// Play mode physics tests on synthetic geometry: collision traces and Source-style movement (walking, walls, steps,
// jumping, crouch-jumping onto a ledge, falling).
//   node scripts/test-play.mjs
import { CollisionWorld, FLAG_PLAYER, FLAG_BULLET, FLAG_GRENADE } from '../src/js/play/collision.js';
import { PlayerMovement, MOVE } from '../src/js/play/movement.js';
import { Match, Combatant, SHORT_RULES } from '../src/js/play/match.js';
import { SmokeField } from '../src/js/play/smoke.js';
import { Deathmatch, ARMS_RACE } from '../src/js/play/modes.js';
import * as THREE from 'three';
import { flameAtlas, GroundFire, FireArt } from '../src/js/play/fire.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('FAIL', msg); } };
const near = (a, b, eps) => Math.abs(a - b) <= eps;

// Axis-aligned boxes as 12 triangles each.
function boxTris(min, max) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const q = (a, b, c, d) => [[a, b, c], [a, c, d]];
  const v = (x, y, z) => [x, y, z];
  return [
    ...q(v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1)), // top
    ...q(v(x0, y0, z0), v(x0, y1, z0), v(x1, y1, z0), v(x1, y0, z0)), // bottom
    ...q(v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1)), // -y
    ...q(v(x0, y1, z0), v(x0, y1, z1), v(x1, y1, z1), v(x1, y1, z0)), // +y
    ...q(v(x0, y0, z0), v(x0, y0, z1), v(x0, y1, z1), v(x0, y1, z0)), // -x
    ...q(v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1), v(x1, y0, z1)), // +x
  ];
}
function world(boxes) {
  const tris = boxes.flatMap(([min, max, flags = FLAG_PLAYER | FLAG_BULLET]) => boxTris(min, max).map((t) => ({ t, flags })));
  const n = tris.length;
  const buf = new ArrayBuffer(n * 38);
  const pos = new Float32Array(buf, 0, n * 9), fl = new Uint8Array(buf, n * 36, n);
  tris.forEach(({ t, flags }, i) => { pos.set(t.flat(), i * 9); fl[i] = flags; });
  return new CollisionWorld(buf, { tris: n, surfaces: ['default'] });
}

const W = world([
  [[-2000, -2000, -64], [2000, 2000, 0]], // floor, top at z=0
  [[500, -2000, 0], [564, 2000, 300]], // wall at x=500..564
  [[200, -100, 0], [300, 100, 16]], // a 16-unit step
  [[-600, -100, 0], [-500, 100, 60]], // a 60-unit ledge (needs a crouch-jump)
  [[-1000, -2000, 0], [-980, 2000, 300], FLAG_BULLET], // bullets only (no player collision)
]);

// traces
const down = W.raycast([0, 0, 100], [0, 0, -1], 1000);
ok(down && near(down.t, 100, 1e-3) && near(down.normal[2], 1, 1e-6), 'ray down hits the floor top');
ok(!W.raycast([0, 0, 100], [0, 0, 1], 1000), 'ray up hits nothing');
const tb = W.traceBox([0, -500, 1], [1000, -500, 1], [-16, -16, 0], [16, 16, 72]);
ok(tb.fraction < 1 && near(tb.endpos[0], 500 - 16, 0.1) && near(tb.normal[0], -1, 1e-6), 'box sweep stops at the wall: ' + tb.endpos[0]);
const tbs = W.traceBox([0, 0, 1], [0, 0, 1], [-16, -16, 0], [16, 16, 72]);
ok(!tbs.normal && tbs.fraction === 1, 'standing box clear of the floor');
ok(!W.raycast([-900, 0, 40], [-1, 0, 0], 500, FLAG_PLAYER), 'player mask ignores bullet-only geometry');
ok(!!W.raycast([-900, 0, 40], [-1, 0, 0], 500, FLAG_BULLET), 'bullet mask hits bullet-only geometry');

// movement
const run = (p, ticks, cmd) => { for (let i = 0; i < ticks; i++) p.tick(1 / 64, { forward: 0, side: 0, yaw: 0, maxSpeed: 250, ...cmd }); return p; };
let p = new PlayerMovement(W, [0, 0, 50]);
run(p, 64, {});
ok(p.onGround && near(p.origin[2], 0, 0.1), 'falls to the floor: ' + p.origin[2]);
run(p, 64, { forward: 1, yaw: 90 });
ok(near(p.speed2d(), 250, 1), 'runs at the weapon speed: ' + p.speed2d().toFixed(1));
const accel = new PlayerMovement(W, [0, 0, 0]);
run(accel, 6, { forward: 1, yaw: 90 });
ok(accel.speed2d() > 80 && accel.speed2d() < 250, 'accelerates over a few ticks: ' + accel.speed2d().toFixed(1));
run(p, 64, {});
ok(p.speed2d() < 1, 'friction stops the player: ' + p.speed2d().toFixed(2));
p = new PlayerMovement(W, [0, -500, 0]);
run(p, 64 * 4, { forward: 1, yaw: 0 });
ok(near(p.origin[0], 500 - 16, 0.5), 'walking into the wall stops at it: ' + p.origin[0].toFixed(2));
p = new PlayerMovement(W, [0, -500, 0]);
run(p, 64 * 3, { forward: 1, side: -1, yaw: 0 });
ok(p.origin[1] > -300 && near(p.origin[0], 484, 0.5), 'slides along the wall: ' + p.origin.map((v) => v.toFixed(1)));
p = new PlayerMovement(W, [100, 0, 0]);
run(p, 40, { forward: 1, yaw: 0 });
ok(p.origin[0] > 200 && near(p.origin[2], 16, 0.2), 'steps up a 16-unit step: ' + p.origin.map((v) => v.toFixed(1)));
// jump height ~57 units
p = new PlayerMovement(W, [0, 500, 0]);
let top = 0;
p.tick(1 / 64, { forward: 0, side: 0, yaw: 0, jump: true, maxSpeed: 250 });
for (let i = 0; i < 64; i++) { p.tick(1 / 64, { forward: 0, side: 0, yaw: 0, jump: true, maxSpeed: 250 }); top = Math.max(top, p.origin[2]); }
ok(near(top, MOVE.jumpImpulse ** 2 / (2 * MOVE.gravity), 2), 'jump height ~57: ' + top.toFixed(1));
ok(p.onGround, 'lands again');
// holding jump doesn't bunny hop
const z0 = p.origin[2];
run(p, 20, { jump: true });
ok(near(p.origin[2], z0, 0.01), 'holding jump does not jump again');
// crouch-jump onto the 60-unit ledge (a plain jump can't reach it)
const tryLedge = (crouch) => {
  const q = new PlayerMovement(W, [-100, 0, 0]);
  while (q.origin[0] > -440) q.tick(1 / 64, { forward: 1, side: 0, yaw: 180, maxSpeed: 250 });
  for (let i = 0; i < 90; i++) q.tick(1 / 64, { forward: 1, side: 0, yaw: 180, jump: true, duck: crouch && i > 6, maxSpeed: 250 });
  return q;
};
ok(tryLedge(false).origin[2] < 1, 'a plain jump does not reach the 60-unit ledge');
const cj = tryLedge(true);
ok(near(cj.origin[2], 60, 0.5), 'a crouch-jump reaches the 60-unit ledge: ' + cj.origin[2].toFixed(1));
// crouch speed
p = new PlayerMovement(W, [0, 900, 0]);
run(p, 128, { forward: 1, yaw: 0, duck: true });
ok(near(p.speed2d(), 250 * MOVE.duckScale, 1), 'crouch walking speed: ' + p.speed2d().toFixed(1));
run(p, 10, { forward: 0 });
p.tick(1 / 64, { forward: 0, side: 0, yaw: 0, maxSpeed: 250 });
run(p, 30, {});
ok(!p.ducked, 'stands up again');
// crouch spam: each new crouch goes down slower (CS2's duck speed), and it comes back after a rest
{
  const q = new PlayerMovement(W, [0, 900, 0]);
  const downTicks = () => { let n = 0; while (q.duckAmount < 1 && n < 200) { q.tick(1 / 64, { forward: 0, side: 0, yaw: 0, duck: true, maxSpeed: 250 }); n++; } run(q, 12, {}); return n; };
  const first = downTicks();
  for (let i = 0; i < 8; i++) { run(q, 3, { duck: true }); run(q, 3, {}); } // tapping crouch
  run(q, 20, {});
  const spammed = downTicks();
  run(q, 64 * 3, {});
  const rested = downTicks();
  ok(first <= 12 && spammed > first * 2.5 && rested <= 12, `crouch spam slows the crouch, a rest brings it back: ${first} ticks down, ${spammed} after tapping it, ${rested} rested`);
}

// ---- ladders: a wall at y=1000..1040 up to z=200 with a ladder plane in front of it, and a roof to step onto ----
{
  const tris = [];
  const add = (min, max, surface) => boxTris(min, max).forEach((t) => tris.push({ t, surface }));
  add([-2000, -2000, -64], [2000, 3000, 0], 0); // floor
  add([-200, 1000, 0], [200, 1400, 200], 0); // a block to climb onto (top z=200)
  add([-16, 998, 0], [16, 1000, 200], 1); // the ladder (2 units thick, its climbable face at y=998 facing -y)
  const n = tris.length, buf = new ArrayBuffer(n * 38);
  const pos = new Float32Array(buf, 0, n * 9), fl = new Uint8Array(buf, n * 36, n), sf = new Uint8Array(buf, n * 37, n);
  tris.forEach(({ t, surface }, i) => { pos.set(t.flat(), i * 9); fl[i] = FLAG_PLAYER | FLAG_BULLET; sf[i] = surface; });
  const L = new CollisionWorld(buf, { tris: n, surfaces: ['default', 'ladder'] });
  // Sight lines: the first-hit test agrees with the ray test, and stops short of the end point.
  const sights = [[[0, 500, 100], [0, 1600, 100]], [[0, 500, 300], [0, 1600, 300]], [[-500, 500, 50], [500, 500, 50]], [[0, 1200, 100], [0, 1300, 100]], [[0, 900, 10], [0, 999, 10]]];
  ok(sights.every(([a, b]) => { const d = b.map((v, k) => v - a[k]), l = Math.hypot(...d); return L.occluded(a, b) === !!L.raycast(a, d.map((v) => v / l), l - 2); }),
    'collision: a sight line is blocked exactly when a ray says so (through the block, over it, along the floor, from inside, to the ladder)');
  const climb =(cmd, ticks, q) => { for (let i = 0; i < ticks; i++) q.tick(1 / 64, { forward: 0, side: 0, yaw: 90, pitch: 0, maxSpeed: 250, ...cmd }); return q; };
  let q = new PlayerMovement(L, [0, 900, 0]);
  climb({ forward: 1 }, 64, q);
  ok(q.onLadder && q.origin[2] > 20, 'walking into a ladder climbs it: z=' + q.origin[2].toFixed(1));
  const z1 = q.origin[2];
  climb({ forward: 1 }, 16, q);
  ok(near(q.origin[2] - z1, MOVE.climbSpeed / 4, 4), 'climbs at CS2 ladder speed: ' + ((q.origin[2] - z1) * 4).toFixed(1) + '/s');
  climb({}, 32, q);
  ok(q.onLadder && near(q.velocity[2], 0, 0.01) && q.origin[2] > z1, 'hangs on the ladder without input');
  climb({ forward: 1, pitch: 80 }, 32, q);
  ok(q.origin[2] < z1 + 40, 'looking down and pressing forward climbs down: z=' + q.origin[2].toFixed(1));
  let roof = false;
  for (let i = 0; i < 64 * 4 && !roof; i++) { climb({ forward: 1, pitch: -30 }, 1, q); roof = q.onGround && q.origin[2] > 199; }
  ok(roof && q.origin[1] > 980, 'climbs over the top onto the roof: ' + q.origin.map((v) => v.toFixed(1)));
  q = new PlayerMovement(L, [0, 900, 0]);
  climb({ forward: 1 }, 64, q);
  climb({ jump: true }, 1, q);
  ok(!q.onLadder && q.velocity[1] < -200, 'jumping pushes off the ladder: vy=' + q.velocity[1].toFixed(1));
  // fall damage speed: a 300-unit drop lands at about 690 units/s (CS2 hurts above 580)
  q = new PlayerMovement(L, [0, 1200, 500]);
  let landed = 0;
  for (let i = 0; i < 200 && !landed; i++) { q.tick(1 / 64, { forward: 0, side: 0, yaw: 0, maxSpeed: 250 }); landed = q.landed; }
  ok(near(landed, Math.sqrt(2 * MOVE.gravity * 300), 25), 'landing speed after a 300-unit fall: ' + landed.toFixed(0));
}

// ---- match rules (economy, rounds, bomb) with a stand-in game ----
function fakeGame() {
  const g = { now: 0, team: 'CT', enemyTeam: 'T', map: { info: { bombsites: [{ site: 'A', min: [0, 0, 0], max: [100, 100, 100] }] } } };
  g.me = new Combatant({ name: 'You', team: 'CT', squad: 'A', bot: false });
  g.combatants = [g.me, new Combatant({ name: 'ct2', team: 'CT', squad: 'A' }), new Combatant({ name: 't1', team: 'T', squad: 'B' }), new Combatant({ name: 't2', team: 'T', squad: 'B' })];
  for (const k of ['onRoundStart', 'onLive', 'onHalftime', 'onPlanted', 'onDefuseStart', 'onDefuseAbort', 'onDefused', 'onExploded', 'onBombDropped', 'onBombPickedUp', 'onRoundEnd', 'onMatchOver']) g[k] = () => {};
  g.positionOf = () => [50, 50, 10];
  g.isDefusing = () => true;
  return g;
}
{
  const g = fakeGame(), m = new Match(g, SHORT_RULES);
  m.startRound();
  ok(m.phase === 'freeze' && g.combatants.filter((c) => c.hasC4).length === 1 && g.combatants.find((c) => c.hasC4).team === 'T', 'one terrorist gets the bomb');
  m.tick(SHORT_RULES.freeze + 0.01);
  ok(m.phase === 'live', 'freeze time ends');
  const [me, ct2, t1, t2] = g.combatants;
  t1.alive = false; m.onKill(t1, me, { killAward: 300 });
  ok(me.money === 1100 && me.kills === 1 && t1.deaths === 1, 'kill reward: ' + me.money);
  t2.alive = false; m.onKill(t2, ct2, { killAward: 600 });
  m.tick(0.01);
  ok(m.phase === 'end' && m.score.A === 1 && m.history[0].reason === 'elimination', 'CT win by elimination');
  ok(me.money === 1100 + 3250 && t1.money === 800 + 1400, 'round reward and loss bonus: ' + me.money + ' / ' + t1.money);
  m.tick(SHORT_RULES.endDelay + 0.01);
  ok(m.round === 2 && m.phase === 'freeze', 'next round');
  // CT loses on the bomb: T reward, CT loss bonus (CT had no losses), planter bonus
  m.tick(SHORT_RULES.freeze + 0.01);
  const carrier = g.combatants.find((c) => c.hasC4);
  carrier.alive = true;
  const before = carrier.money;
  m.planted(carrier, [50, 50, 10]);
  ok(m.phase === 'planted' && carrier.money === before + 300, 'plant bonus');
  g.now = SHORT_RULES.bombTime + 1;
  m.tick(0.01);
  ok(m.history[1].winner === 'T' && m.history[1].reason === 'bomb', 'bomb explodes: T win');
  ok(me.money === Math.min(16000, 4350 + 1400), 'CT first loss bonus $1400: ' + me.money);
  ok(m.lossStreak.T === 0 && m.lossStreak.CT === 1, 'loss streaks: ' + JSON.stringify(m.lossStreak));
  // time runs out: terrorists still alive get no loss bonus
  m.tick(SHORT_RULES.endDelay + 0.01); g.now = 0;
  m.tick(SHORT_RULES.freeze + 0.01);
  for (const c of g.combatants) c.alive = true; // the game revives everyone at round start
  const tMoney = t1.money, t2Dead = t2;
  t2Dead.alive = false;
  m.tick(SHORT_RULES.roundTime + 0.01);
  ok(m.history[2].reason === 'time' && t1.money === tMoney, 'living terrorists get nothing when time runs out');
  ok(t2Dead.money > 0 && m.lossStreak.T === 1, 'dead terrorists get the loss bonus');
  // buying
  ok(m.canBuy(me, 'vesthelm', {}) === false || m.phase !== 'freeze', 'buying only in buy time');
  m.tick(SHORT_RULES.endDelay + 0.01);
  me.money = 1000;
  ok(m.canBuy(me, 'vesthelm', {}) && !m.canBuy(me, 'weapon_ak47', { weapon_ak47: { price: 2700 } }), 'team-only weapons and money');
  m.pay(me, 'vest', {}); ok(me.armor === 100 && me.money === 350, 'kevlar');
  ok(m.costFor(me, 'vesthelm', {}) === 350, 'helmet upgrade costs $350');
  // halftime: sides swap and money resets
  while (m.round < SHORT_RULES.halftime) { m.endRound('CT', 'time'); m.tick(SHORT_RULES.endDelay + 0.01); }
  m.endRound('CT', 'time'); m.tick(SHORT_RULES.endDelay + 0.01);
  ok(m.round === SHORT_RULES.halftime + 1 && me.team === 'T' && t1.team === 'CT' && me.money === 800, `halftime swap: ${me.team} money ${me.money}`);
  while (m.phase !== 'over') { m.endRound('T', 'time'); m.tick(SHORT_RULES.endDelay + 0.01); }
  ok(m.winnerSquad() === 'A' && m.score.A >= SHORT_RULES.winsNeeded, 'match ends at ' + SHORT_RULES.winsNeeded + ' wins: ' + JSON.stringify(m.score));
}
// overtime: 8-8 goes to MR3 overtimes ($12,500, swap after 3); without overtime it's a draw
{
  const play = (rules, wins) => {
    const g = fakeGame(), m = new Match(g, rules);
    const log = [];
    g.onRoundStart = (round, o) => log.push({ round, ...o, team: g.me.team, money: g.me.money });
    m.startRound();
    for (const w of wins) { if (m.phase === 'over') break; m.tick(rules.freeze + 0.01); m.endRound(g.combatants.find((c) => c.squad === w).team, 'time'); m.tick(rules.endDelay + 0.01); }
    return { m, g, log };
  };
  const tie = 'ABABABABABABABAB'.split(''); // 8-8 after 16
  let r = play(SHORT_RULES, tie);
  ok(r.m.phase === 'over' && r.m.winnerSquad() === null, 'no overtime: 8-8 is a draw');
  r = play({ ...SHORT_RULES, overtime: true }, [...tie, 'A', 'B', 'A', 'B', 'A', 'B', 'A', 'A', 'A', 'A']);
  const ot1 = r.log.find((x) => x.round === 17), ot1half = r.log.find((x) => x.round === 20), ot2 = r.log.find((x) => x.round === 23);
  ok(ot1?.overtime === 1 && ot1.money === 12500 && ot1.team === r.log.find((x) => x.round === 16).team, 'overtime 1: $12,500, same sides as the second half');
  ok(ot1half?.halftime && ot1half.money === 12500 && ot1half.team !== ot1.team, 'overtime halftime: sides swap, $12,500 again');
  ok(ot2?.overtime === 2, 'a tied overtime (11-11) starts overtime 2');
  ok(r.m.phase === 'over' && r.m.winnerSquad() === 'A' && r.m.score.A === 15 && r.m.score.B === 11, 'overtime 2 won at 15: ' + JSON.stringify(r.m.score));
}

// ---- smoke: fills a room, pours out through the doorway, never through the walls ----
{
  // A 256 x 256 room (walls 16 thick, 128 high) with a 64-wide doorway in its +x wall, on a big floor.
  const S = world([
    [[-3000, -3000, -64], [3000, 3000, 0]],
    [[-144, -144, 0], [-128, 144, 128]], [[-144, -144, 0], [144, -128, 128]], [[-144, 128, 0], [144, 144, 128]],
    [[128, -144, 0], [144, -32, 128]], [[128, 32, 0], [144, 144, 128]],
    [[-144, -144, 128], [144, 144, 144]], // roof
  ]);
  const f = new SmokeField(S, [0, 0, 0], 0, 0);
  while (!f.done) f.fill();
  const at = (p) => f.densityAt(p, 3);
  const cellsOutside = f.cells.filter((k) => f.min[0] + ((k % 32) + 0.5) * 16 > 144).length;
  ok(at([0, 0, 60]) > 0.9 && at([100, 100, 30]) > 0.9 && at([-100, -100, 100]) > 0.9, 'smoke fills the room: ' + f.cells.length + ' cells');
  ok(at([-180, 0, 60]) === 0 && at([0, -180, 60]) === 0 && at([0, 0, 160]) === 0, 'not through the walls or the roof');
  ok(cellsOutside > 50 && at([170, 0, 30]) > 0.5, 'pours out through the doorway: ' + cellsOutside + ' cells outside');
  ok(f.thickness([-100, 0, 60], [100, 0, 60], 3) > 30 && f.thickness([-100, 0, 60], [100, 0, 60], 0.05) === 0, 'blocks sight once bloomed');
  f.carve([-120, 0, 60], [1, 0, 0], 300);
  ok(f.thickness([-100, 0, 60], [100, 0, 60], 3) < 5, 'a bullet tunnel lets you see through');
  for (let i = 0; i < 40; i++) f.heal(0.05);
  ok(f.thickness([-100, 0, 60], [100, 0, 60], 3) > 30, 'the tunnel closes again');
  ok(f.densityAt([0, 0, 60], 18.5) < 0.6 && f.densityAt([0, 0, 60], 21) === 0, 'fades out after 18 seconds');
}

// ---- Deathmatch and Arms Race scoring ----
{
  const g = fakeGame();
  g.ffa = true;
  g.hostile = (a, b) => a !== b;
  const respawned = [], levels = [];
  g.respawn = (c) => { c.alive = true; respawned.push(c); };
  g.onLevel = (c, d) => levels.push([c.name, d]);
  let over = null;
  g.onMatchOver = (squad) => { over = squad; };
  const dm = new Deathmatch(g, { minutes: 1 });
  dm.startRound();
  const [me, a, b] = g.combatants;
  b.alive = false; dm.onKill(b, me, { id: 'weapon_ak47' }, { headshot: true });
  ok(me.points === 15 && me.kills === 1 && b.deaths === 1, 'deathmatch: a headshot kill is 15 points: ' + me.points);
  a.alive = false; dm.onKill(a, me, { id: 'weapon_deagle' });
  ok(me.points === 30, 'deathmatch: a pistol kill is worth more: ' + me.points);
  g.now = 1; dm.tick(1);
  ok(respawned.length === 0, 'no respawn before 2 seconds');
  g.now = 2.1; dm.tick(1.1);
  ok(respawned.includes(a) && respawned.includes(b), 'the dead respawn after 2 seconds');
  g.now = 61; dm.tick(60);
  ok(dm.phase === 'over' && over === 'A' && dm.leader === me, 'the match ends at the time limit, most points wins');
  const ar = new Deathmatch(g, { minutes: 10, armsRace: true });
  ar.startRound();
  const [p, q] = g.combatants;
  for (let i = 0; i < ARMS_RACE.length - 1; i++) { q.alive = false; ar.onKill(q, p, { id: ARMS_RACE[p.level] }); }
  ok(p.level === ARMS_RACE.length - 1 && ar.phase === 'live', 'arms race: a new weapon every kill up to the knife: level ' + p.level);
  q.level = 3; q.alive = false; ar.onKill(q, p, { id: 'weapon_knife' });
  ok(ar.phase === 'over' && ar.leader === p, 'arms race: the knife kill wins');
  const ar2 = new Deathmatch(g, { armsRace: true }); ar2.startRound();
  q.level = 4; p.level = 2; q.alive = false; ar2.onKill(q, p, { id: 'weapon_knife' });
  ok(q.level === 3 && p.level === 3, 'arms race: knifed players go back a weapon');
}

// ---- Bots standing still: the body keeps its facing while the aim moves about; freeze time doesn't spin them.
{
  const { Bot } = await import('../src/js/play/bots.js');
  const { Brain } = await import('../src/js/play/ai.js');
  const b = { mode: 'move', yaw: 0, bodyYaw: 0, vel: [0, 0, 0], turning: false };
  const step = (secs, aim) => { for (let t = 0; t < secs; t += 1 / 60) { b.yaw = aim(t); Bot.prototype.turnBody.call(b, 1 / 60); } };
  step(4, (t) => Math.sin(t * 0.7) * 25);
  ok(b.bodyYaw === 0, 'a bot sweeping its aim 25° either way keeps its feet still: body ' + b.bodyYaw.toFixed(1));
  step(1, () => 90);
  ok(Math.abs(b.bodyYaw - 90) < 3 && !b.turning, 'aiming 90° away turns the body round, then it stops: ' + b.bodyYaw.toFixed(1));
  b.vel = [200, 0, 0];
  step(0.3, () => -60);
  ok(Math.abs(b.bodyYaw + 60) < 1, 'moving, the body faces the aim: ' + b.bodyYaw.toFixed(1));

  const bot = { yaw: 40, pitch: 0, index: 1 };
  const brain = Object.assign(Object.create(Brain.prototype), { bot, d: { turn: 380 } });
  Brain.prototype.roundStart.call(brain, {});
  let lo = Infinity, hi = -Infinity;
  for (let t = 0; t < 15; t += 1 / 144) { brain.lookAround(1 / 144, t); lo = Math.min(lo, bot.yaw); hi = Math.max(hi, bot.yaw); }
  ok(lo >= 29.5 && hi <= 50.5, `freeze time: a bot glances a little either side of its heading (${lo.toFixed(1)}..${hi.toFixed(1)}), not round`);

  // Holding an angle for 30 seconds: steady, with the odd small glance (it used to sweep 25° either way nonstop).
  const holder = { yaw: 30, pitch: 0, index: 2, vel: [0, 0, 0] };
  const hb = Object.assign(Object.create(Brain.prototype), { bot: holder, d: { turn: 380 } });
  Brain.prototype.roundStart.call(hb, {});
  Object.assign(hb, { task: 'hold', holdYaw: 30 });
  let turned = 0, movingFrames = 0, frames = 0, prev = holder.yaw, far = 0;
  for (let t = 0; t < 30; t += 1 / 60) {
    hb.look(1 / 60, t);
    const d = Math.abs(holder.yaw - prev); prev = holder.yaw;
    turned += d; frames++; if (d > 0.01) movingFrames++;
    far = Math.max(far, Math.abs(holder.yaw - 30));
  }
  ok(far <= 15.5 && movingFrames / frames < 0.35 && turned < 160,
    `holding an angle: steady with the odd glance (${Math.round((movingFrames / frames) * 100)}% of the time turning, ${Math.round(turned)}° in 30 s, at most ${far.toFixed(1)}° off)`);
}

// ---- CS2's equipment icons: weapon ids map to the icon files the service extracts (a set like CS2's own) ----
{
  const { iconFor } = await import('../src/js/play/icons.js');
  const { CATALOG } = await import('../src/js/play/match.js');
  const names = ['ak47', 'm4a1', 'm4a1_silencer', 'm4a1_silencer_off', 'usp_silencer', 'usp_silencer_off', 'knife', 'knife_t', 'knife_karambit',
    'bayonet', 'knife_m9_bayonet', 'hegrenade', 'molotov', 'incgrenade', 'inferno', 'c4', 'planted_c4', 'taser', 'kevlar', 'assaultsuit', 'defuser',
    'glock', 'hkp2000', 'elite', 'p250', 'tec9', 'fiveseven', 'cz75a', 'deagle', 'revolver', 'mac10', 'mp9', 'mp7', 'mp5sd', 'ump45', 'p90', 'bizon',
    'nova', 'xm1014', 'sawedoff', 'mag7', 'negev', 'm249', 'galilar', 'famas', 'ssg08', 'sg556', 'aug', 'awp', 'g3sg1', 'scar20', 'decoy', 'flashbang',
    'smokegrenade'];
  const icons = Object.fromEntries(names.map((n) => [n, `cs2cache/play/icons/${n}.svg`]));
  const icon = (id, opts) => iconFor(icons, id, opts)?.replace(/^.*\/|\.svg$/g, '') ?? null;
  ok(icon('weapon_ak47') === 'ak47' && icon('weapon_m4a1_silencer') === 'm4a1_silencer' && icon('weapon_m4a1') === 'm4a1', 'icons: guns by id');
  ok(icon('weapon_knife') === 'knife' && icon('weapon_knife_t') === 'knife_t' && icon('weapon_knife_karambit') === 'knife_karambit'
    && icon('weapon_bayonet') === 'bayonet' && icon('weapon_knife_skeleton') === 'knife', 'icons: knives (their own, else the default)');
  ok(icon('weapon_hegrenade') === 'hegrenade' && icon('weapon_c4') === 'c4' && icon('planted_c4') === 'planted_c4' && icon('weapon_taser') === 'taser', 'icons: grenades, C4, Zeus');
  ok(icon('weapon_molotov') === 'molotov' && icon('weapon_molotov', { kill: true }) === 'inferno' && icon('weapon_incgrenade', { kill: true }) === 'inferno', 'icons: fire kills are the inferno');
  ok(icon('weapon_usp_silencer', { gun: { detachable: true, silenced: false } }) === 'usp_silencer_off'
    && icon('weapon_m4a1_silencer', { gun: { detachable: true, silenced: true } }) === 'm4a1_silencer', 'icons: silencer off');
  const all = CATALOG.flatMap((c) => c.items.map(([id]) => id));
  ok(all.every((id) => icon(id)), 'icons: every buy menu item has one: ' + all.filter((id) => !icon(id)).join(', '));
  ok(icon(undefined) === null && iconFor(undefined, 'weapon_ak47') === null && iconFor({}, 'weapon_ak47') === null, 'icons: none without CS2 (names shown)');
}

// ---- the soccer ball -----------------------------------------------------------------------------------------------
{
  const { Balls } = await import('../src/js/play/props.js');
  const THREE = await import('three');
  // The floor and the wall, solid to props as well (they move like grenades).
  const SOLID = FLAG_PLAYER | FLAG_BULLET | FLAG_GRENADE;
  const BW = world([[[-2000, -2000, -64], [2000, 2000, 0], SOLID], [[500, -2000, 0], [564, 2000, 300], SOLID]]);
  const game = { collision: BW, scene: { add() {} }, sounds: { play() {} }, now: 0, frameNo: 0, lineOfSight: () => true };
  const make = (at) => new Balls(game, [{ mesh: new THREE.Object3D(), spawn: at, radius: 8, amb: { set() {} } }]);
  const run = (balls, secs) => { for (let i = 0; i < secs * 64; i++) { game.now += 1 / 64; balls.tick(1 / 64); } };
  const hull = [[-16, -16, 0], [16, 16, 72]];

  let balls = make([0, 600, 9]), b = balls.list[0];
  ok(near(b.spawn[2], 8.05, 0.01) && b.asleep, 'ball: settles onto the floor at its spot, at rest');
  run(balls, 1);
  ok(b.asleep && near(b.pos[0], 0, 1e-9) && near(b.pos[2], 8.05, 0.01), 'ball: stays put until something touches it');

  const back = balls.touch([-23, 600, 0], [250, 0, 0], ...hull);
  ok(!back && b.vel[0] > 250 && !b.asleep, 'ball: walking into it kicks it ahead, faster than you walk: ' + b.vel[0].toFixed(0));
  run(balls, 10);
  ok(b.asleep && b.pos[0] > 150 && near(b.pos[2], 8, 0.5) && Math.abs(b.pos[1] - 600) < 1, 'ball: rolls on along the floor and comes to rest: ' + b.pos.map((v) => v.toFixed(1)));

  balls = make([400, 800, 8]); b = balls.list[0];
  b.vel = [400, 0, 0]; balls.wake(b);
  let maxX = 0;
  for (let i = 0; i < 64; i++) { balls.tick(1 / 64); maxX = Math.max(maxX, b.pos[0]); }
  ok(maxX < 500 - 7 && b.vel[0] < 0, 'ball: bounces off a wall without going into it: ' + maxX.toFixed(1));

  balls = make([500 - 7.3, 1000, 8]); b = balls.list[0];
  const pinned = balls.touch([500 - 7.3 - 8 - 16 + 2, 1000, 0], [0, 0, 0], ...hull);
  ok(pinned && pinned[0] < -1.5, "ball: against a wall it can't get out of the way, so it holds you back: " + pinned?.map((v) => v.toFixed(2)));

  balls = make([0, 1200, 8]); b = balls.list[0];
  ok(!balls.shot([-100, 1220, 8], [1, 0, 0], 500, 300) && b.asleep, 'ball: a shot that misses leaves it be');
  ok(balls.shot([-100, 1200, 8], [1, 0, 0], 500, 300) && b.vel[0] > 250 && b.vel[2] > 0, 'ball: a shot knocks it along the bullet');
  balls.reset();
  ok(b.asleep && b.pos[0] === 0 && b.vel.every((v) => v === 0), 'ball: a new round puts it back on its spot, at rest');

  // A grenade moving 11 units a tick through where the ball is bounces off it (no tunnelling).
  const nade = { pos: [-4, 1200, 9], vel: [700, 0, 0] };
  ok(balls.bump(nade, [-15, 1200, 9]) && nade.vel[0] < 700 && b.vel[0] > 0 && Math.hypot(nade.pos[0] - b.pos[0], nade.pos[2] - b.pos[2]) >= 10, 'ball: a grenade bounces off it and knocks it');
  balls.reset();
  balls.blast([-60, 1200, 4], 350);
  ok(b.vel[0] > 500 && b.vel[2] > 100, 'ball: an HE next to it sends it flying');
}

// ---- the bots' upper body: bent to the aim from the animation's pose, never on top of last frame's bend --------------
{
  const THREE = await import('three');
  const { Bot } = await import('../src/js/play/bots.js');
  const chain = ['spine_0', 'spine_1', 'spine_2', 'spine_3'].map(() => new THREE.Bone());
  chain.reduce((parent, b) => (parent.add(b), b), new THREE.Group());
  const bot = { bones: { spine_1: chain[1], spine_2: chain[2], spine_3: chain[3] }, yaw: 30, bodyYaw: 0, pitch: 12 };
  const chest = () => chain[3].getWorldQuaternion(new THREE.Quaternion());
  // A still pose: the mixer only writes bones whose animated value changed, so on these frames it writes nothing.
  const frame = () => { Bot.prototype.unbendSpine.call(bot); Bot.prototype.bendSpine.call(bot); };
  frame();
  const once = chest();
  for (let i = 0; i < 30; i++) frame();
  ok(once.angleTo(chest()) < 1e-6, 'bots: the torso bend does not add up frame after frame (no spinning round)');
  const twist = 2 * Math.acos(Math.min(1, Math.abs(chest().w))) * 180 / Math.PI;
  bot.yaw = 170; frame();
  const big = 2 * Math.acos(Math.min(1, Math.abs(chest().w))) * 180 / Math.PI;
  ok(twist > 25 && big < 65, 'bots: the upper body turns with the aim, at most 60° from the legs: ' + twist.toFixed(0) + '°, ' + big.toFixed(0) + '°');
}

// ---- CS2's special inspects and draws: now and then, never twice in a row, cl_inspect_rare forcing them on or off --
{
  const { Arsenal } = await import('../src/js/play/weapons.js');
  const gun = { vm: { has: () => true } }, ars = { game: { cv: { cl_inspect_rare: 0 } } };
  let n = 0, twice = 0, prev = false;
  for (let i = 0; i < 9000; i++) { const r = Arsenal.prototype.rare.call(ars, gun, 'inspectRare'); n += r; if (r && prev) twice++; prev = r; }
  ok(n > 700 && n < 1100 && twice === 0, 'special inspects: about one in nine, never twice in a row: ' + n + ' in 9000');
  ars.game.cv.cl_inspect_rare = 1;
  const always = [0, 1, 2].every(() => Arsenal.prototype.rare.call(ars, gun, 'inspectRare'));
  ars.game.cv.cl_inspect_rare = -1;
  const never = [0, 1, 2].every(() => !Arsenal.prototype.rare.call(ars, gun, 'inspectRare'));
  ok(always && never && !Arsenal.prototype.rare.call({ game: { cv: { cl_inspect_rare: 1 } } }, { vm: { has: () => false } }, 'inspectRare'), 'special inspects: cl_inspect_rare 1 always, -1 never (and none for a weapon without one)');
}

// ---- CS2's binds: key names, older saves' keys, scroll jump, mouse buttons, console commands -------------------------
{
  const { Input, keyName, bindTable, DEFAULT_BINDS } = await import('../src/js/play/input.js');
  ok(['KeyW', 'Space', 'ControlLeft', 'Numpad1', 'F5', 'Digit3', 'Backquote'].map(keyName).join(' ') === 'w space ctrl kp_end f5 3 `', 'binds: CS2 key names');
  const old = bindTable({ binds: { jump: 'KeyJ' } });
  ok(old.j === '+jump' && !old.space && old.w === '+forward', "binds: an older save's keys carry over (jump on J instead of Space)");
  // An Input without the page's events: the binds, the held keys and the wheel.
  const make = (binds) => { const i = Object.create(Input.prototype); Object.assign(i, { keys: new Set(), pressed: new Set(), pulses: new Set(), buttons: 0, clicked: 0, wheel: 0 }); i.setBinds(binds); return i; };
  const inp = make({ ...DEFAULT_BINDS, mwheelup: '+jump', mwheeldown: '+jump', f1: 'say gg' });
  inp.notch('mwheeldown');
  const during = inp.held('jump'); inp.endTick();
  const after = inp.held('jump');
  inp.notch('mwheelup');
  ok(during && !after && inp.held('jump'), 'binds: a wheel notch on +jump is one tick of jump (press and release), so it bunny hops');
  inp.endTick();
  inp.down('space'); const sp = inp.held('jump'); inp.up('space');
  ok(sp && !inp.held('jump'), 'binds: space still holds +jump while it is down');
  inp.down('mouse1'); const fire = inp.buttons & 1; inp.up('mouse1');
  const cmds = []; inp.onCommand = (c) => cmds.push(c); inp.down('f1'); inp.down('b');
  ok(fire && !(inp.buttons & 1) && inp.takeClicked() & 1 && cmds.join() === 'say gg,buy', 'binds: mouse1 fires (+attack), F1 runs a console command (say gg), B the buy menu');
  // Scroll jumping: a notch every tick jumps again on every landing; holding the jump key jumps once.
  const hop = (jumpPress) => { const p = new PlayerMovement(W, [0, 1400, 0]); let n = 0; for (let i = 0; i < 64 * 3; i++) { const g0 = p.onGround; p.tick(1 / 64, { forward: 1, side: 0, yaw: 0, jump: true, jumpPress, maxSpeed: 250 }); if (g0 && p.velocity[2] > 250) n++; } return n; };
  const spun = hop(true), heldKey = hop(false);
  ok(spun >= 4 && heldKey === 1, `binds: scroll jumping bunny hops (${spun} jumps in 3 s), holding jump doesn't (${heldKey})`);
  const wheel = make(DEFAULT_BINDS); wheel.notch('mwheeldown'); wheel.notch('mwheeldown'); wheel.notch('mwheelup');
  ok(wheel.takeWheel() === 1 && !wheel.held('jump'), 'binds: by default the wheel changes weapon (invnext / invprev)');
}

// ---- nav links and what bots can climb ------------------------------------------------------------------------------
{
  const { NavMesh } = await import('../src/js/play/nav.js');
  // A floor (A, z 0) with a 16-unit step to the west (E), a 50-unit box to the east (B) and an 80-unit ledge to the
  // north (C). Corners go round each area; edge i runs from corner i to i+1 and lists the areas across it.
  const sq = (x0, y0, x1, y1, z) => [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]];
  const nav = new NavMesh({ areas: [
    { id: 1, flags: 0, c: sq(0, 0, 100, 100, 0), e: [[], [2], [3], [4]] },
    { id: 2, flags: 0, c: sq(100, 0, 200, 100, 50), e: [[], [], [], [1]] },
    { id: 3, flags: 0, c: sq(0, 100, 100, 200, 80), e: [[1], [], [], []] },
    { id: 4, flags: 0, c: sq(-100, 0, 0, 100, 16), e: [[], [1], [], []] },
  ] });
  const box = nav.path([50, 50, 0], [150, 50, 50]);
  ok(box && box.points.some((p) => p.jump > 40 && p.jump < 60), 'nav: onto a 50-unit box is a jump');
  const step = nav.path([50, 50, 0], [-50, 50, 16]);
  ok(step && !step.points.some((p) => p.jump), 'nav: up a 16-unit step is a walk');
  ok(nav.path([50, 50, 0], [50, 150, 80]) === null, "nav: an 80-unit ledge can't be climbed (higher than a crouch-jump)");
  ok(nav.path([50, 150, 80], [50, 50, 0]) !== null, 'nav: but you can drop down from it');
  ok(nav.groundAt(150, 50, 0) === null && nav.groundAt(150, 50, 0, 74) === 50 && nav.groundAt(50, 150, 0, 74) === null && nav.groundAt(-50, 50, 0) === 16,
    'nav: the ground a step (or a jump) up from where you are');
  // A crawl (a crouch-only area between two rooms): the way in and out of it says to crouch.
  const crawl = new NavMesh({ areas: [
    { id: 1, flags: 0, c: sq(0, 0, 100, 100, 0), e: [[], [2], [], []] },
    { id: 2, flags: 0x10000, c: sq(100, 30, 160, 70, 0), e: [[], [3], [], [1]] },
    { id: 3, flags: 0, c: sq(160, 0, 260, 100, 0), e: [[], [], [], [2]] },
  ] });
  const through = crawl.path([50, 50, 0], [210, 50, 0]);
  ok(through && through.points.filter((p) => p.crouch).length === 2 && !through.points[through.points.length - 1].crouch, 'nav: into and out of a crawl, the bot is told to crouch');
}

// Molotov fire: the flame flipbook and a fire's life.
{
  const a = flameAtlas(), W = a.width, CH = a.height / 4, CW = W / 8;
  let edges = 0, lit = 0;
  for (let cy = 0; cy < 4; cy++) for (let x = 0; x < W; x++) { // the root and tip rows hidden
    edges = Math.max(edges, a.data[((cy * CH) * W + x) * 4 + 1], a.data[((cy * CH + CH - 1) * W + x) * 4 + 1]);
  }
  for (let i = 0; i < a.data.length; i += 4) if (a.data[i] > 128) lit++;
  ok(edges < 16, 'fire: flipbook cells fade out at the root and the tip (no bleeding between frames)');
  ok(lit > W * a.height * 0.03 && lit < W * a.height * 0.4, 'fire: flipbook frames have flames in them (' + (lit / (W * a.height) * 100).toFixed(1) + '% hot)');
  const diff = (f0, f1) => { let d = 0; for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
    const p = (fy, fx) => a.data[(((Math.floor(fy / 8) * CH) + y) * W + (fy % 8) * CW + x) * 4];
    d += Math.abs(p(f0, 0) - p(f1, 0)); } return d / (CW * CH); };
  ok(diff(31, 0) < diff(0, 16) * 0.6, 'fire: the flipbook loops (last frame runs into the first)');
  const art = { flames: null, puff: null, material: FireArt.prototype.material };
  const spots = Array.from({ length: 40 }, (_, i) => [Math.cos(i) * 2, 0, Math.sin(i) * 2, i / 40]);
  const fire = new GroundFire(art, new THREE.Vector3(), spots, 7, 100);
  ok(fire.obj.children.length === 5 && fire.obj.children[0].geometry.instanceCount === 40, 'fire: flames, scorch, glow, embers and smoke, one draw each');
  ok(fire.level(100) === 0 && fire.level(103) === 1 && fire.level(107) === 0, 'fire: catches, burns, dies down');
  fire.update(103);
  ok(fire.u.uAge.value === 3 && fire.u.uRemain.value === 4, 'fire: shaders get its age and time left');
  fire.dispose();
}

// Moving solids (doors, breakable glass) in the collision world, and the map export's entity helpers.
{
  const w = world([[[-2000, -2000, -64], [2000, 2000, 0]]]);
  const door = w.addDynamic({ tris: new Float32Array(boxTris([100, -40, 0], [104, 40, 90]).flat(2)), flags: FLAG_PLAYER | FLAG_BULLET, surface: 'wood' });
  const shot = w.raycast([0, 0, 40], [1, 0, 0], 500, FLAG_BULLET);
  ok(shot && near(shot.t, 100, 0.01) && shot.shape === door && shot.surface === 'wood', 'collision: a moving solid stops a bullet and says which it is');
  const walk = w.traceBox([0, 0, 1], [200, 0, 1], [-16, -16, 0], [16, 16, 72], FLAG_PLAYER);
  ok(walk.fraction < 1 && walk.endpos[0] < 84.1 && walk.endpos[0] > 83, 'collision: and a player walking into it');
  door.off = true;
  ok(!w.raycast([0, 0, 40], [1, 0, 0], 500, FLAG_BULLET) && w.traceBox([0, 0, 1], [200, 0, 1], [-16, -16, 0], [16, 16, 72], FLAG_PLAYER).fraction === 1, 'collision: gone once switched off (broken glass, an open way)');
  const play = (await import('../cs2/play.cjs')).default;
  const m = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, y * 0.0254, z * 0.0254, x * 0.0254, 1]; // game (x, y, z) -> glTF translation
  const json = { nodes: [
    { name: 'brush_blocker_2_1.hammer_mesh_0' }, { name: 'fence_gate.fence_gate_body', matrix: m(100, 200, 0) },
    { name: 'fence_gate.fence_gate_body', matrix: m(500, 200, 0) }, { name: 'door_metal.door_body', matrix: m(0, 0, 0) }, { name: 'wall_1.hammer_mesh_0' } ] };
  const ents = [
    { classname: 'func_brush', startdisabled: 'true', model: 'resource_name:"maps/x/entities/brush_blocker_2_1.vmdl"' },
    { classname: 'prop_dynamic', startdisabled: 'true', model: 'resource_name:"models/props/fence_gate.vmdl"', origin: '[ 100.0, 200.0, 0.0 ]' },
    { classname: 'prop_door_rotating', model: 'resource_name:"models/props/door_metal.vmdl"', origin: '[ 0.0, 0.0, 0.0 ]', distance: '89', speed: '200', opendir: '0', returndelay: '-1', soundopenoverride: 'Door.Open' },
  ];
  ok(JSON.stringify(play.disabledNodes(json, ents)) === '[0,1]', 'map export: entities that start switched off (a Wingman blocker, one of two fence gates) are found by model and origin');
  const doors = play.doorNodes(json, ents);
  ok(doors.length === 1 && doors[0].nodes[0] === 3 && doors[0].distance === 89 && doors[0].away && doors[0].wait === -1 && doors[0].sounds.open === 'Door.Open', 'map export: a prop door, its hinge, swing and sounds');
  const bjson = { nodes: [{ name: 'pane_1.hammer_mesh_0' }, { name: 'nuke_vent_breakable_c', matrix: m(50, 60, 70) }, { name: 'nuke_vent_breakable_c.body' }, { name: 'wine_bottle_breakable', matrix: m(5, 5, 5) }, { name: 'crate_1', matrix: m(9, 9, 9) }] };
  const breaks = play.glassNodes(bjson, [
    { classname: 'func_breakable', material: '0', model: 'resource_name:"maps/x/entities/pane_1.vmdl"' },
    { classname: 'func_breakable', material: '1', model: 'resource_name:"maps/x/entities/pane_1.vmdl"' }, // wood: not glass
    { classname: 'prop_dynamic', model: 'resource_name:"models/nuke_vent_breakable_c.vmdl"', origin: '[ 50.0, 60.0, 70.0 ]' },
    { classname: 'prop_physics_multiplayer', model: 'resource_name:"models/wine_bottle_breakable.vmdl"', origin: '[ 5.0, 5.0, 5.0 ]' },
    { classname: 'prop_dynamic', model: 'resource_name:"models/crate_1.vmdl"', origin: '[ 9.0, 9.0, 9.0 ]' }, // not a breakable model
  ]);
  ok(breaks.length === 3 && breaks[0].surface === 'glass' && breaks[0].solid && JSON.stringify(breaks[1].nodes) === '[1]' && breaks[1].surface === 'metalvent' && breaks[1].solid
    && breaks[2].surface === 'glassbottle' && breaks[2].sound === 'GlassBottle.Break' && !breaks[2].solid, 'map export: breakable glass and props (a vent cover stops players, a bottle only bullets)');
  // Mirage: sheet metal vent covers breakable by name, and the shutter's frame shown once it breaks.
  const mjson = { nodes: [{ name: 'wall_hole_cover_sheetmetal', matrix: m(-1336, -974, -132) }, { name: 'shutter_window_l_breakable', matrix: m(-1919, -270, -72) },
    { name: 'shutter_window_l_remainder', matrix: m(-1888, -276, -72) }, { name: 'shutter_window_r_remainder', matrix: m(-1952, -276, -72) }] };
  const mirage = play.glassNodes(mjson, [
    { classname: 'prop_dynamic', targetname: '[PR#]prop.breakable.01', model: 'resource_name:"models/props/de_mirage/wall_hole_cover_sheetmetal.vmdl"', origin: '[ -1336.0, -974.0, -132.0 ]' },
    { classname: 'prop_dynamic', model: 'resource_name:"models/props/de_mirage/shutter_window_l_breakable.vmdl"', origin: '[ -1919.0, -270.0, -72.0 ]' },
    { classname: 'prop_dynamic', startdisabled: 'true', model: 'resource_name:"models/props/de_mirage/shutter_window_l_remainder.vmdl"', origin: '[ -1888.0, -276.0, -72.0 ]' },
    { classname: 'prop_dynamic', startdisabled: 'true', model: 'resource_name:"models/props/de_mirage/shutter_window_r_remainder.vmdl"', origin: '[ -1952.0, -276.0, -72.0 ]' },
  ]);
  ok(mirage.length === 2 && mirage[0].surface === 'metalvent' && mirage[0].solid && mirage[1].surface === 'wood' && JSON.stringify(mirage[1].remainder) === '[2,3]',
    "map export: Mirage's vent covers (breakable by name) and the shutter, its frame left when it breaks");
  const impacts = play.surfaceImpacts('{ surfacePropertyName = "brass_bell_large" audiosounds = { bulletimpact = "inferno.bell_c" } }, { surfacePropertyName = "Glass" audiosounds = { bulletimpact = "Glass.BulletImpact" } }');
  ok(impacts.brass_bell_large === 'inferno.bell_c' && impacts.glass === 'Glass.BulletImpact', "map export: every surface's bullet impact sound (Inferno's bells)");
}

// ---- grenade flight (flight.js): how the game, the bots and the lineup finder all fly grenades -----------------------
{
  const { throwVelocity, simulateFlight, FUSE } = await import('../src/js/play/flight.js');
  const ALL = FLAG_PLAYER | FLAG_BULLET | FLAG_GRENADE;
  const G = world([[[-4000, -4000, -64], [4000, 4000, 0], ALL], [[1500, -500, 0], [1540, 500, 400], ALL]]);
  const s = simulateFlight(G, [0, 0, 64], throwVelocity(-30, 0, 1), 'smoke');
  ok(s && near(s.pos[2], 2, 3) && s.time >= FUSE.smoke && s.landed, 'flight: a smoke lands, comes to rest on the floor and goes off after its fuse');
  const w = simulateFlight(G, [1000, 0, 64], throwVelocity(0, 0, 1), 'smoke');
  ok(w && w.pos[0] < 1500, 'flight: off a wall it bounces back to this side');
  const fl = simulateFlight(G, [0, 0, 64], throwVelocity(-45, 0, 1), 'flash');
  ok(fl && near(fl.time, FUSE.flash, 1 / 64 + 1e-9) && fl.pos[2] > 50, 'flight: a flashbang bursts in the air on its fuse');
  const mo = simulateFlight(G, [0, 0, 64], throwVelocity(-10, 0, 1), 'fire');
  ok(mo && mo.landed && near(mo.pos[2], 2, 3) && mo.time < FUSE.fire, 'flight: a molotov breaks where it first hits the floor');
  ok(throwVelocity(0, 90, 1, [0, 0, 301.993])[2] > 300, 'flight: a jump-throw carries the jump up');
}

// ---- bots: skill by rank, CS Ratings, who they are -------------------------------------------------------------------
{
  const K = await import('../src/js/play/skill.js');
  const silver = K.skillParams(0), ge = K.skillParams(1);
  ok(silver.reaction[0] > ge.reaction[0] * 3 && silver.aimErr > ge.aimErr * 3 && silver.utility < 0.2 && ge.utility > 0.9 && silver.strafe > ge.strafe * 5 && silver.crosshair > ge.crosshair * 10,
    "skill: Silvers react slower, aim worse, rarely throw utility, counter-strafe late and look at the floor; Global Elites don't");
  ok([1, 6, 7, 10, 11, 14, 15, 17, 18].every((g) => K.groupOfSkill(K.skillOfGroup(g)) === g), 'skill: skill groups and skill map back and forth');
  const band = (g) => K.ratingOfSkill(K.skillOfGroup(g));
  ok(band(1) <= 1000 && band(6) < 5000 && band(7) > 5000 && band(10) < 10000 && band(11) > 10000 && band(14) < 15000 && band(18) >= 29000,
    'skill: CS Ratings by rank (Silvers under 5,000, Gold Novas 5-10k, Master Guardians 10-15k, Global Elites about 30k)');
  ok(Math.abs(K.skillOfRating(K.ratingOfSkill(0.6)) - 0.6) < 1e-6, 'skill: a CS Rating maps back to the skill');
  {
    // Bots know their guns: an AK-47's spray at range, a run, an unscoped AWP.
    const { inaccuracyOf, hitOdds } = await import('../src/js/play/ai.js');
    const ak = { maxSpeed: [215, 215], inaccStand: [0.00641, 0.00641], inaccCrouch: [0.00481, 0.00481], inaccMove: [0.17506, 0.17506], spread: [0.0006, 0.0006], inaccJump: [0.4, 0.4] };
    const awp = { maxSpeed: [200, 100], inaccStand: [0.0808, 0.002], inaccCrouch: [0.0606, 0.0015], inaccMove: [0.17648, 0.17648], spread: [0.0002, 0.0002] };
    const at = (d) => 8 / d, odds = (st, m, s, d, o) => hitOdds(at(d), inaccuracyOf(st, m, s), { spread: st.spread[m], ...o });
    ok(odds(ak, 0, {}, 2000) > 0.5 && odds(ak, 0, { penalty: 0.0078 * 3 }, 2000) < 0.2 && odds(ak, 0, { speed: 215 }, 1000) < 0.05 && odds(ak, 0, { speed: 60 }, 1000) > 0.95,
      'bots: an AK-47 lands its first shot at 2000 units, not a three-bullet spray there or on the run');
    ok(odds(ak, 0, { penalty: 0.0078 * 5 }, 250) > 0.6 && odds(ak, 0, { penalty: 0.0078 * 5 }, 250, { recoil: 0.04 }) === 0,
      "bots: up close a spray still lands, unless the recoil isn't pulled down");
    ok(odds(awp, 0, {}, 1500) < 0.1 && odds(awp, 1, {}, 1500) > 0.99 && odds(awp, 1, { speed: 100 }, 1500) < 0.1, 'bots: an AWP hits scoped and stopped');
    ok(silver.discipline < 0.1 && ge.discipline > 0.99, 'skill: Global Elites wait for their shot, Silvers fire anyway');
  }
  ok(K.tierOf('expert') === 'global' && K.tierOf('easy') === 'silver' && K.tierOf('mg') === 'mg' && K.TO_DIFFICULTY.supreme === 'expert', 'skill: the old difficulty settings map to rank tiers');
  let lo = 1, hi = 0;
  for (let i = 0; i < 200; i++) { const s2 = K.botSkill('x' + i, 'gold'); lo = Math.min(lo, s2); hi = Math.max(hi, s2); }
  ok(K.groupOfSkill(lo) >= 6 && K.groupOfSkill(hi) <= 11, "skill: a tier's bots are its ranks, one either side now and then");
  const { pickIdentities } = await import('../src/js/play/identity.js');
  const list = Array.from({ length: 30 }, (_, i) => ({ id: 'p' + i, name: 'P' + i }));
  const picked = pickIdentities(list, 9);
  ok(picked.length === 9 && new Set(picked.map((x) => x.id)).size === 9 && pickIdentities(list.slice(0, 4), 9).length === 4, "identity: a match's bots are different players");
}

// ---- the lineups (src/data/lineups.json) still land on today's maps (those exported in the cache) ---------------------
{
  const fs = (await import('node:fs')).default, path = (await import('node:path')).default;
  const { landing } = await import('../src/js/play/utility.js');
  const cache = process.env.CS2SIM_CACHE || path.join(process.env.APPDATA || '', 'CS2 Case Simulator', 'cs2cache');
  const file = new URL('../src/data/lineups.json', import.meta.url);
  const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  for (const [map, list] of Object.entries(all)) {
    const dir = path.join(cache, 'play', map);
    if (!fs.existsSync(path.join(dir, 'collision.bin'))) continue;
    const info = JSON.parse(fs.readFileSync(path.join(dir, 'map.json'), 'utf8')), buf = fs.readFileSync(path.join(dir, 'collision.bin'));
    const col = new CollisionWorld(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), info.collision);
    const off = list.map((l) => { const r = landing(col, l); return r ? Math.hypot(r.pos[0] - l.land[0], r.pos[1] - l.land[1], r.pos[2] - l.land[2]) : Infinity; });
    ok(list.length && off.every((d) => d < 2), 'lineups: every ' + map + ' lineup lands where it was found (' + list.length + ')');
  }
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
