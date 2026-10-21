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

// Earning is deliberately slow: clicks, upgrades and passive income were nerfed so cases, the market and the
// armory stay worth working towards.
export const CRIT_MULT = 5; // headshots pay 5x a normal click
export const UPGRADES = [
  { id: 'mouse', n: 'Gaming Mouse', d: '+$0.02 per click', base: 8, g: 1.2, kind: 'click' },
  { id: 'rank', n: 'Rank Up', d: 'x1.15 click value per rank', base: 80, g: 2.6, max: RANKS.length - 1, kind: 'click' },
  { id: 'crosshair', n: 'Crosshair Code', d: '+0.5% headshot chance (x5 click)', base: 30, g: 1.5, max: 30, kind: 'click' },
  { id: 'bots', n: 'Deathmatch Bots', d: '+$0.04 / second', base: 20, g: 1.18, kind: 'idle', rate: 0.04 },
  { id: 'pugs', n: 'PUG Grinder', d: '+$0.40 / second', base: 200, g: 1.18, kind: 'idle', rate: 0.4 },
  { id: 'tradebot', n: 'Trade Bot', d: '+$3 / second', base: 2500, g: 1.18, kind: 'idle', rate: 3 },
  { id: 'major', n: 'Major Run', d: '+$20 / second', base: 30000, g: 1.18, kind: 'idle', rate: 20 },
  { id: 'prime', n: 'Prime Status', d: '+10% to all income', base: 500, g: 3.5, max: 10, kind: 'global' },
];
export const lvl = (st, id) => st.upg[id] || 0;
export const upgradeCost = (st, u) => round2(u.base * Math.pow(u.g, lvl(st, u.id)));

export const globalMult = (st) => 1 + 0.1 * Math.min(lvl(st, 'prime'), 10);
export const clickValue = (st) => round2((0.05 + 0.02 * lvl(st, 'mouse')) * Math.pow(1.15, lvl(st, 'rank')) * globalMult(st));
export const critChance = (st) => 0.02 + 0.005 * Math.min(lvl(st, 'crosshair'), 30);
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

// Offline earnings: a quarter of the rate, at most 4 hours.
export const OFFLINE_CAP_S = 4 * 3600;
export const OFFLINE_RATE = 0.25;
export function offlineEarnings(st, awaySeconds) {
  const away = Math.min(OFFLINE_CAP_S, awaySeconds);
  if (away < 60) return 0;
  return Math.floor(idleRate(st) * away * OFFLINE_RATE * 100) / 100;
}
