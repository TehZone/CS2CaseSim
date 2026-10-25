// How good a bot is, from its rank: one number, skill (0 a Silver I, 1 The Global Elite), that sets everything it does —
// how fast it reacts and turns, how far off its first shot is and how it controls a spray, where its crosshair rests,
// how quickly it stops to shoot (counter-strafing), how much utility it throws and how well, how patient it is and how
// quickly it trades a teammate. Matchmaking finds a match's bots around your own rank (matchedSkill); a private match's
// come from the ranks you pick, each its own rank within it: a skill group in Competitive and Wingman, a CS Rating in
// Premier (see ranks.js, premier.js).
import { SKILL_GROUPS, groupValue, mmrOfGroup } from '../engine/ranks.js';

export const BOT_TIERS = {
  silver: { name: 'Silver', groups: [1, 6] },
  gold: { name: 'Gold Nova', groups: [7, 10] },
  mg: { name: 'Master Guardian', groups: [11, 14] },
  eagle: { name: 'Legendary Eagle', groups: [15, 16] },
  supreme: { name: 'Supreme', groups: [17, 17] },
  global: { name: 'Global Elite', groups: [18, 18] },
};
// The old Easy..Expert setting, and back (match rewards and your rank's opponents still go by these four).
export const FROM_DIFFICULTY = { easy: 'silver', normal: 'gold', hard: 'eagle', expert: 'global' };
export const TO_DIFFICULTY = { silver: 'easy', gold: 'normal', mg: 'hard', eagle: 'hard', supreme: 'expert', global: 'expert' };
export const tierOf = (p) => (BOT_TIERS[p] ? p : FROM_DIFFICULTY[p] || 'gold');

export const skillOfGroup = (g) => Math.max(0, Math.min(1, (g - 1) / (SKILL_GROUPS.length - 1)));
export const groupOfSkill = (s) => Math.max(1, Math.min(SKILL_GROUPS.length, 1 + Math.round(s * (SKILL_GROUPS.length - 1))));
// A CS Rating for a skill, by where the skill groups sit in Premier: Silvers 1,000-5,000, Gold Novas to 10,000, Master
// Guardians to 15,000, Legendary Eagles to 20,000, Supremes to 25,000, Global Elites 25,000-30,000. And back.
const RATING_KNOTS = [[1, 1000], [6.5, 5000], [10.5, 10000], [14.5, 15000], [16.5, 20000], [17.5, 25000], [18, 30000]];
const along = (x, knots) => {
  for (let i = 1; i < knots.length; i++) {
    const [x0, y0] = knots[i - 1], [x1, y1] = knots[i];
    if (x <= x1 || i === knots.length - 1) return y0 + (y1 - y0) * Math.max(0, Math.min(1, (x - x0) / (x1 - x0)));
  }
  return knots[0][1];
};
// A skill for a (hidden) competitive rating, and back.
export const skillOfMmr = (mmr) => skillOfGroup(groupValue(mmr));
export const mmrOfSkill = (s) => Math.round(mmrOfGroup(1 + Math.max(0, Math.min(1, s)) * (SKILL_GROUPS.length - 1)));
// The tier a skill group is in.
export const tierOfGroup = (g) => Object.keys(BOT_TIERS).find((t) => g <= BOT_TIERS[t].groups[1]) || 'global';
export const ratingOfSkill = (s) => Math.round(along(1 + Math.max(0, Math.min(1, s)) * (SKILL_GROUPS.length - 1), RATING_KNOTS));
export const skillOfRating = (r) => Math.max(0, Math.min(1, (along(r, RATING_KNOTS.map(([g, v]) => [v, g])) - 1) / (SKILL_GROUPS.length - 1)));

// A bot's skill group in a tier: spread over the tier's groups (one either side now and then), the same for the same name.
export function botSkill(name, tier, rng = Math.random) {
  const { groups: [lo, hi] } = BOT_TIERS[tierOf(tier)];
  let g = lo + Math.floor(rng() * (hi - lo + 1));
  const r = rng();
  if (r < 0.15) g--; else if (r > 0.85) g++;
  g = Math.max(1, Math.min(SKILL_GROUPS.length, g));
  return Math.max(0, Math.min(1, skillOfGroup(g) + (rng() - 0.5) * 0.03));
}

// A matchmade bot: its own rank near yours, the spread CS2's matchmaking puts in a lobby. mmr: your competitive or
// wingman rating to match (see ranks.js matchmakingMmr), or rating: your CS Rating (Premier). Mostly within a skill
// group either way (about 1,000 CS Rating), now and then one or two.
export function matchedSkill({ mmr = null, rating = null }, rng = Math.random) {
  const off = (rng() + rng() + rng() - 1.5) * 1.3; // (-2..2, mostly within one)
  if (rating != null) return skillOfRating(Math.max(0, Math.min(35000, rating + off * 1100)));
  return skillOfMmr(mmr + off * 55);
}

// The bot ranks a private match can have: a tier (each bot its own rank in it) or one skill group, as 'tier:gold' or
// 'group:7'. [{ id, name, groups: [[id, name]] }] for the lobby's list.
export const PRIVATE_RANKS = Object.entries(BOT_TIERS).map(([id, t]) => ({
  id: 'tier:' + id, name: t.name,
  groups: Array.from({ length: t.groups[1] - t.groups[0] + 1 }, (_, i) => ['group:' + (t.groups[0] + i), SKILL_GROUPS[t.groups[0] + i - 1]]),
}));
// A private match's bot of that rank (a tier as before, the old Easy..Expert too; a skill group a little either side).
export function privateSkill(choice, name, rng = Math.random) {
  const g = /^group:(\d+)$/.exec(choice || '');
  if (g) return Math.max(0, Math.min(1, skillOfGroup(Number(g[1])) + (rng() - 0.5) * 0.03));
  return botSkill(name, tierOf(String(choice || '').replace(/^tier:/, '')), rng);
}

const lerp = (a, b, t) => a + (b - a) * t;
// Values at Silver I (s 0) and The Global Elite (s 1), eased in between (ranks don't improve evenly).
const RANGE = {
  reactMin: [0.6, 0.12], reactMax: [1.0, 0.21], turn: [200, 900], aimErr: [8.5, 1.5], head: [0.1, 0.72], control: [0.2, 0.93],
  fov: [85, 120], hear: [0.5, 1], burst: [3, 30],
  // Crosshair placement: how far below head height it rests while walking and holding (degrees).
  crosshair: [14, 0.5],
  // Counter-strafing: how long it keeps moving after it starts shooting (inaccurate) before it's stopped.
  strafe: [0.4, 0.03],
  // Knowing its gun: how far it waits for a shot that will land (stopped, the spray's penalty and recoil worn off) rather
  // than firing anyway, walking and spraying at range.
  discipline: [0.05, 1],
  // Utility: the chance it throws the lineup its plan gives it, and how far off its aim is (degrees).
  utility: [0.12, 0.97], utilityErr: [6, 0.08],
  // Patience: holding an angle and waiting for the team rather than peeking alone; trading: going for a teammate's
  // killer at once.
  patience: [0.15, 0.92], trade: [0.15, 0.95],
};

// Everything a bot of skill s does differently (see Brain).
export function skillParams(s) {
  s = Math.max(0, Math.min(1, s));
  const e = s * s * (3 - 2 * s) * 0.6 + s * 0.4; // a little slower at the ends
  const v = Object.fromEntries(Object.entries(RANGE).map(([k, [a, b]]) => [k, lerp(a, b, e)]));
  return {
    skill: s, reaction: [v.reactMin, v.reactMax], turn: v.turn, aimErr: v.aimErr, head: v.head, control: v.control, fov: v.fov, hear: v.hear,
    burst: Math.round(v.burst), crosshair: v.crosshair, strafe: v.strafe, discipline: v.discipline, utility: v.utility, utilityErr: v.utilityErr, patience: v.patience,
    trade: v.trade, popFlash: s > 0.55, executes: s > 0.35,
  };
}
