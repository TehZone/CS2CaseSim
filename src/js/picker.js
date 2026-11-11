// A compact, searchable multi-select of inventory items (gambling stakes, trade offers, a profile's showcase).
// Choosing an item only marks its card: the list isn't drawn again, so it stays where it was scrolled to. A search, or
// redraw() when the items changed, draws the list again at the same scroll position, and the search box is never
// replaced (it keeps its focus and caret).
import { esc, money } from './util.js';
import * as I from './items.js';

// items: the list to choose from. selected: Set of uids (mutated). onChange(selected) after each toggle (it may change the
// set too: what's marked follows it). → { redraw } for when the items changed.
export function mountPicker(el, { items, selected, onChange, empty = 'No items', limit = 300 }) {
  let q = '';
  el.innerHTML = `<div class="toolbar" style="margin-bottom:8px"><input class="input" type="search" placeholder="Search items…" style="width:220px">
    <span class="muted" style="font-size:12px" data-count></span><button class="btn sm ghost" data-none style="display:none">Clear</button></div><div data-list></div>`;
  const search = el.querySelector('input[type=search]'), count = el.querySelector('[data-count]'), none = el.querySelector('[data-none]');
  const box = el.querySelector('[data-list]');
  // What's chosen: the count and value of all of it (whatever the search shows), Clear, and the marked cards.
  const sync = () => {
    const total = items().filter((it) => selected.has(it.uid)).reduce((s, it) => s + I.itemValue(it), 0);
    count.innerHTML = `${selected.size} selected · <b class="green">${money(total)}</b>`;
    none.style.display = selected.size ? '' : 'none';
    for (const c of box.querySelectorAll('[data-uid]')) c.classList.toggle('selected', selected.has(c.dataset.uid));
  };
  const drawList = () => {
    const scroll = box.querySelector('.picker')?.scrollTop || 0;
    const list = items()
      .filter((it) => !q || I.itemName(it).toLowerCase().includes(q))
      .map((it) => ({ it, v: I.itemValue(it) }))
      .sort((a, b) => b.v - a.v);
    box.innerHTML = list.length ? `<div class="picker">${list.slice(0, limit).map(({ it, v }) => {
      const r = I.rarityInfo(it);
      const np = I.nameParts(it);
      return `<div class="card ${selected.has(it.uid) ? 'selected' : ''}" data-uid="${esc(it.uid)}" style="--rc:${r.c}" title="${esc(I.itemName(it))}">
        <div class="sel"></div><div class="img"><img loading="lazy" src="${I.itemImage(it, 's')}"></div><div class="rbar"></div>
        <div class="meta"><div class="n2">${esc(np.bottom)}</div>${I.nameTagHtml(it)}<div class="row"><span class="val">${money(v)}</span></div></div></div>`;
    }).join('')}</div>` : `<div class="empty" style="padding:30px">${empty}</div>`;
    const grid = box.querySelector('.picker');
    if (grid) grid.scrollTop = scroll; // (the browser keeps it in range when the list got shorter)
    sync();
  };
  box.addEventListener('click', (e) => {
    const c = e.target.closest('[data-uid]');
    if (!c || !box.contains(c)) return;
    const u = c.dataset.uid;
    if (selected.has(u)) selected.delete(u); else selected.add(u);
    onChange?.(selected);
    sync();
  });
  none.addEventListener('click', () => { selected.clear(); onChange?.(selected); sync(); });
  search.addEventListener('input', () => { q = search.value.toLowerCase(); drawList(); });
  drawList();
  return { redraw: drawList };
}
