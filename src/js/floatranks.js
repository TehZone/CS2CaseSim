// Float ranks for your own items (see engine/database.js), for the inventory's item cards and the item details: online,
// among every copy on the server (the server works them out: db.ranks); offline, among your own copies (as the Item
// Database shows them). They arrive a moment after the inventory draws (it draws again when they change).
import { S } from './state.js';
import { online } from './backend.js';
import { net } from './net/online.js';
import { inventoryRanks } from './engine/database.js';

let ranks = new Map(), key = '', fetchedAt = 0, pending = null;

// { low?, high?, of, cat } for an item you own, or null.
export const floatRankOf = (uid) => ranks.get(uid) || null;

// Brings them up to date (the server's a few seconds old at most); resolves true when they changed.
export function refreshRanks() {
  const inv = S.inv, k = (online() ? 'on|' : 'off|') + inv.length + '|' + (inv[0]?.uid || '') + '|' + (inv[inv.length - 1]?.uid || '');
  if (!online()) {
    if (k === key) return Promise.resolve(false);
    key = k;
    ranks = inventoryRanks(inv);
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
