// Scan modes. Values are starting points; the Quest 3S depth map is coarse
// (Depth API ~ 1–2 cm noise at 1 m), so finer voxels mostly help with
// averaging over many frames.

export const MODES = {
  small: {
    id: 'small',
    name: 'Kleine Objekte',
    hint: 'bis ca. 30 cm – Objekt auf Tisch stellen, Box drumherum legen, langsam drumherum gehen',
    voxelSize: 0.004,
    truncation: 0.015,
    minDepth: 0.15,
    maxDepth: 1.0,
    box: { size: [0.3, 0.3, 0.3] },
    minWeight: 3,
    smooth: 4,
    cutBottom: 4,
  },
  medium: {
    id: 'medium',
    name: 'Mittelgroße Objekte',
    hint: 'ca. 30 cm – 2 m: Möbel, Geräte, Fahrrad … Box drumherum legen und umrunden',
    voxelSize: 0.01,
    truncation: 0.035,
    minDepth: 0.2,
    maxDepth: 2.5,
    box: { size: [1.2, 1.2, 1.2] },
    minWeight: 3,
    smooth: 3,
    cutBottom: 10,
  },
  room: {
    id: 'room',
    name: 'Raum',
    hint: 'ganzes Zimmer: langsam alle Wände, Boden und Decke abschauen; nutzt zusätzlich das Raum-Mesh der Quest',
    voxelSize: 0.03,
    truncation: 0.09,
    minDepth: 0.3,
    maxDepth: 4.5,
    box: null,
    minWeight: 3,
    smooth: 2,
  },
};

export const QUALITY = {
  fine: { label: 'Fein', factor: 0.75 },
  normal: { label: 'Normal', factor: 1 },
  coarse: { label: 'Grob (schnell)', factor: 1.5 },
};

export function modeConfig(id, quality = 'normal') {
  const m = MODES[id];
  const f = QUALITY[quality]?.factor ?? 1;
  return { ...m, voxelSize: m.voxelSize * f, truncation: m.truncation * f };
}
