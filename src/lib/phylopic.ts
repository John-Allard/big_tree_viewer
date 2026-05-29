import type { TaxonomyRank } from "../types/taxonomy";

const PHYLOPIC_API_BASE = "https://api.phylopic.org";
const PHYLOPIC_CACHE_PREFIX = "big-tree-viewer:phylopic:";

export const PHYLOPIC_MAX_RETRIEVE_PER_CLICK = 200;

export class PhyloPicRateLimitError extends Error {
  retryAfterMs: number;

  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = "PhyloPicRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

export interface PhyloPicSilhouette {
  key: string;
  taxonLabel: string;
  rank: TaxonomyRank;
  taxId: number | null;
  imageUuid: string;
  dataUrl: string;
  width: number;
  height: number;
  attribution: string;
  licenseUrl: string;
  licenseLabel: string;
  sourceUrl: string;
}

export interface PhyloPicCandidate {
  key: string;
  taxonLabel: string;
  rank: TaxonomyRank;
  taxId: number | null;
}

interface PhyloPicNodeResponse {
  build?: number;
  uuid?: string;
  _embedded?: {
    primaryImage?: unknown;
    items?: Array<{ uuid?: string }>;
  };
  _links?: {
    cladeImages?: { href?: string };
  };
}

interface PhyloPicImageRecord {
  uuid?: string;
  attribution?: string;
  _links?: {
    contributor?: { href?: string; title?: string };
    license?: { href?: string };
    self?: { href?: string; title?: string };
    vectorFile?: { href?: string; sizes?: string; type?: string };
    sourceFile?: { href?: string; sizes?: string; type?: string };
    rasterFiles?: Array<{ href?: string; sizes?: string; type?: string }>;
  };
}

interface PhyloPicImagesResponse {
  _embedded?: {
    items?: PhyloPicImageRecord[];
  };
}

function absolutePhyloPicUrl(href: string): string {
  return href.startsWith("http") ? href : `${PHYLOPIC_API_BASE}${href}`;
}

function cacheKey(candidate: PhyloPicCandidate): string {
  return `${PHYLOPIC_CACHE_PREFIX}${candidate.key}`;
}

function licenseLabel(licenseUrl: string): string {
  if (licenseUrl.includes("/publicdomain/zero/")) {
    return "CC0 1.0";
  }
  if (licenseUrl.includes("/publicdomain/mark/")) {
    return "Public Domain Mark";
  }
  const match = /creativecommons\.org\/licenses\/([^/]+)\/([^/]+)/i.exec(licenseUrl);
  if (match) {
    return `CC ${match[1].toUpperCase()} ${match[2]}`;
  }
  return licenseUrl || "Unknown license";
}

function licenseAllowsPublication(licenseUrl: string): boolean {
  const normalized = licenseUrl.toLowerCase();
  if (normalized.includes("-nc") || normalized.includes("/nc/")) {
    return false;
  }
  return normalized.includes("creativecommons.org/publicdomain/")
    || normalized.includes("creativecommons.org/licenses/by")
    || normalized.includes("creativecommons.org/licenses/zero");
}

function parseSizes(value: string | undefined): { width: number; height: number } {
  const match = /^([\d.]+)x([\d.]+)$/i.exec(value ?? "");
  if (!match) {
    return { width: 1, height: 1 };
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  return {
    width: Number.isFinite(width) && width > 0 ? width : 1,
    height: Number.isFinite(height) && height > 0 ? height : 1,
  };
}

function pickImageFile(record: PhyloPicImageRecord): { href: string; sizes?: string } | null {
  const rasterFiles = [...(record._links?.rasterFiles ?? [])]
    .filter((file) => file.href && file.type === "image/png")
    .sort((left, right) => parseSizes(right.sizes).width - parseSizes(left.sizes).width);
  const largestRaster = rasterFiles[0];
  if (largestRaster?.href) {
    return { href: largestRaster.href, sizes: largestRaster.sizes };
  }
  const sourceFile = record._links?.sourceFile;
  if (sourceFile?.href && sourceFile.type === "image/png") {
    return { href: sourceFile.href, sizes: sourceFile.sizes };
  }
  const vectorFile = record._links?.vectorFile;
  if (vectorFile?.href) {
    return { href: vectorFile.href, sizes: vectorFile.sizes };
  }
  return null;
}

function retryAfterMs(response: Response): number {
  const retryAfter = response.headers.get("Retry-After");
  if (!retryAfter) {
    return 5000;
  }
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.max(1000, seconds * 1000);
  }
  const dateMs = Date.parse(retryAfter);
  if (Number.isFinite(dateMs)) {
    return Math.max(1000, dateMs - Date.now());
  }
  return 5000;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    credentials: "omit",
    mode: "cors",
    headers: { Accept: "application/json" },
  });
  if (response.status === 429) {
    throw new PhyloPicRateLimitError("PhyloPic rate limit reached.", retryAfterMs(response));
  }
  if (!response.ok) {
    throw new Error(`PhyloPic request failed (${response.status} ${response.statusText}).`);
  }
  return await response.json() as T;
}

async function fetchDataUrl(url: string): Promise<string> {
  const response = await fetch(url, { credentials: "omit", mode: "cors" });
  if (response.status === 429) {
    throw new PhyloPicRateLimitError("PhyloPic image download rate limit reached.", retryAfterMs(response));
  }
  if (!response.ok) {
    throw new Error(`PhyloPic image download failed (${response.status} ${response.statusText}).`);
  }
  const blob = await response.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read PhyloPic image."));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

async function resolveNodeUuid(candidate: PhyloPicCandidate): Promise<{ uuid: string; build: number } | null> {
  if (candidate.taxId) {
    const url = `${PHYLOPIC_API_BASE}/resolve/ncbi.nlm.nih.gov/taxid/${candidate.taxId}`;
    const resolved = await fetchJson<PhyloPicNodeResponse>(url);
    if (resolved.uuid && resolved.build) {
      return { uuid: resolved.uuid, build: resolved.build };
    }
  }
  const searchName = candidate.taxonLabel.trim().toLowerCase();
  if (!searchName) {
    return null;
  }
  const list = await fetchJson<PhyloPicNodeResponse>(
    `${PHYLOPIC_API_BASE}/nodes?filter_name=${encodeURIComponent(searchName)}`,
  );
  const build = list.build;
  if (!build) {
    return null;
  }
  const page = await fetchJson<PhyloPicNodeResponse>(
    `${PHYLOPIC_API_BASE}/nodes?build=${build}&filter_name=${encodeURIComponent(searchName)}&page=0&embed_items=true`,
  );
  const uuid = page._embedded?.items?.[0]?.uuid;
  return uuid ? { uuid, build } : null;
}

async function findPermissiveImage(nodeUuid: string, build: number): Promise<PhyloPicImageRecord | null> {
  const filterAttempts = [
    "filter_license_by=false&filter_license_nc=false&filter_license_sa=false",
    "filter_license_nc=false&filter_license_sa=false",
    "filter_license_nc=false",
  ];
  for (const filters of filterAttempts) {
    const response = await fetchJson<PhyloPicImagesResponse>(
      `${PHYLOPIC_API_BASE}/images?build=${build}&filter_clade=${nodeUuid}&${filters}&page=0&embed_items=true`,
    );
    const usable = (response._embedded?.items ?? []).find((item) => {
      const licenseUrl = item._links?.license?.href ?? "";
      return Boolean(item.uuid && pickImageFile(item) && licenseAllowsPublication(licenseUrl));
    });
    if (usable) {
      return usable;
    }
  }
  return null;
}

export function readCachedPhyloPicSilhouette(candidate: PhyloPicCandidate): PhyloPicSilhouette | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(cacheKey(candidate));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as PhyloPicSilhouette;
    return parsed?.dataUrl ? parsed : null;
  } catch {
    return null;
  }
}

export function writeCachedPhyloPicSilhouette(candidate: PhyloPicCandidate, silhouette: PhyloPicSilhouette): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(cacheKey(candidate), JSON.stringify(silhouette));
  } catch {
    // The in-memory state still works if localStorage is full or unavailable.
  }
}

export async function retrievePhyloPicSilhouette(candidate: PhyloPicCandidate): Promise<PhyloPicSilhouette | null> {
  const cached = readCachedPhyloPicSilhouette(candidate);
  if (cached) {
    return cached;
  }
  const node = await resolveNodeUuid(candidate);
  if (!node) {
    return null;
  }
  const image = await findPermissiveImage(node.uuid, node.build);
  if (!image) {
    return null;
  }
  const imageFile = pickImageFile(image);
  if (!image.uuid || !imageFile) {
    return null;
  }
  const dimensions = parseSizes(imageFile.sizes);
  const imageUrl = absolutePhyloPicUrl(imageFile.href);
  const dataUrl = await fetchDataUrl(imageUrl);
  const licenseUrl = image._links?.license?.href ?? "";
  const silhouette: PhyloPicSilhouette = {
    key: candidate.key,
    taxonLabel: candidate.taxonLabel,
    rank: candidate.rank,
    taxId: candidate.taxId,
    imageUuid: image.uuid,
    dataUrl,
    width: dimensions.width,
    height: dimensions.height,
    attribution: image.attribution || image._links?.contributor?.title || "PhyloPic contributor",
    licenseUrl,
    licenseLabel: licenseLabel(licenseUrl),
    sourceUrl: image._links?.self?.href ? absolutePhyloPicUrl(image._links.self.href) : `https://www.phylopic.org/images/${image.uuid}`,
  };
  writeCachedPhyloPicSilhouette(candidate, silhouette);
  return silhouette;
}

export function buildPhyloPicAttributionCaption(silhouettes: PhyloPicSilhouette[]): string {
  const unique = new Map<string, PhyloPicSilhouette>();
  for (const silhouette of silhouettes) {
    const license = `${silhouette.licenseLabel} ${silhouette.licenseUrl}`.toLowerCase();
    if (license.includes("cc0") || license.includes("zero/") || license.includes("public domain mark") || license.includes("/publicdomain/mark/")) {
      continue;
    }
    unique.set(silhouette.imageUuid, silhouette);
  }
  if (unique.size === 0) {
    return "";
  }
  const lines = Array.from(unique.values()).sort((left, right) => left.taxonLabel.localeCompare(right.taxonLabel)).map((item) => (
    `${item.taxonLabel} by ${item.attribution}, ${item.licenseLabel}`
  ));
  return `PhyloPic image attribution: ${lines.join("; ")}.`;
}
