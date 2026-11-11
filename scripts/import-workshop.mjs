// Imports a Steam Workshop weapon finish as a custom skin (CUSTOM_CONTENT.md, section 10), from its creator's own files.
// Steam never downloads a weapon finish (subscribing only votes), so the files come from the creator, with their written
// permission. The Workshop id gives its title and creator, credited in the game.
//
//   node scripts/import-workshop.mjs <the creator's folder or .zip> --workshop <id or link> --permission <file> [what's yours]
//   node scripts/import-workshop.mjs <Workshop id or link>     looks in your Steam folder, and says what's there (a map), or why
//                                                              nothing is (a finish is never downloaded)
//
// The creator's files: a CS2 addon (its .econitem and .tga textures: content/csgo_addons/<addon>/, or a zip of it), a
// finish's .vcompmat (or compiled .vcompmat_c with .vtex_c textures), or a CS:GO-era upload (myweaponfinishes/<name>.zip:
// workbench .txt, .tga, .vtf).
//
// What the Workshop doesn't carry is yours:
//   --rarity <Mil-Spec...>            guns (knives are ★ Covert)
//   --prices FN=42.5,MW=24,...        or 42.5,24,... in wear order; --prices-stattrak the same
//   --float 0,0.7                     when the creator's file has no wear range (a CS2 finish's own wear range is used)
//   --stattrak / --no-stattrak        StatTrak™ drops (default: yes)
// And optionally:
//   --name "AK-47 | Nebula"           its name (default: its Workshop title, else its file's name)
//   --weapon <AK-47 | weapon_ak47>    when the files and title don't say (a knife finish is posted under a gun's tag)
//   --creator-name <name>             the creator's name (default: their Steam profile's)
//   --icon <png>                      its picture (else: node scripts/bake-custom-icons.mjs --src <the pack folder>)
//   --style <style> --colors <#a,#b>  for a CS:GO workbench file this can't read (or to override, with --allow-loss)
//   --model hd|legacy                 the model a UV-painted finish is on (CS2-era: hd, CS:GO-era: legacy)
//   --flip-normal / --no-flip-normal  its normal map's green channel (CS:GO-era: flipped)
//   --item <name>                     which finish, when the files hold several
//   --allow-loss                      import a finish that uses extended features custom skins don't have yet, without them
//   --keep-size                       keep textures over 2048 (the build ships them at 2048 anyway)
//   --out <pack folder>               where it goes (default custom-staging/, which isn't in git and isn't built)
//   --live                            into custom/ itself (needs --permission), to build with npm run custom
//   --force                           replace a folder of the same name
//   --details <file.json>             Steam's metadata saved before (GetPublishedFileDetails), instead of asking Steam
//   --offline                         never contact Steam (then --creator-name is needed)
//   --steam <Steam folder>            where to look for subscribed items (default: this PC's Steam libraries)
// Only public metadata is ever read from Steam (the item's details and the creator's profile name), never a file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importFinish, workshopId, STAGING } from './custom/workshop.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flags = new Set(['--stattrak', '--no-stattrak', '--flip-normal', '--no-flip-normal', '--allow-loss', '--keep-size', '--live', '--force', '--offline']);
const o = {}, rest = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (flags.has(a)) { o[a] = true; continue; }
  if (a.startsWith('--')) { o[a] = args[++i]; continue; }
  rest.push(a);
}
if (!rest.length && !o['--files'] && !o['--workshop']) {
  console.log('Usage: node scripts/import-workshop.mjs <the creator\'s folder or .zip | a Workshop id or link> [--workshop <id>] [--permission <file>] [--rarity ...] [--prices ...]\nThe options are at the top of scripts/import-workshop.mjs; CUSTOM_CONTENT.md section 10 says how it works.');
  process.exit(1);
}
const pos = rest.join(' ').trim();
const asId = pos && workshopId(pos);
const pair = (s) => (s == null ? undefined : String(s).split(/[\s,:]+/).filter(Boolean).map(Number));
function prices(s) {
  if (s == null) return undefined;
  const t = String(s).trim();
  if (t.startsWith('{')) return JSON.parse(t);
  const parts = t.split(/[\s,;]+/).filter(Boolean);
  if (parts.every((p) => p.includes('='))) return Object.fromEntries(parts.map((p) => { const [k, v] = p.split('='); return [k.trim().toUpperCase(), Number(v)]; }));
  return parts.map(Number);
}

let r;
try {
  r = await importFinish({
    files: o['--files'] || (asId ? null : pos || null),
    workshop: o['--workshop'] || (asId ? pos : null),
    details: o['--details'] ? path.resolve(o['--details']) : null,
    offline: !!o['--offline'], creatorName: o['--creator-name'], name: o['--name'], weapon: o['--weapon'], rarity: o['--rarity'],
    float: pair(o['--float']), prices: prices(o['--prices']), pricesStatTrak: prices(o['--prices-stattrak']),
    stattrak: o['--stattrak'] ? true : o['--no-stattrak'] ? false : undefined,
    style: o['--style'], colors: o['--colors'], model: o['--model'],
    flipNormal: o['--flip-normal'] ? true : o['--no-flip-normal'] ? false : undefined,
    icon: o['--icon'], permission: o['--permission'], out: o['--out'] ? path.resolve(o['--out']) : undefined, live: !!o['--live'],
    force: !!o['--force'], allowLoss: !!o['--allow-loss'], keepSize: !!o['--keep-size'], item: o['--item'], steam: o['--steam'],
  });
} catch (e) {
  console.log('ERROR    ' + (e?.message || e));
  process.exit(1);
}
for (const n of r.notes) console.log('note     ' + n);
if (!r.ok) {
  for (const e of r.errors) console.log('ERROR    ' + e);
  process.exit(1);
}
const rel = (p) => path.relative(ROOT, p) || p;
const ws = r.skin.workshop;
console.log(`\nImported ${r.skin.name}${ws ? ` (Steam Workshop ${ws.id}, by ${ws.creatorName})` : ` (by ${r.skin.credit})`} into ${rel(r.folder)}`);
console.log(`  ${r.skin.finish.style} (CS2's ${r.template} template), float ${r.skin.float[0]} to ${r.skin.float[1]}. Textures: ${r.textures.join(', ') || 'none'}.`);
console.log(`  Its id will be ${r.id}.`);
const pack = path.dirname(path.dirname(r.folder));
const live = pack === path.join(ROOT, 'custom');
console.log('\nNext:');
let n = 1;
if (ws && !r.permission) console.log(`  ${n++}. Get ${ws.creatorName}'s written permission to ship it to every player, and import again with --permission <file>. Until then the game's build refuses it.`);
if (!fs.existsSync(path.join(r.folder, 'icon.png'))) console.log(`  ${n++}. Its picture: node scripts/bake-custom-icons.mjs --src ${rel(pack)}`);
if (!live) {
  console.log(`  ${n++}. Try it: node scripts/build-custom.mjs --src "${rel(pack)}" --try (it prints how to run the game with it).`);
  console.log(`  ${n++}. Move ${rel(r.folder)} into custom/skins/, put it in a case, and build: npm run custom (CUSTOM_CONTENT.md, section 8).`);
} else console.log(`  ${n++}. Put it in a case and build: npm run custom (CUSTOM_CONTENT.md, section 8).`);
if (pack === STAGING) console.log('  (custom-staging/ isn\'t in git and isn\'t built: nothing reaches players from there.)');
