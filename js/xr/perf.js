// Frame rate measurement and automatic throttling: if the headset misses its
// frame rate, depth frames are processed less often and the preview is
// refreshed less often (and back up again once there is headroom).

const DEPTH_EVERY = [2, 3, 4, 6, 8];   // process a depth frame every n-th rendered frame
const PREVIEW_FACTOR = [1, 1.5, 2, 3, 4]; // multiplier for the preview interval

export class PerfGovernor {
  /** @param {number} [target] display refresh rate in Hz (Quest 3S: 72/90/120) */
  constructor(target = 72) {
    this.target = target;
    this.fps = target;
    this.level = 0;
    this._windowStart = 0;
    this._windowFrames = 0;
    this._goodSince = 0;
    this.frames = 0;
    this.time = 0;          // ms
    this.slowTime = 0;      // ms below 90 % of the target
    this.minFps = Infinity; // worst 1 s average
  }

  get depthEvery() { return DEPTH_EVERY[this.level]; }
  get previewFactor() { return PREVIEW_FACTOR[this.level]; }
  get avgFps() { return this.time > 0 ? (this.frames * 1000) / this.time : this.target; }

  /** Call once per rendered frame. @param {number} now ms @param {number} dt ms since the last frame */
  tick(now, dt) {
    if (dt > 0 && dt < 500) {
      this.frames++;
      this.time += dt;
      if (1000 / dt < this.target * 0.9) this.slowTime += dt;
    }
    if (!this._windowStart) this._windowStart = now;
    this._windowFrames++;
    const span = now - this._windowStart;
    if (span < 1000) return;
    // 1 s window
    this.fps = (this._windowFrames * 1000) / span;
    this.minFps = Math.min(this.minFps, this.fps);
    this._windowStart = now;
    this._windowFrames = 0;
    if (this.fps < this.target * 0.85) {
      if (this.level < DEPTH_EVERY.length - 1) this.level++;
      this._goodSince = 0;
    } else if (this.fps > this.target * 0.95) {
      if (!this._goodSince) this._goodSince = now;
      // only speed up again after 3 s without problems
      if (this.level > 0 && now - this._goodSince >= 3000) { this.level--; this._goodSince = now; }
    } else {
      this._goodSince = 0;
    }
  }

  summary() {
    return {
      target: this.target,
      avg: Math.round(this.avgFps),
      min: Number.isFinite(this.minFps) ? Math.round(this.minFps) : null,
      slowPct: this.time ? Math.round((this.slowTime / this.time) * 100) : 0,
      level: this.level,
    };
  }
}
