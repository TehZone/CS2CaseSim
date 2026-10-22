// Player movement, ported from Source's game movement (the code CS2's movement grew from): friction, ground and air
// acceleration, sliding the player's box along walls (TryPlayerMove), stepping up stairs and ledges (StepMove),
// jumping, crouching and crouch-jumping, and ladders (LadderMove: CS2 maps mark ladders with the "ladder" surface).
// Units are CS2's: inches and seconds, Z up.
import { FLAG_PLAYER } from './collision.js';

export const MOVE = {
  gravity: 800, friction: 5.2, stopSpeed: 80, accelerate: 5.5, airAccelerate: 12, airMaxWishSpeed: 30,
  maxSpeed: 320, stepSize: 18, jumpImpulse: 301.993, walkScale: 0.52, duckScale: 0.34, duckTime: 0.125,
  climbSpeed: 200 * 0.78, ladderDistance: 2, ladderJump: 270, // MAX_CLIMB_SPEED x sv_ladder_scale_speed
};
export const HULL_STAND = { mins: [-16, -16, 0], maxs: [16, 16, 72] };
export const HULL_DUCK = { mins: [-16, -16, 0], maxs: [16, 16, 54] };
export const EYE_STAND = 64.06, EYE_DUCK = 46.05;
const DUCK_DIFF = HULL_STAND.maxs[2] - HULL_DUCK.maxs[2];
const NON_JUMP_VELOCITY = 140;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export class PlayerMovement {
  constructor(world, origin = [0, 0, 0]) {
    this.world = world;
    this.origin = origin.slice();
    this.velocity = [0, 0, 0];
    this.onGround = false;
    this.groundNormal = null;
    this.ducked = false; // hull is the crouched one
    this.duckAmount = 0; // 0 standing .. 1 crouched (eye height blend)
    this.jumpHeld = false;
    this.landed = 0; // fall speed of the latest landing (for sounds), consumed by the caller
    this.categorize();
  }

  get hull() { return this.ducked ? HULL_DUCK : HULL_STAND; }
  get eyeHeight() { return EYE_STAND + (EYE_DUCK - EYE_STAND) * this.duckAmount; }
  eye() { return [this.origin[0], this.origin[1], this.origin[2] + this.eyeHeight]; }
  speed2d() { return Math.hypot(this.velocity[0], this.velocity[1]); }

  trace(start, end, hull = this.hull) { return this.world.traceBox(start, end, hull.mins, hull.maxs, FLAG_PLAYER); }

  teleport(origin) {
    this.origin = origin.slice();
    this.velocity = [0, 0, 0];
    this.ducked = false; this.duckAmount = 0;
    this.onLadder = false;
    this.categorize();
  }

  // One movement tick. cmd: { forward, side (-1..1, +side = right), yaw, pitch (degrees), jump, duck, walk, maxSpeed }.
  tick(dt, cmd) {
    this.duck(dt, cmd.duck);
    if (this.ladderMove(cmd)) {
      this.jumpHeld = !!cmd.jump;
      this.tryPlayerMove(dt);
      const wasOnGround = this.onGround;
      this.categorize();
      this.fallVelocity = 0;
      return;
    }
    let maxSpeed = Math.min(MOVE.maxSpeed, cmd.maxSpeed || 250);
    if (this.ducked && this.onGround) maxSpeed *= MOVE.duckScale;
    else if (cmd.walk) maxSpeed *= MOVE.walkScale;

    const yaw = (cmd.yaw * Math.PI) / 180;
    const fwd = [Math.cos(yaw), Math.sin(yaw), 0], right = [Math.sin(yaw), -Math.cos(yaw), 0];
    let wish = [fwd[0] * cmd.forward + right[0] * cmd.side, fwd[1] * cmd.forward + right[1] * cmd.side, 0];
    const wl = Math.hypot(wish[0], wish[1]);
    const wishSpeed = wl > 0 ? maxSpeed * Math.min(1, wl) : 0;
    if (wl > 0) wish = [wish[0] / wl, wish[1] / wl, 0];

    // Jump (needs a fresh press: CS2 has no auto bunny hop)
    if (cmd.jump && !this.jumpHeld && this.onGround) {
      this.velocity[2] = MOVE.jumpImpulse;
      this.onGround = false;
      this.jumped = true;
    }
    this.jumpHeld = !!cmd.jump;

    if (this.onGround) {
      this.velocity[2] = 0;
      this.friction(dt);
      this.accelerate(wish, wishSpeed, MOVE.accelerate, dt);
      // Never faster than the weapon's speed on the ground.
      const sp = this.speed2d();
      if (sp > maxSpeed && sp > 0) { this.velocity[0] *= maxSpeed / sp; this.velocity[1] *= maxSpeed / sp; }
      this.walkMove(dt);
    } else {
      this.velocity[2] -= MOVE.gravity * dt * 0.5;
      this.fallVelocity = -this.velocity[2]; // before the move: landing clips it to zero
      this.airAccelerate(wish, wishSpeed, MOVE.airAccelerate, dt);
      this.tryPlayerMove(dt);
      this.velocity[2] -= MOVE.gravity * dt * 0.5;
    }
    const wasOnGround = this.onGround, fall = Math.max(-this.velocity[2], this.fallVelocity || 0);
    this.categorize();
    if (!wasOnGround && this.onGround) { this.landed = fall; this.velocity[2] = 0; }
    if (this.onGround) this.fallVelocity = 0;
  }

  // Source's LadderMove: moving into a ladder surface climbs it. Forward climbs towards where you look (look down and
  // press forward to go down), back goes the other way, strafing slides sideways, jump pushes you off.
  ladderMove(cmd) {
    let wish;
    const yaw = (cmd.yaw * Math.PI) / 180, pitch = ((cmd.pitch || 0) * Math.PI) / 180;
    const fwd = [Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), -Math.sin(pitch)];
    const right = [Math.sin(yaw), -Math.cos(yaw), 0];
    if (this.onLadder) wish = this.ladderNormal.map((v) => -v);
    else {
      if (!cmd.forward && !cmd.side) return false;
      wish = [0, 1, 2].map((i) => fwd[i] * cmd.forward + right[i] * cmd.side);
      wish[2] = 0;
      const l = Math.hypot(...wish);
      if (l < 1e-6) return false;
      wish = wish.map((v) => v / l);
    }
    // The ladder in that direction, unless something else is in front of it (ladders often share their plane with a clip).
    const end = this.origin.map((o, i) => o + wish[i] * MOVE.ladderDistance);
    const tr = this.world.ladders.size ? this.world.traceBox(this.origin, end, this.hull.mins, this.hull.maxs, FLAG_PLAYER, this.world.ladders) : null;
    if (!tr?.normal || tr.fraction === 1 || Math.abs(tr.normal[2]) > 0.7 || this.trace(this.origin, end).fraction < tr.fraction - 0.01) { this.onLadder = false; return false; }
    this.onLadder = true;
    const n = tr.normal;
    this.ladderNormal = n;
    const onFloor = this.onGround;
    if (cmd.jump && !this.jumpHeld) {
      this.onLadder = false;
      this.velocity = n.map((v) => v * MOVE.ladderJump);
      this.onGround = false;
      return true;
    }
    const fs = cmd.forward * MOVE.climbSpeed, rs = cmd.side * MOVE.climbSpeed;
    if (!fs && !rs) { this.velocity = [0, 0, 0]; return true; }
    const vel = [0, 1, 2].map((i) => fwd[i] * fs + right[i] * rs);
    const perp = cross([0, 0, 1], n), pl = Math.hypot(...perp) || 1;
    for (let i = 0; i < 3; i++) perp[i] /= pl;
    const normal = dot(vel, n);
    const lateral = vel.map((v, i) => v - n[i] * normal);
    const up = cross(n, perp);
    this.velocity = lateral.map((v, i) => v - up[i] * normal);
    if (onFloor && normal > 0) for (let i = 0; i < 3; i++) this.velocity[i] += n[i] * MOVE.climbSpeed; // stepping off at the bottom
    return true;
  }

  friction(dt) {
    const speed = Math.hypot(...this.velocity);
    if (speed < 0.1) return;
    const control = speed < MOVE.stopSpeed ? MOVE.stopSpeed : speed;
    const ns = Math.max(0, speed - control * MOVE.friction * dt);
    const k = ns / speed;
    this.velocity = this.velocity.map((v) => v * k);
  }

  accelerate(dir, wishSpeed, accel, dt) {
    const add = wishSpeed - dot(this.velocity, dir);
    if (add <= 0) return;
    const a = Math.min(add, accel * dt * wishSpeed);
    for (let i = 0; i < 3; i++) this.velocity[i] += a * dir[i];
  }

  airAccelerate(dir, wishSpeed, accel, dt) {
    const capped = Math.min(wishSpeed, MOVE.airMaxWishSpeed);
    const add = capped - dot(this.velocity, dir);
    if (add <= 0) return;
    const a = Math.min(add, accel * wishSpeed * dt);
    for (let i = 0; i < 3; i++) this.velocity[i] += a * dir[i];
  }

  // Slides the box along everything it touches during this tick (up to 4 bumps).
  tryPlayerMove(dt) {
    const planes = [];
    const original = this.velocity.slice(), primal = this.velocity.slice();
    let timeLeft = dt;
    for (let bump = 0; bump < 4; bump++) {
      if (!this.velocity[0] && !this.velocity[1] && !this.velocity[2]) break;
      const end = this.origin.map((o, i) => o + this.velocity[i] * timeLeft);
      const tr = this.trace(this.origin, end);
      if (tr.fraction > 0) { this.origin = tr.endpos; planes.length = 0; original.splice(0, 3, ...this.velocity); }
      if (tr.fraction === 1 || !tr.normal) break;
      timeLeft -= timeLeft * tr.fraction;
      if (planes.length >= 5) { this.velocity = [0, 0, 0]; break; }
      planes.push(tr.normal);
      // Find a velocity that doesn't go back into any plane we've hit this tick.
      let i;
      for (i = 0; i < planes.length; i++) {
        this.velocity = clip(original, planes[i], 1);
        let j;
        for (j = 0; j < planes.length; j++) if (j !== i && dot(this.velocity, planes[j]) < 0) break;
        if (j === planes.length) break;
      }
      if (i === planes.length) {
        if (planes.length !== 2) { this.velocity = [0, 0, 0]; break; }
        // Slide along the crease between the two planes.
        const a = planes[0], b = planes[1];
        const dir = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
        const l = Math.hypot(...dir) || 1;
        const d = dot(dir, this.velocity) / l;
        this.velocity = dir.map((x) => (x / l) * d);
      }
      if (dot(this.velocity, primal) <= 0) { this.velocity = [0, 0, 0]; break; }
    }
  }

  // Ground movement with stair/ledge stepping: try the plain move and the move from one step higher, keep whichever
  // gets further.
  walkMove(dt) {
    const dest = [this.origin[0] + this.velocity[0] * dt, this.origin[1] + this.velocity[1] * dt, this.origin[2]];
    const tr = this.trace(this.origin, dest);
    if (tr.fraction === 1) { this.origin = tr.endpos; this.stayOnGround(); return; }
    const pos = this.origin.slice(), vel = this.velocity.slice();
    this.tryPlayerMove(dt);
    const downPos = this.origin.slice(), downVel = this.velocity.slice();
    this.origin = pos.slice(); this.velocity = vel.slice();
    const up = this.trace(this.origin, [pos[0], pos[1], pos[2] + MOVE.stepSize + 0.03125]);
    if (!up.startsolid) this.origin = up.endpos;
    this.tryPlayerMove(dt);
    const down = this.trace(this.origin, [this.origin[0], this.origin[1], this.origin[2] - MOVE.stepSize - 0.03125]);
    if (!down.startsolid) this.origin = down.endpos;
    if (down.fraction < 1 && down.normal && down.normal[2] < 0.7) { this.origin = downPos; this.velocity = downVel; return; }
    const dDown = (downPos[0] - pos[0]) ** 2 + (downPos[1] - pos[1]) ** 2;
    const dUp = (this.origin[0] - pos[0]) ** 2 + (this.origin[1] - pos[1]) ** 2;
    if (dDown > dUp) { this.origin = downPos; this.velocity = downVel; } else this.velocity[2] = downVel[2];
    this.stayOnGround();
  }

  // Keeps the player glued to the ground walking down slopes and steps.
  stayOnGround() {
    const start = [this.origin[0], this.origin[1], this.origin[2] + 2];
    const up = this.trace(this.origin, start);
    const tr = this.trace(up.endpos, [this.origin[0], this.origin[1], this.origin[2] - MOVE.stepSize]);
    if (tr.fraction > 0 && tr.fraction < 1 && !tr.startsolid && tr.normal && tr.normal[2] >= 0.7) {
      if (Math.abs(this.origin[2] - tr.endpos[2]) > 0.5 * 0.03125) this.origin = tr.endpos;
    }
  }

  categorize() {
    if (this.velocity[2] > NON_JUMP_VELOCITY) { this.onGround = false; this.groundNormal = null; return; }
    const tr = this.trace(this.origin, [this.origin[0], this.origin[1], this.origin[2] - 2]);
    if (tr.normal && tr.fraction < 1 && tr.normal[2] >= 0.7) {
      this.onGround = true;
      this.groundNormal = tr.normal;
      this.groundTri = tr.tri;
      if (tr.fraction > 0) this.origin = tr.endpos;
    } else { this.onGround = false; this.groundNormal = null; }
  }

  // Crouching: on the ground the box shrinks from the top; in the air it pulls the legs up (crouch-jumping).
  duck(dt, want) {
    if (want) {
      if (!this.ducked) {
        if (!this.onGround) this.origin[2] += DUCK_DIFF; // keep the head where it is
        this.ducked = true;
        if (!this.onGround) this.duckAmount = 1;
      }
      this.duckAmount = Math.min(1, this.duckAmount + dt / MOVE.duckTime);
    } else {
      if (this.ducked) {
        // Stand up only if there's room (in the air, by dropping the legs back down).
        const start = this.onGround ? this.origin : [this.origin[0], this.origin[1], this.origin[2] - DUCK_DIFF];
        const tr = this.trace(start, start, HULL_STAND);
        if (!tr.startsolid && tr.fraction === 1 && !tr.normal) {
          if (!this.onGround) { this.origin = start.slice(); this.duckAmount = 0; }
          this.ducked = false;
        } else if (!this.onGround) {
          // no room to drop the legs: try standing in place
          const tr2 = this.trace(this.origin, this.origin, HULL_STAND);
          if (!tr2.normal) this.ducked = false;
        }
      }
      if (!this.ducked) this.duckAmount = Math.max(0, this.duckAmount - dt / MOVE.duckTime);
    }
  }
}

function clip(v, n, overbounce) {
  const backoff = dot(v, n) * overbounce;
  const out = v.map((x, i) => x - n[i] * backoff);
  const adjust = dot(out, n);
  if (adjust < 0) for (let i = 0; i < 3; i++) out[i] -= n[i] * adjust;
  return out;
}
