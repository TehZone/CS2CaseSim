// Passive income in the game (src/js/passive.js) and the connection's handling of changes around its welcome
// (src/js/net/online.js): the real modules, with the real engine, state and backend, against a stand-in WebSocket. ui.js is
// the one module replaced (its toasts are recorded), the page's globals are stand-ins, nothing goes on the network, and the
// clock and the game's once-every-10-seconds look are moved by hand.
//   node scripts/test-passive-client.mjs
import { register } from 'node:module';

// ---- the page, without one -------------------------------------------------------------------------------------------
const toasts = [];
globalThis.__toasts = toasts;
register('data:text/javascript,' + encodeURIComponent(`
  const UI = 'data:text/javascript,' + encodeURIComponent('export const toast = (msg, type, ms) => { globalThis.__toasts.push({ msg, type, ms }); };');
  export async function resolve(specifier, context, next) {
    const r = await next(specifier, context);
    return r.url.endsWith('/src/js/ui.js') ? { url: UI, shortCircuit: true } : r;
  }`));

const ls = new Map([['cs2sim-online', JSON.stringify({ token: 'tok', url: 'http://127.0.0.1:9' })]]); // (a saved login)
globalThis.localStorage = { getItem: (k) => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) };
globalThis.window = {};
globalThis.document = { body: { classList: { toggle() {}, add() {}, remove() {} } } };

// The server's side of the connection: the test says when it opens, fails, and what it sends.
const sockets = [];
class FakeSocket {
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { if (this.readyState === 3) return; this.readyState = 3; setTimeout(() => this.onclose?.(), 0); } // (as a browser: later)
  open() { this.readyState = 1; this.onopen?.(); }
  fail() { this.readyState = 3; this.onclose?.(); }
  deliver(m) { this.onmessage?.({ data: JSON.stringify(m) }); }
}
globalThis.WebSocket = FakeSocket;
let pricesGate = Promise.resolve();
globalThis.fetch = async (url) => {
  if (String(url).endsWith('/api/prices')) { await pricesGate; return { ok: true, json: async () => ({ pricedAt: 'P2' }) }; }
  return { ok: true, json: async () => ({}) };
};

// The clock, and the game's timers (passive.js looks every 10 seconds; the keep-alive's never runs).
const MIN = 60e3, HOUR = 3600e3;
let now = Date.UTC(2026, 10, 10, 12);
Date.now = () => now;
const intervals = [];
globalThis.setInterval = (fn, ms) => { const h = { fn, ms, unref() {}, ref() {} }; intervals.push(h); return h; };
globalThis.clearInterval = (h) => { const i = intervals.indexOf(h); if (i >= 0) intervals.splice(i, 1); };
const look = () => intervals.find((h) => h.ms === 10e3).fn();
const settle = () => new Promise((r) => setTimeout(r, 10));

const state = await import('../src/js/state.js');
const { net } = await import('../src/js/net/online.js');
const { online } = await import('../src/js/backend.js');
const { initPassive } = await import('../src/js/passive.js');

let failed = 0, passed = 0;
const check = (name, ok, info = '') => { ok ? passed++ : failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const since = (n) => toasts.slice(n).map((t) => t.msg.replace(/<[^>]+>/g, ''));

try {
  // ---- opening the game with a saved login, and the server can't be reached --------------------------------------------
  state.S.money = 10;
  state.S.passive = { at: now - 5 * HOUR, earned: 0 };
  net.resume(); // (main.js: before initPassive)
  initPassive();
  await settle();
  check('opening the game with a saved login: the offline save is paid its 5 hours, and the toast waits while connecting',
    state.S.money === 30010 && toasts.length === 0 && net.status() === 'connecting' && sockets.length === 1, `money ${state.S.money}, toasts ${toasts.length}`);
  sockets[0].fail();
  await settle();
  let t = since(0);
  check('the attempt fails (the game keeps trying): one toast for the time away, without the 12-hour note',
    t.length === 1 && t[0] === 'While you were away you earned $30,000.00' && net.status() === 'connecting' && !online(), JSON.stringify(t));
  check('(it shows for longer than a toast does)', toasts[0]?.ms >= 5000);

  // ---- while the game runs: the minutes, without toasts ------------------------------------------------------------------
  let n = toasts.length;
  now += MIN; look(); await settle();
  now += 2 * MIN; look(); await settle();
  check('while it runs: a minute, then two at once, put the money up with no toast', state.S.money === 30310 && toasts.length === n, `money ${state.S.money}`);
  now -= HOUR; look(); await settle();
  now += MIN; look(); await settle();
  check('the PC\'s clock put back an hour pays nothing, then counts on from there', state.S.money === 30410 && toasts.length === n);

  // ---- the PC sleeps 13 hours while still trying; then the connection works ----------------------------------------------
  now += 13 * HOUR; look(); await settle();
  check('13 hours asleep: the offline save is paid 12 hours, its toast held while connecting', state.S.money === 102410 && toasts.length === n);
  net.resume(); // (the retry: a new attempt starts, which says nothing yet about the last one)
  await settle();
  const sock = sockets.at(-1);
  sock.open();
  check('the new attempt says hello', sock.sent[0]?.t === 'hello' && sock.sent[0].token === 'tok' && toasts.length === n);
  sock.deliver({ t: 'delta', d: { set: { money: 999999, stars: 99 } } }); // (before the welcome: it's in the welcome's state)
  let release;
  pricesGate = new Promise((r) => (release = r));
  sock.deliver({ t: 'welcome', user: { id: 1, name: 'alice' }, state: { money: 777, stars: 1, passive: { at: now, earned: 500 } }, pricedAt: 'P2', serverTime: now,
    players: [], trades: [], lobbies: null, market: {}, account: null, motd: '', away: { earned: 500, minutes: 5, capped: false } });
  await settle();
  sock.deliver({ t: 'delta', d: { set: { stars: 5 } } }); // (while the welcome is being taken in: prices synced first)
  check('a change before the welcome, or while it\'s taken in, never lands on the offline save', state.S.money === 102410 && state.S.stars === 0 && !online());
  release();
  await settle();
  t = since(n);
  check('online: the account\'s state, with the change that came while the welcome was taken in', online() && state.S.money === 777 && state.S.stars === 5);
  check('online: one toast, the account\'s own time away; the offline save\'s held one isn\'t shown', t.length === 1 && t[0] === 'While you were away you earned $500.00', JSON.stringify(t));

  // ---- online: the server pays; the offline save waits ---------------------------------------------------------------------
  n = toasts.length;
  sock.deliver({ t: 'delta', d: { set: { money: 877, passive: { at: now + MIN, earned: 600 } } } }); // (the server's minute)
  now += 10 * MIN; look(); await settle();
  check('online: the server\'s minute puts the money up, with no toast, and the game collects nothing itself', state.S.money === 877 && toasts.length === n);

  // ---- logging out: back on the offline save -------------------------------------------------------------------------------
  net.logout();
  await settle();
  t = since(n);
  check('logging out: one toast with all the offline save earned while you were away from it (the 13 hours and the 10 minutes online)',
    t.length === 1 && t[0] === 'Your offline save earned $73,000.00 while you were away from it (12 hours max)', JSON.stringify(t));
  check('and the offline save has it, and nothing the server sent', !online() && net.status() === 'offline' && state.S.money === 103410 && state.S.stars === 0, `money ${state.S.money}`);

  // ---- offline, no login: time away is told at once -------------------------------------------------------------------------
  n = toasts.length;
  now += 4 * HOUR + 30e3; look(); await settle();
  t = since(n);
  check('offline: 4 hours asleep is told at once', t.length === 1 && t[0] === 'While you were away you earned $24,000.00' && state.S.money === 127410, JSON.stringify(t));
  now += 30e3; look(); await settle();
  check('and the half minute left over makes the next minute', state.S.money === 127510 && toasts.length === n + 1);
} catch (e) {
  failed++;
  console.log('FAIL  (threw)', e);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
