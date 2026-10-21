// Trade offers between players. Items offered are reserved (can't be sold or used) while the offer is open.
// Accepting re-checks both sides and swaps everything in one database transaction.
import crypto from 'node:crypto';
import { makeCtx, delta, take, give, spend, credit, GameError } from '../src/js/engine/actions.js';
import { itemName } from '../src/js/engine/items.js';
import { round2 } from '../src/js/engine/util.js';

const MAX_ITEMS = 100, MAX_OPEN = 20, MAX_LIST = 30;
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

  async list(userId) {
    const { rows } = await this.srv.db.query(
      'SELECT * FROM trades WHERE from_id = $1 OR to_id = $1 ORDER BY updated DESC LIMIT ' + MAX_LIST, [userId]);
    return rows.map(norm).map((t) => this.view(t));
  }
  view(t) {
    return {
      id: t.id, status: t.status, version: t.version, created: Number(t.created), updated: Number(t.updated), msg: t.offer.msg || '',
      from: { id: t.from_id, name: t.offer.fromName }, to: { id: t.to_id, name: t.offer.toName },
      give: { items: t.offer.giveItems, money: t.offer.give.money }, get: { items: t.offer.getItems, money: t.offer.get.money },
    };
  }
  async pushLists(...ids) {
    for (const id of new Set(ids)) if (this.srv.isOnline(id)) this.srv.sendTo(id, { t: 'trades', trades: await this.list(id) });
  }

  async rpc(user, m, a = {}) {
    switch (m) {
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
    return { name: other.name, items: e.st.inv.filter((i) => !i.lk).slice(0, 1500) };
  }

  async offer(user, a) {
    const other = await this.findUser(a.to);
    if (other.id === user.id) fail("You can't trade with yourself");
    if ([...this.open.values()].filter((t) => t.from_id === user.id).length >= MAX_OPEN) fail(`You have ${MAX_OPEN} open offers. Cancel some first.`);
    const give = { uids: uidList(a.give?.uids), money: money(a.give?.money) };
    const get = { uids: uidList(a.get?.uids), money: money(a.get?.money) };
    if (!give.uids.length && !get.uids.length && !give.money && !get.money) fail('The offer is empty');
    const msg = String(a.msg || '').replace(/[<>]/g, '').slice(0, 140);
    const reserved = this.reserved(user.id);
    return this.srv.store.lock([user.id, other.id], async (entries) => {
      const me = entries.find((e) => e.id === user.id), them = entries.find((e) => e.id === other.id);
      const pick = (st, uids, whose) => uids.map((u) => {
        const it = st.inv.find((i) => i.uid === u);
        if (!it) fail(`${whose} no longer ${whose === 'You' ? 'have' : 'has'} one of these items`);
        if (it.lk) fail(`${itemName(it)} is locked`);
        return structuredClone(it);
      });
      const giveItems = pick(me.st, give.uids, 'You');
      const getItems = pick(them.st, get.uids, other.name);
      for (const u of give.uids) if (reserved.has(u)) fail('One of your items is already in another open offer');
      if (give.money > me.st.money + 1e-9) fail('You don’t have that much money');
      const now = Date.now();
      const t = {
        id: crypto.randomUUID(), from_id: user.id, to_id: other.id, status: 'open', version: 1, created: now, updated: now,
        offer: { give, get, msg, fromName: me.name, toName: them.name, giveItems, getItems },
      };
      await this.srv.db.query('INSERT INTO trades (id, from_id, to_id, status, version, offer, created, updated) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)',
        [t.id, t.from_id, t.to_id, t.status, t.version, JSON.stringify(t.offer), now, now]);
      this.open.set(t.id, t);
      if (a.counterOf) {
        const c = this.open.get(String(a.counterOf));
        if (c && c.to_id === user.id) await this.close(c, 'countered');
      }
      await this.pushLists(user.id, other.id);
      this.srv.notice(other.id, `New trade offer from <b>${me.name}</b>`);
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
    if (!t || t[side + '_id'] !== user.id) fail('That offer is no longer open');
    await this.close(t, status);
    await this.pushLists(t.from_id, t.to_id);
    if (status === 'declined') this.srv.notice(t.from_id, `<b>${t.offer.toName}</b> declined your trade offer`);
    return {};
  }

  async accept(user, { id, version }) {
    const t = this.open.get(String(id));
    if (!t || t.to_id !== user.id) fail('That offer is no longer open');
    if (version != null && Number(version) !== t.version) fail('The offer changed. Check it again.');
    const result = await this.srv.store.lock([t.from_id, t.to_id], async (entries) => {
      if (!this.open.has(t.id)) fail('That offer is no longer open');
      const from = entries.find((e) => e.id === t.from_id), to = entries.find((e) => e.id === t.to_id);
      // Re-check everything against the current inventories before changing anything.
      const problem = (() => {
        const has = (st, uids) => uids.every((u) => st.inv.some((i) => i.uid === u && !i.lk));
        if (!has(from.st, t.offer.give.uids)) return `${t.offer.fromName} no longer has all the offered items`;
        if (!has(to.st, t.offer.get.uids)) return 'You no longer have all the requested items (or some are locked)';
        if (from.st.money + 1e-9 < t.offer.give.money) return `${t.offer.fromName} doesn't have enough money any more`;
        if (to.st.money + 1e-9 < t.offer.get.money) return 'You don’t have enough money';
        const cap = this.srv.INV_CAP;
        if (from.st.inv.length - t.offer.give.uids.length + t.offer.get.uids.length > cap || to.st.inv.length - t.offer.get.uids.length + t.offer.give.uids.length > cap) return 'An inventory would be over the limit';
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
        await this.pushLists(o.from_id, o.to_id);
      }
    }
    await this.pushLists(t.from_id, t.to_id);
    return { ok: true, d: result.dt };
  }
}

function norm(r) {
  return { ...r, version: Number(r.version), offer: typeof r.offer === 'string' ? JSON.parse(r.offer) : r.offer };
}
