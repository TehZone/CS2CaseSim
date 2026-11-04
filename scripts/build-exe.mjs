// Builds dist/CS2-Case-Simulator-Setup.exe, dist/CS2-Case-Simulator.exe and dist/latest.json: the three files a GitHub
// release of the game carries (see "Releasing a new version" in DEPLOY.md). electron-builder's NSIS step fails on very
// long Windows paths, so the app is staged in a short temp folder, built there, and the exes copied back.
//   CS2SIM_BUILD_DIR=<dir>: build in that folder and leave the files in <dir>/out instead (a test build beside the real one)
//   CS2SIM_BUILD_PATCH=<json>: merged into the built package.json (a test build's version and name)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = process.env.CS2SIM_BUILD_DIR ? path.resolve(process.env.CS2SIM_BUILD_DIR) : path.join(os.tmpdir(), 'cs2sim-build');
const OUT = process.env.CS2SIM_BUILD_DIR ? path.join(STAGE, 'out') : path.join(ROOT, 'dist');
const { FILE_KINDS, MANIFEST } = createRequire(import.meta.url)('../shared/release.cjs');
const merge = (a, b) => { for (const [k, v] of Object.entries(b)) a[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(a[k] || {}, v) : v; return a; };
const lock = (dir) => { try { return fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'); } catch { return ''; } };

fs.mkdirSync(STAGE, { recursive: true });
const reuseModules = fs.existsSync(path.join(STAGE, 'node_modules')) && lock(STAGE) === lock(ROOT);
for (const entry of ['main.js', 'preload.js', 'package.json', 'package-lock.json', 'shared', 'cs2', 'src', 'build', 'tools']) {
  fs.rmSync(path.join(STAGE, entry), { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, entry), path.join(STAGE, entry), { recursive: true });
}
if (!reuseModules) {
  console.log('Copying node_modules to', STAGE, '(first build only)...');
  fs.rmSync(path.join(STAGE, 'node_modules'), { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, 'node_modules'), path.join(STAGE, 'node_modules'), { recursive: true });
}
if (process.env.CS2SIM_BUILD_PATCH) {
  const file = path.join(STAGE, 'package.json');
  fs.writeFileSync(file, JSON.stringify(merge(JSON.parse(fs.readFileSync(file, 'utf8')), JSON.parse(process.env.CS2SIM_BUILD_PATCH)), null, 2));
}
fs.rmSync(path.join(STAGE, 'dist'), { recursive: true, force: true });
execSync('npx electron-builder --win', { cwd: STAGE, stdio: 'inherit' });
fs.mkdirSync(OUT, { recursive: true });
const files = {};
for (const [kind, exe] of Object.entries(FILE_KINDS)) {
  const file = path.join(OUT, exe);
  fs.copyFileSync(path.join(STAGE, 'dist', exe), file);
  const bytes = fs.readFileSync(file);
  files[kind] = { name: exe, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  console.log('Built', file);
}
// What the game and the server read from the release (shared/release.cjs). The version is the one just built into the
// exes, so the two can't disagree; the notes are what the update window shows.
const { version } = JSON.parse(fs.readFileSync(path.join(STAGE, 'package.json'), 'utf8'));
const notes = fs.existsSync(path.join(ROOT, 'RELEASE_NOTES.md')) ? fs.readFileSync(path.join(ROOT, 'RELEASE_NOTES.md'), 'utf8').trim() : '';
fs.writeFileSync(path.join(OUT, MANIFEST), JSON.stringify({ version, date: new Date().toISOString(), notes, files }, null, 2));
console.log('Built', path.join(OUT, MANIFEST), 'for version', version);
