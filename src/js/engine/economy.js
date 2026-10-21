// The clicker economy and the shape of a player's state. Every function takes the state object explicitly so the
// same rules run on the client (offline save) and on the multiplayer server (online account).
import { round2 } from './util.js';
import { chickenIncome } from './chickens.js';

// Auto-sell rules for new drops: sell anything worth less than `below` dollars and/or of the rarity ranks in
// `ranks` (0 Consumer ... 5 Covert). Knives, gloves and other ★ items are never auto-sold.
export const AUTO_SELL_DEFAULT = { on: false, below: 0, ranks: [], keepStt: true, keepRare: true };

export function freshState() {
  return {
    v: 2,
    money: 10,
    stars: 0,
    starSpend: 0, // case spending towards the next armory star
    inv: [],
    upg: {},
    coopSlots: 3,
    team: freshTeam(),
    stats: {
      opened: 0, spent: 0, sold: 0, clicks: 0, clickEarned: 0, passiveEarned: 0,
      bestValue: 0, bestName: '', drops: {}, knives: 0, stickersApplied: 0,
      tradeups: 0, armory: 0, packs: 0, gambleWagered: 0, gambleWon: 0, battles: 0, matches: 0,
    },
    settings: { volume: 0.5, fast: false, confirmSellAbove: 25, showOdds: true, autoSell: { ...AUTO_SELL_DEFAULT } },
    created: Date.now(),
    lastSeen: Date.now(),
  };
}

export function freshTeam() {
  return { name: 'My Team', slots: { IGL: null, AWP: null, Entry: null, Support: null, Lurk: null }, bench: [null, null], tokens: {}, w: 0, l: 0, elo: 1000, cup: null, history: [] };
}

// Older saves: fill in anything added since.
export function upgradeState(saved) {
  const base = freshState();
  const st = { ...base, ...saved, stats: { ...base.stats, ...saved.stats }, settings: { ...base.settings, ...saved.settings } };
  st.settings.autoSell = { ...AUTO_SELL_DEFAULT, ...(saved.settings?.autoSell || {}) };
  st.team = { ...freshTeam(), ...(saved.team || {}) };
  st.team.slots = { ...freshTeam().slots, ...(st.team.slots || {}) };
  st.v = base.v;
  return st;
}

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
export const lvl = (st, id) => st.upg[id] || 0;
export const upgradeCost = (st, u) => round2(u.base * Math.pow(u.g, lvl(st, u.id)));

export const globalMult = (st) => 1 + 0.25 * lvl(st, 'prime');
export const clickValue = (st) => round2((0.1 + 0.05 * lvl(st, 'mouse')) * Math.pow(1.25, lvl(st, 'rank')) * globalMult(st));
export const critChance = (st) => 0.02 + 0.01 * lvl(st, 'crosshair');
export const rankName = (st) => RANKS[lvl(st, 'rank')];

export function coopChickens(st) {
  return st.inv
    .filter((i) => i.t === 'chicken')
    .sort((a, b) => chickenIncome(b) - chickenIncome(a))
    .slice(0, st.coopSlots);
}
export const chickenRate = (st) => coopChickens(st).reduce((s, c) => s + chickenIncome(c), 0);
export const idleRate = (st) =>
  UPGRADES.filter((u) => u.kind === 'idle').reduce((s, u) => s + lvl(st, u.id) * u.rate, 0) * globalMult(st) + chickenRate(st);
export const coopSlotCost = (st) => round2(50 * Math.pow(2.2, st.coopSlots - 3));

// Offline earnings: half rate, at most 8 hours.
export const OFFLINE_CAP_S = 8 * 3600;
export function offlineEarnings(st, awaySeconds) {
  const away = Math.min(OFFLINE_CAP_S, awaySeconds);
  if (away < 60) return 0;
  return Math.floor(idleRate(st) * away * 0.5 * 100) / 100;
}
