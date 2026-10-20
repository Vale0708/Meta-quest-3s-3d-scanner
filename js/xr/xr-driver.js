// WebXR session on the Quest: passthrough (immersive-ar), depth, controllers, room mesh.
import * as THREE from 'three';
import { ScanApp } from './scan-app.js';
import { DepthReader } from './depth-reader.js';
import { PerfGovernor } from './perf.js';
import { tipOffset } from './tip.js';
import { ColorCamera, PoseHistory, cameraPose, projFromModel, mul4 } from './color-camera.js';

export async function isARSupported() {
  try { return !!navigator.xr && await navigator.xr.isSessionSupported('immersive-ar'); } catch { return false; }
}

/**
 * Starts a scan session.
 * @param {object} o
 * @param {object} o.mode
 * @param {string} o.orientation
 * @param {boolean} [o.color]  capture colors with the camera (getUserMedia)
 * @param {(rec) => Promise<void>} o.onSave
 * @param {(info: {saved: boolean, diag: object}) => void} o.onEnd
 */
export async function startXR(o) {
  const sessionInit = {
    requiredFeatures: ['local-floor'],
    optionalFeatures: ['depth-sensing', 'mesh-detection', 'plane-detection', 'hand-tracking'],
    depthSensing: {
      usagePreference: ['gpu-optimized', 'cpu-optimized'],
      // the Quest Browser only offers 'unsigned-short' – without it the depth is not enabled at all
      dataFormatPreference: ['unsigned-short', 'float32', 'luminance-alpha'],
    },
  };
  const session = await navigator.xr.requestSession('immersive-ar', sessionInit);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(1);
  renderer.xr.enabled = true;
  // foveated rendering: less detail at the edges of the view saves GPU time on the Quest
  renderer.xr.setFoveation(1);
  renderer.xr.setReferenceSpaceType('local-floor');
  renderer.domElement.style.display = 'none';
  document.body.appendChild(renderer.domElement);
  // We use the depth for scanning, not for occlusion (it would hide the preview on real surfaces).
  renderer.xr.getDepthSensingMesh = () => null;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 1, 0.01, 50);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2));

  // color camera (only if the browser hands out the passthrough cameras)
  let colorCam = null, colorError = '';
  if (o.color) {
    try { colorCam = await new ColorCamera().start(); } catch (e) { colorError = e.message || String(e); colorCam = null; }
  }
  const poses = new PoseHistory();
  const videoTex = colorCam ? new THREE.VideoTexture(colorCam.video) : null;

  let saved = false;
  // Not every browser reports enabledFeatures – then simply try the depth.
  const featuresKnown = !!session.enabledFeatures;
  const features = session.enabledFeatures ? [...session.enabledFeatures] : [];
  let tryDepth = featuresKnown ? features.includes('depth-sensing') : true;
  const diag = { features: featuresKnown ? features : ['(unbekannt)'], depthUsage: null, depthFormat: null, color: colorCam ? colorCam.label || 'ja' : (o.color ? 'Fehler: ' + colorError : 'aus') };

  const app = new ScanApp({
    scene,
    mode: o.mode,
    orientation: o.orientation,
    onSave: async (rec) => { rec.stats.depth = { ...depthReader.info }; await o.onSave(rec); saved = true; },
    onExit: () => session.end(),
    caps: session.initiateRoomCapture ? { roomCapture: () => session.initiateRoomCapture() } : {},
    colorCam,
  });
  if (o.color && !colorCam) app.message = '!Kamera nicht verfügbar: ' + colorError.slice(0, 40);
  window.__scanApp = app; // for debugging in the browser console
  if (!tryDepth) app.message = '!Browser hat die Depth API nicht freigegeben';

  await renderer.xr.setSession(session);
  const perf = new PerfGovernor(session.frameRate || 72);
  app.perf = perf;
  const depthReader = new DepthReader(renderer, { maxSize: o.mode.id === 'small' ? 192 : 160 });
  // diagnosis for the "Mehr …" page of the VR menu
  app.diagLines = () => {
    const d = depthReader.info;
    return [
      `Features: ${diag.features.join(', ') || '–'}`,
      `Tiefe: ${tryDepth ? 'aktiv' : 'aus'} · ${session.depthUsage ?? '?'} / ${session.depthDataFormat ?? '?'} · ${d.frames} Bilder${d.size ? ' · ' + d.size : ''}`,
      ...(d.sampler ? [`Tiefe-Dekodierung: ${d.sampler} · ${d.decode}${d.median ? ` · Median ${d.median.toFixed(2)} m` : ''}${d.validRatio !== undefined ? ` · ${Math.round(d.validRatio * 100)} % gültig` : ''}`] : []),
      ...(d.lastError ? [`!Fehler (${d.errors}×): ${d.lastError}`] : []),
    ];
  };

  // ---------------------------------------------------- controllers
  const tipVec = new THREE.Vector3();
  const ctrls = [0, 1].map((i) => {
    const c = renderer.xr.getController(i);
    c.userData.prev = {};
    c.addEventListener('connected', (e) => { c.userData.source = e.data; });
    c.addEventListener('disconnected', () => { c.userData.source = null; });
    c.addEventListener('selectstart', () => { c.userData.select = true; c.userData.selectEdge = true; });
    c.addEventListener('selectend', () => { c.userData.select = false; c.userData.releaseEdge = true; });
    scene.add(c);
    // ray
    const ray = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]), new THREE.LineBasicMaterial({ color: 0x9ecbff, transparent: true, opacity: 0.7 }));
    ray.scale.z = 0.3;
    c.add(ray);
    c.userData.ray = ray;
    return c;
  });
  const byHand = (h) => ctrls.find((c) => c.userData.source?.handedness === h);

  const raycaster = new THREE.Raycaster();
  const tmpM = new THREE.Matrix4();
  let last = performance.now();
  let frameNo = 0;
  let sceneAt = 0;
  const headPanel = new THREE.Object3D();
  scene.add(headPanel);

  renderer.setAnimationLoop((time, frame) => {
    const now = performance.now();
    perf.tick(now, now - last);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    frameNo++;
    const ref = renderer.xr.getReferenceSpace();

    const viewer = frame ? frame.getViewerPose(ref) : null;
    if (viewer) poses.push(now, viewer.transform.matrix);

    // ---- depth (+ color)
    if (frame && tryDepth) {
      const pose = viewer;
      if (pose && pose.views.length && frameNo % perf.depthEvery === 0 && !app.fusion.busy) {
        depthReader.capture(frame, pose.views[0], session);
      }
      const f = depthReader.poll();
      if (f) {
        if (colorCam?.active && app.phase === 'scanning') {
          const c = colorCam.grab(128);
          const head = c && poses.at(c.time);
          if (head) f.color = { width: c.width, height: c.height, rgba: c.rgba, proj: projFromModel(colorCam.model, c.width / c.height), camToWorld: cameraPose(head, colorCam.model) };
        }
        app.onDepthFrame(f);
      }
      diag.depthUsage = session.depthUsage;
      diag.depthFormat = session.depthDataFormat;
      // without a single depth image after many attempts: give up (saves time per frame)
      if (depthReader.info.frames === 0 && depthReader.info.errors > 120) {
        tryDepth = false;
        app.message = '!Browser liefert keine Tiefendaten: ' + (depthReader.info.lastError || '').slice(0, 60);
      }
    }

    // ---- room mesh / planes
    if (frame && o.mode.id === 'room' && now - sceneAt > 1000) {
      sceneAt = now;
      try { app.captureScene(frame, ref); } catch (e) { console.warn(e); }
    }

    // ---- input
    const right = byHand('right') || ctrls[0];
    const left = byHand('left');
    right.updateMatrixWorld();
    app.tipWorld.copy(tipVec.fromArray(tipOffset(app.tip))).applyMatrix4(right.matrixWorld);
    app.tipBase.setFromMatrixPosition(right.matrixWorld);

    tmpM.identity().extractRotation(right.matrixWorld);
    raycaster.ray.origin.setFromMatrixPosition(right.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tmpM);
    const hit = app.panel.hit(raycaster);
    app.panel.setHover(hit?.id ?? null);
    // while measuring/placing, the ray ends at the floating tip (like a virtual stylus)
    right.userData.ray.scale.z = hit?.onPanel ? hit.distance : app.tipVisible && app.tip.mode === 'float' ? app.tip.dist : 0.3;
    if (left) left.userData.ray.visible = false;

    const ud = right.userData;
    if (ud.selectEdge) {
      ud.selectEdge = false;
      if (hit?.onPanel) { if (hit.id) app.onButton(hit.id); ud.panelPress = true; }
      else app.trigger();
    }
    if (ud.select && !ud.panelPress) app.calibrationSample(right.matrixWorld);
    if (ud.releaseEdge) {
      ud.releaseEdge = false;
      if (!ud.panelPress) {
        app.calibrationEnd();
      }
      ud.panelPress = false;
    }

    const gp = right.userData.source?.gamepad;
    if (gp) {
      const btn = (i) => !!gp.buttons[i]?.pressed;
      const edge = (i) => { const p = btn(i), was = ud.prev[i]; ud.prev[i] = p; return p && !was; };
      if (edge(1)) app.dragBox(true, app.tipWorld);
      else if (btn(1)) app.dragBox(false, app.tipWorld);
      if (edge(4)) app.startPause();
      if (edge(5)) app.undo();
      const sx = gp.axes[2] || 0, sy = gp.axes[3] || 0;
      if (app.colorCal) {
        // align the color camera: right stick = yaw/pitch
        if (Math.abs(sx) > 0.2) app.adjustColorModel(-sx * dt * 0.15, 0, 0);
        if (Math.abs(sy) > 0.2) app.adjustColorModel(0, -sy * dt * 0.15, 0);
      } else {
        if (Math.abs(sy) > 0.2) app.adjustBox(-sy * dt * 0.6, 0);
        if (Math.abs(sx) > 0.2) app.adjustBox(0, -sx * dt * 1.2);
      }
    }
    const lgp = left?.userData.source?.gamepad;
    if (lgp) {
      const lud = left.userData;
      const sy = lgp.axes[3] || 0;
      if (app.colorCal) { if (Math.abs(sy) > 0.2) app.adjustColorModel(0, 0, -sy * dt * 8); }
      else if (Math.abs(sy) > 0.2) app.adjustBox(0, 0, -sy * dt * 0.6);
      const p4 = !!lgp.buttons[4]?.pressed, p5 = !!lgp.buttons[5]?.pressed;
      if (p4 && !lud.prev[4]) app.panel.mesh.visible = !app.panel.mesh.visible; // X: hide/show panel
      if (p5 && !lud.prev[5]) app.cycleTool(); // Y: next measuring tool
      lud.prev[4] = p4; lud.prev[5] = p5;
    }

    // ---- panel: on the left controller, otherwise in front of the head
    const pm = app.panel.mesh;
    if (left) {
      left.updateMatrixWorld();
      pm.position.set(0, 0.07, -0.05).applyMatrix4(left.matrixWorld);
      pm.quaternion.setFromRotationMatrix(left.matrixWorld).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 4, 0, 0)));
    } else {
      const cam = renderer.xr.getCamera();
      headPanel.position.setFromMatrixPosition(cam.matrixWorld);
      headPanel.quaternion.setFromRotationMatrix(cam.matrixWorld);
      const target = new THREE.Vector3(-0.15, -0.15, -0.5).applyMatrix4(cam.matrixWorld);
      pm.position.lerp(target, Math.min(1, dt * 2));
      pm.lookAt(headPanel.position);
    }

    // live projection of the camera image for the alignment
    if (app.colorCal && colorCam && viewer) {
      const cam = cameraPose(viewer.transform.matrix, colorCam.model);
      const view = new THREE.Matrix4().fromArray(cam).invert();
      const vp = mul4(projFromModel(colorCam.model, colorCam.aspect), view.elements);
      app.setProjector(vp, videoTex);
    }

    app.update(now);
    renderer.render(scene, camera);
  });

  session.addEventListener('end', () => {
    renderer.setAnimationLoop(null);
    diag.depth = { ...depthReader.info };
    diag.orientation = app.fusion.orientation;
    diag.perf = perf.summary();
    depthReader.dispose();
    if (colorCam) diag.colorFrames = colorCam.frames;
    colorCam?.stop();
    videoTex?.dispose();
    app.dispose();
    renderer.dispose();
    renderer.domElement.remove();
    o.onEnd({ saved, diag });
  });
  return session;
}
