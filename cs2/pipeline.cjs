// Reads the player's local CS2 install (via Source 2 Viewer CLI) to build an index of paint kits, weapon
// composite inputs and models, and extracts models/textures/shaders on demand into a local cache.
// Used by the Electron main process and by dev scripts. Nothing from the game is bundled with the app.
// Caches outlive CS2 updates: each remembers the CRCs of the game files it was made from (the VPK listing has one per
// file), and only what was made from a file the update changed is made again.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { spawn, execFileSync } = require('child_process');
const { parseKV1, splitDataDump } = require('./kv.cjs');
const { listVanity, parseEntities, sceneInfo } = require('./vanity.cjs');

const INDEX_VERSION = 4;
// The pak01 files the index is made from (see CS2.signature).
const INDEX_INPUTS = ['scripts/items/items_game.txt', 'weapons/paints/', 'gloves/paints/', 'materials/models/weapons/customization/paints/vmats/',
  'workshop/paintkits/', 'items/assets/paintkits/', /composite_inputs\.vmat_c$/];

// CLI runs made inside CS2.background() (Prepare all) go in a lane of their own, next to the player's (which never
// wait for them), at a lower CPU priority.
const lowPriority = new AsyncLocalStorage();

// VPK paths in -f lists short enough for one command line (a background run is kept short: the player may be waiting
// for a file it's extracting).
function chunks(list, max) {
  const out = [];
  let cur = [], len = 0;
  for (const f of list) {
    if (cur.length && len + f.length + 1 > max) { out.push(cur); cur = []; len = 0; }
    cur.push(f);
    len += f.length + 1;
  }
  if (cur.length) out.push(cur);
  return out;
}
const chunkSize = () => (lowPriority.getStore() ? 5000 : 24000);
// A cached file's key in the CRC records: its path in the cache.
const toKey = (cacheDir, file) => path.relative(cacheDir, file).replace(/\\/g, '/');

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
// Parameters a weapon's composite_inputs material provides to the paint shader.
const WEAPON_KEYS = ['g_tAmbientOcclusion', 'g_tColor', 'g_tMasks', 'g_tMetalness', 'g_tPosition', 'g_tSurface',
  'g_flUvScale1', 'g_flWeaponLength1', 'F_SEPARATE_CHANNEL_INPUTS'];

// ---- locating the game --------------------------------------------------------------------
function steamRoots() {
  const roots = [];
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { encoding: 'utf8', windowsHide: true });
    const m = out.match(/SteamPath\s+REG_SZ\s+(.+)/);
    if (m) roots.push(m[1].trim().replace(/\//g, '\\'));
  } catch {}
  roots.push('C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam');
  return [...new Set(roots)];
}

function findGameDir() {
  const libs = new Set();
  for (const root of steamRoots()) {
    const vdf = path.join(root, 'steamapps', 'libraryfolders.vdf');
    if (!fs.existsSync(vdf)) continue;
    libs.add(root);
    try {
      const kv = parseKV1(fs.readFileSync(vdf, 'utf8'));
      for (const v of Object.values(kv.libraryfolders || {})) if (v && v.path) libs.add(v.path.replace(/\\\\/g, '\\'));
    } catch {}
  }
  for (const lib of libs) {
    const dir = path.join(lib, 'steamapps', 'common', 'Counter-Strike Global Offensive', 'game', 'csgo');
    try { if (fs.existsSync(path.join(dir, 'pak01_dir.vpk'))) return dir; } catch {}
  }
  return null;
}

// ---- helpers ------------------------------------------------------------------------------
const params = (mat) => {
  const p = { ints: {}, floats: {}, vectors: {}, textures: {}, strings: {} };
  for (const x of mat.m_intParams || []) p.ints[x.m_name] = x.m_nValue;
  for (const x of mat.m_floatParams || []) p.floats[x.m_name] = x.m_flValue;
  for (const x of mat.m_vectorParams || []) p.vectors[x.m_name] = x.m_value;
  for (const x of mat.m_textureParams || []) p.textures[x.m_name] = x.m_pValue;
  for (const x of mat.m_stringAttributes || []) p.strings[x.m_name] = x.m_value;
  return p;
};
const base = (p) => p.replace(/\\/g, '/').split('/').pop().replace(/\.[^.]+$/, '');

// A loose variable from a composite container -> { value, min, max, kind }
function looseVar(v) {
  const t = v.m_nVariableType || '';
  if (v.m_strTextureRuntimeResourcePath != null) return { kind: 'texture', value: v.m_strTextureRuntimeResourcePath };
  if (v.m_cValueColor4 != null) return { kind: 'color', value: v.m_cValueColor4.slice(0, 3).map((c) => c / 255) };
  if (t.includes('BOOLEAN') || v.m_bValueBoolean != null) return { kind: 'int', value: v.m_bValueBoolean ? 1 : 0 };
  if (t.includes('INTEGER')) return { kind: 'int', value: v.m_nValueIntX ?? 0 };
  if (t.includes('FLOAT2') || v.m_flValueFloatY != null) {
    return {
      kind: 'float2', value: [v.m_flValueFloatX ?? 0, v.m_flValueFloatY ?? 0],
      min: v.m_bHasFloatBounds || v.m_flValueFloatX_Min != null ? [v.m_flValueFloatX_Min ?? 0, v.m_flValueFloatY_Min ?? 0] : null,
      max: v.m_bHasFloatBounds || v.m_flValueFloatX_Max != null ? [v.m_flValueFloatX_Max ?? 0, v.m_flValueFloatY_Max ?? 0] : null,
    };
  }
  if (t.includes('STRING')) return { kind: 'string', value: v.m_strStringValue ?? '' };
  return {
    kind: 'float', value: v.m_flValueFloatX ?? 0,
    min: v.m_flValueFloatX_Min ?? null, max: v.m_flValueFloatX_Max ?? null,
  };
}

// Is an exported glTF whole? (an export cut short when the app closed leaves a short .bin/.glb or missing textures)
function gltfComplete(file) {
  try {
    if (file.endsWith('.glb')) {
      const fd = fs.openSync(file, 'r'), h = Buffer.alloc(12);
      fs.readSync(fd, h, 0, 12, 0);
      fs.closeSync(fd);
      return h.readUInt32LE(0) === 0x46546c67 && fs.statSync(file).size >= h.readUInt32LE(8);
    }
    const g = JSON.parse(fs.readFileSync(file, 'utf8'));
    const dir = path.dirname(file);
    const ok = (uri) => fs.existsSync(path.join(dir, decodeURIComponent(uri)));
    return (g.buffers || []).every((b) => !b.uri || (ok(b.uri) && fs.statSync(path.join(dir, decodeURIComponent(b.uri))).size >= b.byteLength))
      && (g.images || []).every((im) => !im.uri || ok(im.uri));
  } catch { return false; }
}

// What each cached file was made from and that file's CRC (<cache>/<name>.crc.json: { stamp, files: { key: [VPK path,
// CRC] } }), so a CS2 update redoes only what it changed. The first time it's used after an update, every entry is
// checked against the listing and the files made from a changed (or removed) VPK file are deleted (`drop`), to be made
// again when next asked for. Files made before there was a record are taken as they are.
class CrcRecord {
  constructor(cs2, name, drop) {
    this.cs2 = cs2;
    this.file = path.join(cs2.cacheDir, name + '.crc.json');
    this.drop = drop;
    this.data = null;
    this.checked = null;
    this.timer = null;
  }

  // Checked once per run of the app (files it has handed out stay where they are until the next).
  ready() {
    this.checked ||= (async () => {
      try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {}
      if (!this.data?.files) this.data = { stamp: this.cs2.vpkStamp(), files: {} };
      const stamp = this.cs2.vpkStamp();
      if (this.data.stamp === stamp) return;
      let files;
      try { files = await this.cs2.listing(); } catch (e) { this.cs2.log('cache check: ' + e.message); return; }
      let dropped = 0;
      for (const [key, [src, crc]] of Object.entries(this.data.files)) {
        if (files.get(src) === crc) continue;
        try { this.drop(key, src); } catch {}
        delete this.data.files[key];
        dropped++;
      }
      this.data.stamp = stamp;
      this.save(true);
      this.cs2.log(`CS2 was updated: ${dropped} of the cached files in ${path.basename(this.file)} changed and will be made again`);
    })();
    return this.checked;
  }

  has(key) { return !!this.data?.files[key]; }

  // Remembers the CRC a file was just made from (or, made before there was a record, is taken to be from).
  async note(key, src) {
    const crc = (await this.cs2.listing().catch(() => null))?.get(src);
    if (!crc || !this.data) return;
    this.data.files[key] = [src, crc];
    this.save();
  }

  save(now = false) {
    clearTimeout(this.timer);
    this.timer = null;
    const write = () => { this.timer = null; try { writeAtomic(this.file, JSON.stringify(this.data)); } catch (e) { this.cs2.log('cache record: ' + e.message); } };
    if (now) write();
    else { this.timer = setTimeout(write, 2000); this.timer.unref?.(); }
  }

  flush() { if (this.timer) this.save(true); }
}

class CS2 {
  constructor({ cli, gameDir, cacheDir, env = {}, log = () => {} }) {
    this.cli = cli;
    this.gameDir = gameDir;
    this.vpk = path.join(gameDir, 'pak01_dir.vpk');
    this.shaderVpk = path.join(gameDir, 'shaders_vulkan_dir.vpk');
    this.cacheDir = cacheDir;
    this.env = env;
    this.log = log;
    this.lanes = { fg: Promise.resolve(), bg: Promise.resolve() };
    this.inflight = new Map(); // output file -> the job making it
    this.batches = {}; // extract() requests waiting to share a CLI run, by root and lane
    fs.mkdirSync(cacheDir, { recursive: true });
    this.extracted = new CrcRecord(this, 'files', (key, src) => {
      const p = this.localPathFor(src, key.slice(0, key.indexOf('/')));
      if (p) fs.rmSync(p, { force: true });
    });
    // Exported glTFs: a .gltf has a folder of its own (with its textures), a .glb is one file in a shared one.
    this.exported = new CrcRecord(this, 'exports', (key) => {
      const out = path.join(this.cacheDir, key);
      fs.rmSync(key.endsWith('.gltf') ? path.dirname(out) : out, { recursive: true, force: true });
    });
  }

  // Writes the cache records out now (when the app quits).
  flush() { this.extracted.flush(); this.exported.flush(); }

  // Runs fn with every CLI run it makes in the background lane.
  background(fn) { return lowPriority.run(true, fn); }

  // One job per output at a time: an output another job is already making is waited for.
  once(key, fn) {
    if (!this.inflight.has(key)) {
      const job = fn().finally(() => this.inflight.delete(key));
      this.inflight.set(key, job);
    }
    return this.inflight.get(key);
  }

  // Runs the CLI, one run at a time in each lane (the tool preloads the whole VPK on each start).
  run(args, { capture = true, env = {} } = {}) {
    const low = !!lowPriority.getStore();
    const job = () => new Promise((resolve, reject) => {
      const p = spawn(this.cli, args, { env: { ...process.env, ...this.env, ...env }, windowsHide: true });
      if (low && p.pid) { try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {} }
      const out = [], err = [];
      p.stdout.on('data', (d) => capture && out.push(d));
      p.stderr.on('data', (d) => err.push(d));
      p.on('error', reject);
      p.on('close', (code) => {
        const text = Buffer.concat(out).toString('utf8');
        if (code !== 0 && !text) reject(new Error(`Source2Viewer-CLI exited ${code}: ${Buffer.concat(err).toString().slice(0, 500)}`));
        else resolve(text);
      });
    });
    const lane = low ? 'bg' : 'fg';
    const r = this.lanes[lane].then(job, job);
    this.lanes[lane] = r.catch(() => {});
    return r;
  }

  // The game build (pak01's size and time): when it's the one a cache was made on, the cache holds.
  vpkStamp() {
    const st = fs.statSync(this.vpk);
    return `${st.size}-${Math.round(st.mtimeMs)}`;
  }

  // Every file in pak01 with its CRC and size ("crc:size"): Map(path -> crc), listed once per game build (kept in
  // listing.txt).
  listing() {
    const stamp = this.vpkStamp();
    if (this.listingJob?.stamp !== stamp) {
      const file = path.join(this.cacheDir, 'listing.txt');
      const job = (async () => {
        let text = null;
        try { const t = fs.readFileSync(file, 'utf8'); if (t.startsWith(stamp + '\n')) text = t.slice(stamp.length + 1); } catch {}
        if (text == null) {
          const lines = [];
          for (const l of (await this.run(['-i', this.vpk, '-l'])).split(/\r?\n/)) {
            const m = /^(.+) CRC:(\w+) size:(\d+)$/.exec(l);
            if (m) lines.push(`${m[1]}\t${m[2]}:${m[3]}`);
          }
          if (!lines.length) throw new Error('Could not list the files in CS2');
          text = lines.join('\n');
          writeAtomic(file, stamp + '\n' + text);
        }
        const files = new Map();
        for (const l of text.split('\n')) { const t = l.indexOf('\t'); if (t > 0) files.set(l.slice(0, t), l.slice(t + 1)); }
        return files;
      })();
      job.stamp = stamp;
      job.catch(() => { if (this.listingJob === job) this.listingJob = null; });
      this.listingJob = job;
    }
    return this.listingJob;
  }

  // A signature of the pak01 files a cache is made from (`inputs`: paths, folders ending in '/', regexes), the same
  // until one of them changes, is added or goes.
  async signature(inputs) {
    const files = await this.listing();
    const exact = inputs.filter((s) => typeof s === 'string' && !s.endsWith('/'));
    const folders = inputs.filter((s) => typeof s === 'string' && s.endsWith('/'));
    const res = inputs.filter((s) => s instanceof RegExp);
    const lines = exact.map((f) => `${f} ${files.get(f) || '-'}`);
    if (folders.length || res.length) {
      for (const [f, crc] of files) if (folders.some((p) => f.startsWith(p)) || res.some((r) => r.test(f))) lines.push(`${f} ${crc}`);
    }
    return crypto.createHash('sha1').update(lines.sort().join('\n')).digest('hex');
  }

  // A JSON cache made from pak01 files (`inputs`, see signature()) if it still holds: made on this game build, or on an
  // earlier one from the same files (a CS2 update that left them alone: it's stamped with this build). null when it
  // has to be made again (and written with save()). `ok(cache)`: is it the current format? The cache keeps the
  // signature as `sig`.
  async cached(file, inputs, ok = () => true) {
    let c;
    try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
    if (!c || !ok(c)) return null;
    const stamp = this.vpkStamp();
    if (c.stamp === stamp && c.sig) return c;
    let now;
    try { now = await this.signature(inputs); } catch (e) { this.log('cache check: ' + e.message); return c.stamp === stamp ? c : null; }
    if (c.stamp !== stamp && c.sig !== now) return null;
    if (c.stamp !== stamp) this.log(`CS2 was updated, but not the files ${path.relative(this.cacheDir, file)} is made from: kept`);
    c.stamp = stamp;
    c.sig = now;
    writeAtomic(file, JSON.stringify(c));
    return c;
  }

  async save(file, data, inputs) {
    const c = { ...data, stamp: this.vpkStamp(), sig: await this.signature(inputs).catch(() => undefined) };
    writeAtomic(file, JSON.stringify(c));
    return c;
  }

  // A map's (or any single VPK's) content signature: its files' CRCs. Steam rewrites every map's VPK in some CS2
  // updates, most with nothing in them changed.
  async vpkContent(vpk) {
    const lines = (await this.run(['-i', vpk, '-l'])).split(/\r?\n/).filter((l) => / CRC:/.test(l)).sort();
    if (!lines.length) throw new Error('Could not list ' + path.basename(vpk));
    return crypto.createHash('sha1').update(lines.join('\n')).digest('hex');
  }

  async dump(filter, ext, vpk = this.vpk) {
    const args = ['-i', vpk, '-f', filter, '-b', 'DATA'];
    if (ext) args.push('-e', ext);
    return splitDataDump(await this.run(args));
  }

  // Every file in pak01.
  async list() { return [...(await this.listing()).keys()]; }

  // Extract (and decompile) VPK files into the cache, preserving their paths. Returns local paths.
  // `raw` keeps textures exactly as the shaders sample them (no normal map reconstruction), in files-raw/.
  async extract(files, { raw = false } = {}) {
    const root = raw ? 'files-raw' : 'files';
    const want = [...new Set(files.map((f) => f.replace(/\\/g, '/').replace(/(\.v\w+)$/, '$1_c').replace(/_c_c$/, '_c')))];
    await this.extracted.ready();
    const missing = want.filter((f) => !this.localPathFor(f, root));
    if (missing.length) await this.extractNow(root, raw, missing);
    const out = {};
    for (const f of want) {
      out[f] = this.localPathFor(f, root);
      if (out[f] && !this.extracted.has(root + '/' + f)) await this.extracted.note(root + '/' + f, f);
    }
    return out;
  }

  // Extracts files that aren't in the cache: requests made close together share CLI runs, and a file already on its
  // way is waited for rather than extracted twice.
  extractNow(root, raw, files) {
    const lane = lowPriority.getStore() ? 'bg' : 'fg', key = root + ':' + lane;
    let batch = this.batches[key];
    if (!batch) {
      let release;
      batch = this.batches[key] = { files: [], done: new Promise((r) => { release = r; }) };
      setTimeout(async () => {
        delete this.batches[key];
        try {
          for (const list of chunks(batch.files, chunkSize())) {
            const args = ['-i', this.vpk, '-f', list.join(','), '-d', '-o', path.join(this.cacheDir, root)];
            if (raw) args.push('--texture_decode_flags', 'none');
            await this.run(args).catch((e) => this.log('extract: ' + e.message));
          }
        } finally {
          for (const f of batch.files) this.inflight.delete(root + '/' + f);
          release();
        }
      }, 15);
    }
    const waits = new Set();
    for (const f of files) {
      const busy = this.inflight.get(root + '/' + f);
      if (busy) { waits.add(busy); continue; }
      batch.files.push(f);
      this.inflight.set(root + '/' + f, batch.done);
      waits.add(batch.done);
    }
    return Promise.all(waits);
  }

  // Decompiled texture lands as .png or .exr next to the VPK-relative path.
  localPathFor(vpkFile, root = 'files') {
    const rel = vpkFile.replace(/_c$/, '');
    if (rel.endsWith('.vsnd')) {
      for (const ext of ['.wav', '.mp3']) {
        const p = path.join(this.cacheDir, root, rel.replace(/\.vsnd$/, ext));
        if (fs.existsSync(p)) return p;
      }
      return null;
    }
    const stem = path.join(this.cacheDir, root, rel.replace(/\.vtex$/, ''));
    for (const ext of ['.png', '.exr', '']) {
      const p = rel.endsWith('.vtex') ? stem + ext : path.join(this.cacheDir, root, rel);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    }
    return null;
  }

  // Parameters of compiled materials ({ path: { shader, ints, floats, vectors, textures } }), many per CLI run.
  async materialParams(vmats) {
    const out = {};
    for (const list of chunks(vmats.map((f) => f.replace(/\.vmat$/, '.vmat_c')), chunkSize())) {
      const docs = await this.dump(list.join(','), null);
      for (const [p, mat] of Object.entries(docs)) {
        const { ints, floats, vectors, textures } = params(mat);
        out[p] = { shader: (mat.m_shaderName || '').replace(/\.vfx$/, ''), ints, floats, vectors, textures };
      }
    }
    return out;
  }

  async exportModel(vmdl) {
    const name = base(vmdl), src = vmdl.replace(/(\.vmdl)$/, '$1_c');
    const dir = path.join(this.cacheDir, 'models', name);
    const file = path.join(dir, name + '.gltf'), key = toKey(this.cacheDir, file);
    await this.exported.ready();
    return this.once(file, async () => {
      if (fs.existsSync(file) && gltfComplete(file)) {
        if (!this.exported.has(key)) await this.exported.note(key, src);
        return file;
      }
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      await this.run(['-i', this.vpk, '-f', src, '-d', '-o', file, '--gltf_export_format', 'gltf', '--gltf_export_materials', '--gltf_textures_adapt']);
      if (!fs.existsSync(file)) throw new Error('Model export failed for ' + vmdl);
      await this.exported.note(key, src);
      return file;
    });
  }

  // Exports any model/animation resource to glTF in the cache (first-person arms and inspect clips).
  async exportGltf(file, rel, { materials = false, glb = false, animations = false } = {}) {
    const out = path.join(this.cacheDir, rel), src = file.replace(/(\.v\w+)$/, '$1_c').replace(/_c_c$/, '_c'), key = toKey(this.cacheDir, out);
    await this.exported.ready();
    return this.once(out, async () => {
      if (fs.existsSync(out) && gltfComplete(out)) {
        if (!this.exported.has(key)) await this.exported.note(key, src);
        return out;
      }
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const args = ['-i', this.vpk, '-f', src, '-o', out, '--gltf_export_format', glb ? 'glb' : 'gltf'];
      if (materials) args.push('--gltf_export_materials', '--gltf_textures_adapt');
      if (animations) args.push('--gltf_export_animations');
      await this.run(args);
      for (const f of fs.readdirSync(path.dirname(out))) if (/_physics.(glb|gltf)$/i.test(f)) fs.rmSync(path.join(path.dirname(out), f), { force: true });
      if (!fs.existsSync(out)) throw new Error('Export failed for ' + file);
      await this.exported.note(key, src);
      return out;
    });
  }

  // Exports many models/animation clips to .glb in one CLI run (each run reloads the VPK), keeping their VPK paths
  // under cacheDir/rel. Returns { vpkFile: localPath | null }.
  async exportGlbBatch(files, rel) {
    const root = path.join(this.cacheDir, rel);
    const out = (f) => path.join(root, f.replace(/_c$/, '').replace(/\.[^./]+$/, '.glb'));
    await this.exported.ready();
    const waits = [], missing = [];
    for (const f of new Set(files)) {
      if (this.inflight.has(out(f))) waits.push(this.inflight.get(out(f)));
      else if (!fs.existsSync(out(f)) || !gltfComplete(out(f))) missing.push(f);
      else if (!this.exported.has(toKey(this.cacheDir, out(f)))) await this.exported.note(toKey(this.cacheDir, out(f)), f);
    }
    if (missing.length) {
      const job = (async () => {
        for (const list of chunks(missing, chunkSize())) await this.run(['-i', this.vpk, '-f', list.join(','), '-o', root, '--gltf_export_format', 'glb']);
        for (const f of missing) if (fs.existsSync(out(f))) await this.exported.note(toKey(this.cacheDir, out(f)), f);
      })().finally(() => { for (const f of missing) this.inflight.delete(out(f)); });
      for (const f of missing) this.inflight.set(out(f), job);
      waits.push(job);
    }
    await Promise.all(waits);
    return Object.fromEntries(files.map((f) => [f, fs.existsSync(out(f)) ? out(f) : null]));
  }

  // The inspect/menu backdrops in this install (maps/<id>_vanity.vpk).
  vanityMaps() {
    return listVanity(path.join(this.gameDir, 'maps'));
  }

  // Exports one backdrop's world to glTF (with its materials) and its entities to scene.json. Cached.
  async exportVanity(id) {
    const map = this.vanityMaps().find((m) => m.id === id);
    if (!map) throw new Error('Unknown backdrop ' + id);
    const vpk = path.join(this.gameDir, 'maps', map.vpk);
    const base = map.vpk.replace(/.vpk$/i, '');
    const dir = path.join(this.cacheDir, 'vanity', id);
    const glb = path.join(dir, 'scene.glb'), meta = path.join(dir, 'scene.json');
    if (fs.existsSync(glb) && fs.existsSync(meta)) return { glb, meta, fresh: false };
    fs.mkdirSync(dir, { recursive: true });
    await this.run(['-i', vpk, '-f', `maps/${base}/world.vwrld_c`, '-d', '-o', glb,
      '--gltf_export_format', 'glb', '--gltf_export_materials', '--gltf_textures_adapt']);
    if (!fs.existsSync(glb)) throw new Error('Backdrop export failed for ' + id);
    for (const f of fs.readdirSync(dir)) if (/_physics.glb$/i.test(f)) fs.rmSync(path.join(dir, f), { force: true });
    const entDir = path.join(dir, 'ents');
    await this.run(['-i', vpk, '-f', `maps/${base}/entities/default_ents.vents_c`, '-d', '-o', entDir]);
    const entFile = path.join(entDir, 'maps', base, 'entities', 'default_ents.vents');
    const info = fs.existsSync(entFile) ? sceneInfo(parseEntities(fs.readFileSync(entFile, 'utf8'))) : {};
    fs.rmSync(entDir, { recursive: true, force: true });
    fs.writeFileSync(meta, JSON.stringify({ id, name: map.name, ...info }));
    return { glb, meta, fresh: true };
  }

  // GLSL ES 3.00 for one static combo of a compiled pixel shader (needs the patched CLI).
  // `es` picks the GLSL ES version SPIRV-Cross targets: 310 for shaders it can't express in 3.00 (arrays of arrays),
  // which the renderer then converts.
  async shaderSource(shader, combo, { es = 300 } = {}) {
    const key = `${shader}__${combo.replace(/[^\w=,]/g, '').replace(/[=,]/g, '_')}${es === 300 ? '' : '__es' + es}`;
    const file = path.join(this.cacheDir, 'shaders', key + '.frag');
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
    return this.once(file, async () => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const text = await this.run(['-i', this.shaderVpk, '-f', `shaders/vfx/${shader}_vulkan_50_ps.vcs`, '--shader_combo', combo, '-q'],
        { env: { VRF_GLSL_ES_VERSION: String(es) } });
      if (!new RegExp(`#version ${es} es`).test(text)) throw new Error('Shader decompile failed: ' + text.slice(0, 300));
      fs.writeFileSync(file, text);
      return text;
    });
  }

  // ---------------------------------------------------------------------------------------
  async buildIndex() {
    const indexFile = path.join(this.cacheDir, 'index.json');
    const igFile = path.join(this.cacheDir, 'items_game.txt');
    const cur = fs.existsSync(igFile) && await this.cached(indexFile, INDEX_INPUTS, (c) => c.version === INDEX_VERSION);
    if (cur) return cur;

    this.log('Reading items_game.txt…');
    await this.run(['-i', this.vpk, '-f', 'scripts/items/items_game.txt', '-o', igFile]);
    const ig = parseKV1(fs.readFileSync(igFile, 'utf8')).items_game;

    this.log('Reading paint kits…');
    const compmats = await this.dump('weapons/paints/', 'vcompmat_c');
    const gloveMats = await this.dump('gloves/paints/', 'vcompmat_c,vmat_c');
    const paintVmats = await this.dump('materials/models/weapons/customization/paints/vmats/', 'vmat_c');
    const templates = await this.dump('workshop/paintkits/', 'vmat_c');
    const assetPaints = await this.dump('items/assets/paintkits/', 'vmat_c');
    this.log('Reading weapon composite inputs…');
    const all = await this.list();
    const inputFiles = all.filter((f) => /composite_inputs\.vmat_c$/.test(f));
    const inputs = {};
    for (let i = 0; i < inputFiles.length; i += 60) Object.assign(inputs, await this.dump(inputFiles.slice(i, i + 60).join(','), null));

    const materials = { ...paintVmats, ...templates, ...gloveMats, ...assetPaints };
    const compByName = {}, compByPath = {};
    for (const [p, doc] of Object.entries({ ...compmats, ...gloveMats })) {
      if (!p.endsWith('.vcompmat')) continue;
      compByPath[p] = { path: p, doc };
      if (!base(p).startsWith('_')) compByName[base(p)] = compByPath[p];
    }

    // Weapon composite inputs keyed by the weapon material they belong to (glTF material name).
    const inputsByMaterial = {};
    for (const [p, mat] of Object.entries(inputs)) {
      const pr = params(mat);
      const layer = pr.strings.layer_name_1;
      if (!layer) continue;
      inputsByMaterial[base(layer)] = {
        path: p,
        separate: pr.ints.F_SEPARATE_CHANNEL_INPUTS || 0,
        uvScale: pr.floats.g_flUvScale1 ?? 1,
        weaponLength: pr.floats.g_flWeaponLength1 ?? 36,
        textures: pr.textures,
      };
    }

    // Weapons: model per item (resolving prefabs).
    const resolve = (item, key) => {
      let cur = item, guard = 0;
      while (cur && guard++ < 20) {
        if (cur[key]) return cur[key];
        const pf = cur.prefab && ig.prefabs[cur.prefab.split(' ')[0]];
        cur = pf;
      }
      return null;
    };
    const weapons = {};
    for (const item of Object.values(ig.items || {})) {
      if (!item || !item.name) continue;
      const model = resolve(item, 'model_player');
      if (model && /\.vmdl$/.test(model)) weapons[item.name] = { model };
    }

    this.log('Resolving paint kits…');
    const paints = {};
    for (const [id, kit] of Object.entries(ig.paint_kits || {})) {
      if (!kit || !kit.name || kit.name === 'default') continue;
      const comp = compByName[kit.name];
      if (!comp) continue;
      try {
        paints[kit.name] = this.resolvePaint(kit, +id, comp, compByPath, materials);
      } catch (e) {
        this.log(`  skipped ${kit.name}: ${e.message}`);
      }
    }

    const index = await this.save(indexFile, { version: INDEX_VERSION, builtAt: new Date().toISOString(), weapons, inputs: inputsByMaterial, paints }, INDEX_INPUTS);
    this.log(`Indexed ${Object.keys(paints).length} paint kits, ${Object.keys(inputsByMaterial).length} weapon materials.`);
    return index;
  }

  // Runs the composite-material program far enough to know, for the colour and roughness passes,
  // which shader variant and parameters are used and which variables the seed randomises.
  resolvePaint(kit, id, comp, compByPath, materials) {
    const procs = [];
    const collect = (doc, seen = new Set()) => {
      for (const point of doc.m_Points || []) {
        for (const proc of point.m_vecCompositeMaterialAssemblyProcedures || []) {
          for (const inc of proc.m_vecCompMatIncludes || []) {
            const n = inc.replace(/\\/g, '/');
            if (!seen.has(n) && compByPath[n]) { seen.add(n); collect(compByPath[n].doc, seen); }
          }
          procs.push(proc);
        }
      }
    };
    collect(comp.doc);

    // Containers (later procedures override earlier ones with the same alias).
    const containers = {};
    let paintMaterial = null;
    for (const proc of procs) {
      for (const c of proc.m_vecCompositeInputContainers || []) {
        const type = c.m_nCompositeMaterialInputContainerSourceType;
        const alias = c.m_strAlias;
        if (type === 'CONTAINER_SOURCE_TYPE_SPECIFIC_MATERIAL') {
          const mp = (c.m_strSpecificContainerMaterial || '').replace(/\\/g, '/');
          const mat = materials[mp];
          if (alias === 'paint') paintMaterial = mp;
          if (mat) containers[alias] = { kind: 'material', vars: materialVars(mat) };
        } else if (type === 'CONTAINER_SOURCE_TYPE_LOOSE_VARIABLES' && (c.m_vecLooseVariables || []).some((v) => v.m_strResourceMaterial)) {
          const mp = c.m_vecLooseVariables.find((v) => v.m_strResourceMaterial).m_strResourceMaterial.replace(/\\/g, '/');
          const mat = materials[mp];
          if (alias === 'paint') paintMaterial = mp;
          if (mat) containers[alias] = { kind: 'material', vars: materialVars(mat) };
        } else if (type === 'CONTAINER_SOURCE_TYPE_LOOSE_VARIABLES') {
          const prev = containers[alias]?.vars || {};
          const vars = { ...prev };
          for (const v of c.m_vecLooseVariables || []) vars[v.m_strName] = looseVar(v);
          containers[alias] = { kind: 'loose', vars };
        } else if (type === 'CONTAINER_SOURCE_TYPE_MATERIAL_FROM_TARGET_ATTR') {
          containers[alias] = { kind: 'weapon' };
        } else {
          containers[alias] = containers[alias] || { kind: 'target' };
        }
      }
    }
    if (!paintMaterial || !containers.paint) throw new Error('no paint material');

    // Randomised variables, in roll order.
    const rolls = [];
    const rollSets = [];
    const walk = (list, fn) => { for (const m of list || []) { fn(m); if (m.m_vecConditionalMutators) walk(m.m_vecConditionalMutators, fn); } };
    for (const proc of procs) {
      walk(proc.m_vecPropertyMutators, (m) => {
        if (m.m_nMutatorCommandType !== 'COMP_MAT_PROPERTY_MUTATOR_RANDOM_ROLL_INPUT_VARIABLES') return;
        rollSets.push({
          seed: (m.m_strRandomRollInputVars_SeedInputVar || '').split('.').pop(),
          conds: (m.m_vecConditions || []).map((c) => ({
            on: c.m_strMutatorConditionContainerName + '.' + c.m_strMutatorConditionContainerVarName,
            exists: c.m_nMutatorCondition === 'COMP_MAT_MUTATOR_CONDITION_INPUT_CONTAINER_VALUE_EXISTS',
            value: c.m_strMutatorConditionContainerVarValue, not: c.m_bPassWhenTrue === false,
          })),
          vars: (m.m_vecRandomRollInputVars_InputVarsToRoll || []).map((spec) => {
            const [alias, name, comps] = spec.split('.');
            const v = containers[alias]?.vars?.[name];
            return v ? { alias, name, comps: comps.length, min: v.min, max: v.max } : { alias, name, comps: comps.length, consume: true };
          }),
        });
        if (!/g_nRandomSeed$/.test(m.m_strRandomRollInputVars_SeedInputVar || '')) return;
        for (const spec of m.m_vecRandomRollInputVars_InputVarsToRoll || []) {
          const [alias, name, comps] = spec.split('.');
          const v = containers[alias]?.vars?.[name];
          if (!v) continue;
          rolls.push({ alias, name, comps: comps.length, min: v.min, max: v.max });
        }
      });
    }

    // Evaluate GENERATE_TEXTURE programs for colour and roughness passes.
    const passes = {};
    const finalProps = {};
    const condOk = (conds) => (conds || []).every((c) => {
      const v = containers[c.m_strMutatorConditionContainerName]?.vars?.[c.m_strMutatorConditionContainerVarName];
      let ok = true;
      if (c.m_nMutatorCondition === 'COMP_MAT_MUTATOR_CONDITION_INPUT_CONTAINER_VALUE_EXISTS') ok = v != null;
      else if (c.m_nMutatorCondition === 'COMP_MAT_MUTATOR_CONDITION_INPUT_CONTAINER_VALUE_EQUALS') {
        const want = c.m_strMutatorConditionContainerVarValue;
        const have = v?.value;
        ok = String(have === true ? 1 : have === false ? 0 : have) === String(want === 'true' ? 1 : want === 'false' ? 0 : want);
      }
      return c.m_bPassWhenTrue === false ? !ok : ok;
    });
    const copyFrom = (alias, into) => {
      const c = containers[alias];
      if (!c) return;
      if (c.kind === 'weapon') {
        for (const k of WEAPON_KEYS) into[k] = { kind: 'weapon', name: k };
        return;
      }
      for (const [k, v] of Object.entries(c.vars || {})) {
        if (k === '$shader' && into.$shader) continue;
        if (alias === 'econ_instance' || alias === 'grunge_wear') into[k] = { kind: 'instance', alias, name: k, base: v };
        else into[k] = v;
      }
    };
    for (const proc of procs) {
      walk(proc.m_vecPropertyMutators, (m) => {
        const type = m.m_nMutatorCommandType;
        if (type === 'COMP_MAT_PROPERTY_MUTATOR_GENERATE_TEXTURE') {
          const target = m.m_strGenerateTexture_TargetParam;
          const vars = {};
          copyFrom(m.m_strGenerateTexture_InitialContainer, vars);
          for (const ins of m.m_vecTexGenInstructions || []) {
            if (!condOk(ins.m_vecConditions)) continue;
            if (ins.m_nMutatorCommandType === 'COMP_MAT_PROPERTY_MUTATOR_COPY_MATCHING_KEYS') copyFrom(ins.m_strCopyMatchingKeys_InputContainerSrc, vars);
            else if (ins.m_nMutatorCommandType === 'COMP_MAT_PROPERTY_MUTATOR_COPY_PROPERTY') {
              const src = containers[ins.m_strCopyProperty_InputContainerSrc];
              if (src?.kind === 'weapon' || src?.kind === 'target') vars[ins.m_strCopyProperty_TargetProperty] = { kind: 'weapon', name: ins.m_strCopyProperty_InputContainerProperty };
              else { const v = src?.vars?.[ins.m_strCopyProperty_InputContainerProperty]; if (v) vars[ins.m_strCopyProperty_TargetProperty] = v; }
            } else if (ins.m_nMutatorCommandType === 'COMP_MAT_PROPERTY_MUTATOR_SET_VALUE') {
              const sv = ins.m_nSetValue_Value;
              vars[sv.m_strName] = looseVar(sv);
            }
          }
          passes[target] = vars;
        } else if (type === 'COMP_MAT_PROPERTY_MUTATOR_COPY_PROPERTY' && condOk(m.m_vecConditions)) {
          const src = containers[m.m_strCopyProperty_InputContainerSrc];
          const v = src?.vars?.[m.m_strCopyProperty_InputContainerProperty];
          if (v) finalProps[m.m_strCopyProperty_TargetProperty] = v;
        }
      });
    }
    const color = passes.g_tColor;
    if (!color) throw new Error('no colour pass');
    const strip = (vars) => Object.fromEntries(Object.entries(vars).filter(([k]) => k !== '$weapon'));
    const shader = color.$shader?.value || (containers.paint ? (materials[paintMaterial]?.m_shaderName || 'csgo_customweapon.vfx') : 'csgo_customweapon.vfx');
    return {
      id,
      legacy: kit.use_legacy_model === '1',
      wear: [parseFloat(kit.wear_remap_min ?? 0), parseFloat(kit.wear_remap_max ?? 1)],
      compmat: comp.path,
      paint: paintMaterial,
      shader: shader.replace(/\.vfx$/, ''),
      color: strip(color),
      rough: passes.g_tMetalness ? strip(passes.g_tMetalness) : null,
      final: finalProps,
      rolls,
      ...(/customglove/.test(shader) ? { rollSets } : {}),
    };
  }
}

// Material params as loose-variable-like entries.
function materialVars(mat) {
  const pr = params(mat);
  const vars = {};
  for (const [k, v] of Object.entries(pr.ints)) vars[k] = { kind: 'int', value: v };
  for (const [k, v] of Object.entries(pr.floats)) vars[k] = { kind: 'float', value: v };
  for (const [k, v] of Object.entries(pr.vectors)) vars[k] = /^g_vColor\d$/.test(k) ? { kind: 'color', value: v.slice(0, 3) } : { kind: 'vec', value: v };
  for (const [k, v] of Object.entries(pr.textures)) vars[k] = { kind: 'texture', value: v };
  vars.$shader = { kind: 'string', value: mat.m_shaderName };
  return vars;
}

module.exports = { CS2, findGameDir, INDEX_VERSION };
