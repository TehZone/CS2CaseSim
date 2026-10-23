// Your weapons in Play mode, following CS2's weapon data (scripts/weapons.vdata from your install): fire rate, magazine,
// damage with range falloff and armor, inaccuracy (standing, crouching, moving, in the air, firing) with recovery, the
// spread pattern, and recoil generated from each weapon's recoil seed the way Source does (aim punch with its
// decay, plus view punch), and each weapon's special modes: the M4A1-S and USP-S silencer (Mouse2 screws it off/on),
// the Glock-18 and FAMAS burst fire (Mouse2), the R8 Revolver (Mouse1 cocks then fires, Mouse2 fans), shotguns
// loading one shell at a time, and the Zeus x27 (one charge, recharging after 30 seconds).
// Angles are in degrees with Source's signs: positive pitch looks down, positive yaw turns left.
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

// Which of the weapon data's paired values apply (CS2 keeps two per stat): the second when scoped, with the silencer
// off, in burst mode.
export const altMode = (g) => (g.zoom > 0 || (g.detachable && !g.silenced) || g.burstMode ? 1 : 0);
const REVOLVER_COCK = 0.2, TASER_RECHARGE = 30, SHELL_TIME = 0.5;

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
    this.detachable = stats.silencer === 'WEAPONSILENCER_DETACHABLE';
    this.burstMode = false; this.burstLeft = 0; this.nextBurst = 0;
    this.taser = stats.type === 'WEAPONTYPE_TASER';
    this.rechargeAt = 0;
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
    for (const s of ['primary', 'secondary', 'knife', 'taser', 'c4']) if (this.guns[s]) { this.select(s, t); return; }
  }
  // Slots in wheel order: guns, knife, Zeus, grenades (CS2's order), bomb.
  order() { return ['primary', 'secondary', 'knife', 'taser', ...NADE_ORDER.map((id) => 'g_' + id), 'c4'].filter((s) => this.guns[s]); }

  select(slot, t) {
    const g = this.guns[slot];
    if (!g || g === this.current) return;
    if (this.current) {
      const c = this.current;
      c.zoom = 0; c.reloading = false; c.shellReload = false; c.burstLeft = 0; c.cockAt = null;
      if (c.pendingSilencer != null) { c.pendingSilencer = null; c.vm.setSilencer?.(c.silenced); } // switching away cancels it
    }
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

  inaccuracy(g, m = altMode(g)) {
    const st = g.stats, p = this.game.player;
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
    for (const z of Object.values(this.guns)) {
      if (z.taser && z.clip <= 0 && z.rechargeAt && t >= z.rechargeAt) { z.clip = 1; z.rechargeAt = 0; if (z === g) this.sound('Weapon_Taser.ChargeReady', { volume: 0.5 }); }
    }
    for (const s of this.scheduled.splice(0)) { if (t >= s.at) this.sound(s.event); else this.scheduled.push(s); }
    if (!g) return;
    const pressed = input.takePressed();
    const clicked = input.takeClicked();
    const wheel = input.takeWheel();
    this.pressed = pressed;
    if (!this.game.me.alive) return;
    for (const [a, slot] of [['slot1', 'primary'], ['slot2', 'secondary'], ['slot5', 'c4']]) if (pressed.has(a) && this.guns[slot]) this.select(slot, t);
    // 3: the knife, or the Zeus when you already hold the knife (CS2 keeps both in slot 3).
    if (pressed.has('slot3')) this.select(this.current?.slot === 'knife' && this.guns.taser ? 'taser' : this.guns.knife ? 'knife' : 'taser', t);
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
    if (cur.pendingSilencer != null && t >= cur.silencerAt) { cur.silenced = cur.pendingSilencer; cur.pendingSilencer = null; cur.vm.setSilencer?.(cur.silenced); }
    if (!cur.reloading && cur.vm.role !== 'idle' && t >= cur.animEnd && cur.vm.has('idle')) cur.vm.play('idle', { loop: true, fade: 0.12 });
    if (cur.resumeZoom && t >= cur.nextAttack) { cur.zoom = cur.resumeZoom; cur.resumeZoom = 0; }
    if (cur.nade) { this.grenade(cur, t, input); return; }
    // The bomb: hold fire in a bomb site to plant (the game runs the planting).
    if (cur.id === 'weapon_c4') { this.game.playerPlant(!!(input.buttons & 1), t); return; }
    // Inspecting works in freeze time too, like CS2 (not while defusing or buying).
    if (pressed.has('inspect') && !cur.reloading && t >= cur.nextAttack && cur.vm.has('inspect') && !this.game.defusing && !this.game.buyMenu?.isOpen) {
      cur.zoom = 0; cur.animEnd = t + cur.vm.play('inspect');
    }
    if (!this.game.canAttack()) { if (pressed.has('reload')) this.reload(cur, t); return; }
    if (pressed.has('reload')) this.reload(cur, t);
    const held = !!(input.buttons & 1), alt = !!(input.buttons & 4);
    if (cur.melee) {
      if ((clicked & 1 || held) && t >= cur.nextAttack) this.knife(cur, t, 'light');
      else if ((clicked & 4 || alt) && t >= cur.nextAttack) this.knife(cur, t, 'heavy');
      return;
    }
    if (cur.taser) { if (clicked & 1 && t >= cur.nextAttack) this.zap(cur, t); return; }
    if (cur.stats.revolver) { this.revolver(cur, t, held, alt); return; }
    if (clicked & 4 && !cur.reloading && t >= cur.deployEnd) {
      if (cur.stats.zoomLevels > 0) {
        cur.zoom = (cur.zoom + 1) % (cur.stats.zoomLevels + 1);
        cur.resumeZoom = 0;
        this.sound(cur.zoom ? 'Weapon_AWP.Zoom' : 'Weapon_AWP.ZoomOut', { volume: 0.5 });
      } else if (cur.detachable && t >= cur.nextAttack && cur.pendingSilencer == null) this.toggleSilencer(cur, t);
      else if (cur.stats.burst) {
        cur.burstMode = !cur.burstMode;
        this.game.hud?.message(cur.burstMode ? 'Switched to burst-fire mode' : cur.stats.fullAuto ? 'Switched to full-automatic' : 'Switched to semi-automatic', 1500);
        this.sound('Weapon_Glock.Element_Click', { volume: 0.5 });
      }
    }
    // The rest of a burst: two more shots, a burst gap apart.
    if (cur.burstLeft > 0 && t >= cur.nextBurst) {
      if (cur.clip > 0 && !cur.reloading) { this.shoot(cur, t, { burst: true }); cur.burstLeft--; cur.nextBurst = t + cur.stats.burstGap; } else cur.burstLeft = 0;
    }
    const wants = cur.stats.fullAuto && !cur.burstMode ? held : !!(clicked & 1);
    // Shotguns can fire in the middle of loading shells.
    if (wants && cur.shellReload && cur.clip > 0) { cur.reloading = false; cur.shellReload = false; }
    if (wants && t >= cur.nextAttack && !cur.reloading && cur.pendingSilencer == null) {
      if (cur.clip > 0) {
        this.shoot(cur, t);
        if (cur.burstMode) { cur.burstLeft = 2; cur.nextBurst = t + cur.stats.burstGap; cur.nextAttack = t + cur.stats.burstCycle; }
      } else this.dryFire(cur, t);
    }
  }

  dryFire(g, t) {
    this.sound(/PISTOL/.test(g.stats.type) ? 'Default.ClipEmpty_Pistol' : 'Default.ClipEmpty_Rifle');
    g.nextAttack = t + 0.2;
    if (g.reserve > 0) this.reload(g, t);
  }

  // M4A1-S / USP-S: screw the silencer off or on (its own animation; it takes effect when that ends).
  toggleSilencer(g, t) {
    const on = !g.silenced;
    const role = on ? 'silencerAttach' : 'silencerDetach';
    const len = g.vm.has(role) ? g.vm.play(role, { fade: 0.08 }) : 2.6;
    g.zoom = 0;
    g.animEnd = t + len;
    g.nextAttack = Math.max(g.nextAttack, t + len);
    g.silencerAt = t + len * 0.9;
    g.pendingSilencer = on;
    if (on) g.vm.setSilencer?.(true); // it comes into view from your hand; screwed off, it's hidden once put away
    const pistol = g.id === 'weapon_usp_silencer';
    this.sound(pistol ? (on ? 'Weapon_USP.AttachSilencer' : 'Weapon_USP.DetachSilencer') : on ? 'Weapon_M4A1.Silencer_On' : 'Weapon_M4A1.Silencer_Off', { volume: 0.6 });
    this.game.emit('silencer', { gun: g, on });
  }

  // R8 Revolver: holding Mouse1 cocks the hammer (a fifth of a second) and fires; Mouse2 fans the hammer, fast and
  // inaccurate (the data's second values).
  revolver(g, t, held, alt) {
    if (g.reloading) { g.cockAt = null; return; }
    if (g.clip <= 0) { if ((held || alt) && t >= g.nextAttack) { g.cockAt = null; this.dryFire(g, t); } return; }
    if (alt) { g.cockAt = null; if (t >= g.nextAttack) this.shoot(g, t, { mode: 1 }); return; }
    if (!held) { if (g.cockAt != null) { g.cockAt = null; if (g.vm.has('idle')) g.vm.play('idle', { loop: true, fade: 0.1 }); } return; }
    if (t < g.nextAttack) return;
    if (g.cockAt == null) {
      g.cockAt = t + REVOLVER_COCK;
      if (g.vm.has('prepare')) g.animEnd = t + g.vm.play('prepare', { fade: 0.03 });
      this.sound('Weapon_Revolver.Prepare', { volume: 0.7 });
    } else if (t >= g.cockAt) { g.cockAt = null; this.shoot(g, t, { mode: 0 }); }
  }

  // Zeus x27: one shock at close range that kills; it recharges in 30 seconds.
  zap(g, t) {
    if (g.clip <= 0) { this.sound('Weapon_Taser.ChargeNotReady', { volume: 0.5 }); g.nextAttack = t + 0.4; return; }
    g.clip = 0;
    g.rechargeAt = t + TASER_RECHARGE;
    g.nextAttack = t + 0.5;
    g.lastShot = t;
    const { fwd } = basis(this.game.input.pitch, this.game.input.yaw);
    this.game.fireBullet(this.game.me, this.game.player.eye(), fwd, g, { tracer: true });
    this.sound('Weapon_Taser.Single', { volume: 0.8 });
    g.animEnd = t + g.vm.play('shoot', { fade: 0.02 });
    this.game.noise(this.game.player.eye(), 1400, this.game.me);
    this.game.emit('shot', g);
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

  shoot(g, t, { mode = altMode(g), burst = false } = {}) {
    const st = g.stats, m = mode;
    const game = this.game;
    g.clip--;
    g.shots++;
    if (!burst) g.nextAttack = t + st.cycle[m];
    const inacc = this.inaccuracy(g, m), spread = st.spread[m];
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
    const role = st.revolver && m === 1 && g.vm.has('shootAlt') ? 'shootAlt' : g.clip === 0 && g.vm.has('shootEmpty') ? 'shootEmpty' : 'shoot';
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
    if (g.melee || g.taser || g.reloading || g.clip >= g.stats.clip || g.reserve <= 0 || t < g.deployEnd || g.pendingSilencer != null) return;
    g.zoom = 0; g.resumeZoom = 0; g.burstLeft = 0; g.cockAt = null;
    if (g.stats.bulletsPerReload === 1) { this.loadShell(g, t); this.game.emit('reload', g); return; }
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

  // Shotguns (Nova, XM1014, Sawed-Off) load one shell at a time: each shell replays the start of the reload animation
  // (grab a shell, push it in); after the last one the animation plays on (back to the pump).
  loadShell(g, t) {
    g.reloading = true;
    g.shellReload = true;
    const len = g.vm.play('reload', { fade: 0.05 }) || SHELL_TIME;
    g.reloadEnd = t + SHELL_TIME;
    g.animEnd = t + len;
  }

  finishReload(g, t) {
    if (g.shellReload) {
      g.clip++; g.reserve--;
      const ev = [g.prefix + 'Insertshell', g.prefix + 'InsertShell'].find((e) => this.game.sounds?.has(e));
      if (ev) this.sound(ev, { volume: 0.7 });
      if (g.clip < g.stats.clip && g.reserve > 0) this.loadShell(g, t);
      else { g.reloading = false; g.shellReload = false; g.recoilIndex = 0; }
      this.game.emit('ammo', g);
      return;
    }
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
