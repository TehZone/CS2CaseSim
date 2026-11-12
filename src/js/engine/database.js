// The item database (like CSFloat's): every item in the game, every copy of it players hold, and the float ranks among
// those copies. Pure: the page (pages/database.js) and the server (its db.* requests) share it.

// The kinds of item it covers, as inventory items' t.
export const DB_TYPES = ['skin', 'sticker', 'charm', 'agent', 'tool', 'badge'];
export const itemKey = (item) => item.t + ':' + item.id;

// A copy's category: float ranks are counted apart for normal, StatTrak™ and Souvenir copies (as CSFloat's are).
export const copyCategory = (item) => (item.sv ? 'sv' : item.stt ? 'st' : 'n');
export const CATEGORY_NAME = { n: 'Normal', st: 'StatTrak™', sv: 'Souvenir' };
// The categories a list of copies filters by: every copy, or one of copyCategory's.
export const COPY_CATS = ['all', 'n', 'st', 'sv'];

// Items with floats, lowest first: equal floats by who had it first (at), then uid, so an order doesn't flip back and
// forth. (db.ranks and db.floats on the server order them the same way.)
export const byFloat = (a, b) => a.fl - b.fl || (a.at || 0) - (b.at || 0) || String(a.uid).localeCompare(String(b.uid));

// The three lowest and three highest floats among the copies of one item, in each category. copies: [{ item }] (items
// with fl). Returns Map uid -> { low?: 1..3, high?: 1..3, of: copies in its category, cat } (a copy can be both when
// there are few; the only copy in its category has none). Equal floats rank by who had it first (at), then uid, so a
// rank doesn't flip back and forth.
export function floatRanks(copies, top = 3, min = 2) {
  const out = new Map(), groups = new Map();
  for (const c of copies) {
    const it = c.item || c;
    if (it.fl == null) continue;
    const k = copyCategory(it);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  for (const [cat, list] of groups) {
    if (list.length < min) continue;
    list.sort(byFloat);
    const of = list.length, rank = (it) => out.get(it.uid) || out.set(it.uid, { of, cat }).get(it.uid);
    for (let i = 0; i < Math.min(top, of); i++) rank(list[i]).low = i + 1;
    for (let i = 0; i < Math.min(top, of); i++) rank(list[of - 1 - i]).high = i + 1;
  }
  return out;
}

// The float ranks of every skin in an inventory (each among its own item's copies): Map uid -> rank (see floatRanks).
export function inventoryRanks(items) {
  const byItem = new Map(), out = new Map();
  for (const it of items) if (it.t === 'skin' && it.fl != null) { const k = itemKey(it); if (!byItem.has(k)) byItem.set(k, []); byItem.get(k).push(it); }
  for (const list of byItem.values()) for (const [uid, r] of floatRanks(list)) out.set(uid, r);
  return out;
}

// How many copies of each item there are: { key: n } over [{ item }] (or items).
export function countCopies(copies) {
  const out = {};
  for (const c of copies) {
    const it = c.item || c;
    if (!DB_TYPES.includes(it.t)) continue;
    const k = itemKey(it);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

// Float records: the copies with the lowest (dir 'low') or highest ('high') floats of any skin, every skin together, in
// one category (COPY_CATS). copies: [{ item }] (or items); what's returned is those same entries, best first. Only what has
// a float counts (skins but vanillas; not stickers, agents and the rest). The highest are the lowest read backwards, ties
// included, as floatRanks' #1 High is its last copy. (Online the server does this over every player: db.floats.)
export const FLOAT_TOP = 100; // (the most a list holds)
export function floatRecords(copies, { dir = 'low', cat = 'all', limit = FLOAT_TOP } = {}) {
  const by = (a, b) => byFloat(a.item || a, b.item || b), cmp = dir === 'high' ? (a, b) => by(b, a) : by;
  // Only the best `limit` so far, best first (not every copy sorted): a copy that can't make it costs one comparison.
  const top = [];
  for (const c of copies) {
    const it = c.item || c;
    if (it.t !== 'skin' || it.fl == null || (cat !== 'all' && copyCategory(it) !== cat)) continue;
    if (top.length >= limit && (!limit || cmp(c, top[top.length - 1]) >= 0)) continue;
    let lo = 0, hi = top.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cmp(c, top[m]) < 0) hi = m; else lo = m + 1; }
    top.splice(lo, 0, c);
    if (top.length > limit) top.pop();
  }
  return top;
}

// How many copies of one item share each pattern (paint seed): Map 'cat:sd' -> n, where cat is 'all' (every copy) or the
// copy's own category. copies: [{ item }] (or items). A copy with no pattern (a vanilla knife, a sticker) isn't counted.
export function patternCounts(copies) {
  const out = new Map();
  const add = (k) => out.set(k, (out.get(k) || 0) + 1);
  for (const c of copies) {
    const it = c.item || c;
    if (it.sd == null) continue;
    add('all:' + it.sd);
    add(copyCategory(it) + ':' + it.sd);
  }
  return out;
}
// How many copies have this item's pattern, among all of them (cat 'all') or one category's: 0 for no pattern.
export const patternCount = (counts, item, cat = 'all') => (item.sd == null ? 0 : counts.get(cat + ':' + item.sd) || 0);

// Copies by pattern number, then by float (byFloat); a copy with no pattern last. Items, not { item }.
export function byPattern(a, b) {
  if ((a.sd == null) !== (b.sd == null)) return a.sd == null ? 1 : -1;
  if (a.sd != null && a.sd !== b.sd) return a.sd - b.sd; // (null and a missing sd are the same: no pattern)
  if ((a.fl == null) !== (b.fl == null)) return a.fl == null ? 1 : -1;
  return a.fl == null ? (a.at || 0) - (b.at || 0) || String(a.uid).localeCompare(String(b.uid)) : byFloat(a, b);
}

// What the database shows of a copy (and the server sends): the item without what's only its owner's business.
export function publicCopy(item) {
  const { uid, t, id, fl, sd, stt, sv, stk, kills, sn, at, name } = item;
  return { uid, t, id, fl, sd, stt, sv, stk, kills, sn, at, name };
}
