import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from "react";
import TreeCanvas from "./components/TreeCanvas";
import { computeGenusBlocks, computeOrderedLeaves } from "./components/treeCanvasCache";
import { serializeSubtreeToNewick } from "./components/treeCanvasUtils";
import {
  cloneDefaultFigureStyles,
  FONT_FAMILY_OPTIONS,
  LABEL_STYLE_CLASS_LABELS,
  TAXONOMY_LABEL_SIZE_SCALE_MAX,
  TAXONOMY_LABEL_SIZE_SCALE_MIN,
  type FigureStyleSettings,
  type FontFamilyKey,
  type LabelStyleClass,
} from "./lib/figureStyles";
import {
  buildMetadataColorOverlay,
  buildMetadataLabelOverlay,
  buildMetadataMarkerOverlay,
  METADATA_CONTINUOUS_PALETTES,
  metadataColumnLooksContinuous,
  parseMetadataTable,
  type MetadataApplyScope,
  type MetadataColorMode,
  type MetadataContinuousPalette,
  type MetadataContinuousTransform,
  type MetadataColorOverlayResult,
  type MetadataLabelOverlayResult,
  type MetadataMarkerShape,
  type MetadataMarkerOverlayResult,
  type ParsedMetadataTable,
} from "./lib/metadataColors";
import {
  parseSharedSubtreeStoragePayload,
  rebuildSharedSubtreeTaxonomyMap,
  type SharedSubtreeTaxonomyPayload,
  type SharedSubtreeVisualPayload,
} from "./lib/sharedSubtreePayload";
import { deriveCollapsibleTaxonomyRanks } from "./lib/taxonomyActiveRanks";
import { buildTaxonomyCollapsedTreePayload } from "./lib/taxonomyCollapse";
import { buildTaxonomyBlocksForOrderedLeaves, taxonomyEntityKey } from "./lib/taxonomyBlocks";
import {
  getCachedTaxonomyArchive,
  getCachedTaxonomyMapping,
  getSharedSubtreePayload,
  putCachedTaxonomyArchive,
  putCachedTaxonomyMapping,
} from "./lib/taxonomyCache";
import { rerootTreePayload, type RerootMode } from "./lib/rerootTree";
import { normalizeImportedTreeText } from "./lib/treeImport";
import type { WorkerResponse } from "./types/messages";
import { TAXONOMY_RANKS, type TaxonomyCollapseRank, type TaxonomyMapPayload, type TaxonomyRank } from "./types/taxonomy";
import type { WorkerTreePayload } from "./types/tree";
import type { LayoutOrder, LoadState, TreeModel, ViewMode, ZoomAxisMode } from "./types/tree";
import type { LabelStyleSettings } from "./lib/figureStyles";

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  if (Math.abs(value) < 0.001) {
    return value.toExponential(3);
  }
  if (Math.abs(value) >= 1000) {
    return value.toFixed(0);
  }
  return value.toFixed(4).replace(/\.?0+$/, "");
}

function sanitizeExportBaseLabel(label: string): string {
  return label
    .trim()
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9._-]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    || "tree";
}

function normalizeSvgExportFilename(value: string, fallbackBaseLabel: string): string {
  const trimmed = value.trim();
  const base = trimmed
    .replace(/[/\\?%*:|"<>]+/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^_+|_+$/g, "")
    || `${fallbackBaseLabel}.svg`;
  return /\.svg$/i.test(base) ? base : `${base}.svg`;
}

function normalizeSearchQuery(value: string): string {
  return value.toLowerCase();
}

function normalizeSearchTarget(value: string): string {
  return value.trim().replace(/^['"]+|['"]+$/g, "").replaceAll("_", " ").toLowerCase();
}

function canonicalSearchKey(value: string): string {
  return normalizeSearchTarget(value).replace(/\s+/g, " ");
}

function taxonomyRankLabel(rank: TaxonomyRank): string {
  return rank.charAt(0).toUpperCase() + rank.slice(1);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesSearchQuery(target: string, query: string): boolean {
  const normalizedTarget = target.toLowerCase();
  const normalizedQuery = normalizeSearchQuery(query);
  const trimmedQuery = normalizedQuery.trim();
  if (!trimmedQuery) {
    return false;
  }
  const hasTrailingSeparator = /[_ ]$/.test(normalizedQuery);
  const tokens = trimmedQuery.split(/[_ ]+/).filter(Boolean).map(escapeRegExp);
  if (tokens.length === 0) {
    return false;
  }
  const body = tokens.join("[_ ]+");
  const pattern = hasTrailingSeparator ? `${body}(?:[_ ]+|$)` : body;
  return new RegExp(pattern, "i").test(normalizedTarget);
}

function isNumericInternalLabel(value: string): boolean {
  return /^[+-]?\d+(?:\.\d+)?$/.test(value.trim());
}

function useSessionDisclosure(key: string, defaultOpen: boolean): [boolean, (value: boolean) => void] {
  const storageKey = `big-tree-viewer:${key}:open`;
  const [isOpen, setIsOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") {
      return defaultOpen;
    }
    const stored = window.sessionStorage.getItem(storageKey);
    if (stored === null) {
      return defaultOpen;
    }
    return stored === "true";
  });

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.sessionStorage.setItem(storageKey, isOpen ? "true" : "false");
  }, [isOpen, storageKey]);

  return [isOpen, setIsOpen];
}

function PanelSection({
  title,
  isOpen,
  onToggle,
  children,
}: {
  title: string;
  isOpen: boolean;
  onToggle: () => void;
  children: ReactNode;
}): ReactNode {
  return (
    <section className="panel-section">
      <button
        type="button"
        className="section-toggle"
        aria-expanded={isOpen}
        onClick={onToggle}
      >
        <span className={`section-toggle-mark${isOpen ? " open" : ""}`}>▸</span>
        <span>{title}</span>
      </button>
      {isOpen ? <div className="section-body">{children}</div> : null}
    </section>
  );
}

const DEFAULT_TAXONOMY_COLOR_JITTER = 1;
const DEFAULT_BRANCH_THICKNESS_SCALE = 1;
const DEFAULT_TAXONOMY_BRANCH_COLORING_ENABLED = true;
const DEFAULT_SHOW_INTERMEDIATE_SCALE_TICKS = true;
const DEFAULT_EXTEND_RECT_SCALE_TO_TICK = false;
const DEFAULT_SHOW_SCALE_ZERO_TICK = false;
const DEFAULT_CIRCULAR_CENTER_SCALE_ANGLE_DEGREES = -5;
const DEFAULT_SHOW_CIRCULAR_CENTER_RADIAL_SCALE_BAR = false;
const DEFAULT_TIME_STRIPE_STYLE = "bands";
const DEFAULT_TIME_STRIPE_LINE_WEIGHT = 1.1;
const DEFAULT_SHOW_NODE_ERROR_BARS = false;
const DEFAULT_ERROR_BAR_THICKNESS_PX = 1.2;
const DEFAULT_ERROR_BAR_CAP_SIZE_PX = 7;
const DEFAULT_METADATA_LABEL_MAX_COUNT = 240;
const DEFAULT_METADATA_LABEL_MIN_SPACING_PX = 10;
const DEFAULT_METADATA_LABEL_OFFSET_X_PX = 0;
const DEFAULT_METADATA_LABEL_OFFSET_Y_PX = 0;
const DEFAULT_METADATA_MARKER_SIZE_PX = 9;
const DEFAULT_TAXONOMY_COLLAPSE_RANK: TaxonomyCollapseRank = "species";
const TAXONOMY_ARCHIVE_URL = "https://ftp.ncbi.nlm.nih.gov/pub/taxonomy/taxdmp.zip";
type VisualPopoverId =
  | LabelStyleClass
  | "timeStripes"
  | "metadataBranchColors"
  | "metadataLabels"
  | "metadataMarkers";

function disabledControlTitle(reason?: string): string | undefined {
  return reason ? `Disabled: ${reason}` : undefined;
}

type DiagnosticsEventRecord = {
  at: string;
  kind: string;
  data?: unknown;
};

const DIAGNOSTICS_STORAGE_KEY = "big-tree-viewer:diagnostics:v1";
const DIAGNOSTICS_ACTIVE_SESSION_KEY = "big-tree-viewer:diagnostics:active-session:v1";
const DIAGNOSTICS_MAX_EVENTS = 200;

function diagnosticsTimestamp(): string {
  return new Date().toISOString();
}

function createDiagnosticsSessionId(): string {
  return `diag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function cloneDiagnosticsValue<T>(value: T): T {
  if (value === undefined) {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

function readDiagnosticsEvents(): DiagnosticsEventRecord[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(DIAGNOSTICS_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as DiagnosticsEventRecord[] : [];
  } catch {
    return [];
  }
}

function writeDiagnosticsEvents(events: DiagnosticsEventRecord[]): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(DIAGNOSTICS_STORAGE_KEY, JSON.stringify(events.slice(-DIAGNOSTICS_MAX_EVENTS)));
  } catch {
    // Ignore local storage failures so diagnostics never break the viewer.
  }
}

function appendDiagnosticsEvent(kind: string, data?: unknown): void {
  const events = readDiagnosticsEvents();
  events.push({
    at: diagnosticsTimestamp(),
    kind,
    data: cloneDiagnosticsValue(data),
  });
  writeDiagnosticsEvents(events);
}

function clearDiagnosticsEvents(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.removeItem(DIAGNOSTICS_STORAGE_KEY);
  } catch {
    // Ignore local storage failures so diagnostics never break the viewer.
  }
}

function diagnosticsPanelEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const value = new URLSearchParams(window.location.search).get("diagnostics");
  return value === "1" || value === "true";
}

function useLowMemoryTaxonomyMode(): boolean {
  if (typeof navigator === "undefined" || typeof window === "undefined") {
    return false;
  }
  const userAgent = navigator.userAgent;
  const isAppleMobileDevice = /iPhone|iPad|iPod/.test(userAgent)
    || (userAgent.includes("Macintosh") && "ontouchend" in window);
  const isWebKitBrowser = /AppleWebKit/i.test(userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(userAgent);
  return isAppleMobileDevice && isWebKitBrowser;
}

function LabelStyleSection({
  labelClass,
  settings,
  viewMode,
  isOpen,
  disabled,
  disabledReason,
  extraControls,
  onToggle,
  onUpdate,
}: {
  labelClass: LabelStyleClass;
  settings: LabelStyleSettings;
  viewMode: ViewMode;
  isOpen: boolean;
  disabled: boolean;
  disabledReason?: string;
  extraControls?: ReactNode;
  onToggle: () => void;
  onUpdate: (
    labelClass: LabelStyleClass,
    field: keyof LabelStyleSettings,
    value: FontFamilyKey | number | boolean,
  ) => void;
}): ReactNode {
  const isTaxonomy = labelClass === "taxonomy";
  const isScale = labelClass === "scale";
  const supportsAxisOffsets = labelClass === "internalNode"
    || labelClass === "bootstrap"
    || labelClass === "nodeHeight";
  const usePolarOffsets = supportsAxisOffsets && viewMode === "circular";
  return (
    <div className={`label-style-popover-anchor${disabled ? " disabled" : ""}`}>
      <button
        type="button"
        className="label-style-gear"
        aria-expanded={disabled ? false : isOpen}
        aria-haspopup="dialog"
        aria-label={`${LABEL_STYLE_CLASS_LABELS[labelClass]} settings`}
        title={disabled && disabledReason ? `${LABEL_STYLE_CLASS_LABELS[labelClass]} settings unavailable: ${disabledReason}` : `${LABEL_STYLE_CLASS_LABELS[labelClass]} settings`}
        onClick={onToggle}
        disabled={disabled}
      >
        <span aria-hidden="true">⚙</span>
      </button>
      {disabled || !isOpen ? null : (
        <div className="label-style-popover" role="dialog" aria-label={`${LABEL_STYLE_CLASS_LABELS[labelClass]} settings`}>
          <div className="label-style-popover-header">
            <strong>{LABEL_STYLE_CLASS_LABELS[labelClass]}</strong>
            <button
              type="button"
              className="label-style-popover-close"
              aria-label={`Close ${LABEL_STYLE_CLASS_LABELS[labelClass]} settings`}
              onClick={onToggle}
            >
              ×
            </button>
          </div>
          <div className="label-style-body">
          <label>
            Font family
            <select
              value={settings.fontFamily}
              onChange={(event) => onUpdate(labelClass, "fontFamily", event.target.value as FontFamilyKey)}
            >
              {FONT_FAMILY_OPTIONS.map((option) => (
                <option key={option.key} value={option.key}>{option.label}</option>
              ))}
            </select>
          </label>
          <label>
            {isTaxonomy ? "Label size" : "Size scale"}
            <input
              type="range"
              min={isTaxonomy ? TAXONOMY_LABEL_SIZE_SCALE_MIN : 0.6}
              max={isTaxonomy ? TAXONOMY_LABEL_SIZE_SCALE_MAX : 1.8}
              step={0.05}
              value={settings.sizeScale}
              onChange={(event) => onUpdate(labelClass, "sizeScale", Number(event.target.value))}
            />
          </label>
          <div className="figure-style-value">x{settings.sizeScale.toFixed(2)}</div>
          {labelClass === "tip" ? (
            <>
              <label className="label-style-inline-toggle">
                <input
                  type="checkbox"
                  checked={Boolean(settings.bold)}
                  onChange={(event) => onUpdate(labelClass, "bold", event.target.checked)}
                />
                Bold
              </label>
              <label className="label-style-inline-toggle">
                <input
                  type="checkbox"
                  checked={Boolean(settings.italic)}
                  onChange={(event) => onUpdate(labelClass, "italic", event.target.checked)}
                />
                Italic
              </label>
            </>
          ) : null}
          {isTaxonomy ? (
            <>
              <label>
                Band thickness
                <input
                  type="range"
                  min={0.65}
                  max={1.8}
                  step={0.05}
                  value={settings.bandThicknessScale ?? 1}
                  onChange={(event) => onUpdate(labelClass, "bandThicknessScale", Number(event.target.value))}
                />
              </label>
              <div className="figure-style-value">x{(settings.bandThicknessScale ?? 1).toFixed(2)}</div>
            </>
          ) : isScale ? null : supportsAxisOffsets ? (
            <>
              <label>
                {usePolarOffsets ? "Tangential offset" : "X offset"}
                <input
                  type="range"
                  min={-24}
                  max={24}
                  step={1}
                  value={settings.offsetXPx}
                  onChange={(event) => onUpdate(labelClass, "offsetXPx", Number(event.target.value))}
                />
              </label>
              <div className="figure-style-value">{settings.offsetXPx}px</div>
              <label>
                {usePolarOffsets ? "Radial offset" : "Y offset"}
                <input
                  type="range"
                  min={-24}
                  max={24}
                  step={1}
                  value={settings.offsetYPx}
                  onChange={(event) => onUpdate(labelClass, "offsetYPx", Number(event.target.value))}
                />
              </label>
              <div className="figure-style-value">{settings.offsetYPx}px</div>
            </>
          ) : (
            <>
              <label>
                Offset
                <input
                  type="range"
                  min={-24}
                  max={24}
                  step={1}
                  value={settings.offsetPx}
                  onChange={(event) => onUpdate(labelClass, "offsetPx", Number(event.target.value))}
                />
              </label>
              <div className="figure-style-value">{settings.offsetPx}px</div>
            </>
          )}
          {extraControls}
        </div>
        </div>
      )}
    </div>
  );
}

function SettingsPopoverButton({
  title,
  isOpen,
  disabled,
  disabledReason,
  onToggle,
  children,
}: {
  title: string;
  isOpen: boolean;
  disabled: boolean;
  disabledReason?: string;
  onToggle: () => void;
  children: ReactNode;
}): ReactNode {
  return (
    <div className={`label-style-popover-anchor${disabled ? " disabled" : ""}`}>
      <button
        type="button"
        className="label-style-gear"
        aria-expanded={disabled ? false : isOpen}
        aria-haspopup="dialog"
        aria-label={`${title} settings`}
        title={disabled && disabledReason ? `${title} settings unavailable: ${disabledReason}` : `${title} settings`}
        onClick={onToggle}
        disabled={disabled}
      >
        <span aria-hidden="true">⚙</span>
      </button>
      {disabled || !isOpen ? null : (
        <div className="label-style-popover" role="dialog" aria-label={`${title} settings`}>
          <div className="label-style-popover-header">
            <strong>{title}</strong>
            <button
              type="button"
              className="label-style-popover-close"
              aria-label={`Close ${title} settings`}
              onClick={onToggle}
            >
              ×
            </button>
          </div>
          <div className="label-style-body">
            {children}
          </div>
        </div>
      )}
    </div>
  );
}

interface SearchResult {
  kind: "node" | "genus" | "taxonomy";
  node: number;
  displayName: string;
  rank?: TaxonomyRank;
  key?: string;
}

const EMPTY_METADATA_OVERLAY: MetadataColorOverlayResult = {
  colors: [],
  hasAny: false,
  matchedRowCount: 0,
  matchedNodeCount: 0,
  coloredNodeCount: 0,
  unmappedRowCount: 0,
  invalidValueRowCount: 0,
  categoryLegend: [],
  continuousLegend: null,
  version: "",
};

const EMPTY_METADATA_LABEL_OVERLAY: MetadataLabelOverlayResult = {
  labels: [],
  hasAny: false,
  labeledNodeCount: 0,
  matchedRowCount: 0,
  unmappedRowCount: 0,
  version: "",
};

const EMPTY_METADATA_MARKER_OVERLAY: MetadataMarkerOverlayResult = {
  markers: [],
  hasAny: false,
  matchedRowCount: 0,
  markedNodeCount: 0,
  unmappedRowCount: 0,
  legend: [],
  version: "",
};

const SEARCH_TAXONOMY_RANK_ORDER: TaxonomyRank[] = [
  "superkingdom",
  "phylum",
  "class",
  "order",
  "family",
  "genus",
];

function taxonomySearchRankPriority(rank: TaxonomyRank): number {
  return SEARCH_TAXONOMY_RANK_ORDER.indexOf(rank);
}

function lowestCommonAncestor(tree: TreeModel, leftNode: number, rightNode: number): number {
  const ancestors = new Set<number>();
  let current = leftNode;
  while (current >= 0 && !ancestors.has(current)) {
    ancestors.add(current);
    current = tree.buffers.parent[current];
  }
  current = rightNode;
  while (current >= 0) {
    if (ancestors.has(current)) {
      return current;
    }
    current = tree.buffers.parent[current];
  }
  return 0;
}

function searchResultLabel(result: SearchResult): string {
  if (result.kind === "taxonomy") {
    return `${result.rank ?? "taxonomy"}: ${result.displayName}`;
  }
  if (result.kind === "genus") {
    return `genus: ${result.displayName}`;
  }
  return `match: ${result.displayName}`;
}

interface TaxonomyWorkerResponse {
  type: "taxonomy-progress" | "taxonomy-downloaded" | "taxonomy-mapped" | "taxonomy-error";
  message?: string;
  archive?: ArrayBuffer;
  payload?: TaxonomyMapPayload;
}

function taxonomyToken(name: string): string {
  return normalizeSearchTarget(name).split(/ +/).filter(Boolean)[0] ?? "unknown";
}

function prefixGroup(value: string, length: number, suffix: string): string {
  const base = value.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (!base) {
    return `unknown-${suffix}`;
  }
  return `${base.slice(0, Math.max(1, Math.min(length, base.length)))}${suffix}`;
}

function buildMockTaxonomyMap(tree: TreeModel): TaxonomyMapPayload {
  return {
    version: 3,
    mappedCount: tree.leafNodes.length,
    totalTips: tree.leafNodes.length,
    activeRanks: ["genus", "family", "order", "class", "phylum"],
    tipRanks: Array.from(tree.leafNodes, (node) => {
      const genus = taxonomyToken(tree.names[node] || "");
      return {
        node,
        ranks: {
          superkingdom: "cellular organisms",
          phylum: prefixGroup(genus, 1, "-phy"),
          class: prefixGroup(genus, 2, "-cls"),
          order: prefixGroup(genus, 3, "-ord"),
          family: prefixGroup(genus, 4, "-fam"),
          genus,
        },
      };
    }),
  };
}

function buildTreeModel(payload: WorkerTreePayload): TreeModel {
  let minPositive = Number.POSITIVE_INFINITY;
  for (let node = 0; node < payload.nodeCount; node += 1) {
    const length = payload.buffers.branchLength[node];
    if (length > 0 && length < minPositive) {
      minPositive = length;
    }
  }
  return {
    ...payload,
    branchLengthMinPositive: Number.isFinite(minPositive) ? minPositive : 1,
  };
}

function filterTaxonomyRanksForCollapse(
  taxonomyMap: TaxonomyMapPayload,
  collapseRank: TaxonomyRank,
): TaxonomyRank[] {
  const activeRanks = new Set<TaxonomyRank>(taxonomyMap.activeRanks);
  const collapseIndex = TAXONOMY_RANKS.indexOf(collapseRank);
  return TAXONOMY_RANKS.filter((rank, rankIndex) => {
    if (!activeRanks.has(rank)) {
      return false;
    }
    if (rank === collapseRank) {
      return false;
    }
    return rankIndex < collapseIndex;
  });
}

async function computeTreeSignature(text: string): Promise<string> {
  const encoded = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export default function App() {
  const workerRef = useRef<Worker | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const metadataFileInputRef = useRef<HTMLInputElement | null>(null);
  const didAutoloadRef = useRef(false);
  const dragCounterRef = useRef(0);
  const pendingPasteHideRef = useRef(false);
  const pendingTreeSignatureRef = useRef<string | null>(null);
  const pendingTreeLabelRef = useRef("");
  const pendingSharedSubtreeTaxonomyRef = useRef<SharedSubtreeTaxonomyPayload | null>(null);
  const pendingSharedSubtreeVisualRef = useRef<SharedSubtreeVisualPayload | null>(null);
  const pendingTreeReplacementTaxonomyRef = useRef<TaxonomyMapPayload | null | undefined>(undefined);
  const pendingTreeReplacementTaxonomyEnabledRef = useRef<boolean | null>(null);
  const [tree, setTree] = useState<TreeModel | null>(null);
  const [treeSignature, setTreeSignature] = useState<string | null>(null);
  const [loadedTreeLabel, setLoadedTreeLabel] = useState("tree");
  const [loadState, setLoadState] = useState<LoadState>({
    loading: false,
    message: "Load a Newick tree to begin.",
    error: null,
  });
  const [viewMode, setViewMode] = useState<ViewMode>("rectangular");
  const [order, setOrder] = useState<LayoutOrder>("asc");
  const [zoomAxisMode, setZoomAxisMode] = useState<ZoomAxisMode>("both");
  const [circularRotationDegrees, setCircularRotationDegrees] = useState(0);
  const [showTimeStripes, setShowTimeStripes] = useState(true);
  const [showScaleBars, setShowScaleBars] = useState(true);
  const [showIntermediateScaleTicks, setShowIntermediateScaleTicks] = useState(DEFAULT_SHOW_INTERMEDIATE_SCALE_TICKS);
  const [extendRectScaleToTick, setExtendRectScaleToTick] = useState(DEFAULT_EXTEND_RECT_SCALE_TO_TICK);
  const [showScaleZeroTick, setShowScaleZeroTick] = useState(DEFAULT_SHOW_SCALE_ZERO_TICK);
  const [scaleTickIntervalInput, setScaleTickIntervalInput] = useState("");
  const [useAutomaticTaxonomyRankVisibility, setUseAutomaticTaxonomyRankVisibility] = useState(true);
  const [useAutoCircularCenterScaleAngle, setUseAutoCircularCenterScaleAngle] = useState(true);
  const [circularCenterScaleAngleDegrees, setCircularCenterScaleAngleDegrees] = useState(DEFAULT_CIRCULAR_CENTER_SCALE_ANGLE_DEGREES);
  const [showCircularCenterRadialScaleBar, setShowCircularCenterRadialScaleBar] = useState(DEFAULT_SHOW_CIRCULAR_CENTER_RADIAL_SCALE_BAR);
  const [timeStripeStyle, setTimeStripeStyle] = useState<"bands" | "dashed">(DEFAULT_TIME_STRIPE_STYLE);
  const [timeStripeLineWeight, setTimeStripeLineWeight] = useState(DEFAULT_TIME_STRIPE_LINE_WEIGHT);
  const [showGenusLabels, setShowGenusLabels] = useState(true);
  const [showInternalNodeLabels, setShowInternalNodeLabels] = useState(false);
  const [showBootstrapLabels, setShowBootstrapLabels] = useState(false);
  const [showNodeHeightLabels, setShowNodeHeightLabels] = useState(false);
  const [showNodeErrorBars, setShowNodeErrorBars] = useState(DEFAULT_SHOW_NODE_ERROR_BARS);
  const [errorBarThicknessPx, setErrorBarThicknessPx] = useState(DEFAULT_ERROR_BAR_THICKNESS_PX);
  const [errorBarCapSizePx, setErrorBarCapSizePx] = useState(DEFAULT_ERROR_BAR_CAP_SIZE_PX);
  const [figureStyles, setFigureStyles] = useState<FigureStyleSettings>(() => cloneDefaultFigureStyles());
  const [taxonomyColorJitter, setTaxonomyColorJitter] = useState(DEFAULT_TAXONOMY_COLOR_JITTER);
  const [taxonomyBranchColoringEnabled, setTaxonomyBranchColoringEnabled] = useState(DEFAULT_TAXONOMY_BRANCH_COLORING_ENABLED);
  const [branchThicknessScale, setBranchThicknessScale] = useState(DEFAULT_BRANCH_THICKNESS_SCALE);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const [fitRequest, setFitRequest] = useState(0);
  const [focusNodeRequest, setFocusNodeRequest] = useState(0);
  const [dataOpen, setDataOpen] = useSessionDisclosure("section-data", true);
  const [viewOpen, setViewOpen] = useSessionDisclosure("section-view", true);
  const [visualOpen, setVisualOpen] = useSessionDisclosure("section-visual", false);
  const [taxonomyOpen, setTaxonomyOpen] = useSessionDisclosure("section-taxonomy", false);
  const [searchOpen, setSearchOpen] = useSessionDisclosure("section-search", false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useSessionDisclosure("section-diagnostics", false);
  const [statsOpen, setStatsOpen] = useSessionDisclosure("section-stats", false);
  const [sidebarVisible, setSidebarVisible] = useSessionDisclosure("sidebar-visible", true);
  const [pastedTreeText, setPastedTreeText] = useState("");
  const [showPasteInput, setShowPasteInput] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [exportSvgRequest, setExportSvgRequest] = useState(0);
  const [exportSvgFilename, setExportSvgFilename] = useState("big-tree-view.svg");
  const [visualResetRequest, setVisualResetRequest] = useState(0);
  const [activeLabelStylePopover, setActiveLabelStylePopover] = useState<VisualPopoverId | null>(null);
  const [metadataOpen, setMetadataOpen] = useSessionDisclosure("section-metadata", false);
  const [metadataTable, setMetadataTable] = useState<ParsedMetadataTable | null>(null);
  const [metadataRawText, setMetadataRawText] = useState("");
  const [metadataFirstRowIsHeader, setMetadataFirstRowIsHeader] = useState(true);
  const [metadataFileName, setMetadataFileName] = useState("");
  const [metadataEnabled, setMetadataEnabled] = useState(false);
  const [metadataKeyColumn, setMetadataKeyColumn] = useState("");
  const [metadataValueColumn, setMetadataValueColumn] = useState("");
  const [metadataColorMode, setMetadataColorMode] = useState<MetadataColorMode>("categorical");
  const [metadataApplyScope, setMetadataApplyScope] = useState<MetadataApplyScope>("branch");
  const [metadataReverseScale, setMetadataReverseScale] = useState(false);
  const [metadataContinuousPalette, setMetadataContinuousPalette] = useState<MetadataContinuousPalette>("blueOrange");
  const [metadataContinuousTransform, setMetadataContinuousTransform] = useState<MetadataContinuousTransform>("linear");
  const [metadataContinuousMinInput, setMetadataContinuousMinInput] = useState("");
  const [metadataContinuousMaxInput, setMetadataContinuousMaxInput] = useState("");
  const [metadataLabelsEnabled, setMetadataLabelsEnabled] = useState(false);
  const [metadataLabelColumn, setMetadataLabelColumn] = useState("");
  const [metadataMarkersEnabled, setMetadataMarkersEnabled] = useState(false);
  const [metadataMarkerColumn, setMetadataMarkerColumn] = useState("");
  const [metadataCategoryColorOverrides, setMetadataCategoryColorOverrides] = useState<Record<string, string>>({});
  const [metadataMarkerStyleOverrides, setMetadataMarkerStyleOverrides] = useState<Record<string, { color?: string; shape?: MetadataMarkerShape }>>({});
  const [metadataMarkerSizePx, setMetadataMarkerSizePx] = useState(DEFAULT_METADATA_MARKER_SIZE_PX);
  const [metadataLabelMaxCount, setMetadataLabelMaxCount] = useState(DEFAULT_METADATA_LABEL_MAX_COUNT);
  const [metadataLabelMinSpacingPx, setMetadataLabelMinSpacingPx] = useState(DEFAULT_METADATA_LABEL_MIN_SPACING_PX);
  const [metadataLabelOffsetXPx, setMetadataLabelOffsetXPx] = useState(DEFAULT_METADATA_LABEL_OFFSET_X_PX);
  const [metadataLabelOffsetYPx, setMetadataLabelOffsetYPx] = useState(DEFAULT_METADATA_LABEL_OFFSET_Y_PX);
  const [metadataStatus, setMetadataStatus] = useState("");
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [taxonomyCached, setTaxonomyCached] = useState<boolean | null>(null);
  const [taxonomyLoading, setTaxonomyLoading] = useState(false);
  const [taxonomyStatus, setTaxonomyStatus] = useState("");
  const [taxonomyError, setTaxonomyError] = useState<string | null>(null);
  const [taxonomyEnabled, setTaxonomyEnabled] = useState(false);
  const [taxonomyRankVisibility, setTaxonomyRankVisibility] = useState<Partial<Record<TaxonomyRank, boolean>>>({});
  const [taxonomyCollapseRank, setTaxonomyCollapseRank] = useState<TaxonomyCollapseRank>(DEFAULT_TAXONOMY_COLLAPSE_RANK);
  const [taxonomyMap, setTaxonomyMap] = useState<TaxonomyMapPayload | null>(null);
  const [diagnosticsRevision, setDiagnosticsRevision] = useState(0);
  const [diagnosticsStatus, setDiagnosticsStatus] = useState("");
  const [unexpectedDiagnosticsSessionId, setUnexpectedDiagnosticsSessionId] = useState<string | null>(null);
  const diagnosticsSessionIdRef = useRef<string>(createDiagnosticsSessionId());
  const showDiagnosticsPanel = useMemo(() => diagnosticsPanelEnabled(), []);
  const useLowMemoryTaxonomyMapping = useMemo(() => useLowMemoryTaxonomyMode(), []);
  const appendDiagnostic = useCallback((kind: string, data?: unknown): void => {
    appendDiagnosticsEvent(kind, data);
    setDiagnosticsRevision((value) => value + 1);
  }, []);
  const collapsibleTaxonomyRanks = useMemo<TaxonomyRank[]>(
    () => taxonomyMap ? deriveCollapsibleTaxonomyRanks(taxonomyMap.tipRanks) : [],
    [taxonomyMap],
  );
  const taxonomyCollapseActiveRank = useMemo<TaxonomyRank | null>(() => {
    if (!taxonomyMap || taxonomyCollapseRank === "species") {
      return null;
    }
    return collapsibleTaxonomyRanks.includes(taxonomyCollapseRank) ? taxonomyCollapseRank : null;
  }, [collapsibleTaxonomyRanks, taxonomyCollapseRank, taxonomyMap]);
  const collapsedTaxonomyView = useMemo(() => {
    if (!tree || !taxonomyMap || !taxonomyCollapseActiveRank) {
      return null;
    }
    const collapsedPayload = buildTaxonomyCollapsedTreePayload(tree, taxonomyMap, taxonomyCollapseActiveRank, order);
    if (!collapsedPayload?.taxonomyMap) {
      return null;
    }
    return {
      tree: buildTreeModel(collapsedPayload.payload),
      taxonomyMap: {
        ...collapsedPayload.taxonomyMap,
        activeRanks: filterTaxonomyRanksForCollapse(
          collapsedPayload.taxonomyMap,
          taxonomyCollapseActiveRank,
        ),
      },
      sourceNodeByNode: collapsedPayload.sourceNodeByNode,
      hasLowerRankFallbackLabels: collapsedPayload.hasLowerRankFallbackLabels,
    };
  }, [order, taxonomyCollapseActiveRank, taxonomyMap, tree]);
  const viewTree = collapsedTaxonomyView?.tree ?? tree;
  const viewTaxonomyMap = collapsedTaxonomyView?.taxonomyMap ?? taxonomyMap;
  const taxonomyCollapseIsSynthetic = collapsedTaxonomyView !== null;
  const taxonomyCollapseHasLowerRankFallbackLabels = Boolean(collapsedTaxonomyView?.hasLowerRankFallbackLabels);
  const handleHoverChange = useCallback(() => {}, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const recordDiagnostic = (kind: string, data?: unknown): void => {
      appendDiagnosticsEvent(kind, data);
      setDiagnosticsRevision((value) => value + 1);
    };
    const sessionId = diagnosticsSessionIdRef.current;
    const previousSessionId = window.localStorage.getItem(DIAGNOSTICS_ACTIVE_SESSION_KEY);
    if (previousSessionId && previousSessionId !== sessionId) {
      setUnexpectedDiagnosticsSessionId(previousSessionId);
      recordDiagnostic("session-recovered-after-unclean-exit", {
        previousSessionId,
      });
    }
    window.localStorage.setItem(DIAGNOSTICS_ACTIVE_SESSION_KEY, sessionId);
    recordDiagnostic("session-started", {
      sessionId,
      href: window.location.href,
      userAgent: navigator.userAgent,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      },
    });

    const onError = (event: ErrorEvent): void => {
      recordDiagnostic("window-error", {
        message: event.message,
        filename: event.filename,
        line: event.lineno,
        column: event.colno,
      });
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
      recordDiagnostic("unhandled-rejection", {
        reason: typeof event.reason === "string" ? event.reason : String(event.reason),
      });
    };
    const onVisibilityChange = (): void => {
      recordDiagnostic("visibility-change", {
        state: document.visibilityState,
      });
    };
    const onPageShow = (event: PageTransitionEvent): void => {
      recordDiagnostic("page-show", {
        persisted: event.persisted,
      });
    };
    const markSessionClosed = (): void => {
      appendDiagnosticsEvent("session-closing", {
        sessionId,
      });
      if (window.localStorage.getItem(DIAGNOSTICS_ACTIVE_SESSION_KEY) === sessionId) {
        window.localStorage.removeItem(DIAGNOSTICS_ACTIVE_SESSION_KEY);
      }
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("pagehide", markSessionClosed);
    window.addEventListener("beforeunload", markSessionClosed);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("pagehide", markSessionClosed);
      window.removeEventListener("beforeunload", markSessionClosed);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      markSessionClosed();
    };
  }, []);

  const diagnosticsReport = useMemo(() => JSON.stringify({
    version: 1,
    generatedAt: diagnosticsTimestamp(),
    current: {
      treeLoaded: tree !== null,
      treeSignature,
      viewMode,
      order,
      taxonomyCached,
      taxonomyLoading,
      taxonomyStatus,
      taxonomyError,
      taxonomyEnabled,
      taxonomyMappedCount: viewTaxonomyMap?.mappedCount ?? 0,
      loadState,
      unexpectedPreviousSessionId: unexpectedDiagnosticsSessionId,
      renderDebug: typeof window !== "undefined" ? window.__BIG_TREE_VIEWER_RENDER_DEBUG__ ?? null : null,
    },
    events: readDiagnosticsEvents(),
  }, null, 2), [
    diagnosticsRevision,
    loadState,
    order,
    taxonomyCached,
    taxonomyEnabled,
    taxonomyError,
    taxonomyLoading,
    taxonomyStatus,
    tree,
    treeSignature,
    unexpectedDiagnosticsSessionId,
    viewMode,
    viewTaxonomyMap,
  ]);

  const copyDiagnosticsReport = useCallback(async (): Promise<void> => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard API unavailable.");
      }
      await navigator.clipboard.writeText(diagnosticsReport);
      setDiagnosticsStatus("Diagnostics copied to the clipboard.");
      appendDiagnostic("diagnostics-copied", {
        characters: diagnosticsReport.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDiagnosticsStatus(`Copy failed. Use the text box below. ${message}`);
      appendDiagnostic("diagnostics-copy-failed", {
        message,
      });
    }
  }, [appendDiagnostic, diagnosticsReport]);

  const clearDiagnosticsReport = useCallback((): void => {
    clearDiagnosticsEvents();
    setUnexpectedDiagnosticsSessionId(null);
    setDiagnosticsStatus("Diagnostics cleared for this device.");
    setDiagnosticsRevision((value) => value + 1);
  }, []);

  const applySharedSubtreeVisualSettings = useCallback((visual: SharedSubtreeVisualPayload): void => {
    setViewMode(visual.viewMode);
    setOrder(visual.order);
    setZoomAxisMode(visual.zoomAxisMode);
    setCircularRotationDegrees(visual.circularRotationDegrees);
    setShowTimeStripes(visual.showTimeStripes);
    setTimeStripeStyle(visual.timeStripeStyle);
    setTimeStripeLineWeight(visual.timeStripeLineWeight);
    setShowScaleBars(visual.showScaleBars);
    setScaleTickIntervalInput(visual.scaleTickInterval === null ? "" : String(visual.scaleTickInterval));
    setShowIntermediateScaleTicks(visual.showIntermediateScaleTicks);
    setExtendRectScaleToTick(visual.extendRectScaleToTick);
    setShowScaleZeroTick(visual.showScaleZeroTick);
    setUseAutoCircularCenterScaleAngle(visual.useAutoCircularCenterScaleAngle);
    setCircularCenterScaleAngleDegrees(visual.circularCenterScaleAngleDegrees);
    setShowCircularCenterRadialScaleBar(visual.showCircularCenterRadialScaleBar);
    setShowGenusLabels(visual.showGenusLabels);
    setShowInternalNodeLabels(visual.showInternalNodeLabels);
    setShowBootstrapLabels(visual.showBootstrapLabels);
    setShowNodeHeightLabels(visual.showNodeHeightLabels);
    setShowNodeErrorBars(visual.showNodeErrorBars);
    setErrorBarThicknessPx(visual.errorBarThicknessPx);
    setErrorBarCapSizePx(visual.errorBarCapSizePx);
    setFigureStyles(visual.figureStyles);
    setTaxonomyEnabled(visual.taxonomyEnabled);
    setTaxonomyBranchColoringEnabled(visual.taxonomyBranchColoringEnabled);
    setUseAutomaticTaxonomyRankVisibility(visual.useAutomaticTaxonomyRankVisibility);
    setTaxonomyRankVisibility(visual.taxonomyRankVisibility);
    setTaxonomyCollapseRank(visual.taxonomyCollapseRank);
    setTaxonomyColorJitter(visual.taxonomyColorJitter);
    setBranchThicknessScale(visual.branchThicknessScale);
  }, []);

  const rerootCurrentTree = useCallback((node: number, mode: RerootMode): void => {
    if (!tree) {
      return;
    }
    const rerootedPayload = rerootTreePayload(tree, node, mode);
    if (!rerootedPayload) {
      return;
    }
    const nextTree = buildTreeModel(rerootedPayload);
    const nextTaxonomyMap = taxonomyMap
      ? rebuildSharedSubtreeTaxonomyMap(nextTree, {
        version: taxonomyMap.version,
        mappedCount: taxonomyMap.tipRanks.length,
        totalTips: taxonomyMap.totalTips,
        activeRanks: [...taxonomyMap.activeRanks],
        tipEntries: taxonomyMap.tipRanks.map((tip) => ({
          name: tree.names[tip.node] ?? "",
          ranks: tip.ranks,
          taxIds: tip.taxIds,
          collapseFallbacks: tip.collapseFallbacks,
        })),
      })
      : null;
    pendingTreeReplacementTaxonomyRef.current = nextTaxonomyMap;
    pendingTreeReplacementTaxonomyEnabledRef.current = taxonomyEnabled && Boolean(nextTaxonomyMap);
    setTree(nextTree);
    setTreeSignature((current) => `${current ?? "tree"}:reroot:${mode}:${node}:${Date.now()}`);
    setLoadedTreeLabel((current) => (current.includes("(rerooted)") ? current : `${current} (rerooted)`));
    setLoadState({
      loading: false,
      message: `Tree rerooted on the ${mode}.`,
      error: null,
    });
  }, [taxonomyEnabled, taxonomyMap, tree]);

  useEffect(() => {
    if (taxonomyEnabled && showGenusLabels) {
      setShowGenusLabels(false);
    }
  }, [showGenusLabels, taxonomyEnabled]);

  useEffect(() => {
    if (typeof document === "undefined" || activeLabelStylePopover === null) {
      return;
    }
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".label-style-popover-anchor")) {
        return;
      }
      if (!target?.closest(".control-panel")) {
        return;
      }
      setActiveLabelStylePopover(null);
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setActiveLabelStylePopover(null);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [activeLabelStylePopover]);

  const searchResults = useMemo(() => {
    const query = normalizeSearchQuery(searchQuery);
    const queryKey = canonicalSearchKey(searchQuery);
    if (!viewTree || !searchQuery.trim()) {
      return [] as SearchResult[];
    }
    const exactTaxonomyResults: SearchResult[] = [];
    const partialTaxonomyResults: Array<SearchResult & { rankOrder: number; orderIndex: number }> = [];
    const pushTaxonomyResult = (
      rank: TaxonomyRank,
      label: string,
      key: string,
      firstNode: number,
      lastNode: number,
      orderIndex: number,
    ): void => {
      if (!matchesSearchQuery(label, query)) {
        return;
      }
      const result = {
        kind: "taxonomy",
        node: lowestCommonAncestor(viewTree, firstNode, lastNode),
        displayName: label,
        rank,
        key,
      } satisfies SearchResult;
      if (canonicalSearchKey(label) === queryKey) {
        exactTaxonomyResults.push(result);
        return;
      }
      partialTaxonomyResults.push({
        ...result,
        rankOrder: taxonomySearchRankPriority(rank),
        orderIndex,
      });
    };

    if (taxonomyEnabled && viewTaxonomyMap) {
      const orderedLeaves = computeOrderedLeaves(viewTree, order);
      const taxonomyBlocks = buildTaxonomyBlocksForOrderedLeaves(orderedLeaves, viewTaxonomyMap, null);
      for (let rankIndex = 0; rankIndex < SEARCH_TAXONOMY_RANK_ORDER.length; rankIndex += 1) {
        const rank = SEARCH_TAXONOMY_RANK_ORDER[rankIndex];
        const blocks = [...(taxonomyBlocks[rank] ?? [])].sort((left, right) => (
          (left.labelStartIndex ?? left.startIndex ?? 0) - (right.labelStartIndex ?? right.startIndex ?? 0)
        ));
        for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
          const block = blocks[blockIndex];
          const totalTipCount = (block.segments ?? []).reduce((total, segment) => {
            const end = segment.endIndex >= segment.startIndex ? segment.endIndex : segment.endIndex + orderedLeaves.length;
            return total + Math.max(0, end - segment.startIndex);
          }, 0);
          if (totalTipCount <= 1) {
            continue;
          }
          const labelStartIndex = block.labelStartIndex ?? block.startIndex ?? block.segments?.[0]?.startIndex ?? 0;
          const labelEndIndex = block.labelEndIndex ?? block.endIndex ?? block.segments?.[0]?.endIndex ?? (labelStartIndex + 1);
          const labelFirstNode = orderedLeaves[labelStartIndex];
          const labelLastNode = orderedLeaves[((labelEndIndex - 1 + orderedLeaves.length) % orderedLeaves.length)];
          pushTaxonomyResult(
            rank,
            block.label,
            `${rank}:${block.entityKey ?? taxonomyEntityKey(block.label, block.taxId ?? null)}:${block.centerNode}`,
            labelFirstNode,
            labelLastNode,
            labelStartIndex,
          );
        }
      }
    } else {
      const exactGenusResults: SearchResult[] = [];
      const partialGenusResults: Array<SearchResult & { rankOrder: number; orderIndex: number }> = [];
      const orderedLeaves = computeOrderedLeaves(viewTree, order);
      const genusBlocks = computeGenusBlocks(viewTree, orderedLeaves);
      for (let index = 0; index < genusBlocks.length; index += 1) {
        const block = genusBlocks[index];
        if (!matchesSearchQuery(block.label, query)) {
          continue;
        }
        const result = {
          kind: "genus",
          node: block.centerNode,
          displayName: block.label,
        } satisfies SearchResult;
        if (canonicalSearchKey(block.label) === queryKey) {
          exactGenusResults.push(result);
        } else {
          partialGenusResults.push({
            ...result,
            rankOrder: taxonomySearchRankPriority("genus"),
            orderIndex: index,
          });
        }
      }
      exactTaxonomyResults.push(...exactGenusResults);
      partialTaxonomyResults.push(...partialGenusResults);
    }

    const exactLeafMatches: number[] = [];
    const exactInternalMatches: number[] = [];
    const partialNodeMatches: number[] = [];
    for (let node = 0; node < viewTree.nodeCount; node += 1) {
      const rawName = (viewTree.names[node] || "").trim();
      if (!rawName) {
        continue;
      }
      const isInternal = viewTree.buffers.firstChild[node] >= 0;
      if (isInternal && isNumericInternalLabel(rawName)) {
        continue;
      }
      if (matchesSearchQuery(rawName, query)) {
        const isExact = canonicalSearchKey(rawName) === queryKey;
        if (isExact && !isInternal) {
          exactLeafMatches.push(node);
        } else if (isExact) {
          exactInternalMatches.push(node);
        } else {
          partialNodeMatches.push(node);
        }
      }
    }
    const sortNodes = (nodes: number[]): void => {
      nodes.sort((left, right) => (
        viewTree.layouts[order].center[left] - viewTree.layouts[order].center[right]
        || viewTree.buffers.depth[left] - viewTree.buffers.depth[right]
        || left - right
      ));
    };
    sortNodes(exactLeafMatches);
    sortNodes(exactInternalMatches);
    sortNodes(partialNodeMatches);
    exactTaxonomyResults.sort((left, right) => (
      taxonomySearchRankPriority(left.rank ?? "genus") - taxonomySearchRankPriority(right.rank ?? "genus")
      || left.displayName.localeCompare(right.displayName)
      || left.node - right.node
    ));
    partialTaxonomyResults.sort((left, right) => (
      left.rankOrder - right.rankOrder
      || left.orderIndex - right.orderIndex
      || left.displayName.localeCompare(right.displayName)
      || left.node - right.node
    ));
    const nodeResults = [...exactLeafMatches, ...exactInternalMatches, ...partialNodeMatches];
    const results = [
      ...exactTaxonomyResults,
      ...partialTaxonomyResults.map(({ rankOrder: _rankOrder, orderIndex: _orderIndex, ...result }) => result),
    ];
    for (let index = 0; index < nodeResults.length; index += 1) {
      const node = nodeResults[index];
      results.push({
        kind: "node",
        node,
        displayName: normalizeSearchTarget(viewTree.names[node] || "").replaceAll("_", " ") || `node-${node}`,
      });
    }
    return results;
  }, [order, searchQuery, taxonomyEnabled, viewTaxonomyMap, viewTree]);

  const searchMatches = useMemo(
    () => searchResults.filter((result) => result.kind === "node").map((result) => result.node),
    [searchResults],
  );

  const activeSearchResult = searchResults.length > 0
    ? searchResults[Math.min(activeSearchIndex, searchResults.length - 1)]
    : null;
  const activeSearchNode = activeSearchResult?.kind === "node" ? activeSearchResult.node : null;
  const activeSearchGenusCenterNode = activeSearchResult?.kind === "genus" ? activeSearchResult.node : null;
  const activeSearchTaxonomyNode = activeSearchResult?.kind === "taxonomy" ? activeSearchResult.node : null;
  const activeSearchTaxonomyKey = activeSearchResult?.kind === "taxonomy" ? (activeSearchResult.key ?? null) : null;
  const scaleTickInterval = useMemo(() => {
    const trimmed = scaleTickIntervalInput.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }, [scaleTickIntervalInput]);
  const effectiveCircularCenterScaleAngleDegrees = useMemo(
    () => (useAutoCircularCenterScaleAngle ? (order === "asc" ? 5 : -5) : circularCenterScaleAngleDegrees),
    [circularCenterScaleAngleDegrees, order, useAutoCircularCenterScaleAngle],
  );
  const handleCircularCenterScaleAngleAutoChange = useCallback((enabled: boolean) => {
    if (!enabled) {
      setCircularCenterScaleAngleDegrees(effectiveCircularCenterScaleAngleDegrees);
    }
    setUseAutoCircularCenterScaleAngle(enabled);
  }, [effectiveCircularCenterScaleAngleDegrees]);
  const metadataColumns = metadataTable?.columns ?? [];
  const metadataValueColumnSupportsContinuous = useMemo(
    () => (metadataTable && metadataValueColumn ? metadataColumnLooksContinuous(metadataTable.rows, metadataValueColumn) : false),
    [metadataTable, metadataValueColumn],
  );
  const metadataContinuousMin = useMemo(() => {
    const trimmed = metadataContinuousMinInput.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }, [metadataContinuousMinInput]);
  const metadataContinuousMax = useMemo(() => {
    const trimmed = metadataContinuousMaxInput.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }, [metadataContinuousMaxInput]);
  const metadataOverlay = useMemo<MetadataColorOverlayResult>(() => {
    if (!tree || !metadataTable || !metadataKeyColumn || !metadataValueColumn) {
      return EMPTY_METADATA_OVERLAY;
    }
    return buildMetadataColorOverlay(
      tree,
      metadataTable.rows,
      metadataKeyColumn,
      metadataValueColumn,
      {
        mode: metadataColorMode,
        scope: metadataApplyScope,
        reverseScale: metadataReverseScale,
        continuousPalette: metadataContinuousPalette,
        continuousTransform: metadataContinuousTransform,
        continuousMin: metadataContinuousMin,
        continuousMax: metadataContinuousMax,
        categoricalColorOverrides: metadataCategoryColorOverrides,
      },
    );
  }, [
    metadataApplyScope,
    metadataColorMode,
    metadataContinuousMax,
    metadataContinuousMin,
    metadataContinuousPalette,
    metadataContinuousTransform,
    metadataCategoryColorOverrides,
    metadataKeyColumn,
    metadataReverseScale,
    metadataTable,
    metadataValueColumn,
    tree,
  ]);
  const metadataLabelOverlay = useMemo<MetadataLabelOverlayResult>(() => {
    if (!tree || !metadataTable || !metadataKeyColumn || !metadataLabelColumn) {
      return EMPTY_METADATA_LABEL_OVERLAY;
    }
    return buildMetadataLabelOverlay(
      tree,
      metadataTable.rows,
      metadataKeyColumn,
      metadataLabelColumn,
      metadataApplyScope,
    );
  }, [metadataApplyScope, metadataKeyColumn, metadataLabelColumn, metadataTable, tree]);
  const metadataMarkerOverlay = useMemo<MetadataMarkerOverlayResult>(() => {
    if (!tree || !metadataTable || !metadataKeyColumn || !metadataMarkerColumn) {
      return EMPTY_METADATA_MARKER_OVERLAY;
    }
    return buildMetadataMarkerOverlay(
      tree,
      metadataTable.rows,
      metadataKeyColumn,
      metadataMarkerColumn,
      {
        categoryStyleOverrides: metadataMarkerStyleOverrides,
      },
    );
  }, [metadataKeyColumn, metadataMarkerColumn, metadataMarkerStyleOverrides, metadataTable, tree]);
  const metadataOverlaysSuppressed = taxonomyCollapseIsSynthetic;
  const availableTaxonomyRanks = useMemo<TaxonomyRank[]>(
    () => [...(viewTaxonomyMap?.activeRanks ?? [])].sort(
      (left, right) => TAXONOMY_RANKS.indexOf(left) - TAXONOMY_RANKS.indexOf(right),
    ),
    [viewTaxonomyMap],
  );
  const handleAutomaticTaxonomyRankVisibilityChange = useCallback((enabled: boolean) => {
    if (!enabled) {
      const renderDebug = (window as typeof window & {
        __BIG_TREE_VIEWER_RENDER_DEBUG__?: {
          rect?: { taxonomyVisibleRanks?: string[] };
          circular?: { taxonomyVisibleRanks?: string[] };
        } | null;
      }).__BIG_TREE_VIEWER_RENDER_DEBUG__;
      const visibleRanks = (
        viewMode === "circular"
          ? renderDebug?.circular?.taxonomyVisibleRanks
          : renderDebug?.rect?.taxonomyVisibleRanks
      ) ?? [];
      const nextVisibility: Partial<Record<TaxonomyRank, boolean>> = {};
      for (let index = 0; index < availableTaxonomyRanks.length; index += 1) {
        const rank = availableTaxonomyRanks[index];
        nextVisibility[rank] = visibleRanks.includes(rank);
      }
      setTaxonomyRankVisibility(nextVisibility);
    }
    setUseAutomaticTaxonomyRankVisibility(enabled);
  }, [availableTaxonomyRanks, viewMode]);
  useEffect(() => {
    if (metadataColorMode === "continuous" && !metadataValueColumnSupportsContinuous) {
      setMetadataColorMode("categorical");
    }
  }, [metadataColorMode, metadataValueColumnSupportsContinuous]);
  useEffect(() => {
    if (!taxonomyMap || taxonomyCollapseRank === "species") {
      return;
    }
    if (!collapsibleTaxonomyRanks.includes(taxonomyCollapseRank)) {
      setTaxonomyCollapseRank(DEFAULT_TAXONOMY_COLLAPSE_RANK);
    }
  }, [collapsibleTaxonomyRanks, taxonomyCollapseRank, taxonomyMap]);

  useEffect(() => {
    if (searchResults.length === 0) {
      setActiveSearchIndex(0);
      return;
    }
    setActiveSearchIndex((current) => Math.min(current, searchResults.length - 1));
  }, [searchResults]);

  const handleWorkerMessage = useCallback((event: MessageEvent<WorkerResponse>): void => {
    const data = event.data;
    if (data.type === "parse-progress") {
      setLoadState((current) => ({
        ...current,
        loading: true,
        message: data.message,
      }));
      return;
    }
    if (data.type === "parse-error") {
      pendingPasteHideRef.current = false;
      pendingTreeSignatureRef.current = null;
      pendingTreeLabelRef.current = "";
      pendingSharedSubtreeTaxonomyRef.current = null;
      setLoadState({
        loading: false,
        message: "Failed to parse tree.",
        error: data.message,
      });
      return;
    }
    const nextTree = buildTreeModel(data.payload);
    setTree(nextTree);
    setTreeSignature(pendingTreeSignatureRef.current);
    setLoadedTreeLabel(pendingTreeLabelRef.current || "tree");
    pendingTreeSignatureRef.current = null;
    pendingTreeLabelRef.current = "";
    setLoadState({
      loading: false,
      message: "",
      error: null,
    });
    if (pendingPasteHideRef.current) {
      pendingPasteHideRef.current = false;
      setShowPasteInput(false);
      setPastedTreeText("");
    }
    setFitRequest((value) => value + 1);
  }, []);

  const handleWorkerError = useCallback((event: ErrorEvent): void => {
    pendingPasteHideRef.current = false;
    pendingTreeSignatureRef.current = null;
    pendingTreeLabelRef.current = "";
    pendingSharedSubtreeTaxonomyRef.current = null;
    setLoadState({
      loading: false,
      message: "Tree worker failed.",
      error: event.message || "Unknown worker error.",
    });
  }, []);

  const handleWorkerMessageError = useCallback((): void => {
    pendingPasteHideRef.current = false;
    pendingTreeSignatureRef.current = null;
    pendingTreeLabelRef.current = "";
    pendingSharedSubtreeTaxonomyRef.current = null;
    setLoadState({
      loading: false,
      message: "Tree worker message transfer failed.",
      error: "The browser could not deserialize the parsed tree payload.",
    });
  }, []);

  const ensureWorker = useCallback((): Worker => {
    if (workerRef.current) {
      return workerRef.current;
    }
    const worker = new Worker(new URL("./workers/treeWorker.ts", import.meta.url), { type: "module" });
    worker.addEventListener("message", handleWorkerMessage);
    worker.addEventListener("error", handleWorkerError);
    worker.addEventListener("messageerror", handleWorkerMessageError);
    workerRef.current = worker;
    return worker;
  }, [handleWorkerError, handleWorkerMessage, handleWorkerMessageError]);

  useEffect(() => () => {
    const worker = workerRef.current;
    if (!worker) {
      return;
    }
    worker.terminate();
    workerRef.current = null;
  }, []);

  const parseText = useCallback(async (text: string, label: string): Promise<void> => {
    const normalizedText = normalizeImportedTreeText(text);
    pendingTreeSignatureRef.current = await computeTreeSignature(normalizedText);
    pendingTreeLabelRef.current = label;
    setLoadState({
      loading: true,
      message: `Starting worker for ${label}...`,
      error: null,
    });
    const worker = ensureWorker();
    setLoadState({
      loading: true,
      message: `Parsing ${label}...`,
      error: null,
    });
    worker.postMessage({
      type: "parse-tree",
      text: normalizedText,
    });
  }, [ensureWorker]);

  const runTaxonomyWorker = useCallback((request: { type: "download-taxonomy" } | { type: "map-taxonomy"; archive: Blob | ArrayBuffer; tips: Array<{ node: number; name: string }>; lowMemoryMode?: boolean }): Promise<TaxonomyWorkerResponse> => {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL("./workers/taxonomyWorker.ts", import.meta.url), { type: "module" });
      const cleanup = (): void => {
        worker.terminate();
      };
      worker.addEventListener("message", (event: MessageEvent<TaxonomyWorkerResponse>) => {
        const data = event.data;
        if (data.type === "taxonomy-progress") {
          setTaxonomyStatus(data.message ?? "");
          appendDiagnostic("taxonomy-worker-progress", {
            message: data.message ?? "",
          });
          return;
        }
        cleanup();
        resolve(data);
      });
      worker.addEventListener("error", (event) => {
        cleanup();
        reject(event.error ?? new Error(event.message || "Taxonomy worker failed."));
      });
      worker.postMessage(
        request,
        request.type === "map-taxonomy" && request.archive instanceof ArrayBuffer ? [request.archive] : [],
      );
    });
  }, [appendDiagnostic]);

  useEffect(() => {
    void (async () => {
      const cached = await getCachedTaxonomyArchive();
      setTaxonomyCached(cached !== null);
    })();
  }, []);

  const loadSubtreeFromUrl = useCallback(async (): Promise<boolean> => {
    if (typeof window === "undefined") {
      return false;
    }
    const params = new URLSearchParams(window.location.search);
    const subtreeKey = params.get("subtree");
    if (!subtreeKey) {
      return false;
    }
    const sharedPayload = await getSharedSubtreePayload(subtreeKey);
    const raw = sharedPayload ? JSON.stringify(sharedPayload) : window.localStorage.getItem(subtreeKey);
    if (!raw) {
      setLoadState({
        loading: false,
        message: "Unable to load shared subtree.",
        error: "The requested subtree payload is not available in local storage.",
      });
      return true;
    }
    const payload = parseSharedSubtreeStoragePayload(raw);
    pendingSharedSubtreeTaxonomyRef.current = payload.taxonomy ?? null;
    pendingSharedSubtreeVisualRef.current = payload.visual ?? null;
    if (payload.visual) {
      applySharedSubtreeVisualSettings(payload.visual);
    }
    await parseText(payload.newick, "shared subtree");
    return true;
  }, [applySharedSubtreeVisualSettings, parseText]);

  const loadExample = async (): Promise<void> => {
    setLoadState({
      loading: true,
      message: "Loading bundled example tree...",
      error: null,
    });
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}example-tree.nwk`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const text = await response.text();
      await parseText(text, "example tree");
    } catch (error) {
      setLoadState({
        loading: false,
        message: "Unable to load bundled example tree.",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const downloadCurrentTreeNewick = useCallback((): void => {
    if (!tree || typeof window === "undefined") {
      return;
    }
    const newick = serializeSubtreeToNewick(tree, tree.root);
    const blob = new Blob([newick], { type: "text/plain;charset=utf-8" });
    const url = window.URL.createObjectURL(blob);
    const link = window.document.createElement("a");
    const baseLabel = sanitizeExportBaseLabel(loadedTreeLabel);
    link.href = url;
    link.download = `${baseLabel}.nwk`;
    window.document.body.appendChild(link);
    link.click();
    window.document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  }, [loadedTreeLabel, tree]);

  const requestSvgExport = useCallback((): void => {
    if (!tree || typeof window === "undefined") {
      return;
    }
    const baseLabel = sanitizeExportBaseLabel(loadedTreeLabel);
    const defaultFilename = `${baseLabel}-${viewMode}-view.svg`;
    const requestedFilename = window.prompt("Save SVG as", defaultFilename);
    if (requestedFilename === null) {
      return;
    }
    setExportSvgFilename(normalizeSvgExportFilename(requestedFilename, `${baseLabel}-${viewMode}-view`));
    setExportSvgRequest((value) => value + 1);
  }, [loadedTreeLabel, tree, viewMode]);

  useEffect(() => {
    if (didAutoloadRef.current) {
      return;
    }
    didAutoloadRef.current = true;
    void (async () => {
      const loadedSubtree = await loadSubtreeFromUrl();
      if (!loadedSubtree) {
        await loadExample();
      }
    })();
  }, [loadExample, loadSubtreeFromUrl]);

  useEffect(() => {
    if (!tree || !treeSignature) {
      setTaxonomyMap(null);
      setTaxonomyEnabled(false);
      return;
    }
    setFitRequest((value) => value + 1);
    if (pendingTreeReplacementTaxonomyRef.current !== undefined) {
      const replacementTaxonomy = pendingTreeReplacementTaxonomyRef.current;
      const replacementEnabled = pendingTreeReplacementTaxonomyEnabledRef.current;
      pendingTreeReplacementTaxonomyRef.current = undefined;
      pendingTreeReplacementTaxonomyEnabledRef.current = null;
      setTaxonomyMap(replacementTaxonomy ?? null);
      setTaxonomyEnabled(replacementEnabled ?? false);
      setTaxonomyStatus(replacementTaxonomy
        ? `Updated taxonomy mapping after reroot (${replacementTaxonomy.mappedCount.toLocaleString()} mapped tips).`
        : "");
      setTaxonomyError(null);
      return;
    }
    const inheritedSubtreeTaxonomy = pendingSharedSubtreeTaxonomyRef.current;
    const inheritedSubtreeVisual = pendingSharedSubtreeVisualRef.current;
    if (inheritedSubtreeTaxonomy) {
      pendingSharedSubtreeTaxonomyRef.current = null;
      pendingSharedSubtreeVisualRef.current = null;
      const rebuilt = rebuildSharedSubtreeTaxonomyMap(tree, inheritedSubtreeTaxonomy);
      if (rebuilt) {
        setTaxonomyMap(rebuilt);
        setTaxonomyEnabled(inheritedSubtreeVisual?.taxonomyEnabled ?? true);
        setTaxonomyStatus(`Loaded shared taxonomy mapping for this subtree (${rebuilt.mappedCount.toLocaleString()} mapped tips).`);
        setTaxonomyError(null);
        void putCachedTaxonomyMapping(treeSignature, rebuilt);
        return;
      }
    }
    const inheritedTaxonomyEnabled = inheritedSubtreeVisual?.taxonomyEnabled;
    pendingSharedSubtreeVisualRef.current = null;
    setTaxonomyMap(null);
    setTaxonomyEnabled(false);
    let cancelled = false;
    void (async () => {
      const cached = await getCachedTaxonomyMapping(treeSignature);
      if (cancelled || !cached) {
        return;
      }
      setTaxonomyMap(cached);
      setTaxonomyEnabled(inheritedTaxonomyEnabled ?? true);
      setTaxonomyStatus(`Loaded cached taxonomy mapping for this tree (${cached.mappedCount.toLocaleString()} mapped tips).`);
      setTaxonomyError(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [tree, treeSignature]);

  const onFileChange = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    const text = await file.text();
    await parseText(text, file.name);
    event.target.value = "";
  };

  const clearMetadata = useCallback((): void => {
    setMetadataTable(null);
    setMetadataRawText("");
    setMetadataFirstRowIsHeader(true);
    setMetadataFileName("");
    setMetadataEnabled(false);
    setMetadataKeyColumn("");
    setMetadataValueColumn("");
    setMetadataColorMode("categorical");
    setMetadataApplyScope("branch");
    setMetadataReverseScale(false);
    setMetadataContinuousPalette("blueOrange");
    setMetadataContinuousTransform("linear");
    setMetadataContinuousMinInput("");
    setMetadataContinuousMaxInput("");
    setMetadataLabelsEnabled(false);
    setMetadataLabelColumn("");
    setMetadataMarkersEnabled(false);
    setMetadataMarkerColumn("");
    setMetadataCategoryColorOverrides({});
    setMetadataMarkerStyleOverrides({});
    setMetadataMarkerSizePx(DEFAULT_METADATA_MARKER_SIZE_PX);
    setMetadataLabelMaxCount(DEFAULT_METADATA_LABEL_MAX_COUNT);
    setMetadataLabelMinSpacingPx(DEFAULT_METADATA_LABEL_MIN_SPACING_PX);
    setMetadataLabelOffsetXPx(DEFAULT_METADATA_LABEL_OFFSET_X_PX);
    setMetadataLabelOffsetYPx(DEFAULT_METADATA_LABEL_OFFSET_Y_PX);
    setMetadataStatus("");
    setMetadataError(null);
  }, []);

  const applyMetadataText = useCallback((text: string, label: string, firstRowIsHeader: boolean): void => {
    try {
      const table = parseMetadataTable(text, firstRowIsHeader);
      if (table.columns.length < 2) {
        throw new Error("Metadata file must include at least two columns: one key column and one value column.");
      }
      const defaultKeyColumn = table.columns[0];
      const defaultValueColumn = table.columns[1];
      setMetadataTable(table);
      setMetadataRawText(text);
      setMetadataFirstRowIsHeader(firstRowIsHeader);
      setMetadataFileName(label);
      setMetadataEnabled(true);
      setMetadataKeyColumn(defaultKeyColumn);
      setMetadataValueColumn(defaultValueColumn);
      setMetadataLabelColumn(table.columns[2] ?? defaultValueColumn);
      setMetadataLabelsEnabled(false);
      setMetadataColorMode(metadataColumnLooksContinuous(table.rows, defaultValueColumn) ? "continuous" : "categorical");
      setMetadataApplyScope("branch");
      setMetadataReverseScale(false);
      setMetadataContinuousPalette("blueOrange");
      setMetadataContinuousTransform("linear");
      setMetadataContinuousMinInput("");
      setMetadataContinuousMaxInput("");
      setMetadataMarkersEnabled(false);
      setMetadataMarkerColumn(table.columns[3] ?? table.columns[1]);
      setMetadataCategoryColorOverrides({});
      setMetadataMarkerStyleOverrides({});
      setMetadataMarkerSizePx(DEFAULT_METADATA_MARKER_SIZE_PX);
      setMetadataLabelMaxCount(DEFAULT_METADATA_LABEL_MAX_COUNT);
      setMetadataLabelMinSpacingPx(DEFAULT_METADATA_LABEL_MIN_SPACING_PX);
      setMetadataLabelOffsetXPx(DEFAULT_METADATA_LABEL_OFFSET_X_PX);
      setMetadataLabelOffsetYPx(DEFAULT_METADATA_LABEL_OFFSET_Y_PX);
      setMetadataStatus(`Loaded ${table.rows.length.toLocaleString()} metadata rows from ${label}.`);
      setMetadataError(null);
    } catch (error) {
      clearMetadata();
      setMetadataError(error instanceof Error ? error.message : String(error));
      setMetadataStatus("");
    }
  }, [clearMetadata]);

  const importMetadataText = useCallback((text: string, label: string): void => {
    applyMetadataText(text, label, metadataFirstRowIsHeader);
  }, [applyMetadataText, metadataFirstRowIsHeader]);

  const onMetadataFileChange = useCallback(async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    const text = await file.text();
    importMetadataText(text, file.name);
    event.target.value = "";
  }, [importMetadataText]);

  const loadPastedTree = useCallback(async (): Promise<void> => {
    const text = pastedTreeText.trim();
    if (!text) {
      setLoadState({
        loading: false,
        message: "Paste a tree string first.",
        error: "No pasted tree text was provided.",
      });
      return;
    }
    pendingPasteHideRef.current = true;
    await parseText(text, "pasted tree");
  }, [parseText, pastedTreeText]);

  const handleDrop = useCallback(async (event: DragEvent<HTMLDivElement>): Promise<void> => {
    event.preventDefault();
    dragCounterRef.current = 0;
    setDragActive(false);
    const dataTransfer = "dataTransfer" in event ? event.dataTransfer : null;
    if (!dataTransfer) {
      return;
    }
    const file = dataTransfer.files?.[0];
    if (file) {
      const text = await file.text();
      if (/\.(csv|tsv)$/i.test(file.name)) {
        importMetadataText(text, file.name);
        return;
      }
      await parseText(text, file.name);
      return;
    }
    const plainText = dataTransfer.getData("text/plain");
    if (plainText.trim()) {
      setPastedTreeText(plainText);
      await parseText(plainText, "dropped tree text");
    }
  }, [importMetadataText, parseText]);

  const downloadTaxonomy = useCallback(async (): Promise<void> => {
    setTaxonomyLoading(true);
    setTaxonomyError(null);
    setTaxonomyStatus("Preparing taxonomy download...");
    appendDiagnostic("taxonomy-download-started", {
      treeLoaded: tree !== null,
    });
    try {
      setTaxonomyStatus("Downloading NCBI taxonomy...");
      const response = await fetch(TAXONOMY_ARCHIVE_URL);
      if (!response.ok) {
        throw new Error(`Taxonomy download failed with HTTP ${response.status}.`);
      }
      const archive = await response.blob();
      const cacheMode = await putCachedTaxonomyArchive(archive);
      setTaxonomyCached(true);
      setTaxonomyStatus(
        cacheMode === "persistent"
          ? "Taxonomy download cached locally."
          : "Taxonomy download available for this session. Safari could not persist the archive locally.",
      );
      appendDiagnostic("taxonomy-download-completed", {
        cacheMode,
        sizeBytes: archive.size,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTaxonomyError(message);
      appendDiagnostic("taxonomy-download-failed", {
        message,
      });
    } finally {
      setTaxonomyLoading(false);
    }
  }, [appendDiagnostic, tree]);

  const runTaxonomyMapping = useCallback(async (): Promise<void> => {
    if (!tree) {
      return;
    }
    setTaxonomyLoading(true);
    setTaxonomyError(null);
    setTaxonomyStatus("Loading taxonomy cache...");
    appendDiagnostic("taxonomy-mapping-started", {
      tipCount: tree.leafCount,
      treeSignature,
      lowMemoryMode: useLowMemoryTaxonomyMapping,
    });
    try {
      const archive = await getCachedTaxonomyArchive();
      if (!archive) {
        throw new Error("Taxonomy cache not found. Download the taxonomy first.");
      }
      const tips = Array.from(tree.leafNodes)
        .sort((left, right) => tree.layouts.input.center[left] - tree.layouts.input.center[right])
        .map((node) => ({
          node,
          name: tree.names[node] || "",
        }));
      const response = await runTaxonomyWorker({
        type: "map-taxonomy",
        archive,
        tips,
        lowMemoryMode: useLowMemoryTaxonomyMapping,
      });
      if (response.type !== "taxonomy-mapped" || !response.payload) {
        throw new Error(response.message || "Taxonomy mapping did not complete.");
      }
      if (treeSignature && !useLowMemoryTaxonomyMapping) {
        await putCachedTaxonomyMapping(treeSignature, response.payload);
      }
      setTaxonomyMap(response.payload);
      setTaxonomyEnabled(true);
      setTaxonomyStatus(
        useLowMemoryTaxonomyMapping
          ? `Mapped taxonomy for ${response.payload.mappedCount.toLocaleString()} of ${response.payload.totalTips.toLocaleString()} tips in low-memory mobile mode.`
          : `Mapped taxonomy for ${response.payload.mappedCount.toLocaleString()} of ${response.payload.totalTips.toLocaleString()} tips.`,
      );
      appendDiagnostic("taxonomy-mapping-completed", {
        mappedCount: response.payload.mappedCount,
        totalTips: response.payload.totalTips,
        activeRanks: response.payload.activeRanks,
        lowMemoryMode: useLowMemoryTaxonomyMapping,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTaxonomyError(message);
      appendDiagnostic("taxonomy-mapping-failed", {
        message,
      });
    } finally {
      setTaxonomyLoading(false);
    }
  }, [appendDiagnostic, runTaxonomyWorker, tree, treeSignature, useLowMemoryTaxonomyMapping]);

  const stepSearch = (direction: -1 | 1): void => {
    if (searchResults.length === 0) {
      return;
    }
    setActiveSearchIndex((current) => {
      const next = current + direction;
      if (next < 0) {
        return searchResults.length - 1;
      }
      if (next >= searchResults.length) {
        return 0;
      }
      return next;
    });
  };

  const updateFigureStyle = useCallback((
    labelClass: LabelStyleClass,
    field: keyof FigureStyleSettings[LabelStyleClass],
    value: FontFamilyKey | number | boolean,
  ): void => {
    setFigureStyles((current) => ({
      ...current,
      [labelClass]: {
        ...current[labelClass],
        [field]: value,
      },
    }));
  }, []);

  const resetFigureStyles = useCallback((): void => {
    setFigureStyles(cloneDefaultFigureStyles());
    setTaxonomyColorJitter(DEFAULT_TAXONOMY_COLOR_JITTER);
    setTaxonomyBranchColoringEnabled(DEFAULT_TAXONOMY_BRANCH_COLORING_ENABLED);
    setUseAutomaticTaxonomyRankVisibility(true);
    setTaxonomyRankVisibility({});
    setTaxonomyCollapseRank(DEFAULT_TAXONOMY_COLLAPSE_RANK);
    setBranchThicknessScale(DEFAULT_BRANCH_THICKNESS_SCALE);
    setShowIntermediateScaleTicks(DEFAULT_SHOW_INTERMEDIATE_SCALE_TICKS);
    setExtendRectScaleToTick(DEFAULT_EXTEND_RECT_SCALE_TO_TICK);
    setShowScaleZeroTick(DEFAULT_SHOW_SCALE_ZERO_TICK);
    setScaleTickIntervalInput("");
    setUseAutoCircularCenterScaleAngle(true);
    setCircularCenterScaleAngleDegrees(DEFAULT_CIRCULAR_CENTER_SCALE_ANGLE_DEGREES);
    setShowCircularCenterRadialScaleBar(DEFAULT_SHOW_CIRCULAR_CENTER_RADIAL_SCALE_BAR);
    setTimeStripeStyle(DEFAULT_TIME_STRIPE_STYLE);
    setTimeStripeLineWeight(DEFAULT_TIME_STRIPE_LINE_WEIGHT);
    setShowNodeErrorBars(DEFAULT_SHOW_NODE_ERROR_BARS);
    setErrorBarThicknessPx(DEFAULT_ERROR_BAR_THICKNESS_PX);
    setErrorBarCapSizePx(DEFAULT_ERROR_BAR_CAP_SIZE_PX);
    setActiveLabelStylePopover(null);
    setVisualResetRequest((current) => current + 1);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.__BIG_TREE_VIEWER_APP_TEST__ = {
      getState: () => ({
        treeLoaded: tree !== null,
        treeSignature,
        loading: loadState.loading,
        loadError: loadState.error,
        viewMode,
        order,
        showGenusLabels,
        taxonomyEnabled,
        taxonomyStatus,
        taxonomyError,
        taxonomyCached,
        taxonomyLoading,
        taxonomyLowMemoryMode: useLowMemoryTaxonomyMapping,
        taxonomyBranchColoringEnabled,
        taxonomyRankVisibility,
        collapsibleTaxonomyRanks,
        taxonomyCollapseRank,
        taxonomyCollapseHasLowerRankFallbackLabels,
        taxonomyColorJitter,
        taxonomyMappedCount: viewTaxonomyMap?.mappedCount ?? 0,
        metadataEnabled,
        metadataFileName,
        metadataRowCount: metadataTable?.rows.length ?? 0,
        metadataKeyColumn,
        metadataValueColumn,
        metadataColorMode,
        metadataApplyScope,
        metadataContinuousPalette,
        metadataContinuousTransform,
        metadataContinuousMin,
        metadataContinuousMax,
        metadataLabelsEnabled,
        metadataLabelColumn,
        metadataMarkersEnabled,
        metadataMarkerColumn,
        metadataMarkerSizePx,
        metadataLabelMaxCount,
        metadataLabelMinSpacingPx,
        metadataLabelOffsetXPx,
        metadataLabelOffsetYPx,
        metadataMatchedRowCount: metadataOverlay.matchedRowCount,
        metadataMatchedNodeCount: metadataOverlay.matchedNodeCount,
        metadataColoredNodeCount: metadataOverlay.coloredNodeCount,
        metadataLabeledNodeCount: metadataLabelOverlay.labeledNodeCount,
        metadataMarkedNodeCount: metadataMarkerOverlay.markedNodeCount,
        showInternalNodeLabels,
        showBootstrapLabels,
        figureStyles,
        branchThicknessScale,
        showIntermediateScaleTicks,
        extendRectScaleToTick,
        showScaleZeroTick,
        scaleTickInterval,
        circularCenterScaleAngleDegrees: effectiveCircularCenterScaleAngleDegrees,
        circularCenterScaleAngleAuto: useAutoCircularCenterScaleAngle,
        showCircularCenterRadialScaleBar,
        taxonomyRankVisibilityAuto: useAutomaticTaxonomyRankVisibility,
        timeStripeStyle,
        timeStripeLineWeight,
        showNodeErrorBars,
        errorBarThicknessPx,
        errorBarCapSizePx,
        nodeIntervalCount: viewTree?.nodeIntervalCount ?? 0,
        maxDepth: viewTree?.maxDepth ?? null,
        rootAge: viewTree?.rootAge ?? null,
        isUltrametric: viewTree?.isUltrametric ?? false,
        searchQuery,
        activeSearchIndex,
        activeSearchResult: activeSearchResult
          ? {
            kind: activeSearchResult.kind,
            displayName: activeSearchResult.displayName,
            rank: activeSearchResult.rank ?? null,
            key: activeSearchResult.key ?? null,
            node: activeSearchResult.node,
          }
          : null,
        searchResults: searchResults.map((result) => ({
          kind: result.kind,
          displayName: result.displayName,
          rank: result.rank ?? null,
          key: result.key ?? null,
          node: result.node,
        })),
      }),
      setViewMode,
      setOrder,
      setShowGenusLabels,
      setShowInternalNodeLabels,
      setShowBootstrapLabels,
      setTaxonomyEnabled,
      setTaxonomyBranchColoringEnabled,
      setTaxonomyRankVisibilityForTest: (rank: TaxonomyRank, visible: boolean) => {
        setUseAutomaticTaxonomyRankVisibility(false);
        setTaxonomyRankVisibility((current) => ({
          ...current,
          [rank]: visible,
        }));
      },
      setTaxonomyRankVisibilityAutoForTest: (enabled: boolean) => {
        setUseAutomaticTaxonomyRankVisibility(enabled);
      },
      setTaxonomyCollapseRankForTest: setTaxonomyCollapseRank,
      setTaxonomyColorJitterForTest: setTaxonomyColorJitter,
      setBranchThicknessScaleForTest: setBranchThicknessScale,
      setShowIntermediateScaleTicks,
      setExtendRectScaleToTick,
      setShowScaleZeroTick,
      setScaleTickIntervalInput,
      setCircularCenterScaleAngleDegrees: (value: number) => {
        setUseAutoCircularCenterScaleAngle(false);
        setCircularCenterScaleAngleDegrees(value);
      },
      setUseAutoCircularCenterScaleAngle: (enabled: boolean) => {
        if (!enabled) {
          setCircularCenterScaleAngleDegrees(effectiveCircularCenterScaleAngleDegrees);
        }
        setUseAutoCircularCenterScaleAngle(enabled);
      },
      setShowCircularCenterRadialScaleBar,
      setTimeStripeStyle: (value: "bands" | "dashed") => setTimeStripeStyle(value),
      setTimeStripeLineWeight,
      setShowNodeErrorBars,
      setErrorBarThicknessPx,
      setErrorBarCapSizePx,
      setMetadataEnabled,
      setSearchQuery,
      setCircularRotationDegreesForTest: setCircularRotationDegrees,
      setTaxonomyMapForTest: (payload: TaxonomyMapPayload | null) => {
        setTaxonomyMap(payload);
        setTaxonomyEnabled(Boolean(payload));
      },
      importMetadataTextForTest: (text: string, label = "test-metadata.csv") => {
        importMetadataText(text, label);
      },
      clearMetadataForTest: () => {
        clearMetadata();
      },
      setMetadataKeyColumn,
      setMetadataValueColumn,
      setMetadataColorMode,
      setMetadataApplyScope,
      setMetadataReverseScale,
      setMetadataContinuousPalette,
      setMetadataContinuousTransform,
      setMetadataContinuousMinInput,
      setMetadataContinuousMaxInput,
      setMetadataLabelsEnabled,
      setMetadataLabelColumn,
      setMetadataMarkersEnabled,
      setMetadataMarkerColumn,
      setMetadataMarkerSizePx,
      setMetadataLabelMaxCount,
      setMetadataLabelMinSpacingPx,
      setMetadataLabelOffsetXPx,
      setMetadataLabelOffsetYPx,
      setFigureStyleForTest: (labelClass: LabelStyleClass, field: "fontFamily" | "sizeScale" | "offsetPx" | "offsetXPx" | "offsetYPx" | "bandThicknessScale" | "bold" | "italic", value: string | number | boolean) => {
        updateFigureStyle(labelClass, field, value as FontFamilyKey | number | boolean);
      },
      runRealTaxonomyMappingForTest: async () => {
        const archive = await getCachedTaxonomyArchive();
        if (!archive) {
          await downloadTaxonomy();
        }
        await runTaxonomyMapping();
      },
      downloadTaxonomyForTest: async () => {
        await downloadTaxonomy();
      },
      runTaxonomyMappingForTest: async () => {
        await runTaxonomyMapping();
      },
      getTaxonomyMapForTest: () => viewTaxonomyMap,
      setMockTaxonomy: () => {
        if (!tree) {
          return;
        }
        setTaxonomyMap(buildMockTaxonomyMap(tree));
        setTaxonomyEnabled(true);
      },
      cacheMockTaxonomy: async () => {
        if (!tree || !treeSignature) {
          return;
        }
        await putCachedTaxonomyMapping(treeSignature, buildMockTaxonomyMap(tree));
      },
      clearTaxonomy: () => {
        setTaxonomyMap(null);
        setTaxonomyEnabled(false);
      },
      rerootOnNodeForTest: (node: number, mode: RerootMode) => {
        rerootCurrentTree(node, mode);
      },
      requestSearchFocus: () => setFocusNodeRequest((value) => value + 1),
      requestFit: () => setFitRequest((value) => value + 1),
    };
    (window as typeof window & {
      __BIG_TREE_VIEWER_APP_TEST_INTERNAL__?: {
        leafNodes: number[];
        names?: string[];
        parent?: number[];
        firstChild?: number[];
        nextSibling?: number[];
      };
    }).__BIG_TREE_VIEWER_APP_TEST_INTERNAL__ = {
      leafNodes: viewTree ? Array.from(viewTree.leafNodes) : [],
      names: viewTree ? Array.from(viewTree.names) : [],
      parent: viewTree ? Array.from(viewTree.buffers.parent) : [],
      firstChild: viewTree ? Array.from(viewTree.buffers.firstChild) : [],
      nextSibling: viewTree ? Array.from(viewTree.buffers.nextSibling) : [],
    };
    return () => {
      delete window.__BIG_TREE_VIEWER_APP_TEST__;
      delete (window as typeof window & {
        __BIG_TREE_VIEWER_APP_TEST_INTERNAL__?: {
          leafNodes: number[];
          names?: string[];
          parent?: number[];
          firstChild?: number[];
          nextSibling?: number[];
        };
      }).__BIG_TREE_VIEWER_APP_TEST_INTERNAL__;
    };
  }, [
    activeSearchIndex,
    activeSearchResult,
    clearMetadata,
    downloadTaxonomy,
    importMetadataText,
    loadState.error,
    loadState.loading,
    metadataApplyScope,
    metadataColorMode,
    metadataContinuousMax,
    metadataContinuousMin,
    metadataContinuousPalette,
    metadataContinuousTransform,
    metadataEnabled,
    metadataFileName,
    metadataKeyColumn,
    metadataLabelColumn,
    metadataLabelOverlay.labeledNodeCount,
    metadataLabelMaxCount,
    metadataLabelMinSpacingPx,
    metadataLabelOffsetXPx,
    metadataLabelOffsetYPx,
    metadataLabelsEnabled,
    metadataMarkerColumn,
    metadataMarkerOverlay.markedNodeCount,
    metadataMarkerSizePx,
    metadataMarkersEnabled,
    metadataOverlay.coloredNodeCount,
    metadataOverlay.matchedNodeCount,
    metadataOverlay.matchedRowCount,
    extendRectScaleToTick,
    errorBarCapSizePx,
    errorBarThicknessPx,
    effectiveCircularCenterScaleAngleDegrees,
    scaleTickInterval,
    showScaleZeroTick,
    showIntermediateScaleTicks,
    showCircularCenterRadialScaleBar,
    useAutoCircularCenterScaleAngle,
    useAutomaticTaxonomyRankVisibility,
    showNodeErrorBars,
    metadataTable,
    metadataValueColumn,
    order,
    branchThicknessScale,
    downloadTaxonomy,
    figureStyles,
    rerootCurrentTree,
    runTaxonomyMapping,
    searchQuery,
    searchResults,
    showBootstrapLabels,
    showGenusLabels,
    showInternalNodeLabels,
    timeStripeLineWeight,
    timeStripeStyle,
    taxonomyBranchColoringEnabled,
    taxonomyCached,
    collapsibleTaxonomyRanks,
    taxonomyCollapseRank,
    taxonomyColorJitter,
    taxonomyCollapseHasLowerRankFallbackLabels,
    taxonomyEnabled,
    taxonomyError,
    taxonomyLoading,
    useLowMemoryTaxonomyMapping,
    taxonomyRankVisibility,
    taxonomyStatus,
    taxonomyMap,
    tree,
    viewTree,
    viewTaxonomyMap,
    treeSignature,
    updateFigureStyle,
    viewMode,
  ]);

  return (
    <div
      className={`app-shell${sidebarVisible ? "" : " sidebar-hidden"}${dragActive ? " drag-active" : ""}`}
      onDragEnter={(event) => {
        event.preventDefault();
        dragCounterRef.current += 1;
        setDragActive(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        event.preventDefault();
        dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
        if (dragCounterRef.current === 0) {
          setDragActive(false);
        }
      }}
      onDrop={(event) => void handleDrop(event)}
    >
      {dragActive ? <div className="drag-overlay">Drop a tree file, CSV/TSV metadata file, or Newick / NEXUS text to load it</div> : null}
      {!sidebarVisible ? (
        <button
          type="button"
          className="mobile-sidebar-toggle mobile-sidebar-toggle-floating"
          onClick={() => setSidebarVisible(true)}
        >
          Show Panel
        </button>
      ) : null}
      <aside className="control-panel">
        <div className="panel-title-row">
          <div className="panel-title-block">
            <h1>Big Tree Viewer</h1>
            <p>by John B Allard</p>
          </div>
          <button
            type="button"
            className="mobile-sidebar-toggle mobile-sidebar-toggle-inline"
            onClick={() => setSidebarVisible(false)}
          >
            Hide Panel
          </button>
        </div>

        <PanelSection title="Data" isOpen={dataOpen} onToggle={() => setDataOpen(!dataOpen)}>
          <div className="button-row">
            <button type="button" onClick={() => void loadExample()} disabled={loadState.loading}>
              Load Example
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => fileInputRef.current?.click()}
            >
              Open Newick
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => setShowPasteInput((value) => !value)}
            >
              Paste Newick
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".nwk,.newick,.tree,.tre,.txt,.nex,.nexus"
              hidden
              onChange={(event) => void onFileChange(event)}
            />
          </div>
          {showPasteInput ? (
            <div className="paste-tree">
              <textarea
                value={pastedTreeText}
                onChange={(event) => setPastedTreeText(event.target.value)}
                placeholder="Paste a Newick or NEXUS tree string here"
                spellCheck={false}
              />
              <div className="button-row">
                <button type="button" className="secondary" onClick={() => void loadPastedTree()}>
                  Load Pasted Tree
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setPastedTreeText("");
                    setShowPasteInput(false);
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
          <div className="button-row">
            <button
              type="button"
              className="secondary"
              disabled={!tree}
              onClick={requestSvgExport}
            >
              Export View SVG
            </button>
            <button
              type="button"
              className="secondary"
              disabled={!tree}
              onClick={downloadCurrentTreeNewick}
            >
              Download Newick
            </button>
          </div>
          {loadState.loading && loadState.message ? <p className="status-line">{loadState.message}</p> : null}
          {loadState.error ? <p className="status-error">{loadState.error}</p> : null}
        </PanelSection>

        <PanelSection title="View" isOpen={viewOpen} onToggle={() => setViewOpen(!viewOpen)}>
          <div className="segmented">
            <button
              type="button"
              className={viewMode === "rectangular" ? "active" : ""}
              onClick={() => setViewMode("rectangular")}
            >
              Rectangular
            </button>
            <button
              type="button"
              className={viewMode === "circular" ? "active" : ""}
              onClick={() => setViewMode("circular")}
            >
              Circular
            </button>
          </div>
          <div className="segmented">
            <button type="button" className={order === "asc" ? "active" : ""} onClick={() => setOrder("asc")}>
              Smallest First
            </button>
            <button type="button" className={order === "desc" ? "active" : ""} onClick={() => setOrder("desc")}>
              Largest First
            </button>
            <button type="button" className={order === "input" ? "active" : ""} onClick={() => setOrder("input")}>
              Input Order
            </button>
          </div>
          <div className="segmented">
            <button
              type="button"
              className={zoomAxisMode === "both" ? "active" : ""}
              onClick={() => setZoomAxisMode("both")}
              disabled={viewMode === "circular"}
              title={disabledControlTitle(viewMode === "circular" ? "Circular mode always zooms both axes together." : undefined)}
            >
              Zoom Both
            </button>
            <button
              type="button"
              className={zoomAxisMode === "x" ? "active" : ""}
              onClick={() => setZoomAxisMode("x")}
              disabled={viewMode === "circular"}
              title={disabledControlTitle(viewMode === "circular" ? "Circular mode always zooms both axes together." : undefined)}
            >
              Zoom X
            </button>
            <button
              type="button"
              className={zoomAxisMode === "y" ? "active" : ""}
              onClick={() => setZoomAxisMode("y")}
              disabled={viewMode === "circular"}
              title={disabledControlTitle(viewMode === "circular" ? "Circular mode always zooms both axes together." : undefined)}
            >
              Zoom Y
            </button>
          </div>
          <div className="button-row">
            <button type="button" className="secondary" onClick={() => setFitRequest((value) => value + 1)}>
              Fit View
            </button>
          </div>
          <p className="view-zoom-hint">
            <span className="view-zoom-hint-desktop">Push + to zoom in and - to zoom out.</span>
            <span className="view-zoom-hint-mobile">Pinch to zoom.</span>
          </p>
          {viewMode === "circular" ? (
            <div className="rotation-controls">
              <label htmlFor="circular-rotation">Rotation</label>
              <input
                id="circular-rotation"
                type="range"
                min={-180}
                max={180}
                step={1}
                value={circularRotationDegrees}
                onChange={(event) => setCircularRotationDegrees(Number(event.target.value))}
              />
              <div className="button-row">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setCircularRotationDegrees((value) => Math.max(-180, value - 15))}
                >
                  Rotate Left
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setCircularRotationDegrees((value) => Math.min(180, value + 15))}
                >
                  Rotate Right
                </button>
                <button type="button" className="secondary" onClick={() => setCircularRotationDegrees(0)}>
                  Reset
                </button>
              </div>
            </div>
          ) : null}
        </PanelSection>

        <PanelSection title="Visual Options" isOpen={visualOpen} onToggle={() => setVisualOpen(!visualOpen)}>
          <div className="option-list">
            <div className="visual-option-row">
              <span className="visual-option-static-label">Tip labels</span>
              <div className="visual-option-actions">
                <LabelStyleSection
                  labelClass="tip"
                  settings={figureStyles.tip}
                  viewMode={viewMode}
                  isOpen={activeLabelStylePopover === "tip"}
                  disabled={false}
                  onToggle={() => setActiveLabelStylePopover((current) => current === "tip" ? null : "tip")}
                  onUpdate={updateFigureStyle}
                />
              </div>
            </div>
            <div className="visual-option-row">
              <label className="visual-option-checkbox" title={disabledControlTitle(taxonomyEnabled ? "Turn off taxonomy overlays to show genus labels." : undefined)}>
                <input
                  type="checkbox"
                  checked={showGenusLabels}
                  onChange={(event) => setShowGenusLabels(event.target.checked)}
                  disabled={taxonomyEnabled}
                  title={disabledControlTitle(taxonomyEnabled ? "Turn off taxonomy overlays to show genus labels." : undefined)}
                />
                Show genus labels
              </label>
              <div className="visual-option-actions">
                <LabelStyleSection
                  labelClass="genus"
                  settings={figureStyles.genus}
                  viewMode={viewMode}
                  isOpen={activeLabelStylePopover === "genus"}
                  disabled={taxonomyEnabled || !showGenusLabels}
                  disabledReason={taxonomyEnabled ? "Turn off taxonomy overlays to edit genus labels." : "Enable genus labels first."}
                  onToggle={() => setActiveLabelStylePopover((current) => current === "genus" ? null : "genus")}
                  onUpdate={updateFigureStyle}
                />
              </div>
            </div>
            <div className="visual-option-row">
              <label className="visual-option-checkbox" title={disabledControlTitle(!taxonomyMap ? "Run taxonomy mapping first." : undefined)}>
                <input
                  type="checkbox"
                  checked={taxonomyEnabled}
                  onChange={(event) => setTaxonomyEnabled(event.target.checked)}
                  disabled={!taxonomyMap}
                  title={disabledControlTitle(!taxonomyMap ? "Run taxonomy mapping first." : undefined)}
                />
                Show taxonomy overlays
              </label>
              <div className="visual-option-actions">
                <LabelStyleSection
                  labelClass="taxonomy"
                  settings={figureStyles.taxonomy}
                  viewMode={viewMode}
                  isOpen={activeLabelStylePopover === "taxonomy"}
                  disabled={!taxonomyEnabled}
                  disabledReason="Turn on taxonomy overlays first."
                  extraControls={(
                    <>
                      <label>
                        Color jitter
                        <input
                          type="range"
                          min={0}
                          max={4}
                          step={0.05}
                          value={taxonomyColorJitter}
                          onChange={(event) => setTaxonomyColorJitter(Number(event.target.value))}
                        />
                      </label>
                      <div className="figure-style-value">x{taxonomyColorJitter.toFixed(2)}</div>
                      <label className="label-style-inline-toggle">
                        <input
                          type="checkbox"
                          checked={taxonomyBranchColoringEnabled}
                          onChange={(event) => setTaxonomyBranchColoringEnabled(event.target.checked)}
                        />
                        Taxonomy branch coloring
                      </label>
                      {taxonomyMap && availableTaxonomyRanks.length > 0 ? (
                        <>
                          <label className="label-style-inline-toggle">
                            <input
                              type="checkbox"
                              checked={useAutomaticTaxonomyRankVisibility}
                              onChange={(event) => handleAutomaticTaxonomyRankVisibilityChange(event.target.checked)}
                            />
                            Automatic visible ranks
                          </label>
                          <div className="taxonomy-rank-controls">
                            <div className="taxonomy-rank-controls-title">Visible taxonomy ranks</div>
                            <div className="taxonomy-rank-checkboxes">
                              {availableTaxonomyRanks.map((rank) => (
                                <label
                                  key={rank}
                                  className="taxonomy-rank-checkbox"
                                  title={disabledControlTitle(
                                    useAutomaticTaxonomyRankVisibility
                                      ? "Turn off automatic visible ranks to choose ranks manually."
                                      : undefined,
                                  )}
                                >
                                  <input
                                    type="checkbox"
                                    checked={taxonomyRankVisibility[rank] !== false}
                                    disabled={useAutomaticTaxonomyRankVisibility}
                                    onChange={(event) => {
                                      setTaxonomyRankVisibility((current) => ({
                                        ...current,
                                        [rank]: event.target.checked,
                                      }));
                                    }}
                                  />
                                  {taxonomyRankLabel(rank)}
                                </label>
                              ))}
                            </div>
                          </div>
                        </>
                      ) : null}
                    </>
                  )}
                  onToggle={() => setActiveLabelStylePopover((current) => current === "taxonomy" ? null : "taxonomy")}
                  onUpdate={updateFigureStyle}
                />
              </div>
            </div>
            <div className="visual-option-row">
              <label className="visual-option-checkbox" title={disabledControlTitle((tree?.nodeIntervalCount ?? 0) === 0 ? "This tree does not contain node interval annotations." : undefined)}>
                <input
                  type="checkbox"
                  checked={showInternalNodeLabels}
                  onChange={(event) => setShowInternalNodeLabels(event.target.checked)}
                />
                Show internal node labels
              </label>
              <div className="visual-option-actions">
                <LabelStyleSection
                  labelClass="internalNode"
                  settings={figureStyles.internalNode}
                  viewMode={viewMode}
                  isOpen={activeLabelStylePopover === "internalNode"}
                  disabled={!showInternalNodeLabels}
                  disabledReason="Enable internal node labels first."
                  onToggle={() => setActiveLabelStylePopover((current) => current === "internalNode" ? null : "internalNode")}
                  onUpdate={updateFigureStyle}
                />
              </div>
            </div>
            <div className="visual-option-row">
              <label className="visual-option-checkbox">
                <input
                  type="checkbox"
                  checked={showBootstrapLabels}
                  onChange={(event) => setShowBootstrapLabels(event.target.checked)}
                />
                Show bootstrap labels
              </label>
              <div className="visual-option-actions">
                <LabelStyleSection
                  labelClass="bootstrap"
                  settings={figureStyles.bootstrap}
                  viewMode={viewMode}
                  isOpen={activeLabelStylePopover === "bootstrap"}
                  disabled={!showBootstrapLabels}
                  disabledReason="Enable bootstrap labels first."
                  onToggle={() => setActiveLabelStylePopover((current) => current === "bootstrap" ? null : "bootstrap")}
                  onUpdate={updateFigureStyle}
                />
              </div>
            </div>
            <div className="visual-option-row">
              <label className="visual-option-checkbox">
                <input
                  type="checkbox"
                  checked={showNodeHeightLabels}
                  onChange={(event) => setShowNodeHeightLabels(event.target.checked)}
                />
                Show node height labels
              </label>
              <div className="visual-option-actions">
                <LabelStyleSection
                  labelClass="nodeHeight"
                  settings={figureStyles.nodeHeight}
                  viewMode={viewMode}
                  isOpen={activeLabelStylePopover === "nodeHeight"}
                  disabled={!showNodeHeightLabels}
                  disabledReason="Enable node height labels first."
                  onToggle={() => setActiveLabelStylePopover((current) => current === "nodeHeight" ? null : "nodeHeight")}
                  onUpdate={updateFigureStyle}
                />
              </div>
            </div>
            <div className="visual-option-row">
              <label className="visual-option-checkbox">
                <input
                  type="checkbox"
                  checked={showNodeErrorBars}
                  disabled={(tree?.nodeIntervalCount ?? 0) === 0}
                  onChange={(event) => setShowNodeErrorBars(event.target.checked)}
                  title={disabledControlTitle((tree?.nodeIntervalCount ?? 0) === 0 ? "This tree does not contain node interval annotations." : undefined)}
                />
                Show node error bars
              </label>
            </div>
            <div className="visual-option-row">
              <label className="visual-option-checkbox">
                <input
                  type="checkbox"
                  checked={showScaleBars}
                  onChange={(event) => setShowScaleBars(event.target.checked)}
                />
                Show scale bars
              </label>
              <div className="visual-option-actions">
                <LabelStyleSection
                  labelClass="scale"
                  settings={figureStyles.scale}
                  viewMode={viewMode}
                  isOpen={activeLabelStylePopover === "scale"}
                  disabled={!showScaleBars}
                  disabledReason="Enable scale bars first."
                  extraControls={(
                    <>
                      <label>
                        Tick interval
                        <input
                          type="number"
                          min={0}
                          step="any"
                          value={scaleTickIntervalInput}
                          placeholder="auto"
                          onChange={(event) => setScaleTickIntervalInput(event.target.value)}
                        />
                      </label>
                      <p className="figure-style-help">Leave blank for automatic tick spacing.</p>
                      <label className="label-style-inline-toggle">
                        <input
                          type="checkbox"
                          checked={showIntermediateScaleTicks}
                          onChange={(event) => setShowIntermediateScaleTicks(event.target.checked)}
                        />
                        Show fading subdivision ticks
                      </label>
                      <label className="label-style-inline-toggle">
                        <input
                          type="checkbox"
                          checked={extendRectScaleToTick}
                          onChange={(event) => setExtendRectScaleToTick(event.target.checked)}
                        />
                        Extend rectangular scale to next tick
                      </label>
                      <label className="label-style-inline-toggle">
                        <input
                          type="checkbox"
                          checked={showScaleZeroTick}
                          onChange={(event) => setShowScaleZeroTick(event.target.checked)}
                        />
                        Show zero tick
                      </label>
                      <label className="label-style-inline-toggle">
                        <input
                          type="checkbox"
                          checked={useAutoCircularCenterScaleAngle}
                          onChange={(event) => handleCircularCenterScaleAngleAutoChange(event.target.checked)}
                        />
                        Auto angle from tip ordering
                      </label>
                      <label>
                        Circular center scale angle
                        <input
                          type="range"
                          min={-180}
                          max={180}
                          step={1}
                          disabled={useAutoCircularCenterScaleAngle}
                          value={effectiveCircularCenterScaleAngleDegrees}
                          onChange={(event) => {
                            setUseAutoCircularCenterScaleAngle(false);
                            setCircularCenterScaleAngleDegrees(Number(event.target.value));
                          }}
                        />
                      </label>
                      <div className="figure-style-value">{effectiveCircularCenterScaleAngleDegrees.toFixed(0)} deg</div>
                      <label className="label-style-inline-toggle">
                        <input
                          type="checkbox"
                          checked={showCircularCenterRadialScaleBar}
                          onChange={(event) => setShowCircularCenterRadialScaleBar(event.target.checked)}
                        />
                        Show circular radial scale bar
                      </label>
                    </>
                  )}
                  onToggle={() => setActiveLabelStylePopover((current) => current === "scale" ? null : "scale")}
                  onUpdate={updateFigureStyle}
                />
              </div>
            </div>
            <div className="visual-option-row">
              <label className="visual-option-checkbox">
                <input
                  type="checkbox"
                  checked={showTimeStripes}
                  onChange={(event) => setShowTimeStripes(event.target.checked)}
                />
                Show time stripes
              </label>
              <div className="visual-option-actions">
                <SettingsPopoverButton
                  title="Time stripes"
                  isOpen={activeLabelStylePopover === "timeStripes"}
                  disabled={!showTimeStripes}
                  disabledReason="Enable time stripes first."
                  onToggle={() => setActiveLabelStylePopover((current) => current === "timeStripes" ? null : "timeStripes")}
                >
                  <label>
                    Stripe style
                    <select value={timeStripeStyle} onChange={(event) => setTimeStripeStyle(event.target.value as "bands" | "dashed")}>
                      <option value="bands">Shaded bands</option>
                      <option value="dashed">Dashed guides</option>
                    </select>
                  </label>
                  {timeStripeStyle === "dashed" ? (
                    <>
                      <label>
                        Stripe line weight
                        <input
                          type="range"
                          min={0.5}
                          max={4}
                          step={0.1}
                          value={timeStripeLineWeight}
                          onChange={(event) => setTimeStripeLineWeight(Number(event.target.value))}
                        />
                      </label>
                      <div className="figure-style-value">{timeStripeLineWeight.toFixed(1)}px</div>
                    </>
                  ) : null}
                </SettingsPopoverButton>
              </div>
            </div>
          </div>
          <div className="visual-options-controls">
            {showNodeErrorBars ? (
              <>
                <label>
                  Error bar thickness
                  <input
                    type="range"
                    min={0.5}
                    max={4}
                    step={0.1}
                    value={errorBarThicknessPx}
                    onChange={(event) => setErrorBarThicknessPx(Number(event.target.value))}
                  />
                </label>
                <div className="figure-style-value">{errorBarThicknessPx.toFixed(1)}px</div>
                <label>
                  Error bar cap size
                  <input
                    type="range"
                    min={0}
                    max={16}
                    step={1}
                    value={errorBarCapSizePx}
                    onChange={(event) => setErrorBarCapSizePx(Number(event.target.value))}
                  />
                </label>
                <div className="figure-style-value">{errorBarCapSizePx.toFixed(0)}px</div>
              </>
            ) : null}
            <label>
              Branch thickness
              <input
                type="range"
                min={0.5}
                max={4}
                step={0.05}
                value={branchThicknessScale}
                onChange={(event) => setBranchThicknessScale(Number(event.target.value))}
              />
            </label>
            <div className="figure-style-value">x{branchThicknessScale.toFixed(2)}</div>
          </div>
          <div className="visual-options-actions">
            <button type="button" className="secondary visual-options-reset" onClick={resetFigureStyles}>
              Reset Defaults
            </button>
          </div>
        </PanelSection>

        <PanelSection title="Taxonomy" isOpen={taxonomyOpen} onToggle={() => setTaxonomyOpen(!taxonomyOpen)}>
          <div className="search-controls">
            {taxonomyCached ? (
              <p className="status-line">Taxonomy cache found.</p>
            ) : (
              <div className="button-row">
                <button
                  type="button"
                  className="secondary"
                  disabled={taxonomyLoading}
                  title={disabledControlTitle(taxonomyLoading ? "Taxonomy download already in progress." : undefined)}
                  onClick={() => void downloadTaxonomy()}
                >
                  Download Taxonomy
                </button>
              </div>
            )}
            {taxonomyCached ? (
              <div className="button-row">
                <button
                  type="button"
                  className="secondary"
                  disabled={taxonomyLoading || !tree}
                  title={disabledControlTitle(
                    taxonomyLoading
                      ? "Taxonomy mapping is already running."
                      : !tree
                        ? "Load a tree first."
                        : undefined,
                  )}
                  onClick={() => void runTaxonomyMapping()}
                >
                  Run Taxonomy Mapping
                </button>
              </div>
            ) : null}
            {taxonomyStatus ? <p className="status-line">{taxonomyStatus}</p> : null}
            {taxonomyError ? <p className="status-error">{taxonomyError}</p> : null}
            {taxonomyMap ? (
              <>
                <label>
                  Collapse mapped tips to
                  <select
                    value={taxonomyCollapseRank}
                    onChange={(event) => setTaxonomyCollapseRank(event.target.value as TaxonomyCollapseRank)}
                  >
                    <option value="species">Species</option>
                    {collapsibleTaxonomyRanks.map((rank) => (
                      <option key={rank} value={rank}>{taxonomyRankLabel(rank)}</option>
                    ))}
                  </select>
                </label>
                {taxonomyCollapseActiveRank && taxonomyCollapseHasLowerRankFallbackLabels ? (
                  <p className="status-line">
                    * This taxon is a lower rank than {taxonomyRankLabel(taxonomyCollapseActiveRank)} because this lineage lacked a {taxonomyRankLabel(taxonomyCollapseActiveRank)} in the NCBI taxonomy.
                  </p>
                ) : null}
              </>
            ) : null}
          </div>
        </PanelSection>

        <PanelSection title="Metadata" isOpen={metadataOpen} onToggle={() => setMetadataOpen(!metadataOpen)}>
          <div className="search-controls">
            <input
              ref={metadataFileInputRef}
              type="file"
              accept=".csv,.tsv,text/csv,text/tab-separated-values"
              hidden
              onChange={(event) => void onMetadataFileChange(event)}
            />
            <div className="button-row">
              <button type="button" className="secondary" onClick={() => metadataFileInputRef.current?.click()}>
                Open CSV / TSV
              </button>
              <button type="button" className="secondary" disabled={!metadataTable} onClick={clearMetadata}>
                Clear Metadata
              </button>
            </div>
            {metadataTable ? (
              <>
                <p className="status-line">
                  {metadataFileName || "metadata"}: {metadataTable.rows.length.toLocaleString()} rows, {metadataTable.columns.length.toLocaleString()} columns
                </p>
                <label className="metadata-inline-toggle">
                  <input
                    type="checkbox"
                    checked={metadataFirstRowIsHeader}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setMetadataFirstRowIsHeader(checked);
                      if (metadataRawText && metadataFileName) {
                        applyMetadataText(metadataRawText, metadataFileName, checked);
                      }
                    }}
                  />
                  Treat first line as a header
                </label>
                <label>
                  Match tree labels by column
                  <select value={metadataKeyColumn} onChange={(event) => setMetadataKeyColumn(event.target.value)}>
                    {metadataColumns.map((column) => (
                      <option key={column} value={column}>{column}</option>
                    ))}
                  </select>
                </label>
                <div className="metadata-toggle-row">
                  <label className="metadata-inline-toggle metadata-toggle-main">
                    <input
                      type="checkbox"
                      checked={metadataEnabled}
                      onChange={(event) => setMetadataEnabled(event.target.checked)}
                    />
                    Enable metadata branch colors
                  </label>
                  <SettingsPopoverButton
                    title="Metadata branch colors"
                    isOpen={activeLabelStylePopover === "metadataBranchColors"}
                    disabled={!metadataEnabled}
                    disabledReason="Enable metadata branch colors first."
                    onToggle={() => setActiveLabelStylePopover((current) => current === "metadataBranchColors" ? null : "metadataBranchColors")}
                  >
                    <label>
                      Color by column
                      <select value={metadataValueColumn} onChange={(event) => {
                        const nextColumn = event.target.value;
                        setMetadataValueColumn(nextColumn);
                        setMetadataColorMode(metadataColumnLooksContinuous(metadataTable.rows, nextColumn) ? "continuous" : "categorical");
                      }}
                      >
                        {metadataColumns.map((column) => (
                          <option key={column} value={column}>{column}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Apply colors to
                      <select value={metadataApplyScope} onChange={(event) => setMetadataApplyScope(event.target.value as MetadataApplyScope)}>
                        <option value="branch">Matched branches</option>
                        <option value="subtree">Matched subtrees</option>
                      </select>
                    </label>
                    <label>
                      Color mode
                      <select
                        value={metadataColorMode}
                        onChange={(event) => setMetadataColorMode(event.target.value as MetadataColorMode)}
                      >
                        <option value="categorical">Categorical</option>
                        <option value="continuous" disabled={!metadataValueColumnSupportsContinuous}>Continuous</option>
                      </select>
                    </label>
                    {metadataColorMode === "continuous" ? (
                      <>
                        <label>
                          Palette
                          <select
                            value={metadataContinuousPalette}
                            onChange={(event) => setMetadataContinuousPalette(event.target.value as MetadataContinuousPalette)}
                          >
                            {Object.entries(METADATA_CONTINUOUS_PALETTES).map(([key, palette]) => (
                              <option key={key} value={key}>{palette.label}</option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Transform
                          <select
                            value={metadataContinuousTransform}
                            onChange={(event) => setMetadataContinuousTransform(event.target.value as MetadataContinuousTransform)}
                          >
                            <option value="linear">Linear</option>
                            <option value="sqrt">Signed square root</option>
                            <option value="log">Signed log1p</option>
                          </select>
                        </label>
                        <label>
                          Clamp minimum
                          <input
                            type="number"
                            value={metadataContinuousMinInput}
                            placeholder="auto"
                            onChange={(event) => setMetadataContinuousMinInput(event.target.value)}
                          />
                        </label>
                        <label>
                          Clamp maximum
                          <input
                            type="number"
                            value={metadataContinuousMaxInput}
                            placeholder="auto"
                            onChange={(event) => setMetadataContinuousMaxInput(event.target.value)}
                          />
                        </label>
                        <label className="metadata-inline-toggle">
                          <input
                            type="checkbox"
                            checked={metadataReverseScale}
                            onChange={(event) => setMetadataReverseScale(event.target.checked)}
                          />
                          Reverse continuous scale
                        </label>
                      </>
                    ) : null}
                    {metadataColorMode === "categorical" && metadataOverlay.categoryLegend.length > 0 ? (
                      <div className="metadata-legend" data-testid="metadata-legend">
                        {metadataOverlay.categoryLegend.map((item) => (
                          <div key={item.label} className="metadata-legend-item">
                            <div className="metadata-legend-item-controls">
                              <input
                                className="metadata-legend-swatch-input"
                                type="color"
                                aria-label={`Set metadata branch color for ${item.label}`}
                                value={item.color}
                                onChange={(event) => {
                                  setMetadataCategoryColorOverrides((current) => ({
                                    ...current,
                                    [item.label]: event.target.value,
                                  }));
                                }}
                              />
                            </div>
                            <span className="metadata-legend-label">{item.label}</span>
                            <span className="metadata-legend-count">{item.count.toLocaleString()}</span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {metadataColorMode === "continuous" && metadataOverlay.continuousLegend ? (
                      <div className="metadata-gradient-legend" data-testid="metadata-gradient-legend">
                        <div
                          className="metadata-gradient-bar"
                          style={{
                            background: metadataOverlay.continuousLegend.gradientCss,
                          }}
                        />
                        <div className="metadata-gradient-labels">
                          <span>{formatNumber(metadataOverlay.continuousLegend.min)}</span>
                          <span>{formatNumber(metadataOverlay.continuousLegend.max)}</span>
                        </div>
                        <div className="metadata-gradient-labels">
                          <span>data {formatNumber(metadataOverlay.continuousLegend.actualMin)}</span>
                          <span>{METADATA_CONTINUOUS_PALETTES[metadataOverlay.continuousLegend.palette].label} · {metadataOverlay.continuousLegend.transform}</span>
                          <span>data {formatNumber(metadataOverlay.continuousLegend.actualMax)}</span>
                        </div>
                      </div>
                    ) : null}
                  </SettingsPopoverButton>
                </div>
                <div className="metadata-toggle-row">
                  <label className="metadata-inline-toggle metadata-toggle-main">
                    <input
                      type="checkbox"
                      checked={metadataLabelsEnabled}
                      onChange={(event) => setMetadataLabelsEnabled(event.target.checked)}
                    />
                    Show metadata text labels
                  </label>
                  <SettingsPopoverButton
                    title="Metadata text labels"
                    isOpen={activeLabelStylePopover === "metadataLabels"}
                    disabled={!metadataLabelsEnabled}
                    disabledReason="Enable metadata text labels first."
                    onToggle={() => setActiveLabelStylePopover((current) => current === "metadataLabels" ? null : "metadataLabels")}
                  >
                    <label>
                      Text label column
                      <select value={metadataLabelColumn} onChange={(event) => setMetadataLabelColumn(event.target.value)}>
                        {metadataColumns.map((column) => (
                          <option key={column} value={column}>{column}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Font family
                      <select
                        value={figureStyles.internalNode.fontFamily}
                        onChange={(event) => updateFigureStyle("internalNode", "fontFamily", event.target.value as FontFamilyKey)}
                      >
                        {FONT_FAMILY_OPTIONS.map((option) => (
                          <option key={option.key} value={option.key}>{option.label}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Size scale
                      <input
                        type="range"
                        min={0.6}
                        max={1.8}
                        step={0.05}
                        value={figureStyles.internalNode.sizeScale}
                        onChange={(event) => updateFigureStyle("internalNode", "sizeScale", Number(event.target.value))}
                      />
                    </label>
                    <div className="figure-style-value">x{figureStyles.internalNode.sizeScale.toFixed(2)}</div>
                    <label>
                      Metadata label max count
                      <input
                        type="range"
                        min={20}
                        max={600}
                        step={10}
                        value={metadataLabelMaxCount}
                        onChange={(event) => setMetadataLabelMaxCount(Number(event.target.value))}
                      />
                    </label>
                    <div className="figure-style-value">{metadataLabelMaxCount.toLocaleString()}</div>
                    <label>
                      Metadata label spacing
                      <input
                        type="range"
                        min={0}
                        max={28}
                        step={1}
                        value={metadataLabelMinSpacingPx}
                        onChange={(event) => setMetadataLabelMinSpacingPx(Number(event.target.value))}
                      />
                    </label>
                    <div className="figure-style-value">{metadataLabelMinSpacingPx}px</div>
                    <label>
                      Metadata label X offset
                      <input
                        type="range"
                        min={-36}
                        max={36}
                        step={1}
                        value={metadataLabelOffsetXPx}
                        onChange={(event) => setMetadataLabelOffsetXPx(Number(event.target.value))}
                      />
                    </label>
                    <div className="figure-style-value">{metadataLabelOffsetXPx}px</div>
                    <label>
                      Metadata label Y offset
                      <input
                        type="range"
                        min={-36}
                        max={36}
                        step={1}
                        value={metadataLabelOffsetYPx}
                        onChange={(event) => setMetadataLabelOffsetYPx(Number(event.target.value))}
                      />
                    </label>
                    <div className="figure-style-value">{metadataLabelOffsetYPx}px</div>
                  </SettingsPopoverButton>
                </div>
                <div className="metadata-toggle-row">
                  <label className="metadata-inline-toggle metadata-toggle-main">
                    <input
                      type="checkbox"
                      checked={metadataMarkersEnabled}
                      onChange={(event) => setMetadataMarkersEnabled(event.target.checked)}
                    />
                    Show metadata markers
                  </label>
                  <SettingsPopoverButton
                    title="Metadata markers"
                    isOpen={activeLabelStylePopover === "metadataMarkers"}
                    disabled={!metadataMarkersEnabled}
                    disabledReason="Enable metadata markers first."
                    onToggle={() => setActiveLabelStylePopover((current) => current === "metadataMarkers" ? null : "metadataMarkers")}
                  >
                    <label>
                      Marker category column
                      <select value={metadataMarkerColumn} onChange={(event) => setMetadataMarkerColumn(event.target.value)}>
                        {metadataColumns.map((column) => (
                          <option key={column} value={column}>{column}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Marker size
                      <input
                        type="range"
                        min={4}
                        max={20}
                        step={1}
                        value={metadataMarkerSizePx}
                        onChange={(event) => setMetadataMarkerSizePx(Number(event.target.value))}
                      />
                    </label>
                    <div className="figure-style-value">{metadataMarkerSizePx}px</div>
                    {metadataMarkerOverlay.legend.length > 0 ? (
                      <div className="metadata-legend" data-testid="metadata-marker-legend">
                        {metadataMarkerOverlay.legend.map((item) => (
                          <div key={item.label} className="metadata-legend-item">
                            <div className="metadata-legend-item-controls">
                              <input
                                className="metadata-legend-swatch-input"
                                type="color"
                                aria-label={`Set metadata marker color for ${item.label}`}
                                value={item.color}
                                onChange={(event) => {
                                  setMetadataMarkerStyleOverrides((current) => ({
                                    ...current,
                                    [item.label]: {
                                      ...current[item.label],
                                      color: event.target.value,
                                    },
                                  }));
                                }}
                              />
                              <select
                                className="metadata-shape-select"
                                aria-label={`Set metadata marker shape for ${item.label}`}
                                value={item.shape}
                                onChange={(event) => {
                                  setMetadataMarkerStyleOverrides((current) => ({
                                    ...current,
                                    [item.label]: {
                                      ...current[item.label],
                                      shape: event.target.value as MetadataMarkerShape,
                                    },
                                  }));
                                }}
                              >
                                <option value="circle">Circle</option>
                                <option value="square">Square</option>
                                <option value="diamond">Diamond</option>
                                <option value="triangle">Triangle</option>
                              </select>
                            </div>
                            <span className="metadata-legend-label">{item.label}</span>
                            <span className="metadata-legend-count">{item.count.toLocaleString()}</span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </SettingsPopoverButton>
                </div>
                <div className="metadata-summary">
                  <span>Matched rows: {metadataOverlay.matchedRowCount.toLocaleString()}</span>
                  {metadataOverlay.matchedNodeCount !== metadataOverlay.matchedRowCount ? (
                    <span>Matched nodes: {metadataOverlay.matchedNodeCount.toLocaleString()}</span>
                  ) : null}
                  {metadataEnabled && metadataOverlay.coloredNodeCount !== metadataOverlay.matchedNodeCount ? (
                    <span>Colored nodes: {metadataOverlay.coloredNodeCount.toLocaleString()}</span>
                  ) : null}
                  {metadataLabelsEnabled && metadataLabelOverlay.labeledNodeCount !== metadataOverlay.matchedNodeCount ? (
                    <span>Text labels: {metadataLabelOverlay.labeledNodeCount.toLocaleString()}</span>
                  ) : null}
                  {metadataMarkersEnabled && metadataMarkerOverlay.markedNodeCount !== metadataOverlay.matchedNodeCount ? (
                    <span>Markers: {metadataMarkerOverlay.markedNodeCount.toLocaleString()}</span>
                  ) : null}
                </div>
                {metadataOverlay.unmappedRowCount > 0 ? (
                  <p className="status-line">
                    Unmapped rows: {metadataOverlay.unmappedRowCount.toLocaleString()}
                  </p>
                ) : null}
                {metadataOverlay.invalidValueRowCount > 0 ? (
                  <p className="status-line">
                    Invalid numeric rows: {metadataOverlay.invalidValueRowCount.toLocaleString()}
                  </p>
                ) : null}
              </>
            ) : null}
            {metadataStatus ? <p className="status-line">{metadataStatus}</p> : null}
            {metadataError ? <p className="status-error">{metadataError}</p> : null}
          </div>
        </PanelSection>

        <PanelSection title="Search" isOpen={searchOpen} onToggle={() => setSearchOpen(!searchOpen)}>
          <div className="search-controls">
            <div className="search-input-wrap">
              <input
                type="search"
                value={searchQuery}
                placeholder="Search tip, node, genus, or taxonomy names"
                disabled={!tree}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && activeSearchResult !== null) {
                    event.preventDefault();
                    setFocusNodeRequest((value) => value + 1);
                  }
                }}
              />
              <button
                type="button"
                className="search-clear"
                aria-label="Clear search"
                disabled={!searchQuery}
                onClick={() => {
                  setSearchQuery("");
                  setActiveSearchIndex(0);
                }}
              >
                ×
              </button>
            </div>
            <div className="button-row">
              <button
                type="button"
                className="secondary"
                disabled={searchResults.length === 0}
                onClick={() => stepSearch(-1)}
              >
                Previous
              </button>
              <button
                type="button"
                className="secondary"
                disabled={searchResults.length === 0}
                onClick={() => stepSearch(1)}
              >
                Next
              </button>
              <button
                type="button"
                className="secondary"
                disabled={activeSearchResult === null}
                onClick={() => setFocusNodeRequest((value) => value + 1)}
              >
                Focus
              </button>
            </div>
            {searchQuery.trim() ? (
              <>
                <p className="status-line">
                  {searchResults.length === 0
                  ? "No matches."
                  : `Showing ${activeSearchIndex + 1} of ${searchResults.length}`}
                </p>
                {activeSearchResult ? (
                  <p className="search-match-name">
                    {searchResultLabel(activeSearchResult)}
                  </p>
                ) : null}
              </>
            ) : null}
          </div>
        </PanelSection>

        {showDiagnosticsPanel ? (
          <PanelSection title="Diagnostics" isOpen={diagnosticsOpen} onToggle={() => setDiagnosticsOpen(!diagnosticsOpen)}>
            <div className="search-controls">
              {unexpectedDiagnosticsSessionId ? (
                <p className="status-error">
                  The previous session on this device appears to have ended unexpectedly. Copy the report below and send it over.
                </p>
              ) : (
                <p className="status-line">
                  Diagnostics stay on this device. The report includes recent app events and taxonomy progress, but not your tree text.
                </p>
              )}
              <div className="button-row">
                <button type="button" className="secondary" onClick={() => void copyDiagnosticsReport()}>
                  Copy Diagnostics
                </button>
                <button type="button" className="secondary" onClick={clearDiagnosticsReport}>
                  Clear Diagnostics
                </button>
              </div>
              {diagnosticsStatus ? <p className="status-line">{diagnosticsStatus}</p> : null}
              <textarea
                className="diagnostics-report"
                readOnly
                rows={12}
                value={diagnosticsReport}
              />
            </div>
          </PanelSection>
        ) : null}

        <PanelSection title="Stats" isOpen={statsOpen} onToggle={() => setStatsOpen(!statsOpen)}>
          {viewTree ? (
            <div>
              <dl className="stats-list">
                <dt>Tips</dt>
                <dd>{viewTree.leafCount.toLocaleString()}</dd>
                <dt>Nodes</dt>
                <dd>{viewTree.nodeCount.toLocaleString()}</dd>
                <dt>Tree depth</dt>
                <dd>{formatNumber(viewTree.maxDepth)}</dd>
                <dt>Root age</dt>
                <dd>{formatNumber(viewTree.rootAge)}</dd>
                <dt>Ultrametric</dt>
                <dd>{viewTree.isUltrametric ? "Yes" : "No"}</dd>
              </dl>
            </div>
          ) : (
            <p className="empty-note">No tree loaded.</p>
          )}
        </PanelSection>
      </aside>

      <main className="viewer-panel">
        <TreeCanvas
          tree={viewTree}
          order={order}
          viewMode={viewMode}
          zoomAxisMode={viewMode === "circular" ? "both" : zoomAxisMode}
          circularRotation={(circularRotationDegrees * Math.PI) / 180}
          showTimeStripes={showTimeStripes}
          timeStripeStyle={timeStripeStyle}
          timeStripeLineWeight={timeStripeLineWeight}
          showScaleBars={showScaleBars}
          scaleTickInterval={scaleTickInterval}
          showIntermediateScaleTicks={showIntermediateScaleTicks}
          extendRectScaleToTick={extendRectScaleToTick}
          showScaleZeroTick={showScaleZeroTick}
          circularCenterScaleAngleDegrees={effectiveCircularCenterScaleAngleDegrees}
          useAutoCircularCenterScaleAngle={useAutoCircularCenterScaleAngle}
          showCircularCenterRadialScaleBar={showCircularCenterRadialScaleBar}
          showGenusLabels={showGenusLabels && !taxonomyEnabled && !taxonomyCollapseIsSynthetic}
          taxonomyEnabled={taxonomyEnabled}
          taxonomyBranchColoringEnabled={taxonomyBranchColoringEnabled}
          taxonomyColorJitter={taxonomyColorJitter}
          useAutomaticTaxonomyRankVisibility={useAutomaticTaxonomyRankVisibility}
          taxonomyRankVisibility={taxonomyRankVisibility}
          taxonomyCollapseRank={taxonomyCollapseRank}
          taxonomyMap={viewTaxonomyMap}
          taxonomyColorSourceMap={taxonomyMap}
          sharedSubtreeSourceTree={tree}
          sharedSubtreeSourceTaxonomyMap={taxonomyMap}
          sharedSubtreeSourceNodeByViewNode={collapsedTaxonomyView?.sourceNodeByNode ?? null}
          metadataBranchColors={metadataEnabled && !metadataOverlaysSuppressed && metadataOverlay.hasAny ? metadataOverlay.colors : null}
          metadataBranchColorVersion={metadataEnabled ? metadataOverlay.version : ""}
          metadataLabels={metadataLabelsEnabled && !metadataOverlaysSuppressed && metadataLabelOverlay.hasAny ? metadataLabelOverlay.labels : null}
          metadataLabelVersion={metadataLabelsEnabled ? metadataLabelOverlay.version : ""}
          metadataMarkers={metadataMarkersEnabled && !metadataOverlaysSuppressed && metadataMarkerOverlay.hasAny ? metadataMarkerOverlay.markers : null}
          metadataMarkerVersion={metadataMarkersEnabled ? metadataMarkerOverlay.version : ""}
          metadataMarkerSizePx={metadataMarkerSizePx}
          metadataLabelMaxCount={metadataLabelMaxCount}
          metadataLabelMinSpacingPx={metadataLabelMinSpacingPx}
          metadataLabelOffsetXPx={metadataLabelOffsetXPx}
          metadataLabelOffsetYPx={metadataLabelOffsetYPx}
          showInternalNodeLabels={showInternalNodeLabels}
          showBootstrapLabels={showBootstrapLabels}
          figureStyles={figureStyles}
          branchThicknessScale={branchThicknessScale}
          showNodeHeightLabels={showNodeHeightLabels}
          showNodeErrorBars={showNodeErrorBars}
          errorBarThicknessPx={errorBarThicknessPx}
          errorBarCapSizePx={errorBarCapSizePx}
          searchQuery={searchQuery}
          searchMatches={searchMatches}
          activeSearchNode={activeSearchNode}
          activeSearchGenusCenterNode={activeSearchGenusCenterNode}
          activeSearchTaxonomyNode={activeSearchTaxonomyNode}
          activeSearchTaxonomyKey={activeSearchTaxonomyKey}
          focusNodeRequest={focusNodeRequest}
          fitRequest={fitRequest}
          exportSvgRequest={exportSvgRequest}
          exportSvgFilename={exportSvgFilename}
          visualResetRequest={visualResetRequest}
          onHoverChange={handleHoverChange}
          onRerootRequest={taxonomyCollapseIsSynthetic ? undefined : rerootCurrentTree}
          onViewModeChange={setViewMode}
        />
      </main>
    </div>
  );
}
