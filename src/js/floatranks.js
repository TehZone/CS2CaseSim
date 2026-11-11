// Float ranks for your own items (see engine/database.js), for the inventory's item cards and the item details: online,
// among every copy on the server (the server works them out: db.ranks); offline, among every copy you and the NPC players
// own (as the Item Database shows them). They arrive a moment after the inventory draws (it draws again when they change).
// Online they're asked for at most every RANKS_GAP, and not while auto open runs: a change meanwhile is asked about when the
// time comes or it stops, and 'ranks' (state.js's events) says when that answer changed them.
import { S, emit, calmly, isAutoOpening } from './state.js';
import { online } from './backend.js';
import { net } from './net/online.js';
import { floatRanks, itemKey } from './engine/database.js';
import { crowd, inventoryOf, worldCopies } from './engine/npcs.js';
import { ownedItems } from './engine/storage.js';
import { storedCount } from './stored.js';

// Your skins' ranks among everyone's copies of the same item (offline). Worked out again only where something changed: the
// NPC players' copies are grouped by item once for as long as what they own stays the same, and an item's ranks are kept
// while your copies of it and theirs are the same. (A drop or a sale changes one or two items' ranks, not the thousands of
// others a big inventory has: every one of them over again took a long moment after each opening.)
let world = { sig: null, byItem: new Map() };
const kept = new Map(); // item key -> { sig (your copies), ranks: [[uid, rank]] }
// (What can change in the NPC world: the people the save has dealt with. The others own what they started with.)
const worldSig = (so) => (so ? so.seed + '|' + Object.entries(so.npcs || {}).map(([id, s]) => id + ':' + s.inv.map((it) => it.uid).join(',')).join(';') : '');
const copySig = (list) => list.map((it) => `${it.uid}:${it.fl}:${it.at || 0}:${it.stt ? 1 : 0}${it.sv ? 1 : 0}`).join(',');
function offlineRanks(inv) {
  const mine = new Map(), out = new Map();
  for (const it of inv) if (it.t === 'skin' && it.fl != null) { const k = itemKey(it); if (!mine.has(k)) mine.set(k, []); mine.get(k).push(it); }
  if (!mine.size) return out;
  const sig = worldSig(S.social);
  if (sig !== world.sig) {
    world = { sig, byItem: new Map() };
    kept.clear();
    for (const c of worldCopies(S.social)) { const k = itemKey(c.item); if (!world.byItem.has(k)) world.byItem.set(k, []); world.byItem.get(k).push(c.item); }
  }
  for (const k of kept.keys()) if (!mine.has(k)) kept.delete(k);
  for (const [k, list] of mine) {
    const s = copySig(list);
    let c = kept.get(k);
    if (!c || c.sig !== s) {
      const own = new Set(list.map((it) => it.uid));
      c = { sig: s, ranks: [...floatRanks([...list, ...(world.byItem.get(k) || [])])].filter(([uid]) => own.has(uid)) };
      kept.set(k, c);
    }
    for (const [uid, r] of c.ranks) out.set(uid, r);
  }
  return out;
}

// What the 2,000 NPC players own, which the ranks need (npcs.js works it out once a session; main.js warmNpcs does it while the
// app is idle, which an auto open's reels leave little of). Not ready yet: worked out here a slice at a time, the frames going
// on between, instead of the best part of a second at once in the middle of drawing the inventory. → null (ready now) or a
// promise for when it is.
const SLICE_MS = 8;
let warming = null;
function worldReady(so) {
  if (!so || world.sig === worldSig(so)) return null;
  const people = crowd(so.seed);
  let i = 0;
  const step = () => { const t = performance.now(); while (i < people.length && performance.now() - t < SLICE_MS) inventoryOf(so, people[i++]); return i >= people.length; };
  if (warming?.so === so) return warming.p;
  if (step()) return null; // (all of it worked out already: what's left is quick)
  const p = new Promise((done) => {
    const more = () => { if (S.social !== so || step()) { if (warming?.p === p) warming = null; done(); } else setTimeout(more, 0); };
    setTimeout(more, 0);
  });
  warming = { so, p };
  return p;
}

let ranks = new Map(), key = '', fetchedAt = 0, askedAt = -Infinity, pending = null;
export const RANKS_GAP = 15000;
// (the request that had to wait: its answer is announced, as no page is waiting for it)
const later = calmly(() => refreshRanks().then((changed) => { if (changed) emit('ranks'); }), RANKS_GAP);

// { low?, high?, of, cat } for an item you own, or null.
export const floatRankOf = (uid) => ranks.get(uid) || null;

// Brings them up to date (the server's a few seconds old at most); resolves true when they changed. Offline they're ready when
// this returns, unless what the NPC players own is still being worked out: then the promise is marked `later` (and resolves
// once they're worked out), as online, where they always come later.
export function refreshRanks() {
  // (Online the server's answer covers what's in your Storage Units, so they count by their number: a unit's contents
  // arriving (stored.js) changes nothing to ask about.)
  const inv = online() ? S.inv : ownedItems(S);
  const k = online() ? `on|${inv.length + storedCount()}|${inv[0]?.uid || ''}|${inv[inv.length - 1]?.uid || ''}`
    : 'off|' + (S.social?.seed || 0) + '|' + Object.values(S.social?.npcs || {}).reduce((t, s) => t + s.inv.length, 0) + '|'
      + inv.length + '|' + (inv[0]?.uid || '') + '|' + (inv[inv.length - 1]?.uid || '');
  if (!online()) {
    if (k === key) return Promise.resolve(false);
    const wait = inv.some((it) => it.t === 'skin' && it.fl != null) ? worldReady(S.social) : null; // (no skin of yours: nothing to rank)
    if (wait) { const p = wait.then(() => (online() ? false : refreshRanks())); p.later = true; return p; }
    key = k;
    ranks = offlineRanks(inv);
    return Promise.resolve(true);
  }
  if (k === key && Date.now() - fetchedAt < 30000) return Promise.resolve(false);
  if (pending) return pending;
  if (isAutoOpening() || Date.now() - askedAt < RANKS_GAP) { later.ask(); return Promise.resolve(false); }
  askedAt = Date.now();
  later.ran();
  pending = net.social('db.ranks').then((r) => {
    const next = new Map(Object.entries(r || {}));
    const changed = next.size !== ranks.size || [...next].some(([uid, v]) => JSON.stringify(v) !== JSON.stringify(ranks.get(uid)));
    ranks = next; key = k; fetchedAt = Date.now();
    return changed;
  }).catch(() => false).finally(() => { pending = null; });
  return pending;
}
