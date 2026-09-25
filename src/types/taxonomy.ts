import type { LayoutOrder } from "./tree";

export const TAXONOMY_RANKS = [
  "superkingdom",
  "kingdom",
  "subkingdom",
  "infrakingdom",
  "superphylum",
  "phylum",
  "subphylum",
  "infraphylum",
  "superclass",
  "class",
  "subclass",
  "infraclass",
  "cohort",
  "subcohort",
  "superorder",
  "order",
  "suborder",
  "infraorder",
  "parvorder",
  "superfamily",
  "family",
  "subfamily",
  "tribe",
  "subtribe",
  "genus",
  "subgenus",
  "section",
  "subsection",
  "series",
  "subseries",
  "species group",
  "species subgroup",
] as const;

export type TaxonomyRank = typeof TAXONOMY_RANKS[number];

export const DEFAULT_TAXONOMY_RANKS = [
  "superkingdom",
  "kingdom",
  "phylum",
  "class",
  "order",
  "family",
  "genus",
] as const satisfies readonly TaxonomyRank[];

const DEFAULT_TAXONOMY_RANK_SET = new Set<TaxonomyRank>(DEFAULT_TAXONOMY_RANKS);

export const OPTIONAL_TAXONOMY_RANKS = TAXONOMY_RANKS.filter(
  (rank): rank is Exclude<TaxonomyRank, typeof DEFAULT_TAXONOMY_RANKS[number]> => !DEFAULT_TAXONOMY_RANK_SET.has(rank),
);

export function isDefaultTaxonomyRank(rank: TaxonomyRank): boolean {
  return DEFAULT_TAXONOMY_RANK_SET.has(rank);
}

export function isAutomaticTaxonomyRank(rank: TaxonomyRank): boolean {
  return isDefaultTaxonomyRank(rank) && rank !== "kingdom";
}
export type TaxonomyCollapseRank = TaxonomyRank | "species";
export type TaxonomySource = "ncbi" | "catalogue-of-life";
export type TaxonomyIdentifierMode = "scientific-name" | "ncbi-taxid";

export interface TaxonomyCollapseFallback {
  label: string;
  rank: string;
  taxId?: number;
}

export interface TaxonomyTipRanks {
  node: number;
  sourceTaxId?: number;
  ranks: Partial<Record<TaxonomyRank, string>>;
  taxIds?: Partial<Record<TaxonomyRank, number>>;
  collapseFallbacks?: Partial<Record<TaxonomyRank, TaxonomyCollapseFallback>>;
}

export interface TaxonomyMapPayload {
  version?: number;
  source?: TaxonomySource;
  identifierMode?: TaxonomyIdentifierMode;
  sourceVersion?: string;
  sourceDoi?: string;
  mappedCount: number;
  totalTips: number;
  resolvedRanks?: TaxonomyRank[];
  activeRanks: TaxonomyRank[];
  tipRanks: TaxonomyTipRanks[];
}

export interface CompactTaxonomyTaxon {
  taxId: number;
  parentTaxId?: number | null;
  rank: string;
  name: string;
}

export interface CompactTaxonomyTip {
  tipIndex: number;
  tipLabel?: string;
  taxId: number;
}

export interface CompactTaxonomyPayload {
  format: "big-tree-viewer-compact-taxonomy";
  version: 1;
  taxa: CompactTaxonomyTaxon[];
  tips: CompactTaxonomyTip[];
}

export interface TaxonomyBlock {
  rank: TaxonomyRank;
  label: string;
  taxId?: number | null;
  entityKey?: string;
  firstNode: number;
  lastNode: number;
  centerNode: number;
  startIndex?: number;
  endIndex?: number;
  labelStartIndex?: number;
  labelEndIndex?: number;
  color: string;
  segments?: Array<{
    firstNode: number;
    lastNode: number;
    startIndex: number;
    endIndex: number;
  }>;
}

export type TaxonomyBlocksByOrder = Record<LayoutOrder, Record<TaxonomyRank, TaxonomyBlock[]>>;
