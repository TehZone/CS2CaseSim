// Badges as a player has them: CS2's collectibles, items of t: 'badge' (what they are, and the data: badgedata.js). Pure: the
// client, the server and the admin panels share it.
//
// The rules, everywhere:
//   - Every one of CS2's collectibles is in the game, to look at: the Item Database lists them all, and the Index the four
//     Collectible Pins Capsules' pins.
//   - The capsules' pins (def.tr) come from opening a capsule (case.open): the capsules are in the Store (Cases, Pin
//     Capsules) at their market price and need no key. The pins themselves are never sold there. Pins are the only badges
//     that trade, sell, list on the Market, stake and go in Storage Units (like stickers), and keep their serial numbers.
//   - The Service Medals come from prestiging: each prestige (levels.js MEDALS) gives its medal's badge, once (grantMedals
//     below).
//   - Every other badge (coins, trophies, passes, the Genuine operation pins...) nobody can get: staff can give one (the
//     admin panels). A badge that isn't a pin, a Service Medal too, is bound to whoever has it (items.isBound):
//     actions.take() refuses it, so no trade, sale, stake, listing or contract can move it, and storage.storeRefusal keeps it
//     out of Storage Units. Its value is $0: it can't be sold. Nor does it count toward the inventory's limit
//     (items.capCount): nothing but staff can take one out of it.
//
// For a profile (its badges, and the one it features): badgesOf, ownsBadge and featuredBadge below. A featured badge is kept
// by its id (any copy of it will do), and is shown only while the player owns one: in their inventory or a Storage Unit.
// (What they have listed on the Market isn't counted: it's on its way to someone else.)
import { D } from './data.js';
import * as I from './items.js';
import { storedOf } from './storage.js';
import { MEDALS, medalName, prestigesOf } from './levels.js';

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

// ---- Service Medals: what prestiging gives ----------------------------------------------------------------------------
// Each prestige is one of levels.js MEDALS (a year's Service Medal in one of its colours, in the order they're earned), and
// gives that medal's badge: CS2's Service Medal collectible of that year and colour (its variant 'Level <colour>': CS2
// numbers a year's colours in the order of their item ids, as the medal pictures do, scripts/build-extras.mjs), all 69 of
// them, one for each prestige there is. Past the last one (every medal earned: addXp keeps you at 69) there's nothing more
// to give. Each comes once: prof.medalBadges lists the badges given (their ids), so a badge staff took away isn't given
// again, a prestige whose badge came already (medals taken off and earned again) gives none, and no badge is given twice
// even if MEDALS changes (a new year's medal put first moves every prestige onto another medal: each player keeps the
// badges they were given and gets those of the medals they're on now that they haven't had). Given whatever the inventory
// holds: a bound badge doesn't count toward its limit.
export const MEDAL_SRC = 'Prestige';
let medalMap = null;
// The badge ids of MEDALS, in their order (null for one the game data hasn't got: none without badges at all).
export function medalBadgeIds() {
  if (medalMap?.badges === D.badges) return medalMap.ids;
  const by = new Map();
  for (const d of Object.values(D.badges)) if (d.ty === 'Service Medal' && !d.tr) by.set(`${d.n}|${d.v}`, d.id);
  medalMap = { badges: D.badges, ids: MEDALS.map((m) => by.get(`${medalName(m)}|Level ${m.l}`) ?? null) };
  return medalMap.ids;
}
// The badge id of the medal at MEDALS[i] (levels.js medalOf's, for a profile with i + 1 prestiges), or null.
export const medalBadgeId = (i) => (Number.isInteger(i) ? medalBadgeIds()[i] ?? null : null);
// The Service Medal badges a profile has been given for its prestiges: their ids (prof.medalBadges; anything that isn't a
// list of ids is none).
export function medalBadgesGiven(prof) {
  const v = prof?.medalBadges;
  return Array.isArray(v) ? v.filter((id) => typeof id === 'string') : [];
}
// The badges a state is owed for its prestiges (the medal of each it has whose badge it hasn't been given), given now: new
// items at the front of its inventory (the newest medal first), and their ids added to the profile's list. A medal the game
// data hasn't got is passed over (its badge is given once the data has it). Changes `st` (its inv, and its prof as a new
// object); → the items given ([] when nothing was owed). Where it runs: after every prestige (actions.js, as XP is added),
// when a save or account is loaded (state.js, server/store.mjs: prestiges from before), and as staff change the medals
// (admin).
export function grantMedals(st, { now = Date.now() } = {}) {
  if (!st || !Array.isArray(st.inv)) return [];
  const given = medalBadgesGiven(st.prof), had = new Set(given), items = [];
  for (let i = 0, to = prestigesOf(st.prof); i < to; i++) {
    const id = medalBadgeId(i);
    if (!id || had.has(id)) continue;
    had.add(id);
    items.push({ ...I.makeBadgeItem(D.badges[id], MEDAL_SRC), at: now, nw: true });
  }
  if (!items.length) return items;
  st.prof = { ...st.prof, medalBadges: [...given, ...items.map((it) => it.id)] };
  st.inv.unshift(...items.reverse());
  return items;
}
