// The Market: what players have listed, bought at once (the Store, pages/market.js, is the game's own restocking stock).
// Laid out like Skinport's market: a search box and the category bar along the top, the filters down the left, and the listings
// as cards (price, discount against the reference price, the item, its float on a wear bar) or as a list. "All items" is every
// item in the game with how many are listed; an item's page has all its listings. Sell lists one of yours; My listings changes
// a price or takes one down. Online it's the server's (server/p2pmarket.mjs); offline the NPC traders list and buy
// (engine/p2p.js). The data side: src/js/p2pmarket.js.
import { esc, money, timeAgo, debounce } from '../util.js';
import { D, WEAR_BY_KEY } from '../data.js';
import * as I from '../items.js';
import { S, on } from '../state.js';
import { online } from '../backend.js';
import { net } from '../net/online.js';
import { sfx } from '../audio.js';
import { toast, openModal, confirmDialog, openInspect, itemCard, contextMenu } from '../ui.js';
import * as P from '../engine/p2p.js';
import { listedOf } from '../engine/storage.js';
import * as M from '../p2pmarket.js';

const MODE_KEY = 'cs2sim-market-view';
const ALL_WEARS = P.WEAR_KEYS;
const view = {
  tab: 'browse', // browse | catalog | item | sell | mine
  q: '', cat: '', sort: 'new', csort: 'listed', page: 0, mode: readMode(),
  f: { pmin: '', pmax: '', wears: [...ALL_WEARS], stt: false, sv: false, rare: false, ranks: [] },
  key: null, back: 'browse', isort: 'plow', ipage: 0, sellQ: '', sellSort: 'vdesc',
};
let root = null, offs = [], unwatch = null, seq = 0, fresh = 0, shown = new Map(), suggestFor = '';
const TYPE_WORD = { knife: 'Knife', gloves: 'Gloves', pistol: 'Pistol', rifle: 'Rifle', smg: 'SMG', heavy: 'Heavy', agent: 'Agent', charm: 'Charm', sticker: 'Sticker' };
const ITEM_SORTS = [['plow', 'Price: low to high'], ['phigh', 'Price: high to low'], ['flow', 'Float: low to high'], ['fhigh', 'Float: high to low'], ['new', 'Newest']];
const ICON = {
  search: '<svg viewBox="0 0 24 24" width="16" height="16"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M15.5 15.5L21 21" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
  cart: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M2 4h3l2.4 10.2a1 1 0 0 0 1 .8h9.4a1 1 0 0 0 1-.7L21 7H6.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="9.5" cy="19" r="1.6" fill="currentColor"/><circle cx="17" cy="19" r="1.6" fill="currentColor"/></svg>',
  grid: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M1 1h6v6H1zM9 1h6v6H9zM1 9h6v6H1zM9 9h6v6H9z" fill="currentColor"/></svg>',
  list: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M1 2h14v3H1zM1 6.5h14v3H1zM1 11h14v3H1z" fill="currentColor"/></svg>',
  clock: '<svg viewBox="0 0 16 16" width="12" height="12"><circle cx="8" cy="8" r="6.3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 4.5V8l2.4 1.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  dots: '<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="3" r="1.5" fill="currentColor"/><circle cx="8" cy="8" r="1.5" fill="currentColor"/><circle cx="8" cy="13" r="1.5" fill="currentColor"/></svg>',
};
function readMode() { try { return localStorage.getItem(MODE_KEY) === 'list' ? 'list' : 'grid'; } catch { return 'grid'; } }
function keepMode(m) { try { localStorage.setItem(MODE_KEY, m); } catch {} }

export function render(r) {
  root = r;
  offs.forEach((o) => o());
  offs = [
    // (Your listings changed: My listings and Sell drawn again, with what you were typing in them kept.)
    on('state', (d) => { if (d?.set && 'listed' in d.set) { countMine(); if (view.tab === 'mine' || view.tab === 'sell') keepingInput(() => drawMain()); } }),
    on('money', debounce(() => root && afford(), 100)),
    net.on('status', ({ status }) => { if (status === 'online' || status === 'offline') { watchAgain(); drawAll(); } }),
  ];
  watchAgain();
  drawAll();
  setTimeout(() => { try { P.warmCatalog(); } catch {} }, 300); // (every item in the game and its orders, made once: before the first search wants them)
}
// Draws something again with the boxes you were typing in as you left them: a new price in My listings (by its listing), the
// Sell tab's search, which one had the cursor and where.
function keepingInput(draw) {
  const main = root?.querySelector('[data-main]');
  if (!main) return draw();
  const id = (el) => (el.matches('[data-sellq]') ? 'sellq' : `p:${el.closest('[data-lid]')?.dataset.lid}`);
  const typed = new Map();
  let focus = null;
  main.querySelectorAll('input[data-newprice], input[data-sellq]').forEach((el) => {
    if (el.value !== el.defaultValue) typed.set(id(el), el.value);
    if (document.activeElement === el) focus = { id: id(el), a: el.selectionStart, b: el.selectionEnd };
  });
  draw();
  main.querySelectorAll('input[data-newprice], input[data-sellq]').forEach((el) => {
    const k = id(el);
    if (typed.has(k)) { el.value = typed.get(k); if (k !== 'sellq') el.dispatchEvent(new Event('input')); }
    if (focus?.id === k) { el.focus(); try { el.setSelectionRange(focus.a, focus.b); } catch {} }
  });
}
export function destroy() { offs.forEach((o) => o()); offs = []; unwatch?.(); unwatch = null; root = null; }

// ---- listening ------------------------------------------------------------------------------------------------------------
function watchAgain() {
  unwatch?.();
  unwatch = M.available() ? M.watch(changed) : null;
}
const redrawSoon = debounce(() => { if (root && ['browse', 'catalog', 'item'].includes(view.tab)) drawMain({ keep: true }); }, 400);
// All items' counts and lowest prices, asked for again after the listings change but at most every CATALOG_GAP (each change
// asking would have the server work every item in the game out again for every push).
const CATALOG_GAP = 5000;
let catalogAt = 0, catalogTimer = null;
function catalogSoon() {
  if (catalogTimer) return;
  catalogTimer = setTimeout(() => { catalogTimer = null; if (root && view.tab === 'catalog') drawMain({ keep: true }); }, Math.max(400, catalogAt + CATALOG_GAP - Date.now()));
}
// The listings' changes, pushed online and worked out offline: what's on screen is marked (gone) or repriced where it is, and
// new ones are counted ("N new listings · Show"), so nothing moves under the cursor. An item's page takes a new listing of it
// in a moment; All items its new counts now and then.
function changed(ch) {
  if (!root) return;
  if ('open' in ch) showClosed();
  for (const lid of ch.del || []) markGone(lid);
  for (const u of ch.upd || []) repriced(u);
  const adds = (ch.add || []).filter((l) => !shown.has(l.lid) && !M.isMine(l));
  if (adds.length && view.tab === 'browse') { fresh += adds.length; drawFresh(); }
  if (view.tab === 'item' && adds.some((l) => P.factsOf(l).key === view.key)) redrawSoon();
  if (view.tab === 'catalog' && (ch.add?.length || ch.del?.length || ch.upd?.length)) catalogSoon();
}
function markGone(lid) {
  if (!shown.has(lid)) return;
  shown.delete(lid);
  root.querySelectorAll(`[data-lid="${CSS.escape(lid)}"]`).forEach((el) => {
    el.classList.add('sold');
    el.querySelectorAll('[data-buy]').forEach((b) => { b.disabled = true; b.textContent = 'Gone'; b.title = 'Sold or taken down'; });
  });
}
// (A new copy of the listing, never the one a Buy window already showed: that buys at the price it said, or is refused.)
function repriced({ lid, price }) {
  const was = shown.get(lid);
  if (!was) return;
  const l = { ...was, price };
  shown.set(lid, l);
  root.querySelectorAll(`[data-lid="${CSS.escape(lid)}"]`).forEach((el) => {
    const f = P.factsOf(l);
    el.querySelector('[data-price]')?.replaceChildren(document.createTextNode(money(price)));
    const d = el.querySelector('[data-disc]');
    if (d) d.outerHTML = discHtml(f.disc);
    el.querySelectorAll('[data-buy]').forEach((b) => { b.dataset.p = price; });
  });
  afford();
}
// The admin panel's switches (online): with the Market closed a banner says so, and Buy, List and Save are off (cancelling
// still works).
function showClosed() {
  const shut = M.isClosed(), el = root?.querySelector('[data-closed]');
  if (el) el.hidden = !shut;
  root?.querySelectorAll('[data-save]').forEach((b) => { if (shut) b.disabled = true; else b.closest('[data-lid]')?.querySelector('[data-newprice]')?.dispatchEvent(new Event('input')); });
  afford();
}
function drawFresh() {
  const el = root?.querySelector('[data-fresh]');
  if (!el) return;
  el.hidden = !fresh;
  el.textContent = `${fresh.toLocaleString('en-US')} new listing${fresh === 1 ? '' : 's'} · Show`;
}

// ---- the page --------------------------------------------------------------------------------------------------------------
function drawAll() {
  if (!root) return;
  fresh = 0;
  const ok = M.available();
  root.innerHTML = `<div class="pm">
    <header class="pm-head">
      <div class="pm-brand"><h1>Market</h1><span>${online() ? 'Players\' listings' : 'Offline: the traders\' listings'} · ${P.MARKET_FEE ? `${Math.round(P.MARKET_FEE * 100)}% fee` : 'no fee'}</span></div>
      <label class="pm-search">${ICON.search}<input type="search" data-q placeholder="Search every item in the game" value="${esc(view.q)}" spellcheck="false" autocomplete="off"><div class="pm-suggest" data-suggest hidden></div></label>
      <nav class="pm-tabs">${[['browse', 'Market'], ['catalog', 'All items'], ['sell', 'Sell'], ['mine', 'My listings']].map(([k, n]) => `<button data-tab="${k}" class="${tabOf() === k ? 'on' : ''}">${n}${k === 'mine' ? ' <span class="pm-pill" data-minecount></span>' : ''}</button>`).join('')}</nav>
    </header>
    <div class="pm-cats">${[['', 'All'], ...P.CATS].map(([k, n]) => `<button data-cat="${k}" class="${view.cat === k ? 'on' : ''}">${n}</button>`).join('')}</div>
    <div class="pm-closed" data-closed ${M.isClosed() ? '' : 'hidden'}>The Market is closed on this server right now: buying, listing and new prices are off for the moment. You can still look around and take your own listings down.</div>
    <div class="pm-body ${['sell', 'mine', 'item'].includes(view.tab) ? 'noside' : ''}">
      <aside class="pm-side">${sideHtml()}</aside>
      <main class="pm-main" data-main>${ok ? '' : '<div class="pm-empty">This server has no Market yet. It comes with the server\'s next update.</div>'}</main>
    </div></div>`;
  wireHead();
  wireSide();
  root.querySelector('[data-main]').addEventListener('click', onMainClick);
  root.querySelector('[data-main]').addEventListener('contextmenu', onMainMenu);
  countMine();
  if (ok) drawMain();
}
const tabOf = () => (view.tab === 'item' ? view.back : view.tab);
function countMine() {
  const el = root?.querySelector('[data-minecount]');
  if (!el) return;
  const n = listedOf(S).length;
  el.textContent = n;
  el.hidden = !n;
}
function setTab(tab) {
  view.tab = tab;
  root.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tabOf()));
  root.querySelector('.pm-body').classList.toggle('noside', ['sell', 'mine', 'item'].includes(tab));
  drawMain();
}

function sideHtml() {
  const f = view.f, chk = (on) => (on ? 'checked' : '');
  return `<div class="pm-fgroup"><div class="pm-fh">Price</div>
      <div class="pm-range"><label>from<input class="input" data-pmin inputmode="decimal" placeholder="$0.00" value="${esc(f.pmin)}"></label>
      <label>to<input class="input" data-pmax inputmode="decimal" placeholder="∞" value="${esc(f.pmax)}"></label></div></div>
    <div class="pm-fgroup"><div class="pm-fh">Exterior</div>${ALL_WEARS.map((w) => `<label class="pm-chk"><input type="checkbox" data-wear="${w}" ${chk(f.wears.includes(w))}><span class="pm-wdot" style="--wc:${WEAR_BY_KEY[w].c}"></span>${WEAR_BY_KEY[w].n}</label>`).join('')}</div>
    <div class="pm-fgroup"><div class="pm-fh">Extras</div>
      <label class="pm-chk"><input type="checkbox" data-x="stt" ${chk(f.stt)}><span class="st">StatTrak™</span></label>
      <label class="pm-chk"><input type="checkbox" data-x="sv" ${chk(f.sv)}><span class="sv">Souvenir</span></label>
      <label class="pm-chk"><input type="checkbox" data-x="rare" ${chk(f.rare)}>Rare pattern only</label></div>
    <div class="pm-fgroup"><div class="pm-fh">Rarity</div>${P.RANKS.map(([r, n]) => `<label class="pm-chk"><input type="checkbox" data-rank="${r}" ${chk(f.ranks.includes(r))}><span class="pm-rdot" style="--rc:${rankColor(r)}"></span>${esc(n)}</label>`).join('')}</div>
    <button class="btn ghost sm pm-reset" data-reset>Reset filters</button>`;
}
const rankColor = (r) => ['#b0c3d9', '#5e98d9', '#4b69ff', '#8847ff', '#d32ce6', '#eb4b4b', '#e4ae39', '#e4ae39'][r];

// What the filters and the search ask for, as the requests take it.
function query(extra = {}) {
  const f = view.f, num = (v) => { const n = P.cleanPrice(v); return Number.isFinite(n) && n > 0 ? n : null; };
  return {
    text: view.q, cat: view.cat, sort: view.sort, page: view.page, pmin: num(f.pmin), pmax: num(f.pmax),
    wears: f.wears.length === ALL_WEARS.length ? [] : f.wears, stt: f.stt, sv: f.sv, rare: f.rare, ranks: f.ranks, ...extra,
  };
}

function wireHead() {
  root.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { view.page = 0; setTab(b.dataset.tab); }));
  root.querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => {
    view.cat = view.cat === b.dataset.cat ? '' : b.dataset.cat;
    root.querySelectorAll('[data-cat]').forEach((x) => x.classList.toggle('on', x.dataset.cat === view.cat));
    view.page = 0;
    if (!['browse', 'catalog'].includes(view.tab)) setTab(view.tab === 'item' ? view.back : 'browse'); else drawMain();
  }));
  const q = root.querySelector('[data-q]'), box = root.querySelector('[data-suggest]');
  const apply = debounce(() => {
    view.q = q.value.trim();
    view.page = 0;
    if (!['browse', 'catalog'].includes(view.tab)) { view.tab = view.tab === 'item' ? view.back : 'browse'; setTab(view.tab); } else drawMain();
    suggest(view.q);
  }, 250);
  q.addEventListener('input', apply);
  q.addEventListener('focus', () => { if (q.value.trim()) suggest(q.value.trim()); });
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { box.hidden = true; } if (e.key === 'Escape') { box.hidden = true; e.stopPropagation(); } });
  q.addEventListener('blur', () => setTimeout(() => { box.hidden = true; }, 150));
  box.addEventListener('mousedown', (e) => {
    const row = e.target.closest('[data-key]');
    if (!row) return;
    e.preventDefault();
    box.hidden = true;
    openItem(row.dataset.key);
  });
}
// The search box's dropdown: the items in the game it finds, whether anyone's selling them.
async function suggest(text) {
  const box = root?.querySelector('[data-suggest]');
  if (!box) return;
  suggestFor = text;
  if (!text) { box.hidden = true; return; }
  let r;
  try { r = await M.catalog({ text, sort: 'listed' }); } catch { return; }
  if (!root || suggestFor !== text || document.activeElement !== root.querySelector('[data-q]')) return;
  box.innerHTML = r.rows.slice(0, 8).map((x) => {
    const e = P.catalogEntry(x.key);
    if (!e) return '';
    const it = P.entryItem(e);
    return `<div class="pm-sug" data-key="${esc(x.key)}"><img src="${esc(I.itemImage(it, 's'))}" alt=""><span class="pm-sug-n">${esc(e.n)}</span>
      <span class="pm-sug-c ${x.n ? '' : 'none'}">${x.n ? `${x.n} listed · from <b>${money(x.min)}</b>` : 'No listings'}</span></div>`;
  }).join('') + (r.total > 8 ? `<div class="pm-sug-more">${r.total.toLocaleString('en-US')} items in the game match · see them all in All items</div>` : '') || '<div class="pm-sug-more">No item in the game matches that</div>';
  box.hidden = false;
  box.querySelector('.pm-sug-more')?.addEventListener('mousedown', (e) => { e.preventDefault(); box.hidden = true; view.page = 0; setTab('catalog'); });
}

function wireSide() {
  const side = root.querySelector('.pm-side'), f = view.f;
  const again = debounce(() => { view.page = 0; view.ipage = 0; if (['browse', 'catalog', 'item'].includes(view.tab)) drawMain(); }, 300);
  side.querySelector('[data-pmin]').addEventListener('input', (e) => { f.pmin = e.target.value; again(); });
  side.querySelector('[data-pmax]').addEventListener('input', (e) => { f.pmax = e.target.value; again(); });
  side.querySelectorAll('[data-wear]').forEach((c) => c.addEventListener('change', () => {
    f.wears = [...side.querySelectorAll('[data-wear]:checked')].map((x) => x.dataset.wear);
    again();
  }));
  side.querySelectorAll('[data-x]').forEach((c) => c.addEventListener('change', () => { f[c.dataset.x] = c.checked; again(); }));
  side.querySelectorAll('[data-rank]').forEach((c) => c.addEventListener('change', () => { f.ranks = [...side.querySelectorAll('[data-rank]:checked')].map((x) => +x.dataset.rank); again(); }));
  side.querySelector('[data-reset]').addEventListener('click', () => {
    view.f = { pmin: '', pmax: '', wears: [...ALL_WEARS], stt: false, sv: false, rare: false, ranks: [] };
    side.innerHTML = sideHtml();
    wireSide();
    again();
  });
}

// ---- the main area ---------------------------------------------------------------------------------------------------------
function drawMain({ keep = false } = {}) {
  const main = root?.querySelector('[data-main]');
  if (!main || !M.available()) return;
  const draw = { browse: drawBrowse, catalog: drawCatalog, item: drawItem, sell: drawSell, mine: drawMine }[view.tab] || drawBrowse;
  seq++; // (an answer still on its way for what was drawn before is for nothing now)
  draw(main, keep);
}
const loading = (main, keep) => { if (!keep || !main.firstElementChild) main.innerHTML = '<div class="pm-empty">Loading…</div>'; };
// A request whose answer is for what's on screen now (not one asked for before something else was drawn).
async function ask(fn) {
  const mine = seq;
  try {
    const r = await fn();
    return mine === seq && root ? r : null;
  } catch (e) {
    if (mine === seq && root) root.querySelector('[data-main]').innerHTML = `<div class="pm-empty red">${esc(e.message)}</div>`;
    return null;
  }
}
function pagerHtml(r) {
  if (r.pages <= 1) return '';
  return `<div class="pm-pager"><button class="btn sm" data-pg="${r.page - 1}" ${r.page ? '' : 'disabled'}>‹ Prev</button>
    <span>Page ${r.page + 1} of ${r.pages.toLocaleString('en-US')}</span><button class="btn sm" data-pg="${r.page + 1}" ${r.page < r.pages - 1 ? '' : 'disabled'}>Next ›</button></div>`;
}
const barHtml = (count, sorts, cur, { toggle = true } = {}) => `<div class="pm-bar"><span class="pm-count">${count}</span><button class="pm-fresh" data-fresh hidden></button><span class="spacer"></span>
  <select class="input pm-sort" data-sort>${sorts.map(([k, n]) => `<option value="${k}" ${cur === k ? 'selected' : ''}>${n}</option>`).join('')}</select>
  ${toggle ? `<div class="pm-modes"><button data-mode="grid" class="${view.mode === 'grid' ? 'on' : ''}" title="Grid">${ICON.grid}</button><button data-mode="list" class="${view.mode === 'list' ? 'on' : ''}" title="List">${ICON.list}</button></div>` : ''}</div>`;

async function drawBrowse(main, keep) {
  loading(main, keep);
  const r = await ask(() => M.browse(query()));
  if (!r) return;
  fresh = 0;
  shown = new Map(r.rows.map((l) => [l.lid, l]));
  const what = view.q ? ` for “${esc(view.q)}”` : '';
  main.innerHTML = `${barHtml(`${r.total.toLocaleString('en-US')} item${r.total === 1 ? '' : 's'}${what}`, P.SORTS, view.sort)}
    ${r.rows.length ? listingsHtml(r.rows) : `<div class="pm-empty">${view.q ? `Nobody has listed anything like that${anyFilter() ? ' with these filters' : ''}. <button class="link-btn" data-goto="catalog">Find it in All items</button> to see whether anyone has.` : anyFilter() ? 'No listing matches these filters.' : online() ? 'Nothing is listed yet. Be the first: <button class="link-btn" data-goto="sell">Sell</button> one of your items.' : 'Nothing is listed right now.'}</div>`}
    ${pagerHtml(r)}`;
  wireBar(main, (v) => { view.sort = v; view.page = 0; drawMain(); });
  afford();
}
const anyFilter = () => { const f = view.f; return !!(view.cat || f.pmin || f.pmax || f.wears.length < ALL_WEARS.length || f.stt || f.sv || f.rare || f.ranks.length); };
function wireBar(main, onSort) {
  main.querySelector('[data-sort]')?.addEventListener('change', (e) => onSort(e.target.value));
  main.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { view.mode = b.dataset.mode; keepMode(view.mode); drawMain({ keep: true }); }));
}
const listingsHtml = (rows) => (view.mode === 'list'
  ? `<div class="pm-list">${rows.map(rowHtml).join('')}</div>`
  : `<div class="pm-grid">${rows.map(cardHtml).join('')}</div>`);

// ---- how an item reads ------------------------------------------------------------------------------------------------------
// { kind (the small line, a weapon or what it is), name (its finish), sub ("Factory New ★ Covert Knife") }
function nameBits(it) {
  const d = I.itemDef(it) || {}, np = I.nameParts(it), r = I.rarityInfo(it), cat = P.categoryOf(it);
  if (it.t === 'skin') {
    const rar = r.rank === 6 ? (d.cat === 'gloves' ? '★ Extraordinary' : '★ Covert') : r.n;
    return { kind: np.top, name: np.bottom, sub: [I.wearName(it), rar, TYPE_WORD[cat] || (d.cat === 'equipment' ? 'Equipment' : '')].filter(Boolean).join(' ') };
  }
  if (it.t === 'crate' || it.t === 'key' || it.t === 'tool') return { kind: np.top, name: np.bottom, sub: r.n };
  return { kind: np.top, name: np.bottom, sub: [r.n, TYPE_WORD[cat]].filter(Boolean).join(' ') };
}
const discHtml = (disc) => (Math.abs(disc) < 0.005 ? '<span class="pm-disc zero" data-disc>±0%</span>'
  : disc > 0 ? `<span class="pm-disc" data-disc>-${Math.round(disc * 100)}%</span>` : `<span class="pm-disc up" data-disc>+${Math.round(-disc * 100)}%</span>`);
const patHtml = (f) => (f.label ? `<span class="pm-pat ${esc(f.tier)}" title="${esc(f.label)}">${esc(f.label)}</span>` : '');
function floatHtml(it) {
  if (it.t !== 'skin' || it.fl == null) return it.t === 'charm' && it.pat ? `<div class="pm-fl"><span>Pattern #${(+it.pat).toLocaleString('en-US')}</span></div>` : '<div class="pm-fl"></div>';
  return `<div class="pm-fl"><span>${(+it.fl).toFixed(it.fl < 0.01 ? 4 : 3)}</span><div class="pm-wear" title="Float ${esc(I.floatString(it.fl))}"><i style="left:${Math.max(0, Math.min(100, it.fl * 100))}%"></i></div></div>`;
}
const thumbs = (it) => `${(it.stk || []).map((s) => (D.stickers[s.id] ? `<img src="${esc(I.itemImage({ t: 'sticker', id: s.id }, 's'))}" title="${esc(D.stickers[s.id].n)}" alt="">` : '')).join('')}${it.kc && I.itemDef(I.attachedCharm(it)) ? `<img class="kc" src="${esc(I.itemImage(I.attachedCharm(it), 's'))}" title="${esc(I.itemName(I.attachedCharm(it)))}" alt="">` : ''}`;
function sellerHtml(l) {
  const s = l.seller || {};
  if (M.isMine(l)) return '<span class="pm-seller me">Your listing</span>';
  return `<button class="pm-seller" data-seller="${esc(s.npc || s.id)}" title="${esc(s.name)}'s profile">${esc(s.name)}</button>`;
}
function buyBtn(l, cls = '') {
  if (M.isMine(l)) return `<button class="pm-buy mine ${cls}" data-editmine="${esc(l.lid)}">Your listing</button>`;
  return `<button class="pm-buy ${cls}" data-buy="${esc(l.lid)}" data-p="${l.price}">${ICON.cart}<span>Buy</span></button>`;
}
function cardHtml(l) {
  const it = l.item, f = P.factsOf(l), b = nameBits(it), r = I.rarityInfo(it);
  return `<div class="pm-card ${M.isMine(l) ? 'mine' : ''}" data-lid="${esc(l.lid)}" style="--rc:${r.c}">
    <div class="pm-top"><span class="pm-age" title="Listed ${esc(new Date(l.at).toLocaleString())}">${ICON.clock}${esc(timeAgo(l.at))}</span><span class="pm-tags">${it.stt ? '<b class="st">ST™</b>' : ''}${it.sv ? '<b class="sv">SV</b>' : ''}${it.sn ? `<b class="sn">#${+it.sn}</b>` : ''}</span></div>
    <div class="pm-img" data-open><img loading="lazy" src="${esc(I.itemImage(it, 'm'))}" alt=""><div class="pm-thumbs">${thumbs(it)}</div></div>
    <div class="pm-pricerow"><b class="pm-price" data-price>${money(l.price)}</b>${discHtml(f.disc)}</div>
    <div class="pm-ref">Reference price ${money(f.ref)}</div>
    <div class="pm-kind"><i></i>${esc(b.kind)}</div>
    <div class="pm-name" title="${esc(I.itemName(it))}">${esc(b.name)}${patHtml(f)}</div>
    ${I.customName(it) ? `<div class="pm-tagname">"<bdi>${esc(I.customName(it))}</bdi>"</div>` : ''}
    <div class="pm-sub">${esc(b.sub)}</div>
    ${floatHtml(it)}
    <div class="pm-act">${buyBtn(l)}<button class="pm-more" data-more title="More">${ICON.dots}</button></div>
  </div>`;
}
function rowHtml(l) {
  const it = l.item, f = P.factsOf(l), b = nameBits(it), r = I.rarityInfo(it);
  return `<div class="pm-row ${M.isMine(l) ? 'mine' : ''}" data-lid="${esc(l.lid)}" style="--rc:${r.c}">
    <div class="pm-rimg" data-open><img loading="lazy" src="${esc(I.itemImage(it, 's'))}" alt=""></div>
    <div class="pm-rname"><div class="pm-kind"><i></i>${esc(b.kind)}</div><div class="pm-name">${esc(b.name)}${patHtml(f)}</div><div class="pm-sub">${esc(b.sub)}${it.sn ? ` · #${+it.sn}` : ''}</div></div>
    <div class="pm-rfl">${floatHtml(it)}${it.t === 'skin' && it.sd != null ? `<div class="pm-seed">Pattern <b>${+it.sd}</b>${f.label ? ` · ${esc(f.label)}` : ''}</div>` : ''}</div>
    <div class="pm-rthumbs">${thumbs(it)}</div>
    <div class="pm-rseller">${sellerHtml(l)}<span class="pm-age">${esc(timeAgo(l.at))}</span></div>
    <div class="pm-rprice"><div><b class="pm-price" data-price>${money(l.price)}</b>${discHtml(f.disc)}</div><div class="pm-ref">Ref. ${money(f.ref)}</div></div>
    <div class="pm-ract">${buyBtn(l)}</div>
  </div>`;
}
function afford() {
  const shut = M.isClosed(), el = root?.querySelector('[data-closed]');
  if (el && el.hidden === shut) el.hidden = !shut; // (an answer said it opened or closed)
  root?.querySelectorAll('[data-buy]').forEach((b) => {
    if (b.closest('.sold')) return;
    b.disabled = shut || S.money + 1e-9 < +b.dataset.p;
    b.title = shut ? 'The Market is closed right now' : '';
  });
}

// ---- clicks in the main area ------------------------------------------------------------------------------------------------
function listingOf(el) { const lid = el.closest('[data-lid]')?.dataset.lid; return lid ? shown.get(lid) || null : null; }
function onMainClick(e) {
  const t = e.target;
  const pg = t.closest('[data-pg]');
  if (pg) { const n = +pg.dataset.pg; if (view.tab === 'item') view.ipage = n; else view.page = n; drawMain(); root.scrollTop = 0; root.querySelector('.pm-main')?.scrollIntoView({ block: 'start' }); return; }
  if (t.closest('[data-fresh]')) { fresh = 0; view.page = 0; view.sort = 'new'; drawMain(); return; }
  const go = t.closest('[data-goto]');
  if (go) { view.page = 0; setTab(go.dataset.goto); return; }
  const buy = t.closest('[data-buy]');
  if (buy) { const l = listingOf(buy); if (l) buyListing(l); return; }
  if (t.closest('[data-editmine]')) { setTab('mine'); return; }
  const seller = t.closest('[data-seller]');
  if (seller) { const l = listingOf(seller) || { seller: { id: +seller.dataset.seller, npc: seller.dataset.seller } }; openSeller(l.seller); return; }
  if (t.closest('[data-more]')) { const l = listingOf(t); if (l) listingMenu(e, l); return; }
  if (t.closest('[data-back]')) { setTab(view.back); return; }
  const entry = t.closest('[data-key]');
  if (entry) { openItem(entry.dataset.key); return; }
  if (t.closest('[data-open]')) { const l = listingOf(t); if (l) openItem(P.factsOf(l).key); }
}
function onMainMenu(e) {
  const l = listingOf(e.target);
  if (l) listingMenu(e, l);
}
function listingMenu(e, l) {
  e.preventDefault();
  const it = l.item;
  contextMenu(e.clientX, e.clientY, [
    ['skin', 'sticker', 'agent', 'charm'].includes(it.t) ? { label: 'Inspect', icon: 'zoom_in', hint: '3D', action: () => openInspect(it, { preview: true }) } : null,
    { label: 'All listings of this item', icon: 'stats_grid', action: () => openItem(P.factsOf(l).key) },
    M.isMine(l) ? { label: 'Change price or cancel', icon: 'edit', action: () => setTab('mine') } : { label: `${l.seller?.name || 'Seller'}'s profile`, icon: 'player', action: () => openSeller(l.seller) },
    '-',
    M.isMine(l) ? null : { label: `Buy for ${money(l.price)}`, icon: 'dollar_sign', disabled: S.money + 1e-9 < l.price, action: () => buyListing(l) },
  ].filter(Boolean));
}
async function openSeller(s) {
  if (!s || s.me) return;
  if (s.npc && !online()) { (await import('./community.js')).openPerson(s.npc); return; }
  if (online() && Number.isInteger(+s.id)) (await import('./community-online.js')).openProfile(+s.id);
}

// ---- buying -------------------------------------------------------------------------------------------------------------------
// The listing as the window shows it is what's bought: its price is the one sent, so a seller's new price meanwhile is refused
// (the page then shows it), never charged.
async function buyListing(shownL) {
  const l = { ...shownL }, price = l.price, f = P.factsOf(l), name = esc(P.marketName(l.item));
  if (M.isClosed()) { sfx.error(); toast('The Market is closed on this server right now', 'bad'); return; }
  if (S.money + 1e-9 < price) { sfx.error(); toast(`You need ${money(price)} for that`, 'bad'); return; }
  const off = f.disc > 0.005 ? ` <span class="green">${Math.round(f.disc * 100)}% under</span> its reference price (${money(f.ref)})` : f.disc < -0.005 ? ` ${Math.round(-f.disc * 100)}% over its reference price (${money(f.ref)})` : ` its reference price`;
  const wear = l.item.t === 'skin' && l.item.fl != null ? ` (${esc(I.wearName(l.item))}, float ${esc(I.floatString(l.item.fl))})` : '';
  if (!(await confirmDialog(`Buy <b>${name}</b>${wear} from <b>${esc(l.seller?.name || '?')}</b> for <b class="green">${money(price)}</b>?<br><span class="muted">That's${off}.</span>`, { title: 'Buy from the Market', ok: `Buy for ${money(price)}` }))) return;
  try {
    const r = await M.buy({ lid: l.lid, price });
    sfx.buy();
    toast(`Bought <b>${esc(P.marketName(r.item || l.item))}</b> for ${money(r.price ?? price)}`, 'good');
    markGone(l.lid);
  } catch (e) {
    sfx.error();
    toast(esc(e.message), 'bad');
    if (e.code === 'gone') markGone(l.lid);
    if (e.code === 'price' || e.code === 'gone') redrawSoon();
    if (e.code === 'off') showClosed();
  }
}

// ---- All items: every item in the game -----------------------------------------------------------------------------------------
async function drawCatalog(main, keep) {
  loading(main, keep);
  catalogAt = Date.now();
  const r = await ask(() => M.catalog(query({ sort: view.csort })));
  if (!r) return;
  main.innerHTML = `${barHtml(`${r.total.toLocaleString('en-US')} item${r.total === 1 ? '' : 's'} in the game${view.q ? ` for “${esc(view.q)}”` : ''}`, P.CATALOG_SORTS, view.csort, { toggle: false })}
    ${r.rows.length ? `<div class="pm-grid cat">${r.rows.map(entryHtml).join('')}</div>` : '<div class="pm-empty">No item in the game matches that.</div>'}${pagerHtml(r)}`;
  wireBar(main, (v) => { view.csort = v; view.page = 0; drawMain(); });
  afford(); // (the banner, if the answer said the Market closed)
}
function entryHtml(x) {
  const e = P.catalogEntry(x.key);
  if (!e) return '';
  const it = P.entryItem(e), b = nameBits(it), r = I.rarityInfo(it), ref = P.entryRef(e);
  return `<div class="pm-card pm-entry ${x.n ? '' : 'pm-none'}" data-key="${esc(x.key)}" style="--rc:${r.c}">
    <div class="pm-img"><img loading="lazy" src="${esc(I.itemImage(it, 'm'))}" alt=""></div>
    <div class="pm-pricerow">${x.n ? `<span class="pm-from">from</span><b class="pm-price">${money(x.min)}</b>` : '<b class="pm-price none">No listings</b>'}</div>
    <div class="pm-ref">Reference price ${money(ref)}</div>
    <div class="pm-kind"><i></i>${esc(b.kind)}</div>
    <div class="pm-name" title="${esc(e.n)}">${esc(b.name)}</div>
    <div class="pm-sub">${esc(b.sub)}</div>
    <div class="pm-count-line">${x.n ? `<b>${x.n.toLocaleString('en-US')}</b> listed` : 'Nobody is selling one'}</div>
  </div>`;
}

// ---- an item's page: every listing of it ------------------------------------------------------------------------------------------
function openItem(key) {
  if (!P.catalogEntry(key)) return;
  if (view.tab !== 'item') view.back = ['browse', 'catalog'].includes(view.tab) ? view.tab : 'browse';
  view.key = key;
  view.ipage = 0;
  view.tab = 'item';
  root.querySelector('.pm-body')?.classList.add('noside');
  drawMain();
  root.scrollTop = 0;
}
async function drawItem(main, keep) {
  const e = P.catalogEntry(view.key);
  if (!e) return setTab('browse');
  const it = P.entryItem(e), b = nameBits(it), r = I.rarityInfo(it);
  loading(main, keep);
  const res = await ask(() => M.browse({ key: view.key, sort: view.isort, page: view.ipage }));
  if (!res) return;
  shown = new Map(res.rows.map((l) => [l.lid, l]));
  const low = res.rows.length && view.isort === 'plow' && !view.ipage ? res.rows[0].price : null;
  const mine = S.inv.filter((x) => P.catalogKey(x) === view.key && !P.listRefusal(x));
  main.innerHTML = `<div class="pm-item" style="--rc:${r.c}">
    <button class="btn ghost sm" data-back>‹ Back</button>
    <div class="pm-ihead"><div class="pm-iimg"><img src="${esc(I.itemImage(it, 'l'))}" alt=""></div>
      <div class="pm-iinfo"><div class="pm-kind"><i></i>${esc(b.kind)}</div><h2>${esc(e.n)}</h2><div class="pm-sub">${esc(b.sub)}</div>
        <dl class="kv"><dt>Reference price</dt><dd>${money(P.entryRef(e))}</dd><dt>Listed now</dt><dd>${res.total.toLocaleString('en-US')}</dd>
        ${low != null ? `<dt>Cheapest</dt><dd class="green">${money(low)}</dd>` : ''}</dl>
        ${mine.length ? `<button class="btn primary sm" data-sellkey>Sell yours (${mine.length})</button>` : ''}</div></div>
    ${barHtml(`${res.total.toLocaleString('en-US')} listing${res.total === 1 ? '' : 's'}`, ITEM_SORTS, view.isort, { toggle: false })}
    ${res.rows.length ? `<div class="pm-list item">${res.rows.map(rowHtml).join('')}</div>` : '<div class="pm-empty">Nobody is selling one right now.</div>'}
    ${pagerHtml(res)}</div>`;
  wireBar(main, (v) => { view.isort = v; view.ipage = 0; drawMain(); });
  main.querySelector('[data-sellkey]')?.addEventListener('click', () => sellOnMarket(mine[0]));
  afford();
}

// ---- selling ----------------------------------------------------------------------------------------------------------------------
// Your items in open trade offers (online), which can't be listed.
function reserved() {
  if (!online()) return new Set();
  const me = net.me()?.id;
  return new Set(net.trades().filter((t) => t.status === 'open' && t.from?.id === me).flatMap((t) => (t.give?.items || []).map((i) => i.uid)));
}
const SELL_SORTS = [['vdesc', 'Value: high to low'], ['vasc', 'Value: low to high'], ['new', 'Newest'], ['name', 'Name']];
function drawSell(main) {
  const res = reserved(), q = view.sellQ.trim().toLowerCase();
  const can = S.inv.filter((it) => !P.listRefusal(it, { reserved: res }) && (!q || I.itemName(it).toLowerCase().includes(q)));
  const sorts = { vdesc: (a, b) => I.itemValue(b) - I.itemValue(a), vasc: (a, b) => I.itemValue(a) - I.itemValue(b), new: (a, b) => (b.at || 0) - (a.at || 0), name: (a, b) => I.itemName(a).localeCompare(I.itemName(b)) };
  can.sort(sorts[view.sellSort] || sorts.vdesc);
  const shownItems = can.slice(0, 300), n = listedOf(S).length;
  main.innerHTML = `<div class="pm-sellhead"><h3>Sell an item</h3><p class="muted">Pick one of your items and set a price: it leaves your inventory until someone buys it (the money is yours at once, even while you're away) or you cancel.
      ${online() ? 'Other players buy it.' : 'Offline, the traders look at your listings and buy what\'s worth it to them.'} ${P.MARKET_FEE ? `The Market keeps ${Math.round(P.MARKET_FEE * 100)}%.` : 'There\'s no fee.'} Up to ${P.MAX_LISTINGS} listings at once (you have ${n}).</p></div>
    <div class="toolbar"><input class="input" type="search" data-sellq placeholder="Search your items…" value="${esc(view.sellQ)}"><select class="input" data-sellsort>${SELL_SORTS.map(([k, t]) => `<option value="${k}" ${view.sellSort === k ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <span class="spacer"></span><span class="muted">${can.length.toLocaleString('en-US')} item${can.length === 1 ? '' : 's'} you can list${can.length > shownItems.length ? ` · the first ${shownItems.length} shown: search for the rest` : ''}</span></div>
    ${shownItems.length ? `<div class="grid" data-sellgrid>${shownItems.map((it) => itemCard(it)).join('')}</div>` : `<div class="pm-empty">${S.inv.length ? 'None of your items can be listed (locked items, Storage Units and items in trade offers can\'t).' : 'Your inventory is empty.'}</div>`}`;
  const sq = main.querySelector('[data-sellq]');
  sq.addEventListener('input', debounce(() => { view.sellQ = sq.value; drawSell(main); const x = main.querySelector('[data-sellq]'); x.focus(); x.setSelectionRange(x.value.length, x.value.length); }, 200));
  main.querySelector('[data-sellsort]').addEventListener('change', (e) => { view.sellSort = e.target.value; drawSell(main); });
  main.querySelector('[data-sellgrid]')?.addEventListener('click', (e) => {
    const c = e.target.closest('.card[data-uid]');
    const it = c && S.inv.find((x) => x.uid === c.dataset.uid);
    if (it) sellOnMarket(it);
  });
}

// The selling window for one of your items (the inventory's "Sell on Market" too): its reference price, the cheapest listing
// of the same item, a suggested price, and what you'd get. → whether it was listed
export async function sellOnMarket(item) {
  if (!M.available()) { toast('This server has no Market yet', 'bad'); return false; }
  if (M.isClosed()) { sfx.error(); toast('The Market is closed on this server right now', 'bad'); return false; }
  const why = P.listRefusal(item, { reserved: reserved() });
  if (why) { sfx.error(); toast(esc(why), 'bad'); return false; }
  if (listedOf(S).length >= P.MAX_LISTINGS) { sfx.error(); toast(`You have ${P.MAX_LISTINGS} listings. Cancel one first.`, 'bad'); return false; }
  const ref = P.referencePrice(item), key = P.catalogKey(item);
  return new Promise((resolve) => {
    let done = false;
    const m = openModal({
      title: 'Sell on the Market', cls: 'wide pm-sellmodal',
      body: `<div class="pm-sell"><div class="pm-sellcard">${itemCard(item)}</div><div class="pm-sellform">
        <div class="pm-sellname">${I.nameHtml(item)}</div>
        <dl class="kv"><dt>Reference price</dt><dd>${money(ref)} <span class="muted">· what the Store pays for it right now</span></dd>
          <dt>Cheapest listed</dt><dd data-low class="muted">Looking…</dd>
          <dt>Suggested price</dt><dd><button class="link-btn" data-sug>${money(P.suggestedPrice(ref))}</button></dd></dl>
        <label class="pm-pricefield">Your price<span class="pm-dollar">$</span><input class="input" data-price inputmode="decimal" value="${P.suggestedPrice(ref).toFixed(2)}"></label>
        <div class="pm-get">You get <b data-get></b> when it sells <span class="muted">· ${P.MARKET_FEE ? `${Math.round(P.MARKET_FEE * 100)}% fee` : 'no fee'}</span></div>
        <div class="pm-warn" data-warn></div></div></div>`,
      foot: '<button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-list>List it</button>',
      onClose: () => { if (!done) resolve(false); },
    });
    const input = m.el.querySelector('[data-price]'), btn = m.el.querySelector('[data-list]');
    const update = () => {
      const p = P.cleanPrice(input.value), bad = P.priceProblem(p, ref);
      m.el.querySelector('[data-get]').textContent = Number.isFinite(p) ? money(P.sellerGets(p)) : '—';
      const warn = bad || (p < ref * 0.98 ? `That's ${Math.round((1 - p / ref) * 100)}% under its reference price: the Store would pay you ${money(ref)} for it right now.` : '');
      m.el.querySelector('[data-warn]').textContent = warn;
      m.el.querySelector('[data-warn]').classList.toggle('bad', !!bad);
      btn.disabled = !!bad;
      btn.textContent = bad ? 'List it' : `List for ${money(p)}`;
    };
    let edited = false;
    input.addEventListener('input', () => { edited = true; update(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !btn.disabled) btn.click(); });
    m.el.querySelector('[data-sug]').addEventListener('click', () => { input.value = m.el.querySelector('[data-sug]').dataset.v || P.suggestedPrice(ref).toFixed(2); update(); });
    update();
    input.focus();
    input.select();
    M.lowest(key).then(({ n, min }) => {
      if (!m.el.isConnected) return;
      const sug = P.suggestedPrice(ref, min);
      m.el.querySelector('[data-low]').innerHTML = n ? `${money(min)} <span class="muted">· ${n} listed</span>` : 'None listed';
      m.el.querySelector('[data-low]').classList.toggle('muted', !n);
      const s = m.el.querySelector('[data-sug]');
      s.textContent = money(sug);
      s.dataset.v = sug.toFixed(2);
      if (!edited) { input.value = sug.toFixed(2); update(); input.select(); }
    }).catch(() => { if (m.el.isConnected) m.el.querySelector('[data-low]').textContent = '—'; });
    btn.addEventListener('click', async () => {
      const p = P.cleanPrice(input.value);
      btn.disabled = true;
      try {
        await M.list(item, p);
        done = true;
        sfx.coin();
        toast(`Listed <b>${esc(P.marketName(item))}</b> on the Market for <b>${money(p)}</b>`, 'good');
        m.close();
        resolve(true);
      } catch (e) {
        sfx.error();
        toast(esc(e.message), 'bad');
        btn.disabled = false;
        if (e.code === 'off') { showClosed(); m.close(); }
      }
    });
  });
}

// ---- My listings ---------------------------------------------------------------------------------------------------------------
async function drawMine(main) {
  const mine = M.myListings().sort((a, b) => b.at - a.at);
  shown = new Map(mine.map((l) => [l.lid, l]));
  main.innerHTML = `<div class="pm-mine"><div class="pm-sellhead"><h3>Your listings <span class="muted">${mine.length} / ${P.MAX_LISTINGS}</span></h3>
      <button class="btn primary sm" data-goto="sell">Sell an item</button></div>
    ${mine.length ? `<div class="pm-list mine">${mine.map((l) => {
      const it = l.item, f = P.factsOf(l), b = nameBits(it), r = I.rarityInfo(it);
      return `<div class="pm-row" data-lid="${esc(l.lid)}" style="--rc:${r.c}">
        <div class="pm-rimg" data-open><img loading="lazy" src="${esc(I.itemImage(it, 's'))}" alt=""></div>
        <div class="pm-rname"><div class="pm-kind"><i></i>${esc(b.kind)}</div><div class="pm-name">${esc(b.name)}${patHtml(f)}</div><div class="pm-sub">${esc(b.sub)}</div></div>
        <div class="pm-rfl">${floatHtml(it)}</div>
        <div class="pm-rseller"><span class="pm-age">Listed ${esc(timeAgo(l.at))}</span><span class="muted">Reference ${money(f.ref)}</span></div>
        <div class="pm-reprice"><span class="pm-dollar">$</span><input class="input" data-newprice value="${l.price.toFixed(2)}" inputmode="decimal"><button class="btn sm" data-save disabled>Save</button></div>
        <div class="pm-ract"><button class="btn sm danger" data-cancel>Cancel</button></div></div>`;
    }).join('')}</div>` : '<div class="pm-empty">You have nothing listed. <button class="link-btn" data-goto="sell">Sell an item</button></div>'}
    <div class="pm-sellhead"><h3>Recent activity</h3></div><div data-recent><div class="pm-empty">Loading…</div></div></div>`;
  main.querySelectorAll('[data-lid]').forEach((row) => {
    const l = shown.get(row.dataset.lid), input = row.querySelector('[data-newprice]'), save = row.querySelector('[data-save]');
    if (!l || !input) return;
    input.addEventListener('input', () => { const p = P.cleanPrice(input.value); save.disabled = M.isClosed() || !Number.isFinite(p) || p === l.price || !!P.priceProblem(p, P.factsOf(l).ref); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !save.disabled) save.click(); });
    save.addEventListener('click', async () => {
      const p = P.cleanPrice(input.value);
      save.disabled = true;
      try { await M.reprice(l.lid, p); sfx.coin(); toast(`${esc(P.marketName(l.item))} is now listed for <b>${money(p)}</b>`, 'good'); } catch (e) { sfx.error(); toast(esc(e.message), 'bad'); save.disabled = false; if (e.code === 'off') showClosed(); }
    });
    row.querySelector('[data-cancel]').addEventListener('click', async () => {
      if (!(await confirmDialog(`Take <b>${esc(P.marketName(l.item))}</b> off the Market? It goes back to your inventory.`, { title: 'Take it off the Market', ok: 'Take it down', no: 'Keep it listed', danger: true }))) return;
      try { await M.cancel(l.lid); toast(`${esc(P.marketName(l.item))} is back in your inventory`, 'good'); } catch (e) { sfx.error(); toast(esc(e.message), 'bad'); }
    });
  });
  let rows;
  try { rows = await M.recent(); } catch (e) { const el = main.querySelector('[data-recent]'); if (el) el.innerHTML = `<div class="pm-empty red">${esc(e.message)}</div>`; return; }
  const el = root?.querySelector('[data-recent]');
  if (!el || view.tab !== 'mine') return;
  const what = { sold: ['Sold', 'green'], bought: ['Bought', ''], cancelled: ['Cancelled', 'dim'], removed: ['Taken down', 'red'] };
  el.innerHTML = rows.length ? `<div class="db-table-wrap"><table class="price-table pm-hist"><thead><tr><th>When</th><th></th><th>Item</th><th class="num">Price</th><th>With</th></tr></thead><tbody>${rows.map((x) => {
    const [label, cls] = what[x.kind] || [x.kind, ''];
    const name = x.item ? P.marketName(x.item) : x.name || '';
    return `<tr><td class="nw">${esc(timeAgo(x.at))}</td><td><span class="chip ${cls}">${label}</span></td><td>${esc(name)}</td>
      <td class="num">${money(x.price)}${x.kind === 'sold' && x.got != null && x.got !== x.price ? ` <span class="muted">(you got ${money(x.got)})</span>` : ''}</td><td>${x.who ? esc(x.who) : '<span class="dim">—</span>'}</td></tr>`;
  }).join('')}</tbody></table></div>` : '<div class="pm-empty">Nothing yet.</div>';
  showClosed(); // (the answer says whether the Market is open: Save on or off)
}

// ---- offline: the traders buy what you list --------------------------------------------------------------------------------------
export function initMarket() {
  M.startOffline((sold) => {
    for (const s of sold.slice(0, 3)) toast(`<b>${esc(s.who)}</b> bought your <b>${esc(s.name)}</b> on the Market: <b class="green">+${money(s.got)}</b>`, 'gold');
    if (sold.length > 3) toast(`…and ${sold.length - 3} more of your listings sold`, 'gold');
  });
}
