// Color camera via getUserMedia (Quest Browser: passthrough cameras, if the
// browser exposes them). The browser provides no intrinsics/extrinsics, so
// a simple pinhole model is used (horizontal FOV, offset to the head, yaw/pitch),
// which can be adjusted in VR with "Farbe ausrichten".

const MODEL_KEY = 'quest-scanner-color-model';
const DEVICE_KEY = 'quest-scanner-color-device';

// Starting values: left front camera of the Quest 3/3S, roughly in front of the left eye.
export const DEFAULT_MODEL = { hfov: 72, offset: [-0.032, -0.015, -0.06], yaw: 0, pitch: 0, latency: 40 };

export function loadModel() {
  try {
    const m = JSON.parse(localStorage.getItem(MODEL_KEY));
    if (m && typeof m.hfov === 'number') return { ...DEFAULT_MODEL, ...m };
  } catch { /* storage unavailable */ }
  return { ...DEFAULT_MODEL, offset: DEFAULT_MODEL.offset.slice() };
}

export function saveModel(m) {
  try { localStorage.setItem(MODEL_KEY, JSON.stringify(m)); } catch { /* ignore */ }
}

export function loadDeviceId() {
  try { return localStorage.getItem(DEVICE_KEY) || ''; } catch { return ''; }
}

export function saveDeviceId(id) {
  try { localStorage.setItem(DEVICE_KEY, id); } catch { /* ignore */ }
}

// Projection matrix (column-major) from the horizontal FOV and the aspect ratio W/H.
export function projFromModel(model, aspect) {
  const fx = 1 / Math.tan((model.hfov * Math.PI) / 360);
  const m = new Float32Array(16);
  m[0] = fx; m[5] = fx * aspect; m[10] = -1; m[11] = -1; m[14] = -0.2;
  return m;
}

// Pose of the color camera = head pose · offset · yaw · pitch (column-major).
export function cameraPose(head, model) {
  const cy = Math.cos(model.yaw), sy = Math.sin(model.yaw);
  const cp = Math.cos(model.pitch), sp = Math.sin(model.pitch);
  // R = Ry(yaw) · Rx(pitch)
  const R = [cy, 0, -sy, sy * sp, cp, cy * sp, sy * cp, -sp, cy * cp];
  const L = new Float32Array(16);
  L[0] = R[0]; L[1] = R[1]; L[2] = R[2];
  L[4] = R[3]; L[5] = R[4]; L[6] = R[5];
  L[8] = R[6]; L[9] = R[7]; L[10] = R[8];
  L[12] = model.offset[0]; L[13] = model.offset[1]; L[14] = model.offset[2]; L[15] = 1;
  return mul4(head, L);
}

export function mul4(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

export async function listCameras() {
  const devs = await navigator.mediaDevices.enumerateDevices();
  return devs.filter((d) => d.kind === 'videoinput');
}

export class ColorCamera {
  constructor() {
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.stream = null;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.frames = 0;        // new video frames (requestVideoFrameCallback)
    this.lastCapture = 0;   // captureTime of the latest frame (performance.now timebase), if known
    this.grabs = 0;
    this.model = loadModel();
  }

  get active() {
    return !!this.stream && this.stream.getVideoTracks().some((t) => t.readyState === 'live');
  }

  get label() {
    return this.stream?.getVideoTracks()[0]?.label || '';
  }

  async start(deviceId = loadDeviceId()) {
    const video = deviceId ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 960 } } : { width: { ideal: 1280 }, height: { ideal: 960 } };
    this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    this.video.srcObject = this.stream;
    await this.video.play();
    const onFrame = (now, meta) => {
      this.frames++;
      this.lastCapture = meta?.captureTime ?? 0;
      if (this.stream) this.video.requestVideoFrameCallback?.(onFrame);
    };
    this.video.requestVideoFrameCallback?.(onFrame);
    return this;
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  get aspect() {
    return (this.video.videoWidth || 4) / (this.video.videoHeight || 3);
  }

  /**
   * Current camera image, scaled down to maxW pixels wide.
   * @returns {{width, height, rgba: Uint8Array, time: number}|null}
   */
  grab(maxW = 160) {
    const v = this.video;
    if (!v.videoWidth || v.readyState < 2) return null;
    const w = Math.min(maxW, v.videoWidth), h = Math.round((w * v.videoHeight) / v.videoWidth);
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.ctx.drawImage(v, 0, 0, w, h);
    const img = this.ctx.getImageData(0, 0, w, h);
    this.grabs++;
    const time = this.lastCapture > 0 ? this.lastCapture : performance.now() - this.model.latency;
    return { width: w, height: h, rgba: new Uint8Array(img.data.buffer), time };
  }
}

// Ring buffer of head poses, to pick the pose at the moment the image was captured.
export class PoseHistory {
  constructor(n = 90) {
    this.n = n;
    this.items = [];
  }

  push(t, matrix) {
    this.items.push({ t, m: new Float32Array(matrix) });
    if (this.items.length > this.n) this.items.shift();
  }

  at(t) {
    let best = null, bd = Infinity;
    for (const it of this.items) {
      const d = Math.abs(it.t - t);
      if (d < bd) { bd = d; best = it; }
    }
    return best ? best.m : null;
  }
}
