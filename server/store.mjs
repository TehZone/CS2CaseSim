// Player state on the server: cached in memory, changed one request at a time per player (a lock per player),
// and written to the database. Single-player changes are written within a couple of seconds; anything that moves
// value between players (trades, gambling escrow and payouts) is written for everyone involved in one transaction
// before the request is answered.
import { upgradeState, idleRate, offlineEarnings } from '../src/js/engine/economy.js';
import { round2 } from '../src/js/engine/util.js';

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
    e = this.cache.get(id); // loaded meanwhile
    if (e) return e;
    e = { id: rows[0].id, name: rows[0].name, st: upgradeState(typeof rows[0].state === 'string' ? JSON.parse(rows[0].state) : rows[0].state), dirty: false, touched: Date.now() };
    delete e.st.settings;
    this.cache.set(id, e);
    return e;
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

  async flush() {
    const dirty = [...this.cache.values()].filter((e) => e.dirty);
    for (const e of dirty) {
      if (this.locks.has(e.id)) continue; // being changed right now; next round
      e.dirty = false;
      try {
        await this.db.query('UPDATE users SET state = $1::jsonb, last_seen = $2 WHERE id = $3', [JSON.stringify(e.st), Date.now(), e.id]);
      } catch (err) {
        e.dirty = true;
        throw err;
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

// Passive income on the server. Connected players earn the full rate; time away earns the offline rate (half,
// at most 8 hours), like the offline game. Returns money earned (and marks the change in ctx when given).
export function tickIdle(st, now, { away = false } = {}) {
  const last = st.lastTick || now;
  st.lastTick = now;
  const dt = Math.max(0, (now - last) / 1000);
  if (!dt) return 0;
  const earned = away ? offlineEarnings(st, dt) : Math.floor(idleRate(st) * Math.min(dt, 120) * 100) / 100;
  if (earned > 0) {
    st.money = round2(st.money + earned);
    st.stats.passiveEarned = round2((st.stats.passiveEarned || 0) + earned);
  }
  return earned;
}
