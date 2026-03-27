import { deriveActiveTaxonomyRanks } from "./taxonomyActiveRanks";
import type { TaxonomyMapPayload, TaxonomyRank } from "../types/taxonomy";

export type TaxonomyNodeInfo = { parentId: number; rank: string };

export type ParsedTaxonomyForMapping = {
  nodes: Map<number, TaxonomyNodeInfo>;
  rankNames: Map<number, string>;
  speciesIndex: Map<string, number[]>;
  genusIndex: Map<string, number[]>;
};

export type TipTaxonomyRequest = {
  node: number;
  name: string;
};

type ResolvedTipMapping = {
  node: number;
  ranks: Partial<Record<TaxonomyRank, string>>;
  taxIds: Partial<Record<TaxonomyRank, number>>;
};

type CandidateLineage = {
  taxId: number;
  ranks: Partial<Record<TaxonomyRank, string>>;
  taxIds: Partial<Record<TaxonomyRank, number>>;
};

const CONTEXT_RANK_WEIGHTS: Array<[TaxonomyRank, number]> = [
  ["superkingdom", 64],
  ["phylum", 32],
  ["class", 16],
  ["order", 8],
  ["family", 4],
  ["genus", 2],
];

export function normalizeTaxonomyName(name: string): string {
  return name.trim().toLowerCase().replaceAll("_", " ");
}

export function addTaxonomyIndexEntry(index: Map<string, number[]>, name: string, taxId: number): void {
  const existing = index.get(name);
  if (existing) {
    if (!existing.includes(taxId)) {
      existing.push(taxId);
    }
    return;
  }
  index.set(name, [taxId]);
}

function candidateSpeciesNames(name: string): string[] {
  const normalized = normalizeTaxonomyName(name).replaceAll("|", " ").replaceAll(";", " ").replaceAll(",", " ");
  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return [];
  }
  const candidates = [parts.join(" "), parts.join("_")];
  if (parts.length >= 2) {
    const twoPart = `${parts[0]} ${parts[1]}`;
    candidates.push(twoPart, twoPart.replaceAll(" ", "_"));
  }
  return [...new Set(candidates)];
}

function extractGenus(name: string): string {
  const parts = normalizeTaxonomyName(name).split(/\s+/).filter(Boolean);
  return parts[0] ?? "";
}

function ancestorAtRank(
  taxId: number,
  rank: TaxonomyRank,
  taxonomy: ParsedTaxonomyForMapping,
  memo: Map<string, number | null>,
): number | null {
  const key = `${taxId}:${rank}`;
  if (memo.has(key)) {
    return memo.get(key) ?? null;
  }
  let current = taxId;
  const seen = new Set<number>();
  while (current > 0 && !seen.has(current)) {
    seen.add(current);
    const node = taxonomy.nodes.get(current);
    if (!node) {
      break;
    }
    if (node.rank === rank) {
      memo.set(key, current);
      return current;
    }
    current = node.parentId;
  }
  memo.set(key, null);
  return null;
}

function buildCandidateLineage(
  taxId: number,
  taxonomy: ParsedTaxonomyForMapping,
  targetRanks: TaxonomyRank[],
  ancestorMemo: Map<string, number | null>,
  lineageMemo: Map<number, CandidateLineage | null>,
): CandidateLineage | null {
  const cached = lineageMemo.get(taxId);
  if (cached !== undefined) {
    return cached;
  }
  const ranks: Partial<Record<TaxonomyRank, string>> = {};
  const taxIds: Partial<Record<TaxonomyRank, number>> = {};
  let anyRank = false;
  for (let rankIndex = 0; rankIndex < targetRanks.length; rankIndex += 1) {
    const rank = targetRanks[rankIndex];
    const ancestor = ancestorAtRank(taxId, rank, taxonomy, ancestorMemo);
    if (!ancestor) {
      continue;
    }
    const label = taxonomy.rankNames.get(ancestor);
    if (!label) {
      continue;
    }
    ranks[rank] = label;
    taxIds[rank] = ancestor;
    anyRank = true;
  }
  const lineage = anyRank ? { taxId, ranks, taxIds } : null;
  lineageMemo.set(taxId, lineage);
  return lineage;
}

function scoreCandidateAgainstResolvedNeighbors(
  candidate: CandidateLineage,
  tipIndex: number,
  resolved: Array<ResolvedTipMapping | null>,
): number {
  let score = 0;
  let seenResolved = 0;
  for (let radius = 1; radius <= 48 && seenResolved < 12; radius += 1) {
    const candidateIndices = [tipIndex - radius, tipIndex + radius];
    for (let indexOffset = 0; indexOffset < candidateIndices.length; indexOffset += 1) {
      const neighborIndex = candidateIndices[indexOffset];
      if (neighborIndex < 0 || neighborIndex >= resolved.length) {
        continue;
      }
      const neighbor = resolved[neighborIndex];
      if (!neighbor) {
        continue;
      }
      seenResolved += 1;
      const distanceWeight = 1 / (1 + (radius * 0.5));
      for (let rankIndex = 0; rankIndex < CONTEXT_RANK_WEIGHTS.length; rankIndex += 1) {
        const [rank, rankWeight] = CONTEXT_RANK_WEIGHTS[rankIndex];
        const candidateTaxId = candidate.taxIds[rank];
        const neighborTaxId = neighbor.taxIds[rank];
        if (!candidateTaxId || !neighborTaxId) {
          continue;
        }
        if (candidateTaxId === neighborTaxId) {
          score += rankWeight * distanceWeight;
        }
      }
    }
  }
  return score;
}

function lineagesEquivalent(left: CandidateLineage, right: CandidateLineage, targetRanks: TaxonomyRank[]): boolean {
  for (let rankIndex = 0; rankIndex < targetRanks.length; rankIndex += 1) {
    const rank = targetRanks[rankIndex];
    if ((left.taxIds[rank] ?? null) !== (right.taxIds[rank] ?? null)) {
      return false;
    }
  }
  return true;
}

function collectCandidatesForTip(
  tip: TipTaxonomyRequest,
  taxonomy: ParsedTaxonomyForMapping,
  targetRanks: TaxonomyRank[],
  ancestorMemo: Map<string, number | null>,
  lineageMemo: Map<number, CandidateLineage | null>,
): CandidateLineage[] {
  const speciesCandidates = candidateSpeciesNames(tip.name)
    .flatMap((candidate) => taxonomy.speciesIndex.get(candidate) ?? []);
  const genusCandidates = speciesCandidates.length > 0
    ? []
    : [...(taxonomy.genusIndex.get(extractGenus(tip.name)) ?? [])];
  const source = speciesCandidates.length > 0 ? speciesCandidates : genusCandidates;
  const unique = [...new Set(source)];
  const candidates: CandidateLineage[] = [];
  for (let index = 0; index < unique.length; index += 1) {
    const lineage = buildCandidateLineage(unique[index], taxonomy, targetRanks, ancestorMemo, lineageMemo);
    if (lineage) {
      candidates.push(lineage);
    }
  }
  return candidates;
}

export function mapTipsWithContext(
  tips: TipTaxonomyRequest[],
  taxonomy: ParsedTaxonomyForMapping,
  targetRanks: TaxonomyRank[],
  mappingVersion: number,
): TaxonomyMapPayload {
  const ancestorMemo = new Map<string, number | null>();
  const lineageMemo = new Map<number, CandidateLineage | null>();
  const candidatesByTip = tips.map((tip) => collectCandidatesForTip(tip, taxonomy, targetRanks, ancestorMemo, lineageMemo));
  const resolved: Array<ResolvedTipMapping | null> = new Array(tips.length).fill(null);

  for (let index = 0; index < tips.length; index += 1) {
    const candidates = candidatesByTip[index];
    if (candidates.length === 1) {
      resolved[index] = {
        node: tips[index].node,
        ranks: candidates[0].ranks,
        taxIds: candidates[0].taxIds,
      };
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < tips.length; index += 1) {
      if (resolved[index]) {
        continue;
      }
      const candidates = candidatesByTip[index];
      if (candidates.length <= 1) {
        continue;
      }
      let best: CandidateLineage | null = null;
      let bestScore = 0;
      let secondBestScore = 0;
      for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
        const candidate = candidates[candidateIndex];
        const score = scoreCandidateAgainstResolvedNeighbors(candidate, index, resolved);
        if (score > bestScore) {
          secondBestScore = bestScore;
          bestScore = score;
          best = candidate;
        } else if (score > secondBestScore) {
          secondBestScore = score;
        }
      }
      if (best && bestScore > 0 && (bestScore - secondBestScore) > 1e-6) {
        resolved[index] = {
          node: tips[index].node,
          ranks: best.ranks,
          taxIds: best.taxIds,
        };
        changed = true;
      }
    }
  }

  const tipRanks: TaxonomyMapPayload["tipRanks"] = [];
  for (let index = 0; index < tips.length; index += 1) {
    const direct = resolved[index];
    if (direct) {
      tipRanks.push(direct);
      continue;
    }
    const candidates = candidatesByTip[index];
    if (candidates.length === 0) {
      continue;
    }
    let equivalent = true;
    for (let candidateIndex = 1; candidateIndex < candidates.length; candidateIndex += 1) {
      if (!lineagesEquivalent(candidates[0], candidates[candidateIndex], targetRanks)) {
        equivalent = false;
        break;
      }
    }
    if (!equivalent) {
      continue;
    }
    tipRanks.push({
      node: tips[index].node,
      ranks: candidates[0].ranks,
      taxIds: candidates[0].taxIds,
    });
  }

  return {
    version: mappingVersion,
    mappedCount: tipRanks.length,
    totalTips: tips.length,
    activeRanks: deriveActiveTaxonomyRanks(tipRanks.map((tip) => tip.ranks)),
    tipRanks,
  };
}
