// Storage Units, as CS2's (item 1201 "casket" in its items_game.txt): a Base Grade tool from the store that can't be traded
// or sold, labelled when you start using it, holding up to 1,000 items you move in and out one at a time or in bulk. An
// empty one can be deleted, for no refund. Other Storage Units can't go inside.
//
// A unit is one item in your inventory (t: 'unit', with `name` and `mod`, when it last changed). What's in it is in
// st.stored, each item with `su` (its unit's uid) and `sat` (when it went in). Stored items aren't in st.inv, so nothing that
// works on the inventory can reach them: every trade, sale, stake, contract, sticker and equip refuses them without
// having to ask. They're still yours, though: ownedItems() is what net worth and the item database read.
// Pure: the client, the server and the admin panels share it. The actions themselves are in actions.js (storage.*).
import * as I from './items.js';
import { round2 } from './util.js';

export const UNIT_CAP = 1000; // CSGO_Tool_Casket_Tag_Desc: "store up to 1,000"
export const UNIT_PRICE = 1.99; // what CS2's store charges, in USD
export const UNIT_NAME_MAX = 20; // (CS2 labels units with its Name Tag window: 20 is that window's limit)
// How many you can own (bought: staff can give more). CS2 stops you at some number too ("You already own too many Storage
// Units"); it doesn't say which. 100 full units are 100,000 items: anything that shows units goes through all of what's
// stored once (unitTotals, unitCounts), never once for each unit.
export const MAX_UNITS = 100;

export const storedOf = (st) => st.stored || [];
// What's listed on the Market (engine/p2p.js): out of the inventory until it sells or the listing is cancelled, but still yours.
export const listedOf = (st) => (Array.isArray(st.listed) ? st.listed : []);
// Everything a player owns: the inventory, what's in their units and what they have listed on the Market.
export const ownedItems = (st) => [...(st.inv || []), ...storedOf(st), ...listedOf(st)];
export const ownedValue = (st) => round2(ownedItems(st).reduce((s, it) => s + I.itemValue(it), 0));
export const unitsOf = (st) => (st.inv || []).filter(I.isUnit);
export const contents = (st, unit) => storedOf(st).filter((it) => it.su === unit);
export const storedItem = (st, uid) => storedOf(st).find((it) => it.uid === uid) || null;
export const unitCount = (st, unit) => { let n = 0; for (const it of storedOf(st)) if (it.su === unit) n++; return n; };
export const unitValue = (st, unit) => round2(contents(st, unit).reduce((s, it) => s + I.itemValue(it), 0));
// Every unit's count (unitCounts) or count and value (unitTotals) from one pass over what's stored, by unit uid: what a list
// of units reads, as unitCount and unitValue each go through all of it. The same numbers as theirs (values added up in the
// same order); a unit with nothing in it isn't in the Map.
export function unitCounts(st) {
  const out = new Map();
  for (const it of storedOf(st)) out.set(it.su, (out.get(it.su) || 0) + 1);
  return out;
}
export function unitTotals(st) {
  const out = new Map();
  for (const it of storedOf(st)) {
    let s = out.get(it.su);
    if (!s) out.set(it.su, (s = { n: 0, value: 0 }));
    s.n++;
    s.value += I.itemValue(it);
  }
  for (const s of out.values()) s.value = round2(s.value);
  return out;
}

// A label as a unit keeps it: plain text with none of the characters a save file loses (see admin.js saveFile).
export const cleanName = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replaceAll('"', "'").trim().slice(0, UNIT_NAME_MAX).trim();

// Why an item can't go into a unit ('' if it can). CS2 also keeps out default weapons (not inventory items here), and Service
// Medals, coins and trophies: so here every badge but a capsule's pin (a bound one, items.isBound).
export const storeRefusal = (item) => (I.isUnit(item) ? "Storage Units can't go inside other Storage Units"
  : I.isBound(item) ? `${I.itemName(item)} can't go into a Storage Unit (only pins from capsules can)` : '');

// The rarities a unit's contents filter by (ranks: see items.rarityRank), and how they're ordered.
export const RANK_FILTERS = [['all', 'All rarities'], ['0', 'Consumer / Default'], ['1', 'Industrial / Base Grade'], ['2', 'Mil-Spec / High Grade'],
  ['3', 'Restricted / Remarkable'], ['4', 'Classified / Exotic'], ['5', 'Covert / Extraordinary'], ['6', '★ Knives & gloves']];
export const SORT_NAMES = [['new', 'Newest stored'], ['old', 'Oldest stored'], ['vdesc', 'Value: high → low'], ['vasc', 'Value: low → high'], ['quality', 'Quality'], ['float', 'Float: low → high'], ['name', 'Name']];
const stamp = (it) => it.sat ?? it.at ?? 0;
const SORTS = {
  new: (a, b) => stamp(b) - stamp(a),
  old: (a, b) => stamp(a) - stamp(b),
  vdesc: (a, b) => I.itemValue(b) - I.itemValue(a),
  vasc: (a, b) => I.itemValue(a) - I.itemValue(b),
  quality: (a, b) => I.rarityRank(b) - I.rarityRank(a) || (b.stt || b.sv ? 1 : 0) - (a.stt || a.sv ? 1 : 0) || I.itemValue(b) - I.itemValue(a),
  float: (a, b) => (a.fl ?? 2) - (b.fl ?? 2),
  name: (a, b) => I.itemName(a).localeCompare(I.itemName(b)),
};
// Items as a unit's contents view shows them: search, a rarity and an order. (A copy: the list given stays as it was.)
export function viewItems(items, { q = '', rank = 'all', sort = 'new' } = {}) {
  const text = String(q).trim().toLowerCase();
  return items.filter((it) => (rank === 'all' || String(I.rarityRank(it)) === String(rank)) && (!text || I.itemName(it).toLowerCase().includes(text)))
    .sort(SORTS[sort] || SORTS.new);
}

// Puts a save's storage right as it loads. Older saves have none and get an empty list; a stored item that's also in the
// inventory stays in the inventory, and one whose unit is gone (or is over a unit's limit, or is itself a unit) goes back
// there rather than being lost. Equipped slots can't point inside a unit. Returns how many items went back.
export function repairStorage(st) {
  const raw = Array.isArray(st.stored) ? st.stored : [];
  const units = new Set(st.inv.filter(I.isUnit).map((it) => it.uid)), seen = new Set(st.inv.map((it) => it.uid));
  const kept = [], back = [], counts = new Map();
  for (const it of raw) {
    if (!it || typeof it !== 'object' || seen.has(it.uid)) continue;
    seen.add(it.uid);
    const n = counts.get(it.su) || 0;
    if (units.has(it.su) && n < UNIT_CAP && !I.isUnit(it)) { counts.set(it.su, n + 1); kept.push(it); }
    else { const { su: _su, sat: _sat, ...item } = it; back.push(item); }
  }
  st.stored = kept;
  if (back.length) st.inv = [...back, ...st.inv];
  for (const it of st.inv) if (I.isUnit(it) && it.name != null) { const name = cleanName(it.name); if (name) it.name = name; else delete it.name; }
  if (kept.length && st.loadout) {
    const inside = new Set(kept.map((it) => it.uid));
    st.loadout = Object.fromEntries(Object.entries(st.loadout).filter(([, u]) => !inside.has(u)));
  }
  return back.length;
}
