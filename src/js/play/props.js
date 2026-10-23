// Physics props: CS2's soccer ball (Dust II has one) as a ball you can kick about, like in game. Walking into it kicks
// it along, bots bump it too, bullets, knives and HE blasts knock it, grenades bounce off it, and it bounces off the
// world and rolls to a stop. Every round it's back on its spot. The ball is a sphere: against the collision mesh it
// sweeps as a box of its size (like grenades), against players and bots it meets their hull boxes.
import * as THREE from 'three';
import { FLAG_GRENADE } from './collision.js';
import { toGl, dirGl } from './world.js';

const GRAVITY = 800;
const BOUNCE = 0.55; // restitution off walls and floors
const WALL_FRICTION = 0.9; // speed along a wall kept when it bounces off
const ROLL_DECEL = 40, ROLL_DRAG = 0.3; // rolling friction: a constant part and one that grows with speed (units/s²)
const KICK = 1.35; // a ball you walk into leaves at this times your speed into it
const BLAST = 1100; // HE: speed given at the centre of the blast, falling off to nothing at its edge
const NADE_BOUNCE = 0.45;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export class Balls {
  // list: from loadWorld: [{ mesh, spawn: [x, y, z] (its centre), radius, amb }].
  constructor(game, list = []) {
    this.game = game;
    this.list = list.map((b) => ({ ...b, spawn: b.spawn.slice(), home: b.mesh.quaternion.clone() }));
    for (const b of this.list) {
      // Resting just on the floor (the model sits a little into it, and a trace starting inside would fall through).
      const down = game.collision.raycast(b.spawn, [0, 0, -1], b.radius * 2, FLAG_GRENADE);
      if (down) b.spawn[2] += b.radius + 0.05 - down.t;
      game.scene.add(b.mesh);
    }
    this.q = new THREE.Quaternion();
    this.axis = new THREE.Vector3();
    this.reset();
  }

  // Back on its spot and at rest (CS2 resets the map's props every round).
  reset() {
    for (const b of this.list) {
      b.pos = b.spawn.slice(); b.prev = b.spawn.slice();
      b.vel = [0, 0, 0]; b.spin = [0, 0, 0];
      b.asleep = true; b.still = 0; b.lit = -1;
      b.mesh.quaternion.copy(b.home);
      toGl(b.pos, b.mesh.position);
    }
  }

  hull(b) { const h = b.radius * 0.9; return [[-h, -h, -b.radius], [h, h, b.radius]]; }
  wake(b) { b.asleep = false; b.still = 0; }

  sound(b, speed) {
    const g = this.game, now = g.now;
    if (speed < 40 || now - (b.lastSound || 0) < 0.08) return;
    b.lastSound = now;
    g.sounds.play(speed > 260 ? 'Ball.ImpactHard' : 'Ball.ImpactSoft', { pos: b.pos, listener: g, volume: Math.min(1, speed / 400) });
  }

  // Flight, bounces and rolling, one tick.
  tick(dt) {
    const col = this.game.collision;
    for (const b of this.list) {
      b.prev = b.pos.slice();
      if (b.asleep) continue;
      const [mins, maxs] = this.hull(b);
      let left = dt, ground = null;
      b.vel[2] -= GRAVITY * dt;
      for (let it = 0; it < 4 && left > 1e-5; it++) {
        const to = [b.pos[0] + b.vel[0] * left, b.pos[1] + b.vel[1] * left, b.pos[2] + b.vel[2] * left];
        const tr = col.traceBox(b.pos, to, mins, maxs, FLAG_GRENADE);
        b.pos = tr.endpos;
        if (!tr.normal || tr.fraction >= 1) break;
        left *= 1 - tr.fraction;
        const n = tr.normal, vn = dot(b.vel, n);
        if (vn >= 0) {
          // Stopped by a surface it's moving along (a corner of the box on a floor that isn't quite flat): ease off it.
          for (let k = 0; k < 3; k++) b.pos[k] += n[k] * 0.05;
          continue;
        }
        const floor = n[2] > 0.7;
        if (floor) ground = n;
        // A hard landing bounces; a soft one (or rolling along) just stays on the floor.
        const e = floor && -vn < 60 ? 0 : BOUNCE, keep = floor ? 1 : WALL_FRICTION;
        for (let k = 0; k < 3; k++) b.vel[k] = (b.vel[k] - vn * n[k]) * keep - vn * n[k] * e;
        this.sound(b, -vn);
      }
      if (ground) {
        // Rolling: friction slows it, and it turns with the ground speed.
        const sp = Math.hypot(...b.vel), drop = (ROLL_DECEL + ROLL_DRAG * sp) * dt, k = sp > drop ? (sp - drop) / sp : 0;
        for (let i = 0; i < 3; i++) b.vel[i] *= k;
        b.spin = [ground[1] * b.vel[2] - ground[2] * b.vel[1], ground[2] * b.vel[0] - ground[0] * b.vel[2], ground[0] * b.vel[1] - ground[1] * b.vel[0]].map((v) => v / b.radius);
        if (sp * k < 4) { b.still += dt; if (b.still > 0.25) { b.vel = [0, 0, 0]; b.spin = [0, 0, 0]; b.asleep = true; } } else b.still = 0;
      } else for (let i = 0; i < 3; i++) b.spin[i] *= 0.995;
      if (b.pos[2] < -3000) { this.reset(); return; } // fell out of the map
      const w = Math.hypot(...b.spin);
      if (w > 1e-3) {
        dirGl(b.spin.map((v) => v / w), this.axis);
        b.mesh.quaternion.premultiply(this.q.setFromAxisAngle(this.axis, w * dt));
      }
    }
  }

  // Someone's hull (feet at o, mins/maxs as the player's, moving at v) against the balls: a ball they walk into is
  // kicked along and pushed out of them. Returns how far they need moving back where a ball can't get out of the way
  // (against a wall), or null.
  touch(o, v, mins, maxs) {
    let back = null;
    for (const b of this.list) {
      const c = b.pos, r = b.radius;
      const near = [0, 1, 2].map((k) => Math.max(o[k] + mins[k], Math.min(o[k] + maxs[k], c[k])));
      let n = [c[0] - near[0], c[1] - near[1], c[2] - near[2]], d = Math.hypot(...n), pen = r - d;
      if (d >= r) continue;
      if (d < 1e-3) {
        // Its centre is inside the hull: out sideways, away from the hull's middle.
        n = [c[0] - o[0], c[1] - o[1], 0]; d = Math.hypot(n[0], n[1]) || 1;
        if (!n[0] && !n[1]) n = [1, 0, 0];
        pen = maxs[0] + r - d;
      }
      n = n.map((x) => x / d);
      // Kicked: it leaves faster than you walk into it, with a little lift.
      const rel = (v[0] - b.vel[0]) * n[0] + (v[1] - b.vel[1]) * n[1] + (v[2] - b.vel[2]) * n[2];
      if (rel > 0) {
        for (let k = 0; k < 3; k++) b.vel[k] += n[k] * rel * KICK;
        b.vel[2] += Math.min(90, rel * 0.2);
        this.sound(b, rel);
      }
      this.wake(b);
      const [bm, bx] = this.hull(b), want = pen + 0.1, col = this.game.collision;
      let tr = col.traceBox(c, c.map((p, k) => p + n[k] * want), bm, bx, FLAG_GRENADE);
      if (tr.normal && dot(tr.normal, n) >= 0) {
        // Only held by the floor it rests on: ease off it and push again.
        const from = c.map((p, k) => p + tr.normal[k] * 0.05);
        tr = col.traceBox(from, from.map((p, k) => p + n[k] * want), bm, bx, FLAG_GRENADE);
      }
      b.pos = tr.endpos;
      const short = want * (1 - tr.fraction);
      if (short > 0.05) back = (back || [0, 0, 0]).map((x, k) => x - n[k] * short);
    }
    return back;
  }

  // The ball a ray hits first (closer than maxT): { b, t } or null.
  ray(o, d, maxT) {
    let best = null;
    for (const b of this.list) {
      const oc = [o[0] - b.pos[0], o[1] - b.pos[1], o[2] - b.pos[2]], p = dot(oc, d), disc = p * p - (dot(oc, oc) - b.radius * b.radius);
      if (disc < 0) continue;
      const t = -p - Math.sqrt(disc);
      if (t >= 0 && t < maxT && (!best || t < best.t)) best = { b, t };
    }
    return best;
  }

  // A bullet or a knife along a ray: the ball it hits is knocked along it (speed: how hard). True if one was hit.
  shot(o, d, maxT, speed) {
    const hit = this.ray(o, d, maxT);
    if (!hit) return false;
    const { b, t } = hit, g = this.game;
    for (let k = 0; k < 3; k++) b.vel[k] += d[k] * speed;
    b.vel[2] += speed * 0.15;
    b.spin = b.spin.map((w) => w + (Math.random() - 0.5) * 20);
    this.wake(b);
    g.sounds.play('Ball.BulletImpact', { pos: [0, 1, 2].map((k) => o[k] + d[k] * t), listener: g, volume: 0.6 });
    return true;
  }

  // An HE blast: balls in the open within radius fly away from it.
  blast(p, radius) {
    const g = this.game;
    for (const b of this.list) {
      const dv = [b.pos[0] - p[0], b.pos[1] - p[1], b.pos[2] - p[2]], d = Math.hypot(...dv);
      if (d > radius || !g.lineOfSight([p[0], p[1], p[2] + 4], b.pos)) continue;
      const f = 1 - d / radius, n = d > 1 ? dv.map((x) => x / d) : [0, 0, 1];
      for (let k = 0; k < 3; k++) b.vel[k] += n[k] * BLAST * f;
      b.vel[2] += 300 * f;
      b.spin = b.spin.map((w) => w + (Math.random() - 0.5) * 30 * f);
      this.wake(b);
    }
  }

  // A flying grenade (pos, vel; 2 units across) that moved from `from` this tick, against the balls: where its path
  // meets one they bounce off each other (about the same weight).
  bump(n, from) {
    for (const b of this.list) {
      const min = b.radius + 2, seg = [0, 1, 2].map((k) => n.pos[k] - from[k]), len = Math.hypot(...seg);
      let at = null;
      if (len > 1e-6) {
        const d = seg.map((x) => x / len), oc = [0, 1, 2].map((k) => from[k] - b.pos[k]), p = dot(oc, d), disc = p * p - (dot(oc, oc) - min * min);
        const t = disc >= 0 ? -p - Math.sqrt(disc) : -1;
        if (t >= 0 && t <= len) at = from.map((q, k) => q + d[k] * t);
      }
      if (!at && Math.hypot(n.pos[0] - b.pos[0], n.pos[1] - b.pos[1], n.pos[2] - b.pos[2]) < min) at = n.pos;
      if (!at) continue;
      const dv = [at[0] - b.pos[0], at[1] - b.pos[1], at[2] - b.pos[2]], dl = Math.hypot(...dv);
      if (dl < 1e-3) continue;
      const nrm = dv.map((x) => x / dl);
      n.pos = b.pos.map((p, k) => p + nrm[k] * (min + 0.1));
      const vn = (n.vel[0] - b.vel[0]) * nrm[0] + (n.vel[1] - b.vel[1]) * nrm[1] + (n.vel[2] - b.vel[2]) * nrm[2];
      if (vn >= 0) continue;
      const j = (-(1 + NADE_BOUNCE) * vn) / 2;
      for (let k = 0; k < 3; k++) { n.vel[k] += nrm[k] * j; b.vel[k] -= nrm[k] * j; }
      this.wake(b);
      this.sound(b, -vn);
      return true;
    }
    return false;
  }

  // Where it's drawn (between ticks) and lit (the light probes where it is).
  update(alpha, probes) {
    for (const b of this.list) {
      toGl(b.prev.map((p, k) => p + (b.pos[k] - p) * alpha), b.mesh.position);
      if (probes && (b.lit < 0 || (!b.asleep && this.game.frameNo % 4 === 0))) { b.amb.set(probes, b.pos); b.lit = 0; }
    }
  }

  dispose() { for (const b of this.list) b.mesh.parent?.remove(b.mesh); }
}
