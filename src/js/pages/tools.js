// Name Tags and the StatTrak™ Swap Tool on screen, in CS2's words: buying them, naming an item (type, preview, apply), taking
// a name off, and the swap (pick two items, watch the counters change places, confirm). The rules are in engine/tools.js and
// the actions in engine/actions.js (tools.*), so the same checks run on the offline save and on the server. Not a page of its
// own: the store and the inventory open these.
import { esc, money } from '../util.js';
import * as I from '../items.js';
import { S } from '../state.js';
import { online } from '../backend.js';
import { sfx } from '../audio.js';
import { openModal, toast, tryAct, confirmDialog, itemCard, openInspect, canInspect, chooseItem } from '../ui.js';
import { net } from '../net/online.js';
import * as T from '../engine/tools.js';
import { namePlatePreview } from '../cs2/skin.js';

const pad = (n) => String(n).padStart(6, '0'); // (how CS2's popup writes a counter)
// What an open trade offer holds: neither it nor a tool in it can be used. (The server and the save have the last word.)
const held = () => (online()
  ? new Set(net.trades().filter((t) => t.status === 'open').flatMap((t) => [...t.give.items, ...t.get.items]).map((i) => i.uid))
  : T.heldByTraders(S));
const freeItems = (test) => { const busy = held(); return S.inv.filter((it) => !it.lk && !busy.has(it.uid) && test(it)); };
const freeTools = (id) => freeItems((it) => I.isTool(it) && it.id === id);
// What a list leaves out for an open offer, said in the list: the item would just seem to have gone. ('' if nothing is.)
const heldNote = (test) => {
  const busy = held(), n = S.inv.filter((it) => !it.lk && busy.has(it.uid) && test(it)).length;
  return !n ? '' : n === 1 ? '1 item is held by an open trade offer: answer it to use the item here.' : `${n} items are held by open trade offers: answer them to use the items here.`;
};
const byValue = (a, b) => I.itemValue(b) - I.itemValue(a);
const nothingFor = (tool) => `Could not find any items to use with ${esc(I.itemName(tool))} in your inventory.`; // inv_empty_lister_for_use

export async function buyTool(id, n = 1) {
  const r = await tryAct('tools.buy', { id, n });
  if (!r) return null;
  sfx.buy();
  toast(`Bought ${n > 1 ? `${n}× ` : ''}<b>${esc(I.TOOLS[id].n)}</b> for <b class="green">${money(r.cost)}</b>. ${n > 1 ? 'They\'re' : 'It\'s'} in your inventory.`, 'good');
  return r.items;
}

// CS2's Name Tag window: the plate shows what's typed as it's typed; press the tick to preview it on the item (the text locks;
// the cross starts over), then apply it. With no tag there's no tick, as in CS2. `tool`: the tag to use (else your oldest). An
// item with a name can have it removed here, with no tag needed.
export function openNameTag(item, { tool = null, onDone } = {}) {
  let name = null, plate = null; // (the name being previewed; the plate on show)
  const have = tool || freeTools(I.NAME_TAG)[0] || null;
  const m = openModal({
    title: 'Use Name Tag', cls: 'nt-modal',
    body: `<div class="nt-card" data-card></div>
      <div class="nt-plate" data-plate hidden></div>
      <p class="nt-for">Enter a new name for: <b>${esc(I.realName(item))}</b></p>
      <div class="nt-entry">
        <input class="input" data-name maxlength="${T.NAME_MAX}" placeholder="New name" spellcheck="false" autocomplete="off" value="${esc(I.customName(item))}">
        <button class="btn" data-tick title="Preview Name Tag" ${have ? '' : 'hidden'}>Preview</button>
        <button class="btn ghost" data-clear title="Start over." hidden>&times;</button>
      </div>
      <div class="nt-msg" data-msg></div>
      <p class="muted nt-warn">${have ? 'A Name Tag can only be used once' : 'You need a <b>Name Tag</b> to rename this item. They\'re in the store, on the Cases page\'s Tools tab.'}</p>`,
    foot: `${I.customName(item) ? '<button class="btn danger" data-remove title="Remove the name tag from this item, restoring its original name.">Remove Name Tag</button><span class="spacer"></span>' : ''}
      <button class="btn ghost" data-close>Close</button><button class="btn gold" data-ok disabled>Apply Name Tag</button>`,
  });
  const $ = (s) => m.el.querySelector(s);
  const input = $('[data-name]'), msg = $('[data-msg]'), ok = $('[data-ok]');
  const card = () => {
    $('[data-card]').innerHTML = itemCard(name == null ? item : { ...item, name });
    if (name != null && canInspect(item)) {
      const b = document.createElement('button');
      b.className = 'btn sm';
      b.textContent = 'Inspect';
      b.title = 'See it on the item';
      b.addEventListener('click', () => openInspect({ ...item, uid: 'preview-' + item.uid, name }, { preview: true }));
      $('[data-card]').appendChild(b);
    }
  };
  const lock = (on) => {
    input.disabled = on;
    $('[data-tick]').hidden = on || !have;
    $('[data-clear]').hidden = !on;
    ok.disabled = !(on && have);
  };
  const preview = () => {
    if (!have) return;
    const why = T.nameProblem(input.value);
    if (!why && input.value === item.name) { msg.textContent = 'It already has that name'; return; }
    msg.textContent = why;
    if (why) { input.focus(); return; }
    name = input.value;
    lock(true);
    card();
  };
  const unlock = () => {
    name = null;
    lock(false);
    card();
    input.focus();
  };
  const startOver = () => {
    msg.textContent = '';
    input.value = '';
    plate?.set('');
    unlock();
  };
  const apply = async () => {
    if (name == null || ok.disabled) return;
    ok.disabled = true;
    const r = await tryAct('tools.name', { uid: item.uid, tool: tool?.uid ?? null, name });
    if (!r) { unlock(); return; }
    sfx.buy();
    toast(`<b>Name Tag Applied</b> · ${esc(I.itemName(r.item))}`, 'good');
    m.close();
    onDone?.();
  };
  $('[data-tick]').addEventListener('click', preview);
  $('[data-clear]').addEventListener('click', startOver);
  ok.addEventListener('click', apply);
  $('[data-remove]')?.addEventListener('click', async () => { if (await removeNameTag(item)) { m.close(); onDone?.(); } });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') preview(); });
  input.addEventListener('input', () => plate?.set(input.value));
  namePlatePreview().then((p) => {
    if (!p || !m.el.isConnected) return;
    plate = p;
    plate.set(input.value);
    $('[data-plate]').append(plate.canvas);
    $('[data-plate]').hidden = false;
  }).catch(() => {}); // (no CS2 install: no plate)
  card();
  input.focus();
  input.select();
  return m;
}

export async function removeNameTag(item) {
  if (!(await confirmDialog('Remove the name tag from this item, restoring its original name.', { title: 'Remove Name Tag', ok: 'Remove Name Tag', danger: true }))) return false;
  if (!(await tryAct('tools.unname', { uid: item.uid }))) return false;
  sfx.buy();
  toast(`<b>Name Tag Removed</b> · ${esc(I.realName(item))}`, 'good');
  return true;
}

// Starting from the tag: which item it goes on.
async function useNameTag(tool) {
  const item = await chooseItem(`Select an item to use with ${esc(I.itemName(tool))}`, freeItems(T.nameable).sort(byValue), { empty: nothingFor(tool), note: heldNote(T.nameable) });
  if (item) openNameTag(item, { tool });
}

// CS2's swap: from the tool, the first item, then a second from those it can swap with, then both counters running to their
// new values. Nothing is used up until it's accepted.
async function useSwapTool(tool) {
  const line = (it) => `StatTrak™ ${pad(it.kills || 0)}`;
  const stattrak = (it) => it.t === 'skin' && it.stt && !!I.itemDef(it);
  const a = await chooseItem(`Select an item to use with ${esc(I.itemName(tool))}`, freeItems(stattrak).sort(byValue), { empty: nothingFor(tool), line, note: heldNote(stattrak) });
  if (!a) return;
  const matches = (it) => !T.swapRefusal(a, it);
  const b = await chooseItem(`Select an item to swap StatTrak™ values with ${I.nameHtml(a)}`, freeItems(matches).sort(byValue), {
    empty: `Could not find any items to swap StatTrak™ values with<br><b>${I.nameHtml(a)}</b> in your inventory.<br><br>StatTrak™ values can only be swapped between two of the same item type.`, line, note: `${I.nameHtml(a)} Selected for Swap · ${pad(a.kills || 0)} kills. Items with the same count have nothing to swap. ${heldNote(matches)}`,
  });
  if (b) confirmSwap(tool, a, b);
}
function confirmSwap(tool, a, b) {
  const from = [a.kills || 0, b.kills || 0], gap = from[1] - from[0];
  const side = (it, i) => `<div class="st-side" style="--rc:${I.rarityInfo(it).c}">
      <div class="st-img"><img src="${I.itemImage(it, 'm')}" alt=""></div>
      <div class="st-name" title="${esc(I.itemName(it))}">${esc(I.realName(it))}</div>${I.nameTagHtml(it)}
      <div class="st-count" data-n="${i}">${pad(from[i])}</div>
      <div class="muted st-was">Now ${pad(from[i])} · After ${pad(from[1 - i])}</div>
    </div>`;
  const m = openModal({
    title: 'StatTrak™ Swap Tool', cls: 'st-modal',
    body: `<p class="st-desc">This item swaps StatTrak™ values between two of the same item type.</p>
      <div class="st-pair">${side(a, 0)}${side(b, 1)}</div>
      <p class="muted st-warn">This StatTrak™ Swap Tool can only be used once</p>`,
    foot: '<button class="btn ghost" data-close>Close</button><button class="btn gold" data-ok>ACCEPT</button>',
    onClose: () => clearInterval(timer),
  });
  const nums = [...m.el.querySelectorAll('[data-n]')];
  let step = 0;
  const show = (k) => { const d = Math.round(k * gap); nums[0].textContent = pad(from[0] + d); nums[1].textContent = pad(from[1] - d); };
  // (the popup's own timing: a hundredth of the way every 40 ms)
  const timer = setInterval(() => { step = Math.min(1, step + 0.01); show(step); if (step >= 1) clearInterval(timer); }, 40);
  const ok = m.el.querySelector('[data-ok]');
  ok.addEventListener('click', async () => {
    ok.disabled = true;
    clearInterval(timer);
    show(1);
    const r = await tryAct('tools.swap', { a: a.uid, b: b.uid, tool: tool.uid });
    if (!r) { ok.disabled = false; return; }
    sfx.buy();
    toast(`<b>New StatTrak™ Value</b> · ${esc(I.itemName(r.a))}: ${pad(r.a.kills)} · ${esc(I.itemName(r.b))}: ${pad(r.b.kills)}`, 'good');
    m.close();
  });
}

// A tool's own button (I.TOOLS[id].use).
export function useTool(tool) {
  return tool.id === I.NAME_TAG ? useNameTag(tool) : useSwapTool(tool);
}
