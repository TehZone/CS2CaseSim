// Trade Up Contracts: 10 skins of one rarity -> one of the next rarity (or 5 Coverts -> a knife/gloves).
import { esc, money, imgUrl } from '../util.js';
import { D, rarityColor, RARITY, WEARS, wearOf } from '../data.js';
import * as I from '../items.js';
import { S, on } from '../state.js';
import { sfx } from '../audio.js';
import { tryAct, toast, openInspect } from '../ui.js';
import { tradeupContract, tradeupIneligible, CLASSIC_COUNT, COVERT_COUNT } from '../engine/tradeup.js';
import { playRoulette, showResults } from './cases.js';

const view = { picked: [], rarity: 'all', stt: 'all', q: '', sort: 'value' };
let root = null, offs = [];

export function render(r) {
  root = r;
  offs.forEach((o) => o());
  offs = [on('inv', () => { prune(); draw(); })];
  prune();
  draw();
}
export function destroy() { offs.forEach((o) => o()); offs = []; root = null; }

// Drop picked items that were sold or traded away.
function prune() {
  const have = new Set(S.inv.map((i) => i.uid));
  view.picked = view.picked.filter((u) => have.has(u));
}
const pickedItems = () => view.picked.map((u) => S.inv.find((i) => i.uid === u)).filter(Boolean);

// Value of a possible outcome at the float the contract would give it.
function outcomeValue(o, stt) {
  const vals = o.ids.map((id) => {
    const s = D.skins[id];
    const sample = { t: 'skin', id, fl: s.v ? null : o.fl, sd: 0, stt: stt && s.stt, stk: [] };
    return I.basePrice(sample) * I.floatMultiplier(sample);
  });
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function draw() {
  if (!root) return;
  const items = pickedItems();
  const c = tradeupContract(items);
  const need = items.length ? c.need : CLASSIC_COUNT;
  const input = items.reduce((s, it) => s + I.itemValue(it), 0);
  const outs = c.outcomes.map((o) => ({ ...o, value: outcomeValue(o, c.stt) }));
  const ev = outs.reduce((s, o) => s + o.chance * o.value, 0);
  const profit = outs.filter((o) => o.value > input).reduce((s, o) => s + o.chance, 0);
  const lockRarity = items.length ? D.skins[items[0].id].r : null;
  const lockStt = items.length ? !!items[0].stt : null;

  // Inventory candidates.
  let cands = S.inv.filter((it) => it.t === 'skin' && !view.picked.includes(it.uid));
  if (view.q) cands = cands.filter((it) => I.itemName(it).toLowerCase().includes(view.q));
  if (view.rarity !== 'all') cands = cands.filter((it) => String(D.skins[it.id]?.r) === view.rarity);
  if (view.stt !== 'all') cands = cands.filter((it) => !!it.stt === (view.stt === 'st'));
  const why = (it) => {
    const w = tradeupIneligible(it);
    if (w) return w;
    if (it.lk) return 'Locked';
    if (lockRarity != null && D.skins[it.id].r !== lockRarity) return 'Different rarity';
    if (lockStt != null && !!it.stt !== lockStt) return lockStt ? 'Contract is StatTrak™' : 'Contract is not StatTrak™';
    if (items.length >= need) return 'Contract is full';
    return '';
  };
  const ranked = cands.map((it) => ({ it, w: why(it), v: I.itemValue(it) }));
  ranked.sort((a, b) => (!!a.w - !!b.w) || (view.sort === 'float' ? (a.it.fl ?? 1) - (b.it.fl ?? 1) : view.sort === 'value' ? a.v - b.v : b.v - a.v));

  root.innerHTML = `<div class="page">
    <div class="page-head"><h1>Trade Up</h1><span class="sub">Ten skins of one rarity become one skin of the next rarity from their collections. Five Covert skins become a knife or gloves.</span></div>
    <div class="two-col">
      <div class="panel">
        <h3>Contract ${items.length ? `· ${esc(RARITY.skin[lockRarity])}${lockStt ? ' StatTrak™' : ''}` : ''}</h3>
        <div class="tu-slots">${Array.from({ length: need }, (_, i) => {
          const it = items[i];
          if (!it) return `<div class="tu-slot"><span class="num">${i + 1}</span></div>`;
          const r = I.rarityInfo(it);
          return `<div class="tu-slot filled" style="--rc:${r.c}" data-rm="${it.uid}" title="${esc(I.itemName(it))}">
            <img src="${I.itemImage(it, 's')}"><span class="f">${it.fl != null ? it.fl.toFixed(4) : ''}</span><button class="x">&times;</button></div>`;
        }).join('')}</div>
        <div class="tu-sum">
          <div>Inputs<b>${money(input)}</b></div>
          <div>Expected<b class="${ev >= input ? 'green' : 'red'}">${outs.length ? money(ev) : '—'}</b></div>
          <div>Profit chance<b>${outs.length ? (profit * 100).toFixed(1) + '%' : '—'}</b></div>
          <div>Output float<b>${outs.length && outs[0].fl != null ? outs[0].fl.toFixed(4) : '—'}</b></div>
        </div>
        <div class="open-row">
          <button class="btn gold big" data-sign ${c.ok ? '' : 'disabled'}>Sign contract</button>
          <button class="btn" data-clear ${items.length ? '' : 'disabled'}>Clear</button>
          <span class="muted" style="font-size:12px">${esc(c.ok ? (c.covert ? 'Covert contract: knife or gloves!' : 'Ready to sign') : items.length ? c.error : 'Pick skins from your inventory')}</span>
        </div>
        ${outs.length ? `<div class="section-title" style="margin-top:16px">Possible outcomes (${outs.length})</div>
        <div class="tu-out">${outs.map((o) => {
          const s = D.skins[o.ids[0]];
          const wear = o.fl != null ? WEARS.find((w) => w.k === wearOf(o.fl)).n : 'Vanilla';
          return `<div class="tu-row" style="--rc:${rarityColor(s.star ? 6 : s.r)}" data-insp="${o.ids[0]}" data-fl="${o.fl ?? ''}">
            <img src="${imgUrl(s.img, 's')}">
            <div><div>${esc(s.n)}${o.ids.length > 1 ? ' <span class="dim">(phases)</span>' : ''}</div><div class="muted">${esc(wear)}${o.fl != null ? ' · ' + o.fl.toFixed(5) : ''} · <span class="${o.value >= input ? 'green' : ''}">${money(o.value)}</span></div></div>
            <div class="ch">${(o.chance * 100).toFixed(o.chance < 0.01 ? 2 : 1)}%</div></div>`;
        }).join('')}</div>` : `<p class="muted" style="font-size:12px;line-height:1.6;margin-top:14px">How it works (same as CS2): every skin you add puts one ticket per possible result from its own collection into the draw.
          Collections you add more skins from are more likely. The result's float is the average of your skins' floats (each relative to its own float range) mapped onto the result's range.
          Souvenirs, knives and gloves can't be used. StatTrak™ contracts give StatTrak™ results.</p>`}
      </div>
      <div>
        <div class="toolbar">
          <input class="input" type="search" placeholder="Search your skins…" value="${esc(view.q)}">
          <select class="input" data-k="rarity"><option value="all">All rarities</option>${[0, 1, 2, 3, 4, 5].map((r) => `<option value="${r}" ${view.rarity === String(r) ? 'selected' : ''}>${RARITY.skin[r]}</option>`).join('')}</select>
          <select class="input" data-k="stt"><option value="all">Normal + StatTrak™</option><option value="n" ${view.stt === 'n' ? 'selected' : ''}>Normal</option><option value="st" ${view.stt === 'st' ? 'selected' : ''}>StatTrak™</option></select>
          <select class="input" data-k="sort"><option value="value" ${view.sort === 'value' ? 'selected' : ''}>Cheapest first</option><option value="pricey" ${view.sort === 'pricey' ? 'selected' : ''}>Priciest first</option><option value="float" ${view.sort === 'float' ? 'selected' : ''}>Lowest float</option></select>
        </div>
        ${ranked.length ? `<div class="grid">${ranked.slice(0, 240).map(({ it, w, v }) => {
          const r = I.rarityInfo(it);
          const np = I.nameParts(it);
          return `<div class="card ${w ? 'ineligible' : ''}" data-add="${it.uid}" style="--rc:${r.c}" title="${esc(w || 'Add to contract')}">
            <div class="img"><img loading="lazy" src="${I.itemImage(it, 's')}"></div><div class="rbar"></div>
            <div class="meta"><div class="n1">${esc(np.top)}</div><div class="n2">${esc(np.bottom)}</div>
            <div class="row"><span class="val">${money(v)}</span><span class="wear">${it.fl != null ? it.fl.toFixed(4) : ''}</span></div></div></div>`;
        }).join('')}</div>` : '<div class="empty">No skins to trade up. Open some cases or souvenir packages first.</div>'}
      </div>
    </div>
  </div>`;

  root.querySelectorAll('[data-rm]').forEach((el) => el.addEventListener('click', () => { view.picked = view.picked.filter((u) => u !== el.dataset.rm); draw(); }));
  root.querySelectorAll('[data-add]').forEach((el) => el.addEventListener('click', () => {
    const it = S.inv.find((i) => i.uid === el.dataset.add);
    const w = it && why(it);
    if (w) { sfx.error(); return toast(esc(w), 'bad'); }
    view.picked.push(it.uid);
    sfx.click();
    draw();
  }));
  root.querySelectorAll('[data-insp]').forEach((el) => el.addEventListener('click', () => {
    const s = D.skins[el.dataset.insp];
    openInspect(I.makeSkinItem(s, { stt: c.stt && s.stt, ...(el.dataset.fl ? { fl: +el.dataset.fl } : {}) }));
  }));
  root.querySelector('[data-clear]').addEventListener('click', () => { view.picked = []; draw(); });
  root.querySelector('[data-sign]').addEventListener('click', () => sign(c, input, outs));
  const q = root.querySelector('input[type=search]');
  q.addEventListener('input', () => { view.q = q.value.toLowerCase(); draw(); const n = root.querySelector('input[type=search]'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); });
  root.querySelectorAll('select[data-k]').forEach((s) => s.addEventListener('change', () => { view[s.dataset.k] = s.value; draw(); }));
}

let signing = false;
async function sign(contract, input, outs) {
  if (signing || !contract.ok) return;
  signing = true;
  const uids = [...view.picked];
  const r = await tryAct('tradeup.sign', { uids });
  if (!r) { signing = false; return; }
  view.picked = [];
  sfx.open();
  // Reel of the possible outcomes, weighted by their chances.
  const pool = outs.flatMap((o) => Array(Math.max(1, Math.round(o.chance * 40))).fill(o.ids[0]));
  const box = {
    n: 'Trade Up Contract', showAll: true,
    fake: () => ({ t: 'skin', id: pool[Math.floor(Math.random() * pool.length)], fl: 0.2, stt: contract.stt }),
  };
  try { await playRoulette(box, [r.item], 'Trade Up Contract'); } finally { signing = false; }
  showResults(box, [r.item], 1, { cost: input, again: null });
  if (root) draw();
}
