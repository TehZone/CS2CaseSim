// Bot brains: what CS2's bots do in a competitive round. Terrorists pick a bomb site, walk there over the nav mesh and
// plant; counter-terrorists split up to hold the sites and rotate on contact; after the plant both teams play the bomb
// (retake and defuse). In a fight a bot reacts after a human-like delay, turns towards the enemy with limited speed,
// its aim error shrinking as it tracks, stops to shoot, controls part of the recoil and fires in bursts.
// Bots buy by their money like CS2's bots (eco, force, full buy, an AWP now and then).
import { FLAG_BULLET } from './collision.js';
import { Gun } from './weapons.js';
import { setOf } from './bots.js';

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
    this.stuckT = 0; this.lastProgress = [0, 0, 0];
    this.task = 'idle'; // goto | hold | plant | defuse | pickup | hunt
  }

  get c() { return this.bot.c; }

  roundStart(plan) {
    this.plan = plan || {};
    this.path = null; this.goal = null; this.target = null; this.lastSeen = null; this.heard = null;
    this.task = 'idle';
    this.holdYaw = null;
    this.startDelay = rnd(0, 1.5);
    this.walkUntil = 0;
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
  }

  // ---- per tick ---------------------------------------------------------------------------------------------------
  tick(dt, t) {
    const g = this.game, b = this.bot, c = this.c;
    if (!c.alive) return;
    const phase = g.match.phase;
    this.updateGun(dt, t);
    if (phase === 'freeze') { b.vel = [0, 0, 0]; this.lookAround(dt, t); return; }
    if (t >= this.nextScan) { this.nextScan = t + 3 / 64; this.scan(t); }
    if (t >= this.nextThink) { this.nextThink = t + 0.25; this.decide(t); }
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
    if (want !== b.slot && !gun?.reloading) this.game.botSwitch(b, want, t);
    if (gun && !gun.melee && !gun.reloading && gun.clip < gun.stats.clip && gun.reserve > 0 && (gun.clip === 0 || (!this.target?.visible && gun.clip < gun.stats.clip * 0.4 && t > (this.target?.lostAt || 0) + 1.5))) {
      gun.reloading = true;
      gun.reloadEnd = t + (RELOAD_TIME[gun.stats.type] || 2.5);
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
      const seen = [body.head, body.chest].find((p) => g.lineOfSight(eye, p));
      if (seen && d < bestD) { best = { c: e, point: seen }; bestD = d; }
    }
    if (best) {
      g.spot(best.c, this.c);
      if (!this.target || this.target.c !== best.c) {
        this.target = { c: best.c, since: t, react: t + rnd(...this.d.reaction) * (this.target?.c === best.c ? 0.3 : 1), shots: 0, pauseUntil: 0 };
        const a = Math.random() * Math.PI * 2;
        this.aimErr = [Math.sin(a) * this.d.aimErr, Math.cos(a) * this.d.aimErr * 1.4];
        this.aimHead = Math.random() < this.d.head;
        this.crouchFight = Math.random() < 0.25 && bestD > 900;
      }
      this.target.visible = true;
      this.target.dist = bestD;
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
    if (!gun || gun.reloading) { b.ducked = false; return tg.dist < 600; }
    if (gun.melee) {
      // Run at them with the knife and slash when close.
      if (tg.dist < 70 && t >= gun.nextAttack && t >= tg.react) { gun.nextAttack = t + 0.5; g.botKnife(b, tg.c, gun); }
      return true;
    }
    b.ducked = this.crouchFight;
    const tol = Math.max(0.6, Math.min(5, (Math.atan(10 / Math.max(1, tg.dist)) * 180) / Math.PI));
    const onTarget = Math.abs(wrap(b.yaw - y)) < tol + Math.abs(this.aimErr[1]) && Math.abs(b.pitch - p) < tol + Math.abs(this.aimErr[0]);
    if (t >= tg.react && t >= tg.pauseUntil && onTarget && t >= gun.nextAttack && gun.clip > 0) {
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
    if (this.lastSeen && t - this.lastSeen.t < 4) { const [p, y] = angleTo(b.eye(), [this.lastSeen.pos[0], this.lastSeen.pos[1], this.lastSeen.pos[2] + 60]); this.turnTo(p, y, dt, 0.7); return; }
    if (this.heard && t - this.heard.t < 3) { const [p, y] = angleTo(b.eye(), [this.heard.pos[0], this.heard.pos[1], this.heard.pos[2] + 60]); this.turnTo(p, y, dt, 0.6); return; }
    if (this.task === 'hold' && this.holdYaw != null && Math.hypot(b.vel[0], b.vel[1]) < 20) {
      const sweep = Math.sin(t * 0.7 + b.index) * 25;
      this.turnTo(0, this.holdYaw + sweep, dt, 0.25);
      return;
    }
    const sp = Math.hypot(b.vel[0], b.vel[1]);
    if (sp > 30) this.turnTo(0, (Math.atan2(b.vel[1], b.vel[0]) * 180) / Math.PI, dt, 0.5);
  }
  lookAround(dt, t) { this.turnTo(0, this.bot.yaw + Math.sin(t * 0.5 + this.bot.index) * 0.3, dt, 0.1); }

  // ---- objectives -------------------------------------------------------------------------------------------------
  decide(t) {
    const g = this.game, m = g.match, b = this.bot, c = this.c, bomb = m.bomb;
    if (t - g.liveAt < this.startDelay) return;
    if (this.target?.visible && !this.target.c.alive) this.target = null;
    const siteBox = (s) => g.map.info.bombsites.find((x) => x.site === s);
    if (c.team === 'T') {
      if (bomb.state === 'dropped' && g.nearestTo(bomb.pos, 'T') === c) return this.setTask('pickup', bomb.pos);
      if (bomb.state === 'planted') {
        // Get clear before it goes off.
        if (m.rules.bombTime - (g.now - bomb.plantedAt) < 9) return this.flee(bomb.pos);
        return this.holdNear(bomb.pos, 500, 'bomb', t);
      }
      const site = siteBox(this.plan.site || 'A');
      if (c.hasC4 && site) {
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

  recentlySawEnemy(t, s) { return this.lastSeen && t - this.lastSeen.t < s; }

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
    if (goal && (!this.goal || dist2(goal, this.goal) > 48 || !this.path)) this.goTo(goal);
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
    this.path = p ? p.points : [goal.slice()];
    this.pi = 0;
    this.stuckT = 0;
    this.holdYaw = null;
  }

  move(dt, t, moving) {
    const g = this.game, b = this.bot, nav = g.nav;
    const gun = b.weapons[b.slot];
    let max = gun?.stats?.maxSpeed?.[0] || 250;
    if (b.ducked) max *= 0.34;
    else if (this.walking(t)) max *= 0.52;
    let want = [0, 0], wpZ = null;
    if (moving && this.path && this.pi < this.path.length && this.task !== 'hold') {
      let wp = this.path[this.pi];
      let dx = wp[0] - b.pos[0], dy = wp[1] - b.pos[1];
      let d = Math.hypot(dx, dy);
      while (d < 24 && this.pi < this.path.length - 1) { this.pi++; wp = this.path[this.pi]; dx = wp[0] - b.pos[0]; dy = wp[1] - b.pos[1]; d = Math.hypot(dx, dy); }
      if (d > 8) { want = [(dx / d) * max, (dy / d) * max]; wpZ = wp[2]; } else if (this.pi >= this.path.length - 1) this.path = null;
    } else if (this.target?.visible && b.weapons[b.slot]?.melee && moving) {
      const e = g.bodyOf(this.target.c).feet, dx = e[0] - b.pos[0], dy = e[1] - b.pos[1], d = Math.hypot(dx, dy);
      if (d > 30) want = [(dx / d) * max, (dy / d) * max];
    }
    if (!moving) b.ducked = this.target?.visible ? b.ducked : this.task === 'plant' || this.task === 'defuse';
    else if (!this.target?.visible) b.ducked = false;
    // Keep apart from teammates and you.
    for (const o of g.bodies()) {
      if (o.c === this.c || !o.c.alive) continue;
      const dx = b.pos[0] - o.feet[0], dy = b.pos[1] - o.feet[1], d = Math.hypot(dx, dy);
      if (d < 36 && d > 0.01 && Math.abs(b.pos[2] - o.feet[2]) < 60) { want[0] += (dx / d) * 120; want[1] += (dy / d) * 120; }
    }
    const k = 1 - Math.exp(-dt * 9);
    b.vel[0] += (want[0] - b.vel[0]) * k;
    b.vel[1] += (want[1] - b.vel[1]) * k;
    const nx = b.pos[0] + b.vel[0] * dt, ny = b.pos[1] + b.vel[1] * dt;
    const h = nav.heightAt(nx, ny, b.pos[2] + 20);
    if (h === null && wpZ === null) {
      // Off the mesh (e.g. pushed by a teammate): don't go there.
      b.vel[0] *= 0.3; b.vel[1] *= 0.3;
    } else if (h === null) {
      // Crossing between two areas (a seam, a step up or a drop): follow the path, easing towards its height.
      b.pos[0] = nx; b.pos[1] = ny;
      const dz = wpZ - b.pos[2];
      if (dz > 0) b.pos[2] += Math.min(dz, 400 * dt);
      else { b.vel[2] -= 800 * dt; b.pos[2] = Math.max(wpZ, b.pos[2] + b.vel[2] * dt); if (b.pos[2] === wpZ) b.vel[2] = 0; }
    } else {
      b.pos[0] = nx; b.pos[1] = ny;
      if (h < b.pos[2] - 3) { b.vel[2] -= 800 * dt; b.pos[2] = Math.max(h, b.pos[2] + b.vel[2] * dt); if (b.pos[2] === h) b.vel[2] = 0; }
      else { b.pos[2] = h; b.vel[2] = 0; }
    }
    // Stuck: find the way again.
    if (moving && this.path) {
      this.stuckT += dt;
      if (this.stuckT > 1) {
        if (dist2(b.pos, this.lastProgress) < 20 && this.goal) this.goTo(this.goal);
        this.lastProgress = b.pos.slice();
        this.stuckT = 0;
      }
    }
  }
  walking(t) { return this.task === 'hold' || (this.lastSeen && t - this.lastSeen.t < 6 && !this.target?.visible); }
}

// Team plans for a round: the T site and lurker, the CT split.
export function teamPlan(game, side) {
  const bots = game.bots.filter((b) => b.c.team === side);
  if (side === 'T') {
    const site = Math.random() < 0.5 ? 'A' : 'B';
    const lurk = bots.length >= 4 ? bots[Math.floor(Math.random() * bots.length)].c : null;
    return { site, lurk: lurk?.hasC4 ? null : lurk };
  }
  const assign = new Map();
  const order = bots.map((b) => b.c).sort(() => Math.random() - 0.5);
  const n = order.length;
  const layout = n >= 5 ? ['A', 'A', 'B', 'B', 'mid'] : n === 4 ? ['A', 'A', 'B', 'B'] : n === 3 ? ['A', 'B', 'mid'] : n === 2 ? ['A', 'B'] : ['A'];
  order.forEach((c, i) => assign.set(c, layout[i % layout.length]));
  return { assign };
}

export { setOf };
