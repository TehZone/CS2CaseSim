import { esc, money } from '../util.js';
import { D, RARITY, rarityColor, CASE_ODDS } from '../data.js';
import * as I from '../items.js';
import { S, save, resetSave, emit } from '../state.js';
import { toast, confirmDialog } from '../ui.js';
import { online } from '../backend.js';
import { autoSellLabel, autoSellModal } from '../autosell.js';
import { sfx } from '../audio.js';
import { cs2Status } from '../cs2/api.js';
import { backgroundMaps, setMenuBackground } from '../menu.js';
import { prepareAll, prepareMaps, prepareStatus, prepareCancel, cacheSize, compactStatus, setCompress } from '../cs2/content.js';
import { rankInfo } from '../engine/ranks.js';
import { loadRankArt, emblemHtml, rankKey } from '../rank.js';
import { levelHtml } from '../profile.js';
import { ownedWorth } from '../stored.js';

let root;

export function render(r) {
  root = r;
  draw();
  loadRankArt().then((a) => { if (a && root === r) draw(); });
}
export function destroy() { root = null; }

// Your CS:GO rank from Play's competitive (or wingman) matches: the emblem and its name (or the wins it still needs).
function competitiveRank(wingman = false) {
  const info = rankInfo(wingman ? S.wingman : S.rank);
  const text = info.expired ? 'Expired' : info.group ? info.name : `Unranked · ${info.needWins} wins to go`;
  return `<span class="stat-rank">${emblemHtml(rankKey(info), { size: 28, wingman })}${esc(text)}</span>`;
}

function draw() {
  const st = S.stats;
  const invValue = ownedWorth(); // (what's in Storage Units too)
  const drops = [2, 3, 4, 5, 6].map((k) => [k, st.drops[k] || 0]);
  const totalDrops = drops.reduce((s, d) => s + d[1], 0) || 1;
  const expected = { 2: 0.7992, 3: 0.1598, 4: 0.032, 5: 0.0064, 6: 0.0026 };
  const stats = [
    ['Balance', money(S.money)], ['Inventory value', money(invValue)], ['Net worth', money(S.money + invValue)],
    ['Cases opened', st.opened.toLocaleString()], ['Spent on cases', money(st.spent)], ['Sold items for', money(st.sold)],
    ['Knives & gloves unboxed', st.knives], ['Best drop', st.bestName ? `${esc(st.bestName)}<br><span class="green">${money(st.bestValue)}</span>` : '—'],
    ['Stickers applied', st.stickersApplied], ['Profile level', levelHtml(S.prof)],
    ['Matches played (Play)', (st.playMatches || 0).toLocaleString()], ['Matches won', (st.playWins || 0).toLocaleString()], ['Kills', (st.playKills || 0).toLocaleString()], ['Earned from matches', money(st.playEarned || 0)],
    ['Competitive rank (Play)', competitiveRank()], ['Wingman rank (Play)', competitiveRank(true)],
    ['Trade-ups signed', st.tradeups || 0], ['Armory redemptions', st.armory || 0],
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
      <div class="setting"><div>Case drop animation<p>The case drops in and unlocks before the roulette, like CS2 (its real 3D model when Counter-Strike 2 is installed).</p></div><input type="checkbox" ${S.settings.caseIntro !== false ? 'checked' : ''} data-s="caseIntro"></div>
      <div class="setting"><div>Main menu background<p>CS2's own picture of a map behind every page, like its main menu (from your Counter-Strike 2 install).</p></div>
        <select class="input" data-menubg><option value="random">Random map</option><option value="off">Off</option></select></div>
      <div class="setting"><div>Auto-sell<p>Sell new drops automatically when they are worth less than an amount or have chosen rarities. <span data-aslabel>${esc(autoSellLabel())}</span></p></div><button class="btn" data-a="autosell">Set up…</button></div>
      <div class="setting"><div>Confirm sales above<p>Ask before selling items worth at least this much.</p></div><input class="input" type="number" min="0" step="1" value="${S.settings.confirmSellAbove}" style="width:110px" data-s="confirmSellAbove"></div>
      <div class="setting"><div>Market prices<p>Prices from ${D.pricedAt ? new Date(D.pricedAt).toLocaleString() : 'the bundled snapshot'}. Refreshing downloads the latest Skinport, CSFloat, Buff163, YouPin and Steam prices.</p>
        <div class="log" data-log></div></div>
        <div style="display:flex;gap:8px;flex-direction:column">
          <button class="btn primary" data-a="refresh" ${window.native && !online() ? '' : `disabled title="${online() ? 'Online play uses the server’s prices' : 'Available in the desktop app'}"`}>Refresh prices</button>
          <button class="btn ghost sm" data-a="resetprices" ${window.native ? '' : 'disabled'}>Use bundled prices</button>
        </div></div>
      <div class="setting"><div>Real CS2 models<p data-cs2>Checking for Counter-Strike 2…</p></div><button class="btn" data-a="cs2clear" ${window.native ? '' : 'disabled'}>Rebuild CS2 cache</button></div>
      <div class="setting prepare-all" data-prep hidden><div style="flex:1;min-width:0">Prepare all CS2 content
        <p>Exports every Play map, weapon model and skin texture, sticker, case, agent, icon and sound from your CS2 install now, so nothing has to be extracted the first time you open it. It runs in the background while you play, and can be stopped and carried on later. After a CS2 update only what the update changed is exported again. Maps only exports just the maps you can play and their sounds (up to a GB each), so a match on any of them starts without preparing the map first.</p>
        <div class="progress" data-prep-bar hidden style="margin:8px 0 4px"><i style="width:0%"></i></div>
        <p data-prep-step></p>
        <p data-prep-info></p>
        <label class="prepare-keep"><input type="checkbox" data-s="keepPrepared" ${S.settings.keepPrepared !== false ? 'checked' : ''}> Keep what you prepared up to date after CS2 updates</label></div>
        <div style="display:flex;gap:8px;flex-direction:column">
          <button class="btn primary" data-a="prepare">Prepare all</button>
          <button class="btn ghost sm" data-a="prepare-maps">Maps only</button>
        </div></div>
      <div class="setting prepare-all" data-compact hidden><div style="flex:1;min-width:0">Compress the CS2 cache
        <p>Windows keeps the cache's map geometry, models, sounds and data compressed on the drive and unpacks them in memory as the game reads them: nothing is unpacked onto the drive while you play, and nothing has to be compressed again afterwards. It saves about a quarter of the cache (its textures are compressed already). New exports are compressed when the game is idle, and each map as soon as Prepare has exported it.</p>
        <p data-compact-info></p></div>
        <input type="checkbox" data-s="compressCache" ${S.settings.compressCache !== false ? 'checked' : ''}></div>
      <div class="setting"><div>Image cache<p>Skin images are cached on disk after the first download so the game works offline.</p></div><button class="btn" data-a="clearcache" ${window.native ? '' : 'disabled'}>Clear cache</button></div>
      <div class="setting"><div>Reset progress<p>Deletes your money, inventory, upgrades and stats.</p></div><button class="btn danger" data-a="reset" ${online() ? 'disabled title="Log out to reset your offline save"' : ''}>Reset save</button></div>
    </div>

    <div class="section-title">About</div>
    <p class="muted" style="max-width:860px;line-height:1.6;font-size:13px">
      Fan-made simulator, not affiliated with or endorsed by Valve. Counter-Strike, CS2 and all item names and images are property of Valve Corporation.
      Item database: ByMykel CSGO-API (Steam CDN images). Market prices: Skinport public API plus CSFloat, Buff163, YouPin and Steam price feeds via csgotrader.app,
      blended as a median of third-party marketplaces. Drop odds follow Valve's published rates. Pattern tiers (blue gems, Fire &amp; Ice, fade %, diamonds...) follow community lists,
      most of them the CS.MONEY Wiki's rare patterns, and are approximations. No real money or items are involved.
      <br>Data built ${D.generatedAt ? new Date(D.generatedAt).toLocaleString() : '—'} · ${D.cases.filter((c) => c.kind === 'case').length} cases · ${Object.keys(D.skins).length} skins · ${Object.keys(D.stickers).length.toLocaleString()} stickers · ${Object.keys(D.agents).length} agents.
    </p>
  </div>`;

  root.querySelectorAll('[data-s]').forEach((el) => el.addEventListener('change', () => {
    const k = el.dataset.s;
    S.settings[k] = el.type === 'checkbox' ? el.checked : +el.value;
    save();
    if (k === 'volume') { emit('volume'); sfx.click(); }
    if (k === 'compressCache') setCompress(el.checked);
  }));
  root.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => action(b.dataset.a, b)));
  const bgSel = root.querySelector('[data-menubg]');
  bgSel.value = S.settings.menuBg === 'off' ? 'off' : 'random';
  backgroundMaps().then((maps) => {
    if (!maps.length || !bgSel.isConnected) { bgSel.disabled = !maps.length; return; }
    bgSel.insertAdjacentHTML('beforeend', maps.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join(''));
    bgSel.value = S.settings.menuBg && [...bgSel.options].some((o) => o.value === S.settings.menuBg) ? S.settings.menuBg : 'random';
  });
  bgSel.addEventListener('change', () => { S.settings.menuBg = bgSel.value; save(); setMenuBackground(bgSel.value); });
  cs2Status().then((st) => {
    const el = root?.querySelector('[data-cs2]');
    if (!el) return;
    el.textContent = st.available
      ? `Using your CS2 install (${st.gameDir}). Guns and knives are shown on their real models with CS2's own skin shader; models and textures are extracted the first time you inspect each weapon and cached.`
      : st.gameDir ? 'CS2 found, but the model extractor is missing. Showing icon-based 3D models.' : 'Counter-Strike 2 is not installed, so 3D inspect uses icon-based models.';
    if (st.available && window.native?.cs2PrepareAll) { root.querySelector('[data-prep]').hidden = false; watchPrepare(root); }
  });
}

const gb = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : Math.round(b / 1e6) + ' MB');

// The "Prepare all" row, kept up to date while the page is open: its progress, the cache's size, how many of Play's maps
// are made and when it last ran. Its two buttons start their kind of run; while one runs, its button stops it.
function watchPrepare(r) {
  const tick = async () => {
    if (root !== r || !r.isConnected) return;
    const st = await prepareStatus().catch(() => null);
    const row = r.querySelector('[data-prep]');
    if (!st || !row) return;
    const bar = row.querySelector('[data-prep-bar]'), m = st.maps;
    bar.hidden = !st.running;
    bar.firstElementChild.style.width = `${Math.min(100, (100 * st.done) / (st.total || 1)).toFixed(1)}%`;
    row.querySelector('[data-prep-step]').textContent = st.running ? `${st.step}${st.detail ? ' · ' + st.detail : ''} · ${Math.floor((100 * st.done) / (st.total || 1))}%`
      : st.step && st.step !== 'Done' ? st.step : '';
    const idle = {
      all: st.last && !st.last.outdated ? 'Check again' : 'Prepare all',
      maps: m?.last && !m.last.outdated && m.ready === m.total ? 'Check maps again' : 'Maps only',
    };
    for (const [kind, sel] of [['all', 'prepare'], ['maps', 'prepare-maps']]) {
      const btn = row.querySelector(`[data-a="${sel}"]`), mine = st.running && st.kind === kind, other = st.running && !mine;
      btn.textContent = !mine ? idle[kind] : !st.stopping ? 'Stop' : kind === 'maps' ? 'Stopping after this map…' : 'Stopping…';
      btn.disabled = other;
      btn.title = other ? 'Stop the one that’s running first' : '';
    }
    row.querySelector('[data-a="prepare"]').classList.toggle('primary', !st.running);
    const clear = r.querySelector('[data-a="cs2clear"]');
    if (clear) clear.disabled = st.running;
    const [size, packing] = await Promise.all([cacheSize().catch(() => null), compactStatus().catch(() => null)]);
    const parts = [], disk = size?.disk ?? size?.bytes;
    if (size) parts.push(`Cache: ${disk < size.bytes * 0.97 ? `${gb(disk)} (${gb(size.bytes)} uncompressed)` : gb(size.bytes)}${size.free != null ? ` · ${gb(size.free)} free on the drive` : ''}`);
    if (m?.total) parts.push(`Maps: ${m.ready} of ${m.total} ready${m.need && m.ready < m.total ? `, about ${gb(m.need)} more` : ''}`);
    const when = (rec, what) => `${what} ${new Date(rec.at).toLocaleString()}${rec.skipped ? ` (${rec.skipped} items weren't in your install)` : ''}${rec.outdated ? ' · CS2 has been updated since' : ''}`;
    parts.push(m?.last?.kind === 'maps' ? when(m.last, 'Maps last prepared') : st.last ? when(st.last, 'Last prepared') : 'Not prepared yet');
    row.querySelector('[data-prep-info]').textContent = parts.join(' · ');
    showCompact(r, packing, size);
    setTimeout(tick, st.running || packing?.running ? 1000 : 5000);
  };
  tick();
}

// The "Compress the CS2 cache" row: what compressing saves, or how far a pass has got (hidden where the game has no
// compression: off Windows, or a development run).
function showCompact(r, c, size) {
  const row = r.querySelector('[data-compact]');
  if (!row || !c || c.off) return;
  row.hidden = false;
  const box = row.querySelector('[data-s="compressCache"]'), saved = size ? size.bytes - (size.disk ?? size.bytes) : 0;
  box.disabled = c.supported === false;
  let text;
  if (c.supported === false) text = 'Not available here: Windows can only compress files on an NTFS drive.';
  else if (c.running && c.kind === 'compress') text = `Compressing… ${gb(c.done)} of ${gb(c.total)}`;
  else if (c.running) text = `Unpacking… ${Math.floor((100 * c.done) / (c.total || 1))}%`;
  else if (c.enabled === false) {
    text = c.needFree ? `Off: unpacking needs ${gb(c.needFree)} free, so what's compressed stays compressed (it reads the same)`
      : saved > 5e6 ? "Off: what's compressed is unpacked when the game is idle" : 'Off: the cache is stored uncompressed';
  } else {
    text = saved > 5e6 ? `Saves ${gb(saved)}` : 'Nothing compressed yet';
    if (size?.backlog > 0) text += ` · ${gb(size.backlog)} waiting, compressed when the game is idle`;
  }
  row.querySelector('[data-compact-info]').textContent = text;
}

async function action(a, btn) {
  if (a === 'autosell') return autoSellModal(() => { const el = root?.querySelector('[data-aslabel]'); if (el) el.textContent = autoSellLabel(); });
  if (a === 'reset') {
    if (!(await confirmDialog('Delete <b>all</b> progress? This cannot be undone.', { ok: 'Reset everything', danger: true }))) return;
    await resetSave();
    toast('Save reset. Fresh start with $10.', 'good');
    draw();
  }
  if (a === 'prepare' || a === 'prepare-maps') {
    const maps = a === 'prepare-maps';
    const st = await prepareStatus();
    if (st?.running) {
      // (A map being exported is made to its end: the run stops after it.)
      if (st.kind === (maps ? 'maps' : 'all')) { prepareCancel(); btn.textContent = maps ? 'Stopping after this map…' : 'Stopping…'; }
      return;
    }
    btn.disabled = true;
    try {
      if (await (maps ? prepareMaps() : prepareAll())) toast(maps ? 'Preparing the maps in the background. You can keep playing.' : 'Preparing all CS2 content in the background. You can keep playing.', 'good');
    } catch (e) { toast('Could not start: ' + e.message, 'bad'); }
    btn.disabled = false;
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
