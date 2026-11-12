// The /match socket: an online PvP match's traffic between its host's game and everyone else's (server/matchmaking.mjs runs
// the match; engine/pvp.js has the numbers). Its own WebSocketServer, never compressed (permessage-deflate is declined: a
// frame costs its latency), with binary frames for the game's inputs and snapshots. The relay reads their first bytes only,
// never the game's payload:
//   client -> server  [0x01][n u8 1-4][cmd…] (CMDS, at most 256 bytes)
//   server -> host    [0x81][k u8]{[slot u8][len u16][body]} (INPUTS: each client's CMDS less its first byte, [n][cmd…],
//                     gathered per match and sent at most every 4 ms; more than 255 is another frame)
//   host -> server    [0x10][tick u32][sharedLen u16][shared][k u8]{[slot u8][len u16][own]} (BUNDLE, at most 16 KB)
//   server -> client  [0x90][tick u32][sharedLen u16][shared][its own part, or nothing] (SNAP: one per member, split from the
//                     bundle; skipped while the socket has more than 64 KB waiting, and the host asked for a keyframe after)
//   host -> server    [0x11][slot u8][payload] (UNICAST) -> that slot gets [0x91][payload]
// Text frames are JSON (the hello, then the match's messages: matchmaking.mjs text()). Little-endian throughout.
//
// The hello is the first frame, within 5 s: { t: 'hello', v: 1, token, match, app } (the login's token, never in the
// address). A second socket for the same player and match replaces the first (4000). Close codes: engine/pvp.js CLOSE.
//
// It runs in the server's process behind this small interface (pvp: auth, joined, left, text, rtt, forwarding), so it can
// move to its own if /health's event-loop p99 says it should.
import { WebSocketServer } from 'ws';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import * as A from './accounts.mjs';
import { banText } from './admin.mjs';
import { RELAY, FRAME, CLOSE } from '../src/js/engine/pvp.js';

// A token bucket: `rate` a second, at most `burst` at once; credit(n): n more, used first (what the server itself asked for,
// a keyframe, isn't held against the socket's own rate).
class Bucket {
  constructor([rate, burst]) { this.rate = rate; this.burst = burst; this.t = burst; this.at = performance.now(); this.extra = 0; }
  take(n = 1) {
    const now = performance.now();
    this.t = Math.min(this.burst, this.t + ((now - this.at) / 1000) * this.rate);
    this.at = now;
    if (this.extra >= n) { this.extra -= n; return true; }
    if (this.t < n) return false;
    this.t -= n;
    return true;
  }
  credit(n) { this.extra = Math.min(this.burst, this.extra + n); }
}
// A close reason fits in 123 bytes.
const reasonOf = (s) => { let r = String(s || ''); while (Buffer.byteLength(r) > 123) r = r.slice(0, -1); return r; };

export class Relay {
  // abuseMs: how long a socket can keep breaking its limits before it's closed (1008); helloMs: how long the hello can take.
  constructor(srv, pvp, { abuseMs = RELAY.ABUSE_MS, helloMs = RELAY.HELLO_MS } = {}) {
    this.srv = srv;
    this.pvp = pvp;
    pvp.relay = this;
    this.log = srv.log || (() => {});
    this.opts = { abuseMs, helloMs };
    // (autoPong off: a ping is answered only within the socket's limit, see control.)
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: RELAY.MAX_PAYLOAD, autoPong: false });
    this.hellos = A.limiter(RELAY.HELLOS_PER_MIN, 60000);
    this.preHello = new Map(); // ip -> sockets open and not past their hello
    this.matches = new Map(); // matchId -> Map(slot -> ws)
    this.inputs = new Map(); // matchId -> { list, pending, last }
    this.count = { in: 0, out: 0, frames: 0 };
    this.timer = setInterval(() => this.beat(), RELAY.PING_MS);
    this.timer.unref?.();
  }

  handleUpgrade(req, socket, head) {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.connection(ws, req));
  }

  connection(ws, req) {
    ws.on('error', () => {});
    ws.ip = this.srv.ipOf ? this.srv.ipOf(req) : req.socket.remoteAddress || '?';
    ws.phase = 'hello';
    // (An address can have only so many sockets waiting on their hello: the per-address hello limit counts hellos, and a
    // socket that never sends one would otherwise cost nothing to hold open.)
    const open = (this.preHello.get(ws.ip) || 0) + 1;
    this.preHello.set(ws.ip, open);
    ws.preHello = true;
    if (open > RELAY.PRE_HELLO) { this.closeWs(ws, CLOSE.HELLO, 'Too many connections'); return; }
    ws.helloTimer = setTimeout(() => this.closeWs(ws, CLOSE.HELLO, 'No hello'), this.opts.helloMs);
    ws.helloTimer.unref?.();
    ws.control = new Bucket(RELAY.CONTROL);
    ws.on('message', (data, isBinary) => this.message(ws, data, isBinary));
    ws.on('close', () => this.closed(ws));
    ws.on('ping', (data) => this.control(ws, () => { try { ws.pong(data); } catch { /* closing */ } }));
    ws.on('pong', (data) => this.control(ws, () => this.pong(ws, data)));
  }
  helloDone(ws) {
    if (!ws.preHello) return;
    ws.preHello = false;
    const n = (this.preHello.get(ws.ip) || 1) - 1;
    if (n > 0) this.preHello.set(ws.ip, n); else this.preHello.delete(ws.ip);
  }
  // A ping or a pong from a socket: none before its hello (closed), and within its limit after (beyond it: dropped, and a
  // socket that keeps it up is closed as any abuse).
  control(ws, fn) {
    if (ws.phase !== 'in') { this.closeWs(ws, CLOSE.HELLO, 'The hello comes first'); return; }
    if (!ws.control.take()) { this.abuse(ws); return; }
    fn();
  }

  closeWs(ws, code, reason = '') {
    if (ws.readyState === 0 || ws.readyState === 1) ws.close(code, reasonOf(reason));
  }

  message(ws, data, isBinary) {
    this.count.in += data.length;
    if (ws.phase === 'hello') {
      if (isBinary) return this.closeWs(ws, CLOSE.HELLO, 'The hello comes first');
      ws.phase = 'auth';
      this.helloDone(ws);
      this.hello(ws, data).catch((e) => { this.log('[relay] hello failed', e); this.closeWs(ws, 1011, 'Server error'); });
      return;
    }
    if (ws.phase !== 'in') return; // (still being checked: dropped)
    if (isBinary) this.binary(ws, data);
    else this.text(ws, data);
  }

  async hello(ws, raw) {
    clearTimeout(ws.helloTimer);
    if (!this.hellos(ws.ip)) return this.closeWs(ws, CLOSE.HELLO, 'Too many connections: wait a minute');
    let msg = null;
    try { msg = JSON.parse(raw); } catch { /* not JSON */ }
    if (!msg || msg.t !== 'hello' || msg.v !== RELAY.VERSION) return this.closeWs(ws, CLOSE.HELLO, 'Update the game to play online matches');
    const { admin, db } = this.srv;
    const u = await A.userForToken(db, msg.token).catch(() => null);
    if (!u) return this.closeWs(ws, CLOSE.AUTH, 'Your login has expired. Log in again.');
    const ipHash = admin.ipHash(ws.ip);
    const ban = await admin.activeBan({ userId: u.id, ipHash });
    if (ban) return this.closeWs(ws, CLOSE.BANNED, banText(ban));
    if (admin.settings.maintenance && await admin.levelOf(u.id, { fast: true }) < 1) return this.closeWs(ws, CLOSE.MAINTENANCE, admin.maintenanceMsg());
    const r = this.pvp.auth(u.id, String(msg.match ?? ''));
    if (r.code) return this.closeWs(ws, r.code, r.code === CLOSE.OVER ? 'That match is over' : 'You are not in that match');
    if (msg.app !== r.match.app) return this.closeWs(ws, CLOSE.HELLO, 'Your game is a different version from the match');
    if (ws.readyState !== 1) return;
    Object.assign(ws, {
      user: u, ipHash, match: r.match, member: r.member, slot: r.member.slot, phase: 'in', lastPong: performance.now(), pings: new Map(), keyAt: 0,
      clientBin: new Bucket(RELAY.CLIENT_BIN), hostBin: new Bucket(RELAY.HOST_BIN), hostBytes: new Bucket([RELAY.HOST_BYTES, RELAY.HOST_BYTES]),
      texts: new Bucket(RELAY.TEXT), abuseFrom: null, abuseLast: 0, needKey: false, stuckSince: null,
    });
    let socks = this.matches.get(r.match.id);
    if (!socks) this.matches.set(r.match.id, (socks = new Map()));
    const old = socks.get(ws.slot);
    socks.set(ws.slot, ws);
    if (old && old !== ws) { old.replaced = true; this.closeWs(old, CLOSE.REPLACED, 'Connected again from somewhere else'); }
    this.pvp.joined(r.match, r.member, ws);
  }

  closed(ws) {
    clearTimeout(ws.helloTimer);
    this.helloDone(ws);
    if (ws.phase !== 'in') { ws.phase = 'closed'; return; }
    ws.phase = 'closed';
    const socks = this.matches.get(ws.match.id);
    if (socks?.get(ws.slot) === ws) {
      socks.delete(ws.slot);
      if (!socks.size) this.matches.delete(ws.match.id);
    }
    if (ws.replaced) return;
    try { this.pvp.left(ws.match, ws.member, ws); } catch (e) { this.log('[relay] left failed', e); }
  }

  // Breaking a limit: the frame's dropped, and a socket that keeps it up for abuseMs is closed (1008).
  abuse(ws) {
    const now = performance.now();
    if (ws.abuseFrom == null || now - ws.abuseLast > 1000) ws.abuseFrom = now;
    ws.abuseLast = now;
    if (now - ws.abuseFrom >= this.opts.abuseMs) this.closeWs(ws, CLOSE.ABUSE, 'Too much traffic');
  }

  binary(ws, buf) {
    const m = ws.match, type = buf[0];
    if (m.host === ws.slot) {
      if (!ws.hostBin.take() || !ws.hostBytes.take(buf.length) || buf.length > RELAY.HOST_BIN_MAX) return this.abuse(ws);
      if (type === FRAME.BUNDLE) { if (!this.bundle(ws, buf)) this.abuse(ws); return; }
      if (type === FRAME.UNICAST) { if (!this.unicast(ws, buf)) this.abuse(ws); return; }
      return this.abuse(ws);
    }
    if (!ws.clientBin.take()) return this.abuse(ws);
    if (type !== FRAME.CMDS || buf.length > RELAY.CLIENT_BIN_MAX || buf.length < 2 || buf[1] < 1 || buf[1] > 4) return this.abuse(ws);
    if (!this.pvp.forwarding(m)) return; // (not live: nobody to take it, dropped quietly)
    this.input(m, ws.slot, buf.subarray(1));
  }

  // A client's commands, gathered per match and sent to the host as one INPUTS frame, at most every INPUT_EVERY_MS: what
  // came in this turn of the event loop goes at its end, unless the last frame went less than that ago; then the next
  // command to come in after that sends them (in a match one does every couple of milliseconds), or a timer if none does.
  // (A timer alone would wait a timer's resolution: about 15 ms on Windows.)
  input(m, slot, body) {
    let q = this.inputs.get(m.id);
    if (!q) this.inputs.set(m.id, (q = { list: [], soon: false, timer: null, last: 0 }));
    q.list.push([slot, body]);
    if (q.soon) return;
    q.soon = true;
    setImmediate(() => { q.soon = false; this.maybeFlush(m, q); });
  }
  maybeFlush(m, q) {
    if (!q.list.length) return;
    const wait = RELAY.INPUT_EVERY_MS - (performance.now() - q.last);
    if (wait <= 0) { clearTimeout(q.timer); q.timer = null; this.flushInputs(m, q); return; }
    if (!q.timer) { q.timer = setTimeout(() => { q.timer = null; this.maybeFlush(m, q); }, wait); q.timer.unref?.(); }
  }
  flushInputs(m, q) {
    q.last = performance.now();
    const list = q.list;
    q.list = [];
    if (!this.matches.has(m.id)) { this.inputs.delete(m.id); return; }
    const host = this.socketOf(m.id, m.host);
    if (!host || host.readyState !== 1) return;
    for (let i = 0; i < list.length; i += 255) {
      const part = list.slice(i, i + 255);
      const out = Buffer.allocUnsafe(2 + part.reduce((s, [, b]) => s + 3 + b.length, 0));
      out[0] = FRAME.INPUTS;
      out[1] = part.length;
      let p = 2;
      for (const [slot, b] of part) {
        out[p] = slot;
        out.writeUInt16LE(b.length, p + 1);
        b.copy(out, p + 3);
        p += 3 + b.length;
      }
      this.out(host, out);
    }
  }

  // A host's bundle split: each member its SNAP, the shared part and its own. → false when it doesn't read right.
  bundle(ws, buf) {
    if (buf.length < 8) return false;
    const tick = buf.readUInt32LE(1), sharedLen = buf.readUInt16LE(5);
    let p = 7 + sharedLen;
    if (p + 1 > buf.length) return false;
    const shared = buf.subarray(7, p), k = buf[p++], own = new Map();
    for (let i = 0; i < k; i++) {
      if (p + 3 > buf.length) return false;
      const slot = buf[p], len = buf.readUInt16LE(p + 1);
      p += 3;
      if (p + len > buf.length) return false;
      own.set(slot, buf.subarray(p, p + len));
      p += len;
    }
    if (p !== buf.length) return false;
    // (The header and shared part once; a member with its own part gets a copy with it on the end.)
    const hs = Buffer.allocUnsafe(7 + sharedLen);
    hs[0] = FRAME.SNAP;
    hs.writeUInt32LE(tick, 1);
    hs.writeUInt16LE(sharedLen, 5);
    shared.copy(hs, 7);
    for (const [slot, sock] of this.matches.get(ws.match.id) || []) {
      if (slot === ws.slot) continue;
      const o = own.get(slot);
      this.snap(ws.match, sock, o ? Buffer.concat([hs, o], hs.length + o.length) : hs);
    }
    return true;
  }
  // A snapshot to a member: skipped while its socket has more than SKIP_OVER waiting (then the host is asked for a keyframe
  // for it once it's drained); a socket past KILL_OVER, or stuck past STUCK_MS, is cut off.
  snap(m, sock, frame) {
    if (sock.readyState !== 1) return;
    const b = sock.bufferedAmount, now = performance.now();
    if (b > RELAY.KILL_OVER) return sock.terminate();
    if (b > RELAY.SKIP_OVER) {
      sock.needKey = true;
      sock.stuckSince ??= now;
      if (now - sock.stuckSince > RELAY.STUCK_MS) sock.terminate();
      return;
    }
    sock.stuckSince = null;
    if (sock.needKey) {
      sock.needKey = false;
      this.requestKey(m.id, sock.slot, { force: true });
    }
    this.out(sock, frame);
  }
  unicast(ws, buf) {
    if (buf.length < 2) return false;
    const target = this.socketOf(ws.match.id, buf[1]);
    if (!target || target === ws || target.readyState !== 1) return true; // (gone: nothing to do)
    if (target.bufferedAmount > RELAY.KILL_OVER) { target.terminate(); return true; }
    buf[1] = FRAME.UNI;
    this.out(target, buf.subarray(1));
    return true;
  }
  out(ws, buf) {
    this.count.out += buf.length;
    this.count.frames++;
    ws.send(buf, { binary: true });
  }

  text(ws, data) {
    const host = ws.match.host === ws.slot;
    if (!ws.texts.take()) return this.abuse(ws);
    if (data.length > (host ? RELAY.CHECKPOINT_MAX : RELAY.TEXT_MAX)) return this.abuse(ws);
    let msg = null;
    try { msg = JSON.parse(data); } catch { /* not JSON */ }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') return this.abuse(ws);
    if (msg.t !== 'checkpoint' && data.length > RELAY.TEXT_MAX) return this.abuse(ws);
    Promise.resolve().then(() => this.pvp.text(ws.match, ws.member, msg)).catch((e) => this.log('[relay] text failed', msg.t, e));
  }

  // Every PING_MS: a ping to each socket ([0x71][u32 nonce], the nonce at random), a socket silent past DEAD_MS cut off, and
  // each match its round trips ({ t: 'rtt', ms: { slot: ms } }).
  beat() {
    const now = performance.now();
    for (const ws of this.wss.clients) {
      if (ws.phase !== 'in') continue;
      if (now - ws.lastPong > RELAY.DEAD_MS) { ws.terminate(); continue; }
      const n = crypto.randomBytes(4).readUInt32LE(0);
      ws.pings.set(n, now);
      if (ws.pings.size > 4) ws.pings.delete(ws.pings.keys().next().value);
      const b = Buffer.alloc(5);
      b[0] = 0x71;
      b.writeUInt32LE(n, 1);
      try { ws.ping(b); } catch { /* closing */ }
    }
    for (const [id, socks] of this.matches) {
      const ms = {};
      for (const [slot, ws] of socks) if (ws.rtt != null) ms[slot] = Math.round(ws.rtt);
      if (Object.keys(ms).length) this.broadcast(id, { t: 'rtt', ms });
    }
  }
  // A pong: only one answering a ping this server sent (its nonce, once) is a sample of the round trip, and keeps the socket
  // alive: made-up pongs, which could make a slow game look fast enough to host, count for nothing.
  pong(ws, data) {
    if (ws.phase !== 'in') return;
    if (!Buffer.isBuffer(data) || data.length < 5 || data[0] !== 0x71) return;
    const n = data.readUInt32LE(1), sent = ws.pings.get(n);
    if (sent == null) return;
    ws.pings.delete(n);
    ws.lastPong = performance.now();
    const ms = ws.lastPong - sent;
    this.pvp.rtt(ws.match, ws.member, ms);
    const recent = ws.member.mrtt.slice(-5).sort((a, b) => a - b);
    ws.rtt = recent[Math.floor(recent.length / 2)] ?? ms;
  }

  // ---- for matchmaking.mjs ------------------------------------------------------------------------------------------
  // The host asked for a keyframe for a slot ({ t: 'key', slot }): at most one every KEY_MS a slot (force: a new socket, or
  // one that missed snapshots, gets its own), and the host's frames for it credited to its limits, so that games asking
  // can't get the host closed for flooding.
  requestKey(matchId, slot, { force = false } = {}) {
    const m = this.socketOf(matchId, slot)?.match, host = m ? this.socketOf(matchId, m.host) : null;
    const ws = this.socketOf(matchId, slot), now = performance.now();
    if (!host || !ws || host === ws || host.readyState !== 1) return false;
    if (!force && now - ws.keyAt < RELAY.KEY_MS) return false;
    ws.keyAt = now;
    host.hostBin.credit(2);
    host.hostBytes.credit(RELAY.HOST_BIN_MAX);
    this.send(matchId, m.host, { t: 'key', slot });
    return true;
  }
  socketOf(matchId, slot) { return this.matches.get(matchId)?.get(slot) || null; }
  isConnected(matchId, slot) { const ws = this.socketOf(matchId, slot); return !!ws && ws.readyState === 1; }
  send(matchId, slot, msg) {
    const ws = this.socketOf(matchId, slot);
    if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
  }
  broadcast(matchId, msg) {
    const socks = this.matches.get(matchId);
    if (!socks) return;
    const text = JSON.stringify(msg);
    for (const ws of socks.values()) if (ws.readyState === 1) ws.send(text);
  }
  closeSlot(matchId, slot, code, reason) { const ws = this.socketOf(matchId, slot); if (ws) this.closeWs(ws, code, reason); }
  closeMatch(matchId, code, reason) {
    for (const ws of [...(this.matches.get(matchId)?.values() || [])]) this.closeWs(ws, code, reason);
    this.inputs.delete(matchId);
  }
  kickUser(userId, code, reason = code === CLOSE.MAINTENANCE ? 'The server is under maintenance' : 'Disconnected by the server') {
    for (const ws of this.wss.clients) if (ws.user?.id === userId) this.closeWs(ws, code, reason);
  }
  stats() {
    let members = 0;
    for (const socks of this.matches.values()) members += socks.size;
    return { members, sockets: this.wss.clients.size, bytesIn: this.count.in, bytesOut: this.count.out };
  }
  // Every socket closed with `code` (1012: the games come back once the server's started again); those that haven't closed
  // within a second are cut off, so the server's own close doesn't wait on them.
  async close(code = CLOSE.RESTART) {
    clearInterval(this.timer);
    const all = [...this.wss.clients];
    for (const ws of all) this.closeWs(ws, code, 'The server is restarting');
    const until = Date.now() + 1000;
    while (all.some((ws) => ws.readyState !== 3) && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
    for (const ws of all) if (ws.readyState !== 3) ws.terminate();
    this.wss.close();
  }
}
