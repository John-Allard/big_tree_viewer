import type { TaxonomyMapPayload, TaxonomySource } from "../types/taxonomy";
import type { SharedSubtreeStoragePayload } from "./sharedSubtreePayload";

const DB_NAME = "big-tree-viewer-taxonomy";
const ARCHIVE_STORE_NAME = "archives";
const MAPPING_STORE_NAME = "mappings";
const SUBTREE_STORE_NAME = "shared-subtrees";
const TAXONOMY_MAPPING_CACHE_VERSION = 7;
const CATALOGUE_OF_LIFE_MAPPING_CACHE_VERSION = 8;
const cachedArchiveInMemory = new Map<TaxonomySource, Blob | ArrayBuffer>();
const linkedArchiveHandleInMemory = new Map<TaxonomySource, TaxonomyArchiveFileHandle | null>();

export interface TaxonomyArchiveFileHandle {
  kind: "file";
  name: string;
  getFile: () => Promise<File>;
  queryPermission?: (descriptor?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (descriptor?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
}

export interface LinkedTaxonomyArchiveStatus {
  name: string;
  permission: PermissionState;
}

interface CachedTaxonomyMappingRecord {
  version: number;
  treeSignature: string;
  source?: TaxonomySource;
  payload: TaxonomyMapPayload;
}

function archiveKey(source: TaxonomySource): string {
  return source === "ncbi" ? "ncbi-taxdmp-zip" : "catalogue-of-life-texttree-zip";
}

function archiveFileHandleKey(source: TaxonomySource): string {
  return source === "ncbi" ? "ncbi-taxdmp-file-handle" : "catalogue-of-life-texttree-file-handle";
}

function mappingKey(source: TaxonomySource): string {
  return source === "ncbi" ? "latest-tree-mapping" : `latest-tree-mapping:${source}`;
}

function mappingCacheVersion(source: TaxonomySource): number {
  return source === "catalogue-of-life"
    ? CATALOGUE_OF_LIFE_MAPPING_CACHE_VERSION
    : TAXONOMY_MAPPING_CACHE_VERSION;
}

function openTaxonomyDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 3);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ARCHIVE_STORE_NAME)) {
        db.createObjectStore(ARCHIVE_STORE_NAME);
      }
      if (!db.objectStoreNames.contains(MAPPING_STORE_NAME)) {
        db.createObjectStore(MAPPING_STORE_NAME);
      }
      if (!db.objectStoreNames.contains(SUBTREE_STORE_NAME)) {
        db.createObjectStore(SUBTREE_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open taxonomy cache."));
  });
}

function cloneArchiveBuffer(buffer: ArrayBuffer): ArrayBuffer {
  return buffer.slice(0);
}

function isTaxonomyArchiveFileHandle(value: unknown): value is TaxonomyArchiveFileHandle {
  return Boolean(
    value
    && typeof value === "object"
    && (value as { kind?: unknown }).kind === "file"
    && typeof (value as { name?: unknown }).name === "string"
    && typeof (value as { getFile?: unknown }).getFile === "function",
  );
}

async function readArchiveStoreValue(key: string): Promise<unknown> {
  const db = await openTaxonomyDb();
  return await new Promise((resolve, reject) => {
    const transaction = db.transaction(ARCHIVE_STORE_NAME, "readonly");
    const request = transaction.objectStore(ARCHIVE_STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to read taxonomy cache."));
    transaction.oncomplete = () => db.close();
  });
}

async function persistArchiveStoreValue(key: string, value: unknown): Promise<void> {
  const db = await openTaxonomyDb();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(ARCHIVE_STORE_NAME, "readwrite");
    const store = transaction.objectStore(ARCHIVE_STORE_NAME);
    const request = store.put(value, key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("Unable to update taxonomy cache."));
    transaction.oncomplete = () => db.close();
  });
}

async function persistTaxonomyArchive(source: TaxonomySource, archive: Blob | ArrayBuffer): Promise<void> {
  await persistArchiveStoreValue(archiveKey(source), archive);
}

async function getLinkedTaxonomyArchiveHandle(source: TaxonomySource): Promise<TaxonomyArchiveFileHandle | null> {
  if (linkedArchiveHandleInMemory.has(source)) {
    return linkedArchiveHandleInMemory.get(source) ?? null;
  }
  const stored = await readArchiveStoreValue(archiveFileHandleKey(source));
  const handle = isTaxonomyArchiveFileHandle(stored) ? stored : null;
  linkedArchiveHandleInMemory.set(source, handle);
  return handle;
}

async function queryTaxonomyFilePermission(handle: TaxonomyArchiveFileHandle): Promise<PermissionState> {
  if (typeof handle.queryPermission === "function") {
    try {
      return await handle.queryPermission({ mode: "read" });
    } catch {
      return "prompt";
    }
  }
  try {
    await handle.getFile();
    return "granted";
  } catch {
    return "denied";
  }
}

export async function getLinkedTaxonomyArchiveStatus(source: TaxonomySource = "ncbi"): Promise<LinkedTaxonomyArchiveStatus | null> {
  const handle = await getLinkedTaxonomyArchiveHandle(source);
  if (!handle) {
    return null;
  }
  return {
    name: handle.name,
    permission: await queryTaxonomyFilePermission(handle),
  };
}

export async function readLinkedTaxonomyArchive(source: TaxonomySource = "ncbi", requestPermission = false): Promise<File | null> {
  const handle = await getLinkedTaxonomyArchiveHandle(source);
  if (!handle) {
    return null;
  }
  let permission = await queryTaxonomyFilePermission(handle);
  if (permission !== "granted" && requestPermission && typeof handle.requestPermission === "function") {
    permission = await handle.requestPermission({ mode: "read" });
  }
  if (permission !== "granted") {
    return null;
  }
  const file = await handle.getFile();
  cachedArchiveInMemory.set(source, file);
  return file;
}

export async function linkTaxonomyArchiveFile(source: TaxonomySource, handle: TaxonomyArchiveFileHandle): Promise<"persistent" | "memory"> {
  linkedArchiveHandleInMemory.set(source, handle);
  try {
    await persistArchiveStoreValue(archiveFileHandleKey(source), handle);
    return "persistent";
  } catch {
    return "memory";
  }
}

export function useTaxonomyArchiveForSession(source: TaxonomySource, archive: Blob | ArrayBuffer): void {
  cachedArchiveInMemory.set(source, archive instanceof ArrayBuffer ? cloneArchiveBuffer(archive) : archive);
}

export async function getCachedTaxonomyArchive(source: TaxonomySource = "ncbi"): Promise<Blob | ArrayBuffer | null> {
  const inMemory = cachedArchiveInMemory.get(source);
  if (inMemory instanceof Blob) {
    return inMemory;
  }
  if (inMemory instanceof ArrayBuffer) {
    return cloneArchiveBuffer(inMemory);
  }
  const linkedArchive = await readLinkedTaxonomyArchive(source, false);
  if (linkedArchive) {
    return linkedArchive;
  }
  const archive = await readArchiveStoreValue(archiveKey(source));
  if (archive instanceof Blob) {
    cachedArchiveInMemory.set(source, archive);
    return archive;
  }
  if (archive instanceof ArrayBuffer) {
    cachedArchiveInMemory.set(source, cloneArchiveBuffer(archive));
    return cloneArchiveBuffer(archive);
  }
  return null;
}

export async function putCachedTaxonomyArchive(source: TaxonomySource, archive: Blob | ArrayBuffer): Promise<"persistent" | "memory"> {
  cachedArchiveInMemory.set(source, archive instanceof ArrayBuffer ? cloneArchiveBuffer(archive) : archive);
  try {
    await persistTaxonomyArchive(source, archive);
    return "persistent";
  } catch (error) {
    if (archive instanceof Blob) {
      try {
        await persistTaxonomyArchive(source, await archive.arrayBuffer());
        return "persistent";
      } catch {
        return "memory";
      }
    }
    if (archive instanceof ArrayBuffer) {
      try {
        await persistTaxonomyArchive(source, cloneArchiveBuffer(archive));
        return "persistent";
      } catch {
        return "memory";
      }
    }
    throw error;
  }
}

export async function getCachedTaxonomyMapping(treeSignature: string, source: TaxonomySource = "ncbi"): Promise<TaxonomyMapPayload | null> {
  const db = await openTaxonomyDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(MAPPING_STORE_NAME, "readonly");
    const store = transaction.objectStore(MAPPING_STORE_NAME);
    const request = store.get(mappingKey(source));
    request.onsuccess = () => {
      const record = (request.result as CachedTaxonomyMappingRecord | undefined) ?? null;
      const recordSource = record?.source ?? record?.payload.source ?? "ncbi";
      if (!record || record.version !== mappingCacheVersion(source) || record.treeSignature !== treeSignature || recordSource !== source) {
        resolve(null);
        return;
      }
      resolve(record.payload);
    };
    request.onerror = () => reject(request.error ?? new Error("Unable to read taxonomy mapping cache."));
    transaction.oncomplete = () => db.close();
  });
}

export async function putCachedTaxonomyMapping(treeSignature: string, payload: TaxonomyMapPayload, source: TaxonomySource = payload.source ?? "ncbi"): Promise<void> {
  const db = await openTaxonomyDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(MAPPING_STORE_NAME, "readwrite");
    const store = transaction.objectStore(MAPPING_STORE_NAME);
    const request = store.put({
      version: mappingCacheVersion(source),
      treeSignature,
      source,
      payload,
    } satisfies CachedTaxonomyMappingRecord, mappingKey(source));
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("Unable to update taxonomy mapping cache."));
    transaction.oncomplete = () => db.close();
  });
}

export async function getSharedSubtreePayload(key: string): Promise<SharedSubtreeStoragePayload | null> {
  const db = await openTaxonomyDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(SUBTREE_STORE_NAME, "readonly");
    const store = transaction.objectStore(SUBTREE_STORE_NAME);
    const request = store.get(key);
    request.onsuccess = () => resolve((request.result as SharedSubtreeStoragePayload | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error("Unable to read shared subtree payload."));
    transaction.oncomplete = () => db.close();
  });
}

export async function putSharedSubtreePayload(key: string, payload: SharedSubtreeStoragePayload): Promise<void> {
  const db = await openTaxonomyDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(SUBTREE_STORE_NAME, "readwrite");
    const store = transaction.objectStore(SUBTREE_STORE_NAME);
    const request = store.put(payload, key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("Unable to store shared subtree payload."));
    transaction.oncomplete = () => db.close();
  });
}
