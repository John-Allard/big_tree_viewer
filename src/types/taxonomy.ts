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
  mappedCount: number;
  totalTips: number;
  tipRanks: TaxonomyTipRanks[];
}

export interface TaxonomyBlock {
  rank: TaxonomyRank;
  label: string;
  firstNode: number;
  lastNode: number;
  centerNode: number;
  color: string;
}

export type TaxonomyBlocksByOrder = Record<LayoutOrder, Record<TaxonomyRank, TaxonomyBlock[]>>;
