// The Store (the top bar's name for it; the page is still 'market'): limited stock that restocks every 10 minutes (rules in
// engine/market.js). Players' own listings are the Market: pages/p2pmarket.js. Cheap items are almost always
// listed; rare and expensive ones only now and then, one copy at a time. Online, everyone shares the same stock.
import { esc, money, imgUrl, debounce } from '../util.js';
import { D, rarityColor } from '../data.js';
import * as I from '../items.js';
import { S, on } from '../state.js';
import { sfx } from '../audio.js';
import { toast, openModal, openInspect, tryAct, patternTag } from '../ui.js';
import { online } from '../backend.js';
import { net } from '../net/online.js';
import { marketWindow, windowEnd, skinListings, charmListings, unitsLeft, localSold, lowestPrice } from '../engine/market.js';

const PAGE = 60;
const view = { tab: 'skins', q: '', sort: 'pricey', page: 0, fx: 'all', cat: 'all', pat: 'all', stock: true };
let root, offs = [], timer = null, shownWindow = -1, chooserRedraw = null;
const FX = ['all', 'Paper', 'Holo', 'Foil', 'Gold', 'Glitter', 'Lenticular', 'Embroidered'];
const CATS = [['all', 'All'], ['rifle', 'Rifles'], ['pistol', 'Pistols'], ['smg', 'SMGs'], ['heavy', 'Heavy'], ['knife', 'Knives'], ['gloves', 'Gloves']];
// Which charm patterns to show, by the game's own rule for them (charmPattern, engine/items.js).
const PATS = [['all', 'All patterns'], ['rare', 'Any rare pattern'], ['top', 'Top 10 (#1 to #10)'], ['low', 'Low (#11 to #1,000)'], ['special', 'Special numbers']];
const patIn = {
  all: () => true,
  rare: (p) => !!p.label,
  top: (p) => !!p.tier,
  low: (p) => p.label === 'Low pattern',
  special: (p) => p.label === 'Special pattern',
};
const PAT_SORTS = [['rarest', 'Pattern: rarest first'], ['patlow', 'Pattern: low → high'], ['pathigh', 'Pattern: high → low']];

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
  if (w !== shownWindow) { draw(); chooserRedraw?.(); toast('The Store has restocked.', 'gold'); return; }
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
  if (view.tab === 'charms') return charmRows(w, sold);
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

// Charms: a card per listing, each showing its own pattern's colours and number, and a card for each charm with none left
// (when asked for). Searching takes a name or a pattern number (with or without its #).
function charmRows(w, sold) {
  const q = view.q, num = /^#?\d[\d,]*$/.test(q) ? q.replace(/\D/g, '') : '';
  const out = [];
  for (const c of Object.values(D.charms)) {
    const named = !q || c.n.toLowerCase().includes(q);
    const base = { id: c.id, n: c.n.replace('Charm | ', ''), top: D.charmColById[c.col]?.n.replace(' Charm Collection', '') || 'Charm', img: c.img, rc: rarityColor(c.r) };
    const live = charmListings(c, w).filter((l) => !sold.has(l.lid));
    for (const l of live) {
      const info = I.patternInfo(l.item);
      if (patIn[view.pat](info) && (named || (num && String(l.item.pat).includes(num)))) out.push({ ...base, p: l.p, left: 1, ln: l.n, item: l.item, pat: l.item.pat, info });
    }
    if (!live.length && named && view.pat === 'all') out.push({ ...base, p: c.p, left: 0 });
  }
  return out;
}

function draw() {
  if (!root) return;
  const w = marketWindow(now());
  shownWindow = w;
  const sold = soldFor(w);
  let list = rows(w, sold);
  const inStock = list.filter((r) => r.left > 0).length;
  if (view.stock) list = list.filter((r) => r.left > 0);
  const sorts = {
    pricey: (a, b) => b.p - a.p, cheap: (a, b) => a.p - b.p, name: (a, b) => a.n.localeCompare(b.n),
    rarest: (a, b) => (b.info?.mult || 0) - (a.info?.mult || 0) || (a.pat || 0) - (b.pat || 0),
    patlow: (a, b) => (a.pat || 0) - (b.pat || 0), pathigh: (a, b) => (b.pat || 0) - (a.pat || 0),
  };
  list.sort((a, b) => (b.left > 0) - (a.left > 0) || sorts[view.sort](a, b));
  const charms = view.tab === 'charms';
  const rare = charms ? charmListed(w, sold) : 0;
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  view.page = Math.min(view.page, pages - 1);
  const shown = list.slice(view.page * PAGE, view.page * PAGE + PAGE);
  root.innerHTML = `<div class="page">
    <div class="page-head"><h1>Store</h1><span class="sub">The game's own limited stock${online() ? ', shared with everyone on the server' : ''}. Rare items are listed rarely and one at a time. Each listing can only be bought once.</span>
      <span class="spacer"></span><span class="chip gold">Restocks in <b data-restock style="margin-left:4px">${fmt(windowEnd(w) - now())}</b></span></div>
    <div class="toolbar">
      <div class="seg" data-tabs>${[['skins', 'Skins'], ['stickers', 'Stickers'], ['charms', 'Charms'], ['agents', 'Agents']].map(([k, n]) => `<button data-v="${k}" class="${view.tab === k ? 'active' : ''}">${n}</button>`).join('')}</div>
      <input class="input" type="search" placeholder="${charms ? 'Search charms or a pattern #…' : `Search ${view.tab}…`}" value="${esc(view.q)}">
      ${view.tab === 'stickers' ? `<select class="input" data-fx>${FX.map((f) => `<option value="${f}" ${view.fx === f ? 'selected' : ''}>${f === 'all' ? 'All finishes' : f}</option>`).join('')}</select>` : ''}
      ${view.tab === 'skins' ? `<select class="input" data-cat>${CATS.map(([k, n]) => `<option value="${k}" ${view.cat === k ? 'selected' : ''}>${n}</option>`).join('')}</select>` : ''}
      ${charms ? `<select class="input" data-pat>${PATS.map(([k, n]) => `<option value="${k}" ${view.pat === k ? 'selected' : ''}>${n}</option>`).join('')}</select>` : ''}
      <select class="input" data-sort>${[['pricey', 'Price: high → low'], ['cheap', 'Price: low → high'], ['name', 'Name'], ...(charms ? PAT_SORTS : [])].map(([k, n]) => `<option value="${k}" ${view.sort === k ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <label class="check"><input type="checkbox" data-stock ${view.stock ? 'checked' : ''}> For sale now only</label>
      <span class="spacer"></span>${rare ? `<button class="chip gold rare-chip" data-rare title="Show only the rare patterns listed now">${rare} rare pattern${rare === 1 ? '' : 's'} listed</button>` : ''}<span class="muted">${inStock.toLocaleString()} for sale now</span>
    </div>
    ${shown.length ? `<div class="grid">${shown.map((r) => `<div class="card ${r.left ? '' : 'out'} ${r.info?.label ? 'rare-pat' : ''}" data-id="${r.id}" ${r.item ? `data-ln="${r.ln}"` : ''} style="--rc:${r.rc}">
      ${r.info?.label ? `<div class="tags">${patternTag(r.info)}</div>` : ''}
      <div class="img"><img loading="lazy" src="${r.item ? I.itemImage(r.item, 'm') : imgUrl(r.img, 'm')}"></div><div class="rbar"></div>
      <div class="meta"><div class="n1" title="${esc(r.top)}">${esc(r.top)}</div><div class="n2" title="${esc(r.n)}">${esc(r.n)}</div>
      <div class="row"><span class="val">${r.left && r.skin ? '<span class="dim" style="font-weight:400">from</span> ' : ''}${money(r.p)}</span>
      ${r.left ? `<button class="btn sm primary" data-buy="${r.id}" ${r.item ? `data-ln="${r.ln}"` : ''} data-p="${r.p}">${r.skin ? 'View' : 'Buy'}</button>` : '<span class="dim" style="font-size:11px">Not for sale</span>'}</div>
      <div class="row">${r.item ? `<span class="pat-no" title="This listing's pattern">Pattern <b>#${r.pat.toLocaleString('en-US')}</b></span>` : `<span class="stock ${r.left ? (r.left === 1 ? 'last' : '') : 'none'}">${r.left ? `${r.left} for sale` : 'Out of stock'}</span>`}</div></div></div>`).join('')}</div>`
      : `<div class="empty">${charms && view.pat !== 'all' ? 'No charm with a pattern like that is listed right now. Rare patterns turn up now and then: check back after the restock.' : view.stock ? 'Nothing matching is for sale right now. Untick “For sale now only” to browse everything, or check back after the restock.' : 'No items match.'}</div>`}
    ${pages > 1 ? `<div class="pager"><button class="btn sm" data-pg="-1" ${view.page ? '' : 'disabled'}>‹ Prev</button><span>Page ${view.page + 1} / ${pages}</span><button class="btn sm" data-pg="1" ${view.page < pages - 1 ? '' : 'disabled'}>Next ›</button></div>` : ''}
  </div>`;
  root.querySelectorAll('[data-tabs] button').forEach((b) => b.addEventListener('click', () => {
    view.tab = b.dataset.v; view.page = 0; view.q = ''; view.pat = 'all';
    if (PAT_SORTS.some(([k]) => k === view.sort)) view.sort = 'pricey'; // pattern orders are the charms'
    draw();
  }));
  const q = root.querySelector('input[type=search]');
  q.addEventListener('input', debounce(() => { view.q = q.value.toLowerCase(); view.page = 0; draw(); const n = root.querySelector('input[type=search]'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }, 220));
  root.querySelector('[data-fx]')?.addEventListener('change', (e) => { view.fx = e.target.value; view.page = 0; draw(); });
  root.querySelector('[data-cat]')?.addEventListener('change', (e) => { view.cat = e.target.value; view.page = 0; draw(); });
  root.querySelector('[data-pat]')?.addEventListener('change', (e) => { view.pat = e.target.value; view.page = 0; draw(); });
  root.querySelector('[data-rare]')?.addEventListener('click', () => { view.pat = view.pat === 'rare' ? 'all' : 'rare'; view.sort = 'rarest'; view.page = 0; draw(); });
  root.querySelector('[data-sort]').addEventListener('change', (e) => { view.sort = e.target.value; draw(); });
  root.querySelector('[data-stock]').addEventListener('change', (e) => { view.stock = e.target.checked; view.page = 0; draw(); });
  root.querySelectorAll('[data-pg]').forEach((b) => b.addEventListener('click', () => { view.page += +b.dataset.pg; draw(); root.scrollTop = 0; }));
  root.querySelectorAll('[data-buy]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); buy(b.dataset.buy, b.dataset.ln); }));
  root.querySelectorAll('.card[data-id]').forEach((c) => c.addEventListener('click', () => preview(c.dataset.id, c.dataset.ln)));
  updateAfford();
}

function updateAfford() {
  root?.querySelectorAll('[data-buy]').forEach((b) => (b.disabled = S.money < +b.dataset.p));
}

// How many rare patterns are listed now, whatever's being searched for or shown.
function charmListed(w, sold) {
  let n = 0;
  for (const c of Object.values(D.charms)) for (const l of charmListings(c, w)) if (!sold.has(l.lid) && I.patternInfo(l.item).label) n++;
  return n;
}

function preview(id, ln) {
  if (view.tab === 'stickers') openInspect(I.makeStickerItem(D.stickers[id]));
  else if (view.tab === 'charms') openInspect(ln == null ? I.makeCharmItem(D.charms[id]) : charmListings(D.charms[id], marketWindow(now()))[+ln].item);
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

function buy(id, ln) {
  if (view.tab === 'stickers') return purchase({ kind: 'sticker', id }, D.stickers[id].n);
  if (view.tab === 'charms') {
    const l = charmListings(D.charms[id], marketWindow(now()))[+ln];
    return purchase({ kind: 'charm', id, n: l.n }, `${D.charms[id].n} #${l.item.pat.toLocaleString('en-US')}`);
  }
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
