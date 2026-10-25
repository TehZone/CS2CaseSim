// CS2's reverb presets (sounds/graphs/reverb_*.vmix, the one the soundscape you're in picks: see soundscape.js) as
// impulse responses for a ConvolverNode. A preset's processors run one after the other on a click, as CS2's mixer runs
// them on the sound: a delay is an echo that comes back fainter each time (its repeats through a lowpass), a diffusor
// smears what it gets (allpasses), a box (a shoebox reverb) is a room's tail: delay lines between its two sizes feeding
// back into themselves through a lowpass, a plate is one too (Dattorro's, here as a box after diffusion), Freeverb is
// Jezar's, and a filter shapes what comes out. Pure JS, no DOM (tests run it).

const db = (x) => Math.pow(10, (x || 0) / 20);
const MAX_SECONDS = 4;

// What CS2's main mix (sounds/graphs/__main__.vmix, audio.EQ81) does to the room on its way out, whichever preset it
// is: its lows (30 dB off under 225 Hz) and highs (21 dB off over 5.8 kHz) taken out, and a little at 1.4 kHz. Goes
// after a preset's own processors (see SoundBank.reverb).
export const ROOM_EQ = [
  { type: 'filter', kind: 'low_shelf', cutoff: 224.55, q: 1.034, gain: -30, poles: 2 },
  { type: 'filter', kind: 'peaking', cutoff: 1374.38, q: 1.6665, gain: -2.83, poles: 2 },
  { type: 'filter', kind: 'high_shelf', cutoff: 5832.68, q: 1, gain: -21.35, poles: 2 },
];

// How long a preset rings for (until it's 60 dB down), roughly.
export function reverbLength(chain) {
  let t = 0.05;
  for (const p of chain) {
    if (p.type === 'delay') { const g = Math.min(0.99, db(p.feedback)); t += (p.ms / 1000) * (1 + (g > 0.001 ? Math.log(1e-3) / Math.log(g) : 0)); }
    else if (p.type === 'diffusor') t += (p.size || 0) * 0.1;
    else if (p.type === 'box') { const g = Math.min(0.98, p.feedback || 0); t += (((p.min + p.max) / 2) / 1000) * (g > 0.001 ? Math.log(1e-3) / Math.log(g) : 1); }
    else if (p.type === 'plate') t += reverbLength([...PLATE(p)]);
    else if (p.type === 'freeverb') t += 0.031 * Math.log(1e-3) / Math.log(freeverbFeedback(p));
  }
  return Math.min(MAX_SECONDS, t);
}

// The preset's impulse response at a sample rate: { left, right } (Float32Arrays), or null for one that does nothing
// (reverb_0_null).
export function renderReverb(chain, rate = 48000) {
  if (!chain?.length) return null;
  const n = Math.max(64, Math.round(reverbLength(chain) * rate));
  const ch = [0, 1].map((c) => {
    let x = new Float32Array(n);
    x[0] = 1;
    for (const p of chain) x = (STAGES[p.type] || ((v) => v))(x, p, rate, c);
    const fade = Math.min(n, Math.round(rate * 0.05));
    for (let i = 0; i < fade; i++) x[n - 1 - i] *= i / fade; // (no click where it's cut off)
    return x;
  });
  return { left: ch[0], right: ch[1] };
}

// RBJ's biquads (12 dB an octave), stepped one sample at a time.
function biquad(kind, cutoff, rate, q = Math.SQRT1_2, gainDb = 0) {
  const w = (2 * Math.PI * Math.min(cutoff, rate * 0.45)) / rate, cw = Math.cos(w), a = Math.sin(w) / (2 * q), A = Math.pow(10, gainDb / 40);
  let b0, b1, b2, a0, a1, a2;
  if (kind === 'highpass') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + a; a1 = -2 * cw; a2 = 1 - a; }
  else if (kind === 'high_shelf' || kind === 'low_shelf') {
    const s = kind === 'high_shelf' ? 1 : -1, r = 2 * Math.sqrt(A) * a;
    b0 = A * (A + 1 + s * (A - 1) * cw + r); b1 = -2 * s * A * (A - 1 + s * (A + 1) * cw); b2 = A * (A + 1 + s * (A - 1) * cw - r);
    a0 = A + 1 - s * (A - 1) * cw + r; a1 = 2 * s * (A - 1 - s * (A + 1) * cw); a2 = A + 1 - s * (A - 1) * cw - r;
  } else if (kind === 'peak' || kind === 'peaking') { b0 = 1 + a * A; b1 = -2 * cw; b2 = 1 - a * A; a0 = 1 + a / A; a1 = -2 * cw; a2 = 1 - a / A; }
  else { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + a; a1 = -2 * cw; a2 = 1 - a; } // lowpass
  b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x) => { const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; };
}
const lowpass = (cutoff, rate) => biquad('lowpass', cutoff, rate);

// The echo: back after ms (the two sides a little apart by its width), then again fainter by its feedback, each repeat
// through the lowpass; with some of the sound straight through (its direct gain).
function delay(x, p, rate, c) {
  const n = x.length, D = Math.max(1, Math.round((p.ms / 1000) * rate * (1 + (c ? 0.5 : -0.5) * (p.width || 0))));
  const direct = p.direct <= -60 ? 0 : db(p.direct), gain = db(p.gain), fb = p.feedback <= -60 ? 0 : Math.min(0.99, db(p.feedback));
  const lp = lowpass(p.cutoff || 20000, rate), w = new Float32Array(n), y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (i >= D) w[i] = x[i - D] + fb * lp(w[i - D]);
    y[i] = direct * x[i] + gain * w[i];
  }
  return y;
}

// Allpasses in a row (as many as its complexity), their lengths from its size, each feeding back by its feedback.
const SPREAD = [1, 0.71, 0.53, 0.37, 0.29, 0.23, 0.19, 0.17];
function diffuse(x, p, rate, c) {
  const stages = Math.max(1, Math.min(SPREAD.length, Math.round(p.complexity || 1))), g = Math.min(0.8, db(p.feedback));
  for (let s = 0; s < stages; s++) {
    const M = Math.max(1, Math.round(rate * (p.size || 0.1) * 0.05 * SPREAD[s] * (c ? 1.09 : 1)));
    const y = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) y[i] = -g * x[i] + (i >= M ? x[i - M] + g * y[i - M] : 0);
    x = y;
  }
  const out = db(p.gain);
  if (out !== 1) for (let i = 0; i < x.length; i++) x[i] *= out;
  return x;
}

// A delay line feeding back into itself by g through a one-pole lowpass (a, its coefficient), its input scaled so it
// carries as much energy as it gets (it rings, it doesn't build up).
function comb(src, D, g, a) {
  const y = new Float32Array(src.length), k = Math.sqrt(1 - g * g);
  let s = 0;
  for (let i = 0; i < src.length; i++) {
    const back = i >= D ? y[i - D] : 0;
    s = (1 - a) * back + a * s;
    y[i] = (i >= D ? src[i - D] : 0) * k + g * s;
  }
  return y;
}
const onePole = (cutoff, rate) => Math.exp((-2 * Math.PI * Math.min(cutoff || 20000, rate * 0.45)) / rate);

// The shoebox: delay lines (as many as its complexity) from its smallest size to its largest, each feeding back by its
// feedback through a lowpass, side by side (parallel) or one into the next.
function box(x, p, rate, c) {
  const k = Math.max(2, Math.min(12, Math.round(p.complexity || 4))), g = Math.min(0.98, Math.max(0, p.feedback || 0));
  const lo = Math.max(1, p.min || 1), hi = Math.max(lo + 1, p.max || lo + 1), a = onePole(p.cutoff, rate);
  const sizes = Array.from({ length: k }, (_, i) => Math.max(1, Math.round((lo * Math.pow(hi / lo, i / (k - 1)) * (c ? 1.07 : 1) * rate) / 1000)) | 1);
  let y;
  if (p.parallel) {
    y = new Float32Array(x.length);
    for (const D of sizes) { const z = comb(x, D, g, a); for (let i = 0; i < y.length; i++) y[i] += z[i] / Math.sqrt(k); }
  } else {
    y = x;
    for (const D of sizes) y = comb(y, D, g, a);
  }
  const out = db(p.gain);
  if (out !== 1) for (let i = 0; i < y.length; i++) y[i] *= out;
  return y;
}

// Dattorro's plate as diffusion into a box: its decay is how much comes round each time, its damping how dark it gets.
const PLATE = (p) => [
  { type: 'diffusor', size: 0.15, complexity: 4, feedback: 20 * Math.log10(Math.max(0.05, 0.75 * (p.diffusion ?? 0.5))) },
  { type: 'box', min: 40, max: 150, complexity: 8, feedback: Math.min(0.95, p.decay ?? 0.5), cutoff: 300 + 12000 * (1 - (p.damp ?? 0.5)), parallel: true },
];
const plate = (x, p, rate, c) => PLATE(p).reduce((v, q) => STAGES[q.type](v, q, rate, c), x);

// Jezar's Freeverb: 8 delay lines side by side (its room size how much they feed back), then 4 allpasses; the right
// side's lines a little longer (spread by its width).
const FV_COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617], FV_PASSES = [556, 441, 341, 225];
const freeverbFeedback = (p) => 0.7 + 0.28 * Math.min(1, p.size ?? 0.5);
function freeverb(x, p, rate, c) {
  const s = rate / 44100, g = freeverbFeedback(p), a = Math.min(0.9, 0.4 * (p.damp ?? 0.5)), spread = c ? Math.round(23 * (p.width ?? 1)) : 0;
  let y = new Float32Array(x.length);
  for (const n of FV_COMBS) { const z = comb(x, Math.round((n + spread) * s), g, a); for (let i = 0; i < y.length; i++) y[i] += z[i] / Math.sqrt(FV_COMBS.length); }
  for (const n of FV_PASSES) {
    const M = Math.round((n + spread) * s), z = new Float32Array(y.length);
    for (let i = 0; i < y.length; i++) z[i] = -0.5 * y[i] + (i >= M ? y[i - M] + 0.5 * z[i - M] : 0);
    y = z;
  }
  const late = p.late ?? 1;
  for (let i = 0; i < y.length; i++) y[i] *= late;
  return y;
}

// A filter on what comes out: 1 pole (6 dB an octave), or biquads in a row (12 dB each).
function filter(x, p, rate) {
  const y = new Float32Array(x.length);
  if (p.poles === 1 && p.kind === 'lowpass') {
    const a = onePole(p.cutoff, rate);
    let s = 0;
    for (let i = 0; i < x.length; i++) y[i] = s = (1 - a) * x[i] + a * s;
    return y;
  }
  const stages = Array.from({ length: Math.max(1, Math.round((p.poles || 2) / 2)) }, () => biquad(p.kind, p.cutoff, rate, p.q, p.gain));
  for (let i = 0; i < x.length; i++) { let v = x[i]; for (const f of stages) v = f(v); y[i] = v; }
  return y;
}

const STAGES = { delay, diffusor: diffuse, box, plate, freeverb, filter };
