// Sparse TSDF volume (truncated signed distance field) with voxel hashing.
// Fuses depth images into a voxel grid and extracts a triangle mesh via
// marching cubes. Pure JavaScript without DOM dependencies, so it runs in
// both the web worker and Node (tests).
//
// Conventions:
//  - World coordinates in meters (WebXR: Y up, -Z forward).
//  - Depth values are z-depth (distance along the camera's -Z axis) in meters,
//    0 or NaN = invalid.
//  - Matrices are column-major Float32Array(16), like WebXR/three.js.
//  - Depth images have row 0 at the bottom (like gl.readPixels), i.e. NDC y up.

import { edgeTable, triTable } from './mc-tables.js?v=9e37035';

export const BLOCK = 8;
const BV = BLOCK * BLOCK * BLOCK;
const OFF = 1 << 14; // offset so that negative block indices become positive

export function blockKey(bx, by, bz) {
  // 3 × 15 bits → 45 bits, exactly representable as a Number
  return ((bx + OFF) * 32768 + (by + OFF)) * 32768 + (bz + OFF);
}

// Edge → [corner a, corner b, axis]; corner a is always the lower corner.
const CORNER = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];
const EDGE = [
  [0, 1, 0], [1, 2, 1], [3, 2, 0], [0, 3, 1],
  [4, 5, 0], [5, 6, 1], [7, 6, 0], [4, 7, 1],
  [0, 4, 2], [1, 5, 2], [2, 6, 2], [3, 7, 2],
];

export class TsdfVolume {
  /**
   * @param {object} o
   * @param {number} o.voxelSize   edge length of a voxel in m
   * @param {number} [o.truncation] truncation distance in m
   * @param {number} [o.maxWeight]  upper bound of the running average weight
   * @param {number} [o.solidWeight] weight from which a voxel counts as well observed (slow carving)
   * @param {number} [o.minDepth]   ignore closer measurements (m)
   * @param {number} [o.maxDepth]   ignore farther measurements (m)
   * @param {object|null} [o.box]   {center:[x,y,z], half:[hx,hy,hz], yaw} – only fuse inside
   */
  constructor(o) {
    this.voxelSize = o.voxelSize;
    this.truncation = o.truncation ?? Math.max(3 * o.voxelSize, 0.02);
    this.maxWeight = o.maxWeight ?? 64;
    this.solidWeight = o.solidWeight ?? 4;
    this.minDepth = o.minDepth ?? 0.1;
    this.maxDepth = o.maxDepth ?? 4;
    this.edgeFilter = o.edgeFilter ?? 0.04; // relative depth jump that marks an edge pixel
    this.allocStride = o.allocStride ?? 2;
    this.color = !!o.color; // also fuse RGB from a color camera
    this.setBox(o.box ?? null);
    this.blocks = new Map();
    this.frames = 0;
  }

  setBox(box) {
    this.box = box;
    if (box) {
      this._bc = Math.cos(box.yaw || 0);
      this._bs = Math.sin(box.yaw || 0);
    }
  }

  // Is the world point inside the box (enlarged by margin)?
  inBox(x, y, z, margin = 0) {
    const b = this.box;
    if (!b) return true;
    const dx = x - b.center[0], dy = y - b.center[1], dz = z - b.center[2];
    // rotate by -yaw around Y
    const lx = this._bc * dx - this._bs * dz;
    const lz = this._bs * dx + this._bc * dz;
    return Math.abs(lx) <= b.half[0] + margin &&
      Math.abs(dy) <= b.half[1] + margin &&
      Math.abs(lz) <= b.half[2] + margin;
  }

  clearColor() {
    for (const b of this.blocks.values()) if (b.cw) { b.cw.fill(0); b.rgb.fill(0); }
  }

  clear() {
    this.blocks.clear();
    this.frames = 0;
  }

  _getBlock(bx, by, bz, create) {
    const k = blockKey(bx, by, bz);
    let b = this.blocks.get(k);
    if (!b && create) {
      b = { bx, by, bz, tsdf: new Float32Array(BV).fill(1), weight: new Float32Array(BV) };
      if (this.color) { b.rgb = new Float32Array(BV * 3); b.cw = new Float32Array(BV); }
      this.blocks.set(k, b);
    }
    return b;
  }

  /**
   * Fuse one depth frame.
   * @param {object} f
   * @param {number} f.width
   * @param {number} f.height
   * @param {Float32Array} f.depth  z-depth in m, row 0 at the bottom
   * @param {ArrayLike<number>} f.proj      projection matrix of the depth camera
   * @param {ArrayLike<number>} f.camToWorld pose of the depth camera
   * @param {object} [c] optional color frame taken at the same moment:
   *   {width, height, rgba: Uint8Array (row 0 = top), proj, camToWorld}
   * @returns {number} number of updated blocks
   */
  integrate(f, c = null) {
    const W = f.width, H = f.height, P = f.proj, M = f.camToWorld;
    const depth = this._filterEdges(f.depth, W, H);
    const vs = this.voxelSize, tr = this.truncation, bsz = vs * BLOCK;
    const minD = this.minDepth, maxD = this.maxDepth;
    // noise of the Quest depth grows ~ with the square of the distance → weight (dRef/d)²,
    // capped to [0.1, 1]: close views dominate, far views only fill gaps
    const dRef2 = (0.5 * maxD) ** 2;
    // voxels that are already well observed are carved only slowly by "free space" from a
    // single frame – a misregistered frame (head moved fast) must not erase good surfaces
    const solidW = this.solidWeight;

    // camera rotation R (columns) and position t
    const r00 = M[0], r10 = M[1], r20 = M[2];
    const r01 = M[4], r11 = M[5], r21 = M[6];
    const r02 = M[8], r12 = M[9], r22 = M[10];
    const tx = M[12], ty = M[13], tz = M[14];
    const p0 = P[0], p4 = P[4], p8 = P[8], p5 = P[5], p9 = P[9];

    // --- 1. Allocate blocks along the rays around the measured surface ---
    const touched = new Set();
    const s = this.allocStride;
    for (let j = 0; j < H; j += s) {
      const yn = ((j + 0.5) / H) * 2 - 1;
      const cy = (yn + p9) / p5; // camera ray at z = -1
      for (let i = 0; i < W; i += s) {
        const d = depth[j * W + i];
        if (!(d >= minD && d <= maxD)) continue;
        const xn = ((i + 0.5) / W) * 2 - 1;
        const cx = (xn + p8 - p4 * cy) / p0;
        // world direction for z-depth 1
        const dx = r00 * cx + r01 * cy - r02;
        const dy = r10 * cx + r11 * cy - r12;
        const dz = r20 * cx + r21 * cy - r22;
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const t0 = Math.max(minD, d - tr / len), t1 = d + tr / len;
        const step = (bsz * 0.5) / len;
        for (let t = t0; t <= t1 + 1e-9; t += step) {
          const x = tx + dx * t, y = ty + dy * t, z = tz + dz * t;
          if (this.box && !this.inBox(x, y, z, tr)) continue;
          touched.add(blockKey(Math.floor(x / bsz), Math.floor(y / bsz), Math.floor(z / bsz)));
        }
      }
    }

    // --- 2. Update every voxel of the touched blocks projectively ---
    const maxW = this.maxWeight;
    // color camera: world → camera rotation (R^T rows) and projection
    const useColor = this.color && c && c.rgba;
    let CW = 0, CH = 0, cr = null, cp = null, ct = null, rgba = null;
    if (useColor) {
      const C = c.camToWorld;
      CW = c.width; CH = c.height; rgba = c.rgba;
      cr = [C[0], C[1], C[2], C[4], C[5], C[6], C[8], C[9], C[10]];
      ct = [C[12], C[13], C[14]];
      cp = [c.proj[0], c.proj[4], c.proj[8], c.proj[5], c.proj[9]];
    }
    const colorBand = tr * 0.5;
    const hasBox = !!this.box;
    for (const k of touched) {
      let b = this.blocks.get(k);
      if (!b) {
        const bz = (k % 32768) - OFF;
        const rest = Math.floor(k / 32768);
        const by = (rest % 32768) - OFF;
        const bx = Math.floor(rest / 32768) - OFF;
        b = this._getBlock(bx, by, bz, true);
      }
      const T = b.tsdf, Wt = b.weight, RGB = b.rgb, CWt = b.cw;
      const ox = b.bx * BLOCK, oy = b.by * BLOCK, oz = b.bz * BLOCK;
      let idx = 0;
      for (let z = 0; z < BLOCK; z++) {
        const wz = (oz + z) * vs;
        for (let y = 0; y < BLOCK; y++) {
          const wy = (oy + y) * vs;
          for (let x = 0; x < BLOCK; x++, idx++) {
            const wx = (ox + x) * vs;
            if (hasBox && !this.inBox(wx, wy, wz)) continue;
            // world → camera: R^T (p - t)
            const ex = wx - tx, ey = wy - ty, ez = wz - tz;
            const X = r00 * ex + r10 * ey + r20 * ez;
            const Y = r01 * ex + r11 * ey + r21 * ez;
            const Z = r02 * ex + r12 * ey + r22 * ez;
            const zc = -Z;
            if (zc < minD) continue;
            const xn = (p0 * X + p4 * Y + p8 * Z) / zc;
            const yn = (p5 * Y + p9 * Z) / zc;
            const u = Math.floor((xn + 1) * 0.5 * W);
            const v = Math.floor((yn + 1) * 0.5 * H);
            if (u < 0 || v < 0 || u >= W || v >= H) continue;
            const d = depth[v * W + u];
            if (!(d >= minD && d <= maxD)) continue;
            const sdf = d - zc;
            if (sdf < -tr) continue;
            const val = sdf >= tr ? 1 : sdf / tr;
            const w0 = Wt[idx];
            let wNew = dRef2 / (d * d);
            wNew = wNew > 1 ? 1 : wNew < 0.1 ? 0.1 : wNew;
            if (sdf >= tr && w0 >= solidW) wNew *= 0.2;
            const wSum = w0 + wNew;
            T[idx] = (T[idx] * w0 + val * wNew) / wSum;
            Wt[idx] = wSum > maxW ? maxW : wSum;
            // color only for voxels close to the measured surface (= visible)
            if (useColor && sdf < colorBand && sdf > -colorBand) {
              const qx = wx - ct[0], qy = wy - ct[1], qz = wz - ct[2];
              const cX = cr[0] * qx + cr[1] * qy + cr[2] * qz;
              const cY = cr[3] * qx + cr[4] * qy + cr[5] * qz;
              const cZ = cr[6] * qx + cr[7] * qy + cr[8] * qz;
              if (cZ < -0.05) {
                const xc = (cp[0] * cX + cp[1] * cY + cp[2] * cZ) / -cZ;
                const yc = (cp[3] * cY + cp[4] * cZ) / -cZ;
                const cu = Math.floor((xc + 1) * 0.5 * CW);
                const cv = Math.floor((1 - yc) * 0.5 * CH); // image row 0 = top
                if (cu >= 0 && cv >= 0 && cu < CW && cv < CH) {
                  const o = (cv * CW + cu) * 4;
                  // pixels in the image center are sharper → slightly higher weight
                  const cw0 = CWt[idx], cwn = 1 - 0.5 * Math.max(Math.abs(xc), Math.abs(yc));
                  const cs = cw0 + cwn;
                  RGB[idx * 3] = (RGB[idx * 3] * cw0 + rgba[o] * cwn) / cs;
                  RGB[idx * 3 + 1] = (RGB[idx * 3 + 1] * cw0 + rgba[o + 1] * cwn) / cs;
                  RGB[idx * 3 + 2] = (RGB[idx * 3 + 2] * cw0 + rgba[o + 2] * cwn) / cs;
                  CWt[idx] = cs > 30 ? 30 : cs;
                }
              }
            }
          }
        }
      }
    }
    this.frames++;
    return touched.size;
  }

  // Invalidate pixels at depth discontinuities (they smear surfaces).
  _filterEdges(depth, W, H) {
    const th = this.edgeFilter;
    if (!th) return depth;
    const out = new Float32Array(depth.length);
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        const d = depth[k];
        if (!(d > 0)) continue;
        let ok = true;
        const lim = th * d;
        if (i > 0 && Math.abs(depth[k - 1] - d) > lim) ok = false;
        else if (i < W - 1 && Math.abs(depth[k + 1] - d) > lim) ok = false;
        else if (j > 0 && Math.abs(depth[k - W] - d) > lim) ok = false;
        else if (j < H - 1 && Math.abs(depth[k + W] - d) > lim) ok = false;
        if (ok) out[k] = d;
      }
    }
    return out;
  }

  /**
   * Marching cubes over all allocated blocks.
   * @param {object} [o]
   * @param {number} [o.minWeight] voxels with less weight count as unobserved
   * @returns {{positions: Float32Array, indices: Uint32Array}}
   */
  extractMesh(o = {}) {
    const minW = o.minWeight ?? 2;
    const vs = this.voxelSize;
    const blocks = this.blocks;
    const positions = [];
    const indices = [];
    const vmap = new Map();
    const val = new Float32Array(8);
    const edgeVert = new Int32Array(12);
    const withColor = this.color;
    const colors = [];
    const cBlk = new Array(8), cLi = new Int32Array(8);

    // neighbour lookup with a one-entry cache
    let cKey = -1, cBlock = null;
    const sample = (gx, gy, gz, out, i) => {
      const bx = Math.floor(gx / BLOCK), by = Math.floor(gy / BLOCK), bz = Math.floor(gz / BLOCK);
      const k = blockKey(bx, by, bz);
      if (k !== cKey) { cKey = k; cBlock = blocks.get(k) || null; }
      if (!cBlock) return false;
      const li = (gx - bx * BLOCK) + BLOCK * ((gy - by * BLOCK) + BLOCK * (gz - bz * BLOCK));
      if (cBlock.weight[li] < minW) return false;
      out[i] = cBlock.tsdf[li];
      cBlk[i] = cBlock; cLi[i] = li;
      return true;
    };

    for (const b of blocks.values()) {
      const T = b.tsdf, Wt = b.weight;
      const ox = b.bx * BLOCK, oy = b.by * BLOCK, oz = b.bz * BLOCK;
      for (let z = 0; z < BLOCK; z++) {
        for (let y = 0; y < BLOCK; y++) {
          for (let x = 0; x < BLOCK; x++) {
            const gx = ox + x, gy = oy + y, gz = oz + z;
            let ok = true;
            if (x < BLOCK - 1 && y < BLOCK - 1 && z < BLOCK - 1) {
              // fast path: all 8 corners inside this block
              for (let c = 0; c < 8; c++) {
                const C = CORNER[c];
                const li = (x + C[0]) + BLOCK * ((y + C[1]) + BLOCK * (z + C[2]));
                if (Wt[li] < minW) { ok = false; break; }
                val[c] = T[li];
                cBlk[c] = b; cLi[c] = li;
              }
            } else {
              for (let c = 0; c < 8; c++) {
                const C = CORNER[c];
                if (!sample(gx + C[0], gy + C[1], gz + C[2], val, c)) { ok = false; break; }
              }
            }
            if (!ok) continue;
            let ci = 0;
            for (let c = 0; c < 8; c++) if (val[c] < 0) ci |= 1 << c;
            const bits = edgeTable[ci];
            if (bits === 0) continue;
            // reject spurious zero crossings between "free" (+1) and "behind" (-1)
            let spurious = false;
            for (let e = 0; e < 12 && !spurious; e++) {
              if ((bits & (1 << e)) && Math.abs(val[EDGE[e][0]] - val[EDGE[e][1]]) > 1.6) spurious = true;
            }
            if (spurious) continue;
            for (let e = 0; e < 12; e++) {
              if (!(bits & (1 << e))) continue;
              const E = EDGE[e];
              const a = CORNER[E[0]];
              const ax = gx + a[0], ay = gy + a[1], az = gz + a[2];
              const key = (((ax + 65536) * 131072 + (ay + 65536)) * 131072 + (az + 65536)) * 3 + E[2];
              let vi = vmap.get(key);
              if (vi === undefined) {
                const va = val[E[0]], vb = val[E[1]];
                const t = va / (va - vb);
                vi = positions.length / 3;
                positions.push(ax * vs, ay * vs, az * vs);
                positions[vi * 3 + E[2]] += t * vs;
                vmap.set(key, vi);
                if (withColor) {
                  const A = cBlk[E[0]], B = cBlk[E[1]], ia = cLi[E[0]], ib = cLi[E[1]];
                  const ca = A.cw[ia] > 0, cb = B.cw[ib] > 0;
                  for (let k = 0; k < 3; k++) {
                    const x0 = A.rgb[ia * 3 + k], x1 = B.rgb[ib * 3 + k];
                    colors.push(ca && cb ? x0 + (x1 - x0) * t : ca ? x0 : cb ? x1 : 170);
                  }
                }
              }
              edgeVert[e] = vi;
            }
            const base = ci << 4;
            for (let t = 0; triTable[base + t] !== -1; t += 3) {
              // Bourke table winding is clockwise for outward normals with
              // "inside = value < iso" → swap to counter-clockwise.
              const a = edgeVert[triTable[base + t]];
              const b2 = edgeVert[triTable[base + t + 1]];
              const c = edgeVert[triTable[base + t + 2]];
              if (a === b2 || b2 === c || a === c) continue;
              indices.push(a, c, b2);
            }
          }
        }
      }
    }
    const mesh = { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
    if (withColor) mesh.colors = Uint8Array.from(colors, (v) => Math.round(v));
    return mesh;
  }

  stats() {
    let observed = 0;
    for (const b of this.blocks.values()) for (let i = 0; i < BV; i++) if (b.weight[i] > 0) observed++;
    return { blocks: this.blocks.size, voxels: observed, frames: this.frames };
  }
}
