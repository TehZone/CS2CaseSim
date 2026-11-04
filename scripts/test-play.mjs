// Play mode physics tests on synthetic geometry: collision traces and Source-style movement (walking, walls, steps,
// jumping, crouch-jumping onto a ledge, falling).
//   node scripts/test-play.mjs
import { CollisionWorld, FLAG_PLAYER, FLAG_BULLET, FLAG_GRENADE } from '../src/js/play/collision.js';
import { PlayerMovement, MOVE } from '../src/js/play/movement.js';
import { Game } from '../src/js/play/game.js';
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
{
  const q = run(new PlayerMovement(W, [0, 1600, 0]), 1, { jump: true, jumpPress: true });
  let top = 0;
  for (let i = 0; i < 64; i++) { run(q, 1, { jump: true, duck: true }); top = Math.max(top, q.origin[2]); }
  ok(near(top, 66, 0.6), "a crouch-jump lifts the feet 66 (CS2's), short of a standing player's 72: " + top.toFixed(1));
}
// Other players are solid, and walking into one isn't a ladder: on a map with ladders (found by their surface), a trace
// for ladders went by the players too, and you climbed a bot you walked into.
{
  const LW = world([[[-2000, -2000, -64], [2000, 2000, 0]]]);
  LW.ladders = new Set([1]); // a map with ladders (none here)
  const me = { alive: true }, bot = { alive: true }, b = { pos: [0, 0, 0], ducked: false };
  const g = { collision: LW, combatants: [me, bot], me, botOf: () => b, traceBodies: Game.prototype.traceBodies };
  const walkInto = (cmd = () => ({})) => {
    g.player = new PlayerMovement(Game.prototype.bodyWorld.call(g, () => me), [-100, 0, 0]);
    let stood = 0; // the highest it stood
    for (let i = 0; i < 64 * 3; i++) { run(g.player, 1, { forward: 1, ...cmd(i, g.player) }); if (g.player.onGround) stood = Math.max(stood, g.player.origin[2]); }
    return stood;
  };
  ok(walkInto() < 1 && near(g.player.origin[0], -32, 0.1) && !g.player.onLadder, 'walking into a player stops at them, without climbing them: ' + g.player.origin.map((v) => v.toFixed(1)));
  const cjump = (i, p) => ({ jump: true, jumpPress: p.onGround, duck: !p.onGround });
  ok(walkInto(cjump) < 1, "crouch-jumping at a standing player doesn't get onto their head");
  b.ducked = true;
  ok(near(walkInto(cjump), 54, 0.1), "a crouching one's it does");
}
// crouch speed
p = new PlayerMovement(W, [0, 900, 0]);
run(p, 128, { forward: 1, yaw: 0, duck: true });
ok(near(p.speed2d(), 250 * MOVE.duckScale, 1), 'crouch walking speed: ' + p.speed2d().toFixed(1));
run(p, 10, { forward: 0 });
p.tick(1 / 64, { forward: 0, side: 0, yaw: 0, maxSpeed: 250 });
run(p, 30, {});
ok(!p.ducked, 'stands up again');
// letting go of crouch in the air just above a box: the legs can't drop into it, so you stand in place, land on it
// and walk on (they dropped into it before and you were stuck)
{
  const B = world([[[-2000, -2000, -64], [2000, 2000, 0]], [[1500, 1500, 0], [1600, 1600, 48]]]);
  const q = new PlayerMovement(B, [1550, 1550, 60]);
  q.ducked = true; q.duckAmount = 1; q.onGround = false; q.velocity = [0, 0, -50];
  q.origin = [1550, 1550, 52]; // feet 4 units over the box
  q.tick(1 / 64, { forward: 0, side: 0, yaw: 0, maxSpeed: 250 }); // (crouch let go)
  const legsIn = q.origin[2] < 48 - 0.5;
  run(q, 32, {});
  const landed = q.onGround && near(q.origin[2], 48, 0.5);
  run(q, 64, { forward: 1, yaw: 0 });
  ok(!legsIn && landed && q.origin[0] > 1620, `letting go of crouch just over a box doesn't sink the legs into it: lands on it and walks off (z ${q.origin[2].toFixed(1)}, x ${q.origin[0].toFixed(0)})`);
}
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
// leaving the match: a technical timeout holds the next freeze time (once), you never carry the bomb while you're gone
{
  const g = fakeGame(), m = new Match(g, SHORT_RULES);
  g.combatants.forEach((c) => { c.team = c === g.me || c.name === 'ct2' ? 'T' : 'CT'; });
  g.me.away = true;
  let mine = 0;
  for (let i = 0; i < 40; i++) { m.round = 0; m.startRound(); if (g.me.hasC4) mine++; }
  m.tick(SHORT_RULES.freeze + 0.01);
  m.techTimeout(120);
  const pending = m.timeout?.pending;
  m.endRound('CT', 'time'); m.tick(SHORT_RULES.endDelay + 0.01);
  m.tick(60);
  const held = m.phase === 'freeze' && near(m.time, SHORT_RULES.freeze, 1e-6) && m.timeout?.left > 0;
  m.tick(61); m.tick(SHORT_RULES.freeze - 0.5);
  ok(mine === 0 && pending && held && m.phase === 'freeze' && !m.timeout, `left the match: never the bomb carrier (${mine}), the next freeze time held 2 minutes, then counted down`);
  m.tick(1);
  ok(m.phase === 'live', 'after the technical timeout the round starts');
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

// ---- the bots' locomotion: clips at weight 0 stopped, started again in step: the same pose as all 16 playing --------
{
  const THREE = await import('three');
  const { Bot } = await import('../src/js/play/bots.js');
  // A clip per path, each its own length, swinging the hip its own way. (About one axis: three blends three or more
  // clips' rotations in the order they play, which stopping and starting them changes, a little, unless they share one.)
  const clips = new Map(), axis = new THREE.Vector3(0, 1, 0);
  const clipFor = (path) => {
    if (!clips.has(path)) {
      let h = 0;
      for (const ch of path) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      const dur = 0.6 + (h % 1000) / 700, amp = 0.3 + (h % 7) / 10, phase = (h % 13) / 2, times = [], values = [];
      for (let i = 0; i <= 24; i++) { const t = (i / 24) * dur; times.push(t); values.push(...new THREE.Quaternion().setFromAxisAngle(axis, Math.sin((i / 24) * Math.PI * 2 + phase) * amp).toArray()); }
      clips.set(path, new THREE.AnimationClip(path, dur, [new THREE.QuaternionKeyframeTrack('hip.quaternion', times, values)]));
    }
    return clips.get(path);
  };
  const rig = () => { const root = new THREE.Group(), hip = new THREE.Bone(); hip.name = 'hip'; root.add(hip); return { root, hip }; };
  const mine = rig(), ref = rig();
  const bot = Object.assign(Object.create(Bot.prototype), { assets: { clips: new Proxy({}, { get: (_, p) => clipFor(p) }) }, mixer: new THREE.AnimationMixer(mine.root),
    mode: 'move', time: 0, yaw: 0, bodyYaw: 0, pitch: 0, vel: [0, 0, 0], ducked: false, climbing: null, airborne: false, bones: {}, gestureAction: null, armsAction: null });
  Bot.prototype.setLocomotion.call(bot, 'rifle');
  // The reference: every clip playing all along, its weight set each frame (as it was).
  const mixer = new THREE.AnimationMixer(ref.root), act = (p) => { const a = mixer.clipAction(clipFor(p)); a.setLoop(THREE.LoopRepeat, Infinity); a.setEffectiveWeight(0); a.play(); return a; };
  const P = (x) => `rifle/_default_rifle/${x}_rifle`, R = { idle: act(P('idle')), crouchIdle: act(P('idle_crouch')), air: act(P('inair_stand')), ladder: act(P('ladder_facing_slow')) };
  for (const g of ['run', 'walk', 'crouch']) R[g] = ['n', 'e', 's', 'w'].map((d) => act(P(`${g}_${d}`)));
  const all = [R.idle, R.crouchIdle, R.air, R.ladder, ...R.run, ...R.walk, ...R.crouch];
  let worst = 0, late = 0, stopped = 0, frames = 0, seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let f = 0; f < 3000; f++) {
    const dt = f % 3 === 0 ? 3 / 144 : 1 / 144; // (an out-of-view bot's three frames at once now and then)
    if (f % 40 === 0) { const sp = rnd() < 0.2 ? 0 : rnd() * 260, dir = rnd() * Math.PI * 2; bot.vel = [Math.cos(dir) * sp, Math.sin(dir) * sp, 0]; bot.ducked = rnd() < 0.2; bot.yaw = rnd() * 360 - 180; }
    bot.airborne = f % 700 > 650; bot.mode = f % 1100 > 1020 ? 'plant' : 'move';
    Bot.prototype.animate.call(bot, dt);
    // The weights the reference gives them (animate's, from where the body faces after this frame's turn).
    const yr = (bot.bodyYaw * Math.PI) / 180, vf = bot.vel[0] * Math.cos(yr) + bot.vel[1] * Math.sin(yr), vr = bot.vel[0] * Math.sin(yr) - bot.vel[1] * Math.cos(yr);
    const speed = Math.hypot(vf, vr), move = Math.min(1, speed / 60), run = bot.ducked ? 0 : Math.min(1, Math.max(0, (speed - 120) / 70));
    const gw = { crouch: bot.ducked ? 1 : 0, run, walk: bot.ducked ? 0 : 1 - run }, a = Math.atan2(vr, vf);
    const w = [Math.max(0, Math.cos(a)), Math.max(0, Math.sin(a)), Math.max(0, -Math.cos(a)), Math.max(0, -Math.sin(a))], sum = w.reduce((s, x) => s + x, 0) || 1;
    if (bot.mode === 'plant') for (const x of all) x.setEffectiveWeight(0);
    else if (bot.airborne) for (const x of all) x.setEffectiveWeight(x === R.air ? 1 : 0);
    else {
      for (const g of ['run', 'walk', 'crouch']) R[g].forEach((x, i) => { x.setEffectiveWeight(gw[g] * (w[i] / sum) * move); x.timeScale = Math.max(0.4, speed / (g === 'run' ? 230 : g === 'walk' ? 120 : 85)); });
      R.idle.setEffectiveWeight(bot.ducked ? 0 : 1 - move); R.crouchIdle.setEffectiveWeight(bot.ducked ? 1 - move : 0); R.air.setEffectiveWeight(0); R.ladder.setEffectiveWeight(0);
    }
    mixer.update(dt);
    worst = Math.max(worst, mine.hip.quaternion.angleTo(ref.hip.quaternion));
    // Each clip that's playing where the reference's is in it.
    for (const x of bot.loco.all) {
      if (!x.isScheduled()) continue;
      const d = Math.abs(x.time - mixer.existingAction(x.getClip()).time), dur = x.getClip().duration;
      late = Math.max(late, Math.min(d, dur - d));
    }
    stopped += bot.loco.all.filter((x) => !x.isScheduled()).length; frames++;
  }
  ok(late < 1e-6, `bots: a locomotion clip started again is where it would have been playing all along (worst ${late.toExponential(1)} s)`);
  ok(worst < 2e-3, `bots: stopping the locomotion clips at weight 0 leaves the pose as it was (worst ${worst.toExponential(1)} rad: three's blending order)`);
  ok(stopped / frames > 10, `bots: most of the 16 locomotion clips are stopped at any time (${(stopped / frames).toFixed(1)} a frame)`);
}

// ---- bones' keyframes worked out in place (keyframes.js): exactly three's numbers --------------------------------
{
  const THREE = await import('three');
  const original = THREE.Interpolant.prototype.evaluate;
  const { quietKeyframes } = await import('../src/js/play/keyframes.js');
  quietKeyframes();
  let seed = 11, same = true, calls = 0;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 40 && same; k++) {
    const n = 2 + Math.floor(rnd() * 30), times = [0];
    for (let i = 1; i < n; i++) times.push(times[i - 1] + 0.01 + rnd() * 0.2);
    const q = [], p = [];
    for (let i = 0; i < n; i++) {
      q.push(...new THREE.Quaternion().setFromEuler(new THREE.Euler(rnd() * 6 - 3, rnd() * 6 - 3, rnd() * 6 - 3)).toArray());
      if (i % 5 === 3) q.splice(-4, 4, ...q.slice(-8, -4)); // (the same rotation twice: three's shortcut)
      p.push(rnd(), rnd() * 10, -rnd());
    }
    for (const track of [new THREE.QuaternionKeyframeTrack('b.quaternion', times, q), new THREE.VectorKeyframeTrack('b.position', times, p)]) {
      const mine = track.createInterpolant(), theirs = track.createInterpolant(), end = times[n - 1];
      let t = -0.05;
      for (let step = 0; step < 400 && same; step++) {
        t = step % 97 === 0 ? rnd() * end * 1.2 - 0.05 : t + rnd() * 0.03; // (on, now and then a jump: past the end, before the start)
        if (t > end + 0.05) t -= end; // (looping)
        const a = Array.from(mine.evaluate(t)), b = Array.from(original.call(theirs, t));
        calls++; if (a.join() !== b.join()) same = false;
      }
    }
  }
  ok(same, `animation: keyframes worked out in place give exactly three's numbers (${calls} times)`);
}

// ---- what's drawn, sorted in place with comparisons that make nothing: the same order as three's own sort ----------
{
  const { quietSorting } = await import('../src/js/play/drawsort.js');
  // three's (r186) painterSortStable and reversePainterSortStable, which return differences.
  const painter = (a, b) => (a.groupOrder !== b.groupOrder ? a.groupOrder - b.groupOrder : a.renderOrder !== b.renderOrder ? a.renderOrder - b.renderOrder
    : a.material.id !== b.material.id ? a.material.id - b.material.id : a.materialVariant !== b.materialVariant ? a.materialVariant - b.materialVariant : a.z !== b.z ? a.z - b.z : a.id - b.id);
  const reverse = (a, b) => (a.groupOrder !== b.groupOrder ? a.groupOrder - b.groupOrder : a.renderOrder !== b.renderOrder ? a.renderOrder - b.renderOrder : a.z !== b.z ? b.z - a.z : a.id - b.id);
  const list = { opaque: [], transmissive: [], transparent: [] }, sorts = {};
  quietSorting({ setOpaqueSort: (f) => { sorts.opaque = f; }, setTransparentSort: (f) => { sorts.transparent = f; }, renderLists: { get: () => list } }, [{}]);
  let seed = 3, same = true;
  const rnd = (n) => ((seed = (seed * 16807) % 2147483647) % n);
  for (let round = 0; round < 200 && same; round++) {
    const items = Array.from({ length: 1 + rnd(160) }, (_, id) => ({ id, groupOrder: rnd(3) ? 0 : rnd(3), renderOrder: rnd(4) ? 0 : rnd(5) - 2, material: { id: rnd(30) },
      materialVariant: rnd(5) ? 0 : 1, z: rnd(6) ? rnd(1000) / 997 : 0.5 }));
    for (const [mine, theirs] of [[sorts.opaque, painter], [sorts.transparent, reverse]]) {
      list.opaque.length = 0; list.opaque.push(...items.slice().reverse());
      const want = items.slice().reverse().sort(theirs).map((x) => x.id).join();
      if (list.opaque.sort(mine).map((x) => x.id).join() !== want) same = false;
    }
  }
  ok(same, 'drawing: the render lists sorted in place come out in three\'s own order');
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

// ---- a new round tops up the guns you kept: full magazine and reserve, a reload cut short, the Zeus charged ------------
{
  const { Gun, refillAmmo } = await import('../src/js/play/weapons.js');
  const recoil = { recoilSeed: 1, recoilAngle: [0, 0], recoilAngleVariance: [0, 0], recoilMagnitude: [0, 0], recoilMagnitudeVariance: [0, 0] };
  const make = (id, stats) => new Gun({ slot: 'x', id, name: id, stats: { ...recoil, ...stats }, vm: null });
  const ak = make('weapon_ak47', { clip: 30, reserve: 90 });
  ak.clip = 4; ak.reserve = 11; ak.reloading = true; ak.reloadEnd = 99;
  const nova = make('weapon_nova', { clip: 8, reserve: 32, bulletsPerReload: 1 });
  nova.clip = 2; nova.reserve = 0; nova.reloading = true; nova.shellReload = true;
  const zeus = make('weapon_taser', { clip: 1, reserve: 0, type: 'WEAPONTYPE_TASER' });
  zeus.clip = 0; zeus.rechargeAt = 50;
  const knife = make('weapon_knife', { melee: true });
  for (const g of [ak, nova, zeus, knife]) refillAmmo(g);
  ok(ak.clip === 30 && ak.reserve === 90 && !ak.reloading && nova.clip === 8 && nova.reserve === 32 && !nova.shellReload
    && zeus.clip === 1 && zeus.rechargeAt === 0 && knife.clip === undefined, 'round start: kept guns get a full magazine and reserve, reloads stop, the Zeus is charged');
}

// ---- a sniper rifle put away is unscoped: drawn again it's at 1×, even switched from between the AWP's shots -------------
{
  const { Arsenal, Gun, refillAmmo } = await import('../src/js/play/weapons.js');
  const base = { recoilSeed: 1, recoilAngle: [0, 0], recoilAngleVariance: [0, 0], recoilMagnitude: [0, 0], recoilMagnitudeVariance: [0, 0],
    recoveryStart: 0, recoveryEnd: 1, recoveryStand: 0.3, recoveryStandFinal: 0.3, cycle: [0.2, 0.2], deploy: 1, clip: 5, reserve: 30 };
  const vm = { play: () => 0.5, has: () => false, role: 'idle', rig: {} };
  const awp = new Gun({ slot: 'primary', id: 'weapon_awp', name: 'AWP', stats: { ...base, type: 'WEAPONTYPE_SNIPER_RIFLE', zoomLevels: 2, unzoomsAfterShot: true, cycle: [1.45, 1.45], maxSpeed: [200, 100] }, vm });
  const scar = new Gun({ slot: 'primary', id: 'weapon_scar20', name: 'SCAR-20', stats: { ...base, type: 'WEAPONTYPE_SNIPER_RIFLE', zoomLevels: 2, maxSpeed: [215, 120] }, vm });
  const usp = new Gun({ slot: 'secondary', id: 'weapon_usp_silencer', name: 'USP-S', stats: { ...base, maxSpeed: [240, 240] }, vm });
  const game = { player: { ducked: false }, me: { alive: true }, cv: {}, canAttack: () => true, emit() {} };
  const input = { buttons: 0, takePressed: () => new Set(), takeClicked: () => 0, takeWheel: () => 0 };
  const ars = new Arsenal(game, {});
  ars.give('secondary', usp, 0, false); ars.give('primary', awp, 0);
  // Fired scoped: unscoped through the bolt, scoped again once it's done (as shoot() leaves it).
  const shot = (t) => { awp.zoom = 0; awp.resumeZoom = 1; awp.nextAttack = t + 1.45; };
  shot(2); ars.tick(0.016, 4, input);
  const held = awp.zoom === 1;
  shot(5); ars.select('secondary', 5.3); ars.select('primary', 5.6); ars.tick(0.016, 8, input);
  const quick = awp.zoom === 0 && ars.maxSpeed() === 200;
  awp.zoom = 2; ars.select('secondary', 9); const away = awp.zoom === 0; ars.select('primary', 9.5); ars.tick(0.016, 11, input);
  ars.give('primary', scar, 12); scar.zoom = 1; ars.select('secondary', 12.5); ars.select('primary', 13); ars.tick(0.016, 15, input);
  ok(held && quick && away && awp.zoom === 0 && scar.zoom === 0, 'sniper scope: a switch unscopes it, and it stays at 1× when drawn again, even switched from mid-bolt');
  awp.zoom = 1; awp.resumeZoom = 1; refillAmmo(awp);
  ok(awp.zoom === 0 && awp.resumeZoom === 0, 'sniper scope: a new round draws it unscoped');
}

// ---- viewmodel animations blend in from where the viewmodel is (CS2's): an inspect pressed again, a reload during one --
{
  const { clipPlayer } = await import('../src/js/play/viewmodel.js');
  const root = new THREE.Object3D(), hand = new THREE.Object3D(), mag = new THREE.Object3D();
  hand.name = 'hand'; mag.name = 'mag'; root.add(hand, mag);
  const track = (n, xs) => new THREE.VectorKeyframeTrack(n + '.position', [0, 1, 2], xs.flatMap((x) => [x, 0, 0]));
  const vm = clipPlayer(root, {
    idle: [new THREE.AnimationClip('idle', 2, [track('hand', [0, 0, 0])])],
    inspect: [new THREE.AnimationClip('inspect', 2, [track('hand', [0, 10, 20])])],
    reload: [new THREE.AnimationClip('reload', 2, [track('mag', [0, -5, -10])])],
  });
  const steps = (n) => { for (let i = 0; i < n; i++) vm.update(0.01); };
  vm.play('idle', { loop: true }); vm.update(0);
  vm.play('inspect', { fade: 0.2 }); steps(100);
  const mid = hand.position.x; // a second in: 10
  vm.play('inspect', { fade: 0.2 });
  const held = hand.position.x; steps(1);
  const next = hand.position.x; steps(30);
  const after = hand.position.x; // 0.31 s into the new one: 3.1
  ok(Math.abs(mid - 10) < 0.01 && held === mid && next > 9.9 && Math.abs(after - 3.1) < 0.01,
    `viewmodel: an inspect pressed again starts over from where it was, blended, not snapped to its start (${mid.toFixed(2)}, ${next.toFixed(2)}, ${after.toFixed(2)})`);
  steps(69);
  vm.play('reload', { fade: 0.2 });
  const r0 = hand.position.x; steps(1);
  const r1 = hand.position.x; steps(30);
  ok(Math.abs(r0 - 10) < 0.01 && r1 > 9.9 && hand.position.x === 0 && Math.abs(mag.position.x + 1.55) < 0.01,
    `viewmodel: a reload during an inspect takes over from it, and the hand the reload doesn't move goes back smoothly (${r0.toFixed(2)}, ${r1.toFixed(2)}, ${hand.position.x})`);
  steps(10); const rest = hand.position.x;
  vm.play('inspect', { fade: 0 }); vm.update(0.01);
  ok(rest === 0 && Math.abs(hand.position.x - 0.1) < 1e-6 && vm.role === 'inspect', 'viewmodel: with no blend (a draw) a clip starts at its first frame');
}

// ---- your equipped agent: its voice, its arms in first person, your body (bots keep theirs) -------------------------------
{
  const { voiceOf, voiceLines, heardLines } = (await import('node:module')).createRequire(import.meta.url)('../cs2/voice.cjs');
  const model = (m) => ({ model_player: `agents/models/${m.split('_variant')[0]}/${m}.vmdl` });
  ok(voiceOf(model('ctm_fbi_variantf')) === 'swat' && voiceOf(model('ctm_st6_variantj')) === 'seal' && voiceOf({ ...model('ctm_st6_variantk'), vo_prefix: 'ctm_gsg9' }) === 'gsg9'
    && voiceOf({ ...model('tm_professional_varf5'), vo_prefix: 'professional_epic' }) === 'professional_epic' && voiceOf(model('tm_balkan_variantf')) === 'balkan' && voiceOf({ ...model('ctm_swat_variantf'), vo_prefix: 'swat_fem' }) === 'swat_fem',
  "agents' voices: CS2's rule (vo_prefix, else the model's name up to _var, FBI as SWAT, ST6 as SEAL)");
  const shared = { m_Requirements: [{ m_name: 'ConceptEnemySpotted', m_matchKey: 'Concept', m_matchExpr: 'Radio.EnemySpotted' }, { m_name: 'ConceptGo', m_matchKey: 'Concept', m_matchExpr: 'Radio.GoGoGo' },
    { m_name: 'ConceptThanks', m_matchKey: 'Concept', m_matchExpr: 'radio.thanks' }, { m_name: 'ConceptPos', m_matchKey: 'Concept', m_matchExpr: 'Radio.InPosition' }] };
  const talker = { m_ResponseGroups: [
    { m_name: 'spotted', m_responses: [{ m_type: 'RESPONSE', m_value: 'lines' }], m_pEmbeddedRule: { m_Requirements: ['ConceptEnemySpotted'] } },
    { m_name: 'lines', m_responses: [{ m_type: 'SPEAK', m_value: 'v.spotted01' }, { m_type: 'SPEAK', m_value: 'v.spotted01' }, { m_type: 'SPEAK', m_value: 'v.gone02' }] },
    { m_name: 'go', m_responses: [{ m_type: 'SPEAK', m_value: 'v.radio_request_move_01' }], m_pEmbeddedRule: { m_Requirements: ['ConceptGo'] } },
    { m_name: 'pos', m_responses: [{ m_type: 'SPEAK', m_value: 'v.at_position_01' }], m_pEmbeddedRule: { m_Requirements: ['ConceptPos'] } },
    { m_name: 'thanks', m_responses: [{ m_type: 'SPEAK', m_value: 'v.thanks01' }], m_pEmbeddedRule: { m_Requirements: ['ConceptThanks'] } },
  ] };
  const lines = voiceLines(talker, shared, new Set(['v.spotted01', 'v.request_move_01', 'v.in_position_01', 'v.thanks01']));
  ok(lines.enemyspotted.join() === 'v.spotted01' && lines.letsgo.join() === 'v.request_move_01' && lines.inposition.join() === 'v.in_position_01' && lines.thanks.join() === 'v.thanks01' && lines.negative.length === 0,
    "agents' voices: each radio line from the talker script, by reference, in any case, only events the voice has, nothing for a line it hasn't recorded");

  const heard = heardLines({ inposition: ['a', 'b', 'c'], thanks: ['d'] }, { a: ['u'], b: [], d: ['v'] });
  ok(heard.inposition.join() === 'a' && heard.thanks.join() === 'd' && heardLines({ thanks: ['d'] }, { d: [] }) === null, "agents' voices: an event with no audio in the install is never picked, and a voice with none falls back to the default");

  const { armsOnly, agentArms, dressArms } = await import('../src/js/play/viewmodel.js');
  const bone = (name) => { const b = new THREE.Bone(); b.name = name; return b; };
  const skinned = (name, tris, weights) => {
    const g = new THREE.BufferGeometry(), n = weights.length;
    g.setAttribute('position', new THREE.Float32BufferAttribute(new Array(n * 3).fill(0), 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(weights.flatMap((w) => [w, 0, 0, 0]), 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights.flatMap(() => [1, 0, 0, 0]), 4));
    g.setIndex(tris);
    const m = new THREE.SkinnedMesh(g, new THREE.MeshStandardMaterial());
    m.name = name;
    const bones = [bone('arm_lower_L'), bone('hand_L'), bone('clavicle_L'), bone('scapula_L')];
    m.add(bones[0]); bones[0].add(bones[1]); m.add(bones[2]); bones[2].add(bones[3]);
    m.bind(new THREE.Skeleton(bones));
    return m;
  };
  const jacket = skinned('tm_leet_variantffirstperson_sleeves', [0, 1, 2, 2, 3, 0], [0, 1, 1, 3]);
  const onArms = skinned('tm_leet_variantffirstperson_default_gloves_arms', [0, 1, 2], [0, 1, 1]);
  const kept = armsOnly(jacket);
  ok(kept !== jacket.geometry && kept.index.count === 3 && armsOnly(onArms) === onArms.geometry, "agents' arms: sleeve triangles hanging on the body are cut (a viewmodel clip doesn't move it), arms are left whole");

  const scene = new THREE.Group(), body = skinned('tm_leet_variantfthirdperson_body', [0, 1, 2], [0, 1, 1]), wrapped = new THREE.Group();
  wrapped.name = 'tm_leet_variantffirstperson_default_gloves_arms';
  const wrappedMesh = skinned('tm_leet_variantffirstperson_default_gloves_arms_1', [0, 1, 2], [0, 1, 1]);
  wrapped.add(wrappedMesh);
  scene.add(jacket, body, wrapped);
  const src = agentArms({ scene });
  ok(src.arms.length === 1 && src.sleeves.length === 1 && src.arms[0].material !== wrappedMesh.material && src.arms[0].geometry === wrappedMesh.geometry && src.sleeves[0].geometry.index.count === 3
    && agentArms({ scene: new THREE.Group() }).sleeves.length === 0, "agents' arms: found by name on the mesh or its group, with materials of their own (the model's are lit for the world); no sleeves is fine");

  const rig = () => { const view = new THREE.Group(), skel = new THREE.Group(), arms = new THREE.Group(); view.add(skel, arms); return { view, skel, arms, bones: {} }; };
  const vm = rig(), wear = dressArms(vm, { T: src }, false), roots = vm.view.children.slice(2);
  wear('T');
  const inT = !vm.arms.visible && roots[0].visible && roots[0].children.length === 2;
  wear('CT');
  ok(inT && vm.arms.visible && !roots[0].visible, "agents' arms: your side's on the rig in place of the default, the default back on a side with no agent");
  const gv = rig(), gw = dressArms(gv, { T: src }, true), groot = gv.view.children[2];
  gw('T');
  ok(gv.arms.visible && groot.visible && groot.children.length === 1 && groot.children[0].material === src.sleeves[0].material, "agents' arms: equipped gloves stay on with the agent's sleeves over them, as in CS2");

  const { Bot } = await import('../src/js/play/bots.js');
  const gltf = (name, ...meshes) => { const s = new THREE.Group(); s.name = name; s.add(...meshes); return { scene: s }; };
  const pool = { T: [gltf('phoenix', skinned('tm_phoenixthirdperson_body', [0, 1, 2], [0, 1, 1])), gltf('leet', skinned('tm_leetthirdperson_body', [0, 1, 2], [0, 1, 1]))], CT: [gltf('sas', skinned('ctm_sasdefusekit', [0, 1, 2], [0, 1, 1])), gltf('st6', skinned('ctm_st6defusekit', [0, 1, 2], [0, 1, 1]))] };
  const mine = gltf('mine', skinned('ctm_swat_variantfdefusekit', [0, 1, 2], [0, 1, 1]), skinned('ctm_swat_variantfthirdperson_body', [0, 1, 2], [0, 1, 1]));
  const assets = { models: pool, own: { T: null, CT: mine } };
  const fake = (own) => Object.assign(Object.create(Bot.prototype), { assets, index: 1, ownBody: own, view: new THREE.Group(), lightOwn() {} });
  const me = fake(true), bot = fake(false);
  me.setModel('CT'); bot.setModel('CT');
  const kit = (b) => { let v = null; b.model.traverse((o) => { if (o.isMesh && /defusekit/.test(o.name)) v = o.visible; }); return v; };
  ok(me.modelSrc === mine && bot.modelSrc === pool.CT[1] && kit(me) === false && kit(bot) === true, 'your body is your agent, with no kit showing; a bot keeps its own model, as it was');
  me.setModel('T');
  ok(me.modelSrc === pool.T[1], 'your body on a side with no agent is the same default as before');
}

// ---- the console: cheats and server commands in private matches only ----------------------------------------------------
{
  const { commands, DevConsole } = await import('../src/js/play/console.js');
  const fresh = (cheatsAllowed) => {
    const out = [], g = { cheatsAllowed, cv: { sv_cheats: 0, host_timescale: 1, sv_infinite_ammo: 0, bot_stop: 0, bot_dont_shoot: 0, mp_buy_anywhere: 0 }, god: false, noclip: false, rules: { startMoney: 800, freeze: 15 }, bots: [],
      combatants: [], me: { team: 'T' }, player: { velocity: [0, 0, 0] } };
    const con = Object.assign(Object.create(DevConsole.prototype), { game: g, print: (t) => out.push(t) });
    con.cmds = commands(g, con);
    return { g, con, out };
  };
  const m = fresh(false);
  for (const line of ['sv_cheats 1', 'god', 'noclip', 'host_timescale 4', 'sv_infinite_ammo 1', 'sv_gravity 100', 'bot_stop 1', 'bot_dont_shoot 1', 'mp_startmoney 16000', 'mp_buy_anywhere 1', 'mp_freezetime 0', 'bot_kill', 'mp_restartgame 1', 'impulse 101']) m.con.run(line);
  const { MOVE } = await import('../src/js/play/movement.js');
  ok(m.g.cv.sv_cheats === 0 && !m.g.god && !m.g.noclip && m.g.cv.host_timescale === 1 && m.g.cv.sv_infinite_ammo === 0 && m.g.cv.bot_stop === 0 && m.g.rules.startMoney === 800 && m.g.rules.freeze === 15 && m.g.cv.mp_buy_anywhere === 0 && MOVE.gravity === 800 && m.g.restartAt === undefined
    && m.out.length === 14 && m.out.every((t) => /only work in private matches/.test(t)), 'console: in a matchmaking match every cheat and server command is refused, sv_cheats 1 too: ' + m.out.length);
  m.g.cv.sv_cheats = 1; m.out.length = 0;
  m.con.run('god'); m.con.run('noclip; host_timescale 4');
  ok(!m.g.god && !m.g.noclip && m.g.cv.host_timescale === 1 && m.out.length === 3, "console: sv_cheats set some other way changes nothing in a matchmaking match, nor does a chain of commands (a bind's)");
  m.out.length = 0;
  m.con.run('mp_startmoney');
  ok(m.out.length === 1 && /^mp_startmoney = 800/.test(m.out[0]), 'console: a server variable can still be read');
  const p = fresh(true);
  for (const line of ['sv_cheats 1', 'god', 'host_timescale 4', 'bot_stop 1', 'sv_gravity 100', 'mp_startmoney 16000', 'mp_buy_anywhere 1']) p.con.run(line);
  const on = p.g.cv.sv_cheats === 1 && p.g.god && p.g.cv.host_timescale === 4 && p.g.cv.bot_stop === 1 && MOVE.gravity === 100 && p.g.rules.startMoney === 16000 && p.g.cv.mp_buy_anywhere === 1;
  p.con.run('sv_cheats 0');
  ok(on && !p.g.god && p.g.cv.host_timescale === 1 && p.g.cv.bot_stop === 0 && MOVE.gravity === 800, 'console: a private match keeps its cheats and server commands, and sv_cheats 0 turns them off');
  p.con.run('sv_cheats 1'); p.con.run('sv_gravity 100'); p.con.run('god');
  const next = fresh(false);
  next.g.god = true; next.con.noCheats();
  ok(MOVE.gravity === 800 && !next.g.god && next.g.cv.sv_cheats === 0, "console: a matchmaking match starts with everything normal, whatever a private match left (how you move is shared between matches)");
  // Other ways to the same thing: fps_max slowing the match as host_timescale does, the HUD off seeing through a flash.
  const hud = () => ({ el: { style: { display: '' } } });
  const a = fresh(false), b = fresh(true);
  a.g.hud = hud(); b.g.hud = hud();
  for (const t of [a, b]) { t.con.cmds = commands(t.g, t.con); t.con.run('fps_max 1'); }
  const slow = [a.g.cv.fps_max, b.g.cv.fps_max];
  a.con.run('fps_max 0'); const none = a.g.cv.fps_max;
  a.con.run('fps_max 144');
  ok(slow.join() === '30,1' && none === 0 && a.g.cv.fps_max === 144, 'console: in a matchmaking match fps_max stops at 30 (lower, the match itself slows down); uncapped and normal caps are fine, and a private match can go lower: ' + slow);
  for (const t of [a, b]) { t.con.run('cl_drawhud 0'); t.con.run('r_drawviewmodel 0'); }
  ok(a.g.hud.el.style.display === '' && a.g.cv.r_drawviewmodel === 1 && b.g.hud.el.style.display === 'none' && b.g.cv.r_drawviewmodel === 0, "console: no turning the HUD or your weapon off in a matchmaking match (the HUD holds a flashbang's white), as in a private match you can");
  a.out.length = 0; a.con.run('cl_drawhud');
  ok(/^cl_drawhud = 1/.test(a.out[0]), 'console: and reading them still works');
  const c = (name, team, alive = true) => ({ name, team, alive, health: 77, money: 4200, kills: 1, deaths: 2 });
  const look = fresh(false), me = c('You', 'T'), mate = c('Mate', 'T'), foe = c('Foe', 'CT');
  Object.assign(look.g, { me, combatants: [me, mate, foe] });
  look.con.cmds = commands(look.g, look.con);
  look.con.run('status');
  ok(/77 hp/.test(look.out[0]) && /4200/.test(look.out[1]) && !/hp|4200/.test(look.out[2]) && /Foe/.test(look.out[2]), "console: status doesn't show enemies' health and money in a matchmaking match");
}

// ---- H switches hands (CS2's switchhands, cl_prefer_lefthanded): bound for older saved binds too, saved -------------------
{
  const { bindTable, BINDS_VERSION, DEFAULT_BINDS, Input } = await import('../src/js/play/input.js');
  const old = bindTable({ keybinds: { w: '+forward', f: '+lookatweapon' } });
  const taken = bindTable({ keybinds: { h: 'say hi' } });
  const unbound = bindTable({ keybinds: { w: '+forward' }, bindsVersion: BINDS_VERSION });
  const elsewhere = bindTable({ keybinds: { j: 'switchhands' } });
  ok(DEFAULT_BINDS.h === 'switchhands' && old.h === 'switchhands' && taken.h === 'say hi' && !unbound.h && !elsewhere.h && elsewhere.j === 'switchhands',
    'switch hands: H by default, and for a saved table from before (unless H is taken, or you bound it elsewhere or unbound it since)');
  const inp = Object.create(Input.prototype); Object.assign(inp, { keys: new Set(), pressed: new Set(), pulses: new Set(), buttons: 0, clicked: 0, wheel: 0 });
  inp.setBinds(DEFAULT_BINDS);
  const ran = []; inp.onCommand = (c) => ran.push(c);
  inp.down('h'); inp.up('h');
  const { Game } = await import('../src/js/play/game.js');
  const saved = [];
  const g = { vmRoot: new THREE.Group(), settings: { onLeftHanded: (on) => saved.push(on) }, me: {}, console: { isOpen: false } };
  g.setLeftHanded = Game.prototype.setLeftHanded;
  Game.prototype.command.call(g, ran[0]);
  const left = g.vmRoot.scale.x === -1 && g.leftHanded && g.settings.leftHanded;
  Game.prototype.command.call(g, 'switchHands');
  g.setLeftHanded(true, false);
  ok(ran.join() === 'switchHands' && left && saved.join() === 'true,false' && g.vmRoot.scale.x === -1,
    'switch hands: H mirrors your viewmodel into the left hand and back, saved each time (and not when the setting is only applied)');
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

// Fire and smoke (grenades.js), as in CS2: a molotov burns 7 s; a smoke popping in or next to it puts it out there and
// then (not through a wall), a smoke grenade landing in the flames pops at once, and a molotov landing in a smoke goes
// straight out. And the bots' check (ai.js wastes) that none of their utility goes like that.
{
  const { Grenades, NADES, FIRE_TIME } = await import('../src/js/play/grenades.js');
  const { Brain } = await import('../src/js/play/ai.js');
  const ALL = FLAG_PLAYER | FLAG_BULLET | FLAG_GRENADE;
  const G = world([[[-4000, -4000, -64], [4000, 4000, 0], ALL], [[1000, -800, 0], [1040, 800, 300], ALL]]); // the floor, a wall
  const heard = [];
  const game = { scene: new THREE.Scene(), collision: G, now: 0, combatants: [], positionOf: (c) => c.p, damage() {}, noise() {}, botOf: () => null,
    sounds: { play: (name) => { heard.push(name); return null; } }, balls: { bump: () => false }, botAssets: { weapon: () => Promise.resolve(null) },
    lineOfSight: (a, b) => !G.occluded(a, b, FLAG_BULLET, 2) };
  const N = game.nades = new Grenades(game);
  const T = { team: 'T' }, CT = { team: 'CT' };
  const run = (secs) => { for (let i = 0; i < Math.round(secs * 64); i++) { game.now += 1 / 64; N.tick(1 / 64); } };
  const pop = (id, pos, c = T) => { const n = { c, id, info: NADES[id], pos: pos.slice(), obj: new THREE.Group() }; N.flying.push(n); N.detonate(n, N.flying.length - 1); };
  const reset = () => { N.clear(); heard.length = 0; };

  pop('weapon_molotov', [0, 0, 2]);
  run(6.9);
  const burning = N.fires.length === 1;
  run(0.2);
  ok(FIRE_TIME === 7 && burning && !N.fires.length, "fire: a molotov burns CS2's 7 seconds, then dies down");
  reset();
  pop('weapon_incgrenade', [0, 0, 2]); run(1);
  pop('weapon_smokegrenade', [60, 0, 2]);
  ok(!N.fires.length && heard.includes('Molotov.Extinguish') && !heard.includes('Inferno.FadeOut'), 'fire: a smoke popping in it puts it out there and then (no dying down)');
  reset();
  pop('weapon_molotov', [0, 0, 2]); run(1);
  pop('weapon_smokegrenade', [170, 0, 2]);
  ok(!N.fires.length, 'fire: so does one popping next to it');
  reset();
  pop('weapon_molotov', [0, 0, 2]); run(0.5);
  pop('weapon_smokegrenade', [420, 0, 2]); run(2);
  ok(N.fires.length === 1, "fire: a smoke a few metres off doesn't (its cloud never reaches it)");
  reset();
  pop('weapon_molotov', [960, 0, 2]); run(0.5);
  pop('weapon_smokegrenade', [1080, 0, 2]); run(2);
  ok(N.fires.length === 1, 'fire: nor one on the other side of a wall');
  reset();
  pop('weapon_molotov', [0, 0, 2]); run(0.5);
  const t0 = game.now;
  N.throw(T, 'weapon_smokegrenade', [-300, 0, 64], [450, 0, 150]);
  run(1.15);
  ok(!N.fires.length && N.volume.active && N.volume.fields[0].born - t0 < 1.1, 'fire: a smoke grenade landing in the flames pops at once (before its fuse, still rolling) and puts them out');
  reset();
  pop('weapon_smokegrenade', [0, 0, 2]); run(2);
  pop('weapon_molotov', [50, 0, 2]);
  ok(!N.fires.length && heard.at(-1) === 'Molotov.Extinguish', 'fire: a molotov landing in a smoke goes straight out');
  const ct = Object.assign(Object.create(Brain.prototype), { game, bot: { c: CT } }), tb = Object.assign(Object.create(Brain.prototype), { game, bot: { c: T } });
  ok(ct.wastes('fire', [30, 0, 0]) && !ct.wastes('fire', [800, 0, 0]), "bots: a molotov into a smoke is wasted (they wait), one clear of it isn't");
  reset();
  pop('weapon_molotov', [2000, 2000, 2], T); run(0.5);
  ok(tb.wastes('smoke', [2050, 2000, 0]) && !ct.wastes('smoke', [2050, 2000, 0]), "bots: a smoke on its own team's fire is wasted, on the other team's it's the point (it puts it out)");
  reset();
  N.dispose();
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
  // Props that break by their own prop data (their models' health and pieces), whatever they're called: Nuke's vent
  // slats, Cache's vents; a prop with prop data but nothing to break into (a radio) doesn't.
  const kvText = (pd, pieces) => `<!-- kv3 encoding:text:version{e21c7f3c-8a33-41c5-9977-a76d3a32aa0d} format:vmdlkeys4:version{9f5c1002-f19f-470c-bd42-c3c26c063d33} -->
{ break_list = [ ${Array.from({ length: pieces }, (_, i) => `{ piece_name = "p${i}" }`).join(', ')} ] prop_data = { base = "${pd.base}" health = ${pd.health} } }`;
  const slats = play.propBreakData({ m_modelInfo: { m_keyValueText: kvText({ base: 'Metal.Medium', health: 1.0 }, 10) } });
  const radio = play.propBreakData({ m_modelInfo: { m_keyValueText: kvText({ base: 'Plastic.Medium', health: 5.0 }, 0) } });
  ok(slats?.health === 1 && slats.base === 'Metal.Medium' && slats.pieces === 10 && radio?.pieces === 0 && play.propBreakData({ m_name: 'x' }) === null, "map export: a model's own break data (prop_data's health and base, its pieces)");
  const pjson = { nodes: [{ name: 'nuke_vent_slats', matrix: m(448, -1403, -416) }, { name: 'newvent', matrix: m(374, -276, 1789) }, { name: 'vintage_radio_1', matrix: m(1, 2, 3) }] };
  const own = { 'models/props/de_nuke/hr_nuke/nuke_vent_slats/nuke_vent_slats.vmdl': slats, 'models/de_cache_s2/newvent/newvent.vmdl': { health: 3, base: 'Metal.Medium', pieces: 10 },
    'models/cs_italy/props/radio/vintage_radio_1.vmdl': radio };
  const props = play.glassNodes(pjson, [
    { classname: 'prop_dynamic', targetname: '[PR#]nuke_vent', model: 'resource_name:"models/props/de_nuke/hr_nuke/nuke_vent_slats/nuke_vent_slats.vmdl"', origin: '[ 448.0, -1403.0, -416.0 ]' },
    { classname: 'prop_dynamic', model: '"models/de_cache_s2/newvent/newvent.vmdl"', origin: '[ 374.0, -276.0, 1789.0 ]' },
    { classname: 'prop_dynamic', model: 'resource_name:"models/cs_italy/props/radio/vintage_radio_1.vmdl"', origin: '[ 1.0, 2.0, 3.0 ]' },
  ], own);
  ok(props.length === 2 && props.every((p) => p.surface === 'metalvent' && p.sound === 'Metal_Box.Break' && p.solid) && props[1].health === 3 && JSON.stringify(props.map((p) => p.nodes[0])) === '[0,1]',
    "map export: props that break by their own prop data (Nuke's vent slats, Cache's vents) with their health, not a radio");
  const impacts = play.surfaceImpacts('{ surfacePropertyName = "brass_bell_large" audiosounds = { bulletimpact = "inferno.bell_c" } }, { surfacePropertyName = "Glass" audiosounds = { bulletimpact = "Glass.BulletImpact" } }');
  ok(impacts.brass_bell_large === 'inferno.bell_c' && impacts.glass === 'Glass.BulletImpact', "map export: every surface's bullet impact sound (Inferno's bells)");
}

// ---- breakables (doors.js): their health taken by bullets and an HE grenade's blast, whole again each round ------------
{
  const { Doors } = await import('../src/js/play/doors.js');
  const played = [];
  const game = { collision: { addDynamic: (o) => o, raycast: () => null }, sounds: { play: (e) => played.push(e) }, effects: {}, bots: [], combatants: [] };
  const box = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 1, 0.1)); // (metres, three's axes)
  const doors = new Doors(game, { doors: [], glass: [{ box, meshes: [], health: 30, surface: 'metalvent', sound: 'Metal_Box.Break', solid: true }] });
  const pane = doors.panes[0], hit = { shape: pane.shape };
  const first = doors.shot(hit, pane.center, [1, 0, 0], 20), second = doors.shot(hit, pane.center, [1, 0, 0], 20);
  ok(!first && second && pane.broken && played.join() === 'Metal_Box.Break', 'breakables: bullets take its health away, and it breaks once it has none');
  doors.reset();
  const away = pane.center.map((v, i) => v + (i === 0 ? 400 : 0)), near = pane.center.map((v, i) => v + (i === 0 ? 100 : 0));
  doors.blast(away, 350, 99);
  const survived = !pane.broken && pane.hp === 30;
  doors.blast(near, 350, 99);
  ok(survived && pane.broken && pane.shape.off, 'breakables: an HE grenade breaks one in its reach (not one past it), and a round starts with it whole');
  // Rays and sweeps skip a door's or breakable's triangles when they miss its bounds, and still hit it when they don't.
  const W = world([[[-1000, -1000, -64], [1000, 1000, 0]]]);
  const tris = new Float32Array(boxTris([100, -20, 0], [110, 20, 80]).flat(2));
  const sh = W.addDynamic({ tris, flags: FLAG_PLAYER | FLAG_BULLET, surface: 'metalvent' });
  W.bound(sh);
  const hitIt = W.raycast([0, 0, 40], [1, 0, 0], 500), past = W.raycast([0, 60, 40], [1, 0, 0], 500), short = W.raycast([0, 0, 40], [1, 0, 0], 50);
  const swept = W.traceBox([0, 0, 2], [200, 0, 2], [-16, -16, 0], [16, 16, 54]);
  ok(hitIt?.shape === sh && Math.abs(hitIt.t - 100) < 1e-3 && !past && !short && swept.shape === sh && W.occluded([0, 0, 40], [300, 0, 40]) && !W.occluded([0, 60, 40], [300, 60, 40]),
    "collision: a breakable's bounds let rays and sweeps past it skip it, and ones into it still hit");
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
  // CS2's throw: aimed 10 degrees above the crosshair looking level, less looking up or down; 750 x 0.9 x (0.7 strength +
  // 0.3); a softer throw leaves the hand lower.
  const { throwPitch, aimPitch, throwSpeed, throwOrigin } = await import('../src/js/play/flight.js');
  ok(throwPitch(0) === -10 && throwPitch(90) === 90 && throwPitch(-90) === -90 && throwPitch(45) === 40 && throwPitch(-45) === -50
    && [-80, -30, -10, 0, 20, 60].every((p) => near(aimPitch(throwPitch(p)), p, 1e-9)), "flight: CS2's raised aim (10 degrees looking level, none straight up or down)");
  ok(throwSpeed(1) === 675 && near(throwSpeed(0.5), 438.75, 1e-9) && near(throwSpeed(0), 202.5, 1e-9), "flight: CS2's throw speeds (Mouse1, both, Mouse2)");
  const o1 = throwOrigin(G, [0, 0, 64], 0, 0, 1), o0 = throwOrigin(G, [0, 0, 64], 0, 0, 0);
  ok(near(Math.hypot(o1[0], o1[1]), 16 * Math.cos(Math.PI / 18), 1e-6) && near(o0[2] - o1[2], -12, 1e-6), 'flight: it leaves the hand 16 units out (22 short of a wall, 6 back), 12 lower for Mouse2');
  // CS2's bounce keeps 0.45 of the speed along the floor too: a grenade that lands carries on only a little way.
  const run = simulateFlight(G, [0, 0, 64], throwVelocity(0, 0, 1), 'smoke', { keepPath: true });
  const first = run.path.find((p) => p[2] < 3);
  ok(first && run.pos[0] - first[0] > 50 && run.pos[0] - first[0] < 400, 'flight: a grenade thrown level comes to rest a short way past where it lands: ' + Math.round(run.pos[0] - first[0]));
}

// ---- bots: skill by rank, CS Ratings, who they are -------------------------------------------------------------------
{
  const K = await import('../src/js/play/skill.js');
  const silver = K.skillParams(0), ge = K.skillParams(1);
  ok(silver.reaction[0] > ge.reaction[0] * 2 && silver.flickErr > ge.flickErr * 3 && silver.flickMin > ge.flickMin * 5 && silver.pursuitLag > ge.pursuitLag * 3 && silver.utility < 0.2 && ge.utility > 0.9 && silver.strafe > ge.strafe * 5 && silver.crosshair > ge.crosshair * 10,
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

// ---- sounds as CS2 plays them: each event's own settings, the soundscapes, and their reverb ---------------------------
{
  const { curveAt, distanceGain, layerVolumes } = await import('../src/js/play/sound.js');
  // Your sounds' layers: the loudest at the volume asked, the rest as CS2 has them next to it, none louder (a helmet
  // headshot kill's event is silent itself: its dink played hundreds of times too loud).
  const infos = { HS: { v: 0, d: [[104, 1], [1100, 1]], c: ['Dink', 'Flesh'] }, Dink: { v: 0.6, d: [[104, 1]] }, Flesh: { v: 0.3, d: [[15, 1]] },
    Glock: { v: 1, d: [[25, 0.8], [30, 1]], c: ['Far', 'Click'] }, Far: { v: 0.7, d: [[800, 0], [2354, 0.34]] }, Click: { v: 0.3, d: [[35, 1]] } };
  const hs = layerVolumes(infos.HS, infos, 0.8), gl = layerVolumes(infos.Glock, infos, 0.9);
  ok(hs.self === 0 && JSON.stringify(hs.layers) === '[["Dink",0.8],["Flesh",0.4]]', "sound: a silent event's layers play at the volume asked, not hundreds of times it: " + JSON.stringify(hs));
  ok(gl.self === 0.9 && gl.layers.length === 1 && gl.layers[0][0] === 'Click' && near(gl.layers[0][1], 0.3375, 1e-9) && layerVolumes(null, infos, 0.5).self === 0.5,
    "sound: your gunshot at the volume asked, its click as CS2 has it next to it, no distant layer: " + JSON.stringify(gl));
  ok(Object.keys(infos).every((e) => layerVolumes(infos[e], infos, 1).layers.every(([, v]) => v <= 1) && layerVolumes(infos[e], infos, 1).self <= 1), 'sound: no layer louder than asked');
  const { renderReverb } = await import('../src/js/play/reverb.js');
  const { Soundscapes } = await import('../src/js/play/soundscape.js');
  const play = (await import('node:module')).createRequire(import.meta.url)('../cs2/play.cjs');
  const c = [[25, 0.8], [30, 1], [176, 1], [440, 0.735], [1288, 0.331], [2500, 0.015]];
  ok(curveAt(c, 0) === 0.8 && curveAt(c, 100) === 1 && near(curveAt(c, 864), 0.533, 0.001) && curveAt(c, 9000) === 0.015, 'sound: a distance curve between its points, flat past its ends');
  ok(distanceGain('Weapon_AK47.Single', { d: c }, 1288) === 0.331 && distanceGain('Weapon_AK47.Single', { d: c }, 9000) === 0 && distanceGain('X.Step', null, 5000) === 0
    && distanceGain('CT_Concrete.StepLeft', null, 100) === 1, "sound: an event's volume by distance (its curve, else how far its kind carries)");
  // The install's sound events -> how each plays.
  const ev = {
    'Base.Step': { volume: 0.9, volume_random_min: -0.1, volume_random_max: 0, occlusion_intensity: 0.375, use_distance_volume_mapping_curve: true, distance_volume_mapping_curve: [[50, 0.45, 0, 0, 1, 1], [1100, 0, 0, 0, 1, 1]] },
    'CT_Wood.StepLeft': { base: 'Base.Step', vsnd_files_track_01: ['a.vsnd', 'b.vsnd'], volume: 0.8 },
    'Weapon_T.Single': { vsnd_files_track_01: ['t.vsnd'], soundevent_01: ['Weapon_T.SingleDistant', 'Nope'], instance_limit: 1, reverb_wet: 1, enable_child_events: true, pitch_random_min: 0.02, pitch_random_max: -0.02,
      use_distance_unfiltered_stereo_mapping_curve: true, distance_unfiltered_stereo_mapping_curve: [[35, 1, 0, 0, 0, 0], [300, 0, 0, 0, 0, 0]], fadetime_volume_mapping_curve: [[0, 1, 0, 0, 0, 0], [0.1, 0, 0, 0, 0, 0]] },
    'Weapon_T.SingleDistant': { vsnd_files_track_01: ['td.vsnd'], volume: 0.5, occlusion_intensity: 0 },
    'Weapon_T.Alias': { soundevent_01: 'Weapon_T.SingleDistant' },
    'UI.Thing': { vsnd_files_track_01: ['u.vsnd'], reverb_wet: 1, mixgroup: 'UI' },
    'map.Street': { dsp_preset: 'reverb_21_outsideStreet', soundevent_01: ['map.wind', 'map.car'], use_time_volume_mapping_curve: true, time_volume_mapping_curve: [[0, 0, 0, 0, 2, 2], [0.36, 1, 0, 0, 2, 3]] },
    'map.wind': { vsnd_files_track_01: ['w.vsnd'], volume: 0.15 },
    'map.car': { vsnd_files_track_01: ['c.vsnd'], enable_retrigger: true, retrigger_interval_min: 13, retrigger_interval_max: 35, use_world_position: true, position: [10, 20, 30] },
  };
  const files = play.soundEventFiles(ev), info = play.soundEventInfo(ev, files);
  ok(info['CT_Wood.StepLeft'].v === 0.8 && info['CT_Wood.StepLeft'].o === 0.375 && JSON.stringify(info['CT_Wood.StepLeft'].vr) === '[-0.1,0]' && info['CT_Wood.StepLeft'].d.length === 2, "sound info: an event gets its base's settings, then its own");
  const t = info['Weapon_T.Single'];
  ok(JSON.stringify(t.c) === '["Weapon_T.SingleDistant"]' && t.n === 1 && t.fo === 0.1 && t.s[0][1] === 1 && JSON.stringify(t.pr) === '[-0.02,0.02]', 'sound info: a gunshot plays its distant layer, one at a time, plain stereo up close');
  ok(info['Weapon_T.Alias'].v === 0.5 && JSON.stringify(files['Weapon_T.Alias']) === '["td.vsnd"]' && info['UI.Thing'].r === 0, "sound info: an alias plays as what it stands for; UI sounds aren't in the room");
  ok(JSON.stringify(files['map.Street']) === '[]' && info['map.Street'].dsp === 'reverb_21_outsidestreet' && info['map.Street'].c.length === 2 && info['map.Street'].fi === 0.36
    && JSON.stringify(info['map.car'].rt) === '[13,35]' && JSON.stringify(info['map.car'].wp) === '[10,20,30]', "sound info: a soundscape: its reverb, and its children (a car's sand now and then, where it is)");
  ok(JSON.stringify(play.mapSoundscapes([{ classname: 'env_soundscape', origin: '1 2 3', radius: '300', soundevent: 'map.Street', enablesoundevent: 'true' },
    { classname: 'env_soundscape', origin: '0 0 0', soundevent: 'x', enablesoundevent: 'false' }, { classname: 'info_target', origin: '0 0 0' }])) === '[{"o":[1,2,3],"r":300,"e":"map.Street"}]', "map: its soundscapes (env_soundscape's that play a soundscape event)");
  // Reverb presets: an echo comes back when it says, as loud as it says; nothing for the null preset.
  const echo = renderReverb([{ type: 'delay', ms: 250, direct: -60, gain: -2.21, feedback: -20, cutoff: 5254, width: 0 }], 48000);
  let at = 0;
  for (let i = 1; i < echo.left.length; i++) if (Math.abs(echo.left[i]) > Math.abs(echo.left[at])) at = i;
  ok(at === 12000 && near(echo.left[at], 0.775, 0.002) && Math.abs(echo.left[0]) < 1e-6, 'reverb: an echo 250 ms later, 2.2 dB down: ' + at + ' ' + echo.left[at].toFixed(3));
  ok(renderReverb([], 48000) === null, 'reverb: the null preset is none');
  const tail = (fb) => { const r = renderReverb([{ type: 'box', min: 20, max: 100, complexity: 8, feedback: fb, cutoff: 8000, gain: 0, parallel: true }], 8000); let last = 0; r.left.forEach((v, i) => { if (Math.abs(v) > 1e-3) last = i; }); return last; };
  ok(tail(0.9) > tail(0.5) * 2 && renderReverb([{ type: 'freeverb', size: 0.6, damp: 0.1, width: 0.5, late: 0.4 }], 8000).right.some((v) => Math.abs(v) > 1e-4), 'reverb: a room rings longer the more it feeds back (and Freeverb rings)');
  // CS2's EQ on the room: its lows and highs mostly gone, its middle kept.
  const { ROOM_EQ } = await import('../src/js/play/reverb.js');
  const eqd = renderReverb(ROOM_EQ, 48000).left;
  const at_ = (f) => { let re = 0, im = 0; eqd.forEach((v, i) => { re += v * Math.cos((2 * Math.PI * f * i) / 48000); im -= v * Math.sin((2 * Math.PI * f * i) / 48000); }); return 20 * Math.log10(Math.hypot(re, im)); };
  ok(at_(60) < -25 && Math.abs(at_(700)) < 1.5 && at_(1374) < -1 && at_(1374) > -4 && at_(14000) < -18, `reverb: CS2's EQ on the room (60 Hz ${at_(60).toFixed(1)}, 700 Hz ${at_(700).toFixed(1)}, 1.4 kHz ${at_(1374).toFixed(1)}, 14 kHz ${at_(14000).toFixed(1)} dB)`);
  // CS2's reverb compressor: the room down while the sounds are loud, back once they stop; nothing for quiet ones.
  let Ducker = null;
  Object.assign(globalThis, { AudioWorkletProcessor: class {}, sampleRate: 48000, registerProcessor: (n, C) => { Ducker = C; } });
  const { duckBy } = await import('../src/js/play/ducker.worklet.js');
  const block = (v) => [new Float32Array(128).fill(v), new Float32Array(128).fill(v)];
  const run = (d, key, secs) => { let out; for (let i = 0; i < (secs * 48000) / 128; i++) { out = block(0); d.process([block(1), key], [out]); } return out[0][127]; };
  const loud = new Ducker(), quiet = new Ducker();
  const down = run(loud, block(0.5), 1.5), back = run(loud, [], 1.5), steps = run(quiet, block(0.03), 1.5);
  ok(near(20 * Math.log10(down), duckBy(20 * Math.log10(0.5)), 0.3) && down < 0.25 && back > 0.95 && steps > 0.99 && duckBy(-40) === 0 && near(duckBy(-23.875 + 1.5625), duckBy(-23.875 + 1.5626), 1e-3),
    `room ducking: under a loud sound ${(20 * Math.log10(down)).toFixed(1)} dB, back after ${back.toFixed(2)}, a quiet one ${steps.toFixed(3)}`);
  // The soundscape you're in: the nearest you can hear (inside its radius, nothing in between); you keep it out of range.
  const played = [], rooms = [], faded = [];
  const bank = { info, events: files, ctx: { currentTime: 0 }, has: (e) => !!files[e]?.length, play: (e, o) => { played.push([e, o]); return Promise.resolve({ gainNode: { gain: { setTargetAtTime() {} } } }); },
    setRoom: (r) => rooms.push(r), fadeOut: (v) => faded.push(v), reverb() {}, load: async () => {} };
  let ear = [0, 0, 0];
  const wall = (p) => p[0] > 900; // something between you and anything over there
  const ss = new Soundscapes({ sounds: bank, earPos: () => ear, soundBlocked: (e, p) => wall(p) }, [
    { o: [100, 0, 0], r: 500, e: 'map.Street' }, { o: [1000, 0, 0], r: 5000, e: 'Other' }, { o: [0, 600, 0], r: 300, e: 'Far' }, { o: [0, 0, 0], r: 0, e: 'Off', off: true },
  ]);
  ss.update(0.6);
  ok(ss.active?.e === 'map.Street' && rooms[0] === 'reverb_21_outsidestreet' && played.length === 1 && played[0][0] === 'map.wind' && played[0][1].loop && played[0][1].volume === 0.15,
    'soundscape: the one you are in sets the reverb and starts its loops (the wind)');
  ear = [3000, 3000, 0];
  ss.update(0.6);
  ok(ss.active?.e === 'map.Street', 'soundscape: out of every one, you keep the last');
  bank.ctx.currentTime = 40;
  ss.update(0.1);
  ok(played.some(([e, o]) => e === 'map.car' && JSON.stringify(o.pos) === '[10,20,30]'), 'soundscape: its one-shots play now and then, where they are');
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

// ---- bots' aim (aim.js): still for the reaction, a flick that lands off, corrections, then following with a lag -----
{
  const { Aim, minJerk } = await import('../src/js/play/aim.js');
  const K = await import('../src/js/play/skill.js');
  const seeded = (s) => () => ((s = (s * 16807) % 2147483647) / 2147483647);
  // A target 40° to the side, 800 units off (its head about 0.29° across, half), still unless target(t) moves it.
  const run = (skill, seed, target = () => [0, 40], secs = 2.5) => {
    const p = K.skillParams(skill), aim = new Aim(seeded(seed)), view = [0, 0], out = [0, 0], dt = 1 / 64;
    const react = (p.reaction[0] + p.reaction[1]) / 2, trace = [];
    aim.start(0, react);
    let prev = target(0), landed = null, was = aim.phase;
    for (let t = 0; t < secs; t += dt) {
      const at = target(t), vel = [(at[0] - prev[0]) / dt, (at[1] - prev[1]) / dt];
      prev = at;
      aim.step(dt, t, view, at, vel, 0.29, p, out);
      view[0] = out[0]; view[1] = out[1];
      const err = Math.hypot(at[0] - view[0], at[1] - view[1]);
      if (was === 'move' && aim.phase !== 'move' && landed == null) landed = err; // (where the first flick put it)
      was = aim.phase;
      trace.push({ t, err, view: view.slice() });
    }
    const last = trace.findLastIndex((x) => x.err >= 1);
    return { trace, react, landed, settled: last < 0 ? 0 : trace[last].t + dt };
  };
  const ge = run(1, 7);
  ok(ge.trace.filter((x) => x.t < ge.react - 1e-9).every((x) => x.view[0] === 0 && x.view[1] === 0), `aim: nothing moves for its reaction time (${Math.round(ge.react * 1000)} ms for a Global Elite)`);
  const med = (xs) => xs.slice().sort((a, b) => a - b)[xs.length >> 1];
  const many = (skill) => Array.from({ length: 41 }, (_, i) => run(skill, 11 + i * 7));
  const G = many(1), Sv = many(0);
  const gSettle = med(G.map((r) => r.settled)), sSettle = med(Sv.map((r) => r.settled)), gLand = med(G.map((r) => r.landed)), sLand = med(Sv.map((r) => r.landed));
  ok(gSettle > ge.react + 0.12 && gSettle < 0.8, `aim: a Global Elite is on a head 40° off after ${Math.round(gSettle * 1000)} ms (reaction, flick and correction), not at once`);
  ok(sSettle > gSettle * 1.8, `aim: a Silver takes much longer: ${Math.round(sSettle * 1000)} ms`);
  ok(gLand > 0.4 && gLand < 6 && sLand > gLand * 2, `aim: the first flick lands off (median ${gLand.toFixed(1)}° for a Global Elite, ${sLand.toFixed(1)}° for a Silver)`);
  ok(Math.abs(minJerk(0.5) - 0.5) < 1e-12 && minJerk(0.6) - minJerk(0.4) > (minJerk(0.2) - minJerk(0)) * 3 && minJerk(1) === 1, 'aim: a flick is fast in the middle and slows into the end (minimum jerk)');
  // Following a strafing target (12° either way, turning back every 0.6 s): it keeps up, but each turn takes it off them
  // for a moment (it used to stay on the head however they moved).
  const strafe = (t) => [0, 40 + (t < 1.5 ? 0 : 12 * (1 - Math.abs((((t - 1.5) / 0.6) % 2) - 1) * 2))];
  const follow = (skill) => { const r = run(skill, 5, strafe, 4); const w = r.trace.filter((x) => x.t > 2.2); return { max: Math.max(...w.map((x) => x.err)), mean: w.reduce((s, x) => s + x.err, 0) / w.length }; };
  const fg = follow(1), fs = follow(0);
  ok(fg.max > 0.3 && fg.mean < 2, `aim: a Global Elite follows a strafing target (${fg.mean.toFixed(2)}° off on average) but a change of direction throws it off for a moment (up to ${fg.max.toFixed(2)}°)`);
  ok(fs.max > fg.max * 2, `aim: a Silver's lag is worse (up to ${fs.max.toFixed(2)}°)`);
}

// ---- bots' senses: a sound gives a rough idea where; they look for it where it would come from, not through walls ---
{
  const { Brain } = await import('../src/js/play/ai.js');
  // A wall between the bot (0, 0) and a noise at (600, 0), with a gap at its north end (y 300 and up).
  const Wl = world([[[-2000, -2000, -64], [2000, 2000, 0]], [[200, -1000, 0], [240, 300, 200]]]);
  const g = { lineOfSight: (a, b) => !Wl.occluded(a, b, FLAG_BULLET, 2), nav: { groundAt: () => 0, path: () => ({ points: [[220, 360, 0], [400, 360, 0], [600, 0, 0]] }) } };
  const bot = { pos: [0, 0, 0], eye: () => [0, 0, 64] };
  const brain = Object.assign(Object.create(Brain.prototype), { game: g, bot, d: { hear: 1, patience: 0.5 } });
  let off = 0, n = 0, still = true;
  for (let i = 0; i < 200; i++) {
    brain.heard = null;
    brain.hear([600, 0, 0], 2600, i * 10);
    off += Math.hypot(brain.heard.pos[0] - 600, brain.heard.pos[1]); n++;
    const at = brain.heard.pos.slice();
    brain.hear([640, 30, 0], 900, i * 10 + 0.4); // (the same footsteps going on nearby)
    still &&= brain.heard.pos[0] === at[0] && brain.heard.pos[1] === at[1];
  }
  ok(off / n > 60 && off / n < 300, `senses: a noise behind a wall 600 units off is placed ${Math.round(off / n)} units out on average (it had the exact spot)`);
  ok(still, "senses: the same footsteps going on nearby don't move where it thinks they are (it used to follow each step)");
  const w = brain.watchPoint({ pos: [600, 0, 0] }, 0);
  ok(w && Math.hypot(w[0] - 220, w[1] - 360) < 1, `senses: it looks for a noise behind a wall at the gap they'd come through (${w?.map(Math.round)}), not through the wall`);
  const open = Object.assign(Object.create(Brain.prototype), { game: { ...g, lineOfSight: () => true }, bot });
  const v = open.watchPoint({ pos: [600, 0, 0] }, 0);
  ok(v && v[0] === 600 && v[1] === 0, 'senses: one it can see the spot of, it looks at');
}

// ---- bots round each other: past on the right of one coming the other way, round one standing in the way ---------------
{
  const { Brain } = await import('../src/js/play/ai.js');
  const a = { c: { alive: true }, pos: [0, 0, 0], vel: [220, 0, 0] }, b = { c: { alive: true }, pos: [60, 6, 0], vel: [-220, 0, 0] };
  const bots = [a, b];
  const g = { combatants: [a.c, b.c], me: null, botOf: (c) => bots.find((x) => x.c === c), nav: { groundAt: () => 0 }, collision: { traceBox: () => ({ fraction: 1 }) } };
  const brain = (x) => Object.assign(Object.create(Brain.prototype), { game: g, bot: x, dodge: 0, dodgeUntil: 0, dodgeFor: null, dodgeFlips: 0 });
  const wa = [250, 0], wb = [-250, 0];
  brain(a).avoid(wa, 0); brain(b).avoid(wb, 0);
  ok(wa[1] < -50 && wb[1] > 50 && Math.abs(Math.hypot(...wa) - 250) < 1e-6, 'avoid: two bots meeting in a corridor each pass on their right (they used to stop face to face)');
  b.vel = [0, 0, 0]; b.pos = [50, 10, 0];
  const ws = [250, 0];
  brain(a).avoid(ws, 1);
  ok(ws[1] < -50, 'avoid: round the other side of someone standing a little to one side');
  const free = [250, 0];
  b.pos = [-80, 0, 0];
  brain(a).avoid(free, 2);
  ok(free[1] === 0, "avoid: someone behind isn't in the way");
  ok(brain(a).occupied([-70, 10, 0]) && !brain(a).occupied([200, 0, 0]), 'avoid: a point someone stands on counts as reached');
}

// ---- where bots hold (spots.js): cover, facing the way in, a different spot each, and not the same every round ---------
{
  const { Spots } = await import('../src/js/play/spots.js');
  const { NavMesh } = await import('../src/js/play/nav.js');
  // The terrorists' side (west) through a doorway (x -400, |y| < 60) into a big room with the site; a crate on it.
  const Wr = world([[[-2000, -2000, -64], [2000, 2000, 0]], [[-400, -1000, 0], [-360, -60, 200]], [[-400, 60, 0], [-360, 1000, 200]], [[300, 250, 0], [360, 310, 60]]]);
  const sq = (x0, y0, x1, y1) => [[x0, y0, 0], [x1, y0, 0], [x1, y1, 0], [x0, y1, 0]];
  const hiding = [[500, -400, 0], [700, 300, 0], [400, 520, 0], [900, 0, 0], [380, 330, 0], [800, -600, 0], [1100, 400, 0], [600, -150, 0]];
  const nav = new NavMesh({ areas: [
    { id: 1, flags: 0, c: sq(-1800, -1000, -400, 1000), e: [[], [2], [], []], h: [] },
    { id: 2, flags: 0, c: sq(-400, -60, -360, 60), e: [[], [3], [], [1]], h: [] },
    { id: 3, flags: 0, c: sq(-360, -1000, 1800, 1000), e: [[], [], [], [2]], h: hiding },
  ] });
  const info = { bombsites: [{ site: 'A', min: [200, -200, 0], max: [600, 200, 40] }], places: [], spawns: { T: [{ origin: [-1500, 0, 0] }], CT: [{ origin: [1500, 0, 0] }] } };
  const game = { map: { info }, nav, collision: Wr, enemySpawnCenter: (team) => info.spawns[team === 'T' ? 'CT' : 'T'][0].origin };
  const sp = new Spots(game, (() => { let s = 99; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })());
  await sp.prepare();
  const p = sp.place('hold:A');
  ok(p && p.ways.length === 1 && p.spots.length >= 4, `spots: the site's way in and ${p?.spots.length} spots that watch it`);
  const door = [-380, 0];
  const bots = ['one', 'two', 'three'].map((name) => ({ c: { name, team: 'CT' } }));
  sp.roundStart();
  const picks = bots.map((b) => sp.pick(b, 'hold:A'));
  const apart = picks.every((s, i) => s && picks.every((o, j) => i === j || Math.hypot(s.pos[0] - o.pos[0], s.pos[1] - o.pos[1]) >= 100));
  ok(apart, 'spots: three CTs on a site each get their own spot, 100+ units apart');
  const facing = picks.every((s) => {
    const yaw = (Math.atan2(door[1] - s.pos[1], door[0] - s.pos[0]) * 180) / Math.PI;
    return Math.hypot(s.at[0] - door[0], s.at[1] - door[1]) < 260 && Math.abs(((yaw - s.look[1] + 540) % 360) - 180) < 20 && !Wr.occluded([s.pos[0], s.pos[1], s.pos[2] + 64], s.at, FLAG_BULLET, 2);
  });
  ok(facing, 'spots: each watches the doorway the terrorists come through, facing it (not the wall towards their spawn)');
  let changed = 0, prev = picks[0].pos;
  for (let r = 0; r < 8; r++) { sp.roundStart(); const s = sp.pick(bots[0], 'hold:A'); if (Math.hypot(s.pos[0] - prev[0], s.pos[1] - prev[1]) > 100) changed++; prev = s.pos; }
  ok(changed >= 6, `spots: round to round a bot holds somewhere else (${changed} of 8 rounds)`);

  // A real position (setups.js): near its own spot, watching the enemy come out of its callout.
  const { SETUPS } = await import('../src/js/play/setups.js');
  info.id = 'test_rooms';
  info.places = [{ name: 'Door', min: [-420, -80, 0], max: [-340, 80, 100] }, { name: 'Site', min: [200, -200, 0], max: [600, 200, 100] }];
  SETUPS.test_rooms = { CT: { A: [{ id: 'corner', name: 'corner', at: [700, 300, 0], watch: ['Door'] }] }, T: [] };
  const sp2 = new Spots(game);
  ok(sp2.keys().includes('pos:CT:corner'), 'positions: a map\'s positions are worked out with its other spots, as the match loads');
  sp2.roundStart();
  const pos = sp2.pick(bots[0], 'pos:CT:corner');
  ok(pos && Math.hypot(pos.pos[0] - 700, pos.pos[1] - 300) <= 220 && Math.hypot(pos.at[0] - door[0], pos.at[1] - door[1]) < 330 && !Wr.occluded([pos.pos[0], pos.pos[1], pos.pos[2] + 64], pos.at, FLAG_BULLET, 2),
    `positions: a CT on "corner" holds near it (${pos && Math.round(Math.hypot(pos.pos[0] - 700, pos.pos[1] - 300))} units off) watching the doorway its callout names`);
  delete SETUPS.test_rooms;
}

// ---- a round's setup (strats.js): CTs on real positions, called; a terrorists' default spread over the map --------------
{
  const { teamPlan } = await import('../src/js/play/strats.js');
  const { SETUPS } = await import('../src/js/play/setups.js');
  const P = (id, extra = {}) => ({ id, name: id, at: [0, 0, 0], watch: [], ...extra });
  SETUPS.test_plan = {
    CT: { A: [P('a1'), P('a2'), P('a3', { awp: true })], B: [P('b1'), P('b2'), P('b3')], mid: [P('m1'), P('m2', { awp: true })] },
    T: [P('tmid', { site: 'mid' }), P('ta1', { site: 'A' }), P('ta2', { site: 'A' }), P('tb1', { site: 'B' }), P('tb2', { site: 'B' })],
  };
  const mk = (team, i, gun) => ({ c: { team, name: team + i, skill: 0.6, nades: {}, hasC4: team === 'T' && i === 0, alive: true }, weapons: { primary: { id: gun } }, pos: [0, 0, 0], brain: { d: { utility: 0 } } });
  const game = { map: { info: { id: 'test_plan', bombsites: [{ site: 'A' }, { site: 'B' }] } }, midSpot: [0, 0, 0], lineups: [], tSiteHistory: [],
    bots: [...[0, 1, 2, 3, 4].map((i) => mk('CT', i, i === 2 ? 'weapon_awp' : 'weapon_m4a1')), ...[0, 1, 2, 3, 4].map((i) => mk('T', i, 'weapon_ak47'))] };
  let ok1 = true, awpOk = true, called = true;
  for (let r = 0; r < 30; r++) {
    const ct = teamPlan(game, 'CT', 'full');
    const bySite = {};
    for (const [c, s] of ct.assign) { const p = ct.pos.get(c); if (!p || !SETUPS.test_plan.CT[s].includes(p)) ok1 = false; (bySite[s] ||= []).push(p?.id); }
    if (Object.values(bySite).some((l) => new Set(l).size !== l.length)) ok1 = false;
    const awper = game.bots[2].c, ap = ct.pos.get(awper);
    if (ap && SETUPS.test_plan.CT[ct.assign.get(awper)].some((p) => p.awp) && !ap.awp) awpOk = false;
    if (!ct.call || ![...ct.pos.values()].every((p) => ct.call.includes(p.name))) called = false;
  }
  ok(ok1, 'setups: each CT plays a position of its own site, never two on one');
  ok(awpOk, "setups: the AWPer takes its site's AWP position");
  ok(called, 'setups: the setup is called ("A a1 and a3, mid m1, B b1 and b2")');
  game.forceStrat = 'default';
  let spread = true, lurkOk = true;
  for (let r = 0; r < 30; r++) {
    const t = teamPlan(game, 'T', 'full');
    const ps = [...t.positions.values()];
    if (ps.length !== 5 || new Set(ps).size !== 5 || new Set(ps.slice(0, 3).map((p) => p.site)).size < 2) spread = false;
    const lp = t.lurk && t.positions.get(t.lurk);
    if (lp && (lp.site === t.site || lp.site === 'mid')) lurkOk = false;
  }
  ok(spread, "setups: a default spreads the terrorists over the map's positions, one each");
  ok(lurkOk, "setups: the default's lurker plays the other site's side");
  delete SETUPS.test_plan;
}

// ---- outnumbered (ai.js fallBack): a CT falls back to retake, a Silver stays --------------------------------------------
{
  const { Brain } = await import('../src/js/play/ai.js');
  const site = { site: 'A', min: [0, 0, 0], max: [200, 200, 40] }, said = [];
  const mkc = (team, p) => ({ team, alive: true, p });
  const me = mkc('CT', [100, 100, 0]), mate = mkc('CT', [3000, 3000, 0]), ts = [1, 2, 3].map(() => mkc('T', [150, 150, 0]));
  const g = { combatants: [me, mate, ...ts], positionOf: (c) => c.p, radio: { say: (c, k, text) => said.push(text) } };
  const mkBrain = (skill) => Object.assign(Object.create(Brain.prototype), { game: g, bot: { c: me }, d: { skill }, plan: { sightings: new Map(ts.map((e) => [e, { site: 'A', t: 10 }])) }, retakeSpot: () => [-900, -900, 0] });
  const b = mkBrain(0.6), back = b.fallBack('A', 11, () => site);
  ok(back && back.spot[0] === -900 && /falling back/.test(said[0] || ''), `fall back: a CT alone on A seeing three terrorists there falls back to retake ("${said[0]}")`);
  ok(!mkBrain(0.2).fallBack('A', 11, () => site), 'fall back: a Silver stays where it is');
  const two = mkBrain(0.6);
  two.plan.sightings = new Map(ts.slice(0, 2).map((e) => [e, { site: 'A', t: 10 }]));
  ok(!two.fallBack('A', 11, () => site), "fall back: two terrorists aren't enough to fall back from");
  ok(b.fallBack('A', 40, () => site) === null, "fall back: back to its spot once they're gone from the site (nothing seen there for a while)");
}

// ---- guns keep their skins: dropped, picked up by a bot or by you; a bot's is the default -------------------------------
{
  const { Drops, gunSkin, LOCAL } = await import('../src/js/play/drops.js');
  const item = { uid: 'u1', t: 'skin', id: 'skin-ak', fl: 0.12, sd: 661, stt: true, kills: 5, stk: [{ id: 's1', x: 0.4, y: 0.5 }], kc: { id: 'c1' } };
  const s = gunSkin(item);
  ok(s.owner === LOCAL && s.item !== item && JSON.stringify(s.item) === JSON.stringify(item) && gunSkin(null) === null,
    "skins: a gun's skin is a copy of the whole item (finish, float, pattern, StatTrak, stickers, charm) and whose it is, as plain JSON");
  const asked = [];
  const g = { now: 0, scene: new THREE.Scene(), botAssets: { weapon: (id, it) => { asked.push(it); return Promise.resolve(null); } } };
  const drops = new Drops(g);
  const mine = drops.drop({ id: 'weapon_ak47', clip: 30, reserve: 90, skin: s }, [0, 0, 0]);
  const theirs = drops.drop({ id: 'weapon_ak47', clip: 30, reserve: 90 }, [0, 0, 0]);
  ok(mine.skin === s && asked[0] === s.item && theirs.skin === null && asked[1] == null, "skins: a dropped gun keeps its skin and lies there with it; a bot's is the default");
  const given = [], equips = [];
  const bot = { weapons: {}, equip: (id, o) => equips.push(o.skin) };
  const me = { name: 'You' }, other = { name: 'bot' };
  const ak = { clip: 30, reserve: 90, recoilSeed: 1, recoilAngle: [0, 0], recoilAngleVariance: [0, 0], recoilMagnitude: [1, 1], recoilMagnitudeVariance: [0, 0] };
  const fake = { me, drops: { take: () => true }, sounds: { play() {} }, arsenal: { guns: {} }, stats: { weapon_ak47: ak }, botOf: () => bot, giveMe: (slot, id, sel, skin) => { given.push(skin); return Promise.resolve(); } };
  const { Game } = await import('../src/js/play/game.js');
  Game.prototype.pickUp.call(fake, other, mine);
  ok(bot.weapons.primary?.skin === s && equips[0] === s, 'skins: a bot that picks your gun up holds it with your skin, and drops it with it');
  Game.prototype.pickUp.call(fake, me, mine);
  Game.prototype.pickUp.call(fake, me, theirs);
  ok(given[0] === s && given[1] === null, "skins: you pick yours up with your skin, a bot's with the default (not your own skin for it)");
}

// ---- a map's sky (cs2/play.cjs mapInfo): as bright as CS2 draws it, env_sky's brightness scale ----------------------
{
  const play = (await import('node:module')).createRequire(import.meta.url)('../cs2/play.cjs');
  const sky = (e) => play.mapInfo([{ classname: 'env_sky', skyname: 'resource_name:"materials/x/sky.vmat"', ...e }]).skyBrightness;
  ok(sky({ brightnessscale: '4.0' }) === 4 && sky({ brightnessscale: '0.5' }) === 0.5 && sky({}) === 1 && play.mapInfo([]).skyBrightness === 1,
    "map info: the sky's brightness (Cache's 4), 1 when the map doesn't say");
  ok(play.PLAY_VERSION >= 12, 'map exports: version 12 brings the windows\' and glass\'s textures and the sky\'s brightness');
}

// ---- the screen's shape (screen.js): CS2's 4:3 stretched or with black bars, 16:10, 16:9, its resolutions ----------
{
  const { screenLayout } = await import('../src/js/play/screen.js');
  const n = screenLayout(1920, 1080, {});
  ok(n.w === 1920 && n.h === 1080 && n.scaleX === 1 && !n.res, "screen: the window's own shape fills it");
  const st = screenLayout(1920, 1080, { aspect: '4:3', scaling: 'stretched' });
  ok(st.w === 1440 && st.h === 1080 && Math.abs(st.scaleX - 4 / 3) < 1e-9 && st.x === 0, '4:3 stretched on 16:9: laid out at 1440×1080 and stretched a third wider to fill the screen');
  const bars = screenLayout(1920, 1080, { aspect: '4:3', scaling: 'bars' });
  ok(bars.w === 1440 && bars.x === 240 && bars.scaleX === 1, '4:3 with black bars: 1440×1080 in the middle, 240 px of black either side');
  const wide = screenLayout(1280, 1024, { aspect: '16:9', scaling: 'bars' });
  ok(wide.w === 1280 && wide.h === 720 && wide.y === 152, '16:9 with black bars on a 5:4 screen: bars top and bottom');
  ok(screenLayout(1920, 1080, { aspect: '4:3', resolution: '1280x960' }).res?.join() === '1280,960' && !screenLayout(1920, 1080, { aspect: '4:3', resolution: '1920x1080' }).res,
    "screen: a resolution of the aspect picked is drawn at; another aspect's isn't");
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
