// STEP AP214 (ISO 10303-21) with faceted surfaces: every triangle becomes a
// planar FACE_SURFACE bounded by a POLY_LOOP. Every part becomes an
// OPEN_SHELL of a SHELL_BASED_SURFACE_MODEL. CAD programs (FreeCAD, Fusion,
// SolidWorks, Inventor, …) import this as surfaces / a surface body.
// Units: millimeters.

function num(v) {
  if (!Number.isFinite(v)) v = 0;
  const s = v.toFixed(4);
  return s === '-0.0000' ? '0.' : s.replace(/0+$/, '').replace(/\.$/, '.');
}

function esc(s) {
  return String(s).replace(/'/g, "''").replace(/[^\x20-\x7e]/g, '_');
}

/**
 * @param {{name: string, mesh: {positions: Float32Array, indices: Uint32Array}}[]} parts
 * @param {{name?: string, author?: string}} [o]
 * @returns {string}
 */
export function toSTEP(parts, o = {}) {
  const name = esc(o.name || 'Scan');
  const out = [];
  let id = 0;
  const e = (s) => { id++; out.push(`#${id}=${s};`); return id; };

  const ctx = e("APPLICATION_CONTEXT('automotive design')");
  e(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${ctx})`);
  const pctx = e(`PRODUCT_CONTEXT('',#${ctx},'mechanical')`);
  const prod = e(`PRODUCT('${name}','${name}','',(#${pctx}))`);
  e(`PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(#${prod}))`);
  const pdf = e(`PRODUCT_DEFINITION_FORMATION('','',#${prod})`);
  const pdc = e(`PRODUCT_DEFINITION_CONTEXT('part definition',#${ctx},'design')`);
  const pd = e(`PRODUCT_DEFINITION('design','',#${pdf},#${pdc})`);
  const pds = e(`PRODUCT_DEFINITION_SHAPE('','',#${pd})`);
  const lu = e('(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))');
  const au = e('(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))');
  const su = e('(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())');
  const unc = e(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-03),#${lu},'distance_accuracy_value','confusion accuracy')`);
  const grc = e(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${unc}))GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lu},#${au},#${su}))REPRESENTATION_CONTEXT('Context3D','3D Context with 0.001 mm uncertainty'))`);
  const o0 = e("CARTESIAN_POINT('',(0.,0.,0.))");
  const dz = e("DIRECTION('',(0.,0.,1.))");
  const dx = e("DIRECTION('',(1.,0.,0.))");
  const ax0 = e(`AXIS2_PLACEMENT_3D('',#${o0},#${dz},#${dx})`);

  const shells = [];
  for (const part of parts) {
    const p = part.mesh.positions, idx = part.mesh.indices;
    const nv = p.length / 3;
    const pt = new Int32Array(nv).fill(0);
    const faces = [];
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
      const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const nl = Math.hypot(nx, ny, nz);
      const ul = Math.hypot(ux, uy, uz);
      if (nl < 1e-9 || ul < 1e-9) continue; // degenerate
      nx /= nl; ny /= nl; nz /= nl;
      for (const v of [a, b, c]) {
        if (!pt[v]) pt[v] = e(`CARTESIAN_POINT('',(${num(p[v * 3])},${num(p[v * 3 + 1])},${num(p[v * 3 + 2])}))`);
      }
      const loop = e(`POLY_LOOP('',(#${pt[a]},#${pt[b]},#${pt[c]}))`);
      const bound = e(`FACE_OUTER_BOUND('',#${loop},.T.)`);
      const dn = e(`DIRECTION('',(${num(nx)},${num(ny)},${num(nz)}))`);
      // reference direction: first edge, exactly orthogonal to the normal
      const dr = e(`DIRECTION('',(${(ux / ul).toFixed(6)},${(uy / ul).toFixed(6)},${(uz / ul).toFixed(6)}))`);
      const ax = e(`AXIS2_PLACEMENT_3D('',#${pt[a]},#${dn},#${dr})`);
      const pl = e(`PLANE('',#${ax})`);
      faces.push(e(`FACE_SURFACE('',(#${bound}),#${pl},.T.)`));
    }
    if (faces.length) shells.push(e(`OPEN_SHELL('${esc(part.name)}',(${faces.map((f) => '#' + f).join(',')}))`));
  }
  const sbsm = e(`SHELL_BASED_SURFACE_MODEL('',(${shells.map((s) => '#' + s).join(',')}))`);
  const rep = e(`MANIFOLD_SURFACE_SHAPE_REPRESENTATION('${name}',(#${ax0},#${sbsm}),#${grc})`);
  e(`SHAPE_DEFINITION_REPRESENTATION(#${pds},#${rep})`);

  const now = new Date().toISOString().slice(0, 19);
  const header = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('Quest 3S Scanner - facettiertes Scan-Netz'),'2;1');",
    `FILE_NAME('${name}.step','${now}',('${esc(o.author || '')}'),(''),'Quest 3S Scanner','Quest 3S Scanner','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    'ENDSEC;',
    'DATA;',
  ];
  return header.join('\n') + '\n' + out.join('\n') + '\nENDSEC;\nEND-ISO-10303-21;\n';
}
