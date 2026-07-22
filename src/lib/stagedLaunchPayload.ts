const DB_NAME = "big-tree-viewer-launches";
const STORE_NAME = "payloads";
const STAGED_LAUNCH_TTL_MS = 10 * 60 * 1000;

interface StagedLaunchRecord {
  createdAt: number;
  payload: unknown;
}

function openLaunchDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open staged launch storage."));
  });
}

function launchKey(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const random = crypto.getRandomValues(new Uint32Array(4));
  return Array.from(random, (value) => value.toString(16).padStart(8, "0")).join("");
}

function isStagedLaunchRecord(value: unknown): value is StagedLaunchRecord {
  return Boolean(
    value
    && typeof value === "object"
    && typeof (value as { createdAt?: unknown }).createdAt === "number"
    && "payload" in value,
  );
}

export async function stageLaunchPayload(payload: unknown): Promise<string> {
  const key = launchKey();
  const db = await openLaunchDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put({ createdAt: Date.now(), payload } satisfies StagedLaunchRecord, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Unable to stage the Big Tree Viewer launch."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Unable to stage the Big Tree Viewer launch."));
  });
  db.close();
  return key;
}

export async function consumeStagedLaunchPayload(key: string): Promise<unknown | null> {
  if (!/^[a-z0-9-]{16,80}$/i.test(key)) {
    return null;
  }
  const db = await openLaunchDb();
  const payload = await new Promise<unknown | null>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(key);
    let result: unknown | null = null;
    request.onsuccess = () => {
      const record = request.result;
      if (isStagedLaunchRecord(record) && Date.now() - record.createdAt <= STAGED_LAUNCH_TTL_MS) {
        result = record.payload;
      }
      store.delete(key);
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error ?? new Error("Unable to read the staged Big Tree Viewer launch."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Unable to read the staged Big Tree Viewer launch."));
  });
  db.close();
  return payload;
}

export async function deleteExpiredStagedLaunchPayloads(): Promise<void> {
  const db = await openLaunchDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        return;
      }
      const record = cursor.value;
      if (!isStagedLaunchRecord(record) || Date.now() - record.createdAt > STAGED_LAUNCH_TTL_MS) {
        cursor.delete();
      }
      cursor.continue();
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Unable to clean staged Big Tree Viewer launches."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Unable to clean staged Big Tree Viewer launches."));
  });
  db.close();
}
