// Mesh operations on indexed triangle meshes {positions: Float32Array, indices: Uint32Array}.
// No three.js dependency, so they run in the worker and in Node.

export function emptyMesh() {
  return { positions: new Float32Array(0), indices: new Uint32Array(0) };
}

export function triangleCount(m) {
  return m.indices.length / 3;
}

export function bounds(m) {
  const p = m.positions;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (p[i + k] < min[k]) min[k] = p[i + k];
      if (p[i + k] > max[k]) max[k] = p[i + k];
    }
  }
  return { min, max };
}

export function mergeMeshes(list) {
  let nv = 0, ni = 0;
  for (const m of list) { nv += m.positions.length; ni += m.indices.length; }
  const positions = new Float32Array(nv), indices = new Uint32Array(ni);
  let ov = 0, oi = 0;
  for (const m of list) {
    positions.set(m.positions, ov);
    const base = ov / 3;
    for (let i = 0; i < m.indices.length; i++) indices[oi + i] = m.indices[i] + base;
    ov += m.positions.length;
    oi += m.indices.length;
  }
  return { positions, indices };
}

// Applies a column-major 4×4 matrix to all vertices (returns a new mesh).
export function transformMesh(m, M) {
  const p = m.positions, out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    out[i] = M[0] * x + M[4] * y + M[8] * z + M[12];
    out[i + 1] = M[1] * x + M[5] * y + M[9] * z + M[13];
    out[i + 2] = M[2] * x + M[6] * y + M[10] * z + M[14];
  }
  let indices = m.indices;
  // a mirroring matrix would flip the winding
  const det = M[0] * (M[5] * M[10] - M[9] * M[6]) - M[4] * (M[1] * M[10] - M[9] * M[2]) + M[8] * (M[1] * M[6] - M[5] * M[2]);
  if (det < 0) {
    indices = new Uint32Array(m.indices);
    for (let i = 0; i < indices.length; i += 3) { const t = indices[i + 1]; indices[i + 1] = indices[i + 2]; indices[i + 2] = t; }
  }
  return { positions: out, indices };
}

// Drops vertices no triangle references.
export function compact(m) {
  const map = new Int32Array(m.positions.length / 3).fill(-1);
  let n = 0;
  for (let i = 0; i < m.indices.length; i++) { const v = m.indices[i]; if (map[v] < 0) map[v] = n++; }
  const positions = new Float32Array(n * 3);
  for (let v = 0; v < map.length; v++) {
    const t = map[v];
    if (t >= 0) { positions[t * 3] = m.positions[v * 3]; positions[t * 3 + 1] = m.positions[v * 3 + 1]; positions[t * 3 + 2] = m.positions[v * 3 + 2]; }
  }
  const indices = new Uint32Array(m.indices.length);
  for (let i = 0; i < indices.length; i++) indices[i] = map[m.indices[i]];
  return { positions, indices };
}

// Removes small connected components (noise blobs). Keeps components with at
// least minTris triangles and at least minFraction of the largest component.
export function removeSmallComponents(m, { minTris = 50, minFraction = 0.02 } = {}) {
  const nv = m.positions.length / 3, idx = m.indices;
  const parent = new Int32Array(nv);
  for (let i = 0; i < nv; i++) parent[i] = i;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const unite = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  for (let i = 0; i < idx.length; i += 3) { unite(idx[i], idx[i + 1]); unite(idx[i], idx[i + 2]); }
  const count = new Map();
  for (let i = 0; i < idx.length; i += 3) { const r = find(idx[i]); count.set(r, (count.get(r) || 0) + 1); }
  let largest = 0;
  for (const c of count.values()) largest = Math.max(largest, c);
  const keepMin = Math.max(minTris, largest * minFraction);
  const out = [];
  for (let i = 0; i < idx.length; i += 3) {
    if (count.get(find(idx[i])) >= keepMin) out.push(idx[i], idx[i + 1], idx[i + 2]);
  }
  return compact({ positions: m.positions, indices: new Uint32Array(out) });
}

function adjacency(m) {
  const nv = m.positions.length / 3, idx = m.indices;
  const deg = new Uint32Array(nv + 1);
  for (let i = 0; i < idx.length; i += 3) {
    deg[idx[i]] += 2; deg[idx[i + 1]] += 2; deg[idx[i + 2]] += 2;
  }
  const start = new Uint32Array(nv + 1);
  for (let v = 0; v < nv; v++) start[v + 1] = start[v] + deg[v];
  const fill = start.slice(0, nv);
  const nb = new Uint32Array(start[nv]);
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i], b = idx[i + 1], c = idx[i + 2];
    nb[fill[a]++] = b; nb[fill[a]++] = c;
    nb[fill[b]++] = a; nb[fill[b]++] = c;
    nb[fill[c]++] = a; nb[fill[c]++] = b;
  }
  return { start, nb };
}

// Taubin smoothing (λ|μ): removes noise without shrinking the object.
export function taubinSmooth(m, iterations = 5, lambda = 0.5, mu = -0.53) {
  if (iterations <= 0) return m;
  const { start, nb } = adjacency(m);
  const nv = m.positions.length / 3;
  let p = new Float32Array(m.positions), q = new Float32Array(p.length);
  const pass = (f) => {
    for (let v = 0; v < nv; v++) {
      const s = start[v], e = start[v + 1];
      if (e === s) { q[v * 3] = p[v * 3]; q[v * 3 + 1] = p[v * 3 + 1]; q[v * 3 + 2] = p[v * 3 + 2]; continue; }
      let x = 0, y = 0, z = 0;
      for (let k = s; k < e; k++) { const n = nb[k] * 3; x += p[n]; y += p[n + 1]; z += p[n + 2]; }
      const inv = 1 / (e - s);
      q[v * 3] = p[v * 3] + f * (x * inv - p[v * 3]);
      q[v * 3 + 1] = p[v * 3 + 1] + f * (y * inv - p[v * 3 + 1]);
      q[v * 3 + 2] = p[v * 3 + 2] + f * (z * inv - p[v * 3 + 2]);
    }
    const t = p; p = q; q = t;
  };
  for (let i = 0; i < iterations; i++) { pass(lambda); pass(mu); }
  return { positions: p, indices: m.indices };
}

// Vertex clustering: merges all vertices within a grid cell (fast, robust).
export function decimateCluster(m, cell) {
  const p = m.positions, nv = p.length / 3;
  const b = bounds(m);
  const ny = Math.ceil((b.max[1] - b.min[1]) / cell) + 1, nz = Math.ceil((b.max[2] - b.min[2]) / cell) + 1;
  const cellOf = new Map();
  const remap = new Uint32Array(nv);
  const acc = [];
  for (let v = 0; v < nv; v++) {
    const kx = Math.floor((p[v * 3] - b.min[0]) / cell);
    const ky = Math.floor((p[v * 3 + 1] - b.min[1]) / cell);
    const kz = Math.floor((p[v * 3 + 2] - b.min[2]) / cell);
    const key = (kx * ny + ky) * nz + kz;
    let c = cellOf.get(key);
    if (c === undefined) { c = acc.length / 4; cellOf.set(key, c); acc.push(0, 0, 0, 0); }
    acc[c * 4] += p[v * 3]; acc[c * 4 + 1] += p[v * 3 + 1]; acc[c * 4 + 2] += p[v * 3 + 2]; acc[c * 4 + 3]++;
    remap[v] = c;
  }
  const positions = new Float32Array((acc.length / 4) * 3);
  for (let c = 0; c < acc.length / 4; c++) {
    const n = acc[c * 4 + 3];
    positions[c * 3] = acc[c * 4] / n; positions[c * 3 + 1] = acc[c * 4 + 1] / n; positions[c * 3 + 2] = acc[c * 4 + 2] / n;
  }
  const seen = new Set();
  const out = [];
  const idx = m.indices;
  for (let i = 0; i < idx.length; i += 3) {
    const a = remap[idx[i]], b = remap[idx[i + 1]], c = remap[idx[i + 2]];
    if (a === b || b === c || a === c) continue;
    // de-duplicate identical triangles (independent of rotation)
    let k0 = a, k1 = b, k2 = c;
    if (k1 < k0 && k1 < k2) { k0 = b; k1 = c; k2 = a; } else if (k2 < k0 && k2 < k1) { k0 = c; k1 = a; k2 = b; }
    const key = k0 + ',' + k1 + ',' + k2;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a, b, c);
  }
  return compact({ positions, indices: new Uint32Array(out) });
}

// Reduces to roughly targetTris triangles (binary search on cell size).
export function decimateToTarget(m, targetTris) {
  if (triangleCount(m) <= targetTris) return m;
  const b = bounds(m);
  const diag = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  let lo = diag * 1e-5, hi = diag / 4, best = null;
  for (let it = 0; it < 18; it++) {
    const mid = Math.sqrt(lo * hi);
    const r = decimateCluster(m, mid);
    if (triangleCount(r) > targetTris) lo = mid; else { hi = mid; best = r; }
    if (best && triangleCount(best) > targetTris * 0.9) break;
  }
  return best || decimateCluster(m, hi);
}

// Signed volume (closed meshes: > 0 when triangles face outward).
export function signedVolume(m) {
  const p = m.positions, idx = m.indices;
  let v = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
      - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
      + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

// Number of edges with exactly one adjacent triangle (0 = watertight).
export function boundaryEdgeCount(m) {
  const idx = m.indices, cnt = new Map();
  const add = (a, b) => { const k = a < b ? a * 4294967296 + b : b * 4294967296 + a; cnt.set(k, (cnt.get(k) || 0) + 1); };
  for (let i = 0; i < idx.length; i += 3) { add(idx[i], idx[i + 1]); add(idx[i + 1], idx[i + 2]); add(idx[i + 2], idx[i]); }
  let n = 0;
  for (const c of cnt.values()) if (c === 1) n++;
  return n;
}

// Surface area in square units.
export function surfaceArea(m) {
  const p = m.positions, idx = m.indices;
  let s = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    s += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  return s;
}
