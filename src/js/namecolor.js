// The colour picker for the names players give: a Storage Unit's label (pages/storage.js) and a Name Tag's name
// (pages/tools.js). The palette (engine/namecolor.js NAME_COLORS, the default look first) is a radio group, so the arrow keys
// move through it and Tab goes past it; then a custom colour (the system's colour chooser: clicking it picks the custom colour
// it shows, the last one chosen there, so one can be gone back to after trying the palette). A sample shows the name as it
// will look, lightened as the game draws it when a colour is too dark to read.
import { esc } from './util.js';
import { NAME_COLORS, cleanColor, readableColor } from './engine/namecolor.js';

let seq = 0;
const inPalette = (c) => NAME_COLORS.some(([x]) => x === c);

// value: the colour to start with (six hex digits, null: the default look). text(): the name the sample shows. look: 'tag'
// (a Name Tag's, in quotes and italics as the tiles show it) or 'label' (a unit's label). onChange(colour) as it changes.
// → { html (for the dialog's body), mount(root) (once it's on the page), value() (six hex digits or null), refresh() (the
// sample again, after the name changed) }
export function colorPicker({ value = null, text = () => '', look = 'tag', onChange } = {}) {
  const id = `nc-pick-${++seq}`;
  let cur = cleanColor(value), root = null;
  const on = inPalette(cur) ? cur : cur ? 'custom' : null; // (which swatch is picked: a custom colour is none of them)
  let custom = on === 'custom' ? cur : null; // (the custom colour the custom swatch shows: none until one is chosen)
  const html = `<fieldset class="nc-pick" id="${id}">
      <legend>Colour</legend>
      <div class="nc-row">
        <div class="nc-swatches" role="radiogroup" aria-label="Name colour">${NAME_COLORS.map(([c, n]) => `<label class="nc-sw${c ? '' : ' def'}" title="${esc(n)}">
          <input type="radio" name="${id}" value="${c || ''}" aria-label="${esc(n)}" ${c === on ? 'checked' : ''}>
          <span${c ? ` style="--sw:#${c}"` : ''}></span></label>`).join('')}</div>
        <label class="nc-sw nc-custom ${on === 'custom' ? 'on' : ''}" title="Custom colour"><input type="color" value="#${cur || 'ffffff'}" aria-label="Custom colour"></label>
      </div>
      <div class="nc-sample nc-${look}" data-sample></div>
      <div class="nc-note" data-note></div>
    </fieldset>`;
  const refresh = () => {
    if (!root) return;
    const shown = readableColor(cur), name = text() || (look === 'tag' ? 'Name' : 'Label');
    const sample = root.querySelector('[data-sample]');
    sample.innerHTML = look === 'tag' ? `"<bdi>${esc(name)}</bdi>"` : `<bdi>${esc(name)}</bdi>`;
    sample.style.color = shown ? '#' + shown : '';
    root.querySelector('[data-note]').textContent = shown && shown !== cur ? 'Shown lighter where it appears, so it can be read on the dark background.' : '';
  };
  const choose = (c) => {
    cur = c;
    const radio = [...root.querySelectorAll('input[type=radio]')];
    for (const r of radio) r.checked = (r.value || null) === c;
    root.querySelector('.nc-custom').classList.toggle('on', !!c && !inPalette(c));
    refresh();
    onChange?.(cur);
  };
  return {
    html,
    mount(el) {
      root = el.querySelector('#' + id);
      root.querySelectorAll('input[type=radio]').forEach((r) => r.addEventListener('change', () => { if (r.checked) choose(r.value || null); }));
      const box = root.querySelector('input[type=color]');
      box.addEventListener('input', () => { custom = cleanColor(box.value); choose(custom); });
      // (a click opens the chooser, and picks again the custom colour it shows: choosing that same one fires no input)
      box.addEventListener('click', () => { if (custom && custom !== cur) choose(custom); });
      refresh();
    },
    value: () => cur,
    refresh,
  };
}
