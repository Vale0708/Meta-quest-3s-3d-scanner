// Saves scans in IndexedDB (stays on the device in the browser).
const DB = 'quest-3d-scanner';
const STORE = 'scans';

function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(req?.result); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}

export const saveScan = (rec) => tx('readwrite', (s) => s.put(rec));
export const getScan = (id) => tx('readonly', (s) => s.get(id));
export const deleteScan = (id) => tx('readwrite', (s) => s.delete(id));

// List without the large geometry data
export async function listScans() {
  const db = await open();
  return new Promise((resolve, reject) => {
    const out = [];
    const t = db.transaction(STORE, 'readonly');
    const req = t.objectStore(STORE).openCursor(null, 'prev');
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      const v = c.value;
      out.push({ id: v.id, name: v.name, mode: v.mode, created: v.created, tris: v.mesh.indices.length / 3, measurements: v.measurements.length, sceneMeshes: v.sceneMeshes.length });
      c.continue();
    };
    t.oncomplete = () => { db.close(); resolve(out); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}
