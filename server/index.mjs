// CS2 Case Simulator multiplayer server.
//   node server/index.mjs            (DATABASE_URL=postgres://... for Postgres/Neon; without it an embedded
//                                     Postgres is used: in memory, or on disk with PGLITE_DIR=./server/.data)
//   node server/index.mjs --admins alice,bob --discord-token-file <path>   (dev: staff by name, the bot's token from a file)
// HTTP: GET /health, POST /api/register | /api/login | /api/logout | /api/reset, GET /api/prices
// WebSocket: /ws (protocol described in src/js/net/online.js)
// Staff, bans and the Discord bot: server/admin.mjs and server/discord.mjs (env: ADMIN_USERS, DISCORD_BOT_TOKEN or
// DISCORD_TOKEN_FILE, DISCORD_GUILD_ID, DISCORD_ADMIN_ROLES, DISCORD_MOD_ROLES, DISCORD_LOG_CHANNEL, DISCORD_DROPS_CHANNEL, DISCORD_LINKED_ROLE,
// DISCORD_GATEWAY=0 for an instance that must not run the bot's gateway). TRUST_PROXY=<hops>: only behind reverse
// proxies (Render: 1), the client's address is taken from X-Forwarded-For, that many entries from the right.
// The version lock: server/release.mjs (env: RELEASE_FEED; on by itself when NODE_ENV is production).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { openDb } from './db.mjs';
import { Store } from './store.mjs';
import { Trades } from './trade.mjs';
import { Social } from './social.mjs';
import { Live } from './live.mjs';
import * as A from './accounts.mjs';
import { Admin, banText, networkBanText } from './admin.mjs';
import { Release, releaseFromEnv } from './release.mjs';
import { D, initData } from '../src/js/engine/data.js';
import { makeCtx, runAction, delta, GameError } from '../src/js/engine/actions.js';
import { dropEmbed } from './drops.mjs';
import { marketWindow } from '../src/js/engine/market.js';
import { DB_TYPES, publicCopy } from '../src/js/engine/database.js';
import { ownedValue } from '../src/js/engine/storage.js';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROTOCOL = 1;
const INV_CAP = 3000;
const MAX_MSG = 64 * 1024;
// Requests that end your own offer or round still work while trading or gambling is turned off.
const TRADE_ALWAYS = new Set(['cancel', 'decline']);
const GAMBLE_ALWAYS = new Set(['flip.cancel', 'battle.cancel']);
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
// Actions saved in a transaction before they're answered (others are written within a couple of seconds): what moves
// items in and out of a Storage Unit, uses up a tool or claims an Index reward is never left only in memory.
const IN_TRANSACTION = /^(storage|tools|index)\./;
// What a player opens or trades up to themselves: the rare ones go to the Discord server (see drops.mjs). Not a case battle's
// drops, which another seat may have opened, and not a level-up reward, which isn't opened.
const OPENED = new Set(['case.open', 'armory.redeem', 'tradeup.sign']);

// The bot's options from the environment (false: no token, no bot). The token is read, never logged.
export function discordFromEnv({ env = process.env, tokenFile = env.DISCORD_TOKEN_FILE, log = console.log } = {}) {
  let token = String(env.DISCORD_BOT_TOKEN || '').trim();
  if (!token && tokenFile) {
    try { token = fs.readFileSync(tokenFile, 'utf8').split(/\r?\n/)[0].trim(); } catch (e) {
      log(`[discord] could not read the token file (${e.code || 'error'}): the bot is off`);
      return false;
    }
  }
  token = token.replace(/^Bot\s+/i, '');
  if (!token) return false;
  return {
    token, guildId: env.DISCORD_GUILD_ID || undefined,
    adminRoles: env.DISCORD_ADMIN_ROLES ? list(env.DISCORD_ADMIN_ROLES) : undefined,
    modRoles: env.DISCORD_MOD_ROLES ? list(env.DISCORD_MOD_ROLES) : undefined,
    logChannel: env.DISCORD_LOG_CHANNEL || undefined, dropChannel: env.DISCORD_DROPS_CHANNEL || undefined, linkedRole: env.DISCORD_LINKED_ROLE || undefined,
    gateway: env.DISCORD_GATEWAY !== '0',
  };
}

// No bot on this server: the same methods, doing nothing (server/discord.mjs isn't even loaded).
function noDiscord() {
  const off = { ok: false, error: 'This server isn\'t connected to Discord' };
  return {
    enabled: false, interactions: false,
    status: () => ({ enabled: false, connected: false, ready: false, bot: null, guild: null, guildId: null, error: null }),
    start: async () => null, close() {}, onInteraction() {},
    memberLevel: async () => 0, levelOf: async () => 0, member: async () => null, setLinkedRole: async () => false,
    dm: async () => false, ban: async () => off, unban: async () => off, modLog: async () => null, rareDrop: async () => null,
  };
}

// `discord`: false (no bot), createDiscord's options (tests point them at a stand-in), or undefined (the environment).
async function openDiscord(opt, log) {
  const cfg = opt === undefined ? discordFromEnv({ log }) : opt;
  if (!cfg || !cfg.token) return noDiscord();
  const clean = Object.fromEntries(Object.entries(cfg).filter(([, v]) => v !== undefined)); // (so createDiscord's defaults apply)
  const { createDiscord } = await import('./discord.mjs');
  return createDiscord({ log, ...clean });
}

export async function startServer({
  port = +process.env.PORT || 8787, db: dbOpts = {}, log = console.log, priceRefresh = process.env.PRICE_REFRESH !== '0',
  admins = list(process.env.ADMIN_USERS), discord: discordOpt, trustProxy = process.env.TRUST_PROXY, release: releaseOpt = releaseFromEnv(),
} = {}) {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/data/game-data.json'), 'utf8'));
  initData(data, { keys: JSON.parse(fs.readFileSync(path.join(ROOT, 'src/data/keys.json'), 'utf8')) });
  const db = await openDb(dbOpts);
  log(`[server] database: ${db.kind}`);
  const store = new Store(db, { log });
  const sockets = new Map(); // userId -> Set<ws>
  // The latest kick of each player ({ seq, at, msg }): a hello already under way when it happened is refused with it.
  const kicks = new Map();
  let kickSeq = 0;
  const pricing = require('../shared/pricing.cjs');
  const discord = await openDiscord(discordOpt, log);
  // Tells the Discord server about what was just opened. Nothing here may touch the opening itself: it's already paid for.
  const announceDrops = (name, items) => {
    try {
      for (const it of items || []) {
        const embed = dropEmbed(name, it);
        if (embed) Promise.resolve(discord.rareDrop(embed)).catch((e) => log('[discord] rare drop failed', e?.message || e));
      }
    } catch (e) { log('[discord] rare drop failed', e?.message || e); }
  };
  log(discord.enabled ? '[discord] bot configured' : '[discord] no bot (set DISCORD_BOT_TOKEN to link accounts and use Discord roles)');

  const srv = {
    db, store, log, INV_CAP, sockets, discord,
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
    // Throws a player off: `fatal` to each of their connections, which then close (and ignore anything still coming).
    kick(id, { code, error, ban } = {}) {
      kicks.set(id, { seq: ++kickSeq, at: Date.now(), msg: { t: 'fatal', code, error, ...(ban ? { ban } : {}) } });
      const set = sockets.get(id);
      if (!set) return false;
      const text = JSON.stringify(kicks.get(id).msg);
      for (const ws of [...set]) {
        ws.kicked = true;
        if (ws.readyState === 1) ws.send(text);
        ws.close(1000);
      }
      sockets.delete(id);
      store.online.delete(id);
      broadcastPlayers();
      return true;
    },
    async pushAccount(id) {
      if (!sockets.has(id)) return;
      srv.sendTo(id, { t: 'account', account: await admin.account(id) });
    },
    broadcastMsg(msg) {
      for (const id of sockets.keys()) srv.sendTo(id, msg);
      return sockets.size;
    },
    broadcastPlayers: () => broadcastPlayers(),
  };
  const trades = new Trades(srv);
  srv.trades = trades;
  await trades.init();
  const socials = new Social(srv);
  srv.social = socials;
  const live = new Live(srv);
  srv.live = live;
  await live.refundOpen();
  const admin = new Admin(srv, discord, { admins });
  srv.admin = admin;
  await admin.init();
  const release = new Release(srv, releaseOpt);
  srv.release = release;
  await release.init();

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
  // The client's address (rate limits, network bans): the connection's own, unless TRUST_PROXY says how many reverse
  // proxies in front each append the address they saw to X-Forwarded-For. Then it's the entry that many from the
  // right: anything to its left came from the client, who can write whatever they like there.
  const hops = Math.max(0, Math.floor(Number(trustProxy) || 0));
  const ipOf = (req) => {
    if (hops) {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (xff.length >= hops) return xff[xff.length - hops];
    }
    return req.socket.remoteAddress || '?';
  };
  log(hops ? `[server] client addresses: X-Forwarded-For, ${hops} proxy hop${hops === 1 ? '' : 's'} (TRUST_PROXY)` : '[server] client addresses: the connection\'s own (no TRUST_PROXY)');

  const server = http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400, cors); return res.end(); }
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    try {
      if (url.pathname === '/health') return json(res, 200, { ok: true, online: sockets.size, data: D.generatedAt, pricedAt: D.pricedAt, requiredVersion: release.required, discord: { connected: !!discord.status().connected } });
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(`<!doctype html><title>CS2 Case Simulator server</title><body style="font-family:system-ui;background:#0a0d12;color:#e8eef5;padding:40px">
          <h1>CS2 Case Simulator server</h1><p>This server is running. To play online, click <b>Offline</b> at the top right of the game and log in.</p>
          <p>Players online: ${sockets.size}</p></body>`);
      }
      if (url.pathname === '/api/prices' && req.method === 'GET') {
        const gz = /gzip/.test(req.headers['accept-encoding'] || '');
        res.writeHead(200, { 'content-type': 'application/json', ...(gz ? { 'content-encoding': 'gzip' } : {}), ...cors });
        return res.end(gz ? pricePatchGz : JSON.stringify(pricePatch));
      }
      if (req.method === 'POST' && ['/api/register', '/api/login', '/api/logout', '/api/reset'].includes(url.pathname)) {
        const ip = ipOf(req);
        if (!ipLimit(ip)) return json(res, 429, { error: 'Too many attempts. Wait a minute.' });
        const body = await readBody(req);
        if (url.pathname === '/api/logout') { await A.logout(db, body.token); return json(res, 200, { ok: true }); }
        if (!nameLimit(String(body.name || '').toLowerCase())) return json(res, 429, { error: 'Too many attempts for this account. Try later.' });
        if (url.pathname === '/api/reset') return json(res, 200, await admin.resetPassword(body.name, body.code, body.password));
        const ipHash = admin.ipHash(ip);
        let r;
        if (url.pathname === '/api/register') {
          if (!admin.settings.registration) return json(res, 403, { error: 'New accounts are closed right now' });
          const ban = await admin.activeBan({ ipHash });
          if (ban) return json(res, 403, { error: networkBanText(ban), ban: { reason: ban.reason, expires: ban.expires, by: ban.by } });
          r = await A.register(db, body.name, body.password);
        } else {
          // A banned account (or one on a banned network) gets no session; maintenance only stops the WebSocket.
          r = await A.login(db, body.name, body.password, {
            check: async (u) => {
              const ban = await admin.activeBan({ userId: u.id, ipHash });
              if (ban) throw new A.AuthError(banText(ban), 403, { ban: { reason: ban.reason, expires: ban.expires, by: ban.by } });
            },
          });
        }
        await admin.noteIp(r.id, ip);
        return json(res, 200, { token: r.token, name: r.name });
      }
      json(res, 404, { error: 'Not found' });
    } catch (e) {
      if (e instanceof A.AuthError) return json(res, e.status || 400, { error: e.message, ...(e.extra || {}) });
      log('[http]', e);
      json(res, 500, { error: 'Server error' });
    }
  });

  // The item database reads everyone's saved inventories: what's still only in memory is written first (at most every
  // few seconds), and the counts of every item are kept a little while.
  let dbIndex = null, dbFlushed = 0;
  const dbFresh = async () => { if (Date.now() - dbFlushed > 4000) { dbFlushed = Date.now(); await store.flush().catch(() => {}); } };
  const DB_IN = DB_TYPES.map((t) => `'${t}'`).join(', ');
  // Everything a player owns, for a FROM clause: what's in their Storage Units counts as much as their inventory.
  const OWNED = (u) => `jsonb_array_elements(COALESCE(${u}.state->'inv', '[]'::jsonb) || COALESCE(${u}.state->'stored', '[]'::jsonb))`;

  // (ws: the connection asking, which a push to the player's other tabs leaves out)
  async function social(user, m, a, ws) {
    // The item database: how many copies of each item there are on the server, and every copy of one with its owner.
    if (m === 'db.index') {
      if (!dbIndex || Date.now() - dbIndex.at > 15000) {
        await dbFresh();
        const { rows } = await db.query(`SELECT it->>'t' AS t, it->>'id' AS id, count(*)::int AS n
          FROM users u, ${OWNED('u')} AS it WHERE it->>'t' IN (${DB_IN}) GROUP BY 1, 2`);
        const { rows: [u] } = await db.query('SELECT count(*)::int AS n FROM users');
        dbIndex = { at: Date.now(), counts: Object.fromEntries(rows.map((x) => [x.t + ':' + x.id, x.n])), players: u.n };
      }
      return { r: { counts: dbIndex.counts, players: dbIndex.players } };
    }
    if (m === 'db.item') {
      const t = String(a.t || ''), id = String(a.id || '').slice(0, 80);
      if (!DB_TYPES.includes(t) || !id) throw new GameError('Unknown item');
      await dbFresh();
      const { rows } = await db.query(`SELECT u.id, u.name, it FROM users u, ${OWNED('u')} AS it
        WHERE it->>'t' = $1 AND it->>'id' = $2 LIMIT 5000`, [t, id]);
      const row = (x) => ({ owner: x.name, id: x.id, me: x.id === user.id, item: publicCopy(typeof x.it === 'string' ? JSON.parse(x.it) : x.it) });
      // A sticker: also the guns it's applied to.
      const applied = t !== 'sticker' ? [] : (await db.query(`SELECT u.id, u.name, it FROM users u, ${OWNED('u')} AS it
        WHERE it->'stk' @> $1::jsonb LIMIT 5000`, [JSON.stringify([{ id }])])).rows;
      return { r: { copies: rows.map(row), applied: applied.map(row) } };
    }
    if (m === 'db.ranks') {
      // Every copy of the skins you own, ranked by float in its category (lowest and highest, as floatRanks does it):
      // { uid: { low?, high?, of, cat } } for your copies in a top three.
      await dbFresh();
      const { rows } = await db.query(`WITH c AS (
          SELECT u.id AS owner, it->>'uid' AS uid, it->>'id' AS sid, (it->>'fl')::float8 AS fl, COALESCE((it->>'at')::float8, 0) AS at,
            CASE WHEN it->>'sv' = 'true' THEN 'sv' WHEN it->>'stt' = 'true' THEN 'st' ELSE 'n' END AS cat
          FROM users u, ${OWNED('u')} AS it
          WHERE it->>'t' = 'skin' AND it->>'fl' IS NOT NULL AND it->>'id' IN (
            SELECT mine->>'id' FROM users me, ${OWNED('me')} AS mine WHERE me.id = $1 AND mine->>'t' = 'skin')
        ), r AS (
          SELECT owner, uid, cat, COUNT(*) OVER w AS n,
            ROW_NUMBER() OVER (PARTITION BY sid, cat ORDER BY fl ASC, at ASC, uid ASC) AS low,
            ROW_NUMBER() OVER (PARTITION BY sid, cat ORDER BY fl DESC, at DESC, uid DESC) AS high
          FROM c WINDOW w AS (PARTITION BY sid, cat))
        SELECT uid, cat, n::int AS n, low::int AS low, high::int AS high FROM r WHERE owner = $1 AND n >= 2 AND (low <= 3 OR high <= 3)`, [user.id]);
      const out = {};
      for (const x of rows) out[x.uid] = { ...(x.low <= 3 ? { low: x.low } : {}), ...(x.high <= 3 ? { high: x.high } : {}), of: x.n, cat: x.cat };
      return { r: out };
    }
    return { r: await socials.rpc(user, m, a, ws) }; // (friends, chat and profiles)
  }

  // ---- WebSocket ------------------------------------------------------------------------------------
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MSG });
  const playersList = () => [...sockets.keys()].map((id) => {
    const e = store.cache.get(id);
    return { name: e?.name || '?', online: true, worth: e ? Math.round(ownedValue(e.st)) : 0 };
  });
  const broadcastPlayers = () => { const players = playersList(); for (const id of sockets.keys()) srv.sendTo(id, { t: 'players', players }); };

  wss.on('connection', (ws, req) => {
    let user = null, greeting = false;
    let tokens = 60, lastRefill = Date.now();
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    const send = (m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
    // A refused hello: the reason, then the connection closes (the game closes it too, on reading it).
    const refuse = (m) => { send(m); setTimeout(() => { if (!user && ws.readyState === 1) ws.close(1000); }, 1000).unref?.(); };
    const hello = setTimeout(() => { if (!user) ws.close(); }, 15000);

    // (A frame the socket can't read, too long or broken: ws closes the connection itself, but an error nobody listens for ends
    // the server.)
    ws.on('error', () => {});
    const onMessage = async (raw) => {
      if (ws.kicked) return; // (thrown off: what was already on its way is ignored)
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      // Token bucket: 20 requests per second on average, bursts of 60.
      const now = Date.now();
      tokens = Math.min(60, tokens + ((now - lastRefill) / 1000) * 20);
      lastRefill = now;
      if (--tokens < 0) { if (msg.id) send({ t: 'res', id: msg.id, ok: false, err: 'Slow down a little', code: 'rate' }); return; }

      if (msg.t === 'hello') {
        if (user || greeting) return;
        const outdated = release.refusal(msg.app); // (first: an old game gets the reason it can read, whatever else differs)
        if (outdated) return refuse(outdated);
        if (msg.v !== PROTOCOL) return refuse({ t: 'fatal', error: 'Your game is a different version from the server. Update the game.', code: 'version' });
        if (msg.data !== D.generatedAt) return refuse({ t: 'fatal', error: 'Your game data is a different version from the server. Update the game (or the server).', code: 'version' });
        greeting = true;
        const began = kickSeq; // (a kick from here on that this hello's checks can't have seen)
        try {
          const u = await A.userForToken(db, msg.token).catch(() => null);
          if (!u) return refuse({ t: 'fatal', error: 'Your login has expired. Log in again.', code: 'auth' });
          const ip = ipOf(req), ipHash = admin.ipHash(ip);
          await admin.noteIp(u.id, ip);
          const ban = await admin.activeBan({ userId: u.id, ipHash });
          if (ban) return refuse({ t: 'fatal', code: 'banned', error: banText(ban), ban: { reason: ban.reason, expires: ban.expires, by: ban.by } });
          if (admin.settings.maintenance && await admin.levelOf(u.id, { fast: true }) < 1) return refuse({ t: 'fatal', code: 'maintenance', error: admin.maintenanceMsg() });
          if (ws.readyState !== 1) return;
          // Kicked (banned, signed out, a new password...) while the checks above were waiting: the kick only reached the
          // connections registered then, so this one goes too. From the next line on, a kick finds it in `sockets`.
          const kicked = kicks.get(u.id);
          if (kicked && kicked.seq > began) return refuse(kicked.msg);
          clearTimeout(hello);
          user = u;
          ws.user = u; // (a rename updates the name its requests use)
          ws.ipHash = ipHash; // (a network ban throws off every account connected from it)
          ws.app = msg.app; // (a new release drops the versions it leaves behind)
          if (!sockets.has(u.id)) sockets.set(u.id, new Set());
          sockets.get(u.id).add(ws);
          store.online.add(u.id);
          const state = await store.withUser(u.id, async (e) => e.st);
          send({
            t: 'welcome', user: { id: u.id, name: u.name }, state, pricedAt: D.pricedAt, serverTime: Date.now(),
            players: playersList(), trades: await trades.list(u.id), lobbies: live.snapshot(u.id), market: marketSnapshot(),
            account: await admin.account(u.id), motd: admin.settings.motd || '',
          });
          broadcastPlayers();
        } catch (e) {
          log('[ws] hello failed', e);
          ws.close(1011);
        } finally {
          greeting = false;
        }
        return;
      }
      if (!user || msg.t !== 'rpc') return;
      const reply = (ok, body) => send({ t: 'res', id: msg.id, ok, ...body });
      try {
        if (msg.ns === 'act') {
          // (the games against bots are gambling too)
          if (!admin.settings.gambling && /^gamble\./.test(String(msg.m))) throw new GameError('Gambling is turned off on this server right now', 'off');
          const args = msg.args || {};
          const boughtNow = [];
          const out = await store.withUser(user.id, async (e) => {
            const ctx = makeCtx(e.st, { online: true, invCap: INV_CAP, reserved: trades.reserved(user.id), asked: trades.asked(user.id) });
            // The market's stock is shared by everyone on the server.
            ctx.market = (w) => ({ has: (lid) => soldSet(w).has(lid), add: (lid) => { soldSet(w).add(lid); marketDirty = true; boughtNow.push([w, lid]); } });
            ctx.serial = srv.serial; // serial numbers are counted across the server
            ctx.dirty.add('money');
            const r = runAction(ctx, String(msg.m), args);
            store.markDirty(e);
            if (IN_TRANSACTION.test(String(msg.m))) await store.commit([e]);
            return { r, d: delta(ctx) };
          });
          reply(true, { r: out.r, d: out.d });
          for (const [w, lid] of boughtNow) for (const id of sockets.keys()) srv.sendTo(id, { t: 'market', w, lid });
          srv.sendTo(user.id, { t: 'delta', d: out.d }, ws); // other tabs of the same player
          if (OPENED.has(String(msg.m))) announceDrops(user.name, out.r.items || [out.r.item]);
          return;
        }
        if (msg.ns === 'social') {
          const out = await social(user, String(msg.m), msg.args || {}, ws);
          return reply(true, { r: out.r, d: out.d });
        }
        if (msg.ns === 'trade') {
          if (!admin.settings.trading && !TRADE_ALWAYS.has(String(msg.m))) throw new GameError('Trading is turned off on this server right now', 'off');
          return reply(true, { r: await trades.rpc(user, String(msg.m), msg.args || {}) });
        }
        if (msg.ns === 'gamble') {
          if (!admin.settings.gambling && !GAMBLE_ALWAYS.has(String(msg.m))) throw new GameError('Gambling is turned off on this server right now', 'off');
          return reply(true, { r: await live.rpc(user, String(msg.m), msg.args || {}) });
        }
        if (msg.ns === 'account') return reply(true, { r: await admin.accountRpc(user, String(msg.m), msg.args || {}) });
        if (msg.ns === 'admin') return reply(true, { r: await admin.rpc(user, String(msg.m), msg.args || {}) });
        reply(false, { err: 'Unknown request' });
      } catch (e) {
        if (e instanceof GameError) return reply(false, { err: e.message, code: e.code });
        log('[rpc]', msg.ns, msg.m, e);
        reply(false, { err: 'Server error, please try again' });
      }
    };
    // (Whatever one connection sends, it's the connection that ends and not the server.)
    ws.on('message', (raw) => onMessage(raw).catch((e) => { log('[ws]', e); ws.close(1011); }));

    ws.on('close', () => {
      clearTimeout(hello);
      if (!user) return;
      const set = sockets.get(user.id);
      set?.delete(ws);
      if (set && !set.size) {
        sockets.delete(user.id);
        store.online.delete(user.id);
        broadcastPlayers();
        socials.left(user.id).catch((e) => log('[social] left failed', e?.message || e));
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
    for (const [id, k] of kicks) if (Date.now() - k.at > 120000) kicks.delete(id); // (no hello waits that long)
  }, 30000);

  await new Promise((r) => server.listen(port, r));
  const actualPort = server.address().port;
  log(`[server] listening on :${actualPort}`);
  // The bot connects in the background; nothing waits for Discord.
  if (discord.enabled) Promise.resolve().then(() => discord.start()).catch((e) => log('[discord] start failed', e?.message || e));

  async function close() {
    clearInterval(ping); clearInterval(priceTimer); clearInterval(saveMarket); clearInterval(serialTimer);
    admin.close();
    release.close();
    socials.close();
    try { discord.close(); } catch (e) { log('[discord] close failed', e?.message || e); }
    await saveSerials();
    if (marketDirty) await db.query("INSERT INTO kv (k, v) VALUES ('market', $1::jsonb) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v", [JSON.stringify(marketSnapshot())]).catch(() => {});
    live.close();
    for (const ws of wss.clients) ws.terminate();
    await new Promise((r) => server.close(() => r()));
    await store.close();
    await db.close();
  }
  return { port: actualPort, close, srv, db, store, refreshPrices, admin, discord };
}

// Run directly: start and shut down cleanly on SIGTERM (Render sends it before stopping an instance).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Set it to your Neon connection string (see DEPLOY.md).');
    process.exit(1);
  }
  // Dev conveniences: --admins a,b (as ADMIN_USERS) and --discord-token-file <path> (as DISCORD_TOKEN_FILE).
  const argv = process.argv.slice(2);
  const arg = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const admins = arg('--admins'), tokenFile = arg('--discord-token-file');
  const s = await startServer({
    ...(admins != null ? { admins: list(admins) } : {}),
    ...(tokenFile ? { discord: discordFromEnv({ tokenFile }) } : {}),
  });
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
