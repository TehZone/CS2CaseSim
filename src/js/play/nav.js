// The map's navigation mesh (CS2's .nav for the player hull): convex areas with their neighbours and the ladders
// between them. Used to put bots on walkable ground and to find paths between places. Game units.
const CELL = 256;
const FLAG_CROUCH = 0x10000, FLAG_JUMP = 0x2, FLAG_AVOID = 0x80;
// What a player can climb (CS2's): a step without jumping, a jump, a crouch-jump.
export const STEP_HEIGHT = 18, JUMP_HEIGHT = 56, CROUCH_JUMP_HEIGHT = 66;
const JUMP_COST = 100; // a jump costs a path this many units more than walking (stairs or a ramp nearby win)

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
    this.failed = new Set(); // jumps ("from>to" area ids) a bot couldn't make this match (something in the way): paths go round
    this.blocked = new Set(); // ways ("from>to") a bot got stuck on again and again this round (see Brain.move): paths go round
    this.ledges = new Set(); // ids of the areas that are slivers over nothing (see markLedges): paths don't go onto them

    // How far each link climbs where the two areas meet: up to a step is a walk, up to a crouch-jump a jump, higher
    // can't be climbed (the link is only for coming down).
    for (const a of this.areas) {
      a.rise = new Map();
      for (const id of a.links) {
        const b = this.byId.get(id);
        if (!b) continue;
        const from = portal(a, b), to = b.links.includes(a.id) ? portal(b, a) : heightPoint(b, from);
        a.rise.set(id, to[2] - from[2]);
      }
    }
    // Ladders: climbable links between the areas at their bottom and top. dir is the side you climb from (Source's
    // NavDirType: north -y, east +x, south +y, west -x), so the climber stands at bottom + normal x 16.
    this.ladders = (data.ladders || []).map((l) => {
      const normal = [[0, -1, 0], [1, 0, 0], [0, 1, 0], [-1, 0, 0]][l.dir] || [0, 1, 0];
      return { ...l, normal, bottomAreas: [...new Set(l.bottomAreas)], topAreas: [...new Set(l.topAreas)] };
    });
    this.ladderLinks = new Map(); // area id -> [{ to, ladder, up }]
    const link = (from, to, ladder, up) => { if (!this.ladderLinks.has(from)) this.ladderLinks.set(from, []); this.ladderLinks.get(from).push({ to, ladder, up }); };
    for (const l of this.ladders) for (const b of l.bottomAreas) for (const t of l.topAreas) { link(b, t, l, true); link(t, b, l, false); }
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
  heightAt(x, y, z, maxDz = 80) {
    const a = this.findArea([x, y, z], maxDz);
    return a ? heightIn(a.corners, x, y) : null;
  }

  // The highest ground under (x, y) from `down` below z to `up` above it (what someone standing at z could get onto
  // there), or null. A player is 72 units tall, so two walkable surfaces at one spot are always further apart than that.
  groundAt(x, y, z, up = STEP_HEIGHT, down = 600) {
    const list = this.grid.get(Math.floor(x / CELL) + ',' + Math.floor(y / CELL)) || [];
    let best = null;
    for (const a of list) {
      if (x < a.min[0] - 1 || x > a.max[0] + 1 || y < a.min[1] - 1 || y > a.max[1] + 1) continue;
      const h = heightIn(a.corners, x, y);
      if (h !== null && h <= z + up && h >= z - down && (best === null || h > best)) best = h;
    }
    return best;
  }

  // Is any of the mesh in a box? (A callout or a position on the part of the map that's closed off in Wingman isn't.)
  reaches(min, max) {
    return this.areas.some((a) => a.max[0] >= min[0] && a.min[0] <= max[0] && a.max[1] >= min[1] && a.min[1] <= max[1] && a.max[2] >= min[2] - 40 && a.min[2] <= max[2] + 40);
  }

  // The main part of the map: the biggest set of areas that all reach each other (walking, jumping, dropping down,
  // climbing ladders), where the spawns are. Bits of mesh nobody gets onto (a box top with only a way down from it, a
  // ledge outside the map: CS2's mesh has hiding spots on some) and pits nobody gets out of are left out of where bots
  // are sent.
  get reach() { return (this._reach ||= this.mainReach()); }
  canReach(a) { return !!a && this.reach.has(a.id); }
  reachable(p) { return this.canReach(this.nearestArea(p)); }

  // Ledges over nothing: a sliver of mesh narrower than a body across, with on one side no more mesh level with it, no
  // wall and no floor within 300 units below (the guard rails and parapets round the edges of Vertigo's roofs, a sill
  // over a drop off the map). A bot that gets onto one carries its speed on over the edge: on Vertigo's B, jumping onto
  // the stair rail and dropping onto the guard rail at the building's edge, it went off the building, and on A one
  // walking along the parapet at the east edge did. Paths never go onto one from off one (a bot already on one gets off),
  // and what's only reached over them (their hiding spots) is out of where bots are sent (reach). col: the map's
  // CollisionWorld; mask: what a player collides with.
  markLedges(col, mask) {
    const BODY = 32, DEEP = 300;
    // Past (x, y) the way u (at the height of b's top): no wall within 64 units, and a gap with no floor.
    const overNothing = (x, y, z, u) => {
      const wall = col.raycast([x, y, z + 24], [u[0], u[1], 0], 64, mask), room = wall ? wall.t : 64;
      for (let k = 16; k <= room - 8; k += 16) {
        const q = [x + u[0] * k, y + u[1] * k, z + 24], tr = col.traceBox(q, [q[0], q[1], q[2] - 24 - DEEP], [-8, -8, 0], [8, 8, 8], mask);
        if (tr.startsolid) return false;
        if (tr.fraction >= 1) return true;
      }
      return false;
    };
    for (const b of this.areas) {
      const c = b.corners, n = c.length;
      for (let i = 0; i < n && !this.ledges.has(b.id); i++) {
        const p = c[i], q = c[(i + 1) % n], l = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (l < 1) continue;
        // This edge's outward way, the area's width that way, and anything level past it.
        let u = [(q[1] - p[1]) / l, (p[0] - q[0]) / l];
        if ((b.center[0] - (p[0] + q[0]) / 2) * u[0] + (b.center[1] - (p[1] + q[1]) / 2) * u[1] > 0) u = [-u[0], -u[1]];
        let lo = Infinity, hi = -Infinity;
        for (const k of c) { const d = k[0] * u[0] + k[1] * u[1]; lo = Math.min(lo, d); hi = Math.max(hi, d); }
        if (hi - lo >= BODY || (b.edges[i] || []).some((id) => Math.abs(b.rise.get(id) ?? Infinity) <= STEP_HEIGHT)) continue;
        // (Along the edge, every 64 units or so: a pillar past one point of a long rail isn't the whole rail.)
        const m = Math.min(8, Math.max(1, Math.round(l / 64)));
        for (let s = 0; s < m; s++) {
          const f = (s + 0.5) / m;
          if (overNothing(p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f, Math.max(p[2], q[2]), u)) { this.ledges.add(b.id); break; }
        }
      }
    }
    this._reach = null;
    return this;
  }
  // Onto a ledge (see markLedges) from off one: no path goes that way.
  ontoLedge(from, to) { return this.ledges.size > 0 && this.ledges.has(to) && !this.ledges.has(from); }

  mainReach() {
    const n = this.areas.length, idx = new Map(this.areas.map((a, i) => [a.id, i]));
    const fwd = this.areas.map((a) => {
      const out = [];
      for (const id of a.links) { const j = idx.get(id); if (j != null && (a.rise.get(id) || 0) <= CROUCH_JUMP_HEIGHT && !this.ontoLedge(a.id, id)) out.push(j); }
      for (const lk of this.ladderLinks.get(a.id) || []) { const j = idx.get(lk.to); if (j != null && !this.ontoLedge(a.id, lk.to)) out.push(j); }
      return out;
    });
    const rev = this.areas.map(() => []);
    fwd.forEach((out, i) => { for (const j of out) rev[j].push(i); });
    // Kosaraju: finishing order over the links, then the components over them reversed.
    const order = [], seen = new Uint8Array(n);
    for (let s = 0; s < n; s++) {
      if (seen[s]) continue;
      const stack = [[s, 0]];
      seen[s] = 1;
      while (stack.length) {
        const top = stack[stack.length - 1], out = fwd[top[0]];
        if (top[1] < out.length) { const j = out[top[1]++]; if (!seen[j]) { seen[j] = 1; stack.push([j, 0]); } } else { order.push(top[0]); stack.pop(); }
      }
    }
    const comp = new Int32Array(n).fill(-1), size = [];
    for (let k = n - 1; k >= 0; k--) {
      const s = order[k];
      if (comp[s] >= 0) continue;
      const c = size.length, stack = [s];
      comp[s] = c; size.push(0);
      while (stack.length) { const i = stack.pop(); size[c] += this.areas[i].size; for (const j of rev[i]) if (comp[j] < 0) { comp[j] = c; stack.push(j); } }
    }
    const main = size.indexOf(Math.max(...size));
    return new Set(this.areas.filter((a, i) => comp[i] === main).map((a) => a.id));
  }

  // A random spot inside a box (e.g. a bomb site) on walkable ground (that can be got to).
  randomPointIn(min, max, accept = () => true, tries = 80) {
    const list = this.areas.filter((a) => a.max[0] >= min[0] && a.min[0] <= max[0] && a.max[1] >= min[1] && a.min[1] <= max[1]
      && a.max[2] >= min[2] - 40 && a.min[2] <= max[2] + 40 && !(a.flags & (FLAG_CROUCH | FLAG_JUMP)) && a.size > 400 && this.reach.has(a.id));
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

  // The nearest area to a position: the one it stands on; else the one whose edge it's just off (its middle over the lip
  // of a ledge, a body's width beside a platform's area: not the floor far below it, from where a path would start
  // under the platform); else the one below it; else the closest centre.
  nearestArea(p) {
    const a = this.findArea(p, STEP_HEIGHT + 6) || this.edgeArea(p) || this.findArea(p, 200);
    if (a) return a;
    let best = null, bd = Infinity;
    for (const x of this.areas) {
      const d = (x.center[0] - p[0]) ** 2 + (x.center[1] - p[1]) ** 2 + ((x.center[2] - p[2]) * 2) ** 2;
      if (d < bd) { bd = d; best = x; }
    }
    return best;
  }

  // A jump a bot couldn't make (p: its path point, see path: link "from>to"): paths go round it from now on, and round
  // the jumps onto the same area beside it (the same ledge a little way along, that the same overhang or rail keeps you
  // off: on Vertigo's A site, three in a row).
  failJump(p) {
    if (!p?.link) return;
    this.failed.add(p.link);
    const to = this.byId.get(+p.link.split('>')[1]);
    if (!to) return;
    for (const a of this.areas) {
      const rise = a.rise.get(to.id);
      if (rise == null || rise <= STEP_HEIGHT || a.id === +p.link.split('>')[0]) continue;
      const q = portal(a, to);
      if (Math.hypot(q[0] - p[0], q[1] - p[1]) < 96 && Math.abs(q[2] - p[2]) < 24) this.failed.add(a.id + '>' + to.id);
    }
  }

  // The area within r units sideways of p (a body's half width) with its floor about level with p, or null.
  edgeArea(p, r = 16) {
    let best = null, bd = r;
    for (let gx = Math.floor((p[0] - r) / CELL); gx <= Math.floor((p[0] + r) / CELL); gx++) {
      for (let gy = Math.floor((p[1] - r) / CELL); gy <= Math.floor((p[1] + r) / CELL); gy++) {
        for (const a of this.grid.get(gx + ',' + gy) || []) {
          if (p[0] < a.min[0] - r || p[0] > a.max[0] + r || p[1] < a.min[1] - r || p[1] > a.max[1] + r) continue;
          if (p[2] < a.min[2] - 24 || p[2] > a.max[2] + STEP_HEIGHT + 6) continue;
          const d = edgeDist(a.corners, p[0], p[1]);
          if (d < bd) { bd = d; best = a; }
        }
      }
    }
    return best;
  }

  // A random standing spot, weighted by area size. `accept(area, point)` can reject candidates.
  randomPoint(accept = () => true, tries = 60) {
    for (let t = 0; t < tries; t++) {
      let r = Math.random() * this.total, a = this.areas[0];
      for (const x of this.areas) { r -= x.size; if (r <= 0) { a = x; break; } }
      if (a.flags & (FLAG_CROUCH | FLAG_JUMP | FLAG_AVOID) || a.size < 900 || !this.reach.has(a.id)) continue;
      const p = pointIn(a.corners);
      if (accept(a, p)) return { area: a, point: p };
    }
    return null;
  }

  // A* over areas; returns waypoints (crossing points between areas, then the goal) or null. nearest: where there's no
  // way to the goal (a spot on a box nobody gets onto), the way to the nearest place to it that there is a way to
  // ({ partial: true }, ending there).
  path(from, to, nearest = false) {
    const start = this.nearestArea(from), goal = this.nearestArea(to);
    if (!start || !goal) return null;
    const open = new Map([[start.id, { a: start, g: 0, f: dist(start.center, goal.center), prev: null }]]);
    const closed = new Map();
    // The waypoints along a chain of areas, ending at end.
    const build = (cur, end) => {
      const areas = [];
      for (let n = cur; n; n = n.prev) areas.unshift(n.a);
      const pts = [];
      const chain = [];
      for (let n = cur; n; n = n.prev) chain.unshift(n);
      for (let i = 1; i < areas.length; i++) {
        const lad = chain[i].ladder;
        if (!lad) {
          const rise = areas[i - 1].rise.get(areas[i].id) || 0;
          const link = areas[i - 1].id + '>' + areas[i].id;
          const p = rise > STEP_HEIGHT ? Object.assign(portal(areas[i - 1], areas[i]), { jump: rise, into: across(areas[i - 1], areas[i]), link }) : Object.assign(portal(areas[i - 1], areas[i]), { link });
          if ((areas[i - 1].flags | areas[i].flags) & FLAG_CROUCH) p.crouch = true; // (a vent, a hole in a wall: crouch through)
          // A way through that has to be gone through, not cut past (a crouch gap, a drop off a ledge): which way across.
          if (p.crouch || rise < -STEP_HEIGHT) p.cross = p.into || across(areas[i - 1], areas[i]);
          pts.push(p);
          continue;
        }
        // Climb: walk to the foot (or the top), then up (or down) the rungs, then step off.
        const { ladder: l, up } = lad, n = l.normal;
        const foot = [l.bottom[0] + n[0] * 16, l.bottom[1] + n[1] * 16, l.bottom[2]], head = [l.top[0] + n[0] * 16, l.top[1] + n[1] * 16, l.top[2]];
        const off = [l.top[0] - n[0] * 24, l.top[1] - n[1] * 24, l.top[2]];
        const into = areas[i];
        if (up) { pts.push(foot); pts.push(Object.assign(head, { ladder: l, up: true })); pts.push(heightPoint(into, off)); }
        else { pts.push(heightPoint(areas[i - 1], off)); pts.push(head); pts.push(Object.assign(foot, { ladder: l, up: false })); }
      }
      pts.push(end);
      return { areas, points: pts };
    };
    while (open.size) {
      let cur = null;
      for (const n of open.values()) if (!cur || n.f < cur.f) cur = n;
      open.delete(cur.a.id);
      closed.set(cur.a.id, cur);
      if (cur.a === goal) return build(cur, to.slice());
      for (const id of cur.a.links) {
        if (closed.has(id)) continue;
        const b = this.byId.get(id);
        const rise = cur.a.rise.get(id) || 0;
        if (!b || rise > CROUCH_JUMP_HEIGHT || (rise > STEP_HEIGHT && this.failed.has(cur.a.id + '>' + id)) || (this.blocked.size && this.blocked.has(cur.a.id + '>' + id)) || this.ontoLedge(cur.a.id, id)) continue;
        const g = cur.g + dist(cur.a.center, b.center) * (b.flags & FLAG_CROUCH ? 2 : 1) + (rise > STEP_HEIGHT ? JUMP_COST : 0);
        const o = open.get(id);
        if (!o || g < o.g) open.set(id, { a: b, g, f: g + dist(b.center, goal.center), prev: cur });
      }
      for (const lk of this.ladderLinks.get(cur.a.id) || []) {
        if (closed.has(lk.to) || this.ontoLedge(cur.a.id, lk.to)) continue;
        const b = this.byId.get(lk.to);
        if (!b) continue;
        const g = cur.g + dist(cur.a.center, lk.ladder.bottom) + lk.ladder.length * 1.6 + dist(lk.ladder.top, b.center);
        const o = open.get(lk.to);
        if (!o || g < o.g) open.set(lk.to, { a: b, g, f: g + dist(b.center, goal.center), prev: cur, ladder: lk });
      }
    }
    if (!nearest) return null;
    let near = null, nearD = Infinity;
    for (const n of closed.values()) { const d = dist(closestIn(n.a, to), to); if (d < nearD) { nearD = d; near = n; } }
    return near && Object.assign(build(near, closestIn(near.a, to)), { partial: true });
  }
}

// nav.json with areas taken out, the links and ladders to them too, and links cut ([from, to]: through a wall): what's
// left of the map in Wingman. Paths, hiding spots and random spots are all on what's left, so a bot never sets off for
// the far side of a wall.
export function withoutAreas(data, closed = [], cut = []) {
  const gone = new Set(closed), left = (ids) => ids.filter((id) => !gone.has(id));
  const walled = new Set(cut.map(([from, to]) => from + '>' + to));
  return {
    ...data,
    areas: data.areas.filter((a) => !gone.has(a.id)).map((a) => ({ ...a, e: a.e.map((ids) => left(ids).filter((id) => !walled.has(a.id + '>' + id))) })),
    ladders: (data.ladders || []).map((l) => ({ ...l, topAreas: left(l.topAreas), bottomAreas: left(l.bottomAreas) })).filter((l) => l.topAreas.length && l.bottomAreas.length),
  };
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

// How far (x, y) is from a convex area, sideways (0 inside it).
function edgeDist(c, x, y) {
  if (heightIn(c, x, y) !== null) return 0;
  let best = Infinity;
  for (let i = 0; i < c.length; i++) {
    const p = c[i], q = c[(i + 1) % c.length], dx = q[0] - p[0], dy = q[1] - p[1], l2 = dx * dx + dy * dy || 1;
    const k = Math.max(0, Math.min(1, ((x - p[0]) * dx + (y - p[1]) * dy) / l2));
    best = Math.min(best, Math.hypot(p[0] + dx * k - x, p[1] + dy * k - y));
  }
  return best;
}
// The point of an area nearest to p (on its surface): p's own (x, y) when it's over it, else the nearest on its edge,
// a little way in.
function closestIn(a, p) {
  const c = a.corners, h = heightIn(c, p[0], p[1]);
  if (h !== null) return [p[0], p[1], h];
  let best = null, bd = Infinity;
  for (let i = 0; i < c.length; i++) {
    const s = c[i], q = c[(i + 1) % c.length], dx = q[0] - s[0], dy = q[1] - s[1], l2 = dx * dx + dy * dy || 1;
    const k = Math.max(0, Math.min(1, ((p[0] - s[0]) * dx + (p[1] - s[1]) * dy) / l2));
    const x = s[0] + dx * k, y = s[1] + dy * k, d = Math.hypot(x - p[0], y - p[1]);
    if (d < bd) { bd = d; best = [x, y, s[2] + (q[2] - s[2]) * k]; }
  }
  // (Pulled towards the middle by up to 8 units, so it's on it, not on the line.)
  const mx = a.center[0] - best[0], my = a.center[1] - best[1], ml = Math.hypot(mx, my);
  if (ml > 0) { const k = Math.min(8, ml) / ml; best[0] += mx * k; best[1] += my * k; }
  return best;
}

// A point moved onto an area's surface (its height there, or the area's centre height).
function heightPoint(a, p) {
  const x = Math.min(Math.max(p[0], a.min[0]), a.max[0]), y = Math.min(Math.max(p[1], a.min[1]), a.max[1]);
  const h = heightIn(a.corners, x, y);
  return [x, y, h ?? a.center[2]];
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
// Which way a path crosses from area a into b: straight across their shared edge (a horizontal unit vector), the way
// to jump onto b when it's a ledge.
function across(a, b) {
  const n = a.corners.length;
  for (let i = 0; i < n; i++) {
    if (!a.edges[i]?.includes(b.id)) continue;
    const p = a.corners[i], q = a.corners[(i + 1) % n];
    const l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1, x = (q[1] - p[1]) / l, y = (p[0] - q[0]) / l;
    const k = (b.center[0] - (p[0] + q[0]) / 2) * x + (b.center[1] - (p[1] + q[1]) / 2) * y >= 0 ? 1 : -1;
    return [x * k, y * k];
  }
  const l = Math.hypot(b.center[0] - a.center[0], b.center[1] - a.center[1]) || 1;
  return [(b.center[0] - a.center[0]) / l, (b.center[1] - a.center[1]) / l];
}

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
