// Builds src/data/badges.json: CS2's collectibles as badges (src/js/engine/badgedata.js), and the four Collectible Pins
// Capsules that hold the only ones a player can get. Everything comes from the cached item database and price lists in
// cache/raw (scripts/build-data.mjs downloads them): collectibles.json, crates.json and prices_*.json. Nothing is downloaded.
//   node scripts/build-badges.mjs --app 1.1.6     (the version these badges ship in: see below)
//   node scripts/build-badges.mjs --check         (says what it would write, and the lock, and writes nothing)
//
// The badges are part of the data lock (D.lock gets `+bd.<hash>`), so new or changed badges lock out every game without them.
// That's why the file says the version it ships in (`app`): the live server keeps running the badges the published release
// has (server/index.mjs badgeGate) until a release at least that new is out. A build whose lock is the file's own (new prices,
// pictures or descriptions) keeps the file's version and needs no --app; one that changes the lock needs it. The release built
// from this must be that version or newer (package.json "version"), or its games and the server won't agree. A version that's
// out (its git tag, or scripts/data/changelog-versions.json has it or a later one) is refused: --not-out for one that was only
// built for release, never published.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { badgeLock, BD_FORMAT } from '../src/js/engine/badgedata.js';

const require = createRequire(import.meta.url);
const pricing = require('../shared/pricing.cjs');
const { parseVersion, compareVersions } = require('../shared/release.cjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'cache', 'raw');
const OUT = path.join(ROOT, 'src', 'data', 'badges.json');
const STEAM_IMG = 'https://community.akamai.steamstatic.com/economy/image/';
const img = (u) => (!u ? '' : u.startsWith(STEAM_IMG) ? '~' + u.slice(STEAM_IMG.length) : u);

// CS2's rarities as the game ranks a badge (items.js rarityRank; data.js RARITY.badge): Base Grade is 0 (grey), the rest go
// as a sticker's do.
const RANK = { rarity_common: 0, rarity_rare: 2, rarity_mythical: 3, rarity_legendary: 4, rarity_ancient: 5 };
// A pin with no price on any market (none today): about what its rarity sells for.
const PIN_FALLBACK = { 2: 2.5, 3: 3, 4: 5, 5: 20 };
const CAPSULE_FALLBACK = 5.95;
// Premier Season Medals come in seven colours, one for each CS Rating tier, and five levels each.
const PREMIER_COLOURS = ['Grey', 'Light Blue', 'Blue', 'Purple', 'Pink', 'Red', 'Gold'];

// What kind of collectible it is, for the pages: the item database's own type, and a name for the five it has none for.
function typeOf(x) {
  if (x.type) return x.type;
  return /Badge$/.test(x.name) ? 'Badge' : 'Veteran Coin';
}
// What tells apart the collectibles CS2 gives one name: a Service Medal's level, a Premier Medal's colour and level, a CS2
// map's coin from its CS:GO one.
function variantOf(x) {
  const icon = String(x.original?.image_inventory || ''), name = String(x.original?.item_name || '');
  // (service_medal_2016_lvl3; the 2015 ones are service_medal_2015 and service_medal_2015_2)
  if (x.type === 'Service Medal') { const m = /_(?:lvl)?(\d)$/.exec(icon); return `Level ${m ? m[1] : 1}`; }
  if (x.type === 'Premier Season Coin') { const m = /_coin_(\d)(\d)$/.exec(icon); return m && PREMIER_COLOURS[+m[1] - 1] ? `${PREMIER_COLOURS[+m[1] - 1]}, level ${m[2]}` : ''; }
  if (x.type === 'Map Contributor Coin' && /CS2$/.test(name)) return 'CS2';
  return '';
}

export function buildBadges({ raw = RAW } = {}) {
  const readRaw = (f) => JSON.parse(fs.readFileSync(path.join(raw, f), 'utf8'));
  const collectibles = readRaw('collectibles.json'), crates = readRaw('crates.json');
  const prices = {};
  for (const name of Object.keys(pricing.SOURCES)) { try { prices[name] = readRaw(`prices_${name}.json`); } catch { prices[name] = null; } }
  const idx = pricing.buildIndex(prices);
  const problems = [];

  // The capsules first: their pins are the ones that trade.
  const capsules = crates.filter((c) => c.type === 'Pins').sort((a, b) => Number(a.def_index) - Number(b.def_index));
  const boxOf = new Map();
  const cases = capsules.map((c) => {
    const pools = {};
    for (const x of c.contains || []) {
      const r = RANK[x.rarity?.id];
      if (r == null || r < 2) { problems.push(`${c.name}: ${x.name} has a rarity a capsule can't drop (${x.rarity?.name})`); continue; }
      (pools[r] ||= []).push(x.id);
      boxOf.set(x.id, c.id);
    }
    for (const k of Object.keys(pools)) pools[k].sort();
    const price = pricing.priceOf(idx, c.market_hash_name || c.name, null);
    if (price == null) problems.push(`${c.name}: no market price (using ${CAPSULE_FALLBACK})`);
    return { id: c.id, n: c.name, img: img(c.image), kind: 'pins', key: false, date: c.first_sale_date || '', price: price ?? CAPSULE_FALLBACK, pools };
  });

  const badges = {};
  for (const x of [...collectibles].sort((a, b) => Number(a.def_index) - Number(b.def_index))) {
    const r = RANK[x.rarity?.id];
    if (r == null) { problems.push(`${x.name}: unknown rarity ${x.rarity?.id}`); continue; }
    const box = boxOf.get(x.id), v = variantOf(x);
    let p = 0;
    if (box) {
      const mp = pricing.priceOf(idx, x.market_hash_name || x.name, null);
      if (mp == null) problems.push(`${x.name}: no market price (using ${PIN_FALLBACK[r]})`);
      p = mp ?? PIN_FALLBACK[r] ?? 2.5;
    }
    badges[x.id] = {
      id: x.id, n: x.name, ty: typeOf(x), ...(v ? { v } : {}), r, rc: x.rarity.color || '', img: img(x.image),
      ...(x.description ? { desc: String(x.description).trim() } : {}), p, ...(box ? { tr: 1, box } : {}),
    };
  }
  for (const c of cases) for (const ids of Object.values(c.pools)) for (const id of ids) if (!badges[id]) problems.push(`${c.n}: ${id} isn't a collectible`);
  // Names as the game shows them (with their variant) should tell every badge apart.
  const seen = new Map();
  for (const b of Object.values(badges)) {
    const k = b.n + (b.v ? ` (${b.v})` : '');
    if (seen.has(k)) problems.push(`two badges are called ${k} (${seen.get(k)} and ${b.id})`);
    seen.set(k, b.id);
  }
  return { badges, cases, problems };
}

// Whether a version of the game may be out already, and why: its release's tag (vX.Y.Z) is in the repository, or a release
// build was made for it or a later one (scripts/data/changelog-versions.json, which `npm run dist` writes and is committed
// with each release: this checkout may not have every tag). '' when neither.
function outAlready(version) {
  try { if (execFileSync('git', ['tag', '-l', 'v' + version], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) return `its git tag v${version} exists`; } catch {}
  try {
    const built = Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'data', 'changelog-versions.json'), 'utf8')));
    const newest = built.filter(parseVersion).sort(compareVersions).at(-1);
    if (newest && compareVersions(version, newest) <= 0) return `version ${newest} was built for release already (scripts/data/changelog-versions.json)`;
  } catch {}
  return '';
}

function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  const appArg = argv.includes('--app') ? argv[argv.indexOf('--app') + 1] : null;
  if (appArg != null && !parseVersion(appArg)) { console.error(`--app ${appArg}: not a version (1.2.3)`); process.exit(1); }
  // (--not-out: the version was built for release, but isn't published yet. Never for one players have.)
  const notOut = argv.includes('--not-out');
  const { badges, cases, problems } = buildBadges();
  for (const p of problems) console.warn('warning:', p);
  const prev = (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { return null; } })();
  const body = { format: BD_FORMAT, badges, cases };
  const lock = badgeLock(body), same = prev && badgeLock(prev) === lock;
  const app = appArg || (same ? prev.app : null);
  const pins = Object.values(badges).filter((b) => b.tr).length;
  console.log(`${Object.keys(badges).length} badges (${pins} pins from ${cases.length} capsules), lock +bd.${lock}${same ? ' (unchanged)' : prev ? ' (changed)' : ''}`);
  if (!app) { console.error('The lock changes: say which release these badges ship in with --app <version> (one that isn\'t out yet).'); process.exit(1); }
  // Badges stamped with a version that's out would run at once on the live server (its required version is at least that)
  // wherever it doesn't run them yet, and lock out every game of that version: refused, as build-custom does. (Kept as the file
  // has it, a version was checked when it was given.)
  const out = appArg || !same ? outAlready(app) : '';
  if (out && !(notOut && !/git tag/.test(out))) {
    console.error(`--app ${app}: ${out}, and badges are part of the data lock. Give the version they ship in, one that isn't out yet${/git tag/.test(out) ? '' : ' (or add --not-out if that version was only built, not published)'}.`);
    process.exit(1);
  }
  const pkg = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return null; } })();
  if (pkg && parseVersion(pkg) && compareVersions(pkg, app) < 0) console.log(`note: package.json says ${pkg}: the release that ships these badges must be ${app} or newer (set "version" before npm run dist).`);
  if (check) { console.log(`would write ${path.relative(ROOT, OUT)} for version ${app}`); return; }
  fs.writeFileSync(OUT, JSON.stringify({ format: BD_FORMAT, app, ...body }) + '\n');
  console.log(`wrote ${path.relative(ROOT, OUT)} for version ${app}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
