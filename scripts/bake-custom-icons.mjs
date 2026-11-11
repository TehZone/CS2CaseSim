// Draws custom items' pictures from their 3D (CUSTOM_CONTENT.md): every custom skin, knife and pair of gloves in the packs
// that has no icon.png gets one, rendered on its real CS2 model through the game's own 3D code in a hidden window, and
// written beside its skin.json (where you can keep it, or paint over it). Then build as usual: node scripts/build-custom.mjs.
// Needs your CS2 install (players never do: the picture ships with the game).
//   node scripts/bake-custom-icons.mjs                       custom/
//   node scripts/bake-custom-icons.mjs --src docs/custom-example
//   --force         draws every item's again, over the icon.png it has
//   --shots <dir>   also writes check pictures there: each item as drawn, and each custom case's 3D crate
//   --port <n>      a dev server already running there with --custom <a build of these packs>; else one is started
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildCustom, writeBuild } from './build-custom.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const src = path.resolve(opt('--src') || path.join(ROOT, 'custom'));
const shots = opt('--shots') ? path.resolve(opt('--shots')) : null;
const force = args.includes('--force');
let port = +opt('--port') || 0;

// A draft build of the packs (stand-in pictures where there are none) for the game to load.
const r = buildCustom({ src, draft: true });
for (const e of r.errors) console.log('ERROR    ' + e);
if (!r.ok) process.exit(1);
if (!r.custom) { console.log('No custom content in ' + src); process.exit(0); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-icons-'));
writeBuild(r, { out: tmp });

// Which items to draw, and the folder each picture goes to.
const steps = [];
for (const [id, { dir, iconFloat: fl, iconSeed: sd }] of Object.entries(r.sources)) {
  const has = fs.readdirSync(dir).some((x) => x.toLowerCase() === 'icon.png');
  if (has && !force && !shots) continue;
  const s = r.custom.skins[id];
  steps.push({ fn: 'icon', arg: { id, fl: fl ?? Math.round(Math.min(s.mx, s.mn + 0.01) * 1e4) / 1e4, sd: sd ?? 0 }, out: has && !force ? null : path.join(dir, 'icon.png'), shot: shots && path.join(shots, id + '.png') });
}
if (shots) for (const c of r.custom.cases) steps.push({ fn: 'crate', arg: { id: c.id }, shot: path.join(shots, c.id + '-crate.png') });
if (!steps.length) { console.log('Every item has its icon.png (--force draws them again).'); process.exit(0); }

let server = null;
if (!port) {
  port = 5301;
  server = spawn(process.execPath, ['scripts/dev-server.mjs', '--port', String(port), '--custom', tmp], { cwd: ROOT, stdio: 'ignore' });
}
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(`http://localhost:${port}/api/cs2/status`)).ok) break; } catch { /* still starting */ }
    if (i > 100) throw new Error('The dev server did not start');
    await new Promise((res) => setTimeout(res, 100));
  }
  const status = await (await fetch(`http://localhost:${port}/api/cs2/status`)).json();
  if (!status.available) throw new Error('Counter-Strike 2 is not installed: the pictures are drawn from its models');
  const job = path.join(tmp, 'job.json');
  fs.writeFileSync(job, JSON.stringify({ steps }));
  const code = await new Promise((res) => {
    const p = spawn(ELECTRON, [path.join('scripts', 'custom-bake', 'main.cjs'), String(port), job], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, CUSTOM_BAKE_PROFILE: path.join(tmp, 'profile') } });
    p.on('close', res);
  });
  if (code) throw new Error('The bake failed');
  for (const s of steps) if (s.out && fs.existsSync(s.out)) console.log('wrote ' + path.relative(ROOT, s.out));
  // (Only custom/ builds into the game: another folder is tried in a folder of its own.)
  const live = src === path.join(ROOT, 'custom');
  console.log(live ? 'Now build: npm run custom' : `Now try it: node scripts/build-custom.mjs --src "${path.relative(ROOT, src) || src}" --try (it prints how to run the game with it)`);
} finally {
  server?.kill();
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch (e) { console.log(`(left ${tmp}: ${e.code})`); }
}
