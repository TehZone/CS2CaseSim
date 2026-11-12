// Friends & Chat and profiles, like Steam's, with the NPC players of engine/npcs.js (offline only). On the left your
// friends by status, friend requests and people you may know; on the right a chat (their offers inline, to accept,
// decline or haggle over: a price and an argument for it, or just type, "would you do $500? it's a 0.01 float") or a
// profile: their level and medal, item showcase, badges, comments and inventory (make them an offer from it), or yours,
// which you set up yourself (name, a picture of your own or an agent, country, a map behind it, a bio, up to six items to
// show off and a badge to feature). Faces (the picture with the featured badge in its corner) are faces.js's: an NPC
// features the rarest pin they have. Online the page is about real players instead: community-online.js takes over, and
// uses what's exported here so it looks the same.
import { esc, money, timeAgo, imgUrl } from '../util.js';
import { D } from '../data.js';
import * as I from '../items.js';
import { S, on } from '../state.js';
import { act, online } from '../backend.js';
import { sfx } from '../audio.js';
import { toast, openModal, itemCard, openInspect, canInspect, showItemDetail, confirmDialog } from '../ui.js';
import { mountPicker } from '../picker.js';
import * as N from '../engine/npcs.js';
import { ownedItems } from '../engine/storage.js';
import { MEDALS, medalOf } from '../engine/levels.js';
import { levelIconHtml, medalHtml, passiveText } from '../profile.js';
import { cs2Play } from '../cs2/api.js';
import { backgroundMaps } from '../menu.js';
import { avatarHtml as faceHtml, myFace, npcFace, badgesBoxHtml, badgeList, makePicture } from '../faces.js';
import { badgeItem } from '../engine/badges.js';
import { PIC_SIZE } from '../engine/picture.js';
import { render as renderOnline, destroy as destroyOnline, unreadCount as unreadOnline } from './community-online.js';

const view = { pane: 'chat', who: null, q: '', tab: 'showcase', haggle: null };
let root = null, offs = [];

const so = () => S.social;
const people = () => (so() ? N.crowd(so().seed) : []);
const stateOf = (id) => so()?.npcs[id] || null;
const npc = (id) => (so() ? N.npcOf(so().seed, id) : null);
export const unreadCount = () => (online() ? unreadOnline() : Object.values(so()?.unread || {}).reduce((t, n) => t + n, 0) + people().filter((n) => stateOf(n.id)?.friend === 2).length);

export function openChat(id) { view.pane = 'chat'; view.who = id; view.haggle = null; window.dispatchEvent(new CustomEvent('app:go', { detail: 'community' })); }
export function openPerson(id) { view.pane = 'profile'; view.who = id; view.tab = 'showcase'; window.dispatchEvent(new CustomEvent('app:go', { detail: 'community' })); }

export function render(r) {
  offs.forEach((o) => o());
  offs = [];
  // (Nothing here draws online: `root` stays empty, so the page on screen is only ever the other file's.)
  if (online()) { root = null; renderOnline(r); return; }
  root = r;
  offs = [on('social', () => drawAll()), on('inv', () => view.pane === 'profile' && drawMain())];
  root.innerHTML = '<div class="page community"><div class="cm-grid"><aside class="fr-panel" data-list></aside><section class="cm-main" data-main></section></div></div>';
  if (!so()) act('npc.tick').then(drawAll).catch((e) => toast(esc(e.message), 'bad'));
  if (!view.who) { const first = people().find((n) => so()?.unread[n.id]) || people().find((n) => stateOf(n.id)?.friend === 1); view.who = first?.id || 'me'; view.pane = first ? 'chat' : 'profile'; }
  drawAll();
}
export function destroy() { offs.forEach((o) => o()); offs = []; root = null; destroyOnline(); }

function drawAll() { if (!root || online() || !so()) return; drawList(); drawMain(); }

// ---- avatars and names -------------------------------------------------------------------------------------------------
// (faces.js draws them: yours as Edit profile set it, an NPC's agent with the rarest pin they have in its corner)
function avatarHtml(id, size = 32, status = '') {
  return faceHtml(id === 'me' ? myFace() : npcFace(so(), npc(id)), size, status);
}
const myName = () => so()?.me?.name || 'You';
// A country, as a small tag (Windows draws flag emoji as two letters anyway).
export const cc = (c) => (c ? `<span class="cc">${esc(c)}</span>` : '');
const kindLabel = (n) => (n.type === 'collector' ? N.FOCUS[n.focus].n : n.type === 'beginner' ? 'New to trading' : 'Player');
const kindTag = (n) => (n.type === 'collector' ? ' <span class="fr-tag">Collector</span>' : n.type === 'beginner' ? ' <span class="fr-tag new">New</span>' : '');

// ---- the friends list -----------------------------------------------------------------------------------------------------------
function drawList() {
  const el = root?.querySelector('[data-list]');
  if (!el) return;
  const q = view.q.toLowerCase();
  const match = (n) => !q || n.name.toLowerCase().includes(q);
  const all = people().filter(match);
  const friends = all.filter((n) => stateOf(n.id)?.friend === 1);
  const pres = (n) => N.presence(n);
  const groups = [
    ['Friend requests', all.filter((n) => stateOf(n.id)?.friend === 2), 'req'],
    ['In-Game', friends.filter((n) => pres(n).s === 'ingame')],
    ['Online', friends.filter((n) => ['online', 'away'].includes(pres(n).s))],
    ['Offline', friends.filter((n) => pres(n).s === 'offline')],
    ['Requests sent', all.filter((n) => stateOf(n.id)?.friend === 3)],
    ['People you may know', all.filter((n) => !stateOf(n.id)?.friend && (so().threads[n.id] || so().feed.some((f) => f.npc === n.id))).slice(0, 12)],
  ];
  const row = (n, req) => {
    const p = pres(n), un = so().unread[n.id] || 0, on_ = view.who === n.id;
    return `<div class="fr-row ${on_ ? 'on' : ''} st-${p.s}" data-who="${n.id}">${avatarHtml(n.id, 34, p.s)}
      <div class="fr-txt"><div class="fr-name">${esc(n.name)}${kindTag(n)}</div><div class="fr-st">${esc(p.label)}</div></div>
      ${req ? `<button class="btn sm primary" data-acc="${n.id}">Accept</button>` : un ? `<span class="pill">${un}</span>` : ''}</div>`;
  };
  el.innerHTML = `<div class="fr-me ${view.who === 'me' ? 'on' : ''}" data-who="me">${avatarHtml('me', 40, 'online')}<div class="fr-txt"><div class="fr-name">${esc(myName())}</div><div class="fr-st">${levelIconHtml(S.prof.level, 16)} Level ${S.prof.level} · View profile</div></div></div>
    <input class="input" type="search" data-q placeholder="Search friends and players" value="${esc(view.q)}">
    ${groups.filter(([, list]) => list.length).map(([t, list, req]) => `<div class="fr-group"><div class="fr-gh">${t} <span>(${list.length})</span></div>${list.map((n) => row(n, req)).join('')}</div>`).join('')}
    <div class="fr-group"><div class="fr-gh">Everyone</div><button class="btn sm ghost" data-browse style="width:100%">Find players</button></div>`;
  el.querySelectorAll('[data-who]').forEach((x) => x.addEventListener('click', (e) => {
    if (e.target.closest('[data-acc]')) return;
    view.who = x.dataset.who; view.haggle = null;
    view.pane = view.who === 'me' ? 'profile' : (so().threads[view.who] || stateOf(view.who)?.friend === 1 ? 'chat' : 'profile');
    drawAll();
  }));
  el.querySelectorAll('[data-acc]').forEach((b) => b.addEventListener('click', async () => { await act('npc.friend', { npc: b.dataset.acc, on: true }); sfx.buy(); }));
  const qi = el.querySelector('[data-q]');
  qi.addEventListener('input', () => { view.q = qi.value; drawList(); const n = root.querySelector('[data-q]'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); });
  el.querySelector('[data-browse]').addEventListener('click', browsePlayers);
}

// The active players and anyone else you've dealt with; a search finds anyone (everyone else is in the Item Database too,
// as the owners).
function browsePlayers() {
  const all = people();
  const m = openModal({
    title: 'Find players', cls: 'wide',
    body: `<p class="muted" style="margin:0 0 10px">The traders around you. ${(all.length - all.filter((n) => n.active).length).toLocaleString()} more own the items in the <b>Item Database</b>: search for them by name, or click an owner there to visit them.</p>
      <input class="input" type="search" data-find placeholder="Search everyone by name" style="width:100%;margin-bottom:10px">
      <div class="fr-browse" data-found></div>`,
    foot: '<button class="btn ghost" data-close>Close</button>',
  });
  const found = m.el.querySelector('[data-found]'), input = m.el.querySelector('[data-find]');
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    const list = q ? all.filter((n) => n.name.toLowerCase().includes(q)).slice(0, 60) : all.filter((n) => n.active || stateOf(n.id));
    found.innerHTML = list.length ? list.map((n) => { const st = stateOf(n.id); return `<div class="fr-row" data-who="${n.id}">${avatarHtml(n.id, 40, N.presence(n).s)}
      <div class="fr-txt"><div class="fr-name">${cc(n.country)}${esc(n.name)}${kindTag(n)}</div><div class="fr-st">${esc(kindLabel(n))} · Level ${n.level}</div></div>
      <span class="muted" style="font-size:11px">${st?.friend === 1 ? 'Friend' : st?.friend === 3 ? 'Request sent' : st?.friend === 2 ? 'Wants to be friends' : ''}</span></div>`; }).join('')
      : '<div class="empty" style="padding:20px">Nobody by that name.</div>';
    found.querySelectorAll('[data-who]').forEach((x) => x.addEventListener('click', () => { m.close(); view.who = x.dataset.who; view.pane = 'profile'; view.tab = 'showcase'; drawAll(); }));
  };
  input.addEventListener('input', draw);
  draw();
}

// ---- the right side ---------------------------------------------------------------------------------------------------------------
function drawMain() {
  const el = root?.querySelector('[data-main]');
  if (!el || !so()) return;
  if (view.who === 'me') return drawProfile(el, 'me');
  if (!npc(view.who)) { el.innerHTML = '<div class="empty">Pick a friend on the left.</div>'; return; }
  // (Offline the action runs at once and draws this again: the placeholder goes first.)
  if (!stateOf(view.who)) { el.innerHTML = '<div class="empty">Loading…</div>'; act('npc.read', { npc: view.who }).catch((e) => toast(esc(e.message), 'bad')); return; }
  if (view.pane === 'profile') return drawProfile(el, view.who);
  drawChat(el, view.who);
}

function headerHtml(n) {
  const st = stateOf(n.id), p = N.presence(n);
  return `<div class="ch-head">${avatarHtml(n.id, 44, p.s)}
    <div class="grow"><div class="ch-name">${cc(n.country)}${esc(n.name)} <span class="fr-tag">${esc(kindLabel(n))}</span></div><div class="fr-st st-${p.s}">${esc(p.label)}</div></div>
    <button class="btn sm ${view.pane === 'chat' ? 'primary' : ''}" data-pane="chat">Chat</button>
    <button class="btn sm ${view.pane === 'profile' ? 'primary' : ''}" data-pane="profile">Profile</button>
    <button class="btn sm gold" data-offer>Make offer</button>
    ${st?.friend === 1 ? '<button class="btn sm ghost" data-unfriend>Remove friend</button>' : st?.friend === 2 ? '<button class="btn sm primary" data-friend>Accept request</button>'
      : st?.friend === 3 ? '<button class="btn sm ghost" disabled>Request sent</button>' : '<button class="btn sm" data-friend>Add friend</button>'}</div>`;
}
function wireHeader(el, n) {
  el.querySelectorAll('[data-pane]').forEach((b) => b.addEventListener('click', () => { view.pane = b.dataset.pane; drawMain(); }));
  el.querySelector('[data-offer]')?.addEventListener('click', () => offerModal(n.id));
  el.querySelector('[data-friend]')?.addEventListener('click', async () => { await act('npc.friend', { npc: n.id, on: true }); toast(stateOf(n.id)?.friend === 1 ? `You and ${esc(n.name)} are now friends` : `Friend request sent to ${esc(n.name)}`, 'good'); });
  el.querySelector('[data-unfriend]')?.addEventListener('click', async () => { if (await confirmDialog(`Remove ${esc(n.name)} from your friends?`, { ok: 'Remove', danger: true })) act('npc.friend', { npc: n.id, on: false }); });
}

// ---- chat --------------------------------------------------------------------------------------------------------------------
function drawChat(el, id) {
  const n = npc(id), msgs = so().threads[id] || [];
  const lastFor = new Map();
  msgs.forEach((m, i) => { if (m.offer) lastFor.set(m.offer, i); });
  el.innerHTML = `${headerHtml(n)}
    <div class="msgs" data-msgs>${msgs.length ? msgs.map((m, i) => `<div class="msg ${m.from}">
      ${m.from === 'npc' ? avatarHtml(id, 28) : ''}<div class="bub"><div class="txt">${esc(m.text)}</div><div class="when">${timeAgo(m.at)}</div>
      ${m.offer && lastFor.get(m.offer) === i ? offerHtml(m.offer) : ''}</div></div>`).join('') : `<div class="empty" style="padding:40px">Say hi to ${esc(n.name)}.</div>`}</div>
    <form class="composer" data-form><input class="input" data-text maxlength="300" placeholder="Message ${esc(n.name)}… (you can haggle here: “would you do $500? it’s a low float”)" autocomplete="off"><button class="btn primary">Send</button></form>`;
  wireHeader(el, n);
  const box = el.querySelector('[data-msgs]');
  box.scrollTop = box.scrollHeight;
  wireOffers(el);
  const form = el.querySelector('[data-form]'), input = el.querySelector('[data-text]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    await typing(() => act('npc.say', { npc: id, text }));
  });
  if (so().unread[id]) act('npc.read', { npc: id }).catch(() => {});
  input.focus();
}
// Their reply after a moment of "typing…".
async function typing(fn) {
  const box = root?.querySelector('[data-msgs]');
  if (box) { box.insertAdjacentHTML('beforeend', '<div class="msg npc typing"><div class="bub"><div class="txt">typing…</div></div></div>'); box.scrollTop = box.scrollHeight; }
  await new Promise((r) => setTimeout(r, 500 + Math.random() * 900));
  try { return await fn(); } catch (e) { sfx.error(); toast(esc(e.message), 'bad'); drawMain(); return null; }
}

const itemsHtml = (items) => items.map((it) => `<div class="oi" style="--rc:${I.rarityInfo(it).c}" data-item="${esc(it.uid)}" title="${esc(I.itemName(it))}"><img src="${I.itemImage(it, 's')}"><div>${esc(I.nameParts(it).bottom)}</div>${I.nameTagHtml(it)}<div class="v">${money(I.itemValue(it))}</div></div>`).join('');
function offerItems(o) {
  const s = stateOf(o.npc);
  return { mine: o.want.uids.map((u) => S.inv.find((it) => it.uid === u)).filter(Boolean), theirs: o.give.uids.map((u) => s?.inv.find((it) => it.uid === u)).filter(Boolean) };
}
function offerHtml(id) {
  const o = so().offers.find((x) => x.id === id);
  if (!o) return '';
  const { mine, theirs } = offerItems(o);
  const netCash = (o.give.money || 0) - (o.want.money || 0);
  const value = mine.reduce((t, it) => t + I.itemValue(it), 0) + (o.want.money || 0), getVal = theirs.reduce((t, it) => t + I.itemValue(it), 0) + (o.give.money || 0);
  const status = o.status === 'open' ? (o.agreed ? '<span class="chip green">Agreed</span>' : '<span class="chip gold">Open</span>') : `<span class="chip ${o.status === 'accepted' ? 'green' : 'red'}">${esc(o.status)}</span>`;
  const haggling = view.haggle === o.id && o.status === 'open';
  return `<div class="npc-offer" data-offer-id="${o.id}">
    <div class="no-head">${o.kind === 'buy' ? 'Cash offer' : 'Trade offer'} ${status} <span class="muted">${o.status === 'open' ? 'expires ' + timeLeft(o.exp) : ''}</span></div>
    <div class="offer-sides">
      <div class="offer-side"><h4>You give · <span class="green">${money(value)}</span></h4>${o.want.money ? `<div class="green">${money(o.want.money)} cash</div>` : ''}<div class="offer-items">${itemsHtml(mine) || '<span class="muted">Nothing</span>'}</div></div>
      <div class="offer-side"><h4>You get · <span class="green">${money(getVal)}</span></h4>${o.give.money ? `<div class="green big-cash">${money(o.give.money)} cash</div>` : ''}<div class="offer-items">${itemsHtml(theirs)}</div></div>
    </div>
    ${o.status === 'open' ? `<div class="open-row"><button class="btn primary" data-acc-offer="${o.id}">Accept${netCash ? ` (${netCash > 0 ? '+' : '−'}${money(Math.abs(netCash))})` : ''}</button>
      <button class="btn" data-haggle="${o.id}">Haggle</button><button class="btn ghost" data-dec-offer="${o.id}">Decline</button></div>
      ${haggling ? `<div class="haggle"><label class="check">Your price ${netCash < 0 ? '(what you pay)' : '(what they pay)'} $ <input class="input" type="number" step="0.01" data-price value="${Math.abs(N.nice(Math.max(netCash, 0) * 1.15 || value * 1.1)).toFixed(2)}" style="width:120px"></label>
        <div class="args">${Object.entries(N.ARGUMENTS).map(([k, a]) => `<label class="arg"><input type="radio" name="arg-${o.id}" value="${k}"> ${esc(a.n)}</label>`).join('')}<label class="arg"><input type="radio" name="arg-${o.id}" value="" checked> No argument</label></div>
        <button class="btn gold" data-send-counter="${o.id}">Send counter</button></div>` : ''}` : ''}</div>`;
}
function timeLeft(t) { const m = Math.max(0, Math.round((t - Date.now()) / 60000)); return m >= 60 ? `in ${Math.round(m / 60)}h` : `in ${m}m`; }
function wireOffers(el) {
  el.querySelectorAll('[data-item]').forEach((x) => x.addEventListener('click', () => {
    const it = S.inv.find((i) => i.uid === x.dataset.item) || Object.values(so().npcs).flatMap((s) => s.inv).find((i) => i.uid === x.dataset.item);
    if (it) S.inv.includes(it) ? showItemDetail(it) : canInspect(it) && openInspect(it);
  }));
  el.querySelectorAll('[data-acc-offer]').forEach((b) => b.addEventListener('click', async () => {
    const o = so().offers.find((x) => x.id === b.dataset.accOffer);
    const { mine } = offerItems(o);
    if (!(await confirmDialog(`Trade with <b>${esc(npc(o.npc).name)}</b>? You give ${mine.map((it) => `<b>${esc(I.itemName(it))}</b>`).join(', ') || 'nothing'}${o.want.money ? ` and ${money(o.want.money)}` : ''}. It can't be undone.`, { ok: 'Accept trade' }))) return;
    try { const r = await act('npc.accept', { offer: o.id }); sfx.coin(); toast(`Trade complete${r.money > 0 ? `: +${money(r.money)}` : ''}${r.got.length ? ` · got ${r.got.map((it) => esc(I.itemName(it))).join(', ')}` : ''}`, 'good'); } catch (e) { sfx.error(); toast(esc(e.message), 'bad'); }
  }));
  el.querySelectorAll('[data-dec-offer]').forEach((b) => b.addEventListener('click', () => act('npc.decline', { offer: b.dataset.decOffer }).catch((e) => toast(esc(e.message), 'bad'))));
  el.querySelectorAll('[data-haggle]').forEach((b) => b.addEventListener('click', () => { view.haggle = view.haggle === b.dataset.haggle ? null : b.dataset.haggle; drawMain(); }));
  el.querySelectorAll('[data-send-counter]').forEach((b) => b.addEventListener('click', async () => {
    const box = b.closest('.npc-offer'), o = so().offers.find((x) => x.id === b.dataset.sendCounter);
    const p = Math.abs(+box.querySelector('[data-price]').value || 0);
    const net = (o.give.money || 0) - (o.want.money || 0);
    const arg = box.querySelector('input[type=radio]:checked')?.value || null;
    view.haggle = null;
    const r = await typing(() => act('npc.counter', { offer: o.id, price: net < 0 ? -p : p, arg }));
    if (r?.outcome === 'agree') sfx.coin();
  }));
}

// ---- trade offers you make -----------------------------------------------------------------------------------------------------------
export function offerModal(id) {
  const n = npc(id), s = stateOf(id);
  if (!n) return;
  const mine = new Set(), theirs = new Set();
  let myMoney = 0, theirMoney = 0;
  const m = openModal({
    title: `Trade offer to ${esc(n.name)}`, cls: 'xwide',
    body: `<div class="offer-sides">
      <div class="offer-side"><h4>You give · <span class="green" data-give>$0.00</span></h4><label class="check" style="margin-bottom:8px">Money <input class="input" type="number" min="0" step="0.01" data-mym value="0" style="width:110px"></label><div data-mine></div></div>
      <div class="offer-side"><h4>You get · <span class="green" data-get>$0.00</span></h4><label class="check" style="margin-bottom:8px">Money <input class="input" type="number" min="0" step="0.01" data-thm value="0" style="width:110px"> <span class="muted">(they have ${money(s?.money || 0)})</span></label><div data-theirs></div></div>
    </div><input class="input" data-msg maxlength="200" placeholder="Message (optional)" style="width:100%;margin-top:10px">`,
    foot: `<span class="muted" style="font-size:12px">${n.type === 'collector' ? `${esc(n.name)} collects ${esc(N.FOCUS[n.focus].n.toLowerCase())} items: they pay more for those, and want a lot for theirs.`
      : n.type === 'beginner' ? `${esc(n.name)} is new to trading: they go by an item's plain price for its name and wear (floats, patterns, stickers and serials don't register) and misjudge some skins.`
      : `${esc(n.name)} trades at about market price.`}</span><span class="spacer"></span><button class="btn ghost" data-close>Cancel</button><button class="btn gold" data-send>Send offer</button>`,
  });
  const totals = () => {
    const sum = (list, set) => list.filter((it) => set.has(it.uid)).reduce((t, it) => t + I.itemValue(it), 0);
    m.el.querySelector('[data-give]').textContent = money(sum(S.inv, mine) + myMoney);
    m.el.querySelector('[data-get]').textContent = money(sum(s?.inv || [], theirs) + theirMoney);
  };
  mountPicker(m.el.querySelector('[data-mine]'), { items: () => S.inv.filter(I.tradable), selected: mine, onChange: totals, empty: 'No unlocked items' });
  mountPicker(m.el.querySelector('[data-theirs]'), { items: () => s?.inv || [], selected: theirs, onChange: totals, empty: 'Their inventory is empty' });
  m.el.querySelector('[data-mym]').addEventListener('input', (e) => { myMoney = Math.max(0, +e.target.value || 0); totals(); });
  m.el.querySelector('[data-thm]').addEventListener('input', (e) => { theirMoney = Math.max(0, +e.target.value || 0); totals(); });
  m.el.querySelector('[data-send]').addEventListener('click', async () => {
    const msg = m.el.querySelector('[data-msg]').value;
    m.close();
    view.who = id; view.pane = 'chat';
    if (root) drawAll(); else openChat(id);
    const r = await typing(() => act('npc.offer', { npc: id, give: { uids: [...mine], money: myMoney }, get: { uids: [...theirs], money: theirMoney }, msg }));
    if (!r) return;
    if (r.result === 'accepted') { sfx.coin(); toast(`${esc(n.name)} accepted your offer`, 'good'); }
    else if (r.result === 'countered') toast(`${esc(n.name)} wants ${money(r.more)} more: their counter is in the chat`, '');
    else toast(`${esc(n.name)} declined`, 'bad');
  });
}

// ---- profiles --------------------------------------------------------------------------------------------------------------------
function profileData(id) {
  if (id === 'me') {
    const me = so().me;
    const items = me.showcase.map((u) => S.inv.find((it) => it.uid === u)).filter(Boolean);
    const top = S.inv.filter((it) => !I.isUnit(it)).sort((a, b) => I.itemValue(b) - I.itemValue(a));
    return {
      name: myName(), country: me.country, bio: me.bio || 'No information given.', level: S.prof.level, medal: medalOf(S.prof), medals: S.prof.medals,
      showcase: items.length ? items : top.slice(0, 6), picked: items.length > 0, inv: ownedItems(S), money: S.money, joined: new Date(S.created || Date.now()).getFullYear(),
      friends: people().filter((n) => stateOf(n.id)?.friend === 1).length, comments: so().comments, status: { s: 'online', label: 'Online' }, bg: me.bg,
      badges: badgeList(S), featured: myFace().badge,
    };
  }
  const n = npc(id), s = stateOf(id);
  const top = [...s.inv].sort((a, b) => (n.type === 'collector' ? N.FOCUS[n.focus].fit(b) - N.FOCUS[n.focus].fit(a) : 0) || I.itemValue(b) - I.itemValue(a));
  return {
    name: n.name, country: n.country, bio: n.bio, level: n.level, medal: n.medals ? MEDALS[Math.min(n.medals, MEDALS.length) - 1] : null, medals: n.medals,
    showcase: top.slice(0, 6), inv: s.inv, money: s.money, joined: n.joined, friends: 12 + (n.level * 7) % 90, comments: [], status: N.presence(n), trades: s.trades || 0, kind: kindLabel(n),
    bg: null, mapSeed: n.id, badges: badgeList({ inv: s.inv }), featured: npcFace(so(), n).badge,
  };
}
// The top of a profile: who they are, their level and medal. (avatar: its HTML; mine: yours, with Edit profile.)
export const profileHeadHtml = (p, avatar, mine) => `<div class="sp-head">${avatar}
      <div class="sp-who"><h2>${esc(p.name)}</h2><div class="muted">${cc(p.country)}${p.kind ? esc(p.kind) + ' · ' : ''}Member since ${p.joined}</div><p class="sp-bio">${esc(p.bio)}</p></div>
      <div class="sp-level"><div class="lvl-big">${levelIconHtml(p.level, 46)}<span>Level <b>${p.level}</b></span></div>${p.medal ? `<div class="sp-medal">${medalHtml(p.medal, 54)}<span>${esc(p.medal.y)} Service Medal<br><small>${p.medals} medal${p.medals === 1 ? '' : 's'}</small></span></div>` : ''}
        ${mine ? '<button class="btn sm" data-edit>Edit profile</button>' : ''}</div></div>`;
function drawProfile(el, id) {
  const p = profileData(id), mine = id === 'me';
  const value = p.inv.reduce((t, it) => t + I.itemValue(it), 0);
  const showInv = !mine && view.tab === 'inventory';
  el.innerHTML = `${mine ? '' : headerHtml(npc(id))}<div class="sp" data-sp>
    ${profileHeadHtml(p, avatarHtml(id, 120), mine)}
    <div class="sp-body">
      <div class="sp-left">
        ${mine ? '' : `<div class="seg" data-tabs><button data-v="showcase" class="${showInv ? '' : 'active'}">Showcase</button><button data-v="inventory" class="${showInv ? 'active' : ''}">Inventory (${p.inv.length})</button></div>`}
        ${showInv ? `<div class="grid">${[...p.inv].sort((a, b) => I.itemValue(b) - I.itemValue(a)).map((it) => itemCard(it)).join('') || '<div class="empty">Empty</div>'}</div>
          <p class="muted" style="font-size:12px">Click an item to inspect it. Want something? <a href="#" data-offer2>Make an offer</a>.</p>`
        : `<div class="sp-box"><div class="sp-bh">Item showcase${mine && !p.picked ? ' <span class="muted">(your most valuable: pick your own in Edit profile)</span>' : ''}</div>
          <div class="grid showcase">${p.showcase.map((it) => itemCard(it)).join('') || '<div class="empty">Nothing to show yet</div>'}</div></div>
          ${badgesBoxHtml(p.badges, p.featured, { mine })}
          <div class="sp-box"><div class="sp-bh">Comments</div>${p.comments.length ? p.comments.map((c) => `<div class="cm-row">${avatarHtml(c.npc, 30)}<div><b>${esc(npc(c.npc)?.name || '?')}</b> <span class="muted">${timeAgo(c.at)}</span><div>${esc(c.text)}</div></div></div>`).join('')
            : `<div class="muted">${mine ? 'Trade with people and some will leave you +rep.' : 'No comments.'}</div>`}</div>`}
      </div>
      <div class="sp-right">
        <div class="sp-status st-${p.status.s}">${p.status.s === 'ingame' ? 'Currently In-Game' : p.status.s === 'offline' ? 'Currently Offline' : 'Currently Online'}<small>${esc(p.status.label)}</small></div>
        <div class="sp-stat"><span>Inventory value</span><b>${money(value)}</b></div>
        <div class="sp-stat"><span>Items</span><b>${p.inv.length}</b></div>
        <div class="sp-stat"><span>Friends</span><b>${p.friends}</b></div>
        ${mine ? `<div class="sp-stat"><span>Passive income</span><b class="green">${passiveText(S.prof.medals)}</b></div><div class="sp-stat"><span>Trades with players</span><b>${S.stats.npcTrades || 0}</b></div><div class="sp-stat"><span>Matches won</span><b>${S.stats.playWins || 0}</b></div>`
          : `<div class="sp-stat"><span>Trades with you</span><b>${p.trades}</b></div><button class="btn primary" data-msg>Message</button><button class="btn gold" data-offer3>Make offer</button>`}
      </div>
    </div></div>`;
  if (!mine) wireHeader(el, npc(id));
  el.querySelectorAll('[data-tabs] button').forEach((b) => b.addEventListener('click', () => { view.tab = b.dataset.v; drawMain(); }));
  el.querySelector('[data-edit]')?.addEventListener('click', editProfile);
  el.querySelector('[data-msg]')?.addEventListener('click', () => { view.pane = 'chat'; drawMain(); });
  for (const sel of ['[data-offer2]', '[data-offer3]']) el.querySelector(sel)?.addEventListener('click', (e) => { e.preventDefault(); offerModal(id); });
  el.querySelectorAll('.sp .card[data-uid]').forEach((c) => c.addEventListener('click', () => {
    const it = p.inv.find((x) => x.uid === c.dataset.uid);
    if (it) mine ? showItemDetail(it) : canInspect(it) && openInspect(it);
  }));
  wireBadges(el);
  backdrop(el.querySelector('[data-sp]'), p);
}
// A profile's badges (faces.js badgesBoxHtml): each one to look at closely.
export function wireBadges(el) {
  el.querySelectorAll('.sp [data-badge]').forEach((b) => b.addEventListener('click', () => { const it = badgeItem(b.dataset.badge); if (it) openInspect({ ...it, uid: 'badge:' + it.id }, { preview: true }); }));
}
// A CS2 map's main-menu picture behind the profile (from the install), like a Steam profile background.
export async function backdrop(el, p) {
  const maps = await backgroundMaps().catch(() => []);
  if (!maps.length || !el?.isConnected) return;
  const id = p.bg && maps.some((m) => m.id === p.bg) ? p.bg : p.mapSeed ? maps[[...p.mapSeed].reduce((a, c) => a + c.charCodeAt(0), 0) % maps.length].id : null;
  if (!id) return;
  const url = await cs2Play('menuBackdrop', id).catch(() => null);
  if (url && el.isConnected) el.style.setProperty('--sp-bg', `url("${new URL(url, location.href).href}")`);
}

const COUNTRY_LIST = ['', 'US', 'CA', 'GB', 'DE', 'FR', 'SE', 'DK', 'NO', 'FI', 'PL', 'CZ', 'UA', 'RU', 'BR', 'AR', 'AU', 'NL', 'ES', 'PT', 'IT', 'TR', 'KZ', 'RO', 'HU', 'IL', 'IN', 'JP', 'KR', 'CN', 'MX', 'ZA'];
// (a new picture goes in the save as the data: URL faces.js made: engine/picture.js)
const editProfile = () => profileDialog({
  me: { ...so().me, badge: myFace().badge }, badges: badgeList(S),
  save: (f) => act('persona.set', { ...f, pic: f.pic === undefined ? undefined : f.pic?.dataUrl ?? null }),
});
// The Edit profile window. me: { name, bio, country, avatar, bg, showcase: uids, pic, badge }. named: with the Name box (an
// online name is the account's). extra: more fields for the top row. faces: with the picture and the featured badge (a
// server without them: not), badges what can be featured ([{ id, n }]: faces.js badgeList). save(fields, window's element)
// runs on Save, a throw is a toast; with faces, fields.pic is undefined (unchanged), null (taken off) or the new picture
// (faces.js makePicture's { bytes, dataUrl, base64 }), and fields.badge the badge's id or null.
export async function profileDialog({ me, named = true, extra = '', save, faces = true, badges = [] }) {
  const show = new Set(me.showcase);
  let avatar = me.avatar, badge = me.badge || null, pic, busy = false; // (pic: undefined, unchanged; null, off; or the new one)
  const shownPic = () => (pic === undefined ? me.pic || null : pic?.dataUrl || null);
  const maps = await backgroundMaps().catch(() => []);
  const agents = Object.values(D.agents).sort((a, b) => b.r - a.r || a.n.localeCompare(b.n));
  const badgeBtn = (b) => { const it = badgeItem(b.id); return it ? `<button class="ep-badge ${b.id === badge ? 'on' : ''}" data-bd="${esc(b.id)}" title="${esc(I.itemName(it))}"><img loading="lazy" src="${I.itemImage(it, 's')}" alt=""></button>` : ''; };
  const m = openModal({
    title: 'Edit profile', cls: 'xwide',
    body: `<div class="edit-prof">
      <div class="ep-row">${named ? `<label>Name<input class="input" data-name maxlength="32" value="${esc(me.name)}" placeholder="Your name"></label>` : ''}
        <label>Country<select class="input" data-country>${COUNTRY_LIST.map((c) => `<option value="${c}" ${c === me.country ? 'selected' : ''}>${c || 'None'}</option>`).join('')}</select></label>
        ${maps.length ? `<label>Background<select class="input" data-bg><option value="">None</option>${maps.map((x) => `<option value="${esc(x.id)}" ${x.id === me.bg ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>` : ''}${extra}</div>
      <label>Summary<textarea class="input" data-bio maxlength="300" rows="3" placeholder="A few words about you">${esc(me.bio)}</textarea></label>
      ${faces ? `<div class="section-title">Profile picture</div>
      <div class="ep-face"><span data-preview></span><div class="ep-facebtns"><button class="btn sm" data-upload>Upload a picture…</button><button class="btn sm ghost" data-unpic>Remove picture</button></div>
        <input type="file" data-file accept="image/png,image/jpeg,image/webp,image/gif" hidden>
        <div class="muted">A PNG, JPEG, WebP or GIF (its first frame) of your own: its middle square, made ${PIC_SIZE} × ${PIC_SIZE}. Or pick an agent below.</div></div>` : '<div class="section-title">Avatar</div>'}
      <div class="ep-avatars">${agents.map((a) => `<button class="ep-av" data-av="${a.id}" title="${esc(a.n)}"><img loading="lazy" src="${imgUrl(a.img, 's')}"></button>`).join('')}</div>
      ${faces ? `<div class="section-title">Featured badge <span class="muted" style="font-size:12px;text-transform:none;letter-spacing:0">on your profile, and in the corner of your picture</span></div>
      ${badges.length ? `<div class="ep-badges"><button class="ep-badge none" data-bd="">None</button>${badges.map(badgeBtn).join('')}</div>`
        : '<div class="muted" style="font-size:12px">No badges yet: open a Collectible Pins Capsule (Cases, Pin Capsules) for a pin.</div>'}` : ''}
      <div class="section-title">Item showcase <span class="muted" style="font-size:12px;text-transform:none;letter-spacing:0">up to 6</span></div><div data-show></div></div>`,
    foot: '<button class="btn ghost" data-close>Cancel</button><button class="btn gold" data-save>Save</button>',
  });
  // What the picture and badge parts show: the face as it will be, the agent (only without a picture) and the badge picked.
  const drawFace = () => {
    const prev = m.el.querySelector('[data-preview]');
    if (prev) prev.innerHTML = faceHtml({ name: me.name || 'You', avatar, pic: shownPic(), badge }, 92);
    const unpic = m.el.querySelector('[data-unpic]');
    if (unpic) unpic.hidden = !shownPic();
    m.el.querySelectorAll('[data-av]').forEach((x) => x.classList.toggle('on', !shownPic() && x.dataset.av === avatar));
    m.el.querySelectorAll('[data-bd]').forEach((x) => x.classList.toggle('on', (x.dataset.bd || null) === badge));
  };
  // (an agent picked while there's a picture: the agent is what you want shown, so the picture comes off)
  m.el.querySelectorAll('[data-av]').forEach((b) => b.addEventListener('click', () => {
    if (shownPic()) { pic = null; avatar = b.dataset.av; } else avatar = avatar === b.dataset.av ? null : b.dataset.av;
    drawFace();
  }));
  m.el.querySelectorAll('[data-bd]').forEach((b) => b.addEventListener('click', () => { badge = b.dataset.bd || null; drawFace(); }));
  const file = m.el.querySelector('[data-file]');
  m.el.querySelector('[data-upload]')?.addEventListener('click', () => file.click());
  m.el.querySelector('[data-unpic]')?.addEventListener('click', () => { pic = null; drawFace(); });
  file?.addEventListener('change', async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    busy = true;
    try { pic = await makePicture(f); drawFace(); } catch (e) { toast(esc(e.message), 'bad'); } finally { busy = false; }
  });
  drawFace();
  mountPicker(m.el.querySelector('[data-show]'), { items: () => S.inv.filter((it) => !I.isUnit(it)), selected: show, onChange: (sel) => { while (sel.size > 6) sel.delete([...sel][0]); }, empty: 'Your inventory is empty' });
  const saveBtn = m.el.querySelector('[data-save]');
  saveBtn.addEventListener('click', async () => {
    if (busy) return;
    saveBtn.disabled = true;
    try {
      await save({ ...(named ? { name: m.el.querySelector('[data-name]').value } : {}), bio: m.el.querySelector('[data-bio]').value, country: m.el.querySelector('[data-country]').value,
        avatar, showcase: [...show].slice(0, 6), bg: m.el.querySelector('[data-bg]')?.value || null, ...(faces ? { pic, badge } : {}) }, m.el);
      m.close();
      toast('Profile saved', 'good');
    } catch (e) { toast(esc(e.message), 'bad'); saveBtn.disabled = false; }
  });
  return m;
}
