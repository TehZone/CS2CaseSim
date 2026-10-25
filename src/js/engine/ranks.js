// CS:GO's competitive ranks: one skill group for all maps (not CS2's rating per map), from Silver I to The Global
// Elite; Wingman has its own rank on the same groups. A hidden rating (MMR, Elo-like) moves with every matchmade match
// against the bots: up on a win, down on a loss, a little either way on a tie, more for a bigger round difference and
// depending on how strong the bots were (matchmaking finds them around your rank: see matchmakingMmr).
// The rank is hidden until 10 wins ("need wins", like CS:GO's placement), then moves at most one group a match: up
// only after a win, down only after a loss. It shows as expired after 30 days without a win, until the next one.
// Pure (no DOM): the same code runs on the local save and on the server.

export const SKILL_GROUPS = ['Silver I', 'Silver II', 'Silver III', 'Silver IV', 'Silver Elite', 'Silver Elite Master',
  'Gold Nova I', 'Gold Nova II', 'Gold Nova III', 'Gold Nova Master', 'Master Guardian I', 'Master Guardian II',
  'Master Guardian Elite', 'Distinguished Master Guardian', 'Legendary Eagle', 'Legendary Eagle Master',
  'Supreme Master First Class', 'The Global Elite'];
export const SHORT_NAMES = ['S1', 'S2', 'S3', 'S4', 'SE', 'SEM', 'GN1', 'GN2', 'GN3', 'GNM', 'MG1', 'MG2', 'MGE', 'DMG', 'LE', 'LEM', 'SMFC', 'GE'];

// The rating each group starts at (group 1 below the first).
const STARTS = [700, 760, 820, 880, 940, 1000, 1060, 1120, 1180, 1240, 1300, 1360, 1420, 1480, 1540, 1600, 1680];
export const PLACEMENT_WINS = 10;
export const START_MMR = 1000;
const EXPIRES = 30 * 24 * 3600 * 1000;
// What the bots are worth on the same scale (beating Expert bots often enough gets you to The Global Elite).
export const BOT_MMR = { easy: 700, normal: 1000, hard: 1300, expert: 1600 };

export function freshRank() {
  return { mmr: START_MMR, group: 0, wins: 0, losses: 0, ties: 0, lastWin: 0 };
}

// The group (1..18) a rating is in.
export function groupFor(mmr) {
  let g = 1;
  for (const s of STARTS) if (mmr >= s) g++;
  return g;
}

// What to show for a rank: { group (0 unranked), name, short, needWins (wins still needed), expired }.
export function rankInfo(r, now = Date.now()) {
  r = r || freshRank();
  const needWins = r.group ? 0 : Math.max(0, PLACEMENT_WINS - (r.wins || 0));
  const expired = !!r.group && !!r.lastWin && now - r.lastWin > EXPIRES;
  return {
    group: r.group || 0, needWins, expired,
    name: r.group ? SKILL_GROUPS[r.group - 1] : 'Unranked',
    short: r.group ? SHORT_NAMES[r.group - 1] : '–',
  };
}

// A rating's place among the groups as one number: 1 (Silver I) .. 18 (The Global Elite), fractions in between, each
// group's middle rating on its whole number (the first and last groups' a half-width past their edge). And back.
const MIDDLES = [STARTS[0] - 30, ...STARTS.slice(1).map((s, i) => (STARTS[i] + s) / 2), STARTS[STARTS.length - 1] + 40];
export function groupValue(mmr) {
  if (mmr <= MIDDLES[0]) return 1;
  for (let i = 1; i < MIDDLES.length; i++) if (mmr < MIDDLES[i]) return i + (mmr - MIDDLES[i - 1]) / (MIDDLES[i] - MIDDLES[i - 1]);
  return MIDDLES.length;
}
export function mmrOfGroup(g) {
  g = Math.max(1, Math.min(MIDDLES.length, g));
  const i = Math.min(MIDDLES.length - 2, Math.floor(g) - 1);
  return MIDDLES[i] + (MIDDLES[i + 1] - MIDDLES[i]) * (g - 1 - i);
}
// The rating matchmaking finds your opponents by: your rank's (its group's middle) once you have one, else the hidden
// one your placement will go by.
export function matchmakingMmr(r) {
  r = { ...freshRank(), ...(r || {}) };
  return r.group ? MIDDLES[r.group - 1] : r.mmr;
}

// A finished competitive (or wingman) match: result 'win' | 'loss' | 'tie', the rounds each side won, and how strong
// the other team was: opponent (their average rating) or, from before matchmaking, the bots' difficulty.
// Returns the new rank and what happened: { rank, delta (rating), change: 'up' | 'down' | 'placed' | null, before, after }.
export function rateMatch(r, { result, roundsFor = 0, roundsAgainst = 0, difficulty = 'normal', opponent = null, now = Date.now() }) {
  r = { ...freshRank(), ...(r || {}) };
  const before = r.group;
  const score = result === 'win' ? 1 : result === 'tie' ? 0.5 : 0;
  const opp = Number.isFinite(opponent) ? opponent : BOT_MMR[difficulty] ?? BOT_MMR.normal;
  const expected = 1 / (1 + 10 ** ((opp - r.mmr) / 400));
  // Placement moves faster; a bigger win (or loss) moves further.
  const k = r.group ? 25 : 40;
  const margin = result === 'tie' ? 1 : 1 + 0.6 * Math.min(1, Math.abs(roundsFor - roundsAgainst) / 10);
  const delta = Math.round(k * margin * (score - expected));
  r.mmr += delta;
  if (result === 'win') { r.wins++; r.lastWin = now; } else if (result === 'tie') r.ties++; else r.losses++;
  let change = null;
  const target = groupFor(r.mmr);
  if (!r.group) {
    if (r.wins >= PLACEMENT_WINS) { r.group = target; change = 'placed'; }
  } else if (result === 'win' && target > r.group) { r.group++; change = 'up'; }
  else if (result === 'loss' && target < r.group) { r.group--; change = 'down'; }
  return { rank: r, delta, change, before, after: r.group };
}

// A bot's rank, from its difficulty with a little spread (the same for the same name and difficulty).
export function botGroup(name, difficulty = 'normal') {
  let h = 2166136261;
  for (const ch of String(name) + difficulty) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const jitter = ((h >>> 0) % 181) - 90;
  return groupFor((BOT_MMR[difficulty] ?? BOT_MMR.normal) + jitter);
}
