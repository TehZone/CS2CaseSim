// Builds dist/CS2-Case-Simulator.exe. electron-builder's NSIS step fails on very long Windows paths,
// so the app is staged in a short temp folder, built there, and the exe copied back.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = path.join(os.tmpdir(), 'cs2sim-build');
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
fs.rmSync(path.join(STAGE, 'dist'), { recursive: true, force: true });
execSync('npx electron-builder --win', { cwd: STAGE, stdio: 'inherit' });
fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
for (const exe of ['CS2-Case-Simulator-Setup.exe', 'CS2-Case-Simulator.exe']) {
  fs.copyFileSync(path.join(STAGE, 'dist', exe), path.join(ROOT, 'dist', exe));
  console.log('Built', path.join(ROOT, 'dist', exe));
}
