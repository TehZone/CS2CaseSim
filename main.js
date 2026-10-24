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
  cs2Cache = process.env.CS2SIM_CACHE ? path.resolve(process.env.CS2SIM_CACHE) : path.join(userDir, 'cs2cache'); // CS2SIM_CACHE: e.g. a smoke test on the app's own exports
  const cli = app.isPackaged
    ? path.join(process.resourcesPath, 's2v', 'Source2Viewer-CLI.exe')
    : process.env.CS2SIM_CLI || path.join(__dirname, 'tools', 's2v', 'Source2Viewer-CLI.exe');
  cs2 = new CS2Service({ cacheDir: cs2Cache, cliPath: cli, log: (m) => console.log('[cs2]', m), shrinkImages });
}

// Play mode calls from the renderer (one channel, whitelisted).
const PLAY_CALLS = {
  maps: () => cs2.playMaps(), mapImages: () => cs2.playMapImages(), map: (id) => cs2.playMap(id), progress: (key) => cs2.playProgress(key), weapon: (id) => cs2.playWeapon(id),
  agent: (vmdl) => cs2.playAgent(vmdl), anims: (list) => cs2.playAnims(list), sounds: (events) => cs2.playSounds(events),
  agentModel: (id) => cs2.agentModel(id), stats: () => cs2.playStats(), impacts: () => cs2.playImpacts(), voices: () => cs2.playVoices(), icons: () => cs2.playIcons(),
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
  ipcMain.handle('cs2:prepareAll', (_e, content) => cs2.prepareAll(content));
  ipcMain.handle('cs2:prepareStatus', () => cs2.prepareStatus());
  ipcMain.handle('cs2:prepareCancel', () => cs2.prepareCancel());
  ipcMain.handle('cs2:cacheSize', () => cs2.cacheSize());
  ipcMain.handle('cs2:clear', () => {
    cs2.prepareCancel();
    cs2.flush(); // nothing left to write into the folder once it's gone
    fs.rmSync(cs2Cache, { recursive: true, force: true });
    cs2 = new CS2Service({ cacheDir: cs2Cache, cliPath: cs2.cliPath, log: (m) => console.log('[cs2]', m), shrinkImages });
    return true;
  });

  ipcMain.handle('app:openExternal', (_e, u) => {
    if (/^https:\/\//.test(u)) shell.openExternal(u);
  });
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), userData: userDir, electron: process.versions.electron }));
  // Display settings that need a restart (the uncapped frame rate): { uncapped, active } (active: what this run has).
  const displayNow = readDisplay();
  ipcMain.handle('app:display', () => ({ ...readDisplay(), active: !!displayNow.uncapped }));
  ipcMain.handle('app:setDisplay', (_e, d) => { fs.writeFileSync(displayFile, JSON.stringify({ ...readDisplay(), uncapped: !!d?.uncapped })); return true; });
  ipcMain.handle('app:relaunch', () => { app.relaunch(); app.exit(0); });
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
  // (Not in a smoke run that measures: its CLI runs would be in the numbers.)
  if (!SMOKE || process.env.CS2SIM_SMOKE === 'prepare') setTimeout(() => cs2.learnSignatures().catch((e) => console.warn('[cs2] learn signatures:', e.message)), 20000);
  if (SMOKE) runSmokeTest(win);
}

// `CS2SIM_SMOKE=1 electron .` loads the game hidden, opens a case preview in 3D, screenshots it and quits.
const SMOKE = !!process.env.CS2SIM_SMOKE;
if (SMOKE) app.setPath('userData', path.join(app.getPath('temp'), 'cs2sim-smoke'));
// The frame rate is the monitor's (vsync) unless the player unlocked it in Play's settings (display.json, read at start:
// Chromium only takes these switches before it starts). A perf run always measures as fast as Play goes.
const displayFile = path.join(app.getPath('userData'), 'display.json');
const readDisplay = () => { try { return JSON.parse(fs.readFileSync(displayFile, 'utf8')); } catch { return {}; } };
if (process.env.CS2SIM_SMOKE_ANGLE) app.commandLine.appendSwitch('use-angle', process.env.CS2SIM_SMOKE_ANGLE); // (trying ANGLE's other backends: gl, vulkan, d3d11)
if (process.env.CS2SIM_SMOKE === 'hitch') app.commandLine.appendSwitch('enable-precise-memory-info'); // the heap falling in a frame: a garbage collection
// Play collects the garbage loading a match leaves (models, textures, parsing) behind the loading screen (window.gc), not
// in a full collection a minute into the match (50 ms or more).
app.commandLine.appendSwitch('js-flags', '--expose-gc');
if (process.env.CS2SIM_SMOKE === 'perf' || readDisplay().uncapped) { app.commandLine.appendSwitch('disable-frame-rate-limit'); app.commandLine.appendSwitch('disable-gpu-vsync'); }

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

// `CS2SIM_SMOKE=maps` loads Play maps (CS2SIM_SMOKE_MAPS=de_nuke,de_vertigo...; default every one) in a competitive
// match and screenshots each from both spawns and both bomb sites (and any CS2SIM_SMOKE_VIEWS: JSON
// { map: [{ name, pos: [x, y, z], yaw, pitch }] }) into userData/maps-<map>-<view>[-CS2SIM_SMOKE_TAG].png, without the
// HUD or the weapon, logging each view's average brightness, the auto exposure and the material in the middle; then
// checks the map's moving parts (a door opens, a breakable breaks, the bells' sound, a kill volume kills a fall).
// The Play maps a smoke run goes through: CS2SIM_SMOKE_MAPS (de_nuke,de_vertigo...), or every one in the list.
async function smokeMapIds(win) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  await wait(3000);
  // CS2SIM_SMOKE_GLOBALS: page globals for the run (JSON, e.g. debugging switches the game reads).
  if (process.env.CS2SIM_SMOKE_GLOBALS) await js(`Object.assign(window, ${process.env.CS2SIM_SMOKE_GLOBALS}); 1`);
  // CS2SIM_SMOKE_PREFS: Play settings for the run (JSON, e.g. {"quality":"performance","renderScale":0.75}).
  if (process.env.CS2SIM_SMOKE_PREFS) await js(`(() => { const k = 'cs2sim.play'; const p = JSON.parse(localStorage.getItem(k) || '{}'); localStorage.setItem(k, JSON.stringify({ ...p, ...${process.env.CS2SIM_SMOKE_PREFS} })); })(); 1`);
  await js(`document.querySelector('#nav [data-page=play]').click(); 1`);
  let ids = (process.env.CS2SIM_SMOKE_MAPS || '').split(',').filter(Boolean);
  for (let i = 0; i < 40 && !ids.length; i++) {
    await wait(500);
    const all = JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('[data-map]')].map((b) => b.dataset.map))`));
    if (all.length > 1) ids = all;
  }
  return ids;
}

// Starts a competitive match on a map (exporting it first if needed): whether it's running (window.__playGame).
async function smokeStartMap(win, id, label) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  await js(`window.__cs2Debug = true; window.__playGame = null; document.querySelector('[data-map="${id}"]')?.click();
    setTimeout(() => document.querySelector('[data-start]').click(), 400); 1`);
  for (let i = 0; i < 900; i++) {
    await wait(1000);
    if (await js(`!!window.__playGame?.raf`)) return true;
    if (i > 2 && !(await js(`!!document.querySelector('.play-root')`))) break; // it gave up (the error is in a toast)
    if (i % 30 === 29) console.log('SMOKE', label, id, 'loading', await js(`document.querySelector('.play-root [data-status]')?.textContent || ''`));
  }
  console.log('SMOKE', label, id, 'did not load:', await js(`[...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' / ')`));
  await js(`document.querySelector('.play-root [data-cancel]')?.click(); 1`);
  return false;
}

async function runMapsSmoke(win) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  const tag = process.env.CS2SIM_SMOKE_TAG ? '-' + process.env.CS2SIM_SMOKE_TAG : '';
  const extra = process.env.CS2SIM_SMOKE_VIEWS ? JSON.parse(process.env.CS2SIM_SMOKE_VIEWS) : {};
  for (const id of await smokeMapIds(win)) {
    if (!(await smokeStartMap(win, id, 'maps'))) continue;
    const views = JSON.parse(await js(`(() => { const g = window.__playGame, i = g.map.info;
      document.querySelector('.play-pause')?.classList.add('hidden'); g.paused = false;
      g.god = true; g.cv.bot_stop = 1; g.match.time = 9999; g.console.run('cl_drawhud 0; r_drawviewmodel 0');
      for (const b of g.bots) b.root.visible = false; // the bots stand at the spawns, in the way
      const yawTo = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
      const sites = i.bombsites.map((s) => ({ name: s.site.toLowerCase(), p: [(s.min[0] + s.max[0]) / 2, (s.min[1] + s.max[1]) / 2, s.max[2] + 40] }));
      const t = i.spawns.T[0]?.origin, ct = i.spawns.CT[0]?.origin;
      const mid = sites.length ? [0, 1].map((k) => sites.reduce((s, x) => s + x.p[k], 0) / sites.length) : [0, 0];
      const out = [];
      if (t) out.push({ name: 'tspawn', pos: t, yaw: yawTo(t, mid), pitch: 3 });
      if (ct) out.push({ name: 'ctspawn', pos: ct, yaw: yawTo(ct, mid), pitch: 3 });
      for (const s of sites) out.push({ name: 'site' + s.name, pos: s.p, yaw: t ? yawTo(s.p, t) : 0, pitch: 8, drop: true });
      return JSON.stringify(out.concat(${JSON.stringify(extra[id] || [])})); })()`));
    for (const v of views) {
      await js(`(() => { const g = window.__playGame, v = ${JSON.stringify(v)};
        if (!g.me.alive) { g.me.alive = true; g.me.health = 100; g.deathCam = null; }
        const z = v.drop ? g.floorAt(v.pos, 400) ?? v.pos[2] : v.pos[2];
        g.player.teleport([v.pos[0], v.pos[1], z]); g.input.yaw = v.yaw; g.input.pitch = v.pitch ?? 0; })()`);
      await wait(2500); // the auto exposure settles
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(app.getPath('userData'), `maps-${id}-${v.name}${tag}.png`), img.toPNG());
      const bmp = img.toBitmap(); let sum = 0;
      for (let k = 0; k < bmp.length; k += 4 * 7) sum += (bmp[k] + bmp[k + 1] + bmp[k + 2]) / 3;
      // And the material in the middle of the view (or at CS2SIM_SMOKE_PROBES, [[x, y], ...] from -1 to 1), to find the
      // one that looks wrong.
      const mat = await js(`(async () => { const THREE = await import('three'), g = window.__playGame, r = new THREE.Raycaster();
        return ${process.env.CS2SIM_SMOKE_PROBES || '[[0, 0]]'}.map(([x, y]) => {
          r.setFromCamera(new THREE.Vector2(x, y), g.camera);
          const hit = r.intersectObjects(g.scene.children, true).find((h) => h.object.visible && h.object.material?.visible !== false);
          return hit ? (hit.object.material.userData?.vmat?.Name || hit.object.material.name) + ' (' + (hit.object.material.userData?.vmat?.ShaderName || '') + ')' : '';
        }).join(' | '); })()`);
      console.log('SMOKE maps', id, v.name, JSON.stringify({ brightness: Math.round(sum / (bmp.length / 28)), exposure: +(await js(`window.__playGame.post.exposure`)).toFixed(2), mat }));
    }
    // The map's moving parts: a door swings, a pane of glass breaks, the bells have their sounds, and a fall into a
    // kill volume (Vertigo's drop) kills on the way down.
    console.log('SMOKE maps', id, 'checks', await js(`(async () => { const g = window.__playGame, d = g.doors, out = {};
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      out.doors = d.list.length; out.panes = d.panes.length;
      if (d.list.length) { const door = d.list[0]; d.toggle(door, null); await sleep(1500); out.doorAngle = Math.round(door.angle); d.reset(); }
      if (d.panes.length) { const p = d.panes[0]; out.glassBroke = d.shot({ shape: p.shape }, p.center) && p.broken; d.reset(); }
      const bell = g.impactSound('brass_bell_large'); if (g.collision.surfaces.includes('brass_bell_large')) out.bell = bell + ':' + g.sounds.has(bell);
      // CS2SIM_SMOKE_FIND (a regex): where the meshes with those materials are (game units), to point a view at them.
      const find = ${JSON.stringify(process.env.CS2SIM_SMOKE_FIND || '')};
      if (find) {
        out.found = [];
        g.world.world.traverse((o) => { if (!o.isMesh || !new RegExp(find, 'i').test(o.material.name)) return;
          o.geometry.computeBoundingBox(); const c = o.geometry.boundingBox.getCenter(new (o.position.constructor)()).applyMatrix4(o.matrixWorld);
          out.found.push(o.material.name + ' ' + [c.z, c.x, c.y].map((v) => Math.round(v / 0.0254)).join(',')); });
      }
      const hz = (g.map.info.hurts || []).filter((h) => h.damage >= 500).sort((a, b) => (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) - (a.max[0] - a.min[0]) * (a.max[1] - a.min[1]))[0];
      const top = g.map.info.spawns.CT[0]?.origin[2] + 64;
      if (hz && top > hz.max[2] + 500) {
        let spot = null;
        for (let x = hz.min[0] + 64; x < hz.max[0] && !spot; x += 256) for (let y = hz.min[1] + 64; y < hz.max[1] && !spot; y += 256)
          if (!g.collision.raycast([x, y, top], [0, 0, -1], top - hz.max[2] + 100, 1)) spot = [x, y, top];
        if (spot) {
          g.god = false; g.me.alive = true; g.me.health = 100; g.player.teleport(spot);
          const t0 = g.now; while (g.me.alive && g.now - t0 < 8) await sleep(50);
          out.fall = { drop: Math.round(top - hz.max[2]), seconds: +(g.now - t0).toFixed(2), died: !g.me.alive };
          g.god = true;
        }
      }
      return JSON.stringify(out); })()`));
    await js(`document.querySelector('.play-root [data-leave]')?.click(); 1`);
    await wait(2000);
  }
  app.quit();
}

// `CS2SIM_SMOKE=prepare` checks "Prepare all CS2 content": times loading a Play map (the first of CS2SIM_SMOKE_MAPS;
// none for "none") twice, then runs Prepare all from Settings for CS2SIM_SMOKE_SECONDS (default 60) logging its
// progress, screenshots the Settings row into userData/prepare-*.png and stops it.
async function runPrepareSmoke(win) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => fs.writeFileSync(path.join(app.getPath('userData'), `prepare-${name}.png`), (await win.webContents.capturePage()).toPNG());
  const [id] = process.env.CS2SIM_SMOKE_MAPS === 'none' ? (await wait(3000), []) : await smokeMapIds(win);
  for (const run of id ? [1, 2] : []) {
    const t0 = Date.now();
    const ok = await smokeStartMap(win, id, 'prepare');
    console.log('SMOKE prepare map', id, 'load', run, ok ? 'took' : 'failed after', ((Date.now() - t0) / 1000).toFixed(1) + 's');
    await js(`document.querySelector('.play-root [data-leave]')?.click(); 1`);
    await wait(2000);
  }
  await js(`document.querySelector('#nav [data-page=stats]').click(); 1`);
  for (let i = 0; i < 20 && !(await js(`!!document.querySelector('[data-prep]:not([hidden])')`)); i++) await wait(500);
  await js(`document.querySelector('[data-prep]').scrollIntoView({ block: 'center' }); 1`);
  await wait(6000);
  console.log('SMOKE prepare row', await js(`document.querySelector('[data-prep]')?.innerText.replace(/\\n+/g, ' | ')`));
  await shot('idle');
  await js(`document.querySelector('[data-a=prepare]').click(); 1`);
  const end = Date.now() + 1000 * (+process.env.CS2SIM_SMOKE_SECONDS || 60);
  let last = '';
  while (Date.now() < end) {
    await wait(2000);
    const st = await js(`window.native.cs2PrepareStatus()`);
    const line = `${st.step}${st.detail ? ' · ' + st.detail : ''} ${Math.floor((100 * st.done) / (st.total || 1))}%`;
    if (line !== last) console.log('SMOKE prepare', ((end - Date.now()) / 1000).toFixed(0) + 's left', line, 'skipped', st.skipped);
    last = line;
    if (!st.running) break;
  }
  await js(`document.querySelector('[data-prep]').scrollIntoView({ block: 'center' }); 1`);
  await wait(1200);
  await shot('running');
  console.log('SMOKE prepare row', await js(`document.querySelector('[data-prep]')?.innerText.replace(/\\n+/g, ' | ')`));
  await js(`window.native.cs2PrepareCancel()`);
  for (let i = 0; i < 300 && (await js(`window.native.cs2PrepareStatus()`)).running; i++) await wait(1000);
  console.log('SMOKE prepare stopped', JSON.stringify(await js(`window.native.cs2PrepareStatus()`)));
  app.quit();
}

// `CS2SIM_SMOKE=hitch` hunts stutters: on each map (CS2SIM_SMOKE_MAPS, default Dust II, Inferno and Nuke) it plays a
// 5v5 competitive match in real time for CS2SIM_SMOKE_SECONDS (default 240) — you buy a rifle and every grenade each
// round, fire, throw them all, then die and spectate the bots — and logs every frame that took over 33 ms with what ran
// in it: the game's parts (simulation, bots, effects, drawing, HUD), GL work (shader compiles and links, texture and
// buffer uploads, in the frame or between frames), new shader programs and textures, a fall in the JS heap (a garbage
// collection), long tasks, and what had just happened (kills, throws, detonations, round starts, buys).
async function runHitchSmoke(win) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  const secs = +process.env.CS2SIM_SMOKE_SECONDS || 240;
  if (!process.env.CS2SIM_SMOKE_MAPS) process.env.CS2SIM_SMOKE_MAPS = 'de_dust2,de_inferno,de_nuke';
  const totals = [];
  for (const id of await smokeMapIds(win)) {
    if (!(await smokeStartMap(win, id, 'hitch'))) continue;
    await js(`(() => { const g = window.__playGame, gl = g.renderer.getContext(), now = () => performance.now();
      document.querySelector('.play-pause')?.classList.add('hidden'); g.paused = false;
      g.console.run('sv_cheats 1');
      const H = window.__hitch = { t0: now(), ints: [], slow: [], events: [], long: [], cur: null, prev: 0, lastEnd: 0, outside: {} };
      const add = (o, k, v) => { o[k] = (o[k] || 0) + v; };
      const heap = () => performance.memory?.usedJSHeapSize || 0;
      // The game's parts, timed inside the frame.
      const wrap = (obj, name, label) => { const f = obj?.[name]; if (typeof f !== 'function') return;
        obj[name] = function (...a) { const t = now(); try { return f.apply(this, a); } finally { if (H.cur) add(H.cur.p, label, now() - t); } }; };
      wrap(g, 'tick', 'sim'); wrap(g.match, 'tick', 'match'); wrap(g.nades, 'tick', 'nades'); wrap(g.nades, 'update', 'nadesFx'); wrap(g.effects, 'update', 'effects');
      wrap(g.drops, 'tick', 'drops'); wrap(g.doors, 'tick', 'doors'); wrap(g.arsenal, 'tick', 'arsenal'); wrap(g, 'updateHud', 'hud'); wrap(g.post, 'render', 'render');
      wrap(g, 'updateSpecView', 'spec'); wrap(g, 'botThrowing', 'botThrow'); wrap(g, 'spotFromMe', 'spot'); wrap(g, 'pickups', 'pickups'); wrap(g, 'footsteps', 'steps');
      wrap(g.sounds, 'play', 'sound'); wrap(g.hud, 'kill', 'hudKill'); wrap(g.hud, 'scoreboard', 'scoreboard'); wrap(g.hud, 'chatLine', 'chat'); wrap(g.hud, 'message', 'hudMsg');
      const B = g.bots[0];
      wrap(Object.getPrototypeOf(B.brain), 'tick', 'ai'); wrap(Object.getPrototypeOf(B), 'animate', 'animate'); wrap(Object.getPrototypeOf(B), 'sync', 'botSync');
      // What happened, and when (with its own time).
      const ev = (obj, name, label, fmt) => { const f = obj?.[name]; if (typeof f !== 'function') return;
        obj[name] = function (...a) { const t = now(); const r = f.apply(this, a); const d = now() - t; let x = ''; try { x = fmt ? ' ' + fmt(...a) : ''; } catch {}
          H.events.push({ t, d, what: label + x }); if (H.cur) add(H.cur.p, label, d); return r; }; };
      ev(g, 'kill', 'kill', (c) => c.name); ev(g.nades, 'throw', 'throw', (c, w) => w); ev(g.nades, 'detonate', 'detonate', (n) => n.id || n.kind || '');
      ev(g.match, 'startRound', 'startRound'); ev(g.match, 'endRound', 'endRound'); ev(g, 'buy', 'buy', (w) => w); ev(g.drops, 'drop', 'drop', (gun) => gun?.id || '');
      ev(g.effects, 'explosion', 'explosion'); ev(g.effects, 'flashPop', 'flashPop'); ev(g.match, 'planted', 'planted'); ev(g.match, 'defused', 'defused');
      ev(g.match, 'exploded', 'bombExploded'); ev(g, 'restartMatch', 'restartMatch'); ev(g.nades, 'fire', 'fire'); ev(g.nades, 'smoke', 'smoke'); ev(g.nades, 'explodeHE', 'he');
      ev(g.nades, 'flashbang', 'flash'); ev(g.arsenal, 'select', 'select', (s) => s); ev(g.arsenal, 'shoot', 'shoot', (gun) => gun.id); ev(g, 'vmData', 'vmData', (w) => w);
      // GL work, in the frame (by call) and between frames.
      for (const name of ['compileShader', 'linkProgram', 'getProgramParameter', 'getShaderParameter', 'getProgramInfoLog', 'getShaderInfoLog', 'getUniformLocation', 'getActiveUniform', 'texImage2D', 'texSubImage2D', 'texImage3D', 'texSubImage3D',
        'texStorage2D', 'texStorage3D', 'compressedTexImage2D', 'generateMipmap', 'bufferData', 'bufferSubData', 'readPixels', 'getError']) {
        const f = gl[name]; if (typeof f !== 'function') continue;
        gl[name] = function (...a) { const t = now(); try { return f.apply(gl, a); } finally { const d = now() - t, o = H.cur ? (H.cur.gl ||= {}) : H.outside; const e = o[name] ||= [0, 0]; e[0]++; e[1] += d;
          // Where the slow uploads come from (and how big they are).
          if (d > 3 && /^tex/.test(name)) { const src = a.find((x) => x && typeof x === 'object' && 'width' in x); const size = src ? src.width + 'x' + src.height : a[4] + 'x' + a[5];
            const k = (H.cur ? 'frame ' : 'between ') + size + ' ' + (new Error().stack || '').split('\\n').slice(3, 9).map((l) => l.trim().replace(/^at /, '').replace(/\\(.*\\/(.*?):(\\d+):\\d+\\)/, '$1:$2')).join(' < ');
            const s = (H.stacks ||= {})[k] ||= [0, 0]; s[0]++; s[1] += d; } } };
      }
      // Textures made inside frames: from where.
      const ct = gl.createTexture;
      gl.createTexture = function () { if (H.cur) { const k = (new Error().stack || '').split('\\n').slice(2, 8).map((l) => l.trim().replace(/^at /, '').replace(/\\(.*\\/(.*?):(\\d+):\\d+\\)/, '$1:$2')).join(' < '); const s = (H.made ||= {})[k] ||= [0]; s[0]++; } return ct.apply(gl, arguments); };
      new PerformanceObserver((l) => { for (const e of l.getEntries()) H.long.push([e.startTime, e.duration]); }).observe({ type: 'longtask' });
      const info = g.renderer.info, frame = g.frame;
      g.frame = function (dt) {
        const t = now(), h0 = heap();
        if (H.cur) H.reentered = (H.reentered || 0) + 1;
        const c = H.cur = { t, int: H.prev ? t - H.prev : 0, gap: H.lastEnd ? t - H.lastEnd : 0, prevCpu: H.lastCpu || 0, p: {}, pre: H.outside, heapGap: H.lastHeap ? h0 - H.lastHeap : 0, prog: info.programs?.length || 0, tex: info.memory.textures };
        H.outside = {};
        frame.call(this, dt);
        const e = now(), h1 = heap();
        const progs = info.programs || [];
        if (progs.length > c.prog) c.progNames = progs.slice(c.prog).map((pr) => pr.name + (pr.cacheKey ? ' ' + String(pr.cacheKey).slice(0, 60) : '')).join(' | ');
        c.cpu = e - t; c.heapIn = h1 - h0; c.prog = progs.length - c.prog; c.tex = info.memory.textures - c.tex;
        H.prev = t; H.lastEnd = e; H.lastHeap = h1; H.lastCpu = c.cpu; H.cur = null;
        if (c.int) H.ints.push(c.int);
        if (c.int > 33 || c.cpu > 25) H.slow.push(c);
      };
      return 1; })()`);
    // CS2SIM_SMOKE_PROFILE: a CPU profile of the first map's run, split into the work inside frames and between them.
    const prof = process.env.CS2SIM_SMOKE_PROFILE && !totals.length ? win.webContents.debugger : null;
    // CS2SIM_SMOKE_ALLOC: where the garbage comes from (a sampling heap profile of the first map's run, freed objects too).
    const alloc = process.env.CS2SIM_SMOKE_ALLOC && !totals.length ? win.webContents.debugger : null;
    if (alloc) {
      if (!alloc.isAttached()) alloc.attach('1.3');
      await alloc.sendCommand('HeapProfiler.enable');
      await alloc.sendCommand('HeapProfiler.startSampling', { samplingInterval: 16384, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    }
    let profAt = 0; // performance.now() when it started (to line its samples up with the frames)
    if (prof) {
      if (!prof.isAttached()) prof.attach('1.3');
      await prof.sendCommand('Profiler.enable'); await prof.sendCommand('Profiler.setSamplingInterval', { interval: 200 });
      const before = await js('performance.now()'); await prof.sendCommand('Profiler.start'); profAt = (before + await js('performance.now()')) / 2;
    }
    // You: a rifle and every grenade each round, a few shots and the grenades thrown, then dead (the bots play it out).
    const t0 = Date.now();
    let round = -1;
    while (Date.now() - t0 < secs * 1000) {
      const st = JSON.parse(await js(`JSON.stringify({ round: window.__playGame?.match.round, phase: window.__playGame?.match.phase, alive: window.__playGame?.me.alive, over: !!window.__playGame?.matchOver })`));
      if (!st.phase || st.over) break;
      if (st.round !== round && st.phase === 'freeze' && st.alive) {
        round = st.round;
        await js(`(async () => { const g = window.__playGame; g.console.run('impulse 101');
          const rifle = g.me.team === 'T' ? 'weapon_ak47' : 'weapon_m4a1';
          for (const w of [rifle, 'weapon_smokegrenade', 'weapon_flashbang', 'weapon_hegrenade', g.me.team === 'T' ? 'weapon_molotov' : 'weapon_incgrenade', 'vesthelm']) { try { await g.buy(w); } catch {} }
          return 1; })()`);
        for (let i = 0; i < 40 && JSON.parse(await js(`JSON.stringify(window.__playGame?.match.phase)`)) === 'freeze'; i++) await wait(500);
        await js(`(async () => { const g = window.__playGame, inp = g.input, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const i = g.map.info, s = i.bombsites[0], o = g.player.origin, to = [(s.min[0] + s.max[0]) / 2, (s.min[1] + s.max[1]) / 2];
          inp.yaw = Math.atan2(to[1] - o[1], to[0] - o[0]) * 180 / Math.PI; inp.pitch = -8;
          g.arsenal.select('primary', g.now); await sleep(900); inp.down('mouse1'); await sleep(600); inp.up('mouse1'); await sleep(400);
          for (const n of ['weapon_smokegrenade', 'weapon_flashbang', 'weapon_hegrenade', 'weapon_molotov', 'weapon_incgrenade']) {
            if (!g.arsenal.guns['g_' + n] || !g.me.alive) continue;
            g.arsenal.select('g_' + n, g.now); await sleep(1000); inp.down('mouse1'); await sleep(400); inp.up('mouse1'); await sleep(900);
          }
          await sleep(3000); if (g.me.alive) g.console.run('kill'); return 1; })()`);
      }
      await wait(1000);
    }
    if (alloc) {
      const { profile } = await alloc.sendCommand('HeapProfiler.stopSampling');
      const self = new Map(), total = new Map();
      const key = (n) => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.replace(/.*\//, '')}:${n.callFrame.lineNumber + 1}`;
      let all = 0;
      const chains = new Map(); // the biggest allocators' callers
      const walk = (n, path) => {
        const k = key(n), size = n.selfSize || 0;
        all += size;
        self.set(k, (self.get(k) || 0) + size);
        if (size && /lightAt|applyBoneTransform|computeBoundingSphere|three\.core\.js:6044|setValueV3f/.test(k)) { const c = k + ' <- ' + path.slice(-4).reverse().join(' <- '); chains.set(c, (chains.get(c) || 0) + size); }
        const p = path.includes(k) ? path : [...path, k];
        for (const kk of new Set(p)) total.set(kk, (total.get(kk) || 0) + size);
        for (const c of n.children || []) walk(c, p);
      };
      walk(profile.head, []);
      const mb = (b) => (b / 1e6).toFixed(1).padStart(7);
      console.log(`SMOKE hitch allocated ${(all / 1e6).toFixed(0)} MB; by own allocations:\n` + [...self].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, b]) => `  ${mb(b)} MB  ${k}`).join('\n'));
      console.log('SMOKE hitch biggest allocators, by caller:\n' + [...chains].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, b]) => `  ${mb(b)} MB  ${k}`).join('\n'));
      console.log('SMOKE hitch allocations by total (with what they call):\n' + [...total].filter(([k]) => /\.js:/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, b]) => `  ${mb(b)} MB  ${k}`).join('\n'));
    }
    if (prof) {
      const { profile } = await prof.sendCommand('Profiler.stop');
      const byId = new Map(profile.nodes.map((nd) => [nd.id, nd])), parent = new Map();
      for (const nd of profile.nodes) for (const c of nd.children || []) parent.set(c, nd);
      const keyOf = (nd) => `${nd.callFrame.functionName || '(anon)'} ${nd.callFrame.url.replace(/.*\//, '')}:${nd.callFrame.lineNumber + 1}`;
      const sets = { inside: new Map(), outside: new Map(), outsideSelf: new Map(), outsideRoots: new Map(), slowSelf: new Map(), slowTotal: new Map() };
      let tin = 0, tout = 0, tslow = 0;
      // The frames that took over 18 ms of their own, in the profile's time (ms from its start).
      const slowFrames = JSON.parse(await js(`JSON.stringify(window.__hitch.slow.filter((c) => c.cpu > 18).map((c) => [c.t, c.t + c.cpu]))`)).map(([a, b]) => [a - profAt, b - profAt]);
      let at = 0;
      profile.samples.forEach((sid, k) => {
        const dt = (profile.timeDeltas[k + 1] ?? profile.timeDeltas[k] ?? 0) / 1000;
        at += (profile.timeDeltas[k] || 0) / 1000;
        const slow = slowFrames.some(([a, b]) => at >= a && at <= b);
        const chain = [];
        for (let nd = byId.get(sid); nd; nd = parent.get(nd.id)) chain.push(nd);
        const leaf = keyOf(chain[0]);
        if (leaf.startsWith('(idle')) return;
        const inFrame = chain.some((nd) => nd.callFrame.functionName === 'frame' && /game\.js$/.test(nd.callFrame.url));
        const seen = new Set();
        for (const nd of chain) { const kk = keyOf(nd); if (seen.has(kk)) continue; seen.add(kk); const m = inFrame ? sets.inside : sets.outside; m.set(kk, (m.get(kk) || 0) + dt); if (slow && inFrame) sets.slowTotal.set(kk, (sets.slowTotal.get(kk) || 0) + dt); }
        if (slow && inFrame) { tslow += dt; sets.slowSelf.set(leaf, (sets.slowSelf.get(leaf) || 0) + dt); }
        if (inFrame) tin += dt;
        else {
          tout += dt;
          sets.outsideSelf.set(leaf, (sets.outsideSelf.get(leaf) || 0) + dt);
          const js3 = chain.filter((nd) => /\.js$/.test(nd.callFrame.url)).slice(-3).reverse().map(keyOf).join(' > ') || leaf;
          sets.outsideRoots.set(js3, (sets.outsideRoots.get(js3) || 0) + dt);
        }
      });
      const list = (m, n = 25) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([kk, t]) => `  ${t.toFixed(0).padStart(7)}  ${kk}`).join('\n');
      console.log(`SMOKE hitch profile: ${tin.toFixed(0)} ms in frames, ${tout.toFixed(0)} ms between frames`);
      console.log('SMOKE hitch between frames, by total time:\n' + list(sets.outside, 40));
      console.log('SMOKE hitch between frames, by own time:\n' + list(sets.outsideSelf, 25));
      console.log('SMOKE hitch between frames, by task (outermost JS):\n' + list(sets.outsideRoots, 25));
      console.log('SMOKE hitch in frames, by total time:\n' + list(sets.inside, 30));
      console.log(`SMOKE hitch in the ${slowFrames.length} slow frames (${tslow.toFixed(0)} ms), by total time:\n` + list(sets.slowTotal, 45));
      console.log('SMOKE hitch in the slow frames, by own time:\n' + list(sets.slowSelf, 25));
    }
    const r = JSON.parse(await js(`(() => { const H = window.__hitch, ints = H.ints.slice().sort((a, b) => a - b), n = ints.length || 1;
      const q = (p) => +(ints[Math.min(n - 1, Math.floor(n * p))] || 0).toFixed(1);
      const top = (o, k = 5) => Object.entries(o || {}).sort((a, b) => b[1] - a[1]).slice(0, k).filter(([, v]) => v >= 0.5).map(([k2, v]) => k2 + ' ' + v.toFixed(1)).join(', ');
      const glTop = (o) => Object.entries(o || {}).filter(([, v]) => v[1] >= 0.5).sort((a, b) => b[1][1] - a[1][1]).slice(0, 4).map(([k, v]) => k + ' ' + v[0] + 'x ' + v[1].toFixed(1)).join(', ');
      const byCpu = H.slow.slice().sort((a, b) => b.cpu - a.cpu).slice(0, 8);
      const slow = [...new Set([...H.slow.slice().sort((a, b) => b.int - a.int).slice(0, 25), ...byCpu])].map((c) => {
        const evs = H.events.filter((e) => e.t > c.t - Math.max(c.int, 50) - 30 && e.t < c.t + c.cpu).map((e) => e.what + (e.d >= 1 ? ' (' + e.d.toFixed(0) + 'ms)' : ''));
        const lt = H.long.filter(([s, d]) => s + d > c.t - c.int && s < c.t + c.cpu).map(([s, d]) => d.toFixed(0)).join('+');
        return '  ' + ((c.t - H.t0) / 1000).toFixed(1).padStart(6) + 's  ' + c.int.toFixed(0).padStart(4) + ' ms  cpu ' + c.cpu.toFixed(0).padStart(3) + '  gap ' + c.gap.toFixed(0).padStart(3) + '  prev cpu ' + c.prevCpu.toFixed(0)
          + (c.prog ? '  +' + c.prog + ' programs' : '') + (c.tex ? '  +' + c.tex + ' tex' : '')
          + (c.heapIn < -1e6 || c.heapGap < -1e6 ? '  GC ' + (Math.min(c.heapIn, c.heapGap) / 1e6).toFixed(0) + 'MB' : '')
          + (lt ? '  long ' + lt : '') + '\\n          parts: ' + top(c.p, 7) + (glTop(c.gl) ? '\\n          gl: ' + glTop(c.gl) : '') + (glTop(c.pre) ? '\\n          gl before: ' + glTop(c.pre) : '')
          + (evs.length ? '\\n          events: ' + [...new Set(evs)].slice(0, 8).join(', ') : '') + (c.progNames ? '\\n          new programs: ' + c.progNames : ''); });
      return JSON.stringify({ frames: H.ints.length, p50: q(0.5), p99: q(0.99), p999: q(0.999), worst: q(1), over33: ints.filter((x) => x > 33).length, over50: ints.filter((x) => x > 50).length, over100: ints.filter((x) => x > 100).length,
        rounds: window.__playGame.match.round, reentered: H.reentered || 0,
        uploads: Object.entries(H.stacks || {}).sort((a, b) => b[1][1] - a[1][1]).slice(0, 12).map(([k, v]) => v[0] + 'x ' + v[1].toFixed(0) + ' ms  ' + k)
          .concat(Object.entries(H.made || {}).sort((a, b) => b[1][0] - a[1][0]).slice(0, 8).map(([k, v]) => v[0] + ' textures made in frames  ' + k)), slow }); })()`));
    console.log('SMOKE hitch', id, 'slow texture uploads (count, total, size, where):\n' + (r.uploads || []).map((l) => '  ' + l).join('\n'));
    console.log('SMOKE hitch', id, JSON.stringify({ ...r, slow: undefined, uploads: undefined }));
    console.log('SMOKE hitch', id, 'slowest frames (when, frame interval, own CPU, gap before it):\n' + r.slow.join('\n'));
    totals.push({ id, ...r, slow: undefined, uploads: undefined });
    await js(`document.querySelector('.play-root [data-leave]')?.click(); 1`);
    await wait(2500);
  }
  console.log('SMOKE hitch all', JSON.stringify(totals));
  app.quit();
}

// `CS2SIM_SMOKE=perf` measures Play's frame rate (vsync off, so as fast as it goes) on each map
// (CS2SIM_SMOKE_MAPS) in a live round with the bots playing, from both spawns and both bomb sites
// (CS2SIM_SMOKE_SECONDS each, default 5): frames a second, the slowest frames, where a frame's CPU time goes (the
// simulation, drawing) and the GPU's (when the driver can time it), draw calls and triangles.
async function runPerfSmoke(win) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  const secs = +process.env.CS2SIM_SMOKE_SECONDS || 5;
  if (process.env.CS2SIM_SMOKE_FULLSCREEN) win.setFullScreen(true); // the screen's own resolution
  const all = [];
  for (const id of await smokeMapIds(win)) {
    const t0 = Date.now();
    if (!(await smokeStartMap(win, id, 'perf'))) continue;
    const load = (Date.now() - t0) / 1000;
    const views = JSON.parse(await js(`(() => { const g = window.__playGame, i = g.map.info;
      document.querySelector('.play-pause')?.classList.add('hidden'); g.paused = false;
      g.god = true; g.match.time = 0; // straight into the live round: the bots go
      const yawTo = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
      const sites = i.bombsites.map((s) => ({ name: 'site' + s.site.toLowerCase(), pos: [(s.min[0] + s.max[0]) / 2, (s.min[1] + s.max[1]) / 2, s.max[2] + 40] }));
      const t = i.spawns.T[0]?.origin, ct = i.spawns.CT[0]?.origin, mid = sites.length ? [0, 1].map((k) => sites.reduce((s, x) => s + x.pos[k], 0) / sites.length) : [0, 0];
      // Measuring: each frame's time, its simulation and drawing, and (EXT_disjoint_timer_query_webgl2) the GPU's.
      const P = window.__perf = { frames: [], cur: null };
      const gl = g.renderer.getContext(), tq = ${process.env.CS2SIM_SMOKE_NOGPU ? 'null' : "gl.getExtension('EXT_disjoint_timer_query_webgl2')"}, pending = []; // (CS2SIM_SMOKE_NOGPU: no GPU timing)
      P.gpuTimer = !!tq;
      g.renderer.info.autoReset = false;
      const frame = g.frame, tick = g.tick, render = g.post.render;
      g.frame = function (dt) {
        P.cur = { dt, sim: 0, draw: 0 };
        g.renderer.info.reset();
        const t = performance.now(); frame.call(this, dt); P.cur.cpu = performance.now() - t;
        P.cur.calls = g.renderer.info.render.calls; P.cur.tris = g.renderer.info.render.triangles;
        P.frames.push(P.cur);
        while (pending.length && gl.getQueryParameter(pending[0].q, gl.QUERY_RESULT_AVAILABLE)) {
          const p = pending.shift();
          if (!gl.getParameter(tq.GPU_DISJOINT_EXT)) p.f.gpu = gl.getQueryParameter(p.q, gl.QUERY_RESULT) / 1e6;
          gl.deleteQuery(p.q);
        }
      };
      g.tick = function () { const t = performance.now(); tick.call(this); if (P.cur) P.cur.sim += performance.now() - t; };
      // Each render call's time, by what it draws (the world, the 3D skybox, your weapon, the post passes).
      const rr = g.renderer.render.bind(g.renderer);
      g.renderer.render = function (scene, camera) {
        const t = performance.now(); rr(scene, camera);
        if (!P.cur) return;
        const k = scene === g.scene ? 'rWorld' : scene === g.world.sky3d?.scene ? 'rSky' : scene === g.vmScene ? 'rVm' : 'rPost';
        P.cur[k] = (P.cur[k] || 0) + performance.now() - t;
      };
      g.post.render = function (...a) {
        const q = tq && pending.length < 8 ? gl.createQuery() : null;
        if (q) gl.beginQuery(tq.TIME_ELAPSED_EXT, q);
        const t = performance.now(); render.apply(this, a); P.cur.draw += performance.now() - t;
        if (q) { gl.endQuery(tq.TIME_ELAPSED_EXT); pending.push({ q, f: P.cur }); }
      };
      ${process.env.CS2SIM_SMOKE_SETUP || ''}; // CS2SIM_SMOKE_SETUP: JS run first (g: the game), e.g. to measure without something
      return JSON.stringify([
        t && { name: 'tspawn', pos: t, yaw: yawTo(t, mid) }, ct && { name: 'ctspawn', pos: ct, yaw: yawTo(ct, mid) },
        ...sites.map((s) => ({ ...s, yaw: t ? yawTo(s.pos, t) : 0 })),
      ].filter(Boolean)); })()`));
    for (const v of views) {
      await js(`(() => { const g = window.__playGame, v = ${JSON.stringify(v)};
        if (!g.me.alive) { g.me.alive = true; g.me.health = 100; g.deathCam = null; }
        g.player.teleport([v.pos[0], v.pos[1], g.floorAt(v.pos, 400) ?? v.pos[2]]); g.input.yaw = v.yaw; g.input.pitch = 3; })()`);
      await wait(v === views[0] ? +process.env.CS2SIM_SMOKE_SETTLE || 1000 : 1000); // settle (shaders, textures in view; CS2SIM_SMOKE_SETTLE ms before the first)
      await js(`window.__perf.frames = []; 1`);
      // CS2SIM_SMOKE_PROFILE: a CPU profile of the first view, its functions by their own time.
      const prof = process.env.CS2SIM_SMOKE_PROFILE && v === views[0] ? win.webContents.debugger : null;
      if (prof) { if (!prof.isAttached()) prof.attach('1.3'); await prof.sendCommand('Profiler.enable'); await prof.sendCommand('Profiler.setSamplingInterval', { interval: 200 }); await prof.sendCommand('Profiler.start'); }
      await wait(secs * 1000);
      if (prof) {
        const { profile } = await prof.sendCommand('Profiler.stop');
        const self = new Map(), dt = new Map();
        profile.samples.forEach((id, k) => dt.set(id, (dt.get(id) || 0) + (profile.timeDeltas[k] || 0)));
        let total = 0;
        for (const n of profile.nodes) {
          const t = (dt.get(n.id) || 0) / 1000, f = n.callFrame, key = `${f.functionName || '(anon)'} ${f.url.replace(/.*\//, '')}:${f.lineNumber + 1}`;
          self.set(key, (self.get(key) || 0) + t); total += t;
        }
        console.log('SMOKE perf', id, 'profile (ms of', Math.round(total), 'ms)\n' + [...self].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, t]) => `  ${t.toFixed(0).padStart(6)} ${(t / total * 100).toFixed(1).padStart(5)}%  ${k}`).join('\n'));
        // And by total time (with what they call; a recursive call counted once).
        const byId = new Map(profile.nodes.map((n) => [n.id, n])), incl = new Map();
        const keyOf = (n) => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.replace(/.*\//, '')}:${n.callFrame.lineNumber + 1}`;
        const walk = (n, open) => {
          const k = keyOf(n);
          let t = (dt.get(n.id) || 0) / 1000;
          const fresh = !open.has(k);
          if (fresh) open.add(k);
          for (const c of n.children || []) t += walk(byId.get(c), open);
          if (fresh) { open.delete(k); incl.set(k, (incl.get(k) || 0) + t); }
          return t;
        };
        walk(profile.nodes[0], new Set());
        // CS2SIM_SMOKE_CALLERS (a regex): who calls the matching functions (four levels up), by time.
        if (process.env.CS2SIM_SMOKE_CALLERS) {
          const re = new RegExp(process.env.CS2SIM_SMOKE_CALLERS), parent = new Map(), chains = new Map();
          for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n);
          const sub = (n) => (dt.get(n.id) || 0) / 1000 + (n.children || []).reduce((s, c) => s + sub(byId.get(c)), 0);
          for (const n of profile.nodes) {
            if (!re.test(keyOf(n))) continue;
            const up = [];
            for (let p = parent.get(n.id); p && up.length < 4; p = parent.get(p.id)) up.push(keyOf(p));
            const k = keyOf(n) + ' <- ' + up.join(' <- ');
            chains.set(k, (chains.get(k) || 0) + sub(n));
          }
          console.log('SMOKE perf', id, 'callers\n' + [...chains].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, t]) => `  ${t.toFixed(0).padStart(6)}  ${k}`).join('\n'));
        }
        console.log('SMOKE perf', id, 'profile, total time\n' + [...incl].filter(([k]) => /\.js:/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 50).map(([k, t]) => `  ${t.toFixed(0).padStart(6)} ${(t / total * 100).toFixed(1).padStart(5)}%  ${k}`).join('\n'));
      }
      const r = JSON.parse(await js(`(() => { const P = window.__perf, f = P.frames.slice(1), n = f.length || 1, g = window.__playGame;
        const avg = (k) => f.reduce((s, x) => s + (x[k] || 0), 0) / n, ms = f.map((x) => x.dt * 1000).sort((a, b) => a - b);
        const gpu = f.filter((x) => x.gpu != null);
        return JSON.stringify({ fps: Math.round(n / ${secs}), p99: +(ms[Math.floor(n * 0.99)] || 0).toFixed(1), worst: +(ms[n - 1] || 0).toFixed(1), hitches: ms.filter((x) => x > 50).length,
          cpu: +avg('cpu').toFixed(2), sim: +avg('sim').toFixed(2), draw: +avg('draw').toFixed(2),
          rWorld: +avg('rWorld').toFixed(2), rSky: +avg('rSky').toFixed(2), rVm: +avg('rVm').toFixed(2), rPost: +avg('rPost').toFixed(2),
          gpu: gpu.length ? +(gpu.reduce((s, x) => s + x.gpu, 0) / gpu.length).toFixed(2) : null,
          calls: Math.round(avg('calls')), tris: Math.round(avg('tris') / 1000) + 'k', bots: g.bots.filter((b) => b.c.alive).length,
          // The slowest frames: how long since the one before, and that frame's own time (simulation, drawing).
          slowest: f.slice().sort((a, b) => b.dt - a.dt).slice(0, 3).map((x) => [Math.round(x.dt * 1000), Math.round(x.cpu), Math.round(x.sim), Math.round(x.draw)].join('/')) }); })()`));
      all.push({ map: id, view: v.name, ...r });
      console.log('SMOKE perf', id, v.name, JSON.stringify(r));
      // CS2SIM_SMOKE_VARIANTS ([[name, js], ...], at the first view): each applied on top of the last, measured again,
      // to see what each part costs.
      if (v !== views[0] || !process.env.CS2SIM_SMOKE_VARIANTS) continue;
      for (const [name, code] of JSON.parse(process.env.CS2SIM_SMOKE_VARIANTS)) {
        await js(`(() => { const g = window.__playGame; ${code}; })(); 1`);
        await wait(800);
        await js(`window.__perf.frames = []; 1`);
        await wait(secs * 1000);
        console.log('SMOKE perf', id, v.name, '+' + name, await js(`(() => { const P = window.__perf, f = P.frames.slice(1), n = f.length || 1;
          const avg = (k) => f.reduce((s, x) => s + (x[k] || 0), 0) / n, gpu = f.filter((x) => x.gpu != null);
          return JSON.stringify({ fps: Math.round(n / ${secs}), cpu: +avg('cpu').toFixed(2), sim: +avg('sim').toFixed(2), draw: +avg('draw').toFixed(2),
            gpu: gpu.length ? +(gpu.reduce((s, x) => s + x.gpu, 0) / gpu.length).toFixed(2) : null, calls: Math.round(avg('calls')), tris: Math.round(avg('tris') / 1000) + 'k' }); })()`));
      }
    }
    console.log('SMOKE perf', id, 'info', await js(`(() => { const g = window.__playGame, m = g.renderer.info.memory;
      const gl = g.renderer.getContext(), di = gl.getExtension('WEBGL_debug_renderer_info');
      return JSON.stringify({ load: ${load.toFixed(1)}, programs: g.renderer.info.programs?.length, geometries: m.geometries, textures: m.textures, gpuTimer: window.__perf.gpuTimer,
        gpuName: di ? gl.getParameter(di.UNMASKED_RENDERER_WEBGL) : '?',
        size: [g.canvas.width, g.canvas.height], quality: { pixelRatio: g.renderer.getPixelRatio(), msaa: g.msaa } }); })()`));
    await js(`document.querySelector('.play-root [data-leave]')?.click(); 1`);
    await wait(2000);
  }
  const avg = (k) => all.reduce((s, x) => s + (x[k] || 0), 0) / (all.length || 1);
  console.log('SMOKE perf all', JSON.stringify({ fps: Math.round(avg('fps')), cpu: +avg('cpu').toFixed(2), sim: +avg('sim').toFixed(2), draw: +avg('draw').toFixed(2), gpu: +avg('gpu').toFixed(2), worstFps: all.reduce((m, x) => (x.fps < m.fps ? x : m), all[0] || {}) }));
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
  // Knives' StatTrak counters read the right way up (their top towards the back of the blade, which is up in the
  // inspect), guns' too: +1 is upright, -1 upside down.
  console.log('SMOKE stattrak knives', await js(`(async () => { try {
    const THREE = await import('three'), { D } = await import('./js/data.js'), { buildCS2Model } = await import('./js/cs2/skin.js');
    const renderer = new THREE.WebGLRenderer(), out = {};
    for (const [wid, name] of [['weapon_knife_karambit', 'Karambit'], ['weapon_knife_butterfly', 'Butterfly'], ['weapon_knife_m9_bayonet', 'M9'], ['weapon_bayonet', 'Bayonet'],
      ['weapon_knife_skeleton', 'Skeleton'], ['weapon_knife_widowmaker', 'Talon'], ['weapon_knife_css', 'Classic'], ['weapon_ak47', 'AK-47'], ['weapon_awp', 'AWP']]) {
      const s = Object.values(D.skins).find((x) => x.wid === wid);
      const m = await buildCS2Model({ t: 'skin', fl: 0, sd: 0, stt: true, kills: 42 }, { ...s, v: true, fid: null }, renderer);
      m.updateMatrixWorld(true);
      let c = null; m.traverse((o) => { if (o.name === 'stattrak') c = o; });
      out[name] = c ? Math.round(new THREE.Vector3(0, 1, 0).transformDirection(c.children[0].matrixWorld).y * 100) / 100 : 'none';
    }
    renderer.dispose();
    return JSON.stringify(out);
  } catch (e) { return 'failed: ' + e.message; } })()`));
  // First person's light: a Karambit | Fade in the studio, then an M9 Bayonet | Doppler (Phase 2) in front of Anubis's
  // bright map (play-first-person-map.png): the weapon's shadows, middle and highlights, how colourful it is, and how
  // bright the (dimmed) map behind it is.
  const fpLook = (name, phase, backdrop) => js(`(async () => { try {
    const ui = await import('./js/ui.js'), I = await import('./js/items.js'), { D } = await import('./js/data.js'), { inspectView: v } = await import('./js/inspect.js');
    document.querySelector('.inspect [data-a=close]')?.click();
    await new Promise((r) => setTimeout(r, 400));
    ui.openInspect(I.makeSkinItem(Object.values(D.skins).find((x) => x.n === ${JSON.stringify(name)} && (!${JSON.stringify(phase)} || x.ph === ${JSON.stringify(phase)})), { stt: false, fl: 0.02, sd: 7 }));
    for (let i = 0; i < 240 && document.querySelector('.inspect .loading'); i++) await new Promise((r) => setTimeout(r, 250));
    await v.setBackdrop(${JSON.stringify(backdrop)});
    await v.enterFirstPerson();
    const fp = v.fp; fp.play(false); fp.update(0); fp.update(2); fp.mixer.timeScale = 0; v.applyLighting();
    const r = v.renderer, gl = r.getContext(), W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    const read = () => { const px = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
    r.setRenderTarget(null); r.render(v.scene, v.fpCamera); const a = read(); fp.rig.visible = false; r.render(v.scene, v.fpCamera); const b = read(); fp.rig.visible = true;
    v.frame(); const all = read();
    const lum = [], map = []; let chroma = 0;
    for (let i = 0; i < a.length; i += 4) {
      const l = (0.2126 * all[i] + 0.7152 * all[i + 1] + 0.0722 * all[i + 2]) / 255;
      if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) >= 12) { lum.push(l); chroma += (Math.max(all[i], all[i + 1], all[i + 2]) - Math.min(all[i], all[i + 1], all[i + 2])) / 255; }
      else if (i % 16 === 0) map.push(l);
    }
    lum.sort((x, y) => x - y); map.sort((x, y) => x - y);
    const q = (arr, p) => Math.round(arr[Math.floor(arr.length * p)] * 100) / 100;
    return JSON.stringify({ exposure: r.toneMappingExposure, shadows: q(lum, 0.05), middle: q(lum, 0.5), highlights: q(lum, 0.95), clippedPct: Math.round((lum.filter((x) => x > 0.97).length / lum.length) * 1000) / 10, colour: Math.round((chroma / lum.length) * 1000) / 1000, ...(${JSON.stringify(backdrop)} === 'studio' ? {} : { map: q(map, 0.5) }) });
  } catch (e) { return 'failed: ' + e.message; } })()`);
  console.log('SMOKE first person light', await fpLook('★ Karambit | Fade', null, 'studio'));
  await wait(1500);
  await shot('first-person-light');
  console.log('SMOKE first person on a map', await fpLook('★ M9 Bayonet | Doppler', 'Phase 2', 'de_anubis'));
  await wait(1500);
  await shot('first-person-map');
  await js(`document.querySelector('.inspect [data-a=close]')?.click(); 1`);
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
    g.input.keys.add('w');
    let kicked = 0;
    for (let i = 0; i < 192; i++) { g.tick(); kicked = Math.max(kicked, speed()); }
    g.input.keys.delete('w');
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
  // Scroll jump, bound from the console like CS2: every wheel notch (what the wheel listener calls) is a jump, so
  // spinning it hops again on each landing; binddefaults puts the wheel back on the weapon switch. Your saved binds
  // are put back afterwards.
  console.log('SMOKE play scroll jump', await js(`(() => { const saved = localStorage.getItem('cs2sim.play'); try {
    const g = window.__playGame, p = g.player, gun = g.arsenal.gun?.id;
    g.console.run('bind mwheelup +jump; bind mwheeldown +jump');
    const bound = [g.input.actionOf('mwheelup'), g.input.actionOf('mwheeldown')];
    for (let i = 0; i < 64 && !p.onGround; i++) g.tick();
    let hops = 0, was = p.onGround;
    for (let i = 0; i < 64 * 4; i++) { if (i % 2 === 0) g.input.notch(i % 4 ? 'mwheelup' : 'mwheeldown'); g.tick(); if (was && !p.onGround && p.velocity[2] > 0) hops++; was = p.onGround; }
    const sameGun = g.arsenal.gun?.id === gun;
    g.console.run('binddefaults');
    for (let i = 0; i < 64 && !p.onGround; i++) g.tick();
    g.input.notch('mwheeldown'); g.tick();
    return JSON.stringify({ bound, hopsIn4s: hops, sameGun, afterDefaults: { wheel: g.input.actionOf('mwheeldown'), jumped: p.velocity[2] > 0 } });
  } catch (e) { return 'failed: ' + e.message; } finally { if (saved === null) localStorage.removeItem('cs2sim.play'); else localStorage.setItem('cs2sim.play', saved); } })()`));
  // A molotov in your hand (the bottle in the right hand, not inside the camera) and its fire in front of you.
  await js(`window.__playGame.giveItem('weapon_molotov')`);
  await wait(2500);
  console.log('SMOKE play molotov in hand', await js(`(async () => { try {
    const THREE = await import('three'); const g = window.__playGame, gun = g.arsenal.gun;
    if (gun?.id !== 'weapon_molotov') return 'holding ' + gun?.id;
    gun.vm.rig.updateMatrixWorld(true);
    const eye = new THREE.Vector3(); g.vmCamera.getWorldPosition(eye);
    const cm = (n) => gun.vm.bones[n] ? Math.round(gun.vm.bones[n].getWorldPosition(new THREE.Vector3()).distanceTo(eye) * 100) : null;
    let bottle = null; gun.vm.rig.traverse((o) => { if (!bottle && o.isSkinnedMesh && /molotov/i.test(o.name)) bottle = o; });
    const bone = bottle?.skeleton.bones.find((b) => /^molotov(_\\d+)?$/.test(b.name))?.name;
    return JSON.stringify({ bottleBone: bone, bottleCm: cm(bone), handCm: cm('hand_R') });
  } catch (e) { return 'failed: ' + e.message; } })()`));
  await shot('molotov-hand');
  await js(`(() => { const g = window.__playGame, eye = g.player.eye(), yr = window.__smokeDir * Math.PI / 180;
    g.input.yaw = window.__smokeDir; g.input.pitch = 12;
    g.nades.fire({ pos: [eye[0] + Math.cos(yr) * 260, eye[1] + Math.sin(yr) * 260, eye[2]], c: g.me, id: 'weapon_molotov', info: { name: 'Molotov' } }); })()`);
  await wait(2500);
  await shot('molotov-fire');
  console.log('SMOKE play molotov fire', await js(`(() => { const g = window.__playGame, f = g.nades.fires[0];
    return f ? JSON.stringify({ flames: f.art.obj.children[0].geometry.instanceCount, light: +g.nades.fireLight.intensity.toFixed(1) }) : 'no fire'; })()`), 'fps', JSON.parse(await state()).fps);
  await wait(6000);
  console.log('SMOKE play molotov burnt out', await js(`(() => { const n = window.__playGame.nades; return JSON.stringify({ fires: n.fires.length, light: n.fireLight.intensity, left: n.group.children.length }); })()`));
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
    // How far into a wall a bot's body (32 wide) is: rays out from its middle at knee and chest height.
    const depth = (p) => { let d = 0; for (const h of [26, 50]) for (let a = 0; a < 8; a++) {
      const hit = g.collision.raycast([p[0], p[1], p[2] + h], [Math.cos(a * Math.PI / 4), Math.sin(a * Math.PI / 4), 0], 16, 2);
      if (hit && Math.abs(hit.normal[2]) < 0.7) d = Math.max(d, 16 - hit.t); } return Math.round(d); };
    const rec = { simSeconds: 240, walkUps: 0, jumps: 0, falls: 0, inWall: 0, rounds: [] }, prev = new Map();
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
        if (n % 8 === 0) rec.inWall = Math.max(rec.inWall, depth(b.pos));
      }
      if (m.round !== r0) { const h = m.history[m.history.length - 1]; rec.rounds.push(h.winner + ':' + h.reason); }
      if (g.me.alive && m.phase === 'live') g.kill(g.me, null, { name: 'World' }, false);
    }
    out.playing = rec;
    // An enemy on A site (a CT kept there, unhurt) and the terrorists taking A by Short and Long: none of them in a wall
    // on the way up (Ts on A: how many got onto the site).
    const A = [1112, 2480, 100], onA = { rounds: 0, inWall: 0, tsOnSite: 0 };
    let held = null, placed = -1, seen = new Set();
    for (let n = 0; n < 200 * 64 && onA.rounds < 2; n++) {
      if (placed !== m.round && m.phase === 'live') {
        placed = m.round; seen = new Set();
        held = g.bots.find((b) => b.c.team === 'CT' && b.c.alive);
        if (held) { held.pos = [A[0], A[1], g.floorAt(A, 200) ?? 96]; held.c.health = 1e6; held.spot = held.pos.slice(); }
        for (const b of g.bots) if (b.c.team === 'T' && b.brain.plan) b.brain.plan.site = 'A';
        if (g.me.alive) g.kill(g.me, null, { name: 'World' }, false);
      }
      const r0 = m.round;
      g.tick();
      if (held?.spot) { held.pos = held.spot.slice(); held.vel = [0, 0, 0]; }
      for (const b of g.bots) if (b.c.alive && b !== held) {
        if (n % 4 === 0) onA.inWall = Math.max(onA.inWall, depth(b.pos));
        if (b.c.team === 'T' && m.siteAt(b.pos)?.site === 'A') seen.add(b);
      }
      if (m.round !== r0) { onA.rounds++; onA.tsOnSite += seen.size; if (held) { held.c.health = 100; held.spot = null; } held = null; }
    }
    out.enemyOnA = onA;
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
  if (process.env.CS2SIM_SMOKE === 'perf') { win.webContents.once('did-finish-load', () => runPerfSmoke(win).catch((e) => { console.error('SMOKE failed', e); app.quit(); })); return; }
  if (process.env.CS2SIM_SMOKE === 'maps') { win.webContents.once('did-finish-load', () => runMapsSmoke(win).catch((e) => { console.error('SMOKE failed', e); app.quit(); })); return; }
  if (process.env.CS2SIM_SMOKE === 'hitch') { win.webContents.once('did-finish-load', () => runHitchSmoke(win).catch((e) => { console.error('SMOKE failed', e); app.quit(); })); return; }
  if (process.env.CS2SIM_SMOKE === 'prepare') { win.webContents.once('did-finish-load', () => runPrepareSmoke(win).catch((e) => { console.error('SMOKE failed', e); app.quit(); })); return; }
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
      const it = I.makeSkinItem(s, { stt: true, fl: 0.05, sd: ${Number(process.env.CS2SIM_SMOKE_SEED) || 661} }); // CS2SIM_SMOKE_SEED picks the pattern
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
app.on('will-quit', () => cs2?.flush());
