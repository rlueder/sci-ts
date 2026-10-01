import { APP_ID } from "./app.ts";
import { MemorySaveStore, type SaveInfo, type VmSnapshot } from "@sci-ts/sci";

const DB = APP_ID;
const STORE = "saves";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Saved games in IndexedDB (per browser, survive reloads). Kernels need synchronous access,
 * so everything is loaded into a MemorySaveStore at startup and writes go through to disk.
 *
 * A save is a snapshot of the running scripts, so it only fits the scripts it was made with:
 * each set of mods gets its own saves (`namespace`, e.g. "altar-hello"). The unmodded game
 * keeps plain numeric keys, as before namespaces existed.
 */
export async function browserSaveStore(namespace = ""): Promise<MemorySaveStore> {
  const store = new MemorySaveStore();
  const key = (id: number): IDBValidKey => (namespace ? `${namespace}:${id}` : id);
  const mine = (k: IDBValidKey) => (namespace ? typeof k === "string" && k.startsWith(`${namespace}:`) : typeof k === "number");
  let db: IDBDatabase | undefined;
  try {
    db = await open();
    await new Promise<void>((resolve, reject) => {
      const req = db!.transaction(STORE).objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve();
        if (mine(cursor.key)) {
          const save = cursor.value as { info: SaveInfo; snapshot: VmSnapshot };
          store.saves.set(save.info.id, save);
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn("Saved games unavailable (IndexedDB blocked?); saves will last until reload.", e);
  }
  store.onWrite = (info, snapshot) => {
    db?.transaction(STORE, "readwrite").objectStore(STORE).put({ info, snapshot }, key(info.id));
  };
  return store;
}
