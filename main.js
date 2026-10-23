const { app, BrowserWindow, protocol, net, ipcMain, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const pricing = require('./shared/pricing.cjs');
const { CS2Service } = require('./cs2/service.cjs');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const SRC = path.join(__dirname, 'src');
const BUNDLED_DATA = path.join(SRC, 'data', 'game-data.json');
const IMAGE_HOSTS = /^https:\/\/(community\.(akamai|cloudflare|fastly)\.steamstatic\.com|steamcommunity-a\.akamaihd\.net|raw\.githubusercontent\.com)\//;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.woff2': 'font/woff2',
  '.gltf': 'model/gltf+json', '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream', '.exr': 'image/x-exr',
};

let userDir, imgDir, savePath, refreshedDataPath, cs2Cache, cs2;

function initPaths() {
  userDir = app.getPath('userData');
  imgDir = path.join(userDir, 'imgcache');
  savePath = path.join(userDir, 'save.json');
  refreshedDataPath = path.join(userDir, 'game-data.refreshed.json');
  fs.mkdirSync(imgDir, { recursive: true });
  // Real CS2 models: extracted on demand from the player's own CS2 install with the bundled
  // Source 2 Viewer CLI, cached under userData. Nothing from the game ships with the app.
  cs2Cache = path.join(userDir, 'cs2cache');
  const cli = app.isPackaged
    ? path.join(process.resourcesPath, 's2v', 'Source2Viewer-CLI.exe')
    : process.env.CS2SIM_CLI || path.join(__dirname, 'tools', 's2v', 'Source2Viewer-CLI.exe');
  cs2 = new CS2Service({ cacheDir: cs2Cache, cliPath: cli, log: (m) => console.log('[cs2]', m), shrinkImages });
}

// Play mode calls from the renderer (one channel, whitelisted).
const PLAY_CALLS = {
  maps: () => cs2.playMaps(), mapImages: () => cs2.playMapImages(), map: (id) => cs2.playMap(id), progress: (key) => cs2.playProgress(key), weapon: (id) => cs2.playWeapon(id),
  agent: (vmdl) => cs2.playAgent(vmdl), anims: (list) => cs2.playAnims(list), sounds: (events) => cs2.playSounds(events),
  agentModel: (id) => cs2.agentModel(id), stats: () => cs2.playStats(), voices: () => cs2.playVoices(), icons: () => cs2.playIcons(),
  ranks: () => cs2.playRanks(),
};
function playCall(fn, arg) {
  if (!Object.hasOwn(PLAY_CALLS, fn)) throw new Error('Unknown play call ' + fn);
  return PLAY_CALLS[fn](arg);
}

// Shrinks PNGs in place (inspect backdrop textures are drawn blurred, so 512px is plenty) with cs2/png.cjs on a worker
// thread: it keeps every channel as it is (Electron's resizer premultiplies alpha, which blacks out the colour of
// textures that keep a mask in alpha). The worker gets png.cjs's source, as it can't load scripts from the app's asar.
let shrinkWorker = null, shrinkJobs = 0;
const shrinkWaiting = new Map();
function shrinkImages(files, max) {
  if (!files.length) return Promise.resolve();
  if (!shrinkWorker) {
    const { Worker } = require('node:worker_threads');
    const src = fs.readFileSync(path.join(__dirname, 'cs2', 'png.cjs'), 'utf8');
    shrinkWorker = new Worker(`const module = { exports: {} };\n${src}\nconst { parentPort } = require('node:worker_threads');
parentPort.on('message', ({ id, files, max }) => module.exports.shrinkPNGs(files, max).then(() => parentPort.postMessage(id), () => parentPort.postMessage(id)));`, { eval: true });
    shrinkWorker.on('message', (id) => { shrinkWaiting.get(id)?.(); shrinkWaiting.delete(id); });
    shrinkWorker.on('error', (e) => { console.warn('[shrink]', e); for (const done of shrinkWaiting.values()) done(); shrinkWaiting.clear(); shrinkWorker = null; });
    shrinkWorker.unref();
  }
  const id = ++shrinkJobs;
  return new Promise((resolve) => { shrinkWaiting.set(id, resolve); shrinkWorker.postMessage({ id, files, max }); });
}

const inflight = new Map();
async function handleImage(url) {
  const target = url.searchParams.get('u') || '';
  if (!IMAGE_HOSTS.test(target)) return new Response('forbidden', { status: 403 });
  const file = path.join(imgDir, crypto.createHash('sha1').update(target).digest('hex'));
  const headers = { 'content-type': 'image/png', 'cache-control': 'max-age=31536000' };
  try {
    return new Response(await fs.promises.readFile(file), { headers });
  } catch {}
  // Coalesce concurrent requests for the same image.
  let job = inflight.get(file);
  if (!job) {
    job = (async () => {
      const res = await net.fetch(target);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await fs.promises.writeFile(file, buf).catch(() => {});
      return buf;
    })().finally(() => inflight.delete(file));
    inflight.set(file, job);
  }
  try {
    return new Response(await job, { headers });
  } catch (e) {
    return new Response(String(e.message), { status: 502 });
  }
}

function readRefreshedData() {
  // Only use refreshed prices if they were computed on top of this exact bundled data build.
  try {
    const bundledStamp = JSON.parse(fs.readFileSync(BUNDLED_DATA, 'utf8')).generatedAt;
    const txt = fs.readFileSync(refreshedDataPath, 'utf8');
    if (JSON.parse(txt).generatedAt === bundledStamp) return txt;
  } catch {}
  return null;
}

async function handleApp(req) {
  const url = new URL(req.url);
  if (url.pathname === '/img') return handleImage(url);
  if (url.pathname.startsWith('/cs2cache/')) {
    const f = path.normalize(path.join(cs2Cache, decodeURIComponent(url.pathname.slice('/cs2cache/'.length))));
    if (!f.startsWith(cs2Cache)) return new Response('forbidden', { status: 403 });
    try {
      return new Response(await fs.promises.readFile(f), { headers: { 'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  }
  if (url.pathname === '/data/game-data.json') {
    const refreshed = readRefreshedData();
    if (refreshed) return new Response(refreshed, { headers: { 'content-type': MIME['.json'] } });
  }
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  const file = path.normalize(path.join(SRC, rel));
  if (!file.startsWith(SRC)) return new Response('forbidden', { status: 403 });
  try {
    const body = await fs.promises.readFile(file);
    return new Response(body, { headers: { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' } });
  } catch {
    return new Response('not found', { status: 404 });
  }
}

function writeSaveAtomic(text) {
  const tmp = savePath + '.tmp';
  fs.writeFileSync(tmp, text);
  if (fs.existsSync(savePath)) fs.copyFileSync(savePath, savePath + '.bak');
  fs.renameSync(tmp, savePath);
}

function registerIpc() {
  ipcMain.handle('save:load', () => {
    for (const f of [savePath, savePath + '.bak']) {
      try {
        const txt = fs.readFileSync(f, 'utf8');
        JSON.parse(txt);
        return txt;
      } catch {}
    }
    return null;
  });
  ipcMain.handle('save:write', (_e, text) => { writeSaveAtomic(text); return true; });
  ipcMain.on('save:writeSync', (e, text) => {
    try { writeSaveAtomic(text); e.returnValue = true; } catch { e.returnValue = false; }
  });
  ipcMain.handle('save:delete', () => {
    for (const f of [savePath, savePath + '.bak']) fs.rmSync(f, { force: true });
    return true;
  });

  ipcMain.handle('prices:refresh', async (e) => {
    const send = (m) => e.sender.send('prices:progress', m);
    const data = JSON.parse(fs.readFileSync(BUNDLED_DATA, 'utf8'));
    const raw = await pricing.fetchSources((u, o) => net.fetch(u, o), send);
    const ok = Object.values(raw).filter(Boolean).length;
    if (!ok) throw new Error('Could not reach any marketplace. Check your internet connection.');
    send('Calculating prices...');
    const counts = pricing.applyPrices(data, pricing.buildIndex(raw));
    fs.writeFileSync(refreshedDataPath, JSON.stringify(data));
    return { ...counts, sources: Object.keys(raw).filter((k) => raw[k]) };
  });
  ipcMain.handle('prices:reset', () => { fs.rmSync(refreshedDataPath, { force: true }); return true; });

  ipcMain.handle('cs2:status', () => cs2.status());
  ipcMain.handle('cs2:prepare', (_e, req) => cs2.prepare(req));
  ipcMain.handle('cs2:sounds', () => cs2.sounds());
  ipcMain.handle('cs2:sticker', (_e, material) => cs2.sticker(material));
  ipcMain.handle('cs2:vanityMaps', () => cs2.vanityMaps());
  ipcMain.handle('cs2:vanity', (_e, id) => cs2.vanity(id));
  ipcMain.handle('cs2:gloveClip', () => cs2.gloveClip());
  ipcMain.handle('cs2:firstPerson', (_e, weapon) => cs2.firstPerson(weapon));
  ipcMain.handle('cs2:statTrak', (_e, weapon) => cs2.statTrak(weapon));
  ipcMain.handle('cs2:crate', (_e, id) => cs2.crate(id));
  ipcMain.handle('cs2:play', (_e, fn, arg) => playCall(fn, arg));
  ipcMain.handle('cs2:clear', () => {
    fs.rmSync(cs2Cache, { recursive: true, force: true });
    cs2 = new CS2Service({ cacheDir: cs2Cache, cliPath: cs2.cliPath, log: (m) => console.log('[cs2]', m), shrinkImages });
    return true;
  });

  ipcMain.handle('app:openExternal', (_e, u) => {
    if (/^https:\/\//.test(u)) shell.openExternal(u);
  });
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), userData: userDir, electron: process.versions.electron }));
  ipcMain.handle('app:clearImageCache', () => {
    fs.rmSync(imgDir, { recursive: true, force: true });
    fs.mkdirSync(imgDir, { recursive: true });
    return true;
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1180,
    minHeight: 720,
    backgroundColor: '#0a0d12',
    title: 'CS2 Case Simulator',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    // Smoke runs keep animating while the window is covered by other windows (they capture animations).
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: !SMOKE },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12') win.webContents.toggleDevTools();
    if (input.key === 'F11') win.setFullScreen(!win.isFullScreen());
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadURL('app://game/index.html');
  if (SMOKE) runSmokeTest(win);
}

// `CS2SIM_SMOKE=1 electron .` loads the game hidden, opens a case preview in 3D, screenshots it and quits.
const SMOKE = !!process.env.CS2SIM_SMOKE;
if (SMOKE) app.setPath('userData', path.join(app.getPath('temp'), 'cs2sim-smoke'));

// `CS2SIM_SMOKE=features`: opens a souvenir package and a player pack, plays a bot battle and a team match, signs
// a trade-up, then screenshots every page into userData/smoke-<page>.png.
async function runFeatureSmoke(win) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  // Wait for a fresh frame before capturing (capturePage can return the previous one).
  const shot = async (name) => {
    win.webContents.invalidate();
    await js('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    await wait(400);
    fs.writeFileSync(path.join(app.getPath('userData'), `smoke-${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  await wait(3500);
  const log = await js(`(async () => {
    const out = [];
    const { act } = await import('./js/backend.js'); const st = await import('./js/state.js'); const { D } = await import('./js/data.js');
    const I = await import('./js/items.js'); const M = await import('./js/engine/manager.js');
    st.S.money = 100000; st.S.settings.fast = true;
    const sv = D.cases.find((c) => /Cologne 2014 Cobblestone Souvenir/.test(c.n));
    const r1 = await act('case.open', { id: sv.id, n: 3 }); out.push('souvenir: ' + r1.items.map((i) => I.itemName(i) + ' [' + i.stk.length + ' stickers]').join(', '));
    for (let i = 0; i < 3; i++) await act('team.pack', { pack: 'premium' });
    out.push('pro cards: ' + st.S.inv.filter((i) => i.t === 'pro').length);
    const box = D.cases.find((c) => c.n === 'Chroma 2 Case');
    const b = await act('gamble.battle', { cases: [box.id, box.id], format: '2v2', mode: 'normal', clientSeed: 'smoke' });
    out.push('battle: ' + (b.won ? 'won ' + b.prize.length + ' items' : 'lost') + ', totals ' + b.teamTotals.join(' vs '));
    for (let i = 0; i < 3; i++) await act('case.open', { id: box.id, n: 10 });
    const mil = st.S.inv.filter((it) => it.t === 'skin' && D.skins[it.id].r === 2 && !it.stt && !it.sv).slice(0, 10);
    if (mil.length === 10) { const t = await act('tradeup.sign', { uids: mil.map((i) => i.uid) }); out.push('trade-up: ' + I.itemName(t.item)); }
    return out.join('\\n');
  })()`);
  console.log('SMOKE features\n' + log);
  // CS2SIM_SMOKE_SERVER=http://localhost:8787 also checks online play: create an account, connect, open a case.
  if (process.env.CS2SIM_SMOKE_SERVER) {
    const online = await js(`(async () => {
      const { net } = await import('./js/net/online.js'); const { act } = await import('./js/backend.js'); const { D } = await import('./js/data.js');
      net.setServerUrl(${JSON.stringify(process.env.CS2SIM_SMOKE_SERVER)});
      try {
        await net.login('smoke' + Math.floor(Math.random() * 1e6), 'smoke-pass-1', { register: true });
        const box = D.cases.filter((c) => c.kind === 'case').sort((a, b) => a.price - b.price)[0];
        const r = await act('case.open', { id: box.id, n: 1 });
        const out = 'online as ' + net.me().name + ', opened ' + r.items.length + ' item(s) on the server';
        net.logout();
        return out;
      } catch (e) { return 'online FAILED: ' + e.message; }
    })()`);
    console.log('SMOKE', online);
  }
  for (const page of ['cases', 'inventory', 'tradeup', 'armory', 'gamble', 'team', 'stats']) {
    await js(`document.querySelector('#nav [data-page=${page}]').click()`);
    await wait(page === 'team' ? 600 : 1500);
    if (page === 'team') { await js(`document.querySelector('[data-auto]')?.click()`); await wait(1500); }
    await shot(page);
  }
  await js(`document.querySelector('#nav [data-page=cases]').click(); (async () => { const c = await import('./js/pages/cases.js'); c.openCollectionView('collection-set-cobblestone'); })()`);
  await wait(1500);
  await shot('collection');
  console.log('SMOKE screenshots saved to', app.getPath('userData'));
  app.quit();
}

// `CS2SIM_SMOKE=crate` opens a case (CS2SIM_SMOKE_CASE, default the CS:GO Weapon Case) through the cases page and
// captures the drop/unlock intro, the roulette and the results.
async function runCrateSmoke(win) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => fs.writeFileSync(path.join(app.getPath('userData'), `crate-${name}.png`), (await win.webContents.capturePage()).toPNG());
  await wait(4000);
  const id = process.env.CS2SIM_SMOKE_CASE || 'crate-4001';
  // Export the crate first (the intro only waits a moment for a first-time export).
  const t = Date.now();
  console.log('SMOKE crate', JSON.stringify(await js(`window.native.cs2Crate(${JSON.stringify(id.replace(/^crate-/, ''))})`)), ((Date.now() - t) / 1000).toFixed(1) + 's');
  await js(`(async () => { const { S } = await import('./js/state.js'); S.money += 1000; const c = await import('./js/pages/cases.js');
    document.querySelector('#nav [data-page=cases]').click(); c.openCaseView(${JSON.stringify(id)}); })()`);
  await wait(800);
  await shot('page');
  const t0 = Date.now();
  await js(`document.querySelector('[data-open]').click()`);
  for (const ms of [500, 900, 1300, 1800, 2400, 3000, 3600, 4200, 5000, 12500]) {
    await wait(ms - (Date.now() - t0));
    await shot(String(ms).padStart(5, '0'));
    console.log('SMOKE', ms, await js(`JSON.stringify({ stage: document.querySelector('.crate-stage')?.className ?? null, canvas: !!document.querySelector('.crate-stage canvas'), strips: !!document.querySelector('.opening:not(.intro) .strips') })`));
  }
  console.log('SMOKE results', await js(`JSON.stringify({ results: document.querySelectorAll('.result').length, opening: !!document.querySelector('.opening') })`));
  console.log('SMOKE screenshots saved to', app.getPath('userData'));
  app.quit();
}

// `CS2SIM_SMOKE=play` starts a Play match on Dust II (exporting the map on first use), looks at a bot, shoots it and
// screenshots the view into userData/play-*.png.
async function runPlaySmoke(win) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => fs.writeFileSync(path.join(app.getPath('userData'), `play-${name}.png`), (await win.webContents.capturePage()).toPNG());
  await wait(4000);
  // A StatTrak™ AK-47 with 41 kills in the loadout: its counter in the 3D inspect (a close-up of it in play-stattrak-inspect.png),
  // then a kill with it in the match (below).
  console.log('SMOKE play stattrak inspect', await js(`(async () => { try {
    const THREE = await import('three'), { S } = await import('./js/state.js'), I = await import('./js/items.js'), { D } = await import('./js/data.js'), { act } = await import('./js/backend.js');
    const ui = await import('./js/ui.js'), { inspectView } = await import('./js/inspect.js');
    const it = I.makeSkinItem(Object.values(D.skins).find((s) => s.wid === 'weapon_ak47' && /Redline/.test(s.n)), { stt: true, fl: 0.1, sd: 5 });
    it.uid = 'smoke-st'; it.kills = 41; S.inv.unshift(it); await act('loadout.equip', { uid: it.uid });
    ui.openInspect(it);
    for (let i = 0; i < 240 && document.querySelector('.inspect .loading'); i++) await new Promise((r) => setTimeout(r, 250));
    const st = inspectView.state; st.anim = null; st.yaw = 0; st.pitch = 0; st.vy = st.vp = 0; st.lastInput = performance.now() + 1e9;
    await new Promise((r) => setTimeout(r, 500));
    let counter = null; inspectView.scene.traverse((o) => { if (o.name === 'stattrak') counter = o; });
    if (!counter) return 'no counter on the model';
    const p = counter.getWorldPosition(new THREE.Vector3()), W = 640, H = 360, cam = new THREE.PerspectiveCamera(6, W / H, 0.01, 100);
    cam.position.copy(inspectView.camera.position); cam.lookAt(p);
    const r = inspectView.renderer, rt = new THREE.WebGLRenderTarget(W, H, { colorSpace: THREE.SRGBColorSpace, samples: 4 });
    r.setRenderTarget(rt); r.render(inspectView.scene, cam); r.setRenderTarget(null);
    const px = new Uint8Array(W * H * 4); r.readRenderTargetPixels(rt, 0, 0, W, H, px); rt.dispose();
    const c = document.createElement('canvas'); c.id = 'smoke-closeup'; c.width = W; c.height = H; c.style.cssText = 'position:fixed;left:0;top:0;z-index:99999';
    const ctx = c.getContext('2d'), img = ctx.createImageData(W, H);
    for (let y = 0; y < H; y++) img.data.set(px.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
    ctx.putImageData(img, 0, 0); document.body.appendChild(c);
    return 'counter on ' + counter.parent.name + ', ' + it.kills + ' kills';
  } catch (e) { return 'failed: ' + e.message; } })()`));
  await wait(800);
  await shot('stattrak-inspect');
  await js(`document.getElementById('smoke-closeup')?.remove(); document.querySelector('.inspect [data-a=close]')?.click(); 1`);
  await wait(500);
  const t0 = Date.now();
  await js(`window.__cs2Debug = true; document.querySelector('#nav [data-page=play]').click(); setTimeout(() => document.querySelector('[data-start]').click(), 300); 1`);
  let last = '';
  for (let i = 0; i < 900; i++) {
    await wait(1000);
    const r = JSON.parse(await js(`JSON.stringify({ started: !!window.__playGame?.raf, status: document.querySelector('[data-status]')?.textContent || '', root: !!document.querySelector('.play-root'), toast: document.querySelector('#toasts')?.textContent || '' })`));
    if (r.status !== last) { console.log('SMOKE play', ((Date.now() - t0) / 1000).toFixed(0) + 's', r.status); last = r.status; }
    if (r.started || !r.root) { if (!r.started) console.log('SMOKE play failed', r.toast); break; }
  }
  console.log('SMOKE play loaded in', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  // Skip the freeze time and let the round play for a while in real time.
  const state = () => js(`(() => { const g = window.__playGame; if (!g) return 'no game'; const m = g.match;
    return JSON.stringify({ round: m.round, phase: m.phase, time: Math.round(m.time), score: m.score, fps: Math.round(g.fps || 0), bomb: m.bomb?.state,
      alive: g.combatants.filter((c) => c.alive).map((c) => c.team[0]).join(''), feed: document.querySelector('.feed')?.innerText.split(String.fromCharCode(10)).join(' | ') }); })()`);
  // The bots standing still: on the floor and not turning round, idle in spawn through a 30 s freeze time, then for 35 s
  // of the round (bots holding angles), with you in god mode and the bots not shooting. Their torsos too: upright, and
  // twisted from the legs only as far as their aim is (the chest's offset from the aim stays put, frame after frame).
  await js(`(() => { const g = window.__playGame; document.querySelector('.play-pause').classList.add('hidden'); g.paused = false; g.input.locked = true;
    g.god = true; g.cv.bot_dont_shoot = 1; g.match.time = 31;
    const wrap = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
    const mates = g.bots.filter((b) => b.c.team === g.me.team), c = [0, 1].map((k) => mates.reduce((s, b) => s + b.pos[k], 0) / Math.max(1, mates.length));
    const o = g.player.origin; g.input.yaw = Math.atan2(c[1] - o[1], c[0] - o[0]) * 180 / Math.PI; g.input.pitch = 8;
    const rec = window.__stillRec = { gap: 0, freezeSec: 0, freezeAim: 0, freezeBody: 0, stillSec: 0, stillAim: 0, stillBody: 0, maxStillBodyRate: 0, stillTurningFrames: 0, stillFrames: 0, torso: {}, maxTwist: 0, rootTilt: 0 };
    const last = new Map(g.bots.map((b) => [b, [b.yaw, b.bodyYaw]]));
    g.on((type, dt) => { if (type !== 'frame' || !dt) return;
      for (const b of g.bots) { if (!b.c.alive) continue;
        const [ly, lb] = last.get(b), da = Math.abs(wrap(b.yaw - ly)), db = Math.abs(wrap(b.bodyYaw - lb)); last.set(b, [b.yaw, b.bodyYaw]);
        if (g.match.phase === 'freeze') { rec.freezeSec += dt; rec.freezeAim += da; rec.freezeBody += db; const f = g.floorAt(b.pos, 300); if (f != null) rec.gap = Math.max(rec.gap, Math.abs(b.pos[2] - f)); }
        else if (Math.hypot(b.vel[0], b.vel[1]) < 20 && !b.airborne && !b.brain.target?.visible) {
          rec.stillSec += dt; rec.stillAim += da; rec.stillBody += db; rec.stillFrames++; if (da > 0.05) rec.stillTurningFrames++;
          rec.maxStillBodyRate = Math.max(rec.maxStillBodyRate, db / dt);
        }
        const L = b.root.visible && b.bonePos('arm_upper_L'), R = L && b.bonePos('arm_upper_R');
        if (R) {
          const twist = wrap(Math.atan2(R[1] - L[1], R[0] - L[0]) * 180 / Math.PI + 90 - b.bodyYaw), dev = wrap(twist - Math.max(-60, Math.min(60, wrap(b.yaw - b.bodyYaw))));
          const t = rec.torso[b.index] ||= { min: 1e9, max: -1e9 };
          if (g.match.phase === 'freeze') { t.min = Math.min(t.min, dev); t.max = Math.max(t.max, dev); }
          rec.maxTwist = Math.max(rec.maxTwist, Math.abs(twist));
          rec.rootTilt = Math.max(rec.rootTilt, Math.abs(b.root.rotation.x), Math.abs(b.root.rotation.z));
        } } }); })()`);
  await wait(3000);
  await shot('spawn');
  await wait(22000);
  await shot('spawn-25s'); // the torsos 25 s on (a twist left adding up would have turned them round by now)
  await wait(7000);
  await wait(35000);
  console.log('SMOKE play standing still', await js(`(() => { const r = window.__stillRec, g = window.__playGame; g.god = false; g.cv.bot_dont_shoot = 0;
    return JSON.stringify({ floorGap: Math.round(r.gap * 10) / 10,
      freeze: { botSeconds: Math.round(r.freezeSec), aimDegPerSec: Math.round((r.freezeAim / Math.max(1, r.freezeSec)) * 100) / 100, bodyDegPerSec: Math.round((r.freezeBody / Math.max(1, r.freezeSec)) * 100) / 100 },
      holding: { botSeconds: Math.round(r.stillSec), aimDegPerSec: Math.round((r.stillAim / Math.max(1, r.stillSec)) * 100) / 100, bodyDegPerSec: Math.round((r.stillBody / Math.max(1, r.stillSec)) * 100) / 100,
        turningPct: Math.round((r.stillTurningFrames / Math.max(1, r.stillFrames)) * 100), maxBodyDegPerSec: Math.round(r.maxStillBodyRate) },
      torso: { freezeDriftDeg: Math.round(Math.max(0, ...Object.values(r.torso).filter((t) => t.max >= t.min).map((t) => t.max - t.min))), maxTwistDeg: Math.round(r.maxTwist), rootTiltDeg: Math.round(r.rootTilt * 180 / Math.PI * 10) / 10 } }); })()`));
  // Stickers on the magazine come out with it: an AK-47 with one on the mag and one on the receiver, a third into a reload.
  console.log('SMOKE play mag sticker', await js(`(async () => { try {
    const THREE = await import('three'), { D } = await import('./js/data.js'), { buildViewmodel } = await import('./js/play/viewmodel.js'), { cs2Play } = await import('./js/cs2/api.js');
    const g = window.__playGame, def = Object.values(D.skins).find((s) => s.wid === 'weapon_ak47' && /Redline/.test(s.n)), st = Object.values(D.stickers)[0];
    const item = { t: 'skin', id: def.id, fl: 0.1, sd: 1, uid: 'smoke-mag', stk: [{ id: st.id, x: 0.55, y: 0.7, s: 0.6, r: 0, slot: 0 }, { id: st.id, x: 0.3, y: 0.55, s: 0.6, r: 0, slot: 1 }] };
    const vm = await buildViewmodel(item, def, await cs2Play('weapon', 'weapon_ak47'), { renderer: g.renderer });
    const decals = []; vm.rig.traverse((o) => { if (o.isMesh && o.renderOrder === 2 && o.parent?.isBone) decals.push(o); });
    const at = (o) => { o.updateWorldMatrix(true, false); o.geometry.computeBoundingBox(); return o.geometry.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(o.matrixWorld); };
    const before = decals.map(at), len = vm.play('reload');
    for (let t = 0; t < len * 0.35; t += 1 / 60) vm.update(1 / 60);
    const res = decals.map((d, i) => d.parent.name + ' moved ' + Math.round(at(d).distanceTo(before[i]) * 1000) + 'mm').join(', ');
    vm.dispose();
    return res;
  } catch (e) { return 'failed: ' + e.message; } })()`));
  // CS2's special inspects (the Deagle's spin, the Falchion's and Skeleton's): how far the weapon turns in each.
  console.log('SMOKE play special inspects', await js(`(async () => { try {
    const THREE = await import('three'), { buildViewmodel } = await import('./js/play/viewmodel.js'), { cs2Play } = await import('./js/cs2/api.js');
    const g = window.__playGame, out = {};
    for (const wid of ['weapon_deagle', 'weapon_knife_falchion', 'weapon_knife_skeleton']) {
      const vm = await buildViewmodel({ t: 'skin', fl: 0, sd: 0 }, { wid, w: wid, n: wid, cat: /knife/.test(wid) ? 'knife' : 'pistol', v: true }, await cs2Play('weapon', wid), { renderer: g.renderer });
      const turn = (role) => { const len = vm.play(role, { fade: 0 }); vm.update(0); const b = vm.bones.weapon_offset; let prev = b.getWorldQuaternion(new THREE.Quaternion()), total = 0;
        for (let t = 0; t < len; t += 1 / 30) { vm.update(1 / 30); const q = b.getWorldQuaternion(new THREE.Quaternion()); total += (prev.angleTo(q) * 180) / Math.PI; prev = q; }
        return Math.round(len * 10) / 10 + 's ' + Math.round(total) + 'deg'; };
      out[wid.replace('weapon_', '')] = vm.has('inspectRare') ? { usual: turn('inspect'), special: turn('inspectRare') } : 'no special inspect';
      vm.dispose();
    }
    return JSON.stringify(out);
  } catch (e) { return 'failed: ' + e.message; } })()`));
  // A kill with the StatTrak™ AK-47 counts on the item and on the gun's counter (a teamkill doesn't).
  await js(`(async () => { const g = window.__playGame; await g.giveMe('primary', 'weapon_ak47'); g.input.pressed.add('slot1'); })()`);
  await wait(1500);
  console.log('SMOKE play stattrak kill', await js(`(async () => { try {
    const g = window.__playGame, { S } = await import('./js/state.js'), kills = () => S.inv.find((i) => i.uid === 'smoke-st')?.kills;
    const gun = g.arsenal.gun, before = kills();
    const enemy = g.combatants.find((c) => c.alive && c.team !== g.me.team), mate = g.combatants.find((c) => c.alive && c !== g.me && c.team === g.me.team);
    g.kill(enemy, g.me, gun, true);
    if (mate) g.kill(mate, g.me, gun, false);
    await new Promise((r) => setTimeout(r, 600));
    let display = 'none';
    gun.vm.rig.traverse((o) => { const src = o.geometry?.userData.uv0; if (!src) return; const uv = o.geometry.attributes.uv, cell = {};
      for (let i = 0; i < uv.count; i++) cell[Math.floor(src[i * 2])] = Math.floor(uv.getX(i) / 0.0625 + 0.01);
      display = [1, 2, 3, 4, 5, 6].map((k) => (cell[k] ? cell[k] - 1 : '.')).join(''); });
    return JSON.stringify({ gun: gun.id, before, after: kills(), display });
  } catch (e) { return 'failed: ' + e.message; } })()`));
  await shot('stattrak-play');
  // Dust II's soccer ball: walked into (you can't walk through it at a wall), shot, a grenade off it and an HE next to
  // it; it's back on its spot next round (see round 2 below). A screenshot of it in play-ball.png.
  console.log('SMOKE play soccer ball', await js(`(async () => { try {
    const g = window.__playGame, b = g.balls.list[0];
    if (!b) return 'no ball on this map';
    const god = g.god, stop = g.cv.bot_stop; g.god = true; g.cv.bot_stop = 1; // the bots wait (the round mustn't end meanwhile)
    const rel = () => b.pos.map((v, k) => Math.round(v - b.spawn[k]));
    const speed = () => Math.round(Math.hypot(...b.vel));
    const stand = (dx, dy = 0) => { g.player.origin = [b.spawn[0] + dx, b.spawn[1] + dy, b.spawn[2] - b.radius - 0.05]; g.player.velocity = [0, 0, 0]; g.input.yaw = 0; g.input.pitch = 0; };
    const out = {};
    if (!g.me.alive) { g.me.alive = true; g.me.health = 100; g.deathCam = null; } // shot by then: back on your feet to walk
    g.balls.reset(); stand(-70);
    g.input.keys.add('KeyW');
    let kicked = 0;
    for (let i = 0; i < 192; i++) { g.tick(); kicked = Math.max(kicked, speed()); }
    g.input.keys.delete('KeyW');
    out.walk = { kickedTo: kicked, ballAt: rel(), youAt: Math.round(g.player.origin[0] - b.spawn[0]), gap: Math.round(b.pos[0] - g.player.origin[0]) };
    g.balls.reset(); stand(-200);
    const eye = g.player.eye(), d = b.pos.map((v, k) => v - eye[k]), l = Math.hypot(...d);
    g.fireBullet(g.me, eye, d.map((v) => v / l), g.arsenal.gun);
    const shotSpeed = speed();
    for (let i = 0; i < 64; i++) g.tick();
    out.shot = { gun: g.arsenal.gun.id, speed: shotSpeed, after1s: rel() };
    g.balls.reset();
    const n = g.nades.throw(g.me, 'weapon_decoy', [b.spawn[0] - 120, b.spawn[1], b.spawn[2] + 2], [700, 0, 40]);
    let nade = null;
    for (let i = 0; i < 30 && !nade; i++) { g.tick(); if (!b.asleep) nade = { ball: speed(), decoy: Math.round(Math.hypot(...n.vel)) }; }
    out.grenade = nade || 'missed';
    g.balls.reset();
    g.nades.explodeHE({ pos: [b.spawn[0] - 60, b.spawn[1] + 20, b.spawn[2] - 4], c: g.me, id: 'weapon_hegrenade', info: { name: 'HE Grenade' } });
    out.he = { speed: speed() };
    for (let i = 0; i < 64; i++) g.tick();
    out.he.after1s = rel();
    stand(-90, -30);
    const e2 = g.player.eye();
    g.input.yaw = Math.atan2(b.pos[1] - e2[1], b.pos[0] - e2[0]) * 180 / Math.PI;
    g.input.pitch = Math.atan2(e2[2] - b.pos[2], Math.hypot(b.pos[0] - e2[0], b.pos[1] - e2[1])) * 180 / Math.PI;
    g.god = god; g.cv.bot_stop = stop;
    out.phase = g.match.phase;
    return JSON.stringify(out);
  } catch (e) { return 'failed: ' + e.message; } })()`));
  await wait(600);
  await shot('ball');
  // The Deagle's spin in the match: bought, drawn and inspected with cl_inspect_rare 1.
  await js(`(async () => { const g = window.__playGame; g.cv.cl_inspect_rare = 1; await g.giveMe('secondary', 'weapon_deagle'); g.input.pressed.add('slot2'); })()`);
  await wait(1500);
  await js(`window.__playGame.input.pressed.add('inspect')`);
  await wait(2300);
  await shot('deagle-spin');
  console.log('SMOKE play deagle inspect', await js(`(() => { const g = window.__playGame; const r = g.arsenal.gun?.vm.role; g.cv.cl_inspect_rare = 0; return g.arsenal.gun?.id + ' ' + r; })()`));
  for (const s of [4, 8, 12]) { await wait(4000); console.log('SMOKE play t+' + s + 's', await state()); }
  await shot('live');
  // A volumetric smoke in front of you: how it looks and what it costs (same view with and without it).
  await js(`(() => { const g = window.__playGame; const eye = g.player.eye(); let best = 0, by = 0;
    for (let a = 0; a < 360; a += 10) { const d = [Math.cos(a * Math.PI / 180), Math.sin(a * Math.PI / 180), 0]; const h = g.collision.raycast(eye, d, 2000, 2); const t = h ? h.t : 2000; if (t > best) { best = t; by = a; } }
    window.__smokeDir = by; g.input.yaw = by; g.input.pitch = 3; g.me.health = 1e6; for (const b of g.bots) b.brain.tick = () => {}; })()`);
  await wait(3000);
  const fpsBefore = JSON.parse(await state()).fps;
  await js(`(() => { const g = window.__playGame, eye = g.player.eye(), yr = window.__smokeDir * Math.PI / 180;
    const p = [eye[0] + Math.cos(yr) * 350, eye[1] + Math.sin(yr) * 350, eye[2]];
    const down = g.collision.raycast(p, [0, 0, -1], 400, 2); g.nades.volume.add([p[0], p[1], p[2] - (down ? down.t : 64)]); })()`);
  await wait(5000);
  await shot('smoke');
  const fpsSmoke = JSON.parse(await state()).fps;
  await js(`window.__playGame.nades.volume.clear()`);
  await wait(3000);
  console.log('SMOKE play smoke fps', fpsBefore, '-> with smoke', fpsSmoke, '-> cleared', JSON.parse(await state()).fps, await js(`window.__playGame.renderer.domElement.width + 'x' + window.__playGame.renderer.domElement.height`));
  // Fast-forward: follow a teammate (you stand still) until the round ends.
  await js(`(() => { const g = window.__playGame; g.kill(g.me, null, { name: 'World' }, false); })()`);
  await wait(4000);
  await shot('spectate');
  console.log('SMOKE play spectate', await state());
  const ff = await js(`(() => { const g = window.__playGame, m = g.match; const r = m.round; let n = 0;
    while (m.round === r && n < 64 * 200) { g.tick(); n++; if (n % 2 === 0) for (const b of g.bots) if (b.root.visible) { b.sync(); b.animate(2 / 64); } }
    return JSON.stringify({ simSeconds: Math.round(n / 64), round: m.round, score: m.score, last: m.history[m.history.length - 1] }); })()`);
  console.log('SMOKE play round 1 result', ff);
  await wait(1500);
  await shot('round2');
  console.log('SMOKE play round 2', await state(), await js(`(() => { const b = window.__playGame.balls.list[0];
    return b ? 'ball ' + JSON.stringify({ fromSpot: Math.round(Math.hypot(...b.pos.map((v, k) => v - b.spawn[k]))), resting: b.asleep }) : ''; })()`));
  // Bots climb like players: a box on Long A, the xbox at top of Mid and the box by Mid doors take a jump (the Mid doors
  // one a crouch-jump), and over four minutes of bots playing none gets up more than a step without one.
  console.log('SMOKE play bot climbing', await js(`(() => { try {
    const g = window.__playGame, nav = g.nav, m = g.match;
    for (const b of g.bots) delete b.brain.tick; // the smoke check above switched their thinking off
    const stage = (from, to) => {
      const A = nav.findArea(from, 40), B = nav.findArea(to, 40);
      if (!A || !B) return 'no nav there';
      const b = g.bots.find((x) => x.c.alive) || g.bots[0], br = b.brain;
      const goal = B.center.slice();
      b.pos = [A.center[0], A.center[1], g.floorAt(A.center, 64) ?? A.center[2]]; b.vel = [0, 0, 0]; b.jumped = false; b.tuck = 0; b.climbing = null;
      br.target = null; br.task = 'goto'; br.goTo(goal);
      let jumps = 0, crouch = 0, walkUps = 0, was = false, z = b.pos[2], vz = 0;
      for (let i = 0; i < 5 * 64; i++) {
        g.now += 1 / 64; br.move(1 / 64, g.now, true);
        if (b.jumped && !was) { jumps++; if (b.tuck) crouch++; }
        was = !!b.jumped;
        if (vz === 0 && b.vel[2] === 0 && b.pos[2] - z > 18.5) walkUps++;
        z = b.pos[2]; vz = b.vel[2];
      }
      const onTop = Math.hypot(b.pos[0] - goal[0], b.pos[1] - goal[1]) < 48 && Math.abs(b.pos[2] - goal[2]) < 20;
      return { rise: Math.round(goal[2] - A.center[2]), jumps, crouch, walkUps, onTop };
    };
    const out = { longBox: stage([1547, 2040, -10], [1647, 2071, 55]), xbox: stage([-208, 491, -2], [-233, 550, 47]), midDoorsBox: stage([-311, 1436, -28], [-247, 1332, 36]) };
    const rec = { simSeconds: 240, walkUps: 0, jumps: 0, falls: 0, rounds: [] }, prev = new Map();
    for (let n = 0; n < 240 * 64; n++) {
      const r0 = m.round, ph0 = m.phase;
      for (const b of g.bots) prev.set(b, { z: b.pos[2], vz: b.vel[2], j: !!b.jumped, alive: b.c.alive });
      g.tick();
      const fresh = m.round !== r0 || (ph0 !== m.phase && m.phase === 'freeze');
      for (const b of g.bots) {
        const p = prev.get(b);
        if (fresh || !b.c.alive || !p.alive) continue;
        if (!b.climbing && p.vz === 0 && b.vel[2] === 0 && b.pos[2] - p.z > 18.5) rec.walkUps++;
        if (b.jumped && !p.j) rec.jumps++;
        if (b.vel[2] < -1500 && p.vz >= -1500) rec.falls++;
      }
      if (m.round !== r0) { const h = m.history[m.history.length - 1]; rec.rounds.push(h.winner + ':' + h.reason); }
      if (g.me.alive && m.phase === 'live') g.kill(g.me, null, { name: 'World' }, false);
    }
    out.playing = rec;
    return JSON.stringify(out);
  } catch (e) { return 'failed: ' + e.message; } })()`));
  // CS:GO ranks: the 10th competitive win reveals your rank on the end screen (play-rank.png), a later win ranks you up,
  // the scoreboard shows everyone's, and so does the lobby afterwards (play-lobby-rank.png).
  console.log('SMOKE play rank', await js(`(async () => { try {
    const g = window.__playGame, { S } = await import('./js/state.js'), { act } = await import('./js/backend.js');
    S.rank = { mmr: 1190, group: 0, wins: 9, losses: 3, ties: 1, lastWin: Date.now() };
    g.match.score.A = 9; g.match.score.B = 4;
    g.onMatchOver('A');
    await new Promise((r) => setTimeout(r, 1500));
    const box = document.querySelector('.play-hud [data-rank]');
    const shown = box?.innerText.replace(/\\s+/g, ' '), art = !!box?.querySelector('img.rank-emblem'), flag = !!box?.querySelector('img.flag');
    const placed = S.rank.group;
    S.rank.group = Math.max(1, placed - 2); // as if it had dropped: the next win takes it up a group
    const up = await act('play.rank', { result: 'win', roundsFor: 13, roundsAgainst: 5, difficulty: 'hard' });
    return JSON.stringify({ shown, emblem: art, flag, placed, nextWin: { change: up.change, from: up.before, to: up.after }, scoreboardEmblems: document.querySelectorAll('.play-hud td.rank .rank-emblem').length });
  } catch (e) { return 'failed: ' + e.message; } })()`));
  await wait(1200);
  await shot('rank');
  await js(`document.querySelector('[data-leave]')?.click(); 1`);
  await wait(2500);
  console.log('SMOKE play lobby rank', await js(`(() => { const c = document.querySelector('.play-rank'); c?.scrollIntoView({ block: 'center' }); return c ? c.innerText.replace(/\\s+/g, ' ') + (c.querySelector('img') ? ' (emblem)' : '') : 'no rank card'; })()`));
  await wait(800);
  await shot('lobby-rank');
  console.log('SMOKE screenshots saved to', app.getPath('userData'));
  app.quit();
}

function runSmokeTest(win) {
  win.webContents.on('console-message', (e, level, message) => console.log('[renderer]', e.message ?? message));
  if (process.env.CS2SIM_SMOKE === 'features') { win.webContents.once('did-finish-load', () => runFeatureSmoke(win).catch((e) => { console.error('SMOKE failed', e); app.quit(); })); return; }
  if (process.env.CS2SIM_SMOKE === 'play') { win.webContents.once('did-finish-load', () => runPlaySmoke(win).catch((e) => { console.error('SMOKE failed', e); app.quit(); })); return; }
  if (process.env.CS2SIM_SMOKE === 'crate') { win.webContents.once('did-finish-load', () => runCrateSmoke(win).catch((e) => { console.error('SMOKE failed', e); app.quit(); })); return; }
  win.webContents.once('did-finish-load', async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await wait(4000);
    const page = await win.webContents.executeJavaScript(`JSON.stringify({ tiles: document.querySelectorAll('.case-tile').length,
      imgsLoaded: [...document.querySelectorAll('.case-tile img')].filter((i) => i.complete && i.naturalWidth).length,
      balance: document.querySelector('#balance')?.textContent })`);
    console.log('SMOKE page', page);
    const t0 = Date.now();
    await win.webContents.executeJavaScript(`(async () => {
      const ui = await import('./js/ui.js'); const I = await import('./js/items.js'); const { D } = await import('./js/data.js');
      const s = Object.values(D.skins).find((x) => x.n === (${JSON.stringify(process.env.CS2SIM_SMOKE_SKIN || 'AK-47 | Case Hardened')}));
      const it = I.makeSkinItem(s, { stt: true, fl: 0.05, sd: 661 });
      // CS2SIM_SMOKE_STICKERS=1 puts three stickers (holo, foil, gold) on the receiver.
      if (${JSON.stringify(!!process.env.CS2SIM_SMOKE_STICKERS)}) {
        const pick = (fx) => Object.values(D.stickers).find((x) => x.fx === fx && x.sm && !x.so);
        it.stk = ['Holo', 'Foil', 'Gold'].map((fx, i) => ({ id: pick(fx).id, x: 0.38 + i * 0.12, y: 0.35, r: 0, wr: 0, m: 1 }));
      }
      // CS2SIM_SMOKE_GLOVES="★ Sport Gloves | Vice" equips those gloves (worn in the first-person inspect).
      const gloves = ${JSON.stringify(process.env.CS2SIM_SMOKE_GLOVES || '')};
      if (gloves) {
        const st = await import('./js/state.js'); const { act } = await import('./js/backend.js');
        const g = I.makeSkinItem(Object.values(D.skins).find((x) => x.n === gloves), { fl: 0.1, sd: 42 });
        st.S.inv.unshift(g);
        await act('loadout.equip', { uid: g.uid });
      }
      ui.openInspect(it);
    })()`);
    for (let i = 0; i < 240; i++) {
      await wait(500);
      if (!(await win.webContents.executeJavaScript(`!!document.querySelector('.inspect .loading')`))) break;
    }
    // CS2SIM_SMOKE_BG=de_dust2 also shows that inspect backdrop (CS2's menu scene) behind the item.
    if (process.env.CS2SIM_SMOKE_BG) {
      const tb = Date.now();
      const r = await win.webContents.executeJavaScript(`(async () => { const { inspectView } = await import('./js/inspect.js'); try { await inspectView.setBackdrop(${JSON.stringify(process.env.CS2SIM_SMOKE_BG)}); return 'ok ' + inspectView.backdrop?.name; } catch (e) { return 'FAILED ' + e.message; } })()`);
      console.log('SMOKE backdrop', r, ((Date.now() - tb) / 1000).toFixed(1) + 's');
    }
    // CS2SIM_SMOKE_FP=1.5 switches to the first-person inspect and captures that many seconds into the animation.
    if (process.env.CS2SIM_SMOKE_FP) {
      const tf = Date.now();
      const r = await win.webContents.executeJavaScript(`(async () => { const { inspectView } = await import('./js/inspect.js'); try { await inspectView.enterFirstPerson(); return 'ok ' + inspectView.fp.duration.toFixed(2) + 's clip'; } catch (e) { return 'FAILED ' + e.message; } })()`);
      console.log('SMOKE first person', r, ((Date.now() - tf) / 1000).toFixed(1) + 's');
      await wait(Number(process.env.CS2SIM_SMOKE_FP) * 1000 - 1500);
    }
    await wait(1500);
    const insp = await win.webContents.executeJavaScript(`(async () => { const { inspectView } = await import('./js/inspect.js');
      return JSON.stringify({ inspectOpen: !!document.querySelector('.inspect canvas'), stillLoading: !!document.querySelector('.inspect .loading'), source: inspectView.source }); })()`);
    console.log('SMOKE seconds to model', ((Date.now() - t0) / 1000).toFixed(1));
    console.log('SMOKE sounds', await win.webContents.executeJavaScript(`window.native.cs2Sounds().then((s) => Object.keys(s).join(','))`));
    console.log('SMOKE inspect', insp);
    const img = await win.webContents.capturePage();
    const shot = path.join(app.getPath('userData'), 'smoke.png');
    fs.writeFileSync(shot, img.toPNG());
    console.log('SMOKE screenshot saved', shot);
    app.quit();
  });
}

app.whenReady().then(() => {
  initPaths();
  Menu.setApplicationMenu(null);
  protocol.handle('app', handleApp);
  registerIpc();
  createWindow();
  // Index the player's CS2 install in the background so the first real-model inspect is quick.
  if (!SMOKE) setTimeout(() => { if (cs2.status().available) cs2.ensureIndex().catch((e) => console.warn('[cs2]', e.message)); }, 4000);
});

app.on('window-all-closed', () => app.quit());
