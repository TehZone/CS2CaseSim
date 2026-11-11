// The game's side of the lean1 capability and its other bandwidth changes (src/js/net/online.js): the hello's caps, the
// players list and trade offers kept from changes, the Gamble page's lobbies asked for while it's open, a server without
// lean1 treated as before, and no /health keep-alive. Then case.open's buy offline (the engine's action, against the three
// requests it replaces, and its maxCost), lean1's answers and changes as the game takes them in (state.js applyDelta,
// relink; a closed trade offer as its status only, an older copy of an offer left out), Storage Units known by their sums
// (merged as they change) and asked for one at a time, again after a reconnect (stored.js loadUnit, unitWatch), the kept
// price patch, the pages' requests asked for calmly (state.js calmly, floatranks.js), and the cases cases.js counts as yours
// (not one in your own open trade offer). The real modules, with the real state and game data, against a stand-in
// WebSocket: nothing goes on the network, and the page's globals are stand-ins.
//   node scripts/test-online-client.mjs
import fs from 'node:fs';
const ls = new Map([['cs2sim-online', JSON.stringify({ token: 'tok' })]]); // (a saved login)
globalThis.localStorage = { getItem: (k) => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) };
globalThis.window = {};
globalThis.document = { body: { classList: { toggle() {}, add() {}, remove() {} } } };

// The server's side of the connection: the test says when it opens, fails, and what it sends.
const sockets = [];
class FakeSocket {
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { if (this.readyState === 3) return; this.readyState = 3; setTimeout(() => this.onclose?.(), 0); }
  open() { this.readyState = 1; this.onopen?.(); }
  fail() { this.readyState = 3; this.onclose?.(); }
  deliver(m) { this.onmessage?.({ data: JSON.stringify(m) }); }
  subs() { return this.sent.filter((m) => m.t === 'sub'); }
}
globalThis.WebSocket = FakeSocket;
const fetched = [];
const serve = { prices: {} }; // (what /api/prices answers)
globalThis.fetch = async (url) => { fetched.push(String(url)); return { ok: true, json: async () => (/\/api\/prices$/.test(String(url)) ? structuredClone(serve.prices) : {}) }; };
// The clock, which the test can move on (skew).
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;
const intervals = [];
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms) => { intervals.push(ms); return realSetInterval(fn, 1e9); };

const state = await import('../src/js/state.js');
const { D, initData, keyFor } = await import('../src/js/data.js');
const { net, relink } = await import('../src/js/net/online.js');
const { act, can } = await import('../src/js/backend.js');
const stored = await import('../src/js/stored.js');
const floatranks = await import('../src/js/floatranks.js');
const cases = await import('../src/js/pages/cases.js'); // (its ownedCases: what it counts as yours to open)
const E = await import('../src/js/engine/economy.js');
const { makeCtx, runAction, delta } = await import('../src/js/engine/actions.js');
const { makeSkinItem, itemValue, UNIT_ID } = await import('../src/js/engine/items.js');
const { ownedValue } = await import('../src/js/engine/storage.js');
const { round2, seededRng } = await import('../src/js/engine/util.js');
const DATA = new URL('../src/data/', import.meta.url);
initData(JSON.parse(fs.readFileSync(new URL('game-data.json', DATA), 'utf8')), { keys: JSON.parse(fs.readFileSync(new URL('keys.json', DATA), 'utf8')) });
const skinDef = Object.values(D.skins).find((s) => !s.v && s.p?.FT?.[0] > 1 && s.mn <= 0.2 && s.mx >= 0.2);
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

let failed = 0, passed = 0;
const check = (name, ok, info = '') => { ok ? passed++ : failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const settle = () => new Promise((r) => setTimeout(r, 10));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const heard = { players: 0, trades: 0, lobbies: 0 };
for (const k of Object.keys(heard)) net.on(k, () => heard[k]++);
const welcome = (extra = {}) => ({ t: 'welcome', user: { id: 1, name: 'leo' }, state: { money: 5 }, pricedAt: D.pricedAt, serverTime: Date.now(),
  players: [{ name: 'leo', online: true, worth: 1 }, { name: 'olga', online: true, worth: 2 }],
  trades: [{ id: 'a', updated: 20, status: 'open' }, { id: 'b', updated: 10, status: 'declined' }], market: {}, account: null, motd: '', ...extra });
// The Gamble page, as main.js draws it: drawn again on every 'reset' (a welcome), watching the lobbies while shown.
let unwatch = null;
const gamblePage = { open() { unwatch = net.watch('lobbies'); }, close() { unwatch?.(); unwatch = null; } };
state.on('reset', () => { if (unwatch) { gamblePage.close(); gamblePage.open(); } });

try {
  // ---- case.open's buy, offline: the engine's own action (the one the server runs), against case.buy, key.buy, case.open --
  const C = D.cases.find((c) => c.kind === 'case' && keyFor(c) && c.price > 0), K = keyFor(C);
  const NOKEY = D.cases.find((c) => !keyFor(c) && c.price > 0 && c.price < 100);
  const fresh = () => { const st = E.freshState(Date.UTC(2026, 0, 1)); st.money = 1000; return st; };
  const ctxOf = (st, rng) => makeCtx(st, { rng, now: Date.UTC(2026, 0, 2) });
  const strip = (it) => { const { uid: _uid, at: _at, ...rest } = it; return rest; }; // (new uids and times: everything else is the rolls')
  const a = fresh(), b = fresh(), ra = seededRng('the same rolls'), rb = seededRng('the same rolls');
  const boughtCase = runAction(ctxOf(a, ra), 'case.buy', { id: C.id, n: 3 }), boughtKey = runAction(ctxOf(a, ra), 'key.buy', { key: K, n: 3 });
  const three = runAction(ctxOf(a, ra), 'case.open', { id: C.id, n: 3 });
  const ctxB = ctxOf(b, rb), oneGo = runAction(ctxB, 'case.open', { id: C.id, n: 3, buy: true });
  check('offline: case.open with buy ends where case.buy, key.buy and case.open do: money, stats, stars, the Index, the drops',
    a.money === b.money && canon(a.stats) === canon(b.stats) && a.stars === b.stars && a.starSpend === b.starSpend && canon(a.index) === canon(b.index) && canon(a.serials) === canon(b.serials)
    && canon(a.inv.map(strip)) === canon(b.inv.map(strip)) && canon(three.items.map(strip)) === canon(oneGo.items.map(strip)) && b.inv.length === 3, `${a.money} / ${b.money}`);
  check('offline: what it bought, as the two would have said it', same(oneGo.bought, { cases: 3, keys: 3, cost: round2(boughtCase.cost + boughtKey.cost), stars: boughtCase.stars + boughtKey.stars }));
  const dB = delta(ctxB);
  check('offline: its changes never had the bought cases and keys (nothing added, nothing removed)', dB.del.length === 0 && dB.add.every((it) => it.t !== 'crate' && it.t !== 'key') && dB.add.length === 3);
  // Some of them already: it buys only the rest, and opens the oldest it has first.
  const c2 = fresh();
  runAction(ctxOf(c2), 'case.buy', { id: C.id, n: 1 });
  runAction(ctxOf(c2), 'key.buy', { key: K, n: 3 });
  const mixed = runAction(ctxOf(c2), 'case.open', { id: C.id, n: 3, buy: true });
  check('offline: with 1 case and 3 keys already, it buys 2 cases and nothing else, and uses all of them', mixed.bought?.cases === 2 && mixed.bought.keys === 0 && !c2.inv.some((it) => it.t === 'crate' || it.t === 'key'));
  const c3 = fresh();
  runAction(ctxOf(c3), 'case.buy', { id: C.id, n: 2 });
  runAction(ctxOf(c3), 'key.buy', { key: K, n: 2 });
  const enough = runAction(ctxOf(c3), 'case.open', { id: C.id, n: 2, buy: true });
  check('offline: with everything already, it buys nothing (no bought in the answer)', !('bought' in enough) && enough.items.length === 2);
  const nk = fresh(), nkR = runAction(ctxOf(nk), 'case.open', { id: NOKEY.id, n: 2, buy: true });
  check('offline: a case that takes no key: only the cases', nkR.bought?.cases === 2 && nkR.bought.keys === 0 && nkR.bought.cost === round2(NOKEY.price * 2));
  const poor = fresh();
  poor.money = 1;
  const before = canon(poor);
  let refused = null;
  try { runAction(ctxOf(poor), 'case.open', { id: C.id, n: 3, buy: true }); } catch (e) { refused = e; }
  check('offline: not enough money for what it would buy: refused, and nothing changed', refused?.code === 'funds' && canon(poor) === before);
  // maxCost: what the game expects buying to cost. More is refused before anything is paid; that much or more goes ahead.
  const capped = fresh(), cappedWas = canon(capped), need = round2(round2(C.price * 2) + round2(D.keyPrice * 2));
  let tooDear = null;
  try { runAction(ctxOf(capped), 'case.open', { id: C.id, n: 2, buy: true, maxCost: round2(need - 0.01) }); } catch (e) { tooDear = e; }
  check('offline: buy costing more than maxCost: refused (price), and nothing changed', tooDear?.code === 'price' && canon(capped) === cappedWas, tooDear?.message);
  const atCap = runAction(ctxOf(capped), 'case.open', { id: C.id, n: 2, buy: true, maxCost: need });
  check('offline: buy costing maxCost exactly: bought and opened', atCap.bought?.cost === need && atCap.items.length === 2);
  const picked = fresh();
  runAction(ctxOf(picked), 'case.buy', { id: C.id, n: 1 });
  let noKey = null;
  try { runAction(ctxOf(picked), 'case.open', { id: C.id, uids: [picked.inv[0].uid], buy: true }); } catch (e) { noKey = e; }
  check('offline: buy is for your oldest only: picked cases open with keys you have', noKey?.code === 'nokey');
  let withoutBuy = null;
  try { runAction(ctxOf(fresh()), 'case.open', { id: C.id, n: 1 }); } catch (e) { withoutBuy = e; }
  check('offline: without buy, as before: no case, no opening', withoutBuy?.code === 'nocase');
  // Through the game's backend, offline (as cases.js does it).
  state.S.money = 1000;
  const viaGame = await act('case.open', { id: C.id, n: 2, buy: true });
  check('offline, through the game: one action buys and opens, and the save has the drops and none of the cases', can('buyOpen') && viaGame.bought?.cases === 2 && viaGame.items.length === 2
    && Math.abs(state.S.money - (1000 - viaGame.bought.cost)) < 0.005 && !state.S.inv.some((it) => it.t === 'crate' || it.t === 'key') && viaGame.items.every((it) => state.S.inv.includes(it)));
  check('offline: the Storage Unit helpers are engine/storage.js\'s (no sums offline)', !state.storedPart() && stored.unitLoaded('anything') && stored.ownedWorth() === ownedValue(state.S) && stored.storedTotals().n === 0);

  // ---- a server without lean1 (an older one): everything as before ---------------------------------------------------------
  net.resume();
  await settle();
  let sock = sockets.at(-1);
  sock.open();
  const hello = sock.sent[0];
  check('the hello announces lean1 (and the Market\'s p2p1)', hello?.t === 'hello' && same(hello.caps, ['lean1', 'p2p1']) && hello.v === 1 && hello.token === 'tok', JSON.stringify(hello));
  gamblePage.open();
  sock.deliver(welcome({ lobbies: { battles: [], flips: [{ id: 'f' }], jackpot: null } }));
  await settle();
  check('a welcome without caps: not lean, and the welcome\'s lobbies are kept', net.status() === 'online' && !net.lean() && net.lobbies().flips[0]?.id === 'f');
  check('and the Gamble page asks for nothing (that server sends the lobbies anyway)', sock.subs().length === 0);
  sock.deliver({ t: 'players', players: [{ name: 'x', online: true, worth: 0 }] });
  sock.deliver({ t: 'trades', trades: [{ id: 'z', updated: 1 }] });
  check('whole lists replace the lists, as before', net.players().length === 1 && net.players()[0].name === 'x' && net.trades().length === 1 && net.trades()[0].id === 'z');
  gamblePage.close();
  await settle();
  check('closing the page says nothing either', sock.subs().length === 0);

  // ---- a lean1 server ------------------------------------------------------------------------------------------------------
  sock.fail(); // (the connection drops; the game tries again)
  await settle();
  await new Promise((r) => setTimeout(r, 1100)); // (the first retry is a second later)
  sock = sockets.at(-1);
  sock.open();
  gamblePage.open();
  for (const k of Object.keys(heard)) heard[k] = 0;
  sock.deliver(welcome({ caps: ['lean1'] }));
  await settle();
  check('a welcome with lean1: lean, and the lobbies start empty (they come when asked for)', net.lean() && same(net.lobbies(), { battles: [], flips: [], jackpot: null }) && heard.lobbies >= 1);
  check('the open Gamble page asks for them once, after the welcome (its redraw on the welcome says nothing more)', same(sock.subs(), [{ t: 'sub', lobbies: true }]), JSON.stringify(sock.subs()));
  sock.deliver({ t: 'lobbies', lobbies: { battles: [], flips: [{ id: 'g' }], jackpot: null } });
  check('the lobbies it\'s sent are the page\'s', net.lobbies().flips[0]?.id === 'g');
  // A second page watching, and the page drawn again: nothing to tell.
  const other = net.watch('lobbies');
  gamblePage.close(); gamblePage.open();
  await settle();
  other();
  await settle();
  check('drawn again, or watched twice: nothing more is said, and the lobbies are kept', sock.subs().length === 1 && net.lobbies().flips[0]?.id === 'g');
  gamblePage.close();
  await settle();
  check('the page closes: it says so, and the lobbies (no longer kept up to date) are forgotten', same(sock.subs().at(-1), { t: 'sub', lobbies: false }) && sock.subs().length === 2 && !net.lobbies().flips.length);
  let threw = null;
  try { net.watch('nothing'); } catch (e) { threw = e; }
  check('only what can be watched', !!threw);

  // The players list from changes.
  heard.players = 0;
  sock.deliver({ t: 'players.d', join: [{ name: 'pia', online: true, worth: 0 }] });
  sock.deliver({ t: 'players.d', upd: [{ name: 'olga', online: true, worth: 50 }], leave: ['leo'] });
  sock.deliver({ t: 'players.d', upd: [{ name: 'olgaB', was: 'olga', online: true, worth: 50 }] });
  check('players.d: joins at the end, leaves go, an upd takes its row\'s place (a rename by the name it had)',
    same(net.players(), [{ name: 'olgaB', online: true, worth: 50 }, { name: 'pia', online: true, worth: 0 }]) && heard.players === 3, JSON.stringify(net.players()));
  check('players.d: and the text pages show is up to date', net.onlineText() === 'Online. Players Online: 2');

  // Trade offers from changes. (A whole offer has `give`; a row without it is a closed offer's new status only.)
  heard.trades = 0;
  const offer = (id, extra = {}) => ({ id, status: 'open', version: 1, updated: 30, from: { id: 1, name: 'leo' }, to: { id: 2, name: 'olga' }, give: { items: [], money: 1 }, get: { items: [], money: 0 }, ...extra });
  sock.deliver({ t: 'trades.d', upd: [offer('c')] });
  sock.deliver({ t: 'trades.d', upd: [{ ...offer('b'), updated: 40, status: 'accepted', version: 2 }], del: ['a'] });
  check('trades.d: a new offer on top, a changed one moved up with its new status, del taken out',
    same(net.trades().map((t) => t.id + ':' + t.status), ['b:accepted', 'c:open']) && heard.trades === 2, JSON.stringify(net.trades()));
  const tradeAsks = () => sock.sent.filter((m) => m.t === 'rpc' && m.ns === 'trade' && m.m === 'list');
  sock.deliver({ t: 'trades.d', upd: [{ id: 'c', status: 'declined', version: 2, updated: 50 }] });
  const cNow = net.trades().find((t) => t.id === 'c');
  check('trades.d: a closed offer as its new status only: merged into the copy here (its items and money kept), moved up',
    net.trades()[0].id === 'c' && cNow.status === 'declined' && cNow.version === 2 && cNow.give?.money === 1 && cNow.from?.name === 'leo' && !tradeAsks().length, JSON.stringify(cNow));
  sock.deliver({ t: 'trades.d', upd: [offer('c')] });
  check('trades.d: an older copy of an offer that comes after a newer one is left out (two changes the other way round)', net.trades().find((t) => t.id === 'c').status === 'declined');
  sock.deliver({ t: 'trades.d', upd: [{ id: 'c', status: 'declined', version: 2, updated: 50 }] });
  check('trades.d: the same change twice changes nothing', net.trades().filter((t) => t.id === 'c').length === 1 && net.trades().find((t) => t.id === 'c').give?.money === 1);
  // The new status of an offer this list hasn't got (fallen off the end of it): the list is asked for again.
  sock.deliver({ t: 'trades.d', upd: [{ id: 'old', status: 'cancelled', version: 2, updated: 60 }] });
  await settle();
  check('trades.d: a new status for an offer not here: nothing made up for it, and the list is asked for (once)', !net.trades().some((t) => t.id === 'old') && tradeAsks().length === 1);
  sock.deliver({ t: 'trades.d', upd: [{ id: 'old2', status: 'cancelled', version: 2, updated: 61 }] });
  await settle();
  check('trades.d: (another while it\'s on its way: not asked twice)', tradeAsks().length === 1);
  // (A change that came while the list was on its way is newer than the list's copy of that offer: kept.)
  sock.deliver({ t: 'trades.d', upd: [{ ...offer('n'), updated: 70 }] });
  sock.deliver({ t: 'res', id: tradeAsks()[0].id, ok: true, r: [{ ...offer('old'), status: 'cancelled', version: 2, updated: 60 }, { ...offer('c'), status: 'declined', version: 2, updated: 50 }, { ...offer('n'), updated: 65 }] });
  await settle();
  check('trades: the list asked for replaces it, with a newer copy here kept', same(net.trades().map((t) => t.id + ':' + t.updated), ['n:70', 'old:60', 'c:50']), JSON.stringify(net.trades().map((t) => t.id + ':' + t.updated)));
  sock.deliver({ t: 'trades', trades: [{ id: 'w', updated: 1 }] });
  check('trades: a whole list still replaces it', net.trades().length === 1 && net.trades()[0].id === 'w');

  // A reconnect with the page open asks again: the new connection's server knows nothing of it.
  gamblePage.open();
  await settle();
  check('(open again: it says so)', same(sock.subs().at(-1), { t: 'sub', lobbies: true }) && sock.subs().length === 3);
  sock.fail();
  await new Promise((r) => setTimeout(r, 1200));
  sock = sockets.at(-1);
  sock.open();
  check('connecting: nothing is asked before the welcome', sock.subs().length === 0);
  sock.deliver(welcome({ caps: ['lean1'] }));
  await settle();
  check('a reconnect with the page open asks for the lobbies again', same(sock.subs(), [{ t: 'sub', lobbies: true }]));
  gamblePage.close();
  await settle();

  // ---- actions' answers and changes, lean1's shapes (server/lean.mjs) -------------------------------------------------------
  // A lean1 welcome with Storage Units: their sums, and no contents.
  const unitA = { uid: 'uA', t: 'unit', id: UNIT_ID, name: 'A', at: 1 }, unitB = { uid: 'uB', t: 'unit', id: UNIT_ID, name: 'B', at: 2 };
  const skin = (uid, extra = {}) => ({ ...makeSkinItem(skinDef, { fl: 0.2 }), uid, ...extra });
  const inA = [skin('a1', { su: 'uA', sat: 5 }), skin('a2', { su: 'uA', sat: 6 })], inB = [skin('b1', { su: 'uB', sat: 7 }), skin('b2', { su: 'uB', sat: 8 }), skin('b3', { su: 'uB', sat: 9 })];
  const sumOf = (items) => ({ n: items.length, value: round2(items.reduce((s, it) => s + itemValue(it), 0)), best: items[0] });
  const leanState = { money: 50, inv: [unitA, unitB, skin('i1', { nw: true }), skin('i2', { nw: true })], stats: { opened: 4, spent: 9, sold: 0, drops: { 2: 3, 3: 1 }, bestName: 'x' } };
  sock.deliver(welcome({ caps: ['lean1'], state: leanState, units: { uA: sumOf(inA), uB: sumOf(inB) } }));
  await settle();
  check('a lean1 welcome without stored: the units\' sums are kept, nothing loaded', !!state.storedPart() && !stored.unitLoaded('uA') && stored.unitCount('uB') === 3 && state.S.stored.length === 0);
  check('the totals, net worth and most valuable item come from the sums', stored.storedTotals().n === 5 && stored.storedTotals().value === round2(sumOf(inA).value + sumOf(inB).value)
    && stored.ownedWorth() === round2(itemValue(state.S.inv[2]) + itemValue(state.S.inv[3]) + sumOf(inA).value + sumOf(inB).value) && !!stored.bestOwned());
  // The stats as what changed, merged.
  state.applyDelta({ set: { money: 40 }, stats: { opened: 7, drops: { 3: 2, 5: 1 } } });
  check('d.stats: the fields that changed are merged into the stats, drops by rarity too', state.S.money === 40 && state.S.stats.opened === 7 && state.S.stats.spent === 9 && state.S.stats.bestName === 'x' && state.S.stats.knives === 0 && canon(state.S.stats.drops) === canon({ 2: 3, 3: 2, 5: 1 }), JSON.stringify(state.S.stats));
  state.applyDelta({ set: { stats: { opened: 1, drops: {} } } });
  check('set.stats (an older server, or a push from elsewhere) still replaces them whole', same(state.S.stats, { opened: 1, drops: {} }));
  // item.seen as uids.
  let invHeard = 0;
  const offInv = state.on('inv', () => invHeard++);
  state.applyDelta({ seen: ['i1'] });
  check('d.seen: those items lose their New tag, the others keep theirs, and the inventory is told', !('nw' in state.S.inv.find((i) => i.uid === 'i1')) && state.S.inv.find((i) => i.uid === 'i2').nw === true && invHeard === 1);
  // An answer's items as { uid }: relink makes them whole. (An action through the game's backend, answered as the server would.)
  const answered = async (name, args, reply) => {
    const p = act(name, args);
    await settle();
    const q = sock.sent.findLast((m) => m.t === 'rpc' && m.ns === 'act' && m.m === name);
    sock.deliver({ t: 'res', id: q.id, ok: true, ...reply });
    return p;
  };
  const res = await answered('case.open', { id: 'x', n: 2, buy: true }, { r: { items: [{ uid: 'n1' }, skin('sold1', { as: true })], autoSold: 1 }, d: { add: [skin('n1', { nw: true })], set: { money: 30 } } });
  check('relink: an item sent as { uid } is the one d.add put in the inventory; an auto-sold one stays as it came', res.items[0] === state.S.inv.find((i) => i.uid === 'n1') && res.items[0].t === 'skin' && res.items[1].as === true && res.items[1].uid === 'sold1');
  const upd = skin('zz', { name: 'renamed' });
  const fallback = relink({ item: { uid: 'zz' } }, { upd: [upd] });
  check('relink: one the inventory doesn\'t have is the changes\' own copy', fallback.item === upd);
  // Storage Units: changes for a unit that isn't here change only its sums; for one that is, its contents.
  state.applyDelta({ sto: { add: [skin('b4', { su: 'uB', sat: 10 })], del: [] }, units: { uA: sumOf(inA), uB: { n: 4, value: 4, best: null } } });
  check('a deposit into a unit not asked for: its contents stay unknown, its count and value are the new sums', !state.S.stored.length && stored.unitCount('uB') === 4 && stored.unitValue('uB') === 4 && invHeard >= 2);
  // Only the units that changed, merged: a row without best keeps the one it had; null is a unit that's gone.
  const topB = skin('b9');
  state.applyDelta({ sto: { add: [], del: [] }, units: { uB: { n: 4, value: 4, best: topB } } });
  state.applyDelta({ sto: { add: [], del: [] }, units: { uB: { n: 5, value: 7 }, uZ: { n: 1, value: 1, best: null } } });
  const rowB = state.storedPart().sums.get('uB');
  check('d.units: merged: the units in it change (best kept when it isn\'t sent), the others don\'t', rowB.n === 5 && rowB.value === 7 && rowB.best === topB && stored.unitCount('uA') === 2 && state.storedPart().sums.has('uZ'));
  state.applyDelta({ sto: { add: [], del: [] }, units: { uZ: null, uB: { n: 4, value: 4, best: null } } });
  check('d.units: a unit as null is gone from the sums; best: null is a unit with nothing in it', !state.storedPart().sums.has('uZ') && state.storedPart().sums.get('uB').best === null && stored.unitCount('uB') === 4);
  // Asking for one: the request, the answer.
  const ask = stored.loadUnit('uA');
  check('loadUnit: asked for once however many ask', stored.loadUnit('uA') === ask);
  await settle();
  const req = sock.sent.findLast((m) => m.t === 'rpc' && m.m === 'stored');
  check('loadUnit: social stored for that unit', req?.ns === 'social' && same(req.args, { unit: 'uA' }));
  sock.deliver({ t: 'res', id: req.id, ok: true, r: { unit: 'uA', items: inA, sum: sumOf(inA) } });
  check('loadUnit: the unit\'s contents are here, and it counts them', (await ask) === true && stored.unitLoaded('uA') && stored.unitContents('uA').length === 2 && stored.unitCount('uA') === 2 && !stored.unitLoaded('uB'));
  state.applyDelta({ sto: { add: [skin('a3', { su: 'uA', sat: 11 })], del: ['a1'] }, units: { uA: { n: 2, value: 0, best: null }, uB: { n: 4, value: 4, best: null } } });
  check('a change to a unit that\'s here: its contents follow it, and it counts them (not the sums)', same(stored.unitContents('uA').map((i) => i.uid).sort(), ['a2', 'a3']) && stored.unitValue('uA') > 0);
  state.applyDelta({ sto: { add: [skin('a3', { su: 'uA', sat: 11 })], del: ['a1'] } });
  check('the same change twice (it can come two ways): each item once', stored.unitContents('uA').length === 2);
  const most = stored.bestOwned();
  check('the most valuable item: of the inventory, the units here and the others\' best', [...state.S.inv, ...state.S.stored].every((it) => itemValue(it) <= itemValue(most)));
  // A unit bought since the welcome is new, so empty: nothing to ask for.
  state.applyDelta({ add: [{ uid: 'uC', t: 'unit', id: UNIT_ID, at: 3 }] });
  const asks = () => sock.sent.filter((m) => m.m === 'stored').length, asked = asks();
  check('a unit that comes in d.add (bought) is known to be empty: nothing to ask for', stored.unitLoaded('uC') && stored.unitCount('uC') === 0 && (await stored.loadUnit('uC')) === true && asks() === asked);
  // A reply from before a new welcome is for a state that's gone.
  const late = stored.loadUnit('uB');
  await settle();
  const lateReq = sock.sent.findLast((m) => m.t === 'rpc' && m.m === 'stored');
  sock.deliver(welcome({ caps: ['lean1'], state: leanState, units: { uA: sumOf(inA), uB: sumOf(inB) } }));
  await settle();
  sock.deliver({ t: 'res', id: lateReq.id, ok: true, r: { unit: 'uB', items: inB, sum: sumOf(inB) } });
  await late;
  check('a unit\'s contents asked for before a new welcome are dropped (it\'s asked for again when it\'s needed)', asks() === asked + 1 && !stored.unitLoaded('uB') && !state.S.stored.length);
  // The Storage Unit window (pages/storage.js) through unitWatch: asked for as it's shown, and again after a reconnect.
  let drawn = 0;
  const lastAsk = () => sock.sent.findLast((m) => m.t === 'rpc' && m.m === 'stored');
  const wA = stored.unitWatch('uA', () => drawn++), a0 = asks();
  check('unitWatch: a unit not here: loading, asked for once however often the window draws', wA.status() === 'loading' && wA.status() === 'loading' && asks() === a0 + 1 && same(lastAsk().args, { unit: 'uA' }));
  const askA = lastAsk();
  sock.deliver({ t: 'res', id: askA.id, ok: true, r: { unit: 'uA', items: inA, sum: sumOf(inA) } });
  await settle();
  check('unitWatch: it comes: the window is drawn again, and they\'re here', drawn === 1 && wA.status() === 'here' && stored.unitContents('uA').length === 2);
  // A reconnect (every deploy restarts the server): the new welcome forgets what was loaded, and the open window asks again.
  sock.deliver(welcome({ caps: ['lean1'], state: leanState, units: { uA: sumOf(inA), uB: sumOf(inB) } }));
  await settle();
  check('unitWatch: after a new welcome, the open window asks for them again by itself', wA.status() === 'loading' && asks() === a0 + 2 && lastAsk().id !== askA.id);
  sock.deliver({ t: 'res', id: lastAsk().id, ok: true, r: { unit: 'uA', items: inA, sum: sumOf(inA) } });
  await settle();
  check('unitWatch: and has them', wA.status() === 'here' && drawn === 2);
  // A reply meant for the connection before: it doesn't count, and the window asks the new one.
  const wB = stored.unitWatch('uB', () => drawn++);
  wB.status();
  const askB = lastAsk(), b0 = asks();
  sock.deliver(welcome({ caps: ['lean1'], state: leanState, units: { uA: sumOf(inA), uB: sumOf(inB) } }));
  await settle();
  sock.deliver({ t: 'res', id: askB.id, ok: true, r: { unit: 'uB', items: inB, sum: sumOf(inB) } });
  await settle();
  check('unitWatch: a reply from before the reconnect isn\'t taken, and the window asks again', !stored.unitLoaded('uB') && wB.status() === 'loading' && asks() === b0 + 1);
  // Refused: shown as failed (no asking again on every draw) until Try again.
  sock.deliver({ t: 'res', id: lastAsk().id, ok: false, err: 'That Storage Unit is gone', code: 'missing' });
  await settle();
  const b1 = asks();
  check('unitWatch: refused: failed, and drawing again asks nothing', wB.status() === 'failed' && wB.status() === 'failed' && asks() === b1);
  wB.retry();
  check('unitWatch: Try again asks again', wB.status() === 'loading' && asks() === b1 + 1);
  sock.deliver({ t: 'res', id: lastAsk().id, ok: true, r: { unit: 'uB', items: inB, sum: sumOf(inB) } });
  await settle();
  check('unitWatch: and has them', wB.status() === 'here' && stored.unitContents('uB').length === 3);
  // The whole of it (staff restoring a save): everything's known.
  state.applyDelta({ set: { stored: [...inA, ...inB] } });
  check('set.stored: all of it is here, as offline', !state.storedPart() && stored.unitLoaded('uB') && stored.unitCount('uB') === 3);
  offInv();

  // ---- what the backend can do: case.open's buy only on a lean1 server -----------------------------------------------------
  check('online with lean1: case.open\'s buy is used', can('buyOpen'));
  sock.deliver(welcome({}));
  await settle();
  check('online with a server without lean1: not (that server would refuse an opening it\'s short for), and no sums', !can('buyOpen') && !state.storedPart());

  // ---- prices: the last patch is kept, and a welcome with its pricedAt takes it from there ---------------------------------
  const bundled = D.pricedAt, sid = Object.values(D.skins).find((s) => s !== skinDef && s.p).id, bundledP = D.skins[sid].p;
  const patch = (at, p) => ({ generatedAt: D.generatedAt, pricedAt: at, skins: { [sid]: p }, stickers: {}, agents: {}, cases: {} });
  const launch = () => { D.pricedAt = bundled; D.skins[sid].p = bundledP; }; // (a new launch: the build's prices again)
  const pricesFetched = () => fetched.filter((u) => /\/api\/prices$/.test(u)).length;
  ls.delete(state.PRICES_KEY);
  serve.prices = patch('P1', { FN: [111] });
  launch();
  sock.deliver(welcome({ pricedAt: 'P1' }));
  await settle();
  check('prices: the first time, downloaded, used and kept', pricesFetched() === 1 && D.pricedAt === 'P1' && same(D.skins[sid].p, { FN: [111] }) && JSON.parse(ls.get(state.PRICES_KEY)).pricedAt === 'P1');
  launch();
  sock.deliver(welcome({ pricedAt: 'P1' }));
  await settle();
  check('prices: a welcome with the kept pricedAt: not downloaded, taken from what was kept', pricesFetched() === 1 && D.pricedAt === 'P1' && same(D.skins[sid].p, { FN: [111] }));
  serve.prices = patch('P2', { FN: [222] });
  launch();
  sock.deliver(welcome({ pricedAt: 'P2' }));
  await settle();
  check('prices: a newer pricedAt: downloaded, and that one kept instead', pricesFetched() === 2 && same(D.skins[sid].p, { FN: [222] }) && JSON.parse(ls.get(state.PRICES_KEY)).pricedAt === 'P2');
  ls.set(state.PRICES_KEY, '{not json');
  launch();
  sock.deliver(welcome({ pricedAt: 'P2' }));
  await settle();
  check('prices: what was kept is unreadable: downloaded again', pricesFetched() === 3 && same(D.skins[sid].p, { FN: [222] }));
  ls.set(state.PRICES_KEY, JSON.stringify({ ...patch('P2', { FN: [1] }), generatedAt: 'another build' }));
  launch();
  sock.deliver(welcome({ pricedAt: 'P2' }));
  await settle();
  check('prices: kept for another data build: not used', pricesFetched() === 4 && same(D.skins[sid].p, { FN: [222] }));
  const realLs = globalThis.localStorage;
  globalThis.localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  launch();
  sock.deliver(welcome({ pricedAt: 'P2' }));
  await settle();
  globalThis.localStorage = realLs;
  check('prices: no storage at all (it throws): downloaded, and used all the same', pricesFetched() === 5 && D.pricedAt === 'P2' && same(D.skins[sid].p, { FN: [222] }) && net.status() === 'online');
  launch();
  sock.deliver(welcome({}));
  await settle();
  check('prices: a welcome with the build\'s own pricedAt asks for nothing', pricesFetched() === 5);
  // In a browser the save shares that storage, and comes first: one that doesn't fit beside the kept prices pushes them out.
  let saveLen = 0;
  globalThis.localStorage = { getItem: () => null, removeItem() {}, setItem: (k, v) => { if (k === 'cs2-case-sim-save') saveLen = String(v).length; } };
  state.saveNow();
  const tight = new Map([[state.PRICES_KEY, 'x'.repeat(500)]]);
  globalThis.localStorage = { getItem: (k) => tight.get(k) ?? null, removeItem: (k) => tight.delete(k),
    setItem: (k, v) => { const others = [...tight].filter(([key]) => key !== k).reduce((t, [, x]) => t + x.length, 0); if (others + String(v).length > saveLen + 100) throw new Error('quota'); tight.set(k, String(v)); } };
  state.saveNow();
  globalThis.localStorage = realLs;
  check('a save that doesn\'t fit beside the kept prices: they go, and the save is written', saveLen > 0 && tight.get('cs2-case-sim-save')?.length === saveLen && !tight.has(state.PRICES_KEY));

  // ---- asked for calmly (your own profile, the float ranks) ----------------------------------------------------------------
  const runs = [];
  const calm = state.calmly(() => runs.push(Date.now()), 80);
  calm.ask();
  calm.ask();
  check('calmly: asked for: runs at once, and once', runs.length === 1);
  await new Promise((r) => setTimeout(r, 30));
  calm.ask(); calm.ask();
  check('calmly: asked again within the gap: waits', runs.length === 1 && calm.waiting());
  await new Promise((r) => setTimeout(r, 90));
  check('calmly: then runs once, when the gap is over', runs.length === 2 && runs[1] - runs[0] >= 75);
  await new Promise((r) => setTimeout(r, 100));
  state.setAutoOpening(true);
  calm.ask(); calm.ask();
  await new Promise((r) => setTimeout(r, 120));
  check('calmly: not while auto open runs, however long', runs.length === 2 && calm.waiting());
  state.setAutoOpening(false);
  check('calmly: once when it stops', runs.length === 3 && !calm.waiting());
  state.setAutoOpening(true); state.setAutoOpening(false);
  check('calmly: auto open starting and stopping with nothing asked runs nothing', runs.length === 3);
  calm.ask();
  calm.stop();
  await new Promise((r) => setTimeout(r, 100));
  check('calmly: stop() forgets one waiting', runs.length === 3 && !calm.waiting());
  // One whose time comes while auto open runs waits for it to stop.
  calm.ask(); // (the gap is over: at once)
  calm.ask(); // (within it: waits)
  state.setAutoOpening(true);
  await new Promise((r) => setTimeout(r, 120));
  check('calmly: one that was waiting when auto open started doesn\'t run during it', runs.length === 4 && calm.waiting());
  state.setAutoOpening(false);
  check('calmly: it runs when auto open stops', runs.length === 5 && !calm.waiting());

  // The float ranks, online: one request, then at most every RANKS_GAP, none during auto open, once after it.
  sock.deliver(welcome({ caps: ['lean1'], state: { money: 5, inv: [skin('f1'), skin('f2')] } }));
  await settle();
  const rankAsks = () => sock.sent.filter((m) => m.t === 'rpc' && m.m === 'db.ranks');
  const answerRanks = (r) => { const q = rankAsks().at(-1); sock.deliver({ t: 'res', id: q.id, ok: true, r }); };
  let ranksHeard = 0;
  const offRanks = state.on('ranks', () => ranksHeard++);
  const firstRanks = floatranks.refreshRanks();
  await settle();
  check('float ranks: asked for once', rankAsks().length === 1);
  answerRanks({ f1: { low: 1, of: 2, cat: 'n' } });
  check('float ranks: the answer is there', (await firstRanks) === true && floatranks.floatRankOf('f1')?.low === 1);
  state.applyDelta({ add: [skin('f3')] });
  check('float ranks: the inventory changes at once after: not asked again yet', (await floatranks.refreshRanks()) === false && rankAsks().length === 1);
  state.setAutoOpening(true);
  skew += floatranks.RANKS_GAP + 1000;
  state.applyDelta({ add: [skin('f4')] });
  await floatranks.refreshRanks();
  await settle();
  check('float ranks: during auto open, not even when the gap is over', rankAsks().length === 1);
  state.setAutoOpening(false);
  await settle();
  check('float ranks: asked for once when it stops', rankAsks().length === 2);
  answerRanks({ f1: { low: 1, of: 2, cat: 'n' }, f4: { high: 1, of: 3, cat: 'n' } });
  await settle();
  check('float ranks: and the page is told they changed (\'ranks\')', ranksHeard === 1 && floatranks.floatRankOf('f4')?.high === 1);
  offRanks();
  check('the gaps are 10 to 30 seconds', floatranks.RANKS_GAP >= 10000 && floatranks.RANKS_GAP <= 30000);
  // Online the server's ranks cover what's in Storage Units already: a unit's contents arriving asks nothing more.
  skew += floatranks.RANKS_GAP + 1000;
  sock.deliver(welcome({ caps: ['lean1'], state: { money: 5, inv: [unitA, skin('f1'), skin('f2')] }, units: { uA: sumOf(inA) } }));
  await settle();
  const r0 = rankAsks().length, forUnits = floatranks.refreshRanks();
  await settle();
  check('float ranks: a new state (with a unit): asked for', rankAsks().length === r0 + 1);
  answerRanks({});
  await forUnits;
  skew += floatranks.RANKS_GAP + 1000; // (past the gap, and within the 30 seconds an answer is good for)
  state.storedArrived('uA', { items: inA, sum: sumOf(inA) });
  await floatranks.refreshRanks();
  await settle();
  check('float ranks: a unit\'s contents arriving: not asked again', stored.unitLoaded('uA') && rankAsks().length === r0 + 1);
  state.applyDelta({ sto: { add: [], del: ['a1'] }, units: { uA: { n: 1, value: 1 } } });
  const storedChanged = floatranks.refreshRanks();
  await settle();
  check('float ranks: (what\'s stored changing does ask: their count is in what it goes by)', rankAsks().length === r0 + 2);
  answerRanks({});
  await storedChanged;

  // ---- cases.js: the cases and keys it counts as yours are the ones the server will open ------------------------------------
  const crate = (uid, at) => ({ uid, t: 'crate', id: C.id, at }), key = (uid, at) => ({ uid, t: 'key', id: K, at });
  sock.deliver(welcome({ caps: ['lean1'], state: { money: 500, inv: [crate('c1', 1), crate('c2', 2), key('k1', 1), key('k2', 2)] },
    trades: [{ ...offer('mine'), give: { items: [crate('c1', 1)], money: 0 } }, { ...offer('theirs', { from: { id: 2, name: 'olga' }, to: { id: 1, name: 'leo' } }), get: { items: [crate('c2', 2)], money: 0 } }] }));
  await settle();
  check('cases.js: online, a case in an open offer you made isn\'t counted (the server won\'t open it); one an offer to you asks for still is (as the server has it)',
    same(cases.ownedCases(C).map((it) => it.uid), ['c2']) && cases.ownedKeys(C).length === 2);
  sock.deliver({ t: 'trades.d', upd: [{ id: 'mine', status: 'cancelled', version: 2, updated: 99 }] });
  check('cases.js: the offer closed: it counts again', cases.ownedCases(C).length === 2);

  // ---- no keep-alive -------------------------------------------------------------------------------------------------------
  check('no /health keep-alive: nothing fetches it, and nothing is set to every 5 minutes', !fetched.some((u) => /\/health/.test(u)) && !intervals.includes(5 * 60 * 1000), JSON.stringify({ fetched, intervals }));

  net.logout();
  await settle();
  check('logged out: offline, and not lean any more', net.status() === 'offline' && !net.lean());
} catch (e) {
  failed++;
  console.log('FAIL  (threw)', e);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
