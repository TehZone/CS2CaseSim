// Badges: CS2's collectibles (pins, operation and map coins, Pick'Em and Premier coins, Service Medals, trophies, passes,
// veteran coins...) as items, t: 'badge'. scripts/build-badges.mjs builds them into src/data/badges.json, with the four
// Collectible Pins Capsules, and this merges that file into the game data, the same way on the client and on the server
// (as custom.js does custom content). Without the file nothing changes. What a player can do with one: engine/badges.js.
//
// The file: { format, app, badges: { id: def }, cases: [capsule] }. A def is { id, n, ty (its kind: 'Pin', 'Service
// Medal'...), v (what tells apart badges CS2 gives one name: 'Level 3'), r (its rarity's rank: 0 Base Grade, 2 High Grade
// ... 5 Extraordinary), rc, img, desc, p (its price), tr: 1 and box (a capsule's pin, and its capsule's id) }. A capsule is a
// case of kind 'pins' (no key, as CS2's), its pools of badge ids by rarity.
//
// The data lock: badges change what an item is, so a game and a server must have the same ones. D.lock is
// `<the lock without them>+bd.<hash>`, the hash made here from what defines them (ids, names, kinds, variants, rarities, which
// trade and from which capsule, and the capsules' contents). Prices, pictures and descriptions aren't in it: prices reach
// games through the server's price patch. `app` is the version the badges ship in: the live server runs them only once
// that release is published (server/index.mjs badgeGate), so pushing them locks out no game on the release before.

import { stableJson, hash64 } from './custom.js';

export const BD_FORMAT = 1;
export const BD_LOCK = '+bd.';

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const BADGE_KEYS = ['id', 'n', 'ty', 'v', 'r', 'tr', 'box'];
const CASE_KEYS = ['id', 'n', 'kind', 'key', 'pools'];

// Whether a badges.json has anything in it.
export const hasBadges = (b) => !!b && typeof b === 'object' && Object.keys(b.badges || {}).length > 0;

// The badges' part of the lock (16 hex digits), or null without any.
export function badgeLock(b) {
  if (!hasBadges(b)) return null;
  const byId = (x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
  return hash64(stableJson({
    format: b.format ?? BD_FORMAT,
    badges: Object.values(b.badges).sort(byId).map((d) => pick(d, BADGE_KEYS)),
    cases: [...(b.cases || [])].sort(byId).map((c) => pick(c, CASE_KEYS)),
  }));
}
// A lock with these badges (the lock as it is without them: the game data's, with any custom content's part).
export const withBadges = (lock, b) => { const h = badgeLock(b); return h ? lock + BD_LOCK + h : lock; };

// Merges badges into D (initData calls it, after custom content and before its tables are built). New objects and arrays
// throughout: the parsed data passed in is left as it was. A capsule whose id a case already has, or a badge with a broken
// entry, is left out (the build never makes one). Returns what was added.
export function mergeBadges(D, b) {
  D.badges = {};
  D.bd = null;
  const added = { badges: 0, cases: 0 };
  if (!hasBadges(b)) return added;
  const badges = {};
  for (const [id, d] of Object.entries(b.badges)) {
    if (!d || d.id !== id || typeof d.n !== 'string') continue;
    badges[id] = { ...d };
    added.badges++;
  }
  const caseIds = new Set(D.cases.map((c) => c.id)), cases = [...D.cases];
  for (const c of b.cases || []) {
    if (!c?.id || caseIds.has(c.id) || c.kind !== 'pins') continue;
    caseIds.add(c.id);
    const pools = {};
    for (const [k, ids] of Object.entries(c.pools || {})) { const ok = (ids || []).filter((id) => badges[id]); if (ok.length) pools[k] = ok; }
    cases.push({ ...c, pools, key: false, custom: false });
    added.cases++;
  }
  D.badges = badges;
  D.cases = cases;
  D.bd = { format: b.format ?? BD_FORMAT, app: b.app || null, lock: badgeLock(b), ...added };
  D.lock = withBadges(D.lock, b);
  return added;
}
