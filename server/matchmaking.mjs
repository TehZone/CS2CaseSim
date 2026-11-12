// Online PvP for Play (Competitive and Wingman): the queue, the accept, loading, the host, the match's own log of its rounds,
// disconnects and abandons, and the pay (ns 'pvp' on /ws; the match's traffic goes through server/relay.mjs on /match). The
// rules and numbers are src/js/engine/pvp.js, shared with the game.
//
// Only a connection whose hello announced pvp1 (index.mjs CAPS) can ask anything here or is sent anything from here: a game
// without it is refused ('outdated'), and 1.1.7 never asks.
//
// The server can't play a match (it has no maps). One player's game hosts it, chosen by the round trip measured while
// queued and loading (engine pvp.js pickHost), and every other game sends it inputs through the relay. As each round ends
// the host says how ({ t: 'round' }); the server checks it against what it can know (the score steps by one, the time since
// the last round, who died and who killed: engine checkRound) and logs it by its own clock. A round that breaks the log is
// the host's fault: the match ends there, the others paid for its finished rounds, the host an abandon (hostFault). At the
// end each player's own game reports its own numbers and the result it saw, and each player is paid once (pvp_players.paid,
// in the transaction that pays them) the lower of the log's and their own, as a bot match pays, less for repeat opponents
// and rounds that were too quick, and nobody the result when most other players' games saw another (engine payPlan,
// actions.js 'pvp.reward').
//
// Matches are rows (pvp_matches): a restart pauses every live one, and they resume once their players are back (restore).
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { makeCtx, runAction, delta, GameError } from '../src/js/engine/actions.js';
import * as MM from '../src/js/engine/matchmaking.js';
import { matchmakingMmr, rankInfo, groupFor } from '../src/js/engine/ranks.js';
import { loadoutSlot, itemDef } from '../src/js/engine/items.js';
import { publicCopy } from '../src/js/engine/database.js';
import { featuredBadge } from '../src/js/engine/badges.js';
import { textProblem } from '../src/js/engine/tools.js';
import * as V from '../src/js/engine/pvp.js';
import { isPicHash } from './social.mjs';

export const PVP = V.PVP_CAP;
const SEC = 1000, MIN = 60 * SEC, DAY = 24 * 60 * MIN;
const fail = (m, code = 'bad') => { throw new GameError(m, code); };
const SERVER = { name: 'Server' }; // (the audit log's actor for what the server does by itself)
const OPEN = new Set(['loading', 'live', 'paused']);
// Per player, over a sliding window.
const LIMITS = {
  queue: [{ max: 10, ms: MIN, say: 'Slow down: at most 10 searches a minute' }],
  leave: [{ max: 10, ms: MIN, say: 'Slow down: too many changes to your search' }],
  decline: [{ max: 10, ms: MIN, say: 'Slow down: too many declines' }],
  accept: [{ max: 5, ms: 10 * SEC, say: 'Slow down: too many accepts' }],
  state: [{ max: 30, ms: 10 * SEC, say: 'Slow down: too many requests' }],
  abandon: [{ max: 10, ms: MIN, say: 'Slow down: too many requests' }],
};
const MSG = {
  over: 'Match over',
  void: 'This match couldn\'t be verified: no reward',
  'host-left': 'The host left: paid for finished rounds',
  'host-fault': 'The host\'s game broke the match\'s rules: paid for finished rounds',
  staff: 'Staff ended this match: paid for finished rounds',
  staffVoid: 'Staff ended this match: no reward',
  maintenance: 'The server is going into maintenance: paid for finished rounds',
};
const TICK_MS = V.NET.TICK * SEC;
class Settled extends Error {} // (a pvp_players row someone already settled: the transaction rolls back)
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const newId = () => crypto.randomBytes(9).toString('base64url');

// What a player looks like in a match: the agents, knife, gloves and gun skins they have equipped, as the item database shows
// an item (publicCopy). guns: by the gun's weapon id (weapon_ak47).
export function lookOf(st) {
  const owned = (slot, uid) => { const it = uid ? (st.inv || []).find((i) => i.uid === uid) : null; return it && loadoutSlot(it) === slot ? it : null; };
  const one = (slot) => { const it = owned(slot, st.loadout?.[slot]); return it ? publicCopy(it) : null; };
  const guns = {};
  for (const [slot, uid] of Object.entries(st.loadout || {})) {
    if (!slot.startsWith('w:')) continue;
    const it = owned(slot, uid), d = it && itemDef(it);
    if (d?.wid) guns[d.wid] = publicCopy(it);
  }
  return { agentT: one('agentT'), agentCT: one('agentCT'), knife: one('knife'), gloves: one('gloves'), guns };
}

export class PvP {
  // clock: the server's (tests move it). tick: false, and the tests call tick() themselves. fillAfter: how long a queue
  // waits before it splits the players it has (V.QUEUE.FILL_AFTER). times: V.TIMES overrides (tests).
  constructor(srv, { clock = Date.now, tick = true, fillAfter = V.QUEUE.FILL_AFTER, rng = Math.random, times = {} } = {}) {
    this.srv = srv;
    this.db = srv.db;
    this.log = srv.log || (() => {});
    this.clock = clock;
    this.rng = rng;
    this.fillAfter = fillAfter;
    this.T = { ...V.TIMES, ...times };
    this.queue = new Map(); // userId -> entry
    this.dodges = new Map(); // userId -> { n, last, until, fails } (kept in pvp_dodges too: a restart doesn't forget them)
    this.founds = new Map(); // id -> a lobby waiting for its accepts
    this.foundOf = new Map(); // userId -> found
    this.starting = new Set(); // userIds of a lobby everyone accepted, its match being made (startMatch's awaits)
    this.matches = new Map(); // id -> match (open, or settling)
    this.matchOf = new Map(); // userId -> the open match they're in (not abandoned)
    this.hits = new Map();
    this.relay = null; // (server/relay.mjs sets itself)
    this.closed = false;
    this.busy = new Set(); // settlements under way (close waits for them)
    this.lastPing = 0;
    this.lastBeat = clock();
    this.ticking = null;
    this.timer = tick ? setInterval(() => this.tick().catch((e) => this.log('[pvp] tick failed', e)), V.QUEUE.TICK_MS) : null;
    this.timer?.unref?.();
  }

  now() { return this.clock(); }
  on() { return this.srv.admin?.settings?.pvp !== false; }
  hasCap(ws) { return !!ws?.caps?.has(PVP); }
  // A push to a player's pvp1 connections (only those).
  push(userId, msg) { this.srv.sendEach(userId, (ws) => (this.hasCap(ws) && ws.welcomed ? msg : null)); }
  send(ws, msg) { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); }
  limit(kind, id) {
    const rules = LIMITS[kind], key = `${kind}:${id}`, now = this.now();
    const times = (this.hits.get(key) || []).filter((t) => now - t < rules.at(-1).ms);
    this.hits.set(key, times);
    for (const { max, ms, say } of rules) if (times.filter((t) => now - t < ms).length >= max) fail(say, 'rate');
    times.push(now);
  }
  audit(action, detail, target = null) {
    return this.srv.admin?.audit(SERVER, action, target, detail).catch?.(() => {});
  }
  track(p) { this.busy.add(p); p.finally(() => this.busy.delete(p)).catch(() => {}); return p; }

  // Whether a player is searching, has a match found or starting, or is in one: Play's own matches wait (index.mjs refuses
  // play.start and play.reward meanwhile, so nobody is paid twice for the same minutes).
  playing(userId) { return this.queue.has(userId) || this.foundOf.has(userId) || this.starting.has(userId) || this.matchOf.has(userId); }

  // ---- dodges ----------------------------------------------------------------------------------------------------------
  // fail: a map that "failed to load" (FAILS of them within the window are let go as dodges; the next is an abandon:
  // → { ms, abandon }).
  dodge(userId, { fail = false } = {}) {
    const now = this.now(), d = { n: 0, last: 0, until: 0, fails: 0, ...this.dodges.get(userId) };
    if (now - d.last > V.QUEUE.DODGE_WINDOW) { d.n = 0; d.fails = 0; }
    const ms = V.QUEUE.DODGE[Math.min(d.n, V.QUEUE.DODGE.length - 1)];
    const next = { n: d.n + 1, last: now, until: now + ms, fails: d.fails + (fail ? 1 : 0) };
    this.dodges.set(userId, next);
    this.db.query(`INSERT INTO pvp_dodges (user_id, n, last, until, fails) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (user_id) DO UPDATE SET n = EXCLUDED.n, last = EXCLUDED.last, until = EXCLUDED.until, fails = EXCLUDED.fails`,
    [userId, next.n, next.last, next.until, next.fails]).catch((e) => this.log('[pvp] dodge not saved', e.message));
    return fail ? { ms, abandon: next.fails > V.QUEUE.FAILS } : ms;
  }
  dodgeLeft(userId) { return Math.max(0, (this.dodges.get(userId)?.until || 0) - this.now()); }
  // (Staff and the tests: a player's dodges forgotten.)
  async clearDodge(userId) {
    this.dodges.delete(userId);
    await this.db.query('DELETE FROM pvp_dodges WHERE user_id = $1', [userId]).catch(() => {});
  }

  // ---- requests (ns 'pvp') ---------------------------------------------------------------------------------------------
  async rpc(user, m, a, ws) {
    a = isObj(a) ? a : {};
    switch (m) {
      case 'queue': return this.rpcQueue(user, a, ws);
      case 'leave': this.limit('leave', user.id); return { left: this.leave(user.id) };
      case 'accept': return this.accept(user, a);
      case 'decline': return this.decline(user, a);
      case 'state': this.limit('state', user.id); return this.state(user.id);
      case 'abandon': return this.rpcAbandon(user, a);
      default: return fail('Unknown request');
    }
  }

  // { mode, maps: [{ id, c, x }], fixed?: [id] } → { since, mode, pool, settled? }. A ranked bot match still open from before
  // is settled first, as the bot queue does (play.queue): a loss and the cooldown.
  async rpcQueue(user, a, ws) {
    if (!this.on()) fail('Online matches are turned off on this server right now', 'off');
    const admin = this.srv.admin;
    if (admin.settings.maintenance && await admin.levelOf(user.id, { fast: true }) < 1) fail(admin.maintenanceMsg(), 'maintenance');
    this.limit('queue', user.id);
    const M = V.modeOf(a.mode);
    if (!M) fail('Pick Competitive or Wingman');
    if (!ws?.app) fail('Update the game to play online matches', 'outdated');
    // (Matched only within one version, and online that's the released one: a made-up version string would be a queue of
    // its own, where only the players who share it meet.)
    const rel = this.srv.release;
    if (rel?.on && rel.required && ws.app !== rel.required) fail(`Online matches are played on the released version (${rel.required}): update the game`, 'outdated');
    const { maps, fixed } = V.cleanMaps(M.id, a.maps, a.fixed);
    if (!maps.size) fail(`None of your CS2 maps can be played online in ${M.name}`, 'maps');
    const out = await this.srv.store.withUser(user.id, async (e) => {
      const ctx = makeCtx(e.st, { ...this.srv.rules, online: true, now: this.now() });
      const r = runAction(ctx, 'play.queue', { mode: M.id });
      // (A match against bots still open (play.start) can't be paid for once you're searching: its minutes would be paid
      // twice. index.mjs refuses play.start while you search or play online.)
      if (ctx.st.play) { ctx.st.play = null; ctx.dirty.add('play'); }
      if (ctx.dirty.size) this.srv.store.markDirty(e);
      return { ...r, mmr: matchmakingMmr(e.st[M.rankKey]), d: ctx.dirty.size ? delta(ctx) : null };
    });
    if (out.d) this.srv.deltaTo(user.id, out.d);
    if (out.cooldown > 0) fail(`You can't play ${M.name} for ${MM.formatWait(out.cooldown)}: you abandoned a match`, 'cooldown');
    if (this.matchOf.has(user.id) || this.foundOf.has(user.id) || this.starting.has(user.id)) fail('You are already in a match', 'busy');
    const dodge = this.dodgeLeft(user.id);
    if (dodge) fail(`You didn't accept a match: you can search again in ${MM.formatWait(dodge)}`, 'dodge');
    const now = this.now(), old = this.queue.get(user.id);
    const keep = old && old.mode === M.id && old.app === ws.app;
    const entry = {
      userId: user.id, name: user.name, ws, mode: M.id, app: ws.app, since: keep ? old.since : now, maps, fixed, mmr: out.mmr,
      rtt: keep ? old.rtt : [], alone: false, gone: null, off: false,
    };
    this.queue.set(user.id, entry);
    this.pushQ(entry, now);
    return { since: entry.since, mode: M.id, pool: [...maps.keys()], ...(out.settled ? { settled: { mode: out.settled.mode, cooldown: out.settled.cooldown } } : {}) };
  }
  leave(userId) { return this.queue.delete(userId); }

  // → { n, of }: the accepts so far.
  async accept(user, a) {
    this.limit('accept', user.id);
    const f = this.founds.get(String(a.id ?? ''));
    if (!f || f.done || !f.entries.some((e) => e.userId === user.id)) fail('That match is gone', 'missing');
    f.accepted.add(user.id);
    const n = f.accepted.size, of = f.entries.length;
    for (const e of f.entries) this.push(e.userId, { t: 'pvp.accepts', id: f.id, n, of });
    if (n === of) await this.track(this.startMatch(f));
    return { n, of };
  }
  async decline(user, a) {
    this.limit('decline', user.id);
    const f = this.founds.get(String(a.id ?? ''));
    if (!f || f.done || !f.entries.some((e) => e.userId === user.id)) fail('That match is gone', 'missing');
    this.cancelFound(f, 'declined', new Set([user.id]));
    return {};
  }

  // What a game needs after a welcome: its search, a match found that waits for its accept, the match it's in (away: it
  // isn't connected to it, and how long it has to come back), and how long a dodge keeps it from searching.
  state(userId) {
    const now = this.now(), q = this.queue.get(userId), f = this.foundOf.get(userId), m = this.matchOf.get(userId);
    let match = null;
    if (m && !m.finalizing) {
      const mem = m.members.get(userId), connected = this.connected(m, mem);
      let left = null;
      if (!connected) {
        const d = mem.drops.at(-1);
        left = m.host == null ? Math.max(0, m.loadBy + this.T.RECONNECT - now) : d && d.back == null ? Math.max(0, this.T.RECONNECT - this.active(m, d.at, now)) : this.T.RECONNECT;
      }
      match = { id: m.id, mode: m.mode, map: m.map, status: m.status, slot: mem.slot, away: connected ? null : { left } };
    }
    return {
      queue: q ? { mode: q.mode, since: q.since, alone: !!q.alone } : null,
      found: f && !f.done ? { id: f.id, deadline: f.deadline, accepted: f.accepted.has(userId), mode: f.mode, map: f.map.id, humans: f.entries.length } : null,
      match, dodge: this.dodgeLeft(userId),
    };
  }

  async rpcAbandon(user, a) {
    this.limit('abandon', user.id);
    const m = this.matchOf.get(user.id);
    if (!m || m.id !== String(a.id ?? '') || m.finalizing || m.ending || m.logEnd != null) fail('You are not in that match any more', 'missing');
    const mem = m.members.get(user.id);
    const r = await this.track(this.abandonUser(m, mem));
    if (mem.slot === m.host && m.liveAt != null && !m.logEnd) { m.endWhy = 'host-left'; await this.track(this.endMatch(m, 'host-left')); }
    else if (mem.slot === m.host) await this.track(this.cancelLoading(m, 'load-failed', new Set()));
    else if (m.status === 'loading' && m.host == null) await this.maybeElect(m);
    return { cooldown: r.cooldown };
  }

  // ---- the /ws side ------------------------------------------------------------------------------------------------------
  // A queued connection closed: the entry waits QUEUE.GRACE for the game to search again (keeping its place).
  disconnected(ws) {
    if (!ws?.user) return;
    const e = this.queue.get(ws.user.id);
    if (e && e.ws === ws) e.gone = this.now();
  }
  // A tagged pong ([0x70][u32 nonce][4 bytes]) from a queued connection: a round trip sample, timed by the server's own note
  // of when it sent that ping (a nonce it chose at random: a pong for a ping that wasn't sent, or sent again, counts for
  // nothing, so a game can't make its round trip look shorter and get itself picked to host).
  pong(ws, data) {
    if (!ws?.user || !Buffer.isBuffer(data) || data.length < 5) return;
    const e = this.queue.get(ws.user.id);
    if (!e || e.ws !== ws || !e.pings) return;
    const n = data.readUInt32LE(1), sent = e.pings.get(n);
    if (sent == null) return;
    e.pings.delete(n);
    const ms = performance.now() - sent;
    if (!(ms >= 0 && ms < 10000)) return;
    e.rtt.push(ms);
    if (e.rtt.length > V.QUEUE.RTT_KEEP) e.rtt.shift();
  }
  pingQueue() {
    for (const e of this.queue.values()) {
      if (e.off || !this.hasCap(e.ws) || e.ws.readyState !== 1) continue;
      const n = crypto.randomBytes(4).readUInt32LE(0), b = Buffer.alloc(9);
      b[0] = 0x70;
      b.writeUInt32LE(n, 1);
      (e.pings ||= new Map()).set(n, performance.now());
      if (e.pings.size > 4) e.pings.delete(e.pings.keys().next().value);
      try { e.ws.ping(b); } catch { /* closing */ }
    }
  }

  // ---- the clock ---------------------------------------------------------------------------------------------------------
  tick() {
    if (this.ticking) return this.ticking;
    this.ticking = this.runTick().finally(() => { this.ticking = null; });
    return this.ticking;
  }
  async runTick() {
    if (this.closed) return;
    const now = this.now();
    this.tickQueues(now);
    for (const f of [...this.founds.values()]) if (!f.done && now >= f.deadline) this.cancelFound(f, 'timeout', new Set(f.entries.map((e) => e.userId).filter((id) => !f.accepted.has(id))));
    for (const m of [...this.matches.values()]) {
      await this.track(this.tickMatch(m, now)).catch((e) => this.log('[pvp] match tick failed', m.id, e));
    }
    if (now - this.lastBeat >= this.T.HEARTBEAT) {
      this.lastBeat = now;
      await this.heartbeat(now);
      // (what the limits and dodges remember, once it can't matter any more)
      for (const [k, times] of this.hits) if (!times.length || now - times.at(-1) > 10 * MIN) this.hits.delete(k);
      for (const [id, d] of this.dodges) if (now - d.last > V.QUEUE.DODGE_WINDOW && now > d.until) this.dodges.delete(id);
    }
    const t = performance.now();
    if (t - this.lastPing >= V.QUEUE.PING_MS) { this.lastPing = t; this.pingQueue(); }
  }

  tickQueues(now) {
    for (const e of [...this.queue.values()]) if (e.gone != null && now - e.gone >= V.QUEUE.GRACE) this.queue.delete(e.userId);
    const buckets = new Map();
    for (const e of this.queue.values()) {
      e.off = e.gone != null || e.ws?.readyState !== 1;
      const k = e.mode + '|' + e.app;
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(e);
    }
    for (const list of buckets.values()) {
      const M = V.modeOf(list[0].mode);
      for (let lobby; (lobby = V.pickLobby(list.filter((e) => this.queue.get(e.userId) === e), now, { lobby: M.lobby, fillAfter: this.fillAfter, rng: this.rng }));) {
        this.makeFound(lobby.members, M, now);
      }
    }
    for (const e of this.queue.values()) this.pushQ(e, now);
  }
  // { t: 'pvp.q' } to the connection that queued: how long it's waited, the players found who share a map with it (it too),
  // the lobby's size, the seconds until the oldest of them waited long enough for a split, and whether it's alone.
  pushQ(e, now) {
    if (e.off || e.gone != null) return;
    const M = V.modeOf(e.mode);
    const keys = new Set([...e.maps].map(([id, m]) => id + '|' + m.c));
    const mates = [...this.queue.values()].filter((x) => x.mode === e.mode && x.app === e.app && !x.off && [...x.maps].some(([id, m]) => keys.has(id + '|' + m.c)));
    const oldest = Math.min(e.since, ...mates.map((x) => x.since));
    this.send(e.ws, { t: 'pvp.q', mode: e.mode, waited: Math.max(0, Math.floor((now - e.since) / SEC)), found: mates.length, need: M.lobby,
      split: Math.max(0, Math.ceil((oldest + this.fillAfter - now) / SEC)), alone: !!e.alone });
  }

  makeFound(members, M, now) {
    const map = V.pickMap(members, M.id, this.rng);
    const f = { id: newId(), mode: M.id, app: members[0].app, map, entries: members, accepted: new Set(), deadline: now + V.QUEUE.ACCEPT, done: false };
    for (const e of members) { this.queue.delete(e.userId); this.foundOf.set(e.userId, f); }
    this.founds.set(f.id, f);
    for (const e of members) this.push(e.userId, { t: 'pvp.found', id: f.id, mode: M.id, map: map.id, humans: members.length, deadline: f.deadline });
  }
  // Back in the queue with the place it had (since).
  requeue(e) {
    if (this.closed) return false;
    e.alone = false;
    e.off = false;
    e.gone = e.ws?.readyState === 1 ? null : this.now();
    this.queue.set(e.userId, e);
    return true;
  }
  // A lobby that wasn't accepted: who didn't accept (dodgers) waits a dodge's cooldown, everyone else searches again in
  // their place. drop: someone who goes without either (kicked).
  cancelFound(f, why, dodgers, { drop = null, requeue = true } = {}) {
    if (f.done) return;
    f.done = true;
    this.founds.delete(f.id);
    for (const e of f.entries) {
      this.foundOf.delete(e.userId);
      if (e.userId === drop) continue;
      if (dodgers.has(e.userId)) {
        const ms = this.dodge(e.userId);
        this.push(e.userId, { t: 'pvp.cancel', id: f.id, why, requeued: false, msg: `You didn't accept the match: you can search again in ${MM.formatWait(ms)}` });
      } else {
        const back = requeue && this.requeue(e);
        this.push(e.userId, { t: 'pvp.cancel', id: f.id, why, requeued: !!back, msg: back ? 'Not everyone accepted the match: you\'re back in the queue' : cancelMsg(why) });
      }
    }
  }

  // ---- a match ---------------------------------------------------------------------------------------------------------
  // Everyone accepted: the teams, the bots and the roster, a row, and { t: 'pvp.go' } to each player (the rest comes over
  // /match).
  async startMatch(f) {
    if (f.done) return;
    f.done = true;
    this.founds.delete(f.id);
    // (Starting from here, before any wait: a search sent alongside the last accept is refused, not a second match.)
    for (const e of f.entries) { this.starting.add(e.userId); this.foundOf.delete(e.userId); }
    try { return await this.makeMatch(f); } finally { for (const e of f.entries) this.starting.delete(e.userId); }
  }
  async makeMatch(f) {
    const M = V.modeOf(f.mode), now = this.now(), ids = f.entries.map((e) => e.userId);
    const { sides, slots } = V.splitTeams(f.entries, f.mode, this.rng);
    let roster, blocks, hostLeft;
    try {
      [roster, blocks, hostLeft] = await Promise.all([this.roster(ids, M), this.blocksOf(ids), this.hostLeftOf(ids, now)]);
    } catch (e) {
      this.log('[pvp] could not make a match', e);
      for (const x of f.entries) { const back = this.requeue(x); this.push(x.userId, { t: 'pvp.cancel', id: f.id, why: 'load-failed', requeued: back, msg: 'The match couldn\'t start: back in the queue' }); }
      return;
    }
    for (const s of slots) {
      if (s.kind === 'human') Object.assign(s, roster.get(s.userId), { mmr: f.entries.find((e) => e.userId === s.userId).mmr });
      else Object.assign(s, { name: null, group: groupFor(V.mmrOfSkill(s.skill)) });
    }
    const members = new Map();
    for (const e of f.entries) {
      const s = slots.find((x) => x.userId === e.userId);
      members.set(e.userId, {
        userId: e.userId, name: s.name, slot: s.slot, squad: s.squad, state: 'loading', load: 0, stage: null, ready: false, connected: false,
        qrtt: e.rtt.slice(), mrtt: [], since: e.since, hostLeft: hostLeft.get(e.userId) || 0, drops: [], control: [],
        eligible: null, abandoned: false, banned: false, failed: false, kicked: false, entry: e, ipHash: null, pushedAt: 0, pushTimer: null,
      });
    }
    const m = {
      id: f.id, mode: f.mode, app: f.app, map: f.map.id, content: f.map.c, site: f.map.site, seed: crypto.randomBytes(4).readUInt32LE(0),
      sides, slots, status: 'loading', created: now, loadBy: now + (f.map.x ? this.T.LOAD : this.T.LOAD_EXPORT), members,
      host: null, backups: [], startedAt: null, liveAt: null, rounds: [], score: { A: 0, B: 0 }, pauses: [], paused: null,
      checkpoint: null, reports: new Map(), hosts: [], migrations: 0, endWhy: null, voidWhy: null, logEnd: null, endWaitBy: null, ending: null,
      plan: null, ended: null, finalizing: false, electing: false, blocks, saveQ: Promise.resolve(),
    };
    try {
      await this.db.tx(async (q) => {
        const row = this.toRow(m);
        await q(`INSERT INTO pvp_matches (id, mode, map, app, status, host_id, members, data, created, started, ended, updated)
          VALUES ($1, $2, $3, $4, $5, NULL, $6::jsonb, $7::jsonb, $8, NULL, NULL, $8)`, [m.id, m.mode, m.map, m.app, m.status, row.members, row.data, now]);
        for (const x of members.values()) await q('INSERT INTO pvp_players (match_id, user_id, slot, squad, at) VALUES ($1, $2, $3, $4, $5)', [m.id, x.userId, x.slot, x.squad, now]);
      });
    } catch (e) {
      this.log('[pvp] could not save a match', e);
      for (const x of f.entries) { const back = this.requeue(x); this.push(x.userId, { t: 'pvp.cancel', id: f.id, why: 'load-failed', requeued: back, msg: 'The match couldn\'t start: back in the queue' }); }
      return;
    }
    this.matches.set(m.id, m);
    for (const id of ids) this.matchOf.set(id, m);
    for (const x of members.values()) this.push(x.userId, { t: 'pvp.go', id: m.id, mode: m.mode, map: m.map, site: m.site, slot: x.slot, loadBy: m.loadBy });
  }

  // Each human's name, picture, featured badge, rank emblem (the mode's skill group, 0 unranked) and look.
  async roster(ids, M) {
    const { rows } = await this.db.query('SELECT id, name, pic, badge FROM users WHERE id = ANY($1::int[])', [ids]);
    const out = new Map();
    for (const r of rows) {
      const st = this.srv.store.cache.get(r.id)?.st || await this.srv.store.peek(r.id);
      out.set(r.id, { name: r.name, pic: isPicHash(r.pic) ? r.pic : null, badge: featuredBadge(st, r.badge), group: rankInfo(st[M.rankKey]).group, look: lookOf(st) });
    }
    return out;
  }
  // Who blocked whom among these players ('blocker:blocked'): their chat in the match doesn't reach the one who blocked.
  async blocksOf(ids) {
    const { rows } = await this.db.query('SELECT user_id, blocked_id FROM blocks WHERE user_id = ANY($1::int[]) AND blocked_id = ANY($1::int[])', [ids]);
    return new Set(rows.map((r) => `${r.user_id}:${r.blocked_id}`));
  }
  // How many matches each of these players hosted and left, or whose rules their game broke, or whose result the other
  // players' games contested, in the last week (host election passes them over at 2).
  async hostLeftOf(ids, now) {
    const { rows } = await this.db.query(`SELECT host_id, count(*)::int AS n FROM pvp_matches WHERE host_id = ANY($1::int[]) AND ended >= $2
      AND (data->>'endWhy' IN ('host-left', 'host-fault') OR data->>'contested' = 'true') GROUP BY host_id`, [ids, now - V.HOST.LEFT_DAYS * DAY]);
    return new Map(rows.map((r) => [r.host_id, r.n]));
  }

  memberAt(m, slot) { for (const x of m.members.values()) if (x.slot === slot) return x; return null; }
  connected(m, mem) { return !!mem && !!this.relay?.isConnected(m.id, mem.slot); }
  // Milliseconds between two times with the match's pauses left out.
  active(m, from, to) {
    let t = to - from;
    for (const p of m.pauses) { const a = Math.max(from, p.from), b = Math.min(to, p.to ?? to); if (b > a) t -= b - a; }
    return t;
  }
  // Who controls a slot from now: its player (human) or a bot for them.
  setControl(mem, human, at) {
    const open = mem.control.at(-1);
    if (human) { if (open && open.back == null) open.back = at; } else if (!open || open.back != null) mem.control.push({ from: at, back: null });
  }
  publicSlots(m) {
    return m.slots.map(({ mmr: _m, ...s }) => s);
  }
  memberMsg(mem) { return { t: 'member', slot: mem.slot, state: mem.state, ...(mem.state === 'loading' ? { load: mem.load, ...(mem.stage ? { stage: mem.stage } : {}) } : {}) }; }
  // A member's state to everyone in the match (load progress at most LOAD_HZ times a second: the last one always goes).
  pushMember(m, mem, { throttle = false } = {}) {
    if (!this.relay) return;
    const gap = SEC / this.T.LOAD_HZ, t = performance.now();
    if (throttle && t - mem.pushedAt < gap) {
      if (!mem.pushTimer) { mem.pushTimer = setTimeout(() => { mem.pushTimer = null; this.pushMember(m, mem); }, gap - (t - mem.pushedAt)); mem.pushTimer.unref?.(); }
      return;
    }
    clearTimeout(mem.pushTimer);
    mem.pushTimer = null;
    mem.pushedAt = t;
    this.relay.broadcast(m.id, this.memberMsg(mem));
  }

  // ---- the relay's side (server/relay.mjs) --------------------------------------------------------------------------------
  // A hello's match and member, or the close code that refuses it.
  auth(userId, matchId) {
    const m = this.matches.get(matchId);
    if (!m || !OPEN.has(m.status) || m.finalizing) return { code: V.CLOSE.OVER };
    const mem = m.members.get(userId);
    if (!mem || mem.abandoned) return { code: V.CLOSE.NOT_MEMBER };
    return { match: m, member: mem };
  }
  // Whether a client's inputs go to the host now.
  forwarding(m) { return m.status === 'live' && m.host != null && !m.finalizing; }
  rtt(m, mem, ms) {
    mem.mrtt.push(ms);
    if (mem.mrtt.length > V.QUEUE.RTT_KEEP) mem.mrtt.shift();
  }

  joined(m, mem, ws) {
    const now = this.now();
    mem.connected = true;
    mem.kicked = false;
    mem.ipHash = ws.ipHash || null;
    const d = mem.drops.at(-1);
    if (d && d.back == null) d.back = now;
    if (m.host == null) mem.state = mem.ready ? 'ready' : 'loading';
    else if (!m.ending) {
      // (Back in the match: control at once within the grace, else the host gives it back at the next freeze time. One that
      // hasn't loaded the map yet stays a bot until it says it's ready.)
      mem.state = mem.ready ? 'in' : 'loading';
      this.setControl(mem, mem.ready, now);
    }
    this.send(ws, {
      t: 'joined', id: m.id, mode: m.mode, map: m.map, site: m.site, seed: m.seed, sides: m.sides, slot: mem.slot, host: m.host, status: m.status,
      paused: m.paused ? { why: m.paused.why, until: m.paused.until } : null, slots: this.publicSlots(m),
      members: [...m.members.values()].map((x) => ({ slot: x.slot, state: x.state, load: x.load })),
    });
    this.pushMember(m, mem);
    if (m.host != null && mem.slot !== m.host && m.status === 'live') this.relay?.requestKey(m.id, mem.slot, { force: true });
    if (m.paused?.why === 'host' && mem.slot === m.host) this.resume(m);
    else if (m.paused?.why === 'restart') this.maybeResume(m, now);
    this.save(m);
  }

  left(m, mem) {
    mem.connected = false;
    if (this.closed || m.finalizing || mem.abandoned) return;
    const now = this.now();
    if (m.host == null) { mem.state = 'dropped'; this.pushMember(m, mem); return; }
    if (m.ending || m.logEnd != null) { mem.state = 'dropped'; mem.drops.push({ at: now, back: null }); this.pushMember(m, mem); return; }
    mem.drops.push({ at: now, back: null });
    if (mem.slot === m.host) {
      mem.state = 'dropped';
      this.pushMember(m, mem);
      if (!m.paused) this.pause(m, 'host', now + this.T.HOST_GRACE);
      return;
    }
    // (Kicked or banned: a bot at once. Otherwise the slot waits TAKEOVER_GRACE first.)
    if (mem.kicked) { mem.state = 'bot'; this.setControl(mem, false, now); } else mem.state = 'dropped';
    this.pushMember(m, mem);
    this.save(m);
  }

  // A text frame from a member (the relay checked its size and rate).
  async text(m, mem, msg) {
    if (m.finalizing || mem.abandoned) return;
    const host = mem.slot === m.host;
    switch (msg.t) {
      case 'load': return this.onLoad(m, mem, msg);
      case 'ready': return this.onReady(m, mem);
      case 'chat': return this.onChat(m, mem, msg);
      case 'report': return this.onReport(m, mem, msg);
      case 'leave': return this.relay?.closeSlot(m.id, mem.slot, V.CLOSE.END, 'Left the match');
      case 'live': return host ? this.onLive(m) : null;
      case 'round': return host ? this.onRound(m, msg) : null;
      case 'checkpoint': return host ? this.onCheckpoint(m, msg) : null;
      case 'end': return host ? this.onEnd(m, msg) : null;
      default: return null;
    }
  }

  async onLoad(m, mem, msg) {
    mem.load = Number.isInteger(msg.p) ? Math.max(0, Math.min(100, msg.p)) : mem.load;
    mem.stage = typeof msg.stage === 'string' ? msg.stage.slice(0, 40) : null;
    if ((typeof msg.failed === 'string' || msg.failed === true) && m.host == null) {
      // (The map wouldn't load before the start: a dodge, not an abandon. The slot's a bot from here on. After the start it's
      // no way out of a match: a game that can't come back is away, and its window runs as anyone's.)
      // (A third within the hour is an abandon: the way out of a match that's going badly can't be "my map didn't load".)
      const { ms, abandon } = this.dodge(mem.userId, { fail: true });
      if (abandon) {
        await this.abandonUser(m, mem, { msg: (cd) => `Your map failed to load again: that counts as abandoning the match. No ranked matches for ${MM.formatWait(cd)}` });
      } else {
        mem.failed = true;
        this.push(mem.userId, { t: 'pvp.over', id: m.id, why: 'abandoned', msg: `The map didn't load: you can search again in ${MM.formatWait(ms)}` });
        await this.abandonUser(m, mem);
      }
      if (m.host == null) await this.maybeElect(m);
      return;
    }
    if (m.host != null && !m.ending && mem.state !== 'loading' && mem.load < 100) {
      // (After the start, a game loading again (it closed and came back): a bot plays for it until it's ready.)
      mem.state = 'loading';
      this.setControl(mem, false, this.now());
      this.pushMember(m, mem);
      return;
    }
    this.pushMember(m, mem, { throttle: true });
  }
  // (A game says ready again while it waits for its first keyframe: the host is asked for one at most every KEY_MS a slot,
  // and nothing's saved unless something changed.)
  async onReady(m, mem) {
    const was = mem.state;
    mem.ready = true;
    mem.load = 100;
    if (m.host == null) {
      if (was !== 'ready') { mem.state = 'ready'; this.pushMember(m, mem); }
      return this.maybeElect(m);
    }
    if (m.ending) return;
    if (was !== 'in') {
      mem.state = 'in';
      this.setControl(mem, true, this.now());
      this.pushMember(m, mem);
      this.save(m);
    }
    if (m.status === 'live' && mem.slot !== m.host) this.relay?.requestKey(m.id, mem.slot);
  }
  async maybeElect(m) {
    if (m.status !== 'loading' || m.host != null) return;
    const waiting = [...m.members.values()].filter((x) => !x.abandoned && !(x.ready && this.connected(m, x)));
    if (!waiting.length) await this.elect(m);
  }
  // Everyone's loaded (or the time's up): the host, then { t: 'host' } and { t: 'start' }. A squad with none of its humans
  // ready: the match is off.
  async elect(m) {
    if (m.host != null || m.electing || m.finalizing) return;
    m.electing = true;
    try {
      const now = this.now(), humans = [...m.members.values()];
      const ready = humans.filter((x) => !x.abandoned && x.ready && this.connected(m, x));
      if (V.SQUADS.some((sq) => !ready.some((x) => x.squad === sq))) return await this.cancelLoading(m, 'load-failed');
      const order = V.pickHost(humans.map((x) => ({ ...x, connected: this.connected(m, x) })));
      if (!order.length) return await this.cancelLoading(m, 'load-failed');
      m.host = order[0].slot;
      m.backups = order.slice(1).map((x) => x.slot);
      m.hosts.push({ slot: m.host, userId: order[0].userId, from: now, to: null });
      m.startedAt = now;
      for (const x of humans) {
        if (x.abandoned) continue;
        if (ready.includes(x)) { x.state = 'in'; continue; }
        const on = this.connected(m, x);
        x.state = on ? 'loading' : 'bot';
        this.setControl(x, false, now);
        if (!on) x.drops.push({ at: now, back: null });
      }
      this.relay?.broadcast(m.id, { t: 'host', slot: m.host, backups: m.backups });
      this.relay?.broadcast(m.id, { t: 'start' });
      for (const x of humans) if (!x.abandoned) this.pushMember(m, x);
      await this.save(m);
    } finally { m.electing = false; }
  }
  // A match that never went live, called off: players who were ready search again in their place (with their accept,
  // nothing lost), those who weren't (dodgers, by default) wait a dodge.
  async cancelLoading(m, why, dodgers = null, { requeue = true } = {}) {
    if (m.finalizing) return;
    m.finalizing = true;
    const now = this.now();
    m.status = 'cancelled';
    m.endWhy = why;
    m.ended = now;
    for (const x of m.members.values()) {
      this.matchOf.delete(x.userId);
      if (x.abandoned) continue;
      const dodge = dodgers ? dodgers.has(x.userId) : !(x.ready && this.connected(m, x));
      if (dodge) {
        const ms = this.dodge(x.userId);
        this.push(x.userId, { t: 'pvp.cancel', id: m.id, why, requeued: false, msg: `${cancelMsg(why)}: you can search again in ${MM.formatWait(ms)}` });
      } else {
        const back = requeue && x.entry && this.requeue(x.entry);
        this.push(x.userId, { t: 'pvp.cancel', id: m.id, why, requeued: !!back, msg: back ? `${cancelMsg(why)}: you're back in the queue` : cancelMsg(why) });
      }
    }
    await this.save(m);
    await this.db.query("UPDATE pvp_players SET paid = $2, outcome = 'cancelled' WHERE match_id = $1 AND paid IS NULL", [m.id, now]).catch((e) => this.log('[pvp] settle failed', e.message));
    this.relay?.closeMatch(m.id, V.CLOSE.OVER, 'The match was called off');
    this.matches.delete(m.id);
  }

  onLive(m) {
    if (m.liveAt != null || m.host == null) return;
    const now = this.now();
    m.liveAt = now;
    if (m.status === 'paused') m.paused.prev = 'live'; else m.status = 'live';
    return this.save(m);
  }
  // A round's end from the host. Each logged round is acknowledged ({ t: 'round.ok', n }): the host keeps the ones not yet
  // acknowledged and sends them again once it's back after its link dropped (a round sent into a dead socket would leave a
  // gap in the log), and an exact resend of a logged round is acknowledged again and changes nothing.
  async onRound(m, msg) {
    if (Number.isInteger(msg.n) && msg.n >= 1 && msg.n <= m.rounds.length) {
      const old = m.rounds[msg.n - 1];
      if (old.w === msg.w && old.score.A === msg.score?.A && old.score.B === msg.score?.B) this.relay?.send(m.id, m.host, { t: 'round.ok', n: msg.n });
      return;
    }
    if (m.logEnd != null || m.ending || m.voidWhy) return; // (void: it plays on, and nothing more is logged)
    if (m.liveAt == null) return this.hostFault(m, 'A round before the match went live');
    const now = this.now(), r = V.cleanRound(msg, m.mode);
    const start = m.rounds.at(-1)?.at ?? m.liveAt;
    let gap = this.active(m, start, now);
    // (A round a restart paused: a crash's pause runs from the row's last write, before the server stopped, so the time
    // played since then isn't counted. The host's own count of the round's ticks stands in for it, never more than the
    // time that went by.)
    if (Number.isInteger(msg.ticks) && msg.ticks > 0 && m.pauses.some((p) => p.why === 'restart' && p.from < now && (p.to ?? now) > start)) {
      gap = Math.max(gap, Math.min(now - start, msg.ticks * TICK_MS));
    }
    const why = V.checkRound({ rounds: m.rounds, score: m.score }, r, { mode: m.mode, gap });
    if (why) return this.hostFault(m, why);
    m.rounds.push({ ...r, at: now, start, gap });
    m.score = { ...r.score };
    this.relay?.send(m.id, m.host, { t: 'round.ok', n: r.n });
    if (V.endOf(m.score, m.rounds.length, m.mode)) this.markEnd(m, now);
    return this.save(m);
  }
  // The host's game broke the log's rules (a round that can't follow it, an end before it, no round for too long): the
  // match ends now, its finished rounds paid to everyone else as if the host had left, and the host abandoned it. (Not void,
  // which pays nobody and holds nobody to anything: that was a free way out for a host that was losing.) Before live: called
  // off, the host a dodge, everyone else back in the queue.
  async hostFault(m, why) {
    if (m.ending || m.finalizing || m.voidWhy || m.fault) return;
    m.fault = why;
    this.log(`[pvp] match ${m.id}: the host broke its rules: ${why}`);
    const host = this.memberAt(m, m.host);
    await this.audit('pvp.fault', { match: m.id, mode: m.mode, map: m.map, why, score: m.score, rounds: m.rounds.length, host: host?.name ?? null }, host ? { id: host.userId, name: host.name } : null);
    if (m.liveAt == null) return this.cancelLoading(m, 'load-failed', new Set(host ? [host.userId] : []));
    m.endWhy = 'host-fault';
    return this.endMatch(m, 'host-fault');
  }
  // The log says the match is over: who's there now is paid (a member a bot is playing for isn't), and the host has
  // END_WAIT to say so too.
  markEnd(m, now) {
    m.logEnd = now;
    m.endWaitBy = now + this.T.END_WAIT;
    for (const x of m.members.values()) x.eligible = this.present(m, x);
  }
  // Whether a member is there at the end (paid, not a leaver): playing, gone under the takeover grace, or connected.
  present(m, x) { return !x.abandoned && (x.state === 'in' || x.state === 'dropped' || this.connected(m, x)); }
  // (One checkpoint a round, the round being played: each is a write of the whole row.)
  onCheckpoint(m, msg) {
    if (msg.round !== m.rounds.length + 1 || msg.data === undefined || m.checkpoint?.round === msg.round) return;
    m.checkpoint = { round: msg.round, data: msg.data, at: this.now() };
    return this.save(m);
  }
  // The host says it's over. Before the log is: the host's fault. After it, the log's score is the one paid, whatever the
  // host says (one that disagrees is noted for staff: voiding the match there would let a losing host off).
  async onEnd(m, msg) {
    if (m.ending) return;
    if (m.voidWhy) { m.endWhy = 'over'; return this.endMatch(m, 'void'); }
    if (m.logEnd == null) return this.hostFault(m, 'The host ended the match before its score did');
    const s = msg.score;
    if (!s || s.A !== m.score.A || s.B !== m.score.B) {
      const host = this.memberAt(m, m.host);
      await this.audit('pvp.fault', { match: m.id, mode: m.mode, map: m.map, why: 'The host\'s final score isn\'t the server\'s: paid by the server\'s', score: m.score, said: s ?? null }, host ? { id: host.userId, name: host.name } : null);
    }
    m.endWhy = 'over';
    return this.endMatch(m, 'over');
  }
  onChat(m, mem, msg) {
    const text = typeof msg.text === 'string' ? msg.text.trim() : '';
    if (textProblem(text, 'A message', V.CHAT_MAX)) return;
    try { this.srv.social.limit('chat', mem.userId); } catch { return; }
    const team = msg.team === true;
    for (const x of m.members.values()) {
      if (x.abandoned || (team && x.squad !== mem.squad) || m.blocks.has(`${x.userId}:${mem.userId}`)) continue;
      this.relay?.send(m.id, x.slot, { t: 'chat', slot: mem.slot, name: mem.name, text, team });
    }
  }
  onReport(m, mem, msg) {
    if (m.logEnd == null && !m.ending) return;
    if (m.reports.has(mem.userId)) return;
    const r = V.cleanReport(msg);
    if (!r) return;
    m.reports.set(mem.userId, r);
    this.save(m);
    if (m.ending?.why === 'over' && this.allReported(m)) return this.track(this.finalize(m));
  }
  allReported(m) {
    return [...m.members.values()].filter((x) => x.eligible && this.connected(m, x)).every((x) => m.reports.has(x.userId));
  }

  async voidMatch(m, why, actor = null) {
    if (m.voidWhy) return;
    m.voidWhy = why;
    this.log(`[pvp] match ${m.id} is void: ${why}`);
    await this.audit('pvp.void', { match: m.id, mode: m.mode, map: m.map, why, score: m.score, rounds: m.rounds.length, ...(actor ? { by: actor.name } : {}) });
    return this.save(m);
  }

  // ---- pauses --------------------------------------------------------------------------------------------------------------
  pause(m, why, until) {
    const now = this.now();
    m.pauses.push({ from: now, to: null, why });
    m.paused = { why, until, from: now, prev: m.status === 'paused' ? m.paused?.prev : m.status };
    m.status = 'paused';
    this.relay?.broadcast(m.id, { t: 'pause', why, until });
    return this.save(m);
  }
  resume(m) {
    if (!m.paused) return;
    const now = this.now(), p = m.pauses.at(-1);
    if (p && p.to == null) p.to = now;
    m.status = m.paused.prev === 'loading' ? 'loading' : 'live';
    m.paused = null;
    this.relay?.broadcast(m.id, { t: 'resume' });
    // (Members not back after a restart: dropped from now, their windows from here.)
    for (const x of m.members.values()) {
      if (x.abandoned || this.connected(m, x) || x.state === 'dropped' || x.state === 'bot') continue;
      x.state = 'dropped';
      x.drops.push({ at: now, back: null });
      this.pushMember(m, x);
    }
    return this.save(m);
  }
  // After a restart: on once the host and everyone else is back, or RESUME_AFTER_HOST after the host is.
  maybeResume(m, now) {
    const p = m.paused;
    if (p?.why !== 'restart') return;
    const host = this.memberAt(m, m.host);
    if (!this.connected(m, host)) return;
    p.hostBack ??= now;
    const all = [...m.members.values()].every((x) => x.abandoned || this.connected(m, x));
    if (all || now - p.hostBack >= this.T.RESUME_AFTER_HOST) this.resume(m);
  }

  // ---- the match's timers ----------------------------------------------------------------------------------------------
  async tickMatch(m, now) {
    if (m.finalizing) return;
    if (m.status === 'loading' && m.host == null) {
      if (now >= m.loadBy) await this.elect(m);
      return;
    }
    // (A host that never goes live holds everyone in the match: off, the host a dodge, the rest back in the queue.)
    if (m.status === 'loading' && m.liveAt == null && m.startedAt != null && this.active(m, m.startedAt, now) > this.T.LIVE_BY) {
      return this.cancelLoading(m, 'load-failed', new Set([this.memberAt(m, m.host)?.userId]));
    }
    if (m.status === 'paused') {
      const p = m.paused;
      const hostOn = this.connected(m, this.memberAt(m, m.host));
      if (p.why === 'restart') this.maybeResume(m, now);
      if (m.paused && !hostOn && now >= p.until) {
        if (m.liveAt == null) return this.cancelLoading(m, 'load-failed', new Set([this.memberAt(m, m.host)?.userId]));
        m.endWhy = 'host-left';
        return this.endMatch(m, 'host-left');
      }
      return; // (every other timer stops while it's paused)
    }
    if (m.logEnd == null && !m.ending) {
      for (const x of m.members.values()) {
        if (x.abandoned || x.slot === m.host || this.connected(m, x)) continue;
        const d = x.drops.at(-1);
        if (!d || d.back != null) continue;
        const away = this.active(m, d.at, now);
        if (x.state === 'dropped' && away >= this.T.TAKEOVER_GRACE) {
          x.state = 'bot';
          this.setControl(x, false, now);
          this.pushMember(m, x);
          this.save(m);
        }
        if (away >= this.T.RECONNECT) await this.abandonUser(m, x);
      }
    }
    if (m.liveAt != null && !m.ending && this.active(m, m.liveAt, now) > this.T.MAX_LIVE) {
      await this.voidMatch(m, 'The match went on too long');
      return this.endMatch(m, 'void');
    }
    // (A host that stops logging rounds holds everyone the same way.)
    if (m.liveAt != null && !m.ending && m.logEnd == null && !m.voidWhy && this.active(m, m.rounds.at(-1)?.at ?? m.liveAt, now) > this.T.ROUND_MAX) {
      return this.hostFault(m, `No round ended for ${Math.round(this.T.ROUND_MAX / MIN)} minutes`);
    }
    if (m.logEnd != null && !m.ending && now >= m.endWaitBy) return this.endMatch(m, m.voidWhy ? 'void' : 'over');
    if (m.ending?.why === 'over' && (now >= m.ending.reportBy || this.allReported(m))) return this.finalize(m);
  }

  async heartbeat(now) {
    const ids = [...this.matches.values()].filter((m) => !m.finalizing && m.status !== 'paused').map((m) => m.id);
    if (!ids.length) return;
    await this.db.query('UPDATE pvp_matches SET updated = $2 WHERE id = ANY($1::text[])', [ids, now]).catch((e) => this.log('[pvp] heartbeat failed', e.message));
  }

  // ---- the end ---------------------------------------------------------------------------------------------------------
  // why: 'over' (its score), 'void', 'host-left', 'staff' or 'maintenance'. { t: 'end' } to everyone; a match played to
  // its end waits REPORT_WAIT for the players' own reports, any other is settled at once.
  async endMatch(m, why) {
    if (m.ending || m.finalizing) return;
    const now = this.now();
    if (m.paused) { const p = m.pauses.at(-1); if (p && p.to == null) p.to = now; m.paused = null; m.status = m.liveAt != null ? 'live' : 'loading'; }
    m.ending = { why, at: now, reportBy: now + this.T.REPORT_WAIT };
    if (m.logEnd == null) for (const x of m.members.values()) x.eligible = this.present(m, x);
    const msg = why === 'staff' && m.voidWhy ? MSG.staffVoid : MSG[why] || MSG.over;
    // (score: the log's, by the server's squads: a game that missed the host's own end, loading or reconnecting, shows it.)
    this.relay?.broadcast(m.id, { t: 'end', why, msg, report: why === 'over', score: { ...m.score } });
    if (why !== 'over') return this.finalize(m);
    await this.save(m);
    if (this.allReported(m)) return this.finalize(m); // (the reports came before the host's end)
  }

  // The match's settlement: its pay worked out (engine payPlan) and kept with it, then each player's abandon or pay, each
  // once (pvp_players.paid). A restart in the middle carries on from what was kept (restore).
  async finalize(m) {
    if (m.finalizing) return;
    m.finalizing = true;
    const now = this.now();
    try {
      const humans = [...m.members.values()];
      const hostId = this.memberAt(m, m.host)?.userId ?? null;
      let history = [], networks = new Set();
      if (!m.voidWhy) [history, networks] = await Promise.all([this.history(m), this.networks(m)]);
      const plan = V.payPlan({
        mode: m.mode, slots: m.slots, rounds: m.rounds, score: m.score, liveAt: m.liveAt, created: m.created, active: (a, b) => this.active(m, a, b),
        endWhy: m.endWhy, voidWhy: m.voidWhy, hostId,
        members: humans.map((x) => ({ userId: x.userId, slot: x.slot, squad: x.squad, eligible: !!x.eligible, abandoned: x.abandoned, control: x.control, drops: x.drops })),
      }, m.reports, history, networks);
      if (plan.void && !m.voidWhy) await this.voidMatch(m, plan.void);
      m.status = m.voidWhy ? 'void' : m.endWhy === 'over' ? 'over' : 'cancelled';
      m.ended = now;
      // (Most of the other players' games saw another result than the host's log: nobody's paid the result or ranked by
      // it, staff are told, and it counts against the host like a match it left: hosting goes to someone else.)
      if (plan.contested && !m.voidWhy) {
        m.contested = true;
        const host = this.memberAt(m, m.host);
        await this.audit('pvp.contested', { match: m.id, mode: m.mode, map: m.map, score: m.score, host: host?.name ?? null,
          against: plan.against.map((id) => m.members.get(id)?.name), reports: Object.fromEntries(plan.against.map((id) => [m.members.get(id)?.name, m.reports.get(id)?.score ?? null])) },
        host ? { id: host.userId, name: host.name } : null);
      }
      const paidIds = new Set(plan.users.map((u) => u.userId));
      // (Leavers: a member a bot was playing for at the end abandoned it; the host of one that ended because they left, or
      // because their game broke its rules. Not in a void match, which nobody's held to.)
      const abandons = m.voidWhy ? [] : humans.filter((x) => !x.abandoned && !paidIds.has(x.userId) && (plan.left.includes(x.userId) || (V.HOST_GONE.has(m.endWhy) && x.userId === hostId))).map((x) => x.userId);
      m.plan = {
        users: plan.users.map((u) => ({ userId: u.userId, outcome: u.outcome, args: this.rewardArgs(m, u), notes: u.notes, squad: u.squad, board: u.board, disputed: u.disputed })),
        abandons,
      };
      await this.save(m);
      for (const u of plan.users.filter((x) => x.disputed)) {
        await this.audit('pvp.dispute', { match: m.id, mode: m.mode, map: m.map, log: u.board, report: m.reports.get(u.userId)?.me, score: m.score, reported: m.reports.get(u.userId)?.score }, { id: u.userId, name: m.members.get(u.userId)?.name });
      }
      const net = plan.users.filter((u) => u.notes.some((n) => /network/.test(n)));
      if (net.length) await this.audit('pvp.network', { match: m.id, mode: m.mode, map: m.map, players: net.map((u) => m.members.get(u.userId)?.name) });
      for (const id of abandons) {
        const hostGone = id === hostId && V.HOST_GONE.has(m.endWhy);
        const msg = !hostGone ? undefined : m.endWhy === 'host-fault'
          ? (cd) => `Your game broke the match's rules while hosting it (${m.fault || 'the server couldn\'t follow it'}): that counts as abandoning it. No ranked matches for ${MM.formatWait(cd)}`
          : (cd) => `You left the match you were hosting: that counts as abandoning it. No ranked matches for ${MM.formatWait(cd)}`;
        await this.abandonUser(m, m.members.get(id), { quiet: true, msg });
      }
      // What each player is told: a void or cut-short match's why, then their pay.
      const overWhy = m.voidWhy ? (m.endWhy === 'over' ? 'void' : m.endWhy) : m.endWhy === 'over' ? null : m.endWhy;
      for (const x of humans) {
        if (x.abandoned || !overWhy) continue;
        if (V.HOST_GONE.has(m.endWhy) && x.userId === hostId) continue;
        const msg = m.voidWhy ? (m.endWhy === 'staff' ? MSG.staffVoid : MSG.void) : MSG[overWhy];
        this.push(x.userId, { t: 'pvp.over', id: m.id, why: overWhy, msg });
      }
      for (const u of m.plan.users) await this.payUser(m, u);
      await this.settleRest(m.id, now);
    } finally {
      for (const x of m.members.values()) { if (this.matchOf.get(x.userId) === m) this.matchOf.delete(x.userId); clearTimeout(x.pushTimer); }
      this.relay?.closeMatch(m.id, V.CLOSE.END, 'Match over');
      this.matches.delete(m.id);
    }
  }
  // pvp.reward's arguments for a player in the plan.
  rewardArgs(m, u) {
    return { mode: m.mode, result: u.result, kills: u.kills, assists: u.assists, mvps: u.mvps, roundsWon: u.roundsWon, roundsFor: u.roundsFor,
      roundsAgainst: u.roundsAgainst, opponent: u.opponent, mult: u.mult, rank: u.rank, stt: u.stt };
  }
  // Pays one player once: their state and their pvp_players row in one transaction (a row already paid rolls it back).
  async payUser(m, u) {
    const now = this.now();
    let out = null;
    try {
      await this.srv.store.withUser(u.userId, async (e) => {
        if (!this.srv.isOnline(u.userId) && !e.dirty && !e.saving) await this.srv.store.reload(e);
        const ctx = makeCtx(e.st, { ...this.srv.rules, online: true, system: true, now });
        const r = runAction(ctx, 'pvp.reward', u.args);
        this.srv.store.markDirty(e);
        await this.srv.store.commit([e], async (q) => {
          const { rows } = await q(`UPDATE pvp_players SET paid = $3, earned = $4, xp = $5, outcome = $6, stats = $7::jsonb
            WHERE match_id = $1 AND user_id = $2 AND paid IS NULL RETURNING 1`,
          [m.id, u.userId, now, r.earned, r.xp.total, u.outcome, JSON.stringify({ ...u.board, paid: { k: u.args.kills, a: u.args.assists, m: u.args.mvps }, mult: u.args.mult, notes: u.notes })]);
          if (!rows.length) throw new Settled();
        });
        out = { r, d: delta(ctx) };
      });
    } catch (e) {
      if (e instanceof Settled) return null;
      this.log('[pvp] pay failed', m.id, u.userId, e);
      return null;
    }
    this.srv.deltaTo(u.userId, out.d);
    const sq = u.squad, score = m.score || { A: 0, B: 0 };
    this.push(u.userId, {
      t: 'pvp.paid', id: m.id, result: u.args.result, score: { you: score[sq], them: score[V.otherSquad(sq)] }, earned: out.r.earned, xp: out.r.xp.total,
      pay: out.r.pay, mult: u.args.mult, notes: u.notes, rank: out.r.rank ? { change: out.r.rank.change, before: out.r.rank.before, after: out.r.rank.after } : null,
    });
    return out.r;
  }
  // Every row of the match not settled yet (void, or left with nothing): settled with nothing.
  async settleRest(matchId, now) {
    await this.db.query(`UPDATE pvp_players SET paid = $2, outcome = COALESCE(outcome, $3) WHERE match_id = $1 AND paid IS NULL`, [matchId, now, 'none'])
      .catch((e) => this.log('[pvp] settle failed', e.message));
  }

  // An abandon: not back in time, given up, or gone at the end. A loss for the mode's rank and the matchmaking cooldown
  // ('pvp.abandon'), once; the slot stays a bot's. Banned (or a map that wouldn't load): nothing, but the slot's still a bot.
  // msg(cooldown): what they're told, instead of the usual.
  async abandonUser(m, mem, { quiet = false, msg = null } = {}) {
    if (!mem || mem.abandoned) return { cooldown: 0 };
    const now = this.now();
    mem.abandoned = true;
    mem.state = 'abandoned';
    this.setControl(mem, false, now);
    if (this.matchOf.get(mem.userId) === m) this.matchOf.delete(mem.userId);
    this.pushMember(m, mem);
    this.relay?.closeSlot(m.id, mem.slot, V.CLOSE.END, 'You left the match');
    let cooldown = 0;
    if (mem.banned || mem.failed) {
      await this.db.query('UPDATE pvp_players SET paid = $3, outcome = $4 WHERE match_id = $1 AND user_id = $2 AND paid IS NULL', [m.id, mem.userId, now, mem.banned ? 'banned' : 'dodge'])
        .catch((e) => this.log('[pvp] settle failed', e.message));
    } else {
      const sq = mem.squad;
      const args = { mode: m.mode, opponent: V.opponentOf(m.slots, sq), roundsFor: m.score[sq], roundsAgainst: m.score[V.otherSquad(sq)] };
      const r = await this.penalize(m.id, mem.userId, args);
      cooldown = r?.cooldown || 0;
      if (r && msg) this.push(mem.userId, { t: 'pvp.over', id: m.id, why: 'abandoned', msg: msg(cooldown) });
      else if (r && !quiet) this.push(mem.userId, { t: 'pvp.over', id: m.id, why: 'abandoned', msg: `You abandoned the match: no ranked matches for ${MM.formatWait(cooldown)}` });
      else if (r) this.push(mem.userId, { t: 'pvp.over', id: m.id, why: 'abandoned', msg: `You weren't there at the end: no ranked matches for ${MM.formatWait(cooldown)}` });
    }
    await this.save(m);
    return { cooldown };
  }
  async penalize(matchId, userId, args) {
    let out = null;
    try {
      await this.srv.store.withUser(userId, async (e) => {
        if (!this.srv.isOnline(userId) && !e.dirty && !e.saving) await this.srv.store.reload(e);
        const ctx = makeCtx(e.st, { ...this.srv.rules, online: true, system: true, now: this.now() });
        const r = runAction(ctx, 'pvp.abandon', args);
        this.srv.store.markDirty(e);
        await this.srv.store.commit([e], async (q) => {
          const { rows } = await q(`UPDATE pvp_players SET paid = $3, outcome = 'abandon' WHERE match_id = $1 AND user_id = $2 AND paid IS NULL RETURNING 1`, [matchId, userId, this.now()]);
          if (!rows.length) throw new Settled();
        });
        out = { r, d: delta(ctx) };
      });
    } catch (e) {
      if (e instanceof Settled) return null;
      this.log('[pvp] abandon failed', matchId, userId, e);
      return null;
    }
    this.srv.deltaTo(userId, out.d);
    return out.r;
  }

  // Every row of the earlier matches (that went live, in the last day) these players were in: anti-farm's history.
  async history(m) {
    const ids = [...m.members.keys()];
    const { rows } = await this.db.query(`SELECT p.match_id AS match, p.user_id AS "user", p.squad, p.at FROM pvp_players p
      WHERE p.match_id IN (SELECT q.match_id FROM pvp_players q JOIN pvp_matches x ON x.id = q.match_id
        WHERE q.user_id = ANY($1::int[]) AND q.at >= $2 AND q.match_id <> $3 AND x.started IS NOT NULL)`, [ids, m.created - V.FARM.WINDOW, m.id]);
    return rows.map((r) => ({ match: r.match, user: r.user, squad: r.squad, at: Number(r.at) }));
  }
  // Pairs of these players ('lower:higher') on one network: now (the relay's sockets), or within NETWORK_DAYS (user_ips).
  async networks(m) {
    const ids = [...m.members.keys()], out = new Set();
    const pair = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);
    const { rows } = await this.db.query(`SELECT DISTINCT a.user_id AS a, b.user_id AS b FROM user_ips a JOIN user_ips b ON a.ip_hash = b.ip_hash AND a.user_id < b.user_id
      WHERE a.user_id = ANY($1::int[]) AND b.user_id = ANY($1::int[]) AND a.last >= $2 AND b.last >= $2`, [ids, Date.now() - V.NETWORK_DAYS * DAY]);
    for (const r of rows) out.add(pair(r.a, r.b));
    const xs = [...m.members.values()].filter((x) => x.ipHash);
    for (const a of xs) for (const b of xs) if (a.userId < b.userId && a.ipHash === b.ipHash) out.add(pair(a.userId, b.userId));
    return out;
  }

  // ---- staff, kicks and the switch ---------------------------------------------------------------------------------------
  // srv.kick (a ban, a kick, a sign-out, maintenance): out of the queue and any match found, and their slot's a bot now. A
  // ban pays nothing and gives no cooldown.
  kickUser(id, code) {
    if (this.queue.has(id)) this.queue.delete(id);
    const f = this.foundOf.get(id);
    // (A match found and waiting for accepts: a kick or a sign-out then is a dodge like any match not accepted, so it's no
    // way round one; a ban just takes them out of it.)
    if (f) this.cancelFound(f, 'declined', code === 'banned' || code === 'maintenance' ? new Set() : new Set([id]), code === 'banned' || code === 'maintenance' ? { drop: id } : {});
    const m = this.matchOf.get(id);
    if (!m || m.finalizing) return;
    const mem = m.members.get(id);
    if (code === 'banned') mem.banned = true;
    if (this.connected(m, mem)) {
      mem.kicked = true;
      this.relay.kickUser(id, code === 'maintenance' ? V.CLOSE.MAINTENANCE : V.CLOSE.BANNED);
    } else if (mem.state === 'dropped' && m.host != null && mem.slot !== m.host) {
      mem.state = 'bot';
      this.setControl(mem, false, this.now());
      this.pushMember(m, mem);
    }
  }
  // Maintenance on: every match ends now (finished rounds paid), every lobby waiting for accepts is off. (Called before
  // the players are thrown off, so who's there now is who's paid.)
  async maintenance() {
    for (const f of [...this.founds.values()]) this.cancelFound(f, 'maintenance', new Set(), { requeue: false });
    for (const m of [...this.matches.values()]) {
      if (m.finalizing || m.ending) continue;
      if (m.host == null) await this.track(this.cancelLoading(m, 'maintenance', new Set(), { requeue: false }));
      else { m.endWhy = 'maintenance'; await this.track(this.endMatch(m, 'maintenance')); }
    }
  }
  // The admin switch: off, the queue and the lobbies waiting for accepts are emptied (matches being played finish).
  settingsChanged(before, next) {
    if (next.pvp !== false || before.pvp === false) return;
    for (const e of [...this.queue.values()]) {
      this.queue.delete(e.userId);
      this.push(e.userId, { t: 'pvp.cancel', id: null, why: 'staff', requeued: false, msg: 'Online matches were turned off on this server' });
    }
    for (const f of [...this.founds.values()]) this.cancelFound(f, 'staff', new Set(), { requeue: false });
  }
  // Staff end a match: as cut short, the finished rounds paid (pay), or void.
  async staffEnd(actor, id, pay) {
    const m = this.matches.get(String(id ?? ''));
    if (!m || m.finalizing) fail('That match is over', 'missing');
    if (m.ending) fail('That match is ending already');
    const info = { id: m.id, mode: m.mode, map: m.map, score: { ...m.score }, rounds: m.rounds.length, players: [...m.members.values()].map((x) => x.name) };
    if (m.host == null) await this.track(this.cancelLoading(m, 'staff', new Set(), { requeue: false }));
    else {
      if (!pay) await this.voidMatch(m, 'Staff ended it without pay', actor);
      m.endWhy = 'staff';
      await this.track(this.endMatch(m, 'staff'));
    }
    return info;
  }
  // The live matches for the admin panel.
  live() {
    return [...this.matches.values()].filter((m) => !m.finalizing).map((m) => ({
      id: m.id, mode: m.mode, map: m.map, status: m.status, score: { ...m.score }, round: m.rounds.length, created: m.created, liveAt: m.liveAt,
      paused: m.paused ? { why: m.paused.why, until: m.paused.until } : null, void: m.voidWhy, ending: m.ending?.why || null, host: m.host,
      members: [...m.members.values()].map((x) => ({ slot: x.slot, squad: x.squad, id: x.userId, name: x.name, state: x.state, connected: this.connected(m, x), host: x.slot === m.host })),
      bots: m.slots.filter((s) => s.kind === 'bot').length,
    }));
  }
  stats() {
    let matches = 0;
    for (const m of this.matches.values()) if (!m.finalizing) matches++;
    return { queued: this.queue.size, matches, members: this.relay?.stats().members ?? 0 };
  }

  // ---- persistence -------------------------------------------------------------------------------------------------------
  toRow(m) {
    const members = [...m.members.values()].map((x) => ({
      userId: x.userId, name: x.name, slot: x.slot, squad: x.squad, state: x.state, load: x.load, ready: x.ready, since: x.since, hostLeft: x.hostLeft,
      drops: x.drops, control: x.control, eligible: x.eligible, abandoned: x.abandoned, banned: x.banned, failed: x.failed,
    }));
    const data = {
      seed: m.seed, site: m.site, sides: m.sides, slots: m.slots, content: m.content, loadBy: m.loadBy, startedAt: m.startedAt, liveAt: m.liveAt,
      host: m.host, backups: m.backups, rounds: m.rounds, score: m.score, pauses: m.pauses, paused: m.paused, checkpoint: m.checkpoint,
      reports: Object.fromEntries(m.reports), hosts: m.hosts, migrations: m.migrations, endWhy: m.endWhy, voidWhy: m.voidWhy, logEnd: m.logEnd,
      endWaitBy: m.endWaitBy, ending: m.ending, plan: m.plan, fault: m.fault || null, contested: !!m.contested,
    };
    return { members: JSON.stringify(members), data: JSON.stringify(data) };
  }
  // The match's row written: one write at a time and at most one more waiting, which writes the match as it is when its
  // turn comes (however many saves were asked for meanwhile: a member can't queue up writes by the frame).
  save(m) {
    if (m.savePending) return m.savePending;
    const run = () => {
      m.savePending = null;
      const row = this.toRow(m), hostId = this.memberAt(m, m.host)?.userId ?? null;
      const args = [m.id, m.status, hostId, row.members, row.data, m.liveAt, m.ended, this.now()];
      return this.db.query(`UPDATE pvp_matches SET status = $2, host_id = $3, members = $4::jsonb, data = $5::jsonb, started = $6,
        ended = $7, updated = $8 WHERE id = $1`, args).catch((e) => this.log('[pvp] save failed', m.id, e.message));
    };
    m.savePending = m.saveQ = m.saveQ.then(run);
    return m.saveQ;
  }
  fromRow(r) {
    const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
    const d = parse(r.data), members = new Map();
    for (const x of parse(r.members)) {
      members.set(x.userId, { ...x, connected: false, kicked: false, qrtt: [], mrtt: [], entry: null, ipHash: null, pushedAt: 0, pushTimer: null, stage: null, drops: x.drops || [], control: x.control || [] });
    }
    return {
      id: r.id, mode: r.mode, map: r.map, app: r.app, status: r.status, created: Number(r.created), ended: null, members,
      seed: d.seed, site: d.site ?? null, sides: d.sides, slots: d.slots, content: d.content, loadBy: d.loadBy, startedAt: d.startedAt ?? null,
      liveAt: d.liveAt ?? null, host: d.host ?? null, backups: d.backups || [], rounds: d.rounds || [], score: d.score || { A: 0, B: 0 },
      pauses: d.pauses || [], paused: d.paused || null, checkpoint: d.checkpoint ?? null, reports: new Map(Object.entries(d.reports || {}).map(([k, v]) => [Number(k), v])),
      hosts: d.hosts || [], migrations: d.migrations || 0, endWhy: d.endWhy ?? null, voidWhy: d.voidWhy ?? null, logEnd: d.logEnd ?? null,
      endWaitBy: d.endWaitBy ?? null, ending: d.ending ?? null, plan: d.plan ?? null, finalizing: false, electing: false, blocks: new Set(),
      fault: d.fault ?? null, contested: !!d.contested, saveQ: Promise.resolve(), savePending: null,
    };
  }

  // At the start: a match still loading is off (the queue lived in memory); a live one waits, paused, for its players
  // (RESTART_GRACE for its host), from its last heartbeat. A finished one not paid to everyone is paid now.
  // The dodges still running, or still counting towards the next one (pvp_dodges).
  async loadDodges() {
    const now = this.now();
    const { rows } = await this.db.query('SELECT user_id, n, last, until, fails FROM pvp_dodges WHERE until > $1 OR last > $2', [now, now - V.QUEUE.DODGE_WINDOW]);
    for (const d of rows) this.dodges.set(d.user_id, { n: d.n, last: Number(d.last), until: Number(d.until), fails: d.fails });
  }
  async restore() {
    const now = this.now();
    await this.loadDodges();
    const { rows } = await this.db.query("SELECT * FROM pvp_matches WHERE status IN ('loading', 'live', 'paused')");
    for (const r of rows) {
      try {
        const m = this.fromRow(r);
        if (m.liveAt == null) {
          m.status = 'cancelled';
          m.endWhy = 'restart';
          m.ended = now;
          await this.save(m);
          await this.db.query("UPDATE pvp_players SET paid = $2, outcome = 'cancelled' WHERE match_id = $1 AND paid IS NULL", [m.id, now]);
          continue;
        }
        m.blocks = await this.blocksOf([...m.members.keys()]);
        if (!m.ending) {
          const open = m.pauses.at(-1);
          const from = open && open.to == null ? open.from : Number(r.updated);
          if (open && open.to == null) open.why = 'restart'; else m.pauses.push({ from, to: null, why: 'restart' });
          m.paused = { why: 'restart', until: now + this.T.RESTART_GRACE, from, prev: 'live' };
          m.status = 'paused';
        }
        this.matches.set(m.id, m);
        for (const x of m.members.values()) if (!x.abandoned) this.matchOf.set(x.userId, m);
        await this.save(m);
      } catch (e) { this.log('[pvp] could not restore a match', r.id, e); }
    }
    const { rows: unpaid } = await this.db.query(`SELECT DISTINCT m.id, m.mode, m.data FROM pvp_matches m JOIN pvp_players p ON p.match_id = m.id
      WHERE m.status IN ('over', 'void', 'cancelled') AND p.paid IS NULL`);
    for (const r of unpaid) await this.settleUnpaid(r).catch((e) => this.log('[pvp] could not settle a match', r.id, e));
  }
  // A finished match's rows still unpaid (a restart while it was being settled): its kept plan, each row once.
  async settleUnpaid(r) {
    const d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    const plan = d.plan || { users: [], abandons: [] }, now = this.now();
    for (const id of plan.abandons || []) {
      const sq = d.slots?.find((s) => s.userId === id)?.squad || 'A';
      await this.penalize(r.id, id, { mode: r.mode, opponent: V.opponentOf(d.slots || [], sq), roundsFor: d.score?.[sq] || 0, roundsAgainst: d.score?.[V.otherSquad(sq)] || 0 });
    }
    for (const u of plan.users || []) await this.payUser({ id: r.id, score: d.score }, u);
    await this.settleRest(r.id, now);
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.ticking?.catch(() => {});
    const now = this.now();
    for (const f of this.founds.values()) for (const e of f.entries) this.push(e.userId, { t: 'pvp.cancel', id: f.id, why: 'restart', requeued: false, msg: cancelMsg('restart') });
    for (const m of this.matches.values()) {
      if (m.finalizing) continue;
      if (m.host == null || m.liveAt == null) {
        for (const x of m.members.values()) if (!x.abandoned) this.push(x.userId, { t: 'pvp.cancel', id: m.id, why: 'restart', requeued: false, msg: cancelMsg('restart') });
        continue;
      }
      if (!m.ending && m.status === 'live') {
        m.pauses.push({ from: now, to: null, why: 'restart' });
        m.paused = { why: 'restart', until: now + this.T.RESTART_GRACE, from: now, prev: 'live' };
        m.status = 'paused';
        // (Said before the sockets close: the host stops its match's clock now, not when its link notices.)
        this.relay?.broadcast(m.id, { t: 'pause', why: 'restart', until: m.paused.until });
      }
      this.save(m);
    }
    await Promise.allSettled([...this.busy]);
    await Promise.allSettled([...this.matches.values()].map((m) => m.saveQ));
    for (const m of this.matches.values()) for (const x of m.members.values()) clearTimeout(x.pushTimer);
  }
}

function cancelMsg(why) {
  return {
    declined: 'Not everyone accepted the match', timeout: 'Not everyone accepted the match in time', 'load-failed': 'Not everyone could load the match',
    restart: 'The server restarted: search again', staff: 'Staff called the match off', maintenance: 'The server is going into maintenance',
  }[why] || 'The match was called off';
}
