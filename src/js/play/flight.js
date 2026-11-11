// A grenade's flight, as the game plays it (grenades.js) and as bots and the lineup finder (scripts/build-lineups.mjs)
// check a throw: CS2's gravity for grenades (0.4 x 800), and its bounce: off whatever it hits, keeping 0.45 of its
// speed (along the surface as well as off it), stopped on the ground once it's down to 20 units/s. Pure (no three.js):
// game units, Z up. Checked against CS2's own lineups (the official map guides in its install, annotations/official:
// where you stand, the aim, the throw and where the smoke ends up), flown here on the same maps: its standing throws come
// to rest within a few units of where CS2 says, and 15 of its 18 jump-throws within 10.
import { FLAG_GRENADE, FLAG_PLAYER } from './collision.js';

export const GRAVITY = 800 * 0.4, RESTITUTION = 0.45, MIN_SPEED = 20;
// A jump-throw, CS2's (a bind's, or a jump and a quick throw: CS2 throws both alike): the grenade leaves the hand
// JUMP_THROW seconds into the jump, going up with the thrower (the jump's 301.993 less sv_gravity 800 since: 218 units/s,
// plus the throw's own) from an eye risen as far (27.3 units). The time is what lands CS2's own jump-throw lineups
// where its guides say (0.1 or 0.11 misses most of them by hundreds of units).
export const JUMP_IMPULSE = 301.993, JUMP_THROW = 0.105;
export const JUMP_THROW_VZ = JUMP_IMPULSE - 800 * JUMP_THROW, JUMP_THROW_RISE = JUMP_IMPULSE * JUMP_THROW - 400 * JUMP_THROW * JUMP_THROW;
// A jump-throw from a spot: the eye it leaves from and the thrower's velocity then (standing there: no run-up). With the
// map (col), the jump is the one the player's box can make there: under a ceiling lower than the rise (a tunnel, a vent)
// the head stops on it and the jump's speed up is gone (Source clips it on the ceiling), falling from there; into a wall,
// the eye stops at it. (Without, a grenade thrown under a tunnel's ceiling started 10 units inside it and came to rest
// in it.)
const HEAD = [[-16, -16, 0], [16, 16, 7.95]]; // (the top of a player's box about the eye: 72 - 64.06 standing, 54 - 46.05 crouched)
export function jumpThrow(eye, vel = [0, 0, 0], col = null) {
  let rise = JUMP_THROW_RISE, vz = JUMP_THROW_VZ;
  const to = [eye[0] + vel[0] * JUMP_THROW, eye[1] + vel[1] * JUMP_THROW, eye[2]];
  if (col) {
    const up = col.traceBox(eye, [eye[0], eye[1], eye[2] + JUMP_THROW_RISE], HEAD[0], HEAD[1], FLAG_PLAYER);
    if (up.fraction < 1) {
      const room = Math.max(0, up.endpos[2] - eye[2]);
      const fall = JUMP_THROW - (JUMP_IMPULSE - Math.sqrt(JUMP_IMPULSE * JUMP_IMPULSE - 1600 * room)) / 800; // (since the head hit it)
      rise = room - 400 * fall * fall; vz = -800 * fall;
      if (rise <= 0) { rise = 0; vz = 0; } // (down again already)
    }
    const at = [eye[0], eye[1], eye[2] + rise];
    if (to[0] !== eye[0] || to[1] !== eye[1]) { const e = col.traceBox(at, [to[0], to[1], at[2]], HEAD[0], HEAD[1], FLAG_PLAYER).endpos; to[0] = e[0]; to[1] = e[1]; }
  }
  to[2] = eye[2] + rise;
  return { eye: to, vel: [vel[0], vel[1], vz] };
}
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

// One tick of a grenade n ({ pos, vel, still, landed }), as CS2 moves one (its ResolveFlyCollisionCustom): gravity over
// the tick (the move at the mean of the vertical speed before and after), and on hitting something the bounce: the
// speed mirrored off the surface and 0.45 of it kept, and on for the rest of the tick. Off the ground (or a slope it's
// too slow to bounce off) it stops below 20 units/s, and a fast steep bounce up off it (over 309.8 units/s, within 60
// degrees of straight up) is cut by up to half (CS2's "keep it from bouncing up like crazy when you throw it at the
// ground"). Returns how fast it hit something (0 for nothing).
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
    const speed = Math.hypot(n.vel[0], n.vel[1], n.vel[2]);
    if (nrm[2] > 0.7 || (nrm[2] > 0.1 && speed < MIN_SPEED)) {
      if (nrm[2] > 0.7) n.landed = true;
      if (speed * speed > 96000) {
        const up = (n.vel[0] * nrm[0] + n.vel[1] * nrm[1] + n.vel[2] * nrm[2]) / speed;
        if (up > 0.5) for (let k = 0; k < 3; k++) n.vel[k] *= 1.5 - up;
      }
      if (speed < MIN_SPEED) { n.vel = [0, 0, 0]; n.still = 0.16; } // (at rest on the ground)
      else push(n.vel.map((v) => v * (1 - tr.fraction) * dt));
    } else push(n.vel.map((v) => v * (1 - tr.fraction) * dt));
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
