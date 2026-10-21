// Team manager: pro player cards from packs, a five-player lineup with roles and chemistry, and simulated matches
// (round by round, MR12 with overtime) against real historical Major rosters.
import { D, eventShort } from './data.js';
import { PRO_RARITY, proTier, proValue, proTeamName, proTeamTag, makeProItem } from './items.js';
import { rand, round2, pickWeighted, clamp, shuffle } from './util.js';

export const SLOTS = ['IGL', 'AWP', 'Entry', 'Support', 'Lurk'];
export const ROLE_NAMES = { IGL: 'In-game leader', AWP: 'AWPer', Entry: 'Entry fragger', Support: 'Support', Lurk: 'Lurker', RIF: 'Rifler' };
export const ATTRS = ['AIM', 'UTL', 'POS', 'CLU'];

// ---- packs --------------------------------------------------------------------------------------
// Tier weights: Bronze, Silver, Gold, Gold Star, Legend. Prices are set so a pack returns ~85% of its price.
export const PACKS = [
  { id: 'starter', n: 'Starter Pack', cards: 3, w: [75, 22, 3, 0, 0], color: '#8b98a8' },
  { id: 'standard', n: 'Standard Pack', cards: 5, w: [60, 30, 8, 1.6, 0.4], color: '#4b69ff' },
  { id: 'major', n: 'Major Pack', cards: 5, w: [50, 32, 14, 3.2, 0.8], color: '#d32ce6', perEvent: true },
  { id: 'premium', n: 'Premium Pack', cards: 5, w: [25, 40, 26, 7, 2], guarantee: 2, color: '#e4ae39' },
  { id: 'legend', n: 'Legends Pack', cards: 3, w: [0, 0, 40, 45, 15], guarantee: 3, color: '#ff5cdb' },
];
export const packById = (id) => PACKS.find((p) => p.id === id.split(':')[0]);

let tierPools = null;
function pools(ev) {
  if (!tierPools || tierPools.n !== D.proList.length) {
    tierPools = { n: D.proList.length, all: [[], [], [], [], []], ev: {} };
    for (const p of D.proList) {
      const t = proTier(p.ovr);
      tierPools.all[t].push(p);
      ((tierPools.ev[p.ev] ||= [[], [], [], [], []])[t]).push(p);
    }
  }
  return ev ? tierPools.ev[ev] || [[], [], [], [], []] : tierPools.all;
}
function tierWeights(pack, ev, minTier = 0) {
  const pl = pools(ev);
  return pack.w.map((w, t) => [t, t >= minTier && pl[t].length ? w : 0]).filter(([, w]) => w > 0);
}
const avg = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
export function packEV(pack, ev) {
  const pl = pools(ev);
  const card = (minTier) => {
    const tw = tierWeights(pack, ev, minTier);
    const total = tw.reduce((s, [, w]) => s + w, 0);
    return tw.reduce((s, [t, w]) => s + (w / total) * avg(pl[t].map(proValue)), 0);
  };
  const g = pack.guarantee ? 1 : 0;
  return card(0) * (pack.cards - g) + (g ? card(pack.guarantee) : 0);
}
export function packPrice(packId) {
  const pack = packById(packId);
  const ev = pack.perEvent ? +packId.split(':')[1] : null;
  return round2(Math.max(0.49, packEV(pack, ev) / 0.85));
}
// Majors you can buy Major Packs for (those with enough cards).
export const packEvents = () => Object.keys(D.events).map(Number).filter((ev) => pools(ev).flat().length >= 20).sort((a, b) => b - a);

export function openPack(packId, r = rand) {
  const pack = packById(packId);
  const ev = pack.perEvent ? +packId.split(':')[1] : null;
  const pl = pools(ev);
  const src = pack.perEvent ? `${pack.n} (${eventShort(ev)})` : pack.n;
  return Array.from({ length: pack.cards }, (_, i) => {
    const minTier = pack.guarantee && i === 0 ? pack.guarantee : 0;
    const t = pickWeighted(tierWeights(pack, ev, minTier), r);
    const list = pl[t];
    return makeProItem(list[Math.floor(r() * list.length)], src);
  }).sort((a, b) => D.pros[a.id].ovr - D.pros[b.id].ovr); // best card revealed last
}

// ---- lineup and chemistry ----------------------------------------------------------------------
// How well a card fits a role slot (rating penalty).
export function roleFit(card, slot) {
  if (card.role === slot) return 0;
  if (slot === 'AWP') return card.role === 'AWP' ? 0 : 7;
  if (card.role === 'AWP') return 5;
  if (slot === 'IGL') return 4;
  if (card.role === 'RIF') return 1;
  if (card.role === 'IGL') return 2;
  return 2;
}

// lineup: { IGL: card, AWP: card, ... } (cards are D.pros entries or null).
export function chemistry(lineup) {
  const cards = SLOTS.map((s) => lineup[s]).filter(Boolean);
  let chem = 0;
  const links = [];
  for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) {
    const a = cards[i], b = cards[j];
    if (a.tm === b.tm && a.ev === b.ev) { chem += 3; links.push([a.id, b.id, 'Same roster']); }
    else if (a.tm === b.tm) { chem += 1.5; links.push([a.id, b.id, 'Same team']); }
    else if (Math.abs(a.y - b.y) <= 1) chem += 0.5;
    if (a.geo && a.geo === b.geo) { chem += 1; links.push([a.id, b.id, 'Same country']); }
  }
  for (const s of SLOTS) if (lineup[s] && roleFit(lineup[s], s) === 0) chem += 1;
  return { value: clamp(Math.round(chem), 0, 30), links };
}

export function teamRating(lineup) {
  const cards = SLOTS.map((s) => lineup[s]);
  if (cards.some((c) => !c)) return { rating: 0, chem: 0, complete: false };
  const eff = SLOTS.map((s) => lineup[s].ovr - roleFit(lineup[s], s));
  const chem = chemistry(lineup).value;
  return { rating: round2(avg(eff) + chem * 0.2), chem, complete: true, eff };
}

// The player's lineup from their state (uids -> cards); missing or sold cards come back as null.
export function lineupFromState(st) {
  const byUid = new Map(st.inv.filter((i) => i.t === 'pro').map((i) => [i.uid, i]));
  const out = {};
  for (const s of SLOTS) {
    const it = byUid.get(st.team.slots[s]);
    out[s] = it ? D.pros[it.id] : null;
  }
  return out;
}

// Best lineup from a set of cards (greedy by effective rating), used for AI teams and "auto pick".
export function autoLineup(cards) {
  const left = [...cards].sort((a, b) => b.ovr - a.ovr);
  const out = {};
  for (const slot of ['AWP', 'IGL', 'Entry', 'Lurk', 'Support']) {
    let best = -1, bi = -1;
    left.forEach((c, i) => { const v = c.ovr - roleFit(c, slot); if (v > best) { best = v; bi = i; } });
    out[slot] = bi >= 0 ? left.splice(bi, 1)[0] : null;
  }
  return out;
}

// ---- opponents -----------------------------------------------------------------------------------
export function rosterTeam(key) {
  const ids = D.rosters[key] || [];
  const cards = ids.map((id) => D.pros[id]);
  if (cards.length < 5) return null;
  const lineup = autoLineup(cards);
  const [ev, tm] = key.split('|').map(Number);
  const t = D.proTeams[tm];
  return { key, name: `${t?.n || 'Team'} (${eventShort(ev)})`, tag: t?.tag || '', ev, tm, lineup, ...teamRating(lineup) };
}
let rosterCache = null;
export function allRosterTeams() {
  if (!rosterCache || rosterCache.n !== D.proList.length) {
    rosterCache = { n: D.proList.length, list: Object.keys(D.rosters).map(rosterTeam).filter(Boolean).sort((a, b) => a.rating - b.rating) };
  }
  return rosterCache.list;
}
// Three opponents around a rating: an easier one, an even one and a harder one.
export function suggestOpponents(rating, r = rand) {
  const list = allRosterTeams();
  const near = (target) => {
    const c = list.filter((t) => Math.abs(t.rating - target) < 2.5);
    return (c.length ? c : list)[Math.floor(r() * (c.length || list.length))];
  };
  return [near(rating - 4), near(rating), near(rating + 4)];
}

// ---- match simulation ----------------------------------------------------------------------------
const DUEL_SCALE = 110, ROUND_SWING = 12;
// teams: { name, lineup } with a complete lineup. Returns rounds, score and per-player stats.
export function simulateMatch(teamA, teamB, r = rand) {
  const side = (t) => SLOTS.map((s) => ({ ...t.lineup[s], slot: s, fit: roleFit(t.lineup[s], s) }));
  const A = side(teamA), B = side(teamB);
  const chemA = chemistry(teamA.lineup).value, chemB = chemistry(teamB.lineup).value;
  const stats = new Map([...A, ...B].map((p) => [p.id, { k: 0, d: 0, dmg: 0, n: p.n }]));
  const power = (p, chem) => p.ovr - p.fit + chem * 0.2;
  const rounds = [];
  let sa = 0, sb = 0, lossA = 0, lossB = 0;
  const target = 13;
  const playRound = (idx) => {
    const aliveA = A.map((p) => ({ p, hp: 100 })), aliveB = B.map((p) => ({ p, hp: 100 }));
    // Economy: a losing streak means weaker buys for the next round.
    const ecoA = lossA >= 2 && idx % 12 !== 0 ? -2.5 : 0, ecoB = lossB >= 2 && idx % 12 !== 0 ? -2.5 : 0;
    const feed = [];
    let first = true;
    // Round-to-round form: mid-rounds, stacks and anti-ecos that ratings don't capture.
    const formA = (r() - 0.5) * ROUND_SWING, formB = (r() - 0.5) * ROUND_SWING;
    while (aliveA.length && aliveB.length) {
      // Entry fraggers and AWPers take the first fights; lurkers and clutch players the late ones.
      const pickFighter = (alive) => pickWeighted(alive.map((x, i) => [i, (first ? (x.p.slot === 'Entry' ? 3 : x.p.slot === 'AWP' ? 2 : 1) : 1) * (x.p.slot === 'Lurk' && !first ? 1.5 : 1)]), r);
      const ia = pickFighter(aliveA), ib = pickFighter(aliveB);
      const pa = aliveA[ia].p, pb = aliveB[ib].p;
      const clutchA = aliveA.length === 1 ? (pa.a[3] - 75) * 0.2 : 0, clutchB = aliveB.length === 1 ? (pb.a[3] - 75) * 0.2 : 0;
      const ra = power(pa, chemA) + ecoA + clutchA + (pa.a[0] - pa.ovr) * 0.3 + (aliveA.length - aliveB.length) * 1.2;
      const rb = power(pb, chemB) + ecoB + clutchB + (pb.a[0] - pb.ovr) * 0.3 + (aliveB.length - aliveA.length) * 1.2;
      const pWinA = 1 / (1 + Math.pow(10, (rb - ra + formB - formA) / DUEL_SCALE));
      const aWins = r() < pWinA;
      const [win, lose, loseList] = aWins ? [pa, pb, aliveB] : [pb, pa, aliveA];
      const li = aWins ? ib : ia;
      stats.get(win.id).k++;
      stats.get(win.id).dmg += 100;
      stats.get(lose.id).d++;
      // Chip damage on the winner of the duel.
      const wl = (aWins ? aliveA : aliveB).find((x) => x.p.id === win.id);
      const chip = Math.floor(r() * 40);
      wl.hp -= chip;
      stats.get(lose.id).dmg += chip;
      feed.push({ k: win.n, v: lose.n, hs: r() < (win.slot === 'AWP' ? 0.25 : 0.45), awp: win.slot === 'AWP' });
      loseList.splice(li, 1);
      if (wl.hp <= 0) { (aWins ? aliveA : aliveB).splice((aWins ? aliveA : aliveB).indexOf(wl), 1); stats.get(win.id).d++; feed.push({ k: lose.n, v: win.n, trade: true }); }
      first = false;
    }
    const aWon = aliveA.length > 0;
    if (aWon) { sa++; lossA = 0; lossB++; } else { sb++; lossB = 0; lossA++; }
    rounds.push({ w: aWon ? 'A' : 'B', feed, score: [sa, sb] });
  };
  let idx = 0;
  while (sa < target && sb < target && !(sa === target - 1 && sb === target - 1)) playRound(idx++);
  // Overtime at 12-12: blocks of six rounds, first to 4 wins the block; 3-3 means another overtime.
  let ot = 0;
  while (sa === sb) {
    ot++;
    const baseA = sa, baseB = sb;
    while (sa - baseA < 4 && sb - baseB < 4 && !(sa - baseA === 3 && sb - baseB === 3)) playRound(idx++);
  }
  const players = [...stats.entries()].map(([id, s]) => ({ id, n: s.n, k: s.k, d: s.d, adr: Math.round(s.dmg / rounds.length) }));
  return { rounds, score: [sa, sb], winner: sa > sb ? 'A' : 'B', players, overtime: ot > 0 };
}

// Finishing place when knocked out with n teams left (final loss = 2nd, semi-final = 3rd-4th, ...).
export const placeLabel = (p) => ({ 1: "1st", 2: "2nd", 3: "3rd-4th", 5: "5th-8th", 9: "9th-16th" })[p] || p + "th";
// ---- rewards and cups ----------------------------------------------------------------------------
export const CUPS = {
  cup: { n: 'Online Cup', teams: 4, prize: { 1: 60, 2: 25, 3: 10 }, token: 'standard' },
  lan: { n: 'LAN Event', teams: 8, prize: { 1: 400, 2: 160, 3: 70, 5: 25 }, token: 'premium' },
  major: { n: 'Major Championship', teams: 16, prize: { 1: 3000, 2: 1200, 3: 500, 5: 200, 9: 60 }, token: 'legend' },
};
export function matchReward(myRating, oppRating, won) {
  const diff = clamp((oppRating - myRating) / 10, -0.6, 1.2);
  return won ? round2(Math.max(2, 12 * (1 + diff) * (myRating / 75) ** 2)) : 1;
}

// Seeds a bracket: the player's team plus AI rosters around its rating.
export function newCup(type, myRating, r = rand) {
  const cup = CUPS[type];
  const list = allRosterTeams();
  const strength = type === 'major' ? 3 : type === 'lan' ? 1.5 : 0;
  const pool = shuffle(list.filter((t) => Math.abs(t.rating - (myRating + strength)) < 6), r);
  const opps = (pool.length >= cup.teams - 1 ? pool : shuffle([...list], r)).slice(0, cup.teams - 1).map((t) => t.key);
  const field = shuffle(['me', ...opps], r);
  return { type, field, alive: field, round: 0, results: [], done: false, place: 0 };
}

export function teamLabel(key) {
  if (key === 'me') return 'Your team';
  return rosterTeam(key)?.name || key;
}
export { PRO_RARITY, proTier, proValue, proTeamName, proTeamTag };
