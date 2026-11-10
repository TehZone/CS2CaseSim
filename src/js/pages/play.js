// Play: CS2 against bots on real CS2 maps from your install, with your equipped skins, gloves and knife. Matchmaking
// (CS2's Premier, Competitive, Wingman, Deathmatch and Arms Race) finds a match on the maps you pick, against bots of
// your rank (see matchmaking.js); a private match has everything up to you, the bots' ranks too, and moves no rank.
// In a match this page is its menu (Esc): Resume, your settings and keys, Leave, and Reconnect / Abandon once you've
// left a ranked one.
import { esc } from '../util.js';
import { cs2Play } from '../cs2/api.js';
import { MODES } from '../play/modes.js';
import { S } from '../state.js';
import { settingsHtml, bindSettings, playPrefs, savePlayPrefs, privateRanks } from './play-settings.js';
import { rankInfo, PLACEMENT_WINS } from '../engine/ranks.js';
import { loadRankArt, emblemHtml, rankKey, ratingHtml } from '../rank.js';
import { premierInfo, ACTIVE_DUTY } from '../engine/premier.js';
import { isRanked, cooldownLeft, formatWait, RECONNECT_S } from '../engine/matchmaking.js';
import { PRIVATE_RANKS } from '../play/skill.js';
import * as mm from '../matchmaking.js';

// Map art colours for the lobby cards (any other installed map gets a neutral card).
const MAP_TINT = { de_dust2: '#c9a46a, #7b5a33', de_mirage: '#d8b98a, #8a6a45', de_inferno: '#c98a5a, #6b3f22', de_nuke: '#8fa5b5, #3e4b57',
  de_ancient: '#7fa36a, #3c5a35', de_anubis: '#d6b97a, #6d5a3a', de_overpass: '#9fb0a0, #4a5a4c', de_vertigo: '#a8b8c8, #4c5a6a', de_train: '#9a9a8a, #4a4a40',
  cs_office: '#a0a8b8, #404858', cs_italy: '#d8a878, #7a5030' };
const MM_MODES = ['premier', 'competitive', 'wingman', 'deathmatch', 'armsrace'];
const PRIVATE_MODES = ['competitive', 'wingman', 'deathmatch', 'armsrace'];
// What matchmaking plays in each mode (CS2's rules: no options).
const MM_RULES = { premier: '5v5 · MR12, overtime on a tie · friendly fire', competitive: '5v5 · MR12, a draw on 12:12 · friendly fire',
  wingman: '2v2 on one bomb site · first to 9 · friendly fire', deathmatch: 'Free for all · 10 minutes', armsrace: 'Free for all · first to a knife kill' };
const KEYS = 'WASD move · Space jump · Ctrl crouch · Shift walk · W into a ladder climbs it · Mouse1 fire · Mouse2 scope / silencer / burst mode · R reload · F inspect · B buy · E defuse / pick up · G drop · 1/2/3 weapons (3 again for the Zeus) · 4 grenades (Mouse1 throw, Mouse2 lob) · 5 bomb (hold Mouse1 in a site) · Z / X / V radio (commands, reports, responses: your bots follow orders) · Middle mouse ping · Tab scores · Esc menu (the match goes on)';
let mapList = null, mapImages = null; // the installed maps, and CS2's screenshot of each ({ id: url })
let wingmanMaps = null; // CS2's Wingman maps among them (matchmaking.js mapsFor)
let rankAsked = false;
let root = null, unsub = null, ticker = null;
const nameOf = (id) => mapList?.find((m) => m.id === id)?.name || id;
const shareMaps = () => mm.setMaps({ maps: mapList, images: mapImages, nameOf, wingman: wingmanMaps });

export function render(r) {
  root = r;
  if (!mapList) {
    mapList = [{ id: 'de_dust2', name: 'Dust II' }];
    cs2Play('maps').then((list) => {
      const bomb = (list || []).filter((m) => /^de_/.test(m.id)); // bomb defusal maps
      if (bomb.length) { mapList = bomb; shareMaps(); if (root === r) render(r); }
    }).catch(() => {});
    cs2Play('wingmanMaps').catch(() => ({ pool: [], fixed: [] })).then((w) => { wingmanMaps = w; shareMaps(); if (root === r) render(r); });
  }
  if (!rankAsked) { rankAsked = true; loadRankArt().then((a) => { if (a && root === r) render(r); }); }
  if (!mapImages) {
    mapImages = {};
    cs2Play('mapImages').then((imgs) => { mapImages = imgs || {}; shareMaps(); if (root === r) render(r); }).catch(() => {});
  }
  shareMaps();
  unsub ||= mm.onMatchmaking(() => { if (root) render(root); });
  clearInterval(ticker);
  ticker = setInterval(tick, 500);
  const live = mm.liveMatch();
  if (live && !live.loading) liveHtml(r, live); else lobbyHtml(r);
  tick();
}

export function destroy() { root = null; unsub?.(); unsub = null; clearInterval(ticker); }

// The times that count down on the page: the search, the cooldown, the time left to reconnect.
function tick() {
  if (!root) return;
  const s = mm.searching(), live = mm.liveMatch(), clock = (ms) => { const t = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
  const go = root.querySelector('[data-go]');
  if (go && s) go.innerHTML = `${s.state === 'found' ? 'Match found' : `Searching ${clock(Date.now() - s.started)}`}<small>Cancel</small>`;
  const cd = root.querySelector('[data-cooldown]');
  if (cd) {
    const left = cooldownLeft(S.mm);
    if (left) cd.textContent = formatWait(left); else render(root);
  }
  const rc = root.querySelector('[data-reconnect-left]');
  if (rc && live?.away) rc.textContent = clock(RECONNECT_S * 1000 - (Date.now() - live.away.since));
  const sc = root.querySelector('[data-live-score]');
  if (sc && live?.game.match) sc.textContent = mm.scoreLine(live.game);
}

// A map tile's background: the map's screenshot (an absolute URL: relative ones in a custom property resolve against
// the stylesheet), over its tint.
const tileStyle = (id) => [mapImages[id] && `--img: url('${new URL(mapImages[id], location.href).href}')`, MAP_TINT[id] && `--tint: linear-gradient(160deg, ${MAP_TINT[id]} 70%, #1a1712)`].filter(Boolean).join(';');
const opts = (list, cur) => list.map(([id, n]) => `<option value="${id}" ${id === cur ? 'selected' : ''}>${esc(n)}</option>`).join('');

// ---- the lobby ----------------------------------------------------------------------------------------------------------
function lobbyHtml(r) {
  const p = playPrefs(), priv = p.lobby === 'private';
  const modes = priv ? PRIVATE_MODES : MM_MODES;
  const mode = modes.includes(p.mode) ? p.mode : 'competitive';
  const search = mm.searching(), busy = !!search || !!mm.liveMatch();
  const premier = !priv && mode === 'premier';
  const pool = priv ? [] : mm.poolOf(p, mode);
  const cooldown = !priv && isRanked(mode) ? cooldownLeft(S.mm) : 0;
  const map = priv ? mm.privateMap(p, mode) : null;
  const tiles = (premier ? mapList.filter((m) => ACTIVE_DUTY.includes(m.id)) : mm.mapsFor(mode)).map(({ id, name }) => {
    const on = priv ? id === map : !premier && pool.includes(id);
    const sub = premier ? 'Active Duty: picked by banning' : priv ? (id === 'de_dust2' ? 'Recommended' : 'The first match prepares the map (a couple of minutes)')
      : on ? 'In your search' : 'Click to add to your search';
    return `<button class="play-map ${on ? 'active' : ''} ${priv ? '' : 'pick'}" data-map="${id}" style="${tileStyle(id)}" ${premier || (busy && !priv) ? 'disabled' : ''}>
      <span>${esc(name)}</span><small>${sub}</small></button>`;
  }).join('');
  r.innerHTML = `<div class="page play-page">
    <div class="page-head"><h1>Play</h1><span class="sub">CS2 against bots, on real CS2 maps from your install, with your equipped skins, gloves and knife.</span></div>
    <div class="play-tabs">
      <button class="${priv ? '' : 'active'}" data-lobby="mm"><b>Matchmaking</b><small>Bots of your rank, on the maps you pick</small></button>
      <button class="${priv ? 'active' : ''}" data-lobby="private"><b>Private match</b><small>Your rules and the bots' ranks; no rank</small></button>
    </div>
    <div class="play-lobby">
      <div class="play-maps ${premier ? 'veto-pool' : ''}">${tiles || (mode === 'wingman' ? `<div class="muted">${wingmanMaps ? 'None of CS2\'s Wingman maps are installed.' : 'Reading CS2\'s Wingman maps…'}</div>` : '')}</div>
      <div class="play-setup panel">
        <div class="play-modes">${modes.map((id) => `<button class="${id === mode ? 'active' : ''}" data-mode="${id}" ${busy && !priv ? 'disabled' : ''}><b>${esc(MODES[id].name)}</b><small>${esc(priv ? MODES[id].blurb : MM_RULES[id])}</small></button>`).join('')}</div>
        ${priv ? privateOptions(p, mode, map) : mmOptions(p, mode, pool, premier)}
        <label>Sensitivity (CS2)<input class="input" type="number" min="0.05" max="20" step="0.05" data-k="sensitivity" value="${p.sensitivity}"></label>
        <label>Graphics<select class="input" data-k="quality">${opts([['high', 'High (full resolution, soft shadows)'], ['balanced', 'Medium'], ['performance', 'Low (no 3D skybox, no anti-aliasing)']], p.quality)}</select></label>
        ${cooldown ? `<div class="play-cooldown"><b>Ranked cooldown</b><span>You abandoned a match: no Premier, Competitive or Wingman for <b data-cooldown>${formatWait(cooldown)}</b>.</span></div>` : ''}
        ${priv ? `<button class="btn primary big" data-start ${busy || !map ? 'disabled' : ''}>Start</button>${search ? '<div class="muted">Cancel your search to start a private match.</div>' : ''}`
          : search ? `<button class="btn primary big searching" data-go></button>`
          : `<button class="btn primary big" data-go ${cooldown || busy || (!premier && !pool.length) ? 'disabled' : ''}>Go</button>`}
        ${priv ? '<div class="muted play-private-note">Private matches are practice: they pay a reward but move no rank.</div>' : rankCard(mode)}
        ${record()}
        <div class="muted play-keys">${KEYS}</div>
      </div>
    </div>
    ${settingsHtml(p)}
  </div>`;
  bindSettings(r, playPrefs, savePlayPrefs, () => render(r));
  const set = (fn) => { const q = playPrefs(); fn(q); savePlayPrefs(q); render(r); };
  r.querySelectorAll('[data-lobby]').forEach((b) => b.addEventListener('click', () => set((q) => { q.lobby = b.dataset.lobby; })));
  r.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => set((q) => { q.mode = b.dataset.mode; })));
  r.querySelectorAll('[data-map]').forEach((b) => b.addEventListener('click', () => set((q) => {
    if (priv) { q.map = b.dataset.map; return; }
    // Matchmaking: the maps the search picks from, each on or off (CS2 keeps a list per mode).
    const list = new Set(mm.poolOf(q, mode));
    if (list.has(b.dataset.map)) list.delete(b.dataset.map); else list.add(b.dataset.map);
    q.pools = { ...(q.pools || {}), [mode]: [...list] };
  })));
  r.querySelectorAll('[data-pool]').forEach((b) => b.addEventListener('click', () => set((q) => { q.pools = { ...(q.pools || {}), [mode]: b.dataset.pool === 'all' ? mm.mapsFor(mode).map((m) => m.id) : [] }; })));
  r.querySelectorAll('[data-k]').forEach((el) => el.addEventListener('change', () => {
    const q = playPrefs(), k = el.dataset.k;
    if (k.startsWith('ranks.')) q.ranks = { ...privateRanks(q), [k.slice(6)]: el.value };
    else q[k] = el.type === 'number' || k === 'teamSize' || k === 'minutes' ? Number(el.value) : el.value;
    savePlayPrefs(q);
    if (k === 'ffa' || k === 'mode') render(r);
  }));
  r.querySelector('[data-start]')?.addEventListener('click', () => mm.startPrivate());
  r.querySelector('[data-go]')?.addEventListener('click', () => (mm.searching() ? mm.cancelSearch() : mm.startSearch()));
}

// Matchmaking's choices: only the maps (none at all for Premier, which bans).
function mmOptions(p, mode, pool, premier) {
  if (premier) return '<div class="play-pool muted">Premier picks its map from the Active Duty pool by banning, once the match is found.</div>';
  return `<div class="play-pool"><span><b>${pool.length}</b> map${pool.length === 1 ? '' : 's'} in your search${pool.length ? `: ${esc(pool.map(nameOf).join(', '))}` : ''}</span>
    <span><button class="btn ghost sm" data-pool="all">All</button><button class="btn ghost sm" data-pool="none">None</button></span></div>`;
}

// A private match's choices: the side, the team size (in Wingman the bomb site, on a map without its own), the rules and
// the bots' ranks.
function privateOptions(p, mode, map) {
  const rounds = !MODES[mode].respawn, ffa = mode === 'armsrace' || (mode === 'deathmatch' && p.ffa === 'ffa');
  const ranks = privateRanks(p);
  const rankSelect = (k, label) => `<label>${label}<select class="input" data-k="ranks.${k}">${PRIVATE_RANKS.map((t) => `<optgroup label="${esc(t.name)}">
      <option value="${t.id}" ${ranks[k] === t.id ? 'selected' : ''}>Any ${esc(t.name)}</option>${t.groups.map(([id, n]) => `<option value="${id}" ${ranks[k] === id ? 'selected' : ''}>${esc(n)}</option>`).join('')}</optgroup>`).join('')}</select></label>`;
  const per = rounds || !ffa;
  return `${!ffa ? `<label>Side<select class="input" data-k="team"><option value="CT" ${p.team === 'CT' ? 'selected' : ''}>Counter-Terrorists</option><option value="T" ${p.team === 'T' ? 'selected' : ''}>Terrorists</option></select></label>` : ''}
    ${mode === 'wingman' ? (mm.fixedSite(map) ? '' : `<label>Bomb site<select class="input" data-k="site">${opts([['A', 'A'], ['B', 'B']], p.site)}</select></label>`)
      : `<label>${per ? 'Players per team' : 'Players'}<select class="input" data-k="teamSize">${opts([5, 4, 3, 2, 1].map((n) => [String(n), per ? `${n}v${n}` : String(n * 2)]), String(p.teamSize))}</select></label>`}
    ${mode === 'deathmatch' ? `<label>Deathmatch<select class="input" data-k="ffa">${opts([['ffa', 'Free for all'], ['team', 'Teams']], p.ffa)}</select></label>` : ''}
    ${!rounds ? `<label>Length<select class="input" data-k="minutes">${opts([['5', '5 minutes'], ['10', '10 minutes'], ['15', '15 minutes']], String(p.minutes))}</select></label>` : ''}
    ${ffa ? rankSelect('B', "Bots' ranks") : `${rankSelect('A', "Your teammates' ranks")}${rankSelect('B', "Opponents' ranks")}`}
    ${mode === 'competitive' ? `<label>Match length<select class="input" data-k="length">${opts([['short', 'Short (first to 9)'], ['long', 'Long (first to 13)']], p.length)}</select></label>` : ''}
    ${rounds ? `<label>Overtime<select class="input" data-k="overtime">${opts([['on', 'On (MR3, $12,500)'], ['off', 'Off (ties are draws)']], p.overtime)}</select></label>` : ''}
    ${!ffa ? `<label>Friendly fire<select class="input" data-k="friendlyFire">${opts([['off', 'Off'], ['on', 'On (CS2 competitive)']], p.friendlyFire)}</select></label>` : ''}`;
}

// Your rank in the mode (Wingman has its own; Premier is a CS Rating), and how the bots are found.
function rankCard(mode) {
  if (mode === 'premier') return premierCard();
  if (mode !== 'competitive' && mode !== 'wingman') return `<div class="play-rank off"><div><small>${esc(MODES[mode].name)}</small><b>No rank</b><span>Bots around your competitive rank. Casual: leave whenever you like.</span></div></div>`;
  const wingman = mode === 'wingman', r = (wingman ? S.wingman : S.rank) || {}, info = rankInfo(r);
  const name = info.expired ? 'Rank expired' : info.group ? info.name : 'Unranked';
  const sub = info.needWins ? `${info.needWins} more ${wingman ? 'wingman' : 'competitive'} win${info.needWins === 1 ? '' : 's'} to get your rank (${PLACEMENT_WINS - info.needWins}/${PLACEMENT_WINS})`
    : info.expired ? 'Win a match to show it again' : `${r.wins || 0} wins · ${r.losses || 0} losses · ${r.ties || 0} ties`;
  return `<div class="play-rank">${emblemHtml(rankKey(info), { size: 46, wingman })}<div><small>${wingman ? 'Wingman rank' : 'Competitive rank'}</small><b>${esc(name)}</b><span>${esc(sub)}</span>
    <span class="play-rank-bots">${info.group ? 'Bots are matched to your rank' : 'Bots are matched to your hidden rating until you\'re placed'}</span></div></div>`;
}

// Your CS Rating (Premier): the badge, or the wins still needed to get one.
function premierCard() {
  const p = S.premier || {}, info = premierInfo(p);
  const sub = info.rated ? `${p.wins || 0} wins · ${p.losses || 0} losses · ${p.ties || 0} ties${p.best ? ' · best ' + ratingHtml(p.best, { size: 11 }) : ''}`
    : `${info.needWins} more Premier win${info.needWins === 1 ? '' : 's'} to get your CS Rating (${PLACEMENT_WINS - info.needWins}/${PLACEMENT_WINS})`;
  return `<div class="play-rank premier"><div class="play-rating">${ratingHtml(info.rating, { size: 22 })}</div><div><small>CS Rating · Premier</small><b>${info.rated ? 'Rated' : 'Unrated'}</b><span>${sub}</span>
    <span class="play-rank-bots">${info.rated ? 'Bots are matched to your CS Rating' : 'Bots are matched to your hidden rating until you\'re rated'}</span></div></div>`;
}

// Your Play record (offline matches): played, won, kills and what they paid.
function record() {
  const st = S.stats || {};
  if (!st.playMatches) return '<div class="muted play-record">Finished matches pay into your wallet (offline): kills, MVPs, rounds and wins, more against better bots.</div>';
  return `<div class="play-record"><span><b>${st.playMatches}</b> matches</span><span><b>${st.playWins || 0}</b> wins</span><span><b>${st.playKills || 0}</b> kills</span><span><b>$${(st.playEarned || 0).toFixed(2)}</b> earned</span></div>`;
}

// ---- in a match: its menu ---------------------------------------------------------------------------------------------
function liveHtml(r, live) {
  const p = playPrefs(), away = !!live.away, name = MODES[live.mode]?.name || live.mode;
  const links = [['cases', 'Cases'], ['market', 'Market'], ['inventory', 'Inventory'], ['database', 'Item Database']];
  r.innerHTML = `<div class="page play-page">
    <div class="page-head"><h1>${away ? 'Match in progress' : 'In a match'}</h1><span class="sub">${esc(name)}${live.private ? ' (private)' : ''} · ${esc(nameOf(live.map))}</span></div>
    <div class="play-live panel ${away ? 'away' : ''}">
      <div class="play-live-score"><small>${esc(name)} · ${esc(nameOf(live.map))}</small><b data-live-score></b></div>
      ${away ? `<p>You left the match: it's going on without you. Reconnect within <b data-reconnect-left></b> or it's abandoned: a loss, and a cooldown from ranked matchmaking.</p>
        <div class="play-live-actions"><button class="btn primary big" data-reconnect>Reconnect</button><button class="btn danger" data-abandon>Abandon match</button></div>`
      : `<p>${live.game.matchOver ? 'The match is over.' : 'The match goes on while you\'re in the menu.'} ${live.ranked && !live.game.matchOver ? 'Leaving it, you can reconnect for 5 minutes.' : ''}</p>
        <div class="play-live-actions">${live.game.matchOver ? '' : '<button class="btn primary big" data-resume>Resume</button>'}<button class="btn ${live.ranked && !live.game.matchOver ? 'danger' : ''}" data-leave>${live.game.matchOver ? 'Back to the lobby' : 'Leave match'}</button></div>`}
      <div class="play-live-links">${links.map(([id, n]) => `<button class="btn ghost" data-page-go="${id}">${n}</button>`).join('')}</div>
    </div>
    <div class="play-setup panel play-live-opts"><label>Sensitivity (CS2)<input class="input" type="number" min="0.05" max="20" step="0.05" data-k="sensitivity" value="${p.sensitivity}"></label></div>
    ${settingsHtml(p, { open: true })}
  </div>`;
  const save = (q) => { savePlayPrefs(q); mm.settingsChanged(); };
  bindSettings(r, playPrefs, save, () => render(r));
  r.querySelector('[data-k=sensitivity]').addEventListener('change', (e) => {
    const q = playPrefs();
    q.sensitivity = Math.max(0.05, Math.min(20, Number(e.target.value) || 1));
    save(q);
  });
  r.querySelector('[data-resume]')?.addEventListener('click', () => mm.resume());
  r.querySelector('[data-leave]')?.addEventListener('click', () => mm.leave());
  r.querySelector('[data-reconnect]')?.addEventListener('click', () => mm.reconnect());
  r.querySelector('[data-abandon]')?.addEventListener('click', () => mm.abandon());
  r.querySelectorAll('[data-page-go]').forEach((b) => b.addEventListener('click', () => window.dispatchEvent(new CustomEvent('app:go', { detail: b.dataset.pageGo }))));
}
