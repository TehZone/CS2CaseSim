// Browser preview of the renderer without Electron: serves src/ and proxies + caches item images.
//   node scripts/dev-server.mjs   ->  http://localhost:5178
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CS2Service } = require('../cs2/service.cjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const IMG = path.join(ROOT, 'cache', 'img');
const portArg = process.argv.indexOf('--port');
const PORT = Number(portArg > 0 ? process.argv[portArg + 1] : process.env.PORT) || 5178;
fs.mkdirSync(IMG, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.gltf': 'model/gltf+json', '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream', '.exr': 'image/x-exr' };
const CS2_CACHE = path.join(ROOT, 'cache', 'cs2');
const TMP = path.join(process.env.LOCALAPPDATA || '', 'Temp');
const cs2 = new CS2Service({
  cacheDir: CS2_CACHE,
  // The app's own (patched) extractor when it's there, else a development build.
  cliPath: process.env.CS2SIM_CLI || [path.join(ROOT, 'tools', 's2v', 'Source2Viewer-CLI.exe'), path.join(TMP, 'vrfcli', 'Source2Viewer-CLI.exe')].find((f) => fs.existsSync(f)),
  cliEnv: { DOTNET_ROOT: path.join(TMP, 'dotnet') },
  log: (m) => console.log('[cs2]', m),
  shrinkImages: (files, max) => require('../cs2/png.cjs').shrinkPNGs(files, max),
});
const json = (res, code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));
const HOSTS = /^https:\/\/(community\.(akamai|cloudflare|fastly)\.steamstatic\.com|raw\.githubusercontent\.com)\//;

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/img') {
      const target = url.searchParams.get('u') || '';
      if (!HOSTS.test(target)) return res.writeHead(403).end();
      const f = path.join(IMG, crypto.createHash('sha1').update(target).digest('hex'));
      let buf;
      if (fs.existsSync(f)) buf = fs.readFileSync(f);
      else {
        const r = await fetch(target);
        if (!r.ok) return res.writeHead(r.status).end();
        buf = Buffer.from(await r.arrayBuffer());
        fs.writeFileSync(f, buf);
      }
      return res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=86400' }).end(buf);
    }
    if (url.pathname === '/api/cs2/status') return json(res, 200, cs2.status());
    if (url.pathname === '/api/cs2/sounds') {
      try { return json(res, 200, await cs2.sounds()); } catch (e) { return res.writeHead(500).end(String(e.message || e)); }
    }
    if (url.pathname === '/api/cs2/prepare') {
      try {
        return json(res, 200, await cs2.prepare({ weapon: url.searchParams.get('weapon'), paint: url.searchParams.get('paint') || null }));
      } catch (e) {
        return res.writeHead(500).end(String(e.message || e));
      }
    }
    if (url.pathname === '/api/cs2/vanity-maps') {
      try { return json(res, 200, cs2.vanityMaps()); } catch (e) { return res.writeHead(500).end(String(e.message || e)); }
    }
    if (url.pathname === '/api/cs2/glove-clip') {
      try { return json(res, 200, await cs2.gloveClip()); } catch (e) { return res.writeHead(500).end(String(e.message || e)); }
    }
    if (url.pathname === '/api/cs2/first-person') {
      try { return json(res, 200, await cs2.firstPerson(url.searchParams.get('weapon'))); } catch (e) { return res.writeHead(500).end(String(e.message || e)); }
    }
    if (url.pathname === '/api/cs2/crate') {
      try { return json(res, 200, await cs2.crate(url.searchParams.get('id'))); } catch (e) { return res.writeHead(500).end(String(e.message || e)); }
    }
    if (url.pathname === '/api/cs2/vanity') {
      try { return json(res, 200, await cs2.vanity(url.searchParams.get('id'))); } catch (e) { return res.writeHead(500).end(String(e.message || e)); }
    }
    if (url.pathname === '/api/cs2/play') {
      const calls = { maps: () => cs2.playMaps(), map: (a) => cs2.playMap(a), progress: (a) => cs2.playProgress(a), weapon: (a) => cs2.playWeapon(a),
        agent: (a) => cs2.playAgent(a), anims: (a) => cs2.playAnims(a), sounds: (a) => cs2.playSounds(a), agentModel: (a) => cs2.agentModel(a), stats: () => cs2.playStats(), voices: () => cs2.playVoices() };
      const fn = url.searchParams.get('fn');
      if (!Object.hasOwn(calls, fn)) return res.writeHead(400).end('Unknown play call');
      try { return json(res, 200, await calls[fn](JSON.parse(url.searchParams.get('arg') || 'null'))); } catch (e) { return res.writeHead(500).end(String(e.message || e)); }
    }
    if (url.pathname === '/api/cs2/sticker') {
      try { return json(res, 200, await cs2.sticker(url.searchParams.get('material'))); } catch (e) { return res.writeHead(500).end(String(e.message || e)); }
    }
    if (url.pathname.startsWith('/cs2cache/')) {
      const f = path.normalize(path.join(CS2_CACHE, decodeURIComponent(url.pathname.slice('/cs2cache/'.length))));
      if (!f.startsWith(CS2_CACHE) || !fs.existsSync(f)) return res.writeHead(404).end();
      res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'max-age=3600' });
      return fs.createReadStream(f).pipe(res);
    }
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.normalize(path.join(SRC, rel));
    if (!file.startsWith(SRC) || !fs.existsSync(file)) return res.writeHead(404).end('not found');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
}).listen(PORT, () => console.log(`dev server on http://localhost:${PORT}`));
