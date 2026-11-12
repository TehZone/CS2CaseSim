// CS2 Case Simulator multiplayer server.
//   node server/index.mjs            (DATABASE_URL=postgres://... for Postgres/Neon; without it an embedded
//                                     Postgres is used: in memory, or on disk with PGLITE_DIR=./server/.data)
//   node server/index.mjs --admins alice,bob --discord-token-file <path>   (dev: staff by name, the bot's token from a file)
// HTTP: GET /health, POST /api/register | /api/login | /api/logout | /api/reset, GET /api/prices (brotli, gzip or plain, by
// the request's Accept-Encoding), GET /pic/<hash> and POST /api/pic (players' profile pictures: face1, server/social.mjs)
// WebSocket: /ws (protocol described in src/js/net/online.js), compressed with permessage-deflate when the game offers it
// (Chromium and Electron always do; see DEFLATE). /match: an online PvP match's traffic (server/relay.mjs), never compressed;
// every other path is refused as before (a 400). Capabilities: a game names the newer message shapes it understands in its
// hello (caps: ['lean1']), and the server answers with the ones it will use (welcome.caps). Only a connection that announced
// a capability is sent its shapes; a game that announces none (1.1.2 and older) gets exactly what it always got. See CAPS.
// Staff, bans and the Discord bot: server/admin.mjs and server/discord.mjs (env: ADMIN_USERS, DISCORD_BOT_TOKEN or
// DISCORD_TOKEN_FILE, DISCORD_GUILD_ID, DISCORD_ADMIN_ROLES, DISCORD_MOD_ROLES, DISCORD_LOG_CHANNEL, DISCORD_DROPS_CHANNEL, DISCORD_LINKED_ROLE,
// DISCORD_GATEWAY=0 for an instance that must not run the bot's gateway). TRUST_PROXY=<hops>: only behind reverse
// proxies (Render: 1, Caddy on the same machine: 1), the client's address is taken from X-Forwarded-For, that many
// entries from the right. HOST=<address>: listen on that address only (127.0.0.1 behind a proxy on the same machine,
// deploy/vps); unset, every interface. /health's `commit`: SERVER_COMMIT (deploy/vps/deploy.sh writes it) or
// RENDER_GIT_COMMIT (Render sets it), null without either.
// The version lock: server/release.mjs (env: RELEASE_FEED; on by itself when NODE_ENV is production).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, PerMessageDeflate, extension } from 'ws';
import { openDb } from './db.mjs';
import { Store } from './store.mjs';
import { Trades } from './trade.mjs';
import { Social } from './social.mjs';
import { Live } from './live.mjs';
import * as A from './accounts.mjs';
import { Admin, banText, networkBanText } from './admin.mjs';
import { Release, releaseFromEnv } from './release.mjs';
import { Passive, PASSIVE_TICK_MS } from './passive.mjs';
import { P2PMarket, P2P } from './p2pmarket.mjs';
import { PvP, PVP } from './matchmaking.mjs';
import { Relay } from './relay.mjs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { D, initData } from '../src/js/engine/data.js';
import { lockBase, dataLock, hasCustom, customPriceHash, stableJson } from '../src/js/engine/custom.js';
import { hasBadges, badgeLock, withBadges } from '../src/js/engine/badgedata.js';
import { makeCtx, runAction, delta, GameError } from '../src/js/engine/actions.js';
import { dropEmbed } from './drops.mjs';
import { marketWindow } from '../src/js/engine/market.js';
import { DB_TYPES, publicCopy } from '../src/js/engine/database.js';
import { ownedValue } from '../src/js/engine/storage.js';
import { forConnection, leanAct, leanPush, leanState, statsBefore, storedOfUnit, sumsSent, unitSums, unitsChange } from './lean.mjs';

const require = createRequire(import.meta.url);
const { parseVersion, compareVersions } = require('../shared/release.cjs');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROTOCOL = 1;
// Capabilities a game can announce in its hello. Each names a set of message shapes, frozen once a game that announces it is
// released: a later change to them is a new name (lean2), and the server keeps answering the old one until a release
// requires a newer game. A connection's own set is ws.caps; srv.lean(ws) is the test for lean1.
//   lean1: the players list as changes after the welcome ({ t: 'players.d' }); gamble lobbies only while the game says its
//          Gamble page is open ({ t: 'sub', lobbies }), at most about once a second (at once to the round's own players),
//          and not in the welcome; trade offers as the ones that changed ({ t: 'trades.d' }; a closed one as its new status
//          only), and an accept's answer without its d. An action's answer and changes without the same item twice, the
//          stats as what changed, item.seen as uids; the welcome without what's in Storage Units, asked for a unit at a time
//          (social 'stored'), and changes with the sums of the units they changed. The shapes are in src/js/net/online.js
//          and server/lean.mjs.
//   (Not a shape, so not a capability: case.open's buy, which a server has from the deploy that brought it. A game uses it
//   only on a server whose welcome names lean1, which came with it.)
//   p2p1:  the Market (server/p2pmarket.mjs): its listings' changes ({ t: 'p2p.d' }), only while the game says its Market page
//          is open ({ t: 'sub', p2p }). Its requests (ns 'p2p') are new ones: a game uses them on a server whose welcome names
//          p2p1.
//   face1: players' faces (server/social.mjs): a Person (social home, find, profile, and the chat push's `who`) with `pic`,
//          their own profile picture's hash (GET /pic/<hash>), and `badge`, the badge they feature; a profile with `badges`,
//          and profile.set's answer with its pic and badge; the staff panel's reports and players with their pictures (pic,
//          about.pic, user.pic, and user.avatar and user.badge); and { t: 'faces.d', ids }, the players whose faces changed
//          (social.mjs facesChanged). Its requests are new ones: social 'faces', POST /api/pic and admin 'pic.clear' and
//          'pic.get', used on a server whose welcome names face1.
//   pvp1:  online PvP matches (server/matchmaking.mjs, server/relay.mjs, engine/pvp.js): the requests of ns 'pvp' (queue, leave,
//          accept, decline, state, abandon; a game without pvp1 is refused, 'outdated'), their pushes ({ t: 'pvp.q' } to the
//          connection that queued, and pvp.found, pvp.accepts, pvp.go, pvp.cancel, pvp.paid and pvp.over to the player's pvp1
//          connections), tagged pings while queued (a ping's payload [0x70][f64], which the game's socket answers by itself: the
//          round trip that picks a match's host), the /match socket, and the admin panel's 'pvp.live' and 'pvp.end'. A game
//          without it is sent none of these.
export const LEAN = 'lean1';
export const FACE = 'face1';
export const CAPS = new Set([LEAN, P2P, FACE, PVP]);
// A profile picture's upload: its base64 in JSON, with the login's token (64 KB of picture, engine/picture.js). A body
// past the limit is read to its end (up to BODY_DRAIN, then the connection is cut) so the 413 reaches the game.
const PIC_BODY = 96 * 1024, BODY_DRAIN = 1024 * 1024;
// The rules of the release before the badges' (1.1.5), which the server keeps while it runs no badges at all (with the release
// gates on: the first badges wait for their release, badgeGate). They ship together, and until then the published game says
// $100 a minute and 20 Storage Units at most, and was built for that many. Once the release is out the server starts again
// with the badges, and without these (engine defaults: 100 units, $100 more a minute for each prestige: storage.js MAX_UNITS,
// levels.js PASSIVE). Later badges waiting for their own release don't bring these back: the server runs the ones it ran
// last meanwhile. makeCtx's options.
export const HELD_RULES = Object.freeze({ maxUnits: 20, prestige: false });
// WebSocket compression (permessage-deflate, RFC 7692). Each connection keeps its zlib streams between messages (context
// takeover, ws's default, kept on purpose): a message is compressed against the ones before it, which is what makes a small
// one, a reply or a lobbies push, shrink to a few dozen bytes. ws's 1 KB threshold only applies without context takeover.
// A 16 KB window (server_max_window_bits=14) and memLevel 6 compressed a replay of a real session (a 1,500-item welcome, 60
// rounds of auto-open, 30 joins) as well as zlib's defaults (32 KB, 8) did: 10.6% of the raw bytes against 10.7%; 8 KB would
// be 11.1%, 4 KB 14%. Measured, a compressed connection then takes about 0.3 MB of the server's memory (0.45 MB with the
// defaults, 0.05 MB uncompressed), so 100 players about 30 MB. The client's own window (client_max_window_bits) is left to
// it: asking for a size would refuse a game that doesn't offer one.
const DEFLATE = { serverMaxWindowBits: 14, zlibDeflateOptions: { memLevel: 6 } };
const INV_CAP = 3000;
const MAX_MSG = 64 * 1024;
// Requests that end your own offer or round still work while trading or gambling is turned off (and the list of offers
// can always be read: the welcome has it anyway).
const TRADE_ALWAYS = new Set(['cancel', 'decline', 'list']);
const GAMBLE_ALWAYS = new Set(['flip.cancel', 'battle.cancel']);
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
// Whether an Accept-Encoding header takes brotli: `br` listed, and not with q=0.
const acceptsBrotli = (ae) => list(ae).some((part) => {
  const [name, ...params] = part.split(';').map((s) => s.trim());
  if (name.toLowerCase() !== 'br') return false;
  const q = params.find((p) => /^q\s*=/i.test(p));
  return !q || Number(q.replace(/^q\s*=\s*/i, '')) > 0;
});
// Actions saved in a transaction before they're answered (others are written within a couple of seconds): what moves
// items in and out of a Storage Unit, uses up a tool or claims an Index reward is never left only in memory. (A unit's label
// moves nothing: it goes with the next save.) Each writes the player's whole state, which with 100 full Storage Units is
// about 19 MB and over 100 ms of the server's thread: a player with more than HEAVY_STORED items stored can send TX_MAX of
// them in TX_MS (more than anyone clicks; 20 full units, the old most, cost a fifth as much and go unlimited).
const IN_TRANSACTION = /^(storage\.(?!name$)|tools\.|index\.)/;
const HEAVY_STORED = 20000, TX_MAX = 10, TX_MS = 10000;
// What a player opens or trades up to themselves: the rare ones go to the Discord server (see drops.mjs). Not a case battle's
// drops, which another seat may have opened, and not a level-up reward, which isn't opened.
const OPENED = new Set(['case.open', 'armory.redeem', 'tradeup.sign']);

// src/data/custom.json (custom content, built by scripts/build-custom.mjs), or null when there is none. One that's there
// but can't be read stops the server: without it its lock would let in no game built with it.
export function readCustom(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  return JSON.parse(text);
}

// The release gate: which custom content the server runs. A build of custom content into the game says the version it
// ships in (custom.app, stamped by scripts/build-custom.mjs). Games without that content can't play with a server that has
// it (the data lock), and nobody has it before that version's release is published. So with the release feed on
// (server/release.mjs, production), content whose lock differs from what the server ran last waits for that release:
// until the feed's required version is at least custom.app, the server runs the content it ran last (kept in the database,
// kv 'custom': what the published release has), or none. Pushing new custom content before publishing its release then
// locks no game out, 1.1.3 included. Once the release is out the server restarts into it (startServer's `restart`).
// Content with the same lock (new prices, new textures) runs at once. Without the release feed (development, tests) the
// file's content always runs.
// Returns { use: the custom content to run, held: null or { app, lock } (what waits), save: what to keep as run last }.
export async function customGate({ db, custom, generatedAt, releaseOn, log = () => {} }) {
  const lockOf = (c) => dataLock(generatedAt, hasCustom(c) ? c : null);
  if (!releaseOn) return { use: custom, held: null, save: false, live: null };
  const kv = async (k) => {
    const { rows } = await db.query('SELECT v FROM kv WHERE k = $1', [k]);
    return rows[0] && (typeof rows[0].v === 'string' ? JSON.parse(rows[0].v) : rows[0].v);
  };
  let live = null, required = null;
  // (Kept as its text: jsonb would reorder its keys, and a skin's prices are in wear order.)
  try { const k = await kv('custom'); live = typeof k?.json === 'string' ? JSON.parse(k.json) : null; } catch (e) { log('[custom] could not read the custom content run last', e.message); }
  try { required = (await kv('release'))?.version ?? null; } catch (e) { log('[custom] could not read the required version', e.message); }
  live = hasCustom(live) ? live : null;
  const lock = lockOf(custom), go = { use: custom, held: null, save: true, live };
  if (lock === lockOf(live)) return go;
  // (Content removed: there's no version to wait for, so it goes at once; CUSTOM_CONTENT.md says to release that quickly.)
  if (!hasCustom(custom)) return go;
  const app = parseVersion(custom.app) ? custom.app : null;
  if (app && required && compareVersions(required, app) >= 0) return go;
  log(`[custom] custom content for version ${app || '(none: rebuild it with npm run custom)'} waits for its release (required now: ${required || 'none'}): `
    + `running ${live ? 'the custom content run last' : 'none'} until then (data lock ${lockOf(live)})`);
  return { use: live, held: { app, lock }, save: false, live };
}

// The same gate for badges (src/data/badges.json, CS2's collectibles and the Collectible Pins Capsules: engine/badgedata.js),
// which are part of the data lock too (its `+bd.` part). Badges whose lock differs from the ones the server ran last (kv
// 'badges') wait, with the release feed on, until the release they ship in (badges.app) is published; until then the server
// runs the badges it ran last, or none: what the published release has. So pushing them keeps every game on the release
// before playing, exactly as it did. Without the feed the file's badges always run.
// Returns { use, held: null or { app, lock (the badges' part of the lock) }, save, live }.
export async function badgeGate({ db, badges, releaseOn, log = () => {} }) {
  const lockOf = (b) => badgeLock(hasBadges(b) ? b : null);
  if (!releaseOn) return { use: badges, held: null, save: false, live: null };
  const kv = async (k) => {
    const { rows } = await db.query('SELECT v FROM kv WHERE k = $1', [k]);
    return rows[0] && (typeof rows[0].v === 'string' ? JSON.parse(rows[0].v) : rows[0].v);
  };
  let live = null, required = null;
  try { const k = await kv('badges'); live = typeof k?.json === 'string' ? JSON.parse(k.json) : null; } catch (e) { log('[badges] could not read the badges run last', e.message); }
  try { required = (await kv('release'))?.version ?? null; } catch (e) { log('[badges] could not read the required version', e.message); }
  live = hasBadges(live) ? live : null;
  const go = { use: badges, held: null, save: true, live };
  if (lockOf(badges) === lockOf(live)) return go;
  if (!hasBadges(badges)) return go; // (taken out: nothing to wait for)
  const app = parseVersion(badges.app) ? badges.app : null;
  if (app && required && compareVersions(required, app) >= 0) return go;
  log(`[badges] badges for version ${app || '(none: rebuild them with node scripts/build-badges.mjs --app <version>)'} wait for their release (required now: ${required || 'none'}): `
    + `running ${live ? 'the badges run last' : 'none'} until then`);
  return { use: live, held: { app, lock: lockOf(badges) }, save: false, live };
}

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
  port = +process.env.PORT || 8787, host = process.env.HOST || undefined, db: dbOpts = {}, log = console.log, priceRefresh = process.env.PRICE_REFRESH !== '0',
  admins = list(process.env.ADMIN_USERS), discord: discordOpt, trustProxy = process.env.TRUST_PROXY, release: releaseOpt = releaseFromEnv(),
  commit = process.env.SERVER_COMMIT || process.env.RENDER_GIT_COMMIT || null,
  // Passive income (server/passive.mjs): the server's clock, and how often it looks for whole minutes due (tests set both).
  clock = Date.now, passiveTick = PASSIVE_TICK_MS,
  // Custom content (src/js/engine/custom.js): undefined reads src/data/custom.json if there is one; tests pass a build's
  // object, or false for none. restart: how the server starts again (run directly: it stops, and systemd starts it), for
  // custom content that waited for its release (customGate) once the release is out. badges: as custom, for
  // src/data/badges.json (badgeGate).
  custom: customOpt, badges: badgesOpt, restart = null,
  // Whether the release gates hold back what waits for a release (customGate, badgeGate): with the release feed on, and in
  // production always. RELEASE_FEED=off there (DEPLOY.md's emergency switch) lets every version in, but the server keeps
  // running what the published release has: a lock that no published game has would lock everyone out instead.
  gated = releaseOpt !== false || process.env.NODE_ENV === 'production',
  // Online PvP (server/matchmaking.mjs): { tick: false } and the tests run its clock themselves; fillAfter (ms), how long a
  // queue waits before it splits the players it has (PVP_FILL_AFTER_S, in seconds, outside production: a playtest's shorter
  // wait); relay: server/relay.mjs's options.
  pvp: pvpOpt = {},
} = {}) {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/data/game-data.json'), 'utf8'));
  const custom = customOpt === undefined ? readCustom(path.join(ROOT, 'src/data/custom.json')) : customOpt || null;
  const badges = badgesOpt === undefined ? readCustom(path.join(ROOT, 'src/data/badges.json')) : badgesOpt || null;
  const db = await openDb(dbOpts);
  log(`[server] database: ${db.kind}`);
  const gate = await customGate({ db, custom, generatedAt: data.generatedAt, releaseOn: !!gated, log });
  const bgate = await badgeGate({ db, badges, releaseOn: !!gated, log });
  initData(data, { keys: JSON.parse(fs.readFileSync(path.join(ROOT, 'src/data/keys.json'), 'utf8')), custom: gate.use, badges: bgate.use });
  if (D.cx) log(`[server] custom content: ${D.cx.skins} skins, ${D.cx.cases} cases (data lock ${D.lock})`);
  if (D.bd) log(`[server] badges: ${D.bd.badges}, ${D.bd.cases} pin capsules (data lock ${D.lock})`);
  // What waits for a release, custom content or badges, as one: the lock a game built with all of it has (both files', as this
  // commit has them), and the earliest version any of it waits for.
  const held = gate.held || bgate.held ? {
    app: [gate.held?.app, bgate.held?.app].filter(Boolean).sort(compareVersions)[0] || null,
    lock: withBadges(dataLock(data.generatedAt, hasCustom(custom) ? custom : null), hasBadges(badges) ? badges : null),
  } : null;
  // (What runs now is what the published release has: kept for the next start, which may be before the next release.)
  if (gate.save) {
    const now = hasCustom(gate.use) ? gate.use : null;
    if (stableJson(now) !== stableJson(gate.live)) {
      await (now ? db.query("INSERT INTO kv (k, v) VALUES ('custom', $1::jsonb) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v", [JSON.stringify({ json: JSON.stringify(now) })]) : db.query("DELETE FROM kv WHERE k = 'custom'"))
        .catch((e) => log('[custom] could not keep the custom content run', e.message));
    }
  }
  if (bgate.save) {
    const now = hasBadges(bgate.use) ? bgate.use : null;
    if (stableJson(now) !== stableJson(bgate.live)) {
      await (now ? db.query("INSERT INTO kv (k, v) VALUES ('badges', $1::jsonb) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v", [JSON.stringify({ json: JSON.stringify(now) })]) : db.query("DELETE FROM kv WHERE k = 'badges'"))
        .catch((e) => log('[badges] could not keep the badges run', e.message));
    }
  }
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

  // userId -> the Storage Units' sums the player's lean1 games were last told (lean.mjs sumsSent: their welcome's, then each
  // change's), while they're connected. A lean1 connection's own ws.unloaded: the units it knows only by those sums (all it
  // had at its welcome, less those it has asked for: social 'stored').
  const unitsSent = new Map();
  const srv = {
    db, store, log, INV_CAP, sockets, discord,
    // (The game's rules as the published release has them, while what ships with them waits: HELD_RULES.)
    rules: gated && !D.bd ? HELD_RULES : {},
    isOnline: (id) => sockets.has(id),
    forEachOnline: (fn) => { for (const id of sockets.keys()) fn(id); },
    sendTo(id, msg, except = null) {
      const set = sockets.get(id);
      if (!set) return;
      const text = JSON.stringify(msg);
      for (const ws of set) if (ws !== except && ws.readyState === 1) ws.send(text);
    },
    // Whether a connection announced lean1 (see CAPS).
    lean: (ws) => !!ws?.caps?.has(LEAN),
    // Whether a connection announced face1 (players' pictures and featured badges: server/social.mjs).
    faces: (ws) => !!ws?.caps?.has(FACE),
    // A message shaped for each of a player's connections: pick(ws) gives it (null: nothing to that one). Each message
    // object is turned into text once, however many connections it goes to.
    sendEach(id, pick, except = null) {
      const set = sockets.get(id);
      if (!set) return;
      const texts = new Map();
      for (const ws of set) {
        if (ws === except || ws.readyState !== 1) continue;
        const m = pick(ws);
        if (m == null) continue;
        if (!texts.has(m)) texts.set(m, JSON.stringify(m));
        ws.send(texts.get(m));
      }
    },
    // Whether any of a player's connections announced lean1 (then the lean shapes are worth making).
    anyLean: (id) => [...(sockets.get(id) || [])].some((ws) => srv.lean(ws)),
    // lean1: the sums of the Storage Units a change to what's in them changed, against what the player's lean1 games were last
    // told (unitsSent), which they are now. Called while the player's state is held, with the state the change made; only
    // when one of their connections is lean1 (all of those are sent every such change: a new one's welcome has them all).
    unitsDelta(id, st) {
      const { change, sent } = unitsChange(unitsSent.get(id) || null, unitSums(st));
      unitsSent.set(id, sent);
      return change;
    },
    // A change that replaced what's in Storage Units whole (staff restoring a save: set.stored): every lean1 game has all of
    // it now, as the game takes it, so nothing is left out for them and the sums start again from here.
    storedWhole(id, st) {
      unitsSent.set(id, sumsSent(unitSums(st)));
      for (const ws of sockets.get(id) || []) ws.unloaded = null;
    },
    // pick() for sendEach: the old message to a game without lean1, `lean` (lean1's, with t and d) to the others, each without
    // the stored items it would drop (forConnection). One object per shape, so each is turned into text once.
    leanPick(full, lean) {
      const units = [...new Set((lean.d?.sto?.add || []).map((it) => it.su))], made = new Map();
      return (ws) => {
        if (!srv.lean(ws)) return full;
        const key = units.filter((u) => ws.unloaded?.has(u)).join('|');
        if (!key) return lean;
        if (!made.has(key)) made.set(key, { ...lean, d: forConnection(lean.d, ws.unloaded) });
        return made.get(key);
      };
    },
    // (lean1: a change to what's in Storage Units also has the changed units' sums: server/lean.mjs. Such a change is only
    // ever sent from inside the player's lock (staff tools), so the state read here is the one it made.)
    deltaTo(id, d, note = null, quiet = false) {
      if (!d) return;
      const extra = note && !quiet ? { note } : {};
      const full = { t: 'delta', d, ...extra };
      const st = store.cache.get(id)?.st, anyLean = (d.sto || 'stored' in (d.set || {})) && st && srv.anyLean(id);
      if (anyLean && 'stored' in (d.set || {})) srv.storedWhole(id, st);
      const leanD = anyLean && d.sto ? leanPush(d, srv.unitsDelta(id, st)) : d;
      srv.sendEach(id, srv.leanPick(full, leanD === d ? full : { t: 'delta', d: leanD, ...extra }));
    },
    notice(id, msg, type = 'gold') { srv.sendTo(id, { t: 'notice', msg, type }); },
    async bumpStat(id, key) {
      await store.withUser(id, async (e) => { e.st.stats[key] = (e.st.stats[key] || 0) + 1; store.markDirty(e); srv.deltaTo(id, { set: { stats: e.st.stats }, add: [], del: [], upd: [] }); });
    },
    // Throws a player off: `fatal` to each of their connections, which then close (and ignore anything still coming).
    kick(id, { code, error, ban } = {}) {
      kicks.set(id, { seq: ++kickSeq, at: Date.now(), msg: { t: 'fatal', code, error, ...(ban ? { ban } : {}) } });
      // (Online PvP: out of the queue, off the match's socket, and a bot plays their slot: server/matchmaking.mjs kickUser.)
      try { srv.pvp?.kickUser(id, code); } catch (e) { log('[pvp] kick failed', e?.message || e); }
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
  store.onCleared = (id) => socials.facesChanged(id); // (a save that took a featured badge off: faces.d)
  const live = new Live(srv);
  srv.live = live;
  await live.refundOpen();
  const admin = new Admin(srv, discord, { admins });
  srv.admin = admin;
  await admin.init();
  // (Custom content or badges that wait for their release, customGate and badgeGate: once the feed shows that version, the
  // server starts again with them. A game that has them asking to play is a sign the release is out, so the feed is read then
  // too, at most once a minute.)
  let restarting = false, lastAsk = 0;
  const onVersion = (v) => {
    if (!held?.app || restarting || compareVersions(v, held.app) < 0) return;
    restarting = true;
    const what = [gate.held && 'its custom content', bgate.held && 'its badges'].filter(Boolean).join(' and ');
    // (Players still on an older version were just told they'd be taken offline once release.grace is up, five minutes:
    // the restart waits for that, as the notice says, and a game that has the new version is told the server is switching
    // meanwhile. With nobody to wait for, a moment for the notices to go out.)
    const wait = (release.outdated().length ? release.grace : 0) + 3000;
    log(`[custom] version ${v} is out: starting again with ${what} in ${Math.round(wait / 1000)} s (data lock ${held.lock})`);
    if (restart) setTimeout(restart, wait).unref?.();
    else log('[custom] (no restart here: start the server again to run it)');
  };
  srv.customWaits = () => {
    if (!held || !release.on || restarting || Date.now() - lastAsk < 60000) return;
    lastAsk = Date.now();
    release.poll().catch(() => {});
  };
  const release = new Release(srv, releaseOpt === false ? false : { ...releaseOpt, onVersion });
  srv.release = release;
  await release.init();
  srv.now = clock; // (passive income's time, and the clock a new or reset account's starts from)
  const passive = new Passive(srv, { clock, tick: passiveTick });
  srv.passive = passive;
  const p2p = new P2PMarket(srv); // (the Market: players' listings, server/p2pmarket.mjs)
  srv.p2p = p2p;
  await p2p.init();
  // Online PvP: the queue and the matches (server/matchmaking.mjs), and their /match socket (server/relay.mjs).
  const { relay: relayOpt = {}, ...pvpRest } = pvpOpt || {};
  const fillEnv = process.env.NODE_ENV !== 'production' && Number(process.env.PVP_FILL_AFTER_S) > 0 ? Number(process.env.PVP_FILL_AFTER_S) * 1000 : null;
  const pvp = new PvP(srv, { clock, ...(fillEnv ? { fillAfter: fillEnv } : {}), ...pvpRest });
  srv.pvp = pvp;
  const relay = new Relay(srv, pvp, relayOpt);
  srv.relay = relay;
  // The event loop's delay (/health's pvp.loopP99, ms): everything the relay forwards waits behind it. Read over a minute.
  // (The histogram times its own timer, so every sample includes the timer's interval, LOOP_RES, and on Windows the timer's
  // granularity too: that's taken off, so an idle server reads about 0 on Linux. DEPLOY.md: move the relay out past 25.)
  const LOOP_RES = 10;
  const loopDelay = monitorEventLoopDelay({ resolution: LOOP_RES });
  loopDelay.enable();
  const loopMs = () => Math.max(0, Math.round((loopDelay.percentile(99) / 1e6 - LOOP_RES) * 100) / 100);
  let loopP99 = null;
  const loopTimer = setInterval(() => { loopP99 = loopMs(); loopDelay.reset(); }, 60000);
  loopTimer.unref?.();

  // ---- market prices: same data build as the client, refreshed daily from the marketplaces ----------------
  // (Compressed once per price change, both ways: brotli at its best is a fifth smaller than gzip here, ~105 KB against
  // ~135 KB. It takes a second or two, so it's made on zlib's own threads, not the one everything else runs on: nothing
  // waits for it but the server's start, and after a refresh gzip goes out until it's ready, never the old prices.)
  let pricePatch = null, pricePatchGz = null, pricePatchBr = null, brBuild = 0;
  // Custom items' prices are their pack's, outside the lock: a deploy can change them alone. A game that kept the patch for
  // the pricedAt the welcome names takes it from there without asking (src/js/net/online.js), so new ones need a new
  // pricedAt. `cxp` (only with custom content) is the hash of the custom prices the patch was made with; `marketAt` (only
  // when it differs from pricedAt) is when the marketplaces' prices were last read, which the daily refresh goes by.
  const cxp = customPriceHash(D);
  let marketAt = D.pricedAt;
  const buildPatch = () => {
    const pick = (obj, f) => Object.fromEntries(Object.values(obj).map((x) => [x.id, f(x)]));
    // (Badges: the pins', the only ones with a market. Only when the server runs badges, so a patch without is as it was.)
    const pins = Object.values(D.badges || {}).filter((b) => b.tr);
    pricePatch = {
      generatedAt: D.lock, pricedAt: D.pricedAt, // (the data lock: a game takes the patch only for its own data)
      skins: pick(D.skins, (s) => s.p), stickers: pick(D.stickers, (s) => s.p), agents: pick(D.agents, (a) => a.p),
      ...(pins.length ? { badges: Object.fromEntries(pins.map((b) => [b.id, b.p])) } : {}),
      cases: Object.fromEntries(D.cases.filter((c) => !c.custom).map((c) => [c.id, c.price])),
      ...(cxp ? { cxp } : {}), ...(marketAt && marketAt !== D.pricedAt ? { marketAt } : {}),
    };
    const text = JSON.stringify(pricePatch);
    pricePatchGz = zlib.gzipSync(text);
    pricePatchBr = null;
    const build = ++brBuild;
    return new Promise((resolve) => zlib.brotliCompress(text, { params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
      [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: Buffer.byteLength(text),
    } }, (err, buf) => {
      if (err) log('[prices] brotli failed (gzip is sent)', err.message);
      else if (build === brBuild) pricePatchBr = buf; // (not one a newer refresh has replaced)
      resolve();
    }));
  };
  // (Saved prices, from before this start. A custom item's are always its pack's, as this deploy has it: they're skipped.)
  const applyPatch = (p) => {
    for (const [id, v] of Object.entries(p.skins)) if (D.skins[id] && !D.skins[id].cx) D.skins[id].p = v;
    for (const [id, v] of Object.entries(p.stickers)) if (D.stickers[id]) D.stickers[id].p = v;
    for (const [id, v] of Object.entries(p.agents)) if (D.agents[id]) D.agents[id].p = v;
    for (const [id, v] of Object.entries(p.badges || {})) if (D.badges[id]?.tr) D.badges[id].p = v;
    for (const [id, v] of Object.entries(p.cases)) if (D.caseById[id] && !D.caseById[id].cx) D.caseById[id].price = v;
    D.pricedAt = p.pricedAt;
  };
  let cxPricesNew = false;
  try {
    const { rows } = await db.query("SELECT v FROM kv WHERE k = 'prices'");
    const saved = rows[0] && (typeof rows[0].v === 'string' ? JSON.parse(rows[0].v) : rows[0].v);
    // (Prices saved for this game data build, whatever custom content was there then: the real items' ids are the build's.)
    if (saved && lockBase(saved.generatedAt) === D.generatedAt && saved.pricedAt > (D.pricedAt || '')) {
      applyPatch(saved);
      marketAt = saved.marketAt || saved.pricedAt;
      log(`[prices] using prices from ${saved.pricedAt}`);
    }
    // Custom prices other than the saved patch's (a deploy changed them, or brought custom content): a new pricedAt, so
    // games download the patch instead of using one they kept. (Without custom content, and none saved, as before.)
    if ((cxp || saved?.cxp) && saved?.cxp !== cxp) cxPricesNew = true;
  } catch (e) { log('[prices] could not load saved prices', e.message); }
  if (cxPricesNew) {
    D.pricedAt = new Date().toISOString();
    log(`[prices] custom prices changed: the price patch is new (${D.pricedAt})`);
  }
  await buildPatch();
  if (cxPricesNew) await db.query("INSERT INTO kv (k, v) VALUES ('prices', $1::jsonb) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v", [JSON.stringify(pricePatch)]).catch((e) => log('[prices] save failed', e.message));
  async function refreshPrices() {
    try {
      log('[prices] refreshing from marketplaces…');
      const raw = await pricing.fetchSources(fetch, (m) => log('[prices]', m));
      if (!Object.values(raw).some(Boolean)) return;
      pricing.applyPrices({ skins: D.skins, stickers: D.stickers, agents: D.agents, cases: D.cases, badges: D.badges }, pricing.buildIndex(raw));
      D.pricedAt = marketAt = new Date().toISOString();
      buildPatch();
      await db.query("INSERT INTO kv (k, v) VALUES ('prices', $1::jsonb) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v", [JSON.stringify(pricePatch)]);
      log('[prices] updated', D.pricedAt);
    } catch (e) { log('[prices] refresh failed', e.message); }
  }
  const DAY = 24 * 3600 * 1000;
  let priceTimer = null;
  if (priceRefresh) {
    // (By when the marketplaces were read, not when custom prices last changed the patch.)
    const age = Date.now() - Date.parse(marketAt || 0);
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
  const picLimit = A.limiter(30, 60000); // (uploads by address, before the login is looked up: social.mjs counts each player's)
  const txLimit = A.limiter(TX_MAX, TX_MS); // (a heavy player's IN_TRANSACTION actions, by account)
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', ...cors }); res.end(JSON.stringify(body)); };
  // (A body past `max` is refused once it has all come, so the answer reaches the sender: cut off as it arrives, a browser
  // reports a reset connection instead. Past BODY_DRAIN the connection is cut anyway.)
  const readBody = (req, max = 16384) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    if (Number(req.headers['content-length']) > BODY_DRAIN) { reject(new Error('too large')); req.destroy(); return; }
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_DRAIN) { reject(new Error('too large')); req.destroy(); } else if (size <= max) chunks.push(c);
    });
    req.on('end', () => {
      if (size > max) return reject(new Error('too large'));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { reject(new Error('bad json')); }
    });
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
  srv.ipOf = ipOf; // (the /match socket's hellos: server/relay.mjs)
  log(hops ? `[server] client addresses: X-Forwarded-For, ${hops} proxy hop${hops === 1 ? '' : 's'} (TRUST_PROXY)` : '[server] client addresses: the connection\'s own (no TRUST_PROXY)');

  const server = http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400, cors); return res.end(); }
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    try {
      // (`commit`: what a deploy waits for, to know the new code is the one answering. `ws`: the open connections, and how
      // many of them are compressed: behind a proxy, that the compression got through it.)
      if (url.pathname === '/health') {
        const conns = [...wss.clients];
        // (customWaits: the version whose release the pushed custom content waits for, customGate; only while it does. The same
        // for badges, badgeGate: badgesWait. customLock and badgesLock: the lock the server will have once it runs them, the
        // one a game built from this commit sends.)
        return json(res, 200, { ok: true, online: sockets.size, data: D.lock, pricedAt: D.pricedAt, requiredVersion: release.required, ...(gate.held ? { customWaits: gate.held.app || 'a rebuild', customLock: held.lock } : {}),
          ...(bgate.held ? { badgesWait: bgate.held.app || 'a rebuild', badgesLock: held.lock } : {}), discord: { connected: !!discord.status().connected }, commit,
          ws: { connections: conns.length, deflate: conns.filter((c) => /permessage-deflate/.test(c.extensions)).length },
          // (Online PvP: players searching, matches, players on /match, and the event loop's p99 delay over the last minute, ms.)
          pvp: { ...pvp.stats(), loopP99: loopP99 ?? loopMs() } });
      }
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(`<!doctype html><title>CS2 Case Simulator server</title><body style="font-family:system-ui;background:#0a0d12;color:#e8eef5;padding:40px">
          <h1>CS2 Case Simulator server</h1><p>This server is running. To play online, click <b>Offline</b> at the top right of the game and log in.</p>
          <p>Players online: ${sockets.size}</p></body>`);
      }
      if (url.pathname === '/api/prices' && req.method === 'GET') {
        // Brotli to whoever accepts it (the game's Chromium does, and unpacks it itself), then gzip, then plain JSON.
        const ae = String(req.headers['accept-encoding'] || '');
        const enc = acceptsBrotli(ae) && pricePatchBr ? 'br' : /gzip/.test(ae) ? 'gzip' : null; // (brotli: once it's made)
        res.writeHead(200, { 'content-type': 'application/json', ...(enc ? { 'content-encoding': enc } : {}), vary: 'Accept-Encoding', ...cors });
        return res.end(enc === 'br' ? pricePatchBr : enc === 'gzip' ? pricePatchGz : JSON.stringify(pricePatch));
      }
      // A profile picture (face1), by the hash of its bytes: the address changes with the picture, so it's cached for good.
      // One taken down, or nobody's, isn't there.
      const picPath = /^\/pic\/([0-9a-f]{64})$/.exec(url.pathname);
      if (picPath && req.method === 'GET') {
        const p = await socials.picture(picPath[1]);
        if (!p) { res.writeHead(404, { 'cache-control': 'no-store', ...cors }); return res.end(); }
        const tag = `"${picPath[1]}"`;
        const head = { 'cache-control': 'public, max-age=31536000, immutable', etag: tag, 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'", ...cors };
        if (req.headers['if-none-match'] === tag) { res.writeHead(304, head); return res.end(); }
        res.writeHead(200, { 'content-type': p.type, 'content-length': p.data.length, ...head });
        return res.end(p.data);
      }
      // A new profile picture of your own (face1): { token, data: its bytes in base64 } → { pic: its hash }. The login, bans and
      // maintenance as a connection's; the picture itself is checked in social.mjs setPicture.
      if (url.pathname === '/api/pic' && req.method === 'POST') {
        const ip = ipOf(req);
        if (!picLimit(ip)) return json(res, 429, { error: 'Too many attempts. Wait a minute.' });
        let body;
        try { body = await readBody(req, PIC_BODY); } catch (e) { return json(res, e.message === 'too large' ? 413 : 400, { error: e.message === 'too large' ? 'That picture is too big' : 'Not a picture' }); }
        const u = await A.userForToken(db, body.token).catch(() => null);
        if (!u) return json(res, 401, { error: 'Your login has expired. Log in again.', code: 'auth' });
        const ban = await admin.activeBan({ userId: u.id, ipHash: admin.ipHash(ip) });
        if (ban) return json(res, 403, { error: banText(ban), code: 'banned' });
        if (admin.settings.maintenance && await admin.levelOf(u.id, { fast: true }) < 1) return json(res, 503, { error: admin.maintenanceMsg(), code: 'maintenance' });
        // (Only while a game of theirs that reads faces is connected: one from before them, 1.1.5, can't show a picture, and its
        // staff can't see, report or take one down. Such a game can't connect before the release that brings faces.)
        if (![...(sockets.get(u.id) || [])].some((ws) => srv.faces(ws))) return json(res, 403, { error: 'Update the game to put up a profile picture', code: 'outdated' });
        if (typeof body.data !== 'string' || body.data.length > PIC_BODY || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.data)) return json(res, 400, { error: 'Not a picture' });
        try {
          return json(res, 200, await socials.setPicture(u.id, Buffer.from(body.data, 'base64')));
        } catch (e) {
          if (e instanceof GameError) return json(res, e.code === 'rate' ? 429 : 400, { error: e.message, code: e.code });
          throw e;
        }
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
          r = await A.register(db, body.name, body.password, { now: clock() });
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
  // Everything a player owns, for a FROM clause: what's in their Storage Units, and what they have listed on the Market, counts
  // as much as their inventory.
  const OWNED = (u) => `jsonb_array_elements(COALESCE(${u}.state->'inv', '[]'::jsonb) || COALESCE(${u}.state->'stored', '[]'::jsonb) || COALESCE(${u}.state->'listed', '[]'::jsonb))`;
  // The lowest and highest floats on the server (db.floats): server/dbfloats.mjs, which says what they cost.
  const { FloatRecords, ItemCopies } = await import('./dbfloats.mjs');
  const floats = srv.floats = new FloatRecords({ db, fresh: dbFresh, owned: OWNED });
  const itemCopies = srv.itemCopies = new ItemCopies({ db, owned: OWNED }); // (db.item past the copies it sends)

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
      const cap = itemCopies.cap, { rows } = await db.query(`SELECT u.id, u.name, it FROM users u, ${OWNED('u')} AS it
        WHERE it->>'t' = $1 AND it->>'id' = $2 LIMIT ${cap + 1}`, [t, id]);
      // More than it sends: the copies at both ends of its floats, and the counts of every copy (counts).
      const many = rows.length > cap ? await itemCopies.many(t, id) : null;
      const row =(x) => ({ owner: x.name, id: x.id, me: x.id === user.id, item: publicCopy(typeof x.it === 'string' ? JSON.parse(x.it) : x.it) });
      // A sticker: also the guns it's applied to.
      const applied = t !== 'sticker' ? [] : (await db.query(`SELECT u.id, u.name, it FROM users u, ${OWNED('u')} AS it
        WHERE it->'stk' @> $1::jsonb LIMIT 5000`, [JSON.stringify([{ id }])])).rows;
      return { r: { copies: (many ? many.copies : rows).map(row), applied: applied.map(row), ...(many ? { counts: many.counts } : {}) } };
    }
    // The copies with the lowest or highest floats of any skin: { dir: 'low' | 'high', cat, limit } → { dir, cat, copies }.
    if (m === 'db.floats') return { r: await floats.rpc(user, a) };
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
  // A permessage-deflate offer ws can't take (one asking for a smaller window than DEFLATE's, or a header it can't read)
  // would end the handshake with a 400: such a game connects without compression instead, as every game did before.
  server.prependListener('upgrade', (req) => {
    const offer = req.headers['sec-websocket-extensions'];
    if (offer === undefined) return;
    try {
      const offers = extension.parse(offer)[PerMessageDeflate.extensionName];
      if (offers) new PerMessageDeflate({ ...DEFLATE, isServer: true }).accept(offers);
    } catch { delete req.headers['sec-websocket-extensions']; }
  });
  // (noServer, and one router for the upgrades: /match is the relay's, never compressed; every other path goes to /ws's server,
  // which takes /ws exactly as before and answers anything else with its 400.)
  const wss = new WebSocketServer({ noServer: true, path: '/ws', maxPayload: MAX_MSG, perMessageDeflate: DEFLATE });
  server.on('upgrade', (req, socket, head) => {
    if (String(req.url || '').split('?')[0] === '/match') return relay.handleUpgrade(req, socket, head);
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  // Who's online: { name, online, worth } for each player connected. A game without lean1 is sent the whole list on every
  // join, leave, kick or rename, as before. A lean1 game gets it in its welcome, then only what changed since the last
  // time anyone was told ({ t: 'players.d', join, leave, upd }: worths are refreshed at those same moments).
  const playerRow = (id) => {
    const e = store.cache.get(id);
    return { name: e?.name || '?', online: true, worth: e ? Math.round(ownedValue(e.st)) : 0 };
  };
  const playersList = () => [...sockets.keys()].map(playerRow);
  let shownPlayers = new Map(); // userId -> the row lean1 games were last told
  // (welcomed: a lean1 connection just sent its welcome, whose list was read in this same moment: it has these changes)
  const broadcastPlayers = (welcomed = null) => {
    const now = new Map([...sockets.keys()].map((id) => [id, playerRow(id)]));
    const join = [], leave = [], upd = [];
    for (const [id, p] of shownPlayers) if (!now.has(id)) leave.push(p.name);
    for (const [id, p] of now) {
      const was = shownPlayers.get(id);
      if (!was) join.push(p);
      else if (was.name !== p.name) upd.push({ ...p, was: was.name }); // (a rename: the row it replaces)
      else if (was.worth !== p.worth) upd.push(p);
    }
    shownPlayers = now;
    const changes = join.length || leave.length || upd.length
      ? { t: 'players.d', ...(join.length ? { join } : {}), ...(leave.length ? { leave } : {}), ...(upd.length ? { upd } : {}) } : null;
    let full = null;
    // (A lean1 connection not welcomed yet gets nothing: its welcome has the list, and is followed at once by one of these.)
    for (const id of sockets.keys()) srv.sendEach(id, (ws) => (srv.lean(ws) ? (ws.welcomed && ws !== welcomed ? changes : null) : (full ??= { t: 'players', players: [...now.values()] })));
  };

  wss.on('connection', (ws, req) => {
    let user = null, greeting = false;
    let tokens = 60, lastRefill = Date.now();
    ws.isAlive = true;
    // (A pong whose payload starts 0x70 answers a queued pvp1 game's ping: a round trip for picking a match's host.)
    ws.on('pong', (data) => { ws.isAlive = true; if (data?.[0] === 0x70) pvp.pong(ws, data); });
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
        // (A game with the custom content or badges that wait for their release: the release is out, or about to be. customGate,
        // badgeGate.)
        if (held && msg.data === held.lock && msg.data !== D.lock) {
          srv.customWaits();
          return refuse({ t: 'fatal', error: 'The server is switching to this version of the game. Try again in a few minutes.', code: 'version' });
        }
        if (msg.data !== D.lock) return refuse({ t: 'fatal', error: 'Your game data is a different version from the server. Update the game (or the server).', code: 'version' });
        // The capabilities it announced that this server has (unknown ones are left out). The welcome names them back only
        // to a game that sent caps at all: an older game's welcome is unchanged.
        const asked = Array.isArray(msg.caps);
        const caps = new Set(asked ? msg.caps.filter((c) => typeof c === 'string' && CAPS.has(c)) : []);
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
          ws.caps = caps; // (the newer message shapes this game reads: see CAPS)
          if (!sockets.has(u.id)) sockets.set(u.id, new Set());
          sockets.get(u.id).add(ws);
          store.online.add(u.id);
          // Passive income for the time since they were last paid (server/passive.mjs), by the server's clock: in the state
          // the welcome brings, `away` says what it paid, and their other windows are sent the change.
          // Their Market listings and state agreed, and what sold while they were away: a notice after the welcome.
          const { state, away, sold } = await store.withUser(u.id, async (e) => ({
            away: await passive.connected(e), sold: await p2p.connected(e).catch((err) => { log('[p2p] connect failed', err?.message || err); return null; }), state: e.st,
          }));
          if (away) passive.push(u.id, { t: 'delta', d: away.d }, ws);
          const offers = await trades.list(u.id), account = await admin.account(u.id);
          // (From here to broadcastPlayers nothing waits: the players list a lean1 game is sent here is the one the changes
          // after it start from. A lean1 game asks for the lobbies when its Gamble page opens: they're not in its welcome.)
          // (lean1: no Storage Units' contents, their counts and values instead: server/lean.mjs. Its changes start from these
          // sums, and it knows every unit it has now only by them until it asks for one.)
          const lean = srv.lean(ws), sums = lean ? unitSums(state) : null;
          if (lean) { unitsSent.set(u.id, sumsSent(sums)); ws.unloaded = new Set(Object.keys(sums)); }
          send({
            t: 'welcome', user: { id: u.id, name: u.name }, state: lean ? leanState(state) : state, ...(lean ? { units: sums } : {}),
            pricedAt: D.pricedAt, serverTime: Date.now(),
            players: playersList(), trades: offers, ...(lean ? {} : { lobbies: live.snapshot(u.id) }), market: marketSnapshot(),
            account, motd: admin.settings.motd || '',
            ...(away?.r.earned ? { away: { earned: away.r.earned, minutes: away.r.minutes, capped: away.r.capped } } : {}),
            ...(asked ? { caps: [...caps] } : {}),
          });
          ws.welcomed = true; // (passive income's pushes wait for this: a change sent before it is in the welcome's state already)
          if (sold) send({ t: 'notice', msg: sold, type: 'gold' });
          p2p.welcome(u.id); // (a sale while this one was connecting: told now)
          broadcastPlayers(ws); // (not to this one if it's lean1: the list in its welcome, read just now, has these changes)
          if (ws.tradesStale) trades.pushFull(u.id, ws).catch((e) => log('[trade] list failed', e?.message || e)); // (see Trades.pushChanged)
        } catch (e) {
          log('[ws] hello failed', e);
          ws.close(1011);
        } finally {
          greeting = false;
        }
        return;
      }
      // A lean1 game says which pushes it wants: { t: 'sub', lobbies: true | false } as its Gamble page opens and closes; a p2p1
      // game { t: 'sub', p2p: true | false } as its Market page does.
      if (user && msg.t === 'sub') {
        if (srv.lean(ws) && typeof msg.lobbies === 'boolean') live.subscribe(ws, msg.lobbies);
        if (ws.caps?.has(P2P) && typeof msg.p2p === 'boolean') p2p.subscribe(ws, msg.p2p);
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
          const name = String(msg.m);
          // (A match against bots doesn't start, nor pay, while the player searches for or plays an online match: one game
          // or two, the same minutes would be paid twice. Their search cleared any open one: server/matchmaking.mjs.)
          if ((name === 'play.start' || name === 'play.reward') && pvp.playing(user.id)) throw new GameError('You are searching for or playing an online match: finish it first', 'busy');
          if (IN_TRANSACTION.test(name) && (store.cache.get(user.id)?.st.stored?.length || 0) > HEAVY_STORED && !txLimit(user.id)) {
            throw new GameError('Slow down: too many changes to your Storage Units, tools or Index at once. Wait a few seconds.', 'rate');
          }
          const out = await store.withUser(user.id, async (e) => {
            const ctx = makeCtx(e.st, { ...srv.rules, online: true, invCap: INV_CAP, reserved: trades.reserved(user.id), asked: trades.asked(user.id) });
            // The market's stock is shared by everyone on the server.
            ctx.market = (w) => ({ has: (lid) => soldSet(w).has(lid), add: (lid) => { soldSet(w).add(lid); marketDirty = true; boughtNow.push([w, lid]); } });
            ctx.serial = srv.serial; // serial numbers are counted across the server
            ctx.dirty.add('money');
            // (lean1's shapes are made here, while the state is this action's: they compare its stats with these)
            const statsWere = srv.anyLean(user.id) ? statsBefore(e.st) : null;
            const r = runAction(ctx, name, args);
            store.markDirty(e);
            if (IN_TRANSACTION.test(name)) await store.commit([e]);
            const d = delta(ctx);
            return { r, d, lean: statsWere ? leanAct(name, r, d, { statsWere, units: d.sto ? srv.unitsDelta(user.id, e.st) : null }) : null };
          });
          // (a lean1 connection's lean, made above if any of the player's connections announced it: one that connected
          // meanwhile gets the old shapes this once, which it reads too)
          const leanOut = srv.lean(ws) && out.lean;
          reply(true, leanOut ? { r: leanOut.r, d: forConnection(leanOut.d, ws.unloaded) } : { r: out.r, d: out.d });
          for (const [w, lid] of boughtNow) for (const id of sockets.keys()) srv.sendTo(id, { t: 'market', w, lid });
          // Other tabs of the same player.
          const full = { t: 'delta', d: out.d };
          srv.sendEach(user.id, srv.leanPick(full, out.lean ? { t: 'delta', d: out.lean.d } : full), ws);
          if (OPENED.has(name)) announceDrops(user.name, out.r.items || [out.r.item]);
          return;
        }
        // What's in one of your own Storage Units ({ unit }: its uid), which a lean1 welcome leaves out. → { unit, items, sum }
        // Answered while the player's state is held: a change to the unit after it is sent after it, one before it is in it.
        if (msg.ns === 'social' && msg.m === 'stored') {
          const unit = String(msg.args?.unit ?? '');
          socials.limit('unit', user.id);
          return await store.withUser(user.id, async (e) => {
            const r = storedOfUnit(e.st, unit);
            if (!r) throw new GameError('That Storage Unit is gone', 'missing');
            ws.unloaded?.delete(unit); // (its changes from here on carry what goes into it: the game has its contents now)
            reply(true, { r });
          });
        }
        if (msg.ns === 'social') {
          const out = await social(user, String(msg.m), msg.args || {}, ws);
          return reply(true, { r: out.r, d: out.d });
        }
        if (msg.ns === 'trade') {
          if (!admin.settings.trading && !TRADE_ALWAYS.has(String(msg.m))) throw new GameError('Trading is turned off on this server right now', 'off');
          const r = await trades.rpc(user, String(msg.m), msg.args || {});
          // (lean1: an accept's answer without its d, the changes the trade made to you, which every one of your connections
          // has just been sent as a delta: the game takes them from that, and never read this copy)
          if (srv.lean(ws) && msg.m === 'accept' && r && typeof r === 'object' && 'd' in r) { const { d: _d, ...rest } = r; return reply(true, { r: rest }); }
          return reply(true, { r });
        }
        if (msg.ns === 'gamble') {
          if (!admin.settings.gambling && !GAMBLE_ALWAYS.has(String(msg.m))) throw new GameError('Gambling is turned off on this server right now', 'off');
          return reply(true, { r: await live.rpc(user, String(msg.m), msg.args || {}) });
        }
        if (msg.ns === 'account') return reply(true, { r: await admin.accountRpc(user, String(msg.m), msg.args || {}) });
        if (msg.ns === 'admin') return reply(true, { r: await admin.rpc(user, String(msg.m), msg.args || {}, { faces: srv.faces(ws) }) });
        // The Market (server/p2pmarket.mjs): { r, d? }, d the changes to you (your other connections get them as a delta).
        if (msg.ns === 'p2p') return reply(true, await p2p.rpc(user, String(msg.m), msg.args || {}, ws));
        // Online PvP (server/matchmaking.mjs): only from a game that announced pvp1.
        if (msg.ns === 'pvp') {
          if (!ws.caps?.has(PVP)) throw new GameError('Update the game to play online matches', 'outdated');
          return reply(true, { r: await pvp.rpc(user, String(msg.m), msg.args || {}, ws) });
        }
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
      p2p.subscribe(ws, false);
      pvp.disconnected(ws); // (a search it made waits a moment for the game to come back: server/matchmaking.mjs)
      const set = sockets.get(user.id);
      set?.delete(ws);
      if (set && !set.size) {
        sockets.delete(user.id);
        unitsSent.delete(user.id);
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

  await new Promise((r) => (host ? server.listen(port, host, r) : server.listen(port, r)));
  const actualPort = server.address().port;
  log(`[server] listening on ${host || ''}:${actualPort}${commit ? ` (commit ${String(commit).slice(0, 7)})` : ''}`);
  // (Online PvP matches from before this start: paused until their players are back, and any pay left owing.)
  await pvp.restore().catch((e) => log('[pvp] restore failed', e));
  // The bot connects in the background; nothing waits for Discord.
  if (discord.enabled) Promise.resolve().then(() => discord.start()).catch((e) => log('[discord] start failed', e?.message || e));

  async function close() {
    clearInterval(ping); clearInterval(priceTimer); clearInterval(saveMarket); clearInterval(serialTimer);
    passive.close();
    admin.close();
    release.close();
    socials.close();
    p2p.close();
    try { discord.close(); } catch (e) { log('[discord] close failed', e?.message || e); }
    await saveSerials();
    if (marketDirty) await db.query("INSERT INTO kv (k, v) VALUES ('market', $1::jsonb) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v", [JSON.stringify(marketSnapshot())]).catch(() => {});
    live.close();
    // (Online PvP: every live match paused and kept, then its players' /match sockets closed with 1012, which they come back
    // from once the server's started again.)
    await pvp.close().catch((e) => log('[pvp] close failed', e?.message || e));
    await relay.close(1012);
    clearInterval(loopTimer);
    loopDelay.disable();
    for (const ws of wss.clients) ws.terminate();
    await new Promise((r) => server.close(() => r()));
    await store.close();
    await db.close();
  }
  return { port: actualPort, close, srv, db, store, refreshPrices, admin, discord };
}

// Run directly: start and shut down cleanly on SIGTERM (systemd and Render send it before stopping the server).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Set it to your Postgres connection string (see DEPLOY.md).');
    process.exit(1);
  }
  // Dev conveniences: --admins a,b (as ADMIN_USERS) and --discord-token-file <path> (as DISCORD_TOKEN_FILE).
  const argv = process.argv.slice(2);
  const arg = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const admins = arg('--admins'), tokenFile = arg('--discord-token-file');
  // --custom <dir>: another build of custom content (node scripts/build-custom.mjs --try prints it), to try it online
  // against a local server without putting it in src/. Never in production.
  const customDir = arg('--custom');
  if (customDir && process.env.NODE_ENV === 'production') { console.error('--custom is for a local server, not production.'); process.exit(1); }
  const customTry = customDir ? readCustom(path.join(path.resolve(customDir), 'data', 'custom.json')) : undefined;
  if (customDir && !customTry) { console.error(`--custom ${customDir}: no data/custom.json there (build one: node scripts/build-custom.mjs --src <packs> --try).`); process.exit(1); }
  const s = await startServer({
    ...(admins != null ? { admins: list(admins) } : {}),
    ...(tokenFile ? { discord: discordFromEnv({ tokenFile }) } : {}),
    ...(customTry ? { custom: customTry } : {}),
    // (Exits once it's closed: systemd's Restart=always starts it again, on the commit the deploy checked out.)
    restart: () => stop(),
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
