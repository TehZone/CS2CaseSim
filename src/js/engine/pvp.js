// Online PvP for Play (Competitive 5v5 and Wingman 2v2): the rules both sides share, in one place. Pure (no DOM, no Node):
// the server (server/matchmaking.mjs, server/relay.mjs) and the game (src/js/pvp.js, src/js/play/net-*.js) import it.
//
// One player's game hosts the match (a listen server: movement, shooting, bots, rounds), everyone else's sends its inputs
// and gets the match's state, relayed through the server's /match socket. The server can't simulate a match (it has no
// maps): it runs the queue, picks the map, the teams, the bots' skill and the host, keeps its own timestamped log of the
// rounds as they end, and pays from that log, checked here (checkRound, payPlan), not from what any one game says at the
// end. A host could still fake its own match: what faking can pay is bounded to what the same player could claim from a
// bot match, and playing the same opponents again and again pays less and then nothing (farmMultiplier).
import { ACTIVE_DUTY } from './premier.js';
import { SKILL_GROUPS, groupValue, mmrOfGroup } from './ranks.js';

export const PVP_CAP = 'pvp1'; // the capability a game announces in its hello (server/index.mjs CAPS)

const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR;

// The modes: play/match.js RULES and modes.js WINGMAN_RULES, matchmaking's length 'long', no overtime. size: a squad's
// players (humans and bots), lobby: the humans a full match has. minGap and softGap (seconds): the shortest a round can be
// from one round's end to the next (freeze time + 5 s), and the average under which it pays half (freeze + the end delay of
// 7 s + 10 s). Slots: squad A's first, then B's.
export const MODES = Object.freeze({
  competitive: Object.freeze({ id: 'competitive', name: 'Competitive', size: 5, lobby: 10, winsNeeded: 13, maxRounds: 24, draw: 12, freeze: 15, endDelay: 7, enemies: 5, rankKey: 'rank', minGap: 20, softGap: 32 }),
  wingman: Object.freeze({ id: 'wingman', name: 'Wingman', size: 2, lobby: 4, winsNeeded: 9, maxRounds: 16, draw: 8, freeze: 10, endDelay: 7, enemies: 2, rankKey: 'wingman', minGap: 15, softGap: 27 }),
});
export const PVP_MODES = Object.keys(MODES);
export const modeOf = (mode) => (Object.hasOwn(MODES, mode) ? MODES[mode] : null);
export const SQUADS = ['A', 'B'];
export const otherSquad = (sq) => (sq === 'A' ? 'B' : 'A');
// A slot's squad, and a squad's slots (A: 0..size-1, B: size..2·size-1).
export const squadOfSlot = (mode, slot) => (slot < modeOf(mode).size ? 'A' : 'B');
export const slotsOf = (mode, squad) => Array.from({ length: modeOf(mode).size }, (_, i) => (squad === 'A' ? 0 : modeOf(mode).size) + i);

// The simulation and the network (the game's side: net-host.js, net-client.js).
// LAGCOMP_MS: how far back a remote player's shot is tested. Their view is their round trip through the relay (to the
// server and on to the host) plus their interpolation behind: 260-460 ms measured at 75-150 ms pings, so 500 (CS:GO's own
// sv_maxunlag is a second). HOST_QUEUE_MAX: a client's commands the host keeps waiting (TCP loses none: a burst after a
// stall is run, HOST_RUN_MAX a tick, not thrown away); HOST_BANK: the ticks without commands that can be made up later (the
// speed guard: nobody runs more than the time allows, plus that). QUEUE_LO/HI: the fewest commands the host should have
// waiting for a client between two snapshots (the clock nudge keeps it there: fewer, and it runs dry).
export const NET = Object.freeze({
  TICK: 1 / 64, SNAP_TICKS: 2, CMDS_MAX: 4,
  INTERP_MS: 100, INTERP_MIN: 70, INTERP_MAX: 200, EXTRAPOLATE_MS: 50,
  LAGCOMP_MS: 500, HISTORY_TICKS: 64,
  RECONCILE_POS: 0.03, RECONCILE_VEL: 0.1, SMOOTH_MS: 100,
  CLOCK_NUDGE: 0.02, QUEUE_LO: 2, QUEUE_HI: 4, HOST_QUEUE_MAX: 32, HOST_RUN_MAX: 4, HOST_BANK: 32,
});

// The queue (server/matchmaking.mjs).
export const QUEUE = Object.freeze({
  TICK_MS: SEC, FILL_AFTER: 120 * SEC, ACCEPT: 20 * SEC,
  // A dodge (a match found and not accepted, or a map that failed to load): 1 minute, then 5, then 30 for repeats within
  // an hour of the last. Kept with the account (pvp_dodges), so a restart doesn't forget them. A third map that "failed to
  // load" within the hour is an abandon (FAILS: the ones let go as dodges).
  DODGE: [MIN, 5 * MIN, 30 * MIN], DODGE_WINDOW: HOUR, FAILS: 2,
  GRACE: 15 * SEC, // (a queue entry outlives the /ws socket that queued it this long)
  PING_MS: 2 * SEC, RTT_KEEP: 15,
  MAX_MAPS: 30,
});
export const MAP_RE = /^de_[a-z0-9_]{1,32}$/;
export const CONTENT_RE = /^[0-9a-f]{40}$/;

// A match's timers (milliseconds; pauses are left out of every one of them).
export const TIMES = Object.freeze({
  LOAD: 180 * SEC, LOAD_EXPORT: 420 * SEC, // (a member hasn't exported the map yet: it takes minutes the first time)
  LOAD_HZ: 2,
  TAKEOVER_GRACE: 5 * SEC, RECONNECT: 300 * SEC,
  HOST_GRACE: 60 * SEC, HOST_GRACE_MIGRATE: 20 * SEC,
  RESTART_GRACE: 120 * SEC, RESUME_AFTER_HOST: 30 * SEC,
  END_WAIT: 15 * SEC, REPORT_WAIT: 30 * SEC,
  // (The row's `updated`: a crash's pause starts there, so the play since it is all a crash can take from a round's time.)
  HEARTBEAT: 5 * SEC,
  // A host that doesn't go live within LIVE_BY of the start, or logs no round for ROUND_MAX of play, is holding everyone:
  // the match is called off (before live) or ends as the host's fault.
  LIVE_BY: 60 * SEC, ROUND_MAX: 5 * MIN,
  MAX_LIVE: 4 * HOUR, // (a match still going after this is over, whatever its host says: void)
});

// The relay (server/relay.mjs): its limits per socket. Frames: [per second, burst]; bytes per second for a host.
export const RELAY = Object.freeze({
  PATH: '/match', VERSION: 1,
  HELLO_MS: 5 * SEC, PING_MS: 2 * SEC, DEAD_MS: 6 * SEC,
  MAX_PAYLOAD: 32 * 1024,
  CLIENT_BIN: [100, 200], CLIENT_BIN_MAX: 256,
  HOST_BIN: [120, 240], HOST_BIN_MAX: 16 * 1024, HOST_BYTES: 512 * 1024,
  TEXT: [10, 20], TEXT_MAX: 2 * 1024, CHECKPOINT_MAX: 8 * 1024,
  ABUSE_MS: 10 * SEC,
  SKIP_OVER: 64 * 1024, KILL_OVER: 1024 * 1024, STUCK_MS: 10 * SEC,
  INPUT_EVERY_MS: 4, HELLOS_PER_MIN: 30,
  // Pings and pongs a socket may send (a second, a burst); sockets an address may have open before their hello; how often
  // the host is asked for a keyframe for one slot (KEY_MS: the server asks, the host's frames for it aren't held against it).
  CONTROL: [4, 8], PRE_HELLO: 10, KEY_MS: 2 * SEC,
});
// Binary frames' first byte (little-endian after it). The relay reads these headers only, never the game's payload.
export const FRAME = Object.freeze({ CMDS: 0x01, BUNDLE: 0x10, UNICAST: 0x11, INPUTS: 0x81, SNAP: 0x90, UNI: 0x91 });
// /match close codes, and whether the game tries again (RECONNECT_CODES).
export const CLOSE = Object.freeze({
  END: 1000, ABUSE: 1008, RESTART: 1012, NETWORK: 1006,
  REPLACED: 4000, AUTH: 4001, HELLO: 4002, NOT_MEMBER: 4003, OVER: 4004, BANNED: 4005, MAINTENANCE: 4006,
});
export const RECONNECT_CODES = new Set([CLOSE.NETWORK, CLOSE.RESTART]);
export const RECONNECT_BACKOFF = [500, 1000, 2000, 4000];
export const CHAT_MAX = 127;
// A kill's flags (the round's kills list and the KILL event): bit 0 headshot, 1 wallbang, 2 no-scope, 3 through smoke,
// 4 blind, 5 flash assist, 6 the world (fall, bomb), 7 late (the KILL event only: after the round was decided, so not in its
// log, and not in anyone's report either).
export const KILL = Object.freeze({ HS: 1, WALLBANG: 2, NOSCOPE: 4, SMOKE: 8, BLIND: 16, FLASH: 32, WORLD: 64, LATE: 128 });
export const NONE = 255; // (no killer, no assister, no MVP)
export const ROUND_WHY = ['elim', 'bomb', 'defuse', 'time'];

// Host election (pickHost).
export const HOST = Object.freeze({ MAX_RTT: 250, TIE_MS: 10, SAMPLES: 10, MATCH_MIN: 5, QUEUE_MIN: 3, LEFT_DAYS: 7, LEFT_MAX: 2 });
// Anti-farm: within a day, an opponent met in that many earlier matches pays this much (the highest count among them).
export const FARM = Object.freeze({ WINDOW: DAY, STEPS: [[8, 0], [5, 0.25], [3, 0.5]] });
export const NETWORK_DAYS = 30;

// ---- bots' skill (the same as play/skill.js, which isn't under engine/: kept equal by scripts/test-engine.mjs) ----------
const skillOfGroup = (g) => Math.max(0, Math.min(1, (g - 1) / (SKILL_GROUPS.length - 1)));
export const skillOfMmr = (mmr) => skillOfGroup(groupValue(mmr));
export const mmrOfSkill = (s) => Math.round(mmrOfGroup(1 + Math.max(0, Math.min(1, s)) * (SKILL_GROUPS.length - 1)));
export function matchedSkill({ mmr }, rng = Math.random) {
  const off = (rng() + rng() + rng() - 1.5) * 1.3;
  return skillOfMmr(mmr + off * 55);
}

// ---- maps ----------------------------------------------------------------------------------------------------------------
// The maps a mode is played on: Competitive, the Active Duty pool; Wingman, CS2's own pool, as each game reads it from its
// CS2 install (null: whatever a game names, as long as it's a map id).
export const poolOf = (mode) => (mode === 'competitive' ? ACTIVE_DUTY : null);
// A queue request's maps, checked: Map(id -> { c, x }) of the mode's pool, and the Wingman maps that have a site of their
// own (fixed). → { maps, fixed } (bad entries are left out).
export function cleanMaps(mode, maps, fixed) {
  const pool = poolOf(mode), out = new Map();
  for (const m of Array.isArray(maps) ? maps.slice(0, QUEUE.MAX_MAPS) : []) {
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || typeof m.c !== 'string') continue;
    if (!MAP_RE.test(m.id) || !CONTENT_RE.test(m.c) || (pool && !pool.includes(m.id)) || out.has(m.id)) continue;
    out.set(m.id, { c: m.c, x: m.x === true });
  }
  const fx = new Set(mode === 'wingman' && Array.isArray(fixed) ? fixed.filter((id) => typeof id === 'string' && out.has(id)) : []);
  return { maps: out, fixed: fx };
}
const groupKey = (id, c) => id + '|' + c;
// Queue entries by the maps they can load: 'id|content' -> [entries], each list in the order given.
export function mapGroups(entries) {
  const g = new Map();
  for (const e of entries) {
    for (const [id, m] of e.maps) {
      const k = groupKey(id, m.c);
      if (!g.has(k)) g.set(k, []);
      g.get(k).push(e);
    }
  }
  return g;
}
const byAge = (a, b) => a.since - b.since || a.userId - b.userId;

// The next lobby from a mode's queue, or null. entries: [{ userId, since, maps: Map(id -> { c, x }), off? }] (off: not
// matchable right now, its socket gone). Every call sets each entry's `alone` (waited FILL_AFTER and nobody shares a map).
// 1. A full lobby: oldest first, each entry's map groups; one with a lobby's worth takes it and the oldest others.
// 2. Fill: an entry that has waited fillAfter takes its biggest map group (ties: the most exported, then at random) when
//    two or more are in it, and the oldest others up to a lobby. (Each such entry in turn, oldest first: one that shares
//    no map with anyone doesn't hold up the next.)
// → { members (the chosen entries, oldest first), fill (whether it's short of a full lobby) }
export function pickLobby(entries, now, { lobby, fillAfter = QUEUE.FILL_AFTER, rng = Math.random } = {}) {
  const live = entries.filter((e) => !e.off).sort(byAge);
  for (const e of entries) e.alone = false;
  const groups = mapGroups(live);
  const take = (o, grp, fill) => ({ members: [o, ...grp.filter((x) => x !== o).slice(0, lobby - 1)].sort(byAge), fill });
  for (const o of live) {
    for (const [id, m] of o.maps) {
      const grp = groups.get(groupKey(id, m.c));
      if (grp.length >= lobby) return take(o, grp, false);
    }
  }
  for (const o of live) {
    if (now - o.since < fillAfter) break;
    let best = null;
    for (const [id, m] of o.maps) {
      const grp = groups.get(groupKey(id, m.c));
      const score = [grp.length, grp.filter((x) => x.maps.get(id)?.x).length, rng()];
      if (!best || score[0] > best.score[0] || (score[0] === best.score[0] && (score[1] > best.score[1] || (score[1] === best.score[1] && score[2] > best.score[2])))) best = { grp, score };
    }
    if (best && best.grp.length >= 2) return take(o, best.grp, true);
    o.alone = true;
  }
  return null;
}
// The map for a lobby: one every member can load (the same CS2 content), those all of them have exported first, then at
// random. Wingman: the site at random, or none when any member's game says the map has a site of its own (fixed).
// → { id, c, x (all exported), site: 'A' | 'B' | null }
export function pickMap(members, mode, rng = Math.random) {
  let shared = null;
  for (const e of members) {
    const keys = new Set([...e.maps].map(([id, m]) => groupKey(id, m.c)));
    shared = shared ? new Set([...shared].filter((k) => keys.has(k))) : keys;
  }
  const all = [...(shared || [])].sort().map((k) => { const [id, c] = k.split('|'); return { id, c, x: members.every((e) => e.maps.get(id)?.x) }; });
  if (!all.length) return null;
  const ready = all.filter((m) => m.x), from = ready.length ? ready : all;
  const map = from[Math.floor(rng() * from.length) % from.length];
  const site = mode === 'wingman' ? (members.some((e) => e.fixed?.has(map.id)) ? null : rng() < 0.5 ? 'A' : 'B') : null;
  return { ...map, site };
}

// ---- teams -------------------------------------------------------------------------------------------------------------
const SNAKE = 'ABBAABBAAB';
// The squads: the lobby's humans by their mode's rating, highest first, snaked A B B A A B B A A B (so they differ by one
// human at most: 3 players are 1 against 2), humans first in each squad's slots and bots after them, each bot's skill around
// the humans' average rating (play/skill.js matchedSkill: matchmaking's spread). Which squad starts CT is a coin.
// members: [{ userId, mmr, since }]. → { sides: { A: 'CT' | 'T', B }, slots: [{ slot, squad, kind, userId? | skill? }] }
export function splitTeams(members, mode, rng = Math.random) {
  const order = [...members].sort((a, b) => b.mmr - a.mmr || byAge(a, b));
  const squads = { A: [], B: [] };
  order.forEach((m, i) => squads[SNAKE[i % SNAKE.length]].push(m));
  const avg = members.reduce((s, m) => s + m.mmr, 0) / Math.max(1, members.length);
  const slots = [];
  for (const sq of SQUADS) {
    slotsOf(mode, sq).forEach((slot, i) => {
      const h = squads[sq][i];
      slots.push(h ? { slot, squad: sq, kind: 'human', userId: h.userId } : { slot, squad: sq, kind: 'bot', skill: Math.round(matchedSkill({ mmr: avg }, rng) * 1e4) / 1e4 });
    });
  }
  const sides = rng() < 0.5 ? { A: 'CT', B: 'T' } : { A: 'T', B: 'CT' };
  return { sides, slots };
}
// The rating a slot plays at: a human's (their mode's matchmaking rating when the match was made), a bot's from its skill.
export const slotMmr = (s) => (s.kind === 'bot' ? mmrOfSkill(s.skill) : Number(s.mmr) || 0);
// The other squad's average rating (a match's opponent for the rank).
export function opponentOf(slots, squad) {
  const them = slots.filter((s) => s.squad !== squad);
  return Math.round(them.reduce((t, s) => t + slotMmr(s), 0) / Math.max(1, them.length));
}

// ---- host election -----------------------------------------------------------------------------------------------------
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
// A member's round trip to the server: the median of its last samples, from /match (five or more) or else the queue (three
// or more), and its jitter (p90 - p10). Without enough: Infinity.
export function rttScore(m) {
  const from = (m.mrtt?.length || 0) >= HOST.MATCH_MIN ? m.mrtt : (m.qrtt?.length || 0) >= HOST.QUEUE_MIN ? m.qrtt : null;
  if (!from) return { median: Infinity, jitter: 0, samples: 0 };
  const s = from.slice(-HOST.SAMPLES).filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return { median: Infinity, jitter: 0, samples: 0 };
  return { median: quantile(s, 0.5), jitter: quantile(s, 0.9) - quantile(s, 0.1), samples: s.length };
}
// Who hosts: among members connected and ready, the lowest round trip to the server (every other player's path is theirs
// plus the host's, so the lowest is best for all). Anyone over 250 ms goes when anyone is under it; anyone who left 2 or
// more matches they hosted in 7 days goes, unless that leaves nobody. Medians within 10 ms of each other count as equal:
// then the steadier (jitter), fewer host-left matches, the longest queued. With no samples at all, the longest queued.
// members: [{ slot, connected, ready, qrtt, mrtt, hostLeft, since }]. → the members in order: the host, then the backups
// (those dropped by the rules above come last); [] when nobody can host.
export function pickHost(members) {
  const all = members.filter((m) => m.connected && m.ready).map((m) => ({ m, ...rttScore(m) }));
  if (!all.length) return [];
  const bySince = (a, b) => (a.m.since ?? 0) - (b.m.since ?? 0) || a.m.slot - b.m.slot;
  if (all.every((x) => x.median === Infinity)) return all.sort(bySince).map((x) => x.m);
  let c = all;
  if (c.some((x) => x.median < HOST.MAX_RTT)) c = c.filter((x) => x.median <= HOST.MAX_RTT);
  const ok = c.filter((x) => (x.m.hostLeft || 0) < HOST.LEFT_MAX);
  if (ok.length) c = ok;
  c = [...c].sort((a, b) => a.median - b.median);
  const out = [];
  while (c.length) {
    const top = c[0].median, tier = c.filter((x) => x.median <= top + HOST.TIE_MS);
    c = c.filter((x) => !tier.includes(x));
    tier.sort((a, b) => a.jitter - b.jitter || (a.m.hostLeft || 0) - (b.m.hostLeft || 0) || bySince(a, b));
    out.push(...tier);
  }
  const rest = all.filter((x) => !out.includes(x)).sort((a, b) => a.median - b.median || bySince(a, b));
  return [...out, ...rest].map((x) => x.m);
}

// ---- the round log -------------------------------------------------------------------------------------------------------
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
// A round's end as the host sends it, checked in shape: { n, w, why, score: { A, B }, kills: [[killer, victim, assister,
// wid, flags]], mvp, mvpWhy } (killer and assister NONE for none). → the clean round, or null.
export function cleanRound(r, mode) {
  const M = modeOf(mode);
  if (!M || !r || typeof r !== 'object') return null;
  const slots = M.size * 2;
  if (!isInt(r.n, 1, M.maxRounds) || !SQUADS.includes(r.w) || !ROUND_WHY.includes(r.why)) return null;
  if (!r.score || !isInt(r.score.A, 0, M.maxRounds) || !isInt(r.score.B, 0, M.maxRounds)) return null;
  if (!Array.isArray(r.kills) || r.kills.length > slots * 2) return null;
  const kills = [];
  for (const k of r.kills) {
    if (!Array.isArray(k) || k.length < 3) return null;
    const [killer, victim, assister, wid = 0, flags = 0] = k;
    if (!(isInt(killer, 0, slots - 1) || killer === NONE) || !isInt(victim, 0, slots - 1) || !(isInt(assister, 0, slots - 1) || assister === NONE)) return null;
    if (!isInt(wid, 0, 65535) || !isInt(flags, 0, 255)) return null;
    kills.push([killer, victim, assister, wid, flags]);
  }
  if (!(isInt(r.mvp, 0, slots - 1) || r.mvp === NONE)) return null;
  const mvpWhy = typeof r.mvpWhy === 'string' ? r.mvpWhy.slice(0, 24) : isInt(r.mvpWhy, 0, 255) ? r.mvpWhy : null;
  return { n: r.n, w: r.w, why: r.why, score: { A: r.score.A, B: r.score.B }, kills, mvp: r.mvp, mvpWhy };
}
// Whether a round can follow the log: '' if it can, else why not (the match is then void). log: { rounds, score }; gap:
// the time since the last round ended (or the match went live), pauses left out, in ms.
export function checkRound(log, r, { mode, gap }) {
  const M = modeOf(mode);
  if (!r) return 'A round the server couldn\'t read';
  if (endOf(log.score, log.rounds.length, mode)) return 'A round after the match was over';
  if (r.n !== log.rounds.length + 1) return `Round ${r.n} came after round ${log.rounds.length}`;
  const other = otherSquad(r.w);
  if (r.score[r.w] !== log.score[r.w] + 1 || r.score[other] !== log.score[other]) return `Round ${r.n}'s score doesn't follow ${log.score.A}-${log.score.B}`;
  if (!(gap >= M.minGap * SEC)) return `Round ${r.n} ended ${Math.round(gap / 100) / 10} s after the last (at least ${M.minGap} s)`;
  const sq = (s) => squadOfSlot(mode, s), dead = new Set(), lost = { A: 0, B: 0 };
  for (const [killer, victim, , , flags] of r.kills) {
    if (dead.has(victim)) return `Round ${r.n}: a player died twice`;
    // (A player who's dead can still kill: a grenade or the fire of one goes off after its thrower died. Not with a gun's
    // shot, which is all a headshot, a wallbang or a no-scope can be.)
    if (killer !== NONE && dead.has(killer) && (flags & (KILL.HS | KILL.WALLBANG | KILL.NOSCOPE))) return `Round ${r.n}: a dead player shot someone`;
    dead.add(victim);
    if (++lost[sq(victim)] > M.size) return `Round ${r.n}: more deaths than players`;
  }
  if (r.mvp !== NONE && sq(r.mvp) !== r.w) return `Round ${r.n}: the MVP isn't on the team that won it`;
  if (r.why === 'elim' && slotsOf(mode, other).some((s) => !dead.has(s))) return `Round ${r.n} was won by elimination with players left alive`;
  return '';
}
// The match's end by its score: { winner: 'A' | 'B' | null (a draw) } or null (it goes on). n: the rounds played.
export function endOf(score, n, mode) {
  const M = modeOf(mode);
  for (const sq of SQUADS) if (score[sq] >= M.winsNeeded) return { winner: sq };
  if (n >= M.maxRounds && score.A === M.draw && score.B === M.draw) return { winner: null };
  return null;
}
// Each slot's numbers from the log: kills (of enemies), assists (on enemies), deaths and MVPs, counting only the rounds
// that `counts(slot, roundIndex)` says (a player's: those that started while they had control, not a bot).
export function boardOf(rounds, mode, counts = () => true) {
  const b = {}, sq = (s) => squadOfSlot(mode, s);
  const row = (s) => (b[s] ??= { k: 0, a: 0, d: 0, m: 0 });
  rounds.forEach((r, i) => {
    for (const [killer, victim, assister] of r.kills) {
      if (counts(victim, i)) row(victim).d++;
      if (killer !== NONE && killer !== victim && sq(killer) !== sq(victim) && counts(killer, i)) row(killer).k++;
      if (assister !== NONE && assister !== killer && sq(assister) !== sq(victim) && counts(assister, i)) row(assister).a++;
    }
    if (r.mvp !== NONE && counts(r.mvp, i)) row(r.mvp).m++;
  });
  return b;
}

// ---- pay -----------------------------------------------------------------------------------------------------------------
// A report (a game's own count, sent once at the end), checked in shape. from: the first round the game counted from the
// start (one that reloaded mid-match counts from the next round it saw start; 1 when it says nothing); w: the rounds'
// winners as that game saw them (one character a round from round 1, the server's squads, '.' for one it didn't see).
// → { score, me: { k, a, d, m }, stt, from, w } or null.
export function cleanReport(r) {
  if (!r || typeof r !== 'object' || !r.me || typeof r.me !== 'object') return null;
  const n = (v) => (isInt(v, 0, 1000) ? v : 0);
  const score = r.score && isInt(r.score.A, 0, 60) && isInt(r.score.B, 0, 60) ? { A: r.score.A, B: r.score.B } : null;
  const stt = (Array.isArray(r.me.stt) ? r.me.stt : []).slice(0, 20)
    .filter((x) => x && typeof x.uid === 'string' && x.uid.length <= 64 && isInt(x.k, 1, 1000)).map((x) => ({ uid: x.uid, k: x.k }));
  const from = isInt(r.from, 1, 99) ? r.from : 1;
  const w = typeof r.w === 'string' && /^[AB.]{0,60}$/.test(r.w) ? r.w : null;
  return { score, me: { k: n(r.me.k), a: n(r.me.a), d: n(r.me.d), m: n(r.me.m) }, stt, from, w };
}
// Whether a game's report agrees with the log's result: its final score, and each round's winner it saw. → true, false, or
// null (it says nothing about the result).
export function reportAgrees(rounds, score, report) {
  if (!report || (!report.score && !report.w)) return null;
  if (report.score && (report.score.A !== score.A || report.score.B !== score.B)) return false;
  for (let i = 0; i < (report.w?.length || 0); i++) {
    const c = report.w[i];
    if (c !== '.' && rounds[i]?.w !== c) return false;
  }
  return true;
}
// Whether a member was connected through a whole time span (drops: [{ at, back }]).
export const connectedThrough = (drops, from, to) => !(drops || []).some((d) => d.at < to && (d.back == null || d.back > from));
// What a player is paid for: the lower of the log's count and their own game's (report), for kills, assists and MVPs.
// Without a report, the log's. Disputed: their own game counted more than one kill differently from the whole log (every
// round, bot control or not: their game's scoreboard counts those), or another score.
export function crossCheck(counted, raw, report, score) {
  if (!report) return { k: counted.k, a: counted.a, m: counted.m, disputed: false, reported: false };
  const disputed = Math.abs((raw?.k ?? counted.k) - report.me.k) > 1 || (report.score != null && (report.score.A !== score.A || report.score.B !== score.B));
  return { k: Math.min(counted.k, report.me.k), a: Math.min(counted.a, report.me.a), m: Math.min(counted.m, report.me.m), disputed, reported: true };
}
// Repeat opponents: the most earlier matches (within a day, before `now`) a player met any one of these opponents in, on the
// other side; 3 or more pays half, 5 a quarter, 8 nothing. history: [{ match, user, squad, at }] (every member's row of
// every match they played). Teammates don't count: farming needs someone to farm. → { mult, most }
export function farmMultiplier(history, me, opponents, now) {
  const mine = new Map();
  for (const h of history) if (h.user === me && now - h.at <= FARM.WINDOW && h.at <= now) mine.set(h.match, h.squad);
  const counts = new Map(), opp = new Set(opponents);
  for (const h of history) {
    const sq = mine.get(h.match);
    if (sq == null || h.user === me || !opp.has(h.user) || h.squad === sq) continue;
    counts.set(h.user, (counts.get(h.user) || 0) + 1);
  }
  const most = Math.max(0, ...counts.values());
  for (const [n, mult] of FARM.STEPS) if (most >= n) return { mult, most };
  return { mult: 1, most };
}
// Rounds that ended too fast on average (pauses left out): half pay. gaps: ms between round ends (the first from live).
export function paceMultiplier(gaps, mode) {
  if (!gaps.length) return { mult: 1, avg: null };
  const avg = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  return { mult: avg < modeOf(mode).softGap * SEC ? 0.5 : 1, avg };
}
// Whether a slot had control (not a bot for them) when round i started. control: [{ from, back }] (a bot had it from `from`
// until the first round start at or after `back`; back null: never came back); starts: each round's start time.
export const hadControl = (control, start) => !(control || []).some((c) => c.from <= start && (c.back == null || start < c.back));

// Matches cut short: paid for their finished rounds (kills, assists, MVPs), no result, no rank. host-left: the host went;
// host-fault: the host's game broke the log's rules (a round that can't follow it, an end before it, none for too long):
// either way the host abandoned it, and nobody else pays for that.
export const CANCELLED = new Set(['host-left', 'host-fault', 'staff', 'maintenance']);
export const HOST_GONE = new Set(['host-left', 'host-fault']);
const NOTES = {
  pace: 'Rounds ended suspiciously fast: half pay',
  farm: { 0.5: 'Repeat opponents: half pay', 0.25: 'Repeat opponents: a quarter of the pay', 0: 'Repeat opponents: no pay' },
  network: 'An opponent plays from your network: no pay for kills, assists or MVPs',
  cancelled: {
    'host-left': 'The host left: paid for finished rounds', 'host-fault': 'The host\'s game broke the match\'s rules: paid for finished rounds',
    staff: 'Staff ended the match: paid for finished rounds', maintenance: 'The server went into maintenance: paid for finished rounds',
  },
  away: 'Rounds a bot played for you don\'t count',
  afk: 'A bot played most of your rounds: no pay for the result, no rank change',
  contested: 'The players\' games didn\'t agree on how the match went: no pay for the result, no rank change',
};
// Everything a finished match pays, from the server's own log. match: { mode, slots, rounds (each with its `at` and `start`
// in ms, and its `gap`: the time it's counted to have taken), score, liveAt, logEnd, active(from, to) (ms between two times,
// pauses left out), endWhy ('over' | 'host-left' | 'host-fault' | 'staff' | 'maintenance'), voidWhy, hostId, members:
// [{ userId, slot, squad, eligible (connected at the end), abandoned, control, drops }] }. reports: Map(userId ->
// cleanReport). history: farmMultiplier's rows. networks: Set of 'a:b' (lower id first), players who share a network.
//
// What each player is paid for: the rounds they had control in (not a bot for them), the lower of the log's numbers and
// their own game's for the rounds that game counted (from its `from`: one that reloaded mid-match lost what came before, and
// the log's stand for those). The result and the rank go only to a player who had control in at least half the rounds, and
// to nobody when most of the other players' own games (the host's isn't asked) say the match went otherwise than the host's
// log (contested: the host is the one who can make the log say anything).
// →
//   { void: why | null, contested, against: [userIds whose games disagreed], users: [{ userId, slot, squad, result ('win' |
//     'draw' | 'loss' | null), kills, assists, mvps, roundsWon, roundsFor, roundsAgainst, opponent, mult, rank (move the
//     rank), notes, stt, disputed, board, outcome }], left: [userIds connected at no point at the end, not paid] }
export function payPlan(match, reports = new Map(), history = [], networks = new Set()) {
  const M = modeOf(match.mode);
  const out = { void: match.voidWhy || null, users: [], left: [], contested: false, against: [] };
  if (out.void) return out;
  const cancelled = CANCELLED.has(match.endWhy);
  const rounds = match.rounds || [], score = match.score || { A: 0, B: 0 }, n = rounds.length;
  const end = endOf(score, n, match.mode);
  if (!cancelled && !end) return { ...out, void: 'The match ended before its score did' };
  // (bounds, as play.reward's: each also holds round by round, checked again here before anything is paid)
  const active = match.active || ((a, b) => b - a);
  const gaps = rounds.map((r) => r.gap ?? active(r.start, r.at));
  if (n && gaps.reduce((s, g) => s + g, 0) < n * M.minGap * SEC) return { ...out, void: 'The rounds were shorter than they can be' };
  const starts = rounds.map((r) => r.start);
  const pace = paceMultiplier(gaps, match.mode);
  const humans = match.members.filter((m) => !m.abandoned);
  const mvpBy = { A: 0, B: 0 };
  for (const r of rounds) if (r.mvp !== NONE) mvpBy[squadOfSlot(match.mode, r.mvp)]++;
  for (const sq of SQUADS) if (mvpBy[sq] > score[sq]) return { ...out, void: 'More MVPs than rounds won' };
  const words = [];
  for (const m of humans) {
    if (m.userId === match.hostId || !m.eligible) continue;
    const w = reportAgrees(rounds, score, reports.get(m.userId));
    if (w != null) words.push([m.userId, w]);
  }
  out.against = words.filter(([, w]) => !w).map(([id]) => id);
  out.contested = !cancelled && out.against.length > 0 && out.against.length * 2 > words.length;
  const none = { k: 0, a: 0, d: 0, m: 0 };
  for (const m of humans) {
    if (cancelled && m.userId === match.hostId && HOST_GONE.has(match.endWhy)) continue;
    if (!m.eligible) { out.left.push(m.userId); continue; }
    const report = reports.get(m.userId) || null, control = m.control || [];
    const ctl = (i) => hadControl(control, starts[i]);
    const mine = (pred) => boardOf(rounds, match.mode, (s, i) => s !== m.slot || pred(i))[m.slot] || none;
    const f = Math.max(0, Math.min(n, (report?.from ?? 1) - 1));
    const counted = mine(ctl), before = mine((i) => i < f && ctl(i)), raw = mine(() => true);
    const after = { k: counted.k - before.k, a: counted.a - before.a, m: counted.m - before.m };
    // (Disputed, for staff: their game counted more than a kill fewer than the log has in the rounds it saw whole, or more
    // than a kill more than the log has since it started counting; or another result.)
    const seen = mine((i) => i >= f && connectedThrough(m.drops, starts[i], rounds[i].at)), since = mine((i) => i >= f);
    const disputed = !!report && (report.me.k + 1 < seen.k || report.me.k > since.k + 1 || reportAgrees(rounds, score, report) === false);
    const sq = m.squad, them = otherSquad(sq), notes = [];
    if (counted.k !== raw.k || counted.a !== raw.a || counted.m !== raw.m) notes.push(NOTES.away);
    let kills = before.k + (report ? Math.min(after.k, report.me.k) : after.k);
    let assists = before.a + (report ? Math.min(after.a, report.me.a) : after.a);
    let mvps = before.m + (report ? Math.min(after.m, report.me.m) : after.m);
    if (kills > n * M.enemies || assists > n * M.enemies || mvps > score[sq]) return { ...out, void: 'A player\'s numbers don\'t add up' };
    // (Every human on the other side, one who abandoned too: a host who left after letting you farm their side is still
    // the opponent you farmed, for the repeat and network rules.)
    const opponents = match.members.filter((o) => o.squad !== sq).map((o) => o.userId);
    if (opponents.some((o) => networks.has(m.userId < o ? `${m.userId}:${o}` : `${o}:${m.userId}`))) {
      kills = assists = mvps = 0;
      notes.push(NOTES.network);
    }
    const farm = farmMultiplier(history, m.userId, opponents, match.created ?? match.liveAt ?? Infinity);
    if (farm.mult < 1) notes.push(NOTES.farm[farm.mult]);
    if (pace.mult < 1) notes.push(NOTES.pace);
    const afk = !cancelled && n > 0 && rounds.filter((_, i) => ctl(i)).length * 2 < n;
    if (cancelled) notes.unshift(NOTES.cancelled[match.endWhy]);
    else if (out.contested) notes.unshift(NOTES.contested);
    else if (afk) notes.unshift(NOTES.afk);
    const mult = farm.mult * pace.mult;
    const result = cancelled || out.contested || afk ? null : end.winner == null ? 'draw' : end.winner === sq ? 'win' : 'loss';
    let budget = kills;
    const stt = [];
    for (const x of report?.stt || []) { const k = Math.min(x.k, budget); if (k > 0) { stt.push({ uid: x.uid, k }); budget -= k; } }
    out.users.push({
      userId: m.userId, slot: m.slot, squad: sq, result, kills, assists, mvps, roundsWon: score[sq], roundsFor: score[sq], roundsAgainst: score[them],
      opponent: opponentOf(match.slots, sq), mult, rank: result != null && mult > 0, notes, stt, disputed, reported: !!report,
      board: { k: counted.k, a: counted.a, d: counted.d, m: counted.m },
      outcome: result || (cancelled ? 'partial' : out.contested ? 'contested' : 'away'), farm: farm.most, pace: pace.avg,
    });
  }
  return out;
}
