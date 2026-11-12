// Online PvP's netcode, in Node (no window, no GPU): the wire format (play/net-codec.js), the host's handling of a remote
// player's commands (play/net-pawn.js), the client's prediction and reconciliation, interpolation and the clock nudge
// (play/net-interp.js), lag compensation (play/lagcomp.js), the shots' seeded spread, and a host and two clients wired
// through an in-memory relay with latency and jitter. The map cases read Dust II's and Nuke's collision from the CS2 export
// cache (CS2SIM_CACHE, else the game's own), read only; they're skipped, and say so, when it isn't there.
import fs from 'node:fs';
import path from 'node:path';
import { CollisionWorld } from '../src/js/play/collision.js';
import { PlayerMovement } from '../src/js/play/movement.js';
import * as C from '../src/js/play/net-codec.js';
import { Interp, ClockNudge, Predictor, moveDiffers } from '../src/js/play/net-interp.js';
import { LagComp } from '../src/js/play/lagcomp.js';
import { NetPawn, CmdInput, moveCmd, repeatCmd, spreadRand } from '../src/js/play/net-pawn.js';
import { NADE_ORDER } from '../src/js/play/grenades.js';
import { Arsenal, Gun } from '../src/js/play/weapons.js';
import { rayCapsule } from '../src/js/play/bots.js';
import { NET, FRAME } from '../src/js/engine/pvp.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('FAIL', msg); } if (process.env.VERBOSE) console.log(cond ? 'ok  ' : 'FAIL', msg); };
const TICK = NET.TICK;
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

// ---- the wire: commands --------------------------------------------------------------------------------------------------
{
  ok(C.NADE_ORDER.join() === NADE_ORDER.join(), 'codec: its grenades are grenades.js\'s, in the same order');
  const w = new C.Writer(8);
  const cmds = [];
  for (let i = 0; i < 300; i++) {
    cmds.push({ seq: (65530 + i) & 0xffff, view: (i * 517) >>> 0, buttons: Math.floor(rnd() * (1 << 21)), fwd: [-1, 0, 1][i % 3], side: [1, -1, 0][i % 3],
      yaw: C.netYaw(rnd() * 720 - 360), pitch: C.netPitch(rnd() * 180 - 90), buys: i % 7 === 0 ? [C.buyIndex('weapon_ak47'), C.buyIndex('vesthelm')] : null, ping: i % 11 === 0 ? [1.5, -2, 3] : null });
  }
  for (const c of cmds) C.writeCmd(w, c);
  const r = new C.Reader(w.done());
  let same = 0;
  for (const c of cmds) {
    const d = C.readCmd(r);
    if (d.seq === c.seq && d.view === c.view && d.buttons === c.buttons && d.fwd === c.fwd && d.side === c.side && d.yaw === c.yaw && d.pitch === c.pitch
      && JSON.stringify(d.buys) === JSON.stringify(c.buys) && JSON.stringify(d.ping) === JSON.stringify(c.ping)) same++;
  }
  ok(same === cmds.length && r.left === 0, `codec: 300 commands round-trip exactly (${same})`);
  const one = new C.Writer(64); C.writeCmd(one, { ...cmds[1], buys: null, ping: null });
  ok(one.p === 21, `codec: a command is 21 bytes (${one.p})`);
  ok(C.netYaw(359) === Math.fround(-1) && C.netYaw(-181) === Math.fround(179) && C.netPitch(120) === 89, 'codec: the aim goes as -180..180 and ±89, rounded to f32');
  // The relay's INPUTS: each client's CMDS less its first byte, gathered (server/relay.mjs flushInputs).
  const f1 = C.cmdsFrame(cmds.slice(0, 4)), f2 = C.cmdsFrame(cmds.slice(4, 5));
  ok(f1[0] === FRAME.CMDS && f1[1] === 4 && f1.length <= 256, 'codec: a CMDS frame of four commands fits the relay\'s 256 bytes');
  const body = (f) => f.subarray(1), parts = [[3, body(f1)], [7, body(f2)]];
  const inputs = new Uint8Array(2 + parts.reduce((s, [, b]) => s + 3 + b.length, 0));
  inputs[0] = FRAME.INPUTS; inputs[1] = parts.length;
  let p = 2;
  for (const [slot, b] of parts) { inputs[p] = slot; inputs[p + 1] = b.length & 255; inputs[p + 2] = b.length >> 8; inputs.set(b, p + 3); p += 3 + b.length; }
  const got = C.readInputs(inputs);
  ok(got.length === 2 && got[0].slot === 3 && got[0].cmds.length === 4 && got[1].slot === 7 && got[1].cmds[0].seq === cmds[4].seq, 'codec: the relay\'s INPUTS read back by slot');
  ok(C.unwrapSeq(2, 65534) === 65538 && C.unwrapSeq(65533, 65538) === 65533 && C.unwrapSeq(10, 5) === 10, 'codec: the 16-bit seq unwraps either side of a wrap');
  ok(C.hash32(1, 2, 3) === C.hash32(1, 2, 3) && C.hash32(1, 2, 3) !== C.hash32(1, 2, 4), 'codec: the seed hash is the same for the same numbers, another for others');
}

// ---- the wire: snapshots -------------------------------------------------------------------------------------------------
{
  const enc = new C.SharedEncoder(), dec = new C.SharedDecoder();
  const bodies = Array.from({ length: 10 }, (_, slot) => ({ ...C.newBody(slot), pos: [rnd() * 3000, rnd() * 3000, rnd() * 200], hp: 100, flags: C.F.ALIVE | C.F.GROUND, held: 'weapon_ak47', team: slot < 5 ? 0 : 1 }));
  const state = () => ({ match: { phase: 'live', round: 3, score: { A: 2, B: 0 }, swapped: false, time: 80, bomb: { state: 'carried', carrier: 6, pos: [0, 0, 0], site: '', plantedLeft: 0, defuser: 255, defuseLeft: 0 }, timeout: 0 },
    bodies, board: bodies.map((b) => ({ slot: b.slot, k: 1, a: 0, d: 2, m: 0, score: 2, dmg: 40, money: 2000 })), doors: [{ idx: 0, angle: 0, target: 0 }], panes: [] });
  const before = dec.decode(new C.Reader(enc.encode(state(), [])));
  ok(before === null, 'codec: a delta before any keyframe is skipped');
  const key = enc.encode(state(), [], { key: true, w: new C.Writer(4096) });
  const k = dec.decode(new C.Reader(key));
  ok(k?.key && dec.bodies.length === 10 && dec.match.round === 3 && dec.match.score.A === 2, 'codec: a keyframe gives everything');
  let sizes = [], wrong = 0;
  for (let f = 0; f < 200; f++) {
    // Seven moving, three still; a shot and a hit now and then.
    for (const b of bodies.slice(0, 7)) { b.pos[0] += 4 + rnd(); b.pos[1] -= 2 * rnd(); b.vel = [250 * rnd(), -60, 0]; b.yaw += rnd() * 3; b.pitch = rnd() * 10 - 5; }
    if (f % 40 === 7) bodies[2].held = 'weapon_awp';
    if (f % 25 === 3) bodies[8].hp -= 7;
    if (f % 30 === 11) { bodies[4].clip = 30 - (f % 7); bodies[4].reserve = 300 - f; } // (a spectator's HUD shows both)
    const events = f % 5 === 0 ? [{ type: C.EV.SHOT, slot: 1, wid: 'weapon_ak47', origin: [1, 2, 3], dir: [0.6, 0.8, 0], flags: 3 }, { type: C.EV.HURT, attacker: 1, victim: 8, dmg: 27, group: 'chest', point: [1, 2, 3], dir: [0, 0, 1] }] : [];
    const bytes = enc.encode(state(), events, { now: f * 2 * TICK });
    sizes.push(bytes.length);
    const s = dec.decode(new C.Reader(bytes));
    for (const b of bodies) {
      const d = dec.bodies[b.slot];
      if (Math.fround(b.pos[0]) !== d.pos[0] || Math.abs(d.vel[0] - b.vel[0]) > 0.13 || d.held !== b.held || d.hp !== Math.ceil(b.hp) || Math.abs(C.wrapYaw(d.yaw - b.yaw)) > 0.01 || Math.abs(d.pitch - b.pitch) > 0.01
        || (d.clip | 0) !== (b.clip | 0) || (d.reserve | 0) !== (b.reserve | 0)) wrong++;
    }
    if (events.length && (s.events.length !== 2 || s.events[0].wid !== 'weapon_ak47' || s.events[1].dmg !== 27 || Math.abs(s.events[0].dir[0] - 0.6) > 1e-3)) wrong++;
  }
  const avg = sizes.reduce((a, b) => a + b, 0) / sizes.length;
  ok(wrong === 0, `codec: 200 delta frames build the same bodies as the host's (within the wire's precision) (${wrong} off)`);
  ok(avg < 260, `codec: a 5v5 shared part, seven moving, is about ${Math.round(avg)} bytes (the design's ~195 + events; < 260)`);
  // A keyframe mid-stream (a client that missed some) and the stream after it agree.
  const dec2 = new C.SharedDecoder();
  dec2.decode(new C.Reader(enc.encode(state(), [], { key: true, w: new C.Writer(4096) })));
  bodies[0].pos[2] += 30;
  const nx = enc.encode(state(), []);
  dec.decode(new C.Reader(nx)); dec2.decode(new C.Reader(nx));
  ok(JSON.stringify(dec.bodies) === JSON.stringify(dec2.bodies), 'codec: a keyframe mid-stream, then the stream: the same as one that had it all');
  // Own part: a player's movement exactly, the weapons, the events.
  const col = { traceBox: (s, e) => ({ fraction: 1, endpos: e.slice(), normal: null }), ladders: new Set() };
  const pm = new PlayerMovement(col, [10.123456789, -20.5, 3]);
  pm.velocity = [123.456789123, -4.5, 0.25]; pm.duckAmount = 0.3; pm.tags = [[0.5, 0.8, 0.02]]; pm.onGround = true; pm.groundNormal = [0, 0, 1];
  const own = { ack: 1234, depth: 2, flags: C.OWN.ALIVE, move: C.moveState(pm), weapons: { active: 'primary', guns: [{ slot: 'primary', wid: 'weapon_ak47', skin: 3, clip: 27, reserve: 90, silenced: false, burst: false, zoom: 0 }, { slot: 'g_weapon_flashbang', wid: 'weapon_flashbang', skin: 255, clip: 0, reserve: 0 }],
    money: 3150, armor: 100, helmet: true, kit: false, c4: true, nades: { weapon_flashbang: 2 }, team: 'T' }, events: [{ type: C.EV.FLASHED, secs: 2.5 }, { type: C.EV.TELEPORT, yaw: 90, pitch: 0 }] };
  const ow = new C.Writer(64); C.writeOwn(ow, own);
  const ob = ow.done(), o = C.readOwn(new C.Reader(ob));
  ok(o.ack === 1234 && o.depth === 2 && o.move.origin[0] === 10.123456789 && o.move.velocity[0] === 123.456789123 && o.move.onGround && o.move.groundNormal[2] === 1, 'codec: the own part has the movement exactly');
  ok(o.weapons.active === 'primary' && o.weapons.guns[0].clip === 27 && o.weapons.guns[0].skin === 3 && o.weapons.nades.weapon_flashbang === 2 && o.weapons.c4 && o.weapons.team === 'T' && o.weapons.money === 3150, 'codec: and the weapons, money, armour, bomb and grenades');
  ok(o.events.length === 2 && near(o.events[0].secs, 2.5) && o.events[1].yaw === 90, 'codec: and its own events (a flash, a respawn)');
  const ow2 = new C.Writer(64); C.writeOwn(ow2, { ...own, weapons: null, events: [] });
  ok(ow2.p <= 110 && ob.length <= 160, `codec: an own part is ${ow2.p} bytes, ${ob.length} with its weapons (sent when they change) and two events`);
  const pm2 = new PlayerMovement(col, [0, 0, 0]);
  C.loadMove(pm2, o.move);
  ok(!moveDiffers(C.moveState(pm2), C.moveState(pm)), 'codec: the movement put back on a player is where it was');
  // The bundle, split as the relay splits it, read as a client reads it.
  const shared = enc.encode(state(), []), owns = new Map([[2, ob], [7, ob]]);
  const bundle = C.bundleFrame(777, shared, owns);
  const tick = bundle[1] | (bundle[2] << 8) | (bundle[3] << 16) | (bundle[4] << 24), sl = bundle[5] | (bundle[6] << 8);
  const snap = new Uint8Array(7 + sl + ob.length); snap.set(bundle.subarray(0, 7 + sl)); snap[0] = FRAME.SNAP; snap.set(ob, 7 + sl);
  const cf = C.readClientFrame(snap);
  ok(tick === 777 && cf.kind === 'snap' && cf.tick === 777 && cf.own && C.readOwn(cf.own).ack === 1234, 'codec: a bundle split by the relay reads back as a snapshot with its own part');
  const kf = C.keyFrame(2, 778, key, ob), uni = kf.subarray(1); uni[0] = FRAME.UNI;
  const ck = C.readClientFrame(uni);
  ok(ck.kind === 'key' && ck.tick === 778 && C.readOwn(ck.own).ack === 1234, 'codec: a keyframe by unicast reads back');
  const jf = C.jsonFrame(2, { t: 'roster', bots: [{ slot: 4, name: 'BOT Bob' }] }), ju = jf.subarray(1); ju[0] = FRAME.UNI;
  ok(C.readClientFrame(ju).msg.bots[0].name === 'BOT Bob', 'codec: a JSON message by unicast (who the bots are)');
}

// ---- seeded spread -------------------------------------------------------------------------------------------------------
{
  const a = spreadRand(99, 3, 1000), b = spreadRand(99, 3, 1000), c = spreadRand(99, 3, 1001);
  const xa = [a(), a(), a()], xb = [b(), b(), b()], xc = [c(), c(), c()];
  ok(xa.join() === xb.join() && xa.join() !== xc.join() && xa.every((v) => v >= 0 && v < 1), 'spread: the same stream for the same match, shooter and tick, another for the next tick');
  // Two arsenals (the host's copy of a player and the player's own) firing the same gun from the same commands: the same
  // bullets, as the shot's seed, the recoil and the inaccuracy are the same.
  const stats = { cycle: [0.1, 0.1], clip: 30, reserve: 90, spread: [0.002, 0.002], inaccStand: [0.006, 0.006], inaccCrouch: [0.004, 0.004], inaccMove: [0.1, 0.1], inaccJump: [0.3, 0.3],
    inaccFire: [0.008, 0.008], recoilSeed: 4567, recoilAngle: [0, 0], recoilAngleVariance: [70, 70], recoilMagnitude: [30, 30], recoilMagnitudeVariance: [0, 0], fullAuto: true,
    recoveryStart: 3, recoveryEnd: 9, recoveryStand: 0.35, recoveryStandFinal: 0.35, recoveryCrouch: 0.3, recoveryCrouchFinal: 0.3, bullets: 1, tracerFrequency: 3, shootSound: 'x', maxSpeed: [215, 215], type: 'WEAPONTYPE_RIFLE' };
  const shotsOf = () => {
    const shots = [], player = new PlayerMovement({ traceBox: (s, e) => ({ fraction: 1, endpos: e.slice(), normal: null }), ladders: new Set() }, [0, 0, 0]);
    player.onGround = true;
    const ci = new CmdInput();
    const owner = { cv: {}, me: { alive: true, nades: {} }, player, input: ci, defusing: false, sounds: { play() {}, has: () => false }, emit() {}, canAttack: () => true,
      fireBullet: (s, eye, dir) => shots.push(dir.map((v) => v.toFixed(12)).join()), noise() {}, playerPlant() {}, throwMyNade() {}, usedNade() {}, meleeTrace: () => null, damage() {} };
    const ars = new Arsenal(owner, {});
    ars.fixedTiming = true;
    const vm = { play: () => 0.3, has: () => false, length: () => 0.3, role: 'idle', rig: { visible: false }, update() {}, setSilencer() {} };
    ars.give('primary', new Gun({ slot: 'primary', id: 'weapon_ak47', name: 'AK', stats, vm }), 0, true);
    let t = 2;
    for (let i = 0; i < 200; i++) {
      t += TICK;
      const cmd = { seq: 500 + i, buttons: i < 180 ? C.B.ATTACK | (i === 0 ? C.B.CLICK1 : 0) : 0, fwd: 0, side: 0, yaw: C.netYaw(30 + i * 0.5), pitch: C.netPitch(-2) };
      ars.rand = spreadRand(77, 5, cmd.seq);
      ars.tick(TICK, t, ci.load(cmd));
    }
    return shots;
  };
  const host = shotsOf(), mine = shotsOf();
  ok(host.length >= 15 && host.join('|') === mine.join('|'), `spread: the host's copy and the player's own game fire the same ${host.length} bullets, exactly`);
}

// ---- lag compensation ----------------------------------------------------------------------------------------------------
{
  const lag = new LagComp();
  const target = { pos: [0, 500, 0], yaw: 0, ducked: false, alive: true };
  const h = { key: 9, get: () => ({ ...target, pos: target.pos.slice() }), set: (s) => { target.pos = s.pos.slice(); target.yaw = s.yaw; } };
  for (let t = 1; t <= 200; t++) { target.pos[0] = (t - 100) * 250 * TICK; lag.record(t, [h]); } // strafing at 250 u/s
  const hit = (from, aimAt) => { const d = [aimAt[0] - from[0], aimAt[1] - from[1], aimAt[2] + 50 - from[2]], l = Math.hypot(...d); return rayCapsule(from, d.map((v) => v / l), [target.pos[0], target.pos[1], target.pos[2] + 20], [target.pos[0], target.pos[1], target.pos[2] + 60], 12) != null; };
  const now = 200, view = now - 6.4; // (a client 100 ms behind)
  const seen = lag.at(9, view);
  const from = [0, 0, 64];
  ok(!hit(from, seen.pos), 'lag compensation: aimed where the client saw the strafing target, the shot misses it where it is now');
  ok(lag.rewind(lag.clampTick(view, now), [h], 0, () => hit(from, seen.pos)), 'lag compensation: rewound to the client\'s view, it hits');
  ok(Math.abs(target.pos[0] - (now - 100) * 250 * TICK) < 1e-9, 'lag compensation: everyone is put back after');
  ok(lag.clampTick(now - 40, now) === now - NET.LAGCOMP_MS / 1000 / TICK && lag.clampTick(now + 5, now) === now, `lag compensation: never more than ${NET.LAGCOMP_MS} ms back, nor ahead`);
  // (A client 150 ms from the server with a host 10 ms from it and 100 ms of interpolation draws the world about 420 ms
  // before the host gets its shot: that view is still tested where it was, not clamped.)
  ok(lag.clampTick(now - 0.42 / TICK, now) === now - 0.42 / TICK, 'lag compensation: a view 420 ms back (a 150 ms player through the relay) is rewound to, not clamped');
  const mid = lag.at(9, 150.5);
  ok(near(mid.pos[0], (50.5) * 250 * TICK, 1e-9), 'lag compensation: between two ticks it\'s between their positions');
}

// ---- interpolation and the clock -----------------------------------------------------------------------------------------
{
  const it = new Interp();
  let frames = 0, under = 0, smooth = true, lastX = null;
  const arrivals = [];
  for (let tick = 2; tick <= 64 * 60; tick += 2) arrivals.push([tick, tick * TICK * 1000 + 60 + (rnd() - 0.5) * 40]);
  arrivals.sort((a, b) => a[1] - b[1]);
  let i = 0;
  for (let now = 100; now < 60 * 1000; now += 1000 / 144) {
    while (i < arrivals.length && arrivals[i][1] <= now) { const [tick] = arrivals[i++]; it.push(tick, new Map([[1, { pos: [tick * 2, 0, 0], vel: [128, 0, 0], yaw: 0, pitch: 0, flags: 1 }]]), now); }
    if (!it.snaps.length) continue;
    it.adapt();
    const s = it.sample(1, it.renderTick(now));
    frames++;
    if (s?.k === 1 && it.renderTick(now) > it.snaps.at(-1).tick) under++;
    if (lastX != null && s && (s.pos[0] < lastX - 0.5)) smooth = false;
    if (s) lastX = s.pos[0];
  }
  ok(under / frames < 0.01, `interpolation: with 60 ms ±20 ms of jitter, ${(100 * under / frames).toFixed(2)}% of frames ran past the snapshots (< 1%)`);
  ok(smooth, 'interpolation: a body moving one way never goes back');
  ok(it.delay >= NET.INTERP_MIN && it.delay <= NET.INTERP_MAX, `interpolation: its delay settles within 70..200 ms (${Math.round(it.delay)})`);
  // Bunched: the host's frames now and then run three ticks at once (two snapshots out together), and 2% of them are held
  // 90 ms on the way (a TCP stall, those behind it with it): still under 1% of frames late, the delay within its bounds.
  {
    const ib = new Interp();
    const arr = [];
    let stallUntil = 0;
    for (let tick = 2; tick <= 64 * 60; tick += 2) {
      let at = tick * TICK * 1000 + 40 + (rnd() - 0.5) * 20 + (tick % 6 === 0 ? 0 : tick % 6 === 2 ? 15 : 0);
      if (rnd() < 0.02) stallUntil = at + 90;
      at = Math.max(at, stallUntil);
      arr.push([tick, at]);
    }
    for (let k = 1; k < arr.length; k++) arr[k][1] = Math.max(arr[k][1], arr[k - 1][1]); // (in order, as TCP keeps them)
    let fr = 0, late = 0, j = 0;
    for (let now = 100; now < 60 * 1000; now += 1000 / 144) {
      while (j < arr.length && arr[j][1] <= now) { const [tick] = arr[j++]; ib.push(tick, new Map([[1, { pos: [tick * 2, 0, 0], vel: [128, 0, 0], yaw: 0, pitch: 0, flags: 1 }]]), now); }
      if (!ib.snaps.length) continue;
      ib.adapt();
      const t = ib.renderTick(now);
      ib.sample(1, t);
      fr++;
      if (now > 10000 && ib.late(t)) late++;
    }
    ok(late / fr < 0.01 && ib.delay <= NET.INTERP_MAX, `interpolation: bunched snapshots and 2% held 90 ms: ${(100 * late / fr).toFixed(2)}% of frames late (< 1%), delay ${Math.round(ib.delay)} ms`);
  }
  // The client's clock nudged by the host's queue for it (its lowest between snapshots): a client whose clock runs 0.5% slow,
  // then one 0.5% fast, and one that starts with a backlog of 6, each settles with one to three commands waiting.
  for (const [drift, q0] of [[0.995, 1.5], [1.005, 1.5], [1, 6]]) {
    const nudge = new ClockNudge();
    let queue = q0, rate = 1, sum = 0, n = 0, low = Infinity, dry = 0;
    for (let s = 0; s < 64 * 120; s++) {
      queue = Math.max(0, queue + drift * rate - 1); // (each host tick takes one; the client sends drift × rate a tick)
      low = Math.min(low, Math.floor(queue));
      if (s % 2 === 0) { rate = nudge.sample(low, s * TICK); low = Infinity; }
      if (s > 64 * 60) { sum += queue; n++; if (queue < 1) dry++; }
    }
    ok(sum / n >= NET.QUEUE_LO - 0.5 && sum / n <= NET.QUEUE_HI + 1.5 && dry / n < 0.01, `clock: a client ${drift < 1 ? 'running slow' : drift > 1 ? 'running fast' : 'with a backlog'} settles with ${(sum / n).toFixed(2)} commands waiting at the host (dry ${(100 * dry / n).toFixed(1)}% of ticks)`);
  }
}

// ---- a map: prediction against the host -----------------------------------------------------------------------------------
const cacheDir = process.env.CS2SIM_CACHE || path.join(process.env.APPDATA || '', 'CS2 Case Simulator', 'cs2cache');
function loadMap(id) {
  const dir = path.join(cacheDir, 'play', id);
  if (!fs.existsSync(path.join(dir, 'collision.bin'))) return null;
  const info = JSON.parse(fs.readFileSync(path.join(dir, 'map.json'), 'utf8')), buf = fs.readFileSync(path.join(dir, 'collision.bin'));
  return { info, col: new CollisionWorld(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), info.collision) };
}
// A scripted player's commands: running about, strafing, jumping, crouching, turning.
function script(n, phase = 0) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const k = Math.floor((i + phase) / 64) % 8;
    const buttons = (k === 3 && i % 64 === 5 ? C.B.JUMP | C.B.JUMPPRESS : 0) | (k === 5 ? C.B.DUCK : 0) | (k === 6 ? C.B.WALK : 0);
    out.push({ seq: (i + 1) & 0xffff, seq32: i + 1, view: 0, buttons, fwd: k % 4 === 1 ? -1 : 1, side: k === 2 ? 1 : k === 4 ? -1 : 0, yaw: C.netYaw((i + phase) * 0.7), pitch: 0, buys: null, ping: null });
  }
  return out;
}
const maps = ['de_dust2', 'de_nuke'].map((id) => [id, loadMap(id)]).filter(([, m]) => m);
if (!maps.length) console.log('SKIP map cases: no Dust II or Nuke export in', cacheDir);
for (const [id, { info, col }] of maps) {
  const start = info.spawns.CT[0].origin;
  const host = new PlayerMovement(col, start), client = new PlayerMovement(col, start);
  const cmds = script(10000);
  let off = 0;
  for (const c of cmds) {
    const mc = moveCmd(c, false, 250);
    host.tick(TICK, mc); client.tick(TICK, { ...mc });
    if (Math.hypot(host.origin[0] - client.origin[0], host.origin[1] - client.origin[1], host.origin[2] - client.origin[2]) > NET.RECONCILE_POS) off++;
  }
  ok(off === 0, `prediction (${id}): the host's and the client's movement from the same 10,000 commands never part by 0.03 units (${off})`);
  // Replayed from the wire's state (net-codec's own part) part way through: still the host's.
  const a = new PlayerMovement(col, start), b = new PlayerMovement(col, start);
  for (const c of cmds.slice(0, 3000)) a.tick(TICK, moveCmd(c, false, 250));
  const w = new C.Writer(); C.writeOwn(w, { ack: 0, depth: 0, flags: 0, move: C.moveState(a), events: [] });
  C.loadMove(b, C.readOwn(new C.Reader(w.done())).move);
  let worst = 0;
  for (const c of cmds.slice(3000, 6000)) { a.tick(TICK, moveCmd(c, false, 250)); b.tick(TICK, moveCmd(c, false, 250)); worst = Math.max(worst, Math.hypot(a.origin[0] - b.origin[0], a.origin[1] - b.origin[1], a.origin[2] - b.origin[2])); }
  ok(worst <= NET.RECONCILE_POS, `prediction (${id}): from the wire's copy of the state it stays within 0.03 units (${worst.toExponential(2)})`);
}

// ---- a host and two clients through a relay with latency ------------------------------------------------------------------
// The host runs each remote player through net-pawn.js (as in a match: its command queue, the speed guard, its movement),
// sends their own part (codec) every second tick through a relay with each client's delay and jitter; each client predicts
// with net-interp.js's Predictor and reconciles; one client shoots a strafing bot the host moves, aiming where its
// interpolation shows it, and the host checks the hit with lag compensation.
{
  const m = maps[0]?.[1];
  const col = m?.col || { traceBox: (s, e, mins, maxs) => { const z = Math.max(e[2], 0); const hitFloor = e[2] < 0; return { fraction: hitFloor ? Math.max(0, (s[2]) / Math.max(1e-9, s[2] - e[2])) : 1, endpos: [e[0], e[1], z], normal: hitFloor ? [0, 0, 1] : null, startsolid: false }; }, ladders: new Set(), boxOverlap: () => false };
  const start = m ? m.info.spawns.CT[0].origin : [0, 0, 0];
  const spawns = { CT: [{ origin: start }], T: [{ origin: start }] };
  const fakeGame = { bodyWorld: () => col, map: { info: { spawns } }, match: { phase: 'live', rules: {} }, cv: {}, now: 0, sounds: null, effects: null, kill() {}, damage() {},
    drops: { lookedAt: () => null }, doors: { use: () => false }, noise() {}, specAnim() {} };
  const fakeHost = { game: fakeGame, seed: 42, fireNet() {}, rewindFor: (p, fn) => fn(), pinged() {}, skinSlot: () => 255, knifeWid: () => null, buyId: () => null };
  const mkBody = (team) => ({ c: { team, alive: true, nades: {}, health: 100 }, pos: [0, 0, 0], vel: [0, 0, 0], yaw: 0, pitch: 0, eye() { return [this.pos[0], this.pos[1], this.pos[2] + 64]; }, equip() {}, setMode() {}, reloadGesture() {}, gesture() {} });
  const profiles = [{ name: 'c1', one: 30, jitter: 5 }, { name: 'c2', one: 60, jitter: 15 }, { name: 'c3', one: 120, jitter: 25 }];
  for (const prof of profiles) {
    const body = mkBody('CT'), pawn = new NetPawn(fakeHost, body, 2, { look: null });
    pawn.move.teleport(start);
    const clientMove = new PlayerMovement(col, start), pred = new Predictor(clientMove);
    // (Each direction in order, as TCP keeps it: a message held up holds up the ones behind it.)
    const relay = { host: [], client: [] };
    const send = (now, to, fn) => relay[to].push([now + prof.one + (rnd() - 0.5) * 2 * prof.jitter, fn]);
    let seq = 0, hostTick = 0, bytesDown = 0, bytesUp = 0;
    const cmds = script(64 * 120, 17);
    let clientAcc = 0, hostAcc = 0, rate = 1;
    const nudge = new ClockNudge();
    let corrections = 0;
    for (let now = 0; now < 120000; now += 1) { // 1 ms steps
      for (const q of Object.values(relay)) while (q.length && q[0][0] <= now) q.shift()[1]();
      // Client ticks (nudged), sending each command.
      clientAcc += rate;
      while (clientAcc >= TICK * 1000 && seq < cmds.length) {
        clientAcc -= TICK * 1000;
        const c = { ...cmds[seq], seq: (seq + 1) & 0xffff }; seq++;
        const mc = moveCmd(c, false, 260);
        clientMove.tick(TICK, mc); clientMove.landed = 0;
        pred.record(seq, c, mc);
        const f = C.cmdsFrame([c]);
        bytesUp += f.length + 6;
        send(now, 'host', () => pawn.take(C.readInputs(Uint8Array.of(0x81, 1, 2, f.length - 1 & 255, (f.length - 1) >> 8, ...f.subarray(1)))[0].cmds));
      }
      // Host ticks.
      hostAcc += 1;
      while (hostAcc >= TICK * 1000) {
        hostAcc -= TICK * 1000;
        hostTick++;
        fakeGame.now += TICK;
        pawn.nextCmd();
        pawn.tick(TICK, fakeGame.now);
        if (hostTick % 2 === 0) {
          const depth = Number.isFinite(pawn.low) ? pawn.low : pawn.queue.length; // (as net-host.js ownBytes: its lowest since the last)
          pawn.low = Infinity;
          const w = new C.Writer(); C.writeOwn(w, { ack: pawn.ackSeq & 0xffff, depth, flags: C.OWN.ALIVE, move: C.moveState(pawn.move), events: [] });
          const own = w.done();
          bytesDown += own.length + 7 + 6;
          send(now, 'client', () => {
            const o = C.readOwn(new C.Reader(own));
            rate = nudge.sample(o.depth, now / 1000);
            const ack = C.unwrapSeq(o.ack, seq);
            if (pred.reconcile(ack, o.move, seq)) corrections++;
          });
        }
      }
    }
    const secs = 120;
    ok(corrections / secs < 0.1, `loopback ${prof.name} (${prof.one * 2} ms round trip): ${(corrections / secs).toFixed(3)} corrections a second moving alone (< 0.1)`);
    ok(bytesUp / secs < 8 * 1024 && bytesDown / secs < 16 * 1024, `loopback ${prof.name}: ${(bytesUp / secs / 1024).toFixed(1)} KB/s up, ${(bytesDown / secs / 1024).toFixed(1)} KB/s down for its own part`);
    ok(pawn.ran <= pawn.since + 16 && pawn.dropped === 0, `loopback: the host never ran more of their commands than the time allows, nor dropped any (${pawn.dropped})`);
  }
  // Hits at 120 ms of round trip (60 each way, ±25): the client fires at a strafing target where its interpolation draws it;
  // the host tests the shot where it was at the client's view tick (lag compensation).
  {
    const lag = new LagComp(), it = new Interp();
    const tgt = { pos: [0, 600, 0], yaw: 0, ducked: false, alive: true };
    const h = { key: 7, get: () => ({ ...tgt, pos: tgt.pos.slice() }), set: (s) => { tgt.pos = s.pos.slice(); } };
    const relay = [];
    let shots = 0, hits = 0, noComp = 0, tick = 0;
    const hitAt = (from, aim) => { const d = [aim[0] - from[0], aim[1] - from[1], aim[2] + 45 - from[2]], l = Math.hypot(...d); return rayCapsule(from, d.map((v) => v / l), [tgt.pos[0], tgt.pos[1], tgt.pos[2] + 10], [tgt.pos[0], tgt.pos[1], tgt.pos[2] + 64], 10) != null; };
    for (let now = 0; now < 60000; now += 1000 / 64) {
      tick++;
      const x = Math.sin(tick / 40) * 300; // strafing back and forth, up to ~470 u/s
      tgt.pos = [x, 600, 0];
      lag.record(tick, [h]);
      if (tick % 2 === 0) { const snap = { tick, pos: tgt.pos.slice() }; relay.push([now + 60 + (rnd() - 0.5) * 50, (at) => it.push(snap.tick, new Map([[7, { pos: snap.pos, vel: [0, 0, 0], yaw: 0, pitch: 0, flags: 1 }]]), at)]); }
      for (let i = 0; i < relay.length; i++) if (relay[i][0] <= now) { relay[i][1](now); relay.splice(i--, 1); }
      if (it.snaps.length > 4 && tick % 16 === 0) {
        it.adapt();
        const view = it.renderTick(now), seen = it.sample(7, view);
        const from = [0, 0, 64], aim = seen.pos;
        // (the command reaches the host 60 ms later: the target has moved on)
        relay.push([now + 60, () => {
          shots++;
          if (lag.rewind(lag.clampTick(view, tick), [h], 0, () => hitAt(from, aim))) hits++;
          if (hitAt(from, aim)) noComp++;
        }]);
      }
    }
    ok(hits / shots >= 0.95, `lag compensation over 120 ms of round trip: ${hits} of ${shots} shots on target hit (${(100 * hits / shots).toFixed(1)}%, ≥ 95%); without it ${noComp}`);
  }
  // A player whose game closed and came back: its commands numbered from 1 again. After the keyframe the host sends it
  // (restart), they're run; before, they'd have been dropped as old.
  {
    const body = mkBody('CT'), pawn = new NetPawn(fakeHost, body, 3, { look: null });
    const cmd = (n) => ({ ...script(1)[0], seq: n & 0xffff });
    for (let n = 1; n <= 7469; n++) { pawn.take([cmd(n)]); pawn.nextCmd(); }
    pawn.take([cmd(1), cmd(2)]);
    const dropped = pawn.queue.length === 0;
    pawn.restart();
    pawn.take([cmd(1), cmd(2), cmd(3)]);
    pawn.nextCmd();
    ok(dropped && pawn.ackSeq % 65536 === 1 && pawn.queue.length === 2, `host: a game that came back counts its commands from 1 again: after its keyframe they're run (ack ${pawn.ackSeq & 0xffff})`);
  }
  // A command again when the next hasn't come: the movement, none of its presses.
  const r = repeatCmd({ seq: 5, buttons: C.B.ATTACK | C.B.RELOAD | C.B.CLICK1 | (3 << C.SLOT_SHIFT), buys: [1], ping: [0, 0, 0] });
  ok(r.buttons === C.B.ATTACK && !r.buys && !r.ping && r.repeat, 'host: a repeated command keeps what\'s held, not what was pressed');
  const run = (pawn) => { pawn.nextCmd(); return (pawn.cur && !pawn.cur.repeat ? 1 : 0) + pawn.extra.length; };
  // The speed guard: a client sending 3 commands a tick for a second gets no more than its time (plus 16).
  {
    const body = mkBody('CT'), pawn = new NetPawn(fakeHost, body, 4, { look: null });
    let ran = 0;
    for (let t = 0; t < 64; t++) {
      pawn.take([0, 1, 2].map((k) => ({ ...script(1)[0], seq: (t * 3 + k + 1) & 0xffff })));
      ran += run(pawn);
    }
    ok(ran <= 64 + 16 && pawn.queue.length <= NET.HOST_QUEUE_MAX, `host: a client sending three commands a tick runs ${ran} in 64 ticks (at most 80), its queue kept to ${NET.HOST_QUEUE_MAX}`);
  }
  // Keyframes asked for over and over (each one a restart for that slot) give no more speed: two commands a tick for ten
  // seconds, a keyframe every 6 ticks.
  {
    const body = mkBody('CT'), pawn = new NetPawn(fakeHost, body, 4, { look: null });
    let ran = 0, seq = 0;
    for (let t = 0; t < 640; t++) {
      pawn.take([{ ...script(1)[0], seq: ++seq & 0xffff }, { ...script(1)[0], seq: ++seq & 0xffff }]);
      ran += run(pawn);
      if (t % 6 === 5) pawn.restart();
    }
    ok(ran <= 640 + 16, `host: keyframes every 6 ticks to a client sending two commands a tick: ${ran} run in 640 ticks (at most 656)`);
  }
  // A lag switch: nothing for 10 seconds, then three commands a tick: the time away banks HOST_BANK ticks at most.
  {
    const body = mkBody('CT'), pawn = new NetPawn(fakeHost, body, 4, { look: null });
    for (let t = 0; t < 640; t++) pawn.nextCmd();
    let ran = 0, seq = 0;
    for (let t = 0; t < 64; t++) { pawn.take([0, 1, 2].map(() => ({ ...script(1)[0], seq: ++seq & 0xffff }))); ran += run(pawn); }
    ok(ran <= 64 + 16 + NET.HOST_BANK, `host: ten seconds of nothing, then three commands a tick: ${ran} run in the next 64 ticks (at most ${64 + 16 + NET.HOST_BANK})`);
  }
  // A burst after a stall on the way (TCP kept every command): none dropped, caught up a few a tick, and the queue left at the
  // cushion the clock keeps.
  {
    const body = mkBody('CT'), pawn = new NetPawn(fakeHost, body, 4, { look: null });
    let seq = 0, ran = 0, ticks = 0;
    for (let t = 0; t < 64; t++) { pawn.take([{ ...script(1)[0], seq: ++seq & 0xffff }]); ran += run(pawn); }
    for (let t = 0; t < 20; t++) ran += run(pawn); // (stalled: nothing comes for 20 ticks)
    pawn.take(Array.from({ length: 22 }, () => ({ ...script(1)[0], seq: ++seq & 0xffff }))); // (then all of it at once, and the next)
    while (pawn.queue.length > NET.QUEUE_HI && ticks < 40) { pawn.take([{ ...script(1)[0], seq: ++seq & 0xffff }]); ran += run(pawn); ticks++; }
    ok(pawn.dropped === 0 && ticks <= 8 && ran === seq - pawn.queue.length, `host: a 20-tick stall's 22 commands: none dropped, caught up in ${ticks} ticks`);
  }
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
