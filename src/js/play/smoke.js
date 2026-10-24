// CS2's volumetric smoke: the cloud floods the space it lands in (voxels flood-filled outwards from the grenade, so it
// pours around corners, through doors and down stairs, but never through walls), bursts out like CS2's (near full size
// in about a second, fully bloomed by 1.5 s), lasts
// 18 seconds and thins out from its edges. Bullets punch tunnels through it and an HE grenade blows a hole in it,
// both of which close up again. Sight lines (yours, the bots') are blocked by how much smoke they pass through, so you
// can see through a hole or a thin edge. Game units (inches, Z up). Drawn by the composite pass in post.js; each voxel
// carries its density and its light (sky from above, less under more smoke; the sun through the cloud towards it),
// worked out here so the shader reads one texel per step.
import * as THREE from 'three';
import { FLAG_BULLET } from './collision.js';

export const VOX = 16, NX = 32, NY = 32, NZ = 16, SLOTS = 6;
const N = NX * NY * NZ;
export const SMOKE_TIME = 18;
// (The flood fill takes about 18 ticks: still well ahead of the bloom, and each tick's collision checks stay small.)
const FADE = 3, MAX_CELLS = 2300, MAX_COST = 24, MAX_RISE = 9, FILL_PER_TICK = 130;
// The bloom: the edge of the cloud reaches a cell at BLOOM * (1 - sqrt(1 - its share of the way out)) seconds (fast at
// first, slowing as it spreads, like CS2's), and each cell then thickens over GROW seconds.
const BLOOM = 1.2, GROW = 0.25, BLOOM_DONE = 0.05 + BLOOM + GROW;
// Holes hold seconds until they're refilled: clear until the last REFILL seconds, then filling back in.
const TUNNEL = 1.15, TUNNEL_SIDE = 0.55, BLAST = 2.4, BLAST_CORE = 1.6, BLAST_RADIUS = 190, REFILL = 0.7;
const BLOCK = 30; // units of full smoke that hide what's behind
export const LIGHT_SCALE = 2; // voxel light is stored halved (it goes above 1)

// Binary min-heap of (cost, cell).
class Heap {
  constructor() { this.c = []; this.i = []; }
  get size() { return this.c.length; }
  push(cost, idx) {
    const c = this.c, i = this.i;
    let k = c.length;
    c.push(cost); i.push(idx);
    while (k > 0) { const p = (k - 1) >> 1; if (c[p] <= c[k]) break; [c[p], c[k]] = [c[k], c[p]]; [i[p], i[k]] = [i[k], i[p]]; k = p; }
  }
  pop() {
    const c = this.c, i = this.i, top = [c[0], i[0]], lc = c.pop(), li = i.pop();
    if (c.length) {
      c[0] = lc; i[0] = li;
      let k = 0;
      for (;;) {
        const l = k * 2 + 1, r = l + 1;
        let m = k;
        if (l < c.length && c[l] < c[m]) m = l;
        if (r < c.length && c[r] < c[m]) m = r;
        if (m === k) break;
        [c[m], c[k]] = [c[k], c[m]]; [i[m], i[k]] = [i[k], i[m]]; k = m;
      }
    }
    return top;
  }
}

// One smoke cloud on a 32 x 32 x 16 grid of 16-unit cells around where the grenade popped.
export class SmokeField {
  constructor(world, pos, now, slot) {
    this.world = world;
    this.slot = slot;
    this.pos = pos.slice();
    this.born = now;
    this.until = now + SMOKE_TIME;
    this.min = [Math.floor(pos[0] / VOX) * VOX - (NX / 2) * VOX, Math.floor(pos[1] / VOX) * VOX - (NY / 2) * VOX, Math.floor(pos[2] / VOX) * VOX - 2 * VOX];
    this.state = new Uint8Array(N); // 0 unknown, 1 free, 2 filled, 3 solid
    this.cost = new Float64Array(N).fill(Infinity); // doubles: the heap compares against these exactly
    this.hole = new Float32Array(N);
    this.cells = []; // filled, in fill order
    this.skin = []; // solid cells under/over the cloud (they carry its density so it sits on the floor; not walls: it would
    // show through a thin wall on the other side)
    this.inSkin = new Uint8Array(N);
    this.heap = new Heap();
    this.maxCost = 1;
    this.holes = false;
    // Start in the grenade's cell, or the nearest free one around and above it (it rests on the floor, maybe by a wall).
    const [x0, y0, z0] = this.cellOf([pos[0], pos[1], pos[2] + 6]);
    start: for (let up = 0; up < 4; up++) {
      for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        if (!this.isFree(x0 + dx, y0 + dy, z0 + up)) continue;
        const k = this.idx(x0 + dx, y0 + dy, z0 + up);
        this.cost[k] = 0; this.heap.push(0, k); this.startZ = z0 + up;
        break start;
      }
    }
    this.done = !this.heap.size;
  }

  idx(x, y, z) { return x + NX * (y + NY * z); }
  cellOf(p) { return [Math.floor((p[0] - this.min[0]) / VOX), Math.floor((p[1] - this.min[1]) / VOX), Math.floor((p[2] - this.min[2]) / VOX)]; }
  isFree(x, y, z) {
    if (x < 1 || y < 1 || z < 1 || x > NX - 2 || y > NY - 2 || z > NZ - 2) return false; // keep a clear border (texture packing)
    const k = this.idx(x, y, z);
    if (!this.state[k]) {
      // The whole cell, a little oversized: neighbouring cells overlap, so no surface (a floor, a wall) slips between them.
      const lo = [this.min[0] + x * VOX - 0.5, this.min[1] + y * VOX - 0.5, this.min[2] + z * VOX - 0.5];
      this.state[k] = this.world.boxOverlap(lo, [lo[0] + VOX + 1, lo[1] + VOX + 1, lo[2] + VOX + 1], FLAG_BULLET) ? 3 : 1;
    }
    return this.state[k] !== 3;
  }

  // Grows the flood fill (cheapest path first: spreading sideways is cheap, rising costs more).
  fill(budget = FILL_PER_TICK) {
    const h = this.heap;
    while (budget-- > 0 && h.size && this.cells.length < MAX_CELLS) {
      const [c, k] = h.pop();
      if (this.state[k] === 2 || c > this.cost[k]) continue;
      if (c > MAX_COST) { h.c.length = 0; h.i.length = 0; break; }
      this.state[k] = 2;
      this.cells.push(k);
      this.maxCost = Math.max(this.maxCost, c);
      const x = k % NX, y = Math.floor(k / NX) % NY, z = Math.floor(k / (NX * NY));
      for (const [dx, dy, dz, w] of [[1, 0, 0, 1], [-1, 0, 0, 1], [0, 1, 0, 1], [0, -1, 0, 1], [0, 0, 1, 1.35], [0, 0, -1, 0.9]]) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (nz > this.startZ + MAX_RISE) continue;
        const n = this.idx(nx, ny, nz);
        if (!this.isFree(nx, ny, nz)) { if (dz && this.state[n] === 3 && !this.inSkin[n]) { this.inSkin[n] = 1; this.skin.push(n); } continue; }
        const nc = c + w * (0.8 + Math.random() * 0.45); // uneven, so the cloud's outline is lumpy
        if (this.state[n] !== 2 && nc < this.cost[n]) { this.cost[n] = nc; h.push(nc, n); }
      }
    }
    if (!h.size || this.cells.length >= MAX_CELLS) this.done = true;
  }

  // How much smoke a cell holds now (0..1): blooming out from the grenade, thinning from the edges at the end,
  // minus any hole.
  cellDensity(k, now) {
    if (this.state[k] !== 2) return 0;
    const c = this.cost[k];
    const reach = 0.05 + BLOOM * (1 - Math.sqrt(Math.max(0, 1 - Math.min(1, c / this.maxCost))));
    const grow = Math.min(1, Math.max(0, (now - this.born - reach) / GROW));
    const fade = Math.min(1, Math.max(0, (this.until - now) / FADE + (1 - c / this.maxCost) * 0.7));
    return grow * fade * (1 - Math.min(1, this.hole[k] / REFILL));
  }
  densityAt(p, now) { return this.densityXYZ(p[0], p[1], p[2], now); }
  densityXYZ(px, py, pz, now) {
    const x = Math.floor((px - this.min[0]) / VOX), y = Math.floor((py - this.min[1]) / VOX), z = Math.floor((pz - this.min[2]) / VOX);
    if (x < 0 || y < 0 || z < 0 || x >= NX || y >= NY || z >= NZ) return 0;
    return this.cellDensity(this.idx(x, y, z), now);
  }

  // Holes close up again.
  heal(dt) {
    if (!this.holes) return;
    let any = false;
    for (const k of this.cells) {
      const h = this.hole[k];
      if (h <= 0) continue;
      this.hole[k] = Math.max(0, h - dt);
      any = true;
    }
    this.holes = any;
  }

  // The part of a segment inside this grid: [t0, t1] along the unit direction, or null.
  clip(o, d, maxT) {
    let t0 = 0, t1 = maxT;
    for (let i = 0; i < 3; i++) {
      const lo = this.min[i] + VOX, hi = this.min[i] + ([NX, NY, NZ][i] - 1) * VOX;
      if (Math.abs(d[i]) < 1e-9) { if (o[i] < lo || o[i] > hi) return null; continue; }
      let a = (lo - o[i]) / d[i], b = (hi - o[i]) / d[i];
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a); t1 = Math.min(t1, b);
      if (t0 > t1) return null;
    }
    return [t0, t1];
  }

  // A bullet passing through: a tunnel about a cell wide.
  carve(o, d, maxT) {
    const seg = this.clip(o, d, maxT);
    if (!seg) return;
    for (let t = seg[0]; t <= seg[1]; t += 6) {
      const [x, y, z] = this.cellOf([o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t]);
      for (const [dx, dy, dz, v] of [[0, 0, 0, TUNNEL], [1, 0, 0, TUNNEL_SIDE], [-1, 0, 0, TUNNEL_SIDE], [0, 1, 0, TUNNEL_SIDE], [0, -1, 0, TUNNEL_SIDE], [0, 0, 1, TUNNEL_SIDE], [0, 0, -1, TUNNEL_SIDE]]) {
        const cx = x + dx, cy = y + dy, cz = z + dz;
        if (cx < 0 || cy < 0 || cz < 0 || cx >= NX || cy >= NY || cz >= NZ) continue;
        const k = this.idx(cx, cy, cz);
        if (this.state[k] === 2 && this.hole[k] < v) { this.hole[k] = v; this.holes = true; }
      }
    }
  }

  // An HE grenade: a big hole that refills from its edges.
  blast(p) {
    for (const k of this.cells) {
      const x = k % NX, y = Math.floor(k / NX) % NY, z = Math.floor(k / (NX * NY));
      const c = [this.min[0] + (x + 0.5) * VOX, this.min[1] + (y + 0.5) * VOX, this.min[2] + (z + 0.5) * VOX];
      const d = Math.hypot(c[0] - p[0], c[1] - p[1], c[2] - p[2]);
      if (d < BLAST_RADIUS) { this.hole[k] = Math.max(this.hole[k], BLAST + (1 - d / BLAST_RADIUS) * BLAST_CORE); this.holes = true; }
    }
  }

  // Units of full smoke along a segment.
  // (Every bot's sight lines through a cloud, several times a second: the densities come from the texture's last write
  // when there's been one, see write, and nothing is allocated a step.)
  thickness(a, b, now) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], l = Math.hypot(dx, dy, dz);
    if (l < 1e-6) return 0;
    const d = [dx / l, dy / l, dz / l];
    const seg = this.clip(a, d, l);
    if (!seg) return 0;
    const dens = this.dens;
    let sum = 0;
    for (let t = seg[0] + 4; t < seg[1]; t += 8) {
      const x = Math.floor((a[0] + d[0] * t - this.min[0]) / VOX), y = Math.floor((a[1] + d[1] * t - this.min[1]) / VOX), z = Math.floor((a[2] + d[2] * t - this.min[2]) / VOX);
      if (x < 0 || y < 0 || z < 0 || x >= NX || y >= NY || z >= NZ) continue;
      const k = x + NX * (y + NY * z);
      sum += (dens ? dens[k] : this.cellDensity(k, now)) * 8;
    }
    return sum;
  }

  // The light at a height with this much smoke above and towards the sun (linear RGB, before LIGHT_SCALE): the sky from
  // above (less deep inside, under more smoke) and the sun through the cloud. lit = { sunDir, sun, sky, ground } (game
  // space, colours as [r, g, b]).
  lightOf(z, toSun, above, lit, out) {
    const up = Math.min(1, Math.max(0, (z - (this.startZ ?? 3)) / 8)), occ = 1 - 0.32 * Math.min(1, above * 0.6), sun = Math.exp(-toSun * 1.8);
    for (let i = 0; i < 3; i++) out[i] = ((lit.ground[i] + (lit.sky[i] - lit.ground[i]) * (0.3 + 0.7 * up)) * occ + lit.sun[i] * sun) * 0.72;
    return out;
  }

  // This cloud's voxels into its slot of the shared RGBA 3D texture: light in RGB, density in A. Empty cells keep the
  // open-air light (so the edges blend to it); the floor and ceiling cells next to the cloud get its density too, so
  // the smoke meets the ground (the depth test, not the voxel, decides where it ends).
  // A cell's light looks at the smoke 20, 52 and 96 units towards the sun and 40 and 90 above it: from a cell's middle
  // those land a whole number of cells away, the same from every cell, so it's all done by cell index. (This runs for
  // thousands of cells a frame while a cloud blooms or fades, and is written out in one loop: numbers passed to or
  // returned from a call that isn't inlined are boxed, which made hundreds of MB of garbage a smoke.)
  write(data, now, lit) {
    const base = this.slot * N, rgb = [0, 0, 0];
    const put = (k, a, light) => {
      const o = (base + k) * 4;
      for (let i = 0; i < 3; i++) data[o + i] = Math.min(255, Math.round((light[i] / LIGHT_SCALE) * 255));
      data[o + 3] = a;
    };
    if (!this.airLit) {
      // The open air's light only changes with height: worked out once a layer, not for each of the 16384 cells.
      this.airLit = true;
      for (let z = 0; z < NZ; z++) {
        this.lightOf(z, 0, 0, lit, rgb);
        for (let k = z * NX * NY; k < (z + 1) * NX * NY; k++) put(k, 0, rgb);
      }
    }
    for (const k of this.skin) data[(base + k) * 4 + 3] = 0;
    const dens = this.dens ||= new Float32Array(N); // (cells that aren't smoke stay 0)
    const life = now - this.born, left = this.until - now, mc = this.maxCost;
    for (const k of this.cells) {
      const c = this.cost[k];
      const reach = 0.05 + BLOOM * (1 - Math.sqrt(Math.max(0, 1 - Math.min(1, c / mc))));
      const grow = Math.min(1, Math.max(0, (life - reach) / GROW)), fade = Math.min(1, Math.max(0, left / FADE + (1 - c / mc) * 0.7));
      dens[k] = grow * fade * (1 - Math.min(1, this.hole[k] / REFILL)); // (cellDensity)
    }
    const sd = lit.sunDir, step = (d, i) => Math.floor(0.5 + (sd[i] * d) / VOX);
    const s1x = step(20, 0), s1y = step(20, 1), s1z = step(20, 2), s2x = step(52, 0), s2y = step(52, 1), s2z = step(52, 2);
    const s3x = step(96, 0), s3y = step(96, 1), s3z = step(96, 2), layer = NX * NY;
    const g = lit.ground, sky = lit.sky, sun = lit.sun, startZ = this.startZ ?? 3;
    for (const k of this.cells) {
      const x = k % NX, y = Math.floor(k / NX) % NY, z = Math.floor(k / layer);
      let toSun = 0, above = 0, X = x + s1x, Y = y + s1y, Z = z + s1z;
      if (X >= 0 && Y >= 0 && Z >= 0 && X < NX && Y < NY && Z < NZ) toSun += dens[X + NX * (Y + NY * Z)];
      X = x + s2x; Y = y + s2y; Z = z + s2z;
      if (X >= 0 && Y >= 0 && Z >= 0 && X < NX && Y < NY && Z < NZ) toSun += dens[X + NX * (Y + NY * Z)];
      X = x + s3x; Y = y + s3y; Z = z + s3z;
      if (X >= 0 && Y >= 0 && Z >= 0 && X < NX && Y < NY && Z < NZ) toSun += dens[X + NX * (Y + NY * Z)];
      if (z + 3 < NZ) above += dens[k + 3 * layer];
      if (z + 6 < NZ) above += dens[k + 6 * layer];
      const up = Math.min(1, Math.max(0, (z - startZ) / 8)), occ = 1 - 0.32 * Math.min(1, above * 0.6), lightSun = Math.exp(-toSun * 1.8);
      for (let i = 0; i < 3; i++) rgb[i] = ((g[i] + (sky[i] - g[i]) * (0.3 + 0.7 * up)) * occ + sun[i] * lightSun) * 0.72; // (lightOf)
      const a = Math.round(dens[k] * 255);
      put(k, a, rgb);
      const below = k - layer, over = k + layer;
      if (this.inSkin[below] && data[(base + below) * 4 + 3] < a) put(below, a, rgb);
      if (this.inSkin[over] && data[(base + over) * 4 + 3] < a) put(over, a, rgb);
    }
  }
}

// A tiling 3D value noise for the cloud's wisps.
function noiseTexture(size = 32) {
  const data = new Uint8Array(size * size * size);
  for (let i = 0; i < data.length; i++) data[i] = Math.floor(Math.random() * 256);
  const t = new THREE.Data3DTexture(data, size, size, size);
  t.format = THREE.RedFormat;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

// Every smoke on the map, packed into one 3D texture (one 32 x 32 x 16 slot each) for the composite shader.
export class SmokeSystem {
  constructor(game) {
    this.game = game;
    this.fields = [];
    this.data = new Uint8Array(N * SLOTS * 4);
    this.tex = new THREE.Data3DTexture(this.data, NX, NY, NZ * SLOTS);
    this.tex.format = THREE.RGBAFormat;
    this.tex.minFilter = this.tex.magFilter = THREE.LinearFilter;
    this.tex.wrapS = this.tex.wrapT = this.tex.wrapR = THREE.ClampToEdgeWrapping;
    this.tex.unpackAlignment = 1;
    this.tex.needsUpdate = true;
    this.noise = noiseTexture();
    this.uniforms = {
      tSmoke: { value: this.tex }, tSmokeNoise: { value: this.noise }, smokeCount: { value: 0 },
      smokeMin: { value: Array.from({ length: SLOTS }, () => new THREE.Vector3()) }, smokeSlot: { value: new Array(SLOTS).fill(0) },
      smokeLife: { value: new Array(SLOTS).fill(0) }, smokeTime: { value: 0 },
    };
    this.dirty = true;
    this.lighting = { sunDir: [0, 0, 1], sun: [1, 1, 1], sky: [0.5, 0.5, 0.55], ground: [0.4, 0.35, 0.3] };
  }

  get active() { return this.fields.length > 0; }
  // The map's light for the clouds (set once the world is loaded).
  setLighting(l) { this.lighting = l; }

  add(pos) {
    const used = new Set(this.fields.map((f) => f.slot));
    let slot = [...Array(SLOTS).keys()].find((s) => !used.has(s));
    if (slot == null) { const old = this.fields.shift(); slot = old.slot; }
    this.data.fill(0, slot * N * 4, (slot + 1) * N * 4);
    const f = new SmokeField(this.game.collision, pos, this.game.now, slot);
    f.fill(FILL_PER_TICK);
    this.fields.push(f);
    this.dirty = true;
    return f;
  }

  tick(dt) {
    const now = this.game.now;
    for (let i = this.fields.length - 1; i >= 0; i--) {
      const f = this.fields[i];
      if (now > f.until) { this.data.fill(0, f.slot * N * 4, (f.slot + 1) * N * 4); this.fields.splice(i, 1); this.dirty = true; continue; }
      if (!f.done) f.fill();
      f.heal(dt);
    }
  }

  // Refreshes the texture while anything is changing (blooming, fading, holes) and the shader's per-smoke uniforms.
  update() {
    const now = this.game.now, u = this.uniforms;
    let changed = this.dirty;
    for (const f of this.fields) {
      const age = now - f.born;
      if (age < BLOOM_DONE + 0.1 || f.until - now < FADE + 1 || f.holes || !f.done || f.wroteHole) {
        f.write(this.data, now, this.lighting);
        f.wroteHole = f.holes;
        changed = true;
      }
    }
    if (changed) this.tex.needsUpdate = true;
    this.dirty = false;
    u.smokeCount.value = this.fields.length;
    u.smokeTime.value = now;
    this.fields.forEach((f, i) => {
      u.smokeMin.value[i].set(f.min[0], f.min[1], f.min[2]);
      u.smokeSlot.value[i] = f.slot;
      u.smokeLife.value[i] = Math.min(1, Math.max(0, (f.until - now) / FADE));
    });
  }

  carve(o, d, maxT) { for (const f of this.fields) f.carve(o, d, maxT); }
  blast(p) { for (const f of this.fields) f.blast(p); }
  blocks(a, b) { const now = this.game.now; let sum = 0; for (const f of this.fields) { sum += f.thickness(a, b, now); if (sum > BLOCK) return true; } return false; }
  // Units of full smoke between two points.
  thickness(a, b) { const now = this.game.now; return this.fields.reduce((sum, f) => sum + f.thickness(a, b, now), 0); }
  densityAt(p) { const now = this.game.now; return this.fields.reduce((m, f) => Math.max(m, f.densityAt(p, now)), 0); }
  clear() { this.fields = []; this.data.fill(0); this.dirty = true; }
  dispose() { this.tex.dispose(); this.noise.dispose(); }
}
