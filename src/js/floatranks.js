// Float ranks for your own items (see engine/database.js), for the inventory's item cards and the item details: online,
// among every copy on the server (the server works them out: db.ranks); offline, among every copy you and the NPC players
// own (as the Item Database shows them). They arrive a moment after the inventory draws (it draws again when they change).
import { S } from './state.js';
import { online } from './backend.js';
import { net } from './net/online.js';
import { floatRanks, itemKey } from './engine/database.js';
import { worldCopies } from './engine/npcs.js';
import { ownedItems } from './engine/storage.js';

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

let ranks = new Map(), key = '', fetchedAt = 0, pending = null;

// { low?, high?, of, cat } for an item you own, or null.
export const floatRankOf = (uid) => ranks.get(uid) || null;

// Brings them up to date (the server's a few seconds old at most); resolves true when they changed.
export function refreshRanks() {
  const inv = ownedItems(S), k = (online() ? 'on|' : 'off|' + (S.social?.seed || 0) + '|' + Object.values(S.social?.npcs || {}).reduce((t, s) => t + s.inv.length, 0) + '|')
    + inv.length + '|' + (inv[0]?.uid || '') + '|' + (inv[inv.length - 1]?.uid || '');
  if (!online()) {
    if (k === key) return Promise.resolve(false);
    key = k;
    ranks = offlineRanks(inv);
    return Promise.resolve(true);
  }
  if (k === key && Date.now() - fetchedAt < 30000) return Promise.resolve(false);
  if (pending) return pending;
  pending = net.social('db.ranks').then((r) => {
    const next = new Map(Object.entries(r || {}));
    const changed = next.size !== ranks.size || [...next].some(([uid, v]) => JSON.stringify(v) !== JSON.stringify(ranks.get(uid)));
    ranks = next; key = k; fetchedAt = Date.now();
    return changed;
  }).catch(() => false).finally(() => { pending = null; });
  return pending;
}
