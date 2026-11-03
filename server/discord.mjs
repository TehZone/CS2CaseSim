// The game server's Discord bot: REST calls that wait out Discord's rate limits, a gateway connection that receives
// the slash commands, and the helpers server/admin.mjs builds on (staff levels from roles, the linked role, DMs, bans,
// the mod log). It knows nothing about the game's tables: admin.mjs answers the interactions this hands it.
// The token never appears in a log line or an error message.
import WebSocket from 'ws';

const ADMINISTRATOR = 1n << 3n;
const MODERATE_MEMBERS = 1n << 40n;
const DEFAULT_GATEWAY = 'wss://gateway.discord.gg';
// Closes a reconnect can't fix: a refused token, a bad shard, API version or intents.
const FATAL_CLOSES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
// Closes after which the session can't be resumed: start a new one.
const FRESH_CLOSES = new Set([4007, 4009]);
const ROLES_MS = 5 * 60 * 1000;
const MEMBER_MS = 60 * 1000;
// A lookup on a player's request path (login, hello): one try, and an answer (or null) within this.
const FAST_MS = 3000;
const FAST = { retries: 0, timeout: FAST_MS };
// An interaction must be answered within 3 s of being sent; one replayed later than this after a RESUME can't be.
const REPLAY_MS = 10000;
const SETUP_RETRY_MS = 30 * 1000, SETUP_RETRY_MAX = 10 * 60 * 1000;
const NOT_CONNECTED = 'This server isn\'t connected to Discord';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Settles as p does, or rejects after ms (p carries on: a late answer still fills the caches for the next ask).
function within(p, ms) {
  let t;
  const late = new Promise((_, no) => { t = setTimeout(() => no(new Error(`no answer from Discord in ${ms / 1000} s`)), ms); t.unref?.(); });
  return Promise.race([p, late]).finally(() => clearTimeout(t));
}
// When Discord made an id (a snowflake), or null for an id that isn't one.
const madeAt = (id) => (/^\d{1,20}$/.test(String(id)) ? Number((BigInt(id) >> 22n) + 1420070400000n) : null);
// Ids go into URL paths: anything with a slash, dot or query character is refused before a request is made.
const okId = (id) => (typeof id === 'string' || typeof id === 'number') && /^[\w-]{1,64}$/.test(String(id));
const perms = (p) => { try { return BigInt(p ?? 0); } catch { return 0n; } };
const nameOf = (u) => (u ? u.global_name || u.username || null : null);
const cut = (s, n) => { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// ---- slash commands (spec §4) ------------------------------------------------------------------------------------
const STRING = 3, USER = 6, SUB = 1;
const player = () => ({ type: STRING, name: 'player', description: 'Their game username', required: true, min_length: 1, max_length: 32 });
export const COMMANDS = [
  {
    name: 'link', type: 1, contexts: [0],
    description: 'Link your game account: use the code from the game (Account, then Link Discord)',
    options: [{ type: STRING, name: 'code', description: 'The code the game shows you, like ABC-123', required: true, min_length: 6, max_length: 9 }],
  },
  { name: 'unlink', type: 1, contexts: [0], description: 'Unlink your game account from your Discord account' },
  {
    name: 'profile', type: 1, contexts: [0],
    description: 'Show a member\'s game account: level, inventory, cases opened and matches',
    options: [{ type: USER, name: 'member', description: 'Whose profile (yours when left out)', required: false }],
  },
  { name: 'resetpassword', type: 1, contexts: [0], description: 'Get a one-time code to reset the password of your linked game account' },
  {
    name: 'game', type: 1, contexts: [0], default_member_permissions: String(MODERATE_MEMBERS),
    description: 'Moderate the game server (staff only)',
    options: [
      { type: SUB, name: 'lookup', description: 'Look up a player: money, level, items, linked Discord and bans', options: [player()] },
      {
        type: SUB, name: 'ban', description: 'Ban a player from the game server',
        options: [
          player(),
          {
            type: STRING, name: 'duration', description: 'How long the ban lasts', required: true,
            choices: [
              { name: '1 hour', value: '1h' }, { name: '1 day', value: '1d' }, { name: '7 days', value: '7d' },
              { name: '30 days', value: '30d' }, { name: 'Permanent', value: 'perm' },
            ],
          },
          { type: STRING, name: 'reason', description: 'Why (the player sees this)', required: true, min_length: 1, max_length: 300 },
        ],
      },
      { type: SUB, name: 'unban', description: 'Lift every active ban of a player', options: [player()] },
      {
        type: SUB, name: 'kick', description: 'Disconnect a player from the game server',
        options: [player(), { type: STRING, name: 'reason', description: 'Why (the player sees this)', required: false, max_length: 300 }],
      },
      {
        type: SUB, name: 'warn', description: 'Send a player a warning they see in the game',
        options: [player(), { type: STRING, name: 'message', description: 'The warning', required: true, min_length: 1, max_length: 500 }],
      },
      {
        type: SUB, name: 'broadcast', description: 'Send a message to everyone online in the game (admins only)',
        options: [{ type: STRING, name: 'message', description: 'The message', required: true, min_length: 1, max_length: 500 }],
      },
    ],
  },
];

// Discord refuses a message whose embed texts are over its limits: clip them rather than lose the message.
function clipEmbed(e) {
  if (!e || typeof e !== 'object') return e;
  const o = { ...e };
  if (o.title != null) o.title = cut(o.title, 256);
  if (o.description != null) o.description = cut(o.description, 4096);
  if (Array.isArray(o.fields)) {
    o.fields = o.fields.slice(0, 25).map((f) => ({
      ...f, name: cut(f?.name || '​', 256), value: cut(f?.value === '' || f?.value == null ? '—' : f.value, 1024),
    }));
  }
  if (o.footer?.text != null) o.footer = { ...o.footer, text: cut(o.footer.text, 2048) };
  if (o.author?.name != null) o.author = { ...o.author, name: cut(o.author.name, 256) };
  return o;
}
const message = ({ content, embeds, components } = {}) => ({
  content: content == null ? undefined : cut(content, 2000),
  embeds: Array.isArray(embeds) ? embeds.slice(0, 10).map(clipEmbed) : embeds,
  components,
  allowed_mentions: { parse: [] }, // (player and staff text never pings anyone)
});

export function createDiscord({ token, guildId, api = 'https://discord.com/api/v10', gatewayUrl, log = console.log,
  adminRoles = ['★ Developer'], modRoles = ['Moderator'], logChannel, linkedRole = '🔗 Linked', gateway = true } = {}) {
  const TOKEN = typeof token === 'string' ? token.trim().replace(/^Bot\s+/i, '') : '';
  const enabled = !!TOKEN;
  const API = String(api || 'https://discord.com/api/v10').replace(/\/+$/, '');
  const redact = (s) => (TOKEN ? String(s).split(TOKEN).join('[token]') : String(s));
  const say = (msg) => { try { log(redact(`[discord] ${msg}`)); } catch { /* a broken logger mustn't stop the bot */ } };
  const names = (v) => new Set((Array.isArray(v) ? v : String(v ?? '').split(',')).map((s) => String(s).trim().toLowerCase()).filter(Boolean));
  const ADMIN_ROLES = names(adminRoles), MOD_ROLES = names(modRoles);
  const LINKED = String(linkedRole || '').trim().toLowerCase();

  // Anything else in the token (a second line, a note) would end up quoted in an error about a bad header.
  const tokenErr = enabled && !/^[A-Za-z0-9._-]+$/.test(TOKEN) ? 'The bot token has characters a Discord token never has (check the token file holds only the token)' : null;
  const usable = enabled && !tokenErr;
  const errs = { gateway: null, setup: null };
  const st = { connected: false, ready: false, bot: null, guild: null };
  let gid = guildId ? String(guildId) : null;
  let appId = null;

  const status = () => ({
    enabled, connected: st.connected, ready: st.ready, bot: st.bot, guild: st.guild, guildId: gid,
    error: tokenErr || errs.gateway || errs.setup || null,
  });

  // ---- REST ------------------------------------------------------------------------------------------------------
  const blocked = new Map(); // bucket -> when its emptied bucket refills
  let globalUntil = 0;
  // Discord's buckets go per route with the channel, guild or webhook id kept and other ids folded together.
  const bucketOf = (method, route) => method + ' ' + route.split('?')[0]
    .replace(/(\/(?:channels|guilds|webhooks|interactions)\/[\w-]+)|\/\d+/g, (m, major) => major || '/:id');
  // Interaction and webhook tokens are secrets for 15 minutes: never in an error message either.
  const shown = (route) => route.split('?')[0].replace(/(\/(?:interactions|webhooks)\/[\w-]+)\/[^/]+/, '$1/[token]');

  let skew = 0; // Discord's clock minus ours (from its Date header), so a host whose clock is off still ages interactions right

  // One request, waiting out rate limits (429 retry_after, and an emptied bucket before its next call), with server
  // errors and network errors retried 3 times. `retries: 0` (a request path) makes one try and gives up on a 429.
  async function rest(method, route, body, { reason, retries = 3, timeout = 15000 } = {}) {
    const label = `${method} ${shown(route)}`;
    const bucket = bucketOf(method, route);
    for (let tries = 0, limited = 0; ;) {
      const wait = Math.max(globalUntil, blocked.get(bucket) || 0) - Date.now();
      if (wait > 0) await sleep(wait);
      const headers = { Authorization: `Bot ${TOKEN}`, 'User-Agent': 'DiscordBot (https://github.com/discord, 1.0) cs2-case-sim-server' };
      if (reason) headers['X-Audit-Log-Reason'] = encodeURIComponent(String(reason).slice(0, 400));
      let payload;
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      let res;
      try { res = await fetch(API + route, { method, headers, body: payload, signal: AbortSignal.timeout(timeout) }); } catch (e) {
        if (tries++ < retries) { await sleep(1500 * tries); continue; }
        throw new Error(`${label}: network error (${e.cause?.code || e.name})`); // (not e itself: it can quote the headers)
      }
      const date = Date.parse(res.headers.get('date') || '');
      if (date) skew = date + 500 - Date.now(); // (the header is to the second)
      if (res.headers.get('x-ratelimit-remaining') === '0') {
        blocked.set(bucket, Date.now() + Math.ceil(parseFloat(res.headers.get('x-ratelimit-reset-after') || '1') * 1000) + 100);
      }
      if (res.status === 429) {
        const j = await res.json().catch(() => ({}));
        const ms = Math.ceil((Number(j.retry_after) || 1) * 1000) + 250;
        const limitErr = Object.assign(new Error(`${label}: rate limited by Discord (try again in ${Math.ceil(ms / 1000)} s)`), { status: 429 });
        if (++limited > 5 || ms > 60000) throw limitErr;
        if (j.global || res.headers.get('x-ratelimit-global')) globalUntil = Date.now() + ms;
        else blocked.set(bucket, Date.now() + ms);
        if (!retries) throw limitErr; // (the next call waits the limit out)
        continue;
      }
      if (res.status >= 500 && tries++ < retries) { await res.arrayBuffer().catch(() => {}); await sleep(1500 * tries); continue; }
      const text = await res.text().catch(() => null); // (null: the answer was cut off, e.g. by the timeout)
      if (text === null && res.ok) {
        if (tries++ < retries) { await sleep(1500 * tries); continue; }
        throw new Error(`${label}: network error (the answer was cut off)`); // (not an empty success)
      }
      let j = null;
      try { j = text ? JSON.parse(text) : null; } catch { j = null; } // (Cloudflare's error pages are HTML)
      if (!res.ok) {
        const what = res.status === 401 && !/^\/(interactions|webhooks)\//.test(route) ? 'Discord refused the bot token' : (j?.message || String(text || '').slice(0, 300));
        const err = new Error(redact(`${label} failed: ${res.status} ${what}${j?.errors ? ' ' + JSON.stringify(j.errors).slice(0, 500) : ''}`));
        err.status = res.status;
        err.code = j?.code;
        throw err;
      }
      return j;
    }
  }

  // ---- cached lookups --------------------------------------------------------------------------------------------
  // A value loaded at most once per ttl and shared by everyone who asks while it loads; a failed load isn't kept.
  function cached(ttl, load) {
    let at = 0, p = null;
    return (fresh = false) => {
      if (!p || fresh || Date.now() - at >= ttl) {
        const mine = p = load();
        at = Date.now();
        mine.catch(() => { if (p === mine) p = null; });
      }
      return p;
    };
  }
  let gidP = null;
  function resolveGid() {
    if (gid) return Promise.resolve(gid);
    if (!gidP) {
      gidP = (async () => {
        const list = await rest('GET', '/users/@me/guilds');
        if (!Array.isArray(list) || list.length !== 1) {
          throw new Error(list?.length ? 'The bot is in more than one server: set DISCORD_GUILD_ID' : 'The bot isn\'t in any server yet: invite it first');
        }
        gid = String(list[0].id);
        return gid;
      })();
      gidP.catch(() => { gidP = null; });
    }
    return gidP;
  }
  const guildInfo = cached(ROLES_MS, async () => {
    const g = await rest('GET', `/guilds/${await resolveGid()}`);
    st.guild = g?.name || null;
    return g;
  });
  const roleMap = cached(ROLES_MS, async () => {
    const roles = await rest('GET', `/guilds/${await resolveGid()}/roles`);
    if (!Array.isArray(roles)) throw new Error('GET roles: no role list in Discord\'s answer'); // (not "nobody has a role")
    return new Map(roles.map((r) => [String(r.id), r]));
  });
  const members = new Map(); // discord id -> { at, p } (p: the member, or null when they aren't in the server)
  function fetchMember(id, fresh = false, fast = false) {
    const now = Date.now();
    let e = members.get(id);
    if (!e || fresh || now - e.at >= MEMBER_MS) {
      if (members.size > 2000) for (const [k, v] of members) if (now - v.at >= MEMBER_MS) members.delete(k);
      const p = (async () => {
        try {
          const m = await rest('GET', `/guilds/${await resolveGid()}/members/${id}`, undefined, fast ? FAST : undefined);
          if (!m || typeof m !== 'object') throw new Error(`GET member ${id}: no member in Discord's answer`); // (not "not in the server")
          return m;
        } catch (err) {
          if (err.status === 404) return null;
          throw err;
        }
      })();
      e = { at: now, p };
      members.set(id, e);
      const mine = e;
      p.catch(() => { if (members.get(id) === mine) members.delete(id); });
    }
    return e.p;
  }
  // The mod log's channel: the configured id, else the first text channel with mod-log in its name (or null).
  const modLogChannel = cached(ROLES_MS, async () => {
    if (logChannel) return String(logChannel);
    const chans = await rest('GET', `/guilds/${await resolveGid()}/channels`);
    const c = (chans || []).find((ch) => ch.type === 0 && String(ch.name || '').toLowerCase().includes('mod-log'));
    if (!c) say('no mod-log channel: set DISCORD_LOG_CHANNEL or add a text channel with mod-log in its name');
    return c ? String(c.id) : null;
  });

  // A member's staff level from their roles; throws when the server or its roles can't be loaded.
  async function levelFrom(m) {
    const uid = m.user?.id;
    const g = await guildInfo();
    if (uid && g?.owner_id && String(g.owner_id) === String(uid)) return 3;
    const roles = await roleMap();
    let level = 0;
    for (const rid of m.roles || []) {
      const r = roles.get(String(rid));
      if (!r) continue;
      const name = String(r.name || '').trim().toLowerCase();
      if ((perms(r.permissions) & ADMINISTRATOR) || ADMIN_ROLES.has(name)) level = Math.max(level, 2);
      else if (MOD_ROLES.has(name)) level = Math.max(level, 1);
    }
    return level;
  }
  // The level of the member who used a command (fail closed: 0 when it can't be worked out).
  async function memberLevel(m) {
    if (!usable || !m || typeof m !== 'object') return 0;
    try {
      return await levelFrom(m);
    } catch (e) {
      say(`couldn't work out a member's staff level (counted as a player): ${e.message}`);
      return 0;
    }
  }

  // ---- interactions ----------------------------------------------------------------------------------------------
  const handlers = [];
  async function respond(what, method, route, body) {
    try { await rest(method, route, body); return true; } catch (e) {
      say(`interaction ${what} failed: ${e.message}`);
      return false;
    }
  }
  function wrap(d) {
    const data = d.data || {};
    const u = d.member?.user || d.user || {};
    let sub = null, opts = Array.isArray(data.options) ? data.options : [];
    const first = opts[0];
    if (first?.type === 2) { // (a subcommand group: its subcommand)
      const s = (first.options || [])[0];
      sub = s?.name ?? null;
      opts = s?.options || [];
    } else if (first?.type === 1) {
      sub = first.name;
      opts = first.options || [];
    }
    const callback = `/interactions/${d.id}/${d.token}/callback`;
    const app = d.application_id || appId;
    return {
      ...d,
      raw: d,
      user: { id: u.id ?? null, name: nameOf(u) },
      member: d.member || null,
      command: data.name ?? null,
      sub,
      opt: (name) => { const o = opts.find((x) => x.name === name); return o ? o.value : null; },
      customId: data.custom_id ?? null,
      reply: (m = {}) => respond('reply', 'POST', callback, { type: 4, data: { ...message(m), ...(m.ephemeral ? { flags: 64 } : {}) } }),
      defer: ({ ephemeral } = {}) => respond('defer', 'POST', callback, { type: 5, ...(ephemeral ? { data: { flags: 64 } } : {}) }),
      edit: (m = {}) => respond('edit', 'PATCH', `/webhooks/${app}/${d.token}/messages/@original`, message(m)),
      update: (m = {}) => respond('update', 'POST', callback, { type: 7, data: message(m) }),
    };
  }
  // `replayed`: it came in while a RESUME replays the events the dropped connection missed. Only a replay is aged:
  // live events are new by definition, and the defer answers for those.
  function onInteractionCreate(d, replayed = false) {
    if (!d || d.guild_id == null) return; // (a DM)
    const at = replayed ? madeAt(d.id) : null;
    if (at != null && Date.now() + skew - at > REPLAY_MS) {
      // Its 3 s to answer are long gone (Discord already told them the app didn't respond): acting on it now would run a
      // command someone may have given up on or done another way.
      say(`skipped ${d.data?.name ? '/' + d.data.name : 'a button press'} replayed after a reconnect, ${Math.round((Date.now() + skew - at) / 1000)} s late`);
      return;
    }
    if (!gid) { // (the setup that finds the server failed: find it now rather than drop the interaction)
      resolveGid().then(() => onInteractionCreate(d), (e) => say(`an interaction was dropped: ${e.message}`));
      return;
    }
    if (String(d.guild_id) !== gid) return; // (another server)
    const ix = wrap(d);
    if (!handlers.length) { ix.reply({ content: 'The game server is still starting. Try again in a moment.', ephemeral: true }); return; }
    for (const fn of handlers) Promise.resolve().then(() => fn(ix)).catch((e) => say(`interaction handler failed: ${e?.message || e}`));
  }

  // ---- gateway ---------------------------------------------------------------------------------------------------
  let ws = null, gwBase = null, seq = null, sessionId = null, resumeUrl = null;
  // The current socket: opened to the resume url, got HELLO, between a RESUME and RESUMED (Discord replaying).
  let viaResume = false, helloSeen = false, replaying = false, resumeFails = 0;
  let beatFirst = null, beatTimer = null, acked = true, retryTimer = null, invalidTimer = null;
  let backoff = 1000, stopped = false, readied = false, setupDone = false;
  let setupP = null, setupTimer = null, setupWait = SETUP_RETRY_MS;
  let startP = null, startDone = null;
  const finishStart = () => { if (startDone) { const r = startDone; startDone = null; r(status()); } };
  const unref = (t) => { t?.unref?.(); return t; };

  function send(sock, p) {
    if (sock.readyState !== WebSocket.OPEN) return;
    try { sock.send(JSON.stringify(p)); } catch (e) { say(`gateway send failed: ${e.message}`); }
  }
  const identify = (sock) => send(sock, { op: 2, d: { token: TOKEN, intents: 0, properties: { os: process.platform, browser: 'cs2sim', device: 'cs2sim' } } });
  const resume = (sock) => { replaying = true; send(sock, { op: 6, d: { token: TOKEN, session_id: sessionId, seq } }); };
  // Discord's docs: when resuming fails, connect to the main gateway url instead. Two sockets to the resume url that
  // never got HELLO (refused, timed out) count as that; RESUME then goes to the main url while the session lasts.
  function resumeUnreachable() {
    if (!resumeUrl || ++resumeFails < 2) return;
    resumeUrl = null;
    resumeFails = 0;
    say('the resume url can\'t be reached: resuming through the main gateway url');
  }

  function stopBeat() {
    clearTimeout(beatFirst);
    clearInterval(beatTimer);
    beatFirst = beatTimer = null;
  }
  // Heartbeats every interval, the first after a random part of it; a beat that finds the last one unacknowledged
  // means the connection died without closing (a zombie): drop it and resume on a new one.
  function heartbeat(sock, interval) {
    stopBeat();
    acked = true;
    const tick = () => {
      if (sock !== ws) return stopBeat();
      if (!acked) { say('no heartbeat ack: the connection looks dead, reconnecting'); return drop(sock, true); }
      acked = false;
      send(sock, { op: 1, d: seq });
    };
    beatFirst = unref(setTimeout(() => {
      beatFirst = null;
      if (sock !== ws) return;
      tick();
      if (sock === ws) beatTimer = unref(setInterval(tick, interval));
    }, Math.floor(interval * Math.random())));
  }

  function reconnect(ms) {
    clearTimeout(retryTimer);
    retryTimer = unref(setTimeout(connect, ms));
  }
  // Leaves a socket we're done with (Discord asked for a reconnect, or it's a zombie) and connects again at once;
  // HELLO on the new one resumes the session.
  function drop(sock, dead = false) {
    if (sock !== ws) return;
    ws = null;
    stopBeat();
    st.connected = st.ready = false;
    try { if (dead) sock.terminate(); else sock.close(4000, 'reconnect'); } catch { /* already gone */ }
    if (!dead) unref(setTimeout(() => { try { sock.terminate(); } catch { /* gone */ } }, 5000));
    if (!stopped) reconnect(0);
  }

  function connect() {
    retryTimer = null;
    if (stopped) return;
    let url;
    const toResume = !!(sessionId && resumeUrl);
    try {
      const u = new URL(toResume ? resumeUrl : gwBase);
      if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw new Error('not a WebSocket url');
      u.searchParams.set('v', '10');
      u.searchParams.set('encoding', 'json');
      url = u.toString();
    } catch (e) {
      if (resumeUrl && sessionId) { resumeUrl = null; return reconnect(0); } // (a bad resume url: the main one, then)
      errs.gateway = `Bad gateway url (${e.message})`;
      say(errs.gateway);
      stopped = true;
      return finishStart();
    }
    let sock;
    try { sock = new WebSocket(url, { handshakeTimeout: 15000, maxPayload: 16 << 20 }); } catch (e) {
      say(`gateway: ${e.message}`);
      if (toResume) resumeUnreachable();
      reconnect(backoff);
      backoff = Math.min(backoff * 2, 60000);
      return;
    }
    ws = sock;
    viaResume = toResume;
    helloSeen = replaying = false;
    sock.on('open', () => { if (sock === ws) st.connected = true; });
    sock.on('message', (raw) => {
      if (sock !== ws) return;
      let p;
      try { p = JSON.parse(raw.toString()); } catch { return; }
      if (p && typeof p === 'object') onPacket(sock, p);
    });
    sock.on('error', (e) => { if (sock === ws) say(`gateway error: ${e.message}`); });
    sock.on('close', (code, why) => onClose(sock, code, String(why || '')));
  }

  function onPacket(sock, p) {
    if (p.s != null) seq = p.s;
    switch (p.op) {
      case 10: // HELLO
        helloSeen = true;
        if (viaResume) resumeFails = 0;
        heartbeat(sock, Number(p.d?.heartbeat_interval) || 41250);
        if (sessionId) resume(sock);
        else identify(sock);
        break;
      case 11: acked = true; break;
      case 1: send(sock, { op: 1, d: seq }); break; // (Discord wants a beat now)
      case 7: say('Discord asked for a reconnect'); drop(sock); break;
      case 9: invalidSession(sock, p.d === true); break;
      case 0: dispatch(p.t, p.d); break;
    }
  }

  // Discord wants 1 to 5 s between an invalid session and the next try. If the socket closes meanwhile, the
  // reconnect does the identify (or resume) instead.
  function invalidSession(sock, resumable) {
    if (!resumable) { sessionId = null; resumeUrl = null; seq = null; }
    st.ready = false;
    say(resumable ? 'session invalidated: resuming' : 'session invalidated: identifying again');
    clearTimeout(invalidTimer);
    invalidTimer = unref(setTimeout(() => {
      invalidTimer = null;
      if (sock !== ws || sock.readyState !== WebSocket.OPEN) return;
      if (sessionId) resume(sock);
      else identify(sock);
    }, 1000 + Math.random() * 4000));
  }

  function dispatch(t, d) {
    if (t === 'READY') {
      sessionId = d?.session_id || null;
      resumeUrl = d?.resume_gateway_url || null;
      resumeFails = 0;
      replaying = false;
      appId = d?.application?.id ? String(d.application.id) : appId;
      st.bot = nameOf(d?.user) || st.bot;
      st.ready = true;
      errs.gateway = null;
      backoff = 1000;
      say(`connected as ${st.bot}`);
      if (!readied) { readied = true; setup().finally(finishStart); } else if (!setupDone) setup();
    } else if (t === 'RESUMED') {
      replaying = false; // (the replay is over: what follows is new)
      st.ready = true;
      errs.gateway = null;
      backoff = 1000;
      say('session resumed');
    } else if (t === 'INTERACTION_CREATE') {
      onInteractionCreate(d, replaying);
    }
  }

  function onClose(sock, code, why) {
    if (sock !== ws) return; // (one we dropped ourselves)
    ws = null;
    stopBeat();
    clearTimeout(invalidTimer);
    st.connected = st.ready = false;
    if (stopped) return;
    const what = `${code}${why ? ' ' + why : ''}`;
    if (FATAL_CLOSES.has(code)) {
      stopped = true;
      errs.gateway = code === 4004 ? 'Discord refused the bot token (gateway close 4004)' : `Discord closed the gateway for good (${what})`;
      say(errs.gateway);
      return finishStart();
    }
    if (viaResume && !helloSeen) resumeUnreachable();
    if (FRESH_CLOSES.has(code)) { sessionId = null; resumeUrl = null; seq = null; }
    say(`gateway closed (${what}): reconnecting in ${backoff / 1000} s`);
    if (!readied) { errs.gateway = `Couldn't connect to Discord's gateway (${what}); still trying`; finishStart(); }
    reconnect(backoff);
    backoff = Math.min(backoff * 2, 60000);
  }

  // Resolves the guild and registers the slash commands (bulk overwrite: the list is exactly COMMANDS). One that fails
  // is tried again later (30 s, doubling up to 10 min): a session can be resumed for days without another READY.
  function setup() {
    clearTimeout(setupTimer);
    setupTimer = null;
    if (!setupP) setupP = trySetup().finally(() => { setupP = null; });
    return setupP;
  }
  async function trySetup() {
    try {
      const g = await guildInfo(true);
      if (!appId) throw new Error('No application id from Discord');
      await rest('PUT', `/applications/${appId}/guilds/${gid}/commands`, COMMANDS);
      setupDone = true;
      errs.setup = null;
      setupWait = SETUP_RETRY_MS;
      if (!gateway) st.ready = true;
      say(`slash commands registered in ${g?.name || gid}`);
    } catch (e) {
      errs.setup = e.status === 403 && e.code === 50001
        ? `Couldn't register the slash commands: invite the bot with the applications.commands scope (${e.message})`
        : `Setup failed: ${e.message}`;
      if (stopped || e.status === 401) return say(errs.setup); // (a refused token stays refused)
      say(`${errs.setup} (trying again in ${setupWait / 1000} s)`);
      setupTimer = unref(setTimeout(setup, setupWait));
      setupWait = Math.min(setupWait * 2, SETUP_RETRY_MAX);
    }
  }

  async function run() {
    if (!gateway) {
      // REST only (another instance runs the gateway): the bot's id is the application's.
      const me = await rest('GET', '/users/@me');
      appId = String(me.id);
      st.bot = nameOf(me);
      await setup();
      st.ready = setupDone;
      return finishStart();
    }
    if (gatewayUrl) gwBase = String(gatewayUrl);
    else {
      try { gwBase = (await rest('GET', '/gateway/bot'))?.url || DEFAULT_GATEWAY; } catch (e) {
        if (e.status === 401) throw e;
        gwBase = DEFAULT_GATEWAY;
        say(`couldn't ask for the gateway url (${e.message}): using the default one`);
      }
    }
    connect();
  }

  // ---- the bot's object ------------------------------------------------------------------------------------------
  let logQ = Promise.resolve(), logWaiting = 0;
  const dmChannels = new Map(); // discord id -> DM channel id

  return {
    enabled,
    status,
    // Whether this instance receives the slash commands and buttons (it runs the gateway): what /link and
    // /resetpassword answer through. False with DISCORD_GATEWAY=0, and once the gateway stopped for good.
    get interactions() { return !!(usable && gateway) && !stopped; },

    start() {
      if (!usable) {
        if (tokenErr) say(tokenErr);
        return Promise.resolve(status());
      }
      if (startP) return startP;
      startP = new Promise((r) => { startDone = r; });
      run().catch((e) => {
        errs.setup = e.status === 401 ? 'Discord refused the bot token (401): check DISCORD_BOT_TOKEN' : redact(e.message);
        say(errs.setup);
        stopped = true;
        finishStart();
      });
      return startP;
    },

    close() {
      stopped = true;
      clearTimeout(retryTimer);
      clearTimeout(invalidTimer);
      clearTimeout(setupTimer);
      stopBeat();
      const sock = ws;
      ws = null;
      if (sock) {
        try { sock.close(1000, 'bye'); } catch { /* not open yet */ }
        unref(setTimeout(() => { try { sock.terminate(); } catch { /* gone */ } }, 2000));
      }
      st.connected = st.ready = false;
      finishStart();
    },

    onInteraction(fn) {
      if (typeof fn === 'function') handlers.push(fn);
    },

    memberLevel,

    // 0..3, 0 when they aren't in the server, null when Discord couldn't tell (an error, a timeout: never cached, the
    // next ask tries again). `fast` (a player's login or hello): one try, and an answer within ~3 s.
    async levelOf(discordId, { refresh = false, fast = false } = {}) {
      if (!usable || !okId(discordId)) return 0;
      const look = (async () => {
        const m = await fetchMember(String(discordId), refresh, fast);
        return m ? await levelFrom(m) : 0;
      })();
      try {
        return await (fast ? within(look, FAST_MS) : look); // (fast: also when it joins a slower lookup already going)
      } catch (e) {
        say(`couldn't look up member ${discordId} (staff level unknown: counted as a player for their own access): ${e.message}`);
        return null;
      }
    },

    async member(discordId) {
      if (!usable || !okId(discordId)) return null;
      try {
        const m = await fetchMember(String(discordId));
        if (!m) return null;
        const u = m.user || {};
        const id = String(u.id || discordId);
        return { id, name: nameOf(u), avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${id}/${u.avatar}.png?size=128` : null };
      } catch (e) {
        say(`couldn't look up member ${discordId}: ${e.message}`);
        return null;
      }
    },

    async setLinkedRole(discordId, on) {
      if (!usable || !okId(discordId) || !LINKED) return false;
      try {
        const role = [...(await roleMap()).values()].find((r) => String(r.name || '').trim().toLowerCase() === LINKED);
        if (!role) return false;
        await rest(on ? 'PUT' : 'DELETE', `/guilds/${await resolveGid()}/members/${discordId}/roles/${role.id}`, undefined,
          { reason: on ? 'Linked their game account' : 'Unlinked their game account' });
        members.delete(String(discordId)); // (their roles changed)
        return true;
      } catch (e) {
        if (e.status !== 404) say(`couldn't ${on ? 'give' : 'take away'} the linked role: ${e.message}`); // (404: not in the server)
        return false;
      }
    },

    async dm(discordId, { content, embeds } = {}) {
      if (!usable || !okId(discordId)) return false;
      const id = String(discordId);
      try {
        let cid = dmChannels.get(id);
        if (!cid) {
          cid = String((await rest('POST', '/users/@me/channels', { recipient_id: id })).id);
          if (dmChannels.size > 1000) dmChannels.clear();
          dmChannels.set(id, cid);
        }
        await rest('POST', `/channels/${cid}/messages`, message({ content, embeds }));
        return true;
      } catch (e) {
        // 50007: they don't take DMs from this server's members, or they blocked the bot.
        say(e.code === 50007 ? `couldn't DM ${id}: they don't accept DMs from the bot` : `couldn't DM ${id}: ${e.message}`);
        return false;
      }
    },

    async ban(discordId, reason) {
      if (!usable) return { ok: false, error: NOT_CONNECTED };
      if (!okId(discordId)) return { ok: false, error: 'Not a Discord user id' };
      try {
        await rest('PUT', `/guilds/${await resolveGid()}/bans/${discordId}`, {}, { reason: reason || 'Banned from the game' });
        members.delete(String(discordId));
        return { ok: true, error: null };
      } catch (e) {
        say(`couldn't ban ${discordId} on Discord: ${e.message}`);
        return { ok: false, error: e.status === 403 ? 'The bot can\'t ban them: it needs Ban Members and a role above theirs' : e.message };
      }
    },

    async unban(discordId, reason) {
      if (!usable) return { ok: false, error: NOT_CONNECTED };
      if (!okId(discordId)) return { ok: false, error: 'Not a Discord user id' };
      try {
        await rest('DELETE', `/guilds/${await resolveGid()}/bans/${discordId}`, undefined, { reason: reason || 'Unbanned from the game' });
        return { ok: true, error: null };
      } catch (e) {
        if (e.status === 404) return { ok: true, error: null }; // (they weren't banned there: that's the state wanted)
        say(`couldn't unban ${discordId} on Discord: ${e.message}`);
        return { ok: false, error: e.status === 403 ? 'The bot can\'t unban: it needs Ban Members' : e.message };
      }
    },

    // Posts one after another, so a burst of staff actions waits its turn behind the channel's rate limit.
    modLog({ title, description, fields, color } = {}) {
      if (!usable) return Promise.resolve(false);
      if (logWaiting >= 100) { say('mod log: too many messages waiting, one was dropped'); return Promise.resolve(false); }
      logWaiting++;
      const p = logQ.then(async () => {
        try {
          const cid = await modLogChannel();
          if (!cid) return false;
          const embed = { title, description, fields, color: Number.isInteger(color) ? color : 0xeb4b4b, timestamp: new Date().toISOString() };
          await rest('POST', `/channels/${cid}/messages`, message({ embeds: [embed] }));
          return true;
        } catch (e) {
          say(`mod log: ${e.message}`);
          return false;
        } finally {
          logWaiting--;
        }
      });
      logQ = p;
      return p;
    },
  };
}
