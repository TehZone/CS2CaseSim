// How good a bot is, from its rank: one number, skill (0 a Silver I, 1 The Global Elite), that sets everything it does —
// how fast it reacts and turns, how far off its first shot is and how it controls a spray, where its crosshair rests,
// how quickly it stops to shoot (counter-strafing), how much utility it throws and how well, how patient it is and how
// quickly it trades a teammate. A match's bots come from the tier you pick in the lobby, each its own rank within it:
// a skill group in Competitive, a CS Rating in Premier (see ranks.js, premier.js).
import { SKILL_GROUPS } from '../engine/ranks.js';

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

const lerp = (a, b, t) => a + (b - a) * t;
// Values at Silver I (s 0) and The Global Elite (s 1), eased in between (ranks don't improve evenly).
const RANGE = {
  reactMin: [0.6, 0.12], reactMax: [1.0, 0.21], turn: [200, 900], aimErr: [8.5, 1.5], head: [0.1, 0.72], control: [0.2, 0.93],
  fov: [85, 120], hear: [0.5, 1], burst: [3, 30],
  // Crosshair placement: how far below head height it rests while walking and holding (degrees).
  crosshair: [14, 0.5],
  // Counter-strafing: how long it keeps moving after it starts shooting (inaccurate) before it's stopped.
  strafe: [0.4, 0.03],
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
    burst: Math.round(v.burst), crosshair: v.crosshair, strafe: v.strafe, utility: v.utility, utilityErr: v.utilityErr, patience: v.patience,
    trade: v.trade, popFlash: s > 0.55, executes: s > 0.35,
  };
}
