// Item generation (rolls, floats, seeds) and valuation (market price x float x pattern + applied stickers).
// Shared by the client and the multiplayer server (no DOM). Images live in the client's items.js.
import { D, WEARS, WEAR_BY_KEY, wearOf, RARITY, rarityColor, caseTiers, phaseWeight, eventShort } from './data.js';
import { analyzePattern } from './patterns.js';
import { BREED, chickenValue, chickenName } from './chickens.js';
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
// A case (or capsule, package...) in your inventory, and a key that opens one.
export const makeCrateItem = (c, src = '') => ({ uid: uid(), t: 'crate', id: c.id, at: Date.now(), src });
export const makeKeyItem = (keyId, src = '') => ({ uid: uid(), t: 'key', id: keyId, at: Date.now(), src });
// A Storage Unit (see storage.js): a tool, so it has no market price and can't be traded or sold.
export const UNIT_ID = 'casket';
const UNIT_DEF = { id: UNIT_ID, n: 'Storage Unit', r: 0, p: 0 };
export const makeUnitItem = (src = '') => ({ uid: uid(), t: 'unit', id: UNIT_ID, at: Date.now(), src });
export const isUnit = (item) => item.t === 'unit';
// A badge (CS2's collectibles: badgedata.js, and what a player can do with one: badges.js). Only a capsule's pins trade; every
// other one is bound to whoever has it, as CS2's Service Medals and coins are: it can't be traded, sold, listed, staked or
// stored. (A badge the game no longer has is bound too: it's nothing.)
export const makeBadgeItem = (b, src = '') => ({ uid: uid(), t: 'badge', id: b.id, at: Date.now(), src });
export const isBadge = (item) => item?.t === 'badge';
export const isBound = (item) => item?.t === 'badge' && !itemDef(item)?.tr;
// What another player, a trader or a stake can take: not locked items, not units, not a bound badge, and nothing the game no
// longer has.
export const tradable = (item) => !item.lk && !isUnit(item) && !isBound(item) && !!itemDef(item);
// How many of these items count toward an inventory's limit (online, the server's INV_CAP): all but bound badges (the
// Service Medals prestiging gives, and what staff gave), which nothing but staff can take out of an inventory again.
export function capCount(items) {
  let n = 0;
  for (const it of items || []) if (!isBound(it)) n++;
  return n;
}

// ---- tools -----------------------------------------------------------------------------------
// CS2's Name Tag (item 1200) and StatTrak™ Swap Tool (item 1324), t: 'tool' in your inventory: Base Grade, with CS2's own
// descriptions. Nothing in items_game.txt says `cannot trade` for them, so unlike the Storage Unit they trade and sell like
// any other item. Their prices are the Steam Market's, fixed like the key's and the unit's, so one always sells for what it
// cost. What they do: tools.js.
export const NAME_TAG = 'nametag', SWAP_TOOL = 'stattrak_swap';
export const TOOLS = {
  [NAME_TAG]: { id: NAME_TAG, n: 'Name Tag', r: 0, p: 4.47, use: 'Apply Name Tag', desc: 'This item will rename a weapon. A custom engraved nameplate will be applied to the weapon and viewable in game.' },
  [SWAP_TOOL]: { id: SWAP_TOOL, n: 'StatTrak™ Swap Tool', r: 0, p: 1.62, use: 'Open StatTrak™ Swap Tool', desc: 'This item swaps StatTrak™ values between two of the same item type.' },
};
export const makeToolItem = (id, src = '') => ({ uid: uid(), t: 'tool', id, at: Date.now(), src });
export const isTool = (item) => item.t === 'tool';
// The name a Name Tag gave an item ('' if none). (A Storage Unit's label is in `name` too, but it's no Name Tag's.)
export const customName = (item) => (item.t === 'skin' && item.name) || '';

// ---- charms ----------------------------------------------------------------------------------
// A charm hangs off a gun's keychain point. Each copy has a pattern (1-100,000, like CS2's): which way it hangs and turns.
// A Sticker Slab is a charm too: any sticker sealed in a clear case (id 'slab', the sticker in `sk`).
export const CHARM_PATTERNS = 100000;
export const rollCharmPattern = (r = rand) => 1 + Math.floor(r() * CHARM_PATTERNS);
export function makeCharmItem(c, { src = '', pat, r = rand } = {}) {
  return { uid: uid(), t: 'charm', id: c.id, pat: pat ?? rollCharmPattern(r), at: Date.now(), src };
}
export const makeSlabItem = (stickerId, { src = 'Sticker Slab', pat, r = rand } = {}) =>
  ({ uid: uid(), t: 'charm', id: 'slab', sk: stickerId, pat: pat ?? rollCharmPattern(r), at: Date.now(), src });
// A slab's definition, made from its sticker: worth the sticker plus the slab.
const slabDefs = new Map();
function slabDef(sk) {
  const s = D.stickers[sk];
  if (!s || !D.slab) return null;
  let d = slabDefs.get(sk);
  if (!d || d.p !== round2(s.p + D.slab.p)) {
    d = { id: 'slab', sk, n: 'Sticker Slab | ' + s.n.replace(/^Sticker \| /, ''), r: s.r, rc: s.rc, img: s.img, fx: s.fx, mdl: D.slab.mdl, p: round2(s.p + D.slab.p), slab: true };
    slabDefs.set(sk, d);
  }
  return d;
}
// Taking a charm off uses up a Charm Detachment; they come in packs of three.
export const DETACH_PACK = { n: 3, price: 0.99 };
// Charms go on guns (Souvenirs too), one per gun; not on knives, gloves or gear.
export const canHaveCharm = (item) => item.t === 'skin' && STICKER_CATS.has(itemDef(item)?.cat);
// The charm on a gun, as a charm item (item.kc keeps the charm item without its uid while it's attached).
export const attachedCharm = (item) => (item.kc ? { ...item.kc, t: 'charm' } : null);
// Where a charm hangs on its gun ({ b: bone, p: point, n: the surface's outward normal }, in the gun model's space in
// inches, see cs2/charm.js), checked and rounded; null if it isn't one.
export function charmPlacement(o) {
  const vec = (v, max) => (Array.isArray(v) && v.length === 3 && v.every((x) => Number.isFinite(x) && Math.abs(x) <= max) ? v.map((x) => Math.round(x * 1000) / 1000) : null);
  const b = typeof o?.b === 'string' && /^[\w.-]{1,48}$/.test(o.b) ? o.b : null;
  const p = vec(o?.p, 100), n = vec(o?.n, 1.01);
  return b && p && n && Math.hypot(...n) > 0.5 ? { b, p, n } : null;
}
// Low and fun patterns are collected: #1, #2-10, #11-100, #101-1000, and numbers like 77777, 12345 or 100000.
const FUN_PATTERNS = new Set([69, 420, 777, 1337, 6969, 12345, 42069, 69420, 100000]);
export function charmPattern(pat) {
  const out = { mult: 1, label: '', tier: '', info: [] };
  if (!pat) return out;
  const s = String(pat);
  const fun = FUN_PATTERNS.has(pat) || (s.length >= 3 && /^(\d)\1+$/.test(s));
  if (pat === 1) Object.assign(out, { mult: 3, label: 'Pattern #1', tier: 't0' });
  else if (pat <= 10) Object.assign(out, { mult: 1.8, label: 'Top 10 pattern', tier: 't1' });
  else if (pat <= 100) Object.assign(out, { mult: 1.3, label: 'Low pattern' });
  else if (fun) Object.assign(out, { mult: 1.15, label: 'Special pattern' });
  else if (pat <= 1000) Object.assign(out, { mult: 1.08, label: 'Low pattern' });
  out.info.push(['Pattern', '#' + pat.toLocaleString('en-US')]);
  return out;
}

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
  const tier = pickWeighted(caseTiers(c), r);
  if (SKIN_KINDS.has(c.kind)) {
    let skinId;
    if (tier === 'rare') {
      const group = pick(c.rare, r);
      skinId = group.length > 1
        ? pickWeighted(group.map((id) => [id, phaseWeight(D.skins[id])]), r)
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
  if (c.kind === 'charms') return makeCharmItem(D.charms[id], { src: c.n, r });
  if (c.kind === 'pins') return makeBadgeItem(D.badges[id], c.n);
  return c.kind === 'agents' ? makeAgentItem(D.agents[id], c.n) : makeStickerItem(D.stickers[id], c.n);
}

// A visual-only filler entry for the roulette strip. Fillers never show the gold "Rare Special Item": gold only
// appears in the reel when it is what you actually pulled.
export function fakeRoll(c, r = rand) {
  const tier = pickWeighted(caseTiers(c).filter(([k]) => k !== 'rare'), r);
  if (SKIN_KINDS.has(c.kind)) return { t: 'skin', id: pick(c.pools[tier], r), fl: 0.2, sv: c.kind === 'souvenir' };
  return { t: c.kind === 'agents' ? 'agent' : c.kind === 'charms' ? 'charm' : c.kind === 'pins' ? 'badge' : 'sticker', id: pick(c.pools[tier], r) };
}

// ---- pro player cards (the old Team manager's: kept to price the ones in older saves, see retireOld) ----------------
export const PRO_RARITY = [
  { n: 'Bronze', c: '#b9824f', min: 60, p: 0.12 },
  { n: 'Silver', c: '#c3ccd8', min: 74, p: 0.45 },
  { n: 'Gold', c: '#e4ae39', min: 80, p: 1.8 },
  { n: 'Gold Star', c: '#ffd447', min: 85, p: 7.5 },
  { n: 'Legend', c: '#ff5cdb', min: 90, p: 30 },
];
export const proTier = (ovr) => PRO_RARITY.reduce((t, x, i) => (ovr >= x.min ? i : t), 0);
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
    case 'charm': return item.id === 'slab' ? slabDef(item.sk) : D.charms[item.id];
    case 'crate': return D.caseById?.[item.id] || null; // a case in your inventory, opened with its key
    case 'key': return D.keys[item.id] || null;
    case 'unit': return UNIT_DEF;
    case 'tool': return Object.hasOwn(TOOLS, item.id) ? TOOLS[item.id] : null;
    case 'badge': return Object.hasOwn(D.badges, item.id) ? D.badges[item.id] : null;
  }
  return null;
}

export function itemName(item) {
  const d = itemDef(item);
  if (!d) return 'Unknown item';
  if (item.t === 'chicken') return chickenName(item);
  if (item.t === 'pro') return `${d.n} (${eventShort(d.ev)})`;
  if (item.t === 'unit') return item.name ? `${d.n} "${item.name}"` : d.n;
  if (item.t === 'badge') return d.v ? `${d.n} (${d.v})` : d.n;
  if (item.t !== 'skin') return d.n;
  const real = item.sv ? 'Souvenir ' + d.n : !item.stt ? d.n : d.star ? d.n.replace('★ ', '★ StatTrak™ ') : 'StatTrak™ ' + d.n;
  return item.name ? `${real} "${item.name}"` : real;
}
// An item's own name, whatever a Name Tag called it.
export const realName = (item) => itemName({ ...item, name: null });

// "AK-47" + "Redline" split, used by cards.
export function nameParts(item) {
  const d = itemDef(item);
  if (!d) return { top: '', bottom: 'Unknown item' };
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
  if (item.t === 'charm') return d.slab ? { top: 'Sticker Slab', bottom: d.n.replace(/^Sticker Slab \| /, '') } : { top: 'Charm', bottom: d.n.replace(/^Charm \| /, '') };
  if (item.t === 'pro') return { top: `${d.ovr} ${d.role} · ${proTeamTag(d)} ${eventShort(d.ev)}`, bottom: d.n };
  if (item.t === 'crate') return { top: 'Container', bottom: d.n };
  if (item.t === 'key') return { top: 'Key', bottom: d.n };
  if (item.t === 'unit') return { top: d.n, bottom: item.name || 'Not labelled yet' };
  if (item.t === 'tool') return { top: 'Tool', bottom: d.n };
  if (item.t === 'badge') return { top: d.ty || 'Badge', bottom: d.v ? `${d.n} (${d.v})` : d.n };
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
  if (item.t === 'crate' || item.t === 'key' || item.t === 'unit' || item.t === 'tool') return 0;
  return d.r;
}
export function rarityInfo(item) {
  const rank = rarityRank(item);
  if (item.t === 'pro') { const t = PRO_RARITY[rank - 2]; return { rank, n: t.n, c: t.c }; }
  const fam = item.t === 'sticker' || item.t === 'charm' ? 'sticker' : ['agent', 'chicken', 'crate', 'key', 'unit', 'tool', 'badge'].includes(item.t) ? item.t : 'skin';
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
  if (item.t === 'sticker' || item.t === 'agent' || item.t === 'charm' || item.t === 'unit' || item.t === 'tool' || item.t === 'badge') return d.p || 0;
  if (item.t === 'chicken') return chickenValue(item);
  if (item.t === 'pro') return proValue(d);
  if (item.t === 'crate') return d.price || 0;
  if (item.t === 'key') return D.keyPrice;
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
  if (!d) return 1; // (a skin the game no longer has: worth nothing, see basePrice)
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
  if (item.t === 'charm') return charmPattern(item.pat);
  if (item.t !== 'skin' || !itemDef(item)) return { mult: 1, label: '', tier: '', info: [] };
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

// Serial numbers: every item unboxed from a container (cases, packages, capsules, the Armory, case battles) is
// numbered in unboxing order per item, StatTrak™ and Souvenir counted apart: offline within your save, online across
// everyone on the server. Items bought on the market or made in trade-ups have none, so unboxing is worth more.
export const serialKey = (item) => `${item.t}:${item.id}${item.stt ? ':st' : ''}${item.sv ? ':sv' : ''}`;
const FUN_SERIALS = new Set([69, 420, 777, 1337, 4200, 6969]);
// Funny or neat numbers: #69, #420, #777, #1337, repeated digits (#111, #2222) and round thousands (#1000).
export function isSpecialSerial(sn) {
  const s = String(sn);
  return FUN_SERIALS.has(sn) || (s.length >= 3 && /^(\d)\1+$/.test(s)) || (sn >= 1000 && /^[1-9]0+$/.test(s));
}
// Value multiplier for a serial: +3% for being unboxed at all, more for low (#1, #2-10, #11-100) and special numbers.
export function serialMultiplier(sn) {
  if (!sn) return 1;
  let tier = sn === 1 ? 1.5 : sn <= 10 ? 1.2 : sn <= 100 ? 1.05 : 1;
  if (isSpecialSerial(sn)) tier = Math.max(tier, 1.1);
  return 1.03 * tier;
}
// Saves from before serial numbers: number the items you unboxed back then, oldest first (once). Market buys and
// trade-up results stay unnumbered.
export function backfillSerials(st) {
  if (st.serialsBackfilled) return;
  st.serialsBackfilled = true;
  const unboxed = [...st.inv, ...(st.stored || [])].filter((it) => !it.sn && ['skin', 'sticker', 'agent', 'chicken'].includes(it.t)
    && it.src && it.src !== 'Market' && it.src !== 'Trade Up Contract').sort((a, b) => (a.at || 0) - (b.at || 0));
  const counts = { ...(st.serials || {}) };
  for (const it of unboxed) it.sn = counts[serialKey(it)] = (counts[serialKey(it)] || 0) + 1;
  st.serials = counts;
}

// Chickens (the old Chicken Coop Crate) and pro player cards (the old Team manager) are no longer in the game: an older
// save's are sold once when it loads, for what they're worth. Returns { n, value } (n 0: there were none).
const RETIRED = new Set(['chicken', 'pro']);
export function retireOld(st) {
  const old = [...st.inv, ...(st.stored || [])].filter((it) => RETIRED.has(it.t));
  if (!old.length) return { n: 0, value: 0 };
  const value = round2(old.reduce((s, it) => s + itemValue(it), 0));
  st.inv = st.inv.filter((it) => !RETIRED.has(it.t));
  if (st.stored) st.stored = st.stored.filter((it) => !RETIRED.has(it.t));
  st.money = round2(st.money + value);
  st.stats.sold = round2((st.stats.sold || 0) + value);
  return { n: old.length, value };
}

export function serialLabel(sn) {
  if (!sn) return '';
  return sn === 1 ? 'First ever unboxed' : sn <= 10 ? 'Top 10' : sn <= 100 ? 'Top 100' : isSpecialSerial(sn) ? 'Special number' : '';
}

export function valueBreakdown(item) {
  const base = basePrice(item);
  const fm = floatMultiplier(item);
  const pat = patternInfo(item);
  const sm = serialMultiplier(item.sn);
  const stickers = item.t === 'skin' ? stickerContribution(item) : [];
  const stickerTotal = stickers.reduce((s, x) => s + x.value, 0);
  // An attached charm keeps its whole value (it comes off again with a Charm Detachment).
  const charm = item.kc ? valueBreakdown(attachedCharm(item)).total : 0;
  const total = round2(base * fm * pat.mult * sm + stickerTotal + charm);
  return { base, fm, pat, sm, stickers, stickerTotal: round2(stickerTotal), charm, total };
}

const valueCache = new WeakMap();
export function itemValue(item) {
  // Cached per object; invalidated by replacing item.stk (see stickers editor) or item.kc, or calling invalidate().
  const key = (item.stk || []).map((s) => s.id + (s.wr || 0)).join() + (item.kc ? '|' + item.kc.id + (item.kc.sk || '') + item.kc.pat : '');
  const c = valueCache.get(item);
  if (c && c.key === key && c.pricedAt === D.pricedAt) return c.v;
  const v = valueBreakdown(item).total;
  valueCache.set(item, { key, v, pricedAt: D.pricedAt });
  return v;
}

// Auto-sell's "low float": a float that starts 0.000.
export const KEEP_FLOAT_BELOW = 0.001;
// Auto-sell: does a new drop match the player's rules? (see AUTO_SELL_DEFAULT in economy.js)
export function autoSellMatch(item, rules) {
  if (!rules?.on || isBound(item)) return false;
  const rank = rarityRank(item);
  if (rank >= 6) return false; // knives, gloves: never
  if (rules.keepStt && item.stt) return false;
  if (item.t === 'skin') {
    const pattern = patternInfo(item);
    if (pattern.label.includes('Blue Gem') ? rules.keepBlue : rules.keepRare && pattern.mult > 1) return false;
    if (rules.keepFloat && item.fl != null && item.fl < KEEP_FLOAT_BELOW) return false;
  }
  const byValue = rules.below > 0 && itemValue(item) < rules.below;
  const byRank = Array.isArray(rules.ranks) && rules.ranks.includes(rank);
  return byValue || byRank;
}
// Cleans auto-sell rules coming from a client.
export function cleanAutoSell(r) {
  if (!r || typeof r !== 'object' || !r.on) return null;
  const below = Math.max(0, Math.min(1e6, Number(r.below) || 0));
  const ranks = Array.isArray(r.ranks) ? [...new Set(r.ranks.map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x <= 5))] : [];
  if (!below && !ranks.length) return null;
  return { on: true, below, ranks, keepStt: !!r.keepStt, keepRare: !!r.keepRare, keepBlue: !!(r.keepBlue ?? r.keepRare), keepFloat: !!(r.keepFloat ?? r.keepRare) };
}

// Loadout slot an item is equipped in: gloves, knife, one agent per side, and one skin per gun (null = not equippable).
export function loadoutSlot(item) {
  const d = itemDef(item);
  if (!d) return null;
  if (item.t === 'agent') return d.team === 'CT' ? 'agentCT' : 'agentT';
  if (item.t !== 'skin') return null;
  if (d.cat === 'gloves') return 'gloves';
  if (d.cat === 'knife') return 'knife';
  return d.w ? 'w:' + d.w : null;
}

// A float as the game shows it (its 32-bit value, every digit), in plain decimals: 5e-8 is 0.00000005000000058430487.
export function floatString(f) {
  if (f == null) return '—';
  const s = String(Math.fround(f)), m = /^(\d)(?:\.(\d+))?e-(\d+)$/.exec(s); // (JavaScript writes what's under 1e-6 as 5e-8)
  return m ? '0.' + '0'.repeat(+m[3] - 1) + m[1] + (m[2] || '') : s;
}

export { WEARS };
