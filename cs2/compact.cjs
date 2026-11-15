// Windows' own compression for the CS2 cache (Settings: "Compress the CS2 cache"): WOF, what `compact /c /exe:lzx`
// sets on a file. A compressed file stays compressed on the drive and Windows unpacks it in memory as it's read, so
// everything that reads the cache (the app:// handler, the CLI, the export checks, scripts) gets the same bytes, size
// and time as ever: nothing is unpacked onto the drive while the game plays, and nothing has to be compressed again
// afterwards. Only what gains is compressed (the maps' geometry and baked data, the models' buffers, sounds and text:
// the PNGs and EXRs, more than half the cache, are compressed already), and only once nothing is writing it: a write
// to a compressed file unpacks it (it is compressed again by the next pass), and one while compact.exe is on it fails,
// so a pass never touches a map being exported, waits while the game is busy or a match is on, and a map's export
// waits for a batch in its folder to finish before it rewrites a file there (settle).
// Off an NTFS drive (FAT, exFAT, ReFS, a network share), or where compact.exe can't run, it does nothing (supported()).
const fs = require('fs');
const path = require('path');
const child_process = require('child_process');

const MODE = 'lzx'; // ('xpress16k' compresses 5 times faster and reads as fast, for about 15% less saved)
// What gains: glTF geometry and buffers, the maps' baked data, sounds, text and JSON (at least 16 KB: a smaller file
// can take more room compressed).
const EXT = /\.(glb|bin|wav|gltf|json|txt|svg|frag)$/i;
const MIN = 16384;
// Kept as they are: records the game rewrites in place (each a write that would unpack it again), and tmp files.
const PLAIN = new Set(['map.json', 'prepared.json', 'prepared-maps.json', 'content.json', 'wingman.json', 'files.crc.json', 'exports.crc.json', 'compact.json']);
const TMP = /(^|[\\/])tmp[^\\/]*[\\/]|\.tmp$/i;
// One compact.exe run: at most this many files, characters of command line and bytes (a bigger file goes alone).
const BATCH = { files: 64, chars: 8000, bytes: 128e6 };
// { v, mode, skip: { path: { s: 'size:mtimeMs', n: passes it didn't shrink in, at } } }: files that didn't shrink in two
// passes, not tried again as they are for a week (one another program had open is tried again).
const MEMO = 'compact.json';
const STRIKES = 2, RETRY = 7 * 864e5;
// compact.exe stops at a path longer than Windows' 260 characters (and skips the rest of its run): never given one.
const MAX_PATH = 255;
const PROBE = '.compact-probe.tmp';

// The room a file takes on the drive (Node's blocks are the compressed allocation, as Explorer's "Size on disk").
const onDisk = (st) => (st.blocks != null ? st.blocks * 512 : st.size);
// (Compressed by a pass: a file that small is never compressed, and one of under a KB or so takes no room of its own.)
const packed = (st) => st.size >= MIN && onDisk(st) < st.size * 0.95;
const toPosix = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
const under = (rel, dir) => !dir || rel === dir || rel.startsWith(dir + '/');
const sizeOf = (list) => list.reduce((s, [, st]) => s + st.size, 0);
const stamp = (st) => `${st.size}:${st.mtimeMs}`;
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

// Files (biggest first) in compact.exe runs within BATCH's limits (`extra`: characters each path has in front of it).
function batches(files, extra = 0) {
  const out = [];
  let cur = [], chars = 0, bytes = 0;
  for (const f of files) {
    const [rel, st] = f;
    if (cur.length && (cur.length >= BATCH.files || chars + rel.length + extra + 3 > BATCH.chars || bytes + st.size > BATCH.bytes)) { out.push(cur); cur = []; chars = 0; bytes = 0; }
    cur.push(f);
    chars += rel.length + extra + 3;
    bytes += st.size;
  }
  if (cur.length) out.push(cur);
  return out;
}

class Compactor {
  // dir: the cache. quiet(): is the game idle (no export running or just run)? busyDirs(): cache folders being written
  // now ('play/<id>'), never touched. held(): something else holding passes off. onChange(): a pass changed the sizes.
  // compact.exe runs in the folder the cache is in (its paths start with the cache's name): never in the cache itself,
  // which then couldn't be deleted (Settings' rebuild) while it runs.
  constructor({ dir, log = () => {}, exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'compact.exe'), spawn = child_process.spawn,
    quiet = () => true, busyDirs = () => [], held = () => false, onChange = () => {}, timing = {} }) {
    Object.assign(this, { dir, log, exe, spawn, quiet, busyDirs, held, onChange });
    this.timing = { settled: 120000, poll: 15000, debounce: 5000, hold: 3 * 3600e3, settle: 120000, watchdog: 60000, giveUp: 10000, ...timing };
    const base = path.basename(this.dir);
    this.cwd = base ? path.dirname(this.dir) : this.dir;
    this.pre = base ? base + '\\' : '';
    this.enabled = null; // the setting, once the renderer has said (setEnabled): nothing runs before
    this.ok = null; // can compact.exe compress here (supported())
    this.job = Promise.resolve(); // passes, one at a time
    this.gen = 0; // stop() moves it on: a pass from before ends at its next batch
    this.child = null;
    this.current = null; // the batch compact.exe is working on: { rels, done }
    this.holds = 0;
    this.heldUntil = 0;
    this.memo = null;
    this.progress = null; // { kind: 'compress' | 'uncompress', done, total } (bytes) while a pass runs
    this.saved = 0;
    this.needFree = 0;
    this.error = null;
    this.timer = null;
    this.retry = null;
    this.freshTimer = null; // a pass again once the files too new for the last one have settled
    this.wanted = false; // a pass was asked for before the setting was known
    this.unpackWanted = false; // off at start: unpack what an earlier run left compressed, when the game is first idle
  }

  abs(rel) { return path.join(this.dir, ...rel.split('/')); }
  arg(rel) { return this.pre + rel.replace(/\//g, '\\'); } // (a path as compact.exe gets it, from this.cwd)
  free() { try { const s = fs.statfsSync(this.dir); return s.bavail * s.bsize; } catch { return Infinity; } }
  busy() { try { return (this.busyDirs() || []).map(toPosix); } catch { return []; } }

  // Can files be compressed where the cache is? Once a run of the app: a 64 KB file of one letter compressed and looked
  // at (FAT, exFAT, ReFS and network drives can't, nor a PC where compact.exe is blocked).
  supported() {
    return (this.probe ||= (async () => {
      const f = path.join(this.dir, PROBE);
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(f, Buffer.alloc(65536, 'a'));
        const r = await this.exec(['/c', '/q', '/exe:xpress4k', this.arg(PROBE)]);
        this.ok = !r.error && onDisk(fs.statSync(f)) < 65536;
      } catch { this.ok = false; }
      try { fs.rmSync(f, { force: true }); } catch {}
      if (!this.ok) this.log("Windows can't compress files where the CS2 cache is (not an NTFS drive, or compact.exe can't run): off");
      return this.ok;
    })());
  }

  // Would a pass compress this file (`rel`: its path in the cache)? A file that gains, as it is, not compressed already
  // and not found not to shrink as it is now.
  eligible(rel, st) {
    rel = toPosix(rel);
    if (!EXT.test(rel) || st.size < MIN || TMP.test(rel) || PLAIN.has(path.posix.basename(rel).toLowerCase()) || packed(st)) return false;
    if (this.abs(rel).length > MAX_PATH) return false;
    const e = this.loadMemo().skip[rel];
    return !(e && e.s === stamp(st) && e.n >= STRIKES && Date.now() - e.at < RETRY);
  }

  active() { return this.enabled === true && this.ok !== false; }

  status() {
    const p = this.progress;
    return { supported: this.ok, enabled: this.enabled, running: !!p, kind: p?.kind || null, done: p?.done || 0, total: p?.total || 0, saved: this.saved, needFree: this.needFree, error: this.error };
  }

  // The setting (at start and when the player changes it). On: new exports are compressed from now on, and what's
  // there now as soon as the game is idle when the player has just turned it on. Off: everything is unpacked again once
  // the game is idle (it reads the same compressed, so when there isn't room for it unpacked it stays as it is).
  setEnabled(on) {
    on = !!on;
    const was = this.enabled;
    this.enabled = on;
    if (on) {
      if (was === true) return;
      this.unpackWanted = false;
      this.supported();
      if (was === false) this.run({ reason: 'on' });
      else if (this.wanted) { this.wanted = false; this.schedule('start'); }
    } else if (was === true) {
      this.stop();
      this.uncompress();
    } else if (was === null) this.unpackWanted = true;
  }

  // A pass soon, once the game is idle (after an export, a Prepare run, a match, the app's start).
  schedule(reason) {
    if (this.enabled === false) { if (this.unpackWanted) { this.unpackWanted = false; this.uncompress(); } return; }
    if (this.enabled !== true) { this.wanted = true; return; }
    if (this.ok === false) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.run({ reason }); }, this.timing.debounce);
    this.timer.unref?.();
  }

  // A match is loading or being played (on) or is over (off): passes wait (at most 3 hours, in case the "over" got lost).
  hold(on) {
    if (on) { this.holds++; this.heldUntil = Date.now() + this.timing.hold; return; }
    this.holds = Math.max(0, this.holds - 1);
    if (!this.holds) this.schedule('match'); // (a match exports guns and sounds)
  }
  isHeld() {
    if (this.holds && Date.now() >= this.heldUntil) this.holds = 0;
    return this.holds > 0 || !!this.held();
  }
  // gate 'idle' (the passes the game starts itself, and unpacking): no match on and the game idle; 'hold' (Prepare's
  // own, which keep the game busy): no match on; false: none.
  gateOpen(gate = 'idle') { return !gate || (!this.isHeld() && (gate !== 'idle' || !!this.quiet())); }

  // An idle-gated pass, or the unpacking, that found the game busy: again in a while.
  later() {
    if (this.retry) return;
    this.retry = setTimeout(() => { this.retry = null; if (this.enabled === false) this.uncompress(); else this.run({}); }, this.timing.poll);
    this.retry.unref?.();
  }

  // Compresses what's eligible in `dirs` (cache folders; '' is all of it), files last written at least `settledMs` ago,
  // biggest first. gate (see gateOpen): 'idle' tries again in a while when the game is busy; 'hold' (Prepare's) leaves
  // it to the pass the match's end starts. stopped(): the run that asked for it has been stopped (looked at between
  // batches). Folders being exported are left alone either way.
  run(opts = {}) {
    const gen = this.gen;
    return (this.job = this.job.then(() => (gen === this.gen ? this.pass(opts, gen) : null)).catch((e) => { this.error = e.message; this.log('compress: ' + e.message); }));
  }

  async pass({ dirs = [''], settledMs = this.timing.settled, gate = 'idle', stopped = () => false } = {}, gen) {
    if (this.enabled !== true || !(await this.supported()) || stopped()) return;
    if (!this.gateOpen(gate)) return gate === 'idle' ? this.later() : undefined;
    const busy = this.busy(), all = await this.scan(dirs, busy), now = Date.now();
    if (dirs.some((d) => !toPosix(d))) this.prune(all, busy);
    const want = all.filter(([rel, st]) => this.eligible(rel, st));
    const files = want.filter(([, st]) => now - st.mtimeMs >= settledMs).sort((a, b) => b[1].size - a[1].size);
    // (Files too new for this pass: another once the youngest has settled, so they don't wait for the next export.)
    const young = want.filter(([, st]) => now - st.mtimeMs < settledMs).reduce((m, [, st]) => Math.max(m, st.mtimeMs), 0);
    if (young) this.again(young + this.timing.settled - now + 1000);
    if (!files.length) return this.saveMemo();
    this.progress = { kind: 'compress', done: 0, total: sizeOf(files) };
    let saved = 0, count = 0;
    try {
      for (const batch of batches(files, this.pre.length)) {
        if (gen !== this.gen || this.enabled !== true || stopped()) break;
        if (!this.gateOpen(gate)) { if (gate === 'idle') this.later(); break; }
        const res = await this.batch(['/c', '/exe:' + MODE, '/i', '/q'], batch, gen);
        if (!res || gen !== this.gen) continue;
        const memo = this.loadMemo();
        for (const [rel, st0] of res.files) {
          let st;
          try { st = fs.statSync(this.abs(rel)); } catch { continue; }
          if (packed(st)) { saved += st.size - onDisk(st); count++; if (memo.skip[rel]) { delete memo.skip[rel]; this.memoDirty = true; } }
          // (Didn't shrink: incompressible, or a file another program had open: noted, and left alone once it hasn't in
          // two passes. Not when the run was cut short or failed (stopped, ended from outside, the drive filling up):
          // that says nothing of the files in it.)
          else if (res.clean && stamp(st) === stamp(st0)) {
            const e = memo.skip[rel];
            memo.skip[rel] = { s: stamp(st), n: e?.s === stamp(st) ? (e.n || 0) + 1 : 1, at: Date.now() };
            this.memoDirty = true;
          }
        }
        if (res.failed) break; // (compact.exe stuck or missing: the next pass tries again)
      }
    } finally {
      this.progress = null;
      if (gen === this.gen) { this.saved += saved; this.saveMemo(); }
      this.onChange();
    }
    if (count) this.log(`compressed ${count} files, ${(saved / 1e6).toFixed(0)} MB saved`);
  }

  again(ms) {
    if (this.freshTimer) return;
    this.freshTimer = setTimeout(() => { this.freshTimer = null; this.schedule('settled'); }, Math.max(1000, ms));
    this.freshTimer.unref?.();
  }

  // Unpacks every compressed file (the setting turned off), once the game is idle (no match on, nothing exported for a
  // minute), when the drive has room for them unpacked and 3 GB more.
  uncompress() {
    const gen = this.gen;
    return (this.job = this.job.then(() => (gen === this.gen ? this.unpack(gen) : null)).catch((e) => { this.error = e.message; this.log('uncompress: ' + e.message); }));
  }

  async unpack(gen) {
    if (this.enabled === true || !(await this.supported())) return;
    if (!this.gateOpen()) return this.later();
    const files = (await this.scan([''], this.busy())).filter(([, st]) => packed(st));
    this.needFree = 0;
    if (!files.length) return this.clearMemo();
    const grow = files.reduce((s, [, st]) => s + st.size - onDisk(st), 0);
    if (this.free() < grow + 3e9) { this.needFree = grow + 3e9; this.log(`unpacking needs ${(this.needFree / 1e9).toFixed(1)} GB free: left compressed`); return; }
    this.progress = { kind: 'uncompress', done: 0, total: sizeOf(files) };
    try {
      for (const batch of batches(files, this.pre.length)) {
        if (gen !== this.gen || this.enabled === true) return;
        if (!this.gateOpen()) return this.later();
        if ((await this.batch(['/u', '/exe', '/i', '/q'], batch, gen))?.failed) return;
      }
    } finally {
      this.progress = null;
      if (gen === this.gen) this.saved = 0;
      this.onChange();
    }
    if (gen === this.gen && this.enabled !== true) this.clearMemo();
  }

  // One compact.exe run over a batch: the files still as they were listed (and in no folder an export has started on
  // since), when the drive has room for the run (WOF writes the new copy before it frees the old). { files, clean: it
  // ran to its end, said nothing went wrong, and left the drive room enough }.
  async batch(flags, list, gen) {
    const busy = this.busy(), go = [];
    for (const [rel, st0] of list) {
      if (busy.some((d) => under(rel, d))) continue;
      let st;
      try { st = fs.statSync(this.abs(rel)); } catch { continue; }
      if (stamp(st) === stamp(st0)) go.push([rel, st]);
    }
    const bytes = sizeOf(go);
    if (this.progress) this.progress.done += sizeOf(list) - bytes;
    if (!go.length || gen !== this.gen) return null;
    if (this.free() < 0.5 * bytes + 64e6) {
      this.error = 'the drive is almost full';
      if (this.progress) this.progress.done += bytes;
      return null;
    }
    const res = await this.exec([...flags, ...go.map(([rel]) => this.arg(rel))], go.map(([rel]) => rel), bytes);
    if (res.error) this.log('compact: ' + res.error.message);
    else if (res.code && res.text) this.log('compact: ' + res.text.trim().split(/\r?\n/).slice(-2).join(' / ').slice(0, 300)); // (its text is only ever logged)
    if (this.progress) this.progress.done += bytes;
    return { files: go, failed: !!res.error, clean: !res.error && !res.killed && res.code === 0 && this.free() >= 0.5 * bytes + 64e6 };
  }

  // Runs compact.exe in the folder the cache is in (its paths relative to that). `rels`: the batch (settle() waits for
  // it, stop() ends it). One that hasn't finished in a minute and 30 s per 100 MB of `bytes` is ended (as stuck), and
  // given up on 10 s after that. Resolves { code, killed, text } or { error }, never rejects.
  exec(args, rels = null, bytes = 0) {
    let release;
    const done = new Promise((r) => { release = r; });
    if (rels) this.current = { rels, done };
    return new Promise((resolve) => {
      let p = null, finished = false, watchdog = null;
      const out = [];
      const finish = (r) => {
        if (finished) return;
        finished = true;
        clearTimeout(watchdog);
        if (p && this.child === p) this.child = null;
        if (this.current?.done === done) this.current = null;
        release();
        resolve(r);
      };
      try { p = this.spawn(this.exe, args, { cwd: this.cwd, windowsHide: true }); } catch (e) { return finish({ error: e, killed: false }); }
      if (rels) this.child = p;
      watchdog = setTimeout(() => {
        this.log('compact.exe is taking too long: ended');
        try { p.kill(); } catch {}
        watchdog = setTimeout(() => finish({ error: new Error("compact.exe didn't end"), killed: true }), this.timing.giveUp);
      }, this.timing.watchdog + (bytes / 100e6) * 30000);
      p.stdout?.on('data', (d) => out.push(d));
      p.stderr?.on('data', (d) => out.push(d));
      p.on('error', (e) => finish({ error: e, killed: !!p.killed }));
      p.on('close', (code) => finish({ code, killed: !!p.killed, text: Buffer.concat(out).toString('latin1') }));
    });
  }

  // Waits until compact.exe isn't working on a file in `relDir` (a cache folder): a map's export calls it before it
  // rewrites a file there (a write while compact is on a file fails). Usually seconds; up to a minute or so when it's
  // on El Dorado's 525 MB world.glb, which goes alone. Never more than 2 minutes: the write then goes ahead.
  async settle(relDir) {
    const d = toPosix(relDir), end = Date.now() + this.timing.settle;
    while (this.current && this.current.rels.some((r) => under(r, d)) && Date.now() < end) await Promise.race([this.current.done, sleep(end - Date.now())]);
  }

  // Ends what's running now: the batch's compact.exe is killed (Windows finishes the file it's on, whole and right).
  // Resolves once the pass has stopped.
  stop() {
    this.gen++;
    clearTimeout(this.timer);
    clearTimeout(this.retry);
    clearTimeout(this.freshTimer);
    this.timer = this.retry = this.freshTimer = null;
    if (this.child) { try { this.child.kill(); } catch {} }
    return this.job;
  }

  // The cache was deleted (Settings' rebuild): nothing remembered of it.
  reset() {
    this.memo = null;
    this.memoDirty = false;
    this.saved = 0;
    this.needFree = 0;
    this.error = null;
  }

  // [[rel, stat]] of the files under `dirs`, without the folders in `skip`.
  async scan(dirs, skip = []) {
    const out = [];
    const walk = async (rel) => {
      if (skip.some((d) => under(rel, d) && rel)) return;
      let ents;
      try { ents = await fs.promises.readdir(rel ? this.abs(rel) : this.dir, { withFileTypes: true }); } catch { return; }
      await Promise.all(ents.map(async (e) => {
        const r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) return walk(r);
        if (!e.isFile() || skip.some((d) => under(r, d))) return;
        try { out.push([r, await fs.promises.stat(this.abs(r))]); } catch {}
      }));
    };
    for (const d of new Set(dirs.map(toPosix))) await walk(d);
    return out;
  }

  loadMemo() {
    if (!this.memo) {
      let m = null;
      try { m = JSON.parse(fs.readFileSync(path.join(this.dir, MEMO), 'utf8')); } catch {}
      this.memo = m?.v === 2 && m.mode === MODE && m.skip && typeof m.skip === 'object' ? m : { v: 2, mode: MODE, skip: {} };
      this.memoDirty = false;
    }
    return this.memo;
  }
  saveMemo() {
    if (!this.memo || !this.memoDirty) return;
    const file = path.join(this.dir, MEMO), tmp = file + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify(this.memo)); fs.renameSync(tmp, file); this.memoDirty = false; } catch (e) { this.log(MEMO + ': ' + e.message); }
  }
  clearMemo() {
    this.memo = { v: 2, mode: MODE, skip: {} };
    this.memoDirty = false;
    try { fs.rmSync(path.join(this.dir, MEMO), { force: true }); } catch {}
  }
  // (Files gone since are forgotten; those in folders the scan left alone are kept.)
  prune(all, skip = []) {
    const memo = this.loadMemo(), have = new Set(all.map(([rel]) => rel));
    for (const rel of Object.keys(memo.skip)) if (!have.has(rel) && !skip.some((d) => under(rel, d))) { delete memo.skip[rel]; this.memoDirty = true; }
  }
}

module.exports = { Compactor, onDisk, MODE, batches, MAX_PATH };
