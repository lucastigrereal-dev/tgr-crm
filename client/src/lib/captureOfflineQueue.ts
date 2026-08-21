export type CaptureOfflinePayload = Record<string, unknown>;

export type CaptureOfflineItem = {
  id: string;
  dedupeKey: string;
  payload: CaptureOfflinePayload;
  createdAt: string;
  attempts: number;
  lastError?: string;
};

const DB_NAME = "tgr-crm-capture-offline";
const STORE = "captures";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const database = request.result;
      const store = database.createObjectStore(STORE, { keyPath: "id" });
      store.createIndex("dedupeKey", "dedupeKey", { unique: true });
    };
    request.onsuccess = () => resolve(request.result);
  });
}

export function captureDedupeKey(payload: CaptureOfflinePayload) {
  const customer = (payload.customer ?? {}) as Record<string, unknown>;
  return [customer.fullName, customer.phone, payload.resortId, payload.scheduledAt]
    .map(value => String(value ?? "").trim().toLowerCase())
    .join("|");
}

export async function listOfflineCaptures(): Promise<CaptureOfflineItem[]> {
  const database = await openDatabase();
  return await new Promise((resolve, reject) => {
    const request = database.transaction(STORE, "readonly").objectStore(STORE).getAll();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve((request.result as CaptureOfflineItem[]).sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  });
}

export async function enqueueOfflineCapture(payload: CaptureOfflinePayload): Promise<CaptureOfflineItem> {
  const database = await openDatabase();
  const item: CaptureOfflineItem = { id: crypto.randomUUID(), dedupeKey: captureDedupeKey(payload), payload, createdAt: new Date().toISOString(), attempts: 0 };
  return await new Promise((resolve, reject) => {
    const store = database.transaction(STORE, "readwrite").objectStore(STORE);
    const indexRequest = store.index("dedupeKey").get(item.dedupeKey);
    indexRequest.onerror = () => reject(indexRequest.error);
    indexRequest.onsuccess = () => {
      const current = indexRequest.result as CaptureOfflineItem | undefined;
      if (current) return resolve(current);
      const putRequest = store.put(item);
      putRequest.onerror = () => reject(putRequest.error);
      putRequest.onsuccess = () => resolve(item);
    };
  });
}

export async function removeOfflineCapture(id: string) {
  const database = await openDatabase();
  return await new Promise<void>((resolve, reject) => {
    const request = database.transaction(STORE, "readwrite").objectStore(STORE).delete(id);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

export async function markOfflineCaptureFailed(id: string, error: string) {
  const database = await openDatabase();
  return await new Promise<void>((resolve, reject) => {
    const store = database.transaction(STORE, "readwrite").objectStore(STORE);
    const getRequest = store.get(id);
    getRequest.onerror = () => reject(getRequest.error);
    getRequest.onsuccess = () => {
      const current = getRequest.result as CaptureOfflineItem | undefined;
      if (!current) return resolve();
      const request = store.put({ ...current, attempts: current.attempts + 1, lastError: error });
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    };
  });
}
