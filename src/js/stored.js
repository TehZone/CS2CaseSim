// What's in your Storage Units, as the pages read it: a unit's count and value, the totals, net worth and your most valuable
// item. Offline, and online with a server that sends it all, S.stored has everything and these add it up (engine/storage.js).
// Online with lean1 the welcome leaves the contents out (see storedPart in state.js): a unit's count, value and most valuable
// item come instead, and what's in a unit is asked for when it's opened (loadUnit), then kept right by the server's changes.
import { S, storedPart, storedArrived } from './state.js';
import * as SU from './engine/storage.js';
import { itemValue } from './engine/items.js';
import { round2 } from './engine/util.js';
import { net } from './net/online.js';

// Whether a unit's contents are in S.stored.
export const unitLoaded = (uid) => { const p = storedPart(); return !p || p.loaded.has(uid); };
const sumOf = (uid) => storedPart()?.sums.get(uid) || null;

export const unitCount = (uid) => (unitLoaded(uid) ? SU.unitCount(S, uid) : +sumOf(uid)?.n || 0);
export const unitValue = (uid) => (unitLoaded(uid) ? SU.unitValue(S, uid) : round2(+sumOf(uid)?.value || 0));
// A unit's contents, once they're here (else []: see unitLoaded).
export const unitContents = (uid) => (unitLoaded(uid) ? SU.contents(S, uid) : []);

// Everything in your Storage Units: { n, value }.
export function storedTotals() {
  if (!storedPart()) { const all = SU.storedOf(S); return { n: all.length, value: all.reduce((s, it) => s + itemValue(it), 0) }; }
  let n = 0, value = 0;
  for (const u of SU.unitsOf(S)) { n += unitCount(u.uid); value += unitValue(u.uid); }
  return { n, value: round2(value) };
}
// Your inventory, Storage Units and Market listings together: what net worth and the stats count.
export const ownedWorth = () => (storedPart() ? round2([...S.inv, ...SU.listedOf(S)].reduce((s, it) => s + itemValue(it), 0) + storedTotals().value) : SU.ownedValue(S));
// Your most valuable item, in the inventory, a unit or on the Market (null: none).
export function bestOwned() {
  const p = storedPart();
  const pool = p ? [...S.inv, ...SU.storedOf(S), ...SU.listedOf(S), ...SU.unitsOf(S).filter((u) => !p.loaded.has(u.uid)).map((u) => sumOf(u.uid)?.best).filter(Boolean)] : SU.ownedItems(S);
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
