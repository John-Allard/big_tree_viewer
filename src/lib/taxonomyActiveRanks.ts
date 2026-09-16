import { isAutomaticTaxonomyRank, type TaxonomyRank, type TaxonomyTipRanks } from "../types/taxonomy";

export const ACTIVE_TAXONOMY_RANK_ORDER: TaxonomyRank[] = [
  "genus",
  "family",
  "order",
  "class",
  "phylum",
  "kingdom",
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
  const states = ACTIVE_TAXONOMY_RANK_ORDER.map(() => ({
    firstLabel: null as string | null,
    sawDifferentLabel: false,
    sawRepeatedLabel: false,
    seen: new Set<string>(),
  }));
  let unresolvedRankCount = states.length;
  for (let entryIndex = 0; entryIndex < tipRankEntries.length; entryIndex += 1) {
    const entry = tipRankEntries[entryIndex];
    for (let rankIndex = 0; rankIndex < ACTIVE_TAXONOMY_RANK_ORDER.length; rankIndex += 1) {
      const state = states[rankIndex];
      if (state.sawDifferentLabel && state.sawRepeatedLabel) {
        continue;
      }
      const rank = ACTIVE_TAXONOMY_RANK_ORDER[rankIndex];
      const label = collapseLabelForRank(entry, rank);
      if (!label) {
        continue;
      }
      if (state.firstLabel === null) {
        state.firstLabel = label;
      } else if (label !== state.firstLabel) {
        state.sawDifferentLabel = true;
      }
      if (!state.sawRepeatedLabel) {
        if (state.seen.has(label)) {
          state.sawRepeatedLabel = true;
          state.seen.clear();
        } else {
          state.seen.add(label);
        }
      }
      if (state.sawDifferentLabel && state.sawRepeatedLabel) {
        unresolvedRankCount -= 1;
      }
    }
    if (unresolvedRankCount === 0) {
      break;
    }
  }
  return ACTIVE_TAXONOMY_RANK_ORDER.filter((_, index) => (
    states[index].sawDifferentLabel && states[index].sawRepeatedLabel
  ));
}

export function deriveActiveTaxonomyRanks(
  tipRankEntries: Array<Partial<Record<TaxonomyRank, string>>>,
): TaxonomyRank[] {
  // Rank availability describes the data, not the relative abundance of its groups.
  // Automatic ribbon visibility decides which available ranks to show at each zoom.
  return deriveCollapsibleTaxonomyRanks(tipRankEntries);
}

export function deriveDefaultVisibleTaxonomyRanks(
  tipRankEntries: Array<Partial<Record<TaxonomyRank, string>>>,
  availableRanks: TaxonomyRank[] = deriveActiveTaxonomyRanks(tipRankEntries),
): TaxonomyRank[] {
  const defaultRanks = availableRanks.filter(isAutomaticTaxonomyRank);
  while (defaultRanks.length > 1) {
    const topRank = defaultRanks[defaultRanks.length - 1];
    const counts = new Map<string, number>();
    for (let index = 0; index < tipRankEntries.length; index += 1) {
      const label = tipRankEntries[index][topRank];
      if (label) {
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
    }
    const total = Array.from(counts.values()).reduce((sum, count) => sum + count, 0);
    const dominant = counts.size > 0 ? Math.max(...counts.values()) : 0;
    if (total > 0 && (dominant / total) > 0.8) {
      defaultRanks.pop();
      continue;
    }
    break;
  }
  return defaultRanks;
}
