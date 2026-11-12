// Player state on the server: cached in memory, changed one request at a time per player (a lock per player),
// and written to the database. Single-player changes are written within a couple of seconds; anything that moves
// value between players (trades, gambling escrow and payouts) is written for everyone involved in one transaction
// before the request is answered.
import { upgradeState } from '../src/js/engine/economy.js';
import { retireOld } from '../src/js/engine/items.js';
import { backfillIndex } from '../src/js/engine/itemindex.js';
import { grantMedals } from '../src/js/engine/badges.js';

const FLUSH_MS = 2000;
const IDLE_EVICT_MS = 10 * 60 * 1000;
// peek's copies of players who aren't in memory, kept a minute so that looking at one again (their profile, then a Storage
// Unit of theirs) doesn't read and parse their whole state again: 100 full Storage Units are 100,000 items, about 19 MB of
// JSON and 400 ms of the server's thread to read. At most PEEK_ITEMS items in all (a few such players, or many smaller ones).
const PEEK_MS = 60 * 1000, PEEK_ITEMS = 300000, PEEK_MAX = 200;
const itemsIn = (st) => (st.inv?.length || 0) + (st.stored?.length || 0) + (st.listed?.length || 0);
// A player's whole state written, and with it their featured badge (users.badge, server/social.mjs) cleared when the state no
// longer has one of it: in the inventory or a Storage Unit (engine/badges.js ownsBadge). Every change that can take a badge
// away (a trade, a sale, a stake, staff) is written through here. `cleared`: this write took it off (the sub-select sees the row
// as it was), which the server tells every game that draws faces (Store's onCleared).
const WRITE = `UPDATE users SET state = $1::jsonb, last_seen = $2, badge = CASE WHEN badge = ANY($4::text[]) THEN badge END WHERE id = $3
  RETURNING (badge IS NULL AND (SELECT badge FROM users WHERE id = $3) IS NOT NULL) AS cleared`;
export function badgeIds(st) {
  const ids = new Set();
  for (const list of [st.inv, st.stored]) for (const it of Array.isArray(list) ? list : []) if (it?.t === 'badge') ids.add(String(it.id));
  return [...ids];
}

export class Store {
  constructor(db, { log = () => {} } = {}) {
    this.db = db;
    this.log = log;
    this.cache = new Map(); // id -> { id, name, st, dirty, touched }
    this.locks = new Map(); // id -> tail promise
    this.online = new Set(); // ids with an open connection
    this.peeked = new Map(); // id -> { st, at, n }: peek's copies (PEEK_MS), the least recently used first
    this.peekedItems = 0;
    this.onCleared = null; // (id): a write took their featured badge off (WRITE), once it's in the database
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
    this.unpeek(id); // (memory's copy is the one from now on)
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
    // The Service Medals' badges for prestiges from before they came with them (and any staff gave by raising the medals),
    // once: the profile lists those given (engine/badges.js grantMedals). Here, so the welcome has them.
    if (grantMedals(st).length) dirty = true;
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

  // A player's state to look at and let go: load's, without keeping it in memory as a player's, so that looking at a lot of
  // players doesn't hold them all. One that isn't in memory is kept a minute as it was read (PEEK_MS), unless this server
  // writes them or loads them meanwhile. (Not for changing: unless they're in memory it isn't the copy that gets saved, and a
  // peeked copy is shared by everyone looking. isPeeked says which a state is.)
  async peek(id) {
    const e = this.cache.get(id);
    if (e) return e.st;
    const kept = this.peeked.get(id);
    if (kept && Date.now() - kept.at < PEEK_MS) { this.peeked.delete(id); this.peeked.set(id, kept); return kept.st; }
    const { rows } = await this.db.query('SELECT state FROM users WHERE id = $1', [id]);
    if (!rows.length) throw new Error('No such player');
    const st = upgradeState(typeof rows[0].state === 'string' ? JSON.parse(rows[0].state) : rows[0].state);
    retireOld(st);
    grantMedals(st); // (as loading them would: their profile shows the medals' badges they'll have)
    if (this.cache.has(id)) return this.cache.get(id).st; // (loaded meanwhile: that copy is the one)
    this.unpeek(id);
    const n = itemsIn(st);
    if (n <= PEEK_ITEMS) {
      this.peeked.set(id, { st, at: Date.now(), n });
      this.peekedItems += n;
      for (const [old, p] of this.peeked) {
        if (this.peekedItems <= PEEK_ITEMS && this.peeked.size <= PEEK_MAX && Date.now() - p.at < PEEK_MS) break;
        this.unpeek(old);
      }
    }
    return st;
  }
  // Whether a state is one of peek's copies, which never change (what's worked out from one can be kept with it).
  isPeeked(id, st) { return this.peeked.get(id)?.st === st; }
  unpeek(id) {
    const p = this.peeked.get(id);
    if (!p) return;
    this.peeked.delete(id);
    this.peekedItems -= p.n;
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
      const cleared = [];
      await this.db.tx(async (q) => {
        for (const e of entries) if ((await q(WRITE, [JSON.stringify(e.st), Date.now(), e.id, badgeIds(e.st)])).rows[0]?.cleared) cleared.push(e.id);
        await extra(q);
      });
      for (const e of entries) { e.dirty = false; this.unpeek(e.id); }
      for (const id of cleared) this.onCleared?.(id);
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
        const { rows } = await this.db.query(WRITE, [JSON.stringify(e.st), Date.now(), e.id, badgeIds(e.st)]);
        this.unpeek(e.id);
        if (rows[0]?.cleared) this.onCleared?.(e.id);
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
