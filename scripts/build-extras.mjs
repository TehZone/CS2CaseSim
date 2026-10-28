// Builds the data that sits beside game-data.json (so building it doesn't replace the prices a player refreshed):
//   src/data/keys.json    CS2's case keys: which key opens which case, with its picture
//   src/data/medals.json  the Service Medals' pictures, by year and colour (the profile's prestige badges)
// From the ByMykel CS2 item database (cached in cache/raw like build-data.mjs).
//   node scripts/build-extras.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'cache', 'raw');
const DB = 'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/';
const STEAM_IMG = 'https://community.akamai.steamstatic.com/economy/image/';
const img = (u) => (!u ? '' : u.startsWith(STEAM_IMG) ? '~' + u.slice(STEAM_IMG.length) : u);

async function cached(name, url) {
  const file = path.join(RAW, name);
  if (!fs.existsSync(file)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    fs.mkdirSync(RAW, { recursive: true });
    fs.writeFileSync(file, await res.text());
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'data', 'game-data.json'), 'utf8'));
const caseByName = new Map(data.cases.map((c) => [c.n, c]));

// Keys: { keyId: { n, img, cases: [caseId] } }, for the cases in game-data that take a key.
const keysRaw = await cached('keys.json', DB + 'keys.json');
const keys = {};
for (const k of keysRaw) {
  const cases = (k.crates || []).map((c) => caseByName.get(c.name)).filter((c) => c?.key).map((c) => c.id);
  if (cases.length) keys[k.id] = { n: k.name, img: img(k.image), cases };
}
const keyed = data.cases.filter((c) => c.key), opened = new Set(Object.values(keys).flatMap((k) => k.cases));
const missing = keyed.filter((c) => !opened.has(c.id));
fs.writeFileSync(path.join(ROOT, 'src', 'data', 'keys.json'), JSON.stringify(keys));
console.log(`keys: ${Object.keys(keys).length} open ${opened.size} of ${keyed.length} cases that need one${missing.length ? ' (none for: ' + missing.map((c) => c.n).join(', ') + ')' : ''}`);

// Service Medals: { 'year-colour': img }, colours in the order CS2 numbers them (its item ids).
const collectibles = await cached('collectibles.json', DB + 'collectibles.json');
const medals = {};
const byYear = {};
for (const c of collectibles) {
  const y = /^(\d{4}) Service Medal$/.exec(c.name)?.[1];
  if (y) (byYear[y] ||= []).push(c);
}
for (const [y, list] of Object.entries(byYear)) {
  list.sort((a, b) => Number(a.def_index) - Number(b.def_index)).forEach((c, i) => { medals[`${y}-${i + 1}`] = img(c.image); });
}
fs.writeFileSync(path.join(ROOT, 'src', 'data', 'medals.json'), JSON.stringify(medals));
console.log(`medals: ${Object.keys(medals).length} (${Object.entries(byYear).map(([y, l]) => `${y}: ${l.length}`).join(', ')})`);
