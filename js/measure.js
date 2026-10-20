// Measurement math: plane and circle fits, controller tip (pivot) calibration.
// Points are [x, y, z] arrays in meters.

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const normalize = (a) => scale(a, 1 / (norm(a) || 1));

export const vec = { sub, dot, cross, norm, scale, normalize };

export function distance(a, b) {
  return norm(sub(a, b));
}

export function centroid(pts) {
  const c = [0, 0, 0];
  for (const p of pts) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  return scale(c, 1 / pts.length);
}

// Eigen decomposition of a symmetric 3×3 matrix (Jacobi). Returns eigenvalues
// ascending with matching eigenvectors.
export function symEig3(A) {
  const a = A.map((r) => r.slice());
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) off += a[i][j] * a[i][j];
    if (off < 1e-30) break;
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-30) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = V[k][p], vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j]);
  return {
    values: order.map((i) => a[i][i]),
    vectors: order.map((i) => [V[0][i], V[1][i], V[2][i]]),
  };
}

// Least-squares plane. normal = direction of least variance.
export function fitPlane(pts) {
  if (pts.length < 3) return null;
  const c = centroid(pts);
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of pts) {
    const d = sub(p, c);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += d[i] * d[j];
  }
  const { vectors } = symEig3(C);
  let n = normalize(vectors[0]);
  if (n[1] < 0 || (Math.abs(n[1]) < 1e-6 && n[2] < 0)) n = scale(n, -1);
  let rms = 0;
  for (const p of pts) rms += dot(sub(p, c), n) ** 2;
  rms = Math.sqrt(rms / pts.length);
  return { centroid: c, normal: n, u: normalize(vectors[2]), v: normalize(cross(n, vectors[2])), rms };
}

// Solves the linear system A x = b (Gauss with partial pivoting).
export function solve(A, b) {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-14) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

// Circle through ≥3 points in 3D: fit a plane, then the 2D circle (Kasa fit).
// Useful for the diameter and axis of rods/tubes (e.g. a clothes rail).
export function fitCircle(pts) {
  if (pts.length < 3) return null;
  const pl = fitPlane(pts);
  const { centroid: c, u, v, normal } = pl;
  const P = pts.map((p) => { const d = sub(p, c); return [dot(d, u), dot(d, v)]; });
  // x² + y² + D x + E y + F = 0
  const AtA = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], Atb = [0, 0, 0];
  for (const [x, y] of P) {
    const row = [x, y, 1], rhs = -(x * x + y * y);
    for (let i = 0; i < 3; i++) { Atb[i] += row[i] * rhs; for (let j = 0; j < 3; j++) AtA[i][j] += row[i] * row[j]; }
  }
  const s = solve(AtA, Atb);
  if (!s) return null;
  const cx = -s[0] / 2, cy = -s[1] / 2;
  const r2 = cx * cx + cy * cy - s[2];
  if (!(r2 > 0)) return null;
  const radius = Math.sqrt(r2);
  const center = [c[0] + u[0] * cx + v[0] * cy, c[1] + u[1] * cx + v[1] * cy, c[2] + u[2] * cx + v[2] * cy];
  let rms = 0;
  for (const [x, y] of P) rms += (Math.hypot(x - cx, y - cy) - radius) ** 2;
  rms = Math.sqrt(rms / P.length);
  return { center, normal, radius, diameter: 2 * radius, rms, planeRms: pl.rms };
}

/**
 * Pivot calibration: the tip is held on a fixed point while the controller
 * is rotated. Solves R_i·p + t_i = q for the tip offset p (controller frame)
 * and the pivot q (world) in the least-squares sense.
 * @param {{R: number[] /* column-major 3×3 or 4×4 *\/, t: number[]}[]} poses
 */
export function pivotCalibration(poses) {
  if (poses.length < 10) return null;
  const AtA = Array.from({ length: 6 }, () => new Array(6).fill(0));
  const Atb = new Array(6).fill(0);
  for (const { m } of poses) {
    // m: column-major 4×4
    const R = [[m[0], m[4], m[8]], [m[1], m[5], m[9]], [m[2], m[6], m[10]]];
    const t = [m[12], m[13], m[14]];
    for (let r = 0; r < 3; r++) {
      const row = [R[r][0], R[r][1], R[r][2], r === 0 ? -1 : 0, r === 1 ? -1 : 0, r === 2 ? -1 : 0];
      const rhs = -t[r];
      for (let i = 0; i < 6; i++) { Atb[i] += row[i] * rhs; for (let j = 0; j < 6; j++) AtA[i][j] += row[i] * row[j]; }
    }
  }
  const x = solve(AtA, Atb);
  if (!x) return null;
  const tip = x.slice(0, 3), pivot = x.slice(3);
  let rms = 0;
  for (const { m } of poses) {
    const w = [
      m[0] * tip[0] + m[4] * tip[1] + m[8] * tip[2] + m[12],
      m[1] * tip[0] + m[5] * tip[1] + m[9] * tip[2] + m[13],
      m[2] * tip[0] + m[6] * tip[1] + m[10] * tip[2] + m[14],
    ];
    rms += distance(w, pivot) ** 2;
  }
  rms = Math.sqrt(rms / poses.length);
  return { tip, pivot, rms };
}

// Rotation angle (degrees) between the orientations of two poses (column-major 4×4).
function rotationAngleDeg(a, b) {
  // trace(Ra^T Rb) = 1 + 2 cos θ
  let tr = 0;
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) tr += a[c * 4 + r] * b[c * 4 + r];
  return (Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) * 180) / Math.PI;
}

function residuals(poses, tip, pivot) {
  return poses.map(({ m }) => distance([
    m[0] * tip[0] + m[4] * tip[1] + m[8] * tip[2] + m[12],
    m[1] * tip[0] + m[5] * tip[1] + m[9] * tip[2] + m[13],
    m[2] * tip[0] + m[6] * tip[1] + m[10] * tip[2] + m[14],
  ], pivot));
}

/**
 * Pivot calibration that tolerates slipping: poses whose tip lands far from the
 * pivot (residual > max(3 × median, 2 mm)) are dropped and the fit is repeated.
 * Also reports how much the controller was tilted (coverage, 100 % ≙ 50°).
 * @returns {{tip, pivot, rms, used, total, coverage}|null}
 */
export function robustPivotCalibration(poses) {
  if (poses.length < 10) return null;
  let set = poses;
  let r = pivotCalibration(set);
  for (let it = 0; it < 3 && r; it++) {
    const res = residuals(set, r.tip, r.pivot);
    const sorted = res.slice().sort((a, b) => a - b);
    const lim = Math.max(3 * sorted[sorted.length >> 1], 0.002);
    const keep = set.filter((_, i) => res[i] <= lim);
    if (keep.length === set.length || keep.length < 10) break;
    set = keep;
    r = pivotCalibration(set);
  }
  if (!r) return null;
  // largest tilt between any kept pose and the first/middle/last one
  let maxAngle = 0;
  const refs = [set[0], set[set.length >> 1], set[set.length - 1]];
  for (const ref of refs) for (const p of set) maxAngle = Math.max(maxAngle, rotationAngleDeg(ref.m, p.m));
  return { ...r, used: set.length, total: poses.length, coverage: Math.min(1, maxAngle / 50) };
}

// Evaluates a measurement from its points.
export function evaluateMeasurement(type, points) {
  switch (type) {
    case 'point':
      return points.length >= 1 ? { type, points: points.slice(0, 1), done: true } : null;
    case 'distance': {
      if (points.length < 2) return null;
      const [a, b] = points;
      const d = sub(b, a);
      return { type, points: [a, b], value: norm(d), dx: Math.abs(d[0]), dy: Math.abs(d[1]), dz: Math.abs(d[2]), done: true };
    }
    case 'circle': {
      const c = fitCircle(points);
      return c ? { type, points: points.slice(), ...c, done: false } : null;
    }
    case 'plane': {
      const p = fitPlane(points);
      return p ? { type, points: points.slice(), ...p, done: false } : null;
    }
  }
  return null;
}

export function describeMeasurement(m) {
  const mm = (v) => (v * 1000).toFixed(1) + ' mm';
  switch (m.type) {
    case 'point': return `Punkt`;
    case 'distance': return `Abstand ${mm(m.value)}`;
    case 'circle': return `Ø ${mm(m.diameter)} (Abw. ${mm(m.rms)})`;
    case 'plane': return `Ebene, Ebenheit ${mm(m.rms)}`;
  }
  return m.type;
}
