// A gun model's own placement data (from its keyvalues, see cs2/service.cjs weaponMarkup): where a charm may hang and
// its sticker slots.
//
// A sticker slot is a place in the gun's sticker space: the model's second UV set, a flat view of the gun in which
// everything a sticker can't reach has a u of -1 or less. CS2's weapon shader draws a sticker wherever that space falls
// inside the slot, so the model holds the projection and slotUv is all the maths there is.
import { cs2WeaponMarkup } from './api.js';
import { SOUVENIR_ICONS } from './souvenir-icons.js';

// A souvenir's stickers in the order they're made (engine/items.js souvenirStickers): the event, the two teams that
// played, the MVP's autograph. CS2 fills these slots by name on the souvenirs it makes now, with a map's coin in Map:
// the event takes that one here. (Its older souvenirs had theirs shuffled across the slots, so no slot is theirs.)
const SOUVENIR_SLOTS = ['Map', 'Team1', 'Team2', 'Autograph'];

// The markup, or null without CS2 (asked once a session).
const failed = new Set();
export async function weaponMarkup(wid) {
  if (!wid || failed.has(wid)) return null;
  try { return await cs2WeaponMarkup(wid); } catch { failed.add(wid); return null; }
}

// Where a point of the sticker space (u, v) is on a sticker in a slot, as the weapon shader has it: 0 to 1 across the
// sticker, v down it. Past those it's off the sticker. A slot's rotation is in turns.
export function slotUv(slot, u, v) {
  const x = (u - 0.5 - slot.offset[0]) * slot.scale, y = (v - 0.5 - slot.offset[1]) * slot.scale;
  const turn = slot.rotation * 2 * Math.PI, c = Math.cos(turn), s = Math.sin(turn);
  return [x * c - y * s + 0.5, x * s + y * c + 0.5];
}

// An item's stickers with the gun's slot for each souvenir one (`slot`), on the body being drawn. One the gun has no slot
// for is left as it was made.
export function souvenirSlots(item, mk, legacy = false) {
  const stk = item.stk || [], sv = stk.filter((s) => s.sv);
  return stk.map((s) => {
    const all = s.sv ? (mk?.stickers || []).filter((x) => x.id === SOUVENIR_SLOTS[sv.indexOf(s)] && x.scale > 0) : [];
    const slot = all.find((x) => x.legacy === legacy) || all[0];
    return slot ? { ...s, slot } : s;
  });
}

// An item's stickers on its icon, the souvenir ones in the gun's slots: each with `at`, where that slot is on this picture
// in widths of it (see scripts/build-souvenir-icons.mjs), left out if the icon can't show the slot. A gun without slots
// keeps them where they were made. box: the icon's outline, as parts of a W by H picture. Steam's icons are 512 wide at
// most, and its bigger pictures are one in a wider margin, so the outline is what places them, and its size says which
// of the gun's bodies this is.
export function souvenirsOnIcon(item, wid, box, W, H) {
  const views = SOUVENIR_ICONS[wid], stk = item.stk || [], sv = stk.filter((s) => s.sv);
  if (!views) return stk;
  const icon = Math.min(W, 512), wide = ((box.x1 - box.x0) * W) / icon, high = ((box.y1 - box.y0) * H) / icon;
  const off = ({ box: b }) => Math.abs(b[1] - b[0] - wide) + Math.abs(b[3] - b[2] - high);
  const view = views.reduce((a, b) => (off(b) < off(a) ? b : a)), k = icon / W;
  const move = ([x, y, ...sides]) => [box.x0 + (x - view.box[0]) * k, (box.y0 * H) / W + (y - view.box[2]) * k, ...sides.map((v) => v * k)];
  return stk.flatMap((s) => {
    if (!s.sv) return [s];
    const at = view.slots[SOUVENIR_SLOTS[sv.indexOf(s)]];
    return at ? [{ ...s, at: move(at) }] : [];
  });
}
