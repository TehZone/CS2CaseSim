// The Armory: spend Armory Stars on items from a rotating set of collections. The rotation changes every 10-15
// minutes. It is computed from the clock alone, so every player (and the server) sees the same armory.
import { D, casePrice, collectionBox, caseTiers } from './data.js';
import { hashStr, seededRng, round2, clamp } from './util.js';

export const ARMORY_EPOCH = Date.UTC(2026, 0, 1);
export const PASS_PRICE = 15.99;
export const PASS_STARS = 40;
export const STAR_VALUE = PASS_PRICE / PASS_STARS; // $0.40 of value per star
export const SPEND_PER_STAR = 25; // opening cases earns 1 star per $25 spent
const FEATURED = 4;
// Collections people chase (the Dragon Lore, Medusa, Gungnir...). One of them is featured in about 40% of rotations.
const ICONIC = ['The Cobblestone Collection', 'The Gods and Monsters Collection', 'The Norse Collection', 'The St. Marc Collection',
  'The Dust Collection', 'The Italy Collection', 'The Militia Collection', 'The Overpass Collection', 'The Dust 2 Collection',
  'The Aztec Collection', 'The 2018 Inferno Collection', 'The Rising Sun Collection'];

export const windowLength = (i) => (600 + (hashStr('armory:' + i) % 301)) * 1000; // 10:00 to 15:00

let anchor = { i: 0, start: ARMORY_EPOCH };
// The rotation window containing `now`: { i, start, end }.
export function armoryWindow(now = Date.now()) {
  let { i, start } = anchor;
  if (now < start) { i = 0; start = ARMORY_EPOCH; }
  while (now >= start + windowLength(i)) { start += windowLength(i); i++; }
  anchor = { i, start };
  return { i, start, end: start + windowLength(i) };
}

// Expected value of a box under its odds, using the item's market price at a typical wear.
function boxEV(box) {
  const tiers = caseTiers(box);
  const tw = tiers.reduce((s, [, w]) => s + w, 0);
  let ev = 0;
  for (const [k, w] of tiers) {
    const ids = k === 'rare' ? box.rare.flat() : box.pools[k];
    const avg = ids.reduce((s, id) => s + typicalPrice(D.skins[id]), 0) / ids.length;
    ev += (w / tw) * avg;
  }
  return ev;
}
function typicalPrice(s) {
  if (!s?.p) return 0;
  if (s.p.V) return s.p.V[0];
  const rows = Object.values(s.p);
  return rows.reduce((t, r) => t + r[0], 0) / rows.length;
}
const starsFor = (value, lo, hi) => clamp(Math.round((value * 1.15) / STAR_VALUE), lo, hi);

const offersCache = new Map();
// The offers of rotation window i: a collection drop per featured collection, one of its souvenir packages when
// one is cheap enough, and a featured weapon case.
export function armoryOffers(i) {
  if (offersCache.has(i)) return offersCache.get(i);
  const r = seededRng('armory-offers:' + i);
  const pool = D.collections.filter((c) => Object.keys(c.tiers).length >= 2);
  const chosen = [];
  const iconic = pool.filter((c) => ICONIC.includes(c.n));
  if (iconic.length && r() < 0.4) chosen.push(iconic[Math.floor(r() * iconic.length)]);
  while (chosen.length < FEATURED && chosen.length < pool.length) {
    const c = pool[Math.floor(r() * pool.length)];
    if (!chosen.includes(c)) chosen.push(c);
  }
  const offers = [];
  for (const col of chosen) {
    offers.push({ id: `${i}:drop:${col.id}`, type: 'drop', col: col.id, stars: starsFor(boxEV(collectionBox(col)), 1, 12) });
    const pkgs = col.packages.map((id) => D.caseById[id]).filter((c) => c && c.price != null && c.price <= 25);
    if (pkgs.length) {
      const pkg = pkgs[Math.floor(r() * pkgs.length)];
      offers.push({ id: `${i}:pkg:${pkg.id}`, type: 'case', box: pkg.id, col: col.id, stars: starsFor(casePrice(pkg), 1, 40) });
    }
  }
  const cases = D.cases.filter((c) => c.kind === 'case' && c.price != null);
  if (cases.length) {
    const c = cases[Math.floor(r() * cases.length)];
    offers.push({ id: `${i}:case:${c.id}`, type: 'case', box: c.id, stars: starsFor(casePrice(c), 1, 40), featured: true });
  }
  const out = { i, collections: chosen.map((c) => c.id), offers };
  offersCache.set(i, out);
  if (offersCache.size > 8) offersCache.delete(offersCache.keys().next().value);
  return out;
}

// Finds an offer that is live now (with a short grace period after a rotation for in-flight requests).
export function findLiveOffer(offerId, now = Date.now()) {
  const w = armoryWindow(now);
  const cur = armoryOffers(w.i).offers.find((o) => o.id === offerId);
  if (cur) return cur;
  if (now - w.start < 30000 && w.i > 0) return armoryOffers(w.i - 1).offers.find((o) => o.id === offerId) || null;
  return null;
}

// The box an offer rolls from.
export function offerBox(o) {
  return o.type === 'drop' ? collectionBox(D.colById[o.col]) : D.caseById[o.box];
}

export const starsFromSpend = (prevSpend, spent) => Math.floor((prevSpend + spent) / SPEND_PER_STAR) - Math.floor(prevSpend / SPEND_PER_STAR);
export const passValue = () => round2(PASS_PRICE);
