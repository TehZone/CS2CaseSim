// Staff tools for the online server: who is staff (ADMIN_USERS or the Discord server's roles), bans (accounts and
// networks), kicks, warnings and sign-outs, edits of an account with automatic snapshots, snapshots and restores,
// notes, the audit log, server settings and broadcasts, plus Discord account linking, password resets through Discord
// and the players' synced configs.
// The game's admin panel (ns 'admin' and 'account') and the bot's slash commands call the same methods, so every check,
// audit row and mod-log message is the same whichever way a request comes in. Permissions are always checked here.
import crypto from 'node:crypto';
import { makeCtx, delta, take, give, GameError } from '../src/js/engine/actions.js';
import { upgradeState } from '../src/js/engine/economy.js';
import { round2 } from '../src/js/engine/util.js';
// (the checks and rules the offline panel shares)
import {
  KEEP_AUTO, MAX_MANUAL, PAGE, LEVEL_NAMES, fail, isObj, pick, wellFormed, worthOf, replaceInPlace, revOf, rawView, text, int, bool, optBool,
  jsonOf, editPlan, applyEdit, rawEdit, restoreUids, restoreMerge, giveSpecs, buildItems, removeUids, givenDetail, removedDetail,
} from '../src/js/engine/admin.js';
import * as A from './accounts.mjs';

const MIN = 60000;
const LINK_MS = 10 * MIN, RESET_MS = 15 * MIN, LEVEL_MS = 60000, UNKNOWN_MS = 10000, LINK_TRIES = 5, BEST_EFFORT_MS = 4000;
const MAX_STAFF_SCAN = 200;
const DEFAULTS = { motd: '', maintenance: false, maintenanceMsg: '', registration: true, trading: true, gambling: true };
const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // (no 0/O or 1/I to mix up)
const DURATIONS = { '1h': 60, '1d': 1440, '7d': 10080, '30d': 43200, perm: null };
const FILTERS = ['all', 'online', 'banned', 'linked', 'staff'];
const TITLES = {
  ban: 'Player banned', unban: 'Player unbanned', kick: 'Player kicked', warn: 'Player warned', signout: 'Player signed out everywhere',
  edit: 'Account edited', 'edit.raw': 'Account edited (raw JSON)', 'items.give': 'Items given', 'items.remove': 'Items removed',
  'snapshot.save': 'Snapshot saved', 'snapshot.restore': 'Snapshot restored', 'snapshot.delete': 'Snapshot deleted', 'note.add': 'Note added',
  rename: 'Player renamed', reset: 'Account reset', 'settings.set': 'Server settings changed', broadcast: 'Broadcast sent',
  link: 'Discord account linked', unlink: 'Discord account unlinked', resetpassword: 'Password reset through Discord',
};
const RED = 0xeb4b4b, GOLD = 0xe4ae39, BLUE = 0x4b69ff, GREEN = 0x4ade80;
const COLORS = { ban: RED, kick: RED, signout: RED, reset: RED, warn: GOLD, unban: GREEN, link: GREEN, broadcast: BLUE, 'settings.set': BLUE };

const num = (v) => (v == null ? null : Number(v));
const parse = (v) => (typeof v === 'string' && /^[[{]/.test(v) ? JSON.parse(v) : v); // (JSONB: objects, or their text)
const like = (s) => '%' + s.replace(/[\\%_]/g, '\\$&') + '%';
const clampLevel = (n) => Math.max(0, Math.min(3, Math.floor(Number(n) || 0)));
const md = (s) => String(s).replace(/[\\*_~`|>]/g, '\\$&'); // (game and Discord names in Discord's markdown)
const randomCode = (n) => Array.from({ length: n }, () => ABC[crypto.randomInt(ABC.length)]).join('');
const showCode = (c) => (c.length === 6 ? c.slice(0, 3) + '-' + c.slice(3) : c.slice(0, 4) + '-' + c.slice(4));
const cleanCode = (s) => String(s ?? '').toUpperCase().replace(/[\s-]/g, '').slice(0, 16);
const dateText = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const untilText = (exp) => (exp ? `until ${dateText(exp)}` : 'permanently');
const publicBan = (b) => ({ reason: b.reason, expires: b.expires, by: b.by });
export const banText = (b) => `This account is banned: ${b.reason} (${untilText(b.expires)})`;
export const networkBanText = (b) => `Your network is banned from this server: ${b.reason} (${untilText(b.expires)})`;
// A best-effort Discord call made after a change is committed, on a request path: the answer waits for it a few seconds
// at most (null: no word from Discord yet; the call goes on in the background).
function soon(p, ms = BEST_EFFORT_MS) {
  let timer;
  return Promise.race([p, new Promise((r) => { timer = setTimeout(r, ms, null); timer.unref?.(); })]).finally(() => clearTimeout(timer));
}

// ---- argument checks (a refusal is a GameError the panel shows as is; the shared ones are in engine/admin.js) --------
const playerId = (v) => int(v, 'Player id', 1, 2 ** 31 - 1);
const cleanSettings = (saved) => {
  const s = { ...DEFAULTS };
  if (isObj(saved)) for (const k of Object.keys(DEFAULTS)) if (typeof saved[k] === typeof DEFAULTS[k]) s[k] = saved[k];
  return s;
};
// Every top-level key, and as null the ones the new state no longer has (the game only sets the keys it's sent).
const fullDelta = (st, gone = []) => ({ set: { ...Object.fromEntries(gone.map((k) => [k, null])), ...st }, add: [], del: [], upd: [] });

function auditRow(r) {
  return { id: r.id, at: num(r.at), actor: r.actor, actorDiscord: r.actor_discord || null, action: r.action, target: r.target_id != null ? { id: r.target_id, name: r.target_name } : null, detail: parse(r.detail) };
}
function banRow(r, now = Date.now()) {
  const expires = num(r.expires), lifted = num(r.lifted);
  return {
    id: r.id, user: r.user_id != null ? { id: r.user_id, name: r.name ?? null } : null, network: !!r.ip_hash, reason: r.reason, by: r.by_name,
    created: num(r.created), expires, lifted, liftedBy: r.lifted_by || null, active: lifted == null && (expires == null || expires > now),
  };
}
const snapRow = (r) => ({ id: r.id, label: r.label, kind: r.kind, by: r.by_name, created: num(r.created), size: Number(r.size) || 0 });

// What a restore left out: items now owned by others, and level-up rewards claimed since.
function droppedText({ dropped, rewards = 0 }) {
  const items = dropped - rewards, n = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
  return [items && `${n(items, 'item')} owned by others now`, rewards && `${n(rewards, 'reward')} claimed since`].filter(Boolean).join(', ');
}

export class Admin {
  constructor(srv, discord, { admins = [] } = {}) {
    this.srv = srv;
    this.db = srv.db;
    this.discord = discord;
    this.log = srv.log || console.log;
    this.admins = new Set(admins.map((n) => String(n).trim().toLowerCase()).filter(Boolean));
    this.settings = { ...DEFAULTS };
    this.salt = '';
    this.started = Date.now();
    this.levels = new Map(); // game user id -> { level, at }
    this.linkCodes = new Map(); // code -> { userId, expires } (memory only: a restart forgets them)
    this.resetCodes = new Map(); // code -> { userId, discordId, expires }
    this.linkTries = new Map(); // Discord user id -> { n, t }: wrong /link codes in the last 10 minutes
    this.settingsQ = Promise.resolve();
    this.timer = setInterval(() => this.sweep(), MIN);
    this.timer.unref?.();
  }

  async init() {
    const { rows: [saved] } = await this.db.query("SELECT v FROM kv WHERE k = 'admin'");
    this.settings = cleanSettings(saved && parse(saved.v));
    // The salt is a JSON string: read back as text (v #>> '{}'), the same from Postgres and PGlite.
    const salt = async () => (await this.db.query("SELECT v #>> '{}' AS s FROM kv WHERE k = 'ipsalt'")).rows[0]?.s || '';
    this.salt = await salt();
    if (!this.salt) {
      // Made once per database (another instance may make it at the same moment: whichever is saved first wins).
      await this.db.query("INSERT INTO kv (k, v) VALUES ('ipsalt', $1::jsonb) ON CONFLICT (k) DO NOTHING", [JSON.stringify(crypto.randomBytes(24).toString('hex'))]);
      this.salt = await salt();
    }
    this.discord.onInteraction((ix) => this.interaction(ix).catch((e) => this.log('[discord] interaction failed', e?.message || e)));
  }

  close() { clearInterval(this.timer); }

  sweep() {
    const now = Date.now();
    for (const [c, x] of this.linkCodes) if (x.expires < now) this.linkCodes.delete(c);
    for (const [c, x] of this.resetCodes) if (x.expires < now) this.resetCodes.delete(c);
    for (const [id, x] of this.linkTries) if (now - x.t > LINK_MS) this.linkTries.delete(id);
    for (const [id, x] of this.levels) if (now - x.at > LEVEL_MS) this.levels.delete(id);
  }

  // ---- networks and bans -------------------------------------------------------------------------------------------
  ipHash(ip) {
    const a = String(ip || '').trim().toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, ''); // (IPv4 seen through IPv6)
    return crypto.createHash('sha256').update(this.salt + a).digest('hex').slice(0, 32);
  }

  async noteIp(userId, ip) {
    try {
      await this.db.query(`INSERT INTO user_ips (user_id, ip_hash, last) VALUES ($1, $2, $3)
        ON CONFLICT (user_id, ip_hash) DO UPDATE SET last = EXCLUDED.last`, [userId, this.ipHash(ip), Date.now()]);
    } catch (e) { this.log('[admin] could not note a network', e.message); }
  }

  // The longest-lasting active ban of an account or a network (a permanent one first). A network ban doesn't keep staff
  // out: they can share a network with whoever was banned (a household, or everyone on a server run on this machine).
  // This runs on every login and hello, so Discord is only asked when a network ban is what decides it.
  async activeBan({ userId = null, ipHash = null } = {}) {
    const longest = async (col, v) => {
      const { rows } = await this.db.query(`SELECT id, reason, expires, by_name FROM bans
        WHERE lifted IS NULL AND (expires IS NULL OR expires > $1) AND ${col} = $2
        ORDER BY (expires IS NULL) DESC, expires DESC LIMIT 1`, [Date.now(), v]);
      return rows.length ? { id: rows[0].id, reason: rows[0].reason, expires: num(rows[0].expires), by: rows[0].by_name } : null;
    };
    const own = userId != null ? await longest('user_id', userId) : null; // (a network ban made with the account included)
    if (!ipHash || (own && own.expires == null)) return own;
    const net = await longest('ip_hash', ipHash);
    if (!net || (own && net.expires != null && net.expires <= own.expires)) return own;
    if (userId != null && await this.levelOf(userId, { fast: true }) >= 1) return own;
    return net;
  }

  // ---- staff levels (spec §0) ----------------------------------------------------------------------------------------
  // 0..3, or null when Discord couldn't say (the lookup failed or timed out): an unknown level is kept 10 s, a known one
  // a minute. `fast`: one quick try, for a login, a hello or the account's answer.
  async lookupLevel(userId, { refresh = false, fast = false } = {}) {
    const c = this.levels.get(userId);
    if (c && !refresh && Date.now() - c.at < (c.level == null ? UNKNOWN_MS : LEVEL_MS)) return c.level;
    const { rows } = await this.db.query('SELECT name, discord_id FROM users WHERE id = $1', [userId]);
    let level = 0;
    if (rows.length && this.admins.has(rows[0].name.toLowerCase())) level = 2;
    else if (rows[0]?.discord_id && this.discord.enabled) {
      try {
        const l = await this.discord.levelOf(rows[0].discord_id, { refresh, fast });
        level = l == null ? null : clampLevel(l);
      } catch (e) {
        this.log('[admin] staff level lookup failed', e.message);
        level = null;
      }
    }
    this.levels.set(userId, { level, at: Date.now() });
    return level;
  }
  // The level an account acts with: one Discord can't confirm right now is a player's (fail closed).
  async levelOf(userId, opts) {
    return (await this.lookupLevel(userId, opts)) ?? 0;
  }
  // The level of an account staff act on: unknown refuses (an admin mustn't count as a player while Discord is down).
  async targetLevel(t) {
    const level = await this.lookupLevel(t.id, { fast: true });
    if (level == null) fail(`Couldn't check ${t.name}'s staff level with Discord right now; try again in a minute.`, 'discord');
    return level;
  }

  // The level as far as known without asking Discord (for lists: ADMIN_USERS, or a level looked up lately).
  knownLevel(u) {
    if (this.admins.has(u.name.toLowerCase())) return 2;
    const c = this.levels.get(u.id);
    return c && c.level != null && Date.now() - c.at < LEVEL_MS ? c.level : 0;
  }

  // discordOn: this server's bot takes /link (it runs the gateway; with DISCORD_GATEWAY=0 another server's does).
  async account(userId) {
    const { rows } = await this.db.query('SELECT discord_id, discord_name FROM users WHERE id = $1', [userId]);
    const r = rows[0];
    return { discord: r?.discord_id ? { id: r.discord_id, name: r.discord_name || '' } : null, staff: await this.levelOf(userId, { fast: true }), discordOn: !!this.discord.interactions, discordBans: !!this.discord.enabled };
  }

  async target(id) {
    const { rows } = await this.db.query('SELECT id, name, discord_id, discord_name, linked_at, created, last_seen FROM users WHERE id = $1', [playerId(id)]);
    if (!rows.length) fail('No such player', 'missing');
    return rows[0];
  }
  async targetByName(name) {
    const n = text(name, 'Player', 32);
    const { rows } = await this.db.query('SELECT id, name, discord_id, discord_name, linked_at, created, last_seen FROM users WHERE name_lc = $1', [n.toLowerCase()]);
    if (!rows.length) fail(`No player called "${n}"`, 'missing');
    return rows[0];
  }

  need(actor, level) {
    if (actor.level < level) fail(level >= 2 ? 'Only admins can do that' : 'Only staff can do that', 'perm');
  }
  isSelf(actor, t) {
    return (actor.id != null && actor.id === t.id) || (!!actor.discordId && actor.discordId === t.discord_id);
  }
  // Punishments: never yourself, and only players below your level.
  async canPunish(actor, t) {
    this.need(actor, 1);
    if (this.isSelf(actor, t)) fail("You can't do that to yourself", 'perm');
    if (actor.level <= await this.targetLevel(t)) fail(`${t.name} is staff at or above your level`, 'perm');
  }
  // Changes to an account: admins, on themselves or on players below their level.
  async canChange(actor, t) {
    this.need(actor, 2);
    if (!this.isSelf(actor, t) && actor.level <= await this.targetLevel(t)) fail(`${t.name} is staff at or above your level`, 'perm');
  }

  // ---- audit + mod log -----------------------------------------------------------------------------------------------
  async audit(actor, action, t, detail = {}) {
    try {
      await this.db.query('INSERT INTO audit (at, actor, actor_discord, action, target_id, target_name, detail) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)',
        [Date.now(), actor.name, actor.discordId || null, action, t?.id ?? null, t?.name ?? null, JSON.stringify(wellFormed(detail ?? {}))]);
    } catch (e) { this.log('[admin] audit write failed', action, e.message); }
    if (!this.discord.enabled) return;
    const fields = [];
    if (t) fields.push({ name: 'Player', value: md(t.name), inline: true });
    fields.push({ name: 'By', value: md(actor.name), inline: true });
    if (detail.reason) fields.push({ name: 'Reason', value: md(String(detail.reason).slice(0, 1000)) });
    if (action === 'ban') fields.push({ name: 'Until', value: detail.expires ? `<t:${Math.floor(detail.expires / 1000)}:f>` : 'Permanent', inline: true });
    if (detail.network) fields.push({ name: 'Network', value: 'Blocked too', inline: true });
    if (detail.msg) fields.push({ name: 'Message', value: md(String(detail.msg).slice(0, 1000)) });
    if (detail.changed?.length) fields.push({ name: 'Changed', value: detail.changed.join(', ').slice(0, 1000) });
    if (detail.count != null) fields.push({ name: 'Items', value: String(detail.count), inline: true });
    if (detail.dropped) fields.push({ name: 'Dropped', value: droppedText(detail), inline: true });
    if (action === 'rename') fields.push({ name: 'Name', value: `${md(detail.before)} → ${md(detail.after)}` });
    Promise.resolve()
      .then(() => this.discord.modLog({ title: TITLES[action] || action, description: t ? `**${md(t.name)}**` : '', fields, color: COLORS[action] ?? GOLD }))
      .catch((e) => this.log('[discord] mod log failed', e?.message || e));
  }

  // ---- snapshots and state replacement -----------------------------------------------------------------------------
  // A snapshot row: `stateJson` taken under the player's lock; their config is copied from their row. Older automatic
  // snapshots past the newest 20 go.
  async saveSnap(q, userId, { label, kind, by, stateJson }) {
    const { rows } = await q(`INSERT INTO snapshots (user_id, label, kind, state, config, by_name, created)
      SELECT id, $2::text, $3::text, $4::jsonb, config, $5::text, $6::bigint FROM users WHERE id = $1 RETURNING id`,
    [userId, label.slice(0, 120), kind, stateJson, by, Date.now()]);
    if (kind === 'auto') {
      await q(`DELETE FROM snapshots WHERE user_id = $1 AND kind = 'auto' AND id NOT IN
        (SELECT id FROM snapshots WHERE user_id = $1 AND kind = 'auto' ORDER BY created DESC, id DESC LIMIT ${KEEP_AUTO})`, [userId]);
    }
    return rows[0]?.id;
  }
  autoSnap(t, actor, what, stateJson) {
    return (q) => this.saveSnap(q, t.id, { label: `Before ${what} by ${actor.name}`, kind: 'auto', by: actor.name, stateJson });
  }

  // A stake in a live round (in memory, or an escrow row not settled yet): its payout would land on top of a replaced
  // state, so restores and resets wait.
  async refuseIfGambling(t) {
    const key = String(t.id);
    const L = this.srv.live;
    const rounds = [...L.flips.values(), ...L.battles.values(), ...(L.pot ? [L.pot] : [])];
    let busy = rounds.some((r) => r.escrow && Object.hasOwn(r.escrow, key));
    if (!busy) {
      const { rows } = await this.db.query("SELECT 1 FROM rounds WHERE status = 'open' AND (data->'escrow') ? $1 LIMIT 1", [key]);
      busy = rows.length > 0;
    }
    if (busy) fail(`${t.name} has a stake in a live gambling round. Try again when it's over.`, 'busy');
  }

  // Cancels every open offer from or to a player (their items in them are what a restore or reset replaces).
  async cancelOffers(id) {
    const T = this.srv.trades;
    const who = new Set();
    for (const t of [...T.open.values()]) {
      if (t.from_id !== id && t.to_id !== id) continue;
      await T.close(t, 'cancelled');
      who.add(t.from_id); who.add(t.to_id);
    }
    if (who.size) await T.pushLists(...who);
    return Math.max(0, who.size - 1);
  }

  // The uids among `uids` that exist anywhere but this player's inventory: another inventory or a gambling escrow.
  // Restoring those would make a second copy. The saved inventories and the open rounds' escrows are read in one
  // statement: whatever moves an item between players (a trade, a stake, a payout) commits both sides in one
  // transaction, so one look sees it in exactly one place. Memory (written first, and looked at too) only adds.
  async ownedElsewhere(id, uids) {
    const want = new Set(uids), out = new Set();
    if (!want.size) return out;
    await this.srv.store.flush().catch(() => {});
    const { rows } = await this.db.query(`SELECT DISTINCT uid FROM (
        SELECT it->>'uid' AS uid FROM users u, jsonb_array_elements(COALESCE(u.state->'inv', '[]'::jsonb)) AS it WHERE u.id <> $1
        UNION ALL
        SELECT it->>'uid' AS uid FROM rounds r, jsonb_each(COALESCE(r.data->'escrow', '{}'::jsonb)) AS x(k, v),
          jsonb_array_elements(COALESCE(x.v->'items', '[]'::jsonb)) AS it WHERE r.status = 'open'
      ) s WHERE uid = ANY($2::text[])`, [id, [...want]]);
    for (const r of rows) out.add(r.uid);
    for (const e of this.srv.store.cache.values()) if (e.id !== id) for (const it of e.st.inv) if (want.has(it.uid)) out.add(it.uid);
    const L = this.srv.live;
    for (const r of [...L.flips.values(), ...L.battles.values(), ...(L.pot ? [L.pot] : [])]) {
      for (const x of Object.values(r.escrow || {})) for (const it of x?.items || []) if (want.has(it.uid)) out.add(it.uid);
    }
    return out;
  }

  // Replaces a player's whole state (restore, reset): refused during a live round, open offers cancelled first, items
  // now owned elsewhere left out, an automatic snapshot of what was there, committed, and the full state pushed.
  async replaceWith(actor, t, next, what) {
    return this.srv.store.withUser(t.id, async (e) => {
      await this.refuseIfGambling(t);
      await this.cancelOffers(t.id);
      // (its items and its rewards' items owned elsewhere now are left out: see restoreMerge)
      const elsewhere = await this.ownedElsewhere(t.id, restoreUids(next));
      const { dropped, rewards } = restoreMerge(e.st, next, { elsewhere });
      const before = JSON.stringify(e.st);
      const gone = Object.keys(e.st).filter((k) => !(k in next));
      replaceInPlace(e.st, next);
      this.srv.store.markDirty(e);
      await this.srv.store.commit([e], this.autoSnap(t, actor, what, before));
      this.srv.deltaTo(t.id, fullDelta(e.st, gone));
      return { dropped, rewards };
    });
  }

  // ---- requests ------------------------------------------------------------------------------------------------------
  async actorFor(user) {
    const { rows } = await this.db.query('SELECT name, discord_id FROM users WHERE id = $1', [user.id]);
    return { id: user.id, name: rows[0]?.name || user.name, discordId: rows[0]?.discord_id || null, level: await this.levelOf(user.id, { fast: true }) };
  }

  async rpc(user, m, args) {
    return this.exec(await this.actorFor(user), String(m), isObj(args) ? args : {});
  }

  // Every admin request, from the panel or a slash command. `actor` = { id (game id or null), name, discordId, level }.
  async exec(actor, m, a) {
    const fn = this.methods[m];
    if (!fn) fail('Unknown request');
    if (actor.level < 1) fail('You are not staff on this server', 'perm');
    return fn.call(this, actor, a);
  }

  get methods() {
    return {
      overview: this.overview, players: this.players, player: this.player, edit: this.edit, 'edit.raw': this.editRaw,
      'items.give': this.itemsGive, 'items.remove': this.itemsRemove, 'snapshot.save': this.snapSave, 'snapshot.list': this.snapList,
      'snapshot.get': this.snapGet, 'snapshot.restore': this.snapRestore, 'snapshot.delete': this.snapDelete, 'config.get': this.configGet,
      ban: this.ban, unban: this.unban, bans: this.bans, kick: this.kick, warn: this.warn, signout: this.signout, 'note.add': this.noteAdd,
      rename: this.rename, reset: this.reset, audit: this.auditList, 'settings.get': this.settingsGet, 'settings.set': this.settingsSet,
      broadcast: this.broadcast,
    };
  }

  async overview(actor) {
    await this.srv.store.flush().catch(() => {}); // (what's only in memory, so the totals are current)
    const { rows: [u] } = await this.db.query(`SELECT count(*)::int AS accounts, count(discord_id)::int AS linked,
      COALESCE(sum((state->>'money')::float8), 0)::float8 AS money,
      COALESCE(sum(jsonb_array_length(COALESCE(state->'inv', '[]'::jsonb))), 0)::float8 AS items FROM users`);
    const { rows: [b] } = await this.db.query('SELECT count(*)::int AS n FROM bans WHERE lifted IS NULL AND (expires IS NULL OR expires > $1)', [Date.now()]);
    const { rows: recent } = await this.db.query('SELECT * FROM audit ORDER BY at DESC, id DESC LIMIT 15');
    return {
      me: { name: actor.name, level: actor.level, levelName: LEVEL_NAMES[actor.level] },
      online: this.srv.sockets.size, accounts: u.accounts, linked: u.linked, activeBans: b.n,
      money: round2(Number(u.money)), items: Number(u.items), uptime: Date.now() - this.started, startedAt: this.started,
      db: this.srv.db.kind, discord: this.discord.status(), settings: { ...this.settings }, recent: recent.map(auditRow),
    };
  }

  // Account ids with a staff level: ADMIN_USERS and linked accounts (the most recently seen first; levels are cached).
  async staffIds() {
    const { rows } = await this.db.query(`SELECT id, name FROM users WHERE name_lc = ANY($1::text[]) OR discord_id IS NOT NULL
      ORDER BY last_seen DESC LIMIT ${MAX_STAFF_SCAN}`, [[...this.admins]]);
    const out = [], until = Date.now() + 5000; // (quick lookups; past 5 s, the levels already known)
    for (let i = 0; i < rows.length; i += 10) {
      const levels = Date.now() > until ? rows.slice(i, i + 10).map((r) => this.knownLevel(r))
        : await Promise.all(rows.slice(i, i + 10).map((r) => this.levelOf(r.id, { fast: true })));
      rows.slice(i, i + 10).forEach((r, j) => { if (levels[j] >= 1) out.push(r.id); });
    }
    return out;
  }

  async players(actor, a) {
    const q = text(a.q, 'Search', 64, { min: 0 }).toLowerCase();
    const filter = a.filter ?? 'all';
    if (!FILTERS.includes(filter)) fail('Unknown filter');
    const page = a.page == null ? 0 : int(a.page, 'Page', 0, 1e6);
    const now = Date.now();
    const params = [];
    const p = (v) => { params.push(v); return '$' + params.length; };
    const tNow = p(now);
    const where = [`${tNow}::bigint IS NOT NULL`]; // (every parameter is used in both queries, so Postgres knows its type)
    if (q) { const x = p(like(q)); where.push(`(u.name_lc LIKE ${x} OR lower(COALESCE(u.discord_name, '')) LIKE ${x})`); }
    if (filter === 'online') where.push(`u.id = ANY(${p([...this.srv.sockets.keys()])}::int[])`);
    if (filter === 'linked') where.push('u.discord_id IS NOT NULL');
    if (filter === 'staff') where.push(`u.id = ANY(${p(await this.staffIds())}::int[])`);
    const banned = `EXISTS (SELECT 1 FROM bans b WHERE b.user_id = u.id AND b.lifted IS NULL AND (b.expires IS NULL OR b.expires > ${tNow}))`;
    if (filter === 'banned') where.push(banned);
    const W = 'WHERE ' + where.join(' AND ');
    // Who's online comes first (their last_seen is only written as they change something). Ids from the socket map,
    // numbers: written into the query rather than passed, since the count query doesn't use them.
    const online = [...this.srv.sockets.keys()].map(Number).filter(Number.isInteger).join(',') || 'NULL';
    const { rows: [c] } = await this.db.query(`SELECT count(*)::int AS n FROM users u ${W}`, params);
    const { rows } = await this.db.query(`SELECT u.id, u.name, u.created, u.last_seen, u.discord_id, u.discord_name, ${banned} AS banned,
      (u.state->>'money')::float8 AS money, (u.state->'prof'->>'level')::int AS level, u.state->'inv' AS inv
      FROM users u ${W} ORDER BY u.id IN (${online}) DESC, u.last_seen DESC, u.id DESC LIMIT ${PAGE} OFFSET ${page * PAGE}`, params);
    return {
      rows: rows.map((r) => {
        const e = this.srv.store.cache.get(r.id); // (fresher than the saved row)
        const inv = e ? e.st.inv : parse(r.inv) || [];
        return {
          id: r.id, name: r.name, online: this.srv.isOnline(r.id), money: round2(e ? e.st.money : Number(r.money) || 0),
          level: (e ? e.st.prof?.level : r.level) || 1, worth: worthOf(inv), items: inv.length,
          discord: r.discord_id ? { id: r.discord_id, name: r.discord_name || '' } : null, banned: !!r.banned,
          staff: this.knownLevel(r), created: num(r.created), lastSeen: num(r.last_seen),
        };
      }),
      total: c.n, page,
    };
  }

  async player(actor, a) {
    const t = await this.target(a.id);
    const { state, rev } = await this.srv.store.withUser(t.id, async (e) => ({ state: structuredClone(e.st), rev: revOf(e.st) }));
    const now = Date.now();
    const { rows: [cfg] } = await this.db.query('SELECT config, config_at FROM users WHERE id = $1', [t.id]);
    const { rows: bans } = await this.db.query('SELECT b.*, u.name FROM bans b LEFT JOIN users u ON u.id = b.user_id WHERE b.user_id = $1 ORDER BY b.created DESC, b.id DESC', [t.id]);
    const { rows: notes } = await this.db.query('SELECT id, by_name, text, created FROM notes WHERE user_id = $1 ORDER BY created DESC, id DESC LIMIT 200', [t.id]);
    const { rows: snaps } = await this.db.query('SELECT id, label, kind, by_name, created, length(state::text) AS size FROM snapshots WHERE user_id = $1 ORDER BY created DESC, id DESC', [t.id]);
    const { rows: audit } = await this.db.query('SELECT * FROM audit WHERE target_id = $1 ORDER BY at DESC, id DESC LIMIT 40', [t.id]);
    const { rows: alts } = await this.db.query(`SELECT DISTINCT u.id, u.name,
      EXISTS (SELECT 1 FROM bans b WHERE b.user_id = u.id AND b.lifted IS NULL AND (b.expires IS NULL OR b.expires > $2)) AS banned
      FROM user_ips a JOIN user_ips o ON o.ip_hash = a.ip_hash AND o.user_id <> a.user_id JOIN users u ON u.id = o.user_id
      WHERE a.user_id = $1 ORDER BY u.id LIMIT 50`, [t.id, now]);
    const ban = await this.activeBan({ userId: t.id });
    return {
      user: {
        id: t.id, name: t.name, created: num(t.created), lastSeen: num(t.last_seen), online: this.srv.isOnline(t.id),
        discord: t.discord_id ? { id: t.discord_id, name: t.discord_name || '', linkedAt: num(t.linked_at) } : null,
        staff: await this.levelOf(t.id, { fast: true }), ban: ban && publicBan(ban),
      },
      state, rev, config: parse(cfg?.config) ?? null, configAt: num(cfg?.config_at),
      bans: bans.map((r) => banRow(r, now)),
      notes: notes.map((r) => ({ id: r.id, by: r.by_name, text: r.text, created: num(r.created) })),
      snapshots: snaps.map(snapRow),
      trades: await this.srv.trades.list(t.id),
      audit: audit.map(auditRow),
      alts: alts.map((r) => ({ id: r.id, name: r.name, banned: !!r.banned })),
    };
  }

  // Money, stars, detachments, the profile, stats and ranks: checked field by field (editPlan), then saved before the
  // answer.
  async edit(actor, a) {
    const t = await this.target(a.id);
    await this.canChange(actor, t);
    const out = await this.srv.store.withUser(t.id, async (e) => {
      const st = e.st;
      const { next, changed, before, after } = editPlan(st, a.set);
      if (!changed.length) return { state: pick(st, Object.keys(next)), changed };
      const snapJson = JSON.stringify(st);
      applyEdit(st, next);
      this.srv.store.markDirty(e);
      await this.srv.store.commit([e], this.autoSnap(t, actor, 'edit', snapJson));
      const keys = Object.keys(before);
      this.srv.deltaTo(t.id, { set: pick(st, keys), add: [], del: [], upd: [] });
      return { state: pick(st, Object.keys(next)), changed, before, after };
    });
    if (out.changed.length) await this.audit(actor, 'edit', t, { changed: out.changed, before: out.before, after: out.after });
    return { state: out.state };
  }

  // Every top-level field but the inventory and the NPC data, replaced as given, from the state the panel loaded: `base`
  // is that `player` answer's `rev`, and anything changed since refuses the edit (the rules: rawEdit).
  async editRaw(actor, a) {
    const t = await this.target(a.id);
    await this.canChange(actor, t);
    const out = await this.srv.store.withUser(t.id, async (e) => {
      const { next, changed, before, after } = rawEdit(e.st, a.state, a.base);
      if (!changed.length) return { state: rawView(e.st), rev: revOf(e.st), changed };
      const snapJson = JSON.stringify(e.st);
      replaceInPlace(e.st, next);
      this.srv.store.markDirty(e);
      await this.srv.store.commit([e], this.autoSnap(t, actor, 'raw edit', snapJson));
      // (a field the new state no longer has goes as null: the game only sets the keys it's sent)
      this.srv.deltaTo(t.id, { set: Object.fromEntries(changed.map((k) => [k, e.st[k] ?? null])), add: [], del: [], upd: [] });
      return { state: rawView(e.st), rev: revOf(e.st), changed, before, after };
    });
    if (out.changed.length) await this.audit(actor, 'edit.raw', t, { changed: out.changed, before: out.before, after: out.after });
    return { state: out.state, rev: out.rev };
  }

  async itemsGive(actor, a) {
    const t = await this.target(a.id);
    await this.canChange(actor, t);
    const { specs, total } = giveSpecs(a.items);
    const out = await this.srv.store.withUser(t.id, async (e) => {
      const cap = this.srv.INV_CAP;
      if (e.st.inv.length + total > cap) fail(`${t.name}'s inventory would be over the limit (${cap} items)`, 'full');
      const items = buildItems(specs, (key) => this.srv.serial(key)); // (the server's own counters)
      const ctx = makeCtx(e.st, { online: true, invCap: cap });
      give(ctx, items);
      this.srv.store.markDirty(e);
      await this.srv.store.commit([e]);
      this.srv.deltaTo(t.id, delta(ctx), `You got ${items.length} item${items.length === 1 ? '' : 's'} from the staff`);
      return items;
    });
    await this.audit(actor, 'items.give', t, givenDetail(out));
    return { added: out.length };
  }

  async itemsRemove(actor, a) {
    const t = await this.target(a.id);
    await this.canChange(actor, t);
    const uids = removeUids(a.uids);
    const out = await this.srv.store.withUser(t.id, async (e) => {
      const snapJson = JSON.stringify(e.st);
      // Locked items go too; items in an open trade offer don't (take() refuses them before changing anything).
      const ctx = makeCtx(e.st, { online: true, reserved: this.srv.trades.reserved(t.id) });
      const items = take(ctx, uids, { allowLocked: true });
      this.srv.store.markDirty(e);
      await this.srv.store.commit([e], this.autoSnap(t, actor, 'item removal', snapJson));
      this.srv.deltaTo(t.id, delta(ctx));
      return items;
    });
    await this.audit(actor, 'items.remove', t, removedDetail(out));
    return { removed: out.length };
  }

  async snapSave(actor, a) {
    const t = await this.target(a.id);
    const label = text(a.label, 'Label', 80, { min: 0 }) || `Saved by ${actor.name}`;
    const { rows: [c] } = await this.db.query("SELECT count(*)::int AS n FROM snapshots WHERE user_id = $1 AND kind = 'manual'", [t.id]);
    if (c.n >= MAX_MANUAL) fail(`${t.name} has ${MAX_MANUAL} saved snapshots. Delete some first.`);
    const id = await this.srv.store.withUser(t.id, (e) =>
      this.saveSnap((sql, p) => this.db.query(sql, p), t.id, { label, kind: 'manual', by: actor.name, stateJson: JSON.stringify(e.st) }));
    await this.audit(actor, 'snapshot.save', t, { snap: id, label });
    return { id };
  }

  async snapList(actor, a) {
    const t = await this.target(a.id);
    const { rows } = await this.db.query('SELECT id, label, kind, by_name, created, length(state::text) AS size FROM snapshots WHERE user_id = $1 ORDER BY created DESC, id DESC', [t.id]);
    return rows.map(snapRow);
  }

  async snapshot(snap) {
    const { rows } = await this.db.query('SELECT s.*, u.name FROM snapshots s JOIN users u ON u.id = s.user_id WHERE s.id = $1', [int(snap, 'Snapshot id', 1, 2 ** 31 - 1)]);
    if (!rows.length) fail('That snapshot is gone', 'missing');
    return rows[0];
  }

  async snapGet(actor, a) {
    const s = await this.snapshot(a.snap);
    return { id: s.id, user: { id: s.user_id, name: s.name }, label: s.label, kind: s.kind, by: s.by_name, created: num(s.created), state: parse(s.state), config: parse(s.config) ?? null };
  }

  async snapRestore(actor, a) {
    const s = await this.snapshot(a.snap);
    const t = await this.target(s.user_id);
    await this.canChange(actor, t);
    const { dropped, rewards } = await this.replaceWith(actor, t, upgradeState(parse(s.state)), 'restore');
    await this.audit(actor, 'snapshot.restore', t, { snap: s.id, label: s.label, created: num(s.created), dropped, rewards });
    return { dropped, rewards };
  }

  async snapDelete(actor, a) {
    const s = await this.snapshot(a.snap);
    const t = await this.target(s.user_id);
    await this.canChange(actor, t);
    await this.db.query('DELETE FROM snapshots WHERE id = $1', [s.id]);
    await this.audit(actor, 'snapshot.delete', t, { snap: s.id, label: s.label, kind: s.kind });
    return {};
  }

  async configGet(actor, a) {
    const t = await this.target(a.id);
    const { rows } = await this.db.query('SELECT config, config_at FROM users WHERE id = $1', [t.id]);
    return { config: parse(rows[0]?.config) ?? null, at: num(rows[0]?.config_at) };
  }

  async ban(actor, a) {
    const t = await this.target(a.id);
    await this.canPunish(actor, t);
    const reason = text(a.reason, 'Reason', 300);
    const minutes = a.minutes == null ? null : int(a.minutes, 'Minutes', 1, 5256000);
    const network = optBool(a.network, 'network'), discordBan = optBool(a.discordBan, 'discordBan');
    if ((network || discordBan) && actor.level < 2) fail('Only admins can block a network or ban from the Discord server', 'perm');
    if (discordBan && !this.discord.enabled) fail("This server isn't connected to Discord");
    if (discordBan && !t.discord_id) fail(`${t.name} has no linked Discord account`);
    // A network ban: the account and the network it last used (other accounts from it can't log in or sign up).
    let ipHash = null;
    if (network) ipHash = (await this.db.query('SELECT ip_hash FROM user_ips WHERE user_id = $1 ORDER BY last DESC LIMIT 1', [t.id])).rows[0]?.ip_hash || null;
    // Blocking the network you're on yourself would block everyone else on it too (on a server run on this machine:
    // every player).
    if (ipHash && actor.id != null && [...(this.srv.sockets.get(actor.id) || [])].some((ws) => ws.ipHash === ipHash)) {
      fail(`${t.name} is on the same network as you, so blocking it would block everyone else there too. Ban the account only.`);
    }
    const created = Date.now(), expires = minutes ? created + minutes * MIN : null;
    // (by_level: only staff at that level or above can lift it)
    const { rows } = await this.db.query('INSERT INTO bans (user_id, ip_hash, reason, by_name, by_level, created, expires) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
      [t.id, ipHash, reason, actor.name, actor.level, created, expires]);
    const ban = { id: rows[0].id, reason, expires, by: actor.name, network: !!ipHash };
    this.srv.kick(t.id, { code: 'banned', error: banText(ban), ban: publicBan(ban) });
    if (ipHash) {
      for (const [id, set] of [...this.srv.sockets]) {
        if (id !== t.id && [...set].some((ws) => ws.ipHash === ipHash) && await this.levelOf(id, { fast: true }) < 1) this.srv.kick(id, { code: 'banned', error: networkBanText(ban), ban: publicBan(ban) });
      }
    }
    // The ban is in force: telling them on Discord (and the Discord ban) gets a few seconds before the answer goes.
    const [dm, discord] = await Promise.all([
      t.discord_id ? soon(this.discord.dm(t.discord_id, { content: `You were banned from the game server: ${reason}\n${expires ? `The ban ends <t:${Math.floor(expires / 1000)}:f>.` : 'The ban is permanent.'}` }).then(Boolean, () => false)) : false,
      discordBan ? soon(this.discord.ban(t.discord_id, `${reason} (game ban by ${actor.name})`).catch((e) => ({ ok: false, error: e?.message || 'failed' }))) : null,
    ]);
    await this.audit(actor, 'ban', t, { reason, minutes, expires, network: !!ipHash, networkAsked: network, discordBan, discord, dm });
    return { ban: { ...ban, created, dm, discord } };
  }

  async unban(actor, a) {
    const t = await this.target(a.id);
    // Never your own ban (as the account, or as the Discord user linked to it), and none made by higher staff: a
    // moderator an admin banned stays banned, even after moving their Discord link to another account.
    if (this.isSelf(actor, t)) fail("You can't lift your own ban", 'perm');
    const discordUnban = optBool(a.discordUnban, 'discordUnban');
    if (discordUnban && !this.discord.enabled) fail("This server isn't connected to Discord");
    if (discordUnban && !t.discord_id) fail(`${t.name} has no linked Discord account`);
    const now = Date.now();
    const { rows: [top] } = await this.db.query(`SELECT max(by_level) AS lv FROM bans
      WHERE user_id = $1 AND lifted IS NULL AND (expires IS NULL OR expires > $2)`, [t.id, now]);
    const need = top?.lv == null ? 0 : clampLevel(top.lv);
    if (need > actor.level) fail(`Only an ${LEVEL_NAMES[need]} can lift this ban`, 'perm');
    // The account's bans, network bans made with it included (they carry its id); one made higher meanwhile stays.
    const { rows } = await this.db.query(`UPDATE bans SET lifted = $1, lifted_by = $2
      WHERE user_id = $3 AND lifted IS NULL AND (expires IS NULL OR expires > $1) AND COALESCE(by_level, 0) <= $4 RETURNING id`, [now, actor.name, t.id, actor.level]);
    const discord = discordUnban ? await soon(this.discord.unban(t.discord_id, `Unbanned in the game by ${actor.name}`).catch((e) => ({ ok: false, error: e?.message || 'failed' }))) : null;
    if (rows.length || discordUnban) await this.audit(actor, 'unban', t, { lifted: rows.length, bans: rows.map((r) => r.id), discordUnban, discord });
    return { lifted: rows.length, ...(discordUnban ? { discord } : {}) };
  }

  async bans(actor, a) {
    const active = optBool(a.active, 'active');
    const now = Date.now();
    const { rows } = active
      ? await this.db.query(`SELECT b.*, u.name FROM bans b LEFT JOIN users u ON u.id = b.user_id
          WHERE b.lifted IS NULL AND (b.expires IS NULL OR b.expires > $1) ORDER BY b.created DESC, b.id DESC LIMIT 500`, [now])
      : await this.db.query('SELECT b.*, u.name FROM bans b LEFT JOIN users u ON u.id = b.user_id ORDER BY b.created DESC, b.id DESC LIMIT 500');
    return rows.map((r) => banRow(r, now));
  }

  async kick(actor, a) {
    const t = await this.target(a.id);
    await this.canPunish(actor, t);
    const reason = text(a.reason, 'Reason', 300, { min: 0 });
    const kicked = this.srv.kick(t.id, { code: 'kicked', error: reason ? `Disconnected by a moderator: ${reason}` : 'Disconnected by a moderator' });
    await this.audit(actor, 'kick', t, { reason, online: kicked });
    return { kicked };
  }

  async warn(actor, a) {
    const t = await this.target(a.id);
    await this.canPunish(actor, t);
    const msg = text(a.msg, 'Message', 500);
    const online = this.srv.isOnline(t.id);
    this.srv.sendTo(t.id, { t: 'admin.msg', kind: 'warn', msg, from: actor.name });
    // (the DM gets a few seconds: null when Discord hasn't answered by then)
    const dm = t.discord_id ? await soon(this.discord.dm(t.discord_id, { content: `Warning from a moderator of the game server:\n> ${msg.replace(/\n/g, '\n> ')}` }).then(Boolean, () => false)) : false;
    await this.audit(actor, 'warn', t, { msg, online, dm });
    return { delivered: online || dm };
  }

  async signout(actor, a) {
    const t = await this.target(a.id);
    await this.canPunish(actor, t);
    await A.endSessions(this.db, t.id);
    const online = this.srv.kick(t.id, { code: 'auth', error: 'You were signed out. Log in again.' });
    await this.audit(actor, 'signout', t, { online });
    return {};
  }

  async noteAdd(actor, a) {
    const t = await this.target(a.id);
    const note = text(a.text, 'Note', 1000);
    const { rows } = await this.db.query('INSERT INTO notes (user_id, by_name, text, created) VALUES ($1, $2, $3, $4) RETURNING id', [t.id, actor.name, note, Date.now()]);
    await this.audit(actor, 'note.add', t, { note: rows[0].id, text: note });
    return { id: rows[0].id };
  }

  async rename(actor, a) {
    const t = await this.target(a.id);
    await this.canChange(actor, t);
    if (typeof a.name !== 'string') fail('Pick a username');
    const name = a.name.trim();
    const bad = A.validName(name);
    if (bad) fail(bad);
    // A name in ADMIN_USERS is an admin: nobody gets one by being renamed to it, and a listed account keeps its name
    // (renamed away, the name would be free for whoever registers it next).
    const other = name.toLowerCase() !== t.name.toLowerCase();
    if (other && this.admins.has(name.toLowerCase())) fail('That username is reserved on this server');
    if (other && this.admins.has(t.name.toLowerCase())) fail('This username is in ADMIN_USERS: change ADMIN_USERS first');
    if (name === t.name) return { name };
    const offers = await this.srv.store.withUser(t.id, async (e) => {
      // Open offers carry both names (and the trade page tells an incoming offer from a sent one by them).
      const renamed = [...this.srv.trades.open.values()].filter((o) => o.from_id === t.id || o.to_id === t.id)
        .map((o) => [o, { ...o.offer, ...(o.from_id === t.id ? { fromName: name } : {}), ...(o.to_id === t.id ? { toName: name } : {}) }]);
      try {
        await this.db.tx(async (q) => {
          await q('UPDATE users SET name = $1, name_lc = $2 WHERE id = $3', [name, name.toLowerCase(), t.id]);
          for (const [o, offer] of renamed) await q('UPDATE trades SET offer = $1::jsonb WHERE id = $2', [JSON.stringify(offer), o.id]);
        });
      } catch (err) {
        if (/unique|duplicate/i.test(err.message)) fail('That username is taken');
        throw err;
      }
      e.name = name;
      for (const [o, offer] of renamed) o.offer = offer;
      return renamed.map(([o]) => o);
    });
    this.levels.delete(t.id);
    for (const ws of this.srv.sockets.get(t.id) || []) if (ws.user) ws.user.name = name; // (their open connections' requests)
    if (offers.length) await this.srv.trades.pushLists(...offers.flatMap((o) => [o.from_id, o.to_id]));
    this.srv.notice(t.id, `Your username is now <b>${name}</b>`);
    await this.audit(actor, 'rename', { id: t.id, name }, { before: t.name, after: name });
    return { name };
  }

  async reset(actor, a) {
    const t = await this.target(a.id);
    await this.canChange(actor, t);
    await this.replaceWith(actor, t, A.newState(), 'reset');
    await this.audit(actor, 'reset', t, {});
    return {};
  }

  async auditList(actor, a) {
    const q = text(a.q, 'Search', 80, { min: 0 });
    const page = a.page == null ? 0 : int(a.page, 'Page', 0, 1e6);
    const where = q ? 'WHERE actor ILIKE $1 OR target_name ILIKE $1 OR action ILIKE $1' : '';
    const params = q ? [like(q)] : [];
    const { rows: [c] } = await this.db.query(`SELECT count(*)::int AS n FROM audit ${where}`, params);
    const { rows } = await this.db.query(`SELECT * FROM audit ${where} ORDER BY at DESC, id DESC LIMIT ${PAGE} OFFSET ${page * PAGE}`, params);
    return { rows: rows.map(auditRow), total: c.n, page };
  }

  async settingsGet() { return { ...this.settings }; }

  async settingsSet(actor, a) {
    this.need(actor, 2);
    if (!isObj(a.settings)) fail('Invalid settings');
    const run = this.settingsQ.then(async () => {
      const next = { ...this.settings };
      for (const [k, v] of Object.entries(a.settings)) {
        if (k === 'motd') next.motd = text(v, 'Message of the day', 300, { min: 0 });
        else if (k === 'maintenanceMsg') next.maintenanceMsg = text(v, 'Maintenance message', 300, { min: 0 });
        else if (['maintenance', 'registration', 'trading', 'gambling'].includes(k)) next[k] = bool(v, k);
        else fail(`Unknown setting: ${k}`);
      }
      await this.db.query("INSERT INTO kv (k, v) VALUES ('admin', $1::jsonb) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v", [JSON.stringify(next)]);
      const before = this.settings;
      this.settings = next;
      return { before, next };
    });
    this.settingsQ = run.catch(() => {});
    const { before, next } = await run;
    let kicked = 0;
    if (next.maintenance && !before.maintenance) {
      for (const id of [...this.srv.sockets.keys()]) {
        if (await this.levelOf(id, { fast: true }) >= 1) continue; // (as a hello checks it)
        this.srv.kick(id, { code: 'maintenance', error: this.maintenanceMsg() });
        kicked++;
      }
    }
    const changed = Object.keys(next).filter((k) => next[k] !== before[k]);
    if (changed.length) await this.audit(actor, 'settings.set', null, { changed, before: pick(before, changed), after: pick(next, changed), kicked });
    return { ...next };
  }
  maintenanceMsg() { return this.settings.maintenanceMsg || 'The server is under maintenance. Try again later.'; }

  async broadcast(actor, a) {
    this.need(actor, 2);
    const msg = text(a.msg, 'Message', 500);
    const sent = this.srv.broadcastMsg({ t: 'admin.msg', kind: 'broadcast', msg, from: actor.name });
    await this.audit(actor, 'broadcast', null, { msg, sent });
    return { sent };
  }

  // ---- ns 'account' (any player) -------------------------------------------------------------------------------------
  async accountRpc(user, m, args) {
    const a = isObj(args) ? args : {};
    switch (String(m)) {
      case 'info': return this.account(user.id);
      case 'link.code': {
        if (!this.discord.enabled) fail("This server isn't connected to Discord");
        // (codes live in this server's memory: only the bot running here would ever see the /link they go into)
        if (!this.discord.interactions) fail("This server can't take /link right now: its Discord bot runs on another server");
        for (const [c, x] of this.linkCodes) if (x.userId === user.id) this.linkCodes.delete(c); // (one per account)
        let code;
        do code = randomCode(6); while (this.linkCodes.has(code));
        const expires = Date.now() + LINK_MS;
        this.linkCodes.set(code, { userId: user.id, expires });
        return { code: showCode(code), expires };
      }
      case 'unlink': {
        await this.unlink(user.id, null);
        return this.account(user.id);
      }
      case 'config.save': {
        const { json } = jsonOf(a.config, 'Configs');
        const at = Date.now();
        await this.db.query('UPDATE users SET config = $1::jsonb, config_at = $2 WHERE id = $3', [json, at, user.id]);
        return { at };
      }
      case 'config.get': {
        const { rows } = await this.db.query('SELECT config, config_at FROM users WHERE id = $1', [user.id]);
        return { config: parse(rows[0]?.config) ?? null, at: num(rows[0]?.config_at) };
      }
    }
    return fail('Unknown request');
  }

  // ---- linking -------------------------------------------------------------------------------------------------------
  // Links a game account to a Discord user (`du` = { id, name }); a Discord user linked to another account moves here.
  // Returns the account's name and `finish` (roles, pushes, the audit row), to run once Discord has its answer: an
  // interaction has to be answered within 3 s, and those are Discord calls that can wait out rate limits.
  async link(userId, du) {
    const dname = String(du.name || '').toWellFormed();
    const res = await this.db.tx(async (q) => {
      const { rows: from } = await q('SELECT id, name FROM users WHERE discord_id = $1 AND id <> $2', [du.id, userId]);
      if (from.length) await q('UPDATE users SET discord_id = NULL, discord_name = NULL, linked_at = NULL WHERE discord_id = $1 AND id <> $2', [du.id, userId]);
      const { rows: [me] } = await q('SELECT name, discord_id FROM users WHERE id = $1', [userId]);
      await q('UPDATE users SET discord_id = $1, discord_name = $2, linked_at = $3 WHERE id = $4', [du.id, dname, Date.now(), userId]);
      return { from, me };
    });
    const ids = [userId, ...res.from.map((r) => r.id)];
    for (const id of ids) { this.levels.delete(id); this.dropResetCodes(id); }
    const prev = res.me?.discord_id;
    const name = res.me?.name || '?';
    const finish = async () => {
      // (best effort: the roles get a few seconds, then the pushes and the audit row go anyway)
      await Promise.all([
        prev && prev !== du.id ? soon(this.discord.setLinkedRole(prev, false).catch(() => false)) : null,
        soon(this.discord.setLinkedRole(du.id, true).catch(() => false)),
      ]);
      for (const id of ids) await this.srv.pushAccount(id);
      await this.audit({ name, discordId: du.id }, 'link', { id: userId, name }, { discord: { id: du.id, name: du.name || '' }, movedFrom: res.from.map((r) => r.name), replaced: prev && prev !== du.id ? prev : null });
    };
    return { name, finish };
  }

  // Unlinks a game account (actor: the player when null). Returns the name it was linked to, or null.
  async unlink(userId, actor) {
    const { rows } = await this.db.query('SELECT name, discord_id, discord_name FROM users WHERE id = $1', [userId]);
    const r = rows[0];
    if (!r?.discord_id) return null;
    await this.db.query('UPDATE users SET discord_id = NULL, discord_name = NULL, linked_at = NULL WHERE id = $1 AND discord_id = $2', [userId, r.discord_id]);
    this.levels.delete(userId);
    this.dropResetCodes(userId);
    await soon(this.discord.setLinkedRole(r.discord_id, false).catch(() => false)); // (best effort: a few seconds at most)
    await this.srv.pushAccount(userId);
    await this.audit(actor || { name: r.name, discordId: r.discord_id }, 'unlink', { id: userId, name: r.name }, { discord: { id: r.discord_id, name: r.discord_name || '' } });
    return r.name;
  }

  // A reset code belongs to the Discord user the account was linked to: unlinking or linking again takes it back.
  dropResetCodes(userId) {
    for (const [c, x] of this.resetCodes) if (x.userId === userId) this.resetCodes.delete(c);
  }

  // POST /api/reset: a code from /resetpassword, for this account, still linked to the Discord user it was given to.
  // A wrong password keeps the code usable.
  async resetPassword(name, code, password) {
    const c = cleanCode(code), r = this.resetCodes.get(c);
    const wrong = () => { throw new A.AuthError('That reset code is wrong or expired'); };
    if (typeof name !== 'string' || !r || r.expires < Date.now()) wrong();
    const { rows } = await this.db.query('SELECT id, name, discord_id FROM users WHERE name_lc = $1', [name.toLowerCase()]);
    if (!rows.length || rows[0].id !== r.userId || rows[0].discord_id !== r.discordId) wrong();
    if (!(await A.setPassword(this.db, r.userId, password, { discordId: r.discordId }))) wrong(); // (unlinked meanwhile)
    this.resetCodes.delete(c);
    this.srv.kick(r.userId, { code: 'auth', error: 'Your password was changed. Log in again.' });
    await this.audit({ name: rows[0].name, discordId: r.discordId }, 'resetpassword', { id: r.userId, name: rows[0].name }, {});
    return { ok: true };
  }

  // ---- Discord interactions (spec §4) --------------------------------------------------------------------------------
  async interaction(ix) {
    if (!ix?.user?.id || (!ix.guild_id && !ix.member)) return; // (DMs)
    if (ix.type === 3 || (ix.type == null && ix.customId)) return this.onButton(ix);
    if (ix.type != null && ix.type !== 2) return;
    switch (ix.command) {
      case 'link': return this.cmdLink(ix);
      case 'unlink': return this.cmdUnlink(ix);
      case 'profile': return this.cmdProfile(ix);
      case 'resetpassword': return this.cmdResetPassword(ix);
      case 'game': return this.cmdGame(ix);
    }
  }

  linkedTo(discordId) {
    return this.db.query('SELECT id, name FROM users WHERE discord_id = $1', [String(discordId)]).then((r) => r.rows[0] || null);
  }

  async cmdLink(ix) {
    const now = Date.now();
    let tries = this.linkTries.get(ix.user.id);
    if (tries && now - tries.t > LINK_MS) { this.linkTries.delete(ix.user.id); tries = null; }
    if (tries && tries.n >= LINK_TRIES) return ix.reply({ content: 'Too many wrong codes. Wait a few minutes, then get a new code in the game.', ephemeral: true });
    const code = cleanCode(ix.opt('code'));
    const c = this.linkCodes.get(code);
    if (!c || c.expires < now) {
      if (tries) tries.n++; else this.linkTries.set(ix.user.id, { n: 1, t: now });
      return ix.reply({ content: 'That code is wrong or expired. In the game, click your name, then **Link Discord** for a new one.', ephemeral: true });
    }
    const { rows } = await this.db.query('SELECT name FROM users WHERE id = $1', [c.userId]);
    if (!rows.length) return ix.reply({ content: 'That game account is gone.', ephemeral: true });
    const name = rows[0].name;
    const staff = clampLevel(await this.discord.memberLevel(ix.member));
    const lines = [`Link your Discord account to the game account **${md(name)}**?`];
    if (staff >= 1) lines.push("⚠️ You're staff: this game account gets your powers in the game's admin panel. Only link your own account.");
    return ix.reply({
      content: lines.join('\n\n'), ephemeral: true,
      components: [{ type: 1, components: [
        { type: 2, style: 3, label: `Link to ${name}`.slice(0, 80), custom_id: `link:yes:${code}` },
        { type: 2, style: 2, label: 'Cancel', custom_id: 'link:no' },
      ] }],
    });
  }

  async onButton(ix) {
    const id = String(ix.customId || '');
    if (id === 'link:no') return ix.update({ content: 'Cancelled: nothing was linked.', components: [] });
    const m = /^link:yes:([A-Z0-9]{6})$/.exec(id);
    if (!m) return;
    const c = this.linkCodes.get(m[1]);
    if (!c || c.expires < Date.now()) return ix.update({ content: 'That code expired. Get a new one in the game and use `/link` again.', components: [] });
    this.linkCodes.delete(m[1]);
    const { name, finish } = await this.link(c.userId, ix.user);
    await ix.update({ content: `Linked to **${md(name)}**. The game shows it in your account; \`/unlink\` undoes it.`, components: [] });
    await finish().catch((e) => this.log('[admin] after linking', e.message));
  }

  async cmdUnlink(ix) {
    const u = await this.linkedTo(ix.user.id);
    if (!u) return ix.reply({ content: "Your Discord account isn't linked to a game account.", ephemeral: true });
    await ix.defer({ ephemeral: true }); // (unlinking takes the role away on Discord first)
    await this.unlink(u.id, { name: '@' + ix.user.name, discordId: ix.user.id });
    return ix.edit({ content: `Unlinked from **${md(u.name)}**.` });
  }

  async cmdProfile(ix) {
    const id = String(ix.opt('member') || ix.user.id);
    const ru = ix.data?.resolved?.users?.[id];
    const who = id === ix.user.id ? ix.user.name : ru?.global_name || ru?.username || 'That member';
    const u = await this.linkedTo(id);
    if (!u) return ix.reply({ content: `${md(who)} hasn't linked a game account (not linked).` });
    const st = (await this.srv.store.load(u.id)).st;
    const s = st.stats || {};
    return ix.reply({
      embeds: [{
        title: u.name, description: `${md(who)}'s game account${this.srv.isOnline(u.id) ? ' · online now' : ''}`, color: GOLD,
        fields: [
          { name: 'Profile level', value: String(st.prof?.level || 1), inline: true },
          { name: 'Items', value: String(st.inv.length), inline: true },
          { name: 'Inventory value', value: `$${worthOf(st.inv).toFixed(2)}`, inline: true },
          { name: 'Cases opened', value: String(s.opened || 0), inline: true },
          { name: 'Matches played', value: String(s.playMatches || 0), inline: true },
          { name: 'Matches won', value: String(s.playWins || 0), inline: true },
        ],
      }],
    });
  }

  async cmdResetPassword(ix) {
    const u = await this.linkedTo(ix.user.id);
    if (!u) return ix.reply({ content: 'Link your game account first: in the game, click your name, then **Link Discord**.', ephemeral: true });
    for (const [c, x] of this.resetCodes) if (x.userId === u.id) this.resetCodes.delete(c);
    let code;
    do code = randomCode(8); while (this.resetCodes.has(code));
    this.resetCodes.set(code, { userId: u.id, discordId: ix.user.id, expires: Date.now() + RESET_MS });
    return ix.reply({
      content: `Password reset code for **${md(u.name)}**: \`${showCode(code)}\`\nIt works once, for 15 minutes. In the game: **Log in** → **Forgot password?**, then your username, this code and a new password. Don't show it to anyone.`,
      ephemeral: true,
    });
  }

  async cmdGame(ix) {
    // Deferred before anything else (Discord waits 3 s), and nothing runs when Discord refuses that: the answer came too
    // late, or this is a replay (after a resume, or to a second server) that was already answered.
    if (!(await ix.defer({ ephemeral: true }))) return;
    const level = clampLevel(await this.discord.memberLevel(ix.member));
    if (level < 1) return ix.edit({ content: 'Only the game\'s staff can use `/game`.' });
    const actor = { id: null, name: ('@' + (ix.user.name || ix.user.id)).toWellFormed(), discordId: ix.user.id, level };
    let out;
    try { out = await this.gameSub(actor, ix); } catch (e) {
      if (!(e instanceof GameError)) this.log('[discord] /game', ix.sub, e);
      out = { content: e instanceof GameError ? e.message : 'Something went wrong on the game server. Check its log.' };
    }
    return ix.edit(out);
  }

  async gameSub(actor, ix) {
    const sub = ix.sub;
    if (sub === 'broadcast') {
      const r = await this.exec(actor, 'broadcast', { msg: ix.opt('message') });
      return { content: `Sent to ${r.sent} player${r.sent === 1 ? '' : 's'} online.` };
    }
    const t = await this.targetByName(ix.opt('player'));
    const name = md(t.name);
    switch (sub) {
      case 'lookup': {
        this.need(actor, 1); // (a read-only view, as in the panel)
        const st =(await this.srv.store.load(t.id)).st;
        const ban = await this.activeBan({ userId: t.id });
        return {
          embeds: [{
            title: t.name, color: ban ? RED : BLUE,
            fields: [
              { name: 'Online', value: this.srv.isOnline(t.id) ? 'Yes' : 'No', inline: true },
              { name: 'Money', value: `$${round2(st.money).toFixed(2)}`, inline: true },
              { name: 'Profile level', value: String(st.prof?.level || 1), inline: true },
              { name: 'Items', value: `${st.inv.length} ($${worthOf(st.inv).toFixed(2)})`, inline: true },
              { name: 'Discord', value: t.discord_id ? `<@${t.discord_id}>` : 'Not linked', inline: true },
              { name: 'Staff', value: LEVEL_NAMES[await this.levelOf(t.id)], inline: true },
              { name: 'Ban', value: ban ? `${md(ban.reason)} (${ban.expires ? `until <t:${Math.floor(ban.expires / 1000)}:f>` : 'permanent'}, by ${md(ban.by)})` : 'None' },
            ],
          }],
        };
      }
      case 'ban': {
        const dur = String(ix.opt('duration') || 'perm');
        if (!(dur in DURATIONS)) fail('Pick a duration');
        const r = await this.exec(actor, 'ban', { id: t.id, reason: ix.opt('reason'), ...(DURATIONS[dur] ? { minutes: DURATIONS[dur] } : {}) });
        return { content: `Banned **${name}** ${r.ban.expires ? `until <t:${Math.floor(r.ban.expires / 1000)}:f>` : 'permanently'}.${r.ban.dm ? ' They were told in a DM.' : ''}` };
      }
      case 'unban': {
        const r = await this.exec(actor, 'unban', { id: t.id });
        return { content: r.lifted ? `Unbanned **${name}** (${r.lifted} ban${r.lifted === 1 ? '' : 's'} lifted).` : `**${name}** had no active ban.` };
      }
      case 'kick': {
        const r = await this.exec(actor, 'kick', { id: t.id, reason: ix.opt('reason') ?? '' });
        return { content: r.kicked ? `Kicked **${name}**.` : `**${name}** isn't online.` };
      }
      case 'warn': {
        const r = await this.exec(actor, 'warn', { id: t.id, msg: ix.opt('message') });
        return {
          content: r.delivered ? `Warned **${name}**.` : r.delivered === null ? `Warning saved; **${name}** isn't online, and Discord hasn't confirmed the DM yet.`
            : `Warning saved, but **${name}** isn't online and has no Discord linked to tell.`,
        };
      }
    }
    return fail('Unknown command');
  }
}
