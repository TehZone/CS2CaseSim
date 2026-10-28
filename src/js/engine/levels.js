// Your profile level, like CS2's: 5,000 XP a level from 1 to 40, earned by playing matches. Earning past level 40 awards
// the next Service Medal and starts you again at level 1. The medals go newest first: every colour of the 2026 Service
// Medal, then every colour of 2025's, and so on back to the first one ever made, 2015's. Each level up comes with a
// reward like CS2's care package: four items to choose two from.
//
// Matches are also the only way to earn money: a win (or a draw) pays $250, a loss $100, and every kill $20 and assist $10.
import { D, COLLECTION_ODDS } from './data.js';
import { makeSkinItem, makeCrateItem } from './items.js';
import { pick, pickWeighted, rand, uid } from './util.js';

export const XP_PER_LEVEL = 5000, MAX_LEVEL = 40;

// Each year's Service Medal and how many colours it comes in (CS2's items_game: the 2015 medal has two, 2017's seven).
const MEDAL_YEARS = [[2026, 6], [2025, 6], [2024, 6], [2023, 6], [2022, 6], [2021, 6], [2020, 6], [2019, 6], [2018, 6], [2017, 7], [2016, 6], [2015, 2]];
// In the order they're earned: { y: year, l: its colour (1 = the first) }.
export const MEDALS = MEDAL_YEARS.flatMap(([y, n]) => Array.from({ length: n }, (_, i) => ({ y, l: i + 1 })));
export const medalName = (m) => `${m.y} Service Medal`;

// What a finished match pays, and the XP it's worth (the same for every mode; rounds count where there are rounds).
export const PAY = { win: 250, draw: 250, loss: 100, kill: 20, assist: 10 };
export const XP = { win: 250, draw: 250, loss: 100, kill: 20, assist: 10, round: 50 };
export const RESULTS = ['win', 'draw', 'loss'];

export function matchPay({ result, kills = 0, assists = 0 }) {
  const parts = { result: PAY[result] || 0, kills: kills * PAY.kill, assists: assists * PAY.assist };
  return { ...parts, total: parts.result + parts.kills + parts.assists };
}
export function matchXp({ result, kills = 0, assists = 0, roundsWon = 0 }) {
  const parts = { result: XP[result] || 0, kills: kills * XP.kill, assists: assists * XP.assist, rounds: roundsWon * XP.round };
  return { ...parts, total: parts.result + parts.kills + parts.assists + parts.rounds };
}

// A new player's profile: level 1, no XP, no medals yet, no rewards waiting.
export const freshProfile = () => ({ level: 1, xp: 0, medals: 0, total: 0, drops: [] });
export const medalOf = (prof) => (prof?.medals ? MEDALS[Math.min(prof.medals, MEDALS.length) - 1] : null);
// The medal the next prestige brings (null once you have every one).
export const nextMedal = (prof) => MEDALS[prof?.medals || 0] || null;

// At most this many rewards wait to be claimed (older ones are kept, newer ones beyond it are skipped).
export const MAX_WAITING = 20;

// Adds XP: returns the new profile (the old one isn't changed) and what happened on the way.
export function addXp(prof, xp, { r = rand, now = Date.now() } = {}) {
  const p = { ...freshProfile(), ...prof, drops: [...(prof?.drops || [])] };
  const before = { level: p.level, xp: p.xp, medals: p.medals };
  p.xp += xp;
  p.total += xp;
  let levelUps = 0;
  const medals = [];
  while (p.xp >= XP_PER_LEVEL) {
    p.xp -= XP_PER_LEVEL;
    levelUps++;
    if (p.level < MAX_LEVEL) p.level++;
    else {
      // Past level 40: the next Service Medal, and back to level 1. (With every medal earned, you keep the last.)
      p.level = 1;
      if (p.medals < MEDALS.length) { p.medals++; medals.push(p.medals - 1); }
    }
    if (p.drops.length < MAX_WAITING) p.drops.push(carePackage({ r, now, level: p.level }));
  }
  return { prof: p, before, after: { level: p.level, xp: p.xp, medals: p.medals }, levelUps, medals };
}

// ---- level-up rewards ------------------------------------------------------------------------------------------------
// CS2's active drop pool: the newest weapon cases, and the timed-drop collections' skins.
const POOL_CASES = 6;
let pool = null;
export function dropPool() {
  if (pool?.data === D.generatedAt) return pool;
  const cases = D.cases.filter((c) => c.kind === 'case' && !c.custom && c.price != null)
    .sort((a, b) => String(b.date || '').replace(/\//g, '-').localeCompare(String(a.date || '').replace(/\//g, '-'))).slice(0, POOL_CASES);
  const collections = D.collections.filter((c) => /timed-drops/.test(c.id));
  pool = { data: D.generatedAt, cases, collections };
  return pool;
}
// One of the timed-drop skins, rarer grades five times rarer each (a Classified is a lucky reward).
function poolSkin(cols, r) {
  const tiers = {};
  for (const c of cols) for (const [t, ids] of Object.entries(c.tiers || {})) (tiers[t] ||= []).push(...ids.filter((id) => D.skins[id]));
  const odds = Object.keys(tiers).filter((t) => tiers[t].length && COLLECTION_ODDS[t]).map((t) => [t, COLLECTION_ODDS[t]]);
  if (!odds.length) return null;
  return D.skins[pick(tiers[pickWeighted(odds, r)], r)];
}

// A level-up reward: four items, at least one case and one skin, no case twice. You keep two of them.
export const CARE_OFFERS = 4, CARE_PICKS = 2;
const SRC = 'Level-up reward';
export function carePackage({ r = rand, now = Date.now(), level = 0 } = {}) {
  const { cases, collections } = dropPool();
  const kinds = Array.from({ length: CARE_OFFERS }, (_, i) => (i === 0 ? 'case' : i === 1 ? 'skin' : r() < 0.4 ? 'case' : 'skin'));
  const used = new Set(), offers = [];
  for (const k of kinds) {
    const left = cases.filter((c) => !used.has(c.id));
    if (k === 'case' && left.length) {
      const c = pick(left, r);
      used.add(c.id);
      offers.push(makeCrateItem(c, SRC));
      continue;
    }
    const s = poolSkin(collections, r);
    if (s) offers.push(makeSkinItem(s, { src: SRC, stt: false, r }));
  }
  return { id: uid(), at: now, level, offers };
}
