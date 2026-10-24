import { $, $$, money, debounce, esc } from './util.js';
import { loadData } from './data.js';
import { S, loadState, on, saveSync, save, idleRate, addMoney, isOnlineState } from './state.js';
import { itemValue } from './items.js';
import { toast, topModal, openModal } from './ui.js';
import { loadGameSounds } from './audio.js';
import { keepPrepared } from './cs2/content.js';
import { net, normalizeUrl } from './net/online.js';
import { offlineEarnings as offlineFor, OFFLINE_CAP_S } from './engine/economy.js';
import * as cases from './pages/cases.js';
import * as inventory from './pages/inventory.js';
import * as tradeup from './pages/tradeup.js';
import * as armory from './pages/armory.js';
import * as clicker from './pages/clicker.js';
import * as market from './pages/market.js';
import * as gamble from './pages/gamble.js';
import * as team from './pages/team.js';
import * as trade from './pages/trade.js';
import * as coop from './pages/coop.js';
import * as stats from './pages/stats.js';
import * as database from './pages/database.js';
import * as play from './pages/play.js';

const PAGES = { play, cases, inventory, tradeup, armory, clicker, market, database, gamble, team, trade, coop, stats };
let current = null, currentName = 'cases';

function go(name) {
  if (!PAGES[name]) name = 'cases';
  current?.destroy?.();
  currentName = name;
  const root = $('#page');
  root.dataset.page = name;
  root.scrollTop = 0;
  $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.page === name));
  current = PAGES[name];
  current.render(root);
}

let lastMoney = 0;
function updateBalance() {
  const el = $('#balance');
  el.textContent = money(S.money);
  if (S.money > lastMoney + 0.5) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
  lastMoney = S.money;
}
const updateInv = debounce(() => {
  $('#inv-count').textContent = S.inv.length;
  $('#net-worth').textContent = 'Inventory ' + money(S.inv.reduce((s, i) => s + itemValue(i), 0));
  $('#idle-rate').textContent = '+' + money(idleRate()) + '/s';
}, 150);
const updateStars = () => { $('#star-count').textContent = S.stars || 0; };

// Passive income. Offline this is the real income; online it is a live estimate the server's total replaces.
function startIdleLoop() {
  let acc = 0, last = performance.now();
  setInterval(() => {
    const now = performance.now();
    const dt = (now - last) / 1000;
    last = now;
    acc += idleRate() * dt;
    if (acc >= 0.01) {
      const v = Math.floor(acc * 100) / 100;
      acc -= v;
      if (!isOnlineState()) S.stats.passiveEarned += v;
      addMoney(v);
    }
  }, 250);
  setInterval(() => save(), 15000);
}

function offlineEarnings() {
  const awayS = (Date.now() - (S.lastSeen || Date.now())) / 1000;
  const earned = offlineFor(S, awayS);
  if (earned <= 0) return;
  S.stats.passiveEarned += earned;
  addMoney(earned);
  const away = Math.min(OFFLINE_CAP_S, awayS);
  const h = Math.floor(away / 3600), m = Math.floor((away % 3600) / 60);
  toast(`Welcome back! Your bots and chickens earned <b class="green">${money(earned)}</b> while you were away (${h ? h + 'h ' : ''}${m}m).`, 'gold');
}

// ---- account (offline / online) ------------------------------------------------------------------
function updateAccount({ status, detail } = { status: net.status() }) {
  const el = $('#account');
  el.classList.toggle('online', status === 'online');
  el.classList.toggle('connecting', status === 'connecting');
  $('#account-name').textContent = status === 'online' ? net.me()?.name : status === 'connecting' ? 'Connecting…' : 'Offline';
  el.title = detail || (status === 'online' ? `Online at ${net.serverUrl()}` : 'Playing offline. Click to log in to a server.');
}

function accountModal() {
  if (net.status() === 'online') {
    const m = openModal({
      title: 'Online account',
      body: `<div class="auth"><div>Logged in as <b>${esc(net.me().name)}</b> on <span class="fair">${esc(net.serverUrl())}</span>.</div>
        <div class="muted" style="font-size:12px">Online progress is saved on the server. Your offline save is kept separately on this PC.</div></div>`,
      foot: '<button class="btn danger" data-out>Log out (play offline)</button><button class="btn ghost" data-close>Close</button>',
    });
    m.el.querySelector('[data-out]').addEventListener('click', () => { net.logout(); m.close(); toast('Back to your offline save.', ''); go(currentName === 'trade' ? 'cases' : currentName); });
    return;
  }
  const m = openModal({
    title: 'Play online',
    body: `<div class="auth">
      <div class="muted" style="font-size:13px;line-height:1.5">Log in to a game server to trade with friends, join live case battles, coinflips and jackpots, and see the shared Armory.
        Online accounts start fresh and are saved on the server; your offline save stays on this PC. Virtual money only.</div>
      <label>Server address<input class="input" data-url placeholder="e.g. my-cs2-server.onrender.com" value="${esc(net.serverUrl())}"></label>
      <label>Username<input class="input" data-name maxlength="20" autocomplete="username"></label>
      <label>Password<input class="input" data-pass type="password" autocomplete="current-password"></label>
      <div class="err" data-err></div>
    </div>`,
    foot: '<button class="btn" data-reg>Create account</button><span class="spacer"></span><button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-login>Log in</button>',
  });
  const err = m.el.querySelector('[data-err]');
  const submit = async (register) => {
    const url = normalizeUrl(m.el.querySelector('[data-url]').value);
    const name = m.el.querySelector('[data-name]').value.trim();
    const pass = m.el.querySelector('[data-pass]').value;
    if (!url) return (err.textContent = 'Enter the server address.');
    if (!name || !pass) return (err.textContent = 'Enter a username and password.');
    net.setServerUrl(url);
    err.textContent = '';
    m.el.querySelectorAll('.modal-foot .btn').forEach((b) => (b.disabled = true));
    try {
      await net.login(name, pass, { register });
      m.close();
      toast(`${register ? 'Account created. ' : ''}Online as <b>${esc(net.me().name)}</b>`, 'good');
      go(currentName);
    } catch (e) {
      err.textContent = e.message;
      m.el.querySelectorAll('.modal-foot .btn').forEach((b) => (b.disabled = false));
    }
  };
  m.el.querySelector('[data-login]').addEventListener('click', () => submit(false));
  m.el.querySelector('[data-reg]').addEventListener('click', () => submit(true));
  m.el.querySelector('[data-pass]').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(false); });
}

async function boot() {
  try {
    await loadData();
  } catch (e) {
    $('#page').innerHTML = `<div class="boot">Could not load game data: ${e.message}</div>`;
    return;
  }
  await loadState();
  loadGameSounds(); // CS2's own case sounds (from the local CS2 install), loaded in the background
  lastMoney = S.money;
  updateBalance();
  updateInv();
  updateStars();
  on('money', () => { updateBalance(); updateInv(); });
  on('inv', updateInv);
  on('stars', updateStars);
  on('reset', () => { lastMoney = S.money; updateBalance(); updateInv(); updateStars(); go(currentName); });
  net.on('status', updateAccount);
  net.on('notice', ({ msg, type }) => toast(msg, type || ''));
  $('#account').addEventListener('click', accountModal);
  $$('#nav button').forEach((b) => b.addEventListener('click', () => go(b.dataset.page)));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && topModal() && !document.querySelector('.inspect')) topModal().close();
  });
  window.addEventListener('beforeunload', () => saveSync());
  go('cases');
  offlineEarnings();
  startIdleLoop();
  updateAccount();
  net.resume();
  setTimeout(keepPrepared, 10000); // after a CS2 update, everything prepared is brought up to date in the background
  if (S.stats.opened === 0 && S.inv.length === 0 && S.money === 10) {
    toast('Welcome! You start with <b class="green">$10.00</b>. Open a case, or earn more on the <b>Earn</b> tab.', 'gold');
  }
}

boot();
