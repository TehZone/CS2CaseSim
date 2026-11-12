// lean1's shapes of what an action sends back, and of the welcome's state (see CAPS in server/index.mjs; the game's side is
// src/js/state.js applyDelta and enterOnline, and relink in src/js/net/online.js). Only a connection that announced lean1 is
// sent these: a 1.1.2 game is sent the answer and the changes exactly as delta() makes them. Pure, and nothing here changes
// what it's given (an action's answer holds the player's own items).
//   The answer (r): an item the changes carry in full (d.add or d.upd) is in it as { uid } alone, and the game takes it from
//                   the changes it has just applied. (Auto-sold drops never reach the inventory, so they stay whole.)
//   The changes (d): empty lists left out; the stats as the fields that changed ({ stats: { opened, drops: { 3: 12 } } }, merged
//                   into the game's), not the whole object in `set`; item.seen as the uids it cleared ({ seen: [uid] }), not
//                   the items; a change to what's in Storage Units with the sums of the units it changed, merged into the
//                   game's ({ units: { [unit uid]: { n, value, best? } | null } }: best only when the most valuable item is
//                   another one, or null when the unit is empty now; a unit as null when it's gone). Items moved into a unit
//                   whose contents that game hasn't asked for are left out of d.sto.add (forConnection): it would drop them.
//   The welcome: no state.stored (what's in Storage Units, up to 100,000 items: 100 units), and { units } instead. The game asks for a
//                unit's contents when it needs them (social 'stored', server/index.mjs).
import { itemValue } from '../src/js/engine/items.js';
import { storedOf, unitsOf } from '../src/js/engine/storage.js';
import { round2 } from '../src/js/engine/util.js';

// The stats as they were before an action (a copy: the action changes the live object).
export const statsBefore = (st) => structuredClone(st.stats || {});

// The fields of `after` that differ from `before`, drops by rarity as their own changes: { field: value, drops?: { rank: n } }.
// null when a field went missing, which an action never does: the whole object goes then.
export function statsChange(before, after) {
  const out = {};
  for (const k of Object.keys(before)) if (!(k in after)) return null;
  for (const [k, v] of Object.entries(after)) {
    if (k === 'drops' && v && typeof v === 'object' && before.drops && typeof before.drops === 'object') {
      for (const r of Object.keys(before.drops)) if (!(r in v)) return null;
      const d = {};
      for (const [r, x] of Object.entries(v)) if (before.drops[r] !== x) d[r] = x;
      if (Object.keys(d).length) out.drops = d;
    } else if (v !== null && typeof v === 'object' ? JSON.stringify(v) !== JSON.stringify(before[k]) : v !== before[k]) out[k] = v;
  }
  return out;
}

// Each Storage Unit's count, value and most valuable item (the whole item, as stored): { [unit uid]: { n, value, best } }.
export function unitSums(st) {
  const out = {}, top = {};
  for (const u of unitsOf(st)) { out[u.uid] = { n: 0, value: 0, best: null }; top[u.uid] = -1; }
  for (const it of storedOf(st)) {
    const s = out[it.su];
    if (!s) continue;
    const v = itemValue(it);
    s.n++;
    s.value += v;
    if (v > top[it.su]) { top[it.su] = v; s.best = it; }
  }
  for (const s of Object.values(out)) s.value = round2(s.value);
  return out;
}

// The units' sums as a player's lean1 games were last told them (the welcome's, then each change's), to tell them only what
// changed since: { [unit uid]: { n, value, key } } (key: the most valuable item, as text: the same uid renamed is another).
export const sumsSent = (sums) => Object.fromEntries(Object.entries(sums).map(([uid, s]) => [uid, { n: s.n, value: s.value, key: s.best ? JSON.stringify(s.best) : '' }]));
// What changed from `was` (sumsSent's, or null: nothing told yet, so everything) to `sums` (unitSums'): → { change, sent }.
// change: the units whose sums changed, as d.units has them (best only when it's another item; null for a unit that's gone);
// sent: what to remember as told.
export function unitsChange(was, sums) {
  const sent = sumsSent(sums), change = {};
  for (const uid of Object.keys(was || {})) if (!(uid in sums)) change[uid] = null;
  for (const [uid, s] of Object.entries(sums)) {
    const w = was?.[uid], now = sent[uid];
    if (w && w.n === now.n && w.value === now.value && w.key === now.key) continue;
    change[uid] = { n: s.n, value: s.value, ...(w && w.key === now.key ? {} : { best: s.best }) };
  }
  return { change, sent };
}

// The welcome's state without what's in Storage Units (a copy of the top level: the player's own state is left as it is).
export function leanState(st) {
  const { stored: _stored, ...rest } = st;
  return rest;
}

// An action's changes for lean1. statsWere: the stats before it (statsBefore), else they go whole. seen: it was item.seen.
// units: the units' sums that changed (unitsChange's), sent when Storage Units changed.
export function leanDelta(d, { statsWere = null, seen = false, units = null } = {}) {
  const out = {};
  let set = d.set || {};
  if ('stats' in set && statsWere) {
    const change = statsChange(statsWere, set.stats || {});
    if (change) {
      const { stats: _stats, ...rest } = set;
      set = rest;
      if (Object.keys(change).length) out.stats = change;
    }
  }
  if (Object.keys(set).length) out.set = set;
  if (d.add?.length) out.add = d.add;
  if (d.del?.length) out.del = d.del;
  if (d.upd?.length) {
    if (seen) out.seen = d.upd.map((it) => it.uid);
    else out.upd = d.upd;
  }
  if (d.sto) { out.sto = d.sto; if (units && Object.keys(units).length) out.units = units; }
  if (d.ix) out.ix = d.ix;
  return out;
}

// Changes (lean1's) for one connection: items moved into a Storage Unit whose contents it hasn't asked for (unloaded: that
// connection's units known only by their sums) are left out of d.sto.add, as the game would drop them; d is unchanged when
// none are.
export function forConnection(d, unloaded) {
  const add = d?.sto?.add;
  if (!add?.length || !unloaded?.size) return d;
  const kept = add.filter((it) => !unloaded.has(it.su));
  return kept.length === add.length ? d : { ...d, sto: { ...d.sto, add: kept } };
}

// An action's answer for lean1: every item that `d` (delta()'s, before leanDelta) carries whole, as { uid }. The same objects
// only: a copy of an item with the same uid stays whole. What it doesn't change is the answer's own objects, unchanged.
export function leanResult(r, d) {
  const sent = new Set([...(d.add || []), ...(d.upd || [])]);
  if (!sent.size || !r || typeof r !== 'object') return r;
  const walk = (v) => {
    if (!v || typeof v !== 'object') return v;
    if (sent.has(v)) return { uid: v.uid };
    let out = null;
    if (Array.isArray(v)) {
      v.forEach((x, i) => { const y = walk(x); if (y !== x) (out ??= v.slice())[i] = y; });
    } else {
      for (const [k, x] of Object.entries(v)) { const y = walk(x); if (y !== x) (out ??= { ...v })[k] = y; }
    }
    return out || v;
  };
  return walk(r);
}

// Both, for an action (name): { r, d }.
export const leanAct = (name, r, d, { statsWere, units = null }) => ({ r: leanResult(r, d), d: leanDelta(d, { statsWere, seen: name === 'item.seen', units }) });

// A change pushed to a player from elsewhere (a trade, a payout, staff): only the sums of the units it changed are added,
// when Storage Units changed. (No stats from before to compare with: they go whole, as they always did.)
export const leanPush = (d, units) => (d?.sto && units && Object.keys(units).length ? { ...d, units } : d);

// What one of a player's own Storage Units holds, for social 'stored'. → { unit, items, sum } (sum: as unitSums has it), or
// null when they have no such unit.
export function storedOfUnit(st, unit) {
  if (!unitsOf(st).some((u) => u.uid === unit)) return null;
  const items = storedOf(st).filter((it) => it.su === unit);
  return { unit, items, sum: unitSums({ inv: [{ t: 'unit', uid: unit }], stored: items })[unit] };
}

