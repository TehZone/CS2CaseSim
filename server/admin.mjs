// Staff tools for the online server: who is staff (ADMIN_USERS or the Discord server's roles), bans (accounts and
// networks), kicks, warnings and sign-outs, edits of an account with automatic snapshots, snapshots and restores,
// notes, the audit log, server settings and broadcasts, plus Discord account linking, password resets through Discord
// and the players' synced configs.
// The game's admin panel (ns 'admin' and 'account') and the bot's slash commands call the same methods, so every check,
// audit row and mod-log message is the same whichever way a request comes in. Permissions are always checked here.
import crypto from 'node:crypto';
import { makeCtx, delta, takeForStaff, clearNameForStaff, give, GameError } from '../src/js/engine/actions.js';
import { featuredBadge, grantMedals } from '../src/js/engine/badges.js';
import { upgradeState } from '../src/js/engine/economy.js';
import { capCount, customName, itemName } from '../src/js/engine/items.js';
import { cooldownLeft, forgive, formatWait } from '../src/js/engine/matchmaking.js';
import { listedOf, ownedItems } from '../src/js/engine/storage.js';
import { round2 } from '../src/js/engine/util.js';
// (the checks and rules the offline panel shares)
import {
  KEEP_AUTO, MAX_MANUAL, PAGE, LEVEL_NAMES, fail, isObj, pick, wellFormed, worthOf, replaceInPlace, revOf, rawView, text, int, bool, optBool,
  jsonOf, editPlan, applyEdit, rawEdit, restoreUids, restoreMerge, giveSpecs, buildItems, removeUids, givenDetail, removedDetail, unnamedDetail,
} from '../src/js/engine/admin.js';
import * as A from './accounts.mjs';

const MIN = 60000;
const LINK_MS = 10 * MIN, RESET_MS = 15 * MIN, LEVEL_MS = 60000, UNKNOWN_MS = 10000, LINK_TRIES = 5, BEST_EFFORT_MS = 4000;
const MAX_STAFF_SCAN = 200;
// (market: the Market, players' listings (server/p2pmarket.mjs); with trading off it's closed too. pvp: online PvP matches
// (server/matchmaking.mjs): off, nobody can search for one, and the matches being played finish.)
const DEFAULTS = { motd: '', maintenance: false, maintenanceMsg: '', registration: true, trading: true, gambling: true, market: true, pvp: true };
const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // (no 0/O or 1/I to mix up)
const DURATIONS = { '1h': 60, '1d': 1440, '7d': 10080, '30d': 43200, perm: null };
const FILTERS = ['all', 'online', 'banned', 'linked', 'staff'];
const TITLES = {
  ban: 'Player banned', unban: 'Player unbanned', kick: 'Player kicked', warn: 'Player warned', signout: 'Player signed out everywhere',
  edit: 'Account edited', 'edit.raw': 'Account edited (raw JSON)', 'items.give': 'Items given', 'items.remove': 'Items removed', 'items.unname': 'Item name cleared',
  'snapshot.save': 'Snapshot saved', 'snapshot.restore': 'Snapshot restored', 'snapshot.delete': 'Snapshot deleted', 'note.add': 'Note added',
  rename: 'Player renamed', reset: 'Account reset', 'settings.set': 'Server settings changed', broadcast: 'Broadcast sent',
  link: 'Discord account linked', unlink: 'Discord account unlinked', resetpassword: 'Password reset through Discord',
  report: 'Player reported', 'report.close': 'Report closed', 'bio.clear': 'Summary cleared', 'cooldown.clear': 'Matchmaking cooldown removed',
  'market.cancel': 'Market listing taken down', 'pic.clear': 'Profile picture removed',
  'pvp.end': 'Online match ended by staff', 'pvp.void': 'Online match void (no reward)', 'pvp.dispute': 'Online match: a player\'s numbers disputed',
  'pvp.network': 'Online match: opponents on one network', 'pvp.fault': 'Online match: the host\'s game broke its rules',
  'pvp.contested': 'Online match: the players\' games disagreed with the host\'s result',
};
const RED = 0xeb4b4b, GOLD = 0xe4ae39, BLUE = 0x4b69ff, GREEN = 0x4ade80;
const COLORS = { ban: RED, kick: RED, signout: RED, reset: RED, warn: GOLD, unban: GREEN, link: GREEN, broadcast: BLUE, 'settings.set': BLUE };

const num = (v) => (v == null ? null : Number(v));
const parse = (v) => (typeof v === 'string' && /^[[{]/.test(v) ? JSON.parse(v) : v); // (JSONB: objects, or their text)
const like = (s) => '%' + s.replace(/[\\%_]/g, '\\$&') + '%';
const clampLevel = (n) => Math.max(0, Math.min(3, Math.floor(Number(n) || 0)));
const md = (s) => String(s).replace(/[\\*_~`|<>[\]()]/g, '\\$&'); // (game and Discord names in Discord's markdown: no styles, no masked links)
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
// (bio: their summary when reported; about.bio: as it is now. about.staff: what the panel offers, the server still checks.
// faces (a staff game with face1): pic, their profile picture when reported (picDown: staff have taken it down since), and
// about.pic as it is now: hashes, which staff fetch with pic.get.)
const reportRow = (r, staff, faces = false) => ({
  id: r.id, from: { id: r.from_id, name: r.from_name }, about: { id: r.about_id, name: r.about_name, staff, bio: r.about_bio || '', ...(faces ? { pic: r.about_pic || null } : {}) },
  reason: r.reason, text: r.text, bio: r.bio || '', ...(faces ? { pic: r.pic || null, picDown: r.pic_removed != null } : {}),
  messages: parse(r.messages) ?? [], at: num(r.at), closedAt: num(r.closed_at), closedBy: r.closed_by || null,
});

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
  // Taking down what a player put up: the same, for moderators too.
  async canTidy(actor, t) {
    this.need(actor, 1);
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
    if (action === 'items.unname') fields.push({ name: 'Name', value: `${md(detail.item)}: ${md(detail.name)}` });
    if (action === 'bio.clear') fields.push({ name: 'Summary', value: md(String(detail.bio).slice(0, 1000)) });
    if (action === 'pic.clear') fields.push({ name: 'Picture', value: `\`${String(detail.pic).slice(0, 16)}\``, inline: true });
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
    const who = new Set(), closed = [];
    for (const t of [...T.open.values()]) {
      if (t.from_id !== id && t.to_id !== id) continue;
      await T.close(t, 'cancelled');
      who.add(t.from_id); who.add(t.to_id);
      closed.push(t.id);
    }
    if (closed.length) await T.pushClosed(...closed);
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
        SELECT it->>'uid' AS uid FROM users u, jsonb_array_elements(COALESCE(u.state->'inv', '[]'::jsonb) || COALESCE(u.state->'stored', '[]'::jsonb) || COALESCE(u.state->'listed', '[]'::jsonb)) AS it WHERE u.id <> $1
        UNION ALL
        SELECT it->>'uid' AS uid FROM rounds r, jsonb_each(COALESCE(r.data->'escrow', '{}'::jsonb)) AS x(k, v),
          jsonb_array_elements(COALESCE(x.v->'items', '[]'::jsonb)) AS it WHERE r.status = 'open'
      ) s WHERE uid = ANY($2::text[])`, [id, [...want]]);
    for (const r of rows) out.add(r.uid);
    for (const e of this.srv.store.cache.values()) if (e.id !== id) for (const it of ownedItems(e.st)) if (want.has(it.uid)) out.add(it.uid);
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
      // (their Market listings end too, and the new state's are inventory items in it: server/p2pmarket.mjs beforeReplace)
      await this.srv.p2p?.beforeReplace(e, next);
      // (its items and its rewards' items owned elsewhere now are left out: see restoreMerge)
      const elsewhere = await this.ownedElsewhere(t.id, restoreUids(next));
      const { dropped, rewards } = restoreMerge(e.st, next, { elsewhere, startOver: what === 'reset' });
      grantMedals(next); // (as a loaded state: a snapshot's prestiges from before their badges get them, engine/badges.js)
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

  // (faces: the staff member's game reads face1's shapes, server/index.mjs CAPS: their requests' answers can have pictures.)
  async rpc(user, m, args, { faces = false } = {}) {
    return this.exec({ ...(await this.actorFor(user)), faces }, String(m), isObj(args) ? args : {});
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
      'items.give': this.itemsGive, 'items.remove': this.itemsRemove, 'items.unname': this.itemsUnname, 'snapshot.save': this.snapSave, 'snapshot.list': this.snapList,
      'snapshot.get': this.snapGet, 'snapshot.restore': this.snapRestore, 'snapshot.delete': this.snapDelete, 'config.get': this.configGet,
      ban: this.ban, unban: this.unban, bans: this.bans, kick: this.kick, warn: this.warn, signout: this.signout, 'note.add': this.noteAdd,
      rename: this.rename, reset: this.reset, audit: this.auditList, 'settings.get': this.settingsGet, 'settings.set': this.settingsSet,
      broadcast: this.broadcast, reports: this.reports, 'report.close': this.reportClose, 'bio.clear': this.bioClear, 'cooldown.clear': this.cooldownClear,
      'market.player': this.marketPlayer, 'market.cancel': this.marketCancel, 'pic.clear': this.picClear, 'pic.get': this.picGet,
      'pvp.live': this.pvpLive, 'pvp.end': this.pvpEnd,
    };
  }

  // ---- online PvP matches (server/matchmaking.mjs) -------------------------------------------------------------------
  // The matches being played: { matches: [{ id, mode, map, status, score, round, members, ... }] }.
  async pvpLive(actor) {
    this.need(actor, 1);
    return { matches: this.srv.pvp?.live() || [] };
  }
  // A match ended by staff: as cut short, its finished rounds paid ({ pay: true }), or void (nothing paid).
  async pvpEnd(actor, a) {
    this.need(actor, 2);
    const pay = bool(a.pay ?? false, 'pay');
    const info = await this.srv.pvp.staffEnd(actor, text(a.id, 'Match', 40), pay);
    await this.audit(actor, 'pvp.end', null, { match: info.id, mode: info.mode, map: info.map, score: info.score, rounds: info.rounds, players: info.players, pay });
    return { id: info.id, pay };
  }

  // ---- the Market (server/p2pmarket.mjs) -----------------------------------------------------------------------------
  // A player's open listings and the latest that ended, as seller or buyer.
  async marketPlayer(actor, a) {
    const t = await this.target(a.id);
    return this.srv.p2p.staffView(t.id);
  }
  // One of a player's listings taken down (moderators too: it's what they put up): the item goes back to their inventory.
  async marketCancel(actor, a) {
    const t = await this.target(a.id);
    await this.canTidy(actor, t);
    const lid = text(a.lid, 'Listing', 80);
    const reason = text(a.reason, 'Reason', 300, { min: 0 });
    const out = await this.srv.p2p.staffCancel(t.id, lid);
    await this.audit(actor, 'market.cancel', t, { lid, item: itemName(out.item), price: out.price, ...(reason ? { reason } : {}) });
    return { item: out.item, price: out.price };
  }

  async overview(actor) {
    await this.srv.store.flush().catch(() => {}); // (what's only in memory, so the totals are current)
    const { rows: [u] } = await this.db.query(`SELECT count(*)::int AS accounts, count(discord_id)::int AS linked,
      COALESCE(sum((state->>'money')::float8), 0)::float8 AS money,
      COALESCE(sum(jsonb_array_length(COALESCE(state->'inv', '[]'::jsonb) || COALESCE(state->'stored', '[]'::jsonb) || COALESCE(state->'listed', '[]'::jsonb))), 0)::float8 AS items FROM users`);
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
      (u.state->>'money')::float8 AS money, (u.state->'prof'->>'level')::int AS level, u.state->'inv' AS inv, u.state->'stored' AS stored, u.state->'listed' AS listed
      FROM users u ${W} ORDER BY u.id IN (${online}) DESC, u.last_seen DESC, u.id DESC LIMIT ${PAGE} OFFSET ${page * PAGE}`, params);
    return {
      rows: rows.map((r) => {
        const e = this.srv.store.cache.get(r.id); // (fresher than the saved row)
        const inv = ownedItems(e ? e.st : { inv: parse(r.inv) || [], stored: parse(r.stored) || [], listed: parse(r.listed) || [] });
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
    const { rows: [cfg] } = await this.db.query("SELECT config, config_at, pic, badge, profile->>'avatar' AS avatar FROM users WHERE id = $1", [t.id]);
    const { rows: bans } = await this.db.query('SELECT b.*, u.name FROM bans b LEFT JOIN users u ON u.id = b.user_id WHERE b.user_id = $1 ORDER BY b.created DESC, b.id DESC', [t.id]);
    const { rows: notes } = await this.db.query('SELECT id, by_name, text, created FROM notes WHERE user_id = $1 ORDER BY created DESC, id DESC LIMIT 200', [t.id]);
    const { rows: snaps } = await this.db.query('SELECT id, label, kind, by_name, created, length(state::text) AS size FROM snapshots WHERE user_id = $1 ORDER BY created DESC, id DESC', [t.id]);
    const { rows: audit } = await this.db.query('SELECT * FROM audit WHERE target_id = $1 ORDER BY at DESC, id DESC LIMIT 40', [t.id]);
    const { rows: alts } = await this.db.query(`SELECT DISTINCT u.id, u.name,
      EXISTS (SELECT 1 FROM bans b WHERE b.user_id = u.id AND b.lifted IS NULL AND (b.expires IS NULL OR b.expires > $2)) AS banned
      FROM user_ips a JOIN user_ips o ON o.ip_hash = a.ip_hash AND o.user_id <> a.user_id JOIN users u ON u.id = o.user_id
      WHERE a.user_id = $1 ORDER BY u.id LIMIT 50`, [t.id, now]);
    const ban = await this.activeBan({ userId: t.id });
    // (Online PvP: how many matches in the last day, and the latest with how it went for them.)
    const { rows: [pv] } = await this.db.query(`SELECT count(*) FILTER (WHERE p.at >= $2)::int AS n,
      (SELECT row_to_json(x) FROM (SELECT q.match_id AS id, m.mode, m.map, m.status, q.outcome, q.earned, q.at FROM pvp_players q
        JOIN pvp_matches m ON m.id = q.match_id WHERE q.user_id = $1 ORDER BY q.at DESC LIMIT 1) x) AS last
      FROM pvp_players p WHERE p.user_id = $1`, [t.id, now - 24 * 3600000]);
    const lastPvp = parse(pv?.last) || null;
    return {
      pvp: { last24h: pv?.n || 0, lastMatch: lastPvp && { ...lastPvp, earned: Number(lastPvp.earned) || 0, at: num(lastPvp.at) } },
      user: {
        id: t.id, name: t.name, created: num(t.created), lastSeen: num(t.last_seen), online: this.srv.isOnline(t.id),
        discord: t.discord_id ? { id: t.discord_id, name: t.discord_name || '', linkedAt: num(t.linked_at) } : null,
        staff: await this.levelOf(t.id, { fast: true }), ban: ban && publicBan(ban), cooldown: cooldownLeft(state.mm),
        // (face1: their face, as players see it: their own picture's hash, the agent they picked and the badge they feature)
        ...(actor.faces ? { pic: cfg?.pic || null, avatar: cfg?.avatar || null, badge: featuredBadge(state, cfg?.badge) } : {}),
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
      const medals = grantMedals(st); // (Service Medals staff raised: their badges, as prestiging gives them: engine/badges.js)
      this.srv.store.markDirty(e);
      await this.srv.store.commit([e], this.autoSnap(t, actor, 'edit', snapJson));
      const keys = Object.keys(before);
      this.srv.deltaTo(t.id, { set: pick(st, keys), add: medals, del: [], upd: [] });
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
      const medals = grantMedals(e.st); // (as an edit of the medals gives their badges)
      this.srv.store.markDirty(e);
      await this.srv.store.commit([e], this.autoSnap(t, actor, 'raw edit', snapJson));
      // (a field the new state no longer has goes as null: the game only sets the keys it's sent)
      const set = Object.fromEntries(changed.map((k) => [k, e.st[k] ?? null]));
      if (medals.length) set.prof = e.st.prof;
      this.srv.deltaTo(t.id, { set, add: medals, del: [], upd: [] });
      return { state: rawView(e.st), rev: revOf(e.st), changed, before, after };
    });
    if (out.changed.length) await this.audit(actor, 'edit.raw', t, { changed: out.changed, before: out.before, after: out.after });
    return { state: out.state, rev: out.rev };
  }

  async itemsGive(actor, a) {
    const t = await this.target(a.id);
    await this.canChange(actor, t);
    const { specs, counted } = giveSpecs(a.items);
    const out = await this.srv.store.withUser(t.id, async (e) => {
      const cap = this.srv.INV_CAP;
      // (Bound badges, a Service Medal given back say, don't count: items.capCount.)
      if (capCount(e.st.inv) + counted > cap) fail(`${t.name}'s inventory would be over the limit (${cap} items, not counting badges that can't be traded)`, 'full');
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
      // (Listed ones come off the Market first, back in the inventory: server/p2pmarket.mjs releaseHeld.)
      for (const d of (await this.srv.p2p?.releaseHeld(e, uids))?.ds || []) this.srv.deltaTo(t.id, d);
      const snapJson = JSON.stringify(e.st);
      // Locked items go too, and items in Storage Units; items in an open trade offer don't (take() refuses them before
      // changing anything).
      const ctx = makeCtx(e.st, { online: true, reserved: this.srv.trades.reserved(t.id) });
      const items = takeForStaff(ctx, uids);
      this.srv.store.markDirty(e);
      await this.srv.store.commit([e], this.autoSnap(t, actor, 'item removal', snapJson));
      this.srv.deltaTo(t.id, delta(ctx));
      return items;
    });
    await this.audit(actor, 'items.remove', t, removedDetail(out));
    return { removed: out.length };
  }

  // A bad name comes off an item, wherever the player keeps it: only the name changes.
  async itemsUnname(actor, a) {
    const t = await this.target(a.id);
    await this.canTidy(actor, t);
    const [uid] = removeUids([a.uid]);
    const out = await this.srv.store.withUser(t.id, async (e) => {
      // (A listed item comes off the Market first, its listing showing the name to everyone: server/p2pmarket.mjs releaseHeld.)
      if (customName(listedOf(e.st).find((x) => x.uid === uid) || {})) {
        for (const d of (await this.srv.p2p?.releaseHeld(e, [uid]))?.ds || []) this.srv.deltaTo(t.id, d, 'A moderator took one of your items off the Market because of its name: it\'s back in your inventory');
      }
      const ctx = makeCtx(e.st, { online: true });
      const r = clearNameForStaff(ctx, uid);
      this.srv.store.markDirty(e);
      await this.srv.store.commit([e]);
      this.srv.deltaTo(t.id, delta(ctx));
      return r;
    });
    await this.audit(actor, 'items.unname', t, unnamedDetail(out)); // (first: the name's gone, whatever happens to the copies)
    await this.srv.trades.dropName(uid);
    return { cleared: out.name };
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

  // A name staff cleared stays cleared when a snapshot from before that comes back (the audit log has the item and the name).
  async keepNamesCleared(st) {
    const named = ownedItems(st).filter(customName);
    if (!named.length) return;
    const { rows } = await this.db.query("SELECT detail->>'uid' AS uid, detail->>'name' AS name FROM audit WHERE action = 'items.unname' AND detail->>'uid' = ANY($1::text[])", [named.map((it) => it.uid)]);
    for (const it of named) if (rows.some((r) => r.uid === it.uid && r.name === it.name)) delete it.name;
  }

  async snapRestore(actor, a) {
    const s = await this.snapshot(a.snap);
    const t = await this.target(s.user_id);
    await this.canChange(actor, t);
    const next = upgradeState(parse(s.state));
    await this.keepNamesCleared(next);
    const { dropped, rewards } = await this.replaceWith(actor, t, next, 'restore');
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
    const thrown = []; // (the other accounts on that network it threw off)
    if (ipHash) {
      for (const [id, set] of [...this.srv.sockets]) {
        if (id !== t.id && [...set].some((ws) => ws.ipHash === ipHash) && await this.levelOf(id, { fast: true }) < 1) { this.srv.kick(id, { code: 'banned', error: networkBanText(ban), ban: publicBan(ban) }); thrown.push(id); }
      }
    }
    // The ban is in force: telling them on Discord (and the Discord ban) gets a few seconds before the answer goes.
    const [dm, discord] = await Promise.all([
      t.discord_id ? soon(this.discord.dm(t.discord_id, { content: `You were banned from the game server: ${reason}\n${expires ? `The ban ends <t:${Math.floor(expires / 1000)}:f>.` : 'The ban is permanent.'}` }).then(Boolean, () => false)) : false,
      discordBan ? soon(this.discord.ban(t.discord_id, `${reason} (game ban by ${actor.name})`).catch((e) => ({ ok: false, error: e?.message || 'failed' }))) : null,
    ]);
    // A banned player sells nothing: their Market listings come down, the items back in their inventory.
    const listings = await Promise.resolve(this.srv.p2p?.takeDown(t.id, 'removed') ?? 0).catch((e) => { this.log('[p2p] take down failed', e?.message || e); return 0; });
    // (A network ban: the accounts it blocks sell nothing either, those it threw off and those whose last network it is.)
    const networkListings = ipHash ? await Promise.resolve(this.srv.p2p?.takeDownNetwork(ipHash, { except: t.id, kicked: thrown }) ?? 0).catch((e) => { this.log('[p2p] take down failed', e?.message || e); return 0; }) : 0;
    await this.audit(actor, 'ban', t, { reason, minutes, expires, network: !!ipHash, networkAsked: network, discordBan, discord, dm, ...(listings ? { listings } : {}), ...(networkListings ? { networkListings } : {}) });
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
    if (offers.length) await this.srv.trades.pushChanged(...offers.map((o) => o.id));
    this.srv.notice(t.id, `Your username is now <b>${name}</b>`);
    await this.audit(actor, 'rename', { id: t.id, name }, { before: t.name, after: name });
    // (After the audit: it is done whatever happens to these.)
    if (this.srv.isOnline(t.id)) this.srv.broadcastPlayers(); // (who's online is by name)
    await this.srv.social.renamed(t.id);
    await this.srv.p2p?.renamed(t.id, name); // (their Market listings show it)
    return { name };
  }

  async reset(actor, a) {
    const t = await this.target(a.id);
    await this.canChange(actor, t);
    // (a new account's: passive income counts again from now, on the server's clock)
    await this.replaceWith(actor, t, A.newState(this.srv.now?.() ?? Date.now()), 'reset');
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
        else if (['maintenance', 'registration', 'trading', 'gambling', 'market', 'pvp'].includes(k)) next[k] = bool(v, k);
        else fail(`Unknown setting: ${k}`);
      }
      await this.db.query("INSERT INTO kv (k, v) VALUES ('admin', $1::jsonb) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v", [JSON.stringify(next)]);
      const before = this.settings;
      this.settings = next;
      return { before, next };
    });
    this.settingsQ = run.catch(() => {});
    const { before, next } = await run;
    this.srv.p2p?.openChanged(); // (the games watching the Market are told whether it's open now)
    this.srv.pvp?.settingsChanged(before, next); // (online PvP off: the queue's emptied)
    let kicked = 0;
    if (next.maintenance && !before.maintenance) {
      // (Online PvP matches end first, paid for their finished rounds to whoever's playing them now: then the kicks.)
      await Promise.resolve(this.srv.pvp?.maintenance()).catch((e) => this.log('[pvp] maintenance failed', e?.message || e));
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

  // A player sent a report. Staff hear of it here and read it in `reports`, the one place that says who sent it: the mod log and
  // the audit log are read by a moderator it may be about. (It's no staff action, so it isn't in the audit log at all.)
  reported(t, { report, reason }) {
    if (!this.discord.enabled) return;
    Promise.resolve()
      .then(() => this.discord.modLog({ title: TITLES.report, description: `**${md(t.name)}**`, fields: [{ name: 'Reason', value: md(reason) }, { name: 'Report', value: `#${report}`, inline: true }], color: GOLD }))
      .catch((e) => this.log('[discord] mod log failed', e?.message || e));
  }

  // Players' reports, the newest first: the open ones, or with `closed` the closed ones. The copy of the messages a report
  // saved is the only way staff ever see a conversation: there's no request that reads the messages table, and that stays.
  // Below admin you don't see one about yourself: the player who sent it could be read off the messages even with their name
  // gone, and they're a player you could act on.
  async reports(actor, a) {
    const page = a.page == null ? 0 : int(a.page, 'Page', 0, 1e6), closed = optBool(a.closed, 'closed');
    const [seen, args] = actor.level >= 2 ? ['TRUE', []] : ['NOT COALESCE(t.id = $1::int OR t.discord_id = $2::text, FALSE)', [actor.id ?? null, actor.discordId ?? null]];
    const { rows: [c] } = await this.db.query(`SELECT count(*)::int AS total, count(r.closed_at)::int AS closed FROM reports r JOIN users t ON t.id = r.about_id WHERE ${seen}`, args);
    const { rows } = await this.db.query(`SELECT r.*, f.name AS from_name, t.name AS about_name, t.profile->>'bio' AS about_bio, t.pic AS about_pic,
      (SELECT removed FROM pictures p WHERE p.hash = r.pic) AS pic_removed FROM reports r
      JOIN users f ON f.id = r.from_id JOIN users t ON t.id = r.about_id WHERE ${seen} AND r.closed_at IS ${closed ? 'NOT ' : ''}NULL
      ORDER BY r.at DESC, r.id DESC LIMIT ${PAGE} OFFSET ${page * PAGE}`, args);
    const open = c.total - c.closed;
    return { rows: rows.map((r) => reportRow(r, this.knownLevel({ id: r.about_id, name: r.about_name }), actor.faces)), total: closed ? c.closed : open, open, page };
  }

  // Not a report about yourself, or about staff at or above your level.
  async reportClose(actor, a) {
    const id = int(a.id, 'Report id', 1, 2 ** 31 - 1);
    const { rows: [r] } = await this.db.query('SELECT about_id, reason FROM reports WHERE id = $1', [id]);
    if (!r) fail('That report is gone', 'missing');
    const t = await this.target(r.about_id);
    if (this.isSelf(actor, t)) fail("You can't close a report about yourself", 'perm');
    await this.canTidy(actor, t);
    const { rows } = await this.db.query('UPDATE reports SET closed_at = $1, closed_by = $2 WHERE id = $3 AND closed_at IS NULL RETURNING id', [Date.now(), actor.name, id]);
    if (!rows.length) fail('That report is already closed');
    await this.audit(actor, 'report.close', t, { report: id, reason: r.reason });
    return {};
  }

  // A bad summary comes off a profile (no word list stops them all): only the summary changes, and what it said is on record.
  async bioClear(actor, a) {
    const t = await this.target(a.id);
    await this.canTidy(actor, t);
    const { rows: [r] } = await this.db.query("SELECT profile->>'bio' AS bio FROM users WHERE id = $1", [t.id]);
    if (!r?.bio) fail(`${t.name} has no summary`);
    await this.db.query(`UPDATE users SET profile = profile || '{"bio":""}'::jsonb WHERE id = $1`, [t.id]);
    await this.audit(actor, 'bio.clear', t, { bio: r.bio });
    this.srv.social.changed(t.id);
    return {};
  }

  // The same for a profile picture (face1): it comes off them (they, and everyone, see their agent or the default again), off
  // anyone else who has the very same picture, isn't served any more, and can't go up again for 30 days (server/social.mjs
  // removePicture). Its hash is on record, in the audit log and any report that had it. pic: which picture (its hash): their
  // current one without it, or one a report about them kept (what was reported, though they've changed it since).
  async picClear(actor, a) {
    const t = await this.target(a.id);
    await this.canTidy(actor, t);
    const reason = text(a.reason, 'Reason', 300, { min: 0 });
    const which = a.pic == null ? null : text(a.pic, 'Picture', 64);
    const { rows: [now] } = await this.db.query('SELECT pic FROM users WHERE id = $1', [t.id]);
    const pic = await this.srv.social.removePicture(t.id, actor.name, { hash: which });
    if (!pic) fail(which ? 'That picture is taken down already' : `${t.name} has no profile picture`);
    await this.audit(actor, 'pic.clear', t, { pic, ...(reason ? { reason } : {}) });
    // (Told only when it was the picture they have: one they'd changed already is just gone from everywhere.)
    if (now?.pic === pic) this.srv.notice(t.id, 'Staff removed your profile picture', 'bad');
    return { pic };
  }
  // A picture a report kept or a player has, for staff to look at, taken down or not (face1's panel: the report window).
  // → { type, data (its bytes, base64) }
  async picGet(actor, a) {
    this.need(actor, 1);
    const p = await this.srv.social.staffPicture(text(a.pic, 'Picture', 64));
    if (!p) fail('That picture is gone', 'missing');
    return p;
  }

  // A matchmaking cooldown comes off, as a ban can be lifted, and with it the abandons that would make the next one longer.
  async cooldownClear(actor, a) {
    const t = await this.target(a.id);
    await this.canTidy(actor, t);
    const left = await this.srv.store.withUser(t.id, async (e) => {
      const ms = cooldownLeft(e.st.mm);
      if (!ms) fail(`${t.name} has no matchmaking cooldown`);
      e.st.mm = forgive(e.st.mm);
      this.srv.store.markDirty(e);
      await this.srv.store.commit([e]);
      this.srv.deltaTo(t.id, { set: { mm: e.st.mm }, add: [], del: [], upd: [] }, 'Your matchmaking cooldown was removed');
      return ms;
    });
    await this.audit(actor, 'cooldown.clear', t, { msg: `${formatWait(left)} left` });
    return {};
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
          { name: 'Items', value: String(ownedItems(st).length), inline: true },
          { name: 'Inventory value', value: `$${worthOf(ownedItems(st)).toFixed(2)}`, inline: true },
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
              { name: 'Items', value: `${ownedItems(st).length} ($${worthOf(ownedItems(st)).toFixed(2)})`, inline: true },
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
