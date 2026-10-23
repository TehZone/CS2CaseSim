// CS2 Case Simulator multiplayer server.
//   node server/index.mjs            (DATABASE_URL=postgres://... for Postgres/Neon; without it an embedded
//                                     Postgres is used: in memory, or on disk with PGLITE_DIR=./server/.data)
// HTTP: GET /health, POST /api/register | /api/login | /api/logout, GET /api/prices
// WebSocket: /ws (protocol described in src/js/net/online.js)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { openDb } from './db.mjs';
import { Store, tickIdle } from './store.mjs';
import { Trades } from './trade.mjs';
import { Live } from './live.mjs';
import * as A from './accounts.mjs';
import { D, initData } from '../src/js/engine/data.js';
import { makeCtx, runAction, delta, credit, GameError } from '../src/js/engine/actions.js';
import * as M from '../src/js/engine/manager.js';
import { marketWindow } from '../src/js/engine/market.js';
import { itemValue } from '../src/js/engine/items.js';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROTOCOL = 1;
const INV_CAP = 3000;
const MAX_MSG = 64 * 1024;

export async function startServer({ port = +process.env.PORT || 8787, db: dbOpts = {}, log = console.log, priceRefresh = process.env.PRICE_REFRESH !== '0' } = {}) {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/data/game-data.json'), 'utf8'));
  initData(data);
  const db = await openDb(dbOpts);
  log(`[server] database: ${db.kind}`);
  const store = new Store(db, { log });
  const sockets = new Map(); // userId -> Set<ws>
  const pricing = require('../shared/pricing.cjs');

  const srv = {
    db, store, log, INV_CAP,
    isOnline: (id) => sockets.has(id),
    forEachOnline: (fn) => { for (const id of sockets.keys()) fn(id); },
    sendTo(id, msg, except = null) {
      const set = sockets.get(id);
      if (!set) return;
      const text = JSON.stringify(msg);
      for (const ws of set) if (ws !== except && ws.readyState === 1) ws.send(text);
    },
    deltaTo(id, d, note = null, quiet = false) {
      if (!d) return;
      srv.sendTo(id, { t: 'delta', d, ...(note && !quiet ? { note } : {}) });
    },
    notice(id, msg, type = 'gold') { srv.sendTo(id, { t: 'notice', msg, type }); },
    async bumpStat(id, key) {
      await store.withUser(id, async (e) => { e.st.stats[key] = (e.st.stats[key] || 0) + 1; store.markDirty(e); srv.deltaTo(id, { set: { stats: e.st.stats }, add: [], del: [], upd: [] }); });
    },
  };
  const trades = new Trades(srv);
  srv.trades = trades;
  await trades.init();
  const live = new Live(srv);
  srv.live = live;
  await live.refundOpen();

  // ---- market prices: same data build as the client, refreshed daily from the marketplaces ----------------
  let pricePatch = null, pricePatchGz = null;
  const buildPatch = () => {
    const pick = (obj, f) => Object.fromEntries(Object.values(obj).map((x) => [x.id, f(x)]));
    pricePatch = {
      generatedAt: D.generatedAt, pricedAt: D.pricedAt,
      skins: pick(D.skins, (s) => s.p), stickers: pick(D.stickers, (s) => s.p), agents: pick(D.agents, (a) => a.p),
      cases: Object.fromEntries(D.cases.filter((c) => !c.custom).map((c) => [c.id, c.price])),
    };
    pricePatchGz = zlib.gzipSync(JSON.stringify(pricePatch));
  };
  const applyPatch = (p) => {
    for (const [id, v] of Object.entries(p.skins)) if (D.skins[id]) D.skins[id].p = v;
    for (const [id, v] of Object.entries(p.stickers)) if (D.stickers[id]) D.stickers[id].p = v;
    for (const [id, v] of Object.entries(p.agents)) if (D.agents[id]) D.agents[id].p = v;
    for (const [id, v] of Object.entries(p.cases)) if (D.caseById[id]) D.caseById[id].price = v;
    D.pricedAt = p.pricedAt;
  };
  try {
    const { rows } = await db.query("SELECT v FROM kv WHERE k = 'prices'");
    const saved = rows[0] && (typeof rows[0].v === 'string' ? JSON.parse(rows[0].v) : rows[0].v);
    if (saved?.generatedAt === D.generatedAt && saved.pricedAt > (D.pricedAt || '')) { applyPatch(saved); log(`[prices] using prices from ${saved.pricedAt}`); }
  } catch (e) { log('[prices] could not load saved prices', e.message); }
  buildPatch();
  async function refreshPrices() {
    try {
      log('[prices] refreshing from marketplaces…');
      const raw = await pricing.fetchSources(fetch, (m) => log('[prices]', m));
      if (!Object.values(raw).some(Boolean)) return;
      pricing.applyPrices({ skins: D.skins, stickers: D.stickers, agents: D.agents, cases: D.cases }, pricing.buildIndex(raw));
      D.pricedAt = new Date().toISOString();
      buildPatch();
      await db.query("INSERT INTO kv (k, v) VALUES ('prices', $1::jsonb) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v", [JSON.stringify(pricePatch)]);
      log('[prices] updated', D.pricedAt);
    } catch (e) { log('[prices] refresh failed', e.message); }
  }
  const DAY = 24 * 3600 * 1000;
  let priceTimer = null;
  if (priceRefresh) {
    const age = Date.now() - Date.parse(D.pricedAt || 0);
    setTimeout(refreshPrices, age > DAY ? 20000 : age > 0 ? DAY - age : DAY).unref?.();
    priceTimer = setInterval(refreshPrices, DAY);
    priceTimer.unref?.();
  }

  // ---- market stock: listings bought by anyone on the server, per 10-minute window ---------------------------
  const marketSold = new Map(); // window -> Set of listing ids
  let marketDirty = false;
  try {
    const { rows } = await db.query("SELECT v FROM kv WHERE k = 'market'");
    const saved = rows[0] && (typeof rows[0].v === 'string' ? JSON.parse(rows[0].v) : rows[0].v);
    const cur = marketWindow();
    for (const [w, ids] of Object.entries(saved || {})) if (+w >= cur - 1) marketSold.set(+w, new Set(ids));
  } catch (e) { log('[market] could not load sold listings', e.message); }
  const soldSet = (w) => { if (!marketSold.has(w)) marketSold.set(w, new Set()); return marketSold.get(w); };
  const marketSnapshot = () => {
    const cur = marketWindow();
    for (const w of [...marketSold.keys()]) if (w < cur - 1) marketSold.delete(w);
    return Object.fromEntries([...marketSold].map(([w, set]) => [w, [...set]]));
  };
  const saveMarket = setInterval(() => {
    if (!marketDirty) return;
    marketDirty = false;
    db.query("INSERT INTO kv (k, v) VALUES ('market', $1::jsonb) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v", [JSON.stringify(marketSnapshot())])
      .catch((e) => { marketDirty = true; log('[market] save failed', e.message); });
  }, 3000);

  // ---- serial numbers: one counter per item for the whole server (see engine items.serialKey) -------------
  const serials = new Map();
  let serialsDirty = false;
  try {
    const { rows } = await db.query("SELECT v FROM kv WHERE k = 'serials'");
    const saved = rows[0] && (typeof rows[0].v === 'string' ? JSON.parse(rows[0].v) : rows[0].v);
    for (const [k, n] of Object.entries(saved || {})) serials.set(k, Number(n) || 0);
  } catch (e) { log('[serials] could not load counters', e.message); }
  srv.serial = (key) => {
    const n = (serials.get(key) || 0) + 1;
    serials.set(key, n);
    serialsDirty = true;
    return n;
  };
  const saveSerials = async () => {
    if (!serialsDirty) return;
    serialsDirty = false;
    await db.query("INSERT INTO kv (k, v) VALUES ('serials', $1::jsonb) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v", [JSON.stringify(Object.fromEntries(serials))])
      .catch((e) => { serialsDirty = true; log('[serials] save failed', e.message); });
  };
  const serialTimer = setInterval(saveSerials, 3000);

  // ---- HTTP ----------------------------------------------------------------------------------------------
  const ipLimit = A.limiter(20, 60000);
  const nameLimit = A.limiter(30, 3600000);
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', ...cors }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 16384) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
  const ipOf = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    try {
      if (url.pathname === '/health') return json(res, 200, { ok: true, online: sockets.size, data: D.generatedAt, pricedAt: D.pricedAt });
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(`<!doctype html><title>CS2 Case Simulator server</title><body style="font-family:system-ui;background:#0a0d12;color:#e8eef5;padding:40px">
          <h1>CS2 Case Simulator server</h1><p>This server is running. Put this address into the game (click <b>Offline</b> at the top right) to play online.</p>
          <p>Players online: ${sockets.size}</p></body>`);
      }
      if (url.pathname === '/api/prices' && req.method === 'GET') {
        const gz = /gzip/.test(req.headers['accept-encoding'] || '');
        res.writeHead(200, { 'content-type': 'application/json', ...(gz ? { 'content-encoding': 'gzip' } : {}), ...cors });
        return res.end(gz ? pricePatchGz : JSON.stringify(pricePatch));
      }
      if (req.method === 'POST' && ['/api/register', '/api/login', '/api/logout'].includes(url.pathname)) {
        if (!ipLimit(ipOf(req))) return json(res, 429, { error: 'Too many attempts. Wait a minute.' });
        const body = await readBody(req);
        if (url.pathname === '/api/logout') { await A.logout(db, body.token); return json(res, 200, { ok: true }); }
        if (!nameLimit(String(body.name || '').toLowerCase())) return json(res, 429, { error: 'Too many attempts for this account. Try later.' });
        const r = url.pathname === '/api/register' ? await A.register(db, body.name, body.password) : await A.login(db, body.name, body.password);
        return json(res, 200, { token: r.token, name: r.name });
      }
      json(res, 404, { error: 'Not found' });
    } catch (e) {
      if (e instanceof A.AuthError) return json(res, 400, { error: e.message });
      log('[http]', e);
      json(res, 500, { error: 'Server error' });
    }
  });

  // ---- team ladder: play against other players' saved lineups ------------------------------------------
  const challenged = new Map(); // "a|b" -> time of last challenge
  async function social(user, m, a) {
    if (m === 'ladder') {
      await store.flush().catch(() => {});
      const { rows } = await db.query(`SELECT name, state->'team'->>'name' AS team, (state->'team'->>'elo')::int AS elo,
        (state->'team'->>'w')::int AS w, (state->'team'->>'l')::int AS l FROM users ORDER BY elo DESC NULLS LAST, name LIMIT 30`);
      return { r: rows.map((x) => ({ name: x.name, team: x.team || 'My Team', elo: x.elo ?? 1000, w: x.w || 0, l: x.l || 0, me: x.name === user.name })) };
    }
    if (m === 'challenge') {
      const { rows } = await db.query('SELECT id, name FROM users WHERE name_lc = $1', [String(a.name || '').toLowerCase()]);
      if (!rows.length) throw new GameError('No such player');
      const other = rows[0];
      if (other.id === user.id) throw new GameError('You can’t play yourself');
      const key = user.id + '|' + other.id;
      if (Date.now() - (challenged.get(key) || 0) < 120000) throw new GameError('You played them a moment ago. Try again in two minutes.');
      return store.lock([user.id, other.id], async (entries) => {
        const me = entries.find((e) => e.id === user.id), them = entries.find((e) => e.id === other.id);
        const mine = M.lineupFromState(me.st), theirs = M.lineupFromState(them.st);
        const rm = M.teamRating(mine), rt = M.teamRating(theirs);
        if (!rm.complete) throw new GameError('Fill all five roles first');
        if (!rt.complete) throw new GameError(`${other.name} doesn't have a full team yet`);
        const match = M.simulateMatch({ name: me.st.team.name, lineup: mine }, { name: them.st.team.name, lineup: theirs });
        const won = match.winner === 'A';
        const ea = me.st.team.elo, eb = them.st.team.elo;
        const exp = 1 / (1 + 10 ** ((eb - ea) / 400));
        const dA = Math.round(32 * ((won ? 1 : 0) - exp));
        const ctx = makeCtx(me.st, { online: true });
        const reward = M.matchReward(rm.rating, rt.rating, won);
        credit(ctx, reward);
        const hist = (t, opp, score, w) => [{ opp, score, won: w, at: Date.now() }, ...t.history].slice(0, 20);
        me.st.team = { ...me.st.team, elo: ea + dA, w: me.st.team.w + (won ? 1 : 0), l: me.st.team.l + (won ? 0 : 1), history: hist(me.st.team, `${them.st.team.name} (${other.name})`, match.score, won) };
        them.st.team = { ...them.st.team, elo: eb - dA, w: them.st.team.w + (won ? 0 : 1), l: them.st.team.l + (won ? 1 : 0), history: hist(them.st.team, `${me.st.team.name} (${user.name})`, [match.score[1], match.score[0]], !won) };
        ctx.dirty.add('team');
        await store.commit([me, them]);
        challenged.set(key, Date.now());
        srv.deltaTo(other.id, { set: { team: them.st.team }, add: [], del: [], upd: [] }, `<b>${user.name}</b> challenged your team: ${won ? 'you lost' : 'you won'} ${match.score[1]}-${match.score[0]}`);
        return { r: { match, reward, elo: dA, opp: { name: `${them.st.team.name} (${other.name})`, rating: rt.rating } }, d: delta(ctx) };
      });
    }
    throw new GameError('Unknown request');
  }

  // ---- WebSocket ------------------------------------------------------------------------------------
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MSG });
  const playersList = () => [...sockets.keys()].map((id) => {
    const e = store.cache.get(id);
    return { name: e?.name || '?', online: true, worth: e ? Math.round(e.st.inv.reduce((s, i) => s + itemValue(i), 0)) : 0 };
  });
  const broadcastPlayers = () => { const players = playersList(); for (const id of sockets.keys()) srv.sendTo(id, { t: 'players', players }); };

  wss.on('connection', (ws, req) => {
    let user = null;
    let tokens = 60, lastRefill = Date.now(), lastClick = Date.now();
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    const send = (m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
    const hello = setTimeout(() => { if (!user) ws.close(); }, 15000);

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      // Token bucket: 20 requests per second on average, bursts of 60.
      const now = Date.now();
      tokens = Math.min(60, tokens + ((now - lastRefill) / 1000) * 20);
      lastRefill = now;
      if (--tokens < 0) { if (msg.id) send({ t: 'res', id: msg.id, ok: false, err: 'Slow down a little', code: 'rate' }); return; }

      if (msg.t === 'hello') {
        if (user) return;
        if (msg.v !== PROTOCOL) return send({ t: 'fatal', error: 'Your game is a different version from the server. Update the game.', code: 'version' });
        if (msg.data !== D.generatedAt) return send({ t: 'fatal', error: 'Your game data is a different version from the server. Update the game (or the server).', code: 'version' });
        const u = await A.userForToken(db, msg.token).catch(() => null);
        if (!u) return send({ t: 'fatal', error: 'Your login has expired. Log in again.', code: 'auth' });
        clearTimeout(hello);
        user = u;
        if (!sockets.has(u.id)) sockets.set(u.id, new Set());
        sockets.get(u.id).add(ws);
        store.online.add(u.id);
        let offline = '';
        const state = await store.withUser(u.id, async (e) => {
          const away = (Date.now() - (e.st.lastTick || Date.now())) / 1000;
          const earned = sockets.get(u.id).size === 1 ? tickIdle(e.st, Date.now(), { away: away > 60 }) : 0;
          if (earned >= 0.01 && away > 60) offline = `Welcome back! You earned <b class="green">$${earned.toFixed(2)}</b> while you were away.`;
          store.markDirty(e);
          return e.st;
        });
        send({
          t: 'welcome', user: { id: u.id, name: u.name }, state, offline, pricedAt: D.pricedAt, serverTime: Date.now(),
          players: playersList(), trades: await trades.list(u.id), lobbies: live.snapshot(u.id), market: marketSnapshot(),
        });
        broadcastPlayers();
        return;
      }
      if (!user || msg.t !== 'rpc') return;
      const reply = (ok, body) => send({ t: 'res', id: msg.id, ok, ...body });
      try {
        if (msg.ns === 'act') {
          let args = msg.args || {};
          if (msg.m === 'click') {
            // At most 12 clicks per second since the last batch (plus a small burst allowance).
            const allowed = Math.floor(((Date.now() - lastClick) / 1000) * 12 + 12);
            lastClick = Date.now();
            const n = Math.min(Number(args.n) || 0, allowed, 400);
            args = { n, crits: Math.min(Number(args.crits) || 0, n) };
          }
          const boughtNow = [];
          const out = await store.withUser(user.id, async (e) => {
            tickIdle(e.st, Date.now());
            const ctx = makeCtx(e.st, { online: true, invCap: INV_CAP, reserved: trades.reserved(user.id) });
            // The market's stock is shared by everyone on the server.
            ctx.market = (w) => ({ has: (lid) => soldSet(w).has(lid), add: (lid) => { soldSet(w).add(lid); marketDirty = true; boughtNow.push([w, lid]); } });
            ctx.serial = srv.serial; // serial numbers are counted across the server
            ctx.dirty.add('money');
            const r = runAction(ctx, String(msg.m), args);
            store.markDirty(e);
            return { r, d: delta(ctx) };
          });
          reply(true, { r: out.r, d: out.d });
          for (const [w, lid] of boughtNow) for (const id of sockets.keys()) srv.sendTo(id, { t: 'market', w, lid });
          srv.sendTo(user.id, { t: 'delta', d: out.d }, ws); // other tabs of the same player
          return;
        }
        if (msg.ns === 'social') {
          const out = await social(user, String(msg.m), msg.args || {});
          return reply(true, { r: out.r, d: out.d });
        }
        if (msg.ns === 'trade') return reply(true, { r: await trades.rpc(user, String(msg.m), msg.args || {}) });
        if (msg.ns === 'gamble') return reply(true, { r: await live.rpc(user, String(msg.m), msg.args || {}) });
        reply(false, { err: 'Unknown request' });
      } catch (e) {
        if (e instanceof GameError) return reply(false, { err: e.message, code: e.code });
        log('[rpc]', msg.ns, msg.m, e);
        reply(false, { err: 'Server error, please try again' });
      }
    });

    ws.on('close', () => {
      clearTimeout(hello);
      if (!user) return;
      const set = sockets.get(user.id);
      set?.delete(ws);
      if (set && !set.size) {
        sockets.delete(user.id);
        store.online.delete(user.id);
        // Bank passive income up to now; time away is paid at the offline rate when they come back.
        store.withUser(user.id, async (e) => { tickIdle(e.st, Date.now()); store.markDirty(e); }).catch(() => {});
        broadcastPlayers();
      }
    });
  });

  // Keep connections alive through proxies, and drop dead ones.
  const ping = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);
  // Passive income for connected players, pushed every 10 seconds.
  const idle = setInterval(async () => {
    for (const id of [...sockets.keys()]) {
      await store.withUser(id, async (e) => {
        const earned = tickIdle(e.st, Date.now());
        if (earned > 0) { store.markDirty(e); srv.deltaTo(id, { set: { money: e.st.money }, add: [], del: [], upd: [] }); }
      }).catch(() => {});
    }
  }, 10000);

  await new Promise((r) => server.listen(port, r));
  const actualPort = server.address().port;
  log(`[server] listening on :${actualPort}`);

  async function close() {
    clearInterval(ping); clearInterval(idle); clearInterval(priceTimer); clearInterval(saveMarket); clearInterval(serialTimer);
    await saveSerials();
    if (marketDirty) await db.query("INSERT INTO kv (k, v) VALUES ('market', $1::jsonb) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v", [JSON.stringify(marketSnapshot())]).catch(() => {});
    live.close();
    for (const ws of wss.clients) ws.terminate();
    await new Promise((r) => server.close(() => r()));
    await store.close();
    await db.close();
  }
  return { port: actualPort, close, srv, db, store, refreshPrices };
}

// Run directly: start and shut down cleanly on SIGTERM (Render sends it before stopping an instance).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Set it to your Neon connection string (see DEPLOY.md).');
    process.exit(1);
  }
  const s = await startServer();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log('[server] shutting down…');
    await s.close().catch((e) => console.error(e));
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
