import { esc, money, imgUrl, round2 } from '../util.js';
import { D, WEARS, casePrice, caseTiers, rarityColor, DOPPLER_PHASE_WEIGHT, collectionBox, eventShort, CASE_KINDS } from '../data.js';
import * as I from '../items.js';
import { S, save, emit } from '../state.js';
import { autoSellLabel, autoSellModal, autoSellRules } from '../autosell.js';
import { act } from '../backend.js';
import { sfx } from '../audio.js';
import { toast, openModal, itemCard, patternTag, sellItems, openInspect, showItemDetail, rarityOddsHTML } from '../ui.js';
import { renderChickenThumb } from '../chicken3d.js';
import { playCaseIntro } from '../caseintro.js';
import { BREED, HAT, chickenValue } from '../chickens.js';

const view = { mode: 'list', caseId: null, colId: null, filter: 'case', sort: 'new', q: '', qty: 1, major: 'all' };
const SKIN_KINDS = new Set(['case', 'souvenir', 'package', 'collection']);
let rootEl = null;

export function openCaseView(id) {
  view.mode = 'case';
  view.caseId = id;
  render(rootEl);
}
export function openCollectionView(id) {
  view.mode = 'collection';
  view.colId = id;
  render(rootEl);
}

export function render(root) {
  rootEl = root;
  if (view.mode === 'case' && D.caseById[view.caseId]) renderCase(root, D.caseById[view.caseId]);
  else if (view.mode === 'collection' && D.colById[view.colId]) renderCollection(root, D.colById[view.colId]);
  else renderList(root);
}

// ---- helpers -------------------------------------------------------------------------------
export function caseImage(c) {
  if (c.kind === 'chickens') return renderChickenThumb({ id: 'golden', hat: 'crown' });
  if (c.kind === 'agents') {
    const master = Object.values(D.agents).filter((a) => a.r === 5).sort((a, b) => b.p - a.p)[0];
    return imgUrl(master?.img, 'm');
  }
  return imgUrl(c.img, 'm');
}

function wearProbs(skin) {
  const out = {};
  for (const [[lo, hi], w] of I.FLOAT_BRACKETS) {
    const flo = skin.mn + lo * (skin.mx - skin.mn), fhi = skin.mn + hi * (skin.mx - skin.mn);
    for (const W of WEARS) {
      const ov = Math.max(0, Math.min(fhi, W.max) - Math.max(flo, W.min));
      if (ov > 0) out[W.k] = (out[W.k] || 0) + (w * ov) / Math.max(1e-9, fhi - flo);
    }
  }
  return out;
}
export function expectedSkin(skin, kind = 'case') {
  if (skin.v) return skin.p.V[0] * 0.9 + (skin.p.V[1] ?? skin.p.V[0]) * 0.1;
  const probs = wearProbs(skin);
  const stt = (kind === 'case' || skin.star) && skin.stt && skin.cat !== 'gloves' ? 0.1 : 0;
  let ev = 0;
  for (const [k, p] of Object.entries(probs)) {
    const row = skin.p[k];
    if (!row) continue;
    if (kind === 'souvenir') { ev += p * (row[2] ?? row[0]); continue; }
    ev += p * ((1 - stt) * row[0] + stt * (row[1] ?? row[0]));
  }
  return ev;
}
function priceRange(skin, kind = 'case') {
  if (skin.v) return [skin.p.V[0], skin.p.V[1] ?? skin.p.V[0]];
  const rows = Object.values(skin.p);
  const vals = kind === 'souvenir' ? rows.map((r) => r[2] ?? r[0]) : kind === 'case' ? rows.flatMap((r) => [r[0], r[1]].filter((x) => x != null)) : rows.map((r) => r[0]);
  return [Math.min(...vals), Math.max(...vals)];
}
const evCache = new Map();
export function caseEV(c) {
  const key = c.id + D.pricedAt;
  if (evCache.has(key)) return evCache.get(key);
  let ev = 0;
  if (c.kind === 'chickens') {
    const hatEV = HAT_EV();
    const tiers = [[2, 0.7992], [3, 0.1598], [4, 0.032], [5, 0.0064], [6, 0.0026]];
    for (const [r, w] of tiers) {
      const bs = c.pools[r].map((id) => BREED[id].v);
      ev += (w * bs.reduce((s, x) => s + x, 0)) / bs.length * hatEV * 1.03;
    }
  } else {
    const tiers = caseTiers(c);
    const tw = tiers.reduce((s, t) => s + t[1], 0);
    for (const [k, w] of tiers) {
      let avg;
      if (k === 'rare') {
        avg = c.rare.reduce((s, g) => {
          const ws = g.map((id) => (g.length > 1 ? DOPPLER_PHASE_WEIGHT[D.skins[id].ph] ?? 0.2 : 1));
          const t = ws.reduce((a, b) => a + b, 0);
          return s + g.reduce((a, id, i) => a + (ws[i] / t) * expectedSkin(D.skins[id], 'case'), 0);
        }, 0) / c.rare.length;
      } else {
        const ids = c.pools[k];
        const val = (id) => (SKIN_KINDS.has(c.kind) ? expectedSkin(D.skins[id], c.kind) : c.kind === 'agents' ? D.agents[id].p : D.stickers[id].p);
        avg = ids.reduce((s, id) => s + val(id), 0) / ids.length;
      }
      ev += (w / tw) * avg;
    }
  }
  evCache.set(key, ev);
  return ev;
}
function HAT_EV() {
  const tw = Object.values(HAT).reduce((s, h) => s + h.w, 0);
  return Object.values(HAT).reduce((s, h) => s + (h.w / tw) * h.m, 0);
}

// ---- case list -----------------------------------------------------------------------------
const FILTERS = [['case', 'Weapon Cases'], ['souvenir', 'Souvenir Packages'], ['package', 'Packages'], ['collection', 'Collections'],
  ['capsule', 'Sticker Capsules'], ['autograph', 'Autograph Capsules'], ['special', 'Agents & Chickens']];
const majors = () => [...new Set(D.cases.filter((c) => c.kind === 'souvenir').map((c) => c.ev))].sort((a, b) => b - a);

function renderList(root) {
  if (view.filter === 'collection') return renderCollections(root);
  const list = D.cases.filter((c) => {
    if (view.filter === 'special') return c.custom;
    if (view.filter === 'souvenir' && view.major !== 'all' && String(c.ev) !== view.major) return false;
    return c.kind === view.filter;
  }).filter((c) => !view.q || c.n.toLowerCase().includes(view.q));
  const sorters = {
    new: (a, b) => (b.date || '').localeCompare(a.date || ''),
    old: (a, b) => (a.date || '').localeCompare(b.date || ''),
    cheap: (a, b) => casePrice(a) - casePrice(b),
    pricey: (a, b) => casePrice(b) - casePrice(a),
    ev: (a, b) => caseEV(b) / casePrice(b) - caseEV(a) / casePrice(a),
  };
  list.sort(sorters[view.sort]);
  root.innerHTML = `<div class="page">
    <div class="page-head"><h1>Cases</h1><span class="sub">Real CS2 drop odds · prices from Skinport, CSFloat, Buff163 & YouPin</span></div>
    <div class="toolbar">
      <div class="seg" data-k="filter">${FILTERS.map(([k, n]) => `<button data-v="${k}" class="${view.filter === k ? 'active' : ''}">${n}</button>`).join('')}</div>
      <input class="input" type="search" placeholder="Search…" value="${esc(view.q)}">
      ${view.filter === 'souvenir' ? `<select class="input" data-k="major"><option value="all">All Majors</option>${majors().map((ev) => `<option value="${ev}" ${view.major === String(ev) ? 'selected' : ''}>${esc(eventShort(ev))}</option>`).join('')}</select>` : ''}
      <span class="spacer"></span>
      <select class="input" data-k="sort">
        ${[['new', 'Newest'], ['old', 'Oldest'], ['cheap', 'Cheapest'], ['pricey', 'Most expensive'], ['ev', 'Best return']].map(([k, n]) => `<option value="${k}" ${view.sort === k ? 'selected' : ''}>${n}</option>`).join('')}
      </select>
    </div>
    <div class="grid lg">${list.map(caseTile).join('') || '<div class="empty">No cases match.</div>'}</div>
  </div>`;
  root.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => { view.filter = b.dataset.v; renderList(root); }));
  root.querySelector('select[data-k=sort]').addEventListener('change', (e) => { view.sort = e.target.value; renderList(root); });
  root.querySelector('select[data-k=major]')?.addEventListener('change', (e) => { view.major = e.target.value; renderList(root); });
  const q = root.querySelector('input[type=search]');
  q.addEventListener('input', () => { view.q = q.value.toLowerCase(); renderList(root); q.focus(); q.setSelectionRange(q.value.length, q.value.length); });
  root.querySelectorAll('.case-tile').forEach((t) => t.addEventListener('click', () => openCaseView(t.dataset.id)));
}

function caseTile(c) {
  const price = casePrice(c);
  const ret = caseEV(c) / price;
  return `<div class="card case-tile" data-id="${c.id}" style="--rc:#f2b21b">
    <div class="img"><img loading="lazy" src="${caseImage(c)}" alt=""></div>
    <div class="meta">
      <div class="n2">${esc(c.n)}</div>
      <div class="row"><span class="price">${money(price)}</span><span class="key">${c.key ? `incl. ${money(D.keyPrice)} ${c.kind === 'package' ? 'decoder' : 'key'}` : 'no key needed'}</span></div>
      <div class="row"><span class="dim" style="font-size:11px">Return ≈ ${(ret * 100).toFixed(0)}%</span><span class="dim" style="font-size:11px">${c.kind === 'souvenir' ? esc(eventShort(c.ev)) : c.date ? c.date.slice(0, 4) : ''}</span></div>
    </div>
  </div>`;
}

// ---- collections -----------------------------------------------------------------------------
function colTopSkin(col) {
  const top = Math.max(...Object.keys(col.tiers).map(Number));
  return col.tiers[top].map((id) => D.skins[id]).sort((a, b) => expectedSkin(b, 'collection') - expectedSkin(a, 'collection'))[0];
}
function renderCollections(root) {
  const list = D.collections.filter((c) => !view.q || c.n.toLowerCase().includes(view.q) || Object.values(c.tiers).flat().some((id) => D.skins[id].n.toLowerCase().includes(view.q)));
  list.sort((a, b) => (view.sort === 'old' ? a.rel.localeCompare(b.rel) : view.sort === 'new' ? b.rel.localeCompare(a.rel) : expectedSkin(colTopSkin(b), 'collection') - expectedSkin(colTopSkin(a), 'collection')));
  root.innerHTML = `<div class="page">
    <div class="page-head"><h1>Collections</h1><span class="sub">Every CS2 collection. Get their skins from souvenir packages, the Armory, trade-ups and cases.</span></div>
    <div class="toolbar">
      <div class="seg" data-k="filter">${FILTERS.map(([k, n]) => `<button data-v="${k}" class="${view.filter === k ? 'active' : ''}">${n}</button>`).join('')}</div>
      <input class="input" type="search" placeholder="Search collections or skins…" value="${esc(view.q)}">
      <span class="spacer"></span>
      <select class="input" data-k="sort">${[['new', 'Newest'], ['old', 'Oldest'], ['pricey', 'Most valuable']].map(([k, n]) => `<option value="${k}" ${view.sort === k ? 'selected' : ''}>${n}</option>`).join('')}</select>
    </div>
    <div class="grid lg">${list.map((col) => {
      const top = colTopSkin(col);
      const n = Object.values(col.tiers).flat().length;
      return `<div class="card col-tile" data-col="${col.id}" style="--rc:${rarityColor(top.r)}">
        <div class="img"><img loading="lazy" src="${imgUrl(top.img, 'm')}" alt=""></div><div class="rbar"></div>
        <div class="meta"><div class="n2">${esc(col.n)}</div>
          <div class="row"><span class="dim" style="font-size:11px">${n} skins · ${esc(top.n)}</span></div>
          <div class="row"><span class="dim" style="font-size:11px">${col.packages.length ? col.packages.length + ' souvenir packages' : col.caseId ? 'Weapon case' : 'Armory / trade-ups'}</span><span class="dim" style="font-size:11px">${col.rel.slice(0, 4)}</span></div>
        </div></div>`;
    }).join('') || '<div class="empty">No collections match.</div>'}</div>
  </div>`;
  root.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => { view.filter = b.dataset.v; renderList(root); }));
  root.querySelector('select[data-k=sort]').addEventListener('change', (e) => { view.sort = e.target.value; renderList(root); });
  const q = root.querySelector('input[type=search]');
  q.addEventListener('input', () => { view.q = q.value.toLowerCase(); renderList(root); const n = root.querySelector('input[type=search]'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); });
  root.querySelectorAll('[data-col]').forEach((t) => t.addEventListener('click', () => openCollectionView(t.dataset.col)));
}

function renderCollection(root, col) {
  const box = collectionBox(col);
  const tiers = caseTiers(box);
  const tw = tiers.reduce((s, t) => s + t[1], 0);
  const keys = Object.keys(col.tiers).sort((a, b) => b - a);
  const pkgs = col.packages.map((id) => D.caseById[id]).filter(Boolean);
  const caseBox = col.caseId && D.caseById[col.caseId];
  root.innerHTML = `<div class="page">
    <div class="page-head"><button class="btn ghost" data-back>← Collections</button></div>
    <div class="case-hero">
      <img class="ci" src="${imgUrl(colTopSkin(col).img, 'm')}" alt="">
      <div>
        <div class="kicker">Collection${col.rel ? ' · ' + col.rel.slice(0, 4) : ''}</div>
        <h2>${esc(col.n)}</h2>
        <div class="muted" style="line-height:1.6;max-width:720px">${caseBox ? 'Drops from the ' + esc(caseBox.n) + ' (case odds there). Odds below are for souvenir packages' : 'Not in any weapon case: get it from the Armory when it’s featured, souvenir packages or trade-ups. Odds below are for Armory drops and souvenir packages'} (each rarity is 5× rarer than the one below).
          Trade up ten skins of one rarity from this collection to get the next rarity.${caseBox ? ' Five Covert skins from it can be traded up into a knife or gloves from the ' + esc(caseBox.n) + '.' : ''}</div>
        <div class="open-row">
          ${caseBox ? `<button class="btn gold" data-case="${caseBox.id}">Open ${esc(caseBox.n)}</button>` : ''}
          ${caseBox ? '' : '<button class="btn" data-go="armory">Armory</button>'}
          <button class="btn" data-go="tradeup">Trade Up</button>
        </div>
        <div class="odds">${rarityOddsHTML(box, tiers)}</div>
      </div>
    </div>
    <div class="section-title">Skins</div>
    <div class="grid">${keys.map((k) => {
      const w = (tiers.find((t) => t[0] === k)?.[1] || 0) / tw;
      return col.tiers[k].map((id) => defTile('collection', id, w / col.tiers[k].length)).join('');
    }).join('')}</div>
    ${pkgs.length ? `<div class="section-title">Souvenir packages (${pkgs.length})</div><div class="grid lg">${pkgs.map(caseTile).join('')}</div>` : ''}
  </div>`;
  root.querySelector('[data-back]').addEventListener('click', () => { view.mode = 'list'; view.filter = 'collection'; render(root); });
  root.querySelector('[data-case]')?.addEventListener('click', (e) => openCaseView(e.currentTarget.dataset.case));
  root.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => document.querySelector(`#nav [data-page=${b.dataset.go}]`)?.click()));
  root.querySelectorAll('.case-tile').forEach((t) => t.addEventListener('click', () => openCaseView(t.dataset.id)));
  root.querySelectorAll('[data-prev]').forEach((t) => t.addEventListener('click', () => {
    const [, ids, odds] = t.dataset.prev.split('|');
    skinPreview(box, ids.split(','), +odds);
  }));
}

// ---- case view -----------------------------------------------------------------------------
function defTile(kind, id, oddsEach) {
  if (SKIN_KINDS.has(kind)) {
    const s = D.skins[id];
    const [lo, hi] = priceRange(s, kind);
    const [w, f] = s.n.split(' | ');
    return `<div class="card def" data-prev="skin|${id}|${oddsEach}" style="--rc:${rarityColor(s.r)}">
      <div class="img"><img loading="lazy" src="${imgUrl(s.img, 'm')}"></div><div class="rbar"></div>
      <div class="meta"><div class="n1">${esc(w)}</div><div class="n2">${esc(f || '')}</div>
      <div class="row"><span class="wear">${money(lo)} – ${money(hi)}</span><span class="dim">${(oddsEach * 100).toFixed(oddsEach < 0.001 ? 3 : 2)}%</span></div></div></div>`;
  }
  if (kind === 'chickens') {
    const b = BREED[id];
    return `<div class="card def" data-prev="chicken|${id}|${oddsEach}" style="--rc:${rarityColor(b.r)}">
      <div class="img"><img src="${renderChickenThumb({ id, hat: 'none' })}"></div><div class="rbar"></div>
      <div class="meta"><div class="n1">Chicken</div><div class="n2">${esc(b.n)}</div>
      <div class="row"><span class="wear">from ${money(chickenValue({ id, hat: 'none', fl: 0.5 }))}</span><span class="dim">${(oddsEach * 100).toFixed(2)}%</span></div></div></div>`;
  }
  const d = kind === 'agents' ? D.agents[id] : D.stickers[id];
  const parts = kind === 'agents' ? d.n.split(' | ') : [d.n.replace('Sticker | ', '')];
  return `<div class="card def" data-prev="${kind === 'agents' ? 'agent' : 'sticker'}|${id}|${oddsEach}" style="--rc:${rarityColor(d.r)}">
    <div class="img"><img loading="lazy" src="${imgUrl(d.img, 'm')}"></div><div class="rbar"></div>
    <div class="meta"><div class="n1">${esc(parts[1] || (kind === 'agents' ? 'Agent' : 'Sticker'))}</div><div class="n2" title="${esc(parts[0])}">${esc(parts[0])}</div>
    <div class="row"><span class="val">${money(d.p)}</span><span class="dim">${(oddsEach * 100).toFixed(oddsEach < 0.001 ? 3 : 2)}%</span></div></div></div>`;
}

function renderCase(root, c) {
  const price = casePrice(c);
  const ev = caseEV(c);
  const tiers = c.kind === 'chickens' ? [['2', 0.7992], ['3', 0.1598], ['4', 0.032], ['5', 0.0064], ['6', 0.0026]] : caseTiers(c);
  const tw = tiers.reduce((s, t) => s + t[1], 0);
  const keys = Object.keys(c.pools).sort((a, b) => b - a);
  const contents = keys.map((k) => {
    const w = (tiers.find((t) => t[0] === k)?.[1] || 0) / tw;
    return c.pools[k].map((id) => defTile(c.kind, id, w / c.pools[k].length)).join('');
  }).join('');
  const rareW = c.rare ? (tiers.find((t) => t[0] === 'rare')?.[1] || 0) / tw : 0;
  const rareTiles = c.rare ? c.rare.map((g) => {
    const s = D.skins[g[0]];
    const [w, f] = s.n.replace('★ ', '').split(' | ');
    const vals = g.flatMap((id) => priceRange(D.skins[id]));
    return `<div class="card def" data-prev="skin|${g.join(',')}|${rareW / c.rare.length}" style="--rc:${rarityColor(6)}">
      <div class="img"><img loading="lazy" src="${imgUrl(s.img, 'm')}"></div><div class="rbar"></div>
      <div class="meta"><div class="n1">★ ${esc(w)}</div><div class="n2">${esc(f || 'Vanilla')}${g.length > 1 ? ` <span class="dim">(${g.length} phases)</span>` : ''}</div>
      <div class="row"><span class="wear">${money(Math.min(...vals))} – ${money(Math.max(...vals))}</span><span class="dim">${((rareW / c.rare.length) * 100).toFixed(3)}%</span></div></div></div>`;
  }).join('') : '';

  root.innerHTML = `<div class="page">
    <div class="page-head"><button class="btn ghost" data-back>← All cases</button></div>
    <div class="case-hero">
      <img class="ci" src="${caseImage(c)}" alt="">
      <div>
        <div class="kicker">Unlock container · ${({ case: 'Weapon case', agents: 'Agent locker', chickens: 'Chicken crate', autograph: 'Autograph capsule', capsule: 'Sticker capsule', souvenir: 'Souvenir package', package: 'Package' })[c.kind] || ''}</div>
        <h2>${esc(c.n)}</h2>
        ${c.kind === 'souvenir' ? `<div class="muted" style="margin:-4px 0 10px">${esc(D.events[c.ev]?.n || '')} · every drop is a Souvenir with that Major's team stickers${D.events[c.ev] && Object.keys(D.events[c.ev].mvp).length ? ' and a gold MVP autograph' : ''}${c.col && D.colById[c.col] ? ` · <a href="#" data-col="${c.col}">${esc(D.colById[c.col].n)}</a>` : ''}</div>` : ''}
        ${c.kind === 'package' && c.col && D.colById[c.col] ? `<div class="muted" style="margin:-4px 0 10px"><a href="#" data-col="${c.col}">${esc(D.colById[c.col].n)}</a></div>` : ''}
        <div class="stats">
          <div>${c.kind === 'souvenir' || c.kind === 'package' ? 'Package' : 'Container'}<b>${money(c.price)}</b></div>
          ${c.key ? `<div>${c.kind === 'package' ? 'Decoder' : 'Key'}<b>${money(D.keyPrice)}</b></div>` : ''}
          <div>Total per open<b class="green">${money(price)}</b></div>
          <div>Expected value<b>${money(ev)}</b></div>
          <div>Return<b class="${ev >= price ? 'green' : 'red'}">${((ev / price) * 100).toFixed(1)}%</b></div>
        </div>
        <div class="open-row">
          <div class="seg" data-k="qty">${[1, 2, 3, 4, 5].map((n) => `<button data-v="${n}" class="${view.qty === n ? 'active' : ''}">×${n}</button>`).join('')}</div>
          <button class="btn gold big" data-open>Open for ${money(price * view.qty)}</button>
          <button class="btn big" data-autoopen title="Keep opening this case automatically">Auto open…</button>
          <label class="check"><input type="checkbox" data-fast ${S.settings.fast ? 'checked' : ''}> Fast open</label>
          <button class="btn sm ${autoSellRules().on ? 'primary' : ''}" data-autosell title="Sell new drops automatically by amount or rarity">${esc(autoSellLabel())}</button>
        </div>
        <div class="odds">${c.kind === 'chickens'
          ? tiers.map(([k, w]) => `<span style="--rc:${rarityColor(+k)}">${['', '', 'Barnyard', 'Free-Range', 'Prize', 'Legendary', '★ Mythic'][k]}: ${(w * 100).toFixed(2)}%</span>`).join('')
          : rarityOddsHTML(c, tiers)}</div>
      </div>
    </div>
    <div class="section-title">Contains one of the following</div>
    <div class="grid">${contents}${c.rare ? `<div class="card rare-tile" style="--rc:#e4ae39" data-scroll-rare><div class="img"><img class="rare-icon" src="img/rare-item.png" alt=""></div><div class="rbar"></div><div class="meta"><div class="n1">Exceedingly rare</div><div class="n2">★ Rare Special Item</div><div class="row"><span class="wear">${c.rareKind === 'gloves' ? 'Gloves' : c.rareKind === 'mixed' ? 'Knives & gloves' : 'Knives'}</span><span class="dim">${(rareW * 100).toFixed(2)}%</span></div></div></div>` : ''}</div>
    ${c.rare ? `<div class="section-title" id="rare-list">Rare special items (${c.rare.length})</div><div class="grid">${rareTiles}</div>` : ''}
    <p class="dim" style="margin-top:22px;font-size:12px">Tip: click any item for prices, odds and a 3D inspect.</p>
  </div>`;

  root.querySelector('[data-back]').addEventListener('click', () => { view.mode = 'list'; render(root); });
  root.querySelectorAll('[data-col]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openCollectionView(a.dataset.col); }));
  root.querySelectorAll('[data-k=qty] button').forEach((b) => b.addEventListener('click', () => { view.qty = +b.dataset.v; renderCase(root, c); }));
  root.querySelector('[data-fast]').addEventListener('change', (e) => { S.settings.fast = e.target.checked; save(); });
  root.querySelector('[data-autosell]').addEventListener('click', () => autoSellModal(() => renderCase(root, c)));
  root.querySelector('[data-open]').addEventListener('click', () => openCase(c, view.qty));
  root.querySelector('[data-autoopen]').addEventListener('click', () => autoOpenModal(c));
  root.querySelector('[data-scroll-rare]')?.addEventListener('click', () => root.querySelector('#rare-list').scrollIntoView({ behavior: 'smooth' }));
  root.querySelectorAll('[data-prev]').forEach((t) => t.addEventListener('click', () => {
    const [kind, ids, odds] = t.dataset.prev.split('|');
    showContentPreview(c, kind, ids.split(','), +odds);
  }));
}

// ---- preview popup for an item in a case's contents ------------------------------------------
const fmtOdds = (o) => (o * 100).toFixed(o < 0.001 ? 4 : o < 0.01 ? 3 : 2) + '%';

function showContentPreview(c, kind, ids, odds) {
  if (kind === 'skin') return skinPreview(c, ids, odds);
  const make = {
    sticker: () => I.makeStickerItem(D.stickers[ids[0]], c.n),
    agent: () => I.makeAgentItem(D.agents[ids[0]], c.n),
    chicken: () => ({ uid: 'preview', t: 'chicken', id: ids[0], hat: 'none', fl: 0.5, sd: 1, at: Date.now() }),
  }[kind];
  const item = make();
  const r = I.rarityInfo(item);
  const price = kind === 'chicken' ? `from ${money(chickenValue(item))}` : money(I.itemValue(item));
  const m = openModal({
    title: esc(I.nameParts(item).bottom),
    cls: 'wide',
    body: `<div class="detail" style="--rc:${r.c}">
      <div><div class="big"><img src="${I.itemImage(item, 'l')}" alt=""></div></div>
      <div>
        <h3>${esc(I.itemName(item))}</h3>
        <div class="rar">${esc(r.n)}</div>
        <dl class="kv">
          <dt>Drop chance</dt><dd>${fmtOdds(odds)}</dd>
          <dt>Market price</dt><dd class="green">${price}</dd>
          <dt>Found in</dt><dd>${esc(c.n)}</dd>
        </dl>
        <div class="actions"><button class="btn gold" data-a="inspect">Inspect in 3D</button><button class="btn ghost" data-close>Close</button></div>
      </div>
    </div>`,
  });
  m.el.querySelector('[data-a=inspect]').addEventListener('click', () => openInspect(make()));
}

const PHASE_ORDER = ['Phase 1', 'Phase 2', 'Phase 3', 'Phase 4', 'Ruby', 'Sapphire', 'Black Pearl', 'Emerald'];

function skinPreview(c, ids, odds) {
  ids = [...ids].sort((a, b) => PHASE_ORDER.indexOf(D.skins[a].ph) - PHASE_ORDER.indexOf(D.skins[b].ph));
  let idx = 0, wear = null, stt = false, seed = Math.floor(Math.random() * 1001);
  const m = openModal({ title: 'Case item', cls: 'wide', body: '' });
  const body = m.el.querySelector('.modal-body');
  const titleEl = m.el.querySelector('.modal-head h2');

  const draw = () => {
    const s = D.skins[ids[idx]];
    const wears = s.v ? [] : WEARS.filter((w) => s.p[w.k]);
    if (!s.v && (!wear || !s.p[wear])) wear = (wears.find((w) => w.k === 'FT') || wears[0]).k;
    const sv = c.kind === 'souvenir';
    const canStt = s.stt && s.cat !== 'gloves' && (c.kind === 'case' || s.star);
    if (!canStt) stt = false;
    const sample = I.makeSkinItem(s, { stt, sv, sd: seed, ...(s.v ? {} : { fl: I.rollFloatInWear(s, wear) }) });
    const pat = I.patternInfo(sample);
    const r = I.rarityInfo(sample);
    const np = I.nameParts(sample);
    titleEl.textContent = s.n + (s.ph ? ` (${s.ph})` : '');
    const rows = s.v
      ? [['Vanilla', s.p.V[0], canStt ? s.p.V[1] : null]]
      : wears.map((w) => [w.n, s.p[w.k][0], canStt ? s.p[w.k][1] : sv ? s.p[w.k][2] ?? null : null]);
    const col2 = canStt ? 'StatTrak™' : sv ? 'Souvenir' : '';
    const info = pat.info.map(([k, v]) => `${k}: ${v}`).join(' · ');
    body.innerHTML = `<div class="detail" style="--rc:${r.c}">
      <div>
        <div class="big"><img src="${imgUrl(s.img, 'l')}" alt=""></div>
        ${ids.length > 1 ? `<div class="phase-chips">${ids.map((id, i) => `<button class="btn sm ${i === idx ? 'gold' : ''}" data-phase="${i}">${esc(D.skins[id].ph || 'Default')}</button>`).join('')}</div>` : ''}
      </div>
      <div>
        <h3>${esc(np.top.replace('StatTrak™ ', ''))} | ${esc(np.bottom)}</h3>
        <div class="rar">${esc(r.n)}${s.ph ? ' · ' + esc(s.ph) : ''}</div>
        <dl class="kv">
          <dt>Drop chance</dt><dd>${fmtOdds(odds)}${ids.length > 1 ? ' <span class="dim">(all phases)</span>' : ''}</dd>
          ${s.v ? '' : `<dt>Float range</dt><dd>${s.mn.toFixed(2)} – ${s.mx.toFixed(2)}</dd>`}
          ${sv ? '<dt>Souvenir</dt><dd>Always (with match stickers)</dd>' : `<dt>StatTrak™</dt><dd>${canStt ? 'Available (10% of drops)' : 'Not available'}</dd>`}
          ${s.col && D.colById[s.col] ? `<dt>Collection</dt><dd>${esc(D.colById[s.col].n)}</dd>` : ''}
          <dt>Finish style</dt><dd>${esc(s.st || '—')}</dd>
        </dl>
        <table class="price-table">
          <tr><th>Exterior</th><th>Price</th>${col2 ? `<th>${col2}</th>` : ''}</tr>
          ${rows.map(([n, a, b]) => `<tr><td>${n}</td><td class="green">${money(a)}</td>${col2 ? `<td class="green">${b != null ? money(b) : '—'}</td>` : ''}</tr>`).join('')}
        </table>
        <div class="section-title">Inspect options</div>
        <div class="insp-opts">
          ${s.v ? '' : `<div class="seg" data-wear>${wears.map((w) => `<button data-v="${w.k}" class="${w.k === wear ? 'active' : ''}">${w.k}</button>`).join('')}</div>`}
          ${canStt ? `<label class="check"><input type="checkbox" data-stt ${stt ? 'checked' : ''}> StatTrak™</label>` : ''}
          ${s.v ? '' : `<label class="check">Pattern <input class="input" type="number" min="0" max="1000" value="${seed}" style="width:84px" data-seed></label>
          <button class="btn sm" data-a="rnd">Random</button>`}
        </div>
        ${pat.label ? `<div style="margin-top:8px">${patternTag(pat)} <span class="muted" style="font-size:12px">${info}</span></div>`
          : info ? `<div class="muted" style="margin-top:8px;font-size:12px">${info}</div>` : ''}
        <div class="actions"><button class="btn gold" data-a="inspect">Inspect in 3D</button><button class="btn ghost" data-a="close">Close</button></div>
      </div>
    </div>`;
    body.querySelectorAll('[data-phase]').forEach((b) => b.addEventListener('click', () => { idx = +b.dataset.phase; draw(); }));
    body.querySelectorAll('[data-wear] button').forEach((b) => b.addEventListener('click', () => { wear = b.dataset.v; draw(); }));
    body.querySelector('[data-stt]')?.addEventListener('change', (e) => { stt = e.target.checked; draw(); });
    body.querySelector('[data-seed]')?.addEventListener('change', (e) => { seed = Math.max(0, Math.min(1000, Math.round(+e.target.value) || 0)); draw(); });
    body.querySelector('[data-a=rnd]')?.addEventListener('click', () => { seed = Math.floor(Math.random() * 1001); draw(); });
    body.querySelector('[data-a=close]').addEventListener('click', () => m.close());
    body.querySelector('[data-a=inspect]').addEventListener('click', () => {
      const it = I.makeSkinItem(s, { stt, sv, sd: seed, ...(s.v ? {} : { fl: I.rollFloatInWear(s, wear) }) });
      if (sv) it.stk = I.souvenirStickers(c.ev);
      openInspect(it);
    });
  };
  draw();
}

// ---- opening -------------------------------------------------------------------------------
let opening = false;

// ---- auto open: keep opening a case until a limit or a stop condition ------------------------------
const AUTO_COUNTS = [10, 25, 50, 100, 250, 1000, 0]; // 0 = until stopped
const autoPrefs = { count: 25, stopAt: 0, stopGold: true, minBalance: 0, anim: false };
let autoRun = null;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function autoOpenModal(c) {
  if (autoRun) return toast('Auto open is already running.', 'bad');
  const n = view.qty, each = round2(casePrice(c) * n);
  const m = openModal({
    title: 'Auto open',
    body: `<div style="display:grid;gap:12px;max-width:560px">
      <div><b>${esc(c.n)}</b> · ×${n} per opening · <span class="green">${money(each)}</span> each</div>
      <label class="check" style="color:var(--text)">Openings <select class="input" data-count>${AUTO_COUNTS.map((k) => `<option value="${k}" ${autoPrefs.count === k ? 'selected' : ''}>${k ? k + ' (' + money(each * k) + ')' : 'Until I stop it'}</option>`).join('')}</select></label>
      <div class="panel" style="padding:12px 14px;display:grid;gap:8px">
        <h3 style="margin:0">Stop when</h3>
        <label class="check"><input type="checkbox" data-gold ${autoPrefs.stopGold ? 'checked' : ''}> I unbox a knife, gloves or another ★ item</label>
        <label class="check">I unbox something worth at least $ <input class="input" type="number" min="0" step="1" value="${autoPrefs.stopAt}" style="width:100px" data-stopat> <span class="dim">(0 = off)</span></label>
        <label class="check">My balance would drop below $ <input class="input" type="number" min="0" step="1" value="${autoPrefs.minBalance}" style="width:100px" data-minbal></label>
        <div class="muted" style="font-size:12px">It always stops when you can't afford the next opening.</div>
      </div>
      <label class="check"><input type="checkbox" data-anim ${autoPrefs.anim ? 'checked' : ''}> Show the case animation (fast)</label>
      <div class="open-row"><span class="muted">${esc(autoSellLabel())}</span><button class="btn sm" data-as>Auto-sell settings…</button></div>
      <div class="muted" style="font-size:12px">You can keep playing on other pages while it runs. Drops that aren't auto-sold go to your inventory.</div>
    </div>`,
    foot: '<button class="btn ghost" data-close>Cancel</button><button class="btn gold" data-start>Start</button>',
  });
  m.el.querySelector('[data-as]').addEventListener('click', () => autoSellModal(() => { m.close(); autoOpenModal(c); }));
  m.el.querySelector('[data-start]').addEventListener('click', () => {
    const q = (sel) => m.el.querySelector(sel);
    Object.assign(autoPrefs, {
      count: +q('[data-count]').value, stopGold: q('[data-gold]').checked, anim: q('[data-anim]').checked,
      stopAt: Math.max(0, +q('[data-stopat]').value || 0), minBalance: Math.max(0, +q('[data-minbal]').value || 0),
    });
    m.close();
    runAutoOpen(c, n, { ...autoPrefs });
  });
}

async function runAutoOpen(c, n, p) {
  if (opening || autoRun) return;
  opening = true;
  const run = (autoRun = { stop: false, done: 0, spent: 0, sold: 0, kept: [], best: null });
  const panel = document.createElement('div');
  panel.className = 'auto-panel';
  document.body.appendChild(panel);
  const draw = () => {
    const keptValue = run.kept.reduce((s, i) => s + I.itemValue(i), 0);
    panel.innerHTML = `<div style="display:flex;align-items:center;gap:10px"><b>Auto open</b><span class="muted" style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.n)}</span><span class="spacer"></span><button class="btn sm danger" data-stop>${run.stop ? 'Stopping…' : 'Stop'}</button></div>
      <div class="auto-stats"><div>Openings<b>${run.done}${p.count ? ' / ' + p.count : ''}</b></div><div>Spent<b>${money(run.spent)}</b></div>
      <div>Kept<b class="green">${money(keptValue)}</b></div><div>Auto-sold<b class="green">${money(run.sold)}</b></div></div>
      ${run.best ? `<div class="muted" style="font-size:12px">Best: <span style="color:${I.rarityInfo(run.best).c}">${esc(I.itemName(run.best))}</span> · ${money(I.itemValue(run.best))}</div>` : ''}`;
    panel.querySelector('[data-stop]').addEventListener('click', () => { run.stop = true; draw(); });
  };
  draw();
  let reason = p.count ? `Finished ${p.count} openings` : 'Stopped';
  const cost = round2(casePrice(c) * n);
  try {
    while (!run.stop && (!p.count || run.done < p.count)) {
      if (S.money + 1e-9 < cost) { reason = 'Not enough money for the next opening'; break; }
      if (S.money - cost < p.minBalance) { reason = `Your balance would drop below ${money(p.minBalance)}`; break; }
      let r;
      try { r = await act('case.open', { id: c.id, n, autoSell: autoSellRules() }); } catch (e) { reason = e.message; break; }
      run.done++;
      run.spent = round2(run.spent + r.cost);
      run.sold = round2(run.sold + (r.autoSold || 0));
      for (const it of r.items) {
        if (!it.as) run.kept.push(it);
        if (!run.best || I.itemValue(it) > I.itemValue(run.best)) run.best = it;
      }
      const top = Math.max(...r.items.map((i) => I.rarityRank(i)));
      if (p.anim) { sfx.open(); await playRoulette(c, r.items); } else { if (top >= 5) sfx.reveal(top); await wait(220); }
      if (top >= 6) sfx.gold();
      draw();
      const hit = r.items.find((i) => (p.stopGold && I.rarityRank(i) >= 6) || (p.stopAt > 0 && I.itemValue(i) >= p.stopAt));
      if (hit) { reason = `You unboxed ${I.itemName(hit)} (${money(I.itemValue(hit))})`; break; }
    }
    if (run.stop) reason = 'Stopped by you';
  } finally {
    panel.remove();
    opening = false;
    autoRun = null;
  }
  const keptValue = run.kept.reduce((s, i) => s + I.itemValue(i), 0);
  const net = keptValue + run.sold - run.spent;
  const top = [...run.kept].sort((a, b) => I.itemValue(b) - I.itemValue(a)).slice(0, 12);
  showResults(c, top, n, {
    cost: 0, again: () => autoOpenModal(c), againLabel: 'Auto open again',
    title: `Auto open: ${run.done} opening${run.done === 1 ? '' : 's'}`,
    summary: `<div class="summary" style="margin-bottom:14px"><div>Result<b>${esc(reason)}</b></div><div>Cases opened<b>${run.done * n}</b></div>
      <div>Spent<b>${money(run.spent)}</b></div><div>Kept<b class="green">${run.kept.length} · ${money(keptValue)}</b></div>
      <div>Auto-sold<b class="green">${money(run.sold)}</b></div><div>Net<b class="${net >= 0 ? 'green' : 'red'}">${money(net)}</b></div></div>
      ${top.length ? `<div class="muted" style="font-size:12px;margin-bottom:8px">Your best kept drops${run.kept.length > top.length ? ` (top ${top.length} of ${run.kept.length})` : ''}:</div>` : '<div class="muted">Every drop was auto-sold.</div>'}`,
  });
}

export async function openCase(c, n) {
  if (opening) return;
  const cost = round2(casePrice(c) * n);
  if (S.money + 1e-9 < cost) {
    sfx.error();
    toast(`You need <b>${money(cost)}</b> to open ${n > 1 ? n + ' of these' : 'this'}. Earn money on the <b>Earn</b> tab or sell items.`, 'bad');
    return;
  }
  opening = true;
  let r;
  try {
    // Rolled and saved (or rolled on the server) before the animation, so nothing is lost if the app closes.
    r = await act('case.open', { id: c.id, n, autoSell: autoSellRules() });
  } catch (e) {
    opening = false;
    sfx.error();
    toast(esc(e.message), 'bad');
    return;
  }
  const intro = S.settings.caseIntro !== false && c.kind !== 'chickens' && c.kind !== 'agents'
    ? (stage) => playCaseIntro(stage, c, caseImage(c)) : null;
  if (!intro) sfx.open();
  if (r.stars) toast(`+${r.stars} Armory Star${r.stars > 1 ? 's' : ''} for opening cases`, 'gold');
  try {
    await playRoulette(c, r.items, undefined, { intro });
  } finally {
    opening = false;
  }
  if (r.autoSold) toast(`Auto-sold ${r.items.filter((i) => i.as).length} item${r.items.filter((i) => i.as).length === 1 ? '' : 's'} for <b class="green">${money(r.autoSold)}</b>`, 'good');
  showResults(c, r.items, n);
}

function slotHTML(entry, showAll = false) {
  if (entry.t === 'rare-placeholder' || (!showAll && entry.t === 'skin' && D.skins[entry.id]?.star)) {
    return `<div class="slot rare" style="--rc:#e4ae39"><img class="rare-icon" src="img/rare-item.png" alt=""><div class="sn">★ Rare Special Item ★</div></div>`;
  }
  const r = I.rarityInfo(entry);
  const np = I.nameParts(entry);
  return `<div class="slot" style="--rc:${r.c}"><img src="${I.itemImage(entry, 's')}"><div class="sn">${esc(np.bottom)}</div></div>`;
}

const WIN_INDEX = 58, REEL_LEN = 66;
// `intro(stage)` (optional) plays first in the overlay and returns { done, skip } (see caseintro.js).
export function playRoulette(c, items, title = `Unlocking ${esc(c.n)}`, { intro = null } = {}) {
  return new Promise((resolve) => {
    const n = items.length;
    const ov = document.createElement('div');
    ov.className = 'opening' + (intro ? ' intro' : '');
    ov.innerHTML = `${intro ? '<div class="crate-stage"></div>' : ''}<h3>${title}</h3><div class="strips n${n}">${items.map(() => '<div class="strip"><div class="reel"></div><div class="marker"></div></div>').join('')}</div><div class="hint">Press SPACE or click to skip</div>`;
    document.body.appendChild(ov);
    const strips = [...ov.querySelectorAll('.strip')];
    const reels = strips.map((strip, si) => {
      const reel = strip.querySelector('.reel');
      // Containers can supply their own fillers (trade-ups, armory) and show gold items in the reel (showAll).
      const entries = Array.from({ length: REEL_LEN }, (_, i) => (i === WIN_INDEX ? items[si] : c.fake ? c.fake() : I.fakeRoll(c)));
      reel.innerHTML = entries.map((e) => slotHTML(e, c.showAll)).join('');
      return { strip, reel };
    });
    let skipAll = false;
    // measure after layout
    const spin = () => requestAnimationFrame(() => {
      const fast = S.settings.fast;
      const anims = reels.map(({ strip, reel }, si) => {
        const slot = reel.children[0];
        const slotW = slot.getBoundingClientRect().width + 6;
        const center = strip.clientWidth / 2;
        const jitter = (Math.random() - 0.5) * slotW * 0.8;
        const target = WIN_INDEX * slotW + (slotW - 6) / 2 + jitter - center;
        return { reel, slotW, center, target, dur: (fast ? 2400 : 6200) + si * (fast ? 120 : 350), lastIdx: -1, done: false };
      });
      const start = performance.now();
      const ease = (t) => 1 - Math.pow(1 - t, 4.4);
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        window.removeEventListener('keydown', onKey, true);
        for (const a of anims) a.reel.style.transform = `translateX(${-a.target}px)`;
        reels.forEach(({ reel }) => reel.children[WIN_INDEX].classList.add('win'));
        const best = Math.max(...items.map((i) => I.rarityRank(i)));
        sfx.reveal(best);
        setTimeout(() => { ov.remove(); resolve(); }, best >= 6 ? 1300 : 750);
      };
      const step = (now) => {
        if (finished) return;
        let allDone = true;
        anims.forEach((a, i) => {
          const t = Math.min(1, (now - start) / a.dur);
          const x = ease(t) * a.target;
          a.reel.style.transform = `translateX(${-x}px)`;
          if (i === 0) {
            const idx = Math.floor((x + a.center) / a.slotW);
            if (idx !== a.lastIdx) { a.lastIdx = idx; if (t < 1) sfx.tick(); }
          }
          if (t < 1) allDone = false;
        });
        if (allDone) finish();
        else requestAnimationFrame(step);
      };
      const onKey = (e) => { if (e.code === 'Space' || e.key === 'Escape') { e.preventDefault(); finish(); } };
      if (skipAll) return finish();
      requestAnimationFrame(step);
      window.addEventListener('keydown', onKey, true);
      ov.addEventListener('click', finish);
    });
    if (!intro) return spin();
    // Skipping during the intro skips the whole opening.
    const stage = ov.querySelector('.crate-stage');
    const run = intro(stage);
    const onSkip = (e) => {
      if (e.type === 'keydown' && e.code !== 'Space' && e.key !== 'Escape') return;
      e.preventDefault();
      skipAll = true;
      run.skip();
    };
    window.addEventListener('keydown', onSkip, true);
    ov.addEventListener('click', onSkip);
    run.done.catch(() => {}).then(() => {
      window.removeEventListener('keydown', onSkip, true);
      ov.removeEventListener('click', onSkip);
      ov.classList.remove('intro');
      stage.classList.add('gone');
      setTimeout(() => stage.remove(), 400);
      spin();
    });
  });
}

function resultCard(it) {
  const r = I.rarityInfo(it);
  const pat = I.patternInfo(it);
  const sub = (it.t === 'skin' && it.fl != null ? `${I.wearName(it)} · ${it.fl.toFixed(6)} · Seed ${it.sd}` : it.t === 'chicken' ? `${HAT[it.hat].n} · Feather ${it.fl.toFixed(4)}` : r.n)
    + (it.sn ? ` · #${it.sn.toLocaleString()}` : '');
  return `<div class="result ${r.rank >= 6 ? 'gold' : ''} ${it.as ? 'autosold' : ''}" style="--rc:${r.c}" data-uid="${it.uid}">
    <img src="${I.itemImage(it, 'm')}"><div class="rbar"></div>
    <div class="rn">${esc(r.n)}</div>
    <div class="nm">${esc(I.itemName(it))}</div>
    <div class="sub">${esc(sub)}</div>
    ${pat.label ? `<div style="margin-top:6px">${patternTag(pat)}</div>` : ''}
    <div class="val">${money(I.itemValue(it))}</div>
    <div class="btns">${it.as ? '<span class="chip green">Auto-sold</span><button class="btn sm" data-a="inspect">Inspect</button>' : '<button class="btn sm gold" data-a="inspect">Inspect</button><button class="btn sm" data-a="detail">Details</button><button class="btn sm primary" data-a="sell">Sell</button>'}</div>
  </div>`;
}

export function showResults(c, items, n, { cost = casePrice(c) * n, again = () => openCase(c, n), againLabel = `Open again (${money(cost)})`, title = null, summary = '' } = {}) {
  const total = items.reduce((s, i) => s + I.itemValue(i), 0);
  const sold = items.filter((i) => i.as), soldValue = sold.reduce((s, i) => s + I.itemValue(i), 0);
  if (items.some((i) => I.rarityRank(i) >= 6)) setTimeout(() => sfx.gold(), 250);
  const m = openModal({
    title: title || (items.length > 1 ? `You unboxed ${items.length} items` : 'You unboxed'),
    cls: items.length > 2 ? 'xwide' : 'wide',
    body: `${summary}<div class="results">${items.map(resultCard).join('')}</div>
      <p class="muted" style="text-align:center;margin:16px 0 0">Total value <b class="${total >= cost ? 'green' : 'red'}">${money(total)}</b>${cost ? ` for ${money(cost)} spent` : ''}${sold.length ? ` · auto-sold ${sold.length} for <b class="green">${money(soldValue)}</b>` : ''}</p>`,
    foot: `<button class="btn" data-a="sellall" ${sold.length === items.length ? 'disabled' : ''}>Sell all</button><span class="spacer"></span><button class="btn ghost" data-close>Keep</button>${again ? `<button class="btn gold" data-a="again">${againLabel}</button>` : ''}`,
  });
  const live = () => items.filter((i) => S.inv.some((x) => x.uid === i.uid));
  m.el.querySelectorAll('.result').forEach((el) => {
    const it = items.find((i) => i.uid === el.dataset.uid);
    el.querySelector('[data-a=inspect]').addEventListener('click', () => openInspect(it));
    el.querySelector('[data-a=detail]')?.addEventListener('click', () => showItemDetail(it));
    el.querySelector('[data-a=sell]')?.addEventListener('click', async () => {
      if (!S.inv.some((x) => x.uid === it.uid)) return;
      if (await sellItems([it])) { el.style.opacity = 0.35; el.querySelector('.btns').innerHTML = '<span class="muted">Sold</span>'; }
    });
  });
  m.el.querySelector('[data-a=sellall]').addEventListener('click', async () => {
    if (await sellItems(live())) m.close();
  });
  m.el.querySelector('[data-a=again]')?.addEventListener('click', () => { m.close(); again(); });
  emit('inv');
}
