// Players' faces: the picture a player is shown with (a picture of their own, or the agent they picked, or their initials)
// with the badge they feature (engine/badges.js) small in its bottom left corner. Every page that shows a player draws it
// here, with avatarHtml, so it's the same everywhere: the friends list, chats and profiles (offline's NPCs too), who's online
// on the Trade page and its offers, the Market's sellers, gambling's seats and pots.
//
// A face is { name, avatar (an agent's id), pic, badge (a badge's id) }: a Person as the server sends it (server/social.mjs,
// face1), or one made here for the offline save (myFace) and its NPCs (npcFace). pic is a data: URL offline (the save keeps
// the picture) and a hash online, the picture fetched from the server once (GET /pic/<hash>, which never changes for a hash)
// and drawn from memory after that. Online, a player the page knows only by name or id (playerFace) is asked about in one
// request with the others drawn at that moment (social 'faces'), and their faces are put in place when it answers, without
// the page drawing anything again; the same when the server says a player's face changed (faces.d).
//
// makePicture turns the picture a player picks (a PNG, JPEG, WebP or GIF's first frame) into one to keep: the middle square,
// 184 x 184, as WebP (PNG if that won't do) of 64 KB at most, which engine/picture.js checks as the server does.
import { esc, imgUrl } from './util.js';
import { D } from './data.js';
import * as I from './items.js';
import { S } from './state.js';
import { online } from './backend.js';
import { net } from './net/online.js';
import * as N from './engine/npcs.js';
import { badgeDef, badgeItem, badgesOf, featuredBadge } from './engine/badges.js';
import { PIC_MAX, PIC_SIZE, bytesToDataUrl, pictureProblem } from './engine/picture.js';
import { storedOf } from './engine/storage.js';

const HASH = /^[0-9a-f]{64}$/;
const initials = (name) => String(name ?? '?').replace(/^bot /i, '').slice(0, 2).toUpperCase() || '?';

// ---- pictures -----------------------------------------------------------------------------------------------------------
// hash -> { url } (url: '' while it's on its way, null if it couldn't be had): an <img> of one still on its way is drawn without a
// src and given it when it comes. A data: URL becomes a blob: URL once, so a page drawn again doesn't carry it as text.
const pics = new Map();
const dataUrls = new Map(); // data: URL -> blob: URL (the latest few)
function dataBlob(url) {
  let out = dataUrls.get(url);
  if (out) return out;
  try {
    const m = /^data:([^;]+);base64,(.*)$/.exec(url), bin = atob(m[2]), b = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    out = URL.createObjectURL(new Blob([b], { type: m[1] }));
  } catch { return url; }
  dataUrls.set(url, out);
  if (dataUrls.size > 8) { const [old, blob] = dataUrls.entries().next().value; dataUrls.delete(old); URL.revokeObjectURL(blob); }
  return out;
}
// The src to draw a pic with: a URL, '' (it's coming), or null (none to draw).
function picSrc(pic) {
  if (typeof pic !== 'string' || !pic) return null;
  if (pic.startsWith('data:image/')) return dataBlob(pic);
  if (!HASH.test(pic) || !online()) return null;
  let e = pics.get(pic);
  if (!e) { pics.set(pic, (e = { url: '' })); fetchPic(pic, e); }
  return e.url;
}
async function fetchPic(hash, e) {
  try {
    const r = await fetch(net.picUrl(hash));
    const blob = r.ok ? await r.blob() : null;
    if (!blob || !/^image\/(png|webp)$/.test(blob.type) || blob.size > PIC_MAX) throw new Error('no picture');
    e.url = URL.createObjectURL(blob);
  } catch { e.url = null; }
  const fill = () => {
    for (const img of document.querySelectorAll(`img[data-pic="${hash}"]`)) {
      if (e.url) img.src = e.url;
      else img.replaceWith(Object.assign(document.createElement('b'), { textContent: img.dataset.ini || '?' }));
    }
  };
  fill();
  requestAnimationFrame(fill); // (one drawn from a page's text made just before it came)
}

// ---- drawing a face -----------------------------------------------------------------------------------------------------
// A face at `size` pixels, with the status ring Friends & Chat uses ('online', 'ingame', 'away', 'offline' or none). key: what
// playerFace knows it by, so its answer can put the face in place.
export function avatarHtml(f, size = 32, status = '', { key = '' } = {}) {
  const name = String(f?.name ?? '?'), src = picSrc(f?.pic);
  const agent = f?.avatar && Object.hasOwn(D.agents, f.avatar) ? D.agents[f.avatar] : null;
  const face = src != null ? `<img class="pic" alt="" data-ini="${esc(initials(name))}"${HASH.test(f.pic) ? ` data-pic="${f.pic}"` : ''}${src ? ` src="${src}"` : ''}>`
    : agent ? `<img src="${imgUrl(agent.img, 's')}" alt="">` : `<b>${esc(initials(name))}</b>`;
  const b = badgeDef(f?.badge), corner = b ? `<img class="av-badge" src="${I.itemImage(badgeItem(b.id), 's')}" alt="" title="${esc(I.itemName(badgeItem(b.id)))}">` : '';
  const keyed = key ? ` data-face="${esc(key)}" data-fs="${size}" data-fst="${esc(status)}"` : '';
  return `<span class="av ${esc(status)}" style="--s:${size}px"${keyed}>${face}${corner}</span>`;
}

// ---- offline: your save and its NPCs ------------------------------------------------------------------------------------
// Your own face offline, as Edit profile set it (a badge only while you still have one).
export function myFace() {
  const me = S.social?.me || {};
  return { name: me.name || 'You', avatar: me.avatar || null, pic: me.pic || null, badge: featuredBadge(S, me.badge) };
}
// An NPC's featured badge: the rarest pin they have (pins being the only badges a player can own), from what they own now.
const npcBadges = new WeakMap(); // their inventory -> { n: its length then, badge }
export function npcBadge(so, n) {
  if (!so || !n) return null;
  const inv = N.inventoryOf(so, n);
  let c = npcBadges.get(inv);
  if (!c || c.n !== inv.length) npcBadges.set(inv, (c = { n: inv.length, badge: badgesOf({ inv })[0]?.id ?? null }));
  return c.badge;
}
export function npcFace(so, n) {
  return n ? { name: n.name, avatar: n.avatar || null, badge: npcBadge(so, n) } : { name: '?' };
}

// ---- online: players known by name or id ----------------------------------------------------------------------------------
// 'i<id>' and 'n<name in lower case>' -> { p: Person, at }. A Person seen anywhere (Friends & Chat's lists, a chat) is kept.
const known = new Map();
const AGAIN = 5 * 60 * 1000; // (a face older than this is asked about again, the old one drawn until the answer)
const keyOf = ({ id, name }) => (id != null && Number.isInteger(+id) ? 'i' + +id : 'n' + String(name ?? '').toLowerCase());
export function rememberFace(p) {
  if (!p || p.id == null || !('pic' in p || 'badge' in p)) return; // (a Person from a server without faces says nothing of them)
  const e = { p: { id: p.id, name: p.name, avatar: p.avatar ?? null, pic: p.pic ?? null, badge: p.badge ?? null }, at: Date.now() };
  known.set('i' + p.id, e);
  known.set('n' + String(p.name).toLowerCase(), e);
}
export function forgetFaces() { known.clear(); wanted.clear(); asked.clear(); }

const wanted = new Set(), asked = new Map(); // keys to ask about, and when each was last asked
let askTimer = null;
function want(key) {
  if (!net.hasFaces() || Date.now() - (asked.get(key) || 0) < AGAIN) return;
  wanted.add(key);
  askTimer ??= setTimeout(askFaces, 30);
}
async function askFaces() {
  askTimer = null;
  const keys = [...wanted].slice(0, 100);
  keys.forEach((k) => { wanted.delete(k); asked.set(k, Date.now()); });
  if (wanted.size) askTimer = setTimeout(askFaces, 30);
  const ids = keys.filter((k) => k[0] === 'i').map((k) => +k.slice(1)), names = keys.filter((k) => k[0] === 'n' && k.length > 1).map((k) => k.slice(1));
  let list;
  try { list = await net.social('faces', { ...(ids.length ? { ids } : {}), ...(names.length ? { names } : {}) }); } catch { return; }
  if (!Array.isArray(list)) return;
  list.forEach(rememberFace);
  for (const k of keys) {
    const p = known.get(k)?.p;
    if (!p) continue;
    for (const el of document.querySelectorAll(`[data-face="${CSS.escape(k)}"]`)) {
      el.outerHTML = avatarHtml(p, +el.dataset.fs || 32, el.dataset.fst || '', { key: k });
    }
  }
}
// A player's face online by what the page knows of them ({ id?, name, avatar? }): what's known, and asked about if it isn't (or
// is old). Offline: the NPC by that id, or your own.
export function playerFace(who = {}) {
  if (!online()) {
    const so = S.social;
    if (who.me || who.id === 'me') return myFace();
    const n = so && who.npc != null ? N.npcOf(so.seed, String(who.npc)) : null;
    return n ? npcFace(so, n) : { name: who.name ?? '?' };
  }
  const key = keyOf(who), e = known.get(key);
  if (!e || Date.now() - e.at > AGAIN) want(key);
  return e ? e.p : { name: who.name ?? '?', avatar: who.avatar ?? null };
}
// avatarHtml for a player known by name or id (playerFace's), put in place when the answer comes.
export const playerAvatar = (who, size = 32, status = '') => avatarHtml(playerFace(who), size, status, online() ? { key: keyOf(who) } : {});
net.on('status', ({ status }) => { if (status === 'offline') forgetFaces(); });
// (face1) Players whose faces changed, their picture or featured badge (server/social.mjs facesChanged, { t: 'faces.d' }):
// what's known of them is asked about again, the old face drawn until the answer, and every face of theirs on the page that
// was drawn with a key (data-face) is put right when it comes.
net.on('faces', ({ ids }) => {
  const gone = new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger));
  if (!gone.size) return;
  const keys = new Set([...gone].map((id) => 'i' + id));
  for (const [k, e] of known) if (gone.has(+e.p.id)) { keys.add(k); e.at = 0; }
  for (const k of keys) asked.delete(k);
  for (const el of document.querySelectorAll('[data-face]')) if (keys.has(el.dataset.face)) want(el.dataset.face);
});

// ---- a profile's badges -----------------------------------------------------------------------------------------------------
// The box on a profile with every badge they have ([{ id, n }], the rarest first), the featured one marked.
export function badgesBoxHtml(list, featured = null, { mine = false } = {}) {
  const shown = (Array.isArray(list) ? list : []).filter((b) => badgeDef(b?.id));
  const cell = (b) => {
    const it = badgeItem(b.id), on = b.id === featured;
    return `<div class="sp-badge ${on ? 'on' : ''}" data-badge="${esc(b.id)}" style="--rc:${I.rarityInfo(it).c}" title="${esc(I.itemName(it))}${b.n > 1 ? ` (${b.n})` : ''}${on ? ' · featured' : ''}">
      <img src="${I.itemImage(it, 's')}" alt="">${b.n > 1 ? `<span>×${b.n}</span>` : ''}</div>`;
  };
  return `<div class="sp-box"><div class="sp-bh">Badges${shown.length ? ` <span class="muted">${shown.length}</span>` : ''}</div>
    ${shown.length ? `<div class="sp-badges">${shown.map(cell).join('')}</div>`
    : `<div class="muted">${mine ? 'No badges yet: open a Collectible Pins Capsule (Cases, Pin Capsules) for a pin, or prestige (past level 40) for a Service Medal.' : 'No badges yet.'}</div>`}</div>`;
}
// [{ id, n }] of what a save has (inventory and Storage Units), for badgesBoxHtml.
export const badgeList = (st) => badgesOf(st).map((b) => ({ id: b.id, n: b.n }));
// The badge you feature, as far as this game knows: offline your save's, online your Person as the server last sent it.
function myBadge() {
  if (!online()) return S.social?.me?.badge || null;
  const me = net.me();
  return (me && known.get('i' + me.id)?.p.badge) || null;
}
// A word for the Market's selling window and gambling's stake: '' unless these items are the last of the badge you feature.
// A save without one unfeatures it (server/store.mjs online, state.js offline), and a listing or a stake takes it out of your
// inventory, so it stays unfeatured even if it comes back.
export function unfeatureWarning(uids) {
  const id = myBadge();
  if (!id) return '';
  const going = new Set(uids);
  const left = (S.inv || []).some((it) => it?.t === 'badge' && it.id === id && !going.has(it.uid)) || storedOf(S).some((it) => it?.t === 'badge' && it.id === id);
  return left ? '' : 'This is your featured badge: once it leaves your inventory it stops being featured, even if it comes back.';
}

// ---- making a picture -------------------------------------------------------------------------------------------------------
const PICKED_MAX = 20 * 1024 * 1024; // (the file a player picks: anything bigger is no profile picture)
// What a file's first bytes say it is: 'png', 'jpeg', 'gif', 'webp' or null.
function pickedType(b) {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
  if (String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP') return 'webp';
  return null;
}
const blobOf = (canvas, type, quality) => new Promise((res) => canvas.toBlob(res, type, quality));
// A file the player picked → { bytes, dataUrl, base64 } to keep, or a throw with what's wrong, in words for them.
export async function makePicture(file) {
  if (!file) throw new Error('Pick a picture');
  if (file.size > PICKED_MAX) throw new Error('That file is too big: pick a picture under 20 MB');
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const type = pickedType(head);
  if (!type) throw new Error('Pick a PNG, JPEG, WebP or GIF picture');
  let bmp;
  try { bmp = await createImageBitmap(new Blob([file], { type: `image/${type}` })); } catch { throw new Error("That picture couldn't be read"); }
  const side = Math.min(bmp.width, bmp.height);
  if (!side) throw new Error("That picture couldn't be read");
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = PIC_SIZE;
  const g = canvas.getContext('2d');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, PIC_SIZE, PIC_SIZE); // (the middle square)
  bmp.close?.();
  for (const [kind, q] of [['image/webp', 0.92], ['image/webp', 0.82], ['image/webp', 0.7], ['image/webp', 0.55], ['image/png']]) {
    const blob = await blobOf(canvas, kind, q);
    if (!blob || blob.type !== kind || blob.size > PIC_MAX) continue;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (pictureProblem(bytes)) continue;
    const dataUrl = bytesToDataUrl(bytes);
    return { bytes, dataUrl, base64: dataUrl.slice(dataUrl.indexOf(',') + 1) };
  }
  throw new Error("That picture couldn't be made small enough: try another one");
}
