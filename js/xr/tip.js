// Measuring tip settings. Default: a virtual tip floating in front of the controller
// (along the pointing ray). Optionally a physical tip found by pivot calibration.
// Offsets are in the controller's target-ray space (meters, -Z = pointing direction).

const KEY = 'quest-scanner-tip';
export const TIP_MIN = 0.02, TIP_MAX = 0.25, TIP_DEFAULT = 0.07;

const clampDist = (d) => Math.min(TIP_MAX, Math.max(TIP_MIN, Math.round(d * 100) / 100));

/** @returns {{mode: 'float'|'calibrated', dist: number, calib: number[]|null}} */
export function loadTip() {
  const t = { mode: 'float', dist: TIP_DEFAULT, calib: null };
  try {
    const v = JSON.parse(localStorage.getItem(KEY));
    if (v && Number.isFinite(v.dist)) t.dist = clampDist(v.dist);
    if (v && Array.isArray(v.calib) && v.calib.length === 3) t.calib = v.calib;
    if (v && v.mode === 'calibrated' && t.calib) t.mode = 'calibrated';
  } catch { /* storage unavailable */ }
  return t;
}

export function saveTip(t) {
  try { localStorage.setItem(KEY, JSON.stringify(t)); } catch { /* ignore */ }
}

/** Offset of the tip in target-ray space. */
export function tipOffset(t) {
  return t.mode === 'calibrated' && t.calib ? t.calib : [0, 0, -t.dist];
}

/** Changes the floating distance (switches back to the floating tip). */
export function nudgeTip(t, delta) {
  return { ...t, mode: 'float', dist: clampDist(t.dist + delta) };
}

export function describeTip(t) {
  if (t.mode === 'calibrated') return `physisch kalibriert (${t.calib.map((v) => (v * 1000).toFixed(1)).join(' / ')} mm)`;
  return `schwebend, ${Math.round(t.dist * 100)} cm vor dem Controller`;
}
