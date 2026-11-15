// CS2's volumetric smoke: the cloud floods the space it lands in (voxels flood-filled outwards from the grenade, so it
// pours around corners, through doors and down stairs, but never through walls), bursts out like CS2's (near full size
// in about a second, fully bloomed by 1.5 s), lasts
// 18 seconds and thins out from its edges. Bullets punch tunnels through it and an HE grenade blows a hole in it,
// both of which close up again. Sight lines (yours, the bots') are blocked by how much smoke they pass through, so you
// can see through a hole or a thin edge. Game units (inches, Z up). Drawn by the composite pass in post.js; each voxel
// carries its density and its light (sky from above, less under more smoke; the sun through the cloud towards it),
// worked out here so the shader reads one texel per step.
// Its shape is one round dome, wider than tall, centred on the grenade: how far out a cell is from the grenade is a
// straight-line distance (around whatever's in the way), and how high it is counts from the ground the grenade landed
// on. Smoke rests on the ground or on more smoke, so popped on a box, a ledge or a roof's edge, the dome carries on out
// over the edge and the smoke under it pours down to the ground below (filling it from the ground up), rather than
// hanging out over the drop; nothing of it is ever left in the air with nothing under it.
import * as THREE from 'three';
import { FLAG_BULLET } from './collision.js';

export const VOX = 16, NX = 32, NY = 32, NZ = 32, SLOTS = 6;
const LAYER = NX * NY, N = LAYER * NZ;
export const SMOKE_TIME = 18;
// (The flood fill takes 25 to 40 ticks: still well ahead of the bloom, and each tick's collision checks stay small.)
// Several filling at once share FILL_SHARED a tick (at least FILL_MIN each), so smokes landing together don't stack up.
const FADE = 3, MAX_CELLS = 2300, MAX_COST = 24, MAX_RISE = 12, FILL_PER_TICK = 130, FILL_SHARED = 400, FILL_MIN = 100;
// The cloud's shape (in cells): a cell's cost is its distance out and its height (TALL times as much: the dome is that
// much wider than tall), as an ellipse, times a lumpy noise of LUMPS either way in lumps about LUMP cells across. Onto
// higher ground (a step, a box, over a low wall) each cell climbed counts as CLIMB cells further out, and its height
// counts from that ground, but no more than RAISE cells above the grenade's (so the dome rises a little over it, it
// doesn't start again from it).
// Smoke that poured down below the grenade's level spreads out as it falls: SPILL cells further for each cell it fell, at
// most SPILL_MAX (so it flares out to the foot of a drop, wider than the dome over it, not a wall straight down).
const TALL = 1.4, CLIMB = 1, LUMPS = 0.12, LUMP = 4, RAISE = 2, SPILL = 0.4, SPILL_MAX = 3;
// How far down the grid reaches under the grenade's cell (cells): BELOW, which leaves room for MAX_RISE above (and the
// start a cell up), or to the ground under the cloud's edges if that's deeper, at most DEEPEST (and then a cloud up on
// top has less room to rise, though most of it has poured down). Over a drop deeper than that it doesn't go: it's cut
// off at the edge.
const BELOW = NZ - MAX_RISE - 3, DEEPEST = NZ - 7;
// The bloom: the edge of the cloud reaches a cell at BLOOM * (1 - sqrt(1 - its share of the way out)) seconds (fast at
// first, slowing as it spreads, like CS2's), and each cell then thickens over GROW seconds. Smoke that poured down below
// the grenade's level gets there FALL seconds later for each cell it fell (so it's seen falling, not there at once).
const BLOOM = 1.2, GROW = 0.25, BLOOM_DONE = 0.05 + BLOOM + GROW, FALL = 0.035;
// Holes hold seconds until they're refilled: clear until the last REFILL seconds, then filling back in.
const TUNNEL = 1.15, TUNNEL_SIDE = 0.55, BLAST = 2.4, BLAST_CORE = 1.6, BLAST_RADIUS = 190, REFILL = 0.7;
const BLOCK = 30; // units of full smoke that hide what's behind
export const LIGHT_SCALE = 2; // voxel light is stored halved (it goes above 1)
const DIMS = [NX, NY, NZ], _dir = [0, 0, 0], _lo = [0, 0, 0], _hi = [0, 0, 0]; // (scratch: plain arrays, see collision.js)
const _from = [0, 0, 0], _to = [0, 0, 0], DOWN = [0, 0, -1];
const LX = NX / LUMP + 2, LY = NY / LUMP + 2, LZ = NZ / LUMP + 2; // (the lumps' lattice)
// Where the cloud starts: the grenade's cell, then those round it.
const AROUND = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];

// Binary min-heap of (cost, cell). (Nothing made as it goes: pop returns the cell and leaves its cost in topCost.)
class Heap {
  constructor() { this.c = []; this.i = []; this.topCost = 0; }
  get size() { return this.c.length; }
  push(cost, idx) {
    const c = this.c, i = this.i;
    let k = c.length;
    c.push(cost); i.push(idx);
    while (k > 0) { const p = (k - 1) >> 1; if (c[p] <= c[k]) break; swap(c, i, p, k); k = p; }
  }
  pop() {
    const c = this.c, i = this.i, top = i[0], lc = c.pop(), li = i.pop();
    this.topCost = c.length ? c[0] : lc; // (before c[0] is overwritten: the cost of the one popped)
    if (c.length) {
      c[0] = lc; i[0] = li;
      let k = 0;
      for (;;) {
        const l = k * 2 + 1, r = l + 1;
        let m = k;
        if (l < c.length && c[l] < c[m]) m = l;
        if (r < c.length && c[r] < c[m]) m = r;
        if (m === k) break;
        swap(c, i, m, k); k = m;
      }
    }
    return top;
  }
}
function swap(c, i, a, b) { const x = c[a]; c[a] = c[b]; c[b] = x; const y = i[a]; i[a] = i[b]; i[b] = y; }
// The flood fill's neighbours: [dx, dy, dz].
const NEIGHBOURS = [1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1];

// Where the grid's bottom goes (game units): low enough for the ground under the cloud, so off a ledge, a box or a roof
// the smoke pours down onto it. BELOW cells under the grenade's, or the lowest ground (that fits) below the grenade's
// level, straight down and out to the cloud's edge in 8 directions, of what it can see at that level (not what's behind
// a wall: a probe there is in or under something else).
function gridBottom(world, pos) {
  const top = Math.floor((pos[2] + 6) / VOX) * VOX, from = _from, to = _to;
  from[0] = pos[0]; from[1] = pos[1]; from[2] = to[2] = pos[2] + 8;
  const reach = to[2] - (top - DEEPEST * VOX); // (a cell past the deepest it goes: ground right at the end still counts)
  let low = top - (BELOW - 1) * VOX;
  for (let a = 0; a < 8; a++) {
    for (let r = 6; r <= 11; r += 5) {
      to[0] = pos[0] + Math.cos((a * Math.PI) / 4) * r * VOX; to[1] = pos[1] + Math.sin((a * Math.PI) / 4) * r * VOX;
      if (world.occluded(from, to, FLAG_BULLET, 0)) break; // (and further out that way)
      const hit = world.raycast(to, DOWN, reach, FLAG_BULLET);
      if (hit && to[2] - hit.t < low) low = to[2] - hit.t;
    }
  }
  return top - Math.min(DEEPEST, Math.ceil((top - low) / VOX) + 1) * VOX;
}

// A cloud's arrays (1 MB), those of one gone kept for the next (see release) rather than made again for each smoke.
const spare = [];
function arrays() {
  const a = spare.pop();
  if (!a) {
    return { state: new Uint8Array(N), cost: new Float64Array(N).fill(Infinity), dist: new Float32Array(N), high: new Uint8Array(N), climb: new Uint8Array(N),
      pivot: new Uint16Array(N), waiting: new Uint8Array(N), ground: new Int8Array(N).fill(-2), lump: new Float32Array(N), hole: new Float32Array(N),
      inSkin: new Uint8Array(N), dens: null, lattice: new Float32Array(LX * LY * LZ) };
  }
  // (Not dist, high, climb or pivot: a cell's are set as it's reached, before they're read.)
  a.state.fill(0); a.cost.fill(Infinity); a.waiting.fill(0); a.ground.fill(-2); a.lump.fill(0); a.hole.fill(0); a.inSkin.fill(0); a.dens?.fill(0);
  return a;
}
// A gone cloud's state (see release): nothing in it. (Never written: nothing fills, carves or classifies a gone cloud.)
const GONE = new Uint8Array(N);

// One smoke cloud on a 32 x 32 x 32 grid of 16-unit cells around where the grenade popped (from the ground under it:
// gridBottom).
export class SmokeField {
  constructor(world, pos, now, slot) {
    this.world = world;
    this.slot = slot;
    this.pos = pos.slice();
    this.born = now;
    this.until = now + SMOKE_TIME;
    this.min = [Math.floor(pos[0] / VOX) * VOX - (NX / 2) * VOX, Math.floor(pos[1] / VOX) * VOX - (NY / 2) * VOX, gridBottom(world, pos)];
    const a = this.arrays = arrays();
    this.state = a.state; // 0 unknown, 1 free, 2 filled, 3 solid
    this.cost = a.cost; // (doubles: the heap compares against these exactly)
    // The cheapest way found into each cell (see relax): how far out it is, how high, how much it climbed, the cell its
    // distance is measured from (in a straight line), and whether it's waiting for the smoke under it.
    this.dist = a.dist; this.high = a.high; this.climb = a.climb; this.pivot = a.pivot; this.waiting = a.waiting;
    this.ground = a.ground; // the solid cell under a free one (-1: none in the grid; -2: not looked for)
    this.lattice = a.lattice;
    for (let i = 0; i < this.lattice.length; i++) this.lattice[i] = Math.random();
    this.lump = a.lump; // (0: not worked out yet)
    this.hole = a.hole;
    this.cells = []; // filled, in fill order
    this.skin = []; // solid cells under/over the cloud (they carry its density so it sits on the floor; not walls: it would
    // show through a thin wall on the other side)
    this.inSkin = a.inSkin;
    // The cloud's bounds, a cell round it (for the skin and the texture's filtering), in cells (x0, y0, z0, x1, y1, z1)
    // and game units: what the shader marches through and sight lines are clipped to.
    this.bounds = new Int16Array([NX, NY, NZ, -1, -1, -1]);
    this.lo = new Float64Array(3); this.hi = new Float64Array(3);
    for (let i = 0; i < 3; i++) this.lo[i] = this.hi[i] = this.min[i] + (DIMS[i] / 2) * VOX;
    this.heap = new Heap();
    this.maxCost = 1;
    this.maxFall = 0; // (cells, see FALL)
    this.holes = false;
    // Start in the grenade's cell, or the nearest free one above it or around it (it rests on the floor, maybe by a wall
    // or under a bench), a level at a time, in sight of the grenade: the first resting on something, else the first with
    // ground under it in the grid, else any.
    const [x0, y0, z0] = this.cellOf([pos[0], pos[1], pos[2] + 6]);
    const eye = [pos[0], pos[1], pos[2] + 6], c = [0, 0, 0];
    let s = -1;
    for (let pass = 0; pass < 6 && s < 0; pass++) {
      for (let up = 0; up < 4 && s < 0; up++) {
        for (const [dx, dy] of AROUND) {
          const x = x0 + dx, y = y0 + dy, z = z0 + up;
          if (!this.isFree(x, y, z)) continue;
          const kind = pass % 3;
          if (kind === 0 ? this.isFree(x, y, z - 1) : kind === 1 ? this.groundOf(x, y, z) < 0 : false) continue;
          if (pass < 3 && (dx || dy || up)) {
            c[0] = this.min[0] + (x + 0.5) * VOX; c[1] = this.min[1] + (y + 0.5) * VOX; c[2] = this.min[2] + (z + 0.5) * VOX;
            if (world.occluded(eye, c, FLAG_BULLET, 0)) continue;
          }
          s = this.idx(x, y, z);
          break;
        }
      }
    }
    this.start = s;
    if (s >= 0) {
      const z = Math.floor(s / LAYER);
      this.cost[s] = 0; this.dist[s] = 0; this.high[s] = 0; this.climb[s] = 0; this.pivot[s] = s; this.heap.push(0, s); this.startZ = z;
    }
    // The ground the grenade landed on (what the dome's height counts from); none in the grid (it landed on something
    // smoke goes through, say), then as if on ground at its level, everywhere there's none (void).
    const sg = s >= 0 ? this.groundOf(s % NX, Math.floor(s / NX) % NY, this.startZ) : -1;
    this.void = sg < 0;
    this.base = this.sg = sg >= 0 ? sg : (this.startZ ?? 1) - 1;
    this.done = s < 0;
  }

  // Gone (SmokeSystem): its arrays go to the next cloud, so nothing of it is read again (and it reads as empty).
  release() {
    if (!this.arrays) return;
    if (spare.length < SLOTS) spare.push(this.arrays);
    this.arrays = this.dens = null;
    this.state = GONE;
    this.cost = this.dist = this.high = this.climb = this.pivot = this.waiting = this.ground = this.lattice = this.lump = this.hole = this.inSkin = null;
    this.cells = []; this.skin = []; this.heap = new Heap(); this.holes = false; this.done = true;
  }

  idx(x, y, z) { return x + NX * (y + NY * z); }
  cellOf(p) { return [Math.floor((p[0] - this.min[0]) / VOX), Math.floor((p[1] - this.min[1]) / VOX), Math.floor((p[2] - this.min[2]) / VOX)]; }
  isFree(x, y, z) {
    if (x < 1 || y < 1 || z < 1 || x > NX - 2 || y > NY - 2 || z > NZ - 2) return false; // keep a clear border (texture packing)
    const k = x + NX * (y + NY * z);
    if (!this.state[k]) this.state[k] = this.solid(x, y, z, z) ? 3 : 1;
    return this.state[k] !== 3;
  }
  // Is anything solid in cells z0..z1 of a column? The whole cells, a little oversized: neighbouring cells overlap, so no
  // surface (a floor, a wall) slips between them. (One box for them all is solid exactly when one of them is.)
  solid(x, y, z0, z1) {
    const lo = _lo, hi = _hi;
    lo[0] = this.min[0] + x * VOX - 0.5; lo[1] = this.min[1] + y * VOX - 0.5; lo[2] = this.min[2] + z0 * VOX - 0.5;
    hi[0] = lo[0] + VOX + 1; hi[1] = lo[1] + VOX + 1; hi[2] = this.min[2] + z1 * VOX - 0.5 + VOX + 1;
    return this.world.boxOverlap(lo, hi, FLAG_BULLET);
  }
  // The solid cell under a free one, or -1 (none in the grid). (Kept for each free cell on the way down. What isn't known
  // yet is looked at a cell, then 2, 4, 8... at a time, then halved down to the cell: a few box tests, not one a cell.)
  groundOf(x, y, z) {
    const g = this.ground, st = this.state, col = x + NX * y;
    if (g[col + LAYER * z] !== -2) return g[col + LAYER * z];
    let zz = z - 1, f = -1, run = 1;
    while (zz >= 1) {
      const j = col + LAYER * zz, s = st[j];
      if (s === 3) { f = zz; break; }
      if (s !== 0) { if (g[j] !== -2) { f = g[j]; break; } zz--; continue; }
      let lo = zz;
      while (lo > 1 && zz - lo + 1 < run && st[j - (zz - lo + 1) * LAYER] === 0) lo--;
      run *= 2;
      if (!this.solid(x, y, lo, zz)) { for (let w = lo; w <= zz; w++) st[col + LAYER * w] = 1; zz = lo - 1; continue; }
      let hi = zz; // (solid somewhere in lo..hi, free above it)
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (this.solid(x, y, mid, hi)) lo = mid;
        else { for (let w = mid; w <= hi; w++) st[col + LAYER * w] = 1; hi = mid - 1; }
      }
      st[col + LAYER * lo] = 3; f = zz = lo;
      break;
    }
    for (let w = z; w > zz; w--) g[col + LAYER * w] = f;
    return f;
  }
  // Is the straight line between the middles of cells a and b clear: every cell it passes through free? (It steps a face
  // at a time, so it can't slip between two cells that only meet at an edge.)
  lineFree(a, b) {
    let x = a % NX, y = Math.floor(a / NX) % NY, z = Math.floor(a / LAYER);
    const bx = b % NX, by = Math.floor(b / NX) % NY, bz = Math.floor(b / LAYER);
    const ax = Math.abs(bx - x), ay = Math.abs(by - y), az = Math.abs(bz - z), sx = bx > x ? 1 : -1, sy = by > y ? 1 : -1, sz = bz > z ? 1 : -1;
    const rx = 1 / ax, ry = 1 / ay, rz = 1 / az;
    let ix = 0, iy = 0, iz = 0;
    for (let n = ax + ay + az - 1; n > 0; n--) { // (the last step is onto b, which is free)
      // The next face it crosses: the nearest of the next ones in x, y and z ((i + 0.5) / a of the way along).
      const tx = ix < ax ? (ix + 0.5) * rx : 2, ty = iy < ay ? (iy + 0.5) * ry : 2, tz = iz < az ? (iz + 0.5) * rz : 2;
      if (tx <= ty && tx <= tz) { x += sx; ix++; } else if (ty <= tz) { y += sy; iy++; } else { z += sz; iz++; }
      if (!this.isFree(x, y, z)) return false;
    }
    return true;
  }
  // The lumpy noise at a cell (smoothly interpolated random values LUMP cells apart), into this.lump.
  lumpAt(x, y, z, k) {
    const gx = x / LUMP, gy = y / LUMP, gz = z / LUMP, ix = Math.floor(gx), iy = Math.floor(gy), iz = Math.floor(gz);
    let fx = gx - ix, fy = gy - iy, fz = gz - iz;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
    const L = this.lattice, i = ix + LX * (iy + LY * iz), j = i + LX * LY;
    const a = L[i] + (L[i + 1] - L[i]) * fx, b = L[i + LX] + (L[i + LX + 1] - L[i + LX]) * fx;
    const c = L[j] + (L[j + 1] - L[j]) * fx, d = L[j + LX] + (L[j + LX + 1] - L[j + LX]) * fx;
    const lower = a + (b - a) * fy, upper = c + (d - c) * fy;
    this.lump[k] = 1 + LUMPS * (2 * (lower + (upper - lower) * fz) - 1);
  }
  // When the bloom reaches a filled cell (seconds after it popped).
  reach(k) {
    return 0.05 + BLOOM * (1 - Math.sqrt(Math.max(0, 1 - Math.min(1, this.cost[k] / this.maxCost)))) + FALL * Math.max(0, this.startZ - Math.floor(k / LAYER));
  }
  // When it's fully bloomed (see update).
  get bloomed() { return BLOOM_DONE + FALL * this.maxFall; }

  // Grows the flood fill, cheapest cell first (see relax).
  fill(budget = FILL_PER_TICK) {
    const h = this.heap, state = this.state, cost = this.cost, cells = this.cells;
    while (budget-- > 0 && h.size && cells.length < MAX_CELLS) {
      const k = h.pop(), c = h.topCost;
      if (state[k] === 2 || c > cost[k]) continue;
      if (c > MAX_COST) { h.c.length = 0; h.i.length = 0; break; }
      const x = k % NX, y = Math.floor(k / NX) % NY, z = Math.floor(k / LAYER);
      // Smoke rests on the ground or on more smoke: with neither under it, it pours down (the cell below fills first,
      // then this one, waiting on it). (Where there's no ground in the grid at all, it rests at the grenade's level.)
      if (k !== this.start && state[k - LAYER] !== 2 && this.isFree(x, y, z - 1) && !(this.void && z - 1 === this.base && this.groundOf(x, y, z) < 0)) {
        this.waiting[k] = 1;
        this.relax(k, x, y, z, x, y, z - 1);
        continue;
      }
      state[k] = 2;
      cells.push(k);
      if (c > this.maxCost) this.maxCost = c;
      if (this.startZ - z > this.maxFall) this.maxFall = this.startZ - z;
      this.grow(x, y, z);
      if (this.waiting[k + LAYER] && state[k + LAYER] !== 2) h.push(cost[k + LAYER], k + LAYER);
      for (let j = 0; j < NEIGHBOURS.length; j += 3) {
        const dz = NEIGHBOURS[j + 2], nx = x + NEIGHBOURS[j], ny = y + NEIGHBOURS[j + 1], nz = z + dz;
        if (nz > this.startZ + MAX_RISE) continue;
        const n = nx + NX * (ny + NY * nz);
        if (!this.isFree(nx, ny, nz)) { if (dz && state[n] === 3 && !this.inSkin[n]) { this.inSkin[n] = 1; this.skin.push(n); } continue; }
        if (state[n] !== 2) this.relax(k, x, y, z, nx, ny, nz);
      }
    }
    if (!h.size || cells.length >= MAX_CELLS) this.done = true;
  }

  // A way into cell (bx, by, bz) from its neighbour a (at ax, ay, az), kept if it's the cheapest yet. Its distance out
  // from the grenade is in a straight line (across, not up or down) from the cell a's is measured from, while nothing's in
  // between, or else from a, so it's round in the open and goes around what's in the way. Its height counts from the
  // grenade's ground, carried on out over a drop (or from higher ground, up to RAISE above it). Smoke pouring down (from a
  // cell with nothing under it) is as far out and no higher than the cell it came from, so it fills under the dome down
  // to the ground; below the grenade's level it spreads out from there (SPILL), no higher than where it came from either.
  // Over a drop with no ground in the grid it doesn't go (but see void).
  relax(a, ax, ay, az, bx, by, bz) {
    const b = bx + NX * (by + NY * bz), sg = this.sg;
    let gb = this.groundOf(bx, by, bz);
    if (gb < 0) { if (!this.void || bz <= this.base) return; gb = this.base; }
    let high = bz - (bz > sg ? (gb < sg ? sg : Math.min(gb, sg + RAISE)) : gb) - 1, d, p = this.pivot[a], cl = this.climb[a];
    const spill = bz > sg ? 0 : Math.min(SPILL_MAX, SPILL * (sg + 1 - bz));
    if (this.lump[b] === 0) this.lumpAt(bx, by, bz, b);
    const lump = this.lump[b], best = this.cost[b];
    // (Poured smoke, and smoke spreading from it below the grenade's level, is no higher than where it came from.)
    if (bz < az || bz <= sg) high = Math.min(high, Math.max(0, this.high[a] + bz - az));
    if (bz !== az) d = this.dist[a];
    else {
      let ga = this.groundOf(ax, ay, az);
      if (ga < 0) ga = this.base;
      const on = bz > sg ? Math.max(gb, sg) : gb, from = az > sg ? Math.max(ga, sg) : ga; // (the ground it's over, for climbing)
      if (on > from) cl = Math.min(255, cl + on - from);
      if (p !== a) {
        // Straight from a's pivot if it's in sight (no way from a is shorter: if that's no cheaper, the line isn't walked).
        const dx = bx - (p % NX), dy = by - (Math.floor(p / NX) % NY);
        d = this.dist[p] + Math.sqrt(dx * dx + dy * dy);
        const out = Math.max(0, d + CLIMB * cl - spill), up = TALL * high;
        if (lump * Math.sqrt(out * out + up * up) >= best) return;
        if (!this.lineFree(p, b)) { p = a; d = this.dist[a] + 1; }
      } else d = this.dist[a] + 1;
    }
    const out = Math.max(0, d + CLIMB * cl - spill), up = TALL * high, c = lump * Math.sqrt(out * out + up * up);
    if (c < best) {
      this.cost[b] = c; this.dist[b] = d; this.high[b] = high; this.climb[b] = cl; this.pivot[b] = p;
      this.heap.push(c, b);
    }
  }

  // A cell filled: the bounds take it in.
  grow(x, y, z) {
    const b = this.bounds;
    if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (z < b[2]) b[2] = z;
    if (x > b[3]) b[3] = x; if (y > b[4]) b[4] = y; if (z > b[5]) b[5] = z;
    for (let i = 0; i < 3; i++) {
      this.lo[i] = this.min[i] + Math.max(1, b[i] - 1) * VOX;
      this.hi[i] = this.min[i] + Math.min(DIMS[i] - 1, b[i + 3] + 2) * VOX;
    }
  }

  // How much smoke a cell holds now (0..1): blooming out from the grenade, thinning from the edges at the end,
  // minus any hole.
  cellDensity(k, now) {
    if (this.state[k] !== 2) return 0;
    const c = this.cost[k], reach = this.reach(k);
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
    for (let j = 0; j < this.cells.length; j++) { // (indexed: every tick of a smoke with a hole in it)
      const k = this.cells[j], h = this.hole[k];
      if (h <= 0) continue;
      this.hole[k] = Math.max(0, h - dt);
      any = true;
    }
    this.holes = any;
  }

  // The part of a segment inside the cloud's bounds: [t0, t1] along the unit direction (into this.seg), or null.
  clip(o, d, maxT) {
    let t0 = 0, t1 = maxT;
    for (let i = 0; i < 3; i++) {
      const lo = this.lo[i], hi = this.hi[i];
      if (Math.abs(d[i]) < 1e-9) { if (o[i] < lo || o[i] > hi) return null; continue; }
      let a = (lo - o[i]) / d[i], b = (hi - o[i]) / d[i];
      if (a > b) { const x = a; a = b; b = x; }
      t0 = Math.max(t0, a); t1 = Math.min(t1, b);
      if (t0 > t1) return null;
    }
    const seg = (this.seg ||= new Float64Array(2));
    seg[0] = t0; seg[1] = t1;
    return seg;
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
      const x = k % NX, y = Math.floor(k / NX) % NY, z = Math.floor(k / LAYER);
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
    const d = _dir;
    d[0] = dx / l; d[1] = dy / l; d[2] = dz / l;
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
  // those land a whole number of cells away, the same from every cell, so it's all done by cell index. Its height for
  // the sky's light is above the ground under it (smoke that poured off a ledge is lit like smoke on its own ground).
  // (This runs for thousands of cells a frame while a cloud blooms or fades, and is written out in one loop: numbers
  // passed to or returned from a call that isn't inlined are boxed, which made hundreds of MB of garbage a smoke.)
  write(data, now, lit) {
    if (!this.arrays) return;
    const base = this.slot * N, rgb = [0, 0, 0];
    const put = (k, a, light) => {
      const o = (base + k) * 4;
      for (let i = 0; i < 3; i++) data[o + i] = Math.min(255, Math.round((light[i] / LIGHT_SCALE) * 255));
      data[o + 3] = a;
    };
    if (!this.airLit) {
      // The open air's light only changes with height: worked out once a layer, not for each of the 32768 cells.
      this.airLit = true;
      for (let z = 0; z < NZ; z++) {
        this.lightOf(z, 0, 0, lit, rgb);
        for (let k = z * LAYER; k < (z + 1) * LAYER; k++) put(k, 0, rgb);
      }
    }
    // (Indexed loops here: thousands of cells a frame, and for...of made an object for each.)
    for (let j = 0; j < this.skin.length; j++) data[(base + this.skin[j]) * 4 + 3] = 0;
    const dens = this.dens ||= (this.arrays.dens ||= new Float32Array(N)); // (cells that aren't smoke stay 0)
    const life = now - this.born, left = this.until - now, mc = this.maxCost;
    const cells = this.cells, cost = this.cost, sz = this.startZ;
    for (let j = 0; j < cells.length; j++) {
      const k = cells[j], c = cost[k];
      const reach = 0.05 + BLOOM * (1 - Math.sqrt(Math.max(0, 1 - Math.min(1, c / mc)))) + FALL * Math.max(0, sz - Math.floor(k / LAYER)); // (reach)
      const grow = Math.min(1, Math.max(0, (life - reach) / GROW)), fade = Math.min(1, Math.max(0, left / FADE + (1 - c / mc) * 0.7));
      dens[k] = grow * fade * (1 - Math.min(1, this.hole[k] / REFILL)); // (cellDensity)
    }
    const sd = lit.sunDir, step = (d, i) => Math.floor(0.5 + (sd[i] * d) / VOX);
    const s1x = step(20, 0), s1y = step(20, 1), s1z = step(20, 2), s2x = step(52, 0), s2y = step(52, 1), s2z = step(52, 2);
    const s3x = step(96, 0), s3y = step(96, 1), s3z = step(96, 2), layer = LAYER;
    const g = lit.ground, sky = lit.sky, sun = lit.sun, startZ = this.startZ ?? 3, ground = this.ground;
    for (let j = 0; j < cells.length; j++) {
      const k = cells[j], x = k % NX, y = Math.floor(k / NX) % NY, z = Math.floor(k / layer);
      let toSun = 0, above = 0, X = x + s1x, Y = y + s1y, Z = z + s1z;
      if (X >= 0 && Y >= 0 && Z >= 0 && X < NX && Y < NY && Z < NZ) toSun += dens[X + NX * (Y + NY * Z)];
      X = x + s2x; Y = y + s2y; Z = z + s2z;
      if (X >= 0 && Y >= 0 && Z >= 0 && X < NX && Y < NY && Z < NZ) toSun += dens[X + NX * (Y + NY * Z)];
      X = x + s3x; Y = y + s3y; Z = z + s3z;
      if (X >= 0 && Y >= 0 && Z >= 0 && X < NX && Y < NY && Z < NZ) toSun += dens[X + NX * (Y + NY * Z)];
      if (z + 3 < NZ) above += dens[k + 3 * layer];
      if (z + 6 < NZ) above += dens[k + 6 * layer];
      const gz = ground[k], up = Math.min(1, Math.max(0, (gz >= 0 ? z - gz - 1 : z - startZ) / 8));
      const occ = 1 - 0.32 * Math.min(1, above * 0.6), lightSun = Math.exp(-toSun * 1.8);
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

// Every smoke on the map, packed into one 3D texture (one 32 x 32 x 32 slot each) for the composite shader. Only the
// slots that changed are sent to the GPU (see upload), not the whole texture.
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
    // The same data as a texture never drawn with (so the GPU has no copy of it): what a slot's upload reads from.
    this.stage = new THREE.Data3DTexture(this.data, NX, NY, NZ * SLOTS);
    this.stage.format = THREE.RGBAFormat;
    this.stage.unpackAlignment = 1;
    this.region = new THREE.Box3();
    this.at = new THREE.Vector3();
    this.noise = noiseTexture();
    const vecs = () => Array.from({ length: SLOTS }, () => new THREE.Vector3());
    this.uniforms = {
      tSmoke: { value: this.tex }, tSmokeNoise: { value: this.noise }, smokeCount: { value: 0 },
      smokeMin: { value: vecs() }, smokeLo: { value: vecs() }, smokeHi: { value: vecs() }, smokeSlot: { value: new Array(SLOTS).fill(0) },
      smokeLife: { value: new Array(SLOTS).fill(0) }, smokeTime: { value: 0 },
    };
    this.changed = 0; // (slots changed since the last upload, a bit each)
    this.lighting = { sunDir: [0, 0, 1], sun: [1, 1, 1], sky: [0.5, 0.5, 0.55], ground: [0.4, 0.35, 0.3] };
  }

  get active() { return this.fields.length > 0; }
  // The map's light for the clouds (set once the world is loaded).
  setLighting(l) { this.lighting = l; }

  add(pos) {
    const used = new Set(this.fields.map((f) => f.slot));
    let slot = [...Array(SLOTS).keys()].find((s) => !used.has(s));
    if (slot == null) { const old = this.fields.shift(); slot = old.slot; old.release(); }
    this.data.fill(0, slot * N * 4, (slot + 1) * N * 4);
    // (Filled from the next tick: SmokeSystem.tick, straight after on the tick it popped.)
    const f = new SmokeField(this.game.collision, pos, this.game.now, slot);
    this.fields.push(f);
    this.changed |= 1 << slot;
    return f;
  }

  tick(dt) {
    const now = this.game.now;
    let filling = 0;
    for (const f of this.fields) if (!f.done) filling++;
    const budget = Math.min(FILL_PER_TICK, Math.max(FILL_MIN, Math.floor(FILL_SHARED / Math.max(1, filling))));
    for (let i = this.fields.length - 1; i >= 0; i--) {
      const f = this.fields[i];
      if (now > f.until) { this.data.fill(0, f.slot * N * 4, (f.slot + 1) * N * 4); this.fields.splice(i, 1); f.release(); this.changed |= 1 << f.slot; continue; }
      if (!f.done) f.fill(budget);
      f.heal(dt);
    }
  }

  // Refreshes the texture's data while anything is changing (blooming, fading, holes) and the shader's per-smoke uniforms.
  update() {
    const now = this.game.now, u = this.uniforms;
    for (const f of this.fields) {
      const age = now - f.born;
      if (age < f.bloomed + 0.1 || f.until - now < FADE + 1 || f.holes || !f.done || f.wroteHole) {
        f.write(this.data, now, this.lighting);
        f.wroteHole = f.holes;
        this.changed |= 1 << f.slot;
      }
    }
    u.smokeCount.value = this.fields.length;
    u.smokeTime.value = now;
    this.fields.forEach((f, i) => {
      u.smokeMin.value[i].set(f.min[0], f.min[1], f.min[2]);
      u.smokeLo.value[i].set(f.lo[0], f.lo[1], f.lo[2]);
      u.smokeHi.value[i].set(f.hi[0], f.hi[1], f.hi[2]);
      u.smokeSlot.value[i] = f.slot;
      u.smokeLife.value[i] = Math.min(1, Math.max(0, (f.until - now) / FADE));
    });
  }

  // Sends the changed slots to the GPU, before the smokes are drawn (Post.render). The first time, all of it.
  upload(renderer) {
    if (!this.changed) return;
    if (!this.sent || !renderer?.copyTextureToTexture) { this.tex.needsUpdate = true; this.sent = !!renderer; this.changed = 0; return; }
    for (let s = 0; s < SLOTS; s++) {
      if (!(this.changed & (1 << s))) continue;
      this.region.min.set(0, 0, s * NZ); this.region.max.set(NX, NY, (s + 1) * NZ);
      this.at.set(0, 0, s * NZ);
      renderer.copyTextureToTexture(this.stage, this.tex, this.region, this.at);
    }
    this.changed = 0;
  }

  carve(o, d, maxT) { for (const f of this.fields) f.carve(o, d, maxT); }
  blast(p) { for (const f of this.fields) f.blast(p); }
  blocks(a, b) { const now = this.game.now; let sum = 0; for (const f of this.fields) { sum += f.thickness(a, b, now); if (sum > BLOCK) return true; } return false; }
  // Units of full smoke between two points.
  thickness(a, b) { const now = this.game.now; return this.fields.reduce((sum, f) => sum + f.thickness(a, b, now), 0); }
  densityAt(p) { const now = this.game.now; return this.fields.reduce((m, f) => Math.max(m, f.densityAt(p, now)), 0); }
  clear() { for (const f of this.fields) f.release(); this.fields = []; this.data.fill(0); this.changed = (1 << SLOTS) - 1; }
  dispose() { this.clear(); spare.length = 0; this.tex.dispose(); this.stage.dispose(); this.noise.dispose(); }
}
