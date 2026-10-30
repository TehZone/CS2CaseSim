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
// cdn.steamstatic.com serves the econ icons Steam has no economy image for, e.g. most Gold and souvenir stickers.
const IMAGE_HOSTS = /^https:\/\/(community\.(akamai|cloudflare|fastly)\.steamstatic\.com\/|steamcommunity-a\.akamaihd\.net\/|cdn\.steamstatic\.com\/apps\/730\/|raw\.githubusercontent\.com\/)/;
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
  soundInfo: (events) => cs2.playSoundInfo(events), reverbs: () => cs2.playReverbs(),
  agentModel: (id) => cs2.agentModel(id), stats: () => cs2.playStats(), impacts: () => cs2.playImpacts(), voices: () => cs2.playVoices(), icons: () => cs2.playIcons(),
  ranks: () => cs2.playRanks(), menuIcons: () => cs2.menuIcons(), menuBackdrop: (id) => cs2.menuBackdrop(id), profileArt: () => cs2.profileArt(),
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
  ipcMain.handle('cs2:charm', (_e, mdl, mat) => cs2.charm(mdl, mat));
  ipcMain.handle('cs2:charmAttach', (_e, weapon) => cs2.charmAttach(weapon));
  ipcMain.handle('cs2:weaponMarkup', (_e, weapon) => cs2.weaponMarkup(weapon));
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
  // net_graph 2's log of a match (src/js/play/framelog.js): userData/netgraph-logs/<name>.txt, and shown in its folder.
  const logDir = () => path.join(userDir, 'netgraph-logs');
  ipcMain.handle('app:saveLog', (_e, name, text) => {
    const file = path.join(logDir(), String(name).replace(/[^\w.-]/g, '_').slice(0, 100) + '.txt');
    fs.mkdirSync(logDir(), { recursive: true });
    fs.writeFileSync(file, String(text).slice(0, 64e6));
    return file;
  });
  ipcMain.handle('app:showLog', (_e, file) => {
    const f = path.resolve(String(file));
    if (path.dirname(f) === logDir() && fs.existsSync(f)) shell.showItemInFolder(f);
  });
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
// (CS2SIM_SMOKE_USERDATA: another profile, for a second smoke run beside the first; with CS2SIM_CACHE at the first's
// cs2cache it needs nothing exported again.)
if (SMOKE) app.setPath('userData', process.env.CS2SIM_SMOKE_USERDATA ? path.resolve(process.env.CS2SIM_SMOKE_USERDATA) : path.join(app.getPath('temp'), 'cs2sim-smoke'));
// The frame rate is the monitor's (vsync) unless the player unlocked it in Play's settings (display.json, read at start:
// Chromium only takes these switches before it starts). A perf run always measures as fast as Play goes.
const displayFile = path.join(app.getPath('userData'), 'display.json');
const readDisplay = () => { try { return JSON.parse(fs.readFileSync(displayFile, 'utf8')); } catch { return {}; } };
if (process.env.CS2SIM_SMOKE_ANGLE) app.commandLine.appendSwitch('use-angle', process.env.CS2SIM_SMOKE_ANGLE); // (trying ANGLE's other backends: gl, vulkan, d3d11)
// The JS heap as it is (net_graph 2 and its log: the heap falling is a garbage collection), not rounded and kept for 20 minutes.
app.commandLine.appendSwitch('enable-precise-memory-info');
// Play collects the garbage loading a match leaves (models, textures, parsing) behind the loading screen (window.gc), not
// in a full collection a minute into the match (50 ms or more).
// And no memory reducer: it's V8's way of giving memory back when a page goes quiet, which a game never is, but a match's
// freeze time (bots stood still, little garbage) looked enough like it: a few seconds into every match it made two or
// three full collections in a row to shrink the heap, 35 ms and 70 ms ones, that freed next to nothing, and it kept the
// young generation small, so it was collected three times as often (Mirage, 8 minutes: with it 285 minor collections
// and 12 full, the longest 70 ms; without it 89 and 10, the longest 10 ms, and 14% more frames).
// (CS2SIM_SMOKE_JSFLAGS: V8's own for a run, e.g. --trace-gc; with CS2SIM_SMOKE_NOSANDBOX the page can write V8's log,
// e.g. --log-deopt --logfile=C:/temp/v8.log --no-logfile-per-isolate: every function deoptimized, where and why.)
app.commandLine.appendSwitch('js-flags', ['--expose-gc', '--no-memory-reducer', process.env.CS2SIM_SMOKE_JSFLAGS].filter(Boolean).join(' '));
if (process.env.CS2SIM_SMOKE_NOSANDBOX) app.commandLine.appendSwitch('no-sandbox');
// (A smoke's window keeps drawing, its game and its CSS animations running, when other windows cover it.)
if (SMOKE) { app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion'); app.commandLine.appendSwitch('disable-backgrounding-occluded-windows'); }
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
    await js(`document.querySelector('#topbar [data-page=${page}]').click()`);
    await wait(page === 'team' ? 600 : 1500);
    if (page === 'team') { await js(`document.querySelector('[data-auto]')?.click()`); await wait(1500); }
    await shot(page);
  }
  await js(`document.querySelector('#topbar [data-page=cases]').click(); (async () => { const c = await import('./js/pages/cases.js'); c.openCollectionView('collection-set-cobblestone'); })()`);
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
  await js(`document.querySelector('#topbar [data-page=play]').click(); 1`);
  let ids = (process.env.CS2SIM_SMOKE_MAPS || '').split(',').filter(Boolean);
  for (let i = 0; i < 40 && !ids.length; i++) {
    await wait(500);
    const all = JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('[data-map]')].map((b) => b.dataset.map))`));
    if (all.length > 1) ids = all;
  }
  return ids;
}

// Starts a competitive match on a map (exporting it first if needed), a private one (it starts at once, with the
// lobby's settings): whether it's running (window.__playGame).
async function smokeStartMap(win, id, label) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  await js(`(() => { const k = 'cs2sim.play'; const p = JSON.parse(localStorage.getItem(k) || '{}'); localStorage.setItem(k, JSON.stringify({ ...p, lobby: 'private' })); })();
    window.__cs2Debug = true; window.__playGame = null; document.querySelector('#topbar [data-page=play]').click();
    setTimeout(() => { document.querySelector('[data-map="${id}"]')?.click(); setTimeout(() => document.querySelector('[data-start]').click(), 400); }, 300); 1`);
  const t0 = Date.now();
  for (let i = 0; i < 900; i++) {
    await wait(1000);
    if (await js(`!!window.__playGame?.raf`)) { console.log('SMOKE', label, id, 'loaded in', ((Date.now() - t0) / 1000).toFixed(0), 's'); return true; }
    if (i > 2 && !(await js(`!!document.querySelector('.play-root')`))) break; // it gave up (the error is in a toast)
    if (i % 30 === 29) console.log('SMOKE', label, id, 'loading', await js(`document.querySelector('.play-root [data-status]')?.textContent || ''`));
  }
  console.log('SMOKE', label, id, 'did not load:', await js(`[...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' / ')`));
  await js(`document.querySelector('.play-root [data-cancel]')?.click(); 1`);
  return false;
}

// `CS2SIM_SMOKE=sound` starts a match on Dust II (CS2SIM_SMOKE_MAP) and takes you to some of its soundscapes
// (CS2SIM_SMOKE_PLACES: LowerTunnel,Bbomb...; else the first few): the one you're in, its reverb, and its ambience
// playing; walks you into a bot (you stop at it); then the sounds of the match for a while (gunshots with their
// distant layers) and how CS2 plays some of them.
async function runSoundSmoke(win) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  const map = process.env.CS2SIM_SMOKE_MAP || 'de_dust2';
  await wait(3000);
  if (!(await smokeStartMap(win, map, 'sound'))) { app.quit(); return; }
  const state = () => js(`(() => { const g = window.__playGame, s = g.soundscapes, b = g.sounds;
    return JSON.stringify({ ctx: b.ctx.state, soundscapes: s.list.length, active: s.active?.e || null, room: b.room?.name || null, reverbs: [...b.verbs.keys()].length,
      voices: [...s.voices].map(([e, v]) => e.replace(/^[^.]+\\./, '') + (v.info.rt ? '(now and then)' : v.src ? '(playing)' : '(waiting)')).join(', ') }); })()`);
  await wait(2000);
  console.log('SMOKE sound at the spawn', await state());
  // Your hit sounds at the volume the game plays them (0.8): each layer's volume as it started (none over 0.8).
  console.log('SMOKE sound your hit sounds', await js(`(async () => { const b = window.__playGame.sounds, play = b.play.bind(b), got = [];
    b.play = async (e, o = {}) => { const s = await play(e, o); if (s) got.push(e.replace('Player.', '') + ' ' + s.gainNode.gain.value.toFixed(2)); return s; };
    for (const e of ['Player.DeathHeadShotArmor.AttackerFeedback', 'Player.DeathHeadShot.AttackerFeedback', 'Player.DamageHeadShotArmor.AttackerFeedback', 'Player.DeathBodyArmor.AttackerFeedback', 'Land_Weapon.StepLeft']) {
      await b.load([e]); b.play(e, { volume: 0.8 }); await new Promise((r) => setTimeout(r, 300)); }
    b.play = play; return got.join(', '); })()`));
  console.log('SMOKE sound info', await js(`JSON.stringify(Object.fromEntries(['Weapon_AK47.Single', 'Weapon_AK47.SingleDistant', 'CT_Concrete.StepLeft'].map((e) => [e, window.__playGame.sounds.info[e] || null])))`));
  const places = process.env.CS2SIM_SMOKE_PLACES ? process.env.CS2SIM_SMOKE_PLACES.split(',')
    : JSON.parse(await js(`JSON.stringify([...new Set(window.__playGame.soundscapes.list.map((s) => s.e.replace(/^[^.]+\\./, '')))].slice(0, 6))`));
  for (const where of places) {
    const ok = await js(`(() => { const g = window.__playGame, s = g.soundscapes.list.find((x) => x.e.toLowerCase().endsWith('.' + ${JSON.stringify(where.toLowerCase())}));
      if (!s) return false; g.player.teleport([s.o[0], s.o[1], s.o[2] - 40]); return true; })()`);
    if (!ok) { console.log('SMOKE sound no soundscape', where); continue; }
    await wait(2500);
    console.log('SMOKE sound in', where, await state());
  }
  // Walking into a bot (bot_stop): you stop at it, you don't climb it (as on a ladder, on a map with ladders).
  console.log('SMOKE sound walk into a bot', await js(`(() => { const g = window.__playGame, hull = g.player.hull;
    for (const b of g.bots.filter((x) => x.c.alive)) for (const yaw of [0, 90, 180, 270]) {
      const p = b.pos, a = yaw * Math.PI / 180, from = [p[0] - Math.cos(a) * 120, p[1] - Math.sin(a) * 120, p[2] + 1];
      if (g.collision.traceBox(from, [p[0] - Math.cos(a) * 33, p[1] - Math.sin(a) * 33, p[2] + 1], hull.mins, hull.maxs).fraction < 1) continue; // (a wall in between)
      g.cv.bot_stop = 1; g.player.teleport(from);
      let rise = 0, ladder = false;
      for (let i = 0; i < 64 * 3; i++) { g.player.tick(1 / 64, { forward: 1, side: 0, yaw, pitch: 0, maxSpeed: 250 }); rise = Math.max(rise, g.player.origin[2] - p[2]); ladder ||= !!g.player.onLadder; }
      const gap = Math.hypot(g.player.origin[0] - p[0], g.player.origin[1] - p[1]);
      g.cv.bot_stop = 0;
      return JSON.stringify({ mapHasLadders: g.collision.ladders.size > 0, rise: +rise.toFixed(1), onLadder: ladder, gap: +gap.toFixed(1) });
    }
    return 'no bot with room in front'; })()`));
  // What plays over a while of the match: each event, how often, and how far away.
  await js(`(() => { const g = window.__playGame, b = g.sounds, play = b.play.bind(b); window.__heard = {};
    b.play = (e, o = {}) => { const ear = g.earPos(), d = o.pos ? Math.round(Math.hypot(o.pos[0] - ear[0], o.pos[1] - ear[1], o.pos[2] - ear[2])) : 0;
      const h = (window.__heard[e] ||= { n: 0, near: 1e9, far: 0 }); h.n++; h.near = Math.min(h.near, d); h.far = Math.max(h.far, d); return play(e, o); }; return 1; })()`);
  await wait(+(process.env.CS2SIM_SMOKE_LISTEN || 30000));
  console.log('SMOKE sound heard', await js(`JSON.stringify(Object.entries(window.__heard).sort((a, b) => b[1].n - a[1].n).slice(0, 40).map(([e, h]) => e + ' x' + h.n + (h.far ? ' ' + h.near + '-' + h.far : '')))`));
  app.quit();
}

// `CS2SIM_SMOKE=botfire` times frames on Dust II (CS2SIM_SMOKE_MAP) with the bots stopped and one thing at a time
// going on, ten times a second a bot (CS2SIM_SMOKE_PHASES: idle, shoot-sky: bots firing at nothing, shoot-ground: at the
// floor (impacts), damage-bots: bots taking damage with no one shooting, damage-me: you taking it, scores: Tab held):
// each phase's frame times (between frames, as net_graph's ms), shaders compiled, long tasks and the time in each call.
async function runBotFireSmoke(win) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  const map = process.env.CS2SIM_SMOKE_MAP || 'de_dust2';
  await wait(3000);
  if (!(await smokeStartMap(win, map, 'botfire'))) { app.quit(); return; }
  await wait(4000);
  await js(`(() => { const g = window.__playGame, now = () => performance.now();
    g.console.run('sv_cheats 1'); g.cv.bot_stop = 1;
    const F = window.__bf = { frames: [], calls: {}, long: [], phase: null };
    const frame = g.frame; let prev = 0;
    g.frame = function (dt) { const t = now(); frame.call(this, dt); const e = now(); if (F.phase) F.frames.push({ phase: F.phase, cpu: e - t, int: prev ? t - prev : 0, progs: g.renderer.info.programs?.length || 0 }); prev = t; };
    const wrap = (obj, name, label = name) => { const f = obj[name]; obj[name] = function (...a) { const t = now(); try { return f.apply(this, a); } finally { if (F.phase) ((F.calls[F.phase] ||= {})[label] ||= []).push(now() - t); } }; };
    wrap(g, 'botShoot'); wrap(g, 'damage'); wrap(g, 'fireBullet'); wrap(g.sounds, 'play', 'sound'); wrap(g.effects, 'impact'); wrap(g.effects, 'blood'); wrap(g.hud, 'scoreboard'); wrap(g, 'kill');
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (F.phase) F.long.push({ phase: F.phase, d: e.duration }); }).observe({ type: 'longtask' });
    const held = g.input.held.bind(g.input);
    g.input.held = (k) => (k === 'scores' && F.phase?.startsWith('scores')) || held(k);
    // A phase's +switches turn one thing off for it: +mute (sounds), +noradio (the bots' radio calls), +noflinch (bots
    // flinching when hit), +nohud (your hurt flash).
    const off = { mute: [g.sounds, 'play', async () => undefined], noradio: [g.radio, 'chatter', () => {}], noflinch: [Object.getPrototypeOf(g.bots[0]), 'flinch', () => {}], nohud: [g.hud, 'hurt', () => {}] };
    window.__bfSwitch = (phase) => {
      for (const [k, [obj, name, stub]] of Object.entries(off)) {
        const want = (phase || '').split('+').includes(k);
        if (want && !obj['__real_' + name]) { obj['__real_' + name] = obj[name]; obj[name] = stub; }
        else if (!want && obj['__real_' + name]) { obj[name] = obj['__real_' + name]; delete obj['__real_' + name]; }
      }
    };
    // Each phase's work, a bot every few ticks (as ten shots a second each).
    const tick = g.tick; let n = 0;
    g.tick = function () {
      tick.call(this);
      const p = F.phase?.split('+')[0]; if (!p || p === 'idle' || p === 'scores') return;
      n++;
      const them = g.bots.filter((b) => b.c.alive && b.c.team !== g.me.team).slice(0, 3), mates = g.bots.filter((b) => b.c.alive && b.c.team === g.me.team).slice(0, 3);
      (p === 'damage-me' ? them.slice(0, 1) : [...them, ...mates]).forEach((b, i) => {
        if ((n + i * 2) % 6) return;
        if (p === 'shoot-sky' || p === 'shoot-ground') {
          const gun = b.weapons[b.slot] || Object.values(b.weapons).find((w) => w && !w.melee);
          if (!gun || gun.melee) return;
          gun.clip = Math.max(gun.clip, 5); b.pitch = p === 'shoot-sky' ? -89 : 70;
          g.botShoot(b, gun, g.now, 1);
        } else if (p === 'damage-bots') {
          const c = b.c, body = g.bodyOf(c); c.health = 100;
          g.damage(c, 1, { attacker: g.me.team !== c.team ? g.me : them[0]?.c, group: ['chest', 'head', 'stomach', 'leg'][n % 4], point: body.chest, dir: [1, 0, 0] });
          c.health = 100;
        } else if (p === 'damage-me') {
          g.god = false; g.me.health = 100;
          g.damage(g.me, 1, { attacker: b.c, group: ['chest', 'head', 'stomach', 'leg'][n % 4], point: g.player.eye(), dir: [1, 0, 0] });
          g.me.health = 100;
        }
      });
    };
    return 1; })()`);
  const phases = (process.env.CS2SIM_SMOKE_PHASES || 'idle,shoot-sky,shoot-ground,damage-bots,damage-me,scores,idle2').split(',');
  for (const p of phases) {
    await js(`window.__bfSwitch(${JSON.stringify(p)}); window.__bf.phase = ${JSON.stringify(p)}; 1`);
    await wait(+(process.env.CS2SIM_SMOKE_PHASE_MS || 8000));
  }
  await js(`window.__bfSwitch(null); window.__bf.phase = null; 1`);
  console.log('SMOKE botfire', await js(`(() => { const F = window.__bf, out = {};
    const q = (a, k) => { const s = a.slice().sort((x, y) => x - y); return s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * k))].toFixed(1) : 0; };
    for (const p of [...new Set(F.frames.map((f) => f.phase))]) {
      const fr = F.frames.filter((f) => f.phase === p), ints = fr.map((f) => f.int).filter(Boolean), cpu = fr.map((f) => f.cpu);
      const calls = Object.fromEntries(Object.entries(F.calls[p] || {}).map(([k, v]) => [k, v.length + ' calls, mean ' + (v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) + ' max ' + Math.max(...v).toFixed(1) + ' ms']));
      out[p] = { frames: fr.length, ms: { mean: +(ints.reduce((a, b) => a + b, 0) / Math.max(1, ints.length)).toFixed(1), p95: q(ints, 0.95), p99: q(ints, 0.99), max: +Math.max(0, ...ints).toFixed(1), over25: ints.filter((x) => x > 25).length },
        cpu: { mean: +(cpu.reduce((a, b) => a + b, 0) / Math.max(1, cpu.length)).toFixed(1), max: +Math.max(0, ...cpu).toFixed(1) }, shaders: fr.length ? fr[fr.length - 1].progs - fr[0].progs : 0,
        longTasks: F.long.filter((l) => l.phase === p).map((l) => Math.round(l.d)), calls };
    }
    return JSON.stringify(out, null, 1); })()`));
  app.quit();
}

// `CS2SIM_SMOKE=corpses` times what dead bodies cost on Dust II (CS2SIM_SMOKE_MAP): the bots stopped and lined up in
// front of you, alive, then dead (the round doesn't end: their guns on the floor, not in their hands), and once their
// bodies have gone; each phase's frame times (between frames, as net_graph's ms), the game's own time in the frame,
// drawing and animating.
async function runCorpseSmoke(win) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  const map = process.env.CS2SIM_SMOKE_MAP || 'de_dust2';
  await wait(3000);
  if (!(await smokeStartMap(win, map, 'corpses'))) { app.quit(); return; }
  await wait(4000);
  const lined = await js(`(() => { const g = window.__playGame, now = () => performance.now();
    g.console.run('sv_cheats 1'); g.cv.bot_stop = 1; g.god = true;
    g.match.endRound = () => {}; // (the bodies stay: no round end)
    // The bots in rows in front of you, on the floor.
    const o = g.player.origin, yaw = g.input.yaw * Math.PI / 180, f = [Math.cos(yaw), Math.sin(yaw)], r = [Math.sin(yaw), -Math.cos(yaw)];
    let n = 0;
    for (const b of g.bots) {
      for (let k = 0; k < 40; k++) {
        const along = 180 + (k % 4) * 90 + Math.floor(n / 3) * 70, side = ((n % 3) - 1) * 70 + (Math.floor(k / 4) % 2 ? 35 : 0);
        const x = o[0] + f[0] * along + r[0] * side, y = o[1] + f[1] * along + r[1] * side, z = g.floorAt([x, y, o[2] + 60], 200);
        if (z == null || Math.abs(z - o[2]) > 40) continue;
        b.pos = [x, y, z]; b.vel = [0, 0, 0]; b.brain.body?.teleport(b.pos); n++; break;
      }
    }
    g.input.pitch = 12; g.console.run('net_graph 2');
    const F = window.__cs = { frames: [], phase: null, parts: {} };
    const frame = g.frame; let prev = 0;
    g.frame = function (dt) { const t = now(); frame.call(this, dt); const e = now(); if (F.phase) F.frames.push({ phase: F.phase, cpu: e - t, int: prev ? t - prev : 0 }); prev = t; };
    const wrap = (obj, name, label) => { const f2 = obj[name]; obj[name] = function (...a) { const t = now(); try { return f2.apply(this, a); } finally { if (F.phase) { const p = (F.parts[F.phase] ||= {}); p[label] = (p[label] || 0) + now() - t; } } }; };
    wrap(g.post, 'render', 'draw'); wrap(Object.getPrototypeOf(g.bots[0]), 'animate', 'animate');
    return n; })()`);
  console.log('SMOKE corpses lined up', lined, 'bots in front of you');
  const phase = (p) => js(`window.__cs.phase = ${JSON.stringify(p)}; 1`);
  const ms = +(process.env.CS2SIM_SMOKE_PHASE_MS || 6000);
  await phase('alive'); await wait(ms);
  await js(`(() => { const g = window.__playGame; window.__cs.phase = null; window.__cs.killedAt = performance.now(); for (const b of g.bots) if (b.c.alive) g.kill(b.c, null, { name: 'World' }, false); return 1; })()`);
  await wait(800);
  const bodies = () => js(`(() => { const g = window.__playGame; let guns = 0; for (const b of g.bots) { let n = 0; b.root.traverse((o) => { if (o.isMesh && o.parent && o.parent.parent === b.bones.hand_R) n++; }); if (b.weaponModel || n) guns++; }
    return JSON.stringify({ seconds: +((performance.now() - window.__cs.killedAt) / 1000).toFixed(1), shown: g.bots.filter((b) => b.root.visible).length, holdingGuns: guns, gunsOnTheFloor: g.drops.list.length }); })()`);
  console.log('SMOKE corpses just dead', await bodies());
  await wait(1700); // (their death animations done)
  await phase('dead'); await wait(Math.min(ms, 6000));
  await phase(null);
  fs.writeFileSync(path.join(app.getPath('userData'), 'corpses-dead.png'), (await win.webContents.capturePage()).toPNG());
  console.log('SMOKE corpses lying there', await bodies());
  const left = 12500 - (await js(`performance.now() - window.__cs.killedAt`));
  if (left > 0) await wait(left);
  console.log('SMOKE corpses after a while', await bodies());
  await phase('gone'); await wait(ms);
  await phase(null);
  console.log('SMOKE corpses', await js(`(() => { const F = window.__cs, out = [];
    const q = (a, k) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * k))].toFixed(1) : '0'; };
    for (const p of ['alive', 'dead', 'gone']) {
      const fr = F.frames.filter((f) => f.phase === p), ints = fr.map((f) => f.int).filter(Boolean), n = Math.max(1, fr.length), parts = F.parts[p] || {};
      out.push(p.padEnd(12) + ' ' + fr.length + ' frames  ms mean ' + (ints.reduce((a, b) => a + b, 0) / Math.max(1, ints.length)).toFixed(2) + ' p95 ' + q(ints, 0.95) + ' max ' + Math.max(0, ...ints).toFixed(1)
        + '  game cpu ' + (fr.reduce((a, f) => a + f.cpu, 0) / n).toFixed(2) + '  draw ' + ((parts.draw || 0) / n).toFixed(2) + '  animate ' + ((parts.animate || 0) / n).toFixed(2) + ' (ms a frame)');
    }
    return '\\n' + out.join('\\n'); })()`));
  app.quit();
}

// `CS2SIM_SMOKE=rounds` plays a 5v5 on Dust II (CS2SIM_SMOKE_MAP) round after round (CS2SIM_SMOKE_ROUNDS, default 12:
// short rounds, you dead at the start of each so the bots play it out) and logs each round's frame cost (the game's
// time a frame, its simulation, drawing, animating, HUD) next to everything that could pile up: what's in the scene,
// geometries, textures, shaders, effects, guns on the floor, grenades, the sound bank's lists, the page's elements and
// the JS heap. Something growing round on round is what gets slower.
async function runRoundsSmoke(win) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  const map = process.env.CS2SIM_SMOKE_MAP || 'de_dust2', rounds = +process.env.CS2SIM_SMOKE_ROUNDS || 12;
  await wait(3000);
  if (!(await smokeStartMap(win, map, 'rounds'))) { app.quit(); return; }
  await js(`(() => { const g = window.__playGame, now = () => performance.now();
    g.console.run('sv_cheats 1'); g.console.run('mp_freezetime 6'); g.console.run('mp_roundtime 1.25'); g.console.run('host_timescale ' + ${+process.env.CS2SIM_SMOKE_TIMESCALE || 2});
    // CS2SIM_SMOKE_MAXROUNDS: a match this many rounds long (played to its end screen).
    const maxRounds = ${+process.env.CS2SIM_SMOKE_MAXROUNDS || 0};
    if (maxRounds) Object.assign(g.match.rules, { maxRounds, winsNeeded: maxRounds / 2 + 1, halftime: maxRounds / 2, overtime: false });
    const R = window.__rd = { cur: null, rows: [] };
    const fresh = () => ({ frames: 0, cpu: 0, int: 0, parts: {}, fz: { frames: 0, cpu: 0, int: 0, parts: {} } });
    R.cur = fresh();
    // Freeze time is measured on its own, from the same spot every round (you, where you stood in the first one,
    // looking the same way): nothing going on, so a round costing more there than the last is something left over.
    let spot = null, wasFreeze = false;
    const frame = g.frame; let prev = 0;
    g.frame = function (dt) {
      const fz = g.match.phase === 'freeze' && g.me.alive;
      if (fz && !wasFreeze) { spot ||= { o: g.player.origin.slice(), yaw: g.input.yaw, pitch: g.input.pitch }; g.player.teleport(spot.o); g.input.yaw = spot.yaw; g.input.pitch = spot.pitch; R.fzSkip = 30; }
      wasFreeze = fz;
      const t = now(); frame.call(this, dt); const e = now();
      const c = fz && !(R.fzSkip-- > 0) ? R.cur.fz : R.cur; c.frames++; c.cpu += e - t; if (prev) c.int += t - prev; prev = t; R.in = c;
    };
    const wrap = (obj, name, label) => { const f = obj?.[name]; if (typeof f !== 'function') return; obj[name] = function (...a) { const t = now(); try { return f.apply(this, a); } finally { const c = R.in || R.cur; c.parts[label] = (c.parts[label] || 0) + now() - t; } }; };
    wrap(g, 'tick', 'sim'); wrap(g.post, 'render', 'draw'); wrap(Object.getPrototypeOf(g.bots[0]), 'animate', 'animate'); wrap(g, 'updateHud', 'hud');
    wrap(Object.getPrototypeOf(g.bots[0].brain), 'tick', 'ai'); wrap(g.nades, 'tick', 'nades'); wrap(g.effects, 'update', 'effects'); wrap(g.sounds, 'play', 'sound');
    wrap(g, 'pickups', 'pickups'); wrap(g.drops, 'tick', 'drops'); wrap(g.soundscapes, 'update', 'soundscapes');
    // Draw calls a frame (net_graph 2 counts the whole frame's), audio nodes made, and event listeners added but not taken
    // off again (a pile of either is something not let go of).
    g.console.run('net_graph 2');
    R.audioNodes = 0; R.listeners = 0;
    for (const m of ['createGain', 'createBufferSource', 'createPanner', 'createBiquadFilter', 'createConvolver']) {
      const f = BaseAudioContext.prototype[m]; BaseAudioContext.prototype[m] = function (...a) { R.audioNodes++; return f.apply(this, a); };
    }
    const add = EventTarget.prototype.addEventListener, rem = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function (...a) { if (!(this instanceof AudioNode)) R.listeners++; return add.apply(this, a); };
    EventTarget.prototype.removeEventListener = function (...a) { if (!(this instanceof AudioNode)) R.listeners--; return rem.apply(this, a); };
    const callsWas = g.graphFrame; R.calls = 0;
    g.graphFrame = function (...a) { R.calls += this.renderer.info.render.calls; return callsWas.apply(this, a); };
    // At each round's end: its frames, and what's there now.
    const count = (o) => { let n = 0; o.traverse(() => n++); return n; };
    const materials = () => { const s = new Set(); g.scene.traverse((o) => { if (o.material) [].concat(o.material).forEach((m) => s.add(m)); }); return s.size; };
    const size = (m) => (m instanceof Map || m instanceof Set ? m.size : Array.isArray(m) ? m.length : m && typeof m === 'object' ? Object.keys(m).length : 0);
    R.snap = () => { const c = R.cur, n = Math.max(1, c.frames), info = g.renderer.info, b = g.sounds, z = c.fz, nz = Math.max(1, z.frames);
      R.rows.push({ round: g.match.round, 'FREEZE frames': z.frames, 'freeze ms': +(z.int / nz).toFixed(2), 'freeze cpu': +(z.cpu / nz).toFixed(2),
        ...Object.fromEntries(Object.entries(z.parts).map(([k, v]) => ['freeze ' + k, +(v / nz).toFixed(2)])),
        'ROUND frames': c.frames, ms: +(c.int / n).toFixed(1), cpu: +(c.cpu / n).toFixed(2), ...Object.fromEntries(Object.entries(c.parts).map(([k, v]) => [k, +(v / n).toFixed(2)])),
        draws: Math.round(R.calls / n), materials: materials(), botObjects: g.bots.reduce((s, x) => s + count(x.root), 0), audioNodes: R.audioNodes, listeners: R.listeners,
        scene: count(g.scene), vm: count(g.vmScene), geo: info.memory.geometries, tex: info.memory.textures, progs: info.programs?.length || 0,
        particles: g.effects.particles.length, tracers: g.effects.tracers.length, gibs: g.effects.gibList.length, holes: g.effects.holes.count, effectsGroup: g.effects.group.children.length,
        floorGuns: g.drops.list.length, flying: g.nades.flying.length, fires: g.nades.fires?.length || 0, smokes: size(g.nades.smokes),
        playing: [...b.playing.values()].reduce((s, l) => s + l.length, 0), playingKeys: b.playing.size, lastStart: b.lastStart.size, buffers: b.buffers.size, events: size(b.events),
        dom: document.getElementsByTagName('*').length, heapMB: +((performance.memory?.usedJSHeapSize || 0) / 1e6).toFixed(0), pings: g.pings.length });
      R.cur = fresh(); R.in = null; R.calls = 0; R.audioNodes = 0; };
    const end = g.match.endRound.bind(g.match);
    g.match.endRound = (...a) => { const r = end(...a); R.snap(); return r; };
    return 1; })()`);
  // You: dead once each round's freeze time is over, so the bots play it out. CS2SIM_SMOKE_PLAY=1: first you buy a rifle
  // and every grenade in the freeze time, then fire and throw them all (as CS2SIM_SMOKE=hitch does).
  const play = !!process.env.CS2SIM_SMOKE_PLAY;
  let last = -1, boughtFor = -1, actedFor = -1;
  for (let i = 0; i < 3000; i++) {
    await wait(1000);
    const st = JSON.parse(await js(`JSON.stringify({ round: window.__playGame?.match.round, phase: window.__playGame?.match.phase, alive: window.__playGame?.me.alive, over: !!window.__playGame?.matchOver, rows: window.__rd.rows.length })`));
    if (st.over || st.rows >= rounds || !st.phase) break;
    if (play && st.phase === 'freeze' && st.alive && boughtFor !== st.round) {
      boughtFor = st.round;
      await js(`(async () => { const g = window.__playGame; g.console.run('impulse 101');
        for (const w of [g.me.team === 'T' ? 'weapon_ak47' : 'weapon_m4a1', 'weapon_smokegrenade', 'weapon_flashbang', 'weapon_hegrenade', g.me.team === 'T' ? 'weapon_molotov' : 'weapon_incgrenade', 'vesthelm']) { try { await g.buy(w); } catch {} }
        return 1; })()`);
    }
    if (play && st.phase === 'live' && st.alive && actedFor !== st.round) {
      actedFor = st.round;
      await js(`(async () => { const g = window.__playGame, inp = g.input, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const s = g.map.info.bombsites[0], o = g.player.origin, to = [(s.min[0] + s.max[0]) / 2, (s.min[1] + s.max[1]) / 2];
        inp.yaw = Math.atan2(to[1] - o[1], to[0] - o[0]) * 180 / Math.PI; inp.pitch = -8;
        g.arsenal.select('primary', g.now); await sleep(700); inp.down('mouse1'); await sleep(600); inp.up('mouse1'); await sleep(300);
        for (const n of ['weapon_smokegrenade', 'weapon_flashbang', 'weapon_hegrenade', 'weapon_molotov', 'weapon_incgrenade']) {
          if (!g.arsenal.guns['g_' + n] || !g.me.alive) continue;
          g.arsenal.select('g_' + n, g.now); await sleep(700); inp.down('mouse1'); await sleep(300); inp.up('mouse1'); await sleep(500);
        }
        return 1; })()`);
    }
    if (st.phase === 'live' && st.alive && (!play || actedFor === st.round)) await js(`(() => { const g = window.__playGame; if (g.me.alive) g.kill(g.me, null, { name: 'World' }, false); return 1; })()`);
    if (st.round !== last) { last = st.round; console.log('SMOKE rounds round', st.round); }
  }
  if (process.env.CS2SIM_SMOKE_MAXROUNDS) {
    await wait(3000);
    console.log('SMOKE rounds end screen: ' + await js(`[...(document.querySelector('[data-end]')?.children || [])].map((e) => e.textContent.replace(/\\s+/g, ' ').trim()).filter(Boolean).join(' | ')`));
    fs.writeFileSync(path.join(app.getPath('userData'), 'rounds-end.png'), (await win.webContents.capturePage()).toPNG());
  }
  const rows = JSON.parse(await js(`JSON.stringify(window.__rd.rows)`));
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  console.log('SMOKE rounds per round:\n' + keys.map((k) => k.padEnd(13) + rows.map((r) => String(r[k] ?? '').padStart(7)).join('')).join('\n'));
  // net_graph 2's own log of the run (src/js/play/framelog.js), saved as the game saves it.
  const log = await js(`window.__playGame.log?.save()`);
  if (log) console.log(`SMOKE rounds net_graph log ${log}:\n` + fs.readFileSync(log, 'utf8').split('\n').slice(0, 90).join('\n'));
  console.log('SMOKE rounds net_graph kept for the next match: ' + await js(`JSON.parse(localStorage.getItem('cs2sim.play') || '{}').netGraph`));
  app.quit();
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
  await js(`document.querySelector('#topbar [data-page=stats]').click(); 1`);
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
    // CS2SIM_SMOKE_LIVE: what the JS heap holds once the first map is loaded and collected (a sampling heap profile of
    // what's still alive then, by where it was made: a big heap makes every full collection long).
    const live = process.env.CS2SIM_SMOKE_LIVE && !totals.length ? win.webContents.debugger : null;
    const heapMB = async () => Math.round(await js('window.gc?.(), (performance.memory?.usedJSHeapSize || 0) / 1e6'));
    if (live) {
      if (!live.isAttached()) live.attach('1.3');
      console.log('SMOKE hitch heap before the match', await heapMB(), 'MB');
      await live.sendCommand('HeapProfiler.enable');
      await live.sendCommand('HeapProfiler.startSampling', { samplingInterval: 32768 });
    }
    if (!(await smokeStartMap(win, id, 'hitch'))) continue;
    if (live) {
      await wait(3000);
      console.log('SMOKE hitch heap with the match loaded', await heapMB(), 'MB');
      // The JS heap itself against what's held outside it (array buffers: performance.memory counts both), and how long
      // a full collection takes.
      const u = await live.sendCommand('Runtime.getHeapUsage');
      console.log('SMOKE hitch heap usage', JSON.stringify(Object.fromEntries(Object.entries(u).map(([k, v]) => [k, Math.round(v / 1e6) + ' MB']))));
      console.log('SMOKE hitch full collections (ms)', await js(`(() => { const r = []; for (let i = 0; i < 3; i++) { const t = performance.now(); window.gc(); r.push(+(performance.now() - t).toFixed(1)); } return r.join(', '); })()`));
      const { profile } = await live.sendCommand('HeapProfiler.stopSampling');
      const self = new Map(), total = new Map();
      const key = (n) => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.replace(/.*\//, '')}:${n.callFrame.lineNumber + 1}`;
      let all = 0;
      const walk = (n, path) => {
        const k = key(n), size = n.selfSize || 0;
        all += size;
        self.set(k, (self.get(k) || 0) + size);
        const p = path.includes(k) ? path : [...path, k];
        for (const kk of new Set(p)) total.set(kk, (total.get(kk) || 0) + size);
        for (const c of n.children || []) walk(c, p);
      };
      walk(profile.head, []);
      const mb = (b) => (b / 1e6).toFixed(1).padStart(7);
      console.log(`SMOKE hitch the match holds ${(all / 1e6).toFixed(0)} MB it made; by own allocations:\n` + [...self].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, b]) => `  ${mb(b)} MB  ${k}`).join('\n'));
      console.log('SMOKE hitch what it holds by total (with what they call):\n' + [...total].filter(([k]) => /\.m?js:/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 50).map(([k, b]) => `  ${mb(b)} MB  ${k}`).join('\n'));
    }
    // The room's ducking (CS2's reverb compressor, an audio worklet): the game's is running, and a loud sound turns it
    // down as far as it should.
    console.log('SMOKE hitch room ducking', await js(`(async () => { const c = new OfflineAudioContext(2, 48000, 48000); await c.audioWorklet.addModule('./js/play/ducker.worklet.js');
      const d = new AudioWorkletNode(c, 'cs2-room-ducker', { numberOfInputs: 2, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
      const room = new ConstantSourceNode(c, { offset: 0.1 }), key = new ConstantSourceNode(c, { offset: 0.5 });
      room.connect(d, 0, 0); key.connect(d, 0, 1); d.connect(c.destination); room.start(); key.start();
      const out = (await c.startRendering()).getChannelData(0);
      return 'in the game: ' + (window.__playGame.sounds.ducker ? 'running' : 'not running') + '; under a loud sound the room is ' + (20 * Math.log10(out[out.length - 1] / 0.1)).toFixed(1) + ' dB'; })()`));
    await js(`(() => { const g = window.__playGame, gl = g.renderer.getContext(), now = () => performance.now();
      document.querySelector('.play-pause')?.classList.add('hidden'); g.paused = false;
      g.console.run('sv_cheats 1');
      // CS2SIM_SMOKE_TAB: Tab held through freeze time (the scoreboard up while you buy); =tap: pressed and let go four
      // times a second.
      if (${!!process.env.CS2SIM_SMOKE_TAB}) { const tap = ${JSON.stringify(process.env.CS2SIM_SMOKE_TAB)} === 'tap', held = g.input.held.bind(g.input);
        g.input.held = (k, ...a) => (k === 'scores' && g.match.phase === 'freeze' && (!tap || Math.floor(performance.now() / 125) % 2 === 0)) || held(k, ...a); }
      // CS2SIM_SMOKE_NOGC: no forced collections (the game's own at round start): V8's own, wherever they come.
      if (${!!process.env.CS2SIM_SMOKE_NOGC}) window.gc = undefined;
      const H = window.__hitch = { t0: now(), ints: [], slow: [], events: [], long: [], cur: null, prev: 0, lastEnd: 0, outside: {} };
      const add = (o, k, v) => { o[k] = (o[k] || 0) + v; };
      const heap = () => performance.memory?.usedJSHeapSize || 0;
      // The game's parts, timed inside the frame.
      const wrap = (obj, name, label) => { const f = obj?.[name]; if (typeof f !== 'function') return;
        // (Its arguments named, not gathered into an array: the wrapper's own garbage would count as the game's.)
        obj[name] = function (a, b, c, d, e) { const t = now(); try { return f.call(this, a, b, c, d, e); } finally { if (H.cur) add(H.cur.p, label, now() - t); } }; };
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
      ev(g, 'botShoot', 'botShoot', (b) => b.c.name); ev(g, 'damage', 'damage', (c) => (c === g.me ? 'you' : 'bot')); ev(g.hud, 'hurt', 'hurt'); ev(g.radio, 'say', 'radio');
      ev(g.match, 'startRound', 'startRound'); ev(g.match, 'endRound', 'endRound'); ev(g, 'buy', 'buy', (w) => w); ev(g.drops, 'drop', 'drop', (gun) => gun?.id || '');
      ev(g.effects, 'explosion', 'explosion'); ev(g.effects, 'flashPop', 'flashPop'); ev(g.match, 'planted', 'planted'); ev(g.match, 'defused', 'defused');
      ev(g.match, 'exploded', 'bombExploded'); ev(g, 'restartMatch', 'restartMatch'); ev(window, 'gc', 'gc'); ev(g.sounds, 'setRoom', 'setRoom', (n) => n); ev(g.nades, 'fire', 'fire'); ev(g.nades, 'smoke', 'smoke'); ev(g.nades, 'explodeHE', 'he');
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
      // What each shader program compiled mid-match was for (the object drawn, its material, the shadow pass or not), and
      // the materials whose disposal took one with them (the next one like it compiles it again).
      const R = g.renderer, rbd = R.renderBufferDirect, upTo = (o) => { const n = []; for (let x = o; x && n.length < 5; x = x.parent) n.push(x.name || x.type); return n.join(' < '); };
      R.renderBufferDirect = function (cam, scene, geo, mat, obj, group) {
        const p0 = info.programs.length, r = rbd.call(this, cam, scene, geo, mat, obj, group);
        if (info.programs.length > p0) {
          // (With what made it new: the fields of its key unlike the program it had, or the nearest one with its name.)
          const progs = [...(R.properties.get(mat).programs?.values() || [])], mine = progs.at(-1), key = String(mine?.cacheKey || '').split(',');
          const other = progs.length > 1 ? progs[0] : info.programs.filter((pr) => pr !== mine && pr.name === mine?.name).sort((x, y) => diffOf(x).length - diffOf(y).length)[0];
          function diffOf(pr) { const k = String(pr.cacheKey).split(','); return key.map((v, i) => (v !== k[i] ? i + ':' + k[i] + '>' + v : null)).filter(Boolean); }
          const w = upTo(obj) + ' [' + (mat.name || mat.type) + (scene ? '' : ', shadow') + ']' + (other ? ' unlike ' + (progs.length > 1 ? 'its last' : 'one like it') + ': ' + diffOf(other).slice(0, 8).join(' ') : ' (none like it)');
          (H.made2 ||= []).push(((now() - H.t0) / 1000).toFixed(1) + 's ' + w); if (H.cur) (H.cur.newFor ||= []).push(w); }
        return r;
      };
      let MP = null;
      g.scene.traverse((o) => { if (MP || !o.material || Array.isArray(o.material)) return; let p = Object.getPrototypeOf(o.material); while (p && !Object.prototype.hasOwnProperty.call(p, 'setValues')) p = Object.getPrototypeOf(p); MP = p; });
      if (MP) { const d = MP.dispose; MP.dispose = function () { const p0 = info.programs.length, r = d.apply(this, arguments);
        if (info.programs.length < p0) (H.released ||= []).push(((now() - H.t0) / 1000).toFixed(1) + 's ' + (this.name || this.type) + ' < ' + (new Error().stack || '').split('\\n').slice(2, 5).map((l) => l.trim().replace(/^at /, '').replace(/\\(.*\\/(.*?):(\\d+):\\d+\\)/, '$1:$2')).join(' < '));
        return r; }; }
      // CS2SIM_SMOKE_BREAK: every breakable broken 8 s in (what that compiles, all at once), and which of their meshes
      // (whole, and what's left once broken) have no shader yet.
      if (${!!process.env.CS2SIM_SMOKE_BREAK}) {
        const none = [];
        for (const p of g.doors?.panes || []) for (const [k, list] of [['whole', p.meshes], ['left', p.after]]) for (const m of list || []) for (const mt of [].concat(m.material)) if (!R.properties.get(mt).programs?.size) none.push(k + ' ' + (mt.name || mt.type) + (m.visible ? '' : ' (hidden)') + ' ' + Object.keys(m.geometry.attributes).join('/'));
        console.log('SMOKE hitch breakables without a shader: ' + (none.join(' | ') || 'none'));
        setTimeout(() => { for (const p of g.doors?.panes || []) if (!p.broken) g.doors.breakPane(p); }, 8000);
      }
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
        if (c.int) { H.ints.push(c.int); (H.all ||= []).push([t, c.int]); }
        // By the round's phase: frames, over 33 ms, and waits over 20 ms between one frame's end and the next's start.
        if (c.int) { const ph = (H.phases ||= {})[g.match?.phase || '?'] ||= [0, 0, 0]; ph[0]++; if (c.int > 33) ph[1]++; if (c.gap > 20) ph[2]++; }
        if (c.int > 33 || c.cpu > 25) H.slow.push(c);
      };
      return 1; })()`);
    // CS2SIM_SMOKE_PROFILE: a CPU profile of the first map's run, split into the work inside frames and between them.
    const prof = process.env.CS2SIM_SMOKE_PROFILE && !totals.length ? win.webContents.debugger : null;
    // CS2SIM_SMOKE_ALLOC: where the garbage comes from (a sampling heap profile of the first map's run, freed objects too;
    // =promoted, only those that outlived the young generation).
    const alloc = process.env.CS2SIM_SMOKE_ALLOC && !totals.length ? win.webContents.debugger : null;
    if (alloc) {
      if (!alloc.isAttached()) alloc.attach('1.3');
      await alloc.sendCommand('HeapProfiler.enable');
      // (=promoted: only what lived long enough to leave the young generation, the garbage that full collections are
      // for: what died young left out.)
      const promoted = process.env.CS2SIM_SMOKE_ALLOC === 'promoted';
      await alloc.sendCommand('HeapProfiler.startSampling', { samplingInterval: promoted ? 4096 : 16384, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: !promoted });
    }
    let profAt = 0; // performance.now() when it started (to line its samples up with the frames)
    if (prof) {
      if (!prof.isAttached()) prof.attach('1.3');
      await prof.sendCommand('Profiler.enable'); await prof.sendCommand('Profiler.setSamplingInterval', { interval: 200 });
      const before = await js('performance.now()'); await prof.sendCommand('Profiler.start'); profAt = (before + await js('performance.now()')) / 2;
    }
    // CS2SIM_SMOKE_TRACE=round: a Chromium trace of that round's freeze time (Tab held too with CS2SIM_SMOKE_TAB), every
    // process, saved to userData/hitch-trace.json: what the browser does between frames, which a CPU profile only shows
    // as "(program)".
    const traceRound = !totals.length && +process.env.CS2SIM_SMOKE_TRACE;
    // CS2SIM_SMOKE_TRACE_LIVE=round: the same through that whole round, its freeze time and the bots playing it out with
    // you dead.
    const traceLive = !totals.length && +process.env.CS2SIM_SMOKE_TRACE_LIVE;
    let liveTrace = false;
    const { contentTracing } = require('electron');
    const traceFile = path.join(app.getPath('userData'), 'hitch-trace.json');
    // CS2SIM_SMOKE_GCTRACE: V8's collections through the whole run (a trace of only them): how many, and how long each
    // held the main thread.
    const gcTrace = !!process.env.CS2SIM_SMOKE_GCTRACE && !traceLive && !traceRound;
    if (gcTrace) await contentTracing.startRecording({ included_categories: ['disabled-by-default-v8.gc'], excluded_categories: ['*'] });
    // You: a rifle and every grenade each round, a few shots and the grenades thrown, then dead (the bots play it out).
    const t0 = Date.now();
    let round = -1;
    while (Date.now() - t0 < secs * 1000) {
      const st = JSON.parse(await js(`JSON.stringify({ round: window.__playGame?.match.round, phase: window.__playGame?.match.phase, alive: window.__playGame?.me.alive, over: !!window.__playGame?.matchOver })`));
      if (liveTrace && st.round !== traceLive) { liveTrace = false; console.log('SMOKE hitch trace of round', traceLive, 'saved to', await contentTracing.stopRecording(traceFile)); }
      if (!st.phase || st.over) break;
      if (st.round !== round && st.phase === 'freeze' && st.alive) {
        round = st.round;
        const tracing = st.round === traceRound;
        if (st.round === traceLive) liveTrace = true;
        // (A whole round's is the tasks on every thread, V8's collections, what the page draws and the GPU's work: the
        // freeze time's categories over a round came to a gigabyte.)
        // (CS2SIM_SMOKE_TRACE_CATS: the round's trace of these categories instead, comma-separated: e.g. V8's compiling.)
        if (tracing || liveTrace) await contentTracing.startRecording({ included_categories: process.env.CS2SIM_SMOKE_TRACE_CATS ? process.env.CS2SIM_SMOKE_TRACE_CATS.split(',') : liveTrace ? ['toplevel', 'devtools.timeline', 'gpu', 'viz', 'v8', 'disabled-by-default-v8.gc']
          : ['toplevel', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink', 'cc', 'gpu', 'viz', 'v8', 'disabled-by-default-v8.gc', 'loading', 'benchmark', 'renderer.scheduler', 'blink.user_timing'], excluded_categories: ['*'] });
        // CS2SIM_SMOKE_BUYMENU: bought with the buy menu open (a buy a second, as you'd click them), left open through the
        // freeze time.
        const menu = !!process.env.CS2SIM_SMOKE_BUYMENU;
        await js(`(async () => { const g = window.__playGame; g.console.run('impulse 101');
          const rifle = g.me.team === 'T' ? 'weapon_ak47' : 'weapon_m4a1';
          if (${menu}) g.openBuyMenu();
          for (const w of [rifle, 'weapon_smokegrenade', 'weapon_flashbang', 'weapon_hegrenade', g.me.team === 'T' ? 'weapon_molotov' : 'weapon_incgrenade', 'vesthelm']) { try { await g.buy(w); } catch {} if (${menu}) await new Promise((r) => setTimeout(r, 1000)); }
          return 1; })()`);
        for (let i = 0; i < 40 && JSON.parse(await js(`JSON.stringify(window.__playGame?.match.phase)`)) === 'freeze'; i++) await wait(500);
        if (menu) await js(`window.__playGame.closeBuyMenu(), 1`);
        if (tracing) console.log('SMOKE hitch trace of round', st.round, 'saved to', await contentTracing.stopRecording(traceFile));
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
    if (liveTrace) console.log('SMOKE hitch trace of round', traceLive, 'saved to', await contentTracing.stopRecording(traceFile));
    if (gcTrace) {
      const file = await contentTracing.stopRecording(path.join(app.getPath('userData'), 'hitch-gc.json'));
      const evs = JSON.parse(fs.readFileSync(file, 'utf8')).traceEvents, names = new Map();
      for (const e of evs) if (e.ph === 'M' && e.name === 'thread_name') names.set(e.pid + ':' + e.tid, e.args.name);
      const sum = {};
      for (const e of evs) if (e.ph === 'X' && names.get(e.pid + ':' + e.tid) === 'CrRendererMain' && /^V8\.GC_(SCAVENGER|MARK_COMPACTOR|MC_INCREMENTAL)$/.test(e.name)) {
        const k = sum[e.name] ||= { n: 0, ms: 0, max: 0 }; k.n++; k.ms += e.dur / 1000; k.max = Math.max(k.max, e.dur / 1000);
      }
      console.log('SMOKE hitch collections on the main thread over', secs, 's:', JSON.stringify(Object.fromEntries(Object.entries(sum).map(([k, v]) => [k, { n: v.n, ms: +v.ms.toFixed(0), max: +v.max.toFixed(1) }]))));
    }
    if (alloc) {
      const { profile } = await alloc.sendCommand('HeapProfiler.stopSampling');
      const self = new Map(), total = new Map();
      const key = (n) => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.replace(/.*\//, '')}:${n.callFrame.lineNumber + 1}`;
      let all = 0;
      // The biggest allocators' callers (CS2SIM_SMOKE_ALLOC_CALLERS: a regex of which; by default the builtins').
      const chains = new Map(), callersOf = new RegExp(process.env.CS2SIM_SMOKE_ALLOC_CALLERS || '^(next|sort|map|values|entries|join|slice|filter|forEach|reduce|concat|split|replace|toFixed|String) ');
      const walk = (n, path) => {
        const k = key(n), size = n.selfSize || 0;
        all += size;
        self.set(k, (self.get(k) || 0) + size);
        if (size && callersOf.test(k)) { const c = k + ' <- ' + path.slice(-4).reverse().join(' <- '); chains.set(c, (chains.get(c) || 0) + size); }
        const p = path.includes(k) ? path : [...path, k];
        for (const kk of new Set(p)) total.set(kk, (total.get(kk) || 0) + size);
        for (const c of n.children || []) walk(c, p);
      };
      walk(profile.head, []);
      const mb = (b) => (b / 1e6).toFixed(1).padStart(7);
      console.log(`SMOKE hitch allocated ${(all / 1e6).toFixed(0)} MB; by own allocations:\n` + [...self].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([k, b]) => `  ${mb(b)} MB  ${k}`).join('\n'));
      console.log('SMOKE hitch biggest allocators, by caller:\n' + [...chains].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, b]) => `  ${mb(b)} MB  ${k}`).join('\n'));
      console.log('SMOKE hitch allocations by total (with what they call):\n' + [...total].filter(([k]) => /\.js:/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, b]) => `  ${mb(b)} MB  ${k}`).join('\n'));
    }
    if (prof) {
      const { profile } = await prof.sendCommand('Profiler.stop');
      const byId = new Map(profile.nodes.map((nd) => [nd.id, nd])), parent = new Map();
      for (const nd of profile.nodes) for (const c of nd.children || []) parent.set(c, nd);
      const keyOf = (nd) => `${nd.callFrame.functionName || '(anon)'} ${nd.callFrame.url.replace(/.*\//, '')}:${nd.callFrame.lineNumber + 1}`;
      const sets = { inside: new Map(), outside: new Map(), outsideSelf: new Map(), outsideRoots: new Map(), slowSelf: new Map(), slowTotal: new Map(), gapSelf: new Map(), gapRoots: new Map() };
      let tin = 0, tout = 0, tslow = 0, tgap = 0;
      // The frames that took over 18 ms of their own, in the profile's time (ms from its start).
      const slowFrames = JSON.parse(await js(`JSON.stringify(window.__hitch.slow.filter((c) => c.cpu > 18).map((c) => [c.t, c.t + c.cpu]))`)).map(([a, b]) => [a - profAt, b - profAt]);
      // And the long waits between frames (over 25 ms from one frame's end to the next one's start).
      const slowGaps = JSON.parse(await js(`JSON.stringify(window.__hitch.slow.filter((c) => c.gap > 25).map((c) => [c.t - c.gap, c.t]))`)).map(([a, b]) => [a - profAt, b - profAt]);
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
          if (slowGaps.some(([a, b]) => at >= a && at <= b)) { tgap += dt; sets.gapSelf.set(leaf, (sets.gapSelf.get(leaf) || 0) + dt); sets.gapRoots.set(js3, (sets.gapRoots.get(js3) || 0) + dt); }
        }
      });
      const list = (m, n = 25) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([kk, t]) => `  ${t.toFixed(0).padStart(7)}  ${kk}`).join('\n');
      console.log(`SMOKE hitch profile: ${tin.toFixed(0)} ms in frames, ${tout.toFixed(0)} ms between frames`);
      // The functions V8 deoptimized (it compiles a function again each time: a function deoptimized over and over is
      // code made and thrown away all match), with why.
      const deopts = new Map();
      for (const nd of profile.nodes) if (nd.deoptReason) { const kk = keyOf(nd) + ': ' + nd.deoptReason; deopts.set(kk, (deopts.get(kk) || 0) + 1); }
      console.log('SMOKE hitch deoptimized functions (profile nodes):\n' + [...deopts].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([kk, n]) => `  ${String(n).padStart(5)}  ${kk}`).join('\n'));
      console.log('SMOKE hitch between frames, by total time:\n' + list(sets.outside, 40));
      console.log('SMOKE hitch between frames, by own time:\n' + list(sets.outsideSelf, 25));
      console.log('SMOKE hitch between frames, by task (outermost JS):\n' + list(sets.outsideRoots, 25));
      console.log('SMOKE hitch in frames, by total time:\n' + list(sets.inside, 30));
      console.log(`SMOKE hitch in the ${slowFrames.length} slow frames (${tslow.toFixed(0)} ms), by total time:\n` + list(sets.slowTotal, 45));
      console.log('SMOKE hitch in the slow frames, by own time:\n' + list(sets.slowSelf, 25));
      console.log(`SMOKE hitch in the ${slowGaps.length} long waits between frames (${tgap.toFixed(0)} ms busy), by own time:\n` + list(sets.gapSelf, 25));
      console.log('SMOKE hitch in the long waits, by task (outermost JS):\n' + list(sets.gapRoots, 20));
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
          + (evs.length ? '\\n          events: ' + [...new Set(evs)].slice(0, 8).join(', ') : '') + (c.progNames ? '\\n          new programs: ' + c.progNames : '')
          + (c.newFor ? '\\n          compiled for: ' + [...new Set(c.newFor)].join(' | ') : ''); });
      // What the slow frames (over 33 ms) follow: how often a kind of event came in the frame before one, against how
      // often it came before any frame (the same share: nothing to do with it).
      const kinds = ['botShoot', 'damage you', 'damage bot', 'hurt', 'kill', 'radio', 'throw', 'detonate'], ev2 = H.events.slice().sort((a, b) => a.t - b.t);
      const near = (t, int, kind) => { let lo = 0, hi = ev2.length; const from = t - int - 30; while (lo < hi) { const m = (lo + hi) >> 1; if (ev2[m].t < from) lo = m + 1; else hi = m; }
        for (let i = lo; i < ev2.length && ev2[i].t <= t; i++) if (ev2[i].what.startsWith(kind)) return true; return false; };
      const all = H.all || [], slowAll = all.filter(([, i]) => i > 33);
      const follows = kinds.map((k) => k + ': ' + Math.round(100 * slowAll.filter(([t, i]) => near(t, i, k)).length / Math.max(1, slowAll.length)) + '% of slow frames, ' + Math.round(100 * all.filter(([t, i]) => near(t, i, k)).length / Math.max(1, all.length)) + '% of all').join('; ');
      return JSON.stringify({ frames: H.ints.length, p50: q(0.5), p99: q(0.99), p999: q(0.999), worst: q(1), over33: ints.filter((x) => x > 33).length, over50: ints.filter((x) => x > 50).length, over100: ints.filter((x) => x > 100).length, follows,
        rounds: window.__playGame.match.round, reentered: H.reentered || 0, compiled: H.made2 || [], released: H.released || [], phases: H.phases,
        uploads: Object.entries(H.stacks || {}).sort((a, b) => b[1][1] - a[1][1]).slice(0, 12).map(([k, v]) => v[0] + 'x ' + v[1].toFixed(0) + ' ms  ' + k)
          .concat(Object.entries(H.made || {}).sort((a, b) => b[1][0] - a[1][0]).slice(0, 8).map(([k, v]) => v[0] + ' textures made in frames  ' + k)), slow }); })()`));
    console.log('SMOKE hitch', id, 'slow texture uploads (count, total, size, where):\n' + (r.uploads || []).map((l) => '  ' + l).join('\n'));
    console.log('SMOKE hitch', id, 'shaders compiled mid-match, for:\n' + r.compiled.map((l) => '  ' + l).join('\n'));
    console.log('SMOKE hitch', id, 'shaders released (a material disposed):\n' + r.released.map((l) => '  ' + l).join('\n'));
    console.log('SMOKE hitch', id, JSON.stringify({ ...r, slow: undefined, uploads: undefined, compiled: r.compiled.length, released: r.released.length }));
    console.log('SMOKE hitch', id, 'slowest frames (when, frame interval, own CPU, gap before it):\n' + r.slow.join('\n'));
    totals.push({ id, ...r, slow: undefined, uploads: undefined });
    await js(`document.querySelector('.play-root [data-leave]')?.click(); 1`);
    await wait(2500);
  }
  console.log('SMOKE hitch all', JSON.stringify(totals));
  app.quit();
}

// `CS2SIM_SMOKE=bots` watches the bots play: for each map (CS2SIM_SMOKE_MAPS, default Dust II and Mirage) and rank tier
// (CS2SIM_SMOKE_TIERS, default silver and global), a competitive match for CS2SIM_SMOKE_SECONDS (default 150) with you dead
// (spectating), logging each round's plans (the terrorists' strat, site and buy, the CTs' setup, who throws which lineup),
// every lineup thrown and how far from its spot it landed, kills, plants and who won; and a scoreboard screenshot
// (userData/bots-<map>-<tier>.png: the bots' real players and ranks).
// And how they behave, from what any version of them shows (where they are, where they look and go, what they shoot),
// every tick: aiming at an enemy behind a wall (one it hasn't been able to see for a second, within 4 degrees of its
// crosshair; and following one that way as it moves), held up by another player (on its way, hardly moving, someone
// within 52 units), where it holds (staring at a wall, how far it sees that way, cover round it, whether it watches a way
// in to the site, the same spot as an earlier round, a teammate on top of it), and its fights (from when it has an
// enemy in sight as its target: how far off its aim is 0.1 to 1 s on, how fast it turns, its first shot, its first hit).
const botMetricsJs = `(() => { const g = window.__playGame, D2R = Math.PI / 180, BULLET = 2;
  const M = window.__botMetrics = { ticks: 0, botTicks: 0, wallTicks: 0, wallTurning: 0, wallWhy: {}, tracks: [], blockedTicks: 0, blocked: [], stuckTicks: 0, stuck: [], holds: [], eng: [], kills: 0, hs: 0, rounds: new Set() };
  const seen = new Map(), streak = new Map(), runs = new Map(), engOf = new Map(), cur = new Map(), prevAng = new Map();
  const live = () => g.match.phase === 'live' || g.match.phase === 'planted';
  const ang = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) / D2R;
  const unit = (from, to) => { const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]], l = Math.hypot(d[0], d[1], d[2]) || 1; return [d[0] / l, d[1] / l, d[2] / l, l]; };
  const visible = (eye, e) => { const body = g.bodyOf(e); return g.lineOfSight(eye, body.head) || g.lineOfSight(eye, body.chest); };
  const posOf = (x) => (x === g.me ? g.player.origin : g.botOf(x).pos);
  // (A follow: half a second or more on one hidden enemy as they moved 48+ units and its view turned 8+ degrees with them.)
  const endStreak = (b) => { const s = streak.get(b); streak.delete(b); if (s && s.n >= 32 && s.moved >= 48 && s.turned >= 8) M.tracks.push({ secs: +(s.n / 64).toFixed(2), moved: Math.round(s.moved), turned: Math.round(s.turned), why: s.why }); };
  const run = (key, on, list) => { const n = runs.get(key) || 0; if (on) { runs.set(key, n + 1); return; } if (n >= 64 && list) list.push(+(n / 64).toFixed(1)); runs.set(key, 0); };
  const sample = () => {
    if (!live()) return;
    M.ticks++;
    const now = g.now, every = M.ticks % 8 === 0;
    M.rounds.add(g.match.round);
    for (const b of g.bots) {
      const c = b.c;
      if (!c.alive) { endStreak(b); run('b' + b.index, false, M.blocked); run('s' + b.index, false, M.stuck); continue; }
      M.botTicks++;
      const eye = b.eye(), fwd = g.viewDir(c), br = b.brain;
      let on = null;
      for (const e of g.combatants) {
        if (!e.alive || !g.hostile(c, e)) continue;
        const key = b.index + ':' + e.name, body = g.bodyOf(e), u = unit(eye, body.head);
        if (u[3] > 3500) continue;
        if (every && visible(eye, e)) seen.set(key, now);
        if (ang(fwd, u) > 4) continue;
        if (visible(eye, e)) { seen.set(key, now); continue; }
        if (now - (seen.get(key) ?? -99) > 1) { on = { e, feet: body.feet.slice() }; break; }
      }
      if (on) {
        M.wallTicks++;
        // Why it looks there, as its brain has it: fighting someone, where it last saw or heard an enemy, holding an
        // angle, on the move, or something else.
        const why = br.target?.visible ? 'fight' : br.lastSeen && now - br.lastSeen.t < 4 ? 'lastSeen' : br.heard && now - br.heard.t < 3 ? 'heard' : br.task === 'hold' ? 'hold' : Math.hypot(b.vel[0], b.vel[1]) > 30 ? 'moving' : 'other';
        M.wallWhy[why] = (M.wallWhy[why] || 0) + 1;
        const p0 = prevAng.get(b), turn = p0 ? Math.hypot(((((b.yaw - p0[0] + 180) % 360) + 360) % 360) - 180, b.pitch - p0[1]) : 0;
        if (turn * 64 > 10) M.wallTurning++;
        const s = streak.get(b);
        if (s && s.e === on.e) { s.n++; s.turned += turn; s.moved = Math.max(s.moved, Math.hypot(on.feet[0] - s.from[0], on.feet[1] - s.from[1])); }
        else { endStreak(b); streak.set(b, { e: on.e, n: 1, from: on.feet, moved: 0, turned: 0, why }); }
      } else endStreak(b);
      const speed = Math.hypot(b.vel[0], b.vel[1]);
      const going = !!(br.path && br.path.length && br.task !== 'hold' && b.mode === 'move' && !b.climbing);
      const near = going && speed < 30 && g.combatants.some((x) => { if (x === c || !x.alive) return false; const p = posOf(x); return Math.hypot(p[0] - b.pos[0], p[1] - b.pos[1]) < 52 && Math.abs(p[2] - b.pos[2]) < 72; });
      if (near) M.blockedTicks++;
      run('b' + b.index, near, M.blocked);
      if (going && speed < 30) M.stuckTicks++;
      run('s' + b.index, going && speed < 30, M.stuck);
      if (br.task === 'hold' && speed < 20) {
        const mine = M.holds.filter((h) => h.round === g.match.round && h.bot === c.name);
        if (!mine.some((h) => Math.hypot(h.pos[0] - b.pos[0], h.pos[1] - b.pos[1]) < 150)) M.holds.push({ round: g.match.round, bot: c.name, team: c.team, phase: g.match.phase, pos: b.pos.slice(), yaw: br.holdYaw ?? b.yaw, nth: mine.length, order: !!br.order });
      }
      const prev = prevAng.get(b), yp = [b.yaw, b.pitch];
      prevAng.set(b, yp);
      const rate = prev ? Math.hypot(((((yp[0] - prev[0] + 180) % 360) + 360) % 360) - 180, yp[1] - prev[1]) * 64 : 0;
      const tg = br.target;
      if (tg && tg.visible && tg.c.alive) {
        const k = b.index + ':' + tg.c.name, body = g.bodyOf(tg.c), u = unit(eye, body.head);
        let en = engOf.get(k);
        if (!en || now - en.last > 2) {
          en = { bot: c.name, skill: +(c.skill ?? 0).toFixed(2), c: tg.c, t0: now, last: now, d: Math.round(u[3]), err0: +ang(fwd, u).toFixed(1), err: {}, peak: 0, shot: null, hit: null, shots: 0 };
          M.eng.push(en); engOf.set(k, en);
        }
        en.last = now; cur.set(b, en);
        const dt = now - en.t0;
        for (const at of [0.1, 0.2, 0.3, 0.5, 1]) if (dt >= at - 1e-9 && en.err[at] == null) en.err[at] = +ang(fwd, u).toFixed(2);
        if (dt < 1.5) en.peak = Math.max(en.peak, Math.round(rate));
      }
    }
  };
  const tick = g.tick; g.tick = function (...a) { const r = tick.apply(this, a); sample(); return r; };
  const shoot = g.botShoot; g.botShoot = function (b, ...a) { const en = cur.get(b); if (en && g.now - en.last < 0.25) { en.shots++; if (en.shot == null) en.shot = +(g.now - en.t0).toFixed(3); } return shoot.call(this, b, ...a); };
  const damage = g.damage; g.damage = function (c, dmg, o = {}) {
    const b = o.attacker?.bot ? g.botOf(o.attacker) : null, en = b && cur.get(b);
    if (en && en.c === c && en.hit == null && c.alive) en.hit = { dt: +(g.now - en.t0).toFixed(3), head: o.group === 'head', shots: en.shots };
    return damage.call(this, c, dmg, o); };
  const kill = g.kill; g.kill = function (c, a, w, hs, ...r) { if (c.alive && a?.bot && a !== c) { M.kills++; if (hs) M.hs++; } return kill.call(this, c, a, w, hs, ...r); };
  const med = (xs) => { const a = xs.filter((x) => x != null && !Number.isNaN(x)).sort((p, q) => p - q); return a.length ? a[Math.floor(a.length / 2)] : null; };
  const pct = (n, d) => (d ? +((100 * n) / d).toFixed(1) : null);
  // The ways into each bomb site: the nav paths there from the terrorists' spawn, mid and the other site, a point every 48 units.
  const ways = new Map();
  const waysTo = (s) => {
    if (ways.has(s.site)) return ways.get(s.site);
    const center = [(s.min[0] + s.max[0]) / 2, (s.min[1] + s.max[1]) / 2, s.min[2] + 8], pts = [];
    const mid = g.map.info.places.find((x) => /^Middle$/i.test(x.name)) || g.map.info.places.find((x) => /mid/i.test(x.name));
    const other = g.map.info.bombsites.find((x) => x.site !== s.site);
    const from = [g.enemySpawnCenter('CT'), mid && [(mid.min[0] + mid.max[0]) / 2, (mid.min[1] + mid.max[1]) / 2, mid.min[2]], other && [(other.min[0] + other.max[0]) / 2, (other.min[1] + other.max[1]) / 2, other.min[2]]].filter(Boolean);
    for (const f of from) {
      const p = g.nav.path(f, center)?.points || [];
      for (let i = 1; i < p.length; i++) { const l = Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]); for (let s2 = 0; s2 < l; s2 += 48) { const k = s2 / l; pts.push([p[i - 1][0] + (p[i][0] - p[i - 1][0]) * k, p[i - 1][1] + (p[i][1] - p[i - 1][1]) * k, p[i - 1][2] + (p[i][2] - p[i - 1][2]) * k + 60]); } }
    }
    ways.set(s.site, pts);
    return pts;
  };
  M.report = () => {
    for (const b of g.bots) { endStreak(b); run('b' + b.index, false, M.blocked); run('s' + b.index, false, M.stuck); }
    const holds = M.holds.map((h) => {
      const eye = [h.pos[0], h.pos[1], h.pos[2] + 64], yr = h.yaw * D2R, dir = [Math.cos(yr), Math.sin(yr), 0];
      const view = g.collision.raycast(eye, dir, 4000, BULLET), sight = view ? view.t : 4000;
      let cover = 0;
      for (let k = 0; k < 16; k++) { const a = (k / 16) * Math.PI * 2; if (g.collision.raycast([h.pos[0], h.pos[1], h.pos[2] + 40], [Math.cos(a), Math.sin(a), 0], 100, BULLET)) cover++; }
      const sites = g.map.info.bombsites.map((s) => ({ s, d: Math.hypot(h.pos[0] - (s.min[0] + s.max[0]) / 2, h.pos[1] - (s.min[1] + s.max[1]) / 2) })).sort((a, b) => a.d - b.d);
      const site = sites[0] && sites[0].d < 1800 ? sites[0].s : null;
      let watches = null;
      if (site && h.team === 'CT' && h.phase === 'live') watches = waysTo(site).some((p) => { const u = unit(eye, p); return u[3] > 250 && u[3] < 3000 && ang(dir, [u[0], u[1], 0].map((v, i, a) => v / (Math.hypot(a[0], a[1]) || 1))) < 50 && g.lineOfSight(eye, p); });
      return { ...h, pos: h.pos.map(Math.round), yaw: Math.round(h.yaw), site: site?.site || null, sight: Math.round(sight), stare: sight < 200, cover, watches };
    });
    // The same spot again: a bot's first hold of a round within 150 units of its first hold of an earlier round on that side.
    const firsts = holds.filter((h) => h.nth === 0 && h.phase === 'live' && !h.order);
    let again = 0, later = 0;
    for (const h of firsts) {
      const before = firsts.filter((x) => x.bot === h.bot && x.team === h.team && x.round < h.round);
      if (!before.length) continue;
      later++;
      if (before.some((x) => Math.hypot(x.pos[0] - h.pos[0], x.pos[1] - h.pos[1]) < 150)) again++;
    }
    const crowded = holds.filter((h) => holds.some((x) => x !== h && x.round === h.round && x.team === h.team && Math.hypot(x.pos[0] - h.pos[0], x.pos[1] - h.pos[1]) < 80)).length;
    const ctLive = holds.filter((h) => h.watches != null);
    const eng = M.eng.map(({ c, last, ...e }) => e);
    const hits = eng.filter((e) => e.hit);
    const bt = Math.max(1, M.botTicks);
    return {
      summary: {
        rounds: M.rounds.size, botSeconds: Math.round(M.botTicks / 64),
        wallAimPct: pct(M.wallTicks, bt), wallAimTurningPct: pct(M.wallTurning, bt), wallWhy: M.wallWhy, wallFollows: M.tracks.length, wallFollowSecs: +M.tracks.reduce((s, t) => s + t.secs, 0).toFixed(1),
        blockedSecsPerRound: +(M.blockedTicks / 64 / Math.max(1, M.rounds.size)).toFixed(1), blockedOver1s: M.blocked.length, blockedOver3s: M.blocked.filter((x) => x >= 3).length,
        stuckSecsPerRound: +(M.stuckTicks / 64 / Math.max(1, M.rounds.size)).toFixed(1), stuckOver3s: M.stuck.filter((x) => x >= 3).length,
        holds: holds.length, stareAtWallPct: pct(holds.filter((h) => h.stare).length, holds.length), medianSight: med(holds.map((h) => h.sight)), medianCover: med(holds.map((h) => h.cover)),
        ctWatchesWayInPct: pct(ctLive.filter((h) => h.watches).length, ctLive.length), sameSpotAgainPct: pct(again, later), crowdedPct: pct(crowded, holds.length),
        fights: eng.length, firstShotS: med(eng.map((e) => e.shot)), firstHitS: med(hits.map((e) => e.hit.dt)), firstHitHeadPct: pct(hits.filter((e) => e.hit.head).length, hits.length),
        shotsToFirstHit: med(hits.map((e) => e.hit.shots)), err0: med(eng.map((e) => e.err0)),
        err100ms: med(eng.map((e) => e.err[0.1])), err200ms: med(eng.map((e) => e.err[0.2])), err300ms: med(eng.map((e) => e.err[0.3])), err500ms: med(eng.map((e) => e.err[0.5])), err1s: med(eng.map((e) => e.err[1])),
        headWithin1degAt200msPct: pct(eng.filter((e) => e.err[0.2] != null && e.err[0.2] < 1).length, eng.filter((e) => e.err[0.2] != null).length),
        peakTurnDegS: med(eng.map((e) => e.peak)), kills: M.kills, headshotKillPct: pct(M.hs, M.kills),
      },
      holds, eng: eng.slice(0, 400), tracks: M.tracks, blocked: M.blocked,
    };
  };
  return 1; })()`;

// `CS2SIM_SMOKE=aspect` checks the video settings' aspect ratios: a match on Dust II (CS2SIM_SMOKE_MAP) in a 1600×900
// window, three bots stopped in front of you, then each of: the window's own shape, 4:3 stretched, 4:3 with black bars,
// 4:3 stretched at 1280×960, 16:10 with black bars. For each: the resolution drawn at, where the screen is, the camera's
// aspect, the radar's and the crosshair's shape on screen, whether a click on the buy menu lands on the tile under it,
// and a screenshot (userData/aspect-<name>.png).
async function runAspectSmoke(win) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  const map = process.env.CS2SIM_SMOKE_MAP || 'de_dust2';
  win.setContentSize(1600, 900);
  await wait(3000);
  await js(`(() => { const k = 'cs2sim.play'; const p = JSON.parse(localStorage.getItem(k) || '{}'); localStorage.setItem(k, JSON.stringify({ ...p, mode: 'competitive', map: '${map}', teamSize: 5, aspect: 'native' })); })(); 1`);
  await js(`document.querySelector('#topbar [data-page=stats]').click(); setTimeout(() => document.querySelector('#topbar [data-page=play]').click(), 200); 1`);
  await wait(1500);
  // The lobby's video settings: 4:3 picked, what it offers then (and back to the window's).
  console.log('SMOKE aspect settings: ' + await js(`(async () => { const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), q = (s) => document.querySelector(s);
    const pick = async (s, v) => { const el = q(s); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); await sleep(300); };
    const opts = (s) => q(s) ? [...q(s).options].map((o) => o.textContent.trim()).join(' / ') : 'none';
    const before = opts('[data-s="root.aspect"]');
    await pick('[data-s="root.aspect"]', '4:3');
    const out = 'aspect ratios: ' + before + '; at 4:3, scaling: ' + opts('[data-s="root.scaling"]') + '; resolutions: ' + opts('[data-s="root.resolution"]') + '; render scale shown: ' + !!q('[data-s="root.renderScale"]');
    await pick('[data-s="root.resolution"]', '1280x960');
    const after = '; at 1280×960, render scale shown: ' + !!q('[data-s="root.renderScale"]') + ', saved ' + JSON.stringify((({ aspect, scaling, resolution }) => ({ aspect, scaling, resolution }))(JSON.parse(localStorage.getItem('cs2sim.play'))));
    await pick('[data-s="root.aspect"]', 'native');
    return out + after; })()`));
  if (!(await smokeStartMap(win, map, 'aspect'))) return app.quit();
  await js(`(async () => { const g = window.__playGame, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('.play-pause')?.classList.add('hidden'); g.paused = false;
    const css = document.createElement('style'); css.textContent = '.play-click, .play-scrim { display: none !important; }'; document.head.appendChild(css);
    g.console.run('sv_cheats 1'); g.cv.bot_stop = 1; g.god = true;
    if (g.match.phase === 'freeze') { g.match.time = 0; await sleep(400); } g.match.time = 9999;
    const o = g.player.origin, yaw = g.input.yaw * Math.PI / 180;
    g.bots.filter((b) => b.c.alive).slice(0, 3).forEach((b, i) => {
      const d = 160 + i * 80, side = (i - 1) * 70, p = [o[0] + Math.cos(yaw) * d + Math.sin(yaw) * side, o[1] + Math.sin(yaw) * d - Math.cos(yaw) * side, o[2] + 40];
      b.pos = [p[0], p[1], g.floorAt(p, 300) ?? o[2]]; b.vel = [0, 0, 0]; b.yaw = b.bodyYaw = g.input.yaw + 180; b.pitch = 0; b.hasPrev = false;
    });
    g.input.pitch = 2; return 1; })()`);
  const configs = [['native', {}], ['4x3-stretched', { aspect: '4:3', scaling: 'stretched' }], ['4x3-bars', { aspect: '4:3', scaling: 'bars' }],
    ['4x3-stretched-1280x960', { aspect: '4:3', scaling: 'stretched', resolution: '1280x960' }], ['16x10-bars', { aspect: '16:10', scaling: 'bars' }]];
  for (const [name, set] of configs) {
    console.log(`SMOKE aspect ${name}: ` + await js(`(async () => { const g = window.__playGame, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      g.applySettings({ ...g.settings, aspect: 'native', scaling: 'stretched', resolution: 'native', ...${JSON.stringify(set)} }, null);
      await sleep(1200);
      const r = (el) => { const b = el?.getBoundingClientRect(); return b ? Math.round(b.width) + '×' + Math.round(b.height) + ' at ' + Math.round(b.left) + ',' + Math.round(b.top) : 'none'; };
      // The buy menu: is the tile under a click the tile?
      g.buyMenu.open(); await sleep(300);
      const tile = g.buyMenu.el.querySelector('[data-buy], [data-item], button'), tb = tile?.getBoundingClientRect();
      const hit = tb && document.elementFromPoint(tb.left + tb.width / 2, tb.top + tb.height / 2);
      const clickOk = !!tile && (hit === tile || tile.contains(hit));
      g.buyMenu.close();
      return 'drawn at ' + g.canvas.width + '×' + g.canvas.height + ', screen ' + r(g.screen) + ', camera aspect ' + g.camera.aspect.toFixed(3)
        + ', radar ' + r(document.querySelector('.play-radar')) + ', crosshair arm ' + r(document.querySelector('.play-hud .xhair i'))
        + ', buy menu ' + r(g.buyMenu.el.firstElementChild) + ' (a click on a tile hits it: ' + clickOk + ')'; })()`));
    await wait(600);
    win.webContents.invalidate();
    await js('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    fs.writeFileSync(path.join(app.getPath('userData'), `aspect-${name}.png`), (await win.webContents.capturePage()).toPNG());
  }
  app.quit();
}

// `CS2SIM_SMOKE=winbanner` plays out each way a round ends on Dust II (CS2SIM_SMOKE_MAP), the real way, with the bots
// stopped: the CTs win by eliminating the terrorists, by defusing the bomb and by the time running out, the terrorists
// by eliminating the CTs and by the bomb exploding. For each it logs the win panel (where it is, its colours and text,
// the MVP) a second in, how long it stays and the next round's message, with a screenshot (userData/winbanner-*.png;
// CS2SIM_SMOKE_ASPECT=4:3 plays them stretched to 4:3).
async function runWinSmoke(win) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  const map = process.env.CS2SIM_SMOKE_MAP || 'de_dust2';
  win.setContentSize(1600, 900);
  await wait(3000);
  await js(`(() => { const k = 'cs2sim.play'; const p = JSON.parse(localStorage.getItem(k) || '{}'); localStorage.setItem(k, JSON.stringify({ ...p, mode: 'competitive', map: '${map}', teamSize: 5, aspect: 'native' })); })(); 1`);
  if (!(await smokeStartMap(win, map, 'winbanner'))) return app.quit();
  await js(`(() => { const g = window.__playGame;
    document.querySelector('.play-pause')?.classList.add('hidden'); g.paused = false;
    const css = document.createElement('style'); css.textContent = '.play-click, .play-scrim { display: none !important; }'; document.head.appendChild(css);
    g.console.run('sv_cheats 1'); g.cv.bot_stop = 1;
    if (${JSON.stringify(process.env.CS2SIM_SMOKE_ASPECT || '')}) g.applySettings({ ...g.settings, aspect: ${JSON.stringify(process.env.CS2SIM_SMOKE_ASPECT || '')}, scaling: 'stretched', resolution: 'native' }, null);
    return 1; })()`);
  const cases = [['ct-elimination', 'CT'], ['ct-defuse', 'CT'], ['ct-time', 'CT'], ['t-elimination', 'T'], ['t-bomb', 'T']];
  for (const [name] of cases) {
    // To the next round's live phase, then end it this way.
    console.log(`SMOKE winbanner ${name}: ` + await js(`(async () => { const g = window.__playGame, m = g.match, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 200 && m.phase !== 'freeze' && m.phase !== 'live'; i++) await sleep(100);
      if (m.phase === 'freeze') { m.time = 0; await sleep(300); }
      const killSide = (side) => { g.console.run('bot_kill ' + side.toLowerCase()); if (g.me.team === side && g.me.alive) g.kill(g.me, null, { name: 'World' }, false); };
      const site = (g.map.info.bombsites || [])[0], sitePos = site && [(site.min[0] + site.max[0]) / 2, (site.min[1] + site.max[1]) / 2, site.min[2] + 2];
      const plant = () => { const t = g.combatants.find((c) => c.team === 'T' && c.alive); t.hasC4 = true; m.planted(t, g.onFloor(sitePos)); };
      const name = '${name}';
      if (name === 'ct-elimination') killSide('T');
      else if (name === 'ct-defuse') { plant(); await sleep(500); m.bomb.defuser = g.combatants.find((c) => c.team === 'CT' && c.alive); m.defused(); }
      else if (name === 'ct-time') m.time = 0.01;
      else if (name === 't-elimination') killSide('CT');
      else if (name === 't-bomb') { plant(); await sleep(500); m.bomb.plantedAt = g.now - m.rules.bombTime; }
      const t0 = performance.now();
      for (let i = 0; i < 100 && m.phase !== 'end'; i++) await sleep(20);
      await sleep(1000);
      const el = g.hud.q('[data-win]'), q = (s) => el.querySelector(s), r = (e) => { const b = e?.getBoundingClientRect(); return b ? Math.round(b.width) + '×' + Math.round(b.height) + ' at ' + Math.round(b.left) + ',' + Math.round(b.top) : 'none'; };
      const title = q('[data-win-title]'), tcs = getComputedStyle(title.parentElement), box = getComputedStyle(q('.wp-result'));
      window.__winShown = t0;
      return JSON.stringify({ phase: m.phase, last: m.history.at(-1), cls: el.className, opacity: getComputedStyle(el).opacity, screen: r(g.screen),
        box: r(q('.wp-result')) + ' ' + box.backgroundColor + ' border ' + box.borderLeftColor + ' ' + box.borderLeftWidth,
        title: '"' + title.textContent + '" ' + r(title) + ' ' + tcs.fontSize + ' ' + tcs.color + ' fit ' + (tcs.getPropertyValue('--fit') || '1'),
        why: '"' + q('[data-win-why]').textContent + '" ' + r(q('[data-win-why]')),
        mvp: '"' + q('[data-win-reason]').textContent + '" / "' + q('[data-win-name]').textContent + '" ' + r(q('.wp-mvp')) + (q('[data-win-avatar] img') ? ' with avatar' : ' no avatar'),
        announcer: (m.history.at(-1)?.winner === 'CT' ? 'Event.CTWin ' : 'Event.TERWin ') + (g.sounds.has(m.history.at(-1)?.winner === 'CT' ? 'Event.CTWin' : 'Event.TERWin') ? 'loaded' : 'missing'),
        oldBanner: g.hud.q('[data-msg]').className, score: m.score });
    })()`));
    win.webContents.invalidate();
    await js('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    fs.writeFileSync(path.join(app.getPath('userData'), `winbanner-${name}${process.env.CS2SIM_SMOKE_ASPECT ? '-' + process.env.CS2SIM_SMOKE_ASPECT.replace(':', 'x') : ''}.png`), (await win.webContents.capturePage()).toPNG());
    // How long it stays (until the next round starts), and that round's message.
    console.log(`SMOKE winbanner ${name} shown for: ` + await js(`(async () => { const g = window.__playGame, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 120 && g.hud.q('[data-win]').classList.contains('show'); i++) await sleep(100);
      await sleep(400);
      const msg = g.hud.q('[data-msg]'), b = msg.getBoundingClientRect();
      return ((performance.now() - window.__winShown) / 1000).toFixed(1) + ' s, until the phase is ' + g.match.phase + '; then "' + (msg.classList.contains('show') ? msg.textContent : '') + '" ' + getComputedStyle(msg).display + ' ' + Math.round(b.width) + ' wide, centred at ' + Math.round(b.left + b.width / 2); })()`));
  }
  app.quit();
}

// `CS2SIM_SMOKE=fire` checks molotovs and smokes on a map (CS2SIM_SMOKE_MAP, else Mirage) against CS2: a molotov in
// front of you burns 7 s (userData/fire-<s>s.png at 1, 4, 6, 6.5 and 6.9 s), a smoke dropped on one puts it out as it
// pops (before its fuse: it pops in the flames; userData/fire-smoked.png), and a molotov dropped into a smoke goes
// straight out.
async function runFireSmoke(win) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => {
    win.webContents.invalidate();
    await js('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    fs.writeFileSync(path.join(app.getPath('userData'), `fire-${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  const map = process.env.CS2SIM_SMOKE_MAP || 'de_mirage';
  await wait(3000);
  if (!(await smokeStartMap(win, map, 'fire'))) { app.quit(); return; }
  await js(`(async () => { const g = window.__playGame, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('.play-pause')?.classList.add('hidden'); g.paused = false;
    g.console.run('sv_cheats 1'); g.god = true;
    if (g.match.phase === 'freeze') { g.match.time = 0; await sleep(300); }
    g.match.time = 9999;
    for (const b of g.bots) { b.brain.tick = () => { b.vel = [0, 0, 0]; }; b.brain.scan = () => {}; b.root.visible = false; } // (none in the way)
    // A spot on the floor in front of you, looked down at; grenades dropped onto it.
    const eye = g.bodyOf(g.me).eye, f = g.viewDir(g.me), h = Math.hypot(f[0], f[1]) || 1;
    const x = eye[0] + (f[0] / h) * 300, y = eye[1] + (f[1] / h) * 300, z = g.floorAt([x, y, eye[2]], 400) ?? eye[2] - 64;
    g.input.pitch = 22;
    window.__fire = { at: [x, y, z], drop: (id) => g.nades.throw(g.me, id, [x, y, z + 40], [0, 0, -60]) };
    return 1; })()`);
  const t = (code) => js(`(() => { const g = window.__playGame, N = g.nades, F = window.__fire; ${code} })()`);
  // 1. How long one burns.
  await t(`F.drop('weapon_molotov'); return 1;`);
  for (let i = 0; i < 40 && !(await t(`return N.fires.length;`)); i++) await wait(50);
  // (When it goes out, on the game's clock: watched every frame, as the screenshots hold up the checks from here.)
  const born = await t(`F.born = N.fires[0]?.born; const f = N.fires[0]; const watch = () => { if (N.fires.includes(f)) requestAnimationFrame(watch); else F.out = g.now; }; if (f) watch(); return F.born;`);
  for (const at of [1, 4, 6, 6.5, 6.9]) {
    // (The game slowed for the last ones: a screenshot takes a moment.)
    if (at === 6) await t(`g.console.run('host_timescale 0.1'); return 1;`);
    while ((await t(`return g.now - F.born;`)) < at) await wait(20);
    await shot(at + 's');
  }
  await t(`g.console.run('host_timescale 1'); return 1;`);
  while (await t(`return N.fires.length;`)) await wait(20);
  await wait(100);
  const burn = await t(`return +(F.out - F.born).toFixed(2);`);
  console.log(`SMOKE fire ${map}: a molotov burned ${burn} s (CS2: 7)${born == null ? ' (it never caught)' : ''}`);
  // 2. A smoke dropped on one.
  await t(`N.clear(); F.drop('weapon_molotov'); return 1;`);
  await wait(1500);
  await t(`F.burning = N.fires.length; F.thrown = g.now; F.drop('weapon_smokegrenade'); return 1;`);
  for (let i = 0; i < 60 && !(await t(`return N.volume.fields.length;`)); i++) await wait(25);
  const smoked = JSON.parse(await t(`return JSON.stringify({ burning: F.burning, left: N.fires.length, popped: N.volume.fields.length ? +(N.volume.fields[0].born - F.thrown).toFixed(2) : null });`));
  await wait(600);
  await shot('smoked');
  console.log(`SMOKE fire ${map}: a smoke dropped on a burning molotov (${smoked.burning} fire) popped ${smoked.popped} s after it was thrown (its fuse: 1.2 s) and left ${smoked.left} burning`);
  // 3. A molotov dropped into a smoke.
  await t(`N.clear(); F.drop('weapon_smokegrenade'); return 1;`);
  await wait(2500);
  await t(`F.drop('weapon_molotov'); return 1;`);
  await wait(1500);
  const into = JSON.parse(await t(`return JSON.stringify({ flying: N.flying.length, fires: N.fires.length, smokes: N.volume.fields.length });`));
  console.log(`SMOKE fire ${map}: a molotov dropped into a smoke (${into.smokes} up): ${into.fires} fires, ${into.flying} still flying`);
  const good = Math.abs(burn - 7) < 0.15 && smoked.burning === 1 && smoked.left === 0 && smoked.popped < 1.2 && into.fires === 0 && into.flying === 0 && into.smokes === 1;
  console.log('SMOKE fire', good ? 'all as in CS2' : 'NOT as in CS2', '(screenshots in', app.getPath('userData') + ')');
  await js(`import(new URL('js/matchmaking.js', location.href).href).then((mm) => mm.leave()).then(() => 1)`); // (a private match: left at once)
  await wait(1500);
  app.quit();
}

// `CS2SIM_SMOKE=lineups` throws every lineup of each map (CS2SIM_SMOKE_MAPS, else Mirage, Dust II and Inferno) in the
// game itself: a bot on its spot exactly (its brain off), its aim exact, and logs where each went off against where
// it's meant to (and where flight.js says it goes on this match's collision), the bad ones (over 110 units off; a flash
// 180) last.
async function runLineupsSmoke(win) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  const maps = (process.env.CS2SIM_SMOKE_MAPS || 'de_mirage,de_dust2,de_inferno').split(',');
  await wait(3000);
  for (const map of maps) {
    await js(`(() => { const k = 'cs2sim.play'; const p = JSON.parse(localStorage.getItem(k) || '{}'); localStorage.setItem(k, JSON.stringify({ ...p, mode: 'competitive', map: '${map}', teamSize: 5 })); })(); 1`);
    if (!(await smokeStartMap(win, map, 'lineups'))) continue;
    const r = await js(`(async () => { const g = window.__playGame, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const { landing, nadeFor } = await import(new URL('js/play/utility.js', location.href).href);
      document.querySelector('.play-pause')?.classList.add('hidden'); g.paused = false;
      g.console.run('sv_cheats 1'); g.console.run('host_timescale 4'); g.god = true;
      if (g.match.phase === 'freeze') { g.match.time = 0; await sleep(300); }
      g.match.time = 9999;
      for (const b of g.bots) { b.brain.tick = () => { b.vel = [0, 0, 0]; }; b.brain.scan = () => {}; }
      const b = g.bots[0], out = [];
      for (const l of g.lineups) {
        const nade = nadeFor(l.kind, l.side), at = [];
        g.onLineupLanded = (c, ln, pos) => { if (ln === l) at.push(pos.slice()); };
        b.c.alive = true; b.pendingThrow = null; b.c.nades[nade] = 1; b.ducked = false;
        b.pos = l.pos.slice(); b.vel = [0, 0, 0];
        const t0 = g.now;
        g.botThrowAim(b, nade, { pitch: l.pitch, yaw: l.yaw, strength: l.strength, jump: l.jump, lineup: l });
        while (!at.length && g.now - t0 < 25) await sleep(50);
        const sim = landing(g.collision, l), off = (p) => p ? Math.round(Math.hypot(p[0] - l.goal[0], p[1] - l.goal[1], l.kind === 'flash' ? p[2] - l.goal[2] - 110 : p[2] - l.goal[2])) : null;
        out.push({ id: l.id, kind: l.kind, side: l.side, off: off(at[0]), sim: off(sim?.pos), built: l.err, time: +(g.now - t0).toFixed(1), simTime: sim?.time != null ? +sim.time.toFixed(1) : null });
        await sleep(200);
      }
      return JSON.stringify(out); })()`);
    const list = JSON.parse(r), bad = list.filter((x) => x.off == null || x.off > (x.kind === 'flash' ? 180 : 110));
    console.log(`SMOKE lineups ${map}: ${list.length - bad.length} of ${list.length} land on their spot in the game`);
    for (const x of [...list.filter((y) => !bad.includes(y)), ...bad]) console.log(`  ${bad.includes(x) ? 'BAD ' : ''}${x.side} ${x.id} (${x.kind}): ${x.off ?? 'never'} off in the game in ${x.time} s; flight.js ${x.sim ?? 'never'} off in ${x.simTime} s (${x.built} when built)`);
    await js(`import(new URL('js/matchmaking.js', location.href).href).then((mm) => mm.leave()).then(() => 1)`); // (a private match: left at once)
    await wait(2500);
  }
  app.quit();
}

// `CS2SIM_SMOKE=drops` checks that guns keep their skins (put a save.json with skins equipped in the smoke profile
// first): on Dust II (CS2SIM_SMOKE_MAP) as a terrorist with the bots stopped, you buy an AK-47 (your skin), drop it, a
// bot picks it up and holds it, dies and drops it, you pick it up again (yours), then pick up a bot's (the default),
// logging each gun's skin, with screenshots (userData/drops-*.png) of yours on the floor, in the bot's hands and in yours,
// and of the bot's in yours.
async function runDropsSmoke(win) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => fs.writeFileSync(path.join(app.getPath('userData'), `drops-${name}.png`), (await win.webContents.capturePage()).toPNG());
  const map = process.env.CS2SIM_SMOKE_MAP || 'de_dust2';
  await wait(3000);
  // (three's warnings with where they came from.)
  await js(`console.warn = ((f) => (...a) => f(...a, new Error().stack.split('\\n').slice(2, 6).join(' <- ')))(console.warn);
    console.error = ((f) => (...a) => f(...a, new Error().stack.split('\\n').slice(2, 6).join(' <- ')))(console.error); 1`);
  await js(`(() => { const k = 'cs2sim.play'; const p = JSON.parse(localStorage.getItem(k) || '{}'); localStorage.setItem(k, JSON.stringify({ ...p, mode: 'competitive', map: '${map}', teamSize: 5, team: 'T' })); })(); 1`);
  await js(`document.querySelector('#topbar [data-page=stats]').click(); setTimeout(() => document.querySelector('#topbar [data-page=play]').click(), 200); 1`);
  await wait(1500);
  if (!(await smokeStartMap(win, map, 'drops'))) return app.quit();
  const step = async (label, code) => { const r = await js(`(async () => { const g = window.__playGame, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const skinOf = (s) => (s === undefined ? 'undefined' : s ? (s.owner + ' ' + s.item.id + ' ' + s.item.uid) : 'default');
    ${code} })()`); console.log('SMOKE drops ' + label + ': ' + r); return r; };
  await step('setup', `document.querySelector('.play-pause')?.classList.add('hidden'); g.paused = false;
    const css = document.createElement('style'); css.textContent = '.play-click, .play-scrim { display: none !important; }'; document.head.appendChild(css);
    g.console.run('sv_cheats 1'); g.cv.bot_stop = 1; g.god = true; g.console.run('impulse 101');
    await g.buy('weapon_ak47'); for (let i = 0; i < 50 && !g.arsenal.guns.primary; i++) await sleep(100);
    if (g.match.phase === 'freeze') { g.match.time = 0; await sleep(400); } g.match.time = 9999;
    const own = g.ownSkin('weapon_ak47');
    return 'spots ' + Math.round(g.spotsMs) + ' ms; your AK-47 skin: ' + (own ? own.id + ' ' + own.uid + ' (' + (own.stk?.length || 0) + ' stickers)' : 'none') + '; the AK in your hands: ' + skinOf(g.arsenal.guns.primary?.skin) + ' named ' + g.arsenal.guns.primary?.name;`);
  // Your AK on the floor, looked at from a little way off.
  await step('dropped', `g.console.run('cl_drawhud 0');
    for (let i = 0; i < 20 && !g.drops.list.length; i++) { g.arsenal.select('primary', g.now); await sleep(300); if (g.arsenal.gun?.slot === 'primary') g.dropMine(); }
    await sleep(2500);
    const it = g.drops.list.at(-1); g.player.teleport([it.pos[0] - 40, it.pos[1], it.pos[2]]); g.input.yaw = 0; g.input.pitch = 56; await sleep(800);
    return 'on the floor: ' + skinOf(it.skin) + ', model built: ' + it.obj.children.length + ', templates: ' + [...g.botAssets.weapons.keys()].filter((k) => k.includes('#')).join(' ');`);
  await shot('floor');
  // A bot with no rifle walks over it: it holds your skin.
  await step('bot picks it up', `const it = g.drops.list.at(-1), b = g.bots.find((x) => x.c.alive && x.c.team === 'CT');
    delete b.weapons.primary; b.pos = it.pos.slice(); b.pos[2] += 2; await sleep(1500);
    g.player.teleport([b.pos[0] - 90, b.pos[1] - 40, b.pos[2]]); g.input.yaw = Math.atan2(40, 90) * 180 / Math.PI; g.input.pitch = 5; b.yaw = 180 + g.input.yaw; await sleep(1500);
    window.__dropBot = b;
    return b.c.name + ' holds ' + b.weapons.primary?.id + ' ' + skinOf(b.weapons.primary?.skin) + ' (model ' + b.holding + ' ' + skinOf(b.holdingSkin) + ')';`);
  await shot('bot');
  await step('bot dies', `const b = window.__dropBot; g.kill(b.c, g.me, g.arsenal.guns.secondary, false); await sleep(1500);
    const it = g.drops.list.at(-1); return 'it dropped ' + it.id + ' ' + skinOf(it.skin);`);
  await step('you pick it up', `const it = g.drops.list.at(-1); g.player.teleport([it.pos[0], it.pos[1], it.pos[2]]); await sleep(2500);
    g.input.pitch = 0; g.arsenal.select('primary', g.now); await sleep(1200);
    const gun = g.arsenal.guns.primary; return 'in your hands: ' + gun?.id + ' ' + skinOf(gun?.skin) + ' named ' + gun?.name;`);
  await shot('yours-again');
  await step("a bot's AK", `g.dropMine(); await sleep(300); g.player.teleport([g.player.origin[0] + 300, g.player.origin[1], g.player.origin[2] + 10]); await sleep(500);
    const b = g.bots.find((x) => x.c.alive && x.c.team === 'CT'); g.giveBot(b, 'weapon_ak47'); g.kill(b.c, g.me, g.arsenal.guns.secondary, false); await sleep(1500);
    const it = g.drops.list.at(-1); g.player.teleport([it.pos[0], it.pos[1], it.pos[2]]); await sleep(2500); g.arsenal.select('primary', g.now); await sleep(1200);
    const gun = g.arsenal.guns.primary; return 'its drop ' + skinOf(it.skin) + '; in your hands: ' + gun?.id + ' ' + skinOf(gun?.skin) + ' named ' + gun?.name;`);
  await shot('default');
  app.quit();
}

async function runBotsSmoke(win) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  const secs = +process.env.CS2SIM_SMOKE_SECONDS || 150;
  const maps = (process.env.CS2SIM_SMOKE_MAPS || 'de_dust2,de_mirage').split(',');
  const tiers = (process.env.CS2SIM_SMOKE_TIERS || 'silver,global').split(',');
  const summary = [];
  await wait(3000);
  for (const map of maps) {
    for (const tier of tiers) {
      await js(`(() => { const k = 'cs2sim.play'; const p = JSON.parse(localStorage.getItem(k) || '{}'); localStorage.setItem(k, JSON.stringify({ ...p, mode: 'competitive', map: '${map}', difficulty: '${tier}', teamSize: 5, length: 'long', quality: 'balanced' })); })(); 1`);
      await js(`document.querySelector('#topbar [data-page=stats]').click(); setTimeout(() => document.querySelector('#topbar [data-page=play]').click(), 200); 1`);
      await wait(1500);
      if (!(await smokeStartMap(win, map, 'bots'))) continue;
      await js(`(() => { const g = window.__playGame, B = window.__bots = { log: [], throws: [], landed: [], kills: 0, plants: 0, wins: { T: 0, CT: 0 } };
        document.querySelector('.play-pause')?.classList.add('hidden'); g.paused = false;
        const fmt = (p) => p ? Math.round(p) : '';
        const planLine = () => { const t = g.plans?.T, ct = g.plans?.CT; if (!t) return;
          B.log.push('round ' + g.match.round + ': T ' + t.strat + ' ' + t.site + ' (' + t.econ + ', stage ' + t.stage + ') throws [' + t.throws.map((x) => x.by.name + ':' + x.lineup.id).join(', ') + '] roles ' + [...t.roles].map(([c, r]) => c.name + '=' + r).join(' ')
            + ' | CT ' + ct.econ + (ct.stack ? ' stack ' + ct.stack : '') + ' throws [' + ct.throws.map((x) => x.by.name + ':' + x.lineup.id).join(', ') + ']');
          // (Positions, setups.js: the CTs' on their sites as called, a default's spread.)
          if (ct.pos?.size) B.log.push('  CT setup: ' + (ct.call || '') + ' [' + [...ct.pos].map(([c, p]) => c.name + '=' + ct.assign.get(c) + ' ' + p.name).join(', ') + ']');
          if (t.positions?.size) B.log.push('  T default: ' + [...t.positions].map(([c, p]) => c.name + '=' + p.name).join(', '));
          B.snapped = false; };
        const start = g.onRoundStart.bind(g); g.onRoundStart = function (...a) { start(...a); planLine(); };
        planLine();
        g.onLineupLanded = (c, l, pos) => { const off = Math.hypot(pos[0] - l.goal[0], pos[1] - l.goal[1], l.kind === 'flash' ? 0 : pos[2] - l.goal[2]); B.landed.push({ by: c.name, id: l.id, kind: l.kind, off: Math.round(l.kind === 'flash' ? Math.hypot(pos[0] - l.goal[0], pos[1] - l.goal[1], pos[2] - l.goal[2] - 110) : off) }); };
        const kill = g.kill.bind(g); g.kill = function (c, a, ...r) { if (c.alive) B.kills++; return kill(c, a, ...r); };
        // CS2SIM_SMOKE_DRILL=exec (or another strat): every round that strat, everyone with money, the CTs standing still
        // at their spawn and the terrorists not looking for them: the utility goes out every round, to see where it lands.
        const drill = ${JSON.stringify(process.env.CS2SIM_SMOKE_DRILL || '')};
        if (drill) {
          g.forceStrat = drill;
          const st0 = g.onRoundStart.bind(g);
          g.onRoundStart = function (...a) {
            for (const c of g.combatants) c.money = 16000;
            st0(...a);
            for (const b of g.bots) { if (b.c.team === 'CT') b.brain.tick = () => { b.vel = [0, 0, 0]; }; else b.brain.scan = () => {}; }
          };
        }
        const end = g.onRoundEnd.bind(g); g.onRoundEnd = function (w, reason, mvp) {
          const t = g.plans?.T;
          if (t?.throws?.length) B.log.push('  throws: ' + t.throws.map((x) => { const b = g.botOf(x.by); return x.lineup.id + (x.thrownAt != null ? ' thrown' : ' not thrown (' + (x.by.alive ? Math.round(Math.hypot(b.pos[0] - x.lineup.pos[0], b.pos[1] - x.lineup.pos[1])) + 'u from its spot' : 'thrower dead') + ')'); }).join(', ') + ' · stage ' + t.stage);
          const ct = g.plans?.CT, fell = g.bots.filter((b) => b.brain.fellBack).map((b) => b.c.name + ' (' + b.brain.fellBack.site + ')');
          const cts = (ct?.throws || []).filter((x) => x.thrownAt != null).map((x) => x.lineup.id), retake = (ct?.retakes || []).filter((x) => x.thrownAt != null).map((x) => x.lineup.id);
          if (fell.length || cts.length || retake.length) B.log.push('  CT utility: ' + (cts.join(', ') || 'none') + (retake.length ? '; retake: ' + retake.join(', ') : '') + (fell.length ? '; fell back: ' + fell.join(', ') : ''));
          B.wins[w]++; B.log.push('  round ' + g.match.round + ' won by ' + w + ' (' + reason + ')' + (g.match.bomb?.site ? ' bomb ' + g.match.bomb.site : '')); return end(w, reason, mvp); };
        const planted = g.match.planted.bind(g.match); g.match.planted = function (...a) { B.plants++; return planted(...a); };
        return 1; })()`);
      // CS2SIM_SMOKE_TIMESCALE: the match played faster (host_timescale; the bots still think every tick of it).
      if (process.env.CS2SIM_SMOKE_TIMESCALE) await js(`(() => { const g = window.__playGame; g.console.run('sv_cheats 1'); g.console.run('host_timescale ${+process.env.CS2SIM_SMOKE_TIMESCALE}'); return 1; })()`);
      await js(botMetricsJs);
      const t0 = Date.now();
      let shot = false;
      while (Date.now() - t0 < secs * 1000) {
        await js(`(() => { const g = window.__playGame; if (g.me.alive && g.match.phase === 'live') g.console.run('kill');
          // Where everyone is 20 s into the round (by callout), and what each is doing.
          const B = window.__bots;
          if (B && !B.snapped && g.match.phase === 'live' && g.now - g.liveAt > 20) {
            B.snapped = true;
            B.log.push('  20 s in: ' + g.bots.filter((b) => b.c.alive).map((b) => b.c.team + ' ' + b.c.name + ' ' + (g.placeOf(b.c) || '?') + ' ' + b.brain.task).join(', '));
          }
          return 1; })()`);
        if (!shot && Date.now() - t0 > 20000) {
          shot = true;
          await js(`window.__playGame.hud.scoreboard(true, window.__playGame.scoreData()); 1`);
          await wait(1500);
          fs.writeFileSync(path.join(app.getPath('userData'), `bots-${map}-${tier}.png`), (await win.webContents.capturePage()).toPNG());
          await js(`window.__playGame.hud.scoreboard(false); 1`);
        }
        await wait(1000);
      }
      const r = JSON.parse(await js(`JSON.stringify(window.__bots)`));
      const land = r.landed, good = land.filter((x) => x.off <= (x.kind === 'flash' ? 180 : 100));
      console.log(`SMOKE bots ${map} ${tier}: ${r.kills} kills, ${r.plants} plants, rounds T ${r.wins.T} / CT ${r.wins.CT}, ${land.length} lineups thrown, ${good.length} landed on their spot`);
      console.log(r.log.map((l) => '  ' + l).join('\n'));
      console.log('  lineups: ' + land.map((x) => `${x.by}:${x.id} ${x.off}u`).join(', '));
      const metrics = JSON.parse(await js(`JSON.stringify(window.__botMetrics.report())`));
      console.log(`SMOKE bots ${map} ${tier} behaviour: ` + JSON.stringify(metrics, null, 1));
      fs.writeFileSync(path.join(app.getPath('userData'), `bots-${map}-${tier}.json`), JSON.stringify(metrics, null, 1));
      summary.push({ map, tier, kills: r.kills, plants: r.plants, wins: r.wins, thrown: land.length, landed: good.length, ...metrics.summary });
      await js(`import(new URL('js/matchmaking.js', location.href).href).then((mm) => mm.leave()).then(() => 1)`); // (a private match: left at once)
      await wait(2500);
    }
  }
  console.log('SMOKE bots all', JSON.stringify(summary));
  app.quit();
}

// `CS2SIM_SMOKE=look` starts a match (CS2SIM_SMOKE_MAPS, else Dust II): holds a grenade primed and throws it (the
// crosshair, the pin), then screenshots bots close up and further off, front and back, your viewmodel, a bot shooting
// (its tracers and muzzle flash) and the HUD (everyone's picture by the clock) into userData/look-*.png, counting the
// white specks on the players in each view (CS2SIM_SMOKE_OUTLIERS: every dot, dark or bright, by what's drawn there).
// CS2SIM_SMOKE_SWEEP adds the count from 32 views round two bots.
async function runLookSmoke(win) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => fs.writeFileSync(path.join(app.getPath('userData'), `look-${name}.png`), (await win.webContents.capturePage()).toPNG());
  await wait(4000);
  const map = (process.env.CS2SIM_SMOKE_MAPS || 'de_dust2').split(',')[0];
  await js(`(() => { const k = 'cs2sim.play'; const p = JSON.parse(localStorage.getItem(k) || '{}'); localStorage.setItem(k, JSON.stringify({ ...p, mode: 'competitive', map: '${map}', teamSize: 5, team: '${process.env.CS2SIM_SMOKE_PLANT ? 'T' : 'CT'}' })); })(); 1`);
  await js(`document.querySelector('#topbar [data-page=stats]').click(); setTimeout(() => document.querySelector('#topbar [data-page=play]').click(), 200); 1`);
  await wait(1500);
  if (!(await smokeStartMap(win, map, 'look'))) return app.quit();
  await js(`(() => { const g = window.__playGame;
    document.querySelector('.play-pause')?.classList.add('hidden'); g.paused = false;
    g.god = true; g.cv.bot_stop = 1; g.match.time = 9999; g.console.run('cl_drawhud 0'); return 1; })()`);
  await wait(3000);
  // A grenade: the crosshair shows with it out; held, the pin stays pulled (not thrown, however long); let go, it's thrown.
  console.log('SMOKE look grenade', await js(`(async () => { const g = window.__playGame, A = g.arsenal, wait = (ms) => new Promise((r) => setTimeout(r, ms));
    if (g.match.phase === 'freeze') { g.match.time = 0; await wait(400); g.match.time = 9999; } // (live, so it can be thrown)
    g.console.run('sv_cheats 1'); g.console.run('give weapon_hegrenade');
    for (let i = 0; i < 50 && !A.current?.nade; i++) await wait(100);
    const gun = A.current;
    if (!gun?.nade) return 'no grenade in hand';
    await wait(1500);
    const xhair = () => !document.querySelector('.play-hud .xhair').classList.contains('hidden');
    const out = { crosshairOut: xhair() };
    g.input.buttons |= 1;
    await wait(3000);
    out.held3s = { pin: gun.pin != null, thrown: gun.throwAt != null, anim: gun.vm.role, crosshair: xhair() };
    g.input.buttons &= ~1;
    await wait(700);
    out.released = { thrown: gun.throwAt != null || !!gun.released, hegrenadesLeft: g.me.nades.weapon_hegrenade || 0 };
    return JSON.stringify(out); })()`));
  // Stand in front of (or behind) a bot, looking at its chest from d units.
  const at = (d, back = 0, bot = 0) => js(`(() => { const g = window.__playGame, b = g.bots.filter((x) => x.c.alive)[${bot}];
    if (!b) return 'no bot';
    const yr = b.yaw * Math.PI / 180 + (${back} ? Math.PI : 0), p = [b.pos[0] + Math.cos(yr) * ${d}, b.pos[1] + Math.sin(yr) * ${d}, b.pos[2]];
    g.player.teleport(p); g.input.yaw = Math.atan2(b.pos[1] - p[1], b.pos[0] - p[0]) * 180 / Math.PI;
    g.input.pitch = Math.atan2(64 - 50, ${d}) * 180 / Math.PI;
    return b.c.name + ' ' + b.holding; })()`);
  // Dots: single pixels unlike every neighbour (dark or bright), by what's drawn there and how it's lit.
  const outliers = async (name) => {
    const img = await win.webContents.capturePage(), { width: W, height: H } = img.getSize(), px = img.toBitmap();
    const at = (x, y) => (y * W + x) * 4, found = [];
    for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) {
      if (x < W * 0.2 && y < H * 0.32) continue; // (the radar)
      const k = at(x, y);
      let min = 1e9;
      for (const [dx, dy] of [[-2, 0], [2, 0], [0, -2], [0, 2], [-1, -1], [1, 1], [-1, 1], [1, -1]]) {
        const n = at(x + dx, y + dy), d = Math.abs(px[k] - px[n]) + Math.abs(px[k + 1] - px[n + 1]) + Math.abs(px[k + 2] - px[n + 2]);
        if (d < min) min = d;
      }
      if (min > 120) found.push([x, y, (px[k] + px[k + 1] + px[k + 2]) / 3 > 120 ? 'bright' : 'dark', px[k] > px[k + 2] + 8 && (px[k] + px[k + 1] + px[k + 2]) / 3 > 150]); // (BGRA: cool and bright, like the sky)
    }
    const kinds = JSON.parse(await js(`(async () => { const THREE = await import('three'), g = window.__playGame, r = new THREE.Raycaster(), out = {};
      for (const [x, y, tone] of ${JSON.stringify(found.slice(0, 150))}) {
        r.setFromCamera(new THREE.Vector2(x / ${W} * 2 - 1, 1 - y / ${H} * 2), g.camera);
        const hit = r.intersectObjects(g.scene.children, true).find((h) => h.object.visible && h.object.material?.visible !== false);
        const m = [].concat(hit?.object.material || [])[0];
        const lit = !m ? '' : m.lightMap ? 'lightmapped' : m.cs2Cube ? 'player' : 'other';
        const k = tone + ' ' + (hit ? lit + ' ' + (m?.userData?.vmat?.Name || m?.name || m?.type).replace('materials/', '') + (m.alphaTest ? ' alphatest' : '') + (m.transparent ? ' transparent' : '') : 'nothing');
        out[k] = (out[k] || 0) + 1;
      }
      return JSON.stringify(Object.entries(out).sort((a, b) => b[1] - a[1]).slice(0, 14)); })()`));
    console.log(`SMOKE look outliers ${name}: ${found.length} (${found.filter((f) => f[2] === 'dark').length} dark)`);
    for (const [k, n] of kinds) console.log('   ', n, k);
    const of = (re) => kinds.filter(([k]) => re.test(k)).reduce((s, [, n]) => s + n, 0);
    return { total: found.length, dark: found.filter((f) => f[2] === 'dark').length, cool: found.filter((f) => f[3]).length, players: of(/ player /), lightmapped: of(/lightmapped/) };
  };
  // White specks: pixels far brighter than everything around them, and what's drawn there (the mesh and material under
  // each, by a ray from the camera). Returns how many are on the players and their guns.
  const specks = async (name) => {
    if (process.env.CS2SIM_SMOKE_OUTLIERS) return (await outliers(name)).players;
    const img = await win.webContents.capturePage(), { width: W, height: H } = img.getSize(), px = img.toBitmap();
    const lum = (x, y) => { const k = (y * W + x) * 4; return (px[k] + px[k + 1] + px[k + 2]) / 3; };
    const found = [];
    for (let y = 3; y < H - 3; y++) for (let x = 3; x < W - 3; x++) {
      if (x < W * 0.2 && y < H * 0.32) continue; // (the radar)
      const l = lum(x, y);
      if (l < 200) continue;
      let ring = 0;
      for (const [dx, dy] of [[-3, 0], [3, 0], [0, -3], [0, 3], [-2, -2], [2, 2], [-2, 2], [2, -2]]) ring += lum(x + dx, y + dy);
      if (ring / 8 < l - 80 && !found.some((f) => Math.abs(f[0] - x) < 4 && Math.abs(f[1] - y) < 4)) found.push([x, y, Math.round(l), Math.round(ring / 8)]);
    }
    const hits = JSON.parse(await js(`(async () => { const THREE = await import('three'), g = window.__playGame, r = new THREE.Raycaster();
      return JSON.stringify(${JSON.stringify(found.slice(0, 60))}.map(([x, y, l, ring]) => {
        r.setFromCamera(new THREE.Vector2(x / ${W} * 2 - 1, 1 - y / ${H} * 2), g.camera);
        let hit = r.intersectObjects(g.scene.children, true).find((h) => h.object.visible && h.object.material?.visible !== false);
        if (!hit) { r.setFromCamera(new THREE.Vector2(x / ${W} * 2 - 1, 1 - y / ${H} * 2), g.vmCamera); hit = r.intersectObjects(g.vmScene.children, true).find((h) => h.object.isMesh && h.object.visible); if (hit) hit.vm = true; }
        let o = hit?.object, path = hit?.vm ? ['viewmodel'] : []; for (let p = o; p && path.length < 4; p = p.parent) path.push(p.name || p.type);
        const m = [].concat(o?.material || [])[0];
        const who = hit?.vm ? 'viewmodel' : path.some((p) => /thirdperson|^(ctm|tm)_/.test(p)) ? 'player' : o?.parent?.userData?.muzzle !== undefined || path.some((p) => /weapon/.test(p)) ? 'gun' : 'map';
        return [x, y, l, ring, who, hit ? (m?.userData?.vmat?.Name || m?.name || m?.type) + ' @ ' + path.join('<') + ' d=' + Math.round(hit.distance / 0.0254)
          + (m ? ' rough ' + (+m.roughness).toFixed(2) + (m.roughnessMap ? '+map' : '') + ' metal ' + (+m.metalness).toFixed(2) + (m.metalnessMap ? '+map' : '') + ' env ' + (+(m.envMapIntensity ?? 1)).toFixed(2) + (m.normalMap ? ' normal' : '') : '') : 'nothing (viewmodel/sky)'];
      })); })()`));
    const onPlayers = hits.filter((h) => h[4] !== 'map');
    console.log(`SMOKE look specks ${name}: ${found.length}, ${onPlayers.length} on players and their guns`);
    for (const h of onPlayers) console.log('  ', JSON.stringify(h));
    return onPlayers.length;
  };
  if (process.env.CS2SIM_SMOKE_PROBE) {
    // What's at some screen points (CS2SIM_SMOKE_PROBE: [[x, y], ...] in screenshot pixels): the page's elements there,
    // and every visible thing in the viewmodel's scene with where it shows on screen.
    const pts = JSON.parse(process.env.CS2SIM_SMOKE_PROBE);
    await wait(2000);
    console.log('SMOKE look probe', await js(`(async () => { const THREE = await import('three'), g = window.__playGame, W = innerWidth, H = innerHeight, dpr = devicePixelRatio;
      const out = { size: [W, H, dpr], elements: ${JSON.stringify(pts)}.map(([x, y]) => document.elementsFromPoint(x / dpr, y / dpr).slice(0, 4).map((e) => e.tagName + '.' + [...e.classList].join('.')).join(' > ')), vm: [] };
      const v = new THREE.Vector3();
      g.vmScene.traverse((o) => { if (!o.visible || o.isBone || o.isLight || o === g.vmScene) return; if (!(o.isMesh || o.isSprite || o.isLine || o.isPoints)) return;
        o.getWorldPosition(v); v.project(g.vmCamera);
        out.vm.push(o.type + ' ' + (o.name || '') + ' ' + ([].concat(o.material || [])[0]?.type || '') + ' @' + Math.round((v.x + 1) / 2 * W * dpr) + ',' + Math.round((1 - v.y) / 2 * H * dpr)); });
      out.vm = out.vm.slice(0, 40);
      const scene = []; g.scene.traverse((o) => { if (o.visible && (o.isSprite || o.isPoints || o.isLine)) { o.getWorldPosition(v); v.project(g.camera); scene.push(o.type + ' ' + (o.name || '') + ' @' + Math.round((v.x + 1) / 2 * W * dpr) + ',' + Math.round((1 - v.y) / 2 * H * dpr) + ' z' + v.z.toFixed(3)); } });
      out.sceneSpritesLines = scene.slice(0, 30);
      return JSON.stringify(out); })()`));
    return app.quit();
  }
  if (process.env.CS2SIM_SMOKE_VM) {
    // Your own weapons in first person (your loadout: copy a save.json into the smoke profile first): each one drawn and
    // idle against a wall and against the sky, its white specks counted.
    await js(`(async () => { const g = window.__playGame; const m = g.match; if (m.phase === 'freeze') { m.time = 0; await new Promise((r) => setTimeout(r, 400)); } m.time = 9999;
      g.console.run('sv_cheats 1'); g.console.run('give ' + (g.me.team === 'CT' ? 'weapon_m4a1' : 'weapon_ak47')); return 1; })()`);
    await wait(4000);
    for (const slot of ['knife', 'secondary', 'primary']) {
      const what = await js(`(() => { const g = window.__playGame; if (!g.arsenal.guns.${slot}) return 'none'; g.arsenal.select('${slot}', g.now); return g.arsenal.guns.${slot}.id; })()`);
      for (const [view, pitch] of [['wall', 0], ['sky', -35]]) {
        await js(`(() => { const g = window.__playGame; g.input.pitch = ${pitch}; return 1; })()`);
        await wait(3500);
        await shot(`vm-${slot}-${view}`);
        console.log('SMOKE look vm', slot, what, view, await specks(`vm ${slot} ${view}`));
      }
    }
    return app.quit();
  }
  if (process.env.CS2SIM_SMOKE_PLANT) {
    // Planting: your C4's plant clip plays through (not the idle), the bomb goes down; again once the round is over
    // (it does, and the round stays decided); and a bot's plant takes its whole body (its walk and hold pose at nothing).
    const plant = (label) => js(`(async () => { const g = window.__playGame, m = g.match, wait = (ms) => new Promise((r) => setTimeout(r, ms));
      if (g.me.team !== 'T') return 'you are not a terrorist';
      if (!g.me.alive) { g.me.alive = true; g.me.health = 100; g.deathCam = null; }
      const site = g.map.info.bombsites[0], p = [(site.min[0] + site.max[0]) / 2, (site.min[1] + site.max[1]) / 2, site.max[2] + 40];
      g.player.teleport(g.onFloor(p));
      for (const c of g.combatants) c.hasC4 = false;
      g.me.hasC4 = true; Object.assign(m.bomb, { state: 'carried', carrier: g.me, pos: null });
      await g.giveMe('c4', 'weapon_c4', true);
      for (let i = 0; i < 40 && g.arsenal.current?.id !== 'weapon_c4'; i++) await wait(100);
      const c4 = g.arsenal.current; await wait(1300); // (drawn)
      const phase = m.phase, won = m.history.length;
      g.input.buttons |= 1; g.input.pitch = 40;
      await wait(1200);
      const mid = { anim: c4?.vm.role, planting: !!g.planting };
      window.__midShot = true; for (let i = 0; i < 30 && window.__midShot; i++) await wait(100);
      await wait(1300);
      g.input.buttons &= ~1;
      await wait(300);
      return JSON.stringify({ label: '${label}', phase, mid, bomb: m.bomb.state, phaseAfter: m.phase, roundsDecided: m.history.length - won, beeping: m.bomb.beepAt > g.now - 2 }); })()`);
    await js(`(async () => { const g = window.__playGame, m = g.match; if (m.phase === 'freeze') { m.time = 0; await new Promise((r) => setTimeout(r, 400)); } m.time = 9999; return 1; })()`);
    const shooter = (async () => { for (let i = 0; i < 200; i++) { if (await js('!!window.__midShot')) { await shot('plant-mid'); await js('window.__midShot = false; 1'); return; } await wait(100); } })();
    console.log('SMOKE look plant', await plant('live'));
    await shooter;
    await js(`(() => { const g = window.__playGame, p = g.match.bomb.pos; g.player.teleport([p[0] - 30, p[1], p[2]]); g.input.yaw = 0; g.input.pitch = 55; g.console.run('r_drawviewmodel 0'); return 1; })()`);
    await wait(1200);
    await shot('plant-bomb');
    await js(`window.__playGame.console.run('r_drawviewmodel 1'); 1`);
    await js(`(async () => { const g = window.__playGame, m = g.match; m.phase = 'live'; Object.assign(m.bomb, { state: 'carried' }); m.endRound('T', 'elimination'); m.time = 9999; return 1; })()`);
    console.log('SMOKE look plant', await plant('after the round'));
    console.log('SMOKE look plant bot', await js(`(async () => { const g = window.__playGame, wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const b = g.bots.find((x) => x.c.alive); b.setMode('plant'); await wait(1200);
      const loco = (b.loco?.all || []).reduce((s, a) => s + a.getEffectiveWeight(), 0);
      const r = { special: +(b.special?.getEffectiveWeight() || 0).toFixed(2), locoWeight: +loco.toFixed(2), holdWeight: +(b.armsAction?.getEffectiveWeight() || 0).toFixed(2) };
      b.setMode('move'); await wait(500);
      r.backHold = +(b.armsAction?.getEffectiveWeight() || 0).toFixed(2);
      return JSON.stringify(r); })()`));
    await shot('plant');
    return app.quit();
  }
  if (process.env.CS2SIM_SMOKE_SWEEP) {
    // Round two bots, close and further off, eight ways: how many specks there are on them in all.
    let total = 0;
    for (const bot of [0, 1]) for (const d of [90, 260]) for (let k = 0; k < 8; k++) {
      await js(`(() => { const g = window.__playGame, b = g.bots.filter((x) => x.c.alive)[${bot}];
        const yr = ${k} * Math.PI / 4, p = [b.pos[0] + Math.cos(yr) * ${d}, b.pos[1] + Math.sin(yr) * ${d}, b.pos[2]];
        g.player.teleport(p); g.input.yaw = Math.atan2(b.pos[1] - p[1], b.pos[0] - p[0]) * 180 / Math.PI; g.input.pitch = Math.atan2(14, ${d}) * 180 / Math.PI; return 1; })()`);
      await wait(700);
      total += await specks(`bot${bot} d${d} k${k}`);
    }
    console.log('SMOKE look sweep specks on players', total);
  }
  for (const [name, d, back] of [['near', 60, 0], ['near-back', 60, 1], ['mid', 200, 0], ['far', 600, 0]]) {
    console.log('SMOKE look', name, await at(d, back));
    await wait(1800);
    await shot(name);
    await specks(name);
  }
  // Your viewmodel against the sky and against a wall.
  await js(`(() => { const g = window.__playGame; g.input.pitch = -20; return 1; })()`);
  await wait(1200);
  await shot('viewmodel');
  // A bot shooting past you: its tracers from its barrel.
  console.log('SMOKE look shooting', await js(`(() => { const g = window.__playGame, b = g.bots.filter((x) => x.c.alive)[0];
    const yr = b.yaw * Math.PI / 180 + Math.PI / 2, p = [b.pos[0] + Math.cos(yr) * 120, b.pos[1] + Math.sin(yr) * 120, b.pos[2]];
    g.player.teleport(p); g.input.yaw = Math.atan2(b.pos[1] - p[1], b.pos[0] - p[0]) * 180 / Math.PI; g.input.pitch = 5;
    const gun = b.weapons[b.slot]; if (!gun || gun.melee) return 'no gun';
    let n = 0; const iv = setInterval(() => { gun.clip = 30; g.botShoot(b, gun, g.now, 1); if (++n > 30) clearInterval(iv); }, 60);
    return b.c.name + ' ' + gun.id + ' muzzle ' + b.muzzle().map(Math.round) + ' eye ' + b.eye().map(Math.round); })()`));
  await wait(400);
  await shot('shooting');
  // The HUD: everyone's picture by the clock, one of them dead.
  await js(`(() => { const g = window.__playGame; g.console.run('cl_drawhud 1'); const b = g.bots.find((x) => x.c.alive && x.c.team !== g.me.team); if (b) g.kill(b.c, null, { name: 'World' }, false); return 1; })()`);
  await wait(1500);
  await shot('hud');
  app.quit();
}

// `CS2SIM_SMOKE=breakables` on Mirage (CS2SIM_SMOKE_MAPS): lists the map's breakables, shoots each vent cover and the
// B shutter (broken, its frame left, back next round), sends a bot through each crawl vent with its cover on (it has to
// crouch, and break the cover), and screenshots bots holding rifles crouched and aiming up and down (the gun in the hand)
// into userData/break-*.png.
async function runBreakSmoke(win) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => fs.writeFileSync(path.join(app.getPath('userData'), `break-${name}.png`), (await win.webContents.capturePage()).toPNG());
  await wait(4000);
  const map = (process.env.CS2SIM_SMOKE_MAPS || 'de_mirage').split(',')[0];
  await js(`(() => { const k = 'cs2sim.play'; const p = JSON.parse(localStorage.getItem(k) || '{}'); localStorage.setItem(k, JSON.stringify({ ...p, mode: 'competitive', map: '${map}', teamSize: 5 })); })(); 1`);
  await js(`document.querySelector('#topbar [data-page=stats]').click(); setTimeout(() => document.querySelector('#topbar [data-page=play]').click(), 200); 1`);
  await wait(1500);
  if (!(await smokeStartMap(win, map, 'break'))) return app.quit();
  await js(`(() => { const g = window.__playGame;
    document.querySelector('.play-pause')?.classList.add('hidden'); g.paused = false;
    g.god = true; g.cv.bot_stop = 1; g.match.time = 9999; g.console.run('cl_drawhud 0'); return 1; })()`);
  await wait(2500);
  const only = process.env.CS2SIM_SMOKE_ONLY || ''; // (vents: just the crawl vents)
  console.log('SMOKE break panes', await js(`JSON.stringify(window.__playGame.doors.panes.filter((p) => !/bottle|pottery/.test(p.surface)).map((p) => ({ surface: p.surface, at: p.center.map(Math.round), solid: p.solid, after: (p.after || []).length, meshes: p.meshes.length })))`));
  // Look at a breakable from the open side (the side a ray from 70 units off reaches it unobstructed), shoot it.
  const look = (i, back = 0) => js(`(() => { const g = window.__playGame, p = g.doors.panes.filter((x) => !/bottle|pottery/.test(x.surface))[${i}];
    const b = p.box, sx = b.max.z - b.min.z, sy = b.max.x - b.min.x; // (GL z is game x, GL x is game y)
    const ax = sx < sy ? [1, 0] : [0, 1];
    for (const s of [1, -1]) {
      const o = [p.center[0] + ax[0] * s * 70, p.center[1] + ax[1] * s * 70, p.center[2]];
      const d = [p.center[0] - o[0], p.center[1] - o[1], 0], l = Math.hypot(d[0], d[1]);
      const hit = g.collision.raycast(o, [d[0] / l, d[1] / l, 0], 80, 2);
      if (hit && hit.shape?.pane === p) {
        const feet = [o[0], o[1], (g.floorAt([o[0], o[1], o[2]], 200) ?? o[2] - 64)];
        g.player.teleport(feet); g.input.yaw = Math.atan2(d[1], d[0]) * 180 / Math.PI;
        g.input.pitch = Math.atan2(g.player.eye()[2] - p.center[2], 70) * 180 / Math.PI;
        return JSON.stringify({ from: feet.map(Math.round), dir: [d[0] / l, d[1] / l].map((v) => +v.toFixed(2)) });
      }
    }
    return 'no clear side'; })()`);
  const panes = JSON.parse(await js(`String(window.__playGame.doors.panes.filter((x) => !/bottle|pottery/.test(x.surface)).length)`));
  for (let i = 0; i < (only === 'vents' ? 0 : panes); i++) {
    const where = await look(i);
    console.log('SMOKE break look', i, where);
    if (where === 'no clear side') continue;
    await wait(1200);
    await shot(`pane${i}-before`);
    console.log('SMOKE break shoot', i, await js(`(() => { const g = window.__playGame, p = g.doors.panes.filter((x) => !/bottle|pottery/.test(x.surface))[${i}];
      const eye = g.player.eye(), d = [p.center[0] - eye[0], p.center[1] - eye[1], p.center[2] - eye[2]], l = Math.hypot(...d);
      g.fireBullet(g.me, eye, d.map((v) => v / l), g.arsenal.current, { tracer: true });
      return JSON.stringify({ broken: p.broken, solidNow: !p.shape.off, after: (p.after || []).filter((m) => m.visible).length + '/' + (p.after || []).length, gibs: g.effects.gibList.length }); })()`));
    await wait(250);
    await shot(`pane${i}-after`);
  }
  await js(`window.__playGame.doors.reset(); 1`);
  console.log('SMOKE break reset', await js(`JSON.stringify(window.__playGame.doors.panes.filter((x) => !/bottle|pottery/.test(x.surface)).map((p) => p.broken))`));
  // Through each crawl vent, its cover on: a bot told to go to the far side.
  const vents = JSON.parse(process.env.CS2SIM_SMOKE_VENTS || '[[[-1167,-317,-52],[-1152,-484,-164]],[[-1258,-946,-164],[-1405,-986,-164]],[[-1405,-986,-164],[-1258,-946,-164]]]');
  await js(`(async () => { const g = window.__playGame; if (g.match.phase === 'freeze') { g.match.time = 0; await new Promise((r) => setTimeout(r, 400)); g.match.time = 9999; } return 1; })()`); // (live, so bots move)
  for (const [from, to] of vents) {
    await js(`(() => { const g = window.__playGame; g.doors.reset(); g.cv.bot_stop = 0;
      for (const b of g.bots) if (b !== g.bots[0]) b.brain.tick = () => { b.vel = [0, 0, 0]; };
      const b = g.bots[0], br = b.brain; br.decide = () => {}; br.scan = () => {}; br.target = null;
      b.pos = g.onFloor(${JSON.stringify(from)}); b.vel = [0, 0, 0]; br.task = 'goto'; br.goTo(${JSON.stringify(to)});
      window.__vent = { crouched: 0, broke: 0, ticks: 0 };
      const t0 = br.tick.bind(br); br.tick = (...a) => { t0(...a); window.__vent.ticks++; if (b.ducked) window.__vent.crouched++; };
      g.player.teleport(g.onFloor([${from[0]} + 40, ${from[1]} + 40, ${from[2]}])); return 1; })()`);
    await wait(9000);
    console.log('SMOKE break vent', JSON.stringify(from), '->', JSON.stringify(to), await js(`(() => { const g = window.__playGame, b = g.bots[0], to = ${JSON.stringify(to)};
      return JSON.stringify({ at: b.pos.map(Math.round), left: Math.round(Math.hypot(b.pos[0] - to[0], b.pos[1] - to[1])), crouchedTicks: window.__vent.crouched, ticks: window.__vent.ticks,
        coversBroken: g.doors.panes.filter((p) => p.surface === 'metalvent' && p.broken).length,
        path: ${!!process.env.CS2SIM_SMOKE_DEBUG} ? (b.brain.path || []).map((p, i) => (i === b.brain.pi ? '>' : '') + p.map(Math.round).join(',') + (p.crouch ? 'c' : '') + (p.jump ? 'j' + Math.round(p.jump) : '')).join(' ') : undefined,
        fresh: ${!!process.env.CS2SIM_SMOKE_DEBUG} ? (g.nav.path(g.onFloor(${JSON.stringify(from)}), to)?.points || []).map((p) => p.map(Math.round).join(',') + (p.crouch ? 'c' : '') + (p.jump ? 'j' + Math.round(p.jump) : '')).join(' ') : undefined, low: b.brain.low, task: b.brain.task, stuck: b.brain.stuckTries }); })()`));
  }
  // Bots with rifles, crouched and aiming up and down: the gun in their hands.
  if (only === 'vents') return app.quit();
  await js(`(() => { const g = window.__playGame; g.cv.bot_stop = 1; for (const b of g.bots) { b.brain.tick = () => { b.vel = [0, 0, 0]; }; b.equip(b.c.team === 'T' ? 'weapon_ak47' : 'weapon_m4a1'); } return 1; })()`);
  await wait(2500);
  for (const [name, ducked, pitch] of [['stand', false, 0], ['crouch', true, 0], ['up', false, -35], ['down', true, 30]]) {
    await js(`(() => { const g = window.__playGame, b = g.bots.find((x) => x.c.alive);
      for (const x of g.bots) { x.ducked = ${ducked}; x.pitch = ${pitch}; }
      const yr = b.yaw * Math.PI / 180 + Math.PI / 2.6, p = [b.pos[0] + Math.cos(yr) * 75, b.pos[1] + Math.sin(yr) * 75, b.pos[2]];
      g.player.teleport(p); g.input.yaw = Math.atan2(b.pos[1] - p[1], b.pos[0] - p[0]) * 180 / Math.PI; g.input.pitch = 10; return 1; })()`);
    await wait(1500);
    await shot('grip-' + name);
    console.log('SMOKE break grip', name, await js(`(() => { const g = window.__playGame, b = g.bots.find((x) => x.c.alive), h = b.weaponModel;
      const THREE_v = (o) => { o.updateWorldMatrix(true, false); const e = o.matrixWorld.elements; return [e[12], e[13], e[14]]; };
      const hand = THREE_v(b.bones.hand_R), gun = h ? THREE_v(h) : null;
      return JSON.stringify({ holding: b.holding, parent: h?.parent?.name, gunToHandCm: gun ? Math.round(Math.hypot(gun[0] - hand[0], gun[1] - hand[1], gun[2] - hand[2]) * 100) : null }); })()`));
  }
  app.quit();
}

// `CS2SIM_SMOKE=premier` plays through Premier: the map veto (banning on your turns, picking a side if it's yours) with
// both teams listed, a few seconds of the match, then the end of it (a win, as your 10th: the CS Rating revealed), with
// screenshots of the veto, the scoreboard and the result into userData/premier-*.png.
async function runPremierSmoke(win) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => fs.writeFileSync(path.join(app.getPath('userData'), `premier-${name}.png`), (await win.webContents.capturePage()).toPNG());
  await wait(3000);
  await js(`(() => { const k = 'cs2sim.play'; const p = JSON.parse(localStorage.getItem(k) || '{}'); localStorage.setItem(k, JSON.stringify({ ...p, lobby: 'mm', mode: 'premier', quality: 'balanced' })); })(); 1`);
  await js(`document.querySelector('#topbar [data-page=play]').click(); 1`);
  await wait(2500);
  await shot('lobby');
  // Matchmaking: the search finds the match (at once here), accepted, then the veto. (No cooldown left from another run.)
  await js(`(async () => { const { S } = await import('./js/state.js'); S.mm = { ...S.mm, until: 0, match: null }; window.__cs2Debug = true; window.__mmWait = 2000;
    document.querySelector('#topbar [data-page=play]').click(); setTimeout(() => document.querySelector('[data-go]').click(), 500); return 1; })()`);
  for (let i = 0; i < 60 && !(await js(`!!document.querySelector('[data-accept]')`)); i++) await wait(500);
  await js(`document.querySelector('[data-accept]')?.click(); 1`);
  for (let i = 0; i < 60 && !(await js(`!!document.querySelector('.veto')`)); i++) await wait(500);
  for (let i = 0; i < 60; i++) {
    await wait(700);
    const st = JSON.parse(await js(`JSON.stringify({ veto: !!document.querySelector('.veto'), mine: !!document.querySelector('.veto-map:not(:disabled)'), side: !!document.querySelector('[data-side]'), go: !!document.querySelector('[data-veto-go]'), status: document.querySelector('.veto-status')?.textContent || '' })`));
    if (!st.veto) break;
    if (i === 2) await shot('veto');
    if (st.mine) { await js(`document.querySelector('.veto-map:not(:disabled)').click(); 1`); console.log('SMOKE premier', st.status, '(banned one)'); }
    else if (st.side) { await js(`document.querySelector('[data-side="CT"]').click(); 1`); console.log('SMOKE premier picked CT'); }
    else if (st.go) { console.log('SMOKE premier', st.status); await shot('veto-done'); await js(`document.querySelector('[data-veto-go]').click(); 1`); break; }
  }
  for (let i = 0; i < 300 && !(await js(`!!window.__playGame?.raf`)); i++) await wait(1000);
  const ok = await js(`!!window.__playGame?.raf`);
  console.log('SMOKE premier match', ok ? 'running' : 'did not start', await js(`JSON.stringify({ map: window.__playGame?.mapId, team: window.__playGame?.team, rules: window.__playGame?.rules })`));
  if (ok) {
    await js(`(() => { const g = window.__playGame; document.querySelector('.play-pause')?.classList.add('hidden'); g.paused = false; return 1; })()`);
    await wait(6000);
    await js(`window.__playGame.hud.scoreboard(true, window.__playGame.scoreData()); 1`);
    await wait(1500);
    await shot('scoreboard');
    console.log('SMOKE premier players', await js(`JSON.stringify(window.__playGame.scoreData().players.map((p) => p.name + ' ' + (p.rating ?? '-') + (p.org ? ' (' + p.org + ')' : '')))`));
    // The end: a win by 13-9 as your tenth win (the rating revealed).
    const before = await js(`(async () => JSON.stringify((await import('./js/state.js')).S.premier || null))()`);
    await js(`(async () => { const { S } = await import('./js/state.js'); S.premier = { ...(S.premier || {}), wins: 9, rating: 9000 }; const g = window.__playGame; g.match.score.A = 13; g.match.score.B = 9; g.onMatchOver('A'); return 1; })()`);
    await wait(4000);
    await shot('result');
    console.log('SMOKE premier result', await js(`document.querySelector('[data-rank]')?.innerText.replace(/\\n+/g, ' ')`), 'before', before, 'after', await js(`(async () => JSON.stringify((await import('./js/state.js')).S.premier))()`));
  }
  app.quit();
}

// `CS2SIM_SMOKE=mm` goes through matchmaking: a Competitive search on CS2SIM_SMOKE_MAP (default Dust II; the timer in
// the top bar while you look at the inventory, the map loading behind), the match found and accepted, Esc's menu over
// the match (still going on, the pages on top), leaving it (a technical timeout, the reconnect timer), reconnecting,
// leaving again and abandoning it (a loss, the cooldown, no ranked search), and the private lobby; screenshots of each
// into userData/mm-*.png.
async function runMatchmakingSmoke(win) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => fs.writeFileSync(path.join(app.getPath('userData'), `mm-${name}.png`), (await win.webContents.capturePage()).toPNG());
  const map = process.env.CS2SIM_SMOKE_MAP || 'de_dust2';
  const state = () => js(`(async () => { const { S } = await import('./js/state.js'), mm = await import('./js/matchmaking.js'), s = mm.searching(), l = mm.liveMatch(), g = l?.game;
    return JSON.stringify({ search: s && { state: s.state, ready: s.ready, map: s.map, secs: Math.round((Date.now() - s.started) / 1000) },
      live: l && { mode: l.mode, ranked: l.ranked, menu: l.menu, away: !!l.away, phase: g.match?.phase, time: +(g.match?.time ?? 0).toFixed(2), now: +g.now.toFixed(2), round: g.match?.round,
        alive: g.me.alive, timeout: g.match?.timeout && { left: Math.round(g.match.timeout.left), pending: g.match.timeout.pending }, overlay: l.overlay.className, body: document.body.className },
      bar: document.querySelector('.mm-bar')?.innerText.replace(/\\s+/g, ' ') || '', mm: S.mm, rank: { wins: S.rank.wins, losses: S.rank.losses, mmr: S.rank.mmr } }); })()`).then(JSON.parse);
  await wait(3000);
  await js(`(async () => { const k = 'cs2sim.play'; const p = JSON.parse(localStorage.getItem(k) || '{}'); localStorage.setItem(k, JSON.stringify({ ...p, lobby: 'mm', mode: 'competitive', pools: { competitive: ['${map}'] }, quality: 'balanced' }));
    const { S } = await import('./js/state.js'); S.mm = { ...S.mm, until: 0, match: null }; return 1; })()`); // (no cooldown left from another run)
  await js(`document.querySelector('#topbar [data-page=play]').click(); 1`);
  await wait(2500);
  await shot('lobby');
  console.log('SMOKE mm lobby', await js(`document.querySelector('.play-setup')?.innerText.replace(/\\s+/g, ' ').slice(0, 400)`));
  await js(`window.__cs2Debug = true; window.__mmWait = 8000; document.querySelector('[data-go]').click(); 1`);
  await wait(2500);
  await js(`document.querySelector('#topbar [data-page=inventory]').click(); 1`);
  await wait(2000);
  await shot('searching');
  console.log('SMOKE mm searching', JSON.stringify(await state()));
  for (let i = 0; i < 400 && !(await js(`!!document.querySelector('[data-accept]')`)); i++) { await wait(1000); if (i % 20 === 19) console.log('SMOKE mm still searching', JSON.stringify((await state()).search)); }
  await wait(1200);
  await shot('found');
  await js(`document.querySelector('[data-accept]')?.click(); 1`);
  for (let i = 0; i < 60 && !(await js(`!!window.__playGame?.raf`)); i++) await wait(500);
  await wait(2500);
  await shot('in-match');
  const a = await state();
  console.log('SMOKE mm in the match', JSON.stringify(a));
  // Esc: the menu over the match (the mouse was never taken here, so the game's own event stands in for it).
  await js(`window.__playGame.emit('menu', true); 1`);
  await wait(1500);
  await shot('menu');
  const t1 = await state();
  await wait(2000);
  const t2 = await state();
  console.log('SMOKE mm menu', JSON.stringify(t1.live), 'match went on:', t2.live.now > t1.live.now + 1.5, `(${t1.live.now} -> ${t2.live.now})`);
  await js(`document.querySelector('[data-page-go=inventory]')?.click(); 1`);
  await wait(2000);
  await shot('menu-inventory');
  await js(`document.querySelector('#topbar .more-btn')?.click(); setTimeout(() => document.querySelector('.more-panel [data-page=database]')?.click(), 300); 1`);
  await wait(2000);
  await shot('menu-database');
  // Resume (the bar's button), then the menu again and Leave.
  await js(`document.querySelector('[data-mm-resume]')?.click(); 1`);
  await wait(800);
  console.log('SMOKE mm resumed', JSON.stringify((await state()).live));
  await js(`window.__playGame.emit('menu', true); 1`);
  await wait(800);
  await js(`document.querySelector('[data-leave]')?.click(); 1`);
  await wait(800);
  await shot('leave-confirm');
  await js(`document.querySelector('.modal [data-ok]')?.click(); 1`);
  await wait(2500);
  await shot('away');
  const away = await state();
  console.log('SMOKE mm left the match', JSON.stringify(away));
  await wait(3000);
  console.log('SMOKE mm away, still going', JSON.stringify((await state()).live));
  await js(`document.querySelector('[data-mm-reconnect]')?.click(); 1`);
  await wait(2500);
  await shot('reconnected');
  console.log('SMOKE mm reconnected', JSON.stringify((await state()).live));
  // Leave again (no second timeout) and abandon.
  await js(`window.__playGame.emit('menu', true); 1`);
  await wait(800);
  await js(`document.querySelector('[data-leave]')?.click(); 1`);
  await wait(800);
  await js(`document.querySelector('.modal [data-ok]')?.click(); 1`);
  await wait(2000);
  console.log('SMOKE mm left again', JSON.stringify((await state()).live));
  await js(`document.querySelector('[data-abandon]')?.click(); 1`);
  await wait(800);
  await js(`document.querySelector('.modal [data-ok]')?.click(); 1`);
  await wait(2500);
  await shot('abandoned');
  const ab = await state();
  console.log('SMOKE mm abandoned', JSON.stringify(ab), 'toast:', await js(`[...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' / ')`));
  await js(`document.querySelector('#topbar [data-page=play]').click(); 1`);
  await wait(1500);
  await shot('cooldown');
  console.log('SMOKE mm cooldown', await js(`JSON.stringify({ banner: document.querySelector('.play-cooldown')?.innerText.replace(/\\s+/g, ' '), go: document.querySelector('[data-go]')?.disabled })`));
  // Wingman's emblems, and the private lobby.
  console.log('SMOKE mm wingman emblems', await js(`(async () => { const a = await (await import('./js/rank.js')).loadRankArt(); return Object.keys(a?.emblems || {}).filter((k) => k.startsWith('wingman')).length; })()`));
  await js(`document.querySelector('[data-lobby=private]')?.click(); 1`);
  await wait(1200);
  await shot('private');
  console.log('SMOKE mm private lobby', await js(`document.querySelector('.play-setup')?.innerText.replace(/\\s+/g, ' ').slice(0, 400)`));
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
      // CS2SIM_SMOKE_SHOTS: a screenshot of each view (userData/perf-<map>-<view>.png) with three bots stopped in front
      // of you, facing you: to see that the world, the bots and the HUD look as they did.
      if (process.env.CS2SIM_SMOKE_SHOTS) {
        await js(`(() => { const g = window.__playGame, o = g.player.origin, yaw = g.input.yaw * Math.PI / 180;
          g.cv.bot_stop = 1;
          g.bots.filter((b) => b.c.alive).slice(0, 3).forEach((b, i) => {
            const d = 150 + i * 70, side = (i - 1) * 60, p = [o[0] + Math.cos(yaw) * d + Math.sin(yaw) * side, o[1] + Math.sin(yaw) * d - Math.cos(yaw) * side, o[2] + 40];
            b.pos = [p[0], p[1], g.floorAt(p, 300) ?? o[2]]; b.vel = [0, 0, 0]; b.yaw = b.bodyYaw = g.input.yaw + 180; b.pitch = 0; b.hasPrev = false;
          });
          return 1; })()`);
        await wait(1500);
        win.webContents.invalidate();
        await js('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
        fs.writeFileSync(path.join(app.getPath('userData'), `perf-${id}-${v.name}.png`), (await win.webContents.capturePage()).toPNG());
        await js('window.__playGame.cv.bot_stop = 0, 1');
      }
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
    document.querySelector('#topbar [data-page=cases]').click(); c.openCaseView(${JSON.stringify(id)}); })()`);
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

// `CS2SIM_SMOKE=charms` redeems a charm from the Armory and hangs it on an AK-47 from the market, seals a sticker in a
// Sticker Slab, and screenshots the gun's 3D inspect (close up), its first person and the slab into userData/charm-*.png.
async function runCharmSmoke(win) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => fs.writeFileSync(path.join(app.getPath('userData'), `charm-${name}.png`), (await win.webContents.capturePage()).toPNG());
  await wait(4000);
  console.log('SMOKE charms', await js(`(async () => { try {
    const { S } = await import('./js/state.js'); const { act } = await import('./js/backend.js'); const { D } = await import('./js/data.js');
    const MK = await import('./js/engine/market.js'); const A = await import('./js/engine/armory.js');
    S.money += 5000; S.stars += 10;
    const w = MK.marketWindow();
    const ak = Object.values(D.skins).find((s) => s.wid === 'weapon_ak47' && !s.v && MK.skinListings(s, w).length);
    const gun = (await act('market.buy', { kind: 'skin', id: ak.id, n: MK.skinListings(ak, w)[0].n, window: w })).item;
    const offer = A.armoryOffers(A.armoryWindow().i).offers.find((o) => o.type === 'charm');
    const charm = (await act('armory.redeem', { offer: offer.id, n: 1 })).item;
    await act('charms.attach', { uid: gun.uid, charm: charm.uid });
    const stk = Object.values(D.stickers).find((s) => !s.so && s.p > 1 && MK.unitStock('sticker', s, w) > 0);
    const slab = (await act('charms.slab', { uid: (await act('market.buy', { kind: 'sticker', id: stk.id, window: w })).item.uid })).item;
    window.__smoke = { gun: gun.uid, slab: slab.uid };
    return JSON.stringify({ gun: ak.n, charm: D.charms[charm.id].n, pattern: charm.pat, slab: D.stickers[slab.sk].n, value: S.inv.find((i) => i.uid === gun.uid).kc ? 'attached' : 'missing' });
  } catch (e) { return 'ERR ' + e.stack; } })()`));
  const inspect = (which) => js(`(async () => { const { S } = await import('./js/state.js'); const ui = await import('./js/ui.js'); const { inspectView } = await import('./js/inspect.js');
    document.querySelector('.inspect [data-a=close]')?.click();
    ui.openInspect(S.inv.find((i) => i.uid === window.__smoke.${which}));
    for (let i = 0; i < 240 && !(inspectView.model && !document.querySelector('.inspect .loading.model')); i++) await new Promise((r) => setTimeout(r, 500));
    let charm = null; inspectView.model?.traverse((o) => { if (o.name === 'charm') charm = o; });
    return JSON.stringify({ model: !!inspectView.model, source: inspectView.source, charm: !!charm, on: charm?.parent?.name || null, error: document.querySelector('.inspect .loading')?.textContent || null }); })()`);
  console.log('SMOKE gun inspect', await inspect('gun'));
  await wait(2500);
  await shot('gun');
  await js(`(async () => { const { inspectView } = await import('./js/inspect.js'); inspectView.state.zoom = 3; })()`);
  await wait(1500);
  await shot('gun-close');
  console.log('SMOKE first person', await js(`(async () => { try { const { inspectView } = await import('./js/inspect.js'); await inspectView.enterFirstPerson();
    let charm = null; inspectView.fp.rig.traverse((o) => { if (o.name === 'charm') charm = o; }); return JSON.stringify({ charm: !!charm, on: charm?.parent?.name || null });
  } catch (e) { return 'ERR ' + e.message; } })()`));
  await wait(1800);
  await shot('fp');
  console.log('SMOKE slab inspect', await inspect('slab'));
  await wait(2500);
  await shot('slab');
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
  await js(`window.__cs2Debug = true; document.querySelector('#topbar [data-page=play]').click(); setTimeout(() => document.querySelector('[data-start]').click(), 300); 1`);
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
  win.webContents.on('console-message', (e, level, message, line, source) => {
    // (errors say where: the file under js/ and the line)
    const isError = e.level === 'error' || level === 3, src = String(e.sourceId ?? source ?? '');
    const where = isError && src ? ` (${src.replace(/^.*\/js\//, '')}:${e.lineNumber ?? line})` : '';
    console.log('[renderer]', (e.message ?? message) + where);
  });
  if (process.env.CS2SIM_SMOKE === 'features') { win.webContents.once('did-finish-load', () => runFeatureSmoke(win).catch((e) => { console.error('SMOKE failed', e); app.quit(); })); return; }
  if (process.env.CS2SIM_SMOKE === 'play') { win.webContents.once('did-finish-load', () => runPlaySmoke(win).catch((e) => { console.error('SMOKE failed', e); app.quit(); })); return; }
  if (process.env.CS2SIM_SMOKE === 'perf') { win.webContents.once('did-finish-load', () => runPerfSmoke(win).catch((e) => { console.error('SMOKE failed', e); app.quit(); })); return; }
  if (process.env.CS2SIM_SMOKE === 'maps') { win.webContents.once('did-finish-load', () => runMapsSmoke(win).catch((e) => { console.error('SMOKE failed', e); app.quit(); })); return; }
  if (process.env.CS2SIM_SMOKE === 'bots') { win.webContents.once('did-finish-load', () => runBotsSmoke(win).catch((e) => { console.error('SMOKE failed', e); app.quit(); })); return; }
  if (process.env.CS2SIM_SMOKE === 'aspect') { win.webContents.once('did-finish-load', () => runAspectSmoke(win).catch((e) => { console.error('SMOKE failed', e); app.quit(); })); return; }
  if (process.env.CS2SIM_SMOKE === 'winbanner') { win.webContents.once('did-finish-load', () => runWinSmoke(win).catch((e) => { console.error('SMOKE failed', e); app.quit(); })); return; }
  if (process.env.CS2SIM_SMOKE === 'fire') { win.webContents.once('did-finish-load', () => runFireSmoke(win).catch((e) => { console.error('SMOKE failed', e); app.quit(); })); return; }
  if (process.env.CS2SIM_SMOKE === 'lineups') { win.webContents.once('did-finish-load', () => runLineupsSmoke(win).catch((e) => { console.error('SMOKE failed', e); app.quit(); })); return; }
  if (process.env.CS2SIM_SMOKE === 'drops') { win.webContents.once('did-finish-load', () => runDropsSmoke(win).catch((e) => { console.error('SMOKE failed', e); app.quit(); })); return; }
  if (process.env.CS2SIM_SMOKE === 'breakables') { win.webContents.once('did-finish-load', () => runBreakSmoke(win).catch((e) => { console.error('SMOKE failed', e); app.quit(); })); return; }
  if (process.env.CS2SIM_SMOKE === 'look') { win.webContents.once('did-finish-load', () => runLookSmoke(win).catch((e) => { console.error('SMOKE failed', e); app.quit(); })); return; }
  if (process.env.CS2SIM_SMOKE === 'rounds') { win.webContents.once('did-finish-load', () => runRoundsSmoke(win).catch((e) => { console.error('SMOKE failed', e); app.quit(); })); return; }
  if (process.env.CS2SIM_SMOKE === 'corpses') { win.webContents.once('did-finish-load', () => runCorpseSmoke(win).catch((e) => { console.error('SMOKE failed', e); app.quit(); })); return; }
  if (process.env.CS2SIM_SMOKE === 'botfire') { win.webContents.once('did-finish-load', () => runBotFireSmoke(win).catch((e) => { console.error('SMOKE failed', e); app.quit(); })); return; }
  if (process.env.CS2SIM_SMOKE === 'sound') { win.webContents.once('did-finish-load', () => runSoundSmoke(win).catch((e) => { console.error('SMOKE failed', e); app.quit(); })); return; }
  if (process.env.CS2SIM_SMOKE === 'mm') { win.webContents.once('did-finish-load', () => runMatchmakingSmoke(win).catch((e) => { console.error('SMOKE failed', e); app.quit(); })); return; }
  if (process.env.CS2SIM_SMOKE === 'premier') { win.webContents.once('did-finish-load', () => runPremierSmoke(win).catch((e) => { console.error('SMOKE failed', e); app.quit(); })); return; }
  if (process.env.CS2SIM_SMOKE === 'hitch') { win.webContents.once('did-finish-load', () => runHitchSmoke(win).catch((e) => { console.error('SMOKE failed', e); app.quit(); })); return; }
  if (process.env.CS2SIM_SMOKE === 'prepare') { win.webContents.once('did-finish-load', () => runPrepareSmoke(win).catch((e) => { console.error('SMOKE failed', e); app.quit(); })); return; }
  if (process.env.CS2SIM_SMOKE === 'crate') { win.webContents.once('did-finish-load', () => runCrateSmoke(win).catch((e) => { console.error('SMOKE failed', e); app.quit(); })); return; }
  if (process.env.CS2SIM_SMOKE === 'charms') { win.webContents.once('did-finish-load', () => runCharmSmoke(win).catch((e) => { console.error('SMOKE failed', e); app.quit(); })); return; }
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
