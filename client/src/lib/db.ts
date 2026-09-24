/**
 * A minimal promise wrapper over IndexedDB.
 *
 * Three stores, four operations, no dependency. `idb` is 2 KB of very good
 * code, but this app needs get/put/del over key-value stores and nothing else,
 * and a storage layer is not somewhere to inherit an upgrade path from.
 *
 *   state     device-local and profile state: the snapshot arrays, the
 *             device-only settings, the sync credential.
 *   corpus    manifest, tier array and the compressed headword index, keyed by
 *             corpusVersion so a migration can still read the old one.
 */

const DB_NAME = 'thewholedictionary';
const DB_VERSION = 1;

export type StoreName = 'state' | 'corpus';
const STORES: StoreName[] = ['state', 'corpus'];

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
  dbPromise = promise;

  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    for (const name of STORES) {
      if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
    }
  };
  request.onsuccess = () => {
    const db = request.result;
    // A second tab that upgrades the schema would otherwise block forever.
    db.onversionchange = () => db.close();
    resolve(db);
  };
  request.onerror = () => {
    dbPromise = null;
    reject(request.error ?? new Error('indexedDB.open failed'));
  };
  return promise;
}

async function run<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const db = await openDb();
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const tx = db.transaction(store, mode);
  const request = fn(tx.objectStore(store));
  request.onsuccess = () => resolve(request.result as T);
  request.onerror = () => reject(request.error ?? new Error(`${store} request failed`));
  tx.onabort = () => reject(tx.error ?? new Error(`${store} transaction aborted`));
  return promise;
}

export function get<T>(store: StoreName, key: string): Promise<T | undefined> {
  return run<T | undefined>(store, 'readonly', (s) => s.get(key));
}

export function put(store: StoreName, key: string, value: unknown): Promise<void> {
  return run<void>(store, 'readwrite', (s) => s.put(value, key));
}

export function del(store: StoreName, key: string): Promise<void> {
  return run<void>(store, 'readwrite', (s) => s.delete(key));
}

export function keys(store: StoreName): Promise<string[]> {
  return run<string[]>(store, 'readonly', (s) => s.getAllKeys() as IDBRequest);
}

export async function clearAll(): Promise<void> {
  for (const store of STORES) await run<void>(store, 'readwrite', (s) => s.clear());
}
