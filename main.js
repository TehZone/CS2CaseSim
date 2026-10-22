const { app, BrowserWindow, protocol, net, ipcMain, shell, Menu, nativeImage } = require('electron');
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
  maps: () => cs2.playMaps(), map: (id) => cs2.playMap(id), progress: (key) => cs2.playProgress(key), weapon: (id) => cs2.playWeapon(id),
  agent: (vmdl) => cs2.playAgent(vmdl), anims: (list) => cs2.playAnims(list), sounds: (events) => cs2.playSounds(events),
  agentModel: (id) => cs2.agentModel(id), stats: () => cs2.playStats(), voices: () => cs2.playVoices(),
};
function playCall(fn, arg) {
  if (!Object.hasOwn(PLAY_CALLS, fn)) throw new Error('Unknown play call ' + fn);
  return PLAY_CALLS[fn](arg);
}

// Shrinks images in place (inspect backdrop textures are drawn blurred, so 512px is plenty).
async function shrinkImages(files, max) {
  for (const f of files) {
    try {
      const img = nativeImage.createFromPath(f);
      const { width, height } = img.getSize();
      if (width && Math.max(width, height) > max) {
        const k = max / Math.max(width, height);
        fs.writeFileSync(f, img.resize({ width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)), quality: 'good' }).toPNG());
      }
    } catch {}
    await new Promise((r) => setImmediate(r));
  }
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
  await js(`(() => { const g = window.__playGame; document.querySelector('.play-pause').classList.add('hidden'); g.paused = false; g.input.locked = true; g.match.time = 0.01; })()`);
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
  console.log('SMOKE play round 2', await state());
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
