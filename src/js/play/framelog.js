// net_graph 2's log of the match, for looking into stutters afterwards: while net_graph 2 is on, the match is written
// down as it's played. That's a line a second (frame times, where the frame went, the GPU's time, what the match holds),
// every slow frame with what came with it (the main thread busy between frames, shaders compiled, textures uploaded,
// a garbage collection, what happened in the game just before), a table a round and a summary. It's saved as a text
// file (userData/netgraph-logs) as soon as it starts, after every round, when the match ends and when you leave it, or
// with net_graph_log (which shows the file).
import { esc } from '../util.js';

const SLOW_MS = 30, SLOW_X = 1.8; // a frame this long, and this many times the usual, is written down on its own
const MAX_SLOW = 4000, MAX_LONG = 4000, RING = 1024;
const BINS = 301; // frame times to the millisecond (the last: 300 ms or more)
// What happened in the game, timed: [what of the game's ('' the game itself), its method, what the log calls it (or
// a function of its arguments that says)].
const HOOKS = [['', 'kill', 'kill'], ['', 'botShoot', 'bot shot'], ['', 'damage', 'damage'], ['arsenal', 'shoot', 'you shot'],
  ['nades', 'throw', 'grenade thrown'], ['nades', 'detonate', 'grenade went off'], ['effects', 'explosion', 'explosion'], ['', 'buy', 'buy', (id) => 'buy ' + String(id).replace(/^weapon_/, '')],
  ['drops', 'drop', 'gun dropped'], ['radio', 'say', 'radio'], ['', 'say', 'chat'], ['', 'onRoundStart', 'round start'], ['', 'onRoundEnd', 'round end'],
  ['match', 'planted', 'bomb planted'], ['match', 'defused', 'bomb defused'], ['match', 'exploded', 'bomb exploded']];

const heapNow = () => performance.memory?.usedJSHeapSize ?? 0; // (to the byte: main.js turns on precise memory info)
const n1 = (v, w = 5) => (v == null || !Number.isFinite(v) ? '-' : v.toFixed(1)).padStart(w);
const n0 = (v, w = 5) => (v == null || !Number.isFinite(v) ? '-' : String(Math.round(v))).padStart(w);
const mb = (b) => Math.round(b / 1e6);
const clock = (s, tenths = false) => `${Math.floor(s / 60)}:${(tenths ? (s % 60).toFixed(1).padStart(4, '0') : String(Math.floor(s % 60)).padStart(2, '0'))}`;
const share = (a, b) => (b ? Math.round((100 * a) / b) + '%' : '-');
// The frame time that this share of frames came in under.
function pct(hist, n, q) {
  let k = 0;
  for (let i = 0; i < BINS; i++) if ((k += hist[i]) >= q * n) return i;
  return BINS - 1;
}
// A long frame of the browser's (long-animation-frame: what ran in it and for how long; longtask where there's none).
function longEntry(e) {
  const end = e.startTime + e.duration, render = e.renderStart || end, layout = e.styleAndLayoutStart || end;
  const scripts = (e.scripts || []).slice().sort((a, b) => b.duration - a.duration).slice(0, 3).map((s) => `${Math.round(s.duration)} ms ${String(s.invoker || s.name).slice(0, 60)}`
    + `${s.sourceFunctionName ? ' → ' + s.sourceFunctionName : ''}${s.sourceURL ? ' (' + s.sourceURL.split('/').pop() + ')' : ''}`);
  return { t: e.startTime, d: e.duration, tasks: render - e.startTime, raf: layout - render, layout: end - layout, scripts };
}

export class FrameLog {
  constructor(g) {
    this.g = g;
    this.began = new Date();
    this.t0 = performance.now();
    const p = (n) => String(n).padStart(2, '0'), d = this.began;
    this.name = `netgraph-${g.mapId || 'match'}-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
    this.lines = []; this.slow = []; this.rounds = []; this.long = [];
    this.hist = new Uint32Array(BINS); this.frames = 0; this.intSum = 0;
    this.ev = { t: new Float64Array(RING), d: new Float32Array(RING), what: new Array(RING), n: 0, from: 0 };
    this.before = {}; this.beforeSlow = {}; // how many frames each kind of event came before (all of them, the slow ones)
    this.slowCount = 0; this.avg = 16; this.sounds = 0; this.done = -1; this.compiled = [];
    // The last frame's own numbers (a slow frame's record is the time since the frame before: that frame's work and the wait after it).
    this.last = { start: 0, end: 0, cpu: 0, sim: 0, ticks: 0, ai: 0, bots: 0, draw: 0, hud: 0, heapIn: 0, frameNo: -1 };
    const info = g.renderer.info;
    this.at = { tex: info.memory.textures, geo: info.memory.geometries, prog: info.programs?.length ?? 0, heap: heapNow() };
    this.sec = this.newSecond(this.t0);
    this.round = null;
    this.nextRound(g.match?.round ?? 0);
    this.hook();
    this.observe();
    this.gl = g.renderer.getContext();
    this.tq = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.queries = []; this.pending = []; this.gpuFor = new Map();
    this.off = g.on((type, data) => { if (type === 'round') this.nextRound(data); else if (type === 'roundEnd') this.saveSoon(); else if (type === 'over') this.matchOver(); });
    this.saveSoon();
  }

  // Each event the game has (HOOKS) is timed and kept (the last RING of them); sounds are counted.
  hook() {
    const g = this.g, log = this;
    for (const [on, name, said, say] of HOOKS) {
      const label = say || said;
      const o = on ? g[on] : g, f = o?.[name];
      if (typeof f !== 'function') continue;
      o[name] = function (...a) { const t = performance.now(); try { return f.apply(this, a); } finally { log.mark(typeof label === 'function' ? label(...a) : label, t, performance.now() - t); } };
    }
    const play = g.sounds?.play;
    if (play) g.sounds.play = function (...a) { log.sounds++; return play.apply(this, a); };
    // A shader compiled as something was drawn: what for (its material, and the model's name or its parent's).
    const r = g.renderer, draw = r?.renderBufferDirect;
    if (draw) r.renderBufferDirect = function (cam, scene, geo, mat, obj) {
      const n = r.info.programs?.length ?? 0, out = draw.apply(this, arguments);
      if ((r.info.programs?.length ?? 0) > n && log.compiled.length < 6) log.compiled.push(`${mat.name || mat.type}${scene ? '' : ' (shadow)'} on ${obj.name || obj.parent?.name || obj.type}`);
      return out;
    };
    // A weapon made mid-match (one not loaded ahead, as you buy or pick it up): as it starts, and once it's ready (how
    // long it took).
    const vm = g.vmData;
    if (vm) g.vmData = function (wid, ...a) {
      const had = this.vmCache.size, t = performance.now(), job = vm.call(this, wid, ...a);
      if (this.vmCache.size > had) { log.mark('weapon loading', t, performance.now() - t); job.then(() => log.mark(`${wid.replace(/^weapon_/, '')} loaded`, performance.now(), performance.now() - t), () => {}); }
      return job;
    };
  }
  mark(what, t, d) {
    const e = this.ev, i = e.n++ % RING;
    e.t[i] = t; e.d[i] = d; e.what[i] = what;
  }
  observe() {
    const types = globalThis.PerformanceObserver?.supportedEntryTypes || [];
    this.longType = types.includes('long-animation-frame') ? 'long-animation-frame' : types.includes('longtask') ? 'longtask' : null;
    if (!this.longType) return;
    this.obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) if (this.long.length < MAX_LONG) this.long.push(longEntry(e)); });
    this.obs.observe({ type: this.longType });
  }

  newSecond(at) {
    return { at, n: 0, k: 0, int: 0, intMax: 0, cpu: 0, cpuMax: 0, sim: 0, ticksMax: 0, ai: 0, bots: 0, draw: 0, hud: 0, gpu: 0, gpuN: 0, gpuMax: 0, idle: 0, slow: 0, gc: 0, gcBytes: 0 };
  }
  nextRound(round) {
    const now = performance.now();
    if (this.round) { this.round.secs = (now - this.round.t) / 1000; this.round.after = { ...this.at }; this.rounds.push(this.round); }
    this.round = { round, t: now, n: 0, int: 0, max: 0, hist: new Uint32Array(BINS), cpu: 0, gpu: 0, gpuN: 0, slow: 0, gc: 0, gcBytes: 0, from: { ...this.at } };
  }

  // The GPU's time drawing the frame (when the browser has timer queries): asked for around the drawing, read when it's ready.
  gpuBegin() {
    if (!this.tq || this.open || this.pending.length > 16) return;
    this.open = this.queries.pop() || this.gl.createQuery();
    this.gl.beginQuery(this.tq.TIME_ELAPSED_EXT, this.open);
  }
  gpuEnd() {
    if (!this.open) return;
    this.gl.endQuery(this.tq.TIME_ELAPSED_EXT);
    this.pending.push([this.open, this.g.frameNo]);
    this.open = null;
  }
  readGpu() {
    const gl = this.gl;
    while (this.pending.length) {
      const [q, frameNo] = this.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      this.pending.shift(); this.queries.push(q);
      const slow = this.gpuFor.get(frameNo);
      this.gpuFor.delete(frameNo);
      if (gl.getParameter(this.tq.GPU_DISJOINT_EXT)) continue; // (a timing the GPU spoiled)
      const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6, s = this.sec, r = this.round;
      s.gpu += ms; s.gpuN++; s.gpuMax = Math.max(s.gpuMax, ms); r.gpu += ms; r.gpuN++;
      if (slow) slow.gpu = ms;
    }
  }

  // At the start of a frame: the time since the last one, and what went on in it (a slow one is written down).
  begin(t0) {
    const g = this.g, info = g.renderer.info, last = this.last, at = this.at;
    const tex = info.memory.textures, geo = info.memory.geometries, prog = info.programs?.length ?? 0, heap = heapNow();
    const changed = [tex - at.tex, geo - at.geo, prog - at.prog], heapBetween = heap - (this.heapEnd ?? heap);
    at.tex = tex; at.geo = geo; at.prog = prog; at.heap = heap;
    const sounds = this.sounds, compiled = this.compiled;
    this.sounds = 0; this.compiled = [];
    // What happened since the last frame started.
    const e = this.ev, events = new Map();
    for (let k = Math.max(e.from, e.n - RING); k < e.n; k++) {
      const i = k % RING, x = events.get(e.what[i]) || [0, 0];
      x[0]++; x[1] += e.d[i]; events.set(e.what[i], x);
    }
    e.from = e.n;
    // (Only from one logged frame to the next: not across frames that weren't, with net_graph 2 off or you away.)
    if (g.frameNo !== this.done) {
      if (this.done >= 0) this.lines.push(`${clock((t0 - this.t0) / 1000).padStart(6)}  (not logged for ${((t0 - last.end) / 1000).toFixed(0)} s: net_graph 2 off, or you away)`);
      return;
    }
    const int = t0 - last.start, idle = t0 - last.end, r = this.round, s = this.sec;
    this.frames++; this.intSum += int;
    this.hist[Math.min(BINS - 1, Math.round(int))]++;
    r.n++; r.int += int; r.max = Math.max(r.max, int); r.hist[Math.min(BINS - 1, Math.round(int))]++;
    s.k++; s.int += int; s.intMax = Math.max(s.intMax, int); s.idle += idle;
    const gc = Math.min(last.heapIn, 0) + Math.min(heapBetween, 0);
    if (gc < -2e6) { s.gc++; s.gcBytes -= gc; r.gc++; r.gcBytes -= gc; }
    for (const k of events.keys()) this.before[k] = (this.before[k] || 0) + 1;
    const slow = int > SLOW_MS && int > SLOW_X * this.avg;
    this.avg += (int - this.avg) * 0.05;
    if (!slow) return;
    s.slow++; r.slow++; this.slowCount++;
    for (const k of events.keys()) this.beforeSlow[k] = (this.beforeSlow[k] || 0) + 1;
    if (this.slow.length >= MAX_SLOW) return;
    const flags = [g.input?.held?.('scores') && 'scoreboard', g.buyMenu?.isOpen && 'buy menu', g.console?.isOpen && 'console', g.me && !g.me.alive && 'you dead'].filter(Boolean);
    const rec = { t: t0, start: last.start, round: g.match?.round ?? 0, phase: g.match?.phase || '', int, usual: this.avg, work: last.cpu, idle, sim: last.sim, ticks: last.ticks,
      ai: last.ai, bots: last.bots, draw: last.draw, hud: last.hud, gpu: null, heapIn: last.heapIn, heapBetween, changed: { tex: changed[0], geo: changed[1], prog: changed[2] }, compiled, sounds, flags,
      events: [...events].sort((a, b) => b[1][1] - a[1][1]).map(([k, [c, d]]) => `${k}${c > 1 ? ' ×' + c : ''}${d >= 0.5 ? ` (${d.toFixed(1)} ms)` : ''}`) };
    this.slow.push(rec);
    this.gpuFor.set(last.frameNo, rec);
  }

  // At the end of a frame: its own numbers (sim: the ticks, steps of them), and once a second a line.
  frame(t0, t1, ticks) {
    const g = this.g, p = g.parts, end = performance.now(), last = this.last, s = this.sec, heap = heapNow();
    this.readGpu();
    const cpu = end - t0;
    Object.assign(last, { start: t0, end, cpu, sim: t1 - t0, ticks, ai: p.ai, bots: p.bots, draw: p.draw, hud: p.hud, heapIn: heap - this.at.heap, frameNo: g.frameNo });
    this.heapEnd = heap;
    this.done = g.frameNo;
    this.round.cpu += cpu;
    s.n++; s.cpu += cpu; s.cpuMax = Math.max(s.cpuMax, cpu); s.sim += t1 - t0; s.ticksMax = Math.max(s.ticksMax, ticks);
    s.ai += p.ai; s.bots += p.bots; s.draw += p.draw; s.hud += p.hud;
    if (end - s.at >= 1000) { this.lines.push(this.secondLine(s, end)); this.sec = this.newSecond(end); }
  }
  secondLine(s, end) {
    const g = this.g, info = g.renderer.info, n = Math.max(1, s.n), ints = Math.max(1, s.k);
    const bodies = (g.bots || []).filter((b) => b.root.visible).length, alive = (g.combatants || []).filter((c) => c.alive).length;
    return `${clock((s.at - this.t0) / 1000).padStart(6)} ${n0(g.match?.round ?? 0, 3)} ${String(g.match?.phase || '').padEnd(7)} ${n0((1000 * s.n) / (end - s.at), 4)} `
      + `${n1(s.int / ints)} ${n1(s.intMax, 6)} | ${n1(s.cpu / n)} ${n1(s.cpuMax, 6)} ${n1(s.sim / n)} ${n0(s.ticksMax, 2)} ${n1(s.ai / n)} ${n1(s.bots / n)} ${n1(s.draw / n)} ${n1(s.hud / n)} `
      + `| ${n1(s.gpuN ? s.gpu / s.gpuN : null)} ${n1(s.gpuN ? s.gpuMax : null, 6)} | ${n1(s.idle / ints)} ${n0(s.slow, 4)} ${n0(s.gc, 3)} ${n0(mb(s.gcBytes), 4)} `
      + `| ${n0(g.graph?.calls, 5)} ${n1((g.graph?.tris || 0) / 1e6, 5)} ${n0(info.memory.textures, 5)} ${n0(info.memory.geometries, 5)} ${n0(info.programs?.length, 4)} ${n0(mb(heapNow()), 5)} `
      + `| ${n0(bodies, 3)} ${n0(g.drops?.list.length, 4)} ${n0(alive, 3)}`;
  }

  matchOver() {
    this.save().then((file) => this.g.hud.q('[data-end]')?.insertAdjacentHTML('beforeend', `<div class="sub">net_graph 2 log saved: ${esc(file)} · type net_graph_log in the console (~) to open its folder</div>`))
      .catch((e) => console.warn('net_graph log', e));
  }
  // Saved outside the frame (and the time it took kept: a slow frame after it says so).
  saveSoon() {
    setTimeout(() => {
      const t = performance.now();
      this.save().catch((e) => console.warn('net_graph log', e));
      this.mark('log saved', t, performance.now() - t);
    }, 0);
  }
  // The log as a text file: userData/netgraph-logs/<name>.txt (a download in a browser). show: shows it in its folder.
  async save(show = false) {
    const text = this.text();
    if (window.native?.saveLog) {
      this.file = await window.native.saveLog(this.name, text);
      if (show) await window.native.showLog(this.file);
      return this.file;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = this.name + '.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    return a.download;
  }
  stop() {
    this.obs?.disconnect();
    this.off?.();
    for (const q of [...this.queries, ...this.pending.map(([q]) => q)]) this.gl.deleteQuery(q);
    this.queries = []; this.pending = [];
  }

  text() {
    const g = this.g, now = performance.now(), gl = this.gl;
    const rounds = [...this.rounds, { ...this.round, secs: (now - this.round.t) / 1000, after: { ...this.at }, live: true }];
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const gpuName = gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
    const buf = gl.drawingBufferWidth + '×' + gl.drawingBufferHeight;
    const secs = (now - this.t0) / 1000, F = this.frames, H = this.hist;
    const out = [];
    out.push('CS2 Case Simulator · net_graph 2 log', '');
    out.push(`Started ${this.began.toLocaleString()} · saved ${new Date().toLocaleString()} · ${clock(secs)} logged`);
    out.push(`Match: ${g.map?.info?.name || g.mapId || '?'} (${g.mapId || '?'}) · ${g.mode} · ${(g.bots || []).length} bots (${g.botTier}) · round ${g.match?.round ?? '?'}${g.matchOver ? ' · over' : ''}`);
    out.push(`GPU: ${gpuName}`);
    out.push(`Screen: window ${innerWidth}×${innerHeight} at ${devicePixelRatio}× · drawn at ${buf} · quality ${g.quality} · render scale ${g.settings.renderScale ?? 1} · fps_max ${g.cv.fps_max || 0}`
      + ` · ${navigator.hardwareConcurrency || '?'} CPU threads${navigator.deviceMemory ? ' · ' + navigator.deviceMemory + ' GB+ memory' : ''}`);
    out.push(`Measured: GPU time ${this.tq ? 'yes' : 'no (the browser has no timer queries)'} · the main thread's long frames ${this.longType || 'no'} · ${navigator.userAgent}`);

    // ---- summary
    const slow = this.slow, nSlow = this.slowCount;
    const own = slow.filter((x) => x.work >= x.idle).length;
    const has = (f) => slow.filter(f).length;
    const longFor = this.matchLong();
    out.push('', '==== SUMMARY ====');
    out.push(`${F} frames · ${n0(F / Math.max(1, this.intSum / 1000), 0)} fps on average (${n1(this.intSum / Math.max(1, F), 0)} ms)`
      + ` · frame times: half under ${pct(H, F, 0.5)} ms, 95% under ${pct(H, F, 0.95)} ms, 99% under ${pct(H, F, 0.99)} ms, 99.9% under ${pct(H, F, 0.999)} ms`);
    out.push(`Slow frames (over ${SLOW_MS} ms and ${SLOW_X}× the usual): ${nSlow} (${(nSlow / Math.max(1 / 60, secs / 60)).toFixed(1)} a minute)${nSlow > slow.length ? ` · the first ${slow.length} are listed` : ''}`);
    if (slow.length) {
      out.push(`  mostly the frame before's own work: ${own} · mostly the wait after it (the GPU, the browser, something else running): ${slow.length - own}`);
      out.push(`  with a garbage collection: ${has((x) => x.heapIn + x.heapBetween < -2e6)} · shaders compiled: ${has((x) => x.changed.prog > 0)} · textures added: ${has((x) => x.changed.tex > 0)}`
        + ` · geometries added: ${has((x) => x.changed.geo > 0)} · 3+ ticks to catch up: ${has((x) => x.ticks >= 3)} · the browser busy outside the frame: ${has((x) => longFor.get(x)?.some((l) => l.tasks > 10))}`);
      const phases = {};
      for (const x of slow) phases[x.phase] = (phases[x.phase] || 0) + 1;
      out.push('  by phase: ' + Object.entries(phases).map(([k, v]) => `${k || '?'} ${v}`).join(' · '));
      const kinds = Object.keys(this.beforeSlow).sort((a, b) => this.beforeSlow[b] - this.beforeSlow[a]);
      if (kinds.length) {
        out.push('  what happened just before (share of slow frames, against share of all frames):');
        for (const k of kinds) out.push(`    ${k.padEnd(18)} ${share(this.beforeSlow[k], nSlow).padStart(4)} of slow · ${share(this.before[k] || 0, F).padStart(4)} of all`);
      }
    }
    const full = rounds.filter((r) => r.n > 100);
    if (full.length >= 6) {
      const avg = (rs) => rs.reduce((a, r) => a + r.int, 0) / Math.max(1, rs.reduce((a, r) => a + r.n, 0));
      out.push(`Early rounds against late: ${n1(avg(full.slice(0, 3)), 0)} ms a frame in the first three, ${n1(avg(full.slice(-3)), 0)} ms in the last three`);
    }

    // ---- rounds
    out.push('', '==== ROUNDS ====', '(ms: frame time, average and percentiles · work: the game\'s own time a frame · gpu: the GPU\'s drawing time · gc: garbage collections · tex, geo, shd, heap: at the round\'s end, and what it added)');
    out.push('round   time  frames   ms   p50  p95  p99   max |  work   gpu | slow  gc   MB |   tex   +  geo   + shd  +  heap MB    +');
    for (const r of rounds) {
      if (!r.n) continue;
      const a = r.after, f = r.from;
      out.push(`${n0(r.round, 5)}${r.live ? '*' : ' '} ${clock(r.secs).padStart(5)} ${n0(r.n, 7)} ${n1(r.int / r.n)} ${n0(pct(r.hist, r.n, 0.5), 4)} ${n0(pct(r.hist, r.n, 0.95), 4)} ${n0(pct(r.hist, r.n, 0.99), 4)} ${n0(r.max, 5)} `
        + `| ${n1(r.cpu / r.n)} ${n1(r.gpuN ? r.gpu / r.gpuN : null)} | ${n0(r.slow, 4)} ${n0(r.gc, 3)} ${n0(mb(r.gcBytes), 4)} `
        + `| ${n0(a.tex, 5)} ${n0(a.tex - f.tex, 3)} ${n0(a.geo, 4)} ${n0(a.geo - f.geo, 3)} ${n0(a.prog, 3)} ${n0(a.prog - f.prog, 2)} ${n0(mb(a.heap), 8)} ${n0(mb(a.heap - f.heap), 4)}`);
    }
    if (rounds.at(-1).live) out.push('(* still going when saved)');

    // ---- slow frames
    out.push('', '==== SLOW FRAMES ====', '(when · round · time since the frame before = that frame\'s work (its parts) + the wait after it · the GPU\'s time for it · what changed · what happened · the browser\'s long frames then)');
    for (const x of slow) {
      const ch = x.changed, heap = x.heapIn + x.heapBetween;
      const what = [ch.prog > 0 && `+${ch.prog} shader${ch.prog > 1 ? 's' : ''}${x.compiled?.length ? ` (${x.compiled.join(', ')})` : ''}`, ch.tex > 0 && `+${ch.tex} tex`, ch.geo > 0 && `+${ch.geo} geo`,
        heap < -2e6 && `gc ${mb(heap)} MB${x.heapBetween < -2e6 ? ' (between frames)' : ''}`, x.sounds && `${x.sounds} sound${x.sounds > 1 ? 's' : ''}`, ...x.flags].filter(Boolean);
      out.push(`${clock((x.t - this.t0) / 1000, true).padStart(8)} r${String(x.round).padEnd(3)} ${x.phase.padEnd(7)} ${n0(x.int, 4)} ms (usual ${n0(x.usual, 0)}) = work ${n1(x.work, 0)}`
        + ` (sim ${n1(x.sim, 0)} in ${x.ticks} tick${x.ticks === 1 ? '' : 's'} · ai ${n1(x.ai, 0)} · bodies ${n1(x.bots, 0)} · draw ${n1(x.draw, 0)} · hud ${n1(x.hud, 0)}) + wait ${n1(x.idle, 0)}`
        + ` · gpu ${x.gpu == null ? '-' : n1(x.gpu, 0)}${what.length ? ' · ' + what.join(' · ') : ''}${x.events.length ? ' · ' + x.events.join(', ') : ''}`);
      for (const l of longFor.get(x) || []) out.push(`           browser: ${n0(l.d, 0)} ms long frame (tasks ${n0(l.tasks, 0)} · rAF ${n0(l.raf, 0)} · style/layout ${n0(l.layout, 0)})${l.scripts.length ? ': ' + l.scripts.join('; ') : ''}`);
    }

    // ---- every second
    out.push('', '==== EVERY SECOND ====');
    out.push('(ms: frame time, average and worst · work: the game\'s own time a frame, average and worst, then its parts: sim (tk: most ticks in a frame), ai, bod(ies), dr(a)w, hud ·'
      + ' gpu: the GPU\'s drawing time · wait: between frames (the GPU, vsync, the browser) · slow frames, garbage collections (MB freed) · what\'s drawn and held · bodies shown, guns on the floor, players alive)');
    out.push('  time rnd phase    fps    ms    max |  work    max   sim tk    ai   bod   drw   hud |   gpu    max |  wait slow  gc   MB | draws  tris   tex   geo  shd  heap | bod guns alive');
    out.push(...this.lines);
    return out.join('\n') + '\n';
  }
  // The browser's long frames during each slow frame's time (from the frame before it started to it starting).
  matchLong() {
    const out = new Map(), long = this.long;
    let j = 0;
    for (const x of this.slow) {
      while (j < long.length && long[j].t + long[j].d < x.start) j++;
      const hits = [];
      for (let k = j; k < long.length && long[k].t < x.t; k++) hits.push(long[k]);
      if (hits.length) out.set(x, hits);
    }
    return out;
  }
}
