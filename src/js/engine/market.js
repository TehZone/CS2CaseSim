// The market: limited stock that restocks every 10 minutes. What is listed and how many come from the clock, so every
// player (and the server) sees the same listings. Cheap items are nearly always in stock; the more an item is worth,
// the less often it is listed and the fewer copies there are. A Dragon Lore or a Ruby knife turns up a few times a
// day; a blue gem or a full fade almost never, because premium patterns and floats rarely make it onto a listing.
// Each listing can be bought once: offline by you, online by anyone on the server.
import { D } from './data.js';
import * as I from './items.js';
import { seededRng, uid } from './util.js';

export const MARKET_WINDOW_MS = 10 * 60 * 1000;
export const MARKET_GRACE_MS = 30 * 1000; // listings from the previous window can still be bought this long after a restock
export const marketWindow = (now = Date.now()) => Math.floor(now / MARKET_WINDOW_MS);
export const windowEnd = (w) => (w + 1) * MARKET_WINDOW_MS;

// [price below, chance the item is listed in a window, most copies listed]
const SCARCITY = [[2, 1, 8], [10, 0.95, 5], [50, 0.7, 3], [200, 0.4, 2], [1000, 0.15, 1], [5000, 0.05, 1], [Infinity, 0.02, 1]];
export function scarcity(price, { star = false, old = false } = {}) {
  const [, chance, max] = SCARCITY.find(([p]) => (price || 0) < p);
  return { chance: chance * (star ? 0.6 : 1) * (old ? 0.6 : 1), max };
}
// Chance that a listing which rolled a premium pattern or float actually keeps it.
export const PREMIUM_KEEP = 0.08;
export function isPremium(item) {
  if (item.t !== 'skin') return false;
  const p = I.patternInfo(item);
  return !!p.tier || p.mult >= 1.2 || I.floatMultiplier(item) >= 1.3;
}

export const lowestPrice = (skin) => (skin.v ? skin.p.V[0] : Math.min(...Object.values(skin.p).map((r) => r[0])));
const OLD_MAJORS = /2014|Katowice 2015|Cologne 2015/;

const cache = new Map(); // window -> { skins: Map(id -> listings), units: Map(kind:id -> count) }
function bucket(w) {
  let b = cache.get(w);
  if (!b) {
    b = { skins: new Map(), units: new Map(), overview: null };
    cache.set(w, b);
    for (const k of [...cache.keys()]) if (k < w - 2 || k > w + 2) cache.delete(k);
  }
  return b;
}

// The concrete listings of a skin in a window: [{ lid, n, item, p }]. Each has its own float and pattern.
export function skinListings(skin, w) {
  const b = bucket(w);
  if (b.skins.has(skin.id)) return b.skins.get(skin.id);
  const r = seededRng(`market:skin:${skin.id}:${w}`);
  const { chance, max } = scarcity(lowestPrice(skin), { star: skin.star });
  const out = [];
  if (r() < chance) {
    const n = 1 + Math.floor(r() * max);
    for (let k = 0; k < n; k++) {
      const stt = !!(skin.stt && skin.cat !== 'gloves' && r() < 0.1);
      let item = I.makeSkinItem(skin, { stt, r, src: 'Market' });
      for (let t = 0; t < 12 && isPremium(item) && r() > PREMIUM_KEEP; t++) item = I.makeSkinItem(skin, { stt, r, src: 'Market' });
      out.push({ lid: `s:${skin.id}:${w}:${k}`, n: k, item, p: I.itemValue(item) });
    }
  }
  b.skins.set(skin.id, out);
  return out;
}

// How many copies of a sticker or agent are listed in a window (they are all the same, at the market price).
export function unitStock(kind, def, w) {
  const b = bucket(w);
  const key = kind + ':' + def.id;
  if (b.units.has(key)) return b.units.get(key);
  let count = 0;
  if (!(kind === 'sticker' && def.so)) { // souvenir-only stickers are never sold
    const r = seededRng(`market:${kind}:${def.id}:${w}`);
    const { chance, max } = scarcity(def.p, { old: kind === 'sticker' && OLD_MAJORS.test(def.t || '') });
    if (r() < chance) count = 1 + Math.floor(r() * max);
  }
  b.units.set(key, count);
  return count;
}
export const unitLid = (kind, id, w, k) => `u:${kind}:${id}:${w}:${k}`;

// Copies left after what has been bought ('sold' is a Set of listing ids, or anything with has()).
export function unitsLeft(kind, def, w, sold) {
  const n = unitStock(kind, def, w);
  let left = 0;
  for (let k = 0; k < n; k++) if (!sold.has(unitLid(kind, def.id, w, k))) left++;
  return left;
}

// A fresh inventory item for a bought skin listing.
export const fromListing = (l) => ({ ...JSON.parse(JSON.stringify(l.item)), uid: uid(), at: Date.now(), src: 'Market' });

// The market's sold listings for a window, for players offline: kept in the save for the last two windows.
export function localSold(st, w) {
  const m = st.market || {};
  const list = m[w] || [];
  return {
    has: (lid) => list.includes(lid),
    add(lid) {
      const next = {};
      for (const [k, v] of Object.entries(m)) if (+k >= w - 1) next[k] = v;
      next[w] = [...list, lid];
      st.market = next;
    },
  };
}
