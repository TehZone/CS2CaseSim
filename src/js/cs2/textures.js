// Textures extracted from the CS2 install (downscaled on decode; premultiplication off so packed data channels survive).
import * as THREE from 'three';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';

const MAX_TEX = 2048;

const sourceCache = new Map();
export async function loadSource(url) {
  if (!sourceCache.has(url)) {
    const job = (async () => {
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
    sourceCache.set(url, job);
    job.catch(() => sourceCache.delete(url));
  }
  return sourceCache.get(url);
}

export async function texture(url, { srgb = false, wrapS = THREE.RepeatWrapping, wrapT = THREE.RepeatWrapping } = {}) {
  const src = await loadSource(url);
  let t;
  if (src.exr) {
    t = src.exr.clone();
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
