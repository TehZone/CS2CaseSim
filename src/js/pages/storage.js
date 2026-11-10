// Storage Units on screen: buying one, its label, a unit's contents (search, sort, rarity) and the deposit and retrieve
// flows, in CS2's words. The rules are in engine/storage.js and the actions in engine/actions.js (storage.*), so the same
// checks run on the offline save and on the server. Not a page of its own: the inventory and the store open these. A unit's
// count and value, and what's in it, come through stored.js: online, its contents are asked for as its window shows them.
import { esc, money, timeAgo, debounce } from '../util.js';
import * as I from '../items.js';
import { S, on } from '../state.js';
import { sfx } from '../audio.js';
import { openModal, toast, tryAct, confirmDialog, itemCard, openInspect, canInspect, contextMenu, chooseItem } from '../ui.js';
import * as SU from '../engine/storage.js';
import { unitContents, unitCount, unitValue, unitWatch } from '../stored.js';

const PAGE = 150;
const plural = (n) => `${n.toLocaleString('en-US')} item${n === 1 ? '' : 's'}`;
const liveUnit = (uid) => S.inv.find((it) => it.uid === uid && I.isUnit(it)) || null;
export const modifiedText = (unit) => (unit.mod ? `Last modified ${timeAgo(unit.mod)}` : 'Not used yet');

export async function buyUnit() {
  const r = await tryAct('storage.buy', {});
  if (!r) return null;
  sfx.buy();
  toast(`Bought a <b>Storage Unit</b> for <b class="green">${money(r.cost)}</b>. It's in your inventory.`, 'good');
  return r.items[0];
}

// The label window: the first time starts using the unit, later ones change it. Resolves whether it was set.
export function labelUnit(unit) {
  return new Promise((resolve) => {
    let done = false;
    const first = !unit.name;
    const m = openModal({
      title: first ? 'Personalize Your Storage Unit' : 'Change Label',
      body: `<p class="muted" style="margin-top:0;line-height:1.5">${first ? 'Enter a descriptive label for your personal Storage Unit and start using it for storing items.' : 'Enter a new descriptive label for this Storage Unit.'}</p>
        <input class="input" data-label maxlength="${SU.UNIT_NAME_MAX}" value="${esc(unit.name || '')}" placeholder="Label" style="width:100%">`,
      foot: `<button class="btn ghost" data-close>Cancel</button><button class="btn gold" data-ok>${first ? 'Personalize' : 'Save'}</button>`,
      onClose: () => resolve(done),
    });
    const input = m.el.querySelector('[data-label]');
    const go = async () => {
      if (!SU.cleanName(input.value)) { toast('Enter a label for it first', 'bad'); input.focus(); return; }
      if (!(await tryAct('storage.name', { unit: unit.uid, name: input.value }))) return;
      done = true;
      m.close();
    };
    m.el.querySelector('[data-ok]').addEventListener('click', go);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    input.focus();
    input.select();
  });
}

export async function deleteUnit(unit) {
  if (!(await confirmDialog(`Delete ${esc(I.itemName(unit))}? You don't get its price back.`, { ok: 'Delete', danger: true }))) return false;
  if (!(await tryAct('storage.delete', { unit: unit.uid }))) return false;
  toast(`Deleted ${esc(I.itemName(unit))}`, 'good');
  return true;
}

// A unit's window (labelled first if it's new): what's in it to look through and retrieve, or your inventory to deposit
// from. Moves are one item (right-click) or any number (select, then the button).
export async function openUnit(unit, mode = 'contents') {
  if (!unit.name && !(await labelUnit(unit))) return null;
  const uid = unit.uid;
  if (unit.nw) tryAct('item.seen', { uids: [uid] });
  const v = { mode, q: '', rank: 'all', sort: 'new', sel: new Set(), limit: PAGE };
  let off = null;
  const m = openModal({ title: 'Storage Unit', cls: 'wide su-modal', body: '<div data-su></div>', onClose: () => off?.() });
  const box = m.el.querySelector('[data-su]');
  const retrieving = () => v.mode === 'contents';
  const source = () => (retrieving() ? unitContents(uid) : S.inv.filter((it) => !I.isUnit(it)));
  // (What's in it, when it isn't here yet: asked for as the window shows it, and again after a reconnect, which forgets it;
  // drawn again when it comes. Depositing needs only its count, which is here: nothing is asked for then.)
  const inside = unitWatch(uid, () => { if (box.isConnected) draw(); });

  const move = async (uids) => {
    const r = await tryAct(retrieving() ? 'storage.retrieve' : 'storage.deposit', { unit: uid, uids });
    if (!r) return;
    sfx.buy();
    toast(`${retrieving() ? 'Retrieved' : 'Stored'} ${plural(r.n)}`, 'good');
    v.sel.clear();
    draw();
  };

  // The line under the list: picking items changes this and the card, and nothing else moves. (Its text says what's picked.)
  function drawFoot(items, all, room) {
    const picked = v.sel.size, over = !retrieving() && picked > room;
    const pickedValue = all.filter((it) => v.sel.has(it.uid)).reduce((s, it) => s + I.itemValue(it), 0);
    const el = box.querySelector('.su-foot');
    el.innerHTML = `<span class="muted">${retrieving() ? `${plural(items.length)} shown` : `Room for ${plural(room)}. Anything equipped comes off when it's stored.`}${picked ? ` · ${plural(picked)} selected · <b class="green">${money(pickedValue)}</b>` : ''}</span>
        <span class="spacer"></span>
        <button class="btn" data-all ${items.length ? '' : 'disabled'}>Select all shown</button>
        <button class="btn ghost" data-none ${picked ? '' : 'disabled'}>Clear</button>
        <button class="btn gold" data-go ${picked && !over ? '' : 'disabled'}>${over ? `Only room for ${room.toLocaleString('en-US')}` : `${retrieving() ? 'Retrieve' : 'Deposit'} ${picked ? plural(picked) : 'Items'}`}</button>`;
    el.querySelector('[data-all]').addEventListener('click', () => {
      for (const it of (retrieving() ? items : items.slice(0, room))) v.sel.add(it.uid);
      draw();
    });
    el.querySelector('[data-none]').addEventListener('click', () => { v.sel.clear(); draw(); });
    el.querySelector('[data-go]').addEventListener('click', () => move([...v.sel]));
  }

  // fromTop: it's a different list now. Otherwise the list stays where you'd scrolled to.
  function draw({ fromTop = false } = {}) {
    const u = liveUnit(uid);
    if (!u) { m.close(); return; }
    const scrolled = fromTop ? 0 : box.querySelector('.su-grid')?.scrollTop || 0;
    const got = retrieving() ? inside.status() : 'here', waiting = got !== 'here', loadFailed = got === 'failed';
    const n = unitCount(uid), room = SU.UNIT_CAP - n, all = source();
    const have = new Set(all.map((it) => it.uid));
    for (const id of [...v.sel]) if (!have.has(id)) v.sel.delete(id);
    const items = SU.viewItems(all, v), shown = items.slice(0, v.limit);
    const hadFocus = document.activeElement?.matches?.('[data-q]');
    box.innerHTML = `<div class="su-head">
        <img src="${I.itemImage(u, 'm')}" alt="">
        <div class="su-who"><h3>${esc(u.name)}</h3><div class="muted">${esc(modifiedText(u))}</div></div>
        <div class="su-fill"><div><b>${n.toLocaleString('en-US')}</b> / ${SU.UNIT_CAP.toLocaleString('en-US')} items</div><div class="su-bar"><i style="width:${(n / SU.UNIT_CAP) * 100}%"></i></div></div>
        <div class="su-worth"><span class="muted">Value inside</span><b class="green">${money(unitValue(uid))}</b></div>
        <div class="su-btns"><button class="btn sm" data-a="label">Change Label</button>${n ? '' : '<button class="btn sm danger" data-a="delete">Delete</button>'}</div>
      </div>
      <div class="toolbar su-bar-tools">
        <div class="seg"><button data-mode="contents" class="${retrieving() ? 'active' : ''}">Retrieve Items</button><button data-mode="deposit" class="${retrieving() ? '' : 'active'}">Deposit Items</button></div>
        <input class="input" type="search" data-q placeholder="${retrieving() ? 'Search this unit…' : 'Search inventory…'}" value="${esc(v.q)}">
        <select class="input" data-rank>${SU.RANK_FILTERS.map(([k, t]) => `<option value="${k}" ${v.rank === k ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
        <select class="input" data-sort>${SU.SORT_NAMES.map(([k, t]) => `<option value="${k}" ${v.sort === k ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
      </div>
      ${shown.length ? `<div class="grid su-grid">${shown.map((it) => itemCard(it, { selectable: true, selected: v.sel.has(it.uid) })).join('')}</div>`
        : `<div class="empty">${all.length ? 'Nothing matches your filters.' : waiting ? (loadFailed ? "Couldn't get what's in this Storage Unit from the server. <button class=\"btn sm\" data-retry>Try again</button>" : "Loading what's in it…")
          : retrieving() ? 'This Storage Unit is empty. Deposit items from your inventory to keep them here, out of the way.' : 'You have nothing to store.'}</div>`}
      ${items.length > v.limit ? `<div class="pager"><button class="btn" data-more>Show more (${(items.length - v.limit).toLocaleString('en-US')} more)</button></div>` : ''}
      <div class="su-foot"></div>`;
    const grid = box.querySelector('.su-grid');
    if (grid) grid.scrollTop = scrolled;
    drawFoot(items, all, room);

    box.querySelector('[data-a=label]').addEventListener('click', async () => { if (await labelUnit(u)) draw(); });
    box.querySelector('[data-a=delete]')?.addEventListener('click', async () => { if (await deleteUnit(u)) m.close(); });
    box.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { v.mode = b.dataset.mode; v.sel.clear(); v.limit = PAGE; v.q = ''; v.rank = 'all'; draw({ fromTop: true }); }));
    const q = box.querySelector('[data-q]');
    q.addEventListener('input', debounce(() => { v.q = q.value; v.limit = PAGE; draw({ fromTop: true }); }, 200));
    if (hadFocus) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
    box.querySelector('[data-rank]').addEventListener('change', (e) => { v.rank = e.target.value; v.limit = PAGE; draw({ fromTop: true }); });
    box.querySelector('[data-sort]').addEventListener('change', (e) => { v.sort = e.target.value; draw({ fromTop: true }); });
    box.querySelector('[data-more]')?.addEventListener('click', () => { v.limit += PAGE; draw(); });
    box.querySelector('[data-retry]')?.addEventListener('click', () => { inside.retry(); draw(); });
    const find = (c) => shown.find((it) => it.uid === c.dataset.uid);
    box.querySelectorAll('.card[data-uid]').forEach((c) => {
      c.addEventListener('click', () => {
        const id = c.dataset.uid;
        if (v.sel.has(id)) v.sel.delete(id); else v.sel.add(id);
        c.classList.toggle('selected', v.sel.has(id));
        drawFoot(items, all, room);
      });
      c.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const it = find(c);
        if (!it) return;
        contextMenu(e.clientX, e.clientY, [
          canInspect(it) ? { label: 'Inspect', icon: 'zoom_in', hint: '3D', action: () => openInspect(it) } : null,
          { label: retrieving() ? 'Retrieve' : 'Move To Storage Unit', icon: 'crate', action: () => move([it.uid]) },
        ].filter(Boolean));
      });
    });
  }
  off = on('inv', debounce(() => { if (box.isConnected) draw(); }, 120));
  draw();
  return m;
}

// The right-click menu on a unit, with CS2's entries.
export function unitContextMenu(e, unit, { onChange } = {}) {
  const n = unitCount(unit.uid);
  const items = unit.name ? [
    { label: 'Retrieve Items', icon: 'crate', hint: plural(n), disabled: !n, action: () => openUnit(unit, 'contents') },
    { label: 'Deposit Items', icon: 'crate', action: () => openUnit(unit, 'deposit') },
    '-',
    { label: 'Change Label', icon: 'info', action: async () => { if (await labelUnit(unit)) onChange?.(); } },
  ] : [{ label: 'Start Using This Unit', icon: 'crate', action: () => openUnit(unit) }];
  items.push('-', { label: 'Delete', danger: true, disabled: n > 0, hint: n ? 'Retrieve its items first' : '', action: async () => { if (await deleteUnit(unit)) onChange?.(); } });
  contextMenu(e.clientX, e.clientY, items);
}

// Moves inventory items into a unit: the only one with room, else your pick of them. With none, an unlabelled one starts
// being used, or you're offered a new one. Resolves whether they moved.
export async function moveToUnit(items) {
  if (!items.length) return false;
  if (items.length > SU.UNIT_CAP) { toast(`A Storage Unit holds ${plural(SU.UNIT_CAP)}: select fewer`, 'bad'); return false; }
  const units = SU.unitsOf(S);
  const fits = units.filter((u) => u.name && SU.UNIT_CAP - unitCount(u.uid) >= items.length).sort((a, b) => (b.mod || 0) - (a.mod || 0));
  let unit = fits[0];
  if (fits.length > 1) {
    unit = await chooseItem(`Select a Storage Unit to move ${items.length === 1 ? esc(I.itemName(items[0])) : plural(items.length)} into`, fits);
    if (!unit) return false;
  } else if (!unit) {
    unit = units.find((u) => !u.name);
    if (!unit) {
      if (!(await confirmDialog(`You have no Storage Unit with room for ${plural(items.length)}. Buy one for <b class="green">${money(SU.UNIT_PRICE)}</b>?`, { ok: 'Buy' }))) return false;
      unit = await buyUnit();
      if (!unit) return false;
    }
    if (!(await labelUnit(unit))) return false;
  }
  const r = await tryAct('storage.deposit', { unit: unit.uid, uids: items.map((it) => it.uid) });
  if (!r) return false;
  sfx.buy();
  toast(`Moved ${plural(r.n)} to <b>${esc(unit.name)}</b>`, 'good');
  return true;
}
