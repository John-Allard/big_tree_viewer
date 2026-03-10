import type { TaxonomyMapPayload } from "../types/taxonomy";

const DB_NAME = "big-tree-viewer-taxonomy";
const ARCHIVE_STORE_NAME = "archives";
const MAPPING_STORE_NAME = "mappings";
const ARCHIVE_KEY = "ncbi-taxdmp-zip";
const LATEST_MAPPING_KEY = "latest-tree-mapping";

interface CachedTaxonomyMappingRecord {
  treeSignature: string;
  payload: TaxonomyMapPayload;
}

function openTaxonomyDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ARCHIVE_STORE_NAME)) {
        db.createObjectStore(ARCHIVE_STORE_NAME);
      }
      if (!db.objectStoreNames.contains(MAPPING_STORE_NAME)) {
        db.createObjectStore(MAPPING_STORE_NAME);
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
      if (!record || record.treeSignature !== treeSignature) {
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
    const request = store.put({ treeSignature, payload } satisfies CachedTaxonomyMappingRecord, LATEST_MAPPING_KEY);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("Unable to update taxonomy mapping cache."));
    transaction.oncomplete = () => db.close();
  });
}
