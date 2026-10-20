// 3D viewer on the start page (desktop / Quest browser): shows the export parts in CAD space.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';

const COLORS = { 'Scan': 0x7ee0b0, 'Quest-Raum-Mesh': 0x6c8cff, 'Raumflaechen': 0xffb86b, 'Messungen': 0xff5c8a };

export class Viewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x12161d);
    this.camera = new THREE.PerspectiveCamera(50, 1, 1, 100000);
    this.camera.up.set(0, 0, 1); // CAD: Z up
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
    const d = new THREE.DirectionalLight(0xffffff, 1.6);
    d.position.set(1, -2, 3);
    this.scene.add(d);
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.axes = new THREE.AxesHelper(100);
    this.scene.add(this.axes);
    this.visible = {};
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(container);
    this.renderer.setAnimationLoop(() => { this.controls.update(); this.renderer.render(this.scene, this.camera); });
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // dollhouse: hide back faces so you can look into a room from outside
  show(parts, fit = true, dollhouse = false) {
    for (const c of [...this.group.children]) { this.group.remove(c); c.geometry.dispose(); c.material.dispose(); }
    for (const p of parts) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(p.mesh.positions, 3));
      g.setIndex(new THREE.BufferAttribute(p.mesh.indices, 1));
      g.computeVertexNormals();
      const transparent = p.name === 'Quest-Raum-Mesh' || p.name === 'Raumflaechen';
      const vc = !!p.mesh.colors;
      if (vc) g.setAttribute('color', new THREE.BufferAttribute(p.mesh.colors, 3, true));
      const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
        color: vc ? 0xffffff : COLORS[p.name] ?? 0xcccccc, vertexColors: vc,
        roughness: 0.8, side: dollhouse && p.name !== 'Messungen' ? THREE.FrontSide : THREE.DoubleSide,
        transparent, opacity: transparent ? 0.45 : 1, depthWrite: !transparent,
      }));
      m.name = p.name;
      this.group.add(m);
    }
    if (fit) this.fit();
  }

  fit() {
    const box = new THREE.Box3().setFromObject(this.group);
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3()).length() || 100;
    this.controls.target.copy(c);
    this.camera.position.copy(c).add(new THREE.Vector3(0.6, -1, 0.7).normalize().multiplyScalar(s * 1.1));
    this.camera.near = s / 1000; this.camera.far = s * 20;
    this.camera.updateProjectionMatrix();
    this.axes.scale.setScalar(Math.max(0.2, s / 1000));
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
