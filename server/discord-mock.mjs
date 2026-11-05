// A stand-in Discord for the admin tests (server/test-admin.mjs): the REST API under /api/v10 and a gateway WebSocket
// on one local port. It records every call, holds one guild (roles, members, an owner and a mod-log channel), and can
// send the bot an INTERACTION_CREATE and wait for its answer. Nothing here ever talks to the real Discord.
import http from 'node:http';
import { WebSocketServer } from 'ws';

const ADMINISTRATOR = String(1n << 3n);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// `closeOnIdentify`: a gateway close code sent instead of READY (e.g. 4004, a refused token). `resumeUrl`: the
// resume_gateway_url READY names (by default this gateway).
export async function startDiscordMock({ token = 'test-token', guildId = '100000000000000001', appId = '200000000000000002',
  ownerId = '300000000000000001', heartbeatInterval = 3000, closeOnIdentify = null, resumeUrl = null } = {}) {
  const roles = {
    everyone: { id: guildId, name: '@everyone', permissions: '0', position: 0 },
    dev: { id: '400000000000000001', name: '★ Developer', permissions: '0', position: 4 },
    mod: { id: '400000000000000002', name: 'Moderator', permissions: '0', position: 3 },
    linked: { id: '400000000000000003', name: '🔗 Linked', permissions: '0', position: 1 },
    boss: { id: '400000000000000004', name: 'Server Boss', permissions: ADMINISTRATOR, position: 5 }, // (ADMINISTRATOR, any name)
  };
  const channels = [
    { id: '500000000000000001', type: 0, name: 'general' },
    { id: '500000000000000002', type: 4, name: 'mod-log' }, // (a category: not where messages go)
    { id: '500000000000000003', type: 0, name: '📋・mod-log' },
    { id: '500000000000000004', type: 0, name: '💎・rare-drops' },
  ];
  const guild = { id: guildId, name: 'Test Guild', owner_id: ownerId };
  const members = new Map(); // discord id -> { user, roles }
  const failing = new Set(); // ids whose member lookup fails (403, quoting the request's Authorization header back)
  const failCallbacks = new Set(); // interaction ids whose callback fails (404 Unknown interaction)
  const hang = []; // (call) => true: that request is never answered (a hung network path)
  const refusals = []; // { method, path, n }: the next n such requests get 403 Missing Access
  const bans = new Set();
  const calls = []; // every REST call: { method, path, body, auth, reason, at }
  const messages = []; // { channel, body } (channel and DM messages)
  let commands = null, port = 0;

  const json = (res, code, body, headers = {}) => {
    res.writeHead(code, { 'content-type': 'application/json', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const memberView = (m) => ({ user: { ...m.user }, roles: [...m.roles], joined_at: '2026-01-01T00:00:00.000Z' });

  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/api/v10/')) return json(res, 404, { message: '404: Not Found', code: 0 });
    const p = url.pathname.slice('/api/v10'.length);
    let body;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
    const call = { method: req.method, path: p, body, auth: req.headers.authorization, reason: req.headers['x-audit-log-reason'], at: Date.now() };
    calls.push(call);
    if (hang.some((fn) => fn(call))) return; // (closed when the bot gives up, or by close())
    const no = refusals.find((r) => r.n > 0 && r.method === req.method && r.path === p);
    if (no) { no.n--; return json(res, 403, { message: 'Missing Access', code: 50001 }); }
    if (req.headers.authorization !== `Bot ${token}`) return json(res, 401, { message: '401: Unauthorized', code: 0 });
    const G = `/guilds/${guildId}`;
    const M = req.method;
    let m;
    if (M === 'GET' && p === '/gateway/bot') return json(res, 200, { url: `ws://127.0.0.1:${port}/gateway`, shards: 1 });
    if (M === 'GET' && p === '/users/@me') return json(res, 200, { id: appId, username: 'Test Bot', bot: true });
    if (M === 'GET' && p === '/users/@me/guilds') return json(res, 200, [{ id: guildId, name: guild.name }]);
    if (M === 'GET' && p === G) return json(res, 200, guild);
    if (M === 'GET' && p === G + '/roles') return json(res, 200, Object.values(roles));
    if (M === 'GET' && p === G + '/channels') return json(res, 200, channels);
    if (M === 'GET' && (m = p.match(/^\/guilds\/\w+\/members\/(\w+)$/))) {
      // (an error that quotes the token: the bot must redact it before it reaches a log line)
      if (failing.has(m[1])) return json(res, 403, { message: `Missing Access for ${req.headers.authorization}`, code: 50001 });
      const mem = members.get(m[1]);
      return mem ? json(res, 200, memberView(mem)) : json(res, 404, { message: 'Unknown Member', code: 10007 });
    }
    if ((M === 'PUT' || M === 'DELETE') && (m = p.match(/^\/guilds\/\w+\/members\/(\w+)\/roles\/(\w+)$/))) {
      const mem = members.get(m[1]);
      if (!mem) return json(res, 404, { message: 'Unknown Member', code: 10007 });
      mem.roles = mem.roles.filter((r) => r !== m[2]);
      if (M === 'PUT') mem.roles.push(m[2]);
      return json(res, 204);
    }
    if ((m = p.match(/^\/guilds\/\w+\/bans\/(\w+)$/))) {
      if (M === 'PUT') { bans.add(m[1]); return json(res, 204); }
      if (M === 'DELETE') return bans.delete(m[1]) ? json(res, 204) : json(res, 404, { message: 'Unknown Ban', code: 10026 });
    }
    if (M === 'PUT' && p === `/applications/${appId}/guilds/${guildId}/commands`) { commands = body; return json(res, 200, body); }
    if (M === 'POST' && (m = p.match(/^\/interactions\/([\w-]+)\/[\w.-]+\/callback$/))) {
      return failCallbacks.has(m[1]) ? json(res, 404, { message: 'Unknown interaction', code: 10062 }) : json(res, 204);
    }
    if (M === 'PATCH' && p.startsWith(`/webhooks/${appId}/`) && p.endsWith('/messages/@original')) return json(res, 200, { id: 'msg-' + calls.length });
    if (M === 'POST' && p === '/users/@me/channels') return json(res, 200, { id: 'dm' + String(body?.recipient_id || ''), type: 1 });
    if (M === 'POST' && (m = p.match(/^\/channels\/(\w+)\/messages$/))) {
      messages.push({ channel: m[1], body });
      return json(res, 200, { id: 'msg-' + calls.length, channel_id: m[1] });
    }
    json(res, 404, { message: `404: no route for ${M} ${p}`, code: 0 });
  });

  // ---- gateway ----
  const wss = new WebSocketServer({ server, path: '/gateway' });
  // `replay`: INTERACTION_CREATEs the bot missed, sent after its next RESUME and before RESUMED (as Discord replays them).
  const gw = { conns: [], seq: 0, sessions: 0, session: null, ackBeats: true, heartbeatInterval, closeOnIdentify, replay: [] };
  wss.on('connection', (sock, req) => {
    const conn = { sock, url: req.url, got: [], n: gw.conns.length };
    gw.conns.push(conn);
    conn.send = (p) => { if (sock.readyState === 1) sock.send(JSON.stringify(p)); };
    conn.dispatch = (t, d) => conn.send({ op: 0, t, s: ++gw.seq, d });
    conn.send({ op: 10, d: { heartbeat_interval: gw.heartbeatInterval } });
    sock.on('message', (data) => {
      let p;
      try { p = JSON.parse(String(data)); } catch { return; }
      p.at = Date.now();
      conn.got.push(p);
      if (p.op === 1 && gw.ackBeats) conn.send({ op: 11 });
      if (p.op === 2) {
        if (gw.closeOnIdentify) return sock.close(gw.closeOnIdentify, 'Authentication failed.');
        if (p.d?.token !== token) return sock.close(4004, 'Authentication failed.');
        gw.session = 'session-' + ++gw.sessions;
        gw.seq = 0;
        conn.dispatch('READY', {
          v: 10, session_id: gw.session, resume_gateway_url: resumeUrl || `ws://127.0.0.1:${port}/gateway`,
          user: { id: appId, username: 'Test Bot', bot: true }, application: { id: appId, flags: 0 }, guilds: [{ id: guildId, unavailable: true }],
        });
      }
      if (p.op === 6) {
        if (p.d?.token === token && p.d?.session_id === gw.session) {
          for (const d of gw.replay.splice(0)) conn.dispatch('INTERACTION_CREATE', d);
          conn.dispatch('RESUMED', {});
        } else conn.send({ op: 9, d: false });
      }
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;

  let ixSeq = 0;
  const mock = {
    token, guildId, appId, ownerId, roles, channels, guild, members, failing, failCallbacks, hang, bans, calls, messages, gw,
    api: `http://127.0.0.1:${port}/api/v10`,
    gatewayUrl: `ws://127.0.0.1:${port}/gateway`,
    modLogChannel: channels[2].id,
    rareDropChannel: channels[3].id,
    get commands() { return commands; },

    // A member of the guild (roles: keys of `roles`).
    member(id, { username, globalName = null, roles: rs = [] } = {}) {
      const m = { user: { id, username: username || 'user' + id.slice(-3), global_name: globalName, avatar: null }, roles: rs.map((k) => roles[k].id) };
      members.set(id, m);
      return m;
    },

    // The latest gateway connection that is still open.
    current() { return [...gw.conns].reverse().find((c) => c.sock.readyState === 1) || null; },
    // Payloads the bot sent on the gateway (op: 1 heartbeat, 2 identify, 6 resume), on every connection.
    sent(op) { return gw.conns.flatMap((c) => c.got.filter((p) => op == null || p.op === op).map((p) => ({ ...p, conn: c.n }))); },

    // The next n requests of `method path` (the path after /api/v10) are refused with 403 Missing Access.
    refuse(method, path, n = 1) { refusals.push({ method, path, n }); },

    // Sends the bot an INTERACTION_CREATE. `from`: a member id (or a { user, roles } object); `dm`: as a DM (no guild);
    // `failCallback`: Discord refuses the answer (as when it comes too late); `at`: when Discord made it (its id is a
    // snowflake of that time; by default an id from 2020); `replay`: held back until the bot's next RESUME.
    interact({ from, type = 2, data = {}, guild = guildId, dm = false, failCallback = false, at = null, replay = false } = {}) {
      const mem = typeof from === 'string' ? members.get(from) || { user: { id: from, username: 'user' + from.slice(-3) }, roles: [] } : from;
      const n = ++ixSeq;
      const d = {
        id: at == null ? String(700000000000000000n + BigInt(n)) : String(((BigInt(Math.floor(at)) - 1420070400000n) << 22n) | BigInt(n & 4095)),
        token: `ixtoken-${n}-secret`, application_id: appId, type, version: 1, data,
        ...(dm ? { user: mem.user } : { guild_id: guild, channel_id: channels[0].id, member: memberView(mem) }),
      };
      if (failCallback) failCallbacks.add(d.id);
      if (replay) gw.replay.push(d);
      else {
        const conn = mock.current();
        if (!conn) throw new Error('the bot is not connected to the stand-in gateway');
        conn.dispatch('INTERACTION_CREATE', d);
      }
      const mine = (c) => c.path === `/interactions/${d.id}/${d.token}/callback` || c.path === `/webhooks/${appId}/${d.token}/messages/@original`;
      return {
        d,
        calls: () => calls.filter(mine),
        // The bot's answer: the first callback (a reply or a button's update), or for a deferred reply its edit.
        answer: async (ms = 6000) => {
          const c = await mock.waitCall((x) => mine(x) && !(x.method === 'POST' && x.body?.type === 5), ms);
          return c ? { type: c.method === 'PATCH' ? 'edit' : c.body.type, data: c.method === 'PATCH' ? c.body : c.body.data, call: c } : null;
        },
      };
    },
    // A slash command: `options` as { name: value } (for a subcommand, pass `sub`).
    command(from, name, { sub = null, options = {}, resolved, ...rest } = {}) {
      const opts = Object.entries(options).map(([k, v]) => ({ name: k, type: k === 'member' ? 6 : 3, value: v })); // (6: a user option)
      const data = { id: '800000000000000001', name, type: 1, ...(sub ? { options: [{ type: 1, name: sub, options: opts }] } : opts.length ? { options: opts } : {}), ...(resolved ? { resolved } : {}) };
      return mock.interact({ from, type: 2, data, ...rest });
    },
    button(from, customId) {
      return mock.interact({ from, type: 3, data: { custom_id: customId, component_type: 2 } });
    },

    async waitCall(pred, ms = 6000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const c = calls.find(pred);
        if (c) return c;
        await wait(20);
      }
      return null;
    },
    async waitGateway(pred, ms = 6000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const p = mock.sent().find(pred);
        if (p) return p;
        await wait(20);
      }
      return null;
    },

    async close() {
      for (const c of gw.conns) { try { c.sock.terminate(); } catch { /* gone */ } }
      await new Promise((r) => wss.close(() => r()));
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
    },
  };
  return mock;
}
