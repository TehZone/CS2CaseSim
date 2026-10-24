// CS2's Premier: a CS Rating (one number, 0 to 35,000+) instead of skill groups. You're unrated until 10 wins; every
// match after that moves it, more for a win against a stronger team (or a loss against a weaker one) and a bigger
// round difference. Its colour shows the tier: grey under 5,000, light blue to 10,000, blue to 15,000, purple to 20,000,
// pink to 25,000, red to 30,000, gold above. Pure (no DOM): the same code runs on the local save and on the server.

export const PLACEMENT_WINS = 10;
export const START_RATING = 8000; // where the hidden rating starts (shown after the placement wins)
export const MAX_RATING = 40000;
export const TIERS = [
  { min: 0, name: 'Grey', color: '#b0c3d9' }, { min: 5000, name: 'Light blue', color: '#8cc6ff' },
  { min: 10000, name: 'Blue', color: '#6a7dff' }, { min: 15000, name: 'Purple', color: '#c166ff' },
  { min: 20000, name: 'Pink', color: '#f03cff' }, { min: 25000, name: 'Red', color: '#eb4b4b' },
  { min: 30000, name: 'Gold', color: '#ffd700' },
];

export function freshPremier() { return { rating: START_RATING, wins: 0, losses: 0, ties: 0, matches: 0, best: 0 }; }

export const tierOf = (rating) => TIERS.reduce((t, x) => (rating >= x.min ? x : t), TIERS[0]);
export const formatRating = (rating) => Math.round(rating).toLocaleString('en-US');

// What to show: { rated, rating (null while unrated), needWins, tier, text }.
export function premierInfo(p) {
  p = { ...freshPremier(), ...(p || {}) };
  const rated = p.wins >= PLACEMENT_WINS;
  const tier = tierOf(p.rating);
  return { rated, rating: rated ? p.rating : null, needWins: rated ? 0 : PLACEMENT_WINS - p.wins, tier: rated ? tier : null,
    text: rated ? formatRating(p.rating) : `${PLACEMENT_WINS - p.wins} wins to a rating` };
}

// The chance of beating a team rated `opp` (CS Ratings are about ten times Elo's scale).
export const expectedScore = (rating, opp) => 1 / (1 + 10 ** ((opp - rating) / 4000));

// A finished Premier match: result 'win' | 'loss' | 'tie', rounds each side won, the other team's average rating.
// Returns { premier, delta, before, after, placed }.
export function ratePremier(p, { result, roundsFor = 0, roundsAgainst = 0, opponent = START_RATING }) {
  p = { ...freshPremier(), ...(p || {}) };
  const before = p.wins >= PLACEMENT_WINS ? p.rating : null;
  const score = result === 'win' ? 1 : result === 'tie' ? 0.5 : 0;
  const margin = result === 'tie' ? 1 : 1 + 0.5 * Math.min(1, Math.abs(roundsFor - roundsAgainst) / 12);
  // Placement moves the hidden rating faster.
  const k = p.wins >= PLACEMENT_WINS ? 600 : 1000;
  const delta = Math.round(k * margin * (score - expectedScore(p.rating, opponent)));
  p.rating = Math.max(0, Math.min(MAX_RATING, p.rating + delta));
  p.matches++;
  if (result === 'win') p.wins++; else if (result === 'tie') p.ties++; else p.losses++;
  const rated = p.wins >= PLACEMENT_WINS;
  if (rated) p.best = Math.max(p.best || 0, p.rating);
  return { premier: p, delta, before, after: rated ? p.rating : null, placed: rated && before == null };
}

// Active Duty: the map pool Premier picks from (the installed ones of these).
export const ACTIVE_DUTY = ['de_ancient', 'de_anubis', 'de_dust2', 'de_inferno', 'de_mirage', 'de_nuke', 'de_train', 'de_overpass', 'de_vertigo'];
// CS2's Premier pick/ban over seven maps: the first team bans two, the second three, the first one more; the map left
// is played and the second team picks its starting side. ['A' | 'B', 'ban'] steps.
export const VETO = [['A', 'ban'], ['A', 'ban'], ['B', 'ban'], ['B', 'ban'], ['B', 'ban'], ['A', 'ban']];
