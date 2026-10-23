// Doors and breakable glass, from the map export (world.js puts each door on a pivot at its hinge and keeps each pane of
// glass apart). Use (E) opens or closes the door you're looking at: it swings away from you (or its own way) at CS2's
// speed with its sounds, and closes again after its wait if it has one. A door is solid (its box, turned with it, in the
// collision world, so it stops you, the bots, bullets and grenades), and a bot that walks into a closed one opens it.
// A breakable (a pane of glass, a shop window, Nuke's vent covers, a bottle...) is solid until a bullet breaks it (a
// bottle or a pot only to bullets).
import { FLAG_PLAYER, FLAG_BULLET, FLAG_GRENADE } from './collision.js';
import { fromGl } from './world.js';

const SOLID = FLAG_PLAYER | FLAG_BULLET | FLAG_GRENADE;
const USE_RANGE = 96; // how far away you can open a door (CS2's use distance)

// The 12 triangles of a box given by its 8 corners (game units), written into out at offset 0.
function boxTris(c, out) {
  const faces = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
  let k = 0;
  for (const [a, b, d, e] of faces) for (const t of [[a, b, d], [a, d, e]]) for (const i of t) { out[k++] = c[i][0]; out[k++] = c[i][1]; out[k++] = c[i][2]; }
}

export class Doors {
  constructor(game, world) {
    this.game = game;
    this.world = world;
    this.list = (world.doors || []).filter((d) => !d.box.isEmpty()).map((d) => {
      const door = { ...d, angle: 0, target: 0, closeAt: Infinity };
      door.shape = game.collision.addDynamic({ tris: new Float32Array(12 * 9), flags: SOLID, surface: 'wood', door });
      this.place(door);
      return door;
    });
    this.panes = (world.glass || []).filter((g) => !g.box.isEmpty()).map((g) => {
      const pane = { ...g, broken: false };
      const b = g.box, corners = [];
      for (let i = 0; i < 8; i++) corners.push(fromGl({ x: i & 1 ? b.max.x : b.min.x, y: i & 2 ? b.max.y : b.min.y, z: i & 4 ? b.max.z : b.min.z }));
      pane.shape = game.collision.addDynamic({ tris: new Float32Array(12 * 9), flags: g.solid === false ? FLAG_BULLET : SOLID, surface: g.surface || 'glass', pane });
      boxTris(corners, pane.shape.tris);
      pane.center = corners.reduce((s, c) => s.map((v, k) => v + c[k] / 8), [0, 0, 0]);
      return pane;
    });
  }

  // Sound events the doors and breakables play (to load with the map's).
  sounds() {
    return [...new Set([...this.list.flatMap((d) => Object.values(d.sounds)), ...this.panes.map((p) => p.sound || 'Glass.Break')].filter(Boolean))];
  }

  // Turns a door's pivot to its angle and its solid box with it (the box shrunk a touch, so it doesn't catch on the
  // frame).
  place(d) {
    d.pivot.rotation.y = (d.angle * Math.PI) / 180;
    d.pivot.updateMatrixWorld(true);
    const b = d.box, m = d.pivot.matrixWorld, corners = [];
    const v = { x: 0, y: 0, z: 0 }, e = m.elements, s = 0.01; // metres
    for (let i = 0; i < 8; i++) {
      v.x = i & 1 ? b.max.x - s : b.min.x + s; v.y = i & 2 ? b.max.y - s : b.min.y + s; v.z = i & 4 ? b.max.z - s : b.min.z + s;
      corners.push(fromGl({ x: e[0] * v.x + e[4] * v.y + e[8] * v.z + e[12], y: e[1] * v.x + e[5] * v.y + e[9] * v.z + e[13], z: e[2] * v.x + e[6] * v.y + e[10] * v.z + e[14] }));
    }
    boxTris(corners, d.shape.tris);
    d.corners = corners;
    d.center = corners.reduce((s2, c) => s2.map((x, k) => x + c[k] / 8), [0, 0, 0]);
  }

  // Is someone (feet at p) in the door's way? Its footprint (seen from above) against their 32-unit box, and heights.
  inWay(d, p) {
    const c = d.corners, zs = c.map((q) => q[2]);
    if (p[2] > Math.max(...zs) || p[2] + 72 < Math.min(...zs)) return false;
    const foot = [c[0], c[1], c[5], c[4]].map((q) => [q[0], q[1]]), box = [[p[0] - 16, p[1] - 16], [p[0] + 16, p[1] - 16], [p[0] + 16, p[1] + 16], [p[0] - 16, p[1] + 16]];
    const axes = [[1, 0], [0, 1], [foot[1][0] - foot[0][0], foot[1][1] - foot[0][1]], [foot[3][0] - foot[0][0], foot[3][1] - foot[0][1]]].map(([x, y]) => [-y, x]);
    for (const [ax, ay] of axes) {
      const pa = foot.map((q) => q[0] * ax + q[1] * ay), pb = box.map((q) => q[0] * ax + q[1] * ay);
      if (Math.max(...pa) < Math.min(...pb) || Math.max(...pb) < Math.min(...pa)) return false;
    }
    return true;
  }

  // Where a door's middle would be at an angle (to open it away from someone).
  centerAt(d, angle) {
    const a = d.angle;
    d.angle = angle; this.place(d);
    const c = d.center;
    d.angle = a; this.place(d);
    return c;
  }

  // Opens a closed door (away from `from`, a position, if it opens either way) or closes an open one.
  toggle(d, from) {
    const g = this.game;
    if (d.target !== 0) { d.target = 0; d.closeAt = Infinity; }
    else {
      let dir = d.reverse ? -1 : 1;
      if (d.away && from) {
        const p = this.centerAt(d, d.distance), q = this.centerAt(d, -d.distance);
        dir = Math.hypot(p[0] - from[0], p[1] - from[1]) >= Math.hypot(q[0] - from[0], q[1] - from[1]) ? 1 : -1;
      }
      d.target = dir * d.distance;
      d.closeAt = d.wait >= 0 ? g.now + Math.abs(d.distance / d.speed) + d.wait : Infinity;
    }
    if (d.sounds.move) g.sounds.play(d.sounds.move, { pos: d.center, listener: g, volume: 0.8 });
  }

  // E: the door you're looking at, within reach.
  use(eye, dir) {
    const hit = this.game.collision.raycast(eye, dir, USE_RANGE, SOLID);
    const d = hit?.shape?.door;
    if (!d) return false;
    this.toggle(d, eye);
    return true;
  }

  // Bullets: a pane of glass (or a vent cover, a bottle...) it hits breaks (returns true: the bullet goes on).
  shot(hit, p) {
    const pane = hit?.shape?.pane;
    if (!pane || pane.broken) return false;
    pane.broken = true;
    pane.shape.off = true;
    for (const m of pane.meshes) m.visible = false;
    this.world.setBroken?.(pane.piece, true); // (in a batch of the map's surfaces: see world.js)
    this.game.sounds.play(pane.sound || 'Glass.Break', { pos: p, listener: this.game });
    this.game.effects.impact?.(p, [0, 0, 1], pane.surface || 'glass');
    return true;
  }

  tick(dt, now) {
    const g = this.game;
    for (const d of this.list) {
      if (now >= d.closeAt) { d.closeAt = Infinity; if (d.target !== 0) this.toggle(d, null); }
      // A bot walking into a closed door opens it (away from itself).
      if (d.target === 0 && d.angle === 0) {
        for (const b of g.bots) {
          if (!b.c.alive || Math.hypot(b.vel[0], b.vel[1]) < 40) continue;
          if (Math.hypot(b.pos[0] - d.center[0], b.pos[1] - d.center[1]) < 48 && Math.abs(b.pos[2] + 36 - d.center[2]) < 60) { this.toggle(d, b.pos); break; }
        }
      }
      if (d.angle === d.target) continue;
      const step = d.speed * dt, delta = d.target - d.angle, prev = d.angle;
      d.angle = Math.abs(delta) <= step ? d.target : d.angle + Math.sign(delta) * step;
      this.place(d);
      // Someone in the way: it stops there.
      if (g.combatants.some((c) => c.alive && this.inWay(d, g.positionOf(c)))) { d.angle = prev; d.target = prev; this.place(d); continue; }
      if (d.angle === d.target) {
        const s = d.target === 0 ? d.sounds.close : d.sounds.open;
        if (s) g.sounds.play(s, { pos: d.center, listener: g, volume: 0.8 });
      }
    }
  }

  // Back as the map starts (each round).
  reset() {
    for (const d of this.list) { d.angle = d.target = 0; d.closeAt = Infinity; this.place(d); }
    for (const p of this.panes) { p.broken = false; p.shape.off = false; for (const m of p.meshes) m.visible = true; this.world.setBroken?.(p.piece, false); }
  }
}
