// Main-thread wrapper around the fusion worker.

export class FusionClient {
  constructor() {
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.busy = false; // a frame is being integrated
    this.stats = { blocks: 0, voxels: 0, frames: 0 };
    this.lastMs = 0;
    this.calibrating = false;
    this.orientation = null;
    this.onStatus = null;
    this.onError = null;
    this._req = new Map();
    this._id = 0;
    this.worker.onmessage = (ev) => this._onMessage(ev.data);
    this.worker.onerror = (ev) => this.onError?.(ev.message || 'Worker-Fehler');
  }

  _onMessage(m) {
    switch (m.type) {
      case 'integrated':
        this.busy = false;
        this.stats = m.stats;
        this.lastMs = m.ms;
        this.calibrating = m.calibrating;
        this.onStatus?.();
        break;
      case 'orientation':
      case 'ready':
        this.orientation = m.orientation;
        this.onStatus?.();
        break;
      case 'orientation-progress':
        this.orientationProgress = m;
        break;
      case 'mesh': {
        const r = this._req.get(m.id);
        this._req.delete(m.id);
        const mesh = { positions: m.positions, indices: m.indices, ms: m.ms };
        if (m.colors) mesh.colors = m.colors;
        r?.resolve(mesh);
        break;
      }
      case 'error': {
        this.busy = false;
        const r = this._req.get(m.id);
        if (r) { this._req.delete(m.id); r.reject(new Error(m.message)); }
        this.onError?.(m.message);
        break;
      }
    }
  }

  init(config, orientation = 'auto') {
    this.worker.postMessage({ type: 'init', config, orientation });
  }

  setBox(box) {
    this.worker.postMessage({ type: 'box', box });
  }

  clear() {
    this.worker.postMessage({ type: 'clear' });
  }

  clearColor() {
    this.worker.postMessage({ type: 'clearColor' });
  }

  // Hands over a depth frame, optionally with a color frame (buffers are transferred).
  // Returns false while busy.
  pushFrame(f) {
    if (this.busy) return false;
    this.busy = true;
    const transfer = [f.depth.buffer];
    if (f.color) transfer.push(f.color.rgba.buffer);
    this.worker.postMessage({ type: 'frame', ...f }, transfer);
    return true;
  }

  extract(minWeight = 2, clean = false) {
    const id = ++this._id;
    return new Promise((resolve, reject) => {
      this._req.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'extract', id, minWeight, clean });
    });
  }

  dispose() {
    this.worker.terminate();
  }
}
