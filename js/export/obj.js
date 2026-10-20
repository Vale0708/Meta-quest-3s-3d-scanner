// Wavefront OBJ, several named objects in one file.

export function toOBJ(parts) {
  const lines = ['# Quest 3S Scanner', '# Einheit: mm, Z nach oben'];
  let base = 1;
  for (const { name, mesh } of parts) {
    lines.push(`o ${name.replace(/\s+/g, '_')}`);
    const p = mesh.positions, idx = mesh.indices;
    // vertex colors as "v x y z r g b" (0…1), read by Blender, MeshLab and others
    const c = mesh.colors;
    for (let i = 0; i < p.length; i += 3) {
      const rgb = c ? ` ${(c[i] / 255).toFixed(3)} ${(c[i + 1] / 255).toFixed(3)} ${(c[i + 2] / 255).toFixed(3)}` : '';
      lines.push(`v ${p[i].toFixed(3)} ${p[i + 1].toFixed(3)} ${p[i + 2].toFixed(3)}${rgb}`);
    }
    for (let i = 0; i < idx.length; i += 3) lines.push(`f ${idx[i] + base} ${idx[i + 1] + base} ${idx[i + 2] + base}`);
    base += p.length / 3;
  }
  return lines.join('\n') + '\n';
}
