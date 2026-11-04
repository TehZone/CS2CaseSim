// Online play: account login, the WebSocket connection to the game server, and the remote backend that sends
// game actions to the server instead of running them locally.
//
// Protocol (JSON over WebSocket at <server>/ws):
//   client -> server  { t: 'hello', token, data, v, app }    first message; data = game data build stamp, app = the game's version
//                     { t: 'rpc', id, ns, m, args }          ns: 'act' | 'gamble' | 'trade' | 'social' | 'account' | 'admin'
//   server -> client  { t: 'welcome', user, state, account, motd, ... }   after hello
//                     { t: 'res', id, ok, r, d, err }        reply to an rpc (d = state changes)
//                     { t: 'delta', d }                      state changes from elsewhere (trades, idle income, wins)
//                     { t: 'account', account }              your Discord link or staff level changed
//                     { t: 'admin.msg', kind, msg, from }    a moderator's warning or a broadcast
//                     { t: 'fatal', code, error, ban? }      refused or thrown off (auth, version, outdated, banned, kicked, maintenance)
//                     { t: 'update', version }               a new release is out: this game is about to be locked out
//                     { t: 'lobbies' | 'players' | 'trades' | 'gamble.result' | 'notice', ... }
import { D } from '../data.js';
import { S, applyDelta, enterOnline, leaveOnline } from '../state.js';
import { setRemote } from '../backend.js';

const LS = 'cs2sim-online';
const PROTOCOL = 1;
// The one server the game plays on, and the only place its address is written: changing it is this one line, and only
// when the user says so. Its address shows to staff in the admin panel and nowhere else, so no text may be built from it.
// A packaged game plays nowhere else: there is no way to choose, and a server saved by an older install is ignored,
// with the login that went with it. Development only (`npm run dev`, `electron .`): a local
// server is net.setServerUrl('http://localhost:8787') in the console. A test run of any build: CS2SIM_SMOKE_SERVER
// (localhost only, see shared/updater.cjs).
const SERVER = 'https://cs2-case-sim-server.onrender.com';
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
// Free hosts (Render) put a server to sleep after 15 minutes without incoming requests; ping it while playing.
let keepAlive = null;
const startKeepAlive = () => { clearInterval(keepAlive); keepAlive = setInterval(() => { if (status === 'online') fetch(net.serverUrl() + '/health').catch(() => {}); }, 5 * 60 * 1000); };

const saved = () => { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch { return {}; } };
const store = (v) => { try { localStorage.setItem(LS, JSON.stringify({ ...saved(), ...v })); } catch {} };
if (packaged && saved().url) store({ url: null, ...(saved().url === SERVER ? {} : { token: null }) });

function setStatus(s, detail = '') {
  status = s;
  emit('status', { status: s, detail });
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
  account: () => account,
  motd: () => motd,
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
    let welcomed = false;
    sock.onopen = () => sock.send(JSON.stringify({ t: 'hello', token: saved().token, data: D.generatedAt, v: PROTOCOL, app: build.version }));
    sock.onmessage = async (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.t === 'welcome') {
        welcomed = true;
        retry = 0;
        await onWelcome(msg);
        resolve();
      } else if (msg.t === 'fatal') {
        wantOnline = false;
        if (msg.code === 'auth') store({ token: null });
        reject(new Error(msg.error));
        // A ban, kick, maintenance or an outdated game gets a window of its own instead of a toast.
        if (SHOWN_FATAL.has(msg.code)) emit('fatal', { code: msg.code, error: msg.error || '', ban: msg.ban || null, required: msg.required || '', asked });
        else emit('notice', { msg: msg.error, type: 'bad' });
        sock.close();
      } else handle(msg);
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      for (const [, p] of pending) p.reject(Object.assign(new Error('Connection lost'), { remote: true }));
      pending.clear();
      if (!welcomed) reject(new Error('Could not connect to the server'));
      if (wantOnline) {
        setStatus('connecting', 'Connection lost, reconnecting…');
        retryTimer = setTimeout(() => connect().catch(() => {}), Math.min(30000, 1000 * 2 ** retry++));
      } else disconnect();
    };
  });
}

function disconnect() {
  try { ws?.close(); } catch {}
  ws = null;
  user = null;
  clearInterval(keepAlive);
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
  players = msg.players || [];
  trades = msg.trades || [];
  lobbies = msg.lobbies || lobbies;
  if (msg.pricedAt && msg.pricedAt !== D.pricedAt) await syncPrices().catch((e) => console.warn('price sync failed', e));
  setRemote(remoteBackend);
  enterOnline(msg.state);
  document.body.classList.add('is-online');
  setStatus('online');
  startKeepAlive();
  emit('players', players);
  emit('trades', trades);
  emit('lobbies', lobbies);
  emit('account', account);
}

// Use the server's market prices so item values match what the server pays.
async function syncPrices() {
  const p = await http('/api/prices');
  for (const [id, v] of Object.entries(p.skins || {})) if (D.skins[id]) D.skins[id].p = v;
  for (const [id, v] of Object.entries(p.stickers || {})) if (D.stickers[id]) D.stickers[id].p = v;
  for (const [id, v] of Object.entries(p.agents || {})) if (D.agents[id]) D.agents[id].p = v;
  for (const [id, v] of Object.entries(p.cases || {})) if (D.caseById[id]) D.caseById[id].price = v;
  D.pricedAt = p.pricedAt;
}

function handle(msg) {
  switch (msg.t) {
    case 'res': {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.d) applyDelta(msg.d);
      if (msg.ok) p.resolve(p.raw ? msg.r : relink(msg.r));
      else p.reject(Object.assign(new Error(msg.err || 'Request failed'), { code: msg.code || 'bad', remote: true }));
      return;
    }
    case 'delta': applyDelta(msg.d); if (msg.note) emit('notice', { msg: msg.note, type: msg.noteType || 'gold' }); return;
    case 'lobbies': lobbies = msg.lobbies; emit('lobbies', lobbies); return;
    case 'players': players = msg.players; emit('players', players); return;
    case 'trades': trades = msg.trades; emit('trades', trades); return;
    case 'gamble.result': emit('gamble.result', msg.ev); return;
    case 'notice': emit('notice', { msg: msg.msg, type: msg.type }); return;
    case 'market': net.marketSold(msg.w).add(msg.lid); emit('market', msg); return;
    case 'account': setAccount(msg.account); return;
    case 'admin.msg': emit('admin.msg', { kind: msg.kind, msg: msg.msg || '', from: msg.from || '' }); return;
    case 'update': emit('update', { version: msg.version || '' }); return;
  }
}

// Result objects carry copies of items; point them at the inventory's objects so the UI sees one item.
function relink(r) {
  if (!r || typeof r !== 'object') return r;
  const byUid = new Map(S.inv.map((i) => [i.uid, i]));
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
};
