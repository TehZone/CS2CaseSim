// A charm's look at any pattern, in 2D, without CS2's files: most charms' colours follow their pattern through their
// material's dynamic expressions, and an item card has no 3D charm to show them with.
//
// scripts/build-charm-pics.mjs renders each charm through the real 3D charm (cs2/charm.js) in the inspect's studio, in the
// pose the inspect first shows it, as layers (src/img/charms/<id>.webp) that say how each pixel responds to its material.
// Lighting is linear in the surface's colour, so a pixel is colour x A + B, A and B measured by rendering the charm once
// black and once white; the colour is the texture before the pattern touches it. This file redoes in 2D what happens to
// that colour in csgo_weapon (the steps of cs2/charm.js's shader, in the same order) for the pattern's parameters, then
// the inspect's tone mapping: the pixels of the 3D charm at that pattern.
import { evalExpression, charmAttrs } from './cs2/expr.js';

export const PIC_W = 384, PIC_H = 288;
const PIXELS = PIC_W * PIC_H;
// The planes of a charm's layers, stacked top to bottom:
//   colour; coverage (R), tint mask (G), pearlescence (B: how much of it each pixel has); on glitter, its flakes (R);
//   then per lighting key (one, or several where the pattern changes the lighting itself: its roughness, metal, glitter
//   or iridescence): A, B and, on glitter, its flakes' light;
//   then, where the pattern moves a print over the charm, its UVs (U, then V, 16 bits in red and green).
const COLOR = 0, MISC = 1, FLAKES = 2;
const firstKey = (look) => (look.glitter ? 3 : 2);
export const planeCount = (look) => firstKey(look) + (look.keys?.length || 1) * (look.glitter ? 3 : 2) + (look.detail ? 2 : 0);

// A and B are HDR: kept on a log scale, finer where the eye is.
const HDR_K = 32, HDR_BITS = 8;
const HDR = Float32Array.from({ length: 256 }, (_, i) => (2 ** ((i / 255) * HDR_BITS) - 1) / HDR_K);
export const hdrCode = (v) => (Math.log2(1 + Math.max(0, v) * HDR_K) / HDR_BITS) * 255;
export const UV_MIN = -1, UV_SPAN = 3; // a charm's UVs, as 16 bits
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const SRGB = Float32Array.from({ length: 256 }, (_, i) => toLinear(i / 255));
// Linear to sRGB bytes, through a table fine enough for the darks.
const OUT_STEPS = 4096;
const OUT = Uint8Array.from({ length: OUT_STEPS + 1 }, (_, i) => {
  const c = i / OUT_STEPS;
  return Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255);
});

const LUM_R = 0.2125, LUM_G = 0.7154, LUM_B = 0.0721, K = 0.57735;
const EXPOSURE = 1.08; // the inspect's
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// The planes of one sheet's pixels (RGBA, as getImageData gives them), kept only where the charm is.
export function readLayers(rgba, look) {
  const planes = planeCount(look), misc = MISC * PIXELS * 4;
  let n = 0;
  for (let i = 0; i < PIXELS; i++) if (rgba[misc + i * 4]) n++;
  const at = new Uint32Array(n), layer = { at, n, planes: [], u: null, v: null };
  let j = 0;
  for (let i = 0; i < PIXELS; i++) if (rgba[misc + i * 4]) at[j++] = i;
  for (let p = 0; p < planes; p++) {
    const out = new Uint8Array(n * 3), o = p * PIXELS * 4;
    for (let k = 0; k < n; k++) {
      const s = o + at[k] * 4;
      out[k * 3] = rgba[s]; out[k * 3 + 1] = rgba[s + 1]; out[k * 3 + 2] = rgba[s + 2];
    }
    layer.planes.push(out);
  }
  if (look.detail) {
    const uv = (plane) => Float32Array.from({ length: n }, (_, k) => UV_MIN + (((plane[k * 3] << 8) | plane[k * 3 + 1]) / 65535) * UV_SPAN);
    layer.u = uv(layer.planes[planes - 2]);
    layer.v = uv(layer.planes[planes - 1]);
  }
  return layer;
}

// A print's texture (RGBA), as a chain of smaller copies in linear colour, the way the GPU would filter it.
export function readDetail(rgba, w, h) {
  const top = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) top[i * 3 + c] = SRGB[rgba[i * 4 + c]];
  const mips = [{ w, h, px: top }];
  while (mips.at(-1).w > 16 && mips.at(-1).h > 16) {
    const s = mips.at(-1), W = s.w >> 1, H = s.h >> 1, px = new Float32Array(W * H * 3);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) {
      const a = (y * 2 * s.w + x * 2) * 3 + c, b = a + s.w * 3;
      px[(y * W + x) * 3 + c] = (s.px[a] + s.px[a + 3] + s.px[b] + s.px[b + 3]) / 4;
    }
    mips.push({ w: W, h: H, px });
  }
  return mips;
}

// Bilinear, repeating (the charm's textures wrap).
function sample(o, m, u, v) {
  const fx = (u - Math.floor(u)) * m.w - 0.5, fy = (v - Math.floor(v)) * m.h - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  const xa = (x0 + m.w) % m.w, xb = (x0 + 1 + m.w) % m.w, ya = ((y0 + m.h) % m.h) * m.w, yb = ((y0 + 1 + m.h) % m.h) * m.w;
  for (let c = 0; c < 3; c++) {
    const top = m.px[(ya + xa) * 3 + c] * (1 - tx) + m.px[(ya + xb) * 3 + c] * tx;
    const bot = m.px[(yb + xa) * 3 + c] * (1 - tx) + m.px[(yb + xb) * 3 + c] * tx;
    o[c] = top * (1 - ty) + bot * ty;
  }
}

// A material's parameters at a pattern, as charmMaterial works them out.
export function lookParams(look, pat) {
  const p = { ...look.params }, attrs = charmAttrs(pat);
  for (const [k, src] of Object.entries(look.dynamic || {})) {
    const v = evalExpression(src, attrs);
    if (v == null) continue;
    p[k] = Array.isArray(p[k]) && !Array.isArray(v) ? p[k].map(() => v) : v;
  }
  return p;
}

// `rgb` turned as csgo_weapon's hue about the grey axis, weighted by saturation (cs2Hue).
function hueInto(o, r, g, b, cos, sin) {
  const mx = r > g ? (r > b ? r : b) : (g > b ? g : b), mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
  const s = mx > 0 ? (mx - mn) / mx : 0;
  const w = s > 0 ? Math.sqrt(Math.sqrt(Math.sqrt(s))) : 0; // pow(s, 0.125)
  const d = K * (r + g + b) * K * (1 - cos), l = r * LUM_R + g * LUM_G + b * LUM_B;
  o[0] = l + (r * cos + K * (b - g) * sin + d - l) * w;
  o[1] = l + (g * cos + K * (r - b) * sin + d - l) * w;
  o[2] = l + (b * cos + K * (g - r) * sin + d - l) * w;
}

// Where this pattern falls among the charm's lighting keys: the two to mix and how far between them.
function keySpot(look, pat) {
  const keys = look.keys;
  if (!keys || keys.length < 2) return [0, 0, 0];
  const t = look.keyBy ? evalExpression(look.keyBy, charmAttrs(pat)) : charmAttrs(pat).$KeychainSeed;
  let i = 0;
  while (i < keys.length - 2 && t > keys[i + 1]) i++;
  const f = clamp01((t - keys[i]) / (keys[i + 1] - keys[i]));
  // A level isn't a blend: the nearest of them (the lighter's liquid).
  if (look.keyNearest) { const k = f < 0.5 ? i : i + 1; return [k, k, 0]; }
  return [i, i + 1, f];
}

// The pixels (RGBA, straight alpha) of a charm's layers at a pattern, into `out`, which starts clear. `detail`: the print's
// chain (readDetail), where the pattern moves one.
export function paintCharm(layer, look, pat, out, detail = null) {
  const p = lookParams(look, pat), { at, n, planes } = layer;
  const num = (k, d) => (typeof p[k] === 'number' && Number.isFinite(p[k]) ? p[k] : d);
  const vec = (k, d) => (Array.isArray(p[k]) ? p[k] : typeof p[k] === 'number' ? [p[k], p[k], p[k], p[k]] : d);
  const adjust = !!look.adjust, glitter = !!look.glitter;
  const contrast = num('g_fContrast', 1), bright = num('g_fBrightness', 1), sat = num('g_fSaturation', 1);
  const hue = (num('g_fHueShift', 0) * Math.PI) / 180, hc = Math.cos(hue), hs = Math.sin(hue);
  const pearl = look.pearl ? num('g_flPearlescentScale', 0) : 0;
  const colour = planes[COLOR], misc = planes[MISC], flakes = planes[FLAKES], stride = glitter ? 3 : 2, key0 = firstKey(look);
  const [k0, k1, f1] = keySpot(look, pat), f0 = 1 - f1;
  const A0 = planes[key0 + k0 * stride], B0 = planes[key0 + k0 * stride + 1], S0 = glitter ? planes[key0 + k0 * stride + 2] : null;
  const A1 = planes[key0 + k1 * stride], B1 = planes[key0 + k1 * stride + 1], S1 = glitter ? planes[key0 + k1 * stride + 2] : null;
  // The print where the pattern moves it: its place on the charm (charmMaterial's cs2DetailXform and cs2DetailOpts).
  let print = null;
  if (look.detail && detail) {
    const ds = vec('g_vDetailTexCoordScale', [1, 1]), dr = (num('g_flDetailTexCoordRotation', 0) * Math.PI) / 180, dc = Math.cos(dr), dn = Math.sin(dr);
    const off = vec('g_vDetailTexCoordOffset', [0, 0]);
    const lod = Math.log2(Math.max(1, Math.max(Math.abs(ds[0]), Math.abs(ds[1])) * look.detail.uvPerPixel * detail[0].w));
    print = {
      m: detail[Math.min(detail.length - 1, Math.round(lod))], xx: ds[0] * dc, xy: -ds[0] * dn, yx: ds[1] * dn, yy: ds[1] * dc,
      ox: 0.5 + off[0] - 0.5 * ds[0] * (dc - dn), oy: 0.5 + off[1] - 0.5 * ds[1] * (dn + dc), blend: num('g_fDetailBlendFactor', 1),
      masked: num('g_bMaskDetailTextureByTintMask', 0) > 0.5, replaces: look.detail.replaces,
    };
  }
  // The lighter's liquid: one colour, whatever's under it.
  let liquid = null;
  if (look.liquid) {
    const c = vec('g_vLiquidColor', [0.6, 0.4, 0.1]), b = num('g_flLiquidBrightness', 1), a = (num('g_flLiquidColorHueShift', 0) * Math.PI) / 180;
    liquid = [0, 0, 0];
    hueInto(liquid, toLinear(c[0]) * b, toLinear(c[1]) * b, toLinear(c[2]) * b, Math.cos(a), Math.sin(a));
  }
  const t = [0, 0, 0], e = EXPOSURE / 0.6;
  for (let k = 0; k < n; k++) {
    const j = k * 3, m = misc[j + 1] / 255;
    let r, g, b;
    if (liquid) { r = liquid[0]; g = liquid[1]; b = liquid[2]; } else { r = SRGB[colour[j]]; g = SRGB[colour[j + 1]]; b = SRGB[colour[j + 2]]; }
    if (print) {
      const q = print, u = layer.u[k], v = layer.v[k];
      sample(t, q.m, q.xx * u + q.xy * v + q.ox, q.yx * u + q.yy * v + q.oy);
      const w = q.blend * (q.masked ? m : 1);
      r += ((q.replaces ? t[0] : r * t[0]) - r) * w; g += ((q.replaces ? t[1] : g * t[1]) - g) * w; b += ((q.replaces ? t[2] : b * t[2]) - b) * w;
    }
    if (adjust && m > 0) {
      let ar = clamp01((0.5 + (r - 0.5) * contrast) * bright), ag = clamp01((0.5 + (g - 0.5) * contrast) * bright), ab = clamp01((0.5 + (b - 0.5) * contrast) * bright);
      hueInto(t, ar, ag, ab, hc, hs);
      const l = t[0] * LUM_R + t[1] * LUM_G + t[2] * LUM_B;
      ar = clamp01(l + (t[0] - l) * sat); ag = clamp01(l + (t[1] - l) * sat); ab = clamp01(l + (t[2] - l) * sat);
      r += (ar - r) * m; g += (ag - g) * m; b += (ab - b) * m;
    }
    if (pearl) {
      const a = pearl * (misc[j + 2] / 255);
      hueInto(t, r, g, b, Math.cos(a), Math.sin(a));
      r = t[0]; g = t[1]; b = t[2];
    }
    // Lit. Glitter's flakes take their colour from the surface under them, and a dark surface brightens under a flake.
    let lr, lg, lb;
    if (glitter) {
      const mr = r > 0.0003 ? r : 0.0003, mg = g > 0.0003 ? g : 0.0003, mb = b > 0.0003 ? b : 0.0003, inv = 1.007 / Math.sqrt(mr * mr + mg * mg + mb * mb);
      const s = clamp01((r * LUM_R + g * LUM_G + b * LUM_B) / 0.8), boost = 1 + (flakes[j] / 255) * 2.5 * (1 - s * s * (3 - 2 * s));
      r *= boost; g *= boost; b *= boost;
      lr = (HDR[S0[j]] * f0 + HDR[S1[j]] * f1) * (0.05 + mr * inv);
      lg = (HDR[S0[j + 1]] * f0 + HDR[S1[j + 1]] * f1) * (0.05 + mg * inv);
      lb = (HDR[S0[j + 2]] * f0 + HDR[S1[j + 2]] * f1) * (0.05 + mb * inv);
    } else lr = lg = lb = 0;
    lr += r * (HDR[A0[j]] * f0 + HDR[A1[j]] * f1) + HDR[B0[j]] * f0 + HDR[B1[j]] * f1;
    lg += g * (HDR[A0[j + 1]] * f0 + HDR[A1[j + 1]] * f1) + HDR[B0[j + 1]] * f0 + HDR[B1[j + 1]] * f1;
    lb += b * (HDR[A0[j + 2]] * f0 + HDR[A1[j + 2]] * f1) + HDR[B0[j + 2]] * f0 + HDR[B1[j + 2]] * f1;
    // The inspect's exposure, three's ACES filmic curve, then sRGB.
    lr *= e; lg *= e; lb *= e;
    let ir = 0.59719 * lr + 0.35458 * lg + 0.04823 * lb, ig = 0.076 * lr + 0.90834 * lg + 0.01566 * lb, ib = 0.0284 * lr + 0.13383 * lg + 0.83777 * lb;
    ir = (ir * (ir + 0.0245786) - 0.000090537) / (ir * (0.983729 * ir + 0.432951) + 0.238081);
    ig = (ig * (ig + 0.0245786) - 0.000090537) / (ig * (0.983729 * ig + 0.432951) + 0.238081);
    ib = (ib * (ib + 0.0245786) - 0.000090537) / (ib * (0.983729 * ib + 0.432951) + 0.238081);
    const o = at[k] * 4;
    out[o] = OUT[(clamp01(1.60475 * ir - 0.53108 * ig - 0.07367 * ib) * OUT_STEPS + 0.5) | 0];
    out[o + 1] = OUT[(clamp01(-0.10208 * ir + 1.10813 * ig - 0.00605 * ib) * OUT_STEPS + 0.5) | 0];
    out[o + 2] = OUT[(clamp01(-0.00327 * ir - 0.07276 * ig + 1.07602 * ib) * OUT_STEPS + 0.5) | 0];
    out[o + 3] = misc[j];
  }
  return out;
}
