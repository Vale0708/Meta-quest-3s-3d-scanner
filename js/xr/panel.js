// VR panel: canvas texture on a plane, buttons are hit via raycaster.
import * as THREE from 'three';

const W = 640;

export class Panel {
  constructor(widthMeters = 0.24) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = 800;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.widthMeters = widthMeters;
    const mat = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    this.mesh.renderOrder = 10;
    this.content = { title: '', lines: [], buttons: [] };
    this.rects = [];
    this.hover = null;
    this.dirty = true;
  }

  set(content) {
    const key = JSON.stringify(content);
    if (key === this._key) return;
    this._key = key;
    this.content = content;
    this.dirty = true;
  }

  setHover(id) {
    if (id !== this.hover) { this.hover = id; this.dirty = true; }
  }

  update() {
    if (!this.dirty) return;
    this.dirty = false;
    const { title, lines: rawLines = [], buttons = [] } = this.content;
    const ctx = this.ctx;
    const pad = 22, bh = 66, gap = 12;
    const lineH = 30;
    // wrap long lines (a leading "!" = warning color carries over to the continuation)
    ctx.font = '25px system-ui, sans-serif';
    const lines = [];
    for (const raw of rawLines) {
      const warn = raw.startsWith('!');
      const words = (warn ? raw.slice(1) : raw).split(' ');
      let cur = '';
      for (const w of words) {
        const next = cur ? cur + ' ' + w : w;
        if (cur && ctx.measureText(next).width > W - 2 * pad) { lines.push((warn ? '!' : '') + cur); cur = w; }
        else cur = next;
      }
      lines.push((warn ? '!' : '') + cur);
    }
    const rows = [];
    let row = [];
    for (const b of buttons) {
      if (b.wide) { if (row.length) rows.push(row); rows.push([b]); row = []; continue; }
      row.push(b);
      if (row.length === 2) { rows.push(row); row = []; }
    }
    if (row.length) rows.push(row);
    const H = pad + 48 + lines.length * lineH + 14 + rows.length * (bh + gap) + pad;
    if (this.canvas.height !== H) {
      this.canvas.height = H;
      // the canvas size changes → a new texture avoids GPU size mismatches
      this.texture.dispose();
      this.texture = new THREE.CanvasTexture(this.canvas);
      this.texture.colorSpace = THREE.SRGBColorSpace;
      this.mesh.material.map = this.texture;
    }
    this.mesh.scale.set(this.widthMeters, (this.widthMeters * H) / W, 1);

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(18, 22, 30, 0.92)';
    roundRect(ctx, 0, 0, W, H, 28);
    ctx.fill();
    ctx.fillStyle = '#7ee0b0';
    ctx.font = 'bold 36px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(title, pad, pad);
    ctx.font = '25px system-ui, sans-serif';
    let y = pad + 52;
    for (const l of lines) {
      ctx.fillStyle = l.startsWith('!') ? '#ffb86b' : '#d8dee9';
      ctx.fillText(l.replace(/^!/, ''), pad, y, W - 2 * pad);
      y += lineH;
    }
    y += 14;
    this.rects = [];
    for (const r of rows) {
      const bw = r.length === 1 ? W - 2 * pad : (W - 2 * pad - gap) / 2;
      r.forEach((b, i) => {
        const x = pad + i * (bw + gap);
        this.rects.push({ id: b.id, x, y, w: bw, h: bh, disabled: b.disabled });
        const hov = this.hover === b.id && !b.disabled;
        ctx.fillStyle = b.disabled ? '#2a2f3a' : b.active ? '#2f8f63' : b.danger ? '#7a2e35' : hov ? '#3d5a80' : '#2e3646';
        roundRect(ctx, x, y, bw, bh, 14);
        ctx.fill();
        if (hov) { ctx.strokeStyle = '#9ecbff'; ctx.lineWidth = 4; ctx.stroke(); }
        ctx.fillStyle = b.disabled ? '#6b7280' : '#ffffff';
        ctx.font = 'bold 26px system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        ctx.fillText(b.label, x + bw / 2, y + bh / 2, bw - 16);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
      });
      y += bh + gap;
    }
    this.texture.needsUpdate = true;
  }

  // Returns {id, point, distance} of the button under the ray, or null.
  hit(raycaster) {
    if (!this.mesh.visible) return null;
    const hits = raycaster.intersectObject(this.mesh, false);
    if (!hits.length || !hits[0].uv) return { id: null, distance: Infinity };
    const { uv } = hits[0];
    const px = uv.x * W, py = (1 - uv.y) * this.canvas.height;
    const r = this.rects.find((r) => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h && !r.disabled);
    return { id: r ? r.id : null, point: hits[0].point, distance: hits[0].distance, onPanel: true };
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Text label as a sprite (for measurements).
export function makeLabel(text, heightMeters = 0.025) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = 'bold 44px system-ui, sans-serif';
  const w = Math.ceil(ctx.measureText(text).width) + 32;
  c.width = w; c.height = 64;
  ctx.fillStyle = 'rgba(10,14,20,0.85)';
  roundRect(ctx, 0, 0, w, 64, 16);
  ctx.fill();
  ctx.fillStyle = '#ffe08a';
  ctx.font = 'bold 44px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 16, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  sp.scale.set((heightMeters * w) / 64, heightMeters, 1);
  sp.renderOrder = 11;
  return sp;
}
