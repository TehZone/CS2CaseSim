// Trading with other players (online only): browse someone's inventory, offer items and/or money for theirs,
// and accept, decline or counter offers. The server swaps both sides in one step, so nothing can be duplicated.
import { esc, money, timeAgo } from '../util.js';
import * as I from '../items.js';
import { S, on } from '../state.js';
import { sfx } from '../audio.js';
import { toast, showItemDetail, confirmDialog } from '../ui.js';
import { online } from '../backend.js';
import { mountPicker } from '../picker.js';
import { net } from '../net/online.js';

const view = { with: null, theirInv: [], mine: new Set(), theirs: new Set(), myMoney: 0, theirMoney: 0, msg: '', q: '', loading: false };
let root = null, offs = [];

export function render(r) {
  root = r;
  offs.forEach((o) => o());
  offs = [net.on('players', () => drawPlayers()), net.on('trades', () => drawOffers()), on('inv', () => drawCompose())];
  draw();
}
export function destroy() { offs.forEach((o) => o()); offs = []; root = null; }

function draw() {
  if (!root) return;
  if (!online()) {
    root.innerHTML = '<div class="page"><div class="empty">Trading needs an online account. Click <b>Offline</b> at the top right to log in.</div></div>';
    return;
  }
  root.innerHTML = `<div class="page">
    <div class="page-head"><h1>Trade</h1><span class="sub">Swap items and money with other players. Both sides must accept; the swap happens in one step on the server.</span></div>
    <div style="display:grid;grid-template-columns:260px 1fr;gap:20px;align-items:start">
      <div class="panel"><h3>Players</h3>
        <div class="toolbar" style="margin-bottom:8px"><input class="input" data-find placeholder="Find by name…" style="width:100%"></div>
        <div class="players" data-players></div></div>
      <div>
        <div data-offers></div>
        <div data-compose></div>
      </div>
    </div>
  </div>`;
  root.querySelector('[data-find]').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.value.trim()) pickPlayer(e.target.value.trim()); });
  drawPlayers();
  drawOffers();
  drawCompose();
}

function drawPlayers() {
  const el = root?.querySelector('[data-players]');
  if (!el) return;
  const me = net.me();
  const list = net.players().filter((p) => p.name !== me?.name);
  el.innerHTML = list.length ? list.map((p) => `<div class="player ${view.with === p.name ? 'on' : ''}" data-p="${esc(p.name)}">
    <span class="avatar" style="--c:hsl(${[...p.name].reduce((a, c) => a + c.charCodeAt(0), 0) % 360} 55% 40%)">${esc(p.name.slice(0, 2).toUpperCase())}</span>
    <div><div>${esc(p.name)}</div><div class="muted" style="font-size:11px">${p.online ? '<span class="green">online</span>' : 'offline'} · ${money(p.worth || 0)}</div></div></div>`).join('')
    : '<div class="muted" style="font-size:12px">Nobody else is online. You can still trade with offline players by name.</div>';
  el.querySelectorAll('[data-p]').forEach((x) => x.addEventListener('click', () => pickPlayer(x.dataset.p)));
}

async function pickPlayer(name, prefill = null) {
  view.with = name; view.loading = true;
  view.mine = new Set(prefill?.mine || []); view.theirs = new Set(prefill?.theirs || []);
  view.myMoney = prefill?.myMoney || 0; view.theirMoney = prefill?.theirMoney || 0;
  drawPlayers(); drawCompose();
  try {
    const r = await net.trade('inventory', { name });
    view.with = r.name;
    view.theirInv = r.items;
  } catch (e) {
    toast(esc(e.message), 'bad');
    view.with = null;
  }
  view.loading = false;
  drawPlayers(); drawCompose();
}

function drawCompose() {
  const el = root?.querySelector('[data-compose]');
  if (!el) return;
  if (!view.with) { el.innerHTML = '<div class="panel"><h3>New offer</h3><div class="muted">Pick a player on the left to see their inventory.</div></div>'; return; }
  if (view.loading) { el.innerHTML = `<div class="panel"><h3>Trading with ${esc(view.with)}</h3><div class="muted">Loading their inventory…</div></div>`; return; }
  const sum = (items, set) => items.filter((i) => set.has(i.uid)).reduce((s, i) => s + I.itemValue(i), 0);
  const give = sum(S.inv, view.mine) + (+view.myMoney || 0), get = sum(view.theirInv, view.theirs) + (+view.theirMoney || 0);
  el.innerHTML = `<div class="panel"><h3>Offer to ${esc(view.with)}</h3>
    <div class="offer-sides">
      <div class="offer-side"><h4>You give · <span class="green">${money(give)}</span></h4>
        <label class="check" style="margin-bottom:8px">Money <input class="input" type="number" min="0" step="0.01" data-mym value="${view.myMoney}" style="width:110px"></label><div data-mypick></div></div>
      <div class="offer-side"><h4>You get · <span class="green">${money(get)}</span></h4>
        <label class="check" style="margin-bottom:8px">Money <input class="input" type="number" min="0" step="0.01" data-thm value="${view.theirMoney}" style="width:110px"></label><div data-thpick></div></div>
    </div>
    <div class="open-row" style="margin-top:12px">
      <input class="input" data-msg placeholder="Message (optional)" maxlength="140" value="${esc(view.msg)}" style="flex:1">
      <button class="btn gold" data-send>Send offer</button>
    </div></div>`;
  mountPicker(el.querySelector('[data-mypick]'), { items: () => S.inv.filter((i) => !i.lk), selected: view.mine, onChange: () => drawCompose(), empty: 'No unlocked items' });
  mountPicker(el.querySelector('[data-thpick]'), { items: () => view.theirInv, selected: view.theirs, onChange: () => drawCompose(), empty: 'They have no tradable items' });
  el.querySelector('[data-mym]').addEventListener('change', (e) => { view.myMoney = Math.max(0, +e.target.value || 0); drawCompose(); });
  el.querySelector('[data-thm]').addEventListener('change', (e) => { view.theirMoney = Math.max(0, +e.target.value || 0); drawCompose(); });
  el.querySelector('[data-msg]').addEventListener('input', (e) => { view.msg = e.target.value; });
  el.querySelector('[data-send]').addEventListener('click', send);
}

async function send() {
  if (!view.mine.size && !view.theirs.size && !view.myMoney && !view.theirMoney) return toast('Add something to the offer', 'bad');
  try {
    await net.trade('offer', {
      to: view.with, give: { uids: [...view.mine], money: +view.myMoney || 0 }, get: { uids: [...view.theirs], money: +view.theirMoney || 0 }, msg: view.msg,
      counterOf: view.counterOf || null,
    });
    view.counterOf = null;
    sfx.buy();
    toast(`Offer sent to ${esc(view.with)}`, 'good');
    view.mine.clear(); view.theirs.clear(); view.myMoney = 0; view.theirMoney = 0; view.msg = '';
    drawCompose();
  } catch (e) { sfx.error(); toast(esc(e.message), 'bad'); }
}

function sideHTML(side, label) {
  return `<div class="offer-side"><h4>${label} · <span class="green">${money(side.items.reduce((s, i) => s + I.itemValue(i), 0) + (side.money || 0))}</span></h4>
    ${side.money ? `<div class="green" style="margin-bottom:6px">${money(side.money)} cash</div>` : ''}
    <div class="offer-items">${side.items.map((it) => `<div class="oi" style="--rc:${I.rarityInfo(it).c}" data-item='${esc(JSON.stringify(it))}' title="${esc(I.itemName(it))}"><img src="${I.itemImage(it, 's')}"><div>${esc(I.nameParts(it).bottom)}</div><div class="v">${money(I.itemValue(it))}</div></div>`).join('') || '<span class="muted" style="font-size:12px">Nothing</span>'}</div></div>`;
}

function drawOffers() {
  const el = root?.querySelector('[data-offers]');
  if (!el) return;
  const me = net.me();
  const list = net.trades();
  const open = list.filter((t) => t.status === 'open');
  const done = list.filter((t) => t.status !== 'open').slice(0, 10);
  const card = (t) => {
    const incoming = t.to.name === me?.name;
    const other = incoming ? t.from.name : t.to.name;
    // From my point of view: what I give and what I get.
    const mineSide = incoming ? t.get : t.give, theirSide = incoming ? t.give : t.get;
    return `<div class="trade-card">
      <div style="display:flex;gap:10px;align-items:center"><span class="chip ${incoming ? 'gold' : ''}">${incoming ? 'Incoming' : 'Sent'}</span>
        <b>${esc(other)}</b><span class="muted" style="font-size:12px">${timeAgo(t.created)}</span>
        ${t.status !== 'open' ? `<span class="chip ${t.status === 'accepted' ? 'green' : 'red'}">${esc(t.status)}</span>` : ''}
        ${t.msg ? `<span class="muted" style="font-size:12px">“${esc(t.msg)}”</span>` : ''}</div>
      <div class="offer-sides">${sideHTML(mineSide, 'You give')}${sideHTML(theirSide, 'You get')}</div>
      ${t.status === 'open' ? `<div class="open-row">${incoming ? `<button class="btn primary" data-accept="${t.id}" data-v="${t.version}">Accept</button><button class="btn" data-counter="${t.id}">Counter</button><button class="btn ghost" data-decline="${t.id}">Decline</button>` : `<button class="btn ghost" data-cancel="${t.id}">Cancel offer</button>`}</div>` : ''}
    </div>`;
  };
  el.innerHTML = `${open.length ? `<div class="section-title" style="margin-top:0">Open offers (${open.length})</div><div style="display:flex;flex-direction:column;gap:10px">${open.map(card).join('')}</div>` : ''}
    ${done.length ? `<details style="margin:14px 0"><summary class="muted" style="cursor:pointer">Recent trades (${done.length})</summary><div style="display:flex;flex-direction:column;gap:10px;margin-top:10px">${done.map(card).join('')}</div></details>` : ''}`;
  el.querySelectorAll('[data-item]').forEach((x) => x.addEventListener('click', () => showItemDetail(JSON.parse(x.dataset.item))));
  const call = async (m, args, ok) => { try { await net.trade(m, args); if (ok) { sfx.coin(); toast(ok, 'good'); } } catch (e) { sfx.error(); toast(esc(e.message), 'bad'); } };
  el.querySelectorAll('[data-accept]').forEach((b) => b.addEventListener('click', async () => {
    const t = list.find((x) => x.id === b.dataset.accept);
    if (await confirmDialog(`Accept this trade with <b>${esc(t.from.name)}</b>? It can't be undone.`, { ok: 'Accept trade' })) call('accept', { id: t.id, version: t.version }, 'Trade complete!');
  }));
  el.querySelectorAll('[data-decline]').forEach((b) => b.addEventListener('click', () => call('decline', { id: b.dataset.decline })));
  el.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', () => call('cancel', { id: b.dataset.cancel })));
  el.querySelectorAll('[data-counter]').forEach((b) => b.addEventListener('click', () => {
    const t = list.find((x) => x.id === b.dataset.counter);
    // Start a new offer to the sender with the same items, ready to adjust (the original is declined when it's sent).
    view.counterOf = t.id;
    pickPlayer(t.from.name, { mine: t.get.items.map((i) => i.uid), theirs: t.give.items.map((i) => i.uid), myMoney: t.get.money, theirMoney: t.give.money });
  }));
}
