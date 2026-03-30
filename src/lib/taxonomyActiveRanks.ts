import type { TaxonomyRank, TaxonomyTipRanks } from "../types/taxonomy";

export const ACTIVE_TAXONOMY_RANK_ORDER: TaxonomyRank[] = [
  "genus",
  "family",
  "order",
  "class",
  "phylum",
  "superkingdom",
];

function collapseLabelForRank(
  entry: Partial<Record<TaxonomyRank, string>> | TaxonomyTipRanks,
  rank: TaxonomyRank,
): string | null {
  const direct = "ranks" in entry ? entry.ranks[rank] : entry[rank];
  if (direct) {
    return direct;
  }
  return "collapseFallbacks" in entry ? (entry.collapseFallbacks?.[rank]?.label ?? null) : null;
}

export function deriveCollapsibleTaxonomyRanks(
  tipRankEntries: Array<Partial<Record<TaxonomyRank, string>> | TaxonomyTipRanks>,
): TaxonomyRank[] {
  const rankToCounts = new Map<TaxonomyRank, Map<string, number>>();
  for (let index = 0; index < ACTIVE_TAXONOMY_RANK_ORDER.length; index += 1) {
    rankToCounts.set(ACTIVE_TAXONOMY_RANK_ORDER[index], new Map());
  }
  for (let entryIndex = 0; entryIndex < tipRankEntries.length; entryIndex += 1) {
    const entry = tipRankEntries[entryIndex];
    for (let rankIndex = 0; rankIndex < ACTIVE_TAXONOMY_RANK_ORDER.length; rankIndex += 1) {
      const rank = ACTIVE_TAXONOMY_RANK_ORDER[rankIndex];
      const label = collapseLabelForRank(entry, rank);
      if (!label) {
        continue;
      }
      const counts = rankToCounts.get(rank);
      if (counts) {
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
    }
  }
  return ACTIVE_TAXONOMY_RANK_ORDER.filter((rank) => {
    const counts = rankToCounts.get(rank);
    const distinctLabelCount = counts?.size ?? 0;
    let largestBlock = 0;
    counts?.forEach((count) => {
      if (count > largestBlock) {
        largestBlock = count;
      }
    });
    return distinctLabelCount > 1 && largestBlock > 1;
  });
}

export function deriveActiveTaxonomyRanks(
  tipRankEntries: Array<Partial<Record<TaxonomyRank, string>>>,
): TaxonomyRank[] {
  const rankToHits = new Map<TaxonomyRank, number>();
  const rankToCounts = new Map<TaxonomyRank, Map<string, number>>();
  for (let index = 0; index < ACTIVE_TAXONOMY_RANK_ORDER.length; index += 1) {
    const rank = ACTIVE_TAXONOMY_RANK_ORDER[index];
    rankToHits.set(rank, 0);
    rankToCounts.set(rank, new Map());
  }
  for (let entryIndex = 0; entryIndex < tipRankEntries.length; entryIndex += 1) {
    const entry = tipRankEntries[entryIndex];
    for (let rankIndex = 0; rankIndex < ACTIVE_TAXONOMY_RANK_ORDER.length; rankIndex += 1) {
      const rank = ACTIVE_TAXONOMY_RANK_ORDER[rankIndex];
      const label = entry[rank];
      if (!label) {
        continue;
      }
      rankToHits.set(rank, (rankToHits.get(rank) ?? 0) + 1);
      const counts = rankToCounts.get(rank);
      if (counts) {
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
    }
  }
  const activeRanks = deriveCollapsibleTaxonomyRanks(tipRankEntries);
  while (activeRanks.length > 1) {
    const topRank = activeRanks[activeRanks.length - 1];
    const counts = rankToCounts.get(topRank);
    const total = rankToHits.get(topRank) ?? 0;
    if (!counts || total <= 0) {
      break;
    }
    let dominant = 0;
    counts.forEach((count) => {
      if (count > dominant) {
        dominant = count;
      }
    });
    if ((dominant / total) > 0.8) {
      activeRanks.pop();
      continue;
    }
    break;
  }
  return activeRanks;
}
