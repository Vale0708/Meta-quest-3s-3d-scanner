// Synthetic depth camera for tests: analytic ray casting.

export function perspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect; m[5] = f; m[10] = (far + near) / (near - far); m[11] = -1; m[14] = (2 * far * near) / (near - far);
  return m;
}

export function lookAt(eye, target, up = [0, 1, 0]) {
  const z = norm(sub(eye, target)); // camera looks along -Z
  const x = norm(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([...x, 0, ...y, 0, ...z, 0, ...eye, 1]);
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a); return a.map((v) => v / l); };

// scene: list of {type:'sphere', c, r} | {type:'plane', y} | {type:'plane', n, d} | {type:'box', min, max}
export function renderDepth(scene, camToWorld, proj, W, H, noise = 0, rnd = Math.random) {
  const depth = new Float32Array(W * H);
  const M = camToWorld, P = proj;
  const eye = [M[12], M[13], M[14]];
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const xn = ((i + 0.5) / W) * 2 - 1, yn = ((j + 0.5) / H) * 2 - 1;
      const cy = (yn + P[9]) / P[5], cx = (xn + P[8] - P[4] * cy) / P[0];
      const d = [M[0] * cx + M[4] * cy - M[8], M[1] * cx + M[5] * cy - M[9], M[2] * cx + M[6] * cy - M[10]];
      let best = Infinity;
      for (const o of scene) {
        let t = Infinity;
        if (o.type === 'sphere') {
          const oc = sub(eye, o.c);
          const a = d[0] ** 2 + d[1] ** 2 + d[2] ** 2, b = 2 * (oc[0] * d[0] + oc[1] * d[1] + oc[2] * d[2]);
          const c = oc[0] ** 2 + oc[1] ** 2 + oc[2] ** 2 - o.r * o.r;
          const disc = b * b - 4 * a * c;
          if (disc >= 0) { const t0 = (-b - Math.sqrt(disc)) / (2 * a); if (t0 > 0) t = t0; }
        } else if (o.type === 'plane') {
          // n·x = dist  (shortcut {y} for horizontal planes)
          const n = o.n || [0, 1, 0], dist = o.n ? o.d : o.y;
          const den = n[0] * d[0] + n[1] * d[1] + n[2] * d[2];
          if (Math.abs(den) > 1e-9) { const t0 = (dist - (n[0] * eye[0] + n[1] * eye[1] + n[2] * eye[2])) / den; if (t0 > 0) t = t0; }
        } else if (o.type === 'box') {
          let tmin = -Infinity, tmax = Infinity;
          for (let k = 0; k < 3; k++) {
            const inv = 1 / d[k];
            let ta = (o.min[k] - eye[k]) * inv, tb = (o.max[k] - eye[k]) * inv;
            if (ta > tb) [ta, tb] = [tb, ta];
            tmin = Math.max(tmin, ta); tmax = Math.min(tmax, tb);
          }
          if (tmax >= tmin && tmin > 0) t = tmin;
        }
        if (t < best) best = t;
      }
      // t is z-depth because d has z-component -1 in camera space
      if (best < Infinity) depth[j * W + i] = best + (noise ? (rnd() * 2 - 1) * noise * best : 0);
    }
  }
  return depth;
}

export function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
