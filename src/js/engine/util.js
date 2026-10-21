// Pure helpers shared by the game client and the multiplayer server (no DOM).
export const round2 = (v) => Math.round(v * 100) / 100;
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// Cryptographically random [0,1) for drops, so outcomes can't be predicted.
const buf = new Uint32Array(1);
export function rand() {
  globalThis.crypto.getRandomValues(buf);
  return buf[0] / 4294967296;
}
export const randInt = (n) => Math.floor(rand() * n);
export const pick = (arr, r = rand) => arr[Math.floor(r() * arr.length)];
export function pickWeighted(entries, r = rand) {
  const total = entries.reduce((s, e) => s + e[1], 0);
  let x = r() * total;
  for (const e of entries) { if ((x -= e[1]) < 0) return e[0]; }
  return entries[entries.length - 1][0];
}
export function shuffle(arr, r = rand) {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}

export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Deterministic 0..1 from a seed and a salt (pattern seed -> same look/stats every time).
export const seeded = (seed, salt = '') => mulberry32(hashStr(salt + ':' + seed))();
// A deterministic RNG stream for a string key (market listings, armory rotations, bots...).
export const seededRng = (key) => mulberry32(hashStr(String(key)));

let uidCounter = 0;
export const uid = () => Date.now().toString(36) + (uidCounter++).toString(36) + randInt(1e6).toString(36);
