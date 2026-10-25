// The item database (like CSFloat's): every item in the game, every copy of it players hold, and the float ranks among
// those copies. Pure: the page (pages/database.js) and the server (its db.* requests) share it.

// The kinds of item it covers, as inventory items' t.
export const DB_TYPES = ['skin', 'sticker', 'charm', 'agent', 'pro'];
export const itemKey = (item) => item.t + ':' + item.id;

// A copy's category: float ranks are counted apart for normal, StatTrak™ and Souvenir copies (as CSFloat's are).
export const copyCategory = (item) => (item.sv ? 'sv' : item.stt ? 'st' : 'n');
export const CATEGORY_NAME = { n: 'Normal', st: 'StatTrak™', sv: 'Souvenir' };

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
    list.sort((a, b) => a.fl - b.fl || (a.at || 0) - (b.at || 0) || String(a.uid).localeCompare(String(b.uid)));
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

// What the database shows of a copy (and the server sends): the item without what's only its owner's business.
export function publicCopy(item) {
  const { uid, t, id, fl, sd, stt, sv, stk, kills, sn, at } = item;
  return { uid, t, id, fl, sd, stt, sv, stk, kills, sn, at };
}
