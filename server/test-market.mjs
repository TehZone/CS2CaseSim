// The Market online (server/p2pmarket.mjs): listing, buying, cancelling and new prices; every race (two buyers, two tabs, a
// seller who trades, sells, stakes, stores or trades up a listed item, a seller who's away, a restart, two server instances at
// once); the rules (limits, prices, rate limits, bans, the admin panel's switches); the admin panel's views; the Item
// Database still counting listed items; and a 1.1.3 game (no caps) never sent anything new. A real server (embedded Postgres
// on disk) and real WebSocket clients.
//   node server/test-market.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

for (const k of Object.keys(process.env)) if (/^DISCORD_/.test(k) || k === 'ADMIN_USERS' || k === 'TRUST_PROXY') delete process.env[k];
const { startServer } = await import('./index.mjs');
const { P2PMarket } = await import('./p2pmarket.mjs');
const { Store } = await import('./store.mjs');
const { D } = await import('../src/js/engine/data.js');
const I = await import('../src/js/engine/items.js');
const P = await import('../src/js/engine/p2p.js');
const { round2 } = await import('../src/js/engine/util.js');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cs2sim-test-market-'));
let failed = 0, passed = 0;
const check = (name, ok, info = '') => { ok ? passed++ : failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const refused = async (p) => { try { await p; return null; } catch (e) { return e; } };
const quiet = () => {};
const opts = { port: 0, db: { dataDir: DIR }, log: quiet, priceRefresh: false, discord: false, admins: ['Boss'] };
let server = await startServer(opts);
const base = () => `http://localhost:${server.port}`;

async function post(p, body) {
  const r = await fetch(base() + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
// A game: caps as its hello names them (null: none at all, as 1.1.3's... no: 1.1.3 names lean1; [] is a game naming none).
async function client(token, caps = ['lean1', 'p2p1']) {
  const ws = new WebSocket(base().replace('http', 'ws') + '/ws');
  const c = { ws, st: null, events: [], pending: new Map(), seq: 0 };
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const welcome = new Promise((res, rej) => {
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.t === 'welcome') { c.st = m.state; c.user = m.user; res(m); return; }
      if (m.t === 'fatal' && !c.user) { rej(Object.assign(new Error(m.error), { code: m.code })); return; }
      if (m.t === 'res') { const p = c.pending.get(m.id); c.pending.delete(m.id); if (m.d) apply(c, m.d); m.ok ? p.res(m.r) : p.rej(Object.assign(new Error(m.err), { code: m.code })); return; }
      if (m.t === 'delta') apply(c, m.d);
      c.events.push(m);
    });
  });
  ws.send(JSON.stringify({ t: 'hello', token, data: D.lock, v: 1, ...(caps ? { caps } : {}) }));
  c.welcome = await welcome;
  // (paced under the server's 20 requests a second per connection)
  let last = 0;
  const pace = async () => { const now = Date.now(), at = Math.max(now, last + 60); last = at; if (at > now) await wait(at - now); };
  c.rpc = async (ns, m, args) => { await pace(); return new Promise((res, rej) => { const id = ++c.seq; c.pending.set(id, { res, rej }); ws.send(JSON.stringify({ t: 'rpc', id, ns, m, args })); }); };
  c.act = (m, a) => c.rpc('act', m, a);
  c.p2p = (m, a = {}) => c.rpc('p2p', m, a);
  c.admin = (m, a = {}) => c.rpc('admin', m, a);
  c.sub = (on) => ws.send(JSON.stringify({ t: 'sub', p2p: on }));
  c.waitFor = async (pred, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const e = c.events.find(pred); if (e) return e; await wait(20); } return null; };
  c.close = () => new Promise((r) => { ws.on('close', r); ws.close(); });
  return c;
}
function apply(c, d) {
  for (const [k, v] of Object.entries(d.set || {})) c.st[k] = v;
  const del = new Set(d.del || []);
  c.st.inv = c.st.inv.filter((i) => !del.has(i.uid));
  for (const u of d.upd || []) { const i = c.st.inv.findIndex((x) => x.uid === u.uid); if (i >= 0) c.st.inv[i] = u; }
  c.st.inv.unshift(...(d.add || []).filter((i) => !c.st.inv.some((x) => x.uid === i.uid)));
}
const json = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const dbState = async (id) => json((await server.db.query('SELECT state FROM users WHERE id = $1', [id])).rows[0].state);
const rowOf = async (lid) => (await server.db.query('SELECT * FROM p2p_listings WHERE id = $1', [lid])).rows[0];
const memState = async (id) => (await server.store.load(id)).st;
const resetLimits = () => server.srv.p2p.hits.clear();
// Gives a player items and money in their saved state (as if they'd always had them).
const setUp = (id, { money, items = [] }) => server.store.withUser(id, async (e) => {
  if (money != null) e.st.money = money;
  e.st.inv.unshift(...items);
  server.store.markDirty(e);
  await server.store.commit([e]);
});
// Every copy of an item (by uid) in every saved state, inventories, units and listings.
const copies = async (uid) => {
  await server.store.flush();
  const { rows } = await server.db.query('SELECT id, state FROM users');
  let n = 0;
  for (const r of rows) { const st = json(r.state); for (const it of [...(st.inv || []), ...(st.stored || []), ...(st.listed || [])]) if (it.uid === uid) n++; }
  return n;
};
const skins = Object.values(D.skins).filter((s) => !s.v && s.p?.FT?.[0] > 2 && s.p.FT[0] < 50 && s.mn <= 0.2 && s.mx >= 0.3 && s.cat === 'rifle');
const mkSkin = (k, extra = {}) => ({ ...I.makeSkinItem(skins[k % skins.length], { fl: 0.2 + (k % 10) / 100, sd: k }), src: 'Test', ...extra });
const knife = Object.values(D.skins).find((s) => s.cat === 'knife' && !s.v && s.p?.FT?.[0] > 50);

try {
  // ---- accounts ------------------------------------------------------------------------------------------------------------
  const tok = {};
  for (const n of ['Boss', 'sam', 'bea', 'cal', 'old', 'dee']) tok[n] = (await post('/api/register', { name: n, password: n + 'pass123' })).body.token;
  check('register the players', Object.values(tok).every(Boolean));
  const id = {};
  for (const n of Object.keys(tok)) id[n] = (await server.db.query('SELECT id FROM users WHERE name_lc = $1', [n.toLowerCase()])).rows[0].id;
  const S = Array.from({ length: 70 }, (_, k) => mkSkin(k));
  const K = { ...I.makeSkinItem(knife, { fl: 0.2, sd: 7 }), src: 'Test' };
  await setUp(id.sam, { money: 1000, items: [...S, K] });
  await setUp(id.bea, { money: 5000 });
  await setUp(id.cal, { money: 5000 });
  await setUp(id.dee, { money: 100, items: [mkSkin(200), mkSkin(201)] });

  // ---- capabilities: a game naming p2p1 is told so; a 1.1.3 game (lean1 only) and one naming nothing aren't ---------------
  let sam = await client(tok.sam), bea = await client(tok.bea), cal = await client(tok.cal);
  const old = await client(tok.old, ['lean1']), bare = await client(tok.dee, null);
  check('caps: a p2p1 game\'s welcome names p2p1 back; 1.1.3\'s names lean1 only; a game naming none gets no caps',
    sam.welcome.caps?.includes('p2p1') && JSON.stringify(old.welcome.caps) === '["lean1"]' && !('caps' in bare.welcome));
  check('1.1.3: an account that never listed has no `listed` in its welcome state', !('listed' in old.st) && !('listed' in bare.st));
  bea.sub(true); old.sub(true); bare.sub(true); // (only bea's counts)
  const tab2 = await client(tok.sam); // (sam's second tab)
  await wait(50);

  // ---- listing ------------------------------------------------------------------------------------------------------------
  const a0 = S[0], ref0 = I.itemValue(a0);
  const r1 = await sam.p2p('list', { uid: a0.uid, price: round2(ref0 * 1.1) });
  let ss = await memState(id.sam);
  check('list: answered with the listing; the item left the inventory for st.listed with its price', !!r1.lid && r1.price === round2(ref0 * 1.1)
    && !ss.inv.some((i) => i.uid === a0.uid) && ss.listed.some((x) => x.uid === a0.uid && x.lid === r1.lid && x.lp === r1.price));
  check('list: the game\'s mirror (its answer\'s changes) has it the same way', !sam.st.inv.some((i) => i.uid === a0.uid) && sam.st.listed?.[0]?.lid === r1.lid);
  check('list: written at once (the row and the state, together)', (await rowOf(r1.lid))?.status === 'open' && (await dbState(id.sam)).listed.some((x) => x.lid === r1.lid));
  check('list: the other tab is sent the change', !!(await tab2.waitFor((m) => m.t === 'delta' && m.d.set?.listed?.some((x) => x.lid === r1.lid))));
  const pushed = await bea.waitFor((m) => m.t === 'p2p.d' && m.add?.some((l) => l.lid === r1.lid));
  check('push: a subscribed p2p1 game is told of the new listing (the item as others see it, no src)', !!pushed && pushed.add[0].seller.name === 'sam' && !('src' in pushed.add[0].item));
  await wait(600);
  check('push: never to a 1.1.3 game or one naming no caps, subscribed or not; never to a p2p1 game not subscribed',
    !old.events.some((m) => m.t === 'p2p.d') && !bare.events.some((m) => m.t === 'p2p.d') && !cal.events.some((m) => m.t === 'p2p.d'));
  check('1.1.3: nothing of a type it doesn\'t know, ever', [...old.events, ...bare.events].every((m) => ['players', 'players.d', 'notice', 'delta', 'trades', 'trades.d', 'market', 'lobbies'].includes(m.t)),
    [...new Set([...old.events, ...bare.events].map((m) => m.t))].join());

  // ---- the rules of listing ------------------------------------------------------------------------------------------------
  const locked = S[1];
  await sam.act('item.lock', { uid: locked.uid, lk: true });
  const e1 = await refused(sam.p2p('list', { uid: locked.uid, price: 50 }));
  const e2 = await refused(sam.p2p('list', { uid: S[2].uid, price: 0.01 }));
  const e3 = await refused(sam.p2p('list', { uid: S[2].uid, price: 2e6 }));
  const e4 = await refused(sam.p2p('list', { uid: S[2].uid, price: round2(I.itemValue(S[2]) * 25) }));
  const e5 = await refused(sam.p2p('list', { uid: 'nope', price: 5 }));
  const e6 = await refused(sam.p2p('list', { uid: a0.uid, price: 5 }));
  check('list refused: locked, under $0.03, over $1,000,000, over 20x its reference, not yours, already listed',
    e1?.code === 'item' && e2?.code === 'price' && e3?.code === 'price' && e4?.code === 'price' && e5?.code === 'missing' && e6?.code === 'missing',
    [e1, e2, e3, e4, e5, e6].map((e) => e?.code).join());
  // An item in your own open trade offer is reserved.
  await sam.rpc('trade', 'offer', { to: 'cal', give: { uids: [S[3].uid] } });
  const e7 = await refused(sam.p2p('list', { uid: S[3].uid, price: 50 }));
  check('list refused: an item in your open trade offer', /pending trade offer/.test(e7?.message || ''), e7?.message);
  // A Storage Unit's item: retrieve it first.
  await setUp(id.sam, { money: 1000 });
  const unit = (await sam.act('storage.buy', { n: 1 })).items[0];
  await sam.act('storage.name', { unit: unit.uid, name: 'box' });
  await sam.act('storage.deposit', { unit: unit.uid, uids: [S[4].uid] });
  const e8 = await refused(sam.p2p('list', { uid: S[4].uid, price: 50 }));
  const e9 = await refused(sam.p2p('list', { uid: unit.uid, price: 50 }));
  check('list refused: an item in a Storage Unit, and a Storage Unit', e8?.code === 'stored' && /Storage Units can't/.test(e9?.message || ''), `${e8?.code} ${e9?.message}`);
  // The rate limit: 10 in 10 seconds.
  resetLimits();
  const burst = [];
  for (let k = 5; k < 16; k++) burst.push(await refused(sam.p2p('list', { uid: S[k].uid, price: round2(I.itemValue(S[k]) * 1.2) })));
  check('rate limit: the 11th listing in 10 seconds is refused (the 10 before it go)', burst.slice(0, 10).every((e) => e === null) && burst[10]?.code === 'rate');
  // The most listings at once: 50.
  resetLimits();
  for (let k = 15; listedCount() < P.MAX_LISTINGS && k < 70; k++) { resetLimits(); await sam.p2p('list', { uid: S[k].uid, price: round2(I.itemValue(S[k]) * 1.3) }); }
  function listedCount() { return (sam.st.listed || []).length; }
  const e10 = await refused(sam.p2p('list', { uid: S[69].uid, price: 50 }));
  check(`at most ${P.MAX_LISTINGS} listings at once`, listedCount() === P.MAX_LISTINGS && e10?.code === 'limit', `${listedCount()} ${e10?.code}`);
  // Cancel some to make room again.
  resetLimits();
  const toCancel = sam.st.listed.slice(0, 10).map((x) => x.lid);
  for (const lid of toCancel) { resetLimits(); await sam.p2p('cancel', { lid }); }
  check('cancel: the items come back to the inventory and the rows are cancelled', sam.st.listed.length === P.MAX_LISTINGS - 10
    && (await Promise.all(toCancel.map(rowOf))).every((r) => r.status === 'cancelled'));
  const e11 = await refused(sam.p2p('cancel', { lid: toCancel[0] }));
  check('cancel: a listing that\'s gone can\'t be cancelled again', e11?.code === 'gone');

  // ---- a listed item can't be used anywhere else ------------------------------------------------------------------------------
  const L = sam.st.listed.find((x) => x.uid === a0.uid);
  const uses = {
    sell: await refused(sam.act('item.sell', { uids: [a0.uid] })),
    store: await refused(sam.act('storage.deposit', { unit: unit.uid, uids: [a0.uid] })),
    tradeup: await refused(sam.act('tradeup.sign', { uids: [a0.uid, ...S.slice(40, 49).map((i) => i.uid)] })),
    stake: await refused(sam.rpc('gamble', 'flip.create', { side: 'ct', money: 0, uids: [a0.uid] })),
    botFlip: await refused(sam.act('gamble.coinflip', { side: 'ct', uids: [a0.uid], clientSeed: 'x' })),
    trade: await refused(sam.rpc('trade', 'offer', { to: 'bea', give: { uids: [a0.uid] } })),
    equip: await refused(sam.act('loadout.equip', { uid: a0.uid })),
    sticker: await refused(sam.act('stickers.scrape', { uid: a0.uid, i: 0 })),
  };
  check('a listed item: no selling, storing, trade-up, staking (live or against bots), trade offer, equipping or stickers',
    Object.entries(uses).every(([k, e]) => (k === 'trade' ? /no longer have/.test(e?.message || '') : e?.code === 'missing')), Object.entries(uses).map(([k, e]) => `${k}:${e?.code}`).join(' '));
  // Someone asking for it in a trade: their offer can't go through while it's listed.
  await refused(bea.rpc('trade', 'offer', { to: 'sam', get: { uids: [a0.uid] } }));
  check('a listed item: nobody can ask for it in a trade offer either', !(await memState(id.sam)).inv.some((i) => i.uid === a0.uid) && L.lid === r1.lid);

  // ---- searching --------------------------------------------------------------------------------------------------------------
  const all = await bea.p2p('browse', {});
  check('browse: the main page has every listing, newest first, a page at a time', all.total === P.MAX_LISTINGS - 10 && all.rows.length <= P.PAGE_SIZE
    && all.rows.every((x, i, a) => !i || a[i - 1].at >= x.at), `${all.total}`);
  const cheap = await bea.p2p('browse', { sort: 'plow' }), dear = await bea.p2p('browse', { sort: 'phigh' });
  check('browse: price low to high and high to low', cheap.rows.every((x, i, a) => !i || a[i - 1].price <= x.price) && dear.rows.every((x, i, a) => !i || a[i - 1].price >= x.price));
  const flow = await bea.p2p('browse', { sort: 'flow' }), disc = await bea.p2p('browse', { sort: 'disc' });
  check('browse: float low to high, biggest discount first', flow.rows.every((x, i, a) => !i || a[i - 1].item.fl <= x.item.fl)
    && disc.rows.every((x, i, a) => !i || P.factsOf(a[i - 1]).disc >= P.factsOf(x).disc - 1e-9));
  const ft = await bea.p2p('browse', { wears: ['FT'] }), rifle = await bea.p2p('browse', { cat: 'rifle' }), knives = await bea.p2p('browse', { cat: 'knife' });
  check('browse: by exterior and by category', ft.rows.every((x) => P.factsOf(x).wear === 'FT') && rifle.total === all.total && knives.total === 0);
  const named = I.realName(a0).split(' | ')[1].split(' ')[0].toLowerCase();
  const byText = await bea.p2p('browse', { text: named });
  check('browse: by name', byText.rows.some((x) => x.lid === r1.lid) && byText.rows.every((x) => I.realName(x.item).toLowerCase().includes(named)), named);
  const band = await bea.p2p('browse', { pmin: 10, pmax: 30 });
  check('browse: a price range', band.rows.every((x) => x.price >= 10 && x.price <= 30));
  const key0 = P.catalogKey(a0);
  const cat = await bea.p2p('catalog', { text: I.realName(a0) });
  const entry = cat.rows.find((x) => x.key === key0);
  check('catalog: searching every item in the game finds it, with how many are listed and the lowest price', !!entry && entry.n >= 1 && entry.min <= r1.price, JSON.stringify(entry));
  const none = await bea.p2p('catalog', { text: 'dragon lore' });
  check('catalog: an item nobody has listed is there, with none', none.rows.length > 0 && none.rows.every((x) => x.n === 0 && x.min === null));
  const one = await bea.p2p('browse', { key: key0, sort: 'plow' });
  check('an item\'s page: all its listings, cheapest first', one.rows.length >= 1 && one.rows.every((x) => P.catalogKey(x.item) === key0));
  const bad = await refused(bea.p2p('browse', { sort: 'nope', page: -4, wears: ['XX'], cat: 'bad', pmin: 'x' }));
  check('browse: nonsense filters are ignored, not errors', bad === null);

  // ---- buying -----------------------------------------------------------------------------------------------------------------
  const beaMoney = (await memState(id.bea)).money, samMoney = (await memState(id.sam)).money;
  const own = await refused(sam.p2p('buy', { lid: r1.lid, price: r1.price }));
  const stale = await refused(bea.p2p('buy', { lid: r1.lid, price: r1.price + 1 }));
  check('buy refused: your own listing; a price other than the listing\'s', own?.code === 'own' && stale?.code === 'price');
  const discordPosts = [];
  const rareDrop = server.srv.discord.rareDrop;
  server.srv.discord.rareDrop = async (x) => { discordPosts.push(x); };
  const got = await bea.p2p('buy', { lid: r1.lid, price: r1.price });
  const bs = await memState(id.bea), ss2 = await memState(id.sam);
  check('buy: the buyer has the item (New) and paid; the seller was paid the whole price (no fee) and the listing is gone from them',
    got.item.uid === a0.uid && bs.inv.some((i) => i.uid === a0.uid && i.nw) && Math.abs(bs.money - (beaMoney - r1.price)) < 0.005
    && Math.abs(ss2.money - (samMoney + r1.price)) < 0.005 && !ss2.listed.some((x) => x.lid === r1.lid) && P.MARKET_FEE === 0);
  const row1 = await rowOf(r1.lid);
  check('buy: the row says sold, to whom, and that the seller was told (they\'re online)', row1.status === 'sold' && row1.buyer_id === id.bea && row1.seen === true && Number(row1.fee) === 0);
  check('buy: saved for both before the answer', (await dbState(id.bea)).inv.some((i) => i.uid === a0.uid) && !(await dbState(id.sam)).listed.some((x) => x.lid === r1.lid));
  const note = await sam.waitFor((m) => m.t === 'delta' && m.note && /sold on the Market/.test(m.note));
  check('buy: the seller\'s games get the change with a notice', !!note && tab2.events.some((m) => m.t === 'delta' && m.d.set?.money != null));
  check('buy: the item exists once', await copies(a0.uid) === 1);
  check('buy: a market purchase posts nothing to Discord\'s drops', discordPosts.length === 0);
  server.srv.discord.rareDrop = rareDrop;
  const gone = await bea.waitFor((m) => m.t === 'p2p.d' && m.del?.includes(r1.lid));
  check('push: a sale takes the listing off the page of those watching', !!gone);
  const again = await refused(cal.p2p('buy', { lid: r1.lid, price: r1.price }));
  check('buy: a sold listing can\'t be bought again', again?.code === 'gone');

  // ---- two buyers at once -----------------------------------------------------------------------------------------------------
  resetLimits();
  const two = sam.st.listed[0];
  const before = { bea: (await memState(id.bea)).money, cal: (await memState(id.cal)).money, sam: (await memState(id.sam)).money };
  const [x1, x2] = await Promise.all([refused(bea.p2p('buy', { lid: two.lid, price: two.lp })), refused(cal.p2p('buy', { lid: two.lid, price: two.lp }))]);
  const after = { bea: (await memState(id.bea)).money, cal: (await memState(id.cal)).money, sam: (await memState(id.sam)).money };
  check('two buyers at once: exactly one gets it, the other is told it\'s gone', [x1, x2].filter((e) => e === null).length === 1 && [x1, x2].some((e) => e?.code === 'gone'));
  check('two buyers at once: money moved once, the item exists once', Math.abs((before.bea + before.cal + before.sam) - (after.bea + after.cal + after.sam)) < 0.005
    && Math.abs(after.sam - before.sam - two.lp) < 0.005 && await copies(two.uid) === 1);
  // The same buyer from two tabs at once.
  resetLimits();
  const bea2 = await client(tok.bea);
  const three = sam.st.listed[0];
  const [y1, y2] = await Promise.all([refused(bea.p2p('buy', { lid: three.lid, price: three.lp })), refused(bea2.p2p('buy', { lid: three.lid, price: three.lp }))]);
  check('two tabs of one buyer at once: bought once', [y1, y2].filter((e) => e === null).length === 1 && await copies(three.uid) === 1);
  const otherTab = await (y1 === null ? bea2 : bea).waitFor((m) => m.t === 'delta' && m.d.add?.some((i) => i.uid === three.uid));
  check('two tabs: the other tab is sent what was bought', !!otherTab);
  await bea2.close();

  // ---- money and room ---------------------------------------------------------------------------------------------------------
  resetLimits();
  const four = sam.st.listed[0];
  await setUp(id.cal, { money: round2(four.lp - 0.01) });
  const poor = await refused(cal.p2p('buy', { lid: four.lid, price: four.lp }));
  check('buy refused: not enough money (nothing changes)', poor?.code === 'funds' && (await rowOf(four.lid)).status === 'open' && (await memState(id.sam)).listed.some((x) => x.lid === four.lid));
  await setUp(id.cal, { money: 5000 });
  const cap = server.srv.INV_CAP;
  server.srv.INV_CAP = (await memState(id.cal)).inv.length;
  const full = await refused(cal.p2p('buy', { lid: four.lid, price: four.lp }));
  server.srv.INV_CAP = cap;
  check('buy refused: a full inventory (nothing changes)', full?.code === 'full' && (await memState(id.cal)).money === 5000);

  // ---- new prices -------------------------------------------------------------------------------------------------------------
  resetLimits();
  const np = round2(four.lp + 1);
  await sam.p2p('reprice', { lid: four.lid, price: np });
  const repriced = await bea.waitFor((m) => m.t === 'p2p.d' && m.upd?.some((u) => u.lid === four.lid && u.price === np));
  const oldPrice = await refused(cal.p2p('buy', { lid: four.lid, price: four.lp }));
  check('reprice: saved, pushed, and a buy at the old price is refused', Number((await rowOf(four.lid)).price) === np && !!repriced && oldPrice?.code === 'price');
  const badPrice = await refused(sam.p2p('reprice', { lid: four.lid, price: 0 }));
  check('reprice refused: a price out of range', badPrice?.code === 'price');

  // ---- the seller isn't connected when it sells --------------------------------------------------------------------------------
  resetLimits();
  const five = sam.st.listed.find((x) => x.lid !== four.lid);
  await sam.close(); await tab2.close();
  await wait(100);
  const samWas = (await dbState(id.sam)).money;
  await cal.p2p('buy', { lid: five.lid, price: five.lp });
  const saved = await dbState(id.sam);
  check('seller away: paid in their saved state, the listing gone from it', Math.abs(saved.money - samWas - five.lp) < 0.005 && !saved.listed.some((x) => x.lid === five.lid)
    && (await rowOf(five.lid)).seen === false);
  sam = await client(tok.sam);
  const awayNote = await sam.waitFor((m) => m.t === 'notice' && /While you were away/.test(m.msg));
  check('seller away: told when they next connect, once', !!awayNote && (await rowOf(five.lid)).seen === true && Math.abs(sam.st.money - saved.money) < 0.005);
  const sam2 = await client(tok.sam);
  await wait(200);
  check('seller away: not told again', !sam2.events.some((m) => m.t === 'notice' && /While you were away/.test(m.msg)));
  await sam2.close();

  // ---- switches ---------------------------------------------------------------------------------------------------------------
  const boss = await client(tok.Boss);
  resetLimits();
  await boss.admin('settings.set', { settings: { trading: false } });
  const off1 = await refused(sam.p2p('list', { uid: S[69].uid, price: 50 })), off2 = await refused(cal.p2p('buy', { lid: four.lid, price: np }));
  const six = sam.st.listed.find((x) => x.lid !== four.lid);
  const offCancel = await refused(sam.p2p('cancel', { lid: six.lid }));
  await boss.admin('settings.set', { settings: { trading: true, market: false } });
  const off3 = await refused(cal.p2p('buy', { lid: four.lid, price: np })), off4 = await refused(sam.p2p('reprice', { lid: four.lid, price: np + 1 }));
  const browseOff = await refused(cal.p2p('browse', {}));
  await boss.admin('settings.set', { settings: { market: true } });
  check('switches: trading off or the market off stop listing, buying and new prices; cancelling and looking still work',
    off1?.code === 'off' && off2?.code === 'off' && offCancel === null && off3?.code === 'off' && off4?.code === 'off' && browseOff === null && (await boss.admin('settings.get')).market === true);

  // ---- the admin panel ----------------------------------------------------------------------------------------------------------
  resetLimits();
  const view = await boss.admin('market.player', { id: id.sam });
  check('admin: a player\'s open listings and what ended, sold to whom', view.open.length === sam.st.listed.length && view.recent.some((r) => r.status === 'sold' && r.buyer?.name === 'bea') && view.fee === 0);
  const notStaff = await refused(cal.admin('market.player', { id: id.sam }));
  const seven = sam.st.listed.find((x) => x.lid !== four.lid);
  const took = await boss.admin('market.cancel', { id: id.sam, lid: seven.lid, reason: 'test' });
  const audit = (await server.db.query("SELECT * FROM audit WHERE action = 'market.cancel' ORDER BY id DESC LIMIT 1")).rows[0];
  check('admin: staff take a listing down (the item back with its owner, logged); players can\'t',
    notStaff?.code === 'perm' && took.item.uid === seven.uid && (await rowOf(seven.lid)).status === 'removed' && (await memState(id.sam)).inv.some((i) => i.uid === seven.uid)
    && audit?.target_id === id.sam && json(audit.detail).lid === seven.lid);
  check('admin: the owner is told', !!(await sam.waitFor((m) => m.t === 'delta' && /moderator took/.test(m.note || ''))));
  // A raw edit (the admin panel's JSON) neither shows nor drops what's listed, and can't write it.
  const pv = await boss.admin('player', { id: id.sam });
  const { inv: _i, stored: _s, listed: _l, index: _x, social: _o, settings: _t, ...raw } = pv.state;
  const keptBefore = (await memState(id.sam)).listed.map((x) => x.lid).join();
  await boss.admin('edit.raw', { id: id.sam, state: { ...raw, stars: (raw.stars || 0) + 1 }, base: pv.rev });
  const pv2 = await boss.admin('player', { id: id.sam });
  const rawListed = await refused(boss.admin('edit.raw', { id: id.sam, state: { ...raw, listed: [] }, base: pv2.rev }));
  check('admin: a raw edit keeps their listings as they are and can\'t write them', (await memState(id.sam)).listed.map((x) => x.lid).join() === keptBefore && keptBefore.length > 0
    && /can't be edited/.test(rawListed?.message || ''));
  const players = await boss.admin('players', { q: 'sam' });
  const samRow = players.rows.find((r) => r.name === 'sam');
  check('admin: a player\'s item count and worth still count what they have listed', samRow.items === [...(await memState(id.sam)).inv, ...(await memState(id.sam)).stored || [], ...(await memState(id.sam)).listed].length);

  // ---- the Item Database counts listed items (they're still owned) ---------------------------------------------------------------
  const listedNow = (await memState(id.sam)).listed[0];
  const idx = await bea.rpc('social', 'db.index', {});
  const copiesOf = await bea.rpc('social', 'db.item', { t: 'skin', id: listedNow.id });
  check('Item Database: counts and copies include listed items', idx.counts['skin:' + listedNow.id] >= 1 && copiesOf.copies.some((c) => c.item.uid === listedNow.uid && c.owner === 'sam'));
  const lows = await bea.rpc('social', 'db.floats', { dir: 'low', cat: 'all', limit: 100 });
  check('float records: listed copies count', Array.isArray(lows.copies));

  // ---- restores and resets --------------------------------------------------------------------------------------------------------
  resetLimits();
  // A snapshot taken while one is listed; it sells; the restore must not bring it back to the seller.
  const snapItem = (await memState(id.sam)).listed.find((x) => x.lid !== four.lid);
  const { id: snap } = await boss.admin('snapshot.save', { id: id.sam, label: 'with a listing' });
  await cal.p2p('buy', { lid: snapItem.lid, price: snapItem.lp });
  const r = await boss.admin('snapshot.restore', { snap });
  await sam.close();
  const st3 = await memState(id.sam);
  check('restore: a listed item sold since stays the buyer\'s (one copy), and no listing is left open for the restored player',
    await copies(snapItem.uid) === 1 && r.dropped >= 1 && !(st3.listed || []).length && !server.srv.p2p.sellerLids(id.sam).length);
  check('restore: their other listings came back to the inventory, each once', (await Promise.all((await snapListed(snap)).filter((x) => x.lid !== snapItem.lid).map((x) => copies(x.uid)))).every((n) => n === 1));
  async function snapListed(s) { return json((await server.db.query('SELECT state FROM snapshots WHERE id = $1', [s])).rows[0].state).listed || []; }
  const openRows = (await server.db.query("SELECT count(*)::int AS n FROM p2p_listings WHERE seller_id = $1 AND status = 'open'", [id.sam])).rows[0].n;
  check('restore: every one of their rows closed', openRows === 0);
  sam = await client(tok.sam);
  resetLimits();
  const relist = sam.st.inv.find((i) => i.t === 'skin' && !i.lk);
  const rl = await sam.p2p('list', { uid: relist.uid, price: round2(I.itemValue(relist) * 1.2) });
  await boss.admin('reset', { id: id.sam });
  check('reset: their listings end with it', (await rowOf(rl.lid)).status === 'cancelled' && !server.srv.p2p.open.has(rl.lid) && !(await memState(id.sam)).listed?.length);

  // ---- state and table agreed -------------------------------------------------------------------------------------------------
  resetLimits();
  const dee = bare; // (dee: a game naming no caps can still use the requests, the pushes are what it's spared)
  const d0 = (await memState(id.dee)).inv.find((i) => i.t === 'skin');
  const dl = await dee.p2p('list', { uid: d0.uid, price: round2(I.itemValue(d0) * 1.1) });
  // The row closed behind its back (another instance's staff, say): the item comes home the next time they're held.
  await server.db.query("UPDATE p2p_listings SET status = 'cancelled' WHERE id = $1", [dl.lid]);
  server.srv.p2p.drop(dl.lid);
  await dee.p2p('mine');
  check('agreement: an item listed with no open row goes back to the inventory', (await memState(id.dee)).inv.some((i) => i.uid === d0.uid) && !(await memState(id.dee)).listed.length && await copies(d0.uid) === 1);
  resetLimits();
  const dl2 = await dee.p2p('list', { uid: d0.uid, price: round2(I.itemValue(d0) * 1.1) });
  await server.store.withUser(id.dee, async (e) => { e.st.listed = []; server.store.markDirty(e); await server.store.commit([e]); }); // (staff edit, say)
  const ghost = await refused(cal.p2p('buy', { lid: dl2.lid, price: dl2.price }));
  check('agreement: a row whose item isn\'t listed any more is taken down, not sold', ghost?.code === 'gone' && (await rowOf(dl2.lid)).status === 'removed' && Math.abs((await memState(id.cal)).money - (5000 - snapItem.lp - five.lp)) < 0.005);

  // ---- bans ---------------------------------------------------------------------------------------------------------------------
  resetLimits();
  const dee2 = await client(tok.dee);
  const d1 = (await memState(id.dee)).inv.find((i) => i.t === 'skin' && i.uid !== d0.uid) || d0;
  const bl = await dee2.p2p('list', { uid: d1.uid, price: round2(I.itemValue(d1) * 1.1) });
  await boss.admin('ban', { id: id.dee, reason: 'scam', minutes: 60 });
  const banAudit = (await server.db.query("SELECT detail FROM audit WHERE action = 'ban' ORDER BY id DESC LIMIT 1")).rows[0];
  check('ban: their listings come down and the items go home', (await rowOf(bl.lid)).status === 'removed' && (await memState(id.dee)).inv.some((i) => i.uid === d1.uid) && json(banAudit.detail).listings === 1);
  const banned = await refused(server.srv.p2p.list({ id: id.dee, name: 'dee' }, { uid: d1.uid, price: 50 }));
  check('ban: a banned player can\'t list (or buy)', banned?.code === 'banned');
  await boss.admin('unban', { id: id.dee });

  // ---- a restart ------------------------------------------------------------------------------------------------------------------
  resetLimits();
  await setUp(id.sam, { items: [mkSkin(300), mkSkin(301), mkSkin(302)] }); // (after the reset: something to sell)
  const kept = (await memState(id.sam)).inv.find((i) => i.t === 'skin');
  sam = await client(tok.sam);
  const kl = await sam.p2p('list', { uid: kept.uid, price: round2(I.itemValue(kept) * 1.15) });
  for (const c of [sam, bea, cal, old, boss]) await c.close().catch(() => {});
  await server.close();
  server = await startServer(opts);
  check('restart: open listings are read back', server.srv.p2p.open.has(kl.lid) && server.srv.p2p.open.get(kl.lid).price === kl.price);
  bea = await client(tok.bea);
  const kb = await bea.p2p('buy', { lid: kl.lid, price: kl.price });
  check('restart: and sell as before', kb.item.uid === kept.uid && await copies(kept.uid) === 1);

  // ---- two server instances at once (a deploy): one sells, the other's memory still says open ---------------------------------
  resetLimits();
  sam = await client(tok.sam);
  const twin = (await memState(id.sam)).inv.filter((i) => i.t === 'skin').slice(0, 2);
  const t1 = await sam.p2p('list', { uid: twin[0].uid, price: round2(I.itemValue(twin[0]) * 1.1) });
  const t2 = await sam.p2p('list', { uid: twin[1].uid, price: round2(I.itemValue(twin[1]) * 1.1) });
  await server.store.flush();
  const otherStore = new Store(server.db, { log: quiet });
  const otherSrv = { db: server.db, store: otherStore, INV_CAP: 3000, log: quiet, isOnline: () => false, sendTo() {}, deltaTo() {}, trades: { reserved: () => new Set() }, admin: { settings: {}, activeBan: async () => null } };
  const other = new P2PMarket(otherSrv);
  await other.init();
  check('two instances: the other one reads the same open listings', other.open.has(t1.lid) && other.open.has(t2.lid));
  // (1) the seller plays on this one (its copy is the one it trusts): the other sells first, this one's sale must roll back.
  const calOther = await otherStore.load(id.cal);
  const calBefore = calOther.st.money;
  await other.buy({ id: id.cal, name: 'cal' }, { lid: t1.lid, price: t1.price });
  const beaBefore = (await dbState(id.bea)).money;
  const late = await refused(bea.p2p('buy', { lid: t1.lid, price: t1.price }));
  check('two instances, seller here: the second sale is refused and rolled back (buyer not charged, seller not paid twice)',
    late?.code === 'gone' && Math.abs((await dbState(id.bea)).money - beaBefore) < 0.005 && Math.abs((await memState(id.bea)).money - beaBefore) < 0.005
    && await copies(twin[0].uid) === 1 && !server.srv.p2p.open.has(t1.lid), `${late?.code} ${late?.message}`);
  check('two instances: the seller\'s copy here is read again (paid once, by the other)', (await memState(id.sam)).listed.every((x) => x.lid !== t1.lid)
    && Math.abs(calOther.st.money - (calBefore - t1.price)) < 0.005);
  await otherStore.close();
  // (2) the seller isn't here: this one reads their row again before selling, and the other's sale shows.
  await sam.close();
  await wait(50);
  const other2Store = new Store(server.db, { log: quiet });
  const other2 = new P2PMarket({ ...otherSrv, store: other2Store });
  await other2.init();
  await other2.buy({ id: id.cal, name: 'cal' }, { lid: t2.lid, price: t2.price });
  await other2Store.close();
  const late2 = await refused(bea.p2p('buy', { lid: t2.lid, price: t2.price }));
  check('two instances, seller away: refused before anything changes', late2?.code === 'gone' && await copies(twin[1].uid) === 1 && Math.abs((await memState(id.bea)).money - beaBefore) < 0.005);

  // ---- the admin panel's switches, as the page shows them ---------------------------------------------------------------------
  resetLimits();
  const boss2 = await client(tok.Boss), watcher = await client(tok.cal), old2 = await client(tok.old, ['lean1']);
  watcher.sub(true); old2.sub(true);
  await wait(50);
  await boss2.admin('settings.set', { settings: { market: false } });
  const closedPush = await watcher.waitFor((m) => m.t === 'p2p.d' && m.open === false);
  const closedAns = await watcher.p2p('browse', {}), closedCat = await watcher.p2p('catalog', { text: 'case' }), closedMine = await watcher.p2p('mine');
  await boss2.admin('settings.set', { settings: { motd: 'hi' } }); // (nothing about the Market changed: nothing pushed)
  await wait(100);
  const pushesWhileClosed = watcher.events.filter((m) => m.t === 'p2p.d' && 'open' in m).length;
  await boss2.admin('settings.set', { settings: { market: true } });
  const openPush = await watcher.waitFor((m) => m.t === 'p2p.d' && m.open === true);
  const openAns = await watcher.p2p('browse', {});
  await wait(100);
  check('closed: the switch is pushed at once to games watching the Market (open: false, then true), once each, and answers say it',
    !!closedPush && pushesWhileClosed === 1 && closedAns.open === false && closedCat.open === false && closedMine.open === false && !!openPush && openAns.open === true);
  check('closed: a 1.1.3 game is sent nothing for it', !old2.events.some((m) => m.t === 'p2p.d'));

  // ---- a sale while the seller's game is still connecting ----------------------------------------------------------------------
  // (Its welcome brings the money; the notice must still come, once: just after that welcome.)
  resetLimits();
  sam = await client(tok.sam);
  const sold1 = mkSkin(400);
  await setUp(id.sam, { items: [sold1] });
  const cl = await sam.p2p('list', { uid: sold1.uid, price: round2(I.itemValue(sold1) * 1.1) });
  await sam.close();
  await wait(50);
  const sent = [], connecting = { welcomed: false, readyState: 1, caps: new Set(['lean1']), send: (t) => sent.push(JSON.parse(t)), close() {} };
  server.srv.sockets.set(id.sam, new Set([connecting]));
  await bea.p2p('buy', { lid: cl.lid, price: cl.price });
  const unseen = (await rowOf(cl.lid)).seen;
  connecting.welcomed = true;
  server.srv.p2p.welcome(id.sam);
  await wait(100);
  server.srv.sockets.delete(id.sam);
  check('a sale while the seller connects: not marked seen then, and told just after the welcome, once', unseen === false && (await rowOf(cl.lid)).seen === true
    && sent.filter((m) => m.t === 'notice' && /sold on the Market/.test(m.msg)).length === 1 && !sent.some((m) => m.note));
  sam = await client(tok.sam);
  await wait(150);
  check('…and not told again at the next hello', !sam.events.some((m) => m.t === 'notice' && /While you were away/.test(m.msg)));

  // ---- a raw edit from a 1.1.3 admin panel (its JSON has `listed` in it, as loaded) ------------------------------------------------
  resetLimits();
  const r113 = mkSkin(405);
  await setUp(id.sam, { items: [r113] });
  const l113 = await sam.p2p('list', { uid: r113.uid, price: round2(I.itemValue(r113) * 1.1) });
  const pv113 = await boss2.admin('player', { id: id.sam });
  const { inv: _i3, stored: _s3, index: _x3, social: _o3, ...rest113 } = pv113.state; // (1.1.3's restOf)
  const raw113 = await refused(boss2.admin('edit.raw', { id: id.sam, state: { ...rest113, stars: (rest113.stars || 0) + 2 }, base: pv113.rev }));
  check('raw edit from a 1.1.3 panel for a player with a listing: goes through, the listing as it was', raw113 === null && (await memState(id.sam)).listed.some((x) => x.lid === l113.lid)
    && (await rowOf(l113.lid)).status === 'open', raw113?.message);

  // ---- staff clearing a bad name on a listed item --------------------------------------------------------------------------------
  resetLimits();
  const namedItem = { ...mkSkin(410), name: 'rude words' };
  await setUp(id.sam, { items: [namedItem] });
  const ln = await sam.p2p('list', { uid: namedItem.uid, price: round2(I.itemValue(namedItem) * 1.1) });
  const shownNamed = (await watcher.p2p('browse', { key: P.catalogKey(namedItem) })).rows.find((l) => l.lid === ln.lid);
  const unnamed = await refused(boss2.admin('items.unname', { id: id.sam, uid: namedItem.uid }));
  const backItem = (await memState(id.sam)).inv.find((i) => i.uid === namedItem.uid);
  check('a bad name on a listed item: the listing comes down (no longer showing it), the name is cleared, the item is home once',
    shownNamed?.item.name === 'rude words' && unnamed === null && (await rowOf(ln.lid)).status === 'removed' && !server.srv.p2p.open.has(ln.lid) && backItem && !backItem.name
    && await copies(namedItem.uid) === 1, unnamed?.message);

  // ---- trade offers and listings -----------------------------------------------------------------------------------------------------
  resetLimits();
  const [ta, tb] = [mkSkin(420), mkSkin(421)];
  await setUp(id.sam, { items: [ta, tb] });
  const offerA = await watcher.rpc('trade', 'offer', { to: 'sam', get: { uids: [ta.uid] } });
  const offerB = await watcher.rpc('trade', 'offer', { to: 'sam', get: { uids: [tb.uid] } });
  const la2 = await sam.p2p('list', { uid: ta.uid, price: round2(I.itemValue(ta) * 1.1) });
  const accListed = await refused(sam.rpc('trade', 'accept', { id: offerA.id }));
  const stillOpen = server.srv.trades.open.has(offerA.id);
  await sam.p2p('cancel', { lid: la2.lid });
  const accBack = await refused(sam.rpc('trade', 'accept', { id: offerA.id }));
  check('a trade offer asking for a listed item: refused while it\'s listed but left open, and goes through once the listing comes down',
    /listed on the Market/.test(accListed?.message || '') && stillOpen && accBack === null && (await memState(id.cal)).inv.some((i) => i.uid === ta.uid), `${accListed?.message} / ${accBack?.message}`);
  const lb = await sam.p2p('list', { uid: tb.uid, price: round2(I.itemValue(tb) * 1.1) });
  await bea.p2p('buy', { lid: lb.lid, price: lb.price });
  const closedRow = (await server.db.query('SELECT status FROM trades WHERE id = $1', [offerB.id])).rows[0];
  check('a trade offer asking for an item sold on the Market: closed as failed at once, and the offerer told', closedRow?.status === 'failed' && !server.srv.trades.open.has(offerB.id)
    && !!(await watcher.waitFor((m) => (m.t === 'trades.d' && m.upd?.some((u) => u.id === offerB.id && u.status === 'failed')) || (m.t === 'trades' && m.trades.some((u) => u.id === offerB.id && u.status === 'failed')))));

  // ---- ended listings are deleted after a week, each seller's newest 40 kept ------------------------------------------------------
  const longAgo = Date.now() - 30 * 24 * 3600e3;
  for (let k = 0; k < 45; k++) {
    await server.db.query(`INSERT INTO p2p_listings (id, seller_id, seller_name, uid, item, price, status, created, updated, seen) VALUES ($1, $2, 'dee', $3, '{}'::jsonb, 1, $4, $5, $5, TRUE)`,
      [`old-${k}`, id.dee, `olduid-${k}`, k % 2 ? 'cancelled' : 'removed', longAgo + k * 1000]);
  }
  await server.db.query(`INSERT INTO p2p_listings (id, seller_id, seller_name, uid, item, price, status, buyer_id, buyer_name, created, updated, sold_at, seen) VALUES ('old-sold', $1, 'dee', 'olduid-s', '{}'::jsonb, 1, 'sold', $2, 'bea', $3, $3, $3, TRUE)`, [id.dee, id.bea, longAgo - 1000]);
  const endedRows = (await server.db.query("SELECT id, status, updated FROM p2p_listings WHERE seller_id = $1 AND status <> 'open' ORDER BY updated DESC", [id.dee])).rows;
  const expectGone = endedRows.slice(40).filter((x) => x.status !== 'sold' && Number(x.updated) < Date.now() - 7 * 24 * 3600e3).map((x) => x.id);
  const pruned = await server.srv.p2p.prune();
  const keptIds = (await server.db.query("SELECT id FROM p2p_listings WHERE seller_id = $1 AND status <> 'open' ORDER BY updated DESC", [id.dee])).rows.map((x) => x.id);
  check('pruning: cancelled and taken-down listings over a week old go, but each seller\'s newest 40 that ended and every sold one stay',
    expectGone.length > 0 && pruned === expectGone.length && keptIds.length === endedRows.length - expectGone.length && !expectGone.some((x) => keptIds.includes(x))
    && keptIds.includes('old-sold') && keptIds.includes('old-44') && !keptIds.includes('old-0'), `${endedRows.length} ended, ${pruned} pruned`);
  const recentEnd = (await server.db.query("SELECT count(*)::int AS n FROM p2p_listings WHERE status IN ('cancelled', 'removed') AND updated > $1", [Date.now() - 3600e3])).rows[0].n;
  await server.srv.p2p.prune();
  check('pruning: nothing recent goes', (await server.db.query("SELECT count(*)::int AS n FROM p2p_listings WHERE status IN ('cancelled', 'removed') AND updated > $1", [Date.now() - 3600e3])).rows[0].n === recentEnd);

  // ---- the server's searches stay quick, and their memory bounded -----------------------------------------------------------------
  resetLimits();
  const lag = [];
  let worst = 0, lastTick = performance.now();
  const tick = setInterval(() => { const t = performance.now(); worst = Math.max(worst, t - lastTick - 5); lastTick = t; }, 5); // (how late a 5 ms timer fires)
  for (let k = 0; k < 12; k++) { if (k % 6 === 5) resetLimits(); const t = performance.now(); await watcher.p2p('catalog', { sort: ['listed', 'plow', 'phigh', 'name'][k % 4], pmin: k / 100 }); lag.push(performance.now() - t); }
  clearInterval(tick);
  check('All items: a new search each time (every item in the game) keeps the server\'s thread free (no long stall)', worst < 120, `worst stall ${worst.toFixed(0)} ms`);
  for (let k = 0; k < 30; k++) { if (k % 6 === 5) resetLimits(); await watcher.p2p('catalog', { pmin: 1 + k / 100 }); }
  check('the searches kept: at most 400,000 rows in all', server.srv.p2p.cacheRows <= 400000 && [...server.srv.p2p.cache.values()].reduce((s, v) => s + v.length, 0) === server.srv.p2p.cacheRows, String(server.srv.p2p.cacheRows));
  for (const c of [boss2, watcher, old2]) await c.close().catch(() => {});

  // ---- money adds up over everything above ------------------------------------------------------------------------------------
  await server.store.flush();
  const { rows: sold } = await server.db.query("SELECT seller_id, buyer_id, price, fee FROM p2p_listings WHERE status = 'sold'");
  check('every sale: the fee is none, and each sold row has a buyer', sold.length > 0 && sold.every((r) => Number(r.fee) === 0 && r.buyer_id != null));
  const dup = (await server.db.query("SELECT uid, count(*)::int AS n FROM p2p_listings WHERE status = 'open' GROUP BY uid HAVING count(*) > 1")).rows;
  check('no item is in two open listings', dup.length === 0);

  // ---- a network ban (last: every account here plays from one network) --------------------------------------------------------------
  // The banned account's listings come down, and so do those of the other accounts it blocks: the ones it throws off and those
  // whose last network it is (not staff's). A listing put up some other way by one of those isn't sold either.
  resetLimits();
  const nbItems = [mkSkin(500), mkSkin(501), mkSkin(502)];
  await setUp(id.cal, { items: [nbItems[0]] });
  await setUp(id.old, { items: [nbItems[1]] });
  await setUp(id.Boss, { items: [nbItems[2]] });
  const calC = await client(tok.cal), oldC = await client(tok.old, ['lean1']), bossC = await client(tok.Boss);
  const nl = await calC.p2p('list', { uid: nbItems[0].uid, price: round2(I.itemValue(nbItems[0]) * 1.1) });
  const ol = (await server.srv.p2p.list({ id: id.old, name: 'old' }, { uid: nbItems[1].uid, price: round2(I.itemValue(nbItems[1]) * 1.1) })).r; // (old: away, last on this network)
  const bl2 = await bossC.p2p('list', { uid: nbItems[2].uid, price: round2(I.itemValue(nbItems[2]) * 1.1) });
  await oldC.close();
  await wait(50);
  await server.admin.exec({ id: null, name: 'Console', discordId: null, level: 3 }, 'ban', { id: id.dee, reason: 'evading', minutes: 600, network: true });
  await wait(200);
  const nbAudit = json((await server.db.query("SELECT detail FROM audit WHERE action = 'ban' ORDER BY id DESC LIMIT 1")).rows[0].detail);
  check('network ban: the listings of the accounts it blocks come down (thrown off, or last on that network), the items home; staff\'s stay',
    (await rowOf(nl.lid)).status === 'removed' && (await rowOf(ol.lid)).status === 'removed' && (await rowOf(bl2.lid)).status === 'open'
    && (await memState(id.cal)).inv.some((i) => i.uid === nbItems[0].uid) && (await memState(id.old)).inv.some((i) => i.uid === nbItems[1].uid) && nbAudit.networkListings >= 2
    && !server.srv.p2p.sellerLids(id.sam).length,
    `${(await rowOf(nl.lid)).status} ${(await rowOf(ol.lid)).status} ${(await rowOf(bl2.lid)).status} ${JSON.stringify(nbAudit)}`);
  resetLimits();
  const sneak = (await server.srv.p2p.list({ id: id.old, name: 'old' }, { uid: nbItems[1].uid, price: round2(I.itemValue(nbItems[1]) * 1.1) })).r;
  const oldMoney = (await memState(id.old)).money;
  const sneakBuy = await refused(server.srv.p2p.buy({ id: id.sam, name: 'sam' }, { lid: sneak.lid, price: sneak.price }));
  check('network ban: a seller whose last network is blocked sells nothing (the listing comes down, nobody paid)', sneakBuy?.code === 'gone' && (await rowOf(sneak.lid)).status === 'removed'
    && (await memState(id.old)).money === oldMoney && await copies(nbItems[1].uid) === 1);
  // (the ban threw every other account on this network off: only what's still open is closed)
  for (const c of [calC, bossC, bea, sam]) if (c.ws.readyState === WebSocket.OPEN) await c.close().catch(() => {});
} catch (e) {
  failed++;
  console.log('FAIL  (threw)', e?.stack || e);
} finally {
  await server.close().catch(() => {});
  fs.rmSync(DIR, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
