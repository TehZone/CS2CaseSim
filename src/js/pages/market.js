// Market: limited stock that restocks every 10 minutes (rules in engine/market.js). Cheap items are almost always
// listed; rare and expensive ones only now and then, one copy at a time. Online, everyone shares the same stock.
import { esc, money, imgUrl, debounce } from '../util.js';
import { D, rarityColor } from '../data.js';
import * as I from '../items.js';
import { S, on } from '../state.js';
import { sfx } from '../audio.js';
import { toast, openModal, openInspect, tryAct } from '../ui.js';
import { online } from '../backend.js';
import { net } from '../net/online.js';
import { marketWindow, windowEnd, skinListings, unitsLeft, localSold, lowestPrice } from '../engine/market.js';

const PAGE = 60;
const view = { tab: 'skins', q: '', sort: 'pricey', page: 0, fx: 'all', cat: 'all', stock: true };
let root, offs = [], timer = null, shownWindow = -1, chooserRedraw = null;
const FX = ['all', 'Paper', 'Holo', 'Foil', 'Gold', 'Glitter', 'Lenticular', 'Embroidered'];
const CATS = [['all', 'All'], ['rifle', 'Rifles'], ['pistol', 'Pistols'], ['smg', 'SMGs'], ['heavy', 'Heavy'], ['knife', 'Knives'], ['gloves', 'Gloves']];

// Online the server's clock and the shared sold list count; offline, this PC's clock and the save.
const now = () => (online() ? net.serverNow() : Date.now());
const soldFor = (w) => (online() ? net.marketSold(w) : localSold(S, w));
const fmt = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export function render(r) {
  root = r;
  offs.forEach((o) => o());
  offs = [
    on('money', debounce(() => root && updateAfford(), 100)),
    on('state', (d) => { if (d?.set && 'market' in d.set) { draw(); chooserRedraw?.(); } }),
    net.on('market', () => { draw(); chooserRedraw?.(); }),
  ];
  draw();
  clearInterval(timer);
  timer = setInterval(tick, 1000);
}
export function destroy() { offs.forEach((o) => o()); offs = []; clearInterval(timer); root = null; }

function tick() {
  if (!root) return;
  const w = marketWindow(now());
  if (w !== shownWindow) { draw(); chooserRedraw?.(); toast('The market has restocked.', 'gold'); return; }
  const el = root.querySelector('[data-restock]');
  if (el) el.textContent = fmt(windowEnd(w) - now());
}

function rows(w, sold) {
  const q = view.q;
  if (view.tab === 'stickers') {
    let list = Object.values(D.stickers).filter((s) => !s.so);
    if (view.fx !== 'all') list = list.filter((s) => (view.fx === 'Paper' ? !s.fx : s.fx === view.fx));
    if (q) list = list.filter((s) => s.n.toLowerCase().includes(q));
    return list.map((s) => ({ id: s.id, n: s.n.replace('Sticker | ', ''), top: s.t || 'Sticker', img: s.img, p: s.p, rc: rarityColor(s.r), left: unitsLeft('sticker', s, w, sold) }));
  }
  if (view.tab === 'agents') {
    let list = Object.values(D.agents);
    if (q) list = list.filter((a) => a.n.toLowerCase().includes(q));
    return list.map((a) => ({ id: a.id, n: a.n.split(' | ')[0], top: a.n.split(' | ')[1] || 'Agent', img: a.img, p: a.p, rc: rarityColor(a.r), left: unitsLeft('agent', a, w, sold) }));
  }
  let list = Object.values(D.skins);
  if (view.cat !== 'all') list = list.filter((s) => s.cat === view.cat);
  if (q) list = list.filter((s) => (s.n + ' ' + (s.ph || '')).toLowerCase().includes(q));
  return list.map((s) => {
    const live = skinListings(s, w).filter((l) => !sold.has(l.lid));
    return {
      id: s.id, n: (s.n.split(' | ')[1] || 'Vanilla') + (s.ph ? ` (${s.ph})` : ''), top: s.n.split(' | ')[0], img: s.img,
      p: live.length ? Math.min(...live.map((l) => l.p)) : lowestPrice(s), rc: rarityColor(s.star ? 6 : s.r), left: live.length, skin: true,
    };
  });
}

function draw() {
  if (!root) return;
  const w = marketWindow(now());
  shownWindow = w;
  const sold = soldFor(w);
  let list = rows(w, sold);
  const inStock = list.filter((r) => r.left > 0).length;
  if (view.stock) list = list.filter((r) => r.left > 0);
  const sorts = { pricey: (a, b) => b.p - a.p, cheap: (a, b) => a.p - b.p, name: (a, b) => a.n.localeCompare(b.n) };
  list.sort((a, b) => (b.left > 0) - (a.left > 0) || sorts[view.sort](a, b));
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  view.page = Math.min(view.page, pages - 1);
  const shown = list.slice(view.page * PAGE, view.page * PAGE + PAGE);
  root.innerHTML = `<div class="page">
    <div class="page-head"><h1>Market</h1><span class="sub">Limited stock${online() ? ', shared with everyone on the server' : ''}. Rare items are listed rarely and one at a time. Each listing can only be bought once.</span>
      <span class="spacer"></span><span class="chip gold">Restocks in <b data-restock style="margin-left:4px">${fmt(windowEnd(w) - now())}</b></span></div>
    <div class="toolbar">
      <div class="seg" data-tabs>${[['skins', 'Skins'], ['stickers', 'Stickers'], ['agents', 'Agents']].map(([k, n]) => `<button data-v="${k}" class="${view.tab === k ? 'active' : ''}">${n}</button>`).join('')}</div>
      <input class="input" type="search" placeholder="Search ${view.tab}…" value="${esc(view.q)}">
      ${view.tab === 'stickers' ? `<select class="input" data-fx>${FX.map((f) => `<option value="${f}" ${view.fx === f ? 'selected' : ''}>${f === 'all' ? 'All finishes' : f}</option>`).join('')}</select>` : ''}
      ${view.tab === 'skins' ? `<select class="input" data-cat>${CATS.map(([k, n]) => `<option value="${k}" ${view.cat === k ? 'selected' : ''}>${n}</option>`).join('')}</select>` : ''}
      <select class="input" data-sort>${[['pricey', 'Price: high → low'], ['cheap', 'Price: low → high'], ['name', 'Name']].map(([k, n]) => `<option value="${k}" ${view.sort === k ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <label class="check"><input type="checkbox" data-stock ${view.stock ? 'checked' : ''}> For sale now only</label>
      <span class="spacer"></span><span class="muted">${inStock.toLocaleString()} for sale now</span>
    </div>
    ${shown.length ? `<div class="grid">${shown.map((r) => `<div class="card ${r.left ? '' : 'out'}" data-id="${r.id}" style="--rc:${r.rc}">
      <div class="img"><img loading="lazy" src="${imgUrl(r.img, 'm')}"></div><div class="rbar"></div>
      <div class="meta"><div class="n1" title="${esc(r.top)}">${esc(r.top)}</div><div class="n2" title="${esc(r.n)}">${esc(r.n)}</div>
      <div class="row"><span class="val">${r.left && r.skin ? '<span class="dim" style="font-weight:400">from</span> ' : ''}${money(r.p)}</span>
      ${r.left ? `<button class="btn sm primary" data-buy="${r.id}" data-p="${r.p}">${r.skin ? 'View' : 'Buy'}</button>` : '<span class="dim" style="font-size:11px">Not for sale</span>'}</div>
      <div class="row"><span class="stock ${r.left ? (r.left === 1 ? 'last' : '') : 'none'}">${r.left ? `${r.left} for sale` : 'Out of stock'}</span></div></div></div>`).join('')}</div>`
      : `<div class="empty">${view.stock ? 'Nothing matching is for sale right now. Untick “For sale now only” to browse everything, or check back after the restock.' : 'No items match.'}</div>`}
    ${pages > 1 ? `<div class="pager"><button class="btn sm" data-pg="-1" ${view.page ? '' : 'disabled'}>‹ Prev</button><span>Page ${view.page + 1} / ${pages}</span><button class="btn sm" data-pg="1" ${view.page < pages - 1 ? '' : 'disabled'}>Next ›</button></div>` : ''}
  </div>`;
  root.querySelectorAll('[data-tabs] button').forEach((b) => b.addEventListener('click', () => { view.tab = b.dataset.v; view.page = 0; view.q = ''; draw(); }));
  const q = root.querySelector('input[type=search]');
  q.addEventListener('input', debounce(() => { view.q = q.value.toLowerCase(); view.page = 0; draw(); const n = root.querySelector('input[type=search]'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }, 220));
  root.querySelector('[data-fx]')?.addEventListener('change', (e) => { view.fx = e.target.value; view.page = 0; draw(); });
  root.querySelector('[data-cat]')?.addEventListener('change', (e) => { view.cat = e.target.value; view.page = 0; draw(); });
  root.querySelector('[data-sort]').addEventListener('change', (e) => { view.sort = e.target.value; draw(); });
  root.querySelector('[data-stock]').addEventListener('change', (e) => { view.stock = e.target.checked; view.page = 0; draw(); });
  root.querySelectorAll('[data-pg]').forEach((b) => b.addEventListener('click', () => { view.page += +b.dataset.pg; draw(); root.scrollTop = 0; }));
  root.querySelectorAll('[data-buy]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); buy(b.dataset.buy); }));
  root.querySelectorAll('.card[data-id]').forEach((c) => c.addEventListener('click', () => preview(c.dataset.id)));
  updateAfford();
}

function updateAfford() {
  root?.querySelectorAll('[data-buy]').forEach((b) => (b.disabled = S.money < +b.dataset.p));
}

function preview(id) {
  if (view.tab === 'stickers') openInspect(I.makeStickerItem(D.stickers[id]));
  else if (view.tab === 'agents') openInspect(I.makeAgentItem(D.agents[id]));
  else chooser(D.skins[id]);
}

async function purchase(args, label) {
  const r = await tryAct('market.buy', { window: marketWindow(now()), ...args });
  if (!r) return false;
  sfx.buy();
  toast(`Bought <b>${esc(label)}</b> for ${money(r.price)}`, 'good');
  if (!online()) draw();
  return true;
}

function buy(id) {
  if (view.tab === 'stickers') return purchase({ kind: 'sticker', id }, D.stickers[id].n);
  if (view.tab === 'agents') return purchase({ kind: 'agent', id }, D.agents[id].n);
  chooser(D.skins[id]);
}

// The listings of one skin this window: each a real item with its own float and pattern.
function chooser(skin) {
  const m = openModal({
    title: esc(skin.n) + (skin.ph ? ` (${esc(skin.ph)})` : ''),
    cls: 'wide',
    body: '',
    foot: `<span class="muted" style="margin-right:auto;font-size:12px">Each listing has its own float and pattern and can be bought once. Rare floats and patterns are listed only rarely.</span><button class="btn ghost" data-close>Close</button>`,
    onClose: () => { chooserRedraw = null; },
  });
  const body = m.el.querySelector('.modal-body');
  const draw = () => {
    const w = marketWindow(now());
    const sold = soldFor(w);
    const listings = skinListings(skin, w).filter((l) => !sold.has(l.lid)).sort((a, b) => a.p - b.p);
    body.innerHTML = `<div style="display:grid;grid-template-columns:260px 1fr;gap:20px;align-items:start">
      <img src="${imgUrl(skin.img, 'm')}" style="width:100%">
      <div style="display:flex;flex-direction:column;gap:6px">${listings.length ? listings.map((l) => {
        const pat = I.patternInfo(l.item);
        return `<div class="stk-row" style="font-size:13px">
          <span class="grow"><span style="${l.item.stt ? 'color:var(--st)' : ''}">${l.item.stt ? 'StatTrak™ ' : ''}${esc(I.wearName(l.item) || 'Vanilla')}</span>
          <span class="muted">${l.item.fl != null ? ' · ' + l.item.fl.toFixed(6) + ' · seed ' + l.item.sd : ''}</span>
          ${pat.label ? `<span class="tag pat ${pat.tier}" style="margin-left:6px">${esc(pat.label)}</span>` : ''}</span>
          <button class="btn sm" data-insp="${l.n}">Inspect</button>
          <button class="btn sm primary" data-n="${l.n}" ${S.money < l.p ? 'disabled' : ''}>${money(l.p)}</button></div>`;
      }).join('') : `<div class="empty" style="padding:30px">Not for sale right now. The market restocks in ${fmt(windowEnd(w) - now())}.</div>`}</div></div>`;
    const byN = (n) => skinListings(skin, w).find((l) => l.n === +n);
    body.querySelectorAll('[data-insp]').forEach((b) => b.addEventListener('click', () => openInspect(byN(b.dataset.insp).item)));
    body.querySelectorAll('[data-n]').forEach((b) => b.addEventListener('click', async () => {
      const l = byN(b.dataset.n);
      const label = I.itemName(l.item) + (l.item.fl != null ? ' (' + I.wearName(l.item) + ')' : '');
      if (await purchase({ kind: 'skin', id: skin.id, n: l.n, window: w }, label)) draw();
    }));
  };
  chooserRedraw = () => { if (m.el.isConnected) draw(); };
  draw();
}
