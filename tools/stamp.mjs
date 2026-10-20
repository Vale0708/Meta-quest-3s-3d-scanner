// Deploy step: appends ?v=<tag> to all relative module URLs, so the browser (e.g. on the
// Quest) never mixes old cached files with new ones after an update.
// Usage: node tools/stamp.mjs <site dir> <tag>
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [dir, tag] = process.argv.slice(2);
if (!dir || !tag) { console.error('Usage: node tools/stamp.mjs <site dir> <tag>'); process.exit(1); }
const v = encodeURIComponent(tag);

const stampJs = (src) => src.replace(/(['"])(\.\.?\/[^'"?\s]+\.js)\1/g, `$1$2?v=${v}$1`);
const stampHtml = (src) => src.replace(/((?:src|href)=")((?:js|css)\/[^"?]+\.(?:js|css))"/g, `$1$2?v=${v}"`);

const walk = (d) => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
let n = 0;
for (const f of walk(join(dir, 'js'))) {
  if (!f.endsWith('.js')) continue;
  writeFileSync(f, stampJs(readFileSync(f, 'utf8')));
  n++;
}
const html = join(dir, 'index.html');
writeFileSync(html, stampHtml(readFileSync(html, 'utf8')));
console.log(`stamped ${n} files with ?v=${tag}`);
