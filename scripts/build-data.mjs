// Builds src/data/game-data.json from the ByMykel CS2 item database and live marketplace prices.
//   node scripts/build-data.mjs            (uses cached downloads when present)
//   node scripts/build-data.mjs --refresh  (re-downloads everything)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pricing = require('../shared/pricing.cjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'cache', 'raw');
const OUT = path.join(ROOT, 'src', 'data', 'game-data.json');
const REFRESH = process.argv.includes('--refresh');
const STEAM_IMG = 'https://community.akamai.steamstatic.com/economy/image/';
const DB = 'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/';

fs.mkdirSync(RAW, { recursive: true });
fs.mkdirSync(path.dirname(OUT), { recursive: true });

async function cached(file, url, opts) {
  const f = path.join(RAW, file);
  if (!REFRESH && fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  console.log('download', url);
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const text = await res.text();
  fs.writeFileSync(f, text);
  return JSON.parse(text);
}

const crates = await cached('crates.json', DB + 'crates.json');
const skinsRaw = await cached('skins_not_grouped.json', DB + 'skins_not_grouped.json');
const skinsGrouped = await cached('skins.json', DB + 'skins.json');
const stickersRaw = await cached('stickers.json', DB + 'stickers.json');
const agentsRaw = await cached('agents.json', DB + 'agents.json');

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
  if (vanilla) rec.v = 1;
  if (s.phase) rec.ph = s.phase;
  skins[id] = rec;
  return rec;
}

const STICKER_TYPES = new Set(['Sticker Capsule', 'Autograph Capsule']);
const cases = [];
const stickerIdsInCapsules = new Set();
for (const c of crates) {
  if (c.type === 'Case') {
    const pools = {};
    for (const it of c.contains) {
      const s = addSkin(it.id);
      if (!s || s.r === 7) continue; // contraband no longer drops
      (pools[s.r] ||= []).push(s.id);
    }
    // Group rare items by name so each knife/glove finish is equally likely and Doppler phases split one slot.
    const groups = new Map();
    for (const it of c.contains_rare) {
      const s = addSkin(it.id);
      if (!s) continue;
      if (!groups.has(s.n)) groups.set(s.n, []);
      groups.get(s.n).push(s.id);
    }
    const rare = [...groups.values()];
    cases.push({
      id: c.id, n: c.name, img: img(c.image), kind: 'case', key: true,
      date: c.first_sale_date || '', price: null, pools, rare,
      rareKind: rare.some((g) => skins[g[0]].cat === 'gloves') ? (rare.some((g) => skins[g[0]].cat === 'knife') ? 'mixed' : 'gloves') : 'knife',
    });
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

const data = { version: 1, keyPrice: pricing.KEY_PRICE, cases, skins, stickers, agents };
const counts = pricing.applyPrices(data, idx);

// Drop stickers nobody sells (no price) unless they are in a capsule; drop capsules without a price.
for (const [id, s] of Object.entries(stickers)) {
  if (s.p == null && !stickerIdsInCapsules.has(id)) delete stickers[id];
  else if (s.p == null) s.p = [0.03, 0.03, 0.05, 0.3, 1.5, 4, 0, 50][s.r] || 0.05;
}
for (const a of Object.values(agents)) if (a.p == null) a.p = [0, 0, 1.5, 3, 7, 15][a.r] || 2;
data.cases = cases.filter((c) => {
  if (c.price == null) return false;
  if (c.kind !== 'case') {
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
console.log(`cases: ${data.cases.filter((c) => c.kind === 'case').length}, capsules: ${data.cases.filter((c) => c.kind !== 'case').length}`);
console.log(`skins: ${Object.keys(skins).length}, stickers: ${Object.keys(stickers).length}, agents: ${Object.keys(agents).length}`);
console.log('priced:', counts);
console.log(`wrote ${OUT} (${kb} KB)`);
