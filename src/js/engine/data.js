// Game data (cases, skins, stickers, agents, collections, Majors, pro players) and the tables built from it.
// Shared by the client and the multiplayer server: the caller loads game-data.json and passes it to initData().
import { round2 } from './util.js';
import { CHICKEN_COOP } from './chickens.js';

export const D = {
  cases: [], skins: {}, stickers: {}, agents: {}, collections: [], events: {}, proTeams: {}, pros: {},
  keyPrice: 2.49, generatedAt: '', pricedAt: '',
};

export const WEARS = [
  { k: 'FN', n: 'Factory New', min: 0, max: 0.07, c: '#4ade80' },
  { k: 'MW', n: 'Minimal Wear', min: 0.07, max: 0.15, c: '#a3e635' },
  { k: 'FT', n: 'Field-Tested', min: 0.15, max: 0.38, c: '#facc15' },
  { k: 'WW', n: 'Well-Worn', min: 0.38, max: 0.45, c: '#fb923c' },
  { k: 'BS', n: 'Battle-Scarred', min: 0.45, max: 1, c: '#ef4444' },
];
export const WEAR_BY_KEY = Object.fromEntries(WEARS.map((w) => [w.k, w]));
export const wearOf = (f) => (f < 0.07 ? 'FN' : f < 0.15 ? 'MW' : f < 0.38 ? 'FT' : f < 0.45 ? 'WW' : 'BS');

// Rarity rank -> label/colour, per item family. Rank 6 = "Rare Special Item" (knives/gloves).
const C = ['#b0c3d9', '#5e98d9', '#4b69ff', '#8847ff', '#d32ce6', '#eb4b4b', '#e4ae39', '#e4ae39'];
export const RARITY = {
  skin: ['Consumer Grade', 'Industrial Grade', 'Mil-Spec Grade', 'Restricted', 'Classified', 'Covert', 'Rare Special', 'Contraband'],
  sticker: ['Default', 'Base Grade', 'High Grade', 'Remarkable', 'Exotic', 'Extraordinary', 'Rare Special', 'Contraband'],
  agent: ['', '', 'Distinguished', 'Exceptional', 'Superior', 'Master', '', ''],
  chicken: ['', '', 'Barnyard', 'Free-Range', 'Prize', 'Legendary', 'Mythic', ''],
};
export const rarityColor = (rank) => C[rank] ?? C[2];

// Official CS2 odds (Valve disclosure).
export const CASE_ODDS = [
  ['2', 0.7992], ['3', 0.1598], ['4', 0.032], ['5', 0.0064], ['rare', 0.0026],
];
// Souvenir packages, collection packages and armory collection drops: each rarity is 5x rarer than the one below.
export const COLLECTION_ODDS = { 0: 0.8, 1: 0.16, 2: 0.032, 3: 0.0064, 4: 0.00128, 5: 0.000256 };
export const DOPPLER_PHASE_WEIGHT = {
  'Phase 1': 0.22, 'Phase 2': 0.22, 'Phase 3': 0.22, 'Phase 4': 0.22,
  Ruby: 0.045, Sapphire: 0.045, 'Black Pearl': 0.03, Emerald: 0.06,
};
export const CASE_KINDS = { case: 'Cases', souvenir: 'Souvenir Packages', package: 'Packages', capsule: 'Capsules', autograph: 'Capsules' };

export function initData(json) {
  Object.assign(D, json);
  for (const c of D.cases) c.custom = false;
  D.cases.push(makeAgentLocker(), CHICKEN_COOP);
  D.caseById = Object.fromEntries(D.cases.map((c) => [c.id, c]));
  D.colById = Object.fromEntries(D.collections.map((c) => [c.id, c]));
  // Pro player cards grouped into the real rosters they played in (AI opponents in the team manager).
  D.rosters = {};
  for (const p of Object.values(D.pros)) (D.rosters[p.ev + '|' + p.tm] ||= []).push(p.id);
  D.proList = Object.values(D.pros);
  return D;
}

function avg(a) { return a.reduce((s, x) => s + x, 0) / (a.length || 1); }

// A custom box that drops any CS2 agent, priced so its expected value is ~80% of the cost (like real cases).
function makeAgentLocker() {
  const pools = {};
  for (const a of Object.values(D.agents)) (pools[a.r] ||= []).push(a.id);
  const odds = { 2: 0.7992, 3: 0.1598, 4: 0.032, 5: 0.0090 };
  let ev = 0, tw = 0;
  for (const [r, w] of Object.entries(odds)) {
    if (!pools[r]) continue;
    ev += w * avg(pools[r].map((id) => D.agents[id].p));
    tw += w;
  }
  return {
    id: 'custom-agents', n: 'Agent Locker', kind: 'agents', key: false, custom: true, date: '',
    img: '', icon: 'agents', price: round2(Math.max(0.99, ev / tw / 0.8)), pools,
  };
}

export function casePrice(c) {
  return round2((c.price || 0) + (c.key ? D.keyPrice : 0));
}

// [[tier, weight], ...] for a case-like container. Weights are relative (only tiers that exist).
export function caseTiers(c) {
  if (c.kind === 'chickens') return null;
  if (c.kind === 'case' || ((c.kind === 'package' || c.kind === 'souvenir') && c.rare?.length)) {
    return CASE_ODDS.filter(([k]) => (k === 'rare' ? c.rare?.length : c.pools[k]?.length));
  }
  if (c.kind === 'souvenir' || c.kind === 'package' || c.kind === 'collection') return collectionTiers(c.pools);
  const odds = { 2: 0.7992, 3: 0.1598, 4: 0.032, 5: 0.0064, 7: 0.0026 };
  return Object.keys(c.pools).map((k) => [k, odds[k] ?? 0.01]);
}
export const collectionTiers = (pools) =>
  Object.keys(pools).filter((k) => pools[k]?.length && COLLECTION_ODDS[k] != null).map((k) => [k, COLLECTION_ODDS[k]]);

// A collection as a case-like container (armory collection drops).
export function collectionBox(col) {
  return { id: col.id, n: col.n, img: col.img, kind: 'collection', key: false, custom: true, pools: col.tiers, col: col.id, price: 0 };
}

export const eventName = (ev) => D.events[ev]?.n || '';
// "2014 ESL One Cologne" -> "Cologne 2014"
export function eventShort(ev) {
  const n = eventName(ev);
  const year = n.match(/20\d\d/)?.[0] || '';
  const city = ['Cologne', 'Katowice', 'DreamHack', 'Cluj-Napoca', 'Columbus', 'Atlanta', 'Krakow', 'Boston', 'London', 'Berlin',
    'Stockholm', 'Antwerp', 'Rio', 'Paris', 'Copenhagen', 'Shanghai', 'Austin', 'Budapest', 'RMR'].find((c) => n.includes(c));
  return city ? `${city} ${year}` : n;
}
