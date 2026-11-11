// Player movement, ported from Source's game movement (the code CS2's movement grew from): friction, ground and air
// acceleration, sliding the player's box along walls (TryPlayerMove), stepping up stairs and ledges (StepMove),
// jumping, crouching and crouch-jumping, and ladders (LadderMove: CS2 maps mark ladders with the "ladder" surface).
// Units are CS2's: inches and seconds, Z up.
import { FLAG_PLAYER } from './collision.js';

export const MOVE = {
  gravity: 800, friction: 5.2, stopSpeed: 80, accelerate: 5.5, airAccelerate: 12, airMaxWishSpeed: 30,
  maxSpeed: 320, stepSize: 18, jumpImpulse: 301.993, walkScale: 0.52, duckScale: 0.34, duckTime: 0.125,
  climbSpeed: 200 * 0.78, ladderDistance: 2, ladderJump: 270, // MAX_CLIMB_SPEED x sv_ladder_scale_speed
  // CS2's speeds past the weapon's own: runSpeed, CS_PLAYER_SPEED_RUN (with no weapon, and what no weapon goes past);
  // climbScale, CS_PLAYER_SPEED_CLIMB_MODIFIER (walking or crouching on a ladder: the quiet climb); bhopScale, a jump keeps
  // no more than 1.1× your speed (sv_enablebunnyhopping 0); landing: sv_staminamax, sv_staminalandcost and
  // sv_staminarecoveryrate (CS2's landing penalty goes by how fast you land, as that stamina did); tagging: wears off at
  // tagRecovery a second, tagDelay after the hit (sv_predictable_damage_tag_ticks 2).
  runSpeed: 260, climbScale: 0.34, bhopScale: 1.1, staminaMax: 80, staminaLandCost: 0.05, staminaRecovery: 60,
  tagRecovery: 0.4, tagDelay: 2 / 64,
};
export const HULL_STAND = { mins: [-16, -16, 0], maxs: [16, 16, 72] };
export const HULL_DUCK = { mins: [-16, -16, 0], maxs: [16, 16, 54] };
export const EYE_STAND = 64.06, EYE_DUCK = 46.05;
const DUCK_DIFF = HULL_STAND.maxs[2] - HULL_DUCK.maxs[2];
// Crouching in the air brings the legs up half of that (and the head down the other half): a crouch-jump is 57 + 9 = 66
// high, CS2's, short of a standing player's 72 (you can't jump onto one's head, only a crouching one's). TUCK_AMOUNT: how
// much of the crouch that is, so the view stays where it was as the legs come up (and goes on down with the crouch).
const TUCK = DUCK_DIFF / 2, TUCK_AMOUNT = TUCK / (EYE_STAND - EYE_DUCK);
const NON_JUMP_VELOCITY = 140;
const DUCK_SPEED = 8, DUCK_SPEED_MIN = 1.5, DUCK_SPAM = 2, DUCK_RECOVER = 3; // CS2's duck speed (see duck)

// The weapon's speed a move asks for (cmd.maxSpeed), none (or past it): runSpeed.
const weaponSpeed = (cmd) => Math.min(MOVE.runSpeed, cmd.maxSpeed || MOVE.runSpeed);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
// Scratch for a tick's working (you and every bot move each tick, with many traces each: arrays made for them were
// garbage by the end of it). A trace's result is its own: origin takes its endpos. (Plain arrays, like the positions
// the traces and helpers get from everywhere else: see collision.js.)
const _wish = [0, 0, 0], _end = [0, 0, 0], _end2 = [0, 0, 0], _orig = [0, 0, 0], _primal = [0, 0, 0];

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
    this.stamina = 0; // the landing penalty (0..staminaMax: see landingScale)
    this.velocityModifier = 1; // tagging: 1 full speed .. 0 stopped (see tag)
    this.tags = []; // hits whose slowdown is still to come: [large, small, seconds]
    this.categorize();
  }

  get hull() { return this.ducked ? HULL_DUCK : HULL_STAND; }
  get eyeHeight() { return EYE_STAND + (EYE_DUCK - EYE_STAND) * this.duckAmount; }
  eye() { return [this.origin[0], this.origin[1], this.origin[2] + this.eyeHeight]; }
  speed2d() { return Math.hypot(this.velocity[0], this.velocity[1]); }

  trace(start, end, hull = this.hull) { return this.world.traceBox(start, end, hull.mins, hull.maxs, FLAG_PLAYER); }
  // Whether a hull fits at a point (nothing solid inside it). A trace that doesn't move can't tell: it lets a box that
  // starts inside something move out of it, so it never reports being inside. Standing up in the air (the legs dropped
  // back down) went by one, and the legs dropped into the top of whatever you were landing on: stuck. This asks the
  // world straight out, the box shrunk a hair so resting on a floor or against a wall doesn't count.
  fits(origin, hull) {
    const e = 0.125, min = [origin[0] + hull.mins[0] + e, origin[1] + hull.mins[1] + e, origin[2] + hull.mins[2] + e];
    const max = [origin[0] + hull.maxs[0] - e, origin[1] + hull.maxs[1] - e, origin[2] + hull.maxs[2] - e];
    if (this.world.boxOverlap) return !this.world.boxOverlap(min, max, FLAG_PLAYER, true);
    const tr = this.trace(origin, origin, hull);
    return !tr.startsolid && !tr.normal;
  }

  teleport(origin) {
    this.origin = origin.slice();
    this.velocity = [0, 0, 0];
    this.ducked = false; this.duckAmount = 0;
    this.onLadder = false;
    this.stamina = 0; this.velocityModifier = 1; this.tags.length = 0;
    this.categorize();
  }

  // How fast you can go this tick, as CS2 works it out: your weapon's speed (cmd.maxSpeed; none, or past it:
  // runSpeed), on the ground slowed by being hit (tagging) and by a landing, then crouched (×0.34) or walking (×0.52).
  topSpeed(cmd) {
    let s = weaponSpeed(cmd);
    if (this.onGround) s *= this.velocityModifier * this.landingScale();
    if (this.ducked && this.onGround) s *= MOVE.duckScale;
    else if (cmd.walk) s *= MOVE.walkScale;
    return s;
  }
  // The landing penalty's share of your speed: (1 - stamina / 100)², as CS2's stamina slowdown is.
  landingScale() { const k = 1 - this.stamina / 100; return k * k; }

  // Hit (CS2's tagging), by a weapon with these flinch velocity modifiers (its data's large and small): the first hit
  // slows you to the large one, each one after takes you down by the small one's share of what's left (never back up);
  // it comes after tagDelay and wears off at tagRecovery a second. Only on the ground (see topSpeed).
  tag(large = 1, small = 1) { if (large < 1 || small < 1) this.tags.push([large, small, MOVE.tagDelay]); }

  // Tagging and the landing penalty wearing off, and hits coming in (each tick, before the move).
  recover(dt) {
    if (this.stamina > 0) this.stamina = Math.max(0, this.stamina - MOVE.staminaRecovery * dt);
    if (this.velocityModifier < 1) this.velocityModifier = Math.min(1, this.velocityModifier + MOVE.tagRecovery * dt);
    for (let i = 0; i < this.tags.length; i++) {
      const t = this.tags[i];
      if ((t[2] -= dt) > 1e-9) continue;
      this.velocityModifier = Math.max(0, Math.min(this.velocityModifier, t[0], this.velocityModifier * t[1]));
      this.tags.splice(i--, 1);
    }
  }

  // One movement tick. cmd: { forward, side (-1..1, +side = right), yaw, pitch (degrees), jump, jumpPress, duck, walk, maxSpeed }.
  // jumpPress: a fresh press this tick even though jump was down the tick before (a mouse wheel notch, see Input).
  tick(dt, cmd) {
    this.duck(dt, cmd.duck);
    this.recover(dt);
    if (this.ladderMove(cmd)) {
      this.jumpHeld = !!cmd.jump;
      this.tryPlayerMove(dt);
      const wasOnGround = this.onGround;
      this.categorize();
      this.fallVelocity = 0;
      return;
    }
    const maxSpeed = this.topSpeed(cmd);

    // Forward (cos, sin) and right (sin, -cos) by the keys.
    const yaw = (cmd.yaw * Math.PI) / 180, cy = Math.cos(yaw), sy = Math.sin(yaw), wish = _wish;
    wish[0] = cy * cmd.forward + sy * cmd.side; wish[1] = sy * cmd.forward - cy * cmd.side; wish[2] = 0;
    const wl = Math.hypot(wish[0], wish[1]);
    const wishSpeed = wl > 0 ? maxSpeed * Math.min(1, wl) : 0;
    if (wl > 0) { wish[0] /= wl; wish[1] /= wl; }

    // Jump (needs a fresh press: CS2 has no auto bunny hop, but every mouse wheel notch is one), at no more than 1.1× your
    // weapon's speed (sv_enablebunnyhopping 0: a bunny hop keeps what it had, up to that).
    if ((cmd.jumpPress || (cmd.jump && !this.jumpHeld)) && this.onGround) {
      const cap = MOVE.bhopScale * weaponSpeed(cmd), sp = this.speed2d();
      if (sp > cap) { this.velocity[0] *= cap / sp; this.velocity[1] *= cap / sp; }
      this.velocity[2] = MOVE.jumpImpulse;
      this.onGround = false;
      this.jumped = true;
    }
    this.jumpHeld = !!cmd.jump;

    if (this.onGround) {
      this.velocity[2] = 0;
      this.friction(dt);
      this.accelerate(wish, wishSpeed, MOVE.accelerate, dt, weaponSpeed(cmd));
      // Never faster than the weapon's speed on the ground.
      const sp = this.speed2d();
      if (sp > maxSpeed && sp > 0) { this.velocity[0] *= maxSpeed / sp; this.velocity[1] *= maxSpeed / sp; }
      // Source's WalkMove: under 1 unit/s it stops dead and doesn't move (nor trace: bots holding an angle cost nothing).
      if (sp < 1) this.velocity[0] = this.velocity[1] = 0;
      else this.walkMove(dt);
    } else {
      this.velocity[2] -= MOVE.gravity * dt * 0.5;
      this.fallVelocity = -this.velocity[2]; // before the move: landing clips it to zero
      this.airAccelerate(wish, wishSpeed, MOVE.airAccelerate, dt);
      this.tryPlayerMove(dt);
      this.velocity[2] -= MOVE.gravity * dt * 0.5;
    }
    const wasOnGround = this.onGround, fall = Math.max(-this.velocity[2], this.fallVelocity || 0);
    this.categorize();
    if (!wasOnGround && this.onGround) { this.landed = fall; this.velocity[2] = 0; this.land(fall); }
    if (this.onGround) this.fallVelocity = 0;
  }

  // Landing slows you for a moment, the more the faster you came down: sv_staminalandcost of the fall speed (a jump's
  // landing: 15, so 72% of your speed, back in a quarter of a second), up to sv_staminamax.
  land(fall) { this.stamina = Math.min(MOVE.staminaMax, Math.max(this.stamina, MOVE.staminaLandCost * fall)); }

  // Source's LadderMove: moving into a ladder surface climbs it. Forward climbs towards where you look (look down and
  // press forward to go down), back goes the other way, strafing slides sideways, jump pushes you off.
  ladderMove(cmd) {
    if (!this.world.ladders.size) { this.onLadder = false; return false; } // (a bot's world has none: see BotBrain.physics)
    if (!this.onLadder && !cmd.forward && !cmd.side) return false;
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
    if (cmd.jumpPress || (cmd.jump && !this.jumpHeld)) {
      this.onLadder = false;
      this.velocity = n.map((v) => v * MOVE.ladderJump);
      this.onGround = false;
      return true;
    }
    // Walking or crouching, you climb at climbScale of the speed (CS2's slow, quiet climb).
    const climb = MOVE.climbSpeed * (cmd.walk || cmd.duck ? MOVE.climbScale : 1);
    const fs = cmd.forward * climb, rs = cmd.side * climb;
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
    const v = this.velocity, speed = Math.hypot(v[0], v[1], v[2]);
    if (speed < 0.1) return;
    const control = speed < MOVE.stopSpeed ? MOVE.stopSpeed : speed;
    const ns = Math.max(0, speed - control * MOVE.friction * dt);
    const k = ns / speed;
    v[0] *= k; v[1] *= k; v[2] *= k;
  }

  // scale: how hard you speed up, by your weapon's speed (sv_accelerate_use_weapon_speed), not by the walking or crouching
  // speed you're after: by that, the friction under 80 units/s (sv_stopspeed) outdid it, and crouching with anything
  // slower than a knife (or walking scoped) crept along at a few units a second.
  accelerate(dir, wishSpeed, accel, dt, scale = wishSpeed) {
    const add = wishSpeed - dot(this.velocity, dir);
    if (add <= 0) return;
    const a = Math.min(add, accel * dt * Math.max(wishSpeed, scale));
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
    const planes = (this.planes ||= []), vel = this.velocity, original = _orig, primal = _primal, end = _end;
    planes.length = 0;
    for (let k = 0; k < 3; k++) original[k] = primal[k] = vel[k];
    let timeLeft = dt;
    for (let bump = 0; bump < 4; bump++) {
      if (!vel[0] && !vel[1] && !vel[2]) break;
      for (let k = 0; k < 3; k++) end[k] = this.origin[k] + vel[k] * timeLeft;
      const tr = this.trace(this.origin, end);
      if (tr.fraction > 0) { this.origin = tr.endpos; planes.length = 0; for (let k = 0; k < 3; k++) original[k] = vel[k]; }
      if (tr.fraction === 1 || !tr.normal) break;
      timeLeft -= timeLeft * tr.fraction;
      if (planes.length >= 5) { vel[0] = vel[1] = vel[2] = 0; break; }
      planes.push(tr.normal);
      // Find a velocity that doesn't go back into any plane we've hit this tick.
      let i;
      for (i = 0; i < planes.length; i++) {
        clip(original, planes[i], 1, vel);
        let j;
        for (j = 0; j < planes.length; j++) if (j !== i && dot(vel, planes[j]) < 0) break;
        if (j === planes.length) break;
      }
      if (i === planes.length) {
        if (planes.length !== 2) { vel[0] = vel[1] = vel[2] = 0; break; }
        // Slide along the crease between the two planes.
        const a = planes[0], b = planes[1];
        const dx = a[1] * b[2] - a[2] * b[1], dy = a[2] * b[0] - a[0] * b[2], dz = a[0] * b[1] - a[1] * b[0];
        const l = Math.hypot(dx, dy, dz) || 1;
        const d = (dx * vel[0] + dy * vel[1] + dz * vel[2]) / l;
        vel[0] = (dx / l) * d; vel[1] = (dy / l) * d; vel[2] = (dz / l) * d;
      }
      if (dot(vel, primal) <= 0) { vel[0] = vel[1] = vel[2] = 0; break; }
    }
    planes.length = 0;
  }

  // Ground movement with stair/ledge stepping: try the plain move and the move from one step higher, keep whichever
  // gets further.
  walkMove(dt) {
    const dest = _end2;
    dest[0] = this.origin[0] + this.velocity[0] * dt; dest[1] = this.origin[1] + this.velocity[1] * dt; dest[2] = this.origin[2];
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
    const start = _end, below = _end2, o = this.origin;
    start[0] = below[0] = o[0]; start[1] = below[1] = o[1]; start[2] = o[2] + 2; below[2] = o[2] - MOVE.stepSize;
    const up = this.trace(o, start);
    const tr = this.trace(up.endpos, below);
    if (tr.fraction > 0 && tr.fraction < 1 && !tr.startsolid && tr.normal && tr.normal[2] >= 0.7) {
      if (Math.abs(this.origin[2] - tr.endpos[2]) > 0.5 * 0.03125) this.origin = tr.endpos;
    }
  }

  categorize() {
    if (this.velocity[2] > NON_JUMP_VELOCITY) { this.onGround = false; this.groundNormal = null; return; }
    const below = _end, o = this.origin;
    below[0] = o[0]; below[1] = o[1]; below[2] = o[2] - 2;
    const tr = this.trace(o, below);
    if (tr.normal && tr.fraction < 1 && tr.normal[2] >= 0.7) {
      this.onGround = true;
      this.groundNormal = tr.normal;
      this.groundTri = tr.tri;
      if (tr.fraction > 0) this.origin = tr.endpos;
    } else { this.onGround = false; this.groundNormal = null; }
  }

  // Crouching: on the ground the box shrinks from the top; in the air it pulls the legs up (crouch-jumping). How fast it
  // goes down and up is CS2's duck speed: 8 (an eighth of a second), less 2 for every new crouch (down to 1.5, two thirds
  // of a second), coming back at 3 a second: spam crouch and it gets slow.
  duck(dt, want) {
    this.duckSpeed = Math.min(DUCK_SPEED, (this.duckSpeed ?? DUCK_SPEED) + DUCK_RECOVER * dt);
    if (want && !this.duckHeld) this.duckSpeed = Math.max(DUCK_SPEED_MIN, this.duckSpeed - DUCK_SPAM);
    this.duckHeld = !!want;
    if (want) {
      if (!this.ducked) {
        if (!this.onGround) { this.origin[2] += TUCK; this.duckAmount = Math.min(1, this.duckAmount + TUCK_AMOUNT); }
        this.ducked = true;
      }
      this.duckAmount = Math.min(1, this.duckAmount + dt * this.duckSpeed);
    } else {
      if (this.ducked) {
        // Stand up only if there's room (in the air, by dropping the legs back down).
        const start = this.onGround ? this.origin : [this.origin[0], this.origin[1], this.origin[2] - TUCK];
        if (this.fits(start, HULL_STAND)) {
          if (!this.onGround) { this.origin = start.slice(); this.duckAmount = Math.max(0, this.duckAmount - TUCK_AMOUNT); }
          this.ducked = false;
        } else if (!this.onGround && this.fits(this.origin, HULL_STAND)) this.ducked = false; // no room to drop the legs: standing in place
      }
      if (!this.ducked) this.duckAmount = Math.max(0, this.duckAmount - dt * this.duckSpeed);
    }
  }
}

function clip(v, n, overbounce, out = [0, 0, 0]) {
  const backoff = dot(v, n) * overbounce;
  for (let i = 0; i < 3; i++) out[i] = v[i] - n[i] * backoff;
  const adjust = dot(out, n);
  if (adjust < 0) for (let i = 0; i < 3; i++) out[i] -= n[i] * adjust;
  return out;
}
