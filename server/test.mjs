// Server integration tests: a real server (embedded Postgres on disk) and real WebSocket clients.
//   node server/test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

process.env.JACKPOT_MS = '1500';
const { startServer } = await import('./index.mjs');
const { D, casePrice, keyFor } = await import('../src/js/engine/data.js');
const { serialKey, makeStickerItem, makeSkinItem, itemValue } = await import('../src/js/engine/items.js');
const SU = await import('../src/js/engine/storage.js');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cs2sim-test-db-'));
let failed = 0, passed = 0;
const check = (name, ok, info = '') => { ok ? passed++ : failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = () => {};

let server = await startServer({ port: 0, db: { dataDir: DIR }, log: quiet, priceRefresh: false, discord: false });
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
  check('storage: units and what\'s in them survive a restart', A2.st.stored.length > 1000 - 200 && A2.st.inv.some((i) => i.t === 'unit' && i.name === 'stash') && A2.st.stored.some((i) => i.uid === stored1), `${A2.st.stored.length} stored`);
  const counted = await A2.rpc('social', 'db.index', {});
  const held = A2.st.stored.filter((i) => i.t === 'sticker');
  check('storage: the item database counts stored copies (a fresh count after the restart)', counted.counts['sticker:' + held[0].id] >= held.filter((i) => i.id === held[0].id).length, String(counted.counts['sticker:' + held[0].id]));
  A2.close();
} catch (e) {
  failed++;
  console.error('FAIL  test crashed:', e);
}
await server.close().catch(() => {});
fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
