// Scan logic independent of the input source (VR controllers or desktop simulation):
// state, scan box, live preview, measurements, scene capture, saving.
import * as THREE from 'three';
import { FusionClient } from '../fusion/client.js';
import { Panel, makeLabel } from './panel.js';
import { evaluateMeasurement, describeMeasurement, robustPivotCalibration } from '../measure.js';
import { saveModel } from './color-camera.js';
import { versionText } from '../version.js';

// Projects the live camera image onto the preview (to align the color camera).
const PROJ_VS = `
uniform mat4 uCamVP;
varying vec4 vProj;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vProj = uCamVP * w;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const PROJ_FS = `
uniform sampler2D uTex;
varying vec4 vProj;
void main() {
  if (vProj.w <= 0.0) discard;
  vec2 uv = vProj.xy / vProj.w * 0.5 + 0.5;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { gl_FragColor = vec4(0.3, 0.3, 0.3, 0.4); return; }
  gl_FragColor = vec4(texture2D(uTex, uv).rgb, 0.85);
}`;

const TOOLS = ['none', 'point', 'distance', 'circle', 'plane'];
const TOOL_NAMES = { none: 'Aus', point: 'Punkt', distance: 'Abstand', circle: 'Kreis/Ø', plane: 'Ebene', calibrate: 'Kalibrieren' };
const TOOL_HINTS = {
  point: 'Spitze auf den Punkt, Trigger drücken',
  distance: 'Trigger auf Punkt 1, dann auf Punkt 2',
  circle: '3–6 Punkte rund um die Stange, dann „Fertig“',
  plane: '3+ Punkte auf der Fläche verteilt, dann „Fertig“',
};

// Help line while the ray points at a button
const HELP = {
  start: 'Startet/pausiert das Erfassen der Tiefenbilder (auch Taste A)',
  preview: 'Blendet das erfasste Modell über der echten Welt ein/aus',
  box: 'Box neu platzieren: Spitze auf den Tisch, Trigger',
  measure: 'Abstände, Durchmesser und Ebenen mit der Spitze antasten',
  more: 'Vorschau, Farbe, Quest-Raumerfassung, Scan löschen, Abbrechen',
  finish: 'Berechnet das endgültige Modell und öffnet den Export',
  back: 'Zurück zum Hauptmenü',
  't-point': 'Einzelnen Punkt antasten',
  't-distance': 'Abstand zwischen zwei Punkten (live-Anzeige)',
  't-circle': 'Durchmesser + Achse, z. B. Kleiderstange',
  't-plane': 'Ebene + Ebenheit, z. B. Wand oder Tischplatte',
  mdone: 'Schließt Kreis/Ebene mit den bisherigen Punkten ab',
  undo: 'Letzten Punkt bzw. letzte Messung löschen (auch Taste B)',
  calib: 'Lernt, wo genau die Messspitze am Controller sitzt (einmalig)',
  colorcal: 'Kamerabild an der echten Welt ausrichten (für Farbe)',
  room: 'Startet die Raumerfassung der Quest selbst – optional, liefert ein grobes Zusatz-Raster',
  reset: 'Verwirft alles bisher Gescannte (Messungen bleiben)',
  exit: 'Beendet ohne zu speichern',
};

export class ScanApp {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene
   * @param {object} o.mode           mode configuration (modes.js)
   * @param {string} [o.orientation]  depth image orientation ('auto' …)
   * @param {(rec: object) => Promise<void>} o.onSave
   * @param {() => void} o.onExit
   * @param {{roomCapture?: () => Promise<void>}} [o.caps]
   */
  constructor(o) {
    this.scene = o.scene;
    this.mode = o.mode;
    this.onSave = o.onSave;
    this.onExit = o.onExit;
    this.caps = o.caps || {};
    this.colorCam = o.colorCam || null; // ColorCamera or a simulated one
    this.colorCal = false;
    this.phase = this.mode.box ? 'place' : 'ready';
    this.tool = 'none';
    this.page = 'main';  // main | measure | calib | more
    this.calibLive = null; // live result while calibrating
    this.preview = true;
    this.message = '';
    this.points = [];          // points of the current measurement
    this.measurements = [];
    this.calibPoses = [];
    this.tipWorld = new THREE.Vector3();
    this.sceneMeshes = new Map(); // XRMesh → {label, positions, indices}
    this.planes = new Map();
    this.depthOk = false;
    this.lastDepthAt = 0;
    this.frameCount = 0;

    this.fusion = new FusionClient();
    this.fusion.onError = (msg) => { this.message = '!Fusion-Fehler: ' + msg.split('\n')[0]; };
    this.fusion.init({
      voxelSize: this.mode.voxelSize,
      truncation: this.mode.truncation,
      minDepth: this.mode.minDepth,
      maxDepth: this.mode.maxDepth,
      box: null,
      color: !!this.colorCam,
    }, o.orientation || 'auto');

    this.root = new THREE.Group();
    this.scene.add(this.root);

    // live preview of the fused surface
    this.materials = {
      normal: new THREE.MeshNormalMaterial({ transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
      color: new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
      project: new THREE.ShaderMaterial({
        vertexShader: PROJ_VS, fragmentShader: PROJ_FS, transparent: true, side: THREE.DoubleSide,
        uniforms: { uCamVP: { value: new THREE.Matrix4() }, uTex: { value: null } },
      }),
    };
    this.previewMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.materials.normal);
    this.previewMesh.frustumCulled = false;
    this.root.add(this.previewMesh);
    this.previewBusy = false;
    this.previewAt = 0;

    // scan box
    if (this.mode.box) {
      const [sx, sy, sz] = this.mode.box.size;
      this.box = { center: [0, 0, 0], half: [sx / 2, sy / 2, sz / 2], yaw: 0 };
      const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
      this.boxLines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x4cc9f0 }));
      this.root.add(this.boxLines);
    }

    // probe tip
    this.tipMarker = new THREE.Mesh(new THREE.SphereGeometry(0.003, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff3366, depthTest: false }));
    this.tipMarker.renderOrder = 12;
    this.root.add(this.tipMarker);
    this.tipCross = new THREE.AxesHelper(0.015);
    this.tipMarker.add(this.tipCross);

    this.measureGroup = new THREE.Group();
    this.root.add(this.measureGroup);
    this.liveGroup = new THREE.Group();
    this.root.add(this.liveGroup);

    this.panel = new Panel(0.24);
    this.root.add(this.panel.mesh);
  }

  // ---------------------------------------------------------------- frames

  onDepthFrame(f) {
    this.depthOk = true;
    this.lastDepthAt = performance.now();
    if (this.phase !== 'scanning') return;
    if (this.fusion.pushFrame(f)) this.frameCount++;
  }

  update(now) {
    // box visual
    if (this.box) {
      if (this.phase === 'place') {
        this.box.center = [this.tipWorld.x, this.tipWorld.y + this.box.half[1] + 0.002, this.tipWorld.z];
      }
      this.boxLines.position.fromArray(this.box.center);
      this.boxLines.rotation.set(0, this.box.yaw, 0);
      this.boxLines.scale.set(this.box.half[0] * 2, this.box.half[1] * 2, this.box.half[2] * 2);
      this.boxLines.material.color.set(this.phase === 'place' ? 0xffd166 : 0x4cc9f0);
    }
    this.tipMarker.position.copy(this.tipWorld);
    this.tipMarker.visible = this.tool !== 'none' || this.phase === 'place';

    // live preview
    if (this.preview && !this.previewBusy && now - this.previewAt > (this.mode.id === 'room' ? 2500 : 1200) * (this.perf?.previewFactor ?? 1) && this.fusion.stats.blocks > 0 &&
      (this.phase === 'scanning' || this.previewStale)) {
      this.previewBusy = true;
      this.previewStale = false;
      this.fusion.extract(Math.max(1, this.mode.minWeight - 1)).then((m) => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
        g.setIndex(new THREE.BufferAttribute(m.indices, 1));
        if (m.colors) g.setAttribute('color', new THREE.BufferAttribute(m.colors, 3, true));
        g.computeVertexNormals();
        this.previewMesh.geometry.dispose();
        this.previewMesh.geometry = g;
        this.previewHasColor = !!m.colors;
        this.previewTris = m.indices.length / 3;
        this.previewBusy = false;
        this.previewAt = performance.now();
      }).catch(() => { this.previewBusy = false; });
    }
    this.previewMesh.visible = this.preview || this.colorCal;
    this.previewMesh.material = this.colorCal ? this.materials.project : this.previewHasColor ? this.materials.color : this.materials.normal;

    this._updateLive();
    this.panel.set(this.panelContent());
    this.panel.update();
  }

  // ------------------------------------------------------------ actions

  startPause() {
    if (this.phase === 'place') this.confirmBox();
    if (this.phase === 'ready' || this.phase === 'paused') this.phase = 'scanning';
    else if (this.phase === 'scanning') { this.phase = 'paused'; this.previewStale = true; }
  }

  confirmBox() {
    if (!this.box) return;
    this.phase = 'ready';
    this.fusion.setBox({ center: this.box.center.slice(), half: this.box.half.slice(), yaw: this.box.yaw });
  }

  replaceBox() {
    if (!this.box) return;
    this.phase = 'place';
  }

  // Grip: move the box with the controller (offset is kept)
  dragBox(start, current) {
    if (!this.box || this.phase === 'place') return;
    if (start) this._dragOffset = new THREE.Vector3().fromArray(this.box.center).sub(current);
    else if (this._dragOffset) {
      const c = current.clone().add(this._dragOffset);
      this.box.center = [c.x, c.y, c.z];
      this.fusion.setBox({ center: this.box.center.slice(), half: this.box.half.slice(), yaw: this.box.yaw });
    }
  }

  adjustBox(dScale, dYaw, dHeight = 0) {
    if (!this.box) return;
    const f = 1 + dScale;
    const bottom = this.box.center[1] - this.box.half[1];
    this.box.half = this.box.half.map((h) => Math.min(2.5, Math.max(0.03, h * f)));
    if (dHeight) this.box.half[1] = Math.min(2.5, Math.max(0.03, this.box.half[1] * (1 + dHeight)));
    this.box.center[1] = bottom + this.box.half[1]; // keep the box standing on the table
    this.box.yaw += dYaw;
    if (this.phase !== 'place') this.fusion.setBox({ center: this.box.center.slice(), half: this.box.half.slice(), yaw: this.box.yaw });
  }

  // ---- color camera alignment

  toggleColorCal() {
    if (!this.colorCam) return;
    this.colorCal = !this.colorCal;
    if (!this.colorCal) {
      saveModel(this.colorCam.model);
      // colors fused with the old alignment are discarded
      this.fusion.clearColor();
      this.previewStale = true;
      this.message = 'Farbausrichtung gespeichert';
    } else {
      this.previewStale = true;
      if (!this.fusion.stats.blocks) this.message = '!Erst kurz scannen, dann ausrichten';
    }
  }

  // dYaw/dPitch in rad, dFov in degrees
  adjustColorModel(dYaw, dPitch, dFov) {
    const m = this.colorCam.model;
    m.yaw += dYaw;
    m.pitch += dPitch;
    m.hfov = Math.min(120, Math.max(30, m.hfov + dFov));
  }

  // per frame from the driver: view-projection of the color camera + image texture
  setProjector(viewProj, texture) {
    const u = this.materials.project.uniforms;
    u.uCamVP.value.fromArray(viewProj);
    u.uTex.value = texture;
  }

  reset() {
    this.fusion.clear();
    this.previewMesh.geometry.dispose();
    this.previewMesh.geometry = new THREE.BufferGeometry();
    this.previewTris = 0;
    this.frameCount = 0;
    if (this.phase === 'scanning') this.phase = 'paused';
  }

  setTool(t) {
    this.tool = t;
    this.points = [];
    this.calibPoses = [];
    this.message = '';
  }

  // Trigger in the room (not on the panel)
  trigger() {
    if (this.phase === 'place') { this.confirmBox(); return; }
    if (this.tool === 'none' || this.tool === 'calibrate') return;
    this.points.push(this.tipWorld.toArray());
    const m = evaluateMeasurement(this.tool, this.points);
    if (m && m.done) this._commitMeasurement(m);
    this._rebuildMeasureVisuals();
  }

  finishMeasurement() {
    const m = evaluateMeasurement(this.tool, this.points);
    if (m) this._commitMeasurement(m);
    else this.message = '!Zu wenige Punkte für ' + TOOL_NAMES[this.tool];
    this._rebuildMeasureVisuals();
  }

  undo() {
    if (this.points.length) this.points.pop();
    else if (this.measurements.length) this.measurements.pop();
    this._rebuildMeasureVisuals();
  }

  _commitMeasurement(m) {
    const { done, ...rest } = m;
    void done;
    rest.label = describeMeasurement(rest);
    this.measurements.push(rest);
    this.points = [];
    this.message = 'Gespeichert: ' + rest.label;
  }

  // Pivot calibration: collect controller poses while the trigger is held
  calibrationSample(matrix) {
    if (this.tool !== 'calibrate') return;
    this.calibPoses.push({ m: Array.from(matrix.elements) });
    if (this.calibPoses.length % 15 === 0) this.calibLive = robustPivotCalibration(this.calibPoses);
  }

  calibrationEnd() {
    if (this.tool !== 'calibrate' || !this.calibPoses.length) return null;
    const r = robustPivotCalibration(this.calibPoses);
    this.calibPoses = [];
    this.calibLive = null;
    if (!r) { this.message = '!Zu kurz – Trigger länger gedrückt halten'; return null; }
    if (r.coverage < 0.6) { this.message = `!Zu wenig gekippt (${Math.round(r.coverage * 100)} %) – stärker in alle Richtungen kippen`; return null; }
    if (r.rms > 0.003) { this.message = `!Ungenau (±${(r.rms * 1000).toFixed(1)} mm) – Spitze ist verrutscht, nochmal`; return null; }
    this.message = `Spitze kalibriert (±${(r.rms * 1000).toFixed(1)} mm, ${r.used}/${r.total} Messungen)`;
    this.tool = 'none';
    this.page = 'measure';
    return r.tip;
  }

  // ------------------------------------------------------- scene (room)

  captureScene(frame, refSpace) {
    if (frame.detectedMeshes) {
      for (const mesh of frame.detectedMeshes) {
        const pose = frame.getPose(mesh.meshSpace, refSpace);
        if (!pose) continue;
        const prev = this.sceneMeshes.get(mesh);
        if (prev && prev.changed === mesh.lastChangedTime) continue;
        const m = pose.transform.matrix, v = mesh.vertices;
        const pos = new Float32Array(v.length);
        for (let i = 0; i < v.length; i += 3) {
          pos[i] = m[0] * v[i] + m[4] * v[i + 1] + m[8] * v[i + 2] + m[12];
          pos[i + 1] = m[1] * v[i] + m[5] * v[i + 1] + m[9] * v[i + 2] + m[13];
          pos[i + 2] = m[2] * v[i] + m[6] * v[i + 1] + m[10] * v[i + 2] + m[14];
        }
        this.sceneMeshes.set(mesh, { label: mesh.semanticLabel || 'mesh', positions: pos, indices: new Uint32Array(mesh.indices), changed: mesh.lastChangedTime });
      }
    }
    if (frame.detectedPlanes) {
      for (const plane of frame.detectedPlanes) {
        const pose = frame.getPose(plane.planeSpace, refSpace);
        if (!pose) continue;
        const m = pose.transform.matrix;
        const poly = plane.polygon.map((p) => [
          m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12],
          m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13],
          m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14],
        ]);
        this.planes.set(plane, { label: plane.semanticLabel || plane.orientation || 'plane', orientation: plane.orientation, polygon: poly });
      }
    }
  }

  // ------------------------------------------------------------- save

  async finish() {
    this.phase = 'saving';
    this.message = 'Berechne endgültiges Netz …';
    this.panel.set(this.panelContent());
    this.panel.update();
    const mesh = await this.fusion.extract(this.mode.minWeight, true);
    const rec = {
      name: `${this.mode.name} ${new Date().toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}`,
      mode: this.mode.id,
      created: Date.now(),
      voxelSize: this.mode.voxelSize,
      mesh: mesh.colors ? { positions: mesh.positions, indices: mesh.indices, colors: mesh.colors } : { positions: mesh.positions, indices: mesh.indices },
      sceneMeshes: [...this.sceneMeshes.values()].map(({ label, positions, indices }) => ({ label, positions, indices })),
      planes: [...this.planes.values()],
      measurements: this.measurements,
      box: this.box ? { center: this.box.center, half: this.box.half, yaw: this.box.yaw } : null,
      origin: this.box ? [this.box.center[0], this.box.center[1] - this.box.half[1], this.box.center[2]] : [0, 0, 0],
      yaw: this.box ? this.box.yaw : null,
      stats: { ...this.fusion.stats, depthFrames: this.frameCount, orientation: this.fusion.orientation },
    };
    await this.onSave(rec);
    this.message = 'Gespeichert!';
    return rec;
  }

  dispose() {
    this.fusion.dispose();
    this.scene.remove(this.root);
  }

  // ---------------------------------------------------------------- UI

  onButton(id) {
    if (id.startsWith('t-')) { this.setTool(id.slice(2)); return; }
    switch (id) {
      case 'start': this.startPause(); break;
      case 'preview': this.preview = !this.preview; break;
      case 'box': this.phase === 'place' ? this.confirmBox() : this.replaceBox(); break;
      case 'measure': this.page = 'measure'; if (this.tool === 'none') this.setTool('distance'); break;
      case 'more': this.page = 'more'; break;
      case 'back': this.page = 'main'; if (this.tool === 'calibrate') this.setTool('none'); break;
      case 'mdone': this.finishMeasurement(); break;
      case 'undo': this.undo(); break;
      case 'colorcal': this.toggleColorCal(); break;
      case 'calib': this.page = 'calib'; this.setTool('calibrate'); break;
      case 'calibback': this.setTool('none'); this.page = 'measure'; break;
      case 'room': this.caps.roomCapture?.().catch((e) => { this.message = '!' + e.message; }); break;
      case 'reset': this.reset(); this.page = 'main'; break;
      case 'finish': this.finish().then(() => this.onExit()); break;
      case 'exit': this.onExit(); break;
    }
  }

  // Y on the left controller: next measuring tool (opens the measure page)
  cycleTool() {
    const i = TOOLS.indexOf(this.tool);
    this.setTool(TOOLS[(i + 1) % TOOLS.length]);
    this.page = this.tool === 'none' ? 'main' : 'measure';
  }

  // What to do next (step guidance at the top of the panel)
  _step() {
    const box = !!this.box;
    if (this.phase === 'saving') return 'Speichere … bitte warten';
    if (this.phase === 'place') return 'Schritt 1/3: Rote Spitze auf die Tischplatte neben das Objekt halten, Trigger drücken';
    if (this.phase === 'ready') return `Schritt ${box ? 2 : 1}/${box ? 3 : 2}: A drücken (oder ▶ Scannen) und langsam umhergehen`;
    if (this.phase === 'paused') return 'Pausiert – A zum Weiterscannen, oder ✔ Fertig';
    if (this.fusion.stats.blocks === 0) return 'Scannt … Kopf langsam bewegen';
    return box ? 'Schritt 2/3: Langsam ums Objekt gehen, auch von oben – dann ✔ Fertig'
      : 'Schritt 1/2: Langsam Wände, Boden, Decke abschauen – dann ✔ Fertig';
  }

  _statusLines() {
    const st = this.fusion.stats;
    const lines = [];
    const fps = this.perf ? ` · ${Math.round(this.perf.fps)}/${this.perf.target} FPS` : '';
    lines.push(`${this.frameCount} Tiefenbilder · ${st.blocks} Blöcke${fps}`);
    if (this.perf?.level) lines.push(`!Gedrosselt (Stufe ${this.perf.level}) – langsamer bewegen`);
    if (!this.depthOk || performance.now() - this.lastDepthAt > 2000) lines.push('!Keine Tiefendaten (Depth API) – nur Messen/Quest-Raum möglich');
    else if (this.fusion.calibrating && this.phase === 'scanning') lines.push('!Richte Tiefenbild aus: Kopf hoch/runter + links/rechts');
    return lines;
  }

  panelContent() {
    const st = this.fusion.stats;
    const hover = this.panel?.hover;
    const lines = [];
    const b = [];
    const scanning = this.phase === 'scanning';
    const busy = this.phase === 'saving';
    let title = this.mode.name;

    if (this.page === 'measure') {
      title = 'Messen';
      lines.push(this.tool !== 'none' && TOOL_HINTS[this.tool] ? `${TOOL_NAMES[this.tool]}: ${TOOL_HINTS[this.tool]}` : 'Werkzeug wählen');
      lines.push(`Punkte: ${this.points.length} · Messungen: ${this.measurements.length}`);
      for (const t of ['point', 'distance', 'circle', 'plane']) b.push({ id: 't-' + t, label: TOOL_NAMES[t], active: this.tool === t });
      b.push({ id: 'mdone', label: 'Fertig (Kreis/Ebene)', disabled: !(this.tool === 'circle' || this.tool === 'plane') || this.points.length < 3 });
      b.push({ id: 'undo', label: 'Rückgängig (B)' });
      b.push({ id: 'calib', label: 'Spitze kalibrieren', wide: true });
      b.push({ id: 'back', label: '← Zurück', wide: true });
    } else if (this.page === 'calib') {
      title = 'Spitze kalibrieren';
      lines.push('1. Spitze in eine kleine Mulde/Ecke drücken (darf nicht rutschen)');
      lines.push('2. Trigger GEDRÜCKT halten und Controller in alle Richtungen kippen');
      lines.push('3. Loslassen, wenn der Balken voll ist');
      const r = this.calibLive;
      const n = this.calibPoses.length;
      if (n) {
        const cov = r ? r.coverage : 0;
        const bar = '█'.repeat(Math.round(cov * 10)) + '░'.repeat(10 - Math.round(cov * 10));
        lines.push(`Kippen ${bar} ${Math.round(cov * 100)} %`);
        if (r) lines.push(`${r.rms <= 0.003 ? '' : '!'}Genauigkeit ±${(r.rms * 1000).toFixed(1)} mm (${r.used}/${r.total} Messungen)`);
      }
      b.push({ id: 'calibback', label: '← Abbrechen', wide: true });
    } else if (this.page === 'more') {
      title = 'Mehr';
      lines.push(...this._statusLines());
      if (this.diagLines) lines.push(...this.diagLines());
      lines.push('Version: ' + versionText());
      if (this.mode.id === 'room') lines.push(`Quest-Raum: ${this.sceneMeshes.size} Meshes, ${this.planes.size} Flächen`);
      b.push({ id: 'preview', label: this.preview ? 'Vorschau: an' : 'Vorschau: aus', active: this.preview });
      if (this.colorCam) b.push({ id: 'colorcal', label: this.colorCal ? 'Ausrichten fertig' : 'Farbe ausrichten', active: this.colorCal });
      if (this.caps.roomCapture && this.mode.id === 'room') b.push({ id: 'room', label: 'Quest-Raumerfassung (optional)', wide: true });
      b.push({ id: 'reset', label: 'Scan löschen', danger: true });
      b.push({ id: 'exit', label: 'Abbrechen', danger: true });
      b.push({ id: 'back', label: '← Zurück', wide: true });
    } else {
      lines.push(this._step());
      lines.push(...this._statusLines());
      if (this.colorCam) {
        const cm = this.colorCam.model;
        if (this.colorCal) lines.push(`Farbe ausrichten: rechter Stick = drehen/kippen, linker = FOV (${cm.hfov.toFixed(1)}°)`);
        else if (!this.colorCam.frames && this.colorCam.grabs > 5) lines.push('!Kamera liefert keine Bilder');
      }
      if (this.phase === 'place') b.push({ id: 'box', label: 'Box hier absetzen', active: true, wide: true });
      else {
        b.push({ id: 'start', label: scanning ? '⏸ Pause (A)' : '▶ Scannen (A)', active: scanning, disabled: busy });
        if (this.box) b.push({ id: 'box', label: 'Box neu setzen', disabled: scanning || busy });
      }
      b.push({ id: 'measure', label: 'Messen …' });
      b.push({ id: 'more', label: 'Mehr …' });
      b.push({ id: 'finish', label: '✔ Fertig & Speichern', wide: true, disabled: busy || (st.blocks === 0 && !this.measurements.length && !this.sceneMeshes.size) });
    }
    if (this.message && this.page !== 'calib') lines.push(this.message);
    else if (this.message && this.page === 'calib' && !this.calibPoses.length) lines.push(this.message);
    if (hover && HELP[hover]) lines.push('ⓘ ' + HELP[hover]);
    return { title, lines, buttons: b };
  }

  // ------------------------------------------------------- visuals

  _rebuildMeasureVisuals() {
    const g = this.measureGroup;
    for (const c of [...g.children]) { g.remove(c); c.traverse?.((o) => { o.geometry?.dispose(); o.material?.map?.dispose(); o.material?.dispose(); }); }
    const dot = (p, color = 0xffd166) => {
      const s = new THREE.Mesh(new THREE.SphereGeometry(0.003, 12, 8), new THREE.MeshBasicMaterial({ color, depthTest: false }));
      s.position.fromArray(p);
      s.renderOrder = 12;
      g.add(s);
    };
    const line = (a, b, color = 0xffd166) => {
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3().fromArray(a), new THREE.Vector3().fromArray(b)]), new THREE.LineBasicMaterial({ color, depthTest: false }));
      l.renderOrder = 12;
      g.add(l);
    };
    for (const m of this.measurements) {
      m.points.forEach((p) => dot(p));
      let at = m.points[0];
      if (m.type === 'distance') { line(m.points[0], m.points[1]); at = [0, 1, 2].map((i) => (m.points[0][i] + m.points[1][i]) / 2); }
      if (m.type === 'circle') {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(m.radius, 0.0008, 6, 64), new THREE.MeshBasicMaterial({ color: 0x80ffdb, depthTest: false }));
        ring.position.fromArray(m.center);
        ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3().fromArray(m.normal));
        g.add(ring);
        at = m.center;
      }
      if (m.type === 'plane') {
        const q = new THREE.Mesh(new THREE.PlaneGeometry(0.15, 0.15), new THREE.MeshBasicMaterial({ color: 0x80ffdb, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthTest: false }));
        q.position.fromArray(m.centroid);
        q.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3().fromArray(m.normal));
        g.add(q);
        at = m.centroid;
      }
      const lab = makeLabel(m.label);
      lab.position.fromArray(at).add(new THREE.Vector3(0, 0.03, 0));
      g.add(lab);
    }
    this.points.forEach((p) => dot(p, 0xff3366));
  }

  _updateLive() {
    const active = this.tool === 'distance' && this.points.length === 1;
    if (!this._liveLine) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      this._liveLine = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xff3366, depthTest: false }));
      this._liveLine.renderOrder = 12;
      this._liveLine.frustumCulled = false;
      this.liveGroup.add(this._liveLine);
    }
    this._liveLine.visible = active;
    if (this._liveLabel) this._liveLabel.visible = active;
    if (!active) return;
    const a = this.points[0], t = this.tipWorld;
    const pos = this._liveLine.geometry.attributes.position;
    pos.setXYZ(0, a[0], a[1], a[2]);
    pos.setXYZ(1, t.x, t.y, t.z);
    pos.needsUpdate = true;
    const mm = Math.round(t.distanceTo(new THREE.Vector3().fromArray(a)) * 1000);
    if (mm !== this._liveKey) {
      this._liveKey = mm;
      if (this._liveLabel) { this.liveGroup.remove(this._liveLabel); this._liveLabel.material.map.dispose(); this._liveLabel.material.dispose(); }
      this._liveLabel = makeLabel(`${mm} mm`, 0.02);
      this.liveGroup.add(this._liveLabel);
    }
    this._liveLabel.position.copy(t).add(new THREE.Vector3(0, 0.025, 0));
  }
}
