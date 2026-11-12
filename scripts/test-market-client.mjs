// The game's side of the Market (src/js/p2pmarket.js, src/js/net/online.js): the hello's p2p1, the Market page's watch sent
// only to a server that named p2p1 (never to an older one), its pushes, its requests online and their changes taken into the
// state, a server without the Market seen as such, and offline the traders' listings and your own through the save's actions;
// net worth counting what you've listed. The real modules and game data against a stand-in WebSocket: nothing goes on the
// network, and the page's globals are stand-ins.
//   node scripts/test-market-client.mjs
import fs from 'node:fs';
const ls = new Map([['cs2sim-online', JSON.stringify({ token: 'tok' })]]);
globalThis.localStorage = { getItem: (k) => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) };
globalThis.window = {};
globalThis.document = { body: { classList: { toggle() {}, add() {}, remove() {} } }, querySelector: () => null };
const sockets = [];
class FakeSocket {
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { if (this.readyState === 3) return; this.readyState = 3; setTimeout(() => this.onclose?.(), 0); }
  open() { this.readyState = 1; this.onopen?.(); }
  deliver(m) { this.onmessage?.({ data: JSON.stringify(m) }); }
  subs() { return this.sent.filter((m) => m.t === 'sub'); }
  rpcs(ns) { return this.sent.filter((m) => m.t === 'rpc' && (!ns || m.ns === ns)); }
}
globalThis.WebSocket = FakeSocket;
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });

const state = await import('../src/js/state.js');
const { D, initData } = await import('../src/js/data.js');
const { net } = await import('../src/js/net/online.js');
const { act, online } = await import('../src/js/backend.js');
const M = await import('../src/js/p2pmarket.js');
const P = await import('../src/js/engine/p2p.js');
const { makeSkinItem, itemValue } = await import('../src/js/engine/items.js');
const { freshSocial } = await import('../src/js/engine/npcs.js');
const stored = await import('../src/js/stored.js');
const { round2 } = await import('../src/js/engine/util.js');
const DATA = new URL('../src/data/', import.meta.url);
initData(JSON.parse(fs.readFileSync(new URL('game-data.json', DATA), 'utf8')), { keys: JSON.parse(fs.readFileSync(new URL('keys.json', DATA), 'utf8')) });
const skinDef = Object.values(D.skins).find((s) => !s.v && s.p?.FT?.[0] > 1 && s.p.FT[0] < 20 && s.mn <= 0.2 && s.mx >= 0.3);

let failed = 0, passed = 0;
const check = (name, ok, info = '') => { ok ? passed++ : failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const settle = () => new Promise((r) => setTimeout(r, 10));
const welcome = (extra = {}) => ({ t: 'welcome', user: { id: 7, name: 'leo' }, state: { money: 500, inv: [] }, pricedAt: D.pricedAt, serverTime: Date.now(),
  players: [], trades: [], market: {}, account: null, motd: '', ...extra });
// Answers the last request of ns 'p2p' (m) with r and d.
const answer = (sock, m, r, d = null, ok = true) => {
  const req = sock.rpcs('p2p').filter((x) => x.m === m).at(-1);
  sock.deliver({ t: 'res', id: req.id, ok, ...(ok ? { r } : { err: r.err, code: r.code }), ...(d ? { d } : {}) });
  return req;
};

try {
  // ---- offline: the traders' listings and your own --------------------------------------------------------------------------------
  state.S.money = 5000;
  state.S.social = freshSocial(99, Date.now());
  const item = { ...makeSkinItem(skinDef, { fl: 0.25, sd: 5 }), at: Date.now() };
  state.S.inv.push(item);
  check('offline: the Market is there', !online() && M.available());
  const page = await M.browse({});
  check('offline: the main page lists the traders\' listings, newest first, a page at a time', page.total > 200 && page.rows.length === P.PAGE_SIZE && page.rows.every((l, i, a) => !i || a[i - 1].at >= l.at) && page.rows[0].seller.npc);
  const r1 = await M.list(item, round2(itemValue(item) * 1.1));
  check('offline: listing goes through the save\'s action (out of the inventory, into your listings)', !state.S.inv.some((i) => i.uid === item.uid) && M.myListings()[0]?.lid === r1.lid && M.isMine(M.myListings()[0]));
  const again = await M.browse({ text: skinDef.n.split(' | ')[1] });
  check('offline: your listing shows among the traders\'', again.rows.some((l) => l.lid === r1.lid && M.isMine(l)));
  check('net worth counts what you\'ve listed', Math.abs(stored.ownedWorth() - itemValue(state.S.listed[0])) < 0.011);
  const cat = await M.catalog({ text: skinDef.n });
  check('offline: All items finds every version of it, with your listing counted', cat.rows.some((x) => x.key === P.catalogKey(item) && x.n >= 1) && cat.total >= 2);
  const low = await M.lowest(P.catalogKey(item));
  check('offline: the cheapest listing of an item, for the selling window', low.n >= 1 && low.min > 0);
  const buyable = page.rows.find((l) => !M.isMine(l) && l.price < 1000);
  const bought = await M.buy(buyable);
  check('offline: buying from a trader', state.S.inv[0].uid === bought.item.uid && state.S.p2p.log[0].kind === 'bought');
  await M.cancel(r1.lid);
  check('offline: cancelling brings it back', state.S.inv.some((i) => i.uid === item.uid) && !M.myListings().length);
  const recent = await M.recent();
  check('offline: recent activity is the save\'s record', recent[0]?.kind === 'bought' && recent[0].who === buyable.seller.name);
  // The page's watch offline: what changed, worked out against what it had (as the server's pushes), not "draw it all again".
  const changes = [];
  const stop = M.watch((ch) => changes.push(ch));
  await M.browse({}); // (the listings it measures changes against: worked out once for both)
  await settle();
  const relist = await act('p2p.list', { uid: item.uid, price: round2(itemValue(item) * 1.2) });
  for (let k = 0; k < 300 && !changes.length; k++) await settle();
  check('offline: the page hears of your listings changing as changes (your new listing added, nothing else)',
    changes.length === 1 && changes[0].add.length === 1 && changes[0].add[0].lid === relist.lid && !changes[0].del.length && !changes[0].upd.length && !changes[0].refresh);
  const other = (await M.browse({ sort: 'plow' })).rows.find((l) => !M.isMine(l) && l.price < 500);
  changes.length = 0;
  await M.buy(other);
  for (let k = 0; k < 300 && !changes.length; k++) await settle();
  check('offline: a trader\'s listing you bought is told as gone (del)', changes.some((c) => c.del.includes(other.lid)) && !changes.some((c) => c.add.some((l) => l.lid === other.lid)));
  stop();
  changes.length = 0;
  await act('p2p.cancel', { lid: relist.lid });
  await act('p2p.list', { uid: item.uid, price: round2(itemValue(item) * 1.2) });
  for (let k = 0; k < 30; k++) await settle();
  check('offline: a stopped watch hears nothing more', !changes.length);
  const offList = state.S.listed.slice();

  // ---- online: the hello, the welcome, the watch ----------------------------------------------------------------------------------
  net.resume();
  await settle();
  let sock = sockets.at(-1);
  sock.open();
  check('the hello announces p2p1 (with lean1, and face1)', JSON.stringify(sock.sent[0].caps) === '["lean1","p2p1","face1"]');
  sock.deliver(welcome({ caps: ['lean1'] }));
  await settle();
  check('a server whose welcome doesn\'t name p2p1: no Market', online() && !net.hasMarket() && !M.available());
  let unwatch = net.watch('p2p');
  await settle();
  check('and nothing is sent to it when the Market page opens', !sock.subs().length);
  unwatch();
  await settle();
  check('online: your offline listings are the offline save\'s, not the account\'s', !M.myListings().length);
  // A server with the Market.
  sock.close();
  await new Promise((r) => setTimeout(r, 1100));
  sock = sockets.at(-1);
  sock.open();
  sock.deliver(welcome({ caps: ['lean1', 'p2p1'], state: { money: 500, inv: [{ ...item, uid: 'on1' }] } }));
  await settle();
  check('a server naming p2p1: the Market is there', net.hasMarket() && M.available());
  const pushes = [];
  unwatch = M.watch((ch) => pushes.push(ch));
  await settle();
  check('the Market page opening says so ({ t: \'sub\', p2p: true })', JSON.stringify(sock.subs()) === '[{"t":"sub","p2p":true}]');
  const listing = { lid: 'L1', item: { ...item, uid: 'x1' }, price: 9, at: Date.now(), seller: { id: 3, name: 'olga' } };
  sock.deliver({ t: 'p2p.d', add: [listing], del: ['L0'], upd: [{ lid: 'L2', price: 4 }] });
  check('a push is handed to the page', pushes.length === 1 && pushes[0].add[0].lid === 'L1' && pushes[0].del[0] === 'L0' && pushes[0].upd[0].price === 4);
  check('the Market open as far as the game knows', !M.isClosed());
  sock.deliver({ t: 'p2p.d', open: false });
  check('the admin panel closing it is pushed: the page is told, and the game knows it\'s closed', pushes.length === 2 && pushes[1].open === false && M.isClosed());
  unwatch();
  await settle();
  check('and its closing says so too', JSON.stringify(sock.subs().at(-1)) === '{"t":"sub","p2p":false}');

  // ---- online: requests ----------------------------------------------------------------------------------------------------------
  const pb = M.browse({ sort: 'plow', page: 2 });
  const req = answer(sock, 'browse', { rows: [listing], total: 1, page: 0, pages: 1, open: true });
  const got = await pb;
  check('browse goes to the server (ns p2p) and comes back as it was sent', req.ns === 'p2p' && req.args.sort === 'plow' && req.args.page === 2 && got.rows[0].lid === 'L1' && got.rows[0].item.uid === 'x1');
  check('an answer saying the Market is open again: the game knows', !M.isClosed());
  const pl = M.list(state.S.inv[0], 12);
  const own = { ...state.S.inv[0], lid: 'M1', lp: 12, lat: Date.now() };
  answer(sock, 'list', { lid: 'M1', price: 12 }, { set: { listed: [own] }, add: [], del: ['on1'], upd: [] });
  await pl;
  check('list: the answer\'s changes are taken (out of the inventory, into your listings)', !state.S.inv.length && state.S.listed[0].lid === 'M1' && M.myListings()[0].seller.me);
  check('online: your listing is yours by your id too', M.isMine({ seller: { id: 7 } }) && !M.isMine({ seller: { id: 3 } }));
  const pf = M.buy(listing);
  answer(sock, 'buy', { err: 'The price changed to $10.00', code: 'price' }, null, false);
  let err = null;
  try { await pf; } catch (e) { err = e; }
  check('a refused buy comes back with its reason and code', err?.code === 'price' && /price changed/.test(err.message));
  const pb2 = M.buy(listing);
  const breq = sock.rpcs('p2p').at(-1);
  sock.deliver({ t: 'res', id: breq.id, ok: true, r: { item: listing.item, price: 9 }, d: { set: { money: 491 }, add: [{ ...listing.item, nw: true }], del: [], upd: [] } });
  await pb2;
  check('buy: sends the price you saw, and the item and money come with the answer', breq.args.lid === 'L1' && breq.args.price === 9 && state.S.money === 491 && state.S.inv[0].uid === 'x1');
  sock.deliver({ t: 'delta', d: { set: { money: 503, listed: [] }, add: [], del: [], upd: [] }, note: 'Your <b>x</b> sold on the Market for <b>$12.00</b>' });
  check('a sale of yours (pushed): paid, the listing gone from your state', state.S.money === 503 && !M.myListings().length);
  const pr = M.recent();
  answer(sock, 'mine', { recent: [{ lid: 'M1', kind: 'sold', item: own, price: 12, got: 12, who: 'olga', at: Date.now() }] });
  check('recent activity online is the server\'s', (await pr)[0].who === 'olga');

  // ---- back offline: the save as it was ---------------------------------------------------------------------------------------------
  net.logout();
  await settle();
  check('logged out: the offline save\'s listings are back, as they were', !online() && JSON.stringify(state.S.listed) === JSON.stringify(offList));
} catch (e) {
  failed++;
  console.log('FAIL  (threw)', e?.stack || e);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
