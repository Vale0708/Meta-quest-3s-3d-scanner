// Start page: mode selection, saved scans, viewer and export.
import { MODES, modeConfig } from './modes.js';
import { isARSupported, startXR, loadTipOffset } from './xr/xr-driver.js';
import { saveScan, listScans, getScan, deleteScan } from './storage.js';
import { buildParts, exportFile, DEFAULT_OPTIONS } from './export/pipeline.js';
import { Viewer } from './viewer.js';

const $ = (s) => document.querySelector(s);
let viewer = null;
let current = null;
let arOk = false;

function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.hidden = true; }, ms);
}

function settings() {
  return { quality: $('#quality').value, orientation: $('#orientation').value };
}

function renderModes() {
  $('#modes').innerHTML = Object.values(MODES).map((m) => `
    <div class="mode">
      <h3>${m.name}</h3>
      <p>${m.hint}</p>
      <div class="meta">Voxel ${(m.voxelSize * 1000).toFixed(0)} mm · Reichweite ${m.maxDepth} m</div>
      <div class="row">
        <button class="primary" data-start="${m.id}" ${arOk ? '' : 'disabled'}>In VR starten</button>
        <button data-sim="${m.id}" title="Ohne Brille am PC testen">Simulation</button>
      </div>
    </div>`).join('');
}

async function refreshList() {
  const list = await listScans();
  $('#list').innerHTML = list.length ? list.map((s) => `
    <div class="item">
      <div class="info"><b>${escapeHtml(s.name)}</b>
        <span>${MODES[s.mode]?.name ?? s.mode} · ${s.tris.toLocaleString('de-DE')} Dreiecke · ${s.measurements} Messungen${s.sceneMeshes ? ' · Raum-Mesh' : ''}</span></div>
      <button class="primary small" data-open="${s.id}">Öffnen / Export</button>
      <button class="danger small" data-del="${s.id}">Löschen</button>
    </div>`).join('') : '<p class="hint">Noch keine Scans gespeichert.</p>';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function exportOptions() {
  const o = { ...DEFAULT_OPTIONS };
  for (const k of ['scan', 'sceneMesh', 'planes', 'measurements', 'clean', 'align']) o[k] = $('#o-' + k).checked;
  o.smooth = +$('#o-smooth').value;
  o.stepMaxTris = Math.max(500, +$('#o-stepMaxTris').value || 30000);
  o.cutBottom = Math.max(0, +$('#o-cutBottom').value || 0);
  return o;
}

let showTimer = 0;
function updateViewer(fit = false) {
  clearTimeout(showTimer);
  showTimer = setTimeout(() => {
    if (!current) return;
    const { parts } = buildParts(current, exportOptions());
    viewer.show(parts, fit, current.mode === 'room');
    const tris = parts.reduce((s, p) => s + p.mesh.indices.length / 3, 0);
    $('#exportinfo').textContent = `${parts.map((p) => p.name).join(', ') || 'nichts ausgewählt'} – ${tris.toLocaleString('de-DE')} Dreiecke`;
  }, fit ? 0 : 150);
}

async function openScan(id) {
  current = await getScan(id);
  if (!current) return;
  $('#detail').hidden = false;
  $('#scanname').value = current.name;
  const mode = MODES[current.mode];
  $('#o-smooth').value = mode?.smooth ?? 3;
  $('#o-smooth-v').textContent = $('#o-smooth').value;
  $('#o-sceneMesh').checked = current.sceneMeshes.length > 0;
  $('#o-sceneMesh').disabled = !current.sceneMeshes.length;
  $('#o-planes').disabled = !current.planes.length;
  $('#o-align').disabled = current.yaw != null;
  $('#o-cutBottom').value = current.box ? (mode?.cutBottom ?? 0) : 0;
  $('#o-cutBottom').disabled = !current.box;
  if (!viewer) viewer = new Viewer($('#viewer'));
  updateViewer(true);
  renderMeasurements();
  $('#detail').scrollIntoView({ behavior: 'smooth' });
}

function renderMeasurements() {
  const ms = current.measurements;
  if (!ms.length) { $('#measurements').innerHTML = ''; return; }
  $('#measurements').innerHTML = `<h3>Messungen</h3><table><tr><th>#</th><th>Typ</th><th>Ergebnis</th></tr>${ms.map((m, i) => `<tr><td>${i + 1}</td><td>${m.type}</td><td>${escapeHtml(m.label)}</td></tr>`).join('')}</table>`;
}

function download(name, data, type) {
  const blob = new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

async function doExport(fmt) {
  if (!current) return;
  toast('Exportiere …');
  await new Promise((r) => setTimeout(r, 30));
  try {
    const f = exportFile(current, fmt, exportOptions());
    download(f.name, f.data, f.type);
    toast(`${f.name} gespeichert${f.tris ? ` (${f.tris.toLocaleString('de-DE')} Dreiecke)` : ''}`);
  } catch (e) {
    toast('Export fehlgeschlagen: ' + e.message, 6000);
  }
}

async function onSave(rec) {
  const id = await saveScan(rec);
  rec.id = id;
  localStorage.setItem('quest-scanner-last', String(id));
}

function showDiag(diag) {
  const d = diag?.depth || {};
  $('#lastdiag').textContent = diag ? `Letzte Sitzung: Features ${diag.features?.join(', ') || '–'} · Tiefe ${diag.depthUsage ?? '–'}/${diag.depthFormat ?? '–'}, ${d.frames ?? 0} Bilder, ${d.size ?? ''}, ${d.decode ?? ''}, near ${d.near ?? '–'} far ${d.far ?? '–'}, Median ${d.median ? d.median.toFixed(2) + ' m' : '–'}, gültig ${d.validRatio != null ? Math.round(d.validRatio * 100) + ' %' : '–'}, Ausrichtung ${diag.orientation ?? '–'}${d.lastError ? ' · Fehler: ' + d.lastError : ''}` : '';
}

async function startScan(id) {
  const s = settings();
  const mode = modeConfig(id, s.quality);
  try {
    await startXR({
      mode,
      orientation: s.orientation,
      onSave,
      onEnd: async ({ saved, diag }) => {
        showDiag(diag);
        try { localStorage.setItem('quest-scanner-diag', JSON.stringify(diag)); } catch { /* ignore */ }
        await refreshList();
        if (saved) openScan(+localStorage.getItem('quest-scanner-last'));
      },
    });
  } catch (e) {
    toast('VR-Start fehlgeschlagen: ' + e.message, 8000);
  }
}

async function startSimulation(id) {
  const { startSim } = await import('./sim/sim-driver.js');
  const stage = $('#simstage');
  stage.hidden = false;
  const mode = modeConfig(id, settings().quality);
  window.__sim = startSim({
    container: stage,
    mode,
    onSave,
    onEnd: async () => {
      stage.hidden = true;
      window.__sim = null;
      await refreshList();
      const last = +localStorage.getItem('quest-scanner-last');
      if (last) openScan(last);
    },
  });
}

async function init() {
  arOk = await isARSupported();
  const sup = $('#support');
  if (arOk) {
    sup.className = 'support ok';
    sup.textContent = 'Mixed Reality (WebXR immersive-ar) ist verfügbar. Du kannst direkt scannen.';
  } else {
    sup.className = 'support no';
    sup.innerHTML = window.isSecureContext
      ? 'Kein WebXR-AR auf diesem Gerät. Öffne die Seite im <b>Browser der Quest</b>. Am PC kannst du die Scans exportieren und die Simulation testen.'
      : 'Die Seite muss über <b>https://</b> geladen werden, sonst ist WebXR gesperrt (siehe README).';
  }
  renderModes();
  const tip = loadTipOffset();
  $('#tipinfo').textContent = tip.some((v) => v) ? `kalibriert (${tip.map((v) => (v * 1000).toFixed(1)).join(' / ')} mm)` : 'nicht kalibriert (Standard: Strahl-Ursprung)';
  try { showDiag(JSON.parse(localStorage.getItem('quest-scanner-diag'))); } catch { /* ignore */ }
  await refreshList();

  document.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.start) startScan(t.dataset.start);
    else if (t.dataset.sim) startSimulation(t.dataset.sim);
    else if (t.dataset.open) openScan(+t.dataset.open);
    else if (t.dataset.del) {
      if (!confirm('Scan wirklich löschen?')) return;
      await deleteScan(+t.dataset.del);
      if (current?.id === +t.dataset.del) { current = null; $('#detail').hidden = true; }
      refreshList();
    } else if (t.dataset.fmt) doExport(t.dataset.fmt);
    else if (t.id === 'close') { current = null; $('#detail').hidden = true; }
    else if (t.id === 'tipreset') { localStorage.removeItem('quest-scanner-tip-offset'); $('#tipinfo').textContent = 'zurückgesetzt'; }
  });
  $('#detail').addEventListener('input', (e) => {
    if (e.target.id === 'o-smooth') $('#o-smooth-v').textContent = e.target.value;
    if (e.target.id.startsWith('o-') && e.target.id !== 'o-stepMaxTris') updateViewer(false);
  });
  $('#scanname').addEventListener('change', async () => {
    if (!current) return;
    current.name = $('#scanname').value.trim() || current.name;
    await saveScan(current);
    refreshList();
  });
}

init();
