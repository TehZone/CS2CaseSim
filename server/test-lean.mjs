// What the server sends, and how small: WebSocket compression (permessage-deflate), /api/prices in brotli or gzip, and the
// lean1 capability (the players list, gamble lobbies and trade offers as changes; actions' answers without the same item
// twice and case.open's buy, with its maxCost; the welcome without what's in Storage Units, and changes with only the
// units' sums that changed and only the stored items a connection has a use for). Each lean1 check has a game beside it that
// announces nothing, as 1.1.2 and older do, which must be sent exactly what it always was. A real server (embedded Postgres
// on disk) and real WebSocket clients; the lean1 clients apply what they get with the game's own functions
// (src/js/net/online.js, and src/js/state.js following one connection, compared with the server's state).
//   node server/test-lean.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import WebSocket from 'ws';

for (const k of ['HOST', 'SERVER_COMMIT', 'RENDER_GIT_COMMIT', 'ADMIN_USERS', 'TRUST_PROXY']) delete process.env[k];
const { startServer, LEAN, CAPS } = await import('./index.mjs');
const { LOBBY_MS, Live } = await import('./live.mjs');
const { D, casePrice, keyFor } = await import('../src/js/engine/data.js');
const { makeStickerItem, itemValue } = await import('../src/js/engine/items.js');
const { ownedItems, ownedValue, contents, unitValue: unitWorth } = await import('../src/js/engine/storage.js');
const { round2 } = await import('../src/js/engine/util.js');
const { playersChanged, tradesChanged, relink } = await import('../src/js/net/online.js');
const lean = await import('./lean.mjs');
// The game's own state (one at a time: it's the module's), with the page's globals it needs. (Not `window` for long: with one,
// the embedded Postgres takes itself for a browser's. Only enterOnline reads it, saving the offline save first.)
globalThis.localStorage ??= (() => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; })();
const state = await import('../src/js/state.js');
const stored = await import('../src/js/stored.js');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cs2sim-test-lean-'));
let failed = 0, passed = 0;
const check = (name, ok, info = '') => { ok ? passed++ : failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const logs = [];
const server = await startServer({ port: 0, db: { dataDir: DIR }, log: (...a) => logs.push(a.join(' ')), priceRefresh: false, discord: false, release: false, admins: ['boss'], trustProxy: 1 });
const base = `http://localhost:${server.port}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// What 1.1.2's src/js/net/online.js takes in: anything else falls through its switch.
const OLD = new Set(['res', 'delta', 'lobbies', 'players', 'trades', 'gamble.result', 'notice', 'market', 'account', 'admin.msg', 'update', 'chat', 'friends']);
const OLD_WELCOME = 'account,lobbies,market,motd,players,pricedAt,serverTime,state,t,trades,user';

let ip = 0;
async function register(name) {
  const r = await fetch(base + '/api/register', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.9.0.${++ip}` }, body: JSON.stringify({ name, password: 'secret123' }) });
  return (await r.json()).token;
}
// A game: its WebSocket, rpc, and the players list, trades and lobbies as the game keeps them. caps: what its hello
// announces (undefined: no caps at all, as 1.1.2). deflate: whether it offers compression (ws offers it, as Chromium does).
async function client(token, { caps, deflate = true } = {}) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { perMessageDeflate: deflate });
  const c = { ws, events: [], pending: new Map(), seq: 0, players: null, trades: null, lobbies: null, wire: 0, raw: 0 };
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  let read0 = ws._socket.bytesRead;
  const welcome = new Promise((res, rej) => {
    ws.on('message', (data) => {
      const text = data.toString(), m = JSON.parse(text);
      // (bytes on the wire for this message, against its text: how much compression saved)
      const read = ws._socket.bytesRead;
      m.wire = read - read0; m.raw = Buffer.byteLength(text);
      read0 = read;
      if (m.t === 'welcome') { c.welcome = m; c.user = m.user; c.players = m.players; c.trades = m.trades; c.lobbies = m.lobbies ?? null; res(m); return; }
      if (m.t === 'fatal') { rej(new Error(m.error)); return; }
      if (!c.welcome) return;
      c.events.push(m);
      c.onEvent?.(m);
      if (m.t === 'players') c.players = m.players;
      if (m.t === 'players.d') c.players = playersChanged(c.players, m);
      if (m.t === 'trades') c.trades = m.trades;
      if (m.t === 'trades.d') c.trades = tradesChanged(c.trades, m);
      if (m.t === 'lobbies') c.lobbies = m.lobbies;
      if (m.t === 'res') { const p = c.pending.get(m.id); c.pending.delete(m.id); m.ok ? p.res(p.whole ? m : m.r) : p.rej(Object.assign(new Error(m.err), { code: m.code })); }
    });
  });
  ws.send(JSON.stringify({ t: 'hello', token, data: D.lock, v: 1, app: '1.1.2', ...(caps !== undefined ? { caps } : {}) }));
  await welcome;
  c.rpc = (ns, m, args) => new Promise((res, rej) => { const id = ++c.seq; c.pending.set(id, { res, rej }); ws.send(JSON.stringify({ t: 'rpc', id, ns, m, args })); });
  c.act = (m, a) => c.rpc('act', m, a);
  // (the whole reply: { r, d, raw, wire })
  c.whole = (ns, m, args) => new Promise((res, rej) => { const id = ++c.seq; c.pending.set(id, { res, rej, whole: true }); ws.send(JSON.stringify({ t: 'rpc', id, ns, m, args })); });
  c.sub = (on) => ws.send(JSON.stringify({ t: 'sub', lobbies: on }));
  c.of = (t) => c.events.filter((e) => e.t === t);
  c.forget = () => { c.events.length = 0; };
  c.waitFor = async (pred, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const e = c.events.find(pred); if (e) return e; await wait(15); } return null; };
  c.close = () => ws.close();
  return c;
}
const until = async (pred, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return true; await wait(15); } return false; };
const give = (id, items) => server.store.withUser(id, async (e) => { e.st.inv.unshift(...items); server.store.markDirty(e); });
const money = (id, m) => server.store.withUser(id, async (e) => { e.st.money = m; server.store.markDirty(e); });
const stickerDef = Object.values(D.stickers).find((s) => s.p >= 1);
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
const byUid = (list) => [...list].sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
const stOf = (id) => server.store.cache.get(id).st;
// The game's state following one connection: its welcome, then every answer and change, in order, as net/online.js takes them
// in (applyDelta, relink; a unit's contents as stored.js loadUnit takes them). → { r(id): an answer as the page gets it }
function follow(c) {
  globalThis.window = {};
  try { state.enterOnline(c.welcome.state, { units: c.welcome.caps?.includes(LEAN) ? c.welcome.units : null }); } finally { delete globalThis.window; }
  const answers = new Map();
  c.onEvent = (m) => {
    if (m.t === 'delta') return state.applyDelta(m.d);
    if (m.t !== 'res') return;
    if (m.d) state.applyDelta(m.d);
    if (!m.ok) return;
    if (m.r && typeof m.r === 'object' && typeof m.r.unit === 'string' && Array.isArray(m.r.items) && 'sum' in m.r) state.storedArrived(m.r.unit, m.r);
    answers.set(m.id, relink(structuredClone(m.r), m.d)); // (a copy: the test looks at what came, too)
  };
  return { r: (id) => answers.get(id), stop: () => { c.onEvent = null; } };
}
// Where the game's state differs from the server's for that player ('' if nowhere): money, stats, stars, the Index, the
// inventory, and what's in the Storage Units whose contents it has. (Waits a moment for what's still on its way.)
async function differs(id) {
  const why = () => {
    const st = stOf(id), S = state.S, out = [];
    if (S.money !== st.money) out.push(`money ${S.money} / ${st.money}`);
    for (const k of ['stats', 'stars', 'starSpend', 'index', 'loadout']) if (canon(S[k]) !== canon(st[k])) out.push(k);
    if (canon(byUid(S.inv)) !== canon(byUid(st.inv))) out.push(`inventory (${S.inv.length} / ${st.inv.length})`);
    const part = state.storedPart();
    if (canon(byUid(S.stored)) !== canon(byUid(st.stored.filter((it) => !part || part.loaded.has(it.su))))) out.push('stored');
    return out.join(', ');
  };
  await until(() => !why(), 2000);
  return why();
}
const stickers = (n) => Array.from({ length: n }, () => makeStickerItem(stickerDef, 'test'));

// A raw upgrade with a given Sec-WebSocket-Extensions: the status and the extensions the server answered with.
const upgrade = (ext) => new Promise((resolve) => {
  const req = http.request({ port: server.port, host: 'localhost', path: '/ws', headers: {
    Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...(ext != null ? { 'Sec-WebSocket-Extensions': ext } : {}),
  } });
  req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ status: res.statusCode, ext: res.headers['sec-websocket-extensions'] ?? null }); });
  req.on('response', (res) => { res.resume(); resolve({ status: res.statusCode, ext: null }); });
  req.on('error', (e) => resolve({ status: 0, ext: String(e.message) }));
  req.end();
});
// GET /api/prices with an Accept-Encoding: status, headers and the body as sent.
const prices = (ae) => new Promise((resolve, reject) => {
  http.get({ port: server.port, host: 'localhost', path: '/api/prices', headers: ae == null ? {} : { 'accept-encoding': ae } }, (res) => {
    const chunks = [];
    res.on('data', (d) => chunks.push(d));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  }).on('error', reject);
});

try {
  // (p2p1, the Market's, is another: server/test-market.mjs; face1, players' pictures and badges, the third: server/test-social.mjs)
  check('lean1 is a capability, and its name; p2p1 and face1 the only others', LEAN === 'lean1' && CAPS.size === 3 && CAPS.has('lean1') && CAPS.has('p2p1') && CAPS.has('face1'));
  const tok = {};
  for (const n of ['olga', 'leo', 'erik', 'pia', 'quin', 'gabe', 'boss']) tok[n] = await register(n);

  // ---- the handshake --------------------------------------------------------------------------------------------------
  const O = await client(tok.olga);
  check('1.1.2 (no caps): its welcome is what it always was, with no caps in it', Object.keys(O.welcome).filter((k) => k !== 'wire' && k !== 'raw').sort().join() === OLD_WELCOME,
    Object.keys(O.welcome).sort().join());
  const L = await client(tok.leo, { caps: ['lean1', 'lean9', 7, null] });
  check('lean1: the welcome names back the capabilities the server took (not the unknown ones)', same(L.welcome.caps, ['lean1']));
  check('lean1: its welcome has the players and trades, and no lobbies (they come when the Gamble page asks)', Array.isArray(L.welcome.players) && Array.isArray(L.welcome.trades) && !('lobbies' in L.welcome));
  const E = await client(tok.erik, { caps: [] });
  check('caps: [] is a game with nothing new: told so, and sent the old welcome', same(E.welcome.caps, []) && 'lobbies' in E.welcome && !server.srv.lean([...server.srv.sockets.get(E.user.id)][0]));

  // ---- WebSocket compression ----------------------------------------------------------------------------------------------
  const params = O.ws._extensions['permessage-deflate']?.params;
  check('permessage-deflate: taken, with the 16 KB window and context takeover', O.ws.extensions === 'permessage-deflate' && params?.server_max_window_bits === 14 && !params.server_no_context_takeover && !params.client_no_context_takeover,
    JSON.stringify(params));
  const chromium = await upgrade('permessage-deflate; client_max_window_bits');
  check('permessage-deflate: the offer Chromium/Electron sends is taken', chromium.status === 101 && /^permessage-deflate/.test(chromium.ext) && /server_max_window_bits=14/.test(chromium.ext), JSON.stringify(chromium));
  const smallWindow = await upgrade('permessage-deflate; server_max_window_bits=10');
  check('permessage-deflate: an offer it can\'t take (a smaller window) still connects, uncompressed', smallWindow.status === 101 && smallWindow.ext === null, JSON.stringify(smallWindow));
  const garbled = await upgrade('permessage-deflate; client_max_window_bits=99, ;;=');
  check('permessage-deflate: so does a header it can\'t read', garbled.status === 101 && garbled.ext === null, JSON.stringify(garbled));
  const none = await upgrade(null);
  const other = await upgrade('x-webkit-deflate-frame');
  check('permessage-deflate: no offer, or another extension: uncompressed, as before', none.status === 101 && none.ext === null && other.status === 101 && other.ext === null);
  const U = await client(tok.erik, { deflate: false });
  check('a game that doesn\'t offer it plays as before', U.ws.extensions === '' && U.welcome.state && !!(await U.act('nothing.here', {}).catch((e) => e)));
  U.close();

  // How much it saves: a 600-item player's welcome, and small replies one after another.
  await give(L.user.id, stickers(600));
  const big = await client(tok.leo, { caps: ['lean1'] });
  check('compressed: a 600-item welcome is under a fifth of its size on the wire', big.welcome.wire < big.welcome.raw / 5, `${big.welcome.wire} of ${big.welcome.raw} bytes`);
  const uids = big.welcome.state.inv.slice(0, 12).map((i) => i.uid);
  for (const uid of uids) await big.act('item.lock', { uid, lk: true });
  const locks = big.of('res').slice(2); // (after the first two: compressed against the ones before)
  const lw = locks.reduce((s, m) => s + m.wire, 0), lr = locks.reduce((s, m) => s + m.raw, 0);
  check('compressed: small replies too, against the ones before them (context takeover)', lw < lr / 3, `${lw} of ${lr} bytes`);
  big.close();
  const health = await (await fetch(base + '/health')).json();
  check('/health: how many connections there are, and how many compressed', health.ws?.connections >= 3 && health.ws.deflate >= 3 && health.ws.deflate <= health.ws.connections, JSON.stringify(health.ws));

  // ---- /api/prices --------------------------------------------------------------------------------------------------
  const plain = await prices(null), gz = await prices('gzip, deflate'), br = await prices('gzip, deflate, br, zstd'), noBr = await prices('br;q=0, gzip');
  const json = plain.body.toString();
  check('/api/prices: plain JSON without Accept-Encoding, as before', plain.status === 200 && !plain.headers['content-encoding'] && JSON.parse(json).pricedAt === D.pricedAt);
  check('/api/prices: gzip, as before', gz.headers['content-encoding'] === 'gzip' && zlib.gunzipSync(gz.body).toString() === json);
  check('/api/prices: brotli to whoever takes it (Chromium sends gzip, deflate, br, zstd), the same JSON', br.headers['content-encoding'] === 'br' && zlib.brotliDecompressSync(br.body).toString() === json);
  check('/api/prices: brotli is smaller than gzip', br.body.length < gz.body.length * 0.9, `${br.body.length} against ${gz.body.length} bytes (${json.length} plain)`);
  check('/api/prices: br;q=0 means no brotli', noBr.headers['content-encoding'] === 'gzip');
  check('/api/prices: it says it varies by Accept-Encoding', [plain, gz, br].every((r) => /accept-encoding/i.test(r.headers.vary || '')));

  // ---- the players list -------------------------------------------------------------------------------------------------
  O.forget(); L.forget();
  const P = await client(tok.pia, { caps: ['lean1'] });
  await until(() => O.of('players').length && L.of('players.d').length);
  const prow = (c) => c.players.find((p) => p.name === 'pia');
  check('players: 1.1.2 gets the whole list on a join, as before', O.of('players').length === 1 && O.players.length === server.srv.sockets.size && !!prow(O));
  check('players: lean1 gets only the join', L.of('players').length === 0 && L.of('players.d').length === 1 && same(L.of('players.d')[0].join, [prow(O)]) && !L.of('players.d')[0].leave && !L.of('players.d')[0].upd,
    JSON.stringify(L.of('players.d')[0]));
  check('players: and has the same list, in the same order', same(L.players, O.players), JSON.stringify(L.players));
  check('players: the newcomer\'s own list is the whole one too', same(P.players, O.players));
  await wait(60);
  check('players: a lean1 newcomer isn\'t sent its own join after its welcome (its welcome\'s list has it)', !P.of('players.d').some((m) => m.join?.some((p) => p.name === 'pia')), JSON.stringify(P.of('players.d')));
  check('players: the change is smaller than the list', L.of('players.d')[0].raw < O.of('players')[0].raw, `${L.of('players.d')[0].raw} against ${O.of('players')[0].raw} bytes`);

  // A worth that changed shows at the next join, as the whole list has it.
  await give(P.user.id, stickers(5));
  O.forget(); L.forget(); P.forget();
  const Q = await client(tok.quin);
  await until(() => O.of('players').length && L.of('players.d').length && P.of('players.d').length);
  const qd = L.of('players.d')[0];
  await until(() => Q.of('players').length);
  check('players: a 1.1.2 newcomer is sent the whole list after its welcome, as before', Q.of('players').length === 1 && same(Q.players, O.players));
  check('players: a worth changed since is sent with the next change (an upd), and the lists agree', same(qd.join?.map((p) => p.name), ['quin']) && qd.upd?.length === 1 && qd.upd[0].name === 'pia' && qd.upd[0].worth > 0
    && same(L.players, O.players) && same(P.players, O.players) && prow(L).worth === prow(O).worth, JSON.stringify(qd));
  // Another window of someone already online changes nothing in the list: nothing to lean1, the list to 1.1.2.
  O.forget(); L.forget();
  const Q2 = await client(tok.quin);
  await until(() => O.of('players').length);
  await wait(60);
  check('players: a second window of someone online: the whole list to 1.1.2, nothing to lean1', O.of('players').length === 1 && L.of('players.d').length === 0 && same(L.players, O.players));
  Q2.close();
  // Leaving.
  O.forget(); L.forget();
  P.close();
  await until(() => O.of('players').length && L.of('players.d').length);
  check('players: a leave is just the name', same(L.of('players.d')[0].leave, ['pia']) && !L.of('players.d')[0].join && same(L.players, O.players) && !prow(L));
  // A rename by staff: the row with the old name gets the new one, where it was.
  const boss = await client(tok.boss);
  await until(() => L.players.some((p) => p.name === 'boss'));
  O.forget(); L.forget();
  await boss.rpc('admin', 'rename', { id: Q.user.id, name: 'quentin' });
  await until(() => O.players.some((p) => p.name === 'quentin') && L.players.some((p) => p.name === 'quentin'));
  const rd = L.of('players.d').at(-1);
  check('players: a rename is an upd that says the name it had, and the row stays in its place', rd?.upd?.[0]?.was === 'quin' && rd.upd[0].name === 'quentin' && same(L.players, O.players), JSON.stringify(rd));
  check('players: (the game\'s function, on its own: a join already there is replaced, not doubled)', same(playersChanged([{ name: 'a', online: true, worth: 1 }], { join: [{ name: 'a', online: true, worth: 2 }], upd: [{ name: 'b', was: 'z', online: true, worth: 3 }] }),
    [{ name: 'a', online: true, worth: 2 }, { name: 'b', online: true, worth: 3 }]));

  // ---- gamble lobbies -----------------------------------------------------------------------------------------------------
  const G = await client(tok.gabe, { caps: ['lean1'] });
  for (const c of [O, L, G]) await money(c.user.id, 1000);
  O.forget(); L.forget();
  const f1 = await G.rpc('gamble', 'flip.create', { money: 1, side: 'ct', clientSeed: 'a' });
  await until(() => O.of('lobbies').length);
  await wait(LOBBY_MS + 150);
  check('lobbies: 1.1.2 gets them on every change, as before', O.of('lobbies').length === 1 && O.lobbies.flips.some((f) => f.id === f1.id));
  check('lobbies: lean1 with no Gamble page open gets none', L.of('lobbies').length === 0 && L.lobbies === null);
  L.sub(true);
  await until(() => L.of('lobbies').length);
  check('lobbies: its Gamble page opens: it gets them at once, as they are', L.of('lobbies').length === 1 && same(L.lobbies, server.srv.live.snapshot(L.user.id)) && L.lobbies.flips.some((f) => f.id === f1.id));
  // Several changes together: every one to 1.1.2; to lean1 the first at once and the rest together a second later.
  O.forget(); L.forget();
  const t0 = Date.now();
  const burst = [];
  for (let i = 0; i < 2; i++) burst.push(await G.rpc('gamble', 'flip.create', { money: 1, side: 't', clientSeed: 'b' + i }));
  await G.rpc('gamble', 'flip.cancel', { id: f1.id });
  const first = await L.waitFor((e) => e.t === 'lobbies');
  check('lobbies: 1.1.2 gets all three changes', O.of('lobbies').length === 3);
  check('lobbies: lean1 gets the first at once', !!first && Date.now() - t0 < LOBBY_MS);
  await wait(LOBBY_MS + 200);
  const got = L.of('lobbies');
  check('lobbies: and the others in one, about a second later, with every change in it', got.length === 2 && same(L.lobbies, server.srv.live.snapshot(L.user.id))
    && burst.every((b) => L.lobbies.flips.some((f) => f.id === b.id)) && !L.lobbies.flips.some((f) => f.id === f1.id), `${got.length} sent`);
  // Your own change shows at once, even in the second after someone else's.
  L.forget();
  await G.rpc('gamble', 'flip.cancel', { id: burst[0].id });
  await L.waitFor((e) => e.t === 'lobbies');
  const mine = await L.rpc('gamble', 'flip.create', { money: 1, side: 'ct', clientSeed: 'mine' });
  check('lobbies: your own new round is on your page when the answer comes (not a second later)', L.lobbies.flips.some((f) => f.id === mine.id && f.mine) && L.of('lobbies').length === 2);
  await wait(LOBBY_MS + 200);
  check('lobbies: and what came together still follows, right', same(L.lobbies, server.srv.live.snapshot(L.user.id)));
  // Someone else ends your round inside that second: you see it at once too, not a second later (no Cancel on a flip that's
  // gone). The proof: it came while the second's send was still waiting.
  const jf = await L.rpc('gamble', 'flip.create', { money: 1, side: 't', clientSeed: 'jf' });
  await wait(LOBBY_MS + 200);
  const gf = await G.rpc('gamble', 'flip.create', { money: 1, side: 'ct', clientSeed: 'gf' }); // (opens the second)
  let whileWaiting = null;
  await G.rpc('gamble', 'flip.join', { id: jf.id, money: 1, clientSeed: 'jg' });
  const sawIt = await until(() => {
    if (L.lobbies.flips.some((f) => f.id === jf.id)) return false;
    whileWaiting ??= !!server.srv.live.leanTimer;
    return true;
  }, LOBBY_MS * 3);
  check('lobbies: your round ended by someone else\'s request: on your page at once (the second\'s send still waiting)', sawIt && whileWaiting === true, `timer pending: ${whileWaiting}`);
  const roundOf = (m, a) => Live.prototype.inRound.call({ flips: new Map([['f', { userId: 7 }]]), battles: new Map([['b', { seats: [{ userId: 1 }, { bot: true, name: 'x' }, null, { userId: 2 }] }]]), pot: { entries: [{ userId: 3 }, { userId: 4 }] } }, m, a);
  check('lobbies: whose round a request is about: a flip\'s maker, a battle\'s seated players (not bots), the pot\'s entrants',
    same(roundOf('flip.join', { id: 'f' }), [7]) && same(roundOf('battle.join', { id: 'b' }), [1, 2]) && same(roundOf('jackpot.join', {}), [3, 4]) && same(roundOf('flip.join', { id: 'gone' }), []) && same(roundOf('flip.create', {}), []));
  await G.rpc('gamble', 'flip.cancel', { id: gf.id });
  await wait(LOBBY_MS + 200);
  // The page closes: nothing more.
  L.sub(false);
  await wait(50);
  L.forget(); O.forget();
  await L.rpc('gamble', 'flip.cancel', { id: mine.id });
  await G.rpc('gamble', 'flip.cancel', { id: burst[1].id });
  await wait(LOBBY_MS + 200);
  check('lobbies: its Gamble page closed: no more, its own requests\' either', L.of('lobbies').length === 0 && O.of('lobbies').length === 2);
  // A 1.1.2 game that sent sub would be ignored (it never does).
  O.ws.send(JSON.stringify({ t: 'sub', lobbies: false }));
  await wait(30);
  O.forget();
  const f3 = await G.rpc('gamble', 'flip.create', { money: 1, side: 'ct', clientSeed: 'c' });
  await until(() => O.of('lobbies').length);
  check('lobbies: 1.1.2 is sent them whatever it says', O.of('lobbies').length === 1);
  await G.rpc('gamble', 'flip.cancel', { id: f3.id });

  // ---- trade offers ---------------------------------------------------------------------------------------------------------
  const oItems = stickers(3), lItems = stickers(3);
  await give(O.user.id, oItems); await give(L.user.id, lItems);
  O.forget(); L.forget();
  const t1 = await O.rpc('trade', 'offer', { to: 'leo', give: { uids: [oItems[0].uid], money: 1 }, get: { uids: [lItems[0].uid], money: 0 }, msg: 'swap?' });
  await until(() => O.of('trades').length && L.of('trades.d').length);
  const listOf = (c) => c.rpc('trade', 'list', {});
  check('trades: 1.1.2 gets its whole list, as before', O.of('trades').length === 1 && same(O.trades, await listOf(O)));
  const td = L.of('trades.d')[0];
  check('trades: lean1 gets only the new offer', L.of('trades').length === 0 && td.upd.length === 1 && td.upd[0].id === t1.id && td.upd[0].status === 'open' && !td.del, JSON.stringify(td).slice(0, 200));
  check('trades: and its list is the server\'s', same(L.trades, await listOf(L)));
  O.forget(); L.forget();
  await L.rpc('trade', 'decline', { id: t1.id });
  await until(() => O.of('trades').length && L.of('trades.d').length);
  const declined = L.of('trades.d')[0].upd[0];
  check('trades: a decline: lean1 gets the offer\'s new status only (its items it has), and the lists agree', same(Object.keys(declined).sort(), ['id', 'status', 'updated', 'version']) && declined.status === 'declined' && declined.version === 2
    && same(L.trades, await listOf(L)) && same(O.trades, await listOf(O)) && O.trades[0].status === 'declined' && O.trades[0].give.items.length === 1, JSON.stringify(declined));
  const t2 = await L.rpc('trade', 'offer', { to: 'olga', give: { uids: [lItems[1].uid], money: 0 }, get: { uids: [oItems[1].uid], money: 0 } });
  await until(() => O.trades.some((t) => t.id === t2.id));
  O.forget(); L.forget();
  const oAccept = await O.rpc('trade', 'accept', { id: t2.id, version: 1 });
  await until(() => O.of('trades').length && L.of('trades.d').length);
  check('trades: an accept: lean1 gets the accepted offer (its status), and the lists agree', L.of('trades.d').at(-1).upd[0].status === 'accepted' && !('give' in L.of('trades.d').at(-1).upd[0]) && same(L.trades, await listOf(L)) && same(O.trades, await listOf(O)));
  check('trades: 1.1.2 accepting: its answer still has the trade\'s changes (d), as before', oAccept?.ok === true && Array.isArray(oAccept.d?.add) && oAccept.d.add.some((it) => it.uid === lItems[1].uid));
  check('trades: what lean1 was sent is a small part of what 1.1.2 was', L.of('trades.d').reduce((s, m) => s + m.raw, 0) < O.of('trades').reduce((s, m) => s + m.raw, 0));
  // A lean1 game accepting: the items come once, in the delta every connection of its player gets, not again in the answer.
  const t2b = await O.rpc('trade', 'offer', { to: 'leo', give: { uids: [oItems[2].uid], money: 0 }, get: { uids: [lItems[2].uid], money: 0 } });
  await until(() => L.trades.some((t) => t.id === t2b.id));
  L.forget();
  const lAccept = await L.whole('trade', 'accept', { id: t2b.id, version: 1 });
  await until(() => L.of('delta').some((m) => m.d.add?.some((it) => it.uid === oItems[2].uid)));
  check('trades: lean1 accepting: its answer has no d, and the items came in its delta', lAccept.r?.ok === true && !('d' in lAccept.r) && !('d' in lAccept) && L.of('delta').some((m) => m.d.add?.some((it) => it.uid === oItems[2].uid)), JSON.stringify(lAccept.r));

  // The 30 latest: one pushed off the end is in del.
  for (let i = 0; i < 30; i++) {
    await server.db.query("INSERT INTO trades (id, from_id, to_id, status, version, offer, created, updated) VALUES ($1, $2, $3, 'cancelled', 2, $4::jsonb, $5, $5)",
      [`old-${i}`, L.user.id, O.user.id, JSON.stringify({ give: { uids: [], money: 1 }, get: { uids: [], money: 0 }, msg: '', fromName: 'leo', toName: 'olga', giveItems: [], getItems: [] }), 1000 + i]);
  }
  const L2 = await client(tok.leo, { caps: ['lean1'] });
  const last = L2.trades.at(-1)?.id;
  check('trades: a new connection\'s welcome has the 30 latest', L2.trades.length === 30 && same(L2.trades, await listOf(L2)) && /^old-/.test(last));
  const t3 = await O.rpc('trade', 'offer', { to: 'leo', give: { uids: [], money: 2 }, get: { uids: [], money: 0 } });
  await until(() => L2.of('trades.d').length);
  const pushedOff = L2.of('trades.d')[0];
  check('trades: a new offer on a full list: it, and the one it pushed off the end (del)', pushedOff.upd[0].id === t3.id && same(pushedOff.del, [last]) && L2.trades.length === 30 && same(L2.trades, await listOf(L2)), `${JSON.stringify(pushedOff.del)}, last was ${last}`);
  L2.close();
  await O.rpc('trade', 'cancel', { id: t3.id });

  // A blocked sender's offer never reaches you, as before.
  await L.rpc('social', 'block', { id: G.user.id, on: true });
  await give(G.user.id, stickers(1));
  L.forget(); G.forget();
  const hidden = await G.rpc('trade', 'offer', { to: 'leo', give: { uids: [], money: 1 }, get: { uids: [], money: 0 } });
  await until(() => G.of('trades.d').length);
  await wait(60);
  check('trades: an offer from someone you blocked: nothing to you, and its sender sees it', L.of('trades.d').length === 0 && !L.trades.some((t) => t.id === hidden.id) && G.trades.some((t) => t.id === hidden.id));
  await G.rpc('trade', 'cancel', { id: hidden.id });
  await L.rpc('social', 'block', { id: G.user.id, on: false });

  // trade 'list' works with trading turned off (the welcome has it anyway); a new offer doesn't.
  server.admin.settings.trading = false;
  const offList = await listOf(L).catch((e) => e);
  const offOffer = await O.rpc('trade', 'offer', { to: 'leo', give: { uids: [], money: 1 }, get: { uids: [], money: 0 } }).catch((e) => e);
  server.admin.settings.trading = true;
  check('trades: the list can be read with trading off', Array.isArray(offList) && offOffer?.code === 'off');

  // A change while a lean1 game's welcome is on its way: its whole list follows the welcome.
  const T = server.srv.trades, realList = T.list;
  let release = null, held = null;
  T.list = async function (id) { const r = await realList.call(this, id); if (id === L.user.id && !held) { held = true; await new Promise((res) => (release = res)); } return r; };
  const late = client(tok.leo, { caps: ['lean1'] });
  await until(() => held);
  const t4 = await O.rpc('trade', 'offer', { to: 'leo', give: { uids: [], money: 3 }, get: { uids: [], money: 0 } });
  release();
  const L3 = await late;
  T.list = realList;
  await until(() => L3.of('trades').length);
  check('trades: an offer made while the welcome was on its way comes just after it, in a whole list', !L3.welcome.trades.some((t) => t.id === t4.id) && L3.of('trades').length === 1 && L3.trades.some((t) => t.id === t4.id) && same(L3.trades, await listOf(L3)));
  L3.close();
  await O.rpc('trade', 'cancel', { id: t4.id });
  check('trades: (the game\'s function, on its own: latest first, 30 kept, del taken out)', same(tradesChanged([{ id: 'a', updated: 5, give: {} }, { id: 'b', updated: 3, give: {} }], { upd: [{ id: 'b', updated: 9, give: {} }, { id: 'c', updated: 4, give: {} }], del: ['a'] }).map((t) => t.id), ['b', 'c'])
    && tradesChanged(Array.from({ length: 30 }, (_, i) => ({ id: 'x' + i, updated: 100 - i, give: {} })), { upd: [{ id: 'n', updated: 999, give: {} }] }).length === 30);
  // Two pushes for one offer can arrive the other way round (each waits on the database): the newer version stays.
  const T5 = await O.rpc('trade', 'offer', { to: 'leo', give: { uids: [], money: 4 }, get: { uids: [], money: 0 } });
  await until(() => L.trades.some((t) => t.id === T5.id));
  const openCopy = structuredClone(L.trades.find((t) => t.id === T5.id));
  await O.rpc('trade', 'cancel', { id: T5.id });
  await until(() => L.trades.find((t) => t.id === T5.id)?.status === 'cancelled');
  L.trades = tradesChanged(L.trades, { upd: [openCopy] }); // (the open copy coming late)
  // (that offer against the server's copy: this connection was never told of the rows put straight into the database above)
  const t5 = L.trades.find((t) => t.id === T5.id), t5Server = (await listOf(L)).find((t) => t.id === T5.id);
  check('trades: an older copy of an offer arriving after the newer one leaves the newer one', t5?.status === 'cancelled' && same(t5, t5Server), JSON.stringify([t5?.status, t5?.version, t5Server?.version]));

  // ---- actions: case.open's buy, and the answers and changes lean1 is sent ------------------------------------------------
  // The game's own state follows one lean1 connection of leo's (LG) and is compared with the server's; leo also has a 1.1.2
  // game open (LO), and his other lean1 one (L): his other tabs.
  const C = D.cases.find((c) => c.kind === 'case' && keyFor(c) && c.price > 0), K = keyFor(C);
  for (const c of [O, L]) await money(c.user.id, 5000);
  const LO = await client(tok.leo), LG = await client(tok.leo, { caps: ['lean1'] });
  let game = follow(LG);
  const LEO = L.user.id;
  check('the game\'s state, following a lean1 connection: the server\'s to begin with', !(await differs(LEO)), await differs(LEO));
  const oldShape = (d) => Object.keys(d).every((k) => ['set', 'add', 'del', 'upd', 'sto', 'ix'].includes(k)) && ['add', 'del', 'upd'].every((k) => Array.isArray(d[k]));
  const STAT_KEYS = Object.keys(stOf(O.user.id).stats);
  const wholeStats = (d) => !!d.set?.stats && STAT_KEYS.every((k) => k in d.set.stats);
  const leanBits = (d) => ['stats', 'seen', 'units'].some((k) => k in d);
  // 1.1.2: three requests, as before.
  const ob = await O.whole('act', 'case.buy', { id: C.id, n: 3 });
  const ok = await O.whole('act', 'key.buy', { key: K, n: 3 });
  const oo = await O.whole('act', 'case.open', { id: C.id, n: 3 });
  check('1.1.2: case.buy and key.buy answer as before: each item whole in r.items and in d.add, the whole stats, every list',
    [ob, ok].every((m) => oldShape(m.d) && wholeStats(m.d) && !leanBits(m.d) && m.r.items.length === 3 && same(m.r.items, m.d.add) && m.r.items.every((it) => it.t && it.id && it.uid)));
  check('1.1.2: case.open answers as before: the drops whole in r.items and d.add, the cases and keys it used in d.del, no bought',
    oldShape(oo.d) && wholeStats(oo.d) && !leanBits(oo.d) && oo.r.items.length === 3 && oo.r.items.every((it) => it.t && it.id) && same(oo.r.items.filter((it) => !it.as), oo.d.add)
    && same([...oo.d.del].sort(), [...ob.r.items, ...ok.r.items].map((i) => i.uid).sort()) && !('bought' in oo.r));
  const noCase = await O.act('case.open', { id: C.id, n: 1 }).catch((e) => e);
  check('case.open without buy, with no case: refused as before', noCase?.code === 'nocase');

  // lean1: one request.
  const crates = (st) => st.inv.filter((it) => (it.t === 'crate' && it.id === C.id) || (it.t === 'key' && it.id === K)).length;
  const was = structuredClone(stOf(LEO));
  L.forget(); LO.forget();
  const lb = await LG.whole('act', 'case.open', { id: C.id, n: 3, buy: true });
  const now = stOf(LEO), caseCost = round2(C.price * 3), keyCost = round2(D.keyPrice * 3);
  check('lean1: case.open with buy: one request buys the 3 cases and 3 keys it was short of, at case.buy and key.buy\'s prices, and opens them',
    crates(was) === 0 && lb.r.bought?.cases === 3 && lb.r.bought.keys === 3 && lb.r.bought.cost === round2(caseCost + keyCost) && now.money === round2(round2(was.money - caseCost) - keyCost)
    && now.stats.opened === was.stats.opened + 3 && now.stats.spent === round2(round2(was.stats.spent + caseCost) + keyCost) && now.stars === was.stars + lb.r.bought.stars,
    JSON.stringify(lb.r.bought));
  check('lean1: no case or key is left over, and the drops are in the inventory', crates(now) === 0 && (lb.d.add || []).every((it) => now.inv.some((x) => x.uid === it.uid)));
  check('lean1: no d.del for cases and keys the game was never sent, and none of them in d.add', !('del' in lb.d) && (lb.d.add || []).every((it) => it.t !== 'crate' && it.t !== 'key'));
  const kept = lb.r.items.filter((it) => !it.as);
  check('lean1: each new item is sent once: whole in d.add, { uid } alone in r.items', kept.length === (lb.d.add || []).length && kept.every((it, i) => same(Object.keys(it), ['uid']) && it.uid === lb.d.add[i].uid), JSON.stringify(lb.r.items).slice(0, 160));
  check('lean1: the stats as the fields that changed, and no set.stats', !('stats' in (lb.d.set || {})) && lb.d.stats?.opened === now.stats.opened && lb.d.stats.spent === now.stats.spent
    && !('playEarned' in lb.d.stats) && !('stickersApplied' in lb.d.stats), JSON.stringify(lb.d.stats));
  const shown = game.r(lb.id);
  check('lean1: the page still gets every drop whole (relink), the inventory\'s own objects', shown.items.length === 3 && shown.items.every((it) => it.t && it.id && (it.as || state.S.inv.includes(it))));
  check('lean1: and the game\'s state is the server\'s (money, stats, stars, the Index, every item)', !(await differs(LEO)), await differs(LEO));
  check('lean1: one answer, a fraction of what 1.1.2\'s three are', lb.raw < (ob.raw + ok.raw + oo.raw) * 0.45, `${lb.raw} bytes against ${ob.raw} + ${ok.raw} + ${oo.raw}`);
  const copyIn = (c) => c.of('delta').find((m) => m.d.add?.length); // (not passive income's, which may come too)
  await until(() => copyIn(LO) && copyIn(L));
  const loCopy = copyIn(LO), lCopy = copyIn(L);
  check('other tabs: the 1.1.2 one is sent the changes as before (the whole stats, every list, the drops whole)', oldShape(loCopy.d) && wholeStats(loCopy.d) && !leanBits(loCopy.d)
    && same(loCopy.d.add.map((i) => i.uid), lb.d.add.map((i) => i.uid)) && loCopy.d.add.every((it) => it.t));
  check('other tabs: the lean1 one is sent lean1\'s', same(lCopy.d.stats, lb.d.stats) && same(lCopy.d.add, lb.d.add) && !('stats' in (lCopy.d.set || {})));

  // With a case already: it buys the rest, and uses that one (in d.del: the game had it).
  const one = await LG.whole('act', 'case.buy', { id: C.id, n: 1 });
  check('lean1: case.buy: the case whole in d.add, { uid } in r.items', same(one.r.items, [{ uid: one.d.add[0].uid }]) && one.d.add[0].t === 'crate' && game.r(one.id).items[0] === state.S.inv.find((it) => it.uid === one.d.add[0].uid));
  const part = await LG.whole('act', 'case.open', { id: C.id, n: 3, buy: true });
  check('lean1: with one case already: it buys the other 2 and the 3 keys, and d.del has the case it used', part.r.bought?.cases === 2 && part.r.bought.keys === 3 && same(part.d.del, [one.d.add[0].uid]) && crates(stOf(LEO)) === 0);
  // The old way from a lean1 game still works.
  await LG.act('case.buy', { id: C.id, n: 2 });
  await LG.act('key.buy', { key: K, n: 2 });
  const threeStep = await LG.whole('act', 'case.open', { id: C.id, n: 2 });
  check('lean1: case.buy, key.buy and case.open still work (d.del: the cases and keys it was sent)', threeStep.d.del?.length === 4 && !threeStep.r.bought && crates(stOf(LEO)) === 0);
  // Auto-sold drops never reach the inventory: they stay whole.
  const sellAll = { on: true, below: 1e6, ranks: [], keepStt: false, keepRare: false };
  const as = await LG.whole('act', 'case.open', { id: C.id, n: 5, buy: true, autoSell: sellAll });
  const sold = as.r.items.filter((it) => it.as);
  check('lean1: auto-sold drops stay whole in r.items (no d.add for them), and what auto-sell paid is there', sold.length > 0 && sold.every((it) => it.t && it.id && !(as.d.add || []).some((x) => x.uid === it.uid))
    && as.r.items.filter((it) => !it.as).every((it) => same(Object.keys(it), ['uid'])) && as.r.autoSold > 0 && as.d.stats?.sold === stOf(LEO).stats.sold);
  check('lean1: the game\'s state is still the server\'s', !(await differs(LEO)), await differs(LEO));
  // Not enough money for what it would buy: refused, and nothing bought on its own (a lean1 game not followed: gabe).
  await money(G.user.id, 1);
  const gWas = canon(stOf(G.user.id));
  const poor = await G.act('case.open', { id: C.id, n: 3, buy: true }).catch((e) => e);
  check('lean1: buy without the money: refused, and nothing changed (no case bought on its own)', poor?.code === 'funds' && canon(stOf(G.user.id)) === gWas);
  await money(G.user.id, 1000);
  // Cases of yours in an open trade offer of yours: the server won't open them, so buy would pay for others. The game counts
  // what it will open (cases.js) and says what it expects to pay (maxCost); more than that is refused.
  await G.act('case.buy', { id: C.id, n: 2 });
  await G.act('key.buy', { key: K, n: 2 });
  const gCrates = stOf(G.user.id).inv.filter((it) => it.t === 'crate' && it.id === C.id).map((it) => it.uid);
  const gOffer = await G.rpc('trade', 'offer', { to: 'olga', give: { uids: gCrates, money: 0 }, get: { uids: [], money: 1 } });
  const gHeld = canon(stOf(G.user.id));
  const overPrice = await G.act('case.open', { id: C.id, n: 2, buy: true, maxCost: 0 }).catch((e) => e);
  check('lean1: buy with maxCost 0 when the cases it has are in its trade offer: refused (price), nothing bought or changed', overPrice?.code === 'price' && canon(stOf(G.user.id)) === gHeld, overPrice?.message);
  const fair = await G.act('case.open', { id: C.id, n: 2, buy: true, maxCost: round2(C.price * 2) });
  check('lean1: with maxCost what 2 cases cost: those are bought and opened, the offered ones left where they are', fair.bought?.cases === 2 && fair.bought.keys === 0 && fair.bought.cost === round2(C.price * 2)
    && gCrates.every((u) => stOf(G.user.id).inv.some((it) => it.uid === u)));
  await G.rpc('trade', 'cancel', { id: gOffer.id });
  // (the server's own copy of the answer, which the Discord drops are made from, is left whole)
  const ctxR = { items: [{ uid: 'a', t: 'skin' }, { uid: 'b', t: 'skin', as: true }], n: 2 }, dR = { add: [ctxR.items[0]], upd: [] };
  const rCopy = JSON.stringify(ctxR), leanR = lean.leanResult(ctxR, dR);
  check('lean1: the lean answer is a copy: the server\'s own (Discord\'s drops, the old games\') is unchanged', JSON.stringify(ctxR) === rCopy && same(leanR.items, [{ uid: 'a' }, ctxR.items[1]]) && leanR.items[1] === ctxR.items[1]);

  // ---- item.seen --------------------------------------------------------------------------------------------------------
  const fresh = state.S.inv.filter((it) => it.nw).slice(0, 4).map((it) => it.uid);
  const seenAns = await LG.whole('act', 'item.seen', { uids: fresh });
  check('lean1: item.seen answers with the uids it cleared, not the items', fresh.length === 4 && same(seenAns.d.seen, fresh) && !('upd' in seenAns.d) && fresh.every((u) => !('nw' in state.S.inv.find((it) => it.uid === u))));
  const oFresh = stOf(O.user.id).inv.filter((it) => it.nw).slice(0, 2).map((it) => it.uid);
  const oSeen = await O.whole('act', 'item.seen', { uids: oFresh });
  check('1.1.2: item.seen as before: the items whole in d.upd, without their New tag', oFresh.length === 2 && oldShape(oSeen.d) && !leanBits(oSeen.d) && same(oSeen.d.upd.map((i) => i.uid), oFresh) && oSeen.d.upd.every((it) => it.t && !('nw' in it)));
  check('lean1: the game\'s state is the server\'s after it', !(await differs(LEO)), await differs(LEO));

  // ---- Storage Units: lean1's welcome leaves what's in them out -------------------------------------------------------------
  const drops = () => state.S.inv.filter((it) => it.t === 'skin' && !it.lk).map((it) => it.uid);
  await LG.act('case.open', { id: C.id, n: 10, buy: true }); // (more to put away)
  const u1 = (await LG.act('storage.buy', {})).items[0].uid, u2 = (await LG.act('storage.buy', {})).items[0].uid;
  await LG.act('storage.name', { unit: u1, name: 'one' });
  await LG.act('storage.name', { unit: u2, name: 'two' });
  check('the game: a unit bought since the welcome is known to be empty (nothing to ask for)', stored.unitLoaded(u1) && stored.unitCount(u1) === 0);
  LO.forget();
  const dep = await LG.whole('act', 'storage.deposit', { unit: u1, uids: drops().slice(0, 4) });
  check('lean1: the first deposit since these units came: d.sto, and both units\' count, value and best (new to its sums)', dep.d.sto?.add.length === 4 && dep.d.units?.[u1]?.n === 4 && dep.d.units[u2]?.n === 0 && !!dep.d.units[u1].best && dep.d.units[u2].best === null);
  const stoIn = (c) => c.of('delta').find((m) => m.d.sto);
  await until(() => stoIn(LO));
  check('1.1.2 (another tab): the same deposit as before: d.sto, and no units', stoIn(LO).d.sto.add.length === 4 && oldShape(stoIn(LO).d) && !leanBits(stoIn(LO).d));
  const dep2 = await LG.whole('act', 'storage.deposit', { unit: u2, uids: drops().slice(0, 3) });
  check('lean1: a deposit into one unit: only that unit\'s sums (d.units has no other)', same(Object.keys(dep2.d.units || {}), [u2]) && dep2.d.units[u2].n === 3 && !!dep2.d.units[u2].best, JSON.stringify(Object.keys(dep2.d.units || {})));
  check('the game: what\'s in units it has is the server\'s', !(await differs(LEO)) && stored.unitCount(u1) === 4 && stored.unitCount(u2) === 3, await differs(LEO));

  // A new connection: 1.1.2's welcome has the contents, lean1's has each unit's sums instead.
  const LS = await client(tok.leo, { caps: ['lean1'] }), OS = await client(tok.leo);
  const st0 = stOf(LEO), bestOf = (items) => items.reduce((b, it) => (!b || itemValue(it) > itemValue(b) ? it : b), null);
  check('1.1.2: its welcome has what\'s in the units, as before, and no sums', Array.isArray(OS.welcome.state.stored) && OS.welcome.state.stored.length === 7 && !('units' in OS.welcome) && canon(OS.welcome.state.stored) === canon(st0.stored));
  const sums = LS.welcome.units || {};
  check('lean1: no state.stored in its welcome; each unit\'s count, value and most valuable item instead', !('stored' in LS.welcome.state) && sums[u1]?.n === 4 && sums[u2]?.n === 3
    && sums[u1].value === unitWorth(st0, u1) && sums[u1].best?.uid === bestOf(contents(st0, u1)).uid && same(Object.keys(sums).sort(), [u1, u2].sort()), JSON.stringify(sums[u1]).slice(0, 120));
  check('lean1: everything else in its welcome\'s state is 1.1.2\'s', canon({ ...OS.welcome.state, stored: undefined }) === canon({ ...LS.welcome.state, stored: undefined }));
  game.stop();
  game = follow(LS);
  const top = bestOf(ownedItems(st0));
  check('the game: a unit not asked for has its count and value from the sums, and no contents yet', !stored.unitLoaded(u1) && stored.unitCount(u1) === 4 && stored.unitValue(u1) === unitWorth(st0, u1) && !stored.unitContents(u1).length && !state.S.stored.length);
  check('the game: totals, net worth and the most valuable item as the server has them', stored.storedTotals().n === 7 && Math.abs(stored.storedTotals().value - round2(unitWorth(st0, u1) + unitWorth(st0, u2))) < 0.011
    && Math.abs(stored.ownedWorth() - ownedValue(st0)) < 0.011 && itemValue(stored.bestOwned()) === itemValue(top), `${stored.ownedWorth()} / ${ownedValue(st0)}`);
  const inU1 = await LS.rpc('social', 'stored', { unit: u1 });
  check('social stored: one unit\'s contents as the server has them, and its sums', inU1.unit === u1 && canon(byUid(inU1.items)) === canon(byUid(contents(st0, u1))) && inU1.sum.n === 4 && inU1.sum.value === unitWorth(st0, u1));
  check('the game: once asked for, the unit\'s contents are here, and still count right', stored.unitLoaded(u1) && stored.unitContents(u1).length === 4 && stored.unitCount(u1) === 4 && !stored.unitLoaded(u2) && !(await differs(LEO)), await differs(LEO));
  const nope = await LS.rpc('social', 'stored', { unit: 'nope' }).catch((e) => e);
  const oldAsk = await OS.rpc('social', 'stored', { unit: u1 }).catch((e) => e);
  check('social stored: a unit you don\'t have is refused; (any game may ask)', nope?.code === 'missing' && oldAsk?.unit === u1);
  // Another tab moves things: into the unit that's here (its contents follow), and into the one that isn't (its sums only).
  LS.forget();
  const serverDrops = () => stOf(LEO).inv.filter((it) => it.t === 'skin' && !it.lk).map((it) => it.uid); // (for the other tab's requests)
  LG.forget(); OS.forget();
  // (the cheapest: one that likely leaves the unit's most valuable item as it was)
  const cheapest = () => stOf(LEO).inv.filter((it) => it.t === 'skin' && !it.lk).sort((a, b) => itemValue(a) - itemValue(b))[0].uid;
  await LO.act('storage.deposit', { unit: u1, uids: serverDrops().slice(0, 1) });
  const bestWas = lean.unitSums(stOf(LEO))[u2].best?.uid, toU2 = cheapest();
  await LO.act('storage.deposit', { unit: u2, uids: [toU2] });
  await until(() => LS.of('delta').filter((m) => m.d.sto).length >= 2 && LG.of('delta').filter((m) => m.d.sto).length >= 2 && OS.of('delta').filter((m) => m.d.sto).length >= 2);
  check('the game: a deposit into a unit that\'s here: its contents follow; into one that isn\'t: only its count and value',
    stored.unitContents(u1).length === 5 && stored.unitCount(u2) === 4 && !state.S.stored.some((it) => it.su === u2) && stored.unitValue(u2) === unitWorth(stOf(LEO), u2) && !(await differs(LEO)), await differs(LEO));
  const intoU2 = (c) => c.of('delta').filter((m) => m.d.sto).at(-1).d;
  check('lean1: a deposit into a unit it hasn\'t asked for: the item is left out of d.sto.add (its sums are there)', intoU2(LS).sto.add.length === 0 && intoU2(LS).units?.[u2]?.n === 4, JSON.stringify(intoU2(LS).sto));
  check('lean1: one that has that unit\'s contents (bought since its welcome) gets the item; 1.1.2 gets it as before', intoU2(LG).sto.add.some((it) => it.uid === toU2) && intoU2(OS).sto.add.some((it) => it.uid === toU2) && !('units' in intoU2(OS)));
  const bestNow = lean.unitSums(stOf(LEO))[u2].best?.uid, u2row = intoU2(LS).units[u2];
  check('lean1: a unit\'s row has its most valuable item only when that\'s another one; the game\'s sums have it right either way',
    (bestNow === bestWas ? !('best' in u2row) : u2row.best?.uid === bestNow) && state.storedPart().sums.get(u2).best?.uid === bestNow && same(Object.keys(intoU2(LS).units), [u2]),
    `best ${bestNow === bestWas ? 'the same, left out' : 'changed, sent'}`);
  const ownDep = await LS.whole('act', 'storage.deposit', { unit: u2, uids: [cheapest()] });
  check('lean1: its own deposit into a unit it hasn\'t asked for: the answer leaves the item out as well', ownDep.d.sto?.add.length === 0 && ownDep.d.units?.[u2]?.n === 5 && stored.unitCount(u2) === 5
    && !(await differs(LEO)), await differs(LEO));
  // Asked for while another tab moves things in it: whichever comes first, the contents end up the server's.
  for (const first of ['ask', 'move']) {
    const unit = first === 'ask' ? u2 : u1;
    if (first === 'move') { state.storedPart().loaded.delete(unit); state.S.stored = state.S.stored.filter((it) => it.su !== unit); } // (as if not asked for yet)
    const inside = contents(stOf(LEO), unit).slice(0, 2).map((it) => it.uid);
    const both = first === 'ask'
      ? [LS.rpc('social', 'stored', { unit }), LO.act('storage.retrieve', { unit, uids: inside })]
      : [LO.act('storage.retrieve', { unit, uids: inside }), LS.rpc('social', 'stored', { unit })];
    await Promise.all(both);
    check(`the game: a unit asked for while another tab takes things out (${first === 'ask' ? 'asked first' : 'taken first'}): its contents end up the server's`,
      stored.unitLoaded(unit) && !(await differs(LEO)) && stored.unitContents(unit).length === contents(stOf(LEO), unit).length && stored.unitCount(unit) === contents(stOf(LEO), unit).length, await differs(LEO));
  }
  // Staff take an item out of a unit: lean1 is told the units' counts with it, 1.1.2 as before.
  LS.forget(); OS.forget();
  const victim = contents(stOf(LEO), u2)[0].uid;
  await boss.rpc('admin', 'items.remove', { id: LEO, uids: [victim] });
  await until(() => stoIn(LS) && stoIn(OS));
  const sd = stoIn(LS).d, od = stoIn(OS).d;
  check('staff take a stored item: lean1 gets d.sto and every unit\'s count; 1.1.2 gets d.sto as before', same(sd.sto?.del, [victim]) && sd.units?.[u2]?.n === contents(stOf(LEO), u2).length
    && same(od.sto?.del, [victim]) && !('units' in od) && oldShape(od) && !(await differs(LEO)), await differs(LEO));
  check('lean1: the welcome with units is smaller than 1.1.2\'s for the same player', LS.welcome.raw < OS.welcome.raw, `${LS.welcome.raw} against ${OS.welcome.raw} bytes`);
  // Staff restore a save: all of it comes (set.stored), so the game has every unit's contents, and from then on what goes into
  // any unit comes whole to it.
  const snapL = await boss.rpc('admin', 'snapshot.save', { id: LEO, label: 'lean' });
  await boss.rpc('admin', 'snapshot.restore', { snap: snapL.id });
  await until(() => !state.storedPart());
  LS.forget();
  const afterRestore = stOf(LEO).inv.filter((it) => it.t === 'skin' && !it.lk)[0].uid;
  await LO.act('storage.deposit', { unit: u2, uids: [afterRestore] });
  await until(() => stoIn(LS));
  check('staff restore a save: lean1 has every unit\'s contents from then on, and a deposit into any unit comes whole', !state.storedPart() && !!stoIn(LS)?.d.sto.add.some((it) => it.uid === afterRestore)
    && !(await differs(LEO)), await differs(LEO));
  // 100 units (the most anyone can buy, up from 20), a few with things in them: lean1's welcome is still only their sums,
  // one row each, and a game that follows it counts every unit as the server does.
  const unitsNow = () => stOf(LEO).inv.filter((it) => it.t === 'unit');
  await money(LEO, 1000);
  while (unitsNow().length < 100) await LG.act('storage.buy', { n: Math.min(10, 100 - unitsNow().length) });
  const fresh100 = unitsNow().filter((u) => u.uid !== u1 && u.uid !== u2).slice(0, 6);
  await LG.act('case.open', { id: C.id, n: 6, buy: true });
  for (const [i, u] of fresh100.entries()) {
    await LG.act('storage.name', { unit: u.uid, name: 'n' + i });
    await LG.act('storage.deposit', { unit: u.uid, uids: [stOf(LEO).inv.filter((it) => it.t === 'skin' && !it.lk)[0].uid] });
  }
  const tooMany = await LG.act('storage.buy', {}).catch((e) => e);
  game.stop();
  const L100 = await client(tok.leo, { caps: ['lean1'] }), O100 = await client(tok.leo);
  game = follow(L100);
  const sums100 = L100.welcome.units || {}, server100 = lean.unitSums(stOf(LEO));
  check('100 units: the 101st is refused; lean1\'s welcome has a row for each of the 100 and no state.stored, its sums the server\'s', tooMany?.code === 'units' && Object.keys(sums100).length === 100
    && !('stored' in L100.welcome.state) && Object.entries(server100).every(([uid, s]) => sums100[uid]?.n === s.n && sums100[uid].value === s.value) && fresh100.every((u) => sums100[u.uid]?.n === 1));
  // (With this little stored, 1.1.2's welcome, which has it all, is the smaller one: lean1's pays off as units fill up.)
  check('100 units: lean1\'s rows stay small: a few KB for all 100, one item at most in each', JSON.stringify(sums100).length < 20 * 1024 && Object.values(sums100).every((s) => JSON.stringify(s).length < 2048)
    && L100.welcome.raw - JSON.stringify(sums100).length < O100.welcome.raw, `${L100.welcome.raw} against ${O100.welcome.raw} bytes, ${JSON.stringify(sums100).length} of rows`);
  check('100 units: the game counts every unit as the server does, from the sums', unitsNow().every((u) => stored.unitCount(u.uid) === server100[u.uid].n && stored.unitValue(u.uid) === server100[u.uid].value)
    && stored.storedTotals().n === stOf(LEO).stored.length);
  game.stop();
  for (const c of [LS, OS, LG, L100, O100]) c.close();

  // 1.1.2 games (olga's, and leo's other one) were never sent a lean1 field, nor an item as { uid } alone.
  const oldOnes = [...O.events, ...LO.events];
  check('1.1.2: never a lean1 field in its changes, nor an item as { uid } alone in an answer',
    !oldOnes.some((m) => (m.t === 'res' || m.t === 'delta') && m.d && leanBits(m.d)) && !oldOnes.some((m) => m.t === 'res' && /\{"uid":"[^"]*"\}/.test(JSON.stringify(m.r ?? null))));
  LO.close();

  // ---- 1.1.2, all along ---------------------------------------------------------------------------------------------------
  await wait(100);
  const seen = new Set(O.events.map((e) => e.t));
  check('1.1.2: everything it was sent is something it reads', [...seen].every((t) => OLD.has(t)), [...seen].join());
  for (const c of [O, L, E, Q, boss, G]) c.close();

  // ---- /api/prices after a daily refresh: brotli is made off the main thread, and the old one is never sent ---------------
  // (The marketplaces are stand-ins: no request leaves this machine. Last, as it changes the server's prices.)
  const realFetch = globalThis.fetch, asked = [];
  globalThis.fetch = (u, o) => (String(u).startsWith(base) ? realFetch(u, o) : (asked.push(String(u)), Promise.resolve({ ok: true, json: async () => [] })));
  const wasAt = D.pricedAt;
  const refreshed = server.refreshPrices();
  const during = [];
  for (let i = 0; i < 40 && D.pricedAt === wasAt; i++) await wait(5);
  for (let i = 0; i < 6; i++) { const r = await prices('gzip, deflate, br'); during.push(r); }
  await refreshed;
  const ready = await until(async () => (await prices('gzip, deflate, br')).headers['content-encoding'] === 'br', 10000);
  globalThis.fetch = realFetch;
  const bodyOf = (r) => JSON.parse((r.headers['content-encoding'] === 'br' ? zlib.brotliDecompressSync(r.body) : r.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(r.body) : r.body).toString());
  const after = await prices('gzip, deflate, br');
  check('/api/prices: a refresh changes pricedAt, and every answer from then on has the new prices (never the old brotli)', asked.length > 0 && asked.every((u) => !u.startsWith(base)) && D.pricedAt !== wasAt
    && during.every((r) => bodyOf(r).pricedAt === D.pricedAt), `${during.map((r) => r.headers['content-encoding']).join(',')}`);
  check('/api/prices: and brotli again once it\'s made', ready && after.headers['content-encoding'] === 'br' && bodyOf(after).pricedAt === D.pricedAt);
} catch (e) {
  failed++;
  console.error('FAIL  test crashed:', e);
}
await server.close().catch((e) => console.error('close failed', e));
const crashed = logs.filter((l) => /^\[(rpc|ws|trade)\]/.test(l));
check('no request ended in a server error', !crashed.length, crashed.slice(0, 3).join(' | '));
fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
