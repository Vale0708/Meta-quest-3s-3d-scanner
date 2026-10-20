// Web worker: depth fusion off the main thread (keeps the XR frame rate up).
import { TsdfVolume } from './tsdf.js';
import { alignFrame, mul4, IDENTITY } from './align.js';
import { removeSmallComponents } from '../mesh/ops.js';

let vol = null;
let orientation = 'auto'; // 'auto' | 'none' | 'flipY' | 'flipX' | 'flipXY'
let decided = null;
let pending = []; // frames buffered while the orientation is still unknown
let probe = null;
// frame-to-model alignment: current world-space pose correction + statistics
let corr = IDENTITY();
let align = { aligned: 0, rejected: 0, inRow: 0, shift: 0, angle: 0, enabled: true };
const isIdentity = (m) => m.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-9);

const VARIANTS = ['none', 'flipY', 'flipX', 'flipXY'];

function orient(depth, W, H, mode) {
  if (mode === 'none') return depth;
  const out = new Float32Array(depth.length);
  const fx = mode === 'flipX' || mode === 'flipXY', fy = mode === 'flipY' || mode === 'flipXY';
  for (let j = 0; j < H; j++) {
    const sj = fy ? H - 1 - j : j;
    for (let i = 0; i < W; i++) out[j * W + i] = depth[sj * W + (fx ? W - 1 - i : i)];
  }
  return out;
}

// Back-projects a few pixels into world space and counts the occupied 4 cm
// cells per hypothesis: the correct image orientation produces consistent
// surfaces across head movements → fewest distinct cells.
function probeOrientation(f) {
  if (!probe) probe = { cells: VARIANTS.map(() => new Set()), frames: 0, dirs: [] };
  const M = f.camToWorld, P = f.proj, W = f.width, H = f.height;
  const fwd = [-M[8], -M[9], -M[10]];
  probe.dirs.push(fwd);
  VARIANTS.forEach((v, vi) => {
    const d = orient(f.depth, W, H, v);
    const set = probe.cells[vi];
    for (let j = 2; j < H; j += 6) {
      const yn = ((j + 0.5) / H) * 2 - 1, cy = (yn + P[9]) / P[5];
      for (let i = 2; i < W; i += 6) {
        const z = d[j * W + i];
        if (!(z > 0.2 && z < 3.5)) continue;
        const xn = ((i + 0.5) / W) * 2 - 1, cx = (xn + P[8] - P[4] * cy) / P[0];
        const x = M[12] + (M[0] * cx + M[4] * cy - M[8]) * z;
        const y = M[13] + (M[1] * cx + M[5] * cy - M[9]) * z;
        const zz = M[14] + (M[2] * cx + M[6] * cy - M[10]) * z;
        set.add(Math.floor(x / 0.04) + ',' + Math.floor(y / 0.04) + ',' + Math.floor(zz / 0.04));
      }
    }
  });
  probe.frames++;
  // Pitch and yaw spread of the viewing directions. A vertical flip is only
  // detectable with pitch motion, a horizontal one only with yaw motion.
  let pMin = Infinity, pMax = -Infinity;
  const a = probe.dirs[0];
  const yaw0 = Math.atan2(a[0], -a[2]);
  let yMin = 0, yMax = 0;
  for (const b of probe.dirs) {
    const pitch = Math.asin(Math.max(-1, Math.min(1, b[1])));
    pMin = Math.min(pMin, pitch); pMax = Math.max(pMax, pitch);
    let dy = Math.atan2(b[0], -b[2]) - yaw0;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    yMin = Math.min(yMin, dy); yMax = Math.max(yMax, dy);
  }
  const spread = Math.min(pMax - pMin, yMax - yMin);
  const sizes = probe.cells.map((s) => s.size);
  const order = sizes.map((s, i) => i).sort((x, y) => sizes[x] - sizes[y]);
  const ratio = sizes[order[0]] / Math.max(1, sizes[order[1]]);
  const motion = spread > 0.26; // ~15° up/down and left/right
  postMessage({ type: 'orientation-progress', frames: probe.frames, spread, sizes });
  if ((probe.frames >= 30 && motion && ratio < 0.93) || probe.frames >= 120) {
    return VARIANTS[order[0]];
  }
  return null;
}

function integrate(f) {
  const t0 = performance.now();
  const depth = orient(f.depth, f.width, f.height, decided);
  const frame = { ...f, depth };
  if (align.enabled && vol.frames >= 8) {
    let a = alignFrame(vol, frame, corr);
    // the last correction may be stale (e.g. after a tracking jump) → retry from the raw pose
    if (a.status === 'rejected' && !isIdentity(corr)) a = alignFrame(vol, frame, IDENTITY());
    if (a.status === 'rejected') {
      align.rejected++;
      align.inRow++;
      return -(performance.now() - t0); // negative = not fused
    }
    align.inRow = 0;
    corr = a.corr;
    if (a.status === 'aligned') { align.aligned++; align.shift = a.shift; align.angle = a.angle; }
  }
  if (!isIdentity(corr)) {
    frame.camToWorld = mul4(corr, f.camToWorld);
    if (f.color) frame.color = { ...f.color, camToWorld: mul4(corr, f.color.camToWorld) };
  }
  vol.integrate(frame, frame.color || null);
  return performance.now() - t0;
}

function extract(minWeight, clean) {
  let mesh = vol.extractMesh({ minWeight });
  if (clean) mesh = removeSmallComponents(mesh, { minTris: 30, minFraction: 0.01 });
  return mesh;
}

self.onmessage = (ev) => {
  const m = ev.data;
  try {
    switch (m.type) {
      case 'init':
        vol = new TsdfVolume(m.config);
        orientation = m.orientation || 'auto';
        decided = orientation === 'auto' ? null : orientation;
        pending = [];
        probe = null;
        corr = IDENTITY();
        align = { aligned: 0, rejected: 0, inRow: 0, shift: 0, angle: 0, enabled: m.config.align !== false };
        postMessage({ type: 'ready', orientation: decided });
        break;
      case 'box':
        vol.setBox(m.box);
        break;
      case 'clear':
        vol.clear();
        corr = IDENTITY();
        align.inRow = 0;
        break;
      case 'clearColor':
        vol.clearColor();
        break;
      case 'frame': {
        const f = { width: m.width, height: m.height, depth: m.depth, proj: m.proj, camToWorld: m.camToWorld, color: m.color || null };
        if (!decided) {
          const r = probeOrientation(f);
          pending.push(f);
          if (pending.length > 60) pending.shift();
          if (r) {
            decided = r;
            postMessage({ type: 'orientation', orientation: decided });
            for (const p of pending) integrate(p);
            pending = [];
          }
          postMessage({ type: 'integrated', ms: 0, stats: vol.stats(), calibrating: !decided });
          break;
        }
        const ms = integrate(f);
        postMessage({ type: 'integrated', ms: Math.abs(ms), fused: ms >= 0, stats: vol.stats(), calibrating: false,
          align: { aligned: align.aligned, rejected: align.rejected, inRow: align.inRow, shift: align.shift, angle: align.angle } });
        break;
      }
      case 'extract': {
        const t0 = performance.now();
        const mesh = extract(m.minWeight ?? 2, !!m.clean);
        const transfer = [mesh.positions.buffer, mesh.indices.buffer];
        if (mesh.colors) transfer.push(mesh.colors.buffer);
        postMessage({ type: 'mesh', id: m.id, positions: mesh.positions, indices: mesh.indices, colors: mesh.colors || null, ms: performance.now() - t0 }, transfer);
        break;
      }
    }
  } catch (err) {
    postMessage({ type: 'error', id: m.id, message: String(err && err.stack || err) });
  }
};
