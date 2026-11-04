import { $, $$, money, debounce, esc } from './util.js';
import { act, online } from './backend.js';
import { loadData } from './data.js';
import { S, loadState, on, saveSync, save, retiredOnLoad } from './state.js';
import { ownedValue } from './engine/storage.js';
import { toast, topModal, openModal, installTooltips } from './ui.js';
import { initMenu, initMoreMenu } from './menu.js';
import { loadGameSounds } from './audio.js';
import { keepPrepared } from './cs2/content.js';
import { net } from './net/online.js';
import * as cases from './pages/cases.js';
import * as inventory from './pages/inventory.js';
import * as tradeup from './pages/tradeup.js';
import * as armory from './pages/armory.js';
import * as market from './pages/market.js';
import * as gamble from './pages/gamble.js';
import * as trade from './pages/trade.js';
import * as stats from './pages/stats.js';
import * as database from './pages/database.js';
import * as itemindex from './pages/itemindex.js';
import * as play from './pages/play.js';
import * as community from './pages/community.js';
import * as admin from './pages/admin.js';
import * as changelog from './pages/changelog.js';
import { npcOf, crowd, inventoryOf } from './engine/npcs.js';
import { initMatchmaking } from './matchmaking.js';
import { initProfile } from './profile.js';
import { initAccount, discordSection, bindDiscordSection, openResetModal, staffPc } from './account.js';
import { initUpdates } from './update.js';

const PAGES = { play, cases, inventory, tradeup, armory, market, index: itemindex, database, gamble, trade, stats, community, admin, changelog };
let current = null, currentName = 'cases';

function go(name) {
  if (!PAGES[name]) name = 'cases';
  current?.destroy?.();
  currentName = name;
  const root = $('#page');
  root.dataset.page = name;
  root.scrollTop = 0;
  $$('#topbar [data-page]').forEach((b) => b.classList.toggle('active', b.dataset.page === name));
  // A section from the More menu: its name shows on the More button.
  $('.more-cur').textContent = $(`.more-panel [data-page="${name}"] .mlbl`)?.textContent || '';
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
  $('#net-worth').textContent = money(ownedValue(S));
}, 150);
const updateStars = () => { $('#star-count').textContent = S.stars || 0; };
// Unread messages and friend requests from the NPC players (offline).
const updateMessages = () => {
  const n = online() ? 0 : community.unreadCount(), el = $('#msg-count');
  el.hidden = !n;
  el.textContent = n;
};

// Offline, the NPC players go about their business while the game is open (and catch up a little after time away or a
// match): they buy from the market, and message you with offers for your rare items. New messages pop up unless you're
// already reading that chat.
function startNpcLoop() {
  const tick = async () => {
    // (Not during a match: they catch up afterwards, and the match's frames stay smooth.)
    if (online() || document.querySelector('.play-canvas')) return;
    let r;
    try { r = await act('npc.tick'); } catch { return; }
    for (const e of (r.events || []).slice(0, 2)) {
      if ((currentName === 'community' && document.querySelector(`.fr-row.on[data-who="${e.npc}"]`))) continue;
      const name = S.social ? npcOf(S.social.seed, e.npc)?.name : '';
      toast(`<b>${esc(name || 'Someone')}</b>: ${esc(e.text.length > 120 ? e.text.slice(0, 117) + '…' : e.text)}`, 'msg');
    }
  };
  setTimeout(tick, 4000);
  setInterval(tick, 30000);
  setTimeout(warmNpcs, 6000);
}
// What the 2,000 NPC players own (tens of thousands of items), worked out a few at a time while the app is idle rather
// than all at once when the Item Database or your float ranks first ask (engine/npcs.js keeps it for the session).
function warmNpcs() {
  const so = S.social;
  if (online() || !so) return;
  const people = crowd(so.seed);
  let i = 0;
  const step = (deadline) => {
    if (online()) return;
    if (document.querySelector('.play-canvas')) { setTimeout(() => requestIdleCallback(step), 10000); return; } // (not during a match)
    while (i < people.length && deadline.timeRemaining() > 3) inventoryOf(so, people[i++]);
    if (i < people.length) requestIdleCallback(step);
  };
  requestIdleCallback(step);
}


// ---- account (offline / online) ------------------------------------------------------------------
function updateAccount({ status, detail } = { status: net.status() }) {
  const el = $('#account');
  el.classList.toggle('online', status === 'online');
  el.classList.toggle('connecting', status === 'connecting');
  $('#account-name').textContent = status === 'online' ? net.me()?.name : status === 'connecting' ? 'Connecting…' : 'Offline';
  el.title = detail || (status === 'online' ? net.onlineText() : 'Playing offline. Click to log in.');
}

function accountModal() {
  if (net.status() === 'online') {
    const m = openModal({
      title: 'Online account',
      body: `<div class="auth"><div data-online-text>${esc(net.onlineText())}</div>
        <div class="muted" style="font-size:12px">Online progress is saved on the server. Your offline save is kept separately on this PC.</div>${discordSection()}</div>`,
      foot: '<button class="btn danger" data-out>Log out (play offline)</button><button class="btn ghost" data-close>Close</button>',
    });
    bindDiscordSection(m);
    m.el.querySelector('[data-out]').addEventListener('click', () => { net.logout(); m.close(); toast('Back to your offline save.', ''); go(currentName === 'trade' || (currentName === 'admin' && !staffPc()) ? 'cases' : currentName); });
    return;
  }
  const m = openModal({
    title: 'Play online',
    body: `<div class="auth">
      <div class="muted" style="font-size:13px;line-height:1.5">Log in to trade with friends, join live case battles, coinflips and jackpots, and see the shared Armory.
        Online accounts start fresh and are saved on the server; your offline save stays on this PC. Virtual money only.</div>
      <label>Username<input class="input" data-name maxlength="20" autocomplete="username"></label>
      <label>Password<input class="input" data-pass type="password" autocomplete="current-password"></label>
      <div class="err" data-err></div>
      <button type="button" class="link-btn" data-forgot>Forgot password?</button>
    </div>`,
    foot: '<button class="btn" data-reg>Create account</button><span class="spacer"></span><button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-login>Log in</button>',
  });
  const err = m.el.querySelector('[data-err]');
  const submit = async (register) => {
    const name = m.el.querySelector('[data-name]').value.trim();
    const pass = m.el.querySelector('[data-pass]').value;
    if (!name || !pass) return (err.textContent = 'Enter a username and password.');
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
  m.el.querySelector('[data-forgot]').addEventListener('click', () => openResetModal({
    name: m.el.querySelector('[data-name]').value.trim(),
    onDone: (name) => { m.el.querySelector('[data-name]').value = name; err.textContent = ''; m.el.querySelector('[data-pass]').focus(); },
  }));
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
  on('social', updateMessages);
  on('reset', () => { lastMoney = S.money; updateBalance(); updateInv(); updateStars(); updateMessages(); go(currentName); });
  net.on('status', updateAccount);
  net.on('players', () => { updateAccount(); $$('[data-online-text]').forEach((el) => { el.textContent = net.onlineText(); }); });
  net.on('notice', ({ msg, type }) => toast(msg, type || ''));
  $('#account').addEventListener('click', accountModal);
  $$('#topbar [data-page]').forEach((b) => b.addEventListener('click', () => go(b.dataset.page)));
  installTooltips();
  initMoreMenu();
  initMenu();
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && topModal() && !document.querySelector('.inspect')) topModal().close();
  });
  window.addEventListener('beforeunload', () => saveSync());
  // Matchmaking (matchmaking.js) opens a page (the Play page when Esc brings up the menu over a match) and draws the
  // page again when a match ends.
  window.addEventListener('app:go', (e) => go(e.detail));
  window.addEventListener('app:refresh', () => go(currentName));
  initMatchmaking();
  initProfile();
  initAccount();
  initUpdates();
  itemindex.initIndex();
  startNpcLoop();
  go('cases');
  setInterval(() => save(), 15000);
  updateAccount();
  net.resume();
  setTimeout(keepPrepared, 10000); // after a CS2 update, everything prepared is brought up to date in the background
  if (retiredOnLoad?.n) {
    save();
    toast(`Chickens and player cards are no longer in the game, so ${retiredOnLoad.n === 1 ? 'yours was' : `your ${retiredOnLoad.n} were`} sold for <b class="green">${money(retiredOnLoad.value)}</b>.`, 'gold');
  }
  if (S.stats.opened === 0 && S.inv.length === 0 && S.money === 10) {
    toast('Welcome! You start with <b class="green">$10.00</b>. Earn more by playing matches in <b>Play</b>: $250 a win, $100 a loss, $20 a kill.', 'gold');
  }
}

boot();
