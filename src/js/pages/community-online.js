// Friends & Chat online: the page of community.js with real players instead of its NPCs. On the left your card, friend
// requests, friends by status, requests sent, recent chats and who you've blocked; on the right a chat or a profile. The
// server keeps all of it (server/social.mjs, through net.social) and `home` is what the left side and the unread pill are
// drawn from. Make offer goes to the Trade page's own compose. Profiles have no comments in this version: a public wall is a
// bigger moderation job. S.social is the offline save's, and nothing here touches it.
//
// Players are strangers: whatever one of them wrote (a name, a summary, a message) and whatever the server refuses with
// reaches the page through esc(), on the sender's screen and the receiver's, and a name in running text goes in <bdi>.
import { esc, money, timeAgo, debounce } from '../util.js';
import { D } from '../data.js';
import * as I from '../items.js';
import { S, on } from '../state.js';
import { sfx } from '../audio.js';
import { toast, openModal, itemCard, openInspect, canInspect, showItemDetail, confirmDialog } from '../ui.js';
import { medalOf } from '../engine/levels.js';
import { levelIconHtml } from '../profile.js';
import { net } from '../net/online.js';
import { offerTo } from './trade.js';
import { avatarTag, cc, backdrop, profileHeadHtml, profileDialog } from './community.js';

const MESSAGE_MAX = 300, REPORT_MAX = 500;
const DMS = [['everyone', 'Everyone'], ['friends', 'Friends only']];
// (Said as it is: the reason goes to staff and the mod log in these words.)
const REASONS = ['Harassment or threats', 'Hate speech', 'Scam or a dishonest trade', 'Spam', 'Something else'];

// Who you're looking at ('me', or a player's id), and what you'd left behind there: kept when you leave the page.
const view = { pane: 'chat', who: null, q: '', tab: 'showcase', drafts: new Map(), scroll: new Map() };
let root = null, offs = [], homeDrawn = false;
// `home`'s answer. era: which login an answer belongs to, so one that comes after a log out is dropped. owner: the account
// everything here is from.
let home = null, homeError = '', era = 0, homeRun = null, homeAgain = false, owner = null;
const people = new Map(); // id -> Person, as last heard of
const threads = new Map(); // id -> { msgs, more, loaded, busy, error }: chats opened since connecting
const cards = new Map(); // id -> `profile`'s answer, or { error }
const cardRuns = new Map(); // id -> that request, while it's out
const windows = new Set(); // this page's open windows: what they hold means nothing after a log out

const list = (v) => (Array.isArray(v) ? v : []);
const meId = () => home?.me?.id ?? net.me()?.id;
const shownId = () => (view.who === 'me' ? meId() : view.who);
const among = (key, id) => !!home?.[key].some((p) => p.id === id);
const relationOf = (id) => (among('friends', id) ? 1 : among('requests', id) ? 2 : among('sent', id) ? 3 : 0);
const isBlocked = (id) => among('blocked', id);
const chatOf = (id) => home?.chats.find((c) => c.with.id === id);
const unreadOf = (id) => +chatOf(id)?.unread || 0;
// (Who's online comes from the `players` broadcast, by name: it has no ids.)
const isHere = (p) => net.players().some((x) => x.name === p.name);
const statusOf = (p) => (isHere(p) ? { s: 'online', label: 'Online' } : { s: 'offline', label: p.seen ? `Last online ${timeAgo(+p.seen)}` : 'Offline' });
const avatar = (p, size, status = '') => avatarTag(p.avatar && Object.hasOwn(D.agents, p.avatar) ? D.agents[p.avatar] : null, String(p.name ?? '?'), size, status);
const named = (p) => `<b><bdi>${esc(p.name)}</bdi></b>`;
const failed = (e) => { sfx.error(); toast(esc(e.message), 'bad'); };
const msgKey = (m) => String(m.id); // (a BIGSERIAL: it may come as text)
const yearOf = (t) => (+t > 9999 ? new Date(+t).getFullYear() : t || '—');

function remember(p) {
  if (p?.id == null) return;
  const { id, name, avatar: face, country, level, online, seen } = p;
  people.set(id, { id, name, avatar: face, country, level, online, seen });
}

// Unread messages and friend requests, for the pill at the top. (A blocked player's old messages have no row to read them on.)
export const unreadCount = () => (home ? home.chats.reduce((t, c) => t + (isBlocked(c.with.id) ? 0 : +c.unread || 0), 0) + home.requests.length : 0);
const announce = () => window.dispatchEvent(new Event('app:unread'));

// ---- what comes in, on this page or not ---------------------------------------------------------------------------------
export function initFriends() {
  net.on('status', ({ status }) => {
    if (status === 'offline') return forget();
    if (status !== 'online') return;
    // (Logging in over a lost connection never goes through offline: the last account's things leave here instead.)
    if (owner != null && owner !== net.me()?.id) { forget(); drawList(); drawMe(); drawRows(); }
    owner = net.me()?.id ?? null;
    // (A reconnect may have missed messages, and the page was drawn again before it got here: what's open asks again.)
    threads.clear(); cards.clear(); loadHome(); drawMain();
  });
  net.on('chat', onChat);
  net.on('friends', () => { if (net.status() === 'online') loadHome(); });
  net.on('players', () => { drawRows(); drawHead(); drawStatus(); });
}

// Logged out, thrown off or the other account next: nothing of this login stays.
function forget() {
  era++;
  home = null; homeError = ''; homeRun = null; homeAgain = false; homeDrawn = false; owner = null;
  people.clear(); threads.clear(); cards.clear(); cardRuns.clear();
  Object.assign(view, { pane: 'chat', who: null, q: '', tab: 'showcase' });
  view.drafts.clear(); view.scroll.clear();
  windows.forEach((m) => m.close());
  windows.clear();
}

function setHome(h) {
  const of = (k) => list(h[k]);
  home = { me: h.me, friends: of('friends'), requests: of('requests'), sent: of('sent'), blocked: of('blocked'), chats: of('chats'), settings: h.settings || {} };
  homeError = '';
  for (const p of [home.me, ...home.friends, ...home.requests, ...home.sent, ...home.blocked, ...home.chats.map((c) => c.with)]) remember(p);
  // What's on screen is read, whatever this says: it may be from just before chat.read landed, or what a reconnect brought in.
  for (const c of home.chats) if (+c.unread && isShown(c.with.id)) { c.unread = 0; net.social('chat.read', { id: c.with.id }).catch(() => {}); }
}
async function askHome(at) {
  do {
    homeAgain = false;
    try {
      const h = await net.social('home');
      if (at === era) setHome(h);
    } catch (e) { if (at === era) homeError = e.message || 'Request failed'; }
  } while (homeAgain && at === era);
  if (at !== era) return;
  homeRun = null;
  announce();
  drawLive();
}
// Asks for `home` again: one request at a time, and one more after it if something changed meanwhile.
function loadHome() {
  if (homeRun) { homeAgain = true; return homeRun; }
  return (homeRun = askHome(era));
}

function loadCard(id) {
  if (cardRuns.has(id)) return cardRuns.get(id);
  const at = era, known = people.has(id);
  const run = net.social('profile', { id }).then((p) => { if (at === era) { cards.set(id, p); remember(p); } }, (e) => { if (at === era) cards.set(id, { error: e.message || 'Request failed' }); })
    .then(() => {
      if (at !== era) return;
      cardRuns.delete(id);
      if (root && shownId() === id && (view.pane === 'profile' || !known)) drawMain();
    });
  cardRuns.set(id, run);
  return run;
}

// A message came in or went out: into its chat if that's open, and to the top of the chats. False if we have it already. (Two
// sent at the same moment can get here the wrong way round: they go by id, as chat.history has them.)
function took(id, msg, unread) {
  const t = threads.get(id);
  if (t?.msgs.some((m) => msgKey(m) === msgKey(msg))) return false;
  t?.msgs.splice(t.msgs.findLastIndex((m) => +m.id < +msg.id) + 1, 0, msg);
  if (isShown(id)) appendMsg(people.get(id), msg);
  const c = chatOf(id) || (home && people.has(id) ? { with: people.get(id), unread: 0 } : null);
  if (!c) { loadHome(); return true; }
  if (!c.last || +msg.id > +c.last.id) c.last = msg;
  if (unread) c.unread = (+c.unread || 0) + 1;
  home.chats = [c, ...home.chats.filter((x) => x !== c)];
  drawRows();
  return true;
}

function onChat({ msg, who } = {}) {
  if (!msg) return;
  if (homeRun) homeAgain = true; // (the answer on its way may be from before this message, and would wipe it from the counts)
  const mine = +msg.from === meId(), id = mine ? +msg.to : +msg.from;
  if (who?.id === id) remember(who);
  const reading = !mine && isShown(id);
  if (!took(id, msg, !mine && !reading)) return;
  if (reading) net.social('chat.read', { id }).catch(() => {});
  if (mine || reading) return;
  announce();
  sfx.buy();
  const text = [...String(msg.text)];
  const el = toast(`${named(people.get(id) || { name: 'Someone' })}: <bdi>${esc(text.length > 120 ? text.slice(0, 117).join('') + '…' : text.join(''))}</bdi>`, 'msg link');
  el.addEventListener('click', () => { view.who = id; view.pane = 'chat'; window.dispatchEvent(new CustomEvent('app:go', { detail: 'community' })); });
}

// ---- the page -----------------------------------------------------------------------------------------------------------
export function render(r) {
  root = r;
  offs.forEach((o) => o());
  offs = [on('inv', () => { if (view.who === 'me' && home) loadCard(meId()); })];
  cards.clear();
  homeDrawn = false;
  root.innerHTML = '<div class="page community live"><div class="cm-grid"><aside class="fr-panel" data-list></aside><section class="cm-main" data-main></section></div></div>';
  drawList();
  drawAll();
  if (net.status() === 'online') loadHome();
}
export function destroy() {
  const box = root?.querySelector('[data-msgs]');
  // (Under the chat it's showing: a toast's click has moved view.who on by now.)
  if (box && box.scrollHeight - box.scrollTop - box.clientHeight > 40) view.scroll.set(+box.dataset.with, box.scrollTop);
  offs.forEach((o) => o());
  offs = [];
  root = null;
}

function drawAll() { drawMe(); drawRows(); drawMain(); }
// What changed without you doing anything: the parts that show it, and never the box you're typing in.
function drawLive() {
  if (!root) return;
  if (!homeDrawn) return drawAll();
  drawMe();
  drawRows();
  drawHead();
  if (view.pane === 'profile') loadCard(shownId());
}
function pick(id, pane) {
  if (id === meId()) id = 'me';
  view.who = id;
  view.pane = id === 'me' ? 'profile' : pane || (chatOf(id) || relationOf(id) === 1 ? 'chat' : 'profile');
  view.tab = 'showcase';
  if (view.pane === 'profile') cards.delete(shownId());
  drawAll();
}

// ---- the friends list ---------------------------------------------------------------------------------------------------
// (The search box is drawn once and only what's under it changes, so a message coming in doesn't take it from under you.)
function drawList() {
  const el = root?.querySelector('[data-list]');
  if (!el) return;
  el.innerHTML = `<div data-me></div>
    <input class="input" type="search" data-q placeholder="Search friends and chats" value="${esc(view.q)}">
    <div class="fr-groups" data-rows></div>
    <div class="fr-group"><div class="fr-gh">Everyone</div><button class="btn sm ghost" data-browse style="width:100%">Find players</button></div>`;
  const q = el.querySelector('[data-q]');
  q.addEventListener('input', () => { view.q = q.value; drawRows(); });
  el.querySelector('[data-browse]').addEventListener('click', findPlayers);
  el.querySelector('[data-me]').addEventListener('click', () => { if (home) pick('me'); });
  el.querySelector('[data-rows]').addEventListener('click', (e) => {
    const acc = e.target.closest('[data-acc]'), row = e.target.closest('[data-who]');
    if (acc) setFriend(people.get(+acc.dataset.acc), true);
    else if (row) pick(+row.dataset.who);
  });
}
function drawMe() {
  const el = root?.querySelector('[data-me]');
  if (!el) return;
  const me = home?.me || { name: net.me()?.name || 'You' };
  el.innerHTML = `<div class="fr-me ${view.who === 'me' ? 'on' : ''}">${avatar(me, 40, 'online')}<div class="fr-txt"><div class="fr-name">${esc(me.name)}</div><div class="fr-st">${levelIconHtml(S.prof.level, 16)} Level ${S.prof.level} · View profile</div></div></div>`;
}
function rowHtml(p, kind) {
  const st = statusOf(p), un = unreadOf(p.id), last = kind === 'chat' ? chatOf(p.id)?.last : null;
  return `<div class="fr-row ${view.who === p.id ? 'on' : ''} st-${st.s}" data-who="${esc(p.id)}">${avatar(p, 34, st.s)}
    <div class="fr-txt"><div class="fr-name">${esc(p.name)}</div><div class="fr-st"><span class="fr-line">${esc(kind === 'blocked' ? 'Blocked' : last ? last.text : st.label)}</span></div></div>
    ${un && kind !== 'blocked' ? `<span class="pill">${un}</span>` : ''}${kind === 'req' ? `<button class="btn sm primary" data-acc="${esc(p.id)}">Accept</button>` : ''}</div>`;
}
function drawRows() {
  const el = root?.querySelector('[data-rows]');
  if (!el) return;
  if (!home) { el.innerHTML = ''; return; }
  const q = view.q.trim().toLowerCase();
  const hit = (p) => !q || String(p.name).toLowerCase().includes(q);
  const friends = home.friends.filter(hit).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const groups = [
    ['Friend requests', home.requests.filter(hit), 'req'],
    ['Online friends', friends.filter(isHere)],
    ['Offline friends', friends.filter((p) => !isHere(p))],
    ['Requests sent', home.sent.filter(hit)],
    ['Recent chats', home.chats.map((c) => c.with).filter((p) => hit(p) && !relationOf(p.id) && !isBlocked(p.id)), 'chat'],
    ['Blocked', home.blocked.filter(hit), 'blocked'],
  ].filter(([, rows]) => rows.length);
  el.innerHTML = groups.length ? groups.map(([t, rows, kind]) => `<div class="fr-group"><div class="fr-gh">${t} <span>(${rows.length})</span></div>${rows.map((p) => rowHtml(p, kind)).join('')}</div>`).join('')
    : `<div class="muted fr-none">${q ? 'Nobody by that name here. Find players searches everyone.' : 'No friends yet. Find players to meet some.'}</div>`;
}

// Who's online, and anyone by username.
function findPlayers() {
  const m = openModal({
    title: 'Find players', cls: 'wide',
    body: `<p class="muted" style="margin:0 0 10px">Who's online right now. Search to find anyone by username.</p>
      <input class="input" type="search" data-find placeholder="Search everyone by username" maxlength="20" style="width:100%;margin-bottom:10px">
      <div class="fr-browse" data-found><div class="empty" style="padding:20px">Loading…</div></div>`,
    foot: '<button class="btn ghost" data-close>Close</button>',
  });
  windows.add(m);
  const found = m.el.querySelector('[data-found]'), input = m.el.querySelector('[data-find]');
  let asked = 0;
  const search = async () => {
    const mine = ++asked, q = input.value.trim();
    let rows;
    try { rows = list(await net.social('find', { q })).filter((p) => p.id !== meId()); }
    catch (e) { if (mine === asked) found.innerHTML = `<div class="empty" style="padding:20px">${esc(e.message)}</div>`; return; }
    if (mine !== asked || !found.isConnected) return;
    rows.forEach(remember);
    const tag = (p) => (isBlocked(p.id) ? 'Blocked' : ['', 'Friend', 'Wants to be friends', 'Request sent'][relationOf(p.id)]);
    found.innerHTML = rows.length ? rows.map((p) => { const st = statusOf(p); return `<div class="fr-row" data-who="${esc(p.id)}">${avatar(p, 40, st.s)}
      <div class="fr-txt"><div class="fr-name">${cc(p.country)}${esc(p.name)}</div><div class="fr-st"><span class="fr-line">Level ${esc(p.level ?? 1)} · ${esc(st.label)}</span></div></div>
      <span class="muted" style="font-size:11px">${tag(p)}</span></div>`; }).join('')
      : `<div class="empty" style="padding:20px">${q ? 'Nobody by that name.' : 'Nobody else is online right now.'}</div>`;
    found.querySelectorAll('[data-who]').forEach((x) => x.addEventListener('click', () => { m.close(); pick(+x.dataset.who, 'profile'); }));
  };
  input.addEventListener('input', debounce(search, 250));
  search();
}

// ---- the right side -----------------------------------------------------------------------------------------------------
function drawMain() {
  const el = root?.querySelector('[data-main]');
  if (!el) return;
  if (!home) {
    const down = net.status() !== 'online';
    el.innerHTML = `<div class="empty">${down ? 'Connecting to the server…' : homeError ? `${esc(homeError)}<br><button class="btn sm" data-retry style="margin-top:10px">Try again</button>` : 'Loading…'}</div>`;
    el.querySelector('[data-retry]')?.addEventListener('click', () => { homeError = ''; drawMain(); loadHome(); });
    return;
  }
  homeDrawn = true;
  // The first time here: where there's something to read, or else your own profile.
  if (view.who == null) {
    const c = home.chats.find((x) => +x.unread && !isBlocked(x.with.id)) || home.chats.find((x) => !isBlocked(x.with.id));
    view.who = c ? c.with.id : 'me';
    view.pane = c ? 'chat' : 'profile';
    drawMe(); drawRows();
  }
  if (view.who === 'me' || view.pane === 'profile') return drawProfile(el, view.who);
  const p = people.get(view.who);
  if (p) return drawChat(el, p);
  // Someone we've not heard of on this login (a reconnect, say): `profile` says who they are.
  const card = cards.get(view.who);
  el.innerHTML = `<div class="empty">${card?.error ? esc(card.error) : 'Loading…'}</div>`;
  if (!card) loadCard(view.who);
}

function headHtml(p) {
  const st = statusOf(p), rel = relationOf(p.id), blocked = isBlocked(p.id);
  return `${avatar(p, 44, st.s)}
    <div class="grow"><div class="ch-name">${cc(p.country)}${esc(p.name)}</div><div class="fr-st st-${st.s}">${esc(st.label)}</div></div>
    <button class="btn sm ${view.pane === 'chat' ? 'primary' : ''}" data-pane="chat">Chat</button>
    <button class="btn sm ${view.pane === 'profile' ? 'primary' : ''}" data-pane="profile">Profile</button>
    <button class="btn sm gold" data-offer>Make offer</button>
    ${blocked ? '' : rel === 1 ? '<button class="btn sm ghost" data-unfriend>Remove friend</button>'
      : rel === 2 ? '<button class="btn sm primary" data-friend>Accept request</button><button class="btn sm ghost" data-unfriend>Decline</button>'
      : rel === 3 ? '<button class="btn sm ghost" data-unfriend>Cancel request</button>' : '<button class="btn sm" data-friend>Add friend</button>'}
    <button class="btn sm ghost" data-block>${blocked ? 'Unblock' : 'Block'}</button>
    <button class="btn sm ghost" data-report>Report</button>`;
}
function drawHead() {
  const el = root?.querySelector('[data-head]'), p = people.get(view.who);
  if (!el || !p) return;
  el.innerHTML = headHtml(p);
  el.querySelectorAll('[data-pane]').forEach((b) => b.addEventListener('click', () => {
    view.pane = b.dataset.pane;
    if (view.pane === 'profile') cards.delete(p.id);
    drawMain();
  }));
  el.querySelector('[data-offer]').addEventListener('click', () => offerTo(p.name));
  el.querySelector('[data-friend]')?.addEventListener('click', () => setFriend(p, true));
  el.querySelector('[data-unfriend]')?.addEventListener('click', () => unfriend(p));
  el.querySelector('[data-block]').addEventListener('click', () => setBlock(p));
  el.querySelector('[data-report]').addEventListener('click', () => reportWindow(p));
}

async function setFriend(p, yes, done) {
  if (!p) return;
  let r;
  try { r = await net.social('friend', { id: p.id, on: yes }); } catch (e) { return failed(e); }
  if (yes) { sfx.buy(); toast(r?.relation === 1 ? `You and ${named(p)} are now friends` : `Friend request sent to ${named(p)}`, 'good'); }
  else if (done) toast(done, '');
  loadHome();
}
async function unfriend(p) {
  const rel = relationOf(p.id);
  if (rel === 1 && !(await confirmDialog(`Remove ${named(p)} from your friends?`, { ok: 'Remove', danger: true }))) return;
  setFriend(p, false, rel === 2 ? 'Request declined' : rel === 3 ? 'Request cancelled' : `${named(p)} is no longer a friend`);
}
// (They aren't told, and nothing they see changes but that their messages are refused like anyone's can be.)
async function setBlock(p) {
  const yes = !isBlocked(p.id);
  if (yes && !(await confirmDialog(`Block ${named(p)}? Neither of you can message the other, they can't friend you, and if you're friends that ends. They aren't told.`, { title: 'Block player', ok: 'Block', danger: true }))) return;
  try { await net.social('block', { id: p.id, on: yes }); } catch (e) { return failed(e); }
  toast(`${named(p)} ${yes ? 'is blocked' : 'is no longer blocked'}`, yes ? '' : 'good');
  await loadHome();
  if (view.who === p.id) drawMain(); // (the box to type in comes or goes)
}

function reportWindow(p) {
  const m = openModal({
    title: `Report <bdi>${esc(p.name)}</bdi>`,
    body: `<div class="edit-prof"><p class="muted" style="margin:0;line-height:1.5">Staff get your reason and a copy of your last 30 messages with this player. It doesn't block them: you can do that too.</p>
      <label>Reason<select class="input" data-why>${REASONS.map((n) => `<option>${n}</option>`).join('')}</select></label>
      <label>Anything to add (optional)<textarea class="input" data-more maxlength="${REPORT_MAX}" rows="3"></textarea></label></div>`,
    foot: '<button class="btn ghost" data-close>Cancel</button><button class="btn danger" data-send>Send report</button>',
  });
  windows.add(m);
  const btn = m.el.querySelector('[data-send]');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await net.social('report', { id: p.id, reason: m.el.querySelector('[data-why]').value, text: m.el.querySelector('[data-more]').value.trim() });
      m.close();
      toast('Report sent to the staff. Thank you.', 'good');
    } catch (e) { btn.disabled = false; failed(e); }
  });
}

// ---- chat -----------------------------------------------------------------------------------------------------------------
const threadOf = (id) => { if (!threads.has(id)) threads.set(id, { msgs: [], more: false, loaded: false, busy: false, error: '' }); return threads.get(id); };
const isShown = (id) => !!root && view.pane === 'chat' && view.who === id && !!root.querySelector('[data-msgs]');
const msgHtml = (m, p) => {
  const mine = +m.from === meId();
  return `<div class="msg ${mine ? 'me' : 'them'}" data-id="${esc(m.id)}">${mine ? '' : avatar(p, 28)}<div class="bub"><div class="txt" dir="auto">${esc(m.text)}</div><div class="when">${timeAgo(+m.at)}</div></div></div>`;
};

function drawChat(el, p) {
  const blocked = isBlocked(p.id);
  el.innerHTML = `<div class="ch-head" data-head></div><div class="msgs" data-msgs data-with="${esc(p.id)}"></div>
    ${blocked ? '<div class="composer muted">You blocked this player. Unblock them to chat.</div>'
      : `<form class="composer" data-form><input class="input" data-text maxlength="${MESSAGE_MAX}" placeholder="Message ${esc(p.name)}…" value="${esc(view.drafts.get(p.id) || '')}" autocomplete="off"><button class="btn primary">Send</button></form>`}`;
  drawHead();
  const t = threadOf(p.id), box = el.querySelector('[data-msgs]');
  drawMsgs(p);
  box.addEventListener('scroll', () => { if (box.scrollTop < 80) older(p); });
  if (!t.loaded && !t.busy) loadThread(p);
  const c = chatOf(p.id);
  if (c?.unread) {
    c.unread = 0;
    announce();
    drawRows();
    net.social('chat.read', { id: p.id }).catch(() => {});
  }
  if (blocked) return;
  const form = el.querySelector('[data-form]'), input = el.querySelector('[data-text]');
  input.addEventListener('input', () => view.drafts.set(p.id, input.value));
  form.addEventListener('submit', (e) => { e.preventDefault(); send(p, input); });
  input.focus();
}

function drawMsgs(p) {
  const box = root?.querySelector('[data-msgs]'), t = threadOf(p.id);
  if (!box) return;
  box.innerHTML = t.msgs.length ? t.msgs.map((m) => msgHtml(m, p)).join('')
    : `<div class="empty" style="padding:40px">${t.error ? `${esc(t.error)}<br><button class="btn sm" data-retry style="margin-top:10px">Try again</button>` : t.loaded ? `Say hi to <bdi>${esc(p.name)}</bdi>.` : 'Loading…'}</div>`;
  box.querySelector('[data-retry]')?.addEventListener('click', () => loadThread(p));
  box.scrollTop = view.scroll.get(p.id) ?? box.scrollHeight;
  if (t.loaded) view.scroll.delete(p.id);
  // (A first page too short to scroll would never ask for the rest.)
  if (t.more && box.scrollHeight <= box.clientHeight) older(p);
}
function appendMsg(p, m) {
  const box = root?.querySelector('[data-msgs]');
  if (!box || !p) return;
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  box.querySelector(':scope > .empty')?.remove();
  const next = [...box.children].find((el) => +el.dataset.id > +m.id);
  if (next) next.insertAdjacentHTML('beforebegin', msgHtml(m, p));
  else box.insertAdjacentHTML('beforeend', msgHtml(m, p));
  if (near || +m.from === meId()) box.scrollTop = box.scrollHeight;
}

// The newest messages. (Anything that came in while they were on their way stays, after them.)
async function loadThread(p) {
  const t = threadOf(p.id), at = era;
  if (t.busy) return;
  t.busy = true;
  t.error = '';
  try {
    const r = await net.social('chat.history', { id: p.id });
    if (at !== era) return;
    const first = list(r?.msgs), seen = new Set(first.map(msgKey));
    t.msgs = [...first, ...t.msgs.filter((m) => !seen.has(msgKey(m)))];
    t.more = !!r?.more;
    t.loaded = true;
  } catch (e) {
    if (at !== era) return;
    t.error = e.message || 'Request failed';
  }
  t.busy = false;
  if (isShown(p.id)) drawMsgs(p);
}
// The ones before those, when you scroll up to them: added above, and what you were reading stays where it was.
async function older(p) {
  const t = threadOf(p.id), at = era;
  if (!t.more || t.busy || !t.msgs.length) return;
  t.busy = true;
  try {
    const r = await net.social('chat.history', { id: p.id, before: t.msgs[0].id });
    if (at !== era) return;
    const have = new Set(t.msgs.map(msgKey)), add = list(r?.msgs).filter((m) => !have.has(msgKey(m)));
    t.msgs = [...add, ...t.msgs];
    t.more = !!r?.more && add.length > 0;
    const box = isShown(p.id) ? root.querySelector('[data-msgs]') : null;
    if (box && add.length) {
      // (Measured from the bottom: the browser moves the scroll itself for what's added above, except at the very top.)
      const fromEnd = box.scrollHeight - box.scrollTop;
      box.insertAdjacentHTML('afterbegin', add.map((m) => msgHtml(m, p)).join(''));
      box.scrollTop = box.scrollHeight - fromEnd;
    }
  } catch (e) { if (at === era) failed(e); }
  if (at === era) t.busy = false;
}

async function send(p, input) {
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  view.drafts.delete(p.id);
  try {
    const r = await net.social('chat.send', { id: p.id, text });
    if (r?.msg) took(p.id, r.msg, false);
  } catch (e) {
    failed(e);
    // What you wrote comes back, unless you've moved on or started something else.
    if (input.isConnected && !input.value) { input.value = text; view.drafts.set(p.id, text); }
  }
}

// ---- profiles -------------------------------------------------------------------------------------------------------------
const statusHtml = (st) => `${st.s === 'offline' ? 'Currently Offline' : 'Currently Online'}<small>${esc(st.label)}</small>`;
function drawStatus() {
  const el = root?.querySelector('[data-status]'), p = people.get(view.who);
  if (!el || !p) return;
  const st = statusOf(p);
  el.className = `sp-status st-${st.s}`;
  el.innerHTML = statusHtml(st);
}
function drawProfile(el, who) {
  const mine = who === 'me', id = shownId(), p = cards.get(id);
  const head = mine ? '' : '<div class="ch-head" data-head></div>';
  if (!p || p.error) {
    el.innerHTML = `${head}<div class="empty">${p ? `${esc(p.error)}<br><button class="btn sm" data-retry style="margin-top:10px">Try again</button>` : 'Loading…'}</div>`;
    drawHead();
    el.querySelector('[data-retry]')?.addEventListener('click', () => { cards.delete(id); drawMain(); });
    if (!p) loadCard(id);
    return;
  }
  const items = [...list(p.inv)].sort((a, b) => I.itemValue(b) - I.itemValue(a));
  const show = list(p.showcase).length ? list(p.showcase) : items.slice(0, 6);
  const value = +p.value || items.reduce((t, it) => t + I.itemValue(it), 0);
  const count = +p.count || 0, st = mine ? { s: 'online', label: 'Online' } : statusOf(p), showInv = !mine && view.tab === 'inventory';
  const top = { name: p.name, country: p.country, joined: esc(yearOf(p.joined)), bio: p.bio || 'No information given.', level: +p.level || 1, medal: medalOf({ medals: +p.medals || 0 }), medals: +p.medals || 0 };
  el.innerHTML = `${head}<div class="sp" data-sp>
    ${profileHeadHtml(top, avatar(p, 120), mine)}
    <div class="sp-body">
      <div class="sp-left">
        ${mine ? '' : `<div class="seg" data-tabs><button data-v="showcase" class="${showInv ? '' : 'active'}">Showcase</button><button data-v="inventory" class="${showInv ? 'active' : ''}">Inventory (${count})</button></div>`}
        ${showInv ? `<div class="grid">${items.map((it) => itemCard(it)).join('') || '<div class="empty">Empty</div>'}</div>
          <p class="muted" style="font-size:12px">${count > items.length ? `Their ${items.length} most valuable items. ` : ''}Click an item to inspect it. Want something? <a href="#" data-offer2>Make an offer</a>.</p>`
        : `<div class="sp-box"><div class="sp-bh">Item showcase${mine && !p.picked ? ' <span class="muted">(your most valuable: pick your own in Edit profile)</span>' : ''}</div><div class="grid showcase">${show.map((it) => itemCard(it)).join('') || '<div class="empty">Nothing to show yet</div>'}</div></div>`}
      </div>
      <div class="sp-right">
        <div class="sp-status st-${st.s}" data-status>${statusHtml(st)}</div>
        <div class="sp-stat"><span>Inventory value</span><b>${money(value)}</b></div>
        <div class="sp-stat"><span>Items</span><b>${count}</b></div>
        <div class="sp-stat"><span>Friends</span><b>${+p.friends || 0}</b></div>
        ${mine ? '' : `<button class="btn primary" data-msg ${isBlocked(id) ? 'disabled' : ''}>Message</button><button class="btn gold" data-offer3>Make offer</button>`}
      </div>
    </div></div>`;
  drawHead();
  el.querySelectorAll('[data-tabs] button').forEach((b) => b.addEventListener('click', () => { view.tab = b.dataset.v; drawMain(); }));
  el.querySelector('[data-edit]')?.addEventListener('click', editProfile);
  el.querySelector('[data-msg]')?.addEventListener('click', () => { view.pane = 'chat'; drawMain(); });
  for (const sel of ['[data-offer2]', '[data-offer3]']) el.querySelector(sel)?.addEventListener('click', (e) => { e.preventDefault(); offerTo(p.name); });
  el.querySelectorAll('.sp .card[data-uid]').forEach((c) => c.addEventListener('click', () => {
    const it = mine ? S.inv.find((x) => x.uid === c.dataset.uid) : [...items, ...show].find((x) => x.uid === c.dataset.uid);
    if (it) mine ? showItemDetail(it) : canInspect(it) && openInspect(it);
  }));
  backdrop(el.querySelector('[data-sp]'), { bg: p.bg });
}

async function editProfile() {
  const p = cards.get(meId()), at = era;
  if (!p || p.error || !home) return;
  const dms = home.settings.dms || DMS[0][0];
  const m = await profileDialog({
    // (Your most valuable items, shown until you pick some, aren't picks to save.)
    me: { name: p.name, bio: p.bio || '', country: p.country || '', avatar: p.avatar || null, bg: p.bg || null, showcase: p.picked ? list(p.showcase).map((it) => it.uid) : [] },
    named: false,
    extra: `<label>Who can message you<select class="input" data-dms>${DMS.map(([k, n]) => `<option value="${k}" ${k === dms ? 'selected' : ''}>${n}</option>`).join('')}</select></label>`,
    save: async (f, el) => {
      // (The maps come from this PC's CS2: with no list, or yours not on it, the None showing isn't a choice, and yours stays.)
      const maps = el.querySelector('[data-bg]');
      const unseen = !maps || (!maps.value && ![...maps.options].some((o) => o.value === p.bg));
      await net.social('profile.set', { ...f, bg: unseen ? undefined : f.bg, dms: el.querySelector('[data-dms]').value });
      cards.delete(meId());
      await loadHome();
      if (view.who === 'me') drawMain();
    },
  });
  if (at === era) windows.add(m); else m.close();
}
