// A bot's crosshair, moved the way a player's hand moves it. An enemy comes into sight and for its reaction time nothing
// happens (longer when they're at the edge of its view): the crosshair carries on as it was. Then a flick, one quick
// movement there, fast and then slowing as it arrives (the smooth "minimum jerk" curve a hand's movements follow), that
// lands short, long or a little to the side, by more the further it went (a Silver's by a lot, a Global Elite's by a
// little); seeing that, a moment later, a smaller correction, and maybe another, until it's on them. On them it follows
// with a lag, its hand catching up with how they move (a strafe the other way takes it off them for a moment), and a
// slight wobble; if they get away from it, another quick movement after them. Before this a bot turned at its full
// speed straight onto the head the moment it saw you and stayed there.
// Angles [pitch, yaw] in degrees, times in seconds. Pure: the bot's brain (ai.js) gives it the angles to the point it
// aims at each tick, and its rank's numbers (skill.js).
const wrap = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
// How far along a minimum-jerk movement is (0 to 1) a fraction x of the way through its time.
export const minJerk = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * x * (10 + x * (-15 + 6 * x)));
const gauss = (rng) => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());

export class Aim {
  constructor(rng = Math.random) {
    this.rng = rng;
    this.phase = 'idle'; // wait (reacting) | move (a flick or a correction) | dwell (seeing where it landed) | track
    this.until = 0; this.t0 = 0; this.T = 0; this.subs = 0;
    this.from = [0, 0]; this.d = [0, 0];
    this.pv = [0, 0]; // how fast its hand follows the target (deg/s)
    this.noise = [0, 0]; // the wobble on where it means to aim
  }

  // An enemy in sight at t: it moves after react seconds.
  start(t, react) { this.phase = 'wait'; this.until = t + react; this.subs = 0; this.pv[0] = this.pv[1] = 0; }
  get moving() { return this.phase === 'move'; }
  // How far through the movement it's making (1 when it isn't making one).
  progress(t) { return this.phase === 'move' ? Math.min(1, (t - this.t0) / this.T) : 1; }

  // One tick: view is where it aims now, at where the aim point is, vel how fast that moves across its view (deg/s),
  // size its angular half size (deg), p the rank's numbers. Returns the new view (in out).
  step(dt, t, view, at, vel, size, p, out = [0, 0]) {
    out[0] = view[0]; out[1] = view[1];
    const k = Math.exp(-dt / 0.35), s = p.aimNoise * Math.sqrt(1 - k * k);
    this.noise[0] = this.noise[0] * k + s * 0.6 * gauss(this.rng);
    this.noise[1] = this.noise[1] * k + s * gauss(this.rng);
    if (this.phase === 'idle') return out;
    if (this.phase === 'wait' || this.phase === 'dwell') {
      if (t < this.until) return out;
      this.plan(t, view, at, vel, p, this.phase === 'dwell');
    }
    const max = p.turn * dt;
    if (this.phase === 'move') {
      const x = Math.min(1, (t - this.t0) / this.T), f = minJerk(x);
      turnToward(view, this.from[0] + this.d[0] * f, this.from[1] + this.d[1] * f, max, out);
      if (x >= 1) {
        // Landed: off by more than the target's size, it looks again and corrects (a few times at most).
        const e = Math.hypot(at[0] - out[0], wrap(at[1] - out[1]));
        if (e > Math.max(size * 1.2, 0.3) && this.subs < 4) { this.phase = 'dwell'; this.until = t + p.dwell * (0.7 + 0.6 * this.rng()); }
        else this.phase = 'track';
      }
      return out;
    }
    // Following: the hand's speed catches up with the target's (it lags when they change direction), and it closes
    // what gap there is.
    const a = 1 - Math.exp(-dt / p.pursuitLag), kp = 1 / p.pursuitLag;
    this.pv[0] += (vel[0] - this.pv[0]) * a; this.pv[1] += (vel[1] - this.pv[1]) * a;
    const ep = at[0] + this.noise[0] - view[0], ey = wrap(at[1] + this.noise[1] - view[1]);
    turnToward(view, view[0] + (this.pv[0] + ep * kp) * dt, view[1] + (this.pv[1] + ey * kp) * dt, max, out);
    // They got away from it (a quick strafe, a jump, its own recoil): a quick movement after them.
    if (Math.hypot(at[0] - out[0], wrap(at[1] - out[1])) > Math.max(2.5, size * 5)) { this.subs = Math.min(this.subs, 2); this.plan(t, out, at, vel, p, true); }
    return out;
  }

  // A movement from where it aims to where the target will be when it gets there (a good player allows for how they're
  // moving), off by some of the way.
  plan(t, view, at, vel, p, correction) {
    const dp = at[0] - view[0], dy = wrap(at[1] - view[1]);
    const T = (correction ? p.flickBase * 0.7 : p.flickBase) + p.flickK * Math.sqrt(Math.hypot(dp, dy));
    const gp = dp + vel[0] * T * p.lead, gy = dy + vel[1] * T * p.lead, G = Math.hypot(gp, gy);
    const sd = p.flickErr * G + p.flickMin * (correction ? 0.5 : 1);
    const along = gauss(this.rng) * sd - p.undershoot * G, across = gauss(this.rng) * sd * 0.45;
    const ux = G > 1e-6 ? gp / G : 1, uy = G > 1e-6 ? gy / G : 0;
    this.d[0] = gp + ux * along - uy * across; this.d[1] = gy + uy * along + ux * across;
    this.from[0] = view[0]; this.from[1] = view[1];
    this.t0 = t; this.T = T; this.phase = 'move'; this.subs++;
  }
}

// Turns from view towards (p, y), at most max degrees, into out.
function turnToward(view, p, y, max, out) {
  const dp = p - view[0], dy = wrap(y - view[1]), d = Math.hypot(dp, dy), k = d > max ? max / d : 1;
  out[0] = Math.max(-89, Math.min(89, view[0] + dp * k));
  out[1] = wrap(view[1] + dy * k);
  return out;
}
