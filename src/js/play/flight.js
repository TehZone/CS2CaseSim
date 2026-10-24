// A grenade's flight, as the game plays it (grenades.js) and as bots and the lineup finder (scripts/build-lineups.mjs)
// check a throw: CS2's gravity for grenades (0.4 x 800), bounces with 0.45 restitution, losing some speed along what it
// hits (more on the floor), resting once it's slow on the ground. Pure (no three.js): game units, Z up.
import { FLAG_GRENADE, FLAG_PLAYER } from './collision.js';

export const GRAVITY = 800 * 0.4, RESTITUTION = 0.45;
// Seconds before each kind goes off: HE and flashbangs on their fuse, smokes and decoys once they've stopped after it,
// molotovs when they hit the ground (or on the fuse in the air).
export const FUSE = { he: 1.5, flash: 1.65, smoke: 1.2, fire: 2.0, decoy: 1.2 };
const BOX_MIN = [-2, -2, -2], BOX_MAX = [2, 2, 2];

// CS2's throw: the aim is raised (pitch -10 + pitch * 80/90), speed 750 x 0.9 scaled by strength (1 Mouse1, 0.5 both,
// 0 Mouse2), plus 1.25x the thrower's velocity.
export function throwVelocity(pitch, yaw, strength, vel = [0, 0, 0]) {
  const p = ((-10 + pitch * (80 / 90)) * Math.PI) / 180, y = (yaw * Math.PI) / 180;
  const speed = 675 * (0.7 * strength + 0.3);
  const d = [Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), -Math.sin(p)];
  return d.map((v, i) => v * speed + vel[i] * 1.25);
}

// Where a grenade leaves the hand: 16 units in front of the eye, short of a wall right there.
export function throwOrigin(col, eye, pitch, yaw) {
  const p = (pitch * Math.PI) / 180, y = (yaw * Math.PI) / 180;
  const fwd = [Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), -Math.sin(p)];
  return col.traceBox(eye, eye.map((v, i) => v + fwd[i] * 16), BOX_MIN, BOX_MAX, FLAG_PLAYER).endpos;
}

// One tick of a grenade n ({ pos, vel, still, landed }). Returns the fastest it hit something at this tick (0 for nothing).
export function flightStep(col, n, dt) {
  if (n.still > 0.15) { n.still += dt; return 0; }
  let left = dt, hit = 0;
  for (let it = 0; it < 3 && left > 0; it++) {
    n.vel[2] -= GRAVITY * left;
    const to = [n.pos[0] + n.vel[0] * left, n.pos[1] + n.vel[1] * left, n.pos[2] + n.vel[2] * left];
    const tr = col.traceBox(n.pos, to, BOX_MIN, BOX_MAX, FLAG_GRENADE);
    n.pos = tr.endpos;
    if (!tr.normal || tr.fraction >= 1) break;
    left *= 1 - tr.fraction;
    const nrm = tr.normal;
    const vn = n.vel[0] * nrm[0] + n.vel[1] * nrm[1] + n.vel[2] * nrm[2];
    const speed = Math.hypot(n.vel[0], n.vel[1], n.vel[2]);
    for (let k = 0; k < 3; k++) n.vel[k] = (n.vel[k] - vn * nrm[k]) * (nrm[2] > 0.7 ? 0.8 : 0.95) - vn * nrm[k] * RESTITUTION;
    if (nrm[2] > 0.7) n.landed = true;
    hit = Math.max(hit, speed);
    if (nrm[2] > 0.7 && Math.hypot(n.vel[0], n.vel[1], n.vel[2]) < 25) { n.vel = [0, 0, 0]; n.still = 0.16; break; }
  }
  if (Math.hypot(n.vel[0], n.vel[1], n.vel[2]) < 5) n.still += dt; else n.still = 0;
  return hit;
}

// Whether a grenade of this kind goes off now (age: seconds since it was thrown).
export function detonates(kind, n, age) {
  if (kind === 'he' || kind === 'flash') return age >= FUSE[kind];
  if (kind === 'smoke' || kind === 'decoy') return age >= FUSE[kind] && n.still > 0.15;
  if (kind === 'fire') return !!n.landed || age >= FUSE.fire;
  return false;
}

// A whole flight, tick by tick as the game runs it: { pos (where it goes off), time, landed, path (every tick's position,
// with keepPath) }, or null when it never does (still flying after 20 seconds).
export function simulateFlight(col, origin, vel, kind, { dt = 1 / 64, keepPath = false } = {}) {
  const n = { pos: origin.slice(), vel: vel.slice(), still: 0, landed: false };
  const path = keepPath ? [origin.slice()] : null;
  for (let k = 0; k * dt < 20; k++) {
    flightStep(col, n, dt);
    if (path) path.push(n.pos.slice());
    if (detonates(kind, n, k * dt)) return { pos: n.pos, time: k * dt, landed: n.landed, path };
  }
  return null;
}
