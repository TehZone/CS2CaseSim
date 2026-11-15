// Checks the CS2 cache's compression (cs2/compact.cjs: Windows' own, compact.exe) on a pretend cache in a folder of its
// own under the temp folder (NTFS here), never the game's, and the PNG encoder that shrinks exported textures
// (cs2/png.cjs: lossless, smaller files).
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
  // ---- the PNG encoder: smaller, the same pixels ---------------------------------------------------------------------
  {
    const img = (w, h, f) => { const px = new Uint8Array(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set(f(x, y), (y * w + x) * 4); return px; };
    const same = (dec, px) => { // decoded (any channel count) against RGBA
      const n = dec.width * dec.height, ch = dec.channels;
      for (let i = 0; i < n; i++) for (let c = 0; c < 4; c++) {
        const v = ch >= 3 ? (c < 3 ? dec.data[i * ch + c] : ch === 4 ? dec.data[i * ch + 3] : 255) : (c < 3 ? dec.data[i * ch] : ch === 2 ? dec.data[i * ch + 1] : 255);
        if (v !== px[i * 4 + c]) return false;
      }
      return true;
    };
    const cases = {
      'RGBA with alpha': [37, 23, (x, y) => [x * 7, y * 11, (x * y) & 255, (x + y * 3) & 255]],
      'opaque RGBA': [64, 40, (x, y) => [x * 4, 255 - y * 6, (x ^ y) * 3, 255]],
      grey: [33, 17, (x, y) => { const g = (x * 5 + y * 9) & 255; return [g, g, g, 255]; }],
      'alpha mask': [48, 48, (x, y) => [200, 120, 40, (x - 24) ** 2 + (y - 24) ** 2 < 400 ? 255 : 0]],
      'one pixel': [1, 1, () => [10, 20, 30, 255]],
      'one column': [1, 9, (x, y) => [y * 20, 5, 7, y * 25]],
      noise: [50, 31, () => [...crypto.randomBytes(3), 255]],
    };
    for (const [name, [w, h, f]] of Object.entries(cases)) {
      const px = img(w, h, f), dec = png.decodePNG(png.encodePNG(w, h, px));
      const opaque = px.every((v, i) => i % 4 !== 3 || v === 255);
      ok(dec.width === w && dec.height === h && same(dec, px), `png: ${name} decodes to the same pixels`);
      ok(dec.channels === (opaque ? 3 : 4), `png: ${name} is ${opaque ? 'RGB (it is opaque)' : 'RGBA'}`);
      const plain = png.decodePNG(png.encodePNG(w, h, px, { filter: 'none', reduce: false, level: 1 }));
      ok(plain.channels === 4 && same(plain, px), `png: ${name} the old way (level 1, unfiltered RGBA) still reads back`);
    }
    // shrinkPNGs: what map exports write. Smaller than before (level 1, unfiltered, RGBA), the same pixels.
    const tex = path.join(root, 'tex.png'), W = 512;
    const src = img(W, W, (x, y) => [128 + 100 * Math.sin(x / 17) | 0, 128 + 90 * Math.cos(y / 23) | 0, (x * y / 97) & 255, 255]);
    fs.writeFileSync(tex, png.encodePNG(W, W, src, { level: 1, filter: 'none', reduce: false }));
    await png.shrinkPNGs([tex], 256);
    const mine = fs.readFileSync(tex), dec = png.decodePNG(mine);
    const old = png.encodePNG(dec.width, dec.height, (() => { const o = new Uint8Array(dec.width * dec.height * 4); for (let i = 0; i < dec.width * dec.height; i++) { o.set(dec.data.subarray(i * 3, i * 3 + 3), i * 4); o[i * 4 + 3] = 255; } return o; })(), { level: 1, filter: 'none', reduce: false });
    ok(dec.width === 256 && dec.channels === 3 && mine.length < old.length * 0.9, `png: shrinkPNGs writes a smaller file than before (${mine.length} vs ${old.length} bytes)`);
    ok(same(png.decodePNG(old), (() => { const o = new Uint8Array(256 * 256 * 4); for (let i = 0; i < 256 * 256; i++) { o.set(dec.data.subarray(i * 3, i * 3 + 3), i * 4); o[i * 4 + 3] = 255; } return o; })()), 'png: with the same pixels');
    // The map's height maps (service.cjs heightMap): still opaque.
    const { heightMap } = require('../cs2/service.cjs');
    const hm = path.join(root, 'height.png');
    fs.writeFileSync(hm, png.encodePNG(64, 64, img(64, 64, (x, y) => [x * 4, y * 4, 0, 0])));
    await heightMap(hm);
    const h = png.decodePNG(fs.readFileSync(hm));
    ok(h.channels === 3 || (h.channels === 4 && h.data.every((v, i) => i % 4 !== 3 || v === 255)), 'png: a height map comes out opaque');
    ok(h.data[(10 * 64 + 20) * h.channels] === 80 && h.data[(10 * 64 + 20) * h.channels + 1] === 40, 'png: with its height and tint mask');
  }

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
    await c.run({ gate: false });
    ok(!spawned.slice(1).length, 'not before the setting is on');
    c.setEnabled(true);
    await c.run();
    const compressed = all().filter(([, f]) => packed(f)).map(([rel]) => rel).sort();
    ok(compressed.join() === 'play/de_x/lightmap.bin,play/de_x/world.glb', `compressed: the geometry and baked data, nothing else (${compressed.join()})`);
    ok(all().every(([rel, f]) => { const st = fs.statSync(f); return sha(f) === before[rel].sha && st.size === before[rel].size && st.mtimeMs === before[rel].mtime; }), 'compressed: every file reads the same, with the same size and time');
    ok(spawned.slice(1).every((a) => a.includes('/exe:' + MODE)) && MODE === 'lzx', 'compressed: with LZX');
    const memo = () => JSON.parse(fs.readFileSync(path.join(dir, 'compact.json'), 'utf8'));
    const noise = `${before['noise.bin'].size}:${before['noise.bin'].mtime}`;
    ok(memo().v === 2 && memo().mode === MODE && memo().skip['noise.bin']?.s === noise && memo().skip['noise.bin'].n === 1 && Object.keys(memo().skip).length === 1, 'what didn\'t shrink is noted (noise)');
    let n = spawned.length;
    await c.run();
    ok(spawned.length === n + 1 && spawned.at(-1).some((a) => /noise\.bin$/.test(a)) && memo().skip['noise.bin'].n === 2, 'it is tried once more by the next pass (another program may have had it open)');
    n = spawned.length;
    await c.run();
    ok(spawned.length === n, 'and once it has not shrunk in two, a pass finds nothing to do: no compact.exe run');
    ok(spawned.slice(1).every((a) => a.filter((x) => !x.startsWith('/')).every((x) => x.startsWith('cache\\'))), 'compact.exe gets the paths from the folder the cache is in');
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
    await c.run({ dirs: ['play/de_x'], settledMs: 0, gate: false });
    ok(packed(path.join(dir, 'play', 'de_x', 'world.glb')) && sha(path.join(dir, 'play', 'de_x', 'world.glb')) === before['play/de_x/world.glb'].sha, 'and is packed again, the same');

    // Stopped in the middle of a big file: the file is whole (Windows finishes it), and nothing is noted about it.
    const bigRel = 'play/de_y/world.glb', big = put(bigRel, floats(30e6, 7)); // 120 MB
    fs.utimesSync(big, old, old);
    const bigSha = sha(big);
    const job = c.run({ dirs: ['play/de_y'], gate: false });
    await tick(700);
    ok(!!c.child && c.status().running, 'stop: a big file being compressed');
    const t0 = Date.now();
    await c.stop();
    console.log(`(stop: compact.exe ended ${Date.now() - t0} ms after being stopped, the 120 MB file ${packed(big) ? 'compressed' : 'not compressed'})`);
    ok(sha(big) === bigSha && fs.statSync(big).size === 120e6 && !c.child && !c.status().running, 'stop: the file is whole after stopping');
    await job;
    ok(!JSON.parse(fs.readFileSync(path.join(dir, 'compact.json'), 'utf8')).skip[bigRel], 'stop: a batch cut short notes nothing');
    fs.rmSync(path.join(dir, 'play', 'de_y'), { recursive: true });

    // Settings' rebuild deletes the cache while compact.exe is on a big file in it: compact.exe runs outside it, so it
    // can be (and the cache made again at once).
    {
      const dir5 = path.join(root, 'cache5'), f5 = path.join(dir5, 'play', 'de_z', 'world.glb');
      fs.mkdirSync(path.dirname(f5), { recursive: true });
      fs.writeFileSync(f5, floats(30e6, 9));
      fs.utimesSync(f5, old, old);
      const c5 = new Compactor({ dir: dir5 });
      c5.setEnabled(true);
      const job5 = c5.run({ gate: false });
      for (let i = 0; i < 100 && !c5.child; i++) await tick(20);
      let err = null;
      try { fs.rmSync(dir5, { recursive: true, force: true }); } catch (e) { err = e; }
      ok(c5.child && !err && !fs.existsSync(dir5), `rebuild: the cache is deleted while compact.exe runs (${err?.code || 'ok'})`);
      fs.mkdirSync(path.dirname(f5), { recursive: true });
      fs.writeFileSync(f5, 'new');
      ok(fs.readFileSync(f5, 'utf8') === 'new', 'rebuild: and made again at once');
      await c5.stop();
      await job5;
      ok(!c5.child && fs.readFileSync(f5, 'utf8') === 'new' && !fs.existsSync(path.join(dir5, 'compact.json')), 'rebuild: the old pass writes nothing into the new cache');
    }

    // A path longer than compact.exe takes (it would stop its run there): never given one.
    {
      const deep = 'models/' + 'd'.repeat(100) + '/' + 'e'.repeat(100) + '/' + 'f'.repeat(60) + '.bin';
      const st = { size: 1e6, mtimeMs: 0, blocks: 2000 };
      ok(c.abs(deep).length > 255 && !c.eligible(deep, st) && c.eligible('models/short.bin', st), 'a path over 255 characters is left as it is');
    }

    // Turned off: everything is unpacked again.
    c.setEnabled(false);
    await c.job;
    const left = (await c.scan([''])).filter(([, st]) => st.size >= 16384 && onDisk(st) < st.size * 0.95);
    ok(!left.length && !fs.existsSync(path.join(dir, 'compact.json')) && all().every(([rel, f]) => sha(f) === before[rel].sha), `off: nothing left compressed, the same files (${left.map(([r]) => r).join()})`);
    ok(spawned.some((a) => a[0] === '/u' && a.includes('/exe')), 'off: unpacked with compact /u /exe');
    const runs = spawned.length;
    await c.run({ gate: false });
    ok(spawned.length === runs, 'off: no pass runs');
  }

  // ---- when passes run, with a pretend compact.exe ---------------------------------------------------------------------
  {
    const dir2 = path.join(root, 'gates');
    const put2 = (rel, data) => { const f = path.join(dir2, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); fs.utimesSync(f, old, old); };
    // (Long names, so the command line's limit is what splits the runs, but within the 255 characters a path may have.)
    const long = Math.min(130, 255 - dir2.length - 16);
    for (let i = 0; i < 150; i++) put2(`models/${'m'.repeat(long)}${i}.bin`, floats(5000 + i));
    put2('play/de_x/world.glb', floats(1e5));
    put2('play/de_y/world.glb', floats(1e5, 2));
    const runs = [];
    let quiet = true, busy = [];
    const c2 = supportedAnyway(new Compactor({ dir: dir2, spawn: fakeSpawn(runs), quiet: () => quiet, busyDirs: () => busy, timing: { poll: 30, debounce: 30 } }));
    c2.setEnabled(true);
    await c2.run();
    const rels = runs.flatMap(files);
    ok(runs.length >= 3 && runs.every((r) => r.opts.cwd === root && r.opts.windowsHide && r.args.slice(0, 4).join(' ') === `/c /exe:${MODE} /i /q`), 'fake: each run in the folder the cache is in, hidden, LZX');
    ok(runs.every((r) => files(r).length <= 64 && files(r).join('   ').length <= 8000) && rels.length === 152 && new Set(rels).size === 152, 'fake: every file once, at most 64 and 8,000 characters a run');
    ok(rels.every((r) => !r.includes('/') && r.startsWith('gates\\')) && rels.includes('gates\\play\\de_x\\world.glb'), 'fake: Windows paths, from the cache\'s folder');
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
    await c2.run({ gate: false });
    ok(runs.length > 0 && !runs.flatMap(files).some((r) => r.startsWith('gates\\play\\de_x\\')) && runs.flatMap(files).includes('gates\\play\\de_y\\world.glb'), 'busy: a map being exported is left alone, even by Prepare\'s own passes');
    busy = [];

    // Prepare's own passes ('hold'): not while a match is on (the pass after it does it), whether or not the game is busy.
    c2.clearMemo();
    runs.length = 0;
    quiet = false;
    c2.hold(true);
    await c2.run({ dirs: ['play/de_y'], settledMs: 0, gate: 'hold' });
    ok(!runs.length && !c2.retry, "prepare's pass: nothing while a match holds it, and no retry of its own");
    c2.hold(false);
    clearTimeout(c2.timer); c2.timer = null; // (the match's own pass: not wanted here)
    await c2.run({ dirs: ['play/de_y'], settledMs: 0, gate: 'hold' });
    ok(runs.length === 1, "prepare's pass: runs with the game busy (Prepare is what keeps it busy)");
    quiet = true;
    // stopped(): Prepare stopped, the pass ends at its next batch.
    {
      const runsS = [], holdS = [];
      const cS = supportedAnyway(new Compactor({ dir: dir2, spawn: fakeSpawn(runsS, holdS) }));
      cS.clearMemo();
      cS.setEnabled(true);
      let stopNow = false;
      const one = cS.run({ gate: 'hold', stopped: () => stopNow });
      for (let i = 0; i < 100 && !holdS.length; i++) await tick(5);
      stopNow = true;
      holdS.shift()();
      await one;
      ok(runsS.length === 1, `prepare's pass: stopped after the batch it was on (${runsS.length} runs)`);
    }

    // Turned on in Settings while a match is on: nothing until it's over.
    c2.clearMemo();
    runs.length = 0;
    c2.enabled = false;
    c2.hold(true);
    c2.setEnabled(true);
    await c2.job;
    ok(!runs.length, 'turned on: nothing while a match is on');
    c2.hold(false);
    for (let i = 0; i < 100 && !runs.length; i++) await tick(10);
    await c2.job;
    ok(runs.length > 0, 'turned on: and compressed once it is over');

    // Turned off (or off at start): unpacking waits for the game to be idle too.
    const c6 = supportedAnyway(new Compactor({ dir: dir2, spawn: fakeSpawn(runs), quiet: () => quiet, timing: { poll: 30, debounce: 30 } }));
    c6.scan = async () => [['play/de_x/world.glb', { size: 4e5, blocks: 100, mtimeMs: 0 }]]; // (as if compressed)
    c6.batch = async (flags, list) => { runs.push({ args: flags, opts: {} }); return { files: list, clean: true }; };
    runs.length = 0;
    c6.setEnabled(false); // (off at start)
    c6.hold(true);
    c6.schedule('map');
    await c6.job;
    ok(!runs.length && !!c6.retry, 'off: nothing unpacked while a match is on (tried again in a while)');
    c6.hold(false);
    for (let i = 0; i < 100 && !runs.some((r) => r.args[0] === '/u'); i++) await tick(10);
    await c6.job;
    ok(runs.some((r) => r.args[0] === '/u'), 'off: unpacked once the match is over');
    c6.stop();

    // A run that ends with an error (compact.exe ended from outside, say) says nothing of its files: nothing noted.
    {
      const failing = (exe, args, opts) => { const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.kill = () => {}; setImmediate(() => p.emit('close', 1)); return p; };
      const c7 = supportedAnyway(new Compactor({ dir: dir2, spawn: failing }));
      c7.clearMemo();
      c7.setEnabled(true);
      await c7.run({ dirs: ['play/de_y'], settledMs: 0, gate: false });
      ok(!Object.keys(c7.loadMemo().skip).length, 'a run that ended with an error notes nothing');
    }

    // Too new for a pass: another once they've settled (not at the next export).
    {
      const fresh = [];
      const c8 = supportedAnyway(new Compactor({ dir: dir2, spawn: fakeSpawn(fresh), timing: { settled: 300, debounce: 10 } }));
      c8.clearMemo();
      c8.setEnabled(true);
      fs.writeFileSync(path.join(dir2, 'play', 'de_y', 'world.glb'), floats(1e5, 3));
      await c8.run({ dirs: ['play/de_y'] });
      ok(!fresh.length && !!c8.freshTimer, 'too new: left, with a pass to come');
      for (let i = 0; i < 400 && !fresh.length; i++) await tick(10);
      await c8.job;
      ok(fresh.flatMap(files).includes('gates\\play\\de_y\\world.glb'), 'too new: compressed by the pass that comes once it has settled');
      c8.stop();
      fs.utimesSync(path.join(dir2, 'play', 'de_y', 'world.glb'), old, old);
    }

    // A compact.exe that never ends: ended (and given up on), and a map's export waiting for it goes on.
    {
      const stuck = [];
      const hang = (exe, args, opts) => { const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.kill = () => { stuck.push('kill'); }; stuck.push(args); return p; };
      const c9 = supportedAnyway(new Compactor({ dir: dir2, spawn: hang, log: () => {}, timing: { watchdog: 50, giveUp: 50, settle: 60000 } }));
      c9.clearMemo();
      c9.setEnabled(true);
      const t0 = Date.now();
      const job9 = c9.run({ gate: false });
      for (let i = 0; i < 50 && !c9.current; i++) await tick(5);
      const waited = c9.settle('play/de_x');
      await job9;
      await waited;
      ok(stuck.filter((x) => x === 'kill').length === 1 && stuck.filter((x) => x !== 'kill').length === 1 && !c9.current && !c9.child && Date.now() - t0 < 5000,
        `stuck: ended, the pass gives up there, and settle() goes on (${Date.now() - t0} ms)`);
      ok(!Object.keys(c9.loadMemo().skip).length, 'stuck: nothing noted');
      // settle() never waits more than its 2 minutes (here 80 ms).
      const c10 = supportedAnyway(new Compactor({ dir: dir2, spawn: hang, log: () => {}, timing: { watchdog: 60000, settle: 80 } }));
      c10.setEnabled(true);
      c10.run({ dirs: ['play/de_x'], settledMs: 0, gate: false });
      for (let i = 0; i < 50 && !c10.current; i++) await tick(5);
      const t1 = Date.now();
      await c10.settle('play/de_x');
      ok(Date.now() - t1 >= 70 && Date.now() - t1 < 2000, `settle: waits at most its limit (${Date.now() - t1} ms)`);
      c10.stop(); // (the pretend one never ends: the script's exit ends it)
    }
    // settle(): a map's export waits for a batch in its folder, not for one elsewhere.
    c2.clearMemo();
    runs.length = 0;
    const hold = [];
    const c3 = supportedAnyway(new Compactor({ dir: dir2, spawn: fakeSpawn(runs, hold) }));
    c3.setEnabled(true);
    const job = c3.run({ dirs: ['play/de_y'], settledMs: 0, gate: false });
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
    await c4.run({ gate: false });
    ok(spawned.length === 1 && !fs.existsSync(path.join(root, 'none', 'compact.json')), 'no compact.exe: a pass does nothing');
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
