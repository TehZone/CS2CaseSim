// Your online account beyond logging in: linking it to your Discord account (a code you paste into the bot's /link),
// resetting a forgotten password with a code from the bot's /resetpassword, your configs kept on the server, what
// the server tells you (bans, kicks, maintenance, a moderator's warning, broadcasts and the message of the day), and
// the staff accounts this PC has signed in with (they unlock the admin panel offline).
import { esc } from './util.js';
import { S } from './state.js';
import { sfx } from './audio.js';
import { toast, openModal, confirmDialog } from './ui.js';
import { online } from './backend.js';
import { net, normalizeUrl } from './net/online.js';
import { playPrefs } from './pages/play-settings.js';

export const LEVEL_NAMES = ['Player', 'Moderator', 'Admin', 'Owner'];
const fmtDate = (ts) => new Date(ts).toLocaleString();

// ---- the staff PC ---------------------------------------------------------------------------------
// Every online account seen on this PC with its staff level: { accounts: { "<server>|<name>": { level, name, server,
// at } } }. While one of them is staff (moderator or above) the admin panel works offline too, on this PC's save.
const PC = 'cs2-admin-pc';
const pcAccounts = () => {
  try {
    const a = JSON.parse(localStorage.getItem(PC) || '{}')?.accounts;
    return a && typeof a === 'object' && !Array.isArray(a) ? a : {};
  } catch { return {}; }
};
// (A role taken away locks it again: the same account seen at level 0. Another account changes nothing of this one's.
// The same account under a name it had before, renamed since, is this entry now: by the server's id for it.)
function notePc(a) {
  const me = net.me(), name = me?.name, id = me?.id ?? null, server = net.serverUrl();
  if (!a || typeof a !== 'object' || typeof name !== 'string' || !name || !server) return;
  const level = Math.max(0, Math.min(3, a.staff | 0));
  try {
    const accounts = pcAccounts(), key = `${server}|${name.toLowerCase()}`;
    if (id != null) for (const [k, e] of Object.entries(accounts)) if (k !== key && e?.server === server && e?.id === id) delete accounts[k];
    accounts[key] = { level, name, server, at: Date.now(), id };
    localStorage.setItem(PC, JSON.stringify({ accounts }));
  } catch {}
}
// The staff account that unlocks this PC (the highest level, then the latest seen), or null: { name, server, level, at }.
export function staffPc() {
  let best = null;
  for (const e of Object.values(pcAccounts())) {
    if (!e || typeof e !== 'object' || !(e.level >= 1)) continue;
    if (!best || e.level > best.level || (e.level === best.level && (+e.at || 0) > (+best.at || 0))) best = e;
  }
  return best && { name: String(best.name || ''), server: String(best.server || ''), level: Math.min(3, best.level | 0), at: +best.at || 0 };
}
// More → Admin: online, for your account's live staff level (online.js sets it); offline, on a staff PC.
function staffClass() {
  if (!online()) document.body.classList.toggle('is-staff', !!staffPc());
}

// A toast that stays longer than ui.js's (3.2 s): broadcasts and the message of the day.
function longToast(html, type, ms = 10000) {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = html;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, ms);
}

// ---- the account window's Discord section ---------------------------------------------------
function discordHtml() {
  const a = net.account();
  const staff = a?.staff >= 1 ? `<div class="acct-staff"><span class="chip gold">${LEVEL_NAMES[Math.min(3, a.staff)]}</span>
    <span class="muted">You're staff on this server.</span><span class="spacer"></span><button class="btn sm" data-admin>Open admin panel</button></div>` : '';
  if (!a) return '<div class="acct-discord"><h4>Discord</h4><div class="muted">This server doesn\'t support Discord linking.</div></div>';
  if (!a.discordOn) return `<div class="acct-discord"><h4>Discord</h4><div class="muted">This server isn't connected to Discord.</div>${staff}</div>`;
  const body = a.discord
    ? `<div class="acct-linked"><span class="acct-dc">${discordGlyph}</span><div><b>@${esc(a.discord.name)}</b><div class="muted">Linked to your Discord account.</div></div>
        <span class="spacer"></span><button class="btn ghost sm" data-unlink>Unlink</button></div>`
    : `<div class="acct-linked"><span class="acct-dc off">${discordGlyph}</span><div class="muted">Not linked. Link it to get the Linked role in the game's Discord, see your profile there and reset your password if you forget it.</div>
        <span class="spacer"></span><button class="btn primary sm" data-link>Link Discord</button></div>`;
  return `<div class="acct-discord"><h4>Discord</h4>${body}${staff}</div>`;
}
const discordGlyph = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M19.3 5.3A16.6 16.6 0 0 0 15.2 4l-.5 1a15.4 15.4 0 0 0-5.4 0L8.8 4a16.6 16.6 0 0 0-4.1 1.3C2.1 9.2 1.4 13 1.8 16.7a16.7 16.7 0 0 0 5 2.6l1.1-1.7c-.6-.2-1.2-.5-1.7-.9l.4-.3a11.9 11.9 0 0 0 10.8 0l.4.3c-.5.4-1.1.7-1.7.9l1.1 1.7a16.6 16.6 0 0 0 5-2.6c.5-4.3-.7-8-2.9-11.4zM8.7 14.5c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2zm6.6 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2z"/></svg>';

// The online account window's Discord part: `${discordSection()}` in its body, then bindDiscordSection(modal).
export const discordSection = () => `<div data-discord>${discordHtml()}</div>`;
export function bindDiscordSection(m) {
  const box = m.el.querySelector('[data-discord]');
  if (!box) return;
  const wire = () => {
    box.querySelector('[data-link]')?.addEventListener('click', () => openLinkModal());
    box.querySelector('[data-admin]')?.addEventListener('click', () => { m.close(); window.dispatchEvent(new CustomEvent('app:go', { detail: 'admin' })); });
    box.querySelector('[data-unlink]')?.addEventListener('click', async (e) => {
      const name = net.account()?.discord?.name || '';
      if (!(await confirmDialog(`Unlink your Discord account <b>@${esc(name)}</b> from this game account?`, { ok: 'Unlink', danger: true }))) return;
      e.target.disabled = true;
      try {
        await net.accountRpc('unlink');
        toast('Discord unlinked.', 'good');
      } catch (err) {
        sfx.error();
        toast(esc(err.message), 'bad');
        if (e.target.isConnected) e.target.disabled = false;
      }
    });
  };
  wire();
  // Linked or unlinked from Discord (or here) while the window is open: it shows at once.
  const off = net.on('account', () => {
    if (!box.isConnected) return off();
    box.innerHTML = discordHtml();
    wire();
  });
}

// ---- linking: a code shown here, pasted into /link in the game's Discord ---------------------
const pretty = (code) => { const c = String(code || '').replace(/[^0-9a-z]/gi, '').toUpperCase(); return c.length === 6 ? c.slice(0, 3) + '-' + c.slice(3) : c; };
const clock = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export function openLinkModal() {
  let timer = null, code = null, closing = null;
  const m = openModal({
    title: 'Link Discord',
    body: '<div class="link-box" data-box><div class="muted">Getting a code…</div></div>',
    foot: '<button class="btn ghost" data-close>Close</button>',
    onClose: () => { clearInterval(timer); clearTimeout(closing); off(); },
  });
  const box = m.el.querySelector('[data-box]');
  const off = net.on('account', (a) => {
    if (!a?.discord || closing) return;
    clearInterval(timer);
    sfx.coin();
    box.innerHTML = `<div class="link-done"><span class="acct-dc">${discordGlyph}</span><div><b>Linked to @${esc(a.discord.name)}</b>
      <div class="muted">Your game account and your Discord account are linked.</div></div></div>`;
    closing = setTimeout(() => m.close(), 2200);
  });
  const tick = () => {
    const el = box.querySelector('[data-left]');
    if (!el || !code) return;
    const left = code.expires - net.serverNow();
    if (left > 0) { el.textContent = `Expires in ${clock(left)}`; return; }
    clearInterval(timer);
    box.querySelector('.link-code')?.classList.add('expired');
    el.innerHTML = 'This code has expired. <button class="btn sm" data-new>New code</button>';
    el.querySelector('[data-new]').addEventListener('click', load);
    box.querySelector('[data-copy]')?.setAttribute('disabled', '');
  };
  async function load() {
    clearInterval(timer);
    box.innerHTML = '<div class="muted">Getting a code…</div>';
    try {
      const r = await net.accountRpc('link.code');
      code = { text: pretty(r.code), expires: +r.expires || net.serverNow() + 10 * 60 * 1000 };
    } catch (e) {
      if (!m.el.isConnected) return;
      box.innerHTML = `<div class="err">${esc(e.message)}</div><button class="btn sm" data-new style="margin-top:10px">Try again</button>`;
      box.querySelector('[data-new]').addEventListener('click', load);
      return;
    }
    if (!m.el.isConnected) return;
    box.innerHTML = `<div class="link-code fair" data-code>${esc(code.text)}</div>
      <div class="link-meta"><span data-left></span><span class="spacer"></span><button class="btn sm" data-copy>Copy /link command</button></div>
      <ol class="link-steps">
        <li>Open the game's Discord server.</li>
        <li>Type <span class="fair">/link</span> and paste the code.</li>
        <li>Press <b>Link</b> on the bot's reply.</li>
      </ol>
      <div class="muted" style="font-size:12px">Only you can see the bot's reply. This window closes by itself once you're linked.</div>`;
    box.querySelector('[data-copy]').addEventListener('click', async (e) => {
      try {
        await navigator.clipboard.writeText('/link code:' + code.text);
        e.target.textContent = 'Copied';
        setTimeout(() => { if (e.target.isConnected) e.target.textContent = 'Copy /link command'; }, 1500);
      } catch { toast('Could not copy. Type the code by hand.', 'bad'); }
    });
    tick();
    timer = setInterval(tick, 1000);
  }
  load();
}

// ---- a forgotten password: a reset code from /resetpassword in the Discord -------------------
// Opened from the login window; onDone(name) once the new password is set (so the login window can fill the name in).
export function openResetModal({ url = net.serverUrl(), name = '', onDone } = {}) {
  const m = openModal({
    title: 'Forgot password',
    body: `<div class="auth">
      <div class="muted" style="font-size:13px;line-height:1.5">If your account is linked to Discord, type <span class="fair">/resetpassword</span> in the game's Discord server.
        The bot replies with a reset code only you can see (it works for 15 minutes).</div>
      <label>Server address<input class="input" data-url value="${esc(url)}" placeholder="e.g. my-cs2-server.onrender.com"></label>
      <label>Username<input class="input" data-name maxlength="20" autocomplete="username" value="${esc(name)}"></label>
      <label>Reset code<input class="input fair-input" data-code maxlength="12" placeholder="XXXX-XXXX" autocomplete="one-time-code"></label>
      <label>New password<input class="input" data-pass type="password" autocomplete="new-password"></label>
      <div class="err" data-err></div>
    </div>`,
    foot: '<button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-ok>Set new password</button>',
  });
  const $m = (s) => m.el.querySelector(s);
  const err = $m('[data-err]'), ok = $m('[data-ok]');
  const submit = async () => {
    const u = normalizeUrl($m('[data-url]').value), n = $m('[data-name]').value.trim(), code = $m('[data-code]').value.trim(), pass = $m('[data-pass]').value;
    if (!u) return (err.textContent = 'Enter the server address.');
    if (!n || !code || !pass) return (err.textContent = 'Enter your username, the reset code and a new password.');
    net.setServerUrl(u);
    err.textContent = '';
    ok.disabled = true;
    try {
      await net.resetPassword(n, code, pass);
      sfx.coin();
      toast('Password changed. Log in with it.', 'good');
      m.close();
      onDone?.(n);
    } catch (e) {
      err.textContent = e.message;
      ok.disabled = false;
    }
  };
  ok.addEventListener('click', submit);
  $m('[data-pass]').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  ($m('[data-name]').value ? $m('[data-code]') : $m('[data-name]')).focus();
}

// ---- configs kept on the server -------------------------------------------------------------
// While online, your game settings and Play settings are saved to your account (staff can see them, and you get them
// back from a snapshot): every 10 s when they've changed, and once right after connecting.
let lastSent = '', sending = false;
async function syncConfig() {
  if (net.status() !== 'online' || sending) return;
  let config, json;
  try {
    config = { game: S.settings, play: playPrefs() };
    json = JSON.stringify(config);
  } catch { return; }
  if (json === lastSent) return;
  lastSent = json;
  sending = true;
  try { await net.accountRpc('config.save', { config }); } catch {} finally { sending = false; }
}

// ---- what the server tells you ----------------------------------------------------------------
function fatalModal({ code, error, ban }) {
  sfx.error();
  if (code === 'banned') {
    const b = ban || {};
    openModal({
      title: 'Banned from this server', cls: 'fatal-modal',
      body: `<div class="fatal-box bad">
        <div class="fatal-reason">${esc(b.reason || error || 'No reason given')}</div>
        <dl class="kv"><dt>Length</dt><dd>${b.expires ? `Until ${esc(fmtDate(b.expires))}` : 'Permanently'}</dd>${b.by ? `<dt>By</dt><dd>${esc(b.by)}</dd>` : ''}</dl>
        <div class="muted" style="font-size:12px">You're back on your offline save. If you think this is a mistake, ask the moderators in the game's Discord.</div></div>`,
      foot: '<button class="btn" data-close>OK</button>',
    });
  } else if (code === 'kicked') {
    // (The server's text starts with the title: "Disconnected by a moderator: <reason>".)
    const reason = String(error || '').replace(/^Disconnected by a moderator:?\s*/i, '');
    const m = openModal({
      title: 'Disconnected by a moderator', cls: 'fatal-modal',
      body: `<div class="fatal-box"><div class="fatal-reason">${reason ? esc(reason) : 'No reason given.'}</div>
        <div class="muted" style="font-size:12px">You're back on your offline save. You can reconnect now.</div></div>`,
      foot: '<button class="btn ghost" data-close>Stay offline</button><button class="btn primary" data-re>Reconnect</button>',
    });
    m.el.querySelector('[data-re]').addEventListener('click', () => { m.close(); net.resume(); });
  } else {
    openModal({
      title: 'Server maintenance', cls: 'fatal-modal',
      body: `<div class="fatal-box gold"><div class="fatal-reason">${esc(error || 'The server is under maintenance. Try again later.')}</div>
        <div class="muted" style="font-size:12px">You're back on your offline save. Log in again once it's over.</div></div>`,
      foot: '<button class="btn" data-close>OK</button>',
    });
  }
}

function adminMessage({ kind, msg, from }) {
  if (kind === 'warn') {
    sfx.error();
    openModal({
      title: 'Warning from a moderator', cls: 'fatal-modal',
      body: `<div class="fatal-box gold"><div class="fatal-reason">${esc(msg)}</div>${from ? `<div class="muted" style="font-size:12px">From ${esc(from)}</div>` : ''}</div>`,
      foot: '<button class="btn primary" data-close>I understand</button>',
    });
  } else {
    sfx.matchReady();
    longToast(`<b>${from ? esc(from) : 'Server'}:</b> ${esc(msg)}`, 'gold');
  }
}

// Called once at boot (main.js).
export function initAccount() {
  net.on('fatal', fatalModal);
  net.on('admin.msg', adminMessage);
  // (Your account as the welcome, a push or accountRpc('info') tells it; null when you leave.)
  net.on('account', (a) => { notePc(a); staffClass(); });
  staffClass();
  let shownMotd = '';
  net.on('status', ({ status }) => {
    // (Leaving takes is-staff off with the account: offline it's this PC's again.)
    if (status === 'offline') { shownMotd = ''; lastSent = ''; staffClass(); return; }
    if (status !== 'online') return;
    // The message of the day once per login (not again on a reconnect, unless it changed).
    const motd = net.motd();
    if (motd && motd !== shownMotd) longToast(esc(motd), 'gold', 8000);
    shownMotd = motd;
    lastSent = '';
    syncConfig();
  });
  setInterval(syncConfig, 10000);
}
