// Online matches: Competitive (5v5) and Wingman (2v2) against other players, on the game server (pvp1: net/online.js; the
// server's server/matchmaking.mjs and relay.mjs; the rules in engine/pvp.js). Play's Online tab (pages/play.js) searches;
// the server finds a lobby (a full one at once, else after 2 minutes the players it has, split between the teams, bots
// filling both), everyone accepts (20 s), and every game loads the map (each player's own CS2 install: only maps everyone
// has the same are picked). The player with the lowest round trip to the server hosts the match in their game
// (play/net-host.js); everyone else's game plays it from there (play/net-client.js). The server keeps its own log of the
// rounds and pays from it: the result, kills, assists and MVPs, as a bot match pays.
//
// A search alone after 2 minutes stays a search (nobody else is searching): the Online tab offers a match against bots
// in the same mode instead. Leaving a match: a bot plays for you, and you can come back for 5 minutes (from the Play page or
// the top bar); not back in time, or giving it up, is an abandon (a loss for your rank and the cooldown). The host's game
// lost (closed, or its link down) pauses the match for everyone, and it ends unless it's back within a minute; the host
// choosing Leave ends it at once (an abandon for them, the others paid for the rounds played).
import { net } from './net/online.js';
import { esc, money } from './util.js';
import { toast, topModal, confirmDialog } from './ui.js';
import { sfx } from './audio.js';
import { cs2Play, cs2Status } from './cs2/api.js';
import { S } from './state.js';
import { ACTIVE_DUTY } from './engine/premier.js';
import { MODES as PMODES, squadOfSlot, slotsOf, otherSquad, CLOSE } from './engine/pvp.js';
import { cooldownLeft, formatWait, RECONNECT_S } from './engine/matchmaking.js';
import { SKILL_GROUPS } from './engine/ranks.js';
import { playPrefs, savePlayPrefs } from './pages/play-settings.js';
import { emblemHtml, rankPictures } from './rank.js';
import * as mm from './matchmaking.js';

const go = (page) => window.dispatchEvent(new CustomEvent('app:go', { detail: page }));
const NAMES = { competitive: 'Competitive', wingman: 'Wingman' };
const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

// The search ({ mode, since, waited, found, need, split, alone }), a match found waiting for accepts, the match you're in
// (its game, socket and role), one you've left and can go back to (away), and the maps you can play online.
const state = { q: null, found: null, match: null, away: null, content: null, wingman: null, busy: false };
const subs = new Set();
export const onPvp = (fn) => { subs.add(fn); return () => subs.delete(fn); };
const changed = () => { drawBar(); for (const fn of subs) fn(); };
export const pvpState = () => state;
export const liveMatch = () => (state.match?.begun ? state.match : null);
// Whether online play has Play to itself now (a search, a match found, loading or in one): matchmaking waits.
export const busy = () => !!(state.q || state.found || state.match || state.busy);

// ---- the maps you can play ----------------------------------------------------------------------------------------------
// Your installed maps in the mode's pool (Competitive: Active Duty; Wingman: CS2's Wingman maps), each with its content's
// signature and whether it's exported yet (net: what the server matches on). → [{ id, c, x }]
export async function mapsFor(mode, { fresh = false } = {}) {
  if (!state.content || fresh) state.content = await cs2Play('mapContent').catch(() => []);
  if (mode === 'wingman') {
    state.wingman ||= await cs2Play('wingmanMaps').catch(() => ({ pool: [], fixed: [] }));
    return (state.content || []).filter((m) => state.wingman.pool.includes(m.id));
  }
  return (state.content || []).filter((m) => ACTIVE_DUTY.includes(m.id));
}
export const knownMaps = (mode) => (!state.content ? null : mode === 'wingman' ? (state.wingman ? state.content.filter((m) => state.wingman.pool.includes(m.id)) : null) : state.content.filter((m) => ACTIVE_DUTY.includes(m.id)));

// ---- searching ----------------------------------------------------------------------------------------------------------
export async function search(mode) {
  if (!net.hasPvp()) { toast('This server has no online matches.', 'bad'); return; }
  if (mm.searching() || mm.liveMatch()) { toast('Cancel your search (or leave your match) first.', 'bad'); return; }
  if (busy() || state.away) return;
  state.busy = true;
  changed();
  try {
    const st = await cs2Status();
    if (!st.available) { toast('Play mode needs Counter-Strike 2 installed on this PC.', 'bad'); return; }
    const maps = await mapsFor(mode, { fresh: true });
    if (!maps.length) { toast(`None of your CS2 maps can be played online in ${NAMES[mode]}.`, 'bad'); return; }
    const fixed = mode === 'wingman' ? (state.wingman?.fixed || []).filter((id) => maps.some((m) => m.id === id)) : undefined;
    const r = await net.pvp('queue', { mode, maps, ...(fixed ? { fixed } : {}) });
    if (r.settled) toast(`Your last ${NAMES[r.settled.mode] || r.settled.mode} match was abandoned (the game closed during it): a loss, and no ranked matchmaking for ${formatWait(r.settled.cooldown)}.`, 'bad');
    state.q = { mode, since: r.since, waited: 0, found: 1, need: PMODES[mode].lobby, split: 120, alone: false, at: Date.now() };
  } catch (e) { toast(esc(e.message), 'bad'); }
  finally { state.busy = false; changed(); }
}
export async function cancelSearch() {
  if (!state.q) return;
  state.q = null;
  changed();
  await net.pvp('leave', {}).catch(() => {});
}
// Alone in the search: the match against bots in the same mode instead (matchmaking's, as it pays).
export async function playBotsInstead() {
  const mode = state.q?.mode || 'competitive';
  await cancelSearch();
  const p = playPrefs();
  p.lobby = 'mm'; p.mode = mode;
  savePlayPrefs(p);
  mm.startSearch();
}

// ---- found: accept within 20 s ------------------------------------------------------------------------------------------
function found(msg) {
  state.q = null;
  closePopup();
  const f = state.found = { id: msg.id, mode: msg.mode, map: msg.map, humans: msg.humans, deadline: msg.deadline, accepted: false, n: 0 };
  sfx.matchReady();
  const el = f.popup = document.createElement('div');
  el.className = 'mm-accept';
  el.innerHTML = `<div class="mm-accept-box"><small>Online · ${esc(NAMES[f.mode] || f.mode)}</small><h2>Your match is ready!</h2>
    <div class="mm-slots">${Array.from({ length: f.humans }, () => '<i></i>').join('')}</div>
    <button class="mm-accept-btn" data-accept>Accept</button><div class="mm-accept-time"><i></i></div>
    <div class="muted pvp-accept-sub">${f.humans} player${f.humans === 1 ? '' : 's'} · the server picks the map</div></div>`;
  document.body.appendChild(el);
  const btn = el.querySelector('[data-accept]'), bar = el.querySelector('.mm-accept-time i');
  btn.addEventListener('click', async () => {
    if (f.accepted || state.found !== f) return;
    f.accepted = true; btn.disabled = true; btn.textContent = 'Accepted';
    sfx.acceptBeep();
    try { const r = await net.pvp('accept', { id: f.id }); lights(f, r.n); } catch (e) { toast(esc(e.message), 'bad'); }
  });
  f.timer = setInterval(() => {
    if (state.found !== f) return clearInterval(f.timer);
    const left = f.deadline - net.serverNow();
    bar.style.width = `${Math.max(0, Math.min(100, (left / 20000) * 100))}%`;
  }, 100);
  changed();
}
function lights(f, n) { f.n = n; f.popup?.querySelectorAll('.mm-slots i').forEach((x, i) => x.classList.toggle('on', i < n)); }
function closePopup() { const f = state.found; if (f) { clearInterval(f.timer); f.popup?.remove(); } }

function cancelled(msg) {
  const f = state.found && (msg.id == null || state.found.id === msg.id) ? state.found : null;
  if (f) { closePopup(); state.found = null; }
  const m = state.match;
  if (m && (msg.id == null || m.id === msg.id) && !m.begun) endMatch(m, { quiet: true });
  if (msg.id == null && state.q) state.q = null;
  if (msg.requeued && !state.q) {
    const mode = msg.mode || f?.mode || m?.mode || 'competitive';
    state.q = { mode, since: Date.now(), waited: 0, found: 1, need: PMODES[mode]?.lobby || 10, split: 0, alone: false, at: Date.now() };
  }
  if (msg.msg) toast(esc(msg.msg), msg.requeued ? '' : 'bad');
  changed();
}

// ---- the match: loading, then playing ------------------------------------------------------------------------------------
// pvp.go (or Reconnect): the match's socket, then its game loading (the server says what as `joined`).
function start(msg) {
  closePopup();
  state.found = null; state.q = null; state.away = null;
  if (state.match) endMatch(state.match, { quiet: true });
  const m = state.match = { id: msg.id, mode: msg.mode, map: msg.map, slot: msg.slot, loadBy: msg.loadBy, info: null, members: new Map(), host: null, started: false,
    loaded: false, begun: false, ended: null, menu: false, progress: 0, sentAt: 0, rejoin: !!msg.rejoin };
  m.overlay = mm.makeOverlay();
  m.overlay.classList.add('pvp-match');
  m.load = document.createElement('div');
  m.load.className = 'pvp-load';
  m.overlay.appendChild(m.load);
  // (What comes before our game's ready to take it, the host's first keyframe say, waits for it: see maybeBegin.)
  m.early = [];
  m.link = net.openMatch(m.id, {
    joined: (j) => joined(m, j), text: (t) => text(m, t), binary: (b) => (m.net ? m.net.onBinary(b) : m.early.length < 400 && m.early.push(b)), closed: (c) => closedLink(m, c),
  });
  m.timer = setInterval(() => drawLoad(m), 500);
  drawLoad(m);
  changed();
}
function joined(m, j) {
  if (state.match !== m) return;
  m.info = j;
  m.host = j.host;
  m.status = j.status;
  for (const x of j.members || []) m.members.set(x.slot, { state: x.state, load: x.load || 0 });
  banner(m, j.paused || null); // (back in: the reconnecting notice goes, or the match's own pause shows)
  drawLoad(m);
  if (!m.game) load(m);
  else if (m.loaded && !m.net) maybeBegin(m);
  else m.net?.onJoined?.(j); // (back after our link dropped: the host sends what the server didn't get, and goes on)
}
function text(m, msg) {
  if (state.match !== m) return;
  switch (msg.t) {
    case 'member': { const x = m.members.get(msg.slot) || {}; x.state = msg.state; if (msg.load != null) x.load = msg.load; x.stage = msg.stage || null; m.members.set(msg.slot, x); drawLoad(m); break; }
    case 'host': m.host = msg.slot; drawLoad(m); maybeBegin(m); break;
    case 'start': m.started = true; maybeBegin(m); break;
    case 'pause': banner(m, msg); break;
    case 'resume': banner(m, null); break;
    case 'end': m.ended = msg; ended(m, msg); break;
  }
  if (window.__cs2Debug && msg.t !== 'rtt' && !(msg.t === 'member' && msg.state === 'loading')) console.info('[pvp match]', JSON.stringify(msg).slice(0, 200));
  // (Members' states are kept here, and the game's net side starts from them: an old one replayed after it would undo a
  // newer one.)
  if (m.net) m.net.onText(msg); else if (msg.t !== 'host' && msg.t !== 'start' && msg.t !== 'member' && m.early.length < 400) m.early.push(msg);
}
// The socket closed for good (or is trying again: the match waits for us).
function closedLink(m, c) {
  if (state.match !== m) return;
  if (c.retrying) {
    // (Hosting: the match stops here too until the link's back, as everyone else's game can't see it go on.)
    m.net?.onLink?.(false);
    banner(m, { why: c.code === CLOSE.RESTART ? 'restart' : 'connection' });
    return;
  }
  if (m.ended || c.code === CLOSE.END) { if (!m.begun) endMatch(m, { quiet: true }); return; }
  const why = c.code === CLOSE.NOT_MEMBER ? 'You are no longer in this match' : c.code === CLOSE.OVER ? 'That match is over' : c.code === CLOSE.BANNED ? (c.reason || 'You were disconnected')
    : c.code === CLOSE.MAINTENANCE ? 'The server is under maintenance' : c.code === CLOSE.REPLACED ? 'You joined this match from somewhere else' : 'Lost the connection to the match';
  toast(esc(why), 'bad');
  endMatch(m, { quiet: true });
  if (net.status() === 'online') net.pvp('state').then(fromState).catch(() => {});
}

async function load(m) {
  const j = m.info, mode = m.mode, mySq = squadOfSlot(mode, j.slot), other = otherSquad(mySq);
  const slotInfo = new Map(j.slots.map((s) => [s.slot, s]));
  const mates = slotsOf(mode, mySq).filter((s) => s !== j.slot), foes = slotsOf(mode, other);
  const roster = { A: mates.map((s) => ({ skill: slotInfo.get(s)?.skill ?? 0.5 })), B: foes.map((s) => ({ skill: slotInfo.get(s)?.skill ?? 0.5 })) };
  // (Loading, said at once: a game back in a match it had loaded before (it closed) could otherwise be taken as ready, and be
  // given control before it has the map.)
  m.link.send({ t: 'load', p: 0 });
  const { Game } = await import('./play/game.js');
  // (window.__pvpLoadDelay: a test run's wait before loading, so games on one machine don't load all at once)
  if (window.__pvpLoadDelay) await new Promise((r) => setTimeout(r, window.__pvpLoadDelay));
  if (state.match !== m) return;
  const p = playPrefs();
  const game = m.game = new Game(m.overlay, mm.gameOptions(p, {
    map: j.map, mode, team: j.sides[mySq], site: j.site || 'A', teamSize: PMODES[mode].size, roster, ranked: false, length: 'long', overtime: false,
    friendlyFire: true, online: true, onStatus: (s) => progress(m, s),
  }));
  try {
    await game.load();
    // (Everyone's knife, in case this game ends up hosting: their clips time their swings, net-pawn.js.)
    const { knifeWid } = await import('./play/net-match.js');
    await Promise.all(j.slots.filter((s) => s.kind === 'human').map((s) => knifeWid(s.look?.knife)).filter(Boolean).map((w) => game.vmData(w, { plain: true }).catch(() => null)));
  } catch (e) {
    console.error(e);
    if (state.match !== m) return;
    toast('Could not load the match: ' + esc(e.message || String(e)), 'bad');
    m.link.send({ t: 'load', failed: String(e.message || e).slice(0, 80) });
    setTimeout(() => endMatch(m, { quiet: true }), 300);
    return;
  }
  if (state.match !== m || game.disposed) return;
  m.loaded = true;
  m.link.send({ t: 'load', p: 100 });
  m.link.send({ t: 'ready' });
  drawLoad(m);
  maybeBegin(m);
}
// Loading's progress for everyone's loading screen (at most twice a second): by what the game says it's doing.
function progress(m, s) {
  const t = String(s || '');
  const w = /Loading weapons… (\d+) of (\d+)/.exec(t);
  const p = w ? 85 + Math.round((13 * +w[1]) / Math.max(1, +w[2])) : /Compiling shaders/.test(t) ? 98 : /Loading weapons and sounds/.test(t) ? 84 : /Loading players/.test(t) ? 80
    : /where bots hold/.test(t) ? 72 : /collision/i.test(t) ? 45 : /Preparing the map|Exporting|map/i.test(t) ? Math.min(40, Math.max(5, m.progress + 1)) : Math.min(70, m.progress + 1);
  m.progress = Math.max(m.progress, Math.min(99, p));
  m.stage = t.replace(/….*$/, '…').slice(0, 40);
  const now = performance.now();
  if (now - m.sentAt >= 500) { m.sentAt = now; m.link.send({ t: 'load', p: m.progress, stage: m.stage }); }
  drawLoad(m);
}

// Everyone's loaded, the host is picked, the server's said start: our game hosts the match or plays it from the host's.
async function maybeBegin(m) {
  if (m.net || m.beginning || !m.loaded || m.host == null || state.match !== m || m.ended) return;
  if (!m.started && m.info.status === 'loading') return;
  m.beginning = true;
  const game = m.game, j = m.info;
  const [{ NetHost }, { NetClient }] = await Promise.all([import('./play/net-host.js'), import('./play/net-client.js')]);
  m.beginning = false;
  if (state.match !== m || m.net || m.ended) return;
  const info = { ...j, slot: j.slot, host: m.host, mode: m.mode, picUrl: net.picUrl, members: [...m.members].map(([slot, x]) => ({ slot, state: x.state })) };
  if (m.host === j.slot) {
    if (m.rejoin && j.status !== 'loading') {
      // (Our game hosted it and closed: the match was in it, and can't go on from here.)
      toast('Your game was hosting this match when it closed: it can\'t carry on from here.', 'bad');
      await abandon({ confirm: false });
      return;
    }
    m.net = new NetHost(game, m.link, info);
    m.net.attach();
    m.net.start();
    m.role = 'host';
    window.native?.setHosting?.(true);
  } else {
    m.net = new NetClient(game, m.link, info);
    m.net.attach();
    m.role = 'client';
  }
  for (const x of m.early.splice(0)) { if (x instanceof Uint8Array) m.net.onBinary(x); else m.net.onText(x); }
  begin(m);
}

function begin(m) {
  const game = m.game, overlay = m.overlay;
  m.begun = true;
  clearInterval(m.timer);
  m.load.remove();
  while (topModal()) topModal().close();
  const click = overlay.querySelector('.play-click');
  game.on((type, data) => {
    if (state.match !== m) return;
    if (type === 'menu') setMenu(m, data);
    if (type === 'over') {
      overlay.querySelector('.play-over').classList.remove('hidden');
      const el = rewardBox(m);
      if (el && m.reward) el.innerHTML = m.reward;
      changed();
    }
    if (type === 'frame') click.classList.toggle('hidden', !!(game.input.locked || game.input.menu || m.menu || game.matchOver));
  });
  overlay.addEventListener('mousedown', (e) => {
    if (state.match !== m || m.menu || game.matchOver || game.input.locked || game.input.menu) return;
    if (e.target.closest('.play-buy, .play-console, .play-chat, .play-over')) return;
    game.resume();
  });
  overlay.querySelector('[data-over-done]').addEventListener('click', () => { if (state.match === m) { endMatch(m); go('play'); } });
  game.start();
  if (window.__cs2Debug) window.__playGame = game;
  window.__pvpMatch = m;
  changed();
}

// The menu over the match (Esc), as matchmaking's: the match goes on behind it.
function setMenu(m, open) {
  if (!m || m.menu === open) return;
  m.menu = open;
  if (open) m.menuAt = performance.now();
  document.body.classList.toggle('match-menu', open);
  if (open) go('play');
  changed();
}
export function resume() { const m = state.match; if (!m?.begun) return; setMenu(m, false); m.game.resume(); }
function escKey(e) {
  const m = state.match;
  if (e.key !== 'Escape' || !m?.begun || m.game.matchOver) return;
  if (topModal() || document.querySelector('.inspect, .mm-accept')) return;
  if (m.game.input.locked || m.game.input.menu || m.game.console?.isOpen || m.game.chatOpen) return;
  if (performance.now() - (m.menuAt || 0) < 400) return;
  e.preventDefault();
  setMenu(m, !m.menu);
}

// A pause for everyone (the host's gone, the server's restarting) or our own connection trying again.
function banner(m, p) {
  let el = m.overlay.querySelector('.pvp-banner');
  if (!p) { el?.remove(); clearInterval(m.bannerTimer); return; }
  if (!el) { el = document.createElement('div'); el.className = 'pvp-banner'; m.overlay.appendChild(el); }
  const draw = () => {
    const left = p.until ? clock(p.until - net.serverNow()) : '';
    el.textContent = p.why === 'host' ? `Waiting for the host to come back${left ? ` (${left})` : ''}` : p.why === 'restart' ? `The server is restarting${left ? ` (${left})` : ''}…`
      : p.why === 'connection' ? 'Lost the connection: reconnecting…' : 'Paused';
  };
  draw();
  clearInterval(m.bannerTimer);
  m.bannerTimer = setInterval(draw, 500);
}

// The match is over (the server's end): with a cut-short one, its own end screen (the host left, staff, maintenance). One
// that ended while this game was still loading (it came back to it late): nothing to play, so the result is told here and
// the reward follows as a note. One played to its end whose own end this game missed (the host's, sent while it was away):
// the end screen from the server's score.
function ended(m, msg) {
  banner(m, null);
  const g = m.game;
  if (!m.begun) {
    const sq = m.info ? squadOfSlot(m.mode, m.info.slot) : null, s = msg.score;
    const score = sq && s ? ` ${s[sq]} : ${s[otherSquad(sq)]}` : '';
    toast(esc(msg.why === 'over' ? `The online match ended while your game was loading:${score}.` : msg.msg || 'The online match ended.'), '');
    setTimeout(() => { if (state.match === m) endMatch(m, { quiet: true }); }, 50);
    return;
  }
  if (!g) return;
  if (msg.why === 'over' && !g.matchOver && msg.score) {
    const sq = squadOfSlot(m.mode, m.info.slot), s = msg.score;
    setTimeout(async () => {
      if (state.match !== m || g.matchOver) return;
      const { endScreen } = await import('./play/net-match.js');
      if (state.match !== m || g.matchOver) return;
      g.clock?.pause(true);
      const you = s[sq], them = s[otherSquad(sq)];
      endScreen(g, { won: you > them, draw: you === them, score: { you, them } }); // (its 'over': begin shows the reward)
    }, 2500);
  }
  if (msg.why !== 'over' && !g.matchOver) {
    g.matchOver = true;
    g.hud.winPanel(null);
    g.clock?.pause(true); // (nothing more happens in it)
    g.hud.endScreen(`<h1>${msg.why === 'void' ? 'Match over' : 'Match ended'}</h1><div class="sub">${esc(msg.msg || '')}</div><div class="reward" data-reward>Reward: working it out…</div>`);
    g.hud.scoreboard(true, g.scoreData());
    g.input.unlock();
    m.overlay.querySelector('.play-over').classList.remove('hidden');
  }
  if (m.role === 'host') window.native?.setHosting?.(false);
}
// The server's pay (after the match's end), or why there's none: on the end screen, and a toast if it's gone.
function rewardBox(m) { return m?.game?.hud.q('[data-reward]') || null; }
function paid(msg) {
  const m = state.match, el = m?.id === msg.id ? rewardBox(m) : null;
  const html = rewardHtml(msg);
  if (el) el.innerHTML = html;
  else if (m?.id === msg.id && m.begun) m.reward = html; // (the end screen's still to come: it shows it, see begin)
  else toast(`Online match: <b>+${money(msg.earned || 0)}</b> · ${(msg.xp || 0).toLocaleString()} XP${(msg.notes || []).length ? ` · ${esc(msg.notes[0])}` : ''}`, 'good');
}
function over(msg) {
  const m = state.match;
  if (msg.why === 'abandoned') {
    if (m?.id === msg.id) endMatch(m, { quiet: true });
    state.away = null;
    toast(esc(msg.msg || 'You abandoned the match'), 'bad');
    changed();
    return;
  }
  const el = m?.id === msg.id ? rewardBox(m) : null, html = `<span class="muted">${esc(msg.msg || '')}</span>`;
  if (el) el.innerHTML = html;
  else if (m?.id === msg.id && m.begun) m.reward = html;
  else if (msg.msg) toast(esc(msg.msg), msg.why === 'void' ? 'bad' : '');
}
export function rewardHtml(r) {
  const p = r.pay || {}, usd = (v) => money(v || 0);
  const parts = [r.result && `${{ win: 'Win', draw: 'Draw', loss: 'Loss' }[r.result]} ${usd(p.result)}`, p.kills && `kills ${usd(p.kills)}`, p.assists && `assists ${usd(p.assists)}`, p.mvps && `MVPs ${usd(p.mvps)}`].filter(Boolean).join(' · ');
  const rank = r.rank?.change ? `<div class="pvp-rank">${r.rank.change === 'up' ? 'Rank up!' : r.rank.change === 'down' ? 'Rank down' : r.rank.change === 'placed' ? 'Rank revealed' : ''}${r.rank.after ? ` · ${esc(SKILL_GROUPS[r.rank.after - 1] || '')}` : ''}</div>` : '';
  return `<div class="match-pay"><div><b class="green">+${usd(r.earned)}</b> <span class="muted">${parts}</span></div><div class="xp-line"><span>+${(r.xp || 0).toLocaleString()} XP</span></div>
    ${(r.notes || []).map((n) => `<div class="muted pvp-note">${esc(n)}</div>`).join('')}${rank}</div>`;
}

// Leaving: a bot plays for you, and you can come back for RECONNECT_S. The host's leaving pauses the match for everyone.
export async function leave() {
  const m = state.match;
  if (!m) return;
  if (m.game?.matchOver || !m.begun) { endMatch(m); go('play'); return; }
  const host = m.role === 'host';
  // (The host's game is the match: once it's gone the match can't go on, so leaving ends it for everyone at once (the others
  // are paid for the rounds played), and it's an abandon.)
  const text = host ? 'You\'re hosting this match: leaving ends it for everyone now (they\'re paid for the rounds played), and it counts as an abandon: a loss, and a cooldown from ranked matchmaking.'
    : `Leave the match? A bot plays for you, and you can reconnect for ${RECONNECT_S / 60} minutes from the Play page or the top bar. If you don't come back, it counts as an abandon: a loss, and a cooldown from ranked matchmaking.`;
  const ok = await confirmDialog(text, { ok: 'Leave match', danger: true });
  if (!ok || state.match !== m) return;
  if (host) { await abandon({ confirm: false }); go('play'); return; }
  m.link.send({ t: 'leave' });
  const away = { id: m.id, mode: m.mode, map: m.map, slot: m.slot, until: Date.now() + RECONNECT_S * 1000, host };
  setTimeout(() => endMatch(m, { quiet: true }), 150);
  state.away = away;
  changed();
  go('play');
}
export function reconnect() {
  const a = state.away;
  if (!a || state.match) return;
  start({ id: a.id, mode: a.mode, map: a.map, slot: a.slot, rejoin: true });
}
export async function abandon({ confirm = true } = {}) {
  const id = state.match?.id || state.away?.id;
  if (!id) return;
  if (confirm) {
    const ok = await confirmDialog(`Abandon the match? It counts as a loss, and you can't play ranked matchmaking for a while (${formatWait(nextWait())}).`, { ok: 'Abandon', danger: true });
    if (!ok) return;
  }
  try {
    // (The server's own word on it comes as pvp.over, abandoned, with the cooldown: see over. Only without one, this.)
    const r = await net.pvp('abandon', { id });
    if (!r.cooldown) toast('You abandoned the match.', 'bad');
  } catch (e) { toast(esc(e.message), 'bad'); }
  if (state.match?.id === id) endMatch(state.match, { quiet: true });
  state.away = null;
  changed();
}
const nextWait = () => Math.max(30 * 60e3, cooldownLeft(S.mm) || 0);

function endMatch(m, { quiet = false } = {}) {
  if (!m) return;
  clearInterval(m.timer); clearInterval(m.bannerTimer);
  if (m.role === 'host') window.native?.setHosting?.(false);
  try { m.net?.dispose(); } catch (e) { console.warn(e); }
  try { m.link?.close(1000); } catch {}
  try { m.game?.dispose(); } catch (e) { console.warn(e); }
  m.overlay?.remove();
  if (state.match === m) state.match = null;
  if (window.__playGame === m.game) window.__playGame = null;
  if (window.__pvpMatch === m) window.__pvpMatch = null;
  document.body.classList.remove('match-menu');
  if (!quiet) window.dispatchEvent(new CustomEvent('app:refresh'));
  changed();
}

// After a welcome: a search, a match found, or one we're in from before (this game closed during it: away).
function fromState(r) {
  if (!r) return;
  state.dodge = r.dodge || 0;
  if (r.queue && !state.q && !state.match) state.q = { mode: r.queue.mode, since: r.queue.since, waited: 0, found: 1, need: PMODES[r.queue.mode]?.lobby || 10, split: 0, alone: !!r.queue.alone, at: Date.now() };
  if (!r.queue && state.q && !state.busy) state.q = null;
  if (r.found && !state.found && !r.found.accepted) found({ id: r.found.id, mode: r.found.mode, map: r.found.map, humans: r.found.humans, deadline: r.found.deadline });
  if (r.match && !state.match) {
    if (r.match.away) state.away = { id: r.match.id, mode: r.match.mode, map: r.match.map, slot: r.match.slot, until: Date.now() + (r.match.away.left ?? RECONNECT_S * 1000), status: r.match.status };
  } else if (!r.match) state.away = null;
  changed();
}

// ---- the loading screen ---------------------------------------------------------------------------------------------------
function drawLoad(m) {
  if (!m.load || m.begun) return;
  const j = m.info;
  if (!j) { m.load.innerHTML = '<div class="pvp-load-box"><div class="spinner"></div><div>Joining the match…</div></div>'; return; }
  const side = (sq) => j.sides[sq], mySq = squadOfSlot(m.mode, j.slot);
  const row = (s) => {
    const emblem = `<span class="pvp-rank-em">${s.group ? emblemHtml(s.group, { size: 16, wingman: m.mode === 'wingman' }) : ''}</span>`;
    if (s.kind !== 'human') return `<div class="pvp-row bot"><span class="pvp-pic">BOT</span><span class="pvp-name">BOT</span>${emblem}</div>`;
    const x = m.members.get(s.slot) || {}, me = s.slot === j.slot;
    const p = me ? m.progress : x.state === 'ready' || x.state === 'in' ? 100 : x.load || 0;
    const st = x.state === 'ready' || x.state === 'in' ? 'Ready' : x.state === 'dropped' ? 'Disconnected' : x.state === 'abandoned' ? 'Left' : (me ? m.stage : x.stage) || 'Loading…';
    const pic = net.picUrl(s.pic);
    return `<div class="pvp-row ${me ? 'me' : ''}"><span class="pvp-pic">${pic ? `<img src="${esc(pic)}" alt="">` : ''}</span><span class="pvp-name">${esc(s.name || '?')}${m.host === s.slot ? ' <b class="pvp-host">HOST</b>' : ''}</span>
      ${emblem}<span class="pvp-bar"><i style="width:${p}%"></i></span><small>${esc(st)}</small></div>`;
  };
  const team = (sq) => `<div class="pvp-team ${side(sq) === 'CT' ? 'ct' : 't'}"><h3>${side(sq) === 'CT' ? 'Counter-Terrorists' : 'Terrorists'}${sq === mySq ? ' · your team' : ''}</h3>${j.slots.filter((s) => s.squad === sq).map(row).join('')}</div>`;
  const waiting = [...m.members.values()].filter((x) => x.state !== 'ready' && x.state !== 'in' && x.state !== 'abandoned').length;
  const left = (m.loadBy || 0) - net.serverNow();
  const foot = m.host != null ? (m.loaded ? 'Starting…' : 'The match has started: you join it as soon as your game has loaded') : `${waiting ? `Waiting for ${waiting} player${waiting === 1 ? '' : 's'}` : 'Everyone\'s ready'}${left > 0 ? ` · starts by ${clock(left)}` : ''}`;
  m.load.innerHTML = `<div class="pvp-load-box"><small>Online · ${esc(NAMES[m.mode] || m.mode)}</small><h2>${esc(mapName(j.map))}</h2>
    <div class="pvp-teams">${team('A')}${team('B')}</div><div class="pvp-load-foot">${esc(foot)}</div></div>`;
}
const mapName = (id) => mm.mapName?.(id) || id;

// ---- the top bar ----------------------------------------------------------------------------------------------------------
let barEl = null;
function drawBar() {
  if (!barEl) return;
  const q = state.q, a = state.away, m = state.match, f = state.found;
  let html = '';
  if (q) html = `<span class="mm-spin"></span><span class="mm-txt"><small>Searching online · ${esc(NAMES[q.mode] || q.mode)}</small><b data-pvp-time></b></span>
    <button class="mm-x" data-pvp-cancel title="Cancel the search" aria-label="Cancel the search">✕</button>`;
  else if (f) html = `<span class="mm-spin"></span><span class="mm-txt"><small>Online · ${esc(NAMES[f.mode] || f.mode)}</small><b>Match found</b></span>`;
  else if (m && !m.begun) html = `<span class="mm-spin"></span><span class="mm-txt"><small>Online · ${esc(NAMES[m.mode] || m.mode)}</small><b>Loading the match</b></span>`;
  else if (m?.menu) html = `<span class="mm-txt"><small>Online · ${esc(NAMES[m.mode] || m.mode)}</small><b>${esc(scoreLine(m))}</b></span><button class="btn primary sm" data-pvp-resume>Resume</button>`;
  else if (a) html = `<span class="mm-txt"><small>Online match in progress</small><b data-pvp-time></b></span><button class="btn primary sm" data-pvp-reconnect>Reconnect</button><button class="btn ghost sm" data-pvp-abandon>Abandon</button>`;
  barEl.className = 'mm-bar pvp-topbar' + (q || f || (m && !m.begun) ? ' searching' : a ? ' away' : m?.menu ? ' live' : '');
  barEl.hidden = !html;
  barEl.innerHTML = html;
  barEl.querySelector('[data-pvp-cancel]')?.addEventListener('click', cancelSearch);
  barEl.querySelector('[data-pvp-resume]')?.addEventListener('click', resume);
  barEl.querySelector('[data-pvp-reconnect]')?.addEventListener('click', reconnect);
  barEl.querySelector('[data-pvp-abandon]')?.addEventListener('click', () => abandon());
  tickBar();
}
function tickBar() {
  if (!barEl || barEl.hidden) return;
  const t = barEl.querySelector('[data-pvp-time]');
  if (t && state.q) t.textContent = `${clock(state.q.waited * 1000 + (Date.now() - state.q.at))} · ${state.q.found}/${state.q.need}`;
  else if (t && state.away) t.textContent = `${clock(state.away.until - Date.now())} to reconnect`;
}
export function scoreLine(m) {
  const g = m?.game, x = g?.match;
  if (!x) return NAMES[m?.mode] || '';
  return `${g.me.team} ${x.score.A} : ${x.score.B} ${g.me.team === 'CT' ? 'T' : 'CT'} · Round ${x.round}`;
}

export function initPvp() {
  barEl = document.createElement('div');
  barEl.className = 'mm-bar pvp-topbar';
  barEl.hidden = true;
  document.querySelector('#topbar .top-right')?.prepend(barEl);
  document.addEventListener('keydown', escKey);
  mm.setOtherBusy(() => busy());
  setInterval(() => {
    tickBar();
    if (state.away && Date.now() > state.away.until) { state.away = null; changed(); }
  }, 500);
  net.on('pvp', (msg) => {
    if (msg.t !== 'pvp.q' && window.__cs2Debug) console.info('[pvp]', msg.t, JSON.stringify(msg).slice(0, 300));
    switch (msg.t) {
      case 'pvp.state': return fromState(msg);
      // (Only into the search we have: one already on its way when we cancelled would bring a search back that the server
      // no longer has. The queue's own answer, a requeue or the state after a welcome make the search; these only update it.)
      case 'pvp.q': if (state.q && state.q.mode === msg.mode) { state.q = { ...state.q, waited: msg.waited, found: msg.found, need: msg.need, split: msg.split, alone: !!msg.alone, at: Date.now() }; changed(); } return;
      case 'pvp.found': return found(msg);
      case 'pvp.accepts': if (state.found?.id === msg.id) lights(state.found, msg.n); return;
      case 'pvp.go': return start(msg);
      case 'pvp.cancel': return cancelled(msg);
      case 'pvp.paid': return paid(msg);
      case 'pvp.over': return over(msg);
    }
  });
  net.on('status', ({ status }) => {
    if (status === 'offline') { state.q = null; if (state.found) { closePopup(); state.found = null; } changed(); }
  });
  rankPictures?.().catch?.(() => {});
}
