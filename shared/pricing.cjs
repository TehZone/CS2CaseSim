// Market price aggregation shared by the data build script (Node) and the
// Electron main process ("Refresh prices" in Settings).
//
// Sources (all public, no API key):
//   - Skinport public API      (lowest listing / suggested price, Doppler phases via `version`)
//   - CSFloat   via csgotrader (lowest listing, Doppler phases)
//   - Buff163   via csgotrader (lowest listing, Doppler phases)
//   - YouPin    via csgotrader (lowest listing)
//   - Steam     via csgotrader (7/30/90 day sales; only used as a fallback, discounted)
//
// The final price of an item is the median of the third-party marketplaces that list it.

const SOURCES = {
  skinport: 'https://api.skinport.com/v1/items?app_id=730&currency=USD&tradable=0',
  csfloat: 'https://prices.csgotrader.app/latest/csfloat.json',
  buff163: 'https://prices.csgotrader.app/latest/buff163.json',
  youpin: 'https://prices.csgotrader.app/latest/youpin.json',
  steam: 'https://prices.csgotrader.app/latest/steam.json',
};

const WEARS = [
  { k: 'FN', name: 'Factory New', min: 0, max: 0.07 },
  { k: 'MW', name: 'Minimal Wear', min: 0.07, max: 0.15 },
  { k: 'FT', name: 'Field-Tested', min: 0.15, max: 0.38 },
  { k: 'WW', name: 'Well-Worn', min: 0.38, max: 0.45 },
  { k: 'BS', name: 'Battle-Scarred', min: 0.45, max: 1 },
];
// Typical price of each wear relative to Field-Tested, used to fill gaps.
const WEAR_RATIO = { FN: 2.1, MW: 1.35, FT: 1, WW: 0.9, BS: 0.8 };
// Fallback multipliers vs Phase 1 when a marketplace has no phase price.
const PHASE_RATIO = { 'Phase 1': 1, 'Phase 2': 1.35, 'Phase 3': 0.97, 'Phase 4': 1.08, Ruby: 5.5, Sapphire: 4.2, 'Black Pearl': 4.5, Emerald: 4.5 };
const KEY_PRICE = 2.49;

async function fetchSources(fetchImpl = fetch, onProgress = () => {}) {
  const out = {};
  for (const [name, url] of Object.entries(SOURCES)) {
    onProgress(`Downloading ${name} prices...`);
    try {
      const res = await fetchImpl(url, { headers: { 'Accept-Encoding': 'br, gzip', 'User-Agent': 'cs2-case-sim/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      out[name] = await res.json();
    } catch (e) {
      onProgress(`  ${name} failed: ${e.message}`);
      out[name] = null;
    }
  }
  return out;
}

function buildIndex(raw) {
  const sp = new Map();
  for (const e of raw.skinport || []) {
    let m = sp.get(e.market_hash_name);
    if (!m) sp.set(e.market_hash_name, (m = {}));
    m[e.version || ''] = e;
  }
  return { sp, cf: raw.csfloat || {}, bf: raw.buff163 || {}, yp: raw.youpin || {}, st: raw.steam || {} };
}

const num = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : null);

function median(a) {
  const v = a.filter((x) => x != null).sort((x, y) => x - y);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function priceOf(idx, name, phase) {
  const vals = [];
  const sp = idx.sp.get(name)?.[phase || ''];
  if (sp) {
    const low = sp.quantity > 0 ? num(sp.min_price) : null;
    const sug = num(sp.suggested_price);
    vals.push(low && sug ? Math.min(low, sug * 1.5) : low || sug);
  }
  const cf = idx.cf[name];
  if (cf) {
    vals.push(phase
      ? num(cf.doppler?.[phase]) ?? num(cf.starting_at?.doppler?.[phase])
      : num(cf.price) ?? num(cf.starting_at?.price));
  }
  const bf = idx.bf[name];
  if (bf) vals.push(phase ? num(bf.starting_at?.doppler?.[phase]) : num(bf.starting_at?.price));
  if (!phase) vals.push(num(idx.yp[name]));

  let p = median(vals);
  if (p == null && !phase) {
    const st = idx.st[name];
    const s = st && (num(st.last_7d) ?? num(st.last_30d) ?? num(st.last_90d) ?? num(st.last_24h));
    if (s) p = s * 0.8; // Steam prices include the wallet premium
  }
  return p == null ? null : Math.round(p * 100) / 100;
}

function wearsFor(mn, mx) {
  return WEARS.filter((w) => mx > w.min && mn < w.max).map((w) => w.k);
}

function mhn(skin, wearKey, st) {
  const isStar = skin.n.startsWith('★');
  const base = isStar ? skin.n.slice(2) : skin.n;
  const prefix = st ? (isStar ? '★ StatTrak™ ' : 'StatTrak™ ') : (isStar ? '★ ' : '');
  if (!wearKey) return prefix + base;
  return `${prefix}${base} (${WEARS.find((w) => w.k === wearKey).name})`;
}

const RARITY_FALLBACK = [0.03, 0.05, 0.1, 0.6, 3, 15, 180, 2000];

// Returns { FN: [normal, stattrak], MW: [...], ... } or { V: [normal, stattrak] } for vanilla knives.
function priceSkin(idx, skin) {
  const phase = skin.ph || null;
  const lookup = (wk, st) => {
    let p = priceOf(idx, mhn(skin, wk, st), phase);
    if (phase) {
      const base = priceOf(idx, mhn(skin, wk, st), null);
      const ratio = PHASE_RATIO[phase] || 1;
      // No phase-specific listing: derive from the base finish price.
      if (p == null && base) p = Math.round(base * ratio * 100) / 100;
      // Gem phases (Ruby, Sapphire, Black Pearl, Emerald) never trade near regular phases; ignore stale/noisy listings.
      if (p != null && base && ratio >= 4 && p < base * 2.5) p = Math.round(base * ratio * 100) / 100;
    }
    return p;
  };
  if (skin.v) {
    const n = lookup(null, false);
    const s = skin.stt ? lookup(null, true) : null;
    const nn = n ?? (s ? s / 1.15 : RARITY_FALLBACK[6]);
    return { V: [nn, skin.stt ? s ?? nn * 1.15 : null] };
  }
  const wears = wearsFor(skin.mn, skin.mx);
  const p = {};
  for (const wk of wears) p[wk] = [lookup(wk, false), skin.stt ? lookup(wk, true) : null];
  // Fill gaps from the nearest known wear using typical ratios.
  const known = wears.filter((w) => p[w][0] != null);
  for (const wk of wears) {
    if (p[wk][0] == null) {
      if (known.length) {
        const ref = known.reduce((a, b) => (Math.abs(wears.indexOf(b) - wears.indexOf(wk)) < Math.abs(wears.indexOf(a) - wears.indexOf(wk)) ? b : a));
        p[wk][0] = Math.round(p[ref][0] * (WEAR_RATIO[wk] / WEAR_RATIO[ref]) * 100) / 100;
      } else {
        p[wk][0] = RARITY_FALLBACK[skin.star ? 6 : skin.r] * WEAR_RATIO[wk];
      }
    }
    if (skin.stt && p[wk][1] == null) p[wk][1] = Math.round(p[wk][0] * (skin.star ? 1.15 : 1.7) * 100) / 100;
  }
  return p;
}

// Mutates game data in place with fresh prices. Returns counts for reporting.
function applyPrices(data, idx) {
  let skins = 0, stickers = 0, agents = 0, cases = 0;
  for (const s of Object.values(data.skins)) { s.p = priceSkin(idx, s); skins++; }
  for (const s of Object.values(data.stickers)) {
    const p = priceOf(idx, s.n, null);
    if (p != null) { s.p = p; stickers++; }
  }
  for (const a of Object.values(data.agents)) {
    const p = priceOf(idx, a.n, null);
    if (p != null) { a.p = p; agents++; }
  }
  for (const c of data.cases) {
    if (c.custom) continue;
    const p = priceOf(idx, c.n, null);
    if (p != null) { c.price = p; cases++; }
  }
  data.pricedAt = new Date().toISOString();
  return { skins, stickers, agents, cases };
}

module.exports = { SOURCES, WEARS, KEY_PRICE, fetchSources, buildIndex, priceOf, priceSkin, applyPrices, wearsFor, mhn };
