// Online PvP (server/matchmaking.mjs, server/relay.mjs, engine/pvp.js): the queue, the accept, the match's /match socket,
// the server's own round log, disconnects, restarts and the pay. A real server (embedded Postgres on disk) and real
// WebSocket clients; the matches' clock is the test's (pvp: { tick: false }: each tick is run here).
//   node server/test-pvp.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import WebSocket from 'ws';

for (const k of Object.keys(process.env)) {
  if (/^DISCORD_/.test(k) || ['ADMIN_USERS', 'TRUST_PROXY', 'PVP_FILL_AFTER_S', 'HOST', 'SERVER_COMMIT', 'RENDER_GIT_COMMIT', 'RELEASE_FEED'].includes(k)) delete process.env[k];
}
const { startServer } = await import('./index.mjs');
const { D } = await import('../src/js/engine/data.js');
const V = await import('../src/js/engine/pvp.js');
const L = await import('../src/js/engine/levels.js');
const R = await import('../src/js/engine/ranks.js');
const MM = await import('../src/js/engine/matchmaking.js');
const { mulberry32 } = await import('../src/js/engine/util.js');
const { makeSkinItem } = await import('../src/js/engine/items.js');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cs2sim-test-pvp-'));
let failed = 0, passed = 0;
const check = (name, ok, info = '') => { ok ? passed++ : failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = () => {};
let now = Date.now();
const clock = () => now;
const advance = (ms) => { now += ms; };
const OPTS = {
  port: 0, db: { dataDir: DIR }, log: quiet, priceRefresh: false, discord: false, admins: ['boss'], trustProxy: 1, clock, passiveTick: 2 ** 30,
  // (ROUND_MAX: no match here plays rounds as fast as the clock moves; its own check sets the real one.)
  pvp: { tick: false, rng: mulberry32(7), relay: { helloMs: 1000, abuseMs: 1500 }, times: { ROUND_MAX: 1000 * 3600e3 } },
};
let server = await startServer(OPTS);
const base = () => `http://localhost:${server.port}`;
const P = () => server.srv.pvp;
const tick = () => P().tick();
const OLD_CAPS = ['lean1', 'p2p1', 'face1'], CAPS = [...OLD_CAPS, 'pvp1'], APP = '1.2.0';
const C1 = 'a'.repeat(40), C2 = 'b'.repeat(40);
const MAPS = [{ id: 'de_dust2', c: C1, x: true }, { id: 'de_mirage', c: C1, x: false }];
const until = async (fn, ms = 5000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await wait(15); } };

async function post(p, body, ip = '10.9.9.9') {
  const r = await fetch(base() + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
// A game: the /ws connection, its rpc, the pushes it got, and its state built from the welcome and deltas.
async function client(acc, { caps = CAPS, app = APP, noCaps = false } = {}) {
  const ws = new WebSocket(base().replace('http', 'ws') + '/ws', { headers: { 'x-forwarded-for': acc.ip } });
  const c = { ws, acc, st: null, events: [], pending: new Map(), seq: 0 };
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const welcome = new Promise((res, rej) => {
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.t === 'welcome') { c.st = m.state; c.user = m.user; res(m); return; }
      if (m.t === 'fatal') { rej(new Error(m.error)); return; }
      if (m.t === 'res') { const p = c.pending.get(m.id); c.pending.delete(m.id); if (m.d) apply(c, m.d); m.ok ? p.res(m.r) : p.rej(Object.assign(new Error(m.err), { code: m.code })); return; }
      if (m.t === 'delta') apply(c, m.d);
      c.events.push(m);
    });
  });
  ws.send(JSON.stringify({ t: 'hello', token: acc.token, data: D.lock, v: 1, app, ...(noCaps ? {} : { caps }) }));
  c.welcome = await welcome;
  c.rpc = (ns, m, args) => new Promise((res, rej) => { const id = ++c.seq; c.pending.set(id, { res, rej }); ws.send(JSON.stringify({ t: 'rpc', id, ns, m, args })); });
  c.pvp = (m, args = {}) => c.rpc('pvp', m, args);
  c.admin = (m, args = {}) => c.rpc('admin', m, args);
  c.waitFor = (pred, ms = 5000) => until(() => c.events.find(pred), ms);
  c.take = (t) => { const i = c.events.findIndex((e) => e.t === t); return i < 0 ? null : c.events.splice(i, 1)[0]; };
  c.clear = () => { c.events.length = 0; };
  c.close = () => new Promise((r) => { if (ws.readyState === 3) return r(); ws.once('close', r); ws.close(); });
  acc.c = c;
  return c;
}
function apply(c, d) {
  for (const [k, v] of Object.entries(d.set || {})) c.st[k] = v;
  const del = new Set(d.del || []);
  c.st.inv = (c.st.inv || []).filter((i) => !del.has(i.uid));
  for (const u of d.upd || []) { const i = c.st.inv.findIndex((x) => x.uid === u.uid); if (i >= 0) c.st.inv[i] = u; }
  c.st.inv.unshift(...(d.add || []));
}
const refused = (p) => p.then(() => null, (e) => e);
// The /match socket: its text frames, binary frames and how it closed.
async function sock(acc, matchId, { app = APP, hello = true, deflate = true, token = acc.token } = {}) {
  const ws = new WebSocket(base().replace('http', 'ws') + '/match', { headers: { 'x-forwarded-for': acc.ip }, perMessageDeflate: deflate });
  const s = { ws, acc, texts: [], bins: [], closed: null };
  ws.on('message', (data, isBinary) => { if (isBinary) s.bins.push(Buffer.from(data)); else s.texts.push(JSON.parse(data)); });
  ws.on('close', (code, reason) => { s.closed = { code, reason: String(reason) }; });
  ws.on('error', () => {});
  await new Promise((res) => { ws.on('open', res); ws.on('close', res); });
  if (hello && ws.readyState === 1) ws.send(JSON.stringify({ t: 'hello', v: 1, token, match: matchId, app }));
  s.send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  s.bin = (b) => ws.readyState === 1 && ws.send(b);
  s.waitText = (pred, ms = 5000) => until(() => s.texts.find(pred), ms);
  s.waitClosed = (ms = 5000) => until(() => s.closed, ms);
  s.close = () => new Promise((r) => { if (ws.readyState === 3) return r(); ws.once('close', r); ws.close(); });
  return s;
}
const upgrade = (p, ext) => new Promise((resolve) => {
  const req = http.request({ port: server.port, host: 'localhost', path: p, headers: {
    Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...(ext != null ? { 'Sec-WebSocket-Extensions': ext } : {}),
  } });
  req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ status: res.statusCode, ext: res.headers['sec-websocket-extensions'] ?? null }); });
  req.on('response', (res) => { res.resume(); resolve({ status: res.statusCode, ext: null }); });
  req.on('error', (e) => resolve({ status: 0, ext: String(e.message) }));
  req.end();
});
const st = async (id) => (await server.store.load(id)).st;
const setState = (id, fn) => server.store.withUser(id, async (e) => { fn(e.st); server.store.markDirty(e); });
const rows = async (sql, args = []) => (await server.db.query(sql, args)).rows;

// Accounts: each its own address (trustProxy: X-Forwarded-For).
const ACC = {};
async function account(name, n) {
  const ip = `10.7.${Math.floor(n / 200)}.${(n % 200) + 1}`;
  const r = await post('/api/register', { name, password: 'secret123' }, ip);
  if (r.status !== 200) throw new Error(`register ${name}: ${JSON.stringify(r.body)}`);
  ACC[name] = { name, token: r.body.token, ip, id: null };
  return ACC[name];
}
const NAMES = Array.from({ length: 14 }, (_, i) => `p${String(i + 1).padStart(2, '0')}`);
await account('boss', 199);
for (const [i, n] of NAMES.entries()) await account(n, i + 1);
await account('oldie', 150);
for (const a of Object.values(ACC)) { const c = await client(a); a.id = c.user.id; }
const ps = (...names) => names.map((n) => ACC[n]);

// Queue these players and run the queue until a lobby's found; then all accept. → { id, m (the server's match), go }
async function lobby(players, mode = 'competitive', { maps = MAPS, fill = players.length < V.modeOf(mode).lobby, accept = true } = {}) {
  for (const a of players) a.c.clear();
  for (const a of players) await a.c.pvp('queue', { mode, maps });
  if (fill) advance(V.QUEUE.FILL_AFTER + 1000);
  await tick();
  const found = [];
  for (const a of players) found.push(await a.c.waitFor((e) => e.t === 'pvp.found'));
  if (found.some((f) => !f) || new Set(found.map((f) => f.id)).size !== 1) throw new Error('no lobby: ' + JSON.stringify(found));
  const id = found[0].id;
  if (!accept) return { id, found };
  for (const a of players) await a.c.pvp('accept', { id });
  const go = [];
  for (const a of players) go.push(await a.c.waitFor((e) => e.t === 'pvp.go' && e.id === id));
  return { id, m: P().matches.get(id), go, found };
}
// Every player's /match socket, joined. → Map(name -> socket)
async function joinAll(players, id) {
  const out = new Map();
  for (const a of players) {
    const s = await sock(a, id);
    if (!(await s.waitText((t) => t.t === 'joined'))) throw new Error(`${a.name} not joined: ${JSON.stringify(s.closed)}`);
    out.set(a.name, s);
  }
  return out;
}
// Everyone ready (with these round trips for the host's pick); → the host's socket, once { t: 'host' } and 'start' are out.
async function startMatch(m, socks, rtts = {}) {
  for (const x of m.members.values()) x.mrtt = rtts[x.name] || [];
  for (const s of socks.values()) s.send({ t: 'ready' });
  await until(() => m.host != null);
  const host = [...socks.values()].find((s) => s.acc.id === P().memberAt(m, m.host).userId);
  for (const s of socks.values()) await s.waitText((t) => t.t === 'start');
  return host;
}
const goLive = async (m, host) => { host.send({ t: 'live', tick: 0 }); await until(() => m.liveAt != null); };
// A round's end as a host sends it: the winner's first slot kills the losing squad (elim), unless told otherwise.
function roundMsg(m, w, opts = {}) {
  const lose = V.otherSquad(w), n = m.rounds.length + 1, score = { ...m.score, [w]: m.score[w] + 1 };
  const killer = opts.killer ?? V.slotsOf(m.mode, w)[0], why = opts.why ?? 'elim';
  const kills = opts.kills ?? (why === 'elim' ? V.slotsOf(m.mode, lose).map((v) => [killer, v, opts.assister ?? 255, 7, 0]) : []);
  return { t: 'round', n: opts.n ?? n, w, why, score: opts.score ?? score, kills, mvp: opts.mvp ?? killer, mvpWhy: 'kills' };
}
async function playRound(m, host, w, { gap = 35000, ...opts } = {}) {
  advance(gap);
  const n = m.rounds.length;
  host.send(roundMsg(m, w, opts));
  return until(() => m.rounds.length > n || m.voidWhy, 3000);
}
const humanOf = (m, name) => [...m.members.values()].find((x) => x.userId === ACC[name].id);
const closeAll = async (socks) => { for (const s of socks.values()) await s.close(); };
// Ends whatever match these players are in (no pay) and clears their dodges, for the next check.
async function dispose(...names) {
  for (const n of names) {
    const m = P().matchOf.get(ACC[n].id);
    if (m && !m.finalizing && !m.ending) await P().staffEnd({ name: 'test' }, m.id, false).catch(() => {});
    await P().clearDodge(ACC[n].id);
    P().queue.delete(ACC[n].id);
  }
  await until(() => names.every((n) => !P().matchOf.has(ACC[n].id)), 3000);
}
// And their matchmaking cooldowns (an abandon's), for the next check.
async function noCooldown(...names) { for (const n of names) await setState(ACC[n].id, (x) => { x.mm = MM.freshMM(); }); }

try {
  // ---- 1. compatibility and routing ---------------------------------------------------------------------------------
  {
    const old = await client(ACC.oldie, { caps: OLD_CAPS });
    check('1.1.7\'s hello: the welcome names exactly lean1, p2p1 and face1', JSON.stringify(old.welcome.caps) === JSON.stringify(OLD_CAPS), JSON.stringify(old.welcome.caps));
    const none = await client(ACC.oldie, { noCaps: true });
    check('a hello without caps: no caps in the welcome', !('caps' in none.welcome));
    check('a pvp1 hello: the welcome names pvp1', ACC.p01.c.welcome.caps.includes('pvp1'));
    const e = await refused(old.pvp('state'));
    check('ns pvp without pvp1: refused, outdated', e?.code === 'outdated' && /Update the game/.test(e.message), e?.message);
    const e2 = await refused(none.pvp('queue', { mode: 'competitive', maps: MAPS }));
    check('ns pvp from a game without caps: refused, outdated', e2?.code === 'outdated');
    check('/ws: permessage-deflate is negotiated as before', ACC.p01.c.ws.extensions.startsWith('permessage-deflate'), ACC.p01.c.ws.extensions);
    const small = await upgrade('/ws', 'permessage-deflate; server_max_window_bits=10');
    check('/ws: an offer it can\'t take still connects, uncompressed', small.status === 101 && small.ext === null, JSON.stringify(small));
    const foo = await upgrade('/foo', null);
    check('another path: a 400, as before', foo.status === 400, JSON.stringify(foo));
    const m1 = await upgrade('/match', 'permessage-deflate; client_max_window_bits');
    check('/match: never compressed, even when offered', m1.status === 101 && m1.ext === null, JSON.stringify(m1));
    const ms = await sock(ACC.oldie, 'nope', { hello: false });
    check('/match: the ws client\'s deflate offer is declined', ms.ws.extensions === '', ms.ws.extensions);
    await ms.close();
    const h = await (await fetch(base() + '/health')).json();
    check('/health: pvp (queued, matches, members) and loopP99', h.pvp && h.pvp.queued === 0 && h.pvp.matches === 0 && h.pvp.members === 0 && 'loopP99' in h.pvp, JSON.stringify(h.pvp));
    const boss = ACC.boss.c;
    const s0 = await boss.admin('settings.get');
    check('admin: settings.get has every old key, and pvp on', ['motd', 'maintenance', 'maintenanceMsg', 'registration', 'trading', 'gambling', 'market'].every((k) => k in s0) && s0.pvp === true);
    const s1 = await boss.admin('settings.set', { settings: { pvp: false } });
    const s2 = await boss.admin('settings.set', { settings: { pvp: true } });
    check('admin: the pvp switch is accepted', s1.pvp === false && s2.pvp === true);
    // (an old game's admin panel saving the keys it knows)
    const s3 = await boss.admin('settings.set', { settings: { motd: 'hi', trading: true } });
    check('admin: a save without pvp keeps it', s3.pvp === true && s3.motd === 'hi');
    await boss.admin('settings.set', { settings: { motd: '' } });
    // (Old games: no pvp pushes, whatever happens. Checked at the end, after everything below.)
    ACC.oldie.watch = old;
    await none.close();
  }

  // ---- 2. the queue ---------------------------------------------------------------------------------------------------
  {
    // Ranks, so the teams snake by rating: p01 highest.
    for (const [i, n] of NAMES.entries()) await setState(ACC[n].id, (s) => { s.rank = { ...R.freshRank(), mmr: 1700 - i * 50, group: R.groupFor(1700 - i * 50), wins: 12 }; s.wingman = { ...R.freshRank(), mmr: 1700 - i * 50, group: R.groupFor(1700 - i * 50), wins: 12 }; });
    // 10 in Competitive: a match at once.
    const ten = ps(...NAMES.slice(0, 10));
    for (const a of ten) await a.c.pvp('queue', { mode: 'competitive', maps: MAPS });
    await tick();
    const f10 = await Promise.all(ten.map((a) => a.c.waitFor((e) => e.t === 'pvp.found', 2000)));
    check('10 players in Competitive: a match at once, for all of them', f10.every((f) => f && f.id === f10[0].id && f.humans === 10 && f.mode === 'competitive'),
      JSON.stringify(f10[0]));
    check('the map: one they all have exported first', f10[0].map === 'de_dust2', f10[0].map);
    check('pvp.found\'s deadline: 20 s on the server\'s clock', f10[0].deadline === now + V.QUEUE.ACCEPT);
    const st10 = await ten[0].c.pvp('state');
    check('state: the match found, not accepted yet', st10.found?.id === f10[0].id && st10.found.accepted === false && st10.queue === null && st10.match === null, JSON.stringify(st10));
    for (const a of ten) await a.c.pvp('accept', { id: f10[0].id });
    const go10 = await Promise.all(ten.map((a) => a.c.waitFor((e) => e.t === 'pvp.go')));
    const m10 = P().matches.get(f10[0].id);
    const acc10 = ten[3].c.events.filter((e) => e.t === 'pvp.accepts').map((e) => e.n);
    check('accepts: each told the count as it goes up', acc10.join() === '1,2,3,4,5,6,7,8,9,10', acc10.join());
    check('all accepted: loading, a row, and pvp.go to each with their slot', m10?.status === 'loading' && go10.every((g, i) => g && g.slot === humanOf(m10, ten[i].name).slot && g.map === 'de_dust2' && g.loadBy === m10.loadBy)
      && (await rows('SELECT status FROM pvp_matches WHERE id = $1', [m10.id]))[0]?.status === 'loading'
      && (await rows('SELECT count(*)::int AS n FROM pvp_players WHERE match_id = $1 AND paid IS NULL', [m10.id]))[0].n === 10);
    const snake = [...m10.slots].filter((s) => s.kind === 'human').sort((a, b) => b.mmr - a.mmr).map((s) => s.squad).join('');
    check('teams: snaked by rating, A B B A A B B A A B', snake === 'ABBAABBAAB', snake);
    check('slots: A 0-4, B 5-9, no bots in a full lobby', m10.slots.every((s) => s.squad === (s.slot < 5 ? 'A' : 'B') && s.kind === 'human'));
    check('a full lobby loads in 3 minutes (every map exported)', m10.loadBy - m10.created === V.TIMES.LOAD);
    const busy = await refused(ten[0].c.pvp('queue', { mode: 'wingman', maps: MAPS }));
    check('in a match: searching again is refused, busy', busy?.code === 'busy', busy?.message);
    await dispose(...NAMES.slice(0, 10));

    // 4 in Wingman: at once.
    const four = ps('p01', 'p02', 'p03', 'p04');
    const w4 = await lobby(four, 'wingman', { fill: false });
    check('4 players in Wingman: a match at once, 2v2, no bots', w4.m.slots.length === 4 && w4.m.slots.every((s) => s.kind === 'human') && w4.found[0].humans === 4);
    await dispose('p01', 'p02', 'p03', 'p04');

    // 3 in Competitive: nothing before the fill time, then 1 + 4 bots against 2 + 3 bots.
    const three = ps('p01', 'p02', 'p03');
    for (const a of three) { a.c.clear(); await a.c.pvp('queue', { mode: 'competitive', maps: MAPS }); }
    advance(V.QUEUE.FILL_AFTER - 5000);
    await tick();
    const q3 = await three[2].c.waitFor((e) => e.t === 'pvp.q' && e.waited > 0);
    check('3 players: no match before 2 minutes', !three.some((a) => a.c.events.some((e) => e.t === 'pvp.found')));
    check('pvp.q: found 3 of 10, the split in 5 s, not alone', q3 && q3.found === 3 && q3.need === 10 && q3.split === 5 && q3.alone === false && q3.mode === 'competitive', JSON.stringify(q3));
    advance(6000);
    await tick();
    const f3 = await three[0].c.waitFor((e) => e.t === 'pvp.found');
    for (const a of three) await a.c.pvp('accept', { id: f3.id });
    const m3 = await until(() => P().matches.get(f3.id));
    const hum = (sq) => m3.slots.filter((s) => s.squad === sq && s.kind === 'human').length, bots = m3.slots.filter((s) => s.kind === 'bot');
    check('3 players after 2 minutes: 1 + 4 bots against 2 + 3 bots', hum('A') === 1 && hum('B') === 2 && bots.length === 7, `A ${hum('A')}, B ${hum('B')}`);
    check('the highest rated alone in A, the next two in B', humanOf(m3, 'p01').squad === 'A' && humanOf(m3, 'p02').squad === 'B' && humanOf(m3, 'p03').squad === 'B');
    check('humans first in each squad\'s slots, bots after', m3.slots.filter((s) => s.squad === 'A').map((s) => s.kind).join() === 'human,bot,bot,bot,bot'
      && m3.slots.filter((s) => s.squad === 'B').map((s) => s.kind).join() === 'human,human,bot,bot,bot');
    const avg = (1700 + 1650 + 1600) / 3;
    check('bots: each a skill around the humans\' average rating, and a rank emblem', bots.every((b) => b.skill >= 0 && b.skill <= 1 && Math.abs(V.mmrOfSkill(b.skill) - avg) < 200 && b.group >= 1 && b.name === null),
      bots.map((b) => V.mmrOfSkill(b.skill)).join());
    check('sides: one squad CT, the other T', ['CT', 'T'].includes(m3.sides.A) && m3.sides.B === (m3.sides.A === 'CT' ? 'T' : 'CT'));
    await dispose('p01', 'p02', 'p03');

    // 1 alone: waits; alone after 2 minutes; a second player: matched 1v1 with bots.
    const solo = ACC.p05;
    solo.c.clear();
    await solo.c.pvp('queue', { mode: 'wingman', maps: MAPS });
    advance(V.QUEUE.FILL_AFTER + 1000);
    await tick();
    const qa = await solo.c.waitFor((e) => e.t === 'pvp.q' && e.waited > 0);
    check('alone after 2 minutes: alone, and no match', qa?.alone === true && !solo.c.events.some((e) => e.t === 'pvp.found') && (await solo.c.pvp('state')).queue?.alone === true, JSON.stringify(qa));
    await ACC.p06.c.pvp('queue', { mode: 'wingman', maps: MAPS });
    await tick();
    const f2 = await solo.c.waitFor((e) => e.t === 'pvp.found');
    check('a second player: matched at once, 1v1', f2?.humans === 2);
    for (const n of ['p05', 'p06']) await ACC[n].c.pvp('accept', { id: f2.id });
    const m2 = await until(() => P().matches.get(f2.id));
    check('1v1 in Wingman: each with a bot', m2.slots.filter((s) => s.kind === 'bot').length === 2 && humanOf(m2, 'p05').squad !== humanOf(m2, 'p06').squad);
    await dispose('p05', 'p06');

    // Maps: different content never matches; the intersection, exported first; fixed sites; versions.
    const a = ACC.p07, b = ACC.p08;
    for (const x of [a, b]) x.c.clear();
    await a.c.pvp('queue', { mode: 'wingman', maps: [{ id: 'de_vertigo', c: C1, x: true }] });
    await b.c.pvp('queue', { mode: 'wingman', maps: [{ id: 'de_vertigo', c: C2, x: true }] });
    advance(V.QUEUE.FILL_AFTER + 1000);
    await tick();
    const qva = await a.c.waitFor((e) => e.t === 'pvp.q' && e.waited > 0), qvb = await b.c.waitFor((e) => e.t === 'pvp.q' && e.waited > 0);
    check('the same map with different content: never matched (each alone)', !a.c.events.some((e) => e.t === 'pvp.found') && qva?.alone === true && qva.found === 1 && qvb?.alone === true);
    await a.c.pvp('queue', { mode: 'wingman', maps: [{ id: 'de_vertigo', c: C2, x: false }, { id: 'de_nuke', c: C1, x: false }, { id: 'de_inferno', c: C1, x: true }], fixed: ['de_inferno'] });
    await b.c.pvp('queue', { mode: 'wingman', maps: [{ id: 'de_vertigo', c: C2, x: true }, { id: 'de_inferno', c: C1, x: true }, { id: 'de_nuke', c: C1, x: true }] });
    await tick();
    const fm = await a.c.waitFor((e) => e.t === 'pvp.found');
    for (const x of [a, b]) await x.c.pvp('accept', { id: fm.id });
    const mm = await until(() => P().matches.get(fm.id));
    check('maps: one both can load, exported by both first; a map with its own site has none', fm.map === 'de_inferno' && mm.site === null, `${fm.map} ${mm?.site}`);
    await dispose('p07', 'p08');
    for (const x of [a, b]) x.c.clear();
    await a.c.pvp('queue', { mode: 'wingman', maps: [{ id: 'de_nuke', c: C1, x: false }] });
    await b.c.pvp('queue', { mode: 'wingman', maps: [{ id: 'de_nuke', c: C1, x: true }] });
    advance(V.QUEUE.FILL_AFTER + 1000);
    await tick();
    const fs2 = await a.c.waitFor((e) => e.t === 'pvp.found');
    for (const x of [a, b]) await x.c.pvp('accept', { id: fs2.id });
    const ms2 = await until(() => P().matches.get(fs2.id));
    check('Wingman: a site, A or B, when no one says the map has its own', ['A', 'B'].includes(ms2.site), ms2.site);
    check('a map someone hasn\'t exported yet: 7 minutes to load', ms2.loadBy - ms2.created === V.TIMES.LOAD_EXPORT);
    await dispose('p07', 'p08');
    // Another version of the game: another queue.
    const other = await client(ACC.p09, { app: '1.2.1' });
    other.clear();
    ACC.p10.c.clear();
    await other.pvp('queue', { mode: 'wingman', maps: MAPS });
    await ACC.p10.c.pvp('queue', { mode: 'wingman', maps: MAPS });
    advance(V.QUEUE.FILL_AFTER + 1000);
    await tick();
    check('another version of the game: never matched together', !other.events.some((e) => e.t === 'pvp.found') && !ACC.p10.c.events.some((e) => e.t === 'pvp.found'));
    await ACC.p10.c.pvp('leave');
    await other.pvp('leave');
    await other.close();

    // A search outlives its socket a moment: searching again within 15 s keeps its place; leave ends it.
    const r1 = await ACC.p11.c.pvp('queue', { mode: 'competitive', maps: MAPS });
    advance(30000);
    await ACC.p11.c.close();
    await until(() => P().queue.get(ACC.p11.id)?.gone != null);
    advance(10000);
    await tick();
    const c11 = await client(ACC.p11);
    const r2 = await c11.pvp('queue', { mode: 'competitive', maps: MAPS });
    check('searching again within 15 s of the socket closing keeps its place (since)', r2.since === r1.since && r2.pool.join() === 'de_dust2,de_mirage', `${r1.since} ${r2.since}`);
    check('leave: out of the queue', (await c11.pvp('leave')).left === true && !P().queue.has(ACC.p11.id) && (await c11.pvp('leave')).left === false);
    await c11.pvp('queue', { mode: 'competitive', maps: MAPS });
    await c11.close();
    await until(() => P().queue.get(ACC.p11.id)?.gone != null);
    advance(16000);
    await tick();
    check('a search whose socket closed: gone after 15 s', !P().queue.has(ACC.p11.id));
    await client(ACC.p11);

    // Refusals.
    const p12 = ACC.p12.c;
    const mapsBad = await refused(p12.pvp('queue', { mode: 'competitive', maps: [{ id: 'de_poseidon', c: C1, x: true }, { id: 'bad id', c: C1 }, { id: 'de_dust2', c: 'xyz' }] }));
    check('no map of the mode\'s pool: refused, maps', mapsBad?.code === 'maps', mapsBad?.message);
    const modeBad = await refused(p12.pvp('queue', { mode: 'deathmatch', maps: MAPS }));
    check('a mode other than Competitive and Wingman: refused', modeBad?.code === 'bad');
    await setState(ACC.p12.id, (s) => { s.mm = { ...MM.freshMM(), match: { mode: 'competitive', opponent: 1000, at: now - 60000 } }; });
    const rank0 = (await st(ACC.p12.id)).rank.mmr;
    const settled = await refused(p12.pvp('queue', { mode: 'competitive', maps: MAPS }));
    const s12 = await st(ACC.p12.id);
    check('a ranked bot match still open: settled first (a loss, the cooldown), then refused, cooldown, in play.join\'s words',
      settled?.code === 'cooldown' && /^You can't play Competitive for 30 minutes: you abandoned a match$/.test(settled.message) && s12.mm.match === null && s12.mm.until > now && s12.rank.mmr < rank0,
      settled?.message);
    check('the game was sent that change', p12.st.mm?.until === s12.mm.until);
    const cd = await refused(p12.pvp('queue', { mode: 'wingman', maps: MAPS }));
    check('in a cooldown: refused, cooldown', cd?.code === 'cooldown' && /Wingman for 30 minutes/.test(cd.message), cd?.message);
    await setState(ACC.p12.id, (s) => { s.mm = MM.freshMM(); });
    await boss_settings({ pvp: false });
    const off = await refused(p12.pvp('queue', { mode: 'competitive', maps: MAPS }));
    check('the admin switch off: refused, off', off?.code === 'off');
    await boss_settings({ pvp: true });
    advance(61000); // (the requests above counted too)
    let rate = null;
    for (let i = 0; i < 11 && !rate; i++) { const e = await refused(p12.pvp('queue', { mode: 'competitive', maps: MAPS })); if (e?.code === 'rate') rate = i + 1; }
    check('searching: the 11th in a minute is refused, rate', rate === 11, String(rate));
    await p12.pvp('leave');
    advance(61000);
  }

  // ---- 3. accepting -----------------------------------------------------------------------------------------------------
  {
    const two = ps('p01', 'p02');
    const t1 = await lobby(two, 'wingman', { accept: false });
    await ACC.p01.c.pvp('accept', { id: t1.id });
    const sinceP01 = P().foundOf.get(ACC.p01.id).entries.find((e) => e.userId === ACC.p01.id).since;
    advance(V.QUEUE.ACCEPT + 1000);
    await tick();
    const c1 = await ACC.p01.c.waitFor((e) => e.t === 'pvp.cancel'), c2 = await ACC.p02.c.waitFor((e) => e.t === 'pvp.cancel');
    check('a timeout: the one who accepted is back in the queue in their place', c1?.why === 'timeout' && c1.requeued === true && P().queue.get(ACC.p01.id)?.since === sinceP01);
    const left1 = P().dodgeLeft(ACC.p02.id);
    check('the one who didn\'t: out, with a 1 minute dodge', c2?.why === 'timeout' && c2.requeued === false && !P().queue.has(ACC.p02.id) && left1 === 60000, `${left1}`);
    const dg = await refused(ACC.p02.c.pvp('queue', { mode: 'wingman', maps: MAPS }));
    check('in a dodge: refused, dodge', dg?.code === 'dodge' && /search again in 1 minute/.test(dg.message), dg?.message);
    check('state: the dodge left', (await ACC.p02.c.pvp('state')).dodge === 60000);
    advance(61000);
    await ACC.p01.c.pvp('leave');
    const t2 = await lobby(two, 'wingman', { accept: false });
    await ACC.p02.c.pvp('decline', { id: t2.id });
    const d2 = await ACC.p02.c.waitFor((e) => e.t === 'pvp.cancel' && e.id === t2.id);
    check('a decline: the match is off at once; a second dodge within the hour is 5 minutes', d2?.why === 'declined' && P().dodgeLeft(ACC.p02.id) === 300000 && P().queue.has(ACC.p01.id));
    const gone = await refused(ACC.p01.c.pvp('accept', { id: t2.id }));
    check('accepting a match that\'s off: refused, missing', gone?.code === 'missing');
    advance(301000);
    await ACC.p01.c.pvp('leave');
    const t3 = await lobby(two, 'wingman', { accept: false });
    await ACC.p02.c.pvp('decline', { id: t3.id });
    check('a third within the hour: 30 minutes', P().dodgeLeft(ACC.p02.id) === 1800000);
    await ACC.p01.c.pvp('leave');
    P().dodges.delete(ACC.p02.id);
    let accRate = null;
    const t4 = await lobby(two, 'wingman', { accept: false });
    for (let i = 0; i < 6 && !accRate; i++) { const e = await refused(ACC.p01.c.pvp('accept', { id: t4.id })); if (e?.code === 'rate') accRate = i + 1; }
    check('accept: the 6th in 10 s is refused, rate', accRate === 6, String(accRate));
    await ACC.p02.c.pvp('decline', { id: t4.id });
    P().dodges.delete(ACC.p02.id);
    await ACC.p01.c.pvp('leave');
    advance(61000);

    // The load deadline. A squad with none of its humans ready: the match is off ('load-failed'), whoever was ready searches
    // again in their place, whoever wasn't waits a dodge.
    const LF = await lobby(two, 'wingman');
    const since1 = humanOf(LF.m, 'p01').since;
    const s1 = await joinAll([ACC.p01], LF.id);
    s1.get('p01').send({ t: 'ready' });
    await until(() => humanOf(LF.m, 'p01').ready);
    advance(V.TIMES.LOAD + 1000);
    await tick();
    const lf1 = await ACC.p01.c.waitFor((e) => e.t === 'pvp.cancel' && e.id === LF.id), lf2 = await ACC.p02.c.waitFor((e) => e.t === 'pvp.cancel' && e.id === LF.id);
    check('load deadline, a squad with nobody ready: off; the ready one back in the queue in their place, the other a dodge',
      lf1?.why === 'load-failed' && lf1.requeued === true && P().queue.get(ACC.p01.id)?.since === since1 && lf2?.requeued === false && P().dodgeLeft(ACC.p02.id) > 0
      && (await rows('SELECT status FROM pvp_matches WHERE id = $1', [LF.id]))[0].status === 'cancelled', JSON.stringify([lf1, lf2]));
    check('and its /match sockets closed, 4004', (await s1.get('p01').waitClosed())?.code === 4004);
    await dispose('p01', 'p02');
    // A map that won't load (before the start): a dodge, not an abandon; the others start without waiting for it.
    const four = ps('p01', 'p02', 'p03', 'p04');
    const LD = await lobby(four, 'wingman', { fill: false });
    const sd = await joinAll(four, LD.id);
    const mm4 = structuredClone((await st(ACC.p04.id)).mm || null);
    sd.get('p04').send({ t: 'load', p: 30, failed: 'The map couldn\'t be exported' });
    await until(() => humanOf(LD.m, 'p04').abandoned);
    for (const n of ['p01', 'p02', 'p03']) sd.get(n).send({ t: 'ready' });
    await until(() => LD.m.host != null);
    check('a map that won\'t load: a dodge for them (no cooldown, no rank loss), their slot a bot, and the rest start', P().dodgeLeft(ACC.p04.id) > 0 && JSON.stringify((await st(ACC.p04.id)).mm || null) === JSON.stringify(mm4)
      && LD.m.host != null && (await rows('SELECT outcome FROM pvp_matches m JOIN pvp_players p ON p.match_id = m.id WHERE m.id = $1 AND p.user_id = $2', [LD.id, ACC.p04.id]))[0]?.outcome === 'dodge'
      && !!(await ACC.p04.c.waitFor((e) => e.t === 'pvp.over' && e.id === LD.id)));
    await closeAll(sd);
    await dispose('p01', 'p02', 'p03', 'p04');
    // Someone missing at the deadline (their squad has another ready): a bot for them, and they can still come in.
    const LM = await lobby(four, 'wingman', { fill: false });
    const sm = await joinAll(ps('p01', 'p02', 'p03'), LM.id);
    for (const s of sm.values()) s.send({ t: 'ready' });
    await until(() => ['p01', 'p02', 'p03'].every((n) => humanOf(LM.m, n).ready));
    check('3 of 4 ready: no start before the deadline', LM.m.host == null);
    advance(V.TIMES.LOAD + 1000);
    await tick();
    const late = humanOf(LM.m, 'p04');
    check('the deadline: the host picked, the one missing a bot', LM.m.host != null && late.state === 'bot' && late.control.at(-1)?.back === null);
    const s4 = await sock(ACC.p04, LM.id);
    await s4.waitText((t) => t.t === 'joined');
    check('coming in late: loading (a bot still plays for them)', late.state === 'loading' && late.control.at(-1)?.back === null);
    s4.send({ t: 'ready' });
    await until(() => late.state === 'in');
    check('loaded: in, control back', late.state === 'in' && late.control.at(-1)?.back != null);
    sm.set('p04', s4);
    await closeAll(sm);
    await dispose('p01', 'p02', 'p03', 'p04');
  }

  // ---- 4. host election ---------------------------------------------------------------------------------------------
  {
    // Tagged /ws pongs: queued pvp1 games are pinged ([0x70][f64]) and their pongs are round trips.
    const a = ACC.p03;
    await a.c.pvp('queue', { mode: 'competitive', maps: MAPS });
    const e = P().queue.get(a.id);
    for (let i = 0; i < 3; i++) { P().lastPing = 0; await tick(); await until(() => e.rtt.length > i, 2000); }
    check('queued: pinged, and the pongs are round trip samples', e.rtt.length >= 3 && e.rtt.every((ms) => ms >= 0 && ms < 1000), e.rtt.join());
    const alive = [...server.srv.sockets.get(a.id)][0];
    check('the 30 s keepalive still sees those pongs', alive.isAlive === true);
    await a.c.pvp('leave');

    const four = ps('p01', 'p02', 'p03', 'p04');
    const L4 = await lobby(four, 'wingman', { fill: false });
    const socks = await joinAll(four, L4.id);
    const host = await startMatch(L4.m, socks, { p01: [80, 82, 81, 79, 80], p02: [30, 31, 29, 30, 30], p03: [35, 36, 34, 35, 35], p04: [300, 300, 300, 300, 300] });
    check('host: the lowest median round trip (p02); backups in order', host.acc.name === 'p02' && L4.m.backups.map((s) => P().memberAt(L4.m, s).name).join() === 'p03,p01,p04',
      `${host.acc.name} ${L4.m.backups}`);
    const hostMsg = await socks.get('p04').waitText((t) => t.t === 'host');
    check('{ t: host } and { t: start } to everyone', hostMsg?.slot === L4.m.host && socks.get('p04').texts.some((t) => t.t === 'start'));
    await closeAll(socks);
    await dispose('p01', 'p02', 'p03', 'p04');
    // Unit: ties, over 250 ms, host-left history, no samples.
    const mk = (slot, mrtt, extra = {}) => ({ slot, connected: true, ready: true, mrtt, qrtt: [], hostLeft: 0, since: slot, ...extra });
    const pick = (ms) => V.pickHost(ms).map((x) => x.slot).join();
    check('pickHost: medians within 10 ms tie, then the steadier', pick([mk(0, [40, 41, 40, 39, 40]), mk(1, [35, 20, 50, 35, 36])]) === '0,1');
    check('pickHost: over 250 ms goes when someone is under it', pick([mk(0, [300, 300, 300, 300, 300]), mk(1, [240, 240, 240, 240, 240])]) === '1,0');
    check('pickHost: 2 host-left matches in a week pass you over, unless that leaves nobody', pick([mk(0, [20, 20, 20, 20, 20], { hostLeft: 2 }), mk(1, [60, 60, 60, 60, 60])]) === '1,0'
      && pick([mk(0, [20, 20, 20, 20, 20], { hostLeft: 2 })]) === '0');
    check('pickHost: no samples: the longest queued who\'s ready', pick([mk(0, [], { since: 9 }), mk(1, [], { since: 3 }), mk(2, [], { since: 1, ready: false })]) === '1,0');
    check('pickHost: queue samples count when /match has too few', pick([mk(0, [1, 1], { qrtt: [90, 90, 90] }), mk(1, [], { qrtt: [50, 50, 50] })]) === '1,0');
  }

  // ---- 5. the relay: auth and frames --------------------------------------------------------------------------------
  let RL = null;
  {
    const four = ps('p01', 'p02', 'p03', 'p04');
    const L4 = await lobby(four, 'wingman', { fill: false });
    RL = L4;
    const quiet1 = await sock(ACC.p01, L4.id, { hello: false });
    const qc = await quiet1.waitClosed(3000);
    check('/match: no hello within the time: 4002', qc?.code === 4002, JSON.stringify(qc));
    const badTok = await sock(ACC.p01, L4.id, { token: 'not-a-real-token-xxxxxxxxxxxxx' });
    check('/match: a bad token: 4001', (await badTok.waitClosed())?.code === 4001);
    const stranger = await sock(ACC.p05, L4.id);
    check('/match: not one of its players: 4003', (await stranger.waitClosed())?.code === 4003);
    const nowhere = await sock(ACC.p01, 'no-such-match');
    check('/match: no such match: 4004', (await nowhere.waitClosed())?.code === 4004);
    const wrongApp = await sock(ACC.p01, L4.id, { app: '1.1.9' });
    check('/match: another version of the game: 4002', (await wrongApp.waitClosed())?.code === 4002);
    const bin = await sock(ACC.p01, L4.id, { hello: false });
    bin.bin(Buffer.from([1, 1, 2, 3]));
    check('/match: a binary frame before the hello: 4002', (await bin.waitClosed())?.code === 4002);
    const socks = await joinAll(four, L4.id);
    const j = socks.get('p03').texts.find((t) => t.t === 'joined');
    const me3 = humanOf(L4.m, 'p03');
    check('joined: the match, its slots with names, pictures, badges, ranks and looks, and the members', j.id === L4.id && j.mode === 'wingman' && j.map === 'de_dust2' && j.slot === me3.slot
      && j.host === null && j.status === 'loading' && Number.isInteger(j.seed) && j.slots.length === 4 && j.slots.every((s) => s.kind === 'human' && s.name && 'pic' in s && 'group' in s && s.look && 'guns' in s.look && !('mmr' in s))
      && j.members.length === 4, JSON.stringify(j).slice(0, 300));
    const again = await sock(ACC.p03, L4.id);
    await again.waitText((t) => t.t === 'joined');
    check('a second socket for the same player replaces the first: 4000', (await socks.get('p03').waitClosed())?.code === 4000 && again.ws.readyState === 1);
    socks.set('p03', again);
    // Loading progress, throttled.
    for (let p = 10; p <= 50; p += 10) socks.get('p04').send({ t: 'load', p, stage: 'Preparing the map…' });
    await wait(700);
    const loads = socks.get('p01').texts.filter((t) => t.t === 'member' && t.slot === humanOf(L4.m, 'p04').slot && t.state === 'loading').map((t) => t.load);
    check('load progress to everyone, at most 2 a second, the last one always', loads.length >= 1 && loads.length <= 3 && loads.at(-1) === 50, loads.join());
    const host = await startMatch(L4.m, socks, { p01: [10, 10, 10, 10, 10], p02: [40, 40, 40, 40, 40], p03: [50, 50, 50, 50, 50], p04: [60, 60, 60, 60, 60] });
    await goLive(L4.m, host);
    check('the host is p01; live', host.acc.name === 'p01' && L4.m.status === 'live');
    const s2 = socks.get('p02'), s3 = socks.get('p03'), s4 = socks.get('p04');
    const slot = (n) => humanOf(L4.m, n).slot;
    // Inputs: clients' CMDS reach the host as INPUTS, with their slots, gathered.
    host.bins.length = 0;
    s2.bin(Buffer.from([0x01, 1, 0xaa, 0xbb]));
    s3.bin(Buffer.from([0x01, 2, 0xcc]));
    s2.bin(Buffer.from([0x01, 1, 0xdd]));
    await until(() => host.bins.reduce((n, b) => n + b[1], 0) >= 3, 2000);
    const ins = [];
    for (const b of host.bins) {
      if (b[0] !== 0x81) continue;
      let p = 2;
      for (let i = 0; i < b[1]; i++) { const s = b[p], len = b.readUInt16LE(p + 1); ins.push([s, [...b.subarray(p + 3, p + 3 + len)]]); p += 3 + len; }
    }
    const sorted = (x) => x.map((i) => JSON.stringify(i)).sort().join();
    check('CMDS -> the host as INPUTS: each with its slot and its body ([n][cmd…]), a socket\'s in its order', sorted(ins) === sorted([[slot('p02'), [1, 0xaa, 0xbb]], [slot('p03'), [2, 0xcc]], [slot('p02'), [1, 0xdd]]])
      && JSON.stringify(ins.filter((i) => i[0] === slot('p02'))) === JSON.stringify([[slot('p02'), [1, 0xaa, 0xbb]], [slot('p02'), [1, 0xdd]]]), JSON.stringify(ins));
    check('INPUTS: gathered into fewer frames than commands', host.bins.filter((b) => b[0] === 0x81).length < 3, String(host.bins.length));
    // A bundle: each member its SNAP (shared + own); one without an own part, shared only. UNICAST to one.
    const shared = Buffer.from('SHARED'), bundle = Buffer.concat([Buffer.from([0x10]), u32(77), u16(shared.length), shared, Buffer.from([2]),
      Buffer.from([slot('p02')]), u16(3), Buffer.from('own'), Buffer.from([slot('p03')]), u16(4), Buffer.from('mine')]);
    for (const s of [s2, s3, s4]) s.bins.length = 0;
    host.bin(bundle);
    await until(() => s2.bins.length && s3.bins.length && s4.bins.length, 2000);
    const head = (b) => [b[0], b.readUInt32LE(1), b.readUInt16LE(5)];
    check('BUNDLE -> SNAP with the shared part and the member\'s own', JSON.stringify(head(s2.bins[0])) === '[144,77,6]' && s2.bins[0].subarray(7).toString() === 'SHAREDown'
      && s3.bins[0].subarray(7).toString() === 'SHAREDmine', s2.bins[0]?.toString('hex'));
    check('a member without an own part: the shared part only', s4.bins[0]?.subarray(7).toString() === 'SHARED');
    check('the host gets no SNAP of its own', !host.bins.some((b) => b[0] === 0x90));
    host.bin(Buffer.concat([Buffer.from([0x11, slot('p04')]), Buffer.from('KEYFRAME')]));
    await until(() => s4.bins.length > 1, 2000);
    check('UNICAST -> that slot only, as [0x91][payload]', s4.bins.at(-1)?.[0] === 0x91 && s4.bins.at(-1).subarray(1).toString() === 'KEYFRAME' && s2.bins.length === 1 && s3.bins.length === 1);
    // Wrong frames: dropped.
    host.bins.length = 0;
    s2.bin(Buffer.concat([Buffer.from([0x01, 1]), Buffer.alloc(300)])); // (over 256 B)
    s2.bin(Buffer.from([0x10, 0, 0, 0, 0, 0, 0, 0])); // (a client's bundle)
    s2.bin(Buffer.from([0x55, 1])); // (no such type)
    host.bin(Buffer.from([0x01, 1, 5])); // (the host's CMDS)
    await wait(200);
    check('a client\'s oversize CMDS, a client\'s BUNDLE, an unknown type, a host\'s CMDS: all dropped', host.bins.length === 0 && s3.bins.length === 1);
    host.bin(Buffer.from([0x10, 1, 0, 0, 0, 200, 0])); // (a bundle whose shared part runs past its end)
    await wait(100);
    check('a bundle that doesn\'t read right: dropped', s3.bins.length === 1 && host.ws.readyState === 1);
    s2.bin(Buffer.alloc(33 * 1024, 1));
    check('a frame over 32 KB closes the socket', (await s2.waitClosed())?.code === 1009, JSON.stringify(s2.closed));
    socks.set('p02', await sock(ACC.p02, L4.id));
    await socks.get('p02').waitText((t) => t.t === 'joined');
    // A client flooding: drops, then 1008 once it keeps it up (abuseMs, 1.5 s here).
    const flood = socks.get('p04');
    const t0 = Date.now();
    while (Date.now() - t0 < 2500 && flood.ws.readyState === 1) { for (let i = 0; i < 20; i++) flood.bin(Buffer.from([0x01, 1, i])); await wait(10); }
    check('a client flooding 2000 frames a second: closed, 1008', (await flood.waitClosed(2000))?.code === 1008, JSON.stringify(flood.closed));
    // The host's bytes: past 512 KB a second, bundles are dropped.
    const relayB = server.srv.relay, bundleOf = relayB.bundle.bind(relayB);
    let bundled = 0;
    relayB.bundle = (w, b) => { bundled++; return bundleOf(w, b); };
    const big = Buffer.concat([Buffer.from([0x10]), u32(1), u16(15000), Buffer.alloc(15000, 7), Buffer.from([0])]);
    for (let i = 0; i < 60; i++) host.bin(big);
    await wait(500);
    relayB.bundle = bundleOf;
    check('a host past 512 KB a second: bundles dropped (about 34 of 60 go)', bundled > 20 && bundled < 60 && host.ws.readyState === 1, String(bundled));
    // Backpressure (the relay's own rule, on a socket whose buffer is full).
    const m = L4.m, sent = [], keys = [];
    const fake = { readyState: 1, bufferedAmount: 70 * 1024, slot: 3, send: (b) => sent.push(b), terminate: () => { fake.dead = true; } };
    const relay = server.srv.relay;
    const realSend = relay.send.bind(relay);
    relay.send = (id, s, msg) => { if (msg.t === 'key') keys.push(msg.slot); else realSend(id, s, msg); };
    relay.snap(m, fake, Buffer.from('x'));
    const skipped = sent.length === 0 && fake.needKey === true;
    fake.bufferedAmount = 0;
    relay.snap(m, fake, Buffer.from('y'));
    check('backpressure: a SNAP skipped over 64 KB waiting; drained, the host is asked for a keyframe and it goes on', skipped && sent.length === 1 && keys.join() === '3');
    fake.bufferedAmount = 70 * 1024;
    relay.snap(m, fake, Buffer.from('z'));
    fake.stuckSince -= 11000;
    relay.snap(m, fake, Buffer.from('z'));
    const stuck = fake.dead === true;
    fake.dead = false;
    fake.stuckSince = null;
    fake.bufferedAmount = 2 * 1024 * 1024;
    relay.snap(m, fake, Buffer.from('z'));
    check('backpressure: stuck 10 s, or over 1 MB waiting: cut off', stuck && fake.dead === true);
    relay.send = realSend;
    // Chat: through the server, the team's to its squad only, the filter, the limit, and blocks.
    socks.set('p04', await sock(ACC.p04, L4.id));
    await socks.get('p04').waitText((t) => t.t === 'joined');
    for (const s of socks.values()) s.texts.length = 0;
    const mate = [...socks.keys()].find((n) => n !== 'p01' && humanOf(m, n).squad === humanOf(m, 'p01').squad);
    const foe = [...socks.keys()].find((n) => humanOf(m, n).squad !== humanOf(m, 'p01').squad);
    host.send({ t: 'chat', text: '  rotate B  ', team: true });
    host.send({ t: 'chat', text: 'gg', team: false });
    await until(() => socks.get(foe).texts.some((t) => t.t === 'chat'), 2000);
    await wait(100);
    const said = (n) => socks.get(n).texts.filter((t) => t.t === 'chat').map((t) => `${t.text}/${t.team}`).join();
    check('chat: team chat to the squad (the sender too), all chat to everyone, with the name and slot', said(mate) === 'rotate B/true,gg/false' && said('p01') === 'rotate B/true,gg/false' && said(foe) === 'gg/false'
      && socks.get(foe).texts.find((t) => t.t === 'chat').name === 'p01', `${said(mate)} | ${said(foe)}`);
    await server.db.query('INSERT INTO blocks (user_id, blocked_id, at) VALUES ($1, $2, $3)', [ACC[foe].id, ACC.p01.id, Date.now()]);
    m.blocks = await P().blocksOf([...m.members.keys()]);
    for (const s of socks.values()) s.texts.length = 0;
    host.send({ t: 'chat', text: 'hello all', team: false });
    host.send({ t: 'chat', text: '‮ reversed', team: false });
    await until(() => socks.get(mate).texts.some((t) => t.t === 'chat'), 2000);
    await wait(100);
    check('chat: not to a player who blocked the sender; control characters refused', said(mate) === 'hello all/false' && said(foe) === '');
    let delivered = 0;
    for (const s of socks.values()) s.texts.length = 0;
    for (let i = 0; i < 6; i++) host.send({ t: 'chat', text: `spam ${i}`, team: true });
    await wait(300);
    delivered = socks.get('p01').texts.filter((t) => t.t === 'chat').length;
    check('chat: at most 5 in 5 seconds (social\'s limit)', delivered <= 5 && delivered >= 1, String(delivered));
    RL.socks = socks;
    RL.host = host;
  }

  // ---- 6. bans, kicks and maintenance on /match -------------------------------------------------------------------------
  {
    const m = RL.m, socks = RL.socks, boss = ACC.boss.c;
    const victim = [...socks.keys()].find((n) => n !== RL.host.acc.name);
    const vs = socks.get(victim), vm = humanOf(m, victim);
    await boss.admin('ban', { id: ACC[victim].id, minutes: 60, reason: 'test' });
    check('banned mid-match: their /match socket closes with 4005', (await vs.waitClosed())?.code === 4005, JSON.stringify(vs.closed));
    await until(() => vm.state === 'bot', 2000);
    check('their slot is a bot at once', vm.state === 'bot' && vm.banned === true && vm.control.at(-1)?.back === null);
    const again = await sock(ACC[victim], m.id);
    check('banned: a hello is refused, 4005, with the ban', (await again.waitClosed())?.code === 4005 && /banned/.test(again.closed.reason), JSON.stringify(again.closed));
    // (Not back in time: no pay, and no cooldown: a ban.)
    const mm0 = (await st(ACC[victim].id)).mm;
    advance(V.TIMES.RECONNECT + 1000);
    await tick();
    check('banned and not back in time: abandoned, without a cooldown', vm.abandoned === true && (await st(ACC[victim].id)).mm.until === mm0?.until
      && (await rows('SELECT outcome FROM pvp_players WHERE match_id = $1 AND user_id = $2', [m.id, ACC[victim].id]))[0]?.outcome === 'banned');
    await boss.admin('unban', { id: ACC[victim].id });
    await client(ACC[victim]);
    // Maintenance: matches end now (finished rounds paid), then everyone who isn't staff is off; a hello is refused, 4006.
    await boss.admin('settings.set', { settings: { maintenance: true } });
    await until(() => !P().matches.has(m.id), 3000);
    const ended = (await rows('SELECT status, data FROM pvp_matches WHERE id = $1', [m.id]))[0];
    check('maintenance: the match ends, cut short (cancelled), and its sockets close', ended?.status === 'cancelled' && JSON.parse(JSON.stringify(ended.data)).endWhy === 'maintenance'
      && [...socks.values()].every((s) => s.closed || s.ws.readyState !== 1));
    const ms = await sock(ACC.p02, m.id);
    check('maintenance: a hello is refused, 4006', (await ms.waitClosed())?.code === 4006, JSON.stringify(ms.closed));
    await boss.admin('settings.set', { settings: { maintenance: false } });
    for (const n of NAMES) if (!server.srv.sockets.has(ACC[n].id)) await client(ACC[n]);
    for (const n of NAMES) P().dodges.delete(ACC[n].id);
  }

  // ---- 7. a whole match: the log, the pay, once ------------------------------------------------------------------------
  advance(25 * 3600e3); // (a day on: no earlier matches between anyone)
  let FULL = null;
  {
    const two = ps('p01', 'p02');
    const L2 = await lobby(two, 'competitive');
    const m = L2.m;
    const socks = await joinAll(two, L2.id);
    const host = await startMatch(m, socks, { p01: [20, 20, 20, 20, 20], p02: [40, 40, 40, 40, 40] });
    await goLive(m, host);
    const a = humanOf(m, 'p01'), b = humanOf(m, 'p02');
    // Give p02 a StatTrak gun to count on.
    const skin = Object.values(D.skins).find((s) => s.stt && s.cat === 'rifle');
    const gun = makeSkinItem(skin, { src: 'test', stt: true });
    await setState(ACC.p02.id, (s) => { s.inv.unshift(gun); });
    // (copies: st() is the live state)
    const m0 = { a: structuredClone(await st(ACC.p01.id)), b: structuredClone(await st(ACC.p02.id)) };
    const money0 = { a: m0.a.money, b: m0.b.money }, rank0 = { a: m0.a.rank.mmr, b: m0.b.rank.mmr };
    const prof0 = { a: m0.a.prof, b: m0.b.prof };
    // b's squad wins 13-5: b kills every round its squad wins; a in the rounds a's squad wins.
    const order = [...Array(5).fill(a.squad), ...Array(13).fill(b.squad)];
    for (const w of order) await playRound(m, host, w, { killer: w === a.squad ? a.slot : b.slot });
    check('18 rounds logged, 5-13, by the server\'s clock', m.rounds.length === 18 && m.score[a.squad] === 5 && m.score[b.squad] === 13 && m.logEnd != null && !m.voidWhy, `${JSON.stringify(m.score)} ${m.voidWhy}`);
    host.send({ t: 'end', score: { ...m.score } });
    for (const s of socks.values()) await s.waitText((t) => t.t === 'end');
    const endMsg = socks.get('p02').texts.find((t) => t.t === 'end');
    check('{ t: end } to everyone, over, asking for reports', endMsg?.why === 'over' && endMsg.report === true);
    socks.get('p01').send({ t: 'report', board: [], score: { ...m.score }, me: { k: 25, a: 0, d: 65, m: 5, stt: [] } });
    socks.get('p02').send({ t: 'report', board: [], score: { ...m.score }, me: { k: 65, a: 0, d: 25, m: 13, stt: [{ uid: gun.uid, k: 40 }, { uid: 'nope', k: 5 }] } });
    const paidB = await ACC.p02.c.waitFor((e) => e.t === 'pvp.paid', 5000), paidA = await ACC.p01.c.waitFor((e) => e.t === 'pvp.paid', 5000);
    const exB = L.matchPay({ result: 'win', kills: 65, assists: 0, mvps: 13 }), exA = L.matchPay({ result: 'loss', kills: 25, assists: 0, mvps: 5 });
    const xB = L.matchXp({ result: 'win', kills: 65, assists: 0, roundsWon: 13 }), xA = L.matchXp({ result: 'loss', kills: 25, assists: 0, roundsWon: 5 });
    const s1 = { a: await st(ACC.p01.id), b: await st(ACC.p02.id) };
    check('the winner: paid as a bot match (win, 65 kills, 13 MVPs), and told', paidB && paidB.result === 'win' && paidB.earned === exB.total && Math.abs(s1.b.money - money0.b - exB.total) < 0.01
      && paidB.score.you === 13 && paidB.score.them === 5 && paidB.mult === 1 && paidB.pay.kills === exB.kills && paidB.xp === xB.total, JSON.stringify(paidB));
    check('the loser: a loss, 25 kills, 5 MVPs', paidA && paidA.result === 'loss' && paidA.earned === exA.total && Math.abs(s1.a.money - money0.a - exA.total) < 0.01 && paidA.xp === xA.total, JSON.stringify(paidA));
    check('XP added to the profile', JSON.stringify(s1.b.prof) !== JSON.stringify(prof0.b));
    check('stats: matches, wins, kills, earned', s1.b.stats.playMatches === (m0.b.stats.playMatches || 0) + 1 && s1.b.stats.playWins === (m0.b.stats.playWins || 0) + 1 && s1.b.stats.playKills === (m0.b.stats.playKills || 0) + 65);
    check('rank: up for the winner, down for the loser, against the other team\'s rating', s1.b.rank.mmr > rank0.b && s1.a.rank.mmr < rank0.a && paidB.rank && paidA.rank, `${rank0.b}->${s1.b.rank.mmr} ${rank0.a}->${s1.a.rank.mmr}`);
    const g = s1.b.inv.find((i) => i.uid === gun.uid);
    check('StatTrak: the kills counted on the gun its game named (one not theirs left out)', g?.kills === 40, String(g?.kills));
    const rowsP = await rows('SELECT user_id, paid, earned, outcome FROM pvp_players WHERE match_id = $1 ORDER BY slot', [m.id]);
    check('pvp_players: each paid once, with what they earned', rowsP.length === 2 && rowsP.every((r) => r.paid != null) && rowsP.some((r) => r.outcome === 'win' && r.earned === exB.total));
    const row = (await rows('SELECT status, started, ended FROM pvp_matches WHERE id = $1', [m.id]))[0];
    check('the match: over', row.status === 'over' && row.started != null && row.ended != null);
    // Paying again (the same plan, a restart in the middle): nothing more.
    const before2 = (await st(ACC.p02.id)).money;
    await P().payUser({ id: m.id, score: m.score }, (await rows('SELECT data FROM pvp_matches WHERE id = $1', [m.id]))[0].data.plan.users.find((u) => u.userId === ACC.p02.id));
    check('paying a player again: refused by their row (paid once)', (await st(ACC.p02.id)).money === before2);
    check('closed: everyone\'s /match socket, 1000', (await socks.get('p01').waitClosed())?.code === 1000);
    FULL = m;
  }

  // ---- 8. the log's checks: the host's fault --------------------------------------------------------------------------
  // A round that can't follow the log (or an end before it) is the host's game breaking the match's rules: the match ends
  // there, the others paid for the finished rounds (no result, no rank), the host an abandon. (Void would have been a free
  // way out for a losing host.)
  advance(25 * 3600e3);
  async function faultCase(name, steps) {
    advance(25 * 3600e3); // (a day apart: repeat opponents would pay less)
    const two = ps('p03', 'p04');
    const L2 = await lobby(two, 'wingman');
    const m = L2.m, socks = await joinAll(two, L2.id);
    const host = await startMatch(m, socks, { p03: [20, 20, 20, 20, 20], p04: [40, 40, 40, 40, 40] });
    await goLive(m, host);
    await steps(m, host, socks);
    const ok = await until(() => m.fault && !P().matches.has(m.id), 3000);
    check(`the host's fault: ${name}`, !!ok && m.endWhy === 'host-fault' && !m.voidWhy, m.fault || m.voidWhy || '(nothing)');
    await closeAll(socks);
    await dispose('p03', 'p04');
    m.hostName = host.acc.name;
    return m;
  }
  await faultCase('a round under 15 s (Wingman)', async (m, host) => { await playRound(m, host, 'A', { gap: 10000 }); });
  await noCooldown('p03', 'p04');
  await faultCase('a score that skips a step', async (m, host) => { await playRound(m, host, 'A', { score: { A: 2, B: 0 } }); });
  await noCooldown('p03', 'p04');
  await faultCase('a round number out of order', async (m, host) => { await playRound(m, host, 'A', { n: 3 }); });
  await noCooldown('p03', 'p04');
  await faultCase('a dead player\'s headshot', async (m, host) => {
    await playRound(m, host, 'A', { kills: [[2, 0, 255, 7, 0], [0, 2, 255, 7, 0], [0, 3, 255, 7, 1]] });
  });
  await noCooldown('p03', 'p04');
  await faultCase('a victim killed twice', async (m, host) => { await playRound(m, host, 'A', { kills: [[0, 2, 255, 7, 0], [0, 2, 255, 7, 0], [0, 3, 255, 7, 0]] }); });
  await noCooldown('p03', 'p04');
  await faultCase('an MVP on the losing squad', async (m, host) => { await playRound(m, host, 'A', { mvp: 2 }); });
  await noCooldown('p03', 'p04');
  await faultCase('an elimination with someone left alive', async (m, host) => { await playRound(m, host, 'A', { kills: [[0, 2, 255, 7, 0]] }); });
  await noCooldown('p03', 'p04');
  const before8 = { p03: structuredClone(await st(ACC.p03.id)), p04: structuredClone(await st(ACC.p04.id)) };
  const fEnd = await faultCase('the host\'s end before the score\'s, losing 0-3', async (m, host) => {
    const hostSq = humanOf(m, host.acc.name).squad, other = V.otherSquad(hostSq), killer = V.slotsOf('wingman', other)[0];
    for (let i = 0; i < 3; i++) await playRound(m, host, other, { killer });
    host.send({ t: 'end', score: { ...m.score } });
  });
  {
    const other = fEnd.hostName === 'p03' ? 'p04' : 'p03';
    const after = { [fEnd.hostName]: await st(ACC[fEnd.hostName].id), [other]: await st(ACC[other].id) };
    const row = (await rows('SELECT status, data FROM pvp_matches WHERE id = $1', [fEnd.id]))[0];
    const paidO = await ACC[other].c.waitFor((e) => e.t === 'pvp.paid' && e.id === fEnd.id, 3000), overO = await ACC[other].c.waitFor((e) => e.t === 'pvp.over' && e.id === fEnd.id, 3000);
    const overH = await ACC[fEnd.hostName].c.waitFor((e) => e.t === 'pvp.over' && e.id === fEnd.id, 3000);
    const audits = await rows("SELECT count(*)::int AS n FROM audit WHERE action = 'pvp.fault' AND actor = 'Server'");
    check('the host\'s fault: cancelled, the host abandoned it (a cooldown, a rank loss) and is told why', row.status === 'cancelled' && row.data.endWhy === 'host-fault'
      && after[fEnd.hostName].mm.until > now && after[fEnd.hostName].wingman.mmr < before8[fEnd.hostName].wingman.mmr && /broke the match's rules/.test(overH?.msg || ''), JSON.stringify(overH));
    check('the other player: paid the finished rounds (3 rounds, 6 kills, 3 MVPs), no result pay, no rank change, no cooldown',
      paidO && paidO.result === null && paidO.pay.result === 0 && paidO.pay.kills === 600 && paidO.pay.mvps === 750 && paidO.rank === null && overO?.why === 'host-fault'
      && after[other].wingman.mmr === before8[other].wingman.mmr && !(after[other].mm?.until > now), JSON.stringify(paidO));
    check('an audit row for each, by the Server', audits[0].n >= 8, String(audits[0].n));
    await noCooldown('p03', 'p04');
    // The host's final score not the log's (after the log's end): the log's is paid, the host's noted for staff.
    advance(25 * 3600e3);
    const two = ps('p03', 'p04');
    const L2 = await lobby(two, 'wingman');
    const m = L2.m, socks = await joinAll(two, L2.id);
    const host = await startMatch(m, socks, { p03: [20, 20, 20, 20, 20], p04: [40, 40, 40, 40, 40] });
    await goLive(m, host);
    for (let i = 0; i < 9; i++) await playRound(m, host, 'A');
    host.send({ t: 'end', score: { A: 1, B: 9 } });
    for (const s of socks.values()) s.send({ t: 'report', board: [], score: { ...m.score }, me: { k: 0, a: 0, d: 0, m: 0, stt: [] } });
    const pw = await ACC[P().memberAt(m, 0).name].c.waitFor((e) => e.t === 'pvp.paid' && e.id === m.id, 4000);
    check('the host\'s end score not the log\'s: the log\'s result paid (over), an audit row', pw?.result === 'win' && (await rows('SELECT status FROM pvp_matches WHERE id = $1', [m.id]))[0].status === 'over'
      && (await rows("SELECT count(*)::int AS n FROM audit WHERE action = 'pvp.fault' AND detail->>'match' = $1", [m.id]))[0].n === 1, JSON.stringify(pw));
    await closeAll(socks);
    await dispose('p03', 'p04');
    // (A dead player's grenade still kills, as in CS2: not void.)
    const pass = await (async () => {
      const two = ps('p03', 'p04');
      const L2 = await lobby(two, 'wingman');
      const m = L2.m, socks = await joinAll(two, L2.id);
      const host = await startMatch(m, socks, { p03: [20, 20, 20, 20, 20], p04: [40, 40, 40, 40, 40] });
      await goLive(m, host);
      await playRound(m, host, 'A', { kills: [[2, 0, 255, 7, 0], [0, 2, 255, 44, 0], [0, 3, 255, 44, 0]] });
      const fine = !m.voidWhy && m.rounds.length === 1;
      await closeAll(socks);
      await dispose('p03', 'p04');
      return fine;
    })();
    check('a dead player\'s grenade kill (no headshot, no wallbang): not void', pass);
  }

  // ---- 9. half pay, the cross-check, repeat opponents, one network --------------------------------------------------
  advance(25 * 3600e3);
  async function wingmanMatch(names, { gap = 35000, reports = {}, winner = 'A', rtts = {} } = {}) {
    const players = ps(...names);
    const L2 = await lobby(players, 'wingman', { fill: names.length < 4 });
    const m = L2.m, socks = await joinAll(players, L2.id);
    const host = await startMatch(m, socks, rtts[names[0]] ? rtts : Object.fromEntries(names.map((n, i) => [n, Array(5).fill(20 + i * 10)])));
    await goLive(m, host);
    for (let i = 0; i < 9; i++) await playRound(m, host, winner, { gap });
    host.send({ t: 'end', score: { ...m.score } });
    for (const n of names) {
      const me = humanOf(m, n), r = reports[n];
      socks.get(n).send({ t: 'report', board: [], score: r?.score || { ...m.score }, me: r?.me || { k: me.squad === winner && me.slot === V.slotsOf('wingman', winner)[0] ? 18 : 0, a: 0, d: 0, m: me.squad === winner && me.slot === V.slotsOf('wingman', winner)[0] ? 9 : 0, stt: [] } });
    }
    const paid = {};
    for (const n of names) paid[n] = await ACC[n].c.waitFor((e) => e.t === 'pvp.paid' && e.id === m.id, 5000);
    await closeAll(socks);
    return { m, paid };
  }
  {
    // Rounds too quick on average (20 s, under Wingman's 27): half pay.
    const { m, paid } = await wingmanMatch(['p05', 'p06'], { gap: 20000 });
    const w = [...m.members.values()].find((x) => x.squad === 'A');
    const ex = L.matchPay({ result: 'win', kills: 18, mvps: 9 });
    const pw = paid[w.name];
    check('rounds 20 s apart on average: half pay, and why', pw && pw.mult === 0.5 && pw.earned === Math.round(ex.total * 50) / 100 && pw.notes.some((t) => /suspiciously fast/.test(t)), JSON.stringify(pw));
  }
  advance(25 * 3600e3);
  {
    // A report lower than the log: its numbers paid; more than a kill apart: disputed (an audit row).
    const before = (await rows("SELECT count(*)::int AS n FROM audit WHERE action = 'pvp.dispute'"))[0].n;
    const { m, paid } = await wingmanMatch(['p07', 'p08'], { reports: { p07: { me: { k: 10, a: 0, d: 0, m: 9 } }, p08: { me: { k: 10, a: 0, d: 0, m: 9 } } } });
    const w = [...m.members.values()].find((x) => x.squad === 'A' && x.slot === 0);
    const pw = paid[w.name];
    const after = (await rows("SELECT count(*)::int AS n FROM audit WHERE action = 'pvp.dispute'"))[0].n;
    check('the lower of the log and the player\'s own report is paid', pw && pw.pay.kills === 1000 && pw.pay.mvps === 9 * 250, JSON.stringify(pw?.pay));
    check('a report more than one kill off the log: disputed, an audit row', after > before, `${before} -> ${after}`);
  }
  advance(25 * 3600e3);
  {
    // Repeat opponents: seeded history of p09 against p10 (earlier matches today), then a match: 3 -> half, 5 -> a quarter,
    // 8 -> nothing (no XP, no rank change). Teammates don't count.
    const seed = async (n, opp = 'p10') => {
      for (let i = 0; i < n; i++) {
        const id = `seed-${opp}-${now}-${i}`;
        await server.db.query(`INSERT INTO pvp_matches (id, mode, map, app, status, members, data, created, started, ended, updated)
          VALUES ($1, 'wingman', 'de_dust2', $2, 'over', '[]'::jsonb, '{}'::jsonb, $3, $3, $3, $3)`, [id, APP, now - 3600e3]);
        await server.db.query('INSERT INTO pvp_players (match_id, user_id, slot, squad, at, paid) VALUES ($1, $2, 0, $3, $4, $4), ($1, $5, 2, $6, $4, $4)',
          [id, ACC.p09.id, 'A', now - 3600e3, ACC[opp].id, opp === 'p10' ? 'B' : 'A']);
      }
    };
    await seed(3);
    let r = await wingmanMatch(['p09', 'p10']);
    const half = Object.values(r.paid);
    check('3 earlier matches against the same opponent today: half pay', half.every((p) => p.mult === 0.5 && p.notes.some((t) => /Repeat opponents: half/.test(t))), JSON.stringify(half.map((p) => p.mult)));
    advance(60000);
    await seed(1); // (with the match just played: 5)
    r = await wingmanMatch(['p09', 'p10']);
    check('5: a quarter', Object.values(r.paid).every((p) => p.mult === 0.25), JSON.stringify(Object.values(r.paid).map((p) => p.mult)));
    advance(60000);
    await seed(2); // (8)
    const rank9 = (await st(ACC.p09.id)).wingman.mmr, prof9 = JSON.stringify((await st(ACC.p09.id)).prof), money9 = (await st(ACC.p09.id)).money;
    r = await wingmanMatch(['p09', 'p10']);
    const s9 = await st(ACC.p09.id);
    check('8: nothing, no XP and no rank change', Object.values(r.paid).every((p) => p.mult === 0 && p.earned === 0 && p.xp === 0 && p.rank === null)
      && s9.wingman.mmr === rank9 && JSON.stringify(s9.prof) === prof9 && s9.money === money9, JSON.stringify(Object.values(r.paid).map((p) => [p.mult, p.earned, p.xp])));
    advance(25 * 3600e3);
    await seed(9, 'p11'); // (p11 as p09's teammate: doesn't count)
    r = await wingmanMatch(['p09', 'p10']);
    check('teammates met again and again don\'t count; a day later, full pay again', Object.values(r.paid).every((p) => p.mult === 1));
  }
  advance(25 * 3600e3);
  {
    // One network: an opponent who shares an address (user_ips) gets no pay for kills, assists or MVPs; the result's stays.
    const hash = 'f'.repeat(32);
    await server.db.query('INSERT INTO user_ips (user_id, ip_hash, last) VALUES ($1, $3, $4), ($2, $3, $4) ON CONFLICT DO NOTHING', [ACC.p12.id, ACC.p13.id, hash, Date.now()]);
    const before = (await rows("SELECT count(*)::int AS n FROM audit WHERE action = 'pvp.network'"))[0].n;
    const { paid } = await wingmanMatch(['p12', 'p13']);
    const after = (await rows("SELECT count(*)::int AS n FROM audit WHERE action = 'pvp.network'"))[0].n;
    const ps2 = Object.values(paid);
    check('opponents on one network: no pay for kills, assists or MVPs (the result\'s stays), both of them', ps2.every((p) => p.pay.kills === 0 && p.pay.mvps === 0 && p.pay.assists === 0 && p.pay.result > 0 && p.notes.some((t) => /network/.test(t))),
      JSON.stringify(ps2.map((p) => p.pay)));
    check('and an audit row', after === before + 1);
    await server.db.query('DELETE FROM user_ips WHERE ip_hash = $1', [hash]);
  }

  // ---- 10. disconnects: a bot takes over, coming back, abandoning ---------------------------------------------------------
  advance(25 * 3600e3);
  {
    const four = ps('p01', 'p02', 'p03', 'p04');
    const L4 = await lobby(four, 'wingman', { fill: false });
    const m = L4.m, socks = await joinAll(four, L4.id);
    const host = await startMatch(m, socks, { p01: [10, 10, 10, 10, 10], p02: [40, 40, 40, 40, 40], p03: [50, 50, 50, 50, 50], p04: [60, 60, 60, 60, 60] });
    await goLive(m, host);
    const away = [...socks.keys()].find((n) => n !== host.acc.name && humanOf(m, n).squad === humanOf(m, host.acc.name).squad);
    const me = humanOf(m, away);
    await playRound(m, host, me.squad, { killer: me.slot });
    await socks.get(away).close();
    await until(() => me.state === 'dropped');
    const seen = await host.waitText((t) => t.t === 'member' && t.slot === me.slot && t.state === 'dropped');
    check('a player drops: dropped, to everyone', !!seen);
    advance(6000);
    await tick();
    check('5 s later: a bot plays for them', me.state === 'bot' && !!(await host.waitText((t) => t.t === 'member' && t.slot === me.slot && t.state === 'bot')));
    const st0 = await ACC[away].c.pvp('state');
    check('state: the match, away, with the time left to come back', st0.match?.id === m.id && st0.match.away && st0.match.away.left > 290000 && st0.match.away.left <= 300000, JSON.stringify(st0.match));
    // Rounds while a bot plays for them don't count for them.
    await playRound(m, host, me.squad, { killer: me.slot });
    advance(60000);
    const back = await sock(ACC[away], m.id);
    await back.waitText((t) => t.t === 'joined');
    socks.set(away, back);
    check('back within 5 minutes: in again (control at the next freeze time, the host says), and the host asked for a keyframe', me.state === 'in' && !me.abandoned
      && !!(await host.waitText((t) => t.t === 'key' && t.slot === me.slot)));
    await playRound(m, host, me.squad, { killer: me.slot });
    for (let i = 0; i < 6; i++) await playRound(m, host, me.squad, { killer: me.slot });
    host.send({ t: 'end', score: { ...m.score } });
    for (const n of socks.keys()) socks.get(n).send({ t: 'report', board: [], score: { ...m.score }, me: { k: n === away ? 18 : 0, a: 0, d: 0, m: n === away ? 9 : 0, stt: [] } });
    const pd = await ACC[away].c.waitFor((e) => e.t === 'pvp.paid' && e.id === m.id, 5000);
    check('their pay leaves out the round a bot played for them (8 of 9 rounds\' kills and MVPs)', pd && pd.pay.kills === 16 * 100 && pd.pay.mvps === 8 * 250 && pd.notes.some((t) => /bot played/.test(t)), JSON.stringify(pd?.pay));
    await closeAll(socks);
  }
  advance(25 * 3600e3);
  {
    // Not back within 5 minutes: abandoned, the cooldown and a rank loss, no pay; their bot match isn't touched.
    const four = ps('p05', 'p06', 'p07', 'p08');
    const L4 = await lobby(four, 'wingman', { fill: false });
    const m = L4.m, socks = await joinAll(four, L4.id);
    const host = await startMatch(m, socks, { p05: [10, 10, 10, 10, 10], p06: [40, 40, 40, 40, 40], p07: [50, 50, 50, 50, 50], p08: [60, 60, 60, 60, 60] });
    await goLive(m, host);
    const away = [...socks.keys()].find((n) => n !== host.acc.name), me = humanOf(m, away);
    const botMatch = { mode: 'competitive', opponent: 1000, at: now };
    await setState(ACC[away].id, (s) => { s.mm = { ...MM.freshMM(), match: botMatch }; });
    const r0 = (await st(ACC[away].id)).wingman.mmr;
    await socks.get(away).close();
    await until(() => me.state === 'dropped');
    advance(200000);
    await tick();
    check('away 200 s: still theirs to come back to', me.state === 'bot' && !me.abandoned);
    advance(101000);
    await tick();
    await until(() => me.abandoned, 2000);
    const s = await st(ACC[away].id);
    check('not back within 5 minutes: abandoned, a cooldown, a rank loss; the bot match they\'re in untouched', me.abandoned && s.mm.until > now && s.wingman.mmr < r0 && JSON.stringify(s.mm.match) === JSON.stringify(botMatch)
      && (await rows('SELECT outcome FROM pvp_players WHERE match_id = $1 AND user_id = $2', [m.id, ACC[away].id]))[0]?.outcome === 'abandon', JSON.stringify(s.mm));
    check('told: abandoned, the cooldown', !!(await ACC[away].c.waitFor((e) => e.t === 'pvp.over' && e.why === 'abandoned' && e.id === m.id)));
    check('everyone else: their slot abandoned', !!(await host.waitText((t) => t.t === 'member' && t.slot === me.slot && t.state === 'abandoned')));
    const re = await sock(ACC[away], m.id);
    check('an abandoned player can\'t come back: 4003', (await re.waitClosed())?.code === 4003);
    // An explicit abandon: at once.
    const other = [...socks.keys()].find((n) => n !== host.acc.name && n !== away);
    const r = await ACC[other].c.pvp('abandon', { id: m.id });
    check('abandon: at once, with its cooldown', r.cooldown >= 30 * 60000 && humanOf(m, other).abandoned);
    await closeAll(socks);
    await dispose(...four.map((a) => a.name));
    for (const a of four) await setState(a.id, (x) => { x.mm = MM.freshMM(); });
  }

  // ---- 11. the host lost ------------------------------------------------------------------------------------------------
  advance(25 * 3600e3);
  {
    const four = ps('p01', 'p02', 'p03', 'p04');
    let L4 = await lobby(four, 'wingman', { fill: false });
    let m = L4.m, socks = await joinAll(four, L4.id);
    let host = await startMatch(m, socks, { p01: [10, 10, 10, 10, 10], p02: [40, 40, 40, 40, 40], p03: [50, 50, 50, 50, 50], p04: [60, 60, 60, 60, 60] });
    await goLive(m, host);
    await playRound(m, host, 'A');
    await host.close();
    const pz = await socks.get('p02').waitText((t) => t.t === 'pause');
    check('the host drops: everyone paused, why host, until a minute from now', pz?.why === 'host' && pz.until === now + V.TIMES.HOST_GRACE && m.status === 'paused');
    advance(30000);
    await tick();
    const hb = await sock(ACC.p01, m.id);
    await hb.waitText((t) => t.t === 'joined');
    check('back within the minute: resumed', m.status === 'live' && !!(await socks.get('p02').waitText((t) => t.t === 'resume')));
    // The pause isn't round time: a round 10 s of play after the one before (with 30 s paused) is too quick.
    socks.set('p01', hb);
    host = hb;
    await closeAll(socks);
    await dispose('p01', 'p02', 'p03', 'p04');

    advance(25 * 3600e3);
    L4 = await lobby(four, 'wingman', { fill: false });
    m = L4.m;
    socks = await joinAll(four, L4.id);
    host = await startMatch(m, socks, { p01: [10, 10, 10, 10, 10], p02: [40, 40, 40, 40, 40], p03: [50, 50, 50, 50, 50], p04: [60, 60, 60, 60, 60] });
    await goLive(m, host);
    const hostSq = humanOf(m, 'p01').squad, killer = [...m.members.values()].find((x) => x.squad === hostSq && x.name !== 'p01');
    await playRound(m, host, hostSq, { killer: killer.slot });
    await playRound(m, host, hostSq, { killer: killer.slot });
    const before = { host: structuredClone(await st(ACC.p01.id)), k: structuredClone(await st(ACC[killer.name].id)) };
    await host.close();
    await socks.get('p02').waitText((t) => t.t === 'pause');
    advance(V.TIMES.HOST_GRACE + 1000);
    await tick();
    await until(() => !P().matches.has(m.id), 3000);
    const over = await ACC[killer.name].c.waitFor((e) => e.t === 'pvp.over' && e.id === m.id);
    const paid = await ACC[killer.name].c.waitFor((e) => e.t === 'pvp.paid' && e.id === m.id);
    const after = { host: await st(ACC.p01.id), k: await st(ACC[killer.name].id) };
    check('the host not back in a minute: over, host-left, the others told', over?.why === 'host-left' && /host left/.test(over.msg) && (await rows('SELECT status FROM pvp_matches WHERE id = $1', [m.id]))[0].status === 'cancelled');
    check('the others: paid for the finished rounds\' kills and MVPs, no result pay, no rank change, no cooldown',
      paid && paid.result === null && paid.pay.result === 0 && paid.pay.kills === 2 * 2 * 100 && paid.pay.mvps === 2 * 250 && paid.rank === null
      && after.k.wingman.mmr === before.k.wingman.mmr && !(after.k.mm?.until > now), JSON.stringify(paid));
    check('the host: an abandon (a cooldown, a rank loss)', after.host.mm.until > now && after.host.wingman.mmr < before.host.wingman.mmr
      && !!(await ACC.p01.c.waitFor((e) => e.t === 'pvp.over' && e.why === 'abandoned' && e.id === m.id)));
    await closeAll(socks);
    for (const a of four) await setState(a.id, (x) => { x.mm = MM.freshMM(); });
  }

  {
    // The host lost before the match went live: nothing was played, so it's off after the minute; the host waits a dodge,
    // everyone else searches again.
    const two = ps('p03', 'p04');
    const L2 = await lobby(two, 'wingman');
    const socks = await joinAll(two, L2.id);
    const host = await startMatch(L2.m, socks, { p03: [10, 10, 10, 10, 10], p04: [40, 40, 40, 40, 40] });
    const other = [...socks.values()].find((s) => s !== host);
    await host.close();
    const pz = await other.waitText((t) => t.t === 'pause' && t.why === 'host');
    advance(V.TIMES.HOST_GRACE + 1000);
    await tick();
    const c = await other.acc.c.waitFor((e) => e.t === 'pvp.cancel' && e.id === L2.id);
    check('the host lost before it went live: paused, then off; the host a dodge, the other back in the queue', !!pz && c?.requeued === true && P().dodgeLeft(host.acc.id) > 0
      && !(((await st(host.acc.id)).mm?.until || 0) > now), JSON.stringify(c));
    await closeAll(socks);
    await dispose('p03', 'p04');
  }

  // ---- 12. a restart ----------------------------------------------------------------------------------------------------
  advance(25 * 3600e3);
  {
    // A match still loading, and a live one.
    const lo = await lobby(ps('p09', 'p10'), 'wingman');
    const four = ps('p05', 'p06', 'p07', 'p08');
    const L4 = await lobby(four, 'wingman', { fill: false });
    const m = L4.m, socks = await joinAll(four, L4.id);
    const host = await startMatch(m, socks, { p05: [10, 10, 10, 10, 10], p06: [40, 40, 40, 40, 40], p07: [50, 50, 50, 50, 50], p08: [60, 60, 60, 60, 60] });
    await goLive(m, host);
    await playRound(m, host, 'A');
    const id = m.id, hostName = host.acc.name;
    await server.close();
    const codes = [...socks.values()].map((s) => s.closed?.code);
    const row = (await (async () => { server = await startServer(OPTS); return rows('SELECT status, data FROM pvp_matches WHERE id = $1', [id]); })())[0];
    check('a restart: every /match socket closed with 1012', codes.every((c) => c === 1012), codes.join());
    check('and told first: { t: pause, why: restart } (the host stops its clock then, not when its link notices)', [...socks.values()].every((s) => s.texts.some((t) => t.t === 'pause' && t.why === 'restart')));
    const m2 = P().matches.get(id);
    check('after it: the live match paused (restart), the loading one cancelled', m2?.status === 'paused' && m2.paused.why === 'restart' && row.data.pauses.at(-1)?.why === 'restart'
      && (await rows('SELECT status FROM pvp_matches WHERE id = $1', [lo.id]))[0].status === 'cancelled', `${m2?.status} ${JSON.stringify(m2?.paused)}`);
    for (const a of [...four, ACC.p09, ACC.p10]) await client(a);
    advance(50000);
    const ns = new Map();
    const lateOne = four.find((a) => a.name !== hostName);
    for (const a of four.filter((x) => x !== lateOne)) { const s = await sock(a, id); await s.waitText((t) => t.t === 'joined'); ns.set(a.name, s); }
    await tick();
    check('the host and two of three back: still paused', m2.status === 'paused');
    advance(V.TIMES.RESUME_AFTER_HOST + 1000);
    await tick();
    const lm = humanOf(m2, lateOne.name);
    check('30 s after the host was back: resumed; the one still away dropped from now (its window starts again)', m2.status === 'live' && !!(await ns.get(hostName).waitText((t) => t.t === 'resume'))
      && lm.state === 'dropped' && lm.drops.at(-1)?.at === now, `${m2.status} ${lm.state}`);
    const s4 = await sock(lateOne, id);
    await s4.waitText((t) => t.t === 'joined');
    ns.set(lateOne.name, s4);
    check('and back in', lm.state === 'in');
    // 50 s passed during the restart: the round gap leaves it out, so a round 10 s of play later is too quick (the host's own
    // count of its ticks, when it sends one, stands in for a round a restart paused, never more than the time gone by).
    advance(10000);
    ns.get(hostName).send({ ...roundMsg(m2, 'A'), ticks: 12 * 64 });
    await until(() => m2.fault, 2000);
    check('time paused for a restart isn\'t round time: a round 10 s of play after the last is too quick, whatever its ticks say', /after the last/.test(m2.fault || ''), m2.fault);
    await closeAll(ns);
    await dispose('p05', 'p06', 'p07', 'p08');
    await noCooldown('p05', 'p06', 'p07', 'p08');
  }
  {
    // A finished match not paid to everyone (the server stopped in the middle): paid on the next start, once.
    const m = FULL;
    const plan = (await rows('SELECT data FROM pvp_matches WHERE id = $1', [m.id]))[0].data.plan;
    const winner = plan.users.find((u) => u.outcome === 'win');
    await server.db.query('UPDATE pvp_players SET paid = NULL WHERE match_id = $1 AND user_id = $2', [m.id, winner.userId]);
    const before = (await st(winner.userId)).money;
    await server.store.flush();
    await server.close();
    server = await startServer(OPTS);
    const after = (await st(winner.userId)).money;
    const prow = (await rows('SELECT paid, earned FROM pvp_players WHERE match_id = $1 AND user_id = $2', [m.id, winner.userId]))[0];
    check('a finished match\'s unpaid row: paid on the next start, from the plan kept with it', prow.paid != null && after > before && Math.abs(after - before - prow.earned) < 0.01,
      `${before} -> ${after} (${prow.earned})`);
    await server.close();
    server = await startServer(OPTS);
    check('and only once', (await st(winner.userId)).money === after);
    for (const a of Object.values(ACC)) await client(a);
  }

  // ---- 13. staff -----------------------------------------------------------------------------------------------------
  advance(25 * 3600e3);
  {
    const boss = ACC.boss.c;
    const two = ps('p01', 'p02');
    const L2 = await lobby(two, 'wingman');
    const m = L2.m, socks = await joinAll(two, L2.id);
    const host = await startMatch(m, socks, { p01: [20, 20, 20, 20, 20], p02: [40, 40, 40, 40, 40] });
    await goLive(m, host);
    await playRound(m, host, 'A');
    const live = await boss.admin('pvp.live');
    const lm = live.matches.find((x) => x.id === m.id);
    check('admin pvp.live: the match, its score and players', lm && lm.mode === 'wingman' && lm.score.A === 1 && lm.members.length === 2 && lm.members.every((x) => x.name && x.connected), JSON.stringify(lm));
    const e1 = await refused(ACC.p03.c.admin('pvp.live'));
    check('a player: refused', e1?.code === 'perm');
    // Turning the switch off: no searching, the match goes on.
    await boss.admin('settings.set', { settings: { pvp: false } });
    check('the switch off: the match being played goes on', P().matches.has(m.id) && m.status === 'live');
    await boss.admin('settings.set', { settings: { pvp: true } });
    const r = await boss.admin('pvp.end', { id: m.id, pay: true });
    const paid = await ACC[P().memberAt(m, 0)?.name || 'p01'].c.waitFor((e) => e.t === 'pvp.paid' && e.id === m.id, 3000);
    const audit = await rows("SELECT actor, detail FROM audit WHERE action = 'pvp.end' ORDER BY id DESC LIMIT 1");
    check('admin pvp.end with pay: cut short, the finished rounds paid, an audit row', r.pay === true && (await rows('SELECT status FROM pvp_matches WHERE id = $1', [m.id]))[0].status === 'cancelled'
      && audit[0]?.actor === 'boss' && audit[0].detail.match === m.id && (paid ? paid.pay.result === 0 : true));
    const gone = await refused(boss.admin('pvp.end', { id: m.id, pay: false }));
    check('ending it again: refused', gone?.code === 'missing');
    await closeAll(socks);
    advance(25 * 3600e3);
    const L3 = await lobby(two, 'wingman');
    const s3 = await joinAll(two, L3.id);
    const h3 = await startMatch(L3.m, s3, { p01: [20, 20, 20, 20, 20], p02: [40, 40, 40, 40, 40] });
    await goLive(L3.m, h3);
    await playRound(L3.m, h3, 'A');
    await boss.admin('pvp.end', { id: L3.id, pay: false });
    const ov = await ACC.p01.c.waitFor((e) => e.t === 'pvp.over' && e.id === L3.id, 3000);
    check('admin pvp.end without pay: void, nobody paid', ov?.why === 'staff' && /no reward/.test(ov.msg) && (await rows('SELECT status FROM pvp_matches WHERE id = $1', [L3.id]))[0].status === 'void'
      && (await rows('SELECT count(*)::int AS n FROM pvp_players WHERE match_id = $1 AND earned > 0', [L3.id]))[0].n === 0);
    await closeAll(s3);
    const pv = await boss.admin('player', { id: ACC.p01.id });
    check('admin player: their online matches (the last day, the latest)', pv.pvp && pv.pvp.last24h >= 1 && pv.pvp.lastMatch?.id === L3.id && pv.pvp.lastMatch.status === 'void', JSON.stringify(pv.pvp));
  }

  // ---- 15. what the review found ------------------------------------------------------------------------------------
  advance(25 * 3600e3);
  {
    // Rounds are acknowledged, and an exact resend (a host back after its link dropped) changes nothing.
    const two = ps('p01', 'p02');
    const L2 = await lobby(two, 'wingman');
    const m = L2.m, socks = await joinAll(two, L2.id);
    const host = await startMatch(m, socks, { p01: [20, 20, 20, 20, 20], p02: [40, 40, 40, 40, 40] });
    const other = [...socks.values()].find((s) => s !== host);
    await goLive(m, host);
    host.texts.length = 0;
    advance(35000);
    const r1 = roundMsg(m, 'A');
    host.send(r1);
    const ok1 = await host.waitText((t) => t.t === 'round.ok' && t.n === 1);
    host.send(r1);
    await until(() => host.texts.filter((t) => t.t === 'round.ok').length >= 2, 2000);
    check('a logged round: acknowledged; sent again, acknowledged again and logged once', !!ok1 && m.rounds.length === 1 && !m.fault
      && host.texts.filter((t) => t.t === 'round.ok' && t.n === 1).length === 2);
    // A crash 12 s into round 2 (the pause runs from the row's last write, round 1's), back 40 s later, the round over 8 s
    // after that: its 20 s of play are the host's ticks, not the 8 s the server saw.
    const t0 = m.rounds[0].at;
    advance(52000);
    m.pauses.push({ from: t0, to: now, why: 'restart' }); // (as restore() has a crash)
    advance(8000);
    host.send({ ...roundMsg(m, 'A'), ticks: 20 * 64 });
    await until(() => m.rounds.length === 2 || m.fault, 2000);
    check('a round a crash paused: the host\'s ticks count for its time (20 s), never more than went by', m.rounds.length === 2 && !m.fault && m.rounds[1].gap === 20000, `${m.fault} ${m.rounds[1]?.gap}`);
    // A game saying ready over and over: the host is asked for a keyframe once every 2 s at most, and credited for it.
    host.texts.length = 0;
    for (let i = 0; i < 10; i++) other.send({ t: 'ready' });
    await wait(400);
    const keys = host.texts.filter((t) => t.t === 'key').length, hs = server.srv.relay.socketOf(m.id, m.host);
    check('ready ten times: one keyframe asked of the host, its frames for it not held against it', keys === 1 && hs.hostBin.extra >= 2, String(keys));
    // Pongs on /match: only answers to the server's own pings (random nonces, each once) are round trips. (The relay's own
    // timer held meanwhile: one ping, by hand.)
    const relayT = server.srv.relay;
    clearInterval(relayT.timer);
    const mem = humanOf(m, other.acc.name), n0 = mem.mrtt.length;
    for (let i = 0; i < 6; i++) other.ws.pong(Buffer.from([0x71, i, 0, 0, 0]));
    await wait(200);
    const forged = mem.mrtt.length === n0;
    relayT.beat();
    await until(() => mem.mrtt.length > n0, 2000);
    await wait(100);
    relayT.timer = setInterval(() => relayT.beat(), V.RELAY.PING_MS);
    relayT.timer.unref?.();
    check('/match: pongs for pings never sent are no round trips; the server\'s own are', forged && mem.mrtt.length === n0 + 1, `${n0} ${mem.mrtt.length}`);
    // Queue pings too: a pong with a nonce the server didn't send is nothing.
    await ACC.p03.c.pvp('queue', { mode: 'competitive', maps: MAPS });
    const qe = P().queue.get(ACC.p03.id);
    ACC.p03.c.ws.pong(Buffer.from([0x70, 1, 2, 3, 4, 0, 0, 0, 0]));
    await wait(150);
    const qForged = qe.rtt.length === 0;
    P().lastPing = 0;
    await tick();
    await until(() => qe.rtt.length > 0, 2000);
    check('the queue: a made-up pong is no round trip; an answer to the server\'s ping is', qForged && qe.rtt.length === 1, qe.rtt.join());
    await ACC.p03.c.pvp('leave');
    // Pings: none before the hello, and few after.
    const pre = await sock(ACC.p03, m.id, { hello: false });
    pre.ws.ping();
    check('/match: a ping before the hello: closed, 4002', (await pre.waitClosed())?.code === 4002, JSON.stringify(pre.closed));
    const pres = [];
    for (let i = 0; i < 11; i++) pres.push(await sock(ACC.p05, m.id, { hello: false }));
    await until(() => pres[10].closed, 1000);
    check('/match: an address\'s 11th socket waiting on its hello: closed at once', pres[10].closed?.code === 4002 && /Too many/.test(pres[10].closed.reason), JSON.stringify(pres[10].closed));
    for (const s of pres) await s.close();
    let pongs = 0;
    other.ws.on('pong', () => { pongs++; });
    const tf = Date.now();
    while (Date.now() - tf < 2500 && other.ws.readyState === 1) { for (let i = 0; i < 20; i++) other.ws.ping(); await wait(20); }
    check('/match: a ping flood: a few answered, then closed (1008)', (await other.waitClosed(2000))?.code === 1008 && pongs <= 40, String(pongs));
    await closeAll(socks);
    await dispose('p01', 'p02');
  }
  advance(25 * 3600e3);
  {
    // Contested: the other player's own game saw the opposite result. Nobody's paid the result or ranked by it, both told,
    // staff told, and it counts against the host's hosting.
    const two = ps('p03', 'p04');
    const L2 = await lobby(two, 'wingman');
    const m = L2.m, socks = await joinAll(two, L2.id);
    const host = await startMatch(m, socks, { p03: [20, 20, 20, 20, 20], p04: [40, 40, 40, 40, 40] });
    await goLive(m, host);
    const other = [...socks.values()].find((s) => s !== host), hostSq = humanOf(m, host.acc.name).squad, oSq = V.otherSquad(hostSq);
    const r0 = { h: (await st(host.acc.id)).wingman.mmr, o: (await st(other.acc.id)).wingman.mmr };
    for (let i = 0; i < 9; i++) await playRound(m, host, hostSq);
    host.send({ t: 'end', score: { ...m.score } });
    const endMsg = await other.waitText((t) => t.t === 'end');
    host.send({ t: 'report', board: [], score: { ...m.score }, me: { k: 18, a: 0, d: 0, m: 9, stt: [] } });
    other.send({ t: 'report', board: [], score: { [oSq]: 9, [hostSq]: 0 }, w: oSq.repeat(9), me: { k: 18, a: 0, d: 0, m: 9, stt: [] } });
    const ph = await host.acc.c.waitFor((e) => e.t === 'pvp.paid' && e.id === m.id, 4000), po = await other.acc.c.waitFor((e) => e.t === 'pvp.paid' && e.id === m.id, 4000);
    check('{ t: end } carries the log\'s score', endMsg?.score?.[hostSq] === 9 && endMsg.score[oSq] === 0, JSON.stringify(endMsg));
    check('contested: nobody paid the result or ranked, both told why, an audit row, and it counts against the host\'s hosting',
      ph?.result === null && ph.pay.result === 0 && po?.result === null && po.pay.result === 0 && ph.rank === null && po.rank === null && ph.pay.kills === 1800
      && (await st(host.acc.id)).wingman.mmr === r0.h && (await st(other.acc.id)).wingman.mmr === r0.o && ph.notes.some((t) => /didn't agree/.test(t))
      && (await rows("SELECT count(*)::int AS n FROM audit WHERE action = 'pvp.contested' AND detail->>'match' = $1", [m.id]))[0].n === 1
      && (await P().hostLeftOf([host.acc.id], now)).get(host.acc.id) >= 1, JSON.stringify([ph?.pay, po?.pay]));
    await closeAll(socks);
    await dispose('p03', 'p04');
  }
  advance(25 * 3600e3);
  {
    // A player connected the whole match but never ready: a bot played every round for them. No result pay, no rank change
    // (their teammate, who played, wins as usual).
    const four = ps('p05', 'p06', 'p07', 'p08');
    const L4 = await lobby(four, 'wingman', { fill: false });
    const m = L4.m, socks = await joinAll(four, L4.id);
    for (const x of m.members.values()) x.mrtt = Array(5).fill(20);
    const afk = humanOf(m, 'p06'), mate = [...m.members.values()].find((x) => x.squad === afk.squad && x !== afk);
    socks.get('p06').send({ t: 'load', p: 40, stage: 'Preparing the map…' });
    const staged = await socks.get('p05').waitText((t) => t.t === 'member' && t.slot === afk.slot && t.stage);
    check('a member\'s load progress carries its stage', staged?.stage === 'Preparing the map…' && staged.load === 40, JSON.stringify(staged));
    for (const n of ['p05', 'p07', 'p08']) socks.get(n).send({ t: 'ready' });
    await until(() => ['p05', 'p07', 'p08'].every((n) => humanOf(m, n).ready));
    advance(V.TIMES.LOAD + 1000);
    await tick();
    await until(() => m.host != null);
    const host = [...socks.values()].find((s) => s.acc.id === P().memberAt(m, m.host).userId);
    await goLive(m, host);
    for (let i = 0; i < 9; i++) await playRound(m, host, afk.squad, { killer: mate.slot });
    host.send({ t: 'end', score: { ...m.score } });
    for (const s of socks.values()) s.send({ t: 'report', board: [], score: { ...m.score }, me: { k: s.acc.id === mate.userId ? 18 : 0, a: 0, d: 0, m: s.acc.id === mate.userId ? 9 : 0, stt: [] } });
    const pa = await ACC.p06.c.waitFor((e) => e.t === 'pvp.paid' && e.id === m.id, 4000), pm = await ACC[mate.name].c.waitFor((e) => e.t === 'pvp.paid' && e.id === m.id, 4000);
    check('never ready, a bot playing every round: no result pay, no rank change, and why; their teammate wins as usual',
      pa?.result === null && pa.pay.result === 0 && pa.rank === null && pa.notes.some((t) => /most of your rounds/.test(t)) && pm?.result === 'win' && !!pm.rank, JSON.stringify([pa, pm?.result]));
    await closeAll(socks);
    await dispose('p05', 'p06', 'p07', 'p08');
  }
  advance(25 * 3600e3);
  {
    // A host that never goes live: off a minute after the start, the host a dodge, the other back in the queue.
    const two = ps('p07', 'p08');
    const L2 = await lobby(two, 'wingman');
    const m = L2.m, socks = await joinAll(two, L2.id);
    const host = await startMatch(m, socks, { p07: [20, 20, 20, 20, 20], p08: [40, 40, 40, 40, 40] });
    const other = [...socks.values()].find((s) => s !== host);
    advance(V.TIMES.LIVE_BY - 5000);
    await tick();
    const still = P().matches.has(m.id);
    advance(10000);
    await tick();
    const c = await other.acc.c.waitFor((e) => e.t === 'pvp.cancel' && e.id === m.id);
    check('a host that never goes live: off after a minute, the host a dodge, the other back in the queue', still && c?.requeued === true && P().dodgeLeft(host.acc.id) > 0 && !P().matches.has(m.id), JSON.stringify(c));
    await closeAll(socks);
    await dispose('p07', 'p08');
    // A live match whose host logs no round for 5 minutes: the host's fault.
    advance(25 * 3600e3);
    const L3 = await lobby(two, 'wingman');
    const m3 = L3.m, s3 = await joinAll(two, L3.id);
    const h3 = await startMatch(m3, s3, { p07: [20, 20, 20, 20, 20], p08: [40, 40, 40, 40, 40] });
    await goLive(m3, h3);
    await playRound(m3, h3, 'A');
    P().T.ROUND_MAX = V.TIMES.ROUND_MAX;
    advance(V.TIMES.ROUND_MAX - 5000);
    await tick();
    const live3 = P().matches.has(m3.id);
    advance(10000);
    await tick();
    await until(() => !P().matches.has(m3.id), 3000);
    P().T.ROUND_MAX = OPTS.pvp.times.ROUND_MAX;
    check('no round logged for 5 minutes: over, the host\'s fault', live3 && m3.endWhy === 'host-fault' && /No round ended/.test(m3.fault || ''), m3.fault);
    await closeAll(s3);
    await dispose('p07', 'p08');
    await noCooldown('p07', 'p08');
  }
  advance(25 * 3600e3);
  {
    // The last accept and a search sent together: the search is refused, never a second match.
    const two = ps('p09', 'p10');
    const t = await lobby(two, 'wingman', { accept: false });
    await ACC.p09.c.pvp('accept', { id: t.id });
    const [, q] = await Promise.all([ACC.p10.c.pvp('accept', { id: t.id }), refused(ACC.p10.c.pvp('queue', { mode: 'wingman', maps: MAPS }))]);
    await until(() => P().matchOf.has(ACC.p10.id));
    check('the last accept and a search together: the search refused (busy), one match', q?.code === 'busy' && !P().queue.has(ACC.p10.id) && P().matchOf.has(ACC.p10.id), q?.message);
    const ps1 = await refused(ACC.p10.c.rpc('act', 'play.start', { mode: 'competitive' }));
    check('in an online match: no match against bots starts (play.start refused, busy)', ps1?.code === 'busy', ps1?.message);
    await dispose('p09', 'p10');
    // A bot match open (play.start) when the search starts: it can't be paid for any more.
    const run = (await ACC.p09.c.rpc('act', 'play.start', { mode: 'competitive' })).run;
    await ACC.p09.c.pvp('queue', { mode: 'wingman', maps: MAPS });
    const pr = await refused(ACC.p09.c.rpc('act', 'play.reward', { run, result: 'win', kills: 0, rounds: 0 }));
    await ACC.p09.c.pvp('leave');
    const pr2 = await refused(ACC.p09.c.rpc('act', 'play.reward', { run, result: 'win', kills: 0, rounds: 0 }));
    check('searching: an open bot match is cleared, its reward refused while searching (busy) and after (match)', (await st(ACC.p09.id)).play == null && ACC.p09.c.st.play == null
      && pr?.code === 'busy' && pr2?.code === 'match', `${pr?.code} ${pr2?.code}`);
    // A kick while a match waits for accepts: a dodge, like any match not accepted.
    const t2 = await lobby(ps('p11', 'p12'), 'wingman', { accept: false });
    server.srv.kick(ACC.p12.id, { code: 'kicked', error: 'test' });
    const kc = await ACC.p11.c.waitFor((e) => e.t === 'pvp.cancel' && e.id === t2.id);
    check('kicked while a match waits for accepts: a dodge for them, the other back in the queue', kc?.requeued === true && P().dodgeLeft(ACC.p12.id) > 0);
    // Dodges are kept with the account: a restart's fresh memory reads them back.
    const left = P().dodgeLeft(ACC.p12.id);
    P().dodges.clear();
    await P().loadDodges();
    check('dodges kept (pvp_dodges): read back as they were', P().dodgeLeft(ACC.p12.id) === left && left > 0, `${left}`);
    await ACC.p11.c.pvp('leave');
    await client(ACC.p12);
    await P().clearDodge(ACC.p12.id);
    // A third map that "failed to load" within the hour: an abandon, not a dodge.
    P().dodge(ACC.p11.id, { fail: true }); P().dodge(ACC.p11.id, { fail: true });
    P().dodges.get(ACC.p11.id).until = 0;
    const L3 = await lobby(ps('p11', 'p12'), 'wingman');
    const s3 = await joinAll(ps('p11', 'p12'), L3.id);
    s3.get('p11').send({ t: 'load', p: 20, failed: 'nope' });
    const ab = await ACC.p11.c.waitFor((e) => e.t === 'pvp.over' && e.id === L3.id);
    check('a third map that "failed to load" in an hour: an abandon (a cooldown), and told', /failed to load again/.test(ab?.msg || '') && (await st(ACC.p11.id)).mm.until > now, JSON.stringify(ab));
    await closeAll(s3);
    await dispose('p11', 'p12');
    await noCooldown('p11', 'p12');
    // Online, matches are only made on the released version.
    const rel = server.srv.release, was = { on: rel.on, required: rel.required };
    Object.assign(rel, { on: true, required: '9.9.9' });
    const ov = await refused(ACC.p11.c.pvp('queue', { mode: 'wingman', maps: MAPS }));
    rel.required = APP;
    await ACC.p11.c.pvp('queue', { mode: 'wingman', maps: MAPS });
    const okq = P().queue.has(ACC.p11.id);
    Object.assign(rel, was);
    await ACC.p11.c.pvp('leave');
    check('a version other than the released one: refused (outdated); the released one searches', ov?.code === 'outdated' && /released version/.test(ov.message) && okq, ov?.message);
  }

  // ---- 14. old games saw none of it ------------------------------------------------------------------------------------
  {
    const old = ACC.oldie.watch;
    check('a 1.1.7 game was sent no pvp push, whatever happened', old ? !old.events.some((e) => /^pvp\./.test(e.t)) : true);
  }
} catch (e) {
  failed++;
  console.log('FAIL  (threw)', e);
} finally {
  await server.close().catch(() => {});
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* still open */ }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
async function boss_settings(s) { return ACC.boss.c.admin('settings.set', { settings: s }); }
