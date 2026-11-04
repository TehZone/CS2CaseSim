// The update run for real, end to end: two builds of the game (the same code, an older and a newer version), a stand-in
// for GitHub's release files on this machine, and the older build updating itself to the newer one, as the installed game
// and as the portable exe, by clicking through the real window. The builds have their own package name (which is the
// install folder) and product name (the save folder and the exe), so they install and save beside the real game and never
// touch it. Windows only; a build takes a few minutes, and windows will open.
// Everything is started through Explorer, as a player starts it. Run from a Store app (the Claude desktop app is one),
// child processes get a private copy of %APPDATA%, which the game relaunched by the installer wouldn't share.
//   node scripts/test-update-e2e.mjs build     builds both, in <temp>/cs2e2e (never while another build is running)
//   node scripts/test-update-e2e.mjs run       runs the updates on those builds
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.join(os.tmpdir(), 'cs2e2e');
const NAME = 'CS2 Sim Update Test', PACKAGE = 'cs2-sim-update-test';
const REAL_GAME = path.join(process.env.LOCALAPPDATA, 'Programs', 'cs2-case-sim', 'CS2 Case Simulator.exe');
const OLD = '1.1.0', NEW = '1.1.1';
const SETUP = 'CS2-Case-Simulator-Setup.exe', PORTABLE = 'CS2-Case-Simulator.exe';
const DATA = path.join(process.env.APPDATA, NAME); // the test builds' userData
const SHOTS = path.join(WORK, 'shots');
const DEBUG_PORT = 9347;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch {}
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
    await wait(250);
  }
};
let failed = 0, passed = 0;
const check = (name, ok, info = '') => { ok ? passed++ : failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };

function build() {
  const running = execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match \'electron-builder|build-exe|makensis\' -and $_.ProcessId -ne $PID } | Measure-Object | Select-Object -ExpandProperty Count"', { encoding: 'utf8' }).trim();
  if (+running > 1) throw new Error('another build is running');
  for (const [version, dir] of [[OLD, 'old'], [NEW, 'new']]) {
    console.log(`building ${version}...`);
    const patch = { name: PACKAGE, version, productName: NAME, build: { appId: 'com.dawso.cs2sim.updatetest', productName: NAME, nsis: { shortcutName: NAME } } };
    execSync(`node "${path.join(ROOT, 'scripts/build-exe.mjs')}"`, { stdio: 'inherit', env: { ...process.env, CS2SIM_BUILD_DIR: path.join(WORK, 'stage'), CS2SIM_BUILD_PATCH: JSON.stringify(patch) } });
    fs.rmSync(path.join(WORK, dir), { recursive: true, force: true });
    fs.renameSync(path.join(WORK, 'stage', 'out'), path.join(WORK, dir));
    // (run won't install a build unless this says it can't land on the real game.)
    const built = JSON.parse(fs.readFileSync(path.join(WORK, 'stage', 'package.json'), 'utf8'));
    fs.writeFileSync(path.join(WORK, dir, 'test-build.json'), JSON.stringify({ name: built.name, productName: built.productName, version: built.version }));
  }
}

// ---- the stand-in for GitHub ----------------------------------------------------------------------------------------
const served = [];
let corrupt = false; // (the next exe asked for comes with one bit wrong)
const feed = http.createServer((req, res) => {
  const name = path.basename(req.url);
  // (As GitHub does: a release file's address redirects to where the file really is.)
  if (!req.url.startsWith('/assets/')) { res.writeHead(302, { location: `/assets/${name}` }); return res.end(); }
  const file = path.join(WORK, 'new', name);
  served.push(name);
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('Not Found'); }
  const bytes = fs.readFileSync(file);
  if (corrupt && name.endsWith('.exe')) { corrupt = false; bytes[bytes.length >> 1] ^= 1; }
  res.writeHead(200, { 'content-length': bytes.length });
  res.end(bytes);
});

// ---- the game's page, over the DevTools protocol -----------------------------------------------------------------------
async function page() {
  const list = await until(async () => {
    const pages = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()).filter((t) => t.type === 'page');
    return pages.length ? pages : null;
  }, 120000, 'the game\'s page');
  const ws = new WebSocket(list[0].webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
  return {
    eval: async (expression) => {
      const r = await Promise.race([send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }), wait(120000).then(() => null)]);
      if (!r) throw new Error(`no answer from the page: ${expression.slice(0, 80)}`);
      return r.result?.result?.value;
    },
    shot: async (name) => {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      if (r.result?.data) fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.result.data, 'base64'));
    },
    close: () => { try { ws.close(); } catch {} },
  };
}

// Runs commands outside whatever started this script, and waits for them.
let outsideRuns = 0;
async function outside(...lines) {
  const file = path.join(WORK, `outside-${++outsideRuns}.cmd`), done = `${file}.done`;
  fs.rmSync(done, { force: true });
  fs.writeFileSync(file, ['@echo off', ...lines, `echo done> "${done}"`, ''].join('\r\n'));
  spawn('explorer.exe', [file], { detached: true, stdio: 'ignore' }).unref();
  await until(() => fs.existsSync(done), 180000, `outside: ${lines.at(-1)}`);
  fs.rmSync(file, { force: true });
  fs.rmSync(done, { force: true });
}
const startGame = (exe, env) => outside(...Object.entries(env).map(([k, v]) => `set ${k}=${v}`), `start "" "${exe}" --remote-debugging-port=${DEBUG_PORT}`);
async function clearData() {
  await outside(`if exist "${DATA}" rmdir /s /q "${DATA}"`);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
}

const ps = (cmd) => execSync(`powershell -NoProfile -Command "${cmd}"`, { encoding: 'utf8' }).trim();
// (1.1.1 or 1.1.1.0: the portable wrapper and the game write it differently. Quiet: the file goes away during an install.)
const isVersion = (exe, v) => fs.existsSync(exe) && [v, `${v}.0`].includes(ps(`(Get-Item -LiteralPath '${exe.replace(/'/g, "''")}' -ErrorAction SilentlyContinue).VersionInfo.ProductVersion`));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const gameProcesses = () => ps(`(Get-CimInstance Win32_Process -Filter \\"Name='${NAME}.exe'\\" | ForEach-Object { $_.ExecutablePath }) -join ';'`);
// (By this name only: the real game may be running.)
const killGame = () => { try { execSync(`taskkill /F /T /IM "${NAME}.exe"`, { stdio: 'ignore' }); } catch {} };
const updateLog = () => { try { return fs.readFileSync(path.join(DATA, 'update.log'), 'utf8'); } catch { return ''; } };
const modalText = `document.querySelector('.modal')?.innerText || ''`;
// (Past the boot, which ends in the game connecting by itself: a login any sooner races that.)
const booted = async (p) => { await until(() => p.eval(`!!document.querySelector('#page') && !document.querySelector('#page .boot') && !!window.native?.build`), 120000, 'the game to boot'); await wait(1000); };
const online = `import('./js/net/online.js').then((o) => o.net)`;
const testEnv = () => ({ CS2SIM_UPDATE_FEED: `http://127.0.0.1:${feed.address().port}`, CS2SIM_SMOKE_SERVER: `http://localhost:${game.port}` });
let game = null; // a real game server on this machine, locked by the same stand-in release
let accounts = 0;

// Starts the older game and goes through the window; `corruptFirst`: a damaged download first, and Try again.
async function clickThrough(exe, tag, { corruptFirst = false } = {}) {
  await startGame(exe, testEnv());
  const p = await page();
  await booted(p);
  check(`${tag}: the game says it's ${OLD}`, (await p.eval('window.native.build.version')) === OLD);
  await until(() => p.eval(`!!document.querySelector('.update-modal')`), 60000, 'the update window');
  const offer = await p.eval(modalText);
  check(`${tag}: the window offers the new version, with its notes`, offer.includes(`Version ${NEW}`) && offer.includes(`You have ${OLD}`) && offer.includes('The first version with updates') && /not now/i.test(offer) && /\bupdate\b/i.test(offer), offer.replace(/\s+/g, ' ').slice(0, 160));
  await p.shot(`${tag}-1-offer`);

  await p.eval(`document.querySelector('.update-modal [data-close]').click()`);
  await until(() => p.eval(`!document.querySelector('.update-modal') && !!document.querySelector('.fatal-modal')`), 5000, 'the warning');
  const warning = await p.eval(modalText);
  check(`${tag}: Not now warns that online play stops`, /won't be able to play online with other players until you update/.test(warning), warning.replace(/\s+/g, ' ').slice(0, 160));
  await p.shot(`${tag}-2-warning`);
  await p.eval(`document.querySelector('.fatal-modal [data-close]').click()`);
  check(`${tag}: and the game carries on, with an Update button left at the top right`, await until(() => p.eval(`!document.querySelector('.modal') && !!document.querySelector('#update-btn')`), 5000, 'the button'));
  // Logging in anyway: the server refuses this version, and the game says why and offers the update.
  const refused = await p.eval(`(async () => { const net = await ${online}; try { await net.login('e2e_player' + ${++accounts}, 'local-test-pass-1', { register: true }); return 'let in'; } catch (e) { return e.message; } })()`);
  check(`${tag}: the server refuses this version`, /out of date/.test(refused), refused);
  await until(() => p.eval(`!!document.querySelector('.update-modal') && !document.querySelector('.update-modal [data-locked]').hidden`), 10000, 'the update window after the refusal');
  const locked = await p.eval(modalText);
  check(`${tag}: the game explains why and offers the update`, /can't play online with other players until you update/.test(locked) && locked.includes(`Version ${NEW}`), locked.replace(/\s+/g, ' ').slice(0, 160));
  await p.shot(`${tag}-2b-refused`);

  // Something to find again afterwards.
  const money = 4242.42;
  await p.eval(`(async () => { const st = await import('./js/state.js'); st.S.money = ${money}; st.saveSync(); return 1; })()`);

  if (corruptFirst) {
    corrupt = true;
    await p.eval(`document.querySelector('.update-modal [data-go]').click()`);
    await until(() => p.eval(`/doesn't match/.test(document.querySelector('.update-modal [data-err]')?.textContent || '')`), 180000, 'the damaged download to be refused');
    check(`${tag}: a damaged download is refused, and the game stays open`, true);
    await p.shot(`${tag}-3-corrupt`);
  }
  await p.eval(`document.querySelector('.update-modal [data-go]').click()`);
  const during = await until(() => p.eval(`document.querySelector('.update-modal [data-status]')?.textContent.startsWith('Downloading') ? document.querySelector('.update-modal [data-status]').textContent : ''`), 30000, 'the progress');
  check(`${tag}: the download shows its progress`, /of \d+ MB/.test(during), during);
  await p.shot(`${tag}-4-progress`);
  return money;
}

// The one server: a packaged game ignores a saved address and offers no way to set one, and says who's online as it should.
async function runServerChecks() {
  console.log('\n---- one server, in the packaged game ----');
  const exe = path.join(WORK, 'new', PORTABLE);
  await startGame(exe, { ...testEnv(), CS2SIM_SMOKE_SERVER: '' });
  let p = await page();
  try {
    await booted(p);
    check('packaged: the game says it\'s packaged, with no server override', await p.eval(`window.native.build.packaged && !window.native.build.server`));
    await p.eval(`localStorage.setItem('cs2sim-online', JSON.stringify({ url: 'http://example.invalid', token: 'old-token', name: 'x' })); location.reload(); 1`);
    await wait(1500);
    await booted(p);
    check('packaged: a server saved by an older install is ignored', (await p.eval(`${online}.then((n) => n.serverUrl())`)) === 'https://cs2-case-sim-server.onrender.com');
    const left = JSON.parse(await p.eval(`localStorage.getItem('cs2sim-online')`));
    check('packaged: and the login that went with it is dropped, so nothing is sent to the real server', !left.url && !left.token, JSON.stringify(left));
    await p.eval(`${online}.then((n) => n.setServerUrl('http://example.invalid'))`);
    check('packaged: nothing in the page can set another one', (await p.eval(`${online}.then((n) => n.serverUrl())`)) === 'https://cs2-case-sim-server.onrender.com');
    await p.eval(`document.querySelector('#account').click()`);
    await wait(300);
    const form = await p.eval(`[...document.querySelectorAll('.modal label')].map((l) => l.textContent.trim()).join(', ') + ' / ' + !!document.querySelector('.modal [data-url]')`);
    check('packaged: the login window asks for no server', form === 'Username, Password / false', form);
    await p.shot('packaged-login');
  } finally {
    p.close();
    killGame();
  }
  await wait(3000);
  // The same exe on the test server (a test run's only way to one), and what it says once connected.
  await startGame(exe, testEnv());
  p = await page();
  try {
    await booted(p);
    const in_ = await p.eval(`(async () => { const net = await ${online}; try { await net.login('e2e_staff', 'local-test-pass-1', { register: true }); return 'let in'; } catch (e) { return e.message; } })()`);
    check('packaged: the latest version is let in', in_ === 'let in', in_);
    await wait(500);
    check('packaged: a test server saying you\'re staff doesn\'t unlock the offline admin panel on this PC',
      (await p.eval(`document.body.classList.contains('is-staff')`)) && !(await p.eval(`localStorage.getItem('cs2-admin-pc')`)));
    await p.eval(`document.querySelector('#account').click()`);
    await wait(300);
    const chip = await p.eval(`document.querySelector('#account').title || document.querySelector('#account').dataset.tip`);
    const win = await p.eval(modalText);
    check('packaged: the top right says it as asked', chip === 'Online. Players Online: 1', chip);
    check('packaged: the account window too, with no address in it', win.includes('Online. Players Online: 1') && !/https?:|localhost|onrender/.test(win), win.replace(/\s+/g, ' ').slice(0, 120));
    await p.shot('packaged-online');
  } finally {
    p.close();
    killGame();
  }
  await wait(3000);
}

async function runInstaller() {
  console.log('\n---- the installer ----');
  await clearData();
  await outside(`start "" /wait "${path.join(WORK, 'old', SETUP)}" /S`);
  const home = path.join(process.env.LOCALAPPDATA, 'Programs', PACKAGE);
  const exe = path.join(home, `${NAME}.exe`);
  await until(() => fs.existsSync(exe), 60000, 'the install');
  check('installer: the older version is installed', isVersion(exe, OLD), exe);
  try {
    const money = await clickThrough(exe, 'installer');
    const t0 = Date.now(), secs = () => `${Math.round((Date.now() - t0) / 1000)} s`;
    await until(() => isVersion(exe, NEW), 240000, 'the new version on disk');
    check('installer: the new version is on disk', true, secs());
    check('installer: the file was checked before it ran', /download checked/.test(updateLog()));
    const running = await until(() => (gameProcesses().includes(home) ? gameProcesses() : ''), 120000, 'the game to start again');
    check('installer: the game started again by itself', !!running, secs());
    check('installer: and it is the new version running', await until(() => updateLog().includes(`${NEW} started (installer)`), 180000, 'the new version\'s log'), secs());
    const downloads = () => fs.readdirSync(path.join(DATA, 'updates')).filter((f) => /^\d+-/.test(f));
    check('installer: the downloaded installer is cleared up a minute later', await until(() => !downloads().length, 120000, 'the download to be cleared'), secs());
    const saved = JSON.parse(fs.readFileSync(path.join(DATA, 'save.json'), 'utf8'));
    check('installer: the save came through', Math.abs(saved.money - money) < 0.01, `money ${saved.money}`);
  } finally {
    killGame();
    await wait(1500);
    const un = path.join(home, `Uninstall ${NAME}.exe`);
    if (fs.existsSync(un)) await outside(`start "" /wait "${un}" /S`);
    // (The installer keeps a copy of itself here.)
    await outside(`if exist "${path.join(process.env.LOCALAPPDATA, PACKAGE + '-updater')}" rmdir /s /q "${path.join(process.env.LOCALAPPDATA, PACKAGE + '-updater')}"`);
  }
}

async function runPortable() {
  console.log('\n---- the portable exe ----');
  await clearData();
  const home = path.join(WORK, 'Portable (1) & co');
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  const exe = path.join(home, PORTABLE);
  fs.copyFileSync(path.join(WORK, 'old', PORTABLE), exe);
  check('portable: the older version is in its folder', isVersion(exe, OLD));
  try {
    const money = await clickThrough(exe, 'portable', { corruptFirst: true });
    const target = sha(path.join(WORK, 'new', PORTABLE));
    await until(() => sha(exe) === target, 300000, 'the exe to be replaced');
    check('portable: the exe was replaced by the new one, byte for byte', isVersion(exe, NEW));
    check('portable: nothing is left beside it', await until(() => fs.readdirSync(home).length === 1, 30000, 'the folder to be clean'), fs.readdirSync(home).join(', '));
    check('portable: and it started again by itself', await until(() => updateLog().includes(`${NEW} started (portable)`), 120000, 'the new version\'s log'));
    const saved = JSON.parse(fs.readFileSync(path.join(DATA, 'save.json'), 'utf8'));
    check('portable: the save came through', Math.abs(saved.money - money) < 0.01, `money ${saved.money}`);
  } finally {
    killGame();
  }
}

async function run() {
  for (const d of ['old', 'new']) {
    const built = fs.existsSync(path.join(WORK, d, 'test-build.json')) && JSON.parse(fs.readFileSync(path.join(WORK, d, 'test-build.json'), 'utf8'));
    if (built?.name !== PACKAGE || built?.productName !== NAME) throw new Error('build first: node scripts/test-update-e2e.mjs build');
  }
  const real = () => { const s = fs.statSync(REAL_GAME, { throwIfNoEntry: false }); return s ? `${s.size} ${s.mtimeMs}` : 'not installed'; };
  const realBefore = real();
  fs.mkdirSync(SHOTS, { recursive: true });
  const only = process.argv[3];
  await new Promise((r) => feed.listen(0, '127.0.0.1', r));
  const { startServer } = await import('../server/index.mjs');
  game = await startServer({ port: 0, log: () => {}, priceRefresh: false, discord: false, admins: ['e2e_staff'], release: { feed: `http://127.0.0.1:${feed.address().port}/latest.json`, every: 3600000 } });
  await until(() => game.srv.release.required === NEW, 15000, 'the server to read the release');
  await clearData();
  try {
    if (!only) await runServerChecks();
    if (only !== 'portable') await runInstaller();
    if (only !== 'installer') await runPortable();
  } catch (e) {
    failed++;
    console.error('FAIL  run stopped:', e.message);
    await wait(500);
    console.error('update.log:\n' + updateLog());
    killGame();
  }
  await clearData().catch(() => {});
  check('the real game\'s install was not touched', real() === realBefore, realBefore);
  await game.close().catch(() => {});
  feed.closeAllConnections?.();
  feed.close();
  console.log(`\nasked of the feed: ${[...new Set(served)].join(', ')}`);
  console.log(`screenshots in ${SHOTS}`);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

if (process.argv[2] === 'build') build();
else if (process.argv[2] === 'run') await run();
else console.log('node scripts/test-update-e2e.mjs build | run [installer|portable]');
