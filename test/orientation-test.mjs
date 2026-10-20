// Checks the automatic detection of the depth image orientation in the worker logic
// by running worker.js in a fake worker scope.
import { perspective, lookAt, renderDepth } from '../js/sim/synth.js';

const msgs = [];
globalThis.self = globalThis;
globalThis.postMessage = (m) => msgs.push(m);
await import('../js/fusion/worker.js');
const send = (m) => globalThis.onmessage({ data: m });

function flip(depth, W, H, fx, fy) {
  const out = new Float32Array(depth.length);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) out[j * W + i] = depth[(fy ? H - 1 - j : j) * W + (fx ? W - 1 - i : i)];
  return out;
}

let failed = 0;
const scene = [{ type: 'plane', y: 0 }, { type: 'box', min: [-0.5, 0, -2.2], max: [0.4, 0.75, -1.6] }, { type: 'box', min: [1.2, 0, -3], max: [1.6, 1.8, -2.5] }, { type: 'sphere', c: [-0.8, 1.2, -2], r: 0.3 }];
for (const [fx, fy, expect] of [[false, false, 'none'], [false, true, 'flipY'], [true, false, 'flipX'], [true, true, 'flipXY']]) {
  msgs.length = 0;
  send({ type: 'init', config: { voxelSize: 0.03 }, orientation: 'auto' });
  const P = perspective(1.4, 1, 0.1, 100);
  let k = 0, result = null;
  while (!result && k < 150) {
    const t = k * 0.08;
    const target = [Math.sin(t) * 1.5, 0.6 + Math.sin(t * 1.7) * 0.6, -2];
    const M = lookAt([0, 1.6, 0], target);
    const d = flip(renderDepth(scene, M, P, 96, 96), 96, 96, fx, fy);
    send({ type: 'frame', width: 96, height: 96, depth: d, proj: P, camToWorld: M });
    result = msgs.find((m) => m.type === 'orientation');
    k++;
  }
  const ok = result && result.orientation === (expect === 'none' ? 'none' : expect);
  // the image is flipped by `expect`, so the worker has to apply the same flip to undo it
  console.log(`${ok ? 'OK  ' : 'FAIL'} Orientierung ${expect}: erkannt ${result?.orientation} nach ${k} Frames`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
