// The player's state as the UI sees it. Offline it is the local save; online it mirrors the server account
// (updated from the changes the server sends back). Changes go through backend.js actions, not direct edits.
import { debounce, round2 } from './util.js';
import * as E from './engine/economy.js';
import { backfillSerials } from './engine/items.js';

const LS_KEY = 'cs2-case-sim-save';
export const bus = new EventTarget();
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
export const on = (type, fn) => {
  const h = (e) => fn(e.detail);
  bus.addEventListener(type, h);
  return () => bus.removeEventListener(type, h);
};

export let S = E.freshState();
let offlineS = null; // the local save, kept aside while playing online
export const isOnlineState = () => offlineS != null;

export async function loadState() {
  let text = null;
  try {
    text = window.native ? await window.native.loadSave() : localStorage.getItem(LS_KEY);
  } catch {}
  if (text) {
    try {
      S = E.upgradeState(JSON.parse(text));
      backfillSerials(S); // saves from before serial numbers (once)
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
export function saveNow() {
  const text = serialize();
  if (window.native) return window.native.writeSave(text);
  try { localStorage.setItem(LS_KEY, text); } catch {}
}
export function saveSync() {
  const text = serialize();
  if (window.native) window.native.writeSaveSync(text);
  else try { localStorage.setItem(LS_KEY, text); } catch {}
}
export const save = debounce(saveNow, 800);

function announceAll() {
  emit('reset');
  emit('money');
  emit('inv');
  emit('stars');
  emit('team');
}

export async function resetSave() {
  if (window.native) await window.native.deleteSave();
  else localStorage.removeItem(LS_KEY);
  const settings = S.settings;
  if (offlineS) offlineS = { ...E.freshState(), settings };
  else S = { ...E.freshState(), settings };
  announceAll();
}

// Switch the UI to an online account's state (from the server) and back.
export function enterOnline(serverState) {
  if (!offlineS) { saveSync(); offlineS = S; }
  S = { ...E.upgradeState(serverState), settings: offlineS.settings };
  announceAll();
}
export function leaveOnline() {
  if (!offlineS) return;
  S = offlineS;
  offlineS = null;
  announceAll();
}

// Applies a change set from an action (local or from the server) and tells the UI what changed.
export function applyDelta(d, { local = false } = {}) {
  if (!local) {
    for (const [k, v] of Object.entries(d.set || {})) S[k] = v;
    if (d.del?.length) { const del = new Set(d.del); S.inv = S.inv.filter((i) => !del.has(i.uid)); }
    if (d.upd?.length) {
      const byUid = new Map(S.inv.map((i) => [i.uid, i]));
      for (const u of d.upd) { const cur = byUid.get(u.uid); if (cur) { for (const k of Object.keys(cur)) if (!(k in u)) delete cur[k]; Object.assign(cur, u); } }
    }
    if (d.add?.length) {
      const have = new Set(S.inv.map((i) => i.uid));
      S.inv.unshift(...d.add.filter((i) => !have.has(i.uid)));
    }
  }
  const set = d.set || {};
  if ('money' in set) emit('money');
  if (d.add?.length || d.del?.length || d.upd?.length || 'coopSlots' in set) emit('inv');
  if ('stars' in set) emit('stars');
  if ('team' in set) emit('team');
  if ('loadout' in set) emit('inv');
  if ('upg' in set) emit('money');
  emit('state', d);
}

// Display-only money change: the offline idle loop (which is the real income offline) and, online, the
// optimistic counter between server updates.
export function addMoney(v) {
  S.money = round2(S.money + v);
  emit('money');
  if (!offlineS) save();
}

export const findItem = (uid) => S.inv.find((i) => i.uid === uid);

// ---- clicker economy (rules in engine/economy.js) -------------------------------------------
export const { RANKS, UPGRADES } = E;
export const lvl = (id) => E.lvl(S, id);
export const upgradeCost = (u) => E.upgradeCost(S, u);
export const globalMult = () => E.globalMult(S);
export const clickValue = () => E.clickValue(S);
export const critChance = () => E.critChance(S);
export const rankName = () => E.rankName(S);
export const coopChickens = () => E.coopChickens(S);
export const chickenRate = () => E.chickenRate(S);
export const idleRate = () => E.idleRate(S);
export const coopSlotCost = () => E.coopSlotCost(S);
