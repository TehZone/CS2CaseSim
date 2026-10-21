import { esc, money, debounce } from '../util.js';
import * as I from '../items.js';
import { S, on, save } from '../state.js';
import { itemCard, showItemDetail, sellItems, openModal, toast } from '../ui.js';

const view = { type: 'all', sort: 'new', q: '', select: false, selected: new Set(), limit: 150 };
const TYPES = [['all', 'All'], ['gun', 'Guns'], ['knife', 'Knives'], ['gloves', 'Gloves'], ['sticker', 'Stickers'], ['agent', 'Agents'], ['chicken', 'Chickens']];
let root, off;

function matches(item) {
  const d = I.itemDef(item);
  if (!d) return false;
  if (view.type !== 'all') {
    if (view.type === 'gun' && !(item.t === 'skin' && !['knife', 'gloves'].includes(d.cat))) return false;
    if (view.type === 'knife' && !(item.t === 'skin' && d.cat === 'knife')) return false;
    if (view.type === 'gloves' && !(item.t === 'skin' && d.cat === 'gloves')) return false;
    if (['sticker', 'agent', 'chicken'].includes(view.type) && item.t !== view.type) return false;
  }
  if (view.q && !I.itemName(item).toLowerCase().includes(view.q)) return false;
  return true;
}

const SORTS = {
  new: (a, b) => b.at - a.at,
  old: (a, b) => a.at - b.at,
  vdesc: (a, b) => I.itemValue(b) - I.itemValue(a),
  vasc: (a, b) => I.itemValue(a) - I.itemValue(b),
  rarity: (a, b) => I.rarityRank(b) - I.rarityRank(a) || I.itemValue(b) - I.itemValue(a),
  float: (a, b) => (a.fl ?? 2) - (b.fl ?? 2),
};

export function render(r) {
  root = r;
  off?.();
  off = on('inv', debounce(() => draw(), 120));
  draw();
}

export function destroy() {
  off?.();
  off = null;
  let changed = false;
  for (const it of S.inv) if (it.nw) { delete it.nw; changed = true; }
  if (changed) save();
  view.select = false;
  view.selected.clear();
  root = null;
}

function draw() {
  if (!root || !root.querySelector || root.dataset.page !== 'inventory') return;
  const items = S.inv.filter(matches).sort(SORTS[view.sort]);
  const totalValue = S.inv.reduce((s, i) => s + I.itemValue(i), 0);
  const shownValue = items.reduce((s, i) => s + I.itemValue(i), 0);
  const best = S.inv.reduce((b, i) => (!b || I.itemValue(i) > I.itemValue(b) ? i : b), null);
  for (const uid of [...view.selected]) if (!S.inv.some((i) => i.uid === uid)) view.selected.delete(uid);
  const selItems = S.inv.filter((i) => view.selected.has(i.uid));
  const selValue = selItems.reduce((s, i) => s + I.itemValue(i), 0);
  const scroll = root.scrollTop;

  root.innerHTML = `<div class="page">
    <div class="page-head"><h1>Inventory</h1></div>
    <div class="summary">
      <div>Items<b>${S.inv.length}</b></div>
      <div>Inventory value<b class="green">${money(totalValue)}</b></div>
      <div>Showing<b>${items.length} · ${money(shownValue)}</b></div>
      <div>Most valuable<b>${best ? esc(I.itemName(best)) + ' · ' + money(I.itemValue(best)) : '—'}</b></div>
    </div>
    <div class="toolbar">
      <div class="seg">${TYPES.map(([k, n]) => `<button data-type="${k}" class="${view.type === k ? 'active' : ''}">${n}</button>`).join('')}</div>
      <input class="input" type="search" placeholder="Search inventory…" value="${esc(view.q)}">
      <select class="input" data-sort>${[['new', 'Newest'], ['old', 'Oldest'], ['vdesc', 'Value: high → low'], ['vasc', 'Value: low → high'], ['rarity', 'Rarity'], ['float', 'Float: low → high']].map(([k, n]) => `<option value="${k}" ${view.sort === k ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <span class="spacer"></span>
      ${view.select
        ? `<button class="btn" data-a="all">Select all shown</button><button class="btn" data-a="none">Clear</button>
           <button class="btn primary" data-a="sellsel" ${selItems.length ? '' : 'disabled'}>Sell ${selItems.length} (${money(selValue)})</button>
           <button class="btn ghost" data-a="done">Done</button>`
        : `<button class="btn" data-a="bulk">Bulk sell…</button><button class="btn" data-a="select">Select</button>`}
    </div>
    ${items.length ? `<div class="grid">${items.slice(0, view.limit).map((i) => itemCard(i, { selectable: view.select, selected: view.selected.has(i.uid) })).join('')}</div>` : `<div class="empty">${S.inv.length ? 'Nothing matches your filters.' : 'Your inventory is empty. Open some cases!'}</div>`}
    ${items.length > view.limit ? `<div class="pager"><button class="btn" data-a="more">Show more (${items.length - view.limit} more)</button></div>` : ''}
  </div>`;
  root.scrollTop = scroll;

  root.querySelectorAll('[data-type]').forEach((b) => b.addEventListener('click', () => { view.type = b.dataset.type; view.limit = 150; draw(); }));
  root.querySelector('[data-sort]').addEventListener('change', (e) => { view.sort = e.target.value; draw(); });
  const q = root.querySelector('input[type=search]');
  q.addEventListener('input', debounce(() => { view.q = q.value.toLowerCase(); draw(); const nq = root.querySelector('input[type=search]'); nq.focus(); nq.setSelectionRange(nq.value.length, nq.value.length); }, 200));
  root.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => action(b.dataset.a, items)));
  root.querySelectorAll('.card[data-uid]').forEach((c) => c.addEventListener('click', () => {
    const it = S.inv.find((i) => i.uid === c.dataset.uid);
    if (!it) return;
    if (view.select) {
      if (view.selected.has(it.uid)) view.selected.delete(it.uid); else if (!it.lk) view.selected.add(it.uid);
      draw();
    } else showItemDetail(it, { onChange: () => draw() });
  }));
}

async function action(a, items) {
  if (a === 'select') { view.select = true; draw(); }
  if (a === 'done') { view.select = false; view.selected.clear(); draw(); }
  if (a === 'all') { items.filter((i) => !i.lk).forEach((i) => view.selected.add(i.uid)); draw(); }
  if (a === 'none') { view.selected.clear(); draw(); }
  if (a === 'more') { view.limit += 150; draw(); }
  if (a === 'sellsel') {
    const sel = S.inv.filter((i) => view.selected.has(i.uid));
    if (await sellItems(sel)) { view.selected.clear(); view.select = false; draw(); }
  }
  if (a === 'bulk') bulkSell();
}

function bulkSell() {
  const m = openModal({
    title: 'Bulk sell',
    body: `<p class="muted" style="margin-top:0">Sell every unlocked item worth less than a threshold. Locked items are never sold.</p>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <label>Below $ <input class="input" type="number" min="0" step="0.5" value="1" style="width:110px" data-th></label>
        <select class="input" data-ty>${TYPES.map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select>
      </div>
      <p data-preview style="margin-bottom:0"></p>`,
    foot: `<button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-go>Sell</button>`,
  });
  const th = m.el.querySelector('[data-th]'), ty = m.el.querySelector('[data-ty]'), pv = m.el.querySelector('[data-preview]');
  const pick = () => {
    const prev = view.type;
    view.type = ty.value;
    const list = S.inv.filter((i) => !i.lk && matchesType(i) && I.itemValue(i) < +th.value);
    view.type = prev;
    return list;
  };
  const matchesType = (i) => { const q = view.q; view.q = ''; const r = matches(i); view.q = q; return r; };
  const upd = () => { const l = pick(); pv.innerHTML = `${l.length} items · <b class="green">${money(l.reduce((s, i) => s + I.itemValue(i), 0))}</b>`; };
  th.addEventListener('input', upd); ty.addEventListener('change', upd); upd();
  m.el.querySelector('[data-go]').addEventListener('click', async () => {
    const l = pick();
    if (!l.length) return toast('Nothing to sell.', 'bad');
    m.close();
    await sellItems(l);
  });
}
