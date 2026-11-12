// Online PvP: the host's side. This game runs the whole match (it's a listen server): its own player as in any match, the
// bots with their brains, and each remote player as a body moved by their commands (net-pawn.js). It runs on its own
// clock (net-match.js MatchClock, not the frame), and every second tick sends one bundle through the server's relay: the
// part everyone gets (the match, every body, the scoreboard, doors and glass, what happened: shots, hits, kills, grenades,
// the bomb, the round) and each client's own (their movement exactly, their weapons, their acknowledged command). A remote
// player's shot is tested where they saw everyone (lagcomp.js). As each round ends it tells the server how ({ t: 'round' }:
// the server keeps its own log and pays from it), and at the end the score ({ t: 'end' }).
import { CLOSE, KILL, NONE, ROUND_WHY } from '../engine/pvp.js';
import { NetPawn } from './net-pawn.js';
import { LagComp } from './lagcomp.js';
import { mapSlots, skinSlot, knifeWid, MatchClock, TICK, playersOnBoard, serverChat, endScreen } from './net-match.js';
import { SharedEncoder, Writer, writeOwn, bundleFrame, keyFrame, jsonFrame, readInputs, moveState, EV, SHOT_F, ROUND_KIND, BOMB_KIND, F, F2, OWN, BUY_IDS, WEAPON_IDS } from './net-codec.js';
import { LOCAL } from './drops.js';
import { NameTags } from './nametags.js';

const WHY = { elimination: 'elim', bomb: 'bomb', defuse: 'defuse', time: 'time' };
const WID_NO = new Map(WEAPON_IDS.map((id, i) => [id, i]));
void ROUND_WHY;

export class NetHost {
  // info: { id, mode, slot (ours), slots, sides, seed, members } (the server's joined), link: the /match socket (pvp.js).
  constructor(game, link, info, { onEnd = null } = {}) {
    this.game = game; this.link = link; this.info = info; this.seed = info.seed >>> 0; this.onEnd = onEnd;
    this.role = 'host';
    this.events = []; this.roundKills = []; this.tickNo = 0; this.dropId = 0; this.stt = new Map(); this.kills = 0;
    this.members = new Map((info.members || []).map((x) => [x.slot, x.state]));
    this.rtt = {};
    this.enc = new SharedEncoder();
    this.w = new Writer(16384); this.ow = new Writer(1024);
    this.lag = new LagComp();
    this.stats = { up: 0, frames: 0, at: performance.now(), upRate: 0, cmdsIn: 0, clamped: 0, clampRate: 0 };
    this.lastWeapons = new Map();
    // Rounds told to the server and not acknowledged yet ({ t: 'round.ok', n }): sent again once the link is back (one sent
    // while it was down never got there). winners: each round's, by the server's squads (the report's `w`).
    this.outbox = []; this.winners = ''; this.lastRoundTick = 0;
    this.keyAt = new Map(); this.keyWant = new Set(); // (keyframes asked for: one a slot a second at most)
    this.linkDown = false; this.serverPaused = false;
  }

  // After the map's loaded (everyone's game loads the same match): who's who, the remote players' bodies under their
  // commands, and what the host tells everyone about.
  attach() {
    const g = this.game;
    this.slots = mapSlots(g, this.info);
    this.pawns = [];
    for (const x of this.slots.bySlot.values()) {
      if (x.info?.kind !== 'human' || !x.b) continue;
      const p = new NetPawn(this, x.b, x.slot, x.info);
      x.b.brain = p;
      x.pawn = p;
      this.pawns.push(p);
    }
    this.pawnOf = new Map(this.pawns.map((p) => [p.slot, p]));
    g.pvp = this;
    g.remote = false;
    this.wrap();
    serverChat(g, (m) => this.link.send(m));
    g.scoreData = () => playersOnBoard(g, this.slots, { picUrl: this.picUrl, ping: (s) => (s === this.slots.mine ? 'HOST' : this.rtt[s] != null ? `${this.rtt[s] + (this.rtt[this.slots.mine] || 0)} ms` : ''), bot: (s) => !!this.pawnOf.get(s)?.bot });
    g.netText = () => this.netText();
    this.tags = new NameTags(g);
  }

  // The match starts ({ t: 'start' }, with us the host): round 1's freeze time, everyone's keyframe, and live.
  start() {
    const g = this.game;
    this.applyMembers();
    g.match.startRound();
    this.clock = new MatchClock(g, { onRun: () => {} });
    g.clock = this.clock;
    for (const p of this.pawns) this.keyframe(p.slot);
    this.link.send({ t: 'live', tick: this.tickNo });
    this.lastRoundTick = this.tickNo;
    this.started = true;
    if (this.linkDown || this.serverPaused) this.clock.pause(true);
  }
  // The link to the server (pvp.js): down (trying again), the match's clock stops at once, as everyone else's game can't
  // see it go on (a round played meanwhile would be one the server never saw: its log broken); back (joined), the rounds it
  // didn't acknowledge are sent again, and the clock goes on unless the server has the match paused (its resume says when).
  onLink(up) {
    if (up) return;
    this.linkDown = true;
    this.clock?.pause(true);
  }
  onJoined(j) {
    const wasDown = this.linkDown;
    this.linkDown = false;
    this.serverPaused = !!j.paused;
    if (this.started) this.link.send({ t: 'live', tick: this.tickNo }); // (in case ours never got there: the server takes the first)
    for (const r of this.outbox) this.link.send(r);
    if (!wasDown || !this.started) return;
    if (!this.serverPaused) { this.clock?.pause(false); for (const p of this.pawns) this.keyframe(p.slot); }
  }

  // ---- what the game does, told to everyone -----------------------------------------------------------------------------
  wrap() {
    const g = this.game, host = this, S = this.slots;
    const slotOf = (c) => (c ? S.ofC.get(c) ?? NONE : NONE);
    const wrap = (obj, name, fn) => { const orig = obj[name].bind(obj); obj[name] = (...a) => fn(orig, ...a); };
    const tick = g.tick.bind(g);
    // (A tick that throws still ends as a tick: its snapshot goes, and the next one runs. net-match.js MatchClock logs it.)
    g.tick = () => { this.preTick(); try { tick(); } finally { this.postTick(); } };
    wrap(g, 'fireBullet', (orig, shooter, origin, dir, gun, opts = {}) => {
      const slot = slotOf(shooter);
      if (slot !== NONE) {
        const key = slot + '|' + g.now, first = this.shotKey !== key;
        this.shotKey = key;
        this.ev({ type: EV.SHOT, slot, wid: gun?.id || '', origin: origin.slice(), dir: dir.slice(), flags: (opts.tracer ? SHOT_F.TRACER : 0) | (first ? SHOT_F.SOUND : 0) | (gun?.silenced ? SHOT_F.SILENCED : 0) });
      }
      return orig(shooter, origin, dir, gun, opts);
    });
    wrap(g, 'damage', (orig, c, dmg, o = {}) => {
      const was = c.alive ? c.health : 0, r = orig(c, dmg, o);
      const lost = was - Math.max(0, c.health);
      if (lost > 0) this.ev({ type: EV.HURT, attacker: slotOf(o.attacker), victim: slotOf(c), dmg: Math.round(lost), group: o.group || 'chest', point: o.point, dir: o.dir });
      return r;
    });
    wrap(g, 'kill', (orig, c, attacker, weapon, headshot, how = {}) => {
      if (!c.alive) return orig(c, attacker, weapon, headshot, how);
      const by = attacker && attacker !== c;
      const air = by && g.inAir(attacker), blind = by && g.isBlind(attacker), assister = this.assisterOf(c, attacker), phase = g.match.phase;
      const r = orig(c, attacker, weapon, headshot, how);
      const flags = (headshot ? KILL.HS : 0) | (how.wallbang ? KILL.WALLBANG : 0) | (how.noscope ? KILL.NOSCOPE : 0) | (how.smoke ? KILL.SMOKE : 0) | (blind ? KILL.BLIND : 0) | (attacker ? 0 : KILL.WORLD);
      const killer = slotOf(attacker), victim = slotOf(c), wid = weapon?.id || '';
      // (Kills after the round's decided aren't in its log (the next round's would count them twice), nor in anyone's own
      // count for the report: the KILL event says so, LATE.)
      const counts = phase === 'live' || phase === 'planted';
      this.ev({ type: EV.KILL, attacker: killer, victim, assister, wid, flags: flags | (counts ? 0 : KILL.LATE), how: air ? 1 : 0 });
      if (counts) this.roundKills.push([killer, victim, assister, WID_NO.get(wid) ?? 0, flags]);
      if (counts && attacker === g.me && c.team !== g.me.team) this.kills++;
      return r;
    });
    wrap(g.nades, 'throw', (orig, c, id, origin, vel) => {
      const n = orig(c, id, origin, vel);
      if (n) this.ev({ type: EV.NADE, slot: slotOf(c), wid: id, origin: origin.slice(), vel: vel.slice() });
      return n;
    });
    wrap(g.drops, 'drop', (orig, gun, pos, vel, by) => {
      const it = orig(gun, pos, vel, by);
      it.netId = ++this.dropId & 0xffff;
      this.ev({ type: EV.DROP, op: 0, id: it.netId, wid: gun.id, skin: skinSlot(gun.skin, S.mine), pos: pos.slice(), vel: vel.slice() });
      return it;
    });
    wrap(g.drops, 'take', (orig, it) => {
      const r = orig(it);
      if (r && it.netId != null) this.ev({ type: EV.DROP, op: 1, id: it.netId });
      return r;
    });
    // A remote player's own guns (net-pawn.js) where the game gives a bot one: a new round, walking over a gun, the bomb.
    const pawnOf = (c) => { const p = g.botOf(c)?.pawn; return p && !p.bot ? p : null; };
    wrap(g, 'respawnBot', (orig, b, sp, died) => (b.pawn?.respawn(sp, died) ? undefined : orig(b, sp, died)));
    wrap(g, 'pickUp', (orig, c, it) => { const p = c !== g.me && pawnOf(c); return p ? p.pickUp(it) : orig(c, it); });
    wrap(g, 'onBombPickedUp', (orig, c) => {
      this.ev({ type: EV.BOMB, kind: BOMB_KIND.PICKED, slot: slotOf(c) });
      const p = c !== g.me && pawnOf(c);
      if (!p) return orig(c);
      g.removeBomb();
      p.giveC4();
    });
    wrap(g, 'onPlanted', (orig, c, bomb, o = {}) => { const r = orig(c, bomb, o); this.ev({ type: EV.BOMB, kind: BOMB_KIND.PLANTED, slot: slotOf(c), pos: bomb.pos, yaw: c === g.me ? g.input.yaw : g.botOf(c)?.yaw || 0 }); return r; });
    wrap(g, 'onDefused', (orig, c) => { this.ev({ type: EV.BOMB, kind: BOMB_KIND.DEFUSED, slot: slotOf(c), pos: g.match.bomb?.pos }); return orig(c); });
    wrap(g, 'onExploded', (orig, bomb) => { this.ev({ type: EV.BOMB, kind: BOMB_KIND.EXPLODED, slot: NONE, pos: bomb.pos }); return orig(bomb); });
    wrap(g, 'onBombDropped', (orig, bomb) => { this.ev({ type: EV.BOMB, kind: BOMB_KIND.DROPPED, slot: NONE, pos: bomb.pos }); return orig(bomb); });
    wrap(g, 'onDefuseStart', (orig, c) => { this.ev({ type: EV.BOMB, kind: BOMB_KIND.DEFUSING, slot: slotOf(c || g.match.bomb?.defuser) }); return orig(c); });
    wrap(g, 'onRoundStart', (orig, round, o = {}) => {
      this.roundKills = [];
      const r = orig(round, o);
      this.ev({ type: EV.ROUND, kind: ROUND_KIND.START, round, flags: (o.halftime ? 1 : 0) | (o.pistol ? 2 : 0), overtime: o.overtime || 0 });
      return r;
    });
    wrap(g, 'onLive', (orig) => { this.ev({ type: EV.ROUND, kind: ROUND_KIND.LIVE, round: g.match.round }); return orig(); });
    wrap(g, 'onRoundEnd', (orig, winner, reason, mvp) => {
      const r = orig(winner, reason, mvp);
      this.ev({ type: EV.ROUND, kind: ROUND_KIND.END, round: g.match.round, winner, reason, mvp: slotOf(mvp), mvpKills: mvp?.roundKills || 0 });
      this.reportRound(winner, reason, mvp);
      return r;
    });
    // Bots' chatter and your radio calls, for everyone on that side (the radio plays only your own side's).
    const said = new Map();
    wrap(g.radio, 'say', (orig, c, line, text, o = {}) => {
      const slot = slotOf(c), now = g.now;
      if (slot !== NONE && c?.alive !== false && (o.force || now - (said.get(c) ?? -99) >= 5)) { said.set(c, now); this.ev({ type: EV.RADIO, slot, line: line || '', text: text || '' }); }
      return orig(c, line, text, o);
    });
    // Your StatTrak™ kills: counted for the report (the server adds them, up to the kills it pays), not one by one.
    g.countStatTrak = (gun) => {
      const it = gun?.skin?.owner === LOCAL ? gun.skin.item : null;
      if (it?.stt && it.uid) this.stt.set(it.uid, (this.stt.get(it.uid) || 0) + 1);
    };
    g.onMatchOver = (squad) => this.matchOver(squad);
    // Bodies' gestures (reloading, throwing, flinching...) for everyone's copy of them.
    const clips = g.botAssets.clips;
    for (const b of g.bots) {
      const slot = slotOf(b.c);
      const ges = b.gesture.bind(b), rel = b.reloadGesture.bind(b), fl = b.flashed.bind(b);
      b.gesture = (clip, o = {}) => {
        const kind = clip === clips.throw ? 'throw' : clip === clips.lob ? 'lob' : clip === clips.pullpin ? 'pullpin' : clip === clips.flinchHead ? 'flinchHead'
          : clip === clips.flinchChest ? 'flinchChest' : clip === clips.flinchStomach ? 'flinchStomach' : null;
        if (kind) this.ev({ type: EV.GEST, slot, kind, secs: 0 });
        return ges(clip, o);
      };
      b.reloadGesture = (id, secs) => { this.ev({ type: EV.GEST, slot, kind: 'reload', secs }); return rel(id, secs); };
      b.flashed = (secs) => { this.ev({ type: EV.GEST, slot, kind: 'flashed', secs }); return fl(secs); };
    }
  }
  ev(e) { if (this.events.length < 240) this.events.push(e); }

  // Who gets the assist for a kill: the one (not the killer, on the other side) who did the most damage over 40 this round.
  assisterOf(victim, killer) {
    let best = NONE, most = 40;
    for (const [id, dmg] of victim.roundDamage || []) {
      const a = this.game.combatants.find((c) => c.id === id);
      if (!a || a === killer || a.team === victim.team || dmg <= most) continue;
      most = dmg; best = this.slots.ofC.get(a) ?? NONE;
    }
    return best;
  }

  // ---- the round log and the end ----------------------------------------------------------------------------------------
  serverScore() { const s = this.game.match.score, S = this.slots; return { [S.server('A')]: s.A, [S.server('B')]: s.B }; }
  serverSquadOf(side) { const c = this.game.combatants.find((x) => x.team === side); return c ? this.slots.server(c.squad) : null; }
  // ticks: the round's own length by this game's clock (it stops while the match is paused), which the server takes for a
  // round its restart's pause ran into.
  reportRound(winner, reason, mvp) {
    const m = this.game.match, w = this.serverSquadOf(winner);
    if (!w) return;
    const msg = { t: 'round', n: m.round, w, why: WHY[reason] || 'time', score: this.serverScore(), kills: this.roundKills.slice(0, 40),
      mvp: mvp ? this.slots.ofC.get(mvp) ?? NONE : NONE, mvpWhy: reason === 'defuse' ? 'defuse' : reason === 'bomb' ? 'plant' : 'kills', ticks: this.tickNo - this.lastRoundTick };
    this.lastRoundTick = this.tickNo;
    this.winners = this.winners.padEnd(m.round - 1, '.') + w;
    this.outbox.push(msg);
    if (this.outbox.length > 30) this.outbox.shift();
    this.link.send(msg);
    this.roundKills = [];
  }
  matchOver(squad) {
    const g = this.game, S = this.slots, score = this.serverScore();
    const wonSq = squad == null ? null : S.server(squad);
    this.ev({ type: EV.ROUND, kind: ROUND_KIND.OVER, round: g.match.round, flags: wonSq === 'A' ? 1 : wonSq === 'B' ? 2 : 0 });
    this.flushSoon = true;
    this.link.send({ t: 'end', score });
    endScreen(g, { won: squad === 'A', draw: squad == null, score: { you: g.match.score.A, them: g.match.score.B } });
  }
  // The report this game sends at the end: its own count (the server pays the lower of it and its log).
  report() {
    const g = this.game, me = g.me;
    return { t: 'report', score: this.serverScore(), board: this.boardRows().map((x) => ({ s: x.slot, k: x.k, a: x.a, d: x.d, m: x.m, dmg: x.dmg })), from: 1, w: this.winners,
      me: { k: Math.max(0, this.kills), a: Math.max(0, me.assists), d: me.deaths, m: me.mvps || 0, stt: [...this.stt].map(([uid, k]) => ({ uid, k })) } };
  }

  // ---- the socket ---------------------------------------------------------------------------------------------------------
  onBinary(u8) {
    if (u8[0] !== 0x81) return;
    for (const { slot, cmds } of readInputs(u8)) { const p = this.pawnOf.get(slot); if (p) { p.take(cmds); this.stats.cmdsIn += cmds.length; } }
  }
  onText(msg) {
    const g = this.game;
    switch (msg.t) {
      case 'member': this.members.set(msg.slot, msg.state); this.applyMembers(); return;
      case 'key': if (this.started) this.wantKey(msg.slot); return;
      case 'round.ok': this.outbox = this.outbox.filter((r) => r.n > msg.n); return;
      case 'rtt': this.rtt = msg.ms || {}; return;
      case 'chat': { const c = this.slots.cOf(msg.slot); if (c) g.say(c, String(msg.text || ''), !!msg.team); return; }
      case 'pause': this.serverPaused = true; this.clock?.pause(true); return;
      case 'resume':
        this.serverPaused = false;
        if (!this.linkDown) this.clock?.pause(false);
        if (this.started) for (const p of this.pawns) this.keyframe(p.slot);
        return;
      case 'end': this.ended = true; if (msg.report) this.link.send(this.report()); return;
    }
  }
  // A keyframe asked for: at most one a second a slot (the rest wait for that second to pass: postTick).
  wantKey(slot) {
    if (performance.now() - (this.keyAt.get(slot) || -1e9) >= 1000) this.keyframe(slot);
    else this.keyWant.add(slot);
  }
  // Members' states: a bot plays for anyone who isn't there (gone, loading again, or given up); they get it back at the next
  // freeze time once they are.
  applyMembers() {
    if (!this.started && !this.game.match) return;
    for (const p of this.pawns) {
      const st = this.members.get(p.slot);
      if (st === 'bot' || st === 'loading' || st === 'abandoned') { if (!p.bot) p.takeover(); p.wantBack = false; }
      else if (st === 'in' && p.bot) p.wantBack = true;
    }
  }

  // ---- a tick -------------------------------------------------------------------------------------------------------------
  preTick() {
    for (const p of this.pawns) {
      if (p.bot) { p.queue.length = 0; p.cur = null; continue; }
      p.nextCmd();
    }
  }
  postTick() {
    const t = ++this.tickNo;
    this.lag.record(t, this.handles());
    if (t % 2 === 0 || this.flushSoon) { this.flushSoon = false; this.sendBundle(); }
    if (this.keyWant.size && t % 8 === 0) for (const slot of [...this.keyWant]) if (performance.now() - (this.keyAt.get(slot) || -1e9) >= 1000) { this.keyWant.delete(slot); this.keyframe(slot); }
  }
  // Each body's handle for lag compensation (where it is, and putting it somewhere for a moment).
  handles() {
    if (this.hl) return this.hl;
    const g = this.game, out = [];
    for (const x of this.slots.bySlot.values()) {
      if (x.c === g.me) {
        out.push({ key: x.slot, get: () => ({ pos: g.player.origin.slice(), yaw: g.input.yaw, ducked: g.player.ducked, alive: g.me.alive }), set: (s) => { g.player.origin = s.pos.slice(); } });
      } else {
        const b = x.b;
        out.push({ key: x.slot, get: () => ({ pos: b.pos.slice(), yaw: b.bodyYaw, ducked: b.ducked, alive: b.c.alive }), set: (s) => { b.pos = s.pos.slice(); b.bodyYaw = s.yaw; } });
      }
    }
    return (this.hl = out);
  }
  // A remote player's shot, tested where they saw everyone.
  rewindFor(pawn, fn) {
    const view = (pawn.cur?.view ?? this.tickNo * 256) / 256, t = this.lag.clampTick(view, this.tickNo);
    if (t > view + 0.5) this.stats.clamped++; // (further back than lag compensation goes: net_graph counts them)
    return this.lag.rewind(t, this.handles(), pawn.slot, fn);
  }
  fireNet(pawn, origin, dir, gun, opts = {}) {
    return this.rewindFor(pawn, () => this.game.fireBullet(pawn.c, origin, dir, gun, { ...opts, muzzle: pawn.b.muzzle() }));
  }
  pinged(pawn, pos) { this.ev({ type: EV.PING, slot: pawn.slot, pos }); }

  // ---- snapshots ------------------------------------------------------------------------------------------------------------
  sharedState() {
    const g = this.game, m = g.match, S = this.slots, slotOf = (c) => (c ? S.ofC.get(c) ?? NONE : NONE);
    const sides0 = this.info.sides || { A: 'CT', B: 'T' };
    const aNow = g.combatants.find((c) => S.server(c.squad) === 'A')?.team;
    const bomb = m.bomb || {};
    const match = {
      phase: m.phase, round: m.round, score: this.serverScore(), swapped: !!aNow && aNow !== sides0.A, time: m.time,
      bomb: { state: bomb.state || 'carried', carrier: slotOf(bomb.carrier), pos: bomb.pos || [0, 0, 0], site: bomb.site || '', plantedLeft: bomb.state === 'planted' ? Math.max(0, m.rules.bombTime - (g.now - bomb.plantedAt)) : 0,
        defuser: slotOf(bomb.defuser), defuseLeft: bomb.defuser ? Math.max(0, bomb.defuseEnd - g.now) : 0 },
      timeout: m.timeout && m.phase === 'freeze' ? Math.max(0, m.timeout.left) : 0,
    };
    const bodies = [];
    for (const x of S.bySlot.values()) bodies.push(this.bodyState(x));
    return { match, bodies, board: this.boardRows(), doors: (g.doors?.list || []).map((d, idx) => ({ idx, angle: d.angle, target: d.target })), panes: (g.doors?.panes || []).map((p, idx) => ({ idx, broken: !!p.broken })) };
  }
  boardRows() {
    const S = this.slots;
    return [...S.bySlot.values()].map(({ slot, c }) => ({ slot, k: c.kills, a: c.assists, d: c.deaths, m: c.mvps || 0, score: c.score, dmg: Math.round(c.damage || 0), money: c.money }));
  }
  bodyState(x) {
    const g = this.game, c = x.c, S = this.slots;
    let flags = c.alive ? F.ALIVE : 0, flags2 = 0, pos, vel, yaw, pitch, held, skin, clip, reserve;
    if (c === g.me) {
      const p = g.player, gun = g.arsenal?.gun;
      pos = p.origin; vel = p.velocity; yaw = g.input.yaw; pitch = g.input.pitch;
      flags |= (p.ducked ? F.DUCKED : 0) | (p.onGround ? F.GROUND : 0) | (p.onLadder ? F.LADDER : 0) | (g.planting ? F.PLANTING : 0) | (g.defusing ? F.DEFUSING : 0) | (gun?.zoom ? F.SCOPED : 0);
      held = c.alive ? gun?.id || '' : ''; skin = skinSlot(gun?.skin, S.mine); clip = gun?.clip ?? 0; reserve = gun?.reserve ?? 0;
    } else {
      const b = x.b, w = b.weapons?.[b.slot];
      pos = b.pos; vel = b.vel; yaw = b.yaw; pitch = b.pitch;
      flags |= (b.ducked ? F.DUCKED : 0) | (!b.airborne && !b.climbing ? F.GROUND : 0) | (b.climbing ? F.LADDER : 0) | (b.mode === 'plant' ? F.PLANTING : 0) | (b.mode === 'defuse' ? F.DEFUSING : 0) | (w?.zoom ? F.SCOPED : 0);
      held = c.alive ? b.holding || '' : ''; skin = skinSlot(b.holdingSkin, S.mine); clip = w?.clip ?? 0; reserve = w?.reserve ?? 0;
      if (x.pawn?.bot) flags2 |= F2.BOT;
      const st = this.members.get(x.slot);
      if (st === 'dropped' || st === 'bot' || st === 'abandoned') flags2 |= F2.AWAY;
    }
    flags2 |= (c.helmet ? F2.HELMET : 0) | (c.defuser ? F2.KIT : 0) | (c.hasC4 ? F2.C4 : 0) | (g.isBlind(c) ? F2.BLIND : 0);
    return { slot: x.slot, pos, vel, yaw, pitch, flags, flags2, held, skin, hp: c.alive ? c.health : 0, armor: c.armor, clip, reserve, team: c.team === 'T' ? 1 : 0 };
  }
  ownBytes(p, { force = false } = {}) {
    const g = this.game, c = p.c, w = this.ow.reset();
    let flags = (c.alive && !p.bot ? OWN.ALIVE : 0) | (p.planting ? OWN.PLANTING : 0) | (p.defusing ? OWN.DEFUSING : 0) | (g.inBuyZone(c) ? OWN.BUYZONE : 0);
    const events = p.events.splice(0);
    if (p.teleport) { flags |= OWN.TELEPORT; events.push({ type: EV.TELEPORT, yaw: p.teleport.yaw, pitch: p.teleport.pitch }); p.teleport = null; }
    const ws = p.weaponsState(), key = JSON.stringify(ws), last = this.lastWeapons.get(p.slot);
    const send = force || !last || last.key !== key || this.tickNo - last.at > 64;
    if (send) this.lastWeapons.set(p.slot, { key, at: this.tickNo });
    // (depth: the fewest of their commands waiting at any tick since the last snapshot: 0, and it ran dry. Their game's
    // clock is nudged to keep it at NET.QUEUE_LO..QUEUE_HI: net-interp.js ClockNudge.)
    const depth = Number.isFinite(p.low) ? p.low : p.queue.length;
    p.low = Infinity;
    writeOwn(w, { ack: p.ackSeq & 0xffff, depth, flags, move: moveState(p.move), weapons: send ? ws : null, events });
    return w.done();
  }
  sendBundle() {
    if (!this.started) return;
    const g = this.game, state = this.sharedState();
    const shared = this.enc.encode(state, this.events, { now: g.now });
    this.events = [];
    const owns = new Map();
    for (const p of this.pawns) owns.set(p.slot, this.ownBytes(p));
    const frame = bundleFrame(this.tickNo, shared, owns, this.w);
    this.link.send(frame);
    this.count(frame.length);
  }
  // Everything for one client (its game's just joined, came back, or missed snapshots): the whole shared part, its own,
  // and who the bots are.
  keyframe(slot) {
    const p = this.pawnOf.get(slot);
    if (!p || !this.game.match) return;
    this.keyAt.set(slot, performance.now());
    p.restart(); // (their game may be a new one: see NetPawn.restart)
    const shared = this.enc.encode(this.sharedState(), [], { key: true, w: new Writer(4096) });
    const f = keyFrame(slot, this.tickNo, shared, this.ownBytes(p, { force: true }));
    this.link.send(f);
    this.link.send(jsonFrame(slot, this.roster()));
    this.count(f.length);
  }
  roster() {
    const bots = [];
    for (const x of this.slots.bySlot.values()) if (x.info?.kind !== 'human' && x.b) bots.push({ slot: x.slot, name: x.c.name, id: x.c.identity?.id || null });
    return { t: 'roster', bots };
  }
  count(n) {
    const s = this.stats, now = performance.now();
    s.up += n + 6; s.frames++;
    if (now - s.at >= 1000) {
      const k = 1000 / (now - s.at);
      s.upRate = s.up * k; s.cmdRate = s.cmdsIn * k; s.clampRate = s.clamped * k;
      s.dropped = this.pawns.reduce((n, p) => n + (p.dropped || 0), 0);
      s.up = 0; s.cmdsIn = 0; s.clamped = 0; s.at = now;
    }
  }
  netText() {
    const s = this.stats, depth = this.pawns.map((p) => p.queue.length).join('/');
    return `host · up ${(s.upRate / 1024).toFixed(1)} KB/s · cmds in ${Math.round(s.cmdRate || 0)}/s · queues ${depth || '-'} · rewinds past ${this.lag.max * 1000 * TICK | 0} ms ${(s.clampRate || 0).toFixed(1)}/s · cmds dropped ${s.dropped || 0}`;
  }

  // ---- bits ---------------------------------------------------------------------------------------------------------------
  skinSlot(skin) { return skinSlot(skin, this.slots.mine); }
  knifeWid(item) { return knifeWid(item); }
  buyId(n) { return BUY_IDS[n] || null; }
  get picUrl() { return this.info.picUrl || null; }

  dispose() {
    this.tags?.dispose();
    this.clock?.stop();
    if (this.game.clock === this.clock) this.game.clock = null;
    this.link = { send() {} };
  }
}
export { CLOSE };
