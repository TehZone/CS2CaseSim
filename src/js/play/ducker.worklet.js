// CS2's reverb compressor (sounds/graphs/__main__.vmix, ReverbCompressor), on the audio thread: the room (input 0) is
// turned down while the sounds themselves (input 1: every sound but the music and the radio) are loud. Their level over
// the last 300 ms past -23.9 dB is cut 26 to 1 (in a knee 3.1 dB wide), the room's volume following in 20 ms. A spray
// keeps its room down until it stops, a shot's echo mostly; a footstep isn't loud enough to. See SoundBank.roomOut.
const THRESHOLD = -23.875, KNEE = 3.125, RATIO = 26, ATTACK = 0.02, RELEASE = 0.02, RMS = 0.3;

// How many dB the room goes down for a level (dB) of the sounds.
export function duckBy(level) {
  const over = level - THRESHOLD;
  if (2 * over <= -KNEE) return 0;
  if (2 * over < KNEE) return ((1 / RATIO - 1) * (over + KNEE / 2) ** 2) / (2 * KNEE);
  return (1 / RATIO - 1) * over;
}

if (typeof AudioWorkletProcessor !== 'undefined') {
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
