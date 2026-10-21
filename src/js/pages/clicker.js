import { money, moneyShort, rand } from '../util.js';
import { S, on, addMoney, trySpend, save, UPGRADES, RANKS, lvl, upgradeCost, clickValue, critChance, idleRate, rankName, globalMult, chickenRate } from '../state.js';
import { sfx } from '../audio.js';

let root, offs = [];

const TARGET_SVG = `<svg viewBox="0 0 200 200">
  <defs>
    <radialGradient id="tg" cx="50%" cy="40%" r="60%"><stop offset="0" stop-color="#2a3646"/><stop offset="1" stop-color="#121a24"/></radialGradient>
    <linearGradient id="tr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd35c"/><stop offset="1" stop-color="#d98f07"/></linearGradient>
  </defs>
  <circle cx="100" cy="100" r="96" fill="url(#tg)" stroke="#3a4a60" stroke-width="3"/>
  <circle cx="100" cy="100" r="74" fill="none" stroke="url(#tr)" stroke-width="10"/>
  <circle cx="100" cy="100" r="48" fill="none" stroke="#e8eef5" stroke-width="8" opacity=".85"/>
  <circle cx="100" cy="100" r="22" fill="url(#tr)"/>
  <circle cx="100" cy="100" r="6" fill="#121a24"/>
  <g stroke="#5fd46f" stroke-width="4" stroke-linecap="round">
    <line x1="100" y1="2" x2="100" y2="34"/><line x1="100" y1="166" x2="100" y2="198"/>
    <line x1="2" y1="100" x2="34" y2="100"/><line x1="166" y1="100" x2="198" y2="100"/>
  </g>
</svg>`;

export function render(r) {
  root = r;
  root.innerHTML = `<div class="page">
    <div class="page-head"><h1>Earn</h1><span class="sub">Click the target to earn money. Headshots pay ×10. Upgrades boost clicks and add passive income.</span></div>
    <div class="clicker">
      <div class="click-zone">
        <span class="rank-badge" data-rank></span>
        <button class="target" aria-label="Click to earn">${TARGET_SVG}</button>
        <div class="click-stats">
          <div>Per click<b data-cv></b></div>
          <div>Headshot chance<b data-crit></b></div>
          <div>Passive income<b data-idle></b></div>
          <div>Prime bonus<b data-gm></b></div>
        </div>
        <div class="muted" style="font-size:12px" data-chick></div>
      </div>
      <div>
        <div class="section-title" style="margin-top:0">Upgrades</div>
        <div class="upgrades"></div>
      </div>
    </div>
  </div>`;
  const zone = root.querySelector('.click-zone');
  root.querySelector('.target').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const hs = rand() < critChance();
    const v = clickValue() * (hs ? 10 : 1);
    addMoney(v);
    S.stats.clicks++;
    S.stats.clickEarned += v;
    hs ? sfx.headshot() : sfx.click();
    const z = zone.getBoundingClientRect();
    const f = document.createElement('div');
    f.className = 'floater' + (hs ? ' hs' : '');
    f.textContent = (hs ? 'HEADSHOT +' : '+') + money(v);
    f.style.left = e.clientX - z.left - 30 + (Math.random() - 0.5) * 30 + 'px';
    f.style.top = e.clientY - z.top - 20 + 'px';
    zone.appendChild(f);
    setTimeout(() => f.remove(), 900);
  });
  offs.push(on('money', () => refresh()));
  draw();
}

export function destroy() {
  offs.forEach((o) => o());
  offs = [];
  root = null;
}

function draw() {
  const list = root.querySelector('.upgrades');
  list.innerHTML = UPGRADES.map((u) => {
    const l = lvl(u.id);
    const maxed = u.max != null && l >= u.max;
    return `<div class="upg" data-id="${u.id}">
      <div class="nm">${u.n}<span class="lv">Lv ${l}${u.max != null ? '/' + u.max : ''}</span></div>
      <button class="btn ${maxed ? '' : 'primary'}" data-buy="${u.id}" ${maxed ? 'disabled' : ''}>${maxed ? 'Maxed' : moneyShort(upgradeCost(u))}</button>
      <div class="ds">${u.id === 'rank' && !maxed ? `${u.d} · next: ${RANKS[l + 1]}` : u.d}</div>
    </div>`;
  }).join('');
  list.querySelectorAll('[data-buy]').forEach((b) => b.addEventListener('click', () => buy(b.dataset.buy)));
  refresh();
}

function buy(id) {
  const u = UPGRADES.find((x) => x.id === id);
  if (u.max != null && lvl(id) >= u.max) return;
  if (!trySpend(upgradeCost(u))) { sfx.error(); return; }
  S.upg[id] = lvl(id) + 1;
  sfx.buy();
  save();
  draw();
}

function refresh() {
  if (!root) return;
  root.querySelector('[data-cv]').textContent = money(clickValue());
  root.querySelector('[data-crit]').textContent = (critChance() * 100).toFixed(0) + '%';
  root.querySelector('[data-idle]').textContent = money(idleRate()) + '/s';
  root.querySelector('[data-gm]').textContent = '×' + globalMult().toFixed(2);
  root.querySelector('[data-rank]').textContent = '★ ' + rankName();
  const cr = chickenRate();
  root.querySelector('[data-chick]').textContent = cr > 0 ? `Includes ${money(cr)}/s of eggs from your chicken coop` : 'Tip: chickens in your coop lay eggs for extra passive income';
  root.querySelectorAll('[data-buy]').forEach((b) => {
    const u = UPGRADES.find((x) => x.id === b.dataset.buy);
    if (u.max != null && lvl(u.id) >= u.max) return;
    b.disabled = S.money < upgradeCost(u);
  });
}
