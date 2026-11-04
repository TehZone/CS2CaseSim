// Bakes what the game draws charm pictures from (see src/js/charmlook.js): renders every charm through the real 3D charm
// in a hidden Electron window and writes src/img/charms/<id>.webp and src/data/charm-looks.json. They ship with the game,
// so players need no CS2 install; this needs one, and is run again when charms or the charm shader change.
//   node scripts/build-charm-pics.mjs                  every charm
//   node scripts/build-charm-pics.mjs keychain-25 ...  just these (the rest of the data stays)
//   --check <dir>   also compares them with the real 3D charm at several patterns, writes the pictures side by side
//                   there, and fails if any is off
//   --port <n>      a dev server already running there, else one is started
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src', 'img', 'charms'), LOOKS = path.join(ROOT, 'src', 'data', 'charm-looks.json');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
// How far a picture may be from the real charm: the mean difference of its pixels, of 255, at any of the patterns checked.
// Only glitter comes near this: its flakes are single pixels that catch the light differently at each size.
const CHECK_PATTERNS = [1, 4242, 33333, 66666, 100000], MAX_ERROR = 10;

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? null : args.splice(i, 2)[1]; };
const checkDir = opt('--check');
let port = +opt('--port') || 0;

const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'data', 'game-data.json'), 'utf8'));
const ids = args.length ? args : Object.keys(data.charms);
for (const id of ids) if (!data.charms[id]) throw new Error('No charm ' + id);

let server = null;
if (!port) {
  port = 5299;
  server = spawn(process.execPath, ['scripts/dev-server.mjs', '--port', String(port)], { cwd: ROOT, stdio: 'ignore' });
}
for (let i = 0; ; i++) {
  try { if ((await fetch(`http://localhost:${port}/api/cs2/status`)).ok) break; } catch { /* still starting */ }
  if (i > 100) throw new Error('The dev server did not start');
  await new Promise((r) => setTimeout(r, 100));
}
const status = await (await fetch(`http://localhost:${port}/api/cs2/status`)).json();
if (!status.available) throw new Error('Counter-Strike 2 is not installed: the charm pictures are baked from its files');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'charm-pics-'));
const job = path.join(tmp, 'job.json'), looksFile = path.join(tmp, 'looks.json');
const steps = ids.flatMap((id) => [
  { fn: 'layers', key: id, arg: { id } },
  ...(checkDir ? [{ fn: 'compare', arg: { id, pats: CHECK_PATTERNS } }] : []),
]);
fs.writeFileSync(job, JSON.stringify({ out: path.join(tmp, 'out'), looks: looksFile, steps }));

const report = [];
const code = await new Promise((res) => {
  const p = spawn(ELECTRON, [path.join('scripts', 'charm-bake', 'main.cjs'), String(port), job], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  const lines = (chunk) => {
    buf += chunk;
    const all = buf.split('\n');
    buf = all.pop();
    for (const l of all) if (/^(layers|compare|  #|bake failed)/.test(l)) { console.log(l); report.push(l); }
  };
  p.stdout.on('data', lines);
  p.stderr.on('data', lines);
  p.on('close', res);
});
server?.kill();
if (code) throw new Error('The bake failed');

const fresh = JSON.parse(fs.readFileSync(looksFile, 'utf8'));
const looks = fs.existsSync(LOOKS) ? JSON.parse(fs.readFileSync(LOOKS, 'utf8')) : {};
fs.mkdirSync(OUT, { recursive: true });
for (const id of ids) {
  delete looks[id];
  for (const f of [`${id}.webp`, `${id}-print.webp`]) fs.rmSync(path.join(OUT, f), { force: true });
}
Object.assign(looks, fresh);
const made = path.join(tmp, 'out');
for (const f of fs.readdirSync(made)) {
  if (f.endsWith('.webp')) fs.copyFileSync(path.join(made, f), path.join(OUT, f));
  else if (checkDir) { fs.mkdirSync(checkDir, { recursive: true }); fs.copyFileSync(path.join(made, f), path.join(checkDir, f)); }
}
const sorted = Object.fromEntries(Object.keys(data.charms).filter((id) => looks[id]).map((id) => [id, looks[id]]));
fs.writeFileSync(LOOKS, JSON.stringify(sorted));
fs.rmSync(tmp, { recursive: true, force: true });

const size = fs.readdirSync(OUT).reduce((n, f) => n + fs.statSync(path.join(OUT, f)).size, 0);
console.log(`${Object.keys(sorted).length} charms with pictures, ${(size / 1048576).toFixed(1)} MB`);
if (checkDir) {
  const errors = report.flatMap((l) => { const m = l.match(/mean err ([\d.]+)/); return m ? [+m[1]] : []; });
  const worst = Math.max(...errors);
  console.log(`checked ${errors.length} patterns: mean error ${(errors.reduce((a, b) => a + b, 0) / errors.length).toFixed(2)}/255, worst ${worst}/255`);
  fs.mkdirSync(checkDir, { recursive: true });
  fs.writeFileSync(path.join(checkDir, 'report.txt'), report.join('\n'));
  if (worst > MAX_ERROR) throw new Error(`A picture is off the real charm by ${worst}/255 (more than ${MAX_ERROR})`);
}
