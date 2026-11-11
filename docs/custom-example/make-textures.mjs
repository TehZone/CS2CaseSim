// Draws the example pack's pictures and textures (all made here from noise and shapes, nothing copied) into the folders
// beside this file. They're kept with the pack, so this only needs running again to change them.
//   node docs/custom-example/make-textures.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encode, resize } from '../../scripts/custom/images.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const save = (rel, img) => { const f = path.join(HERE, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, encode(img)); console.log(rel, `${img.w}x${img.h}`); };

// ---- helpers ------------------------------------------------------------------------------------------------------------
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
// Value noise on a grid of `cells` that wraps (so a texture tiles), summed over octaves.
function noise(seed, cells) {
  const r = rng(seed), g = Float32Array.from({ length: cells * cells }, r);
  return (u, v) => {
    const x = u * cells, y = v * cells, x0 = Math.floor(x), y0 = Math.floor(y), fx = smooth(x - x0), fy = smooth(y - y0);
    const at = (i, j) => g[(((j % cells) + cells) % cells) * cells + (((i % cells) + cells) % cells)];
    return mix(mix(at(x0, y0), at(x0 + 1, y0), fx), mix(at(x0, y0 + 1), at(x0 + 1, y0 + 1), fx), fy);
  };
}
function fbm(seed, base, octaves) {
  const layers = Array.from({ length: octaves }, (_, i) => noise(seed + i * 101, base << i));
  return (u, v) => { let s = 0, a = 0.5, t = 0; for (const n of layers) { s += n(u, v) * a; t += a; a *= 0.5; } return s / t; };
}
function canvas(w, h, fn) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = fn((x + 0.5) / w, (y + 0.5) / h, x, y);
    data.set(c.map((v) => Math.round(clamp(v, 0, 255))), (y * w + x) * 4);
  }
  return { w, h, data };
}
// Signed distance helpers for the pictures (u, v in 0..1).
const sdBox = (px, py, bx, by, r = 0) => { const dx = Math.abs(px) - bx + r, dy = Math.abs(py) - by + r; return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r; };
const cover = (d, aa) => clamp(0.5 - d / aa);
function over(dst, src, a) { return [mix(dst[0], src[0], a), mix(dst[1], src[1], a), mix(dst[2], src[2], a), Math.max(dst[3], a * 255)]; }

// ---- AK-47 | Example Nebula: a Custom Paint Job (colour over the whole UV layout; alpha = how fast it wears) ------------
{
  const n = fbm(11, 4, 6), m = fbm(29, 3, 5), stars = rng(5);
  const starMap = new Map();
  for (let i = 0; i < 900; i++) starMap.set(Math.floor(stars() * 1024) + Math.floor(stars() * 1024) * 1024, 0.4 + stars() * 0.6);
  const deep = hexRgb('#0b0820'), violet = hexRgb('#5b2a86'), teal = hexRgb('#1fb5a8'), rose = hexRgb('#f05a7e');
  save('skins/AK-47 - Example Nebula/color.png', canvas(1024, 1024, (u, v, x, y) => {
    const a = n(u, v), b = m(u + 0.3, v), cloud = smooth(clamp((a - 0.35) * 2.2));
    let c = deep.map((d, i) => mix(d, violet[i], cloud));
    c = c.map((d, i) => mix(d, teal[i], smooth(clamp((b - 0.55) * 3)) * cloud));
    c = c.map((d, i) => mix(d, rose[i], smooth(clamp((a - 0.62) * 4))));
    const s = starMap.get(x + y * 1024);
    if (s) c = c.map((d) => mix(d, 255, s));
    // Alpha is how the paint wears (CUSTOM_CONTENT.md): 255 wears as usual, below 128 it's tougher (0 never wears). The
    // bright clouds are tough. (153 to 230 would leave the gun unpainted there.)
    return [...c, cloud > 0.5 ? 60 : 255];
  }));
}

// ---- M4A1-S | Example Circuit: Hydrographic (a tiling mask: red, green and blue pick the 2nd, 3rd and 4th colours) -------
{
  const S = 1024, cell = 64, r = rng(77), traces = [];
  for (let i = 0; i < 70; i++) {
    let x = Math.floor(r() * (S / cell)), y = Math.floor(r() * (S / cell));
    const path = [[x, y]];
    for (let k = 0; k < 3 + Math.floor(r() * 5); k++) { if (r() < 0.5) x += r() < 0.5 ? 1 : -1; else y += r() < 0.5 ? 1 : -1; path.push([x, y]); }
    traces.push(path);
  }
  const R = new Float32Array(S * S), G = new Float32Array(S * S), B = new Float32Array(S * S);
  const stamp = (arr, cx, cy, rad) => {
    for (let y = Math.floor(cy - rad - 1); y <= cy + rad + 1; y++) for (let x = Math.floor(cx - rad - 1); x <= cx + rad + 1; x++) {
      const i = (((y % S) + S) % S) * S + (((x % S) + S) % S);
      arr[i] = Math.max(arr[i], clamp(rad + 0.5 - Math.hypot(x - cx, y - cy)));
    }
  };
  for (const p of traces) {
    for (let k = 1; k < p.length; k++) {
      const [x0, y0] = p[k - 1].map((q) => q * cell + cell / 2), [x1, y1] = p[k].map((q) => q * cell + cell / 2);
      for (let t = 0; t <= 1; t += 1 / cell) stamp(R, mix(x0, x1, t), mix(y0, y1, t), 5);
    }
    const [ex, ey] = p.at(-1).map((q) => q * cell + cell / 2);
    stamp(G, ex, ey, 14);
    const [sx, sy] = p[0].map((q) => q * cell + cell / 2);
    stamp(B, sx, sy, 9);
  }
  save('skins/M4A1-S - Example Circuit/color.png', canvas(S, S, (u, v, x, y) => {
    const i = y * S + x, g = G[i], b = B[i] * (1 - g);
    return [R[i] * (1 - g) * (1 - b) * 255, g * 255, b * 255, 255];
  }));
}

// ---- ★ Karambit | Example Aurora: Anodized Airbrushed (a smooth mask the seed turns along the blade: its Fade rule's
// percentage is that rotation, its offset fixed) ------------------------------------------------------------------------------
{
  const n = fbm(41, 2, 4);
  save('skins/Karambit - Example Aurora/color.png', canvas(1024, 1024, (u, v) => {
    const w = n(u, v) * 0.25;
    const red = smooth(clamp((u + w - 0.15) * 1.6)), green = smooth(clamp((u + v * 0.4 + w - 0.55) * 2)), blue = smooth(clamp((1 - v + w - 0.6) * 2.5));
    return [red * 255, green * 255, blue * 255, 255];
  }));
}

// ---- ★ Sport Gloves | Example Circuit: a full-colour picture over the whole pair ("mode": "color") -------------------------
// (A plain diagonal tile, not painted to the gloves' UV layout: its stripes cross the seams. CUSTOM_CONTENT.md, section 5,
// says how to paint one that follows the layout.)
{
  const n = fbm(63, 6, 4);
  const navy = hexRgb('#14213d'), orange = hexRgb('#fca311'), grey = hexRgb('#e5e5e5');
  save('skins/Sport Gloves - Example Circuit/pattern.png', canvas(1024, 1024, (u, v) => {
    const stripe = Math.abs(((u + v) * 12) % 2 - 1), band = smooth(clamp((stripe - 0.78) * 8));
    const hex = Math.abs(Math.sin(u * 60) * Math.sin(v * 60)), dots = smooth(clamp((hex - 0.93) * 20)) * (1 - band);
    const grain = (n(u, v) - 0.5) * 22;
    let c = navy.map((x, i) => mix(x, orange[i], band));
    c = c.map((x, i) => mix(x, grey[i], dots * 0.6) + grain);
    return [...c, 255];
  }));
}

// ---- Example Case: its picture (Steam's style: the case alone on a transparent background) and its crate's emblem ---------
// (The picture is a simple flat box: it isn't drawn after the Kilowatt crate the case opens in. A real case's case.png
// follows the crate it uses: CUSTOM_CONTENT.md, section 6.)
const emblem = (u, v) => {
  // A rounded hexagon badge with a four-pointed star (in 0..1 coordinates, centred).
  const px = (u - 0.5) * 2, py = (v - 0.5) * 2;
  const k = [0.866, 0.5], qx = Math.abs(px), qy = Math.abs(py);
  const hexD = Math.max(qx * k[0] + qy * k[1], qy) - 0.82;
  const ring = Math.abs(hexD + 0.08) - 0.05;
  const star = Math.min(Math.abs(px) + Math.abs(py) * 5, Math.abs(px) * 5 + Math.abs(py)) * 0.32 - 0.22;
  return { hexD, ring, star };
};
{
  const teal = hexRgb('#16c79a'), dark = hexRgb('#11152b'), light = hexRgb('#e8f6ff');
  save('cases/Example Case/crate.png', canvas(512, 512, (u, v) => {
    const { hexD, ring, star } = emblem(u, v), aa = 3 / 256;
    let c = [0, 0, 0, 0];
    c = over(c, [...dark, 255], cover(hexD, aa));
    c = over(c, [...teal, 255], cover(ring, aa));
    c = over(c, [...light, 255], cover(star, aa));
    return c;
  }));
  // The case: a box seen from the front, its lid on top and the emblem on its face.
  const W = 1024, H = 768, body = hexRgb('#2b3a55'), lid = hexRgb('#3d5378'), edge = hexRgb('#7d93b8');
  const img = canvas(W, H, (u, v) => {
    const x = (u - 0.5) * W, y = (v - 0.5) * H, aa = 1.5;
    let c = [0, 0, 0, 0];
    c = over(c, [0, 0, 0, 255], cover(sdBox(x, y - 270, 390, 18, 18), 40) * 0.45); // (its shadow)
    const front = sdBox(x, y - 50, 360, 200, 24), top = sdBox(x, y + 200, 385, 52, 20);
    c = over(c, [...edge, 255], cover(Math.min(front, top) - 5, aa));
    c = over(c, [...body.map((q) => q * (1.15 - (y + 150) / 900)), 255], cover(front, aa));
    c = over(c, [...lid, 255], cover(top, aa));
    c = over(c, [...edge, 255], cover(sdBox(x, y + 200, 60, 14, 6), aa)); // (its latch)
    const R = 150, em = emblem((x / R) / 2 + 0.5, ((y - 50) / R) / 2 + 0.5);
    c = over(c, [...dark, 255], cover(em.hexD * R, aa));
    c = over(c, [...teal, 255], cover(em.ring * R, aa));
    c = over(c, [...light, 255], cover(em.star * R, aa));
    return c;
  });
  save('cases/Example Case/case.png', img);
  void resize;
}
