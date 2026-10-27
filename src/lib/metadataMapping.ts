import { TAXONOMY_RANKS, type TaxonomyMapPayload, type TaxonomyRank, type TaxonomyTipRanks } from "../types/taxonomy";
import type { TreeModel } from "../types/tree";

type MappingTree = Pick<TreeModel, "nodeCount" | "names" | "leafNodes">;
type MetadataRows = ReadonlyArray<Readonly<Record<string, string>>>;

export interface MetadataTaxonomyMapPayload extends TaxonomyMapPayload {
  mappingOrigin: "metadata-ranks";
  metadataRankColumns: Partial<Record<TaxonomyRank, string>>;
}

// Keep key matching identical to metadataColors, without normalizing display values.
function normalizeKey(value: string): string {
  return value.trim().replace(/^['"]+|['"]+$/g, "").replaceAll("_", " ").replace(/\s+/g, " ").toLowerCase();
}

function indexRows(rows: MetadataRows, keyColumn: string, columns: readonly string[]): Map<string, string[]> {
  const indexed = new Map<string, string[]>();
  if (!keyColumn) return indexed;
  for (let index = 0; index < rows.length; index += 1) {
    const key = normalizeKey(rows[index][keyColumn] ?? "");
    if (!key) continue;
    const values = columns.map((column) => (rows[index][column] ?? "").trim());
    const previous = indexed.get(key);
    if (previous && previous.some((value, column) => value !== values[column])) {
      throw new Error(`Conflicting metadata rows for key "${key}" at data row ${index + 1}.`);
    }
    indexed.set(key, values);
  }
  return indexed;
}

/** Null entries let the caller fall back to original IDs; tree.names is never changed. */
export function buildMetadataTipDisplayLabels(
  tree: MappingTree,
  rows: MetadataRows,
  keyColumn: string,
  valueColumn: string,
): Array<string | null> {
  const labels = new Array<string | null>(tree.nodeCount).fill(null);
  const indexed = indexRows(rows, keyColumn, valueColumn ? [valueColumn] : []);
  if (!valueColumn) return labels;
  for (const node of tree.leafNodes) {
    labels[node] = indexed.get(normalizeKey(tree.names[node] ?? ""))?.[0] || null;
  }
  return labels;
}

/** Include every tip, using empty names rather than scientific-name fallback. */
export function buildMetadataTaxIdTips(
  tree: MappingTree,
  rows: MetadataRows,
  keyColumn: string,
  valueColumn: string,
): Array<{ node: number; name: string }> {
  const indexed = indexRows(rows, keyColumn, valueColumn ? [valueColumn] : []);
  const names = new Map<string, string>();
  for (const [key, values] of indexed) {
    const value = values[0] ?? "";
    if (!value) continue;
    const taxId = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(taxId) || taxId <= 0) {
      throw new Error(`Invalid NCBI taxid "${value}" for metadata key "${key}"; expected a positive integer.`);
    }
    names.set(key, `taxid=${taxId}`);
  }
  return Array.from(tree.leafNodes, (node) => ({
    node,
    name: names.get(normalizeKey(tree.names[node] ?? "")) ?? "",
  }));
}

function syntheticTaxId(key: string): number {
  // A negative 52-bit hash avoids NCBI IDs and remains an exact JSON-safe integer.
  let low = 2166136261;
  let high = 5381;
  for (let index = 0; index < key.length; index += 1) {
    low = Math.imul(low ^ key.charCodeAt(index), 16777619);
    high = Math.imul(high, 33) ^ key.charCodeAt(index);
  }
  return -(((high & 0xfffff) * 0x100000000) + (low >>> 0) + 1);
}

export function buildMetadataTaxonomyMap(
  tree: MappingTree,
  rows: MetadataRows,
  keyColumn: string,
  rankColumns: Partial<Record<TaxonomyRank, string>>,
): MetadataTaxonomyMapPayload {
  for (const rank of Object.keys(rankColumns)) {
    if (!(TAXONOMY_RANKS as readonly string[]).includes(rank)) {
      throw new Error(`Unsupported metadata taxonomy rank "${rank}".`);
    }
  }
  const selectedRanks = TAXONOMY_RANKS.filter((rank) => Boolean(rankColumns[rank]?.trim()));
  const metadataRankColumns: Partial<Record<TaxonomyRank, string>> = {};
  const columns = selectedRanks.map((rank) => {
    const column = rankColumns[rank]!;
    metadataRankColumns[rank] = column;
    return column;
  });
  const indexed = indexRows(rows, keyColumn, columns);
  const tipRanks: TaxonomyTipRanks[] = [];
  const keysByTip: Array<Partial<Record<TaxonomyRank, string>>> = [];
  const entityKeys = new Set<string>();
  const populatedRanks = new Set<TaxonomyRank>();
  for (const node of tree.leafNodes) {
    const values = indexed.get(normalizeKey(tree.names[node] ?? ""));
    if (!values) continue;
    const ranks: TaxonomyTipRanks["ranks"] = {};
    const keys: Partial<Record<TaxonomyRank, string>> = {};
    const lineage: Array<[TaxonomyRank, string]> = [];
    for (let index = 0; index < selectedRanks.length; index += 1) {
      const rank = selectedRanks[index];
      const label = values[index];
      // Missing ancestors remain explicit so incomplete lineages cannot merge homonyms.
      lineage.push([rank, label]);
      if (!label) continue;
      ranks[rank] = label;
      const key = JSON.stringify(lineage);
      keys[rank] = key;
      entityKeys.add(key);
      populatedRanks.add(rank);
    }
    if (Object.keys(ranks).length === 0) continue;
    tipRanks.push({ node, ranks });
    keysByTip.push(keys);
  }

  // Resolve even hash collisions deterministically, independent of row/tip order.
  const ids = new Map<string, number>();
  const usedIds = new Set<number>();
  for (const key of [...entityKeys].sort()) {
    let id = syntheticTaxId(key);
    while (usedIds.has(id)) id -= 1;
    ids.set(key, id);
    usedIds.add(id);
  }
  for (let index = 0; index < tipRanks.length; index += 1) {
    const taxIds: NonNullable<TaxonomyTipRanks["taxIds"]> = {};
    for (const rank of selectedRanks) {
      const key = keysByTip[index][rank];
      if (key !== undefined) taxIds[rank] = ids.get(key)!;
    }
    tipRanks[index].taxIds = taxIds;
  }
  return {
    mappingOrigin: "metadata-ranks",
    metadataRankColumns,
    mappedCount: tipRanks.length,
    totalTips: tree.leafNodes.length,
    resolvedRanks: [...selectedRanks],
    activeRanks: selectedRanks.filter((rank) => populatedRanks.has(rank)).reverse(),
    tipRanks,
  };
}
