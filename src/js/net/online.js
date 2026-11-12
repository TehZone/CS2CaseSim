// Online play: account login, the WebSocket connection to the game server, and the remote backend that sends
// game actions to the server instead of running them locally.
//
// Protocol (JSON over WebSocket at <server>/ws; the browser and the server agree on permessage-deflate by themselves):
//   client -> server  { t: 'hello', token, data, v, app, caps }   first message; data = game data build stamp, app = the game's
//                                                            version, caps = the capabilities this game reads (see below)
//                     { t: 'rpc', id, ns, m, args }          ns: 'act' | 'gamble' | 'trade' | 'social' | 'account' | 'admin'
//                     { t: 'sub', lobbies }                  (lean1) the Gamble page opened (true) or closed (false)
//   server -> client  { t: 'welcome', user, state, account, motd, away?, caps?, players, trades, lobbies?, market, ... }
//                                                            after hello (away: what passive income paid for the time since you
//                                                            were last here: { earned, minutes, capped }; caps: see below)
//                     { t: 'res', id, ok, r, d, err }        reply to an rpc (d = state changes)
//                     { t: 'delta', d }                      state changes from elsewhere (trades, passive income every minute, wins)
//                     { t: 'account', account }              your Discord link or staff level changed
//                     { t: 'admin.msg', kind, msg, from }    a moderator's warning or a broadcast
//                     { t: 'fatal', code, error, ban? }      refused or thrown off (auth, version, outdated, banned, kicked, maintenance)
//                     { t: 'update', version }               a new release is out: this game is about to be locked out
//                     { t: 'chat', msg, who }                a message to you, or one you sent from another tab
//                     { t: 'friends' }                       your friends, requests or blocks changed: ask for `home` again
//                     { t: 'players', players }              who's online, the whole list: [{ name, online, worth }]
//                     { t: 'lobbies', lobbies }              the live gamble lobbies: { battles, flips, jackpot }
//                     { t: 'trades', trades }                your trade offers, the whole list (the 30 latest, open and closed)
//                     { t: 'gamble.result' | 'notice' | 'market', ... }
//
// Capabilities. A game names the newer message shapes it reads in its hello (caps: CAPS), and the server's welcome lists
// the ones it will use with this connection (welcome.caps; no caps in the welcome: an older server, so none). The server
// sends a shape only to a connection whose welcome named it, so a game that sends no caps (1.1.2 and older) is sent exactly
// what it always was. Once a game announcing one is released, its shapes are frozen: a change is a new name. net.lean().
//   lean1:
//     players: the whole list in the welcome, then only changes:
//                     { t: 'players.d', join?: [row], leave?: [name], upd?: [row] }   (an upd row with `was` is a rename:
//                                                            the row that had that name)
//     lobbies: not in the welcome, and sent only while this game says its Gamble page is open ({ t: 'sub', lobbies: true },
//              answered with them at once; net.watch), at most about once a second; your own requests' change at once.
//     trades:  the whole list in the welcome (and from rpc trade 'list'), then only the offers that changed:
//                     { t: 'trades.d', upd: [offer], del?: [id] }   (del: offers off the end of your 30 latest; an upd row
//                                                            without `give` is an offer whose status is all that changed:
//                                                            { id, status, version, updated }, merged into the copy you have;
//                                                            a copy with a lower version than yours is an older one)
//              A whole { t: 'trades' } list can still come, and replaces the list. A trade accept's answer has no d (the
//              trade's changes come as a delta, as they do to your other connections).
//     actions: (rpc 'act' answers, and the changes copied to your other tabs; the shapes are server/lean.mjs's) an item that
//              d.add or d.upd carries is in r as { uid } alone (relink puts the item back); empty lists are left out; the
//              stats as the fields that changed, d.stats (merged: state.js applyDelta), not set.stats; item.seen as d.seen:
//              [uid]; a change to Storage Units' contents comes with d.units, the sums of the units it changed, merged:
//              { [unit uid]: { n, value, best? } | null } (best only when it's another item, null when the unit is empty;
//              a unit as null: it's gone), and d.sto.add leaves out what went into a unit whose contents you haven't asked for.
//     welcome: state.stored is left out, and welcome.units has each unit's { n, value, best } (its count, value and most
//              valuable item). A unit's contents: rpc social 'stored' { unit } -> { unit, items, sum } (stored.js loadUnit).
//     case.open's buy (one request buys what's missing and opens) is used only on a server whose welcome names lean1, with
//     maxCost (what the game worked out it costs: more is refused, 'price').
import { D } from '../data.js';
import { S, applyDelta, enterOnline, leaveOnline, PRICES_KEY } from '../state.js';
import { setRemote } from '../backend.js';

const LS = 'cs2sim-online';
const PROTOCOL = 1;
// The capabilities this game reads (see the protocol above), and the ones the server took for this connection.
const LEAN = 'lean1';
// p2p1: the Market (server/p2pmarket.mjs): its requests (rpc ns 'p2p', net.p2p) and, while the Market page watches
// (net.watch('p2p') sends { t: 'sub', p2p }), its listings' changes: { t: 'p2p.d', add?: [listing], del?: [lid], upd?: [{ lid,
// price }], open? (the admin panel opened or closed it) } (net.on('p2p')). A server whose welcome doesn't name it has no Market
// (net.hasMarket()).
const P2P = 'p2p1';
// face1: players' faces (server/social.mjs): Persons with `pic` (their own profile picture's hash: GET <server>/pic/<hash>)
// and `badge` (the badge they feature), profiles with `badges`, social 'faces' ({ ids } or { names } → [Person]), a new
// picture through POST /api/pic (net.uploadPic), staff's admin 'pic.clear' and 'pic.get', and { t: 'faces.d', ids }: the
// players whose faces changed (net.on('faces')). faces.js draws them (net.hasFaces()).
const FACE = 'face1';
const CAPS = [LEAN, P2P, FACE];
let caps = new Set();
const TRADES_SHOWN = 30; // (the server's MAX_LIST: a trades.d keeps the list to the 30 latest)
// The one server the game plays on, and the only place its address is written: changing it is this one line, and only
// when the user says so. Its address shows to staff in the admin panel and nowhere else, so no text may be built from it.
// A packaged game plays nowhere else: there is no way to choose, and a server saved by an older install is ignored,
// with the login that went with it. Development only (`npm run dev`, `electron .`): a local
// server is net.setServerUrl('http://localhost:8787') in the console. A test run of any build: CS2SIM_SMOKE_SERVER
// (localhost only, see shared/updater.cjs).
const SERVER = 'https://server.cs2casesim.lol';
// This build, from the app (preload.js): { version, packaged, server }. In a browser (the dev server) there's none, and in
// Node (scripts/test-play.mjs loads this through the game) no window either.
const build = globalThis.window?.native?.build || {};
const packaged = globalThis.location?.protocol === 'app:' && build.packaged !== false;
const bus = new EventTarget();
let ws = null, user = null, status = 'offline', seq = 0, retry = 0, retryTimer = null, wantOnline = false;
const pending = new Map();
let lobbies = { battles: [], flips: [], jackpot: null };
let players = [], trades = [];
// Your account's Discord link and staff level ({ discord, staff, discordOn, discordBans }), and the server's message of the day.
let account = null, motd = '';
// Server clock offset and the market listings already bought on the server (per 10-minute window).
let clockOffset = 0;
const marketSold = new Map(); // window -> Set of listing ids
// What pages want pushed (lean1: { t: 'sub' }): how many watch each topic, and what this connection's server was last told.
const watching = { lobbies: 0, p2p: 0 };
// (Each topic is the server's to push only with its capability: the lobbies with lean1, the Market's listings with p2p1.)
const TOPIC_CAP = { lobbies: LEAN, p2p: P2P };
let subSent = {}, subTimer = null;

const saved = () => { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch { return {}; } };
const store = (v) => { try { localStorage.setItem(LS, JSON.stringify({ ...saved(), ...v })); } catch {} };
if (packaged && saved().url) store({ url: null, ...(saved().url === SERVER ? {} : { token: null }) });

// (lost: the connection, or the attempt at one, has just ended, and the game tries again: see passive.js)
function setStatus(s, detail = '', lost = false) {
  status = s;
  emit('status', { status: s, detail, lost });
}
function emit(type, detail) { bus.dispatchEvent(new CustomEvent(type, { detail })); }

// Staff see the Admin section (the server still checks every admin request).
function setAccount(a, announce = true) {
  account = a && typeof a === 'object' ? a : null;
  document.body.classList.toggle('is-staff', (account?.staff || 0) >= 1);
  if (announce) emit('account', account);
}
// Fatal codes that end the session for a reason the player is shown in a window (main.js / account.js).
const SHOWN_FATAL = new Set(['banned', 'kicked', 'maintenance', 'outdated']);

export const net = {
  on(type, fn) { const h = (e) => fn(e.detail); bus.addEventListener(type, h); return () => bus.removeEventListener(type, h); },
  status: () => status,
  me: () => user,
  lobbies: () => lobbies,
  players: () => players,
  trades: () => trades,
  serverUrl: () => build.server || (packaged ? SERVER : saved().url || SERVER),
  // A packaged game on a test run's server: what that server says about you counts for nothing outside the run.
  testServer: () => packaged && !!build.server,
  // What the game says about being online; a page showing it keeps it live with data-online-text (main.js).
  onlineText: () => `Online. Players Online: ${players.length}`,
  serverNow: () => Date.now() + clockOffset,
  marketSold: (w) => { if (!marketSold.has(w)) marketSold.set(w, new Set()); return marketSold.get(w); },
  setServerUrl: (url) => { if (!packaged) store({ url: normalizeUrl(url) }); },
  gamble: (m, args) => rpc('gamble', m, args),
  trade: (m, args) => rpc('trade', m, args),
  social: (m, args) => rpc('social', m, args),
  // The Market (p2p1). (Its answers as they came: listings are other players' items, not your inventory's.)
  p2p: (m, args) => rpc('p2p', m, args, { relink: false }),
  hasMarket: () => caps.has(P2P),
  // Players' faces (face1): whether this connection's server has them; a profile picture's address (its hash); and a new
  // picture of your own, its bytes in base64 (→ { pic: hash }; a refusal is an Error with the server's words and code).
  hasFaces: () => caps.has(FACE),
  picUrl: (hash) => (/^[0-9a-f]{64}$/.test(String(hash)) ? `${net.serverUrl()}/pic/${hash}` : ''),
  uploadPic: (data) => http('/api/pic', { token: saved().token, data }),
  account: () => account,
  motd: () => motd,
  // Whether this connection's server sends the lean1 shapes (see the protocol above).
  lean: () => caps.has(LEAN),
  // A page that shows a topic the server pushes only on request ('lobbies'): watch while it's shown; the function returned
  // stops. Offline or on a server without lean1 it changes nothing (everything is pushed there anyway).
  watch(topic) {
    if (!(topic in watching)) throw new Error(`Nothing to watch called ${topic}`);
    watching[topic]++;
    syncSubs();
    let on = true;
    return () => { if (on) { on = false; watching[topic]--; syncSubs(); } };
  },
  // (Admin answers come as the server sent them: a snapshot's or another player's items aren't your live ones.)
  admin: (m, args) => rpc('admin', m, args, { relink: false }),
  // (info and unlink answer with the account: it is kept like a pushed one.)
  accountRpc: (m, args) => rpc('account', m, args).then((r) => { if ((m === 'info' || m === 'unlink') && r && typeof r === 'object') setAccount(r); return r; }),
  resetPassword: (name, code, password) => http('/api/reset', { name, code, password }),
  login, logout, resume,
};

function normalizeUrl(url) {
  url = String(url || '').trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\//.test(url)) url = (/^(localhost|127\.)/.test(url) ? 'http://' : 'https://') + url;
  return url;
}

async function http(path, body) {
  const url = net.serverUrl();
  let res;
  try {
    res = await fetch(url + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error('Could not reach the server. If it is on a free host it may be waking up: try again in a minute.');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Server error ${res.status}`);
  return json;
}

// Log in (or create an account) and connect.
async function login(name, password, { register = false } = {}) {
  setStatus('connecting', 'Contacting the server (a sleeping free server can take up to a minute)…');
  try {
    const r = await http(register ? '/api/register' : '/api/login', { name, password });
    store({ token: r.token, name: r.name });
    await connect({ asked: true });
  } catch (e) {
    setStatus('offline');
    throw e;
  }
}

function logout() {
  wantOnline = false;
  const s = saved();
  if (s.token) http('/api/logout', { token: s.token }).catch(() => {});
  store({ token: null });
  disconnect();
}

// Reconnect on startup when the player was online last time.
function resume() {
  if (saved().token) connect().catch(() => {});
}

// (asked: the player pressed Log in, as opposed to the game connecting by itself.)
function connect({ asked = false } = {}) {
  return new Promise((resolve, reject) => {
    wantOnline = true;
    clearTimeout(retryTimer);
    const url = net.serverUrl().replace(/^http/, 'ws') + '/ws';
    setStatus('connecting', retry ? 'Reconnecting…' : 'Connecting…');
    try { ws?.close(); } catch {}
    // (Fixed text: what the browser throws here has the address in it, and the login window shows what comes back.)
    let sock;
    try { sock = new WebSocket(url); } catch {
      wantOnline = false;
      setStatus('offline');
      return reject(new Error('Could not connect to the server'));
    }
    ws = sock;
    // A change the server sends before the welcome is in the welcome's state already. One that comes while the welcome is
    // being taken in (prices synced first) is after it, but the game's state is still the offline save then, which mustn't
    // get it: it waits in `early`.
    let welcomed = false, early = null;
    sock.onopen = () => sock.send(JSON.stringify({ t: 'hello', token: saved().token, data: D.lock, v: PROTOCOL, app: build.version, caps: CAPS }));
    sock.onmessage = async (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.t === 'welcome') {
        welcomed = true;
        retry = 0;
        early = [];
        try { await onWelcome(msg); } finally { const waiting = early; early = null; for (const m of waiting) handle(m); }
        resolve();
      } else if (msg.t === 'fatal') {
        wantOnline = false;
        if (msg.code === 'auth') store({ token: null });
        reject(new Error(msg.error));
        // A ban, kick, maintenance or an outdated game gets a window of its own instead of a toast.
        if (SHOWN_FATAL.has(msg.code)) emit('fatal', { code: msg.code, error: msg.error || '', ban: msg.ban || null, required: msg.required || '', asked });
        else emit('notice', { msg: msg.error, type: 'bad' });
        sock.close();
      } else if (early) early.push(msg);
      else if (welcomed) handle(msg);
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      for (const [, p] of pending) p.reject(Object.assign(new Error('Connection lost'), { remote: true }));
      pending.clear();
      if (!welcomed) reject(new Error('Could not connect to the server'));
      if (wantOnline) {
        setStatus('connecting', 'Connection lost, reconnecting…', true);
        retryTimer = setTimeout(() => connect().catch(() => {}), Math.min(30000, 1000 * 2 ** retry++));
      } else disconnect();
    };
  });
}

function disconnect() {
  try { ws?.close(); } catch {}
  ws = null;
  user = null;
  caps = new Set();
  setRemote(null);
  document.body.classList.remove('is-online');
  motd = '';
  if (account) setAccount(null);
  document.body.classList.remove('is-staff');
  leaveOnline();
  setStatus('offline');
}

async function onWelcome(msg) {
  user = msg.user;
  motd = typeof msg.motd === 'string' ? msg.motd : '';
  // (Set before enterOnline: the page drawn again on 'reset' already knows your staff level.)
  setAccount(msg.account, false);
  if (msg.serverTime) clockOffset = msg.serverTime - Date.now();
  marketSold.clear();
  for (const [w, ids] of Object.entries(msg.market || {})) marketSold.set(+w, new Set(ids));
  // (The capabilities the server took. A new connection's server has been told nothing it's watched yet.)
  caps = new Set(Array.isArray(msg.caps) ? msg.caps : []);
  subSent = {};
  players = msg.players || [];
  trades = msg.trades || [];
  // (lean1: the lobbies come when the Gamble page asks for them, just after this if it's open)
  lobbies = msg.lobbies || (net.lean() ? { battles: [], flips: [], jackpot: null } : lobbies);
  if (msg.pricedAt && msg.pricedAt !== D.pricedAt) await syncPrices(msg.pricedAt).catch((e) => console.warn('price sync failed', e));
  setRemote(remoteBackend);
  enterOnline(msg.state, { units: net.lean() ? msg.units : null });
  document.body.classList.add('is-online');
  setStatus('online');
  syncSubs();
  emit('players', players);
  emit('trades', trades);
  emit('lobbies', lobbies);
  emit('account', account);
  // Passive income for your time away, paid as you connected (it's in the state already): passive.js says so.
  if (msg.away && typeof msg.away === 'object') emit('away', msg.away);
}

// Use the server's market prices so item values match what the server pays. The last patch downloaded is kept (PRICES_KEY,
// with the pricedAt it's from): a welcome whose pricedAt is that one's takes it from there instead of downloading it again,
// which the server's prices change only once a day to need. (Kept for this game's data build only: its ids are that build's.)
async function syncPrices(pricedAt) {
  const kept = keptPrices();
  const p = kept && kept.pricedAt === pricedAt ? kept : await http('/api/prices');
  for (const [id, v] of Object.entries(p.skins || {})) if (D.skins[id]) D.skins[id].p = v;
  for (const [id, v] of Object.entries(p.stickers || {})) if (D.stickers[id]) D.stickers[id].p = v;
  for (const [id, v] of Object.entries(p.agents || {})) if (D.agents[id]) D.agents[id].p = v;
  for (const [id, v] of Object.entries(p.badges || {})) if (D.badges[id]?.tr) D.badges[id].p = v; // (the pins': engine/badges.js)
  for (const [id, v] of Object.entries(p.cases || {})) if (D.caseById[id]) D.caseById[id].price = v;
  D.pricedAt = p.pricedAt;
  if (p !== kept && isPatch(p)) { try { localStorage.setItem(PRICES_KEY, JSON.stringify(p)); } catch {} }
}
const isPatch = (p) => !!p && typeof p === 'object' && typeof p.pricedAt === 'string' && p.generatedAt === D.lock
  && ['skins', 'stickers', 'agents', 'cases'].every((k) => p[k] && typeof p[k] === 'object');
// The kept patch, or null (none, unreadable, or from another data build).
function keptPrices() {
  try {
    const p = JSON.parse(localStorage.getItem(PRICES_KEY) || 'null');
    return isPatch(p) ? p : null;
  } catch { return null; }
}

function handle(msg) {
  switch (msg.t) {
    case 'res': {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.d) applyDelta(msg.d);
      if (msg.ok) p.resolve(p.raw ? msg.r : relink(msg.r, msg.d));
      else p.reject(Object.assign(new Error(msg.err || 'Request failed'), { code: msg.code || 'bad', remote: true }));
      return;
    }
    case 'delta': applyDelta(msg.d); if (msg.note) emit('notice', { msg: msg.note, type: msg.noteType || 'gold' }); return;
    case 'lobbies': lobbies = msg.lobbies; emit('lobbies', lobbies); return;
    case 'players': players = msg.players; emit('players', players); return;
    case 'players.d': players = playersChanged(players, msg); emit('players', players); return;
    case 'trades': trades = msg.trades; emit('trades', trades); return;
    case 'trades.d': {
      const missing = tradesMissing(trades, msg);
      trades = tradesChanged(trades, msg);
      emit('trades', trades);
      if (missing) askTrades();
      return;
    }
    case 'gamble.result': emit('gamble.result', msg.ev); return;
    case 'notice': emit('notice', { msg: msg.msg, type: msg.type }); return;
    case 'market': net.marketSold(msg.w).add(msg.lid); emit('market', msg); return;
    case 'account': setAccount(msg.account); return;
    case 'admin.msg': emit('admin.msg', { kind: msg.kind, msg: msg.msg || '', from: msg.from || '' }); return;
    case 'update': emit('update', { version: msg.version || '' }); return;
    case 'chat': emit('chat', { msg: msg.msg, who: msg.who }); return;
    case 'friends': emit('friends'); return;
    case 'faces.d': emit('faces', { ids: Array.isArray(msg.ids) ? msg.ids : [] }); return; // (face1: faces.js)
    case 'p2p.d': emit('p2p', { add: msg.add || [], del: msg.del || [], upd: msg.upd || [], ...(typeof msg.open === 'boolean' ? { open: msg.open } : {}) }); return;
  }
}

// lean1's players.d on the list: who left goes, a changed row (an upd, or a join already there) takes its place, and a new
// one goes at the end, where the server's list has it.
export function playersChanged(list, { join = [], leave = [], upd = [] }) {
  const gone = new Set(leave);
  const out = list.filter((p) => !gone.has(p.name));
  for (const p of [...upd, ...join]) {
    const row = { name: p.name, online: p.online, worth: p.worth };
    const i = out.findIndex((x) => x.name === (p.was ?? p.name) || x.name === p.name);
    if (i >= 0) out[i] = row; else out.push(row);
  }
  return out;
}
// lean1's trades.d on the list: a changed offer replaces its own or joins the list, del's go, latest first, the 30 latest
// kept. A row without `give` is an offer's new status only ({ id, status, version, updated }): merged into the copy here
// (none here: see tradesMissing). A copy older than the one here (a lower version, or the same and updated earlier) is
// left out: two changes to one offer can arrive the other way round.
export function tradesChanged(list, { upd = [], del = [] }) {
  const have = new Map(list.map((t) => [t.id, t])), changed = new Map(), gone = new Set(del);
  for (const row of upd) {
    if (!row || typeof row !== 'object' || row.id == null) continue;
    const cur = changed.get(row.id) || have.get(row.id);
    if (cur && newerOffer(cur, row)) continue;
    if ('give' in row) changed.set(row.id, row);
    else if (cur) changed.set(row.id, { ...cur, ...row });
  }
  const kept = list.filter((t) => !changed.has(t.id) && !gone.has(t.id));
  return [...changed.values(), ...kept].sort((a, b) => b.updated - a.updated).slice(0, TRADES_SHOWN);
}
const newerOffer = (a, b) => (+a.version || 0) > (+b.version || 0) || ((+a.version || 0) === (+b.version || 0) && (+a.updated || 0) > (+b.updated || 0));
// Whether a trades.d has a new status for an offer this list hasn't (it had fallen off the end of your 30 latest, or its
// change hasn't come yet): then the list is asked for again (askTrades).
export const tradesMissing = (list, { upd = [] }) => upd.some((row) => row && typeof row === 'object' && !('give' in row) && !list.some((t) => t.id === row.id));
// Your whole list again (lean1's trade 'list'). A change can pass it on the way, so a copy here that's newer than the list's
// is kept, and so is one the list hasn't that changed after everything in it (the list was read before it); the rest of
// what's here goes, as the list says.
let tradesAsk = null;
function askTrades() {
  if (tradesAsk) return;
  tradesAsk = rpc('trade', 'list', {}, { relink: false })
    .then((list) => {
      if (!Array.isArray(list)) return;
      const ids = new Set(list.map((t) => t?.id)), read = Math.max(0, ...list.map((t) => +t?.updated || 0));
      trades = tradesChanged(list, { upd: trades.filter((t) => ids.has(t.id) || (+t.updated || 0) > read) });
      emit('trades', trades);
    })
    .catch(() => {})
    .finally(() => { tradesAsk = null; });
}

// Tells the server what the pages watch now (each topic only to a server whose welcome named its capability: TOPIC_CAP), once
// the page changes of this moment are done: a page drawn again stops and starts watching at once, which says nothing.
function syncSubs() {
  if (subTimer) return;
  subTimer = setTimeout(() => {
    subTimer = null;
    if (status !== 'online' || !ws || ws.readyState !== 1) return;
    for (const topic of Object.keys(watching)) {
      if (!caps.has(TOPIC_CAP[topic])) continue;
      const want = watching[topic] > 0;
      if (!!subSent[topic] === want) continue;
      subSent[topic] = want;
      ws.send(JSON.stringify({ t: 'sub', [topic]: want }));
      // (No longer kept up to date: forgotten, so the page opening again shows none rather than old ones until they come.)
      if (topic === 'lobbies' && !want) lobbies = { battles: [], flips: [], jackpot: null };
    }
  }, 0);
}

// Result objects carry copies of items; point them at the inventory's objects so the UI sees one item. (lean1: an item the
// changes carry is in the answer as { uid } alone, and this is what makes it whole: the inventory's, which the changes have
// just put there, or else the changes' own copy.)
export function relink(r, d = null) {
  if (!r || typeof r !== 'object') return r;
  const byUid = new Map(S.inv.map((i) => [i.uid, i]));
  for (const it of [...(d?.add || []), ...(d?.upd || [])]) if (it && typeof it.uid === 'string' && !byUid.has(it.uid)) byUid.set(it.uid, it);
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      if (typeof v.uid === 'string' && byUid.has(v.uid)) return byUid.get(v.uid);
      for (const k of Object.keys(v)) v[k] = walk(v[k]);
    }
    return v;
  };
  return walk(r);
}

// relink: false resolves with the answer as it came (see relink).
function rpc(ns, m, args = {}, { relink: link = true } = {}) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1 || status !== 'online') return reject(Object.assign(new Error('Not connected to the server'), { remote: true }));
    const id = ++seq;
    pending.set(id, { resolve, reject, raw: !link });
    ws.send(JSON.stringify({ t: 'rpc', id, ns, m, args }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(Object.assign(new Error('The server did not answer'), { remote: true })); } }, 30000);
  });
}

// ---- remote backend: actions run on the server --------------------------------------------------------
const remoteBackend = {
  act(name, args) {
    return rpc('act', name, args);
  },
  // What this connection's server can do that an older one can't (backend.js can): 'buyOpen', case.open's buy, came with lean1.
  can: (what) => what === 'buyOpen' && net.lean(),
};
