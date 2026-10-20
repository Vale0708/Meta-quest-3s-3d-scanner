// Start page: mode selection, saved scans, viewer and export.
import { MODES, modeConfig } from './modes.js';
import { isARSupported, startXR } from './xr/xr-driver.js';
import { loadTip, describeTip } from './xr/tip.js';
import { saveScan, listScans, getScan, deleteScan } from './storage.js';
import { buildParts, exportFile, DEFAULT_OPTIONS } from './export/pipeline.js';
import { Viewer } from './viewer.js';
import { versionText } from './version.js';
import { listCameras, loadDeviceId, saveDeviceId } from './xr/color-camera.js';

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
  return { quality: $('#quality').value, orientation: $('#orientation').value, color: $('#color').checked };
}

// ---- camera test: permission, device selection, live preview
let testStream = null;
async function cameraTest() {
  const info = $('#caminfo');
  if (!navigator.mediaDevices?.getUserMedia) { info.textContent = 'Dieser Browser bietet keinen Kamerazugriff (getUserMedia fehlt).'; return; }
  try {
    testStream?.getTracks().forEach((t) => t.stop());
    const id = $('#camdev').value || loadDeviceId();
    testStream = await navigator.mediaDevices.getUserMedia({ video: id ? { deviceId: { exact: id } } : true, audio: false });
    const v = $('#campreview');
    v.srcObject = testStream;
    v.hidden = false;
    await v.play();
    const cams = await listCameras();
    const track = testStream.getVideoTracks()[0];
    const cur = track.getSettings().deviceId;
    $('#camdev').innerHTML = cams.map((c, i) => `<option value="${c.deviceId}" ${c.deviceId === cur ? 'selected' : ''}>${escapeHtml(c.label || 'Kamera ' + (i + 1))}</option>`).join('');
    $('#camdev').hidden = cams.length < 2;
    saveDeviceId(cur || '');
    const st = track.getSettings();
    info.textContent = `Kamera läuft: ${track.label || 'unbenannt'} (${st.width}×${st.height}). ${cams.length} Kamera(s) gefunden. Siehst du hier die echte Umgebung? Dann klappt die Farbe.`;
    $('#color').checked = true;
    storeColorPref();
  } catch (e) {
    info.textContent = e && e.name === 'NotFoundError'
      ? 'Der Quest-Browser meldet keine Kamera (NotFoundError). Meta gibt die Passthrough-Kameras im Browser bisher nicht frei. Farbe kommt deshalb mit der nativen App. Scannen geht trotzdem, nur ohne Farbe.'
      : `Kein Kamerazugriff: ${e.name || ''} ${e.message || e}. Scannen geht trotzdem, nur ohne Farbe.`;
  }
}

function stopCameraTest() {
  testStream?.getTracks().forEach((t) => t.stop());
  testStream = null;
  $('#campreview').hidden = true;
}

function storeColorPref() {
  try { localStorage.setItem('quest-scanner-color', $('#color').checked ? '1' : '0'); } catch { /* ignore */ }
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
  for (const k of ['scan', 'sceneMesh', 'planes', 'measurements', 'clean', 'align', 'colors']) o[k] = $('#o-' + k).checked;
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
  $('#o-colors').disabled = !current.mesh.colors;
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
  $('#lastdiag').textContent = diag ? `Letzte Sitzung: Features ${diag.features?.join(', ') || '–'} · Tiefe ${diag.depthUsage ?? '–'}/${diag.depthFormat ?? '–'}, ${d.frames ?? 0} Bilder, ${d.size ?? ''}, ${d.decode ?? ''}, near ${d.near ?? '–'} far ${d.far ?? '–'}, Median ${d.median ? d.median.toFixed(2) + ' m' : '–'}, gültig ${d.validRatio != null ? Math.round(d.validRatio * 100) + ' %' : '–'}, Ausrichtung ${diag.orientation ?? '–'}, ${diag.align ? `Posen korrigiert ${diag.align.aligned}, verworfen ${diag.align.rejected}, ` : ''}Farbe ${diag.color ?? '–'}${diag.colorFrames != null ? ` (${diag.colorFrames} Kamerabilder)` : ''}${diag.perf ? `, FPS Ø ${diag.perf.avg}/${diag.perf.target}, min ${diag.perf.min ?? '–'}, ${diag.perf.slowPct} % langsam` : ''}${d.lastError ? ' · Fehler: ' + d.lastError : ''}` : '';
}

async function startScan(id) {
  const s = settings();
  const mode = modeConfig(id, s.quality);
  stopCameraTest();
  try {
    await startXR({
      mode,
      color: s.color,
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
    color: settings().color,
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
  $('#version').textContent = versionText();
  renderModes();
  try { $('#color').checked = localStorage.getItem('quest-scanner-color') === '1'; } catch { /* ignore */ }
  $('#color').addEventListener('change', storeColorPref);
  $('#camdev').addEventListener('change', () => { saveDeviceId($('#camdev').value); cameraTest(); });
  $('#tipinfo').textContent = describeTip(loadTip());
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
    else if (t.id === 'camtest') cameraTest();
    else if (t.id === 'tipreset') {
      try { localStorage.removeItem('quest-scanner-tip'); localStorage.removeItem('quest-scanner-tip-offset'); } catch { /* ignore */ }
      $('#tipinfo').textContent = describeTip(loadTip());
    }
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
