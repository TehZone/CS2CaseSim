// The packaged game's updater, for both builds. It reads latest.json from the newest GitHub release (shared/release.cjs),
// downloads the exe of the build it's running from there, checks its size and SHA-256 against latest.json, and hands over:
//   installer: runs the new Setup.exe (one click and per-user, so no prompt: it only shows its progress bar, for the half a
//              minute the game is gone), which closes this game, replaces it and starts it
//   portable:  a small script waits for this exe to be free, puts the new one in its place and starts it (the running exe
//              can't be touched: the portable wrapper around the game holds it open until the game has quit)
// Failing is always quiet: no internet or a GitHub error is just "no update", and a failed download leaves the game alone.
// src/js/update.js is the window the player sees, and decides when to check.
//
// createUpdater holds all of it (scripts/test-update.mjs runs it on a fake feed without Electron); initUpdater connects it.
//
// Test runs: CS2SIM_UPDATE_FEED=http://127.0.0.1:<port> reads the release from a feed on this machine (no other host is
// accepted) and CS2SIM_SMOKE_SERVER=http://localhost:<port> plays on a server on this machine. Nothing a player can see or
// save changes either.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { RELEASE_PAGE, RELEASE_FILES, MANIFEST, compareVersions, parseManifest } = require('./release.cjs');

const STALL_MS = 60000; // a download that gets nothing for this long has failed
const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/;
const localOnly = (url) => (url && LOCAL.test(url) ? url.replace(/\/+$/, '') : '');

// Waits for the old exe to be free (the wrapper quits a few seconds after the game), then swaps and starts it. The paths
// come in the environment, so nothing in them can break the script. Two minutes of trying, then the old exe starts again.
const SWAP_SCRIPT = `@echo off
set tries=0
:again
move /y "%CS2SIM_NEW%" "%CS2SIM_EXE%" >nul 2>&1
if not errorlevel 1 goto run
set /a tries+=1
if %tries% geq 120 goto run
ping -n 2 127.0.0.1 >nul
goto again
:run
start "" "%CS2SIM_EXE%"
(goto) 2>nul & del "%~f0"
`;

// { version, kind: 'installer' | 'portable' | 'folder' | 'dev', exe: the portable exe, dir: for the installer's download,
//   tempDir, base: where the release's files are, fetcher, quit, log, enabled }
function createUpdater({ version, kind, exe = '', dir, tempDir = os.tmpdir(), base = RELEASE_FILES, fetcher = (...a) => fetch(...a), quit = () => {}, log = () => {}, enabled = true, spawner = spawn }) {
  let latest = null; // the release found to be newer
  let job = null, abort = null, cancelled = false; // the download under way
  let ready = ''; // the downloaded, checked file

  const fileOf = (m) => m?.files[kind] || null;
  const canInstall = (m) => (kind === 'installer' || (kind === 'portable' && !!exe)) && !!fileOf(m);

  // { available, version, current, notes, size, install } or { available: false, reason }. Never throws.
  async function check() {
    if (!enabled) return { available: false, reason: 'off' };
    try {
      const res = await fetcher(`${base}/${MANIFEST}`, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (!res.ok) return { available: false, reason: `HTTP ${res.status}` };
      const m = parseManifest(await res.json());
      if (!m) return { available: false, reason: 'no release in the file' };
      if (compareVersions(m.version, version) <= 0) { latest = null; return { available: false, reason: 'up to date' }; }
      if (latest?.version !== m.version) ready = '';
      latest = m;
      log(`update ${m.version} found (this is ${version}, ${kind})`);
      return { available: true, version: m.version, current: version, notes: m.notes, size: fileOf(m)?.size || 0, install: canInstall(m) };
    } catch (e) {
      return { available: false, reason: e.message };
    }
  }

  async function fetchTo(file, target, onProgress) {
    const ctl = new AbortController();
    abort = () => ctl.abort();
    let stall = setTimeout(() => ctl.abort(), STALL_MS);
    const alive = () => { clearTimeout(stall); stall = setTimeout(() => ctl.abort(), STALL_MS); };
    const out = fs.createWriteStream(target);
    const failed = new Promise((_, reject) => out.once('error', reject));
    failed.catch(() => {});
    try {
      await Promise.race([once(out, 'open'), failed]);
      const res = await fetcher(`${base}/${file.name}`, { cache: 'no-store', signal: ctl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const hash = crypto.createHash('sha256'), reader = res.body.getReader();
      let got = 0, shown = 0;
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), failed]);
        if (done) break;
        alive();
        got += value.length;
        if (got > file.size) throw new Error('bad-file');
        hash.update(value);
        if (!out.write(value)) await Promise.race([once(out, 'drain'), failed]);
        if (got - shown > file.size / 200 || got === file.size) { shown = got; onProgress?.({ received: got, total: file.size }); }
      }
      if (got !== file.size || hash.digest('hex') !== file.sha256) throw new Error('bad-file');
      out.end();
      await Promise.race([once(out, 'close'), failed]);
    } catch (e) {
      out.destroy();
      if (!out.closed) await once(out, 'close').catch(() => {});
      try { fs.rmSync(target, { force: true }); } catch {} // (what's left goes at the next start; the reason is e)
      throw e;
    } finally {
      clearTimeout(stall);
      abort = null;
    }
  }

  // { ok: true } with the file checked, or { ok: false, error, cancelled? }.
  function download(onProgress) {
    if (job) return job;
    cancelled = false;
    job = (async () => {
      if (!latest || !canInstall(latest)) return { ok: false, error: 'This copy of the game can\'t update itself. Get the new version from the download page.' };
      const file = fileOf(latest);
      if (ready && fs.existsSync(ready)) return { ok: true };
      ready = '';
      // (The installer gets a new name each time: an old one that has run can stay undeletable for a long while, with
      // nothing to show what's holding it, and a fixed name would then fail every update after it.)
      const target = kind === 'portable' ? `${exe}.update` : path.join(dir, `${Date.now()}-${file.name}`);
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        log(`downloading ${file.name} (${file.size} bytes) to ${target}`);
        await fetchTo(file, target, onProgress);
        ready = target;
        log('download checked: size and SHA-256 match');
        return { ok: true };
      } catch (e) {
        const why = e?.message || String(e);
        log(`download failed: ${why}`);
        if (cancelled) return { ok: false, cancelled: true, error: '' };
        if (why === 'bad-file') return { ok: false, error: 'The download doesn\'t match the release, so it wasn\'t installed. Try again.' };
        if (kind === 'portable' && ['EACCES', 'EPERM', 'EROFS'].includes(e?.code)) return { ok: false, error: 'The game can\'t write to the folder it\'s in. Move it somewhere you can write to, or get the new version from the download page.' };
        if (e?.code === 'ENOSPC') return { ok: false, error: 'There isn\'t enough disk space for the update.' };
        return { ok: false, error: 'The download failed. Check your internet connection and try again.' };
      }
    })().finally(() => { job = null; });
    return job;
  }

  const cancel = () => { cancelled = true; abort?.(); return true; };

  function started(child) {
    return new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  }

  // Hands over to the new version and quits: { ok: false, error } if it couldn't, and the game stays open.
  async function install() {
    if (!ready || !fs.existsSync(ready)) return { ok: false, error: 'The update isn\'t downloaded yet.' };
    try {
      let child;
      if (kind === 'installer') {
        log(`starting the installer ${ready}`);
        child = spawner(ready, ['--updated', '--force-run'], { detached: true, stdio: 'ignore' });
      } else {
        const script = path.join(tempDir, `cs2sim-swap-${process.pid}.cmd`);
        fs.writeFileSync(script, SWAP_SCRIPT.replace(/\n/g, '\r\n'));
        log(`swapping ${exe} once it's free`);
        // (Relative to its own folder: cmd /c has its own ideas about quotes in a path like "Bob (2)". The .\ because a
        // bare name isn't looked for in the current folder if NoDefaultCurrentDirectoryInExePath is set.)
        child = spawner(process.env.ComSpec || 'cmd.exe', ['/d', '/c', `.\\${path.basename(script)}`], {
          cwd: tempDir, detached: true, stdio: 'ignore', windowsHide: true,
          env: { ...process.env, CS2SIM_NEW: ready, CS2SIM_EXE: exe },
        });
      }
      await started(child);
      child.unref();
      quit();
      return { ok: true };
    } catch (e) {
      log(`could not start the update: ${e?.message || e}`);
      return { ok: false, error: 'The update couldn\'t start. Get the new version from the download page.' };
    }
  }

  // What an earlier update left behind. Anything that can't go yet stays for the next time, and never gets in the way.
  function cleanup() {
    if (job || ready) return;
    const old = dir && fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => path.join(dir, f)) : [];
    for (const f of [...old, ...(exe ? [`${exe}.update`] : [])]) try { fs.rmSync(f, { force: true }); } catch {}
  }

  return { check, download, cancel, install, cleanup };
}

// Which build this is. The installer leaves an uninstaller beside the game; a folder (npm run dist:dir) has none.
function buildKind(app) {
  if (!app.isPackaged) return 'dev';
  if (process.env.PORTABLE_EXECUTABLE_FILE) return 'portable';
  return fs.existsSync(path.join(path.dirname(process.execPath), `Uninstall ${app.getName()}.exe`)) ? 'installer' : 'folder';
}

// Called when the app is ready, before the window opens.
function initUpdater({ smoke = false } = {}) {
  const { app, ipcMain, net, shell } = require('electron');
  const userDir = app.getPath('userData');
  const logFile = path.join(userDir, 'update.log');
  const log = (m) => {
    try {
      if (fs.statSync(logFile, { throwIfNoEntry: false })?.size > 256 * 1024) fs.rmSync(logFile, { force: true });
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${app.getVersion()} ${m}\n`);
    } catch {}
  };
  const feed = localOnly(process.env.CS2SIM_UPDATE_FEED);
  const kind = buildKind(app);
  const updater = createUpdater({
    version: app.getVersion(), kind, exe: process.env.PORTABLE_EXECUTABLE_FILE || '', dir: path.join(userDir, 'updates'), tempDir: app.getPath('temp'),
    base: feed || RELEASE_FILES, fetcher: (u, o) => net.fetch(u, o), quit: () => app.quit(), log,
    enabled: !smoke && (app.isPackaged || !!feed),
  });
  if (app.isPackaged && !smoke) {
    log(`started (${kind})`);
    updater.cleanup();
    setTimeout(updater.cleanup, 60000); // (the installer that started this game is still closing just now)
  }

  // What the page needs before anything else (preload.js): its version, and a test run's own server.
  const build = { version: app.getVersion(), packaged: app.isPackaged, server: localOnly(process.env.CS2SIM_SMOKE_SERVER) };
  ipcMain.on('app:build', (e) => { e.returnValue = build; });
  ipcMain.handle('update:check', () => updater.check());
  ipcMain.handle('update:download', (e) => updater.download((p) => { if (!e.sender.isDestroyed()) e.sender.send('update:progress', p); }));
  ipcMain.handle('update:cancel', () => updater.cancel());
  ipcMain.handle('update:install', () => updater.install());
  ipcMain.handle('update:page', () => shell.openExternal(RELEASE_PAGE));
}

module.exports = { createUpdater, initUpdater, SWAP_SCRIPT };
