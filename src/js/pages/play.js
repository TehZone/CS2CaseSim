// Play: offline CS2 practice against bots on real CS2 maps, with your equipped skins, gloves and knife.
import { esc } from '../util.js';
import { cs2Status, cs2Play } from '../cs2/api.js';
import { toast } from '../ui.js';
import { MODES } from '../play/modes.js';
import { S } from '../state.js';
import { settingsHtml, bindSettings, matchSettings, SETTINGS_DEFAULTS } from './play-settings.js';

// Map art colours for the lobby cards (any other installed map gets a neutral card).
const MAP_TINT = { de_dust2: '#c9a46a, #7b5a33', de_mirage: '#d8b98a, #8a6a45', de_inferno: '#c98a5a, #6b3f22', de_nuke: '#8fa5b5, #3e4b57',
  de_ancient: '#7fa36a, #3c5a35', de_anubis: '#d6b97a, #6d5a3a', de_overpass: '#9fb0a0, #4a5a4c', de_vertigo: '#a8b8c8, #4c5a6a', de_train: '#9a9a8a, #4a4a40',
  cs_office: '#a0a8b8, #404858', cs_italy: '#d8a878, #7a5030' };
let mapList = null;

const PREFS_KEY = 'cs2sim.play';
const DEFAULTS = { map: 'de_dust2', mode: 'competitive', site: 'A', ffa: 'ffa', minutes: 10, team: 'CT', teamSize: 5, difficulty: 'normal', length: 'short', overtime: 'on', friendlyFire: 'off', sensitivity: 1.25, quality: 'balanced', ...SETTINGS_DEFAULTS };
function prefs() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
}
const savePrefs = (p) => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch {} };

let root = null, session = null;

export function render(r) {
  root = r;
  const p = prefs();
  if (!mapList) {
    mapList = [{ id: 'de_dust2', name: 'Dust II' }];
    cs2Play('maps').then((list) => {
      const bomb = (list || []).filter((m) => /^de_/.test(m.id)); // bomb defusal maps
      if (bomb.length) { mapList = bomb; if (root === r) render(r); }
    }).catch(() => {});
  }
  const opts = (list, cur) => list.map(([id, n]) => `<option value="${id}" ${id === cur ? 'selected' : ''}>${esc(n)}</option>`).join('');
  const mode = MODES[p.mode] ? p.mode : 'competitive', rounds = !MODES[mode].respawn;
  r.innerHTML = `<div class="page play-page">
    <div class="page-head"><h1>Play</h1><span class="sub">Offline CS2 against bots, on real CS2 maps from your install, with your equipped skins, gloves and knife.</span></div>
    <div class="play-lobby">
      <div class="play-maps">${mapList.map(({ id, name }) => `<button class="play-map ${id === p.map ? 'active' : ''}" data-map="${id}" style="${MAP_TINT[id] ? `--tint: linear-gradient(160deg, ${MAP_TINT[id]} 70%, #1a1712)` : ''}">
          <span>${esc(name)}</span><small>${id === 'de_dust2' ? 'Recommended' : 'The first match prepares the map (a couple of minutes)'}</small></button>`).join('')}</div>
      <div class="play-setup card">
        <div class="play-modes">${Object.entries(MODES).map(([id, m]) => `<button class="${id === mode ? 'active' : ''}" data-mode="${id}"><b>${esc(m.name)}</b><small>${esc(m.blurb)}</small></button>`).join('')}</div>
        ${mode !== 'armsrace' && !(mode === 'deathmatch' && p.ffa === 'ffa') ? `<label>Side<select class="input" data-k="team"><option value="CT" ${p.team === 'CT' ? 'selected' : ''}>Counter-Terrorists</option><option value="T" ${p.team === 'T' ? 'selected' : ''}>Terrorists</option></select></label>` : ''}
        ${mode === 'wingman' ? `<label>Bomb site<select class="input" data-k="site">${opts([['A', 'A'], ['B', 'B']], p.site)}</select></label>`
          : `<label>${rounds || p.ffa !== 'ffa' ? 'Players per team' : 'Players'}<select class="input" data-k="teamSize">${opts([['5', rounds || p.ffa !== 'ffa' ? '5v5' : '10'], ['4', rounds || p.ffa !== 'ffa' ? '4v4' : '8'], ['3', rounds || p.ffa !== 'ffa' ? '3v3' : '6'], ['2', rounds || p.ffa !== 'ffa' ? '2v2' : '4'], ['1', rounds || p.ffa !== 'ffa' ? '1v1' : '2']], String(p.teamSize))}</select></label>`}
        ${mode === 'deathmatch' ? `<label>Deathmatch<select class="input" data-k="ffa">${opts([['ffa', 'Free for all'], ['team', 'Teams']], p.ffa)}</select></label>` : ''}
        ${!rounds ? `<label>Length<select class="input" data-k="minutes">${opts([['5', '5 minutes'], ['10', '10 minutes'], ['15', '15 minutes']], String(p.minutes))}</select></label>` : ''}
        <label>Bot difficulty<select class="input" data-k="difficulty">${opts([['easy', 'Easy'], ['normal', 'Normal'], ['hard', 'Hard'], ['expert', 'Expert']], p.difficulty)}</select></label>
        ${mode === 'competitive' ? `<label>Match length<select class="input" data-k="length">${opts([['short', 'Short (first to 9)'], ['long', 'Long (first to 13)']], p.length)}</select></label>` : ''}
        ${rounds ? `<label>Overtime<select class="input" data-k="overtime">${opts([['on', 'On (MR3, $12,500)'], ['off', 'Off (ties are draws)']], p.overtime)}</select></label>` : ''}
        ${rounds || p.ffa !== 'ffa' ? `<label>Friendly fire<select class="input" data-k="friendlyFire">${opts([['off', 'Off'], ['on', 'On (CS2 competitive)']], p.friendlyFire)}</select></label>` : ''}
        <label>Sensitivity (CS2)<input class="input" type="number" min="0.05" max="20" step="0.05" data-k="sensitivity" value="${p.sensitivity}"></label>
        <label>Graphics<select class="input" data-k="quality">${opts([['high', 'High (full resolution)'], ['balanced', 'Balanced'], ['performance', 'Performance']], p.quality)}</select></label>
        <button class="btn primary big" data-start>Play</button>
        ${record()}
        <div class="muted play-keys">WASD move · Space jump · Ctrl crouch · Shift walk · W into a ladder climbs it · Mouse1 fire · Mouse2 scope / silencer / burst mode · R reload · F inspect · B buy · E defuse / pick up · G drop · 1/2/3 weapons (3 again for the Zeus) · 4 grenades (Mouse1 throw, Mouse2 lob) · 5 bomb (hold Mouse1 in a site) · Z / X / V radio (commands, reports, responses: your bots follow orders) · Tab scores · Esc pause</div>
      </div>
    </div>
    ${settingsHtml(p)}
  </div>`;
  bindSettings(r, prefs, savePrefs, () => render(r));
  r.querySelectorAll('[data-map]').forEach((b) => b.addEventListener('click', () => { const q = prefs(); q.map = b.dataset.map; savePrefs(q); render(r); }));
  r.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { const q = prefs(); q.mode = b.dataset.mode; savePrefs(q); render(r); }));
  r.querySelectorAll('[data-k]').forEach((el) => el.addEventListener('change', () => {
    const q = prefs();
    q[el.dataset.k] = el.type === 'number' || el.dataset.k === 'teamSize' || el.dataset.k === 'minutes' ? Number(el.value) : el.value;
    savePrefs(q);
    if (el.dataset.k === 'ffa') render(r);
  }));
  r.querySelector('[data-start]').addEventListener('click', () => start());
}

export function destroy() { root = null; }

// Your Play record (offline matches): played, won, kills and what they paid.
function record() {
  const st = S.stats || {};
  if (!st.playMatches) return '<div class="muted play-record">Finished matches pay into your wallet (offline): kills, MVPs, rounds and wins, more on harder bots.</div>';
  return `<div class="play-record"><span><b>${st.playMatches}</b> matches</span><span><b>${st.playWins || 0}</b> wins</span><span><b>${st.playKills || 0}</b> kills</span><span><b>$${(st.playEarned || 0).toFixed(2)}</b> earned</span></div>`;
}

async function start() {
  const st = await cs2Status();
  if (!st.available) { toast(st.gameDir ? 'The model extractor is missing.' : 'Play mode needs Counter-Strike 2 installed on this PC.', 'bad'); return; }
  if (session) return;
  const p = prefs();
  const { Game } = await import('../play/game.js');
  const overlay = document.createElement('div');
  overlay.className = 'play-root';
  overlay.innerHTML = `<div class="play-loading"><div class="spinner"></div><div data-status>Loading…</div><button class="btn ghost" data-cancel>Cancel</button></div>
    <div class="play-pause hidden"><div class="play-pause-box"><h2>Paused</h2><div class="play-stats" data-stats></div>
      <label class="play-sens">Sensitivity <input class="input" type="number" min="0.05" max="20" step="0.05" data-sens value="${p.sensitivity}"></label>
      <button class="btn primary" data-resume>Resume</button><button class="btn danger" data-leave>Leave match</button></div></div>`;
  document.body.appendChild(overlay);
  const statusEl = overlay.querySelector('[data-status]');
  const leave = () => {
    session?.game.dispose();
    session = null;
    overlay.remove();
  };
  overlay.querySelector('[data-cancel]').addEventListener('click', leave);
  overlay.querySelector('[data-leave]').addEventListener('click', leave);
  overlay.querySelector('[data-resume]').addEventListener('click', () => session?.game.resume());
  const game = new Game(overlay, { map: p.map, mode: p.mode, site: p.site, ffa: p.ffa !== 'team', minutes: p.minutes, team: p.team, teamSize: p.teamSize, difficulty: p.difficulty, length: p.length, overtime: p.overtime !== 'off', friendlyFire: p.friendlyFire === 'on', sensitivity: p.sensitivity, quality: p.quality, settings: matchSettings(p), onStatus: (m) => { statusEl.textContent = m; } });
  session = { game, overlay };
  const showStats = () => {
    const me = game.me, m = game.match;
    overlay.querySelector('[data-stats]').innerHTML = me && m ? `<span>Round <b>${m.round}</b></span><span><b>${me.kills}</b> kills</span><span><b>${me.deaths}</b> deaths</span>${me.shots ? `<span><b>${Math.round(((me.hits || 0) / me.shots) * 100)}%</b> accuracy</span>` : ''}` : '';
  };
  game.on((type, data) => {
    if (type === 'pause') { overlay.querySelector('.play-pause').classList.toggle('hidden', !data); if (data) showStats(); }
    if (type === 'over') {
      overlay.querySelector('.play-pause h2').textContent = data.draw ? 'Draw' : data.won ? 'Victory' : 'Defeat';
      overlay.querySelector('[data-resume]').classList.add('hidden');
      overlay.querySelector('.play-sens').classList.add('hidden');
      overlay.querySelector('[data-leave]').textContent = 'Back to lobby';
      overlay.querySelector('.play-pause').classList.add('over');
      overlay.querySelector('.play-pause').classList.remove('hidden');
    }
  });
  overlay.querySelector('[data-sens]').addEventListener('change', (e) => {
    const v = Math.max(0.05, Math.min(20, Number(e.target.value) || 1));
    game.setSensitivity(v);
    const q = prefs(); q.sensitivity = v; savePrefs(q);
  });
  try {
    await game.load();
  } catch (e) {
    console.error(e);
    toast('Could not start the match: ' + esc(e.message || String(e)), 'bad');
    leave();
    return;
  }
  if (!session) return;
  overlay.querySelector('.play-loading').remove();
  overlay.querySelector('.play-pause').classList.remove('hidden');
  overlay.querySelector('.play-pause h2').textContent = 'Ready';
  overlay.querySelector('[data-resume]').textContent = 'Click to play';
  game.on((type) => { if (type === 'pause') { overlay.querySelector('.play-pause h2').textContent = 'Paused'; overlay.querySelector('[data-resume]').textContent = 'Resume'; } });
  game.start();
  if (window.__cs2Debug) window.__playGame = game;
}
