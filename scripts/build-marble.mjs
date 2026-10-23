// Marble Fade colour split per knife and pattern seed, computed from the player's CS2 install the way CS2 paints it:
// the seed rolls the pattern's rotation (CS2's random stream), the pattern lands on the knife's painted area through
// csgo_customweapon's pattern UV transform, and the anodized multicolour style layers yellow, red and blue by the
// pattern's R, G and B (then the knife mask's fixed red/blue). Writes src/data/marble-fade.json:
//   { [weapon id]: { [paint kit]: { t: tiers, c: [yellow, red, blue, ...] per seed 0-1000, ok } } }
// t is a string with one digit per seed: 3 Max Fire & Ice, 2 Fire & Ice, 1 Fake Fire & Ice, 0 none. Fire & Ice is the
// pattern rotated to the far end of the kit's range (the only thing the seed changes): the blade's playside then
// shows only red and blue. The cut-offs reproduce the community lists for the Karambit (412 max; 16, 146, 241, 359,
// 393, 541, 602, 649, 688, 701; fakes 152, 281, 292, 344, 628). c is the playside colour split (% of the painted
// blade), measured on the knife's own UV layout; ok says it agrees with the rotation ranking (some knives' masks also
// paint the guard or handle, which muddies it). build-data.mjs embeds this as data.marble for engine/patterns.js.
//   node scripts/build-marble.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { UniformRandomStream } from '../src/js/cs2/rng.js';

const require = createRequire(import.meta.url);
const { CS2Service } = require('../cs2/service.cjs');
const { decodePNG } = require('../cs2/png.cjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src', 'data', 'marble-fade.json');
const DATA = path.join(ROOT, 'src', 'data', 'game-data.json');
const SEEDS = 1001;
const SAMPLES = 60000; // painted texels per knife

const svc = new CS2Service({ cacheDir: path.join(ROOT, 'cache', 'cs2'), cliPath: path.join(ROOT, 'tools', 's2v', 'Source2Viewer-CLI.exe'), log: () => {} });
svc.url = (f) => f; // local paths
if (!svc.status().available) throw new Error('Counter-Strike 2 is not installed');

// Pattern UV transform, as skin.js xform (csgo_customweapon's material expressions).
const round2 = (x) => Math.floor((x + 0.005) * 100) / 100;
function xform(rotation, scale, offset, sizeScale) {
  const v0 = round2(rotation), v1 = round2(scale * sizeScale);
  const v3 = (v0 * Math.PI) / 180, v4 = Math.cos(v3), v5 = Math.sin(v3);
  const v6 = 0.5 / (v1 !== 0 ? v1 : 1);
  const v7 = Math.cos(-v3), v8 = Math.sin(-v3);
  const v9 = v6 * v7 - v6 * v8, v10 = v9 * v8 + v6 * v7;
  const ox = round2(offset[0]), oy = round2(offset[1]);
  return [[v4 * v1, -v5 * v1, v1 * v4 * v9 + v1 * -v5 * v10 + (ox - 0.5)], [v5 * v1, v4 * v1, v1 * v5 * v9 + v1 * v4 * v10 + (oy - 0.5)]];
}

// The kit's random rolls for a seed, in CS2's order (as skin.js rollInstance).
function rollInstance(kit, seed) {
  const rng = new UniformRandomStream(seed);
  const out = {};
  for (const r of kit.rolls || []) {
    // The pattern offset is drawn before the rotation even when the kit fixes it (see skin.js rollInstance).
    if (r.alias === 'econ_instance' && r.name === 'g_flPatternTexCoordRotation' && !kit.rolls.some((x) => x.name === 'g_vPatternTexCoordOffset')) {
      rng.randomFloat(0, 1); rng.randomFloat(0, 1);
    }
    out[r.alias + '.' + r.name] = r.comps === 1 ? rng.randomFloat(r.min ?? 0, r.max ?? 0)
      : [rng.randomFloat(r.min?.[0] ?? 0, r.max?.[0] ?? 0), rng.randomFloat(r.min?.[1] ?? 0, r.max?.[1] ?? 0)];
  }
  return out;
}
// Which side of the blade each texel is on: the knife's painted mesh is drawn into UV space (a W×H grid) with each
// triangle labelled by the sign of its normal along the blade's thin axis: bit 1 or bit 2 (both where the two faces
// share mirrored UVs; 0 = no surface there).
function sideMap(gltfFile, meshName, material, W, H) {
  const g = JSON.parse(fs.readFileSync(gltfFile, 'utf8'));
  const bin = fs.readFileSync(path.join(path.dirname(gltfFile), decodeURIComponent(g.buffers[0].uri)));
  const read = (ai) => {
    const a = g.accessors[ai], bv = g.bufferViews[a.bufferView];
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
    const size = { 5126: 4, 5125: 4, 5123: 2, 5121: 1 }[a.componentType];
    const stride = bv.byteStride || n * size, base = (bv.byteOffset || 0) + (a.byteOffset || 0);
    const out = new Float64Array(a.count * n);
    for (let i = 0; i < a.count; i++) {
      for (let c = 0; c < n; c++) {
        const o = base + i * stride + c * size;
        out[i * n + c] = a.componentType === 5126 ? bin.readFloatLE(o) : a.componentType === 5125 ? bin.readUInt32LE(o) : a.componentType === 5123 ? bin.readUInt16LE(o) : bin.readUInt8(o);
      }
    }
    return out;
  };
  const mesh = g.meshes.find((m) => m.name.endsWith(meshName)) || g.meshes[0];
  const prims = mesh.primitives.filter((p) => g.materials[p.material]?.name === material);
  const tris = [];
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of prims) {
    const pos = read(p.attributes.POSITION), uv = read(p.attributes.TEXCOORD_0), idx = read(p.indices);
    for (let i = 0; i < pos.length; i++) { lo[i % 3] = Math.min(lo[i % 3], pos[i]); hi[i % 3] = Math.max(hi[i % 3], pos[i]); }
    tris.push({ pos, uv, idx });
  }
  const size = [0, 1, 2].map((k) => hi[k] - lo[k]);
  const thin = size.indexOf(Math.min(...size));
  const grid = new Uint8Array(W * H);
  for (const { pos, uv, idx } of tris) {
    for (let t = 0; t < idx.length; t += 3) {
      const [i0, i1, i2] = [idx[t], idx[t + 1], idx[t + 2]];
      const e1 = [0, 1, 2].map((k) => pos[i1 * 3 + k] - pos[i0 * 3 + k]), e2 = [0, 1, 2].map((k) => pos[i2 * 3 + k] - pos[i0 * 3 + k]);
      const nrm = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const len = Math.hypot(...nrm) || 1;
      const along = nrm[thin] / len;
      if (Math.abs(along) < 0.35) continue; // spine and edges: neither side
      const side = along > 0 ? 1 : 2;
      // Rasterise the UV triangle (UVs wrap: use the fractional part of its first vertex's cell).
      const P = [i0, i1, i2].map((i) => [uv[i * 2] * W, uv[i * 2 + 1] * H]);
      const x0 = Math.floor(Math.min(...P.map((p) => p[0]))), x1 = Math.ceil(Math.max(...P.map((p) => p[0])));
      const y0 = Math.floor(Math.min(...P.map((p) => p[1]))), y1 = Math.ceil(Math.max(...P.map((p) => p[1])));
      const area = (P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (P[1][1] - P[0][1]);
      if (!area) continue;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5, py = y + 0.5;
          const w0 = ((P[1][0] - px) * (P[2][1] - py) - (P[2][0] - px) * (P[1][1] - py)) / area;
          const w1 = ((P[2][0] - px) * (P[0][1] - py) - (P[0][0] - px) * (P[2][1] - py)) / area;
          if (w0 < -1e-6 || w1 < -1e-6 || 1 - w0 - w1 < -1e-6) continue;
          const gx = ((x % W) + W) % W, gy = ((y % H) + H) % H;
          grid[gy * W + gx] |= side;
        }
      }
    }
  }
  return grid;
}

// A pass variable's value for this seed (instance rolls, else the kit's value).
const value = (v, rolled, fallback) => (v?.kind === 'instance' ? rolled[v.alias + '.' + v.name] ?? v.base?.value : v?.value) ?? fallback;

const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const jobs = new Map();
for (const s of Object.values(data.skins)) if (s.fin === 'Marble Fade' && s.cat === 'knife') jobs.set(s.wid + '|' + s.fid, s);

const out = {};
for (const [key, skin] of jobs) {
  const t0 = Date.now();
  const prep = await svc.prepare({ weapon: skin.wid, paint: skin.fid });
  const { kit, inputs } = prep;
  const maskFile = prep.textures[inputs?.textures?.g_tMasks];
  const patFile = prep.textures[kit.color.g_tPattern?.value];
  if (!maskFile || !patFile || !/\.png$/i.test(maskFile) || !/\.png$/i.test(patFile)) { console.warn('skip', key, 'textures missing'); continue; }
  const mask = decodePNG(fs.readFileSync(maskFile)), pat = decodePNG(fs.readFileSync(patFile));

  // The painted texels (mask R), sampled evenly, with their fixed red/blue (mask G/B).
  let painted = 0;
  for (let i = 0; i < mask.width * mask.height; i++) if (mask.data[i * mask.channels] > 127) painted++;
  const stride = Math.max(1, Math.round(Math.sqrt(painted / SAMPLES)));
  const gw = Math.ceil(mask.width / stride), gh = Math.ceil(mask.height / stride);
  const sides = sideMap(prep.model, prep.mesh, prep.material, gw, gh);
  const texels = [];
  for (let y = 0; y < mask.height; y += stride) {
    for (let x = 0; x < mask.width; x += stride) {
      const o = (y * mask.width + x) * mask.channels;
      const m = mask.data[o] / 255;
      const side = sides[Math.floor(y / stride) * gw + Math.floor(x / stride)];
      if (m <= 0.5 || !side) continue;
      texels.push((x + 0.5) / mask.width, (y + 0.5) / mask.height, m, mask.data[o + 1] / 255, mask.data[o + 2] / 255, side);
    }
  }

  const sizeScale = value(kit.color.g_bIgnoreWeaponSizeScale, {}, 0) ? 1 : inputs.uvScale;
  const scale = value(kit.color.g_flPatternTexCoordScale, {}, 1);
  const seeds = [], rots = [];
  for (let seed = 0; seed < SEEDS; seed++) {
    const rolled = rollInstance(kit, seed);
    const rot = value(kit.color.g_flPatternTexCoordRotation, rolled, 0);
    rots.push(rot);
    const off = value(kit.color.g_vPatternTexCoordOffset, rolled, [0, 0]);
    const [a, b] = xform(rot, scale, off, sizeScale);
    const acc = [0, 0, 0, 0, 0, 0]; // yellow, red, blue on side 1, then side 2
    for (let i = 0; i < texels.length; i += 6) {
      const u = texels[i], v = texels[i + 1], m = texels[i + 2];
      let pu = u * a[0] + v * a[1] + a[2], pv = u * b[0] + v * b[1] + b[2];
      pu -= Math.floor(pu); pv -= Math.floor(pv); // repeat sampling
      const po = ((Math.min(pat.height - 1, (pv * pat.height) | 0)) * pat.width + Math.min(pat.width - 1, (pu * pat.width) | 0)) * pat.channels;
      // Layer by layer like the shader: colour0, then yellow, red, blue by the pattern, then the mask's fixed red/blue.
      let base = 1, y = 0, r = 0, bl = 0;
      const mix = (t) => { base *= 1 - t; y *= 1 - t; r *= 1 - t; bl *= 1 - t; };
      let t = (pat.data[po] / 255) * m; mix(t); y += t;
      t = (pat.data[po + 1] / 255) * m; mix(t); r += t;
      t = (pat.data[po + 2] / 255) * m; mix(t); bl += t;
      t = texels[i + 3]; mix(t); r += t;
      t = texels[i + 4]; mix(t); bl += t;
      for (const k of texels[i + 5] === 3 ? [0, 3] : texels[i + 5] === 1 ? [0] : [3]) { acc[k] += y; acc[k + 1] += r; acc[k + 2] += bl; }
    }
    for (const k of [0, 3]) {
      const sum = acc[k] + acc[k + 1] + acc[k + 2] || 1;
      seeds.push(Math.round((acc[k] / sum) * 1000) / 10, Math.round((acc[k + 1] / sum) * 1000) / 10, Math.round((acc[k + 2] / sum) * 1000) / 10);
    }
  }
  // Playside: the face that can show no yellow at all (the lower minimum yellow over all seeds).
  let m1 = 100, m2 = 100;
  for (let i = 0; i < SEEDS; i++) { m1 = Math.min(m1, seeds[i * 6]); m2 = Math.min(m2, seeds[i * 6 + 3]); }
  const side = m1 <= m2 ? 0 : 3;
  const c = [];
  for (let i = 0; i < SEEDS; i++) c.push(seeds[i * 6 + side], seeds[i * 6 + side + 1], seeds[i * 6 + side + 2]);
  // Tiers by how close the rotation is to the far end of the kit's range.
  const roll = kit.rolls.find((r) => r.name === 'g_flPatternTexCoordRotation');
  const end = roll ? (Math.abs(roll.max) > Math.abs(roll.min) ? roll.max : roll.min) : 0;
  const t = rots.map((r) => { const d = Math.abs(r - end); return !roll ? 0 : d <= 0.05 ? 3 : d <= 0.265 ? 2 : d <= 0.47 ? 1 : 0; }).join('');
  // The measurement agrees when its least-yellow, most-red seeds are mostly the most-rotated ones.
  const ymin = Math.min(m1, m2);
  const byColour = [...Array(SEEDS).keys()].filter((i) => c[i * 3] <= ymin + 0.5).sort((a, b) => c[b * 3 + 1] - c[a * 3 + 1]).slice(0, 6);
  const byRotation = [...Array(SEEDS).keys()].sort((a, b) => Math.abs(rots[a] - end) - Math.abs(rots[b] - end)).slice(0, 6);
  // ...and it can show a blade with (almost) no yellow at all, like a real Fire & Ice.
  const ok = byColour.filter((i) => byRotation.includes(i)).length >= 4 && ymin <= 6;
  (out[skin.wid] ||= {})[skin.fid] = { t, c, ok };
  console.log(skin.n, `${texels.length / 6} texels`, ok ? 'colours ok' : 'colours unreliable', t.split('').filter((x) => x >= '2').length + ' Fire & Ice', ((Date.now() - t0) / 1000).toFixed(1) + 's');
}

fs.writeFileSync(OUT, JSON.stringify(out));
// Also refresh the copy inside game-data.json (build-data.mjs embeds it on a full rebuild).
data.marble = out;
fs.writeFileSync(DATA, JSON.stringify(data));
console.log('wrote', OUT);
