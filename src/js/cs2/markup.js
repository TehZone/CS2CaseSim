// A gun model's own placement data (from its keyvalues, see cs2/service.cjs weaponMarkup): where a charm may hang and
// its sticker slots.
//
// Sticker slots (a souvenir's Team1, Team2, Autograph and Map) are points in a side view of the gun, muzzle left, y down,
// -0.5 to 0.5 across a square around the gun: as wide as the gun plus SLOT_PAD, centred on its length, its top SLOT_TOP
// above the gun's. (Read off CS2's own stickable outlines, drawn in the same view, which this lines up with the models.)
import { cs2WeaponMarkup } from './api.js';

const SLOT_PAD = 3.4, SLOT_TOP = 0.7; // inches
// A slot's Scale is how many sticker widths fit across the view; our sticker sizes are of Steam's icons, a little margin
// around the sticker itself.
const ICON_MARGIN = 1.25;
// A souvenir's stickers in the order they're made (engine/items.js souvenirStickers): the event, the two teams that
// played, the MVP's autograph.
const SOUVENIR_SLOTS = ['Map', 'Team1', 'Team2', 'Autograph'];

// The markup, or null without CS2 (asked once a session).
const failed = new Set();
export async function weaponMarkup(wid) {
  if (!wid || failed.has(wid)) return null;
  try { return await cs2WeaponMarkup(wid); } catch { failed.add(wid); return null; }
}

// Where a slot is on the gun's side view: { x, y } from its muzzle and top as parts of its length and height (a
// sticker's model-space position, `m`), its turn r in degrees and the sticker's width w as a part of the gun's length;
// null if the model hasn't that slot.
function slotPosition(mk, legacy, id) {
  const want = legacy ? 'legacy' : 'hd';
  const b = mk?.bounds?.[want] || mk?.bounds?.hd || mk?.bounds?.legacy;
  const slots = mk?.stickers || [];
  const s = slots.find((x) => x.id === id && (x.legacy ? 'legacy' : 'hd') === want) || slots.find((x) => x.id === id);
  if (!b || !s) return null;
  const L = b.max[0] - b.min[0], H = b.max[2] - b.min[2];
  if (!(L > 0 && H > 0)) return null;
  const S = L + SLOT_PAD, xc = (b.min[0] + b.max[0]) / 2, zc = b.max[2] + SLOT_TOP - S / 2;
  const X = xc - s.offset[0] * S, Z = zc - s.offset[1] * S; // forward and up, in the model's space
  return { x: (b.max[0] - X) / L, y: (b.max[2] - Z) / H, r: (s.rotation * 180) / Math.PI, w: s.scale > 0 ? S / s.scale / L : 0 };
}

// An item's stickers with its souvenir stickers moved into the gun's own slots at CS2's size, as CS2 places them (those
// it can't place keep where they were made). base: a sticker's usual width on this gun (composite.js stickerBase).
export function placeSouvenirStickers(item, mk, base, legacy = false) {
  const sv = (item.stk || []).filter((s) => s.sv);
  if (!mk || !sv.length) return item.stk || [];
  return item.stk.map((s) => {
    if (!s.sv) return s;
    const at = slotPosition(mk, legacy, s.sl || SOUVENIR_SLOTS[sv.indexOf(s)]);
    return at ? { ...s, x: at.x, y: at.y, r: at.r, m: 1, ...(at.w ? { s: (at.w * ICON_MARGIN) / base } : {}) } : s;
  });
}
