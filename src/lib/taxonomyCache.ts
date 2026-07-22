import type { TaxonomyMapPayload } from "../types/taxonomy";
import type { SharedSubtreeStoragePayload } from "./sharedSubtreePayload";

const DB_NAME = "big-tree-viewer-taxonomy";
const ARCHIVE_STORE_NAME = "archives";
const MAPPING_STORE_NAME = "mappings";
const SUBTREE_STORE_NAME = "shared-subtrees";
const ARCHIVE_KEY = "ncbi-taxdmp-zip";
const ARCHIVE_FILE_HANDLE_KEY = "ncbi-taxdmp-file-handle";
const LATEST_MAPPING_KEY = "latest-tree-mapping";
const TAXONOMY_MAPPING_CACHE_VERSION = 6;
let cachedArchiveInMemory: Blob | ArrayBuffer | null = null;
let linkedArchiveHandleInMemory: TaxonomyArchiveFileHandle | null | undefined;

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
  payload: TaxonomyMapPayload;
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

async function persistTaxonomyArchive(archive: Blob | ArrayBuffer): Promise<void> {
  await persistArchiveStoreValue(ARCHIVE_KEY, archive);
}

async function getLinkedTaxonomyArchiveHandle(): Promise<TaxonomyArchiveFileHandle | null> {
  if (linkedArchiveHandleInMemory !== undefined) {
    return linkedArchiveHandleInMemory;
  }
  const stored = await readArchiveStoreValue(ARCHIVE_FILE_HANDLE_KEY);
  linkedArchiveHandleInMemory = isTaxonomyArchiveFileHandle(stored) ? stored : null;
  return linkedArchiveHandleInMemory;
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

export async function getLinkedTaxonomyArchiveStatus(): Promise<LinkedTaxonomyArchiveStatus | null> {
  const handle = await getLinkedTaxonomyArchiveHandle();
  if (!handle) {
    return null;
  }
  return {
    name: handle.name,
    permission: await queryTaxonomyFilePermission(handle),
  };
}

export async function readLinkedTaxonomyArchive(requestPermission = false): Promise<File | null> {
  const handle = await getLinkedTaxonomyArchiveHandle();
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
  cachedArchiveInMemory = file;
  return file;
}

export async function linkTaxonomyArchiveFile(handle: TaxonomyArchiveFileHandle): Promise<"persistent" | "memory"> {
  linkedArchiveHandleInMemory = handle;
  try {
    await persistArchiveStoreValue(ARCHIVE_FILE_HANDLE_KEY, handle);
    return "persistent";
  } catch {
    return "memory";
  }
}

export function useTaxonomyArchiveForSession(archive: Blob | ArrayBuffer): void {
  cachedArchiveInMemory = archive instanceof ArrayBuffer ? cloneArchiveBuffer(archive) : archive;
}

export async function getCachedTaxonomyArchive(): Promise<Blob | ArrayBuffer | null> {
  if (cachedArchiveInMemory instanceof Blob) {
    return cachedArchiveInMemory;
  }
  if (cachedArchiveInMemory instanceof ArrayBuffer) {
    return cloneArchiveBuffer(cachedArchiveInMemory);
  }
  const linkedArchive = await readLinkedTaxonomyArchive(false);
  if (linkedArchive) {
    return linkedArchive;
  }
  const archive = await readArchiveStoreValue(ARCHIVE_KEY);
  if (archive instanceof Blob) {
    cachedArchiveInMemory = archive;
    return archive;
  }
  if (archive instanceof ArrayBuffer) {
    cachedArchiveInMemory = cloneArchiveBuffer(archive);
    return cloneArchiveBuffer(archive);
  }
  return null;
}

export async function putCachedTaxonomyArchive(archive: Blob | ArrayBuffer): Promise<"persistent" | "memory"> {
  cachedArchiveInMemory = archive instanceof ArrayBuffer ? cloneArchiveBuffer(archive) : archive;
  try {
    await persistTaxonomyArchive(archive);
    return "persistent";
  } catch (error) {
    if (archive instanceof Blob) {
      try {
        await persistTaxonomyArchive(await archive.arrayBuffer());
        return "persistent";
      } catch {
        return "memory";
      }
    }
    if (archive instanceof ArrayBuffer) {
      try {
        await persistTaxonomyArchive(cloneArchiveBuffer(archive));
        return "persistent";
      } catch {
        return "memory";
      }
    }
    throw error;
  }
}

export async function getCachedTaxonomyMapping(treeSignature: string): Promise<TaxonomyMapPayload | null> {
  const db = await openTaxonomyDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(MAPPING_STORE_NAME, "readonly");
    const store = transaction.objectStore(MAPPING_STORE_NAME);
    const request = store.get(LATEST_MAPPING_KEY);
    request.onsuccess = () => {
      const record = (request.result as CachedTaxonomyMappingRecord | undefined) ?? null;
      if (!record || record.version !== TAXONOMY_MAPPING_CACHE_VERSION || record.treeSignature !== treeSignature) {
        resolve(null);
        return;
      }
      resolve(record.payload);
    };
    request.onerror = () => reject(request.error ?? new Error("Unable to read taxonomy mapping cache."));
    transaction.oncomplete = () => db.close();
  });
}

export async function putCachedTaxonomyMapping(treeSignature: string, payload: TaxonomyMapPayload): Promise<void> {
  const db = await openTaxonomyDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(MAPPING_STORE_NAME, "readwrite");
    const store = transaction.objectStore(MAPPING_STORE_NAME);
    const request = store.put({
      version: TAXONOMY_MAPPING_CACHE_VERSION,
      treeSignature,
      payload,
    } satisfies CachedTaxonomyMappingRecord, LATEST_MAPPING_KEY);
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
