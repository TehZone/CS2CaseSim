// Online PvP: everyone's game but the host's. It sends the host its player's commands (one a tick, CS2's usercmds) and
// moves and shoots its player at once from them (prediction), with the same movement and weapons code the host runs them
// through (net-pawn.js); when the host's answer for a command differs from what was predicted, it takes the host's and
// runs the commands since again (reconciliation), the camera eased over to the difference. Everyone else is drawn from
// the host's snapshots, NET.INTERP behind (net-interp.js), as bodies (bots.js Bot) like the bots are in any match; what
// happened (shots, hits, kills, grenades, the bomb, the round) is played as it comes up in that time. The match's state
// (the round, the clock, the score, the bomb) is the host's, on this game's own Match object (its rules and checks
// for the HUD and the buy menu).
//
// Nothing here decides anything: damage, deaths, buying, picking up, planting and defusing are the host's (this game's
// copies of those do nothing, or only show).
import * as THREE from 'three';
import { NET, NONE, KILL } from '../engine/pvp.js';
import { textProblem } from '../engine/tools.js';
import { RADIO } from './radio.js';
import { CmdInput, moveCmd, spreadRand, MIRROR_BRAIN } from './net-pawn.js';
import { Interp, ClockNudge, Predictor } from './net-interp.js';
import { mapSlots, skinOf, MatchClock, TICK, playersOnBoard, serverChat, endScreen, atBomb } from './net-match.js';
import { SharedDecoder, Reader, readOwn, readClientFrame, cmdsFrame, netYaw, netPitch, unwrapSeq, B, SLOT_SHIFT, EV, SHOT_F, ROUND_KIND, BOMB_KIND, F, F2, OWN, buyIndex } from './net-codec.js';
import { basis } from './weapons.js';
import { botGun } from './ai.js';
import { ITEM_NAMES } from './match.js';
import { iconFor } from './icons.js';
import { gunSkin, LOCAL } from './drops.js';
import { botIdentities } from './identity.js';
import { toGl } from './world.js';
import { equipped } from '../loadout.js';
import { NameTags } from './nametags.js';

const DEATH_CAM = 2.5;
const SIDE = ['CT', 'T'];
// The radio menus' calls (radio.js RADIO: their voice lines and words): all a real player's call can be.
const RADIO_LINES = new Set(Object.values(RADIO).flatMap((m) => m.items.map((x) => x[1])));
const RADIO_TEXTS = new Set(Object.values(RADIO).flatMap((m) => m.items.map((x) => x[0])));

export class NetClient {
  constructor(game, link, info) {
    this.game = game; this.link = link; this.info = info; this.seed = info.seed >>> 0;
    this.role = 'client';
    this.hostSlot = info.host;
    this.dec = new SharedDecoder();
    this.interp = new Interp();
    this.nudge = new ClockNudge();
    this.ci = new CmdInput();
    this.seq = 0; this.unsent = []; this.buys = []; this.pingAt = null;
    this.pending = []; // events waiting for the render time to reach their tick
    this.drops = new Map();
    this.stats = { down: 0, up: 0, at: performance.now(), downRate: 0, upRate: 0, fixes: 0, fixRate: 0, frames: 0 };
    this.kills = 0; this.stt = new Map(); this.countFrom = null; this.winners = ''; this.ackSeq = 0;
    this.eyeOffset = [0, 0, 0];
    this.alive = false; this.keyed = false;
    this.members = new Map((info.members || []).map((x) => [x.slot, x.state]));
    this.rtt = {};
  }

  attach() {
    const g = this.game, me = g.me;
    this.slots = mapSlots(g, this.info);
    this.pred = new Predictor(g.player);
    this.ring = this.pred.ring;
    for (const b of g.bots) { b.brain = MIRROR_BRAIN; b.weapons = {}; b.slot = 'held'; }
    g.pvp = this;
    g.remote = true;
    g.arsenal.fixedTiming = true; // (as the host's copy of us times them: net-pawn.js)
    me.alive = false; me.health = 0;
    // What only the host decides: here it does nothing, or only shows.
    g.damage = () => {};
    g.kill = () => {};
    g.flash = () => {};
    g.pickups = () => {};
    g.pickUp = () => {};
    g.dropOnDeath = () => {};
    g.onLive = () => { g.liveAt = g.now; };
    g.onMatchOver = () => {};
    g.buy = (id) => { const n = buyIndex(id); if (n >= 0 && g.inBuyZone() && g.match?.canBuy(me, id, g.stats)) this.buys.push(n); };
    g.throwMyNade = (id) => { if (!(me.nades[id] > 0)) return false; me.nades[id]--; return me.nades[id]; };
    g.playerPlant = (holding, t) => this.plantView(holding, t);
    g.countStatTrak = () => {};
    g.tick = () => this.tick();
    serverChat(g, (m) => this.link.send(m));
    g.scoreData = () => playersOnBoard(g, this.slots, { picUrl: this.info.picUrl, ping: (s) => this.pingOf(s), bot: (s) => !!(this.dec.bodies[s]?.flags2 & F2.BOT) });
    g.netText = () => this.netText();
    this.clock = new MatchClock(g, { onRun: (n, frame) => this.afterRun(n, frame) });
    this.clock.pause(true); // (until the host's first keyframe)
    g.clock = this.clock;
    this.idents = botIdentities().catch(() => []);
    this.tags = new NameTags(g);
    // (No keyframe from the host yet, a while after the start: our ready again makes the server ask it for one.)
    this.keyTimer = setInterval(() => { if (this.keyed) clearInterval(this.keyTimer); else this.link.send({ t: 'ready' }); }, 3000);
  }
  pingOf(slot) {
    const host = this.hostSlot, r = this.rtt;
    if (slot === host) return ['dropped', 'bot', 'abandoned'].includes(this.members.get(host)) ? 'HOST · away' : 'HOST';
    return r[slot] != null ? `${r[slot] + (r[host] || 0)} ms` : '';
  }

  // ---- the socket ---------------------------------------------------------------------------------------------------------
  onBinary(u8) {
    this.stats.down += u8.length + 6;
    let f;
    try { f = readClientFrame(u8); } catch (e) { console.warn('pvp frame', e); return; }
    if (!f) return;
    if (f.kind === 'json') { this.onJson(f.msg); return; }
    this.onSnap(f.tick, f.shared, f.own, f.kind === 'key');
  }
  onText(msg) {
    const g = this.game;
    switch (msg.t) {
      case 'member': this.members.set(msg.slot, msg.state); return;
      case 'rtt': this.rtt = msg.ms || {}; return;
      case 'chat': { const c = this.slots.cOf(msg.slot); if (c) g.say(c, String(msg.text || ''), !!msg.team); return; }
      case 'pause': this.paused = true; this.clock.pause(true); return;
      case 'resume': this.paused = false; if (this.keyed) this.clock.pause(false); return;
      case 'end': if (msg.report) this.link.send(this.report()); return;
    }
  }
  async onJson(msg) {
    if (msg?.t !== 'roster') return;
    const ids = await this.idents, byId = new Map((ids || []).map((x) => [x.id, x]));
    for (const r of msg.bots || []) {
      const c = this.slots.cOf(r.slot);
      if (!c || c.bot === false) continue;
      if (r.name) c.name = String(r.name).slice(0, 40);
      c.identity = (r.id && byId.get(r.id)) || null;
    }
  }

  // ---- snapshots ----------------------------------------------------------------------------------------------------------
  onSnap(tick, sharedR, ownR, key) {
    const g = this.game, now = performance.now();
    let s;
    try { s = this.dec.decode(sharedR); } catch (e) { console.warn('pvp snapshot', e); return; }
    if (!s) return; // (a delta before our first keyframe)
    if (key && !this.keyed) { this.keyed = true; if (!this.paused) this.clock.pause(false); }
    if (key) { this.interp.clear(); this.pending.length = 0; }
    // Everyone's bodies as of this tick (the interpolation's), the match and the map's doors at once.
    const bodies = new Map();
    for (const b of this.dec.bodies) if (b) bodies.set(b.slot, { pos: b.pos.slice(), vel: b.vel.slice(), yaw: b.yaw, pitch: b.pitch, flags: b.flags, flags2: b.flags2, held: b.held, skin: b.skin, hp: b.hp, armor: b.armor, clip: b.clip, reserve: b.reserve, team: b.team });
    this.interp.push(tick, bodies, now);
    this.applyMatch(s);
    for (const d of s.doors) this.applyDoor(d);
    for (const p of s.panes) { const pane = g.doors?.panes[p.idx]; if (pane && p.broken && !pane.broken) g.doors.breakPane(pane); else if (pane && !p.broken && pane.broken) g.doors.reset(); }
    const mine = this.slots.mine;
    for (const e of s.events) {
      // (What's yours plays at once: your death, the hits you take and make, your kills' feedback and your own grenade. The
      // rest as the time they're drawn at reaches them: a body falls where it's drawn, so your kill's body waits for that.)
      if (e.type === EV.KILL && e.victim === mine) this.play(e);
      else if (e.type === EV.HURT && (e.victim === mine || e.attacker === mine)) this.play(e);
      else if (e.type === EV.NADE && e.slot === mine) this.play(e, { ahead: this.seq - this.ackSeq });
      else {
        if (e.type === EV.KILL && e.attacker === mine) { this.killFeedback(e); e.fed = true; }
        this.pending.push({ tick, e });
      }
    }
    if (ownR) { try { this.applyOwn(readOwn(ownR), key); } catch (e) { console.warn('pvp own', e); } }
  }
  applyMatch(s) {
    const g = this.game, m = g.match, S = this.slots, x = s.match;
    if (!m) return;
    m.phase = x.phase; m.round = x.round;
    m.score.A = x.score[S.mySquad]; m.score.B = x.score[S.other];
    if (s.matchMask & 2) m.time = x.time;
    m.timeout = x.timeout > 0 ? { left: x.timeout, pending: false } : null;
    const b = (m.bomb ||= { state: 'carried', carrier: null, pos: null, site: null, plantedAt: 0, defuser: null, defuseEnd: 0, beepAt: 0 });
    const wasPlanted = b.state === 'planted';
    b.state = x.bomb.state; b.carrier = S.cOf(x.bomb.carrier); b.pos = x.bomb.state === 'carried' && !b.carrier ? null : x.bomb.pos.slice(); b.site = x.bomb.site || null;
    if (b.state === 'planted' && (!wasPlanted || Math.abs(g.now - (m.rules.bombTime - x.bomb.plantedLeft) - b.plantedAt) > 0.25)) b.plantedAt = g.now - (m.rules.bombTime - x.bomb.plantedLeft);
    b.defuser = S.cOf(x.bomb.defuser); b.defuseEnd = g.now + x.bomb.defuseLeft;
    // The sides (they swap at halftime): everyone's team by their squad.
    const sides = this.info.sides || { A: 'CT', B: 'T' }, flip = (t) => (t === 'CT' ? 'T' : 'CT');
    const side = (sq) => (x.swapped ? flip(sides[sq]) : sides[sq]);
    const mine = side(S.mySquad);
    for (const v of S.bySlot.values()) v.c.team = side(v.slot < S.M.size ? 'A' : 'B');
    if (mine !== g.team) { g.team = mine; g.enemyTeam = flip(mine); g.onHalftime(); }
    for (const r of s.rows) { const c = S.cOf(r.slot); if (c) Object.assign(c, { kills: r.k, assists: r.a, deaths: r.d, mvps: r.m, score: r.score, damage: r.dmg, money: r.money }); }
  }
  applyDoor(d) {
    const door = this.game.doors?.list[d.idx];
    if (!door) return;
    if (door.target !== d.target) { door.target = d.target; door.closeAt = Infinity; }
    if (Math.abs(door.angle - d.angle) > 25) { door.angle = d.angle; this.game.doors.place(door); }
  }

  // Our own part: the host's word on our player as of the last command it ran (ack).
  applyOwn(o, key) {
    const g = this.game, me = g.me, p = g.player, S = this.slots;
    this.nudge.sample(o.depth, g.now);
    this.clock.rate = this.nudge.rate;
    const ack = unwrapSeq(o.ack, this.seq);
    this.ackSeq = ack;
    const alive = !!(o.flags & OWN.ALIVE);
    for (const e of o.events) this.playOwn(e, o);
    if (o.flags & OWN.TELEPORT || key || !this.alive !== !alive) {
      // A respawn (or our first word from the host, or coming back to life): its state, the commands since run again.
      this.pred.reset(o.move, ack, this.seq);
      g.prevEye = p.eye();
      this.eyeOffset = [0, 0, 0];
      if (alive && !me.alive) this.respawned();
    } else if (alive) this.reconcile(ack, o.move);
    if (!alive && me.alive) { me.alive = false; me.health = 0; }
    this.alive = alive;
    g.defusing = !!(o.flags & OWN.DEFUSING);
    this.hostPlanting = !!(o.flags & OWN.PLANTING);
    if (o.weapons) this.applyWeapons(o.weapons, this.ring.get(ack), key || !!(o.flags & OWN.TELEPORT));
    const body = this.dec.bodies[S.mine];
    if (body) { me.health = alive ? body.hp : 0; me.armor = body.armor; }
  }
  // Where the host had us after command `ack`, against where we'd predicted: corrected (and the commands since run again)
  // when it's out by more than a hair, the camera eased over to it (SMOOTH_MS).
  reconcile(ack, host) {
    const d = this.pred.reconcile(ack, host, this.seq);
    if (!d) return;
    for (let k = 0; k < 3; k++) this.eyeOffset[k] += d[k];
    if (Math.hypot(...this.eyeOffset) > 64) this.eyeOffset = [0, 0, 0];
    this.stats.fixes++;
  }
  respawned() {
    const g = this.game, me = g.me;
    me.alive = true; me.health = 100;
    g.deathCam = null; g.spectating = null;
    g.myBody.root.visible = false;
    g.arsenal.aim = [0, 0]; g.arsenal.aimVel = [0, 0]; g.arsenal.view = [0, 0]; g.arsenal.throws = []; g.arsenal.scheduled = [];
    g.planting = null;
  }
  playOwn(e) {
    const g = this.game;
    if (e.type === EV.TELEPORT) { g.input.yaw = e.yaw; g.input.pitch = e.pitch; this.ring.clear(); }
    else if (e.type === EV.FLASHED) {
      const secs = e.secs;
      if (secs > (g.flashUntil || 0) - g.now) { g.flashUntil = g.now + secs; g.flashSecs = secs; g.flashCapture = true; }
      g.sounds?.play(secs > 3 ? 'Flashbang.Ring.Long' : secs > 1.5 ? 'Flashbang.Ring.Medium' : 'Flashbang.Ring.Short', { volume: 0.5 });
    } else if (e.type === EV.BUY && e.ok) { g.sounds?.play('Player.PickupWeapon', { volume: 0.6 }); if (g.buyMenu.isOpen) g.buyMenu.render(); }
  }
  // The host's word on our weapons, as of command `ack` (at: what we had then, by our own prediction). What it says
  // differently from what we had then is put right now (a gun bought or picked up, one dropped, ammo); what we've done
  // since, it hasn't seen yet, and stays. With nothing to go by (a respawn, a keyframe), it's taken as it is.
  applyWeapons(w, at, hard) {
    const g = this.game, a = g.arsenal, me = g.me;
    me.money = w.money; me.armor = w.armor; me.helmet = w.helmet; me.defuser = w.kit; me.hasC4 = w.c4;
    const was = !hard && at?.weapons ? at.weapons : null;
    for (const id of Object.keys({ ...w.nades, ...me.nades })) {
      const n = was ? (me.nades[id] || 0) + ((w.nades[id] || 0) - (was.nades[id] || 0)) : w.nades[id] || 0;
      if (n > 0) me.nades[id] = n; else delete me.nades[id];
    }
    const host = new Map(w.guns.map((x) => [x.slot, x]));
    for (const h of w.guns) {
      const cur = a.guns[h.slot], then = was?.guns[h.slot];
      if (!then || then.wid !== h.wid || hard) {
        if (!cur || cur.id !== h.wid) this.loadGun(h, w.active === h.slot);
        else if (hard) { cur.clip = h.clip; cur.reserve = h.reserve; }
      } else if (cur && cur.id === h.wid) {
        cur.clip = Math.max(0, cur.clip + (h.clip - then.clip));
        cur.reserve = Math.max(0, cur.reserve + (h.reserve - then.reserve));
      }
    }
    for (const [slot, gun] of Object.entries(a.guns)) {
      if (host.has(slot)) continue;
      if (!hard && was && !was.guns[slot]) continue; // (ours since: the host hasn't heard yet)
      if (slot.startsWith('g_') && me.nades[gun.id] > 0) continue;
      a.remove(slot, g.now);
    }
    if (w.active && a.guns[w.active] && (hard || (was && was.active !== w.active)) && a.current?.slot !== w.active) a.select(w.active, g.now);
  }
  loadGun(h, select) {
    const g = this.game, key = h.slot + '|' + h.wid;
    if ((this.loading ||= new Set()).has(key)) return;
    this.loading.add(key);
    const mine = h.skin === this.slots.mine || h.skin === 255;
    const skin = h.skin === 255 ? null : mine ? gunSkin(g.ownSkin(h.wid)) : skinOf(h.skin, h.wid, this.info.slots, this.slots.mine, () => null);
    const wid = h.slot === 'knife' ? g.knifeId(g.me.team) : h.wid;
    g.myGun(h.slot, wid, h.skin === 255 && h.slot !== 'knife' ? null : skin ?? undefined).then((gun) => {
      if (g.disposed) return;
      gun.clip = h.clip; gun.reserve = h.reserve; gun.silenced = h.silenced ?? gun.silenced;
      g.arsenal.give(h.slot, gun, g.now, select || !g.arsenal.current);
    }).catch((e) => console.warn('pvp gun', h.wid, e)).finally(() => this.loading.delete(key));
  }
  // What we hold and carry after a tick, for applyWeapons to compare with the host's.
  weaponsNow() {
    const a = this.game.arsenal, guns = {};
    for (const [slot, gun] of Object.entries(a.guns)) guns[slot] = { wid: gun.id, clip: gun.clip ?? 0, reserve: gun.reserve ?? 0 };
    return { active: a.current?.slot || null, guns, nades: { ...this.game.me.nades } };
  }

  // ---- a tick: our command, and our player moved by it at once --------------------------------------------------------------
  tick() {
    const g = this.game, inp = g.input, me = g.me, m = g.match, p = g.player;
    g.now += TICK;
    g.prevEye = p.eye();
    for (const n of g.nades.flying) n.prev = n.pos.slice();
    // The match's clock runs on here between snapshots.
    if (m) {
      if (m.timeout && m.phase === 'freeze') m.timeout.left = Math.max(0, m.timeout.left - TICK);
      else if (m.phase === 'freeze' || m.phase === 'live' || m.phase === 'end') m.time = Math.max(0, m.time - TICK);
    }
    const cmd = this.sample();
    const alive = me.alive && this.alive;
    let move = null;
    if (alive) {
      const frozen = m.phase === 'freeze' || !!g.planting || g.defusing || m.phase === 'over';
      move = moveCmd(cmd, frozen, g.arsenal.maxSpeed());
      const wasGround = p.onGround;
      p.tick(TICK, move);
      g.footsteps(wasGround);
      p.landed = 0;
      // The weapons, by the command's own aim (the host's is exactly it) and spread.
      const iy = inp.yaw, ip = inp.pitch;
      inp.yaw = cmd.yaw; inp.pitch = cmd.pitch;
      g.arsenal.rand = spreadRand(this.seed, this.slots.mine, cmd.seq);
      try { g.arsenal.tick(TICK, g.now, this.ci.load(cmd)); } finally { inp.yaw = iy + (inp.yaw - cmd.yaw); inp.pitch = ip + (inp.pitch - cmd.pitch); }
      // (Defusing, as the host will see it: holding E at the bomb, looking at it.)
      if (cmd.buttons & B.USE && m.phase === 'planted' && me.team === 'CT' && atBomb(p.eye(), basis(cmd.pitch, cmd.yaw).fwd, m.bomb?.pos)) g.defusing = true;
    } else if (this.clicked & 1 || !g.spectating?.c.alive) g.nextSpectate(); // (Mouse1: the next teammate, first person: game.js spectateInput)
    this.pred.record(this.seq, cmd, move, { weapons: this.weaponsNow() });
    inp.endTick();
    // What moves here by itself: grenades in flight, guns falling, doors, the ball, the bomb's beeps, everyone's steps.
    g.nades.tick(TICK); g.drops.tick(TICK); g.balls.tick(TICK); g.doors.tick(TICK, g.now);
    for (const b of g.bots) if (b.c.alive) g.botFootsteps(b);
    if (m && (m.phase === 'planted' || (m.phase === 'end' && m.bomb?.state === 'planted')) && m.bomb?.pos && g.now >= (m.bomb.beepAt || 0)) {
      const left = m.rules.bombTime - (g.now - m.bomb.plantedAt);
      g.sounds.play('C4.PlantSound', { pos: m.bomb.pos, listener: g, volume: 0.7 });
      g.ledAt = g.now; g.radar?.beep();
      m.bomb.beepAt = g.now + Math.max(0.1, 0.15 + 0.85 * Math.pow(Math.max(0, left) / m.rules.bombTime, 1.4));
    }
    if ((g.tickCount = (g.tickCount || 0) + 1) % 8 === 0) {
      g.sunTarget = g.collision.raycast(g.camEye || p.eye(), g.world.sunDir, 16000, 1) ? 0 : 1;
      if (alive) g.spotFromMe();
    }
    g.sunVis += ((g.sunTarget ?? 1) - g.sunVis) * 0.2;
    const ear = basis(inp.pitch, inp.yaw);
    g.sounds.setListener(g.camEye || p.eye(), ear.fwd, ear.up);
    g.soundscapes.update(TICK);
  }
  // This tick's command from the keys and the mouse (CS2's usercmd).
  sample() {
    const g = this.game, inp = g.input, held = (a) => inp.held(a);
    const pressed = inp.takePressed(), clicked = inp.takeClicked(), wheel = inp.takeWheel(), ping = inp.takePing();
    this.clicked = clicked;
    let slot = 0;
    for (let n = 1; n <= 5; n++) if (pressed.has('slot' + n)) slot = n;
    const frozen = g.buyMenu.isOpen || g.chatOpen || g.console?.isOpen;
    const buttons = (inp.buttons & 1 ? B.ATTACK : 0) | (inp.buttons & 4 ? B.ATTACK2 : 0) | (held('jump') ? B.JUMP : 0) | (held('duck') ? B.DUCK : 0)
      | (held('walk') ? B.WALK : 0) | (held('use') ? B.USE : 0) | (pressed.has('reload') ? B.RELOAD : 0) | (pressed.has('inspect') ? B.INSPECT : 0)
      | (pressed.has('drop') ? B.DROP : 0) | (inp.notched('jump') ? B.JUMPPRESS : 0) | (pressed.has('lastWeapon') ? B.LASTINV : 0)
      | (wheel > 0 ? B.INVNEXT : 0) | (wheel < 0 ? B.INVPREV : 0) | (ping ? B.PING : 0) | (frozen ? B.FROZEN : 0) | (pressed.has('use') ? B.USEPRESS : 0)
      | (slot << SLOT_SHIFT) | (clicked & 1 ? B.CLICK1 : 0) | (clicked & 4 ? B.CLICK2 : 0);
    const fwd = (held('forward') ? 1 : 0) - (held('back') ? 1 : 0), side = (held('right') ? 1 : 0) - (held('left') ? 1 : 0);
    const seq = ++this.seq;
    const view = Math.max(0, Math.round(this.interp.renderTick(performance.now()) * 256)) >>> 0;
    const cmd = { seq: seq & 0xffff, view, buttons, fwd, side, yaw: netYaw(inp.yaw), pitch: netPitch(inp.pitch), buys: this.buys.length ? this.buys.splice(0, 4) : null, ping: null };
    if (ping && g.me.alive) {
      const eye = g.player.eye(), dir = basis(inp.pitch, inp.yaw).fwd, hit = g.collision.raycast(eye, dir, 6000, 1);
      cmd.ping = [0, 1, 2].map((k) => eye[k] + dir[k] * (hit ? hit.t - 4 : 2000));
    }
    this.unsent.push(cmd);
    return cmd;
  }
  afterRun(n, frame) {
    // Our commands since the last send (at most four a message).
    while (this.unsent.length) {
      const part = this.unsent.splice(0, 4), f = cmdsFrame(part);
      this.link.send(f);
      this.stats.up += f.length + 6;
    }
    if (frame) this.render();
  }

  // ---- the frame: everyone else where they were interp ms ago, and what happened by then ---------------------------------
  render() {
    const g = this.game, now = performance.now(), it = this.interp;
    it.adapt(); it.frames++;
    const t = it.renderTick(now);
    this.renderAt = t;
    if (it.late(t)) it.underflows++; // (a late frame: once a frame, however many bodies)
    for (let i = 0; i < this.pending.length; i++) {
      const x = this.pending[i];
      if (x.tick > t) break;
      this.play(x.e);
      this.pending.splice(i--, 1);
    }
    if (this.pending.length > 600) this.pending.splice(0, this.pending.length - 600);
    const sample = (this.sampleOut ||= {});
    for (const v of this.slots.bySlot.values()) {
      if (!v.b) continue;
      const s = it.sample(v.slot, t, sample);
      if (s) this.pose(v, s);
    }
    // The camera's correction eased away.
    const o = this.eyeOffset, k = Math.exp(-(g.frameMs || 16) / NET.SMOOTH_MS);
    o[0] *= k; o[1] *= k; o[2] *= k;
    g.eyeOffset = Math.abs(o[0]) + Math.abs(o[1]) + Math.abs(o[2]) > 0.01 ? o : null;
    this.statsTick();
  }
  // A body as the snapshots have it now.
  pose(v, s) {
    const g = this.game, b = v.b, c = v.c, alive = !!(s.flags & F.ALIVE);
    if (alive && (b.mode === 'dead' || !b.root.visible || !b.netSpawned)) { b.netSpawned = true; c.alive = true; b.holding = null; b.netSkin = null; b.spawn(s.pos, s.yaw); }
    else if (!alive && c.alive) { c.alive = false; if (b.mode !== 'dead') { b.setMode('dead'); b.deadAt = g.now; } }
    c.alive = alive;
    c.health = s.hp; c.armor = s.armor; c.helmet = !!(s.flags2 & F2.HELMET); c.defuser = !!(s.flags2 & F2.KIT); c.hasC4 = !!(s.flags2 & F2.C4);
    if (!alive) return;
    b.pos = s.pos; b.prev = s.pos; b.hasPrev = false;
    b.vel = s.vel; b.yaw = s.yaw; b.pitch = s.pitch; b.prevAim[0] = s.pitch; b.prevAim[1] = s.yaw;
    b.ducked = !!(s.flags & F.DUCKED);
    b.airborne = !(s.flags & F.GROUND) && !(s.flags & F.LADDER);
    b.climbing = s.flags & F.LADDER ? (b.climbing || { ladder: true }) : null;
    const mode = s.flags & F.PLANTING ? 'plant' : s.flags & F.DEFUSING ? 'defuse' : 'move';
    if (b.mode !== mode) b.setMode(mode);
    if (s.held && (s.held !== b.holding || (b.netSkin ?? 255) !== s.skin)) {
      b.netSkin = s.skin;
      const skin = skinOf(s.skin, s.held, this.info.slots, this.slots.mine, (wid) => gunSkin(g.ownSkin(wid)));
      b.equip(s.held, { skin });
    }
    const w = (b.weapons.held ||= {});
    w.id = s.held; w.clip = s.clip; w.reserve = s.reserve ?? 0; w.stats = g.stats?.[s.held]; w.melee = /knife|bayonet/.test(s.held || '');
  }

  // ---- what happened ------------------------------------------------------------------------------------------------------
  // o.ahead: ticks to carry it on (your own grenade: your game is that far ahead of the host's, by the commands it hasn't run
  // yet, so it flies from where it would be by now).
  play(e, o = {}) {
    const g = this.game, S = this.slots, me = g.me;
    const bodyOf = (slot) => S.at(slot)?.b || null, cOf = (slot) => (slot === NONE ? null : S.cOf(slot));
    switch (e.type) {
      case EV.SHOT: {
        if (e.slot === S.mine) return; // (ours: shown as we fired)
        const b = bodyOf(e.slot);
        if (!b) return;
        const gun = botGun(e.wid, g.stats?.[e.wid] || {});
        gun.silenced = !!(e.flags & SHOT_F.SILENCED);
        const muzzle = b.muzzle();
        g.fireBullet(b.c, e.origin, e.dir, gun, { tracer: !!(e.flags & SHOT_F.TRACER), muzzle });
        if (e.flags & SHOT_F.SOUND) {
          const st = gun.stats;
          const ev = gun.taser ? 'Weapon_Taser.Single' : gun.silenced ? (e.wid === 'weapon_usp_silencer' ? 'Weapon_USP.SilencedShot' : 'Weapon_M4A1.Silenced') : st.shootSound;
          if (ev) g.sounds.play(ev, { pos: e.origin, listener: g, volume: 1, source: b });
          g.specAnim(b, 'shoot');
          g.effects.worldFlash(muzzle);
        }
        return;
      }
      case EV.HURT: {
        const victim = cOf(e.victim), attacker = cOf(e.attacker), head = e.group === 'head';
        if (e.point) { g.effects.blood(e.point, e.dir || [0, 0, 1]); g.sounds.play('Flesh.BulletImpact', { pos: e.point, listener: g, volume: 0.5 }); }
        if (victim === me) {
          let ang = null;
          if (attacker) { const ap = g.positionOf(attacker), mp = g.player.origin, a = (Math.atan2(ap[1] - mp[1], ap[0] - mp[0]) * 180) / Math.PI; ang = -(((a - g.input.yaw + 540) % 360) - 180); }
          g.hud.hurt(ang, e.dmg);
          const armored = head ? me.helmet && me.armor > 0 : e.group !== 'leg' && me.armor > 0;
          if (me.health > 0) g.sounds.play(head ? (armored ? 'Player.DamageHeadShotArmor.Victim' : 'Player.DamageHeadShot.Victim') : armored ? 'Player.DamageBodyArmor.Victim' : 'Player.DamageBody.Victim', { volume: 0.7 });
        } else if (victim) {
          bodyOf(e.victim)?.flinch(e.group);
          if (attacker === me) g.sounds.play(head ? 'Player.DamageHeadShot.AttackerFeedback' : 'Player.DamageBody.AttackerFeedback', { volume: 0.7 });
        }
        return;
      }
      case EV.KILL: return this.killed(e);
      case EV.NADE: {
        const c = cOf(e.slot), n = c ? g.nades.throw(c, e.wid, e.origin, e.vel) : null, k = Math.max(0, Math.min(32, o.ahead | 0));
        if (n && k) { n.born -= k * TICK; for (let i = 0; i < k; i++) g.nades.move(n, TICK); n.prev = n.pos.slice(); }
        return;
      }
      case EV.BOMB: {
        const c = cOf(e.slot), m = g.match;
        if (e.kind === BOMB_KIND.PLANTED && c && m?.bomb) { m.bomb.pos = e.pos; m.bomb.state = 'planted'; g.onPlanted(c, m.bomb); }
        else if (e.kind === BOMB_KIND.DEFUSED && c) g.onDefused(c);
        else if (e.kind === BOMB_KIND.EXPLODED) { g.onExploded({ pos: e.pos }); }
        else if (e.kind === BOMB_KIND.DROPPED) g.onBombDropped({ pos: e.pos });
        else if (e.kind === BOMB_KIND.PICKED) { g.removeBomb(); if (c === me) { g.sounds.play('Player.PickupC4', { volume: 0.7 }); g.hud.message('You picked up the bomb', 2000); } }
        else if (e.kind === BOMB_KIND.DEFUSING) g.onDefuseStart(c);
        return;
      }
      case EV.ROUND: return this.round(e);
      case EV.DROP: {
        if (e.op === 0) {
          const skin = skinOf(e.skin, e.wid, this.info.slots, S.mine, (wid) => gunSkin(g.ownSkin(wid)));
          const it = g.drops.drop({ id: e.wid, clip: 0, reserve: 0, skin }, e.pos, e.vel, null);
          this.drops.set(e.id, it);
        } else { const it = this.drops.get(e.id); if (it) { g.drops.take(it); this.drops.delete(e.id); } }
        return;
      }
      case EV.GEST: {
        const b = bodyOf(e.slot);
        if (!b || !b.c.alive) return;
        const clips = g.botAssets.clips;
        if (e.kind === 'reload') { if (b.holding) b.reloadGesture(b.holding, e.secs || 2); g.specAnim(b, 'reload', e.secs || 2); }
        else if (e.kind === 'flashed') b.flashed(e.secs || 1);
        else if (e.kind === 'throw' || e.kind === 'lob') { b.gesture(clips[e.kind]); g.specAnim(b, e.kind === 'throw' ? 'throw' : 'throwUnder'); }
        else if (clips[e.kind]) b.gesture(clips[e.kind], /^flinch/.test(e.kind) ? { weight: 0.6, duration: 0.35 } : {});
        return;
      }
      case EV.RADIO: {
        // (The host's word, so checked here: a real player's call can only be the host's own, from the radio menus (their
        // lines, their words); a bot's chatter gets the chat's filter. Anything else isn't shown.)
        const c = cOf(e.slot), human = S.at(e.slot)?.info?.kind === 'human';
        if (!c || c === me) return;
        if (human && (e.slot !== this.hostSlot || !RADIO_LINES.has(e.line) || (e.text && !RADIO_TEXTS.has(e.text)))) return;
        const text = e.text && !human && textProblem(e.text, 'A call', 120) ? null : e.text || null;
        g.radio?.say(c, e.line || null, text, { force: true });
        return;
      }
      case EV.PING: { const c = cOf(e.slot); if (c && c.team === me.team) this.showPing(e.pos, c); return; }
    }
  }
  // A kill's feedback: the kill feed, and when it's yours its sound and your count for the report (not one made after the
  // round was decided, LATE: the server's log has none of those either). Yours play as they come (onSnap: e.fed).
  killFeedback(e) {
    const g = this.game, S = this.slots, me = g.me;
    const c = S.cOf(e.victim), attacker = e.attacker === NONE ? null : S.cOf(e.attacker);
    if (!c) return;
    const headshot = !!(e.flags & 1);
    if (attacker === me && c !== me && c.team !== me.team) {
      if (!(e.flags & KILL.LATE) && this.countFrom != null) this.kills++;
      g.sounds.play(headshot ? 'Player.DeathHeadShot.AttackerFeedback' : 'Player.DeathBody.AttackerFeedback', { volume: 0.8 });
      // (StatTrak™: a kill with your own gun counts, as the host has it; the server adds them at the end.)
      const gun = Object.values(g.arsenal.guns).find((x) => x.id === e.wid && x.skin?.owner === LOCAL && x.skin.item?.stt);
      if (gun) this.stt.set(gun.skin.item.uid, (this.stt.get(gun.skin.item.uid) || 0) + 1);
    }
    const wname = e.wid ? ITEM_NAMES[e.wid] || e.wid.replace(/^weapon_/, '') : 'World';
    const by = attacker && attacker !== c;
    g.hud.kill({ killer: attacker?.name || '', victim: c.name, weapon: wname, icon: iconFor(g.icons, e.wid, { kill: true }), mine: attacker === me || c === me,
      killerTeam: attacker?.team, victimTeam: c.team, headshot, wallbang: !!(e.flags & 2), noscope: !!(e.flags & 4), smoke: !!(e.flags & 8), air: by && !!e.how, blind: by && !!(e.flags & 16) });
  }
  killed(e) {
    const g = this.game, S = this.slots, me = g.me;
    const c = S.cOf(e.victim), attacker = e.attacker === NONE ? null : S.cOf(e.attacker), b = S.at(e.victim)?.b;
    if (!c) return;
    const headshot = !!(e.flags & 1);
    if (c.alive || c === me) {
      c.alive = false; c.health = 0;
      if (c === me) {
        g.planting = null; g.defusing = false;
        g.closeBuyMenu();
        g.sounds.play(headshot ? 'Player.DeathHeadShot.Victim' : 'Player.DeathBody.Victim', { volume: 0.8 });
        g.myBody.spawn(g.player.origin, g.input.yaw);
        g.myBody.setMode('dead', { headshot });
        g.myBody.deadAt = g.now;
        g.deathCam = { until: g.now + DEATH_CAM, killer: attacker, from: g.player.eye().slice() };
        this.alive = false;
      } else if (b) { b.setMode('dead', { headshot }); b.deadAt = g.now; b.vel = [0, 0, 0]; }
    }
    if (!e.fed) this.killFeedback(e);
  }
  round(e) {
    const g = this.game, S = this.slots;
    if (e.kind === ROUND_KIND.START) {
      this.countFrom ??= e.round; // (the first round this game saw start: its report counts from there)
      g.balls?.reset(); g.doors?.reset(); g.nav?.blocked?.clear();
      g.effects.clear(); g.nades.clear(); g.drops.clear(); this.drops.clear();
      for (const p of g.pings) { p.sprite.removeFromParent(); p.sprite.material.dispose(); }
      g.pings = [];
      g.flashUntil = 0; g.removeBomb(); g.planting = null; g.defusing = false;
      g.deathCam = null; g.spectating = null;
      g.radio?.close();
      g.liveAt = Infinity;
      for (const c of g.combatants) c.roundKills = 0;
      g.hud.winPanel(null);
      g.hud.message(e.flags & 1 ? 'Switching sides' : e.round === 1 ? 'Match start · Round 1' : `Round ${e.round}`, 2500);
      g.sounds.stop('voice', 0.2);
      g.sounds.channel('music', 'Music.StartRound.valve_cs2_01', { volume: 0.35 * g.musicVolume }, 0.8);
      g.emit('round', e.round);
    } else if (e.kind === ROUND_KIND.LIVE) {
      g.onLive(); // (the buy time and the round's own clock go from here)
    } else if (e.kind === ROUND_KIND.END) {
      const mvp = e.mvp === NONE ? null : S.cOf(e.mvp);
      if (mvp) mvp.roundKills = e.mvpKills;
      // (Who won it as this game saw it, by the server's squads: the report's `w`.)
      if (e.winner && e.round >= 1) this.winners = this.winners.padEnd(e.round - 1, '.').slice(0, e.round - 1) + (g.me.team === e.winner ? S.mySquad : S.other);
      g.onRoundEnd(e.winner, e.reason, mvp);
    } else if (e.kind === ROUND_KIND.OVER) {
      const won = (e.flags === 1 && S.mySquad === 'A') || (e.flags === 2 && S.mySquad === 'B'), draw = e.flags === 0;
      endScreen(g, { won, draw, score: { you: g.match.score.A, them: g.match.score.B } });
    }
  }
  // A teammate's ping (middle mouse): the marker where they aimed, for a few seconds (game.js ping).
  showPing(pos, c) {
    const g = this.game;
    if (!g.pingTex) {
      const cv = document.createElement('canvas'); cv.width = cv.height = 64;
      const x = cv.getContext('2d');
      x.beginPath(); x.moveTo(32, 4); x.lineTo(60, 32); x.lineTo(32, 60); x.lineTo(4, 32); x.closePath();
      x.fillStyle = '#ffd23c'; x.fill(); x.lineWidth = 5; x.strokeStyle = 'rgba(0,0,0,.75)'; x.stroke();
      g.pingTex = new THREE.CanvasTexture(cv); g.pingTex.colorSpace = THREE.SRGBColorSpace;
    }
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: g.pingTex, depthTest: false, depthWrite: false, sizeAttenuation: false, transparent: true }));
    sprite.scale.setScalar(0.035); sprite.renderOrder = 999;
    toGl([pos[0], pos[1], pos[2] + 6], sprite.position);
    g.scene.add(sprite);
    g.pings.push({ pos, until: g.now + 4, sprite });
    if (g.pings.length > 3) { const old = g.pings.shift(); old.sprite.removeFromParent(); old.sprite.material.dispose(); }
    g.sounds.play('UI.PlayerPing', { volume: 0.5 });
    const place = g.placeAt(pos);
    g.hud.chat(c.name, g.placeOf(c), place ? `Pinged ${place.replace(/([a-z])([A-Z])/g, '$1 $2')}` : 'Pinged a spot', c.team);
  }
  // The bomb in your hands (Mouse1 in a site): the plant animation as it goes; the host plants it.
  plantView(holding, t) {
    const g = this.game, m = g.match, feet = g.player.origin;
    const ok = holding && m.canPlant(g.me, feet) && g.player.onGround;
    const c4 = g.arsenal.guns.c4;
    if (!ok) {
      if (g.planting) { g.planting = null; if (c4) { c4.animEnd = 0; c4.vm.play('idle', { loop: true }); g.c4Screen(c4.vm.rig, 0); } }
      if (holding && m.phase === 'live' && !m.siteAt(feet) && t - (g.siteWarnAt || -9) > 2) { g.siteWarnAt = t; g.hud.message('You must be at a bomb site to plant the bomb', 2000); }
      return;
    }
    if (!g.planting) {
      g.planting = { start: t };
      if (c4) { c4.animEnd = Infinity; c4.vm.play(c4.vm.has('plant') ? 'plant' : 'idle', { speed: (c4.vm.length('plant') || m.rules.plantTime) / m.rules.plantTime }); g.c4Screen(c4.vm.rig, 1); }
      g.sounds.play('c4.initiate', { volume: 0.7 });
      g.beepKeys = 0;
    }
    const k = (t - g.planting.start) / m.rules.plantTime;
    if (k * 7 > g.beepKeys + 1 && g.beepKeys < 7) { g.beepKeys++; g.sounds.play('c4.keypressquiet', { volume: 0.6 }); g.c4Screen(c4?.vm.rig, 1 + g.beepKeys); }
  }

  // ---- the end ------------------------------------------------------------------------------------------------------------
  report() {
    const g = this.game, me = g.me, S = this.slots;
    const score = { [S.mySquad]: g.match.score.A, [S.other]: g.match.score.B };
    return { t: 'report', score, board: [...this.dec.board.values()].map((x) => ({ s: x.slot, k: x.k, a: x.a, d: x.d, m: x.m, dmg: x.dmg })), from: this.countFrom ?? 99, w: this.winners,
      me: { k: this.kills, a: Math.max(0, me.assists), d: me.deaths, m: me.mvps || 0, stt: [...this.stt].map(([uid, k]) => ({ uid, k })) } };
  }

  // ---- net_graph ----------------------------------------------------------------------------------------------------------
  statsTick() {
    const s = this.stats, now = performance.now();
    if (now - s.at < 1000) return;
    const k = 1000 / (now - s.at);
    s.downRate = s.down * k; s.upRate = s.up * k; s.fixRate = s.fixes * k; s.under = this.interp.underflows; s.frames = this.interp.frames;
    s.down = 0; s.up = 0; s.fixes = 0; s.at = now;
    this.interp.underflows = 0; this.interp.frames = 0;
    this.lastStats = { down: s.downRate, up: s.upRate, fixes: s.fixRate, interp: this.interp.delay, depth: this.nudge.avg ?? 0, rate: this.clock.rate, underflows: s.under };
  }
  netText() {
    const x = this.lastStats;
    if (!x) return 'online · waiting for the host';
    const host = this.hostSlot, r = this.rtt[this.slots.mine], h = this.rtt[host];
    return `in ${(x.down / 1024).toFixed(1)} KB/s · out ${(x.up / 1024).toFixed(1)} KB/s · ping ${r != null && h != null ? r + h : '?'} ms · interp ${Math.round(x.interp)} ms · host queue ${x.depth.toFixed(1)} · fixes ${x.fixes.toFixed(1)}/s · late ${x.underflows}`;
  }

  dispose() {
    this.tags?.dispose();
    clearInterval(this.keyTimer);
    this.clock?.stop();
    if (this.game.clock === this.clock) this.game.clock = null;
    this.link = { send() {} };
  }
}
void equipped; void SIDE; void Reader;
