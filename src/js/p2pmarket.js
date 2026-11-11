// The Market's data for the game's pages (no DOM): the same requests whichever mode you're in. Online they go to the server
// (net.p2p, server/p2pmarket.mjs) and the listings' changes come pushed while a page watches; offline they're the NPC
// traders' listings and your own, worked out here with the engine's searches (engine/p2p.js), and what you do runs as the
// save's own actions (backend.js act). A listing: { lid, item, price, at, seller: { id, name } | { npc, name, type } | { me } }.
import { S, on } from './state.js';
import { act, online } from './backend.js';
import { net } from './net/online.js';
import * as P from './engine/p2p.js';
import { listedOf } from './engine/storage.js';

const OFFLINE_KEEP_MS = 30 * 1000; // (the traders' listings, worked out again at most this often while nothing changes)
let memo = null; // { so, at, list } the traders' listings

// Whether there's a Market where you play now: always offline; online, a server whose welcome named p2p1.
export const available = () => !online() || net.hasMarket();
// Whether the server's admin panel has it closed now (trading or the Market switched off): its answers and pushes say so.
// Offline it's always open.
let closed = false;
export const isClosed = () => online() && closed;
const noteOpen = (r) => { if (r && typeof r.open === 'boolean') closed = !r.open; return r; };
const noteOff = (e) => { if (e?.code === 'off') closed = true; throw e; };

// Your own listings as listings (from your state: online the server's copy of it).
export function myListings() {
  const name = online() ? net.me()?.name || 'You' : S.social?.me?.name || 'You';
  return listedOf(S).map((x) => ({ lid: x.lid, item: P.fromListed(x), price: x.lp, at: x.lat, seller: { me: true, id: online() ? net.me()?.id : 'me', name } }));
}
export const isMine = (l) => !!l?.seller?.me || (online() && l?.seller?.id != null && l.seller.id === net.me()?.id);

// The NPC traders' listings now, worked out a few traders at a time (the first time it is what they own that takes the
// time: npcs.js keeps it for the session). Offline only.
let working = null; // { so, p }: the traders' listings being worked out (a page and its watcher ask together: once)
async function npcListings() {
  if (!S.social) await act('npc.tick').catch(() => {});
  const so = S.social;
  if (!so) return [];
  const now = Date.now();
  if (memo && memo.so === so && now - memo.at < OFFLINE_KEEP_MS && P.epochOf(memo.at) === P.epochOf(now)) return memo.list;
  if (working?.so === so) return working.p;
  const p = (async () => {
    const sellers = P.npcSellers(so.seed), list = [];
    let t0 = performance.now();
    for (const n of sellers) {
      list.push(...P.npcListings(so, n, now));
      if (performance.now() - t0 > 12) { await new Promise((r) => setTimeout(r, 0)); t0 = performance.now(); } // (frames go on meanwhile)
      if (S.social !== so) return npcListings(); // (changed meanwhile: start again)
    }
    memo = { so, at: now, list };
    return list;
  })();
  working = { so, p };
  try { return await p; } finally { if (working?.p === p) working = null; }
}
async function offlineAll() { return [...(await npcListings()), ...myListings()]; }

// Listings a search finds, a page of them: { rows, total, page, pages }.
export async function browse(q = {}) {
  if (online()) return noteOpen(await net.p2p('browse', q));
  const query = P.cleanQuery(q);
  return P.pageOf(P.findListings(await offlineAll(), query), query.page);
}
// Every item in the game a search finds, with its listings: { rows: [{ key, n, min }], total, page, pages }.
export async function catalog(q = {}) {
  if (online()) return noteOpen(await net.p2p('catalog', q));
  const query = P.cleanQuery(q, P.CATALOG_SORTS), counts = P.listingCounts(await offlineAll());
  const pg = P.pageOf(P.findCatalog(counts, query), query.page);
  return { ...pg, rows: pg.rows.map((e) => P.catalogRow(counts, e)) };
}
// How many of an item are listed and the cheapest: { n, min } (min null with none).
export async function lowest(key) {
  const r = await browse({ key, sort: 'plow' });
  return { n: r.total, min: r.rows[0]?.price ?? null };
}
// What happened lately: online the server's record ({ kind: 'sold' | 'bought' | 'cancelled' | 'removed', item, price, got, who,
// at }), offline the save's (sold to and bought from the traders, by name).
export async function recent() {
  if (online()) return noteOpen(await net.p2p('mine')).recent || [];
  return (S.p2p?.log || []).map((x) => ({ ...x, item: null }));
}

export async function list(item, price) {
  return online() ? net.p2p('list', { uid: item.uid, price }).catch(noteOff) : act('p2p.list', { uid: item.uid, price });
}
export async function cancel(lid) {
  return online() ? net.p2p('cancel', { lid }) : act('p2p.cancel', { lid });
}
export async function reprice(lid, price) {
  return online() ? net.p2p('reprice', { lid, price }).catch(noteOff) : act('p2p.reprice', { lid, price });
}
// Buys a listing at the price you were shown (l.price): one that changed since is refused (code 'price'), never charged.
export async function buy(l) {
  const r = online() ? await net.p2p('buy', { lid: l.lid, price: l.price }).catch(noteOff) : await act('p2p.buy', { lid: l.lid, price: l.price });
  memo = null;
  return r;
}

// Changes to watch while a page shows the Market: fn({ add, del, upd }), the listings that came up, went (sold or taken down)
// or have a new price. Online they're the server's pushes (and { open } when its admin panel opens or closes the Market);
// offline they're worked out here as the traders or your listings change, against what they were. → stop()
export function watch(fn) {
  const offs = [];
  let stopped = false;
  if (online()) {
    offs.push(net.watch('p2p'), net.on('p2p', (ch) => { noteOpen(ch); fn(ch); }));
  } else {
    let last = null, busy = false, again = false;
    const diff = async () => {
      if (busy) { again = true; return; }
      busy = true;
      try {
        do {
          again = false;
          const now = new Map((await offlineAll()).map((l) => [l.lid, l]));
          if (stopped || online()) return;
          if (last) {
            const add = [], del = [], upd = [];
            for (const [lid, l] of now) { const was = last.get(lid); if (!was) add.push(l); else if (was.price !== l.price) upd.push({ lid, price: l.price }); }
            for (const lid of last.keys()) if (!now.has(lid)) del.push(lid);
            if (add.length || del.length || upd.length) fn({ add, del, upd });
          }
          last = now;
        } while (again);
      } catch { /* (the next change tries again) */ } finally { busy = false; }
    };
    diff(); // (what the changes are told against: the listings as the page first finds them)
    offs.push(on('state', (d) => { if (d?.set && ('social' in d.set || 'listed' in d.set)) { memo = null; diff(); } }));
  }
  return () => { stopped = true; offs.forEach((f) => f()); };
}

// Offline, the traders buy from your listings as time passes (engine p2p.tick): now and then while the game is open, and
// once soon after it starts (for the time it was closed); not during a match or a case opening's reel. onSold([{ name, price, got, who }]) for what sold.
export function startOffline(onSold) {
  const tick = async () => {
    if (online() || !listedOf(S).length || globalThis.document?.querySelector('.play-canvas, .opening')) return;
    let r;
    try { r = await act('p2p.tick'); } catch { return; }
    if (r?.sold?.length) onSold(r.sold);
  };
  setTimeout(tick, 5000);
  setInterval(tick, 30000);
  return tick;
}
