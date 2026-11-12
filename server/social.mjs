// Friends & Chat online: profiles, friends, blocks, private messages and reports between real players (ns 'social', the
// requests index.mjs' social() doesn't answer itself; the page is src/js/pages/community-online.js). Players are a numeric
// id plus their current name, as the `Person` a request gets back: { id, name, avatar, country, level, online, seen }. (Only
// `find` and `profile` always have a level: see people.)
//
// Faces (face1, server/index.mjs CAPS): to a game that announced it, a Person also has `pic`, their own profile picture (the
// SHA-256 of its bytes, served at /pic/<hash>, or null) and `badge`, the badge they feature (its id, or null), which the game
// draws in the picture's corner wherever a player is shown; `faces` gets the Persons of players the game knows only by name
// or id, and a profile lists their badges. A game without face1 gets every Person and profile as it always did, and the
// agent `avatar` as the picture: a player's own picture is for newer games only. A picture goes up over HTTP (POST /api/pic:
// setPicture), staff take one down (admin.mjs pic.clear), and a report keeps the one there was when it was sent.
//
// What a player writes is kept exactly as sent and never escaped here: whatever shows it goes through esc().
//
// Private means private: no staff request reads messages. All staff ever see of a conversation is the copy a report saved
// (`reports` in admin.mjs), so a new staff screen must not read this table.
//
// A blocked player isn't told, so nothing they can see differs from being ignored: their profile of you is a plain one, what
// they ask of you looks as it would for anyone (a friend request sits in Requests sent and never arrives, a trade offer stays
// open and never arrives, see trade.mjs), and a message is refused in the same words as one to a friends-only player.
import crypto from 'node:crypto';
import { fail, int, bool, isObj, text as shortText, worthOf } from '../src/js/engine/admin.js';
import { badgeDef, badgesOf, featuredBadge } from '../src/js/engine/badges.js';
import { D } from '../src/js/engine/data.js';
import { publicCopy } from '../src/js/engine/database.js';
import { isUnit, itemValue } from '../src/js/engine/items.js';
import { medalOf } from '../src/js/engine/levels.js';
import { PIC_TYPES, pictureInfo, pictureProblem } from '../src/js/engine/picture.js';
import { contents, storedOf, unitsOf, unitTotals } from '../src/js/engine/storage.js';
import { plainText, textProblem } from '../src/js/engine/tools.js';

const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR;
const MSG_MAX = 300, BIO_MAX = 300, KEEP = 200, PAGE = 50, FIND_MAX = 30, SHOWCASE_MAX = 6, REPORT_COPY = 30, CHATS_MAX = 100, BLOCKS_MAX = 500;
// faces: the most players one request asks about. PIC_AGAIN: how long a picture staff took down can't go up again, from
// anyone. PICS_KEPT: pictures the server keeps in memory to serve (64 KB at most each).
const FACES_MAX = 100, PIC_AGAIN = 30 * DAY, PICS_KEPT = 200;
export const isPicHash = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
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
  faces: [{ max: 30, ms: 10 * SEC, say: 'Slow down: too many requests' }, { max: 300, ms: MIN, say: 'Slow down: too many requests' }],
  // A new profile picture (each is stored, and everyone who sees you downloads it). Taking yours off isn't counted.
  pic: [{ max: 3, ms: 5 * MIN, say: 'Slow down: at most 3 new profile pictures in 5 minutes' }, { max: 10, ms: HOUR, say: 'Too many new profile pictures: at most 10 an hour' }],
  // A featured badge or a picture taken off (profile.set): every friend's game is told, so not too often.
  look: [{ max: 10, ms: MIN, say: 'Slow down: too many changes to your profile picture or badge' }],
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
    this.pics = new Map(); // hash -> { type, data }: pictures served lately, the least recently served first
    this.faceIds = new Set(); // players whose faces changed, for the next faces.d (facesChanged)
    this.faceTimer = null;
    this.views = new WeakMap(); // a peeked state (store.peek, which never changes) -> what profile worked out from it
    this.timer = setInterval(() => this.sweep(), 10 * MIN);
    this.timer.unref?.();
  }

  close() { clearInterval(this.timer); clearTimeout(this.faceTimer); }

  // A player's face changed (their picture, or the badge they feature, set or taken off by anyone or anything): every game
  // that reads faces (face1) is told, { t: 'faces.d', ids }, so a page that shows them by name or id outside Friends & Chat
  // (who's online, the Market's sellers, trade offers, gambling) draws them again. Friends and chat partners also get
  // `friends` (renamed). Gathered for a moment, so a burst is one message.
  facesChanged(...ids) {
    for (const id of ids) if (Number.isInteger(+id) && id != null) this.faceIds.add(+id);
    if (this.faceTimer || !this.faceIds.size) return;
    this.faceTimer = setTimeout(() => {
      this.faceTimer = null;
      const text = JSON.stringify({ t: 'faces.d', ids: [...this.faceIds] });
      this.faceIds.clear();
      for (const set of this.srv.sockets.values()) for (const ws of set) if (this.faces(ws) && ws.welcomed && ws.readyState === 1) ws.send(text);
    }, 250);
    this.faceTimer.unref?.();
  }

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
  // faces: with `pic` and `badge` (face1). A featured badge is checked against what's in memory when the player is there; the
  // column itself never outlives the badge by more than a save (server/store.mjs).
  async people(ids, { levels = false, faces = false } = {}) {
    const want = [...new Set(ids)], cache = this.srv.store.cache;
    if (!want.length) return new Map();
    const { rows } = await this.db.query(`SELECT id, name, profile, last_seen, pic, badge,
      CASE WHEN id = ANY($2::int[]) THEN (state->'prof'->>'level')::int END AS level FROM users WHERE id = ANY($1::int[])`, [want, levels ? want.filter((id) => !cache.has(id)) : []]);
    return new Map(rows.map((r) => {
      const p = profileOf(r.profile), e = cache.get(r.id);
      const person = { id: r.id, name: r.name, avatar: p.avatar, country: p.country, level: e ? e.st.prof?.level || 1 : levels ? r.level || 1 : null, online: this.srv.isOnline(r.id), seen: Number(r.last_seen) };
      if (faces) Object.assign(person, { pic: isPicHash(r.pic) ? r.pic : null, badge: e ? featuredBadge(e.st, r.badge) : badgeDef(r.badge) ? r.badge : null });
      return [r.id, person];
    }));
  }
  // Whether a connection reads faces (face1).
  faces(ws) { return !!this.srv.faces?.(ws); }

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
    const { rows } = await this.db.query('SELECT name, profile, pic FROM users WHERE id = $1', [id]);
    if (!rows.length) fail('No such player', 'missing');
    const { dms, bio } = profileOf(rows[0].profile);
    return { id, name: rows[0].name, dms, bio, pic: rows[0].pic || null, ...(await this.between(user.id, id)) };
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
    const a = isObj(args) ? args : {}, faces = this.faces(ws);
    switch (m) {
      case 'home': return this.home(user, faces);
      case 'find': return this.find(user, a, faces);
      case 'profile': return this.profile(user, a, faces);
      case 'profile.set': return this.profileSet(user, a, faces);
      case 'faces': if (faces) return this.facesOf(user, a); break;
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
  async home(user, faces = false) {
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
    const who = await this.people([me, ...pairs.map(friendOf), ...blocked, ...chats.map((r) => r.other)], { faces });
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
  async find(user, a, faces = false) {
    const q = shortText(a.q, 'Search', 64, { min: 0 }).toLowerCase(), online = [...this.srv.sockets.keys()];
    this.limit('find', user.id);
    const ids = !q ? online.filter((id) => id !== user.id).slice(0, FIND_MAX) : (await this.db.query(`SELECT id FROM users WHERE name_lc LIKE $1 AND id <> $2
      ORDER BY id = ANY($3::int[]) DESC, name_lc = $4 DESC, last_seen DESC, id DESC LIMIT ${FIND_MAX}`, [like(q), user.id, online, q])).rows.map((r) => r.id);
    const who = await this.people(ids, { levels: true, faces });
    return ids.map((id) => who.get(id)).filter(Boolean);
  }

  // (face1) The Persons of players a game shows by name or id outside Friends & Chat (who's online, a Market seller, a trade
  // offer's other side), to draw their faces: { ids: [id] } or { names: [name] }, up to 100. Unknown ones are left out, and
  // nothing is refused for being someone you've blocked or who blocked you: it's what anyone looking at them sees.
  async facesOf(user, a) {
    this.limit('faces', user.id);
    const ask = (v, what) => { if (v == null) return []; if (!Array.isArray(v) || v.length > FACES_MAX) fail(`Ask about up to ${FACES_MAX} ${what}`); return v; };
    const ids = ask(a.ids, 'players').map(playerId);
    const names = [...new Set(ask(a.names, 'names').map((n) => shortText(n, 'Name', 32).toLowerCase()))];
    if (names.length) ids.push(...(await this.db.query('SELECT id FROM users WHERE name_lc = ANY($1::text[])', [names])).rows.map((r) => r.id));
    return [...(await this.people(ids, { faces: true })).values()];
  }

  // ---- profiles ------------------------------------------------------------------------------------------------------
  // Items as shownItem has them. `inv` is the most valuable 300 and `count` and `value` are all of them, none of which counts
  // what's in a Storage Unit: `units` lists those with what each holds, `stored` adds them up, and `unit` opens one. `picked`:
  // the showcase is the owner's choice, not their most valuable (Edit profile starts from what they chose). faces (face1): the
  // Person's `pic` and `badge` (checked against their save, and the column cleared if they've lost it), and `badges`, every
  // badge they have ([{ id, n }], the rarest first: engine/badges.js badgesOf).
  async profile(user, a, faces = false) {
    const id = playerId(a.id), me = user.id;
    this.limit('profile', me);
    const who = (await this.people([id], { faces })).get(id);
    if (!who) fail('No such player', 'missing');
    const [{ rows: [row] }, { rows: [pals] }, st, x] = await Promise.all([
      this.db.query('SELECT profile, created, badge FROM users WHERE id = $1', [id]),
      this.db.query("SELECT count(*)::int AS n FROM friends WHERE status = 'friends' AND (a = $1 OR b = $1)", [id]),
      this.srv.store.peek(id),
      id === me ? { mine: false } : this.between(me, id),
    ]);
    const p = profileOf(row.profile), v = this.viewOf(id, st);
    const chosen = p.showcase.map((uid) => v.inv.find((it) => it.uid === uid)).filter(Boolean);
    let face = {};
    if (faces) {
      const badge = featuredBadge(st, row.badge);
      if (row.badge && !badge) {
        const { rows: off } = await this.db.query('UPDATE users SET badge = NULL WHERE id = $1 AND badge = $2 RETURNING id', [id, row.badge]);
        if (off.length) this.facesChanged(id);
      }
      face = { badge, badges: (v.badges ??= badgesOf(st).map((b) => ({ id: b.id, n: b.n }))) };
    }
    return {
      ...who, level: st.prof?.level || 1, bio: p.bio, bg: p.bg, medal: medalOf(st.prof), medals: st.prof?.medals || 0, joined: new Date(Number(row.created)).getFullYear(),
      showcase: (chosen.length ? chosen : v.top.slice(0, SHOWCASE_MAX)).map(shownItem), picked: chosen.length > 0, inv: v.top.map(shownItem), count: v.inv.length, value: v.value, friends: pals.n,
      units: v.units, stored: v.stored, relation: relationOf(x, me), blockedByMe: x.mine, ...face,
    };
  }
  // What a profile shows of a state: its inventory (less Storage Units), the most valuable 300, their value, each unit with what
  // it holds, what's stored in all, and their badges. Kept with a peeked state (store.peek's copies never change), so a player
  // looked at again within the minute costs nothing more: 100 full units are 100,000 items to go through.
  viewOf(id, st) {
    const peeked = this.srv.store.isPeeked?.(id, st);
    let v = peeked ? this.views.get(st) : null;
    if (v) return v;
    const inv = st.inv.filter((it) => !isUnit(it));
    const sums = unitTotals(st); // (each unit's count and value, from one pass over what's stored: up to 100 units)
    v = {
      inv, top: inv.map((it) => [itemValue(it), it]).sort((i, j) => j[0] - i[0]).slice(0, INV_SHOWN).map(([, it]) => it), value: worthOf(inv),
      units: unitsOf(st).map((u) => ({ ...publicCopy(u), mod: u.mod, n: sums.get(u.uid)?.n || 0, value: sums.get(u.uid)?.value || 0 })),
      stored: { count: storedOf(st).length, value: worthOf(storedOf(st)) }, badges: null, // (badges: face1's, made when asked)
    };
    if (peeked) this.views.set(st, v);
    return v;
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

  // What's sent changes, what isn't stays. → the saved profile (and with face1 its `pic` and `badge`). badge: the badge to
  // feature, one they have (inventory or Storage Units), or null for none. pic: only null, which takes their picture off (a
  // picture goes up over HTTP: setPicture).
  async profileSet(user, a, faces = false) {
    const set = {};
    let st = null;
    const state = async () => (st ??= (await this.srv.store.load(user.id)).st);
    const cols = {};
    if (a.badge !== undefined) {
      if (a.badge != null && a.badge !== '' && !(typeof a.badge === 'string' && featuredBadge(await state(), a.badge))) fail("You don't have that badge");
      cols.badge = a.badge || null;
    }
    if (a.pic !== undefined) {
      if (a.pic != null) fail('A profile picture is sent on its own');
      cols.pic = null;
    }
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
      const inv = (await state()).inv;
      set.showcase = [...new Set(a.showcase.map(String))].filter((uid) => inv.some((it) => it.uid === uid && !isUnit(it)));
    }
    if (a.dms !== undefined) {
      if (!DMS.includes(a.dms)) fail('Pick who can message you');
      set.dms = a.dms;
    }
    // (pic and badge are columns of their own: $3 and $5 say whether each is sent)
    if ('pic' in cols || 'badge' in cols) this.limit('look', user.id);
    const { rows } = await this.db.query(`UPDATE users SET profile = COALESCE(profile, '{}'::jsonb) || $1::jsonb,
      badge = CASE WHEN $3::boolean THEN $4::text ELSE badge END, pic = CASE WHEN $5::boolean THEN NULL ELSE pic END
      WHERE id = $2 RETURNING profile, pic, badge, (SELECT pic FROM users WHERE id = $2) AS was, (SELECT badge FROM users WHERE id = $2) AS had`,
    [JSON.stringify(set), user.id, 'badge' in cols, cols.badge ?? null, 'pic' in cols]);
    const r = rows[0];
    if (r?.was && r.was !== r.pic) await this.dropPicture(r.was);
    // (a new face: everyone who has them in a list draws it again)
    if (r && (r.was !== r.pic || r.had !== r.badge)) { await this.renamed(user.id); this.facesChanged(user.id); } else this.changed(user.id);
    return { ...profileOf(r?.profile), ...(faces ? { pic: r?.pic || null, badge: r?.badge || null } : {}) };
  }

  // ---- profile pictures ----------------------------------------------------------------------------------------------
  // A player's own picture, from POST /api/pic (server/index.mjs) with its bytes as the game made them, which are checked
  // here whatever the game says they are (engine/picture.js: a PNG or WebP, 184 x 184, at most 64 KB, not animated, no
  // metadata). One staff took down can't go up again for 30 days, from anyone. → { pic: its hash }
  async setPicture(userId, bytes) {
    const bad = pictureProblem(bytes);
    if (bad) fail(bad);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex'), type = PIC_TYPES[pictureInfo(bytes).type];
    const { rows: [had] } = await this.db.query('SELECT removed FROM pictures WHERE hash = $1', [hash]);
    if (had?.removed && this.now() - Number(had.removed) < PIC_AGAIN) fail('Staff took that picture down: pick another one', 'removed');
    this.limit('pic', userId);
    const was = await this.db.tx(async (q) => {
      await q(`INSERT INTO pictures (hash, type, data, size, by_id, at) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (hash) DO UPDATE SET removed = NULL, removed_by = NULL WHERE pictures.removed IS NOT NULL`, [hash, type, bytes, bytes.length, userId, Date.now()]);
      const { rows: [r] } = await q('UPDATE users SET pic = $1 WHERE id = $2 RETURNING (SELECT pic FROM users WHERE id = $2) AS was', [hash, userId]);
      if (!r) fail('No such player', 'missing');
      return r.was;
    });
    if (was && was !== hash) await this.dropPicture(was);
    await this.renamed(userId);
    if (was !== hash) this.facesChanged(userId);
    return { pic: hash };
  }

  // A picture nobody has any more goes, unless a report keeps it (staff can still see what was reported) or staff took it
  // down (the row says it can't go up again).
  async dropPicture(hash) {
    await this.db.query(`DELETE FROM pictures WHERE hash = $1 AND removed IS NULL AND NOT EXISTS (SELECT 1 FROM users WHERE pic = $1)
      AND NOT EXISTS (SELECT 1 FROM reports WHERE pic = $1)`, [hash]).catch((e) => this.srv.log?.('[social] could not drop a picture', e.message));
    this.pics.delete(hash);
  }

  // A picture to serve (GET /pic/<hash>): { type, data } or null (none, taken down, or nobody's any more: one only a report
  // keeps is for staff, staffPicture). The latest 200 are kept in memory (dropPicture and removePicture take one out).
  async picture(hash) {
    if (!isPicHash(hash)) return null;
    let p = this.pics.get(hash);
    if (p) { this.pics.delete(hash); this.pics.set(hash, p); return p; }
    const { rows: [r] } = await this.db.query('SELECT type, data, removed FROM pictures WHERE hash = $1 AND EXISTS (SELECT 1 FROM users WHERE pic = $1)', [hash]);
    if (!r || r.removed != null) return null;
    p = { type: r.type, data: Buffer.from(r.data) };
    this.pics.set(hash, p);
    if (this.pics.size > PICS_KEPT) this.pics.delete(this.pics.keys().next().value);
    return p;
  }

  // Staff take a picture down (admin.mjs pic.clear): off the player, and off anyone else with the same one, marked as taken
  // down (not served, and not to go up again for 30 days), and everyone who sees them told. `hash`: which picture, their
  // current one (without it) or one a report about them kept, whether or not they still have it. → the hash, or null if
  // there was nothing to take down (no picture, or that one is down already)
  async removePicture(id, by, { hash: which = null } = {}) {
    const { rows: [u] } = await this.db.query('SELECT pic FROM users WHERE id = $1', [id]);
    let hash = u?.pic || null;
    if (which != null) {
      if (!isPicHash(which)) fail('Unknown picture');
      if (which !== hash && !(await this.db.query('SELECT 1 FROM reports WHERE about_id = $1 AND pic = $2 LIMIT 1', [id, which])).rows.length) fail("That isn't a picture of theirs", 'missing');
      hash = which;
    }
    if (!hash) return null;
    const { marked, rows } = await this.db.tx(async (q) => ({
      marked: (await q('UPDATE pictures SET removed = $1, removed_by = $2 WHERE hash = $3 AND removed IS NULL RETURNING hash', [this.now(), by, hash])).rows.length > 0,
      rows: (await q('UPDATE users SET pic = NULL WHERE pic = $1 RETURNING id', [hash])).rows,
    }));
    this.pics.delete(hash);
    for (const r of rows) await this.renamed(r.id);
    this.facesChanged(...rows.map((r) => r.id));
    return marked || rows.length ? hash : null;
  }

  // A picture for staff to look at (admin.mjs pic.get): one a report kept or a player has, taken down or not, so what was
  // reported can still be seen after it's gone from everywhere else. → { type, data (base64) } or null
  async staffPicture(hash) {
    if (!isPicHash(hash)) return null;
    const { rows: [r] } = await this.db.query(`SELECT type, data FROM pictures WHERE hash = $1
      AND (EXISTS (SELECT 1 FROM reports WHERE pic = $1) OR EXISTS (SELECT 1 FROM users WHERE pic = $1))`, [hash]);
    return r ? { type: r.type, data: Buffer.from(r.data).toString('base64') } : null;
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

  // Saves the last 30 messages between you, their summary and their profile picture as they stand for staff (`reports` in
  // admin.mjs: the picture is kept while a report has it, dropPicture), and tells the mod log there's a new one (`reported`).
  async report(user, a) {
    const t = await this.other(user, a.id, "You can't report yourself");
    const clean = (v) => (typeof v === 'string' ? plainText(v) : v);
    const reason = shortText(clean(a.reason), 'Reason', 80), details = shortText(clean(a.text), 'Details', 500, { min: 0 });
    this.limit('report', user.id);
    const msgs = await this.conversation(user.id, t.id, REPORT_COPY);
    const { rows: [r] } = await this.db.query('INSERT INTO reports (from_id, about_id, reason, text, messages, bio, pic, at) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8) RETURNING id',
      [user.id, t.id, reason, details, JSON.stringify(msgs), t.bio, isPicHash(t.pic) ? t.pic : null, Date.now()]);
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
    // (`who` is the other side of the conversation, from each end: with its face to a game that reads faces)
    const who = await this.people([me, t.id], { faces: true });
    const plain = ({ pic: _p, badge: _b, ...p }) => p;
    const each = (p) => { const face1 = { t: 'chat', msg, who: p }, old = { t: 'chat', msg, who: p && plain(p) }; return (c) => (this.faces(c) ? face1 : old); };
    this.srv.sendEach(t.id, each(who.get(me)));
    this.srv.sendEach(me, each(who.get(t.id)), ws);
    return { msg };
  }

  async read(user, a, ws) {
    const { rows } = await this.db.query('UPDATE messages SET read = TRUE WHERE to_id = $1 AND from_id = $2 AND NOT read RETURNING id', [user.id, playerId(a.id)]);
    if (rows.length) this.srv.sendTo(user.id, { t: 'friends' }, ws); // (your other tabs' unread counts)
    return { read: rows.length };
  }
}
