// Turns a stored scan into export parts in CAD space (mm, Z up).
import * as ops from '../mesh/ops.js';
import { cadMatrix, pointToCad, dirToCad } from '../mesh/cad.js';
import { measurementGeometry } from '../mesh/primitives.js';
import { toBinarySTL } from './stl.js';
import { toSTEP } from './step.js';
import { toOBJ } from './obj.js';

export const DEFAULT_OPTIONS = {
  scan: true,
  sceneMesh: true,
  planes: false,
  measurements: true,
  smooth: 3,
  clean: true,
  align: true,
  stepMaxTris: 30000,
  cutBottom: 0, // mm above the box floor; removes table/floor remnants (object modes only)
};

// Dominant wall direction from the horizontal normals: area-weighted mean
// of 4θ (walls at 90° to each other map onto the same direction).
export function dominantYaw(mesh) {
  const p = mesh.positions, idx = mesh.indices;
  let sx = 0, sy = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const area = Math.hypot(nx, ny, nz);
    if (area === 0 || Math.abs(ny) / area > 0.3) continue; // only (nearly) vertical faces
    const th = Math.atan2(nz, nx);
    sx += area * Math.cos(4 * th);
    sy += area * Math.sin(4 * th);
  }
  if (sx === 0 && sy === 0) return 0;
  // three.js yaw convention: local X axis = (cos ψ, 0, -sin ψ) → ψ = -θ
  return -Math.atan2(sy, sx) / 4;
}

// Drops triangles whose centroid lies below z (CAD space).
function clipBelow(m, z) {
  const p = m.positions, idx = m.indices, out = [];
  for (let t = 0; t < idx.length; t += 3) {
    const zc = (p[idx[t] * 3 + 2] + p[idx[t + 1] * 3 + 2] + p[idx[t + 2] * 3 + 2]) / 3;
    if (zc >= z) out.push(idx[t], idx[t + 1], idx[t + 2]);
  }
  return ops.compact({ positions: p, indices: new Uint32Array(out) });
}

function planeMesh(poly) {
  const pos = new Float32Array(poly.flat());
  const idx = [];
  for (let i = 1; i < poly.length - 1; i++) idx.push(0, i, i + 1);
  return { positions: pos, indices: new Uint32Array(idx) };
}

/** @returns {{parts: {name, mesh}[], frame: {origin, yaw}, info: object}} */
export function buildParts(rec, opt = DEFAULT_OPTIONS) {
  let scan = rec.mesh;
  if (opt.clean && scan.indices.length) scan = ops.removeSmallComponents(scan, { minTris: 40, minFraction: 0.01 });
  if (opt.smooth > 0 && scan.indices.length) scan = ops.taubinSmooth(scan, opt.smooth);

  const sceneMesh = rec.sceneMeshes?.length ? ops.mergeMeshes(rec.sceneMeshes) : null;
  let yaw = rec.yaw ?? 0;
  if (rec.yaw == null && opt.align) {
    const ref = scan.indices.length ? scan : sceneMesh;
    yaw = ref ? dominantYaw(ref) : 0;
  }
  const frame = { origin: rec.origin || [0, 0, 0], yaw };
  const M = cadMatrix(frame);
  const parts = [];
  if (opt.scan && scan.indices.length) {
    let cad = ops.transformMesh(scan, M);
    if (rec.box && opt.cutBottom > 0) {
      cad = clipBelow(cad, opt.cutBottom);
      if (opt.clean) cad = ops.removeSmallComponents(cad, { minTris: 40, minFraction: 0.01 });
    }
    if (cad.indices.length) parts.push({ name: 'Scan', mesh: cad });
  }
  if (opt.sceneMesh && sceneMesh) parts.push({ name: 'Quest-Raum-Mesh', mesh: ops.transformMesh(sceneMesh, M) });
  if (opt.planes && rec.planes?.length) {
    parts.push({ name: 'Raumflaechen', mesh: ops.transformMesh(ops.mergeMeshes(rec.planes.filter((p) => p.polygon.length >= 3).map((p) => planeMesh(p.polygon))), M) });
  }
  if (opt.measurements && rec.measurements?.length) {
    const geo = rec.measurements.flatMap((m) => measurementGeometry(m));
    if (geo.length) parts.push({ name: 'Messungen', mesh: ops.transformMesh(ops.mergeMeshes(geo), M) });
  }
  return { parts, frame };
}

function safeName(s) {
  const map = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss' };
  return s.replace(/[äöüÄÖÜß]/g, (c) => map[c]).replace(/[^\w\-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'scan';
}

export function exportFile(rec, format, opt = DEFAULT_OPTIONS) {
  const { parts, frame } = buildParts(rec, opt);
  const base = safeName(rec.name);
  if (format === 'csv') return { name: `${base}_Messungen.csv`, data: measurementsCSV(rec, frame), type: 'text/csv' };
  if (!parts.length) throw new Error('Nichts zu exportieren – Optionen prüfen.');
  if (format === 'stl') {
    const merged = ops.mergeMeshes(parts.map((p) => p.mesh));
    return { name: `${base}.stl`, data: toBinarySTL(merged, `Quest 3S Scanner ${base}`.slice(0, 80)), type: 'model/stl', tris: ops.triangleCount(merged) };
  }
  if (format === 'obj') return { name: `${base}.obj`, data: toOBJ(parts), type: 'text/plain' };
  if (format === 'step') {
    const total = parts.reduce((s, p) => s + ops.triangleCount(p.mesh), 0);
    const reduced = parts.map((p) => {
      const share = Math.max(200, Math.round(opt.stepMaxTris * ops.triangleCount(p.mesh) / Math.max(1, total)));
      return { name: p.name, mesh: ops.decimateToTarget(p.mesh, share) };
    });
    const tris = reduced.reduce((s, p) => s + ops.triangleCount(p.mesh), 0);
    return { name: `${base}.step`, data: toSTEP(reduced, { name: base }), type: 'application/step', tris };
  }
  throw new Error('Unbekanntes Format ' + format);
}

export function measurementsCSV(rec, frame) {
  const f = (v) => v.toFixed(2).replace('.', ',');
  const rows = [['Nr', 'Typ', 'Ergebnis', 'Wert_mm', 'X_mm', 'Y_mm', 'Z_mm', 'Nx', 'Ny', 'Nz', 'Abweichung_mm', 'Punkte (X/Y/Z mm)'].join(';')];
  rec.measurements.forEach((m, i) => {
    let value = '', at = m.points[0], n = null, dev = '';
    if (m.type === 'distance') value = f(m.value * 1000);
    if (m.type === 'circle') { value = f(m.diameter * 1000); at = m.center; n = m.normal; dev = f(m.rms * 1000); }
    if (m.type === 'plane') { at = m.centroid; n = m.normal; dev = f(m.rms * 1000); }
    const c = pointToCad(at, frame);
    const nc = n ? dirToCad(n, frame) : null;
    const pts = m.points.map((p) => pointToCad(p, frame).map(f).join('/')).join(' | ');
    rows.push([i + 1, m.type, m.label, value, ...c.map(f), ...(nc ? nc.map((v) => v.toFixed(4).replace('.', ',')) : ['', '', '']), dev, pts].join(';'));
  });
  return '﻿' + rows.join('\r\n') + '\r\n';
}
