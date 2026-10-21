// Save state, money, inventory and the clicker economy.
import { round2, debounce } from './util.js';
import { chickenIncome } from './chickens.js';

const LS_KEY = 'cs2-case-sim-save';
export const bus = new EventTarget();
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
export const on = (type, fn) => {
  const h = (e) => fn(e.detail);
  bus.addEventListener(type, h);
  return () => bus.removeEventListener(type, h);
};

function freshState() {
  return {
    v: 1,
    money: 10,
    inv: [],
    upg: {},
    coopSlots: 3,
    stats: {
      opened: 0, spent: 0, sold: 0, clicks: 0, clickEarned: 0, passiveEarned: 0,
      bestValue: 0, bestName: '', drops: {}, knives: 0, stickersApplied: 0,
    },
    settings: { volume: 0.5, fast: false, confirmSellAbove: 25, showOdds: true },
    created: Date.now(),
    lastSeen: Date.now(),
  };
}

export let S = freshState();

export async function loadState() {
  let text = null;
  try {
    text = window.native ? await window.native.loadSave() : localStorage.getItem(LS_KEY);
  } catch {}
  if (text) {
    try {
      const saved = JSON.parse(text);
      const base = freshState();
      S = { ...base, ...saved, stats: { ...base.stats, ...saved.stats }, settings: { ...base.settings, ...saved.settings } };
    } catch (e) {
      console.error('Save corrupted, starting fresh', e);
    }
  }
  return S;
}

function serialize() {
  S.lastSeen = Date.now();
  return JSON.stringify(S);
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

export async function resetSave() {
  if (window.native) await window.native.deleteSave();
  else localStorage.removeItem(LS_KEY);
  S = freshState();
  emit('reset');
  emit('money');
  emit('inv');
}

// ---- money ---------------------------------------------------------------------------------
export function addMoney(v) {
  S.money = round2(S.money + v);
  emit('money');
  save();
}
export function trySpend(v) {
  v = round2(v);
  if (S.money + 1e-9 < v) return false;
  S.money = round2(S.money - v);
  emit('money');
  save();
  return true;
}

// ---- inventory -----------------------------------------------------------------------------
export function addItems(items) {
  S.inv.unshift(...items);
  emit('inv');
  save();
}
export function removeItems(uids) {
  const set = new Set(uids);
  S.inv = S.inv.filter((i) => !set.has(i.uid));
  emit('inv');
  save();
}
export const findItem = (uid) => S.inv.find((i) => i.uid === uid);

// ---- clicker economy -----------------------------------------------------------------------
// Ranks double as the "click multiplier" upgrade.
export const RANKS = [
  'Silver I', 'Silver II', 'Silver III', 'Silver IV', 'Silver Elite', 'Silver Elite Master',
  'Gold Nova I', 'Gold Nova II', 'Gold Nova III', 'Gold Nova Master',
  'Master Guardian I', 'Master Guardian II', 'Master Guardian Elite', 'Distinguished Master Guardian',
  'Legendary Eagle', 'Legendary Eagle Master', 'Supreme Master First Class', 'The Global Elite',
];

export const UPGRADES = [
  { id: 'mouse', n: 'Gaming Mouse', d: '+$0.05 per click', base: 5, g: 1.17, kind: 'click' },
  { id: 'rank', n: 'Rank Up', d: 'x1.25 click value per rank', base: 60, g: 2.4, max: RANKS.length - 1, kind: 'click' },
  { id: 'crosshair', n: 'Crosshair Code', d: '+1% headshot chance (x10 click)', base: 25, g: 1.45, max: 30, kind: 'click' },
  { id: 'bots', n: 'Deathmatch Bots', d: '+$0.10 / second', base: 15, g: 1.15, kind: 'idle', rate: 0.1 },
  { id: 'pugs', n: 'PUG Grinder', d: '+$1 / second', base: 140, g: 1.15, kind: 'idle', rate: 1 },
  { id: 'tradebot', n: 'Trade Bot', d: '+$8 / second', base: 1400, g: 1.15, kind: 'idle', rate: 8 },
  { id: 'major', n: 'Major Run', d: '+$60 / second', base: 15000, g: 1.15, kind: 'idle', rate: 60 },
  { id: 'prime', n: 'Prime Status', d: '+25% to all income', base: 400, g: 3.2, max: 20, kind: 'global' },
];
export const lvl = (id) => S.upg[id] || 0;
export const upgradeCost = (u) => round2(u.base * Math.pow(u.g, lvl(u.id)));

export const globalMult = () => 1 + 0.25 * lvl('prime');
export const clickValue = () => round2((0.1 + 0.05 * lvl('mouse')) * Math.pow(1.25, lvl('rank')) * globalMult());
export const critChance = () => 0.02 + 0.01 * lvl('crosshair');
export const rankName = () => RANKS[lvl('rank')];

export function coopChickens() {
  return S.inv
    .filter((i) => i.t === 'chicken')
    .sort((a, b) => chickenIncome(b) - chickenIncome(a))
    .slice(0, S.coopSlots);
}
export const chickenRate = () => coopChickens().reduce((s, c) => s + chickenIncome(c), 0);
export const idleRate = () =>
  UPGRADES.filter((u) => u.kind === 'idle').reduce((s, u) => s + lvl(u.id) * u.rate, 0) * globalMult() + chickenRate();
export const coopSlotCost = () => round2(50 * Math.pow(2.2, S.coopSlots - 3));
