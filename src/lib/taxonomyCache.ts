const DB_NAME = "big-tree-viewer-taxonomy";
const STORE_NAME = "archives";
const ARCHIVE_KEY = "ncbi-taxdmp-zip";

function openTaxonomyDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open taxonomy cache."));
  });
}

export async function getCachedTaxonomyArchive(): Promise<Blob | null> {
  const db = await openTaxonomyDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(ARCHIVE_KEY);
    request.onsuccess = () => resolve((request.result as Blob | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error("Unable to read taxonomy cache."));
    transaction.oncomplete = () => db.close();
  });
}

export async function putCachedTaxonomyArchive(archive: Blob): Promise<void> {
  const db = await openTaxonomyDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(archive, ARCHIVE_KEY);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("Unable to update taxonomy cache."));
    transaction.oncomplete = () => db.close();
  });
}
