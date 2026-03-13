import { TAXONOMY_RANKS, type TaxonomyBlock, type TaxonomyMapPayload, type TaxonomyRank } from "../types/taxonomy";

export type TaxonomyColorByRank = Partial<Record<TaxonomyRank, Record<string, string>>>;

export function colorForTaxonomy(rank: TaxonomyRank, label: string, colorsByRank: TaxonomyColorByRank | null): string {
  const mapped = colorsByRank?.[rank]?.[label];
  if (mapped) {
    return mapped;
  }
  let hash = 0;
  const key = `${rank}:${label}`;
  for (let index = 0; index < key.length; index += 1) {
    hash = ((hash * 31) + key.charCodeAt(index)) >>> 0;
  }
  const hue = hash % 360;
  const saturation = rank === "genus" ? 58 : 52;
  const lightness = rank === "superkingdom" ? 72 : rank === "phylum" ? 66 : 60;
  return `hsl(${hue}deg ${saturation}% ${lightness}%)`;
}

function orderedLeafSpanThreshold(leafCount: number): number {
  const minSpan = (Math.PI * 2) / Math.max(1, leafCount);
  return Math.max(2.5, 0.01 / Math.max(minSpan, 1e-9));
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
  const labelByNode = new Map<number, Partial<Record<TaxonomyRank, string>>>();
  for (let index = 0; index < taxonomyMap.tipRanks.length; index += 1) {
    labelByNode.set(taxonomyMap.tipRanks[index].node, taxonomyMap.tipRanks[index].ranks);
  }
  const labelsByRank = TAXONOMY_RANKS.reduce<Record<TaxonomyRank, Record<string, number[]>>>((accumulator, rank) => {
    const byLabel: Record<string, number[]> = {};
    for (let index = 0; index < orderedLeaves.length; index += 1) {
      const label = labelByNode.get(orderedLeaves[index])?.[rank] ?? null;
      if (!label) {
        continue;
      }
      if (!byLabel[label]) {
        byLabel[label] = [];
      }
      byLabel[label].push(index);
    }
    accumulator[rank] = byLabel;
    return accumulator;
  }, {} as Record<TaxonomyRank, Record<string, number[]>>);
  const blocks = TAXONOMY_RANKS.reduce<Record<TaxonomyRank, TaxonomyBlock[]>>((accumulator, rank) => {
    accumulator[rank] = [];
    return accumulator;
  }, {} as Record<TaxonomyRank, TaxonomyBlock[]>);
  for (let rankIndex = 0; rankIndex < TAXONOMY_RANKS.length; rankIndex += 1) {
    const rank = TAXONOMY_RANKS[rankIndex];
    const breakThreshold = orderedLeafSpanThreshold(orderedLeaves.length);
    const entries = Object.entries(labelsByRank[rank]).sort((left, right) => left[1][0] - right[1][0]);
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
      const [label, indices] = entries[entryIndex];
      const unwrapped = unwrapCircularIndices(indices, orderedLeaves.length);
      if (unwrapped.length === 0) {
        continue;
      }
      const segments: Array<{ firstNode: number; lastNode: number; startIndex: number; endIndex: number }> = [];
      let segmentStart = unwrapped[0];
      let currentSegmentSize = 1;
      let bestSegmentStart = unwrapped[0];
      let bestSegmentEnd = unwrapped[0] + 1;
      let bestSegmentSize = 1;
      let bestSpan = 1;
      for (let index = 1; index <= unwrapped.length; index += 1) {
        const previous = unwrapped[index - 1];
        const next = index < unwrapped.length ? unwrapped[index] : Number.POSITIVE_INFINITY;
        const gap = next - previous;
        if (index < unwrapped.length && gap <= breakThreshold) {
          currentSegmentSize += 1;
          continue;
        }
        const segmentEnd = previous + 1;
        const wrappedStartIndex = ((segmentStart % orderedLeaves.length) + orderedLeaves.length) % orderedLeaves.length;
        const wrappedEndExclusive = ((segmentEnd % orderedLeaves.length) + orderedLeaves.length) % orderedLeaves.length;
        const wrappedEndIndex = wrappedEndExclusive === 0 ? orderedLeaves.length : wrappedEndExclusive;
        const lastIndex = (wrappedEndIndex - 1 + orderedLeaves.length) % orderedLeaves.length;
        segments.push({
          firstNode: orderedLeaves[wrappedStartIndex],
          lastNode: orderedLeaves[lastIndex],
          startIndex: wrappedStartIndex,
          endIndex: wrappedEndIndex,
        });
        const span = segmentEnd - segmentStart;
        if (span > bestSpan || (span === bestSpan && currentSegmentSize > bestSegmentSize)) {
          bestSpan = span;
          bestSegmentSize = currentSegmentSize;
          bestSegmentStart = segmentStart;
          bestSegmentEnd = segmentEnd;
        }
        segmentStart = next;
        currentSegmentSize = 1;
      }
      const overallStart = unwrapped[0];
      const overallEnd = unwrapped[unwrapped.length - 1] + 1;
      const wrappedOverallStart = ((overallStart % orderedLeaves.length) + orderedLeaves.length) % orderedLeaves.length;
      const wrappedOverallEndExclusive = ((overallEnd % orderedLeaves.length) + orderedLeaves.length) % orderedLeaves.length;
      const wrappedOverallEnd = wrappedOverallEndExclusive === 0 ? orderedLeaves.length : wrappedOverallEndExclusive;
      const overallLastIndex = (wrappedOverallEnd - 1 + orderedLeaves.length) % orderedLeaves.length;
      const centerIndex = Math.floor((overallStart + overallEnd - 1) * 0.5) % orderedLeaves.length;
      blocks[rank].push({
        rank,
        label,
        firstNode: orderedLeaves[wrappedOverallStart],
        lastNode: orderedLeaves[overallLastIndex],
        centerNode: orderedLeaves[centerIndex],
        startIndex: wrappedOverallStart,
        endIndex: wrappedOverallEnd,
        labelStartIndex: ((bestSegmentStart % orderedLeaves.length) + orderedLeaves.length) % orderedLeaves.length,
        labelEndIndex: (((bestSegmentEnd % orderedLeaves.length) + orderedLeaves.length) % orderedLeaves.length) || orderedLeaves.length,
        color: colorForTaxonomy(rank, label, colorsByRank),
        segments,
      });
    }
  }
  return blocks;
}
