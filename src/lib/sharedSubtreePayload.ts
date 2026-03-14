import type { TaxonomyMapPayload, TaxonomyRank } from "../types/taxonomy";
import type { TreeModel } from "../types/tree";
import { TAXONOMY_RANKS, type TaxonomyTipRanks } from "../types/taxonomy";
import { deriveActiveTaxonomyRanks } from "./taxonomyActiveRanks";

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
  version: 1;
  newick: string;
  taxonomy?: SharedSubtreeTaxonomyPayload;
};

export function parseSharedSubtreeStoragePayload(raw: string): SharedSubtreeStoragePayload {
  try {
    const parsed = JSON.parse(raw) as Partial<SharedSubtreeStoragePayload>;
    if (parsed && typeof parsed.newick === "string") {
      return {
        version: 1,
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
