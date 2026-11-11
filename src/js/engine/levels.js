// Your profile level, like CS2's: 5,000 XP a level from 1 to 40, earned by playing matches. Earning past level 40 awards
// the next Service Medal and starts you again at level 1. The medals go newest first: every colour of the 2026 Service
// Medal, then every colour of 2025's, and so on back to the first one ever made, 2015's. Each level up comes with a
// reward like CS2's care package: four items to choose two from.
//
// Money comes from matches (a win or a draw pays $1,250, a loss $500, and every kill $100, assist $50 and round MVP $250)
// and from passive income: $100 every minute, while the game is open and while it's closed, up to 12 hours of it at a time
// (PASSIVE below).
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
// mvp: each round MVP you earn (only in modes with rounds: Deathmatch and Arms Race have none). XP doesn't count them.
export const PAY = { win: 1250, draw: 1250, loss: 500, kill: 100, assist: 50, mvp: 250 };
export const XP = { win: 250, draw: 250, loss: 100, kill: 20, assist: 10, round: 50 };
export const RESULTS = ['win', 'draw', 'loss'];

export function matchPay({ result, kills = 0, assists = 0, mvps = 0 }) {
  const parts = { result: PAY[result] || 0, kills: kills * PAY.kill, assists: assists * PAY.assist, mvps: mvps * PAY.mvp };
  return { ...parts, total: parts.result + parts.kills + parts.assists + parts.mvps };
}
export function matchXp({ result, kills = 0, assists = 0, roundsWon = 0 }) {
  const parts = { result: XP[result] || 0, kills: kills * XP.kill, assists: assists * XP.assist, rounds: roundsWon * XP.round };
  return { ...parts, total: parts.result + parts.kills + parts.assists + parts.rounds };
}

// ---- passive income ----------------------------------------------------------------------------------------------------
// $100 for every whole minute, online and offline, while the game is open and while it's closed: up to 12 hours of it at a
// time (a longer absence pays 12 hours, $72,000). The one rule for both modes (offline the game runs it by the PC's clock,
// online the server by its own: see actions.js 'passive.collect'). The state keeps passive = { at, earned }: the time it has
// been counted up to, and what it has paid in all. Collecting at `now` pays the whole minutes since `at`, no more than the
// cap, and moves `at` on by every whole minute that went by (paid, or past the cap), so the part of a minute left over
// counts towards the next. A state with no time yet (saves and accounts from before passive income: no back pay) or one
// ahead of the clock (a PC's clock put back) pays nothing and counts from now. Open, the game collects every minute, so
// the cap only ever bites on time away.
export const PASSIVE = { perMinute: 100, capHours: 12 };
export const PASSIVE_MINUTE = 60 * 1000;
// A new save's or account's: counting from its creation.
export const freshPassive = (now = Date.now()) => ({ at: now, earned: 0 });
// What collecting at `now` pays, from the time `at` it was counted up to. → { minutes, pay, capped, at (the new time) }
export function passivePay(at, now) {
  if (!Number.isFinite(at) || now < at) return { minutes: 0, pay: 0, capped: false, at: now };
  const whole = Math.floor((now - at) / PASSIVE_MINUTE), minutes = Math.min(whole, PASSIVE.capHours * 60);
  return { minutes, pay: minutes * PASSIVE.perMinute, capped: whole > minutes, at: at + whole * PASSIVE_MINUTE };
}
// Whether collecting at `now` would change anything: a whole minute is due, or the clock starts (or starts again).
export const passiveDue = (passive, now) => !Number.isFinite(passive?.at) || now < passive.at || now - passive.at >= PASSIVE_MINUTE;

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
  if (pool?.data === D.lock) return pool;
  // (Custom cases only when their pack says so, on top of the six: a new custom case never pushes a real one out.)
  const cases = D.cases.filter((c) => c.kind === 'case' && !c.custom && !c.cx && c.price != null)
    .sort((a, b) => String(b.date || '').replace(/\//g, '-').localeCompare(String(a.date || '').replace(/\//g, '-'))).slice(0, POOL_CASES)
    .concat(D.cases.filter((c) => c.cx && c.levelDrops && c.kind === 'case' && c.price != null));
  const collections = D.collections.filter((c) => /timed-drops/.test(c.id));
  pool = { data: D.lock, cases, collections };
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
export const CARE_SRC = 'Level-up reward';
export function carePackage({ r = rand, now = Date.now(), level = 0 } = {}) {
  const { cases, collections } = dropPool();
  const kinds = Array.from({ length: CARE_OFFERS }, (_, i) => (i === 0 ? 'case' : i === 1 ? 'skin' : r() < 0.4 ? 'case' : 'skin'));
  const used = new Set(), offers = [];
  for (const k of kinds) {
    const left = cases.filter((c) => !used.has(c.id));
    if (k === 'case' && left.length) {
      const c = pick(left, r);
      used.add(c.id);
      offers.push(makeCrateItem(c, CARE_SRC));
      continue;
    }
    const s = poolSkin(collections, r);
    if (s) offers.push(makeSkinItem(s, { src: CARE_SRC, stt: false, r }));
  }
  return { id: uid(), at: now, level, offers };
}
