import type { TaxonomyMapPayload } from "../types/taxonomy";
import type { SharedSubtreeStoragePayload } from "./sharedSubtreePayload";

const DB_NAME = "big-tree-viewer-taxonomy";
const ARCHIVE_STORE_NAME = "archives";
const MAPPING_STORE_NAME = "mappings";
const SUBTREE_STORE_NAME = "shared-subtrees";
const ARCHIVE_KEY = "ncbi-taxdmp-zip";
const LATEST_MAPPING_KEY = "latest-tree-mapping";
const TAXONOMY_MAPPING_CACHE_VERSION = 3;

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

export async function getCachedTaxonomyArchive(): Promise<Blob | null> {
  const db = await openTaxonomyDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(ARCHIVE_STORE_NAME, "readonly");
    const store = transaction.objectStore(ARCHIVE_STORE_NAME);
    const request = store.get(ARCHIVE_KEY);
    request.onsuccess = () => resolve((request.result as Blob | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error("Unable to read taxonomy cache."));
    transaction.oncomplete = () => db.close();
  });
}

export async function putCachedTaxonomyArchive(archive: Blob): Promise<void> {
  const db = await openTaxonomyDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(ARCHIVE_STORE_NAME, "readwrite");
    const store = transaction.objectStore(ARCHIVE_STORE_NAME);
    const request = store.put(archive, ARCHIVE_KEY);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("Unable to update taxonomy cache."));
    transaction.oncomplete = () => db.close();
  });
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
