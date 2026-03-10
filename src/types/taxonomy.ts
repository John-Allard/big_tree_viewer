import type { LayoutOrder } from "./tree";

export const TAXONOMY_RANKS = [
  "superkingdom",
  "phylum",
  "class",
  "order",
  "family",
  "genus",
] as const;

export type TaxonomyRank = typeof TAXONOMY_RANKS[number];

export interface TaxonomyTipRanks {
  node: number;
  ranks: Partial<Record<TaxonomyRank, string>>;
}

export interface TaxonomyMapPayload {
  version?: number;
  mappedCount: number;
  totalTips: number;
  activeRanks: TaxonomyRank[];
  tipRanks: TaxonomyTipRanks[];
}

export interface TaxonomyBlock {
  rank: TaxonomyRank;
  label: string;
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
