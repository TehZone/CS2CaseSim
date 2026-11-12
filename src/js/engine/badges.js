// Badges as a player has them: CS2's collectibles, items of t: 'badge' (what they are, and the data: badgedata.js). Pure: the
// client, the server and the admin panels share it.
//
// The rules, everywhere:
//   - Every one of CS2's collectibles is in the game, to look at: the Item Database lists them all, and the Index the four
//     Collectible Pins Capsules' pins.
//   - The only ones a player can get are the capsules' pins (def.tr), by opening a capsule (case.open): the capsules are in
//     the Store (Cases, Pin Capsules) at their market price and need no key. The pins themselves are never sold there. Pins
//     trade, sell, list on the Market, stake and go in Storage Units like stickers, and keep their serial numbers.
//   - Every other badge (Service Medals, coins, trophies, passes, the Genuine operation pins...) nobody can get: staff can
//     give one (the admin panels). Such a badge is bound to whoever has it (items.isBound): actions.take() refuses it, so no
//     trade, sale, stake, listing or contract can move it, and storage.storeRefusal keeps it out of Storage Units. Its value
//     is $0: it can't be sold.
//
// For a profile (its badges, and the one it features): badgesOf, ownsBadge and featuredBadge below. A featured badge is kept
// by its id (any copy of it will do), and is shown only while the player owns one: in their inventory or a Storage Unit.
// (What they have listed on the Market isn't counted: it's on its way to someone else.)
import { D } from './data.js';
import * as I from './items.js';
import { storedOf } from './storage.js';

export const isBadge = I.isBadge;
export const isBound = I.isBound;
// A badge's definition by its id, or null.
export const badgeDef = (id) => (typeof id === 'string' && Object.hasOwn(D.badges, id) ? D.badges[id] : null);
// A capsule's pin: the only badges a player can get, and the only ones that trade.
export const isPin = (def) => !!def?.tr;
export const allBadges = () => Object.values(D.badges);
// The Collectible Pins Capsules (cases of kind 'pins').
export const pinCapsules = () => D.cases.filter((c) => c.kind === 'pins');
// An item to show for a badge id (its picture, name and rarity through items.js), or null.
export const badgeItem = (id) => (badgeDef(id) ? { t: 'badge', id } : null);

// Rarest first, then by name.
const order = (a, b) => (b.def.r - a.def.r) || I.itemName({ t: 'badge', id: a.id }).localeCompare(I.itemName({ t: 'badge', id: b.id }));
// The badges someone has: [{ id, def, n (copies), uids }], rarest first. `st` is a state ({ inv, stored }), or anything with
// an inventory (an NPC's state, { inv }). Badges the game no longer has are left out.
export function badgesOf(st) {
  const by = new Map();
  for (const it of [...(st?.inv || []), ...storedOf(st || {})]) {
    if (it?.t !== 'badge') continue;
    const def = badgeDef(it.id);
    if (!def) continue;
    let e = by.get(it.id);
    if (!e) by.set(it.id, (e = { id: it.id, def, n: 0, uids: [] }));
    e.n++;
    e.uids.push(it.uid);
  }
  return [...by.values()].sort(order);
}
// Whether they have one of this badge (inventory or Storage Units).
export function ownsBadge(st, id) {
  if (!badgeDef(id)) return false;
  return (st?.inv || []).some((it) => it?.t === 'badge' && it.id === id) || storedOf(st || {}).some((it) => it?.t === 'badge' && it.id === id);
}
// A featured badge as a profile keeps it: the id when it's a badge they own, else null (none, or one they no longer have).
// What a request asks to feature goes through this, and so does what a profile shows: a badge traded away stops showing.
export const featuredBadge = (st, id) => (id != null && ownsBadge(st, String(id)) ? String(id) : null);
