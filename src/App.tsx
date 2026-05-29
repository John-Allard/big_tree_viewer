import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type DragEvent, type ReactNode } from "react";
import { gzip, gunzip, strFromU8, strToU8 } from "fflate";
import TreeCanvas from "./components/TreeCanvas";
import { computeGenusBlocks, computeOrderedLeaves } from "./components/treeCanvasCache";
import type { TaxonomyOverlayStyle, TimeStripeStyle } from "./components/treeCanvasTypes";
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
import { HOME_DESCRIPTION } from "./siteCopy";
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
  buildPhyloPicAttributionCaption,
  PHYLOPIC_MAX_RETRIEVE_PER_CLICK,
  PhyloPicRateLimitError,
  readCachedPhyloPicSilhouette,
  retrievePhyloPicSilhouette,
  type PhyloPicCandidate,
  type PhyloPicSilhouette,
} from "./lib/phylopic";
import {
  parseSharedSubtreeStoragePayload,
  rebuildSharedSubtreeTaxonomyMap,
  type SharedSubtreeTaxonomyPayload,
  type SharedSubtreeVisualPayload,
} from "./lib/sharedSubtreePayload";
import {
  DEFAULT_TAXONOMY_COLOR_PALETTE,
  parseCustomTaxonomyPalette,
  SPIRAL_TTOL_TAXONOMY_COLOR_PALETTE,
  TAXONOMY_COLOR_PALETTE_KEYS,
  TAXONOMY_COLOR_PALETTES,
  type TaxonomyColorPaletteKey,
} from "./lib/taxonomyPalettes";
import { DEFAULT_TIME_AXIS_LOG_BASE, MAX_TIME_AXIS_LOG_BASE, MIN_TIME_AXIS_LOG_BASE, type TimeAxisScale } from "./lib/timeAxis";
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
import { looksLikeTreeText, normalizeImportedTreeText } from "./lib/treeImport";
import type { WorkerResponse } from "./types/messages";
import { TAXONOMY_RANKS, type TaxonomyCollapseRank, type TaxonomyMapPayload, type TaxonomyRank } from "./types/taxonomy";
import type { WorkerTreePayload } from "./types/tree";
import type { LayoutOrder, LoadState, TreeModel, ViewMode, ZoomAxisMode } from "./types/tree";
import type { LabelStyleSettings } from "./lib/figureStyles";
import type { TreeCanvasSessionState } from "./components/treeCanvasTypes";

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

function normalizePngExportFilename(value: string, fallbackBaseLabel: string): string {
  const trimmed = value.trim();
  const base = trimmed
    .replace(/[/\\?%*:|"<>]+/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^_+|_+$/g, "")
    || `${fallbackBaseLabel}.png`;
  return /\.png$/i.test(base) ? base : `${base}.png`;
}

type ExportViewFormat = "png" | "svg";

type BigTreeViewerLaunchPayload = {
  version?: 1;
  newick?: string;
  label?: string;
  controls?: {
    hideDownloadNewick?: boolean;
  };
  visual?: {
    viewMode?: ViewMode;
    order?: LayoutOrder;
    zoomAxisMode?: ZoomAxisMode;
    circularRotationDegrees?: number;
    spiralTurns?: number;
    showTipLabels?: boolean;
    showGenusLabels?: boolean;
    showTimeStripes?: boolean;
    showScaleBars?: boolean;
    timeAxisScale?: TimeAxisScale;
    timeAxisLogBase?: number;
    branchThicknessScale?: number;
    taxonomyEnabled?: boolean;
    taxonomyBranchColoringEnabled?: boolean;
    taxonomyColorPalette?: TaxonomyColorPaletteKey;
  };
  metadata?: {
    text?: string;
    label?: string;
    firstRowIsHeader?: boolean;
    enabled?: boolean;
    keyColumn?: string;
    valueColumn?: string;
    colorMode?: MetadataColorMode;
    applyScope?: MetadataApplyScope;
    labelsEnabled?: boolean;
    labelColumn?: string;
    markersEnabled?: boolean;
    markerColumn?: string;
  };
};

type BigTreeViewerSessionSettings = {
  viewMode: ViewMode;
  showSpiralViewOption: boolean;
  order: LayoutOrder;
  zoomAxisMode: ZoomAxisMode;
  circularRotationDegrees: number;
  spiralTurns: number;
  showTimeStripes: boolean;
  timeStripeStyle: TimeStripeStyle;
  timeStripeLineWeight: number;
  timeAxisScale: TimeAxisScale;
  timeAxisLogBase: number;
  showScaleBars: boolean;
  showIntermediateScaleTicks: boolean;
  extendRectScaleToTick: boolean;
  showScaleZeroTick: boolean;
  scaleTickIntervalInput: string;
  useAutoCircularCenterScaleAngle: boolean;
  circularCenterScaleAngleDegrees: number;
  showCircularCenterRadialScaleBar: boolean;
  showTipLabels: boolean;
  showGenusLabels: boolean;
  showInternalNodeLabels: boolean;
  showBootstrapLabels: boolean;
  showNodeHeightLabels: boolean;
  showNodeErrorBars: boolean;
  errorBarThicknessPx: number;
  errorBarCapSizePx: number;
  figureStyles: FigureStyleSettings;
  taxonomyEnabled: boolean;
  taxonomyOverlayStyle: TaxonomyOverlayStyle;
  taxonomyRankVisibility: Partial<Record<TaxonomyRank, boolean>>;
  taxonomyCollapseRank: TaxonomyCollapseRank;
  useAutomaticTaxonomyRankVisibility: boolean;
  taxonomyBranchColoringEnabled: boolean;
  taxonomyColorJitter: number;
  taxonomyColorPalette: TaxonomyColorPaletteKey;
  taxonomyCustomPaletteInput: string;
  taxonomyColorRootRank: TaxonomyRank | "auto";
  taxonomyColorJitterRank: TaxonomyRank;
  phylopicRankSelection?: Partial<Record<TaxonomyRank, boolean>>;
  phylopicPlacement?: "after-label" | "outside-ribbon";
  branchThicknessScale: number;
  metadataEnabled: boolean;
  metadataFirstRowIsHeader: boolean;
  metadataKeyColumn: string;
  metadataValueColumn: string;
  metadataColorMode: MetadataColorMode;
  metadataApplyScope: MetadataApplyScope;
  metadataReverseScale: boolean;
  metadataContinuousPalette: MetadataContinuousPalette;
  metadataContinuousTransform: MetadataContinuousTransform;
  metadataContinuousMinInput: string;
  metadataContinuousMaxInput: string;
  metadataLabelsEnabled: boolean;
  metadataLabelColumn: string;
  metadataMarkersEnabled: boolean;
  metadataMarkerColumn: string;
  metadataCategoryColorOverrides: Record<string, string>;
  metadataMarkerStyleOverrides: Record<string, { color?: string; shape?: MetadataMarkerShape }>;
  metadataMarkerSizePx: number;
  metadataLabelMaxCount: number;
  metadataLabelMinSpacingPx: number;
  metadataLabelOffsetXPx: number;
  metadataLabelOffsetYPx: number;
};

type BigTreeViewerSessionFile = {
  format: "big-tree-viewer-session";
  version: 1;
  savedAt: string;
  settings: BigTreeViewerSessionSettings;
  tree?: {
    label: string;
    newick: string;
    signature: string | null;
  };
  metadata?: {
    text: string;
    label: string;
    firstRowIsHeader: boolean;
  };
  taxonomy?: {
    map: TaxonomyMapPayload | null;
  };
  canvas?: TreeCanvasSessionState | null;
};

const MAX_REMOTE_LAUNCH_BYTES = 150 * 1024 * 1024;

function decodeBase64UrlText(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

function parseLaunchJsonParam(value: string | null): Partial<BigTreeViewerLaunchPayload> | null {
  if (!value) {
    return null;
  }
  try {
    const decoded = decodeBase64UrlText(value);
    const parsed = JSON.parse(decoded) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Partial<BigTreeViewerLaunchPayload> : null;
  } catch {
    return null;
  }
}

function readLaunchTextParam(params: URLSearchParams, plainKey: string, encodedKey: string): string | undefined {
  const encoded = params.get(encodedKey);
  if (encoded) {
    try {
      return decodeBase64UrlText(encoded);
    } catch {
      return undefined;
    }
  }
  return params.get(plainKey) ?? undefined;
}

function parseSessionText(text: string): BigTreeViewerSessionFile {
  let parsed: Partial<BigTreeViewerSessionFile>;
  try {
    parsed = JSON.parse(text) as Partial<BigTreeViewerSessionFile>;
  } catch {
    throw new Error("This is not a valid Big Tree Viewer session file.");
  }
  if (parsed.format !== "big-tree-viewer-session" || parsed.version !== 1 || !parsed.settings) {
    throw new Error("This is not a valid Big Tree Viewer session file.");
  }
  return parsed as BigTreeViewerSessionFile;
}

function gzipBytes(data: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    gzip(data, { level: 6, mtime: 0 }, (error, compressed) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(compressed);
    });
  });
}

function bytesAreGzip(data: Uint8Array): boolean {
  return data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b;
}

function gunzipBytes(data: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    gunzip(data, (error, decompressed) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(decompressed);
    });
  });
}

async function buildSessionBlob(session: BigTreeViewerSessionFile): Promise<Blob> {
  const text = JSON.stringify(session);
  const compressed = await gzipBytes(strToU8(text));
  const bytes = new ArrayBuffer(compressed.byteLength);
  new Uint8Array(bytes).set(compressed);
  return new Blob([bytes], { type: "application/octet-stream" });
}

async function parseSessionBytes(data: Uint8Array): Promise<BigTreeViewerSessionFile> {
  const text = bytesAreGzip(data) ? strFromU8(await gunzipBytes(data)) : strFromU8(data);
  return parseSessionText(text);
}

function fileLooksLikeSession(file: File): boolean {
  return /\.(btvsession|json)$/i.test(file.name) || file.type === "application/json";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function launchLabelFromUrl(url: string, fallback: string): string {
  try {
    const parsed = new URL(url, window.location.href);
    const pathName = parsed.pathname.split("/").filter(Boolean).pop();
    return pathName ? decodeURIComponent(pathName) : fallback;
  } catch {
    return fallback;
  }
}

function normalizeRemoteLaunchUrl(url: string): URL {
  const parsed = new URL(url.trim(), window.location.href);
  if (parsed.hostname === "www.dropbox.com" || parsed.hostname === "dropbox.com") {
    parsed.hostname = "dl.dropboxusercontent.com";
    parsed.searchParams.delete("raw");
    parsed.searchParams.set("dl", "1");
  }
  return parsed;
}

async function fetchRemoteLaunchBytes(url: string, label: string): Promise<Uint8Array> {
  const trimmed = url.trim();
  if (!trimmed) {
    throw new Error(`${label} URL is empty.`);
  }
  const parsed = normalizeRemoteLaunchUrl(trimmed);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} URL must use http or https.`);
  }
  const response = await fetch(parsed.toString(), { credentials: "omit", mode: "cors" });
  if (!response.ok) {
    throw new Error(`Could not fetch ${label} URL (${response.status} ${response.statusText}).`);
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_REMOTE_LAUNCH_BYTES) {
    throw new Error(`${label} file is too large for URL launch.`);
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_REMOTE_LAUNCH_BYTES) {
    throw new Error(`${label} file is too large for URL launch.`);
  }
  return new Uint8Array(buffer);
}

async function fetchRemoteLaunchText(url: string, label: string): Promise<string> {
  return new TextDecoder().decode(await fetchRemoteLaunchBytes(url, label));
}

function readLaunchBoolParam(params: URLSearchParams, key: string): boolean | undefined {
  const value = params.get(key);
  if (value === null) {
    return undefined;
  }
  if (/^(1|true|yes|on)$/i.test(value)) {
    return true;
  }
  if (/^(0|false|no|off)$/i.test(value)) {
    return false;
  }
  return undefined;
}

function readLaunchNumberParam(params: URLSearchParams, key: string): number | undefined {
  const value = params.get(key);
  if (value === null || value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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
  tourId,
  children,
}: {
  title: string;
  isOpen: boolean;
  onToggle: () => void;
  tourId?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <section className="panel-section" data-tour={tourId}>
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
const DEFAULT_SPIRAL_TURNS = 5.5;
const DEFAULT_TIME_STRIPE_STYLE: TimeStripeStyle = "bands";
const DEFAULT_TIME_STRIPE_LINE_WEIGHT = 1.1;
const DEFAULT_TAXONOMY_OVERLAY_STYLE: TaxonomyOverlayStyle = "ribbons";
const DEFAULT_SHOW_NODE_ERROR_BARS = false;
const DEFAULT_ERROR_BAR_THICKNESS_PX = 1.2;
const DEFAULT_ERROR_BAR_CAP_SIZE_PX = 7;
const DEFAULT_METADATA_LABEL_MAX_COUNT = 240;
const DEFAULT_METADATA_LABEL_MIN_SPACING_PX = 10;
const DEFAULT_METADATA_LABEL_OFFSET_X_PX = 0;
const DEFAULT_METADATA_LABEL_OFFSET_Y_PX = 0;
const TUTORIAL_COMPLETED_STORAGE_KEY = "big-tree-viewer-tutorial-completed";
const TUTORIAL_DISMISSED_STORAGE_KEY = "big-tree-viewer-tutorial-dismissed";
const TUTORIAL_HASH = "#tutorial";
const MOBILE_TUTORIAL_MEDIA_QUERY = "(max-width: 980px), (pointer: coarse)";

function suppressTutorialForCurrentViewport(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return window.matchMedia(MOBILE_TUTORIAL_MEDIA_QUERY).matches;
}

type TutorialStepId = "data" | "navigation" | "visual" | "taxonomy" | "branchMenu" | "metadata" | "sessions";

const TUTORIAL_STEPS: Array<{
  id: TutorialStepId;
  target: string;
  title: string;
  body: string;
}> = [
  {
    id: "data",
    target: "data",
    title: "Load a tree",
    body: "Open a Newick/NEXUS file, drag a tree onto the page, or paste a Newick string. Trees are parsed locally in your browser; Big Tree Viewer does not upload your data.",
  },
  {
    id: "navigation",
    target: "view",
    title: "Navigate the tree",
    body: "Switch between rectangular and circular layouts, choose tip ordering, fit the view, and zoom with the wheel, trackpad pinch, +/-, or touch gestures. Rectangular mode can lock zoom to X, Y, or both axes.",
  },
  {
    id: "visual",
    target: "visual",
    title: "Style the figure",
    body: "Visual Options controls labels, time stripes, branch thickness, and export styling. Gear buttons open detailed controls for typography, spacing, line weights, and taxonomy ribbon styling.",
  },
  {
    id: "taxonomy",
    target: "taxonomy",
    title: "Map taxonomy",
    body: "You can automatically map binomial species tip names to taxonomic groups and display colored taxonomy ribbons on your tree. Download Taxonomy fetches the NCBI taxdump archive, roughly a few hundred MB compressed, and caches it in browser site storage for later mappings.",
  },
  {
    id: "branchMenu",
    target: "branch-menu-demo",
    title: "Use the branch menu",
    body: "Right-click or control-click a branch, tip, or taxonomy ribbon to open the context menu. Use it to zoom to subtrees, reroot, open a subtree in a new tab, collapse clades, copy tip names, or assign manual branch and subtree colors.",
  },
  {
    id: "metadata",
    target: "metadata",
    title: "Display metadata",
    body: "Open a CSV or TSV table, choose the column that matches tree labels, then color branches, add text labels, or draw markers from other columns. Metadata stays local in the browser.",
  },
  {
    id: "sessions",
    target: "sessions",
    title: "Save your work",
    body: "Save Session writes a compressed .btvsession file containing the tree, metadata, settings, manual colors, collapsed clades, taxonomy mapping, and viewport. Load Settings applies reusable styling from a saved session to another tree.",
  },
];

function tutorialCardPositionForTarget(target: Element, card: HTMLElement | null): CSSProperties {
  const rect = target.getBoundingClientRect();
  const margin = 16;
  const gap = 14;
  const cardWidth = Math.min(card?.offsetWidth || 420, window.innerWidth - (margin * 2));
  const cardHeight = Math.min(card?.offsetHeight || 240, window.innerHeight - (margin * 2));
  let left = rect.right + gap;
  let top = rect.top + (rect.height * 0.5) - (cardHeight * 0.5);

  if (left + cardWidth > window.innerWidth - margin) {
    left = rect.left - cardWidth - gap;
  }
  if (left < margin) {
    left = Math.min(window.innerWidth - margin - cardWidth, Math.max(margin, rect.left));
    top = rect.bottom + gap;
  }
  if (top + cardHeight > window.innerHeight - margin) {
    top = rect.top - cardHeight - gap;
  }

  return {
    top: Math.max(margin, Math.min(window.innerHeight - margin - cardHeight, top)),
    left: Math.max(margin, Math.min(window.innerWidth - margin - cardWidth, left)),
  };
}
const DEFAULT_METADATA_MARKER_SIZE_PX = 9;
const DEFAULT_TAXONOMY_COLLAPSE_RANK: TaxonomyCollapseRank = "species";
const DEFAULT_TIME_AXIS_SCALE: TimeAxisScale = "linear";
const DEFAULT_TAXONOMY_COLOR_ROOT_RANK: TaxonomyRank | "auto" = "auto";
const DEFAULT_TAXONOMY_COLOR_JITTER_RANK: TaxonomyRank = "genus";
const TAXONOMY_ARCHIVE_URL = "https://ftp.ncbi.nlm.nih.gov/pub/taxonomy/taxdmp.zip";
type VisualPopoverId =
  | LabelStyleClass
  | "timeStripes"
  | "phylopic"
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
  const usePolarOffsets = supportsAxisOffsets && viewMode !== "rectangular";
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
                  min={viewMode === "spiral" ? 0.15 : 0.65}
                  max={viewMode === "spiral" ? 5 : 1.8}
                  step={0.05}
                  value={settings.bandThicknessScale ?? 1}
                  onChange={(event) => onUpdate(labelClass, "bandThicknessScale", Number(event.target.value))}
                />
              </label>
              <div className="figure-style-value">x{(settings.bandThicknessScale ?? 1).toFixed(2)}</div>
              <label>
                Ribbon gap
                <input
                  type="range"
                  min={0}
                  max={40}
                  step={1}
                  value={settings.taxonomyGapPx ?? 0}
                  onChange={(event) => onUpdate(labelClass, "taxonomyGapPx", Number(event.target.value))}
                />
              </label>
              <div className="figure-style-value">{Math.max(0, settings.taxonomyGapPx ?? 0)}px</div>
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
  const pendingSessionTaxonomyRef = useRef<TaxonomyMapPayload | null | undefined>(undefined);
  const pendingSessionTaxonomyEnabledRef = useRef<boolean | null>(null);
  const pendingSessionCanvasStateRef = useRef<TreeCanvasSessionState | null | undefined>(undefined);
  const pendingSessionRestoreResolverRef = useRef<(() => void) | null>(null);
  const pendingSessionSnapshotResolverRef = useRef<((state: TreeCanvasSessionState | null) => void) | null>(null);
  const pendingTreeParseResolverRef = useRef<(() => void) | null>(null);
  const pendingTreeParseRejecterRef = useRef<((error: Error) => void) | null>(null);
  const phylopicCancelRequestedRef = useRef(false);
  const spiralShortcutKeysRef = useRef(new Set<string>());
  const [tree, setTree] = useState<TreeModel | null>(null);
  const [treeSignature, setTreeSignature] = useState<string | null>(null);
  const [loadedTreeLabel, setLoadedTreeLabel] = useState("tree");
  const [loadState, setLoadState] = useState<LoadState>({
    loading: false,
    message: "Load a Newick tree to begin.",
    error: null,
  });
  const [showSpiralViewOption, setShowSpiralViewOption] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("rectangular");
  const [order, setOrder] = useState<LayoutOrder>("asc");
  const [zoomAxisMode, setZoomAxisMode] = useState<ZoomAxisMode>("both");
  const [circularRotationDegrees, setCircularRotationDegrees] = useState(0);
  const [showTimeStripes, setShowTimeStripes] = useState(true);
  const [timeAxisScale, setTimeAxisScale] = useState<TimeAxisScale>(DEFAULT_TIME_AXIS_SCALE);
  const [timeAxisLogBase, setTimeAxisLogBase] = useState(DEFAULT_TIME_AXIS_LOG_BASE);
  const [timeAxisLogBaseDraft, setTimeAxisLogBaseDraft] = useState(DEFAULT_TIME_AXIS_LOG_BASE);
  const [showScaleBars, setShowScaleBars] = useState(true);
  const [showIntermediateScaleTicks, setShowIntermediateScaleTicks] = useState(DEFAULT_SHOW_INTERMEDIATE_SCALE_TICKS);
  const [extendRectScaleToTick, setExtendRectScaleToTick] = useState(DEFAULT_EXTEND_RECT_SCALE_TO_TICK);
  const [showScaleZeroTick, setShowScaleZeroTick] = useState(DEFAULT_SHOW_SCALE_ZERO_TICK);
  const [scaleTickIntervalInput, setScaleTickIntervalInput] = useState("");
  const [useAutomaticTaxonomyRankVisibility, setUseAutomaticTaxonomyRankVisibility] = useState(true);
  const [useAutoCircularCenterScaleAngle, setUseAutoCircularCenterScaleAngle] = useState(true);
  const [circularCenterScaleAngleDegrees, setCircularCenterScaleAngleDegrees] = useState(DEFAULT_CIRCULAR_CENTER_SCALE_ANGLE_DEGREES);
  const [showCircularCenterRadialScaleBar, setShowCircularCenterRadialScaleBar] = useState(DEFAULT_SHOW_CIRCULAR_CENTER_RADIAL_SCALE_BAR);
  const [spiralTurns, setSpiralTurns] = useState(DEFAULT_SPIRAL_TURNS);
  const [timeStripeStyle, setTimeStripeStyle] = useState<TimeStripeStyle>(DEFAULT_TIME_STRIPE_STYLE);
  const [timeStripeLineWeight, setTimeStripeLineWeight] = useState(DEFAULT_TIME_STRIPE_LINE_WEIGHT);
  const [showTipLabels, setShowTipLabels] = useState(true);
  const [showGenusLabels, setShowGenusLabels] = useState(true);
  const [showInternalNodeLabels, setShowInternalNodeLabels] = useState(false);
  const [showBootstrapLabels, setShowBootstrapLabels] = useState(false);
  const [showNodeHeightLabels, setShowNodeHeightLabels] = useState(false);
  const [showNodeErrorBars, setShowNodeErrorBars] = useState(DEFAULT_SHOW_NODE_ERROR_BARS);
  const [errorBarThicknessPx, setErrorBarThicknessPx] = useState(DEFAULT_ERROR_BAR_THICKNESS_PX);
  const [errorBarCapSizePx, setErrorBarCapSizePx] = useState(DEFAULT_ERROR_BAR_CAP_SIZE_PX);
  const [figureStyles, setFigureStyles] = useState<FigureStyleSettings>(() => cloneDefaultFigureStyles());
  const [taxonomyColorJitter, setTaxonomyColorJitter] = useState(DEFAULT_TAXONOMY_COLOR_JITTER);
  const [taxonomyColorPalette, setTaxonomyColorPalette] = useState<TaxonomyColorPaletteKey>(DEFAULT_TAXONOMY_COLOR_PALETTE);
  const [taxonomyCustomPaletteInput, setTaxonomyCustomPaletteInput] = useState("");
  const [taxonomyColorRootRank, setTaxonomyColorRootRank] = useState<TaxonomyRank | "auto">(DEFAULT_TAXONOMY_COLOR_ROOT_RANK);
  const [taxonomyColorJitterRank, setTaxonomyColorJitterRank] = useState<TaxonomyRank>(DEFAULT_TAXONOMY_COLOR_JITTER_RANK);
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
  const [exportPngRequest, setExportPngRequest] = useState(0);
  const [exportPngFilename, setExportPngFilename] = useState("big-tree-view.png");
  const [exportPngWidth, setExportPngWidth] = useState(6000);
  const [exportPngHeight, setExportPngHeight] = useState(6000);
  const [showExportOptions, setShowExportOptions] = useState(false);
  const [exportViewFormat, setExportViewFormat] = useState<ExportViewFormat>("png");
  const [exportViewFilenameInput, setExportViewFilenameInput] = useState("big-tree-view.png");
  const [exportViewWidthInput, setExportViewWidthInput] = useState(6000);
  const [exportViewHeightInput, setExportViewHeightInput] = useState(6000);
  const [exportViewPrintWidthInchesInput, setExportViewPrintWidthInchesInput] = useState(20);
  const [exportViewPrintHeightInchesInput, setExportViewPrintHeightInchesInput] = useState(20);
  const [exportViewDpiInput, setExportViewDpiInput] = useState(300);
  const [sessionStateRequest, setSessionStateRequest] = useState(0);
  const [sessionRestoreRequest, setSessionRestoreRequest] = useState(0);
  const [sessionRestoreState, setSessionRestoreState] = useState<TreeCanvasSessionState | null>(null);
  const [sessionStatus, setSessionStatus] = useState("");
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [hideDownloadNewick, setHideDownloadNewick] = useState(false);
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
  const [taxonomyStorageInfoVisible, setTaxonomyStorageInfoVisible] = useState(false);
  const [taxonomyEnabled, setTaxonomyEnabled] = useState(false);
  const [taxonomyOverlayStyle, setTaxonomyOverlayStyle] = useState<TaxonomyOverlayStyle>(DEFAULT_TAXONOMY_OVERLAY_STYLE);
  const [taxonomyRankVisibility, setTaxonomyRankVisibility] = useState<Partial<Record<TaxonomyRank, boolean>>>({});
  const [taxonomyCollapseRank, setTaxonomyCollapseRank] = useState<TaxonomyCollapseRank>(DEFAULT_TAXONOMY_COLLAPSE_RANK);
  const [taxonomyMap, setTaxonomyMap] = useState<TaxonomyMapPayload | null>(null);
  const [phylopicEnabled, setPhyloPicEnabled] = useState(false);
  const [phylopicOpen, setPhyloPicOpen] = useSessionDisclosure("taxonomy-phylopic", false);
  const [phylopicRetrieving, setPhyloPicRetrieving] = useState(false);
  const [phylopicStatus, setPhyloPicStatus] = useState("");
  const [phylopicError, setPhyloPicError] = useState<string | null>(null);
  const [phylopicRankSelection, setPhyloPicRankSelection] = useState<Partial<Record<TaxonomyRank, boolean>>>({});
  const [phylopicViewportRanks, setPhyloPicViewportRanks] = useState<TaxonomyRank[]>([]);
  const [phylopicPlacement, setPhyloPicPlacement] = useState<"after-label" | "outside-ribbon">("after-label");
  const [phylopicSizeScale, setPhyloPicSizeScale] = useState(1.35);
  const [phylopicOffsetXPx, setPhyloPicOffsetXPx] = useState(0);
  const [phylopicOffsetYPx, setPhyloPicOffsetYPx] = useState(0);
  const [phylopicSilhouettes, setPhyloPicSilhouettes] = useState<PhyloPicSilhouette[]>([]);
  const [phylopicCaptionVisible, setPhyloPicCaptionVisible] = useState(false);
  const [phylopicReminderDismissed, setPhyloPicReminderDismissed] = useState(false);
  const [diagnosticsRevision, setDiagnosticsRevision] = useState(0);
  const [diagnosticsStatus, setDiagnosticsStatus] = useState("");
  const [unexpectedDiagnosticsSessionId, setUnexpectedDiagnosticsSessionId] = useState<string | null>(null);
  const diagnosticsSessionIdRef = useRef<string>(createDiagnosticsSessionId());
  const showDiagnosticsPanel = useMemo(() => diagnosticsPanelEnabled(), []);
  const useLowMemoryTaxonomyMapping = useMemo(() => useLowMemoryTaxonomyMode(), []);
  const shouldShowTutorialPrompt = useMemo(() => {
    if (typeof window === "undefined") {
      return false;
    }
    if (suppressTutorialForCurrentViewport()) {
      return false;
    }
    return window.localStorage.getItem(TUTORIAL_COMPLETED_STORAGE_KEY) !== "true"
      && window.localStorage.getItem(TUTORIAL_DISMISSED_STORAGE_KEY) !== "true";
  }, []);
  const [tutorialPromptVisible, setTutorialPromptVisible] = useState(shouldShowTutorialPrompt);
  const [tutorialActive, setTutorialActive] = useState(false);
  const [tutorialStepIndex, setTutorialStepIndex] = useState(0);
  const [tutorialCardPosition, setTutorialCardPosition] = useState<CSSProperties | undefined>(undefined);
  const [tutorialCardReady, setTutorialCardReady] = useState(false);
  const [tutorialSuppressedForMobile, setTutorialSuppressedForMobile] = useState(() => suppressTutorialForCurrentViewport());
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const queries = [
      window.matchMedia("(max-width: 980px)"),
      window.matchMedia("(pointer: coarse)"),
    ];
    const updateSuppression = (): void => {
      setTutorialSuppressedForMobile(queries.some((query) => query.matches));
    };
    updateSuppression();
    queries.forEach((query) => {
      if (typeof query.addEventListener === "function") {
        query.addEventListener("change", updateSuppression);
      } else {
        query.addListener(updateSuppression);
      }
    });
    return () => {
      queries.forEach((query) => {
        if (typeof query.removeEventListener === "function") {
          query.removeEventListener("change", updateSuppression);
        } else {
          query.removeListener(updateSuppression);
        }
      });
    };
  }, []);
  useEffect(() => {
    if (!tutorialSuppressedForMobile) {
      return;
    }
    setTutorialPromptVisible(false);
    setTutorialActive(false);
    setTutorialCardReady(false);
  }, [tutorialSuppressedForMobile]);
  useEffect(() => {
    if (showSpiralViewOption) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.repeat || !event.shiftKey) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key !== "s" && key !== "p") {
        return;
      }
      const pressed = spiralShortcutKeysRef.current;
      pressed.add(key);
      if (pressed.has("s") && pressed.has("p")) {
        setShowSpiralViewOption(true);
        pressed.clear();
      }
    };
    const handleKeyUp = (event: KeyboardEvent): void => {
      spiralShortcutKeysRef.current.delete(event.key.toLowerCase());
      if (event.key === "Shift") {
        spiralShortcutKeysRef.current.clear();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [showSpiralViewOption]);

  const openSectionForTutorialStep = useCallback((stepIndex: number): void => {
    const step = TUTORIAL_STEPS[stepIndex];
    if (!step) {
      return;
    }
    if (step.id === "data" || step.id === "sessions") {
      setDataOpen(true);
    } else if (step.id === "navigation") {
      setViewOpen(true);
    } else if (step.id === "branchMenu") {
      setDataOpen(false);
      setViewOpen(false);
      setVisualOpen(false);
      setTaxonomyOpen(false);
      setMetadataOpen(false);
    } else if (step.id === "visual") {
      setVisualOpen(true);
    } else if (step.id === "taxonomy") {
      setTaxonomyOpen(true);
    } else if (step.id === "metadata") {
      setMetadataOpen(true);
    }
  }, [setDataOpen, setMetadataOpen, setTaxonomyOpen, setViewOpen, setVisualOpen]);

  const showTutorialStep = useCallback((stepIndex: number): void => {
    const boundedIndex = Math.max(0, Math.min(TUTORIAL_STEPS.length - 1, stepIndex));
    setTutorialCardReady(false);
    openSectionForTutorialStep(boundedIndex);
    setTutorialStepIndex(boundedIndex);
  }, [openSectionForTutorialStep]);

  const completeTutorial = useCallback((remember = true): void => {
    setTutorialActive(false);
    setTutorialPromptVisible(false);
    setTutorialCardReady(false);
    setTutorialStepIndex(0);
    if (remember && typeof window !== "undefined") {
      window.localStorage.setItem(TUTORIAL_COMPLETED_STORAGE_KEY, "true");
      window.localStorage.removeItem(TUTORIAL_DISMISSED_STORAGE_KEY);
    }
  }, []);

  const dismissTutorial = useCallback((dontShowAgain = false): void => {
    setTutorialActive(false);
    setTutorialPromptVisible(false);
    setTutorialCardReady(false);
    setTutorialStepIndex(0);
    if (dontShowAgain && typeof window !== "undefined") {
      window.localStorage.setItem(TUTORIAL_DISMISSED_STORAGE_KEY, "true");
    }
  }, []);

  const startTutorial = useCallback((): void => {
    if (tutorialSuppressedForMobile) {
      return;
    }
    setTutorialPromptVisible(false);
    showTutorialStep(0);
    setTutorialActive(true);
  }, [showTutorialStep, tutorialSuppressedForMobile]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const maybeStartTutorialFromHash = (): void => {
      if (window.location.hash !== TUTORIAL_HASH) {
        return;
      }
      startTutorial();
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    };
    maybeStartTutorialFromHash();
    window.addEventListener("hashchange", maybeStartTutorialFromHash);
    return () => {
      window.removeEventListener("hashchange", maybeStartTutorialFromHash);
    };
  }, [startTutorial]);

  useLayoutEffect(() => {
    if (!tutorialActive) {
      window.document.querySelectorAll(".tour-highlight").forEach((element) => element.classList.remove("tour-highlight"));
      setTutorialCardPosition(undefined);
      setTutorialCardReady(false);
      return;
    }
    const step = TUTORIAL_STEPS[tutorialStepIndex];
    if (!step) {
      return;
    }
    const positionCardNearTarget = (target: Element): void => {
      setTutorialCardPosition(tutorialCardPositionForTarget(
        target,
        window.document.querySelector<HTMLElement>(".tutorial-card"),
      ));
      setTutorialCardReady(true);
    };

    window.document.querySelectorAll(".tour-highlight").forEach((element) => element.classList.remove("tour-highlight"));
    let retryFrame: number | null = null;
    let retryCount = 0;
    const attachToTarget = (): void => {
      const target = window.document.querySelector(`[data-tour="${step.target}"]`);
      if (!target) {
        if (retryCount < 60) {
          retryCount += 1;
          retryFrame = window.requestAnimationFrame(attachToTarget);
        }
        return;
      }
      target.classList.add("tour-highlight");
      target.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
      positionCardNearTarget(target);
    };
    attachToTarget();
    const handleResize = (): void => {
      const currentTarget = window.document.querySelector(`[data-tour="${step.target}"]`);
      if (currentTarget) {
        positionCardNearTarget(currentTarget);
      }
    };
    window.addEventListener("resize", handleResize);
    window.addEventListener("scroll", handleResize, true);
    return () => {
      if (retryFrame !== null) {
        window.cancelAnimationFrame(retryFrame);
      }
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("scroll", handleResize, true);
      window.document.querySelectorAll(".tour-highlight").forEach((element) => element.classList.remove("tour-highlight"));
    };
  }, [
    tutorialActive,
    tutorialStepIndex,
  ]);
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
    setSpiralTurns(visual.spiralTurns);
    setShowTimeStripes(visual.showTimeStripes);
    setTimeAxisScale(visual.timeAxisScale);
    setTimeAxisLogBase(visual.timeAxisLogBase);
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
    setShowTipLabels(visual.showTipLabels);
    setShowGenusLabels(visual.showGenusLabels);
    setShowInternalNodeLabels(visual.showInternalNodeLabels);
    setShowBootstrapLabels(visual.showBootstrapLabels);
    setShowNodeHeightLabels(visual.showNodeHeightLabels);
    setShowNodeErrorBars(visual.showNodeErrorBars);
    setErrorBarThicknessPx(visual.errorBarThicknessPx);
    setErrorBarCapSizePx(visual.errorBarCapSizePx);
    setFigureStyles(visual.figureStyles);
    setTaxonomyEnabled(visual.taxonomyEnabled);
    setTaxonomyOverlayStyle(visual.taxonomyOverlayStyle === "strands" ? "strands" : "ribbons");
    setTaxonomyBranchColoringEnabled(visual.taxonomyBranchColoringEnabled);
    setUseAutomaticTaxonomyRankVisibility(visual.useAutomaticTaxonomyRankVisibility);
    setTaxonomyRankVisibility(visual.taxonomyRankVisibility);
    setTaxonomyCollapseRank(visual.taxonomyCollapseRank);
    setTaxonomyColorJitter(visual.taxonomyColorJitter);
    setTaxonomyColorPalette(visual.taxonomyColorPalette);
    setTaxonomyCustomPaletteInput(visual.taxonomyCustomPaletteInput);
    setTaxonomyColorRootRank(visual.taxonomyColorRootRank);
    setTaxonomyColorJitterRank(visual.taxonomyColorJitterRank);
    setBranchThicknessScale(visual.branchThicknessScale);
  }, []);

  const applyLaunchVisualSettings = useCallback((visual: BigTreeViewerLaunchPayload["visual"] | undefined): void => {
    if (!visual) {
      return;
    }
    if (visual.viewMode === "rectangular" || visual.viewMode === "circular" || visual.viewMode === "spiral") {
      setViewMode(visual.viewMode);
      if (visual.viewMode === "spiral") {
        setShowSpiralViewOption(true);
      }
    }
    if (visual.order === "asc" || visual.order === "desc" || visual.order === "input") {
      setOrder(visual.order);
    }
    if (visual.zoomAxisMode === "both" || visual.zoomAxisMode === "x" || visual.zoomAxisMode === "y") {
      setZoomAxisMode(visual.zoomAxisMode);
    }
    if (typeof visual.circularRotationDegrees === "number" && Number.isFinite(visual.circularRotationDegrees)) {
      setCircularRotationDegrees(visual.circularRotationDegrees);
    }
    if (typeof visual.spiralTurns === "number" && Number.isFinite(visual.spiralTurns)) {
      setSpiralTurns(visual.spiralTurns);
    }
    if (typeof visual.showTipLabels === "boolean") {
      setShowTipLabels(visual.showTipLabels);
    }
    if (typeof visual.showGenusLabels === "boolean") {
      setShowGenusLabels(visual.showGenusLabels);
    }
    if (typeof visual.showTimeStripes === "boolean") {
      setShowTimeStripes(visual.showTimeStripes);
    }
    if (typeof visual.showScaleBars === "boolean") {
      setShowScaleBars(visual.showScaleBars);
    }
    if (visual.timeAxisScale === "linear" || visual.timeAxisScale === "log") {
      setTimeAxisScale(visual.timeAxisScale);
    }
    if (typeof visual.timeAxisLogBase === "number" && Number.isFinite(visual.timeAxisLogBase)) {
      setTimeAxisLogBase(Math.max(MIN_TIME_AXIS_LOG_BASE, Math.min(MAX_TIME_AXIS_LOG_BASE, visual.timeAxisLogBase)));
    }
    if (typeof visual.branchThicknessScale === "number" && Number.isFinite(visual.branchThicknessScale)) {
      setBranchThicknessScale(visual.branchThicknessScale);
    }
    if (typeof visual.taxonomyEnabled === "boolean") {
      setTaxonomyEnabled(visual.taxonomyEnabled);
    }
    if (typeof visual.taxonomyBranchColoringEnabled === "boolean") {
      setTaxonomyBranchColoringEnabled(visual.taxonomyBranchColoringEnabled);
    }
    if (visual.taxonomyColorPalette && (TAXONOMY_COLOR_PALETTE_KEYS as readonly string[]).includes(visual.taxonomyColorPalette)) {
      setTaxonomyColorPalette(visual.taxonomyColorPalette);
    }
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
      const genusBlocks = computeGenusBlocks(viewTree, orderedLeaves, "linear");
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
  const phylopicSelectableRanks = useMemo<TaxonomyRank[]>(
    () => availableTaxonomyRanks.filter((rank) => {
      if (useAutomaticTaxonomyRankVisibility) {
        return true;
      }
      return taxonomyRankVisibility[rank] !== false;
    }),
    [availableTaxonomyRanks, taxonomyRankVisibility, useAutomaticTaxonomyRankVisibility],
  );
  const phylopicViewportRankSet = useMemo(() => new Set(phylopicViewportRanks), [phylopicViewportRanks]);
  const phylopicHasViewportRankInfo = phylopicViewportRanks.length > 0;
  const phylopicHasSelectedVisibleRank = phylopicSelectableRanks.some((rank) => (
    phylopicRankSelection[rank] && (!phylopicHasViewportRankInfo || phylopicViewportRankSet.has(rank))
  ));
  const phylopicCaption = useMemo(
    () => buildPhyloPicAttributionCaption(phylopicSilhouettes),
    [phylopicSilhouettes],
  );
  const customTaxonomyPaletteColors = useMemo(
    () => parseCustomTaxonomyPalette(taxonomyCustomPaletteInput),
    [taxonomyCustomPaletteInput],
  );
  useEffect(() => {
    setTimeAxisLogBaseDraft(timeAxisLogBase);
  }, [timeAxisLogBase]);
  const commitTimeAxisLogBaseDraft = useCallback((): void => {
    const clamped = Math.max(
      MIN_TIME_AXIS_LOG_BASE,
      Math.min(MAX_TIME_AXIS_LOG_BASE, Number.isFinite(timeAxisLogBaseDraft) ? timeAxisLogBaseDraft : DEFAULT_TIME_AXIS_LOG_BASE),
    );
    setTimeAxisLogBaseDraft(clamped);
    setTimeAxisLogBase((current) => Math.abs(current - clamped) < 1e-9 ? current : clamped);
  }, [timeAxisLogBaseDraft]);
  const taxonomyColorPaletteOptions = useMemo(
    () => TAXONOMY_COLOR_PALETTE_KEYS.filter((paletteKey) => (
      paletteKey !== SPIRAL_TTOL_TAXONOMY_COLOR_PALETTE
      || viewMode === "spiral"
      || taxonomyColorPalette === SPIRAL_TTOL_TAXONOMY_COLOR_PALETTE
    )),
    [taxonomyColorPalette, viewMode],
  );
  useEffect(() => {
    if (availableTaxonomyRanks.length === 0) {
      return;
    }
    if (taxonomyColorRootRank !== "auto" && !availableTaxonomyRanks.includes(taxonomyColorRootRank)) {
      setTaxonomyColorRootRank(DEFAULT_TAXONOMY_COLOR_ROOT_RANK);
    }
    if (!availableTaxonomyRanks.includes(taxonomyColorJitterRank)) {
      setTaxonomyColorJitterRank(availableTaxonomyRanks.includes(DEFAULT_TAXONOMY_COLOR_JITTER_RANK)
        ? DEFAULT_TAXONOMY_COLOR_JITTER_RANK
        : availableTaxonomyRanks[availableTaxonomyRanks.length - 1]);
    }
  }, [availableTaxonomyRanks, taxonomyColorJitterRank, taxonomyColorRootRank]);
  const handleAutomaticTaxonomyRankVisibilityChange = useCallback((enabled: boolean) => {
    if (!enabled) {
      const renderDebug = (window as typeof window & {
        __BIG_TREE_VIEWER_RENDER_DEBUG__?: {
          rect?: { taxonomyVisibleRanks?: string[] };
          circular?: { taxonomyVisibleRanks?: string[] };
          spiral?: { visibleTaxonomyRanks?: string[] };
        } | null;
      }).__BIG_TREE_VIEWER_RENDER_DEBUG__;
      const visibleRanks = (
        viewMode === "circular"
          ? renderDebug?.circular?.taxonomyVisibleRanks
          : viewMode === "spiral"
            ? renderDebug?.spiral?.visibleTaxonomyRanks
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
    setPhyloPicRankSelection((current) => {
      const next: Partial<Record<TaxonomyRank, boolean>> = {};
      const visibleRanks = phylopicViewportRanks.length > 0 ? phylopicViewportRanks : phylopicSelectableRanks;
      const visibleRankSet = new Set(visibleRanks);
      let hasSelectedAvailableRank = false;
      for (const rank of phylopicSelectableRanks) {
        const selected = (current[rank] ?? false) && visibleRankSet.has(rank);
        next[rank] = selected;
        hasSelectedAvailableRank ||= selected;
      }
      const defaultRank = phylopicSelectableRanks.find((rank) => visibleRankSet.has(rank));
      if (!hasSelectedAvailableRank && defaultRank) {
        next[defaultRank] = true;
      }
      return next;
    });
  }, [phylopicSelectableRanks, phylopicViewportRanks]);

  useEffect(() => {
    if (!taxonomyMap || !taxonomyEnabled) {
      setPhyloPicViewportRanks([]);
      return;
    }
    const readVisibleRanks = (): void => {
      const renderDebug = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getRenderDebug?.() as {
        rect?: { taxonomyVisibleRanks?: TaxonomyRank[] };
        circular?: { taxonomyVisibleRanks?: TaxonomyRank[] };
        spiral?: { visibleTaxonomyRanks?: TaxonomyRank[] };
      } | null | undefined;
      const rawRanks = (
        viewMode === "circular"
          ? renderDebug?.circular?.taxonomyVisibleRanks
          : viewMode === "spiral"
            ? renderDebug?.spiral?.visibleTaxonomyRanks
            : renderDebug?.rect?.taxonomyVisibleRanks
      ) ?? [];
      const nextRanks = rawRanks.filter((rank): rank is TaxonomyRank => TAXONOMY_RANKS.includes(rank));
      setPhyloPicViewportRanks((current) => {
        if (current.length === nextRanks.length && current.every((rank, index) => rank === nextRanks[index])) {
          return current;
        }
        return nextRanks;
      });
    };
    readVisibleRanks();
    const interval = window.setInterval(readVisibleRanks, 350);
    return () => window.clearInterval(interval);
  }, [taxonomyEnabled, taxonomyMap, viewMode]);

  useEffect(() => {
    setPhyloPicEnabled(false);
    setPhyloPicSilhouettes([]);
    setPhyloPicStatus("");
    setPhyloPicError(null);
    setPhyloPicCaptionVisible(false);
    setPhyloPicReminderDismissed(false);
  }, [treeSignature]);

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
      const rejectParse = pendingTreeParseRejecterRef.current;
      pendingTreeParseResolverRef.current = null;
      pendingTreeParseRejecterRef.current = null;
      setLoadState({
        loading: false,
        message: "Failed to parse tree.",
        error: data.message,
      });
      rejectParse?.(new Error(data.message));
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
    const resolveParse = pendingTreeParseResolverRef.current;
    pendingTreeParseResolverRef.current = null;
    pendingTreeParseRejecterRef.current = null;
    resolveParse?.();
  }, []);

  const handleWorkerError = useCallback((event: ErrorEvent): void => {
    const rejectParse = pendingTreeParseRejecterRef.current;
    pendingTreeParseResolverRef.current = null;
    pendingTreeParseRejecterRef.current = null;
    pendingPasteHideRef.current = false;
    pendingTreeSignatureRef.current = null;
    pendingTreeLabelRef.current = "";
    pendingSharedSubtreeTaxonomyRef.current = null;
    setLoadState({
      loading: false,
      message: "Tree worker failed.",
      error: event.message || "Unknown worker error.",
    });
    rejectParse?.(new Error(event.message || "Tree worker failed."));
  }, []);

  const handleWorkerMessageError = useCallback((): void => {
    const rejectParse = pendingTreeParseRejecterRef.current;
    pendingTreeParseResolverRef.current = null;
    pendingTreeParseRejecterRef.current = null;
    pendingPasteHideRef.current = false;
    pendingTreeSignatureRef.current = null;
    pendingTreeLabelRef.current = "";
    pendingSharedSubtreeTaxonomyRef.current = null;
    setLoadState({
      loading: false,
      message: "Tree worker message transfer failed.",
      error: "The browser could not deserialize the parsed tree payload.",
    });
    rejectParse?.(new Error("The browser could not deserialize the parsed tree payload."));
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
    pendingTreeParseRejecterRef.current?.(new Error("Tree parsing was superseded by another load request."));
    pendingTreeParseResolverRef.current = null;
    pendingTreeParseRejecterRef.current = null;
    setLoadState({
      loading: true,
      message: `Preparing ${label}...`,
      error: null,
    });
    const normalizedText = normalizeImportedTreeText(text);
    if (!looksLikeTreeText(normalizedText)) {
      setLoadState({
        loading: false,
        message: "",
        error: `${label} does not look like a Newick or NEXUS tree.`,
      });
      throw new Error(`${label} does not look like a Newick or NEXUS tree.`);
    }
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
    const parseDone = new Promise<void>((resolve, reject) => {
      pendingTreeParseResolverRef.current = resolve;
      pendingTreeParseRejecterRef.current = reject;
    });
    worker.postMessage({
      type: "parse-tree",
      text: normalizedText,
    });
    await parseDone;
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
    let cancelled = false;
    setTaxonomyCached(null);
    void (async () => {
      try {
        const cached = await getCachedTaxonomyArchive();
        if (cancelled) {
          return;
        }
        setTaxonomyCached(cached !== null);
      } catch {
        if (!cancelled) {
          setTaxonomyCached(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
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

  const openExportOptions = useCallback((): void => {
    if (!tree) {
      return;
    }
    const baseLabel = sanitizeExportBaseLabel(loadedTreeLabel);
    const extension = exportViewFormat === "svg" ? "svg" : "png";
    setExportViewFilenameInput(`${baseLabel}-${viewMode}-view.${extension}`);
    if (viewMode === "rectangular") {
      setExportViewWidthInput(6000);
      setExportViewHeightInput(4000);
      setExportViewPrintWidthInchesInput(20);
      setExportViewPrintHeightInchesInput(13.33);
    } else {
      setExportViewWidthInput(6000);
      setExportViewHeightInput(6000);
      setExportViewPrintWidthInchesInput(20);
      setExportViewPrintHeightInchesInput(20);
    }
    setShowExportOptions((value) => !value);
  }, [exportViewFormat, loadedTreeLabel, tree, viewMode]);

  const applyPrintSizeToPngExport = useCallback((): void => {
    const widthInches = Math.max(0.5, Math.min(100, Number(exportViewPrintWidthInchesInput) || 20));
    const heightInches = Math.max(0.5, Math.min(100, Number(exportViewPrintHeightInchesInput) || widthInches));
    const dpi = Math.max(72, Math.min(1200, Number(exportViewDpiInput) || 300));
    setExportViewWidthInput(Math.max(320, Math.min(10000, Math.round(widthInches * dpi))));
    setExportViewHeightInput(Math.max(320, Math.min(10000, Math.round(heightInches * dpi))));
  }, [exportViewDpiInput, exportViewPrintHeightInchesInput, exportViewPrintWidthInchesInput]);

  const exportCurrentView = useCallback((): void => {
    if (!tree || typeof window === "undefined") {
      return;
    }
    const baseLabel = sanitizeExportBaseLabel(loadedTreeLabel);
    if (exportViewFormat === "svg") {
      setExportSvgFilename(normalizeSvgExportFilename(exportViewFilenameInput, `${baseLabel}-${viewMode}-view`));
      setExportSvgRequest((value) => value + 1);
      setShowExportOptions(false);
      return;
    }
    const width = Math.max(320, Math.min(10000, Math.round(Number(exportViewWidthInput) || 6000)));
    const height = Math.max(320, Math.min(10000, Math.round(Number(exportViewHeightInput) || 6000)));
    setExportViewWidthInput(width);
    setExportViewHeightInput(height);
    setExportPngWidth(width);
    setExportPngHeight(height);
    setExportPngFilename(normalizePngExportFilename(exportViewFilenameInput, `${baseLabel}-${viewMode}-view`));
    setExportPngRequest((value) => value + 1);
    setShowExportOptions(false);
  }, [
    exportViewFilenameInput,
    exportViewFormat,
    exportViewHeightInput,
    exportViewWidthInput,
    loadedTreeLabel,
    tree,
    viewMode,
  ]);

  const handleSessionStateSnapshot = useCallback((state: TreeCanvasSessionState): void => {
    const resolver = pendingSessionSnapshotResolverRef.current;
    pendingSessionSnapshotResolverRef.current = null;
    resolver?.(state);
  }, []);

  const requestCanvasSessionState = useCallback(async (): Promise<TreeCanvasSessionState | null> => {
    if (!tree || typeof window === "undefined") {
      return null;
    }
    return await new Promise<TreeCanvasSessionState | null>((resolve) => {
      pendingSessionSnapshotResolverRef.current = resolve;
      window.setTimeout(() => {
        if (pendingSessionSnapshotResolverRef.current === resolve) {
          pendingSessionSnapshotResolverRef.current = null;
          resolve(null);
        }
      }, 500);
      setSessionStateRequest((value) => value + 1);
    });
  }, [tree]);

  const captureSessionSettings = useCallback((): BigTreeViewerSessionSettings => ({
    viewMode,
    showSpiralViewOption,
    order,
    zoomAxisMode,
    circularRotationDegrees,
    spiralTurns,
    showTimeStripes,
    timeStripeStyle,
    timeStripeLineWeight,
    timeAxisScale,
    timeAxisLogBase,
    showScaleBars,
    showIntermediateScaleTicks,
    extendRectScaleToTick,
    showScaleZeroTick,
    scaleTickIntervalInput,
    useAutoCircularCenterScaleAngle,
    circularCenterScaleAngleDegrees,
    showCircularCenterRadialScaleBar,
    showTipLabels,
    showGenusLabels,
    showInternalNodeLabels,
    showBootstrapLabels,
    showNodeHeightLabels,
    showNodeErrorBars,
    errorBarThicknessPx,
    errorBarCapSizePx,
    figureStyles,
    taxonomyEnabled,
    taxonomyOverlayStyle,
    taxonomyRankVisibility,
    taxonomyCollapseRank,
    useAutomaticTaxonomyRankVisibility,
    taxonomyBranchColoringEnabled,
    taxonomyColorJitter,
    taxonomyColorPalette,
    taxonomyCustomPaletteInput,
    taxonomyColorRootRank,
    taxonomyColorJitterRank,
    phylopicRankSelection,
    phylopicPlacement,
    branchThicknessScale,
    metadataEnabled,
    metadataFirstRowIsHeader,
    metadataKeyColumn,
    metadataValueColumn,
    metadataColorMode,
    metadataApplyScope,
    metadataReverseScale,
    metadataContinuousPalette,
    metadataContinuousTransform,
    metadataContinuousMinInput,
    metadataContinuousMaxInput,
    metadataLabelsEnabled,
    metadataLabelColumn,
    metadataMarkersEnabled,
    metadataMarkerColumn,
    metadataCategoryColorOverrides,
    metadataMarkerStyleOverrides,
    metadataMarkerSizePx,
    metadataLabelMaxCount,
    metadataLabelMinSpacingPx,
    metadataLabelOffsetXPx,
    metadataLabelOffsetYPx,
  }), [
    branchThicknessScale,
    circularCenterScaleAngleDegrees,
    circularRotationDegrees,
    errorBarCapSizePx,
    errorBarThicknessPx,
    extendRectScaleToTick,
    figureStyles,
    metadataApplyScope,
    metadataCategoryColorOverrides,
    metadataColorMode,
    metadataContinuousMaxInput,
    metadataContinuousMinInput,
    metadataContinuousPalette,
    metadataContinuousTransform,
    metadataEnabled,
    metadataFirstRowIsHeader,
    metadataKeyColumn,
    metadataLabelColumn,
    metadataLabelMaxCount,
    metadataLabelMinSpacingPx,
    metadataLabelOffsetXPx,
    metadataLabelOffsetYPx,
    metadataLabelsEnabled,
    metadataMarkerColumn,
    metadataMarkerSizePx,
    metadataMarkerStyleOverrides,
    metadataMarkersEnabled,
    metadataReverseScale,
    metadataValueColumn,
    order,
    phylopicRankSelection,
    phylopicPlacement,
    scaleTickIntervalInput,
    showBootstrapLabels,
    showCircularCenterRadialScaleBar,
    showGenusLabels,
    showIntermediateScaleTicks,
    showInternalNodeLabels,
    showNodeErrorBars,
    showNodeHeightLabels,
    showScaleBars,
    showScaleZeroTick,
    showSpiralViewOption,
    showTimeStripes,
    showTipLabels,
    spiralTurns,
    taxonomyBranchColoringEnabled,
    taxonomyCollapseRank,
    taxonomyColorJitter,
    taxonomyColorJitterRank,
    taxonomyColorPalette,
    taxonomyColorRootRank,
    taxonomyCustomPaletteInput,
    taxonomyEnabled,
    taxonomyOverlayStyle,
    taxonomyRankVisibility,
    timeAxisLogBase,
    timeAxisScale,
    timeStripeLineWeight,
    timeStripeStyle,
    useAutoCircularCenterScaleAngle,
    useAutomaticTaxonomyRankVisibility,
    viewMode,
    zoomAxisMode,
  ]);

  const applySessionSettings = useCallback((settings: BigTreeViewerSessionSettings): void => {
    if (settings.viewMode === "rectangular" || settings.viewMode === "circular" || settings.viewMode === "spiral") {
      setViewMode(settings.viewMode);
      if (settings.viewMode === "spiral" || settings.showSpiralViewOption) {
        setShowSpiralViewOption(true);
      }
    }
    if (settings.order === "input" || settings.order === "asc" || settings.order === "desc") {
      setOrder(settings.order);
    }
    if (settings.zoomAxisMode === "both" || settings.zoomAxisMode === "x" || settings.zoomAxisMode === "y") {
      setZoomAxisMode(settings.zoomAxisMode);
    }
    setCircularRotationDegrees(settings.circularRotationDegrees);
    setSpiralTurns(settings.spiralTurns);
    setShowTimeStripes(settings.showTimeStripes);
    setTimeStripeStyle(settings.timeStripeStyle === "age-gradient" || settings.timeStripeStyle === "dashed" ? settings.timeStripeStyle : "bands");
    setTimeStripeLineWeight(settings.timeStripeLineWeight);
    setTimeAxisScale(settings.timeAxisScale);
    setTimeAxisLogBase(settings.timeAxisLogBase);
    setShowScaleBars(settings.showScaleBars);
    setShowIntermediateScaleTicks(settings.showIntermediateScaleTicks);
    setExtendRectScaleToTick(settings.extendRectScaleToTick);
    setShowScaleZeroTick(settings.showScaleZeroTick);
    setScaleTickIntervalInput(settings.scaleTickIntervalInput);
    setUseAutoCircularCenterScaleAngle(settings.useAutoCircularCenterScaleAngle);
    setCircularCenterScaleAngleDegrees(settings.circularCenterScaleAngleDegrees);
    setShowCircularCenterRadialScaleBar(settings.showCircularCenterRadialScaleBar);
    setShowTipLabels(settings.showTipLabels);
    setShowGenusLabels(settings.showGenusLabels);
    setShowInternalNodeLabels(settings.showInternalNodeLabels);
    setShowBootstrapLabels(settings.showBootstrapLabels);
    setShowNodeHeightLabels(settings.showNodeHeightLabels);
    setShowNodeErrorBars(settings.showNodeErrorBars);
    setErrorBarThicknessPx(settings.errorBarThicknessPx);
    setErrorBarCapSizePx(settings.errorBarCapSizePx);
    setFigureStyles(settings.figureStyles);
    setTaxonomyEnabled(settings.taxonomyEnabled);
    setTaxonomyOverlayStyle(settings.taxonomyOverlayStyle === "strands" ? "strands" : "ribbons");
    setTaxonomyRankVisibility(settings.taxonomyRankVisibility);
    setTaxonomyCollapseRank(settings.taxonomyCollapseRank);
    setUseAutomaticTaxonomyRankVisibility(settings.useAutomaticTaxonomyRankVisibility);
    setTaxonomyBranchColoringEnabled(settings.taxonomyBranchColoringEnabled);
    setTaxonomyColorJitter(settings.taxonomyColorJitter);
    setTaxonomyColorPalette(settings.taxonomyColorPalette);
    setTaxonomyCustomPaletteInput(settings.taxonomyCustomPaletteInput);
    setTaxonomyColorRootRank(settings.taxonomyColorRootRank);
    setTaxonomyColorJitterRank(settings.taxonomyColorJitterRank);
    if (settings.phylopicRankSelection) {
      setPhyloPicRankSelection(settings.phylopicRankSelection);
    }
    if (settings.phylopicPlacement === "after-label" || settings.phylopicPlacement === "outside-ribbon") {
      setPhyloPicPlacement(settings.phylopicPlacement);
    }
    setBranchThicknessScale(settings.branchThicknessScale);
    setMetadataFirstRowIsHeader(settings.metadataFirstRowIsHeader);
    setMetadataEnabled(settings.metadataEnabled);
    setMetadataKeyColumn(settings.metadataKeyColumn);
    setMetadataValueColumn(settings.metadataValueColumn);
    setMetadataColorMode(settings.metadataColorMode);
    setMetadataApplyScope(settings.metadataApplyScope);
    setMetadataReverseScale(settings.metadataReverseScale);
    setMetadataContinuousPalette(settings.metadataContinuousPalette);
    setMetadataContinuousTransform(settings.metadataContinuousTransform);
    setMetadataContinuousMinInput(settings.metadataContinuousMinInput);
    setMetadataContinuousMaxInput(settings.metadataContinuousMaxInput);
    setMetadataLabelsEnabled(settings.metadataLabelsEnabled);
    setMetadataLabelColumn(settings.metadataLabelColumn);
    setMetadataMarkersEnabled(settings.metadataMarkersEnabled);
    setMetadataMarkerColumn(settings.metadataMarkerColumn);
    setMetadataCategoryColorOverrides(settings.metadataCategoryColorOverrides);
    setMetadataMarkerStyleOverrides(settings.metadataMarkerStyleOverrides);
    setMetadataMarkerSizePx(settings.metadataMarkerSizePx);
    setMetadataLabelMaxCount(settings.metadataLabelMaxCount);
    setMetadataLabelMinSpacingPx(settings.metadataLabelMinSpacingPx);
    setMetadataLabelOffsetXPx(settings.metadataLabelOffsetXPx);
    setMetadataLabelOffsetYPx(settings.metadataLabelOffsetYPx);
  }, []);

  const writeSessionFile = useCallback(async (session: BigTreeViewerSessionFile): Promise<boolean> => {
    if (typeof window === "undefined") {
      return false;
    }
    const baseLabel = sanitizeExportBaseLabel(session.tree?.label ?? loadedTreeLabel ?? "big-tree-viewer");
    const suggestedName = `${baseLabel}.btvsession`;
    const blob = await buildSessionBlob(session);
    const pickerWindow = window as Window & {
      showSaveFilePicker?: (options: unknown) => Promise<{
        createWritable: () => Promise<{ write: (data: Blob) => Promise<void>; close: () => Promise<void> }>;
      }>;
    };
    if (typeof pickerWindow.showSaveFilePicker === "function") {
      try {
        const handle = await pickerWindow.showSaveFilePicker({
          id: "big-tree-viewer-sessions",
          suggestedName,
          types: [{
            description: "Big Tree Viewer session",
            accept: { "application/octet-stream": [".btvsession"] },
          }],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return true;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return false;
        }
        throw error;
      }
    }
    const url = window.URL.createObjectURL(blob);
    const link = window.document.createElement("a");
    link.href = url;
    link.download = suggestedName;
    window.document.body.appendChild(link);
    link.click();
    window.document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
    return true;
  }, [loadedTreeLabel]);

  const readSessionFile = useCallback(async (): Promise<File | null> => {
    if (typeof window === "undefined") {
      return null;
    }
    const pickerWindow = window as Window & {
      showOpenFilePicker?: (options: unknown) => Promise<Array<{ getFile: () => Promise<File> }>>;
    };
    if (typeof pickerWindow.showOpenFilePicker === "function") {
      try {
        const [handle] = await pickerWindow.showOpenFilePicker({
          id: "big-tree-viewer-sessions",
          multiple: false,
          types: [{
            description: "Big Tree Viewer session",
            accept: { "application/octet-stream": [".btvsession"], "application/json": [".json"] },
          }],
        });
        return handle ? await handle.getFile() : null;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return null;
        }
        throw error;
      }
    }
    return await new Promise<File | null>((resolve) => {
      const input = window.document.createElement("input");
      input.type = "file";
      input.accept = ".btvsession,.json,application/json,application/octet-stream";
      input.onchange = () => resolve(input.files?.[0] ?? null);
      input.click();
    });
  }, []);

  const parseSessionFile = useCallback(async (file: File): Promise<BigTreeViewerSessionFile> => await parseSessionBytes(new Uint8Array(await file.arrayBuffer())), []);

  const saveSession = useCallback(async (): Promise<void> => {
    try {
      setSessionError(null);
      setSessionStatus("Preparing session file...");
      const canvas = await requestCanvasSessionState();
      const session: BigTreeViewerSessionFile = {
        format: "big-tree-viewer-session",
        version: 1,
        savedAt: new Date().toISOString(),
        settings: captureSessionSettings(),
        tree: tree ? {
          label: loadedTreeLabel,
          newick: serializeSubtreeToNewick(tree, tree.root),
          signature: treeSignature,
        } : undefined,
        metadata: metadataRawText ? {
          text: metadataRawText,
          label: metadataFileName || "metadata.csv",
          firstRowIsHeader: metadataFirstRowIsHeader,
        } : undefined,
        taxonomy: tree ? { map: taxonomyMap } : undefined,
        canvas,
      };
      const saved = await writeSessionFile(session);
      setSessionStatus(saved ? "Session saved." : "");
    } catch (error) {
      setSessionStatus("");
      setSessionError(error instanceof Error ? error.message : String(error));
    }
  }, [
    captureSessionSettings,
    loadedTreeLabel,
    metadataFileName,
    metadataFirstRowIsHeader,
    metadataRawText,
    requestCanvasSessionState,
    taxonomyMap,
    tree,
    treeSignature,
    writeSessionFile,
  ]);

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
    if (pendingSessionTaxonomyRef.current !== undefined) {
      const sessionTaxonomy = pendingSessionTaxonomyRef.current;
      const sessionTaxonomyEnabled = pendingSessionTaxonomyEnabledRef.current;
      const resolveSessionRestore = pendingSessionRestoreResolverRef.current;
      pendingSessionTaxonomyRef.current = undefined;
      pendingSessionTaxonomyEnabledRef.current = null;
      pendingSessionRestoreResolverRef.current = null;
      setTaxonomyMap(sessionTaxonomy ?? null);
      setTaxonomyEnabled(sessionTaxonomy ? sessionTaxonomyEnabled ?? true : false);
      setTaxonomyStatus(sessionTaxonomy
        ? `Loaded taxonomy mapping from session (${sessionTaxonomy.mappedCount.toLocaleString()} mapped tips).`
        : "");
      setTaxonomyError(null);
      if (pendingSessionCanvasStateRef.current !== undefined) {
        setSessionRestoreState(pendingSessionCanvasStateRef.current ?? null);
        setSessionRestoreRequest((value) => value + 1);
        pendingSessionCanvasStateRef.current = undefined;
      }
      if (resolveSessionRestore) {
        window.requestAnimationFrame(() => resolveSessionRestore());
      }
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

  const loadFullSessionFromObject = useCallback(async (session: BigTreeViewerSessionFile, label: string): Promise<boolean> => {
    setSessionStatus(`Restoring session from ${label}...`);
    if (session.metadata?.text) {
      applyMetadataText(session.metadata.text, session.metadata.label, session.metadata.firstRowIsHeader);
    } else {
      clearMetadata();
    }
    applySessionSettings(session.settings);
    if (session.tree?.newick) {
      setSessionStatus(`Parsing tree from ${label}...`);
      pendingSessionTaxonomyRef.current = session.taxonomy?.map ?? null;
      pendingSessionTaxonomyEnabledRef.current = session.settings.taxonomyEnabled;
      pendingSessionCanvasStateRef.current = session.canvas ?? null;
      const restoreApplied = new Promise<void>((resolve) => {
        pendingSessionRestoreResolverRef.current = resolve;
      });
      setTree(null);
      setTreeSignature(null);
      try {
        await parseText(session.tree.newick, session.tree.label || label);
        setSessionStatus(session.taxonomy?.map
          ? `Applying taxonomy mapping and saved view from ${label}...`
          : `Applying saved view from ${label}...`);
        await restoreApplied;
      } catch (error) {
        pendingSessionRestoreResolverRef.current = null;
        throw error;
      }
      return true;
    }
    setSessionStatus(`Loaded settings from ${label}.`);
    return false;
  }, [
    applyMetadataText,
    applySessionSettings,
    clearMetadata,
    parseText,
  ]);

  const loadSession = useCallback(async (mode: "full" | "settings"): Promise<void> => {
    try {
      setSessionError(null);
      setSessionLoading(true);
      setSessionStatus(mode === "full" ? "Choose a session file to load..." : "Choose a session file for settings...");
      const file = await readSessionFile();
      if (!file) {
        setSessionLoading(false);
        setSessionStatus("");
        return;
      }
      setSessionStatus(`Reading ${file.name}...`);
      const session = await parseSessionFile(file);
      setSessionStatus(mode === "full" ? `Loading session from ${file.name}...` : `Loading settings from ${file.name}...`);
      if (mode === "full" && await loadFullSessionFromObject(session, file.name)) {
        setSessionStatus(`Loaded session from ${file.name}.`);
        return;
      }
      if (mode === "settings") {
        applySessionSettings(session.settings);
      }
      if (mode === "settings" && tree && session.tree?.signature && session.tree.signature === treeSignature && session.canvas) {
        setSessionRestoreState(session.canvas);
        setSessionRestoreRequest((value) => value + 1);
        setSessionStatus(`Loaded settings and tree-specific view state from ${file.name}.`);
        return;
      }
      setSessionStatus(mode === "settings"
        ? `Loaded reusable settings from ${file.name}. Tree-specific state was skipped.`
        : `Loaded settings from ${file.name}.`);
    } catch (error) {
      setSessionStatus("");
      setSessionError(error instanceof Error ? error.message : String(error));
    } finally {
      setSessionLoading(false);
    }
  }, [
    applySessionSettings,
    loadFullSessionFromObject,
    parseSessionFile,
    readSessionFile,
    tree,
    treeSignature,
  ]);

  const loadFileAsTreeOrSession = useCallback(async (file: File): Promise<void> => {
    setSessionError(null);
    setLoadState((current) => ({ ...current, error: null }));
    if (fileLooksLikeSession(file)) {
      try {
        setSessionLoading(true);
        setSessionStatus(`Reading ${file.name}...`);
        const session = await parseSessionFile(file);
        setSessionStatus(`Loading session from ${file.name}...`);
        if (!await loadFullSessionFromObject(session, file.name)) {
          throw new Error("The session file did not include a tree.");
        }
        setSessionStatus(`Loaded session from ${file.name}.`);
      } catch (error) {
        setSessionStatus("");
        setSessionError(error instanceof Error ? error.message : String(error));
      } finally {
        setSessionLoading(false);
      }
      return;
    }
    const text = await file.text();
    try {
      await parseText(text, file.name);
    } catch {
      // parseText has already populated the user-facing load error.
    }
  }, [loadFullSessionFromObject, parseSessionFile, parseText]);

  const onFileChange = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    await loadFileAsTreeOrSession(file);
    event.target.value = "";
  };

  const applyLaunchMetadata = useCallback((metadata: BigTreeViewerLaunchPayload["metadata"] | undefined): void => {
    if (!metadata?.text) {
      return;
    }
    applyMetadataText(metadata.text, metadata.label ?? "launch-metadata.csv", metadata.firstRowIsHeader ?? true);
    if (typeof metadata.enabled === "boolean") {
      setMetadataEnabled(metadata.enabled);
    }
    if (metadata.keyColumn) {
      setMetadataKeyColumn(metadata.keyColumn);
    }
    if (metadata.valueColumn) {
      setMetadataValueColumn(metadata.valueColumn);
    }
    if (metadata.colorMode === "categorical" || metadata.colorMode === "continuous") {
      setMetadataColorMode(metadata.colorMode);
    }
    if (metadata.applyScope === "branch" || metadata.applyScope === "subtree") {
      setMetadataApplyScope(metadata.applyScope);
    }
    if (typeof metadata.labelsEnabled === "boolean") {
      setMetadataLabelsEnabled(metadata.labelsEnabled);
    }
    if (metadata.labelColumn) {
      setMetadataLabelColumn(metadata.labelColumn);
    }
    if (typeof metadata.markersEnabled === "boolean") {
      setMetadataMarkersEnabled(metadata.markersEnabled);
    }
    if (metadata.markerColumn) {
      setMetadataMarkerColumn(metadata.markerColumn);
    }
  }, [applyMetadataText]);

  const loadLaunchPayload = useCallback(async (payload: BigTreeViewerLaunchPayload, sourceLabel = "launch API"): Promise<boolean> => {
    if (typeof payload.controls?.hideDownloadNewick === "boolean") {
      setHideDownloadNewick(payload.controls.hideDownloadNewick);
    }
    applyLaunchVisualSettings(payload.visual);
    applyLaunchMetadata(payload.metadata);
    if (!payload.newick?.trim()) {
      return false;
    }
    await parseText(payload.newick, payload.label?.trim() || sourceLabel);
    return true;
  }, [applyLaunchMetadata, applyLaunchVisualSettings, parseText]);

  const readLaunchPayloadFromUrl = useCallback((): {
    payload: BigTreeViewerLaunchPayload | null;
    waitForMessage: boolean;
    newickUrl?: string;
    sessionUrl?: string;
    hideDownloadNewick: boolean;
  } => {
    if (typeof window === "undefined") {
      return { payload: null, waitForMessage: false, hideDownloadNewick: false };
    }
    const params = new URLSearchParams(window.location.search);
    const newickUrl = params.get("btv_newick_url") ?? undefined;
    const sessionUrl = params.get("btv_session_url") ?? undefined;
    const hideDownloadNewick = readLaunchBoolParam(params, "btv_hide_download_newick") ?? false;
    const payload: BigTreeViewerLaunchPayload = {
      ...(parseLaunchJsonParam(params.get("btv_payload")) ?? {}),
    };
    if (hideDownloadNewick) {
      payload.controls = {
        ...payload.controls,
        hideDownloadNewick: true,
      };
    }
    const newick = readLaunchTextParam(params, "btv_newick", "btv_newick_b64");
    const metadataText = readLaunchTextParam(params, "btv_metadata", "btv_metadata_b64");
    if (newick) {
      payload.newick = newick;
    }
    if (params.get("btv_label")) {
      payload.label = params.get("btv_label") ?? undefined;
    }
    const viewModeParam = params.get("btv_view");
    const orderParam = params.get("btv_order");
    const zoomAxisModeParam = params.get("btv_zoom_axis");
    const timeAxisScaleParam = params.get("btv_time_axis");
    const paletteParam = params.get("btv_palette");
    const visualParamsPresent = Boolean(
      viewModeParam
      || orderParam
      || zoomAxisModeParam
      || timeAxisScaleParam
      || paletteParam
      || params.has("btv_tip_labels")
      || params.has("btv_genus_labels")
      || params.has("btv_time_stripes")
      || params.has("btv_scale_bars")
      || params.has("btv_taxonomy")
      || params.has("btv_taxonomy_branch_colors")
      || params.has("btv_rotation")
      || params.has("btv_spiral_turns")
      || params.has("btv_branch_thickness")
      || params.has("btv_time_axis_log_base"),
    );
    if (visualParamsPresent) {
      payload.visual = {
        ...payload.visual,
        viewMode: viewModeParam === "rectangular" || viewModeParam === "circular" || viewModeParam === "spiral"
          ? viewModeParam
          : payload.visual?.viewMode,
        order: orderParam === "asc" || orderParam === "desc" || orderParam === "input"
          ? orderParam
          : payload.visual?.order,
        zoomAxisMode: zoomAxisModeParam === "both" || zoomAxisModeParam === "x" || zoomAxisModeParam === "y"
          ? zoomAxisModeParam
          : payload.visual?.zoomAxisMode,
        circularRotationDegrees: readLaunchNumberParam(params, "btv_rotation") ?? payload.visual?.circularRotationDegrees,
        spiralTurns: readLaunchNumberParam(params, "btv_spiral_turns") ?? payload.visual?.spiralTurns,
        showTipLabels: readLaunchBoolParam(params, "btv_tip_labels") ?? payload.visual?.showTipLabels,
        showGenusLabels: readLaunchBoolParam(params, "btv_genus_labels") ?? payload.visual?.showGenusLabels,
        showTimeStripes: readLaunchBoolParam(params, "btv_time_stripes") ?? payload.visual?.showTimeStripes,
        showScaleBars: readLaunchBoolParam(params, "btv_scale_bars") ?? payload.visual?.showScaleBars,
        timeAxisScale: timeAxisScaleParam === "linear" || timeAxisScaleParam === "log"
          ? timeAxisScaleParam
          : payload.visual?.timeAxisScale,
        timeAxisLogBase: readLaunchNumberParam(params, "btv_time_axis_log_base") ?? payload.visual?.timeAxisLogBase,
        branchThicknessScale: readLaunchNumberParam(params, "btv_branch_thickness") ?? payload.visual?.branchThicknessScale,
        taxonomyEnabled: readLaunchBoolParam(params, "btv_taxonomy") ?? payload.visual?.taxonomyEnabled,
        taxonomyBranchColoringEnabled: readLaunchBoolParam(params, "btv_taxonomy_branch_colors") ?? payload.visual?.taxonomyBranchColoringEnabled,
        taxonomyColorPalette: paletteParam && (TAXONOMY_COLOR_PALETTE_KEYS as readonly string[]).includes(paletteParam)
          ? paletteParam as TaxonomyColorPaletteKey
          : payload.visual?.taxonomyColorPalette,
      };
    }
    const metadataColorModeParam = params.get("btv_metadata_color_mode");
    const metadataScopeParam = params.get("btv_metadata_scope");
    const metadataParamsPresent = Boolean(
      metadataText
      || params.has("btv_metadata_label")
      || params.has("btv_metadata_header")
      || params.has("btv_metadata_enabled")
      || params.has("btv_metadata_key")
      || params.has("btv_metadata_value")
      || metadataColorModeParam
      || metadataScopeParam
      || params.has("btv_metadata_labels")
      || params.has("btv_metadata_label_column")
      || params.has("btv_metadata_markers")
      || params.has("btv_metadata_marker_column"),
    );
    if (metadataParamsPresent) {
      payload.metadata = {
        ...payload.metadata,
        text: metadataText ?? payload.metadata?.text,
        label: params.get("btv_metadata_label") ?? payload.metadata?.label,
        firstRowIsHeader: readLaunchBoolParam(params, "btv_metadata_header") ?? payload.metadata?.firstRowIsHeader,
        enabled: readLaunchBoolParam(params, "btv_metadata_enabled") ?? payload.metadata?.enabled,
        keyColumn: params.get("btv_metadata_key") ?? payload.metadata?.keyColumn,
        valueColumn: params.get("btv_metadata_value") ?? payload.metadata?.valueColumn,
        colorMode: metadataColorModeParam === "categorical" || metadataColorModeParam === "continuous"
          ? metadataColorModeParam
          : payload.metadata?.colorMode,
        applyScope: metadataScopeParam === "branch" || metadataScopeParam === "subtree"
          ? metadataScopeParam
          : payload.metadata?.applyScope,
        labelsEnabled: readLaunchBoolParam(params, "btv_metadata_labels") ?? payload.metadata?.labelsEnabled,
        labelColumn: params.get("btv_metadata_label_column") ?? payload.metadata?.labelColumn,
        markersEnabled: readLaunchBoolParam(params, "btv_metadata_markers") ?? payload.metadata?.markersEnabled,
        markerColumn: params.get("btv_metadata_marker_column") ?? payload.metadata?.markerColumn,
      };
    }
    const effectiveHideDownloadNewick = hideDownloadNewick || payload.controls?.hideDownloadNewick === true;
    const hasPayload = Boolean(payload.newick || payload.metadata?.text || payload.visual || payload.controls);
    return {
      payload: hasPayload ? payload : null,
      waitForMessage: params.get("btv_api") === "1" || params.get("btv_launch") === "1",
      newickUrl,
      sessionUrl,
      hideDownloadNewick: effectiveHideDownloadNewick,
    };
  }, []);

  useEffect(() => {
    if (didAutoloadRef.current) {
      return;
    }
    didAutoloadRef.current = true;
    void (async () => {
      const launch = readLaunchPayloadFromUrl();
      setHideDownloadNewick(launch.hideDownloadNewick);
      if (launch.sessionUrl) {
        try {
          setLoadState({
            loading: true,
            message: "Fetching Big Tree Viewer session...",
            error: null,
          });
          const bytes = await fetchRemoteLaunchBytes(launch.sessionUrl, "session");
          const session = await parseSessionBytes(bytes);
          const label = launchLabelFromUrl(launch.sessionUrl, "remote session");
          if (!await loadFullSessionFromObject(session, label)) {
            throw new Error("The remote session did not include a tree.");
          }
          setSessionStatus(`Loaded session from ${label}.`);
          return;
        } catch (error) {
          setLoadState({
            loading: false,
            message: "",
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
      }
      if (launch.newickUrl) {
        try {
          setLoadState({
            loading: true,
            message: "Fetching remote Newick tree...",
            error: null,
          });
          const newick = await fetchRemoteLaunchText(launch.newickUrl, "Newick");
          const label = launch.payload?.label?.trim() || launchLabelFromUrl(launch.newickUrl, "remote Newick");
          const loaded = await loadLaunchPayload({ ...(launch.payload ?? {}), newick, label }, "URL Newick");
          if (loaded) {
            return;
          }
        } catch (error) {
          setLoadState({
            loading: false,
            message: "",
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
      }
      if (launch.payload && await loadLaunchPayload(launch.payload, "URL launch")) {
        return;
      }
      if (launch.waitForMessage) {
        setLoadState({
          loading: false,
          message: "Waiting for Big Tree Viewer launch payload...",
          error: null,
        });
        return;
      }
      const loadedSubtree = await loadSubtreeFromUrl();
      if (!loadedSubtree) {
        await loadExample();
      }
    })();
  }, [loadExample, loadFullSessionFromObject, loadLaunchPayload, loadSubtreeFromUrl, readLaunchPayloadFromUrl]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }
    const readyMessage = { type: "big-tree-viewer:ready", version: 1 };
    window.opener?.postMessage(readyMessage, "*");
    window.parent !== window && window.parent.postMessage(readyMessage, "*");
    const handleMessage = (event: MessageEvent): void => {
      const data = event.data as { type?: string; payload?: BigTreeViewerLaunchPayload } | null;
      if (!data || typeof data !== "object" || data.type !== "big-tree-viewer:load") {
        return;
      }
      const payload = data.payload && typeof data.payload === "object"
        ? data.payload
        : data as BigTreeViewerLaunchPayload;
      const replyOrigin = event.origin || "*";
      void loadLaunchPayload(payload, "message launch")
        .then((loaded) => {
          (event.source as Window | null)?.postMessage(
            { type: loaded ? "big-tree-viewer:loaded" : "big-tree-viewer:error", version: 1, message: loaded ? undefined : "No Newick string was provided." },
            replyOrigin,
          );
        })
        .catch((error) => {
          (event.source as Window | null)?.postMessage(
            { type: "big-tree-viewer:error", version: 1, message: error instanceof Error ? error.message : String(error) },
            replyOrigin,
          );
        });
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [loadLaunchPayload]);

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
      if (/\.(csv|tsv)$/i.test(file.name)) {
        const text = await file.text();
        importMetadataText(text, file.name);
        return;
      }
      await loadFileAsTreeOrSession(file);
      return;
    }
    const plainText = dataTransfer.getData("text/plain");
    if (plainText.trim()) {
      setPastedTreeText(plainText);
      try {
        await parseText(plainText, "dropped tree text");
      } catch {
        // parseText has already populated the user-facing load error.
      }
    }
  }, [importMetadataText, loadFileAsTreeOrSession, parseText]);

  const downloadTaxonomy = useCallback(async (): Promise<void> => {
    setTaxonomyLoading(true);
    setTaxonomyError(null);
    setTaxonomyStatus("Checking local taxonomy cache...");
    appendDiagnostic("taxonomy-download-started", {
      treeLoaded: tree !== null,
    });
    try {
      const cached = await getCachedTaxonomyArchive();
      if (cached) {
        setTaxonomyCached(true);
        setTaxonomyStatus("Taxonomy cache found.");
        appendDiagnostic("taxonomy-download-skipped-cache-found", {});
        return;
      }
      setTaxonomyStatus("Preparing taxonomy download...");
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

  const retrievePhyloPicForVisibleTaxa = useCallback(async (): Promise<void> => {
    if (!taxonomyEnabled || !viewTaxonomyMap) {
      setPhyloPicError("Run taxonomy mapping and show taxonomy overlays before retrieving silhouettes.");
      return;
    }
    const renderDebug = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getRenderDebug?.() as {
      width?: number;
      height?: number;
    } | null | undefined;
    const viewportWidth = Number.isFinite(renderDebug?.width) ? Number(renderDebug?.width) : 0;
    const viewportHeight = Number.isFinite(renderDebug?.height) ? Number(renderDebug?.height) : 0;
    const hitboxIntersectsCanvas = (hitbox: Record<string, unknown>): boolean => {
      if (viewportWidth <= 0 || viewportHeight <= 0) {
        return true;
      }
      const width = typeof hitbox.width === "number" ? hitbox.width : 0;
      const height = typeof hitbox.height === "number" ? hitbox.height : 0;
      if (width <= 0 || height <= 0) {
        return false;
      }
      let left = 0;
      let right = 0;
      let top = 0;
      let bottom = 0;
      if (hitbox.kind === "rotated") {
        const x = typeof hitbox.x === "number" ? hitbox.x : 0;
        const y = typeof hitbox.y === "number" ? hitbox.y : 0;
        const radius = Math.hypot(width, height) * 0.5;
        left = x - radius;
        right = x + radius;
        top = y - radius;
        bottom = y + radius;
      } else {
        left = typeof hitbox.x === "number" ? hitbox.x : 0;
        top = typeof hitbox.y === "number" ? hitbox.y : 0;
        right = left + width;
        bottom = top + height;
      }
      const margin = 4;
      return right >= -margin
        && left <= viewportWidth + margin
        && bottom >= -margin
        && top <= viewportHeight + margin;
    };
    const hitboxes = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getLabelHitboxes() ?? [];
    const taxonomyLabels = hitboxes.filter((hitbox): hitbox is Record<string, unknown> & {
      text: string;
      taxonomyRank: TaxonomyRank;
    } => (
      hitbox.labelKind === "taxonomy"
      && typeof hitbox.text === "string"
      && hitbox.text.trim().length > 0
      && typeof hitbox.taxonomyRank === "string"
      && TAXONOMY_RANKS.includes(hitbox.taxonomyRank as TaxonomyRank)
      && typeof hitbox.width === "number"
      && typeof hitbox.height === "number"
      && hitbox.width >= 18
      && hitbox.height >= 8
      && hitboxIntersectsCanvas(hitbox)
    ));
    const selectedRanks = TAXONOMY_RANKS.filter((rank) => phylopicRankSelection[rank]);
    if (selectedRanks.length === 0) {
      setPhyloPicError("Select at least one taxonomy rank before retrieving silhouettes.");
      return;
    }
    const visibleRankSet = new Set(phylopicViewportRanks);
    const targetRanks = selectedRanks.filter((rank) => (
      phylopicViewportRanks.length === 0
        ? viewTaxonomyMap.activeRanks.includes(rank)
        : visibleRankSet.has(rank)
    ));
    if (targetRanks.length === 0) {
      setPhyloPicError("None of the selected taxonomy ranks is currently visible in the taxonomy overlays.");
      return;
    }
    const candidateByKey = new Map<string, PhyloPicCandidate>();
    for (const hitbox of taxonomyLabels) {
      const rank = hitbox.taxonomyRank;
      if (!targetRanks.includes(rank)) {
        continue;
      }
      const taxId = typeof hitbox.taxonomyTaxId === "number" && Number.isFinite(hitbox.taxonomyTaxId)
        ? hitbox.taxonomyTaxId
        : null;
      const taxonLabel = hitbox.text.trim();
      const key = `${rank}:${taxonLabel}:${taxId ?? ""}`;
      if (!candidateByKey.has(key)) {
        candidateByKey.set(key, { key, taxonLabel, rank, taxId });
      }
    }
    if (candidateByKey.size === 0) {
      setPhyloPicError("No visible taxonomy labels were found for the selected taxonomy ranks.");
      return;
    }
    const existingKeys = new Set(phylopicSilhouettes.map((silhouette) => silhouette.key));
    const candidates = Array.from(candidateByKey.values()).filter((candidate) => !existingKeys.has(candidate.key));
    if (candidates.length === 0) {
      setPhyloPicEnabled(true);
      setPhyloPicStatus("All selected target taxa already have cached or retrieved silhouettes.");
      setPhyloPicError(null);
      return;
    }
    setPhyloPicRetrieving(true);
    setPhyloPicEnabled(true);
    setPhyloPicError(null);
    phylopicCancelRequestedRef.current = false;
    try {
      const cached: PhyloPicSilhouette[] = [];
      const uncached: PhyloPicCandidate[] = [];
      for (const candidate of candidates) {
        const cachedSilhouette = readCachedPhyloPicSilhouette(candidate);
        if (cachedSilhouette) {
          cached.push(cachedSilhouette);
        } else {
          uncached.push(candidate);
        }
      }
      const toFetch = uncached.slice(0, PHYLOPIC_MAX_RETRIEVE_PER_CLICK);
      setPhyloPicStatus(
        uncached.length > toFetch.length
          ? `Loaded ${cached.length.toLocaleString()} cached silhouettes. Retrieving ${toFetch.length.toLocaleString()} of ${uncached.length.toLocaleString()} uncached selected taxa in this batch.`
          : `Retrieving ${toFetch.length.toLocaleString()} PhyloPic silhouette${toFetch.length === 1 ? "" : "s"}...`,
      );
      const retrieved: PhyloPicSilhouette[] = [];
      let rateLimited = false;
      let cancelled = false;
      for (let index = 0; index < toFetch.length; index += 1) {
        if (phylopicCancelRequestedRef.current) {
          cancelled = true;
          break;
        }
        const candidate = toFetch[index];
        setPhyloPicStatus(`Retrieving PhyloPic silhouettes (${index + 1}/${toFetch.length}): ${candidate.taxonLabel}`);
        if (index > 0 && toFetch.length > 25) {
          await sleep(index % 25 === 0 ? 800 : 120);
          if (phylopicCancelRequestedRef.current) {
            cancelled = true;
            break;
          }
        }
        try {
          const silhouette = await retrievePhyloPicSilhouette(candidate);
          if (silhouette) {
            retrieved.push(silhouette);
          }
        } catch (error) {
          if (error instanceof PhyloPicRateLimitError) {
            rateLimited = true;
            setPhyloPicStatus(`PhyloPic rate limit reached. Pausing for ${Math.ceil(error.retryAfterMs / 1000).toLocaleString()} seconds before stopping this batch.`);
            await sleep(error.retryAfterMs);
            break;
          }
          // Missing taxa or individual API failures should not stop the rest of the visible set.
        }
      }
      const additions = [...cached, ...retrieved];
      if (additions.length > 0) {
        setPhyloPicSilhouettes((current) => {
          const byKey = new Map(current.map((silhouette) => [silhouette.key, silhouette]));
          for (const silhouette of additions) {
            byKey.set(silhouette.key, silhouette);
          }
          return Array.from(byKey.values());
        });
      }
      setPhyloPicStatus(
        cancelled
          ? `Cancelled PhyloPic retrieval${additions.length > 0 ? ` after adding ${additions.length.toLocaleString()} silhouette${additions.length === 1 ? "" : "s"}.` : "."}`
          : additions.length > 0
          ? `Added ${additions.length.toLocaleString()} silhouette${additions.length === 1 ? "" : "s"}${rateLimited ? " before the PhyloPic rate limit paused this batch." : "."}`
          : "No publication-compatible PhyloPic silhouettes were found for the visible target taxa.",
      );
    } finally {
      setPhyloPicRetrieving(false);
      phylopicCancelRequestedRef.current = false;
    }
  }, [phylopicRankSelection, phylopicSilhouettes, phylopicViewportRanks, taxonomyEnabled, viewTaxonomyMap]);

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
    setTaxonomyColorPalette(DEFAULT_TAXONOMY_COLOR_PALETTE);
    setTaxonomyCustomPaletteInput("");
    setTaxonomyColorRootRank(DEFAULT_TAXONOMY_COLOR_ROOT_RANK);
    setTaxonomyColorJitterRank(DEFAULT_TAXONOMY_COLOR_JITTER_RANK);
    setTaxonomyBranchColoringEnabled(DEFAULT_TAXONOMY_BRANCH_COLORING_ENABLED);
    setTaxonomyOverlayStyle(DEFAULT_TAXONOMY_OVERLAY_STYLE);
    setUseAutomaticTaxonomyRankVisibility(true);
    setTaxonomyRankVisibility({});
    setTaxonomyCollapseRank(DEFAULT_TAXONOMY_COLLAPSE_RANK);
    setBranchThicknessScale(DEFAULT_BRANCH_THICKNESS_SCALE);
    setShowIntermediateScaleTicks(DEFAULT_SHOW_INTERMEDIATE_SCALE_TICKS);
    setTimeAxisScale(DEFAULT_TIME_AXIS_SCALE);
    setTimeAxisLogBase(DEFAULT_TIME_AXIS_LOG_BASE);
    setTimeAxisLogBaseDraft(DEFAULT_TIME_AXIS_LOG_BASE);
    setExtendRectScaleToTick(DEFAULT_EXTEND_RECT_SCALE_TO_TICK);
    setShowScaleZeroTick(DEFAULT_SHOW_SCALE_ZERO_TICK);
    setScaleTickIntervalInput("");
    setUseAutoCircularCenterScaleAngle(true);
    setCircularCenterScaleAngleDegrees(DEFAULT_CIRCULAR_CENTER_SCALE_ANGLE_DEGREES);
    setShowCircularCenterRadialScaleBar(DEFAULT_SHOW_CIRCULAR_CENTER_RADIAL_SCALE_BAR);
    setSpiralTurns(DEFAULT_SPIRAL_TURNS);
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
        timeAxisScale,
        showTipLabels,
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
        taxonomyColorPalette,
        taxonomyCustomPaletteColorCount: customTaxonomyPaletteColors.length,
        taxonomyColorRootRank,
        taxonomyColorJitterRank,
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
        spiralTurns,
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
      setShowTipLabels,
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
      setTaxonomyColorPaletteForTest: setTaxonomyColorPalette,
      setTaxonomyColorRootRankForTest: setTaxonomyColorRootRank,
      setTaxonomyColorJitterRankForTest: setTaxonomyColorJitterRank,
      setBranchThicknessScaleForTest: setBranchThicknessScale,
      setShowIntermediateScaleTicks,
      setShowTimeStripes,
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
      setSpiralTurnsForTest: setSpiralTurns,
      setTimeStripeStyle: (value: "bands" | "dashed") => setTimeStripeStyle(value),
      setTimeAxisScale,
      setTimeAxisLogBase,
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
      setMetadataCategoryColorOverridesForTest: setMetadataCategoryColorOverrides,
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
      setFigureStyleForTest: (labelClass: LabelStyleClass, field: "fontFamily" | "sizeScale" | "offsetPx" | "offsetXPx" | "offsetYPx" | "bandThicknessScale" | "taxonomyGapPx" | "bold" | "italic", value: string | number | boolean) => {
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
    showTipLabels,
    showBootstrapLabels,
    showGenusLabels,
    showInternalNodeLabels,
    spiralTurns,
    timeStripeLineWeight,
    timeAxisScale,
    timeAxisLogBase,
    timeStripeStyle,
    taxonomyBranchColoringEnabled,
    taxonomyCached,
    collapsibleTaxonomyRanks,
    taxonomyCollapseRank,
    taxonomyColorJitter,
    taxonomyColorPalette,
    customTaxonomyPaletteColors.length,
    taxonomyColorRootRank,
    taxonomyColorJitterRank,
    taxonomyCollapseHasLowerRankFallbackLabels,
    taxonomyEnabled,
    taxonomyError,
    taxonomyLoading,
    taxonomyOverlayStyle,
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
      {tutorialPromptVisible && !tutorialSuppressedForMobile ? (
        <div className="tutorial-prompt" role="dialog" aria-label="Big Tree Viewer tutorial">
          <button
            type="button"
            className="tutorial-close"
            aria-label="Close tutorial prompt"
            onClick={() => dismissTutorial(false)}
          >
            ×
          </button>
          <div>
            <strong>New to Big Tree Viewer?</strong>
            <p>Take a short guided tour of loading trees, navigation, taxonomy, metadata, and session files.</p>
          </div>
          <div className="tutorial-actions">
            <button type="button" onClick={startTutorial}>Start tutorial</button>
            <button type="button" className="secondary" onClick={() => dismissTutorial(true)}>Don&apos;t show again</button>
          </div>
        </div>
      ) : null}
      {tutorialActive && !tutorialSuppressedForMobile ? (
        <div
          className={`tutorial-card${tutorialCardReady ? " ready" : ""}`}
          role="dialog"
          aria-live="polite"
          aria-label="Big Tree Viewer tutorial step"
          style={tutorialCardPosition}
        >
          <div className="tutorial-step-counter">
            Step {tutorialStepIndex + 1} of {TUTORIAL_STEPS.length}
          </div>
          <h2>{TUTORIAL_STEPS[tutorialStepIndex].title}</h2>
          <p>{TUTORIAL_STEPS[tutorialStepIndex].body}</p>
          <div className="tutorial-actions">
            <button
              type="button"
              onClick={() => {
                if (tutorialStepIndex >= TUTORIAL_STEPS.length - 1) {
                  completeTutorial(true);
                } else {
                  showTutorialStep(tutorialStepIndex + 1);
                }
              }}
            >
              {tutorialStepIndex >= TUTORIAL_STEPS.length - 1 ? "Finish" : "Next"}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={tutorialStepIndex === 0}
              onClick={() => showTutorialStep(tutorialStepIndex - 1)}
            >
              Back
            </button>
            <button type="button" className="secondary" onClick={() => dismissTutorial(true)}>
              Stop
            </button>
          </div>
        </div>
      ) : null}
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
        <button
          type="button"
          className="mobile-sidebar-toggle mobile-sidebar-toggle-inline"
          onClick={() => setSidebarVisible(false)}
        >
          Hide Panel
        </button>
        <div className="panel-title-row">
          <div className="panel-title-block">
            <h1>Big Tree Viewer</h1>
            <p>by John B Allard</p>
            <p className="panel-title-description">
              {HOME_DESCRIPTION}{" "}
              <a className="panel-title-link" href={`${import.meta.env.BASE_URL}#about`}>Learn more</a>
            </p>
          </div>
        </div>

        <PanelSection title="Data" isOpen={dataOpen} onToggle={() => setDataOpen(!dataOpen)} tourId="data">
          <div className="button-row">
            <button type="button" onClick={() => void loadExample()} disabled={loadState.loading}>
              Load Example
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => fileInputRef.current?.click()}
            >
              Open File
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
              accept=".nwk,.newick,.tree,.tre,.txt,.nex,.nexus,.btvsession,.json"
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
              onClick={openExportOptions}
            >
              Export View
            </button>
            {!hideDownloadNewick ? (
              <button
                type="button"
                className="secondary"
                disabled={!tree}
                onClick={downloadCurrentTreeNewick}
              >
                Download Newick
              </button>
            ) : null}
          </div>
          {showExportOptions ? (
            <div className="export-options" role="dialog" aria-label="Export view settings">
              <label>
                Format
                <select
                  value={exportViewFormat}
                  onChange={(event) => {
                    const nextFormat = event.target.value === "svg" ? "svg" : "png";
                    setExportViewFormat(nextFormat);
                    setExportViewFilenameInput((value) => {
                      const base = value.trim().replace(/\.(svg|png)$/i, "") || `${sanitizeExportBaseLabel(loadedTreeLabel)}-${viewMode}-view`;
                      return `${base}.${nextFormat}`;
                    });
                  }}
                >
                  <option value="png">PNG raster image</option>
                  <option value="svg">SVG vector file</option>
                </select>
              </label>
              <label>
                File name
                <input
                  type="text"
                  value={exportViewFilenameInput}
                  onChange={(event) => setExportViewFilenameInput(event.target.value)}
                />
              </label>
              {exportViewFormat === "png" ? (
                <>
                  <div className="export-options-grid">
                    <label>
                      Width px
                      <input
                        type="number"
                        min={320}
                        max={10000}
                        step={100}
                        value={exportViewWidthInput}
                        onChange={(event) => setExportViewWidthInput(Number(event.target.value))}
                      />
                    </label>
                    <label>
                      Height px
                      <input
                        type="number"
                        min={320}
                        max={10000}
                        step={100}
                        value={exportViewHeightInput}
                        onChange={(event) => setExportViewHeightInput(Number(event.target.value))}
                      />
                    </label>
                  </div>
                  <div className="export-options-grid">
                    <label>
                      Print width (in)
                      <input
                        type="number"
                        min={0.5}
                        max={100}
                        step={0.5}
                        value={exportViewPrintWidthInchesInput}
                        onChange={(event) => setExportViewPrintWidthInchesInput(Number(event.target.value))}
                      />
                    </label>
                    <label>
                      Print height (in)
                      <input
                        type="number"
                        min={0.5}
                        max={100}
                        step={0.5}
                        value={exportViewPrintHeightInchesInput}
                        onChange={(event) => setExportViewPrintHeightInchesInput(Number(event.target.value))}
                      />
                    </label>
                  </div>
                  <div className="export-options-grid export-options-grid-single">
                    <label>
                      DPI
                      <input
                        type="number"
                        min={72}
                        max={1200}
                        step={25}
                        value={exportViewDpiInput}
                        onChange={(event) => setExportViewDpiInput(Number(event.target.value))}
                      />
                    </label>
                  </div>
                  <button type="button" className="secondary export-helper-button" onClick={applyPrintSizeToPngExport}>
                    Set pixels from print size
                  </button>
                  <p className="export-options-help">
                    PNG exports the current viewport at the pixel dimensions above. Match the pixel aspect ratio to the figure shape you want; square dimensions usually work best for circular views. Very large exports can take a few seconds.
                  </p>
                </>
              ) : (
                <p className="export-options-help">
                  SVG is best for smaller or moderately detailed views. For hundreds of thousands of visible branches, PNG is usually the safer print format.
                </p>
              )}
              <div className="button-row">
                <button type="button" onClick={exportCurrentView}>
                  Export
                </button>
                <button type="button" className="secondary" onClick={() => setShowExportOptions(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
          <div className="button-row" data-tour="sessions">
            <button type="button" className="secondary" onClick={() => void saveSession()}>
              Save Session
            </button>
            <button type="button" className="secondary" onClick={() => void loadSession("full")}>
              Load Session
            </button>
            <button type="button" className="secondary" onClick={() => void loadSession("settings")}>
              Load Settings
            </button>
          </div>
          {(loadState.loading || sessionLoading) ? <div className="loading-progress" aria-hidden="true"><span /></div> : null}
          {loadState.loading && loadState.message ? <p className="status-line">{loadState.message}</p> : null}
          {loadState.error ? <p className="status-error">{loadState.error}</p> : null}
          {sessionStatus ? <p className="status-line">{sessionStatus}</p> : null}
          {sessionError ? <p className="status-error">{sessionError}</p> : null}
        </PanelSection>

        <PanelSection title="View" isOpen={viewOpen} onToggle={() => setViewOpen(!viewOpen)} tourId="view">
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
            {showSpiralViewOption ? (
              <button
                type="button"
                className={viewMode === "spiral" ? "active" : ""}
                onClick={() => setViewMode("spiral")}
              >
                Spiral
              </button>
            ) : null}
          </div>
          <div className="view-group-divider" aria-hidden="true" />
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
          <div className="view-group-divider" aria-hidden="true" />
          <div className="segmented">
            <button
              type="button"
              className={zoomAxisMode === "both" ? "active" : ""}
              onClick={() => setZoomAxisMode("both")}
              disabled={viewMode !== "rectangular"}
              title={disabledControlTitle(viewMode !== "rectangular" ? "Polar modes always zoom both axes together." : undefined)}
            >
              Zoom Both
            </button>
            <button
              type="button"
              className={zoomAxisMode === "x" ? "active" : ""}
              onClick={() => setZoomAxisMode("x")}
              disabled={viewMode !== "rectangular"}
              title={disabledControlTitle(viewMode !== "rectangular" ? "Polar modes always zoom both axes together." : undefined)}
            >
              Zoom X
            </button>
            <button
              type="button"
              className={zoomAxisMode === "y" ? "active" : ""}
              onClick={() => setZoomAxisMode("y")}
              disabled={viewMode !== "rectangular"}
              title={disabledControlTitle(viewMode !== "rectangular" ? "Polar modes always zoom both axes together." : undefined)}
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
          {viewMode === "circular" || viewMode === "spiral" ? (
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
              {viewMode === "spiral" ? (
                <>
                  <label htmlFor="spiral-turns">Spiral turns</label>
                  <input
                    id="spiral-turns"
                    type="range"
                    min={3}
                    max={8}
                    step={0.1}
                    value={spiralTurns}
                    onChange={(event) => setSpiralTurns(Number(event.target.value))}
                  />
                  <div className="figure-style-value">{spiralTurns.toFixed(1)}</div>
                </>
              ) : null}
            </div>
          ) : null}
        </PanelSection>

        <PanelSection title="Visual Options" isOpen={visualOpen} onToggle={() => setVisualOpen(!visualOpen)} tourId="visual">
          <div className="option-list">
            <div className="visual-option-row">
              <label className="visual-option-checkbox">
                <input
                  type="checkbox"
                  checked={showTipLabels}
                  onChange={(event) => setShowTipLabels(event.target.checked)}
                />
                Show tip labels
              </label>
              <div className="visual-option-actions">
                <LabelStyleSection
                  labelClass="tip"
                  settings={figureStyles.tip}
                  viewMode={viewMode}
                  isOpen={activeLabelStylePopover === "tip"}
                  disabled={!showTipLabels}
                  disabledReason="Enable tip labels first."
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
                        Overlay style
                        <select
                          value={taxonomyOverlayStyle}
                          onChange={(event) => setTaxonomyOverlayStyle(event.target.value === "strands" ? "strands" : "ribbons")}
                        >
                          <option value="ribbons">Filled ribbons</option>
                          <option value="strands">Center strands</option>
                        </select>
                      </label>
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
                      <label>
                        Color palette
                        <select
                          value={taxonomyColorPalette}
                          onChange={(event) => setTaxonomyColorPalette(event.target.value as TaxonomyColorPaletteKey)}
                        >
                          {taxonomyColorPaletteOptions.map((paletteKey) => (
                            <option key={paletteKey} value={paletteKey}>
                              {TAXONOMY_COLOR_PALETTES[paletteKey].label}
                            </option>
                          ))}
                        </select>
                      </label>
                      {taxonomyColorPalette === "custom" ? (
                        <>
                          <label>
                            Custom palette colors
                            <textarea
                              rows={3}
                              value={taxonomyCustomPaletteInput}
                              placeholder="#4e79a7, #f28e2b, #59a14f"
                              onChange={(event) => setTaxonomyCustomPaletteInput(event.target.value)}
                            />
                          </label>
                          <label>
                            Upload palette text
                            <input
                              type="file"
                              accept=".txt,.csv,.tsv,text/plain,text/csv"
                              onChange={(event) => {
                                const file = event.target.files?.[0] ?? null;
                                if (!file) {
                                  return;
                                }
                                void file.text().then((text) => {
                                  setTaxonomyCustomPaletteInput(text);
                                });
                              }}
                            />
                          </label>
                          <div className="figure-style-value">{customTaxonomyPaletteColors.length} colors</div>
                        </>
                      ) : null}
                      {taxonomyMap && availableTaxonomyRanks.length > 0 ? (
                        <>
                          <label>
                            Palette anchor rank
                            <select
                              value={taxonomyColorRootRank}
                              onChange={(event) => setTaxonomyColorRootRank(event.target.value as TaxonomyRank | "auto")}
                            >
                              <option value="auto">Auto balanced rank</option>
                              {availableTaxonomyRanks.map((rank) => (
                                <option key={rank} value={rank}>{taxonomyRankLabel(rank)}</option>
                              ))}
                            </select>
                          </label>
                          <label>
                            Branch jitter floor
                            <select
                              value={taxonomyColorJitterRank}
                              onChange={(event) => setTaxonomyColorJitterRank(event.target.value as TaxonomyRank)}
                            >
                              {availableTaxonomyRanks.map((rank) => (
                                <option key={rank} value={rank}>{taxonomyRankLabel(rank)}</option>
                              ))}
                            </select>
                          </label>
                        </>
                      ) : null}
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
                      <label
                        className="label-style-inline-toggle"
                        title={viewMode === "spiral" ? "Spiral mode always uses a log time axis." : undefined}
                      >
                        <input
                          type="checkbox"
                          checked={viewMode === "spiral" || timeAxisScale === "log"}
                          disabled={viewMode === "spiral"}
                          onChange={(event) => setTimeAxisScale(event.target.checked ? "log" : "linear")}
                        />
                        Use log time axis
                      </label>
                      <label
                        htmlFor="time-axis-log-base"
                        className={viewMode !== "spiral" && timeAxisScale !== "log" ? "label-style-disabled-control" : undefined}
                      >
                        Log time scale base
                        <input
                          id="time-axis-log-base"
                          type="range"
                          min={MIN_TIME_AXIS_LOG_BASE}
                          max={MAX_TIME_AXIS_LOG_BASE}
                          step={0.1}
                          value={timeAxisLogBaseDraft}
                          disabled={viewMode !== "spiral" && timeAxisScale !== "log"}
                          onChange={(event) => setTimeAxisLogBaseDraft(Number(event.target.value))}
                          onPointerUp={commitTimeAxisLogBaseDraft}
                          onMouseUp={commitTimeAxisLogBaseDraft}
                          onTouchEnd={commitTimeAxisLogBaseDraft}
                          onBlur={commitTimeAxisLogBaseDraft}
                          onKeyUp={(event) => {
                            if (event.key === "Enter" || event.key === " " || event.key.startsWith("Arrow")) {
                              commitTimeAxisLogBaseDraft();
                            }
                          }}
                        />
                      </label>
                      <div className="figure-style-value">{timeAxisLogBaseDraft.toFixed(1)}</div>
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
                    <select value={timeStripeStyle} onChange={(event) => setTimeStripeStyle(event.target.value as TimeStripeStyle)}>
                      <option value="bands">Shaded bands</option>
                      <option value="age-gradient">Old-to-young gradient</option>
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

        <PanelSection title="Taxonomy" isOpen={taxonomyOpen} onToggle={() => setTaxonomyOpen(!taxonomyOpen)} tourId="taxonomy">
          <div className="search-controls">
            {taxonomyCached === null ? (
              <p className="status-line">Checking local taxonomy cache...</p>
            ) : taxonomyCached ? (
              <>
                <p className="status-line">Taxonomy cache found.</p>
                <button
                  type="button"
                  className="text-link-button taxonomy-storage-link"
                  onClick={() => setTaxonomyStorageInfoVisible((visible) => !visible)}
                >
                  Where is this file on my computer?
                </button>
                {taxonomyStorageInfoVisible ? (
                  <div className="taxonomy-storage-note">
                    <p>
                      Big Tree Viewer stores the NCBI taxdump archive in browser-managed
                      IndexedDB site storage, not as a normal visible download.
                    </p>
                    <p>
                      Database: <code>big-tree-viewer-taxonomy</code>, object store:
                      <code> archives</code>, key: <code>ncbi-taxdmp-zip</code>.
                    </p>
                    <p>
                      Typical browser profile locations are under
                      <code> ~/Library/Application Support/[browser]/.../IndexedDB</code> on macOS,
                      <code> ~/.config/[browser]/.../IndexedDB</code> on Linux, and
                      <code> %LOCALAPPDATA%\[browser]\User Data\...\IndexedDB</code> on Windows.
                      The exact profile folder is chosen by your browser.
                    </p>
                  </div>
                ) : null}
              </>
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
                <div className="taxonomy-silhouette-controls">
                  <button
                    type="button"
                    className="section-toggle taxonomy-subsection-toggle"
                    aria-expanded={phylopicOpen}
                    onClick={() => setPhyloPicOpen(!phylopicOpen)}
                  >
                    <span className={`section-toggle-mark${phylopicOpen ? " open" : ""}`}>▸</span>
                    <span>Silhouettes</span>
                  </button>
                  {phylopicOpen ? (
                    <div className="taxonomy-silhouette-body">
                      <div className="taxonomy-silhouette-ranks" aria-label="Taxonomy ranks for silhouette retrieval">
                        {phylopicSelectableRanks.map((rank) => {
                          const rankVisible = !phylopicHasViewportRankInfo || phylopicViewportRankSet.has(rank);
                          return (
                            <label key={rank} className={`taxonomy-rank-checkbox${rankVisible ? "" : " taxonomy-rank-checkbox-disabled"}`} title={rankVisible ? undefined : "This rank is not visible in the current viewport."}>
                              <input
                                type="checkbox"
                                disabled={!rankVisible}
                                checked={phylopicRankSelection[rank] ?? false}
                                onChange={(event) => {
                                  setPhyloPicRankSelection((current) => ({
                                    ...current,
                                    [rank]: event.target.checked,
                                  }));
                                }}
                              />
                              <span>{taxonomyRankLabel(rank)}</span>
                            </label>
                          );
                        })}
                      </div>
                      <div className="button-row">
                        <button
                          type="button"
                          className="secondary"
                          disabled={phylopicRetrieving || !taxonomyEnabled || !phylopicHasSelectedVisibleRank}
                          title={disabledControlTitle(!taxonomyEnabled ? "Show taxonomy overlays first." : phylopicRetrieving ? "PhyloPic retrieval is already running." : !phylopicHasSelectedVisibleRank ? "Select at least one visible rank." : undefined) ?? "Retrieve publication-compatible PhyloPic silhouettes for the selected visible taxonomy ranks, cache them locally, and generate an attribution caption."}
                          onClick={() => void retrievePhyloPicForVisibleTaxa()}
                        >
                          Retrieve Silhouettes
                        </button>
                        {phylopicRetrieving ? (
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => {
                              phylopicCancelRequestedRef.current = true;
                              setPhyloPicStatus("Cancelling PhyloPic retrieval after the current request finishes...");
                            }}
                          >
                            Cancel Retrieval
                          </button>
                        ) : null}
                        {phylopicSilhouettes.length > 0 ? (
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => {
                              setPhyloPicSilhouettes([]);
                              setPhyloPicEnabled(false);
                            }}
                          >
                            Clear Silhouettes
                          </button>
                        ) : null}
                      </div>
                      {phylopicSilhouettes.length > 0 ? (
                        <div className="taxonomy-silhouette-settings">
                          <label>
                            Placement
                            <select value={phylopicPlacement} onChange={(event) => setPhyloPicPlacement(event.target.value as "after-label" | "outside-ribbon")}>
                              <option value="after-label">After label along ribbon</option>
                              <option value="outside-ribbon">Outside rectangular ribbon</option>
                            </select>
                          </label>
                          <label>
                            Silhouette size
                            <input
                              type="range"
                              min={0.35}
                              max={4}
                              step={0.05}
                              value={phylopicSizeScale}
                              onChange={(event) => setPhyloPicSizeScale(Number(event.target.value))}
                            />
                          </label>
                          <div className="figure-style-value">x{phylopicSizeScale.toFixed(2)} ribbon width</div>
                          <label>
                            {viewMode === "rectangular" ? "Along-label offset" : "Angular offset"}
                            <input
                              type="range"
                              min={-160}
                              max={160}
                              step={1}
                              value={phylopicOffsetXPx}
                              onChange={(event) => setPhyloPicOffsetXPx(Number(event.target.value))}
                            />
                          </label>
                          <div className="figure-style-value">{phylopicOffsetXPx.toFixed(0)}px</div>
                          <label>
                            {viewMode === "rectangular" ? "Across-ribbon offset" : "Radial offset"}
                            <input
                              type="range"
                              min={-160}
                              max={160}
                              step={1}
                              value={phylopicOffsetYPx}
                              onChange={(event) => setPhyloPicOffsetYPx(Number(event.target.value))}
                            />
                          </label>
                          <div className="figure-style-value">{phylopicOffsetYPx.toFixed(0)}px</div>
                          <p className="status-line">
                            Retrieves at most {PHYLOPIC_MAX_RETRIEVE_PER_CLICK} selected visible labels per click with light throttling for large batches, excludes NonCommercial licenses, and caches successful PNG silhouettes in this browser for display and export.
                          </p>
                        </div>
                      ) : null}
                      {phylopicStatus ? <p className="status-line">{phylopicStatus}</p> : null}
                      {phylopicError ? <p className="status-error">{phylopicError}</p> : null}
                      {phylopicCaption ? (
                        <>
                          <button
                            type="button"
                            className="text-link-button"
                            onClick={() => setPhyloPicCaptionVisible((visible) => !visible)}
                          >
                            {phylopicCaptionVisible ? "Hide PhyloPic attribution caption" : "Show PhyloPic attribution caption"}
                          </button>
                          {phylopicCaptionVisible ? (
                            <textarea className="taxonomy-caption-textarea" readOnly value={phylopicCaption} />
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </>
            ) : null}
          </div>
        </PanelSection>

        <PanelSection title="Metadata" isOpen={metadataOpen} onToggle={() => setMetadataOpen(!metadataOpen)} tourId="metadata">
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
          zoomAxisMode={viewMode !== "rectangular" ? "both" : zoomAxisMode}
          circularRotation={(circularRotationDegrees * Math.PI) / 180}
          spiralTurns={spiralTurns}
          showTimeStripes={showTimeStripes}
          timeStripeStyle={timeStripeStyle}
          timeStripeLineWeight={timeStripeLineWeight}
          showScaleBars={showScaleBars}
          timeAxisScale={timeAxisScale}
          timeAxisLogBase={timeAxisLogBase}
          scaleTickInterval={scaleTickInterval}
          showIntermediateScaleTicks={showIntermediateScaleTicks}
          extendRectScaleToTick={extendRectScaleToTick}
          showScaleZeroTick={showScaleZeroTick}
          circularCenterScaleAngleDegrees={effectiveCircularCenterScaleAngleDegrees}
          useAutoCircularCenterScaleAngle={useAutoCircularCenterScaleAngle}
          showCircularCenterRadialScaleBar={showCircularCenterRadialScaleBar}
          showTipLabels={showTipLabels}
          showGenusLabels={showGenusLabels && !taxonomyEnabled && !taxonomyCollapseIsSynthetic}
          taxonomyEnabled={taxonomyEnabled}
          taxonomyOverlayStyle={taxonomyOverlayStyle}
          taxonomyBranchColoringEnabled={taxonomyBranchColoringEnabled}
          taxonomyColorJitter={taxonomyColorJitter}
          taxonomyColorPalette={taxonomyColorPalette}
          taxonomyCustomPaletteColors={customTaxonomyPaletteColors}
          taxonomyColorRootRank={taxonomyColorRootRank}
          taxonomyColorJitterRank={taxonomyColorJitterRank}
          useAutomaticTaxonomyRankVisibility={useAutomaticTaxonomyRankVisibility}
          taxonomyRankVisibility={taxonomyRankVisibility}
          taxonomyCollapseRank={taxonomyCollapseRank}
          taxonomyMap={viewTaxonomyMap}
          taxonomyColorSourceMap={taxonomyMap}
          phylopicEnabled={phylopicEnabled}
          phylopicSilhouettes={phylopicSilhouettes}
          phylopicPlacement={phylopicPlacement}
          phylopicSizeScale={phylopicSizeScale}
          phylopicOffsetXPx={phylopicOffsetXPx}
          phylopicOffsetYPx={phylopicOffsetYPx}
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
          exportPngRequest={exportPngRequest}
          exportPngFilename={exportPngFilename}
          exportPngWidth={exportPngWidth}
          exportPngHeight={exportPngHeight}
          sessionStateRequest={sessionStateRequest}
          sessionRestoreRequest={sessionRestoreRequest}
          sessionRestoreState={sessionRestoreState}
          visualResetRequest={visualResetRequest}
          tutorialBranchMenuDemoActive={tutorialActive && TUTORIAL_STEPS[tutorialStepIndex]?.id === "branchMenu"}
          onHoverChange={handleHoverChange}
          onRerootRequest={taxonomyCollapseIsSynthetic ? undefined : rerootCurrentTree}
          onViewModeChange={setViewMode}
          onSessionStateSnapshot={handleSessionStateSnapshot}
        />
        {phylopicEnabled && phylopicSilhouettes.length > 0 && !phylopicReminderDismissed ? (
          <div className="phylopic-attribution-reminder">
            <button
              type="button"
              className="phylopic-attribution-close"
              aria-label="Dismiss PhyloPic attribution reminder"
              onClick={() => setPhyloPicReminderDismissed(true)}
            >
              ×
            </button>
            <strong>PhyloPic attribution required</strong>
            <span>Include the generated attribution caption if you use this figure.</span>
            <button
              type="button"
              className="text-link-button"
              onClick={() => {
                setTaxonomyOpen(true);
                setPhyloPicOpen(true);
                setPhyloPicCaptionVisible(true);
              }}
            >
              Open caption
            </button>
          </div>
        ) : null}
      </main>
    </div>
  );
}
