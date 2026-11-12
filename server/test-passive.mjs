// Passive income online (server/passive.mjs): a real server (embedded Postgres on disk) and real WebSocket clients. The
// server pays it by its own clock, which these checks move on (`skew`): on connecting for the time away, and about every
// minute while connected, once per account however many windows; never twice across a restart or two server instances;
// $100 more a minute for each prestige the account has when it's paid.
//   node server/test-passive.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

for (const k of ['HOST', 'SERVER_COMMIT', 'RENDER_GIT_COMMIT', 'ADMIN_USERS', 'TRUST_PROXY']) delete process.env[k];
const { startServer } = await import('./index.mjs');
const { Store } = await import('./store.mjs');
const { collect } = await import('./passive.mjs');
const { D } = await import('../src/js/engine/data.js');
const { PASSIVE } = await import('../src/js/engine/levels.js');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cs2sim-test-passive-'));
let failed = 0, passed = 0;
const check = (name, ok, info = '') => { ok ? passed++ : failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = () => {};
const MIN = 60e3, HOUR = 3600e3;

// The server's clock: real time plus `skew`. The clients' clocks are never asked.
let skew = 0;
const clock = () => Date.now() + skew;
const opts = { port: 0, db: { dataDir: DIR }, log: quiet, priceRefresh: false, discord: false, admins: ['Boss'], clock, passiveTick: 50 };
let server = await startServer(opts);
const base = () => `http://localhost:${server.port}`;

async function post(p, body) {
  const r = await fetch(base() + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
// A game client: WebSocket + rpc + a mirror of the state built from welcome + deltas. `hello`: more for its hello to say.
async function client(token, hello = {}) {
  const ws = new WebSocket(base().replace('http', 'ws') + '/ws');
  const c = { ws, st: null, events: [], pending: new Map(), seq: 0 };
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const welcome = new Promise((res, rej) => {
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.t === 'welcome') { c.st = m.state; c.user = m.user; res(m); return; }
      if (m.t === 'fatal') { rej(new Error(m.error)); return; }
      if (!c.st) { c.early = (c.early || 0) + 1; return; } // (nothing should come before the welcome)
      if (m.t === 'res') { const p = c.pending.get(m.id); c.pending.delete(m.id); if (m.d) for (const [k, v] of Object.entries(m.d.set || {})) c.st[k] = v; m.ok ? p.res(m.r) : p.rej(Object.assign(new Error(m.err), { code: m.code })); return; }
      if (m.t === 'delta') for (const [k, v] of Object.entries(m.d.set || {})) c.st[k] = v;
      c.events.push(m);
    });
  });
  ws.send(JSON.stringify({ t: 'hello', token, data: D.lock, v: 1, ...hello }));
  c.welcome = await welcome;
  c.rpc = (ns, m, args) => new Promise((res, rej) => { const id = ++c.seq; c.pending.set(id, { res, rej }); ws.send(JSON.stringify({ t: 'rpc', id, ns, m, args })); });
  c.act = (m, a) => c.rpc('act', m, a);
  c.admin = (m, a) => c.rpc('admin', m, a);
  c.close = () => ws.close();
  return c;
}
const serverState = async (id) => (await server.store.load(id)).st;
const savedState = async (id) => { const { rows } = await server.db.query('SELECT state FROM users WHERE id = $1', [id]); return typeof rows[0].state === 'string' ? JSON.parse(rows[0].state) : rows[0].state; };
// Passive income's pushes a client has had.
const pushes = (c) => c.events.filter((m) => m.t === 'delta' && m.d?.set && 'passive' in m.d.set);
const until = async (pred, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return true; await wait(20); } return false; };
// Closes a player's windows and waits for the server to see them gone (else its timer would still pay them).
const leave = async (id, ...cs) => { for (const c of cs) c.close(); await until(() => !server.srv.sockets.has(id)); };
// The server's clock to `ms` after the time an account's passive income was counted up to.
const clockTo = async (id, ms) => { skew += (await serverState(id)).passive.at + ms - clock(); };

try {
  check('passive income is $100 a minute and $100 more for each prestige, 12 hours at most', PASSIVE.perMinute === 100 && PASSIVE.perPrestige === 100 && PASSIVE.capHours === 12);

  // ---- a new account, and the time away on connecting (capped) ------------------------------------------------------------
  const t0 = clock();
  const ra = await post('/api/register', { name: 'alice', password: 'secret123' });
  const t1 = clock(), token = ra.body.token;
  let A = await client(token);
  const id = A.user.id;
  check('a new account counts from when it was made, on the server\'s clock', A.st.passive.at >= t0 && A.st.passive.at <= t1 && A.st.passive.earned === 0 && A.st.money === 10 && !A.welcome.away);

  const at0 = A.st.passive.at;
  await leave(id, A);
  skew += 13 * HOUR;
  A = await client(token);
  check('connecting after 13 hours away pays 12 hours ($72,000), and the welcome says what it paid', A.welcome.away?.earned === 72000 && A.welcome.away.minutes === 720
    && A.welcome.away.capped === true && A.st.money === 72010 && (await serverState(id)).money === 72010, JSON.stringify(A.welcome.away));
  check('and counts all of the time away: the 13th hour never pays', A.st.passive.at > clock() - MIN && A.st.passive.at <= clock() && (A.st.passive.at - at0) % MIN === 0 && A.st.passive.earned === 72000);
  check('nothing comes before the welcome', !A.early);

  await leave(id, A);
  A = await client(token);
  check('connecting again straight away pays nothing more', !A.welcome.away && A.st.money === 72010);

  // ---- time away under the cap, and the part of a minute left over --------------------------------------------------------
  await leave(id, A);
  await clockTo(id, 90 * MIN + 30e3);
  A = await client(token);
  check('90 and a half minutes away pays 90 minutes on connecting', A.welcome.away?.earned === 9000 && A.welcome.away.minutes === 90 && !A.welcome.away.capped && A.st.money === 81010);
  const n0 = pushes(A).length;
  skew += 30e3;
  check('and the half minute left over makes the timer pay one more half a minute later', await until(() => pushes(A).length > n0) && A.st.money === 81110 && (await serverState(id)).money === 81110);

  // ---- two windows: one account, paid once ---------------------------------------------------------------------------
  const A2 = await client(token);
  check('a second window connecting pays nothing it hasn\'t earned', !A2.welcome.away && A2.st.money === 81110);
  const m0 = (await serverState(id)).money, n1 = pushes(A).length, n2 = pushes(A2).length;
  skew += MIN;
  await until(() => pushes(A).length > n1 && pushes(A2).length > n2);
  await wait(300); // (time for a second payment, were there one)
  check('two windows: the minute\'s timer pays the account once, and each window hears it once', (await serverState(id)).money === m0 + 100
    && pushes(A).length === n1 + 1 && pushes(A2).length === n2 + 1 && A.st.money === m0 + 100 && A2.st.money === m0 + 100);
  const push = pushes(A).at(-1);
  check('the minute\'s push is small: just the money and the clock', Object.keys(push.d.set).sort().join() === 'money,passive' && !push.d.add && !push.d.upd && JSON.stringify(push).length < 160, JSON.stringify(push));

  // ---- the time is the server's ------------------------------------------------------------------------------------------
  const m1 = (await serverState(id)).money;
  let asked = null; try { await A.act('passive.collect', { now: clock() + 99 * HOUR, minutes: 720 }); } catch (e) { asked = e; }
  check('a client can\'t ask for it, whatever time it says', asked?.code === 'server' && (await serverState(id)).money === m1);
  await leave(id, A, A2);
  const later = clock() + 99 * HOUR;
  A = await client(token, { now: later, time: later, serverTime: later, clock: later });
  check('a time sent with the hello counts for nothing: the server\'s clock decides', !A.welcome.away && A.st.money === m1 && (await serverState(id)).passive.at <= clock());

  // ---- restarts: the clock is saved with the money -------------------------------------------------------------------------
  const m2 = (await serverState(id)).money, n3 = pushes(A).length;
  skew += 5 * MIN;
  await until(() => pushes(A).length > n3);
  check('5 minutes on the server\'s clock while connected: the timer pays $500 in one go', (await serverState(id)).money === m2 + 500 && pushes(A).length === n3 + 1);
  await leave(id, A);
  await server.close();
  server = await startServer(opts);
  A = await client(token);
  check('a restart: connecting to the new server pays nothing for time already paid', !A.welcome.away && A.st.money === m2 + 500);
  await leave(id, A);
  await server.close();
  skew += 3 * MIN;
  server = await startServer(opts);
  A = await client(token);
  check('time away across a restart is paid once, on connecting', A.welcome.away?.minutes === 3 && A.st.money === m2 + 800);
  await leave(id, A);
  A = await client(token);
  check('and connecting again pays nothing more', !A.welcome.away && A.st.money === m2 + 800);
  await leave(id, A);

  // ---- two server instances at once (a deploy): each with its own copy in memory, one database ---------------------------
  await server.store.flush();
  const was = structuredClone(await serverState(id));
  const other = new Store(server.db, { log: quiet }); // (the other instance's memory)
  await other.load(id);
  await clockTo(id, MIN + 5e3);
  const one = await collect(server.store, id, clock);
  await server.store.flush();
  const two = await collect(other, id, clock); // (its copy is from before the first one's was written)
  await other.flush();
  const kept = await savedState(id), next = new Store(server.db, { log: quiet });
  check('two instances: one pays the minute; the other\'s copy is out of date, so it reads the row again and finds it paid', one?.r.earned === 100 && two === null
    && kept.money === was.money + 100 && kept.passive.at === was.passive.at + MIN && await collect(next, id, clock) === null
    && (await other.load(id)).st.money === was.money + 100, `${was.money} -> ${kept.money}`);
  skew += MIN;
  const three = await collect(server.store, id, clock);
  await server.store.flush();
  const late = new Store(server.db, { log: quiet }); // (an instance loading it after that was written)
  check('two instances: one that loads it after the other paid finds that minute paid', three?.r.earned === 100 && await collect(late, id, clock) === null
    && (await savedState(id)).money === was.money + 200);
  for (const s of [other, next, late]) await s.close();

  // ---- two instances: the minute's pay writes only money and the clock, never this copy of the rest of the row -------------
  const rp = await post('/api/register', { name: 'idlep', password: 'secret123' });
  const P = await client(rp.body.token), pid = P.user.id;
  await server.store.flush();
  const B = new Store(server.db, { log: quiet }); // (the other instance: it changes the row of a player idle on this one)
  await B.lock([pid], async ([e]) => { e.st.money += 5000; e.st.stars += 7; await B.commit([e]); });
  const np = pushes(P).length;
  await clockTo(pid, MIN + 1e3);
  await until(() => pushes(P).length > np);
  await server.store.flush();
  const row = await savedState(pid), mine = server.store.cache.get(pid).st;
  check('a player idle on this instance: the other one\'s change stays, the minute is paid on top, and the push has the right money', row.money === 5110
    && row.stars === 7 && row.passive.earned === 100 && mine.money === 5110 && mine.stars === 7 && P.st.money === 5110 && pushes(P).length === np + 1, JSON.stringify({ money: row.money, stars: row.stars }));
  await B.close();
  // A change of their own on this instance, not written yet when the minute comes: written whole with it.
  await P.act('play.start', { mode: 'deathmatch' });
  const np2 = pushes(P).length;
  skew += MIN;
  await until(() => pushes(P).length > np2);
  await server.store.flush();
  const row2 = await savedState(pid);
  check('a change of the player\'s own and the minute\'s pay are both saved', row2.money === 5210 && row2.play?.mode === 'deathmatch' && row2.stars === 7, JSON.stringify({ money: row2.money, play: row2.play?.mode }));
  await leave(pid, P);

  // ---- accounts from before passive income: no back pay ----------------------------------------------------------------
  const ro = await post('/api/register', { name: 'oldtimer', password: 'secret123' });
  const { rows: [o] } = await server.db.query('SELECT id FROM users WHERE name = $1', ['oldtimer']);
  await server.db.query("UPDATE users SET state = state - 'passive', created = $2 WHERE id = $1", [o.id, clock() - 400 * 24 * HOUR]);
  let O = await client(ro.body.token);
  check('an account from before passive income: its first connect pays nothing for the time before, and starts its clock', !O.welcome.away && O.st.money === 10
    && O.st.passive.at > clock() - 1000 && O.st.passive.at <= clock() && O.st.passive.earned === 0);
  await server.store.flush();
  check('and the clock it started is saved', (await savedState(o.id)).passive?.at === O.st.passive.at);
  await leave(o.id, O);
  skew += 10 * MIN;
  O = await client(ro.body.token);
  check('then it earns like any other', O.welcome.away?.minutes === 10 && O.st.money === 1010);
  await leave(o.id, O);

  // ---- staff: a restore keeps the clock, a reset starts it again ---------------------------------------------------------
  const rb = await post('/api/register', { name: 'Boss', password: 'secret123' });
  const boss = await client(rb.body.token);
  const snap = await boss.admin('snapshot.save', { id, label: 'an old clock' });
  await clockTo(id, 2 * HOUR + 30e3);
  A = await client(token);
  const paidTo = A.st.passive.at;
  check('two hours away pays two hours', A.welcome.away?.minutes === 120);
  await leave(id, A);
  await boss.admin('snapshot.restore', { snap: snap.id });
  check('a restored snapshot keeps the clock as it is now, so its two hours aren\'t paid again', (await serverState(id)).passive.at === paidTo);
  A = await client(token);
  check('(connecting after the restore pays nothing)', !A.welcome.away);
  await leave(id, A);
  skew += 3 * HOUR;
  await boss.admin('reset', { id });
  const fresh = await serverState(id);
  check('a reset starts the clock again at the reset (on the server\'s clock)', fresh.money === 10 && fresh.passive.earned === 0 && fresh.passive.at > clock() - 1000 && fresh.passive.at <= clock());
  A = await client(token);
  check('so the three hours before it pay nothing', !A.welcome.away && A.st.money === 10);
  await leave(id, A);

  // ---- prestige: $100 more a minute for each Service Medal, at the medals the account has when it's paid ---------------------
  const rm = await post('/api/register', { name: 'medalist', password: 'secret123' });
  let M = await client(rm.body.token);
  const mid = M.user.id;
  await boss.admin('edit', { id: mid, set: { prof: { medals: 3 } } });
  const nm = pushes(M).length;
  await clockTo(mid, MIN + 1e3);
  await until(() => pushes(M).length > nm);
  await wait(200); // (time for a second payment, were there one)
  check('3 prestiges: the minute\'s timer pays $400 ($100 + 3 × $100), once', (await serverState(mid)).money === 410 && M.st.money === 410 && pushes(M).length === nm + 1
    && (await serverState(mid)).passive.earned === 400, `money ${(await serverState(mid)).money}`);
  await leave(mid, M);
  await clockTo(mid, 13 * HOUR);
  M = await client(rm.body.token);
  check('3 prestiges: 13 hours away pays the 12 hours at $400 a minute ($288,000), and the welcome says so', M.welcome.away?.earned === 288000 && M.welcome.away.minutes === 720
    && M.welcome.away.capped === true && M.st.money === 288410, JSON.stringify(M.welcome.away));
  check('the welcome\'s away is as it always was: no new field for a 1.1.5 game', Object.keys(M.welcome.away).sort().join() === 'capped,earned,minutes', Object.keys(M.welcome.away).join());
  await leave(mid, M);
  await boss.admin('edit', { id: mid, set: { prof: { medals: 1 } } });
  await clockTo(mid, 5 * MIN + 30e3);
  M = await client(rm.body.token);
  check('the rate is the prestiges the account has when it\'s paid: one medal now, so 5 minutes away pay $1,000', M.welcome.away?.earned === 1000 && M.welcome.away.minutes === 5
    && M.st.money === 289410, JSON.stringify(M.welcome.away));
  await leave(mid, M);
  await server.store.withUser(mid, async (e) => { e.st.prof = { ...e.st.prof, medals: 1e6 }; server.store.markDirty(e); }); // (not a count the panel lets through)
  await clockTo(mid, MIN + 1e3);
  M = await client(rm.body.token);
  check('a medal count past every medal there is pays as every medal (69: $7,000 a minute), no more', M.welcome.away?.earned === 7000 && M.welcome.away.minutes === 1, JSON.stringify(M.welcome.away));
  M.close();
  boss.close();
} catch (e) {
  failed++;
  console.log('FAIL  (threw)', e);
} finally {
  await server.close().catch(() => {});
  fs.rmSync(DIR, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
