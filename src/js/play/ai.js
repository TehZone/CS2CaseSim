// Bot brains: what CS2's bots do in a competitive round. Terrorists pick a bomb site, walk there over the nav mesh and
// plant; counter-terrorists split up to hold the sites and rotate on contact; after the plant both teams play the bomb
// (retake and defuse). In a fight a bot reacts after a human-like delay, turns towards the enemy with limited speed,
// its aim error shrinking as it tracks, stops to shoot, controls part of the recoil and fires in bursts.
// Bots buy by their money like CS2's bots (eco, force, full buy, an AWP now and then). Your teammates follow your
// radio commands (radio.js): go to a site, rush, follow you, hold, regroup, fall back, cover you.
import { FLAG_BULLET, FLAG_PLAYER } from './collision.js';
import { Gun } from './weapons.js';
import { setOf } from './bots.js';
import { PlayerMovement } from './movement.js';
import { STEP_HEIGHT, JUMP_HEIGHT, CROUCH_JUMP_HEIGHT } from './nav.js';

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
const NO_LADDERS = new Set(); // bots climb ladders on their paths themselves (climb)

// A bot's gun (same data and recoil tables as yours, without a viewmodel).
export function botGun(id, stats, sounds) {
  const g = new Gun({ slot: id === 'weapon_knife' || /knife/.test(id) ? 'knife' : 'x', id, name: id, stats: stats || {}, sounds, vm: null });
  g.punch = [0, 0]; g.punchVel = [0, 0];
  return g;
}

export class Brain {
  constructor(game, bot, level = 'normal') {
    this.game = game;
    this.bot = bot;
    this.d = DIFFICULTY[level] || DIFFICULTY.normal;
    this.path = null; this.pi = 0; this.goal = null;
    this.target = null; this.lastSeen = null; this.heard = null;
    this.nextThink = 0; this.nextScan = (bot.index % 4) * (1 / 64);
    this.stuckT = 0; this.lastProgress = [0, 0, 0]; this.stuckTries = 0; this.restUntil = 0;
    this.heading = null; // where it means to go (degrees), which it faces while moving
    this.task = 'idle'; // goto | hold | plant | defuse | pickup | hunt
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
  }

  // A radio command from you (your teammates only).
  obey(kind, { pos, target, t }) {
    const b = this.bot;
    if (kind === 'spotted') { this.heard = { pos: target, t }; this.nextScan = t; return; }
    this.path = null; this.goal = null; this.holdYaw = null; this.spots = {}; this.nextThink = t; this.startDelay = 0;
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
        } else { this.task = 'hold'; this.path = null; this.holdYaw = g.input.yaw + (b.index % 2 ? 35 : -35); }
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
  buy(pistolRound) {
    const g = this.game, c = this.c, m = g.match, st = g.stats;
    const take = (id) => { if (m.canBuy(c, id, st)) { m.pay(c, id, st); if (id.startsWith('weapon_')) g.giveBot(this.bot, id); return true; } return false; };
    if (pistolRound) {
      if (c.team === 'T' || Math.random() < 0.5) take('vest'); else if (Math.random() < 0.6) take('defuser');
      if (Math.random() < 0.25) take(Math.random() < 0.5 ? 'weapon_p250' : c.team === 'T' ? 'weapon_tec9' : 'weapon_fiveseven');
      return;
    }
    const has = this.bot.weapons.primary;
    const rifle = c.team === 'T' ? 'weapon_ak47' : Math.random() < 0.5 ? 'weapon_m4a1' : 'weapon_m4a1_silencer';
    const full = (st[rifle]?.price || 2900) + 1000;
    if (!has) {
      if (c.money >= 4750 + 1000 && Math.random() < 0.18) take('weapon_awp');
      else if (c.money >= full) take(rifle);
      else if (c.money >= 2600 && g.match.lossStreak[c.team] >= 2) take(c.team === 'T' ? 'weapon_galilar' : 'weapon_famas') || take(c.team === 'T' ? 'weapon_mac10' : 'weapon_mp9');
      else if (c.money >= 1300 && Math.random() < 0.35) take('weapon_deagle') || take('weapon_p250');
    }
    if (this.bot.weapons.primary || c.money >= 2500) take('vesthelm') || take('vest');
    if (c.team === 'CT' && Math.random() < 0.7) take('defuser');
    // Grenades with what's left.
    if (this.bot.weapons.primary) {
      const fire = c.team === 'T' ? 'weapon_molotov' : 'weapon_incgrenade';
      for (const [id, p] of [['weapon_flashbang', 0.65], ['weapon_smokegrenade', 0.5], [fire, 0.4], ['weapon_hegrenade', 0.35], ['weapon_flashbang', 0.3]]) {
        if (Math.random() < p && c.money >= (st[id]?.price || 300) + 200) take(id);
      }
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
    this.move(dt, t, moving);
    if (!this.target?.visible && b.mode === 'move') this.look(dt, t);
  }

  // Keeps the current gun reloaded and switched to the best one.
  updateGun(dt, t) {
    const b = this.bot, gun = b.weapons[b.slot];
    for (const w of Object.values(b.weapons)) {
      if (!w?.punch) continue;
      const e = Math.exp(-6 * dt);
      w.punch[0] = w.punch[0] * e + w.punchVel[0] * dt; w.punch[1] = w.punch[1] * e + w.punchVel[1] * dt;
      w.punchVel[0] *= Math.exp(-8 * dt); w.punchVel[1] *= Math.exp(-8 * dt);
      w.penalty *= Math.exp(-dt * 2.3 / Math.max(0.1, w.stats.recoveryStand || 0.4));
      if (t > w.lastShot + 0.4) w.recoilIndex *= Math.exp(-dt * 6);
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
    const [aimP, aimY] = [b.pitch, b.yaw];
    const fwd = [Math.cos((aimY * Math.PI) / 180), Math.sin((aimY * Math.PI) / 180)];
    let best = null, bestD = Infinity;
    for (const e of g.enemiesOf(this.c)) {
      const body = g.bodyOf(e);
      const d = Math.hypot(body.chest[0] - eye[0], body.chest[1] - eye[1], body.chest[2] - eye[2]);
      if (d > 4500) continue;
      const to = [(body.chest[0] - eye[0]) / d, (body.chest[1] - eye[1]) / d];
      const inView = to[0] * fwd[0] + to[1] * fwd[1] > Math.cos(((this.d.fov / 2) * Math.PI) / 180) || d < 220 || this.hurtBy === e;
      if (!inView) continue;
      const seen = [body.head, body.chest].find((p) => g.canSee(eye, p));
      // Stick with the enemy it's fighting unless another is clearly closer (two at about the same distance would
      // otherwise swap every scan, the aim flicking between them).
      const dd = this.target?.c === e && this.target.visible ? d * 0.7 : d;
      if (seen && dd < bestD) { best = { c: e, point: seen, d }; bestD = dd; }
    }
    if (best) {
      g.spot(best.c, this.c);
      if (!this.target || this.target.c !== best.c) {
        this.target = { c: best.c, since: t, react: t + rnd(...this.d.reaction) * (this.target?.c === best.c ? 0.3 : 1), shots: 0, pauseUntil: 0 };
        const a = Math.random() * Math.PI * 2;
        this.aimErr = [Math.sin(a) * this.d.aimErr, Math.cos(a) * this.d.aimErr * 1.4];
        this.aimHead = Math.random() < this.d.head;
        this.crouchFight = Math.random() < 0.25 && best.d > 900;
      }
      if (!this.target.visible && t - (this.target.calledAt ?? -99) > 6) { this.target.calledAt = t; g.radio.chatter(this.c, 'spotted', { where: g.placeOf(best.c) ? 'at ' + g.placeOf(best.c).replace(/([a-z])([A-Z])/g, '$1 $2') : '' }); }
      this.target.visible = true;
      this.target.dist = best.d;
      this.lastSeen = { pos: g.bodyOf(best.c).feet.slice(), t };
      g.callout(this.c, best.c);
    } else if (this.target?.visible) {
      this.target.visible = false;
      this.target.lostAt = t;
    }
    if (this.target && !this.target.c.alive) this.target = null;
  }

  // Someone shot at us or a gun went off nearby.
  hear(pos, loud, t) {
    if (this.target?.visible) return;
    const d = Math.hypot(pos[0] - this.bot.pos[0], pos[1] - this.bot.pos[1]);
    if (d > loud * this.d.hear) return;
    this.heard = { pos: pos.slice(), t };
  }
  hurt(attacker, t) {
    this.hurtBy = attacker;
    if (!this.target?.visible && attacker) { this.heard = { pos: this.game.bodyOf(attacker).feet.slice(), t }; this.nextScan = t; }
  }

  // ---- fighting ---------------------------------------------------------------------------------------------------
  // Aims at the target and shoots. Returns whether the bot should keep moving.
  fight(dt, t) {
    const g = this.game, b = this.bot, tg = this.target;
    const body = g.bodyOf(tg.c);
    const eye = b.eye();
    const aimAt = this.aimHead ? body.head : body.chest;
    const [p, y] = angleTo(eye, aimAt);
    const k = Math.exp(-dt * 2.2);
    this.aimErr[0] *= k; this.aimErr[1] *= k;
    this.turnTo(p + this.aimErr[0], y + this.aimErr[1], dt, 1);
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
    const tol = Math.max(0.6, Math.min(5, (Math.atan(10 / Math.max(1, tg.dist)) * 180) / Math.PI));
    const onTarget = Math.abs(wrap(b.yaw - y)) < tol + Math.abs(this.aimErr[1]) && Math.abs(b.pitch - p) < tol + Math.abs(this.aimErr[0]);
    if (t >= tg.react && t >= tg.pauseUntil && onTarget && t >= gun.nextAttack && gun.clip > 0 && !g.teammateInLine(b, aimAt) && !g.cv?.bot_dont_shoot) {
      const auto = gun.stats.fullAuto;
      const burst = tg.dist < 600 ? this.d.burst * 3 : tg.dist < 1500 ? this.d.burst : Math.max(1, Math.round(this.d.burst / 2));
      g.botShoot(b, gun, t, this.d.control);
      tg.shots++;
      if (!auto) gun.nextAttack = Math.max(gun.nextAttack, t + rnd(0.08, 0.25) + (tg.dist > 1200 ? 0.15 : 0));
      if (tg.shots >= burst) { tg.shots = 0; tg.pauseUntil = t + rnd(0.2, 0.45); }
    }
    // Stand still to shoot accurately (counter-strafing); keep moving if it's a knife fight.
    return false;
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
    if (this.lastSeen && t - this.lastSeen.t < 4) { const [p, y] = angleTo(b.eye(), [this.lastSeen.pos[0], this.lastSeen.pos[1], this.lastSeen.pos[2] + 60]); this.turnTo(p, y, dt, 0.7); return; }
    if (this.heard && t - this.heard.t < 3) { const [p, y] = angleTo(b.eye(), [this.heard.pos[0], this.heard.pos[1], this.heard.pos[2] + 60]); this.turnTo(p, y, dt, 0.6); return; }
    if (this.task === 'hold' && this.holdYaw != null && Math.hypot(b.vel[0], b.vel[1]) < 20) { this.glance(dt, t, this.holdYaw, 15, 0.2); return; }
    // Moving: face the way it's going (the path, not its velocity, which teammates shoving past and walls jostle).
    if (this.heading != null && Math.hypot(b.vel[0], b.vel[1]) > 30) this.turnTo(0, this.heading, dt, 0.5);
  }
  // Freeze time: still, the odd glance either side of the heading it spawned with.
  lookAround(dt, t) {
    this.baseYaw ??= this.bot.yaw;
    this.glance(dt, t, this.baseYaw, 8, 0.1);
  }
  // Standing still like a player: aim steady at an angle, and every few seconds maybe a small glance to one side (eased,
  // then still again), not a constant sweep.
  glance(dt, t, base, spread, rate) {
    if (t >= this.glanceAt) {
      this.glanceAt = t + 3 + Math.random() * 4;
      this.glanceOff = Math.random() < 0.5 ? 0 : (Math.random() * 2 - 1) * spread;
    }
    this.turnTo(0, base + this.glanceOff, dt, rate);
  }

  // ---- objectives -------------------------------------------------------------------------------------------------
  decide(t) {
    const g = this.game, m = g.match, b = this.bot, c = this.c, bomb = m.bomb;
    if (t - g.liveAt < this.startDelay) return;
    if (this.target?.visible && !this.target.c.alive) this.target = null;
    if (g.respawnMode) return this.hunt(t);
    const siteBox = (s) => g.map.info.bombsites.find((x) => x.site === s);
    if (!this.target?.visible && t >= this.nadeAt) this.useNades(t, siteBox);
    if (this.followOrder(t)) return;
    // No rifle? Grab one lying nearby.
    if (!b.weapons.primary && !this.target?.visible && (bomb.state !== 'planted' || c.team === 'T')) {
      const loot = g.drops.list.filter((it) => it.id !== 'defuser' && !/^weapon_(glock|usp_silencer|hkp2000|elite|p250|tec9|fiveseven|cz75a|deagle|revolver)$/.test(it.id) && !g.nades.inFire(it.pos))
        .map((it) => ({ it, d: Math.hypot(it.pos[0] - b.pos[0], it.pos[1] - b.pos[1]) })).filter((x) => x.d < 700).sort((x, y) => x.d - y.d)[0];
      if (loot) return this.setTask('goto', loot.it.pos);
    }
    // A CT without a kit picks one up lying nearby.
    if (c.team === 'CT' && !c.defuser && !this.target?.visible) {
      const kit = g.drops.list.find((it) => it.id === 'defuser' && Math.hypot(it.pos[0] - b.pos[0], it.pos[1] - b.pos[1]) < 600);
      if (kit) return this.setTask('goto', kit.pos);
    }
    if (c.team === 'T') {
      if (bomb.state === 'dropped' && g.nearestTo(bomb.pos, 'T') === c) return this.setTask('pickup', bomb.pos);
      if (bomb.state === 'planted') {
        // Get clear before it goes off.
        if (m.rules.bombTime - (g.now - bomb.plantedAt) < 9) return this.flee(bomb.pos);
        return this.holdNear(bomb.pos, 500, 'bomb', t);
      }
      const site = siteBox(this.plan.site || 'A');
      if (c.hasC4 && site) {
        if (!this.calledSite && Math.hypot(site.min[0] - b.pos[0], site.min[1] - b.pos[1]) < 2200) { this.calledSite = true; g.radio.chatter(c, 'goingToPlant', { site: site.site }); }
        if (m.siteAt(b.pos) && !this.recentlySawEnemy(t, 2.5)) { this.setTask('plant'); g.botPlant(b, t); return; }
        return this.setTask('goto', this.siteSpot(site, 'plant'));
      }
      if (this.plan.lurk === c && m.time > 35) return this.holdIn(siteBox(this.plan.site === 'A' ? 'B' : 'A') || site, t, true);
      return this.holdIn(site, t, true);
    }
    // CT
    if (bomb.state === 'planted') {
      const d = Math.hypot(bomb.pos[0] - b.pos[0], bomb.pos[1] - b.pos[1], bomb.pos[2] - b.pos[2]);
      const timeLeft = m.rules.bombTime - (g.now - bomb.plantedAt);
      const need = c.defuser ? m.rules.defuseKitTime : m.rules.defuseTime;
      if (d < 50 && (!this.recentlySawEnemy(t, 1.5) || timeLeft < need + 1.5) && timeLeft > need - 0.3) { this.setTask('defuse'); g.botDefuse(b, t); return; }
      // Too late to get there and defuse: save yourself.
      if (b.mode !== 'defuse' && timeLeft < need + d / 230 - 0.5) return this.flee(bomb.pos);
      if (bomb.defuser && bomb.defuser !== c) return this.holdNear(bomb.pos, 350, 'cover', t);
      return this.setTask('goto', bomb.pos);
    }
    const site = this.plan.rotate || this.plan.assign?.get(c) || 'A';
    if (site === 'mid' && g.midSpot) return this.holdAt(g.midSpot, t);
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

  // Grenades like CS2's bots use them: terrorists smoke off the CT side and flash before taking a site; anyone throws
  // a molotov or HE where they last saw enemies; retaking CTs flash the bomb; terrorists burn a defuser.
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
          if (go('weapon_smokegrenade', spot)) { this.plan.smoked = true; return; }
        }
        if (d < 1000 && d > 300 && !this.plan.flashed && has('weapon_flashbang')) {
          if (go('weapon_flashbang', [center[0], center[1], center[2] + 120], true)) { this.plan.flashed = true; return; }
        }
      }
    }
    // Enemies were just here (out of sight now): burn or blow up the spot.
    if (this.lastSeen && t - this.lastSeen.t < 2.5 && t - this.lastSeen.t > 0.4) {
      const d = Math.hypot(this.lastSeen.pos[0] - b.pos[0], this.lastSeen.pos[1] - b.pos[1]);
      if (d > 350 && d < 1500) { if (go(fire, this.lastSeen.pos) || go('weapon_hegrenade', this.lastSeen.pos)) return; }
    }
    if (m.phase === 'planted') {
      const d = Math.hypot(bomb.pos[0] - b.pos[0], bomb.pos[1] - b.pos[1]);
      if (c.team === 'CT' && d < 1200 && d > 400 && go('weapon_flashbang', [bomb.pos[0], bomb.pos[1], bomb.pos[2] + 100], true)) return;
      if (c.team === 'T' && bomb.defuser && d < 1300 && go(fire, bomb.pos)) return;
    }
  }

  // Runs away from the bomb (towards your own spawn), out of the blast.
  flee(from) {
    const b = this.bot;
    if (this.task === 'flee' && this.goal) return;
    const home = this.game.enemySpawnCenter(this.c.team === 'T' ? 'CT' : 'T'); // your own spawn
    const away = this.game.nav.randomPointIn([home[0] - 400, home[1] - 400, home[2] - 200], [home[0] + 400, home[1] + 400, home[2] + 200]);
    const d = Math.hypot(b.pos[0] - from[0], b.pos[1] - from[1]);
    if (d > 2200) { this.task = 'hold'; return; }
    this.task = 'flee';
    this.goTo(away?.point || home);
  }

  setTask(task, goal) {
    const b = this.bot;
    if (task !== 'plant' && task !== 'defuse' && (b.mode === 'plant' || b.mode === 'defuse')) this.game.botCancelObjective(b);
    this.task = task;
    // A bot that couldn't get anywhere waits a moment before trying the same goal again.
    if (!goal || (this.game.now < this.restUntil && this.goal && dist2(goal, this.goal) <= 48)) return;
    if (!this.goal || dist2(goal, this.goal) > 48 || !this.path) this.goTo(goal);
  }

  // A spot in a bomb site: planting spot for the carrier, a holding spot otherwise (both kept for the round).
  siteSpot(site, kind) {
    const key = site.site + kind;
    this.spots ||= {};
    if (!this.spots[key]) {
      // A planting spot has to be inside the bomb site's trigger (not up on a box above it).
      const r = this.game.nav.randomPointIn(site.min, site.max, (a, p) => kind !== 'plant' || !!this.game.match.siteAt(p));
      this.spots[key] = r ? r.point : [(site.min[0] + site.max[0]) / 2, (site.min[1] + site.max[1]) / 2, site.min[2]];
    }
    return this.spots[key];
  }
  holdIn(site, t, attacking) {
    if (!site) return;
    const spot = this.siteSpot(site, attacking ? 'push' : 'hold');
    this.holdAt(spot, t, attacking ? null : this.game.enemySpawnCenter(this.c.team));
  }
  holdAt(spot, t, faceTo = null) {
    const b = this.bot;
    const d = Math.hypot(spot[0] - b.pos[0], spot[1] - b.pos[1]);
    if (d > 40) return this.setTask('goto', spot);
    this.task = 'hold';
    const face = faceTo || this.game.enemySpawnCenter(this.c.team);
    if (this.holdYaw == null) this.holdYaw = (Math.atan2(face[1] - b.pos[1], face[0] - b.pos[0]) * 180) / Math.PI;
  }
  holdNear(pos, r, kind, t) {
    this.spots ||= {};
    const key = 'near' + kind;
    if (!this.spots[key] || dist2(this.spots[key], pos) > r * 1.5) {
      const p = this.game.nav.randomPointIn([pos[0] - r, pos[1] - r, pos[2] - 100], [pos[0] + r, pos[1] + r, pos[2] + 100]);
      this.spots[key] = p ? p.point : pos.slice();
      this.holdYaw = null;
    }
    this.holdAt(this.spots[key], t, kind === 'bomb' ? this.game.enemySpawnCenter(this.c.team) : pos);
  }

  // ---- movement over the nav mesh ---------------------------------------------------------------------------------
  goTo(goal) {
    const p = this.game.nav.path(this.bot.pos, goal);
    this.goal = goal.slice();
    this.path = p ? p.points : [Object.assign(goal.slice(), { direct: true })]; // no way there on the mesh: straight at it
    this.pi = 0;
    this.stuckT = 0;
    this.holdYaw = null;
  }

  move(dt, t, moving) {
    const g = this.game, b = this.bot, nav = g.nav;
    const gun = b.weapons[b.slot];
    if (this.climb(dt, moving)) return;
    let max = gun?.stats?.maxSpeed?.[0] || 250;
    if (b.ducked) max *= 0.34;
    else if (this.walking(t)) max *= 0.52;
    let want = [0, 0], wpZ = null, direct = false;
    this.heading = null;
    if (moving && this.path && this.pi < this.path.length && this.task !== 'hold') {
      if (t >= (this.smoothAt || 0)) { this.smoothAt = t + 0.2; this.skipAhead(); }
      let wp = this.path[this.pi];
      let dx = wp[0] - b.pos[0], dy = wp[1] - b.pos[1];
      let d = Math.hypot(dx, dy);
      const under = (p) => p.jump && b.pos[2] < p[2] + p.jump - STEP_HEIGHT; // a jump there it hasn't made yet
      while (d < 24 && !wp.ladder && !under(wp) && this.pi < this.path.length - 1) { this.pi++; wp = this.path[this.pi]; dx = wp[0] - b.pos[0]; dy = wp[1] - b.pos[1]; d = Math.hypot(dx, dy); }
      const last = this.pi >= this.path.length - 1;
      // There once it's close, and up on the same level: a goal on a box isn't reached from the foot of it, so it keeps
      // on (slowing down near it) into the box, which it then jumps onto.
      const below = last && (b.vel[2] !== 0 || wp[2] - b.pos[2] > STEP_HEIGHT) && d > 2;
      // Slowing down to arrive (moving like you, it slides a bit when it lets go).
      const s = below && d < 32 ? max * Math.max(0.35, d / 32) : last ? max * Math.min(1, Math.max(0.3, d / 96)) : max;
      if (under(wp) && d < 40) {
        // At the foot of a jump: straight at the ledge (across the edge onto it, not along it towards the next point),
        // up against it, then up (and on that way in the air until it's on top).
        const [ix, iy] = wp.into || [dx / (d || 1), dy / (d || 1)];
        want = [ix * max, iy * max]; wpZ = wp[2] + wp.jump;
      } else if (d > (last ? 32 : 8) || below) { want = [(dx / d) * s, (dy / d) * s]; wpZ = wp[2]; direct = !!wp.direct; } else if (last) this.path = null;
    } else if (this.target?.visible && b.weapons[b.slot]?.melee && moving) {
      const e = g.bodyOf(this.target.c).feet, dx = e[0] - b.pos[0], dy = e[1] - b.pos[1], d = Math.hypot(dx, dy);
      if (d > 30) want = [(dx / d) * max, (dy / d) * max];
    }
    if (!moving) b.ducked = this.target?.visible ? b.ducked : this.task === 'plant' || this.task === 'defuse';
    else if (!this.target?.visible) b.ducked = false;
    // Step out of fire.
    const burning = g.nades.fireNear(b.pos, 30);
    if (burning) {
      const dx = b.pos[0] - burning.pos[0], dy = b.pos[1] - burning.pos[1], d = Math.hypot(dx, dy) || 1;
      want = [(dx / d) * max, (dy / d) * max];
    }
    // Face where it's going, unless that's only a few units away (pushed around a point, it would swing round it).
    if ((want[0] || want[1]) && (!this.path || Math.hypot(this.path[this.pi][0] - b.pos[0], this.path[this.pi][1] - b.pos[1]) > 24 || burning)) this.heading = (Math.atan2(want[1], want[0]) * 180) / Math.PI;
    // Keep apart from teammates and you (only when actually bumping into them; it doesn't change where it faces).
    for (const o of g.bodies()) {
      if (o.c === this.c || !o.c.alive) continue;
      const dx = b.pos[0] - o.feet[0], dy = b.pos[1] - o.feet[1], d = Math.hypot(dx, dy);
      if (d < 32 && d > 0.01 && Math.abs(b.pos[2] - o.feet[2]) < 60) { const k = 90 * (1 - d / 32) + 30; want[0] += (dx / d) * k; want[1] += (dy / d) * k; }
    }
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
    const air = !body.onGround, go = Math.hypot(want[0], want[1]);
    let jump = false;
    if (!air && go > 0 && wpZ !== null && wpZ > b.pos[2] + STEP_HEIGHT / 2 && t >= (this.jumpAt || 0) + 0.3) {
      const rise = this.ledgeAhead(want[0] / go, want[1] / go);
      if (rise) { jump = true; this.jumpAt = t; b.jumped = true; b.tuck = rise > JUMP_HEIGHT ? CROUCH_JUMP_HEIGHT - JUMP_HEIGHT : 0; }
    }
    const tucking = !!b.tuck && air && t > this.jumpAt;
    body.tick(dt, {
      yaw: (Math.atan2(want[1], want[0]) * 180) / Math.PI, forward: Math.min(1, go / max), side: 0, pitch: 0,
      maxSpeed: gun?.stats?.maxSpeed?.[0] || 250, walk: this.walking(t) && !b.ducked, duck: b.ducked || tucking, jump, jumpPress: jump,
    });
    if (body.velocity[2] < -3000) { const a = nav.nearestArea(body.origin); body.teleport([a.center[0], a.center[1], a.center[2]]); } // fell out of the map
    b.pos = body.origin.slice(); b.vel = body.velocity.slice();
    if (body.onGround && !jump) { if (b.tuck) b.ducked = false; b.jumped = false; b.tuck = 0; } // landed
    else if (tucking) b.ducked = true;
    b.airborne = !body.onGround && (b.jumped || b.vel[2] < -120); // jumping, or falling for real (not a step down)
    // Stuck: find the way again; after a few tries, stand still a moment (rather than turning back and forth between
    // new paths) and then try again.
    if (moving && this.path && !b.climbing) {
      this.stuckT += dt;
      if (this.stuckT > 1) {
        if (dist2(b.pos, this.lastProgress) < 20 && this.goal) {
          // Stuck below a jump it can't make (the nav mesh links a ledge that a crate, an overhang or a wall keeps you
          // off): every bot goes another way from now on.
          const wp = this.path[this.pi];
          if (this.pi >= this.path.length - 1 && dist2(b.pos, wp) < 40 && Math.abs(wp[2] - b.pos[2]) < STEP_HEIGHT) { this.path = null; this.stuckTries = 0; } // as near as it gets (a spot close to a wall): there
          else if (this.stuckTries >= 1 && wp?.link && b.pos[2] < wp[2] + wp.jump - STEP_HEIGHT) { nav.failed.add(wp.link); this.stuckTries = 0; this.goTo(this.goal); }
          else if (++this.stuckTries >= 3) { this.path = null; this.stuckTries = 0; this.restUntil = t + 2 + Math.random() * 2; b.vel[0] = b.vel[1] = 0; }
          else this.goTo(this.goal);
        } else this.stuckTries = 0;
        this.lastProgress = b.pos.slice();
        this.stuckT = 0;
      }
    }
  }

  // The bot's movement (yours: see movement.js) at where the bot is. Anything else that put it somewhere (a spawn, a
  // ladder) or stopped it (planting, bot_stop) is taken over first.
  physics() {
    const b = this.bot, c = this.game.collision;
    if (this.body?.world.of !== c) this.body = new PlayerMovement({ of: c, traceBox: (...a) => c.traceBox(...a), ladders: NO_LADDERS }, b.pos);
    const m = this.body;
    if (m.origin[0] !== b.pos[0] || m.origin[1] !== b.pos[1] || m.origin[2] !== b.pos[2]) m.teleport(b.pos);
    m.velocity = b.vel.slice();
    return m;
  }

  // How far up the ledge right in front (direction dx, dy; up against it, as you jump onto one: in the air you can
  // hardly speed up towards it) is, if it's one to jump onto: higher than a step, no higher than a crouch-jump, with
  // room to stand on it. 0 otherwise.
  ledgeAhead(dx, dy) {
    const g = this.game, [x, y, z] = this.bot.pos;
    const tr = g.collision.traceBox([x, y, z], [x + dx * 6, y + dy * 6, z], [-16, -16, STEP_HEIGHT], [16, 16, 70], FLAG_PLAYER);
    if (tr.fraction >= 1 || tr.startsolid || !tr.normal || Math.abs(tr.normal[2]) > 0.7) return 0;
    const nl = Math.hypot(tr.normal[0], tr.normal[1]);
    if ((tr.normal[0] * dx + tr.normal[1] * dy) / nl > -0.5) return 0; // a wall it's going along, not at
    // Its top, from above where the body would stand on it (part of it over the edge, as you can).
    const px = tr.endpos[0] + dx * 24, py = tr.endpos[1] + dy * 24;
    const down = g.collision.traceBox([px, py, z + CROUCH_JUMP_HEIGHT + 2], [px, py, z + STEP_HEIGHT], [-16, -16, 0], [16, 16, 54], FLAG_PLAYER);
    if (down.startsolid || down.fraction <= 0.01 || down.fraction >= 1 || !down.normal || down.normal[2] < 0.7) return 0;
    const rise = down.endpos[2] - z;
    return rise > STEP_HEIGHT && rise <= CROUCH_JUMP_HEIGHT ? rise : 0;
  }

  // String pulling: the path runs through the middles of the nav areas' shared edges (a zig-zag), so head for the
  // furthest of the next waypoints the bot can walk straight to (its body fits all the way, the ground is there with no
  // drop or gap). It then walks, and faces, in straight lines and turns at real corners. Never past a ladder or a jump.
  skipAhead() {
    const b = this.bot, g = this.game, p = this.path;
    let best = this.pi;
    for (let k = this.pi + 1; k < Math.min(p.length, this.pi + 6); k++) {
      if (p[k].ladder || p[k - 1].ladder || p[k + 1]?.ladder || (k - 1 > this.pi && p[k - 1].jump)) break;
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
    // The body fits (from knee to head height, so steps and stairs don't count).
    const tr = g.collision.traceBox([from[0], from[1], from[2] + 20], [to[0], to[1], Math.max(from[2], to[2]) + 20], [-15, -15, 0], [15, 15, 40], FLAG_PLAYER);
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
    const dz = wp[2] - b.pos[2], step = Math.sign(dz) * Math.min(Math.abs(dz), 156 * dt);
    b.pos[0] += (wp[0] - b.pos[0]) * Math.min(1, dt * 8);
    b.pos[1] += (wp[1] - b.pos[1]) * Math.min(1, dt * 8);
    b.pos[2] += step;
    b.vel = [0, 0, step / dt];
    if (Math.abs(dz) < 1) { this.pi++; b.climbing = null; b.vel = [0, 0, 0]; }
    return true;
  }

  walking(t) { return !this.plan?.rush && (this.task === 'hold' || (this.lastSeen && t - this.lastSeen.t < 6 && !this.target?.visible)); }
}

// Team plans for a round: the T site and lurker, the CT split.
export function teamPlan(game, side) {
  const bots = game.bots.filter((b) => b.c.team === side);
  const have = game.map.info.bombsites.map((s) => s.site);
  if (side === 'T') {
    const site = have[Math.floor(Math.random() * have.length)] || 'A';
    const lurk = bots.length >= 4 ? bots[Math.floor(Math.random() * bots.length)].c : null;
    return { site, lurk: lurk?.hasC4 ? null : lurk };
  }
  const assign = new Map();
  const order = bots.map((b) => b.c).sort(() => Math.random() - 0.5);
  const n = order.length;
  const two = have.includes('B') ? 'B' : have[0] || 'A';
  const mid = game.midSpot ? 'mid' : Math.random() < 0.5 ? 'A' : two;
  const layout = n >= 5 ? ['A', 'A', two, two, mid] : n === 4 ? ['A', 'A', two, two] : n === 3 ? ['A', two, mid] : n === 2 ? ['A', two] : [Math.random() < 0.5 ? 'A' : two];
  order.forEach((c, i) => assign.set(c, layout[i % layout.length]));
  return { assign };
}

export { setOf };
