import { esc, money, imgUrl, debounce } from '../util.js';
import { D, WEARS, WEAR_BY_KEY, rarityColor, RARITY } from '../data.js';
import * as I from '../items.js';
import { S, trySpend, addItems, on } from '../state.js';
import { sfx } from '../audio.js';
import { toast, openModal, openInspect } from '../ui.js';

const PAGE = 60;
const view = { tab: 'stickers', q: '', sort: 'pricey', page: 0, fx: 'all', cat: 'all' };
let root, off;
const FX = ['all', 'Paper', 'Holo', 'Foil', 'Gold', 'Glitter', 'Lenticular', 'Embroidered'];
const CATS = [['all', 'All'], ['rifle', 'Rifles'], ['pistol', 'Pistols'], ['smg', 'SMGs'], ['heavy', 'Heavy'], ['knife', 'Knives'], ['gloves', 'Gloves']];

export function render(r) {
  root = r;
  off?.();
  off = on('money', debounce(() => root && updateAfford(), 100));
  draw();
}
export function destroy() { off?.(); off = null; root = null; }

function lowest(skin) {
  if (skin.v) return skin.p.V[0];
  return Math.min(...Object.values(skin.p).map((r) => r[0]));
}

function rows() {
  const q = view.q;
  if (view.tab === 'stickers') {
    let list = Object.values(D.stickers);
    if (view.fx !== 'all') list = list.filter((s) => (view.fx === 'Paper' ? !s.fx : s.fx === view.fx));
    if (q) list = list.filter((s) => s.n.toLowerCase().includes(q));
    return list.map((s) => ({ id: s.id, n: s.n.replace('Sticker | ', ''), top: s.t || 'Sticker', img: s.img, p: s.p, rc: rarityColor(s.r) }));
  }
  if (view.tab === 'agents') {
    let list = Object.values(D.agents);
    if (q) list = list.filter((a) => a.n.toLowerCase().includes(q));
    return list.map((a) => ({ id: a.id, n: a.n.split(' | ')[0], top: a.n.split(' | ')[1] || 'Agent', img: a.img, p: a.p, rc: rarityColor(a.r) }));
  }
  let list = Object.values(D.skins);
  if (view.cat !== 'all') list = list.filter((s) => s.cat === view.cat);
  if (q) list = list.filter((s) => (s.n + ' ' + (s.ph || '')).toLowerCase().includes(q));
  return list.map((s) => ({ id: s.id, n: (s.n.split(' | ')[1] || 'Vanilla') + (s.ph ? ` (${s.ph})` : ''), top: s.n.split(' | ')[0], img: s.img, p: lowest(s), rc: rarityColor(s.star ? 6 : s.r), from: true }));
}

function draw() {
  if (!root) return;
  const list = rows();
  const sorts = { pricey: (a, b) => b.p - a.p, cheap: (a, b) => a.p - b.p, name: (a, b) => a.n.localeCompare(b.n) };
  list.sort(sorts[view.sort]);
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  view.page = Math.min(view.page, pages - 1);
  const shown = list.slice(view.page * PAGE, view.page * PAGE + PAGE);
  root.innerHTML = `<div class="page">
    <div class="page-head"><h1>Market</h1><span class="sub">Buy at current marketplace prices${D.pricedAt ? ' · updated ' + new Date(D.pricedAt).toLocaleDateString() : ''}</span></div>
    <div class="toolbar">
      <div class="seg" data-tabs>${[['stickers', 'Stickers'], ['agents', 'Agents'], ['skins', 'Skins']].map(([k, n]) => `<button data-v="${k}" class="${view.tab === k ? 'active' : ''}">${n}</button>`).join('')}</div>
      <input class="input" type="search" placeholder="Search ${view.tab}…" value="${esc(view.q)}">
      ${view.tab === 'stickers' ? `<select class="input" data-fx>${FX.map((f) => `<option value="${f}" ${view.fx === f ? 'selected' : ''}>${f === 'all' ? 'All finishes' : f}</option>`).join('')}</select>` : ''}
      ${view.tab === 'skins' ? `<select class="input" data-cat>${CATS.map(([k, n]) => `<option value="${k}" ${view.cat === k ? 'selected' : ''}>${n}</option>`).join('')}</select>` : ''}
      <select class="input" data-sort>${[['pricey', 'Price: high → low'], ['cheap', 'Price: low → high'], ['name', 'Name']].map(([k, n]) => `<option value="${k}" ${view.sort === k ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <span class="spacer"></span><span class="muted">${list.length.toLocaleString()} listings</span>
    </div>
    ${shown.length ? `<div class="grid">${shown.map((r) => `<div class="card" data-id="${r.id}" style="--rc:${r.rc}">
      <div class="img"><img loading="lazy" src="${imgUrl(r.img, 'm')}"></div><div class="rbar"></div>
      <div class="meta"><div class="n1" title="${esc(r.top)}">${esc(r.top)}</div><div class="n2" title="${esc(r.n)}">${esc(r.n)}</div>
      <div class="row"><span class="val">${r.from ? '<span class="dim" style="font-weight:400">from</span> ' : ''}${money(r.p)}</span>
      <button class="btn sm primary" data-buy="${r.id}" data-p="${r.p}">${r.from ? 'Buy…' : 'Buy'}</button></div></div></div>`).join('')}</div>` : '<div class="empty">No listings match.</div>'}
    ${pages > 1 ? `<div class="pager"><button class="btn sm" data-pg="-1" ${view.page ? '' : 'disabled'}>‹ Prev</button><span>Page ${view.page + 1} / ${pages}</span><button class="btn sm" data-pg="1" ${view.page < pages - 1 ? '' : 'disabled'}>Next ›</button></div>` : ''}
  </div>`;
  root.querySelectorAll('[data-tabs] button').forEach((b) => b.addEventListener('click', () => { view.tab = b.dataset.v; view.page = 0; view.q = ''; draw(); }));
  const q = root.querySelector('input[type=search]');
  q.addEventListener('input', debounce(() => { view.q = q.value.toLowerCase(); view.page = 0; draw(); const n = root.querySelector('input[type=search]'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }, 220));
  root.querySelector('[data-fx]')?.addEventListener('change', (e) => { view.fx = e.target.value; view.page = 0; draw(); });
  root.querySelector('[data-cat]')?.addEventListener('change', (e) => { view.cat = e.target.value; view.page = 0; draw(); });
  root.querySelector('[data-sort]').addEventListener('change', (e) => { view.sort = e.target.value; draw(); });
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
  else openInspect(I.makeSkinItem(D.skins[id], { stt: false }));
}

function purchase(price, item, label) {
  if (!trySpend(price)) { sfx.error(); return toast(`Not enough money for ${esc(label)}.`, 'bad'); }
  item.nw = true;
  item.src = 'Market';
  addItems([item]);
  sfx.buy();
  toast(`Bought <b>${esc(label)}</b> for ${money(price)}`, 'good');
}

function buy(id) {
  if (view.tab === 'stickers') { const s = D.stickers[id]; return purchase(s.p, I.makeStickerItem(s), s.n); }
  if (view.tab === 'agents') { const a = D.agents[id]; return purchase(a.p, I.makeAgentItem(a), a.n); }
  chooser(D.skins[id]);
}

// Real listings: each one is a concrete item (float + pattern seed) priced at its full value.
function makeListings(skin) {
  const out = [];
  const variants = skin.v ? [[null, false], ...(skin.stt ? [[null, true]] : [])]
    : WEARS.filter((W) => skin.p[W.k]).flatMap((W) => [[W.k, false], ...(skin.stt && skin.cat !== 'gloves' ? [[W.k, true]] : [])]);
  for (const [wk, st] of variants) {
    for (let n = 0; n < 2; n++) {
      const item = I.makeSkinItem(skin, { stt: st, ...(wk ? { fl: I.rollFloatInWear(skin, wk) } : {}) });
      out.push({ item, p: I.itemValue(item) });
    }
  }
  return out.sort((a, b) => a.p - b.p);
}

function chooser(skin) {
  let listings = makeListings(skin);
  const m = openModal({
    title: esc(skin.n) + (skin.ph ? ` (${esc(skin.ph)})` : ''),
    cls: 'wide',
    body: '',
    foot: `<span class="muted" style="margin-right:auto;font-size:12px">Each listing has its own float and pattern; rare floats and patterns cost more.</span><button class="btn" data-refresh>New listings</button>`,
  });
  const body = m.el.querySelector('.modal-body');
  const draw = () => {
    body.innerHTML = `<div style="display:grid;grid-template-columns:260px 1fr;gap:20px;align-items:start">
      <img src="${imgUrl(skin.img, 'm')}" style="width:100%">
      <div style="display:flex;flex-direction:column;gap:6px">${listings.map((l, i) => {
        const pat = I.patternInfo(l.item);
        return `<div class="stk-row" style="font-size:13px">
          <span class="grow"><span style="${l.item.stt ? 'color:var(--st)' : ''}">${l.item.stt ? 'StatTrak™ ' : ''}${esc(I.wearName(l.item) || 'Vanilla')}</span>
          <span class="muted">${l.item.fl != null ? ' · ' + l.item.fl.toFixed(6) + ' · seed ' + l.item.sd : ''}</span>
          ${pat.label ? `<span class="tag pat ${pat.tier}" style="margin-left:6px">${esc(pat.label)}</span>` : ''}</span>
          <button class="btn sm" data-insp="${i}">Inspect</button>
          <button class="btn sm primary" data-i="${i}" ${S.money < l.p ? 'disabled' : ''}>${money(l.p)}</button></div>`;
      }).join('')}</div></div>`;
    body.querySelectorAll('[data-insp]').forEach((b) => b.addEventListener('click', () => openInspect(listings[+b.dataset.insp].item)));
    body.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => {
      const l = listings[+b.dataset.i];
      purchase(l.p, l.item, I.itemName(l.item) + (l.item.fl != null ? ' (' + I.wearName(l.item) + ')' : ''));
      listings.splice(+b.dataset.i, 1);
      draw();
    }));
  };
  m.el.querySelector('[data-refresh]').addEventListener('click', () => { listings = makeListings(skin); draw(); });
  draw();
}
