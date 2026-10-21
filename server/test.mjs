// Server integration tests: a real server (embedded Postgres on disk) and real WebSocket clients.
//   node server/test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

process.env.JACKPOT_MS = '1500';
const { startServer } = await import('./index.mjs');
const { D, casePrice } = await import('../src/js/engine/data.js');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cs2sim-test-db-'));
let failed = 0, passed = 0;
const check = (name, ok, info = '') => { ok ? passed++ : failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = () => {};

let server = await startServer({ port: 0, db: { dataDir: DIR }, log: quiet, priceRefresh: false });
const base = () => `http://localhost:${server.port}`;

async function post(p, body) {
  const r = await fetch(base() + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

// A game client: WebSocket + rpc + a mirror of the state built from welcome + deltas.
async function client(token) {
  const ws = new WebSocket(base().replace('http', 'ws') + '/ws');
  const c = { ws, st: null, events: [], pending: new Map(), seq: 0 };
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
  ws.send(JSON.stringify({ t: 'hello', token, data: D.generatedAt, v: 1 }));
  c.welcome = await welcome;
  c.rpc = (ns, m, args) => new Promise((res, rej) => { const id = ++c.seq; c.pending.set(id, { res, rej }); ws.send(JSON.stringify({ t: 'rpc', id, ns, m, args })); });
  c.act = (m, a) => c.rpc('act', m, a);
  c.waitFor = async (pred, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const e = c.events.find(pred); if (e) return e; await wait(25); } return null; };
  c.close = () => ws.close();
  return c;
}
function apply(c, d) {
  for (const [k, v] of Object.entries(d.set || {})) c.st[k] = v;
  const del = new Set(d.del || []);
  c.st.inv = c.st.inv.filter((i) => !del.has(i.uid));
  for (const u of d.upd || []) { const i = c.st.inv.findIndex((x) => x.uid === u.uid); if (i >= 0) c.st.inv[i] = u; }
  c.st.inv.unshift(...(d.add || []));
}
const give = (id, money) => server.store.withUser(id, async (e) => { e.st.money = money; server.store.markDirty(e); });
const serverState = async (id) => (await server.store.load(id)).st;

try {
  // ---- accounts -----------------------------------------------------------------------------------
  const ra = await post('/api/register', { name: 'alice', password: 'secret123' });
  const rb = await post('/api/register', { name: 'Bob_2', password: 'hunter22' });
  check('register two accounts', ra.status === 200 && rb.status === 200 && ra.body.token && rb.body.token);
  check('duplicate username rejected', (await post('/api/register', { name: 'ALICE', password: 'whatever1' })).status === 400);
  check('bad username rejected', (await post('/api/register', { name: 'a b', password: 'whatever1' })).status === 400);
  check('wrong password rejected', (await post('/api/login', { name: 'alice', password: 'nope-nope' })).status === 400);
  const la = await post('/api/login', { name: 'Alice', password: 'secret123' });
  check('login is case-insensitive and returns a token', la.status === 200 && la.body.name === 'alice');
  let A = await client(la.body.token), B = await client(rb.body.token);
  check('websocket hello -> welcome with fresh state', A.st.money === 10 && A.st.inv.length === 0 && B.user.name === 'Bob_2');
  let bad = null; try { await client('not-a-real-token-xxxxxxxxxx'); } catch (e) { bad = e.message; }
  check('invalid token refused', /expired|log in/i.test(bad || ''));

  // ---- economy --------------------------------------------------------------------------------------
  await give(A.user.id, 1000); await give(B.user.id, 1000);
  const box = D.cases.find((c) => c.n === 'Chroma 2 Case');
  const before = (await serverState(A.user.id)).money;
  const op = await A.act('case.open', { id: box.id, n: 5 });
  const after = (await serverState(A.user.id)).money;
  check('opening cases debits the right amount (server side)', Math.abs(before - casePrice(box) * 5 - after) < 0.011 && op.items.length === 5, `${before} -> ${after}`);
  check('client mirror matches the server', Math.abs(A.st.money - after) < 0.011 && A.st.inv.length === 5);
  let err = null; try { await A.act('case.open', { id: box.id, n: 9999 }); } catch (e) { err = e; }
  check('invalid requests rejected', err?.code === 'bad');
  const sellUid = op.items[0].uid;
  const both = await Promise.allSettled([A.act('item.sell', { uids: [sellUid] }), A.act('item.sell', { uids: [sellUid] })]);
  check('double spend: selling one item twice at once pays once', both.filter((r) => r.status === 'fulfilled').length === 1);
  const m0 = (await serverState(A.user.id)).money;
  await A.act('click', { n: 400, crits: 0 });
  const m1 = (await serverState(A.user.id)).money;
  check('click spam is capped by the server', m1 - m0 < 0.1 * 400 * 0.5, `earned ${(m1 - m0).toFixed(2)}`);

  // ---- market: one shared stock ------------------------------------------------------------------------
  {
    const MK = await import('../src/js/engine/market.js');
    const w = MK.marketWindow();
    const skin = Object.values(D.skins).find((s) => !s.star && MK.skinListings(s, w).length && MK.skinListings(s, w)[0].p < 50);
    const bought = await A.act('market.buy', { kind: 'skin', id: skin.id, n: 0, window: w });
    let e = null; try { await B.act('market.buy', { kind: 'skin', id: skin.id, n: 0, window: w }); } catch (x) { e = x; }
    check('market stock is shared: a listing sells once for everyone', bought.item && e?.code === 'sold');
    const ev = await B.waitFor((m) => m.t === 'market' && m.lid === MK.skinListings(skin, w)[0].lid);
    check('other players are told when a listing sells', !!ev);
  }

  // ---- trading --------------------------------------------------------------------------------------
  await B.act('case.open', { id: box.id, n: 2 });
  const x = A.st.inv[0], y = B.st.inv[0];
  const inv = await A.rpc('trade', 'inventory', { name: 'bob_2' });
  check('see another player’s inventory', inv.items.some((i) => i.uid === y.uid));
  const offer = await A.rpc('trade', 'offer', { to: 'Bob_2', give: { uids: [x.uid], money: 5 }, get: { uids: [y.uid], money: 0 }, msg: 'swap?' });
  err = null; try { await A.act('item.sell', { uids: [x.uid] }); } catch (e) { err = e; }
  check('items in an open offer are reserved', err?.code === 'reserved');
  const bt = await B.waitFor((e) => e.t === 'trades' && e.trades.some((t) => t.id === offer.id));
  check('recipient is notified of the offer', !!bt);
  err = null; try { await B.rpc('trade', 'accept', { id: offer.id, version: 99 }); } catch (e) { err = e; }
  check('stale offer version rejected', /changed/i.test(err?.message || ''));
  const moneyA = (await serverState(A.user.id)).money, moneyB = (await serverState(B.user.id)).money;
  await B.rpc('trade', 'accept', { id: offer.id, version: 1 });
  const sA = await serverState(A.user.id), sB = await serverState(B.user.id);
  check('trade swaps items atomically', sA.inv.some((i) => i.uid === y.uid) && !sA.inv.some((i) => i.uid === x.uid) && sB.inv.some((i) => i.uid === x.uid) && !sB.inv.some((i) => i.uid === y.uid));
  check('trade moves the money', Math.abs(sA.money - (moneyA - 5)) < 0.011 && Math.abs(sB.money - (moneyB + 5)) < 0.011);
  await wait(200);
  check('both clients got the change', A.st.inv.some((i) => i.uid === y.uid) && B.st.inv.some((i) => i.uid === x.uid));
  const { rows } = await server.db.query('SELECT state FROM users WHERE id = $1', [B.user.id]);
  const dbB = typeof rows[0].state === 'string' ? JSON.parse(rows[0].state) : rows[0].state;
  check('trade is already in the database', dbB.inv.some((i) => i.uid === x.uid));
  // An offer that becomes impossible fails cleanly.
  const z = B.st.inv.find((i) => i.uid !== x.uid);
  const o2 = await A.rpc('trade', 'offer', { to: 'bob_2', give: { uids: [], money: 1 }, get: { uids: [z.uid], money: 0 } });
  await B.act('item.lock', { uid: z.uid, lk: true });
  err = null; try { await B.rpc('trade', 'accept', { id: o2.id }); } catch (e) { err = e; }
  check('offer with a locked item fails', /failed/i.test(err?.message || ''));

  // ---- coinflip between players: value is conserved ------------------------------------------------------
  const tot0 = (await serverState(A.user.id)).money + (await serverState(B.user.id)).money;
  const flip = await A.rpc('gamble', 'flip.create', { money: 100, side: 'ct', clientSeed: 'a' });
  err = null; try { await B.rpc('gamble', 'flip.join', { id: flip.id, money: 50, clientSeed: 'b' }); } catch (e) { err = e; }
  check('coinflip join must match the stake', /between/.test(err?.message || ''));
  await B.rpc('gamble', 'flip.join', { id: flip.id, money: 100, clientSeed: 'b' });
  const ra2 = await A.waitFor((e) => e.t === 'gamble.result' && e.ev.kind === 'flip');
  const tot1 = (await serverState(A.user.id)).money + (await serverState(B.user.id)).money;
  check('coinflip settles and conserves money', ra2 && Math.abs(tot0 - tot1) < 0.011, `winner ${ra2?.ev.result.winnerName} ${tot0} -> ${tot1} stats A ${JSON.stringify((await serverState(A.user.id)).stats.gambleWon)}`);
  const { coinflipResult, sha256Hex } = await import('../src/js/engine/gamble.js');
  const fr = ra2.ev.result;
  check('coinflip result verifies from the revealed seeds', coinflipResult(fr.fair.serverSeed, fr.fair.clientSeed) === fr.result && sha256Hex(fr.fair.serverSeed) === fr.fair.hash);

  // ---- battle vs bots ------------------------------------------------------------------------------
  const mb = (await serverState(A.user.id)).money;
  const bat = await A.rpc('gamble', 'battle.create', { cases: [box.id, box.id], format: '1v1v1', mode: 'normal', clientSeed: 'x' });
  await A.rpc('gamble', 'battle.bots', { id: bat.id });
  const be = await A.waitFor((e) => e.t === 'gamble.result' && e.ev.kind === 'battle');
  const ma = (await serverState(A.user.id)).money;
  check('battle vs bots runs and charges the cost', be && Math.abs(mb - ma - casePrice(box) * 2) < 0.011, be ? `won: ${be.ev.result.winners.includes(0)}` : 'no result');
  // Two players + a bot in a 2v2.
  const b2 = await A.rpc('gamble', 'battle.create', { cases: [box.id], format: '2v2', mode: 'crazy', clientSeed: 'y' });
  await B.rpc('gamble', 'battle.join', { id: b2.id, seat: 2, clientSeed: 'z' });
  await A.rpc('gamble', 'battle.bots', { id: b2.id });
  const e1 = await A.waitFor((e) => e.t === 'gamble.result' && e.ev.kind === 'battle' && e.ev.result.format === '2v2');
  const e2 = await B.waitFor((e) => e.t === 'gamble.result' && e.ev.kind === 'battle' && e.ev.result.format === '2v2');
  check('2v2 battle: both players get the result', e1 && e2 && e2.ev.mySeat === 2);

  // ---- jackpot ------------------------------------------------------------------------------------
  const j0 = (await serverState(A.user.id)).money + (await serverState(B.user.id)).money;
  await A.rpc('gamble', 'jackpot.join', { money: 30, clientSeed: 'p' });
  await B.rpc('gamble', 'jackpot.join', { money: 10, clientSeed: 'q' });
  const je = await A.waitFor((e) => e.t === 'gamble.result' && e.ev.kind === 'jackpot', 6000);
  const j1 = (await serverState(A.user.id)).money + (await serverState(B.user.id)).money;
  check('jackpot draws and conserves money', je && Math.abs(j0 - j1) < 0.011, je ? `winner ${je.ev.result.winnerName}` : 'no draw');

  // ---- team ladder ------------------------------------------------------------------------------------
  const M = await import('../src/js/engine/manager.js');
  for (const c of [A, B]) {
    await give(c.user.id, 5000);
    for (let i = 0; i < 4; i++) await c.act('team.pack', { pack: 'premium' });
    const owned = c.st.inv.filter((i) => i.t === 'pro');
    const lu = M.autoLineup(owned.map((i) => D.pros[i.id]));
    await c.act('team.set', { slots: Object.fromEntries(M.SLOTS.map((s) => [s, owned.find((i) => i.id === lu[s].id).uid])) });
  }
  const ladder = await A.rpc('social', 'ladder', {});
  check('ladder lists players by Elo', ladder.length >= 2 && ladder.some((p) => p.me));
  const eloA = A.st.team.elo, eloB = (await serverState(B.user.id)).team.elo;
  const ch = await A.rpc('social', 'challenge', { name: 'bob_2' });
  const eloA2 = (await serverState(A.user.id)).team.elo, eloB2 = (await serverState(B.user.id)).team.elo;
  check('challenge plays both saved lineups and moves Elo both ways', ch.match.rounds.length >= 13 && eloA2 - eloA === ch.elo && eloB2 - eloB === -ch.elo, `${ch.match.score.join('-')}, Elo ${ch.elo >= 0 ? '+' : ''}${ch.elo}`);
  err = null; try { await A.rpc('social', 'challenge', { name: 'bob_2' }); } catch (e) { err = e; }
  check('challenge cooldown', /moment ago/.test(err?.message || ''));

  // ---- restart: open escrow is refunded --------------------------------------------------------------
  const r0 = (await serverState(A.user.id)).money;
  await A.rpc('gamble', 'flip.create', { money: 25, side: 't', clientSeed: 'r' });
  const r1 = (await serverState(A.user.id)).money;
  A.close(); B.close();
  await server.close();
  server = await startServer({ port: 0, db: { dataDir: DIR }, log: quiet, priceRefresh: false });
  const r2 = (await serverState(A.user.id)).money;
  check('open coinflip escrow refunded after a restart', Math.abs(r1 - (r0 - 25)) < 0.011 && Math.abs(r2 - r0) < 0.5, `${r0} -> ${r1} -> ${r2}`);
  const A2 = await client(la.body.token);
  check('player can log back in after a restart', A2.st.inv.length > 0);
  A2.close();
} catch (e) {
  failed++;
  console.error('FAIL  test crashed:', e);
}
await server.close().catch(() => {});
fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
