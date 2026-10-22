// The map's navigation mesh (CS2's .nav for the player hull): convex areas with their neighbours. Used to put bots on
// walkable ground and to find paths between places. Game units.
const CELL = 256;
const FLAG_CROUCH = 0x10000, FLAG_JUMP = 0x2, FLAG_AVOID = 0x80;

export class NavMesh {
  constructor(data) {
    this.areas = data.areas.map((a) => {
      const n = a.c.length;
      let cx = 0, cy = 0, cz = 0, size = 0;
      for (const p of a.c) { cx += p[0] / n; cy += p[1] / n; cz += p[2] / n; }
      for (let i = 1; i < n - 1; i++) size += triArea(a.c[0], a.c[i], a.c[i + 1]);
      const min = [Math.min(...a.c.map((p) => p[0])), Math.min(...a.c.map((p) => p[1])), Math.min(...a.c.map((p) => p[2]))];
      const max = [Math.max(...a.c.map((p) => p[0])), Math.max(...a.c.map((p) => p[1])), Math.max(...a.c.map((p) => p[2]))];
      return { id: a.id, flags: a.flags, corners: a.c, edges: a.e, hiding: a.h, center: [cx, cy, cz], size, min, max, links: [...new Set(a.e.flat())] };
    });
    this.byId = new Map(this.areas.map((a) => [a.id, a]));
    this.grid = new Map();
    for (const a of this.areas) {
      for (let gx = Math.floor(a.min[0] / CELL); gx <= Math.floor(a.max[0] / CELL); gx++) {
        for (let gy = Math.floor(a.min[1] / CELL); gy <= Math.floor(a.max[1] / CELL); gy++) {
          const k = gx + ',' + gy;
          if (!this.grid.has(k)) this.grid.set(k, []);
          this.grid.get(k).push(a);
        }
      }
    }
    this.total = this.areas.reduce((s, a) => s + a.size, 0);
  }

  // The area under a position (the one whose surface is closest below/around it), or null.
  findArea(p, maxDz = 80) {
    const list = this.grid.get(Math.floor(p[0] / CELL) + ',' + Math.floor(p[1] / CELL)) || [];
    let best = null, bd = Infinity;
    for (const a of list) {
      if (p[0] < a.min[0] - 1 || p[0] > a.max[0] + 1 || p[1] < a.min[1] - 1 || p[1] > a.max[1] + 1) continue;
      const z = heightIn(a.corners, p[0], p[1]);
      if (z === null) continue;
      const dz = p[2] - z;
      if (dz < -24 || dz > maxDz) continue;
      if (Math.abs(dz) < bd) { bd = Math.abs(dz); best = a; }
    }
    return best;
  }

  // Ground height under (x, y) near z, from the nav mesh (null off the mesh).
  heightAt(x, y, z) {
    const a = this.findArea([x, y, z], 80);
    return a ? heightIn(a.corners, x, y) : null;
  }

  // A random spot inside a box (e.g. a bomb site) on walkable ground.
  randomPointIn(min, max, accept = () => true, tries = 80) {
    const list = this.areas.filter((a) => a.max[0] >= min[0] && a.min[0] <= max[0] && a.max[1] >= min[1] && a.min[1] <= max[1]
      && a.max[2] >= min[2] - 40 && a.min[2] <= max[2] + 40 && !(a.flags & (FLAG_CROUCH | FLAG_JUMP)) && a.size > 400);
    if (!list.length) return null;
    const total = list.reduce((s, a) => s + a.size, 0);
    for (let t = 0; t < tries; t++) {
      let r = Math.random() * total, a = list[0];
      for (const x of list) { r -= x.size; if (r <= 0) { a = x; break; } }
      const p = pointIn(a.corners);
      if (p[0] < min[0] - 40 || p[0] > max[0] + 40 || p[1] < min[1] - 40 || p[1] > max[1] + 40) continue;
      if (accept(a, p)) return { area: a, point: p };
    }
    return null;
  }

  // The nearest area to a position (falls back to the closest centre).
  nearestArea(p) {
    const a = this.findArea(p, 200);
    if (a) return a;
    let best = null, bd = Infinity;
    for (const x of this.areas) {
      const d = (x.center[0] - p[0]) ** 2 + (x.center[1] - p[1]) ** 2 + ((x.center[2] - p[2]) * 2) ** 2;
      if (d < bd) { bd = d; best = x; }
    }
    return best;
  }

  // A random standing spot, weighted by area size. `accept(area, point)` can reject candidates.
  randomPoint(accept = () => true, tries = 60) {
    for (let t = 0; t < tries; t++) {
      let r = Math.random() * this.total, a = this.areas[0];
      for (const x of this.areas) { r -= x.size; if (r <= 0) { a = x; break; } }
      if (a.flags & (FLAG_CROUCH | FLAG_JUMP | FLAG_AVOID) || a.size < 900) continue;
      const p = pointIn(a.corners);
      if (accept(a, p)) return { area: a, point: p };
    }
    return null;
  }

  // A* over areas; returns waypoints (crossing points between areas, then the goal) or null.
  path(from, to) {
    const start = this.nearestArea(from), goal = this.nearestArea(to);
    if (!start || !goal) return null;
    const open = new Map([[start.id, { a: start, g: 0, f: dist(start.center, goal.center), prev: null }]]);
    const closed = new Map();
    while (open.size) {
      let cur = null;
      for (const n of open.values()) if (!cur || n.f < cur.f) cur = n;
      open.delete(cur.a.id);
      closed.set(cur.a.id, cur);
      if (cur.a === goal) {
        const areas = [];
        for (let n = cur; n; n = n.prev) areas.unshift(n.a);
        const pts = [];
        for (let i = 1; i < areas.length; i++) pts.push(portal(areas[i - 1], areas[i]));
        pts.push(to.slice());
        return { areas, points: pts };
      }
      for (const id of cur.a.links) {
        if (closed.has(id)) continue;
        const b = this.byId.get(id);
        if (!b) continue;
        const g = cur.g + dist(cur.a.center, b.center) * (b.flags & FLAG_CROUCH ? 2 : 1);
        const o = open.get(id);
        if (!o || g < o.g) open.set(id, { a: b, g, f: g + dist(b.center, goal.center), prev: cur });
      }
    }
    return null;
  }
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const triArea = (a, b, c) => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;

// Height of a convex area's surface at (x, y), or null when outside it (triangle fan).
function heightIn(c, x, y) {
  for (let i = 1; i < c.length - 1; i++) {
    const h = triHeight(c[0], c[i], c[i + 1], x, y);
    if (h !== null) return h;
  }
  return null;
}
function triHeight(a, b, c, x, y) {
  const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (Math.abs(d) < 1e-9) return null;
  const u = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d;
  const v = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d;
  const w = 1 - u - v;
  if (u < -1e-4 || v < -1e-4 || w < -1e-4) return null;
  return u * a[2] + v * b[2] + w * c[2];
}

// A random point inside a convex area (area-weighted triangle of its fan).
function pointIn(c) {
  const tris = [];
  let total = 0;
  for (let i = 1; i < c.length - 1; i++) { const s = triArea(c[0], c[i], c[i + 1]); tris.push([c[0], c[i], c[i + 1], s]); total += s; }
  let r = Math.random() * total, t = tris[0];
  for (const x of tris) { r -= x[3]; if (r <= 0) { t = x; break; } }
  let u = Math.random(), v = Math.random();
  if (u + v > 1) { u = 1 - u; v = 1 - v; }
  const [a, b, d] = t;
  return [0, 1, 2].map((k) => a[k] + (b[k] - a[k]) * u + (d[k] - a[k]) * v);
}

// Where to cross from area a into its neighbour b: the middle of their shared edge (clamped into both).
function portal(a, b) {
  const n = a.corners.length;
  for (let i = 0; i < n; i++) {
    if (!a.edges[i]?.includes(b.id)) continue;
    const p = a.corners[i], q = a.corners[(i + 1) % n];
    // the part of this edge that b's bounds cover
    const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
    return [Math.min(Math.max(mid[0], b.min[0]), b.max[0]), Math.min(Math.max(mid[1], b.min[1]), b.max[1]), mid[2]];
  }
  return b.center.slice();
}
