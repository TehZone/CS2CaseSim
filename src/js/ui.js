// Shared UI: cards, modals, toasts, item detail, 3D inspect overlay, selling.
import { esc, money, imgUrl } from './util.js';
import { D, WEARS, wearOf, WEAR_BY_KEY, rarityColor, eventName } from './data.js';
import * as I from './items.js';
import { S, emit, save } from './state.js';
import { act } from './backend.js';
import { sfx } from './audio.js';
import { inspectView } from './inspect.js';
import { cs2VanityMaps } from './cs2/api.js';
import { composeItem } from './composite.js';
import { chickenIncome, featherMult, HAT, BREED } from './chickens.js';
import { openStickerEditor } from './stickerEditor.js';
import { TIER_LABEL } from './patterns.js';

// ---- toasts --------------------------------------------------------------------------------
export function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 3200);
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

export function confirmDialog(text, { ok = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const m = openModal({
      title: 'Confirm', body: `<p style="margin:0;line-height:1.5">${text}</p>`,
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
  return `<div class="floatbar"><div class="range" style="left:${d.mn * 100}%;right:${(1 - d.mx) * 100}%"></div><i style="left:${item.fl * 100}%"></i></div>
    <div class="floatlabels"><span>FN</span><span>MW</span><span>FT</span><span>WW</span><span>BS</span></div>`;
}

export function itemCard(item, { selectable = false, selected = false, extra = '' } = {}) {
  const r = I.rarityInfo(item);
  const np = I.nameParts(item);
  const pat = I.patternInfo(item);
  const wear = item.t === 'skin' && item.fl != null ? `${wearOf(item.fl)} · ${item.fl.toFixed(4)}` : item.t === 'chicken' ? `${HAT[item.hat].n}` : r.n;
  const stk = item.stk?.length ? `<div class="stickers">${item.stk.map((s) => `<img src="${imgUrl(D.stickers[s.id]?.img, 's')}">`).join('')}</div>` : '';
  return `<div class="card ${selected ? 'selected' : ''} ${extra}" data-uid="${item.uid}" style="--rc:${r.c}">
    ${selectable ? '<div class="sel"></div>' : ''}
    <div class="tags">${item.nw ? '<span class="tag new">New</span>' : ''}${item.stt ? '<span class="tag st">ST™</span>' : ''}${item.sv ? '<span class="tag sv">Souvenir</span>' : ''}${patternTag(pat)}${item.lk ? '<span class="tag lock">🔒</span>' : ''}</div>
    <div class="img"><img loading="lazy" src="${I.itemImage(item, 'm')}" alt="">${stk}</div>
    <div class="rbar"></div>
    ${item.t === 'skin' && item.fl != null ? `<div class="floatline"><i style="left:${item.fl * 100}%"></i></div>` : ''}
    <div class="meta">
      <div class="n1 ${item.stt ? 'stt' : item.sv ? 'sv' : ''}">${esc(np.top)}</div>
      <div class="n2">${esc(np.bottom)}</div>
      <div class="row"><span class="wear">${esc(wear)}</span><span class="val">${money(I.itemValue(item))}</span></div>
      ${item.t === 'chicken' ? `<div class="income">🥚 ${money(chickenIncome(item))}/s egg rate</div>` : ''}
    </div>
  </div>`;
}

// ---- selling -------------------------------------------------------------------------------
export async function sellItems(items, { ask = true } = {}) {
  items = items.filter((i) => !i.lk);
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
    }
    if (d.ph) kv.push(['Phase', d.ph]);
    kv.push(['Finish style', d.st || '—']);
    for (const [k, v] of vb.pat.info) kv.push([k, v]);
    if (item.stt) kv.push(['StatTrak™ kills', item.kills || 0]);
  } else if (item.t === 'sticker') {
    if (d.t) kv.push(['Tournament', d.t]);
    if (d.fx) kv.push(['Finish', d.fx]);
    kv.push(['Type', d.ty || 'Sticker']);
  } else if (item.t === 'agent') {
    kv.push(['Team', d.team === 'T' ? 'Terrorist' : 'Counter-Terrorist']);
  } else if (item.t === 'pro') {
    kv.push(['Overall', d.ovr], ['Role', d.role], ['Team', esc(I.proTeamName(d))], ['Major', esc(eventName(d.ev))]);
    kv.push(['Aim / Utility / Positioning / Clutch', d.a.join(' / ')]);
    if (d.geo) kv.push(['Country', esc(d.geo)]);
  } else if (item.t === 'chicken') {
    kv.push(['Breed', BREED[item.id].n.replace('★ ', '')]);
    kv.push(['Hat', HAT[item.hat].n]);
    kv.push(['Feather float', `<span class="money">${I.floatString(item.fl)}</span>`]);
    kv.push(['Egg income', `${money(chickenIncome(item))}/s (when in coop)`]);
  }
  if (item.src) kv.push(['Obtained from', esc(item.src)]);

  const lines = [];
  if (item.t === 'skin') {
    lines.push(['Market price', money(vb.base)]);
    if (vb.fm !== 1) lines.push(['Float premium', '×' + vb.fm.toFixed(2)]);
    if (vb.pat.mult !== 1) lines.push([`Pattern (${esc(vb.pat.label || 'seed ' + item.sd)})`, '×' + vb.pat.mult]);
    for (const s of vb.stickers) lines.push([`Sticker: ${esc(s.def?.n.replace('Sticker | ', '') || '?')}${s.craft > 1 ? ' (craft ×' + s.craft + ')' : ''}`, '+' + money(s.value)]);
  } else if (item.t === 'chicken') {
    lines.push(['Breed value', money(BREED[item.id].v)]);
    lines.push(['Hat multiplier', '×' + HAT[item.hat].m]);
    lines.push(['Feather premium', '×' + featherMult(item.fl).toFixed(2)]);
  } else {
    lines.push(['Market price', money(vb.base)]);
  }

  return `<div class="detail" style="--rc:${r.c}">
    <div>
      <div class="big"><img src="${I.itemImage(item, 'l')}" alt=""></div>
      ${item.t === 'skin' ? floatBar(item) : ''}
    </div>
    <div>
      <h3>${esc(I.itemName(item))}</h3>
      <div class="rar">${esc(r.n)}${d.ph ? ' · ' + esc(d.ph) : ''}</div>
      ${vb.pat.label ? `<div style="margin-bottom:10px">${patternTag(vb.pat)} ${vb.pat.tier ? `<span class="muted" style="font-size:12px">${TIER_LABEL[vb.pat.tier] || ''}</span>` : ''}</div>` : ''}
      <dl class="kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      <div class="valbox">
        <div class="muted" style="font-size:11px;letter-spacing:1px;text-transform:uppercase">Value</div>
        <div class="total">${money(vb.total)}</div>
        ${lines.map(([k, v]) => `<div class="line"><span>${k}</span><span>${v}</span></div>`).join('')}
      </div>
      <div class="actions">
        <button class="btn gold" data-a="inspect">Inspect in 3D</button>
        ${I.canHaveStickers(item) ? `<button class="btn" data-a="stickers">Stickers (${item.stk?.length || 0}/${I.MAX_STICKERS})</button>` : ''}
        <button class="btn" data-a="lock">${item.lk ? 'Unlock' : 'Lock'}</button>
        <button class="btn primary" data-a="sell" ${item.lk ? 'disabled' : ''}>Sell ${money(vb.total)}</button>
      </div>
    </div>
  </div>`;
}

export function showItemDetail(item, { onChange } = {}) {
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
      img.src = c.toDataURL();
      big.replaceChildren(img);
    }).catch(() => {});
  };
  const wire = () => {
    m.el.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', async () => {
      const a = b.dataset.a;
      if (a === 'inspect') openInspect(item);
      if (a === 'lock') { if (await tryAct('item.lock', { uid: item.uid, lk: !item.lk })) refresh(); }
      if (a === 'sell') { if (await sellItems([item])) m.close(); }
      if (a === 'stickers') openStickerEditor(item, { onDone: () => { emit('inv'); refresh(); } });
    }));
  };
  wire();
  upgradeImage();
  return m;
}

// ---- 3D inspect overlay --------------------------------------------------------------------
export function openInspect(item) {
  const r = I.rarityInfo(item);
  const pat = I.patternInfo(item);
  const wrap = document.createElement('div');
  wrap.className = 'inspect';
  wrap.style.setProperty('--rc', r.c);
  const sub = [I.itemDef(item)?.ph, I.wearName(item), item.fl != null ? 'Float ' + I.floatString(item.fl) : '', item.sd != null ? 'Pattern ' + item.sd : '']
    .filter(Boolean).join('  ·  ');
  wrap.innerHTML = `
    <div class="stage"></div>
    <div class="loading">Loading model…</div>
    <div class="val">${money(I.itemValue(item))}</div>
    <div class="top">
      <select class="input bg-pick" data-bg title="Background" style="display:none"></select>
      <button class="btn" data-a="inspect">Inspect (F)</button>
      <button class="btn" data-a="flip">Flip (B)</button>
      <button class="btn" data-a="reset">Reset (R)</button>
      <button class="btn" data-a="close">Close (Esc)</button>
    </div>
    <div class="hud">
      <div class="rn">${esc(r.n)}</div>
      <h2>${esc(I.itemName(item))}</h2>
      <div class="sub">${esc(sub)}</div>
      ${pat.label ? `<div class="pattern">${patternTag(pat)}</div>` : ''}
      ${item.t === 'skin' ? floatBar(item) : ''}
      ${item.stk?.length ? `<div class="sub" style="margin-top:10px">${item.stk.length} sticker${item.stk.length > 1 ? 's' : ''} applied</div>` : ''}
    </div>
    <div class="help">Drag to rotate · Scroll to zoom · Double-click to reset</div>`;
  document.body.appendChild(wrap);
  const stage = wrap.querySelector('.stage');
  inspectView.mount(stage);
  const slow = setTimeout(() => {
    const l = wrap.querySelector('.loading');
    if (l) l.textContent = 'Extracting the model from your CS2 install (first time only)…';
  }, 1500);
  // Backdrops: CS2's own menu/inspect scenes (Dust II, Mirage...) when the game is installed.
  const bgSel = wrap.querySelector('[data-bg]');
  const setBg = async (id) => {
    const l = wrap.querySelector('.loading') || wrap.appendChild(Object.assign(document.createElement('div'), { className: 'loading' }));
    if (id !== 'studio') l.textContent = 'Loading the backdrop (the first time it is extracted from CS2, about 15 seconds)…';
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
    .then(() => { clearTimeout(slow); wrap.querySelector('.loading.model')?.remove(); })
    .catch((e) => { wrap.querySelector('.loading.model').textContent = 'Could not load model: ' + e.message; });
  const close = () => {
    inspectView.unmount();
    wrap.remove();
    window.removeEventListener('keydown', onKey, true);
  };
  const act = (a) => {
    if (a === 'close') close();
    if (a === 'inspect') inspectView.playInspect();
    if (a === 'flip') inspectView.flip();
    if (a === 'reset') inspectView.reset();
  };
  const onKey = (e) => {
    const k = e.key.toLowerCase();
    const map = { escape: 'close', f: 'inspect', b: 'flip', r: 'reset' };
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
