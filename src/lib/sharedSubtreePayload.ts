import { cloneDefaultFigureStyles, FONT_FAMILY_OPTIONS, type FigureStyleSettings, type FontFamilyKey, type LabelStyleClass } from "./figureStyles";
import { DEFAULT_TAXONOMY_COLOR_PALETTE, isTaxonomyColorPaletteKey, type TaxonomyColorPaletteKey } from "./taxonomyPalettes";
import { DEFAULT_TIME_AXIS_LOG_BASE, MAX_TIME_AXIS_LOG_BASE, MIN_TIME_AXIS_LOG_BASE, type TimeAxisScale } from "./timeAxis";
import type { TaxonomyCollapseFallback, TaxonomyCollapseRank, TaxonomyMapPayload, TaxonomyRank } from "../types/taxonomy";
import type { TreeModel } from "../types/tree";
import { TAXONOMY_RANKS, type TaxonomyTipRanks } from "../types/taxonomy";
import { deriveActiveTaxonomyRanks } from "./taxonomyActiveRanks";
import type { LayoutOrder, ViewMode, ZoomAxisMode } from "../types/tree";
import type { NodeErrorBarStyle, TaxonomyOverlayStyle, TaxonomyRankDisplayMode, TimeStripeStyle } from "../components/treeCanvasTypes";

export type SharedSubtreeTaxonomyEntry = {
  name: string;
  ranks: Partial<Record<TaxonomyRank, string>>;
  taxIds?: Partial<Record<TaxonomyRank, number>>;
  collapseFallbacks?: Partial<Record<TaxonomyRank, TaxonomyCollapseFallback>>;
};

export type SharedSubtreeTaxonomyPayload = {
  version?: number;
  mappedCount: number;
  totalTips: number;
  activeRanks: TaxonomyRank[];
  tipEntries: SharedSubtreeTaxonomyEntry[];
};

export type SharedSubtreeStoragePayload = {
  version: 1 | 2;
  newick: string;
  taxonomy?: SharedSubtreeTaxonomyPayload;
  visual?: SharedSubtreeVisualPayload;
  controls?: {
    hideDownloadNewick?: boolean;
  };
};

export type SharedSubtreeVisualPayload = {
  viewMode: ViewMode;
  order: LayoutOrder;
  zoomAxisMode: ZoomAxisMode;
  circularRotationDegrees: number;
  radialAngularSpanDegrees?: number;
  radialCenterOpeningRatio?: number;
  spiralTurns: number;
  showTimeStripes: boolean;
  timeAxisScale: TimeAxisScale;
  timeAxisLogBase: number;
  timeStripeStyle: TimeStripeStyle;
  timeStripeLineWeight: number;
  showScaleBars: boolean;
  scaleTickInterval: number | null;
  showIntermediateScaleTicks: boolean;
  extendRectScaleToTick: boolean;
  showScaleZeroTick: boolean;
  useAutoCircularCenterScaleAngle: boolean;
  circularCenterScaleAngleDegrees: number;
  showCircularCenterRadialScaleBar: boolean;
  showTipLabels: boolean;
  alignTipLabels: boolean;
  showGenusLabels: boolean;
  showInternalNodeLabels: boolean;
  showBootstrapLabels: boolean;
  showNodeHeightLabels: boolean;
  showNodeErrorBars: boolean;
  errorBarStyle: NodeErrorBarStyle;
  errorBarColor: string;
  errorBarOpacity: number;
  errorBarShowNodeDot: boolean;
  errorBarThicknessPx: number;
  errorBarCapSizePx: number;
  figureStyles: FigureStyleSettings;
  taxonomyEnabled: boolean;
  taxonomyOverlayStyle: TaxonomyOverlayStyle;
  taxonomyBranchColoringEnabled: boolean;
  useAutomaticTaxonomyRankVisibility: boolean;
  taxonomyRankVisibility: Partial<Record<TaxonomyRank, boolean>>;
  taxonomyRankDisplayModes: Partial<Record<TaxonomyRank, TaxonomyRankDisplayMode>>;
  taxonomyCollapseRank: TaxonomyCollapseRank;
  taxonomyColorJitter: number;
  taxonomyColorPalette: TaxonomyColorPaletteKey;
  taxonomyCustomPaletteInput: string;
  taxonomyColorRootRank: TaxonomyRank | "auto";
  taxonomyColorJitterRank: TaxonomyRank;
  taxonomyLabelOnlyStrandRank?: TaxonomyRank | "none";
  branchThicknessScale: number;
};

const FONT_FAMILY_KEYS = new Set<FontFamilyKey>(FONT_FAMILY_OPTIONS.map((option) => option.key));
const LABEL_STYLE_CLASSES: LabelStyleClass[] = ["tip", "genus", "taxonomy", "internalNode", "bootstrap", "nodeHeight", "scale"];

function coerceFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function coerceBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function coerceEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

function coerceNullableFiniteNumber(value: unknown): number | null {
  if (value === null) {
    return null;
  }
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function coerceTimeAxisLogBase(value: unknown): number {
  const numeric = coerceFiniteNumber(value, DEFAULT_TIME_AXIS_LOG_BASE);
  return Math.max(MIN_TIME_AXIS_LOG_BASE, Math.min(MAX_TIME_AXIS_LOG_BASE, numeric));
}

function parseSharedFigureStyles(raw: unknown): FigureStyleSettings {
  const defaults = cloneDefaultFigureStyles();
  if (!raw || typeof raw !== "object") {
    return defaults;
  }
  const candidate = raw as Partial<Record<LabelStyleClass, Partial<FigureStyleSettings[LabelStyleClass]>>>;
  for (let index = 0; index < LABEL_STYLE_CLASSES.length; index += 1) {
    const labelClass = LABEL_STYLE_CLASSES[index];
    const source = candidate[labelClass];
    if (!source || typeof source !== "object") {
      continue;
    }
    const current = defaults[labelClass];
    const fontFamily = source.fontFamily;
    current.fontFamily = typeof fontFamily === "string" && FONT_FAMILY_KEYS.has(fontFamily as FontFamilyKey)
      ? fontFamily as FontFamilyKey
      : current.fontFamily;
    current.sizeScale = coerceFiniteNumber(source.sizeScale, current.sizeScale);
    current.offsetPx = coerceFiniteNumber(source.offsetPx, current.offsetPx);
    current.offsetXPx = coerceFiniteNumber(source.offsetXPx, current.offsetXPx);
    current.offsetYPx = coerceFiniteNumber(source.offsetYPx, current.offsetYPx);
    current.bandThicknessScale = coerceFiniteNumber(source.bandThicknessScale, current.bandThicknessScale ?? 1);
    if (labelClass === "taxonomy") {
      const sourceTaxonomyGap = typeof source.taxonomyGap === "number" && Number.isFinite(source.taxonomyGap)
        ? source.taxonomyGap
        : coerceFiniteNumber(source.taxonomyGapPx, 0) + 1;
      current.taxonomyGap = sourceTaxonomyGap;
      current.taxonomyGapPx = 0;
    } else {
      current.taxonomyGapPx = coerceFiniteNumber(source.taxonomyGapPx, current.taxonomyGapPx ?? 0);
    }
    current.bold = coerceBoolean(source.bold, Boolean(current.bold));
    current.italic = coerceBoolean(source.italic, Boolean(current.italic));
    if (labelClass === "tip") {
      current.limitWidth = coerceBoolean(source.limitWidth, Boolean(current.limitWidth));
      current.maxWidthPx = Math.max(40, coerceFiniteNumber(source.maxWidthPx, current.maxWidthPx ?? 240));
      current.overflowMode = coerceEnum(source.overflowMode, ["truncate", "scale"] as const, "truncate");
    }
    if (labelClass === "bootstrap" || labelClass === "nodeHeight") {
      current.decimalPlaces = Math.max(-1, Math.min(6, Math.round(coerceFiniteNumber(
        source.decimalPlaces,
        current.decimalPlaces ?? -1,
      ))));
      current.polarOrientation = coerceEnum(
        source.polarOrientation,
        ["tangential", "radial"] as const,
        "tangential",
      );
    }
  }
  return defaults;
}

function parseSharedSubtreeVisualPayload(raw: unknown): SharedSubtreeVisualPayload | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const source = raw as Partial<SharedSubtreeVisualPayload>;
  const parsedTaxonomyRankVisibility: Partial<Record<TaxonomyRank, boolean>> = {};
  const parsedTaxonomyRankDisplayModes: Partial<Record<TaxonomyRank, TaxonomyRankDisplayMode>> = {};
  if (source.taxonomyRankVisibility && typeof source.taxonomyRankVisibility === "object") {
    for (let index = 0; index < TAXONOMY_RANKS.length; index += 1) {
      const rank = TAXONOMY_RANKS[index];
      const value = source.taxonomyRankVisibility[rank];
      if (typeof value === "boolean") {
        parsedTaxonomyRankVisibility[rank] = value;
      }
    }
  }
  if (source.taxonomyRankDisplayModes && typeof source.taxonomyRankDisplayModes === "object") {
    for (let index = 0; index < TAXONOMY_RANKS.length; index += 1) {
      const rank = TAXONOMY_RANKS[index];
      const value = source.taxonomyRankDisplayModes[rank];
      if (value === "hidden" || value === "label-only" || value === "ribbon") {
        parsedTaxonomyRankDisplayModes[rank] = value;
      }
    }
  }
  const legacyLabelOnlyRank = coerceEnum(source.taxonomyLabelOnlyStrandRank, ["none", ...TAXONOMY_RANKS] as const, "none");
  if (legacyLabelOnlyRank !== "none" && !parsedTaxonomyRankDisplayModes[legacyLabelOnlyRank]) {
    parsedTaxonomyRankDisplayModes[legacyLabelOnlyRank] = "label-only";
  }
  const hasErrorBarStyle = source.errorBarStyle === "rectangle" || source.errorBarStyle === "capped-line";
  return {
    viewMode: coerceEnum(source.viewMode, ["rectangular", "circular", "fan", "spiral"] as const, "rectangular"),
    order: coerceEnum(source.order, ["asc", "desc", "input"] as const, "asc"),
    zoomAxisMode: coerceEnum(source.zoomAxisMode, ["both", "x", "y"] as const, "both"),
    circularRotationDegrees: coerceFiniteNumber(source.circularRotationDegrees, 0),
    radialAngularSpanDegrees: coerceFiniteNumber(source.radialAngularSpanDegrees, source.viewMode === "fan" ? 180 : 360),
    radialCenterOpeningRatio: coerceFiniteNumber(source.radialCenterOpeningRatio, 0),
    spiralTurns: coerceFiniteNumber(source.spiralTurns, 5.5),
    showTimeStripes: coerceBoolean(source.showTimeStripes, true),
    timeAxisScale: coerceEnum(source.timeAxisScale, ["linear", "log"] as const, "linear"),
    timeAxisLogBase: coerceTimeAxisLogBase(source.timeAxisLogBase),
    timeStripeStyle: coerceEnum(source.timeStripeStyle, ["bands", "age-gradient", "dashed"] as const, "bands"),
    timeStripeLineWeight: coerceFiniteNumber(source.timeStripeLineWeight, 1.1),
    showScaleBars: coerceBoolean(source.showScaleBars, true),
    scaleTickInterval: coerceNullableFiniteNumber(source.scaleTickInterval),
    showIntermediateScaleTicks: coerceBoolean(source.showIntermediateScaleTicks, true),
    extendRectScaleToTick: coerceBoolean(source.extendRectScaleToTick, false),
    showScaleZeroTick: coerceBoolean(source.showScaleZeroTick, false),
    useAutoCircularCenterScaleAngle: coerceBoolean(source.useAutoCircularCenterScaleAngle, true),
    circularCenterScaleAngleDegrees: coerceFiniteNumber(source.circularCenterScaleAngleDegrees, -5),
    showCircularCenterRadialScaleBar: coerceBoolean(source.showCircularCenterRadialScaleBar, false),
    showTipLabels: coerceBoolean(source.showTipLabels, true),
    alignTipLabels: coerceBoolean(source.alignTipLabels, false),
    showGenusLabels: coerceBoolean(source.showGenusLabels, true),
    showInternalNodeLabels: coerceBoolean(source.showInternalNodeLabels, false),
    showBootstrapLabels: coerceBoolean(source.showBootstrapLabels, false),
    showNodeHeightLabels: coerceBoolean(source.showNodeHeightLabels, false),
    showNodeErrorBars: coerceBoolean(source.showNodeErrorBars, false),
    errorBarStyle: coerceEnum(source.errorBarStyle, ["rectangle", "capped-line"] as const, "capped-line"),
    errorBarColor: typeof source.errorBarColor === "string" ? source.errorBarColor : hasErrorBarStyle ? "#166534" : "#64748b",
    errorBarOpacity: Math.max(0.05, Math.min(1, coerceFiniteNumber(source.errorBarOpacity, hasErrorBarStyle ? 0.38 : 0.82))),
    errorBarShowNodeDot: coerceBoolean(source.errorBarShowNodeDot, false),
    errorBarThicknessPx: coerceFiniteNumber(source.errorBarThicknessPx, hasErrorBarStyle ? 5 : 1.2),
    errorBarCapSizePx: coerceFiniteNumber(source.errorBarCapSizePx, 7),
    figureStyles: parseSharedFigureStyles(source.figureStyles),
    taxonomyEnabled: coerceBoolean(source.taxonomyEnabled, false),
    taxonomyOverlayStyle: coerceEnum(source.taxonomyOverlayStyle, ["ribbons", "strands"] as const, "ribbons"),
    taxonomyBranchColoringEnabled: coerceBoolean(source.taxonomyBranchColoringEnabled, true),
    useAutomaticTaxonomyRankVisibility: coerceBoolean(source.useAutomaticTaxonomyRankVisibility, true),
    taxonomyRankVisibility: parsedTaxonomyRankVisibility,
    taxonomyRankDisplayModes: parsedTaxonomyRankDisplayModes,
    taxonomyCollapseRank: coerceEnum(source.taxonomyCollapseRank, ["species", ...TAXONOMY_RANKS] as const, "species"),
    taxonomyColorJitter: coerceFiniteNumber(source.taxonomyColorJitter, 1),
    taxonomyColorPalette: isTaxonomyColorPaletteKey(source.taxonomyColorPalette)
      ? source.taxonomyColorPalette
      : DEFAULT_TAXONOMY_COLOR_PALETTE,
    taxonomyCustomPaletteInput: typeof source.taxonomyCustomPaletteInput === "string" ? source.taxonomyCustomPaletteInput : "",
    taxonomyColorRootRank: coerceEnum(source.taxonomyColorRootRank, ["auto", ...TAXONOMY_RANKS] as const, "auto"),
    taxonomyColorJitterRank: coerceEnum(source.taxonomyColorJitterRank, TAXONOMY_RANKS, "genus"),
    taxonomyLabelOnlyStrandRank: legacyLabelOnlyRank,
    branchThicknessScale: coerceFiniteNumber(source.branchThicknessScale, 1),
  };
}

export function parseSharedSubtreeStoragePayload(raw: string): SharedSubtreeStoragePayload {
  try {
    const parsed = JSON.parse(raw) as Partial<SharedSubtreeStoragePayload>;
    if (parsed && typeof parsed.newick === "string") {
      return {
        version: parsed.version === 2 ? 2 : 1,
        newick: parsed.newick,
        taxonomy: parsed.taxonomy
          ? {
            version: parsed.taxonomy.version,
            mappedCount: Number(parsed.taxonomy.mappedCount ?? 0),
            totalTips: Number(parsed.taxonomy.totalTips ?? 0),
            activeRanks: Array.isArray(parsed.taxonomy.activeRanks)
              ? parsed.taxonomy.activeRanks.filter((rank): rank is TaxonomyRank => (
                typeof rank === "string" && (TAXONOMY_RANKS as readonly string[]).includes(rank)
              ))
              : [],
            tipEntries: Array.isArray(parsed.taxonomy.tipEntries)
              ? parsed.taxonomy.tipEntries.filter((entry): entry is SharedSubtreeTaxonomyEntry => (
                Boolean(entry)
                && typeof entry.name === "string"
                && Boolean(entry.ranks)
              ))
              : [],
          }
          : undefined,
        visual: parseSharedSubtreeVisualPayload(parsed.visual),
        controls: parsed.controls && typeof parsed.controls === "object"
          ? { hideDownloadNewick: parsed.controls.hideDownloadNewick === true }
          : undefined,
      };
    }
  } catch {
    // Backward compatibility: older subtree shares stored raw Newick text only.
  }
  return {
    version: 1,
    newick: raw,
  };
}

export function rebuildSharedSubtreeTaxonomyMap(
  tree: TreeModel,
  payload: SharedSubtreeTaxonomyPayload,
): TaxonomyMapPayload | null {
  if (!payload.tipEntries.length) {
    return null;
  }
  const entriesByName = new Map<string, SharedSubtreeTaxonomyEntry[]>();
  for (let index = 0; index < payload.tipEntries.length; index += 1) {
    const entry = payload.tipEntries[index];
    const bucket = entriesByName.get(entry.name);
    if (bucket) {
      bucket.push(entry);
    } else {
      entriesByName.set(entry.name, [entry]);
    }
  }
  const tipRanks: TaxonomyTipRanks[] = [];
  for (let index = 0; index < tree.leafNodes.length; index += 1) {
    const node = tree.leafNodes[index];
    const name = tree.names[node] ?? "";
    const bucket = entriesByName.get(name);
    if (!bucket || bucket.length === 0) {
      continue;
    }
    const entry = bucket.shift();
    if (!entry) {
      continue;
    }
    tipRanks.push({
      node,
      ranks: entry.ranks,
      taxIds: entry.taxIds,
      collapseFallbacks: entry.collapseFallbacks,
    });
    if (bucket.length === 0) {
      entriesByName.delete(name);
    }
  }
  if (!tipRanks.length) {
    return null;
  }
  const derivedActiveRanks = deriveActiveTaxonomyRanks(tipRanks.map((tip) => tip.ranks));
  if (derivedActiveRanks.length === 0 && tipRanks.length > 1) {
    const finestRepeatedRank = [...TAXONOMY_RANKS]
      .reverse()
      .filter((rank) => payload.activeRanks.includes(rank))
      .find((rank) => {
        const counts = new Map<string, number>();
        for (let index = 0; index < tipRanks.length; index += 1) {
          const label = tipRanks[index].ranks[rank];
          if (label) {
            counts.set(label, (counts.get(label) ?? 0) + 1);
          }
        }
        return Array.from(counts.values()).some((count) => count > 1);
      });
    if (finestRepeatedRank) {
      derivedActiveRanks.push(finestRepeatedRank);
    }
  }
  return {
    version: payload.version,
    mappedCount: tipRanks.length,
    totalTips: tree.leafNodes.length,
    activeRanks: derivedActiveRanks,
    tipRanks,
  };
}
