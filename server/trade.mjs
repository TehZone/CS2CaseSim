// Trade offers between players. Items offered are reserved (can't be sold or used) while the offer is open.
// Accepting re-checks both sides and swaps everything in one database transaction.
import crypto from 'node:crypto';
import { makeCtx, delta, take, give, spend, credit, GameError } from '../src/js/engine/actions.js';
import { capCount, isBound, isUnit, itemName, tradable } from '../src/js/engine/items.js';
import { listedOf, storedItem } from '../src/js/engine/storage.js';
import { textProblem } from '../src/js/engine/tools.js';
import { round2 } from '../src/js/engine/util.js';

const MAX_ITEMS = 100, MAX_OPEN = 20, MAX_LIST = 30, MSG_MAX = 140;
// The offers player $1 sees: theirs, and those to them (not one sent while they had its sender blocked).
const VISIBLE = "(from_id = $1 OR (to_id = $1 AND offer->>'hidden' IS NULL))";
const fail = (m) => { throw new GameError(m); };
const money = (v) => { const n = round2(Number(v) || 0); if (!(n >= 0) || n > 1e12) fail('Invalid amount'); return n; };
const uidList = (v) => {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > MAX_ITEMS) fail(`At most ${MAX_ITEMS} items per side`);
  const out = v.map(String);
  if (new Set(out).size !== out.length) fail('Duplicate items');
  return out;
};

export class Trades {
  constructor(srv) {
    this.srv = srv;
    this.open = new Map(); // id -> row (open offers only)
  }

  async init() {
    const { rows } = await this.srv.db.query("SELECT * FROM trades WHERE status = 'open'");
    for (const r of rows) this.open.set(r.id, norm(r));
  }

  // uids a player has offered in open trades (reserved).
  reserved(userId) {
    const s = new Set();
    for (const t of this.open.values()) if (t.from_id === userId) for (const u of t.offer.give.uids) s.add(u);
    return s;
  }

  // uids of a player's that other players' open trades ask for. (Not a hidden offer's: see offer.)
  asked(userId) {
    const s = new Set();
    for (const t of this.open.values()) if (t.to_id === userId && !t.offer.hidden) for (const u of t.offer.get.uids) s.add(u);
    return s;
  }
  // Staff took a bad name off an item: the copies of it in offers lose it too, closed ones as well (Recent trades shows them).
  async dropName(uid) {
    const holding = (side) => JSON.stringify({ [side]: [{ uid }] });
    const { rows } = await this.srv.db.query('SELECT * FROM trades WHERE offer @> $1::jsonb OR offer @> $2::jsonb', [holding('giveItems'), holding('getItems')]);
    for (const row of rows) {
      const t = this.open.get(row.id) || norm(row); // (an open one: the copy the server works from)
      const copies = [...t.offer.giveItems, ...t.offer.getItems].filter((i) => i.uid === uid && i.name != null);
      if (!copies.length) continue;
      for (const it of copies) delete it.name;
      await this.srv.db.query('UPDATE trades SET offer = $1::jsonb WHERE id = $2', [JSON.stringify(t.offer), t.id]);
      await this.pushChanged(t.id);
    }
  }

  // A player's list: the MAX_LIST latest offers they see (VISIBLE), open and closed.
  async list(userId) {
    const { rows } = await this.srv.db.query(`SELECT * FROM trades WHERE ${VISIBLE} ORDER BY updated DESC LIMIT ${MAX_LIST}`, [userId]);
    return rows.map(norm).map((t) => this.view(t));
  }
  view(t) {
    return {
      id: t.id, status: t.status, version: t.version, created: Number(t.created), updated: Number(t.updated), msg: t.offer.msg || '',
      from: { id: t.from_id, name: t.offer.fromName }, to: { id: t.to_id, name: t.offer.toName },
      give: { items: t.offer.giveItems, money: t.offer.give.money }, get: { items: t.offer.getItems, money: t.offer.get.money },
    };
  }
  // Tells both sides of these offers (ids) that they changed. A game without lean1 gets its whole list again
  // ({ t: 'trades', trades }), as it always did. A lean1 game gets only the offers that changed and are on its list, and the
  // ids of any pushed off the end of it ({ t: 'trades.d', upd, del }); its whole list comes in its welcome and from
  // trade 'list'. (A lean1 connection whose welcome is still on its way is sent its whole list just after it instead: the
  // welcome's may have been read before this change.)
  pushChanged(...ids) { return this.push(ids, []); }
  // The same, for offers whose status is all that changed (closed: declined, cancelled, accepted, failed, countered): to a
  // lean1 game each is { id, status, version, updated }, which it merges into the copy it has (it asks for its list again
  // if it hasn't one). Its items, money and words are what it was sent already.
  pushClosed(...ids) { return this.push(ids, ids); }
  async push(ids, closed) {
    ids = [...new Set(ids.filter((x) => x != null).map(String))];
    if (!ids.length) return;
    const brief = new Set(closed.filter((x) => x != null).map(String));
    const row = (t) => (brief.has(t.id) ? { id: t.id, status: t.status, version: t.version, updated: Number(t.updated) } : this.view(t));
    const { rows } = await this.srv.db.query('SELECT * FROM trades WHERE id = ANY($1::text[])', [ids]);
    const changed = rows.map(norm);
    const conns = (id) => [...(this.srv.sockets.get(id) || [])];
    for (const id of new Set(changed.flatMap((t) => [t.from_id, t.to_id]))) {
      let some = null;
      if (conns(id).some((ws) => this.srv.lean(ws))) {
        const theirs = changed.filter((t) => t.from_id === id || t.to_id === id);
        const { rows: top } = await this.srv.db.query(`SELECT id FROM trades WHERE ${VISIBLE} ORDER BY updated DESC LIMIT ${MAX_LIST + theirs.length}`, [id]);
        const shown = new Set(top.slice(0, MAX_LIST).map((r) => r.id));
        // (Nothing at all when none of them is on their list: an offer from someone they've blocked says nothing to them.)
        const upd = theirs.filter((t) => shown.has(t.id)).map(row), del = top.slice(MAX_LIST).map((r) => r.id);
        if (upd.length) some = { t: 'trades.d', upd, ...(del.length ? { del } : {}) };
      }
      // (The whole list last, and sent as soon as it's read: whoever is connected by then gets it.)
      const full = conns(id).some((ws) => !this.srv.lean(ws)) ? { t: 'trades', trades: await this.list(id) } : null;
      this.srv.sendEach(id, (ws) => {
        if (!this.srv.lean(ws)) return full;
        if (!ws.welcomed) { ws.tradesStale = true; return null; }
        return some;
      });
    }
  }
  // A player's whole list to one connection (see pushChanged).
  async pushFull(id, ws) {
    ws.tradesStale = false;
    const trades = await this.list(id);
    if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'trades', trades }));
  }

  async rpc(user, m, a = {}) {
    switch (m) {
      case 'list': return this.list(user.id); // (the whole list again: a lean1 game is otherwise sent only changes)
      case 'inventory': return this.inventory(user, a);
      case 'offer': return this.offer(user, a);
      case 'accept': return this.accept(user, a);
      case 'decline': return this.setStatus(user, a, 'declined', 'to');
      case 'cancel': return this.setStatus(user, a, 'cancelled', 'from');
    }
    fail('Unknown request');
  }

  async findUser(name) {
    if (typeof name !== 'string' || !name) fail('Unknown player');
    const { rows } = await this.srv.db.query('SELECT id, name FROM users WHERE name_lc = $1', [name.toLowerCase()]);
    if (!rows.length) fail(`No player called "${name}"`);
    return rows[0];
  }

  async inventory(user, { name }) {
    const other = await this.findUser(name);
    const e = await this.srv.store.load(other.id);
    return { name: other.name, items: e.st.inv.filter(tradable).slice(0, 1500) };
  }

  async offer(user, a) {
    const other = await this.findUser(a.to);
    if (other.id === user.id) fail("You can't trade with yourself");
    const who = await this.srv.social.other(user, other.id);
    if (who.mine) fail(`Unblock ${other.name} to send them an offer`);
    // Someone who blocked you never gets it, and you aren't told: it stays open on your side until you cancel it.
    const hidden = who.theirs;
    if ([...this.open.values()].filter((t) => t.from_id === user.id).length >= MAX_OPEN) fail(`You have ${MAX_OPEN} open offers. Cancel some first.`);
    const give = { uids: uidList(a.give?.uids), money: money(a.give?.money) };
    const get = { uids: uidList(a.get?.uids), money: money(a.get?.money) };
    if (!give.uids.length && !get.uids.length && !give.money && !get.money) fail('The offer is empty');
    // The words with it reach the other player, so they're a message: the same filter, and the same refusal whether the setting
    // or a block is why (an offer without any still goes, as a block's must).
    const msg = String(a.msg || '').replace(/[<>]/g, '').trim();
    if (msg) {
      const bad = textProblem(msg, 'A trade message', MSG_MAX);
      if (bad) fail(bad);
      this.srv.social.mayWrite(who);
    }
    this.srv.social.limit('offer', user.id);
    const reserved = this.reserved(user.id);
    return this.srv.store.lock([user.id, other.id], async (entries) => {
      const me = entries.find((e) => e.id === user.id), them = entries.find((e) => e.id === other.id);
      const pick = (st, uids, whose) => uids.map((u) => {
        const it = st.inv.find((i) => i.uid === u);
        if (!it && whose === 'You' && storedItem(st, u)) fail(`${itemName(storedItem(st, u))} is in a Storage Unit. Retrieve it first.`);
        if (!it) fail(`${whose} no longer ${whose === 'You' ? 'have' : 'has'} one of these items`);
        if (it.lk) fail(`${itemName(it)} is locked`);
        if (isUnit(it)) fail("Storage Units can't be traded");
        if (isBound(it)) fail(`${itemName(it)} can't be traded (only pins from capsules trade)`);
        return structuredClone(it);
      });
      const giveItems = pick(me.st, give.uids, 'You');
      const getItems = pick(them.st, get.uids, other.name);
      for (const u of give.uids) if (reserved.has(u)) fail('One of your items is already in another open offer');
      if (give.money > me.st.money + 1e-9) fail('You don’t have that much money');
      const now = Date.now();
      const t = {
        id: crypto.randomUUID(), from_id: user.id, to_id: other.id, status: 'open', version: 1, created: now, updated: now,
        offer: { give, get, msg, fromName: me.name, toName: them.name, giveItems, getItems, ...(hidden ? { hidden } : {}) },
      };
      await this.srv.db.query('INSERT INTO trades (id, from_id, to_id, status, version, offer, created, updated) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)',
        [t.id, t.from_id, t.to_id, t.status, t.version, JSON.stringify(t.offer), now, now]);
      this.open.set(t.id, t);
      let countered = null;
      if (a.counterOf) {
        const c = this.open.get(String(a.counterOf));
        if (c && c.to_id === user.id && !c.offer.hidden) { await this.close(c, 'countered'); countered = c.id; }
      }
      await this.push([t.id, countered], [countered]); // (the countered offer: its status only)
      if (!hidden) this.srv.notice(other.id, `New trade offer from <b>${me.name}</b>`);
      return { id: t.id };
    });
  }

  async close(t, status) {
    const now = Date.now();
    await this.srv.db.query('UPDATE trades SET status = $1, version = version + 1, updated = $2 WHERE id = $3', [status, now, t.id]);
    this.open.delete(t.id);
  }

  async setStatus(user, { id }, status, side) {
    const t = this.open.get(String(id));
    // (a hidden offer never reached the player it's to, so it isn't theirs to answer)
    if (!t || t[side + '_id'] !== user.id || (side === 'to' && t.offer.hidden)) fail('That offer is no longer open');
    await this.close(t, status);
    await this.pushClosed(t.id);
    if (status === 'declined') this.srv.notice(t.from_id, `<b>${t.offer.toName}</b> declined your trade offer`);
    return {};
  }

  async accept(user, { id, version }) {
    const t = this.open.get(String(id));
    if (!t || t.to_id !== user.id || t.offer.hidden) fail('That offer is no longer open');
    if (version != null && Number(version) !== t.version) fail('The offer changed. Check it again.');
    const result = await this.srv.store.lock([t.from_id, t.to_id], async (entries) => {
      if (!this.open.has(t.id)) fail('That offer is no longer open');
      const from = entries.find((e) => e.id === t.from_id), to = entries.find((e) => e.id === t.to_id);
      // (One of yours it asks for is on the Market (server/p2pmarket.mjs): still yours, so the offer stays open for when the
      // listing comes down. Sold, it's gone: closeRelying closes the offer then.)
      const listed = listedOf(to.st).find((x) => t.offer.get.uids.includes(x.uid));
      if (listed) throw new GameError(`${itemName(listed)} is listed on the Market. Cancel its listing in My listings to trade it.`);
      // Re-check everything against the current inventories before changing anything.
      const problem = (() => {
        const has = (st, uids) => uids.every((u) => st.inv.some((i) => i.uid === u && !i.lk));
        if (!has(from.st, t.offer.give.uids)) return `${t.offer.fromName} no longer has all the offered items`;
        if (!has(to.st, t.offer.get.uids)) return 'You no longer have all the requested items (or some are locked)';
        if (from.st.money + 1e-9 < t.offer.give.money) return `${t.offer.fromName} doesn't have enough money any more`;
        if (to.st.money + 1e-9 < t.offer.get.money) return 'You don’t have enough money';
        const cap = this.srv.INV_CAP;
        if (capCount(from.st.inv) - t.offer.give.uids.length + t.offer.get.uids.length > cap || capCount(to.st.inv) - t.offer.get.uids.length + t.offer.give.uids.length > cap) return 'An inventory would be over the limit';
        return '';
      })();
      if (problem) {
        await this.close(t, 'failed');
        throw new GameError(`Trade failed: ${problem}`);
      }
      const cf = makeCtx(from.st, { online: true }), ct = makeCtx(to.st, { online: true });
      const a = take(cf, t.offer.give.uids, { allowLocked: false });
      const b = take(ct, t.offer.get.uids, { allowLocked: false });
      if (t.offer.give.money) { spend(cf, t.offer.give.money); credit(ct, t.offer.give.money); }
      if (t.offer.get.money) { spend(ct, t.offer.get.money); credit(cf, t.offer.get.money); }
      give(ct, a.map((it) => ({ ...it, nw: true })));
      give(cf, b.map((it) => ({ ...it, nw: true })));
      const now = Date.now();
      await this.srv.store.commit([from, to], async (q) => {
        await q("UPDATE trades SET status = 'accepted', version = version + 1, updated = $1 WHERE id = $2", [now, t.id]);
      });
      this.open.delete(t.id);
      return { df: delta(cf), dt: delta(ct) };
    });
    this.srv.deltaTo(t.from_id, result.df, `<b>${t.offer.toName}</b> accepted your trade offer`);
    this.srv.deltaTo(t.to_id, result.dt, null, true);
    // Offers that relied on items that just moved can no longer go through.
    for (const o of [...this.open.values()]) {
      const gone = (uids, owner) => uids.some((u) => !this.srv.store.cache.get(owner)?.st.inv.some((i) => i.uid === u));
      if ((o.from_id === t.from_id || o.from_id === t.to_id || o.to_id === t.from_id || o.to_id === t.to_id) &&
        (gone(o.offer.give.uids, o.from_id) || gone(o.offer.get.uids, o.to_id))) {
        await this.close(o, 'failed');
        await this.pushClosed(o.id);
      }
    }
    await this.pushClosed(t.id);
    return { ok: true, d: result.dt };
  }
  // Items of a player's just went to someone else outside a trade (sold on the Market, server/p2pmarket.mjs): the open offers
  // that gave or asked for them can no longer go through, so they close as failed, as after an accept above.
  async closeRelying(ownerId, uids) {
    const gone = new Set(uids);
    for (const o of [...this.open.values()]) {
      if ((o.from_id === ownerId && o.offer.give.uids.some((u) => gone.has(u))) || (o.to_id === ownerId && o.offer.get.uids.some((u) => gone.has(u)))) {
        await this.close(o, 'failed');
        await this.pushClosed(o.id);
      }
    }
  }
}

function norm(r) {
  return { ...r, version: Number(r.version), offer: typeof r.offer === 'string' ? JSON.parse(r.offer) : r.offer };
}
