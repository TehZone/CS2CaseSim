// Where bots hold, as players do: a spot with some cover that sees a way the enemy comes in, facing the place they'd
// first show on it (the doorway, the top of the ramp), not a random point out in the open turned towards the enemy's
// spawn as the crow flies (often a wall). For each place a side holds (a bomb site for the CTs, the same site for the
// terrorists once they've taken it, mid, where the terrorists gather before going in) it works out once a match:
// - the ways in: the nav paths to it from where the enemy comes (for the CTs: the terrorists' spawn, mid, the other
//   site; for the terrorists: the CTs' spawn, the other site, mid), a point every 96 units of the last 2,800 or so;
// - the spots worth holding: CS2's own hiding spots in its nav mesh (corners and cover its tools found) and some points
//   about the place, each with where on which way in an enemy first comes into its view (between 220 and 2,600 units
//   off), the angle there, its cover (walls and boxes close by), and how good it is (cover, a fair distance for a rifle
//   or for an AWP, one way in rather than several at once, not out in the corridor the enemy walks through).
// Each round a team's bots share them out (see pick): different ways in where there are several, a spot no teammate has
// taken, and not the spot it held the last two times, chosen at random among the good ones: never the same five spots.
import { FLAG_BULLET } from './collision.js';
import { stagingPoint } from './strats.js';

const EYE = 64, STEP = 96, NEAR = 220, FAR = 2600;
const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const centerOf = (box) => [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, box.min[2]];
const inBox = (p, box, m) => p[0] > box.min[0] - m && p[0] < box.max[0] + m && p[1] > box.min[1] - m && p[1] < box.max[1] + m && p[2] > box.min[2] - 200 && p[2] < box.max[2] + 200;

export class Spots {
  constructor(game, rng = Math.random) {
    this.game = game;
    this.rng = rng;
    this.places = new Map(); // key -> { ways, spots } (null: nothing found there)
    this.claims = new Map(); // key -> [{ pos, way, by }] this round
    this.history = new Map(); // bot name + key -> its last spots there
  }

  roundStart() { this.claims.clear(); }

  // What a side holds: 'hold:A' (CTs on a site), 'push:A' (terrorists on it, facing the CTs' ways in), 'mid:CT' or
  // 'mid:T', 'gather:A' (terrorists short of a site, watching the way out of it; 'gather:A/1' short of it on its second
  // way in, and so on).
  place(key) {
    if (!this.places.has(key)) this.places.set(key, this.build(key));
    return this.places.get(key);
  }
  // All of them, now (when the match loads: not mid-round), a place at a time and letting the page get on in between.
  async prepare() { for (const k of this.keys()) { this.place(k); await new Promise((r) => setTimeout(r, 0)); } }
  keys() {
    const g = this.game, sites = g.map.info.bombsites || [];
    const out = [];
    for (const s of sites) {
      out.push('hold:' + s.site, 'push:' + s.site, 'gather:' + s.site);
      // (And short of the site on each of its other ways in, for a plan coming in by one: see staging.)
      for (let r = 1; r < (this.place('hold:' + s.site)?.ways.length || 0); r++) out.push('gather:' + s.site + '/' + r);
    }
    if (this.midBox()) out.push('mid:CT', 'mid:T');
    return out;
  }

  // Where the terrorists gather short of a site coming in by one of its ways in (an index into its hold: place's ways;
  // 0, the way from their spawn, is strats.js stagingPoint): about 650 units back along it from where it enters.
  staging(siteId, route = 0) {
    const w = route > 0 && this.place('hold:' + siteId)?.ways[route];
    if (!w) return stagingPoint(this.game, siteId);
    const p = w.pts[Math.max(0, w.entry - 7)];
    return [p[0], p[1], p[2] - EYE];
  }
  // Where a way in enters the site (on the ground), or null.
  door(siteId, route) {
    const d = this.place('hold:' + siteId)?.ways[route]?.door;
    return d ? [d[0], d[1], d[2] - EYE] : null;
  }

  midBox() {
    const places = this.game.map.info.places || [];
    return places.find((x) => /^Middle$/i.test(x.name)) || places.find((x) => /mid/i.test(x.name)) || null;
  }
  spawnOf(side) { return this.game.enemySpawnCenter(side === 'T' ? 'CT' : 'T'); }

  // The region a place covers, where the enemy comes from, and where they're headed.
  setup(key) {
    const g = this.game, [kind, place] = key.split(':'), id = place.split('/')[0], sites = g.map.info.bombsites || [];
    const site = sites.find((s) => s.site === id), other = sites.find((s) => s.site !== id), mid = this.midBox();
    const at = (box) => box && centerOf(box);
    if (kind === 'hold' && site) return { box: site, margin: 500, to: centerOf(site), from: [this.spawnOf('T'), at(mid), at(other)], names: ['spawn', 'mid', other && other.site] };
    if (kind === 'push' && site) return { box: site, margin: 300, to: centerOf(site), from: [this.spawnOf('CT'), at(other), at(mid)] };
    if (kind === 'mid' && mid) return { box: mid, margin: 300, to: centerOf(mid), from: [this.spawnOf(id === 'CT' ? 'T' : 'CT')] };
    if (kind === 'gather' && site) {
      // Short of the site on the terrorists' way there (see staging), watching the way out of it.
      const p = this.staging(id, +(key.split('/')[1] || 0));
      return { box: { min: [p[0] - 300, p[1] - 300, p[2] - 120], max: [p[0] + 300, p[1] + 300, p[2] + 120] }, margin: 100, to: p, from: [centerOf(site)] };
    }
    return null;
  }

  build(key) {
    const g = this.game, nav = g.nav, col = g.collision, def = this.setup(key);
    if (!def || !nav || !col) return null;
    // The ways in, each a list of points (at head height) from the enemy's side towards the place.
    const ways = [];
    for (let o = 0; o < def.from.length; o++) {
      const from = def.from[o];
      if (!from) continue;
      const path = nav.path(from, def.to)?.points;
      if (!path || path.length < 2) continue;
      const pts = [];
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1], b = path[i], l = dist2(a, b);
        for (let s = 0; s < l; s += STEP) { const k = s / l; pts.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k + EYE]); }
      }
      const near = pts.filter((p) => dist2(p, def.to) < FAR + 200);
      // (Two origins whose ways in meet before the place are the same way in: kept once.)
      const entry = near.findIndex((p) => inBox(p, def.box, 150));
      const door = near[Math.max(0, entry)] || near[near.length - 1];
      if (near.length && !ways.some((w) => dist2(w.door, door) < 300)) ways.push({ pts: near, door, entry: Math.max(0, entry), from: def.names?.[o] || null });
    }
    if (!ways.length) return null;
    // Where to hold: CS2's hiding spots about the place, and points in it.
    const cand = [];
    for (const a of nav.areas) for (const h of a.hiding || []) if (inBox(h, def.box, def.margin)) cand.push({ pos: [h[0], h[1], h[2]], hiding: true });
    for (let i = 0; i < 45; i++) { const r = nav.randomPointIn(def.box.min, def.box.max, () => true, 20); if (r) cand.push({ pos: r.point, hiding: false }); }
    const spots = [];
    for (const c of cand) {
      const eye = [c.pos[0], c.pos[1], c.pos[2] + EYE];
      let watch = null, seen = 0, inPath = false;
      for (let w = 0; w < ways.length; w++) {
        const { pts, entry } = ways[w];
        // Out in the corridor they come through (short of the place): in their way, not holding it.
        for (let i = 0; i < entry && !inPath; i++) if (Math.hypot(pts[i][0] - eye[0], pts[i][1] - eye[1], pts[i][2] - eye[2]) < 110) inPath = true;
        // The first place on this way it would see an enemy coming (from the enemy's end).
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i], d = Math.hypot(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]);
          if (d < NEAR || d > FAR || col.occluded(eye, p, FLAG_BULLET, 2)) continue;
          seen++;
          if (!watch || d < watch.d) watch = { way: w, at: p, d }; // (seeing several: it watches the nearest)
          break;
        }
      }
      if (!watch) continue;
      let cover = 0;
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        if (col.raycast([c.pos[0], c.pos[1], c.pos[2] + 40], [Math.cos(a), Math.sin(a), 0], 80, FLAG_BULLET)) cover++;
      }
      const d = watch.d, base = 1 + cover * 0.06 + (c.hiding ? 0.35 : 0) - (seen - 1) * 0.25 - (inPath ? 0.6 : 0);
      const band = (lo, hi) => (d >= lo && d <= hi ? 0.5 : -Math.min(0.5, (d < lo ? lo - d : d - hi) / 1000));
      const look = [-(Math.atan2(watch.at[2] - eye[2], Math.hypot(watch.at[0] - eye[0], watch.at[1] - eye[1])) * 180) / Math.PI, (Math.atan2(watch.at[1] - eye[1], watch.at[0] - eye[0]) * 180) / Math.PI];
      spots.push({ pos: c.pos, way: watch.way, at: watch.at, look, cover, d: Math.round(d), score: base + band(350, 1400), awp: base + band(700, 2600) });
    }
    // Spots a few units apart are one spot.
    spots.sort((a, b) => b.score - a.score);
    const kept = [];
    for (const s of spots) if (!kept.some((k) => dist2(k.pos, s.pos) < 40)) kept.push(s);
    return kept.length ? { ways, spots: kept } : null;
  }

  // A spot for this bot at a place this round: { pos, look: [pitch, yaw], at } or null (nothing worked out there).
  // see: only spots that see this point (the planted bomb), within this far of it.
  pick(bot, key, { awp = false, see = null, within = Infinity } = {}) {
    const p = this.place(key);
    if (!p) return null;
    const claims = this.claims.get(key) || [], hist = this.history.get(bot.c.name + key) || [];
    // Another way in from the ones teammates already watch, if there is one.
    const watched = new Set(claims.map((c) => c.way));
    let free = p.spots.filter((s) => !claims.some((c) => dist2(c.pos, s.pos) < 140) && !this.takenNear(s.pos, bot));
    if (see) free = free.filter((s) => dist2(s.pos, see) < within && !this.game.collision.occluded([s.pos[0], s.pos[1], s.pos[2] + EYE], [see[0], see[1], see[2] + 12], FLAG_BULLET, 2));
    if (!free.length) return null;
    const fresh = free.filter((s) => !watched.has(s.way));
    const pool = (fresh.length ? fresh : free).map((s) => {
      const w = Math.max(0.05, awp ? s.awp : s.score);
      return { s, w: w * w * (hist.some((h) => dist2(h, s.pos) < 150) ? 0.12 : 1) * (0.6 + 0.8 * this.rng()) };
    }).sort((a, b) => b.w - a.w).slice(0, 10);
    let r = this.rng() * pool.reduce((t, x) => t + x.w, 0), got = pool[0].s;
    for (const x of pool) { r -= x.w; if (r <= 0) { got = x.s; break; } }
    claims.push({ pos: got.pos, way: got.way, by: bot.c });
    this.claims.set(key, claims);
    this.history.set(bot.c.name + key, [got.pos, ...hist].slice(0, 2));
    return { pos: got.pos.slice(), look: got.look.slice(), at: got.at.slice() };
  }
  // Someone else (on its team) holding or headed for a spot right there, at any place.
  takenNear(pos, bot) {
    for (const list of this.claims.values()) for (const c of list) if (c.by !== bot.c && c.by.team === bot.c.team && dist2(c.pos, pos) < 100) return true;
    return false;
  }
  // Let go of its spots (it moved on: a rotation, an order).
  release(bot) { for (const list of this.claims.values()) for (let i = list.length - 1; i >= 0; i--) if (list[i].by === bot.c) list.splice(i, 1); }
}
