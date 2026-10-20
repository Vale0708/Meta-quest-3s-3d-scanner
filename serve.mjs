// Local HTTPS server so the Quest can open the app on your Wi-Fi.
// WebXR only works over https:// (or http://localhost).
//   npm install
//   npm start            → https://<PC-IP>:8443
// In the Quest Browser, accept the certificate warning once
// ("Erweitert" → "Weiter zu …"). The certificate is self-signed and stays local.
import https from 'node:https';
import http from 'node:http';
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.PORT || 8443);
const HTTP_PORT = +(process.env.HTTP_PORT || 8080);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.md': 'text/plain; charset=utf-8',
};

function lanIPs() {
  return Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
}

async function certificate() {
  const dir = join(ROOT, '.cert');
  const keyFile = join(dir, 'key.pem'), certFile = join(dir, 'cert.pem');
  if (existsSync(keyFile) && existsSync(certFile)) return { key: await readFile(keyFile), cert: await readFile(certFile) };
  const { default: selfsigned } = await import('selfsigned');
  const ips = lanIPs();
  const pems = selfsigned.generate([{ name: 'commonName', value: 'quest-3d-scanner.local' }], {
    days: 3650, keySize: 2048, algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, ...['127.0.0.1', ...ips].map((ip) => ({ type: 7, ip }))] }],
  });
  await mkdir(dir, { recursive: true });
  await writeFile(keyFile, pems.private);
  await writeFile(certFile, pems.cert);
  return { key: pems.private, cert: pems.cert };
}

async function handler(req, res) {
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT) || /[\\/]\.(cert|git)/.test(file) || file.includes('node_modules')) { res.writeHead(403).end(); return; }
    const st = await stat(file).catch(() => null);
    if (!st || !st.isFile()) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(await readFile(file));
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
}

const { key, cert } = await certificate();
https.createServer({ key, cert }, handler).listen(PORT, '0.0.0.0', () => {
  console.log('\nQuest 3D-Scanner läuft:\n');
  for (const ip of lanIPs()) console.log(`  Quest-Browser:  https://${ip}:${PORT}`);
  console.log(`  Dieser PC:      https://localhost:${PORT}`);
  console.log(`  (per USB-Kabel + "adb reverse tcp:${HTTP_PORT} tcp:${HTTP_PORT}" auch http://localhost:${HTTP_PORT} auf der Quest)\n`);
  console.log('Zertifikatswarnung auf der Quest einmalig bestätigen: "Erweitert" → "Weiter".  Beenden mit Strg+C.\n');
});
http.createServer(handler).listen(HTTP_PORT, '0.0.0.0');
