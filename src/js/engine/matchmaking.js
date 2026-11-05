// CS2's matchmaking rules that stay with you between matches: which modes are ranked, how long a match you left waits
// for you to reconnect, and the cooldown for abandoning one (leaving it for good, or not coming back in time): no
// Premier, Competitive or Wingman until it's over. Each abandon within a week of the last makes the next cooldown
// longer: 30 minutes, 2 hours, a day, then a week. Pure (no DOM): the same code runs on the local save and on the server.

export const RANKED_MODES = ['premier', 'competitive', 'wingman'];
export const isRanked = (mode) => RANKED_MODES.includes(mode);
export const RECONNECT_S = 5 * 60;
export const COOLDOWNS = [30 * 60e3, 2 * 3600e3, 24 * 3600e3, 7 * 24 * 3600e3];
const FORGIVEN = 7 * 24 * 3600e3; // a week without an abandon: the next cooldown is the shortest again

// offenses: abandons counted towards the next cooldown; until: when the cooldown ends; match: the ranked match you're
// in ({ mode, opponent, at }), kept until it's finished (or abandoned), so a match you quit the game during counts.
export function freshMM() { return { offenses: 0, lastOffense: 0, until: 0, match: null }; }

export const cooldownLeft = (mm, now = Date.now()) => Math.max(0, (mm?.until || 0) - now);

// Staff took a cooldown away: it's over, and the abandons behind it don't count towards the next one. The match you're in stays.
export const forgive = (mm) => ({ ...freshMM(), ...(mm || {}), offenses: 0, lastOffense: 0, until: 0 });

// How long the next abandon's cooldown would be.
export function nextCooldown(mm, now = Date.now()) {
  mm = { ...freshMM(), ...(mm || {}) };
  const n = now - mm.lastOffense > FORGIVEN ? 0 : mm.offenses;
  return COOLDOWNS[Math.min(n, COOLDOWNS.length - 1)];
}

// An abandoned match: the cooldown starts. Returns { mm, ms } (the new state and the cooldown's length).
export function abandon(mm, now = Date.now()) {
  mm = { ...freshMM(), ...(mm || {}) };
  const ms = nextCooldown(mm, now);
  if (now - mm.lastOffense > FORGIVEN) mm.offenses = 0;
  mm.offenses++;
  mm.lastOffense = now;
  mm.until = Math.max(mm.until, now + ms);
  mm.match = null;
  return { mm, ms };
}

// A wait as words: "45 seconds", "28 minutes", "1 hour 59 minutes", "6 days 23 hours".
export function formatWait(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const unit = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (s < 60) return unit(s, 'second');
  const m = Math.ceil(s / 60);
  if (m < 60) return unit(m, 'minute');
  const h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d) return unit(d, 'day') + (h % 24 ? ' ' + unit(h % 24, 'hour') : '');
  return unit(h, 'hour') + (m % 60 ? ' ' + unit(m % 60, 'minute') : '');
}
