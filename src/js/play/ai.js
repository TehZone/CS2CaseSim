// Bot brains: what CS2's bots do in a competitive round. Terrorists pick a bomb site, walk there over the nav mesh and
// plant; counter-terrorists split up to hold the sites and rotate on contact; after the plant both teams play the bomb
// (retake and defuse). They hold spots with cover facing the ways in (spots.js), different ones round to round (on the
// maps setups.js knows, the positions players take there); a CT outnumbered on its site falls back to retake. They don't
// stand about waiting: from a spot held a while with nothing going on they look out along the way in (an info peek, a
// step out for a pick; one CT a round pushes out early), they go after an enemy that got out of sight (a higher rank when
// the odds allow it), to a fight they hear nearby and for a teammate's killer, and the bomb goes down with time to
// spare. In a fight a bot reacts after a human-like delay and aims like a player's hand (aim.js: a flick that lands a
// little off, a correction, then following with a lag), stops to shoot, controls part of the recoil and fires in bursts.
// It knows where enemies are from what it sees and, roughly, from what it hears: it looks for a noise behind a wall where
// they'd come from (the corner, the doorway), not at them through it. Bots buy by their money like CS2's bots (eco, force,
// full buy, an AWP now and then). Your teammates follow your radio commands (radio.js): go to a site, rush, follow you,
// hold, regroup, fall back, cover you.
import { FLAG_BULLET, FLAG_PLAYER } from './collision.js';
import { USE_RANGE } from './doors.js';
import { Aim } from './aim.js';
import { Gun } from './weapons.js';
import { setOf } from './bots.js';
import { PlayerMovement } from './movement.js';
import { STEP_HEIGHT, JUMP_HEIGHT, CROUCH_JUMP_HEIGHT } from './nav.js';
import { skillParams } from './skill.js';
import { advancePlan, stagingPoint, ownSpawn } from './strats.js';
import { lineupsFor, nadeFor } from './utility.js';

// The old four levels (the console's bot_difficulty, and the skill they stand for: see skill.js).
export const LEVEL_SKILL = { easy: 0.15, normal: 0.42, hard: 0.72, expert: 0.95 };
export const DIFFICULTY = {
  easy: { reaction: [0.5, 0.85], turn: 240, aimErr: 7, head: 0.15, control: 0.3, burst: 3, fov: 90, hear: 0.6 },
  normal: { reaction: [0.3, 0.55], turn: 380, aimErr: 4.5, head: 0.3, control: 0.55, burst: 5, fov: 100, hear: 0.8 },
  hard: { reaction: [0.2, 0.35], turn: 560, aimErr: 3, head: 0.45, control: 0.75, burst: 8, fov: 110, hear: 1 },
  expert: { reaction: [0.13, 0.24], turn: 850, aimErr: 1.8, head: 0.65, control: 0.9, burst: 30, fov: 120, hear: 1 },
};
const RELOAD_TIME = { WEAPONTYPE_RIFLE: 2.45, WEAPONTYPE_SUBMACHINEGUN: 2.3, WEAPONTYPE_PISTOL: 2.2, WEAPONTYPE_SNIPER_RIFLE: 3.6, WEAPONTYPE_SHOTGUN: 3.0, WEAPONTYPE_MACHINEGUN: 5.5 };
const rnd = (a, b) => a + Math.random() * (b - a);
const angleTo = (from, to) => {
  const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  return [-(Math.atan2(d[2], Math.hypot(d[0], d[1])) * 180) / Math.PI, (Math.atan2(d[1], d[0]) * 180) / Math.PI];
};
const wrap = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
const _view = [0, 0], _at = [0, 0], _aimOut = [0, 0];
const NO_LADDERS = new Set(); // bots climb ladders on their paths themselves (climb)
// How long after the last sighting on the site the rotate call was for its CTs keep still there (see probing), seconds.
export const ALERT = 10;
// How long into an execute the team waits for its pop flash before going onto the site without it, seconds (on time,
// it bursts about three seconds in: see entryDelay).
export const POP_WAIT = 4.5;
// How long a bot a few steps from its lineup's spot, getting no nearer, keeps trying before it throws from where it is.
export const STUCK_LINEUP = 1.5;
// Gunfire again about where the last was within this long is the same fight going on (see hear), seconds: goSee's while.
export const FIGHT_GOES_ON = 4;
const _chest = [0, 0, 0];
// A path point that's a jump it hasn't made yet (b: the bot).
const jumpAhead = (p, b) => p.jump && b.pos[2] < p[2] + p.jump - STEP_HEIGHT;
// A way through it hasn't gone through yet (a crouch gap, a drop off a ledge: see NavMesh.path cross), though it's near
// the point (d away): it doesn't cut past it to the next one, which is round the corner of it (Vertigo's scaffold frame:
// heading on for the stairs below, it slid along the wall beside the gap).
const shortOf = (p, b, d) => !!p.cross && d > 4 && (b.pos[0] - p[0]) * p.cross[0] + (b.pos[1] - p[1]) * p.cross[1] < -4;

// A gun's inaccuracy (as yours, weapons.js): standing or crouched, the firing penalty, moving faster than a third of its
// top speed, in the air. m: its mode (1 scoped). The bullets' spread adds to it.
export function inaccuracyOf(st, m, { ducked = false, speed = 0, airborne = false, penalty = 0 } = {}) {
  const max = st.maxSpeed?.[m] || 250, move = Math.max(0, Math.min(1, (speed - max * 0.34) / (max * 0.61)));
  return ((ducked ? st.inaccCrouch?.[m] : st.inaccStand?.[m]) || 0) + penalty + (st.inaccMove?.[m] || 0) * move + (airborne ? st.inaccJump?.[m] || 0 : 0);
}

// The chance a shot lands on a target this big (its half width over the distance, radians): bullets land at up to
// inaccuracy (plus spread) from where the gun points, evenly out to it, and recoil it doesn't pull down pushes them off
// by that (radians). A shotgun's pellets: the chance any one does.
export function hitOdds(size, inacc, { spread = 0, bullets = 1, recoil = 0 } = {}) {
  const one = Math.max(0, Math.min(1, (size - recoil) / Math.max(1e-5, inacc + spread)));
  return 1 - (1 - one) ** bullets;
}

// A bot's gun (same data and recoil tables as yours, without a viewmodel).
export function botGun(id, stats, sounds) {
  const g = new Gun({ slot: id === 'weapon_knife' || /knife/.test(id) ? 'knife' : 'x', id, name: id, stats: stats || {}, sounds, vm: null });
  g.punch = [0, 0]; g.punchVel = [0, 0];
  return g;
}

export class Brain {
  // skill: 0 (Silver I) to 1 (The Global Elite), see skill.js (or one of the old levels' names).
  constructor(game, bot, skill = 0.42) {
    this.game = game;
    this.bot = bot;
    this.d = skillParams(typeof skill === 'number' ? skill : LEVEL_SKILL[skill] ?? 0.42);
    this.path = null; this.pi = 0; this.goal = null; this.near = 32; this.closest = null;
    this.target = null; this.lastSeen = null; this.heard = null;
    this.nextThink = 0; this.nextScan = (bot.index % 4) * (1 / 64);
    this.stuckT = 0; this.lastProgress = [0, 0, 0]; this.stuckTries = 0; this.restUntil = 0;
    this.heading = null; // where it means to go (degrees), which it faces while moving
    this.task = 'idle'; // goto | hold | plant | defuse | pickup | hunt
    this.aim = new Aim();
  }

  get c() { return this.bot.c; }

  roundStart(plan) {
    this.plan = plan || {};
    this.blindUntil = 0; this.nadeAt = 0; this.thrown = new Set();
    this.path = null; this.goal = null; this.target = null; this.lastSeen = null; this.heard = null;
    this.task = 'idle';
    this.holdYaw = null; this.baseYaw = null; this.heading = null; this.stuckTries = 0; this.restUntil = 0; this.glanceAt = 0; this.glanceOff = 0;
    this.startDelay = rnd(0, 1.5);
    this.walkUntil = 0;
    this.order = null;
    this.calledSite = false;
    this.approach = null; this.lineupAim = null; this.lineupFace = null; this.trade = null; this.spots = {}; this.retaking = false; this.fellBack = null; this.retakeX = null;
    this.hurtBy = null; this.hurtAt = -99; this.holdPitch = null;
    this.dodge = 0; this.dodgeUntil = 0; this.dodgeFor = null; this.dodgeFlips = 0; this.viaDone = false;
    this.closest = null; this.badPlant = null; this.fetch = null; this.skip = new WeakSet(); this.after = null;
    this.chase = null; this.probe = null; this.probeAt = null; this.pushed = false; this.lurkFor = rnd(4, 9);
    this.aim = new Aim();
  }

  // A radio command from you (your teammates only).
  obey(kind, { pos, target, t }) {
    const b = this.bot;
    if (kind === 'spotted') { this.heard = { pos: target, t }; this.nextScan = t; return; }
    this.path = null; this.goal = null; this.holdYaw = null; this.holdPitch = null; this.spots = {}; this.nextThink = t; this.startDelay = 0;
    this.game.spots?.release(b);
    if (kind === 'siteA' || kind === 'siteB' || kind === 'rush') { this.order = null; return; }
    this.order = { kind, pos: pos.slice(), until: kind === 'fallback' ? t + 25 : kind === 'cover' ? t + 20 : Infinity };
    if (kind === 'hold') this.holdYaw = b.yaw;
  }
  // Following orders (before the bomb is down; then the bomb comes first). Returns true while an order decides.
  followOrder(t) {
    const g = this.game, b = this.bot, o = this.order;
    if (!o || g.match.phase !== 'live') return false;
    if (t > o.until) { this.order = null; return false; }
    const me = g.me, mp = g.player.origin, d = dist2(mp, b.pos);
    switch (o.kind) {
      case 'follow': case 'cover':
        if (!me.alive) { this.order = null; return false; }
        if (d > (o.kind === 'cover' ? 220 : 150)) {
          // A spot near you, a little behind and to the side.
          const yr = (g.input.yaw * Math.PI) / 180, side = (b.index % 2 ? 1 : -1) * 50;
          const spot = [mp[0] - Math.cos(yr) * 70 + Math.sin(yr) * side, mp[1] - Math.sin(yr) * 70 - Math.cos(yr) * side, mp[2]];
          this.setTask('goto', g.nav.findArea(spot, 60) ? spot : mp);
        } else { this.task = 'hold'; this.path = null; this.holdYaw = g.input.yaw + (b.index % 2 ? 35 : -35); this.holdPitch = null; }
        return true;
      case 'hold':
        this.task = 'hold'; this.path = null;
        if (this.holdYaw == null) this.holdYaw = b.yaw;
        return true;
      case 'regroup':
        if (!me.alive || d < 180) { this.order = null; return false; }
        this.setTask('goto', mp);
        return true;
      case 'fallback': {
        const home = g.enemySpawnCenter(this.c.team === 'T' ? 'CT' : 'T');
        if (dist2(home, b.pos) < 300) { this.task = 'hold'; this.path = null; return true; }
        this.setTask('goto', this.spots.home ||= (g.nav.randomPointIn([home[0] - 300, home[1] - 300, home[2] - 150], [home[0] + 300, home[1] + 300, home[2] + 150])?.point || home));
        return true;
      }
    }
    return false;
  }

  // ---- buying -----------------------------------------------------------------------------------------------------
  // Buys by the team's call (strats.js teamEconomy: 'pistol' | 'eco' | 'force' | 'full'). Higher ranks buy more utility
  // (smokes and flashes for the lineups); lower ranks an HE more often.
  buy(econ = 'full') {
    if (econ === true) econ = 'pistol'; else if (!econ) econ = 'full';
    const g = this.game, c = this.c, m = g.match, st = g.stats, skill = this.d.skill, T = c.team === 'T';
    const take = (id) => { if (m.canBuy(c, id, st)) { m.pay(c, id, st); if (id.startsWith('weapon_')) g.giveBot(this.bot, id); return true; } return false; };
    if (econ === 'pistol') {
      if (T || Math.random() < 0.5) take('vest'); else if (Math.random() < 0.6) take('defuser');
      if (Math.random() < 0.25) take(Math.random() < 0.5 ? 'weapon_p250' : T ? 'weapon_tec9' : 'weapon_fiveseven');
      if (skill > 0.5 && Math.random() < 0.5) take('weapon_flashbang');
      return;
    }
    if (econ === 'eco') { // saving: a pistol now and then, a flash at higher ranks
      if (Math.random() < 0.25) take('weapon_p250');
      if (skill > 0.6 && Math.random() < 0.4) take('weapon_flashbang');
      return;
    }
    const has = this.bot.weapons.primary;
    const rifle = T ? 'weapon_ak47' : Math.random() < 0.5 ? 'weapon_m4a1' : 'weapon_m4a1_silencer';
    const full = (st[rifle]?.price || 2900) + 1000;
    if (!has) {
      if (econ === 'force') take(c.money >= 2850 ? (T ? 'weapon_galilar' : 'weapon_famas') : T ? 'weapon_mac10' : 'weapon_mp9');
      else if (c.money >= 4750 + 1000 && Math.random() < 0.18) take('weapon_awp');
      else if (c.money >= full) take(rifle);
      else if (c.money >= 2600) take(T ? 'weapon_galilar' : 'weapon_famas') || take(T ? 'weapon_mac10' : 'weapon_mp9');
      else if (c.money >= 1300 && Math.random() < 0.35) take('weapon_deagle') || take('weapon_p250');
    }
    if (this.bot.weapons.primary || c.money >= 2500) take('vesthelm') || take('vest');
    if (!T && Math.random() < (econ === 'force' ? 0.4 : 0.75)) take('defuser');
    // Grenades with what's left.
    if (this.bot.weapons.primary) {
      const fire = T ? 'weapon_molotov' : 'weapon_incgrenade', u = 0.35 + skill * 0.6;
      const list = econ === 'force' ? [['weapon_flashbang', 0.5 * u]]
        : [['weapon_smokegrenade', u], ['weapon_flashbang', u], [fire, 0.25 + skill * 0.5], ['weapon_flashbang', u * 0.7], ['weapon_hegrenade', 0.5 - skill * 0.3]];
      for (const [id, p] of list) if (Math.random() < p && c.money >= (st[id]?.price || 300) + 200) take(id);
    }
  }

  // Flashbanged: blind until then (a bot that was aiming at you loses you).
  flashed(until) {
    if (!(this.blindUntil > this.game.now)) this.blindYaw = this.bot.yaw;
    this.blindUntil = Math.max(this.blindUntil || 0, until);
    if (this.target) this.target.visible = false;
  }

  // ---- per tick ---------------------------------------------------------------------------------------------------
  tick(dt, t) {
    const g = this.game, b = this.bot, c = this.c;
    if (!c.alive) return;
    const phase = g.match.phase;
    this.updateGun(dt, t);
    if (phase === 'freeze') { b.vel = [0, 0, 0]; this.lookAround(dt, t); return; }
    if (t >= this.nextScan) { this.nextScan = t + 3 / 64; this.scan(t); }
    // (Their thinking spread over the ticks: all nine finding paths in the same tick, as the round went live, took 20 ms.)
    if (t >= this.nextThink && t - g.liveAt >= (b.index % 8) * 0.03) { this.nextThink = t + 0.25; this.decide(t); }
    let moving = true;
    if (this.target?.visible) moving = this.fight(dt, t);
    else if (this.task === 'plant' || this.task === 'defuse') moving = false;
    if (b.mode === 'plant' || b.mode === 'defuse') moving = false;
    // A lineup's grenade in hand: still on its spot till it leaves the hand (the throw was worked out from exactly there;
    // its next task waits).
    if (b.pendingThrow?.lineup && !b.pendingThrow.released) moving = false;
    this.move(dt, t, moving);
    if (!this.target?.visible && b.mode === 'move') this.look(dt, t);
  }

  // Keeps the current gun reloaded and switched to the best one.
  updateGun(dt, t) {
    const b = this.bot, gun = b.weapons[b.slot];
    for (const slot in b.weapons) { // (not Object.values: every bot, every tick)
      const w = b.weapons[slot];
      if (!w?.punch) continue;
      const e = Math.exp(-6 * dt);
      w.punch[0] = w.punch[0] * e + w.punchVel[0] * dt; w.punch[1] = w.punch[1] * e + w.punchVel[1] * dt;
      w.punchVel[0] *= Math.exp(-8 * dt); w.punchVel[1] *= Math.exp(-8 * dt);
      w.penalty *= Math.exp(-dt * 2.3 / Math.max(0.1, w.stats.recoveryStand || 0.4));
      if (t > w.lastShot + 0.4) w.recoilIndex *= Math.exp(-dt * 6);
      if (w !== gun || (!this.target?.visible && t > (this.target?.lostAt || 0) + 1)) w.zoom = 0; // (scoped only to fight)
    }
    if (gun?.reloading && t >= gun.reloadEnd) {
      const take = Math.min(gun.stats.clip - gun.clip, gun.reserve);
      gun.clip += take; gun.reserve -= take; gun.reloading = false;
    }
    const want = this.bestSlot();
    if (want !== b.slot && !gun?.reloading && !b.pendingThrow) this.game.botSwitch(b, want, t);
    if (gun && !gun.melee && !gun.reloading && gun.clip < gun.stats.clip && gun.reserve > 0 && (gun.clip === 0 || (!this.target?.visible && gun.clip < gun.stats.clip * 0.4 && t > (this.target?.lostAt || 0) + 1.5))) {
      gun.reloading = true;
      // CS2's reload time from the weapon data (shotguns: half a second a shell).
      const st = gun.stats;
      gun.reloadEnd = t + (st.bulletsPerReload === 1 ? 0.5 * (st.clip - gun.clip) : st.reloadTime || RELOAD_TIME[st.type] || 2.5);
      this.bot.reloadGesture(gun.id, gun.reloadEnd - t);
      this.game.specAnim?.(this.bot, 'reload', gun.reloadEnd - t);
      this.game.botSound(b, gun.prefix + 'Clipout', 0.5);
    }
  }

  bestSlot() {
    const w = this.bot.weapons;
    if (this.task === 'plant' && w.c4) return 'c4';
    const ok = (g) => g && (g.clip > 0 || g.reserve > 0);
    if (ok(w.primary)) return 'primary';
    if (ok(w.secondary)) return 'secondary';
    return 'knife';
  }

  // ---- senses -----------------------------------------------------------------------------------------------------
  scan(t) {
    const g = this.game, b = this.bot, eye = b.eye();
    if (t < this.blindUntil) { if (this.target?.visible) { this.target.visible = false; this.target.lostAt = t; } return; }
    const fx = Math.cos((b.yaw * Math.PI) / 180), fy = Math.sin((b.yaw * Math.PI) / 180);
    let best = null, bestD = Infinity;
    // (Ten bots, twenty times a second each: nothing made for an enemy out of range or out of view.)
    for (const e of g.combatants) {
      if (!e.alive || !g.hostile(this.c, e)) continue;
      const chest = g.chestInto(e, _chest);
      const d = Math.hypot(chest[0] - eye[0], chest[1] - eye[1], chest[2] - eye[2]);
      if (d > 4500) continue;
      const dh = Math.hypot(chest[0] - eye[0], chest[1] - eye[1]) || 1, cos = ((chest[0] - eye[0]) / dh) * fx + ((chest[1] - eye[1]) / dh) * fy;
      // (Someone who just shot it: it turns to them wherever they are, for a moment.)
      const inView = cos > Math.cos(((this.d.fov / 2) * Math.PI) / 180) || d < 220 || (this.hurtBy === e && t - this.hurtAt < 1.5);
      if (!inView) continue;
      const body = g.bodyOf(e), seen = g.canSee(eye, body.head) ? body.head : g.canSee(eye, body.chest) ? body.chest : undefined;
      // Stick with the enemy it's fighting unless another is clearly closer (two at about the same distance would
      // otherwise swap every scan, the aim flicking between them).
      const dd = this.target?.c === e && this.target.visible ? d * 0.7 : d;
      if (seen && dd < bestD) { best = { c: e, point: seen, d, cos, head: seen === body.head, chest: body.chest }; bestD = dd; }
    }
    if (best) {
      g.spot(best.c, this.c);
      // Its reaction (the rank's, and longer the further from where it was looking they are), then its aim moves (aim.js).
      // The same enemy back in sight after a moment out of it: a quicker reaction, it was half expecting them there.
      const fresh = !this.target || this.target.c !== best.c, back = !fresh && !this.target.visible && t - (this.target.lostAt ?? t) > 0.25;
      if (fresh || back) {
        const off = (Math.acos(Math.max(-1, Math.min(1, best.cos))) * 180) / Math.PI;
        const react = rnd(...this.d.reaction) * (back ? 0.6 : 1) + (this.d.periph || 0) * Math.min(1, off / 60);
        if (fresh) {
          this.target = { c: best.c, since: t, react: t + react, shots: 0, pauseUntil: 0, vel: [0, 0], ang: null };
          this.aimHead = Math.random() < this.d.head;
          this.crouchFight = Math.random() < 0.25 && best.d > 900;
        } else { this.target.react = t + react; this.target.ang = null; this.target.vel[0] = this.target.vel[1] = 0; }
        this.aim.start(t, react);
      }
      if (!this.target.visible && t - (this.target.calledAt ?? -99) > 6) { this.target.calledAt = t; g.radio.chatter(this.c, 'spotted', { where: g.placeOf(best.c) ? 'at ' + g.placeOf(best.c).replace(/([a-z])([A-Z])/g, '$1 $2') : '' }); }
      this.target.visible = true;
      this.target.dist = best.d;
      // What of them it can see (it aims at that: with only their head over a ledge, a shot at the chest hits the ledge).
      this.target.sees = !best.head ? 'chest' : g.canSee(eye, best.chest) ? 'both' : 'head';
      this.lastSeen = { pos: g.bodyOf(best.c).feet.slice(), t };
      g.callout(this.c, best.c);
      if (this.c.team === 'CT') this.reportContact(best.c);
    } else if (this.target?.visible) {
      this.target.visible = false;
      this.target.lostAt = t;
    }
    if (this.target && !this.target.c.alive) this.target = null;
  }

  // A gun went off nearby, or footsteps. A sound gives a rough idea where it came from, not the spot: off by more the
  // further it was, more again through a wall; and while the same footsteps or shots go on about there, the idea stays
  // put rather than following each one (it used to have each one's exact spot, and turned to follow enemies through
  // walls step by step).
  hear(pos, loud, t) {
    if (this.target?.visible) return;
    const b = this.bot, d = Math.hypot(pos[0] - b.pos[0], pos[1] - b.pos[1]);
    if (d > loud * this.d.hear) return;
    const h = this.heard;
    if (h?.src && t - h.t < 1.2 && dist2(h.src, pos) < 250) { h.t = t; return; }
    const clear = this.game.lineOfSight(b.eye(), [pos[0], pos[1], pos[2] + 40]);
    // Footsteps (and a grenade going off): an impatient (lower-ranked) bot goes to see, a patient one holds its angle and
    // waits for them. Gunfire is a fight going on, a teammate's as often as not: most go to it, a good player as much as
    // anyone (join), decided once for the fight (more bursts about there don't roll again: it went, came back, went).
    // Not a decoy's bursts (no one's there to fight; a patient player isn't drawn by it, an impatient one goes to see, as
    // for footsteps: it drew a Global Elite most of its 15 s, a Silver about half), nor a CT's for gunfire about the site
    // it holds (an execute coming in: a patient one holds its post and its angle; the rotate call brings the others).
    const fight = loud >= 2500 && !this.decoyAt(pos) && !this.onPost(pos);
    const same = fight && h?.fight && t - h.t < FIGHT_GOES_ON && dist2(h.src, pos) < 600;
    this.heard = { ...this.guess(pos, d, clear ? 0.05 : 0.14), t, fight, peek: same ? h.peek : Math.random() < (fight ? this.d.join ?? 0 : 1 - this.d.patience) };
  }
  // A decoy going off there (its bursts, see grenades.js).
  decoyAt(pos) { return !!this.game.nades?.decoys?.some((x) => dist2(x.pos, pos) < 1); }
  // About the site a CT holds (the site and 700 units round it, as its sightings count: see reportContact).
  onPost(pos) {
    if (this.plan?.side !== 'CT') return false;
    const s = this.game.map?.info?.bombsites?.find((x) => x.site === this.ctSite());
    return !!s && pos[0] > s.min[0] - 700 && pos[0] < s.max[0] + 700 && pos[1] > s.min[1] - 700 && pos[1] < s.max[1] + 700;
  }
  // Roughly where something at pos (d away) is, on the ground there: off by share of the distance (one standard
  // deviation) and a little more.
  guess(pos, d, share) {
    const sd = d * share + 24, x = pos[0] + gauss() * sd, y = pos[1] + gauss() * sd;
    return { pos: [x, y, this.game.nav?.groundAt(x, y, pos[2] + 8, 16, 200) ?? pos[2]], src: pos.slice(), watch: null };
  }
  // A teammate just died near here: go for the killer (trading), as fast as its rank goes; where the killer is it knows
  // only roughly (where the shots came from). Not one with a lineup of its own to throw first (see throwing): the
  // execute's smoke goes out rather than its thrower running off with it.
  traded(killer, pos, t) {
    if (this.target?.visible || this.throwing() || Math.random() > this.d.trade) return;
    this.trade = { c: killer, pos: pos.slice(), until: t + 5 };
    const at = this.game.bodyOf(killer).feet;
    this.heard = { ...this.guess(at, dist2(at, this.bot.pos), 0.1), t };
    this.nextThink = t;
  }
  // Shot: it knows which way it came from (and turns to look, see scan), roughly how far.
  hurt(attacker, t) {
    this.hurtBy = attacker; this.hurtAt = t;
    if (!this.target?.visible && attacker) {
      const at = this.game.bodyOf(attacker).feet;
      this.heard = { ...this.guess(at, dist2(at, this.bot.pos), 0.05), t };
      this.nextScan = t;
    }
  }
  // Where to look for an enemy it heard or lost sight of (h: heard or lastSeen): there if it can see the spot, else the
  // way they'd come from it (the last of the way there it can see: the corner of a wall, a doorway), not at the wall
  // between; null when it can see none of it. Worked out again every second or so.
  watchPoint(h, t) {
    if (h.watchAt != null && t < h.watchAt + 1) return h.watch;
    const g = this.game, eye = this.bot.eye(), at = [h.pos[0], h.pos[1], h.pos[2] + 60];
    let w = at;
    if (!g.lineOfSight(eye, at)) {
      const pts = g.nav?.path(this.bot.pos, h.pos)?.points;
      w = null;
      for (let i = 0; pts && i < pts.length && i < 32; i++) {
        const p = [pts[i][0], pts[i][1], pts[i][2] + 60];
        if (dist2(p, eye) < 64) continue;
        if (g.lineOfSight(eye, p)) w = p; else if (w) break;
      }
    }
    h.watch = w; h.watchAt = t;
    return w;
  }

  // ---- fighting ---------------------------------------------------------------------------------------------------
  // Aims at the target and shoots. Returns whether the bot should keep moving.
  fight(dt, t) {
    const g = this.game, b = this.bot, tg = this.target;
    const body = g.bodyOf(tg.c);
    const eye = b.eye();
    // Its head or its body, whichever the bot means to shoot (aimHead) if it can see that, else what it can see.
    const sees = tg.sees || 'both', atHead = sees === 'both' ? this.aimHead : sees === 'head';
    const aimAt = atHead ? body.head : body.chest;
    const [p, y] = angleTo(eye, aimAt);
    // How fast the point it aims at moves across its view (deg/s, smoothed), for its hand to follow (aim.js). (Not as
    // it moves from the head to the body or back.)
    if (tg.ang && tg.atHead === atHead) {
      const kv = 1 - Math.exp(-dt / 0.05);
      tg.vel[0] += ((p - tg.ang[0]) / dt - tg.vel[0]) * kv; tg.vel[1] += (wrap(y - tg.ang[1]) / dt - tg.vel[1]) * kv;
    } else tg.ang ||= [0, 0];
    tg.ang[0] = p; tg.ang[1] = y; tg.atHead = atHead;
    const dist = Math.max(1, tg.dist || 1), deg = (u) => (Math.atan(u / dist) * 180) / Math.PI;
    _view[0] = b.pitch; _view[1] = b.yaw; _at[0] = p; _at[1] = y;
    this.aim.step(dt, t, _view, _at, tg.vel, deg(atHead ? 4 : 9), this.d, _aimOut);
    b.pitch = _aimOut[0]; b.yaw = _aimOut[1];
    const gun = b.weapons[b.slot];
    if (b.slot === 'c4') return true;
    if (b.pendingThrow) return false; // a grenade in hand: throw it first
    if (!gun || gun.reloading) { b.ducked = false; return tg.dist < 600; }
    if (gun.melee) {
      // Run at them with the knife and slash when close.
      if (tg.dist < 70 && t >= gun.nextAttack && t >= tg.react) { gun.nextAttack = t + 0.5; g.botKnife(b, tg.c, gun); }
      return true;
    }
    b.ducked = this.crouchFight;
    // A sniper rifle scopes in (unscoped, CS2's are wild) unless the enemy is right on top of it; the shot waits until
    // the scope has settled.
    const scope = gun.stats.zoomLevels > 0 && tg.dist > 300;
    if (scope && !gun.zoom && t >= tg.react - 0.15) {
      gun.zoom = 1;
      gun.zoomReady = t + (gun.stats.zoomTime?.[1] || 0.05) + rnd(0.05, 0.15) + (1 - this.d.skill) * 0.25;
      g.botSound(b, 'Weapon_AWP.Zoom', 0.4);
    } else if (!scope && gun.zoom) gun.zoom = 0;
    // On them: the crosshair on their head, or on their body (then it's a body shot). It shoots once its aim follows
    // them, between corrections while it's on them, or (a higher rank) as a flick arrives on them.
    const ph = this.aim.phase, ready = ph === 'track' || ph === 'dwell' || (this.d.flickShot && this.aim.progress(t) > 0.85);
    // (Only on what it can see of them: the crosshair on their hidden chest is on the ledge in front of it.)
    const head = angleTo(eye, body.head), chest = atHead ? angleTo(eye, body.chest) : [p, y];
    const onTarget = ready && ((sees !== 'chest' && Math.hypot(b.pitch - head[0], wrap(b.yaw - head[1])) < Math.max(0.2, deg(4.5)))
      || (sees !== 'head' && Math.abs(wrap(b.yaw - chest[1])) < Math.max(0.3, deg(10)) && Math.abs(b.pitch - chest[0]) < Math.max(0.4, deg(18))));
    const settled = (!scope || (gun.zoom && t >= gun.zoomReady)) && this.accurate(gun, tg, atHead);
    if (t >= tg.react && t >= tg.pauseUntil && onTarget && settled && t >= gun.nextAttack && gun.clip > 0 && !g.teammateInLine(b, aimAt) && !g.cv?.bot_dont_shoot) {
      const auto = gun.stats.fullAuto;
      const burst = tg.dist < 600 ? this.d.burst * 3 : tg.dist < 1500 ? this.d.burst : Math.max(1, Math.round(this.d.burst / 2));
      g.botShoot(b, gun, t, this.d.control);
      tg.shotAt ??= t;
      tg.shots++;
      if (!auto) gun.nextAttack = Math.max(gun.nextAttack, t + rnd(0.08, 0.25) + (tg.dist > 1200 ? 0.15 : 0));
      if (tg.shots >= burst) { tg.shots = 0; tg.pauseUntil = t + rnd(0.2, 0.45); }
    }
    // Stand still to shoot accurately (counter-strafing): a Global Elite has stopped as it fires, a Silver keeps walking a
    // while, its first shots wide. Until it reacts, it carries on as it was.
    return tg.shotAt == null ? t < tg.react : t < tg.shotAt + this.d.strafe;
  }

  // Whether its next shot would land, as it knows its gun (see inaccuracyOf, hitOdds): the spread now (moving, the
  // spray's penalty) and the recoil it can't pull down, against the target's size there. One that knows its gun
  // (discipline) waits for good odds, or the best this gun gets at that range: it stops before shooting, taps at range,
  // bursts nearer and sprays up close. A Silver fires anyway.
  accurate(gun, tg, atHead = this.aimHead) {
    const b = this.bot, st = gun.stats, m = gun.zoom > 0 ? 1 : 0;
    const size = (atHead ? 4 : 8) / Math.max(1, tg.dist);
    const opts = { spread: st.spread?.[m] || 0, bullets: st.bullets || 1 };
    const now = hitOdds(size, inaccuracyOf(st, m, { ducked: b.ducked, speed: Math.hypot(b.vel[0], b.vel[1]), airborne: b.airborne, penalty: gun.penalty }),
      { ...opts, recoil: Math.hypot(gun.punch[0], gun.punch[1]) * 2 * (1 - this.d.control) * (Math.PI / 180) });
    const best = hitOdds(size, inaccuracyOf(st, m, { ducked: b.ducked }), opts);
    return now >= this.d.discipline * Math.min(0.5, best * 0.85);
  }

  turnTo(p, y, dt, rate = 1) {
    const b = this.bot, max = this.d.turn * rate * dt;
    const dy = wrap(y - b.yaw), dp = p - b.pitch;
    b.yaw = wrap(b.yaw + Math.max(-max, Math.min(max, dy)));
    b.pitch = Math.max(-89, Math.min(89, b.pitch + Math.max(-max, Math.min(max, dp))));
  }

  // Where to look when not fighting: the last place an enemy was, a noise, the hold angle, or ahead.
  look(dt, t) {
    const b = this.bot;
    if (b.climbing) return;
    // Blind: looking about, around where it faced when the flash went off (targets relative to the current facing
    // would add up, frame after frame, into spinning).
    if (t < this.blindUntil) { this.turnTo(8 + Math.sin(t * 9) * 3, (this.blindYaw ?? b.yaw) + Math.sin(t * 3.1 + b.index) * 35, dt, 0.4); return; }
    // Where an enemy was last seen, or heard: there, or where they'd come from there (see watchPoint).
    const seenAt = this.lastSeen && t - this.lastSeen.t < 4 && this.watchPoint(this.lastSeen, t);
    if (seenAt) { const [p, y] = angleTo(b.eye(), seenAt); this.turnTo(p, y, dt, 0.7); return; }
    const heardAt = this.heard && t - this.heard.t < 3 && this.watchPoint(this.heard, t);
    if (heardAt) { const [p, y] = angleTo(b.eye(), heardAt); this.turnTo(p, y, dt, 0.6); return; }
    if (this.lineupFace) { this.turnTo(this.lineupFace[0], this.lineupFace[1], dt, 0.35); return; } // lining up a throw
    // Holding a spot: the angle it holds (at head height where they'd show, for a good player; lower for a Silver).
    if (this.task === 'hold' && this.holdYaw != null && Math.hypot(b.vel[0], b.vel[1]) < 20) {
      // (An angle worked out for the spot is held steadier: a glance off it is a few degrees.)
      this.glance(dt, t, this.holdYaw, this.holdPitch == null ? 15 : 6, 0.2, this.holdPitch == null ? this.d.crosshair : this.holdPitch + this.d.crosshair * 0.8);
      return;
    }
    // Moving: face the way it's going (the path, not its velocity, which teammates shoving past and walls jostle), the
    // crosshair at head height for a good player, down at the floor for a Silver.
    if (this.heading != null && Math.hypot(b.vel[0], b.vel[1]) > 30) this.turnTo(this.d.crosshair, this.heading, dt, 0.5);
  }
  // Freeze time: still, the odd glance either side of the heading it spawned with.
  lookAround(dt, t) {
    this.baseYaw ??= this.bot.yaw;
    this.glance(dt, t, this.baseYaw, 8, 0.1);
  }
  // Standing still like a player: aim steady at an angle, and every few seconds maybe a small glance to one side (eased,
  // then still again), not a constant sweep.
  glance(dt, t, base, spread, rate, pitch = this.d.crosshair) {
    if (t >= this.glanceAt) {
      this.glanceAt = t + 3 + Math.random() * 4;
      this.glanceOff = Math.random() < 0.5 ? 0 : (Math.random() * 2 - 1) * spread;
    }
    this.turnTo(pitch, base + this.glanceOff, dt, rate);
  }

  // ---- objectives -------------------------------------------------------------------------------------------------
  // (A lineup it was on and isn't any more, its moment gone (a CT's smoke past the first half minute, a retake's once
  // the clock's too short): its aim and its last steps onto the spot go with it. It went on facing the throw's angle,
  // drawn back onto the spot, not throwing anything else, for the rest of the round.)
  decide(t) {
    this.lining = false;
    this.think(t);
    if (!this.lining && (this.lineupFace || this.approach) && !this.bot.pendingThrow) { this.lineupFace = null; this.approach = null; this.lineupAim = null; }
  }
  think(t) {
    const g = this.game, m = g.match, b = this.bot, c = this.c, bomb = m.bomb;
    if (t - g.liveAt < this.startDelay) return;
    if (this.target?.visible && !this.target.c.alive) this.target = null;
    if (g.respawnMode) return this.hunt(t);
    const siteBox = (s) => g.map.info.bombsites.find((x) => x.site === s);
    if (!this.target?.visible && t >= this.nadeAt && !this.lineupFace) this.useNades(t, siteBox);
    if (this.followOrder(t)) return;
    // A CT outnumbered where it holds falls back (see fallBack), rather than trading into them.
    if (c.team === 'CT' && bomb.state !== 'planted') { const back = this.fallBack(this.ctSite(), t, siteBox); if (back) return this.holdAt(back.spot, t, back.face); }
    // Trading a teammate who just went down nearby, after an enemy it was fighting who got out of sight (see chaseTo), or
    // going to see a noise (footsteps: impatient ones; a fight nearby: most), before the plan.
    if (this.trade && t < this.trade.until && !this.target?.visible && bomb.state !== 'planted') return this.setTask('goto', this.trade.pos);
    const after = this.chaseTo(t);
    if (after) return this.setTask('goto', after, 48);
    if (this.goSee(t)) return this.setTask('goto', this.heard.pos);
    // No rifle? Grab one lying nearby.
    if (!b.weapons.primary && !this.target?.visible && (bomb.state !== 'planted' || c.team === 'T')) {
      const loot = g.drops.list.filter((it) => it.id !== 'defuser' && !this.skip.has(it) && !/^weapon_(glock|usp_silencer|hkp2000|elite|p250|tec9|fiveseven|cz75a|deagle|revolver)$/.test(it.id) && !g.nades.inFire(it.pos))
        .map((it) => ({ it, d: Math.hypot(it.pos[0] - b.pos[0], it.pos[1] - b.pos[1]) })).filter((x) => x.d < 700).sort((x, y) => x.d - y.d)[0];
      if (loot && this.fetching(loot.it, t)) return this.setTask('goto', loot.it.pos, 16);
    }
    // A CT without a kit picks one up lying nearby.
    if (c.team === 'CT' && !c.defuser && !this.target?.visible) {
      const kit = g.drops.list.find((it) => it.id === 'defuser' && !this.skip.has(it) && Math.hypot(it.pos[0] - b.pos[0], it.pos[1] - b.pos[1]) < 600);
      if (kit && this.fetching(kit, t)) return this.setTask('goto', kit.pos, 16);
    }
    if (c.team === 'T') {
      if (bomb.state === 'dropped' && g.nearestTo(bomb.pos, 'T') === c) return this.setTask('pickup', bomb.pos, 8);
      if (bomb.state === 'planted') {
        // Get clear before it goes off.
        if (m.rules.bombTime - (g.now - bomb.plantedAt) < 9) return this.flee(bomb.pos);
        return this.holdNear(bomb.pos, 500, 'bomb', t);
      }
      const plan = this.plan;
      advancePlan(g, plan, t);
      const site = siteBox(plan.site || 'A');
      const stage = plan.stage || 'execute', role = plan.roles?.get(c);
      // A lineup of its own for the plan comes first.
      const mine = plan.throws?.find((x) => x.by === c && !x.done);
      if (mine && (stage !== 'setup' || mine.early) && this.doLineup(mine, t, !!mine.early)) return;
      const going = stage === 'execute' && t >= (plan.execStart ?? 0) + this.entryDelay(plan);
      // A rush coming in by another way than the shortest (see strats.js): through its doorway first.
      if (plan.via && plan.rush && !this.viaDone && site) {
        if (dist2(plan.via, b.pos) > 120 && !m.siteAt(b.pos)) return this.setTask('goto', plan.via);
        this.viaDone = true;
      }
      if (c.hasC4 && site) {
        if (!this.calledSite && Math.hypot(site.min[0] - b.pos[0], site.min[1] - b.pos[1]) < 2200) { this.calledSite = true; g.radio.chatter(c, 'goingToPlant', { site: site.site }); }
        if (this.plantNow(t)) { this.setTask('plant'); g.botPlant(b, t); return; }
        // (Right onto its spot: near isn't enough, it has to be in the site.)
        if (stage === 'execute' && (going || plan.rush)) return this.setTask('goto', this.plantSpot(site), 4);
        return this.holdGather(plan.site, t, plan.route);
      }
      if (stage === 'setup') return this.setupHold(plan, role, t);
      // The lurker: by the other site's way in, for the CTs rotating out of it (a look out for a pick now and then), until
      // the execute's under way (see lurking).
      if (this.lurking(plan, t) && siteBox(plan.site === 'A' ? 'B' : 'A')) return this.holdGather(plan.site === 'A' ? 'B' : 'A', t, 0, true);
      if (stage === 'gather' || !going) return this.holdGather(plan.site, t, plan.route);
      return this.holdIn(site, t, true);
    }
    // CT
    if (bomb.state === 'planted') {
      const d = Math.hypot(bomb.pos[0] - b.pos[0], bomb.pos[1] - b.pos[1], bomb.pos[2] - b.pos[2]);
      const timeLeft = m.rules.bombTime - (g.now - bomb.plantedAt);
      const need = c.defuser ? m.rules.defuseKitTime : m.rules.defuseTime;
      // At the bomb; or stopped as near as it gets to it (on a ledge it can't get onto, past a crate) and within your reach
      // of it (eye to bomb, as you defuse: see Game.useKey).
      const eye = b.eye(), reach = Math.hypot(bomb.pos[0] - eye[0], bomb.pos[1] - eye[1], bomb.pos[2] - eye[2]);
      const at = d < 50 || (!this.path && this.task === 'goto' && this.goal && dist2(this.goal, bomb.pos) < 1 && reach < 90);
      if (at && (!this.recentlySawEnemy(t, 1.5) || timeLeft < need + 1.5) && timeLeft > need - 0.3) { this.setTask('defuse'); g.botDefuse(b, t); return; }
      // Too late to get there and defuse: save yourself.
      if (b.mode !== 'defuse' && timeLeft < need + d / 230 - 0.5) return this.flee(bomb.pos);
      if (bomb.defuser && bomb.defuser !== c) return this.holdNear(bomb.pos, 350, 'cover', t);
      // A retake together: wait short of the site for a teammate (higher ranks; Silvers run in one by one), unless time
      // won't allow it.
      const spot = this.retakeSpot(bomb), cts = g.combatants.filter((x) => x.team === 'CT' && x.alive);
      const near = cts.filter((x) => dist2(g.positionOf(x), spot) < 450).length;
      const rush = timeLeft < need + d / 200 + 7 || near >= Math.min(2, cts.length) || Math.random() > this.d.patience;
      // A retake's utility on the way in, with the time for it: smokes cutting off where the terrorists hold the bomb
      // from, then flashes (one of each lineup for the site, whoever's nearest it with the grenade).
      if (!this.retaking && timeLeft > need + d / 200 + 12 && this.retakeUtility(bomb, t)) return;
      if (!rush && d > 700 && !this.retaking) return this.holdAt(spot, t, bomb.pos);
      this.retaking = true;
      return this.setTask('goto', bomb.pos, 8);
    }
    const assigned = this.plan.assign?.get(c) || 'A', site = this.ctSite();
    // Its utility at the choke it holds: a smoke early (the first half minute), a molotov or HE as they come (seen on its
    // site, or heard near where it goes: a rush's footsteps), from its lineup's spot if it's close by, between fights.
    const early = this.plan.throws?.find((x) => x.by === c && !x.done && !(x.lineup.kind === 'smoke' && t - g.liveAt >= 30));
    if (early && !this.target?.visible) {
      const smoke = early.lineup.kind === 'smoke', l = early.lineup;
      const coming = early.until || this.contactAt(assigned, t, 4) > 0 || (this.heard && t - this.heard.t < 3 && dist2(this.heard.pos, l.land) < 900);
      // (Not while its choke is smoked, its own team's smoke or theirs: a molotov landing in a smoke goes straight out.)
      if (smoke ? t - g.liveAt < 30 && this.doLineup(early, t, true)
        : coming && dist2(l.pos, b.pos) < 600 && !this.wastes(l.kind, l.land) && this.doLineup(early, t, true, (early.until ||= t + 6))) return;
    }
    // (Each holding its spot, with a look out along the way in now and then: see probing.)
    if (site === 'mid' && g.midSpot) { const s = this.spotAt(this.plan.pos?.get(c) && site === assigned ? 'pos:CT:' + this.plan.pos.get(c).id : 'mid:CT', () => g.midSpot); if (this.probing(t, s)) return; return this.holdAt(s.pos, t, null, s.look); }
    // Its position there (setups.js), unless it's rotated to another site.
    const p = site === assigned && this.plan.pos?.get(c);
    if (p && siteBox(site)) { const s = this.spotAt('pos:CT:' + p.id, () => this.siteSpot(siteBox(site), 'hold')); if (this.probing(t, s)) return; return this.holdAt(s.pos, t, this.game.enemySpawnCenter(c.team), s.look); }
    return this.holdIn(siteBox(site), t, false);
  }

  // Deathmatch / Arms Race: go where enemies were last seen or heard, else roam towards the nearest one's area.
  hunt(t) {
    const g = this.game, b = this.bot;
    if (this.followOrder(t)) return;
    if (this.lastSeen && t - this.lastSeen.t < 5) return this.setTask('goto', this.lastSeen.pos);
    if (this.heard && t - this.heard.t < 4 && dist2(this.heard.pos, b.pos) > 80) return this.setTask('goto', this.heard.pos);
    if (this.task === 'goto' && this.path && t < (this.roamUntil || 0)) return;
    const foes = g.enemiesOf(this.c).map((c) => g.positionOf(c)).sort((p, q) => dist2(p, b.pos) - dist2(q, b.pos));
    let goal = null;
    if (foes.length && Math.random() < 0.7) {
      const p = foes[0];
      goal = g.nav.randomPointIn([p[0] - 500, p[1] - 500, p[2] - 200], [p[0] + 500, p[1] + 500, p[2] + 200])?.point;
    }
    goal ||= g.nav.randomPoint()?.point;
    if (goal) { this.roamUntil = t + 12; this.setTask('goto', goal); }
  }

  recentlySawEnemy(t, s) { return this.lastSeen && t - this.lastSeen.t < s; }
  get awper() { return /awp|ssg08|scar20|g3sg1/.test(this.bot.weapons?.primary?.id || ''); }
  // The bomb carrier on a site plants once it's seen no one for a moment; with the clock running out, at once (it used
  // to wait two and a half seconds after any glimpse of an enemy, and the round ran out).
  plantNow(t) { const m = this.game.match; return !!m.siteAt(this.bot.pos) && !this.target?.visible && !this.recentlySawEnemy(t, m.time < 25 ? 0.5 : 2.5); }

  // An enemy it was fighting got out of sight (back behind a corner, through a door): after a moment holding the angle
  // (they may peek again), it goes after them to where it last saw them, rather than giving the fight up. A higher rank
  // only when its team isn't outnumbered or they're hurt (a Silver whatever the odds); not an AWPer (it holds its angle),
  // not hurt itself, not the bomb carrier or one with a lineup to throw, not with the bomb down (the bomb comes first),
  // nor far. Decided once each time they get away (chase: the rank's chance). Returns where to go, or null.
  chaseTo(t) {
    const g = this.game, b = this.bot, tg = this.target, seen = this.lastSeen;
    if (!tg || tg.visible || !tg.c.alive || !seen || g.match.bomb?.state === 'planted' || this.c.hasC4 || tg.lostAt == null || this.throwing()) return null;
    const lost = t - tg.lostAt;
    if (lost < 0.6 || lost > 5) return null;
    if (this.chase?.c !== tg.c || this.chase.lostAt !== tg.lostAt) {
      let mates = 0, foes = 0;
      for (const x of g.combatants) if (x.alive) { if (x.team === this.c.team) mates++; else if (g.hostile(this.c, x)) foes++; }
      const worth = this.d.skill < 0.35 || mates >= foes || tg.c.health < 60;
      const go = !this.awper && this.c.health >= 35 && worth && dist2(seen.pos, b.pos) < 1400 && Math.random() < (this.d.chase ?? 0);
      this.chase = { c: tg.c, lostAt: tg.lostAt, go };
    }
    return this.chase.go && dist2(seen.pos, b.pos) > 60 ? seen.pos : null;
  }
  // A lineup of its own to throw (lining it up now, or a terrorist's for the hit once the default's over): it doesn't
  // go off after a fight first (the execute's smokes would never go out).
  throwing() {
    return this.task === 'lineup' || !!this.lineupFace || (this.c.team === 'T' && this.plan?.stage !== 'setup' && !!this.plan?.throws?.some((x) => x.by === this.c && !x.done));
  }
  // Going to see what it heard (see hear): footsteps for a few seconds after; a fight (gunfire) within reach for a while
  // longer. Not with the bomb down; neither the bomb carrier nor a bot with a lineup to throw leaves it for a fight.
  goSee(t) {
    const h = this.heard;
    if (!h?.peek || this.target?.visible || this.game.match.bomb?.state === 'planted' || (h.fight && (this.c.hasC4 || this.throwing()))) return false;
    const d = dist2(h.pos, this.bot.pos);
    return t - h.t < (h.fight ? FIGHT_GOES_ON : 3) && d > 120 && (!h.fight || d < 1800);
  }
  // Holding a spot (s: { pos, look, at }) with nothing going on (nothing seen or heard for a while): now and then a look
  // along the way the enemy would come, a few hundred units towards where they'd first show (s.at) and back: an info peek
  // from a CT's spot, a step out into the map for a pick from a default's. Every 9 to 18 s (a terrorist taking map
  // control, 6 to 12), by the rank's chance (probe); not an AWPer, not hurt, not while its team knows where they are (a
  // CT after the rotate call, while they've been seen there lately). Returns whether that's what it's doing.
  probing(t, s) {
    const g = this.game, b = this.bot, p = this.probe, every = () => (this.c.team === 'T' ? rnd(6, 12) : rnd(9, 18));
    // (A CT once its team has seen where they are: not while they're about the site the call was for, again once nothing's
    // been seen there for a while, a fake or a hit that's waiting.)
    const alert = this.c.team === 'CT' && !!this.plan?.rotate && this.contactAt(this.plan.rotate, t, ALERT) > 0;
    if (p) {
      if (!this.target?.visible && t < p.until && !alert) {
        if (p.there == null && dist2(p.to, b.pos) > 40 && !(this.closest && dist2(this.closest.goal, p.to) < 1 && dist2(this.closest.at, b.pos) < 40)) { this.setTask('goto', p.to); return true; }
        p.there ??= t;
        if (t - p.there < p.look) { this.task = 'hold'; this.path = null; this.holdYaw = p.yaw; this.holdPitch = p.pitch; return true; }
      }
      this.probe = null; this.probeAt = t + every(); this.holdYaw = null; this.holdPitch = null;
      return false;
    }
    if (!s?.at || this.task !== 'hold' || dist2(s.pos, b.pos) > 48) return false;
    // (The CTs' early push, when it's this one's round for it (plan.aggro, see strats.js): the first time, at once, further
    // out and for longer.)
    const push = this.c.team === 'CT' && this.plan?.aggro === this.c && !this.pushed;
    if (this.probeAt == null) { this.probeAt = t + (push ? rnd(0.3, 1.5) : rnd(4, 10)); return false; }
    if (t < this.probeAt) return false;
    this.probeAt = t + every();
    if (push) this.pushed = true;
    if (this.awper || this.c.health < 60 || alert || this.recentlySawEnemy(t, 6) || (this.heard && t - this.heard.t < 4) || !(push || Math.random() < (this.d.probe ?? 0))) return false;
    const pts = g.nav?.path(b.pos, [s.at[0], s.at[1], s.at[2] - 64])?.points;
    if (!pts || pts.length < 2) return false;
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const want = Math.min(push ? rnd(700, 1100) : rnd(250, 550), total - (push ? 120 : 200));
    if (want < 150) return false;
    let to = pts[pts.length - 1];
    for (let i = 1, run = 0; i < pts.length; i++) {
      const a = pts[i - 1], q = pts[i], l = Math.hypot(q[0] - a[0], q[1] - a[1]);
      if (run + l >= want) { const k = (want - run) / l; to = [a[0] + (q[0] - a[0]) * k, a[1] + (q[1] - a[1]) * k, a[2] + (q[2] - a[2]) * k]; break; }
      run += l;
    }
    const [pitch, yaw] = angleTo([to[0], to[1], to[2] + 64], s.at);
    const look = push ? rnd(5, 9) : rnd(1.2, 2.5);
    this.probe = { to: [to[0], to[1], to[2]], until: t + 3 + want / 150 + look, look, there: null, pitch, yaw };
    return this.probing(t, s);
  }
  // The lurker stays out on the other site's side until a few seconds into the execute (the CTs rotating out past it),
  // then comes on to the site behind them.
  lurking(plan, t) { return plan.lurk === this.c && this.game.match.time > 30 && !(plan.execStart != null && plan.stage === 'execute' && t > plan.execStart + this.lurkFor); }

  // A lineup (utility.js) for its plan: to the exact spot, still, the aim (off by its rank's error), and the throw when
  // its moment comes (now: at once; else smokes as the execute starts, molotovs just after, pop flashes last). Returns
  // whether that's what it's doing. until: when it's too late for it (else the first half minute for one thrown now).
  doLineup(x, t, now = false, until = null) {
    const g = this.game, b = this.bot, l = x.lineup, plan = this.plan;
    const late = until != null ? t > until : now ? t - g.liveAt > 30 : plan.stage === 'execute' && t - plan.execStart > 8;
    if (!(this.c.nades[x.nade] > 0) || late || b.pendingThrow?.lineup === l) { if (!b.pendingThrow) x.done = true; this.lineupFace = null; this.approach = null; return false; }
    const d = dist2(l.pos, b.pos);
    if (d > 40) { this.approach = null; this.lineupFace = null; this.setTask('goto', l.pos); return true; }
    // (Its last steps onto the spot: as near as it gets is near enough once it's got no nearer for a moment, a teammate
    // or a corner in the way. It stood there aimed until the throw was given up, the execute without its smoke.)
    if (this.approach !== l.pos || d < this.approachBest - 1) { this.approachBest = d; this.approachAt = t; }
    const blocked = t - this.approachAt > STUCK_LINEUP;
    this.task = 'lineup'; this.path = null; this.approach = l.pos; this.lining = true;
    this.lineupAim ||= [(Math.random() * 2 - 1) * this.d.utilityErr, (Math.random() * 2 - 1) * this.d.utilityErr];
    const aim = this.lineupFace = [l.pitch + this.lineupAim[0], l.yaw + this.lineupAim[1]];
    const ready = now || (plan.stage === 'execute' && t >= plan.execStart + [0, 0.5, 1.1][x.phase]);
    // Not into a smoke (a molotov goes straight out), nor a smoke onto its team's own fire (it would put it out): it
    // waits till that's gone, doing what it would otherwise meanwhile (an execute's goes on without it).
    if (ready && this.wastes(l.kind, l.land)) { if (!now) x.done = true; this.lineupAim = null; this.lineupFace = null; this.approach = null; return false; }
    if (d < 3 && Math.hypot(b.vel[0], b.vel[1]) < 8) { b.pos[0] = l.pos[0]; b.pos[1] = l.pos[1]; b.vel[0] = b.vel[1] = 0; } // (exactly on it)
    const still = (d < 3 || blocked) && Math.hypot(b.vel[0], b.vel[1]) < 8;
    const aimed = Math.abs(wrap(b.yaw - aim[1])) < 0.5 && Math.abs(b.pitch - aim[0]) < 0.5;
    if (ready && still && aimed && g.botThrowAim(b, x.nade, { pitch: aim[0], yaw: aim[1], strength: l.strength, jump: l.jump, lineup: l })) {
      x.done = true; x.thrownAt = t;
      this.lineupAim = null; this.lineupFace = null; this.approach = null;
      if (l.kind === 'flash' && plan.side === 'T') plan.flashAt = Math.max(plan.flashAt || 0, t + 0.55 + 1.65);
    }
    return true;
  }
  // Would a grenade landing there be wasted: a molotov in a smoke (it goes straight out, as in CS2), a smoke on its own
  // team's fire (it puts it out)?
  wastes(kind, at) {
    const nades = this.game.nades;
    return kind === 'fire' ? nades.smokedAt(at) : kind === 'smoke' ? !!nades.fireSmokedBy(at, this.c.team) : false;
  }
  siteCenter(site) { return site ? [(site.min[0] + site.max[0]) / 2, (site.min[1] + site.max[1]) / 2, site.min[2]] : null; }
  // A spot of its own to hold at a place this round (spots.js: some cover, facing a way in; key as there), kept for the
  // round: { pos, look: [pitch, yaw] }. Where nothing was worked out: fallback()'s point, facing as holdAt does.
  spotAt(key, fallback) {
    if (!this.spots[key]) {
      const awp = /awp|ssg08|scar20|g3sg1/.test(this.bot.weapons.primary?.id || '');
      this.spots[key] = this.game.spots?.pick(this.bot, key, { awp }) || { pos: fallback(), look: null };
    }
    return this.spots[key];
  }
  // Its own spot near where the team gathers for a site (coming in by one of its ways: see strats.js), watching the way
  // out of it. probe: a look out along it now and then (a default's spread, the lurker: see probing), not while the team
  // gathers to go in.
  holdGather(siteId, t, route = 0, probe = false) {
    const s = this.spotAt('gather:' + siteId + (route ? '/' + route : ''), () => {
      const p = this.game.spots?.staging(siteId, route) || stagingPoint(this.game, siteId);
      return this.game.nav.randomPointIn([p[0] - 260, p[1] - 260, p[2] - 120], [p[0] + 260, p[1] + 260, p[2] + 120])?.point || p;
    });
    if (probe && this.probing(t, s)) return;
    return this.holdAt(s.pos, t, this.siteCenter(this.game.map.info.bombsites.find((x) => x.site === siteId)), s.look);
  }
  // A default: spread out for map control (the lurker on the other site's way in, the entry in mid, the rest by both
  // sites' ways in), holding there until it's time to gather, with a step out for a pick now and then (see probing).
  setupHold(plan, role, t) {
    const g = this.game, p = plan.positions?.get(this.c);
    if (p) { const s = this.spotAt('pos:T:' + p.id, () => g.nav.randomPointIn([p.at[0] - 150, p.at[1] - 150, p.at[2] - 100], [p.at[0] + 150, p.at[1] + 150, p.at[2] + 100])?.point || p.at.slice()); if (this.probing(t, s)) return; return this.holdAt(s.pos, t, null, s.look); }
    const other = g.map.info.bombsites.map((x) => x.site).find((x) => x !== plan.site) || plan.site;
    if (role === 'entry' && g.midSpot) { const s = this.spotAt('mid:T', () => g.midSpot); if (this.probing(t, s)) return; return this.holdAt(s.pos, t, null, s.look); }
    return role === 'lurk' || !(this.bot.index % 2) ? this.holdGather(other, t, 0, true) : this.holdGather(plan.site, t, plan.route, true);
  }
  // When it goes onto the site in the execute (seconds after it starts): the entry first, as the pop flash bursts if
  // there is one, the rest a moment apart (closer at higher ranks, near enough to trade). A pop flash that isn't out
  // POP_WAIT s in (its thrower still on the way to its spot) isn't waited for any longer: they went in only once it was
  // out or given up on, eight seconds in, the team standing about at the site meanwhile.
  entryDelay(plan) {
    if (plan.rush) return (this.bot.index % 5) * 0.25;
    const pop = plan.throws?.some((x) => x.phase === 2 && !x.done && x.by.alive);
    const base = pop ? POP_WAIT : Math.min(POP_WAIT, Math.max(0.8, (plan.flashAt ?? 0) - (plan.execStart ?? 0) - 0.25));
    const k = plan.roles?.get(this.c) === 'entry' ? 0 : 1 + (this.bot.index % 4) * 0.6;
    return base + k * (1.2 - this.d.skill * 0.6);
  }
  // Where CTs gather to retake a planted site: about 700 units short of the bomb, on the way from their spawn.
  retakeSpot(bomb) {
    const key = 'retake' + (bomb.site || '');
    if (!this.spots[key]) {
      const g = this.game, pts = g.nav.path(ownSpawn(g, 'CT'), bomb.pos)?.points || [];
      let pt = pts[0] || bomb.pos, run = 0;
      for (let i = pts.length - 1; i > 0; i--) { run += dist2(pts[i], pts[i - 1]); if (run >= 700) { pt = pts[i - 1]; break; } }
      this.spots[key] = [pt[0], pt[1], pt[2]];
    }
    return this.spots[key];
  }
  // A CT seeing terrorists at a site: the team rotates there once enough show (one is enough for lower ranks; higher
  // ranks wait for two).
  reportContact(e) {
    const g = this.game, plan = this.plan;
    if (plan?.side !== 'CT') return;
    const p = g.bodyOf(e).feet;
    const site = g.map.info.bombsites.find((x) => p[0] > x.min[0] - 700 && p[0] < x.max[0] + 700 && p[1] > x.min[1] - 700 && p[1] < x.max[1] + 700);
    if (!site) return;
    plan.sightings?.set(e, { site: site.site, t: g.now }); // (who's been seen where, lately: see contactAt)
    if (plan.rotate) return;
    plan.contact ||= {};
    const seen = plan.contact[site.site] ||= new Set();
    seen.add(e);
    if (seen.size >= (this.d.skill > 0.5 ? 2 : 1)) {
      plan.rotate = site.site;
      g.radio?.say(this.c, 'needbackup', `They're ${site.site}! Rotate ${site.site}`);
    }
  }

  // A CT's site: its own, or the one the team rotates to (one anchor stays put at higher ranks).
  ctSite() {
    const plan = this.plan, assigned = plan.assign?.get(this.c) || 'A';
    const anchor = plan.rotate && assigned !== plan.rotate && this.d.skill > 0.6 && [...(plan.assign || [])].filter(([x, sg]) => sg === assigned && x.alive).length === 1;
    return plan.rotate && !anchor ? plan.rotate : assigned;
  }
  // How many terrorists (alive) the team has seen about a site in the last secs seconds.
  contactAt(site, t, secs) {
    let n = 0;
    for (const [e, s] of this.plan.sightings || []) if (e.alive && s.site === site && t - s.t < secs) n++;
    return n;
  }
  // Outnumbered on its site (three terrorists at least seen there in the last few seconds, two more than the CTs left
  // there): it falls back out of their way, short of the site on the way from its spawn (where the retake starts once
  // the bomb's down), and says so; back to its spot if they've gone (nothing seen there for a while). A Silver stays.
  // Returns { spot, face } while it does.
  fallBack(site, t, siteBox) {
    const g = this.game, box = siteBox(site);
    if (!box || this.d.skill < 0.35) return null;
    const center = this.siteCenter(box);
    if (this.fellBack) {
      if (this.fellBack.site === site && this.contactAt(site, t, 15) > 0) return this.fellBack;
      this.fellBack = null; this.holdYaw = null;
      return null;
    }
    const seen = this.contactAt(site, t, 5);
    if (seen < 3) return null;
    const cts = g.combatants.filter((x) => x.team === 'CT' && x.alive && dist2(g.positionOf(x), center) < 1100).length;
    if (seen < cts + 2) return null;
    this.fellBack = { site, spot: this.retakeSpot({ site, pos: center }), face: center };
    this.holdYaw = null;
    g.radio?.say(this.c, null, `They're ${seen} on ${site}, I'm falling back`);
    return this.fellBack;
  }
  // A retake's utility (lineups for 'retakeA'...): the next of the site's not thrown yet that it has the grenade for,
  // from a spot near enough (smokes before flashes). Returns whether that's what it's doing.
  retakeUtility(bomb, t) {
    const g = this.game, c = this.c, b = this.bot, plan = this.plan;
    plan.retakes ||= []; // (each lineup one bot's: { lineup, ..., thrownAt once it's out })
    if (!this.retakeX || this.retakeX.done) {
      const l = lineupsFor(g.lineups, 'CT', 'retake' + bomb.site).sort((x, y) => (x.kind === 'flash') - (y.kind === 'flash'))
        .find((x) => !plan.retakes.some((r) => r.lineup === x) && c.nades[nadeFor(x.kind, 'CT')] > 0 && dist2(x.pos, b.pos) < 900);
      if (!l) { this.retakeX = null; return false; }
      plan.retakes.push(this.retakeX = { lineup: l, nade: nadeFor(l.kind, 'CT'), phase: 0, done: false, until: t + 8 });
    }
    return this.doLineup(this.retakeX, t, true, this.retakeX.until);
  }
  // Grenades like CS2's bots use them: terrorists smoke off the CT side and flash before taking a site; anyone throws
  // a molotov or HE where they last saw enemies; retaking CTs flash the bomb, and smoke out a molotov on it; terrorists
  // burn a defuser. (None wasted: see wastes.)
  useNades(t, siteBox) {
    const g = this.game, m = g.match, b = this.bot, c = this.c, n = c.nades, bomb = m.bomb;
    const has = (id) => n[id] > 0;
    const go = (id, target, high = false) => {
      if (!has(id) || this.thrown.has(id + (target ? Math.round(target[0] / 400) : ''))) return false;
      if (g.botThrow(b, id, target, high)) { this.thrown.add(id + Math.round(target[0] / 400)); this.nadeAt = t + 1.2; return true; }
      return false;
    };
    const fire = has('weapon_molotov') ? 'weapon_molotov' : 'weapon_incgrenade';
    if (m.phase === 'live' && c.team === 'T' && this.plan.site) {
      const s = siteBox(this.plan.site);
      if (s) {
        const center = [(s.min[0] + s.max[0]) / 2, (s.min[1] + s.max[1]) / 2, s.min[2] + 10];
        const d = Math.hypot(center[0] - b.pos[0], center[1] - b.pos[1]);
        const ct = g.enemySpawnCenter('T');
        if (d < 1400 && d > 450 && !this.plan.smoked && has('weapon_smokegrenade')) {
          // Smoke between the site and where CTs come from.
          const k = 0.45, target = [center[0] + (ct[0] - center[0]) * k, center[1] + (ct[1] - center[1]) * k, center[2]];
          const spot = g.nav.findArea(target, 400) ? target : center;
          if (!this.wastes('smoke', spot) && go('weapon_smokegrenade', spot)) { this.plan.smoked = true; return; }
        }
        if (d < 1000 && d > 300 && !this.plan.flashed && has('weapon_flashbang')) {
          if (go('weapon_flashbang', [center[0], center[1], center[2] + 120], true)) { this.plan.flashed = true; return; }
        }
      }
    }
    // Enemies were just here (out of sight now): burn or blow up the spot.
    if (this.lastSeen && t - this.lastSeen.t < 2.5 && t - this.lastSeen.t > 0.4) {
      const d = Math.hypot(this.lastSeen.pos[0] - b.pos[0], this.lastSeen.pos[1] - b.pos[1]);
      if (d > 350 && d < 1500) { if ((!this.wastes('fire', this.lastSeen.pos) && go(fire, this.lastSeen.pos)) || go('weapon_hegrenade', this.lastSeen.pos)) return; }
    }
    if (m.phase === 'planted') {
      const d = Math.hypot(bomb.pos[0] - b.pos[0], bomb.pos[1] - b.pos[1]);
      // A fire on the bomb (a terrorist's molotov to stop the defuse): a smoke on it puts it out there and then.
      if (c.team === 'CT' && d < 1300 && d > 250 && g.nades.fireNear(bomb.pos) && g.lineOfSight(b.eye(), [bomb.pos[0], bomb.pos[1], bomb.pos[2] + 40]) && go('weapon_smokegrenade', bomb.pos)) return;
      if (c.team === 'CT' && d < 1200 && d > 400 && go('weapon_flashbang', [bomb.pos[0], bomb.pos[1], bomb.pos[2] + 100], true)) return;
      if (c.team === 'T' && bomb.defuser && d < 1300 && !this.wastes('fire', bomb.pos) && go(fire, bomb.pos)) return;
    }
  }

  // Runs away from the bomb (towards your own spawn), out of the blast.
  flee(from) {
    const b = this.bot, now = this.game.now;
    // On its way, it keeps going. One whose way ran out short of there (stuck, or no way all the way) looks again, once a
    // second, rather than standing in the blast.
    if (this.task === 'flee' && this.goal && (this.path || dist2(b.pos, this.goal) < 48 || now < Math.max(this.restUntil || 0, (this.fledAt ?? -Infinity) + 1))) return;
    this.fledAt = now;
    const home = this.game.enemySpawnCenter(this.c.team === 'T' ? 'CT' : 'T'); // your own spawn
    const away = this.game.nav.randomPointIn([home[0] - 400, home[1] - 400, home[2] - 200], [home[0] + 400, home[1] + 400, home[2] + 200]);
    const d = Math.hypot(b.pos[0] - from[0], b.pos[1] - from[1]);
    if (d > 2200) { this.task = 'hold'; return; }
    this.task = 'flee';
    this.goTo(away?.point || home);
  }

  // near: how close counts as there (see goTo).
  setTask(task, goal, near = 32) {
    const b = this.bot;
    if (task !== 'plant' && task !== 'defuse' && (b.mode === 'plant' || b.mode === 'defuse')) this.game.botCancelObjective(b);
    this.task = task;
    // A bot that couldn't get anywhere waits a moment before trying the same goal again.
    if (!goal || (this.game.now < this.restUntil && this.goal && dist2(goal, this.goal) <= 48)) return;
    if (!this.goal || dist2(goal, this.goal) > 48 || !this.path || (near < this.near && dist2(goal, this.goal) > near)) this.goTo(goal, near);
  }
  // Going for something lying about (a gun, a kit): for as long as getting there should take, then it gives up on it
  // for the round (it's somewhere it can't get to, or can't get near enough to pick up).
  fetching(it, t) {
    if (this.fetch?.it !== it) this.fetch = { it, until: t + 3 + dist2(it.pos, this.bot.pos) / 150 };
    if (t < this.fetch.until) return true;
    this.skip.add(it); this.fetch = null;
    return false;
  }

  // A spot in a bomb site: planting spot for the carrier, a holding spot otherwise (both kept for the round).
  siteSpot(site, kind) {
    const key = site.site + kind;
    this.spots ||= {};
    if (!this.spots[key]) {
      const g = this.game, m = g.match, bad = this.badPlant || [];
      // A planting spot has to be inside the bomb site's trigger (not up on a box above it), and well inside it, a body's
      // width from its edges where there's room, so stopping a little short of it (or sliding past it) is still in it;
      // not where it couldn't get onto one before.
      const inside = (p, k) => [[0, 0], [k, 0], [-k, 0], [0, k], [0, -k]].every(([x, y]) => !!m.siteAt([p[0] + x, p[1] + y, p[2]]));
      const plant = (k, avoid) => (a, p) => inside(p, k) && !(avoid && bad.some((q) => dist2(q, p) < 64));
      const r = kind !== 'plant' ? g.nav.randomPointIn(site.min, site.max)
        : g.nav.randomPointIn(site.min, site.max, plant(24, true)) || g.nav.randomPointIn(site.min, site.max, plant(0, true)) || g.nav.randomPointIn(site.min, site.max, plant(0, false));
      this.spots[key] = r ? r.point : [(site.min[0] + site.max[0]) / 2, (site.min[1] + site.max[1]) / 2, site.min[2]];
    }
    return this.spots[key];
  }
  // The carrier's planting spot (siteSpot): another one once it has stopped on (or as near as it gets to) this one and is
  // still outside the site (something in the way, a kerb or a crate).
  plantSpot(site) {
    const b = this.bot, key = site.site + 'plant', s = this.spots[key];
    if (s && !this.path && this.task === 'goto' && dist2(s, b.pos) < 48 && !this.game.match.siteAt(b.pos)) { (this.badPlant ||= []).push(s); delete this.spots[key]; }
    return this.siteSpot(site, 'plant');
  }
  // Holding a bomb site: the CTs' spots watch the terrorists' ways in (with a look out now and then: see probing), the
  // terrorists' (once they've taken it) the CTs'.
  holdIn(site, t, attacking) {
    if (!site) return;
    const s = this.spotAt((attacking ? 'push:' : 'hold:') + site.site, () => this.siteSpot(site, attacking ? 'push' : 'hold'));
    if (!attacking && this.probing(t, s)) return;
    this.holdAt(s.pos, t, attacking ? null : this.game.enemySpawnCenter(this.c.team), s.look);
  }
  // There, then still, facing look ([pitch, yaw]) or towards faceTo (else the enemy's spawn).
  holdAt(spot, t, faceTo = null, look = null) {
    const b = this.bot;
    const d = Math.hypot(spot[0] - b.pos[0], spot[1] - b.pos[1]);
    // (Someone on it: near enough. No way onto it: as near as there's a way to is.)
    const got = this.closest && dist2(this.closest.goal, spot) < 1 && dist2(this.closest.at, b.pos) < 40;
    if (d > 40 && !(d < 90 && this.occupied(spot)) && !got) return this.setTask('goto', spot);
    this.task = 'hold';
    if (this.holdYaw != null) return;
    if (look) { this.holdPitch = look[0]; this.holdYaw = look[1]; return; }
    const face = faceTo || this.game.enemySpawnCenter(this.c.team);
    this.holdYaw = (Math.atan2(face[1] - b.pos[1], face[0] - b.pos[0]) * 180) / Math.PI;
    this.holdPitch = null;
  }
  // Near something (the planted bomb for the terrorists: a spot of the site's that sees it, to stop a defuse).
  holdNear(pos, r, kind, t) {
    this.spots ||= {};
    const key = 'near' + kind, site = this.game.match.bomb?.site;
    if (!this.spots[key] || dist2(this.spots[key].pos, pos) > r * 1.5) {
      const s = kind === 'bomb' && site ? this.game.spots?.pick(this.bot, 'push:' + site, { see: pos, within: r * 1.8 }) : null;
      const p = s ? null : this.game.nav.randomPointIn([pos[0] - r, pos[1] - r, pos[2] - 100], [pos[0] + r, pos[1] + r, pos[2] + 100]);
      this.spots[key] = s || { pos: p ? p.point : pos.slice(), look: null };
      this.holdYaw = null; this.holdPitch = null;
    }
    const s = this.spots[key];
    this.holdAt(s.pos, t, kind === 'bomb' ? this.game.enemySpawnCenter(this.c.team) : pos, s.look);
  }

  // ---- movement over the nav mesh ---------------------------------------------------------------------------------
  // near: how close to the goal counts as there (closer for what it has to be right on: a planting spot, the bomb).
  goTo(goal, near = 32) {
    // Halfway up (or down) a ladder: the climb first, then this (a way from where it is would start inside the wall the
    // ladder is on, and it would stand there).
    if (this.bot.climbing && this.path?.[this.pi]?.ladder) { this.after = [goal.slice(), near]; return; }
    this.after = null;
    const p = this.game.nav.path(this.bot.pos, goal, true);
    this.goal = goal.slice();
    this.near = near;
    // No way there on the mesh (a spot on a box nobody gets onto): as near to it as there is a way to. No way anywhere (it's
    // somewhere off the mesh itself): straight at it.
    this.closest = p?.partial ? { goal: this.goal, at: p.points[p.points.length - 1] } : null;
    this.path = p ? p.points : [Object.assign(goal.slice(), { direct: true })];
    this.pi = 0;
    this.stuckT = 0;
    this.holdYaw = null; this.holdPitch = null;
  }

  move(dt, t, moving) {
    const g = this.game, b = this.bot, nav = g.nav;
    const gun = b.weapons[b.slot];
    if (this.climb(dt, moving)) return;
    const topSpeed = gun?.stats?.maxSpeed?.[gun.zoom > 0 ? 1 : 0] || 250;
    let max = topSpeed;
    if (b.ducked) max *= 0.34;
    else if (this.walking(t)) max *= 0.52;
    let want = [0, 0], wpZ = null, direct = false, counter = false;
    this.heading = null;
    if (moving && this.path && this.pi < this.path.length && this.task !== 'hold') {
      if (t >= (this.smoothAt || 0)) { this.smoothAt = t + 0.2; this.skipAhead(); }
      // (Up against something short of a way through for a moment, though: as near as it gets, on to the next point.)
      const held = t - (this.movedAt ?? t) > 0.3;
      let wp = this.path[this.pi];
      let dx = wp[0] - b.pos[0], dy = wp[1] - b.pos[1];
      let d = Math.hypot(dx, dy);
      while (d < 24 && !wp.ladder && !jumpAhead(wp, b) && !(!held && shortOf(wp, b, d)) && this.pi < this.path.length - 1) { this.pi++; wp = this.path[this.pi]; dx = wp[0] - b.pos[0]; dy = wp[1] - b.pos[1]; d = Math.hypot(dx, dy); }
      // Someone standing on the point it's making for (a teammate in a doorway, on its spot): as good as there.
      while (d < 80 && !wp.ladder && !jumpAhead(wp, b) && !(!held && shortOf(wp, b, d)) && this.pi < this.path.length - 1 && this.occupied(wp)) { this.pi++; wp = this.path[this.pi]; dx = wp[0] - b.pos[0]; dy = wp[1] - b.pos[1]; d = Math.hypot(dx, dy); }
      const last = this.pi >= this.path.length - 1;
      // There once it's close, and up on the same level: a goal on a box isn't reached from the foot of it, so it keeps
      // on (slowing down near it) into the box, which it then jumps onto.
      const below = last && (b.vel[2] !== 0 || wp[2] - b.pos[2] > STEP_HEIGHT) && d > 2;
      // Slowing down to arrive (moving like you, it slides a bit when it lets go).
      const s = below && d < 32 ? max * Math.max(0.35, d / 32) : last ? max * Math.min(1, Math.max(0.3, d / 96)) : max;
      if (jumpAhead(wp, b) && d < 40) {
        // At the foot of a jump: straight at the ledge (across the edge onto it, not along it towards the next point),
        // up against it, then up (and on that way in the air until it's on top).
        const [ix, iy] = wp.into || [dx / (d || 1), dy / (d || 1)];
        want = [ix * max, iy * max]; wpZ = wp[2] + wp.jump;
      } else if (d > (last ? this.near : 8) || below || (!held && shortOf(wp, b, d))) { want = [(dx / d) * s, (dy / d) * s]; wpZ = wp[2]; direct = !!wp.direct; } else if (last) this.path = null;
    } else if (this.approach && moving) {
      // The last few units onto a lineup's spot, slowing to stop on it.
      const dx = this.approach[0] - b.pos[0], dy = this.approach[1] - b.pos[1], d = Math.hypot(dx, dy);
      if (d > 0.5) want = [(dx / d) * Math.min(max * 0.6, d * 6), (dy / d) * Math.min(max * 0.6, d * 6)];
    } else if (this.target?.visible && b.weapons[b.slot]?.melee && moving) {
      const e = g.bodyOf(this.target.c).feet, dx = e[0] - b.pos[0], dy = e[1] - b.pos[1], d = Math.hypot(dx, dy);
      if (d > 30) want = [(dx / d) * max, (dy / d) * max];
    } else if (!moving && this.target?.visible && this.d.discipline > 0.35 && !b.airborne) {
      // Stopping to shoot: one that knows how counter-strafes (presses the other way, stopped in a tenth of a second
      // rather than sliding to a stop, its first shot inaccurate).
      const v = Math.hypot(b.vel[0], b.vel[1]);
      if (v > 40) { want = [(-b.vel[0] / v) * max, (-b.vel[1] / v) * max]; counter = true; }
    }
    // Low places (a vent, a hole in a wall: CS2's crouch-only nav areas, or a ceiling it would bump its head on just
    // ahead): it crouches to go in and under, and stands again once there's room (its movement only lets it up where it
    // fits: see below).
    const go0 = Math.hypot(want[0], want[1]);
    if (go0 > 0 && t >= (this.lowAt || 0)) {
      this.lowAt = t + 0.1;
      const wp = this.path?.[this.pi], prev = this.path && this.pi > 0 ? this.path[this.pi - 1] : null; // (no path once it has arrived)
      this.low = !!(wp?.crouch && Math.hypot(wp[0] - b.pos[0], wp[1] - b.pos[1]) < 120) || !!(prev?.crouch && Math.hypot(prev[0] - b.pos[0], prev[1] - b.pos[1]) < 64) || this.lowAhead(want[0] / go0, want[1] / go0);
      // And a breakable in the way (a vent cover over the hole it goes through, a shutter): it shoots it open, or slashes
      // it with the knife, like CS2's bots.
      const ahead = (n) => [b.pos[0] + (want[0] / go0) * n, b.pos[1] + (want[1] / go0) * n, b.pos[2] + 2], feet = ahead(0);
      const pane = g.doors?.paneAhead(feet, ahead(40));
      if (pane) this.breakPane(pane, t);
      // And a closed door: opened from as far off as you can.
      g.doors?.openAhead(feet, ahead(USE_RANGE));
    } else if (go0 === 0) this.low = false;
    if (!moving) b.ducked = this.target?.visible ? b.ducked : this.task === 'plant' || this.task === 'defuse';
    else if (!this.target?.visible) b.ducked = !!this.low;
    // Step out of fire.
    const burning = g.nades.fireNear(b.pos, 30);
    if (burning) {
      const dx = b.pos[0] - burning.pos[0], dy = b.pos[1] - burning.pos[1], d = Math.hypot(dx, dy) || 1;
      want = [(dx / d) * max, (dy / d) * max];
    }
    // Face where it's going, unless that's only a few units away (pushed around a point, it would swing round it).
    if ((want[0] || want[1]) && !counter && (!this.path || Math.hypot(this.path[this.pi][0] - b.pos[0], this.path[this.pi][1] - b.pos[1]) > 24 || burning)) this.heading = (Math.atan2(want[1], want[0]) * 180) / Math.PI;
    // (Other players block it like walls, without shoving: see Game.traceBodies. So it steers round them: see avoid.)
    if ((want[0] || want[1]) && !counter && !burning && this.path) this.avoid(want, t);
    // Off the mesh (pushed by a teammate, or heading straight for somewhere the mesh has no way to), or a drop with no
    // floor at all: don't go there.
    const speed = Math.hypot(want[0], want[1]);
    if (speed > 0) {
      const ax = b.pos[0] + (want[0] / speed) * 20, ay = b.pos[1] + (want[1] / speed) * 20;
      const drop = g.floorAt([ax, ay, b.pos[2]], 600) === null && g.floorAt([ax, ay, b.pos[2] + CROUCH_JUMP_HEIGHT], 700) === null; // (from above too: there may be a ledge)
      if (((wpZ === null || direct) && nav.groundAt(ax, ay, b.pos[2], CROUCH_JUMP_HEIGHT + 8) === null) || drop) want = [0, 0];
    }
    // Then it moves like you (movement.js), as if pressing keys towards where it wants to go: its body slides along
    // walls, walks up steps and stairs, can't get up into a ceiling, and falls off ledges. A ledge in the way up is
    // jumped onto (crouch-jumping the highest, the legs tucked once it's off the ground).
    const body = this.physics();
    const air = !body.onGround;
    let go = Math.hypot(want[0], want[1]), jump = false;
    // (Up onto a ledge the path climbs; or one it's up against and getting nowhere, that the mesh has nothing about: from
    // on top of a barrel up onto the crate beside it, whose lip is higher than a step.)
    if (go === 0 || air || Math.hypot(b.vel[0], b.vel[1]) >= 20) this.movedAt = t;
    const stalled = t - (this.movedAt ?? t) > 0.4;
    if (!air && go > 0 && wpZ !== null && (wpZ > b.pos[2] + STEP_HEIGHT / 2 || stalled) && t >= (this.jumpAt || 0) + 0.3) {
      const rise = this.ledgeAhead(want[0] / go, want[1] / go);
      if (rise) { jump = true; this.jumpAt = t; b.jumped = true; b.tuck = rise > JUMP_HEIGHT ? CROUCH_JUMP_HEIGHT - JUMP_HEIGHT : 0; }
      // Up against the foot of its path's jump and nothing there it could get onto (too high, an overhang over it): it
      // won't make it however often it tries (see below).
      else if (stalled && jumpAhead(this.path?.[this.pi] || {}, b)) this.cantJump = this.path[this.pi];
      // Caught on something it can't get onto or over (the corner of a post on its way past, pushed off its line by a
      // teammate: Nuke's T side outside): a moment along its face, the side nearer where it's going, as you'd sidestep.
      // (Twice at most on the way to a point: in a dead end the stuck handling below finds another way.)
      else if (stalled && !(t < this.sideUntil) && (this.sides || 0) < 2) {
        const ux = want[0] / go, uy = want[1] / go, n = g.collision.traceBox(b.pos, [b.pos[0] + ux * 4, b.pos[1] + uy * 4, b.pos[2]], [-16, -16, STEP_HEIGHT], [16, 16, 54], FLAG_PLAYER).normal;
        const sl = n && Math.abs(n[2]) < 0.7 ? Math.hypot(n[0], n[1]) : 0;
        if (sl) { const k = -n[1] * ux + n[0] * uy < 0 ? -1 : 1; this.side = [(-n[1] / sl) * k, (n[0] / sl) * k]; this.sideUntil = t + 0.3; this.sides = (this.sides || 0) + 1; }
      }
    }
    if (t < this.sideUntil && this.side && go > 0 && !jump) { want = [this.side[0] * max, this.side[1] * max]; go = max; }
    const tucking = !!b.tuck && air && t > this.jumpAt;
    const cmd = (this.cmd ||= {}); // (one each, filled in each tick)
    cmd.yaw = (Math.atan2(want[1], want[0]) * 180) / Math.PI; cmd.forward = Math.min(1, go / max); cmd.side = 0; cmd.pitch = 0;
    cmd.maxSpeed = topSpeed; cmd.walk = this.walking(t) && !b.ducked; cmd.duck = b.ducked || tucking; cmd.jump = jump; cmd.jumpPress = jump;
    body.tick(dt, cmd);
    if (body.velocity[2] < -3000) { const a = nav.nearestArea(body.origin); body.teleport([a.center[0], a.center[1], a.center[2]]); } // fell out of the map
    b.pos = body.origin.slice(); b.vel = body.velocity.slice();
    if (body.onGround && !jump) { if (b.tuck) b.ducked = false; b.jumped = false; b.tuck = 0; } // landed
    else if (tucking) b.ducked = true;
    if (body.ducked && body.onGround && !b.ducked) b.ducked = true; // (under a low ceiling: no room to stand yet)
    b.airborne = !body.onGround && (b.jumped || b.vel[2] < -120); // jumping, or falling for real (not a step down)
    // Stuck: find the way again; after a few tries, stand still a moment (rather than turning back and forth between
    // new paths) and then try again.
    if (moving && this.path && !b.climbing) {
      this.stuckT += dt;
      // Getting no nearer the point it's making for in 3 s is stuck too, though it moves: going back and forth under a
      // jump it keeps missing (into Nuke's vent from B), sliding off a ledge.
      const aim = this.path[this.pi];
      if (aim !== this.aimWp) { this.aimWp = aim; this.aimBest = Infinity; this.aimSince = this.aimGain = t; this.sides = 0; }
      const gap = aim ? Math.hypot(aim[0] - b.pos[0], aim[1] - b.pos[1], aim[2] - b.pos[2]) : 0;
      if (gap < this.aimBest - 8) { this.aimBest = gap; this.aimSince = this.aimGain = t; }
      const noHeadway = !!aim && t - this.aimSince > 3;
      if (noHeadway) this.aimSince = t;
      if (this.stuckT > 1 || noHeadway) {
        if (noHeadway) this.lastProgress = b.pos.slice(); // (counts as no progress below)
        if (dist2(b.pos, this.lastProgress) < 20 && this.goal && this.dodgeFor && t < this.dodgeUntil + 0.5 && this.dodgeFlips < 2) {
          // Held up by someone it was steering round: the other way round them, for longer (not a new path: it would be
          // the same one).
          this.dodge = -this.dodge; this.dodgeUntil = t + 1.2; this.dodgeFlips++;
        } else if (dist2(b.pos, this.lastProgress) < 20 && this.goal) {
          // Stuck below a jump it can't make (the nav mesh links a ledge that a crate, an overhang or a wall keeps you
          // off): every bot goes another way from now on.
          const wp = this.path[this.pi];
          if (this.pi >= this.path.length - 1 && dist2(b.pos, wp) < 40 && Math.abs(wp[2] - b.pos[2]) < STEP_HEIGHT) { this.path = null; this.stuckTries = 0; } // as near as it gets (a spot close to a wall): there
          else if ((this.stuckTries >= 1 || this.cantJump === wp) && wp?.jump && b.pos[2] < wp[2] + wp.jump - STEP_HEIGHT) { nav.failJump(wp); this.stuckTries = 0; this.goTo(this.goal, this.near); }
          // Stuck at the same way through again and again (a vent it can't get along, a gap something fills): every bot
          // goes round it for the rest of the round, if there's another way; else it stands a moment and tries again.
          else if (++this.stuckTries >= (t - (this.movedAt ?? t) > 0.9 ? 2 : 3)) { // (2: wedged, not moving at all)
            this.stuckTries = 0;
            // (And the way through before it, if it never got through that: it went on for this one from short of it.)
            const prev = this.pi > 0 && this.path[this.pi - 1];
            const ways = [wp?.link, prev?.cross && (b.pos[0] - prev[0]) * prev.cross[0] + (b.pos[1] - prev[1]) * prev.cross[1] < 0 && prev.link].filter((l) => l && !nav.blocked.has(l));
            for (const l of ways) nav.blocked.add(l);
            const other = ways.length && nav.path(b.pos, this.goal);
            if (other) this.goTo(this.goal, this.near);
            else { for (const l of ways) nav.blocked.delete(l); this.path = null; this.restUntil = t + 2 + Math.random() * 2; b.vel[0] = b.vel[1] = 0; }
          }
          else this.goTo(this.goal, this.near);
        } else if (t - this.aimGain < 1.5) { this.stuckTries = 0; this.dodgeFlips = 0; } // (getting somewhere)
        this.lastProgress = b.pos.slice();
        this.stuckT = 0;
      }
    }
  }

  // Steers want (its velocity) round whoever is just ahead in the way, as a player would: past on its right of someone
  // coming the other way (both do, so they pass), round the side with room of someone standing or going the same way;
  // the side kept a moment once chosen.
  avoid(want, t) {
    const g = this.game, b = this.bot, sp = Math.hypot(want[0], want[1]), ux = want[0] / sp, uy = want[1] / sp;
    let best = null, bd = 90;
    for (const c of g.combatants) {
      if (c === this.c || !c.alive) continue;
      const p = c === g.me ? g.player.origin : g.botOf(c)?.pos;
      if (!p || Math.abs(p[2] - b.pos[2]) > 64) continue;
      const dx = p[0] - b.pos[0], dy = p[1] - b.pos[1], ahead = dx * ux + dy * uy, left = dy * ux - dx * uy;
      if (ahead <= 0 || ahead >= bd || Math.abs(left) > 40) continue; // (two hulls 32 wide: within 40 to the side is in the way)
      best = { c, ahead, left }; bd = ahead;
    }
    if (!best) { this.dodgeFor = null; return; }
    if (this.dodgeFor !== best.c || t > this.dodgeUntil) {
      const v = best.c === g.me ? g.player.velocity : g.botOf(best.c).vel;
      let side = v[0] * ux + v[1] * uy < -40 ? -1 : best.left > 0 ? -1 : 1; // (-1 its right, 1 its left)
      const room = (k) => {
        const x = b.pos[0] - uy * k * 40 + ux * 16, y = b.pos[1] + ux * k * 40 + uy * 16;
        return g.nav.groundAt(x, y, b.pos[2], STEP_HEIGHT, 40) !== null
          && g.collision.traceBox([b.pos[0], b.pos[1], b.pos[2] + 20], [x, y, b.pos[2] + 20], [-16, -16, 0], [16, 16, 50], FLAG_PLAYER).fraction >= 1;
      };
      if (!room(side) && room(-side)) side = -side;
      if (this.dodgeFor !== best.c) this.dodgeFlips = 0;
      this.dodge = side; this.dodgeFor = best.c; this.dodgeUntil = t + 0.6;
    }
    const k = Math.min(1.2, 0.3 + (90 - best.ahead) / 50), nx = ux - uy * this.dodge * k, ny = uy + ux * this.dodge * k, nl = Math.hypot(nx, ny);
    want[0] = (nx / nl) * sp; want[1] = (ny / nl) * sp;
  }
  // Someone else (alive) standing on a point.
  occupied(p) {
    const g = this.game;
    for (const c of g.combatants) {
      if (c === this.c || !c.alive) continue;
      const q = c === g.me ? g.player.origin : g.botOf(c)?.pos;
      if (q && Math.hypot(q[0] - p[0], q[1] - p[1]) < 36 && Math.abs(q[2] - p[2]) < 60) return true;
    }
    return false;
  }

  // Is there a low ceiling just ahead (a vent, a hole in a wall): standing it would bump into it, crouched it goes on?
  lowAhead(dx, dy) {
    const c = this.game.collision, p = this.bot.pos, a = [p[0], p[1], p[2] + 2], e = [p[0] + dx * 36, p[1] + dy * 36, p[2] + 2];
    const stand = c.traceBox(a, e, [-16, -16, 0], [16, 16, 72], FLAG_PLAYER);
    if (!stand.normal || stand.startsolid) return false;
    const duck = c.traceBox(a, e, [-16, -16, 0], [16, 16, 54], FLAG_PLAYER);
    return !duck.normal || duck.fraction > stand.fraction + 0.25;
  }

  // Breaks a breakable that's in its way: a shot at it (aimed straight at it, it's right there), or with no bullets (or
  // a knife out) a slash.
  breakPane(pane, t) {
    const g = this.game, b = this.bot, gun = b.weapons[b.slot];
    const [p, y] = angleTo(b.eye(), pane.center);
    b.pitch = p; b.yaw = y;
    if (gun && !gun.melee && !gun.reloading && gun.clip > 0) { if (t >= gun.nextAttack) g.botShoot(b, gun, t, 1); return; }
    if (t < (this.slashAt || 0)) return;
    this.slashAt = t + 0.5;
    g.specAnim?.(b, 'lightHit');
    g.botSound(b, 'Weapon_Knife.Hit', 0.8);
    g.doors.breakPane(pane, pane.center, [Math.cos((y * Math.PI) / 180), Math.sin((y * Math.PI) / 180), 0]);
  }

  // The bot's movement (yours: see movement.js) at where the bot is. Anything else that put it somewhere (a spawn, a
  // ladder) or stopped it (planting, bot_stop) is taken over first.
  physics() {
    const b = this.bot, c = this.game.collision;
    if (this.body?.world.of !== c) {
      const w = this.game.bodyWorld(() => this.c);
      this.body = new PlayerMovement({ of: c, traceBox: w.traceBox, boxOverlap: (min, max, mask, dynamic) => c.boxOverlap(min, max, mask, dynamic), ladders: NO_LADDERS }, b.pos);
    }
    const m = this.body;
    if (m.origin[0] !== b.pos[0] || m.origin[1] !== b.pos[1] || m.origin[2] !== b.pos[2]) m.teleport(b.pos);
    const v = m.velocity; // (its own copy, as it was: bots move every tick)
    v[0] = b.vel[0]; v[1] = b.vel[1]; v[2] = b.vel[2];
    return m;
  }

  // How far up the ledge right in front (direction dx, dy; up against it, as you jump onto one: in the air you can
  // hardly speed up towards it) is, if it's one to jump onto: higher than a step, no higher than a crouch-jump, with
  // room to stand on it. Or, with nothing to stand on just past it and the floor beyond as low as here, something low
  // across the way to jump over (a pipe, a kerb higher than a step: on Nuke outside, bots stood against one): how high
  // it is, if a jump clears it and there's floor past it. 0 otherwise.
  ledgeAhead(dx, dy) {
    const g = this.game, [x, y, z] = this.bot.pos;
    const tr = g.collision.traceBox([x, y, z], [x + dx * 6, y + dy * 6, z], [-16, -16, STEP_HEIGHT], [16, 16, 70], FLAG_PLAYER);
    if (tr.fraction >= 1 || tr.startsolid || !tr.normal || Math.abs(tr.normal[2]) > 0.7) return 0;
    const nl = Math.hypot(tr.normal[0], tr.normal[1]);
    if ((tr.normal[0] * dx + tr.normal[1] * dy) / nl > -0.5) return 0; // a wall it's going along, not at
    // Its top, from above where the body would stand on it (part of it over the edge, as you can).
    const top = (k) => g.collision.traceBox([tr.endpos[0] + dx * k, tr.endpos[1] + dy * k, z + CROUCH_JUMP_HEIGHT + 2], [tr.endpos[0] + dx * k, tr.endpos[1] + dy * k, z + STEP_HEIGHT], [-16, -16, 0], [16, 16, 54], FLAG_PLAYER);
    const down = top(24);
    if (!down.startsolid && down.fraction > 0.01 && down.fraction < 1 && down.normal?.[2] >= 0.7) {
      const rise = down.endpos[2] - z;
      if (rise > STEP_HEIGHT && rise <= CROUCH_JUMP_HEIGHT) return rise;
    }
    const over = top(4), rise = over.endpos[2] - z;
    if (over.startsolid || over.fraction <= 0.01 || over.fraction >= 1 || rise <= STEP_HEIGHT || rise > CROUCH_JUMP_HEIGHT - 2) return 0;
    const clear = g.collision.traceBox([x, y, z + rise + 2], [x + dx * 48, y + dy * 48, z + rise + 2], [-16, -16, 0], [16, 16, 54], FLAG_PLAYER);
    return clear.fraction >= 1 && !clear.startsolid && g.floorAt([x + dx * 48, y + dy * 48, z + rise], 64 + rise) !== null ? rise : 0;
  }

  // String pulling: the path runs through the middles of the nav areas' shared edges (a zig-zag), so head for the
  // furthest of the next waypoints the bot can walk straight to (its body fits all the way, the ground is there with no
  // drop or gap). It then walks, and faces, in straight lines and turns at real corners. Never past a ladder or a jump.
  skipAhead() {
    const b = this.bot, g = this.game, p = this.path;
    let best = this.pi;
    for (let k = this.pi + 1; k < Math.min(p.length, this.pi + 6); k++) {
      if (p[k].ladder || p[k - 1].ladder || p[k + 1]?.ladder || (k - 1 > this.pi && (p[k - 1].jump || p[k - 1].crouch))) break; // (not past a jump or into a crawl)
      if (!this.walkable(b.pos, p[k])) break;
      best = k;
    }
    this.pi = best;
  }
  walkable(from, to) {
    const g = this.game, nav = g.nav;
    const d = Math.hypot(to[0] - from[0], to[1] - from[1]);
    if (d < 1) return true;
    if (Math.abs(to[2] - from[2]) > 64) return false;
    // The ground all the way, without drops, gaps or anything higher than a step (every 24 units).
    let z = from[2];
    for (let s = 24; s < d; s += 24) {
      const x = from[0] + ((to[0] - from[0]) * s) / d, y = from[1] + ((to[1] - from[1]) * s) / d;
      const h = nav.groundAt(x, y, z, STEP_HEIGHT, STEP_HEIGHT);
      if (h === null) return false;
      z = h;
    }
    // The body fits standing (from knee to head height, so steps and stairs don't count, but a low ceiling does).
    const tr = g.collision.traceBox([from[0], from[1], from[2] + 20], [to[0], to[1], Math.max(from[2], to[2]) + 20], [-15, -15, 0], [15, 15, 52], FLAG_PLAYER);
    return tr.fraction >= 1 && !tr.startsolid;
  }

  // Ladders: at the foot (or the top) of one on the path, go straight up (or down) the rungs at CS2's climbing
  // speed, facing the ladder. Returns true while the bot is on a ladder.
  climb(dt, moving) {
    const b = this.bot, wp = this.path?.[this.pi];
    if (!wp?.ladder) { b.climbing = null; return false; }
    const n = wp.ladder.normal;
    if (!b.climbing && Math.hypot(wp[0] - b.pos[0], wp[1] - b.pos[1]) > 24) return false;
    b.climbing = wp.ladder;
    b.ducked = false;
    b.yaw = (Math.atan2(-n[1], -n[0]) * 180) / Math.PI;
    if (!moving) { b.vel = [0, 0, 0]; return true; }
    // (Up, it climbs till its feet are level with the floor it steps off onto: a ladder's top can be short of it, Nuke's
    // vent ladder by 25 units, more than a step.)
    const next = wp.up && this.path[this.pi + 1], topZ = next ? Math.max(wp[2], next[2] + 1) : wp[2];
    const off = next && Math.abs(topZ - b.pos[2]) < 48 && next;
    // A breakable over the way off the top (Nuke's vent slats, climbing up from B): broken from the ladder first, or it
    // would step off into it and fall back down.
    const pane = off && this.game.doors?.paneAhead([wp[0], wp[1], wp[2] + 2], [off[0], off[1], off[2] + 2]);
    if (pane) { this.breakPane(pane, this.game.now); b.vel = [0, 0, 0]; return true; }
    // And with the way off low (Nuke's vent mouth), crouched to go through it, as you'd duck at the top.
    if (off) { const dx = off[0] - b.pos[0], dy = off[1] - b.pos[1], l = Math.hypot(dx, dy) || 1; if (off.crouch || this.lowAhead(dx / l, dy / l)) b.ducked = true; }
    const dz = topZ - b.pos[2];
    if (next && Math.abs(dz) < 1) {
      // At the top: over the edge onto the floor it steps off onto, as the ladder takes you over, not off the ladder
      // back down the hole it came up.
      const hx = next[0] - b.pos[0], hy = next[1] - b.pos[1], hl = Math.hypot(hx, hy);
      if (hl > 4 && this.game.floorAt(b.pos, 8) == null) {
        const st = Math.min(hl, 120 * dt);
        b.pos[0] += (hx / hl) * st; b.pos[1] += (hy / hl) * st; b.vel = [0, 0, 0];
        return true;
      }
      this.pi++; b.climbing = null; b.vel = [0, 0, 0];
      this.climbed();
      return true;
    }
    const step = Math.sign(dz) * Math.min(Math.abs(dz), 156 * dt);
    b.pos[0] += (wp[0] - b.pos[0]) * Math.min(1, dt * 8);
    b.pos[1] += (wp[1] - b.pos[1]) * Math.min(1, dt * 8);
    b.pos[2] += step;
    b.vel = [0, 0, step / dt];
    if (Math.abs(dz) < 1) { this.pi++; b.climbing = null; b.vel = [0, 0, 0]; this.climbed(); }
    return true;
  }

  // Off the ladder: where it was sent meanwhile (see goTo).
  climbed() { if (this.after) { const [goal, near] = this.after; this.after = null; this.goTo(goal, near); } }

  // Walking (quietly, as you'd hold shift) while holding, and for a few seconds after seeing an enemy; not in a rush, a
  // retake against the clock or on its way to trade a teammate.
  walking(t) { return !this.plan?.rush && !this.retaking && !(this.trade && t < this.trade.until) && (this.task === 'hold' || (this.lastSeen && t - this.lastSeen.t < 4 && !this.target?.visible)); }
}

export { setOf };
