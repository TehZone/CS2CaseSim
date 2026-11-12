// Custom content: the developer's own skins, knives, gloves and cases (CUSTOM_CONTENT.md). scripts/build-custom.mjs builds
// the packs in custom/ into src/data/custom.json (and their pictures and textures into src/custom/), and this merges that
// file into the game data, the same way on the client and on the server. Without the file nothing changes.
//
// A custom item has the shape of a real one, so everything that reads D handles it, plus `cx: 1` (not `custom`, which
// already means the game's own boxes: no Steam picture, no market price). Ids come from the item's name (or its `key`),
// prefixed so they can never be a real item's: skin-cx-…, crate-cx-…, collection-cx-… (real ids are hex or digits).
//
// The data lock: the game and the server refuse each other unless their data is the same. It's D.lock: the game data's
// own generatedAt exactly while there's no custom content (so a game from before custom content still connects), and
// `<generatedAt>+cx.<hash>` with some, the hash made here from what defines the custom items (their ids, names, weapons,
// rarities, float ranges, StatTrak, phases, the Fade rule, collections and what each case holds). Prices, pictures and textures aren't
// in it: prices reach games through the server's price patch, and the looks don't change what an item is.
// D.generatedAt itself is never changed.

export const CX_FORMAT = 1;
export const CX_LOCK = '+cx.';

// JSON with every object's keys sorted, so the same content always hashes the same.
export function stableJson(v) {
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
  return JSON.stringify(v ?? null);
}

// 64 bits of hash (two 32-bit lanes, cyrb53's mixing) as 16 hex digits. Not a secret: it only has to differ when the
// content does.
export function hash64(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
// (Every field the engine goes by: `pr`, the Fade rule, sets values and the Market's prices. What's left out is only shown:
// pictures, rarity colours and names, the style's name, credits, kits.)
const SKIN_KEYS = ['id', 'n', 'wid', 'cat', 'r', 'mn', 'mx', 'stt', 'star', 'ph', 'pw', 'pr', 'col'];
const CASE_KEYS = ['id', 'n', 'kind', 'key', 'pools', 'rare', 'col', 'levelDrops'];
const COL_KEYS = ['id', 'n', 'tiers', 'caseId'];

// Whether a custom.json has anything in it.
export function hasCustom(custom) {
  return !!custom && typeof custom === 'object'
    && (Object.keys(custom.skins || {}).length > 0 || (custom.cases || []).length > 0 || (custom.collections || []).length > 0);
}

// The custom part of the lock (16 hex digits), or null with no custom content.
export function customLock(custom) {
  if (!hasCustom(custom)) return null;
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return hash64(stableJson({
    format: custom.format ?? CX_FORMAT,
    skins: Object.values(custom.skins || {}).sort(byId).map((s) => pick(s, SKIN_KEYS)),
    cases: [...(custom.cases || [])].sort(byId).map((c) => pick(c, CASE_KEYS)),
    collections: [...(custom.collections || [])].sort(byId).map((c) => pick(c, COL_KEYS)),
  }));
}

// A hash of custom items' own prices (each skin's per wear, each case's), or null without custom content. They're outside
// the lock, so the server's price patch is what brings a new one to games: the server says the patch is new
// (server/index.mjs) when this differs from the one its saved patch was made with.
export function customPriceHash(D) {
  const skins = Object.values(D.skins || {}).filter((s) => s?.cx).map((s) => [s.id, s.p]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const cases = (D.cases || []).filter((c) => c?.cx).map((c) => [c.id, c.price]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return skins.length || cases.length ? hash64(stableJson({ skins, cases })) : null;
}

// The data lock for game data with this custom content (see the top).
export const dataLock = (generatedAt, custom) => {
  const h = customLock(custom);
  return h ? generatedAt + CX_LOCK + h : generatedAt;
};
// The game data build a lock is for (a price patch's ids are that build's, whatever custom content or badges came with it:
// every part after the build's own generatedAt starts with a +, see badgedata.js).
export const lockBase = (lock) => String(lock ?? '').split('+')[0];

// Merges custom content into D (called by initData, before its tables are built). New objects and arrays throughout: the
// parsed game data passed to initData is left as it was. A custom entry whose id a real item has is left out (the build
// script never makes one). Returns what was added.
export function mergeCustom(D, custom) {
  const added = { skins: 0, cases: 0, collections: 0 };
  if (!hasCustom(custom)) return added;
  const skins = { ...D.skins };
  for (const [id, s] of Object.entries(custom.skins || {})) {
    if (Object.hasOwn(skins, id) || !s || s.id !== id) continue;
    skins[id] = { ...s, cx: 1 };
    added.skins++;
  }
  const caseIds = new Set(D.cases.map((c) => c.id)), colIds = new Set(D.collections.map((c) => c.id));
  const cases = [...D.cases], collections = [...D.collections];
  for (const c of custom.cases || []) {
    if (!c?.id || caseIds.has(c.id)) continue;
    caseIds.add(c.id);
    cases.push({ ...c, custom: false, cx: 1 });
    added.cases++;
  }
  for (const c of custom.collections || []) {
    if (!c?.id || colIds.has(c.id)) continue;
    colIds.add(c.id);
    collections.push({ ...c, cx: 1 });
    added.collections++;
  }
  D.skins = skins;
  D.cases = cases;
  D.collections = collections;
  D.cx = { format: custom.format ?? CX_FORMAT, lock: customLock(custom), ...added };
  D.lock = dataLock(D.generatedAt, custom);
  return added;
}

// Is this definition custom content?
export const isCustom = (def) => !!def?.cx;
