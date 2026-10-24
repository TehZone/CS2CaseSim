// Textures extracted from the CS2 install (downscaled on decode; premultiplication off so packed data channels survive).
import * as THREE from 'three';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';

const MAX_TEX = 2048;

// Exact PNG decode (8-bit, non-interlaced): browsers may drop the colour of pixels whose alpha is 0 when they
// decode images, but CS2's data textures keep values in RGB under a zero alpha (layer IDs, tint masks...).
// Returns null for PNGs this doesn't handle (the browser's decoder is used then).
async function decodePngExact(url) {
  const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const dv = new DataView(buf.buffer);
  let pos = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = dv.getUint32(pos), type = String.fromCharCode(...buf.subarray(pos + 4, pos + 8));
    if (type === 'IHDR') { w = dv.getUint32(pos + 8); h = dv.getUint32(pos + 12); depth = buf[pos + 16]; ctype = buf[pos + 17]; interlace = buf[pos + 20]; }
    else if (type === 'IDAT') idat.push(buf.subarray(pos + 8, pos + 8 + len));
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ctype];
  if (depth !== 8 || interlace || !ch || Math.max(w, h) > MAX_TEX) return null;
  const raw = new Uint8Array(await new Response(new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  const stride = w * ch, out = new Uint8Array(w * h * 4);
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[x] = v;
    }
    for (let x = 0, o = y * w * 4; x < w; x++, o += 4) {
      const i = x * ch;
      if (ch >= 3) { out[o] = cur[i]; out[o + 1] = cur[i + 1]; out[o + 2] = cur[i + 2]; out[o + 3] = ch === 4 ? cur[i + 3] : 255; }
      else { out[o] = out[o + 1] = out[o + 2] = cur[i]; out[o + 3] = ch === 2 ? cur[i + 1] : 255; }
    }
    [prev, cur] = [cur, prev];
  }
  return { data: out, w, h };
}

const sourceCache = new Map();
export async function loadSource(url, { exact = false } = {}) {
  const key = (exact ? 'exact:' : '') + url;
  if (!sourceCache.has(key)) {
    const job = (async () => {
      if (exact && /\.png$/i.test(url)) {
        const px = await decodePngExact(url);
        if (px) return { pixels: px };
      }
      if (/\.exr$/i.test(url)) {
        const t = await new EXRLoader().loadAsync(url);
        // three's EXRLoader stores rows bottom-up; CS2 (and our PNGs) use top-down rows.
        const { width: w, height: h, data } = t.image;
        const row = (data.length / h) | 0;
        const tmp = new data.constructor(row);
        for (let y = 0; y < h >> 1; y++) {
          const a = y * row, b = (h - 1 - y) * row;
          tmp.set(data.subarray(a, a + row));
          data.copyWithin(a, b, b + row);
          data.set(tmp, b);
        }
        return { exr: t, w };
      }
      const blob = await (await fetch(url)).blob();
      const head = new DataView(await blob.slice(16, 24).arrayBuffer());
      const w = head.getUint32(0), h = head.getUint32(4);
      const k = Math.min(1, MAX_TEX / Math.max(w, h));
      const opts = { premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'from-image' };
      if (k < 1) Object.assign(opts, { resizeWidth: Math.round(w * k), resizeHeight: Math.round(h * k), resizeQuality: 'high' });
      return { bitmap: await createImageBitmap(blob, opts) };
    })();
    sourceCache.set(key, job);
    job.catch(() => sourceCache.delete(key));
  }
  return sourceCache.get(key);
}

// `exact`: decode PNGs exactly (see decodePngExact), for data textures whose colour matters where alpha is 0.
// `shared`: one texture per image and settings for everyone who asks (a model's maps: the bots' guns, your viewmodel
// and the one you see spectating share the same images, uploaded once). Don't change a shared one; disposing it is
// fine (it's uploaded again when next drawn).
const sharedTextures = new Map();
export function texture(url, opts = {}) {
  if (!opts.shared) return makeTexture(url, opts);
  const key = [url, opts.srgb, opts.wrapS, opts.wrapT, opts.exact].join('|');
  if (!sharedTextures.has(key)) {
    const job = makeTexture(url, opts);
    sharedTextures.set(key, job);
    job.catch(() => sharedTextures.delete(key));
  }
  return sharedTextures.get(key);
}
async function makeTexture(url, { srgb = false, wrapS = THREE.RepeatWrapping, wrapT = THREE.RepeatWrapping, exact = false } = {}) {
  const src = await loadSource(url, { exact });
  let t;
  if (src.exr) {
    t = src.exr.clone();
    t.needsUpdate = true;
  } else if (src.pixels) {
    t = new THREE.DataTexture(src.pixels.data, src.pixels.w, src.pixels.h, THREE.RGBAFormat);
    t.needsUpdate = true;
  } else {
    t = new THREE.Texture(src.bitmap);
    t.flipY = false;
    t.premultiplyAlpha = false;
    t.needsUpdate = true;
  }
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = wrapS;
  t.wrapT = wrapT;
  t.generateMipmaps = !src.exr;
  t.minFilter = src.exr ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 8;
  return t;
}

// 1x1 texture of one RGBA8 value (stand-in for a texture a material does not set).
export function solidTex(r, g, b, a) {
  const t = new THREE.DataTexture(new Uint8Array([r, g, b, a]), 1, 1);
  t.needsUpdate = true;
  return t;
}

let white = null;
export function whiteTex() {
  if (!white) white = solidTex(255, 255, 255, 255);
  return white;
}
