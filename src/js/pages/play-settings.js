// The Play lobby's settings: your crosshair (with a live preview), the viewmodel's position, key binds, music and
// radio volume and the fps counter. Saved with the other Play preferences; a match reads them when it starts.
import { esc } from '../util.js';
import { CROSSHAIR, crosshairHtml } from '../play/hud.js';
import { ACTIONS, COMMANDS, bindTable, keyName, keyLabel } from '../play/input.js';

// keybinds: your binds (CS2 key name -> command), null for the defaults; binds: older saves' per-action keys.
export const SETTINGS_DEFAULTS = { crosshair: { ...CROSSHAIR }, viewmodel: { fov: 68, x: 1, y: 1, z: -1 }, keybinds: null, binds: {}, musicVolume: 1, voiceVolume: 1, showFps: true };
const COLORS = [['#32fa32', 'Green'], ['#ffff32', 'Yellow'], ['#32ffff', 'Cyan'], ['#ffffff', 'White'], ['#ff3232', 'Red'], ['#ff64ff', 'Pink']];
// CS2's viewmodel presets.
const PRESETS = { desktop: { fov: 68, x: 1, y: 1, z: -1 }, couch: { fov: 68, x: 0, y: 0, z: -1.5 }, classic: { fov: 68, x: 2.5, y: 0, z: -1.5 } };

let open = false, listening = null;

export function settingsHtml(p) {
  const c = { ...CROSSHAIR, ...p.crosshair }, v = { ...SETTINGS_DEFAULTS.viewmodel, ...p.viewmodel };
  const range = (k, label, min, max, step, val, group) => `<label class="ps-range">${label} <b data-out="${group}.${k}">${val}</b>
    <input type="range" min="${min}" max="${max}" step="${step}" value="${val}" data-s="${group}.${k}"></label>`;
  const check = (k, label, val, group) => `<label class="ps-check"><input type="checkbox" data-s="${group}.${k}" ${val ? 'checked' : ''}> ${label}</label>`;
  // Every action with the keys bound to it (as many as you like: ✕ takes one off, + adds one).
  const table = bindTable(p);
  const binds = ACTIONS.map(([a, label]) => {
    const keys = Object.keys(table).filter((k) => COMMANDS[table[k]] === a);
    return `<div class="ps-bind"><span>${esc(label)}</span><span class="ps-keys">${keys.map((k) => `<button class="ps-key" data-unbind="${esc(k)}" title="Unbind ${esc(keyLabel(k))}">${esc(keyLabel(k))} <i>✕</i></button>`).join('')}
      <button class="btn ghost sm ps-add" data-bind="${a}">${listening === a ? 'Press a key…' : '+'}</button></span></div>`;
  }).join('');
  return `<details class="play-settings panel" ${open ? 'open' : ''}><summary>Settings: crosshair, viewmodel, keys and sound</summary>
    <div class="ps-grid">
      <section><h4>Crosshair</h4>
        <div class="ps-xhair-preview"><div class="ps-xhair">${crosshairHtml(c)}</div></div>
        <label>Style<select class="input" data-s="crosshair.style"><option value="classic" ${c.style === 'classic' ? 'selected' : ''}>Classic (opens up as you move and shoot)</option><option value="static" ${c.style === 'static' ? 'selected' : ''}>Static</option></select></label>
        <label>Colour<select class="input" data-s="crosshair.color">${COLORS.map(([hex, n]) => `<option value="${hex}" ${c.color === hex ? 'selected' : ''}>${n}</option>`).join('')}${COLORS.some(([h]) => h === c.color) ? '' : `<option value="${esc(c.color)}" selected>Custom</option>`}</select></label>
        <label class="ps-range">Custom colour <input type="color" value="${esc(c.color)}" data-s="crosshair.color"></label>
        ${range('size', 'Length', 1, 14, 1, c.size, 'crosshair')}${range('gap', 'Gap', -3, 10, 1, c.gap, 'crosshair')}${range('thickness', 'Thickness', 1, 5, 1, c.thickness, 'crosshair')}
        ${check('outline', 'Outline', c.outline, 'crosshair')}${check('dot', 'Centre dot', c.dot, 'crosshair')}
      </section>
      <section><h4>Viewmodel</h4>
        <div class="ps-presets">${Object.keys(PRESETS).map((k) => `<button class="btn ghost sm" data-preset="${k}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div>
        ${range('fov', 'Field of view', 54, 68, 1, v.fov, 'viewmodel')}${range('x', 'Offset X (sideways)', -2.5, 2.5, 0.5, v.x, 'viewmodel')}
        ${range('y', 'Offset Y (forward)', -2, 2, 0.5, v.y, 'viewmodel')}${range('z', 'Offset Z (height)', -2, 2, 0.5, v.z, 'viewmodel')}
        <h4>Sound and HUD</h4>
        ${range('musicVolume', 'Music', 0, 1, 0.05, p.musicVolume ?? 1, 'root')}${range('voiceVolume', 'Radio voices', 0, 1, 0.05, p.voiceVolume ?? 1, 'root')}
        ${check('showFps', 'Show fps', p.showFps !== false, 'root')}
      </section>
      <section class="ps-binds"><h4>Keys <button class="btn ghost sm" data-resetbinds>Defaults</button></h4>${binds}
        <div class="muted">+ adds a key: press it (a mouse button or the mouse wheel too; Esc cancels). In a match the console (~) has CS2's bind: bind mwheeldown +jump.</div></section>
    </div></details>`;
}

// Wires the panel up: every change is saved at once; key binding listens for the next key press.
export function bindSettings(el, prefs, savePrefs, rerender) {
  el.querySelector('.play-settings')?.addEventListener('toggle', (e) => { open = e.target.open; });
  const write = (path, value) => {
    const q = prefs();
    const [group, key] = path.split('.');
    if (group === 'root') q[key] = value;
    else q[group] = { ...SETTINGS_DEFAULTS[group], ...(q[group] || {}), [key]: value };
    savePrefs(q);
    const out = el.querySelector(`[data-out="${path}"]`);
    if (out) out.textContent = value;
    const prev = el.querySelector('.ps-xhair');
    if (prev) prev.innerHTML = crosshairHtml({ ...CROSSHAIR, ...q.crosshair });
  };
  el.querySelectorAll('[data-s]').forEach((input) => input.addEventListener('input', () => {
    write(input.dataset.s, input.type === 'checkbox' ? input.checked : input.type === 'range' ? Number(input.value) : input.value);
  }));
  el.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => { const q = prefs(); q.viewmodel = { ...PRESETS[b.dataset.preset] }; savePrefs(q); rerender(); }));
  el.querySelector('[data-resetbinds]')?.addEventListener('click', (e) => { e.preventDefault(); const q = prefs(); q.keybinds = null; q.binds = {}; savePrefs(q); rerender(); });
  const saveTable = (change) => { const q = prefs(); const t = bindTable(q); change(t); q.keybinds = t; savePrefs(q); rerender(); };
  el.querySelectorAll('[data-unbind]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); saveTable((t) => { delete t[b.dataset.unbind]; }); }));
  el.querySelectorAll('[data-bind]').forEach((b) => b.addEventListener('click', (e) => {
    e.preventDefault();
    listening = b.dataset.bind;
    b.textContent = 'Press a key…';
    const cmd = ACTIONS.find(([a]) => a === listening)[2];
    // The next key, mouse button or wheel notch gets the action's command (a key does one thing: its old bind goes).
    const done = (key) => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onMouse, true);
      document.removeEventListener('wheel', onWheel, true);
      listening = null;
      if (key) saveTable((t) => { t[key] = cmd; }); else rerender();
    };
    const onKey = (ev) => { ev.preventDefault(); ev.stopPropagation(); done(ev.code === 'Escape' ? null : keyName(ev.code)); };
    const onMouse = (ev) => { ev.preventDefault(); ev.stopPropagation(); done(['mouse1', 'mouse3', 'mouse2', 'mouse4', 'mouse5'][ev.button]); };
    const onWheel = (ev) => { ev.preventDefault(); ev.stopPropagation(); done(ev.deltaY < 0 ? 'mwheelup' : 'mwheeldown'); };
    setTimeout(() => {
      document.addEventListener('keydown', onKey, true);
      document.addEventListener('mousedown', onMouse, true);
      document.addEventListener('wheel', onWheel, { capture: true, passive: false });
    }, 0);
  }));
}

// What a match gets from the saved preferences.
export function matchSettings(p) {
  return { crosshair: p.crosshair, viewmodel: p.viewmodel, keybinds: bindTable(p), musicVolume: p.musicVolume ?? 1, voiceVolume: p.voiceVolume ?? 1, showFps: p.showFps !== false };
}
