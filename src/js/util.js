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
export { round2, clamp, lerp, smoothstep, rand, randInt, pick, pickWeighted, shuffle, hashStr, mulberry32, seeded, seededRng, uid } from './engine/util.js';

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
  // Custom content's pictures ship in the game (src/custom/<id>/icon.png, and icon-l.png twice the size): no proxy.
  if (img.startsWith('custom/')) return size === 'l' ? img.replace(/\.png$/, '-l.png') : img;
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

// An image drawn once into a picture h pixels high: a PNG's blob URL (the URL itself if it can't be). For CS2's SVGs:
// one is drawn all over again each time what's around it is (paths by the hundred), a picture isn't.
export async function picture(url, h) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const w = Math.max(1, Math.round((h * img.naturalWidth) / (img.naturalHeight || img.naturalWidth || 1)));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  return blob ? URL.createObjectURL(blob) : url;
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
