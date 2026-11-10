// What every Case Hardened and Heat Treated skin really looks like at every pattern seed, for the labels in
// engine/patterns.js. The game's own bake (CS2's shader, skin.js) paints each seed, in a hidden Electron window with a user
// data folder of its own, and the paint is counted where it shows on the real model, with no scene lighting: how much of
// the painted metal reads blue, gold or neither, from both sides and from above. Writes src/js/engine/case-hardened-data.js:
//   { [weapon id]: { [paint kit]: { side, high, above, gold, t1, t2, b, g } } }
// b and g are the playside's blue and gold: two base-32 digits per seed 0-1000, in tenths of a percent. side is which side
// that is: the side first person shows the most of, from CS2's own viewmodel at rest (the community's Karambit and
// Five-SeveN seeds come out first there). The AK-47's is its top instead. And only the part that counts is counted, which on
// most knives is the blade and on the AK-47 the dust cover: see PARTS in measure.js. That's what the community's numbers
// are of, and with it the seeds of every skin read what its numbers say.
// The numbers go in a file of their own, not game-data.json: its generatedAt is the lock between game and server.
// Gloves aren't measured: CS2 bakes each hand on its own seed, they have no paint mask, and no side to call the playside.
//
// The rest are the cut-offs for that skin, from its own seeds, because each weapon's range is its own (a MAC-10's bluest is
// 70%, a Talon's 100%). What each one is and why:
//   (high and above are no longer labels: since 2026-11-10 only Blue Gems and Gold Gems are named. They stay in the data.)
//   high   High Blue: the bluest 5% of the weapon's seeds. Every one of them shows more blue than gold, on every skin.
//   above  Above-average blue: the bluest 20%, and at least 10 points over the weapon's typical seed. On most skins that
//          second part changes nothing, but Heat Treated seeds sit in one tight hump: on the Desert Eagle the 20% mark is 5
//          points over typical, and side by side the two look the same.
//   gold   Gold Gem: gold over blue by at least this many points. Over blue, because blue is what the eye catches: a seed
//          with none looks as gold as one with a little more gold and a patch of it. No Gold Gem has over 8% blue that way.
//          It's within 14 points of the skin's best seed, what all gold can reach on that shape of blade, and never under
//          75. So it goes by the look and not by a number of seeds, and how many a skin has is what its blade gives: from 6
//          on a Gut Knife to about 60 on an AK-47. The floor keeps it off skins that never get there: the Shadow Daggers
//          stop at 70 (the community lists none) and Heat Treated well under that.
//   t1, t2 Blue Gem tiers: the bluest seeds, as many as the lists they replace held, so that a seed bluer than a Blue Gem is
//          a Blue Gem too. The lists left in patterns.js only add to Tier 1.
//
// Needs a CS2 install and a dev server (one is started). About half a minute a skin.
//   node scripts/build-case-hardened.mjs                  every skin
//   node scripts/build-case-hardened.mjs weapon_ak47 ...  just these weapons (the rest of the file stays)
//   --raw <file>   keep the whole measurement there too: all three sides, with each side's other colours
//   --from <file>  no measuring: write the file from such a measurement (new cut-offs need nothing else)
//   --port <n>     a dev server already running there
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src', 'js', 'engine', 'case-hardened-data.js');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

const SEEDS = 1001;
const HIGH_SHARE = 0.05, ABOVE_SHARE = 0.2, ABOVE_GAP = 10;
const GOLD = { least: 75, within: 14 };
// How many seeds Tier 1 and Tier 2 take: as many as the skin had on the lists these replace (the AK-47's Tier 1 with its #1).
const TIER_SEEDS = { weapon_ak47: [14, 12], weapon_fiveseven: [7, 6], weapon_knife_karambit: [9, 6] };
const tierSeeds = ({ wid, cat }) => TIER_SEEDS[wid] ?? (cat === 'knife' ? [13, 6] : [8, 4]);

// The cut-offs of one skin (see the top of this file).
function cutOffs(skin, { blue, gold }) {
  const bluest = [...blue].sort((a, b) => b - a), nth = (list, n) => list[n - 1];
  const median = bluest[Math.floor(SEEDS / 2)];
  const high = nth(bluest, Math.round(SEEDS * HIGH_SHARE));
  const above = Math.max(nth(bluest, Math.round(SEEDS * ABOVE_SHARE)), Math.round((median + ABOVE_GAP) * 10) / 10);
  const goldest = Math.max(...gold.map((g, seed) => g - blue[seed]));
  const [t1, t2] = tierSeeds(skin);
  return { high, above, gold: Math.max(GOLD.least, Math.round((goldest - GOLD.within) * 10) / 10), t1: nth(bluest, t1), t2: nth(bluest, t1 + t2) };
}

const encode = (list) => list.map((v) => Math.round(v * 10).toString(32).padStart(2, '0')).join('');

function write(entries) {
  const lines = Object.keys(entries).sort().map((wid) => `  ${wid}: {\n${Object.keys(entries[wid]).sort().map((fid) => {
    const { b, g, ...rest } = entries[wid][fid];
    return `    ${fid}: { ${Object.entries(rest).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ')},\n      b: '${b}',\n      g: '${g}' },`;
  }).join('\n')}\n  },`);
  fs.writeFileSync(OUT, `// Made by scripts/build-case-hardened.mjs, which says what all of this means. Don't edit it by hand.
export const CASE_HARDENED = {
${lines.join('\n')}
};
`);
}

// Measures the skins with CS2's files. → { [weapon id]: { [paint kit]: measurement } }, as far as it got.
async function measure(skins, port) {
  let server = null;
  if (!port) {
    port = 5298;
    server = spawn(process.execPath, ['scripts/dev-server.mjs', '--port', String(port)], { cwd: ROOT, stdio: 'ignore' });
  }
  for (let i = 0; ; i++) {
    try { if ((await fetch(`http://localhost:${port}/api/cs2/status`)).ok) break; } catch { /* still starting */ }
    if (i > 100) throw new Error('The dev server did not start');
    await new Promise((r) => setTimeout(r, 100));
  }
  const status = await (await fetch(`http://localhost:${port}/api/cs2/status`)).json();
  if (!status.available) throw new Error('Counter-Strike 2 is not installed: the skins are painted from its files');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'case-hardened-'));
  const dir = path.join(tmp, 'skins'), userData = path.join(tmp, 'user-data'), job = path.join(tmp, 'job.json');
  fs.mkdirSync(dir);
  fs.writeFileSync(job, JSON.stringify({ dir, userData, skins }));

  const code = await new Promise((res) => {
    const p = spawn(ELECTRON, [path.join('scripts', 'case-hardened', 'main.cjs'), String(port), job], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const lines = (chunk) => {
      buf += chunk;
      const all = buf.split('\n');
      buf = all.pop();
      for (const l of all) if (/^(measure:|measuring failed)/.test(l)) console.log(l);
    };
    p.stdout.on('data', lines);
    p.stderr.on('data', lines);
    p.on('close', res);
  });
  server?.kill();

  // What finished is kept even if a later skin failed.
  const results = {};
  for (const { wid, fid } of skins) {
    const file = path.join(dir, `${wid}.${fid}.json`);
    if (fs.existsSync(file)) (results[wid] ||= {})[fid] = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  return { results, failed: code !== 0 };
}

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? null : args.splice(i, 2)[1]; };
const raw = opt('--raw'), from = opt('--from'), port = +opt('--port') || 0;

const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'data', 'game-data.json'), 'utf8'));
const skins = Object.values(data.skins)
  .filter((s) => (s.fin === 'Case Hardened' || s.fin === 'Heat Treated') && s.cat !== 'gloves' && (!args.length || args.includes(s.wid)))
  .map(({ wid, fid, cat, n }) => ({ wid, fid, cat, n }));
if (!skins.length) throw new Error('No such skins');

const { results, failed } = from ? { results: JSON.parse(fs.readFileSync(from, 'utf8')), failed: false } : await measure(skins, port);

const entries = fs.existsSync(OUT) ? structuredClone((await import(pathToFileURL(OUT).href)).CASE_HARDENED) : {};
for (const skin of skins) {
  const m = results[skin.wid]?.[skin.fid];
  if (m) (entries[skin.wid] ||= {})[skin.fid] = { side: m.sideChosen, ...cutOffs(skin, m), b: encode(m.blue), g: encode(m.gold) };
}
write(entries);
if (raw) {
  const kept = fs.existsSync(raw) ? JSON.parse(fs.readFileSync(raw, 'utf8')) : {};
  for (const [wid, kits] of Object.entries(results)) Object.assign(kept[wid] ||= {}, kits);
  fs.mkdirSync(path.dirname(path.resolve(raw)), { recursive: true });
  fs.writeFileSync(raw, JSON.stringify(kept));
}
if (failed) throw new Error('The measuring failed');
console.log('wrote', OUT);
