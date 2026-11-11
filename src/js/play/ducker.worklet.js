// CS2's compressors in its main mix (sounds/graphs/__main__.vmix), on the audio thread. See SoundBank.roomOut.
//
// The reverb compressor (ReverbCompressor): the room (input 0) is turned down while the sounds themselves (input 1:
// every sound but the music and the radio) are loud. Their level over the last 300 ms past -23.9 dB is cut 26 to 1 (in a
// knee 3.1 dB wide), the room's volume following in 20 ms. A spray keeps its room down until it stops, a shot's echo
// mostly; a footstep isn't loud enough to.
const THRESHOLD = -23.875, KNEE = 3.125, RATIO = 26, ATTACK = 0.02, RELEASE = 0.02, RMS = 0.3;
//
// The final limiter (CS2's FinalMixGlue): everything, its peaks past the threshold cut 40 to 1 (a knee 3.1 dB wide),
// letting go as the peak falls (458 ms). CS2 has it before its volume, at -6 dB, taking hold in 4 ms; here it's after
// the volume setting, just under full scale, so it only keeps the loudest moments from clipping (a gunshot 300 units
// away peaked 3.7 dB over full scale at full volume, two at once 6.4 dB) and never holds down the footsteps after a
// shot at the usual volumes. So it takes hold at once, looking 2 ms ahead (a shot's crack is under a millisecond:
// with CS2's 4 ms it still peaked 2.5 dB over).
export const LIMIT = { threshold: -1, knee: 3.125, ratio: 40, attack: 0.0004, release: 0.458, ahead: 0.002 };

// How many dB the room goes down for a level (dB) of the sounds.
export function duckBy(level) {
  const over = level - THRESHOLD;
  if (2 * over <= -KNEE) return 0;
  if (2 * over < KNEE) return ((1 / RATIO - 1) * (over + KNEE / 2) ** 2) / (2 * KNEE);
  return (1 / RATIO - 1) * over;
}
// How many dB the final limiter takes off a peak (dB).
export function limitBy(peak) {
  const over = peak - LIMIT.threshold, k = LIMIT.knee;
  if (2 * over <= -k) return 0;
  if (2 * over < k) return ((1 / LIMIT.ratio - 1) * (over + k / 2) ** 2) / (2 * k);
  return (1 / LIMIT.ratio - 1) * over;
}

if (typeof AudioWorkletProcessor !== 'undefined') {
  const QUIET = Math.pow(10, (LIMIT.threshold - LIMIT.knee / 2) / 20); // (peaks under this aren't touched)
  class Limiter extends AudioWorkletProcessor {
    constructor() {
      super();
      this.cut = 0; // dB taken off now
      this.peak = 0; // the peak level, falling off as it lets go
      this.kAtt = 1 - Math.exp(-1 / (LIMIT.attack * sampleRate));
      this.fall = Math.exp(-1 / (LIMIT.release * sampleRate));
      this.n = Math.max(1, Math.round(LIMIT.ahead * sampleRate)); // what comes out is this many samples behind what it looks at
      this.lines = [new Float32Array(this.n), new Float32Array(this.n)];
      this.at = 0;
    }
    process([inp], [out]) {
      const n = out[0].length, lines = this.lines, len = this.n;
      let cut = this.cut, peak = this.peak, at = this.at;
      for (let i = 0; i < n; i++) {
        let x = 0;
        for (let c = 0; c < inp.length; c++) { const a = Math.abs(inp[c][i]); if (a > x) x = a; }
        peak = x > peak ? x : peak * this.fall;
        const want = peak > QUIET ? limitBy(20 * Math.log10(peak)) : 0;
        cut = want < cut ? cut + (want - cut) * this.kAtt : want; // (letting go as the peak falls)
        const g = cut < -1e-4 ? Math.pow(10, cut / 20) : 1;
        for (let c = 0; c < 2; c++) {
          const line = lines[c], v = inp.length ? inp[Math.min(c, inp.length - 1)][i] : 0;
          if (c < out.length) out[c][i] = line[at] * g;
          line[at] = v;
        }
        at = at + 1 === len ? 0 : at + 1;
      }
      this.cut = cut; this.peak = peak; this.at = at;
      return true;
    }
  }
  registerProcessor('cs2-final-limiter', Limiter);

  class Ducker extends AudioWorkletProcessor {
    constructor() {
      super();
      this.ms = 0; // the sounds' mean square, over the last RMS seconds
      this.g = 1; // the room's volume
      this.kRms = 1 - Math.exp(-1 / (RMS * sampleRate));
      this.kAtt = 1 - Math.exp(-1 / (ATTACK * sampleRate));
      this.kRel = 1 - Math.exp(-1 / (RELEASE * sampleRate));
    }
    process([room, key], [out]) {
      const n = out[0].length;
      let ms = this.ms, g = this.g;
      if (key.length) for (let i = 0; i < n; i++) { let x = 0; for (const c of key) x += c[i] * c[i]; ms += (x / key.length - ms) * this.kRms; }
      else ms *= Math.pow(1 - this.kRms, n);
      this.ms = ms;
      // (How far down, once a block: the level moves over 300 ms. The volume eases there sample by sample.)
      const want = Math.pow(10, duckBy(10 * Math.log10(ms + 1e-12)) / 20), k = want < g ? this.kAtt : this.kRel;
      for (let i = 0; i < n; i++) {
        g += (want - g) * k;
        if (room.length) for (let c = 0; c < out.length; c++) out[c][i] = room[Math.min(c, room.length - 1)][i] * g;
      }
      this.g = g;
      return true;
    }
  }
  registerProcessor('cs2-room-ducker', Ducker);
}
