import type { TaxonomyRank } from "../types/taxonomy";

const PHYLOPIC_API_BASE = "https://api.phylopic.org";
const PHYLOPIC_CACHE_PREFIX = "big-tree-viewer:phylopic:";
const PHYLOPIC_CACHE_VERSION = "v3";
const PHYLOPIC_IMAGE_CHECK_VERSION = 2;
const PHYLOPIC_MIN_VISIBLE_COVERAGE = 0.12;
const PHYLOPIC_GOOD_VISIBLE_COVERAGE = 0.28;
const PHYLOPIC_MIN_OPAQUE_PIXEL_FRACTION = 0.9;
const PHYLOPIC_MIN_DARK_PIXEL_FRACTION = 0.9;

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
  imageCheckVersion?: number;
  visibleCoverage?: number;
  opaquePixelFraction?: number;
  darkPixelFraction?: number;
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
  return `${PHYLOPIC_CACHE_PREFIX}${PHYLOPIC_CACHE_VERSION}:${candidate.key}`;
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

function pickImageFiles(record: PhyloPicImageRecord): Array<{ href: string; sizes?: string }> {
  const files: Array<{ href?: string; sizes?: string; type?: string }> = [];
  const rasterFiles = [...(record._links?.rasterFiles ?? [])]
    .filter((file) => file.href && file.type === "image/png")
    .sort((left, right) => parseSizes(right.sizes).width - parseSizes(left.sizes).width);
  files.push(...rasterFiles);
  const sourceFile = record._links?.sourceFile;
  if (sourceFile?.href && sourceFile.type === "image/png") {
    files.push(sourceFile);
  }
  const vectorFile = record._links?.vectorFile;
  if (vectorFile?.href) {
    files.push(vectorFile);
  }
  const seen = new Set<string>();
  return files.flatMap((file) => {
    if (!file.href || seen.has(file.href)) {
      return [];
    }
    seen.add(file.href);
    return [{ href: file.href, sizes: file.sizes }];
  });
}

function pickImageFile(record: PhyloPicImageRecord): { href: string; sizes?: string } | null {
  return pickImageFiles(record)[0] ?? null;
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

async function blobToDataUrl(blob: Blob): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read PhyloPic image."));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

async function analyzePhyloPicImage(blob: Blob): Promise<{
  dataUrl: string;
  width: number;
  height: number;
  visibleCoverage: number;
  opaquePixelFraction: number;
  darkPixelFraction: number;
}> {
  const dataUrl = await blobToDataUrl(blob);
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, bitmap.width);
  canvas.height = Math.max(1, bitmap.height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    bitmap.close();
    throw new Error("Unable to prepare PhyloPic image.");
  }
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  let visiblePixels = 0;
  let mostlyOpaquePixels = 0;
  let darkPixels = 0;
  for (let index = 0; index < data.length; index += 4) {
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const alpha = data[index + 3];
    if (alpha >= 32) {
      visiblePixels += 1;
      if (alpha >= 192) {
        mostlyOpaquePixels += 1;
      }
      if (Math.max(red, green, blue) <= 80) {
        darkPixels += 1;
      }
    }
  }
  return {
    dataUrl,
    width: canvas.width,
    height: canvas.height,
    visibleCoverage: visiblePixels / Math.max(1, canvas.width * canvas.height),
    opaquePixelFraction: visiblePixels > 0 ? mostlyOpaquePixels / visiblePixels : 0,
    darkPixelFraction: visiblePixels > 0 ? darkPixels / visiblePixels : 0,
  };
}

async function fetchAnalyzedPhyloPicImage(url: string): Promise<{
  dataUrl: string;
  width: number;
  height: number;
  visibleCoverage: number;
  opaquePixelFraction: number;
  darkPixelFraction: number;
}> {
  const response = await fetch(url, { credentials: "omit", mode: "cors" });
  if (response.status === 429) {
    throw new PhyloPicRateLimitError("PhyloPic image download rate limit reached.", retryAfterMs(response));
  }
  if (!response.ok) {
    throw new Error(`PhyloPic image download failed (${response.status} ${response.statusText}).`);
  }
  const blob = await response.blob();
  return await analyzePhyloPicImage(blob);
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

async function findPermissiveImages(nodeUuid: string, build: number): Promise<PhyloPicImageRecord[]> {
  const filterAttempts = [
    "filter_license_by=false&filter_license_nc=false&filter_license_sa=false",
    "filter_license_nc=false&filter_license_sa=false",
    "filter_license_nc=false",
  ];
  const byUuid = new Map<string, PhyloPicImageRecord>();
  for (const filters of filterAttempts) {
    const response = await fetchJson<PhyloPicImagesResponse>(
      `${PHYLOPIC_API_BASE}/images?build=${build}&filter_clade=${nodeUuid}&${filters}&page=0&embed_items=true`,
    );
    for (const item of response._embedded?.items ?? []) {
      const licenseUrl = item._links?.license?.href ?? "";
      if (item.uuid && !byUuid.has(item.uuid) && pickImageFile(item) && licenseAllowsPublication(licenseUrl)) {
        byUuid.set(item.uuid, item);
      }
    }
  }
  return Array.from(byUuid.values());
}

export function isUsablePhyloPicSilhouette(silhouette: PhyloPicSilhouette | null | undefined): silhouette is PhyloPicSilhouette {
  return Boolean(
    silhouette?.dataUrl
    && typeof silhouette.key === "string"
    && typeof silhouette.taxonLabel === "string"
    && typeof silhouette.imageUuid === "string"
    && typeof silhouette.width === "number"
    && typeof silhouette.height === "number",
  );
}

export function readCachedPhyloPicSilhouette(candidate: PhyloPicCandidate): PhyloPicSilhouette | null {
  if (typeof window === "undefined") {
    return null;
  }
  const key = cacheKey(candidate);
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as PhyloPicSilhouette;
    return isUsablePhyloPicSilhouette(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function deleteCachedPhyloPicSilhouette(candidate: PhyloPicCandidate): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.removeItem(cacheKey(candidate));
  } catch {
    // Ignore storage failures; in-memory state still reflects the user's action.
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

export async function retrievePhyloPicSilhouette(candidate: PhyloPicCandidate, excludedImageUuids: Iterable<string> = []): Promise<PhyloPicSilhouette | null> {
  const excluded = new Set(Array.from(excludedImageUuids).filter(Boolean));
  const cached = readCachedPhyloPicSilhouette(candidate);
  if (cached && !excluded.has(cached.imageUuid)) {
    return cached;
  }
  const node = await resolveNodeUuid(candidate);
  if (!node) {
    return null;
  }
  const images = await findPermissiveImages(node.uuid, node.build);
  if (images.length === 0) {
    return null;
  }
  let bestSilhouette: PhyloPicSilhouette | null = null;
  let bestVisibleCoverage = 0;
  for (const image of images) {
    if (image.uuid && excluded.has(image.uuid)) {
      continue;
    }
    const imageFiles = pickImageFiles(image);
    if (!image.uuid || imageFiles.length === 0) {
      continue;
    }
    let acceptedImage: Awaited<ReturnType<typeof fetchAnalyzedPhyloPicImage>> | null = null;
    let acceptedDimensions = { width: 1, height: 1 };
    for (const imageFile of imageFiles) {
      const imageUrl = absolutePhyloPicUrl(imageFile.href);
      let checkedImage: Awaited<ReturnType<typeof fetchAnalyzedPhyloPicImage>>;
      try {
        checkedImage = await fetchAnalyzedPhyloPicImage(imageUrl);
      } catch (error) {
        if (error instanceof PhyloPicRateLimitError) {
          throw error;
        }
        continue;
      }
      if (
        checkedImage.visibleCoverage < PHYLOPIC_MIN_VISIBLE_COVERAGE
        || checkedImage.opaquePixelFraction < PHYLOPIC_MIN_OPAQUE_PIXEL_FRACTION
        || checkedImage.darkPixelFraction < PHYLOPIC_MIN_DARK_PIXEL_FRACTION
      ) {
        continue;
      }
      acceptedImage = checkedImage;
      acceptedDimensions = parseSizes(imageFile.sizes);
      break;
    }
    if (!acceptedImage) {
      continue;
    }
    const licenseUrl = image._links?.license?.href ?? "";
    const silhouette: PhyloPicSilhouette = {
      key: candidate.key,
      taxonLabel: candidate.taxonLabel,
      rank: candidate.rank,
      taxId: candidate.taxId,
      imageUuid: image.uuid,
      dataUrl: acceptedImage.dataUrl,
      width: acceptedImage.width || acceptedDimensions.width,
      height: acceptedImage.height || acceptedDimensions.height,
      attribution: image.attribution || image._links?.contributor?.title || "PhyloPic contributor",
      licenseUrl,
      licenseLabel: licenseLabel(licenseUrl),
      sourceUrl: image._links?.self?.href ? absolutePhyloPicUrl(image._links.self.href) : `https://www.phylopic.org/images/${image.uuid}`,
      imageCheckVersion: PHYLOPIC_IMAGE_CHECK_VERSION,
      visibleCoverage: acceptedImage.visibleCoverage,
      opaquePixelFraction: acceptedImage.opaquePixelFraction,
      darkPixelFraction: acceptedImage.darkPixelFraction,
    };
    if (acceptedImage.visibleCoverage > bestVisibleCoverage) {
      bestSilhouette = silhouette;
      bestVisibleCoverage = acceptedImage.visibleCoverage;
      if (bestVisibleCoverage >= PHYLOPIC_GOOD_VISIBLE_COVERAGE) {
        break;
      }
    }
  }
  if (bestSilhouette) {
    writeCachedPhyloPicSilhouette(candidate, bestSilhouette);
  }
  return bestSilhouette;
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
  return lines.join("; ");
}

export function buildPhyloPicLicenseDetails(silhouettes: PhyloPicSilhouette[]): string {
  const unique = new Map<string, PhyloPicSilhouette>();
  for (const silhouette of silhouettes) {
    const license = `${silhouette.licenseLabel} ${silhouette.licenseUrl}`.toLowerCase();
    if (!(license.includes("cc0") || license.includes("zero/") || license.includes("public domain mark") || license.includes("/publicdomain/mark/"))) {
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
  return lines.join("; ");
}
