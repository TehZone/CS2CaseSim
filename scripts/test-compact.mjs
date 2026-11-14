// Checks the CS2 cache's compression (cs2/compact.cjs: Windows' own, compact.exe) on a pretend cache in a folder of its
// own under the temp folder (NTFS here), never the game's.
//   node scripts/test-compact.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import child_process from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Compactor, onDisk, MODE, batches } = require('../cs2/compact.cjs');
const png = require('../cs2/png.cjs');
const { CS2Service } = require('../cs2/service.cjs');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('FAIL', msg); } };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs2sim-compact-test-'));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const packed = (f) => { const st = fs.statSync(f); return st.size >= 16384 && onDisk(st) < st.size * 0.95; }; // (a tiny file takes no room of its own)
// Like a GLB's vertex buffers: floats in a pattern, which compress well.
const floats = (n, k = 1) => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = Math.round(Math.sin(i * 0.013 * k) * 900) / 8 + (i % 3); return Buffer.from(a.buffer); };
// A pretend compact.exe: logs each run's arguments and options, "finishes" at once or when let go (`hold`), compresses nothing.
function fakeSpawn(runs, hold = null) {
  return (exe, args, opts) => {
    const p = new EventEmitter();
    p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.killed = false;
    p.kill = () => { p.killed = true; setImmediate(() => p.emit('close', 1)); return true; };
    runs.push({ exe, args, opts });
    const end = () => setImmediate(() => { if (!p.killed) p.emit('close', 0); });
    if (hold) hold.push(end); else end();
    return p;
  };
}
const files = (run) => run.args.filter((a) => !a.startsWith('/'));
const supportedAnyway = (c) => { c.ok = true; c.probe = Promise.resolve(true); return c; };

try {
  // ---- the batches compact.exe gets ---------------------------------------------------------------------------------
  {
    const st = (size) => ({ size });
    const b = batches([['big.glb', st(500e6)], ...Array.from({ length: 100 }, (_, i) => [`f${i}.bin`, st(2e6)])]);
    ok(b[0].length === 1 && b[0][0][0] === 'big.glb', 'batches: a file over the 128 MB a run takes goes alone');
    ok(b.slice(1).every((x) => x.length <= 64 && x.reduce((s, [, y]) => s + y.size, 0) <= 128e6), 'batches: at most 64 files and 128 MB a run');
    const long = batches(Array.from({ length: 100 }, (_, i) => ['d/' + 'x'.repeat(200) + i + '.bin', st(1)]));
    ok(long.every((x) => x.reduce((s, [r]) => s + r.length + 3, 0) <= 8000) && long[0].length < 64, 'batches: at most 8,000 characters of command line a run');
  }

  // ---- real compression of a pretend cache ----------------------------------------------------------------------------
  const dir = path.join(root, 'cache');
  const put = (rel, data) => { const f = path.join(dir, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); return f; };
  const old = (Date.now() - 600000) / 1000;
  const made = {
    'play/de_x/world.glb': floats(2e6), // 8 MB
    'play/de_x/lightmap.bin': floats(4e5, 3),
    'play/de_x/map.json': JSON.stringify({ version: 14, pad: 'a'.repeat(40000) }), // (over 16 KB, but rewritten in place: kept as it is)
    'play/de_x/tex.png': png.encodePNG(128, 128, new Uint8Array(128 * 128 * 4).map((_, i) => (i * 7) & 255)),
    'files/materials/skybox/sky.exr': floats(2e5),
    'small.json': JSON.stringify({ a: 'b'.repeat(4000) }),
    'tmp-x/a.bin': floats(1e5),
    'index.json.tmp': JSON.stringify({ a: 'c'.repeat(50000) }),
    'noise.bin': crypto.randomBytes(1 << 20),
  };
  for (const [rel, data] of Object.entries(made)) fs.utimesSync(put(rel, data), old, old);
  put('fresh.bin', floats(1e5, 5)); // (written just now)
  const all = () => Object.keys(made).concat('fresh.bin').map((rel) => [rel, path.join(dir, ...rel.split('/'))]);
  const before = Object.fromEntries(all().map(([rel, f]) => { const st = fs.statSync(f); return [rel, { sha: sha(f), size: st.size, mtime: st.mtimeMs }]; }));
  const spawned = [], logs = [];
  const spy = (exe, args, opts) => { spawned.push(args); return child_process.spawn(exe, args, opts); };
  let svc = null;
  const c = new Compactor({ dir, spawn: spy, log: (m) => logs.push(m), onChange: () => { if (svc) svc.sizeJob = null; } });
  if (!(await c.supported())) {
    console.log(`SKIP: Windows can't compress files in ${os.tmpdir()} (not NTFS?): the real compression checks are skipped`);
    ok(c.status().supported === false, 'unsupported: says so');
  } else {
    ok(spawned.length === 1 && spawned[0].includes('/exe:xpress4k') && !fs.existsSync(path.join(dir, '.compact-probe.tmp')), 'supported: one probe, cleaned up');
    await c.run({ gated: false });
    ok(!spawned.slice(1).length, 'not before the setting is on');
    c.setEnabled(true);
    await c.run();
    const compressed = all().filter(([, f]) => packed(f)).map(([rel]) => rel).sort();
    ok(compressed.join() === 'play/de_x/lightmap.bin,play/de_x/world.glb', `compressed: the geometry and baked data, nothing else (${compressed.join()})`);
    ok(all().every(([rel, f]) => { const st = fs.statSync(f); return sha(f) === before[rel].sha && st.size === before[rel].size && st.mtimeMs === before[rel].mtime; }), 'compressed: every file reads the same, with the same size and time');
    ok(spawned.slice(1).every((a) => a.includes('/exe:' + MODE)) && MODE === 'lzx', 'compressed: with LZX');
    const memo = JSON.parse(fs.readFileSync(path.join(dir, 'compact.json'), 'utf8'));
    ok(memo.v === 1 && memo.mode === MODE && memo.skip['noise.bin'] === `${before['noise.bin'].size}:${before['noise.bin'].mtime}` && Object.keys(memo.skip).length === 1, 'what didn\'t shrink is noted (noise)');
    const n = spawned.length;
    await c.run();
    ok(spawned.length === n, 'and a second pass finds nothing to do: no compact.exe run');
    ok(c.status().supported === true && c.status().enabled === true && !c.status().running && c.saved > 4e6, 'status: what it saved');

    // The cache's size as Settings shows it (CS2Service.cacheSize): the room on the drive, and what's still to compress.
    svc = new CS2Service({ cacheDir: dir, compactor: c });
    let size = await svc.cacheSize();
    ok(size.disk < size.bytes - 4e6 && size.backlog === before['fresh.bin'].size, 'cache size: smaller on the drive, the fresh file still to do');
    fs.utimesSync(path.join(dir, 'fresh.bin'), old, old);
    await c.run();
    size = await svc.cacheSize();
    ok(size.backlog === 0 && packed(path.join(dir, 'fresh.bin')), 'cache size: nothing left to do once it\'s old enough');
    // A rewrite unpacks a file: it's back in the backlog, and the next pass packs it again.
    fs.writeFileSync(path.join(dir, 'play', 'de_x', 'world.glb'), made['play/de_x/world.glb']);
    fs.utimesSync(path.join(dir, 'play', 'de_x', 'world.glb'), old, old);
    svc.sizeJob = null;
    size = await svc.cacheSize();
    ok(!packed(path.join(dir, 'play', 'de_x', 'world.glb')) && size.backlog === 8e6, 'a rewritten file is stored unpacked again, and waits');
    await c.run({ dirs: ['play/de_x'], settledMs: 0, gated: false });
    ok(packed(path.join(dir, 'play', 'de_x', 'world.glb')) && sha(path.join(dir, 'play', 'de_x', 'world.glb')) === before['play/de_x/world.glb'].sha, 'and is packed again, the same');

    // Stopped in the middle of a big file: the file is whole (Windows finishes it), and nothing is noted about it.
    const bigRel = 'play/de_y/world.glb', big = put(bigRel, floats(30e6, 7)); // 120 MB
    fs.utimesSync(big, old, old);
    const bigSha = sha(big);
    const job = c.run({ dirs: ['play/de_y'], gated: false });
    await tick(700);
    ok(!!c.child && c.status().running, 'stop: a big file being compressed');
    const t0 = Date.now();
    await c.stop();
    console.log(`(stop: compact.exe ended ${Date.now() - t0} ms after being stopped, the 120 MB file ${packed(big) ? 'compressed' : 'not compressed'})`);
    ok(sha(big) === bigSha && fs.statSync(big).size === 120e6 && !c.child && !c.status().running, 'stop: the file is whole after stopping');
    await job;
    ok(!JSON.parse(fs.readFileSync(path.join(dir, 'compact.json'), 'utf8')).skip[bigRel], 'stop: a batch cut short notes nothing');
    fs.rmSync(path.join(dir, 'play', 'de_y'), { recursive: true });

    // Turned off: everything is unpacked again.
    c.setEnabled(false);
    await c.job;
    const left = (await c.scan([''])).filter(([, st]) => st.size >= 16384 && onDisk(st) < st.size * 0.95);
    ok(!left.length && !fs.existsSync(path.join(dir, 'compact.json')) && all().every(([rel, f]) => sha(f) === before[rel].sha), `off: nothing left compressed, the same files (${left.map(([r]) => r).join()})`);
    ok(spawned.some((a) => a[0] === '/u' && a.includes('/exe')), 'off: unpacked with compact /u /exe');
    const runs = spawned.length;
    await c.run({ gated: false });
    ok(spawned.length === runs, 'off: no pass runs');
  }

  // ---- when passes run, with a pretend compact.exe ---------------------------------------------------------------------
  {
    const dir2 = path.join(root, 'gates');
    const put2 = (rel, data) => { const f = path.join(dir2, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); fs.utimesSync(f, old, old); };
    for (let i = 0; i < 150; i++) put2(`models/${'m'.repeat(130)}${i}.bin`, floats(5000 + i));
    put2('play/de_x/world.glb', floats(1e5));
    put2('play/de_y/world.glb', floats(1e5, 2));
    const runs = [];
    let quiet = true, busy = [];
    const c2 = supportedAnyway(new Compactor({ dir: dir2, spawn: fakeSpawn(runs), quiet: () => quiet, busyDirs: () => busy, timing: { poll: 30, debounce: 30 } }));
    c2.setEnabled(true);
    await c2.run();
    const rels = runs.flatMap(files);
    ok(runs.length >= 3 && runs.every((r) => r.opts.cwd === dir2 && r.opts.windowsHide && r.args.slice(0, 4).join(' ') === `/c /exe:${MODE} /i /q`), 'fake: each run in the cache folder, hidden, LZX, its paths relative');
    ok(runs.every((r) => files(r).length <= 64 && files(r).join('   ').length <= 8000) && rels.length === 152 && new Set(rels).size === 152, 'fake: every file once, at most 64 and 8,000 characters a run');
    ok(rels.every((r) => !r.includes('/')) && rels.includes('play\\de_x\\world.glb'), 'fake: Windows paths');
    // (The pretend one compresses nothing: everything's noted as not shrinking. Forget that for what follows.)
    c2.clearMemo();
    runs.length = 0;
    quiet = false;
    await c2.run();
    ok(!runs.length && !!c2.retry, 'gate: nothing while the game is busy, tried again in a while');
    quiet = true;
    for (let i = 0; i < 50 && !runs.length; i++) await tick(20);
    await c2.job;
    ok(runs.length > 0, 'gate: and runs once it is idle');
    c2.clearMemo();
    runs.length = 0;
    c2.hold(true);
    await c2.run();
    ok(!runs.length, 'gate: nothing while a match holds it');
    c2.hold(false);
    for (let i = 0; i < 50 && !runs.length; i++) await tick(20);
    await c2.job;
    ok(runs.length > 0, 'gate: the match over, a pass soon after');
    c2.clearMemo();
    runs.length = 0;
    busy = ['play/de_x'];
    await c2.run({ gated: false });
    ok(runs.length > 0 && !runs.flatMap(files).some((r) => r.startsWith('play\\de_x\\')) && runs.flatMap(files).includes('play\\de_y\\world.glb'), 'busy: a map being exported is left alone, even by Prepare\'s own passes');
    busy = [];
    // settle(): a map's export waits for a batch in its folder, not for one elsewhere.
    c2.clearMemo();
    runs.length = 0;
    const hold = [];
    const c3 = supportedAnyway(new Compactor({ dir: dir2, spawn: fakeSpawn(runs, hold) }));
    c3.setEnabled(true);
    const job = c3.run({ dirs: ['play/de_y'], settledMs: 0, gated: false });
    for (let i = 0; i < 50 && !hold.length; i++) await tick(10);
    let settled = false, elsewhere = false;
    c3.settle('play/de_y').then(() => { settled = true; });
    c3.settle('play/de_x').then(() => { elsewhere = true; });
    await tick(30);
    ok(hold.length === 1 && !settled && elsewhere, 'settle: waits for the batch in its folder, not one elsewhere');
    hold.shift()();
    await job;
    await tick(10);
    ok(settled, 'settle: and goes on once it is done');
  }

  // ---- no compact.exe (or a drive Windows can't compress) ---------------------------------------------------------------
  {
    const spawned = [];
    const c4 = new Compactor({ dir: path.join(root, 'none'), exe: path.join(root, 'no-such', 'compact.exe'), spawn: (e, a, o) => { spawned.push(a); return child_process.spawn(e, a, o); } });
    c4.setEnabled(true);
    ok((await c4.supported()) === false && c4.status().supported === false && !c4.active(), 'no compact.exe: not supported, says so');
    fs.writeFileSync(path.join(root, 'none', 'x.bin'), floats(1e5));
    await c4.run({ gated: false });
    ok(spawned.length === 1 && !fs.existsSync(path.join(root, 'none', 'compact.json')), 'no compact.exe: a pass does nothing');
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
