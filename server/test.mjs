// Server integration tests: a real server (embedded Postgres on disk) and real WebSocket clients.
//   node server/test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import WebSocket from 'ws';

process.env.JACKPOT_MS = '1500';
for (const k of ['HOST', 'SERVER_COMMIT', 'RENDER_GIT_COMMIT']) delete process.env[k]; // (the checks of /health's commit and HOST set them)
const { startServer } = await import('./index.mjs');
const { D, casePrice, keyFor } = await import('../src/js/engine/data.js');
const { serialKey, makeStickerItem, makeSkinItem, itemValue } = await import('../src/js/engine/items.js');
const SU = await import('../src/js/engine/storage.js');
const IX = await import('../src/js/engine/itemindex.js');
const { marketWindow, skinListings } = await import('../src/js/engine/market.js');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cs2sim-test-db-'));
let failed = 0, passed = 0;
const check = (name, ok, info = '') => { ok ? passed++ : failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = () => {};

let server = await startServer({ port: 0, db: { dataDir: DIR }, log: quiet, priceRefresh: false, discord: false });
let ixUser = null; // (the player the Index checks leave behind, for the restart)
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
  if (d.sto) { const gone = new Set(d.sto.del || []); c.st.stored = [...(d.sto.add || []), ...(c.st.stored || []).filter((i) => !gone.has(i.uid))]; }
  if (d.ix) c.st.index = IX.applyChange(c.st.index, d.ix);
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
  // Cases and their keys are bought into the inventory, then opened.
  await A.act('case.buy', { id: box.id, n: 5 });
  await A.act('key.buy', { key: keyFor(box), n: 5 });
  const op = await A.act('case.open', { id: box.id, n: 5 });
  const after = (await serverState(A.user.id)).money;
  check('buying 5 cases and 5 keys and opening them debits the right amount (server side)', Math.abs(before - casePrice(box) * 5 - after) < 0.011 && op.items.length === 5, `${before} -> ${after}`);
  check('client mirror matches the server', Math.abs(A.st.money - after) < 0.011 && A.st.inv.length === 5);
  let err = null; try { await A.act('case.open', { id: box.id, n: 9999 }); } catch (e) { err = e; }
  check('invalid requests rejected', err?.code === 'bad');
  const sellUid = op.items[0].uid;
  const both = await Promise.allSettled([A.act('item.sell', { uids: [sellUid] }), A.act('item.sell', { uids: [sellUid] })]);
  check('double spend: selling one item twice at once pays once', both.filter((r) => r.status === 'fulfilled').length === 1);
  // Match money online: only for a match the server saw start, once, and only what it could have earned.
  let unseen = null; try { await A.act('play.reward', { result: 'win', kills: 20, assists: 3, roundsWon: 13, rounds: 22 }); } catch (e) { unseen = e; }
  const { run } = await A.act('play.start', { mode: 'competitive' });
  let tooFast = null; try { await A.act('play.reward', { run, mode: 'competitive', result: 'win', kills: 20, assists: 3, roundsWon: 13, rounds: 22 }); } catch (e) { tooFast = e; }
  await server.store.withUser(A.user.id, async (e) => { e.st.play = { ...e.st.play, at: Date.now() - 30 * 60 * 1000 }; server.store.markDirty(e); });
  const m0 = (await serverState(A.user.id)).money;
  const paid = await A.act('play.reward', { run, mode: 'competitive', result: 'win', kills: 20, assists: 3, roundsWon: 13, rounds: 22 });
  const m1 = (await serverState(A.user.id)).money;
  let twice = null; try { await A.act('play.reward', { run, mode: 'competitive', result: 'win', kills: 20, assists: 3, roundsWon: 13, rounds: 22 }); } catch (e) { twice = e; }
  check('online match money: refused for an unseen or too-quick match, paid once for a real one ($250 + 20 kills + 3 assists)',
    unseen?.code === 'match' && tooFast?.code === 'match' && twice?.code === 'match' && Math.abs(m1 - m0 - 680) < 0.011 && paid.earned === 680 && paid.xp.total > 0,
    `${m0} -> ${m1}`);

  // A match with cheats in it pays nothing online, and its run can't be paid afterwards.
  {
    const { run: cheatRun } = await A.act('play.start', { mode: 'competitive' });
    await server.store.withUser(A.user.id, async (e) => { e.st.play = { ...e.st.play, at: Date.now() - 30 * 60 * 1000 }; server.store.markDirty(e); });
    const before = await serverState(A.user.id);
    const none = await A.act('play.reward', { run: cheatRun, mode: 'competitive', result: 'win', kills: 20, assists: 3, roundsWon: 13, rounds: 22, cheats: true });
    const after = await serverState(A.user.id);
    let again = null; try { await A.act('play.reward', { run: cheatRun, mode: 'competitive', result: 'win', kills: 20, assists: 3, roundsWon: 13, rounds: 22 }); } catch (e) { again = e; }
    check('online match with cheats: no money, no XP, and no paying it again without the flag',
      none.cheats === true && none.earned === 0 && after.money === before.money && JSON.stringify(after.prof) === JSON.stringify(before.prof) && again?.code === 'match' && (await serverState(A.user.id)).money === before.money);
  }

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
    // A charm's listings are worked out from the clock too: the pattern and price a player sees are the server's.
    const charm = Object.values(D.charms).find((c) => MK.charmListings(c, w)[0]?.p < 50), listing = MK.charmListings(charm, w)[0];
    const got = await A.act('market.buy', { kind: 'charm', id: charm.id, n: 0, window: w });
    let taken = null; try { await B.act('market.buy', { kind: 'charm', id: charm.id, n: 0, window: w }); } catch (x) { taken = x; }
    check('a charm listing online is the one on screen: its pattern and price, sold once for everyone', got.item.pat === listing.item.pat && got.price === listing.p && got.lid === listing.lid && taken?.code === 'sold', `#${got.item?.pat} ${got.price}`);
  }

  // ---- the item database: everyone's copies, by item ----------------------------------------------------
  {
    const idx = await B.rpc('social', 'db.index', {});
    const it = A.st.inv.find((i) => i.t === 'skin' && i.fl != null);
    const key = 'skin:' + it.id, mine = A.st.inv.filter((i) => i.t === 'skin' && i.id === it.id).length;
    check('item database counts every copy on the server', idx.players >= 2 && idx.counts[key] === mine, `${key}: ${idx.counts[key]} (alice has ${mine})`);
    const { copies } = await B.rpc('social', 'db.item', { t: 'skin', id: it.id });
    check('item database lists each copy with its owner and float', copies.length === mine && copies.every((c) => c.owner === 'alice' && !c.me && c.item.fl === A.st.inv.find((x) => x.uid === c.item.uid)?.fl));
    const { copies: own } = await A.rpc('social', 'db.item', { t: 'skin', id: it.id });
    check('item database says whose each copy is, for the link to their profile', copies.every((c) => c.id === A.user.id) && own.every((c) => c.id === A.user.id && c.me));
    let e = null; try { await B.rpc('social', 'db.item', { t: 'chicken', id: 'x' }); } catch (x) { e = x; }
    check('item database refuses unknown kinds', /Unknown item/.test(e?.message || ''));
    // Float ranks for your own items, among everyone's copies: as the database page works them out.
    const DB = await import('../src/js/engine/database.js');
    const mineRanks = await A.rpc('social', 'db.ranks', {});
    const all = DB.inventoryRanks(A.st.inv.concat((await serverState(B.user.id)).inv));
    const expect = Object.fromEntries(A.st.inv.filter((i) => all.has(i.uid)).map((i) => [i.uid, all.get(i.uid)]));
    check('item database: your float ranks among every copy on the server', JSON.stringify(Object.keys(mineRanks).sort()) === JSON.stringify(Object.keys(expect).sort())
      && Object.entries(expect).every(([uid, r]) => mineRanks[uid].low === r.low && mineRanks[uid].high === r.high && mineRanks[uid].of === r.of), `${Object.keys(mineRanks).length} ranked`);
    const stk = await B.rpc('social', 'db.item', { t: 'sticker', id: Object.keys(D.stickers)[0] });
    check('item database: a sticker, held and applied to guns', Array.isArray(stk.copies) && Array.isArray(stk.applied));
  }

  // ---- trading --------------------------------------------------------------------------------------
  await B.act('case.buy', { id: box.id, n: 2 });
  await B.act('key.buy', { key: keyFor(box), n: 2 });
  const bOpen = await B.act('case.open', { id: box.id, n: 2 });
  // Serial numbers are counted across the server: Bob's continue after Alice's of the same item.
  const last = {};
  check('serial numbers are shared by everyone on the server', [...op.items, ...bOpen.items].every((it) => it.sn === (last[serialKey(it)] = (last[serialKey(it)] || 0) + 1)),
    [...op.items, ...bOpen.items].map((it) => it.sn).join(','));
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

  // ---- Storage Units ---------------------------------------------------------------------------------
  {
  const failure = async (p) => { try { await p; return null; } catch (e) { return e; } };
  const dbState = async (id) => { const v = (await server.db.query('SELECT state FROM users WHERE id = $1', [id])).rows[0].state; return typeof v === 'string' ? JSON.parse(v) : v; };
  const stickerDef = Object.values(D.stickers).find((s) => s.p >= 1);
  const skinDef = Object.values(D.skins).find((s) => !s.v && !s.star && s.r === 3);
  // Items straight into a player's inventory (what they are doesn't matter here), for the mirror too.
  const grant = async (c, n, make = () => makeStickerItem(stickerDef, 'test')) => {
    const items = Array.from({ length: n }, make);
    await server.store.withUser(c.user.id, async (e) => { e.st.inv.unshift(...items); server.store.markDirty(e); });
    c.st.inv.unshift(...items.map((i) => structuredClone(i)));
    return items;
  };
  const newUnit = async (c, name) => {
    const { items: [u] } = await c.act('storage.buy', {});
    await c.act('storage.name', { unit: u.uid, name });
    return u;
  };
  await give(A.user.id, 5000); await give(B.user.id, 5000);
  const A3 = await client(la.body.token); // (the same player on a second connection)
  const stash = await newUnit(A, 'stash');
  const [s1, s2, s3] = await grant(A, 3);
  await wait(20);
  const worth0 = SU.ownedValue(await serverState(A.user.id));
  await A.act('storage.deposit', { unit: stash.uid, uids: [s1.uid, s2.uid] });
  const saved = await dbState(A.user.id);
  check('storage: a deposit is in the database when the answer arrives (in a transaction, not left for the next write)', saved.stored.filter((i) => i.su === stash.uid).length === 2 && !saved.inv.some((i) => i.uid === s1.uid)
    && saved.inv.find((i) => i.uid === stash.uid)?.mod > 0);
  check('storage: the deposit reaches the client as a small change: the mirror has it', A.st.stored.length === 2 && !A.st.inv.some((i) => i.uid === s1.uid));
  check('storage: a player\'s other connection sees it too', await (async () => { for (let i = 0; i < 80 && (A3.st.stored || []).length !== 2; i++) await wait(25); return (A3.st.stored || []).length === 2; })());
  check('storage: what you own is worth the same after storing it', SU.ownedValue(await serverState(A.user.id)) === worth0);
  const again = await client(la.body.token);
  check('storage: a new connection gets what\'s stored in its welcome', again.st.stored.length === 2 && again.st.inv.some((i) => i.uid === stash.uid && i.name === 'stash'));
  again.close();

  // Refusals on the server's own paths.
  const code = async (p) => (await failure(p))?.code;
  check('storage: the server refuses selling what\'s stored', await code(A.act('item.sell', { uids: [s1.uid] })) === 'stored');
  check('storage: and staking it in a live coinflip', await code(A.rpc('gamble', 'flip.create', { money: 0, uids: [s1.uid], side: 't', clientSeed: 'x' })) === 'stored');
  check('storage: and in the jackpot', await code(A.rpc('gamble', 'jackpot.join', { money: 0, uids: [s1.uid], clientSeed: 'x' })) === 'stored');
  check('storage: and in a bot coinflip', await code(A.act('gamble.coinflip', { money: 0, uids: [s1.uid], side: 't', clientSeed: 'x' })) === 'stored');
  const offerStored = await failure(A.rpc('trade', 'offer', { to: 'Bob_2', give: { uids: [s1.uid], money: 0 }, get: { uids: [], money: 0 } }));
  check('storage: and offering it in a trade, saying why', /Storage Unit/.test(offerStored?.message || ''), offerStored?.message);
  const askStored = await failure(B.rpc('trade', 'offer', { to: 'alice', give: { uids: [], money: 1 }, get: { uids: [s1.uid], money: 0 } }));
  check('storage: and asking someone for what they\'ve stored (without saying where it is)', /no longer has/.test(askStored?.message || '') && !/Storage/.test(askStored.message), askStored?.message);
  const offerUnit = await failure(A.rpc('trade', 'offer', { to: 'Bob_2', give: { uids: [stash.uid], money: 0 }, get: { uids: [], money: 0 } }));
  check('storage: a unit can\'t be offered in a trade', /can't be traded/.test(offerUnit?.message || ''), offerUnit?.message);
  const seen = await B.rpc('trade', 'inventory', { name: 'alice' });
  check('storage: another player sees neither units nor what\'s in them', !seen.items.some((i) => i.t === 'unit') && !seen.items.some((i) => i.uid === s1.uid) && seen.items.some((i) => i.uid === s3.uid));
  check('storage: a unit refuses a stake', await code(A.rpc('gamble', 'flip.create', { money: 1, uids: [stash.uid], side: 't', clientSeed: 'x' })) === 'unit');
  const pending = await A.rpc('trade', 'offer', { to: 'Bob_2', give: { uids: [s3.uid], money: 0 }, get: { uids: [], money: 0 } });
  check('storage: an item in an open trade offer can\'t be stored', await code(A.act('storage.deposit', { unit: stash.uid, uids: [s3.uid] })) === 'reserved');
  await A.rpc('trade', 'cancel', { id: pending.id });
  const askB = await grant(B, 1);
  const bOffer = await A.rpc('trade', 'offer', { to: 'Bob_2', give: { uids: [], money: 2 }, get: { uids: [askB[0].uid], money: 0 } });
  const bUnit = await newUnit(B, 'bobs');
  await B.act('storage.deposit', { unit: bUnit.uid, uids: [askB[0].uid] });
  const late = await failure(B.rpc('trade', 'accept', { id: bOffer.id }));
  check('storage: an offer for an item stored since fails when accepted, and nothing moves', /no longer have/.test(late?.message || '') && (await serverState(B.user.id)).stored.some((i) => i.uid === askB[0].uid));

  // The item database and net worth still see stored items.
  const copies = await A.rpc('social', 'db.item', { t: 'sticker', id: stickerDef.id });
  check('storage: the item database still lists what\'s stored', copies.copies.some((c) => c.item.uid === s1.uid) && copies.copies.some((c) => c.item.uid === s3.uid));
  const plainSkin = () => makeSkinItem(skinDef, { stt: false });
  const [fl1] = await grant(A, 1, plainSkin);
  await grant(B, 1, plainSkin);
  await A.act('storage.deposit', { unit: stash.uid, uids: [fl1.uid] });
  await server.store.flush();
  const ranks = await A.rpc('social', 'db.ranks', {});
  check('storage: float ranks count stored skins (yours and among everyone\'s)', !!ranks[fl1.uid] && ranks[fl1.uid].of >= 2, JSON.stringify(ranks[fl1.uid]));
  await A.act('storage.retrieve', { unit: stash.uid, uids: [fl1.uid] });
  const stored0 = (await serverState(A.user.id)).stored.length;
  A3.close();
  const peek = await client(la.body.token);
  const listed = peek.welcome.players.find((p) => p.name === 'alice');
  peek.close();
  check('storage: the players list\'s worth counts stored items', stored0 > 0 && listed.worth === Math.round(SU.ownedValue(await serverState(A.user.id))), `${listed.worth}`);

  // A failed save leaves nothing half done: memory goes back to what the database has.
  const tx = server.db.tx;
  server.db.tx = async () => { throw new Error('the database went away'); };
  const dbFail = await failure(A.act('storage.deposit', { unit: stash.uid, uids: [s3.uid] }));
  server.db.tx = tx;
  const afterFail = await serverState(A.user.id);
  check('storage: when the transaction fails the deposit is refused and the item is still in the inventory', dbFail && !dbFail.code && afterFail.inv.some((i) => i.uid === s3.uid) && !afterFail.stored.some((i) => i.uid === s3.uid), dbFail?.message);

  // ---- races: two connections of one player at the same moment. Whatever order they land in, every item ends up in one place.
  const R1 = await client(la.body.token), R2 = await client(la.body.token);
  const place = async (uid) => { const st = await serverState(A.user.id); return [st.inv.filter((i) => i.uid === uid).length, st.stored.filter((i) => i.uid === uid).length]; };
  const noDupes = async () => { const all = SU.ownedItems(await serverState(A.user.id)).map((i) => i.uid); return new Set(all).size === all.length; };

  // Both deposit 600 different items into the same unit: only one fits.
  const big = await newUnit(A, 'big');
  const half1 = await grant(A, 600), half2 = await grant(A, 600);
  const both = await Promise.allSettled([R1.act('storage.deposit', { unit: big.uid, uids: half1.map((i) => i.uid) }), R2.act('storage.deposit', { unit: big.uid, uids: half2.map((i) => i.uid) })]);
  const held = SU.unitCount(await serverState(A.user.id), big.uid);
  check('race: two bulk deposits that together overfill a unit: one goes through whole, the other not at all', both.filter((r) => r.status === 'fulfilled').length === 1 && held === 600 && both.find((r) => r.status === 'rejected')?.reason.code === 'unitfull', `${held} held`);
  // Filling it right up from both sides at once: never past 1,000.
  const rest = (await serverState(A.user.id)).inv.filter((i) => i.t === 'sticker' && [...half1, ...half2].some((x) => x.uid === i.uid));
  const tops = await Promise.allSettled([R1.act('storage.deposit', { unit: big.uid, uids: rest.slice(0, 250).map((i) => i.uid) }), R2.act('storage.deposit', { unit: big.uid, uids: rest.slice(250, 500).map((i) => i.uid) })]);
  const full = SU.unitCount(await serverState(A.user.id), big.uid);
  check('race: the 1,000 cap holds under simultaneous deposits', full <= SU.UNIT_CAP && full === 600 + 250 * tops.filter((r) => r.status === 'fulfilled').length, `${full} held`);
  check('race: nothing was lost or copied by the bulk deposits', await noDupes() && SU.ownedItems(await serverState(A.user.id)).filter((i) => [...half1, ...half2].some((x) => x.uid === i.uid)).length === 1200);

  // A whole unit in one request: a thousand uids fit in one WebSocket message, both ways.
  const room = SU.UNIT_CAP - full, spare = (await serverState(A.user.id)).inv.filter((i) => i.t === 'sticker').slice(0, room).map((i) => i.uid);
  await R1.act('storage.deposit', { unit: big.uid, uids: spare });
  const thousand = SU.contents(await serverState(A.user.id), big.uid).map((i) => i.uid);
  const allOut = await R1.act('storage.retrieve', { unit: big.uid, uids: thousand });
  const emptied = SU.unitCount(await serverState(A.user.id), big.uid);
  const allIn = await R1.act('storage.deposit', { unit: big.uid, uids: thousand });
  check('storage: a full unit moves in one request each way', thousand.length === SU.UNIT_CAP && allOut.n === SU.UNIT_CAP && emptied === 0 && allIn.n === SU.UNIT_CAP && SU.unitCount(await serverState(A.user.id), big.uid) === SU.UNIT_CAP, `${JSON.stringify(thousand).length} bytes of uids`);
  check('storage: and the 1,001st is refused by the server', (await failure(R1.act('storage.deposit', { unit: big.uid, uids: [(await grant(A, 1))[0].uid] })))?.code === 'unitfull');

  // Deposit against sell of the same item, many times over.
  const contest = await grant(A, 20);
  const money0 = (await serverState(A.user.id)).money;
  // (The connections swap roles item by item: the server reads one's messages before the other's, so both ways of it
  // are played out.)
  const sold = await Promise.allSettled(contest.flatMap((it, k) => {
    const [a, b] = k % 2 ? [R2, R1] : [R1, R2];
    return [a.act('storage.deposit', { unit: stash.uid, uids: [it.uid] }), b.act('item.sell', { uids: [it.uid] })];
  }));
  let oneEach = true, sells = 0;
  for (const it of contest) { const [i, s] = await place(it.uid); if (i !== 0 || s > 1) oneEach = false; if (!s) sells++; }
  const ok = sold.filter((r) => r.status === 'fulfilled').length;
  const earned = Math.round(((await serverState(A.user.id)).money - money0) * 100) / 100;
  check('race: deposit against sell: each item is stored or sold, never both, and only what sold is paid for', oneEach && ok === 20 && sells > 0 && sells < 20 && earned === Math.round(sells * itemValue(contest[0]) * 100) / 100, `${sells} sold, ${20 - sells} stored`);

  // Retrieve against retrieve of the same item.
  const onlyIn = (await serverState(A.user.id)).stored.filter((i) => i.su === stash.uid).slice(0, 10).map((i) => i.uid);
  const twice = await Promise.allSettled(onlyIn.flatMap((u) => [R1.act('storage.retrieve', { unit: stash.uid, uids: [u] }), R2.act('storage.retrieve', { unit: stash.uid, uids: [u] })]));
  let exactly = true;
  for (const u of onlyIn) { const [i, s] = await place(u); if (i !== 1 || s !== 0) exactly = false; }
  check('race: the same item retrieved twice at once comes out once', exactly && twice.filter((r) => r.status === 'fulfilled').length === onlyIn.length && await noDupes());

  // Deposit against a trade offer and against a stake, on the same item.
  for (const offerFirst of [false, true]) {
    const [t1, t2] = await grant(A, 2);
    const store = (t) => R1.act('storage.deposit', { unit: stash.uid, uids: [t.uid] });
    const offer = () => R2.rpc('trade', 'offer', { to: 'Bob_2', give: { uids: [t1.uid], money: 0 }, get: { uids: [], money: 0 } });
    const stake = () => R2.rpc('gamble', 'flip.create', { money: 0, uids: [t2.uid], side: 't', clientSeed: 'x' });
    const [dep, off] = offerFirst ? (await Promise.allSettled([offer(), store(t1)])).reverse() : await Promise.allSettled([store(t1), offer()]);
    const [ti, ts] = await place(t1.uid);
    check(`race: deposit against a trade offer (${offerFirst ? 'offer' : 'deposit'} sent first): stored or on offer, never both`, (dep.status === 'fulfilled') !== (off.status === 'fulfilled') && (dep.status === 'fulfilled' ? ts === 1 && ti === 0 : ti === 1 && ts === 0), `deposit ${dep.status}, offer ${off.status}`);
    if (off.status === 'fulfilled') await A.rpc('trade', 'cancel', { id: off.value.id });
    const [dep2, stk] = offerFirst ? (await Promise.allSettled([stake(), store(t2)])).reverse() : await Promise.allSettled([store(t2), stake()]);
    const [t2i, t2s] = await place(t2.uid);
    check(`race: deposit against a stake (${offerFirst ? 'stake' : 'deposit'} sent first): stored or in escrow, never both`, (dep2.status === 'fulfilled') !== (stk.status === 'fulfilled') && t2i === 0 && t2s === (dep2.status === 'fulfilled' ? 1 : 0), `deposit ${dep2.status}, stake ${stk.status}`);
    if (stk.status === 'fulfilled') await A.rpc('gamble', 'flip.cancel', { id: stk.value.id });
  }

  // Many moves back and forth at once, and the database agrees with memory at the end.
  const churn = await grant(A, 10);
  await A.act('storage.deposit', { unit: stash.uid, uids: churn.slice(0, 5).map((i) => i.uid) });
  await Promise.allSettled([
    ...churn.slice(5).map((i, k) => (k % 2 ? R1 : R2).act('storage.deposit', { unit: stash.uid, uids: [i.uid] })),
    ...churn.slice(0, 5).map((i, k) => (k % 2 ? R2 : R1).act('storage.retrieve', { unit: stash.uid, uids: [i.uid] })),
  ]);
  const mem = await serverState(A.user.id), row = await dbState(A.user.id);
  const uids = (l) => l.map((i) => i.uid).sort().join();
  check('race: after moves in both directions at once, the database has exactly what memory has', uids(mem.stored) === uids(row.stored) && uids(mem.inv) === uids(row.inv) && await noDupes(), `${mem.stored.length} stored`);
  R1.close(); R2.close();
  await wait(50);

  // ---- tools: Name Tags and the StatTrak™ Swap Tool, on the server -------------------------------------
  {
    const skin = (x = {}) => () => ({ ...makeSkinItem(skinDef, { stt: false, src: 'test' }), ...x });
    const tagsOf = (st, id = 'nametag') => st.inv.filter((i) => i.t === 'tool' && i.id === id);
    await give(A.user.id, 5000); await give(B.user.id, 5000);
    const T1 = await client(la.body.token), T2 = await client(la.body.token); // (the same player on two more connections)
    const bought = await A.act('tools.buy', { id: 'nametag', n: 2 });
    check('tools: bought on the server, for the Steam Market\'s price', bought.cost === 8.94 && bought.items.length === 2 && A.st.inv.filter((i) => i.t === 'tool').length === 2);
    await A.act('item.sell', { uids: [bought.items[1].uid] });
    check('tools: and sold for what they cost', (await serverState(A.user.id)).money === 5000 - 4.47);
    check('tools: on no path is the price the client\'s', await code(A.act('tools.buy', { id: 'nametag', n: 2, cost: 0.01, p: 0.01 })) === undefined && (await serverState(A.user.id)).money === Math.round((5000 - 4.47 * 3) * 100) / 100);
    for (const t of tagsOf(await serverState(A.user.id)).slice(1)) await A.act('item.sell', { uids: [t.uid] });

    const [g1, g2] = await grant(A, 2, skin());
    const hostile = '<img src=x onerror=';
    const tagged = await A.act('tools.name', { uid: g1.uid, name: hostile });
    const row = await dbState(A.user.id);
    check('tools: a name is in the database when the answer arrives, and the tag is gone from it', tagged.item.name === hostile && row.inv.find((i) => i.uid === g1.uid)?.name === hostile && !tagsOf(row).length);
    check('tools: the client\'s mirror has the name, and the other connection too', A.st.inv.find((i) => i.uid === g1.uid)?.name === hostile && await (async () => { for (let i = 0; i < 80 && !T1.st.inv.find((x) => x.uid === g1.uid)?.name; i++) await wait(25); return true; })());
    check('tools: a name can\'t be set any other way', await failure(A.act('tools.name', { uid: g2.uid, name: 'x', free: true })) !== null && !(await serverState(A.user.id)).inv.find((i) => i.uid === g2.uid).name);

    // The name filter, and a refused name costs nothing.
    await A.act('tools.buy', { id: 'nametag' });
    for (const bad of ['fuck you', 'admin', ' x', 'x'.repeat(21), 'a\u202eb', 'a\u0000b', '\ud83d', 'f.u.c.k', 'sh1t', 'fu\u0441k', '\u3164']) check(`tools: the server refuses the name ${JSON.stringify(bad)}, tag kept`, await code(A.act('tools.name', { uid: g2.uid, name: bad })) === 'name' && tagsOf(await serverState(A.user.id)).length === 1);
    check('tools: what the database has is still good', !(await dbState(A.user.id)).inv.find((i) => i.uid === g2.uid)?.name);

    // Two connections, one tag: one wins, the other is refused.
    const raced = await Promise.allSettled([T1.act('tools.name', { uid: g2.uid, name: 'first' }), T2.act('tools.name', { uid: g1.uid, name: 'second' })]);
    const after = await serverState(A.user.id);
    check('race: one Name Tag, two connections: one success and one refusal', raced.filter((r) => r.status === 'fulfilled').length === 1 && raced.find((r) => r.status === 'rejected')?.reason.code === 'notool' && !tagsOf(after).length, raced.map((r) => r.status).join());
    const st1 = await A.act('tools.buy', { id: 'stattrak_swap' });
    const [k1, k2, k3] = await grant(A, 3, skin({ stt: true, kills: 0 }));
    await server.store.withUser(A.user.id, async (e) => { for (const [uid, n] of [[k1.uid, 500], [k2.uid, 7], [k3.uid, 90]]) e.st.inv.find((i) => i.uid === uid).kills = n; server.store.markDirty(e); });
    const swaps = await Promise.allSettled([T1.act('tools.swap', { a: k1.uid, b: k2.uid }), T2.act('tools.swap', { a: k1.uid, b: k3.uid })]);
    const sw = await serverState(A.user.id), kill = (u) => sw.inv.find((i) => i.uid === u).kills;
    check('race: one Swap Tool, two connections: one swap and one refusal', swaps.filter((r) => r.status === 'fulfilled').length === 1 && swaps.find((r) => r.status === 'rejected')?.reason.code === 'notool' && !tagsOf(sw, 'stattrak_swap').length
      && [kill(k1.uid), kill(k2.uid), kill(k3.uid)].sort((a, b) => a - b).join() === '7,90,500', swaps.map((r) => r.status).join());
    const swRow = await dbState(A.user.id);
    check('tools: the swap is in the database, tool and all', swRow.inv.find((i) => i.uid === k1.uid).kills === kill(k1.uid) && !tagsOf(swRow, 'stattrak_swap').length && !swRow.inv.some((i) => i.uid === st1.items[0].uid));

    // A counter only runs in a match the server saw start, a kill at a time, as fast as that match's clock.
    const before = (await serverState(A.user.id)).inv.find((i) => i.uid === k1.uid).kills;
    check('StatTrak: no match, no kill', await code(A.act('play.stattrak', { uid: k1.uid, kills: 50 })) === 'match' && (await serverState(A.user.id)).inv.find((i) => i.uid === k1.uid).kills === before);
    await A.act('play.start', { mode: 'deathmatch' });
    check('StatTrak: a match that\'s only just started has no kills in it', await code(A.act('play.stattrak', { uid: k1.uid })) === 'match');
    await server.store.withUser(A.user.id, async (e) => { e.st.play = { ...e.st.play, at: Date.now() - 3000 }; server.store.markDirty(e); });
    const counted = await A.act('play.stattrak', { uid: k1.uid, kills: 50 });
    check('StatTrak: a kill in the match counts once, whatever it claims', counted.kills === before + 1 && (await serverState(A.user.id)).inv.find((i) => i.uid === k1.uid).kills === before + 1, String(counted.kills));
    await A.act('play.stattrak', { uid: k1.uid });
    check('StatTrak: and a third in three seconds is too fast', await code(A.act('play.stattrak', { uid: k1.uid })) === 'match' && (await serverState(A.user.id)).inv.find((i) => i.uid === k1.uid).kills === before + 2);

    // Offers: an item (or a tool) in one can't be changed or used, whichever side asked.
    const reservedSkin = (await grant(A, 1, skin()))[0], askedSkin = (await grant(A, 1, skin()))[0];
    await A.act('tools.buy', { id: 'nametag' });
    const mine = await A.rpc('trade', 'offer', { to: 'Bob_2', give: { uids: [reservedSkin.uid], money: 0 }, get: { uids: [], money: 0 } });
    const theirs = await B.rpc('trade', 'offer', { to: 'alice', give: { uids: [], money: 1 }, get: { uids: [askedSkin.uid], money: 0 } });
    check('tools: an item in an offer you made refuses a name', await code(A.act('tools.name', { uid: reservedSkin.uid, name: 'x' })) === 'reserved');
    check('tools: so does one another player\'s offer asks you for', await code(A.act('tools.name', { uid: askedSkin.uid, name: 'x' })) === 'reserved');
    await A.rpc('trade', 'cancel', { id: mine.id });
    await B.rpc('trade', 'cancel', { id: theirs.id });
    const tag = tagsOf(await serverState(A.user.id))[0];
    const tagOffer = await A.rpc('trade', 'offer', { to: 'Bob_2', give: { uids: [tag.uid], money: 0 }, get: { uids: [], money: 0 } });
    check('tools: a tag in an offer isn\'t used', await code(A.act('tools.name', { uid: askedSkin.uid, name: 'x' })) === 'notool' && !(await serverState(A.user.id)).inv.find((i) => i.uid === askedSkin.uid).name);
    check('tools: and the refusal says it\'s held, not that you have none', /in a pending trade offer/.test((await failure(A.act('tools.name', { uid: askedSkin.uid, name: 'x' })))?.message || ''));
    await A.rpc('trade', 'cancel', { id: tagOffer.id });

    // A name survives a trade; so does a counter; the tool itself trades.
    const named = (await serverState(A.user.id)).inv.find((i) => i.name === hostile || i.name === 'first' || i.name === 'second');
    const seen = await B.rpc('trade', 'inventory', { name: 'alice' });
    check('tools: another player sees the name, and tools, in your inventory', seen.items.find((i) => i.uid === named.uid)?.name === named.name && seen.items.some((i) => i.t === 'tool'));
    const counter = sw.inv.find((i) => i.uid === k1.uid);
    const deal = await A.rpc('trade', 'offer', { to: 'Bob_2', give: { uids: [named.uid, k1.uid, tag.uid], money: 0 }, get: { uids: [], money: 1 } });
    const listed = (await B.waitFor((m) => m.t === 'trades' && m.trades.some((t) => t.id === deal.id)))?.trades.find((t) => t.id === deal.id);
    check('tools: the offer shows the name', listed?.give.items.find((i) => i.uid === named.uid)?.name === named.name);
    await B.rpc('trade', 'accept', { id: deal.id });
    const bSt = await serverState(B.user.id);
    check('tools: a traded item keeps its name, and a traded counter its kills', bSt.inv.find((i) => i.uid === named.uid)?.name === named.name && bSt.inv.find((i) => i.uid === k1.uid)?.kills === counter.kills && B.st.inv.find((i) => i.uid === named.uid)?.name === named.name);
    check('tools: and the tool changed hands, ready to use', tagsOf(bSt).some((t) => t.uid === tag.uid));
    check('tools: it isn\'t yours to rename any more', await code(A.act('tools.unname', { uid: named.uid })) === 'missing');
    const removed = await B.act('tools.unname', { uid: named.uid });
    check('tools: removal reaches the client: the name goes from the mirror too', !('name' in removed.item) && !('name' in B.st.inv.find((i) => i.uid === named.uid)));
    await B.act('tools.name', { uid: named.uid, name: 'bobs now' });
    check('tools: the new owner names it with the tag they got', (await serverState(B.user.id)).inv.find((i) => i.uid === named.uid).name === 'bobs now');

    // Storage and the item database.
    const stash2 = await newUnit(B, 'tools');
    await B.act('storage.deposit', { unit: stash2.uid, uids: [named.uid] });
    const inside = (await dbState(B.user.id)).stored.find((i) => i.uid === named.uid);
    check('tools: stored with its name, and no tool reaches it there', inside?.name === 'bobs now' && await code(B.act('tools.unname', { uid: named.uid })) === 'stored');
    await B.act('storage.retrieve', { unit: stash2.uid, uids: [named.uid] });
    check('tools: and it comes back out with its name, in the database and the client\'s mirror', (await dbState(B.user.id)).inv.find((i) => i.uid === named.uid)?.name === 'bobs now' && B.st.inv.find((i) => i.uid === named.uid)?.name === 'bobs now');
    await B.act('storage.deposit', { unit: stash2.uid, uids: [named.uid] });
    const { copies } = await B.rpc('social', 'db.item', { t: 'skin', id: skinDef.id });
    check('tools: the item database shows the name to everyone', copies.find((c) => c.item.uid === named.uid)?.item.name === 'bobs now');
    await A.act('tools.buy', { id: 'nametag' });
    const idx = await A.rpc('social', 'db.index', {});
    const toolCopies = await A.rpc('social', 'db.item', { t: 'tool', id: 'nametag' });
    check('tools: and counts tools', toolCopies.copies.length >= 1 && typeof idx.counts === 'object');
    T1.close(); T2.close();
    await wait(50);
  }
  }

  // ---- the Index: the server keeps the record, and pays each reward once ----------------------------------------------------
  {
    const code = async (p) => { try { await p; return null; } catch (e) { return e.code || e.message; } };
    const said = async (p) => { try { await p; return null; } catch (e) { return e.message; } };
    const dbState = async (id) => { const v = (await server.db.query('SELECT state FROM users WHERE id = $1', [id])).rows[0].state; return typeof v === 'string' ? JSON.parse(v) : v; };
    const player = async (name) => { const r = await post('/api/register', { name, password: 'secret123' }); const c = await client(r.body.token); c.token = r.body.token; await give(c.user.id, 1e6); return c; };
    const P = await player('indexer'), P2 = await client(P.token), Q = await player('indexer2');
    ixUser = P.user.id;
    const xray = D.cases.find((c) => c.n === 'X-Ray P250 Package'), goal = IX.setOf(xray.id).goal;
    const cap = D.cases.find((c) => c.n === 'Sticker Capsule');
    const open = async (c, box, n = 1) => { await c.act('case.buy', { id: box.id, n }); return c.act('case.open', { id: box.id, n }); };

    check('index: a new account starts with an empty record, nothing to fill in', JSON.stringify(P.st.index) === JSON.stringify({ items: {}, claimed: {}, filled: true, lost: 0 }));
    check('index: nothing to claim before you\'ve finished it', await code(P.act('index.claim', { goal })) === 'unfinished');
    P2.events.length = 0;
    const { items: [drop] } = await open(P, xray);
    check('index: an opening goes on the record on the server, and the mirror has it', (await serverState(P.user.id)).index.items[drop.id]?.n === 1 && P.st.index.items[drop.id]?.n === 1);
    const pushed = await P2.waitFor((e) => e.t === 'delta' && e.d.ix);
    check('index: another connection is told, as a small change (not the record)', pushed && pushed.d.ix.items[drop.id]?.n === 1 && !('index' in pushed.d.set) && P2.st.index.items[drop.id]?.n === 1);
    check('index: and the change says which set that finished', JSON.stringify(pushed?.d.ix.done) === JSON.stringify([goal]));

    // A client can only ask for what the record says it has earned.
    const fakes = await Promise.all([
      P.act('index.add', { id: cap.id }), P.act('index.mark', { items: { [drop.id]: {} } }), P.act('index.record', { items: [drop] }),
    ].map(said));
    check('index: there is no action that writes to the record', fakes.every((x) => /Unknown action/.test(x || '')), fakes.join(' / '));
    const other = IX.setOf(cap.id);
    const forged = await code(P.act('index.claim', { goal: other.goal, items: Object.fromEntries(other.ids.map((id) => [id, { n: 1 }])), index: { items: {} }, done: true }));
    check('index: and what a client sends with a claim counts for nothing', forged === 'unfinished');
    const rec0 = JSON.stringify((await serverState(P.user.id)).index);
    check('index: a raw state sent with an action changes nothing', await code(P.act('item.seen', { uids: [], index: { items: { x: { n: 1 } } } })) === null && JSON.stringify((await serverState(P.user.id)).index) === rec0);

    // Two connections claiming at once: one success.
    const paidBefore = (await serverState(P.user.id)).prof.total;
    const race = await Promise.allSettled([P.act('index.claim', { goal }), P2.act('index.claim', { goal })]);
    const wins = race.filter((r) => r.status === 'fulfilled'), losses = race.filter((r) => r.status === 'rejected');
    check('index: two connections claiming at once leave one success', wins.length === 1 && losses.length === 1 && losses[0].reason.code === 'claimed', race.map((r) => r.status).join(', '));
    check('index: and it paid once', (await serverState(P.user.id)).prof.total === paidBefore + IX.goalOf(goal).reward.xp);
    check('index: a claim is in the database when the answer arrives (in a transaction)', Object.hasOwn((await dbState(P.user.id)).index.claimed, goal));
    await wait(40);
    check('index: both connections see it claimed', Object.hasOwn(P.st.index.claimed, goal) && Object.hasOwn(P2.st.index.claimed, goal));

    // Harder: a weapon case's reward and its bonus, six requests at once from both connections.
    const big = IX.setOf(box.id);
    await server.store.withUser(P.user.id, async (e) => { IX.record(e.st, [...big.ids, big.rare[0]].map((id) => ({ t: 'skin', id, fl: 0.2, sd: 1 })), Date.now()); server.store.markDirty(e); });
    const s0 = (await serverState(P.user.id)).stars;
    const many = await Promise.allSettled([big.goal, big.rareGoal, big.goal, big.rareGoal, big.goal, big.rareGoal].map((g, i) => (i % 2 ? P : P2).act('index.claim', { goal: g })));
    check('index: a burst of claims for two rewards pays each once', many.filter((r) => r.status === 'fulfilled').length === 2 && (await serverState(P.user.id)).stars === s0 + IX.goalOf(big.goal).reward.stars + IX.RARE_REWARD.stars);

    // What doesn't count online.
    const { items: [mine] } = await open(Q, cap);
    const offer = await Q.rpc('trade', 'offer', { to: 'indexer', give: { uids: [mine.uid], money: 0 }, get: { uids: [], money: 0 } });
    await P.rpc('trade', 'accept', { id: offer.id });
    await wait(40);
    const pRec = (await serverState(P.user.id)).index.items;
    check('index: an item traded to you doesn\'t count, though it says which capsule it came from', (await serverState(P.user.id)).inv.some((i) => i.uid === mine.uid && i.src === cap.n) && !pRec[mine.id]);
    check('index: and the one who unboxed it keeps it on their record', (await serverState(Q.user.id)).index.items[mine.id]?.n === 1 && !(await serverState(Q.user.id)).inv.some((i) => i.uid === mine.uid));

    const w = marketWindow(Date.now());
    let skin = null; // (the first listing still free: the checks above have bought from this window too)
    for (const s of Object.values(D.skins).filter((x) => !x.star && skinListings(x, w).length && !pRec[x.id])) {
      if (await code(P.act('market.buy', { kind: 'skin', id: s.id, n: 0, window: w })) === null) { skin = s; break; }
    }
    check('index: nor an item bought on the Market', skin && (await serverState(P.user.id)).inv.some((i) => i.id === skin.id) && !(await serverState(P.user.id)).index.items[skin.id]);

    // A stake won from another player, and a battle's drops.
    let staked = null;
    for (let k = 0; k < 16 && !staked; k++) {
      const { items: [it] } = await open(Q, cap), value = Math.max(0.01, Math.round(itemValue(it) * 100) / 100);
      const f = await Q.rpc('gamble', 'flip.create', { money: 0, uids: [it.uid], side: 't', clientSeed: 'q' + k });
      await P.rpc('gamble', 'flip.join', { id: f.id, money: value, clientSeed: 'p' + k });
      await wait(30);
      if ((await serverState(P.user.id)).inv.some((i) => i.uid === it.uid)) staked = it;
    }
    check('index: a stake won from another player doesn\'t count', staked && !(await serverState(P.user.id)).index.items[staked.id]);

    let won = null;
    for (let k = 0; k < 16 && !won; k++) {
      P.events.length = 0;
      const b = await P.rpc('gamble', 'battle.create', { cases: [cap.id], format: '1v1', mode: 'normal', clientSeed: 'b' + k });
      await P.rpc('gamble', 'battle.bots', { id: b.id });
      const ev = await P.waitFor((e) => e.t === 'gamble.result' && e.ev.kind === 'battle');
      if (ev?.ev.result.winners.includes(0)) won = ev.ev.result.share[0];
    }
    await wait(40);
    check('index: a live case battle\'s drops count for the one who takes them home', won?.length > 0 && won.every((i) => (P.st.index.items[i.id]?.n || 0) >= 1));

    // An account from before the Index: filled in from what it owns, minus what changed hands.
    const O = await player('oldtimer'), own = await open(O, cap), keep = own.items[0];
    const { items: [gift] } = await open(Q, xray);
    const t2 = await Q.rpc('trade', 'offer', { to: 'oldtimer', give: { uids: [gift.uid], money: 0 }, get: { uids: [], money: 0 } });
    await O.rpc('trade', 'accept', { id: t2.id });
    const { items: [flipped] } = await open(Q, cap);
    let viaStake = null;
    for (let k = 0; k < 16 && !viaStake; k++) {
      const it = k ? (await open(Q, cap)).items[0] : flipped, value = Math.max(0.01, Math.round(itemValue(it) * 100) / 100);
      const f = await Q.rpc('gamble', 'flip.create', { money: 0, uids: [it.uid], side: 't', clientSeed: 'o' + k });
      await O.rpc('gamble', 'flip.join', { id: f.id, money: value, clientSeed: 'n' + k });
      await wait(30);
      if ((await serverState(O.user.id)).inv.some((i) => i.uid === it.uid)) viaStake = it;
    }
    O.close();
    await wait(40);
    await server.store.flush();
    server.store.cache.delete(O.user.id);
    await server.db.query("UPDATE users SET state = state - 'index' WHERE id = $1", [O.user.id]);
    const back = await serverState(O.user.id), items = back.index.items;
    check('index: an old account is filled in as it loads, from the box items it owns', back.index.filled === true && items[keep.id]?.n >= 1);
    check('index: leaving out what came in a trade', back.inv.some((i) => i.uid === gift.uid) && !items[gift.id]);
    check('index: and what was won as a stake', !!viaStake && back.inv.some((i) => i.uid === viaStake.uid) && (viaStake.id === keep.id || !items[viaStake.id]));
    await server.store.flush();
    check('index: and that\'s saved, so it happens once', (await dbState(O.user.id)).index?.filled === true);
    for (const c of [P, P2, Q]) c.close();
    await wait(50);
  }

  // ---- restart: open escrow is refunded --------------------------------------------------------------
  const stored1 = (await serverState(A.user.id)).stored[0].uid;
  const r0 = (await serverState(A.user.id)).money;
  await A.rpc('gamble', 'flip.create', { money: 25, side: 't', clientSeed: 'r' });
  const r1 = (await serverState(A.user.id)).money;
  A.close(); B.close();
  await server.close();
  server = await startServer({ port: 0, db: { dataDir: DIR }, log: quiet, priceRefresh: false, discord: false });
  const r2 = (await serverState(A.user.id)).money;
  check('open coinflip escrow refunded after a restart', Math.abs(r1 - (r0 - 25)) < 0.011 && Math.abs(r2 - r0) < 0.5, `${r0} -> ${r1} -> ${r2}`);
  const A2 = await client(la.body.token);
  check('player can log back in after a restart', A2.st.inv.length > 0);
  const ixAgain = await serverState(ixUser);
  check('index: the record and what\'s been claimed survive a restart', Object.keys(ixAgain.index.items).length > 3 && Object.keys(ixAgain.index.claimed).length === 3);
  check('storage: units and what\'s in them survive a restart', A2.st.stored.length > 1000 - 200 && A2.st.inv.some((i) => i.t === 'unit' && i.name === 'stash') && A2.st.stored.some((i) => i.uid === stored1), `${A2.st.stored.length} stored`);
  const bAgain = await server.store.load(B.user.id);
  check('tools: a name survives a restart', bAgain.st.stored.some((i) => i.name === 'bobs now'));
  const counted = await A2.rpc('social', 'db.index', {});
  const held = A2.st.stored.filter((i) => i.t === 'sticker');
  check('storage: the item database counts stored copies (a fresh count after the restart)', counted.counts['sticker:' + held[0].id] >= held.filter((i) => i.id === held[0].id).length, String(counted.counts['sticker:' + held[0].id]));
  A2.close();

  // What anyone can send with no login: none of it may end the server. (If it does, this run ends here with it.)
  const stranger = async (act) => {
    const ws = new WebSocket(base().replace('http', 'ws') + '/ws');
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    ws.on('error', quiet);
    act(ws);
    await wait(80);
    ws.terminate();
  };
  for (const frame of ['null', '1', '"x"', 'true', '[]', '{}', 'not json', '{"t":"hello"}', '{"t":"rpc"}']) await stranger((ws) => ws.send(frame));
  await stranger((ws) => ws.send('x'.repeat(70000))); // (over the server's limit for a message)
  await stranger((ws) => ws.send(Buffer.alloc(70000), { binary: true }));
  await stranger((ws) => ws.send(Buffer.from([0xff, 0xfe, 0xfd]), { binary: false })); // (text that isn't UTF-8)
  await stranger((ws) => ws._socket.write(Buffer.from([0xc1, 0x00]))); // (a frame with a reserved bit set, unmasked)
  const rawGet = (target) => new Promise((res) => {
    const s = net.connect(server.port, 'localhost', () => s.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
    let got = '';
    s.on('data', (d) => { got += d; });
    s.on('close', () => res(got.split('\r\n')[0]));
    s.on('error', () => res(got.split('\r\n')[0]));
  });
  const odd = [await rawGet('//'), await rawGet('///'), await rawGet('//?x=1'), await rawGet('http://')];
  check('a stranger: an address that isn\'t one is refused', odd.every((l) => / 400 /.test(l)), odd.join(' | '));
  check('a stranger: nothing they send ends the server', (await fetch(base() + '/health')).ok);

  // ---- /health's commit and HOST (deploy/vps: the server behind Caddy, and a deploy waiting for its commit) -------------
  const health = async (b = base()) => (await fetch(b + '/health')).json();
  check('/health: commit is null when nothing says which', (await health()).commit === null);
  // (whether something answers on that address and the server's port)
  const answers = (host) => new Promise((res) => {
    const s = net.connect(server.port, host, () => { s.destroy(); res(true); });
    s.on('error', () => res(false));
  });
  const v6Before = await answers('::1');
  const restartWith = async (env) => {
    await server.close();
    Object.assign(process.env, env);
    try { server = await startServer({ port: 0, db: { dataDir: DIR }, log: quiet, priceRefresh: false, discord: false }); }
    finally { for (const k of Object.keys(env)) delete process.env[k]; }
  };
  await restartWith({ RENDER_GIT_COMMIT: 'render0' });
  check('/health: the commit Render says (RENDER_GIT_COMMIT)', (await health()).commit === 'render0');
  await restartWith({ HOST: '127.0.0.1', SERVER_COMMIT: 'abc1234', RENDER_GIT_COMMIT: 'render0' });
  const h = await health(`http://127.0.0.1:${server.port}`);
  check('/health: SERVER_COMMIT first', h.commit === 'abc1234', String(h.commit));
  check('HOST: the server answers on that address', h.ok === true);
  check('HOST: and on no other', !(await answers('::1')), v6Before ? '' : '(this machine has no ::1 to try it on)');
} catch (e) {
  failed++;
  console.error('FAIL  test crashed:', e);
}
await server.close().catch(() => {});
fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
