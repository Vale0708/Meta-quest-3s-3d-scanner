// Node tests for the core algorithms: node test/run-tests.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { TsdfVolume } from '../js/fusion/tsdf.js';
import * as ops from '../js/mesh/ops.js';
import { toBinarySTL, parseBinarySTL } from '../js/export/stl.js';
import { toSTEP } from '../js/export/step.js';
import { toOBJ } from '../js/export/obj.js';
import { fitCircle, fitPlane, pivotCalibration, robustPivotCalibration } from '../js/measure.js';
import { cylinder } from '../js/mesh/primitives.js';
import { perspective, lookAt, renderDepth, renderColor, mulberry32 } from '../js/sim/synth.js';
import { toPLY } from '../js/export/ply.js';
import { toCadSpace } from '../js/mesh/cad.js';
import { dominantYaw } from '../js/export/pipeline.js';

let failed = 0;
function check(name, cond, info = '') {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name} ${info}`);
  if (!cond) failed++;
}

const outDir = new URL('./out/', import.meta.url);
mkdirSync(outDir, { recursive: true });

// --- 1. Fusion of a sphere on a floor, scanned all around ---
{
  const center = [0, 0.08, -0.5], r = 0.06;
  const scene = [{ type: 'sphere', c: center, r }, { type: 'plane', y: 0 }];
  const vol = new TsdfVolume({
    voxelSize: 0.004, truncation: 0.016, minDepth: 0.1, maxDepth: 1.5,
    box: { center: [center[0], 0.08, center[2]], half: [0.1, 0.075, 0.1], yaw: 0.3 },
  });
  const P = perspective(Math.PI / 2, 1, 0.1, 100);
  const rnd = mulberry32(1);
  const t0 = performance.now();
  let frames = 0;
  for (let el = 0.3; el <= 1.2; el += 0.3) {
    for (let az = 0; az < Math.PI * 2; az += Math.PI / 8) {
      const dist = 0.4;
      const eye = [center[0] + Math.cos(az) * Math.cos(el) * dist, center[1] + Math.sin(el) * dist, center[2] + Math.sin(az) * Math.cos(el) * dist];
      const M = lookAt(eye, center);
      const depth = renderDepth(scene, M, P, 160, 160, 0.003, rnd);
      vol.integrate({ width: 160, height: 160, depth, proj: P, camToWorld: M });
      frames++;
    }
  }
  const tInt = (performance.now() - t0) / frames;
  const t1 = performance.now();
  let mesh = vol.extractMesh({ minWeight: 1 });
  const tExt = performance.now() - t1;
  check('Integration schnell genug', tInt < 80, `${tInt.toFixed(1)} ms/Frame`);
  check('Extraktion', mesh.indices.length > 0, `${ops.triangleCount(mesh)} Dreiecke in ${tExt.toFixed(0)} ms, ${vol.stats().blocks} Blöcke`);
  mesh = ops.removeSmallComponents(mesh);
  mesh = ops.taubinSmooth(mesh, 3);
  // sphere vertices: those above the floor band
  let sum = 0, sum2 = 0, n = 0;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const y = mesh.positions[i + 1];
    if (y < 0.03) continue;
    const d = Math.hypot(mesh.positions[i] - center[0], y - center[1], mesh.positions[i + 2] - center[2]);
    sum += d; sum2 += d * d; n++;
  }
  const mean = sum / n, sd = Math.sqrt(sum2 / n - mean * mean);
  check('Kugelradius genau (±1 mm)', Math.abs(mean - r) < 0.001, `r=${(mean * 1000).toFixed(2)} mm (soll ${r * 1000}), σ=${(sd * 1000).toFixed(2)} mm`);
  // orientation: normals point away from the sphere center
  let out = 0, inn = 0;
  const p = mesh.positions, idx = mesh.indices;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    if (p[a + 1] < 0.03) continue;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const s = nx * (p[a] - center[0]) + ny * (p[a + 1] - center[1]) + nz * (p[a + 2] - center[2]);
    if (s > 0) out++; else inn++;
  }
  check('Normalen zeigen nach außen', out > inn * 20, `${out} außen / ${inn} innen`);

  const cad = toCadSpace(mesh, { origin: [center[0], 0, center[2]] });
  const b = ops.bounds(cad);
  check('CAD-Koordinaten: Z oben, mm', Math.abs(b.max[2] - 140) < 3 && b.min[2] >= -1, `z ${b.min[2].toFixed(1)}…${b.max[2].toFixed(1)} mm`);
  check('Spiegelfrei (Volumen-Vorzeichen erhalten)', Math.sign(ops.signedVolume(cad)) === Math.sign(ops.signedVolume(mesh)));

  const stl = toBinarySTL(cad);
  const back = parseBinarySTL(stl);
  check('STL Roundtrip', ops.triangleCount(back) === ops.triangleCount(cad), `${(stl.byteLength / 1024).toFixed(0)} KB`);
  writeFileSync(new URL('sphere.stl', outDir), Buffer.from(stl));
  const small = ops.decimateToTarget(cad, 3000);
  check('Dezimierung', ops.triangleCount(small) <= 3000 && ops.triangleCount(small) > 1500, `${ops.triangleCount(small)} Dreiecke`);
  const step = toSTEP([{ name: 'Scan', mesh: small }], { name: 'Kugel' });
  writeFileSync(new URL('sphere.step', outDir), step);
  writeFileSync(new URL('sphere.obj', outDir), toOBJ([{ name: 'Scan', mesh: small }]));
  check('STEP geschrieben', step.startsWith('ISO-10303-21;') && step.trimEnd().endsWith('END-ISO-10303-21;'), `${(step.length / 1024).toFixed(0)} KB`);
}

// --- 2. Closed sphere without floor → watertight and positive volume ---
{
  const center = [0.3, 1.2, -0.2], r = 0.08;
  const scene = [{ type: 'sphere', c: center, r }];
  const vol = new TsdfVolume({ voxelSize: 0.005, truncation: 0.02, maxDepth: 2 });
  const P = perspective(1.2, 1, 0.1, 100);
  for (let el = -1.2; el <= 1.21; el += 0.4) {
    for (let az = 0; az < Math.PI * 2; az += Math.PI / 6) {
      const eye = [center[0] + Math.cos(az) * Math.cos(el) * 0.5, center[1] + Math.sin(el) * 0.5, center[2] + Math.sin(az) * Math.cos(el) * 0.5];
      const up = Math.abs(Math.sin(el)) > 0.99 ? [1, 0, 0] : [0, 1, 0];
      const M = lookAt(eye, center, up);
      vol.integrate({ width: 128, height: 128, depth: renderDepth(scene, M, P, 128, 128), proj: P, camToWorld: M });
    }
  }
  const mesh = vol.extractMesh({ minWeight: 1 });
  const V = ops.signedVolume(mesh), Vs = (4 / 3) * Math.PI * r ** 3;
  check('Geschlossene Kugel: wasserdicht', ops.boundaryEdgeCount(mesh) === 0, `${ops.boundaryEdgeCount(mesh)} offene Kanten`);
  check('Geschlossene Kugel: Volumen', Math.abs(V / Vs - 1) < 0.03, `${(V / Vs * 100).toFixed(1)} % des Sollvolumens`);
}

// --- 3. Room-scale: box-shaped room, 3 cm voxels, no box limit ---
{
  const scene = [{ type: 'plane', y: 0 }, { type: 'box', min: [-0.5, 0, -2.5], max: [0.5, 0.8, -1.8] }];
  const vol = new TsdfVolume({ voxelSize: 0.03, truncation: 0.1, maxDepth: 4 });
  const P = perspective(1.4, 1, 0.1, 100);
  const t0 = performance.now();
  let k = 0;
  for (let az = -0.8; az <= 0.8; az += 0.2, k++) {
    const M = lookAt([0, 1.6, 0], [Math.sin(az) * 2, 0.4, -Math.cos(az) * 2]);
    vol.integrate({ width: 160, height: 160, depth: renderDepth(scene, M, P, 160, 160, 0.01, mulberry32(k)), proj: P, camToWorld: M });
  }
  const tInt = (performance.now() - t0) / k;
  const mesh = vol.extractMesh();
  const b = ops.bounds(mesh);
  check('Raum-Modus Integration', tInt < 150, `${tInt.toFixed(1)} ms/Frame, ${vol.stats().blocks} Blöcke, ${ops.triangleCount(mesh)} Dreiecke`);
  // top of box at 0.8 m
  let top = 0, cnt = 0;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = mesh.positions[i], y = mesh.positions[i + 1], z = mesh.positions[i + 2];
    if (Math.abs(x) < 0.4 && z < -1.9 && z > -2.4 && y > 0.5) { top += y; cnt++; }
  }
  check('Raum: Tischhöhe ±1 cm', cnt > 0 && Math.abs(top / cnt - 0.8) < 0.01, `${(top / cnt).toFixed(3)} m, Bounds y ${b.min[1].toFixed(2)}…${b.max[1].toFixed(2)}`);
}

// --- 4. Measurement fits ---
{
  const rnd = mulberry32(7);
  const c = [0.2, 1.7, -0.4], R = 0.0125, n = [1, 0, 0];
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 1.5; // only 3/4 of the circumference reachable
    pts.push([c[0] + (rnd() - 0.5) * 0.001, c[1] + Math.cos(a) * R + (rnd() - 0.5) * 0.0005, c[2] + Math.sin(a) * R + (rnd() - 0.5) * 0.0005]);
  }
  const fc = fitCircle(pts);
  check('Kreis-Fit (Kleiderstange Ø25)', Math.abs(fc.diameter - 0.025) < 0.0008 && Math.abs(Math.abs(fc.normal[0]) - 1) < 0.05, `Ø ${(fc.diameter * 1000).toFixed(2)} mm`);
  const pp = [];
  for (let i = 0; i < 20; i++) pp.push([rnd(), 0.75 + (rnd() - 0.5) * 0.001, rnd()]);
  const fp = fitPlane(pp);
  check('Ebenen-Fit', Math.abs(fp.normal[1] - 1) < 1e-3 && Math.abs(fp.centroid[1] - 0.75) < 1e-3, `rms ${(fp.rms * 1000).toFixed(2)} mm`);
  // pivot: tip offset [0, -0.02, -0.06] in controller space, pivot point q
  const tip = [0, -0.02, -0.06], q = [0.1, 0.9, -0.3];
  const poses = [];
  for (let i = 0; i < 40; i++) {
    const ax = (rnd() - 0.5) * 1.2, ay = (rnd() - 0.5) * 1.2;
    const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay);
    // R = Ry * Rx (column-major)
    const R = [[cy, sy * sx, sy * cx], [0, cx, -sx], [-sy, cy * sx, cy * cx]];
    const Rt = [0, 1, 2].map((r) => R[r][0] * tip[0] + R[r][1] * tip[1] + R[r][2] * tip[2]);
    const t = [q[0] - Rt[0] + (rnd() - 0.5) * 0.001, q[1] - Rt[1] + (rnd() - 0.5) * 0.001, q[2] - Rt[2] + (rnd() - 0.5) * 0.001];
    poses.push({ m: [R[0][0], R[1][0], R[2][0], 0, R[0][1], R[1][1], R[2][1], 0, R[0][2], R[1][2], R[2][2], 0, t[0], t[1], t[2], 1] });
  }
  // slipping: 15 % of the poses with the tip 1–3 cm away from the pivot
  const slipped = poses.map((p, i) => {
    if (i % 7 !== 3) return p;
    const m = p.m.slice();
    m[12] += 0.01 + rnd() * 0.02; m[14] -= 0.01 + rnd() * 0.02;
    return { m };
  });
  const naive = pivotCalibration(slipped);
  const robust = robustPivotCalibration(slipped);
  const errN = Math.hypot(naive.tip[0] - tip[0], naive.tip[1] - tip[1], naive.tip[2] - tip[2]);
  const errR = Math.hypot(robust.tip[0] - tip[0], robust.tip[1] - tip[1], robust.tip[2] - tip[2]);
  check('Kalibrierung trotz Verrutschen', errR < 0.002 && robust.used < slipped.length && robust.coverage > 0.5,
    `ohne Ausreißerfilter ${(errN * 1000).toFixed(1)} mm, mit ${(errR * 1000).toFixed(2)} mm (${robust.used}/${robust.total} Posen, Abdeckung ${Math.round(robust.coverage * 100)} %)`);
  const pc = pivotCalibration(poses);
  const err = Math.hypot(pc.tip[0] - tip[0], pc.tip[1] - tip[1], pc.tip[2] - tip[2]);
  check('Spitzen-Kalibrierung', err < 0.002, `Fehler ${(err * 1000).toFixed(2)} mm, rms ${(pc.rms * 1000).toFixed(2)} mm`);
  const cyl = cylinder([0, 0, 0], [0, 0, 1], 0.1, 32);
  check('Zylinder-Primitive geschlossen & außen orientiert', ops.boundaryEdgeCount(cyl) === 0 && ops.signedVolume(cyl) > 0, `V=${ops.signedVolume(cyl).toFixed(4)}`);
}


// --- 5. Room alignment to the walls ---
{
  const scene = [{ type: 'plane', y: 0 }, { type: 'box', min: [-1, 0, -2], max: [1, 0.7, -1.5] }];
  const vol = new TsdfVolume({ voxelSize: 0.03, truncation: 0.09, maxDepth: 4 });
  const P = perspective(1.4, 1, 0.1, 100);
  for (let a = -1; a <= 1; a += 0.25) {
    const M = lookAt([0, 1.6, 0], [Math.sin(a) * 2, 0.3, -Math.cos(a) * 2]);
    vol.integrate({ width: 120, height: 120, depth: renderDepth(scene, M, P, 120, 120), proj: P, camToWorld: M });
  }
  const mesh = vol.extractMesh();
  const psi = 0.3, c = Math.cos(psi), s = Math.sin(psi);
  const rot = new Float32Array(mesh.positions);
  for (let i = 0; i < rot.length; i += 3) {
    const x = rot[i], z = rot[i + 2];
    rot[i] = x * c + z * s; rot[i + 2] = -x * s + z * c; // three.js rotation.y = psi
  }
  const est = dominantYaw({ positions: rot, indices: mesh.indices });
  check('Raum an Wänden ausrichten', Math.abs(est - psi) < 0.01, `${(est * 180 / Math.PI).toFixed(2)}° (soll ${(psi * 180 / Math.PI).toFixed(2)}°)`);
  const cad = toCadSpace({ positions: rot, indices: mesh.indices }, { yaw: est });
  // table top (Z > 600 mm) must be an axis-parallel rectangle: 2000 × 500 mm
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < cad.positions.length; i += 3) {
    if (cad.positions[i + 2] < 600) continue;
    x0 = Math.min(x0, cad.positions[i]); x1 = Math.max(x1, cad.positions[i]);
    y0 = Math.min(y0, cad.positions[i + 1]); y1 = Math.max(y1, cad.positions[i + 1]);
  }
  check('Ausgerichtet: Tisch achsparallel', Math.abs(x1 - x0 - 2000) < 100 && Math.abs(y1 - y0 - 500) < 120, `${(x1 - x0).toFixed(0)} × ${(y1 - y0).toFixed(0)} mm (soll 2000 × 500)`);
}

// --- 6. Color fusion: sphere red on top, blue below; color camera offset from the depth camera ---
{
  const center = [0, 1.0, -0.6], r = 0.08;
  const scene = [{ type: 'sphere', c: center, r, colorFn: (p) => (p[1] > center[1] ? [220, 30, 30] : [30, 60, 220]) }];
  const vol = new TsdfVolume({ voxelSize: 0.005, truncation: 0.02, maxDepth: 2, color: true });
  const P = perspective(1.2, 1, 0.1, 100);
  const PC = perspective(1.0, 4 / 3, 0.1, 100); // different FOV/aspect than depth
  for (let el = -0.8; el <= 0.81; el += 0.4) {
    for (let az = 0; az < Math.PI * 2; az += Math.PI / 6) {
      const eye = [center[0] + Math.cos(az) * Math.cos(el) * 0.5, center[1] + Math.sin(el) * 0.5, center[2] + Math.sin(az) * Math.cos(el) * 0.5];
      const M = lookAt(eye, center);
      // color camera 3 cm to the right of the depth camera, also aimed at the center
      const ce = [eye[0] + M[0] * 0.03, eye[1] + M[1] * 0.03, eye[2] + M[2] * 0.03];
      const MC = lookAt(ce, center);
      const rgba = renderColor(scene, MC, PC, 64, 48);
      vol.integrate({ width: 96, height: 96, depth: renderDepth(scene, M, P, 96, 96), proj: P, camToWorld: M },
        { width: 64, height: 48, rgba, proj: PC, camToWorld: MC });
    }
  }
  const mesh = vol.extractMesh({ minWeight: 1 });
  let good = 0, n = 0;
  for (let v = 0; v < mesh.positions.length / 3; v++) {
    const dy = mesh.positions[v * 3 + 1] - center[1];
    if (Math.abs(dy) < 0.015) continue; // equator: mixed colors are expected
    const red = mesh.colors[v * 3] > mesh.colors[v * 3 + 2];
    if (red === dy > 0) good++;
    n++;
  }
  check('Farbfusion: Farben am richtigen Ort', good / n > 0.97, `${(good / n * 100).toFixed(1)} % korrekt, ${mesh.colors.length / 3} Vertices`);
  const dec = ops.decimateToTarget(ops.taubinSmooth(mesh, 2), 2000);
  check('Farben überleben Glätten/Dezimieren', dec.colors && dec.colors.length === dec.positions.length);
  const ply = toPLY(toCadSpace(dec, {}));
  writeFileSync(new URL('color.ply', outDir), Buffer.from(ply));
  const step = toSTEP([{ name: 'Scan', mesh: toCadSpace(dec, {}) }, { name: 'Marker', color: [255, 80, 140], mesh: cylinder([0, 0, 0], [0, 0, 10], 2, 12) }], { name: 'Farbe' });
  writeFileSync(new URL('color.step', outDir), step);
  check('STEP mit Farben', step.includes('COLOUR_RGB') && step.includes('MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION'));
}

console.log(failed ? `\n${failed} Test(s) fehlgeschlagen` : '\nAlle Tests bestanden');
process.exit(failed ? 1 : 0);
