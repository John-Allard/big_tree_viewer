import { deriveActiveTaxonomyRanks } from "./taxonomyActiveRanks";
import type { TaxonomyCollapseFallback, TaxonomyIdentifierMode, TaxonomyMapPayload, TaxonomyRank } from "../types/taxonomy";

export type TaxonomyNodeInfo = { parentId: number; rank: string };

export type ParsedTaxonomyForMapping = {
  nodes: Map<number, TaxonomyNodeInfo>;
  rankNames: Map<number, string>;
  speciesIndex: Map<string, number[]>;
  speciesEpithetIndex?: Map<string, number[]>;
  genusIndex: Map<string, number[]>;
  contextualGenusIndex?: Map<string, number[]>;
  namedTaxonIndex: Map<string, number[]>;
};

export const TAXONOMY_SPECIES_INDEX_NAME_CLASSES = new Set<string>([
  "scientific name",
  "synonym",
]);

export const TAXONOMY_SPECIES_INDEX_RANKS = new Set<string>([
  "species",
  "subspecies",
  "varietas",
  "forma",
]);

const TAXONOMY_COLLAPSE_RANK_PRECEDENCE = new Map<string, number>([
  ["superkingdom", 0],
  ["kingdom", 5],
  ["subkingdom", 6],
  ["infrakingdom", 7],
  ["superphylum", 10],
  ["phylum", 20],
  ["subphylum", 21],
  ["infraphylum", 22],
  ["superclass", 30],
  ["class", 40],
  ["subclass", 41],
  ["infraclass", 42],
  ["cohort", 43],
  ["subcohort", 44],
  ["superorder", 50],
  ["order", 60],
  ["suborder", 61],
  ["infraorder", 62],
  ["parvorder", 63],
  ["superfamily", 70],
  ["family", 80],
  ["subfamily", 81],
  ["tribe", 82],
  ["subtribe", 83],
  ["genus", 90],
  ["subgenus", 91],
  ["section", 92],
  ["subsection", 93],
  ["series", 94],
  ["subseries", 95],
  ["species group", 96],
  ["species subgroup", 97],
  ["species", 100],
  ["subspecies", 101],
  ["varietas", 102],
  ["forma", 103],
]);

export const TAXONOMY_NAMED_LINEAGE_RANKS = new Set<string>(TAXONOMY_COLLAPSE_RANK_PRECEDENCE.keys());

export type TipTaxonomyRequest = {
  node: number;
  name: string;
};

export interface TaxonomyMappingOptions {
  enableCollapseFallbacks?: boolean;
  identifierMode?: TaxonomyIdentifierMode;
  rejectEmbeddedBroadRankRuns?: boolean;
  requireContextForGenusFallback?: boolean;
}

type ResolvedTipMapping = {
  node: number;
  sourceTaxId: number;
  ranks: Partial<Record<TaxonomyRank, string>>;
  taxIds: Partial<Record<TaxonomyRank, number>>;
  collapseFallbacks?: Partial<Record<TaxonomyRank, TaxonomyCollapseFallback>>;
};

type CandidateLineage = {
  taxId: number;
  ranks: Partial<Record<TaxonomyRank, string>>;
  taxIds: Partial<Record<TaxonomyRank, number>>;
  collapseFallbacks: Partial<Record<TaxonomyRank, TaxonomyCollapseFallback>>;
  requiresContext?: boolean;
  allowBroadClassContext?: boolean;
};

const CONTEXT_RANK_WEIGHTS: Array<[TaxonomyRank, number]> = [
  ["superkingdom", 64],
  ["kingdom", 48],
  ["phylum", 32],
  ["class", 16],
  ["order", 8],
  ["family", 4],
  ["genus", 2],
];

export function normalizeTaxonomyName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/[[\]()"']/g, " ")
    .replace(/\s+/g, " ");
}

export function extractNcbiTaxId(name: string): number | null {
  const normalized = name.trim().replace(/^["']+|["']+$/g, "");
  const bareMatch = normalized.match(/^([1-9]\d*)$/);
  if (!bareMatch && !/(?:tax|tx)/i.test(normalized)) {
    return null;
  }
  const match = bareMatch ?? normalized.match(/(?:^|[_|\s])(?:tax(?:[_\s-]?id)|tx)(?:[_=:\s-]?)([1-9]\d*)$/i);
  if (!match) {
    return null;
  }
  const taxId = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(taxId) ? taxId : null;
}

export const extractNcbiTaxIdSuffix = extractNcbiTaxId;

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

export function candidateSpeciesNames(name: string): string[] {
  const normalized = normalizeTaxonomyName(name).replaceAll("|", " ").replaceAll(";", " ").replaceAll(",", " ");
  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return [];
  }
  const candidates = [parts.join(" ")];
  if (parts.length >= 2) {
    const twoPart = `${parts[0]} ${parts[1]}`;
    candidates.push(twoPart);
  }
  return [...new Set(candidates)];
}

export function extractGenus(name: string): string {
  const parts = normalizeTaxonomyName(name).split(/\s+/).filter(Boolean);
  return parts[0] ?? "";
}

export function extractSpeciesEpithet(name: string): string {
  const parts = normalizeTaxonomyName(name).split(/\s+/).filter(Boolean);
  if (parts[0] === "candidatus") {
    return parts[2] ?? "";
  }
  return parts[1] ?? "";
}

export function candidateExactTaxonName(name: string): string | null {
  const parts = normalizeTaxonomyName(name).split(/\s+/).filter(Boolean);
  return parts.length === 1 ? parts[0] : null;
}

function buildCandidateLineage(
  taxId: number,
  taxonomy: ParsedTaxonomyForMapping,
  targetRanks: TaxonomyRank[],
  targetRankSet: Set<string>,
  lineageMemo: Map<number, CandidateLineage | null>,
  enableCollapseFallbacks: boolean,
): CandidateLineage | null {
  const cached = lineageMemo.get(taxId);
  if (cached !== undefined) {
    return cached;
  }
  const ranks: Partial<Record<TaxonomyRank, string>> = {};
  const taxIds: Partial<Record<TaxonomyRank, number>> = {};
  const collapseFallbacks: Partial<Record<TaxonomyRank, TaxonomyCollapseFallback>> = {};
  const lineageAncestors: Array<{ taxId: number; rank: string; label: string }> = [];
  let anyRank = false;
  let current = taxId;
  const seen = new Set<number>();
  while (current > 0 && !seen.has(current)) {
    seen.add(current);
    const node = taxonomy.nodes.get(current);
    if (!node) {
      break;
    }
    const label = taxonomy.rankNames.get(current);
    if (label) {
      lineageAncestors.push({ taxId: current, rank: node.rank, label });
      if (targetRankSet.has(node.rank)) {
        const rank = node.rank as TaxonomyRank;
        ranks[rank] = label;
        taxIds[rank] = current;
        anyRank = true;
      }
    }
    current = node.parentId;
  }
  if (anyRank && enableCollapseFallbacks) {
    const rankedAncestors = lineageAncestors
      .map((ancestor) => ({
        ...ancestor,
        precedence: TAXONOMY_COLLAPSE_RANK_PRECEDENCE.get(ancestor.rank),
      }))
      .filter((ancestor): ancestor is typeof ancestor & { precedence: number } => ancestor.precedence !== undefined)
      .sort((left, right) => left.precedence - right.precedence);
    for (let rankIndex = 0; rankIndex < targetRanks.length; rankIndex += 1) {
      const targetRank = targetRanks[rankIndex];
      if (taxIds[targetRank]) {
        continue;
      }
      const targetPrecedence = TAXONOMY_COLLAPSE_RANK_PRECEDENCE.get(targetRank);
      if (targetPrecedence === undefined) {
        continue;
      }
      let lower = 0;
      let upper = rankedAncestors.length;
      while (lower < upper) {
        const middle = (lower + upper) >>> 1;
        if (rankedAncestors[middle].precedence <= targetPrecedence) {
          lower = middle + 1;
        } else {
          upper = middle;
        }
      }
      const bestFallback = rankedAncestors[lower] ?? null;
      if (bestFallback) {
        collapseFallbacks[targetRank] = {
          label: bestFallback.label,
          rank: bestFallback.rank,
          taxId: bestFallback.taxId,
        };
      }
    }
  }
  const lineage = anyRank ? { taxId, ranks, taxIds, collapseFallbacks } : null;
  lineageMemo.set(taxId, lineage);
  return lineage;
}

function scoreCandidateAgainstResolvedNeighbors(
  candidate: CandidateLineage,
  tipIndex: number,
  resolved: Array<ResolvedTipMapping | null>,
  trustedResolved: boolean[],
  nearestTrusted: { left: Int32Array; right: Int32Array },
  trustedContextOnly: boolean,
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
      if (!neighbor || (trustedContextOnly && !trustedResolved[neighborIndex])) {
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
  if (!trustedContextOnly) {
    return score;
  }
  for (const neighborIndex of [nearestTrusted.left[tipIndex], nearestTrusted.right[tipIndex]]) {
    if (neighborIndex < 0) {
      continue;
    }
    const neighbor = resolved[neighborIndex];
    if (!neighbor) {
      continue;
    }
    for (let rankIndex = 0; rankIndex < CONTEXT_RANK_WEIGHTS.length; rankIndex += 1) {
      const [rank, rankWeight] = CONTEXT_RANK_WEIGHTS[rankIndex];
      const candidateTaxId = candidate.taxIds[rank];
      if (candidateTaxId && candidateTaxId === neighbor.taxIds[rank]) {
        score += rankWeight;
      }
    }
  }
  return score;
}

function hasSupportingFamilyOrOrderContext(
  candidate: CandidateLineage,
  tipIndex: number,
  resolved: Array<ResolvedTipMapping | null>,
  trustedResolved: boolean[],
  trustedContextOnly: boolean,
): boolean {
  let seenResolved = 0;
  for (let radius = 1; radius <= 48 && seenResolved < 12; radius += 1) {
    for (const neighborIndex of [tipIndex - radius, tipIndex + radius]) {
      if (neighborIndex < 0 || neighborIndex >= resolved.length) {
        continue;
      }
      const neighbor = resolved[neighborIndex];
      if (!neighbor || (trustedContextOnly && !trustedResolved[neighborIndex])) {
        continue;
      }
      seenResolved += 1;
      for (const rank of ["family", "order"] as const) {
        const candidateTaxId = candidate.taxIds[rank];
        if (candidateTaxId && candidateTaxId === neighbor.taxIds[rank]) {
          return true;
        }
      }
    }
  }
  return false;
}

function nearestTrustedIndices(trustedResolved: boolean[]): { left: Int32Array; right: Int32Array } {
  const left = new Int32Array(trustedResolved.length);
  const right = new Int32Array(trustedResolved.length);
  let nearest = -1;
  for (let index = 0; index < trustedResolved.length; index += 1) {
    left[index] = nearest;
    if (trustedResolved[index]) {
      nearest = index;
    }
  }
  nearest = -1;
  for (let index = trustedResolved.length - 1; index >= 0; index -= 1) {
    right[index] = nearest;
    if (trustedResolved[index]) {
      nearest = index;
    }
  }
  return { left, right };
}

function hasSupportingCandidateContext(
  candidate: CandidateLineage,
  tipIndex: number,
  resolved: Array<ResolvedTipMapping | null>,
  trustedResolved: boolean[],
  nearestTrusted: { left: Int32Array; right: Int32Array },
  extendedTrustedContext: boolean,
): boolean {
  if (hasSupportingFamilyOrOrderContext(candidate, tipIndex, resolved, trustedResolved, extendedTrustedContext)) {
    return true;
  }
  if (!extendedTrustedContext) {
    return false;
  }
  const leftIndex = nearestTrusted.left[tipIndex];
  const rightIndex = nearestTrusted.right[tipIndex];
  for (const rank of ["family", "order"] as const) {
    const candidateTaxId = candidate.taxIds[rank];
    if (
      candidateTaxId
      && (
        (leftIndex >= 0 && resolved[leftIndex]?.taxIds[rank] === candidateTaxId)
        || (rightIndex >= 0 && resolved[rightIndex]?.taxIds[rank] === candidateTaxId)
      )
    ) {
      return true;
    }
  }
  if (!candidate.allowBroadClassContext) {
    return false;
  }
  const candidateClass = candidate.taxIds.class;
  const leftSupports = Boolean(
    candidateClass
    && leftIndex >= 0
    && resolved[leftIndex]?.taxIds.class === candidateClass,
  );
  const rightSupports = Boolean(
    candidateClass
    && rightIndex >= 0
    && resolved[rightIndex]?.taxIds.class === candidateClass,
  );
  return Boolean(
    leftSupports || rightSupports,
  );
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

function rejectEmbeddedBroadRankRuns(
  resolved: Array<ResolvedTipMapping | null>,
  rank: TaxonomyRank,
  maximumRunLength = 64,
): void {
  const mappedIndices: number[] = [];
  for (let index = 0; index < resolved.length; index += 1) {
    if (resolved[index]?.taxIds[rank]) {
      mappedIndices.push(index);
    }
  }
  let runStart = 0;
  while (runStart < mappedIndices.length) {
    const firstIndex = mappedIndices[runStart];
    const runTaxId = resolved[firstIndex]?.taxIds[rank];
    let runEnd = runStart + 1;
    while (
      runEnd < mappedIndices.length
      && resolved[mappedIndices[runEnd]]?.taxIds[rank] === runTaxId
    ) {
      runEnd += 1;
    }
    const runLength = runEnd - runStart;
    const leftTaxId = runStart > 0
      ? resolved[mappedIndices[runStart - 1]]?.taxIds[rank]
      : undefined;
    const rightTaxId = runEnd < mappedIndices.length
      ? resolved[mappedIndices[runEnd]]?.taxIds[rank]
      : undefined;
    if (
      runTaxId
      && runLength <= maximumRunLength
      && leftTaxId
      && leftTaxId === rightTaxId
      && leftTaxId !== runTaxId
    ) {
      for (let mappedOffset = runStart; mappedOffset < runEnd; mappedOffset += 1) {
        resolved[mappedIndices[mappedOffset]] = null;
      }
    }
    runStart = runEnd;
  }
}

function collectCandidatesForTip(
  tip: TipTaxonomyRequest,
  taxonomy: ParsedTaxonomyForMapping,
  targetRanks: TaxonomyRank[],
  targetRankSet: Set<string>,
  lineageMemo: Map<number, CandidateLineage | null>,
  enableCollapseFallbacks: boolean,
  requireContextForGenusFallback: boolean,
  identifierMode: TaxonomyIdentifierMode,
): CandidateLineage[] {
  if (identifierMode === "ncbi-taxid") {
    const taxId = extractNcbiTaxId(tip.name);
    if (taxId === null) {
      return [];
    }
    const lineage = buildCandidateLineage(
      taxId,
      taxonomy,
      targetRanks,
      targetRankSet,
      lineageMemo,
      enableCollapseFallbacks,
    );
    return lineage ? [lineage] : [];
  }
  const speciesNameCandidates = candidateSpeciesNames(tip.name);
  let speciesCandidates: number[] = [];
  for (let candidateIndex = 0; candidateIndex < speciesNameCandidates.length; candidateIndex += 1) {
    const indexedCandidates = taxonomy.speciesIndex.get(speciesNameCandidates[candidateIndex]) ?? [];
    if (indexedCandidates.length > 0) {
      speciesCandidates = indexedCandidates;
      break;
    }
  }
  const exactTaxonName = speciesCandidates.length > 0 ? null : candidateExactTaxonName(tip.name);
  const exactTaxonCandidates = exactTaxonName
    ? [...(taxonomy.namedTaxonIndex.get(exactTaxonName) ?? [])]
    : [];
  const hasPrimaryCandidates = speciesCandidates.length > 0 || exactTaxonCandidates.length > 0;
  const directGenusCandidates = hasPrimaryCandidates
    ? []
    : [...(taxonomy.genusIndex.get(extractGenus(tip.name)) ?? [])];
  const contextualGenusCandidates = hasPrimaryCandidates
    ? []
    : [...(taxonomy.contextualGenusIndex?.get(extractGenus(tip.name)) ?? [])];
  const genusCandidates = [...directGenusCandidates, ...contextualGenusCandidates];
  const epithetCandidates = hasPrimaryCandidates
    ? []
    : [...(taxonomy.speciesEpithetIndex?.get(extractSpeciesEpithet(tip.name)) ?? [])];
  const source = speciesCandidates.length > 0
    ? speciesCandidates
    : exactTaxonCandidates.length > 0
      ? exactTaxonCandidates
      : [...genusCandidates, ...epithetCandidates];
  const directGenusCandidateIds = new Set(directGenusCandidates);
  const contextualGenusCandidateIds = new Set(contextualGenusCandidates);
  const epithetCandidateIds = new Set(epithetCandidates);
  const unique = [...new Set(source)];
  const candidates: CandidateLineage[] = [];
  for (let index = 0; index < unique.length; index += 1) {
    const lineage = buildCandidateLineage(unique[index], taxonomy, targetRanks, targetRankSet, lineageMemo, enableCollapseFallbacks);
    if (lineage) {
      const genusFallback = directGenusCandidateIds.has(unique[index]) || contextualGenusCandidateIds.has(unique[index]);
      const requiresContext = (
        !directGenusCandidateIds.has(unique[index])
        && (epithetCandidateIds.has(unique[index]) || contextualGenusCandidateIds.has(unique[index]))
      ) || (requireContextForGenusFallback && genusFallback);
      candidates.push(requiresContext ? {
        ...lineage,
        requiresContext: true,
        allowBroadClassContext: genusFallback,
      } : lineage);
    }
  }
  return candidates;
}

export function mapTipsWithContext(
  tips: TipTaxonomyRequest[],
  taxonomy: ParsedTaxonomyForMapping,
  targetRanks: TaxonomyRank[],
  mappingVersion: number,
  options: TaxonomyMappingOptions = {},
): TaxonomyMapPayload {
  const enableCollapseFallbacks = options.enableCollapseFallbacks ?? true;
  const identifierMode = options.identifierMode ?? "scientific-name";
  const requireContextForGenusFallback = options.requireContextForGenusFallback ?? false;
  const targetRankSet = new Set<string>(targetRanks);
  const lineageMemo = new Map<number, CandidateLineage | null>();
  const candidatesByTip = tips.map((tip) => collectCandidatesForTip(
    tip,
    taxonomy,
    targetRanks,
    targetRankSet,
    lineageMemo,
    enableCollapseFallbacks,
    requireContextForGenusFallback,
    identifierMode,
  ));
  const resolved: Array<ResolvedTipMapping | null> = new Array(tips.length).fill(null);
  const trustedResolved = new Array<boolean>(tips.length).fill(false);

  for (let index = 0; index < tips.length; index += 1) {
    const candidates = candidatesByTip[index];
    if (candidates.length === 1 && !candidates[0].requiresContext) {
      resolved[index] = {
        node: tips[index].node,
        sourceTaxId: candidates[0].taxId,
        ranks: candidates[0].ranks,
        taxIds: candidates[0].taxIds,
        collapseFallbacks: candidates[0].collapseFallbacks,
      };
      trustedResolved[index] = true;
    }
  }
  const nearestTrusted = nearestTrustedIndices(trustedResolved);

  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < tips.length; index += 1) {
      if (resolved[index]) {
        continue;
      }
      const candidates = candidatesByTip[index];
      if (candidates.length === 0) {
        continue;
      }
      const contextIndependentCandidates = candidates.filter((candidate) => !candidate.requiresContext);
      if (
        candidates.length > 1
        && contextIndependentCandidates.length === 1
        && hasSupportingCandidateContext(
          contextIndependentCandidates[0],
          index,
          resolved,
          trustedResolved,
          nearestTrusted,
          requireContextForGenusFallback,
        )
      ) {
        const candidate = contextIndependentCandidates[0];
        resolved[index] = {
          node: tips[index].node,
          sourceTaxId: candidate.taxId,
          ranks: candidate.ranks,
          taxIds: candidate.taxIds,
          collapseFallbacks: candidate.collapseFallbacks,
        };
        changed = true;
        continue;
      }
      if (candidates.length === 1) {
        const candidate = candidates[0];
        if (
          candidate.requiresContext
          && hasSupportingCandidateContext(
            candidate,
            index,
            resolved,
            trustedResolved,
            nearestTrusted,
            requireContextForGenusFallback,
          )
        ) {
          resolved[index] = {
            node: tips[index].node,
            sourceTaxId: candidate.taxId,
            ranks: candidate.ranks,
            taxIds: candidate.taxIds,
            collapseFallbacks: candidate.collapseFallbacks,
          };
          changed = true;
        }
        continue;
      }
      let best: CandidateLineage | null = null;
      let bestScore = 0;
      let secondBestScore = 0;
      for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
        const candidate = candidates[candidateIndex];
        const score = scoreCandidateAgainstResolvedNeighbors(
          candidate,
          index,
          resolved,
          trustedResolved,
          nearestTrusted,
          requireContextForGenusFallback,
        );
        if (score > bestScore) {
          secondBestScore = bestScore;
          bestScore = score;
          best = candidate;
        } else if (score > secondBestScore) {
          secondBestScore = score;
        }
      }
      if (
        best
        && bestScore > 0
        && (bestScore - secondBestScore) > 1e-6
        && (!best.requiresContext || hasSupportingCandidateContext(
          best,
          index,
          resolved,
          trustedResolved,
          nearestTrusted,
          requireContextForGenusFallback,
        ))
      ) {
        resolved[index] = {
          node: tips[index].node,
          sourceTaxId: best.taxId,
          ranks: best.ranks,
          taxIds: best.taxIds,
          collapseFallbacks: best.collapseFallbacks,
        };
        changed = true;
      }
    }
  }

  for (let index = 0; index < tips.length; index += 1) {
    if (resolved[index]) {
      continue;
    }
    const candidates = candidatesByTip[index];
    if (candidates.length === 0) {
      continue;
    }
    if (candidates.some((candidate) => candidate.requiresContext)) {
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
    resolved[index] = {
      node: tips[index].node,
      sourceTaxId: candidates[0].taxId,
      ranks: candidates[0].ranks,
      taxIds: candidates[0].taxIds,
      collapseFallbacks: candidates[0].collapseFallbacks,
    };
  }

  if (options.rejectEmbeddedBroadRankRuns) {
    rejectEmbeddedBroadRankRuns(resolved, "phylum");
  }

  const tipRanks = resolved.filter((mapping): mapping is ResolvedTipMapping => mapping !== null);

  return {
    version: mappingVersion,
    identifierMode,
    mappedCount: tipRanks.length,
    totalTips: tips.length,
    resolvedRanks: [...targetRanks],
    activeRanks: deriveActiveTaxonomyRanks(tipRanks.map((tip) => tip.ranks)),
    tipRanks,
  };
}

export function enrichTaxonomyMapRanks(
  taxonomyMap: TaxonomyMapPayload,
  taxonomy: ParsedTaxonomyForMapping,
  requestedRanks: TaxonomyRank[],
  mappingVersion: number,
  enableCollapseFallbacks = true,
): TaxonomyMapPayload {
  const ranksToResolve = [...new Set(requestedRanks)];
  const targetRankSet = new Set<string>(ranksToResolve);
  const lineageMemo = new Map<number, CandidateLineage | null>();
  const tipRanks = taxonomyMap.tipRanks.map((tip) => {
    if (!tip.sourceTaxId) {
      return tip;
    }
    const lineage = buildCandidateLineage(
      tip.sourceTaxId,
      taxonomy,
      ranksToResolve,
      targetRankSet,
      lineageMemo,
      enableCollapseFallbacks,
    );
    if (!lineage) {
      return tip;
    }
    const ranks = { ...tip.ranks };
    const taxIds = { ...tip.taxIds };
    const collapseFallbacks = { ...tip.collapseFallbacks };
    for (const rank of ranksToResolve) {
      if (lineage.ranks[rank]) {
        ranks[rank] = lineage.ranks[rank];
      }
      if (lineage.taxIds[rank]) {
        taxIds[rank] = lineage.taxIds[rank];
      }
      if (lineage.collapseFallbacks[rank]) {
        collapseFallbacks[rank] = lineage.collapseFallbacks[rank];
      }
    }
    return {
      ...tip,
      ranks,
      taxIds,
      collapseFallbacks,
    };
  });
  return {
    ...taxonomyMap,
    version: mappingVersion,
    resolvedRanks: [...new Set([...(taxonomyMap.resolvedRanks ?? taxonomyMap.activeRanks), ...ranksToResolve])],
    activeRanks: deriveActiveTaxonomyRanks(tipRanks.map((tip) => tip.ranks)),
    tipRanks,
  };
}
