// Name Tags and the StatTrak™ Swap Tool, as CS2's. The rules below are its client's own (client.dll and panorama): which
// items take a name and what a name may be, and the check that lets two items swap counters. Pure: the client, the server
// and the admin panels share it. The actions themselves are in actions.js (tools.*), the items in items.js (TOOLS).
//
// A name is the item's `name` and travels with it (trades, Storage Units, saves), adding nothing to its value. Its counter
// is `kills`, which only play.stattrak and a swap change.
import * as I from './items.js';

export const NAME_MAX = 20; // (popup_capability_nameable.js: SetMaxChars(20))
export const MAX_KILLS = 999999; // (the counter's six digits)
export const BAD_NAME = 'Please provide a valid name.'; // tooltip_nameable_invalid

// items_game's `nameable`: every gun, knife and the Zeus, of any quality. Not gloves or agents (their `wearable` prefab turns
// it off), nor charms, stickers, cases and the like. (CS2 also names Storage Units through this window, and C4 and pets,
// which aren't items here.)
export const nameable = (item) => item.t === 'skin' && !!I.itemDef(item) && I.itemDef(item).cat !== 'gloves';

// Words nobody gets to show other players, as a username or an item's name. They're looked for in the text as a person
// reads it (asRead), which stops the easy ways round them; no list stops them all, so staff can still clear a name.
const RESERVED = ['admin', 'moderator', 'server', 'system', 'valve', 'bot'];
const RUDE = /(fuck|shit|cunt|nigg|fag|rape|hitler|nazi)/;
// Other alphabets' letters drawn like a Latin one, and the digits and signs written for one.
const LOOKS_LIKE = new Map(Object.entries({
  a: 'аαɑ@4', b: 'вβ8', c: 'сϲς', d: 'ԁ', e: 'еε3', f: 'ғϝ', g: 'ɡ69', h: 'һн', i: 'іιɩı1!|', k: 'кκ', l: 'ӏ', m: 'м', n: 'пη',
  o: 'оοօ0', p: 'рρ', s: 'ѕ$5', t: 'тτ7', u: 'սυμу', v: 'νѵ', z: 'ᴢ2',
}).flatMap(([letter, like]) => [...like].map((c) => [c, letter])));
// A text as it reads: one width, no accents, no invisible characters (the blank letters too), Latin letters for lookalikes.
// Any sign between letters goes. Words stay apart ("push it" isn't a rude word), but letters spaced out one by one are read
// as the word they spell.
function asRead(text) {
  const s = [...String(text).normalize('NFKD').replace(/[\p{M}\p{Cf}\p{DI}]/gu, '').toLowerCase()].map((c) => LOOKS_LIKE.get(c) ?? c).join('');
  return s.replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/(?<![\p{L}\p{N}])([\p{L}\p{N}])[\s_-]+(?=[\p{L}\p{N}])/gu, '$1').replace(/^[\s_-]+|[\s_-]+$/g, '').replaceAll('-', '_');
}
export function refusedWord(text) {
  const s = asRead(text);
  return RESERVED.some((w) => s === w || s.startsWith(w + '_')) || RUDE.test(s);
}

// Why a text can't be a name ('' if it can). CS2's SetNameToolString: 1 to 20 UTF-16 units (JS's .length: an emoji is 2), no
// space at either end, no control characters; everything else goes, < > and quotes too, so wherever a name is shown it's
// through esc(). Three things are refused here that CS2 lets through: broken text, which the online server's database can't
// store, the characters that reorder or break the text around them (a name is seen by other players, next to other text),
// and a name with nothing to see in it.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const REORDERS = /[\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/;
const BLANK = /^[\p{M}\p{Cf}\p{DI}\p{Z}\u2800]*$/u;
export function nameProblem(name) {
  if (typeof name !== 'string' || !name.length) return 'Enter a name first';
  if (name.length > NAME_MAX) return `A name is at most ${NAME_MAX} characters`;
  if (name[0] === ' ' || name.at(-1) === ' ' || CONTROL.test(name) || REORDERS.test(name) || !name.isWellFormed() || BLANK.test(name)) return BAD_NAME;
  return refusedWord(name) ? 'Please pick another name' : '';
}

// Why these two can't swap counters ('' if they can): CS2's check, which is the same item (or any two knives), both
// StatTrak™, and two different counts. An AK swaps with an AK only: an M4A4 doesn't with an M4A1-S, nor a USP-S with a P2000,
// but a Karambit does with a Bayonet. Souvenirs have no counter. (Vanilla knives' ids aren't weapon_*, hence cat for those.)
export function swapRefusal(a, b) {
  if (!a || !b) return 'Pick two items';
  if (a.uid === b.uid) return 'Pick two different items';
  for (const it of [a, b]) if (it.t !== 'skin' || !it.stt) return `${I.itemName(it)} isn't StatTrak™`;
  const da = I.itemDef(a), db = I.itemDef(b);
  if (!da || !db || !((da.cat === 'knife' && db.cat === 'knife') || da.wid === db.wid)) return 'StatTrak™ values can only be swapped between two of the same item type';
  return (a.kills || 0) === (b.kills || 0) ? 'Both have the same StatTrak™ value' : '';
}

// What a trader's offer is holding of yours, offline (the server knows its own, see ctx.reserved and ctx.asked): items that
// can't be changed or used until you've answered it.
export function heldByTraders(st, now = Date.now()) {
  return new Set((st.social?.offers || []).filter((o) => o.status === 'open' && now <= o.exp).flatMap((o) => o.want.uids));
}
