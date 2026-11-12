// The Market online: players list items from their inventory at a price they choose, and anyone else buys them at once
// (ns 'p2p'; the rules, the catalog and the searches are the engine's: src/js/engine/p2p.js, which the game shares).
//
// Where an item is: a listed item leaves the seller's inventory for their st.listed, and its listing is a row in p2p_listings
// (the whole item, its price, its status), written in the same transaction (store.commit). Nothing that works on the inventory
// can reach it there, so a listed item can't be traded, sold, staked, stored or traded up; cancelling puts it back. Only an
// open row is for sale, and every change to one is an UPDATE ... WHERE status = 'open' in the transaction that moves the item
// and the money: a sale writes the buyer (money out, item in), the seller (item gone, money in) and the row (sold) together or
// not at all, like an accepted trade (trade.mjs). Two buyers at once queue on the seller's lock and the second finds it sold;
// two server instances at once (a deploy) can't both sell one row either: the second's UPDATE finds it sold and its
// transaction rolls back (its memory is read again from the database, store.commit). At most one open row per item (a unique
// index). What's in memory (open listings, for the searches) is read from the table at start, so a restart changes nothing.
//
// A seller who isn't connected is paid in their saved state; their next hello tells them (`seen`). Their state and the table
// are made to agree whenever they're held (settleHeld): a listing whose item isn't in their st.listed any more is taken down,
// and an item in st.listed with no open listing goes back to the inventory (unless it sold: then it's the buyer's).
//
// Pushes: only to a connection that announced the p2p1 capability AND says its Market page is open ({ t: 'sub', p2p: true }):
// { t: 'p2p.d', add?: [listing], del?: [lid], upd?: [{ lid, price }] }, the changes of the last moment together. A game that
// announces nothing (1.1.3 and older) is never sent one. The fee is MARKET_FEE (none).
import crypto from 'node:crypto';
import { makeCtx, delta, take, give, spend, credit, GameError } from '../src/js/engine/actions.js';
import * as P from '../src/js/engine/p2p.js';
import { D } from '../src/js/engine/data.js';
import { capCount, itemName } from '../src/js/engine/items.js';
import { publicCopy } from '../src/js/engine/database.js';
import { listedOf, storedItem } from '../src/js/engine/storage.js';
import { round2 } from '../src/js/engine/util.js';

export const P2P = 'p2p1'; // the capability (server/index.mjs CAPS): the Market's pushes
const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN;
// Per player, across their tabs, over a sliding window (the last rule has the longest window).
const LIMITS = {
  list: [{ max: 10, ms: 10 * SEC, say: 'Slow down: at most 10 listings in 10 seconds' }, { max: 200, ms: HOUR, say: 'Too many listings: at most 200 an hour' }],
  buy: [{ max: 10, ms: 10 * SEC, say: 'Slow down: at most 10 purchases in 10 seconds' }, { max: 300, ms: HOUR, say: 'Too many purchases: at most 300 an hour' }],
  change: [{ max: 20, ms: 10 * SEC, say: 'Slow down: too many changes to your listings' }],
  read: [{ max: 40, ms: 10 * SEC, say: 'Slow down: too many searches' }, { max: 400, ms: MIN, say: 'Slow down: at most 400 searches a minute' }],
};
// (CACHE_ROWS: the rows the cached searches hold in all, an "All items" one up to every item in the game; the oldest go first)
const RECENT = 40, PUSH_MS = 400, CACHE_MAX = 300, CACHE_ROWS = 400000;
// Ended listings (cancelled, or taken down) are deleted after ENDED_DAYS, but for each seller's newest RECENT (My listings and
// the admin panel show those). Sold ones stay: they're what was bought and sold.
const ENDED_DAYS = 7, PRUNE_MS = HOUR;
const fail = (m, code = 'bad') => { throw new GameError(m, code); };
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const html = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// An item as other players see it: the item database's copy and what its card and price need (as a profile shows one).
export function shown(it) {
  const { src: _src, ...kc } = it.kc || {};
  return { ...publicCopy(it), pat: it.pat, sk: it.sk, ...(it.kc ? { kc } : {}) };
}
const rowOf = (r) => ({ lid: r.id, item: shown(parse(r.item)), price: Number(r.price), at: Number(r.created), seller: { id: r.seller_id, name: r.seller_name } });

export class P2PMarket {
  constructor(srv) {
    this.srv = srv;
    this.db = srv.db;
    this.open = new Map(); // lid -> listing { lid, item, price, at, seller: { id, name } } (what a search sends)
    this.bySeller = new Map(); // seller id -> Set of lids
    this.subs = new Set(); // connections with the Market page open (p2p1 only)
    this.ver = 0;
    this.cache = new Map(); // a search's key -> its rows (until the listings change)
    this.cacheRows = 0;
    this.countsMemo = null;
    this.hits = new Map();
    this.queue = null;
    this.pushTimer = null;
    this.untold = new Set(); // sellers whose sale went through while their game was still connecting (see tellSold)
    this.wasOpen = null; // (whether the Market was open when its watchers were last told: openChanged)
    this.prunedAt = 0;
    this.warmedAt = null;
    this.now = () => Date.now(); // (the rate limits' clock: tests move it)
    this.timer = setInterval(() => this.sweep(), MIN);
    this.timer.unref?.();
  }

  async init() {
    const { rows } = await this.db.query("SELECT * FROM p2p_listings WHERE status = 'open'");
    for (const r of rows) this.keep(rowOf(r));
    this.wasOpen = this.isOpen();
    // (Every item in the game and its searches' orders, made once a little after the start rather than on the first search:
    // a fifth of a second. Again after a new price list, by sweep.)
    setTimeout(() => this.warm(), 2000).unref?.();
    this.prunedAt = Date.now() - PRUNE_MS + 5 * MIN; // (the first in a few minutes)
  }
  close() { clearInterval(this.timer); clearTimeout(this.pushTimer); this.flush(); }
  warm() {
    try { P.warmCatalog(); this.warmedAt = D.pricedAt; } catch (e) { this.srv.log?.('[p2p] catalog failed', e?.message || e); }
  }
  sweep() {
    const now = this.now();
    for (const [key, times] of this.hits) if (now - times.at(-1) > HOUR) this.hits.delete(key);
    for (const ws of this.subs) if (ws.readyState !== 1) this.subs.delete(ws);
    if (this.warmedAt !== null && this.warmedAt !== D.pricedAt) this.warm();
    if (Date.now() - this.prunedAt >= PRUNE_MS) this.prune().catch((e) => this.srv.log?.('[p2p] prune failed', e?.message || e));
  }
  // Ended listings older than ENDED_DAYS go, but for each seller's newest RECENT that ended. → how many went
  async prune(now = Date.now()) {
    this.prunedAt = now;
    const { rows } = await this.db.query(`WITH gone AS (DELETE FROM p2p_listings WHERE status IN ('cancelled', 'removed') AND updated < $1 AND id NOT IN (
        SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY seller_id ORDER BY updated DESC) AS n FROM p2p_listings WHERE status <> 'open') x WHERE n <= ${RECENT})
      RETURNING 1) SELECT count(*)::int AS n FROM gone`, [now - ENDED_DAYS * 24 * HOUR]);
    return rows[0]?.n || 0;
  }

  limit(kind, id) {
    const rules = LIMITS[kind], key = `${kind}:${id}`, now = this.now();
    const times = (this.hits.get(key) || []).filter((t) => now - t < rules.at(-1).ms);
    this.hits.set(key, times);
    for (const { max, ms, say } of rules) if (times.filter((t) => now - t < ms).length >= max) fail(say, 'rate');
    times.push(now);
  }
  // The admin panel's switches: trading off, or the market off, stop listing, buying and new prices (not cancelling).
  mayTrade() {
    const s = this.srv.admin?.settings || {};
    if (s.trading === false) fail('Trading is turned off on this server right now', 'off');
    if (s.market === false) fail('The Market is closed on this server right now', 'off');
  }
  isOpen() { const s = this.srv.admin?.settings || {}; return s.trading !== false && s.market !== false; }
  // The admin panel's switches changed (admin.mjs settingsSet): the games watching the Market are told at once whether it's
  // open, so their pages say so ({ t: 'p2p.d', open }: p2p1 only, as every p2p.d). A browse or catalog answer says it too.
  openChanged() {
    const open = this.isOpen();
    if (open === this.wasOpen) return;
    this.wasOpen = open;
    const msg = JSON.stringify({ t: 'p2p.d', open });
    for (const ws of this.subs) if (ws.readyState === 1 && ws.caps?.has(P2P)) ws.send(msg);
  }
  async notBanned(id, who = 'You') {
    const ban = await this.srv.admin?.activeBan({ userId: id });
    if (ban) fail(who === 'You' ? 'Banned players can\'t use the Market' : 'That listing is no longer for sale', who === 'You' ? 'banned' : 'gone');
  }
  // A seller banned, or on a network that's blocked (the one they last played from, as a hello would find it): what they listed
  // isn't for sale.
  async sellerBanned(id) {
    const { rows } = await this.db.query('SELECT ip_hash FROM user_ips WHERE user_id = $1 ORDER BY last DESC LIMIT 1', [id]).catch(() => ({ rows: [] }));
    return this.srv.admin?.activeBan({ userId: id, ipHash: rows[0]?.ip_hash || null });
  }
  // A network ban (admin.mjs ban): the listings of everyone else whose last network it is, and of the accounts it threw off,
  // come down too (not staff's: a network ban doesn't keep them out). → how many
  async takeDownNetwork(ipHash, { except = null, kicked = [] } = {}) {
    const sellers = [...this.bySeller.keys()].filter((id) => id !== except);
    if (!ipHash || !sellers.length) return 0;
    const { rows } = await this.db.query(`SELECT a.user_id FROM user_ips a WHERE a.user_id = ANY($1::int[]) AND a.ip_hash = $2
      AND a.last = (SELECT max(b.last) FROM user_ips b WHERE b.user_id = a.user_id)`, [sellers, ipHash]);
    let n = 0;
    for (const id of new Set([...rows.map((r) => r.user_id), ...kicked.filter((id) => this.bySeller.has(id))])) {
      if (id === except || (await this.srv.admin?.levelOf(id, { fast: true })) >= 1) continue;
      n += await this.takeDown(id, 'removed').catch((e) => { this.srv.log?.('[p2p] take down failed', e?.message || e); return 0; });
    }
    return n;
  }

  // ---- what's open, in memory -------------------------------------------------------------------------------------------
  keep(l) {
    this.open.set(l.lid, l);
    if (!this.bySeller.has(l.seller.id)) this.bySeller.set(l.seller.id, new Set());
    this.bySeller.get(l.seller.id).add(l.lid);
  }
  drop(lid) {
    const l = this.open.get(lid);
    if (!l) return null;
    this.open.delete(lid);
    const set = this.bySeller.get(l.seller.id);
    set?.delete(lid);
    if (set && !set.size) this.bySeller.delete(l.seller.id);
    return l;
  }
  sellerLids = (id) => [...(this.bySeller.get(id) || [])];
  // The listings changed: searches are worked out again, and the games watching are told (together, a moment later).
  changed({ add = [], del = [], upd = [] } = {}) {
    this.ver++;
    this.cache.clear();
    this.cacheRows = 0;
    this.countsMemo = null;
    if (!this.subs.size) return;
    const q = (this.queue ||= { add: new Map(), del: new Set(), upd: new Map() });
    for (const l of add) { q.del.delete(l.lid); q.add.set(l.lid, l); }
    for (const lid of del) { if (q.add.has(lid)) q.add.delete(lid); else q.del.add(lid); q.upd.delete(lid); }
    for (const u of upd) { if (q.add.has(u.lid)) q.add.set(u.lid, { ...q.add.get(u.lid), price: u.price }); else q.upd.set(u.lid, u); }
    if (!this.pushTimer) { this.pushTimer = setTimeout(() => this.flush(), PUSH_MS); this.pushTimer.unref?.(); }
  }
  flush() {
    this.pushTimer = null;
    const q = this.queue;
    this.queue = null;
    if (!q || (!q.add.size && !q.del.size && !q.upd.size)) return;
    const msg = JSON.stringify({ t: 'p2p.d', ...(q.add.size ? { add: [...q.add.values()] } : {}), ...(q.del.size ? { del: [...q.del] } : {}), ...(q.upd.size ? { upd: [...q.upd.values()] } : {}) });
    for (const ws of this.subs) {
      if (ws.readyState !== 1) { this.subs.delete(ws); continue; }
      if (ws.caps?.has(P2P)) ws.send(msg);
    }
  }
  // { t: 'sub', p2p } from a p2p1 game: its Market page opened (true) or closed (false).
  subscribe(ws, on) {
    if (on && ws.caps?.has(P2P)) this.subs.add(ws); else this.subs.delete(ws);
  }
  counts() {
    return (this.countsMemo ||= P.listingCounts([...this.open.values()]));
  }
  // (A search's rows until the listings change; its order by discount goes by the prices, so a new price list starts again.
  // At most CACHE_MAX searches and CACHE_ROWS rows in all: the oldest go first.)
  cached(key, make) {
    key += '|' + D.pricedAt;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const rows = make();
    this.cache.set(key, rows);
    this.cacheRows += rows.length;
    for (const [k, v] of this.cache) {
      if ((this.cache.size <= CACHE_MAX && this.cacheRows <= CACHE_ROWS) || k === key) break;
      this.cache.delete(k);
      this.cacheRows -= v.length;
    }
    return rows;
  }

  // ---- requests -----------------------------------------------------------------------------------------------------------
  // → { r, d? } (d: the changes to the asker, which its other connections are sent as a delta)
  async rpc(user, m, a = {}, ws = null) {
    a = a && typeof a === 'object' ? a : {};
    switch (m) {
      case 'browse': return { r: this.browse(user, a) };
      case 'catalog': return { r: this.catalog(user, a) };
      case 'mine': return this.mine(user, ws);
      case 'list': return this.list(user, a, ws);
      case 'cancel': return this.cancel(user, a, ws);
      case 'reprice': return this.reprice(user, a, ws);
      case 'buy': return this.buy(user, a, ws);
    }
    fail('Unknown request');
  }

  // Listings, a page of them: { rows: [listing], total, page, pages, open (whether buying and listing are on) }. (A search
  // with `key`: one catalog entry's.)
  browse(user, a) {
    this.limit('read', user.id);
    const q = P.cleanQuery(a);
    const rows = this.cached('l' + P.queryKey(q), () => P.findListings([...this.open.values()], q));
    return { ...P.pageOf(rows, q.page), open: this.isOpen() };
  }
  // Every item in the game a search finds, with its listings' count and lowest price: { rows: [{ key, n, min }], total, ... }.
  catalog(user, a) {
    this.limit('read', user.id);
    const q = P.cleanQuery(a, P.CATALOG_SORTS), counts = this.counts();
    const rows = this.cached('c' + P.queryKey(q), () => P.findCatalog(counts, q));
    const pg = P.pageOf(rows, q.page);
    return { ...pg, rows: pg.rows.map((e) => P.catalogRow(counts, e)), open: this.isOpen() };
  }
  // Your listings are in your state (st.listed); this is what happened to the ones that ended, and what you bought:
  // { recent: [{ lid, kind: 'sold' | 'bought' | 'cancelled' | 'removed', item, price, got, who, at }] }.
  async mine(user, ws) {
    this.limit('read', user.id);
    const d = await this.srv.store.withUser(user.id, (e) => this.settleHeld(e));
    if (d) this.srv.sendTo(user.id, { t: 'delta', d }, ws);
    const { rows } = await this.db.query(`SELECT * FROM p2p_listings WHERE (seller_id = $1 AND status <> 'open') OR buyer_id = $1
      ORDER BY updated DESC LIMIT ${RECENT}`, [user.id]);
    return {
      r: {
        recent: rows.map((r) => {
          const bought = r.buyer_id === user.id, price = Number(r.price), fee = Number(r.fee) || 0;
          return { lid: r.id, kind: bought ? 'bought' : r.status, item: shown(parse(r.item)), price, got: bought ? null : round2(price - fee),
            who: bought ? r.seller_name : r.buyer_name || null, whoId: bought ? r.seller_id : r.buyer_id ?? null, at: Number(r.updated) };
        }),
        open: this.isOpen(),
      },
      ...(d ? { d } : {}),
    };
  }

  async list(user, a, ws) {
    this.mayTrade();
    this.limit('list', user.id);
    await this.notBanned(user.id);
    const uid = String(a.uid ?? ''), price = P.cleanPrice(a.price);
    const out = await this.srv.store.withUser(user.id, async (e) => {
      // (read while held: an offer being made is made holding this player too, so it's in here or it found the item gone)
      const reserved = this.srv.trades.reserved(user.id);
      await this.settleHeld(e);
      const item = e.st.inv.find((i) => i.uid === uid);
      if (!item && storedItem(e.st, uid)) fail(`${itemName(storedItem(e.st, uid))} is in a Storage Unit. Retrieve it first.`, 'stored');
      const why = P.listRefusal(item, { reserved });
      if (why) fail(why, item ? 'item' : 'missing');
      const bad = P.priceProblem(price, P.referencePrice(item));
      if (bad) fail(bad, 'price');
      if (listedOf(e.st).length >= P.MAX_LISTINGS || this.sellerLids(user.id).length >= P.MAX_LISTINGS) fail(`You have ${P.MAX_LISTINGS} listings. Cancel one first.`, 'limit');
      const ctx = makeCtx(e.st, { online: true, reserved });
      take(ctx, [item.uid]); // (everything it checks is checked above: nothing has changed if it refuses)
      const lid = crypto.randomUUID(), now = Date.now();
      const entry = P.toListed(item, { lid, price, at: now });
      e.st.listed = [entry, ...listedOf(e.st)];
      ctx.dirty.add('listed');
      this.srv.store.markDirty(e);
      try {
        await this.srv.store.commit([e], (q) => q(`INSERT INTO p2p_listings (id, seller_id, seller_name, uid, item, price, status, created, updated, seen)
          VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'open', $7, $7, TRUE)`, [lid, user.id, e.name, item.uid, JSON.stringify(P.fromListed(entry)), price, now]));
      } catch (err) {
        if (/unique|duplicate/i.test(err.message)) fail('That item is already listed', 'listed');
        throw err;
      }
      const l = { lid, item: shown(entry), price, at: now, seller: { id: user.id, name: e.name } };
      this.keep(l);
      return { l, d: delta(ctx) };
    });
    this.changed({ add: [out.l] });
    this.srv.sendTo(user.id, { t: 'delta', d: out.d }, ws);
    return { r: { lid: out.l.lid, price }, d: out.d };
  }

  async cancel(user, a, ws) {
    this.limit('change', user.id);
    const lid = String(a.lid ?? '');
    const out = await this.srv.store.withUser(user.id, (e) => this.cancelHeld(e, lid, 'cancelled')).catch((err) => this.recheck(lid).then(() => { throw err; }));
    this.srv.sendTo(user.id, { t: 'delta', d: out.d }, ws);
    return { r: { item: out.item }, d: out.d };
  }
  // Takes one of a held player's listings down (status: 'cancelled', or 'removed' by staff): the item back in their inventory
  // (a full one too: it was theirs all along), the row closed, in one transaction. → { item, d, l }
  async cancelHeld(e, lid, status) {
    let entry = listedOf(e.st).find((x) => x.lid === lid);
    if (!entry) {
      await this.settleHeld(e);
      fail('That listing is gone (sold or taken down)', 'gone');
    }
    const ctx = makeCtx(e.st, { online: true });
    e.st.listed = listedOf(e.st).filter((x) => x !== entry);
    ctx.dirty.add('listed');
    const item = P.fromListed(entry);
    e.st.inv.unshift(item);
    ctx.add.push(item);
    this.srv.store.markDirty(e);
    const now = Date.now();
    await this.srv.store.commit([e], async (q) => {
      const { rows } = await q("UPDATE p2p_listings SET status = $2, updated = $3 WHERE id = $1 AND status = 'open' RETURNING id", [lid, status, now]);
      if (!rows.length) throw new GameError('That listing just sold', 'gone');
    });
    const l = this.drop(lid);
    this.changed({ del: [lid] });
    return { item, d: delta(ctx), l, price: entry.lp };
  }

  async reprice(user, a, ws) {
    this.mayTrade();
    this.limit('change', user.id);
    const lid = String(a.lid ?? ''), price = P.cleanPrice(a.price);
    const out = await this.srv.store.withUser(user.id, async (e) => {
      const entry = listedOf(e.st).find((x) => x.lid === lid);
      if (!entry) { await this.settleHeld(e); fail('That listing is gone (sold or taken down)', 'gone'); }
      const bad = P.priceProblem(price, P.referencePrice(entry));
      if (bad) fail(bad, 'price');
      if (price === entry.lp) return { d: null };
      const ctx = makeCtx(e.st, { online: true });
      e.st.listed = listedOf(e.st).map((x) => (x === entry ? { ...x, lp: price } : x));
      ctx.dirty.add('listed');
      this.srv.store.markDirty(e);
      await this.srv.store.commit([e], async (q) => {
        const { rows } = await q("UPDATE p2p_listings SET price = $2, updated = $3 WHERE id = $1 AND status = 'open' RETURNING id", [lid, price, Date.now()]);
        if (!rows.length) throw new GameError('That listing just sold', 'gone');
      });
      const l = this.open.get(lid);
      if (l) this.open.set(lid, { ...l, price });
      return { d: delta(ctx) };
    }).catch((err) => this.recheck(lid).then(() => { throw err; }));
    if (out.d) {
      this.changed({ upd: [{ lid, price }] });
      this.srv.sendTo(user.id, { t: 'delta', d: out.d }, ws);
    }
    return { r: { lid, price }, ...(out.d ? { d: out.d } : {}) };
  }

  // Buys a listing (price: what the buyer saw; another is refused). The buyer and the seller are held together, the seller's
  // copy read again from the database unless they play on this server, everything checked before anything changes, then
  // one transaction: both players and the row, only if the row is still open.
  async buy(user, a, ws) {
    this.mayTrade();
    this.limit('buy', user.id);
    const lid = String(a.lid ?? ''), seen = a.price == null ? null : P.cleanPrice(a.price);
    const l0 = this.open.get(lid) || fail('That listing is no longer for sale', 'gone');
    if (l0.seller.id === user.id) fail('That\'s your own listing. Cancel it in My listings.', 'own');
    if (seen != null && seen !== l0.price) fail(`The price changed to ${P.usd(l0.price)}`, 'price');
    await this.notBanned(user.id);
    const sellerId = l0.seller.id;
    if (await this.sellerBanned(sellerId)) {
      await this.takeDown(sellerId, 'removed').catch(() => {});
      fail('That listing is no longer for sale', 'gone');
    }
    const INV_CAP = this.srv.INV_CAP ?? Infinity;
    let out;
    try {
      out = await this.srv.store.lock([user.id, sellerId], async (entries) => {
        const l = this.open.get(lid) || fail('Someone else just bought that listing', 'gone');
        if (seen != null && seen !== l.price) fail(`The price changed to ${P.usd(l.price)}`, 'price');
        const buyer = entries.find((x) => x.id === user.id), seller = entries.find((x) => x.id === sellerId);
        if (!this.srv.isOnline(sellerId) && !seller.dirty && !seller.saving) await this.srv.store.reload(seller);
        const entry = listedOf(seller.st).find((x) => x.lid === lid);
        if (!entry) {
          await this.voidListing(l, 'removed');
          fail('That listing is no longer for sale', 'gone');
        }
        if (buyer.st.money + 1e-9 < l.price) fail('Not enough money', 'funds');
        if (capCount(buyer.st.inv) + 1 > INV_CAP) fail(`Inventory full (${INV_CAP} items, not counting badges that can't be traded). Sell something first.`, 'full');
        // (Nothing below can refuse.)
        const cb = makeCtx(buyer.st, { online: true, invCap: INV_CAP }), cs = makeCtx(seller.st, { online: true });
        spend(cb, l.price);
        const item = { ...P.fromListed(entry), nw: true };
        give(cb, [item]);
        seller.st.listed = listedOf(seller.st).filter((x) => x !== entry);
        cs.dirty.add('listed');
        const fee = P.feeOf(l.price), got = round2(l.price - fee);
        credit(cs, got);
        this.srv.store.markDirty(buyer);
        this.srv.store.markDirty(seller);
        // (told: a game of the seller's has its welcome, so it's told now. One still connecting isn't: its welcome brings the
        // money, and the sale is left unseen for tellSold, just after that welcome, or the next hello.)
        const now = Date.now(), told = this.welcomed(sellerId);
        await this.srv.store.commit([buyer, seller], async (q) => {
          const { rows } = await q(`UPDATE p2p_listings SET status = 'sold', buyer_id = $2, buyer_name = $3, fee = $4, sold_at = $5, updated = $5, seen = $6
            WHERE id = $1 AND status = 'open' RETURNING id`, [lid, buyer.id, buyer.name, fee, now, told]);
          if (!rows.length) throw new GameError('Someone else just bought that listing', 'gone');
        });
        this.drop(lid);
        return { db: delta(cb), ds: delta(cs), item, price: l.price, got, told, name: P.marketName(item, { real: true }) };
      });
    } catch (err) {
      if (err?.code === 'gone') await this.recheck(lid);
      throw err;
    }
    this.changed({ del: [lid] });
    this.srv.sendTo(user.id, { t: 'delta', d: out.db }, ws);
    this.srv.deltaTo(sellerId, out.ds, out.told ? `Your <b>${html(out.name)}</b> sold on the Market for <b>${P.usd(out.price)}</b>${out.got !== out.price ? ` (${P.usd(out.got)} after the fee)` : ''}` : null);
    if (!out.told) {
      // (a game that got its welcome meanwhile is told now; one that's still connecting, just after its welcome)
      if (this.welcomed(sellerId)) await this.tellSold(sellerId).catch(() => {});
      else if (this.srv.isOnline(sellerId)) this.untold.add(sellerId);
    }
    // Trade offers that asked the seller for it can't go through any more (as when a trade moves an item: trade.mjs).
    await this.srv.trades?.closeRelying?.(sellerId, [out.item.uid]).catch((e) => this.srv.log?.('[p2p] closing offers failed', e?.message || e));
    return { r: { item: out.item, price: out.price }, d: out.db };
  }
  // Whether one of a player's games has its welcome (index.mjs sets ws.welcomed), so a push reaches it.
  welcomed(id) { return [...(this.srv.sockets?.get(id) || [])].some((ws) => ws.welcomed && ws.readyState === 1); }
  // What sold of a player's that they haven't been told about, told now (to their games with a welcome) and marked seen: one
  // UPDATE, so two at once can't both tell it. → the notice, or null. (connected() tells it to a game about to be welcomed.)
  async tellSold(id, { send = true } = {}) {
    this.untold.delete(id);
    const { rows } = await this.db.query("UPDATE p2p_listings SET seen = TRUE WHERE seller_id = $1 AND status = 'sold' AND NOT seen RETURNING id, item, price, fee, sold_at", [id]);
    if (!rows.length) return null;
    rows.sort((a, b) => Number(a.sold_at) - Number(b.sold_at));
    const got = round2(rows.reduce((s, r) => s + Number(r.price) - (Number(r.fee) || 0), 0));
    const msg = rows.length === 1
      ? `While you were away, your <b>${html(P.marketName(parse(rows[0].item), { real: true }))}</b> sold on the Market for <b>${P.usd(got)}</b>`
      : `While you were away, ${rows.length} of your Market listings sold, for <b>${P.usd(got)}</b> in all`;
    if (send) this.srv.notice?.(id, msg);
    return msg;
  }
  // A game was just welcomed (index.mjs): a sale that went through while it was connecting is told now.
  welcome(id) {
    if (this.untold.has(id)) this.tellSold(id).catch((e) => this.srv.log?.('[p2p] telling a sale failed', e?.message || e));
  }

  // ---- keeping state and table agreed ---------------------------------------------------------------------------------------
  // A row someone else may have changed (another instance, or a transaction that just failed): memory goes by the table.
  async recheck(lid) {
    const { rows } = await this.db.query('SELECT * FROM p2p_listings WHERE id = $1', [lid]);
    const r = rows[0];
    if (r?.status === 'open') { if (!this.open.has(lid)) { this.keep(rowOf(r)); this.changed({ add: [this.open.get(lid)] }); } return; }
    if (this.drop(lid)) this.changed({ del: [lid] });
  }
  async voidListing(l, status) {
    await this.db.query("UPDATE p2p_listings SET status = $2, updated = $3 WHERE id = $1 AND status = 'open'", [l.lid, status, Date.now()]);
    if (this.drop(l.lid)) this.changed({ del: [l.lid] });
  }
  // A held player's listings and their state put in agreement (see the top). → the change to their state, or null.
  async settleHeld(e) {
    const listed = listedOf(e.st), have = new Set(listed.map((x) => x.lid));
    for (const lid of this.sellerLids(e.id)) if (!have.has(lid)) await this.voidListing(this.open.get(lid), 'removed');
    const strays = listed.filter((x) => !this.open.has(x.lid));
    if (!strays.length) return null;
    const { rows } = await this.db.query('SELECT * FROM p2p_listings WHERE id = ANY($1::text[])', [strays.map((x) => x.lid)]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const back = [], gone = new Set();
    for (const x of strays) {
      const r = byId.get(x.lid);
      if (r?.status === 'open' && r.seller_id === e.id) { this.keep(rowOf(r)); this.changed({ add: [this.open.get(x.lid)] }); continue; } // (another instance's)
      gone.add(x.lid);
      if (r?.status === 'sold') continue; // (the buyer's now)
      if (!e.st.inv.some((i) => i.uid === x.uid) && !storedItem(e.st, x.uid)) back.push(P.fromListed(x));
    }
    if (!gone.size) return null;
    e.st.listed = listed.filter((x) => !gone.has(x.lid));
    e.st.inv.unshift(...back);
    this.srv.store.markDirty(e);
    await this.srv.store.commit([e]);
    return { set: { listed: e.st.listed }, add: back, del: [], upd: [] };
  }
  // A player connecting (the caller holds their lock): their state and listings agreed, and what sold while they were away.
  // → a notice for them, or null
  async connected(e) {
    await this.settleHeld(e);
    return this.tellSold(e.id, { send: false });
  }
  // Every listing of a player's taken down (a ban; staff), the items back in their inventory. → how many
  async takeDown(id, status = 'removed') {
    const out = await this.srv.store.withUser(id, async (e) => {
      const settled = await this.settleHeld(e);
      const lids = listedOf(e.st).map((x) => x.lid);
      if (!lids.length) return settled ? { d: settled, n: 0 } : null;
      const ctx = makeCtx(e.st, { online: true }), items = listedOf(e.st).map(P.fromListed);
      e.st.listed = [];
      ctx.dirty.add('listed');
      e.st.inv.unshift(...items);
      ctx.add.push(...items);
      this.srv.store.markDirty(e);
      await this.srv.store.commit([e], (q) => q("UPDATE p2p_listings SET status = $2, updated = $3 WHERE id = ANY($1::text[]) AND status = 'open'", [lids, status, Date.now()]));
      for (const lid of lids) this.drop(lid);
      this.changed({ del: lids });
      return { d: delta(ctx), n: lids.length };
    });
    if (out?.d) this.srv.deltaTo(id, out.d);
    return out?.n || 0;
  }
  // Staff are about to replace a held player's whole state (a restore or reset: admin.mjs replaceWith): their listings end
  // and the items go back to the inventory being replaced, and the new state's listings (a snapshot taken while some were up)
  // are inventory items in it, so the restore's own checks see them (one sold since is someone else's: it's left out).
  async beforeReplace(e, next) {
    const lids = [...new Set([...listedOf(e.st).map((x) => x.lid), ...this.sellerLids(e.id)])];
    if (lids.length) {
      await this.db.query("UPDATE p2p_listings SET status = 'cancelled', updated = $2 WHERE id = ANY($1::text[]) AND status = 'open'", [lids, Date.now()]);
      for (const lid of lids) this.drop(lid);
      this.changed({ del: lids });
    }
    if (listedOf(e.st).length) { e.st.inv = [...listedOf(e.st).map(P.fromListed), ...e.st.inv]; e.st.listed = []; }
    if (next && Array.isArray(next.listed)) { next.inv = [...next.listed.filter((x) => x && typeof x === 'object').map(P.fromListed), ...(next.inv || [])]; delete next.listed; }
  }
  // A player was renamed: their listings show the new name.
  async renamed(id, name) {
    await this.db.query("UPDATE p2p_listings SET seller_name = $2 WHERE seller_id = $1 AND status = 'open'", [id, name]);
    const upd = [];
    for (const lid of this.sellerLids(id)) { const l = this.open.get(lid); if (l) { this.open.set(lid, { ...l, seller: { ...l.seller, name } }); upd.push(this.open.get(lid)); } }
    if (upd.length) { this.changed({ del: upd.map((l) => l.lid) }); this.changed({ add: upd }); }
  }

  // ---- the admin panel ------------------------------------------------------------------------------------------------------
  // A player's open listings and their latest that ended, as seller or buyer.
  async staffView(id) {
    const open = this.sellerLids(id).map((lid) => this.open.get(lid)).filter(Boolean).sort((x, y) => y.at - x.at);
    const { rows } = await this.db.query(`SELECT * FROM p2p_listings WHERE (seller_id = $1 AND status <> 'open') OR buyer_id = $1 ORDER BY updated DESC LIMIT ${RECENT}`, [id]);
    return {
      open,
      recent: rows.map((r) => ({ lid: r.id, status: r.status, item: shown(parse(r.item)), price: Number(r.price), fee: Number(r.fee) || 0, at: Number(r.updated),
        seller: { id: r.seller_id, name: r.seller_name }, buyer: r.buyer_id != null ? { id: r.buyer_id, name: r.buyer_name } : null })),
      fee: P.MARKET_FEE, max: P.MAX_LISTINGS,
    };
  }
  // Staff taking one listing down: the item goes back to its owner. → { item, price }
  async staffCancel(id, lid) {
    const out = await this.srv.store.withUser(id, (e) => this.cancelHeld(e, String(lid), 'removed')).catch((err) => this.recheck(String(lid)).then(() => { throw err; }));
    this.srv.deltaTo(id, out.d, `A moderator took your <b>${html(P.marketName(out.item, { real: true }))}</b> off the Market: it's back in your inventory`);
    return { item: out.item, price: out.price };
  }
  // Staff about to work on some of a held player's items (admin.mjs: a Name Tag's name cleared, items removed): those that are
  // listed come down first, back in the inventory, so the tools find them there. → { ds (the changes, to send in order), lids }
  async releaseHeld(e, uids) {
    const want = new Set(uids), lids = listedOf(e.st).filter((x) => want.has(x.uid)).map((x) => x.lid), ds = [];
    for (const lid of lids) ds.push((await this.cancelHeld(e, lid, 'removed')).d);
    return { ds, lids };
  }
}
