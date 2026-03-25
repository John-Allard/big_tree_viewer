import { cloneDefaultFigureStyles, FONT_FAMILY_OPTIONS, type FigureStyleSettings, type FontFamilyKey, type LabelStyleClass } from "./figureStyles";
import type { TaxonomyCollapseRank, TaxonomyMapPayload, TaxonomyRank } from "../types/taxonomy";
import type { TreeModel } from "../types/tree";
import { TAXONOMY_RANKS, type TaxonomyTipRanks } from "../types/taxonomy";
import { deriveActiveTaxonomyRanks } from "./taxonomyActiveRanks";
import type { LayoutOrder, ViewMode, ZoomAxisMode } from "../types/tree";

export type SharedSubtreeTaxonomyEntry = {
  name: string;
  ranks: Partial<Record<TaxonomyRank, string>>;
  taxIds?: Partial<Record<TaxonomyRank, number>>;
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
};

export type SharedSubtreeVisualPayload = {
  viewMode: ViewMode;
  order: LayoutOrder;
  zoomAxisMode: ZoomAxisMode;
  circularRotationDegrees: number;
  showTimeStripes: boolean;
  timeStripeStyle: "bands" | "dashed";
  timeStripeLineWeight: number;
  showScaleBars: boolean;
  scaleTickInterval: number | null;
  showIntermediateScaleTicks: boolean;
  extendRectScaleToTick: boolean;
  showScaleZeroTick: boolean;
  useAutoCircularCenterScaleAngle: boolean;
  circularCenterScaleAngleDegrees: number;
  showCircularCenterRadialScaleBar: boolean;
  showGenusLabels: boolean;
  showInternalNodeLabels: boolean;
  showBootstrapLabels: boolean;
  showNodeHeightLabels: boolean;
  showNodeErrorBars: boolean;
  errorBarThicknessPx: number;
  errorBarCapSizePx: number;
  figureStyles: FigureStyleSettings;
  taxonomyEnabled: boolean;
  taxonomyBranchColoringEnabled: boolean;
  useAutomaticTaxonomyRankVisibility: boolean;
  taxonomyRankVisibility: Partial<Record<TaxonomyRank, boolean>>;
  taxonomyCollapseRank: TaxonomyCollapseRank;
  taxonomyColorJitter: number;
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
    current.bold = coerceBoolean(source.bold, Boolean(current.bold));
    current.italic = coerceBoolean(source.italic, Boolean(current.italic));
  }
  return defaults;
}

function parseSharedSubtreeVisualPayload(raw: unknown): SharedSubtreeVisualPayload | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const source = raw as Partial<SharedSubtreeVisualPayload>;
  const parsedTaxonomyRankVisibility: Partial<Record<TaxonomyRank, boolean>> = {};
  if (source.taxonomyRankVisibility && typeof source.taxonomyRankVisibility === "object") {
    for (let index = 0; index < TAXONOMY_RANKS.length; index += 1) {
      const rank = TAXONOMY_RANKS[index];
      const value = source.taxonomyRankVisibility[rank];
      if (typeof value === "boolean") {
        parsedTaxonomyRankVisibility[rank] = value;
      }
    }
  }
  return {
    viewMode: coerceEnum(source.viewMode, ["rectangular", "circular"] as const, "rectangular"),
    order: coerceEnum(source.order, ["asc", "desc", "input"] as const, "asc"),
    zoomAxisMode: coerceEnum(source.zoomAxisMode, ["both", "x", "y"] as const, "both"),
    circularRotationDegrees: coerceFiniteNumber(source.circularRotationDegrees, 0),
    showTimeStripes: coerceBoolean(source.showTimeStripes, true),
    timeStripeStyle: coerceEnum(source.timeStripeStyle, ["bands", "dashed"] as const, "bands"),
    timeStripeLineWeight: coerceFiniteNumber(source.timeStripeLineWeight, 1.1),
    showScaleBars: coerceBoolean(source.showScaleBars, true),
    scaleTickInterval: coerceNullableFiniteNumber(source.scaleTickInterval),
    showIntermediateScaleTicks: coerceBoolean(source.showIntermediateScaleTicks, true),
    extendRectScaleToTick: coerceBoolean(source.extendRectScaleToTick, false),
    showScaleZeroTick: coerceBoolean(source.showScaleZeroTick, false),
    useAutoCircularCenterScaleAngle: coerceBoolean(source.useAutoCircularCenterScaleAngle, true),
    circularCenterScaleAngleDegrees: coerceFiniteNumber(source.circularCenterScaleAngleDegrees, -5),
    showCircularCenterRadialScaleBar: coerceBoolean(source.showCircularCenterRadialScaleBar, false),
    showGenusLabels: coerceBoolean(source.showGenusLabels, true),
    showInternalNodeLabels: coerceBoolean(source.showInternalNodeLabels, false),
    showBootstrapLabels: coerceBoolean(source.showBootstrapLabels, false),
    showNodeHeightLabels: coerceBoolean(source.showNodeHeightLabels, false),
    showNodeErrorBars: coerceBoolean(source.showNodeErrorBars, false),
    errorBarThicknessPx: coerceFiniteNumber(source.errorBarThicknessPx, 1.2),
    errorBarCapSizePx: coerceFiniteNumber(source.errorBarCapSizePx, 7),
    figureStyles: parseSharedFigureStyles(source.figureStyles),
    taxonomyEnabled: coerceBoolean(source.taxonomyEnabled, false),
    taxonomyBranchColoringEnabled: coerceBoolean(source.taxonomyBranchColoringEnabled, true),
    useAutomaticTaxonomyRankVisibility: coerceBoolean(source.useAutomaticTaxonomyRankVisibility, true),
    taxonomyRankVisibility: parsedTaxonomyRankVisibility,
    taxonomyCollapseRank: coerceEnum(source.taxonomyCollapseRank, ["species", ...TAXONOMY_RANKS] as const, "species"),
    taxonomyColorJitter: coerceFiniteNumber(source.taxonomyColorJitter, 1),
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
    });
    if (bucket.length === 0) {
      entriesByName.delete(name);
    }
  }
  if (!tipRanks.length) {
    return null;
  }
  return {
    version: payload.version,
    mappedCount: tipRanks.length,
    totalTips: tree.leafNodes.length,
    activeRanks: deriveActiveTaxonomyRanks(tipRanks.map((tip) => tip.ranks)),
    tipRanks,
  };
}
