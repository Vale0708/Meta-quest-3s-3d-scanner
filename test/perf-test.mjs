// Checks the automatic throttling: node test/perf-test.mjs
import { PerfGovernor } from '../js/xr/perf.js';

let failed = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${info}`); if (!ok) failed++; };

const g = new PerfGovernor(72);
let t = 1000;
const run = (fps, seconds) => { const dt = 1000 / fps; for (let i = 0; i < fps * seconds; i++) { t += dt; g.tick(t, dt); } };
run(72, 3);
check('Volle Rate: keine Drosselung', g.level === 0 && g.depthEvery === 2, `fps ${g.fps.toFixed(1)}`);
run(45, 3);
check('Einbruch: drosselt', g.level >= 2 && g.depthEvery >= 4, `Stufe ${g.level}, jedes ${g.depthEvery}. Bild`);
run(72, 20);
check('Erholt: wieder volle Rate', g.level === 0, `Stufe ${g.level}`);
const s = g.summary();
check('Statistik', s.min <= 46 && s.avg > 45 && s.avg < 72 && s.slowPct > 0, JSON.stringify(s));
process.exit(failed ? 1 : 0);
