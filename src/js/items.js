// Client side of items: the shared engine rules plus item images (chicken thumbnails are rendered in 3D).
import { itemDef } from './engine/items.js';
import { renderChickenThumb } from './chicken3d.js';
import { imgUrl } from './util.js';

export * from './engine/items.js';

export function itemImage(item, size = 'm') {
  const d = itemDef(item);
  if (!d) return '';
  if (item.t === 'chicken') return renderChickenThumb(item);
  return imgUrl(d.img, size);
}
