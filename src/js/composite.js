// Builds the final texture of an item: base icon + seed-driven pattern tint + float-driven wear + stickers.
import { loadImage, imgUrl, mulberry32, clamp, smoothstep } from './util.js';
import { D } from './data.js';
import { itemDef, patternInfo } from './items.js';

export const STICKER_BASE = 0.15; // sticker width as a fraction of the weapon image width at scale 1

// Sticker width (fraction of the weapon's length) for a weapon. Stickers are a fixed real size in CS2, so on
// pistols (a quarter of a rifle's length) they take up a much larger share of the gun.
export const stickerBase = (def) => STICKER_BASE * (def?.cat === 'pistol' ? 2 : 1);

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// Smooth value noise in [0,1], made by upscaling small random images (GPU bilinear) and summing octaves.
function noiseField(W, H, seed, octaves = [[18, 0.5], [55, 0.3], [160, 0.2]]) {
  const c = canvas(W, H);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.globalCompositeOperation = 'lighter';
  const r = mulberry32(seed);
  for (const [cells, weight] of octaves) {
    const gw = cells, gh = Math.max(2, Math.round((cells * H) / W));
    const small = canvas(gw, gh);
    const sctx = small.getContext('2d');
    const id = sctx.createImageData(gw, gh);
    for (let i = 0; i < gw * gh; i++) {
      const v = Math.floor(r() * 255);
      id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v;
      id.data[i * 4 + 3] = 255;
    }
    sctx.putImageData(id, 0, 0);
    ctx.globalAlpha = weight;
    ctx.drawImage(small, 0, 0, W, H);
  }
  const d = ctx.getImageData(0, 0, W, H).data;
  const out = new Float32Array(W * H);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4] / 255;
  return out;
}

// 0 deep inside the silhouette, rising towards the edges (where paint wears first).
function edgeField(src, W, H) {
  const c = canvas(W, H);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.filter = `blur(${Math.max(2, Math.round(W * 0.01))}px)`;
  ctx.drawImage(src, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  const out = new Float32Array(W * H);
  for (let i = 0; i < out.length; i++) out[i] = 1 - d[i * 4 + 3] / 255;
  return out;
}

export const wearAmount = (f) => clamp((f - 0.03) / 0.75, 0, 1);

function rgb2hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function hsl2rgb(h, s, l) {
  h /= 360;
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

// Case Hardened: shift the gold/brown/purple areas towards blue in seed-specific blobs.
function applyCaseHardened(data, W, H, blue, seed) {
  const n = noiseField(W, H, seed * 31 + 7, [[6, 0.55], [16, 0.3], [48, 0.15]]);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    if (data[o + 3] < 8) continue;
    const [h, s, l] = rgb2hsl(data[o], data[o + 1], data[o + 2]);
    // Only recolour the case-hardening palette (gold/brown, blue, purple); bare grey metal stays.
    if (s < 0.12 || (h > 65 && h < 180) || h > 320) continue;
    // `blue` of the surface (by area) becomes blue, the rest gold. Soft blob borders.
    const b01 = smoothstep(1 - blue - 0.06, 1 - blue + 0.06, n[i]);
    const th = b01 > 0.5 ? 212 : 40;
    const k = Math.abs(b01 - 0.5) * 2 * 0.9;
    const [r, g, b] = hsl2rgb(th, Math.min(1, s * 1.05), l);
    data[o] = data[o] + (r - data[o]) * k;
    data[o + 1] = data[o + 1] + (g - data[o + 1]) * k;
    data[o + 2] = data[o + 2] + (b - data[o + 2]) * k;
  }
}

function applyWear(data, W, H, src, fl, seed, isCloth) {
  const amt = wearAmount(fl);
  if (amt < 0.02) return;
  const noise = noiseField(W, H, seed * 7919 + 13);
  const edge = edgeField(src, W, H);
  const th = 1 - amt * 0.78;
  const grime = amt * 0.18;
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    if (data[o + 3] < 8) continue;
    let r = data[o], g = data[o + 1], b = data[o + 2];
    const lum = 0.3 * r + 0.59 * g + 0.11 * b;
    // overall grime: slightly darker and less saturated
    r += (lum - r) * grime * 0.8; g += (lum - g) * grime * 0.8; b += (lum - b) * grime * 0.8;
    r *= 1 - grime * 0.35; g *= 1 - grime * 0.35; b *= 1 - grime * 0.35;
    const v = noise[i] * 0.78 + edge[i] * 0.6;
    if (v > th) {
      const k = smoothstep(th, th + 0.05, v) * 0.92;
      // Chipped paint reveals bare grey metal (or faded fabric for gloves).
      const m = isCloth ? lum * 0.55 + 85 : 62 + lum * 0.42;
      const mr = isCloth ? m * 1.05 : m * 0.97, mg = m, mb = isCloth ? m * 0.9 : m * 1.04;
      r += (mr - r) * k; g += (mg - g) * k; b += (mb - b) * k;
    }
    data[o] = r; data[o + 1] = g; data[o + 2] = b;
  }
}

// Bounding box of the opaque pixels of a canvas, normalised.
export function alphaBox(canvasOrCtx) {
  const ctx = canvasOrCtx.getContext ? canvasOrCtx.getContext('2d', { willReadFrequently: true }) : canvasOrCtx;
  const { width: w, height: h } = ctx.canvas;
  const d = ctx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    if (d[(y * w + x) * 4 + 3] > 20) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return x1 > x0 ? { x0: x0 / w, x1: x1 / w, y0: y0 / h, y1: y1 / h } : { x0: 0, x1: 1, y0: 0, y1: 1 };
}

// Stickers with `m` were placed on the real model's side view (coordinates relative to its bounding
// box); on icons they are mapped through the icon's weapon bounding box.
export async function drawStickers(ctx, W, H, stickers, box = null, weapon = null) {
  for (const s0 of stickers) {
    const def = D.stickers[s0.id];
    if (!def) continue;
    let s = s0, scale = 1;
    if (s0.m) {
      box = box || alphaBox(ctx);
      s = { ...s0, x: box.x0 + s0.x * (box.x1 - box.x0), y: box.y0 + s0.y * (box.y1 - box.y0) };
      scale = box.x1 - box.x0;
    }
    let im;
    try { im = await loadImage(imgUrl(def.img, 'm')); } catch { continue; }
    const w = stickerBase(weapon) * W * (s.s || 1) * scale;
    const h = (w * im.height) / im.width;
    const tmp = canvas(Math.ceil(w), Math.ceil(h));
    const t = tmp.getContext('2d');
    t.drawImage(im, 0, 0, w, h);
    if (s.wr > 0) {
      // Scrapes: erase noisy patches, more with each scrape.
      const n = noiseField(tmp.width, tmp.height, Math.floor(s.x * 9973 + s.y * 7919), [[5, 0.6], [14, 0.4]]);
      const id = t.getImageData(0, 0, tmp.width, tmp.height);
      for (let i = 0; i < n.length; i++) if (n[i] < s.wr * 0.9) id.data[i * 4 + 3] *= 0.15;
      t.putImageData(id, 0, 0);
    }
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop'; // clip to the weapon's pixels
    ctx.translate(s.x * W, s.y * H);
    ctx.rotate(((s.r || 0) * Math.PI) / 180);
    ctx.drawImage(tmp, -w / 2, -h / 2);
    ctx.restore();
  }
}

const cache = new Map();
// Returns a canvas with the composed item. Cached by everything that affects the look.
export async function composeItem(item, { size = 'l', stickers = true } = {}) {
  const def = itemDef(item);
  const key = [item.t, item.id, item.fl, item.sd, size, stickers ? JSON.stringify(item.stk || []) : ''].join('|');
  if (cache.has(key)) return cache.get(key);
  const job = (async () => {
    const base = await loadImage(imgUrl(def.img, size));
    const W = base.naturalWidth, H = base.naturalHeight;
    const c = canvas(W, H);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(base, 0, 0);
    if (item.t === 'skin' && !def.v) {
      const id = ctx.getImageData(0, 0, W, H);
      const pat = patternInfo(item);
      if (pat.blue != null) applyCaseHardened(id.data, W, H, pat.blue, item.sd);
      applyWear(id.data, W, H, base, item.fl, item.sd, def.cat === 'gloves');
      ctx.putImageData(id, 0, 0);
    }
    if (stickers && item.stk?.length) await drawStickers(ctx, W, H, item.stk, null, def);
    return c;
  })();
  cache.set(key, job);
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  job.catch(() => cache.delete(key));
  return job;
}

// For 3D textures: extend edge colours outwards so filtering never pulls in transparent black.
export function bleedEdges(src) {
  const W = src.width, H = src.height;
  const c = canvas(W, H);
  const ctx = c.getContext('2d');
  ctx.drawImage(src, 0, 0);
  ctx.globalCompositeOperation = 'destination-over';
  for (const b of [1, 2, 4, 8, 16]) {
    ctx.filter = `blur(${b}px)`;
    for (let k = 0; k < 3; k++) ctx.drawImage(src, 0, 0);
  }
  ctx.filter = 'none';
  ctx.fillStyle = '#555';
  ctx.fillRect(0, 0, W, H);
  return c;
}

// Normal map from luminance (adds embossed surface detail under the lights).
export function normalMapFrom(src, strength = 2.2) {
  const W = Math.min(1024, src.width), H = Math.round((src.height * W) / src.width);
  const c = canvas(W, H);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H);
  const lum = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) lum[i] = (d.data[i * 4] * 0.3 + d.data[i * 4 + 1] * 0.59 + d.data[i * 4 + 2] * 0.11) / 255;
  const out = ctx.createImageData(W, H);
  const L = (x, y) => lum[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (L(x + 1, y - 1) + 2 * L(x + 1, y) + L(x + 1, y + 1) - L(x - 1, y - 1) - 2 * L(x - 1, y) - L(x - 1, y + 1)) * strength;
      const dy = (L(x - 1, y + 1) + 2 * L(x, y + 1) + L(x + 1, y + 1) - L(x - 1, y - 1) - 2 * L(x, y - 1) - L(x + 1, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const o = (y * W + x) * 4;
      out.data[o] = ((-dx / len) * 0.5 + 0.5) * 255;
      out.data[o + 1] = ((dy / len) * 0.5 + 0.5) * 255;
      out.data[o + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      out.data[o + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return c;
}
