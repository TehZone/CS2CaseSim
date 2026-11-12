// Lag compensation, as CS2's (the host's side of online PvP): every tick the host keeps where each player and bot was (a
// second of it); a remote player's shot is tested against everyone else where that player saw them, which is where their
// game drew them (the tick in their command: its `view`, NET.INTERP behind), at most LAGCOMP_MS back. Walls are where they
// are now, and the hit hurts whoever it hits as they are now. Pure but for the bodies it moves and puts back (test-pvp-net).
import { NET } from '../engine/pvp.js';

const wrap = (a) => ((((a + 180) % 360) + 360) % 360) - 180;

export class LagComp {
  // bodies(): [{ key, get(): { pos, yaw, ducked } , set(state) }] each tick (a body's handle: a bot's or the host's own).
  constructor({ ticks = NET.HISTORY_TICKS, maxMs = NET.LAGCOMP_MS } = {}) {
    this.ticks = ticks;
    this.max = maxMs / 1000 / NET.TICK; // (in ticks)
    this.hist = new Map(); // key -> ring of { tick, pos, yaw, ducked, alive }
  }
  // Where everyone was at the end of `tick`.
  record(tick, list) {
    for (const h of list) {
      let ring = this.hist.get(h.key);
      if (!ring) this.hist.set(h.key, (ring = new Array(this.ticks)));
      const s = h.get();
      const e = (ring[tick % this.ticks] ||= { tick: -1, pos: [0, 0, 0], yaw: 0, ducked: false, alive: false });
      e.tick = tick; e.pos[0] = s.pos[0]; e.pos[1] = s.pos[1]; e.pos[2] = s.pos[2]; e.yaw = s.yaw; e.ducked = !!s.ducked; e.alive = !!s.alive;
    }
  }
  // The tick a shot is tested at: its view tick, no further back than the limit (or the history), no later than now.
  clampTick(view, now) { return Math.max(now - this.max, Math.min(now, view), now - this.ticks + 2); }
  // A body's state at fractional tick t (between the two kept ticks around it), or null.
  at(key, t) {
    const ring = this.hist.get(key);
    if (!ring) return null;
    const t0 = Math.floor(t), t1 = t0 + 1, f = t - t0;
    const a = ring[((t0 % this.ticks) + this.ticks) % this.ticks], b = ring[((t1 % this.ticks) + this.ticks) % this.ticks];
    const A = a?.tick === t0 ? a : null, Bk = b?.tick === t1 ? b : null;
    if (!A && !Bk) return null;
    if (!A || !Bk || f <= 0) return { ...(A || Bk), pos: (A || Bk).pos.slice() };
    if (Math.abs(Bk.pos[0] - A.pos[0]) + Math.abs(Bk.pos[1] - A.pos[1]) + Math.abs(Bk.pos[2] - A.pos[2]) > 64) return { ...(f < 0.5 ? A : Bk), pos: (f < 0.5 ? A : Bk).pos.slice() };
    return { tick: t, pos: [0, 1, 2].map((k) => A.pos[k] + (Bk.pos[k] - A.pos[k]) * f), yaw: A.yaw + wrap(Bk.yaw - A.yaw) * f, ducked: f < 0.5 ? A.ducked : Bk.ducked, alive: A.alive && Bk.alive };
  }
  // Runs fn with every body in `list` (but the shooter, `skip`) moved back to tick t, and puts them back after. → fn's result.
  rewind(t, list, skip, fn) {
    const saved = [];
    for (const h of list) {
      if (h.key === skip) continue;
      const s = this.at(h.key, t);
      if (!s || !s.alive) continue;
      saved.push([h, h.get()]);
      h.set(s);
    }
    try { return fn(); } finally { for (const [h, s] of saved) h.set(s); }
  }
}
