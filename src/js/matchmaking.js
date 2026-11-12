// Play's matchmaking, like CS2's. A search (its timer in the top bar) goes on while you use the rest of the game: the
// match it will find is set up meanwhile, its map one of the maps you picked at random and its players each a bot of
// its own rank around yours (skill.js matchedSkill), and loaded out of sight, so once it's found (accept it within 20
// seconds) you're straight in. Premier picks its map by banning after it's found, then loads it.
// In a match, Esc opens the menu over it and the match goes on: the whole game is there (cases, the market, your
// inventory, the item database), and the Play page has your settings and keys, Resume and Leave. Leaving a ranked
// match (Premier, Competitive, Wingman) isn't the end of it: Reconnect puts you back in (the first time your team calls
// a technical timeout for you), Abandon gives it up; not back within 5 minutes is an abandon too: a loss and a cooldown
// from ranked matchmaking (engine/matchmaking.js). A private match, or Deathmatch and Arms Race, you simply leave.
import { esc } from './util.js';
import { S } from './state.js';
import { act } from './backend.js';
import { toast, topModal, confirmDialog } from './ui.js';
import { sfx } from './audio.js';
import { cs2Status } from './cs2/api.js';
import { MODES } from './play/modes.js';
import { isRanked, RECONNECT_S, nextCooldown, formatWait } from './engine/matchmaking.js';
import { matchmakingMmr } from './engine/ranks.js';
import { START_RATING, ACTIVE_DUTY } from './engine/premier.js';
import { matchedSkill, privateSkill, ratingOfSkill, groupOfSkill } from './play/skill.js';
import { botIdentities, pickIdentities } from './play/identity.js';
import { playPrefs, savePlayPrefs, matchSettings, privateRanks } from './pages/play-settings.js';
import { equipped } from './loadout.js';
import { BINDS_VERSION } from './play/input.js';
import { premierVeto } from './pages/veto.js';

// How long a search takes before it finds the match (seconds, at random between; and never before the map's loaded).
const SEARCH_S = { premier: [12, 50], competitive: [8, 40], wingman: [6, 30], deathmatch: [3, 12], armsrace: [3, 12] };
const ACCEPT_S = 20;
// The players in each mode's match besides you: your team (A) and the other (B; everyone in free for all).
const SIZES = { premier: { A: 4, B: 5 }, competitive: { A: 4, B: 5 }, wingman: { A: 1, B: 2 }, deathmatch: { A: 0, B: 9 }, armsrace: { A: 0, B: 9 } };

let search = null; // the match being looked for: { mode, started, wait, map, site, team, roster, game, overlay, ready, state }
let live = null; // the match you're in, or have left and can go back to: { mode, ranked, map, game, overlay, menu, away }
let ctx = { maps: [], images: {}, nameOf: (id) => id, wingman: null }; // the installed maps, set by the Play page (wingman: see mapsFor)
const subs = new Set();

export const searching = () => search;
export const liveMatch = () => live;
// Something about matchmaking changed (the Play page draws itself again).
export const onMatchmaking = (fn) => { subs.add(fn); return () => subs.delete(fn); };
const changed = () => { drawBar(); for (const fn of subs) fn(); };
const go = (page) => window.dispatchEvent(new CustomEvent('app:go', { detail: page }));
const modeName = (mode) => MODES[mode]?.name || mode;
// A map's name, as the Play page has it (pvp.js's loading screen).
export const mapName = (id) => ctx.nameOf(id);
export function setMaps({ maps, images, nameOf, wingman }) { ctx = { maps, images: images || {}, nameOf: nameOf || ((id) => id), wingman: wingman || null }; }
// The maps a mode can play: any installed one, but for Wingman only CS2's Wingman maps (none till they've been read:
// cs2.playWingmanMaps's pool).
export const mapsFor = (mode) => (mode === 'wingman' ? ctx.maps.filter((m) => ctx.wingman?.pool.includes(m.id)) : ctx.maps);
// A private match's map: the one you picked, or the first Wingman map if that isn't one.
export function privateMap(p, mode) {
  const list = mapsFor(mode);
  return mode !== 'wingman' || list.some((m) => m.id === p.map) ? p.map : list[0]?.id || null;
}
// Is this Wingman map's bomb site its own (no choosing one)?
export const fixedSite = (id) => !!ctx.wingman?.fixed.includes(id);

// ---- who you play with and against ----------------------------------------------------------------------------------
// Matchmaking's bots: each its own rank around yours (your CS Rating in Premier, your Wingman rank in Wingman, else
// your competitive rank), the hidden rating while you're still unranked.
async function matchRoster(mode) {
  const n = SIZES[mode], ids = pickIdentities(await botIdentities().catch(() => []), n.A + n.B);
  const base = mode === 'premier' ? { rating: { rating: START_RATING, ...(S.premier || {}) }.rating } : { mmr: matchmakingMmr(mode === 'wingman' ? S.wingman : S.rank) };
  const bot = (identity) => { const skill = matchedSkill(base); return { identity, skill, rating: ratingOfSkill(skill), group: groupOfSkill(skill) }; };
  return { A: Array.from({ length: n.A }, (_, i) => bot(ids[i] || null)), B: Array.from({ length: n.B }, (_, i) => bot(ids[n.A + i] || null)) };
}
// A private match's bots: the ranks you picked for your team and the other.
function privateRoster(p, ffa) {
  const size = p.mode === 'wingman' ? 2 : Math.max(1, Math.min(5, p.teamSize | 0));
  const ranks = privateRanks(p);
  const bot = (choice) => ({ skill: privateSkill(choice, '') });
  if (ffa) return { A: [], B: Array.from({ length: size * 2 - 1 }, () => bot(ranks.B)) };
  return { A: Array.from({ length: size - 1 }, () => bot(ranks.A)), B: Array.from({ length: size }, () => bot(ranks.B)) };
}

// Something else using Play (an online match or search, pvp.js): matchmaking and private matches wait for it to end.
let otherBusy = () => false;
export const setOtherBusy = (fn) => { otherBusy = fn; };

// A match's screen: the game draws into it; it's shown when you're in, kept out of sight while it loads behind the menu.
export function makeOverlay({ loading = false, behind = false } = {}) {
  const el = document.createElement('div');
  el.className = 'play-root' + (behind ? ' behind' : '');
  el.innerHTML = `${loading ? '<div class="play-loading"><div class="spinner"></div><div data-status>Loading…</div><button class="btn ghost" data-cancel>Cancel</button></div>' : ''}
    <div class="play-scrim"></div>
    <button class="play-click hidden" type="button"><b>Click to play</b><small>Esc opens the menu</small></button>
    <div class="play-over hidden"><button class="btn primary big" data-over-done>Continue</button></div>`;
  document.body.appendChild(el);
  return el;
}
export function gameOptions(p, extra) {
  return {
    sensitivity: p.sensitivity, quality: p.quality,
    settings: { ...matchSettings(p), onBinds: (t) => { const q = playPrefs(); q.keybinds = t; q.bindsVersion = BINDS_VERSION; savePlayPrefs(q); }, onNetGraph: (n) => { const q = playPrefs(); q.netGraph = n; savePlayPrefs(q); },
      onLeftHanded: (on) => { const q = playPrefs(); q.leftHanded = on; savePlayPrefs(q); } },
    ...extra,
  };
}

// ---- searching --------------------------------------------------------------------------------------------------------
// The maps a mode searches on: the ones you picked for it (installed ones), at first the one you played last.
export function poolOf(p, mode) {
  const list = mapsFor(mode), have = new Set(list.map((m) => m.id));
  if (Array.isArray(p.pools?.[mode])) return p.pools[mode].filter((id) => have.has(id));
  if (mode === 'wingman') return have.has(p.map) ? [p.map] : list.slice(0, 1).map((m) => m.id);
  return [have.has(p.map) ? p.map : 'de_dust2'];
}

let starting = false; // (a search on its way: a second click doesn't start another)
export async function startSearch() {
  if (search || live || starting) return;
  if (otherBusy()) { toast('Cancel your online search (or finish your online match) first.', 'bad'); return; }
  starting = true;
  try { await beginSearch(); } finally { starting = false; }
}
async function beginSearch() {
  const p = playPrefs(), mode = SIZES[p.mode] ? p.mode : 'competitive';
  const st = await cs2Status();
  if (!st.available) { toast(st.gameDir ? 'The model extractor is missing.' : 'Play mode needs Counter-Strike 2 installed on this PC.', 'bad'); return; }
  if (search || live) return;
  let q;
  try { q = await act('play.queue', { mode }); } catch (e) { toast(esc(e.message), 'bad'); return; }
  if (q.settled) toast(`Your last ${modeName(q.settled.mode)} match was abandoned (the game closed during it): a loss, and no ranked matchmaking for ${formatWait(q.settled.cooldown)}.`, 'bad');
  if (q.cooldown) { toast(`You can't play ${modeName(mode)} for ${formatWait(q.cooldown)}: you abandoned a match.`, 'bad'); changed(); return; }
  const premier = mode === 'premier', pool = premier ? [] : poolOf(p, mode);
  if (!premier && !pool.length) { toast('Pick at least one map to search on.', 'bad'); return; }
  const [lo, hi] = SEARCH_S[mode];
  const s = search = {
    // (window.__mmWait: a test run's search time, ms)
    mode, started: Date.now(), wait: window.__mmWait ?? (lo + Math.random() * (hi - lo)) * 1000, state: 'searching', ready: premier,
    map: premier ? null : pool[Math.floor(Math.random() * pool.length)], site: Math.random() < 0.5 ? 'A' : 'B', team: Math.random() < 0.5 ? 'CT' : 'T',
  };
  s.p = p;
  s.timer = setInterval(() => searchTick(s), 250);
  changed();
  s.roster = await matchRoster(mode);
  if (search === s && !premier) prepare(s, p);
}

// The agents you have on: a match loads with them, so changing them while you search loads it again (see searchTick).
const agentsOn = () => ['agentT', 'agentCT'].map((slot) => equipped(slot)?.uid || '').join();

// The match found, loading out of sight while you search (and do whatever else).
async function prepare(s, p) {
  const { Game } = await import('./play/game.js');
  if (search !== s) return;
  const ffa = s.mode === 'deathmatch' || s.mode === 'armsrace';
  s.overlay = makeOverlay({ behind: true });
  s.agents = agentsOn();
  const game = s.game = new Game(s.overlay, gameOptions(p, {
    map: s.map, mode: s.mode, team: s.team, site: s.site, ffa, minutes: 10, teamSize: 5, roster: s.roster, ranked: isRanked(s.mode), quiet: true,
    // CS2's matchmaking rules: Competitive and Wingman end in a draw on a tie, Premier plays overtime; friendly fire on.
    length: 'long', overtime: s.mode === 'premier', friendlyFire: true,
  }));
  try {
    await game.load();
  } catch (e) {
    console.error(e);
    if (search !== s || s.game !== game) return;
    toast('Could not get the match ready: ' + esc(e.message || String(e)), 'bad');
    cancelSearch();
    return;
  }
  if (search === s && s.game === game && !game.disposed) s.ready = true;
}

export function cancelSearch() {
  const s = search;
  if (!s) return;
  search = null;
  clearInterval(s.timer);
  clearInterval(s.acceptTimer);
  s.popup?.remove();
  s.game?.dispose();
  s.overlay?.remove();
  changed();
}

function searchTick(s) {
  if (search !== s) return;
  if (s.state === 'searching' && s.game && s.agents !== agentsOn()) {
    s.ready = false;
    s.game.dispose();
    s.overlay?.remove();
    s.game = s.overlay = null;
    prepare(s, s.p);
  }
  if (s.state === 'searching' && s.ready && s.roster && Date.now() - s.started >= s.wait) found(s);
  else updateBar();
}

// The match is ready: accept it (20 seconds), everyone else accepts too, and you're in. Not accepting cancels it.
function found(s) {
  s.state = 'found';
  clearInterval(s.timer);
  sfx.matchReady();
  const total = 1 + s.roster.A.length + s.roster.B.length;
  const accepts = Array.from({ length: total - 1 }, () => 0.6 + Math.random() ** 2 * 8); // (seconds: most players accept at once)
  const t0 = performance.now();
  let mine = false;
  const el = s.popup = document.createElement('div');
  el.className = 'mm-accept';
  el.innerHTML = `<div class="mm-accept-box"><small>${esc(modeName(s.mode))}</small><h2>Your match is ready!</h2>
    <div class="mm-slots">${Array.from({ length: total }, () => '<i></i>').join('')}</div>
    <button class="mm-accept-btn" data-accept>Accept</button><div class="mm-accept-time"><i></i></div></div>`;
  document.body.appendChild(el);
  const btn = el.querySelector('[data-accept]'), slots = [...el.querySelectorAll('.mm-slots i')], bar = el.querySelector('.mm-accept-time i');
  const count = () => accepts.filter((a) => a <= (performance.now() - t0) / 1000).length + (mine ? 1 : 0);
  btn.addEventListener('click', () => { if (mine) return; mine = true; btn.disabled = true; btn.textContent = 'Accepted'; sfx.acceptBeep(); });
  s.acceptTimer = setInterval(() => {
    if (search !== s) return;
    const secs = (performance.now() - t0) / 1000, n = count();
    slots.forEach((x, i) => x.classList.toggle('on', i < n));
    bar.style.width = `${Math.max(0, 100 - (secs / ACCEPT_S) * 100)}%`;
    if (n === total) { clearInterval(s.acceptTimer); setTimeout(() => { if (search === s) enter(s); }, 700); }
    else if (secs >= ACCEPT_S) {
      cancelSearch();
      toast('You didn\'t accept the match.', 'bad');
    }
  }, 100);
  changed();
}

// In: the match shows (Premier's map banned down to one first, then loaded).
async function enter(s) {
  clearInterval(s.acceptTimer);
  s.popup?.remove();
  search = null;
  while (topModal()) topModal().close();
  document.querySelector('.inspect [data-close], .inspect .x')?.click();
  const p = playPrefs();
  let { game, overlay } = s;
  if (s.mode === 'premier') {
    changed();
    const pool = ACTIVE_DUTY.filter((id) => ctx.maps.some((x) => x.id === id)).slice(0, 7);
    const veto = await premierVeto({ roster: s.roster, pool: pool.length ? pool : ['de_dust2'], nameOf: ctx.nameOf, images: ctx.images });
    s.map = veto.map; s.team = veto.team;
    const { Game } = await import('./play/game.js');
    overlay = makeOverlay({ loading: true });
    const status = overlay.querySelector('[data-status]');
    overlay.querySelector('[data-cancel]').remove(); // (accepted: no backing out now)
    game = new Game(overlay, gameOptions(p, { map: s.map, mode: 'premier', team: s.team, teamSize: 5, roster: s.roster, ranked: true, length: 'long', overtime: true, friendlyFire: true, onStatus: (m) => { status.textContent = m; } }));
    try { await game.load(); } catch (e) {
      console.error(e);
      toast('Could not start the match: ' + esc(e.message || String(e)), 'bad');
      game.dispose(); overlay.remove(); changed();
      return;
    }
    overlay.querySelector('.play-loading')?.remove();
  }
  if (isRanked(s.mode)) {
    try { await act('play.join', { mode: s.mode, opponent: game.opponentRating() }); } catch (e) {
      toast(esc(e.message), 'bad');
      game.dispose(); overlay.remove(); changed();
      return;
    }
  }
  begin({ game, overlay, mode: s.mode, ranked: isRanked(s.mode), map: s.map });
}

// ---- a private match --------------------------------------------------------------------------------------------------
// Everything picked in the lobby (the map, sides, the bots' ranks...), loaded while you watch; it moves no rank.
export async function startPrivate() {
  if (search || live || starting) return;
  if (otherBusy()) { toast('Cancel your online search (or finish your online match) first.', 'bad'); return; }
  starting = true;
  try { await beginPrivate(); } finally { starting = false; }
}
async function beginPrivate() {
  const st = await cs2Status();
  if (!st.available) { toast(st.gameDir ? 'The model extractor is missing.' : 'Play mode needs Counter-Strike 2 installed on this PC.', 'bad'); return; }
  if (search || live) return;
  const p = playPrefs(), mode = MODES[p.mode] && p.mode !== 'premier' ? p.mode : 'competitive';
  const ffa = mode === 'armsrace' || (mode === 'deathmatch' && p.ffa !== 'team');
  const map = privateMap(p, mode);
  if (!map) { toast('None of CS2\'s Wingman maps are installed.', 'bad'); return; }
  const { Game } = await import('./play/game.js');
  const overlay = makeOverlay({ loading: true });
  const status = overlay.querySelector('[data-status]');
  const game = new Game(overlay, gameOptions(p, {
    map, mode, site: p.site, ffa, minutes: p.minutes, team: p.team, teamSize: p.teamSize, roster: privateRoster({ ...p, mode }, ffa),
    length: p.length, overtime: p.overtime !== 'off', friendlyFire: p.friendlyFire === 'on', cheats: true, onStatus: (m) => { status.textContent = m; },
  }));
  const pending = live = { game, overlay, mode, ranked: false, map, private: true, loading: true, menu: false, away: null };
  overlay.querySelector('[data-cancel]').addEventListener('click', () => { if (live === pending) end(); });
  changed();
  try {
    await game.load();
  } catch (e) {
    console.error(e);
    toast('Could not start the match: ' + esc(e.message || String(e)), 'bad');
    if (live === pending) end();
    return;
  }
  if (live !== pending || game.disposed) return;
  overlay.querySelector('.play-loading')?.remove();
  live = null;
  begin({ game, overlay, mode, ranked: false, map, private: true });
}

// ---- in the match -----------------------------------------------------------------------------------------------------
function begin({ game, overlay, mode, ranked, map, private: priv = false }) {
  const m = live = { game, overlay, mode, ranked, map, private: priv, menu: false, away: null, started: Date.now() };
  overlay.classList.remove('behind');
  const click = overlay.querySelector('.play-click');
  game.on((type, data) => {
    if (live !== m) return;
    if (type === 'menu') setMenu(data);
    if (type === 'over') over(m, data);
    if (type === 'frame') click.classList.toggle('hidden', !!(game.input.locked || game.input.menu || m.menu || m.away || game.matchOver));
  });
  // A click anywhere on the match (not on its menus) takes the mouse: you're playing.
  overlay.addEventListener('mousedown', (e) => {
    if (live !== m || m.menu || m.away || game.matchOver || game.input.locked || game.input.menu) return;
    if (e.target.closest('.play-buy, .play-console, .play-chat, .play-over')) return;
    game.resume();
  });
  overlay.querySelector('[data-over-done]').addEventListener('click', () => { if (live === m) { end(); go('play'); } });
  game.start();
  if (window.__cs2Debug) window.__playGame = game;
  changed();
}

// The menu over the match (Esc): the game's pages on top of it, the match going on behind.
function setMenu(open) {
  const m = live;
  if (!m || m.away || m.menu === open) return;
  m.menu = open;
  if (open) m.menuAt = performance.now();
  document.body.classList.toggle('match-menu', open);
  if (open) go('play');
  changed();
}
export function resume() {
  const m = live;
  if (!m || m.away) return;
  setMenu(false);
  m.game.resume();
}

// Esc in the menu goes back to the match (click it to play); Esc over the match (the mouse free) opens the menu again.
function escKey(e) {
  const m = live;
  if (e.key !== 'Escape' || !m || m.away || m.loading || m.game.matchOver) return;
  if (topModal() || document.querySelector('.inspect, .veto-root, .mm-accept')) return; // (theirs to close)
  if (m.game.input.locked || m.game.input.menu || m.game.console?.isOpen || m.game.chatOpen) return;
  if (performance.now() - (m.menuAt || 0) < 400) return; // (the same Esc that let go of the mouse and opened the menu)
  e.preventDefault();
  setMenu(!m.menu);
}

// Leave: a ranked match waits for you to reconnect (5 minutes); any other is over.
export async function leave() {
  const m = live;
  if (!m) return;
  if (!m.ranked || m.game.matchOver) { end(); go('play'); return; }
  const ok = await confirmDialog(`Leave the match? It goes on without you: you can reconnect for ${RECONNECT_S / 60} minutes from the Play page or the top bar. If you don't come back, or you abandon it, it counts as a loss and you can't play ranked matchmaking for ${formatWait(nextCooldown(S.mm))}.`, { ok: 'Leave match', danger: true });
  if (!ok || live !== m || m.game.matchOver) return;
  setMenu(false);
  m.away = { since: Date.now() };
  m.game.disconnect();
  m.overlay.classList.add('away');
  m.awayTimer = setInterval(() => {
    if (live !== m || !m.away) return;
    if (Date.now() - m.away.since >= RECONNECT_S * 1000) abandon({ auto: true });
    else updateBar();
  }, 250);
  go('play');
  changed();
}
export function reconnect() {
  const m = live;
  if (!m?.away) return;
  clearInterval(m.awayTimer);
  m.away = null;
  m.overlay.classList.remove('away');
  m.game.reconnect();
  while (topModal()) topModal().close();
  changed();
}
// Giving the match up: a loss for your rank and the cooldown (auto: you didn't reconnect in time).
export async function abandon({ auto = false } = {}) {
  const m = live;
  if (!m?.ranked) return;
  if (!auto) {
    const ok = await confirmDialog(`Abandon the match? It counts as a loss, and you can't play Premier, Competitive or Wingman for ${formatWait(nextCooldown(S.mm))}.`, { ok: 'Abandon', danger: true });
    if (!ok || live !== m) return;
  }
  const sc = m.game.match?.score || { A: 0, B: 0 };
  clearInterval(m.awayTimer);
  end();
  try {
    const r = await act('play.abandon', { roundsFor: Math.min(60, sc.A), roundsAgainst: Math.min(60, sc.B) });
    toast(`${auto ? 'You didn\'t reconnect in time: the' : 'You abandoned the'} match. It counts as a loss, and you can't play ranked matchmaking for ${formatWait(r.cooldown)}.`, 'bad');
  } catch (e) { toast(esc(e.message), 'bad'); }
  changed();
}

// The match is over: its end screen and Continue (you were away: what happened, and it's done).
async function over(m, { won, draw }) {
  if (!m.away) { m.overlay.querySelector('.play-over').classList.remove('hidden'); changed(); return; }
  clearInterval(m.awayTimer);
  await m.game.rated?.catch(() => null);
  if (live !== m) return;
  const sc = m.game.match.score;
  end();
  toast(`Your ${modeName(m.mode)} match on ${esc(ctx.nameOf(m.map))} ended while you were away: <b>${draw ? 'Draw' : won ? 'Victory' : 'Defeat'}</b> ${sc.A} : ${sc.B}.`, won ? 'good' : '');
}

function end() {
  const m = live;
  if (!m) return;
  live = null;
  clearInterval(m.awayTimer);
  document.body.classList.remove('match-menu');
  m.game.dispose();
  m.overlay.remove();
  if (window.__playGame === m.game) window.__playGame = null;
  changed();
  window.dispatchEvent(new CustomEvent('app:refresh'));
}

// Your settings changed in the menu: the match uses them at once.
export function settingsChanged() {
  if (!live || live.loading) return;
  const p = playPrefs();
  live.game.applySettings(matchSettings(p), p.sensitivity);
}

// ---- the top bar ------------------------------------------------------------------------------------------------------
// Searching (its time), the match found, the match you're in (Resume) or left (Reconnect, Abandon, the time left).
let barEl = null;
const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
function drawBar() {
  if (!barEl) return;
  const m = live, s = search;
  let html = '';
  if (s) html = `<span class="mm-spin"></span><span class="mm-txt"><small>${s.state === 'found' ? 'Match found' : 'Searching'} · ${esc(modeName(s.mode))}</small><b data-mm-time></b></span>
      ${s.state === 'searching' ? '<button class="mm-x" data-mm-cancel title="Cancel the search" aria-label="Cancel the search">✕</button>' : ''}`;
  else if (m?.away) html = `<span class="mm-txt"><small>Match in progress · ${esc(ctx.nameOf(m.map))}</small><b data-mm-time></b></span>
      <button class="btn primary sm" data-mm-reconnect>Reconnect</button><button class="btn ghost sm" data-mm-abandon>Abandon</button>`;
  else if (m && m.menu) html = `<span class="mm-txt"><small>${esc(modeName(m.mode))} · ${esc(ctx.nameOf(m.map))}</small><b data-mm-score></b></span>
      <button class="btn primary sm" data-mm-resume>Resume</button>`;
  barEl.className = 'mm-bar' + (s ? ' searching' : m?.away ? ' away' : m?.menu ? ' live' : '');
  barEl.hidden = !html;
  barEl.innerHTML = html;
  barEl.querySelector('[data-mm-cancel]')?.addEventListener('click', cancelSearch);
  barEl.querySelector('[data-mm-reconnect]')?.addEventListener('click', reconnect);
  barEl.querySelector('[data-mm-abandon]')?.addEventListener('click', () => abandon());
  barEl.querySelector('[data-mm-resume]')?.addEventListener('click', resume);
  updateBar();
}
function updateBar() {
  if (!barEl || barEl.hidden) return;
  const t = barEl.querySelector('[data-mm-time]');
  if (t && search) t.textContent = clock(Date.now() - search.started);
  else if (t && live?.away) t.textContent = `${clock(RECONNECT_S * 1000 - (Date.now() - live.away.since))} to reconnect`;
  const sc = barEl.querySelector('[data-mm-score]');
  if (sc && live?.game.match) sc.textContent = scoreLine(live.game);
}
// The score as the HUD has it: your side first.
export function scoreLine(game) {
  const m = game.match;
  if (!m || game.respawnMode) return modeName(game.mode);
  const mine = game.me.team, theirs = mine === 'CT' ? 'T' : 'CT';
  return `${mine} ${m.score.A} : ${m.score.B} ${theirs} · Round ${m.round}`;
}

// At start: the bar's place in the top bar, Esc over a match, and a ranked match the game closed during (abandoned).
export function initMatchmaking() {
  barEl = document.createElement('div');
  barEl.className = 'mm-bar';
  barEl.hidden = true;
  document.querySelector('#topbar .top-right')?.prepend(barEl);
  document.addEventListener('keydown', escKey);
  setInterval(() => { if (live?.menu) updateBar(); }, 1000);
  if (S.mm?.match) {
    const mode = S.mm.match.mode;
    act('play.abandon', {}).then((r) => toast(`Your last ${modeName(mode)} match was abandoned (the game closed during it): a loss, and no ranked matchmaking for ${formatWait(r.cooldown)}.`, 'bad')).catch(() => {});
  }
}
