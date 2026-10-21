// Sound effects: CS2's own case-opening sounds (extracted from the player's CS2 install) when available,
// otherwise synthesised fallbacks.
import { S } from './state.js';
import { cs2Status, cs2Sounds } from './cs2/api.js';

let ctx, master;
function ac() {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.connect(ctx.destination);
  }
  master.gain.value = S.settings.volume;
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

const buffers = {};
let loading = null;
export function loadGameSounds() {
  if (!loading) {
    loading = (async () => {
      if (!(await cs2Status()).available) return;
      const urls = await cs2Sounds();
      if (!ctx) { ctx = new AudioContext(); master = ctx.createGain(); master.connect(ctx.destination); }
      await Promise.all(Object.entries(urls).map(async ([name, url]) => {
        try { buffers[name] = await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer()); } catch {}
      }));
    })().catch(() => {});
  }
  return loading;
}

function play(name, gain = 1) {
  const b = buffers[name];
  if (!b) return false;
  const c = ac();
  const src = c.createBufferSource();
  src.buffer = b;
  const g = c.createGain();
  g.gain.value = gain;
  src.connect(g).connect(master);
  src.start();
  return true;
}

function tone(freq, dur, { type = 'sine', gain = 0.3, at = 0, slide = 0 } = {}) {
  const c = ac();
  const t = c.currentTime + at;
  const o = c.createOscillator(), g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t + dur);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function noise(dur, { gain = 0.2, freq = 3000, q = 4, at = 0 } = {}) {
  const c = ac();
  const t = c.currentTime + at;
  const len = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = c.createBufferSource();
  src.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
  const g = c.createGain();
  g.gain.value = gain;
  src.connect(f).connect(g).connect(master);
  src.start(t);
}

let lastTick = 0;
export const sfx = {
  tick() {
    const now = performance.now();
    if (now - lastTick < 28) return; // very fast scrolling: don't stack dozens of voices
    lastTick = now;
    if (play('scroll', 0.8)) return;
    noise(0.035, { gain: 0.5, freq: 2600, q: 6 }); tone(1800, 0.03, { type: 'square', gain: 0.04 });
  },
  gold() { play('knife'); },
  click() { tone(520, 0.06, { type: 'triangle', gain: 0.18, slide: 300 }); },
  headshot() { tone(1300, 0.18, { type: 'triangle', gain: 0.25 }); tone(1950, 0.25, { type: 'sine', gain: 0.15, at: 0.03 }); },
  coin() { tone(988, 0.08, { type: 'square', gain: 0.08 }); tone(1319, 0.22, { type: 'square', gain: 0.08, at: 0.07 }); },
  buy() { tone(660, 0.08, { type: 'triangle', gain: 0.2 }); tone(880, 0.12, { type: 'triangle', gain: 0.2, at: 0.06 }); },
  error() { tone(180, 0.18, { type: 'sawtooth', gain: 0.12 }); },
  open() {
    if (play('unlock')) return;
    noise(0.25, { gain: 0.25, freq: 800, q: 1 }); tone(140, 0.25, { type: 'sine', gain: 0.3, slide: -60 });
  },
  sticker() { noise(0.12, { gain: 0.35, freq: 5000, q: 1.5 }); tone(300, 0.1, { type: 'sine', gain: 0.2, at: 0.04 }); },
  scrape() { noise(0.25, { gain: 0.35, freq: 6000, q: 0.8 }); },
  reveal(rank) {
    const name = rank >= 5 ? 'revealAncient' : rank === 4 ? 'revealLegendary' : rank === 3 ? 'revealMythical' : 'revealRare';
    if (play(name)) return;
    const chords = {
      2: [523, 659], 3: [523, 659, 784], 4: [587, 740, 880], 5: [659, 831, 988, 1319], 6: [784, 988, 1175, 1568, 1976],
    };
    const notes = chords[Math.min(6, Math.max(2, rank))];
    notes.forEach((f, i) => tone(f, 0.6 + i * 0.1, { type: rank >= 5 ? 'triangle' : 'sine', gain: 0.16, at: i * 0.07 }));
    if (rank >= 6) for (let i = 0; i < 10; i++) tone(2000 + Math.random() * 2000, 0.25, { gain: 0.04, at: 0.3 + i * 0.06 });
  },
};
