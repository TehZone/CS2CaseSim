// The admin panel (online, staff only): the server at a glance, its players (find one, then ban, kick or warn them, edit
// their stats and items, read the configs their game synced, save and restore snapshots of their account), the bans,
// the audit log and the server's settings. The server checks every request against your staff level (1 moderator,
// 2 admin, 3 owner, from your linked Discord roles) and refuses what you can't do; this page only hides it.
import { esc, money, timeAgo, debounce } from '../util.js';
import { D, WEAR_BY_KEY, wearOf } from '../data.js';
import * as I from '../items.js';
import { online } from '../backend.js';
import { sfx } from '../audio.js';
import { toast, openModal, confirmDialog, openInspect } from '../ui.js';
import { levelIconHtml } from '../profile.js';
import { net } from '../net/online.js';
import { LEVEL_NAMES } from '../account.js';
import { playPrefs, savePlayPrefs } from './play-settings.js';
import { BINDS_VERSION } from '../play/input.js';
import { ASPECTS, RESOLUTIONS } from '../play/screen.js';

const TABS = [['dash', 'Dashboard'], ['players', 'Players'], ['bans', 'Bans'], ['audit', 'Audit log'], ['server', 'Server']];
const TAB_DATA = { dash: 'overview', players: 'players', bans: 'bans', audit: 'audit', server: 'settings' };
const FILTERS = [['all', 'All'], ['online', 'Online'], ['banned', 'Banned'], ['linked', 'Linked'], ['staff', 'Staff']];
const SUBS = [['overview', 'Overview'], ['inventory', 'Inventory'], ['configs', 'Configs'], ['snapshots', 'Snapshots'], ['history', 'History']];
const KINDS = [['all', 'All items'], ['skin', 'Skins'], ['sticker', 'Stickers'], ['agent', 'Agents'], ['charm', 'Charms'], ['crate', 'Cases'], ['key', 'Keys']];
const GIVE_KINDS = [['skin', 'Skin'], ['crate', 'Case'], ['key', 'Key'], ['sticker', 'Sticker'], ['agent', 'Agent'], ['charm', 'Charm']];
const DURATIONS = [['60', '1 hour'], ['1440', '1 day'], ['10080', '7 days'], ['43200', '30 days'], ['perm', 'Permanent'], ['custom', 'Custom (minutes)']];
const PAGE = 50, INV_PAGE = 100, MAX_JSON = 48 * 1024, MAX_MINUTES = 5256000;
const STAT_LABELS = {
  opened: 'Cases opened', spent: 'Spent on cases', sold: 'Sold items for', bestValue: 'Best drop value', knives: 'Knives & gloves',
  stickersApplied: 'Stickers applied', tradeups: 'Trade-ups', armory: 'Armory redemptions', gambleWagered: 'Gambled', gambleWon: 'Gambling result',
  battles: 'Case battles', playMatches: 'Matches played', playWins: 'Matches won', playKills: 'Kills', playEarned: 'Earned from matches', npcTrades: 'NPC trades',
};
const MONEY_STATS = new Set(['spent', 'sold', 'bestValue', 'gambleWagered', 'gambleWon', 'playEarned']);
const RANK_LABELS = { mmr: 'MMR', group: 'Skill group (0-18)', wins: 'Wins', losses: 'Losses', ties: 'Ties', lastWin: 'Last win (time, ms)' };
// What each staff level may do (see the server's rules); the Dashboard lists it.
const ACCESS = [
  [1, 'See every player: stats, items, configs, snapshots and history'],
  [1, 'Ban, kick, warn and sign out players below your level; lift bans'],
  [1, 'Write notes and save snapshots'],
  [2, 'Edit money, stats and items; restore and delete snapshots; rename and reset accounts'],
  [2, 'Network bans and Discord bans'],
  [2, 'Server settings and broadcasts'],
  [3, 'All of it over admins too'],
];

const view = {
  tab: 'dash', q: '', filter: 'all', page: 0, player: null, sub: 'overview', bansActive: true, auditQ: '', auditPage: 0,
  inv: { q: '', kind: 'all', sort: 'value', page: 0, sel: new Set() },
};
let root = null, offs = [], shownLevel = 0;

export function render(r) {
  root = r;
  offs.forEach((o) => o());
  // Opening the page asks the server afresh.
  for (const k of Object.keys(store)) delete store[k];
  offs = [
    // A role given or taken in the Discord changes what you can do here.
    net.on('account', () => { if (myLevel() !== shownLevel) draw(); }),
    net.on('status', ({ status }) => { if (status === 'online') drawBody(); }),
  ];
  draw();
}
export function destroy() { offs.forEach((o) => o()); offs = []; root = null; }

// ---- who may do what (the server decides; this hides what it would refuse) ----------------------
const myLevel = () => (online() && net.account()?.staff) || 0;
const isAdmin = () => myLevel() >= 2;
const isSelf = (u) => u?.id != null && u.id === net.me()?.id;
const canPunish = (u) => myLevel() >= 1 && !isSelf(u) && myLevel() > (u.staff || 0);
const canChange = (u) => myLevel() >= 2 && (isSelf(u) || myLevel() > (u.staff || 0));

// ---- requests ----------------------------------------------------------------------------------
// What each section shows, as the server last answered it: { m, args, data, error, pending } per key.
const store = {};
const invalidate = (...keys) => keys.forEach((k) => delete store[k]);
// The answer a section draws from, when it's here. Otherwise `el` shows that it's loading (or the error, with a retry)
// and `redraw` runs when the answer comes. Other args (another page, a search) ask again.
function need(key, m, args, el, redraw) {
  const a = JSON.stringify(args);
  let s = store[key];
  if (!s || s.args !== a) s = store[key] = { m, args: a };
  if ('data' in s) return s.data || {};
  if (s.error) {
    el.innerHTML = `<div class="empty adm-empty"><div class="red">${esc(s.error)}</div><button class="btn sm" data-retry>Try again</button></div>`;
    el.querySelector('[data-retry]').addEventListener('click', () => { invalidate(key); redraw(); });
    return null;
  }
  el.innerHTML = '<div class="empty adm-empty">Loading…</div>';
  if (!s.pending) {
    s.pending = true;
    net.admin(m, args).then((d) => { s.data = d; }, (e) => { s.error = e.message || 'Request failed'; })
      .finally(() => { s.pending = false; if (store[key] === s && root) redraw(); });
  }
  return null;
}
// Asks again for what a section shows, keeping the old answer on screen until the new one is here.
function refresh(key, redraw) {
  const s = store[key];
  if (!s || !('data' in s)) { invalidate(key); redraw(); return; }
  if (s.pending) return;
  s.pending = true;
  net.admin(s.m, JSON.parse(s.args)).then((d) => { s.data = d; }, (e) => toast(esc(e.message), 'bad'))
    .finally(() => { s.pending = false; if (store[key] === s && root) redraw(); });
}
// Runs a request with its button(s) disabled until the answer; a refusal or error is a toast (unless `fail(e)` shows it
// itself and returns true). `ok` (HTML, or a function of the answer) is the toast when it worked. Resolves to the
// answer, or null when it failed.
async function run(btns, m, args, ok, fail) {
  const list = [].concat(btns || []).filter(Boolean);
  list.forEach((b) => { b.disabled = true; });
  try {
    const r = await net.admin(m, args);
    if (ok) { sfx.coin(); toast(typeof ok === 'function' ? ok(r || {}) : ok, 'good'); }
    return r || {};
  } catch (e) {
    sfx.error();
    if (!fail?.(e)) toast(esc(e.message), 'bad');
    return null;
  } finally {
    list.forEach((b) => { if (b.isConnected) b.disabled = false; });
  }
}
// Pages: the server's first page number (0 or 1) is learnt from its answer to a request that doesn't name one.
const pageBase = {};
const pageArg = (key, idx) => (idx > 0 ? { page: (pageBase[key] ?? 0) + idx } : {});
const notePage = (key, idx, d) => { if (idx === 0) pageBase[key] = Number.isInteger(d.page) ? d.page : 0; };

// ---- formatting --------------------------------------------------------------------------------
const fmtDate = (ts) => (ts ? new Date(+ts).toLocaleString() : '—');
const when = (ts) => (ts ? `<span title="${esc(fmtDate(ts))}">${timeAgo(+ts)}</span>` : '<span class="dim">—</span>');
const untilText = (exp) => (exp ? `until ${fmtDate(exp)}` : 'permanently');
const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const num = (v) => (v != null && Number.isFinite(+v) ? (+v).toLocaleString() : '—');
const plural = (n, w, ws = w + 's') => `${(+n || 0).toLocaleString()} ${+n === 1 ? w : ws}`;
const hue = (name) => [...String(name)].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
const avatar = (name, cls = '') => `<span class="avatar ${cls}" style="--c:hsl(${hue(name)} 55% 40%)">${esc(String(name || '?').slice(0, 2).toUpperCase())}</span>`;
const levelName = (l) => LEVEL_NAMES[Math.max(0, Math.min(3, l | 0))];
const staffChip = (l) => (l >= 1 ? `<span class="chip ${l >= 2 ? 'gold' : 'green'}">${levelName(l)}</span>` : '');
const profLevel = (l) => { const n = Math.max(1, Math.min(40, l | 0 || 1)); return `<span class="adm-lvl">${levelIconHtml(n, 20)}${n}</span>`; };
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const kb = (bytes) => (bytes == null ? '—' : bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);
const jsonSize = (v) => new TextEncoder().encode(JSON.stringify(v)).length;
function durText(min) {
  if (min % 1440 === 0) return plural(min / 1440, 'day');
  if (min % 60 === 0) return plural(min / 60, 'hour');
  return plural(min, 'minute');
}
// (In milliseconds.)
function uptimeText(ms) {
  if (ms == null || !Number.isFinite(+ms)) return '—';
  const s = Math.floor(+ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
function dbText(db) {
  if (db == null) return '—';
  if (typeof db !== 'object') return String(db);
  return [db.kind || db.type || db.name, db.size != null ? (typeof db.size === 'number' ? kb(db.size) : db.size) : null].filter(Boolean).join(' · ') || clip(JSON.stringify(db), 40);
}
// Bans as the server gives them (in a player's history they may be the table's own rows).
const normBan = (b) => ({
  ...b, by: b.by ?? b.by_name ?? '', liftedBy: b.liftedBy ?? b.lifted_by ?? '', network: b.network ?? !!b.ip_hash,
  created: +b.created || null, expires: b.expires != null ? +b.expires : null, lifted: b.lifted != null ? +b.lifted : null,
});
const banActive = (b) => b.active ?? (!b.lifted && (!b.expires || b.expires > net.serverNow()));
function banStatus(b) {
  if (b.lifted) return `<span class="chip">Lifted</span> <span class="muted">${b.liftedBy ? `by ${esc(b.liftedBy)} ` : ''}${when(b.lifted)}</span>`;
  if (b.expires && b.expires <= net.serverNow()) return '<span class="chip">Expired</span>';
  return '<span class="chip red">Active</span>';
}
// Items as the server keeps them: one this build's game data doesn't know mustn't break the page.
const safe = (fn, fallback) => (i) => { try { return fn(i); } catch { return fallback; } };
const itemName = safe((i) => I.itemName(i), 'Unknown item');
const itemValue = safe((i) => I.itemValue(i), 0);
const itemImg = safe((i) => I.itemImage(i, 's'), '');
const itemColor = safe((i) => I.rarityInfo(i).c, '#b0c3d9');

function downloadJson(name, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name.replace(/[^\w.-]+/g, '_').replace(/_+/g, '_');
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const today = (ts = Date.now()) => new Date(+ts).toISOString().slice(0, 10);

function pagerHtml(total, idx, size = PAGE) {
  const pages = Math.max(1, Math.ceil((+total || 0) / size));
  if (pages <= 1) return '';
  return `<div class="adm-pager"><button class="btn sm" data-pg="${idx - 1}" ${idx <= 0 ? 'disabled' : ''}>‹ Prev</button>
    <span>Page ${idx + 1} of ${pages}</span><button class="btn sm" data-pg="${idx + 1}" ${idx >= pages - 1 ? 'disabled' : ''}>Next ›</button></div>`;
}
const wirePager = (el, go) => el.querySelectorAll('[data-pg]').forEach((b) => b.addEventListener('click', () => go(+b.dataset.pg)));
// Player names anywhere on the page open that player.
const wireOpen = (el) => el.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); openPlayer(+b.dataset.open); }));
const playerLink = (u) => (u ? `<button class="adm-link" data-open="${+u.id}">${esc(u.name)}</button>` : '<span class="dim">—</span>');

// A window with a form. `submit($, err)` runs on OK (and Enter in a one-line field) and returns true when it's done
// (the window closes); OK is disabled while it runs.
function formModal({ title, body, ok = 'OK', danger = false, cls = '', submit }) {
  const m = openModal({
    title, cls, body: `<div class="adm-form">${body}<div class="err" data-err></div></div>`,
    foot: `<button class="btn ghost" data-close>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${ok}</button>`,
  });
  const $ = (s) => m.el.querySelector(s);
  const btn = $('[data-ok]'), errEl = $('[data-err]');
  const go = async () => {
    if (btn.disabled) return;
    errEl.textContent = '';
    btn.disabled = true;
    let done = false;
    try { done = await submit($, (t) => { errEl.textContent = t; }); } finally { if (btn.isConnected) btn.disabled = false; }
    if (done) m.close();
  };
  btn.addEventListener('click', go);
  m.el.querySelectorAll('input.input:not([type=search])').forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); }));
  m.el.querySelector('.modal-body .input')?.focus();
  return m;
}

// ---- the page ------------------------------------------------------------------------------------
function draw() {
  if (!root) return;
  const lvl = shownLevel = myLevel();
  if (!online() || lvl < 1) {
    root.innerHTML = `<div class="page"><div class="empty">${online() ? "The admin panel is for this server's moderators and admins."
      : 'The admin panel needs an online account with staff rights. Click <b>Offline</b> at the top right to log in.'}</div></div>`;
    return;
  }
  root.innerHTML = `<div class="page adm">
    <div class="page-head"><h1>Admin</h1><span class="sub">${esc(net.me()?.name || '')} ${staffChip(lvl)} on <span class="fair">${esc(net.serverUrl())}</span></span></div>
    <div class="seg adm-tabs" data-tabs>${TABS.map(([k, n]) => `<button data-v="${k}" class="${view.tab === k ? 'active' : ''}">${n}</button>`).join('')}</div>
    <div class="adm-body" data-body></div>
  </div>`;
  root.querySelectorAll('[data-tabs] button').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.v === 'players') view.player = null; // (Players again from a player: back to the list.)
    view.tab = b.dataset.v;
    invalidate(TAB_DATA[view.tab]);
    draw();
  }));
  drawBody();
}

function drawBody() {
  const el = root?.querySelector('[data-body]');
  if (!el) return;
  if (net.status() !== 'online') { el.innerHTML = '<div class="empty adm-empty">Connecting to the server…</div>'; return; }
  if (view.tab === 'players') return view.player != null ? drawPlayer(el) : drawPlayers(el);
  ({ dash: drawDash, bans: drawBans, audit: drawAudit, server: drawServer })[view.tab]?.(el);
}

function openPlayer(id) {
  if (!Number.isFinite(id)) return;
  Object.assign(view, { tab: 'players', player: id, sub: 'overview', inv: { q: '', kind: 'all', sort: 'value', page: 0, sel: new Set() } });
  invalidate('player');
  draw();
}
// After a change to a player: their page again, and the lists that may show it.
function afterChange() {
  invalidate('players', 'overview', 'bans', 'audit');
  refresh('player', drawBody);
}

// ---- Dashboard -----------------------------------------------------------------------------------
function drawDash(el) {
  const o = need('overview', 'overview', {}, el, drawBody);
  if (!o) return;
  const stats = [
    ['Online now', num(o.online)], ['Accounts', num(o.accounts)], ['Linked to Discord', num(o.linked)], ['Active bans', num(o.activeBans)],
    ['Money in circulation', money(+o.money || 0)], ['Items', num(o.items)], ['Uptime', uptimeText(o.uptime)], ['Database', esc(dbText(o.db))],
  ];
  el.innerHTML = `<div class="toolbar adm-bar"><span class="muted">The server at a glance</span><span class="spacer"></span><button class="btn sm" data-refresh>Refresh</button></div>
    <div class="statgrid adm-stats">${stats.map(([k, v]) => `<div class="stat"><span>${k}</span><b>${v}</b></div>`).join('')}</div>
    <div class="adm-cols">
      <div class="panel"><h3>Discord bot</h3>${discordStatusHtml(obj(o.discord))}</div>
      <div class="panel"><h3>Your access</h3>${accessHtml(o.me)}</div>
      <div class="panel"><h3>Server switches</h3>${switchesHtml(obj(o.settings))}
        <div class="adm-panel-foot"><button class="btn ghost sm" data-go="server">Server settings</button></div></div>
    </div>
    <div class="section-title">Latest staff actions</div>
    ${auditTableHtml(Array.isArray(o.recent) ? o.recent : [])}
    <div class="adm-panel-foot"><button class="btn ghost sm" data-go="audit">Full audit log</button></div>`;
  el.querySelector('[data-refresh]').addEventListener('click', () => refresh('overview', drawBody));
  el.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => { view.tab = b.dataset.go; invalidate(TAB_DATA[view.tab]); draw(); }));
  wireOpen(el);
}

function discordStatusHtml(dc) {
  if (!dc.enabled) return `<div class="adm-state"><span class="chip">Not configured</span></div>
    <p class="muted adm-note">This server runs without a Discord bot: no account linking or slash commands, and staff come from ADMIN_USERS.</p>`;
  const [cls, label] = dc.error ? ['red', 'Error'] : dc.connected && dc.ready ? ['green', 'Connected'] : ['gold', 'Connecting'];
  return `<dl class="kv"><dt>Status</dt><dd><span class="chip ${cls}">${label}</span></dd><dt>Bot</dt><dd>${esc(dc.bot || '—')}</dd>
    <dt>Server</dt><dd>${esc(dc.guild || dc.guildId || '—')}</dd>${dc.error ? `<dt>Error</dt><dd class="red">${esc(dc.error)}</dd>` : ''}</dl>`;
}
function accessHtml(me) {
  const l = me?.level ?? myLevel();
  return `<div class="adm-state">${staffChip(l)}<span class="muted">as ${esc(me?.name || net.me()?.name || '')}</span></div>
    <ul class="adm-access">${ACCESS.map(([n, t]) => `<li class="${l >= n ? 'yes' : 'no'}">${t}</li>`).join('')}</ul>`;
}
function switchesHtml(s) {
  // (Green when the switch is where a normal day has it.)
  const sw = (label, on, normal) => `<div class="adm-switch"><span>${label}</span><span class="chip ${on === normal ? 'green' : 'red'}">${on ? 'On' : 'Off'}</span></div>`;
  return `${sw('Maintenance', !!s.maintenance, false)}${sw('New accounts', s.registration !== false, true)}${sw('Trading', s.trading !== false, true)}${sw('Gambling', s.gambling !== false, true)}
    <div class="adm-motd"><span>Message of the day</span>${s.motd ? `<div>${esc(s.motd)}</div>` : '<div class="dim">None</div>'}</div>`;
}

// ---- the audit log (its tab, the Dashboard and a player's history) ---------------------------------
const actionTone = (a) => (a === 'ban' || a === 'reset' || a === 'items.remove' ? 'red' : a === 'unban' ? 'green' : ['kick', 'warn', 'signout'].includes(a) ? 'gold' : '');
// A value in a log line: times as dates, a Discord account or player by name, lists by length.
function short(v, k = '') {
  if (v == null) return '—';
  if (v === '') return '(empty)';
  if (typeof v === 'number' && v > 1e12 && /^(expires|created|at|until)$|At$/.test(k)) return fmtDate(v);
  if (Array.isArray(v)) return plural(v.length, 'item');
  if (typeof v === 'object') return typeof v.name === 'string' ? (k === 'discord' ? '@' : '') + clip(v.name, 40) : clip(JSON.stringify(v), 60);
  return clip(v, 60);
}
// The fields that differ between a before and an after (one level into objects: prof.level, stats.opened).
function diffs(a, b, pre = '') {
  const out = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k], y = b[k];
    if (!pre && x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x)) out.push(...diffs(x, y, k + '.'));
    else if (JSON.stringify(x) !== JSON.stringify(y)) out.push([pre + k, x, y]);
  }
  return out;
}
function auditSummary(d) {
  if (d == null || d === '') return '<span class="dim">—</span>';
  if (typeof d !== 'object') return esc(clip(d, 160));
  const out = [];
  if (d.before && d.after && typeof d.before === 'object' && typeof d.after === 'object') {
    const ch = diffs(d.before, d.after);
    for (const [k, a, b] of ch.slice(0, 5)) out.push(`<span class="adm-diff"><b>${esc(k)}</b> ${esc(short(a))} → ${esc(short(b))}</span>`);
    if (ch.length > 5) out.push(`<span class="dim">+${ch.length - 5} more</span>`);
  } else if ('before' in d || 'after' in d) out.push(`<span class="adm-diff">${esc(short(d.before))} → ${esc(short(d.after))}</span>`);
  for (const [k, v] of Object.entries(d)) {
    // (Ids and lists the before / after already tells, and switches that stayed off, are left out.)
    if (AUDIT_SKIP.has(k) || v == null || v === false || v === '' || (Array.isArray(v) && !v.length)) continue;
    // (A network ban asked for but made account-only, as the account had no network on record, is worth a word.)
    if (k === 'networkAsked') { if (!d.network) out.push('<span class="dim">network block asked, but no network on record</span>'); continue; }
    if (k === 'items' && Array.isArray(v) && v.every((x) => x?.name)) out.push(esc(v.slice(0, 3).map((x) => `${x.n > 1 ? x.n + '× ' : ''}${x.name}`).join(', ') + (v.length > 3 ? ` +${v.length - 3} more` : '')));
    else out.push(['reason', 'msg', 'text', 'label'].includes(k) ? `“${esc(clip(v, 140))}”` : `<span class="dim">${esc(k)}:</span> ${esc(short(v, k))}`);
  }
  return out.join(' · ') || '<span class="dim">—</span>';
}
const AUDIT_SKIP = new Set(['before', 'after', 'changed', 'uids', 'bans', 'snap', 'note']);
function auditTableHtml(rows, { target = true } = {}) {
  if (!rows.length) return '<div class="empty adm-empty">Nothing yet.</div>';
  return `<div class="db-table-wrap"><table class="price-table adm-table"><thead><tr><th>When</th><th>Who</th><th>Action</th>${target ? '<th>Player</th>' : ''}<th>Details</th></tr></thead><tbody>
    ${rows.map((r) => {
      const t = r.target || (r.target_id != null ? { id: r.target_id, name: r.target_name } : null);
      return `<tr><td class="nw">${when(r.at)}</td><td class="nw">${esc(r.actor)}</td><td class="nw"><span class="chip ${actionTone(r.action)}">${esc(r.action)}</span></td>
        ${target ? `<td class="nw">${playerLink(t)}</td>` : ''}<td class="adm-detail" title="${esc(clip(JSON.stringify(r.detail ?? ''), 1500))}">${auditSummary(r.detail)}</td></tr>`;
    }).join('')}</tbody></table></div>`;
}

function drawAudit(el) {
  el.innerHTML = `<div class="toolbar adm-bar"><input class="input" type="search" data-aq placeholder="Who, player or action…" value="${esc(view.auditQ)}">
    <span class="spacer"></span><span class="muted" data-acount></span><button class="btn sm" data-refresh>Refresh</button></div><div data-alist></div>`;
  const q = el.querySelector('[data-aq]');
  q.addEventListener('input', debounce(() => { view.auditQ = q.value; view.auditPage = 0; drawAuditList(); }, 300));
  el.querySelector('[data-refresh]').addEventListener('click', () => refresh('audit', drawAuditList));
  drawAuditList();
}
function drawAuditList() {
  const el = root?.querySelector('[data-alist]');
  if (!el) return;
  const q = view.auditQ.trim(), idx = view.auditPage;
  const d = need('audit', 'audit', { ...(q ? { q } : {}), ...pageArg('audit', idx) }, el, drawAuditList);
  if (!d) return;
  notePage('audit', idx, d);
  const rows = Array.isArray(d.rows) ? d.rows : [];
  root.querySelector('[data-acount]').textContent = plural(d.total ?? rows.length, 'entry', 'entries');
  el.innerHTML = rows.length ? auditTableHtml(rows) + pagerHtml(d.total, idx) : `<div class="empty adm-empty">${q ? 'Nothing matches that.' : 'No staff actions yet.'}</div>`;
  wireOpen(el);
  wirePager(el, (i) => { view.auditPage = i; drawAuditList(); });
}

// ---- Players ---------------------------------------------------------------------------------------
function drawPlayers(el) {
  el.innerHTML = `<div class="toolbar adm-bar">
      <input class="input" type="search" data-q placeholder="Name or Discord name…" value="${esc(view.q)}">
      <div class="seg" data-filter>${FILTERS.map(([k, n]) => `<button data-v="${k}" class="${view.filter === k ? 'active' : ''}">${n}</button>`).join('')}</div>
      <span class="spacer"></span><span class="muted" data-pcount></span><button class="btn sm" data-refresh>Refresh</button>
    </div><div data-plist></div>`;
  const q = el.querySelector('[data-q]');
  q.addEventListener('input', debounce(() => { view.q = q.value; view.page = 0; drawPlayerList(); }, 300));
  el.querySelectorAll('[data-filter] button').forEach((b) => b.addEventListener('click', () => {
    view.filter = b.dataset.v;
    view.page = 0;
    el.querySelectorAll('[data-filter] button').forEach((x) => x.classList.toggle('active', x === b));
    drawPlayerList();
  }));
  el.querySelector('[data-refresh]').addEventListener('click', () => refresh('players', drawPlayerList));
  drawPlayerList();
}
function drawPlayerList() {
  const el = root?.querySelector('[data-plist]');
  if (!el) return;
  const q = view.q.trim(), idx = view.page;
  const d = need('players', 'players', { ...(q ? { q } : {}), filter: view.filter, ...pageArg('players', idx) }, el, drawPlayerList);
  if (!d) return;
  notePage('players', idx, d);
  const rows = Array.isArray(d.rows) ? d.rows : [];
  root.querySelector('[data-pcount]').textContent = plural(d.total ?? rows.length, 'player');
  if (!rows.length) { el.innerHTML = `<div class="empty adm-empty">${q ? 'No player matches that.' : 'No players here.'}</div>`; return; }
  el.innerHTML = `<div class="db-table-wrap"><table class="price-table adm-table adm-click"><thead><tr>
      <th>Player</th><th>Level</th><th class="num">Money</th><th class="num">Items</th><th class="num">Worth</th><th>Discord</th><th>Status</th><th>Last seen</th><th>Joined</th></tr></thead><tbody>
    ${rows.map((r) => `<tr data-id="${+r.id}">
      <td class="nw"><span class="adm-dot ${r.online ? 'on' : ''}" title="${r.online ? 'Online' : 'Offline'}"></span><b>${esc(r.name)}</b></td>
      <td>${profLevel(r.level)}</td><td class="num">${money(+r.money || 0)}</td><td class="num">${num(r.items)}</td><td class="num">${money(+r.worth || 0)}</td>
      <td class="nw">${r.discord ? `@${esc(r.discord.name)}` : '<span class="dim">—</span>'}</td>
      <td class="nw">${r.banned ? `<span class="chip red" ${r.banned.reason ? `title="${esc(r.banned.reason)}"` : ''}>Banned</span>` : ''}${staffChip(r.staff)}</td>
      <td class="nw">${r.online ? '<span class="green">Online now</span>' : when(r.lastSeen)}</td><td class="nw">${when(r.created)}</td></tr>`).join('')}
    </tbody></table></div>${pagerHtml(d.total, idx)}`;
  el.querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => openPlayer(+tr.dataset.id)));
  wirePager(el, (i) => { view.page = i; drawPlayerList(); });
}

// ---- a player ----------------------------------------------------------------------------------------
function drawPlayer(el) {
  el.innerHTML = `<div class="adm-back"><button class="btn ghost sm" data-back>‹ All players</button><span class="spacer"></span>
    <button class="btn sm" data-prefresh>Refresh</button></div><div data-pv></div>`;
  el.querySelector('[data-back]').addEventListener('click', () => { view.player = null; drawBody(); });
  // (They may have connected, traded or synced their configs since this was loaded.)
  el.querySelector('[data-prefresh]').addEventListener('click', () => refresh('player', drawBody));
  const pv = el.querySelector('[data-pv]');
  const p = need('player', 'player', { id: view.player }, pv, drawBody);
  if (!p) return;
  if (!p.user) { pv.innerHTML = '<div class="empty adm-empty">There is no such player.</div>'; return; }
  const ban = (p.bans || []).map(normBan).find(banActive) || (p.user.ban ? normBan(p.user.ban) : null);
  const inv = p.state?.inv || [];
  const counts = { inventory: inv.length, snapshots: (p.snapshots || []).length };
  pv.innerHTML = `${playerHeadHtml(p, ban)}
    <div class="seg adm-subtabs" data-sub>${SUBS.map(([k, n]) => `<button data-v="${k}" class="${view.sub === k ? 'active' : ''}">${n}${counts[k] ? ` <span class="adm-count">${counts[k].toLocaleString()}</span>` : ''}</button>`).join('')}</div>
    <div class="adm-subbody" data-subbody></div>`;
  pv.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => PLAYER_ACTIONS[b.dataset.act](p, b, ban)));
  wireOpen(pv.querySelector('.adm-head'));
  const sub = pv.querySelector('[data-subbody]');
  pv.querySelectorAll('[data-sub] button').forEach((b) => b.addEventListener('click', () => {
    view.sub = b.dataset.v;
    pv.querySelectorAll('[data-sub] button').forEach((x) => x.classList.toggle('active', x === b));
    SUB_DRAW[view.sub](sub, p);
  }));
  SUB_DRAW[view.sub](sub, p);
}

function playerHeadHtml(p, ban) {
  const u = p.user;
  const facts = [
    ['Account', `#${+u.id}`], ['Joined', u.created ? esc(fmtDate(u.created)) : '—'],
    ['Last seen', u.online ? '<span class="green">Online now</span>' : when(u.lastSeen)],
    ['Discord', u.discord ? `@${esc(u.discord.name)} <span class="dim">${esc(u.discord.id)}</span>` : '<span class="dim">Not linked</span>'],
  ];
  const alts = (p.alts || []).map((a) => `${playerLink(a)}${a.banned ? ' <span class="chip red">Banned</span>' : ''}`).join(', ');
  if (alts) facts.push(['Same network', alts]);
  return `<div class="panel adm-head">
    <div class="adm-head-top">
      ${avatar(u.name, 'adm-av')}
      <div class="adm-who"><h2>${esc(u.name)}${isSelf(u) ? ' <span class="dim">(you)</span>' : ''}</h2>
        <div class="adm-chips"><span class="chip ${u.online ? 'green' : ''}"><span class="adm-dot ${u.online ? 'on' : ''}"></span>${u.online ? 'Online' : 'Offline'}</span>${staffChip(u.staff)}${ban ? '<span class="chip red">Banned</span>' : ''}</div></div>
      <dl class="kv adm-facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    </div>
    ${ban ? `<div class="adm-banline"><b>Banned ${esc(untilText(ban.expires))}</b>${ban.by ? ` by ${esc(ban.by)}` : ''}${ban.network ? ' <span class="chip">Network</span>' : ''}<div>${esc(ban.reason)}</div></div>` : ''}
    <div class="actions adm-actions">${actionButtons(u, ban)}</div>
  </div>`;
}
function actionButtons(u, ban) {
  const b = [];
  if (canPunish(u) && !ban) b.push('<button class="btn danger" data-act="ban">Ban</button>');
  if (myLevel() >= 1 && ban) b.push('<button class="btn primary" data-act="unban">Unban</button>');
  if (canPunish(u)) {
    b.push(`<button class="btn" data-act="kick" ${u.online ? '' : 'disabled title="They aren\'t online"'}>Kick</button>`,
      '<button class="btn" data-act="warn">Warn</button>', '<button class="btn" data-act="signout">Sign out everywhere</button>');
  }
  if (canChange(u)) b.push('<span class="spacer"></span><button class="btn" data-act="rename">Rename</button>', '<button class="btn ghost" data-act="reset">Reset account</button>');
  if (b.length) return (isSelf(u) ? '<span class="muted">That\'s you: you can\'t punish yourself.</span>' : '') + b.join('');
  return `<span class="muted">${isSelf(u) ? "That's you: you can look, but not punish yourself." : `${esc(u.name)} is ${esc(levelName(u.staff))}, the same level as you or above: you can only look.`}</span>`;
}

// The actions in a player's header: each a window with a form or a confirmation.
const PLAYER_ACTIONS = {
  ban(p) {
    const u = p.user, admin = isAdmin();
    const m = formModal({
      title: `Ban ${esc(u.name)}`, ok: 'Ban', danger: true,
      body: `<label>Reason <small>(they see it)</small><textarea class="input" data-reason maxlength="300" rows="3" placeholder="e.g. Scamming other players in trades"></textarea></label>
        <label>Length<select class="input" data-dur>${DURATIONS.map(([v, n]) => `<option value="${v}">${n}</option>`).join('')}</select></label>
        <label data-customrow hidden>Minutes (1 to ${MAX_MINUTES.toLocaleString()})<input class="input" type="number" min="1" max="${MAX_MINUTES}" step="1" data-min></label>
        ${admin ? '<label class="check"><input type="checkbox" data-net> Also block their network (other accounts from it)</label>' : ''}
        ${admin && u.discord && net.account()?.discordBans ? `<label class="check"><input type="checkbox" data-dban> Also ban them from the Discord server (@${esc(u.discord.name)})</label>` : ''}
        ${u.online ? '<div class="muted adm-note">They are online: they are disconnected at once.</div>' : ''}`,
      submit: async ($, err) => {
        const reason = $('[data-reason]').value.trim(), dur = $('[data-dur]').value;
        if (!reason) { err('Give a reason.'); return false; }
        const args = { id: u.id, reason };
        if (dur === 'custom') {
          const n = Number($('[data-min]').value);
          if (!Number.isInteger(n) || n < 1 || n > MAX_MINUTES) { err(`Enter the minutes: a whole number from 1 to ${MAX_MINUTES.toLocaleString()}.`); return false; }
          args.minutes = n;
        } else if (dur !== 'perm') args.minutes = +dur;
        if ($('[data-net]')?.checked) args.network = true;
        if ($('[data-dban]')?.checked) args.discordBan = true;
        const r = await run(null, 'ban', args, `Banned <b>${esc(u.name)}</b> ${args.minutes ? 'for ' + durText(args.minutes) : 'permanently'}`);
        if (r) afterChange();
        return !!r;
      },
    });
    const dur = m.el.querySelector('[data-dur]');
    dur.addEventListener('change', () => { m.el.querySelector('[data-customrow]').hidden = dur.value !== 'custom'; });
  },
  unban(p, btn, ban) {
    const u = p.user;
    formModal({
      title: `Unban ${esc(u.name)}`, ok: 'Unban',
      body: `<p class="adm-p">Lift every active ban of <b>${esc(u.name)}</b>, and the network bans made with them?</p>
        ${ban ? `<div class="muted adm-note">Banned ${esc(untilText(ban.expires))}${ban.by ? ` by ${esc(ban.by)}` : ''}: ${esc(ban.reason)}</div>` : ''}
        ${isAdmin() && u.discord && net.account()?.discordBans ? `<label class="check"><input type="checkbox" data-dunban> Also unban them on the Discord server (@${esc(u.discord.name)})</label>` : ''}`,
      submit: async ($) => {
        const r = await run(null, 'unban', { id: u.id, ...($('[data-dunban]')?.checked ? { discordUnban: true } : {}) }, (x) => `Lifted ${plural(x.lifted ?? 1, 'ban')} of <b>${esc(u.name)}</b>`);
        if (r) afterChange();
        return !!r;
      },
    });
  },
  kick(p) {
    const u = p.user;
    formModal({
      title: `Kick ${esc(u.name)}`, ok: 'Kick', danger: true,
      body: `<p class="adm-p">Disconnect <b>${esc(u.name)}</b> now? They can connect again straight away.</p>
        <label>Reason <small>(optional, they see it)</small><input class="input" data-reason maxlength="300"></label>`,
      submit: async ($) => {
        const reason = $('[data-reason]').value.trim();
        const r = await run(null, 'kick', { id: u.id, ...(reason ? { reason } : {}) }, (x) => (x.kicked ? `Kicked <b>${esc(u.name)}</b>` : `<b>${esc(u.name)}</b> wasn't online`));
        if (r) afterChange();
        return !!r;
      },
    });
  },
  warn(p) {
    const u = p.user;
    formModal({
      title: `Warn ${esc(u.name)}`, ok: 'Send warning',
      body: `<label>Message <small>(shown to them in a window${u.discord ? ', and sent to their Discord' : ''})</small><textarea class="input" data-msg maxlength="500" rows="4" placeholder="e.g. Keep the chat friendly or you'll be banned."></textarea></label>`,
      submit: async ($, err) => {
        const msg = $('[data-msg]').value.trim();
        if (!msg) { err('Write the warning.'); return false; }
        const r = await run(null, 'warn', { id: u.id, msg });
        if (!r) return false;
        // (Not online and no Discord message got through: it's in the log, but they haven't seen it.)
        if (r.delivered) { sfx.coin(); toast(`Warning sent to <b>${esc(u.name)}</b>`, 'good'); }
        // (null: Discord hadn't answered the DM within a few seconds; it may still get there)
        else if (r.delivered === null) toast(`Warning saved. <b>${esc(u.name)}</b> isn't online, and Discord hasn't confirmed the message to them yet`, 'gold');
        else toast(`<b>${esc(u.name)}</b> isn't online${u.discord ? ' and their Discord messages are closed' : ''}, so the warning didn't reach them`, 'gold');
        afterChange();
        return true;
      },
    });
  },
  async signout(p, btn) {
    const u = p.user;
    if (!(await confirmDialog(`Sign <b>${esc(u.name)}</b> out everywhere? Every login of theirs stops working and they're disconnected. They can log in again with their password.`, { ok: 'Sign out everywhere', danger: true }))) return;
    if (await run(btn, 'signout', { id: u.id }, `Signed <b>${esc(u.name)}</b> out everywhere`)) afterChange();
  },
  rename(p) {
    const u = p.user;
    formModal({
      title: `Rename ${esc(u.name)}`, ok: 'Rename',
      body: `<label>New name<input class="input" data-name maxlength="20" value="${esc(u.name)}" autocomplete="off"></label>
        <div class="muted adm-note">3 to 20 letters, digits, _ or -, not taken by anyone else. They log in with the new name.</div>`,
      submit: async ($, err) => {
        const name = $('[data-name]').value.trim();
        if (!name || name === u.name) { err('Enter a new name.'); return false; }
        const r = await run(null, 'rename', { id: u.id, name }, (x) => `Renamed <b>${esc(u.name)}</b> to <b>${esc(x.name || name)}</b>`);
        if (r) afterChange();
        return !!r;
      },
    });
  },
  async reset(p, btn) {
    const u = p.user;
    if (!(await confirmDialog(`Reset <b>${esc(u.name)}</b> to a fresh account? Their money, inventory, stats, ranks and level go back to a new player's.
      An auto snapshot is saved first, so it can be restored. Their open trade offers are cancelled.`, { ok: 'Reset account', danger: true }))) return;
    if (await run(btn, 'reset', { id: u.id }, `<b>${esc(u.name)}</b> has a fresh account`)) afterChange();
  },
};

const SUB_DRAW = { overview: drawOverview, inventory: drawInventory, configs: drawConfigs, snapshots: drawSnapshots, history: drawHistory };

// ---- a player: Overview (their numbers, editable by admins) ------------------------------------------
const getPath = (o, path) => path.split('.').reduce((v, k) => v?.[k], o);
// Saved-state keys the editor makes fields of: plain names only. An admin's raw JSON can put any key in stats or a rank
// (a quote would break out of the field's attribute, a dot its path, a name every object has its label).
const plainKey = (k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !(k in Object.prototype);
const labelOf = (labels, k) => (Object.hasOwn(labels, k) ? labels[k] : k);
// The numbers `edit` can set, in groups: [title, [[path, label, kind]]] (kind: money, int or num).
function editorGroups(st) {
  const groups = [
    ['Account', [['money', 'Money', 'money'], ['stars', 'Armory Stars', 'int'], ['charmDetach', 'Charm Detachments', 'int']]],
    ['Profile', [['prof.level', 'Level (1-40)', 'int'], ['prof.xp', 'XP', 'int'], ['prof.medals', 'Service Medals', 'int']]],
    ['Stats', Object.keys(obj(st.stats)).filter((k) => plainKey(k) && typeof st.stats[k] === 'number').map((k) => [`stats.${k}`, labelOf(STAT_LABELS, k), MONEY_STATS.has(k) ? 'money' : 'num'])],
  ];
  for (const [key, title] of [['rank', 'Competitive rank'], ['wingman', 'Wingman rank']]) {
    const r = obj(st[key]);
    // (In the labels' order: the saved object's own key order is whatever the engine wrote first.)
    const keys = [...Object.keys(RANK_LABELS), ...Object.keys(r).filter((k) => plainKey(k) && !Object.hasOwn(RANK_LABELS, k))];
    groups.push([title, keys.filter((k) => typeof r[k] === 'number').map((k) => [`${key}.${k}`, labelOf(RANK_LABELS, k), 'num'])]);
  }
  return groups.filter(([, f]) => f.length);
}
function drawOverview(el, p) {
  const u = p.user, st = p.state || {}, edit = canChange(u);
  const inv = st.inv || [], invValue = inv.reduce((s, i) => s + itemValue(i), 0), s = obj(st.stats);
  const sum = [
    ['Balance', money(+st.money || 0)], ['Inventory', `${num(inv.length)} · ${money(invValue)}`], ['Net worth', money((+st.money || 0) + invValue)],
    ['Level', profLevel(st.prof?.level)], ['Cases opened', num(s.opened)], ['Matches won', `${num(s.playWins || 0)} of ${num(s.playMatches || 0)}`],
    ['Premier', st.premier ? num(st.premier.rating) : '—'],
  ];
  const field = ([path, label, kind]) => {
    const v = getPath(st, path), shown = typeof v === 'number' ? String(kind === 'money' ? Math.round(v * 100) / 100 : v) : '';
    return `<label class="adm-field"><span>${esc(label)}</span><input class="input" type="number" data-f="${esc(path)}" step="${kind === 'money' ? '0.01' : kind === 'int' ? '1' : 'any'}" value="${esc(shown)}" ${edit ? '' : 'disabled'}></label>`;
  };
  // Two stacked columns, the account and its stats beside the profile and ranks (a grid of rows would leave a gap under
  // every short panel next to the long Stats one).
  const groups = editorGroups(st), left = (t) => t === 'Account' || t === 'Stats';
  const panel = ([title, fields]) => `<div class="panel"><h3>${title}</h3><div class="adm-fields">${fields.map(field).join('')}</div></div>`;
  el.innerHTML = `<div class="summary adm-summary">${sum.map(([k, v]) => `<div>${k}<b>${v}</b></div>`).join('')}</div>
    <div class="adm-editor"><div>${groups.filter(([t]) => left(t)).map(panel).join('')}</div><div>${groups.filter(([t]) => !left(t)).map(panel).join('')}</div></div>
    <div class="actions adm-save">${edit ? `<button class="btn primary" data-save disabled>Save changes</button><button class="btn ghost" data-undo disabled>Undo changes</button>
      <span class="muted adm-note">Only what you change is sent. An auto snapshot is saved before every edit.</span><span class="spacer"></span><button class="btn" data-raw>Raw JSON</button>`
      : '<span class="muted">Moderators can see these numbers; only admins can change them.</span>'}</div>`;
  if (!edit) return;
  const inputs = [...el.querySelectorAll('[data-f]')], save = el.querySelector('[data-save]'), undo = el.querySelector('[data-undo]');
  const changed = () => inputs.filter((i) => i.value !== i.defaultValue);
  const update = () => {
    inputs.forEach((i) => i.classList.toggle('changed', i.value !== i.defaultValue));
    const n = changed().length;
    save.disabled = undo.disabled = !n;
    save.textContent = n ? `Save ${plural(n, 'change')}` : 'Save changes';
  };
  inputs.forEach((i) => i.addEventListener('input', update));
  undo.addEventListener('click', () => { inputs.forEach((i) => { i.value = i.defaultValue; }); update(); });
  save.addEventListener('click', async () => {
    const set = {};
    for (const i of changed()) {
      const v = Number(i.value);
      if (i.value.trim() === '' || !Number.isFinite(v)) { sfx.error(); toast(`${esc(i.closest('label').querySelector('span').textContent)} needs a number`, 'bad'); i.focus(); return; }
      const [a, b] = i.dataset.f.split('.');
      if (b) (set[a] ||= {})[b] = v; else set[a] = v;
    }
    const n = changed().length;
    if (await run([save, undo], 'edit', { id: u.id, set }, `Saved ${plural(n, 'change')} to <b>${esc(u.name)}</b>`)) afterChange();
  });
  el.querySelector('[data-raw]').addEventListener('click', () => rawModal(p));
}

// Every top-level part of the state but the inventory and the (offline-only) NPC world, as JSON to edit by hand.
function rawModal(p) {
  const u = p.user, restOf = (st) => { const { inv, social, ...rest } = st || {}; return rest; };
  // (The save this JSON was made from: the server refuses it when the account has changed since, a sale or a claimed
  // reward that the old copy would undo.)
  let base = p.rev;
  const m = formModal({
    title: `Raw JSON: ${esc(u.name)}`, ok: 'Save JSON', danger: true, cls: 'wide',
    body: `<div class="muted adm-note">Everything in ${esc(u.name)}'s save except the inventory and the NPC world. Keys you leave out are reset to a new account's; an auto snapshot is saved first.</div>
      <textarea class="input adm-json" data-json spellcheck="false">${esc(JSON.stringify(restOf(p.state), null, 2))}</textarea>
      <div class="adm-json-bar"><span class="muted" data-size></span><span class="spacer"></span><button class="btn ghost sm" data-fmt>Format</button></div>`,
    submit: async ($, err) => {
      let state;
      try { state = JSON.parse($('[data-json]').value); } catch (e) { err('That isn\'t valid JSON: ' + e.message); return false; }
      if (!state || typeof state !== 'object' || Array.isArray(state)) { err('The state must be a JSON object { … }.'); return false; }
      if (jsonSize(state) > MAX_JSON) { err('That is over 48 KB.'); return false; }
      if (!(await confirmDialog(`Replace <b>${esc(u.name)}</b>'s save (all but the inventory) with this JSON?`, { ok: 'Replace', danger: true }))) return false;
      const r = await run(null, 'edit.raw', { id: u.id, state, base }, `Saved <b>${esc(u.name)}</b>'s JSON`, (e) => {
        if (e.code !== 'stale') return false;
        stale(e.message);
        return true;
      });
      if (r) afterChange();
      return !!r;
    },
  });
  const ta = m.el.querySelector('[data-json]'), size = m.el.querySelector('[data-size]'), errEl = m.el.querySelector('[data-err]');
  const showSize = () => { const b = new TextEncoder().encode(ta.value).length; size.textContent = `${kb(b)} of 48 KB`; size.classList.toggle('red', b > MAX_JSON); };
  ta.addEventListener('input', showSize);
  showSize();
  // Refused as the account changed since this was opened: Reload puts their save as it is now in the box (your edits
  // there are replaced), to make the change again on.
  function stale(msg) {
    errEl.textContent = `${msg || 'The account changed since you opened it. Reload it and try again.'} `;
    const b = document.createElement('button');
    b.className = 'btn sm';
    b.textContent = 'Reload';
    b.addEventListener('click', async () => {
      const fresh = await run(b, 'player', { id: u.id });
      if (!fresh?.state || !m.el.isConnected) return;
      base = fresh.rev;
      ta.value = JSON.stringify(restOf(fresh.state), null, 2);
      showSize();
      errEl.textContent = 'Reloaded: this is their save as it is now. Make your change again, then save.';
      // (The page behind shows it too.)
      const s = store.player;
      if (s && 'data' in s && s.args === JSON.stringify({ id: u.id })) { s.data = fresh; drawBody(); }
    });
    errEl.append(b);
  }
  m.el.querySelector('[data-fmt]').addEventListener('click', () => { try { ta.value = JSON.stringify(JSON.parse(ta.value), null, 2); showSize(); } catch {} });
}

// ---- a player: Inventory -------------------------------------------------------------------------------
// Items offered in their open trades: the server won't remove those.
function reservedUids(p) {
  const s = new Set();
  for (const t of p.trades || []) if (t.status === 'open' && t.from?.id === p.user.id) for (const i of t.give?.items || []) s.add(i.uid);
  return s;
}
const INSPECTABLE = new Set(['skin', 'sticker', 'agent', 'charm']);
function drawInventory(el, p) {
  const edit = canChange(p.user), v = view.inv;
  el.innerHTML = `<div class="toolbar adm-bar">
      <input class="input" type="search" data-iq placeholder="Search items…" value="${esc(v.q)}">
      <select class="input" data-ikind>${KINDS.map(([k, n]) => `<option value="${k}" ${v.kind === k ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <select class="input" data-isort>${[['value', 'Most valuable'], ['new', 'Newest first'], ['old', 'Oldest first']].map(([k, n]) => `<option value="${k}" ${v.sort === k ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <span class="muted" data-isum></span><span class="spacer"></span>
      ${edit ? '<button class="btn danger" data-remove disabled>Remove selected</button><button class="btn primary" data-give>Give items</button>' : ''}
    </div><div data-ilist></div>`;
  const list = () => drawInvList(el, p);
  const q = el.querySelector('[data-iq]');
  q.addEventListener('input', debounce(() => { v.q = q.value; v.page = 0; list(); }, 200));
  el.querySelector('[data-ikind]').addEventListener('change', (e) => { v.kind = e.target.value; v.page = 0; list(); });
  el.querySelector('[data-isort]').addEventListener('change', (e) => { v.sort = e.target.value; v.page = 0; list(); });
  el.querySelector('[data-give]')?.addEventListener('click', () => giveModal(p));
  el.querySelector('[data-remove]')?.addEventListener('click', (e) => removeItems(p, e.currentTarget));
  list();
}
function drawInvList(el, p) {
  const box = el.querySelector('[data-ilist]');
  if (!box) return;
  const edit = canChange(p.user), v = view.inv, reserved = reservedUids(p), all = p.state?.inv || [];
  const q = v.q.trim().toLowerCase();
  let items = all.filter((i) => (v.kind === 'all' || i.t === v.kind) && (!q || itemName(i).toLowerCase().includes(q) || String(i.uid).toLowerCase() === q));
  items = v.sort === 'value' ? items.map((i) => [i, itemValue(i)]).sort((a, b) => b[1] - a[1]).map((x) => x[0])
    : items.slice().sort((a, b) => (v.sort === 'new' ? (b.at || 0) - (a.at || 0) : (a.at || 0) - (b.at || 0)));
  const pages = Math.max(1, Math.ceil(items.length / INV_PAGE));
  v.page = Math.min(v.page, pages - 1);
  const shown = items.slice(v.page * INV_PAGE, (v.page + 1) * INV_PAGE);
  el.querySelector('[data-isum]').textContent = `${plural(items.length, 'item')} · ${money(items.reduce((s, i) => s + itemValue(i), 0))}`;
  const removeBtn = el.querySelector('[data-remove]');
  const updateSel = () => {
    for (const uid of v.sel) if (!all.some((i) => i.uid === uid)) v.sel.delete(uid);
    if (removeBtn) { removeBtn.disabled = !v.sel.size; removeBtn.textContent = v.sel.size ? `Remove ${plural(v.sel.size, 'item')}` : 'Remove selected'; }
  };
  updateSel();
  if (!shown.length) { box.innerHTML = `<div class="empty adm-empty">${all.length ? 'No item matches that.' : 'Their inventory is empty.'}</div>`; return; }
  const row = (i, n) => {
    const res = reserved.has(i.uid), wk = i.t === 'skin' && i.fl != null ? wearOf(i.fl) : null;
    const tags = [i.stt && '<span class="tag st">ST™</span>', i.sv && '<span class="tag sv">Souvenir</span>', i.lk && '<span class="tag lock" title="Locked">🔒</span>',
      i.sn && `<span class="tag sn" title="Serial number">#${+i.sn}</span>`, i.kc && '<span class="tag" title="A charm is attached">Charm</span>',
      i.stk?.length && `<span class="tag" title="Stickers">${+i.stk.length} stk</span>`, res && '<span class="tag pat" title="In an open trade offer">In trade</span>'].filter(Boolean).join('');
    return `<tr style="--rc:${esc(itemColor(i))}" class="${v.sel.has(i.uid) ? 'sel' : ''}">
      ${edit ? `<td class="cb"><input type="checkbox" data-uid="${esc(i.uid)}" ${v.sel.has(i.uid) ? 'checked' : ''} ${res ? 'disabled title="In an open trade offer"' : ''}></td>` : ''}
      <td class="adm-thumb"><img loading="lazy" src="${esc(itemImg(i))}" alt=""></td>
      <td><div class="adm-iname ${i.stt ? 'stt' : i.sv ? 'sv' : ''}">${esc(itemName(i))}</div><div class="adm-uid">${esc(i.uid)}</div></td>
      <td class="nw">${wk ? `<b class="wk" style="--wc:${WEAR_BY_KEY[wk].c}">${wk}</b>${(+i.fl).toFixed(6)}` : '<span class="dim">—</span>'}</td>
      <td class="nw">${i.sd != null ? +i.sd : i.pat != null ? '#' + (+i.pat) : '<span class="dim">—</span>'}</td>
      <td class="num green">${money(itemValue(i))}</td><td class="adm-tags">${tags}</td>
      <td class="adm-src" title="${esc(i.src || '')}">${esc(clip(i.src || '—', 32))}</td><td class="nw">${when(i.at)}</td>
      <td>${INSPECTABLE.has(i.t) ? `<button class="btn ghost sm" data-insp="${n}">Inspect</button>` : ''}</td></tr>`;
  };
  box.innerHTML = `<div class="db-table-wrap"><table class="price-table adm-table adm-inv"><thead><tr>
      ${edit ? '<th class="cb"><input type="checkbox" data-iall title="Select this page"></th>' : ''}<th></th><th>Item</th><th>Float</th><th>Seed</th><th class="num">Value</th><th>Tags</th><th>From</th><th>Got</th><th></th></tr></thead>
    <tbody>${shown.map(row).join('')}</tbody></table></div>${pagerHtml(items.length, v.page, INV_PAGE)}`;
  box.querySelectorAll('[data-uid]').forEach((c) => c.addEventListener('change', () => {
    if (c.checked) v.sel.add(c.dataset.uid); else v.sel.delete(c.dataset.uid);
    c.closest('tr').classList.toggle('sel', c.checked);
    updateSel();
  }));
  box.querySelector('[data-iall]')?.addEventListener('change', (e) => {
    box.querySelectorAll('[data-uid]:not(:disabled)').forEach((c) => { c.checked = e.target.checked; c.dispatchEvent(new Event('change')); });
  });
  box.querySelectorAll('[data-insp]').forEach((b) => b.addEventListener('click', () => {
    try { openInspect(shown[+b.dataset.insp]); } catch (e) { toast(esc(e.message), 'bad'); }
  }));
  wirePager(box, (i) => { v.page = i; drawInvList(el, p); });
}
async function removeItems(p, btn) {
  const u = p.user, sel = view.inv.sel, items = (p.state?.inv || []).filter((i) => sel.has(i.uid));
  if (!items.length) return;
  const worth = items.reduce((s, i) => s + itemValue(i), 0);
  const what = items.length === 1 ? `<b>${esc(itemName(items[0]))}</b>` : `<b>${plural(items.length, 'item')}</b>`;
  if (!(await confirmDialog(`Remove ${what} (worth ${money(worth)}) from <b>${esc(u.name)}</b>'s inventory? An auto snapshot is saved first.`, { ok: 'Remove', danger: true }))) return;
  const r = await run(btn, 'items.remove', { id: u.id, uids: items.map((i) => i.uid) }, (x) => `Removed ${plural(x.removed ?? items.length, 'item')} from <b>${esc(u.name)}</b>`);
  if (r) { sel.clear(); afterChange(); }
}

// Every item of a kind in the game data, as { id, n, item } (item: a stand-in for the picture and the price).
const giveLists = {};
function giveList(kind) {
  if (giveLists[kind]) return giveLists[kind];
  const mk = (id, n, item) => ({ id, n: n || id, lc: String(n || id).toLowerCase(), item });
  let list = [];
  if (kind === 'skin') list = Object.entries(D.skins).map(([id, d]) => mk(id, d.n, { t: 'skin', id, fl: d.v ? null : Math.min(d.mx, Math.max(d.mn, 0.1)), sd: 0, stk: [] }));
  if (kind === 'crate') list = D.cases.map((c) => mk(c.id, c.n, { t: 'crate', id: c.id }));
  if (kind === 'key') list = Object.entries(D.keys).map(([id, k]) => mk(id, k.n, { t: 'key', id }));
  if (kind === 'sticker') list = Object.entries(D.stickers).map(([id, d]) => mk(id, d.n, { t: 'sticker', id }));
  if (kind === 'agent') list = Object.entries(D.agents).map(([id, d]) => mk(id, d.n, { t: 'agent', id }));
  if (kind === 'charm') list = Object.entries(D.charms || {}).map(([id, d]) => mk(id, d.n, { t: 'charm', id, pat: 50000 }));
  return (giveLists[kind] = list.sort((a, b) => a.n.localeCompare(b.n)));
}
function giveModal(p) {
  const u = p.user;
  let kind = 'skin', pick = null;
  const m = formModal({
    title: `Give items to ${esc(u.name)}`, ok: 'Give', cls: 'wide',
    body: `<div class="adm-give">
      <div class="adm-give-pick">
        <div class="toolbar adm-bar"><select class="input" data-gkind>${GIVE_KINDS.map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select>
          <input class="input" type="search" data-gq placeholder="Search the game's items…"></div>
        <div class="adm-give-list" data-glist></div><div class="muted adm-note" data-gmore></div>
      </div>
      <div class="adm-give-side">
        <div data-gprev class="adm-give-prev"><div class="muted">Pick an item on the left.</div></div>
        <label>How many (1-100)<input class="input" type="number" min="1" max="100" step="1" value="1" data-gn></label>
        <div data-gskin class="adm-form">
          <label>Float <small>(empty: random)</small><input class="input" type="number" min="0" max="1" step="0.0001" data-gfl placeholder="random"></label>
          <label>Pattern seed <small>(0-1000, empty: random)</small><input class="input" type="number" min="0" max="1000" step="1" data-gsd placeholder="random"></label>
          <label class="check"><input type="checkbox" data-gstt> StatTrak™</label>
          <label class="check"><input type="checkbox" data-gsv> Souvenir</label>
        </div>
        <div data-gcharm class="adm-form" hidden><label>Pattern <small>(1-100000, empty: random)</small><input class="input" type="number" min="1" max="100000" step="1" data-gpat placeholder="random"></label></div>
        <div class="muted adm-note">Items come with “Admin” as their source and count toward the inventory limit.</div>
      </div></div>`,
    submit: async ($, err) => {
      if (!pick) { err('Pick an item first.'); return false; }
      const n = Number($('[data-gn]').value);
      if (!Number.isInteger(n) || n < 1 || n > 100) { err('How many: a whole number from 1 to 100.'); return false; }
      const entry = { t: kind, id: pick.id, n };
      if (kind === 'skin') {
        // (A vanilla knife has no float or seed: its fields are off, and anything typed there for another skin is left out.)
        const d = D.skins[pick.id], fl = d.v ? '' : $('[data-gfl]').value.trim(), sd = d.v ? '' : $('[data-gsd]').value.trim();
        if (fl !== '') { const f = Number(fl); if (!(f >= d.mn && f <= d.mx)) { err(`The float is a number from ${d.mn} to ${d.mx} for this skin.`); return false; } entry.fl = f; }
        if (sd !== '') { const s = Number(sd); if (!Number.isInteger(s) || s < 0 || s > 1000) { err('The seed is a whole number from 0 to 1000.'); return false; } entry.sd = s; }
        if ($('[data-gstt]').checked) entry.stt = true;
        if ($('[data-gsv]').checked) entry.sv = true;
        if (entry.stt && entry.sv) { err("A skin can't be StatTrak™ and Souvenir at once."); return false; }
      }
      if (kind === 'charm' && $('[data-gpat]').value.trim() !== '') {
        const pt = Number($('[data-gpat]').value);
        if (!Number.isInteger(pt) || pt < 1 || pt > 100000) { err('The pattern is a whole number from 1 to 100000.'); return false; }
        entry.pat = pt;
      }
      const r = await run(null, 'items.give', { id: u.id, items: [entry] }, (x) => `Gave <b>${esc(u.name)}</b> ${num(x.added ?? n)}× ${esc(pick.n)}`);
      if (r) afterChange();
      return !!r;
    },
  });
  const $ = (s) => m.el.querySelector(s);
  const drawList = () => {
    const q = $('[data-gq]').value.trim().toLowerCase(), all = giveList(kind);
    const hits = q ? all.filter((x) => x.lc.includes(q)) : all;
    const shown = hits.slice(0, 80);
    $('[data-glist]').innerHTML = shown.length ? shown.map((x, i) => `<button type="button" class="adm-gi ${pick?.id === x.id ? 'on' : ''}" data-gi="${i}" style="--rc:${esc(itemColor(x.item))}">
        <img loading="lazy" src="${esc(itemImg(x.item))}" alt=""><span>${esc(x.n)}</span><b>${money(itemValue(x.item))}</b></button>`).join('')
      : '<div class="empty adm-empty">Nothing matches that.</div>';
    $('[data-gmore]').textContent = hits.length > shown.length ? `Showing ${shown.length} of ${hits.length.toLocaleString()}: search to narrow it down.` : '';
    $('[data-glist]').querySelectorAll('[data-gi]').forEach((b) => b.addEventListener('click', () => { pick = shown[+b.dataset.gi]; drawList(); drawPick(); }));
  };
  const drawPick = () => {
    const d = pick && kind === 'skin' ? D.skins[pick.id] : null;
    $('[data-gprev]').innerHTML = pick ? `<div class="adm-give-card" style="--rc:${esc(itemColor(pick.item))}"><img src="${esc(safe((i) => I.itemImage(i, 'm'), '')(pick.item))}" alt="">
      <b>${esc(pick.n)}</b><span class="green">${money(itemValue(pick.item))}</span></div>` : '<div class="muted">Pick an item on the left.</div>';
    $('[data-gskin]').hidden = kind !== 'skin';
    $('[data-gcharm]').hidden = kind !== 'charm';
    // (Vanilla knives have no float or seed; StatTrak™ and Souvenir only where the skin has them, as the server checks.)
    const fl = $('[data-gfl]'), sd = $('[data-gsd]');
    fl.disabled = sd.disabled = !!d?.v;
    if (d?.v) fl.value = sd.value = '';
    fl.min = d ? d.mn : 0;
    fl.max = d ? d.mx : 1;
    fl.placeholder = d && !d.v ? `random (${d.mn}-${d.mx})` : 'random';
    for (const [sel, ok] of [['[data-gstt]', !d || (d.stt && d.cat !== 'gloves')], ['[data-gsv]', !d || d.svp != null]]) {
      $(sel).disabled = !ok;
      if (!ok) $(sel).checked = false;
    }
  };
  $('[data-gkind]').addEventListener('change', (e) => { kind = e.target.value; pick = null; drawList(); drawPick(); });
  $('[data-gq]').addEventListener('input', debounce(drawList, 150));
  drawList();
  drawPick();
  $('[data-gq]').focus();
}

// ---- a player: Configs (what their game synced) ------------------------------------------------------------
const HEX = /^#[0-9a-f]{3,8}$/i;
const clampN = (v, a, b, d) => (Number.isFinite(+v) ? Math.min(b, Math.max(a, +v)) : d);
const yesNo = (v) => (v == null ? '<span class="dim">—</span>' : v ? 'Yes' : 'No');
function valHtml(v) {
  if (v == null) return '<span class="dim">—</span>';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') return `<span class="fair">${esc(clip(JSON.stringify(v), 90))}</span>`;
  return esc(clip(v, 90));
}
// What Play's settings offer (play-settings.js, and the lobby's sensitivity box). A synced config can hold anything:
// it's shown as it is, in red outside these, and using it takes only these (a number clamped into its range).
const FPS_CAPS = [0, 60, 120, 144, 240, 300, 400];
const RANGES = {
  sensitivity: [0.05, 20], musicVolume: [0, 1], voiceVolume: [0, 1], renderScale: [0.5, 1],
  crosshair: { size: [1, 14], gap: [-3, 10], thickness: [1, 5] }, viewmodel: { fov: [54, 68], x: [-2.5, 2.5], y: [-2, 2], z: [-2, 2] },
};
const pct = (v) => `${Math.round(v * 100)}%`;
function rangeHtml(v, [lo, hi], fmt = (x) => esc(String(x))) {
  if (v == null) return '<span class="dim">—</span>';
  if (typeof v === 'number' && v >= lo && v <= hi) return fmt(v);
  return `<span class="red" title="Not what the settings offer (${lo} to ${hi})">${typeof v === 'number' ? fmt(v) : valHtml(v)}</span>`;
}
function fpsHtml(v) {
  if (v == null) return '<span class="dim">—</span>';
  if (FPS_CAPS.includes(v)) return v ? num(v) : 'Monitor';
  return `<span class="red" title="Not one of the settings' frame rate caps">${valHtml(v)}</span>`;
}
// Their crosshair drawn from their numbers (checked: these come from another player's game).
function xhairHtml(x) {
  const c = HEX.test(x.color) ? x.color : '#32fa32', len = clampN(x.size, 1, 20, 6), th = clampN(x.thickness, 1, 6, 2), gap = clampN(x.gap, -5, 12, 3);
  const look = `background:${c};box-shadow:${x.outline === false ? 'none' : '0 0 0 1px rgba(0,0,0,.7)'}`;
  const lines = [`left:${-th / 2}px;top:${-gap - len}px;width:${th}px;height:${len}px`, `left:${-th / 2}px;top:${gap}px;width:${th}px;height:${len}px`,
    `top:${-th / 2}px;left:${-gap - len}px;height:${th}px;width:${len}px`, `top:${-th / 2}px;left:${gap}px;height:${th}px;width:${len}px`];
  if (x.dot) lines.push(`left:${-th / 2}px;top:${-th / 2}px;width:${th}px;height:${th}px`);
  return `<span class="adm-xhair"><span>${lines.map((s) => `<i style="${s};${look}"></i>`).join('')}</span></span>`;
}
function playMainHtml(pl) {
  const x = obj(pl.crosshair), vm = obj(pl.viewmodel), color = HEX.test(x.color) ? x.color : null, xr = RANGES.crosshair, vr = RANGES.viewmodel;
  const rows = [
    ['Sensitivity', rangeHtml(pl.sensitivity, RANGES.sensitivity)],
    ['Crosshair', `<span class="adm-xrow">${xhairHtml(x)}<span>${esc(x.style || 'classic')} · length ${rangeHtml(x.size, xr.size)} · gap ${rangeHtml(x.gap, xr.gap)} · thickness ${rangeHtml(x.thickness, xr.thickness)}${x.outline ? ' · outline' : ''}${x.dot ? ' · dot' : ''}</span></span>`],
    ['Crosshair colour', color ? `<span class="adm-swatch" style="background:${color}"></span><span class="fair">${esc(color)}</span>` : '<span class="dim">—</span>'],
    ['Viewmodel', vm.fov != null ? `FOV ${rangeHtml(vm.fov, vr.fov)} · X ${rangeHtml(vm.x, vr.x)} · Y ${rangeHtml(vm.y, vr.y)} · Z ${rangeHtml(vm.z, vr.z)}` : '<span class="dim">—</span>'],
    ['Hand', pl.leftHanded ? 'Left' : 'Right'],
  ];
  return `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
}
function playVideoHtml(pl) {
  const fps = pl.showFps === false ? 'Off' : pl.showFps === 2 ? 'Frame rate and graph' : pl.showFps == null ? null : 'Frame rate';
  const rows = [
    ['Aspect ratio', valHtml(pl.aspect)], ['Scaling', valHtml(pl.aspect && pl.aspect !== 'native' ? pl.scaling : null)], ['Resolution', valHtml(pl.resolution)],
    ['Render scale', rangeHtml(pl.renderScale, RANGES.renderScale)], ['Frame rate cap', fpsHtml(pl.fpsMax)],
    ['Show fps', fps ? esc(fps) : '<span class="dim">—</span>'], ['Graphics', valHtml(pl.quality)],
    ['Music', rangeHtml(pl.musicVolume, RANGES.musicVolume, pct)], ['Radio voices', rangeHtml(pl.voiceVolume, RANGES.voiceVolume, pct)],
  ];
  return `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
}
function gameHtml(g) {
  const known = {
    volume: ['Sound volume', (v) => rangeHtml(v, [0, 1], pct)], fast: ['Fast open', yesNo], caseIntro: ['Case drop animation', (v) => yesNo(v !== false)],
    confirmSellAbove: ['Confirm sales above', (v) => money(+v || 0)], showOdds: ['Show odds', yesNo], menuBg: ['Menu background', valHtml], keepPrepared: ['Keep CS2 content prepared', yesNo],
    autoSell: ['Auto-sell', (a) => (a?.on ? `On${a.below ? ` · below ${money(+a.below || 0)}` : ''}${a.ranks?.length ? ` · ${plural(a.ranks.length, 'rarity', 'rarities')}` : ''}` : 'Off')],
  };
  // (Own keys only: a config can name one every object has, toString or __proto__.)
  const rows = Object.entries(g).map(([k, v]) => (Object.hasOwn(known, k) ? [known[k][0], known[k][1](v)] : [esc(k), valHtml(v)]));
  return rows.length ? `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>` : '<div class="muted">None synced.</div>';
}
function bindsHtml(pl) {
  // (Only no table at all is the defaults: an empty one, from unbindall, binds nothing.)
  if (pl.keybinds == null) {
    const legacy = Object.entries(obj(pl.binds));
    return `<div class="muted adm-note">CS2's default binds${legacy.length ? `, with ${plural(legacy.length, 'older per-action key')}: ${legacy.map(([a, k]) => `${esc(a)} = ${esc(k)}`).join(', ')}` : ''}.</div>`;
  }
  // The binds as using this config would take them (an entry that isn't a key and a command is left out).
  const t = cleanBinds(pl.keybinds) || {}, keys = Object.keys(t), bad = Object.keys(obj(pl.keybinds)).length - keys.length;
  const note = bad > 0 ? `<div class="muted adm-note">${plural(bad, 'entry', 'entries')} that ${bad === 1 ? "isn't a bind" : "aren't binds"} left out.</div>` : '';
  if (!keys.length) return `<div class="muted adm-note">No keys bound. Using this config keeps your own binds.</div>${note}`;
  const rows = keys.map((k) => [k, String(t[k])]).sort((a, b) => a[1].localeCompare(b[1]));
  return `<div class="adm-binds">${rows.map(([k, c]) => `<div class="adm-bind"><span class="adm-key">${esc(k.toUpperCase())}</span><span class="fair">${esc(clip(c, 60))}</span></div>`).join('')}</div>${note}`;
}
function drawConfigs(el, p) {
  const c = p.config && typeof p.config === 'object' ? p.config : null;
  if (!c) { el.innerHTML = '<div class="empty adm-empty">No configs synced yet. A player\'s game syncs its settings while they\'re online (from this version of the game on).</div>'; return; }
  const pl = obj(c.play), g = obj(c.game);
  el.innerHTML = `<div class="toolbar adm-bar"><span class="muted">Synced ${when(p.configAt)}</span><span class="spacer"></span>
      <button class="btn" data-dl>Download JSON</button>${Object.keys(pl).length ? '<button class="btn primary" data-use>Use this Play config</button>' : ''}</div>
    <div class="adm-cols">
      <div class="panel"><h3>Play: aim and crosshair</h3>${playMainHtml(pl)}</div>
      <div class="panel"><h3>Play: video and sound</h3>${playVideoHtml(pl)}</div>
      <div class="panel"><h3>Game settings</h3>${gameHtml(g)}</div>
    </div>
    <div class="section-title">Key binds</div>${bindsHtml(pl)}`;
  el.querySelector('[data-dl]').addEventListener('click', () => downloadJson(`${p.user.name}-config-${today(p.configAt || Date.now())}.json`, c));
  el.querySelector('[data-use]')?.addEventListener('click', async () => {
    if (!(await confirmDialog(`Use <b>${esc(p.user.name)}</b>'s Play settings as yours: sensitivity, crosshair, viewmodel, keys, video and sound? Your lobby choices (map, mode, bots) stay.`, { ok: 'Use their config' }))) return;
    const n = adoptPlay(pl);
    sfx.coin();
    toast(`Using <b>${esc(p.user.name)}</b>'s Play config (${plural(n, 'setting')})`, 'good');
  });
}
// Someone else's Play settings made yours: only the settings the settings panel has (not the lobby's choices), each
// one of the values it offers (a number clamped into its range: an fps_max of 0.001 would freeze your matches, a
// volume of 1000 deafen you), a colour that is a colour and binds that are binds. Anything else is left as yours.
const clampTo = ([lo, hi]) => (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined);
const oneOf = (...ok) => (v) => (ok.includes(v) ? v : undefined);
const isBool = oneOf(true, false);
const RES = new Set(Object.values(RESOLUTIONS).flat().map(([w, h]) => `${w}x${h}`));
const ADOPT = {
  sensitivity: clampTo(RANGES.sensitivity), quality: oneOf('high', 'balanced', 'performance'), leftHanded: isBool,
  crosshair: {
    style: oneOf('classic', 'static'), color: (v) => (typeof v === 'string' && HEX.test(v) ? v : undefined), outline: isBool, dot: isBool,
    size: clampTo(RANGES.crosshair.size), gap: clampTo(RANGES.crosshair.gap), thickness: clampTo(RANGES.crosshair.thickness),
  },
  viewmodel: Object.fromEntries(Object.entries(RANGES.viewmodel).map(([k, r]) => [k, clampTo(r)])),
  musicVolume: clampTo(RANGES.musicVolume), voiceVolume: clampTo(RANGES.voiceVolume), showFps: oneOf(false, true, 2), netGraph: oneOf(false, true, 2),
  renderScale: clampTo(RANGES.renderScale), fpsMax: oneOf(...FPS_CAPS), aspect: oneOf('native', ...Object.keys(ASPECTS)), scaling: oneOf('stretched', 'bars'),
  resolution: (v) => (v === 'native' || RES.has(v) ? v : undefined),
};
function cleanBinds(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return undefined;
  const out = {};
  for (const [k, c] of Object.entries(b)) if (/^[\w`'[\]\\,./;=-]{1,16}$/.test(k) && typeof c === 'string' && c.length <= 64 && !/[<>"]/.test(c)) out[k] = c;
  return out;
}
function adoptPlay(theirs) {
  const mine = playPrefs(), next = { ...mine };
  let n = 0;
  for (const [k, v] of Object.entries(theirs)) {
    let out;
    if (k === 'keybinds') {
      // (null: CS2's defaults. A table that binds nothing, or nothing valid, would leave you no keys at all: yours stay.)
      out = v === null ? null : cleanBinds(v);
      if (out && !Object.keys(out).length) out = undefined;
      // (Their table as their game reads it: the binds added since the version it was saved at.)
      if (out) next.bindsVersion = Math.min(BINDS_VERSION, Math.max(1, Math.floor(theirs.bindsVersion) || 1));
    } else if (k === 'binds') out = cleanBinds(v);
    else if (!Object.hasOwn(ADOPT, k)) continue;
    else if (typeof ADOPT[k] === 'object') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      out = { ...obj(mine[k]) };
      for (const [kk, vv] of Object.entries(v)) { const x = Object.hasOwn(ADOPT[k], kk) ? ADOPT[k][kk](vv) : undefined; if (x !== undefined) out[kk] = x; }
    } else out = ADOPT[k](v);
    if (out === undefined) continue;
    next[k] = out;
    n++;
  }
  savePlayPrefs(next);
  return n;
}

// ---- a player: Snapshots ------------------------------------------------------------------------------------
function drawSnapshots(el, p) {
  const u = p.user, edit = canChange(u), snaps = p.snapshots || [];
  el.innerHTML = `<div class="toolbar adm-bar"><input class="input adm-label" data-label maxlength="80" placeholder="Label, e.g. Before the trade dispute">
      <button class="btn primary" data-snap>Save snapshot</button><span class="spacer"></span>
      <span class="muted">Auto snapshots are saved before every edit, restore and reset (the newest 20 are kept).</span></div>
    ${snaps.length ? `<div class="db-table-wrap"><table class="price-table adm-table"><thead><tr><th>Label</th><th>Kind</th><th>By</th><th>When</th><th class="num">Size</th><th></th></tr></thead><tbody>
      ${snaps.map((s, i) => `<tr><td><b>${esc(s.label)}</b></td><td><span class="chip ${s.kind === 'auto' ? '' : 'gold'}">${s.kind === 'auto' ? 'Auto' : 'Manual'}</span></td>
        <td class="nw">${esc(s.by)}</td><td class="nw">${esc(fmtDate(s.created))} <span class="dim">· ${when(s.created)}</span></td><td class="num">${kb(s.size)}</td>
        <td class="nw adm-rowbtns"><button class="btn ghost sm" data-sdl="${i}">Download JSON</button>${edit ? `<button class="btn sm" data-srestore="${i}">Restore</button><button class="btn ghost sm" data-sdel="${i}">Delete</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty adm-empty">No snapshots of this account yet.</div>'}`;
  const label = el.querySelector('[data-label]'), btn = el.querySelector('[data-snap]');
  // (Without a label the server names it "Saved by <you>".)
  const save = async () => {
    if (btn.disabled) return; // (Enter, or a held Enter's repeats, while one is being saved)
    if (await run(btn, 'snapshot.save', { id: u.id, label: label.value.trim() }, `Saved a snapshot of <b>${esc(u.name)}</b>`)) afterChange();
  };
  btn.addEventListener('click', save);
  label.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  el.querySelectorAll('[data-sdl]').forEach((b) => b.addEventListener('click', async () => {
    const s = snaps[+b.dataset.sdl], r = await run(b, 'snapshot.get', { snap: s.id });
    if (r) downloadJson(`${u.name}-${s.label}-${today(s.created)}.json`, r);
  }));
  el.querySelectorAll('[data-srestore]').forEach((b) => b.addEventListener('click', async () => {
    const s = snaps[+b.dataset.srestore];
    if (!(await confirmDialog(`Restore <b>${esc(u.name)}</b> to “${esc(s.label)}” from ${esc(fmtDate(s.created))}? Their current save is replaced (an auto snapshot of it is saved first) and their open trade offers are cancelled.
      Items they've traded or sold to someone since are left out.`, { ok: 'Restore', danger: true }))) return;
    const r = await run(b, 'snapshot.restore', { snap: s.id }, (x) => (x.dropped ? `Restored <b>${esc(u.name)}</b>. Left out: ${[x.dropped - (x.rewards || 0) && `${plural(x.dropped - (x.rewards || 0), 'item')} now owned by someone else`, x.rewards && `${plural(x.rewards, 'level-up reward')} claimed since`].filter(Boolean).join(', ')}.` : `Restored <b>${esc(u.name)}</b>`));
    if (r) afterChange();
  }));
  el.querySelectorAll('[data-sdel]').forEach((b) => b.addEventListener('click', async () => {
    const s = snaps[+b.dataset.sdel];
    if (!(await confirmDialog(`Delete the snapshot “${esc(s.label)}”? It can't be brought back.`, { ok: 'Delete', danger: true }))) return;
    if (await run(b, 'snapshot.delete', { snap: s.id }, 'Snapshot deleted')) afterChange();
  }));
}

// ---- a player: History (bans, notes, trades, the audit log about them) ----------------------------------------
function tradeSide(side) {
  const items = side?.items || [], m = +side?.money || 0;
  const parts = [];
  if (items.length) parts.push(`${plural(items.length, 'item')} <span class="dim">(${money(items.reduce((s, i) => s + itemValue(i), 0))})</span>`);
  if (m) parts.push(`<span class="green">${money(m)}</span>`);
  return parts.join(' + ') || '<span class="dim">nothing</span>';
}
function drawHistory(el, p) {
  const u = p.user, bans = (p.bans || []).map(normBan), notes = p.notes || [], trades = p.trades || [], audit = p.audit || [];
  el.innerHTML = `<div class="adm-hist">
    <div>
      <div class="section-title">Notes <span class="adm-count">${notes.length}</span></div>
      <div class="panel adm-notes">
        <div class="adm-note-add"><textarea class="input" data-note maxlength="1000" rows="2" placeholder="A note for the staff (players never see it)…"></textarea><button class="btn primary" data-addnote>Add note</button></div>
        ${notes.length ? notes.map((n) => `<div class="adm-noterow"><div class="adm-notehead"><b>${esc(n.by ?? n.by_name ?? '')}</b> ${when(n.created)}</div><div class="adm-notetext">${esc(n.text)}</div></div>`).join('')
          : '<div class="muted adm-note">No notes yet.</div>'}
      </div>
      <div class="section-title">Bans <span class="adm-count">${bans.length}</span></div>
      ${bans.length ? `<div class="db-table-wrap"><table class="price-table adm-table"><thead><tr><th>Reason</th><th>By</th><th>When</th><th>Length</th><th>Status</th></tr></thead><tbody>
        ${bans.map((b) => `<tr><td>${esc(b.reason)}${b.network ? ' <span class="chip">Network</span>' : ''}</td><td class="nw">${esc(b.by)}</td><td class="nw">${when(b.created)}</td>
          <td class="nw">${b.expires ? esc(fmtDate(b.expires)) : 'Permanent'}</td><td class="nw">${banStatus(b)}</td></tr>`).join('')}</tbody></table></div>`
        : '<div class="muted adm-note">Never banned.</div>'}
    </div>
    <div>
      <div class="section-title">Recent trades <span class="adm-count">${trades.length}</span></div>
      ${trades.length ? `<div class="db-table-wrap"><table class="price-table adm-table"><thead><tr><th>When</th><th>With</th><th>Gave</th><th>Got</th><th>Status</th></tr></thead><tbody>
        ${trades.map((t) => {
          const out = t.from?.id === u.id, other = out ? t.to : t.from;
          return `<tr><td class="nw">${when(t.updated || t.created)}</td><td class="nw">${out ? '→' : '←'} ${playerLink(other)}</td>
            <td>${tradeSide(out ? t.give : t.get)}</td><td>${tradeSide(out ? t.get : t.give)}</td>
            <td class="nw"><span class="chip ${t.status === 'accepted' ? 'green' : t.status === 'open' ? 'gold' : ''}">${esc(t.status)}</span></td></tr>`;
        }).join('')}</tbody></table></div>` : '<div class="muted adm-note">No trades.</div>'}
      <div class="section-title">Staff actions on ${esc(u.name)} <span class="adm-count">${audit.length}</span></div>
      ${auditTableHtml(audit, { target: false })}
    </div></div>`;
  wireOpen(el);
  const note = el.querySelector('[data-note]'), add = el.querySelector('[data-addnote]');
  add.addEventListener('click', async () => {
    const text = note.value.trim();
    if (!text) { sfx.error(); toast('Write the note first', 'bad'); note.focus(); return; }
    if (await run(add, 'note.add', { id: u.id, text }, 'Note added')) afterChange();
  });
}

// ---- Bans --------------------------------------------------------------------------------------------------------
function drawBans(el) {
  el.innerHTML = `<div class="toolbar adm-bar"><div class="seg" data-bseg><button data-v="1" class="${view.bansActive ? 'active' : ''}">Active</button><button data-v="0" class="${view.bansActive ? '' : 'active'}">All</button></div>
    <span class="spacer"></span><span class="muted" data-bcount></span><button class="btn sm" data-refresh>Refresh</button></div><div data-blist></div>`;
  el.querySelectorAll('[data-bseg] button').forEach((b) => b.addEventListener('click', () => {
    view.bansActive = b.dataset.v === '1';
    el.querySelectorAll('[data-bseg] button').forEach((x) => x.classList.toggle('active', x === b));
    drawBanList();
  }));
  el.querySelector('[data-refresh]').addEventListener('click', () => refresh('bans', drawBanList));
  drawBanList();
}
function drawBanList() {
  const el = root?.querySelector('[data-blist]');
  if (!el) return;
  const d = need('bans', 'bans', { active: view.bansActive }, el, drawBanList);
  if (!d) return;
  const rows = (Array.isArray(d) ? d : Array.isArray(d.rows) ? d.rows : []).map(normBan);
  root.querySelector('[data-bcount]').textContent = plural(rows.length, 'ban');
  if (!rows.length) { el.innerHTML = `<div class="empty adm-empty">${view.bansActive ? 'Nobody is banned right now.' : 'No bans yet.'}</div>`; return; }
  el.innerHTML = `<div class="db-table-wrap"><table class="price-table adm-table"><thead><tr><th>Player</th><th>Reason</th><th>By</th><th>When</th><th>Until</th><th>Status</th><th></th></tr></thead><tbody>
    ${rows.map((b, i) => `<tr><td class="nw">${b.user ? playerLink(b.user) : ''}${b.network ? ' <span class="chip" title="Blocks the network it was made from">Network</span>' : ''}</td>
      <td class="adm-detail">${esc(b.reason)}</td><td class="nw">${esc(b.by)}</td><td class="nw">${when(b.created)}</td><td class="nw">${b.expires ? esc(fmtDate(b.expires)) : 'Permanent'}</td>
      <td class="nw">${banStatus(b)}</td><td>${b.user && banActive(b) ? `<button class="btn sm" data-unban="${i}">Unban</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div>`;
  wireOpen(el);
  el.querySelectorAll('[data-unban]').forEach((btn) => btn.addEventListener('click', async () => {
    const b = rows[+btn.dataset.unban];
    if (!(await confirmDialog(`Lift every active ban of <b>${esc(b.user.name)}</b>, and the network bans made with them?`, { ok: 'Unban' }))) return;
    if (await run(btn, 'unban', { id: b.user.id }, (x) => `Lifted ${plural(x.lifted ?? 1, 'ban')} of <b>${esc(b.user.name)}</b>`)) {
      invalidate('players', 'overview', 'player', 'audit');
      refresh('bans', drawBanList);
    }
  }));
}

// ---- Server --------------------------------------------------------------------------------------------------------
// [key, text or switch, name, what it does, placeholder]; switches are on unless set off (maintenance: off unless on).
const SERVER_ROWS = [
  ['motd', 'text', 'Message of the day', 'Shown to every player when they connect. Empty: none.', ''],
  ['maintenance', 'bool', 'Maintenance', 'Disconnects everyone who isn\'t staff and keeps them out until it\'s off.'],
  ['maintenanceMsg', 'text', 'Maintenance message', 'What players see while it\'s on.', 'The server is under maintenance. Try again later.'],
  ['registration', 'bool', 'New accounts', 'Let new players create accounts.'],
  ['trading', 'bool', 'Trading', 'Trade offers between players.'],
  ['gambling', 'bool', 'Gambling', 'Coinflips, jackpots and case battles (players can still cancel their own rounds).'],
];
function drawServer(el) {
  const s = need('settings', 'settings.get', {}, el, drawBody);
  if (!s) return;
  const ro = !isAdmin(), dis = ro ? 'disabled' : '';
  const control = ([k, type, , , ph]) => (type === 'bool'
    ? `<input type="checkbox" data-s="${k}" ${(k === 'maintenance' ? !!s[k] : s[k] !== false) ? 'checked' : ''} ${dis}>`
    : `<input class="input adm-wide" data-s="${k}" maxlength="300" placeholder="${esc(ph)}" value="${esc(s[k] || '')}" ${dis}>`);
  el.innerHTML = `<div class="adm-server">
    <div>
      <div class="section-title" style="margin-top:0">Server settings</div>
      <div class="settings adm-settings">${SERVER_ROWS.map((row) => `<div class="setting"><div>${row[2]}<p>${row[3]}</p></div>${control(row)}</div>`).join('')}</div>
      <div class="actions">${ro ? '<span class="muted">Moderators can see these; only admins can change them.</span>'
        : '<button class="btn primary" data-save disabled>Save settings</button><button class="btn ghost" data-undo disabled>Undo changes</button>'}</div>
    </div>
    <div>
      <div class="section-title" style="margin-top:0">Broadcast a message</div>
      <div class="panel adm-cast">
        <textarea class="input" data-cast maxlength="500" rows="4" placeholder="Shown to everyone online right now, e.g. Server restart in 5 minutes." ${dis}></textarea>
        <div class="adm-cast-bar"><span class="muted" data-left>0 / 500</span><span class="spacer"></span>${ro ? '<span class="muted">Only admins can broadcast.</span>' : '<button class="btn gold" data-send disabled>Send to everyone online</button>'}</div>
      </div>
    </div></div>`;
  const cast = el.querySelector('[data-cast]'), send = el.querySelector('[data-send]');
  cast.addEventListener('input', () => { el.querySelector('[data-left]').textContent = `${cast.value.length} / 500`; if (send) send.disabled = !cast.value.trim(); });
  if (ro) return;
  send.addEventListener('click', async () => {
    const msg = cast.value.trim();
    if (!msg) return;
    const r = await run(send, 'broadcast', { msg }, (x) => `Sent to ${plural(x.sent ?? 0, 'player')}`);
    if (r) { cast.value = ''; cast.dispatchEvent(new Event('input')); invalidate('audit', 'overview'); }
  });
  const inputs = [...el.querySelectorAll('[data-s]')], save = el.querySelector('[data-save]'), undo = el.querySelector('[data-undo]');
  const valueOf = (i) => (i.type === 'checkbox' ? i.checked : i.value.trim());
  const was = (i) => (i.type === 'checkbox' ? i.defaultChecked : i.defaultValue.trim());
  const changed = () => inputs.filter((i) => valueOf(i) !== was(i));
  const update = () => { inputs.forEach((i) => i.closest('.setting').classList.toggle('changed', valueOf(i) !== was(i))); save.disabled = undo.disabled = !changed().length; };
  inputs.forEach((i) => i.addEventListener(i.type === 'checkbox' ? 'change' : 'input', update));
  undo.addEventListener('click', () => { inputs.forEach((i) => { if (i.type === 'checkbox') i.checked = i.defaultChecked; else i.value = i.defaultValue; }); update(); });
  save.addEventListener('click', async () => {
    const part = Object.fromEntries(changed().map((i) => [i.dataset.s, valueOf(i)]));
    if (part.maintenance === true && !(await confirmDialog('Turn maintenance on? Everyone online who isn\'t staff is disconnected, and they can\'t connect until it\'s off.', { ok: 'Turn maintenance on', danger: true }))) return;
    const r = await run([save, undo], 'settings.set', { settings: part }, 'Server settings saved');
    if (!r) return;
    if (store.settings) store.settings.data = r;
    invalidate('overview', 'audit');
    drawBody();
  });
}
