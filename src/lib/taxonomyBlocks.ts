import {
  TAXONOMY_RANKS,
  type TaxonomyBlock,
  type TaxonomyMapPayload,
  type TaxonomyRank,
  type TaxonomyTipRanks,
} from "../types/taxonomy";

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
  const lightness = rank === "superkingdom" ? 72 : rank === "kingdom" ? 69 : rank === "phylum" ? 66 : 60;
  return `hsl(${hue}deg ${saturation}% ${lightness}%)`;
}

function orderedLeafSpanThreshold(leafCount: number): number {
  const minSpan = (Math.PI * 2) / Math.max(1, leafCount);
  return Math.max(2.5, 0.01 / Math.max(minSpan, 1e-9));
}

export function buildTaxonomyBlocksForOrderedLeaves(
  orderedLeaves: number[],
  taxonomyMap: TaxonomyMapPayload,
  colorsByRank: TaxonomyColorByRank | null,
  indexedTips?: Array<TaxonomyTipRanks | undefined>,
): Record<TaxonomyRank, TaxonomyBlock[]> {
  let tipByNode = indexedTips;
  if (!tipByNode) {
    const maxNode = orderedLeaves.reduce((maximum, node) => Math.max(maximum, node), -1);
    tipByNode = new Array<TaxonomyTipRanks | undefined>(maxNode + 1);
    for (let index = 0; index < taxonomyMap.tipRanks.length; index += 1) {
      const tip = taxonomyMap.tipRanks[index];
      if (tip.node >= 0 && tip.node <= maxNode) {
        tipByNode[tip.node] = tip;
      }
    }
  }
  const blocks = TAXONOMY_RANKS.reduce<Record<TaxonomyRank, TaxonomyBlock[]>>((accumulator, rank) => {
    accumulator[rank] = [];
    return accumulator;
  }, {} as Record<TaxonomyRank, TaxonomyBlock[]>);
  const assignments = new Array<{
    entityKey: string;
    label: string;
    taxId: number | null;
  } | null>(orderedLeaves.length).fill(null);

  for (let rankIndex = 0; rankIndex < TAXONOMY_RANKS.length; rankIndex += 1) {
    const rank = TAXONOMY_RANKS[rankIndex];
    assignments.fill(null);
    let mappedCount = 0;
    let firstMappedIndex = -1;
    let firstAssignment: NonNullable<typeof assignments[number]> | null = null;
    let previousMappedIndex = -1;
    let previousAssignment: NonNullable<typeof assignments[number]> | null = null;
    for (let index = 0; index < orderedLeaves.length; index += 1) {
      const tip = tipByNode[orderedLeaves[index]];
      const label = tip?.ranks[rank] ?? null;
      if (!label) {
        continue;
      }
      const taxId = tip?.taxIds?.[rank] ?? null;
      const entityKey = taxonomyEntityKey(label, taxId);
      const assignment = { entityKey, label, taxId };
      if (mappedCount === 0) {
        firstMappedIndex = index;
        firstAssignment = assignment;
      } else if (entityKey === previousAssignment?.entityKey && index > previousMappedIndex + 1) {
        for (let fillIndex = previousMappedIndex + 1; fillIndex < index; fillIndex += 1) {
          assignments[fillIndex] = previousAssignment;
        }
      }
      assignments[index] = assignment;
      mappedCount += 1;
      previousMappedIndex = index;
      previousAssignment = assignment;
    }
    const circularGap = firstMappedIndex >= 0
      ? firstMappedIndex + orderedLeaves.length - previousMappedIndex
      : Number.POSITIVE_INFINITY;
    if (
      mappedCount >= 2
      && firstAssignment?.entityKey === previousAssignment?.entityKey
      && circularGap <= orderedLeafSpanThreshold(orderedLeaves.length)
    ) {
      for (let fillIndex = previousMappedIndex + 1; fillIndex < orderedLeaves.length; fillIndex += 1) {
        assignments[fillIndex] = previousAssignment;
      }
      for (let fillIndex = 0; fillIndex < firstMappedIndex; fillIndex += 1) {
        assignments[fillIndex] = firstAssignment;
      }
    }

    if (mappedCount === 0) {
      continue;
    }
    let scanStart = 0;
    const boundaryFirst = assignments[0];
    const boundaryLast = assignments[orderedLeaves.length - 1];
    if (
      boundaryFirst
      && boundaryLast
      && boundaryFirst.entityKey === boundaryLast.entityKey
    ) {
      while (
        scanStart < orderedLeaves.length
        && assignments[scanStart]?.entityKey === boundaryFirst.entityKey
      ) {
        scanStart += 1;
      }
      if (scanStart === orderedLeaves.length) {
        scanStart = 0;
      }
    }
    let offset = 0;
    while (offset < orderedLeaves.length) {
      const startOffset = offset;
      const startIndex = (scanStart + offset) % orderedLeaves.length;
      const assignment = assignments[startIndex];
      offset += 1;
      while (
        offset < orderedLeaves.length
        && assignments[(scanStart + offset) % orderedLeaves.length]?.entityKey === assignment?.entityKey
      ) {
        offset += 1;
      }
      if (!assignment) {
        continue;
      }
      const span = offset - startOffset;
      const coversAllLeaves = span >= orderedLeaves.length;
      const rawEndIndex = scanStart + offset;
      const endIndex = coversAllLeaves
        ? orderedLeaves.length
        : rawEndIndex <= orderedLeaves.length
          ? rawEndIndex
          : rawEndIndex % orderedLeaves.length;
      const lastIndex = (startIndex + span - 1) % orderedLeaves.length;
      const centerIndex = (startIndex + Math.floor((span - 1) * 0.5)) % orderedLeaves.length;
      const segment = {
        firstNode: orderedLeaves[startIndex],
        lastNode: orderedLeaves[lastIndex],
        startIndex,
        endIndex,
      };
      blocks[rank].push({
        rank,
        label: assignment.label,
        taxId: assignment.taxId,
        entityKey: assignment.entityKey,
        firstNode: segment.firstNode,
        lastNode: segment.lastNode,
        centerNode: orderedLeaves[centerIndex],
        startIndex: segment.startIndex,
        endIndex: segment.endIndex,
        labelStartIndex: segment.startIndex,
        labelEndIndex: segment.endIndex,
        color: colorForTaxonomy(rank, assignment.label, colorsByRank, assignment.taxId),
        segments: [segment],
      });
    }
    blocks[rank].sort((left, right) => (left.startIndex ?? 0) - (right.startIndex ?? 0));
  }
  return blocks;
}
