// The Market: items players list for sale at a price they choose, bought by other players at once. (The Store is the
// game's own stock that restocks every 10 minutes: market.js. In the top bar they're "Store" and "Market".)
//
// A listed item leaves the inventory for st.listed (each with `lid`, its listing's id, `lp`, its price, and `lat`, when it
// was listed), so nothing that works on the inventory can reach it: no trade, sale, stake, contract, Storage Unit, sticker or
// equip, without having to ask (as for Storage Units). It's still yours: ownedItems() counts it (net worth, the Item Database,
// float records). Cancelling a listing puts it back; a sale moves it to the buyer and the money to the seller.
//
// Online the server runs it (server/p2pmarket.mjs: listings in its own table, a sale written for buyer, seller and listing
// in one transaction). Offline the NPC traders (npcs.js) list some of what they own, at their own kind of prices, and buy
// some of what you list over time (p2p.tick, while the admin panel's "Market buyers" rule is on): the actions below, which
// refuse to run online.
//
// Pure apart from those actions: the server, the game's pages and the tests share the catalog, the searches and the rules.
import { D, WEARS, WEAR_BY_KEY, wearOf } from './data.js';
import * as I from './items.js';
import * as N from './npcs.js';
import { ACTIONS, GameError, take, give, spend, credit, findOwned } from './actions.js';
import { listedOf } from './storage.js';
import { hashStr, mulberry32, round2, clamp, pickWeighted, uid as newUid } from './util.js';

// ---- the rules ----------------------------------------------------------------------------------------------------------
// The share of a sale's price the market keeps: none. (0.05 would be 5%, at least a cent; the seller is paid the rest.)
export const MARKET_FEE = 0;
export const MAX_LISTINGS = 50; // a player's open listings at once
export const MIN_PRICE = 0.03, MAX_PRICE = 1000000;
export const MAX_MARKUP = 20; // nor more than 20 times the item's reference price (a typo, not a price)
export const PAGE_SIZE = 60; // listings or catalog entries a page shows
export const feeOf = (price) => (MARKET_FEE > 0 ? Math.max(0.01, round2(price * MARKET_FEE)) : 0);
export const sellerGets = (price) => round2(price - feeOf(price));
const fail = (m, code = 'bad') => { throw new GameError(m, code); };
export const usd = (x) => '$' + Number(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// A price as typed or sent: rounded to cents (NaN when it isn't a number). Typed, a comma before the cents is a decimal point
// ("1,5" and "12,50" are $1.50 and $12.50), commas between groups of three are thousands ("1,250" and "1,234.56"), and a
// European "1.234,56" is $1,234.56; anything else with a comma isn't a price.
function typedNumber(v) {
  let s = v.replace(/[$\s]/g, '');
  if (s.includes(',')) {
    if (s.includes('.')) s = s.lastIndexOf(',') < s.indexOf('.') ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
    else if (/^\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, '');
    else if (/^\d*,\d{1,2}$/.test(s)) s = s.replace(',', '.');
    else return NaN;
  }
  return s === '' ? NaN : Number(s);
}
export const cleanPrice = (v) => { const n = typeof v === 'string' ? typedNumber(v) : Number(v); return Number.isFinite(n) ? round2(n) : NaN; };
// Why a price can't be asked for an item worth `ref` ('' when it can).
export function priceProblem(price, ref = 0) {
  const p = cleanPrice(price);
  if (!Number.isFinite(p)) return 'Enter a price';
  if (p < MIN_PRICE) return `The lowest price is ${usd(MIN_PRICE)}`;
  if (p > MAX_PRICE) return `The highest price is ${usd(MAX_PRICE)}`;
  if (ref > 0 && p > 1 && p > ref * MAX_MARKUP) return `That's more than ${MAX_MARKUP} times its reference price (${usd(ref)})`;
  return '';
}
// The game's own value of a copy: what the Store pays for it at once, and what a listing's discount is measured against.
export const referencePrice = (item) => I.itemValue(item);
// An item's name as the Market says it (a buy's window, a toast, what happened): with a Doppler's phase, which decides most of
// its price ("★ Karambit | Gamma Doppler (Emerald)"). real: without a Name Tag's name.
export function marketName(item, { real = false } = {}) {
  const ph = item?.t === 'skin' && I.itemDef(item)?.ph, tag = real ? '' : I.customName(item);
  if (!ph) return real ? I.realName(item) : I.itemName(item);
  return `${I.realName(item)} (${ph})${tag ? ` "${tag}"` : ''}`;
}
// A price to ask: just under the cheapest listing of the same item, but never under what the Store pays for it at once (then
// you'd sell it there); with none listed, a little over it.
export function suggestedPrice(ref, lowest = null) {
  if (!(ref > 0)) return MIN_PRICE;
  const p = lowest > 0 ? Math.max(ref, lowest - 0.01) : ref * 1.05;
  return Math.max(MIN_PRICE, Math.min(MAX_PRICE, round2(p)));
}
// Why an item can't be listed ('' when it can). reserved: uids in your open trade offers (online).
export function listRefusal(item, { reserved = null } = {}) {
  if (!item) return 'Item not found (it may have been sold or traded)';
  if (I.isUnit(item)) return "Storage Units can't be listed";
  if (I.isBound(item)) return `${I.itemName(item)} can't be listed (only pins from capsules trade)`;
  if (item.lk) return `${I.itemName(item)} is locked. Unlock it first.`;
  if (!I.itemDef(item)) return 'This item is no longer in the game';
  if (reserved?.has(item.uid)) return `${I.itemName(item)} is in a pending trade offer`;
  return '';
}
// A listed item as st.listed keeps it, and back as an inventory item.
export const toListed = (item, { lid, price, at }) => { const { nw: _nw, lid: _l, lp: _p, lat: _a, ...it } = item; return { ...it, lid, lp: price, lat: at }; };
export const fromListed = (entry) => { const { lid: _l, lp: _p, lat: _a, ...it } = entry; return it; };
// A save's listings put right: no item twice, none that's also in the inventory or a Storage Unit, none the game no longer has.
export function repairListed(st) {
  if (st.listed == null) return 0;
  const seen = new Set([...(st.inv || []), ...(st.stored || [])].map((i) => i.uid)), kept = [];
  for (const it of Array.isArray(st.listed) ? st.listed : []) {
    if (!it || typeof it !== 'object' || seen.has(it.uid) || !it.lid || !I.itemDef(it)) continue;
    seen.add(it.uid);
    kept.push(it);
  }
  const n = (Array.isArray(st.listed) ? st.listed.length : 0) - kept.length;
  st.listed = kept;
  return n;
}

// ---- what an item is, for the market's searches -------------------------------------------------------------------------
// The category bar, as Skinport's: guns by kind, then the rest.
export const CATS = [['knife', 'Knife'], ['gloves', 'Gloves'], ['pistol', 'Pistol'], ['rifle', 'Rifle'], ['smg', 'SMG'], ['heavy', 'Heavy'],
  ['agent', 'Agent'], ['charm', 'Charm'], ['sticker', 'Sticker'], ['pin', 'Pin'], ['container', 'Container'], ['more', 'More']];
const GUN_CATS = new Set(['knife', 'gloves', 'pistol', 'rifle', 'smg', 'heavy']);
export const CAT_NAME = Object.fromEntries(CATS);
export function categoryOf(item) {
  if (item.t === 'skin') { const c = I.itemDef(item)?.cat; return GUN_CATS.has(c) ? c : 'more'; } // (the Zeus x27: More)
  if (item.t === 'agent' || item.t === 'charm' || item.t === 'sticker') return item.t;
  if (item.t === 'badge') return 'pin'; // (the only badges that list: badges.js)
  if (item.t === 'crate') return 'container';
  return 'more'; // keys and tools
}
export const WEAR_KEYS = ['FN', 'MW', 'FT', 'WW', 'BS'];
// Rarities as the filter lists them (a skin's, a sticker's or an agent's rank: items.rarityRank).
export const RANKS = [[0, 'Consumer / Default'], [1, 'Industrial / Base Grade'], [2, 'Mil-Spec / High Grade'], [3, 'Restricted / Remarkable'],
  [4, 'Classified / Exotic'], [5, 'Covert / Extraordinary'], [6, '★ Knives & gloves'], [7, 'Contraband']];
export const SORTS = [['new', 'Newest'], ['plow', 'Price: low to high'], ['phigh', 'Price: high to low'], ['disc', 'Biggest discount'], ['flow', 'Float: low to high'], ['fhigh', 'Float: high to low']];
export const CATALOG_SORTS = [['listed', 'Most listed'], ['plow', 'Price: low to high'], ['phigh', 'Price: high to low'], ['name', 'Name']];
const variantOf = (item) => (item.sv ? 'sv' : item.stt ? 'st' : 'n');
// The catalog entry an item is a copy of: a skin by its wear and whether it's StatTrak™ or Souvenir (Skinport's and the Steam
// Market's items), anything else by what it is.
export function catalogKey(item) {
  if (item.t === 'skin') {
    const d = I.itemDef(item);
    return `skin:${item.id}:${d?.v || item.fl == null ? 'V' : wearOf(item.fl)}:${variantOf(item)}`;
  }
  if (item.t === 'charm' && item.id === 'slab') return `charm:slab:${item.sk}`;
  return `${item.t}:${item.id}`;
}
const plain = (s) => String(s || '').toLowerCase().replace(/[™★|()"]/g, ' ').replace(/\s+/g, ' ').trim();
const tokens = (q) => plain(q).split(' ').filter(Boolean);
const matches = (hay, toks) => toks.every((t) => hay.includes(t));

// ---- the catalog: every item in the game ----------------------------------------------------------------------------------
// [{ key, t, id, w (wear key, 'V' for a vanilla knife, null), v ('n' | 'st' | 'sv'), sk (a slab's sticker), cat, rank, n (name),
// s (what a search matches) }], every skin in every wear it comes in and its StatTrak™ and Souvenir versions, every sticker,
// agent, charm, case, capsule, package, key and tool. Made once per game data.
let catalogMemo = null;
export function catalog() {
  if (catalogMemo?.lock === D.lock) return catalogMemo.list;
  const list = [], byKey = new Map();
  const add = (e) => { if (!byKey.has(e.key)) { byKey.set(e.key, e); list.push(e); } };
  for (const s of Object.values(D.skins)) {
    // (every wear its float range reaches, priced or not: a copy can be in one the price list doesn't have)
    const wears = s.v ? ['V'] : WEARS.filter((w) => (w.min < s.mx && w.max > s.mn) || s.p?.[w.k]).map((w) => w.k);
    const variants = ['n', ...(s.stt && s.cat !== 'gloves' ? ['st'] : []), ...(s.svp && !s.v ? ['sv'] : [])];
    for (const w of wears) for (const v of variants) {
      const item = { t: 'skin', id: s.id, stt: v === 'st', sv: v === 'sv' };
      const name = I.itemName(item) + (s.ph ? ` (${s.ph})` : '') + (w === 'V' ? '' : ` (${WEAR_BY_KEY[w].n})`);
      const cat = categoryOf(item);
      add({ key: `skin:${s.id}:${w}:${v}`, t: 'skin', id: s.id, w, v, cat, rank: s.star ? 6 : s.r, n: name,
        s: plain(`${name} ${w === 'V' ? '' : w} ${v === 'st' ? 'stattrak st' : v === 'sv' ? 'souvenir' : ''} ${CAT_NAME[cat]} ${s.st || ''}`) });
    }
  }
  const simple = (t, d, cat, rank, extra = '') => add({ key: `${t}:${d.id}`, t, id: d.id, w: null, v: 'n', cat, rank, n: d.n, s: plain(`${d.n} ${CAT_NAME[cat]} ${extra}`) });
  for (const d of Object.values(D.stickers)) simple('sticker', d, 'sticker', d.r || 0, `${d.t || ''} ${d.fx || ''} ${d.ty || ''}`);
  for (const d of Object.values(D.agents)) simple('agent', d, 'agent', d.r || 0, d.team === 'T' ? 'terrorist' : 'counter-terrorist');
  for (const d of Object.values(D.charms)) simple('charm', d, 'charm', d.r || 0);
  // (Only a capsule's pins: every other badge is bound to whoever has it, badges.js.)
  for (const d of Object.values(D.badges || {})) if (d.tr) simple('badge', d, 'pin', d.r || 0, `${d.ty || ''} badge collectible`);
  for (const c of D.cases) if (!c.hidden) simple('crate', c, 'container', 0, c.kind);
  for (const [id, k] of Object.entries(D.keys)) simple('key', { ...k, id }, 'more', 0, 'key');
  for (const d of Object.values(I.TOOLS)) simple('tool', d, 'more', 0, 'tool');
  catalogMemo = { lock: D.lock, list, byKey };
  return list;
}
export const catalogEntry = (key) => { catalog(); return catalogMemo.byKey.get(key) || slabEntry(key); };
// A Sticker Slab is made from a sticker, so there's no entry for every one: its entry is made when it's asked for.
function slabEntry(key) {
  const m = /^charm:slab:(.+)$/.exec(String(key));
  const s = m && D.stickers[m[1]];
  if (!s || !D.slab) return null;
  const n = 'Sticker Slab | ' + s.n.replace(/^Sticker \| /, '');
  return { key, t: 'charm', id: 'slab', sk: s.id, w: null, v: 'n', cat: 'charm', rank: s.r || 0, n, s: plain(`${n} charm`) };
}
// An item to show for an entry (its picture and value): a skin in the middle of its wear.
export function entryItem(e) {
  if (e.t !== 'skin') return e.sk ? { t: 'charm', id: 'slab', sk: e.sk, pat: 50000 } : { t: e.t, id: e.id };
  const s = D.skins[e.id], w = WEAR_BY_KEY[e.w];
  const fl = !w || s?.v ? null : Math.max(s.mn, Math.min(s.mx, (Math.max(w.min, s.mn) + Math.min(w.max, s.mx)) / 2));
  return { t: 'skin', id: e.id, fl, sd: null, stt: e.v === 'st', sv: e.v === 'sv', stk: [] };
}
// An entry's reference price: the market price of that item as the game prices it (a copy's float, pattern, stickers and
// serial number move its own).
export function entryRef(e) {
  if (e.t !== 'skin') return I.basePrice(entryItem(e));
  const s = D.skins[e.id];
  if (!s) return 0;
  if (s.v) return (e.v === 'st' ? s.p.V?.[1] : null) ?? s.p.V?.[0] ?? 0;
  const row = s.p[e.w] || Object.values(s.p)[0]; // (a wear without a price of its own: as basePrice prices it)
  if (!row) return 0;
  return e.v === 'sv' ? row[2] ?? row[0] * 1.6 : e.v === 'st' ? row[1] ?? row[0] : row[0];
}

// ---- searching ---------------------------------------------------------------------------------------------------------------
// What a search or a filter reads of a listing, worked out once per listing (again when prices change).
const factsMemo = new WeakMap();
export function factsOf(l) {
  const hit = factsMemo.get(l);
  if (hit && hit.pricedAt === D.pricedAt && hit.price === l.price) return hit.f;
  const it = l.item, ref = referencePrice(it), pat = I.patternInfo(it);
  const f = {
    key: catalogKey(it), cat: categoryOf(it), ref, disc: ref > 0 ? (ref - l.price) / ref : 0, rank: I.rarityRank(it),
    wear: it.t === 'skin' && it.fl != null ? wearOf(it.fl) : null, fl: it.t === 'skin' && it.fl != null ? it.fl : null,
    stt: !!it.stt, sv: !!it.sv, rare: !!pat.label, label: pat.label || '', tier: pat.tier || '',
    s: plain(`${I.realName(it)} ${I.itemDef(it)?.ph || ''} ${it.t === 'skin' && it.fl != null ? wearOf(it.fl) + ' ' + WEAR_BY_KEY[wearOf(it.fl)].n : ''} ${pat.label || ''} ${CAT_NAME[categoryOf(it)]}`),
  };
  factsMemo.set(l, { pricedAt: D.pricedAt, price: l.price, f });
  return f;
}
// A search as a request carries it, checked: { text, cat, key, pmin, pmax, wears, stt, sv, ranks, rare, sort, page }.
export function cleanQuery(a = {}, sorts = SORTS) {
  const num = (v) => { const n = cleanPrice(v); return Number.isFinite(n) && n >= 0 ? n : null; };
  const list = (v, ok) => (Array.isArray(v) ? [...new Set(v.filter(ok))] : []).slice(0, 16);
  const q = {
    text: String(a.text ?? '').slice(0, 80), cat: CAT_NAME[a.cat] ? a.cat : '', key: typeof a.key === 'string' ? a.key.slice(0, 120) : '',
    pmin: num(a.pmin), pmax: num(a.pmax), wears: list(a.wears, (w) => WEAR_KEYS.includes(w)), stt: a.stt === true, sv: a.sv === true,
    ranks: list(a.ranks, (r) => Number.isInteger(r) && r >= 0 && r <= 7), rare: a.rare === true, listed: a.listed === true,
    sort: sorts.some(([k]) => k === a.sort) ? a.sort : sorts[0][0], page: Number.isInteger(a.page) && a.page >= 0 && a.page < 1e5 ? a.page : 0,
  };
  return q;
}
// The part of a search that decides which rows match and their order (not the page): a cache key.
export const queryKey = (q) => JSON.stringify({ ...q, page: 0 });
const byTime = (a, b) => b.at - a.at || String(a.lid).localeCompare(String(b.lid));
const LISTING_SORTS = {
  new: byTime,
  plow: (a, b) => a.price - b.price || byTime(a, b),
  phigh: (a, b) => b.price - a.price || byTime(a, b),
  disc: (a, b) => factsOf(b).disc - factsOf(a).disc || a.price - b.price || byTime(a, b),
  flow: (a, b) => (factsOf(a).fl ?? 2) - (factsOf(b).fl ?? 2) || a.price - b.price || byTime(a, b),
  fhigh: (a, b) => (factsOf(b).fl ?? -1) - (factsOf(a).fl ?? -1) || a.price - b.price || byTime(a, b),
};
// Whether a listing (or catalog entry: `f` its facts) passes the sidebar's filters. (Some exteriors ticked, not all: only items
// with one of them, so not a case, a sticker or a vanilla knife, which have none.)
function passes(f, price, q) {
  if (q.cat && f.cat !== q.cat) return false;
  if (q.pmin != null && price < q.pmin) return false;
  if (q.pmax != null && q.pmax > 0 && price > q.pmax) return false;
  if (q.wears.length && q.wears.length < WEAR_KEYS.length && !(f.wear && q.wears.includes(f.wear))) return false;
  if ((q.stt || q.sv) && !((q.stt && f.stt) || (q.sv && f.sv))) return false;
  if (q.ranks.length && !q.ranks.includes(f.rank)) return false;
  return true;
}
// The listings a search finds, in its order (all of them, not a page). list: [{ lid, item, price, at, seller }].
export function findListings(list, q) {
  const toks = tokens(q.text);
  const out = list.filter((l) => {
    const f = factsOf(l);
    if (q.key && f.key !== q.key) return false;
    if (q.rare && !f.rare) return false;
    if (toks.length && !matches(f.s, toks)) return false;
    return passes(f, l.price, q);
  });
  return out.sort(LISTING_SORTS[q.sort] || LISTING_SORTS.new);
}
export function pageOf(rows, page, per = PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(rows.length / per)), p = Math.min(Math.max(0, page | 0), pages - 1);
  return { rows: rows.slice(p * per, (p + 1) * per), total: rows.length, page: p, pages };
}
// How many listings each catalog entry has and the lowest price: Map key -> { n, min }.
export function listingCounts(list) {
  const out = new Map();
  for (const l of list) {
    const k = factsOf(l).key, c = out.get(k);
    if (!c) out.set(k, { n: 1, min: l.price });
    else { c.n++; if (l.price < c.min) c.min = l.price; }
  }
  return out;
}
// The catalog in each of its searches' orders, worked out once per price list (by name once per game data), so a search only
// goes through one in order and sorts the few entries that have listings: { ref (each entry's reference price, by its place in
// catalog()), rank (its place by name), facts (what the sidebar's filters read), at (key -> place), name, up, down (places in
// order: by name, by reference price low to high and high to low, a tie by name) }. Sorting all of it on every search took a
// fifth of a second or more, on the server's one thread.
let orderMemo = null;
function orders() {
  const list = catalog(), o = orderMemo;
  if (o?.lock === D.lock && o.pricedAt === D.pricedAt && o.list === list) return o;
  const n = list.length, ref = new Float64Array(n), places = () => Array.from({ length: n }, (_, i) => i);
  for (let i = 0; i < n; i++) ref[i] = entryRef(list[i]);
  let { name, rank, facts, at } = o?.list === list ? o : {};
  if (!name) {
    const coll = new Intl.Collator(); // (as String.localeCompare; the sort keeps equal names in the catalog's order)
    name = places().sort((a, b) => coll.compare(list[a].n, list[b].n));
    rank = new Int32Array(n);
    name.forEach((i, k) => { rank[i] = k; });
    facts = list.map((e) => ({ cat: e.cat, wear: e.w && e.w !== 'V' ? e.w : null, stt: e.v === 'st', sv: e.v === 'sv', rank: e.rank }));
    at = new Map(list.map((e, i) => [e.key, i]));
  }
  const up = places().sort((a, b) => ref[a] - ref[b] || rank[a] - rank[b]);
  const down = places().sort((a, b) => ref[b] - ref[a] || rank[a] - rank[b]);
  orderMemo = { lock: D.lock, pricedAt: D.pricedAt, list, ref, rank, facts, at, name, up, down };
  return orderMemo;
}
// (made ahead, as the catalog is: the server a moment after it starts, the Market page as it opens)
export const warmCatalog = () => { orders(); };
// listingCounts' answer by catalog place: { has, num, min, idx (the places that have listings) }, made once per answer.
const atMemo = new WeakMap();
function countsAt(o, counts) {
  let c = atMemo.get(counts);
  if (c?.o === o) return c;
  const n = o.list.length;
  c = { o, has: new Uint8Array(n), num: new Int32Array(n), min: new Float64Array(n), idx: [] };
  for (const [key, x] of counts) {
    const i = o.at.get(key);
    if (i == null || c.has[i]) continue;
    c.has[i] = 1; c.num[i] = x.n; c.min[i] = x.min; c.idx.push(i);
  }
  atMemo.set(counts, c);
  return c;
}
// The catalog places a search's text and filters find when each entry is priced at its reference price, in one of the orders
// made ahead: kept for the searches asked again (paging through one, or the same one after the listings changed: what's listed
// doesn't change them), the least lately asked going first past BASE_MAX places in all.
const baseMemo = new Map(), BASE_MAX = 500000;
let baseSize = 0;
function baseOf(o, q, order, toks) {
  const key = JSON.stringify([order, q.text, q.cat, q.pmin, q.pmax, q.wears, q.stt, q.sv, q.ranks]);
  const hit = baseMemo.get(key);
  if (hit) baseMemo.delete(key);
  if (hit?.o === o) { baseMemo.set(key, hit); return hit.rows; }
  if (hit) baseSize -= hit.rows.length;
  const src = o[order], buf = new Int32Array(src.length);
  let n = 0;
  for (const i of src) if ((!toks.length || matches(o.list[i].s, toks)) && passes(o.facts[i], o.ref[i], q)) buf[n++] = i;
  const rows = buf.slice(0, n);
  baseMemo.set(key, { o, rows });
  baseSize += n;
  for (const [k, v] of baseMemo) { if (baseSize <= BASE_MAX || k === key) break; baseMemo.delete(k); baseSize -= v.rows.length; }
  return rows;
}
// Catalog entries a search finds (every item in the game, listed or not), in its order. counts: listingCounts'. The price
// filter goes by the lowest listing, or the reference price of an entry with none. Most listed: by how many, then the cheapest,
// then as the rest (by reference price, high to low); a price order: by that price; a tie by name. (The entries with listings
// are the few sorted here; the rest are in an order made ahead.)
export function findCatalog(counts, q) {
  const o = orders(), list = o.list, ref = o.ref, rank = o.rank, toks = tokens(q.text), c = countsAt(o, counts), has = c.has, min = c.min, num = c.num;
  const ok = (i, price) => (!toks.length || matches(list[i].s, toks)) && passes(o.facts[i], price, q);
  if (q.key) { const i = o.at.get(q.key); return i != null && (has[i] || !q.listed) && ok(i, has[i] ? min[i] : ref[i]) ? [list[i]] : []; }
  const sort = ['plow', 'phigh', 'name'].includes(q.sort) ? q.sort : 'listed';
  const listed = c.idx.filter((i) => ok(i, min[i]));
  listed.sort(sort === 'plow' ? (a, b) => min[a] - min[b] || rank[a] - rank[b]
    : sort === 'phigh' ? (a, b) => min[b] - min[a] || rank[a] - rank[b]
      : sort === 'name' ? (a, b) => rank[a] - rank[b]
        : (a, b) => num[b] - num[a] || min[a] - min[b] || ref[b] - ref[a] || rank[a] - rank[b]);
  if (q.listed) return listed.map((i) => list[i]);
  const rest = [];
  for (const i of baseOf(o, q, sort === 'plow' ? 'up' : sort === 'name' ? 'name' : 'down', toks)) if (!has[i]) rest.push(i);
  if (sort === 'listed') return [...listed, ...rest].map((i) => list[i]);
  // (the two merged: each entry by its own price, or by name)
  const out = new Array(listed.length + rest.length);
  for (let a = 0, b = 0, k = 0; k < out.length; k++) {
    let first;
    if (b >= rest.length) first = true;
    else if (a >= listed.length) first = false;
    else {
      const x = listed[a], y = rest[b], d = sort === 'plow' ? min[x] - ref[y] : sort === 'phigh' ? ref[y] - min[x] : 0;
      first = d < 0 || (d === 0 && rank[x] < rank[y]);
    }
    out[k] = list[first ? listed[a++] : rest[b++]];
  }
  return out;
}
// A catalog row as a page needs it: { key, n (listings), min (lowest price, null with none) }.
export const catalogRow = (counts, e) => ({ key: e.key, n: counts.get(e.key)?.n || 0, min: counts.get(e.key)?.min ?? null });

// ---- offline: the NPC traders' listings -----------------------------------------------------------------------------------
// Some of what the traders own is on the market at any time: each item, in each 4-hour stretch, comes up for sale or not by a
// throw of the save's dice, at a moment in it, and stays up until the end of the next (4 to 8 hours), at a price that is that
// trader's own (players a little over market, collectors well over it for their kind of item, beginners by their guess of its
// plain price: now and then a real bargain). Nothing is stored: who lists what comes from the seed, the clock and what they own
// now, so whatever they've bought or sold since is what they list. The sellers are the first 600 of the crowd and every
// active one (worked out as they're needed: npcs.js keeps what they own for the session).
export const EPOCH_MS = 4 * 3600 * 1000;
const SELLERS = 600;
export const epochOf = (now) => Math.floor(now / EPOCH_MS);
const sellerMemo = new Map();
export function npcSellers(seed) {
  if (!sellerMemo.has(seed)) {
    const all = N.crowd(seed), first = all.slice(0, SELLERS);
    sellerMemo.set(seed, [...first, ...N.activeCrowd(seed).filter((n) => +n.id.slice(1) >= SELLERS)]);
  }
  return sellerMemo.get(seed);
}
// An item's own fingerprint among an inventory's (its rolls, not its uid: a trader's inventory is made again with new uids the
// first time you deal with them). Two copies alike are told apart by which comes first.
const fingerprint = (it) => [it.t, it.id, it.fl ?? '', it.sd ?? '', it.pat ?? '', it.sk ?? '', it.sn ?? '', it.stt ? 1 : 0, it.sv ? 1 : 0, (it.stk || []).map((s) => s.id).join('.')].join(':');
export function fids(inv) {
  const seen = new Map();
  return inv.map((it) => {
    const fp = fingerprint(it), k = seen.get(fp) || 0;
    seen.set(fp, k + 1);
    return hashStr(fp).toString(36) + (k ? '-' + k : '');
  });
}
const listChance = (n) => (n.active ? 0.12 : 0.035);
// What a trader asks for one of their items (x: a throw 0..1): never under market but by a beginner's mistake.
function npcAsk(n, it, x) {
  const ref = referencePrice(it);
  if (!(ref >= MIN_PRICE) || I.isUnit(it) || I.isBound(it)) return null;
  let p;
  if (n.type === 'beginner') p = N.guess(n, it) * (0.95 + 0.2 * x);
  else if (n.type === 'collector') p = (N.FOCUS[n.focus].fit(it) > 0 ? N.keepValue(n, it) : ref * 1.02) * (1 + 0.1 * x);
  else p = ref * (1 + 0.15 * x);
  p = Math.min(N.nice(p), ref * MAX_MARKUP, MAX_PRICE);
  return Math.max(MIN_PRICE, round2(p));
}
// One trader's listing of one of their items in one stretch, or null (not listed then, or not yet, or no longer).
function npcListingOf(seed, n, it, fid, e, now) {
  const r = mulberry32(hashStr(`p2p:${seed}:${n.id}:${fid}:${e}`));
  if (r() >= listChance(n)) return null;
  const at = e * EPOCH_MS + Math.floor(r() * EPOCH_MS);
  if (at > now || now >= (e + 2) * EPOCH_MS) return null;
  const price = npcAsk(n, it, r());
  return price == null ? null : { lid: `npc:${n.id}:${fid}:${e}`, item: it, price, at, seller: { npc: n.id, name: n.name, type: n.type } };
}
// A trader's listings now: [listing]. (Their inventory as it is now; a blocked trader lists nothing.)
const npcMemo = new WeakMap(); // inventory -> { e, fid: [], cands: [[i, e]] }
export function npcListings(so, n, now = Date.now()) {
  if (!so || N.isBlocked(so, n.id, now)) return [];
  const inv = N.inventoryOf(so, n), e = epochOf(now);
  let m = npcMemo.get(inv);
  if (!m || m.e !== e || m.seed !== so.seed || m.len !== inv.length) {
    const ids = fids(inv), cands = [];
    for (let i = 0; i < inv.length; i++) {
      for (const k of [e - 1, e]) {
        const r = mulberry32(hashStr(`p2p:${so.seed}:${n.id}:${ids[i]}:${k}`));
        if (r() < listChance(n)) { cands.push([i, k]); break; } // (listed in the stretch before: still up, its own price)
      }
    }
    m = { e, seed: so.seed, len: inv.length, ids, cands };
    npcMemo.set(inv, m);
  }
  const out = [];
  for (const [i, k] of m.cands) {
    const l = npcListingOf(so.seed, n, inv[i], m.ids[i], k, now) || (k === e - 1 ? npcListingOf(so.seed, n, inv[i], m.ids[i], e, now) : null);
    if (l) out.push(l);
  }
  return out;
}
// Every trader's listings now (it works out what each of them owns the first time: see the page, which does it bit by bit).
export function allNpcListings(so, now = Date.now()) {
  if (!so) return [];
  return npcSellers(so.seed).flatMap((n) => npcListings(so, n, now));
}
// The listing behind an NPC listing's id, if it's still up as it was: { listing, n, fid } or null.
export function npcListingByLid(so, lid, now = Date.now()) {
  const m = /^npc:(n\d+):([a-z0-9-]+):(\d+)$/.exec(String(lid));
  if (!so || !m) return null;
  const n = N.npcOf(so.seed, m[1]);
  if (!n || !npcSellers(so.seed).includes(n) || N.isBlocked(so, n.id, now)) return null;
  const inv = N.inventoryOf(so, n), i = fids(inv).indexOf(m[2]);
  if (i < 0) return null;
  const l = npcListingOf(so.seed, n, inv[i], m[2], +m[3], now);
  return l && l.lid === lid ? { listing: l, n, fid: m[2] } : null;
}

// ---- offline: the actions ---------------------------------------------------------------------------------------------------
const LOG_MAX = 40;
// How often someone looks at each of your listings (a minute's chance), and how far over the plain market price each kind of
// trader goes (buyValue: a collector a lot for their kind of item).
const LOOKS_PER_MIN = 0.1, MAX_LOOKS = 6, AWAY_MAX = 6 * 3600 * 1000;
const offlineOnly = (ctx) => { if (ctx.online) fail('Online, the Market is run by the server', 'online'); };
function logged(st, row) {
  const log = [row, ...(st.p2p?.log || [])].slice(0, LOG_MAX);
  return { ...(st.p2p || {}), log };
}
const trimNpc = (s) => { if (s.inv.length > 60) { s.inv.sort((a, b) => I.itemValue(b) - I.itemValue(a)); s.inv.length = 60; } };
const listedEntry = (st, lid) => listedOf(st).find((x) => x.lid === lid) || fail('That listing is gone', 'gone');

export const P2P_ACTIONS = {
  // Lists one of your items at a price: it leaves the inventory until it sells or you cancel. → { lid, price }
  'p2p.list'(ctx, { uid, price }) {
    offlineOnly(ctx);
    const item = findOwned(ctx, String(uid));
    const why = listRefusal(item);
    if (why) fail(why, 'item');
    const p = cleanPrice(price), bad = priceProblem(p, referencePrice(item));
    if (bad) fail(bad, 'price');
    if (listedOf(ctx.st).length >= MAX_LISTINGS) fail(`You have ${MAX_LISTINGS} listings. Cancel one first.`, 'limit');
    take(ctx, [item.uid]);
    const lid = 'l' + newUid();
    ctx.st.listed = [toListed(item, { lid, price: p, at: ctx.now }), ...listedOf(ctx.st)];
    ctx.dirty.add('listed');
    return { lid, price: p };
  },
  // Takes a listing down: the item comes back (a full inventory too: it was yours all along).
  'p2p.cancel'(ctx, { lid }) {
    offlineOnly(ctx);
    const entry = listedEntry(ctx.st, String(lid));
    ctx.st.listed = listedOf(ctx.st).filter((x) => x !== entry);
    ctx.dirty.add('listed');
    const item = fromListed(entry);
    ctx.st.inv.unshift(item);
    ctx.add.push(item);
    return { item };
  },
  'p2p.reprice'(ctx, { lid, price }) {
    offlineOnly(ctx);
    const entry = listedEntry(ctx.st, String(lid));
    const p = cleanPrice(price), bad = priceProblem(p, referencePrice(entry));
    if (bad) fail(bad, 'price');
    ctx.st.listed = listedOf(ctx.st).map((x) => (x === entry ? { ...x, lp: p } : x));
    ctx.dirty.add('listed');
    return { lid: entry.lid, price: p };
  },
  // Buys an NPC trader's listing (price: what you saw; a listing that changed meanwhile is refused). → { item, price, seller }
  'p2p.buy'(ctx, { lid, price = null }) {
    offlineOnly(ctx);
    const found = npcListingByLid(ctx.st.social, String(lid), ctx.now) || fail('That listing is no longer for sale', 'gone');
    const l = found.listing;
    if (price != null && cleanPrice(price) !== l.price) fail(`The price changed to ${usd(l.price)}`, 'price');
    if (ctx.st.money + 1e-9 < l.price) fail('Not enough money', 'funds');
    if (Number.isFinite(ctx.invCap) && I.capCount(ctx.st.inv) + 1 > ctx.invCap) fail(`Inventory full (${ctx.invCap} items, not counting badges that can't be traded). Sell something first.`, 'full');
    const so = structuredClone(ctx.st.social), s = N.npcState(so, found.n.id);
    const i = fids(s.inv).indexOf(found.fid);
    if (i < 0) fail('That listing is no longer for sale', 'gone');
    const [got] = s.inv.splice(i, 1);
    s.money = round2(s.money + l.price);
    s.trades = (s.trades || 0) + 1;
    spend(ctx, l.price);
    const item = { ...got, at: ctx.now, nw: true };
    give(ctx, [item]);
    ctx.st.social = so;
    ctx.dirty.add('social');
    ctx.st.p2p = logged(ctx.st, { at: ctx.now, kind: 'bought', name: marketName(item), price: l.price, who: found.n.name, npc: found.n.id });
    ctx.dirty.add('p2p');
    return { item, price: l.price, seller: found.n.name };
  },
  // Time passing for your listings: the active traders look at them, and buy what's worth it to them at the price (as they'd
  // pay in a trade: buyValue), with the money they have. Not a blocked one, and nobody with the admin panel's "Market buyers"
  // rule off. → { sold: [{ lid, name, price, got (what you were paid), npc, who }] }
  'p2p.tick'(ctx) {
    offlineOnly(ctx);
    const st = ctx.st, now = ctx.now, r = ctx.rng, since = st.p2p?.at;
    repairListed(st);
    const out = { sold: [] };
    const listed = listedOf(st);
    if (!listed.length) return out;
    st.p2p = { ...(st.p2p || {}), at: now };
    ctx.dirty.add('p2p');
    const so0 = st.social;
    if (!so0 || !N.ruleOn(so0, 'market')) return out;
    const people = N.activeCrowd(so0.seed).filter((n) => !N.isBlocked(so0, n.id, now));
    if (!people.length) return out;
    const cash = new Map(), moneyOf = (n) => { if (!cash.has(n.id)) cash.set(n.id, (so0.npcs[n.id] || N.startingState(so0.seed, n)).money); return cash.get(n.id); };
    const sales = [];
    for (const l of listed) {
      const mins = clamp(now - Math.max(since ?? l.lat, l.lat || 0), 0, AWAY_MAX) / 60000, x = mins * LOOKS_PER_MIN;
      for (let looks = Math.min(MAX_LOOKS, Math.floor(x) + (r() < x % 1 ? 1 : 0)); looks > 0; looks--) {
        const n = pickWeighted(people.map((p) => [p, N.interest(p, l) + 0.05]), r);
        const most = N.buyValue(n, l) * (0.94 + r() * 0.1);
        if (l.lp <= most && l.lp <= moneyOf(n)) { cash.set(n.id, round2(moneyOf(n) - l.lp)); sales.push([l, n]); break; }
      }
    }
    if (!sales.length) return out;
    const so = structuredClone(so0), gone = new Set();
    let p2p = st.p2p;
    for (const [l, n] of sales) {
      const s = N.npcState(so, n.id), item = fromListed(l), got = sellerGets(l.lp);
      s.money = round2(s.money - l.lp);
      s.inv.push({ ...item, at: now });
      trimNpc(s);
      s.trades = (s.trades || 0) + 1;
      so.feed.unshift({ at: now, npc: n.id, text: `bought ${marketName(item)} from your Market listing for ${usd(l.lp)}` });
      so.feed.length = Math.min(so.feed.length, 40);
      credit(ctx, got);
      gone.add(l.lid);
      p2p = logged({ p2p }, { at: now, kind: 'sold', name: marketName(item), price: l.lp, got, who: n.name, npc: n.id });
      out.sold.push({ lid: l.lid, name: marketName(item), price: l.lp, got, npc: n.id, who: n.name });
    }
    st.listed = listed.filter((l) => !gone.has(l.lid));
    st.p2p = p2p;
    st.social = so;
    ctx.dirty.add('listed');
    ctx.dirty.add('social');
    return out;
  },
};
// The game's actions get these wherever this module is loaded (the game's Market page and the server load it; online they
// refuse, as the server's own requests run the Market there).
Object.assign(ACTIONS, P2P_ACTIONS);
