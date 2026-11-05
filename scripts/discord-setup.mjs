// Sets up the game's Discord server from scripts/data/discord-server.json over Discord's REST API, with a bot invited to
// the server with Administrator (nothing has to stay online afterwards: self-assigned roles go through Discord's own
// Onboarding). The bot's token is read from .discord-token in the project folder (gitignored) and never printed.
//
//   node scripts/discord-setup.mjs invite             the link that adds the bot to your server
//   node scripts/discord-setup.mjs                    dry run: what would change, nothing is touched
//   node scripts/discord-setup.mjs --apply            create and update what's in the config (deletes nothing)
//   node scripts/discord-setup.mjs --apply --replace  also delete the channels, roles and AutoMod rules not in it
//   node scripts/discord-setup.mjs update-log [--apply]  only bring the update log up to date (--apply does it too)
//   node scripts/discord-setup.mjs release <link> [--apply]  only post this version's GitHub release link in #releases
// Options: --guild <id> (the bot is in more than one server), --download <url> (the download link in the messages),
// --name <name> (rename the server; by default its name is kept).
// Run again after changing the config: channels and roles are matched by name and updated in place, and the bot edits
// its own messages rather than posting them again.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.DISCORD_API || 'https://discord.com/api/v10'; // (DISCORD_API and DISCORD_TOKEN: for testing against a stand-in)
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const APPLY = flag('--apply'), REPLACE = flag('--replace');
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/data/discord-server.json'), 'utf8'));
const DOWNLOAD = opt('--download') || CONFIG.downloadUrl || '';

// ---- token and REST ----------------------------------------------------------------------------------------------
function readToken() {
  const clean = (s) => s.trim().replace(/^Bot\s+/i, '').replace(/^["'“”]+|["'“”]+$/g, '');
  let t = process.env.DISCORD_TOKEN ? clean(process.env.DISCORD_TOKEN) : '';
  for (const f of ['.discord-token', '.discord-token.txt']) {
    const p = path.join(ROOT, f);
    if (!t && fs.existsSync(p)) t = clean(fs.readFileSync(p, 'utf8'));
  }
  if (!t) {
    console.error('No bot token: put it in a file named .discord-token in the game folder (see the top of this script).');
    process.exit(1);
  }
  // Anything else (a second line, a note) would end up in an error message that quotes the header.
  if (!/^[A-Za-z0-9._-]+$/.test(t)) {
    console.error('The token file must hold only the token, on one line (letters, digits, dots, - and _). Nothing was sent.');
    process.exit(1);
  }
  return t;
}
const TOKEN = readToken();
const redact = (s) => String(s).split(TOKEN).join('[token]');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One request, waiting out rate limits (429 retry_after, and an emptied bucket before the next call).
async function api(method, route, body, { files, reason } = {}) {
  for (let attempt = 0; ; attempt++) {
    const headers = { Authorization: `Bot ${TOKEN}`, 'User-Agent': 'DiscordBot (https://github.com/discord, 1.0) cs2-case-sim-setup' };
    if (reason) headers['X-Audit-Log-Reason'] = encodeURIComponent(reason);
    let payload;
    if (files) {
      payload = new FormData();
      payload.append('payload_json', JSON.stringify(body));
      files.forEach((f, i) => payload.append(`files[${i}]`, new Blob([f.data], { type: f.type }), f.name));
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let res;
    try { res = await fetch(API + route, { method, headers, body: payload }); } catch (e) {
      if (attempt < 3) { await sleep(1500 * (attempt + 1)); continue; }
      throw new Error(`${method} ${route}: network error (${e.cause?.code || e.name})`); // (not e itself: it can quote the headers)
    }
    if (res.status === 429) {
      const j = await res.json().catch(() => ({}));
      await sleep(Math.ceil((j.retry_after ?? 1) * 1000) + 250);
      continue;
    }
    if (res.status >= 500 && attempt < 3) { await sleep(1500 * (attempt + 1)); continue; }
    const text = await res.text();
    let j = null;
    try { j = text ? JSON.parse(text) : null; } catch { j = null; } // (Cloudflare's error pages are HTML)
    if (res.status === 401) throw new Error('Discord refused the token (401). Check .discord-token holds the bot\'s current token: Developer Portal → Bot → Reset Token.');
    if (!res.ok) {
      const err = new Error(`${method} ${route} failed: ${res.status} ${j?.message || text.slice(0, 300)}${j?.errors ? ' ' + JSON.stringify(j.errors) : ''}`);
      err.code = j?.code;
      err.status = res.status;
      throw err;
    }
    if (res.headers.get('x-ratelimit-remaining') === '0') await sleep(Math.ceil(parseFloat(res.headers.get('x-ratelimit-reset-after') || '1') * 1000) + 100);
    return j;
  }
}

// ---- permissions -------------------------------------------------------------------------------------------------
const PERM = {
  CREATE_INSTANT_INVITE: 0, KICK_MEMBERS: 1, BAN_MEMBERS: 2, ADMINISTRATOR: 3, MANAGE_CHANNELS: 4, MANAGE_GUILD: 5,
  ADD_REACTIONS: 6, VIEW_AUDIT_LOG: 7, PRIORITY_SPEAKER: 8, STREAM: 9, VIEW_CHANNEL: 10, SEND_MESSAGES: 11,
  SEND_TTS_MESSAGES: 12, MANAGE_MESSAGES: 13, EMBED_LINKS: 14, ATTACH_FILES: 15, READ_MESSAGE_HISTORY: 16,
  MENTION_EVERYONE: 17, USE_EXTERNAL_EMOJIS: 18, VIEW_GUILD_INSIGHTS: 19, CONNECT: 20, SPEAK: 21, MUTE_MEMBERS: 22,
  DEAFEN_MEMBERS: 23, MOVE_MEMBERS: 24, USE_VAD: 25, CHANGE_NICKNAME: 26, MANAGE_NICKNAMES: 27, MANAGE_ROLES: 28,
  MANAGE_WEBHOOKS: 29, MANAGE_GUILD_EXPRESSIONS: 30, USE_APPLICATION_COMMANDS: 31, REQUEST_TO_SPEAK: 32,
  MANAGE_EVENTS: 33, MANAGE_THREADS: 34, CREATE_PUBLIC_THREADS: 35, CREATE_PRIVATE_THREADS: 36,
  USE_EXTERNAL_STICKERS: 37, SEND_MESSAGES_IN_THREADS: 38, USE_EMBEDDED_ACTIVITIES: 39, MODERATE_MEMBERS: 40,
  VIEW_CREATOR_MONETIZATION_ANALYTICS: 41, USE_SOUNDBOARD: 42, CREATE_GUILD_EXPRESSIONS: 43, CREATE_EVENTS: 44,
  USE_EXTERNAL_SOUNDS: 45, SEND_VOICE_MESSAGES: 46, SET_VOICE_CHANNEL_STATUS: 48, SEND_POLLS: 49, USE_EXTERNAL_APPS: 50, PIN_MESSAGES: 51,
  BYPASS_SLOWMODE: 52,
};
PERM.MANAGE_EMOJIS_AND_STICKERS = PERM.MANAGE_GUILD_EXPRESSIONS; // older name
function bits(names = []) {
  let b = 0n;
  for (const n of names) {
    const k = String(n).toUpperCase().replace(/[\s-]+/g, '_');
    if (!(k in PERM)) throw new Error(`Unknown permission "${n}" in the config`);
    b |= 1n << BigInt(PERM[k]);
  }
  return b;
}
const P = (...n) => bits(n);
// Roles that count as staff: they see the staff channels and can post where members only read.
const STAFF_PERMS = P('ADMINISTRATOR', 'MANAGE_GUILD', 'MANAGE_MESSAGES', 'MODERATE_MEMBERS', 'KICK_MEMBERS', 'BAN_MEMBERS');

// ---- config helpers ----------------------------------------------------------------------------------------------
const TYPE = { text: 0, voice: 2, category: 4, announcement: 5, stage: 13, forum: 15 };
// Discord only has these in Community servers (announcement channels also need its NEWS feature, which comes with it).
const NEEDS_COMMUNITY = new Set(['announcement', 'stage', 'forum']);
const color = (c) => (c ? parseInt(String(c).replace('#', ''), 16) : 0);
// Discord stores text-type channel names lowercased with spaces as hyphens.
const textLike = (type) => ['text', 'announcement', 'forum'].includes(type);
const normName = (name, type) => (textLike(type) ? name.toLowerCase().replace(/\s+/g, '-') : name);
const roleByKey = new Map(CONFIG.roles.map((r) => [r.key, r]));
const staffKeys = CONFIG.roles.filter((r) => bits(r.permissions) & STAFF_PERMS).map((r) => r.key);
const allChannels = CONFIG.categories.flatMap((cat, ci) => cat.channels.map((ch, i) => ({ ...ch, cat, ci, i })));
const chanByKey = new Map(allChannels.map((c) => [c.key, c]));
function emojiOf(s) { return s ? { emoji_id: null, emoji_name: s } : { emoji_id: null, emoji_name: null }; }

// Placeholders in the config's text: {{channel:key}}, {{role:key}}, {{download}}, {{icon}}.
function fill(text, ids) {
  if (text == null) return text;
  let s = String(text);
  if (!DOWNLOAD) s = s.split('\n').filter((l) => !l.includes('{{download}}')).join('\n');
  return s
    .replaceAll('{{download}}', DOWNLOAD)
    .replaceAll('{{icon}}', 'attachment://icon.png')
    .replace(/\{\{channel:([\w-]+)\}\}/g, (m, k) => (ids.channels.get(k) ? `<#${ids.channels.get(k)}>` : `#${chanByKey.get(k)?.name || k}`))
    .replace(/\{\{role:([\w-]+)\}\}/g, (m, k) => (ids.roles.get(k) ? `<@&${ids.roles.get(k)}>` : `@${roleByKey.get(k)?.name || k}`));
}

// ---- the update log ----------------------------------------------------------------------------------------------
// Every commit on the config's branch is an update: an intro, then a message a day (the day where the commit was made),
// each line a commit's subject after a Discord timestamp, which shows in the reader's own time zone.
function updateLogMessages(ids) {
  const U = CONFIG.updateLog;
  const log = execFileSync('git', ['log', '--reverse', '--format=%at%x1f%ad%x1f%s', '--date=format:%Y-%m-%d', U.branch || 'HEAD', '--'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
  const commits = log.split('\n').filter(Boolean).map((l) => { const [at, day, subject] = l.split('\x1f'); return { at: +at, day, subject }; })
    .sort((a, b) => a.at - b.at);
  const escape = (s) => s.replace(/[\\*_~`|[\]<>]/g, '\\$&'); // (a subject is text, not markdown or a mention)
  const days = [];
  commits.forEach((c, i) => {
    const line = `<t:${c.at}:t> — ${escape(c.subject)}`;
    let d = days.at(-1);
    if (!d || d.day !== c.day || d.text.length + line.length + 1 > 4096) days.push(d = { day: c.day, more: d?.day === c.day, text: '', first: i + 1 });
    d.text += (d.text ? '\n' : '') + line;
    d.last = i + 1;
  });
  const dateOf = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const latest = commits.at(-1);
  const intro = {
    title: fill(U.intro.title, ids).slice(0, 256),
    description: fill(U.intro.description, ids).replaceAll('{{count}}', commits.length.toLocaleString('en-US')).replaceAll('{{latest}}', latest ? `<t:${latest.at}:R>` : 'not yet').slice(0, 4096),
    color: color(U.color),
  };
  return {
    count: commits.length,
    embeds: [intro, ...days.map((d) => ({
      title: dateOf(d.day) + (d.more ? ' (continued)' : ''), description: d.text, color: color(U.color),
      footer: { text: d.first === d.last ? `Update ${d.first}` : `Updates ${d.first}–${d.last}` },
    }))],
  };
}

// The log's channel is the bot's: its messages there, oldest first, are the intro and the days in order. Each is edited
// only when it differs, new days are posted below, and with history rewritten to fewer days the extras go.
async function syncUpdateLog(cid, ids, me, apply) {
  const { count, embeds } = updateLogMessages(ids);
  const old = [];
  for (let after = '0'; ;) {
    const got = await api('GET', `/channels/${cid}/messages?limit=100&after=${after}`);
    old.push(...got.filter((m) => m.author?.id === me.id && m.type === 0));
    if (got.length < 100) break;
    after = got.reduce((a, m) => (BigInt(m.id) > BigInt(a) ? m.id : a), after);
  }
  old.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  const same = (m, e) => !m.content && m.embeds?.length === 1 && m.embeds[0].title === e.title && m.embeds[0].description === e.description
    && (m.embeds[0].color ?? 0) === e.color && (m.embeds[0].footer?.text ?? '') === (e.footer?.text ?? '');
  const todo = { post: Math.max(0, embeds.length - old.length), edit: embeds.filter((e, i) => old[i] && !same(old[i], e)).length, delete: Math.max(0, old.length - embeds.length) };
  const summary = `${todo.post} to post, ${todo.edit} to edit${todo.delete ? `, ${todo.delete} to delete` : ''}`;
  if (!apply) { console.log(`update log: ${count} updates in ${embeds.length} messages (the intro, then one a day); ${summary}`); return; }
  for (let i = 0; i < Math.max(old.length, embeds.length); i++) {
    if (i >= embeds.length) { await api('DELETE', `/channels/${cid}/messages/${old[i].id}`); continue; }
    const body = { content: '', embeds: [embeds[i]], allowed_mentions: { parse: [] } };
    if (!old[i]) await api('POST', `/channels/${cid}/messages`, { ...body, flags: 4096 }); // (silent: no ping per day)
    else if (!same(old[i], embeds[i])) await api('PATCH', `/channels/${cid}/messages/${old[i].id}`, body);
  }
  console.log(`update log: ${count} updates; ${todo.post} posted, ${todo.edit} edited${todo.delete ? `, ${todo.delete} deleted` : ''}`);
}

// ---- the plan ----------------------------------------------------------------------------------------------------
function overwritesFor(ch, ids, everyoneId) {
  // The category's access, then the channel's posting policy, as explicit overwrites (so each channel stands alone and
  // shows as synced with its category when they match).
  const ow = new Map(); // id -> { allow, deny, type }
  const get = (id) => { if (!ow.has(id)) ow.set(id, { id, type: 0, allow: 0n, deny: 0n }); return ow.get(id); };
  const allow = (id, b) => { const o = get(id); o.allow |= b; o.deny &= ~b; };
  const deny = (id, b) => { const o = get(id); o.deny |= b; o.allow &= ~b; };
  const view = P('VIEW_CHANNEL');
  const isVoice = ['voice', 'stage'].includes(ch.type);
  const post = isVoice ? P('CONNECT', 'SPEAK') : P('SEND_MESSAGES', 'SEND_MESSAGES_IN_THREADS', 'CREATE_PUBLIC_THREADS', 'CREATE_PRIVATE_THREADS');
  const access = ch.postingPolicy === 'staffOnly' ? 'staff' : ch.cat.access;
  if (access === 'staff') {
    deny(everyoneId, view);
    for (const k of staffKeys) allow(ids.roles.get(k), view);
  } else if (access === 'role') {
    deny(everyoneId, view);
    for (const k of [...(ch.cat.visibleToRoleKeys || []), ...staffKeys]) allow(ids.roles.get(k), view);
  }
  if (ch.postingPolicy === 'readOnly') {
    deny(everyoneId, post);
    for (const k of staffKeys) allow(ids.roles.get(k), post);
    if (!isVoice) allow(everyoneId, P('ADD_REACTIONS'));
  }
  return [...ow.values()].filter((o) => o.id).map((o) => ({ id: o.id, type: o.type, allow: String(o.allow), deny: String(o.deny) }));
}
function categoryOverwrites(cat, ids, everyoneId) {
  return overwritesFor({ type: 'text', cat, postingPolicy: 'everyone' }, ids, everyoneId);
}
function channelBody(ch, ids, everyoneId, parentId) {
  const b = { name: ch.name, type: TYPE[ch.type], parent_id: parentId, permission_overwrites: overwritesFor(ch, ids, everyoneId) };
  if (textLike(ch.type)) b.topic = fill(ch.type === 'forum' ? ch.forumGuidelines || ch.topic : ch.topic, ids)?.slice(0, ch.type === 'forum' ? 4096 : 1024) || null;
  if (['text', 'forum'].includes(ch.type)) b.rate_limit_per_user = ch.slowmodeSeconds || 0;
  if (ch.type === 'voice') b.user_limit = ch.userLimit || 0;
  if (ch.type === 'forum') {
    b.available_tags = (ch.forumTags || []).slice(0, 20).map((t) => ({ name: t.name.slice(0, 20), moderated: !!t.moderated, ...emojiOf(t.emoji) }));
    b.default_reaction_emoji = ch.forumDefaultReaction ? emojiOf(ch.forumDefaultReaction) : null;
    b.default_sort_order = 0; // latest activity
    b.default_forum_layout = 1; // list
    if (b.available_tags.some((t) => !t.moderated)) b.flags = 1 << 4; // REQUIRE_TAG: every post picks a tag
  }
  return b;
}

async function main() {
  const me = await api('GET', '/users/@me');
  if (args[0] === 'invite') {
    console.log(`Open this link, pick your server and press Authorize:\nhttps://discord.com/oauth2/authorize?client_id=${me.id}&scope=bot&permissions=8`);
    return;
  }
  const guilds = await api('GET', '/users/@me/guilds');
  const gid = opt('--guild') || (guilds.length === 1 ? guilds[0].id : null);
  if (!gid) {
    console.log(guilds.length ? `The bot is in ${guilds.length} servers; pick one with --guild <id>:\n${guilds.map((g) => `  ${g.id}  ${g.name}`).join('\n')}` : 'The bot is in no server yet: run "node scripts/discord-setup.mjs invite" for the link.');
    process.exit(1);
  }
  const guild = await api('GET', `/guilds/${gid}?with_counts=true`);
  const channels = await api('GET', `/guilds/${gid}/channels`);
  const roles = await api('GET', `/guilds/${gid}/roles`);
  const member = await api('GET', `/guilds/${gid}/members/${me.id}`);
  const automod = await api('GET', `/guilds/${gid}/auto-moderation/rules`).catch(() => []);
  const everyoneId = gid;
  const botTop = Math.max(0, ...roles.filter((r) => member.roles.includes(r.id)).map((r) => r.position));
  const community = guild.features.includes('COMMUNITY');

  console.log(`${APPLY ? 'Applying to' : 'Dry run for'} "${guild.name}" (${guild.approximate_member_count ?? '?'} members), as ${me.username}${REPLACE ? ', replacing what is not in the config' : ''}.`);
  if (!roles.some((r) => member.roles.includes(r.id) && BigInt(r.permissions) & P('ADMINISTRATOR'))) {
    console.log('! The bot has no Administrator permission: invite it again with the link from "invite".');
  }
  if (guild.mfa_level === 1) console.log('! The server requires 2FA for moderation, so your Discord account (the bot\'s owner) needs 2FA turned on for this to work.');

  // Roles: matched by name; not ours, and deleted with --replace.
  const ids = { roles: new Map(), channels: new Map() };
  const plan = [];
  const roleMatch = new Map();
  for (const r of CONFIG.roles) {
    const ex = roles.find((x) => !x.managed && x.id !== everyoneId && x.name === r.name);
    if (ex) { roleMatch.set(r.key, ex); ids.roles.set(r.key, ex.id); }
    plan.push(`${ex ? 'update' : 'create'} role  ${r.name}`);
  }
  const ourRoleIds = new Set([...roleMatch.values()].map((r) => r.id));
  const staleRoles = roles.filter((r) => r.id !== everyoneId && !r.managed && !ourRoleIds.has(r.id));
  // A bot can only change roles below its own: one of ours (by name), or with --replace one to delete, above it stops the run.
  const stuckRoles = roles.filter((r) => r.id !== everyoneId && !r.managed && r.position >= botTop && (ourRoleIds.has(r.id) || REPLACE));
  if (REPLACE) for (const r of staleRoles) plan.push(`${r.position >= botTop ? 'CANNOT delete (above the bot\'s role)' : 'delete'} role  ${r.name}`);

  // Channels: categories by name, channels by name and kind inside them.
  const chMatch = new Map(), catMatch = new Map();
  for (const cat of CONFIG.categories) {
    const ex = channels.find((x) => x.type === 4 && x.name.toLowerCase() === cat.name.toLowerCase());
    if (ex) catMatch.set(cat.name, ex);
    plan.push(`${ex ? 'update' : 'create'} category  ${cat.name}`);
    for (const ch of cat.channels) {
      const want = normName(ch.name, ch.type);
      const kinds = textLike(ch.type) ? [0, 5, 15] : [TYPE[ch.type]];
      const exc = channels.find((x) => kinds.includes(x.type) && normName(x.name, ch.type) === want && ![...chMatch.values()].includes(x));
      if (exc) { chMatch.set(ch.key, exc); ids.channels.set(ch.key, exc.id); }
      plan.push(`  ${exc ? 'update' : 'create'} ${ch.type.padEnd(12)} ${ch.name}`);
    }
  }
  if (args[0] === 'update-log') {
    const cid = ids.channels.get(CONFIG.updateLog.channelKey);
    if (!cid) { console.log(`There's no #${chanByKey.get(CONFIG.updateLog.channelKey).name} yet: run "node scripts/discord-setup.mjs --apply" to make it.`); process.exit(1); }
    await syncUpdateLog(cid, ids, me, APPLY);
    if (!APPLY) console.log('\nNothing was changed. Run again with --apply to post it.');
    return;
  }
  // A new build's link: a message of its own in #releases, once per version. Nothing else here edits or deletes it.
  if (args[0] === 'release') {
    const url = args[1] || '', version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    if (!/^https:\/\/github\.com\/\S+$/.test(url)) { console.log("Usage: node scripts/discord-setup.mjs release <the release's GitHub link> [--apply]"); process.exit(1); }
    const cid = ids.channels.get('releases'), name = chanByKey.get('releases').name, title = `CS2 Case Simulator ${version}`;
    if (!cid) { console.log(`There's no #${name} yet: run "node scripts/discord-setup.mjs --apply" to make it.`); process.exit(1); }
    const recent = await api('GET', `/channels/${cid}/messages?limit=100`);
    if (recent.some((m) => m.author?.id === me.id && m.embeds?.some((e) => e.title === title))) { console.log(`${title} is already in #${name}.`); return; }
    if (!APPLY) { console.log(`Would post in #${name}: ${title}, ${url}\n\nNothing was changed. Run again with --apply to post it.`); return; }
    await api('POST', `/channels/${cid}/messages`, { embeds: [{ title, url, description: `Download: ${url}`, color: color(CONFIG.updateLog.color) }], allowed_mentions: { parse: [] } });
    console.log(`Posted ${title} in #${name}.`);
    return;
  }
  const ourChanIds = new Set([...chMatch.values(), ...catMatch.values()].map((c) => c.id));
  const staleChannels = channels.filter((c) => !ourChanIds.has(c.id));
  if (REPLACE) for (const c of staleChannels) plan.push(`delete channel  ${c.type === 4 ? '[category] ' : '#'}${c.name}${c.last_message_id ? '  (has messages)' : ''}`);
  // Invite links and webhooks belong to a channel: deleting it ends them.
  const staleIds = new Set(staleChannels.map((c) => c.id));
  const lostInvites = REPLACE ? (await api('GET', `/guilds/${gid}/invites`).catch(() => [])).filter((i) => staleIds.has(i.channel?.id)) : [];
  const lostHooks = REPLACE ? (await api('GET', `/guilds/${gid}/webhooks`).catch(() => [])).filter((h) => staleIds.has(h.channel_id)) : [];
  for (const i of lostInvites) plan.push(`  (ends the invite discord.gg/${i.code}, ${i.uses ?? 0} uses)`);
  for (const h of lostHooks) plan.push(`  (ends the webhook "${h.name}")`);
  if (REPLACE) plan.push('make a permanent invite link to the new welcome channel');
  if (REPLACE) for (const r of automod.filter((a) => !CONFIG.automod.some((x) => x.name === a.name))) plan.push(`delete AutoMod rule  ${r.name}`);
  for (const a of CONFIG.automod) plan.push(`${automod.some((x) => x.name === a.name) ? 'update' : 'create'} AutoMod rule  ${a.name}`);
  if (CONFIG.ownerRoleKey) plan.push(`give the server owner the ${roleByKey.get(CONFIG.ownerRoleKey).name} role`);
  plan.push(`${community ? 'keep' : 'turn on'} Community; set the server's icon, description, rules and updates channels, welcome screen and onboarding`);
  plan.push(`post or edit the bot's messages in ${[...new Set(CONFIG.messages.map((m) => '#' + chanByKey.get(m.channelKey).name))].join(', ')}`);
  if (CONFIG.updateLog) plan.push(`bring the update log in #${chanByKey.get(CONFIG.updateLog.channelKey).name} up to date (${updateLogMessages(ids).count} updates)`);
  console.log(plan.join('\n'));
  if (stuckRoles.length) {
    console.log(`\n! ${stuckRoles.map((r) => r.name).join(', ')} ${stuckRoles.length > 1 ? 'are' : 'is'} above the bot's role, so the bot can't touch ${stuckRoles.length > 1 ? 'them' : 'it'}. In Server Settings → Roles, drag the bot's role (${roles.find((r) => r.managed && member.roles.includes(r.id))?.name || me.username}) to the top, then run this again.`);
    if (APPLY) { console.log('Nothing was changed.'); process.exit(1); }
  }
  if (!APPLY) { console.log('\nNothing was changed. Run again with --apply to apply (add --replace to delete what is listed).'); return; }

  const reason = 'CS2 Case Simulator server setup';
  // 1. @everyone's baseline, then our roles.
  await api('PATCH', `/guilds/${gid}/roles/${everyoneId}`, { permissions: String(bits(CONFIG.everyonePermissions)) }, { reason });
  for (const r of CONFIG.roles) {
    const body = { name: r.name, permissions: String(bits(r.permissions)), colors: { primary_color: color(r.color), secondary_color: null, tertiary_color: null }, hoist: !!r.hoist, mentionable: !!r.mentionable };
    const ex = roleMatch.get(r.key);
    const out = ex ? await api('PATCH', `/guilds/${gid}/roles/${ex.id}`, body, { reason }) : await api('POST', `/guilds/${gid}/roles`, body, { reason });
    ids.roles.set(r.key, out.id);
    console.log(`role ${ex ? 'updated' : 'created'}: ${r.name}`);
  }
  // Top to bottom as in the config, right under the bot's role, so the ones not ours (Server Booster, other bots') come
  // below them: moderators can act on everyone, and the staff colours show over the booster pink.
  const cur = await api('GET', `/guilds/${gid}/roles`);
  const top = Math.max(...cur.filter((r) => member.roles.includes(r.id)).map((r) => r.position));
  const ours = CONFIG.roles.map((r) => ids.roles.get(r.key));
  const rest = cur.filter((r) => r.id !== everyoneId && r.position < top && !ours.includes(r.id)).sort((a, b) => b.position - a.position).map((r) => r.id);
  await api('PATCH', `/guilds/${gid}/roles`, [...ours, ...rest].map((id, i) => ({ id, position: top - 1 - i })), { reason }).catch((e) => console.log(`! role order: ${e.message}`));
  if (CONFIG.ownerRoleKey && guild.owner_id) {
    await api('PUT', `/guilds/${gid}/members/${guild.owner_id}/roles/${ids.roles.get(CONFIG.ownerRoleKey)}`, undefined, { reason })
      .then(() => console.log(`the owner has the ${roleByKey.get(CONFIG.ownerRoleKey).name} role`), (e) => console.log(`! owner role: ${e.message}`));
  }

  // 2. Categories and the channels that don't need Community.
  const catIds = new Map();
  let news = guild.features.includes('NEWS');
  const makeChannel = async (ch) => {
    const parent = catIds.get(ch.cat.name);
    const body = channelBody(ch, ids, everyoneId, parent);
    if (ch.type === 'announcement' && !news) { body.type = 0; console.log(`! no announcement channels without Discord's NEWS feature: ${ch.name} is a text channel`); }
    const ex = chMatch.get(ch.key);
    let out;
    if (ex) {
      const wantType = body.type;
      delete body.type;
      if (ex.type !== wantType && [0, 5].includes(ex.type) && [0, 5].includes(wantType)) body.type = wantType;
      // A forum's tags are kept by id: sent without one, a tag is new and posts lose the old one.
      if (body.available_tags) body.available_tags = body.available_tags.map((t) => { const o = (ex.available_tags || []).find((x) => x.name === t.name); return o ? { ...t, id: o.id } : t; });
      out = await api('PATCH', `/channels/${ex.id}`, body, { reason });
    } else out = await api('POST', `/guilds/${gid}/channels`, body, { reason });
    ids.channels.set(ch.key, out.id);
    console.log(`channel ${ex ? 'updated' : 'created'}: ${ch.name}`);
  };
  for (const cat of CONFIG.categories) {
    const body = { name: cat.name, type: 4, permission_overwrites: categoryOverwrites(cat, ids, everyoneId) };
    const ex = catMatch.get(cat.name);
    const out = ex ? await api('PATCH', `/channels/${ex.id}`, { name: body.name, permission_overwrites: body.permission_overwrites }, { reason }) : await api('POST', `/guilds/${gid}/channels`, body, { reason });
    catIds.set(cat.name, out.id);
    console.log(`category ${ex ? 'updated' : 'created'}: ${cat.name}`);
    for (const ch of allChannels.filter((c) => c.cat === cat)) if (community || !NEEDS_COMMUNITY.has(ch.type)) await makeChannel(ch);
  }

  // 3. Community, with the server's settings and icon.
  const S = CONFIG.special, G = CONFIG.settings;
  const icon = fs.readFileSync(path.join(ROOT, 'build/icon.png'));
  const guildBody = {
    description: CONFIG.serverDescription?.slice(0, 120) || null,
    icon: `data:image/png;base64,${icon.toString('base64')}`,
    verification_level: Math.max(1, G.verificationLevel ?? 1),
    explicit_content_filter: 2,
    default_message_notifications: G.defaultNotifications ?? 1,
    rules_channel_id: ids.channels.get(S.rulesChannelKey),
    public_updates_channel_id: ids.channels.get(S.publicUpdatesChannelKey),
    system_channel_id: ids.channels.get(S.systemChannelKey) || null,
    // By default join messages (with their wave button) and boosts on; Discord's setup tips and role-subscription notices off.
    system_channel_flags: G.systemChannelFlags ?? ((1 << 2) | (1 << 4) | (1 << 5)),
    features: [...new Set([...guild.features, 'COMMUNITY'])],
  };
  if (S.safetyAlertsChannelKey && ids.channels.get(S.safetyAlertsChannelKey)) guildBody.safety_alerts_channel_id = ids.channels.get(S.safetyAlertsChannelKey);
  if (opt('--name')) guildBody.name = opt('--name');
  await api('PATCH', `/guilds/${gid}`, guildBody, { reason });
  console.log(`Community ${community ? 'kept' : 'turned on'}; icon, description and system channels set`);
  news = (await api('GET', `/guilds/${gid}`)).features.includes('NEWS');

  // 4. The channels that needed Community, then everything in the config's order.
  if (!community) for (const ch of allChannels) if (NEEDS_COMMUNITY.has(ch.type)) await makeChannel(ch);
  if (S.afkChannelKey && ids.channels.get(S.afkChannelKey)) await api('PATCH', `/guilds/${gid}`, { afk_channel_id: ids.channels.get(S.afkChannelKey), afk_timeout: G.afkTimeoutSeconds || 300 }, { reason });
  const positions = [];
  // (Parents were set channel by channel: this request may only move one channel to another category.)
  CONFIG.categories.forEach((cat, ci) => {
    positions.push({ id: catIds.get(cat.name), position: ci });
    cat.channels.forEach((ch, i) => positions.push({ id: ids.channels.get(ch.key), position: i }));
  });
  await api('PATCH', `/guilds/${gid}/channels`, positions, { reason }).catch((e) => console.log(`! channel order: ${e.message}`));

  // 5. With --replace: what isn't in the config goes (channels inside categories first).
  if (REPLACE) {
    const keep = new Set([...ids.channels.values(), ...catIds.values()]);
    const fresh = await api('GET', `/guilds/${gid}/channels`);
    for (const c of fresh.filter((c) => !keep.has(c.id)).sort((a, b) => (a.type === 4) - (b.type === 4))) {
      await api('DELETE', `/channels/${c.id}`, undefined, { reason }).then(() => console.log(`channel deleted: ${c.name}`), (e) => console.log(`! couldn't delete #${c.name}: ${e.message}`));
    }
    for (const r of staleRoles.filter((r) => r.position < botTop)) {
      await api('DELETE', `/guilds/${gid}/roles/${r.id}`, undefined, { reason }).then(() => console.log(`role deleted: ${r.name}`), (e) => console.log(`! couldn't delete role ${r.name}: ${e.message}`));
    }
    for (const a of automod.filter((a) => !CONFIG.automod.some((x) => x.name === a.name))) {
      await api('DELETE', `/guilds/${gid}/auto-moderation/rules/${a.id}`, undefined, { reason }).then(() => console.log(`AutoMod rule deleted: ${a.name}`), (e) => console.log(`! couldn't delete AutoMod rule ${a.name}: ${e.message}`));
    }
  }

  // 6. AutoMod. Discord allows one rule of each kind but keywords, so one of those under another name is taken over.
  const TRIGGER = { keyword: 1, spam: 3, keyword_preset: 4, mention_spam: 5, member_profile: 6 };
  const rulesNow = await api('GET', `/guilds/${gid}/auto-moderation/rules`).catch(() => automod);
  const PRESET = { PROFANITY: 1, SEXUAL_CONTENT: 2, SLURS: 3 };
  for (const a of CONFIG.automod) {
    const t = TRIGGER[a.trigger];
    const meta = {};
    if (a.keywords?.length) meta.keyword_filter = a.keywords;
    if (a.regexPatterns?.length) meta.regex_patterns = a.regexPatterns;
    if (a.allowList?.length) meta.allow_list = a.allowList;
    if (a.presets?.length) meta.presets = a.presets.map((p) => PRESET[p]);
    if (a.trigger === 'mention_spam') { meta.mention_total_limit = a.mentionLimit || 5; meta.mention_raid_protection_enabled = !!a.raidProtection; }
    const actions = a.actions.map((x) => {
      if (x.type === 'block') return { type: 1, metadata: x.customMessage ? { custom_message: x.customMessage.slice(0, 150) } : {} };
      if (x.type === 'alert') return { type: 2, metadata: { channel_id: ids.channels.get(x.alertChannelKey) } };
      return { type: 3, metadata: { duration_seconds: x.timeoutSeconds || 60 } };
    });
    const body = {
      name: a.name, event_type: a.trigger === 'member_profile' ? 2 : 1, trigger_metadata: meta, actions, enabled: true,
      exempt_roles: (a.exemptRoleKeys || []).map((k) => ids.roles.get(k)).filter(Boolean),
    };
    const ex = rulesNow.find((x) => x.name === a.name) || (t !== 1 ? rulesNow.find((x) => x.trigger_type === t) : undefined);
    try {
      if (ex && ex.trigger_type === t) {
        const { event_type, ...patch } = body;
        // Discord's own default rules (the one it adds with Community) can be read but not edited: replaced instead.
        await api('PATCH', `/guilds/${gid}/auto-moderation/rules/${ex.id}`, patch, { reason }).catch(async (e) => {
          if (e.status !== 404) throw e;
          await api('DELETE', `/guilds/${gid}/auto-moderation/rules/${ex.id}`, undefined, { reason }).catch(() => {});
          await api('POST', `/guilds/${gid}/auto-moderation/rules`, { ...body, trigger_type: t }, { reason });
        });
      } else {
        if (ex) await api('DELETE', `/guilds/${gid}/auto-moderation/rules/${ex.id}`, undefined, { reason });
        await api('POST', `/guilds/${gid}/auto-moderation/rules`, { ...body, trigger_type: t }, { reason });
      }
      console.log(`AutoMod rule ${ex ? 'updated' : 'created'}: ${a.name}`);
    } catch (e) { console.log(`! AutoMod rule ${a.name}: ${e.message}`); }
  }

  // 7. Welcome screen and onboarding.
  const W = CONFIG.welcomeScreen;
  await api('PATCH', `/guilds/${gid}/welcome-screen`, {
    enabled: true, description: fill(W.description, ids).slice(0, 140),
    welcome_channels: W.channels.slice(0, 5).map((c) => ({ channel_id: ids.channels.get(c.channelKey), description: c.description.slice(0, 50), ...emojiOf(c.emoji) })),
  }, { reason }).then(() => console.log('welcome screen set'), (e) => console.log(`! welcome screen (Discord may no longer let it be edited; onboarding replaces it): ${e.message}`));
  // Prompts and options keep their ids by title (members' answers point at them); new ones need ids Discord hasn't seen:
  // snowflakes from now. Its docs don't say whether voice channels may be offered, so if they're refused it's tried again
  // without them (they stay browsable).
  const O = CONFIG.onboarding;
  const curOnb = await api('GET', `/guilds/${gid}/onboarding`).catch(() => null);
  let next = BigInt(Date.now() - 1420070400000) << 22n;
  const sid = () => String(next++);
  const onboarding = (noVoice) => {
    const chans = (keys) => (keys || []).filter((k) => !(noVoice && ['voice', 'stage'].includes(chanByKey.get(k)?.type))).map((k) => ids.channels.get(k)).filter(Boolean);
    return {
      enabled: true, mode: 0, default_channel_ids: chans(O.defaultChannelKeys),
      prompts: O.prompts.map((p) => {
        const old = curOnb?.prompts?.find((x) => x.title === p.title.slice(0, 100));
        return {
          id: old?.id ?? sid(), type: 0, title: p.title.slice(0, 100), single_select: !!p.singleSelect, required: !!p.required, in_onboarding: p.inOnboarding !== false,
          options: p.options.map((o) => ({
            id: old?.options?.find((x) => x.title === o.title.slice(0, 50))?.id ?? sid(), title: o.title.slice(0, 50), description: o.description?.slice(0, 100) || null, ...emojiOf(o.emoji),
            role_ids: (o.roleKeys || []).map((k) => ids.roles.get(k)).filter(Boolean), channel_ids: chans(o.channelKeys),
          })).filter((o) => o.role_ids.length || o.channel_ids.length),
        };
      }),
    };
  };
  try {
    await api('PUT', `/guilds/${gid}/onboarding`, onboarding(false), { reason });
    console.log('onboarding set');
  } catch (e) {
    try { await api('PUT', `/guilds/${gid}/onboarding`, onboarding(true), { reason }); console.log(`onboarding set, without the voice channels (${e.message})`); } catch (e2) { console.log(`! onboarding: ${e2.message}`); }
  }

  // 8. The bot's messages. Its earlier ones are the first it posted in each channel (read from the oldest, a few pages at
  // most): those are edited in order, and an extra deleted only if it's one of these (by its embed's title), so anything
  // else the bot posts there later stays.
  const byChannel = new Map();
  for (const m of CONFIG.messages) { if (!byChannel.has(m.channelKey)) byChannel.set(m.channelKey, []); byChannel.get(m.channelKey).push(m); }
  for (const [key, msgs] of byChannel) {
    const cid = ids.channels.get(key);
    const titles = new Set(msgs.flatMap((m) => m.embeds.map((e) => fill(e.title, ids))));
    let old = [];
    for (let after = '0', page = 0; page < 5; page++) {
      const got = await api('GET', `/channels/${cid}/messages?limit=100&after=${after}`);
      old.push(...got.filter((m) => m.author?.id === me.id && m.type === 0));
      if (got.length < 100) break;
      after = got.reduce((a, m) => (BigInt(m.id) > BigInt(a) ? m.id : a), after);
    }
    old = old.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    const mine = old.filter((m, i) => i < msgs.length || m.embeds?.some((e) => titles.has(e.title)));
    for (let i = 0; i < Math.max(mine.length, msgs.length); i++) {
      if (i >= msgs.length) { await api('DELETE', `/channels/${cid}/messages/${mine[i].id}`, undefined, { reason }); continue; }
      const m = msgs[i];
      const usesIcon = m.embeds.some((e) => e.thumbnail === '{{icon}}');
      const body = {
        content: m.content ? fill(m.content, ids) : '',
        embeds: m.embeds.map((e) => ({
          title: fill(e.title, ids)?.slice(0, 256) || undefined,
          description: fill(e.description, ids)?.slice(0, 4096) || undefined,
          color: color(e.color) || undefined,
          thumbnail: e.thumbnail === '{{icon}}' ? { url: 'attachment://icon.png' } : undefined,
          fields: (e.fields || []).slice(0, 25).map((f) => ({ name: fill(f.name, ids).slice(0, 256), value: fill(f.value, ids).slice(0, 1024) || '​', inline: !!f.inline })),
          footer: e.footer ? { text: fill(e.footer, ids).slice(0, 2048) } : undefined,
        })),
        allowed_mentions: { parse: [] },
        attachments: usesIcon ? [{ id: 0, filename: 'icon.png' }] : [],
      };
      const files = usesIcon ? [{ name: 'icon.png', type: 'image/png', data: icon }] : undefined;
      if (mine[i]) await api('PATCH', `/channels/${cid}/messages/${mine[i].id}`, body, { files });
      else await api('POST', `/channels/${cid}/messages`, { ...body, flags: 4096 }, { files });
    }
    console.log(`messages ${mine.length ? 'updated' : 'posted'}: #${chanByKey.get(key).name}`);
  }
  if (CONFIG.updateLog) await syncUpdateLog(ids.channels.get(CONFIG.updateLog.channelKey), ids, me, true);

  // 9. With --replace the old invite links went with their channels: a permanent one to the welcome channel.
  if (REPLACE) {
    const at = ids.channels.get(CONFIG.inviteChannelKey || allChannels[0].key);
    await api('POST', `/channels/${at}/invites`, { max_age: 0, max_uses: 0, unique: false }, { reason })
      .then((inv) => console.log(`\nInvite link (never expires): https://discord.gg/${inv.code}`), (e) => console.log(`! invite: ${e.message}`));
  }
  console.log('\nDone.');
}

main().catch((e) => { console.error(redact(e?.message ?? e)); process.exit(1); });
