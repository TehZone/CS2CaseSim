// Charm pictures: every charm shows its own pattern's colours on its card, without opening it (see charmlook.js for how
// they're drawn). Made in the page from layers that ship with the game, so nobody needs CS2 installed.
//
// itemImage() is synchronous and its result goes straight into the pages' HTML. A picture made before comes back at once;
// otherwise it hands out a clear stand-in of the same shape that says which charm it stands for, and one observer here
// fills those in as they come into view. Nothing has to know: the wrong colour is never on screen, only nothing for a
// moment, and only the first time that charm and pattern are shown.
import { D } from './engine/data.js';
import { imgUrl } from './util.js';
import { PIC_W, PIC_H, readLayers, readDetail, paintCharm } from './charmlook.js';

// One clear 4:3 picture for them all, the charm in its fragment: a page's images are loaded as they're parsed, and a different
// URL each (a data: URL, say) costs a few milliseconds a card. This way they're one cached image.
const PREFIX = 'img/charm-standin.png#';
const standIn = (id, pat) => `${PREFIX}${id}_${pat}`;
const isStandIn = (im) => im.getAttribute('src')?.startsWith(PREFIX);
const keyOf = (im) => im.getAttribute('src').slice(PREFIX.length);

const KEEP_PICS = 3000, KEEP_LAYERS = 24; // most recently used
const pics = new Map(); // 'id_pat' -> blob URL
const layers = new Map(); // id -> Promise of the charm's layers
let looks = null, lookLoad = null; // data/charm-looks.json: { [id]: look }

function loadLooks() {
  lookLoad ||= fetch('data/charm-looks.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({})).then((j) => { looks = j; });
  return lookLoad;
}

// The picture of a charm item now: its URL, or (until it's made) a stand-in that fillers below replace. `fallback` is
// for a charm with no look: its plain icon.
export function charmPicture(item, fallback) {
  if (!item.pat) return fallback;
  const key = `${item.id}_${item.pat}`, hit = pics.get(key);
  if (hit) return hit;
  if (looks && !looks[item.id]) return fallback;
  watch();
  return standIn(item.id, item.pat);
}

// The same, when it's wanted as an image rather than for a page: waits for it. Null for a charm with no look.
export async function charmPictureReady(item) {
  if (!item.pat) return null;
  await loadLooks();
  return looks[item.id] ? make(`${item.id}_${item.pat}`) : null;
}

// An image's pixels. Decoded off this thread: the biggest sheets would hold up the page for a moment each.
async function pixelsOf(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('no ' + url);
  const im = await createImageBitmap(await r.blob(), { colorSpaceConversion: 'none' });
  const c = document.createElement('canvas');
  c.width = im.width; c.height = im.height;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(im, 0, 0);
  im.close();
  return g.getImageData(0, 0, c.width, c.height);
}
function layersOf(id) {
  if (!layers.has(id)) {
    const look = looks[id];
    const p = Promise.all([pixelsOf(`img/charms/${id}.webp`), look.detail ? pixelsOf(`img/charms/${id}-print.webp`) : null]).then(([sheet, print]) => {
      const layer = readLayers(sheet.data, look);
      if (print) layer.print = readDetail(print.data, print.width, print.height);
      return layer;
    });
    layers.set(id, p);
    p.catch(() => layers.delete(id));
    for (const k of layers.keys()) { if (layers.size <= KEEP_LAYERS) break; layers.delete(k); }
  }
  // Most recently used last.
  const p = layers.get(id);
  layers.delete(id);
  layers.set(id, p);
  return p;
}

// Painting takes a few milliseconds a picture: a slice of each frame at most, so a page full of new charms still scrolls.
const SLICE_MS = 8;
let sliceEnd = 0;
async function turn() {
  while (performance.now() > sliceEnd) {
    await new Promise((r) => setTimeout(r));
    sliceEnd = performance.now() + SLICE_MS;
  }
}

let canvas = null, pen = null, scratch = null;
const making = new Map(); // key -> Promise of its URL
function make(key) {
  if (pics.has(key)) return Promise.resolve(pics.get(key));
  if (!making.has(key)) {
    const cut = key.lastIndexOf('_'), id = key.slice(0, cut), pat = +key.slice(cut + 1);
    const p = (async () => {
      await loadLooks();
      if (!looks[id]) return imgUrl(D.charms[id]?.img, 'm'); // asked for before the looks came: it keeps its icon
      const layer = await layersOf(id);
      await turn();
      if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.width = PIC_W; canvas.height = PIC_H;
        pen = canvas.getContext('2d');
        scratch = pen.createImageData(PIC_W, PIC_H);
      }
      scratch.data.fill(0);
      paintCharm(layer, looks[id], pat, scratch.data, layer.print);
      pen.putImageData(scratch, 0, 0);
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/webp', 0.95));
      const url = URL.createObjectURL(blob);
      pics.set(key, url);
      for (const k of pics.keys()) { if (pics.size <= KEEP_PICS) break; URL.revokeObjectURL(pics.get(k)); pics.delete(k); }
      return url;
    })().finally(() => making.delete(key));
    making.set(key, p);
  }
  return making.get(key);
}

// ---- filling in the stand-ins ------------------------------------------------------------------------------------------
const waiting = new Map(); // key -> Set of <img>s to fill in
const queue = [];
const AT_ONCE = 4; // pictures on their way (encoding one happens off this thread)
let busy = 0, seer = null, watching = false;

async function worker() {
  busy++;
  while (queue.length) {
    const key = queue.shift();
    const fill = (src) => {
      for (const im of waiting.get(key) || []) if (isStandIn(im) && keyOf(im) === key) im.src = src;
      waiting.delete(key);
    };
    try { fill(await make(key)); } catch (e) {
      console.warn('charm picture', key, e);
      fill(imgUrl(D.charms[key.slice(0, key.lastIndexOf('_'))]?.img, 'm')); // its plain icon, rather than nothing
    }
  }
  busy--;
}

function want(im) {
  const key = keyOf(im);
  if (!waiting.has(key)) { waiting.set(key, new Set()); queue.push(key); }
  waiting.get(key).add(im);
  if (busy < AT_ONCE) worker();
}

function found(im) {
  const hit = pics.get(keyOf(im));
  if (hit) im.src = hit; else seer.observe(im);
}
const standIns = (root) => {
  if (root.nodeType !== 1) return;
  if (root.tagName === 'IMG') { if (isStandIn(root)) found(root); return; }
  root.querySelectorAll?.(`img[src^="${PREFIX}"]`).forEach(found);
};

function watch() {
  if (watching || typeof MutationObserver === 'undefined') return;
  watching = true;
  loadLooks();
  // A little ahead of the view, so they're ready as you scroll to them (the pages scroll inside the window: scrollMargin).
  seer = new IntersectionObserver((seen) => {
    for (const e of seen) {
      if (!e.isIntersecting) continue;
      seer.unobserve(e.target);
      if (isStandIn(e.target)) want(e.target);
    }
  }, { rootMargin: '600px', scrollMargin: '600px' });
  new MutationObserver((changes) => {
    for (const c of changes) {
      if (c.type === 'attributes') standIns(c.target);
      else c.addedNodes.forEach(standIns);
    }
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
}
