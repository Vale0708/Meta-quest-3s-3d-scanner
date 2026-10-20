// Simple triangle primitives (meters) to export measurements as geometry.
import { vec } from '../measure.js?v=9e37035';

function basis(n) {
  const a = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = vec.normalize(vec.cross(n, a));
  const v = vec.cross(n, u);
  return [u, v];
}

// Closed cylinder from p0 to p1 with radius r.
export function cylinder(p0, p1, r, seg = 24) {
  const axis = vec.sub(p1, p0);
  const n = vec.normalize(axis);
  const [u, v] = basis(n);
  const pos = [], idx = [];
  for (const base of [p0, p1]) {
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2, c = Math.cos(a) * r, s = Math.sin(a) * r;
      pos.push(base[0] + u[0] * c + v[0] * s, base[1] + u[1] * c + v[1] * s, base[2] + u[2] * c + v[2] * s);
    }
  }
  pos.push(...p0, ...p1);
  const c0 = seg * 2, c1 = seg * 2 + 1;
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    idx.push(i, j, seg + j, i, seg + j, seg + i); // mantle
    idx.push(c0, j, i); // bottom
    idx.push(c1, seg + i, seg + j); // top
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

// Octahedron as point marker.
export function marker(p, r) {
  const pos = [
    p[0] + r, p[1], p[2], p[0] - r, p[1], p[2],
    p[0], p[1] + r, p[2], p[0], p[1] - r, p[2],
    p[0], p[1], p[2] + r, p[0], p[1], p[2] - r,
  ];
  const idx = [0, 2, 4, 2, 1, 4, 1, 3, 4, 3, 0, 4, 2, 0, 5, 1, 2, 5, 3, 1, 5, 0, 3, 5];
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

// Thin square plate (thickness th) centered at c with normal n.
export function plate(c, n, size, th) {
  const [u, v] = basis(n);
  const h = size / 2, pos = [];
  for (const off of [-th / 2, th / 2]) {
    for (const [a, b] of [[-h, -h], [h, -h], [h, h], [-h, h]]) {
      pos.push(c[0] + u[0] * a + v[0] * b + n[0] * off, c[1] + u[1] * a + v[1] * b + n[1] * off, c[2] + u[2] * a + v[2] * b + n[2] * off);
    }
  }
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

// Box from 8 corners (order: like a three.js BoxGeometry is not needed here).
export function boxFromCorners(c) {
  // c: 8 points [x0y0z0, x1y0z0, x1y1z0, x0y1z0, x0y0z1, x1y0z1, x1y1z1, x0y1z1]
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { positions: new Float32Array(c.flat()), indices: new Uint32Array(idx) };
}

// Geometry for a measurement (meters).
export function measurementGeometry(m) {
  switch (m.type) {
    case 'point': return [marker(m.points[0], 0.004)];
    case 'distance': return [marker(m.points[0], 0.004), marker(m.points[1], 0.004), cylinder(m.points[0], m.points[1], 0.001, 8)];
    case 'circle': {
      const h = Math.max(0.05, m.radius * 2);
      const a = m.center.map((x, i) => x - m.normal[i] * h / 2), b = m.center.map((x, i) => x + m.normal[i] * h / 2);
      return [cylinder(a, b, m.radius, 48)];
    }
    case 'plane': return [plate(m.centroid, m.normal, 0.2, 0.001)];
  }
  return [];
}
