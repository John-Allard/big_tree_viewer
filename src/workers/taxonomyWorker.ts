/// <reference lib="webworker" />

import { DecodeUTF8, Unzip, UnzipInflate } from "fflate";
import type { TaxonomyMapPayload, TaxonomyRank } from "../types/taxonomy";

type TaxonomyWorkerRequest =
  | { type: "download-taxonomy" }
  | { type: "map-taxonomy"; archive: Blob | ArrayBuffer; tips: Array<{ node: number; name: string }> };

type TaxonomyWorkerResponse =
  | { type: "taxonomy-progress"; message: string }
  | { type: "taxonomy-downloaded"; archive: ArrayBuffer }
  | { type: "taxonomy-mapped"; payload: TaxonomyMapPayload }
  | { type: "taxonomy-error"; message: string };

const TAXONOMY_URL = "https://ftp.ncbi.nlm.nih.gov/pub/taxonomy/taxdmp.zip";
const TAXONOMY_MAPPING_VERSION = 4;
const TARGET_RANKS: TaxonomyRank[] = ["genus", "family", "order", "class", "phylum", "superkingdom"];

type NodeInfo = { parentId: number; rank: string };
type ParsedTaxonomy = {
  nodes: Map<number, NodeInfo>;
  rankNames: Map<number, string>;
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

function parseNodeLine(line: string, nodes: Map<number, NodeInfo>): void {
  const parts = line.split("|").map((part) => part.trim());
  if (parts.length < 3) {
    return;
  }
  const taxId = Number.parseInt(parts[0], 10);
  const parentId = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(taxId) || !Number.isFinite(parentId)) {
    return;
  }
  nodes.set(taxId, { parentId, rank: parts[2] });
}

function parseScientificNameLine(
  line: string,
  nodes: Map<number, NodeInfo>,
  rankNames: Map<number, string>,
  speciesIndex: Map<string, number>,
  genusIndex: Map<string, number>,
): void {
  const parts = line.split("|").map((part) => part.trim());
  if (parts.length < 4 || parts[3] !== "scientific name") {
    return;
  }
  const taxId = Number.parseInt(parts[0], 10);
  if (!Number.isFinite(taxId)) {
    return;
  }
  const scientificName = parts[1];
  const rank = nodes.get(taxId)?.rank ?? "";
  if (rank === "species") {
    const normalized = normalizeName(scientificName);
    speciesIndex.set(normalized, taxId);
    speciesIndex.set(normalized.replaceAll(" ", "_"), taxId);
  } else if (rank === "genus") {
    const normalized = normalizeName(scientificName);
    genusIndex.set(normalized, taxId);
    genusIndex.set(normalized.replaceAll(" ", "_"), taxId);
  }
  if ((TARGET_RANKS as string[]).includes(rank)) {
    rankNames.set(taxId, scientificName);
  }
}

function createLineStreamParser(onLine: (line: string) => void): (chunk: Uint8Array, final: boolean) => void {
  let remainder = "";
  const decoder = new DecodeUTF8((text, final) => {
    const merged = remainder + text;
    const lines = merged.split("\n");
    remainder = lines.pop() ?? "";
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line) {
        onLine(line);
      }
    }
    if (final && remainder) {
      onLine(remainder);
      remainder = "";
    }
  });
  return (chunk: Uint8Array, final: boolean) => {
    decoder.push(chunk, final);
  };
}

async function streamBlobChunks(blob: Blob, onChunk: (chunk: Uint8Array, final: boolean) => void): Promise<void> {
  if (typeof blob.stream === "function") {
    const reader = blob.stream().getReader();
    while (true) {
      const { value, done } = await reader.read();
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value ?? 0);
      onChunk(chunk, done);
      if (done) {
        break;
      }
    }
    return;
  }
  const buffer = await blob.arrayBuffer();
  const chunkSize = 1024 * 1024;
  for (let offset = 0; offset < buffer.byteLength; offset += chunkSize) {
    const end = Math.min(buffer.byteLength, offset + chunkSize);
    onChunk(new Uint8Array(buffer.slice(offset, end)), end >= buffer.byteLength);
  }
}

async function parseZipFileLines(
  archiveBlob: Blob,
  targetFileName: "nodes.dmp" | "names.dmp",
  progressMessage: string,
  onLine: (line: string) => void,
): Promise<void> {
  let fileFound = false;
  let fileDone = false;
  await new Promise<void>((resolve, reject) => {
    const maybeResolve = (): void => {
      if (fileFound && fileDone) {
        resolve();
      }
    };
    const unzipper = new Unzip((file) => {
      if (file.name !== targetFileName) {
        return;
      }
      fileFound = true;
      post({ type: "taxonomy-progress", message: progressMessage });
      const parseChunk = createLineStreamParser(onLine);
      file.ondata = (error, data, final) => {
        if (error) {
          reject(error);
          return;
        }
        parseChunk(data, final);
        if (final) {
          fileDone = true;
          maybeResolve();
        }
      };
      file.start();
    });
    unzipper.register(UnzipInflate);
    void streamBlobChunks(archiveBlob, (chunk, final) => {
      unzipper.push(chunk, final);
    }).then(() => {
      if (!fileFound) {
        reject(new Error(`Taxonomy archive did not contain ${targetFileName}.`));
        return;
      }
      maybeResolve();
    }).catch(reject);
  });
}

async function parseArchive(archive: Blob | ArrayBuffer): Promise<ParsedTaxonomy> {
  if (parsedCache) {
    return parsedCache;
  }
  post({ type: "taxonomy-progress", message: "Extracting taxonomy archive..." });
  const archiveBlob = archive instanceof Blob ? archive : new Blob([archive], { type: "application/zip" });
  const nodes = new Map<number, NodeInfo>();
  const rankNames = new Map<number, string>();
  const speciesIndex = new Map<string, number>();
  const genusIndex = new Map<string, number>();

  await parseZipFileLines(archiveBlob, "nodes.dmp", "Parsing taxonomy nodes...", (line) => {
    parseNodeLine(line, nodes);
  });
  await parseZipFileLines(archiveBlob, "names.dmp", "Parsing taxonomy names...", (line) => {
    parseScientificNameLine(line, nodes, rankNames, speciesIndex, genusIndex);
  });

  parsedCache = { nodes, rankNames, speciesIndex, genusIndex };
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
  const rankToCounts = new Map<TaxonomyRank, Map<string, number>>();
  for (let index = 0; index < TARGET_RANKS.length; index += 1) {
    rankToLabels.set(TARGET_RANKS[index], new Set());
    rankToHits.set(TARGET_RANKS[index], 0);
    rankToCounts.set(TARGET_RANKS[index], new Map());
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
    const taxIds: Partial<Record<TaxonomyRank, number>> = {};
    let anyRank = false;
    for (let rankIndex = 0; rankIndex < TARGET_RANKS.length; rankIndex += 1) {
      const rank = TARGET_RANKS[rankIndex];
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
      rankToLabels.get(rank)?.add(label);
      rankToHits.set(rank, (rankToHits.get(rank) ?? 0) + 1);
      const counts = rankToCounts.get(rank);
      if (counts) {
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
      anyRank = true;
    }
    if (!anyRank) {
      continue;
    }
    mappedCount += 1;
    tipRanks.push({ node: tip.node, ranks, taxIds });
  }
  const activeRanks = TARGET_RANKS.filter((rank) => (rankToLabels.get(rank)?.size ?? 0) > 1);
  while (activeRanks.length > 1) {
    const topRank = activeRanks[activeRanks.length - 1];
    const counts = rankToCounts.get(topRank);
    const total = rankToHits.get(topRank) ?? 0;
    if (!counts || total <= 0) {
      break;
    }
    let dominant = 0;
    counts.forEach((count) => {
      if (count > dominant) {
        dominant = count;
      }
    });
    if ((dominant / total) > 0.8) {
      activeRanks.pop();
      continue;
    }
    break;
  }
  return {
    version: TAXONOMY_MAPPING_VERSION,
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
    const taxonomy = await parseArchive(request.archive);
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
