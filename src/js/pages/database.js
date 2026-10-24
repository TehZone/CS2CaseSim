// Item Database, like CSFloat's: search every item in the game (skins, knives, gloves, stickers, agents, pro cards) and
// open one to see every copy that exists: who has it, its float, wear, pattern and stickers, and its float rank (the
// three lowest and three highest floats of the item, counted apart for StatTrak™ and Souvenir copies). Online that's
// everyone on the server; offline, your own inventory. A skin's current Market listings show under its copies.
import { esc, money, imgUrl, debounce } from '../util.js';
import { D, WEARS, wearOf, WEAR_BY_KEY } from '../data.js';
import * as I from '../items.js';
import { S, on } from '../state.js';
import { openInspect, patternTag, toast } from '../ui.js';
import { online } from '../backend.js';
import { net } from '../net/online.js';
import { marketWindow, skinListings, localSold, lowestPrice } from '../engine/market.js';
import { floatRanks, countCopies, copyCategory, CATEGORY_NAME, itemKey } from '../engine/database.js';

const PAGE = 60;
const TYPES = [['all', 'All items'], ['skin', 'Weapon skins'], ['knife', 'Knives'], ['gloves', 'Gloves'], ['sticker', 'Stickers'], ['agent', 'Agents'], ['pro', 'Pro cards']];
const WEAPON_CATS = [['all', 'All weapons'], ['rifle', 'Rifles'], ['pistol', 'Pistols'], ['smg', 'SMGs'], ['heavy', 'Heavy']];
const SORTS = [['owned', 'Most copies'], ['pricey', 'Price: high → low'], ['cheap', 'Price: low → high'], ['rarity', 'Rarity'], ['name', 'Name']];
const COPY_SORTS = [['low', 'Float: low → high'], ['high', 'Float: high → low'], ['value', 'Value'], ['new', 'Newest']];
const view = { type: 'all', cat: 'all', q: '', sort: 'owned', owned: false, page: 0, key: null, copyCat: 'all', wear: 'all', copySort: 'low', owner: '' };
let root, offs = [], index = null, indexAt = 0, copies = null, copiesKey = null, loading = false;

const now = () => (online() ? net.serverNow() : Date.now());
const soldFor = (w) => (online() ? net.marketSold(w) : localSold(S, w));

// Every item in the game, once: what the grid shows and searches.
let CATALOG = null;
function catalog() {
  if (CATALOG) return CATALOG;
  const out = [];
  const add = (t, d, kind, top, bottom, price) => {
    const it = { t, id: d.id }, r = I.rarityInfo(it);
    out.push({ key: t + ':' + d.id, t, id: d.id, kind, cat: d.cat || '', top, bottom, img: d.img, price: price || 0, rank: r.rank, rn: r.n, rc: r.c,
      search: (top + ' ' + bottom + ' ' + (d.t || '') + ' ' + (d.ty || '') + ' ' + (d.ph || '')).toLowerCase() });
  };
  for (const s of Object.values(D.skins)) {
    const np = I.nameParts({ t: 'skin', id: s.id });
    add('skin', s, s.cat === 'knife' ? 'knife' : s.cat === 'gloves' ? 'gloves' : 'skin', np.top, np.bottom, lowestPrice(s));
  }
  for (const s of Object.values(D.stickers)) { const [, a, ...b] = s.n.split(' | '); add('sticker', s, 'sticker', b.length ? `Sticker · ${b.join(' | ')}` : 'Sticker', a || s.n, s.p); }
  for (const a of Object.values(D.agents)) { const [n, f] = a.n.split(' | '); add('agent', a, 'agent', f || 'Agent', n, a.p); }
  for (const p of Object.values(D.pros)) add('pro', p, 'pro', `Pro card · ${D.proTeams[p.tm]?.n || ''}`.trim(), I.itemName({ t: 'pro', id: p.id }), I.basePrice({ t: 'pro', id: p.id }));
  return (CATALOG = out);
}

// Which cases and collections a skin comes from, and the skins that come as Souvenirs (in a souvenir package).
let SOURCES = null, SOUVENIR = null;
const souvenirs = (id) => (SOUVENIR ||= new Set(D.cases.filter((c) => c.kind === 'souvenir').flatMap((c) => Object.values(c.pools || {}).flat()))).has(id);
function sourcesOf(id) {
  if (!SOURCES) {
    SOURCES = new Map();
    const put = (sid, n) => { if (!SOURCES.has(sid)) SOURCES.set(sid, []); if (!SOURCES.get(sid).includes(n)) SOURCES.get(sid).push(n); };
    for (const c of D.cases) {
      for (const ids of Object.values(c.pools || {})) for (const sid of ids) put(sid, c.n);
      for (const sid of [].concat(c.rare || [])) if (typeof sid === 'string') put(sid, c.n);
    }
  }
  return SOURCES.get(id) || [];
}

export function render(r) {
  root = r;
  offs.forEach((o) => o());
  offs = [on('state', () => { if (!online()) { index = null; if (view.key) copiesKey = null; draw(); } })];
  index = null;
  draw();
}
export function destroy() { offs.forEach((o) => o()); offs = []; root = null; }

// How many copies of each item there are: the server's count online (refreshed every so often), your inventory offline.
async function loadIndex() {
  if (!online()) { index = { counts: countCopies(S.inv), players: 1 }; return; }
  if (index && Date.now() - indexAt < 20000) return;
  try { index = await net.social('db.index'); indexAt = Date.now(); } catch (e) { index = { counts: {}, players: 0, err: e.message }; }
}

// Every copy of one item: [{ owner, me, item }], and for a sticker the guns it's applied to.
async function loadCopies(e) {
  if (!online()) {
    const mine = (it) => ({ owner: S.profile?.name || 'You', me: true, item: it });
    return { copies: S.inv.filter((it) => itemKey(it) === e.key).map(mine), applied: e.t === 'sticker' ? S.inv.filter((it) => it.stk?.some((s) => s.id === e.id)).map(mine) : [] };
  }
  return net.social('db.item', { t: e.t, id: e.id });
}

function draw() {
  if (!root) return;
  if (view.key) return drawItem();
  if (!index) { root.innerHTML = '<div class="page"><div class="empty">Loading the item database…</div></div>'; loadIndex().then(() => root && draw()); return; }
  const counts = index.counts || {};
  let list = catalog();
  if (view.type !== 'all') list = list.filter((e) => e.kind === view.type);
  if (view.type === 'skin' && view.cat !== 'all') list = list.filter((e) => e.cat === view.cat);
  if (view.q) { const words = view.q.split(/\s+/).filter(Boolean); list = list.filter((e) => words.every((w) => e.search.includes(w))); }
  if (view.owned) list = list.filter((e) => counts[e.key]);
  const sorts = {
    owned: (a, b) => (counts[b.key] || 0) - (counts[a.key] || 0) || b.price - a.price,
    pricey: (a, b) => b.price - a.price, cheap: (a, b) => a.price - b.price, rarity: (a, b) => b.rank - a.rank || b.price - a.price,
    name: (a, b) => (a.top + a.bottom).localeCompare(b.top + b.bottom),
  };
  list = list.slice().sort(sorts[view.sort]);
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  view.page = Math.min(view.page, pages - 1);
  const shown = list.slice(view.page * PAGE, view.page * PAGE + PAGE);
  const total = Object.values(counts).reduce((s, n) => s + n, 0), kinds = Object.keys(counts).length;
  root.innerHTML = `<div class="page db">
    <div class="page-head"><h1>Item Database</h1><span class="sub">Every item in the game. Open one to see every copy, who owns it and its float rank.</span>
      <span class="spacer"></span><span class="chip">${online() ? `${index.players.toLocaleString()} players on the server` : 'Offline: your items only'} · ${total.toLocaleString()} copies of ${kinds.toLocaleString()} items</span></div>
    ${index.err ? `<div class="db-note">Couldn't reach the server's database: ${esc(index.err)}</div>` : !online() ? '<div class="db-note">Offline, the database shows your own inventory. Log in to a server (top right) to see every player\'s copies.</div>' : ''}
    <div class="toolbar">
      <input class="input db-search" type="search" placeholder="Search ${catalog().length.toLocaleString()} items… (e.g. ak redline, karambit fade, howl)" value="${esc(view.q)}">
      <select class="input" data-type>${TYPES.map(([k, n]) => `<option value="${k}" ${view.type === k ? 'selected' : ''}>${n}</option>`).join('')}</select>
      ${view.type === 'skin' ? `<select class="input" data-cat>${WEAPON_CATS.map(([k, n]) => `<option value="${k}" ${view.cat === k ? 'selected' : ''}>${n}</option>`).join('')}</select>` : ''}
      <select class="input" data-sort>${SORTS.map(([k, n]) => `<option value="${k}" ${view.sort === k ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <label class="check"><input type="checkbox" data-owned ${view.owned ? 'checked' : ''}> Owned by someone</label>
      <span class="spacer"></span><span class="muted">${list.length.toLocaleString()} items</span>
    </div>
    ${shown.length ? `<div class="grid">${shown.map((e) => `<div class="card db-card" data-key="${esc(e.key)}" style="--rc:${e.rc}">
      <div class="img"><img loading="lazy" src="${imgUrl(e.img, 'm')}" alt=""></div><div class="rbar"></div>
      <div class="meta"><div class="n1" title="${esc(e.top)}">${esc(e.top)}</div><div class="n2" title="${esc(e.bottom)}">${esc(e.bottom)}</div>
      <div class="row"><span class="wear">${esc(e.rn)}</span><span class="val">${e.kind === 'skin' || e.kind === 'knife' || e.kind === 'gloves' ? '<span class="dim" style="font-weight:400">from</span> ' : ''}${money(e.price)}</span></div>
      <div class="row"><span class="db-count ${counts[e.key] ? '' : 'none'}">${counts[e.key] ? `${counts[e.key].toLocaleString()} ${counts[e.key] === 1 ? 'copy' : 'copies'}` : 'No copies yet'}</span></div></div></div>`).join('')}</div>`
      : '<div class="empty">No items match.</div>'}
    ${pages > 1 ? `<div class="pager"><button class="btn sm" data-pg="-1" ${view.page ? '' : 'disabled'}>‹ Prev</button><span>Page ${view.page + 1} / ${pages}</span><button class="btn sm" data-pg="1" ${view.page < pages - 1 ? '' : 'disabled'}>Next ›</button></div>` : ''}
  </div>`;
  const q = root.querySelector('.db-search');
  q.addEventListener('input', debounce(() => { view.q = q.value.toLowerCase().trim(); view.page = 0; draw(); const n = root?.querySelector('.db-search'); n?.focus(); n?.setSelectionRange(n.value.length, n.value.length); }, 220));
  root.querySelector('[data-type]').addEventListener('change', (e) => { view.type = e.target.value; view.cat = 'all'; view.page = 0; draw(); });
  root.querySelector('[data-cat]')?.addEventListener('change', (e) => { view.cat = e.target.value; view.page = 0; draw(); });
  root.querySelector('[data-sort]').addEventListener('change', (e) => { view.sort = e.target.value; draw(); });
  root.querySelector('[data-owned]').addEventListener('change', (e) => { view.owned = e.target.checked; view.page = 0; draw(); });
  root.querySelectorAll('[data-pg]').forEach((b) => b.addEventListener('click', () => { view.page += +b.dataset.pg; draw(); root.scrollTop = 0; }));
  root.querySelectorAll('.db-card').forEach((c) => c.addEventListener('click', () => openItem(c.dataset.key)));
}

function openItem(key) {
  view.key = key; view.copyCat = 'all'; view.wear = 'all'; view.copySort = 'low'; view.owner = '';
  copies = null; copiesKey = null;
  root.scrollTop = 0;
  draw();
}

// A copy's float rank, as badges: #1-#3 lowest (green) and highest (orange) among its item's copies in its category.
function rankBadges(r, cat) {
  if (!r) return '';
  const of = `of ${r.of.toLocaleString()} ${CATEGORY_NAME[cat]} ${r.of === 1 ? 'copy' : 'copies'}`;
  return (r.low ? `<span class="fr low r${r.low}" title="#${r.low} lowest float ${of}">#${r.low} Low</span>` : '')
    + (r.high ? `<span class="fr high r${r.high}" title="#${r.high} highest float ${of}">#${r.high} High</span>` : '');
}

function drawItem() {
  const e = catalog().find((x) => x.key === view.key);
  if (!e) { view.key = null; return draw(); }
  if (copiesKey !== e.key) {
    copiesKey = e.key;
    root.innerHTML = `<div class="page db"><div class="page-head"><button class="btn sm ghost" data-back>‹ Item Database</button><h1>${esc(e.bottom)}</h1></div><div class="empty">Looking up every copy…</div></div>`;
    root.querySelector('[data-back]').addEventListener('click', back);
    loading = true;
    loadCopies(e).then((r) => { copies = r; }).catch((err) => { copies = { copies: [], applied: [], err: err.message }; }).finally(() => { loading = false; if (root && view.key === e.key) draw(); });
    return;
  }
  if (loading || !copies) return;
  const d = I.itemDef({ t: e.t, id: e.id }), skin = e.t === 'skin', all = copies.copies || [];
  const sv = skin && (souvenirs(e.id) || all.some((c) => c.item.sv));
  const ranks = skin ? floatRanks(all) : new Map();
  let rows = all.slice();
  if (view.copyCat !== 'all') rows = rows.filter((c) => copyCategory(c.item) === view.copyCat);
  if (view.wear !== 'all') rows = rows.filter((c) => c.item.fl != null && wearOf(c.item.fl) === view.wear);
  if (view.owner) rows = rows.filter((c) => c.owner.toLowerCase().includes(view.owner));
  const sorts = { low: (a, b) => (a.item.fl ?? 2) - (b.item.fl ?? 2), high: (a, b) => (b.item.fl ?? -1) - (a.item.fl ?? -1), value: (a, b) => I.itemValue(b.item) - I.itemValue(a.item), new: (a, b) => (b.item.at || 0) - (a.item.at || 0) };
  rows.sort(sorts[skin ? view.copySort : view.copySort === 'value' ? 'value' : 'new']);
  const cats = { n: 0, st: 0, sv: 0 };
  for (const c of all) cats[copyCategory(c.item)]++;
  const owners = new Set(all.map((c) => c.owner)).size;
  const floats = all.map((c) => c.item.fl).filter((f) => f != null);
  const col = skin && d.col ? D.collections.find((c) => c.id === d.col)?.n : null;
  const from = skin ? sourcesOf(e.id) : [];
  const w = marketWindow(now()), sold = skin ? soldFor(w) : null;
  const listings = skin ? skinListings(d, w).filter((l) => !sold.has(l.lid)).sort((a, b) => a.item.fl - b.item.fl) : [];
  const priceRows = skin && !d.v ? WEARS.filter((x) => d.p[x.k]) : [];
  const shownRows = rows.slice(0, 500);
  root.innerHTML = `<div class="page db">
    <div class="page-head"><button class="btn sm ghost" data-back>‹ Item Database</button><h1>${esc(e.bottom)}</h1><span class="sub">${esc(e.top)}</span></div>
    <div class="db-item">
      <div class="db-hero" style="--rc:${e.rc}"><img src="${imgUrl(e.img, 'l')}" alt=""><div class="rbar"></div>${e.t !== 'pro' ? '<button class="btn sm" data-inspect>Inspect</button>' : ''}</div>
      <div class="db-facts">
        <div class="db-stats">
          <div><b>${all.length.toLocaleString()}</b><span>${all.length === 1 ? 'copy' : 'copies'}</span></div>
          <div><b>${owners.toLocaleString()}</b><span>${owners === 1 ? 'owner' : 'owners'}</span></div>
          ${skin && d.stt ? `<div><b class="st">${cats.st.toLocaleString()}</b><span>StatTrak™</span></div>` : ''}
          ${skin && sv ? `<div><b class="sv">${cats.sv.toLocaleString()}</b><span>Souvenir</span></div>` : ''}
          ${floats.length ? `<div><b>${Math.min(...floats).toFixed(6)}</b><span>lowest float</span></div><div><b>${Math.max(...floats).toFixed(6)}</b><span>highest float</span></div>` : ''}
          ${e.t === 'sticker' ? `<div><b>${(copies.applied || []).length.toLocaleString()}</b><span>applied to guns</span></div>` : ''}
        </div>
        <dl class="db-dl">
          <dt>Rarity</dt><dd style="color:${e.rc}">${esc(e.rn)}</dd>
          ${skin && !d.v ? `<dt>Float range</dt><dd><div class="floatwrap"><div class="floatbar"><div class="range" style="left:${d.mn * 100}%;right:${(1 - d.mx) * 100}%"></div></div></div>${d.mn.toFixed(2)} – ${d.mx.toFixed(2)}</dd>` : ''}
          ${col ? `<dt>Collection</dt><dd>${esc(col)}</dd>` : ''}
          ${from.length ? `<dt>Found in</dt><dd>${from.slice(0, 6).map(esc).join(', ')}${from.length > 6 ? ` and ${from.length - 6} more` : ''}</dd>` : ''}
          ${d.t ? `<dt>Tournament</dt><dd>${esc(d.t)}</dd>` : ''}
          ${!priceRows.length ? `<dt>Price</dt><dd>${money(e.price)}</dd>` : ''}
        </dl>
        ${priceRows.length ? `<table class="price-table"><thead><tr><th>Wear</th><th>Price</th>${d.stt ? '<th>StatTrak™</th>' : ''}${sv ? '<th>Souvenir</th>' : ''}</tr></thead><tbody>
          ${priceRows.map((x) => `<tr><td><b class="wk" style="--wc:${x.c}">${x.k}</b> ${esc(x.n)}</td><td>${money(d.p[x.k][0])}</td>${d.stt ? `<td>${d.p[x.k][1] != null ? money(d.p[x.k][1]) : '—'}</td>` : ''}${sv ? `<td>${d.p[x.k][2] != null ? money(d.p[x.k][2]) : '—'}</td>` : ''}</tr>`).join('')}</tbody></table>` : ''}
      </div>
    </div>
    ${copies.err ? `<div class="db-note">Couldn't reach the server's database: ${esc(copies.err)}</div>` : ''}
    <h2 class="db-h2">Every copy${all.length ? ` <span class="muted">(${all.length.toLocaleString()})</span>` : ''}</h2>
    ${all.length ? `<div class="toolbar">
      ${skin ? `<div class="seg" data-cats>${[['all', 'All'], ['n', 'Normal'], ...(d.stt ? [['st', 'StatTrak™']] : []), ...(sv ? [['sv', 'Souvenir']] : [])].map(([k, n]) => `<button data-v="${k}" class="${view.copyCat === k ? 'active' : ''}">${n}${k !== 'all' ? ` <span class="dim">${cats[k]}</span>` : ''}</button>`).join('')}</div>
        ${!d.v ? `<select class="input" data-wear><option value="all">All wears</option>${WEARS.filter((x) => d.p[x.k]).map((x) => `<option value="${x.k}" ${view.wear === x.k ? 'selected' : ''}>${x.n}</option>`).join('')}</select>` : ''}
        <select class="input" data-csort>${COPY_SORTS.map(([k, n]) => `<option value="${k}" ${view.copySort === k ? 'selected' : ''}>${n}</option>`).join('')}</select>` : ''}
      <input class="input" type="search" data-owner placeholder="Owner…" value="${esc(view.owner)}">
      <span class="spacer"></span><span class="muted">${rows.length.toLocaleString()} shown</span></div>
    <div class="db-table-wrap"><table class="price-table db-table"><thead><tr>${skin ? '<th>Float rank</th><th>Float</th><th>Seed</th>' : ''}<th>Item</th><th>Owner</th><th>Value</th><th></th></tr></thead><tbody>
      ${shownRows.map((c, i) => copyRow(c, i, skin, ranks)).join('')}</tbody></table></div>
    ${rows.length > shownRows.length ? `<div class="muted" style="margin-top:8px">Showing the first ${shownRows.length} of ${rows.length.toLocaleString()}.</div>` : ''}`
    : `<div class="empty" style="padding:30px">${online() ? 'Nobody on the server has one yet.' : "You don't have one. Log in to a server to see other players' copies."}</div>`}
    ${e.t === 'sticker' && copies.applied?.length ? `<h2 class="db-h2">Applied to guns <span class="muted">(${copies.applied.length.toLocaleString()})</span></h2>
      <div class="db-table-wrap"><table class="price-table db-table"><thead><tr><th>Gun</th><th>Float</th><th>Owner</th><th>Value</th><th></th></tr></thead><tbody>
      ${copies.applied.slice(0, 300).map((c, i) => `<tr><td>${esc(I.itemName(c.item))}</td><td>${c.item.fl != null ? c.item.fl.toFixed(6) : '—'}</td><td>${ownerCell(c)}</td><td>${money(I.itemValue(c.item))}</td><td><button class="btn sm" data-ainsp="${i}">Inspect</button></td></tr>`).join('')}</tbody></table></div>` : ''}
    ${skin && listings.length ? `<h2 class="db-h2">For sale on the Market now <span class="muted">(${listings.length})</span></h2>
      <div class="db-table-wrap"><table class="price-table db-table"><thead><tr><th>Float</th><th>Seed</th><th>Item</th><th>Price</th><th></th></tr></thead><tbody>
      ${listings.map((l, i) => `<tr><td>${floatCell(l.item)}</td><td>${l.item.sd ?? '—'}</td><td>${itemCell(l.item)}</td><td>${money(l.p)}</td><td><button class="btn sm" data-linsp="${i}">Inspect</button></td></tr>`).join('')}</tbody></table></div>` : ''}
  </div>`;
  root.querySelector('[data-back]').addEventListener('click', back);
  root.querySelector('[data-inspect]')?.addEventListener('click', () => {
    const it = e.t === 'skin' ? I.makeSkinItem(d, { stt: false, fl: d.v ? null : Math.min(d.mx, Math.max(d.mn, 0.02)), sd: 0 }) : e.t === 'sticker' ? I.makeStickerItem(d) : I.makeAgentItem(d);
    openInspect(it);
  });
  root.querySelectorAll('[data-cats] button').forEach((b) => b.addEventListener('click', () => { view.copyCat = b.dataset.v; draw(); }));
  root.querySelector('[data-wear]')?.addEventListener('change', (ev) => { view.wear = ev.target.value; draw(); });
  root.querySelector('[data-csort]')?.addEventListener('change', (ev) => { view.copySort = ev.target.value; draw(); });
  const own = root.querySelector('[data-owner]');
  own?.addEventListener('input', debounce(() => { view.owner = own.value.toLowerCase().trim(); draw(); const n = root?.querySelector('[data-owner]'); n?.focus(); n?.setSelectionRange(n.value.length, n.value.length); }, 220));
  root.querySelectorAll('[data-cinsp]').forEach((b) => b.addEventListener('click', () => inspectCopy(shownRows[+b.dataset.cinsp].item)));
  root.querySelectorAll('[data-ainsp]').forEach((b) => b.addEventListener('click', () => inspectCopy(copies.applied[+b.dataset.ainsp].item)));
  root.querySelectorAll('[data-linsp]').forEach((b) => b.addEventListener('click', () => inspectCopy(listings[+b.dataset.linsp].item)));
}

const floatCell = (it) => (it.fl == null ? '—' : `<span class="db-float"><b class="wk" style="--wc:${WEAR_BY_KEY[wearOf(it.fl)].c}">${wearOf(it.fl)}</b>${it.fl.toFixed(8)}<i class="floatline"><i style="left:${it.fl * 100}%"></i></i></span>`);
const itemCell = (it) => {
  const pat = I.patternInfo(it);
  return `<span class="db-name ${it.stt ? 'stt' : it.sv ? 'sv' : ''}">${it.stt ? 'StatTrak™' : it.sv ? 'Souvenir' : 'Normal'}</span>${pat.label ? ' ' + patternTag(pat) : ''}${it.sn ? ` <span class="tag sn" title="Serial number">#${it.sn}</span>` : ''}
    ${it.stk?.length ? `<span class="db-stk">${it.stk.map((s) => `<img src="${imgUrl(D.stickers[s.id]?.img, 's')}" title="${esc(D.stickers[s.id]?.n || '')}" alt="">`).join('')}</span>` : ''}`;
};
const ownerCell = (c) => `<span class="db-owner ${c.me ? 'me' : ''}">${esc(c.owner)}${c.me ? ' <span class="dim">(you)</span>' : ''}</span>`;
function copyRow(c, i, skin, ranks) {
  const it = c.item, r = ranks.get(it.uid);
  return `<tr class="${r ? 'ranked' : ''}">${skin ? `<td class="db-ranks">${rankBadges(r, copyCategory(it))}</td><td>${floatCell(it)}</td><td>${it.sd ?? '—'}</td>` : ''}
    <td>${skin ? itemCell(it) : esc(I.itemName(it))}</td><td>${ownerCell(c)}</td><td>${money(I.itemValue(it))}</td>
    <td>${it.t !== 'pro' ? `<button class="btn sm" data-cinsp="${i}">Inspect</button>` : ''}</td></tr>`;
}

function inspectCopy(item) {
  try { openInspect({ ...item, uid: 'db-' + item.uid }); } catch (e) { toast("Couldn't inspect that item: " + esc(e.message), 'bad'); }
}

function back() { view.key = null; copies = null; copiesKey = null; draw(); }
