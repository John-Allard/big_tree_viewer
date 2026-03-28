/// <reference lib="webworker" />

import { DecodeUTF8, Unzip, UnzipInflate } from "fflate";
import {
  addTaxonomyIndexEntry,
  mapTipsWithContext,
  normalizeTaxonomyName,
  TAXONOMY_SPECIES_INDEX_NAME_CLASSES,
} from "../lib/taxonomyNameResolver";
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
const TAXONOMY_MAPPING_VERSION = 6;
const TARGET_RANKS: TaxonomyRank[] = ["genus", "family", "order", "class", "phylum", "superkingdom"];

type NodeInfo = { parentId: number; rank: string };
type ParsedTaxonomy = {
  nodes: Map<number, NodeInfo>;
  rankNames: Map<number, string>;
  speciesIndex: Map<string, number[]>;
  genusIndex: Map<string, number[]>;
};

let parsedCache: ParsedTaxonomy | null = null;

function post(message: TaxonomyWorkerResponse, transfer?: Transferable[]): void {
  if (transfer && transfer.length > 0) {
    self.postMessage(message, transfer);
    return;
  }
  self.postMessage(message);
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

function parseTaxonomyNameLine(
  line: string,
  nodes: Map<number, NodeInfo>,
  rankNames: Map<number, string>,
  speciesIndex: Map<string, number[]>,
  genusIndex: Map<string, number[]>,
): void {
  const parts = line.split("|").map((part) => part.trim());
  if (parts.length < 4) {
    return;
  }
  const taxId = Number.parseInt(parts[0], 10);
  if (!Number.isFinite(taxId)) {
    return;
  }
  const scientificName = parts[1];
  const nameClass = parts[3];
  const rank = nodes.get(taxId)?.rank ?? "";
  if (rank === "species" && TAXONOMY_SPECIES_INDEX_NAME_CLASSES.has(nameClass)) {
    const normalized = normalizeTaxonomyName(scientificName);
    addTaxonomyIndexEntry(speciesIndex, normalized, taxId);
  } else if (rank === "genus" && nameClass === "scientific name") {
    const normalized = normalizeTaxonomyName(scientificName);
    addTaxonomyIndexEntry(genusIndex, normalized, taxId);
  }
  if (nameClass === "scientific name" && (TARGET_RANKS as string[]).includes(rank)) {
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
  const speciesIndex = new Map<string, number[]>();
  const genusIndex = new Map<string, number[]>();

  await parseZipFileLines(archiveBlob, "nodes.dmp", "Parsing taxonomy nodes...", (line) => {
    parseNodeLine(line, nodes);
  });
  await parseZipFileLines(archiveBlob, "names.dmp", "Parsing taxonomy names...", (line) => {
    parseTaxonomyNameLine(line, nodes, rankNames, speciesIndex, genusIndex);
  });

  const parsed = { nodes, rankNames, speciesIndex, genusIndex };
  parsedCache = parsed;
  return parsed;
}

function mapTips(tips: Array<{ node: number; name: string }>, taxonomy: ParsedTaxonomy): TaxonomyMapPayload {
  return mapTipsWithContext(tips, taxonomy, TARGET_RANKS, TAXONOMY_MAPPING_VERSION);
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
