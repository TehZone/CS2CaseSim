// Pictures for the custom content build (scripts/build-custom.mjs): reading PNG and TGA files as 8-bit RGBA, resizing and
// fitting them, and writing PNGs. No dependencies: cs2/png.cjs decodes and encodes.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const png = createRequire(import.meta.url)('../../cs2/png.cjs');

// { w, h, data: Uint8Array of RGBA } from a PNG (8 or 16 bits, grey, grey+alpha, RGB, RGBA, not interlaced or paletted)
// or a TGA (24 or 32 bits, or 8-bit greyscale, plain or run-length encoded, as CS2's Workshop tools take). Throws a
// readable message.
export function readImage(file) {
  const buf = fs.readFileSync(file);
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return fromPng(buf);
  if (/\.tga$/i.test(file)) return fromTga(buf);
  throw new Error('not a PNG or TGA file');
}

function fromPng(buf) {
  let img;
  try { img = png.decodePNG(buf); } catch (e) { throw new Error(`can't read this PNG (${e.message}): save it as an 8-bit RGBA PNG, not interlaced`); }
  const { width: w, height: h, channels: ch, depth } = img;
  if (depth !== 8 && depth !== 16) throw new Error(`${depth}-bit PNGs aren't supported: save it as 8-bit`);
  const step = depth / 8, out = new Uint8Array(w * h * 4), src = img.data;
  for (let i = 0; i < w * h; i++) {
    const at = (c) => src[(i * ch + c) * step]; // (16-bit: the high byte)
    const o = i * 4;
    if (ch >= 3) { out[o] = at(0); out[o + 1] = at(1); out[o + 2] = at(2); out[o + 3] = ch === 4 ? at(3) : 255; }
    else { out[o] = out[o + 1] = out[o + 2] = at(0); out[o + 3] = ch === 2 ? at(1) : 255; }
  }
  return { w, h, data: out };
}

function fromTga(buf) {
  const idLen = buf[0], cmap = buf[1], type = buf[2], w = buf.readUInt16LE(12), h = buf.readUInt16LE(14), bpp = buf[16], desc = buf[17];
  // (Types 2 and 10 are true colour, 3 and 11 greyscale, as masks are often saved: plain and run-length encoded.)
  const grey = type === 3 || type === 11;
  if (cmap || ![2, 3, 10, 11].includes(type)) throw new Error('only true-colour (24 or 32 bits) and greyscale (8 bits) TGAs are supported');
  if (grey ? bpp !== 8 && bpp !== 16 : bpp !== 24 && bpp !== 32) throw new Error(`${bpp}-bit ${grey ? 'greyscale ' : ''}TGAs aren't supported: save it as 24 or 32 bits (or 8-bit greyscale)`);
  const n = bpp / 8, px = new Uint8Array(w * h * 4);
  let p = 18 + idLen, i = 0;
  const put = grey
    ? (o) => { px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = buf[o]; px[i * 4 + 3] = n === 2 ? buf[o + 1] : 255; i++; }
    : (o) => { px[i * 4] = buf[o + 2]; px[i * 4 + 1] = buf[o + 1]; px[i * 4 + 2] = buf[o]; px[i * 4 + 3] = n === 4 ? buf[o + 3] : 255; i++; };
  if (type === 2 || type === 3) { while (i < w * h) { put(p); p += n; } } else {
    while (i < w * h && p < buf.length) {
      const c = buf[p++], count = (c & 127) + 1;
      if (c & 128) { for (let k = 0; k < count && i < w * h; k++) put(p); p += n; } else for (let k = 0; k < count && i < w * h; k++) { put(p); p += n; }
    }
  }
  // Rows are stored bottom-up unless the descriptor's top-left bit is set.
  if (!(desc & 0x20)) {
    const row = w * 4, tmp = new Uint8Array(row);
    for (let y = 0; y < h >> 1; y++) { const a = y * row, b = (h - 1 - y) * row; tmp.set(px.subarray(a, a + row)); px.copyWithin(a, b, b + row); px.set(tmp, b); }
  }
  return { w, h, data: px };
}

// One axis of an area resample: each output sample is the average of the input it covers (box filter, exact coverage), so a
// big downscale keeps fine lines; upscaling is linear.
function axisWeights(from, to) {
  const out = [];
  if (to >= from) {
    for (let i = 0; i < to; i++) {
      const x = Math.max(0, Math.min(from - 1, ((i + 0.5) * from) / to - 0.5)), x0 = Math.floor(x), x1 = Math.min(from - 1, x0 + 1), f = x - x0;
      out.push(f ? [[x0, 1 - f], [x1, f]] : [[x0, 1]]);
    }
    return out;
  }
  const k = from / to;
  for (let i = 0; i < to; i++) {
    const a = i * k, b = a + k, w = [];
    for (let x = Math.floor(a); x < Math.ceil(b) && x < from; x++) w.push([x, (Math.min(b, x + 1) - Math.max(a, x)) / k]);
    out.push(w);
  }
  return out;
}

// The picture at w x h. `premultiply`: weigh colour by alpha while resampling (for pictures, where alpha is coverage; not for
// textures, which keep a mask in alpha that has nothing to do with their colour).
export function resize(img, w, h, { premultiply = false } = {}) {
  if (img.w === w && img.h === h) return img;
  const wx = axisWeights(img.w, w), wy = axisWeights(img.h, h);
  const src = img.data, mid = new Float32Array(w * img.h * 4);
  for (let y = 0; y < img.h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (const [sx, f] of wx[x]) {
      const o = (y * img.w + sx) * 4, al = src[o + 3], m = premultiply ? (f * al) / 255 : f;
      r += src[o] * m; g += src[o + 1] * m; b += src[o + 2] * m; a += al * f;
    }
    const o = (y * w + x) * 4;
    mid[o] = r; mid[o + 1] = g; mid[o + 2] = b; mid[o + 3] = a;
  }
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (const [sy, f] of wy[y]) {
      const o = (sy * w + x) * 4;
      r += mid[o] * f; g += mid[o + 1] * f; b += mid[o + 2] * f; a += mid[o + 3] * f;
    }
    const o = (y * w + x) * 4, un = premultiply ? (a > 0 ? 255 / a : 0) : 1;
    out[o] = Math.round(Math.min(255, r * un)); out[o + 1] = Math.round(Math.min(255, g * un)); out[o + 2] = Math.round(Math.min(255, b * un)); out[o + 3] = Math.round(Math.min(255, a));
  }
  return { w, h, data: out };
}

// The picture scaled to fit inside w x h (its proportions kept), centred on a transparent canvas of that size: how Steam's
// item pictures are laid out.
export function fit(img, w, h) {
  const k = Math.min(w / img.w, h / img.h), iw = Math.max(1, Math.round(img.w * k)), ih = Math.max(1, Math.round(img.h * k));
  const scaled = resize(img, iw, ih, { premultiply: true }), out = new Uint8Array(w * h * 4);
  const ox = (w - iw) >> 1, oy = (h - ih) >> 1;
  for (let y = 0; y < ih; y++) out.set(scaled.data.subarray(y * iw * 4, (y + 1) * iw * 4), ((oy + y) * w + ox) * 4);
  return { w, h, data: out };
}

// The picture with its longest side at most `max` (proportions kept).
export function capSize(img, max) {
  const k = Math.min(1, max / Math.max(img.w, img.h));
  return k < 1 ? resize(img, Math.max(1, Math.round(img.w * k)), Math.max(1, Math.round(img.h * k))) : img;
}

// An RGBA PNG, each row with the filter that leaves the least to compress (PNG's usual heuristic: smallest sum of the filtered
// bytes as signed), so gradients and smooth art come out several times smaller than unfiltered. Deterministic: the same
// picture always gives the same bytes.
export function encode(img) {
  const { w, h, data } = img, stride = w * 4, raw = Buffer.alloc(h * (stride + 1));
  const cand = Array.from({ length: 5 }, () => Buffer.alloc(stride));
  for (let y = 0; y < h; y++) {
    const cur = data.subarray(y * stride, (y + 1) * stride), up = y ? data.subarray((y - 1) * stride, y * stride) : null;
    let best = 0, bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const o = cand[f];
      let sum = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= 4 ? cur[x - 4] : 0, b = up ? up[x] : 0, c = up && x >= 4 ? up[x - 4] : 0;
        let p;
        if (f === 0) p = cur[x];
        else if (f === 1) p = cur[x] - a;
        else if (f === 2) p = cur[x] - b;
        else if (f === 3) p = cur[x] - ((a + b) >> 1);
        else { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); p = cur[x] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
        o[x] = p & 255;
        sum += o[x] < 128 ? o[x] : 256 - o[x];
        if (sum >= bestSum) break;
      }
      if (sum < bestSum) { bestSum = sum; best = f; }
    }
    // (A filter stops early only once it's already worse than the best so far, so the best one's row is always whole.)
    raw[y * (stride + 1)] = best;
    cand[best].copy(raw, y * (stride + 1) + 1);
  }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const td = Buffer.concat([Buffer.from(type), body]), crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
export function writeImage(file, img) { fs.writeFileSync(file, encode(img)); }

// Whether any pixel is see-through (a picture meant to sit on the game's tiles should be).
export function hasTransparency(img) {
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] < 250) return true;
  return false;
}
