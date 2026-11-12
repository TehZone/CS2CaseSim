// Admin panel + Discord linking tests: a real server (embedded Postgres on disk), real WebSocket clients, and the real
// bot (server/discord.mjs) talking to a stand-in Discord (server/discord-mock.mjs). Never the real Discord: the bot's
// options are passed in explicitly, no environment variable is read, and a request to anywhere but this machine fails.
//   node server/test-admin.mjs
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { startDiscordMock } from './discord-mock.mjs';

// Whatever this shell has set, the server never sees a real bot token, admin list or proxy setting here.
for (const k of Object.keys(process.env)) if (/^DISCORD_/.test(k) || k === 'ADMIN_USERS' || k === 'TRUST_PROXY') delete process.env[k];
const localFetch = globalThis.fetch;
const outside = [];
globalThis.fetch = (url, opts) => {
  const u = new URL(String(url?.url || url));
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) { outside.push(u.host); return Promise.reject(new Error('test: local requests only')); }
  return localFetch(url, opts);
};

const { startServer } = await import('./index.mjs');
const { createDiscord, COMMANDS } = await import('./discord.mjs');
const { D, keyFor } = await import('../src/js/engine/data.js');
const { serialKey } = await import('../src/js/engine/items.js');
const { carePackage } = await import('../src/js/engine/levels.js');

const TOKEN = 'test-token';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cs2sim-test-admin-'));
let failed = 0, passed = 0;
const check = (name, ok, info = '') => { ok ? passed++ : failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(25); } return null; };
const refused = async (p) => { try { await p; return null; } catch (e) { return e; } };
const perm = (e) => e?.code === 'perm';

// Every log line of the run, the server's and the bot's: none may hold the token.
const logs = [];
const show = (x) => { if (x instanceof Error) return x.stack || x.message; if (x && typeof x === 'object') { try { return JSON.stringify(x); } catch { return String(x); } } return String(x); };
const serverLog = (...a) => logs.push(a.map(show).join(' '));
const botLog = (...a) => logs.push(a.map(show).join(' '));

// ---- the stand-in Discord: a guild with an owner, a developer, a moderator, an ADMINISTRATOR role and players --------
const mock = await startDiscordMock({ token: TOKEN });
const GID = mock.guildId;
const ID = {
  owner: mock.ownerId, dev: '300000000000000002', mod: '300000000000000003', boss: '300000000000000004', alice: '300000000000000005',
  stranger: '300000000000000006', gone: '300000000000000007', err: '300000000000000008', free: '300000000000000009',
  mod3: '300000000000000010', alt: '300000000000000011', slow: '300000000000000012', mute: '300000000000000013',
};
mock.member(ID.owner, { username: 'owner', globalName: 'Owner O' });
mock.member(ID.dev, { username: 'devin', globalName: 'Devin D', roles: ['dev'] });
mock.member(ID.mod, { username: 'bobd', globalName: 'BobD', roles: ['mod'] });
mock.member(ID.boss, { username: 'rolf', roles: ['boss'] });
mock.member(ID.alice, { username: 'alice_d', globalName: 'Alice D' });
mock.member(ID.stranger, { username: 'stranger' });
mock.member(ID.err, { username: 'errol' });
mock.member(ID.free, { username: 'freddie' });
mock.member(ID.mod3, { username: 'modm_d', globalName: 'ModM', roles: ['mod'] });
mock.member(ID.alt, { username: 'alt_d' });
mock.member(ID.slow, { username: 'slow_d' }); // (later: Discord never answers a lookup of this one)
mock.member(ID.mute, { username: 'mute_d' }); // (later: nor a DM to this one)
mock.failing.add(ID.err); // (Discord answers 403 for this one)

const discordOpts = { token: TOKEN, guildId: GID, api: mock.api, gatewayUrl: mock.gatewayUrl, log: botLog };
// (trustProxy: each client's address is the X-Forwarded-For these requests carry, as behind one reverse proxy)
const server = await startServer({ port: 0, db: { dataDir: DIR }, log: serverLog, priceRefresh: false, admins: ['Boss'], discord: discordOpts, trustProxy: 1 });
const base = () => `http://localhost:${server.port}`;
const IP = { boss: '10.0.0.1', alice: '10.0.0.2', bob: '10.0.0.3', carol: '10.0.0.4', dave: '10.0.0.5', other: '10.0.0.6' };

async function post(p, body, ip) {
  const r = await fetch(base() + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
// A game client from an address (x-forwarded-for): WebSocket + rpc + a mirror of the state from welcome + deltas.
async function client(token, ip, url = base()) {
  const ws = new WebSocket(url.replace('http', 'ws') + '/ws', { headers: { 'x-forwarded-for': ip } });
  const c = { ws, token, st: null, events: [], pending: new Map(), seq: 0 };
  c.closed = new Promise((r) => ws.on('close', r));
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const welcome = new Promise((res, rej) => {
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.t === 'welcome') { c.st = m.state; c.user = m.user; res(m); return; }
      if (m.t === 'fatal' && !c.user) { ws.close(); rej(Object.assign(new Error(m.error), { code: m.code, ban: m.ban })); return; }
      if (m.t === 'res') { const p = c.pending.get(m.id); c.pending.delete(m.id); if (m.d) apply(c, m.d); m.ok ? p.res(m.r) : p.rej(Object.assign(new Error(m.err), { code: m.code })); return; }
      if (m.t === 'delta') apply(c, m.d);
      c.events.push(m);
    });
  });
  ws.send(JSON.stringify({ t: 'hello', token, data: D.lock, v: 1 }));
  c.welcome = await welcome;
  c.rpc = (ns, m, args) => new Promise((res, rej) => { const id = ++c.seq; c.pending.set(id, { res, rej }); ws.send(JSON.stringify({ t: 'rpc', id, ns, m, args })); });
  c.act = (m, a) => c.rpc('act', m, a);
  c.admin = (m, a = {}) => c.rpc('admin', m, a);
  c.waitFor = async (pred, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const e = c.events.find(pred); if (e) return e; await wait(20); } return null; };
  c.close = () => ws.close();
  return c;
}
function apply(c, d) {
  for (const [k, v] of Object.entries(d.set || {})) c.st[k] = v;
  const del = new Set(d.del || []);
  c.st.inv = c.st.inv.filter((i) => !del.has(i.uid));
  for (const u of d.upd || []) { const i = c.st.inv.findIndex((x) => x.uid === u.uid); if (i >= 0) c.st.inv[i] = u; }
  c.st.inv.unshift(...(d.add || []));
  if (d.sto) { const gone = new Set(d.sto.del || []); c.st.stored = [...(d.sto.add || []), ...(c.st.stored || []).filter((i) => !gone.has(i.uid))]; }
}
const json = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const dbState = async (id) => json((await server.db.query('SELECT state FROM users WHERE id = $1', [id])).rows[0].state);
const lastAudit = async (action) => {
  const r = (await server.db.query('SELECT * FROM audit WHERE action = $1 ORDER BY id DESC LIMIT 1', [action])).rows[0];
  return r && { ...r, detail: json(r.detail) };
};
const idOf = async (name) => (await server.db.query('SELECT id FROM users WHERE name_lc = $1', [name])).rows[0].id;
const snapsOf = async (id) => (await server.db.query('SELECT id, label, kind FROM snapshots WHERE user_id = $1 ORDER BY id', [id])).rows;
const linkByDb = (id, did, name) => server.db.query('UPDATE users SET discord_id = $1, discord_name = $2, linked_at = $3 WHERE id = $4', [did, name, Date.now(), id]);

try {
  // ---- the bot comes up against the stand-in ----------------------------------------------------------------------
  const ready = await until(() => server.discord.status().ready && mock.commands);
  const ident = mock.sent(2)[0];
  check('bot: IDENTIFY (token, intents 0) → READY → slash commands registered by a bulk PUT of exactly COMMANDS',
    !!ready && ident?.d.token === TOKEN && ident.d.intents === 0 && ident.d.properties.browser === 'cs2sim' && JSON.stringify(mock.commands) === JSON.stringify(COMMANDS)
    && mock.calls.some((c) => c.method === 'PUT' && c.path === `/applications/${mock.appId}/guilds/${GID}/commands`), JSON.stringify(server.discord.status()));
  const game = COMMANDS.find((c) => c.name === 'game');
  check('slash commands: link, unlink, profile, resetpassword and /game (MODERATE_MEMBERS, guild only) with its six subcommands',
    COMMANDS.map((c) => c.name).join() === 'link,unlink,profile,resetpassword,game' && game.default_member_permissions === String(1n << 40n) && JSON.stringify(game.contexts) === '[0]'
    && game.options.map((o) => o.name).join() === 'lookup,ban,unban,kick,warn,broadcast');
  check('bot: every REST call carries the bot token; the gateway url has v=10 and encoding=json; nothing went past this machine',
    mock.calls.every((c) => c.auth === `Bot ${TOKEN}`) && /v=10/.test(mock.gw.conns[0].url) && /encoding=json/.test(mock.gw.conns[0].url) && !outside.length);
  const health = await (await fetch(base() + '/health')).json();
  check('/health: discord connected', health.discord?.connected === true, JSON.stringify(health.discord));

  // ---- accounts, ADMIN_USERS --------------------------------------------------------------------------------------
  const reg = {};
  for (const [n, pw] of [['boss', 'bosspass1'], ['alice', 'alicepass'], ['bob', 'bobpass1']]) reg[n] = await post('/api/register', { name: n, password: pw }, IP[n]);
  check('register boss, alice and bob', Object.values(reg).every((r) => r.status === 200 && r.body.token));
  const boss = await client(reg.boss.body.token, IP.boss);
  let alice = await client(reg.alice.body.token, IP.alice);
  let bob = await client(reg.bob.body.token, IP.bob);
  const sid = boss.user.id, aid = alice.user.id, bid = bob.user.id;
  check('welcome carries the account (staff level, discordOn, not linked) and the motd',
    boss.welcome.account.staff === 2 && alice.welcome.account.staff === 0 && alice.welcome.account.discordOn === true && alice.welcome.account.discord === null && alice.welcome.motd === '',
    JSON.stringify(alice.welcome.account));
  check('ADMIN_USERS: boss is an admin (names compared case-insensitively), alice a player',
    await server.admin.levelOf(sid, { refresh: true }) === 2 && await server.admin.levelOf(aid, { refresh: true }) === 0);

  // ---- a player is refused on every admin method --------------------------------------------------------------------
  const METHODS = ['overview', 'players', 'player', 'edit', 'edit.raw', 'items.give', 'items.remove', 'snapshot.save', 'snapshot.list', 'snapshot.get', 'snapshot.restore',
    'snapshot.delete', 'config.get', 'ban', 'unban', 'bans', 'kick', 'warn', 'signout', 'note.add', 'rename', 'reset', 'audit', 'settings.get', 'settings.set', 'broadcast', 'cooldown.clear'];
  const notRefused = [];
  for (const m of METHODS) {
    const e = await refused(alice.admin(m, { id: sid, snap: 1, set: { money: 1 }, state: { money: 1 }, items: [{ t: 'crate', id: 'x' }], uids: ['x'], reason: 'x', msg: 'x', text: 'x', name: 'zed', label: 'x', settings: { motd: 'x' } }));
    if (!perm(e)) notRefused.push(m);
  }
  check(`a player is refused on every admin method (${METHODS.length})`, !notRefused.length, notRefused.join(','));
  check('an unknown admin method is refused', !!(await refused(boss.admin('nope'))));

  // ---- linking: link.code → /link → confirm button --------------------------------------------------------------------
  const lc = await alice.rpc('account', 'link.code', {});
  check('link.code: XXX-XXX from the code alphabet, valid 10 minutes', /^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/.test(lc.code) && Math.abs(lc.expires - Date.now() - 600000) < 5000, lc.code);
  const plain = lc.code.replace('-', '');
  const wrongs = [];
  for (let i = 0; i < 5; i++) wrongs.push(await mock.command(ID.stranger, 'link', { options: { code: 'ZZZ-ZZZ' } }).answer());
  const sixth = await mock.command(ID.stranger, 'link', { options: { code: lc.code } }).answer();
  check('/link: a wrong code 5 times (ephemeral answers), then refused even with the right code',
    wrongs.every((a) => a?.type === 4 && a.data.flags === 64 && /wrong or expired/.test(a.data.content)) && /Too many wrong codes/.test(sixth?.data.content || ''), sixth?.data.content);
  const ask = await mock.command(ID.alice, 'link', { options: { code: plain.toLowerCase() } }).answer();
  const buttons = ask?.data.components?.[0]?.components || [];
  check('/link: the right code (any case, no dash) asks first: ephemeral, the account name, Link/Cancel buttons, no staff warning, no pings',
    ask?.type === 4 && ask.data.flags === 64 && /\*\*alice\*\*/.test(ask.data.content) && buttons[0]?.custom_id === `link:yes:${plain}` && buttons[0].label === 'Link to alice'
    && buttons[1]?.custom_id === 'link:no' && !/staff/.test(ask.data.content) && JSON.stringify(ask.data.allowed_mentions) === '{"parse":[]}', ask?.data.content);
  check('/link: nothing is linked before the button', (await alice.rpc('account', 'info', {})).discord === null);
  const cancel = await mock.button(ID.alice, 'link:no').answer();
  check('/link Cancel: the message is updated (type 7), still not linked', cancel?.type === 7 && /Cancelled/.test(cancel.data.content) && (await alice.rpc('account', 'info', {})).discord === null);
  alice.events.length = 0;
  const confirm = await mock.button(ID.alice, `link:yes:${plain}`).answer();
  const push = await alice.waitFor((m) => m.t === 'account' && m.account.discord?.id === ID.alice);
  const rolePut = await mock.waitCall((c) => c.method === 'PUT' && c.path === `/guilds/${GID}/members/${ID.alice}/roles/${mock.roles.linked.id}`);
  const linkAudit = await lastAudit('link');
  const urow = (await server.db.query('SELECT discord_id, discord_name, linked_at FROM users WHERE id = $1', [aid])).rows[0];
  check('/link confirm: linked in the DB, the message updated, the account pushed, the linked role PUT (with an audit reason), an audit row',
    confirm?.type === 7 && /Linked to \*\*alice\*\*/.test(confirm.data.content) && push?.account.discord.name === 'Alice D' && !!rolePut?.reason
    && urow.discord_id === ID.alice && urow.discord_name === 'Alice D' && Number(urow.linked_at) > 0
    && linkAudit?.actor === 'alice' && linkAudit.target_id === aid && linkAudit.actor_discord === ID.alice, confirm?.data.content);
  check('a link code works once', /expired/.test((await mock.button(ID.alice, `link:yes:${plain}`).answer())?.data.content || ''));
  const bc = await bob.rpc('account', 'link.code', {});
  const askB = await mock.command(ID.mod, 'link', { options: { code: bc.code } }).answer();
  check('/link: the staff warning for a staff member', !!askB?.data.content.includes("You're staff: this game account gets your powers in the game's admin panel. Only link your own account."), askB?.data.content);
  bob.events.length = 0;
  await mock.button(ID.mod, askB.data.components[0].components[0].custom_id).answer();
  const bobPush = await bob.waitFor((m) => m.t === 'account' && m.account.discord?.id === ID.mod);
  check('a linked Discord moderator is a moderator in the game (account pushed with staff 1)', bobPush?.account.staff === 1 && bobPush.account.discord.name === 'BobD', JSON.stringify(bobPush?.account));

  // ---- staff levels from Discord roles --------------------------------------------------------------------------------
  const lv = {};
  for (const [n, did, ip] of [['devin', ID.dev, '10.0.1.1'], ['oscar', ID.owner, '10.0.1.2'], ['rolf', ID.boss, '10.0.1.3'], ['nobody', ID.stranger, '10.0.1.4'], ['ghost', ID.gone, '10.0.1.5'], ['errol', ID.err, '10.0.1.6']]) {
    const r = await post('/api/register', { name: n, password: n + 'pass1' }, ip);
    lv[n] = { id: await idOf(n), token: r.body.token };
    await linkByDb(lv[n].id, did, n);
    lv[n].level = await server.admin.levelOf(lv[n].id, { refresh: true });
  }
  check('levels from roles: ★ Developer → 2, guild owner → 3, an ADMINISTRATOR role → 2, no role → 0, not in the guild → 0, a Discord error → 0',
    lv.devin.level === 2 && lv.oscar.level === 3 && lv.rolf.level === 2 && lv.nobody.level === 0 && lv.ghost.level === 0 && lv.errol.level === 0,
    Object.entries(lv).map(([n, x]) => `${n} ${x.level}`).join(', '));
  check('a failed Discord lookup is logged (fail closed), the token in Discord\'s error redacted', logs.some((l) => l.startsWith('[discord]') && l.includes(ID.err) && /counted as a player/.test(l) && l.includes('Bot [token]')));
  const mem = await server.discord.member(ID.dev);
  check('the bot: member() → { id, name, avatar }, null when not in the guild', mem?.id === ID.dev && mem.name === 'Devin D' && mem.avatar === null && await server.discord.member(ID.gone) === null);
  check('the bot: Moderator role → 1, and the same member object rules as /game uses', await server.discord.levelOf(ID.mod) === 1
    && await server.discord.memberLevel({ user: { id: ID.free }, roles: [mock.roles.mod.id] }) === 1 && await server.discord.memberLevel({ user: { id: ID.owner }, roles: [] }) === 3);

  // ---- every §0 rule -----------------------------------------------------------------------------------------------
  const reads = await Promise.all(['overview', 'players', 'audit', 'bans', 'settings.get'].map((m) => bob.admin(m)).concat(
    [bob.admin('player', { id: aid }), bob.admin('snapshot.list', { id: aid }), bob.admin('config.get', { id: aid })])).catch((e) => e);
  check('a moderator can use every read-only view', Array.isArray(reads) && reads[0].me.level === 1 && reads[0].me.name === 'bob', reads.message);
  const modChanges = {
    edit: await refused(bob.admin('edit', { id: aid, set: { money: 1 } })), 'edit.raw': await refused(bob.admin('edit.raw', { id: aid, state: { money: 1 } })),
    'items.give': await refused(bob.admin('items.give', { id: aid, items: [{ t: 'crate', id: 'x' }] })), 'items.remove': await refused(bob.admin('items.remove', { id: aid, uids: ['x'] })),
    reset: await refused(bob.admin('reset', { id: aid })), rename: await refused(bob.admin('rename', { id: aid, name: 'zed' })),
    'settings.set': await refused(bob.admin('settings.set', { settings: { motd: 'x' } })), broadcast: await refused(bob.admin('broadcast', { msg: 'x' })),
  };
  check("a moderator can't edit money (nor change accounts, server settings or broadcast)", Object.values(modChanges).every(perm), Object.entries(modChanges).filter(([, e]) => !perm(e)).map(([m]) => m).join(','));
  check("a moderator can't ban an admin", perm(await refused(bob.admin('ban', { id: sid, reason: 'x' }))));
  check("a moderator can't block a network or ban from the Discord server", perm(await refused(bob.admin('ban', { id: aid, reason: 'x', network: true })))
    && perm(await refused(bob.admin('ban', { id: aid, reason: 'x', discordBan: true }))));
  check('nobody bans themselves (admin or moderator)', perm(await refused(boss.admin('ban', { id: sid, reason: 'x' }))) && perm(await refused(bob.admin('ban', { id: bid, reason: 'x' }))));
  check("an admin can't punish or change another admin (same level)", perm(await refused(boss.admin('ban', { id: lv.devin.id, reason: 'x' })))
    && perm(await refused(boss.admin('kick', { id: lv.rolf.id }))) && perm(await refused(boss.admin('edit', { id: lv.devin.id, set: { money: 1 } }))));
  check('an admin changes their own account', (await boss.admin('edit', { id: sid, set: { stars: 3 } })).state.stars === 3);
  const owner = { id: lv.oscar.id, name: 'oscar', discordId: ID.owner, level: 3 };
  check('the owner outranks an admin', (await server.admin.exec(owner, 'warn', { id: sid, msg: 'from the owner' })).delivered === true && !!(await boss.waitFor((m) => m.t === 'admin.msg' && m.from === 'oscar')));
  check('a moderator punishes a player (a note too)', (await bob.admin('note.add', { id: aid, text: 'keeps spamming' })).id > 0);

  // ---- a matchmaking cooldown taken away ---------------------------------------------------------------------------------
  const giveCooldown = (id) => server.store.withUser(id, async (e) => { e.st.mm = { ...e.st.mm, offenses: 3, lastOffense: Date.now(), until: Date.now() + 3600e3, match: { mode: 'premier', opponent: 1, at: 1 } }; server.store.markDirty(e); });
  check('cooldown.clear: refused when there isn\'t one', /no matchmaking cooldown/.test((await refused(bob.admin('cooldown.clear', { id: aid })))?.message));
  await giveCooldown(aid);
  check('cooldown.clear: the panel shows how long is left', Math.abs((await bob.admin('player', { id: aid })).user.cooldown - 3600e3) < 5000);
  await bob.admin('cooldown.clear', { id: aid });
  const freed = (await server.store.load(aid)).st.mm;
  check('cooldown.clear: a moderator takes it away, and the abandons behind it; the match they\'re in stays', freed.until === 0 && freed.offenses === 0 && freed.lastOffense === 0 && freed.match?.mode === 'premier');
  check('cooldown.clear: their game is told at once', (await alice.waitFor((m) => m.t === 'delta' && m.d?.set?.mm?.until === 0))?.note === 'Your matchmaking cooldown was removed' && (await bob.admin('player', { id: aid })).user.cooldown === 0);
  const clearedRow = (await server.db.query("SELECT * FROM audit WHERE action = 'cooldown.clear' ORDER BY id DESC LIMIT 1")).rows[0];
  check('cooldown.clear: in the audit log, with how long was left', clearedRow?.actor === 'bob' && clearedRow.target_id === aid && /59 minutes|1 hour/.test(JSON.stringify(clearedRow.detail)), JSON.stringify(clearedRow?.detail));
  await giveCooldown(sid);
  check('cooldown.clear: not staff at or above your level, but your own', perm(await refused(bob.admin('cooldown.clear', { id: sid }))) && !(await boss.admin('cooldown.clear', { id: sid })).error);
  for (const id of [aid, sid]) await server.store.withUser(id, async (e) => { e.st.mm = { ...e.st.mm, match: null }; server.store.markDirty(e); });

  // ---- overview / players / player --------------------------------------------------------------------------------
  const ov = await boss.admin('overview');
  check('overview', ov.me.level === 2 && ov.online === 3 && ov.accounts === 9 && ov.linked === 8 && ov.activeBans === 0 && typeof ov.uptime === 'number' && ov.discord.connected === true && ov.discord.guild === 'Test Guild'
    && ov.settings.registration === true && ov.recent.length >= 1, JSON.stringify({ ...ov, recent: ov.recent.length }));
  const pq = await boss.admin('players', { q: 'alice d' }), pl = await boss.admin('players', { filter: 'linked' }), po = await boss.admin('players', { filter: 'online' });
  const ps = await boss.admin('players', { filter: 'staff' });
  check('players: search by the linked Discord name, linked / online / staff filters', pq.total === 1 && pq.rows[0].name === 'alice' && pq.rows[0].discord?.id === ID.alice && pl.total === 8 && po.total === 3
    && ps.rows.map((r) => r.name).sort().join() === 'bob,boss,devin,oscar,rolf', `${pq.total} ${pl.total} ${po.total} ${ps.rows.map((r) => r.name)}`);
  const p1 = await boss.admin('players', { page: 1 });
  check('players: 50 a page, newest seen first', p1.page === 1 && p1.rows.length === 0 && p1.total === 9 && (await boss.admin('players')).rows.length === 9);
  const pv = await boss.admin('player', { id: aid });
  check('player view', pv.user.name === 'alice' && pv.user.online && pv.user.staff === 0 && pv.user.discord?.name === 'Alice D' && pv.state.money === 10 && pv.notes[0]?.text === 'keeps spamming'
    && Array.isArray(pv.bans) && Array.isArray(pv.snapshots) && Array.isArray(pv.trades) && Array.isArray(pv.alts) && pv.audit.some((r) => r.action === 'link'));

  // ---- edit ---------------------------------------------------------------------------------------------------------
  alice.events.length = 0;
  const ed = await boss.admin('edit', { id: aid, set: { money: 5000, prof: { level: 12 }, stats: { opened: 7 }, rank: { wins: 3 } } });
  const inDb = await dbState(aid); // (straight after the answer)
  const dl = await alice.waitFor((m) => m.t === 'delta' && m.d.set?.money === 5000);
  const snaps1 = await snapsOf(aid);
  const au = await lastAudit('edit');
  check('edit: money pushed to the online player as a delta', !!dl && alice.st.money === 5000 && alice.st.prof.level === 12 && alice.st.stats.opened === 7 && alice.st.rank.wins === 3 && !('inv' in dl.d.set));
  check('edit: the DB has it when the answer arrives', ed.state.money === 5000 && inDb.money === 5000 && inDb.prof.level === 12);
  check('edit: an automatic snapshot of before', snaps1.length === 1 && snaps1[0].kind === 'auto' && snaps1[0].label === 'Before edit by boss' && json((await server.db.query('SELECT state FROM snapshots WHERE id = $1', [snaps1[0].id])).rows[0].state).money === 10);
  check('edit: audit with before/after', au.actor === 'boss' && au.target_name === 'alice' && au.detail.before.money === 10 && au.detail.after.money === 5000 && au.detail.before.prof.level === 1 && au.detail.after.rank.wins === 3, JSON.stringify(au.detail));
  const eBad = await Promise.all([{ money: -1 }, { money: '5' }, { money: 2e12 }, { inv: [] }, { stats: { bestName: 3 } }, { stats: { nope: 1 } }, { prof: { level: 41 } }, { rank: { nope: 1 } }, {}].map((set) => refused(boss.admin('edit', { id: aid, set }))));
  check('edit: bad values refused', eBad.every((e) => e && e.code === 'bad'), eBad.map((e) => e?.message).join(' | '));

  // ---- items.give: a case drop's serial, then the same skin from the staff continues the server's counter -----------------
  const box = D.cases.find((c) => c.n === 'Chroma 2 Case');
  await alice.act('case.buy', { id: box.id, n: 1 });
  await alice.act('key.buy', { key: keyFor(box), n: 1 });
  const drop = (await alice.act('case.open', { id: box.id, n: 1 })).items[0];
  await boss.admin('items.give', { id: aid, items: [{ t: 'skin', id: drop.id, stt: !!drop.stt }] });
  await wait(100);
  const sameSkin = alice.st.inv.find((i) => i.t === 'skin' && i.id === drop.id && i.uid !== drop.uid);
  check('items.give: serial numbers continue the server\'s counter (after a case drop of the same item)', drop.sn >= 1 && sameSkin?.sn === drop.sn + 1 && serialKey(sameSkin) === serialKey(drop) && sameSkin.src === 'Admin', `${drop.sn} → ${sameSkin?.sn}`);
  const skin = Object.values(D.skins).find((s) => s.stt && !s.v && s.cat === 'rifle' && s.mn <= 0.01 && s.id !== drop.id);
  const sticker = Object.values(D.stickers)[0];
  const g1 = await boss.admin('items.give', { id: aid, items: [{ t: 'skin', id: skin.id, fl: 0.01, sd: 661, stt: true }, { t: 'sticker', id: sticker.id, n: 2 }, { t: 'crate', id: box.id }] });
  const g2 = await boss.admin('items.give', { id: aid, items: [{ t: 'skin', id: skin.id, stt: true }] });
  await wait(100);
  const given = alice.st.inv.filter((i) => i.t === 'skin' && i.id === skin.id).sort((a, b) => a.sn - b.sn);
  check('items.give: a skin with float, seed and StatTrak™, and the next copy numbered after it', g1.added === 4 && g2.added === 1 && given.length === 2 && Math.abs(given[0].fl - 0.01) < 1e-6 && given[0].sd === 661
    && given[0].stt === true && given[0].kills === 0 && given[1].stt === true && given[1].sn === given[0].sn + 1, given.map((i) => `${i.sn}/${i.fl}/${i.sd}`).join(' '));
  const gAudit = await lastAudit('items.give');
  check('items.give: audited with the items given', gAudit.detail.count === 1 && gAudit.detail.uids.length === 1);
  const gBad = await Promise.all([[{ t: 'skin', id: 'nope' }], [{ t: 'skin', id: skin.id, fl: 2 }], [{ t: 'chicken', id: 'x' }], [{ t: 'sticker', id: sticker.id, n: 101 }], []].map((items) => refused(boss.admin('items.give', { id: aid, items }))));
  check('items.give: bad items refused', gBad.every(Boolean), gBad.map((e) => e?.message).join(' | '));

  // ---- snapshot, then a trade away and an open offer; items.remove ------------------------------------------------------
  const snap = await boss.admin('snapshot.save', { id: aid, label: 'before trade' });
  const atSnap = structuredClone((await server.store.load(aid)).st);
  const off1 = await alice.rpc('trade', 'offer', { to: 'bob', give: { uids: [given[0].uid], money: 0 }, get: { uids: [], money: 0 } });
  await bob.rpc('trade', 'accept', { id: off1.id });
  const stk = alice.st.inv.find((i) => i.t === 'sticker');
  const off2 = await alice.rpc('trade', 'offer', { to: 'bob', give: { uids: [stk.uid], money: 0 }, get: { uids: [], money: 0 } });
  const rr = await refused(boss.admin('items.remove', { id: aid, uids: [stk.uid] }));
  check('items.remove: an item in an open trade offer is refused', rr?.code === 'reserved', rr?.message);
  const crate = alice.st.inv.find((i) => i.t === 'crate');
  await alice.act('item.lock', { uid: crate.uid, lk: true });
  const rem = await boss.admin('items.remove', { id: aid, uids: [crate.uid] });
  await wait(100);
  check('items.remove: a locked item goes, pushed, with an automatic snapshot', rem.removed === 1 && !alice.st.inv.some((i) => i.uid === crate.uid) && (await snapsOf(aid)).some((s) => s.label === 'Before item removal by boss'));
  await boss.admin('edit', { id: aid, set: { money: 1234 } });
  // Refused while alice has a stake in a live coinflip.
  const flip = await alice.rpc('gamble', 'flip.create', { money: 10, side: 'ct', clientSeed: 'a' });
  const busy = await refused(boss.admin('snapshot.restore', { snap: snap.id }));
  const busyReset = await refused(boss.admin('reset', { id: aid }));
  check('snapshot.restore (and reset) refused while the player is in a live coinflip', busy?.code === 'busy' && busyReset?.code === 'busy', busy?.message);
  await alice.rpc('gamble', 'flip.cancel', { id: flip.id });
  check('a moderator can save a snapshot but not restore one', (await bob.admin('snapshot.save', { id: aid, label: 'by the mod' })).id > 0 && perm(await refused(bob.admin('snapshot.restore', { snap: snap.id }))));
  alice.events.length = 0; bob.events.length = 0;
  const rs = await boss.admin('snapshot.restore', { snap: snap.id });
  const full = await alice.waitFor((m) => m.t === 'delta' && Array.isArray(m.d.set?.inv));
  const aNow = (await server.store.load(aid)).st, bNow = (await server.store.load(bid)).st;
  const off2Row = (await server.db.query('SELECT status FROM trades WHERE id = $1', [off2.id])).rows[0];
  check('snapshot.restore: the item traded away since is left out and reported ({ dropped: 1 })', rs.dropped === 1 && !aNow.inv.some((i) => i.uid === given[0].uid) && bNow.inv.some((i) => i.uid === given[0].uid), JSON.stringify(rs));
  check('snapshot.restore: the rest is back (money, the removed crate), pushed as a full state', aNow.money === atSnap.money && aNow.inv.some((i) => i.uid === crate.uid) && aNow.inv.length === atSnap.inv.length - 1
    && !!full && alice.st.money === atSnap.money && alice.st.inv.length === aNow.inv.length);
  check('snapshot.restore: open offers cancelled first (both told)', off2Row.status === 'cancelled' && !server.srv.trades.open.has(off2.id)
    && !!(await alice.waitFor((m) => m.t === 'trades' && m.trades.some((t) => t.id === off2.id && t.status === 'cancelled'))) && !!(await bob.waitFor((m) => m.t === 'trades')));
  const uidsAll = [...aNow.inv, ...bNow.inv].map((i) => i.uid);
  check('no item exists twice after the restore', new Set(uidsAll).size === uidsAll.length);
  const sl = await boss.admin('snapshot.list', { id: aid });
  const sg = await bob.admin('snapshot.get', { snap: snap.id });
  check('snapshot.list / snapshot.get', sl.some((s) => s.id === snap.id && s.kind === 'manual' && s.by === 'boss' && s.size > 0) && sl.some((s) => s.kind === 'auto' && s.label === 'Before restore by boss')
    && sg.state.money === atSnap.money && sg.user.name === 'alice' && sg.label === 'before trade' && sg.kind === 'manual' && 'config' in sg);
  await boss.admin('snapshot.delete', { snap: snap.id });
  check('snapshot.delete', !(await boss.admin('snapshot.list', { id: aid })).some((s) => s.id === snap.id) && (await refused(boss.admin('snapshot.get', { snap: snap.id })))?.code === 'missing');

  // ---- edit.raw -----------------------------------------------------------------------------------------------------
  const pRaw = await boss.admin('player', { id: aid });
  const { inv: _inv, stored: _stored, index: _index, social: _social, ...raw } = pRaw.state;
  alice.events.length = 0;
  // (`base`: the `rev` of the state the edit starts from)
  const er = await boss.admin('edit.raw', { id: aid, state: { ...raw, money: 77, stars: 4 }, base: pRaw.rev });
  await alice.waitFor((m) => m.t === 'delta' && m.d.set?.money === 77);
  check('edit.raw: replaces the fields, keeps the inventory, pushed, audited with an automatic snapshot', er.state.money === 77 && er.state.stars === 4 && !('inv' in er.state) && alice.st.money === 77
    && alice.st.inv.length === aNow.inv.length && (await dbState(aid)).money === 77 && (await lastAudit('edit.raw'))?.detail.after.money === 77 && (await snapsOf(aid)).some((s) => s.label === 'Before raw edit by boss'));
  check('edit.raw: inv, social and wrong types refused', !!(await refused(boss.admin('edit.raw', { id: aid, state: { inv: [] }, base: er.rev }))) && !!(await refused(boss.admin('edit.raw', { id: aid, state: { social: {} }, base: er.rev })))
    && !!(await refused(boss.admin('edit.raw', { id: aid, state: { money: 'lots' }, base: er.rev }))) && !!(await refused(boss.admin('edit.raw', { id: aid, state: { x: 'y'.repeat(49 * 1024) }, base: er.rev }))));

  // ---- reset, rename ------------------------------------------------------------------------------------------------
  alice.events.length = 0;
  await boss.admin('reset', { id: aid });
  await alice.waitFor((m) => m.t === 'delta' && Array.isArray(m.d.set?.inv));
  check('reset: a fresh state as on register, pushed, with an automatic snapshot', alice.st.money === 10 && alice.st.inv.length === 0 && (await dbState(aid)).inv.length === 0
    && (await snapsOf(aid)).some((s) => s.label === 'Before reset by boss') && !!(await lastAudit('reset')));
  const rn = await boss.admin('rename', { id: bid, name: 'robert' });
  const taken = await refused(boss.admin('rename', { id: aid, name: 'Robert' }));
  const invalid = await refused(boss.admin('rename', { id: aid, name: 'a b' }));
  const asRobert = await post('/api/login', { name: 'robert', password: 'bobpass1' }, IP.bob);
  const note = await bob.waitFor((m) => m.t === 'notice' && /robert/.test(m.msg));
  check('rename: renamed (logs in with the new name, told), unique, validated', rn.name === 'robert' && /taken/.test(taken?.message || '') && !!invalid && asRobert.status === 200 && !!note
    && (await lastAudit('rename'))?.detail.before === 'bob');
  await boss.admin('rename', { id: bid, name: 'bob' });

  // ---- configs ------------------------------------------------------------------------------------------------------
  const cs = await alice.rpc('account', 'config.save', { config: { game: { volume: 0.3 }, play: { sens: 2.1, crosshair: { color: '#00ff00' } } } });
  const cg = await alice.rpc('account', 'config.get', {});
  const big = await refused(alice.rpc('account', 'config.save', { config: { x: 'y'.repeat(48 * 1024) } }));
  const notObj = await refused(alice.rpc('account', 'config.save', { config: [1, 2] }));
  const acg = await bob.admin('config.get', { id: aid });
  check('config.save / config.get: stored for yourself, over 48 KB refused, staff read it', cs.at > 0 && cg.config.play.sens === 2.1 && cg.at === cs.at && /48 KB/.test(big?.message || '') && !!notObj
    && acg.config.game.volume === 0.3 && acg.at === cs.at, big?.message);
  check('a snapshot holds the player\'s config', (await boss.admin('snapshot.get', { snap: (await boss.admin('snapshot.save', { id: aid, label: 'with config' })).id })).config?.play.sens === 2.1);

  // ---- ban: kicked, login 403, hello refused, a DM, a Discord ban; unban ----------------------------------------------------
  alice.events.length = 0;
  const bn = await boss.admin('ban', { id: aid, reason: 'cheating', minutes: 60, discordBan: true });
  const fb = await alice.waitFor((m) => m.t === 'fatal' && m.code === 'banned');
  await Promise.race([alice.closed, wait(2000)]);
  const lg = await post('/api/login', { name: 'alice', password: 'alicepass' }, IP.alice);
  const hello = await refused(client(alice.token, IP.alice));
  check('ban: the socket gets fatal banned (reason, until, by) and is closed', fb?.ban?.reason === 'cheating' && fb.ban.by === 'boss' && fb.ban.expires > Date.now() + 59 * 60000 && alice.ws.readyState === 3);
  check('ban: login refused (403, the ban text and the ban), hello refused', lg.status === 403 && /^This account is banned: cheating \(until \d{4}-\d\d-\d\d \d\d:\d\d UTC\)$/.test(lg.body.error) && lg.body.ban?.reason === 'cheating'
    && hello?.code === 'banned' && hello.ban?.by === 'boss', `${lg.status} ${lg.body.error}`);
  const dmOpen = mock.calls.find((c) => c.method === 'POST' && c.path === '/users/@me/channels' && c.body?.recipient_id === ID.alice);
  const dmMsg = mock.messages.find((m) => m.channel === 'dm' + ID.alice && /cheating/.test(m.body.content));
  check('ban: a DM to the linked Discord account with the reason and the end', bn.ban.dm === true && !!dmOpen && !!dmMsg && /<t:\d+:f>/.test(dmMsg.body.content), dmMsg?.body.content);
  const dban = mock.calls.find((c) => c.method === 'PUT' && c.path === `/guilds/${GID}/bans/${ID.alice}`);
  check('ban with discordBan: the Discord ban call, with an audit-log reason', !!dban && decodeURIComponent(dban.reason || '').includes('cheating') && mock.bans.has(ID.alice) && bn.ban.discord?.ok === true);
  const banAudit = await lastAudit('ban');
  check('ban: audited', banAudit.actor === 'boss' && banAudit.target_id === aid && banAudit.detail.reason === 'cheating' && banAudit.detail.minutes === 60 && banAudit.detail.discordBan === true);
  const bl = await bob.admin('bans', { active: true });
  const pb = await bob.admin('players', { filter: 'banned' });
  const ovb = await bob.admin('overview');
  check('bans list, banned filter, overview count', bl.length === 1 && bl[0].user.name === 'alice' && bl[0].network === false && bl[0].reason === 'cheating' && pb.total === 1 && pb.rows[0].banned && ovb.activeBans === 1);
  const ub = await boss.admin('unban', { id: aid, discordUnban: true });
  const lg2 = await post('/api/login', { name: 'alice', password: 'alicepass' }, IP.alice);
  check('unban: lifted (with the Discord unban), login works again', ub.lifted === 1 && !!mock.calls.find((c) => c.method === 'DELETE' && c.path === `/guilds/${GID}/bans/${ID.alice}`)
    && !mock.bans.has(ID.alice) && lg2.status === 200 && (await bob.admin('bans', { active: true })).length === 0 && (await bob.admin('bans', {})).some((b) => b.liftedBy === 'boss'));
  alice = await client(lg2.body.token, IP.alice);
  // A timed ban runs out.
  await boss.admin('ban', { id: aid, reason: 'short', minutes: 1 });
  check('a timed ban refuses the login while it lasts', (await post('/api/login', { name: 'alice', password: 'alicepass' }, IP.alice)).status === 403);
  await server.db.query('UPDATE bans SET expires = $1 WHERE user_id = $2 AND lifted IS NULL', [Date.now() - 1000, aid]);
  const lg3 = await post('/api/login', { name: 'alice', password: 'alicepass' }, IP.alice);
  check('a timed ban expires (login and hello work again)', lg3.status === 200 && !!(alice = await client(lg3.body.token, IP.alice)).welcome);

  // ---- network ban ---------------------------------------------------------------------------------------------------
  const rC = await post('/api/register', { name: 'carol', password: 'carolpass' }, IP.carol);
  const rD = await post('/api/register', { name: 'dave', password: 'davepass' }, IP.dave);
  const carol = await client(rC.body.token, IP.carol);
  const daveThere = await client(rD.body.token, IP.carol); // (dave, from carol's network)
  const nb = await boss.admin('ban', { id: carol.user.id, reason: 'alts', network: true });
  const eve = await post('/api/register', { name: 'eve', password: 'evepass1' }, IP.carol);
  const daveLogin = await post('/api/login', { name: 'dave', password: 'davepass' }, IP.carol);
  const daveHome = await post('/api/login', { name: 'dave', password: 'davepass' }, IP.dave);
  check('network ban: registering from the same network refused (403, the network text, the ban)', nb.ban.network === true && eve.status === 403 && eve.body.error === 'Your network is banned from this server: alts (permanently)' && eve.body.ban?.reason === 'alts', `${eve.status} ${eve.body.error}`);
  check('network ban: another account logging in from that network refused, fine from elsewhere', daveLogin.status === 403 && /banned: alts/.test(daveLogin.body.error) && daveHome.status === 200, `${daveLogin.status} ${daveHome.status}`);
  check('network ban: other accounts online from that network thrown off', !!(await daveThere.waitFor((m) => m.t === 'fatal' && m.code === 'banned')) && !!(await carol.waitFor((m) => m.t === 'fatal' && m.code === 'banned')));
  const pvc = await boss.admin('player', { id: carol.user.id });
  check('player view: alts on the same network', pvc.alts.some((x) => x.name === 'dave') && pvc.user.ban?.reason === 'alts');
  await boss.admin('unban', { id: carol.user.id });
  check('unban lifts the network ban made with the account', (await post('/api/register', { name: 'eve', password: 'evepass1' }, IP.carol)).status === 200);
  // Staff and network bans: you can't block the network you're on, and one made from elsewhere doesn't keep staff out.
  {
    const bossThere = await client(reg.boss.body.token, IP.carol);
    const same = await refused(boss.admin('ban', { id: carol.user.id, reason: 'alts', network: true }));
    bossThere.close();
    await wait(200);
    const nb2 = await boss.admin('ban', { id: carol.user.id, reason: 'alts again', network: true });
    const bossLogin = await post('/api/login', { name: 'boss', password: 'bosspass1' }, IP.carol);
    const bossHello = await client(bossLogin.body.token, IP.carol).catch((e) => e);
    const eve2 = await post('/api/login', { name: 'eve', password: 'evepass1' }, IP.carol);
    check("network ban: refused for the network you're on yourself; one made from elsewhere doesn't keep staff out (players still are)",
      /same network as you/.test(same?.message || '') && nb2.ban.network === true && bossLogin.status === 200 && !!bossHello?.user && eve2.status === 403,
      `${same?.message} | ${bossLogin.status} ${bossHello?.message || ''} ${eve2.status}`);
    bossHello?.close?.();
    await boss.admin('unban', { id: carol.user.id });
  }
  {
    const pa = await boss.admin('players', {});
    const k = pa.rows.findIndex((r) => !r.online);
    check('players: who is online comes first', pa.rows.some((r) => r.online) && pa.rows.slice(k < 0 ? pa.rows.length : k).every((r) => !r.online), pa.rows.map((r) => `${r.name}${r.online ? '*' : ''}`).join(' '));
  }
  for (let i = 1; i <= 22; i++) await boss.admin('edit', { id: carol.user.id, set: { stars: i } });
  const autos = (await snapsOf(carol.user.id)).filter((s) => s.kind === 'auto');
  const firstAuto = json((await server.db.query('SELECT state FROM snapshots WHERE id = $1', [autos[0].id])).rows[0].state);
  check('automatic snapshots: the newest 20 per player are kept', autos.length === 20 && firstAuto.stars === 2, `${autos.length} kept, oldest has ${firstAuto.stars} stars`);
  const aq = await bob.admin('audit', { q: 'BAN' });
  const ap = await bob.admin('audit', { page: 1 });
  check('audit: search (actor, target or action, any case), 50 a page, newest first', aq.total >= 4 && aq.rows.every((r) => /ban/.test(r.action)) && aq.rows[0].at >= aq.rows.at(-1).at
    && ap.page === 1 && ap.rows.length === Math.max(0, Math.min(50, ap.total - 50)), `${aq.total} found, ${ap.total} in all`);

  // ---- kick, warn, signout ----------------------------------------------------------------------------------------------
  const kk = await bob.admin('kick', { id: aid, reason: 'afk' });
  const kf = await alice.waitFor((m) => m.t === 'fatal' && m.code === 'kicked');
  check('kick (by a moderator): fatal kicked with the reason', kk.kicked === true && kf?.error === 'Disconnected by a moderator: afk' && !!(await lastAudit('kick')), kf?.error);
  alice = await client(alice.token, IP.alice);
  const dmsBefore = mock.messages.length;
  const wr = await bob.admin('warn', { id: aid, msg: 'stop spamming' });
  const wm = await alice.waitFor((m) => m.t === 'admin.msg' && m.kind === 'warn');
  const wdm = await until(() => mock.messages.slice(dmsBefore).find((m) => m.channel === 'dm' + ID.alice && /stop spamming/.test(m.body.content)));
  check('warn: admin.msg to the player, DM\'d on Discord too', wr.delivered === true && wm?.msg === 'stop spamming' && wm.from === 'bob' && !!wdm);
  await boss.admin('signout', { id: aid });
  const sf = await alice.waitFor((m) => m.t === 'fatal' && m.code === 'auth');
  const dead = await refused(client(alice.token, IP.alice));
  check('signout: fatal auth, the token no longer works', sf?.error === 'You were signed out. Log in again.' && dead?.code === 'auth');
  const lg4 = await post('/api/login', { name: 'alice', password: 'alicepass' }, IP.alice);
  alice = await client(lg4.body.token, IP.alice);

  // ---- server settings --------------------------------------------------------------------------------------------------
  const fl2 = await alice.rpc('gamble', 'flip.create', { money: 1, side: 't', clientSeed: 'q' });
  const off3 = await alice.rpc('trade', 'offer', { to: 'bob', give: { uids: [], money: 1 }, get: { uids: [], money: 0 } });
  const st1 = await boss.admin('settings.set', { settings: { registration: false, trading: false, gambling: false, motd: 'Welcome!' } });
  const regOff = await post('/api/register', { name: 'frank', password: 'frankpass' }, IP.other);
  const trOff = await refused(alice.rpc('trade', 'offer', { to: 'bob', give: { uids: [], money: 1 }, get: { uids: [], money: 0 } }));
  const trCancel = await alice.rpc('trade', 'cancel', { id: off3.id }).then(() => true, () => false);
  const gaOff = await refused(alice.rpc('gamble', 'flip.create', { money: 1, side: 't' }));
  const botOff = await refused(alice.act('gamble.coinflip', { money: 1, side: 't' }));
  const gaCancel = await alice.rpc('gamble', 'flip.cancel', { id: fl2.id }).then(() => true, () => false);
  check('settings: registration off', st1.registration === false && regOff.status === 403 && regOff.body.error === 'New accounts are closed right now');
  check('settings: trading off (cancelling your own offer still works)', /Trading is turned off/.test(trOff?.message || '') && trCancel);
  check('settings: gambling off (cancelling your own round still works)', /Gambling is turned off/.test(gaOff?.message || '') && /Gambling is turned off/.test(botOff?.message || '') && gaCancel);
  check('settings: bad values refused; saved in kv', !!(await refused(boss.admin('settings.set', { settings: { motd: 'x'.repeat(301) } }))) && !!(await refused(boss.admin('settings.set', { settings: { trading: 'no' } })))
    && !!(await refused(boss.admin('settings.set', { settings: { nope: true } }))) && json((await server.db.query("SELECT v FROM kv WHERE k = 'admin'")).rows[0].v).motd === 'Welcome!');
  await boss.admin('settings.set', { settings: { maintenance: true, maintenanceMsg: 'Back soon' } });
  const mf = await alice.waitFor((m) => m.t === 'fatal' && m.code === 'maintenance');
  const mh = await refused(client(lg4.body.token, IP.alice));
  check('maintenance: kicks non-staff and refuses their hello; staff stay (an admin and a Discord moderator)', mf?.error === 'Back soon' && mh?.code === 'maintenance' && mh.message === 'Back soon'
    && boss.ws.readyState === 1 && bob.ws.readyState === 1 && server.srv.isOnline(sid) && server.srv.isOnline(bid));
  check('maintenance doesn\'t block login', (await post('/api/login', { name: 'alice', password: 'alicepass' }, IP.alice)).status === 200);
  await boss.admin('settings.set', { settings: { maintenance: false, registration: true, trading: true, gambling: true } });
  alice = await client(lg4.body.token, IP.alice);
  check('the motd comes with welcome', alice.welcome.motd === 'Welcome!');

  // ---- broadcast ----------------------------------------------------------------------------------------------------
  const bcast = await boss.admin('broadcast', { msg: 'Restart in 5 minutes' });
  const got = await Promise.all([alice, bob, boss].map((c) => c.waitFor((m) => m.t === 'admin.msg' && m.kind === 'broadcast' && m.msg === 'Restart in 5 minutes')));
  check('broadcast reaches everyone online', bcast.sent === server.srv.sockets.size && bcast.sent === 3 && got.every((m) => m?.from === 'boss'), `sent ${bcast.sent}`);

  // ---- /game from Discord -------------------------------------------------------------------------------------------
  alice.events.length = 0;
  const gb = mock.command(ID.mod, 'game', { sub: 'ban', options: { player: 'ALICE', duration: '1d', reason: 'toxic' } });
  const gbAnswer = await gb.answer();
  const deferred = gb.calls().find((c) => c.method === 'POST' && c.body?.type === 5);
  const gbAudit = await lastAudit('ban');
  const gbKick = await alice.waitFor((m) => m.t === 'fatal' && m.code === 'banned');
  check('/game ban: deferred (ephemeral), then the answer edited in', deferred?.body.data?.flags === 64 && gbAnswer?.type === 'edit' && /^Banned \*\*alice\*\* until <t:\d+:f>\. They were told in a DM\.$/.test(gbAnswer.data.content), gbAnswer?.data.content);
  check('/game ban: bans (the player is thrown off), audit with the @name actor and their Discord id', !!gbKick && gbKick.ban.by === '@BobD' && gbAudit.actor === '@BobD' && gbAudit.actor_discord === ID.mod
    && gbAudit.detail.reason === 'toxic' && gbAudit.detail.minutes === 1440 && !!(await server.admin.activeBan({ userId: aid })));
  const gNoCmd = mock.command(ID.free, 'game', { sub: 'lookup', options: { player: 'alice' } });
  const gNo = await gNoCmd.answer();
  check('/game refused for a member without a staff role (deferred ephemeral first, the refusal edited in)', gNo?.type === 'edit' && /staff/.test(gNo.data.content)
    && gNoCmd.calls().some((c) => c.method === 'POST' && c.body?.type === 5 && c.body?.data?.flags === 64));
  const gUp = await mock.command(ID.mod, 'game', { sub: 'ban', options: { player: 'boss', duration: 'perm', reason: 'x' } }).answer();
  check('/game: the same rules as the panel (a moderator can\'t ban an admin)', gUp?.type === 'edit' && /staff at or above your level/.test(gUp.data.content) && !(await server.admin.activeBan({ userId: sid })), gUp?.data.content);
  const gMissing = await mock.command(ID.mod, 'game', { sub: 'kick', options: { player: 'nobody_here' } }).answer();
  check('/game: an unknown player', /No player called/.test(gMissing?.data.content || ''));
  const gl = await mock.command(ID.mod, 'game', { sub: 'lookup', options: { player: 'alice' } }).answer();
  const banField = gl?.data.embeds?.[0]?.fields?.find((f) => f.name === 'Ban');
  check('/game lookup: an embed with the player, their linked Discord and the ban', gl?.data.embeds?.[0]?.title === 'alice' && /toxic/.test(banField?.value || '') && gl.data.embeds[0].fields.some((f) => f.name === 'Discord' && f.value === `<@${ID.alice}>`));
  const gu = await mock.command(ID.mod, 'game', { sub: 'unban', options: { player: 'alice' } }).answer();
  check('/game unban', /^Unbanned \*\*alice\*\* \(1 ban lifted\)\.$/.test(gu?.data.content || '') && !(await server.admin.activeBan({ userId: aid })), gu?.data.content);
  alice = await client((await post('/api/login', { name: 'alice', password: 'alicepass' }, IP.alice)).body.token, IP.alice);
  const gw1 = await mock.command(ID.mod, 'game', { sub: 'warn', options: { player: 'alice', message: 'be nice' } }).answer();
  const gwMsg = await alice.waitFor((m) => m.t === 'admin.msg' && m.kind === 'warn' && m.msg === 'be nice');
  check('/game warn', /^Warned \*\*alice\*\*\.$/.test(gw1?.data.content || '') && gwMsg?.from === '@BobD');
  const gk = await mock.command(ID.mod, 'game', { sub: 'kick', options: { player: 'alice' } }).answer();
  check('/game kick', /^Kicked \*\*alice\*\*\.$/.test(gk?.data.content || '') && !!(await alice.waitFor((m) => m.t === 'fatal' && m.code === 'kicked')));
  alice = await client(alice.token, IP.alice);
  const gbm = await mock.command(ID.mod, 'game', { sub: 'broadcast', options: { message: 'hi all' } }).answer();
  const gbd = await mock.command(ID.dev, 'game', { sub: 'broadcast', options: { message: 'hi all' } }).answer();
  const gbr = await alice.waitFor((m) => m.t === 'admin.msg' && m.kind === 'broadcast' && m.msg === 'hi all');
  check('/game broadcast: admins only (a ★ Developer sends it)', /Only admins/.test(gbm?.data.content || '') && /^Sent to 3 players online\.$/.test(gbd?.data.content || '') && gbr?.from === '@Devin D', `${gbm?.data.content} / ${gbd?.data.content}`);
  const prof = await mock.command(ID.alice, 'profile').answer();
  const profOther = await mock.command(ID.alice, 'profile', { options: { member: ID.mod }, resolved: { users: { [ID.mod]: mock.members.get(ID.mod).user } } }).answer();
  const profNone = await mock.command(ID.alice, 'profile', { options: { member: ID.free }, resolved: { users: { [ID.free]: mock.members.get(ID.free).user } } }).answer();
  check('/profile: a public reply with the linked game account (yours, or another member\'s), or "not linked"', prof?.type === 4 && !prof.data.flags && prof.data.embeds?.[0]?.title === 'alice'
    && prof.data.embeds[0].fields.some((f) => f.name === 'Cases opened') && profOther?.data.embeds?.[0]?.title === 'bob' && /not linked/.test(profNone?.data.content || ''));
  const other = mock.interact({ from: ID.mod, data: { name: 'profile', type: 1 }, guild: '999999999999999999' });
  const inDm = mock.interact({ from: ID.mod, data: { name: 'profile', type: 1 }, dm: true });
  await wait(500);
  check('interactions from another guild or in DMs are ignored', !other.calls().length && !inDm.calls().length);

  // ---- /resetpassword → /api/reset -----------------------------------------------------------------------------------
  const rpNo = await mock.command(ID.free, 'resetpassword').answer();
  check('/resetpassword: linked members only', rpNo?.data.flags === 64 && /Link your game account first/.test(rpNo.data.content));
  const rp = await mock.command(ID.alice, 'resetpassword').answer();
  const code = /`([A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4})`/.exec(rp?.data.content || '')?.[1];
  check('/resetpassword: an ephemeral one-time code XXXX-XXXX', rp?.data.flags === 64 && !!code, rp?.data.content);
  alice.events.length = 0;
  const wrongCode = await post('/api/reset', { name: 'alice', code: 'AAAA-AAAA', password: 'newpass99' }, IP.alice);
  const wrongName = await post('/api/reset', { name: 'bob', code, password: 'newpass99' }, IP.alice);
  const shortPw = await post('/api/reset', { name: 'alice', code, password: 'x' }, IP.alice);
  const reset = await post('/api/reset', { name: 'ALICE', code: code.toLowerCase(), password: 'newpass99' }, IP.alice);
  const again = await post('/api/reset', { name: 'alice', code, password: 'newpass98' }, IP.alice);
  const rpKick = await alice.waitFor((m) => m.t === 'fatal' && m.code === 'auth');
  const oldDead = await refused(client(alice.token, IP.alice));
  const newPw = await post('/api/login', { name: 'alice', password: 'newpass99' }, IP.alice);
  const oldPw = await post('/api/login', { name: 'alice', password: 'alicepass' }, IP.alice);
  check('/api/reset: a wrong code or another account\'s name → 400 "That reset code is wrong or expired"', wrongCode.status === 400 && wrongCode.body.error === 'That reset code is wrong or expired' && wrongName.status === 400 && shortPw.status === 400);
  check('/api/reset: the code works once; old sessions dead (and thrown off); the new password logs in, the old one doesn\'t', reset.status === 200 && reset.body.ok === true && again.status === 400
    && !!rpKick && oldDead?.code === 'auth' && newPw.status === 200 && oldPw.status === 400 && (await lastAudit('resetpassword'))?.actor_discord === ID.alice, `${reset.status} ${again.status} ${newPw.status} ${oldPw.status}`);
  alice = await client(newPw.body.token, IP.alice);

  // ---- unlinking, and a Discord user moving to another account ------------------------------------------------------------
  alice.events.length = 0;
  const ulCmd = mock.command(ID.alice, 'unlink');
  const ul = await ulCmd.answer();
  const ulPush = await alice.waitFor((m) => m.t === 'account' && m.account.discord === null);
  // (answered "thinking…" first, only to them, since taking the role away on Discord can wait out a rate limit)
  const ulDeferred = ulCmd.calls().some((c) => c.method === 'POST' && c.body?.type === 5 && c.body?.data?.flags === 64);
  check('/unlink: unlinked, the role taken away, the account pushed', ulDeferred && ul?.type === 'edit' && /Unlinked from \*\*alice\*\*/.test(ul.data.content) && !!ulPush
    && !!mock.calls.find((c) => c.method === 'DELETE' && c.path === `/guilds/${GID}/members/${ID.alice}/roles/${mock.roles.linked.id}`)
    && (await server.db.query('SELECT discord_id FROM users WHERE id = $1', [aid])).rows[0].discord_id === null && (await lastAudit('unlink'))?.actor === '@Alice D');
  const ul2 = await mock.command(ID.alice, 'unlink').answer();
  check('/unlink when not linked', /isn't linked/.test(ul2?.data.content || ''));
  const mv = await alice.rpc('account', 'link.code', {});
  const mvAsk = await mock.command(ID.mod, 'link', { options: { code: mv.code } }).answer();
  bob.events.length = 0;
  await mock.button(ID.mod, mvAsk.data.components[0].components[0].custom_id).answer();
  const moved = (await server.db.query('SELECT name FROM users WHERE discord_id = $1', [ID.mod])).rows;
  const bobOff = await bob.waitFor((m) => m.t === 'account' && m.account.discord === null);
  check('linking a Discord user already linked to another account moves it (the old account is told)', moved.length === 1 && moved[0].name === 'alice' && bobOff?.account.staff === 0
    && (await lastAudit('link'))?.detail.movedFrom?.[0] === 'bob');
  alice.events.length = 0;
  const gameUl = await alice.rpc('account', 'unlink', {});
  check('unlink from the game: unlinked, the role taken away', gameUl.discord === null && gameUl.staff === 0 && !!(await mock.waitCall((c) => c.method === 'DELETE' && c.path === `/guilds/${GID}/members/${ID.mod}/roles/${mock.roles.linked.id}`)));
  check('link.code: one per account (a new one replaces the old)', await (async () => {
    const c1 = await alice.rpc('account', 'link.code', {}), c2 = await alice.rpc('account', 'link.code', {});
    const a1 = await mock.command(ID.free, 'link', { options: { code: c1.code } }).answer(), a2 = await mock.command(ID.free, 'link', { options: { code: c2.code } }).answer();
    return /wrong or expired/.test(a1?.data.content || '') && /alice/.test(a2?.data.content || '');
  })());

  // ---- regressions: what the review found (SEC-, INT-, DISCORD- ids) ----------------------------------------------------------
  const acct = async (name, ip) => { const r = await post('/api/register', { name, password: name + 'pass1' }, ip); return { name, ip, token: r.body.token, id: await idOf(name) }; };
  const login = (a, ip = a.ip) => post('/api/login', { name: a.name, password: a.name + 'pass1' }, ip);
  const timed = async (p) => { const t = Date.now(); try { return { v: await p, ms: Date.now() - t }; } catch (e) { return { e, ms: Date.now() - t }; } };
  const resetCode = (a) => /`([A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4})`/.exec(a?.data.content || '')?.[1];
  const giveDrop = (id) => server.store.withUser(id, async (e) => { const d = carePackage({ level: 2 }); e.st.prof = { ...e.st.prof, drops: [d] }; server.store.markDirty(e); return d; });
  const auditFails = () => logs.filter((l) => /audit write failed/.test(l)).length;
  const rawOf = (st) => { const { inv: _inv, stored: _stored, index: _index, social: _social, ...rest } = st; return rest; };
  const modm = await acct('modm', '10.0.5.1'), plainp = await acct('plainp', '10.0.5.2'), modalt = await acct('modalt', '10.0.5.3');
  {
    await linkByDb(modm.id, ID.mod3, 'ModM');
    const bm = await boss.admin('ban', { id: modm.id, reason: 'abusing mod powers' });
    const self = await mock.command(ID.mod3, 'game', { sub: 'unban', options: { player: 'modm' } }).answer();
    // (their Discord link moved to an alt: the banned account isn't "them" any more, but an admin's ban outranks them)
    await server.db.query('UPDATE users SET discord_id = NULL, discord_name = NULL, linked_at = NULL WHERE id = $1', [modm.id]);
    await linkByDb(modalt.id, ID.mod3, 'ModM');
    for (const a of [modm, modalt]) server.admin.levels.delete(a.id);
    const viaAlt = await mock.command(ID.mod3, 'game', { sub: 'unban', options: { player: 'modm' } }).answer();
    const still = await login(modm);
    const row = (await server.db.query('SELECT by_level, lifted FROM bans WHERE id = $1', [bm.ban.id])).rows[0];
    check("SEC-1: a banned moderator can't lift their own ban (/game unban), nor an admin's ban after moving their Discord link to an alt",
      /^You can't lift your own ban/.test(self?.data.content || '') && /^Only an Admin can lift this ban/.test(viaAlt?.data.content || '') && still.status === 403
      && Number(row.by_level) === 2 && row.lifted == null, `${self?.data.content} | ${viaAlt?.data.content} | ${still.status}`);
    const mb = await mock.command(ID.mod, 'game', { sub: 'ban', options: { player: 'plainp', duration: '1h', reason: 'spam' } }).answer();
    const mu = await mock.command(ID.mod3, 'game', { sub: 'unban', options: { player: 'plainp' } }).answer();
    const au = await boss.admin('unban', { id: modm.id });
    check("SEC-1: a moderator lifts another moderator's ban; an admin lifts the admin's", /^Banned \*\*plainp\*\*/.test(mb?.data.content || '')
      && /^Unbanned \*\*plainp\*\* \(1 ban lifted\)/.test(mu?.data.content || '') && au.lifted === 1 && (await login(modm)).status === 200 && (await login(plainp)).status === 200,
    `${mb?.data.content} | ${mu?.data.content}`);
  }
  {
    // (modalt is linked to ID.mod3 now)
    const reset = (code, password) => post('/api/reset', { name: 'modalt', code, password }, modalt.ip);
    const c1 = resetCode(await mock.command(ID.mod3, 'resetpassword').answer());
    await mock.command(ID.mod3, 'unlink').answer();
    const afterUnlink = await reset(c1, 'takeover1');
    await linkByDb(modalt.id, ID.mod3, 'ModM');
    const c2 = resetCode(await mock.command(ID.mod3, 'resetpassword').answer());
    const { finish } = await server.admin.link(modalt.id, { id: ID.alt, name: 'alt_d' }); // (what the /link button runs)
    await finish();
    const afterRelink = await reset(c2, 'takeover2');
    const c3 = resetCode(await mock.command(ID.alt, 'resetpassword').answer());
    // (unlinked behind this server's back, e.g. by another server on the same database: the row decides)
    await server.db.query('UPDATE users SET discord_id = NULL WHERE id = $1', [modalt.id]);
    const afterDb = await reset(c3, 'takeover3');
    await linkByDb(modalt.id, ID.alt, 'alt_d');
    const c4 = resetCode(await mock.command(ID.alt, 'resetpassword').answer());
    const ok = await reset(c4, 'modaltpass2');
    check('SEC-2: a reset code is refused once the account was unlinked, linked to another Discord user, or unlinked in the database; while linked it works',
      !!(c1 && c2 && c3 && c4) && [afterUnlink, afterRelink, afterDb].every((r) => r.status === 400 && r.body.error === 'That reset code is wrong or expired') && ok.status === 200
      && (await post('/api/login', { name: 'modalt', password: 'takeover1' }, modalt.ip)).status === 400 && (await post('/api/login', { name: 'modalt', password: 'modaltpass2' }, modalt.ip)).status === 200,
    [afterUnlink, afterRelink, afterDb, ok].map((r) => r.status).join(' '));
  }
  // (the main server runs with TRUST_PROXY=1; the default, no proxy trusted, is checked on a second server further down)
  const netb = await acct('netb', '10.0.5.8');
  await boss.admin('ban', { id: netb.id, reason: 'alts', network: true });
  {
    const first = await post('/api/register', { name: 'netalt', password: 'netaltpass' }, '203.0.113.7, 10.0.5.8');
    const last = await post('/api/register', { name: 'netalt', password: 'netaltpass' }, '10.0.5.8, 203.0.113.9');
    check('SEC-3: with TRUST_PROXY=1 the address is the last X-Forwarded-For entry (the proxy\'s): a made-up first one neither gets round a network ban nor lands on one',
      first.status === 403 && /network is banned/.test(first.body.error || '') && last.status === 200 && logs.includes('[server] client addresses: X-Forwarded-For, 1 proxy hop (TRUST_PROXY)'),
      `${first.status} ${last.status}`);
  }
  {
    const unknown = await server.admin.lookupLevel(lv.errol.id, { refresh: true });
    const gb = await mock.command(ID.mod, 'game', { sub: 'ban', options: { player: 'errol', duration: '1h', reason: 'x' } }).answer();
    const ed = await refused(boss.admin('edit', { id: lv.errol.id, set: { stars: 1 } }));
    const kk = await refused(boss.admin('kick', { id: lv.errol.id }));
    check("SEC-4: Discord failing on a target's staff level refuses punishing or changing them (code 'discord'); for their own access they count as a player",
      unknown === null && /^Couldn't check errol's staff level with Discord/.test(gb?.data.content || '') && ed?.code === 'discord' && kk?.code === 'discord'
      && !(await server.admin.activeBan({ userId: lv.errol.id })) && await server.admin.levelOf(lv.errol.id) === 0, `${gb?.data.content} | ${ed?.message}`);
    // An unknown level is asked again after 10 s, a known one after a minute.
    const asks = () => mock.calls.filter((c) => c.method === 'GET' && c.path.endsWith('/members/' + ID.err)).length;
    const n0 = asks();
    server.admin.levels.set(lv.errol.id, { level: null, at: Date.now() - 9000 });
    await server.admin.lookupLevel(lv.errol.id);
    const n1 = asks();
    server.admin.levels.set(lv.errol.id, { level: null, at: Date.now() - 11000 });
    await server.admin.lookupLevel(lv.errol.id);
    const n2 = asks();
    server.admin.levels.set(lv.devin.id, { level: 2, at: Date.now() - 30000 });
    const kept = await server.admin.lookupLevel(lv.devin.id);
    check('SEC-4: an unknown staff level is kept 10 s (a known one a minute)', n1 === n0 && n2 === n0 + 1 && kept === 2, `${n0} ${n1} ${n2}`);
  }
  {
    const self = await refused(boss.admin('rename', { id: sid, name: 'Boss2' }));
    const byOwner = await refused(server.admin.exec(owner, 'rename', { id: sid, name: 'Boss2' }));
    const squat = await post('/api/register', { name: 'boss', password: 'squatter1' }, '10.0.5.12');
    check('SEC-6: an ADMIN_USERS account keeps its name (renamed away, anyone could register that admin name)', /ADMIN_USERS/.test(self?.message || '') && /ADMIN_USERS/.test(byOwner?.message || '')
      && (await server.db.query('SELECT name FROM users WHERE id = $1', [sid])).rows[0].name === 'boss' && squat.status === 400, self?.message);
  }
  const surr = await acct('surr', '10.0.5.6');
  {
    const f0 = auditFails();
    const p = await boss.admin('player', { id: surr.id });
    const raw = rawOf(p.state);
    const errs = (await Promise.all([
      boss.admin('warn', { id: surr.id, msg: 'last warning \ud800' }), boss.admin('note.add', { id: surr.id, text: 'a note \udfff' }),
      boss.admin('edit.raw', { id: surr.id, state: { ...raw, stats: { ...raw.stats, bestName: 'x\ud800y' } }, base: p.rev }),
      server.admin.accountRpc({ id: surr.id }, 'config.save', { config: { 'k\ud800': 'v\udfff' } }),
    ].map(refused))).filter(Boolean);
    await refused(boss.admin('ban', { id: surr.id, reason: 'spam \ud800', minutes: 5 }));
    const rows = (await server.db.query('SELECT action, detail FROM audit WHERE target_id = $1', [surr.id])).rows.map((r) => ({ action: r.action, detail: json(r.detail) }));
    const of = (a) => rows.find((r) => r.action === a)?.detail;
    const cfg = json((await server.db.query('SELECT config FROM users WHERE id = $1', [surr.id])).rows[0].config);
    check('SEC-7: lone UTF-16 surrogates in staff text, a raw edit and a config are kept as U+FFFD: every action keeps its audit row',
      of('warn')?.msg === 'last warning �' && of('note.add')?.text === 'a note �' && of('edit.raw')?.after.stats.bestName === 'x�y' && of('ban')?.reason === 'spam �'
      && cfg?.['k�'] === 'v�' && auditFails() === f0 && !errs.length && (await login(surr)).status === 403, `${rows.map((r) => r.action).join(',')} ${errs.map((e) => e.message).join(' | ')}`);
  }
  const xa = await acct('xavi', '10.0.5.4'), xb = await acct('xbob', '10.0.5.5');
  const ca = await client(xa.token, xa.ip), cb = await client(xb.token, xb.ip);
  let xaDrop;
  {
    await boss.admin('edit', { id: xa.id, set: { money: 100 } });
    const p1 = await boss.admin('player', { id: xa.id });
    const again = await boss.admin('player', { id: xa.id });
    await ca.act('case.buy', { id: box.id, n: 1 }); // (the player spends after the admin opened their account)
    const stale = await refused(boss.admin('edit.raw', { id: xa.id, state: { ...rawOf(p1.state), stars: 9 }, base: p1.rev }));
    const noBase = await refused(boss.admin('edit.raw', { id: xa.id, state: { ...rawOf(p1.state), stars: 9 } }));
    const st = (await server.store.load(xa.id)).st;
    // (surr is offline: its state read back from the database has the same rev)
    const r1 = (await boss.admin('player', { id: surr.id })).rev;
    await server.store.flush();
    server.store.cache.delete(surr.id);
    const r2 = (await boss.admin('player', { id: surr.id })).rev;
    check("INT-1: edit.raw from a view loaded before the account changed is refused ('stale'), and one without a base; a rev is the same on every read (from the database too)",
      typeof p1.rev === 'string' && p1.rev === again.rev && stale?.code === 'stale' && noBase?.code === 'stale' && st.stars !== 9 && st.money < 100 && r1 === r2, stale?.message);
    await ca.act('play.start', { mode: 'deathmatch' });
    await ca.act('play.join', { mode: 'competitive', opponent: 1000 });
    xaDrop = await giveDrop(xa.id);
    const p2 = await boss.admin('player', { id: xa.id });
    const raw = rawOf(p2.state);
    const er = await boss.admin('edit.raw', { id: xa.id, state: { ...raw, stars: 7, prof: { ...raw.prof, drops: [] }, play: null, mm: { ...raw.mm, match: null } }, base: p2.rev });
    const st2 = (await server.store.load(xa.id)).st;
    check('INT-1: edit.raw keeps the rewards waiting, the Play match and the ranked match being played, whatever the JSON says (and answers the new rev)',
      st2.stars === 7 && st2.prof.drops.length === 1 && st2.prof.drops[0].id === xaDrop.id && !!p2.state.play && st2.play?.run === p2.state.play.run && st2.mm.match?.mode === 'competitive'
      && er.rev !== p2.rev && er.rev === (await boss.admin('player', { id: xa.id })).rev, JSON.stringify({ drops: st2.prof.drops.length, play: st2.play, match: st2.mm.match }));
  }
  {
    const snap = await boss.admin('snapshot.save', { id: xa.id, label: 'a reward waiting, in a ranked match' });
    const claim = await ca.act('drop.claim', { id: xaDrop.id, picks: [0, 1] });
    const u1 = claim.items[0].uid;
    const off = await ca.rpc('trade', 'offer', { to: 'xbob', give: { uids: [u1], money: 0 }, get: { uids: [], money: 0 } });
    await cb.rpc('trade', 'accept', { id: off.id });
    await ca.act('play.rank', { result: 'win', roundsFor: 13, roundsAgainst: 3, mode: 'competitive' }); // (the match is over)
    const rs = await boss.admin('snapshot.restore', { snap: snap.id });
    const st = (await server.store.load(xa.id)).st, stB = (await server.store.load(xb.id)).st;
    const reclaim = await refused(ca.act('drop.claim', { id: xaDrop.id, picks: [0, 1] }));
    const uids = [...st.inv, ...stB.inv].map((i) => i.uid);
    check('INT-2: restoring a snapshot from before a level-up reward was claimed leaves the reward out (counted in dropped, and as a reward): claiming it again is refused, no item twice',
      rs.dropped === 1 && rs.rewards === 1 && !st.prof.drops.some((d) => d.id === xaDrop.id) && reclaim?.code === 'missing' && new Set(uids).size === uids.length
      && stB.inv.some((i) => i.uid === u1) && !st.inv.some((i) => i.uid === u1), `${JSON.stringify(rs)} ${reclaim?.message}`);
    const q = await ca.act('play.queue', { mode: 'competitive' });
    check('INT-4: a restore keeps the live ranked match (none: it ended since the snapshot), so the next queue settles no abandon',
      st.mm.match === null && !q.settled && q.cooldown === 0 && st.mm.offenses === 0, JSON.stringify({ mm: st.mm, q }));
  }
  {
    await ca.act('play.premier', { result: 'win', roundsFor: 13, roundsAgainst: 5 });
    const had = !!ca.st.premier;
    ca.events.length = 0;
    await boss.admin('reset', { id: xa.id });
    const fd = await ca.waitFor((m) => m.t === 'delta' && Array.isArray(m.d.set?.inv));
    check('INT-6: a reset sends the keys the fresh state no longer has as null (the client drops its premier rating)',
      had && fd?.d.set.premier === null && ca.st.premier === null && !('premier' in (await server.store.load(xa.id)).st), JSON.stringify(fd?.d.set.premier));
  }
  {
    const off = await ca.rpc('trade', 'offer', { to: 'xbob', give: { uids: [], money: 1 }, get: { uids: [], money: 0 } });
    ca.events.length = 0; cb.events.length = 0;
    await boss.admin('rename', { id: xb.id, name: 'xbee' });
    const row = json((await server.db.query('SELECT offer FROM trades WHERE id = $1', [off.id])).rows[0].offer);
    const renamed = (c) => c.waitFor((m) => m.t === 'trades' && m.trades.some((t) => t.id === off.id && t.to.name === 'xbee' && t.from.name === 'xavi'));
    check('INT-5: a rename renames the player in their open offers (in memory and the trades row), and both sides get the new list',
      server.srv.trades.open.get(off.id)?.offer.toName === 'xbee' && row.toName === 'xbee' && row.fromName === 'xavi' && !!(await renamed(cb)) && !!(await renamed(ca)), JSON.stringify(row.toName));
    await ca.rpc('trade', 'cancel', { id: off.id });
  }
  {
    await ca.act('play.premier', { result: 'win', roundsFor: 13, roundsAgainst: 5 });
    const p = await boss.admin('player', { id: xa.id });
    const { premier: _premier, ...raw } = rawOf(p.state);
    ca.events.length = 0;
    await boss.admin('edit.raw', { id: xa.id, state: raw, base: p.rev });
    const d = await ca.waitFor((m) => m.t === 'delta' && m.d.set && 'premier' in m.d.set);
    check('INT-6: a raw edit that leaves a key out sends it as null too', !!p.state.premier && d?.d.set.premier === null && ca.st.premier === null
      && !('premier' in (await server.store.load(xa.id)).st));
  }
  {
    const racer = await acct('racer', '10.0.5.9');
    const tab1 = await client(racer.token, racer.ip);
    const query = server.db.query;
    let reached, release;
    const atCheck = new Promise((r) => (reached = r)), go = new Promise((r) => (release = r));
    // The second tab's hello gets the answer of its ban lookup ("no ban") only once the ban below is made.
    server.db.query = (sql, params) => {
      const p = query(sql, params);
      if (!reached || !/FROM bans/.test(sql) || !/user_id = \$2/.test(sql) || params?.[1] !== racer.id) return p;
      const hit = reached;
      reached = null;
      return p.then(async (r) => { hit(true); await go; return r; });
    };
    let tab2, held;
    try {
      const pending = client(racer.token, racer.ip).catch((e) => e);
      held = await Promise.race([atCheck, wait(5000).then(() => false)]);
      await boss.admin('ban', { id: racer.id, reason: 'racing' });
      release();
      tab2 = await pending;
    } finally {
      server.db.query = query;
      release();
    }
    check('INT-7: a ban made while a hello is between its ban check and joining refuses that hello; the open tab is thrown off',
      held === true && tab2 instanceof Error && tab2.code === 'banned' && !!(await tab1.waitFor((m) => m.t === 'fatal' && m.code === 'banned')) && !server.srv.isOnline(racer.id),
      `${held} ${tab2?.code} ${tab2?.message}`);
  }
  {
    const ix = mock.command(ID.mod, 'game', { sub: 'ban', options: { player: 'plainp', duration: '1h', reason: 'too late' }, failCallback: true });
    const failedLog = await until(() => logs.find((l) => /interaction defer failed/.test(l) && l.includes(`/interactions/${ix.d.id}/`)));
    await wait(300);
    const made = (await server.db.query("SELECT count(*)::int AS n FROM bans WHERE reason = 'too late'")).rows[0].n;
    check('DISCORD-2: /game whose defer Discord refuses (too late, or answered by another server) runs nothing: no ban, no answer edited in',
      !!failedLog && made === 0 && ix.calls().length === 1 && ix.calls()[0].body?.type === 5 && (await login(plainp)).status === 200, `${made} ban(s), ${ix.calls().length} call(s)`);
  }
  check('DISCORD-5: this server runs the gateway, so it takes interactions (the game offers linking)', server.discord.interactions === true && boss.welcome.account.discordOn === true);
  {
    const slowp = await acct('slowp', '10.0.5.10'), mutep = await acct('mutep', '10.0.5.11');
    await linkByDb(slowp.id, ID.slow, 'slow_d');
    await linkByDb(mutep.id, ID.mute, 'mute_d');
    mock.hang.push((c) => c.method === 'GET' && c.path.endsWith('/members/' + ID.slow), (c) => c.method === 'POST' && c.path === '/users/@me/channels' && c.body?.recipient_id === ID.mute);
    const lg = await timed(login(slowp));
    // Side by side: their hello, their login from a banned network (staff would be let in, so Discord is asked), and a
    // warning to another linked player whose DM never goes through.
    const [hello, netLogin, warned] = await Promise.all([timed(client(lg.v?.body.token, slowp.ip)), timed(login(slowp, '10.0.5.8')),
      timed(boss.admin('warn', { id: mutep.id, msg: 'quiet please' }))]);
    mock.hang.length = 0;
    check("DISCORD-1: with Discord never answering a member lookup, a linked player's login answers at once and their hello within a few seconds (as a player)",
      lg.v?.status === 200 && lg.ms < 1500 && !!hello.v?.welcome && hello.ms < 6000 && hello.v.welcome.account.staff === 0, `login ${lg.ms} ms, hello ${hello.ms} ms ${hello.e?.message || ''}`);
    check('DISCORD-1: a login that needs their staff level (a banned network) is answered within a few seconds too', netLogin.v?.status === 403 && netLogin.ms < 6000,
      `${netLogin.v?.status} after ${netLogin.ms} ms`);
    check('DISCORD-4: a warning whose DM Discord never answers is answered within a few seconds (delivered: null, no word from Discord yet)', warned.v?.delivered === null && warned.ms < 6500,
      `${JSON.stringify(warned.v ?? warned.e?.message)} after ${warned.ms} ms`);
    hello.v?.close();
    await boss.admin('unban', { id: netb.id });
  }
  for (const c of [ca, cb]) c.close();

  // ---- admin requests take tokens from the same bucket as the rest --------------------------------------------------------
  const burst = await Promise.all(Array.from({ length: 80 }, () => refused(boss.admin('settings.get'))));
  const slowed = burst.filter((e) => e?.code === 'rate').length;
  check('the token bucket applies to admin requests too', slowed >= 15 && slowed < 80 && burst.filter((e) => e === null).length + slowed === 80, `${slowed} of 80 slowed down; others: ${[...new Set(burst.filter((e) => e && e.code !== 'rate').map((e) => e.code + ' ' + e.message))].join(' | ')}`);

  // ---- an answer Discord refuses is logged without the interaction's token ----------------------------------------------
  const late = mock.command(ID.free, 'unlink', { failCallback: true });
  const lateLog = await until(() => logs.find((l) => /interaction reply failed/.test(l)));
  check('a refused interaction answer is logged with its token hidden', !!(await late.answer()) && !!lateLog && lateLog.includes(`/interactions/${late.d.id}/[token]/callback`) && !lateLog.includes(late.d.token), lateLog);

  // ---- the mod log ------------------------------------------------------------------------------------------------------
  await until(() => mock.messages.some((m) => m.channel === mock.modLogChannel && m.body.embeds?.[0]?.title === 'Discord account unlinked'));
  const logged = mock.messages.filter((m) => m.channel === mock.modLogChannel).map((m) => m.body.embeds?.[0]);
  const titles = new Set(logged.map((e) => e?.title));
  const strayChannels = mock.messages.filter((m) => !m.channel.startsWith('dm') && m.channel !== mock.modLogChannel && m.channel !== mock.rareDropChannel);
  check('mod-log messages posted to the mod-log text channel (embeds with the player, actor and reason)', ['Player banned', 'Player unbanned', 'Account edited', 'Items given', 'Snapshot restored', 'Player kicked', 'Player warned', 'Discord account linked', 'Server settings changed', 'Broadcast sent'].every((t) => titles.has(t))
    && !strayChannels.length && logged.some((e) => e.title === 'Player banned' && e.fields.some((f) => f.name === 'By' && f.value === '@BobD') && e.fields.some((f) => f.name === 'Reason' && f.value === 'toxic'))
    && logged.every((e) => e.timestamp && Number.isInteger(e.color)), [...titles].join(', '));

  // ---- the gateway: heartbeats, op 7 → RESUME, op 9 → IDENTIFY -----------------------------------------------------------
  const beats = await until(() => { const b = mock.sent(1); return b.length >= 2 && b; }, 8000);
  check('gateway: heartbeats sent (with the last sequence number) and acknowledged, no reconnect', !!beats && beats.every((b) => b.d === null || Number.isInteger(b.d)) && mock.gw.conns.length === 1, `${beats?.length} beats, ${mock.gw.conns.length} connection(s)`);
  const nBeats = mock.sent(1).length;
  mock.current().send({ op: 1, d: null });
  check('gateway: op 1 from Discord → a heartbeat at once', !!(await until(() => mock.sent(1).length > nBeats, 1000)));
  const seqAt = mock.gw.seq, sessionAt = mock.gw.session;
  // What the dropped connection missed comes after the RESUME: a /game long past its 3 s (an id from 2020), and a fresh one.
  const oldReplay = mock.command(ID.mod, 'game', { sub: 'warn', options: { player: 'alice', message: 'a replayed warning' }, replay: true });
  const newReplay = mock.command(ID.free, 'unlink', { replay: true, at: Date.now() });
  mock.current().send({ op: 7, d: null });
  const resume = await mock.waitGateway((p) => p.op === 6);
  await until(() => server.discord.status().ready);
  check('gateway: op 7 → a new connection that RESUMEs (token, session, last seq)', !!resume && resume.conn === 1 && resume.d.token === TOKEN && resume.d.session_id === sessionAt && resume.d.seq === seqAt
    && mock.sent(2).length === 1 && server.discord.status().ready, JSON.stringify(resume?.d && { ...resume.d, token: resume.d.token === TOKEN ? '(the token)' : 'other' }));
  const freshAnswer = await newReplay.answer();
  await wait(300);
  check('DISCORD-2: of the interactions replayed after a RESUME, one long past its 3 s is skipped (nothing runs, no answer), a fresh one is answered',
    freshAnswer?.type === 4 && !oldReplay.calls().length && !alice.events.some((m) => m.t === 'admin.msg' && m.msg === 'a replayed warning')
    && logs.some((l) => /skipped \/game replayed after a reconnect/.test(l)), JSON.stringify(freshAnswer?.data));
  check('gateway: interactions arrive on the resumed connection', (await mock.command(ID.free, 'unlink').answer())?.type === 4);
  const t9 = Date.now();
  mock.current().send({ op: 9, d: false });
  const reIdent = await mock.waitGateway((p) => p.op === 2 && p.at > t9, 7000);
  await until(() => server.discord.status().ready && mock.gw.session === 'session-2');
  check('gateway: op 9 → IDENTIFY again after 1-5 s, on the same connection', !!reIdent && reIdent.conn === 1 && reIdent.at - t9 >= 900 && reIdent.at - t9 <= 6000 && server.discord.status().ready, `${reIdent && reIdent.at - t9} ms`);
  check('gateway: interactions arrive after the new session', (await mock.command(ID.free, 'unlink').answer())?.type === 4);

  // ---- other bots, each against its own stand-in, and a second server: side by side -----------------------------------------
  const deadPort = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const side = await Promise.all([
    // A refused token: close 4004 stops the bot for good.
    (async () => {
      const mock2 = await startDiscordMock({ token: TOKEN, closeOnIdentify: 4004 });
      const bot2 = createDiscord({ token: TOKEN, guildId: mock2.guildId, api: mock2.api, gatewayUrl: mock2.gatewayUrl, log: botLog });
      try {
        const st2 = await Promise.race([bot2.start(), wait(5000).then(() => null)]);
        await wait(2500);
        return [
          ['gateway: close 4004 is fatal (start() resolves with the error, no reconnect)', !!st2 && /4004|refused/.test(st2.error || '') && !st2.ready && mock2.gw.conns.length === 1 && !bot2.status().connected, JSON.stringify(st2)],
          ['DISCORD-5: a bot whose gateway stopped for good takes no interactions', bot2.enabled && bot2.interactions === false],
        ];
      } finally {
        bot2.close();
        await mock2.close();
      }
    })(),
    // DISCORD-3: READY names a resume url nobody answers on.
    (async () => {
      const m = await startDiscordMock({ token: TOKEN, resumeUrl: `ws://127.0.0.1:${deadPort}/gateway` });
      const bot = createDiscord({ token: TOKEN, guildId: m.guildId, api: m.api, gatewayUrl: m.gatewayUrl, log: botLog });
      bot.onInteraction(() => {});
      try {
        await bot.start();
        const t = Date.now();
        m.current().send({ op: 7, d: null });
        const res = await m.waitGateway((p) => p.op === 6, 15000);
        await until(() => bot.status().ready, 3000);
        return [['DISCORD-3: when the resume url can\'t be reached, the bot RESUMEs through the main gateway url', !!res && res.conn === 1 && res.d.session_id === 'session-1'
          && m.gw.conns.length === 2 && m.sent(2).length === 1 && bot.status().ready, res ? `after ${res.at - t} ms` : 'no RESUME']];
      } finally {
        bot.close();
        await m.close();
      }
    })(),
    // DISCORD-6: finding the bot's server fails at setup (no DISCORD_GUILD_ID given). One bot after the other: the first
    // has its retry's 30 s made 0.1 s (no other bot may be setting one up meanwhile).
    (async () => {
      const out = [];
      const realTimeout = globalThis.setTimeout;
      {
        const m = await startDiscordMock({ token: TOKEN });
        m.refuse('GET', '/users/@me/guilds');
        const bot = createDiscord({ token: TOKEN, api: m.api, gatewayUrl: m.gatewayUrl, log: botLog });
        bot.onInteraction(() => {});
        let shortened = 0;
        globalThis.setTimeout = (fn, ms, ...a) => realTimeout(fn, fn?.name === 'setup' && ms === 30000 ? (shortened++, 100) : ms, ...a);
        try {
          const st = await bot.start(); // (the failed setup has set its retry by now)
          globalThis.setTimeout = realTimeout;
          // (the stand-in has the commands as the PUT arrives, the bot its answer a moment later; the second server starting up
          // beside this can hold the event loop a while)
          const registered = await until(() => m.commands && !bot.status().error, 8000);
          out.push(['DISCORD-6: a failed setup is retried on a timer (30 s, here 0.1 s): the slash commands get registered with no READY or interaction', !!st.error && shortened === 1
            && !!registered && JSON.stringify(m.commands) === JSON.stringify(COMMANDS) && bot.status().error === null && m.sent(2).length === 1, `${shortened} retry timer(s); ${JSON.stringify({ error: st.error, registered: !!registered, status: bot.status(), identifies: m.sent(2).length })}`]);
        } finally {
          globalThis.setTimeout = realTimeout;
          bot.close();
          await m.close();
        }
      }
      const m = await startDiscordMock({ token: TOKEN });
      m.refuse('GET', '/users/@me/guilds');
      const own = [];
      const bot = createDiscord({ token: TOKEN, api: m.api, gatewayUrl: m.gatewayUrl, log: (...a) => { own.push(a.join(' ')); botLog(...a); } });
      bot.onInteraction((ix) => ix.reply({ content: `pong ${ix.command}`, ephemeral: true }));
      try {
        const st = await bot.start();
        const failed = !m.commands && !!st.error && own.some((l) => /trying again in 30 s/.test(l));
        const pong = await m.command('300000000000000099', 'profile').answer();
        m.current().send({ op: 9, d: false });
        const registered = await until(() => m.commands && !bot.status().error, 8000);
        out.push(['DISCORD-6: while the setup waits for its retry, an interaction finds the server itself and is answered', failed && pong?.data.content === 'pong profile', JSON.stringify(st)],
          ['DISCORD-6: the next READY runs the setup still owed at once (slash commands registered, the error cleared)', !!registered && JSON.stringify(m.commands) === JSON.stringify(COMMANDS)
            && bot.status().error === null && bot.status().guildId === m.guildId, JSON.stringify(bot.status())]);
      } finally {
        bot.close();
        await m.close();
      }
      return out;
    })(),
    // A second server: a REST-only bot (DISCORD_GATEWAY=0: another server runs the gateway) and no TRUST_PROXY.
    (async () => {
      const m = await startDiscordMock({ token: TOKEN });
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs2sim-test-admin-2-'));
      const own = [];
      const s2 = await startServer({ port: 0, db: { dataDir: dir }, log: (...a) => { own.push(a.map(show).join(' ')); serverLog(...a); }, priceRefresh: false, admins: [],
        discord: { token: TOKEN, guildId: m.guildId, api: m.api, gateway: false, log: botLog } });
      try {
        const url = `http://127.0.0.1:${s2.port}`;
        const reg2 = async (name, xff) => (await fetch(url + '/api/register', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': xff }, body: JSON.stringify({ name, password: name + 'pass1' }) })).json();
        const ra = await reg2('xffa', '203.0.113.1');
        await reg2('xffb', '203.0.113.2');
        const nets = (await s2.db.query('SELECT ip_hash FROM user_ips ORDER BY user_id')).rows.map((r) => r.ip_hash);
        await until(() => s2.discord.status().ready);
        const c2 = await client(ra.token, '203.0.113.1', url);
        const lc = await refused(c2.rpc('account', 'link.code', {}));
        c2.close();
        return [
          ["SEC-3: without TRUST_PROXY, X-Forwarded-For is ignored: every address is the connection's own", nets.length === 2 && nets.every((h) => h === s2.admin.ipHash('127.0.0.1'))
            && own.includes("[server] client addresses: the connection's own (no TRUST_PROXY)"), `${nets.length} addresses`],
          ['DISCORD-5: with DISCORD_GATEWAY=0 the bot takes no interactions: the game offers no linking (discordOn false) but still Discord bans (REST), and link.code is refused', s2.discord.enabled
            && s2.discord.interactions === false && c2.welcome.account.discordOn === false && c2.welcome.account.discordBans === true && /runs on another server/.test(lc?.message || ''), lc?.message],
        ];
      } finally {
        await s2.close();
        await m.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    })(),
  ]);
  for (const list of side) for (const [name, ok, info] of list) check(name, ok, info);

  // ---- the Index in the panel: staff can read a player's record, not write it, and a restore can't reopen a claim --------------
  {
    const IX = await import('../src/js/engine/itemindex.js');
    const r = await post('/api/register', { name: 'collector', password: 'collectorpass' }, '10.0.9.1');
    const pid = await idOf('collector'), cc = await client(r.body.token, '10.0.9.1');
    const xray = D.cases.find((c) => c.n === 'X-Ray P250 Package'), goal = IX.setOf(xray.id).goal;
    const snap = await boss.admin('snapshot.save', { id: pid, label: 'before the set' });
    await server.store.withUser(pid, async (e) => { e.st.money = 100; server.store.markDirty(e); });
    await cc.act('case.buy', { id: xray.id });
    await cc.act('case.open', { id: xray.id });
    await cc.act('index.claim', { goal });
    const p = await boss.admin('player', { id: pid });
    check('panel: a player\'s page has their Index: the record and what they\'ve claimed', Object.keys(p.state.index.items).length === 1 && Object.hasOwn(p.state.index.claimed, goal));
    const { inv: _i, stored: _t, index: _x, social: _s, ...rest } = p.state;
    const edit = await refused(boss.admin('edit.raw', { id: pid, state: { ...rest, index: { items: {}, claimed: {}, filled: true, lost: 0 } }, base: p.rev }));
    check('panel: a raw edit can\'t write the Index, for staff either', /can't be edited/.test(edit?.message || ''), edit?.message);
    const ok = await boss.admin('edit.raw', { id: pid, state: { ...rest, stars: 3 }, base: p.rev });
    check('panel: and a raw edit leaves it as it was', ok.state.stars === 3 && !('index' in ok.state) && Object.hasOwn((await dbState(pid)).index.claimed, goal));
    await boss.admin('snapshot.restore', { snap: snap.id });
    const put = await dbState(pid);
    check('panel: a snapshot from before a claim can\'t reopen it, and the record stays', Object.hasOwn(put.index.claimed, goal) && Object.keys(put.index.items).length === 1 && put.money !== 100);
    const again = await refused(cc.act('index.claim', { goal }));
    check('panel: so the reward can\'t be claimed a second time', again?.code === 'claimed', again?.message);
    await wait(40);
    check('panel: the restore reaches the player\'s game whole', Object.hasOwn(cc.st.index?.claimed || {}, goal));
    await boss.admin('reset', { id: pid });
    const wiped = await dbState(pid);
    check('panel: a reset is a new account: the record and its claims start over', !Object.keys(wiped.index.items).length && !Object.keys(wiped.index.claimed).length && wiped.index.filled === true && wiped.index.lost === 0, JSON.stringify(wiped.index));
    await wait(40);
    check('panel: and the player\'s game shows that', !Object.keys(cc.st.index?.items || {}).length && !Object.keys(cc.st.index?.claimed || {}).length);
    cc.close();
  }

  // ---- Storage Units in the panel: what's inside shows, and staff can still give and remove --------------------------------
  {
    const regS = await post('/api/register', { name: 'stasher', password: 'stashpass1' }, IP.other);
    const sc = await client(regS.body.token, IP.other);
    const cid = sc.user.id;
    await boss.admin('edit', { id: cid, set: { money: 100 } });
    const sk = Object.values(D.skins).find((s) => !s.v && !s.star);
    await boss.admin('items.give', { id: cid, items: [{ t: 'skin', id: sk.id, n: 3 }, { t: 'unit', id: 'casket', n: 2 }] });
    await until(() => sc.st.inv.filter((i) => i.t === 'unit').length === 2);
    const [u1, u2] = sc.st.inv.filter((i) => i.t === 'unit');
    const [k1, k2, k3] = sc.st.inv.filter((i) => i.t === 'skin');
    check('panel: staff can give a Storage Unit; it arrives unlabelled, with no serial', !!u1 && !!u2 && !u1.name && u1.sn === undefined && u1.src === 'Admin');
    await sc.act('storage.name', { unit: u1.uid, name: 'vault' });
    await sc.act('storage.deposit', { unit: u1.uid, uids: [k1.uid, k2.uid] });
    const view = await boss.admin('player', { id: cid });
    check('panel: a player\'s page shows what\'s in their units', view.state.stored.length === 2 && view.state.stored.every((i) => i.su === u1.uid) && view.state.inv.find((i) => i.uid === u1.uid)?.name === 'vault');
    const list = await boss.admin('players', { q: 'stasher' });
    const row = (list.rows || list.players || []).find((p) => p.name === 'stasher');
    check('panel: the player list counts stored items', row?.items === 5 && row?.worth > 0, JSON.stringify(row));
    const over = await boss.admin('overview', {});
    check('panel: the overview\'s item total counts stored items', over.items >= 5);
    const stillHolds = await refused(boss.admin('items.remove', { id: cid, uids: [u1.uid] }));
    check('panel: a unit that holds items can\'t be removed on its own', stillHolds?.code === 'unit' && /2 items/.test(stillHolds.message), stillHolds?.message);
    sc.events.length = 0;
    const rm = await boss.admin('items.remove', { id: cid, uids: [k1.uid] });
    await until(() => sc.st.stored.length === 1);
    check('panel: staff can remove an item from inside a unit, and the player sees it go', rm.removed === 1 && sc.st.stored.length === 1 && !(await server.store.load(cid)).st.stored.some((i) => i.uid === k1.uid));
    const rmAudit = await lastAudit('items.remove');
    check('panel: that removal is audited by name', rmAudit.detail.count === 1 && rmAudit.detail.items[0].uid === k1.uid);
    const snapS = await boss.admin('snapshot.save', { id: cid, label: 'with storage' });
    const raw = await boss.admin('player', { id: cid });
    const { inv: _i, stored: _t, index: _x, social: _s, ...rest } = raw.state;
    const rawRefused = await refused(boss.admin('edit.raw', { id: cid, state: { ...rest, stored: [] }, base: raw.rev }));
    check('panel: edit.raw can\'t touch what\'s stored', /stored can't be edited/.test(rawRefused?.message || ''), rawRefused?.message);
    await boss.admin('edit.raw', { id: cid, state: { ...rest, money: 55 }, base: raw.rev });
    check('panel: a raw edit leaves what\'s stored alone', (await server.store.load(cid)).st.stored.length === 1 && (await server.store.load(cid)).st.money === 55);
    await sc.act('storage.retrieve', { unit: u1.uid, uids: [k2.uid] });
    await sc.act('item.sell', { uids: [k2.uid] });
    await boss.admin('snapshot.restore', { snap: snapS.id });
    await until(() => sc.st.stored?.length === 1);
    const back = (await server.store.load(cid)).st;
    check('panel: a restore brings back what was in the units', back.stored.length === 1 && back.stored[0].uid === k2.uid && sc.st.stored[0]?.uid === k2.uid);
    const { rows: [dbRow] } = await server.db.query('SELECT state FROM users WHERE id = $1', [cid]);
    check('panel: and the database has it', json(dbRow.state).stored.length === 1);
    await sc.act('storage.retrieve', { unit: u1.uid, uids: [k2.uid] });
    const rm2 = await boss.admin('items.remove', { id: cid, uids: [u1.uid, u2.uid] });
    check('panel: empty units can be removed', rm2.removed === 2 && !(await server.store.load(cid)).st.inv.some((i) => i.t === 'unit'));
    const keep = k3;
    void keep;
    sc.close();
  }

  // ---- tools in the panel: staff give them, and a bad name can be cleared --------------------------------------------------
  {
    const regT = await post('/api/register', { name: 'namer', password: 'namerpass1' }, IP.other);
    const nc = await client(regT.body.token, IP.other);
    const nid = nc.user.id;
    const tidyId = '300000000000000099';
    mock.member(tidyId, { username: 'tidy_d', roles: ['mod'] });
    const regM = await post('/api/register', { name: 'tidymod', password: 'tidymodpass1' }, '10.0.9.1');
    const tidy = await client(regM.body.token, '10.0.9.1');
    await linkByDb(tidy.user.id, tidyId, 'tidy_d');
    const modLevel = await server.admin.levelOf(tidy.user.id, { refresh: true });
    const regO = await post('/api/register', { name: 'tradepal', password: 'tradepalpass1' }, '10.0.9.2');
    const pal = await client(regO.body.token, '10.0.9.2');
    await boss.admin('edit', { id: nid, set: { money: 100 } });
    const sk = Object.values(D.skins).find((s) => !s.v && !s.star);
    const gave = await boss.admin('items.give', { id: nid, items: [{ t: 'tool', id: 'nametag', n: 9 }, { t: 'tool', id: 'stattrak_swap' }, { t: 'skin', id: sk.id, n: 3 }, { t: 'unit', id: 'casket' }] });
    await until(() => nc.st.inv.filter((i) => i.t === 'tool').length === 10);
    const tools = nc.st.inv.filter((i) => i.t === 'tool');
    check('panel: staff can give tools; they arrive with "Admin" as their source and no serial', gave.added === 14 && tools.every((t) => t.src === 'Admin' && t.sn === undefined), JSON.stringify(tools[0]));
    const badKind = await refused(boss.admin('items.give', { id: nid, items: [{ t: 'tool', id: 'nope' }] }));
    check('panel: an unknown tool is refused', /Unknown tool/.test(badKind?.message || ''), badKind?.message);
    const [s1, s2, s3] = nc.st.inv.filter((i) => i.t === 'skin');
    const unit = nc.st.inv.find((i) => i.t === 'unit');
    const name = '@everyone **hi**';
    await nc.act('tools.name', { uid: s1.uid, name });
    await nc.act('tools.name', { uid: s2.uid, name: 'in a unit' });
    await nc.act('tools.name', { uid: s3.uid, name: 'in an offer' });
    await nc.act('storage.name', { unit: unit.uid, name: 'box' });
    await nc.act('storage.deposit', { unit: unit.uid, uids: [s2.uid] });
    const offer = await nc.rpc('trade', 'offer', { to: 'tradepal', give: { uids: [s3.uid], money: 0 }, get: { uids: [], money: 0 } });

    check('panel: a moderator is one here', modLevel === 1, String(modLevel));
    const notStaff = await refused(pal.admin('items.unname', { id: nid, uid: s1.uid }));
    check('panel: a player can\'t clear a name', perm(notStaff) && (await server.store.load(nid)).st.inv.find((i) => i.uid === s1.uid).name === name, notStaff?.message);
    const up = await refused(tidy.admin('items.unname', { id: (await idOf('boss')), uid: 'x' }));
    check('panel: nor a moderator one of an admin\'s', perm(up), up?.message);
    nc.events.length = 0;
    const cleared = await tidy.admin('items.unname', { id: nid, uid: s1.uid });
    await until(() => !nc.st.inv.find((i) => i.uid === s1.uid)?.name);
    const log = await lastAudit('items.unname');
    check('panel: a moderator clears a bad name: it\'s gone from memory, the database and the player\'s game', cleared.cleared === name && !(await server.store.load(nid)).st.inv.find((i) => i.uid === s1.uid).name
      && !(await dbState(nid)).inv.find((i) => i.uid === s1.uid).name && !('name' in nc.st.inv.find((i) => i.uid === s1.uid)));
    check('panel: and it\'s in the audit log, name and all', log?.actor === 'tidymod' && log.target_name === 'namer' && log.detail.name === name && log.detail.uid === s1.uid && log.detail.item === sk.n, JSON.stringify(log?.detail));
    await until(() => mock.messages.some((m) => m.channel === mock.modLogChannel && m.body.embeds?.[0]?.title === 'Item name cleared'));
    const posted = mock.messages.find((m) => m.channel === mock.modLogChannel && m.body.embeds?.[0]?.title === 'Item name cleared');
    check('panel: the mod log says so, and pings nobody', /@everyone/.test(JSON.stringify(posted?.body.embeds)) && JSON.stringify(posted?.body.allowed_mentions) === '{"parse":[]}' && !/\*\*hi\*\*/.test(posted.body.embeds[0].fields.at(-1).value), JSON.stringify(posted?.body.embeds?.[0]?.fields));
    const again = await refused(tidy.admin('items.unname', { id: nid, uid: s1.uid }));
    check('panel: nothing to clear is refused', /no custom name/.test(again?.message || ''), again?.message);
    const noItem = await refused(tidy.admin('items.unname', { id: nid, uid: 'nope' }));
    check('panel: nor an item they don\'t have', noItem?.code === 'missing');

    await boss.admin('items.unname', { id: nid, uid: s2.uid });
    await until(() => !nc.st.stored.find((i) => i.uid === s2.uid)?.name);
    check('panel: a name is cleared in a Storage Unit too, and the unit keeps the item', !('name' in nc.st.stored.find((i) => i.uid === s2.uid)) && !(await server.store.load(nid)).st.stored.find((i) => i.uid === s2.uid).name && (await server.store.load(nid)).st.stored.find((i) => i.uid === s2.uid).su === unit.uid);

    pal.events.length = 0;
    await boss.admin('items.unname', { id: nid, uid: s3.uid });
    const pushed = await pal.waitFor((m) => m.t === 'trades' && m.trades.some((t) => t.id === offer.id && !t.give.items[0].name));
    const { rows: [tr] } = await server.db.query('SELECT offer FROM trades WHERE id = $1', [offer.id]);
    check('panel: and off an item in an open offer: the other player stops seeing it, and the offer stays open', !!pushed && !json(tr.offer).giveItems[0].name && server.srv.trades.open.has(offer.id));

    // A closed offer keeps a copy of what was in it, shown in Recent trades: that goes too.
    await nc.act('tools.name', { uid: s1.uid, name: 'closed offer' });
    const closed = await nc.rpc('trade', 'offer', { to: 'tradepal', give: { uids: [s1.uid], money: 0 }, get: { uids: [], money: 0 } });
    await pal.rpc('trade', 'decline', { id: closed.id });
    pal.events.length = 0;
    await boss.admin('items.unname', { id: nid, uid: s1.uid });
    const pushedClosed = await pal.waitFor((m) => m.t === 'trades' && m.trades.some((t) => t.id === closed.id && t.status === 'declined' && !t.give.items[0].name));
    const { rows: [trClosed] } = await server.db.query('SELECT status, offer FROM trades WHERE id = $1', [closed.id]);
    check('panel: and off the copy in a closed offer: Recent trades stops showing it, and the offer stays closed', !!pushedClosed && !json(trClosed.offer).giveItems[0].name && trClosed.status === 'declined');
    // The mod log can't be given a masked link.
    const masked = '[x](http://a.co)';
    await nc.act('tools.name', { uid: s1.uid, name: masked });
    await boss.admin('items.unname', { id: nid, uid: s1.uid });
    const maskedPost = await until(() => mock.messages.find((m) => m.channel === mock.modLogChannel && m.body.embeds?.[0]?.title === 'Item name cleared' && /a\.co/.test(m.body.embeds[0].fields.at(-1).value)));
    check('panel: a name is no link in the mod log', !!maskedPost && maskedPost.body.embeds[0].fields.at(-1).value.includes('\\[x\\]\\(http://a.co\\)'), maskedPost?.body.embeds[0].fields.at(-1).value);
    // The clear is on record whatever happens to the copies.
    await nc.act('tools.name', { uid: s1.uid, name: 'copies fail' });
    const dropName = server.srv.trades.dropName;
    server.srv.trades.dropName = async () => { throw new Error('the offers table is gone'); };
    await refused(boss.admin('items.unname', { id: nid, uid: s1.uid }));
    server.srv.trades.dropName = dropName;
    const onRecord = await lastAudit('items.unname');
    check('panel: a clear is audited even if its offers can\'t be reached', onRecord?.detail.name === 'copies fail' && onRecord.detail.uid === s1.uid && !(await server.store.load(nid)).st.inv.find((i) => i.uid === s1.uid).name, JSON.stringify(onRecord?.detail));
    // Going back to before a clear doesn't bring the name back.
    await nc.rpc('trade', 'cancel', { id: offer.id });
    await nc.act('tools.name', { uid: s1.uid, name: 'bad again' });
    await nc.act('tools.name', { uid: s3.uid, name: 'fine name' });
    const before = await boss.admin('snapshot.save', { id: nid, label: 'before the clear' });
    await boss.admin('items.unname', { id: nid, uid: s1.uid });
    await nc.act('tools.name', { uid: s1.uid, name: 'its new name' });
    await boss.admin('snapshot.restore', { snap: before.id });
    const back = (await server.store.load(nid)).st;
    check('panel: restoring a snapshot leaves a cleared name cleared, and every other name as it was', !back.inv.find((i) => i.uid === s1.uid).name && back.inv.find((i) => i.uid === s3.uid).name === 'fine name', JSON.stringify(back.inv.filter((i) => i.t === 'skin').map((i) => i.name)));
    await until(() => !nc.st.inv.find((i) => i.uid === s1.uid)?.name);

    const raw = await refused(boss.admin('edit.raw', { id: nid, base: (await boss.admin('player', { id: nid })).rev, state: { inv: [] } }));
    check('panel: a raw edit still can\'t reach items', /can't be edited here/.test(raw?.message || ''), raw?.message);
    const editName = await refused(boss.admin('edit', { id: nid, set: { name: 'x' } }));
    check('panel: nor an edit', /Unknown field/.test(editName?.message || ''), editName?.message);

    const snap = await boss.admin('snapshot.save', { id: nid, label: 'names' });
    await nc.act('tools.name', { uid: s1.uid, name: 'after' });
    const snapRow = (await boss.admin('snapshot.get', { snap: snap.id }));
    check('panel: a snapshot keeps names as they were', !snapRow.state.inv.find((i) => i.uid === s1.uid).name && snapRow.state.inv.some((i) => i.t === 'tool'));
    for (const c of [nc, tidy, pal]) c.close();
  }

  // ---- rare drops: a Blue Gem or Doppler opened online goes to the read-only channel --------------------------------------
  {
    const { rareDrop, dropEmbed } = await import('./drops.mjs');
    const { analyzePattern } = await import('../src/js/engine/patterns.js');
    const skins = Object.values(D.skins);
    const ak = skins.find((s) => s.wid === 'weapon_ak47' && s.fin === 'Case Hardened');
    const karambit = skins.find((s) => s.wid === 'weapon_knife_karambit' && s.fin === 'Case Hardened');
    const ruby = skins.find((s) => s.fin === 'Doppler' && s.ph === 'Ruby');
    const glock = skins.find((s) => s.fin === 'Gamma Doppler' && s.cat !== 'knife');
    const glove = skins.find((s) => s.cat === 'gloves' && !s.v);
    const plain = skins.find((s) => !s.v && !s.star && !/Doppler|Case Hardened|Heat Treated/.test(s.fin || ''));
    const seeds = Array.from({ length: 1001 }, (_, i) => i);
    const goldSeed = seeds.find((i) => analyzePattern(ak, i).label === 'Gold Gem'), dull = seeds.find((i) => !analyzePattern(ak, i).label);
    const blueSeed = seeds.find((i) => /Blue Gem/.test(analyzePattern(karambit, i).label));
    const it = (skin, sd, more) => ({ t: 'skin', id: skin.id, fl: 0.03, sd, stt: false, stk: [], src: 'Test Case', sn: 7, ...more });
    check('rare drops: the AK-47\'s #1 Blue Gem counts', rareDrop(it(ak, 661))?.title === '💎 #1 Blue Gem', rareDrop(it(ak, 661))?.title);
    check('rare drops: a knife\'s Blue Gem counts', /Blue Gem/.test(rareDrop(it(karambit, blueSeed))?.title));
    const goldKnife = seeds.find((i) => analyzePattern(karambit, i).label === 'Gold Gem');
    check('rare drops: a Gold Gem doesn\'t: a gun with one posts nothing, and a knife with one posts as any knife', goldSeed != null && !rareDrop(it(ak, goldSeed)) && rareDrop(it(karambit, goldKnife))?.title === '🔪 Gold Knife', rareDrop(it(karambit, goldKnife))?.title);
    check('rare drops: every Doppler counts, the Glock-18\'s Gamma Doppler too', rareDrop(it(ruby, 5))?.title === '✨ Doppler · Ruby' && /Gamma Doppler/.test(rareDrop(it(glock, 5))?.title));
    const vanilla = skins.find((s) => s.cat === 'knife' && s.v), plainKnife = skins.find((s) => s.cat === 'knife' && !s.v && !/Doppler|Case Hardened|Heat Treated/.test(s.fin || ''));
    check('rare drops: every knife and pair of gloves is gold, plain ones and vanilla knives too', rareDrop(it(plainKnife, 5))?.title === '🔪 Gold Knife' && rareDrop(it(glove, 5))?.title === '🧤 Gold Gloves'
      && rareDrop({ t: 'skin', id: vanilla.id, fl: null, sd: null, src: 'Test Case' })?.title === '🔪 Gold Knife' && /\$/.test(dropEmbed('someone', { t: 'skin', id: vanilla.id, fl: null, sd: null, src: 'Test Case', stt: false, stk: [] })?.fields[0]?.value));
    check('rare drops: nothing else does', [it(ak, dull), it(plain, 661), { t: 'sticker', id: Object.keys(D.stickers)[0] }, { t: 'crate', id: 'x' }, null].every((x) => !rareDrop(x) && !dropEmbed('someone', x)));
    const shown = dropEmbed('a_b*c', it(ak, 661, { stt: true, kills: 0 }));
    const value = (n) => shown.fields.find((f) => f.name === n)?.value;
    check('rare drops: the post says who, what, where from and the rest, with the name escaped',
      /\*\*a\\_b\\\*c\*\*/.test(shown.description) && /StatTrak™ AK-47/.test(shown.description) && /Test Case/.test(shown.description)
      && value('Pattern') === '#661' && /0\.030000/.test(value('Wear')) && /^\$(?!0\.00)/.test(value('Value')) && value('Serial') === '#7' && /steamstatic/.test(shown.thumbnail?.url), JSON.stringify(shown));
    check('rare drops: the post has the seed\'s real blue and gold', value('Playside blue') === '99.8%' && value('Playside gold') === '0.0%', JSON.stringify(shown.fields));

    const reg = await post('/api/register', { name: 'lucky_opener', password: 'luckypass1' }, '10.0.9.3');
    const op = await client(reg.body.token, '10.0.9.3');
    const box = (id, skin) => { D.caseById[id] = { id, n: 'Lucky Test Case', kind: 'case', key: false, price: 1, rare: [[skin.id]], pools: {} }; };
    let crates = 0;
    const open = async (id, n = 1) => {
      await server.store.withUser(op.user.id, async (e) => { for (let i = 0; i < n; i++) e.st.inv.push({ uid: 'test-crate-' + ++crates, t: 'crate', id, at: Date.now(), src: '' }); server.store.markDirty(e); });
      return op.act('case.open', { id, n });
    };
    box('test-doppler', ruby); box('test-plain', plain);
    const dropsBefore = mock.messages.length; // (a real case opened earlier can be rare too)
    const posts = () => mock.messages.slice(dropsBefore).filter((m) => m.channel === mock.rareDropChannel);
    await until(() => op.st);
    const got = await open('test-doppler');
    const sent = await until(() => posts()[0]);
    const e = sent?.body.embeds?.[0];
    check('rare drops: opening one online posts it, with no ping', got.items[0].id === ruby.id && e?.title === '✨ Doppler · Ruby' && /lucky\\_opener/.test(e.description) && /Lucky Test Case/.test(e.description)
      && sent.body.allowed_mentions?.parse?.length === 0, JSON.stringify(e));
    await open('test-plain');
    const gaveOne = await boss.admin('items.give', { id: op.user.id, items: [{ t: 'skin', id: ruby.id }] });
    await wait(400);
    check('rare drops: a plain item, or one staff gave, posts nothing', gaveOne.added === 1 && posts().length === 1, String(posts().length));
    await open('test-doppler', 2);
    check('rare drops: opening several posts each one', !!(await until(() => posts().length === 3)), String(posts().length));
    const { armoryOffers, armoryWindow } = await import('../src/js/engine/armory.js');
    const offer = armoryOffers(armoryWindow(Date.now()).i).offers.find((o) => o.type === 'drop');
    const col = D.colById[offer.col];
    D.colById[offer.col] = { ...col, tiers: Object.fromEntries(Object.keys(col.tiers).map((k) => [k, [ruby.id]])) };
    await server.store.withUser(op.user.id, async (e) => { e.st.stars = 100; server.store.markDirty(e); });
    const redeemed = await op.act('armory.redeem', { offer: offer.id }).finally(() => { D.colById[offer.col] = col; });
    const armoryPost = await until(() => posts()[3]);
    check('rare drops: an Armory redeem posts too, and says so', redeemed.items[0].id === ruby.id && /Armory · /.test(armoryPost?.body.embeds?.[0]?.description || ''), armoryPost?.body.embeds?.[0]?.description);
    const { discordFromEnv } = await import('./index.mjs');
    check('rare drops: DISCORD_DROPS_CHANNEL picks the channel', discordFromEnv({ env: { DISCORD_BOT_TOKEN: 'x', DISCORD_DROPS_CHANNEL: '123' } }).dropChannel === '123');
    // A trade up counts by the same rule, and it says so: there's no case to name.
    const chroma = D.cases.find((c) => c.n === 'Chroma 2 Case'), goldList = chroma.rare;
    let inputs = 0;
    const tradeUp = async (gold) => {
      const uids = Array.from({ length: 5 }, () => 'test-covert-' + ++inputs);
      await server.store.withUser(op.user.id, async (e) => {
        for (const uid of uids) e.st.inv.push({ uid, t: 'skin', id: chroma.pools[5][0], fl: 0.2, sd: 1, stt: false, stk: [], at: Date.now(), src: '' });
        server.store.markDirty(e);
      });
      chroma.rare = [[gold.id]];
      return op.act('tradeup.sign', { uids }).finally(() => { chroma.rare = goldList; });
    };
    const signed = await tradeUp(ruby);
    const tradePost = await until(() => posts()[4]);
    const tradeText = tradePost?.body.embeds?.[0]?.description || '';
    check('rare drops: a rare trade up posts, and says it was one', signed.item.id === ruby.id && /lucky\\_opener\*\* traded up to \*\*/.test(tradeText) && !/unboxed| from /.test(tradeText), tradeText);
    const goldUp = await tradeUp(plainKnife);
    const goldPost = await until(() => posts()[5]);
    check('rare drops: so does any Covert trade up, as it gives a knife or gloves', goldUp.item.id === plainKnife.id && goldPost?.body.embeds?.[0]?.title === '🔪 Gold Knife', goldPost?.body.embeds?.[0]?.title);
    const low = skins.find((s) => s.r === 2 && !s.star && (D.colById[s.col]?.tiers[3] || []).length && D.colById[s.col].tiers[3].every((id) => !/Doppler|Case Hardened|Heat Treated/.test(D.skins[id].fin || '')));
    const tenUids = Array.from({ length: 10 }, () => 'test-low-' + ++inputs);
    await server.store.withUser(op.user.id, async (e) => {
      for (const uid of tenUids) e.st.inv.push({ uid, t: 'skin', id: low.id, fl: 0.2, sd: 1, stt: false, stk: [], at: Date.now(), src: '' });
      server.store.markDirty(e);
    });
    const classic = await op.act('tradeup.sign', { uids: tenUids });
    await wait(400);
    check('rare drops: an ordinary trade up posts nothing', D.skins[classic.item.id].r === 3 && posts().length === 6, String(posts().length));
    const real = server.discord.rareDrop;
    server.discord.rareDrop = async () => { throw new Error('Discord is down'); };
    const still = await open('test-doppler').catch((err) => err);
    server.discord.rareDrop = () => { throw new Error('Discord is down'); };
    const again = await open('test-doppler').catch((err) => err);
    server.discord.rareDrop = real;
    await wait(100);
    check('rare drops: Discord failing never touches the opening', still.items?.[0]?.id === ruby.id && again.items?.[0]?.id === ruby.id, String(still?.message || again?.message));
    delete D.caseById['test-doppler']; delete D.caseById['test-plain'];
  }

  // ---- staff and the Service Medals: raising them gives their badges, as prestiging does (engine/badges.js grantMedals) ------
  {
    const { medalBadgeIds } = await import('../src/js/engine/badges.js');
    const { capCount } = await import('../src/js/engine/items.js');
    const ids = medalBadgeIds(), medalsOf = (st) => st.inv.filter((x) => x.t === 'badge' && x.src === 'Prestige').map((x) => x.id);
    const md = await acct('medalist', '10.0.9.1');
    const mc = await client(md.token, md.ip);
    await boss.admin('edit', { id: md.id, set: { prof: { medals: 2 } } });
    const pushed = await mc.waitFor((m) => m.t === 'delta' && m.d.add?.length);
    check('medals: staff raising the Service Medals (edit) gives their badges, pushed with the profile in one change', pushed?.d.add.map((x) => x.id).join() === [ids[1], ids[0]].join() && pushed.d.set.prof?.medalBadges?.join() === [ids[0], ids[1]].join()
      && medalsOf(mc.st).join() === [ids[1], ids[0]].join() && medalsOf(await dbState(md.id)).length === 2);
    await boss.admin('edit', { id: md.id, set: { prof: { medals: 0 } } });
    await boss.admin('edit', { id: md.id, set: { prof: { medals: 2 } } });
    check('medals: lowering them takes none away, and raising them again gives none twice', medalsOf(await dbState(md.id)).length === 2 && (await dbState(md.id)).prof.medalBadges.length === 2 && medalsOf(mc.st).length === 2);
    const p = await boss.admin('player', { id: md.id }), raw = rawOf(p.state);
    await boss.admin('edit.raw', { id: md.id, state: { ...raw, prof: { ...raw.prof, medals: 3 } }, base: p.rev });
    const third = await mc.waitFor((m) => m.t === 'delta' && m.d.add?.some((x) => x.id === ids[2]));
    check('medals: and a raw edit of them too', !!third && medalsOf(await dbState(md.id)).join() === [ids[2], ids[1], ids[0]].join() && mc.st.prof.medalBadges.length === 3 && medalsOf(mc.st).length === 3);
    const one = mc.st.inv.find((x) => x.id === ids[1]);
    await boss.admin('items.remove', { id: md.id, uids: [one.uid] });
    await boss.admin('edit', { id: md.id, set: { prof: { medals: 3, level: 5 } } });
    check('medals: one staff took away isn\'t given back', medalsOf(await dbState(md.id)).join() === [ids[2], ids[0]].join() && (await dbState(md.id)).prof.medalBadges.length === 3);
    // A raw edit's prof without the record of the badges given (copied from an older snapshot, or by hand), or with it
    // emptied, gives none again: the record goes with the inventory, which a raw edit doesn't change (engine/admin.js rawEdit).
    for (const medalBadges of [undefined, []]) {
      const p2 = await boss.admin('player', { id: md.id }), raw2 = rawOf(p2.state);
      const { medalBadges: _given, ...bare } = raw2.prof;
      await boss.admin('edit.raw', { id: md.id, state: { ...raw2, prof: { ...bare, ...(medalBadges ? { medalBadges } : {}), level: 6 + !!medalBadges } }, base: p2.rev });
    }
    const afterRaw = await dbState(md.id);
    check('medals: a raw edit with the record of badges given left out, or emptied, gives none again (no second copies)', afterRaw.prof.level === 7
      && medalsOf(afterRaw).join() === [ids[2], ids[0]].join() && afterRaw.prof.medalBadges.join() === [ids[0], ids[1], ids[2]].join() && medalsOf(mc.st).join() === [ids[2], ids[0]].join(), JSON.stringify(medalsOf(afterRaw)));
    // Staff giving one back into a full inventory (3,000 other items): a bound badge doesn't count toward the limit, as
    // everywhere else (items.capCount); anything else is still refused.
    await server.store.withUser(md.id, async (e) => {
      for (let i = 0, n = server.srv.INV_CAP - capCount(e.st.inv); i < n; i++) e.st.inv.push({ uid: 'test-medal-full-' + i, t: 'crate', id: D.cases[0].id, at: Date.now(), src: '' });
      server.store.markDirty(e);
    });
    const back = await refused(boss.admin('items.give', { id: md.id, items: [{ t: 'badge', id: ids[1] }] }));
    const more = await refused(boss.admin('items.give', { id: md.id, items: [{ t: 'crate', id: D.cases[0].id }] }));
    const fullNow = await dbState(md.id);
    check('medals: staff can give a Service Medal back into a full inventory; anything that counts is still refused as full', back === null && more?.code === 'full'
      && fullNow.inv.filter((x) => x.t === 'badge' && x.id === ids[1]).length === 1 && capCount(fullNow.inv) === server.srv.INV_CAP, `${back?.message} / ${more?.code}`);
    await server.store.withUser(md.id, async (e) => { e.st.inv = e.st.inv.filter((x) => !String(x.uid).startsWith('test-medal-full-')); server.store.markDirty(e); });
    mc.close();
  }

  for (const c of [boss, alice, bob]) c.close();
} catch (e) {
  failed++;
  console.error('FAIL  test crashed:', e);
}
await server.close().catch((e) => console.error('close failed', e));
const connsAtClose = mock.gw.conns.length;
await wait(1500);
check('closing the server closes the bot for good (its gateway connection closed, no reconnect, no interactions taken)', mock.gw.conns.length === connsAtClose && mock.gw.conns.every((c) => c.sock.readyState === 3)
  && !server.discord.status().connected && server.discord.interactions === false, `${connsAtClose} → ${mock.gw.conns.length}`);
await mock.close().catch(() => {});

check('the token never appears in a log line captured during the run', logs.length > 0 && logs.some((l) => l.startsWith('[discord]')) && !logs.some((l) => l.includes(TOKEN)), `${logs.length} lines`);
check('interaction tokens never appear in a log line either', !logs.some((l) => /ixtoken-/.test(l)));
check('nothing contacted anything but this machine', !outside.length, outside.join(', '));
if (failed || process.argv.includes('--log')) console.log('\n--- log ---\n' + logs.join('\n'));
fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
