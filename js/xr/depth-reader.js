// Reads the WebXR depth map (Meta Depth API) and delivers it as
// Float32Array z-depth in meters. Supports both WebXR paths:
//  - 'gpu-optimized' (Quest Browser): the depth is a GPU texture → render it
//    into a small RGBA8 texture, read back asynchronously via PBO + fence
//    (no pipeline stall).
//  - 'cpu-optimized': getDepthInMeters() per pixel.
// The result also carries the depth camera's pose and projection.

const VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

function fragmentShader(isArray) {
  return `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;
uniform ${isArray ? 'sampler2DArray' : 'sampler2D'} uTex;
uniform int uLayer;
uniform mat4 uUv;
uniform vec2 uOutSize;
uniform float uNear;
uniform float uFar;
uniform int uMode;      // 0: window depth with near/far, 1: raw * uRawToMeters
uniform int uLA;        // 1: luminance-alpha (16-bit split into two bytes)
uniform float uRawToMeters;
out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy / uOutSize;
  vec2 tuv = (uUv * vec4(uv, 0.0, 1.0)).xy;
  ivec2 size = textureSize(uTex, 0).xy;
  ivec2 px = clamp(ivec2(tuv * vec2(size)), ivec2(0), size - 1);
  vec4 s = texelFetch(uTex, ${isArray ? 'ivec3(px, uLayer)' : 'px'}, 0);
  float raw = uLA == 1 ? (s.r * 255.0 + s.a * 255.0 * 256.0) : s.r;
  float z;
  if (uMode == 0) {
    if (raw <= 0.0 || raw >= 1.0) { outColor = vec4(0.0); return; }
    z = uFar > 1.0e5 ? uNear / (1.0 - raw) : (uNear * uFar) / (uFar - raw * (uFar - uNear));
  } else {
    z = raw * uRawToMeters;
    if (z <= 0.0) { outColor = vec4(0.0); return; }
  }
  float v = clamp(z / 20.0, 0.0, 0.99999);
  vec3 enc = fract(v * vec3(1.0, 255.0, 65025.0));
  enc -= enc.yzz * vec3(1.0 / 255.0, 1.0 / 255.0, 0.0);
  outColor = vec4(enc, 1.0);
}`;
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export class DepthReader {
  /**
   * @param {import('three').WebGLRenderer} renderer
   * @param {{maxSize?: number}} [o]
   */
  constructor(renderer, o = {}) {
    this.renderer = renderer;
    this.gl = renderer.getContext();
    this.maxSize = o.maxSize ?? 160;
    this.programs = {};
    this.slots = [];
    this.info = { usage: null, format: null, frames: 0, errors: 0, lastError: null };
    this.ready = [];
  }

  _program(isArray) {
    const key = isArray ? 'array' : 'tex';
    if (this.programs[key]) return this.programs[key];
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fragmentShader(isArray)));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link: ' + gl.getProgramInfoLog(p));
    const u = {};
    for (const n of ['uTex', 'uLayer', 'uUv', 'uOutSize', 'uNear', 'uFar', 'uMode', 'uLA', 'uRawToMeters']) u[n] = gl.getUniformLocation(p, n);
    const prog = { p, u, vao: gl.createVertexArray() };
    this.programs[key] = prog;
    return prog;
  }

  _slot(w, h) {
    // ring of 3 targets + PBOs, so up to 3 reads can be in flight
    let s = this.slots.find((x) => !x.busy && x.w === w && x.h === h);
    if (s) return s;
    if (this.slots.filter((x) => x.busy).length >= 3) return null;
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const pbo = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, w * h * 4, gl.STREAM_READ);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    s = { w, h, tex, fb, pbo, busy: false, fence: null, meta: null };
    this.slots.push(s);
    return s;
  }

  /**
   * Starts reading the depth for one view (inside the XR frame callback).
   * @param {XRFrame} frame
   * @param {XRView} view
   * @param {XRSession} session
   * @returns {boolean} whether a read was started
   */
  capture(frame, view, session) {
    this.info.usage = session.depthUsage;
    this.info.format = session.depthDataFormat;
    try {
      if (session.depthUsage === 'cpu-optimized') return this._captureCPU(frame, view);
      const binding = this.renderer.xr.getBinding();
      const di = binding.getDepthInformation(view);
      if (!di || di.isValid === false || !di.texture) return false;
      return this.captureTexture(di, view, session.depthDataFormat);
    } catch (e) {
      this._error(e);
      return false;
    }
  }

  _error(e) {
    this.info.errors++;
    this.info.lastError = String(e && e.message || e);
    if (this.info.errors < 5) console.warn('DepthReader', e);
  }

  _poseOf(di, view) {
    const camToWorld = new Float32Array((di.transform || view.transform).matrix);
    const proj = new Float32Array(di.projectionMatrix || view.projectionMatrix);
    return { camToWorld, proj };
  }

  /**
   * GPU path. Also used by the desktop simulation with a self-made texture.
   * @param {{texture: WebGLTexture, textureType?: string, imageIndex?: number, width: number, height: number,
   *   depthNear?: number, depthFar?: number, rawValueToMeters?: number,
   *   normDepthBufferFromNormView?: {matrix: Float32Array}, transform?: XRRigidTransform,
   *   projectionMatrix?: Float32Array}} di
   */
  captureTexture(di, view, format) {
    const gl = this.gl;
    const isArray = di.textureType ? di.textureType === 'texture-array' : true;
    const layer = di.imageIndex ?? (view.eye === 'right' ? 1 : 0);
    const sc = Math.min(1, this.maxSize / Math.max(di.width, di.height));
    const w = Math.max(8, Math.round(di.width * sc)), h = Math.max(8, Math.round(di.height * sc));
    const slot = this._slot(w, h);
    if (!slot) return false;

    const windowDepth = di.depthNear !== undefined && di.depthFar !== undefined && !(di.rawValueToMeters > 0 && format !== 'float32');
    this.info.textureType = di.textureType || '(keins → array)';
    this.info.size = `${di.width}×${di.height} → ${w}×${h}`;
    this.info.near = di.depthNear;
    this.info.far = di.depthFar;
    this.info.rawToMeters = di.rawValueToMeters;
    this.info.decode = windowDepth ? 'Fenstertiefe (near/far)' : 'Rohwert × rawValueToMeters';
    this.info.reprojected = !di.transform;

    const prevRT = this.renderer.getRenderTarget();
    const prevFB = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const prog = this._program(isArray);
    gl.bindFramebuffer(gl.FRAMEBUFFER, slot.fb);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.CULL_FACE); gl.disable(gl.STENCIL_TEST);
    gl.colorMask(true, true, true, true);
    gl.useProgram(prog.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(isArray ? gl.TEXTURE_2D_ARRAY : gl.TEXTURE_2D, di.texture);
    gl.uniform1i(prog.u.uTex, 0);
    gl.uniform1i(prog.u.uLayer, layer);
    gl.uniformMatrix4fv(prog.u.uUv, false, di.normDepthBufferFromNormView?.matrix || IDENTITY);
    gl.uniform2f(prog.u.uOutSize, w, h);
    gl.uniform1f(prog.u.uNear, di.depthNear ?? 0.1);
    gl.uniform1f(prog.u.uFar, Number.isFinite(di.depthFar) ? di.depthFar : 1e9);
    gl.uniform1i(prog.u.uMode, windowDepth ? 0 : 1);
    gl.uniform1i(prog.u.uLA, format === 'luminance-alpha' ? 1 : 0);
    gl.uniform1f(prog.u.uRawToMeters, di.rawValueToMeters || 0.001);
    gl.bindVertexArray(prog.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);

    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    slot.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    slot.busy = true;
    slot.meta = this._poseOf(di, view);
    slot.t = performance.now();

    // restore three.js state
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFB);
    this.renderer.resetState();
    this.renderer.setRenderTarget(prevRT);
    return true;
  }

  _captureCPU(frame, view) {
    const di = frame.getDepthInformation(view);
    if (!di) return false;
    const sc = Math.min(1, this.maxSize / Math.max(di.width, di.height));
    const w = Math.max(8, Math.round(di.width * sc)), h = Math.max(8, Math.round(di.height * sc));
    const depth = new Float32Array(w * h);
    for (let j = 0; j < h; j++) {
      // normalized view coordinates: origin top left → row 0 of our image is the bottom
      const y = 1 - (j + 0.5) / h;
      for (let i = 0; i < w; i++) {
        const d = di.getDepthInMeters((i + 0.5) / w, y);
        depth[j * w + i] = d > 0 ? d : 0;
      }
    }
    this.info.size = `${di.width}×${di.height} → ${w}×${h}`;
    this.info.decode = 'CPU getDepthInMeters';
    this.info.frames++;
    this.ready.push({ width: w, height: h, depth, ...this._poseOf(di, view), latency: 0 });
    return true;
  }

  /** Returns a finished depth frame or null (call every frame). */
  poll() {
    const gl = this.gl;
    for (const s of this.slots) {
      if (!s.busy) continue;
      const st = gl.clientWaitSync(s.fence, 0, 0);
      if (st !== gl.ALREADY_SIGNALED && st !== gl.CONDITION_SATISFIED) continue;
      gl.deleteSync(s.fence);
      s.fence = null;
      const u8 = new Uint8Array(s.w * s.h * 4);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, s.pbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, u8);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      s.busy = false;
      const depth = new Float32Array(s.w * s.h);
      let valid = 0;
      for (let k = 0, o = 0; k < depth.length; k++, o += 4) {
        if (u8[o + 3] < 128) continue;
        depth[k] = (u8[o] / 255 + u8[o + 1] / 65025 + u8[o + 2] / 16581375) * 20;
        valid++;
      }
      this.info.frames++;
      this.info.validRatio = valid / depth.length;
      if (valid) {
        const sample = [];
        for (let k = 0; k < depth.length; k += 37) if (depth[k] > 0) sample.push(depth[k]);
        sample.sort((a, b) => a - b);
        this.info.median = sample[sample.length >> 1];
      }
      this.ready.push({ width: s.w, height: s.h, depth, ...s.meta, latency: performance.now() - s.t });
    }
    return this.ready.shift() || null;
  }

  dispose() {
    const gl = this.gl;
    for (const s of this.slots) {
      if (s.fence) gl.deleteSync(s.fence);
      gl.deleteTexture(s.tex); gl.deleteFramebuffer(s.fb); gl.deleteBuffer(s.pbo);
    }
    for (const p of Object.values(this.programs)) { gl.deleteProgram(p.p); gl.deleteVertexArray(p.vao); }
    this.slots = [];
    this.programs = {};
  }
}
