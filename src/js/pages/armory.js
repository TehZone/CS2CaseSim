// The Armory: spend Armory Stars on drops from a rotating set of collections (new rotation every 10-15 minutes).
import { esc, money, imgUrl } from '../util.js';
import { D, casePrice } from '../data.js';
import { S, on } from '../state.js';
import { sfx } from '../audio.js';
import { tryAct, toast } from '../ui.js';
import { armoryWindow, armoryOffers, offerBox, PASS_PRICE, PASS_STARS, SPEND_PER_STAR } from '../engine/armory.js';
import { playRoulette, showResults, openCollectionView, caseImage } from './cases.js';

let root = null, offs = [], timer = null, shownWindow = -1;

export function render(r) {
  root = r;
  offs.forEach((o) => o());
  offs = [on('stars', () => draw()), on('money', () => updateAfford())];
  draw();
  clearInterval(timer);
  timer = setInterval(tick, 1000);
}
export function destroy() { offs.forEach((o) => o()); offs = []; clearInterval(timer); root = null; }

function tick() {
  if (!root) return;
  const w = armoryWindow();
  if (w.i !== shownWindow) { draw(); toast('The Armory has rotated: new collections are available.', 'gold'); return; }
  const el = root.querySelector('[data-timer]');
  if (el) el.textContent = fmt(w.end - Date.now());
}
const fmt = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

function topSkins(col, n = 3) {
  const ids = Object.entries(col.tiers).sort((a, b) => b[0] - a[0]).flatMap(([, ids]) => ids);
  return ids.slice(0, n).map((id) => D.skins[id]);
}

function colCard(id, offers, live) {
  const col = D.colById[id];
  const mine = offers.filter((o) => o.col === id);
  const iconic = col.tiers[5]?.some((sid) => {
    const p = D.skins[sid].p;
    return p && Math.max(...Object.values(p).map((r) => r[0])) > 500;
  });
  return `<div class="arm-col ${iconic ? 'iconic' : ''} ${live ? '' : 'arm-next'}">
    <div class="top">${topSkins(col).map((s) => `<img src="${imgUrl(s.img, 's')}" title="${esc(s.n)}">`).join('')}</div>
    <div class="body">
      <h4 data-col="${id}">${esc(col.n)} ${iconic ? '<span class="chip gold">Chase item</span>' : ''}</h4>
      <div class="muted" style="font-size:12px">${Object.values(col.tiers).flat().length} skins · best: ${esc(topSkins(col, 1)[0].n)}</div>
      ${mine.map((o) => offerRow(o, live)).join('')}
    </div>
  </div>`;
}
function offerRow(o, live) {
  const box = offerBox(o);
  const label = o.type === 'drop' ? 'Collection drop' : box.kind === 'souvenir' ? 'Souvenir package' : 'Weapon case';
  const img = o.type === 'drop' ? imgUrl(topSkins(D.colById[o.col], 1)[0].img, 's') : caseImage(box);
  return `<div class="arm-offer">
    <img src="${img}">
    <div class="grow"><div>${label}</div><div class="muted">${esc(o.type === 'drop' ? 'Any skin from the collection' : box.n)}${o.type !== 'drop' ? ` · worth ${money(casePrice(box))}` : ''}</div></div>
    ${live ? `<button class="btn gold sm" data-offer="${o.id}" data-stars="${o.stars}">★ ${o.stars}</button>` : `<span class="chip">★ ${o.stars}</span>`}
  </div>`;
}

function draw() {
  if (!root) return;
  const w = armoryWindow();
  shownWindow = w.i;
  const cur = armoryOffers(w.i), next = armoryOffers(w.i + 1);
  const spend = S.starSpend || 0;
  const toNext = SPEND_PER_STAR - (spend % SPEND_PER_STAR);
  root.innerHTML = `<div class="page">
    <div class="page-head"><h1>Armory</h1><span class="sub">Redeem Armory Stars for items from collections you can’t get from cases. The selection rotates every 10-15 minutes${document.body.classList.contains('is-online') ? ' for everyone on the server' : ''}.</span></div>
    <div class="armory-head">
      <div style="display:flex;gap:34px;align-items:center;flex-wrap:wrap">
        <div><div class="muted" style="font-size:11px;letter-spacing:1px;text-transform:uppercase">Your stars</div><div class="stars">${S.stars}</div></div>
        <div style="min-width:240px"><div class="muted" style="font-size:12px;margin-bottom:6px">Next free star: spend ${money(toNext)} more on cases</div>
          <div class="progress"><i style="width:${((spend % SPEND_PER_STAR) / SPEND_PER_STAR) * 100}%"></i></div></div>
        <button class="btn gold" data-pass>Armory Pass: ${PASS_STARS} ★ for ${money(PASS_PRICE)}</button>
      </div>
      <div style="text-align:right"><div class="muted" style="font-size:11px;letter-spacing:1px;text-transform:uppercase">Rotates in</div><div class="timer" data-timer>${fmt(w.end - Date.now())}</div></div>
    </div>
    <div class="section-title">Featured now</div>
    <div class="armory-grid">${cur.collections.map((id) => colCard(id, cur.offers, true)).join('')}
    </div>
    <div class="section-title">Up next</div>
    <div class="armory-grid">${next.collections.map((id) => colCard(id, next.offers, false)).join('')}</div>
  </div>`;
  root.querySelector('[data-pass]').addEventListener('click', buyPass);
  root.querySelectorAll('[data-col]').forEach((h) => h.addEventListener('click', () => {
    document.querySelector('#nav [data-page=cases]').click();
    openCollectionView(h.dataset.col);
  }));
  root.querySelectorAll('[data-offer]').forEach((b) => b.addEventListener('click', () => redeem(b.dataset.offer)));
  updateAfford();
}

function updateAfford() {
  root?.querySelectorAll('[data-offer]').forEach((b) => (b.disabled = S.stars < +b.dataset.stars));
  const p = root?.querySelector('[data-pass]');
  if (p) p.disabled = S.money < PASS_PRICE;
}

async function buyPass() {
  if (await tryAct('armory.pass')) { sfx.buy(); toast(`+${PASS_STARS} Armory Stars`, 'gold'); }
}

let busy = false;
async function redeem(offerId) {
  if (busy) return;
  busy = true;
  const o = armoryOffers(armoryWindow().i).offers.find((x) => x.id === offerId);
  const r = await tryAct('armory.redeem', { offer: offerId });
  if (!r) { busy = false; return; }
  sfx.open();
  const box = offerBox(r.offer || o);
  try { await playRoulette(box, [r.item], `Armory · ${esc(box.n)}`); } finally { busy = false; }
  showResults(box, [r.item], 1, { cost: 0, again: null });
}
