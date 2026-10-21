import { esc, money } from '../util.js';
import { D, RARITY, rarityColor, CASE_ODDS } from '../data.js';
import * as I from '../items.js';
import { S, save, resetSave, idleRate, clickValue, rankName } from '../state.js';
import { toast, confirmDialog } from '../ui.js';
import { online } from '../backend.js';
import { sfx } from '../audio.js';
import { cs2Status } from '../cs2/api.js';

let root;

export function render(r) {
  root = r;
  draw();
}
export function destroy() { root = null; }

function draw() {
  const st = S.stats;
  const invValue = S.inv.reduce((s, i) => s + I.itemValue(i), 0);
  const drops = [2, 3, 4, 5, 6].map((k) => [k, st.drops[k] || 0]);
  const totalDrops = drops.reduce((s, d) => s + d[1], 0) || 1;
  const expected = { 2: 0.7992, 3: 0.1598, 4: 0.032, 5: 0.0064, 6: 0.0026 };
  const stats = [
    ['Balance', money(S.money)], ['Inventory value', money(invValue)], ['Net worth', money(S.money + invValue)],
    ['Cases opened', st.opened.toLocaleString()], ['Spent on cases', money(st.spent)], ['Sold items for', money(st.sold)],
    ['Knives & gloves unboxed', st.knives], ['Best drop', st.bestName ? `${esc(st.bestName)}<br><span class="green">${money(st.bestValue)}</span>` : '—'],
    ['Stickers applied', st.stickersApplied], ['Clicks', st.clicks.toLocaleString()], ['Earned by clicking', money(st.clickEarned)],
    ['Earned passively', money(st.passiveEarned)], ['Rank', rankName()], ['Per click / per second', `${money(clickValue())} / ${money(idleRate())}`],
    ['Trade-ups signed', st.tradeups || 0], ['Armory redemptions', st.armory || 0], ['Player packs opened', st.packs || 0], ['Team matches', st.matches || 0],
    ['Case battles', st.battles || 0], ['Gambled', money(st.gambleWagered || 0)], ['Gambling result', `<span class="${(st.gambleWon || 0) >= 0 ? 'green' : 'red'}">${money(st.gambleWon || 0)}</span>`],
  ];
  root.innerHTML = `<div class="page">
    <div class="page-head"><h1>Stats &amp; Settings</h1>${online() ? '<span class="sub">Showing your online account. Settings below are saved on this PC.</span>' : ''}</div>
    <div class="statgrid">${stats.map(([k, v]) => `<div class="stat"><span>${k}</span><b>${v}</b></div>`).join('')}</div>

    <div class="section-title">Your luck vs. official odds (all containers)</div>
    <div class="bars" style="max-width:760px">${drops.map(([k, n]) => `<div class="b" style="--rc:${rarityColor(k)}">
      <span>${k === 6 ? '★ Rare Special' : RARITY.skin[k]}</span><div style="width:${Math.max(0.5, (n / totalDrops) * 100)}%"></div>
      <span class="muted">${n} · ${((n / totalDrops) * 100).toFixed(2)}% <span class="dim">(${(expected[k] * 100).toFixed(2)}%)</span></span></div>`).join('')}</div>

    <div class="section-title">Settings</div>
    <div class="settings">
      <div class="setting"><div>Sound volume<p>Roulette ticks, reveals and clicks.</p></div><input type="range" min="0" max="1" step="0.05" value="${S.settings.volume}" data-s="volume"></div>
      <div class="setting"><div>Fast open by default<p>Shorter roulette animation.</p></div><input type="checkbox" ${S.settings.fast ? 'checked' : ''} data-s="fast"></div>
      <div class="setting"><div>Confirm sales above<p>Ask before selling items worth at least this much.</p></div><input class="input" type="number" min="0" step="1" value="${S.settings.confirmSellAbove}" style="width:110px" data-s="confirmSellAbove"></div>
      <div class="setting"><div>Market prices<p>Prices from ${D.pricedAt ? new Date(D.pricedAt).toLocaleString() : 'the bundled snapshot'}. Refreshing downloads the latest Skinport, CSFloat, Buff163, YouPin and Steam prices.</p>
        <div class="log" data-log></div></div>
        <div style="display:flex;gap:8px;flex-direction:column">
          <button class="btn primary" data-a="refresh" ${window.native && !online() ? '' : `disabled title="${online() ? 'Online play uses the server’s prices' : 'Available in the desktop app'}"`}>Refresh prices</button>
          <button class="btn ghost sm" data-a="resetprices" ${window.native ? '' : 'disabled'}>Use bundled prices</button>
        </div></div>
      <div class="setting"><div>Real CS2 models<p data-cs2>Checking for Counter-Strike 2…</p></div><button class="btn" data-a="cs2clear" ${window.native ? '' : 'disabled'}>Rebuild CS2 cache</button></div>
      <div class="setting"><div>Image cache<p>Skin images are cached on disk after the first download so the game works offline.</p></div><button class="btn" data-a="clearcache" ${window.native ? '' : 'disabled'}>Clear cache</button></div>
      <div class="setting"><div>Reset progress<p>Deletes your money, inventory, upgrades and stats.</p></div><button class="btn danger" data-a="reset" ${online() ? 'disabled title="Log out to reset your offline save"' : ''}>Reset save</button></div>
    </div>

    <div class="section-title">About</div>
    <p class="muted" style="max-width:860px;line-height:1.6;font-size:13px">
      Fan-made simulator, not affiliated with or endorsed by Valve. Counter-Strike, CS2 and all item names and images are property of Valve Corporation.
      Item database: ByMykel CSGO-API (Steam CDN images). Market prices: Skinport public API plus CSFloat, Buff163, YouPin and Steam price feeds via csgotrader.app,
      blended as a median of third-party marketplaces. Drop odds follow Valve's published rates. Pattern tiers (blue gems, Fire &amp; Ice, fade %) follow community lists
      and are approximations. No real money or items are involved.
      <br>Data built ${D.generatedAt ? new Date(D.generatedAt).toLocaleString() : '—'} · ${D.cases.filter((c) => c.kind === 'case').length} cases · ${Object.keys(D.skins).length} skins · ${Object.keys(D.stickers).length.toLocaleString()} stickers · ${Object.keys(D.agents).length} agents.
    </p>
  </div>`;

  root.querySelectorAll('[data-s]').forEach((el) => el.addEventListener('change', () => {
    const k = el.dataset.s;
    S.settings[k] = el.type === 'checkbox' ? el.checked : +el.value;
    save();
    if (k === 'volume') sfx.click();
  }));
  root.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => action(b.dataset.a, b)));
  cs2Status().then((st) => {
    const el = root?.querySelector('[data-cs2]');
    if (!el) return;
    el.textContent = st.available
      ? `Using your CS2 install (${st.gameDir}). Guns and knives are shown on their real models with CS2's own skin shader; models and textures are extracted the first time you inspect each weapon and cached.`
      : st.gameDir ? 'CS2 found, but the model extractor is missing. Showing icon-based 3D models.' : 'Counter-Strike 2 is not installed, so 3D inspect uses icon-based models.';
  });
}

async function action(a, btn) {
  if (a === 'reset') {
    if (!(await confirmDialog('Delete <b>all</b> progress? This cannot be undone.', { ok: 'Reset everything', danger: true }))) return;
    await resetSave();
    toast('Save reset. Fresh start with $10.', 'good');
    draw();
  }
  if (a === 'cs2clear') {
    if (!(await confirmDialog('Delete the extracted CS2 models and textures? They are re-extracted from your CS2 install as needed.', { ok: 'Rebuild' }))) return;
    await window.native.cs2Clear();
    toast('CS2 cache cleared. Restart the game to rebuild it.', 'good');
  }
  if (a === 'clearcache') {
    await window.native.clearImageCache();
    toast('Image cache cleared.', 'good');
  }
  if (a === 'resetprices') {
    await window.native.resetPrices();
    toast('Restart the game to use the bundled prices.', 'gold');
  }
  if (a === 'refresh') {
    const log = root.querySelector('[data-log]');
    btn.disabled = true;
    log.textContent = '';
    window.native.onPriceProgress((m) => { if (log.isConnected) log.textContent += m + '\n'; });
    try {
      const r = await window.native.refreshPrices();
      log.textContent += `Updated ${r.skins} skins, ${r.stickers} stickers, ${r.agents} agents, ${r.cases} containers from ${r.sources.join(', ')}.\n`;
      const res = await fetch('data/game-data.json', { cache: 'no-store' });
      const fresh = await res.json();
      for (const k of ['skins', 'stickers', 'agents']) for (const [id, v] of Object.entries(fresh[k])) if (D[k][id]) D[k][id].p = v.p;
      for (const c of fresh.cases) if (D.caseById[c.id]) D.caseById[c.id].price = c.price;
      D.pricedAt = fresh.pricedAt;
      toast('Market prices updated.', 'good');
      draw();
    } catch (e) {
      log.textContent += 'Failed: ' + e.message;
      btn.disabled = false;
    }
  }
}
