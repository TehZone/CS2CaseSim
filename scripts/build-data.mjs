// Builds src/data/game-data.json from the ByMykel CS2 item database and live marketplace prices.
//   node scripts/build-data.mjs            (uses cached downloads when present)
//   node scripts/build-data.mjs --refresh  (re-downloads everything)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pricing = require('../shared/pricing.cjs');
const { parseKV1 } = require('../cs2/kv.cjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'cache', 'raw');
const OUT = path.join(ROOT, 'src', 'data', 'game-data.json');
const REFRESH = process.argv.includes('--refresh');
const STEAM_IMG = 'https://community.akamai.steamstatic.com/economy/image/';
const DB = 'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/';
const ITEMS_GAME = 'https://raw.githubusercontent.com/SteamDatabase/GameTracking-CS2/master/game/csgo/pak01_dir/scripts/items/items_game.txt';
const PROS = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'pros.json'), 'utf8'));

fs.mkdirSync(RAW, { recursive: true });
fs.mkdirSync(path.dirname(OUT), { recursive: true });

async function cachedText(file, url, opts) {
  const f = path.join(RAW, file);
  if (!REFRESH && fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  console.log('download', url);
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const text = await res.text();
  fs.writeFileSync(f, text);
  return text;
}
const cached = async (file, url, opts) => JSON.parse(await cachedText(file, url, opts));

const crates = await cached('crates.json', DB + 'crates.json');
const skinsRaw = await cached('skins_not_grouped.json', DB + 'skins_not_grouped.json');
const skinsGrouped = await cached('skins.json', DB + 'skins.json');
const stickersRaw = await cached('stickers.json', DB + 'stickers.json');
const agentsRaw = await cached('agents.json', DB + 'agents.json');
const collectionsRaw = await cached('collections.json', DB + 'collections.json');
const itemsGame = parseKV1(await cachedText('items_game.txt', ITEMS_GAME)).items_game;

const priceRaw = {};
for (const [name, url] of Object.entries(pricing.SOURCES)) {
  try {
    priceRaw[name] = await cached(`prices_${name}.json`, url, { headers: { 'Accept-Encoding': 'br, gzip' } });
  } catch (e) {
    console.warn(`price source ${name} failed: ${e.message}`);
  }
}
const idx = pricing.buildIndex(priceRaw);

const img = (u) => (!u ? '' : u.startsWith(STEAM_IMG) ? '~' + u.slice(STEAM_IMG.length) : u);

const WEAPON_RARITY = {
  rarity_common_weapon: 0, rarity_uncommon_weapon: 1, rarity_rare_weapon: 2,
  rarity_mythical_weapon: 3, rarity_legendary_weapon: 4, rarity_ancient_weapon: 5, rarity_ancient: 5,
  rarity_contraband_weapon: 7, rarity_contraband: 7,
};
const ITEM_RARITY = { rarity_default: 0, rarity_common: 1, rarity_rare: 2, rarity_mythical: 3, rarity_legendary: 4, rarity_ancient: 5, rarity_contraband: 7 };
const AGENT_RARITY = { rarity_rare_character: 2, rarity_mythical_character: 3, rarity_legendary_character: 4, rarity_ancient_character: 5 };
const CATEGORY = {
  sfui_invpanel_filter_gloves: 'gloves', sfui_invpanel_filter_melee: 'knife',
  csgo_inventory_weapon_category_rifles: 'rifle', csgo_inventory_weapon_category_smgs: 'smg',
  csgo_inventory_weapon_category_pistols: 'pistol', csgo_inventory_weapon_category_heavy: 'heavy',
  loadoutslot_equipment: 'equipment',
};

// Finish style (paint type) per skin id, used by the 3D inspect to choose a material.
const styleBySkin = {};
for (const s of skinsRaw) if (s.skin_id && s.style?.name && !styleBySkin[s.skin_id]) styleBySkin[s.skin_id] = s.style.name;
const skinById = Object.fromEntries(skinsGrouped.map((s) => [s.id, s]));

const skins = {};
function addSkin(id) {
  if (skins[id]) return skins[id];
  const s = skinById[id];
  if (!s) return null;
  const vanilla = !s.name.includes('|');
  const rec = {
    id,
    n: s.name,
    w: s.weapon?.name || s.name.replace('★ ', ''),
    wid: s.weapon?.id || '',
    cat: CATEGORY[s.category?.id] || 'other',
    fin: vanilla ? 'Vanilla' : s.pattern?.name || '',
    fid: s.pattern?.id || '',
    st: styleBySkin[id] || (vanilla ? 'Vanilla' : ''),
    r: WEAPON_RARITY[s.rarity?.id] ?? 2,
    rc: s.rarity?.color || '#4b69ff',
    rn: s.rarity?.name || '',
    mn: vanilla ? 0 : s.min_float ?? 0,
    mx: vanilla ? 1 : s.max_float ?? 1,
    stt: !!s.stattrak,
    star: s.name.startsWith('★'),
    img: img(s.image),
  };
  if (s.collections?.[0]) rec.col = s.collections[0].id;
  if (s.souvenir) rec.svp = 1;
  if (vanilla) rec.v = 1;
  if (s.phase) rec.ph = s.phase;
  skins[id] = rec;
  return rec;
}

// Tournament id -> name ("2014 ESL One Cologne"), from the sticker database.
const TOURN = {};
for (const s of stickersRaw) if (s.tournament) TOURN[s.tournament.id] = s.tournament.name;
// "ESL One Cologne 2014 Cobblestone Souvenir Package" -> 4. Matches the year plus a city/organiser word.
function eventForPackage(name) {
  const year = name.match(/20\d\d/)?.[0];
  const lower = name.toLowerCase();
  const cands = Object.entries(TOURN).filter(([, n]) => year && n.includes(year));
  for (const [id, n] of cands) {
    const words = n.toLowerCase().replace(/20\d\d/, '').split(/[\s.]+/).filter((w) => w.length > 2 && !['one', 'esl', 'the'].includes(w));
    if (words.some((w) => lower.includes(w))) return +id;
  }
  return cands.length === 1 ? +cands[0][0] : null;
}

// Group rare items by name so each knife/glove finish is equally likely and Doppler phases split one slot.
function rareGroups(list) {
  const groups = new Map();
  for (const it of list || []) {
    const s = addSkin(it.id);
    if (!s) continue;
    if (!groups.has(s.n)) groups.set(s.n, []);
    groups.get(s.n).push(s.id);
  }
  return [...groups.values()];
}
const rareKindOf = (rare) =>
  rare.some((g) => skins[g[0]].cat === 'gloves') ? (rare.some((g) => skins[g[0]].cat === 'knife') ? 'mixed' : 'gloves') : 'knife';
function skinPools(list) {
  const pools = {}, cols = {};
  for (const it of list) {
    const s = addSkin(it.id);
    if (!s || s.r === 7) continue; // contraband no longer drops
    (pools[s.r] ||= []).push(s.id);
    if (s.col) cols[s.col] = (cols[s.col] || 0) + 1;
  }
  const col = Object.entries(cols).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  return { pools, col };
}

// Non-souvenir packages that hold weapon skins (gift packages and storage units are skipped).
const PACKAGES = new Set(['X-Ray P250 Package', 'Anubis Collection Package', 'Sealed Genesis Terminal', 'Sealed Dead Hand Terminal']);
const STICKER_TYPES = new Set(['Sticker Capsule', 'Autograph Capsule']);
const cases = [];
const stickerIdsInCapsules = new Set();
for (const c of crates) {
  if (c.type === 'Case') {
    const { pools, col } = skinPools(c.contains);
    const rare = rareGroups(c.contains_rare);
    cases.push({
      id: c.id, n: c.name, img: img(c.image), kind: 'case', key: true,
      date: c.first_sale_date || '', price: null, pools, rare, rareKind: rareKindOf(rare), col,
    });
  } else if (c.type === 'Souvenir' || PACKAGES.has(c.name)) {
    const { pools, col } = skinPools(c.contains);
    if (!Object.keys(pools).length) continue;
    const rec = {
      id: c.id, n: c.name, img: img(c.image), kind: c.type === 'Souvenir' ? 'souvenir' : 'package', key: c.name.includes('Terminal'),
      date: c.first_sale_date || '', price: null, pools, col,
    };
    const rare = rareGroups(c.contains_rare);
    if (rare.length) Object.assign(rec, { rare, rareKind: rareKindOf(rare) });
    if (rec.kind === 'souvenir') rec.ev = eventForPackage(c.name);
    cases.push(rec);
  } else if (STICKER_TYPES.has(c.type)) {
    const pools = {};
    for (const it of c.contains) {
      const r = ITEM_RARITY[it.rarity?.id] ?? 2;
      (pools[r] ||= []).push(it.id);
      stickerIdsInCapsules.add(it.id);
    }
    if (!Object.keys(pools).length) continue;
    cases.push({
      id: c.id, n: c.name, img: img(c.image), kind: c.type === 'Autograph Capsule' ? 'autograph' : 'capsule',
      key: false, date: c.first_sale_date || '', price: null, pools,
    });
  }
}

// The sticker kit's CS2 material (stickers/<sm>.vmat in the game files), used by the real-model renderer.
const stickerMaterial = (s) => itemsGame.sticker_kits?.[s.def_index]?.sticker_material || '';
const stickers = {};
for (const s of stickersRaw) {
  if (!s.market_hash_name) continue;
  stickers[s.id] = {
    id: s.id,
    n: s.market_hash_name,
    r: ITEM_RARITY[s.rarity?.id] ?? 2,
    rc: s.rarity?.color || '#4b69ff',
    fx: s.effect && s.effect !== 'Other' ? s.effect : '',
    t: s.tournament?.name || '',
    ty: s.type || '',
    img: img(s.image),
    sm: stickerMaterial(s),
    p: null,
  };
}

const agents = {};
for (const a of agentsRaw) {
  agents[a.id] = {
    id: a.id, n: a.market_hash_name || a.name, r: AGENT_RARITY[a.rarity?.id] ?? 2, rc: a.rarity?.color || '#4b69ff',
    rn: a.rarity?.name || '', team: a.team?.id === 'terrorists' ? 'T' : 'CT', img: img(a.image), p: null,
  };
}

// ---- collections ---------------------------------------------------------------------------
const crateById = Object.fromEntries(crates.map((c) => [c.id, c]));
const collections = [];
for (const c of collectionsRaw) {
  const tiers = {};
  for (const it of c.contains || []) {
    const s = addSkin(it.id);
    if (!s || s.r === 7 || s.star) continue;
    (tiers[s.r] ||= []).push(s.id);
  }
  if (!Object.keys(tiers).length) continue; // agent collections
  const crateIds = (c.crates || []).map((x) => x.id);
  collections.push({
    id: c.id, n: c.name, img: img(c.image), rel: c.release_date || '', tiers,
    packages: crateIds.filter((id) => crateById[id]?.type === 'Souvenir'),
    caseId: crateIds.find((id) => crateById[id]?.type === 'Case') || null,
  });
}

// ---- Majors: events, teams, souvenir stickers ------------------------------------------------
const PE = itemsGame.pro_event_results || {}, PP = itemsGame.pro_players || {}, PT = itemsGame.pro_teams || {};
const stickerKey = new Map(); // "type|team|player|event|effect" -> sticker
for (const s of stickersRaw) {
  if (!s.tournament) continue;
  stickerKey.set([s.type, s.team?.id ?? '', s.player?.id ?? '', s.tournament.id, s.effect || 'Other'].join('|'), s);
}
const findStk = (type, team, player, ev, ...effects) => {
  for (const fx of effects) { const s = stickerKey.get([type, team ?? '', player ?? '', ev, fx].join('|')); if (s) return s; }
  return null;
};
const teamNames = {};
for (const s of stickersRaw) if (s.team) teamNames[s.team.id] = s.team.name;
const proTeams = {};
for (const [id, t] of Object.entries(PT)) proTeams[+id] = { n: teamNames[+id] || t.tag, tag: t.tag, geo: t.geo || '' };

const keepStickers = new Set();
const keep = (s) => { if (s) keepStickers.add(s.id); return s?.id || null; };
const events = {};
const placeOf = {}; // ev -> teamId -> finishing position (1, 2, 3, 5, 9...)
for (const [ev, e] of Object.entries(PE)) {
  const pos = {};
  for (const [t, code] of Object.entries(e.team_places || {})) pos[+t] = +((e.place_names?.[code] || '').match(/\d+/)?.[0] || 16);
  placeOf[ev] = pos;
  const rec = { n: TOURN[ev] || 'Major ' + ev, teams: pos, logo: keep(findStk('Event', null, null, +ev, 'Gold', 'Other')), ts: {}, mvp: {} };
  for (const t of Object.keys(pos)) {
    const ts = findStk('Team', +t, null, +ev, 'Gold', 'Other');
    if (ts) rec.ts[t] = keep(ts);
  }
  events[ev] = rec;
}
// Gold autographs (souvenir MVP stickers) per event and team.
for (const s of stickersRaw) {
  if (s.type !== 'Autograph' || s.effect !== 'Gold' || !s.tournament || !s.team) continue;
  const e = events[s.tournament.id];
  if (!e) continue;
  (e.mvp[s.team.id] ||= []).push(keep(s));
}

// Souvenir-only stickers (gold team/event stickers, MVP autographs) are not sold on the market, so they are
// missing from the list above; add them so souvenir items can show them.
for (const s of stickersRaw) {
  if (!keepStickers.has(s.id) || stickers[s.id]) continue;
  stickers[s.id] = {
    id: s.id, n: s.market_hash_name || s.name, r: ITEM_RARITY[s.rarity?.id] ?? 2, rc: s.rarity?.color || '#4b69ff',
    fx: s.effect && s.effect !== 'Other' ? s.effect : '', t: s.tournament?.name || '', ty: s.type || '', img: img(s.image), sm: stickerMaterial(s), p: null, so: 1,
  };
}

// ---- pro player cards (team manager) --------------------------------------------------------
const fnv = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const lc = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [k.toLowerCase(), v]));
const STARS = lc(PROS.stars), ROLES = lc(PROS.roles);
const PLACE_SCORE = [[1, 80], [2, 78], [3, 76], [5, 74], [9, 72], [12, 71], [13, 70], [15, 69], [17, 68], [20, 67], [23, 66], [25, 65], [99, 64]];
const placeScore = (pos) => (PLACE_SCORE.find(([p]) => pos <= p) || [0, 64])[1];
const ROLE_PROFILE = { AWP: [3, -4, 2, 1], IGL: [-5, 6, 2, 0], Entry: [4, -2, -2, -1], Support: [-2, 6, 0, -1], Lurk: [0, -1, 4, 3], RIF: [2, 0, 0, 0] };
const OPEN_ROLES = ['Entry', 'Support', 'Lurk', 'RIF', 'RIF'];
const clampN = (v, a, b) => Math.max(a, Math.min(b, Math.round(v)));
const autograph = (pid, ev) => findStk('Autograph', null, +pid, +ev, 'Other') || findStk('Autograph', null, +pid, +ev, 'Foil', 'Holo', 'Glitter', 'Gold');

const career = {};
for (const [pid, p] of Object.entries(PP)) {
  const evs = Object.entries(p.events || {});
  career[pid] = { majors: evs.length, wins: evs.filter(([ev, x]) => placeOf[ev]?.[+x.team] === 1).length };
}
const pros = {};
const rosters = {}; // "ev|team" -> card ids
for (const [pid, p] of Object.entries(PP)) {
  for (const [ev, x] of Object.entries(p.events || {})) {
    if (!events[ev]) continue;
    const team = +x.team;
    const year = +((TOURN[ev] || '').match(/20\d\d/)?.[0] || 2014);
    const h = fnv(pid + ':' + ev);
    const star = STARS[p.name.toLowerCase()];
    const starBonus = star ? (year >= star[1] && year <= star[2] ? star[0] : star[0] / 2) : 0;
    const c = career[pid];
    const ovr = clampN(placeScore(placeOf[ev]?.[team] ?? 16) + Math.min(2, c.majors * 0.2) + Math.min(2, c.wins) + starBonus + ((h % 5) - 2), 60, 99);
    const auto = autograph(pid, ev);
    const tstk = findStk('Team', team, null, +ev, 'Other');
    const id = `pro-${pid}-${ev}`;
    pros[id] = {
      id, pid: +pid, n: p.name, geo: p.geo || '', tm: team, ev: +ev, y: year, ovr,
      role: ROLES[p.name.toLowerCase()] || '', img: img(auto?.image || tstk?.image || ''),
    };
    (rosters[ev + '|' + team] ||= []).push(id);
  }
}
// Every roster gets an AWPer and an in-game leader; everyone else without a known role gets a rifle role.
for (const ids of Object.values(rosters)) {
  const cards = ids.map((id) => pros[id]).sort((a, b) => fnv(String(a.pid)) - fnv(String(b.pid)));
  for (const need of ['AWP', 'IGL']) {
    if (!cards.some((c) => c.role === need)) { const c = cards.find((x) => !x.role); if (c) c.role = need; }
  }
  for (const c of cards) if (!c.role) c.role = OPEN_ROLES[fnv(c.pid + 'role') % OPEN_ROLES.length];
}
for (const c of Object.values(pros)) {
  const prof = ROLE_PROFILE[c.role];
  c.a = prof.map((d, i) => clampN(c.ovr + d + ((fnv(c.id + i) % 7) - 3), 40, 99));
}

const data = {
  version: 2, keyPrice: pricing.KEY_PRICE, cases, skins, stickers, agents, collections, events, proTeams, pros,
};
const counts = pricing.applyPrices(data, idx);

// Drop stickers nobody sells (no price) unless they are in a capsule; drop capsules without a price.
for (const [id, s] of Object.entries(stickers)) {
  if (s.p == null && !stickerIdsInCapsules.has(id) && !keepStickers.has(id)) delete stickers[id];
  else if (s.p == null) s.p = [0.03, 0.03, 0.05, 0.3, 1.5, 4, 0, 50][s.r] || 0.05;
}
for (const a of Object.values(agents)) if (a.p == null) a.p = [0, 0, 1.5, 3, 7, 15][a.r] || 2;
data.cases = cases.filter((c) => {
  if (c.price == null) return false;
  if (c.kind === 'capsule' || c.kind === 'autograph') {
    for (const k of Object.keys(c.pools)) {
      c.pools[k] = c.pools[k].filter((id) => stickers[id]);
      if (!c.pools[k].length) delete c.pools[k];
    }
    return Object.keys(c.pools).length > 0;
  }
  return true;
});

data.generatedAt = new Date().toISOString();
fs.writeFileSync(OUT, JSON.stringify(data));
const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
const nKind = (...k) => data.cases.filter((c) => k.includes(c.kind)).length;
console.log(`cases: ${nKind('case')}, souvenir packages: ${nKind('souvenir')}, packages: ${nKind('package')}, capsules: ${nKind('capsule', 'autograph')}`);
console.log(`collections: ${collections.length}, events: ${Object.keys(events).length}, pro cards: ${Object.keys(pros).length}`);
console.log(`skins: ${Object.keys(skins).length}, stickers: ${Object.keys(stickers).length}, agents: ${Object.keys(agents).length}`);
console.log('priced:', counts);
console.log(`wrote ${OUT} (${kb} KB)`);
