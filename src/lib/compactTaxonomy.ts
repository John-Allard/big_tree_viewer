import { deriveActiveTaxonomyRanks } from "./taxonomyActiveRanks";
import {
  TAXONOMY_RANKS,
  type CompactTaxonomyPayload,
  type CompactTaxonomyTaxon,
  type TaxonomyMapPayload,
  type TaxonomyRank,
  type TaxonomyTipRanks,
} from "../types/taxonomy";
import type { TreeModel } from "../types/tree";

const TAXONOMY_RANK_SET = new Set<string>(TAXONOMY_RANKS);

function requirePositiveInteger(value: unknown, description: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${description} must be a positive integer.`);
  }
  return Number(value);
}

function normalizeTaxon(raw: CompactTaxonomyTaxon, index: number): CompactTaxonomyTaxon {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Compact taxonomy taxon ${index} is not an object.`);
  }
  const taxId = requirePositiveInteger(raw.taxId, `Compact taxonomy taxon ${index} taxId`);
  const parentTaxId = raw.parentTaxId === null || raw.parentTaxId === undefined
    ? null
    : requirePositiveInteger(raw.parentTaxId, `Compact taxonomy taxon ${taxId} parentTaxId`);
  const rank = typeof raw.rank === "string" ? raw.rank.trim().toLowerCase() : "";
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!rank) {
    throw new Error(`Compact taxonomy taxon ${taxId} has no rank.`);
  }
  if (!name) {
    throw new Error(`Compact taxonomy taxon ${taxId} has no name.`);
  }
  return { taxId, parentTaxId, rank, name };
}

export function compactTaxonomyToMap(
  tree: TreeModel,
  payload: CompactTaxonomyPayload,
): TaxonomyMapPayload {
  if (!payload || typeof payload !== "object") {
    throw new Error("Compact taxonomy payload is not an object.");
  }
  if (payload.format !== "big-tree-viewer-compact-taxonomy" || payload.version !== 1) {
    throw new Error("Unsupported compact taxonomy format or version.");
  }
  if (!Array.isArray(payload.taxa) || !Array.isArray(payload.tips)) {
    throw new Error("Compact taxonomy must contain taxa and tips arrays.");
  }

  const taxaById = new Map<number, CompactTaxonomyTaxon>();
  for (let index = 0; index < payload.taxa.length; index += 1) {
    const taxon = normalizeTaxon(payload.taxa[index], index);
    if (taxaById.has(taxon.taxId)) {
      throw new Error(`Compact taxonomy contains duplicate taxId ${taxon.taxId}.`);
    }
    taxaById.set(taxon.taxId, taxon);
  }

  const inputLeaves = Array.from(tree.leafNodes)
    .sort((left, right) => tree.layouts.input.center[left] - tree.layouts.input.center[right]);
  const usedTipIndexes = new Set<number>();
  const tipRanks: TaxonomyTipRanks[] = [];
  for (let index = 0; index < payload.tips.length; index += 1) {
    const tip = payload.tips[index];
    if (!tip || typeof tip !== "object") {
      throw new Error(`Compact taxonomy tip ${index} is not an object.`);
    }
    if (!Number.isSafeInteger(tip.tipIndex) || tip.tipIndex < 0 || tip.tipIndex >= inputLeaves.length) {
      throw new Error(`Compact taxonomy tip ${index} has an out-of-range tipIndex.`);
    }
    if (usedTipIndexes.has(tip.tipIndex)) {
      throw new Error(`Compact taxonomy contains duplicate tipIndex ${tip.tipIndex}.`);
    }
    usedTipIndexes.add(tip.tipIndex);

    const taxId = requirePositiveInteger(tip.taxId, `Compact taxonomy tip ${tip.tipIndex} taxId`);
    const node = inputLeaves[tip.tipIndex];
    const actualLabel = tree.names[node] || "";
    if (tip.tipLabel !== undefined) {
      if (typeof tip.tipLabel !== "string") {
        throw new Error(`Compact taxonomy tip ${tip.tipIndex} tipLabel must be a string.`);
      }
      if (tip.tipLabel !== actualLabel) {
        throw new Error(`Compact taxonomy tip ${tip.tipIndex} label mismatch: expected "${actualLabel}", received "${tip.tipLabel}".`);
      }
    }
    if (!taxaById.has(taxId)) {
      throw new Error(`Compact taxonomy tip ${tip.tipIndex} references missing taxId ${taxId}.`);
    }

    const ranks: Partial<Record<TaxonomyRank, string>> = {};
    const taxIds: Partial<Record<TaxonomyRank, number>> = {};
    const visited = new Set<number>();
    let currentTaxId: number | null = taxId;
    while (currentTaxId !== null) {
      if (visited.has(currentTaxId)) {
        throw new Error(`Compact taxonomy contains a parent cycle at taxId ${currentTaxId}.`);
      }
      visited.add(currentTaxId);
      const taxon = taxaById.get(currentTaxId);
      if (!taxon) {
        throw new Error(`Compact taxonomy lineage references missing taxId ${currentTaxId}.`);
      }
      if (TAXONOMY_RANK_SET.has(taxon.rank)) {
        const rank = taxon.rank as TaxonomyRank;
        if (!ranks[rank]) {
          ranks[rank] = taxon.name;
          taxIds[rank] = taxon.taxId;
        }
      }
      if (taxon.parentTaxId === null || taxon.parentTaxId === undefined || taxon.parentTaxId === taxon.taxId) {
        break;
      }
      currentTaxId = taxon.parentTaxId;
    }
    if (Object.keys(ranks).length > 0) {
      tipRanks.push({ node, ranks, taxIds });
    }
  }

  return {
    version: 1,
    mappedCount: tipRanks.length,
    totalTips: tree.leafCount,
    activeRanks: deriveActiveTaxonomyRanks(tipRanks.map((tip) => tip.ranks)),
    tipRanks,
  };
}
