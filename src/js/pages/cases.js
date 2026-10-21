import { esc, money, imgUrl, round2 } from '../util.js';
import { D, WEARS, casePrice, caseTiers, rarityColor, DOPPLER_PHASE_WEIGHT } from '../data.js';
import * as I from '../items.js';
import { S, trySpend, addItems, save, emit } from '../state.js';
import { sfx } from '../audio.js';
import { toast, openModal, itemCard, patternTag, sellItems, openInspect, showItemDetail, rarityOddsHTML } from '../ui.js';
import { renderChickenThumb } from '../chicken3d.js';
import { BREED, HAT, chickenValue } from '../chickens.js';

const view = { mode: 'list', caseId: null, filter: 'case', sort: 'new', q: '', qty: 1 };
let rootEl = null;

export function openCaseView(id) {
  view.mode = 'case';
  view.caseId = id;
  render(rootEl);
}

export function render(root) {
  rootEl = root;
  if (view.mode === 'case' && D.caseById[view.caseId]) renderCase(root, D.caseById[view.caseId]);
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
function expectedSkin(skin) {
  if (skin.v) return skin.p.V[0] * 0.9 + (skin.p.V[1] ?? skin.p.V[0]) * 0.1;
  const probs = wearProbs(skin);
  const stt = skin.stt && skin.cat !== 'gloves' ? 0.1 : 0;
  let ev = 0;
  for (const [k, p] of Object.entries(probs)) {
    const row = skin.p[k];
    if (!row) continue;
    ev += p * ((1 - stt) * row[0] + stt * (row[1] ?? row[0]));
  }
  return ev;
}
function priceRange(skin) {
  if (skin.v) return [skin.p.V[0], skin.p.V[1] ?? skin.p.V[0]];
  const vals = Object.values(skin.p).flatMap((r) => r.filter((x) => x != null));
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
          return s + g.reduce((a, id, i) => a + (ws[i] / t) * expectedSkin(D.skins[id]), 0);
        }, 0) / c.rare.length;
      } else {
        const ids = c.pools[k];
        const val = (id) => (c.kind === 'case' ? expectedSkin(D.skins[id]) : c.kind === 'agents' ? D.agents[id].p : D.stickers[id].p);
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
const FILTERS = [['case', 'Weapon Cases'], ['capsule', 'Sticker Capsules'], ['autograph', 'Autograph Capsules'], ['special', 'Agents & Chickens']];

function renderList(root) {
  const list = D.cases.filter((c) => {
    if (view.filter === 'special') return c.custom;
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
      <input class="input" type="search" placeholder="Search cases…" value="${esc(view.q)}">
      <span class="spacer"></span>
      <select class="input" data-k="sort">
        ${[['new', 'Newest'], ['old', 'Oldest'], ['cheap', 'Cheapest'], ['pricey', 'Most expensive'], ['ev', 'Best return']].map(([k, n]) => `<option value="${k}" ${view.sort === k ? 'selected' : ''}>${n}</option>`).join('')}
      </select>
    </div>
    <div class="grid lg">${list.map(caseTile).join('') || '<div class="empty">No cases match.</div>'}</div>
  </div>`;
  root.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => { view.filter = b.dataset.v; renderList(root); }));
  root.querySelector('select[data-k=sort]').addEventListener('change', (e) => { view.sort = e.target.value; renderList(root); });
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
      <div class="row"><span class="price">${money(price)}</span><span class="key">${c.key ? `incl. ${money(D.keyPrice)} key` : 'no key needed'}</span></div>
      <div class="row"><span class="dim" style="font-size:11px">Return ≈ ${(ret * 100).toFixed(0)}%</span><span class="dim" style="font-size:11px">${c.date ? c.date.slice(0, 4) : ''}</span></div>
    </div>
  </div>`;
}

// ---- case view -----------------------------------------------------------------------------
function defTile(kind, id, oddsEach) {
  if (kind === 'case') {
    const s = D.skins[id];
    const [lo, hi] = priceRange(s);
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
    return c.pools[k].map((id) => defTile(c.kind === 'case' ? 'case' : c.kind, id, w / c.pools[k].length)).join('');
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
        <div class="muted" style="text-transform:uppercase;letter-spacing:1.5px;font-size:12px">${c.kind === 'case' ? 'Weapon case' : c.kind === 'agents' ? 'Agent locker' : c.kind === 'chickens' ? 'Chicken crate' : c.kind === 'autograph' ? 'Autograph capsule' : 'Sticker capsule'}</div>
        <h2>${esc(c.n)}</h2>
        <div class="stats">
          <div>Container<b>${money(c.price)}</b></div>
          ${c.key ? `<div>Key<b>${money(D.keyPrice)}</b></div>` : ''}
          <div>Total per open<b class="green">${money(price)}</b></div>
          <div>Expected value<b>${money(ev)}</b></div>
          <div>Return<b class="${ev >= price ? 'green' : 'red'}">${((ev / price) * 100).toFixed(1)}%</b></div>
        </div>
        <div class="open-row">
          <div class="seg" data-k="qty">${[1, 2, 3, 4, 5].map((n) => `<button data-v="${n}" class="${view.qty === n ? 'active' : ''}">×${n}</button>`).join('')}</div>
          <button class="btn gold big" data-open>Open for ${money(price * view.qty)}</button>
          <label class="check"><input type="checkbox" data-fast ${S.settings.fast ? 'checked' : ''}> Fast open</label>
        </div>
        <div class="odds">${c.kind === 'chickens'
          ? tiers.map(([k, w]) => `<span style="--rc:${rarityColor(+k)}">${['', '', 'Barnyard', 'Free-Range', 'Prize', 'Legendary', '★ Mythic'][k]}: ${(w * 100).toFixed(2)}%</span>`).join('')
          : rarityOddsHTML(c, tiers)}</div>
      </div>
    </div>
    <div class="section-title">Contains</div>
    <div class="grid">${contents}${c.rare ? `<div class="card rare-tile" style="--rc:#e4ae39" data-scroll-rare><div class="img"><span class="rare-glyph">★</span></div><div class="rbar"></div><div class="meta"><div class="n1">Exceedingly rare</div><div class="n2">★ Rare Special Item</div><div class="row"><span class="wear">${c.rareKind === 'gloves' ? 'Gloves' : c.rareKind === 'mixed' ? 'Knives & gloves' : 'Knives'}</span><span class="dim">${(rareW * 100).toFixed(2)}%</span></div></div></div>` : ''}</div>
    ${c.rare ? `<div class="section-title" id="rare-list">Rare special items (${c.rare.length})</div><div class="grid">${rareTiles}</div>` : ''}
    <p class="dim" style="margin-top:22px;font-size:12px">Tip: click any item for prices, odds and a 3D inspect.</p>
  </div>`;

  root.querySelector('[data-back]').addEventListener('click', () => { view.mode = 'list'; render(root); });
  root.querySelectorAll('[data-k=qty] button').forEach((b) => b.addEventListener('click', () => { view.qty = +b.dataset.v; renderCase(root, c); }));
  root.querySelector('[data-fast]').addEventListener('change', (e) => { S.settings.fast = e.target.checked; save(); });
  root.querySelector('[data-open]').addEventListener('click', () => openCase(c, view.qty));
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
    const canStt = s.stt && s.cat !== 'gloves';
    if (!canStt) stt = false;
    const sample = I.makeSkinItem(s, { stt, sd: seed, ...(s.v ? {} : { fl: I.rollFloatInWear(s, wear) }) });
    const pat = I.patternInfo(sample);
    const r = I.rarityInfo(sample);
    const np = I.nameParts(sample);
    titleEl.textContent = s.n + (s.ph ? ` (${s.ph})` : '');
    const rows = s.v
      ? [['Vanilla', s.p.V[0], canStt ? s.p.V[1] : null]]
      : wears.map((w) => [w.n, s.p[w.k][0], canStt ? s.p[w.k][1] : null]);
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
          <dt>StatTrak™</dt><dd>${canStt ? 'Available (10% of drops)' : 'Not available'}</dd>
          <dt>Finish style</dt><dd>${esc(s.st || '—')}</dd>
        </dl>
        <table class="price-table">
          <tr><th>Exterior</th><th>Price</th>${canStt ? '<th>StatTrak™</th>' : ''}</tr>
          ${rows.map(([n, a, b]) => `<tr><td>${n}</td><td class="green">${money(a)}</td>${canStt ? `<td class="green">${b != null ? money(b) : '—'}</td>` : ''}</tr>`).join('')}
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
      openInspect(I.makeSkinItem(s, { stt, sd: seed, ...(s.v ? {} : { fl: I.rollFloatInWear(s, wear) }) }));
    });
  };
  draw();
}

// ---- opening -------------------------------------------------------------------------------
let opening = false;
export async function openCase(c, n) {
  if (opening) return;
  const cost = round2(casePrice(c) * n);
  if (!trySpend(cost)) {
    sfx.error();
    toast(`You need <b>${money(cost)}</b> to open ${n > 1 ? n + ' of these' : 'this'}. Earn money on the <b>Earn</b> tab or sell items.`, 'bad');
    return;
  }
  opening = true;
  sfx.open();
  const items = Array.from({ length: n }, () => I.rollFromCase(c));
  for (const it of items) {
    it.nw = true;
    const v = I.itemValue(it);
    const rank = I.rarityRank(it);
    S.stats.drops[rank] = (S.stats.drops[rank] || 0) + 1;
    if (I.itemDef(it)?.star) S.stats.knives++;
    if (v > S.stats.bestValue) { S.stats.bestValue = v; S.stats.bestName = I.itemName(it); }
  }
  S.stats.opened += n;
  S.stats.spent = round2(S.stats.spent + cost);
  addItems(items); // saved before the animation so nothing is lost if the app closes
  try {
    await playRoulette(c, items);
  } finally {
    opening = false;
  }
  showResults(c, items, n);
}

function slotHTML(entry) {
  if (entry.t === 'rare-placeholder' || (entry.t === 'skin' && D.skins[entry.id]?.star)) {
    return `<div class="slot rare" style="--rc:#e4ae39"><span class="rare-glyph">★</span><div class="sn">Rare Special Item</div></div>`;
  }
  const r = I.rarityInfo(entry);
  const np = I.nameParts(entry);
  return `<div class="slot" style="--rc:${r.c}"><img src="${I.itemImage(entry, 's')}"><div class="sn">${esc(np.bottom)}</div></div>`;
}

const WIN_INDEX = 58, REEL_LEN = 66;
function playRoulette(c, items) {
  return new Promise((resolve) => {
    const n = items.length;
    const ov = document.createElement('div');
    ov.className = 'opening';
    ov.innerHTML = `<h3>Unlocking ${esc(c.n)}</h3><div class="strips n${n}">${items.map(() => '<div class="strip"><div class="reel"></div><div class="marker"></div></div>').join('')}</div><div class="hint">Press SPACE or click to skip</div>`;
    document.body.appendChild(ov);
    const strips = [...ov.querySelectorAll('.strip')];
    const reels = strips.map((strip, si) => {
      const reel = strip.querySelector('.reel');
      const entries = Array.from({ length: REEL_LEN }, (_, i) => (i === WIN_INDEX ? items[si] : I.fakeRoll(c)));
      reel.innerHTML = entries.map(slotHTML).join('');
      return { strip, reel };
    });
    // measure after layout
    requestAnimationFrame(() => {
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
      requestAnimationFrame(step);
      const onKey = (e) => { if (e.code === 'Space' || e.key === 'Escape') { e.preventDefault(); finish(); } };
      window.addEventListener('keydown', onKey, true);
      ov.addEventListener('click', finish);
    });
  });
}

function resultCard(it) {
  const r = I.rarityInfo(it);
  const pat = I.patternInfo(it);
  const sub = it.t === 'skin' && it.fl != null ? `${I.wearName(it)} · ${it.fl.toFixed(6)} · Seed ${it.sd}` : it.t === 'chicken' ? `${HAT[it.hat].n} · Feather ${it.fl.toFixed(4)}` : r.n;
  return `<div class="result ${r.rank >= 6 ? 'gold' : ''}" style="--rc:${r.c}" data-uid="${it.uid}">
    <img src="${I.itemImage(it, 'm')}"><div class="rbar"></div>
    <div class="rn">${esc(r.n)}</div>
    <div class="nm">${esc(I.itemName(it))}</div>
    <div class="sub">${esc(sub)}</div>
    ${pat.label ? `<div style="margin-top:6px">${patternTag(pat)}</div>` : ''}
    <div class="val">${money(I.itemValue(it))}</div>
    <div class="btns"><button class="btn sm gold" data-a="inspect">Inspect</button><button class="btn sm" data-a="detail">Details</button><button class="btn sm primary" data-a="sell">Sell</button></div>
  </div>`;
}

function showResults(c, items, n) {
  const total = items.reduce((s, i) => s + I.itemValue(i), 0);
  const cost = casePrice(c) * n;
  if (items.some((i) => I.rarityRank(i) >= 6)) setTimeout(() => sfx.gold(), 250);
  const m = openModal({
    title: items.length > 1 ? `You unboxed ${items.length} items` : 'You unboxed',
    cls: items.length > 2 ? 'xwide' : 'wide',
    body: `<div class="results">${items.map(resultCard).join('')}</div>
      <p class="muted" style="text-align:center;margin:16px 0 0">Total value <b class="${total >= cost ? 'green' : 'red'}">${money(total)}</b> for ${money(cost)} spent</p>`,
    foot: `<button class="btn" data-a="sellall">Sell all</button><span class="spacer"></span><button class="btn ghost" data-close>Keep</button><button class="btn gold" data-a="again">Open again (${money(cost)})</button>`,
  });
  const live = () => items.filter((i) => S.inv.includes(i));
  m.el.querySelectorAll('.result').forEach((el) => {
    const it = items.find((i) => i.uid === el.dataset.uid);
    el.querySelector('[data-a=inspect]').addEventListener('click', () => openInspect(it));
    el.querySelector('[data-a=detail]').addEventListener('click', () => showItemDetail(it));
    el.querySelector('[data-a=sell]').addEventListener('click', async () => {
      if (!S.inv.includes(it)) return;
      if (await sellItems([it])) { el.style.opacity = 0.35; el.querySelector('.btns').innerHTML = '<span class="muted">Sold</span>'; }
    });
  });
  m.el.querySelector('[data-a=sellall]').addEventListener('click', async () => {
    if (await sellItems(live())) m.close();
  });
  m.el.querySelector('[data-a=again]').addEventListener('click', () => { m.close(); openCase(c, n); });
  emit('inv');
}
