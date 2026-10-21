// A compact, searchable multi-select of inventory items (gambling stakes, trade offers).
import { esc, money } from './util.js';
import * as I from './items.js';

// items: the list to choose from. selected: Set of uids (mutated). onChange(selected) after each toggle.
export function mountPicker(el, { items, selected, onChange, empty = 'No items', limit = 300 }) {
  let q = '';
  const draw = () => {
    const list = items()
      .filter((it) => !q || I.itemName(it).toLowerCase().includes(q))
      .map((it) => ({ it, v: I.itemValue(it) }))
      .sort((a, b) => b.v - a.v);
    const total = list.filter(({ it }) => selected.has(it.uid)).reduce((s, x) => s + x.v, 0);
    el.innerHTML = `<div class="toolbar" style="margin-bottom:8px"><input class="input" type="search" placeholder="Search items…" value="${esc(q)}" style="width:220px">
      <span class="muted" style="font-size:12px">${selected.size} selected · <b class="green">${money(total)}</b></span>
      ${selected.size ? '<button class="btn sm ghost" data-none>Clear</button>' : ''}</div>
      ${list.length ? `<div class="picker">${list.slice(0, limit).map(({ it, v }) => {
        const r = I.rarityInfo(it);
        const np = I.nameParts(it);
        return `<div class="card ${selected.has(it.uid) ? 'selected' : ''}" data-uid="${it.uid}" style="--rc:${r.c}" title="${esc(I.itemName(it))}">
          <div class="sel"></div><div class="img"><img loading="lazy" src="${I.itemImage(it, 's')}"></div><div class="rbar"></div>
          <div class="meta"><div class="n2">${esc(np.bottom)}</div><div class="row"><span class="val">${money(v)}</span></div></div></div>`;
      }).join('')}</div>` : `<div class="empty" style="padding:30px">${empty}</div>`}`;
    el.querySelectorAll('[data-uid]').forEach((c) => c.addEventListener('click', () => {
      const u = c.dataset.uid;
      if (selected.has(u)) selected.delete(u); else selected.add(u);
      draw();
      onChange?.(selected);
    }));
    el.querySelector('[data-none]')?.addEventListener('click', () => { selected.clear(); draw(); onChange?.(selected); });
    const s = el.querySelector('input[type=search]');
    s.addEventListener('input', () => { q = s.value.toLowerCase(); draw(); const n = el.querySelector('input[type=search]'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); });
  };
  draw();
  return { redraw: draw };
}
