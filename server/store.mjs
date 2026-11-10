// Player state on the server: cached in memory, changed one request at a time per player (a lock per player),
// and written to the database. Single-player changes are written within a couple of seconds; anything that moves
// value between players (trades, gambling escrow and payouts) is written for everyone involved in one transaction
// before the request is answered.
import { upgradeState } from '../src/js/engine/economy.js';
import { retireOld } from '../src/js/engine/items.js';
import { backfillIndex } from '../src/js/engine/itemindex.js';

const FLUSH_MS = 2000;
const IDLE_EVICT_MS = 10 * 60 * 1000;

export class Store {
  constructor(db, { log = () => {} } = {}) {
    this.db = db;
    this.log = log;
    this.cache = new Map(); // id -> { id, name, st, dirty, touched }
    this.locks = new Map(); // id -> tail promise
    this.online = new Set(); // ids with an open connection
    this.timer = setInterval(() => this.flush().catch((e) => log('[store] flush failed', e.message)), FLUSH_MS);
  }

  async load(id) {
    let e = this.cache.get(id);
    if (e) { e.touched = Date.now(); return e; }
    const { rows } = await this.db.query('SELECT id, name, state FROM users WHERE id = $1', [id]);
    if (!rows.length) throw new Error('No such player');
    const { st, dirty } = await this.fromRow(id, rows[0].state);
    e = this.cache.get(id); // loaded meanwhile
    if (e) return e;
    e = { id: rows[0].id, name: rows[0].name, st, dirty, touched: Date.now() };
    this.cache.set(id, e);
    return e;
  }

  // A saved state as memory keeps it: brought up to date, without the game's settings. → { st, dirty (it changed) }
  async fromRow(id, state) {
    const saved = typeof state === 'string' ? JSON.parse(state) : state;
    const moved = saved.index?.filled ? null : await this.changedHands(id); // (accounts from before the Index, once)
    const st = upgradeState(saved);
    delete st.settings;
    let dirty = false;
    if (retireOld(st).n) dirty = true; // older accounts' chickens and pro cards, sold once
    if (moved) { backfillIndex(st, { moved }); dirty = true; }
    return { st, dirty };
  }

  // Reads a player's row again into their entry, which stays the same object (the caller holds their lock): another server
  // instance has written the row since this copy of it was loaded (two running at once in a deploy: server/passive.mjs).
  async reload(e) {
    const { rows } = await this.db.query('SELECT name, state FROM users WHERE id = $1', [e.id]);
    if (!rows.length) throw new Error('No such player');
    Object.assign(e, { name: rows[0].name, ...(await this.fromRow(e.id, rows[0].state)), touched: Date.now() });
    return e;
  }

  // A player's state to look at and let go: load's, without keeping it, so that looking at a lot of players doesn't hold them
  // all in memory. (Not for changing: unless they're in memory it isn't the copy that gets saved.)
  async peek(id) {
    const e = this.cache.get(id);
    if (e) return e.st;
    const { rows } = await this.db.query('SELECT state FROM users WHERE id = $1', [id]);
    if (!rows.length) throw new Error('No such player');
    const st = upgradeState(typeof rows[0].state === 'string' ? JSON.parse(rows[0].state) : rows[0].state);
    retireOld(st);
    return st;
  }

  // Every item that's been through a player's accepted trades or live gambling rounds (a trade keeps an item's `src`, so only
  // this tells what they unboxed from what they were given). One a round gave back is in here too: better a copy left off the
  // Index than one that was never theirs.
  async changedHands(id) {
    const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
    const out = new Set();
    const { rows: trades } = await this.db.query("SELECT offer FROM trades WHERE status = 'accepted' AND (from_id = $1 OR to_id = $1)", [id]);
    for (const { offer } of trades) { const o = parse(offer); for (const u of [...(o.give?.uids || []), ...(o.get?.uids || [])]) out.add(u); }
    const { rows: rounds } = await this.db.query("SELECT data->'escrow' AS escrow FROM rounds WHERE jsonb_exists(data->'escrow', $1)", [String(id)]);
    for (const { escrow } of rounds) for (const seat of Object.values(parse(escrow))) for (const it of seat.items || []) out.add(it.uid);
    return out;
  }

  // Runs fn while holding the locks of all the given players (taken in id order, so two requests can't deadlock).
  async lock(ids, fn) {
    ids = [...new Set(ids)].sort((a, b) => a - b);
    const prev = ids.map((id) => this.locks.get(id) || Promise.resolve());
    let release;
    const mine = new Promise((r) => (release = r));
    for (const id of ids) this.locks.set(id, mine);
    await Promise.all(prev.map((p) => p.catch(() => {})));
    try {
      const entries = [];
      for (const id of ids) entries.push(await this.load(id));
      return await fn(entries);
    } finally {
      release();
      for (const id of ids) if (this.locks.get(id) === mine) this.locks.delete(id);
    }
  }
  withUser(id, fn) { return this.lock([id], ([e]) => fn(e)); }

  // Writes these players (and any extra statements) in one transaction. If that fails, the in-memory state is
  // reloaded from the database so memory never claims something the database doesn't have.
  async commit(entries, extra = async () => {}) {
    try {
      await this.db.tx(async (q) => {
        for (const e of entries) await q('UPDATE users SET state = $1::jsonb, last_seen = $2 WHERE id = $3', [JSON.stringify(e.st), Date.now(), e.id]);
        await extra(q);
      });
      for (const e of entries) e.dirty = false;
    } catch (err) {
      for (const e of entries) this.cache.delete(e.id);
      throw err;
    }
  }

  markDirty(e) { e.dirty = true; e.touched = Date.now(); }

  // Writes only these top-level fields of a player's saved state (`next`), the rest of the row left as the database has it,
  // and only if the database still has each of them as `was` (this copy's, before the change): another server instance (two
  // run at once in a deploy) may have written the row since this copy was loaded. For a change the server makes by itself on
  // a timer (passive income, server/passive.mjs), which mustn't write back this copy's view of the rest of the row. Not
  // last_seen (when they last changed something). → whether it was written.
  async patch(e, was, next) {
    const args = [e.id], where = [];
    let set = 'state';
    for (const [k, v] of Object.entries(next)) {
      args.push(k, JSON.stringify(v), was[k] === undefined ? null : JSON.stringify(was[k]));
      const n = args.length;
      set = `jsonb_set(${set}, ARRAY[$${n - 2}::text], $${n - 1}::jsonb)`;
      where.push(`state -> $${n - 2}::text IS NOT DISTINCT FROM $${n}::jsonb`);
    }
    const { rows } = await this.db.query(`UPDATE users SET state = ${set} WHERE id = $1 AND ${where.join(' AND ')} RETURNING id`, args);
    e.touched = Date.now();
    return rows.length > 0;
  }

  async flush() {
    const dirty = [...this.cache.values()].filter((e) => e.dirty);
    for (const e of dirty) {
      if (this.locks.has(e.id)) continue; // being changed right now; next round
      e.dirty = false;
      // (saving: the row is on its way with this copy as it is now, so a change meanwhile goes in the next write, not a patch)
      e.saving = true;
      try {
        await this.db.query('UPDATE users SET state = $1::jsonb, last_seen = $2 WHERE id = $3', [JSON.stringify(e.st), Date.now(), e.id]);
      } catch (err) {
        e.dirty = true;
        throw err;
      } finally {
        e.saving = false;
      }
    }
    const now = Date.now();
    for (const e of [...this.cache.values()]) {
      if (!e.dirty && !this.online.has(e.id) && !this.locks.has(e.id) && now - e.touched > IDLE_EVICT_MS) this.cache.delete(e.id);
    }
  }

  async close() {
    clearInterval(this.timer);
    await this.flush();
  }
}
