// Sticker application: free placement on the weapon, rotation with the mouse wheel, scraping, value preview.
import { esc, money, imgUrl } from './util.js';
import { D } from './data.js';
import * as I from './items.js';
import { S, removeItems, save, emit } from './state.js';
import { composeItem, drawStickers, STICKER_BASE } from './composite.js';
import { cs2Status } from './cs2/api.js';
import { renderSideView } from './cs2/skin.js';
import { inspectView } from './inspect.js';
import { openModal, toast, confirmDialog } from './ui.js';
import { sfx } from './audio.js';

export function openStickerEditor(item, { onDone } = {}) {
  if (!I.canHaveStickers(item)) return toast('Stickers can only be applied to guns.', 'bad');
  let pending = []; // { id, x, y, r, srcUid }
  let selected = null; // sticker def id currently held
  let rot = 0;
  let filter = '';

  const m = openModal({
    title: 'Apply stickers — ' + esc(I.itemName(item)),
    cls: 'xwide',
    body: `<div class="stk-editor">
      <div>
        <div class="stk-canvas-wrap"><canvas width="1024" height="768"></canvas><img class="stk-ghost" style="display:none"></div>
        <p class="muted" style="margin:10px 0 0;font-size:12px">Pick a sticker on the right, then click on the weapon to place it. Scroll to rotate. Right-click cancels.</p>
      </div>
      <div>
        <div class="section-title" style="margin-top:0">Slots</div>
        <div class="slots"></div>
        <div class="section-title">Your stickers</div>
        <input class="input" type="search" placeholder="Search your stickers…" style="width:100%;margin-bottom:8px">
        <div class="stk-pick"></div>
      </div>
    </div>`,
    foot: `<div class="valpreview muted" style="margin-right:auto"></div><button class="btn ghost" data-close>Cancel</button><button class="btn gold" data-apply>Apply stickers</button>`,
  });
  const el = m.el;
  const cv = el.querySelector('canvas');
  const ctx = cv.getContext('2d');
  const ghost = el.querySelector('.stk-ghost');
  const wrap = el.querySelector('.stk-canvas-wrap');
  let alpha = null;
  // Visible region of the base image (normalised), cropped to the weapon so it fills the editor.
  let crop = { x: 0, y: 0, w: 1, h: 1 };
  // 'model': the real CS2 model's side view (stickers stored in model space, shown as decals in 3D);
  // 'icon': the Steam icon (when CS2 isn't installed).
  let mode = 'icon';
  let side = null;

  const loadingText = (t) => {
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = '#9fb0c4';
    ctx.font = '28px Bahnschrift, Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(t, cv.width / 2, cv.height / 2);
  };
  const renderModelSide = async () => {
    inspectView.init();
    side = await renderSideView({ ...item, stk: item.stk || [] }, I.itemDef(item), inspectView.renderer, inspectView.envStudio);
    return side;
  };
  const baseImage = async () => {
    if (await cs2Status().then((st) => st.available).catch(() => false)) {
      loadingText('Loading the real CS2 model…');
      try {
        if (await renderModelSide()) { mode = 'model'; return side.canvas; }
      } catch (e) { console.warn('CS2 side view unavailable, using the icon', e); }
    }
    mode = 'icon';
    return composeItem(item, { size: 'l', stickers: false });
  };

  const ready = baseImage().then((c) => {
    const a = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
    alpha = { w: c.width, h: c.height, d: a.data };
    let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
    for (let y = 0; y < c.height; y += 2) for (let x = 0; x < c.width; x += 2) {
      if (a.data[(y * c.width + x) * 4 + 3] > 20) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 > x0) {
      const pad = 0.05;
      let w = (x1 - x0) / c.width + pad * 2, h = (y1 - y0) / c.height + pad * 2;
      const aspect = cv.width / cv.height, imgAspect = c.width / c.height;
      if (w * imgAspect / h > aspect) h = (w * imgAspect) / aspect; else w = (h * aspect) / imgAspect;
      if (mode === 'icon') { w = Math.min(1, w); h = Math.min(1, h); }
      const cx = (x0 + x1) / 2 / c.width, cy = (y0 + y1) / 2 / c.height;
      crop = mode === 'icon'
        ? { x: Math.min(1 - w, Math.max(0, cx - w / 2)), y: Math.min(1 - h, Math.max(0, cy - h / 2)), w, h }
        : { x: cx - w / 2, y: cy - h / 2, w, h };
    }
  });

  const ownedStickers = () => {
    const used = new Set(pending.map((p) => p.srcUid));
    const groups = new Map();
    for (const it of S.inv) {
      if (it.t !== 'sticker' || used.has(it.uid) || it.lk) continue;
      const g = groups.get(it.id) || { id: it.id, uids: [] };
      g.uids.push(it.uid);
      groups.set(it.id, g);
    }
    return [...groups.values()].sort((a, b) => (D.stickers[b.id]?.p || 0) - (D.stickers[a.id]?.p || 0));
  };

  const placed = (p) => ({ id: p.id, x: p.x, y: p.y, r: p.r, wr: 0, ...(mode === 'model' ? { m: 1 } : {}) });
  const preview = () => ({ ...item, stk: [...(item.stk || []), ...pending.map(placed)] });

  async function redraw() {
    await ready;
    let c;
    if (mode === 'model') {
      // Applied stickers are already rendered on the model; draw the pending ones on top (in image space).
      c = document.createElement('canvas');
      c.width = side.canvas.width; c.height = side.canvas.height;
      const cctx = c.getContext('2d', { willReadFrequently: true });
      cctx.drawImage(side.canvas, 0, 0);
      await drawStickers(cctx, c.width, c.height, pending.map((p) => ({ ...placed(p), m: 0 })));
    } else {
      c = await composeItem(preview(), { size: 'l' });
    }
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(c, crop.x * c.width, crop.y * c.height, crop.w * c.width, crop.h * c.height, 0, 0, cv.width, cv.height);
  }

  function renderSide() {
    const slots = el.querySelector('.slots');
    const all = [...(item.stk || []).map((s, i) => ({ ...s, applied: i })), ...pending.map((p, i) => ({ ...p, pend: i }))];
    let html = '';
    for (let i = 0; i < I.MAX_STICKERS; i++) {
      const s = all[i];
      if (!s) { html += '<div class="sl"></div>'; continue; }
      const def = D.stickers[s.id];
      html += `<div class="sl ${s.pend != null ? 'pending' : ''}" title="${esc(def?.n || '')}${s.wr ? ' — scraped ' + Math.round(s.wr * 100) + '%' : ''}">
        <img src="${imgUrl(def?.img, 's')}" style="opacity:${1 - (s.wr || 0) * 0.6}">
        ${s.pend != null ? `<button data-unpend="${s.pend}" title="Remove">×</button>` : `<button data-scrape="${s.applied}" title="Scrape (destroys at 100%)" style="background:#7a5a20">⌁</button>`}
      </div>`;
    }
    slots.innerHTML = html;
    slots.querySelectorAll('[data-unpend]').forEach((b) => b.addEventListener('click', () => { pending.splice(+b.dataset.unpend, 1); update(); }));
    slots.querySelectorAll('[data-scrape]').forEach((b) => b.addEventListener('click', () => scrape(+b.dataset.scrape)));

    const pick = el.querySelector('.stk-pick');
    const groups = ownedStickers().filter((g) => !filter || D.stickers[g.id]?.n.toLowerCase().includes(filter));
    pick.innerHTML = groups.length
      ? groups.map((g) => {
          const d = D.stickers[g.id];
          return `<div class="s ${selected === g.id ? 'on' : ''}" data-id="${g.id}" title="${esc(d.n)}">
            <img src="${imgUrl(d.img, 's')}" loading="lazy"><div>${esc(d.n.replace('Sticker | ', '')).slice(0, 34)}</div>
            <div class="p">${money(d.p)}${g.uids.length > 1 ? ` <span class="muted">×${g.uids.length}</span>` : ''}</div></div>`;
        }).join('')
      : `<div class="muted" style="grid-column:1/-1;padding:20px;text-align:center">No stickers in your inventory.<br>Open sticker capsules or buy some on the Market.</div>`;
    pick.querySelectorAll('.s').forEach((d) => d.addEventListener('click', () => {
      selected = selected === d.dataset.id ? null : d.dataset.id;
      rot = 0;
      updateGhost();
      renderSide();
    }));

    const before = I.itemValue(item);
    const after = I.valueBreakdown(preview()).total;
    const pendCost = pending.reduce((s, p) => s + (D.stickers[p.id]?.p || 0), 0);
    el.querySelector('.valpreview').innerHTML = pending.length
      ? `Value ${money(before)} → <b class="green">${money(after)}</b> (+${money(after - before)}) · stickers used worth ${money(pendCost)}`
      : `Current value <b class="green">${money(before)}</b>`;
    el.querySelector('[data-apply]').disabled = !pending.length;
  }

  function updateGhost(e) {
    if (!selected || (item.stk?.length || 0) + pending.length >= I.MAX_STICKERS) { ghost.style.display = 'none'; return; }
    const rect = wrap.getBoundingClientRect();
    const w = (STICKER_BASE * rect.width) / crop.w;
    ghost.src = imgUrl(D.stickers[selected].img, 'm');
    ghost.style.width = w + 'px';
    if (e) {
      ghost.style.left = e.clientX - rect.left - w / 2 + 'px';
      ghost.style.top = e.clientY - rect.top - (ghost.offsetHeight || w * 0.75) / 2 + 'px';
      ghost.style.display = 'block';
    }
    ghost.style.transform = `rotate(${rot}deg)`;
  }

  function onWeapon(x, y) {
    if (!alpha) return true;
    if (x < 0 || x >= 1 || y < 0 || y >= 1) return false;
    const px = Math.floor(x * alpha.w), py = Math.floor(y * alpha.h);
    return alpha.d[(py * alpha.w + px) * 4 + 3] > 60;
  }

  wrap.addEventListener('mousemove', updateGhost);
  wrap.addEventListener('mouseleave', () => (ghost.style.display = 'none'));
  wrap.addEventListener('wheel', (e) => {
    if (!selected) return;
    e.preventDefault();
    rot = (rot + (e.deltaY > 0 ? 8 : -8) + 360) % 360;
    updateGhost(e);
  }, { passive: false });
  wrap.addEventListener('contextmenu', (e) => { e.preventDefault(); selected = null; updateGhost(); renderSide(); });
  wrap.addEventListener('click', (e) => {
    if (!selected) return;
    if ((item.stk?.length || 0) + pending.length >= I.MAX_STICKERS) return toast('All 5 sticker slots are used.', 'bad');
    const rect = wrap.getBoundingClientRect();
    const x = crop.x + ((e.clientX - rect.left) / rect.width) * crop.w;
    const y = crop.y + ((e.clientY - rect.top) / rect.height) * crop.h;
    if (!onWeapon(x, y)) return toast('Place the sticker on the weapon.', 'bad');
    const g = ownedStickers().find((g) => g.id === selected);
    if (!g) { selected = null; return update(); }
    pending.push({ id: selected, x, y, r: rot, srcUid: g.uids[0] });
    sfx.sticker();
    if (!ownedStickers().some((x) => x.id === selected)) selected = null;
    update();
  });
  el.querySelector('input[type=search]').addEventListener('input', (e) => { filter = e.target.value.toLowerCase(); renderSide(); });

  async function scrape(i) {
    const s = item.stk[i];
    const next = Math.round(((s.wr || 0) + 0.25) * 100) / 100;
    if (next >= 1 && !(await confirmDialog('Scraping again will <b>remove and destroy</b> this sticker. Continue?', { ok: 'Scrape off', danger: true }))) return;
    sfx.scrape();
    const stk = [...item.stk];
    if (next >= 1) stk.splice(i, 1);
    else stk[i] = { ...s, wr: next };
    item.stk = stk;
    save();
    emit('inv');
    if (mode === 'model') { loadingText('Updating…'); await renderModelSide(); }
    update();
  }

  el.querySelector('[data-apply]').addEventListener('click', () => {
    if (!pending.length) return;
    item.stk = [...(item.stk || []), ...pending.map(placed)];
    S.stats.stickersApplied += pending.length;
    removeItems(pending.map((p) => p.srcUid)); // consumes the sticker items (also saves + emits)
    sfx.sticker();
    toast(`Applied ${pending.length} sticker${pending.length > 1 ? 's' : ''}. New value <b class="green">${money(I.itemValue(item))}</b>`, 'good');
    pending = [];
    m.close();
    onDone?.();
  });

  function update() { renderSide(); redraw(); updateGhost(); }
  update();
}
