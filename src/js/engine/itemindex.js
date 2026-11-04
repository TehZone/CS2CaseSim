// The Index: a lasting record of everything you've unboxed, and the rewards for finishing a case or collection with it.
//
// What counts as unboxed: an item that came out of a box you opened or a drop you earned. That's cases, souvenir packages,
// packages, capsules, the Agent Locker, Armory redemptions, what you took home from a case battle, and the skins you pick
// from a level-up reward. The rule is simple because it's only ever applied in one place: the actions that make those items
// call noteUnboxed (actions.js), and nothing else writes to the record. So an item from the Market, a trade, a stake you
// won or a Trade Up Contract can't count, however it reached you. (A contract's inputs can be bought, so counting its
// result would let money finish a set. The game's serial numbers draw the same line.)
//
// st.index = {
//   items: { <item id>: entry },   one small entry per item, however many times you've unboxed it, so it grows with what's
//                                  distinct (at most every item in the game), not with how many cases you open
//   claimed: { <goal key>: when },
//   filled: true,                  (older saves are filled in once as they load: backfillIndex)
//   lost: n,                       unboxings from before the record that no copy or counter could be matched to
// }
// entry = { at: first unboxed (none: before the record), n: how many, st: of those StatTrak™, sv: Souvenir, fl: lowest float,
//           pt: the best special pattern, as a seed or a charm's number }; a field that would be 0 or empty isn't written.
//
// Pure: the client, the server and the admin panels share it. The action is in actions.js (index.claim). The record leaves
// the server as a small change (ctx.ix, delta's `ix`): sent whole it would be the biggest part of every case opened.
import { D, caseTiers, collectionBox, charmBox } from './data.js';
import * as I from './items.js';
import { CARE_SRC } from './levels.js';
import { ownedItems } from './storage.js';

const RECORDED = new Set(['skin', 'sticker', 'agent', 'charm']); // (the kinds of item boxes hold: not cases, keys or tools)
const ENTRY_FIELDS = new Set(['at', 'n', 'st', 'sv', 'fl', 'pt']);
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

export const freshIndex = () => ({ items: {}, claimed: {}, filled: true, lost: 0 });
// As a save loads. A save from before the Index is marked to be filled in; the rest is checked by saveFile, not here (this
// runs on every load, and on what the server sends).
export function upgradeIndex(saved) {
  if (!isObj(saved)) return { ...freshIndex(), filled: false };
  return { ...freshIndex(), ...saved, items: isObj(saved.items) ? saved.items : {}, claimed: isObj(saved.claimed) ? saved.claimed : {}, filled: !!saved.filled };
}

// The kind of an item by its id (ids are unique across kinds), null if the game doesn't have it.
export function kindOf(id) {
  if (Object.hasOwn(D.skins, id)) return 'skin';
  if (Object.hasOwn(D.stickers, id)) return 'sticker';
  if (Object.hasOwn(D.agents, id)) return 'agent';
  return Object.hasOwn(D.charms, id) ? 'charm' : null;
}

// ---- sets and goals -----------------------------------------------------------------------------------------------------
// A set is something the Index lists: every case, package and capsule, every collection, every charm collection.
//   { id, n, kind, img, custom, tiers: [[rarity, ids]] rarest first, ids: what finishing it takes, rare: its rare specials,
//     goal, rareGoal }
// A goal is what's claimed, and sets with the same contents share one: a collection and its case are the same items, and up
// to 19 souvenir packages (one per Major) can hold the same collection. Each had its own reward, finishing one would pay
// many times over. An item counts wherever it appears, in any version.
//   { key, n, face (the set it's shown as), kind: 'set' | 'rare', ids, opens, reward: { xp, stars }, sets: [set ids] }
//
// What "finished" means: every item in the set but its rare specials. A case's knives and gloves are a 0.26% roll spread over
// as many as 65 items, so asking for them all would mean nobody ever finishes one; instead the first you find from a pool pays
// a bonus of its own (a 'rare' goal: any one will do). Many cases share a pool, so that's one bonus per pool too.
//
// The reward goes by how hard the set is, in openings (expectedOpens) and never by price: prices move, and rewards can't.
// It's XP and Armory Stars, not money or sellable items: money comes from matches only, and a case as a reward would just be
// its price in cash (over $100 for the oldest). Each goal pays once, so what a save can ever earn from the Index is a fixed
// amount, and stays far below what finishing the sets costs.
export const GRADES = [ // [fewer expected openings than, XP, Armory Stars]
  [30, 500, 0], // a 5-sticker team capsule
  [120, 1000, 2], // a small capsule
  [600, 5000, 12], // every weapon case
  [2500, 10000, 25],
  [10000, 20000, 50], // the Agent Locker, the big map collections
  [Infinity, 40000, 100], // the 320-sticker autograph capsules
];
export const RARE_REWARD = { xp: 5000, stars: 10 };
export const rewardFor = (opens) => { const [, xp, stars] = GRADES.find(([top]) => opens < top); return { xp, stars }; };

const harmonic = (n) => { let h = 0; for (let i = 1; i <= n; i++) h += 1 / i; return h; };
// About how many openings it takes to get every item but the rare specials. The hardest rarity decides it: n items sharing a
// chance p take n·H(n)/p openings (the coupon collector). The exact figure runs a little higher when two rarities are about
// as hard, but this is only for grading a set, and the grades are far wider than that.
export function expectedOpens(box) {
  const tiers = caseTiers(box), total = tiers.reduce((s, [, w]) => s + w, 0);
  return Math.ceil(Math.max(...tiers.filter(([k]) => k !== 'rare').map(([k, w]) => {
    const n = box.pools[k].length;
    return (n * harmonic(n) * total) / w;
  })));
}

const tiersOf = (box) => caseTiers(box).filter(([k]) => k !== 'rare').map(([k, w]) => [Number(k), box.pools[k], w]).sort((a, b) => b[0] - a[0]).map(([k, ids]) => [k, ids]);
function makeSet(id, n, kind, img, box, custom = false) {
  const tiers = tiersOf(box);
  return { id, n, kind, img, custom, tiers, ids: [...new Set(tiers.flatMap(([, ids]) => ids))], rare: [...new Set((box.rare || []).flat())], opens: expectedOpens(box), goal: '', rareGoal: null };
}

// Sets with the same items under one goal: a collection's key if one of them is a collection (their ids don't change when a
// package is added to the data), else the lowest of theirs. `ids` picks what's compared.
function group(sets, ids, make) {
  const groups = new Map();
  for (const s of sets) {
    if (!ids(s).length) continue;
    const content = [...ids(s)].sort().join();
    if (!groups.has(content)) groups.set(content, []);
    groups.get(content).push(s);
  }
  return [...groups.values()].map((list) => {
    const lead = list.find((s) => s.kind === 'collection' || s.kind === 'charms') || [...list].sort((a, b) => a.id.localeCompare(b.id))[0];
    return make(lead, list);
  });
}

let cache = null;
function tables() {
  if (cache?.data === D.generatedAt) return cache;
  const sets = D.cases.map((c) => makeSet(c.id, c.n, c.kind, c.img, c, c.custom));
  // A collection with a case is what that case holds (the Huntsman Collection lists five skins no box drops); the others
  // drop from the Armory. Charm collections too.
  for (const col of D.collections) sets.push(makeSet(col.id, col.n, 'collection', col.img, col.caseId ? { ...D.caseById[col.caseId], rare: null } : collectionBox(col)));
  for (const col of D.charmCollections || []) sets.push(makeSet(col.id, col.n, 'charms', col.img, charmBox(col)));
  const goals = new Map();
  for (const g of group(sets, (s) => s.ids, (lead, list) => {
    const opens = Math.min(...list.map((s) => s.opens));
    for (const s of list) s.goal = lead.id;
    // (Its key stays the collection's, but what you opened was the case, so that's what it's called.)
    const face = list.find((s) => s.kind === 'case') || lead;
    return { key: lead.id, n: face.n, face: face.id, kind: 'set', ids: lead.ids, opens, reward: rewardFor(opens), sets: list.map((s) => s.id) };
  })) goals.set(g.key, g);
  for (const g of group(sets, (s) => s.rare, (lead, list) => {
    const key = 'rare-' + lead.id;
    for (const s of list) s.rareGoal = key;
    return { key, n: lead.n, face: lead.id, kind: 'rare', ids: lead.rare, opens: 0, reward: RARE_REWARD, sets: list.map((s) => s.id) };
  })) goals.set(g.key, g);
  const setById = new Map(sets.map((s) => [s.id, s]));
  // Item id -> the goals and sets it's part of.
  const byItem = new Map();
  const put = (id, kind, x) => { if (!byItem.has(id)) byItem.set(id, { goals: [], sets: [] }); byItem.get(id)[kind].push(x); };
  for (const g of goals.values()) for (const id of g.ids) put(id, 'goals', g);
  for (const s of sets) for (const id of new Set([...s.ids, ...s.rare])) put(id, 'sets', s);
  return (cache = { data: D.generatedAt, sets, setById, goals, byItem });
}
export const allSets = () => tables().sets;
export const setOf = (id) => tables().setById.get(id) || null;
export const allGoals = () => [...tables().goals.values()];
export const goalOf = (key) => tables().goals.get(key) || null;
export const setsWith = (id) => tables().byItem.get(id)?.sets || [];

const found = (ix, id) => Object.hasOwn(ix.items, id);
export const goalDone = (ix, g) => (g.kind === 'rare' ? g.ids.some((id) => found(ix, id)) : g.ids.every((id) => found(ix, id)));
export const isClaimed = (ix, key) => Object.hasOwn(ix.claimed, key);
// Finished and not claimed yet.
export const waitingGoals = (ix) => allGoals().filter((g) => !isClaimed(ix, g.key) && goalDone(ix, g));
export function progress(ix, set) {
  const count = (ids) => ids.reduce((n, id) => n + (found(ix, id) ? 1 : 0), 0);
  const done = count(set.ids), total = set.ids.length;
  return { done, total, complete: done === total, rareDone: count(set.rare), rareTotal: set.rare.length };
}

// ---- the record ---------------------------------------------------------------------------------------------------------
const shortFloat = (fl) => Number(fl.toPrecision(6)); // (a float's 17 digits, six times over the size of everything else in an entry)
const patternOf = (item) => (item.t === 'charm' ? item.pat : item.sd);
const patternMult = (t, id, pt) => (pt == null ? 1 : I.patternInfo(t === 'charm' ? { t, id, pat: pt } : { t, id, sd: pt }).mult);
function addCopy(e, it, at) {
  const out = { ...e, n: (e?.n || 0) + 1 };
  if (at != null) out.at = out.at == null ? at : Math.min(out.at, at);
  if (it.stt) out.st = (e?.st || 0) + 1;
  if (it.sv) out.sv = (e?.sv || 0) + 1;
  if (it.fl != null) out.fl = Math.min(out.fl ?? 1, shortFloat(it.fl));
  const pt = patternOf(it);
  if (pt != null && patternMult(it.t, it.id, pt) > Math.max(1, patternMult(it.t, it.id, out.pt))) out.pt = pt;
  return out;
}
const recorded = (it) => RECORDED.has(it.t) && it.id !== 'slab' && kindOf(it.id) === it.t; // (a Sticker Slab is made, not unboxed)

// Items unboxed go on the record. The record is replaced, not changed, so an action that fails after this leaves it as it was.
// → the change, as delta sends it: { items: { id: entry }, done: [the goals these items just finished] } (null: nothing to add)
export function record(st, items, now) {
  const ix = st.index, list = items.filter(recorded);
  if (!list.length) return null;
  const changed = {};
  for (const it of list) changed[it.id] = addCopy(changed[it.id] || ix.items[it.id], it, now);
  const next = { ...ix, items: { ...ix.items, ...changed } };
  st.index = next;
  const fresh = Object.keys(changed).filter((id) => !found(ix, id));
  const done = new Set();
  for (const id of fresh) for (const g of tables().byItem.get(id)?.goals || []) if (!isClaimed(next, g.key) && goalDone(next, g)) done.add(g.key);
  return { items: changed, done: [...done] };
}

// A change from the server, on the client's copy.
export const applyChange = (ix, ch) => ({ ...ix, items: { ...ix.items, ...ch.items }, claimed: { ...ix.claimed, ...ch.claimed } });

// A state put back by staff keeps what's on the record now, and what's been claimed: an older snapshot mustn't let a reward
// be claimed a second time.
function mergeEntry(a, b) {
  const least = (x, y) => (x == null ? y : y == null ? x : Math.min(x, y));
  const out = { n: Math.max(a.n || 0, b.n || 0) };
  const at = least(a.at, b.at), fl = least(a.fl, b.fl), st = Math.max(a.st || 0, b.st || 0), sv = Math.max(a.sv || 0, b.sv || 0);
  if (at != null) out.at = at;
  if (st) out.st = st;
  if (sv) out.sv = sv;
  if (fl != null) out.fl = fl;
  const pt = a.pt ?? b.pt;
  if (pt != null) out.pt = pt;
  return out;
}
export function mergeIndex(a, b) {
  const items = { ...a.items };
  for (const [id, e] of Object.entries(b.items)) items[id] = Object.hasOwn(items, id) ? mergeEntry(items[id], e) : e;
  return { ...a, items, claimed: { ...b.claimed, ...a.claimed }, filled: a.filled || b.filled, lost: Math.max(a.lost || 0, b.lost || 0) };
}

// ---- older saves --------------------------------------------------------------------------------------------------------
// Did an item with this `src` come out of a box? Only what the game writes for that does: anything else (the Market, a trade
// with an NPC, a contract, staff) stays out. A case's name is what an unboxed item keeps for good, so online, where a trade
// between players moves an item as it is, `moved` says which of them changed hands.
let boxNames = null;
function fromBox(src) {
  if (boxNames?.data !== D.generatedAt) boxNames = { data: D.generatedAt, names: new Set([...D.cases.map((c) => c.n), CARE_SRC]) };
  return typeof src === 'string' && (boxNames.names.has(src) || src.startsWith('Armory · '));
}
// What can be recovered, once:
// - Every copy you still own (your inventory, your Storage Units, charms on guns) that came from a box: all of its details.
// - Offline, the save's serial counters: how many of each item you've unboxed, as StatTrak™ and Souvenir too, sold or not. Those
//   copies have no date or float any more, and an entry with no `at` shows as from before the Index. (Online the counters are
//   the server's, shared by everyone, so they can't say whose an item was.)
// Not recoverable: which skins a level-up reward gave you if you've since sold them (they have no serial number), and online,
// anything you no longer own. `lost` is the unboxings left over. moved: uids to leave out (see store.mjs, what changed hands).
export function backfillIndex(st, { moved = null } = {}) {
  const ix = st.index;
  if (ix.filled) return;
  const held = {}, items = { ...ix.items };
  for (const owned of ownedItems(st)) {
    if (moved?.has(owned.uid)) continue;
    for (const it of owned.kc ? [owned, I.attachedCharm(owned)] : [owned]) {
      if (recorded(it) && fromBox(it.src)) held[it.id] = addCopy(held[it.id], it, it.at ?? null);
    }
  }
  const counted = {};
  for (const [key, n] of Object.entries(st.serials || {})) {
    const [t, id, version] = key.split(':');
    if (!RECORDED.has(t) || id === 'slab' || kindOf(id) !== t || !(n > 0)) continue;
    const c = (counted[id] ||= { n: 0, st: 0, sv: 0 });
    c.n += n;
    if (version === 'st') c.st += n;
    if (version === 'sv') c.sv += n;
  }
  for (const id of new Set([...Object.keys(held), ...Object.keys(counted)])) {
    const h = held[id] || {}, c = counted[id] || {}, e = { ...h, n: Math.max(h.n || 0, c.n || 0) };
    const st2 = Math.max(h.st || 0, c.st || 0), sv = Math.max(h.sv || 0, c.sv || 0);
    if (st2) e.st = st2;
    if (sv) e.sv = sv;
    items[id] = e;
  }
  const recovered = Object.values(items).reduce((s, e) => s + e.n, 0);
  st.index = { ...ix, items, filled: true, lost: Math.max(0, (st.stats?.opened || 0) + (st.stats?.armory || 0) - recovered) };
}

// ---- what the pages and panels read -------------------------------------------------------------------------------------
export function summary(ix) {
  const entries = Object.values(ix.items);
  return {
    items: entries.length, copies: entries.reduce((s, e) => s + e.n, 0), waiting: waitingGoals(ix).length,
    claimed: Object.keys(ix.claimed).length, goals: allGoals().length, lost: ix.lost || 0,
  };
}
// A record entry as an item the game's name and picture functions take (showing its best: the lowest float, its pattern).
export function entryItem(id, e = {}) {
  const t = kindOf(id);
  return t ? { t, id, ...(e.fl != null ? { fl: e.fl } : {}), ...(e.pt != null ? (t === 'charm' ? { pat: e.pt } : { sd: e.pt }) : {}) } : null;
}
// Every entry of the record, each with what it's searched and sorted by. (Items the game no longer has are left out.)
export function rows(ix) {
  const out = [];
  for (const [id, e] of Object.entries(ix.items)) {
    const item = entryItem(id, e);
    if (!item) continue;
    out.push({ id, e, item, rank: I.rarityRank(item), name: I.itemName({ t: item.t, id }), search: I.itemName({ t: item.t, id }).toLowerCase() });
  }
  return out;
}
export const RECORD_SORTS = [['new', 'Newest first'], ['old', 'Oldest first'], ['rarity', 'Rarity'], ['count', 'Most unboxed'], ['float', 'Lowest float'], ['name', 'Name']];
export const RECORD_TYPES = [['all', 'All items'], ['skin', 'Weapon skins'], ['star', '★ Knives & gloves'], ['sticker', 'Stickers'], ['charm', 'Charms'], ['agent', 'Agents']];
const SORTS = {
  new: (a, b) => (b.e.at || 0) - (a.e.at || 0),
  old: (a, b) => (a.e.at || 0) - (b.e.at || 0),
  rarity: (a, b) => b.rank - a.rank,
  count: (a, b) => b.e.n - a.e.n,
  float: (a, b) => (a.e.fl ?? 2) - (b.e.fl ?? 2),
  name: (a, b) => a.name.localeCompare(b.name),
};
const ofType = (r, type) => type === 'all' || (type === 'star' ? r.rank === 6 && r.item.t === 'skin' : type === 'skin' ? r.item.t === 'skin' && r.rank !== 6 : r.item.t === type);
// The rows a view shows: search, a rarity (ranks as in items.rarityRank), a type and an order. (A copy: `list` stays as it was.)
export function viewRows(list, { q = '', rank = 'all', type = 'all', sort = 'new' } = {}) {
  const text = String(q).trim().toLowerCase();
  return list.filter((r) => (rank === 'all' || String(r.rank) === String(rank)) && ofType(r, type) && (!text || r.search.includes(text)))
    .sort((a, b) => (SORTS[sort] || SORTS.new)(a, b) || a.name.localeCompare(b.name));
}

// Why a save file's Index isn't as the game writes it ('': it is). The text in it has been cleaned already (admin.js saveFile).
export function indexProblem(ix) {
  const token = /^[A-Za-z0-9_-]{1,80}$/;
  const num = (v) => v == null || (Number.isFinite(v) && v >= 0);
  for (const [id, e] of Object.entries(ix.items || {})) {
    if (!token.test(id) || !isObj(e) || !Number.isSafeInteger(e.n) || e.n < 1 || !Object.keys(e).every((k) => ENTRY_FIELDS.has(k))
      || ![e.at, e.st, e.sv, e.fl, e.pt].every(num) || (e.fl != null && e.fl > 1)) return `index.items.${id.slice(0, 40)}`;
  }
  for (const [key, at] of Object.entries(ix.claimed || {})) if (!token.test(key) || !Number.isFinite(at)) return `index.claimed.${key.slice(0, 40)}`;
  return '';
}
