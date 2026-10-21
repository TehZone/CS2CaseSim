// Online play: account login, the WebSocket connection to the game server, and the remote backend that sends
// game actions to the server instead of running them locally.
//
// Protocol (JSON over WebSocket at <server>/ws):
//   client -> server  { t: 'hello', token, data }            first message; data = game data build stamp
//                     { t: 'rpc', id, ns, m, args }          ns: 'act' | 'gamble' | 'trade' | 'social'
//   server -> client  { t: 'welcome', user, state, ... }     after hello
//                     { t: 'res', id, ok, r, d, err }        reply to an rpc (d = state changes)
//                     { t: 'delta', d }                      state changes from elsewhere (trades, idle income, wins)
//                     { t: 'lobbies' | 'players' | 'trades' | 'gamble.result' | 'notice', ... }
import { D } from '../data.js';
import { S, applyDelta, enterOnline, leaveOnline, emit as emitState, clickValue } from '../state.js';
import { setRemote } from '../backend.js';

const LS = 'cs2sim-online';
const PROTOCOL = 1;
const bus = new EventTarget();
let ws = null, user = null, status = 'offline', seq = 0, retry = 0, retryTimer = null, wantOnline = false;
const pending = new Map();
let lobbies = { battles: [], flips: [], jackpot: null };
let players = [], trades = [];

const saved = () => { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch { return {}; } };
const store = (v) => { try { localStorage.setItem(LS, JSON.stringify({ ...saved(), ...v })); } catch {} };

function setStatus(s, detail = '') {
  status = s;
  emit('status', { status: s, detail });
}
function emit(type, detail) { bus.dispatchEvent(new CustomEvent(type, { detail })); }

export const net = {
  on(type, fn) { const h = (e) => fn(e.detail); bus.addEventListener(type, h); return () => bus.removeEventListener(type, h); },
  status: () => status,
  me: () => user,
  lobbies: () => lobbies,
  players: () => players,
  trades: () => trades,
  serverUrl: () => saved().url || '',
  setServerUrl: (url) => store({ url: normalizeUrl(url) }),
  gamble: (m, args) => rpc('gamble', m, args),
  trade: (m, args) => rpc('trade', m, args),
  social: (m, args) => rpc('social', m, args),
  login, logout, resume,
};

export function normalizeUrl(url) {
  url = String(url || '').trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\//.test(url)) url = (/^(localhost|127\.)/.test(url) ? 'http://' : 'https://') + url;
  return url;
}

async function http(path, body) {
  const url = net.serverUrl();
  if (!url) throw new Error('Set the server address first');
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
    await connect();
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
  if (saved().token && saved().url) connect().catch(() => {});
}

function connect() {
  return new Promise((resolve, reject) => {
    wantOnline = true;
    clearTimeout(retryTimer);
    const url = net.serverUrl().replace(/^http/, 'ws') + '/ws';
    setStatus('connecting', retry ? 'Reconnecting…' : 'Connecting…');
    try { ws?.close(); } catch {}
    const sock = new WebSocket(url);
    ws = sock;
    let welcomed = false;
    sock.onopen = () => sock.send(JSON.stringify({ t: 'hello', token: saved().token, data: D.generatedAt, v: PROTOCOL }));
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
        emit('notice', { msg: msg.error, type: 'bad' });
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
  setRemote(null);
  document.body.classList.remove('is-online');
  leaveOnline();
  setStatus('offline');
}

async function onWelcome(msg) {
  user = msg.user;
  players = msg.players || [];
  trades = msg.trades || [];
  lobbies = msg.lobbies || lobbies;
  if (msg.pricedAt && msg.pricedAt !== D.pricedAt) await syncPrices().catch((e) => console.warn('price sync failed', e));
  setRemote(remoteBackend);
  enterOnline(msg.state);
  document.body.classList.add('is-online');
  setStatus('online');
  emit('players', players);
  emit('trades', trades);
  emit('lobbies', lobbies);
  if (msg.offline) emit('notice', { msg: msg.offline, type: 'gold' });
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
      if (msg.ok) p.resolve(relink(msg.r));
      else p.reject(Object.assign(new Error(msg.err || 'Request failed'), { code: msg.code || 'bad', remote: true }));
      return;
    }
    case 'delta': applyDelta(msg.d); if (msg.note) emit('notice', { msg: msg.note, type: msg.noteType || 'gold' }); return;
    case 'lobbies': lobbies = msg.lobbies; emit('lobbies', lobbies); return;
    case 'players': players = msg.players; emit('players', players); return;
    case 'trades': trades = msg.trades; emit('trades', trades); return;
    case 'gamble.result': emit('gamble.result', msg.ev); return;
    case 'notice': emit('notice', { msg: msg.msg, type: msg.type }); return;
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

function rpc(ns, m, args = {}) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1 || status !== 'online') return reject(Object.assign(new Error('Not connected to the server'), { remote: true }));
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ t: 'rpc', id, ns, m, args }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(Object.assign(new Error('The server did not answer'), { remote: true })); } }, 30000);
  });
}

// ---- remote backend: actions run on the server --------------------------------------------------------
// Clicks are batched (one request per second) and shown immediately; the server's total replaces the guess.
let clickBatch = { n: 0, crits: 0 }, clickTimer = null;
function flushClicks() {
  clickTimer = null;
  const b = clickBatch;
  clickBatch = { n: 0, crits: 0 };
  if (b.n) rpc('act', 'click', b).catch(() => {});
}
const remoteBackend = {
  act(name, args) {
    if (name === 'click') {
      const v = clickValue() * (args.crits ? 10 : 1);
      S.money = Math.round((S.money + v) * 100) / 100;
      emitState('money');
      clickBatch.n += args.n || 1;
      clickBatch.crits += args.crits || 0;
      if (!clickTimer) clickTimer = setTimeout(flushClicks, 1000);
      return Promise.resolve({ earned: v });
    }
    return rpc('act', name, args);
  },
};
