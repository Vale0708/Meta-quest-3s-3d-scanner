// Frame-to-model alignment: before a depth frame is fused, its pose is corrected so that
// its points lie on the zero level of the TSDF built so far (SDF tracking, Gauss-Newton
// with Huber weights, 6 DOF). This removes small pose errors of the headset tracking and
// the delay between depth image and head pose. Frames that still contradict the model
// (points inside well-observed free space) are rejected instead of being fused.
//
// Same conventions as tsdf.js: column-major 4×4 matrices, z-depth, row 0 at the bottom.

import { BLOCK, blockKey } from './tsdf.js?v=9e37035';

export const IDENTITY = () => new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** a·b for column-major 4×4 matrices */
export function mul4(a, b) {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

// Trilinear TSDF sample (in meters) with gradient. Returns false if a corner is missing
// or not observed often enough.
function makeSampler(vol, minW) {
  const vs = vol.voxelSize, tr = vol.truncation, blocks = vol.blocks;
  const res = { d: 0, gx: 0, gy: 0, gz: 0, w: 0 };
  const v = new Float64Array(8);
  let cKey = -1, cBlock = null;
  const voxel = (ix, iy, iz, i) => {
    const bx = Math.floor(ix / BLOCK), by = Math.floor(iy / BLOCK), bz = Math.floor(iz / BLOCK);
    const k = blockKey(bx, by, bz);
    if (k !== cKey) { cKey = k; cBlock = blocks.get(k) || null; }
    if (!cBlock) return -1;
    const li = (ix - bx * BLOCK) + BLOCK * ((iy - by * BLOCK) + BLOCK * (iz - bz * BLOCK));
    v[i] = cBlock.tsdf[li];
    return cBlock.weight[li];
  };
  // nearest voxel only: weight and value (for the free-space check)
  const nearest = (x, y, z) => {
    const w = voxel(Math.round(x / vs), Math.round(y / vs), Math.round(z / vs), 0);
    res.w = w < 0 ? 0 : w;
    res.d = v[0];
    return res;
  };
  const sample = (x, y, z) => {
    const fx = x / vs, fy = y / vs, fz = z / vs;
    const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
    const ax = fx - ix, ay = fy - iy, az = fz - iz;
    for (let i = 0; i < 8; i++) {
      const w = voxel(ix + (i & 1), iy + ((i >> 1) & 1), iz + (i >> 2), i);
      if (w < minW) return null;
    }
    // corners: i = x + 2y + 4z
    const x00 = v[0] + (v[1] - v[0]) * ax, x10 = v[2] + (v[3] - v[2]) * ax;
    const x01 = v[4] + (v[5] - v[4]) * ax, x11 = v[6] + (v[7] - v[6]) * ax;
    const y0 = x00 + (x10 - x00) * ay, y1 = x01 + (x11 - x01) * ay;
    res.d = (y0 + (y1 - y0) * az) * tr;
    const dx00 = v[1] - v[0], dx10 = v[3] - v[2], dx01 = v[5] - v[4], dx11 = v[7] - v[6];
    const dxy0 = dx00 + (dx10 - dx00) * ay, dxy1 = dx01 + (dx11 - dx01) * ay;
    res.gx = (dxy0 + (dxy1 - dxy0) * az) * tr / vs;
    res.gy = ((x10 - x00) + ((x11 - x01) - (x10 - x00)) * az) * tr / vs;
    res.gz = (y1 - y0) * tr / vs;
    return res;
  };
  return { sample, nearest };
}

// Solves the symmetric 6×6 system A x = b (Gaussian elimination with pivoting).
function solve6(A, b) {
  const n = 6, M = new Float64Array(42);
  for (let r = 0; r < n; r++) { for (let c = 0; c < n; c++) M[r * 7 + c] = A[r * 6 + c]; M[r * 7 + 6] = b[r]; }
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r * 7 + c]) > Math.abs(M[p * 7 + c])) p = r;
    if (Math.abs(M[p * 7 + c]) < 1e-12) return null;
    if (p !== c) for (let k = 0; k < 7; k++) { const t = M[c * 7 + k]; M[c * 7 + k] = M[p * 7 + k]; M[p * 7 + k] = t; }
    for (let r = c + 1; r < n; r++) {
      const f = M[r * 7 + c] / M[c * 7 + c];
      for (let k = c; k < 7; k++) M[r * 7 + k] -= f * M[c * 7 + k];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r * 7 + 6];
    for (let k = r + 1; k < n; k++) s -= M[r * 7 + k] * x[k];
    x[r] = s / M[r * 7 + r];
  }
  return x;
}

// Rigid transform: rotation by vector w (Rodrigues) around point c, then translation t.
function twist(w, t, c) {
  const th = Math.hypot(w[0], w[1], w[2]);
  let R;
  if (th < 1e-12) R = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  else {
    const kx = w[0] / th, ky = w[1] / th, kz = w[2] / th, s = Math.sin(th), co = Math.cos(th), C = 1 - co;
    // row-major
    R = [co + kx * kx * C, kx * ky * C - kz * s, kx * kz * C + ky * s,
      ky * kx * C + kz * s, co + ky * ky * C, ky * kz * C - kx * s,
      kz * kx * C - ky * s, kz * ky * C + kx * s, co + kz * kz * C];
  }
  const o = IDENTITY();
  for (let r = 0; r < 3; r++) for (let col = 0; col < 3; col++) o[col * 4 + r] = R[r * 3 + col];
  // p' = R (p - c) + c + t
  for (let r = 0; r < 3; r++) o[12 + r] = c[r] + t[r] - (R[r * 3] * c[0] + R[r * 3 + 1] * c[1] + R[r * 3 + 2] * c[2]);
  return o;
}

/**
 * Aligns a depth frame to the volume.
 * @param {import('./tsdf.js?v=9e37035').TsdfVolume} vol
 * @param {{width:number,height:number,depth:Float32Array,proj:ArrayLike<number>,camToWorld:ArrayLike<number>}} f
 * @param {Float64Array} [init] world-space correction to start from (e.g. the last one)
 * @param {object} [o]
 * @returns {{status:'aligned'|'rejected'|'new', corr: Float64Array, shift: number, angle: number,
 *   rms: number, used: number, conflict: number}}
 *   status 'new': too little known surface in view → fuse unchanged (start/new area)
 */
export function alignFrame(vol, f, init = IDENTITY(), o = {}) {
  const W = f.width, H = f.height, P = f.proj, M = f.camToWorld;
  const tr = vol.truncation;
  const minW = o.minWeight ?? 2;
  const solidW = vol.solidWeight;
  const maxPts = o.maxPoints ?? 1500;
  const minD = vol.minDepth, maxD = vol.maxDepth;
  const { sample, nearest } = makeSampler(vol, minW);

  // points in world coordinates (raw pose) inside the scan box, then subsampled
  const p0 = P[0], p4 = P[4], p8 = P[8], p5 = P[5], p9 = P[9];
  let all = [];
  for (let k = 0; k < f.depth.length; k++) {
    const d = f.depth[k];
    if (!(d >= minD && d <= maxD)) continue;
    const i = k % W, j = (k - i) / W;
    const yn = ((j + 0.5) / H) * 2 - 1, xn = ((i + 0.5) / W) * 2 - 1;
    const cy = (yn + p9) / p5, cx = (xn + p8 - p4 * cy) / p0;
    const X = cx * d, Y = cy * d, Z = -d;
    const x = M[0] * X + M[4] * Y + M[8] * Z + M[12];
    const y = M[1] * X + M[5] * Y + M[9] * Z + M[13];
    const z = M[2] * X + M[6] * Y + M[10] * Z + M[14];
    if (vol.box && !vol.inBox(x, y, z, tr)) continue;
    all.push(x, y, z);
  }
  const step = Math.max(1, Math.floor(all.length / 3 / maxPts));
  let pts = all;
  if (step > 1) {
    pts = [];
    for (let n = 0; n < all.length; n += 3 * step) pts.push(all[n], all[n + 1], all[n + 2]);
  }
  all = null;
  const N = pts.length / 3;
  const result = { status: 'new', corr: Float64Array.from(init), shift: 0, angle: 0, rms: 0, used: 0, conflict: 0 };
  if (N < 50) return result;

  // rotation center: centroid of the points
  const c = [0, 0, 0];
  for (let n = 0; n < N; n++) { c[0] += pts[n * 3]; c[1] += pts[n * 3 + 1]; c[2] += pts[n * 3 + 2]; }
  c[0] /= N; c[1] /= N; c[2] /= N;

  const huber = 0.3 * tr;
  const A = new Float64Array(36), b = new Float64Array(6), J = new Float64Array(6);
  let corr = Float64Array.from(init);
  let used = 0, rms = 0;
  for (let it = 0; it < (o.iterations ?? 10); it++) {
    A.fill(0); b.fill(0);
    used = 0;
    let se = 0;
    for (let n = 0; n < N; n++) {
      const px = pts[n * 3], py = pts[n * 3 + 1], pz = pts[n * 3 + 2];
      const x = corr[0] * px + corr[4] * py + corr[8] * pz + corr[12];
      const y = corr[1] * px + corr[5] * py + corr[9] * pz + corr[13];
      const z = corr[2] * px + corr[6] * py + corr[10] * pz + corr[14];
      const s = sample(x, y, z);
      if (!s) continue;
      const r = s.d;
      if (Math.abs(r) > 0.9 * tr) continue; // outside the truncation band: no gradient information
      const gl = Math.hypot(s.gx, s.gy, s.gz);
      if (gl < 0.3) continue;
      const qx = x - c[0], qy = y - c[1], qz = z - c[2];
      // dr/dω = q × g, dr/dt = g
      J[0] = qy * s.gz - qz * s.gy; J[1] = qz * s.gx - qx * s.gz; J[2] = qx * s.gy - qy * s.gx;
      J[3] = s.gx; J[4] = s.gy; J[5] = s.gz;
      const a = Math.abs(r), w = a <= huber ? 1 : huber / a;
      for (let i = 0; i < 6; i++) {
        b[i] -= w * J[i] * r;
        for (let k = i; k < 6; k++) A[i * 6 + k] += w * J[i] * J[k];
      }
      se += r * r;
      used++;
    }
    rms = used ? Math.sqrt(se / used) : 0;
    if (used < 40) break;
    for (let i = 0; i < 6; i++) for (let k = 0; k < i; k++) A[i * 6 + k] = A[k * 6 + i];
    // damping keeps unconstrained directions (e.g. sliding along a flat wall) at zero
    let trA = 0;
    for (let i = 0; i < 6; i++) trA += A[i * 7];
    for (let i = 0; i < 6; i++) A[i * 7] += 5e-2 * trA / 6 + 1e-9;
    const x = solve6(A, b);
    if (!x) break;
    corr = mul4(twist([x[0], x[1], x[2]], [x[3], x[4], x[5]], c), corr);
    if (Math.hypot(x[3], x[4], x[5]) < 1e-5 && Math.hypot(x[0], x[1], x[2]) < 1e-5) break;
  }

  // check against the model. A point contradicts it if
  //  - it lies in well-observed free space (the model says: empty here), or
  //  - just in front of it (toward the camera) the model is well-observed solid, i.e.
  //    the measurement looks through a known surface (pose pushed the frame too deep).
  const cam = mul4(corr, M);
  const ex = cam[12], ey = cam[13], ez = cam[14];
  let known = 0, conflict = 0;
  for (let n = 0; n < N; n++) {
    const px = pts[n * 3], py = pts[n * 3 + 1], pz = pts[n * 3 + 2];
    const x = corr[0] * px + corr[4] * py + corr[8] * pz + corr[12];
    const y = corr[1] * px + corr[5] * py + corr[9] * pz + corr[13];
    const z = corr[2] * px + corr[6] * py + corr[10] * pz + corr[14];
    let s = nearest(x, y, z);
    let isKnown = s.w >= solidW, bad = isKnown && s.d > 0.85;
    if (!bad) {
      const dx = ex - x, dy = ey - y, dz = ez - z, l = Math.hypot(dx, dy, dz);
      for (const k of [0.75, 1.5]) {
        s = nearest(x + dx / l * k * tr, y + dy / l * k * tr, z + dz / l * k * tr);
        if (s.w < solidW) continue;
        isKnown = true;
        if (s.d < -0.5) { bad = true; break; }
      }
    }
    if (isKnown) known++;
    if (bad) conflict++;
  }
  // size of the correction relative to the start pose
  const rel = mul4(corr, invertRigid(init));
  const shift = Math.hypot(rel[12] + (rel[0] - 1) * c[0] + rel[4] * c[1] + rel[8] * c[2],
    rel[13] + rel[1] * c[0] + (rel[5] - 1) * c[1] + rel[9] * c[2],
    rel[14] + rel[2] * c[0] + rel[6] * c[1] + (rel[10] - 1) * c[2]);
  const angle = Math.acos(Math.min(1, Math.max(-1, (rel[0] + rel[5] + rel[10] - 1) / 2))) * 180 / Math.PI;
  Object.assign(result, { corr, shift, angle, rms, used, conflict: known ? conflict / known : 0 });

  if (known < 0.25 * N || known < 40) return result; // mostly unknown area → fuse as new
  const maxShift = o.maxShift ?? Math.max(2 * tr, 0.03), maxAngle = o.maxAngle ?? 6;
  if (result.conflict > 0.25 || shift > maxShift || angle > maxAngle || (used >= 40 && rms > 0.5 * tr)) {
    result.status = 'rejected';
    return result;
  }
  result.status = used >= 40 ? 'aligned' : 'new';
  return result;
}

/** inverse of a rigid 4×4 transform */
export function invertRigid(m) {
  const o = IDENTITY();
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[c * 4 + r] = m[r * 4 + c];
  for (let r = 0; r < 3; r++) o[12 + r] = -(o[r] * m[12] + o[4 + r] * m[13] + o[8 + r] * m[14]);
  return o;
}
