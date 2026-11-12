// Item Database, like CSFloat's: search every item in the game (skins, knives, gloves, stickers, agents, pro cards) and
// open one to see every copy that exists: who has it, its float, wear, pattern and stickers, and its float rank (the
// three lowest and three highest floats of the item, counted apart for StatTrak™ and Souvenir copies). Online that's
// everyone on the server; offline, you and the NPC players (engine/npcs.js). Click an owner to visit their profile. A
// skin's current Market listings show under its copies.
// A skin's copies sort by pattern (paint seed) too, and each shows how many copies of the skin share its pattern (×N, in
// the category picked: counted over every copy, not only the rows shown); the pattern box shows only one pattern's copies.
// (Online, an item with more copies than the server sends at once, 5,000, comes with the counts of every copy and the
// copies at both ends of each category's floats, so its float records and ranks are among them; the page says so.)
// Float records (the main view's "Lowest floats" and "Highest floats"): the copies with the lowest and highest floats of
// any skin in the game, every skin together, by category. Online the server works them out over every player (db.floats,
// server/dbfloats.mjs); offline, over what the database shows (floatRecords).
import { esc, money, imgUrl, debounce } from '../util.js';
import { D, WEARS, wearOf, WEAR_BY_KEY } from '../data.js';
import * as I from '../items.js';
import { S, on } from '../state.js';
import { act, online } from '../backend.js';
import { worldCopies, crowd } from '../engine/npcs.js';
import { ownedItems } from '../engine/storage.js';
import { openPerson } from './community.js';
import { openProfile } from './community-online.js';
import { openInspect, patternTag, toast, creatorHTML } from '../ui.js';
import { net } from '../net/online.js';
import { marketWindow, skinListings, localSold, lowestPrice } from '../engine/market.js';
import { floatRanks, countCopies, copyCategory, CATEGORY_NAME, itemKey, floatRecords, FLOAT_TOP, patternCounts, patternCount, byPattern } from '../engine/database.js';

const PAGE = 60;
const TYPES = [['all', 'All items'], ['skin', 'Weapon skins'], ['knife', 'Knives'], ['gloves', 'Gloves'], ['sticker', 'Stickers'], ['charm', 'Charms'], ['agent', 'Agents'], ['badge', 'Badges'], ['tool', 'Tools']];
const WEAPON_CATS = [['all', 'All weapons'], ['rifle', 'Rifles'], ['pistol', 'Pistols'], ['smg', 'SMGs'], ['heavy', 'Heavy']];
const SORTS = [['owned', 'Most copies'], ['pricey', 'Price: high → low'], ['cheap', 'Price: low → high'], ['rarity', 'Rarity'], ['name', 'Name']];
const COPY_SORTS = [['low', 'Float: low → high'], ['high', 'Float: high → low'], ['pattern', 'Pattern: low → high'], ['value', 'Value'], ['new', 'Newest']];
// Float records: which end, which copies, how many.
const REC_DIRS = [['low', 'Lowest floats'], ['high', 'Highest floats']];
const REC_CATS = [['all', 'All'], ['n', 'Normal'], ['st', 'StatTrak™'], ['sv', 'Souvenir']];
const REC_TOPS = [50, FLOAT_TOP];
const REC_MS = 15000; // (online, a list is asked for again after this: the server keeps its own about as long)
const view = { type: 'all', cat: 'all', q: '', sort: 'owned', owned: false, page: 0, key: null, copyCat: 'all', wear: 'all', copySort: 'low', owner: '', pattern: null, patText: '',
  rec: null, recCat: 'all', recTop: FLOAT_TOP };
// The pattern box's number: 0 to 1000 (a leading # allowed); null for anything else, which filters nothing.
const patternOf = (s) => { const m = /^#?\s*(\d{1,4})$/.exec(s); return m && +m[1] <= 1000 ? +m[1] : null; };
let root, offs = [], index = null, indexAt = 0, copies = null, copiesKey = null, loading = false;
let recs = null, recsReq = null; // (the float records shown, and the request they're from: { key, at })

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
  for (const c of Object.values(D.charms)) add('charm', c, 'charm', `Charm · ${(D.charmColById[c.col]?.n || '').replace(' Charm Collection', '')}`, c.n.replace('Charm | ', ''), c.p);
  for (const a of Object.values(D.agents)) { const [n, f] = a.n.split(' | '); add('agent', a, 'agent', f || 'Agent', n, a.p); }
  for (const t of Object.values(I.TOOLS)) add('tool', t, 'tool', 'Tool', t.n, t.p);
  // Every one of CS2's collectibles (engine/badges.js): the pins from capsules, and the rest nobody can get.
  for (const b of Object.values(D.badges || {})) add('badge', b, 'badge', b.ty || 'Badge', I.nameParts({ t: 'badge', id: b.id }).bottom, b.p);
  return (CATALOG = out);
}
let BY_KEY = null;
const entryOf = (key) => (BY_KEY ||= new Map(catalog().map((e) => [e.key, e]))).get(key);
// An entry's picture (tools' come with the game).
const pictureOf = (e, size) => (e.t === 'tool' ? I.itemImage({ t: e.t, id: e.id }, size) : imgUrl(e.img, size));

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
  offs = [on('state', () => { if (!online()) offlineChanged(); })];
  index = null;
  recsReq = null;
  copiesKey = null; // (an item left open is read again: its owners may be from before you logged in)
  draw();
}
export function destroy() { offs.forEach((o) => o()); offs = []; root = null; }

// Offline, after anything changed (an action, the NPC players' tick): what's on screen is worked out again and drawn over
// what's there (no "Looking up…" in between), the box being typed in kept as it was.
function offlineChanged() {
  if (!root) return;
  recsReq = null;
  if (view.key) {
    index = null;
    const k = view.key, e = entryOf(k);
    if (!e || loading || copiesKey !== k) return;
    loadCopies(e).then((r) => { if (root && view.key === k && copiesKey === k && !loading) { copies = r; keepFocus(draw); } });
  } else if (view.rec) { index = null; draw(); } // (the list on screen stays until the new one is worked out)
  else loadIndex().then(() => { if (root && !view.key && !view.rec) keepFocus(draw); });
}
// Redraws, giving the box being typed in back as it was: focused, its caret, and what's typed but not yet applied.
const BOXES = ['.db-search', '[data-pattern]', '[data-owner]'];
function keepFocus(redraw) {
  const a = document.activeElement, sel = a && root?.contains(a) ? BOXES.find((s) => a.matches(s)) : null;
  const was = sel && { value: a.value, start: a.selectionStart, end: a.selectionEnd };
  redraw();
  const n = sel && root?.querySelector(sel);
  if (!n) return;
  n.value = was.value;
  n.focus();
  try { n.setSelectionRange(was.start, was.end); } catch { /* (a box that has no caret) */ }
}

// Offline, everything the NPC players own (and yours): [{ owner, npc | me, item }].
const offlineCopies = () => [...ownedItems(S).map((item) => ({ owner: S.social?.me?.name || 'You', me: true, item })), ...worldCopies(S.social)];

// How many copies of each item there are: the server's count online (refreshed every so often), offline yours and the
// NPC players'.
async function loadIndex() {
  if (!online()) {
    if (!S.social) await act('npc.tick').catch(() => {});
    index = { counts: countCopies(offlineCopies()), players: S.social ? crowd(S.social.seed).length + 1 : 1 };
    return;
  }
  if (index && Date.now() - indexAt < 20000) return;
  try { index = await net.social('db.index'); indexAt = Date.now(); } catch (e) { index = { counts: {}, players: 0, err: e.message }; }
}

// Every copy of one item: [{ owner, me, item }], and for a sticker the guns it's applied to.
async function loadCopies(e) {
  if (!online()) {
    const all = offlineCopies();
    return { copies: all.filter((c) => itemKey(c.item) === e.key), applied: e.t === 'sticker' ? all.filter((c) => c.item.stk?.some((s) => s.id === e.id)) : [] };
  }
  return net.social('db.item', { t: e.t, id: e.id });
}

// The copies with the lowest or highest floats of any skin: { copies: [{ owner, me, item }] }, best first, FLOAT_TOP of them.
async function loadRecords(dir, cat) {
  if (!online()) {
    if (!S.social) await act('npc.tick').catch(() => {});
    return { copies: floatRecords(offlineCopies(), { dir, cat }) };
  }
  return net.social('db.floats', { dir, cat, limit: FLOAT_TOP });
}

function draw() {
  if (!root) return;
  if (view.key) return drawItem();
  if (view.rec) return drawRecords();
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
      <span class="spacer"></span><span class="chip">${index.players.toLocaleString()} players ${online() ? 'on the server' : 'offline (you and the NPC traders)'} · ${total.toLocaleString()} copies of ${kinds.toLocaleString()} items</span></div>
    ${index.err ? `<div class="db-note">Couldn't reach the server's database: ${esc(index.err)}</div>` : !online() ? '<div class="db-note">Offline, the database shows your items and every NPC player\'s. Open an item and click an owner to visit their profile and inventory.</div>' : ''}
    <div class="toolbar">
      <input class="input db-search" type="search" placeholder="Search ${catalog().length.toLocaleString()} items… (e.g. ak redline, karambit fade, howl)" value="${esc(view.q)}">
      <select class="input" data-type>${TYPES.map(([k, n]) => `<option value="${k}" ${view.type === k ? 'selected' : ''}>${n}</option>`).join('')}</select>
      ${view.type === 'skin' ? `<select class="input" data-cat>${WEAPON_CATS.map(([k, n]) => `<option value="${k}" ${view.cat === k ? 'selected' : ''}>${n}</option>`).join('')}</select>` : ''}
      <select class="input" data-sort>${SORTS.map(([k, n]) => `<option value="${k}" ${view.sort === k ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <label class="check"><input type="checkbox" data-owned ${view.owned ? 'checked' : ''}> Owned by someone</label>
      <div class="seg db-rec-seg" title="Float records: the copies with the lowest and highest floats of any skin in the game">${REC_DIRS.map(([k, n]) => `<button data-rec="${k}">${k === 'low' ? '▼' : '▲'} ${n}</button>`).join('')}</div>
      <span class="spacer"></span><span class="muted">${list.length.toLocaleString()} items</span>
    </div>
    ${shown.length ? `<div class="grid">${shown.map((e) => `<div class="card db-card" data-key="${esc(e.key)}" style="--rc:${e.rc}">
      <div class="img"><img loading="lazy" src="${pictureOf(e, 'm')}" alt=""></div><div class="rbar"></div>
      <div class="meta"><div class="n1" title="${esc(e.top)}">${esc(e.top)}</div><div class="n2" title="${esc(e.bottom)}">${esc(e.bottom)}</div>
      <div class="row"><span class="wear">${esc(e.rn)}</span><span class="val">${e.t === 'badge' && !D.badges[e.id]?.tr ? '<span class="dim" style="font-weight:400" title="Nobody can get one, and it can’t be traded or sold">Not tradable</span>' : `${e.kind === 'skin' || e.kind === 'knife' || e.kind === 'gloves' ? '<span class="dim" style="font-weight:400">from</span> ' : ''}${money(e.price)}`}</span></div>
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
  // (from here, always every skin's record: a category is picked on the records page)
  root.querySelectorAll('[data-rec]').forEach((b) => b.addEventListener('click', () => { view.rec = b.dataset.rec; view.recCat = 'all'; root.scrollTop = 0; draw(); }));
}

// (o: the copies' filters and sort to open on, when not the usual ones)
function openItem(key, o = {}) {
  view.key = key; view.copyCat = 'all'; view.wear = 'all'; view.copySort = 'low'; view.owner = ''; view.pattern = null; view.patText = '';
  Object.assign(view, o);
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
    root.innerHTML = `<div class="page db"><div class="page-head"><button class="btn sm ghost" data-back>${backLabel()}</button><h1>${esc(e.bottom)}</h1></div><div class="empty">Looking up every copy…</div></div>`;
    root.querySelector('[data-back]').addEventListener('click', back);
    loading = true;
    loadCopies(e).then((r) => { copies = r; }).catch((err) => { copies = { copies: [], applied: [], err: err.message }; }).finally(() => { loading = false; if (root && view.key === e.key) draw(); });
    return;
  }
  if (loading || !copies) return;
  const d = I.itemDef({ t: e.t, id: e.id }), skin = e.t === 'skin', all = copies.copies || [];
  const sv = skin && (souvenirs(e.id) || all.some((c) => c.item.sv));
  // (online, an item with more copies than the server sends comes with the counts of every copy, and the copies at both
  // ends of each category's floats: its ranks and records are among those, out of every copy)
  const big = copies.counts || null, total = big ? big.total : all.length;
  const ranks = skin ? floatRanks(all) : new Map();
  if (big) for (const r of ranks.values()) r.of = big.cats[r.cat] || r.of;
  // How many copies share each pattern: over every copy (not only the rows shown), by category. A vanilla has none.
  const pats = skin && !d.v ? (big ? new Map(Object.entries(big.pats)) : patternCounts(all)) : null;
  const patternsHeld = pats ? [...pats.keys()].filter((k) => k.startsWith('all:')).length : 0;
  let rows = all.slice();
  if (view.copyCat !== 'all') rows = rows.filter((c) => copyCategory(c.item) === view.copyCat);
  if (view.wear !== 'all') rows = rows.filter((c) => c.item.fl != null && wearOf(c.item.fl) === view.wear);
  if (view.owner) rows = rows.filter((c) => c.owner.toLowerCase().includes(view.owner));
  if (pats && view.pattern != null) rows = rows.filter((c) => c.item.sd === view.pattern);
  const sorts = { low: (a, b) => (a.item.fl ?? 2) - (b.item.fl ?? 2), high: (a, b) => (b.item.fl ?? -1) - (a.item.fl ?? -1), pattern: (a, b) => byPattern(a.item, b.item),
    value: (a, b) => I.itemValue(b.item) - I.itemValue(a.item), new: (a, b) => (b.item.at || 0) - (a.item.at || 0) };
  rows.sort(sorts[skin ? view.copySort : view.copySort === 'value' ? 'value' : 'new']);
  const cats = big ? { ...big.cats } : { n: 0, st: 0, sv: 0 };
  if (!big) for (const c of all) cats[copyCategory(c.item)]++;
  const owners = big ? big.owners : new Set(all.map((c) => c.owner)).size;
  const floats = all.map((c) => c.item.fl).filter((f) => f != null);
  const col = skin && d.col ? D.collections.find((c) => c.id === d.col)?.n : null;
  const badge = e.t === 'badge', bound = badge && !d?.tr; // (a badge: a capsule's pin, or one nobody can get: engine/badges.js)
  const from = skin || badge ? sourcesOf(e.id) : [];
  const w = marketWindow(now()), sold = skin ? soldFor(w) : null;
  const listings = skin ? skinListings(d, w).filter((l) => !sold.has(l.lid)).sort((a, b) => a.item.fl - b.item.fl) : [];
  const priceRows = skin && !d.v ? WEARS.filter((x) => d.p[x.k]) : [];
  const shownRows = rows.slice(0, 500);
  root.innerHTML = `<div class="page db">
    <div class="page-head"><button class="btn sm ghost" data-back>${backLabel()}</button><h1>${esc(e.bottom)}</h1><span class="sub">${esc(e.top)}</span></div>
    <div class="db-item">
      <div class="db-hero" style="--rc:${e.rc}"><img src="${pictureOf(e, 'l')}" alt=""><div class="rbar"></div>${e.t === 'tool' ? '' : '<button class="btn sm" data-inspect>Inspect</button>'}</div>
      <div class="db-facts">
        <div class="db-stats">
          <div><b>${total.toLocaleString()}</b><span>${total === 1 ? 'copy' : 'copies'}</span></div>
          <div><b>${owners.toLocaleString()}</b><span>${owners === 1 ? 'owner' : 'owners'}</span></div>
          ${skin && d.stt ? `<div><b class="st">${cats.st.toLocaleString()}</b><span>StatTrak™</span></div>` : ''}
          ${skin && sv ? `<div><b class="sv">${cats.sv.toLocaleString()}</b><span>Souvenir</span></div>` : ''}
          ${floats.length ? `<div><b>${Math.min(...floats).toFixed(6)}</b><span>lowest float</span></div><div><b>${Math.max(...floats).toFixed(6)}</b><span>highest float</span></div>` : ''}
          ${patternsHeld ? `<div title="How many different patterns its copies have"><b>${patternsHeld.toLocaleString()}</b><span>${patternsHeld === 1 ? 'pattern' : 'patterns'}</span></div>` : ''}
          ${e.t === 'sticker' ? `<div><b>${(copies.applied || []).length.toLocaleString()}</b><span>applied to guns</span></div>` : ''}
        </div>
        <dl class="db-dl">
          <dt>Rarity</dt><dd style="color:${e.rc}">${esc(e.rn)}</dd>
          ${skin && !d.v ? `<dt>Float range</dt><dd><div class="floatwrap"><div class="floatbar"><div class="range" style="left:${d.mn * 100}%;right:${(1 - d.mx) * 100}%"></div></div></div>${d.mn.toFixed(2)} – ${d.mx.toFixed(2)}</dd>` : ''}
          ${col ? `<dt>Collection</dt><dd>${esc(col)}</dd>` : ''}
          ${creatorHTML(d) ? `<dt>Made by</dt><dd>${creatorHTML(d)}</dd>` : ''}
          ${from.length ? `<dt>Found in</dt><dd>${from.slice(0, 6).map(esc).join(', ')}${from.length > 6 ? ` and ${from.length - 6} more` : ''}</dd>` : ''}
          ${d.t ? `<dt>Tournament</dt><dd>${esc(d.t)}</dd>` : ''}
          ${badge && d.desc ? `<dt>About</dt><dd>${esc(d.desc)}</dd>` : ''}
          ${badge ? `<dt>How to get one</dt><dd>${bound ? 'Nobody can: it’s here to look at. It can’t be traded or sold.' : 'Open its capsule (Cases, Pin Capsules), or buy one from a player. It trades and sells.'}</dd>` : ''}
          ${!priceRows.length ? `<dt>Price</dt><dd>${bound ? '<span class="muted">None: it can’t be sold</span>' : money(e.price)}</dd>` : ''}
        </dl>
        ${priceRows.length ? `<table class="price-table"><thead><tr><th>Wear</th><th>Price</th>${d.stt ? '<th>StatTrak™</th>' : ''}${sv ? '<th>Souvenir</th>' : ''}</tr></thead><tbody>
          ${priceRows.map((x) => `<tr><td><b class="wk" style="--wc:${x.c}">${x.k}</b> ${esc(x.n)}</td><td>${money(d.p[x.k][0])}</td>${d.stt ? `<td>${d.p[x.k][1] != null ? money(d.p[x.k][1]) : '—'}</td>` : ''}${sv ? `<td>${d.p[x.k][2] != null ? money(d.p[x.k][2]) : '—'}</td>` : ''}</tr>`).join('')}</tbody></table>` : ''}
      </div>
    </div>
    ${copies.err ? `<div class="db-note">Couldn't reach the server's database: ${esc(copies.err)}</div>` : ''}
    <h2 class="db-h2">Every copy${total ? ` <span class="muted">(${total.toLocaleString()})</span>` : ''}</h2>
    ${big ? `<div class="db-note">There are ${total.toLocaleString()} copies, more than the server sends at once. These are the ${all.length.toLocaleString()} with the ${skin ? 'lowest and highest floats' : 'oldest and newest'} in each category, so the list, its filters and its float figures cover them; the copy, owner, category${pats ? ', pattern (×N)' : ''} and float rank counts are of every copy.</div>` : ''}
    ${all.length ? `<div class="toolbar">
      ${skin ? `<div class="seg" data-cats>${[['all', 'All'], ['n', 'Normal'], ...(d.stt ? [['st', 'StatTrak™']] : []), ...(sv ? [['sv', 'Souvenir']] : [])].map(([k, n]) => `<button data-v="${k}" class="${view.copyCat === k ? 'active' : ''}">${n}${k !== 'all' ? ` <span class="dim">${cats[k]}</span>` : ''}</button>`).join('')}</div>
        ${!d.v ? `<select class="input" data-wear><option value="all">All wears</option>${WEARS.filter((x) => d.p[x.k]).map((x) => `<option value="${x.k}" ${view.wear === x.k ? 'selected' : ''}>${x.n}</option>`).join('')}</select>` : ''}
        <select class="input" data-csort>${COPY_SORTS.filter(([k]) => k !== 'pattern' || pats).map(([k, n]) => `<option value="${k}" ${view.copySort === k ? 'selected' : ''}>${n}</option>`).join('')}</select>` : ''}
      ${pats ? `<input class="input db-pat-in" type="search" inputmode="numeric" data-pattern placeholder="Pattern #" value="${esc(view.patText)}" title="A pattern number (0 to 1000): only the copies with it">` : ''}
      <input class="input" type="search" data-owner placeholder="Owner…" value="${esc(view.owner)}">
      <span class="spacer"></span><span class="muted">${rows.length.toLocaleString()} shown</span></div>
    ${pats && view.pattern != null ? patternSummary(pats, view.pattern, view.copyCat)
      : pats && view.patText ? `<div class="db-pat-sum"><span>“${esc(view.patText)}” isn't a pattern number: patterns go from 0 to 1000.</span><span class="spacer"></span><button class="btn sm ghost" data-patclear>Clear</button></div>` : ''}
    <div class="db-table-wrap"><table class="price-table db-table"><thead><tr>${skin ? `<th class="db-rank-col">Float rank</th><th>Float</th><th title="${pats ? `The pattern (paint seed), and how many ${view.copyCat === 'all' ? '' : CATEGORY_NAME[view.copyCat] + ' '}copies of this skin have it` : 'The pattern (paint seed)'}">Pattern</th>` : ''}<th>Item</th><th>Owner</th><th>Value</th><th></th></tr></thead><tbody>
      ${shownRows.length ? shownRows.map((c, i) => copyRow(c, i, skin, ranks, pats)).join('') : `<tr><td colspan="${skin ? 7 : 4}" class="muted">No copy matches these filters.</td></tr>`}</tbody></table></div>
    ${rows.length > shownRows.length ? `<div class="muted" style="margin-top:8px">Showing the first ${shownRows.length} of ${rows.length.toLocaleString()}.</div>` : ''}`
    : `<div class="empty" style="padding:30px">${online() ? 'Nobody on the server has one yet.' : 'Nobody has one yet.'}</div>`}
    ${e.t === 'sticker' && copies.applied?.length ? `<h2 class="db-h2">Applied to guns <span class="muted">(${copies.applied.length.toLocaleString()})</span></h2>
      <div class="db-table-wrap"><table class="price-table db-table"><thead><tr><th>Gun</th><th>Float</th><th>Owner</th><th>Value</th><th></th></tr></thead><tbody>
      ${copies.applied.slice(0, 300).map((c, i) => `<tr><td>${esc(I.itemName(c.item))}</td><td>${c.item.fl != null ? c.item.fl.toFixed(6) : '—'}</td><td>${ownerCell(c)}</td><td>${money(I.itemValue(c.item))}</td><td><button class="btn sm" data-ainsp="${i}">Inspect</button></td></tr>`).join('')}</tbody></table></div>` : ''}
    ${skin && listings.length ? `<h2 class="db-h2">For sale on the Market now <span class="muted">(${listings.length})</span></h2>
      <div class="db-table-wrap"><table class="price-table db-table"><thead><tr><th>Float</th><th>Pattern</th><th>Item</th><th>Price</th><th></th></tr></thead><tbody>
      ${listings.map((l, i) => `<tr><td>${floatCell(l.item)}</td><td>${l.item.sd ?? '—'}</td><td>${itemCell(l.item)}</td><td>${money(l.p)}</td><td><button class="btn sm" data-linsp="${i}">Inspect</button></td></tr>`).join('')}</tbody></table></div>` : ''}
  </div>`;
  root.querySelector('[data-back]').addEventListener('click', back);
  root.querySelector('[data-inspect]')?.addEventListener('click', () => {
    const it = e.t === 'skin' ? I.makeSkinItem(d, { stt: false, fl: d.v ? null : Math.min(d.mx, Math.max(d.mn, 0.02)), sd: 0 }) : e.t === 'sticker' ? I.makeStickerItem(d)
      : e.t === 'charm' ? I.makeCharmItem(d) : e.t === 'badge' ? I.makeBadgeItem(d) : I.makeAgentItem(d);
    openInspect(it);
  });
  root.querySelectorAll('[data-cats] button').forEach((b) => b.addEventListener('click', () => { view.copyCat = b.dataset.v; draw(); }));
  root.querySelector('[data-wear]')?.addEventListener('change', (ev) => { view.wear = ev.target.value; draw(); });
  root.querySelector('[data-csort]')?.addEventListener('change', (ev) => { view.copySort = ev.target.value; draw(); });
  const own = root.querySelector('[data-owner]');
  own?.addEventListener('input', debounce(() => { view.owner = own.value.toLowerCase().trim(); draw(); const n = root?.querySelector('[data-owner]'); n?.focus(); n?.setSelectionRange(n.value.length, n.value.length); }, 220));
  // The pattern box (a number 0 to 1000, kept as typed: anything else filters nothing and says so; empty shows every copy
  // again), and a copy's ×N, which shows its pattern's copies.
  const pat = root.querySelector('[data-pattern]');
  pat?.addEventListener('input', debounce(() => {
    view.patText = pat.value.trim();
    view.pattern = patternOf(view.patText);
    keepFocus(draw);
  }, 220));
  root.querySelectorAll('[data-pat]').forEach((b) => b.addEventListener('click', () => { view.pattern = Number(b.dataset.pat); view.patText = b.dataset.pat; draw(); }));
  root.querySelector('[data-patclear]')?.addEventListener('click', () => { view.pattern = null; view.patText = ''; draw(); });
  root.querySelector('[data-catall]')?.addEventListener('click', () => { view.copyCat = 'all'; draw(); });
  root.querySelectorAll('[data-cinsp]').forEach((b) => b.addEventListener('click', () => inspectCopy(shownRows[+b.dataset.cinsp].item)));
  bindOwners();
  root.querySelectorAll('[data-ainsp]').forEach((b) => b.addEventListener('click', () => inspectCopy(copies.applied[+b.dataset.ainsp].item)));
  root.querySelectorAll('[data-linsp]').forEach((b) => b.addEventListener('click', () => inspectCopy(listings[+b.dataset.linsp].item)));
}

// (dp: decimals; the float records show more, where the first eight are often zeros or nines)
const floatCell = (it, dp = 8) => (it.fl == null ? '—' : `<span class="db-float"><b class="wk" style="--wc:${WEAR_BY_KEY[wearOf(it.fl)].c}">${wearOf(it.fl)}</b>${it.fl.toFixed(dp)}<i class="floatline"><i style="left:${it.fl * 100}%"></i></i></span>`);
const itemCell = (it) => {
  const pat = I.patternInfo(it);
  return `<span class="db-name ${it.stt ? 'stt' : it.sv ? 'sv' : ''}">${it.stt ? 'StatTrak™' : it.sv ? 'Souvenir' : 'Normal'}</span>${pat.label ? ' ' + patternTag(pat) : ''}${it.sn ? ` <span class="tag sn" title="Serial number">#${it.sn}</span>` : ''}${I.nameTagHtml(it)}
    ${it.stk?.length ? `<span class="db-stk">${it.stk.map((s) => `<img src="${imgUrl(D.stickers[s.id]?.img, 's')}" title="${esc(D.stickers[s.id]?.n || '')}" alt="">`).join('')}</span>` : ''}`;
};
// An owner, as a link to their profile: an NPC's or yours offline, a player's online.
const ownerCell = (c) => {
  const to = c.npc ? `data-npc="${esc(c.npc)}"` : !online() ? 'data-npc="me"' : c.id != null ? `data-player="${esc(c.id)}"` : '';
  const name = `${esc(c.owner)}${c.me ? ' <span class="dim">(you)</span>' : ''}`;
  return to ? `<a href="#" class="db-owner ${c.me ? 'me' : 'other'}" ${to} title="Visit ${c.me ? 'your' : `${esc(c.owner)}'s`} profile">${name}</a>` : `<span class="db-owner ${c.me ? 'me' : ''}">${name}</span>`;
};
// A copy's pattern, and how many copies of its skin have it (in the category picked): ×N, which shows only those.
function patternCell(it, pats) {
  if (it.sd == null) return '—';
  const sd = esc(String(it.sd)), cat = view.copyCat, n = pats ? patternCount(pats, it, cat) : 0;
  if (!n) return `<span class="db-pat">${sd}</span>`;
  const of = cat === 'all' ? '' : CATEGORY_NAME[cat] + ' ';
  const say = n === 1 ? `The only ${of}copy of this skin with pattern ${sd}` : `${n.toLocaleString()} ${of}copies of this skin have pattern ${sd}`;
  return `<span class="db-pat">${sd}<button class="db-patn ${n > 1 ? 'dup' : ''}" data-pat="${sd}" title="${say}${view.pattern == null ? `: click to see only ${n === 1 ? 'it' : 'them'}` : ''}">×${n.toLocaleString()}</button></span>`;
}
// Above the copies while the pattern box has a number: how many copies of the skin have that pattern, by category. With
// a category picked (cat), that category's count first, then every category's, which it hides.
function patternSummary(pats, sd, cat = 'all') {
  const n = (k) => pats.get(k + ':' + sd) || 0, all = n('all');
  const by = ['n', 'st', 'sv'].filter((k) => n(k)), split = by.map((k) => `${n(k).toLocaleString()} ${CATEGORY_NAME[k]}`).join(', ');
  const have = (x, of = '') => `<b>${x.toLocaleString()}</b> ${of}${x === 1 ? 'copy' : 'copies'} of this skin ${x === 1 ? 'has' : 'have'} pattern <b>${sd}</b>`;
  let say;
  if (cat === 'all') say = all ? have(all) + (by.length > 1 || (by.length && by[0] !== 'n') ? ` (${split})` : '') : `No copy of this skin has pattern <b>${sd}</b>`;
  else {
    const mine = n(cat), name = CATEGORY_NAME[cat];
    say = mine ? have(mine, name + ' ') : `No ${name} copy of this skin has pattern <b>${sd}</b>`;
    if (all > mine) say += ` <span class="dim">·</span> ${all.toLocaleString()} in every category (${split}) <button class="btn sm ghost" data-catall>Show every category</button>`;
  }
  return `<div class="db-pat-sum"><span>${say}</span><span class="spacer"></span><button class="btn sm ghost" data-patclear>Show every pattern</button></div>`;
}
function copyRow(c, i, skin, ranks, pats) {
  const it = c.item, r = ranks.get(it.uid);
  return `<tr class="${r ? 'ranked' : ''}">${skin ? `<td class="db-rank-col"><div class="db-ranks">${rankBadges(r, copyCategory(it))}</div></td><td>${floatCell(it)}</td><td>${patternCell(it, pats)}</td>` : ''}
    <td>${skin ? itemCell(it) : esc(I.itemName(it))}</td><td>${ownerCell(c)}</td><td>${money(I.itemValue(it))}</td>
    <td>${it.t === 'tool' ? '' : `<button class="btn sm" data-cinsp="${i}">Inspect</button>`}</td></tr>`;
}

function inspectCopy(item) {
  try { openInspect({ ...item, uid: 'db-' + item.uid }); } catch (e) { toast("Couldn't inspect that item: " + esc(e.message), 'bad'); }
}

function back() { view.key = null; copies = null; copiesKey = null; draw(); }
// (an item opened from the float records goes back to them)
const backLabel = () => (view.rec ? '‹ Float records' : '‹ Item Database');

// Owners' links to their profiles, wherever a page has them.
function bindOwners() {
  root.querySelectorAll('[data-npc]').forEach((a) => a.addEventListener('click', (ev) => { ev.preventDefault(); openPerson(a.dataset.npc); }));
  root.querySelectorAll('[data-player]').forEach((a) => a.addEventListener('click', (ev) => { ev.preventDefault(); openProfile(+a.dataset.player); }));
}

// ---- float records: the lowest and highest floats of any skin --------------------------------------------------------
function drawRecords() {
  const dir = view.rec, key = `${online() ? 'on' : 'off'}|${dir}|${view.recCat}`;
  // (asked again when it's a different list or a while old; the one on screen stays until the answer comes)
  if (!recsReq || recsReq.key !== key || Date.now() - recsReq.at > REC_MS) {
    const req = recsReq = { key, at: Date.now() };
    loadRecords(dir, view.recCat).then((r) => ({ ...r, key }), (err) => ({ copies: [], err: err.message, key }))
      .then((r) => { if (recsReq !== req) return; recs = r; if (root && view.rec && !view.key) draw(); });
  }
  const head = `<div class="page-head"><button class="btn sm ghost" data-back>‹ Item Database</button><h1>Float records</h1>
    <span class="sub">The ${dir === 'low' ? 'lowest' : 'highest'} floats of any ${view.recCat === 'all' ? '' : CATEGORY_NAME[view.recCat] + ' '}skin ${online() ? 'on the server, every player\'s' : 'in the database (you and the NPC traders)'}, every skin together. Open one to see every copy of its skin.</span></div>`;
  const toGrid = () => { view.rec = null; draw(); };
  if (recs?.key !== key) {
    root.innerHTML = `<div class="page db">${head}<div class="empty">Looking through every skin…</div></div>`;
    root.querySelector('[data-back]').addEventListener('click', toGrid);
    return;
  }
  const list = (recs.copies || []).slice(0, view.recTop);
  root.innerHTML = `<div class="page db">${head}
    ${recs.err ? `<div class="db-note">Couldn't reach the server's database: ${esc(recs.err)}</div>` : ''}
    <div class="toolbar">
      <div class="seg" data-rdir>${REC_DIRS.map(([k, n]) => `<button data-v="${k}" class="${dir === k ? 'active' : ''}">${k === 'low' ? '▼' : '▲'} ${n}</button>`).join('')}</div>
      <div class="seg" data-rcat>${REC_CATS.map(([k, n]) => `<button data-v="${k}" class="${view.recCat === k ? 'active' : ''}">${n}</button>`).join('')}</div>
      <div class="seg" data-rtop>${REC_TOPS.map((n) => `<button data-v="${n}" class="${view.recTop === n ? 'active' : ''}">Top ${n}</button>`).join('')}</div>
      <span class="spacer"></span><span class="muted">${list.length.toLocaleString()} ${list.length === 1 ? 'copy' : 'copies'}</span>
    </div>
    ${list.length ? `${recordTop(list[0], dir)}
      <div class="db-table-wrap"><table class="price-table db-table db-rec-table"><thead><tr><th>#</th><th>Skin</th><th>Float</th><th>Pattern</th><th>Details</th><th>Owner</th><th>Value</th><th></th></tr></thead><tbody>
      ${list.map((c, i) => recordRow(c, i, dir)).join('')}</tbody></table></div>`
    : `<div class="empty" style="padding:30px">${recs.err ? '' : `No ${view.recCat === 'all' ? '' : CATEGORY_NAME[view.recCat] + ' '}skin with a float ${online() ? 'on the server' : 'in the database'} yet.`}</div>`}
  </div>`;
  root.querySelector('[data-back]').addEventListener('click', toGrid);
  root.querySelectorAll('[data-rdir] button').forEach((b) => b.addEventListener('click', () => { view.rec = b.dataset.v; draw(); }));
  root.querySelectorAll('[data-rcat] button').forEach((b) => b.addEventListener('click', () => { view.recCat = b.dataset.v; draw(); }));
  root.querySelectorAll('[data-rtop] button').forEach((b) => b.addEventListener('click', () => { view.recTop = +b.dataset.v; draw(); }));
  // (its skin's page opens on the same end and category, so the record is at the top of its copies)
  root.querySelectorAll('[data-key]').forEach((a) => a.addEventListener('click', (ev) => {
    ev.preventDefault(); openItem(a.dataset.key, { copySort: dir, copyCat: view.recCat });
  }));
  bindOwners();
  root.querySelectorAll('[data-rinsp]').forEach((b) => b.addEventListener('click', () => inspectCopy(list[+b.dataset.rinsp].item)));
}
const recordName = (e, it) => (e ? `${esc(e.top)} | ${esc(e.bottom)}` : esc(I.itemName(it)));
// The #1, big, above the list.
function recordTop(c, dir) {
  const it = c.item, e = entryOf(itemKey(it)), w = WEAR_BY_KEY[wearOf(it.fl)];
  const what = `${dir === 'low' ? 'Lowest' : 'Highest'} float of any ${view.recCat === 'all' ? '' : CATEGORY_NAME[view.recCat] + ' '}skin ${online() ? 'on the server' : 'in the database'}`;
  return `<div class="db-rec-top" style="--rc:${e?.rc || 'transparent'}">
    ${e ? `<a href="#" class="db-rec-img" data-key="${esc(e.key)}" title="Open ${recordName(e, it)}"><img src="${pictureOf(e, 'm')}" alt=""></a>` : ''}
    <div class="db-rec-what">
      <div><span class="fr ${dir} r1">#1</span> <span class="muted">${what}</span></div>
      <div class="db-rec-float">${it.fl.toFixed(14)}</div>
      <div class="db-rec-line">${e ? `<a href="#" class="db-recitem" data-key="${esc(e.key)}"><span>${recordName(e, it)}</span></a>` : recordName(e, it)}
        <span class="dim">·</span> <b class="wk" style="--wc:${w.c}">${w.k}</b> ${esc(w.n)} <span class="dim">·</span> Pattern ${it.sd != null ? esc(String(it.sd)) : '—'}
        <span class="dim">·</span> ${itemCell(it)} <span class="dim">·</span> ${ownerCell(c)}</div>
    </div></div>`;
}
function recordRow(c, i, dir) {
  const it = c.item, e = entryOf(itemKey(it)), n = i + 1, name = recordName(e, it);
  return `<tr class="${n === 1 ? 'db-rec1' : ''}"><td class="db-recn">${n <= 3 ? `<span class="fr ${dir} r${n}">#${n}</span>` : `#${n}`}</td>
    <td>${e ? `<a href="#" class="db-recitem" data-key="${esc(e.key)}" title="Open ${name}: every copy of it"><img loading="lazy" src="${pictureOf(e, 's')}" alt=""><span>${name}</span></a>` : name}</td>
    <td>${floatCell(it, 12)}</td><td>${it.sd != null ? esc(String(it.sd)) : '—'}</td><td>${itemCell(it)}</td><td>${ownerCell(c)}</td><td>${money(I.itemValue(it))}</td>
    <td><button class="btn sm" data-rinsp="${i}">Inspect</button></td></tr>`;
}
