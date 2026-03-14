import type { TaxonomyRank } from "../types/taxonomy";

const ACTIVE_TAXONOMY_RANK_ORDER: TaxonomyRank[] = [
  "genus",
  "family",
  "order",
  "class",
  "phylum",
  "superkingdom",
];

export function deriveActiveTaxonomyRanks(
  tipRankEntries: Array<Partial<Record<TaxonomyRank, string>>>,
): TaxonomyRank[] {
  const rankToLabels = new Map<TaxonomyRank, Set<string>>();
  const rankToHits = new Map<TaxonomyRank, number>();
  const rankToCounts = new Map<TaxonomyRank, Map<string, number>>();
  for (let index = 0; index < ACTIVE_TAXONOMY_RANK_ORDER.length; index += 1) {
    const rank = ACTIVE_TAXONOMY_RANK_ORDER[index];
    rankToLabels.set(rank, new Set());
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
      rankToLabels.get(rank)?.add(label);
      rankToHits.set(rank, (rankToHits.get(rank) ?? 0) + 1);
      const counts = rankToCounts.get(rank);
      if (counts) {
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
    }
  }
  const activeRanks = ACTIVE_TAXONOMY_RANK_ORDER.filter((rank) => (rankToLabels.get(rank)?.size ?? 0) > 1);
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
