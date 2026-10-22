// Play mode physics tests on synthetic geometry: collision traces and Source-style movement (walking, walls, steps,
// jumping, crouch-jumping onto a ledge, falling).
//   node scripts/test-play.mjs
import { CollisionWorld, FLAG_PLAYER, FLAG_BULLET } from '../src/js/play/collision.js';
import { PlayerMovement, MOVE } from '../src/js/play/movement.js';

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

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
