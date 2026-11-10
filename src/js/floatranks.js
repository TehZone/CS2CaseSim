// Float ranks for your own items (see engine/database.js), for the inventory's item cards and the item details: online,
// among every copy on the server (the server works them out: db.ranks); offline, among every copy you and the NPC players
// own (as the Item Database shows them). They arrive a moment after the inventory draws (it draws again when they change).
// Online they're asked for at most every RANKS_GAP, and not while auto open runs: a change meanwhile is asked about when the
// time comes or it stops, and 'ranks' (state.js's events) says when that answer changed them.
import { S, emit, calmly, isAutoOpening } from './state.js';
import { online } from './backend.js';
import { net } from './net/online.js';
import { floatRanks, itemKey } from './engine/database.js';
import { worldCopies } from './engine/npcs.js';
import { ownedItems } from './engine/storage.js';
import { storedCount } from './stored.js';

// Your skins' ranks among everyone's copies of the same item (offline).
function offlineRanks(inv) {
  const mine = new Map(), out = new Map();
  for (const it of inv) if (it.t === 'skin' && it.fl != null) { const k = itemKey(it); if (!mine.has(k)) mine.set(k, []); mine.get(k).push(it); }
  if (!mine.size) return out;
  const theirs = new Map();
  for (const c of worldCopies(S.social)) { const k = itemKey(c.item); if (mine.has(k)) { if (!theirs.has(k)) theirs.set(k, []); theirs.get(k).push(c.item); } }
  for (const [k, list] of mine) {
    const own = new Set(list.map((it) => it.uid));
    for (const [uid, r] of floatRanks([...list, ...(theirs.get(k) || [])])) if (own.has(uid)) out.set(uid, r);
  }
  return out;
}

let ranks = new Map(), key = '', fetchedAt = 0, askedAt = -Infinity, pending = null;
export const RANKS_GAP = 15000;
// (the request that had to wait: its answer is announced, as no page is waiting for it)
const later = calmly(() => refreshRanks().then((changed) => { if (changed) emit('ranks'); }), RANKS_GAP);

// { low?, high?, of, cat } for an item you own, or null.
export const floatRankOf = (uid) => ranks.get(uid) || null;

// Brings them up to date (the server's a few seconds old at most); resolves true when they changed.
export function refreshRanks() {
  // (Online the server's answer covers what's in your Storage Units, so they count by their number: a unit's contents
  // arriving (stored.js) changes nothing to ask about.)
  const inv = online() ? S.inv : ownedItems(S);
  const k = online() ? `on|${inv.length + storedCount()}|${inv[0]?.uid || ''}|${inv[inv.length - 1]?.uid || ''}`
    : 'off|' + (S.social?.seed || 0) + '|' + Object.values(S.social?.npcs || {}).reduce((t, s) => t + s.inv.length, 0) + '|'
      + inv.length + '|' + (inv[0]?.uid || '') + '|' + (inv[inv.length - 1]?.uid || '');
  if (!online()) {
    if (k === key) return Promise.resolve(false);
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
