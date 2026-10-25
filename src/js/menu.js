// The main menu around every page, like CS2's Panorama: CS2's own icons in the top bar and on buttons, and a map from
// CS2's play menu behind everything. Both come from the player's install (the CS2 service decompiles and caches them);
// without CS2 the drawn icons and a plain backdrop stay.
import { cs2Status, cs2Play } from './cs2/api.js';
import { S } from './state.js';

let icons = null; // CS2's menu icons once loaded: { name: url }

// CS2's icon for a name as an absolute URL (a relative one in a custom property would resolve against the
// stylesheet that uses it), or null.
export const menuIcon = (name) => (icons?.[name] ? new URL(icons[name], location.href).href : null);

// Swaps the drawn icons ([data-icon] elements) in and under `root` for CS2's, masked so they take the text colour.
function applyIcons(root) {
  if (!icons) return;
  const els = root.matches?.('[data-icon]') ? [root] : [];
  els.push(...root.querySelectorAll('[data-icon]'));
  for (const el of els) {
    const url = menuIcon(el.dataset.icon);
    if (!url || el.classList.contains('cs2')) continue;
    el.style.setProperty('--icon', `url("${url}")`);
    el.classList.add('cs2');
  }
}

// An icon for markup built in JS: CS2's when loaded, else `fallback` (drawn SVG or nothing).
export function iconHtml(name, fallback = '') {
  const url = menuIcon(name);
  return url ? `<i class="ico cs2" data-icon="${name}" style="--icon:url(&quot;${url}&quot;)"></i>` : fallback ? `<i class="ico" data-icon="${name}">${fallback}</i>` : '';
}

// Maps whose play-menu screenshot can be the background: CS2's installed bomb maps, [{ id, name }].
export async function backgroundMaps() {
  if (!(await cs2Status()).available) return [];
  const list = await cs2Play('maps').catch(() => []);
  return (list || []).filter((m) => /^de_/.test(m.id));
}

// The main menu's background: CS2's play-menu screenshot of a map. 'random' (the default) picks one of the installed
// maps each launch; 'off' keeps the plain backdrop.
let shownChoice = null;
export async function setMenuBackground(choice = S.settings.menuBg || 'random') {
  const bg = document.getElementById('menu-bg');
  if (!bg) return;
  shownChoice = choice;
  if (choice === 'off') { bg.classList.remove('shown'); return; }
  const maps = await backgroundMaps();
  if (!maps.length) return;
  const id = maps.some((m) => m.id === choice) ? choice : maps[Math.floor(Math.random() * maps.length)].id;
  const url = await cs2Play('menuBackdrop', id).catch(() => null);
  if (!url || shownChoice !== choice) return;
  const abs = new URL(url, location.href).href;
  const img = new Image();
  img.src = abs;
  await img.decode().catch(() => {});
  if (shownChoice !== choice) return;
  bg.querySelector('.vista').style.backgroundImage = `url("${abs}")`;
  bg.dataset.map = id;
  bg.classList.add('shown');
}

export async function initMenu() {
  if (!(await cs2Status()).available) return;
  cs2Play('menuIcons').then((r) => {
    icons = r && Object.keys(r).length ? r : null;
    if (!icons) return;
    applyIcons(document.body);
    // Pages, popups and menus built from now on get CS2's icons too.
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) applyIcons(n);
    }).observe(document.body, { childList: true, subtree: true });
  }).catch((e) => console.warn('CS2 menu icons unavailable:', e));
  setMenuBackground();
}
