import { esc, money, debounce } from '../util.js';
import * as I from '../items.js';
import { S, on } from '../state.js';
import { act } from '../backend.js';
import { itemCard, showItemDetail, sellItems, openModal, toast } from '../ui.js';
import { D, rarityColor } from '../data.js';
import { SELL_RANKS } from '../autosell.js';
import { MAIN_SLOTS, GUN_GROUPS, ZEUS_SLOT, equipped, equippedUids, slotName } from '../loadout.js';
import { cs2Play } from '../cs2/api.js';
import { iconFor } from '../play/icons.js';

const view = { type: 'all', sort: 'new', q: '', select: false, selected: new Set(), limit: 150 };
const TYPES = [['all', 'All'], ['gun', 'Guns'], ['knife', 'Knives'], ['gloves', 'Gloves'], ['souvenir', 'Souvenirs'], ['sticker', 'Stickers'], ['agent', 'Agents'], ['pro', 'Players'], ['chicken', 'Chickens']];
let root, off;

function matches(item) {
  const d = I.itemDef(item);
  if (!d) return false;
  if (view.type !== 'all') {
    if (view.type === 'gun' && !(item.t === 'skin' && !['knife', 'gloves'].includes(d.cat))) return false;
    if (view.type === 'knife' && !(item.t === 'skin' && d.cat === 'knife')) return false;
    if (view.type === 'gloves' && !(item.t === 'skin' && d.cat === 'gloves')) return false;
    if (['sticker', 'agent', 'chicken', 'pro'].includes(view.type) && item.t !== view.type) return false;
    if (view.type === 'souvenir' && !item.sv) return false;
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
  const seen = S.inv.filter((it) => it.nw).map((it) => it.uid);
  if (seen.length) act('item.seen', { uids: seen }).catch(() => {});
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
        : `<button class="btn" data-a="loadout">Loadout</button><button class="btn" data-a="bulk">Bulk sell…</button><button class="btn" data-a="select">Select</button>`}
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
  if (a === 'loadout') loadoutModal();
}

// Loadout, laid out like CS2's: a box for every slot (knife, gloves, Zeus, agents and every gun), with the gun's
// silhouette in the empty ones. Click a box to pick from the skins you own for it.
function loadoutModal() {
  const m = openModal({ title: 'Loadout', cls: 'wide', body: '<div data-lo></div>' });
  const box = m.el.querySelector('[data-lo]');
  const fits = (slot) => S.inv.filter((i) => I.loadoutSlot(i) === slot).sort((a, b) => I.itemValue(b) - I.itemValue(a));
  const wids = {};
  for (const s of Object.values(D.skins)) if (s.wid?.startsWith('weapon_') && !wids[s.w]) wids[s.w] = s.wid;
  let icons = null;
  const drawSlots = () => {
    const owned = {};
    for (const i of S.inv) { const k = I.loadoutSlot(i); if (k) owned[k] = (owned[k] || 0) + 1; }
    const slot = (k, side = '') => {
      const it = equipped(k);
      const n = owned[k] || 0;
      const name = slotName(k);
      const icon = iconFor(icons, k === 'knife' ? 'knife' : k.startsWith('w:') ? wids[name] : null);
      return `<div class="lo-slot ${n ? '' : 'none'}" data-slot="${esc(k)}"><div class="lo-name">${esc(name)}${side ? `<span class="lo-side ${side.toLowerCase()}">${side}</span>` : ''}</div>
        ${it ? itemCard(it) : `<div class="lo-empty">${icon ? `<img src="${esc(icon)}" alt="">` : ''}<span>${n ? `Choose… (${n})` : 'None owned'}</span></div>`}</div>`;
    };
    const total = MAIN_SLOTS.length + 1 + GUN_GROUPS.reduce((s, [, g]) => s + g.length, 0);
    const on = [...MAIN_SLOTS.map(([k]) => k), ZEUS_SLOT, ...GUN_GROUPS.flatMap(([, g]) => g.map((x) => x.slot))].filter((k) => equipped(k)).length;
    box.innerHTML = `<p class="muted" style="margin-top:0">${on} of ${total} slots equipped. Equipped gloves are worn on your hands in
        the first-person inspect and in Play, and your knife, agents and gun skins are what you use there.</p>
      <div class="lo-grid">${[...MAIN_SLOTS.map(([k]) => slot(k)), slot(ZEUS_SLOT)].join('')}</div>
      ${GUN_GROUPS.map(([name, guns]) => `<h3 class="lo-head">${name}</h3><div class="lo-grid guns">${guns.map((g) => slot(g.slot, g.side)).join('')}</div>`).join('')}`;
    box.querySelectorAll('[data-slot]').forEach((el) => el.addEventListener('click', () => choose(el.dataset.slot)));
  };
  // CS2's weapon silhouettes for the empty boxes (when CS2 is installed).
  cs2Play('icons').then((i) => { icons = i; if (box.isConnected && !box.querySelector('[data-back]')) drawSlots(); }).catch(() => {});
  const choose = (k) => {
    const list = fits(k);
    const cur = equipped(k);
    if (!list.length) { toast(`You don't own anything for the ${esc(slotName(k))} slot yet.`); return; }
    box.innerHTML = `<div class="toolbar" style="margin-top:0"><button class="btn ghost" data-back>← Back</button>
        <b>${esc(slotName(k))}</b><span class="spacer"></span>${cur ? '<button class="btn" data-off>Unequip</button>' : ''}</div>
      <div class="grid">${list.slice(0, 200).map((i) => itemCard(i)).join('')}</div>`;
    box.querySelector('[data-back]').addEventListener('click', drawSlots);
    box.querySelector('[data-off]')?.addEventListener('click', async () => {
      try { await act('loadout.unequip', { uid: cur.uid }); } catch (e) { toast(esc(e.message), 'bad'); }
      drawSlots();
    });
    box.querySelectorAll('.card[data-uid]').forEach((c) => c.addEventListener('click', async () => {
      try { await act('loadout.equip', { uid: c.dataset.uid }); } catch (e) { toast(esc(e.message), 'bad'); }
      drawSlots();
    }));
  };
  drawSlots();
}

function bulkSell() {
  const m = openModal({
    title: 'Bulk sell',
    body: `<p class="muted" style="margin-top:0">Sell every unlocked item that is worth less than an amount <b>or</b> has one of the ticked rarities.
      Locked items, knives, gloves and other ★ items are never sold here, and neither are players in your team or anything in your loadout.</p>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
        <label class="check">Worth less than $ <input class="input" type="number" min="0" step="0.5" value="1" style="width:110px" data-th></label>
        <select class="input" data-ty>${TYPES.map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select>
      </div>
      <div style="display:grid;grid-template-columns:repeat(2, 1fr);gap:6px">${SELL_RANKS.map(([k, n]) => `<label class="check" style="color:var(--text)"><input type="checkbox" data-rank="${k}">
        <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${rarityColor(k)}"></span>${esc(n)}</label>`).join('')}</div>
      <p data-preview style="margin-bottom:0"></p>`,
    foot: `<button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-go>Sell</button>`,
  });
  const th = m.el.querySelector('[data-th]'), ty = m.el.querySelector('[data-ty]'), pv = m.el.querySelector('[data-preview]');
  const teamUids = new Set([...Object.values(S.team?.slots || {}), ...(S.team?.bench || [])].filter(Boolean));
  for (const u of equippedUids()) teamUids.add(u);
  const matchesType = (i) => { const prevT = view.type, prevQ = view.q; view.type = ty.value; view.q = ''; const r = matches(i); view.type = prevT; view.q = prevQ; return r; };
  const pick = () => {
    const below = +th.value || 0;
    const ranks = new Set([...m.el.querySelectorAll('[data-rank]:checked')].map((x) => +x.dataset.rank));
    return S.inv.filter((i) => !i.lk && !teamUids.has(i.uid) && I.rarityRank(i) < 6 && matchesType(i)
      && ((below > 0 && I.itemValue(i) < below) || (i.t !== 'pro' && ranks.has(I.rarityRank(i)))));
  };
  const upd = () => { const l = pick(); pv.innerHTML = `${l.length} items · <b class="green">${money(l.reduce((s, i) => s + I.itemValue(i), 0))}</b>`; };
  th.addEventListener('input', upd); ty.addEventListener('change', upd);
  m.el.querySelectorAll('[data-rank]').forEach((x) => x.addEventListener('change', upd));
  upd();
  m.el.querySelector('[data-go]').addEventListener('click', async () => {
    const l = pick();
    if (!l.length) return toast('Nothing to sell.', 'bad');
    m.close();
    await sellItems(l);
  });
}
