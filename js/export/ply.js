// Binary PLY with vertex colors (MeshLab, Blender, CloudCompare, …).

export function toPLY(mesh, comment = 'Quest 3S Scanner, Einheit mm, Z oben') {
  const p = mesh.positions, idx = mesh.indices, col = mesh.colors;
  const nv = p.length / 3, nf = idx.length / 3;
  const header = [
    'ply', 'format binary_little_endian 1.0', `comment ${comment}`,
    `element vertex ${nv}`, 'property float x', 'property float y', 'property float z',
    ...(col ? ['property uchar red', 'property uchar green', 'property uchar blue'] : []),
    `element face ${nf}`, 'property list uchar int vertex_indices', 'end_header', '',
  ].join('\n');
  const hb = new TextEncoder().encode(header);
  const vsz = 12 + (col ? 3 : 0);
  const buf = new ArrayBuffer(hb.length + nv * vsz + nf * 13);
  new Uint8Array(buf).set(hb);
  const dv = new DataView(buf);
  let o = hb.length;
  for (let v = 0; v < nv; v++) {
    dv.setFloat32(o, p[v * 3], true); dv.setFloat32(o + 4, p[v * 3 + 1], true); dv.setFloat32(o + 8, p[v * 3 + 2], true);
    o += 12;
    if (col) { dv.setUint8(o, col[v * 3]); dv.setUint8(o + 1, col[v * 3 + 1]); dv.setUint8(o + 2, col[v * 3 + 2]); o += 3; }
  }
  for (let f = 0; f < nf; f++) {
    dv.setUint8(o, 3);
    dv.setInt32(o + 1, idx[f * 3], true); dv.setInt32(o + 5, idx[f * 3 + 1], true); dv.setInt32(o + 9, idx[f * 3 + 2], true);
    o += 13;
  }
  return buf;
}
