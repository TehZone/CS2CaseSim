import { $, $$, money, debounce } from './util.js';
import { loadData } from './data.js';
import { S, loadState, on, saveSync, save, idleRate, addMoney } from './state.js';
import { itemValue } from './items.js';
import { toast, topModal } from './ui.js';
import { loadGameSounds } from './audio.js';
import * as cases from './pages/cases.js';
import * as inventory from './pages/inventory.js';
import * as clicker from './pages/clicker.js';
import * as market from './pages/market.js';
import * as coop from './pages/coop.js';
import * as stats from './pages/stats.js';

const PAGES = { cases, inventory, clicker, market, coop, stats };
let current = null;

function go(name) {
  if (!PAGES[name]) name = 'cases';
  current?.destroy?.();
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
      S.stats.passiveEarned += v;
      addMoney(v);
    }
  }, 250);
  setInterval(() => save(), 15000);
}

function offlineEarnings() {
  const away = Math.min(8 * 3600, (Date.now() - (S.lastSeen || Date.now())) / 1000);
  const rate = idleRate();
  if (away < 60 || rate <= 0) return;
  const earned = Math.floor(rate * away * 0.5 * 100) / 100;
  if (earned <= 0) return;
  S.stats.passiveEarned += earned;
  addMoney(earned);
  const h = Math.floor(away / 3600), m = Math.floor((away % 3600) / 60);
  toast(`Welcome back! Your bots and chickens earned <b class="green">${money(earned)}</b> while you were away (${h ? h + 'h ' : ''}${m}m).`, 'gold');
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
  on('money', () => { updateBalance(); updateInv(); });
  on('inv', updateInv);
  on('reset', () => go('cases'));
  $$('#nav button').forEach((b) => b.addEventListener('click', () => go(b.dataset.page)));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && topModal() && !document.querySelector('.inspect')) topModal().close();
  });
  window.addEventListener('beforeunload', () => saveSync());
  go('cases');
  offlineEarnings();
  startIdleLoop();
  if (S.stats.opened === 0 && S.inv.length === 0 && S.money === 10) {
    toast('Welcome! You start with <b class="green">$10.00</b>. Open a case, or earn more on the <b>Earn</b> tab.', 'gold');
  }
}

boot();
