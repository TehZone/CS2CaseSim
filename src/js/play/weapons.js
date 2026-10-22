// Your weapons in Play mode, following CS2's weapon data (scripts/weapons.vdata from your install): fire rate, magazine,
// damage with range falloff and armor, inaccuracy (standing, crouching, moving, in the air, firing) with recovery, the
// spread pattern, and recoil generated from each weapon's recoil seed the way Source does (aim punch with its
// decay, plus view punch). Angles are in degrees with Source's signs: positive pitch looks down, positive yaw turns left.
import { UniformRandomStream } from '../cs2/rng.js';
import { NADES, NADE_ORDER } from './grenades.js';

// Source / CS2 convars.
const RECOIL = {
  decayExp: 8, decayLin: 18, velDecay: 4.5, scale: 2, viewTracking: 0.45, viewPunchExtra: 0.055, viewPunchDecay: 18,
  suppressionShots: 4, suppressionFactor: 0.75, variance: 0.55,
};
const LN10 = Math.log(10);
const clamp01 = (x) => Math.max(0, Math.min(1, x));

// Source's recoil table: 64 shots of (angle, magnitude) per weapon mode, from the weapon's recoil seed.
function recoilTable(st, mode) {
  const rng = new UniformRandomStream(st.recoilSeed);
  const out = [];
  let angle = 0, mag = 0;
  for (let j = 0; j < 64; j++) {
    const a = st.recoilAngle[mode] + rng.randomFloat(-st.recoilAngleVariance[mode], st.recoilAngleVariance[mode]);
    const m = st.recoilMagnitude[mode] + rng.randomFloat(-st.recoilMagnitudeVariance[mode], st.recoilMagnitudeVariance[mode]);
    if (st.fullAuto && j > 0) { angle += (a - angle) * RECOIL.variance; mag += (m - mag) * RECOIL.variance; } else { angle = a; mag = m; }
    let k = 1;
    if (st.fullAuto && j < RECOIL.suppressionShots) k = RECOIL.suppressionFactor + (1 - RECOIL.suppressionFactor) * (j / RECOIL.suppressionShots);
    out.push({ angle, mag: mag * k });
  }
  return out;
}

export function basis(pitch, yaw) {
  const p = (pitch * Math.PI) / 180, y = (yaw * Math.PI) / 180;
  const cp = Math.cos(p), sp = Math.sin(p), cy = Math.cos(y), sy = Math.sin(y);
  return { fwd: [cp * cy, cp * sy, -sp], right: [sy, -cy, 0], up: [sp * cy, sp * sy, cp] };
}

const KNIFE = { light: { range: 48, damage: 40, again: 25, backstab: 90, cycle: 0.5, againCycle: 0.4 }, heavy: { range: 32, damage: 65, backstab: 180, cycle: 1.0 } };

export class Gun {
  constructor({ slot, id, name, stats, sounds, vm }) {
    Object.assign(this, { slot, id, name, stats, vm });
    this.sounds = sounds;
    this.melee = !!stats.melee || /knife|bayonet/.test(id);
    this.nade = NADES[id] || null;
    this.clip = stats.clip;
    this.reserve = stats.reserve;
    this.mode = 0;
    this.tables = [recoilTable(stats, 0), recoilTable(stats, 1)];
    this.nextAttack = 0; this.nextAlt = 0; this.reloadEnd = 0; this.deployEnd = 0; this.animEnd = 0;
    this.reloading = false; this.penalty = 0; this.recoilIndex = 0; this.lastShot = -10;
    this.zoom = 0; this.resumeZoom = 0; this.shots = 0;
    // Sound events share the shot's prefix (Weapon_AK47.*); knives inherit a gun's shot sound in the data.
    this.prefix = this.melee ? 'Weapon_Knife.' : (stats.shootSound || '').replace(/\.[^.]*$/, '.');
    this.silenced = stats.silencer !== 'WEAPONSILENCER_NONE' && !!stats.silencer;
  }
  get scoped() { return this.zoom > 0; }
}

export class Arsenal {
  constructor(game, guns) {
    this.game = game;
    this.guns = guns; // slot -> Gun
    this.current = null;
    this.last = null;
    this.aim = [0, 0]; this.aimVel = [0, 0]; this.view = [0, 0];
    this.scheduled = [];
  }

  get gun() { return this.current; }

  // Puts a gun in a slot (replacing what was there) / takes one away.
  give(slot, gun, t, select = true) {
    const old = this.guns[slot];
    if (old && old !== gun) { old.vm.rig.visible = false; if (this.current === old) this.current = null; if (this.last === old) this.last = null; }
    this.guns[slot] = gun;
    gun.slot = slot;
    if (select || !this.current) this.select(slot, t);
  }
  remove(slot, t) {
    const g = this.guns[slot];
    if (!g) return;
    g.vm.rig.visible = false;
    delete this.guns[slot];
    if (this.last === g) this.last = null;
    if (this.current === g) { this.current = null; this.selectBest(t); }
  }
  selectBest(t) {
    for (const s of ['primary', 'secondary', 'knife', 'c4']) if (this.guns[s]) { this.select(s, t); return; }
  }
  // Slots in wheel order: guns, knife, grenades (CS2's order), bomb.
  order() { return ['primary', 'secondary', 'knife', ...NADE_ORDER.map((id) => 'g_' + id), 'c4'].filter((s) => this.guns[s]); }

  select(slot, t) {
    const g = this.guns[slot];
    if (!g || g === this.current) return;
    if (this.current) { this.current.zoom = 0; this.current.reloading = false; }
    this.last = this.current;
    this.current = g;
    this.scheduled = [];
    g.deployEnd = t + (g.stats.deploy || 1);
    g.nextAttack = Math.max(g.nextAttack, g.deployEnd);
    g.animEnd = t + g.vm.play('draw');
    if (g.nade) { g.pin = null; g.throwAt = null; g.released = false; this.sound(g.id === 'weapon_molotov' ? 'Molotov.Draw' : 'HEGrenade.Draw', { volume: 0.5 }); }
    else this.sound(g.melee ? 'Weapon_Knife.Deploy' : g.prefix + 'Draw');
    this.game.emit('weapon', g);
  }

  sound(event, opts) { this.game.sounds?.play(event, { volume: 0.9, ...opts }); }

  // Max speed while holding the current weapon (scoped rifles are slower).
  maxSpeed() {
    const g = this.current;
    if (!g) return 250;
    return g.stats.maxSpeed[g.scoped ? 1 : 0] || 250;
  }

  // Camera angles: your aim plus view punch and part of the aim punch (CS2's view recoil tracking).
  viewAngles(pitch, yaw) {
    const k = RECOIL.scale * RECOIL.viewTracking;
    return [pitch + this.view[0] + this.aim[0] * k, yaw + this.view[1] + this.aim[1] * k];
  }

  inaccuracy(g) {
    const st = g.stats, m = g.scoped ? 1 : 0, p = this.game.player;
    let inacc = (p.ducked ? st.inaccCrouch[m] : st.inaccStand[m]) + g.penalty;
    const max = this.maxSpeed();
    const move = clamp01((p.speed2d() - max * 0.34) / (max * 0.95 - max * 0.34));
    inacc += st.inaccMove[m] * move;
    if (!p.onGround) inacc += st.inaccJump[m];
    return inacc;
  }

  tick(dt, t, input) {
    const g = this.current;
    this.decayPunch(dt);
    for (const s of this.scheduled.splice(0)) { if (t >= s.at) this.sound(s.event); else this.scheduled.push(s); }
    if (!g) return;
    const pressed = input.takePressed();
    const clicked = input.takeClicked();
    const wheel = input.takeWheel();
    this.pressed = pressed;
    if (!this.game.me.alive) return;
    for (const [a, slot] of [['slot1', 'primary'], ['slot2', 'secondary'], ['slot3', 'knife'], ['slot5', 'c4']]) if (pressed.has(a) && this.guns[slot]) this.select(slot, t);
    if (pressed.has('lastWeapon') && this.last && this.guns[this.last.slot] === this.last) this.select(this.last.slot, t);
    if (wheel) {
      const order = this.order();
      const i = order.indexOf(this.current?.slot);
      if (order.length) this.select(order[(i + (wheel > 0 ? 1 : -1) + order.length) % order.length], t);
    }
    // 4: cycle through your grenades.
    if (pressed.has('slot4')) {
      const nades = this.order().filter((s) => s.startsWith('g_'));
      if (nades.length) this.select(nades[(nades.indexOf(this.current?.slot) + 1) % nades.length], t);
    }
    const cur = this.current;
    this.recover(cur, dt, t);
    if (cur.reloading && t >= cur.reloadEnd) this.finishReload(cur, t);
    if (!cur.reloading && cur.vm.role !== 'idle' && t >= cur.animEnd && cur.vm.has('idle')) cur.vm.play('idle', { loop: true, fade: 0.12 });
    if (cur.resumeZoom && t >= cur.nextAttack) { cur.zoom = cur.resumeZoom; cur.resumeZoom = 0; }
    if (cur.nade) { this.grenade(cur, t, input); return; }
    // The bomb: hold fire in a bomb site to plant (the game runs the planting).
    if (cur.id === 'weapon_c4') { this.game.playerPlant(!!(input.buttons & 1), t); return; }
    if (!this.game.canAttack()) { if (pressed.has('reload')) this.reload(cur, t); return; }
    if (pressed.has('reload')) this.reload(cur, t);
    if (pressed.has('inspect') && !cur.reloading && t >= cur.nextAttack && cur.vm.has('inspect')) { cur.zoom = 0; cur.animEnd = t + cur.vm.play('inspect'); }
    const held = !!(input.buttons & 1), alt = !!(input.buttons & 4);
    if (cur.melee) {
      if ((clicked & 1 || held) && t >= cur.nextAttack) this.knife(cur, t, 'light');
      else if ((clicked & 4 || alt) && t >= cur.nextAttack) this.knife(cur, t, 'heavy');
      return;
    }
    if (clicked & 4 && cur.stats.zoomLevels > 0 && !cur.reloading && t >= cur.deployEnd) {
      cur.zoom = (cur.zoom + 1) % (cur.stats.zoomLevels + 1);
      cur.resumeZoom = 0;
      this.sound(cur.zoom ? 'Weapon_AWP.Zoom' : 'Weapon_AWP.ZoomOut', { volume: 0.5 });
    }
    const wants = cur.stats.fullAuto ? held : !!(clicked & 1);
    if (wants && t >= cur.nextAttack && !cur.reloading) {
      if (cur.clip > 0) this.shoot(cur, t);
      else {
        this.sound(/PISTOL/.test(cur.stats.type) ? 'Default.ClipEmpty_Pistol' : 'Default.ClipEmpty_Rifle');
        cur.nextAttack = t + 0.2;
        if (cur.reserve > 0) this.reload(cur, t);
      }
    }
  }

  // Grenades: pressing pulls the pin; releasing throws (Mouse1 full throw, Mouse2 underhand, both medium).
  grenade(g, t, input) {
    const b1 = !!(input.buttons & 1), b2 = !!(input.buttons & 4);
    if (g.throwAt == null) {
      if (!this.game.canAttack() || t < g.deployEnd) return;
      if (!g.pin && (b1 || b2)) {
        g.pin = t;
        g.vm.play(g.vm.has('pullpin') ? 'pullpin' : 'idle');
        this.sound(g.nade.pin, { volume: 0.6 });
      }
      if (g.pin) {
        if (b1 || b2) g.strength = b1 && b2 ? 0.5 : b1 ? 1 : 0;
        else if (t >= g.pin + 0.3) {
          g.throwAt = t + 0.1;
          g.vm.play(g.strength >= 0.5 ? 'throw' : g.vm.has('throwUnder') ? 'throwUnder' : 'throw', { fade: 0.03 });
        }
      }
      return;
    }
    if (!g.released && t >= g.throwAt) {
      g.released = true;
      this.game.throwMyNade(g.id, g.strength ?? 1);
    }
    if (g.released && t >= g.throwAt + 0.45) this.game.usedNade(g.id, t);
  }

  recover(g, dt, t) {
    const st = g.stats, p = this.game.player;
    const k = clamp01((g.recoilIndex - st.recoveryStart) / Math.max(1, st.recoveryEnd - st.recoveryStart));
    const rec = p.ducked ? st.recoveryCrouch + (st.recoveryCrouchFinal - st.recoveryCrouch) * k : st.recoveryStand + (st.recoveryStandFinal - st.recoveryStand) * k;
    const decay = Math.exp((-dt * LN10) / Math.max(0.05, rec));
    g.penalty *= decay;
    if (t > g.lastShot + st.cycle[0] * 1.1) g.recoilIndex *= decay;
  }

  decayPunch(dt) {
    const a = this.aim, v = this.aimVel;
    const e = Math.exp(-RECOIL.decayExp * dt);
    a[0] *= e; a[1] *= e;
    const len = Math.hypot(a[0], a[1]);
    if (len > 0) { const nl = Math.max(0, len - RECOIL.decayLin * dt) / len; a[0] *= nl; a[1] *= nl; }
    a[0] += v[0] * dt * 0.5; a[1] += v[1] * dt * 0.5;
    const ve = Math.exp(-RECOIL.velDecay * dt);
    v[0] *= ve; v[1] *= ve;
    a[0] += v[0] * dt * 0.5; a[1] += v[1] * dt * 0.5;
    const vp = Math.exp(-RECOIL.viewPunchDecay * dt);
    this.view[0] *= vp; this.view[1] *= vp;
  }

  shoot(g, t) {
    const st = g.stats, m = g.scoped ? 1 : 0;
    const game = this.game;
    g.clip--;
    g.shots++;
    g.nextAttack = t + st.cycle[m];
    const inacc = this.inaccuracy(g), spread = st.spread[m];
    // Bullets leave along your aim plus the full aim punch.
    const pitch = game.input.pitch + this.aim[0] * RECOIL.scale, yaw = game.input.yaw + this.aim[1] * RECOIL.scale;
    const { fwd, right, up } = basis(pitch, yaw);
    const eye = game.player.eye();
    const r0 = Math.random(), t0 = Math.random() * Math.PI * 2;
    for (let b = 0; b < (st.bullets || 1); b++) {
      const r1 = Math.random(), t1 = Math.random() * Math.PI * 2;
      const x = Math.cos(t0) * r0 * inacc + Math.cos(t1) * r1 * spread;
      const y = Math.sin(t0) * r0 * inacc + Math.sin(t1) * r1 * spread;
      const d = [fwd[0] + right[0] * x + up[0] * y, fwd[1] + right[1] * x + up[1] * y, fwd[2] + right[2] * x + up[2] * y];
      const l = Math.hypot(d[0], d[1], d[2]);
      game.fireBullet(game.me, eye, [d[0] / l, d[1] / l, d[2] / l], g, { tracer: st.tracerFrequency > 0 && g.shots % st.tracerFrequency === 0 });
    }
    this.kick(g, m);
    g.penalty += st.inaccFire[m];
    g.recoilIndex += 1;
    g.lastShot = t;
    const event = g.silenced && this.game.sounds?.has(g.prefix + 'Silenced') ? g.prefix + 'Silenced'
      : g.silenced && this.game.sounds?.has(g.prefix + 'SilencedShot') ? g.prefix + 'SilencedShot' : st.shootSound;
    this.sound(event, { volume: 0.8 });
    const role = g.clip === 0 && g.vm.has('shootEmpty') ? 'shootEmpty' : 'shoot';
    g.animEnd = t + g.vm.play(role, { fade: 0.02 });
    if (st.unzoomsAfterShot && g.zoom) { g.resumeZoom = g.zoom; g.zoom = 0; }
    game.emit('shot', g);
    game.noise(eye, g.silenced ? 900 : 2600, game.me);
    if (g.clip === 0 && g.reserve > 0 && /SNIPER|PISTOL/.test(st.type) === false) { /* CS2 doesn't auto-reload rifles until you try to fire */ }
  }

  kick(g, m) {
    const tbl = g.tables[m];
    const i = g.recoilIndex, i0 = Math.min(Math.floor(i), 63), i1 = Math.min(i0 + 1, 63), f = i - Math.floor(i);
    const angle = tbl[i0].angle + (tbl[i1].angle - tbl[i0].angle) * f;
    const mag = tbl[i0].mag + (tbl[i1].mag - tbl[i0].mag) * f;
    const rad = (angle * Math.PI) / 180;
    this.aimVel[0] -= Math.cos(rad) * mag;
    this.aimVel[1] -= Math.sin(rad) * mag;
    this.view[0] -= mag * RECOIL.viewPunchExtra;
  }

  reload(g, t) {
    if (g.melee || g.reloading || g.clip >= g.stats.clip || g.reserve <= 0 || t < g.deployEnd) return;
    g.zoom = 0; g.resumeZoom = 0;
    const empty = g.clip === 0 && g.vm.has('reloadEmpty');
    const len = g.vm.play(empty ? 'reloadEmpty' : 'reload') || 2.5;
    g.reloading = true;
    g.reloadEnd = t + len * 0.92;
    g.animEnd = t + len;
    g.nextAttack = Math.max(g.nextAttack, g.reloadEnd);
    const at = (k, e) => this.game.sounds?.has(g.prefix + e) && this.scheduled.push({ at: t + len * k, event: g.prefix + e });
    at(0.12, 'Clipout');
    at(0.5, 'Clipin');
    if (empty || g.clip === 0) { at(0.72, 'BoltPull') || at(0.72, 'BoltBack') || at(0.72, 'Slideback'); at(0.8, 'BoltForward') || at(0.8, 'Sliderelease'); }
    this.game.emit('reload', g);
  }

  finishReload(g) {
    const take = Math.min(g.stats.clip - g.clip, g.reserve);
    g.clip += take;
    g.reserve -= take;
    g.reloading = false;
    g.recoilIndex = 0;
    this.game.emit('ammo', g);
  }

  knife(g, t, kind) {
    const k = KNIFE[kind];
    const again = kind === 'light' && t - g.lastShot < 1.0;
    g.nextAttack = t + (again ? k.againCycle : k.cycle);
    g.lastShot = t;
    const hit = this.game.meleeTrace(k.range);
    const role = kind === 'light' ? (hit ? 'lightHit' : 'lightMiss') : hit ? 'heavyHit' : 'heavyMiss';
    g.animEnd = t + g.vm.play(g.vm.has(role) ? role : kind === 'light' ? 'lightMiss' : 'heavyMiss', { fade: 0.03 });
    if (!hit) { this.sound(kind === 'light' ? 'Weapon_Knife.Slash' : 'Weapon_Knife.Swish.Heavy'); return; }
    if (hit.bot) {
      const backstab = hit.backstab;
      const dmg = backstab ? k.backstab : again && k.again ? k.again : k.damage;
      this.game.damage(hit.bot.c, dmg, { attacker: this.game.me, group: 'chest', armorRatio: 1.7, point: hit.point, dir: hit.dir, weapon: g });
      this.sound(kind === 'light' ? 'Weapon_Knife.Hit' : 'Weapon_Knife.Stab');
    } else this.sound('Weapon_Knife.HitWall');
  }
}

export { RECOIL };
