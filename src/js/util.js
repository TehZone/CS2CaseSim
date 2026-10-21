export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

const fmt2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function money(v) {
  if (!isFinite(v)) return '$0.00';
  return (v < 0 ? '-$' : '$') + fmt2.format(Math.abs(v));
}
export function moneyShort(v) {
  const a = Math.abs(v);
  if (a >= 1e12) return '$' + (v / 1e12).toFixed(2) + 'T';
  if (a >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return '$' + (v / 1e3).toFixed(1) + 'K';
  return money(v);
}
export const round2 = (v) => Math.round(v * 100) / 100;
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// Cryptographically random [0,1) for drops, so outcomes can't be predicted.
const buf = new Uint32Array(1);
export function rand() {
  crypto.getRandomValues(buf);
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

let uidCounter = 0;
export const uid = () => Date.now().toString(36) + (uidCounter++).toString(36) + randInt(1e6).toString(36);

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

const STEAM = 'https://community.akamai.steamstatic.com/economy/image/';
const SIZES = { s: '/256fx192f', m: '/512fx384f', l: '/1024fx768f' };
// Images are fetched through the local proxy (Electron protocol or dev server) so they are cached
// on disk and same-origin (needed to read pixels for the 3D inspect and sticker compositing).
export function imgUrl(img, size = 'm') {
  if (!img) return '';
  const full = img.startsWith('~') ? STEAM + img.slice(1) + (SIZES[size] || '') : img;
  return 'img?u=' + encodeURIComponent(full);
}

const imgCache = new Map();
export function loadImage(src) {
  if (!imgCache.has(src)) {
    imgCache.set(src, new Promise((res, rej) => {
      const im = new Image();
      im.decoding = 'async';
      im.onload = () => res(im);
      im.onerror = () => { imgCache.delete(src); rej(new Error('image failed: ' + src)); };
      im.src = src;
    }));
  }
  return imgCache.get(src);
}

export function timeAgo(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

export function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
