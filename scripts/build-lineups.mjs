// The bots' utility lineups (src/data/lineups.json), found on each map's own geometry. Every lineup below is asked for by
// its callouts: thrown from somewhere in one place to land in another (the part of it nearest a third, say: "the part
// of CT spawn nearest A site" is the CT smoke). For each, it tries throw spots in the first place that the side can walk
// to, and aims (pitch, yaw, Mouse1 / both / Mouse2, standing or jump-throw), simulating every throw with the game's own
// grenade physics (src/js/play/flight.js) on the map's collision mesh, and keeps the throw that lands nearest the spot,
// if one lands close enough: smokes and molotovs on it, flashbangs bursting in the air over it (a pop flash).
// Needs the maps exported into the CS2 cache (play/<map>/: Play mode does that).
//   node scripts/build-lineups.mjs [map ...]        (CS2SIM_CACHE: the cache, else the app's)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CollisionWorld, FLAG_BULLET, FLAG_PLAYER } from '../src/js/play/collision.js';
import { HULL_STAND } from '../src/js/play/movement.js';
import { NavMesh } from '../src/js/play/nav.js';
import { throwVelocity, throwOrigin, simulateFlight } from '../src/js/play/flight.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = process.env.CS2SIM_CACHE || path.join(process.env.APPDATA || '', 'CS2 Case Simulator', 'cs2cache');
const OUT = path.join(ROOT, 'src', 'data', 'lineups.json');
const EYE = 64, JUMP = 301.993;

// purpose: when the bots use it. T: 'A' / 'B' (executes on a site), 'mid' (taking mid), 'default' (map control);
// CT: 'holdA' / 'holdB' (slowing a push at the start of a round), 'retakeA' / 'retakeB'.
const SPECS = {
  de_dust2: [
    ['xbox', 'Xbox smoke', 'T', 'smoke', ['mid', 'A'], ['TSpawn', 'OutsideTunnel', 'TopofMid'], { place: 'Catwalk', toward: 'TopofMid' }],
    ['ctA', 'CT smoke (A)', 'T', 'smoke', ['A'], ['LongDoors', 'OutsideLong', 'LongA', 'TopofMid', 'Catwalk'], { place: 'CTSpawn', toward: 'BombsiteA' }],
    ['crossA', 'Long cross smoke', 'T', 'smoke', ['A'], ['LongDoors', 'OutsideLong', 'LongA'], { place: 'BombsiteA', toward: 'LongA' }],
    ['shortA', 'Short smoke (from long)', 'T', 'smoke', ['A'], ['LongA', 'LongDoors'], { place: 'ShortStairs', toward: 'BombsiteA' }],
    ['plantA', 'A site molotov', 'T', 'fire', ['A'], ['LongA', 'ARamp', 'Catwalk'], { place: 'BombsiteA' }],
    ['popLong', 'Long pop flash', 'T', 'flash', ['A'], ['LongDoors', 'OutsideLong'], { place: 'LongA', toward: 'ARamp' }],
    ['popShort', 'Short pop flash', 'T', 'flash', ['A'], ['Catwalk', 'TopofMid'], { place: 'ShortStairs', toward: 'BombsiteA' }],
    ['bDoors', 'B doors smoke', 'T', 'smoke', ['B'], ['UpperTunnel', 'LowerTunnel', 'TunnelStairs', 'OutsideTunnel'], { place: 'BDoors' }],
    ['bPlat', 'B platform smoke', 'T', 'smoke', ['B'], ['UpperTunnel', 'TunnelStairs', 'OutsideTunnel'], { place: 'BombsiteB', toward: 'BDoors' }],
    ['popB', 'B tunnels pop flash', 'T', 'flash', ['B'], ['UpperTunnel', 'TunnelStairs'], { place: 'BombsiteB', toward: 'UpperTunnel' }],
    ['backB', 'B back molotov', 'T', 'fire', ['B'], ['UpperTunnel', 'TunnelStairs', 'LowerTunnel'], { place: 'BombsiteB', toward: 'BDoors' }],
    ['midDoors', 'Mid doors smoke', 'T', 'smoke', ['mid', 'B', 'default'], ['TopofMid', 'OutsideTunnel', 'TSpawn', 'Middle'], { place: 'MidDoors' }],
    ['longCT', 'Long doors smoke', 'CT', 'smoke', ['holdA'], ['LongA', 'ARamp', 'BombsiteA', 'CTSpawn'], { place: 'LongDoors' }],
    ['longMolly', 'Long doors molotov', 'CT', 'fire', ['holdA'], ['LongA', 'ARamp', 'BombsiteA'], { place: 'LongDoors' }],
    ['tunnelsCT', 'B tunnels smoke', 'CT', 'smoke', ['holdB'], ['BombsiteB', 'BDoors', 'Side'], { place: 'UpperTunnel', toward: 'BombsiteB' }],
    ['tunnelsFlash', 'B tunnels flash', 'CT', 'flash', ['holdB'], ['BombsiteB', 'BDoors'], { place: 'UpperTunnel', toward: 'BombsiteB' }],
    ['retakeA', 'A retake flash', 'CT', 'flash', ['retakeA'], ['CTSpawn', 'ShortStairs'], { place: 'BombsiteA' }],
    ['retakeB', 'B retake flash', 'CT', 'flash', ['retakeB'], ['BDoors', 'MidDoors', 'CTSpawn'], { place: 'BombsiteB' }],
  ],
  de_mirage: [
    ['window', 'Window smoke', 'T', 'smoke', ['mid', 'default', 'B'], ['TSpawn', 'TopofMid', 'TRamp'], { place: 'SnipersNest' }],
    ['jungle', 'Jungle smoke', 'T', 'smoke', ['A'], ['TRamp', 'TSpawn', 'PalaceAlley'], { place: 'Jungle' }],
    ['ctA', 'CT smoke (A)', 'T', 'smoke', ['A'], ['TRamp', 'TSpawn', 'PalaceAlley', 'PalaceInterior'], { place: 'CTSpawn', toward: 'BombsiteA' }],
    ['stairs', 'Stairs smoke', 'T', 'smoke', ['A'], ['TRamp', 'TSpawn', 'PalaceAlley'], { place: 'Stairs' }],
    ['aMolly', 'A site molotov', 'T', 'fire', ['A'], ['TRamp', 'PalaceInterior', 'PalaceAlley'], { place: 'BombsiteA', toward: 'Jungle' }],
    ['popA', 'A ramp pop flash', 'T', 'flash', ['A'], ['TRamp', 'PalaceAlley'], { place: 'BombsiteA', toward: 'TRamp' }],
    ['marketB', 'Market smoke', 'T', 'smoke', ['B'], ['Apartments', 'BackAlley', 'TSpawn', 'Underpass'], { place: 'Shop', toward: 'BombsiteB' }],
    ['shortB', 'Short smoke (B)', 'T', 'smoke', ['B', 'mid'], ['TopofMid', 'Middle', 'Apartments', 'Underpass'], { place: 'Catwalk' }],
    ['popB', 'Apartments pop flash', 'T', 'flash', ['B'], ['Apartments'], { place: 'BombsiteB', toward: 'Apartments' }],
    ['bMolly', 'B site molotov', 'T', 'fire', ['B'], ['Apartments'], { place: 'BombsiteB', toward: 'Shop' }],
    ['topMid', 'Top mid smoke', 'CT', 'smoke', ['holdA', 'holdB'], ['Connector', 'Catwalk', 'Middle'], { place: 'TopofMid' }],
    ['palace', 'Palace molotov', 'CT', 'fire', ['holdA'], ['BombsiteA', 'Stairs', 'CTSpawn'], { place: 'PalaceInterior', toward: 'BombsiteA' }],
    ['ramp', 'A ramp smoke', 'CT', 'smoke', ['holdA'], ['BombsiteA', 'Stairs', 'Jungle'], { place: 'TRamp', toward: 'BombsiteA' }],
    ['apps', 'Apartments molotov', 'CT', 'fire', ['holdB'], ['BombsiteB', 'Shop'], { place: 'Apartments', toward: 'BombsiteB' }],
    ['retakeA', 'A retake flash', 'CT', 'flash', ['retakeA'], ['CTSpawn', 'Jungle', 'Connector'], { place: 'BombsiteA' }],
    ['retakeB', 'B retake flash', 'CT', 'flash', ['retakeB'], ['Shop', 'CTSpawn'], { place: 'BombsiteB' }],
  ],
  de_inferno: [
    ['arch', 'Arch smoke', 'T', 'smoke', ['A'], ['SecondMid', 'Apartments', 'Middle', 'LowerMid'], { place: 'Arch' }],
    ['library', 'Library smoke', 'T', 'smoke', ['A'], ['SecondMid', 'Apartments', 'Middle'], { place: 'Library' }],
    ['pit', 'Pit molotov', 'T', 'fire', ['A'], ['Apartments', 'SecondMid', 'Balcony'], { place: 'Pit' }],
    ['popA', 'A pop flash', 'T', 'flash', ['A'], ['Apartments', 'Balcony', 'SecondMid'], { place: 'BombsiteA', toward: 'Apartments' }],
    ['ctB', 'CT smoke (B)', 'T', 'smoke', ['B'], ['Banana', 'TRamp', 'Underpass'], { place: 'CTSpawn', toward: 'BombsiteB' }],
    ['coffins', 'Coffins smoke', 'T', 'smoke', ['B'], ['Banana', 'TRamp'], { place: 'BombsiteB', toward: 'CTSpawn' }],
    ['firstB', 'B first spot molotov', 'T', 'fire', ['B'], ['Banana'], { place: 'BombsiteB', toward: 'Banana' }],
    ['popB', 'Banana pop flash', 'T', 'flash', ['B'], ['Banana'], { place: 'BombsiteB', toward: 'Banana' }],
    ['bananaCT', 'Banana molotov', 'CT', 'fire', ['holdB'], ['BombsiteB', 'Ruins', 'CTSpawn'], { place: 'Banana', toward: 'BombsiteB' }],
    ['bananaSmoke', 'Banana smoke', 'CT', 'smoke', ['holdB'], ['BombsiteB', 'Ruins', 'CTSpawn'], { place: 'Banana' }],
    ['apps', 'Apartments molotov', 'CT', 'fire', ['holdA'], ['BombsiteA', 'Library', 'Pit'], { place: 'Apartments', toward: 'BombsiteA' }],
    ['retakeA', 'A retake flash', 'CT', 'flash', ['retakeA'], ['Arch', 'Library', 'CTSpawn'], { place: 'BombsiteA' }],
    ['retakeB', 'B retake flash', 'CT', 'flash', ['retakeB'], ['CTSpawn', 'Ruins'], { place: 'BombsiteB' }],
  ],
  de_nuke: [
    ['outsideCT', 'Outside CT smoke', 'T', 'smoke', ['B', 'default'], ['TSpawn', 'Outside', 'Roof'], { place: 'Outside', toward: 'CTSpawn' }],
    ['outsideGarage', 'Outside garage smoke', 'T', 'smoke', ['default'], ['TSpawn', 'Outside', 'Roof'], { place: 'Outside', toward: 'Garage' }],
    ['heaven', 'Heaven smoke', 'T', 'smoke', ['A'], ['Outside', 'Roof', 'Lobby', 'TSpawn'], { place: 'Heaven' }],
    ['popA', 'Hut pop flash', 'T', 'flash', ['A'], ['Lobby', 'Squeaky'], { place: 'BombsiteA', toward: 'Hut' }],
    ['aMolly', 'A site molotov', 'T', 'fire', ['A'], ['Lobby', 'Squeaky', 'Hut'], { place: 'BombsiteA' }],
    ['ramp', 'Ramp smoke', 'T', 'smoke', ['B'], ['Lobby', 'Ramp'], { place: 'Ramp', toward: 'BombsiteB' }],
    ['lobbyCT', 'Lobby smoke', 'CT', 'smoke', ['holdA'], ['BombsiteA', 'Heaven', 'Hut', 'Squeaky'], { place: 'Lobby', toward: 'BombsiteA' }],
    ['retakeA', 'A retake flash', 'CT', 'flash', ['retakeA'], ['Heaven', 'Mini', 'Hut'], { place: 'BombsiteA' }],
    ['retakeB', 'B retake flash', 'CT', 'flash', ['retakeB'], ['Decon', 'Tunnels', 'Control'], { place: 'BombsiteB' }],
  ],
};

// How far each kind is thrown from (units), and how close it has to land.
const RANGE = { smoke: [500, 2800, 1500], fire: [350, 1700, 850], flash: [250, 1500, 650], he: [300, 1600, 800] };
const TOLERANCE = { smoke: 72, fire: 64, flash: 140, he: 90 };
const FLASH_HEIGHT = 110; // a pop flash bursts this far over the spot

const inBox = (p, b) => p[0] >= b.min[0] && p[0] <= b.max[0] && p[1] >= b.min[1] && p[1] <= b.max[1] && p[2] >= b.min[2] - 64 && p[2] <= b.max[2];
const d2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const mean = (ps) => ps.reduce((s, p) => [s[0] + p[0] / ps.length, s[1] + p[1] / ps.length, s[2] + p[2] / ps.length], [0, 0, 0]);

function loadMap(id) {
  const dir = path.join(CACHE, 'play', id);
  const info = JSON.parse(fs.readFileSync(path.join(dir, 'map.json'), 'utf8'));
  const buf = fs.readFileSync(path.join(dir, 'collision.bin'));
  const col = new CollisionWorld(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), info.collision);
  const nav = new NavMesh(JSON.parse(fs.readFileSync(path.join(dir, 'nav.json'), 'utf8')));
  return { info, col, nav };
}

// The nav areas in a place (their middles), the big enough ones.
function areasIn(map, place) {
  const boxes = map.info.places.filter((p) => p.name === place);
  return map.nav.areas.filter((a) => a.size > 400 && boxes.some((b) => inBox(a.center, b)));
}

function target(map, to) {
  const areas = areasIn(map, to.place);
  if (!areas.length) return null;
  const toward = to.toward ? areasIn(map, to.toward) : [];
  const aim = toward.length ? mean(toward.map((a) => a.center)) : mean(areas.map((a) => a.center));
  const best = areas.slice().sort((a, b) => d3(a.center, aim) - d3(b.center, aim))[0];
  // Not right at the edge of the place: a little way into it from the nearest area.
  const inner = areas.filter((a) => d3(a.center, best.center) < 260);
  return mean(inner.map((a) => a.center));
}

function landing(col, eye, pitch, yaw, strength, jump, kind, dt) {
  const vel = throwVelocity(pitch, yaw, strength, jump ? [0, 0, JUMP] : [0, 0, 0]);
  const origin = throwOrigin(col, eye, pitch, yaw);
  return simulateFlight(col, origin, vel, kind, { dt });
}

// How far a throw's result is from what it's for (Infinity when it doesn't do it at all).
function miss(map, kind, res, goal) {
  if (!res) return Infinity;
  if (kind === 'flash') {
    const over = [goal[0], goal[1], goal[2] + FLASH_HEIGHT];
    if (map.col.raycast(res.pos, [0, 0, -1], 400, FLAG_BULLET) === null) return Infinity; // over a drop
    return d3(res.pos, over);
  }
  if (kind === 'fire' && (!res.landed || map.col.raycast(res.pos, [0, 0, -1], 160, FLAG_BULLET) === null)) return Infinity;
  if (Math.abs(res.pos[2] - goal[2]) > 72) return Infinity; // a ledge above or a floor below
  return d2(res.pos, goal);
}

function findLineup(map, spec, side) {
  const [id, name, , kind, purpose, from, to] = spec;
  const goal = target(map, to);
  if (!goal) return { id, error: 'no target area in ' + to.place };
  const spawn = map.info.spawns[side]?.[0]?.origin;
  const [lo, hi, ideal] = RANGE[kind];
  const spots = from.flatMap((p) => areasIn(map, p)).filter((a) => { const d = d2(a.center, goal); return d >= lo && d <= hi; })
    .sort((a, b) => Math.abs(d2(a.center, goal) - ideal) - Math.abs(d2(b.center, goal) - ideal));
  const found = []; // throws that land close enough, to pick the steadiest of
  let tried = 0;
  for (const a of spots) {
    if (tried >= 40 || found.filter((x) => x.err < TOLERANCE[kind] * 0.5).length >= 8) break;
    if (spawn && !map.nav.path(spawn, a.center)) continue; // the side can't get there
    tried++;
    // Where a player standing there has its feet (on the floor under the hull, not the nav area's own height), in whole
    // units as it's stored: the throw is worked out from exactly what a bot will do.
    const x = Math.round(a.center[0]), y = Math.round(a.center[1]);
    const down = map.col.traceBox([x, y, a.center[2] + 32], [x, y, a.center[2] - 96], HULL_STAND.mins, HULL_STAND.maxs, FLAG_PLAYER);
    if (down.startsolid || down.fraction >= 1) continue;
    const feet = [x, y, Math.round(down.endpos[2] * 1000) / 1000], eye = [feet[0], feet[1], feet[2] + EYE];
    const yaw0 = (Math.atan2(goal[1] - eye[1], goal[0] - eye[0]) * 180) / Math.PI;
    // Coarse: every pitch, strength and jump at the direct yaw (at half the tick rate), then the best few refined.
    const coarse = [];
    for (const jump of [false, true]) {
      for (const strength of [1, 0.5, 0]) {
        for (let pitch = -70; pitch <= 30; pitch += 2) {
          const err = miss(map, kind, landing(map.col, eye, pitch, yaw0, strength, jump, kind, 1 / 32), goal);
          if (err < 600) coarse.push({ pitch, yaw: yaw0, strength, jump, err });
        }
      }
    }
    coarse.sort((x, y) => x.err - y.err);
    for (const c of coarse.slice(0, 3)) {
      for (let dp = -1.5; dp <= 1.5; dp += 0.25) {
        for (let dy = -2; dy <= 2; dy += 0.25) {
          const pitch = +(c.pitch + dp).toFixed(2), yaw = +(c.yaw + dy).toFixed(2); // (as stored: exactly what a bot aims)
          const res = landing(map.col, eye, pitch, yaw, c.strength, c.jump, kind, 1 / 64);
          const err = miss(map, kind, res, goal);
          if (err <= TOLERANCE[kind]) found.push({ id, name, side, kind, purpose, from, to: to.place, pos: feet, yaw: +yaw.toFixed(2), pitch: +pitch.toFixed(2), strength: c.strength, jump: c.jump, land: res.pos.map((v) => Math.round(v)), goal: goal.map((v) => Math.round(v)), err: Math.round(err), time: +res.time.toFixed(2) });
        }
      }
    }
  }
  if (!found.length) return { id, error: `nothing lands within ${TOLERANCE[kind]} (${tried} spots tried of ${spots.length})` };
  // The steadiest of the closest: how far it drifts if the aim is half a degree off (the bots' aim isn't perfect), and
  // a standing throw over a jump-throw.
  const drift = (x) => {
    let worst = 0;
    for (const [dp, dy] of [[0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5]]) worst = Math.max(worst, miss(map, kind, landing(map.col, [x.pos[0], x.pos[1], x.pos[2] + EYE], x.pitch + dp, x.yaw + dy, x.strength, x.jump, kind, 1 / 64), goal));
    return worst;
  };
  const pickFrom = found.sort((x, y) => x.err - y.err).filter((x, i, a) => a.findIndex((z) => z.pos.join() === x.pos.join() && Math.abs(z.pitch - x.pitch) < 0.6 && Math.abs(z.yaw - x.yaw) < 0.6) === i).slice(0, 16);
  for (const x of pickFrom) { x.spread = drift(x); x.score = x.err + 0.6 * Math.min(x.spread, 1000) + (x.jump ? 15 : 0); }
  const best = pickFrom.sort((x, y) => x.score - y.score)[0];
  best.spread = Number.isFinite(best.spread) ? Math.round(best.spread) : null;
  delete best.score;
  return best;
}

const maps = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SPECS);
const out = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
for (const id of maps) {
  if (!SPECS[id]) { console.log(id, ': no lineups asked for'); continue; }
  if (!fs.existsSync(path.join(CACHE, 'play', id, 'collision.bin'))) { console.log(id, ': not exported (play the map once)'); continue; }
  const t0 = Date.now();
  const map = loadMap(id);
  const found = [];
  for (const spec of SPECS[id]) {
    const t = Date.now();
    const r = findLineup(map, spec, spec[2]);
    if (r.error) console.log(`  ${id} ${spec[0]}: ${r.error}`);
    else { found.push(r); console.log(`  ${id} ${r.id} (${r.name}): from ${r.pos.join(',')} ${r.jump ? 'jump-throw' : 'throw'} ${r.strength === 1 ? 'Mouse1' : r.strength ? 'Mouse1+2' : 'Mouse2'} at ${r.pitch}/${r.yaw}, lands ${r.err} from the spot (half a degree off: ${r.spread}) in ${((Date.now() - t) / 1000).toFixed(0)}s`); }
  }
  out[id] = found;
  console.log(`${id}: ${found.length} of ${SPECS[id].length} lineups in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
}
