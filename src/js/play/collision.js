// The map's collision mesh (CS2's world physics, in game units: inches, Z up) in a bounding volume hierarchy, with the
// traces Play mode needs: rays for bullets and sight lines, and swept boxes for player movement (Source's player hull
// is an axis-aligned box, and its movement code slides that box along whatever it hits).
// Pure JS with no DOM, so it can run in tests.

const LEAF = 6; // triangles per leaf
export const FLAG_PLAYER = 1, FLAG_BULLET = 2, FLAG_GRENADE = 4;

export class CollisionWorld {
  // buffer: collision.bin (Float32 positions x9 per triangle, then a flags byte and a surface byte per triangle).
  constructor(buffer, { tris, surfaces = [] }) {
    this.count = tris;
    this.pos = new Float32Array(buffer, 0, tris * 9);
    this.flags = new Uint8Array(buffer, tris * 36, tris);
    this.surface = new Uint8Array(buffer, tris * 37, tris);
    this.surfaces = surfaces;
    this.ladders = new Set(surfaces.map((s, i) => (/ladder/i.test(s) ? i : -1)).filter((i) => i >= 0));
    this.build();
  }

  // Median-split BVH. Nodes: bounds (6 floats) + [left child | first triangle, right child | -count].
  build() {
    const n = this.count, P = this.pos;
    const order = new Uint32Array(n);
    const cent = new Float32Array(n * 3), tmin = new Float32Array(n * 3), tmax = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      order[i] = i;
      for (let c = 0; c < 3; c++) {
        const a = P[i * 9 + c], b = P[i * 9 + 3 + c], d = P[i * 9 + 6 + c];
        tmin[i * 3 + c] = Math.min(a, b, d); tmax[i * 3 + c] = Math.max(a, b, d);
        cent[i * 3 + c] = (a + b + d) / 3;
      }
    }
    const maxNodes = Math.ceil(n / 3) * 2 + 1; // leaves hold 3..LEAF triangles after median splits
    const box = new Float32Array(maxNodes * 6), link = new Int32Array(maxNodes * 2);
    let used = 0;
    const stack = [[0, n, used++]];
    while (stack.length) {
      const [lo, hi, node] = stack.pop();
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      let cx0 = Infinity, cy0 = Infinity, cz0 = Infinity, cx1 = -Infinity, cy1 = -Infinity, cz1 = -Infinity;
      for (let k = lo; k < hi; k++) {
        const t = order[k] * 3;
        if (tmin[t] < x0) x0 = tmin[t]; if (tmin[t + 1] < y0) y0 = tmin[t + 1]; if (tmin[t + 2] < z0) z0 = tmin[t + 2];
        if (tmax[t] > x1) x1 = tmax[t]; if (tmax[t + 1] > y1) y1 = tmax[t + 1]; if (tmax[t + 2] > z1) z1 = tmax[t + 2];
        if (cent[t] < cx0) cx0 = cent[t]; if (cent[t] > cx1) cx1 = cent[t];
        if (cent[t + 1] < cy0) cy0 = cent[t + 1]; if (cent[t + 1] > cy1) cy1 = cent[t + 1];
        if (cent[t + 2] < cz0) cz0 = cent[t + 2]; if (cent[t + 2] > cz1) cz1 = cent[t + 2];
      }
      box.set([x0, y0, z0, x1, y1, z1], node * 6);
      if (hi - lo <= LEAF) { link[node * 2] = lo; link[node * 2 + 1] = -(hi - lo); continue; }
      const ext = [cx1 - cx0, cy1 - cy0, cz1 - cz0];
      const axis = ext[0] >= ext[1] && ext[0] >= ext[2] ? 0 : ext[1] >= ext[2] ? 1 : 2;
      const mid = (lo + hi) >> 1;
      nthElement(order, lo, hi, mid, (i) => cent[i * 3 + axis]);
      const l = used++, r = used++;
      link[node * 2] = l; link[node * 2 + 1] = r;
      stack.push([lo, mid, l], [mid, hi, r]);
    }
    this.order = order; this.box = box.subarray(0, used * 6); this.link = link.subarray(0, used * 2);
    this.stack = new Int32Array(256);
  }

  // Is this triangle part of a ladder (CS2 maps give ladders the "ladder" surface)?
  isLadder(tri) { return tri >= 0 && this.ladders.has(this.surface[tri]); }

  // Ray from o along unit direction d, up to maxDist. Returns { t, normal, tri, surface } or null.
  // mask: which flags count as solid (FLAG_BULLET for shots).
  raycast(o, d, maxDist, mask = FLAG_BULLET, ignore = null) {
    const P = this.pos, B = this.box, L = this.link, S = this.stack;
    const ix = 1 / d[0], iy = 1 / d[1], iz = 1 / d[2];
    let best = maxDist, hit = -1, sp = 0;
    S[sp++] = 0;
    while (sp) {
      const node = S[--sp], b = node * 6;
      // slab test
      let t0 = (B[b] - o[0]) * ix, t1 = (B[b + 3] - o[0]) * ix;
      let tn = Math.min(t0, t1), tf = Math.max(t0, t1);
      t0 = (B[b + 1] - o[1]) * iy; t1 = (B[b + 4] - o[1]) * iy;
      tn = Math.max(tn, Math.min(t0, t1)); tf = Math.min(tf, Math.max(t0, t1));
      t0 = (B[b + 2] - o[2]) * iz; t1 = (B[b + 5] - o[2]) * iz;
      tn = Math.max(tn, Math.min(t0, t1)); tf = Math.min(tf, Math.max(t0, t1));
      if (tf < Math.max(tn, 0) || tn > best) continue;
      const a = L[node * 2], c = L[node * 2 + 1];
      if (c >= 0) { S[sp++] = a; S[sp++] = c; continue; }
      for (let k = a; k < a - c; k++) {
        const tri = this.order[k];
        if (!(this.flags[tri] & mask) || tri === ignore) continue;
        const t = rayTri(P, tri * 9, o, d);
        if (t >= 0 && t < best) { best = t; hit = tri; }
      }
    }
    if (hit < 0) return null;
    return { t: best, normal: triNormal(P, hit * 9), tri: hit, surface: this.surfaces[this.surface[hit]] || 'default' };
  }

  // Sweeps an axis-aligned box (mins/maxs relative to start) from start to end. Returns Source-style trace results:
  // { fraction, endpos, normal, startsolid, tri }. only: a Set of surface ids to consider (e.g. ladders).
  traceBox(start, end, mins, maxs, mask = FLAG_PLAYER, only = null) {
    const ext = [(maxs[0] - mins[0]) / 2, (maxs[1] - mins[1]) / 2, (maxs[2] - mins[2]) / 2];
    const c0 = [start[0] + (mins[0] + maxs[0]) / 2, start[1] + (mins[1] + maxs[1]) / 2, start[2] + (mins[2] + maxs[2]) / 2];
    const v = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
    const lo = [Math.min(c0[0], c0[0] + v[0]) - ext[0] - 1, Math.min(c0[1], c0[1] + v[1]) - ext[1] - 1, Math.min(c0[2], c0[2] + v[2]) - ext[2] - 1];
    const hi = [Math.max(c0[0], c0[0] + v[0]) + ext[0] + 1, Math.max(c0[1], c0[1] + v[1]) + ext[1] + 1, Math.max(c0[2], c0[2] + v[2]) + ext[2] + 1];
    const P = this.pos, B = this.box, L = this.link, S = this.stack;
    let best = 1, normal = null, hitTri = -1, startsolid = false, sp = 0;
    S[sp++] = 0;
    const res = { t: 0, n: [0, 0, 0], solid: false };
    while (sp) {
      const node = S[--sp], b = node * 6;
      if (B[b] > hi[0] || B[b + 3] < lo[0] || B[b + 1] > hi[1] || B[b + 4] < lo[1] || B[b + 2] > hi[2] || B[b + 5] < lo[2]) continue;
      const a = L[node * 2], c = L[node * 2 + 1];
      if (c >= 0) { S[sp++] = a; S[sp++] = c; continue; }
      for (let k = a; k < a - c; k++) {
        const tri = this.order[k];
        if (!(this.flags[tri] & mask) || (only && !only.has(this.surface[tri]))) continue;
        if (!sweepBoxTri(P, tri * 9, c0, ext, v, best, res)) continue;
        if (res.solid) { startsolid = true; continue; }
        if (res.t < best) { best = res.t; normal = res.n.slice(); hitTri = tri; }
      }
    }
    // Stop just short of the surface (Source's DIST_EPSILON) so the next move doesn't start inside it.
    let fraction = best;
    if (normal) {
      const len = Math.hypot(v[0], v[1], v[2]);
      fraction = len > 0 ? Math.max(0, best - 0.03125 / len) : 0;
    }
    return {
      fraction, normal, startsolid, tri: hitTri,
      endpos: [start[0] + v[0] * fraction, start[1] + v[1] * fraction, start[2] + v[2] * fraction],
    };
  }
}

// Does any solid triangle touch the box min..max? (Smoke fills only free space.)
CollisionWorld.prototype.boxOverlap = function boxOverlap(min, max, mask = FLAG_BULLET) {
  const B = this.box, L = this.link, S = this.stack, P = this.pos;
  const c = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2], e = [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2];
  let sp = 0;
  S[sp++] = 0;
  while (sp) {
    const node = S[--sp], b = node * 6;
    if (B[b] > max[0] || B[b + 3] < min[0] || B[b + 1] > max[1] || B[b + 4] < min[1] || B[b + 2] > max[2] || B[b + 5] < min[2]) continue;
    const a = L[node * 2], n = L[node * 2 + 1];
    if (n >= 0) { S[sp++] = a; S[sp++] = n; continue; }
    for (let k = a; k < a - n; k++) {
      const tri = this.order[k];
      if ((this.flags[tri] & mask) && triBoxOverlap(P, tri * 9, c, e)) return true;
    }
  }
  return false;
};

// Static triangle / AABB overlap (separating axes: box faces, triangle normal, edge cross products).
function triBoxOverlap(P, i, c, e) {
  const v = [P[i] - c[0], P[i + 1] - c[1], P[i + 2] - c[2], P[i + 3] - c[0], P[i + 4] - c[1], P[i + 5] - c[2], P[i + 6] - c[0], P[i + 7] - c[1], P[i + 8] - c[2]];
  for (let k = 0; k < 3; k++) {
    if (Math.min(v[k], v[3 + k], v[6 + k]) > e[k] || Math.max(v[k], v[3 + k], v[6 + k]) < -e[k]) return false;
  }
  const f = [v[3] - v[0], v[4] - v[1], v[5] - v[2], v[6] - v[3], v[7] - v[4], v[8] - v[5], v[0] - v[6], v[1] - v[7], v[2] - v[8]];
  const test = (ax, ay, az) => {
    const p0 = v[0] * ax + v[1] * ay + v[2] * az, p1 = v[3] * ax + v[4] * ay + v[5] * az, p2 = v[6] * ax + v[7] * ay + v[8] * az;
    const r = e[0] * Math.abs(ax) + e[1] * Math.abs(ay) + e[2] * Math.abs(az);
    return !(Math.min(p0, p1, p2) > r || Math.max(p0, p1, p2) < -r);
  };
  const nx = f[1] * f[5] - f[2] * f[4], ny = f[2] * f[3] - f[0] * f[5], nz = f[0] * f[4] - f[1] * f[3];
  if (!test(nx, ny, nz)) return false;
  for (let j = 0; j < 3; j++) {
    const fx = f[j * 3], fy = f[j * 3 + 1], fz = f[j * 3 + 2];
    if (!test(0, -fz, fy) || !test(fz, 0, -fx) || !test(-fy, fx, 0)) return false;
  }
  return true;
}

// Partial sort so order[mid] is the median by key (quickselect).
function nthElement(a, lo, hi, n, key) {
  hi--;
  while (hi > lo) {
    const pivot = key(a[(lo + hi) >> 1]);
    let i = lo, j = hi;
    while (i <= j) {
      while (key(a[i]) < pivot) i++;
      while (key(a[j]) > pivot) j--;
      if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
    }
    if (n <= j) hi = j; else if (n >= i) lo = i; else return;
  }
}

function rayTri(P, i, o, d) {
  const e1x = P[i + 3] - P[i], e1y = P[i + 4] - P[i + 1], e1z = P[i + 5] - P[i + 2];
  const e2x = P[i + 6] - P[i], e2y = P[i + 7] - P[i + 1], e2z = P[i + 8] - P[i + 2];
  const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-9) return -1;
  const inv = 1 / det;
  const tx = o[0] - P[i], ty = o[1] - P[i + 1], tz = o[2] - P[i + 2];
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
  if (v < 0 || u + v > 1) return -1;
  return (e2x * qx + e2y * qy + e2z * qz) * inv;
}

function triNormal(P, i) {
  const e1x = P[i + 3] - P[i], e1y = P[i + 4] - P[i + 1], e1z = P[i + 5] - P[i + 2];
  const e2x = P[i + 6] - P[i], e2y = P[i + 7] - P[i + 1], e2z = P[i + 8] - P[i + 2];
  const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

// Swept AABB (centre c, half extents e, moving by v over t in [0,1]) against one triangle, by the separating axis
// theorem with time of impact: the box face normals, the triangle normal and the 9 edge cross products.
// Writes { t, n, solid } into out and returns true on a hit before maxT.
const AX = new Float32Array(13 * 3);
function sweepBoxTri(P, i, c, e, v, maxT, out) {
  const ax = P[i] - c[0], ay = P[i + 1] - c[1], az = P[i + 2] - c[2];
  const bx = P[i + 3] - c[0], by = P[i + 4] - c[1], bz = P[i + 5] - c[2];
  const cx = P[i + 6] - c[0], cy = P[i + 7] - c[1], cz = P[i + 8] - c[2];
  const f0 = [bx - ax, by - ay, bz - az], f1 = [cx - bx, cy - by, cz - bz], f2 = [ax - cx, ay - cy, az - cz];
  let k = 0;
  const push = (x, y, z) => { AX[k++] = x; AX[k++] = y; AX[k++] = z; };
  push(1, 0, 0); push(0, 1, 0); push(0, 0, 1);
  const nx = f0[1] * f1[2] - f0[2] * f1[1], ny = f0[2] * f1[0] - f0[0] * f1[2], nz = f0[0] * f1[1] - f0[1] * f1[0];
  push(nx, ny, nz);
  for (const f of [f0, f1, f2]) { push(0, -f[2], f[1]); push(f[2], 0, -f[0]); push(-f[1], f[0], 0); }
  let tEnter = -Infinity, tExit = Infinity, nEnter = null, minPen = Infinity, nPen = null;
  for (let j = 0; j < 13; j++) {
    const lx = AX[j * 3], ly = AX[j * 3 + 1], lz = AX[j * 3 + 2];
    const len = Math.hypot(lx, ly, lz);
    if (len < 1e-6) continue;
    const pa = (ax * lx + ay * ly + az * lz) / len, pb = (bx * lx + by * ly + bz * lz) / len, pc = (cx * lx + cy * ly + cz * lz) / len;
    const tmin = Math.min(pa, pb, pc), tmax = Math.max(pa, pb, pc);
    const r = (e[0] * Math.abs(lx) + e[1] * Math.abs(ly) + e[2] * Math.abs(lz)) / len;
    const vel = (v[0] * lx + v[1] * ly + v[2] * lz) / len;
    // Box interval on this axis at time t: [vel*t - r, vel*t + r]; triangle: [tmin, tmax].
    if (Math.abs(vel) < 1e-9) {
      if (r < tmin || -r > tmax) return false; // separated for the whole move
      const pen = Math.min(r - tmin, tmax + r);
      if (pen < minPen) { minPen = pen; nPen = [lx / len, ly / len, lz / len, r - tmin < tmax + r ? -1 : 1]; }
      continue;
    }
    let t0 = (tmin - r) / vel, t1 = (tmax + r) / vel;
    let sign = -1; // the normal opposes the motion
    if (t0 > t1) { const t = t0; t0 = t1; t1 = t; }
    if (t0 > tEnter) { tEnter = t0; nEnter = [lx / len, ly / len, lz / len, vel > 0 ? sign : -sign]; }
    if (t1 < tExit) tExit = t1;
    if (tEnter > tExit || tExit < 0 || tEnter > maxT) return false;
    const pen = Math.min(r - tmin, tmax + r);
    if (pen < minPen) { minPen = pen; nPen = [lx / len, ly / len, lz / len, r - tmin < tmax + r ? -1 : 1]; }
  }
  if (tEnter < 0) {
    // Already touching/overlapping at the start: only block motion that goes further into the triangle.
    const n = triNormal(P, i);
    const side = -(ax * n[0] + ay * n[1] + az * n[2]); // >0: box centre is on the normal's side
    const nn = side >= 0 ? n : [-n[0], -n[1], -n[2]];
    if (v[0] * nn[0] + v[1] * nn[1] + v[2] * nn[2] >= 0) return false;
    out.t = 0; out.n[0] = nn[0]; out.n[1] = nn[1]; out.n[2] = nn[2]; out.solid = false;
    return true;
  }
  if (!nEnter) return false;
  out.t = tEnter; out.solid = false;
  out.n[0] = nEnter[0] * nEnter[3]; out.n[1] = nEnter[1] * nEnter[3]; out.n[2] = nEnter[2] * nEnter[3];
  return true;
}
