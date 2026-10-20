// WebXR session on the Quest: passthrough (immersive-ar), depth, controllers, room mesh.
import * as THREE from 'three';
import { ScanApp } from './scan-app.js';
import { DepthReader } from './depth-reader.js';

const TIP_KEY = 'quest-scanner-tip-offset';

export function loadTipOffset() {
  try {
    const v = JSON.parse(localStorage.getItem(TIP_KEY));
    if (Array.isArray(v) && v.length === 3) return v;
  } catch { /* storage unavailable */ }
  return [0, 0, 0];
}

function saveTipOffset(v) {
  try { localStorage.setItem(TIP_KEY, JSON.stringify(v)); } catch { /* ignore */ }
}

export async function isARSupported() {
  try { return !!navigator.xr && await navigator.xr.isSessionSupported('immersive-ar'); } catch { return false; }
}

/**
 * Starts a scan session.
 * @param {object} o
 * @param {object} o.mode
 * @param {string} o.orientation
 * @param {(rec) => Promise<void>} o.onSave
 * @param {(info: {saved: boolean, diag: object}) => void} o.onEnd
 */
export async function startXR(o) {
  const sessionInit = {
    requiredFeatures: ['local-floor'],
    optionalFeatures: ['depth-sensing', 'mesh-detection', 'plane-detection', 'hand-tracking'],
    depthSensing: {
      usagePreference: ['gpu-optimized', 'cpu-optimized'],
      dataFormatPreference: ['float32', 'luminance-alpha'],
    },
  };
  const session = await navigator.xr.requestSession('immersive-ar', sessionInit);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(1);
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local-floor');
  renderer.domElement.style.display = 'none';
  document.body.appendChild(renderer.domElement);
  // We use the depth for scanning, not for occlusion (it would hide the preview on real surfaces).
  renderer.xr.getDepthSensingMesh = () => null;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 1, 0.01, 50);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2));

  let saved = false;
  const features = session.enabledFeatures || [];
  const diag = { features: [...features], depthUsage: null, depthFormat: null };

  const app = new ScanApp({
    scene,
    mode: o.mode,
    orientation: o.orientation,
    onSave: async (rec) => { rec.stats.depth = { ...depthReader.info }; await o.onSave(rec); saved = true; },
    onExit: () => session.end(),
    caps: session.initiateRoomCapture ? { roomCapture: () => session.initiateRoomCapture() } : {},
  });
  window.__scanApp = app; // for debugging in the browser console
  if (features.length && !features.includes('depth-sensing')) app.message = '!Depth API nicht verfügbar – nur Messen/Raum-Mesh';

  await renderer.xr.setSession(session);
  const depthReader = new DepthReader(renderer, { maxSize: o.mode.id === 'small' ? 192 : 160 });

  // ---------------------------------------------------- controllers
  const tipOffset = new THREE.Vector3().fromArray(loadTipOffset());
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
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    frameNo++;
    const ref = renderer.xr.getReferenceSpace();

    // ---- depth
    if (frame && features.includes('depth-sensing')) {
      const pose = frame.getViewerPose(ref);
      if (pose && pose.views.length && frameNo % 2 === 0 && !app.fusion.busy) {
        depthReader.capture(frame, pose.views[0], session);
      }
      const f = depthReader.poll();
      if (f) app.onDepthFrame(f);
      diag.depthUsage = session.depthUsage;
      diag.depthFormat = session.depthDataFormat;
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
    app.tipWorld.copy(tipOffset).applyMatrix4(right.matrixWorld);

    tmpM.identity().extractRotation(right.matrixWorld);
    raycaster.ray.origin.setFromMatrixPosition(right.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tmpM);
    const hit = app.panel.hit(raycaster);
    app.panel.setHover(hit?.id ?? null);
    right.userData.ray.scale.z = hit?.onPanel ? hit.distance : 0.3;
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
        const tip = app.calibrationEnd();
        if (tip) { tipOffset.fromArray(tip); saveTipOffset(tip); }
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
      if (Math.abs(sy) > 0.2) app.adjustBox(-sy * dt * 0.6, 0);
      if (Math.abs(sx) > 0.2) app.adjustBox(0, -sx * dt * 1.2);
    }
    const lgp = left?.userData.source?.gamepad;
    if (lgp) {
      const lud = left.userData;
      const sy = lgp.axes[3] || 0;
      if (Math.abs(sy) > 0.2) app.adjustBox(0, 0, -sy * dt * 0.6);
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

    app.update(now);
    renderer.render(scene, camera);
  });

  session.addEventListener('end', () => {
    renderer.setAnimationLoop(null);
    diag.depth = { ...depthReader.info };
    diag.orientation = app.fusion.orientation;
    depthReader.dispose();
    app.dispose();
    renderer.dispose();
    renderer.domElement.remove();
    o.onEnd({ saved, diag });
  });
  return session;
}
