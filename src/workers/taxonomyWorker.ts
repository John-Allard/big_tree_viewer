/// <reference lib="webworker" />

import { strFromU8, unzipSync } from "fflate";
import type { TaxonomyMapPayload, TaxonomyRank } from "../types/taxonomy";

type TaxonomyWorkerRequest =
  | { type: "download-taxonomy" }
  | { type: "map-taxonomy"; archive: ArrayBuffer; tips: Array<{ node: number; name: string }> };

type TaxonomyWorkerResponse =
  | { type: "taxonomy-progress"; message: string }
  | { type: "taxonomy-downloaded"; archive: ArrayBuffer }
  | { type: "taxonomy-mapped"; payload: TaxonomyMapPayload }
  | { type: "taxonomy-error"; message: string };

const TAXONOMY_URL = "https://ftp.ncbi.nlm.nih.gov/pub/taxonomy/taxdmp.zip";
const TARGET_RANKS: TaxonomyRank[] = ["superkingdom", "phylum", "class", "order", "family", "genus"];

type NodeInfo = { parentId: number; rank: string };
type ParsedTaxonomy = {
  nodes: Map<number, NodeInfo>;
  names: Map<number, string>;
  speciesIndex: Map<string, number>;
  genusIndex: Map<string, number>;
};

let parsedCache: ParsedTaxonomy | null = null;

function post(message: TaxonomyWorkerResponse, transfer?: Transferable[]): void {
  if (transfer && transfer.length > 0) {
    self.postMessage(message, transfer);
    return;
  }
  self.postMessage(message);
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replaceAll("_", " ");
}

function candidateSpeciesNames(name: string): string[] {
  const nm = normalizeName(name).replaceAll("|", " ").replaceAll(";", " ").replaceAll(",", " ");
  const parts = nm.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return [];
  }
  const candidates = [parts.join(" "), parts.join("_")];
  if (parts.length >= 2) {
    const two = `${parts[0]} ${parts[1]}`;
    candidates.push(two, two.replaceAll(" ", "_"));
  }
  return [...new Set(candidates)];
}

function extractGenus(name: string): string {
  const parts = normalizeName(name).split(/\s+/).filter(Boolean);
  return parts[0] ?? "";
}

function parseNodes(nodesText: string): Map<number, NodeInfo> {
  const nodes = new Map<number, NodeInfo>();
  const lines = nodesText.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const parts = lines[index].split("|").map((part) => part.trim());
    if (parts.length < 3) {
      continue;
    }
    const taxId = Number.parseInt(parts[0], 10);
    const parentId = Number.parseInt(parts[1], 10);
    if (!Number.isFinite(taxId) || !Number.isFinite(parentId)) {
      continue;
    }
    nodes.set(taxId, { parentId, rank: parts[2] });
  }
  return nodes;
}

function parseNames(namesText: string, nodes: Map<number, NodeInfo>): ParsedTaxonomy {
  const names = new Map<number, string>();
  const speciesIndex = new Map<string, number>();
  const genusIndex = new Map<string, number>();
  const lines = namesText.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const parts = lines[index].split("|").map((part) => part.trim());
    if (parts.length < 4 || parts[3] !== "scientific name") {
      continue;
    }
    const taxId = Number.parseInt(parts[0], 10);
    if (!Number.isFinite(taxId)) {
      continue;
    }
    const scientificName = parts[1];
    names.set(taxId, scientificName);
    const rank = nodes.get(taxId)?.rank ?? "";
    const normalized = normalizeName(scientificName);
    if (rank === "species") {
      speciesIndex.set(normalized, taxId);
      speciesIndex.set(normalized.replaceAll(" ", "_"), taxId);
    } else if (rank === "genus") {
      genusIndex.set(normalized, taxId);
      genusIndex.set(normalized.replaceAll(" ", "_"), taxId);
    }
  }
  return { nodes, names, speciesIndex, genusIndex };
}

function parseArchive(archive: ArrayBuffer): ParsedTaxonomy {
  if (parsedCache) {
    return parsedCache;
  }
  post({ type: "taxonomy-progress", message: "Extracting taxonomy archive..." });
  const files = unzipSync(new Uint8Array(archive));
  const nodesFile = files["nodes.dmp"];
  const namesFile = files["names.dmp"];
  if (!nodesFile || !namesFile) {
    throw new Error("Taxonomy archive did not contain nodes.dmp and names.dmp.");
  }
  post({ type: "taxonomy-progress", message: "Parsing taxonomy nodes..." });
  const nodes = parseNodes(strFromU8(nodesFile));
  post({ type: "taxonomy-progress", message: "Parsing taxonomy names..." });
  parsedCache = parseNames(strFromU8(namesFile), nodes);
  return parsedCache;
}

function ancestorAtRank(taxId: number, rank: TaxonomyRank, taxonomy: ParsedTaxonomy, memo: Map<string, number | null>): number | null {
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

function mapTips(tips: Array<{ node: number; name: string }>, taxonomy: ParsedTaxonomy): TaxonomyMapPayload {
  const ancestorMemo = new Map<string, number | null>();
  const tipRanks: TaxonomyMapPayload["tipRanks"] = [];
  let mappedCount = 0;
  const rankToLabels = new Map<TaxonomyRank, Set<string>>();
  const rankToHits = new Map<TaxonomyRank, number>();
  for (let index = 0; index < TARGET_RANKS.length; index += 1) {
    rankToLabels.set(TARGET_RANKS[index], new Set());
    rankToHits.set(TARGET_RANKS[index], 0);
  }
  for (let index = 0; index < tips.length; index += 1) {
    const tip = tips[index];
    let taxId: number | undefined;
    const speciesCandidates = candidateSpeciesNames(tip.name);
    for (let candidateIndex = 0; candidateIndex < speciesCandidates.length; candidateIndex += 1) {
      const found = taxonomy.speciesIndex.get(speciesCandidates[candidateIndex]);
      if (found) {
        taxId = found;
        break;
      }
    }
    if (!taxId) {
      taxId = taxonomy.genusIndex.get(extractGenus(tip.name));
    }
    if (!taxId) {
      continue;
    }
    const ranks: Partial<Record<TaxonomyRank, string>> = {};
    let anyRank = false;
    for (let rankIndex = 0; rankIndex < TARGET_RANKS.length; rankIndex += 1) {
      const rank = TARGET_RANKS[rankIndex];
      const ancestor = ancestorAtRank(taxId, rank, taxonomy, ancestorMemo);
      if (!ancestor) {
        continue;
      }
      const label = taxonomy.names.get(ancestor);
      if (!label) {
        continue;
      }
      ranks[rank] = label;
      rankToLabels.get(rank)?.add(label);
      rankToHits.set(rank, (rankToHits.get(rank) ?? 0) + 1);
      anyRank = true;
    }
    if (!anyRank) {
      continue;
    }
    mappedCount += 1;
    tipRanks.push({ node: tip.node, ranks });
  }
  const activeRanks = TARGET_RANKS.filter((rank) => (rankToLabels.get(rank)?.size ?? 0) > 1);
  while (activeRanks.length > 1) {
    const topRank = activeRanks[0];
    const uniqueCount = rankToLabels.get(topRank)?.size ?? 0;
    const coverage = mappedCount > 0 ? (rankToHits.get(topRank) ?? 0) / mappedCount : 0;
    if (uniqueCount <= 1 || coverage >= 0.985) {
      activeRanks.shift();
      continue;
    }
    break;
  }
  return {
    mappedCount,
    totalTips: tips.length,
    activeRanks,
    tipRanks,
  };
}

self.addEventListener("message", async (event: MessageEvent<TaxonomyWorkerRequest>) => {
  try {
    const request = event.data;
    if (request.type === "download-taxonomy") {
      post({ type: "taxonomy-progress", message: "Downloading NCBI taxonomy..." });
      const response = await fetch(TAXONOMY_URL);
      if (!response.ok) {
        throw new Error(`Taxonomy download failed with HTTP ${response.status}.`);
      }
      const archive = await response.arrayBuffer();
      post({ type: "taxonomy-downloaded", archive }, [archive]);
      return;
    }
    const taxonomy = parseArchive(request.archive);
    post({ type: "taxonomy-progress", message: "Mapping taxonomy to tree tips..." });
    const payload = mapTips(request.tips, taxonomy);
    post({ type: "taxonomy-mapped", payload });
  } catch (error) {
    post({
      type: "taxonomy-error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
