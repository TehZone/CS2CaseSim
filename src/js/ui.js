// Shared UI: cards, modals, toasts, tooltips, context menus, item detail, 3D inspect overlay, selling.
import { esc, money, imgUrl, timeAgo } from './util.js';
import { D, WEARS, wearOf, WEAR_BY_KEY, rarityColor, keyFor } from './data.js';
import * as I from './items.js';
import { S, emit, save } from './state.js';
import { act } from './backend.js';
import { sfx } from './audio.js';
import { inspectView } from './inspect.js';
import { cs2VanityMaps, cs2Status } from './cs2/api.js';
import { placementFromHit, rehangCharm } from './cs2/charm.js';
import { composeItem, alphaBox } from './composite.js';
import { openStickerEditor } from './stickerEditor.js';
import { TIER_LABEL } from './patterns.js';
import { isEquipped, slotName } from './loadout.js';
import { floatRankOf } from './floatranks.js';
import { CATEGORY_NAME } from './engine/database.js';
import { UNIT_CAP, unitCount, unitValue, viewItems } from './engine/storage.js';
import { nameable } from './engine/tools.js';
import { iconHtml } from './menu.js';

// ---- toasts --------------------------------------------------------------------------------
export function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 3200);
  return el;
}

// Runs a game action and shows its error (not enough money, item locked...) as a toast. Returns null on failure.
export async function tryAct(name, args) {
  try {
    return await act(name, args);
  } catch (e) {
    sfx.error();
    if (e.code || e.remote) toast(esc(e.message), 'bad');
    else { console.error(e); toast('Something went wrong: ' + esc(e.message), 'bad'); }
    return null;
  }
}

// ---- tooltips (Panorama's) -------------------------------------------------------------------
// Anything with a title or data-tip shows its text in a styled box under it (above near the bottom of the window). A
// title moves to data-tip on hover so the browser's own tooltip stays away; code that sets the title again just updates it.
let tipEl = null, tipFor = null, tipTimer = 0;
export function installTooltips() {
  tipEl = document.createElement('div');
  tipEl.className = 'tooltip';
  tipEl.setAttribute('role', 'tooltip');
  document.body.appendChild(tipEl);
  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest?.('[title], [data-tip]');
    if (t === tipFor) return;
    hideTip();
    if (!t) return;
    if (t.hasAttribute('title')) {
      const v = t.getAttribute('title');
      t.removeAttribute('title');
      if (v) t.dataset.tip = v;
    }
    if (!t.dataset.tip) return;
    tipFor = t;
    tipTimer = setTimeout(() => showTip(t), t.closest('#topbar') ? 120 : 450);
  });
  document.addEventListener('mouseout', (e) => { if (tipFor && !tipFor.contains(e.relatedTarget)) hideTip(); });
  for (const ev of ['mousedown', 'wheel', 'keydown']) window.addEventListener(ev, hideTip, true);
}
function showTip(t) {
  if (!t.isConnected) return hideTip();
  tipEl.textContent = t.dataset.tip;
  tipEl.classList.add('show');
  const r = t.getBoundingClientRect(), w = tipEl.offsetWidth, h = tipEl.offsetHeight;
  let y = r.bottom + 8;
  const above = y + h > innerHeight - 6;
  if (above) y = r.top - h - 8;
  const x = Math.max(6, Math.min(innerWidth - w - 6, r.left + r.width / 2 - w / 2));
  tipEl.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  tipEl.classList.toggle('above', above);
}
function hideTip() {
  clearTimeout(tipTimer);
  tipFor = null;
  tipEl?.classList.remove('show');
}

// ---- context menus (Panorama's) ---------------------------------------------------------------
// items: { label, icon (a CS2 menu icon name), action, danger, disabled, hint }, with '-' between groups. Closes on a
// click outside, Esc, scrolling or resizing.
let ctxClose = null;
export function contextMenu(x, y, items) {
  ctxClose?.();
  const el = document.createElement('div');
  el.className = 'ctx-menu';
  el.innerHTML = items.map((it, i) => (it === '-' ? '<div class="sep"></div>'
    : `<button data-i="${i}" class="${it.danger ? 'danger' : ''}" ${it.disabled ? 'disabled' : ''}>${iconHtml(it.icon) || '<i class="ico"></i>'}<span>${esc(it.label)}</span>${it.hint ? `<small>${esc(it.hint)}</small>` : ''}</button>`)).join('');
  document.body.appendChild(el);
  const w = el.offsetWidth, h = el.offsetHeight;
  el.style.left = `${Math.max(4, Math.min(innerWidth - w - 4, x))}px`;
  el.style.top = `${Math.max(4, y + h > innerHeight - 4 ? y - h : y)}px`;
  const outside = (e) => { if (!el.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); } };
  const close = () => {
    el.remove();
    window.removeEventListener('mousedown', outside, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('wheel', close, true);
    window.removeEventListener('resize', close);
    ctxClose = null;
  };
  window.addEventListener('mousedown', outside, true);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('wheel', close, true);
  window.addEventListener('resize', close);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b || b.disabled) return;
    close();
    items[+b.dataset.i].action?.();
  });
  ctxClose = close;
}

// ---- modals --------------------------------------------------------------------------------
const modalStack = [];
export function openModal({ title = '', body = '', foot = '', cls = '', onClose } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal ${cls}">
    <div class="modal-head"><h2>${title}</h2><button class="x" data-close>&times;</button></div>
    <div class="modal-body">${body}</div>${foot ? `<div class="modal-foot">${foot}</div>` : ''}</div>`;
  document.getElementById('modal-root').appendChild(wrap);
  const api = {
    el: wrap.querySelector('.modal'),
    close() {
      if (!wrap.isConnected) return;
      wrap.remove();
      modalStack.splice(modalStack.indexOf(api), 1);
      onClose?.();
    },
  };
  modalStack.push(api);
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) api.close(); });
  wrap.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => api.close()));
  return api;
}
export const topModal = () => modalStack[modalStack.length - 1];

export function confirmDialog(text, { title = 'Confirm', ok = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const m = openModal({
      title, body: `<p style="margin:0;line-height:1.5">${text}</p>`,
      foot: `<button class="btn ghost" data-close>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${ok}</button>`,
      onClose: () => { if (!answered) resolve(false); },
    });
    m.el.querySelector('[data-ok]').addEventListener('click', () => { answered = true; m.close(); resolve(true); });
  });
}

// ---- cards ---------------------------------------------------------------------------------
export function patternTag(p) {
  if (!p.label) return '';
  return `<span class="tag pat ${p.tier}">${esc(p.label)}</span>`;
}

export function floatBar(item) {
  const d = I.itemDef(item);
  if (item.fl == null) return '';
  // Each wear's label sits under the middle of its own stretch of the bar.
  return `<div class="floatwrap"><div class="floatbar"><div class="range" style="left:${d.mn * 100}%;right:${(1 - d.mx) * 100}%"></div><i style="left:${item.fl * 100}%"></i></div>
    <div class="floatlabels">${WEARS.map((w) => `<span style="left:${((w.min + w.max) / 2) * 100}%" title="${w.n}">${w.k}</span>`).join('')}</div></div>`;
}

// A skin's float rank (see floatranks.js): #1-#3 lowest float (or highest) of its item's copies, gold, silver, bronze.
function floatRankText(r) {
  const of = `of ${r.of.toLocaleString()} ${CATEGORY_NAME[r.cat] || ''} copies`.replace('  ', ' ');
  return [r.low && `#${r.low} lowest float ${of}`, r.high && `#${r.high} highest float ${of}`].filter(Boolean).join(', ');
}
function floatRankTag(item) {
  const r = item.t === 'skin' && floatRankOf(item.uid);
  if (!r) return '';
  const [side, n] = r.low ? ['low', r.low] : ['high', r.high];
  return `<span class="tag frk ${side} r${n}" title="${esc(floatRankText(r))}">#${n} ${side === 'low' ? 'Low' : 'High'}</span>`;
}

// Charms: a Sticker Slab's picture is its sticker, drawn in a clear case (.slab); a gun's charm hangs in its card's corner.
const isSlab = (item) => item?.t === 'charm' && item.id === 'slab';
const slabAttr = (item) => (isSlab(item) ? `data-sk="${esc(item.sk)}"` : ''); // its cropped picture is swapped in when ready (items.js)
function charmBadge(c) {
  if (!c || !I.itemDef(c)) return '';
  return `<span class="kc-badge ${isSlab(c) ? 'slab' : ''}" title="${esc(I.itemName(c))} · Pattern #${c.pat}"><img src="${I.itemImage(c, 's')}" ${slabAttr(c)} alt=""></span>`;
}

// A Storage Unit's card: its label, how full it is, and when it last changed (click it to open it: pages/storage.js).
function unitCard(item, { extra = '' } = {}) {
  const r = I.rarityInfo(item), np = I.nameParts(item), n = unitCount(S, item.uid);
  return `<div class="card unit ${extra}" data-uid="${item.uid}" style="--rc:${r.c}">
    <div class="tags">${item.nw ? '<span class="tag new">New</span>' : ''}${item.name ? '' : '<span class="tag pat">Not in use</span>'}</div>
    <div class="img"><img loading="lazy" src="${I.itemImage(item, 'm')}" alt=""></div>
    <div class="rbar"></div>
    <div class="unit-fill"><i style="width:${(n / UNIT_CAP) * 100}%"></i></div>
    <div class="meta">
      <div class="n1">${esc(np.top)}</div>
      <div class="n2">${esc(np.bottom)}</div>
      <div class="row"><span class="wear">${n.toLocaleString('en-US')} / ${UNIT_CAP.toLocaleString('en-US')} items</span><span class="val">${money(unitValue(S, item.uid))}</span></div>
      <div class="row unit-mod"><span>${item.mod ? 'Modified ' + timeAgo(item.mod) : 'Not used yet'}</span></div>
    </div>
  </div>`;
}

export function itemCard(item, { selectable = false, selected = false, extra = '', line = '' } = {}) {
  if (I.isUnit(item)) return unitCard(item, { extra });
  const r = I.rarityInfo(item);
  const np = I.nameParts(item);
  const pat = I.patternInfo(item);
  // Skins show the wear abbreviation (coloured like its stretch of the wear bar) and the float, like CS2's inventory.
  const wk = item.t === 'skin' && item.fl != null ? wearOf(item.fl) : null;
  const wear = wk ? `<b class="wk" style="--wc:${WEAR_BY_KEY[wk].c}" title="${WEAR_BY_KEY[wk].n}">${wk}</b>${item.fl.toFixed(4)}`
    : esc(r.n);
  const stk = item.stk?.length ? `<div class="stickers">${item.stk.map((s) => `<img src="${imgUrl(D.stickers[s.id]?.img, 's')}">`).join('')}</div>` : '';
  const kc = item.kc ? charmBadge(I.attachedCharm(item)) : '';
  return `<div class="card ${selected ? 'selected' : ''} ${extra}" data-uid="${item.uid}" style="--rc:${r.c}">
    ${selectable ? '<div class="sel"></div>' : ''}
    <div class="tags">${item.nw ? '<span class="tag new">New</span>' : ''}${item.stt ? '<span class="tag st">ST™</span>' : ''}${item.sv ? '<span class="tag sv">Souvenir</span>' : ''}${patternTag(pat)}${item.lk ? '<span class="tag lock">🔒</span>' : ''}${isEquipped(item) ? '<span class="tag eq">Equipped</span>' : ''}${floatRankTag(item)}${item.sn ? `<span class="tag sn ${item.sn <= 100 || I.isSpecialSerial(item.sn) ? 'low' : ''}" title="Serial number: unboxed #${item.sn}">#${item.sn}</span>` : ''}</div>
    <div class="img ${isSlab(item) ? 'slab' : ''}"><img loading="lazy" src="${I.itemImage(item, 'm')}" ${slabAttr(item)} alt="">${stk}${kc}</div>
    <div class="rbar"></div>
    ${item.t === 'skin' && item.fl != null ? `<div class="floatline"><i style="left:${item.fl * 100}%"></i></div>` : ''}
    <div class="meta">
      <div class="n1 ${item.stt ? 'stt' : item.sv ? 'sv' : ''}">${esc(np.top)}</div>
      <div class="n2">${esc(np.bottom)}</div>
      ${I.nameTagHtml(item)}
      <div class="row"><span class="wear">${wear}</span><span class="val">${money(I.itemValue(item))}</span></div>
      ${line ? `<div class="row"><span class="wear">${line}</span></div>` : ''}
    </div>
  </div>`;
}

// ---- selling -------------------------------------------------------------------------------
export async function sellItems(items, { ask = true } = {}) {
  items = items.filter(I.tradable);
  if (!items.length) return false;
  const total = items.reduce((s, i) => s + I.itemValue(i), 0);
  if (ask && total >= S.settings.confirmSellAbove) {
    const what = items.length === 1 ? esc(I.itemName(items[0])) : `${items.length} items`;
    if (!(await confirmDialog(`Sell ${what} for <b class="green">${money(total)}</b>?`, { ok: 'Sell' }))) return false;
  }
  const name = items.length === 1 ? esc(I.itemName(items[0])) : items.length + ' items';
  const r = await tryAct('item.sell', { uids: items.map((i) => i.uid) });
  if (!r) return false;
  sfx.coin();
  toast(`Sold ${name} for <b class="green">${money(r.total)}</b>`, 'good');
  return true;
}

// ---- item actions --------------------------------------------------------------------------
// Cases, keys and tools in your inventory have no 3D model to inspect; a case opens instead (with one of your keys for it).
export const canInspect = (item) => item.t !== 'crate' && item.t !== 'key' && item.t !== 'unit' && item.t !== 'tool';
const storage = () => import('./pages/storage.js');
const tools = () => import('./pages/tools.js');
async function openCrateItem(item) {
  const { openCrate } = await import('./pages/cases.js');
  return openCrate(item);
}
function crateKeyHint(item) {
  const c = I.itemDef(item), key = keyFor(c);
  return key ? D.keys[key].n : 'No key needed';
}
// Buying a key for a case you own (cases.js buyCrateKey): whether it did.
async function buyCrateKey(item) {
  const { buyCrateKey: buy } = await import('./pages/cases.js');
  return buy(item);
}
const keysFor = (key) => S.inv.filter((it) => it.t === 'key' && it.id === key && !it.lk).length;
// A case's buttons in its details: Open (with one of your keys, or Buy key & open when you have none) and Buy key.
function crateButtons(item, d) {
  const key = keyFor(d);
  if (!key) return `<button class="btn gold" data-a="open" ${item.lk ? 'disabled' : ''}>Open</button>`;
  const k = D.keys[key], have = keysFor(key);
  return (have ? `<button class="btn gold" data-a="open" ${item.lk ? 'disabled' : ''}>Open (uses a ${esc(k.n)})</button>`
    : `<button class="btn gold" data-a="buyopen" ${item.lk ? 'disabled' : ''} title="Buys a ${esc(k.n)} and opens this case with it">Buy key &amp; open · ${money(D.keyPrice)}</button>`)
    + `<button class="btn" data-a="buykey" title="A ${esc(k.n)}, to your inventory (you have ${have})"><img src="${imgUrl(k.img, 's')}" alt="" style="height:18px;vertical-align:middle;margin:-3px 6px 0 0">Buy key · ${money(D.keyPrice)}</button>`;
}
async function equipItem(item) {
  if (!(await tryAct('loadout.equip', { uid: item.uid }))) return false;
  toast(`Equipped ${esc(I.itemName(item))}${I.loadoutSlot(item) === 'gloves' ? ' — you’ll see them in the first-person inspect' : ''}`, 'good');
  return true;
}

// The right-click menu on an item you own, like CS2's inventory: the same actions as its details. `onChange` runs after
// one that changes the item.
export function itemContextMenu(e, item, { onChange } = {}) {
  e.preventDefault();
  if (I.isUnit(item)) { storage().then((p) => p.unitContextMenu(e, item, { onChange })); return; }
  const done = (ok) => { if (ok) onChange?.(); };
  const slot = I.loadoutSlot(item);
  const items = [
    item.t === 'crate' ? { label: 'Open', icon: 'crate', hint: crateKeyHint(item), disabled: !!item.lk, action: () => openCrateItem(item) }
      : canInspect(item) ? { label: 'Inspect', icon: 'zoom_in', hint: '3D', action: () => openInspect(item) } : null,
    item.t === 'crate' && keyFor(I.itemDef(item)) ? { label: 'Buy key', icon: 'key', hint: `${money(D.keyPrice)} · you have ${keysFor(keyFor(I.itemDef(item)))}`, action: () => buyCrateKey(item).then(done) } : null,
    { label: 'Details', icon: 'info', action: () => showItemDetail(item, { onChange }) },
    '-',
  ].filter(Boolean);
  if (slot) {
    items.push(isEquipped(item)
      ? { label: 'Unequip', icon: 'loadout', hint: slotName(slot), action: async () => done(await tryAct('loadout.unequip', { uid: item.uid })) }
      : { label: 'Equip', icon: 'loadout', hint: slotName(slot), action: async () => done(await equipItem(item)) });
  }
  if (I.canHaveStickers(item)) {
    items.push({ label: 'Stickers', icon: 'sticker', hint: `${item.stk?.length || 0}/${I.MAX_STICKERS}`, action: () => openStickerEditor(item, { onDone: () => { emit('inv'); onChange?.(); } }) });
  }
  if (I.canHaveCharm(item)) {
    items.push(item.kc
      ? { label: 'Remove charm', icon: 'keychain_removal', hint: I.nameParts(I.attachedCharm(item)).bottom, action: async () => done(await detachCharm(item)) }
      : { label: 'Attach charm', icon: 'move_keychain', action: async () => done(await attachCharmTo(item)) });
    if (item.kc) items.push({ label: 'Move charm', icon: 'move_keychain', action: () => openInspect(item, { placeCharm: true }) });
  }
  if (item.t === 'charm') items.push({ label: 'Attach to a gun', icon: 'move_keychain', action: async () => done(await hangCharm(item)) });
  if (item.t === 'sticker' && D.slab) items.push({ label: 'Sticker Slab', icon: 'sticker', hint: money(D.slab.p), action: async () => done(await slabSticker(item)) });
  if (nameable(item)) items.push({ label: 'Apply Name Tag', icon: 'edit', action: async () => (await tools()).openNameTag(item, { onDone: () => done(true) }) });
  if (I.isTool(item)) items.push({ label: I.TOOLS[item.id].use, icon: item.id === I.NAME_TAG ? 'edit' : 'refresh', action: async () => (await tools()).useTool(item) });
  items.push({ label: 'Move To Storage Unit', icon: 'crate', action: async () => done(await (await storage()).moveToUnit([item])) });
  items.push({ label: item.lk ? 'Unlock' : 'Lock', icon: item.lk ? 'unlocked' : 'locked', action: async () => done(await tryAct('item.lock', { uid: item.uid, lk: !item.lk })) });
  items.push('-', { label: 'Sell', icon: 'dollar_sign', hint: money(I.itemValue(item)), disabled: !!item.lk, action: async () => done(await sellItems([item])) });
  contextMenu(e.clientX, e.clientY, items);
}

// ---- charms --------------------------------------------------------------------------------
const CHOOSE_SORTS = [['vdesc', 'Value: high → low'], ['vasc', 'Value: low → high'], ['new', 'Newest'], ['old', 'Oldest'], ['quality', 'Quality'], ['float', 'Float: low → high'], ['name', 'Name']];
// One item picked from a grid, searched and sorted like CS2's list (null if the window is closed). line(item): one more line
// on its card.
export function chooseItem(title, items, { empty = 'Nothing to choose from.', note = '', line } = {}) {
  return new Promise((resolve) => {
    let picked = null;
    const v = { q: '', sort: 'vdesc' };
    const m = openModal({
      title, cls: 'wide',
      body: `${note ? `<p class="muted" style="margin:0 0 12px">${note}</p>` : ''}${items.length ? `<div class="toolbar choose-bar">
          <input class="input" type="search" data-q placeholder="Search items…" spellcheck="false" autocomplete="off">
          <select class="input" data-sort>${CHOOSE_SORTS.map(([k, t]) => `<option value="${k}">${esc(t)}</option>`).join('')}</select>
        </div><div class="grid" data-grid></div>` : `<div class="empty">${empty}</div>`}`,
      foot: '<button class="btn ghost" data-close>Cancel</button>',
      onClose: () => resolve(picked),
    });
    const grid = m.el.querySelector('[data-grid]');
    if (!grid) return;
    const draw = () => {
      const list = viewItems(items, v);
      grid.innerHTML = list.length ? list.map((it) => itemCard(it, { line: line?.(it) })).join('') : '<div class="empty" style="grid-column:1/-1">Nothing matches your search.</div>';
    };
    grid.addEventListener('click', (e) => {
      const c = e.target.closest('.card[data-uid]');
      if (c) { picked = items.find((it) => it.uid === c.dataset.uid); m.close(); }
    });
    m.el.querySelector('[data-q]').addEventListener('input', (e) => { v.q = e.target.value; draw(); });
    m.el.querySelector('[data-sort]').addEventListener('change', (e) => { v.sort = e.target.value; draw(); });
    draw();
  });
}
const byValue = (a, b) => I.itemValue(b) - I.itemValue(a);
async function attach(gun, charm) {
  const r = await tryAct('charms.attach', { uid: gun.uid, charm: charm.uid });
  if (!r) return false;
  sfx.charm();
  toast(`Attached ${esc(I.itemName(charm))} to ${esc(I.itemName(gun))}`, 'good');
  // Then where it hangs, on the gun's real model.
  if ((await cs2Status().catch(() => null))?.available) openInspect(r.item, { placeCharm: true });
  return true;
}
// Picks one of your charms for a gun.
async function attachCharmTo(gun) {
  const charms = S.inv.filter((i) => i.t === 'charm' && !i.lk).sort(byValue);
  const c = await chooseItem(`Attach a charm to ${esc(I.itemName(gun))}`, charms, {
    empty: 'You have no charms. Get them from the Armory’s charm collections or the market, or seal a sticker in a Sticker Slab.',
    note: 'A charm hangs anywhere you put it on the gun (one per gun). Taking it off again uses a Charm Detachment.',
  });
  return c ? attach(gun, c) : false;
}
// Picks a gun for one of your charms.
async function hangCharm(charm) {
  const guns = S.inv.filter((i) => I.canHaveCharm(i) && !i.kc).sort(byValue);
  const g = await chooseItem(`Attach ${esc(I.itemName(charm))} to…`, guns, { empty: 'You have no guns without a charm. Charms go on guns (not knives or gloves), one per gun.' });
  return g ? attach(g, charm) : false;
}
async function detachCharm(gun) {
  const name = esc(I.itemName(I.attachedCharm(gun)));
  let buy = false;
  if (!(S.charmDetach > 0)) {
    if (!(await confirmDialog(`Taking ${name} off uses a Charm Detachment, and you have none. Buy a pack of ${I.DETACH_PACK.n} for <b class="green">${money(I.DETACH_PACK.price)}</b>?`, { ok: 'Buy and remove' }))) return false;
    buy = true;
  }
  const r = await tryAct('charms.detach', { uid: gun.uid, buy });
  if (!r) return false;
  sfx.charm();
  toast(`Removed ${name}. ${r.left} Charm Detachment${r.left === 1 ? '' : 's'} left.`, 'good');
  return true;
}
async function slabSticker(sticker) {
  const name = esc(I.itemName(sticker));
  if (!(await confirmDialog(`Seal ${name} in a Sticker Slab for <b class="green">${money(D.slab.p)}</b>? It becomes a charm you can hang on a gun. The sticker can’t be taken out again.`, { ok: 'Slab it' }))) return false;
  const r = await tryAct('charms.slab', { uid: sticker.uid });
  if (!r) return false;
  sfx.charm();
  toast(`Made <b>${esc(I.itemName(r.item))}</b>`, 'good');
  return true;
}

// ---- item detail ---------------------------------------------------------------------------
function detailBody(item) {
  const d = I.itemDef(item);
  const r = I.rarityInfo(item);
  const vb = I.valueBreakdown(item);
  const kv = [];
  if (item.t === 'skin') {
    if (item.fl != null) {
      kv.push(['Exterior', WEAR_BY_KEY[wearOf(item.fl)].n]);
      kv.push(['Float', `<span class="money">${I.floatString(item.fl)}</span>`]);
      kv.push(['Pattern template', item.sd]);
      const fr = floatRankOf(item.uid);
      if (fr) kv.push(['Float rank', `<span class="tag frk ${fr.low ? 'low' : 'high'} r${fr.low || fr.high}">#${fr.low || fr.high} ${fr.low ? 'Low' : 'High'}</span> ${esc(floatRankText(fr))}`]);
    }
    if (d.ph) kv.push(['Phase', d.ph]);
    kv.push(['Finish style', d.st || '—']);
    for (const [k, v] of vb.pat.info) kv.push([k, v]);
    if (item.stt) kv.push(['StatTrak™ kills', item.kills || 0]);
    if (I.customName(item)) kv.push(['Name Tag', `"<bdi>${esc(item.name)}</bdi>"`]);
    if (item.kc) { const c = I.attachedCharm(item); kv.push(['Charm', `${charmBadge(c)} ${esc(I.itemName(c))} <span class="muted">· Pattern #${c.pat.toLocaleString()}</span>`]); }
  } else if (item.t === 'charm') {
    for (const [k, v] of vb.pat.info) kv.push([k, v]);
    if (d.slab) kv.push(['Sticker', esc(D.stickers[item.sk]?.n || '?')]);
    else if (D.charmColById[d.col]) kv.push(['Collection', esc(D.charmColById[d.col].n)]);
    kv.push(['Attaches to', 'Any gun (one charm per gun)']);
  } else if (item.t === 'sticker') {
    if (d.t) kv.push(['Tournament', d.t]);
    if (d.fx) kv.push(['Finish', d.fx]);
    kv.push(['Type', d.ty || 'Sticker']);
  } else if (item.t === 'agent') {
    kv.push(['Team', d.team === 'T' ? 'Terrorist' : 'Counter-Terrorist']);
  } else if (item.t === 'crate') {
    const key = keyFor(d);
    kv.push(['Opens with', key ? `${esc(D.keys[key].n)} <span class="muted">· ${S.inv.filter((it) => it.t === 'key' && it.id === key && !it.lk).length} in your inventory</span>` : 'No key needed']);
  } else if (item.t === 'key') {
    kv.push(['Opens', d.cases.map((id) => esc(D.caseById[id]?.n || '?')).join(', ')]);
  } else if (item.t === 'tool') {
    kv.push(['Type', 'Tool']);
  }
  if (item.sn) kv.push(['Serial number', `#${item.sn.toLocaleString()}${I.serialLabel(item.sn) ? ` <span class="muted">· ${I.serialLabel(item.sn)}</span>` : ''}`]);
  else if (['skin', 'sticker', 'agent', 'charm'].includes(item.t)) kv.push(['Serial number', '<span class="muted">None (only unboxed items are numbered)</span>']);
  if (item.src) kv.push(['Obtained from', esc(item.src)]);

  const lines = [];
  if (item.t === 'skin') {
    lines.push(['Market price', money(vb.base)]);
    if (vb.fm !== 1) lines.push(['Float premium', '×' + vb.fm.toFixed(2)]);
    if (vb.pat.mult !== 1) lines.push([`Pattern (${esc(vb.pat.label || 'seed ' + item.sd)})`, '×' + vb.pat.mult]);
    for (const s of vb.stickers) lines.push([`Sticker: ${esc(s.def?.n.replace('Sticker | ', '') || '?')}${s.craft > 1 ? ' (craft ×' + s.craft + ')' : ''}`, '+' + money(s.value)]);
    if (vb.charm) lines.push([`Charm: ${esc(I.nameParts(I.attachedCharm(item)).bottom)}`, '+' + money(vb.charm)]);
  } else if (item.t === 'charm') {
    if (d.slab) lines.push(['Sticker', money(D.stickers[item.sk]?.p || 0)], ['Sticker Slab', '+' + money(D.slab.p)]);
    else lines.push(['Market price', money(vb.base)]);
    if (vb.pat.mult !== 1) lines.push([`Pattern (${esc(vb.pat.label)})`, '×' + vb.pat.mult]);
  } else {
    lines.push(['Market price', money(vb.base)]);
  }
  if (vb.sm !== 1) lines.push([`Serial #${item.sn.toLocaleString()}${I.serialLabel(item.sn) ? ' (' + I.serialLabel(item.sn).toLowerCase() + ')' : ' (unboxed)'}`, '×' + vb.sm.toFixed(3).replace(/0+$/, '')]);

  return `<div class="detail" style="--rc:${r.c}">
    <div>
      <div class="big ${isSlab(item) ? 'slab' : ''}"><img src="${I.itemImage(item, 'l')}" ${slabAttr(item)} alt=""></div>
      ${item.t === 'skin' ? floatBar(item) : ''}
    </div>
    <div>
      <h3>${I.nameHtml(item)}</h3>
      <div class="rar">${esc(r.n)}${d.ph ? ' · ' + esc(d.ph) : ''}</div>
      ${d.desc ? `<p class="muted" style="margin:-6px 0 12px;line-height:1.5">${esc(d.desc)}</p>` : ''}
      ${vb.pat.label ? `<div style="margin-bottom:10px">${patternTag(vb.pat)} ${vb.pat.tier ? `<span class="muted" style="font-size:12px">${TIER_LABEL[vb.pat.tier] || ''}</span>` : ''}</div>` : ''}
      <dl class="kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      <div class="valbox">
        <div class="muted" style="font-size:11px;letter-spacing:1px;text-transform:uppercase">Value</div>
        <div class="total">${money(vb.total)}</div>
        ${lines.map(([k, v]) => `<div class="line"><span>${k}</span><span>${v}</span></div>`).join('')}
      </div>
      <div class="actions">
        ${item.t === 'crate' ? crateButtons(item, d) : canInspect(item) ? '<button class="btn gold" data-a="inspect">Inspect in 3D</button>' : ''}
        ${I.canHaveStickers(item) ? `<button class="btn" data-a="stickers">Stickers (${item.stk?.length || 0}/${I.MAX_STICKERS})</button>` : ''}
        ${I.canHaveCharm(item) ? (item.kc ? '<button class="btn" data-a="charm-move">Move charm</button><button class="btn" data-a="charm-off">Remove charm</button>' : '<button class="btn" data-a="charm-on">Attach charm</button>') : ''}
        ${item.t === 'charm' ? '<button class="btn" data-a="charm-hang">Attach to a gun</button>' : ''}
        ${nameable(item) ? '<button class="btn" data-a="nametag">Apply Name Tag</button>' : ''}
        ${I.isTool(item) ? `<button class="btn gold" data-a="usetool">${esc(d.use)}</button>` : ''}
        ${item.t === 'sticker' && D.slab ? `<button class="btn" data-a="slab" title="Seal it in a clear case: a charm you can hang on a gun">Sticker Slab (${money(D.slab.p)})</button>` : ''}
        ${I.loadoutSlot(item) ? (isEquipped(item)
          ? `<button class="btn" data-a="unequip" title="Equipped as your ${esc(slotName(I.loadoutSlot(item)))}">Unequip</button>`
          : `<button class="btn" data-a="equip">Equip (${esc(slotName(I.loadoutSlot(item)))})</button>`) : ''}
        <button class="btn" data-a="store">Move To Storage Unit</button>
        <button class="btn" data-a="lock">${item.lk ? 'Unlock' : 'Lock'}</button>
        <button class="btn primary" data-a="sell" ${item.lk ? 'disabled' : ''}>Sell ${money(vb.total)}</button>
      </div>
    </div>
  </div>`;
}

// Older skins only have a 512×384 Steam icon, which the CDN pads into the large size: crop to the item (with a
// margin, keeping the 4:3 frame) so it fills the panel like newer skins do.
function fitToContent(c) {
  const b = alphaBox(c);
  const W = c.width, H = c.height;
  let w = (b.x1 - b.x0) * W * 1.08, h = (b.y1 - b.y0) * H * 1.08;
  if (w > W * 0.8 || h > H * 0.8) return c;
  if (w / h > W / H) h = (w * H) / W; else w = (h * W) / H;
  const cx = ((b.x0 + b.x1) / 2) * W, cy = ((b.y0 + b.y1) / 2) * H;
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  out.getContext('2d').drawImage(c, cx - w / 2, cy - h / 2, w, h, 0, 0, W, H);
  return out;
}

export function showItemDetail(item, { onChange } = {}) {
  if (I.isUnit(item)) { storage().then((p) => p.openUnit(item)); return null; }
  if (item.nw) act('item.seen', { uids: [item.uid] }).catch(() => {});
  const m = openModal({ title: 'Item details', body: detailBody(item), cls: 'wide', onClose: onChange });
  const refresh = () => {
    m.el.querySelector('.modal-body').innerHTML = detailBody(item);
    wire();
    upgradeImage();
  };
  // Swap the plain icon for the composed one (wear, pattern tint, stickers).
  const upgradeImage = () => {
    if (item.t !== 'skin') return;
    composeItem(item, { size: 'l' }).then((c) => {
      const big = m.el.querySelector('.big');
      if (!big) return;
      const img = document.createElement('img');
      img.src = fitToContent(c).toDataURL();
      big.replaceChildren(img);
    }).catch(() => {});
  };
  const wire = () => {
    m.el.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', async () => {
      const a = b.dataset.a;
      if (a === 'inspect') openInspect(item);
      if (a === 'open') { m.close(); openCrateItem(item); }
      if (a === 'buykey' && await buyCrateKey(item)) refresh();
      if (a === 'buyopen' && await buyCrateKey(item)) { m.close(); openCrateItem(item); }
      if (a === 'lock') { if (await tryAct('item.lock', { uid: item.uid, lk: !item.lk })) refresh(); }
      if (a === 'equip' && await equipItem(item)) refresh();
      if (a === 'unequip' && await tryAct('loadout.unequip', { uid: item.uid })) refresh();
      if (a === 'sell') { if (await sellItems([item])) m.close(); }
      if (a === 'store') { if (await (await storage()).moveToUnit([item])) m.close(); }
      if (a === 'stickers') openStickerEditor(item, { onDone: () => { emit('inv'); refresh(); } });
      if (a === 'charm-on' && await attachCharmTo(item)) refresh();
      if (a === 'charm-off' && await detachCharm(item)) refresh();
      if (a === 'charm-move') openInspect(item, { placeCharm: true });
      // The charm or sticker itself is used up: the details close.
      if (a === 'charm-hang' && await hangCharm(item)) m.close();
      if (a === 'slab' && await slabSticker(item)) m.close();
      if (a === 'nametag') (await tools()).openNameTag(item, { onDone: refresh });
      if (a === 'usetool') { m.close(); (await tools()).useTool(item); }
    }));
  };
  wire();
  upgradeImage();
  return m;
}

// ---- 3D inspect overlay --------------------------------------------------------------------
// placeCharm: start with the gun's charm ready to move. preview: a look at a copy that isn't in the inventory, so nothing on
// it can be saved.
export function openInspect(item, { placeCharm = false, preview = false } = {}) {
  const r = I.rarityInfo(item);
  const pat = I.patternInfo(item);
  const wrap = document.createElement('div');
  wrap.className = 'inspect';
  wrap.style.setProperty('--rc', r.c);
  const sub = [I.itemDef(item)?.ph, I.wearName(item), item.fl != null ? 'Float ' + I.floatString(item.fl) : '', item.sd != null ? 'Pattern ' + item.sd : '',
    item.t === 'charm' && item.pat ? 'Pattern #' + item.pat.toLocaleString() : ''].filter(Boolean).join('  ·  ');
  wrap.innerHTML = `
    <div class="stage"></div>
    <div class="loading">Loading…</div>
    <div class="insp-bar">
      <button class="insp-back" data-a="close" data-tip="Back (Esc)">${iconHtml('back', '<svg viewBox="0 0 32 32"><path d="M13 7l2.1 2.1-5.4 5.4H27v3H9.7l5.4 5.4L13 25 4 16z"/></svg>')}<span>Back</span></button>
      <span class="spacer"></span>
      <select class="input bg-pick" data-bg data-tip="Background (CS2's own maps)" style="display:none"></select>
      <button class="insp-btn" data-a="fp" data-tip="First person (V)" style="display:none">${iconHtml('first_person')}<span>First person</span></button>
      <button class="insp-btn" data-a="charm" data-tip="Move the charm (C)" style="display:none">${iconHtml('move_keychain')}<span>Move charm</span></button>
      <button class="insp-btn" data-a="inspect" data-tip="Inspect (F)">${iconHtml('rotate_weapon')}<span>Inspect</span></button>
      <button class="insp-btn" data-a="flip" data-tip="Flip (B)">${iconHtml('refresh')}<span>Flip</span></button>
      <button class="insp-btn" data-a="reset" data-tip="Reset the view (R)">${iconHtml('undo')}<span>Reset</span></button>
    </div>
    <div class="hud">
      <div class="rn">${esc(r.n)}</div>
      <h2>${I.nameHtml(item)}</h2>
      <div class="sub">${esc(sub)}</div>
      <div class="val">${money(I.itemValue(item))}</div>
      ${pat.label ? `<div class="pattern">${patternTag(pat)}</div>` : ''}
      ${item.t === 'skin' ? floatBar(item) : ''}
      ${item.stk?.length ? `<div class="sub" style="margin-top:10px">${item.stk.length} sticker${item.stk.length > 1 ? 's' : ''} applied</div>` : ''}
      ${item.kc ? `<div class="sub" style="margin-top:6px">Charm: ${esc(I.nameParts(I.attachedCharm(item)).bottom)} · Pattern #${item.kc.pat.toLocaleString()}</div>` : ''}
    </div>
    <div class="help">Drag to rotate · Scroll to zoom · Double-click to reset</div>`;
  document.body.appendChild(wrap);
  const stage = wrap.querySelector('.stage');
  inspectView.mount(stage);
  // Backdrops: CS2's own menu/inspect scenes (Dust II, Mirage...) when the game is installed.
  const bgSel = wrap.querySelector('[data-bg]');
  const setBg = async (id) => {
    const l = wrap.querySelector('.loading') || wrap.appendChild(Object.assign(document.createElement('div'), { className: 'loading' }));
    if (id !== 'studio') l.textContent = 'Loading…';
    try {
      await inspectView.setBackdrop(id);
      wrap.classList.toggle('has-bg', id !== 'studio');
    } catch (e) {
      toast('Could not load that backdrop: ' + esc(e.message), 'bad');
      await inspectView.setBackdrop('studio');
      wrap.classList.remove('has-bg');
      bgSel.value = 'studio';
    }
    if (!wrap.querySelector('.loading.model')) l.remove();
  };
  cs2VanityMaps().then((maps) => {
    if (!maps.length || !wrap.isConnected) return;
    const cur = S.settings.inspectBg || 'studio';
    bgSel.innerHTML = '<option value="studio">Studio</option>' + maps.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
    bgSel.value = maps.some((m) => m.id === cur) ? cur : 'studio';
    bgSel.style.display = '';
    if (bgSel.value !== 'studio') setBg(bgSel.value);
    bgSel.addEventListener('change', () => { S.settings.inspectBg = bgSel.value; save(); setBg(bgSel.value); });
  });
  wrap.querySelector('.loading').classList.add('model');
  inspectView.show(item)
    .then(() => {
      wrap.querySelector('.loading.model')?.remove();
      // First person is available for real CS2 guns and knives.
      if (inspectView.model?.userData.weapon || inspectView.model?.userData.gloveItem) wrap.querySelector('[data-a=fp]').style.display = '';
      // A charm can be moved on a gun's real model.
      if (item.kc && !preview && inspectView.model?.userData.root) {
        wrap.querySelector('[data-a=charm]').style.display = '';
        if (placeCharm) startPlacing();
      }
    })
    .catch((e) => { wrap.querySelector('.loading.model').textContent = 'Could not load model: ' + e.message; });
  const fpBtn = wrap.querySelector('[data-a=fp]');
  const fpLabel = (text) => { fpBtn.querySelector('span').textContent = text; };
  let fpBusy = false;
  const toggleFP = async () => {
    if (fpBusy || fpBtn.style.display === 'none') return;
    fpBusy = true;
    try {
      if (inspectView.fp) { inspectView.exitFirstPerson(); fpLabel('First person'); wrap.classList.remove('fp'); }
      else {
        fpLabel('Loading…');
        await inspectView.enterFirstPerson();
        fpLabel('Third person');
        wrap.classList.add('fp');
      }
    } catch (e) {
      toast('First person isn’t available for this item: ' + esc(e.message), 'bad');
      fpLabel('First person');
    }
    fpBusy = false;
  };
  // Moving the charm: a click on the gun hangs it there (a draft until saved).
  let placing = null;
  const rehang = async (o) => {
    const model = inspectView.model;
    if (!model || placing?.busy) return;
    if (placing) placing.busy = true;
    try {
      await rehangCharm(model, { ...item.kc, o: o || undefined });
      // First person copies the gun when it starts: copy it again.
      model.userData.fp?.dispose();
      model.userData.fp = null;
    } catch (e) { toast('Could not move the charm: ' + esc(e.message), 'bad'); }
    if (placing) placing.busy = false;
  };
  const startPlacing = () => {
    if (placing || !item.kc || preview || !inspectView.model?.userData.root) return;
    if (inspectView.fp) toggleFP();
    placing = { draft: item.kc.o || null, busy: false };
    wrap.classList.add('placing');
    const bar = document.createElement('div');
    bar.className = 'charm-place';
    bar.innerHTML = `<span>Click anywhere on the gun to hang the charm there</span>
      <button class="btn ghost" data-cp="default" data-tip="Where CS2 hangs a charm on this gun">Gun’s own spot</button>
      <button class="btn ghost" data-cp="cancel">Cancel</button>
      <button class="btn primary" data-cp="save">Save</button>`;
    wrap.appendChild(bar);
    bar.querySelectorAll('[data-cp]').forEach((b) => b.addEventListener('click', () => placeAct(b.dataset.cp)));
    inspectView.setPick(async (hit) => {
      const o = placementFromHit(inspectView.model, hit);
      if (!o || placing?.busy) return;
      placing.draft = o;
      sfx.charm();
      await rehang(o);
    });
  };
  const stopPlacing = () => {
    placing = null;
    inspectView.setPick(null);
    wrap.classList.remove('placing');
    wrap.querySelector('.charm-place')?.remove();
  };
  const placeAct = async (a) => {
    if (!placing || placing.busy) return;
    if (a === 'default') { placing.draft = null; await rehang(null); return; }
    if (a === 'cancel') { const o = item.kc.o; stopPlacing(); await rehang(o); return; }
    const r = await tryAct('charms.place', { uid: item.uid, o: placing.draft });
    if (!r) return;
    item = r.item;
    stopPlacing();
    toast(`Moved ${esc(I.nameParts(I.attachedCharm(item)).bottom)}`, 'good');
  };
  const close = () => {
    stopPlacing();
    inspectView.unmount();
    wrap.remove();
    window.removeEventListener('keydown', onKey, true);
  };
  const act = (a) => {
    if (a === 'close') close();
    if (a === 'inspect') inspectView.playInspect();
    if (a === 'fp') toggleFP();
    if (a === 'flip') inspectView.flip();
    if (a === 'reset') inspectView.reset();
    if (a === 'charm') placing ? placeAct('cancel') : startPlacing();
  };
  const onKey = (e) => {
    const k = e.key.toLowerCase();
    if (placing && k === 'escape') { e.stopPropagation(); e.preventDefault(); placeAct('cancel'); return; }
    const map = { escape: 'close', f: 'inspect', b: 'flip', r: 'reset', v: 'fp', c: 'charm' };
    if (map[k]) { e.stopPropagation(); e.preventDefault(); act(map[k]); }
  };
  window.addEventListener('keydown', onKey, true);
  wrap.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => act(b.dataset.a)));
}

export function rarityOddsHTML(c, tiers) {
  const names = {
    case: { 0: 'Consumer', 1: 'Industrial', 2: 'Mil-Spec', 3: 'Restricted', 4: 'Classified', 5: 'Covert', rare: '★ Rare Special' },
    capsule: { 2: 'High Grade', 3: 'Remarkable', 4: 'Exotic', 5: 'Extraordinary', 7: 'Contraband' },
    agents: { 2: 'Distinguished', 3: 'Exceptional', 4: 'Superior', 5: 'Master' },
  };
  const fam = ['case', 'souvenir', 'package', 'collection'].includes(c.kind) ? 'case' : c.kind === 'agents' ? 'agents' : 'capsule';
  const total = tiers.reduce((s, t) => s + t[1], 0);
  return tiers.map(([k, w]) => `<span style="--rc:${rarityColor(k === 'rare' ? 6 : +k)}">${names[fam][k] || k}: ${((w / total) * 100).toFixed(w / total < 0.001 ? 4 : 2)}%</span>`).join('');
}

export { WEARS };
