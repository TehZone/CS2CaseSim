// Online PvP: a remote player in the host's match (net-host.js). Their body is a Bot (bots.js) like any other in game.bots,
// so everything the game does to a combatant (damage, deaths, the round, spectating, the scoreboard) works as it does for a
// bot; what a bot's Brain does with it (ai.js), this does from the player's commands instead: it moves them with the same
// PlayerMovement and the same weapons code (weapons.js Arsenal, seeded, with the weapon data's timings) their own game
// predicts with (net-client.js), so both come out the same, and the host's is the one that counts.
//
// Their guns here are real Guns with a viewmodel that animates nothing (stubVm): only its clips' lengths, the timings, count.
// b.weapons is the Arsenal's own slots, so a death drops their gun and walking over one picks it up as the game does for
// anyone. When they drop out, a bot takes over (takeover: a Brain, their guns as bot guns); they get it back at the next
// freeze time (respawn).
import { PlayerMovement } from './movement.js';
import { Arsenal, Gun, basis, refillAmmo } from './weapons.js';
import { botGun, Brain } from './ai.js';
import { NADES, NADE_ORDER, throwVelocity, throwOrigin } from './grenades.js';
import { jumpThrow } from './flight.js';
import { DEFAULT_PISTOL, slotOf, isGrenade } from './match.js';
import { FLAG_BULLET } from './collision.js';
import { UniformRandomStream } from '../cs2/rng.js';
import { NET } from '../engine/pvp.js';
import { B, SLOT_SHIFT, ONE_SHOT, hash32 } from './net-codec.js';

export const TICK = 1 / 64;
const STOPPED_SPEED = 1; // (game.js: your top speed while you can't move)
const LEAD = 16; // (the speed guard: commands run may lead the ticks since they joined by this much)

// What a command presses this tick, as weapons.js Arsenal reads an Input: held buttons (1 attack, 4 attack2), presses, clicks
// and the wheel. The same on the host (a remote player) and in the player's own game (its prediction).
export class CmdInput {
  load(cmd) {
    const b = cmd.buttons;
    this.cmd = cmd;
    this.pitch = cmd.pitch; this.yaw = cmd.yaw;
    this.buttons = (b & B.ATTACK ? 1 : 0) | (b & B.ATTACK2 ? 4 : 0);
    const p = new Set();
    if (b & B.RELOAD) p.add('reload');
    if (b & B.INSPECT) p.add('inspect');
    if (b & B.DROP) p.add('drop');
    if (b & B.USEPRESS) p.add('use');
    if (b & B.LASTINV) p.add('lastWeapon');
    const slot = (b >> SLOT_SHIFT) & 7;
    if (slot >= 1 && slot <= 5) p.add('slot' + slot);
    this.pressed = p;
    this.clicked = (b & B.CLICK1 ? 1 : 0) | (b & B.CLICK2 ? 4 : 0);
    this.wheel = b & B.INVNEXT ? 1 : b & B.INVPREV ? -1 : 0;
    return this;
  }
  takePressed() { const p = this.pressed || new Set(); this.pressed = new Set(); return p; }
  takeClicked() { const c = this.clicked | 0; this.clicked = 0; return c; }
  takeWheel() { const w = this.wheel | 0; this.wheel = 0; return w; }
  held(a) { const b = this.cmd?.buttons || 0; return a === 'jump' ? !!(b & B.JUMP) : a === 'duck' ? !!(b & B.DUCK) : a === 'walk' ? !!(b & B.WALK) : a === 'use' ? !!(b & B.USE) : a === 'attack' ? !!(b & B.ATTACK) : a === 'attack2' ? !!(b & B.ATTACK2) : false; }
  notched(a) { return a === 'jump' && !!((this.cmd?.buttons || 0) & B.JUMPPRESS); }
}
// A command again, with what it only presses once taken out (the host runs the last one again when the next hasn't come).
export const repeatCmd = (c) => ({ ...c, buttons: c.buttons & ~ONE_SHOT, buys: null, ping: null, repeat: true });
// The movement a command asks for (game.js tick's, for anyone): none while frozen (freeze time, planting, defusing, the match
// over) but crouching, at the weapon's speed.
export function moveCmd(cmd, frozen, maxSpeed, out = {}) {
  const b = cmd.buttons;
  out.forward = frozen ? 0 : cmd.fwd; out.side = frozen ? 0 : cmd.side; out.yaw = cmd.yaw; out.pitch = cmd.pitch;
  out.jump = !frozen && !!(b & B.JUMP); out.jumpPress = !frozen && !!(b & B.JUMPPRESS); out.duck = !!(b & B.DUCK); out.walk = !frozen && !!(b & B.WALK);
  out.maxSpeed = frozen ? STOPPED_SPEED : maxSpeed;
  return out;
}
// A shot's spread for a command, the same in both games: CS2's random stream, seeded by the match, the shooter and the tick.
export function spreadRand(seed, slot, seq) {
  const s = new UniformRandomStream((hash32(seed, slot, seq & 0xffff) % 2147483646) + 1);
  return () => s.randomFloat(0, 1);
}
// A viewmodel for a gun nobody sees (the host's copy of a remote player's): its clips' lengths, nothing drawn.
export function stubVm(real) {
  let role = null;
  return {
    play: (r, o = {}) => { role = r; return (real?.length(r) || 0) / (o.speed || 1); },
    has: (r) => !!real?.has(r), length: (r) => real?.length(r) || 0, get role() { return role; },
    rig: { visible: false, userData: {} }, update() {}, setSilencer() {}, muzzle: null, model: { userData: {} }, wear() {},
  };
}

export class NetPawn {
  // host: the NetHost; b: their Bot; slot: theirs; info: their slot in the match ({ name, look, skill... }).
  constructor(host, b, slot, info) {
    this.host = host; this.game = host.game; this.b = b; this.slot = slot; this.info = info;
    const g = this.game, c = b.c;
    this.move = new PlayerMovement(g.bodyWorld(() => c), g.map.info.spawns[c.team][0].origin);
    this.ci = new CmdInput();
    this.queue = []; this.cur = null; this.last = null; this.ackSeq = 0; this.seq32 = -1; this.ran = 0; this.since = 0;
    this.extra = []; this.low = Infinity; this.dropped = 0;
    this.buying = new Set();
    this.planting = null; this.defusing = false; this.blindUntil = 0;
    this.plan = {}; this.d = { utility: 0, skill: info?.skill ?? 0.5 }; this.nextThink = 0; this.startDelay = 0;
    this.events = []; this.teleport = null;
    this.bot = null; this.wantBack = false; // (a bot playing for them: a Brain; back at the next freeze time)
    const pawn = this, mc = {};
    this.mc = mc;
    // The Arsenal's world: this player's movement, aim, sounds where they stand, and their shots through the host.
    this.owner = {
      get cv() { return g.cv; }, get me() { return c; }, get player() { return pawn.move; }, get input() { return pawn.ci; },
      get defusing() { return pawn.defusing; }, buyMenu: null, hud: null,
      sounds: { play: (ev, o = {}) => g.sounds?.play(ev, { ...o, pos: b.eye(), listener: g, source: b }), has: (ev) => !!g.sounds?.has(ev) },
      emit: (type, gun) => pawn.arsenalEvent(type, gun),
      canAttack: () => g.match?.phase !== 'freeze' && c.alive && !((pawn.cur?.buttons || 0) & B.FROZEN) && !pawn.defusing,
      playerPlant: (holding, t) => pawn.plant(holding, t),
      fireBullet: (shooter, origin, dir, gun, opts) => host.fireNet(pawn, origin, dir, gun, opts),
      noise: (pos, loud) => g.noise(pos, loud, c),
      throwMyNade: (id, strength, jump) => pawn.throwNade(id, strength, jump),
      usedNade: (id, t) => pawn.usedNade(id, t),
      meleeTrace: (range) => host.rewindFor(pawn, () => pawn.meleeTrace(range)),
      damage: (...a) => g.damage(...a),
    };
    this.arsenal = new Arsenal(this.owner, {});
    this.arsenal.fixedTiming = true;
    b.weapons = this.arsenal.guns;
    b.pawn = this;
    b.human = true;
    c.bot = false;
  }

  get c() { return this.b.c; }
  // (Brain's surface, for what the game asks of anyone in game.bots.)
  get body() { return this.move; }
  roundStart() { this.planting = null; this.defusing = false; }
  buy() {} hear() {} hurt() {} traded() {} obey() {}
  bestSlot() { return this.b.slot; }
  flashed(until) {
    const secs = Math.max(0, (until - this.game.now) / 0.85);
    this.blindUntil = Math.max(this.blindUntil, until);
    if (secs > 0.3) this.events.push({ type: 7, secs });
  }

  // ---- commands ----------------------------------------------------------------------------------------------------------
  // The next command this tick (host.preTick): one, and a few more when more than QUEUE_HI have piled up (a client whose
  // commands came in a bunch, after a stall on the way, catches up, HOST_RUN_MAX a tick at most, as CS2 runs a backlog of
  // usercmds: TCP lost none of them, and dropping them would undo what their game predicted); none when none has come (they're
  // moved by their commands, as Source moves a player: a late command runs when it comes, so it moves them as it did in their
  // own game, not a guess at it); after a quarter of a second without any (gone, or their game's stalled) they stand idle,
  // falling if they're in the air. Never more than the time since they joined allows, and time without commands banks
  // HOST_BANK ticks at most (a speed hack, or a lag switch, gets nothing). Only past HOST_QUEUE_MAX are the oldest dropped.
  nextCmd() {
    const q = this.queue;
    this.since++;
    this.ran = Math.max(this.ran, this.since - NET.HOST_BANK);
    while (q.length > NET.HOST_QUEUE_MAX) { q.shift(); this.dropped++; }
    this.low = Math.min(this.low, q.length);
    const may = () => this.ran < this.since + LEAD;
    let cmd = null;
    this.extra.length = 0;
    if (q.length && may()) {
      cmd = q.shift(); this.ran++;
      while (q.length > NET.QUEUE_HI && this.extra.length < NET.HOST_RUN_MAX - 1 && may()) { this.extra.push(q.shift()); this.ran++; }
    }
    if (cmd) this.idle = 0;
    else if (this.last && ++this.idle > 16) { cmd = repeatCmd(this.last); cmd.fwd = cmd.side = 0; cmd.buttons &= ~(B.ATTACK | B.ATTACK2 | B.JUMP | B.USE); }
    this.cur = cmd;
    if (cmd && !cmd.repeat) { this.last = cmd; this.ackSeq = cmd.seq32; }
    return cmd;
  }
  // A keyframe for them (their game joined, came back, or missed snapshots): it may be a new game, its commands numbered from 0
  // again, so the next command they send starts the count over (dropped as old, a restarted game would never move again).
  // The speed guard goes on as it was: a keyframe asked for over and over gains nothing.
  restart() { this.seq32 = -1; }
  // Commands from their game ({ seq u16 ... }), in order; the seq unwrapped to 32 bits, old ones (already run) dropped.
  take(cmds) {
    for (const c of cmds) {
      const s = this.seq32 < 0 ? c.seq : this.seq32 + ((((c.seq - (this.seq32 & 0xffff)) & 0xffff) ^ 0x8000) - 0x8000);
      if (s <= this.seq32) continue;
      this.seq32 = s; c.seq32 = s;
      this.queue.push(c);
    }
  }

  // ---- a tick (the game's bot loop calls it while they're alive) -----------------------------------------------------------
  tick(dt, t) {
    this.fixGuns();
    this.run(this.cur, t);
    for (const e of this.extra.splice(0)) { this.run(e, t, true); if (!e.repeat) { this.last = e; this.ackSeq = e.seq32; } }
  }
  // Their slots hold this Arsenal's guns only (with a viewmodel to time them): one the game gave their body as it gives a
  // bot's (a bot gun, nothing to draw) would throw in the Arsenal and stop the match for everyone, so it's swapped for theirs.
  fixGuns() {
    const a = this.arsenal, g = this.game;
    for (const [slot, gun] of Object.entries(a.guns)) {
      if (gun?.vm) continue;
      delete a.guns[slot];
      if (a.current === gun) a.current = null;
      if (a.last === gun) a.last = null;
      if (!gun?.id || slot.startsWith('g_')) continue;
      this.give(slot, gun.id, false, gun.skin ?? null).then((x) => {
        if (x) { x.clip = gun.clip ?? x.clip; x.reserve = gun.reserve ?? x.reserve; }
        if (!a.current && !this.bot) a.selectBest(g.now);
      });
    }
  }
  run(cmd, t, again = false) {
    const g = this.game, b = this.b, c = b.c, m = g.match;
    if (!cmd || !c.alive) return;
    // (Their weapons' time goes a tick a command, as in their own game, however their commands bunch up on the way.)
    t = this.t = this.t == null ? t : Math.max(this.t + TICK, t - 0.25);
    for (const id of cmd.buys || []) this.buyNo(id);
    const frozen = m.phase === 'freeze' || !!this.planting || this.defusing || m.phase === 'over';
    moveCmd(cmd, frozen, this.arsenal.maxSpeed(), this.mc);
    this.move.tick(TICK, this.mc);
    if (this.move.origin[2] < -3000) { g.kill(c, null, { name: 'World' }, false); return; }
    // CS2's fall damage (game.js fallDamage, for them).
    const v = this.move.landed;
    this.move.landed = 0;
    if (v > 580) { g.sounds?.play('Player.DamageFall', { pos: b.pos, listener: g, volume: 0.8 }); g.damage(c, ((v - 580) * 100 / (1024 - 580)) * 1.25, { group: 'leg', explosion: true, weapon: { name: 'World' } }); if (!c.alive) return; }
    this.syncBody(cmd);
    this.arsenal.rand = spreadRand(this.host.seed, this.slot, cmd.seq);
    this.arsenal.tick(TICK, t, this.ci.load(cmd));
    if (!c.alive) return;
    if (this.arsenal.pressed?.has('drop')) this.dropMine();
    this.useKey(cmd);
    if (cmd.ping && !again) this.host.pinged(this, cmd.ping);
  }
  // Their body where their movement is (the frame draws it between ticks, like a bot's).
  syncBody(cmd = this.cur) {
    const b = this.b, p = this.move;
    b.pos = p.origin.slice(); b.vel = p.velocity.slice();
    if (cmd) { b.yaw = cmd.yaw; b.pitch = cmd.pitch; }
    b.ducked = !!p.ducked; b.airborne = !p.onGround && !p.onLadder;
    b.climbing = p.onLadder ? (b.climbing || { ladder: true }) : null;
  }

  // What the Arsenal says it did: drawn a gun (their body holds it), fired, reloaded.
  arsenalEvent(type, gun) {
    const g = this.game, b = this.b;
    if (type === 'weapon' && gun) { b.slot = gun.slot; b.equip(gun.id, { skin: gun.skin || null }); }
    else if (type === 'shot' && gun) { g.specAnim?.(b, gun.melee ? 'lightHit' : 'shoot'); if (!gun.melee) g.effects?.worldFlash(b.muzzle()); }
    else if (type === 'reload' && gun) { const secs = Math.max(0.3, (gun.reloadEnd || g.now + 2) - g.now); b.reloadGesture(gun.id, secs); g.specAnim?.(b, 'reload', secs); }
  }

  // ---- their guns ----------------------------------------------------------------------------------------------------------
  // Whose look a gun of theirs has: their own skin for it (their loadout, as the server sent it), or none.
  skinFor(wid) {
    const look = this.info?.look;
    const item = /knife|bayonet/.test(wid) ? look?.knife : look?.guns?.[wid];
    return item ? { owner: 'slot:' + this.slot, item } : null;
  }
  knifeId() {
    const k = this.info?.look?.knife, wid = this.host.knifeWid(k);
    return wid || (this.b.c.team === 'T' ? 'weapon_knife_t' : 'weapon_knife');
  }
  async give(slot, wid, select = true, skin) {
    const g = this.game;
    const d = await g.vmData(wid, { plain: true }).catch(() => null);
    if (g.disposed || this.bot) return null;
    const gun = new Gun({ slot, id: wid, name: d?.name || wid, stats: d?.data?.stats || g.stats?.[wid] || {}, sounds: d?.data?.sounds, vm: stubVm(d?.vm) });
    gun.skin = skin === undefined ? this.skinFor(wid) : skin;
    this.arsenal.give(slot, gun, g.now, select);
    return gun;
  }
  owns(id) {
    const c = this.b.c, gs = this.arsenal.guns;
    if (id === 'defuser') return c.defuser;
    if (id === 'vest') return c.armor >= 100;
    if (id === 'vesthelm') return c.armor >= 100 && c.helmet;
    return this.buying.has(id) || gs.primary?.id === id || gs.secondary?.id === id || gs.taser?.id === id;
  }
  // A buy from their buy menu (game.js buy, for them): → whether it went through.
  buyNo(n) { const id = this.host.buyId(n); if (id) this.buy(id).then((ok) => this.events.push({ type: 10, item: n, ok: !!ok })); }
  async buy(id) {
    const g = this.game, m = g.match, c = this.b.c;
    if (!g.inBuyZone(c) || this.owns(id) || !m.canBuy(c, id, g.stats)) return false;
    const gun = id.startsWith('weapon_') && !isGrenade(id);
    if (gun) this.buying.add(id);
    m.pay(c, id, g.stats);
    if (isGrenade(id)) await this.syncNades();
    else if (gun) { try { await this.give(slotOf(id), id); } finally { this.buying.delete(id); } }
    return true;
  }
  async syncNades(select = null) {
    const c = this.b.c, a = this.arsenal;
    for (const id of NADE_ORDER) {
      const slot = 'g_' + id, n = c.nades[id] || 0;
      if (n > 0 && !a.guns[slot]) await this.give(slot, id, id === select);
      else if (n <= 0 && a.guns[slot]) a.remove(slot, this.game.now);
      else if (n > 0 && id === select) a.select(slot, this.game.now);
    }
  }
  throwNade(id, strength, jump = null) {
    const g = this.game, c = this.b.c, cmd = this.cur || { pitch: 0, yaw: 0 };
    if (!(c.nades[id] > 0)) return false;
    c.nades[id]--;
    const v = this.move.velocity;
    const { eye, vel } = jump?.eye ? jumpThrow(jump.eye, v, g.collision) : { eye: this.move.eye(), vel: v };
    g.nades.throw(c, id, throwOrigin(g.collision, eye, cmd.pitch, cmd.yaw, strength), throwVelocity(cmd.pitch, cmd.yaw, strength, vel));
    this.b.gesture(strength >= 0.5 ? g.botAssets.clips.throw : g.botAssets.clips.lob);
    return c.nades[id];
  }
  usedNade(id, t) {
    const slot = 'g_' + id, a = this.arsenal;
    if (this.b.c.nades[id] > 0 && a.guns[slot]) { a.current = null; a.select(slot, t); return; }
    a.remove(slot, t);
  }
  // Knife reach (game.js meleeTrace, from their eyes).
  meleeTrace(range) {
    const g = this.game, c = this.b.c, cmd = this.cur || { pitch: 0, yaw: 0 }, eye = this.move.eye();
    const { fwd, right, up } = basis(cmd.pitch, cmd.yaw);
    let best = null;
    for (const x of g.ff ? g.combatants.filter((o) => o.alive && o !== c) : g.enemiesOf(c)) {
      for (const off of [[0, 0], [0.12, 0], [-0.12, 0], [0, 0.1], [0, -0.1]]) {
        const d = [0, 1, 2].map((i) => fwd[i] + right[i] * off[0] + up[i] * off[1]);
        const l = Math.hypot(...d), dir = d.map((v) => v / l);
        const h = g.hitTest(x, eye, dir, range + 16);
        if (h && (!best || h.t < best.t)) {
          const yaw = x === g.me ? g.input.yaw : g.botOf(x)?.yaw || 0;
          const facing = [Math.cos((yaw * Math.PI) / 180), Math.sin((yaw * Math.PI) / 180)];
          best = { t: h.t, bot: { c: x }, c: x, backstab: facing[0] * fwd[0] + facing[1] * fwd[1] > 0.5, point: [0, 1, 2].map((i) => eye[i] + dir[i] * h.t), dir: fwd };
        }
      }
    }
    if (best) return best;
    const wall = g.collision.raycast(eye, fwd, range, FLAG_BULLET);
    if (wall) {
      const p = [0, 1, 2].map((i) => eye[i] + fwd[i] * wall.t);
      if (g.doors.shot(wall, p, fwd)) return { wall, broke: true };
      g.effects.impact(p, wall.normal, wall.surface);
      return { wall };
    }
    return null;
  }
  // The bomb (game.js playerPlant, for them): hold fire in a site, standing.
  plant(holding, t) {
    const g = this.game, m = g.match, c = this.b.c, feet = this.move.origin;
    const ok = holding && m.canPlant(c, feet) && this.move.onGround;
    if (!ok) { if (this.planting) { this.planting = null; this.b.setMode('move'); } return; }
    if (!this.planting) {
      this.planting = { start: t };
      this.b.setMode('plant');
      g.sounds?.play('c4.initiate', { pos: this.b.eye(), listener: g, volume: 0.6 });
    }
    if ((t - this.planting.start) / m.rules.plantTime >= 1) {
      this.planting = null;
      this.b.setMode('move');
      m.planted(c, this.move.origin);
      this.arsenal.remove('c4', t);
    }
  }
  // G (game.js dropMine, for them).
  dropMine() {
    const g = this.game, gun = this.arsenal.gun, cmd = this.cur || { pitch: 0, yaw: 0 };
    if (!gun || gun.melee || gun.nade || gun.taser) return;
    if (gun.id === 'weapon_c4') { g.match.dropBomb(this.b.c, this.move.origin); this.arsenal.remove('c4', g.now); return; }
    const eye = this.move.eye(), { fwd } = basis(cmd.pitch, cmd.yaw), v = this.move.velocity;
    g.drops.drop(gun, [eye[0], eye[1], eye[2] - 10], [fwd[0] * 250 + v[0], fwd[1] * 250 + v[1], fwd[2] * 250 + 60], this.b.c);
    this.arsenal.remove(gun.slot, g.now);
  }
  // E (game.js useKey, for them): a gun they look at for the one in that slot, a door, or the bomb to defuse (held).
  useKey(cmd) {
    const g = this.game, m = g.match, c = this.b.c, eye = this.move.eye(), { fwd } = basis(cmd.pitch, cmd.yaw);
    if (this.arsenal.pressed?.has('use') && m.phase !== 'planted') {
      const it = g.drops.lookedAt(eye, fwd);
      if (it && it.id !== 'defuser') {
        const slot = slotOf(it.id), cur = this.arsenal.guns[slot];
        if (cur) { g.drops.drop(cur, [eye[0], eye[1], eye[2] - 10], [0, 0, 0], c); this.arsenal.remove(slot, g.now); }
        this.pickUp(it);
        return;
      }
      if (g.doors.use(eye, fwd)) return;
    }
    let near = false;
    if (cmd.buttons & B.USE && m.phase === 'planted' && c.team === 'CT') {
      const p = m.bomb.pos, d = Math.hypot(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]);
      near = d < 90 && (fwd[0] * (p[0] - eye[0]) + fwd[1] * (p[1] - eye[1]) + fwd[2] * (p[2] - eye[2])) / d > 0.75;
    }
    if (near && !this.defusing) {
      if (m.bomb.defuser && m.bomb.defuser !== c) return;
      if (m.startDefuse(c)) { this.defusing = true; this.b.setMode('defuse'); }
    } else if (!near && this.defusing) { this.defusing = false; if (this.b.mode === 'defuse') this.b.setMode('move'); }
  }
  // Walking over a gun (game.js pickUp, for them): its ammo and its skin as it was.
  pickUp(it) {
    const g = this.game;
    if (!g.drops.take(it)) return;
    const slot = slotOf(it.id);
    this.give(slot, it.id, false, it.skin || null).then((gun) => { if (gun) { gun.clip = it.clip; gun.reserve = it.reserve; } });
  }
  giveC4() { this.give('c4', 'weapon_c4', false); }

  // ---- rounds --------------------------------------------------------------------------------------------------------------
  // A new round (game.js respawnMe and respawnBot, for them). → false while a bot plays for them (the game's own bot respawn
  // goes on); a bot that was is replaced by them now (wantBack).
  respawn(sp, died) {
    const g = this.game, b = this.b, c = b.c, a = this.arsenal;
    if (this.bot && this.wantBack) this.giveBack();
    if (this.bot) return false;
    this.move.teleport(sp.origin);
    this.teleport = { yaw: sp.yaw, pitch: 0 };
    this.planting = null; this.defusing = false; this.blindUntil = 0;
    a.aim = [0, 0]; a.aimVel = [0, 0]; a.view = [0, 0]; a.throws = []; a.scheduled = [];
    b.spawn(this.move.origin, sp.yaw);
    const jobs = [];
    if (died) {
      a.remove('primary', g.now); a.remove('taser', g.now);
      jobs.push(this.give('secondary', DEFAULT_PISTOL[c.team], false));
      c.armor = 0; c.helmet = false; c.defuser = false; c.nades = {};
    }
    for (const gun of Object.values(a.guns)) refillAmmo(gun);
    jobs.push(this.syncNades());
    const knife = this.knifeId();
    if (a.guns.knife?.id !== knife) jobs.push(this.give('knife', knife, false));
    if (c.hasC4) { if (!a.guns.c4) jobs.push(this.give('c4', 'weapon_c4', false)); } else a.remove('c4', g.now);
    Promise.all(jobs).then(() => { if (this.bot) return; a.current = null; a.selectBest(g.now); });
    this.syncBody({ yaw: sp.yaw, pitch: 0 });
    return true;
  }
  // A bot plays for them (they dropped out, or their game is loading): a Brain with their guns as bot guns.
  takeover() {
    if (this.bot) return;
    const g = this.game, b = this.b;
    const brain = new Brain(g, b, this.info?.skill ?? 0.5);
    const w = {};
    for (const [slot, gun] of Object.entries(this.arsenal.guns)) {
      if (slot.startsWith('g_')) continue; // (grenades are the counts in c.nades)
      const bg = botGun(gun.id, gun.stats);
      bg.clip = gun.clip; bg.reserve = gun.reserve; bg.skin = gun.skin || null; bg.slot = slot;
      w[slot] = bg;
    }
    if (this.planting) { this.planting = null; b.setMode('move'); }
    if (this.defusing) { this.defusing = false; b.setMode('move'); }
    b.weapons = w;
    b.slot = w[b.slot] ? b.slot : w.primary ? 'primary' : w.secondary ? 'secondary' : 'knife';
    if (w[b.slot] && b.c.alive) b.equip(w[b.slot].id, { skin: w[b.slot].skin });
    brain.roundStart(null);
    brain.plan = g.plans?.[b.c.team] || {};
    brain.startDelay = 0;
    b.brain = this.bot = brain;
    this.wantBack = false;
    this.queue.length = 0;
  }
  // Back to them (at a freeze time): their guns from the bot's.
  giveBack() {
    const g = this.game, b = this.b, bw = b.weapons;
    this.bot = null;
    this.wantBack = false;
    b.brain = this;
    b.weapons = this.arsenal.guns;
    for (const slot of Object.keys(this.arsenal.guns)) delete this.arsenal.guns[slot];
    this.arsenal.current = null; this.arsenal.last = null;
    for (const [slot, bg] of Object.entries(bw || {})) {
      if (!bg?.id) continue;
      this.give(slot, bg.id, false, bg.skin ?? null).then((gun) => { if (gun) { gun.clip = bg.clip; gun.reserve = bg.reserve; } });
    }
    this.queue.length = 0; this.last = null; this.idle = 0;
    this.move.teleport(b.pos);
    void g;
  }
  // Their own part's weapons block (net-codec writeOwn): what they hold and carry, and their money.
  weaponsState() {
    const a = this.arsenal, c = this.b.c, host = this.host;
    return {
      active: a.current?.slot || null,
      guns: Object.values(a.guns).map((g) => ({ slot: g.slot, wid: g.id, skin: host.skinSlot(g.skin), clip: g.clip ?? 0, reserve: g.reserve ?? 0, silenced: !!g.silenced, burst: !!g.burstMode, zoom: g.zoom | 0 })),
      money: c.money, armor: c.armor, helmet: !!c.helmet, kit: !!c.defuser, c4: !!c.hasC4, nades: { ...c.nades }, team: c.team,
    };
  }
}

// A bot's body standing in for nobody's brain (net-client.js: every body there is drawn from snapshots).
export const MIRROR_BRAIN = {
  roundStart() {}, buy() {}, hear() {}, hurt() {}, traded() {}, obey() {}, flashed() {}, tick() {}, bestSlot() { return 'held'; },
  plan: {}, d: { utility: 0, skill: 0.5 }, blindUntil: 0, nextThink: 0, startDelay: 0, body: null,
};
void NADES;
