// Item generation (rolls, floats, seeds) and valuation (market price x float x pattern + applied stickers).
// Shared by the client and the multiplayer server (no DOM). Images live in the client's items.js.
import { D, WEARS, WEAR_BY_KEY, wearOf, RARITY, rarityColor, caseTiers, DOPPLER_PHASE_WEIGHT, eventShort } from './data.js';
import { analyzePattern } from './patterns.js';
import { BREED, HAT, rollChicken, chickenValue, chickenName } from './chickens.js';
import { rand, pick, pickWeighted, round2, uid } from './util.js';

export const MAX_STICKERS = 5;
const STICKER_CATS = new Set(['rifle', 'smg', 'pistol', 'heavy']);
const SKIN_KINDS = new Set(['case', 'souvenir', 'package', 'collection']);

// CS2 wear distribution: pick a wear bracket in raw 0..1 space, then scale into the skin's float range.
export const FLOAT_BRACKETS = [[[0, 0.07], 0.03], [[0.07, 0.15], 0.24], [[0.15, 0.38], 0.33], [[0.38, 0.45], 0.24], [[0.45, 1], 0.16]];
export function rollFloat(mn, mx, r = rand) {
  const [lo, hi] = pickWeighted(FLOAT_BRACKETS, r);
  return Math.fround(mn + (lo + r() * (hi - lo)) * (mx - mn));
}
export function rollFloatInWear(skin, wk, r = rand) {
  const w = WEAR_BY_KEY[wk];
  const lo = Math.max(w.min, skin.mn), hi = Math.min(w.max, skin.mx);
  return Math.fround(lo + r() * (hi - lo) * 0.9999);
}

export function makeSkinItem(skin, { src = '', stt, fl, sd, sv, r = rand } = {}) {
  const item = {
    uid: uid(), t: 'skin', id: skin.id,
    fl: skin.v ? null : fl ?? rollFloat(skin.mn, skin.mx, r),
    sd: skin.v ? null : sd ?? Math.floor(r() * 1001),
    stt: sv ? false : stt ?? (skin.stt && skin.cat !== 'gloves' && r() < 0.1),
    stk: [], at: Date.now(), src,
  };
  if (sv) item.sv = true;
  if (item.stt) item.kills = 0;
  return item;
}
export const makeStickerItem = (s, src = '') => ({ uid: uid(), t: 'sticker', id: s.id, at: Date.now(), src });
export const makeAgentItem = (a, src = '') => ({ uid: uid(), t: 'agent', id: a.id, at: Date.now(), src });
export const makeProItem = (p, src = '') => ({ uid: uid(), t: 'pro', id: p.id, at: Date.now(), src });

// Souvenir stickers for a Major: the event logo, the two teams that "played the match" and (from Cologne 2015)
// a gold autograph of the match MVP. Placed in model space (m: 1) so they line up on icons and 3D models.
export function souvenirStickers(ev, r = rand) {
  const e = D.events[ev];
  if (!e) return [];
  const teams = Object.keys(e.ts).filter((t) => D.stickers[e.ts[t]]);
  const a = teams.length ? teams.splice(Math.floor(r() * teams.length), 1)[0] : null;
  const b = teams.length ? teams.splice(Math.floor(r() * teams.length), 1)[0] : null;
  const ids = [e.logo, a && e.ts[a], b && e.ts[b]];
  const mvps = [...(e.mvp[a] || []), ...(e.mvp[b] || [])].filter((id) => D.stickers[id]);
  if (mvps.length) ids.push(pick(mvps, r));
  return ids.filter((id) => id && D.stickers[id]).map((id, i) => ({ id, x: 0.24 + i * 0.17, y: 0.42, r: 0, wr: 0, m: 1, sv: 1 }));
}

// ---- rolling a case ------------------------------------------------------------------------
export function rollFromCase(c, r = rand) {
  if (c.kind === 'chickens') return rollChicken(r, c.n);
  const tier = pickWeighted(caseTiers(c), r);
  if (SKIN_KINDS.has(c.kind)) {
    let skinId;
    if (tier === 'rare') {
      const group = pick(c.rare, r);
      skinId = group.length > 1
        ? pickWeighted(group.map((id) => [id, DOPPLER_PHASE_WEIGHT[D.skins[id].ph] ?? 0.2]), r)
        : group[0];
    } else skinId = pick(c.pools[tier], r);
    const skin = D.skins[skinId];
    if (c.kind === 'souvenir') {
      const item = makeSkinItem(skin, { src: c.n, sv: true, r });
      item.stk = souvenirStickers(c.ev, r);
      return item;
    }
    // Only weapon cases (and their knives/gloves) can drop StatTrak.
    return makeSkinItem(skin, { src: c.n, r, ...(c.kind === 'case' || tier === 'rare' ? {} : { stt: false }) });
  }
  const id = pick(c.pools[tier], r);
  return c.kind === 'agents' ? makeAgentItem(D.agents[id], c.n) : makeStickerItem(D.stickers[id], c.n);
}

// A visual-only filler entry for the roulette strip. Fillers never show the gold "Rare Special Item"
// (or ★ chickens): gold only appears in the reel when it is what you actually pulled.
export function fakeRoll(c, r = rand) {
  if (c.kind === 'chickens') {
    let ch;
    do { ch = rollChicken(r); } while (BREED[ch.id].r >= 6);
    return ch;
  }
  const tier = pickWeighted(caseTiers(c).filter(([k]) => k !== 'rare'), r);
  if (SKIN_KINDS.has(c.kind)) return { t: 'skin', id: pick(c.pools[tier], r), fl: 0.2, sv: c.kind === 'souvenir' };
  return { t: c.kind === 'agents' ? 'agent' : 'sticker', id: pick(c.pools[tier], r) };
}

// ---- pro player cards ------------------------------------------------------------------------
export const PRO_RARITY = [
  { n: 'Bronze', c: '#b9824f', min: 60, p: 0.12 },
  { n: 'Silver', c: '#c3ccd8', min: 74, p: 0.45 },
  { n: 'Gold', c: '#e4ae39', min: 80, p: 1.8 },
  { n: 'Gold Star', c: '#ffd447', min: 85, p: 7.5 },
  { n: 'Legend', c: '#ff5cdb', min: 90, p: 30 },
];
export const proTier = (ovr) => PRO_RARITY.reduce((t, x, i) => (ovr >= x.min ? i : t), 0);
export const proTeamName = (p) => D.proTeams[p.tm]?.n || '';
export const proTeamTag = (p) => D.proTeams[p.tm]?.tag || '';
export function proValue(p) {
  const t = proTier(p.ovr);
  return round2(PRO_RARITY[t].p * (1 + (p.ovr - PRO_RARITY[t].min) * 0.18));
}

// ---- definitions, names, images ------------------------------------------------------------
export function itemDef(item) {
  switch (item.t) {
    case 'skin': return D.skins[item.id];
    case 'sticker': return D.stickers[item.id];
    case 'agent': return D.agents[item.id];
    case 'chicken': return BREED[item.id];
    case 'pro': return D.pros[item.id];
  }
  return null;
}

export function itemName(item) {
  const d = itemDef(item);
  if (!d) return 'Unknown item';
  if (item.t === 'chicken') return chickenName(item);
  if (item.t === 'pro') return `${d.n} (${eventShort(d.ev)})`;
  if (item.t !== 'skin') return d.n;
  if (item.sv) return 'Souvenir ' + d.n;
  if (!item.stt) return d.n;
  return d.star ? d.n.replace('★ ', '★ StatTrak™ ') : 'StatTrak™ ' + d.n;
}

// "AK-47" + "Redline" split, used by cards.
export function nameParts(item) {
  const d = itemDef(item);
  if (item.t === 'skin') {
    const [w, f] = d.n.replace('★ ', '').split(' | ');
    const pre = (d.star ? '★ ' : '') + (item.sv ? 'Souvenir ' : item.stt ? 'StatTrak™ ' : '');
    return { top: pre + w, bottom: f ? f + (d.ph ? ` (${d.ph})` : '') : 'Vanilla' };
  }
  if (item.t === 'sticker') {
    const parts = d.n.replace(/^Sticker \| /, '').split(' | ');
    return { top: 'Sticker', bottom: parts.join(' | ') };
  }
  if (item.t === 'agent') {
    const [a, b] = d.n.split(' | ');
    return { top: b || 'Agent', bottom: a };
  }
  if (item.t === 'chicken') return { top: 'Chicken', bottom: chickenName(item) };
  if (item.t === 'pro') return { top: `${d.ovr} ${d.role} · ${proTeamTag(d)} ${eventShort(d.ev)}`, bottom: d.n };
  return { top: '', bottom: '' };
}

export function wearName(item) {
  if (item.t !== 'skin' || item.fl == null) return '';
  return WEAR_BY_KEY[wearOf(item.fl)].n;
}

export function rarityRank(item) {
  const d = itemDef(item);
  if (!d) return 0;
  if (item.t === 'skin' && d.star) return 6;
  if (item.t === 'pro') return 2 + proTier(d.ovr);
  return d.r;
}
export function rarityInfo(item) {
  const rank = rarityRank(item);
  if (item.t === 'pro') { const t = PRO_RARITY[rank - 2]; return { rank, n: t.n, c: t.c }; }
  const fam = item.t === 'sticker' ? 'sticker' : item.t === 'agent' ? 'agent' : item.t === 'chicken' ? 'chicken' : 'skin';
  let n = RARITY[fam][rank] || '';
  if (item.t === 'skin' && rank === 6) n = itemDef(item).cat === 'gloves' ? 'Extraordinary' : 'Covert ★';
  return { rank, n, c: rarityColor(rank) };
}

// Souvenirs keep their match stickers and take no others (like CS2).
export const canHaveStickers = (item) => item.t === 'skin' && !item.sv && STICKER_CATS.has(itemDef(item)?.cat);

// ---- valuation -----------------------------------------------------------------------------
export function basePrice(item) {
  const d = itemDef(item);
  if (!d) return 0;
  if (item.t === 'sticker' || item.t === 'agent') return d.p || 0;
  if (item.t === 'chicken') return chickenValue(item);
  if (item.t === 'pro') return proValue(d);
  if (d.v) return (item.stt ? d.p.V[1] : null) ?? d.p.V[0];
  let row = d.p[wearOf(item.fl)];
  if (!row) {
    // Float outside listed wears (shouldn't happen); use the closest listed wear.
    const keys = Object.keys(d.p);
    row = d.p[keys[0]];
  }
  if (item.sv) return row[2] ?? row[0] * 1.6;
  return (item.stt ? row[1] : null) ?? row[0];
}

export function floatMultiplier(item) {
  if (item.t !== 'skin' || item.fl == null) return 1;
  const d = itemDef(item);
  const f = item.fl;
  const wk = wearOf(f);
  if (wk === 'FN') {
    if (f < 0.0001) return 6;
    if (f < 0.001) return 3;
    if (f < 0.005) return 1.6;
    if (f < 0.01) return 1.3;
    if (f < 0.02) return 1.1;
  }
  const w = WEAR_BY_KEY[wk];
  const lo = Math.max(w.min, d.mn), hi = Math.min(w.max, d.mx);
  const pos = (f - lo) / Math.max(1e-6, hi - lo);
  if (wk !== 'FN' && pos < 0.02) return 1.25; // top float of its wear (e.g. 0.0700x MW looks Factory New)
  if (wk !== 'FN' && pos < 0.08) return 1.08;
  if (wk === 'BS' && f > 0.99) return 1.35; // max-float collectors
  return 1;
}

export function patternInfo(item) {
  if (item.t !== 'skin') return { mult: 1, label: '', tier: '', info: [] };
  return analyzePattern(itemDef(item), item.sd);
}

// Sticker contribution: a share of each sticker's market price, more for expensive/old tournament
// stickers, boosted for 3x/4x/5x "crafts" of the same sticker, reduced by scraping. Souvenir match
// stickers are already part of the souvenir's market price.
export function stickerContribution(item) {
  const stk = (item.stk || []).filter((s) => !s.sv);
  const counts = {};
  for (const s of stk) counts[s.id] = (counts[s.id] || 0) + 1;
  return stk.map((s) => {
    const def = D.stickers[s.id];
    const p = def?.p || 0;
    let rate = p < 1 ? 0.04 : p < 10 ? 0.07 : p < 100 ? 0.1 : p < 1000 ? 0.15 : 0.22;
    if (/Katowice 2014|Cologne 2014|Katowice 2015/.test(def?.t || '')) rate += 0.08;
    if (def?.fx === 'Holo' || def?.fx === 'Gold') rate += 0.02;
    const n = counts[s.id];
    const craft = n >= 5 ? 2.5 : n >= 4 ? 2 : n >= 3 ? 1.35 : 1;
    const scrape = 1 - (s.wr || 0) * 0.85;
    return { s, def, value: round2(p * rate * craft * scrape), craft };
  });
}

export function valueBreakdown(item) {
  const base = basePrice(item);
  const fm = floatMultiplier(item);
  const pat = patternInfo(item);
  const stickers = item.t === 'skin' ? stickerContribution(item) : [];
  const stickerTotal = stickers.reduce((s, x) => s + x.value, 0);
  const total = round2(base * fm * pat.mult + stickerTotal);
  return { base, fm, pat, stickers, stickerTotal: round2(stickerTotal), total };
}

const valueCache = new WeakMap();
export function itemValue(item) {
  // Cached per object; invalidated by replacing item.stk (see stickers editor) or calling invalidate().
  const key = (item.stk || []).map((s) => s.id + (s.wr || 0)).join();
  const c = valueCache.get(item);
  if (c && c.key === key && c.pricedAt === D.pricedAt) return c.v;
  const v = valueBreakdown(item).total;
  valueCache.set(item, { key, v, pricedAt: D.pricedAt });
  return v;
}

export function floatString(f) {
  return f == null ? '—' : String(Math.fround(f));
}

export { WEARS, HAT };
