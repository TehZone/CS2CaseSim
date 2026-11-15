// Colours for the names players give: a Storage Unit's label and a Name Tag's name. An item keeps its colour in `nc`, six
// lowercase hex digits with no '#' ('ff5c5c'); an item without one has the default look. The colour goes with the name:
// a unit's is changed with its label (storage.name, free), a Name Tag's is part of the tag (tools.name: a new colour is a
// new tag, as a new name is) and goes when the tag is removed (tools.unname). Pure: the client, the server and the admin
// panels share it.
//
// Any colour is taken (cleanColor is the only check, and every action and a save file go through it), and how it's drawn
// keeps it readable: readableColor lightens one too dark to read on the game's dark panels, so a name never disappears.
// Games from before colours (1.1.8) don't know `nc`: they show those names in the default look, and leave the colour as it
// is when they change a unit's label.

// The picker's colours, as [hex, name]: each reads well on the dark UI as it is (readableColor leaves them alone), and each
// looks unlike the default look, the first, with no colour (so no white: the default is nearly white already, and a tag in a
// colour that looks the same would be a tag for nothing). (CS2's rarity colours, lightened where they'd be too dark for
// small text.)
export const NAME_COLORS = [
  [null, 'Default'],
  ['b0c3d9', 'Silver'],
  ['ffe566', 'Yellow'],
  ['e4ae39', 'Gold'],
  ['ff9a3c', 'Orange'],
  ['ff5c5c', 'Red'],
  ['ff8fc7', 'Pink'],
  ['e55cf0', 'Magenta'],
  ['a67cff', 'Purple'],
  ['6f87ff', 'Blue'],
  ['5cd6ff', 'Sky blue'],
  ['4fe0b4', 'Teal'],
  ['8ad064', 'Green'],
  ['c6f04f', 'Lime'],
];

// A colour as an item keeps it ('ff5c5c'), or null if it isn't one. '#FF5C5C' and ' ff5c5c ' are the same colour; three
// digits, names, rgb() and anything else aren't colours here.
export function cleanColor(v) {
  if (typeof v !== 'string' || v.length > 16) return null;
  const s = v.trim().replace(/^#/, '').toLowerCase();
  return /^[0-9a-f]{6}$/.test(s) ? s : null;
}

// What an action takes as a colour: null, '' or nothing for the default look; else a colour cleanColor takes. → the colour
// (null: the default), or undefined when it's no colour at all (the action refuses it).
export function colorArg(v) {
  if (v == null || v === '' || v === false) return null;
  return cleanColor(v) ?? undefined;
}

// ---- readable --------------------------------------------------------------------------------------------------------
// The panel names are drawn on (style.css --panel), and how far from it a name's colour has to stand: a contrast of 4.5:1
// (WCAG AA's for text, between relative luminances), so a lightened name still reads on the lighter surfaces names sit on
// too (a hovered tile, a toast, a tooltip: about 3.5:1 there). Pure blue (#0000ff) is 1.9:1 on the panel, near black far
// less, red (#ff0000) 4:1; the palette's darkest, Blue (6f87ff), is 5:1.
const PANEL = '1c2229', MIN_CONTRAST = 4.5;
const channels = (hex) => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
const linear = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
export const luminance = (hex) => { const [r, g, b] = channels(hex).map(linear); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const hex2 = (n) => Math.round(n).toString(16).padStart(2, '0');
const towardWhite = (rgb, t) => rgb.map((c) => hex2(c + (255 - c) * t)).join('');

// The colour a name is drawn in: the colour as it is when it reads well on the dark UI, else the least lightened (mixed with
// white) that does, so it keeps its hue. → six hex digits, or null when it isn't a colour.
const readable = new Map();
export function readableColor(v) {
  const c = cleanColor(v);
  if (!c) return null;
  let out = readable.get(c);
  if (out) return out;
  if (contrast(c, PANEL) >= MIN_CONTRAST) out = c;
  else {
    const rgb = channels(c);
    let lo = 0, hi = 1;
    for (let i = 0; i < 16; i++) { const t = (lo + hi) / 2; if (contrast(towardWhite(rgb, t), PANEL) >= MIN_CONTRAST) hi = t; else lo = t; }
    out = towardWhite(rgb, hi);
  }
  if (readable.size > 500) readable.clear();
  readable.set(c, out);
  return out;
}
