// Desktop simulation: tests the whole pipeline without a headset.
// A virtual scene is "scanned" with a synthetic depth camera. The depth goes
// through the same GPU path as on the Quest (depth texture array → shader →
// PBO), then the worker, preview, measurements and saving.
import * as THREE from 'three';
import { ScanApp } from '../xr/scan-app.js';
import { DepthReader } from '../xr/depth-reader.js';
import { perspective, lookAt, renderDepth, renderColor, mulberry32 } from './synth.js';
import { loadModel, cameraPose, projFromModel } from '../xr/color-camera.js';

const SCENES = {
  small: {
    target: [0, 0.8, -0.6],
    radius: 0.45,
    objects: [
      { type: 'plane', y: 0.75, colorFn: checker([150, 110, 70], [120, 85, 50], 0.05) },
      { type: 'sphere', c: [0, 0.81, -0.6], r: 0.06, colorFn: (p) => (p[1] > 0.83 ? [220, 40, 40] : [240, 240, 240]) },
      { type: 'box', min: [0.02, 0.75, -0.66], max: [0.1, 0.83, -0.56], color: [40, 90, 220] },
    ],
    tip: [0, 0.75, -0.6],
  },
  medium: {
    target: [0, 0.5, -1.2],
    radius: 1.5,
    objects: [
      { type: 'plane', y: 0, colorFn: checker([90, 90, 90], [60, 60, 60], 0.25) },
      { type: 'box', min: [-0.4, 0, -1.5], max: [0.4, 0.75, -0.9], color: [180, 130, 80] },
      { type: 'sphere', c: [0, 0.95, -1.2], r: 0.2, colorFn: (p) => (p[0] > 0 ? [230, 200, 40] : [40, 160, 80]) },
    ],
    tip: [0, 0, -1.2],
  },
  room: {
    target: [0, 1.2, 0],
    radius: 0,
    objects: [
      { type: 'plane', y: 0, colorFn: checker([140, 100, 60], [120, 85, 50], 0.3) }, { type: 'plane', y: 2.5, color: [245, 245, 245] },
      { type: 'plane', n: [1, 0, 0], d: 1.8, color: [200, 220, 235] }, { type: 'plane', n: [1, 0, 0], d: -1.8, color: [235, 225, 200] },
      { type: 'plane', n: [0, 0, 1], d: 2.2, color: [220, 235, 210] }, { type: 'plane', n: [0, 0, 1], d: -2.2, color: [235, 210, 210] },
      { type: 'box', min: [-1.8, 0, -2.2], max: [-0.8, 0.75, -1.5], color: [90, 60, 40] },
      { type: 'box', min: [1.2, 0, 0.5], max: [1.8, 2.0, 1.5], color: [250, 250, 250] },
      { type: 'sphere', c: [0.5, 1.8, -2.0], r: 0.02 }, // clothes rail as stand-in
    ],
    tip: [0, 0, 0],
  },
};

function checker(a, b, size) {
  return (p) => ((Math.floor(p[0] / size) + Math.floor(p[2] / size)) & 1 ? a : b);
}

// Simulated color camera: same interface as ColorCamera (grab, model, …)
class SimColorCamera {
  constructor(objects) {
    this.objects = objects;
    this.model = loadModel();
    this.frames = 0;
    this.grabs = 0;
    this.label = 'Simulation';
    this.active = true;
    this.aspect = 4 / 3;
  }

  grabAt(head) {
    const camToWorld = cameraPose(head, this.model);
    const proj = projFromModel(this.model, this.aspect);
    const rgba = renderColor(this.objects, camToWorld, proj, 64, 48);
    this.frames++;
    this.grabs++;
    return { width: 64, height: 48, rgba, proj, camToWorld };
  }
}

function sceneVisuals(objects) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x8899aa, roughness: 0.9, transparent: true, opacity: 0.35 });
  for (const o of objects) {
    let m;
    if (o.type === 'sphere') { m = new THREE.Mesh(new THREE.SphereGeometry(o.r, 32, 16), mat); m.position.fromArray(o.c); }
    else if (o.type === 'box') {
      const s = o.max.map((v, i) => v - o.min[i]);
      m = new THREE.Mesh(new THREE.BoxGeometry(...s), mat);
      m.position.set(...o.min.map((v, i) => v + s[i] / 2));
    } else continue;
    g.add(m);
  }
  const grid = new THREE.GridHelper(6, 30, 0x335566, 0x223344);
  g.add(grid);
  return g;
}

/**
 * @param {object} o
 * @param {HTMLElement} o.container
 * @param {object} o.mode
 * @param {(rec) => Promise<void>} o.onSave
 * @param {() => void} o.onEnd
 */
export function startSim(o) {
  const def = SCENES[o.mode.id];
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  o.container.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e1116);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 2.5));
  scene.add(sceneVisuals(def.objects));
  const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 50);

  const gl = renderer.getContext();
  const W = 96, H = 96, NEAR = 0.1, FAR = 100;
  const depthTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, depthTex);
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R32F, W, H, 2);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  renderer.resetState();

  const depthReader = new DepthReader(renderer, { maxSize: 96 });
  const rnd = mulberry32(42);
  let ended = false;

  const ui = document.createElement('div');
  ui.className = 'sim-ui';
  o.container.appendChild(ui);

  const colorCam = o.color ? new SimColorCamera(def.objects) : null;
  const app = new ScanApp({
    scene,
    colorCam,
    mode: o.mode,
    orientation: 'auto',
    onSave: async (rec) => { rec.stats.depth = { ...depthReader.info }; rec.name += ' (Simulation)'; await o.onSave(rec); },
    onExit: () => end(),
  });
  app.panel.mesh.visible = false;
  app.tipWorld.fromArray(def.tip);

  ui.addEventListener('click', (e) => {
    const id = e.target.closest('button')?.dataset.id;
    if (id) app.onButton(id);
  });

  const P = perspective(1.2, 1, NEAR, FAR);
  let t = 0, last = performance.now(), frameNo = 0;
  let uiKey = '';

  function camPose(t) {
    const tg = def.target;
    if (def.radius === 0) {
      // room: stand in the center, look around (yaw) and up/down (pitch)
      const yaw = t * 0.5, pitch = Math.sin(t * 0.9) * 0.6 - 0.1;
      const eye = [0, 1.6, 0];
      return lookAt(eye, [eye[0] + Math.sin(yaw) * Math.cos(pitch), eye[1] + Math.sin(pitch), eye[2] - Math.cos(yaw) * Math.cos(pitch)]);
    }
    const az = t * 0.45, el = 0.35 + Math.sin(t * 0.7) * 0.25;
    const eye = [tg[0] + Math.sin(az) * Math.cos(el) * def.radius, tg[1] + Math.sin(el) * def.radius, tg[2] + Math.cos(az) * Math.cos(el) * def.radius];
    return lookAt(eye, tg);
  }

  function loop() {
    if (ended) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    frameNo++;
    if (app.phase === 'scanning') t += dt;
    const M = camPose(t);

    // synthetic depth → window depth in a texture array → GPU path
    if (frameNo % 3 === 0 && !app.fusion.busy) {
      const z = renderDepth(def.objects, M, P, W, H, 0.004, rnd);
      const win = new Float32Array(W * H);
      for (let k = 0; k < z.length; k++) win[k] = z[k] > 0 ? (FAR * (z[k] - NEAR)) / (z[k] * (FAR - NEAR)) : 1;
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, depthTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, W, H, 1, gl.RED, gl.FLOAT, win);
      renderer.resetState();
      depthReader.captureTexture({
        texture: depthTex, textureType: 'texture-array', imageIndex: 0, width: W, height: H,
        depthNear: NEAR, depthFar: FAR, transform: { matrix: M }, projectionMatrix: P,
      }, { eye: 'left' }, 'float32');
    }
    const f = depthReader.poll();
    if (f) {
      if (colorCam && app.phase === 'scanning') f.color = colorCam.grabAt(f.camToWorld);
      app.onDepthFrame(f);
    }

    app.update(now);
    const content = app.panelContent();
    const key = JSON.stringify(content);
    if (key !== uiKey) {
      uiKey = key;
      ui.innerHTML = `<div class="sim-lines">${content.lines.map((l) => `<div class="${l.startsWith('!') ? 'warn' : ''}">${l.replace(/^!/, '')}</div>`).join('')}</div>` +
        content.buttons.map((b) => `<button data-id="${b.id}" ${b.disabled ? 'disabled' : ''} class="${b.active ? 'active' : ''} ${b.danger ? 'danger' : ''}">${b.label}</button>`).join('');
    }

    // observer camera: behind the virtual depth camera
    const w = o.container.clientWidth, h = o.container.clientHeight;
    if (renderer.domElement.width !== Math.floor(w * renderer.getPixelRatio())) { renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); }
    const eye = new THREE.Vector3(M[12], M[13], M[14]);
    const back = new THREE.Vector3(M[8], M[9], M[10]).multiplyScalar(def.radius ? 0.35 : 0.5);
    camera.position.copy(eye).add(back).add(new THREE.Vector3(0, 0.15, 0));
    camera.lookAt(def.radius ? new THREE.Vector3(...def.target) : eye.clone().sub(new THREE.Vector3(M[8], M[9], M[10])));
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  function end() {
    if (ended) return;
    ended = true;
    depthReader.dispose();
    gl.deleteTexture(depthTex);
    app.dispose();
    renderer.dispose();
    renderer.domElement.remove();
    ui.remove();
    o.onEnd();
  }
  return { app, end };
}
