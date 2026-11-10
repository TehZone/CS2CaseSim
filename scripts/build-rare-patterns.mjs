// The CS.MONEY Wiki's rare patterns (https://wiki.cs.money/rare-patterns) for engine/patterns.js. The wiki has a page for each of
// 100 skins (knives, a few guns and five pairs of gloves) that sorts their pattern seeds into named groups: Blue and Gold Gems,
// Fire & Ice ranks and tips, Slaughter's diamonds and hearts, webs, stripes and the like, some with a tier. For a Fade it also
// gives every seed's real fade percentage. Each page carries it all in its __NEXT_DATA__ (screens.patterns: groups, and fade
// for a Fade); scripts/data/cs-money-rare-patterns.json keeps just that, fetched 2026-11-10: every skin's name, groups
// ({ name, tier, type, seeds }) and fade percentages, and nothing else (no pictures).
// Its seeds are the same 0-1000 as CS2's Pattern Template and the game's: each page lists seeds 0 to 1000, and the seeds it
// ranks first are the ones the game's own measuring found first (the AK-47's 661, the Karambit's 387 and Marble Fade 412).
//
// This writes src/js/engine/rare-patterns-data.js (see the top of that file for its shape): each skin found in the game by its
// name (a StatTrak™ copy is the same skin), its groups' seeds packed two base-32 digits a seed, and the Fades' percentages packed
// like case-hardened-data.js's, each pattern once for all the skins that share it. What a group is called in the game, its tier
// and what it adds to the value is patterns.js's (RARE), not this file's. A Fade's groups (90% to 100%) are only checked here:
// patterns.js goes by the percentage itself, so two copies that show the same one read the same.
//   node scripts/build-rare-patterns.mjs
//   node scripts/build-rare-patterns.mjs --trim <file>   first rewrite scripts/data/cs-money-rare-patterns.json from a fresh
//                                                        download: { [wiki path]: { name, fade, groups, ... } }
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'scripts', 'data', 'cs-money-rare-patterns.json');
const OUT = path.join(ROOT, 'src', 'js', 'engine', 'rare-patterns-data.js');
const SEEDS = 1001;

const args = process.argv.slice(2);
const trim = args.includes('--trim') ? args[args.indexOf('--trim') + 1] : null;
if (args.includes('--trim') && !trim) throw new Error('--trim needs the downloaded file');

// A fresh download (one object per wiki page) down to what's used, one skin a line.
if (trim) {
  const raw = JSON.parse(fs.readFileSync(trim, 'utf8'));
  const skins = Object.keys(raw).sort().map((k) => {
    const { name, fade, groups } = raw[k];
    const kept = { name, ...(fade ? { fade } : {}), groups: groups.map(({ name: n, tier, type, seeds }) => ({ name: n, tier, type, seeds })) };
    return `    ${JSON.stringify(k)}: ${JSON.stringify(kept)}`;
  });
  fs.writeFileSync(SRC, `{
  "source": "https://wiki.cs.money/rare-patterns",
  "fetched": "${fs.statSync(trim).mtime.toISOString().slice(0, 10)}",
  "about": "Each skin's rare pattern groups and, for a Fade, every seed's fade percentage, from the __NEXT_DATA__ of its page on the CS.MONEY Wiki (screens.patterns). Keyed by the page's path under /weapons. Seeds run 0-1000. Read by scripts/build-rare-patterns.mjs.",
  "skins": {
${skins.join(',\n')}
  }
}
`);
  console.log('wrote', SRC, skins.length, 'skins');
}

const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const game = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'data', 'game-data.json'), 'utf8'));
const byName = new Map();
for (const s of Object.values(game.skins)) if (!s.v) byName.set(s.n, [...(byName.get(s.n) || []), s]);

const b32 = (n, width) => n.toString(32).padStart(width, '0');
const isSeed = (x) => Number.isInteger(x) && x >= 0 && x < SEEDS;
const fades = new Map(); // packed pattern -> { id, p, names }
const out = {};
const problems = [];
for (const [page, e] of Object.entries(src.skins)) {
  const found = byName.get(e.name) || [];
  if (found.length !== 1) { problems.push(`${page}: ${e.name} is ${found.length} skins in the game`); continue; }
  const skin = found[0];
  if ((out[skin.wid] ||= {})[skin.fid]) { problems.push(`${page}: ${skin.wid} ${skin.fid} twice`); continue; }
  for (const g of e.groups) if (!g.seeds.length || !g.seeds.every(isSeed)) problems.push(`${page}: ${g.name} has a seed outside 0-1000`);
  if (e.fade) {
    if (e.fade.length !== SEEDS || !e.fade.every((x) => x >= 0 && x <= 100)) { problems.push(`${page}: fade isn't 1001 percentages`); continue; }
    // The wiki's groups are each seed's percentage to the nearest whole percent (which way an x.5 went, its hidden decimals
    // decided): at most one a seed, and never more than half a percent off.
    const whole = new Array(SEEDS).fill(null);
    for (const g of e.groups) {
      const pc = +g.type;
      if (!(pc >= 90 && pc <= 100) || g.tier != null) { problems.push(`${page}: a Fade group that isn't 90-100%: ${g.name}`); continue; }
      for (const sd of g.seeds) {
        if (whole[sd] != null) problems.push(`${page}: seed ${sd} in two Fade groups`);
        if (Math.abs(e.fade[sd] - pc) > 0.5) problems.push(`${page}: seed ${sd} is ${e.fade[sd]}% but in ${g.name}`);
        whole[sd] = pc;
      }
    }
    const p = e.fade.map((x) => b32(Math.round(x * 10), 2)).join('');
    if (!fades.has(p)) fades.set(p, { id: fades.size, p, names: [] });
    fades.get(p).names.push(skin.n);
    out[skin.wid][skin.fid] = { set: 'Fade', fade: fades.get(p).id };
    continue;
  }
  const groups = {};
  for (const g of e.groups) {
    const key = g.type + (g.tier != null ? '/' + g.tier : '');
    groups[key] = [...new Set([...(groups[key] || []), ...g.seeds])].sort((a, b) => a - b);
  }
  out[skin.wid][skin.fid] = {
    set: skin.cat === 'gloves' ? e.name.replace(/^★ /, '') : skin.fin,
    groups: Object.fromEntries(Object.entries(groups).map(([k, seeds]) => [k, seeds.map((sd) => b32(sd, 2)).join('')])),
  };
}
if (problems.length) throw new Error('The source doesn\'t fit the game:\n' + problems.join('\n'));

const q = (s) => (/^[a-z_$][\w$]*$/i.test(s) ? s : `'${s}'`);
// The skins that share a Fade, as comment lines of a readable length.
const names = (list) => list.sort().reduce((lines, n) => {
  const last = lines.at(-1);
  if (last && last.length + n.length < 112) lines[lines.length - 1] = `${last}, ${n}`; else lines.push(n);
  return lines;
}, []).map((l) => `  // ${l}`).join('\n');
const skins = Object.keys(out).sort().map((wid) => `  ${wid}: {\n${Object.keys(out[wid]).sort().map((fid) => {
  const e = out[wid][fid];
  if (e.fade != null) return `    ${fid}: { set: 'Fade', fade: ${e.fade} },`;
  return `    ${fid}: { set: '${e.set}', groups: {\n${Object.entries(e.groups).map(([k, v]) => `      ${q(k)}: '${v}',`).join('\n')}\n    } },`;
}).join('\n')}\n  },`);
fs.writeFileSync(OUT, `// Made by scripts/build-rare-patterns.mjs from scripts/data/cs-money-rare-patterns.json: the CS.MONEY Wiki's rare patterns
// (https://wiki.cs.money/rare-patterns), fetched ${src.fetched}. That script says where it all comes from. Don't edit it by hand.
//   RARE_PATTERNS: { [weapon id]: { [paint kit]: { set, groups: { [group]: seeds } } or { set: 'Fade', fade } } }
// set is what patterns.js's RARE table goes by: the finish, or a pair of gloves' whole name. A group is the wiki's type, then a /
// and its tier when it has one ('diamond/1', 'max-purple'). seeds: two base-32 digits a seed, 0-1000 like CS2's Pattern Template.
//   RARE_FADES: { [fade]: { p } }: every seed's real fade percentage (p: two base-32 digits a seed, in tenths), once for all the
// skins that share the pattern.
export const RARE_FADES = {
${[...fades.values()].map((f) => `${names(f.names)}\n  ${f.id}: {\n    p: '${f.p}' },`).join('\n')}
};
export const RARE_PATTERNS = {
${skins.join('\n')}
};
`);
console.log('wrote', OUT, Object.values(out).reduce((n, kits) => n + Object.keys(kits).length, 0), 'skins,', fades.size, 'fade patterns,', (fs.statSync(OUT).size / 1024).toFixed(1), 'KB');
