// Client side of items: the shared engine rules plus item images (chicken thumbnails are rendered in 3D).
import { itemDef } from './engine/items.js';
import { D } from './engine/data.js';
import { renderChickenThumb } from './chicken3d.js';
import { imgUrl, loadImage } from './util.js';

export * from './engine/items.js';

export function itemImage(item, size = 'm') {
  const d = itemDef(item);
  if (!d) return '';
  if (item.t === 'chicken') return renderChickenThumb(item);
  if (item.t === 'crate' && d.custom) return crateImage(d, size);
  if (d.slab) return slabImage(d, size);
  return imgUrl(d.img, size);
}

// A Sticker Slab's picture: its sticker cropped to the artwork (Steam's sticker icons are mostly margin), filling the case
// the page draws around it (.slab). Made once per sticker; until then the plain icon, swapped for it when it's ready (the
// <img> carries data-sk).
const slabPics = new Map();
function slabImage(d, size) {
  const raw = imgUrl(d.img, size), hit = slabPics.get(d.sk);
  if (hit) return typeof hit === 'string' ? hit : raw;
  slabPics.set(d.sk, loadImage(imgUrl(d.img, 'l')).then((im) => {
    const W = im.naturalWidth, H = im.naturalHeight, c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(im, 0, 0);
    const a = g.getImageData(0, 0, W, H).data;
    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) if (a[(y * W + x) * 4 + 3] > 20) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    if (x1 <= x0) throw new Error('empty sticker');
    const m = Math.round(Math.max(x1 - x0, y1 - y0) * 0.04);
    const out = document.createElement('canvas');
    out.width = x1 - x0 + 2 * m; out.height = y1 - y0 + 2 * m;
    out.getContext('2d').drawImage(c, x0 - m, y0 - m, out.width, out.height, 0, 0, out.width, out.height);
    const url = out.toDataURL('image/png');
    slabPics.set(d.sk, url);
    document.querySelectorAll(`img[data-sk="${CSS.escape(d.sk)}"]`).forEach((el) => { el.src = url; });
  }).catch(() => slabPics.set(d.sk, raw)));
  return raw;
}

// The game's own boxes (the Agent Locker, the Chicken Coop Crate) have no Steam picture: their best item stands in, as on
// the Cases page.
function crateImage(c, size) {
  if (c.kind === 'chickens') return renderChickenThumb({ id: 'golden', hat: 'crown' });
  const master = Object.values(D.agents).filter((a) => a.r === 5).sort((a, b) => b.p - a.p)[0];
  return imgUrl(master?.img, size);
}
