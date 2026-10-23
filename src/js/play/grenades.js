// Grenades: thrown with CS2's throw (Mouse1 full throw, Mouse2 underhand lob, both a medium throw, plus your own
// movement), bouncing off the world, then: HE explodes, the flashbang blinds whoever looks at it, the smoke grenade
// floods the area with CS2's volumetric smoke (smoke.js), the molotov/incendiary sets the ground on fire (a smoke puts it
// out), the decoy fakes gunfire. Game units (inches, Z up); drawn in the glTF scene.
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { FLAG_GRENADE, FLAG_BULLET } from './collision.js';
import { toGl } from './world.js';
import { SmokeSystem } from './smoke.js';
import { FireArt, GroundFire } from './fire.js';

export const NADES = {
  weapon_hegrenade: { kind: 'he', name: 'HE Grenade', short: 'HE', fuse: 1.5, bounce: 'HEGrenade.Bounce', boom: 'BaseGrenade.Explode', pin: 'HEGrenade.PullPin_Grenade', throw: 'HEGrenade.Throw' },
  weapon_flashbang: { kind: 'flash', name: 'Flashbang', short: 'FLASH', fuse: 1.65, bounce: 'Flashbang.Bounce', boom: 'Flashbang.Explode', pin: 'Flashbang.PullPin_Grenade', throw: 'Flashbang.Throw' },
  weapon_smokegrenade: { kind: 'smoke', name: 'Smoke Grenade', short: 'SMOKE', fuse: 1.2, bounce: 'SmokeGrenade.Bounce', boom: 'BaseSmokeEffect.Sound', pin: 'SmokeGrenade.PullPin_Grenade', throw: 'SmokeGrenade.Throw' },
  weapon_molotov: { kind: 'fire', name: 'Molotov', short: 'MOLOTOV', fuse: 2.0, bounce: 'Molotov.Bounce', boom: 'Molotov.Start', pin: 'Molotov.PreThrow', throw: 'Molotov.Throw' },
  weapon_incgrenade: { kind: 'fire', name: 'Incendiary Grenade', short: 'INCENDIARY', fuse: 2.0, bounce: 'IncGrenade.Bounce', boom: 'IncGrenade.Start', pin: 'IncGrenade.PullPin_Grenade', throw: 'IncGrenade.Throw' },
  weapon_decoy: { kind: 'decoy', name: 'Decoy Grenade', short: 'DECOY', fuse: 1.2, bounce: 'HEGrenade.Bounce', boom: 'BaseGrenade.Explode', pin: 'Decoy.PullPin_Grenade', throw: 'Decoy.Throw' },
};
export const NADE_ORDER = ['weapon_hegrenade', 'weapon_flashbang', 'weapon_smokegrenade', 'weapon_molotov', 'weapon_incgrenade', 'weapon_decoy'];
export const NADE_SOUNDS = [...new Set(Object.values(NADES).flatMap((n) => [n.bounce, n.boom, n.pin, n.throw])), 'Inferno.Loop', 'Inferno.FadeOut',
  'Molotov.Extinguish', 'Flashbang.Ring.Long', 'Flashbang.Ring.Medium', 'Flashbang.Ring.Short', 'BaseGrenade.ExplodeDistant', 'Flashbang.ExplodeDistant',
  'Molotov.StartFailed', 'SmokeGrenade.Clear', 'Grenade.ImpactHard'];
// CS2's limits: four grenades, two flashbangs, one of each other kind.
export const NADE_LIMIT = { total: 4, weapon_flashbang: 2 };
export const isNade = (id) => !!NADES[id];

const GRAVITY = 800 * 0.4, RESTITUTION = 0.45;
const FIRE_RADIUS = 140, FIRE_TIME = 7, FIRE_DPS = 40, HE_RADIUS = 350;
const FIRE_LIGHT = 6; // the fire's light (candela) on the walls and players around it

// CS2's throw: the aim is raised (pitch -10 + pitch * 80/90), speed 750 x 0.9 scaled by strength, plus 1.25x your velocity.
export function throwVelocity(pitch, yaw, strength, vel = [0, 0, 0]) {
  const p = ((-10 + pitch * (80 / 90)) * Math.PI) / 180, y = (yaw * Math.PI) / 180;
  const speed = 675 * (0.7 * strength + 0.3);
  const d = [Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), -Math.sin(p)];
  return d.map((v, i) => v * speed + vel[i] * 1.25);
}

// The pitch (game degrees) a bot needs to land a throw of `strength` on `to` from `from`, or null if out of reach.
export function aimThrow(from, to, strength, preferHigh = false) {
  const speed = 675 * (0.7 * strength + 0.3);
  const dx = Math.hypot(to[0] - from[0], to[1] - from[1]), dz = to[2] - from[2];
  const v2 = speed * speed, g = GRAVITY;
  const disc = v2 * v2 - g * (g * dx * dx + 2 * dz * v2);
  if (disc < 0) return null;
  const root = Math.sqrt(disc);
  const angle = Math.atan((v2 + (preferHigh ? root : -root)) / (g * dx)); // elevation of the actual throw
  // Undo the throw's pitch remap: elevation e = -(-10 + pitch * 80/90) -> pitch = (10 - e) * 90/80
  return ((10 - (angle * 180) / Math.PI) * 90) / 80;
}

export class Grenades {
  constructor(game) {
    this.game = game;
    this.group = new THREE.Group();
    game.scene.add(this.group);
    this.flying = []; this.fires = []; this.decoys = [];
    this.volume = new SmokeSystem(game);
    this.fireArt = new FireArt();
    // One light for the fire nearest you, there from the start (adding a light later recompiles every material).
    this.fireLight = new THREE.PointLight(0xff7a2a, 0, 12, 2);
    this.group.add(this.fireLight);
    // A fire with nothing to show, so its shaders compile with the map's (taken out on the first frame).
    this.warmFire = new GroundFire(this.fireArt, new THREE.Vector3(0, -1000, 0), [[0, -1000, 0, 0]], 1, -10);
    this.group.add(this.warmFire.obj);
  }

  // A grenade leaves someone's hand.
  throw(c, id, origin, vel) {
    const info = NADES[id];
    if (!info) return;
    const n = { c, id, info, pos: origin.slice(), vel: vel.slice(), born: this.game.now, still: 0, bounces: 0, obj: new THREE.Group(), spin: new THREE.Vector3(Math.random() * 12, Math.random() * 12, Math.random() * 12) };
    this.group.add(n.obj);
    this.game.botAssets.weapon(id).then((tpl) => {
      if (!tpl || !n.obj.parent) return;
      const m = cloneSkinned(tpl);
      m.position.set(0, 0, 0); m.rotation.set(0, 0, 0); m.scale.set(1, 1, 1);
      m.traverse((o) => { if (o.isMesh) { o.frustumCulled = false; o.castShadow = false; } });
      n.obj.add(m);
    });
    toGl(n.pos, n.obj.position);
    this.flying.push(n);
    this.game.sounds.play(info.throw, { pos: origin, listener: this.game, volume: 0.6 });
    return n;
  }

  tick(dt) {
    const g = this.game, now = g.now;
    for (let i = this.flying.length - 1; i >= 0; i--) {
      const n = this.flying[i];
      this.move(n, dt);
      const age = now - n.born;
      const k = n.info.kind;
      const stopped = n.still > 0.15;
      if ((k === 'he' || k === 'flash') && age >= n.info.fuse) this.detonate(n, i);
      else if ((k === 'smoke' || k === 'decoy') && age >= n.info.fuse && stopped) this.detonate(n, i);
      else if (k === 'fire' && (n.landed || age >= n.info.fuse)) this.detonate(n, i);
      else if (age > 20) this.remove(n, i);
    }
    this.volume.tick(dt);
    for (let i = this.fires.length - 1; i >= 0; i--) {
      const f = this.fires[i];
      if (now > f.until) { this.endFire(f, i); continue; }
      // A smoke spreading over the flames puts them out.
      if (this.volume.active && this.smokedOut(f.pos)) { g.sounds.play('Molotov.Extinguish', { pos: f.pos, listener: g }); this.endFire(f, i); continue; }
      // Burning: damage four times a second to anyone standing in it.
      if (now >= f.nextHurt) {
        f.nextHurt = now + 0.25;
        for (const c of g.combatants) {
          if (!c.alive) continue;
          const p = g.positionOf(c);
          if (Math.hypot(p[0] - f.pos[0], p[1] - f.pos[1]) < f.radius && Math.abs(p[2] - f.pos[2]) < 70) {
            g.damage(c, FIRE_DPS * 0.25, { attacker: f.c, group: 'leg', armorRatio: 2, weapon: { id: f.id, name: NADES[f.id].name }, explosion: true });
          }
        }
      }
    }
    for (let i = this.decoys.length - 1; i >= 0; i--) {
      const d = this.decoys[i];
      if (now > d.until) {
        g.sounds.play('BaseGrenade.Explode', { pos: d.pos, listener: g, volume: 0.4 });
        this.group.remove(d.obj);
        this.decoys.splice(i, 1);
        continue;
      }
      if (now >= d.next) {
        // Bursts of the thrower's gun, like CS2's decoy.
        const shots = 1 + Math.floor(Math.random() * 4);
        for (let s = 0; s < shots; s++) setTimeout(() => g.sounds.play(d.sound, { pos: d.pos, listener: g, volume: 0.9 }), s * 110);
        g.noise(d.pos, 2600, d.c);
        d.next = now + 0.8 + Math.random() * 1.6;
      }
    }
  }

  // Flight with bounces (CS2's grenades bounce with 0.45 restitution and lose some speed along the surface).
  move(n, dt) {
    const col = this.game.collision;
    if (n.still > 0.15) { n.still += dt; return; }
    const from = n.pos.slice();
    let left = dt;
    for (let it = 0; it < 3 && left > 0; it++) {
      n.vel[2] -= GRAVITY * left;
      const to = [n.pos[0] + n.vel[0] * left, n.pos[1] + n.vel[1] * left, n.pos[2] + n.vel[2] * left];
      const tr = col.traceBox(n.pos, to, [-2, -2, -2], [2, 2, 2], FLAG_GRENADE);
      n.pos = tr.endpos;
      if (!tr.normal || tr.fraction >= 1) break;
      left *= 1 - tr.fraction;
      const nrm = tr.normal;
      const vn = n.vel[0] * nrm[0] + n.vel[1] * nrm[1] + n.vel[2] * nrm[2];
      const speed = Math.hypot(...n.vel);
      for (let k = 0; k < 3; k++) n.vel[k] = (n.vel[k] - vn * nrm[k]) * (nrm[2] > 0.7 ? 0.8 : 0.95) - vn * nrm[k] * RESTITUTION;
      if (nrm[2] > 0.7) n.landed = true;
      if (speed > 60 && this.game.now - (n.lastBounce || 0) > 0.08) {
        n.lastBounce = this.game.now;
        this.game.sounds.play(n.info.bounce, { pos: n.pos, listener: this.game, volume: Math.min(1, speed / 500) });
      }
      if (nrm[2] > 0.7 && Math.hypot(...n.vel) < 25) { n.vel = [0, 0, 0]; n.still = 0.16; break; }
    }
    if (this.game.balls.bump(n, from)) n.still = 0;
    if (Math.hypot(...n.vel) < 5) n.still += dt; else n.still = 0;
    toGl(n.pos, n.obj.position);
    if (n.still < 0.1) { n.obj.rotation.x += n.spin.x * dt; n.obj.rotation.y += n.spin.y * dt; n.obj.rotation.z += n.spin.z * dt; }
  }

  remove(n, i) { this.group.remove(n.obj); this.flying.splice(i, 1); }

  detonate(n, i) {
    const g = this.game, k = n.info.kind;
    this.flying.splice(i, 1);
    if (k !== 'decoy') this.group.remove(n.obj);
    g.sounds.play(n.info.boom, { pos: n.pos, listener: g, volume: 1 });
    if (k === 'he') this.explodeHE(n);
    else if (k === 'flash') this.flashbang(n);
    else if (k === 'smoke') this.smoke(n);
    else if (k === 'fire') this.fire(n);
    else if (k === 'decoy') {
      const best = g.botOf(n.c)?.weapons.primary || g.botOf(n.c)?.weapons.secondary || (n.c === g.me ? g.arsenal.guns.primary || g.arsenal.guns.secondary : null);
      this.decoys.push({ c: n.c, pos: n.pos.slice(), obj: n.obj, until: g.now + 15, next: g.now + 0.3, sound: best?.stats?.shootSound || 'Weapon_AK47.Single' });
    }
    g.noise(n.pos, k === 'smoke' ? 1200 : 2400, n.c);
  }

  // HE: up to 99 damage falling off over 350 units, blocked by walls, armor takes some.
  explodeHE(n) {
    const g = this.game;
    g.effects.explosion(n.pos, 0.35);
    this.volume.blast(n.pos);
    g.balls.blast(n.pos, HE_RADIUS);
    for (const c of g.combatants.slice()) {
      if (!c.alive) continue;
      const p = g.bodyOf(c).chest;
      const d = Math.hypot(p[0] - n.pos[0], p[1] - n.pos[1], p[2] - n.pos[2]);
      if (d > HE_RADIUS || !g.lineOfSight([n.pos[0], n.pos[1], n.pos[2] + 4], p)) continue;
      const dmg = 99 * (1 - d / HE_RADIUS);
      if (dmg >= 1) g.damage(c, dmg, { attacker: n.c, group: 'chest', armorRatio: 1.15, weapon: { id: n.id, name: n.info.name }, explosion: true });
    }
    if (Math.hypot(...[0, 1, 2].map((k) => g.player.origin[k] - n.pos[k])) < 600) g.shake = Math.max(g.shake || 0, 0.4);
  }

  // Flashbang: blinds anyone with a line of sight to it, more when they look at it and are close.
  flashbang(n) {
    const g = this.game;
    g.effects.flashPop(n.pos);
    for (const c of g.combatants) {
      if (!c.alive) continue;
      const body = g.bodyOf(c), eye = body.eye;
      const d = Math.hypot(eye[0] - n.pos[0], eye[1] - n.pos[1], eye[2] - n.pos[2]);
      if (d > 2800 || !g.lineOfSight(n.pos, eye) || this.smokeBlocks(n.pos, eye)) continue;
      const view = g.viewDir(c);
      const to = [(n.pos[0] - eye[0]) / d, (n.pos[1] - eye[1]) / d, (n.pos[2] - eye[2]) / d];
      const dot = view[0] * to[0] + view[1] * to[1] + view[2] * to[2];
      const facing = dot > 0.6 ? 1 : dot > -0.3 ? 0.35 + 0.65 * ((dot + 0.3) / 0.9) : 0.2;
      const near = Math.max(0, Math.min(1, 1 - (d - 300) / 2500));
      const secs = 5.2 * facing * near;
      if (secs > 0.3) g.flash(c, secs, n.c);
    }
  }

  // Smoke: CS2's volumetric cloud, flooding the space around where the grenade stopped for 18 seconds.
  smoke(n) { this.volume.add(n.pos); }
  smokedOut(p) { return this.volume.densityAt([p[0], p[1], p[2] + 20]) > 0.25; }

  // Molotov / incendiary: fire on the ground below where it broke (nothing if it bursts high in the air).
  fire(n) {
    const g = this.game;
    const down = g.collision.raycast(n.pos, [0, 0, -1], 160, FLAG_BULLET);
    if (!down) { g.sounds.play(n.id === 'weapon_molotov' ? 'Molotov.StartFailed' : 'IncGrenade.StartFailed', { pos: n.pos, listener: g }); return; }
    const pos = [n.pos[0], n.pos[1], n.pos[2] - down.t];
    if (this.smokedOut(pos)) {
      g.sounds.play('Molotov.Extinguish', { pos, listener: g });
      return;
    }
    // Where the flames stand: on whatever is below (the ground, a box, the stairs), spread along it from where it
    // broke (not through walls), and not up or down a drop.
    const spots = [], from = [pos[0], pos[1], pos[2] + 24];
    for (let i = 0; i < 200 && spots.length < 84; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * FIRE_RADIUS * 0.95;
      const dx = Math.cos(a), dy = Math.sin(a);
      if (r > 8 && g.collision.raycast(from, [dx, dy, 1e-6], r, FLAG_BULLET)) continue;
      const x = pos[0] + dx * r, y = pos[1] + dy * r;
      const hit = g.collision.raycast([x, y, pos[2] + 40], [0, 0, -1], 90, FLAG_BULLET);
      if (!hit || Math.abs(40 - hit.t) > 40) continue;
      spots.push([...toGl([x, y, pos[2] + 40 - hit.t]).toArray(), r / FIRE_RADIUS]);
    }
    const art = new GroundFire(this.fireArt, toGl(pos), spots, FIRE_TIME, g.now);
    this.group.add(art.obj);
    const loop = g.sounds.play('Inferno.Loop', { pos, listener: g, volume: 0.6 });
    this.fires.push({ c: n.c, id: n.id, pos, radius: FIRE_RADIUS, until: g.now + FIRE_TIME, nextHurt: g.now, art, loop });
  }
  endFire(f, i) {
    f.art.dispose();
    Promise.resolve(f.loop).then((src) => { try { src?.stop(); } catch {} });
    this.game.sounds.play('Inferno.FadeOut', { pos: f.pos, listener: this.game, volume: 0.5 });
    this.fires.splice(i, 1);
  }

  // Does a line pass through enough smoke to hide what's behind it?
  smokeBlocks(a, b) { return this.volume.active && this.volume.blocks(a, b); }
  inFire(p) { return this.fires.some((f) => Math.hypot(p[0] - f.pos[0], p[1] - f.pos[1]) < f.radius + 20 && Math.abs(p[2] - f.pos[2]) < 70); }
  // A fire on your level (not one on a ledge above or a floor below).
  fireNear(p, r = 0) { return this.fires.find((f) => Math.hypot(p[0] - f.pos[0], p[1] - f.pos[1]) < f.radius + r && Math.abs(p[2] - f.pos[2]) < 70) || null; }

  // Animation of clouds and flames, and the light of the fire nearest you (flickering).
  update(dt) {
    const g = this.game, now = g.now;
    this.volume.update();
    this.warmFire?.obj.removeFromParent();
    let lit = null, best = Infinity;
    for (const f of this.fires) {
      f.art.update(now);
      const d = f.art.center.distanceToSquared(g.camera.position);
      if (d < best) { best = d; lit = f; }
    }
    const L = this.fireLight;
    L.intensity = lit ? FIRE_LIGHT * lit.art.level(now) * (0.85 + 0.15 * Math.sin(now * 17) * Math.sin(now * 7.7 + 1)) : 0;
    if (lit) { L.position.copy(lit.art.center); L.position.y += 1.1; }
  }

  clear() {
    for (const n of this.flying) this.group.remove(n.obj);
    for (let i = this.fires.length - 1; i >= 0; i--) this.endFire(this.fires[i], i);
    this.volume.clear();
    for (const d of this.decoys) this.group.remove(d.obj);
    this.flying = []; this.fires = []; this.decoys = [];
  }

  dispose() { this.clear(); this.group.removeFromParent(); this.volume.dispose(); this.warmFire.dispose(); this.fireArt.dispose(); }
}
