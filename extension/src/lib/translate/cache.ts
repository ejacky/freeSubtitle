import { sha256Hex } from '../hash';

const DB_NAME = 'freeSubtitle';
const DB_VERSION = 1;
const STORE = 'translations';

interface CacheRecord {
  key: string;
  zh: string;
  provider?: string;
  createdAt: number;
  hits: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;
let writesSincePrune = 0;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
  return dbPromise;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export async function makeCacheKey(parts: {
  version: number;
  targetLang: string;
  source: string;
  context?: string[];
  glossary?: string;
}): Promise<string> {
  const normalized = [
    `v${parts.version}`,
    parts.targetLang,
    parts.source.replace(/\s+/g, ' ').trim(),
    (parts.context ?? []).join('\n').slice(-500),
    (parts.glossary ?? '').slice(0, 500),
  ].join('\u241f');
  return sha256Hex(normalized);
}

export async function getCached(
  key: string,
  ttlDays: number,
): Promise<{ zh: string; provider?: string } | null> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const req = store.get(key);
    const record = await new Promise<CacheRecord | undefined>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result as CacheRecord | undefined);
      req.onerror = () => reject(req.error);
    });
    if (!record) {
      await txDone(tx);
      return null;
    }
    const ageMs = Date.now() - record.createdAt;
    if (ttlDays > 0 && ageMs > ttlDays * 86_400_000) {
      store.delete(key);
      await txDone(tx);
      return null;
    }
    record.hits = (record.hits ?? 0) + 1;
    store.put(record);
    await txDone(tx);
    return { zh: record.zh, provider: record.provider };
  } catch {
    return null;
  }
}

export async function putCached(
  key: string,
  zh: string,
  provider?: string,
  maxEntries = 20_000,
): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({
      key,
      zh,
      provider,
      createdAt: Date.now(),
      hits: 0,
    } satisfies CacheRecord);
    await txDone(tx);
    writesSincePrune++;
    if (writesSincePrune >= 200) {
      writesSincePrune = 0;
      await pruneCache(maxEntries, 30);
    }
  } catch {
    // Cache is best-effort.
  }
}

export async function pruneCache(maxEntries: number, ttlDays: number): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const records = await new Promise<CacheRecord[]>((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve((req.result ?? []) as CacheRecord[]);
      req.onerror = () => reject(req.error);
    });

    const now = Date.now();
    const ttlMs = ttlDays > 0 ? ttlDays * 86_400_000 : Infinity;
    let removed = 0;
    for (const record of records) {
      if (now - record.createdAt > ttlMs) {
        store.delete(record.key);
        removed++;
      }
    }

    const remaining = records.length - removed;
    if (remaining > maxEntries) {
      const survivors = records
        .filter((record) => now - record.createdAt <= ttlMs)
        .sort((a, b) => a.createdAt - b.createdAt);
      const toDelete = remaining - maxEntries;
      for (let i = 0; i < toDelete && i < survivors.length; i++) {
        store.delete(survivors[i]!.key);
      }
    }
    await txDone(tx);
  } catch {
    // ignore
  }
}

export async function clearCache(): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    await txDone(tx);
  } catch {
    // ignore
  }
}

export async function cacheCount(): Promise<number> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).count();
    return await new Promise<number>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return 0;
  }
}
