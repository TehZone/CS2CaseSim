// The item database's float records (social 'db.floats', the Item Database page's "Lowest floats" and "Highest floats"):
// the copies with the lowest or highest floats of any skin on the server, every player's inventory and Storage Units
// together, in one category (every copy, Normal, StatTrak™ or Souvenir). Engine side: floatRecords in
// src/js/engine/database.js, which the page uses offline and which orders copies the same way.
//
// What it costs: items live inside each player's state (JSONB arrays), which no index can reach, so the lists take one
// pass over every item every player owns, as db.index's counts do. It's one pass for all eight lists (each direction in
// each category): the skins with a float are read out once (a MATERIALIZED CTE) and each list is an ORDER BY ... LIMIT
// over those, a top-N heapsort holding its 100 rows. That pass runs at most once every FLOATS_MS, counted from when the
// last one ended (so a slow one isn't run back to back), for every player at once; players asking while it runs wait on
// it, and a smaller limit is a slice of the same list. So the work grows with the items on the server, not with how many
// players ask, how often, or which lists. (Past a few million items the real fix is an items table with an index on the
// float, which needs the saves split up.)
// Also here: db.item for an item with more copies than it sends (ItemCopies).
import { fail, int } from '../src/js/engine/admin.js';
import { COPY_CATS, FLOAT_TOP, publicCopy } from '../src/js/engine/database.js';

export const FLOATS_MS = 15000; // (as db.index's counts are kept)
const DIRS = ['low', 'high'];
// Every list the pass works out, as 'dir:cat' (low:all, low:n, ... high:sv).
const LISTS = DIRS.flatMap((dir) => COPY_CATS.map((cat) => dir + ':' + cat));
// A copy's category in SQL, as copyCategory has it.
const CAT = `CASE WHEN it->>'sv' = 'true' THEN 'sv' WHEN it->>'stt' = 'true' THEN 'st' ELSE 'n' END`;

export class FloatRecords {
  // db: query(sql, params); fresh(): writes what's only in memory first; owned(u): the FROM clause of a player's items.
  constructor({ db, fresh, owned }) {
    this.db = db;
    this.fresh = fresh;
    this.owned = owned;
    this.now = () => Date.now(); // (the cache's clock: tests move it)
    this.cache = null; // { at: when its pass ended (null while it runs), lists: Promise<Map 'dir:cat' -> [{ id, name, item }]> }
  }

  // { dir: 'low' | 'high', cat: 'all' | 'n' | 'st' | 'sv', limit: 1..FLOAT_TOP }, each optional (low, all, FLOAT_TOP).
  static args(a) {
    const dir = a?.dir ?? 'low', cat = a?.cat ?? 'all';
    if (!DIRS.includes(dir)) fail('Which floats: low or high');
    if (!COPY_CATS.includes(cat)) fail('Unknown category');
    return { dir, cat, limit: int(a?.limit ?? FLOAT_TOP, 'Limit', 1, FLOAT_TOP) };
  }

  // → { dir, cat, copies: [{ owner, id, me, item }] } (as db.item's copies), best first.
  async rpc(user, a) {
    const { dir, cat, limit } = FloatRecords.args(a);
    const rows = (await this.lists()).get(dir + ':' + cat);
    return { dir, cat, copies: rows.slice(0, limit).map((x) => ({ owner: x.name, id: x.id, me: x.id === user.id, item: x.item })) };
  }

  // Every list, from the last pass or a new one (see the top). A failed pass isn't kept.
  lists() {
    let c = this.cache;
    if (!c || (c.at != null && this.now() - c.at > FLOATS_MS)) {
      c = this.cache = { at: null, lists: this.query() };
      c.lists.then(() => { c.at = this.now(); }, () => { if (this.cache === c) this.cache = null; });
    }
    return c.lists;
  }

  async query() {
    await this.fresh();
    // Each list: its category's skins (or every one) by float, ties as db.ranks and floatRanks have them (the highest are
    // the lowest backwards); n numbers its rows in that order.
    const list = (key, l) => {
      const [dir, cat] = key.split(':'), o = dir === 'high' ? 'DESC' : 'ASC';
      return `(SELECT ${l} AS l, (ROW_NUMBER() OVER ())::int AS n, id, name, it FROM (SELECT id, name, it FROM c${cat === 'all' ? '' : ` WHERE cat = '${cat}'`}
        ORDER BY fl ${o}, at ${o}, uid ${o} LIMIT ${FLOAT_TOP}) s)`;
    };
    const { rows } = await this.db.query(`WITH c AS MATERIALIZED (
        SELECT u.id, u.name, it, (it->>'fl')::float8 AS fl, COALESCE((it->>'at')::float8, 0) AS at, it->>'uid' AS uid, ${CAT} AS cat
        FROM users u, ${this.owned('u')} AS it WHERE it->>'t' = 'skin' AND it->>'fl' IS NOT NULL)
      ${LISTS.map(list).join('\n      UNION ALL ')}`);
    const lists = new Map(LISTS.map((k) => [k, []]));
    for (const x of rows.sort((a, b) => a.l - b.l || a.n - b.n)) {
      lists.get(LISTS[x.l]).push({ id: x.id, name: x.name, item: publicCopy(typeof x.it === 'string' ? JSON.parse(x.it) : x.it) });
    }
    return lists;
  }
}

// db.item, for an item with more copies than it sends (cap): the copies at both ends of each category's floats (the oldest
// and newest of what has no float), as many of each as fit (3 at least, so floatRanks over them gives every copy's ranks),
// and the counts of every copy. Every float record of the item is among them (a top-100 copy is in its category's lowest
// or highest 100, and 5,000 leaves 833 an end).
// → { copies: [{ id, name, it }], counts: { total, owners, cats: { n, st, sv }, pats: { 'cat:sd': n } } } (pats as
// patternCounts keys them: cat 'all' or a copy's own). One pass over every item, as db.item's own is.
export const DB_COPIES = 5000;
export class ItemCopies {
  constructor({ db, owned }) {
    this.db = db;
    this.owned = owned;
    this.cap = DB_COPIES; // (tests lower it)
  }

  async many(t, id) {
    const { rows } = await this.db.query(`WITH c AS MATERIALIZED (
        SELECT u.id, u.name, it, (it->>'fl')::float8 AS fl, COALESCE((it->>'at')::float8, 0) AS at, it->>'uid' AS uid, it->>'sd' AS sd, ${CAT} AS cat
        FROM users u, ${this.owned('u')} AS it WHERE it->>'t' = $1 AND it->>'id' = $2),
      lim AS (SELECT GREATEST(3, ${this.cap | 0} / (2 * GREATEST(1, count(DISTINCT cat)))) AS k FROM c),
      r AS (SELECT id, name, it, ROW_NUMBER() OVER (PARTITION BY cat ORDER BY fl ASC NULLS LAST, at ASC, uid ASC) AS lo,
          ROW_NUMBER() OVER (PARTITION BY cat ORDER BY fl DESC NULLS LAST, at DESC, uid DESC) AS hi FROM c)
      SELECT 'copy' AS kind, r.id, r.name, r.it, NULL::text AS cat, NULL::text AS sd, NULL::int AS n, NULL::int AS owners
        FROM r, lim WHERE r.lo <= lim.k OR r.hi <= lim.k
      UNION ALL
      SELECT 'count', NULL, NULL, NULL, cat, sd, count(*)::int, count(DISTINCT id)::int FROM c GROUP BY GROUPING SETS ((cat, sd), ())`, [t, id]);
    const copies = [], counts = { total: 0, owners: 0, cats: { n: 0, st: 0, sv: 0 }, pats: {} };
    for (const x of rows) {
      if (x.kind === 'copy') copies.push(x);
      else if (x.cat == null) { counts.total = x.n; counts.owners = x.owners; } // (the () set: every copy)
      else {
        counts.cats[x.cat] += x.n;
        if (x.sd != null) { counts.pats['all:' + x.sd] = (counts.pats['all:' + x.sd] || 0) + x.n; counts.pats[x.cat + ':' + x.sd] = x.n; }
      }
    }
    return { copies, counts };
  }
}
