// Online PvP's client-side timing (pure: scripts/test-pvp-net.mjs runs it in Node):
//  - HostTime: which host tick it is now, from when the snapshots arrive (each says its tick), and how unevenly they come;
//  - Interp: the snapshots kept by tick, everyone else drawn interp ms behind the latest (CS2's cl_interp: a snapshot's
//    interval and how late they come at worst, the p99 of the last 8 seconds, 70..200 ms; up at once when they come later,
//    down slowly), each body between the two snapshots around that time (held at the last one, after up to 50 ms of
//    carrying on, when they stop coming);
//  - ClockNudge: the client's tick rate nudged ±2% so the host always has one to three of its commands waiting, at its
//    lowest between two snapshots (fewer: it runs dry, and repeats or waits; more: the client's input waits);
//  - Ring: the client's last 128 ticks (each command and where it left the player), for reconciliation.
import { NET } from '../engine/pvp.js';
import { moveState, loadMove } from './net-codec.js';

const TICK_MS = NET.TICK * 1000;
const lerp = (a, b, k) => a + (b - a) * k;
const wrap = (a) => ((((a + 180) % 360) + 360) % 360) - 180;

const KEEP_LATE = 256; // (snapshots' lateness kept: 8 seconds of them)
export class HostTime {
  constructor() { this.offset = null; this.jit = []; this.last = -1; }
  // A snapshot of `tick` arrived at local time `now` (ms).
  arrive(tick, now) {
    const off = now - tick * TICK_MS; // (smaller: it came sooner)
    if (this.offset == null) this.offset = off;
    // The earliest arrival is the truest (a late one was held up on the way); drifting back up slowly.
    this.offset = Math.min(off, this.offset + 0.02 * (off - this.offset) + 0.05);
    this.jit.push(off - this.offset);
    if (this.jit.length > KEEP_LATE) this.jit.shift();
    this.last = Math.max(this.last, tick);
  }
  // The host tick (fractional) at local time `now`, as the latest snapshot would put it.
  tickAt(now) { return this.offset == null ? 0 : (now - this.offset) / TICK_MS; }
  // How late snapshots come at worst (ms): their lateness's p99 over the last 8 seconds (bunched ones too: a host frame that
  // ran two ticks at once, a TCP stall that let three through together), p95 while there are few.
  jitter() {
    if (this.jit.length < 4) return 0;
    const s = this.jit.slice().sort((a, b) => a - b);
    return s[Math.floor((s.length >= 64 ? 0.99 : 0.95) * (s.length - 1))];
  }
}

export class Interp {
  constructor({ keep = 48 } = {}) {
    this.keep = keep;
    this.snaps = []; // [{ tick, bodies: Map(slot -> { pos, vel, yaw, pitch, flags }) }], oldest first
    this.time = new HostTime();
    this.delay = NET.INTERP_MS;
    this.underflows = 0; this.frames = 0;
  }
  // The interpolation delay (ms): a snapshot's interval (the next one must be in by the time the last is reached) and how late
  // they come at worst, plus a few ms, within its bounds. Up at once (a stall just showed it's needed), down gently.
  adapt() {
    const want = Math.max(NET.INTERP_MIN, Math.min(NET.INTERP_MAX, NET.SNAP_TICKS * TICK_MS + this.time.jitter() + 4));
    this.delay += (want - this.delay) * (want > this.delay ? 0.3 : 0.01);
    return this.delay;
  }
  // Whether the time drawn now has run past the newest snapshot (a late frame: once a frame, NetClient.render counts them).
  late(t) { const last = this.snaps.at(-1); return !!last && t > last.tick + 0.01; }
  push(tick, bodies, now) {
    this.time.arrive(tick, now);
    const last = this.snaps.at(-1);
    if (last && tick <= last.tick) { if (tick === last.tick) last.bodies = bodies; return; }
    this.snaps.push({ tick, bodies });
    while (this.snaps.length > this.keep) this.snaps.shift();
  }
  clear() { this.snaps = []; }
  // The tick everyone else is drawn at now (fractional host ticks).
  renderTick(now) { return this.time.tickAt(now) - this.delay / TICK_MS; }
  // One body at render tick t: { pos, vel, yaw, pitch, flags, held... } between its snapshots (held after the newest, at
  // most EXTRAPOLATE_MS on), or null when there's nothing for it.
  sample(slot, t, out = {}) {
    const s = this.snaps;
    if (!s.length) return null;
    let i = s.length - 1;
    while (i > 0 && s[i - 1].tick > t) i--;
    // s[i] is the first at or after t (or the oldest); s[i-1] before it.
    let a = s[i - 1], b = s[i];
    if (!a || t >= b.tick) {
      // Past the newest (snapshots late): carry on along its velocity a little, then hold.
      const x = (a && t >= b.tick ? b : b).bodies.get(slot);
      if (!x) return null;
      const ahead = Math.max(0, Math.min(NET.EXTRAPOLATE_MS / TICK_MS, t - b.tick)) * NET.TICK;
      return Object.assign(out, x, { pos: [x.pos[0] + x.vel[0] * ahead, x.pos[1] + x.vel[1] * ahead, x.pos[2] + x.vel[2] * ahead], k: 1, from: x, to: x });
    }
    const x = a.bodies.get(slot), y = b.bodies.get(slot);
    if (!x || !y) return y || x ? Object.assign(out, y || x, { k: 1, from: y || x, to: y || x }) : null;
    const k = Math.max(0, Math.min(1, (t - a.tick) / Math.max(1e-6, b.tick - a.tick)));
    // (A jump of more than 64 units between two snapshots is a teleport, a respawn: no sliding across the map.)
    const far = Math.abs(y.pos[0] - x.pos[0]) + Math.abs(y.pos[1] - x.pos[1]) + Math.abs(y.pos[2] - x.pos[2]) > 64 * NET.SNAP_TICKS;
    const kk = far ? 1 : k;
    Object.assign(out, kk < 0.5 ? x : y);
    out.pos = [lerp(x.pos[0], y.pos[0], kk), lerp(x.pos[1], y.pos[1], kk), lerp(x.pos[2], y.pos[2], kk)];
    out.vel = [lerp(x.vel[0], y.vel[0], kk), lerp(x.vel[1], y.vel[1], kk), lerp(x.vel[2], y.vel[2], kk)];
    out.yaw = x.yaw + wrap(y.yaw - x.yaw) * kk;
    out.pitch = lerp(x.pitch, y.pitch, kk);
    out.k = kk; out.from = x; out.to = y;
    return out;
  }
}

// The client's tick rate: 1 ± CLOCK_NUDGE by the host's queue of its commands (its lowest between two snapshots: the cushion
// the host had, averaged over half a second): under QUEUE_LO, faster until it's back in the middle of QUEUE_LO..QUEUE_HI;
// over QUEUE_HI, slower until the same. (Only to the edge, a clock a little slow would sit at the edge, and run dry often.)
export class ClockNudge {
  constructor() { this.sum = 0; this.n = 0; this.at = 0; this.rate = 1; }
  // depth: the host's queue for this client at its lowest since the last snapshot; now: seconds.
  sample(depth, now) {
    this.sum += depth; this.n++;
    if (now - this.at < 0.5) return this.rate;
    const avg = this.sum / Math.max(1, this.n), mid = (NET.QUEUE_LO + NET.QUEUE_HI) / 2;
    this.sum = 0; this.n = 0; this.at = now;
    this.avg = avg;
    this.rate = avg < NET.QUEUE_LO || (this.rate > 1 && avg < mid) ? 1 + NET.CLOCK_NUDGE : avg > NET.QUEUE_HI || (this.rate < 1 && avg > mid) ? 1 - NET.CLOCK_NUDGE : 1;
    return this.rate;
  }
}

// The last ticks the client predicted: each { seq, cmd, move (the movement cmd it ran), state (moveState after it), extra }.
export class Ring {
  constructor(size = 128) { this.size = size; this.a = new Array(size); }
  put(seq, entry) { entry.seq = seq; this.a[seq % this.size] = entry; return entry; }
  get(seq) { const e = this.a[seq % this.size]; return e && e.seq === seq ? e : null; }
  clear() { this.a = new Array(this.size); }
}

// The client's prediction of its own player: each tick's command and where it left them (ring), and, when the host's word
// on a command (its state after it) differs from that, the host's state taken and the commands since run again. player: a
// PlayerMovement (movement.js).
export class Predictor {
  constructor(player, size = 128) { this.p = player; this.ring = new Ring(size); this.fixes = 0; }
  // After a tick's movement (move: the movement cmd it ran, null when it didn't move): its entry.
  record(seq, cmd, move, extra = {}) { return this.ring.put(seq, { cmd, move, state: moveState(this.p), ...extra }); }
  // The host's state after command `ack` (latest: our newest command). → null when it was as predicted, else how far the
  // eye moved by the correction (to ease the camera over it).
  reconcile(ack, host, latest) {
    const e = this.ring.get(ack);
    if (e && !moveDiffers(e.state, host)) return null;
    // (The last few corrections, what differed: net_graph's fixes, looked into.)
    const a = e?.state;
    (this.log ||= []).push({ ack, missing: !e, dp: a ? Math.hypot(a.origin[0] - host.origin[0], a.origin[1] - host.origin[1], a.origin[2] - host.origin[2]) : null,
      dv: a ? Math.hypot(a.velocity[0] - host.velocity[0], a.velocity[1] - host.velocity[1], a.velocity[2] - host.velocity[2]) : null,
      duck: a ? [a.ducked, host.ducked] : null, ground: a ? [a.onGround, host.onGround] : null, speed: e?.move?.maxSpeed, vm: [a?.velocityModifier, host.velocityModifier] });
    if (this.log.length > 30) this.log.shift();
    const before = this.p.eye();
    loadMove(this.p, host);
    if (e) e.state = host;
    this.replay(ack, latest);
    const after = this.p.eye();
    this.fixes++;
    return [before[0] - after[0], before[1] - after[1], before[2] - after[2]];
  }
  // The host's state taken as it is (a respawn, a keyframe), the commands since run on it.
  reset(host, ack, latest) { loadMove(this.p, host); this.replay(ack, latest); }
  replay(ack, latest) {
    for (let s = ack + 1; s <= latest; s++) {
      const e = this.ring.get(s);
      if (!e?.move) continue;
      this.p.tick(NET.TICK, e.move);
      this.p.landed = 0;
      e.state = moveState(this.p);
    }
  }
}

// Whether two movement states differ enough to correct (reconcile) the prediction.
export function moveDiffers(a, b) {
  if (!a || !b) return true;
  const dp = Math.hypot(a.origin[0] - b.origin[0], a.origin[1] - b.origin[1], a.origin[2] - b.origin[2]);
  const dv = Math.hypot(a.velocity[0] - b.velocity[0], a.velocity[1] - b.velocity[1], a.velocity[2] - b.velocity[2]);
  return dp > NET.RECONCILE_POS || dv > NET.RECONCILE_VEL || a.ducked !== b.ducked || a.onGround !== b.onGround || a.onLadder !== b.onLadder;
}
