// Play: offline CS2 practice against bots on real CS2 maps, with your equipped skins, gloves and knife.
import { esc } from '../util.js';
import { cs2Status } from '../cs2/api.js';
import { toast } from '../ui.js';

const PRIMARIES = [['weapon_ak47', 'AK-47'], ['weapon_m4a1', 'M4A4'], ['weapon_m4a1_silencer', 'M4A1-S'], ['weapon_awp', 'AWP'],
  ['weapon_galilar', 'Galil AR'], ['weapon_famas', 'FAMAS'], ['weapon_sg556', 'SG 553'], ['weapon_aug', 'AUG'], ['weapon_ssg08', 'SSG 08'],
  ['weapon_mp9', 'MP9'], ['weapon_mac10', 'MAC-10'], ['weapon_ump45', 'UMP-45'], ['weapon_p90', 'P90']];
const SECONDARIES = [['weapon_glock', 'Glock-18'], ['weapon_usp_silencer', 'USP-S'], ['weapon_hkp2000', 'P2000'], ['weapon_deagle', 'Desert Eagle'],
  ['weapon_p250', 'P250'], ['weapon_fiveseven', 'Five-SeveN'], ['weapon_tec9', 'Tec-9'], ['weapon_cz75a', 'CZ75-Auto']];
const MAPS = [['de_dust2', 'Dust II']];

const PREFS_KEY = 'cs2sim.play';
const DEFAULTS = { map: 'de_dust2', team: 'CT', primary: 'weapon_ak47', secondary: 'weapon_usp_silencer', bots: 8, sensitivity: 1.25, quality: 'balanced' };
function prefs() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
}
const savePrefs = (p) => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch {} };

let root = null, session = null;

export function render(r) {
  root = r;
  const p = prefs();
  const opts = (list, cur) => list.map(([id, n]) => `<option value="${id}" ${id === cur ? 'selected' : ''}>${esc(n)}</option>`).join('');
  r.innerHTML = `<div class="page play-page">
    <div class="page-head"><h1>Play</h1><span class="sub">Offline CS2 practice against bots, on real CS2 maps from your install, with your equipped skins.</span></div>
    <div class="play-lobby">
      <div class="play-maps">${MAPS.map(([id, n]) => `<button class="play-map ${id === p.map ? 'active' : ''}" data-map="${id}"><span>${esc(n)}</span></button>`).join('')}
        <div class="play-map soon"><span>More maps</span><small>coming soon</small></div></div>
      <div class="play-setup card">
        <label>Side<select class="input" data-k="team"><option value="CT" ${p.team === 'CT' ? 'selected' : ''}>Counter-Terrorists</option><option value="T" ${p.team === 'T' ? 'selected' : ''}>Terrorists</option></select></label>
        <label>Primary<select class="input" data-k="primary">${opts(PRIMARIES, p.primary)}</select></label>
        <label>Pistol<select class="input" data-k="secondary">${opts(SECONDARIES, p.secondary)}</select></label>
        <label>Bots<input class="input" type="number" min="1" max="20" data-k="bots" value="${p.bots}"></label>
        <label>Sensitivity (CS2)<input class="input" type="number" min="0.05" max="20" step="0.05" data-k="sensitivity" value="${p.sensitivity}"></label>
        <label>Graphics<select class="input" data-k="quality">${opts([['high', 'High (full resolution)'], ['balanced', 'Balanced'], ['performance', 'Performance']], p.quality)}</select></label>
        <button class="btn primary big" data-start>Play</button>
        <div class="muted play-keys">WASD move · Space jump · Ctrl crouch · Shift walk · Mouse1 fire · Mouse2 scope · R reload · F inspect · 1/2/3 weapons · Esc pause</div>
      </div>
    </div>
  </div>`;
  r.querySelectorAll('[data-map]').forEach((b) => b.addEventListener('click', () => { const q = prefs(); q.map = b.dataset.map; savePrefs(q); render(r); }));
  r.querySelectorAll('[data-k]').forEach((el) => el.addEventListener('change', () => {
    const q = prefs();
    q[el.dataset.k] = el.type === 'number' ? Number(el.value) : el.value;
    savePrefs(q);
  }));
  r.querySelector('[data-start]').addEventListener('click', () => start());
}

export function destroy() { root = null; }

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
  const game = new Game(overlay, { map: p.map, team: p.team, primary: p.primary, secondary: p.secondary, bots: p.bots, sensitivity: p.sensitivity, quality: p.quality, onStatus: (m) => { statusEl.textContent = m; } });
  session = { game, overlay };
  const showStats = () => {
    const s = game.stats;
    overlay.querySelector('[data-stats]').innerHTML = s.shots ? `<span><b>${s.kills}</b> kills</span><span><b>${s.kills ? Math.round((s.headshots / s.kills) * 100) : 0}%</b> headshots</span><span><b>${Math.round((s.hits / s.shots) * 100)}%</b> accuracy</span>` : '';
  };
  game.on((type, data) => {
    if (type === 'pause') { overlay.querySelector('.play-pause').classList.toggle('hidden', !data); if (data) showStats(); }
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
