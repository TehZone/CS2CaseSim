// A grenade's flight, as the game plays it (grenades.js) and as bots and the lineup finder (scripts/build-lineups.mjs)
// check a throw: CS2's gravity for grenades (0.4 x 800), and its bounce: off whatever it hits, keeping 0.45 of its
// speed (along the surface as well as off it), stopped once it's down to 20 units/s. Pure (no three.js): game units, Z up.
import { FLAG_GRENADE, FLAG_PLAYER } from './collision.js';

export const GRAVITY = 800 * 0.4, RESTITUTION = 0.45, MIN_SPEED = 20;
// Seconds before each kind goes off: HE and flashbangs on their fuse, smokes and decoys once they've stopped after it,
// molotovs when they hit the ground (or on the fuse in the air).
export const FUSE = { he: 1.5, flash: 1.65, smoke: 1.2, fire: 2.0, decoy: 1.2 };
const BOX_MIN = [-2, -2, -2], BOX_MAX = [2, 2, 2];

// CS2's throw (the grenades' m_flThrowVelocity, 750): the aim is raised, by 10 degrees looking level and less the further
// up or down you look (pitch - 10 x (90 - |pitch|) / 90); the speed is 750 x 0.9 scaled by strength (0.7 x strength +
// 0.3: 675 for Mouse1 at 1, 439 for both at 0.5, 203 for Mouse2 at 0), plus 1.25x the thrower's velocity.
export const throwPitch = (pitch) => pitch - ((90 - Math.abs(pitch)) * 10) / 90;
// The pitch you'd look at for a throw at this one (throwPitch's inverse).
export const aimPitch = (thrown) => (thrown >= -10 ? (thrown + 10) * 0.9 : ((thrown + 10) * 9) / 8);
export const throwSpeed = (strength) => 750 * 0.9 * (0.7 * Math.min(1, Math.max(0, strength)) + 0.3);
const along = (pitch, yaw) => {
  const p = (throwPitch(pitch) * Math.PI) / 180, y = (yaw * Math.PI) / 180;
  return [Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), -Math.sin(p)];
};
export function throwVelocity(pitch, yaw, strength, vel = [0, 0, 0]) {
  const speed = throwSpeed(strength);
  return along(pitch, yaw).map((v, i) => v * speed + vel[i] * 1.25);
}

// Where a grenade leaves the hand: from the eye (lower the softer the throw, 12 units for Mouse2), 22 units along the
// throw short of a wall right there, then 6 back.
export function throwOrigin(col, eye, pitch, yaw, strength = 1) {
  const fwd = along(pitch, yaw), from = [eye[0], eye[1], eye[2] + Math.min(1, Math.max(0, strength)) * 12 - 12];
  const end = col.traceBox(from, from.map((v, i) => v + fwd[i] * 22), BOX_MIN, BOX_MAX, FLAG_PLAYER).endpos;
  return end.map((v, i) => v - fwd[i] * 6);
}

// One tick of a grenade n ({ pos, vel, still, landed }), as CS2 moves one: gravity over the tick (the move at the mean
// of the vertical speed before and after), and on hitting something the bounce: the speed mirrored off the surface and
// 0.45 of it kept, none below 20 units/s; off a floor it goes on for the rest of the tick, off a wall it waits for the
// next. Returns how fast it hit something (0 for nothing).
export function flightStep(col, n, dt) {
  if (n.still > 0.15) { n.still += dt; return 0; }
  const vz = n.vel[2] - GRAVITY * dt;
  const move = [n.vel[0] * dt, n.vel[1] * dt, ((n.vel[2] + vz) / 2) * dt];
  n.vel[2] = vz;
  const push = (d) => { const tr = col.traceBox(n.pos, n.pos.map((v, i) => v + d[i]), BOX_MIN, BOX_MAX, FLAG_GRENADE); n.pos = tr.endpos; return tr; };
  const tr = push(move);
  let hit = 0;
  if (tr.normal && tr.fraction < 1) {
    const nrm = tr.normal, vn = n.vel[0] * nrm[0] + n.vel[1] * nrm[1] + n.vel[2] * nrm[2];
    hit = Math.hypot(n.vel[0], n.vel[1], n.vel[2]);
    for (let k = 0; k < 3; k++) n.vel[k] = (n.vel[k] - 2 * vn * nrm[k]) * RESTITUTION;
    if (Math.hypot(n.vel[0], n.vel[1], n.vel[2]) < MIN_SPEED) n.vel = [0, 0, 0];
    if (nrm[2] > 0.7) {
      n.landed = true;
      if (!n.vel[0] && !n.vel[1] && !n.vel[2]) n.still = 0.16; // (at rest on the ground)
      else push(n.vel.map((v) => v * (1 - tr.fraction) * dt));
    }
  }
  if (n.still > 0.15) return hit;
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
