import type { LayoutOrder } from "./tree";

export const TAXONOMY_RANKS = [
  "superkingdom",
  "kingdom",
  "phylum",
  "class",
  "order",
  "family",
  "genus",
] as const;

export type TaxonomyRank = typeof TAXONOMY_RANKS[number];

export function isAutomaticTaxonomyRank(rank: TaxonomyRank): boolean {
  return rank !== "kingdom";
}
export type TaxonomyCollapseRank = TaxonomyRank | "species";
export type TaxonomySource = "ncbi" | "catalogue-of-life";

export interface TaxonomyCollapseFallback {
  label: string;
  rank: string;
  taxId?: number;
}

export interface TaxonomyTipRanks {
  node: number;
  ranks: Partial<Record<TaxonomyRank, string>>;
  taxIds?: Partial<Record<TaxonomyRank, number>>;
  collapseFallbacks?: Partial<Record<TaxonomyRank, TaxonomyCollapseFallback>>;
}

export interface TaxonomyMapPayload {
  version?: number;
  source?: TaxonomySource;
  sourceVersion?: string;
  sourceDoi?: string;
  mappedCount: number;
  totalTips: number;
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
