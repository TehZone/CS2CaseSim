// The updater's tests, without Electron: versions, latest.json, the check failing safely, the download's checks, and the
// portable swap run for real (on a stand-in exe, in a folder with awkward characters, held open as the portable wrapper
// holds it). Nothing here reaches the internet: GitHub is a server on this machine.
//   node scripts/test-update.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../shared/release.cjs');
const { createUpdater } = require('../shared/updater.cjs');

let failed = 0, passed = 0;
const check = (name, ok, info = '') => { ok ? passed++ : failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(50); } return null; };
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cs2sim-test-update-'));

// ---- versions -------------------------------------------------------------------------------------------------------
{
  const c = R.compareVersions;
  check('versions compare number by number, not as text', c('1.10.0', '1.9.0') === 1 && c('1.9.0', '1.10.0') === -1 && c('2.0.0', '1.99.99') === 1 && c('1.0.10', '1.0.9') === 1);
  check('the same version is equal, with or without a v', c('1.2.3', '1.2.3') === 0 && c('v1.2.3', '1.2.3') === 0 && c(' 1.2.3 ', 'v1.2.3') === 0);
  check('something that is no version comes before every version', c(undefined, '0.0.1') === -1 && c('0.0.1', null) === 1 && c('abc', '0.0.0') === -1 && c(undefined, 'abc') === 0);
  check('only x.y.z counts: prereleases, parts missing or extra, signs and huge numbers don\'t',
    ['1.2', '1', '1.2.3.4', '1.2.3-beta', '-1.2.3', '1.2.x', '', '1.2.99999999999999999999', 7, {}, [], null].every((v) => R.parseVersion(v) === null));
  check('outdated: below the required version, or no version at all', R.isOutdated('1.0.0', '1.1.0') && R.isOutdated(undefined, '1.1.0') && R.isOutdated('junk', '1.1.0'));
  check('not outdated: the required version, a newer one, or nothing required', !R.isOutdated('1.1.0', '1.1.0') && !R.isOutdated('1.10.0', '1.9.0') && !R.isOutdated(undefined, null) && !R.isOutdated('1.0.0', null));
}

// ---- latest.json ----------------------------------------------------------------------------------------------------
const FILE = { name: 'CS2-Case-Simulator.exe', size: 10, sha256: 'A'.repeat(64) };
{
  const m = R.parseManifest({ version: 'v1.2.3', notes: '  Fixes  ', files: { portable: FILE } });
  check('latest.json: read, with the v taken off and the hash in lower case', m?.version === '1.2.3' && m.notes === 'Fixes' && m.files.portable.sha256 === 'a'.repeat(64));
  const bad = (f) => R.parseManifest({ version: '1.2.3', files: { portable: { ...FILE, ...f } } });
  check('latest.json: a file name that leaves the folder is refused', !bad({ name: '..\\..\\evil.exe' }) && !bad({ name: '../evil.exe' }) && !bad({ name: '..' }) && !bad({ name: 'a/b.exe' }));
  check('latest.json: a file without a real size or hash is refused', !bad({ size: 0 }) && !bad({ size: -1 }) && !bad({ size: '10' }) && !bad({ sha256: 'abc' }) && !bad({ sha256: undefined }));
  check('latest.json: no version, no files, or not an object: nothing', !R.parseManifest({ files: { portable: FILE } }) && !R.parseManifest({ version: '1.2.3' }) && !R.parseManifest(null) && !R.parseManifest('x') && !R.parseManifest([]));
  check('latest.json: long notes are cut', R.parseManifest({ version: '1.0.0', notes: 'x'.repeat(9000), files: { portable: FILE } }).notes.length === 4000);
}

// ---- a stand-in for GitHub's release files ---------------------------------------------------------------------------
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const installerBytes = crypto.randomBytes(300000), portableBytes = crypto.randomBytes(200000);
const manifest = (version = '1.2.0', extra = {}) => ({
  version, notes: 'What\'s new',
  files: {
    installer: { name: 'Setup.exe', size: installerBytes.length, sha256: sha(installerBytes) },
    portable: { name: 'Game.exe', size: portableBytes.length, sha256: sha(portableBytes) },
  },
  ...extra,
});
let route = {};
const feed = http.createServer((req, res) => {
  const f = route[req.url.slice(1)];
  if (typeof f === 'function') return f(res);
  if (f === undefined) { res.writeHead(404); return res.end('Not Found'); }
  res.writeHead(200);
  res.end(typeof f === 'object' && !Buffer.isBuffer(f) ? JSON.stringify(f) : f);
});
await new Promise((r) => feed.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${feed.address().port}`;
const good = () => ({ 'latest.json': manifest(), 'Setup.exe': installerBytes, 'Game.exe': portableBytes });

// A fake child process, started or failing as asked; the calls it got.
const fakeSpawn = (fails = false) => {
  const calls = [];
  const spawner = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const c = new EventEmitter();
    c.unref = () => {};
    setImmediate(() => (fails ? c.emit('error', new Error('blocked')) : c.emit('spawn')));
    return c;
  };
  return { calls, spawner };
};
const make = (o = {}) => createUpdater({ version: '1.1.0', kind: 'installer', dir: path.join(DIR, 'updates'), base, ...o });

try {
  // ---- the check failing safely -------------------------------------------------------------------------------------
  route = good();
  let r = await make().check();
  check('a newer release is found, with its notes and size', r.available && r.version === '1.2.0' && r.current === '1.1.0' && r.notes === 'What\'s new' && r.size === installerBytes.length && r.install);
  check('numbers again: 1.10.0 is an update from 1.9.0', (route['latest.json'] = manifest('1.10.0'), (await make({ version: '1.9.0' }).check()).available));
  route = good();
  check('the same version is no update', !(await make({ version: '1.2.0' }).check()).available);
  check('an older release is no update', !(await make({ version: '1.3.0' }).check()).available);
  const off = await make({ enabled: false, fetcher: () => { throw new Error('asked'); } }).check();
  check('switched off (development, smoke runs): nothing is asked', !off.available && off.reason === 'off');
  for (const [what, set] of [
    ['no release yet (404)', () => { route = {}; }],
    ['a rate limit (403)', () => { route = { 'latest.json': (res) => { res.writeHead(403); res.end('{"message":"API rate limit exceeded"}'); } }; }],
    ['a rate limit (429)', () => { route = { 'latest.json': (res) => { res.writeHead(429); res.end(); } }; }],
    ['GitHub down (500)', () => { route = { 'latest.json': (res) => { res.writeHead(500); res.end(); } }; }],
    ['GitHub down (503, an HTML page)', () => { route = { 'latest.json': (res) => { res.writeHead(503); res.end('<html>'); } }; }],
    ['an HTML page with a 200', () => { route = { 'latest.json': '<!doctype html><html>' }; }],
    ['broken JSON', () => { route = { 'latest.json': '{"version":' }; }],
    ['a release with no files', () => { route = { 'latest.json': { version: '9.0.0', files: {} } }; }],
    ['the connection dropped', () => { route = { 'latest.json': (res) => res.socket.destroy() }; }],
  ]) {
    set();
    const out = await make().check().catch((e) => ({ threw: e }));
    check(`check: ${what} is no popup and no crash`, out.available === false && !out.threw, out.reason);
  }
  const noNet = await make({ fetcher: () => Promise.reject(new TypeError('fetch failed')) }).check();
  check('check: no internet is no popup and no crash', noNet.available === false);
  const syncThrow = await make({ fetcher: () => { throw new Error('boom'); } }).check();
  check('check: even a fetch that throws is no crash', syncThrow.available === false);

  // ---- which builds can update themselves ---------------------------------------------------------------------------
  route = good();
  check('a game in a folder (no installer) is sent to the download page', !(await make({ kind: 'folder' }).check()).install);
  check('development too', !(await make({ kind: 'dev' }).check()).install);
  check('a portable game with no exe path too', !(await make({ kind: 'portable' }).check()).install);
  route['latest.json'] = { version: '1.2.0', files: { installer: manifest().files.installer } };
  check('a release with only the installer: a portable game can\'t install it', !(await make({ kind: 'portable', exe: path.join(DIR, 'g.exe') }).check()).install);

  // ---- the download's checks ----------------------------------------------------------------------------------------
  const updates = path.join(DIR, 'updates');
  const left = () => (fs.existsSync(updates) ? fs.readdirSync(updates) : []);
  const downloaded = async (routes, o = {}) => {
    route = routes;
    const u = make(o);
    await u.check();
    const progress = [];
    return { u, result: await u.download((p) => progress.push(p)), progress };
  };
  let d = await downloaded(good());
  check('a good download: checked, on disk, with progress up to the full size', d.result.ok && left().length === 1 && fs.readFileSync(path.join(updates, left()[0])).equals(installerBytes)
    && d.progress.at(-1)?.received === installerBytes.length && d.progress.at(-1)?.total === installerBytes.length, JSON.stringify([d.result, d.progress.length]));
  const first = left()[0];
  d.u.cleanup();
  check('a download ready to install isn\'t cleared from under it', left().includes(first));
  check('asking again doesn\'t download it twice', (await d.u.download()).ok && left().length === 1);
  fs.rmSync(updates, { recursive: true, force: true });

  const corrupt = Buffer.from(installerBytes); corrupt[1000] ^= 1;
  d = await downloaded({ ...good(), 'Setup.exe': corrupt });
  check('a corrupt download (one bit) is refused and deleted', !d.result.ok && /doesn't match/.test(d.result.error) && !left().length, d.result.error);
  check('and nothing can be installed from it', !(await d.u.install()).ok);
  d = await downloaded({ ...good(), 'Setup.exe': installerBytes.subarray(0, 1000) });
  check('a short download is refused and deleted', !d.result.ok && !left().length);
  d = await downloaded({ ...good(), 'Setup.exe': Buffer.concat([installerBytes, Buffer.from('more')]) });
  check('a long download is refused and deleted', !d.result.ok && !left().length);
  d = await downloaded({ 'latest.json': manifest() });
  check('a file that\'s missing from the release fails with a message', !d.result.ok && /download failed/.test(d.result.error) && !left().length);
  d = await downloaded({ ...good(), 'Setup.exe': (res) => { res.writeHead(200); res.write(installerBytes.subarray(0, 5000)); setTimeout(() => res.socket.destroy(), 50); } });
  check('a connection lost halfway fails with a message and leaves nothing', !d.result.ok && !left().length);

  route = { ...good(), 'Setup.exe': (res) => { res.writeHead(200); res.write(installerBytes.subarray(0, 5000)); } }; // (and never finishes)
  let u = make();
  await u.check();
  const going = u.download();
  await wait(200);
  u.cancel();
  r = await going;
  check('cancelling stops it and leaves nothing', !r.ok && r.cancelled && !left().length);
  const nothing = await make().download();
  check('nothing to download: a message, no crash', !nothing.ok);

  // A portable game in a folder it can't write to (standing in for that: a folder that is really a file).
  fs.writeFileSync(path.join(DIR, 'not-a-folder'), '');
  route = good();
  u = make({ kind: 'portable', exe: path.join(DIR, 'not-a-folder', 'Game.exe') });
  await u.check();
  r = await u.download();
  check('a folder it can\'t write in fails with a message, no crash', !r.ok && !!r.error, r.error);

  // ---- installing ---------------------------------------------------------------------------------------------------
  let quit = 0;
  let sp = fakeSpawn();
  route = good();
  u = make({ spawner: sp.spawner, quit: () => quit++ });
  await u.check();
  await u.download();
  r = await u.install();
  check('the installer runs by itself, asks nothing and starts the game after', r.ok && sp.calls.length === 1 && path.dirname(sp.calls[0].cmd) === updates && sp.calls[0].cmd.endsWith('Setup.exe') && sp.calls[0].args.join(' ') === '--updated --force-run' && sp.calls[0].opts.detached);
  check('and the game quits', quit === 1);

  quit = 0;
  sp = fakeSpawn(true);
  u = make({ spawner: sp.spawner, quit: () => quit++ });
  await u.check();
  await u.download();
  r = await u.install();
  check('an installer that can\'t start (blocked by antivirus): the game stays open and says so', !r.ok && !!r.error && quit === 0, r.error);

  fs.mkdirSync(updates, { recursive: true });
  fs.writeFileSync(path.join(updates, 'leftover.exe'), 'x');
  make().cleanup();
  check('what an earlier update left is cleared at the next start', !left().includes('leftover.exe'));

  // An installer that has run can stay undeletable for a long while. It must not stop the next update.
  if (process.platform === 'win32') {
    const stuck = path.join(updates, 'Setup.exe');
    fs.writeFileSync(stuck, 'an old installer');
    const hold = `$f=[IO.File]::Open($env:LOCKED,'Open','Read','None'); [Console]::Out.WriteLine('locked'); Start-Sleep 3; $f.Close()`;
    const holder = spawn('powershell.exe', ['-NoProfile', '-Command', hold], { env: { ...process.env, LOCKED: stuck }, stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((res) => holder.stdout.once('data', res));
    route = good();
    u = make({ spawner: fakeSpawn().spawner });
    let threw = false;
    try { u.cleanup(); } catch { threw = true; }
    check('a leftover that can\'t be deleted is left alone, with no crash', !threw && left().includes('Setup.exe'));
    await u.check();
    r = await u.download();
    check('and the next update downloads anyway', r.ok && left().length === 2, JSON.stringify(left()));
    await new Promise((res) => holder.once('close', res));
    fs.rmSync(updates, { recursive: true, force: true });
  }

  // ---- the portable swap, for real ----------------------------------------------------------------------------------
  // The new exe is a copy of node, a real program: told by NODE_OPTIONS to write down where it was started from.
  if (process.platform === 'win32') {
    const home = path.join(DIR, 'Bob (2) & 100%!');
    fs.mkdirSync(home, { recursive: true });
    const exe = path.join(home, 'game.exe'), marker = path.join(DIR, 'ran.txt'), hook = path.join(DIR, 'hook.cjs');
    fs.writeFileSync(exe, 'the old game');
    fs.writeFileSync(hook, `require('fs').writeFileSync(${JSON.stringify(marker)}, process.execPath);`);
    const bytes = fs.readFileSync(process.execPath);
    const m = { version: '1.2.0', files: { portable: { name: 'Game.exe', size: bytes.length, sha256: sha(bytes) } } };
    route = { 'latest.json': m, 'Game.exe': bytes };
    quit = 0;
    u = createUpdater({ version: '1.1.0', kind: 'portable', exe, dir: '', tempDir: DIR, base, quit: () => quit++ });
    await u.check();
    r = await u.download();
    check('portable: the new exe lands beside the old one, checked', r.ok && fs.readFileSync(`${exe}.update`).equals(bytes));
    // Held open with no sharing for 4 s, as the wrapper holds the running exe.
    const lockCmd = `$f=[IO.File]::Open($env:LOCKED,'Open','Read','None'); [Console]::Out.WriteLine('locked'); Start-Sleep 4; $f.Close()`;
    const holder = spawn('powershell.exe', ['-NoProfile', '-Command', lockCmd], { env: { ...process.env, LOCKED: exe }, stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((res) => holder.stdout.once('data', res));
    process.env.NODE_OPTIONS = `--require "${hook.replace(/\\/g, '/')}"`; // (a backslash in there is an escape)
    r = await u.install();
    delete process.env.NODE_OPTIONS;
    check('portable: the swap starts and the game quits', r.ok && quit === 1);
    await wait(2000);
    check('portable: while the exe is held, nothing has moved', fs.existsSync(`${exe}.update`) && !fs.existsSync(marker));
    check('portable: once free it is replaced and started, in a folder with spaces, brackets, & and %', await until(() => fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === exe));
    check('portable: the old exe is gone and nothing is left beside it', fs.readFileSync(exe).equals(bytes) && !fs.existsSync(`${exe}.update`));
    check('portable: the swap script deletes itself', await until(() => !fs.readdirSync(DIR).some((f) => f.startsWith('cs2sim-swap'))));
  }
} catch (e) {
  failed++;
  console.error('FAIL  test crashed:', e);
}
feed.closeAllConnections?.();
feed.close();
try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
