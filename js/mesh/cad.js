// Conversion from WebXR world space (meters, Y up, -Z forward) to CAD
// convention (millimeters, Z up, right-handed): x → X, -z → Y, y → Z.
import { transformMesh } from './ops.js?v=9e37035';

/**
 * @param {{positions: Float32Array, indices: Uint32Array}} mesh
 * @param {{origin?: number[], yaw?: number}} [o] origin in world coordinates (m),
 *        yaw: rotation about the vertical axis that should become the CAD X direction
 */
export function cadMatrix(o = {}) {
  const [ox, oy, oz] = o.origin || [0, 0, 0];
  const c = Math.cos(o.yaw || 0), s = Math.sin(o.yaw || 0);
  // first translate by -origin, then rotate by -yaw about Y, then axis swap + scale
  // local: lx = c*dx - s*dz, lz = s*dx + c*dz, ly = dy
  // CAD:   X = lx, Y = -lz, Z = ly (×1000)
  const k = 1000;
  const m = new Float32Array(16);
  m[0] = k * c; m[4] = 0; m[8] = -k * s;
  m[1] = -k * s; m[5] = 0; m[9] = -k * c;
  m[2] = 0; m[6] = k; m[10] = 0;
  m[12] = -(m[0] * ox + m[8] * oz);
  m[13] = -(m[1] * ox + m[9] * oz);
  m[14] = -k * oy;
  m[15] = 1;
  return m;
}

export function toCadSpace(mesh, o) {
  return transformMesh(mesh, cadMatrix(o));
}

export function pointToCad(p, o) {
  const m = cadMatrix(o);
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

// Direction vectors (without translation/scaling).
export function dirToCad(d, o) {
  const m = cadMatrix(o);
  return [(m[0] * d[0] + m[8] * d[2]) / 1000, (m[1] * d[0] + m[9] * d[2]) / 1000, d[1]];
}
