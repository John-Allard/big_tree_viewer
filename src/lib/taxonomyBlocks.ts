import { TAXONOMY_RANKS, type TaxonomyBlock, type TaxonomyMapPayload, type TaxonomyRank } from "../types/taxonomy";

export type TaxonomyColorByRank = Partial<Record<TaxonomyRank, Record<string, string>>>;

export function taxonomyEntityKey(label: string, taxId?: number | null): string {
  return taxId ? `${label}::${taxId}` : label;
}

export function colorForTaxonomy(
  rank: TaxonomyRank,
  label: string,
  colorsByRank: TaxonomyColorByRank | null,
  taxId?: number | null,
): string {
  const entityKey = taxonomyEntityKey(label, taxId);
  const mapped = colorsByRank?.[rank]?.[entityKey];
  if (mapped) {
    return mapped;
  }
  let hash = 0;
  const key = `${rank}:${entityKey}`;
  for (let index = 0; index < key.length; index += 1) {
    hash = ((hash * 31) + key.charCodeAt(index)) >>> 0;
  }
  const hue = hash % 360;
  const saturation = rank === "genus" ? 58 : 52;
  const lightness = rank === "superkingdom" ? 72 : rank === "phylum" ? 66 : 60;
  return `hsl(${hue}deg ${saturation}% ${lightness}%)`;
}

function unwrapCircularIndices(indices: number[], leafCount: number): number[] {
  if (indices.length === 0) {
    return [];
  }
  const sorted = [...indices].sort((left, right) => left - right);
  if (sorted.length === 1) {
    return sorted;
  }
  let largestGap = -1;
  let largestGapIndex = 0;
  for (let index = 0; index < sorted.length; index += 1) {
    const current = sorted[index];
    const next = index + 1 < sorted.length ? sorted[index + 1] : sorted[0] + leafCount;
    const gap = next - current;
    if (gap > largestGap) {
      largestGap = gap;
      largestGapIndex = index;
    }
  }
  const startIndex = (largestGapIndex + 1) % sorted.length;
  const base = sorted[startIndex];
  const unwrapped: number[] = [];
  for (let offset = 0; offset < sorted.length; offset += 1) {
    let value = sorted[(startIndex + offset) % sorted.length];
    if (value < base) {
      value += leafCount;
    }
    unwrapped.push(value);
  }
  return unwrapped;
}

export function buildTaxonomyBlocksForOrderedLeaves(
  orderedLeaves: number[],
  taxonomyMap: TaxonomyMapPayload,
  colorsByRank: TaxonomyColorByRank | null,
): Record<TaxonomyRank, TaxonomyBlock[]> {
  const tipByNode = new Map<number, TaxonomyMapPayload["tipRanks"][number]>();
  for (let index = 0; index < taxonomyMap.tipRanks.length; index += 1) {
    tipByNode.set(taxonomyMap.tipRanks[index].node, taxonomyMap.tipRanks[index]);
  }
  const labelsByRank = TAXONOMY_RANKS.reduce<Record<TaxonomyRank, Map<string, {
    label: string;
    taxId: number | null;
    indices: number[];
  }>>>((accumulator, rank) => {
    const byLabel = new Map<string, {
      label: string;
      taxId: number | null;
      indices: number[];
    }>();
    for (let index = 0; index < orderedLeaves.length; index += 1) {
      const tip = tipByNode.get(orderedLeaves[index]);
      const label = tip?.ranks[rank] ?? null;
      if (!label) {
        continue;
      }
      const taxId = tip?.taxIds?.[rank] ?? null;
      const entityKey = taxonomyEntityKey(label, taxId);
      const existing = byLabel.get(entityKey);
      if (existing) {
        existing.indices.push(index);
      } else {
        byLabel.set(entityKey, { label, taxId, indices: [index] });
      }
    }
    accumulator[rank] = byLabel;
    return accumulator;
  }, {} as Record<TaxonomyRank, Map<string, {
    label: string;
    taxId: number | null;
    indices: number[];
  }>>);
  const blocks = TAXONOMY_RANKS.reduce<Record<TaxonomyRank, TaxonomyBlock[]>>((accumulator, rank) => {
    accumulator[rank] = [];
    return accumulator;
  }, {} as Record<TaxonomyRank, TaxonomyBlock[]>);
  for (let rankIndex = 0; rankIndex < TAXONOMY_RANKS.length; rankIndex += 1) {
    const rank = TAXONOMY_RANKS[rankIndex];
    const entries = [...labelsByRank[rank].entries()].sort((left, right) => left[1].indices[0] - right[1].indices[0]);
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
      const [entityKey, entry] = entries[entryIndex];
      const { label, taxId, indices } = entry;
      const unwrapped = unwrapCircularIndices(indices, orderedLeaves.length);
      if (unwrapped.length === 0) {
        continue;
      }
      let segmentStart = unwrapped[0];
      for (let index = 1; index <= unwrapped.length; index += 1) {
        const previous = unwrapped[index - 1];
        const next = index < unwrapped.length ? unwrapped[index] : Number.POSITIVE_INFINITY;
        if (index < unwrapped.length && next === previous + 1) {
          continue;
        }
        const segmentEnd = previous + 1;
        const segmentSpan = segmentEnd - segmentStart;
        const coversAllLeaves = segmentSpan >= orderedLeaves.length;
        const wrappedStartIndex = coversAllLeaves
          ? 0
          : ((segmentStart % orderedLeaves.length) + orderedLeaves.length) % orderedLeaves.length;
        const wrappedEndExclusive = coversAllLeaves
          ? orderedLeaves.length
          : ((segmentEnd % orderedLeaves.length) + orderedLeaves.length) % orderedLeaves.length;
        const wrappedEndIndex = wrappedEndExclusive === 0 ? orderedLeaves.length : wrappedEndExclusive;
        const lastIndex = coversAllLeaves
          ? orderedLeaves.length - 1
          : (wrappedEndIndex - 1 + orderedLeaves.length) % orderedLeaves.length;
        const centerIndex = Math.floor((segmentStart + segmentEnd - 1) * 0.5) % orderedLeaves.length;
        const segment = {
          firstNode: orderedLeaves[wrappedStartIndex],
          lastNode: orderedLeaves[lastIndex],
          startIndex: wrappedStartIndex,
          endIndex: wrappedEndIndex,
        };
        blocks[rank].push({
          rank,
          label,
          taxId,
          entityKey,
          firstNode: segment.firstNode,
          lastNode: segment.lastNode,
          centerNode: orderedLeaves[centerIndex],
          startIndex: segment.startIndex,
          endIndex: segment.endIndex,
          labelStartIndex: segment.startIndex,
          labelEndIndex: segment.endIndex,
          color: colorForTaxonomy(rank, label, colorsByRank, taxId),
          segments: [segment],
        });
        segmentStart = next;
      }
    }
    blocks[rank].sort((left, right) => (left.startIndex ?? 0) - (right.startIndex ?? 0));
  }
  return blocks;
}
