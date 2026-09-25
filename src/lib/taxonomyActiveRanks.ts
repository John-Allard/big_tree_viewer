import { isAutomaticTaxonomyRank, TAXONOMY_RANKS, type TaxonomyMapPayload, type TaxonomyRank, type TaxonomyTipRanks } from "../types/taxonomy";

export const ACTIVE_TAXONOMY_RANK_ORDER: TaxonomyRank[] = [...TAXONOMY_RANKS].reverse();

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

export function filterTaxonomyMapToRanks(
  taxonomyMap: TaxonomyMapPayload | null,
  includedRanks: readonly TaxonomyRank[],
): TaxonomyMapPayload | null {
  if (!taxonomyMap) {
    return null;
  }
  const included = new Set(includedRanks);
  const filterRecord = <T>(record: Partial<Record<TaxonomyRank, T>> | undefined): Partial<Record<TaxonomyRank, T>> | undefined => {
    if (!record) {
      return undefined;
    }
    const filtered: Partial<Record<TaxonomyRank, T>> = {};
    for (const rank of TAXONOMY_RANKS) {
      if (included.has(rank) && record[rank] !== undefined) {
        filtered[rank] = record[rank];
      }
    }
    return Object.keys(filtered).length > 0 ? filtered : undefined;
  };
  const tipRanks = taxonomyMap.tipRanks.map((tip) => ({
    node: tip.node,
    sourceTaxId: tip.sourceTaxId,
    ranks: filterRecord(tip.ranks) ?? {},
    taxIds: filterRecord(tip.taxIds),
    collapseFallbacks: filterRecord(tip.collapseFallbacks),
  }));
  const activeRanks = deriveActiveTaxonomyRanks(tipRanks.map((tip) => tip.ranks));
  const resolvedSource = taxonomyMap.resolvedRanks ?? taxonomyMap.activeRanks;
  return {
    ...taxonomyMap,
    resolvedRanks: TAXONOMY_RANKS.filter((rank) => included.has(rank) && resolvedSource.includes(rank)),
    activeRanks,
    tipRanks,
  };
}
