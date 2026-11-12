// What's in your Storage Units, as the pages read it: a unit's count and value, the totals, net worth and your most valuable
// item. Offline, and online with a server that sends it all, S.stored has everything and these add it up (engine/storage.js).
// Online with lean1 the welcome leaves the contents out (see storedPart in state.js): a unit's count, value and most valuable
// item come instead, and what's in a unit is asked for when it's opened (loadUnit), then kept right by the server's changes.
import { S, storedPart, storedArrived } from './state.js';
import * as SU from './engine/storage.js';
import { itemValue } from './engine/items.js';
import { round2 } from './engine/util.js';
import { D } from './engine/data.js';
import { net } from './net/online.js';

// Whether a unit's contents are in S.stored.
export const unitLoaded = (uid) => { const p = storedPart(); return !p || p.loaded.has(uid); };
const sumOf = (uid) => storedPart()?.sums.get(uid) || null;

// What S.stored adds up to: each unit's count and value (engine/storage.js unitTotals), the value of all of it and its most
// valuable item. Worked out once and kept while S.stored is the same list (a change to it is always a new one: state.js, the
// actions) and the prices are the same. Up to 100 units show at once (the inventory, picking a unit), and a pass for each
// one's card went through up to 100,000 items 100 times; net worth and the most valuable item are drawn on every change to
// the inventory or the money, which leaves what's stored as it was.
let totals = null;
function loaded() {
  const list = S.stored;
  if (!totals || totals.list !== list || totals.n !== list?.length || totals.priced !== D.pricedAt) {
    let value = 0, best = null, top = 0;
    for (const it of SU.storedOf(S)) { const v = itemValue(it); value += v; if (!best || v > top) { best = it; top = v; } }
    totals = { list, n: list?.length, priced: D.pricedAt, units: SU.unitTotals(S), value, best };
  }
  return totals;
}
const worthOf = (items) => items.reduce((s, it) => s + itemValue(it), 0);
export const unitCount = (uid) => (unitLoaded(uid) ? loaded().units.get(uid)?.n || 0 : +sumOf(uid)?.n || 0);
export const unitValue = (uid) => (unitLoaded(uid) ? loaded().units.get(uid)?.value || 0 : round2(+sumOf(uid)?.value || 0));
// A unit's contents, once they're here (else []: see unitLoaded).
export const unitContents = (uid) => (unitLoaded(uid) ? SU.contents(S, uid) : []);

// Everything in your Storage Units: { n, value }.
export function storedTotals() {
  if (!storedPart()) return { n: SU.storedOf(S).length, value: loaded().value };
  let n = 0, value = 0;
  for (const u of SU.unitsOf(S)) { n += unitCount(u.uid); value += unitValue(u.uid); }
  return { n, value: round2(value) };
}
// Your inventory, Storage Units and Market listings together: what net worth and the stats count. (Offline, the same as
// engine/storage.js ownedValue: every value is in whole cents, so the order they're added up in makes no difference.)
export const ownedWorth = () => round2(worthOf(S.inv) + worthOf(SU.listedOf(S)) + storedTotals().value);
// Your most valuable item, in the inventory, a unit or on the Market (null: none). (The first of the most valuable, in that
// order, as when they were all looked through.)
export function bestOwned() {
  const p = storedPart(), inside = loaded().best;
  const pool = [...S.inv, ...(inside ? [inside] : []), ...SU.listedOf(S), ...(p ? SU.unitsOf(S).filter((u) => !p.loaded.has(u.uid)).map((u) => sumOf(u.uid)?.best).filter(Boolean) : [])];
  return pool.reduce((b, it) => (!b || itemValue(it) > itemValue(b) ? it : b), null);
}

// Everything in your Storage Units, counted: what the float ranks' key needs (floatranks.js), without valuing anything.
export function storedCount() {
  if (!storedPart()) return SU.storedOf(S).length;
  let n = 0;
  for (const u of SU.unitsOf(S)) n += unitCount(u.uid);
  return n;
}

// Brings a unit's contents here (online with lean1; at once otherwise). Resolves whether they're here. One request per unit
// at a time (per connection: one asked for before a reconnect doesn't stand for the new one); once here, they stay (until the
// connection does).
const loading = new Map(); // unit uid -> { at: the storedPart() it was asked for in, run: its request }
export function loadUnit(uid) {
  if (unitLoaded(uid)) return Promise.resolve(true);
  const at = storedPart(), was = loading.get(uid);
  if (was && was.at === at) return was.run;
  const run = net.social('stored', { unit: uid })
    .then((r) => { storedArrived(uid, r, at); return unitLoaded(uid); }, () => false)
    .finally(() => { if (loading.get(uid)?.run === run) loading.delete(uid); });
  loading.set(uid, { at, run });
  return run;
}

// A window that shows a unit's contents (pages/storage.js): status() says whether they're 'here', 'loading' or 'failed', and
// asks for them whenever they aren't here and nothing is on its way, so a reconnect (whose welcome forgets every unit's
// contents) brings them back by itself. A request that failed is shown as failed until retry(), or until a new connection.
// onSettle: a request came back (draw again).
export function unitWatch(uid, onSettle = () => {}) {
  let asking = false, failedIn = null; // (failedIn: the storedPart() it failed in)
  const ask = () => {
    asking = true;
    failedIn = null;
    const at = storedPart();
    loadUnit(uid).then((ok) => {
      asking = false;
      if (!ok && !unitLoaded(uid)) failedIn = at;
      onSettle();
    });
  };
  return {
    status() {
      if (unitLoaded(uid)) return 'here';
      if (failedIn && failedIn === storedPart()) return 'failed';
      if (!asking) ask();
      return 'loading';
    },
    retry() { failedIn = null; },
  };
}
