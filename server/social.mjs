// Friends & Chat online: profiles, friends, blocks, private messages and reports between real players (ns 'social', the
// requests index.mjs' social() doesn't answer itself; the page is src/js/pages/community-online.js). Players are a numeric
// id plus their current name, as the `Person` a request gets back: { id, name, avatar, country, level, online, seen }. (Only
// `find` and `profile` always have a level: see people.)
//
// What a player writes is kept exactly as sent and never escaped here: whatever shows it goes through esc().
//
// Private means private: no staff request reads messages. All staff ever see of a conversation is the copy a report saved
// (`reports` in admin.mjs), so a new staff screen must not read this table.
//
// A blocked player isn't told, so nothing they can see differs from being ignored: their profile of you is a plain one, what
// they ask of you looks as it would for anyone (a friend request sits in Requests sent and never arrives, a trade offer stays
// open and never arrives, see trade.mjs), and a message is refused in the same words as one to a friends-only player.
import { fail, int, bool, isObj, text as shortText, worthOf } from '../src/js/engine/admin.js';
import { D } from '../src/js/engine/data.js';
import { publicCopy } from '../src/js/engine/database.js';
import { isUnit, itemValue } from '../src/js/engine/items.js';
import { medalOf } from '../src/js/engine/levels.js';
import { contents, storedOf, unitCount, unitsOf, unitValue } from '../src/js/engine/storage.js';
import { plainText, textProblem } from '../src/js/engine/tools.js';

const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN;
const MSG_MAX = 300, BIO_MAX = 300, KEEP = 200, PAGE = 50, FIND_MAX = 30, SHOWCASE_MAX = 6, REPORT_COPY = 30, CHATS_MAX = 100, BLOCKS_MAX = 500;
const INV_SHOWN = 300; // a profile's Inventory tab: the most valuable, as many as a page can draw quickly
const DMS = ['everyone', 'friends'];
const FRESH = { bio: '', country: '', avatar: null, bg: null, showcase: [], dms: 'everyone' };
// Per player, across their tabs, over a sliding window. The last rule has the longest window.
const LIMITS = {
  chat: [{ max: 5, ms: 5 * SEC, say: 'Slow down: at most 5 messages in 5 seconds' }, { max: 60, ms: MIN, say: 'Slow down: at most 60 messages a minute' }],
  friend: [{ max: 30, ms: HOUR, say: 'Too many friend requests: at most 30 an hour' }],
  report: [{ max: 10, ms: HOUR, say: 'Too many reports: at most 10 an hour' }], // (each one posts to the mod log)
  block: [{ max: 30, ms: HOUR, say: 'Too many blocks: at most 30 an hour' }],
  offer: [{ max: 20, ms: MIN, say: 'Slow down: at most 20 trade offers a minute' }, { max: 100, ms: HOUR, say: 'Too many trade offers: at most 100 an hour' }], // (trade.mjs)
  // What's only read. A game asks far less often than these: they're for a script going through every player.
  home: [{ max: 30, ms: 10 * SEC, say: 'Slow down: too many requests' }],
  find: [{ max: 10, ms: 5 * SEC, say: 'Slow down: too many searches' }, { max: 60, ms: MIN, say: 'Slow down: at most 60 searches a minute' }],
  profile: [{ max: 20, ms: 10 * SEC, say: 'Slow down: too many profiles' }, { max: 120, ms: MIN, say: 'Slow down: at most 120 profiles a minute' }],
  unit: [{ max: 20, ms: 10 * SEC, say: 'Slow down: too many Storage Units' }, { max: 120, ms: MIN, say: 'Slow down: at most 120 Storage Units a minute' }],
};
// The two directions of one conversation ($1 and $2 are its players).
const BETWEEN = '((from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1))';
// Each conversation of a player ($1) with its newest message, through the indexes: what it costs goes by their conversations,
// not their messages, and only those rows are read. (`sent` and `got` step through an index from one player to the next, which
// Postgres won't do by itself; a join here instead of LATERAL reads the whole table, as EXPLAIN shows.)
const NEWEST = `WITH RECURSIVE sent(other) AS (
    SELECT min(to_id) FROM messages WHERE from_id = $1
    UNION ALL SELECT (SELECT min(to_id) FROM messages WHERE from_id = $1 AND to_id > other) FROM sent WHERE other IS NOT NULL
  ), got(other) AS (
    SELECT min(from_id) FROM messages WHERE to_id = $1
    UNION ALL SELECT (SELECT min(from_id) FROM messages WHERE to_id = $1 AND from_id > other) FROM got WHERE other IS NOT NULL
  ), others AS (SELECT other FROM sent WHERE other IS NOT NULL UNION SELECT other FROM got WHERE other IS NOT NULL)
  SELECT o.other, m.* FROM others o CROSS JOIN LATERAL (
    SELECT id, from_id, to_id, text, at FROM (
      (SELECT id, from_id, to_id, text, at FROM messages WHERE from_id = $1 AND to_id = o.other ORDER BY id DESC LIMIT 1)
      UNION ALL (SELECT id, from_id, to_id, text, at FROM messages WHERE from_id = o.other AND to_id = $1 ORDER BY id DESC LIMIT 1)
    ) x ORDER BY id DESC LIMIT 1
  ) m`;

const playerId = (v) => int(v, 'Player id', 1, 2 ** 31 - 1);
const like = (s) => '%' + s.replace(/[\\%_]/g, '\\$&') + '%';
const byName = (x, y) => x.name.localeCompare(y.name);
const profileOf = (v) => ({ ...FRESH, ...(typeof v === 'string' ? JSON.parse(v) : v) });
const msgOf = (r) => ({ id: Number(r.id), from: r.from_id, to: r.to_id, text: r.text, at: Number(r.at) });
// An item on a profile: the item database's copy, and what its card and price need besides: a slab's sticker, a charm's
// pattern and the charm on a gun (less where it came from, which is the owner's business as an item's own `src` is).
function shownItem(it) {
  const { src, ...kc } = it.kc || {};
  return { ...publicCopy(it), pat: it.pat, sk: it.sk, ...(it.kc ? { kc } : {}) };
}
// profile's relation: 0 none, 1 friends, 2 they asked you, 3 you asked them. (A request from someone you've blocked isn't one.)
const relationOf = (x, me) => (x.mine ? 0 : x.pal ? 1 : x.asked == null ? 0 : x.asked === me ? 3 : 2);

export class Social {
  constructor(srv) {
    this.srv = srv;
    this.db = srv.db;
    this.now = () => Date.now(); // (the rate limits' clock: the tests move it)
    this.hits = new Map(); // 'kind:id' -> the times of that player's recent attempts
    this.timer = setInterval(() => this.sweep(), 10 * MIN);
    this.timer.unref?.();
  }

  close() { clearInterval(this.timer); }

  sweep() {
    const now = this.now();
    for (const [key, times] of this.hits) if (now - times.at(-1) > HOUR) this.hits.delete(key);
  }

  // Counts an attempt, or refuses it (a refused one doesn't count).
  limit(kind, id) {
    const rules = LIMITS[kind], key = `${kind}:${id}`, now = this.now();
    const times = (this.hits.get(key) || []).filter((t) => now - t < rules.at(-1).ms);
    this.hits.set(key, times);
    for (const { max, ms, say } of rules) if (times.filter((t) => now - t < ms).length >= max) fail(say, 'rate');
    times.push(now);
  }

  // Tells these players' games that their lists changed (null: nobody to tell).
  changed(...ids) { for (const id of ids) if (id != null) this.srv.sendTo(id, { t: 'friends' }); }

  // Map id -> Person. A level comes from memory when a player's there; reading one from the row reads their whole state, so
  // that's only for `levels` (the Find window, the one list that shows them) and otherwise an offline player's is null.
  async people(ids, { levels = false } = {}) {
    const want = [...new Set(ids)], cache = this.srv.store.cache;
    if (!want.length) return new Map();
    const { rows } = await this.db.query(`SELECT id, name, profile, last_seen,
      CASE WHEN id = ANY($2::int[]) THEN (state->'prof'->>'level')::int END AS level FROM users WHERE id = ANY($1::int[])`, [want, levels ? want.filter((id) => !cache.has(id)) : []]);
    return new Map(rows.map((r) => {
      const p = profileOf(r.profile), e = cache.get(r.id);
      return [r.id, { id: r.id, name: r.name, avatar: p.avatar, country: p.country, level: e ? e.st.prof?.level || 1 : levels ? r.level || 1 : null, online: this.srv.isOnline(r.id), seen: Number(r.last_seen) }];
    }));
  }

  // What's between two players: `mine` (me blocking them), `theirs` (them blocking me), `pal` (friends), `asked` (who has a
  // request open), and the pair as the friends table keeps it (a < b).
  async between(me, them) {
    const [a, b] = me < them ? [me, them] : [them, me];
    const { rows: [r] } = await this.db.query(`SELECT
      EXISTS (SELECT 1 FROM blocks WHERE user_id = $1 AND blocked_id = $2) AS mine,
      EXISTS (SELECT 1 FROM blocks WHERE user_id = $2 AND blocked_id = $1) AS theirs,
      f.status, f.asked_by FROM (SELECT 1) x LEFT JOIN friends f ON f.a = $3 AND f.b = $4`, [me, them, a, b]);
    return { a, b, mine: r.mine, theirs: r.theirs, pal: r.status === 'friends', asked: r.status === 'pending' ? r.asked_by : null };
  }

  // Another player, and what's between you. `self`: the refusal for picking yourself.
  async other(user, v, self) {
    const id = playerId(v);
    if (id === user.id) fail(self);
    const { rows } = await this.db.query('SELECT name, profile FROM users WHERE id = $1', [id]);
    if (!rows.length) fail('No such player', 'missing');
    const { dms, bio } = profileOf(rows[0].profile);
    return { id, name: rows[0].name, dms, bio, ...(await this.between(user.id, id)) };
  }

  // Words from you to `other`'s player, whatever carries them (a chat message, a trade offer's). One refusal for both, so being
  // blocked reads like a setting: don't tell them apart here, or in what `profile` sends.
  mayWrite(t) {
    if (t.theirs || (t.dms === 'friends' && !t.pal)) fail(`${t.name} isn't taking messages from you right now`, 'dms');
  }

  // A player's last connection closed, so that's when they were last online: a save only says when they last changed something,
  // and someone who just chats never does. Friends with the page open see it.
  async left(id) {
    await this.db.query('UPDATE users SET last_seen = $1 WHERE id = $2', [Date.now(), id]);
    const { rows } = await this.db.query("SELECT CASE WHEN a = $1 THEN b ELSE a END AS id FROM friends WHERE (a = $1 OR b = $1) AND status = 'friends'", [id]);
    this.changed(...rows.map((r) => r.id));
  }

  // A player's name changed: their lists are kept by id, but a game finds who's online and who to offer to by name.
  async renamed(id) {
    const { rows } = await this.db.query(`SELECT CASE WHEN a = $1 THEN b ELSE a END AS id FROM friends WHERE a = $1 OR b = $1
      UNION SELECT user_id FROM blocks WHERE blocked_id = $1 UNION SELECT to_id FROM messages WHERE from_id = $1 UNION SELECT from_id FROM messages WHERE to_id = $1`, [id]);
    this.changed(id, ...rows.map((r) => r.id));
  }

  async rpc(user, m, args, ws = null) {
    const a = isObj(args) ? args : {};
    switch (m) {
      case 'home': return this.home(user);
      case 'find': return this.find(user, a);
      case 'profile': return this.profile(user, a);
      case 'profile.set': return this.profileSet(user, a);
      case 'unit': return this.unit(user, a);
      case 'friend': return this.friend(user, a);
      case 'block': return this.block(user, a);
      case 'report': return this.report(user, a);
      case 'chat.history': return this.history(user, a);
      case 'chat.send': return this.send(user, a, ws);
      case 'chat.read': return this.read(user, a, ws);
    }
    return fail('Unknown request');
  }

  // ---- the lists -----------------------------------------------------------------------------------------------------
  async home(user) {
    this.limit('home', user.id);
    const me = user.id, q = (sql) => this.db.query(sql, [me]);
    const [{ rows: pairs }, { rows: blocks }, { rows: last }, { rows: unread }, { rows: [row] }] = await Promise.all([
      q('SELECT a, b, status, asked_by FROM friends WHERE a = $1 OR b = $1'),
      q('SELECT blocked_id FROM blocks WHERE user_id = $1'),
      q(NEWEST),
      q('SELECT from_id, count(*)::int AS n FROM messages WHERE to_id = $1 AND NOT read GROUP BY from_id'),
      q('SELECT profile FROM users WHERE id = $1'),
    ]);
    const blocked = new Set(blocks.map((r) => r.blocked_id)), counts = new Map(unread.map((r) => [r.from_id, r.n]));
    const friendOf = (r) => (r.a === me ? r.b : r.a);
    // (a chat with someone you've blocked waits in the Blocked list; the newest first, and whatever's unread however old)
    const chats = last.filter((r) => !blocked.has(r.other)).sort((x, y) => Number(y.id) - Number(x.id)).filter((r, i) => i < CHATS_MAX || counts.get(r.other));
    const who = await this.people([me, ...pairs.map(friendOf), ...blocked, ...chats.map((r) => r.other)]);
    const list = (ids) => ids.map((id) => who.get(id)).filter(Boolean).sort(byName);
    const pick = (fn) => list(pairs.filter(fn).map(friendOf));
    return {
      me: who.get(me),
      friends: pick((r) => r.status === 'friends'),
      requests: pick((r) => r.status === 'pending' && r.asked_by !== me && !blocked.has(r.asked_by)),
      sent: pick((r) => r.status === 'pending' && r.asked_by === me),
      blocked: list([...blocked]),
      chats: chats.filter((r) => who.has(r.other)).map((r) => ({ with: who.get(r.other), last: msgOf(r), unread: counts.get(r.other) || 0 })),
      settings: { dms: profileOf(row?.profile).dms },
    };
  }

  // Who's online, or a search by username: up to 30, online first.
  async find(user, a) {
    const q = shortText(a.q, 'Search', 64, { min: 0 }).toLowerCase(), online = [...this.srv.sockets.keys()];
    this.limit('find', user.id);
    const ids = !q ? online.filter((id) => id !== user.id).slice(0, FIND_MAX) : (await this.db.query(`SELECT id FROM users WHERE name_lc LIKE $1 AND id <> $2
      ORDER BY id = ANY($3::int[]) DESC, name_lc = $4 DESC, last_seen DESC, id DESC LIMIT ${FIND_MAX}`, [like(q), user.id, online, q])).rows.map((r) => r.id);
    const who = await this.people(ids, { levels: true });
    return ids.map((id) => who.get(id)).filter(Boolean);
  }

  // ---- profiles ------------------------------------------------------------------------------------------------------
  // Items as shownItem has them. `inv` is the most valuable 300 and `count` and `value` are all of them, none of which counts
  // what's in a Storage Unit: `units` lists those with what each holds, `stored` adds them up, and `unit` opens one. `picked`:
  // the showcase is the owner's choice, not their most valuable (Edit profile starts from what they chose).
  async profile(user, a) {
    const id = playerId(a.id), me = user.id;
    this.limit('profile', me);
    const who = (await this.people([id])).get(id);
    if (!who) fail('No such player', 'missing');
    const [{ rows: [row] }, { rows: [pals] }, st, x] = await Promise.all([
      this.db.query('SELECT profile, created FROM users WHERE id = $1', [id]),
      this.db.query("SELECT count(*)::int AS n FROM friends WHERE status = 'friends' AND (a = $1 OR b = $1)", [id]),
      this.srv.store.peek(id),
      id === me ? { mine: false } : this.between(me, id),
    ]);
    const p = profileOf(row.profile), inv = st.inv.filter((it) => !isUnit(it));
    const chosen = p.showcase.map((uid) => inv.find((it) => it.uid === uid)).filter(Boolean);
    const top = inv.map((it) => [itemValue(it), it]).sort((i, j) => j[0] - i[0]).slice(0, INV_SHOWN).map(([, it]) => it);
    return {
      ...who, level: st.prof?.level || 1, bio: p.bio, bg: p.bg, medal: medalOf(st.prof), medals: st.prof?.medals || 0, joined: new Date(Number(row.created)).getFullYear(),
      showcase: (chosen.length ? chosen : top.slice(0, SHOWCASE_MAX)).map(shownItem), picked: chosen.length > 0, inv: top.map(shownItem), count: inv.length, value: worthOf(inv), friends: pals.n,
      units: unitsOf(st).map((u) => ({ ...publicCopy(u), mod: u.mod, n: unitCount(st, u.uid), value: unitValue(st, u.uid) })), stored: { count: storedOf(st).length, value: worthOf(storedOf(st)) },
      relation: relationOf(x, me), blockedByMe: x.mine,
    };
  }

  // What's in one of a player's Storage Units, to look through. → { items }: all of it, 1,000 at most. (`sat`: when each went in,
  // which the unit's sort goes by.)
  async unit(user, a) {
    const id = playerId(a.id);
    this.limit('unit', user.id);
    if (!(await this.people([id])).has(id)) fail('No such player', 'missing');
    const st = await this.srv.store.peek(id);
    if (!unitsOf(st).some((u) => u.uid === a.uid)) fail('That Storage Unit is gone', 'missing');
    return { items: contents(st, a.uid).map((it) => ({ ...shownItem(it), sat: it.sat })) };
  }

  // What's sent changes, what isn't stays. → the saved profile
  async profileSet(user, a) {
    const set = {};
    if (a.bio !== undefined) {
      // (the summary is the one text with line breaks: the box it's typed in has them, and it's shown with them)
      if (a.bio != null && typeof a.bio !== 'string') fail('A summary must be text');
      const bio = (a.bio ?? '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      const bad = bio && textProblem(bio.replaceAll('\n', ' '), 'A summary', BIO_MAX);
      if (bad) fail(bad);
      set.bio = bio;
    }
    if (a.country !== undefined) {
      if (a.country && !(typeof a.country === 'string' && /^[A-Z]{2}$/.test(a.country))) fail('Unknown country');
      set.country = a.country || '';
    }
    if (a.avatar !== undefined) {
      if (a.avatar && !(typeof a.avatar === 'string' && Object.hasOwn(D.agents, a.avatar))) fail('Unknown avatar');
      set.avatar = a.avatar || null;
    }
    if (a.bg !== undefined) {
      if (a.bg && !(typeof a.bg === 'string' && /^[\w-]{1,40}$/.test(a.bg))) fail('Unknown map');
      set.bg = a.bg || null;
    }
    if (a.showcase !== undefined) {
      if (!Array.isArray(a.showcase) || a.showcase.length > SHOWCASE_MAX) fail(`Pick up to ${SHOWCASE_MAX} items`);
      const { st } = await this.srv.store.load(user.id);
      set.showcase = [...new Set(a.showcase.map(String))].filter((uid) => st.inv.some((it) => it.uid === uid && !isUnit(it)));
    }
    if (a.dms !== undefined) {
      if (!DMS.includes(a.dms)) fail('Pick who can message you');
      set.dms = a.dms;
    }
    const { rows } = await this.db.query("UPDATE users SET profile = COALESCE(profile, '{}'::jsonb) || $1::jsonb WHERE id = $2 RETURNING profile", [JSON.stringify(set), user.id]);
    this.changed(user.id);
    return profileOf(rows[0]?.profile);
  }

  // ---- friends and blocks --------------------------------------------------------------------------------------------
  // on: asks, or accepts if they already asked you. Off: declines, cancels or removes. → { relation }
  async friend(user, a) {
    const me = user.id, on = bool(a.on, 'on');
    const t = await this.other(user, a.id, "You can't be your own friend");
    const them = t.theirs ? null : t.id; // (someone who blocked you hears nothing of it)
    if (!on) {
      const { rows } = await this.db.query('DELETE FROM friends WHERE a = $1 AND b = $2 RETURNING a', [t.a, t.b]);
      if (rows.length) this.changed(me, them);
      return { relation: 0 };
    }
    if (t.mine) fail(`Unblock ${t.name} first`);
    if (t.pal || t.asked === me) return { relation: relationOf(t, me) };
    if (t.asked == null) this.limit('friend', me);
    const { rows } = await this.db.query(`INSERT INTO friends (a, b, status, asked_by, since) VALUES ($1, $2, 'pending', $3, $4)
      ON CONFLICT (a, b) DO UPDATE SET status = 'friends', since = EXCLUDED.since WHERE friends.status = 'pending' AND friends.asked_by <> EXCLUDED.asked_by
      RETURNING status`, [t.a, t.b, me, Date.now()]);
    this.changed(me, them);
    return { relation: !rows.length ? relationOf(await this.between(me, t.id), me) : rows[0].status === 'friends' ? 1 : 3 };
  }

  // Ends any friendship or request between you. Blocked and unblocked, they aren't told: losing a friend looks like being
  // removed, and what they asked for meanwhile goes without ever reaching you.
  async block(user, a) {
    const me = user.id, on = bool(a.on, 'on');
    if (on) this.limit('block', me);
    const t = await this.other(user, a.id, "You can't block yourself");
    if (on && !t.mine && (await this.db.query('SELECT count(*)::int AS n FROM blocks WHERE user_id = $1', [me])).rows[0].n >= BLOCKS_MAX) fail(`You can block up to ${BLOCKS_MAX} players: unblock some first`);
    const gone = await this.db.tx(async (q) => {
      if (on) await q('INSERT INTO blocks (user_id, blocked_id, at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [me, t.id, Date.now()]);
      else await q('DELETE FROM blocks WHERE user_id = $1 AND blocked_id = $2', [me, t.id]);
      return (await q(`DELETE FROM friends WHERE a = $1 AND b = $2 ${on ? '' : "AND status = 'pending'"} RETURNING a`, [t.a, t.b])).rows.length > 0;
    });
    this.changed(me, gone && !t.theirs ? t.id : null);
    return { blockedByMe: on };
  }

  // Saves the last 30 messages between you and their summary as it stands for staff (`reports` in admin.mjs), and tells the mod
  // log there's a new one (`reported`).
  async report(user, a) {
    const t = await this.other(user, a.id, "You can't report yourself");
    const clean = (v) => (typeof v === 'string' ? plainText(v) : v);
    const reason = shortText(clean(a.reason), 'Reason', 80), details = shortText(clean(a.text), 'Details', 500, { min: 0 });
    this.limit('report', user.id);
    const msgs = await this.conversation(user.id, t.id, REPORT_COPY);
    const { rows: [r] } = await this.db.query('INSERT INTO reports (from_id, about_id, reason, text, messages, bio, at) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) RETURNING id',
      [user.id, t.id, reason, details, JSON.stringify(msgs), t.bio, Date.now()]);
    this.srv.admin.reported(t, { report: r.id, reason });
    return { id: r.id };
  }

  // ---- chat ----------------------------------------------------------------------------------------------------------
  // The newest messages between two players before a message, oldest first.
  async conversation(me, them, n, before = Number.MAX_SAFE_INTEGER) {
    const { rows } = await this.db.query(`SELECT id, from_id, to_id, text, at FROM messages WHERE ${BETWEEN} AND id < $3 ORDER BY id DESC LIMIT ${n}`, [me, them, before]);
    return rows.map(msgOf).reverse();
  }

  // → { msgs, more }: 50 at a time, older ones with `before` (a message's id).
  async history(user, a) {
    const id = playerId(a.id), before = a.before == null ? undefined : int(a.before, 'before', 1, Number.MAX_SAFE_INTEGER);
    const msgs = await this.conversation(user.id, id, PAGE + 1, before);
    return { msgs: msgs.slice(-PAGE), more: msgs.length > PAGE };
  }

  // To anyone, online or not: a message waits in their `home` and history. → { msg }
  async send(user, a, ws) {
    const me = user.id, text = typeof a.text === 'string' ? a.text.trim() : a.text;
    const bad = textProblem(text, 'A message', MSG_MAX);
    if (bad) fail(bad);
    this.limit('chat', me);
    const t = await this.other(user, a.id, "You can't message yourself");
    if (t.mine) fail(`Unblock ${t.name} to message them`);
    this.mayWrite(t);
    const msg = await this.db.tx(async (q) => {
      const { rows: [r] } = await q('INSERT INTO messages (from_id, to_id, text, at) VALUES ($1, $2, $3, $4) RETURNING id, from_id, to_id, text, at', [me, t.id, text, Date.now()]);
      await q(`DELETE FROM messages WHERE ${BETWEEN} AND id <= (SELECT id FROM messages WHERE ${BETWEEN} ORDER BY id DESC OFFSET ${KEEP} LIMIT 1)`, [me, t.id]);
      return msgOf(r);
    });
    // (`who` is the other side of the conversation, from each end)
    const who = await this.people([me, t.id]);
    this.srv.sendTo(t.id, { t: 'chat', msg, who: who.get(me) });
    this.srv.sendTo(me, { t: 'chat', msg, who: who.get(t.id) }, ws);
    return { msg };
  }

  async read(user, a, ws) {
    const { rows } = await this.db.query('UPDATE messages SET read = TRUE WHERE to_id = $1 AND from_id = $2 AND NOT read RETURNING id', [user.id, playerId(a.id)]);
    if (rows.length) this.srv.sendTo(user.id, { t: 'friends' }, ws); // (your other tabs' unread counts)
    return { read: rows.length };
  }
}
