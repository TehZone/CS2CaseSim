// The player's state as the UI sees it. Offline it is the local save; online it mirrors the server account
// (updated from the changes the server sends back). Changes go through backend.js actions, not direct edits.
import { debounce } from './util.js';
import * as E from './engine/economy.js';
import { backfillSerials, retireOld, isUnit } from './engine/items.js';
import { applyChange, backfillIndex } from './engine/itemindex.js';

const LS_KEY = 'cs2-case-sim-save';
// The last price patch the server sent (net/online.js syncPrices), kept between launches. In a browser it shares the save's
// storage, and the save comes first: a save that doesn't fit drops it.
export const PRICES_KEY = 'cs2sim-prices';
export const bus = new EventTarget();
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
export const on = (type, fn) => {
  const h = (e) => fn(e.detail);
  bus.addEventListener(type, h);
  return () => bus.removeEventListener(type, h);
};

export let S = E.freshState();
export let retiredOnLoad = null; // { n, value }: the chickens and pro cards an older save had, sold on load
let offlineS = null; // the local save, kept aside while playing online
export const isOnlineState = () => offlineS != null;
// Online with lean1 (net/online.js), the welcome leaves out what's in Storage Units. Then this is { sums, loaded }: sums is
// each unit's { n, value, best } (its count, value and most valuable item, from the server), loaded the units whose contents
// have been asked for (stored.js loadUnit). S.stored holds the loaded units' contents only, kept right by the changes as
// usual; the others are known by their sums, which the server sends again whenever what's in a unit changes. null:
// S.stored is all of it (offline, and online with a server that sends it all).
let part = null;
export const storedPart = () => part;

export async function loadState() {
  let text = null;
  try {
    text = window.native ? await window.native.loadSave() : localStorage.getItem(LS_KEY);
  } catch {}
  if (text) {
    try {
      S = E.upgradeState(JSON.parse(text));
      backfillSerials(S); // saves from before serial numbers (once)
      backfillIndex(S); // and from before the Index (after those: it reads the serial counters)
      retiredOnLoad = retireOld(S);
    } catch (e) {
      console.error('Save corrupted, starting fresh', e);
    }
  }
  return S;
}

// Only the offline save is written to disk; online progress lives on the server. Settings are per device
// and shared by both (the online state points at the same settings object).
function serialize() {
  const local = offlineS || S;
  local.lastSeen = Date.now();
  return JSON.stringify(local);
}
// (In a browser, the save goes before the kept prices: they only make the next launch quicker.)
function storeSave(text) {
  try { localStorage.setItem(LS_KEY, text); } catch {
    try { localStorage.removeItem(PRICES_KEY); localStorage.setItem(LS_KEY, text); } catch {}
  }
}
export function saveNow() {
  const text = serialize();
  if (window.native) return window.native.writeSave(text);
  storeSave(text);
}
export function saveSync() {
  const text = serialize();
  if (window.native) window.native.writeSaveSync(text);
  else storeSave(text);
}
export const save = debounce(saveNow, 800);

function announceAll() {
  emit('reset');
  emit('money');
  emit('inv');
  emit('stars');
  emit('prof');
  emit('social');
}

export async function resetSave() {
  if (window.native) await window.native.deleteSave();
  else localStorage.removeItem(LS_KEY);
  const settings = S.settings;
  if (offlineS) offlineS = { ...E.freshState(), settings };
  else S = { ...E.freshState(), settings };
  announceAll();
}
// The offline save replaced as a whole (the admin panel's restore, reset and import): this device's settings stay.
export function replaceState(next) {
  const settings = (offlineS || S).settings;
  if (offlineS) offlineS = { ...next, settings };
  else S = { ...next, settings };
  announceAll();
  save();
}

// Switch the UI to an online account's state (from the server) and back. units: a lean1 welcome's Storage Unit sums, when
// its state has no `stored` (see `part`).
export function enterOnline(serverState, { units = null } = {}) {
  if (!offlineS) { saveSync(); offlineS = S; }
  part = units && typeof units === 'object' && !Array.isArray(serverState?.stored) ? { sums: new Map(Object.entries(units)), loaded: new Set() } : null;
  S = { ...E.upgradeState(serverState), settings: offlineS.settings };
  announceAll();
}
export function leaveOnline() {
  part = null;
  if (!offlineS) return;
  S = offlineS;
  offlineS = null;
  announceAll();
}

// A Storage Unit's contents as the server sent them (social 'stored', for stored.js loadUnit): { items, sum }. at: the
// storedPart() it was asked for in (a reply from before a reconnect is for a state that's gone).
export function storedArrived(unit, { items, sum } = {}, at = part) {
  if (!part || part !== at) return;
  const inside = (Array.isArray(items) ? items : []).filter((it) => it && it.su === unit);
  const have = new Set(inside.map((it) => it.uid));
  S.stored = [...inside, ...(S.stored || []).filter((it) => it.su !== unit && !have.has(it.uid))];
  part.loaded.add(unit);
  if (sum && typeof sum === 'object') part.sums.set(unit, sum);
  emit('inv');
}

// Auto open is running (pages/cases.js). Pages that would ask the server again after every change it makes wait for it to
// stop ('autoopen' says when it starts and stops).
let autoOpening = false;
export const isAutoOpening = () => autoOpening;
export function setAutoOpening(running) {
  if (autoOpening === !!running) return;
  autoOpening = !!running;
  emit('autoopen', autoOpening);
}

// Something a page asks the server for again as the inventory changes (your own profile, the float ranks), asked for calmly:
// run() at most once every `gap` ms, never while auto open runs, and once when it stops if it was wanted meanwhile. ask():
// it's wanted now (it runs at once if it may, else when it may). ran(): it has just been asked for some other way (the gap
// starts again). stop(): one waiting is forgotten.
export function calmly(run, gap) {
  let at = -Infinity, timer = null, held = false;
  const fire = () => {
    timer = null;
    if (autoOpening) { held = true; return; } // (its time came while auto open runs: it waits for it to stop)
    at = Date.now();
    run();
  };
  const ask = () => {
    if (autoOpening) { held = true; return; }
    if (timer) return;
    const wait = at + gap - Date.now();
    if (wait <= 0) fire(); else timer = setTimeout(fire, wait);
  };
  on('autoopen', (running) => {
    if (running || !held) return;
    held = false;
    clearTimeout(timer); // (worked out again: the gap may be over by now)
    timer = null;
    ask();
  });
  return {
    ask,
    ran: () => { at = Date.now(); },
    stop: () => { clearTimeout(timer); timer = null; held = false; },
    waiting: () => !!timer || held,
  };
}

// Applies a change set from an action (local or from the server) and tells the UI what changed. The server's may have
// lean1's fields too (server/lean.mjs): `stats` (the stats fields that changed), `seen` (uids whose New tag went) and
// `units` (the sums of the Storage Units whose contents changed).
export function applyDelta(d, { local = false } = {}) {
  if (!local) {
    for (const [k, v] of Object.entries(d.set || {})) S[k] = v;
    if (d.set && 'stored' in d.set) part = null; // (all of it: nothing's left to ask for)
    if (d.stats && typeof d.stats === 'object') {
      const was = S.stats || {};
      S.stats = { ...was, ...d.stats, drops: { ...was.drops, ...d.stats.drops } };
    }
    if (d.del?.length) { const del = new Set(d.del); S.inv = S.inv.filter((i) => !del.has(i.uid)); }
    if (d.upd?.length) {
      const byUid = new Map(S.inv.map((i) => [i.uid, i]));
      for (const u of d.upd) { const cur = byUid.get(u.uid); if (cur) { for (const k of Object.keys(cur)) if (!(k in u)) delete cur[k]; Object.assign(cur, u); } }
    }
    if (d.seen?.length) {
      const seen = new Set(d.seen);
      for (const it of S.inv) if (seen.has(it.uid)) delete it.nw;
    }
    // (only the units whose sums changed, merged: best comes only when it's another item; null, a unit that's gone)
    if (d.units && typeof d.units === 'object' && part) {
      for (const [uid, row] of Object.entries(d.units)) {
        if (row === null) part.sums.delete(uid);
        else if (row && typeof row === 'object') part.sums.set(uid, { ...part.sums.get(uid), ...row });
      }
    }
    if (d.add?.length) {
      const have = new Set(S.inv.map((i) => i.uid));
      const fresh = d.add.filter((i) => !have.has(i.uid));
      S.inv.unshift(...fresh);
      // (a unit you didn't have at the welcome is a new one, so empty: there's nothing in it to ask for)
      if (part) for (const it of fresh) if (isUnit(it) && !part.sums.has(it.uid)) part.loaded.add(it.uid);
    }
    if (d.sto) {
      // (Each item once, whichever order changes come in. lean1: only into a unit whose contents are here.)
      const add = (d.sto.add || []).filter((i) => !part || part.loaded.has(i.su));
      const del = new Set([...(d.sto.del || []), ...add.map((i) => i.uid)]);
      S.stored = [...add, ...(S.stored || []).filter((i) => !del.has(i.uid))];
    }
    if (d.ix) S.index = applyChange(S.index, d.ix);
  }
  const set = d.set || {};
  if ('money' in set) emit('money');
  if (d.add?.length || d.del?.length || d.upd?.length || d.seen?.length || d.sto || d.units || 'stored' in set) emit('inv');
  if ('stars' in set) emit('stars');
  if ('prof' in set) emit('prof');
  if ('social' in set) emit('social');
  if ('loadout' in set) emit('inv');
  if ('upg' in set) emit('money');
  if (d.ix || 'index' in set) emit('index', d.ix || {});
  emit('state', d);
}

export const findItem = (uid) => S.inv.find((i) => i.uid === uid);
