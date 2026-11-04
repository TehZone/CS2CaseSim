// Updates as the player sees them. The game looks for a newer release at launch and every few hours (shared/updater.cjs
// does the looking, the download and the swap): the window offers it, and saying no warns that online play stops until
// you update. Offline play carries on, an Update button stays at the top right, and the offer comes back at the next
// check. The real lock is on the server (server/release.mjs): when it refuses this game, updateRequired explains why.
import { esc } from './util.js';
import { sfx } from './audio.js';
import { toast, openModal, topModal } from './ui.js';
import { saveSync } from './state.js';
import { net } from './net/online.js';

const CHECK_EVERY = 4 * 3600 * 1000;
const ANSWERED_MS = 60000;
const LOCKED = 'You can\'t play online with other players until you update. Your offline save still works.';
const native = window.native;
const canCheck = !!native?.updateCheck;
let release = null; // the newer release found: { version, current, notes, size, install }
let win = null; // the update window, while it's open
let phase = 'offer'; // what the window is doing: offer, download, install
let held = false; // an offer waiting for the player to be free
let saidNo = 0; // when the player last said Not now

const mb = (n) => `${(n / 1048576).toFixed(n < 1048576 * 10 ? 1 : 0)} MB`;
// (Never over a match, an inspect or another window: it waits until they're done.)
const free = () => !document.querySelector('.play-canvas, .inspect') && !topModal();

function showButton() {
  let b = document.getElementById('update-btn');
  if (!release) return b?.remove();
  if (!b) {
    b = document.createElement('button');
    b.id = 'update-btn';
    b.className = 'btn primary sm';
    b.textContent = 'Update';
    b.addEventListener('click', () => openWindow());
    document.querySelector('.top-right')?.prepend(b);
  }
  b.dataset.tip = `Version ${release.version} is out`;
}

async function check() {
  const r = await native.updateCheck().catch(() => null);
  if (r?.available) release = r;
  else if (r?.reason === 'up to date') release = null;
  else return false; // (offline, GitHub down...: nothing changes, and nothing is shown)
  showButton();
  return !!release;
}

async function checkAndOffer() {
  if (!(await check()) || win || held) return;
  held = true;
  const wait = setInterval(() => {
    if (!free()) return;
    clearInterval(wait);
    held = false;
    if (release && Date.now() - saidNo > ANSWERED_MS) openWindow();
  }, 1000);
}

function openWindow({ locked = false, go = false } = {}) {
  if (!release) return;
  if (win) {
    if (locked) win.el.querySelector('[data-locked]').hidden = false;
    return;
  }
  phase = 'offer';
  const r = release;
  const m = win = openModal({
    title: 'Update available', cls: 'update-modal',
    body: `<div class="upd">
      <div class="fatal-box gold" data-locked ${locked ? '' : 'hidden'}><div class="fatal-reason">${LOCKED}</div></div>
      <div class="upd-version"><b>Version ${esc(r.version)}</b><span class="muted">You have ${esc(r.current)}</span><span class="spacer"></span>${r.size ? `<span class="muted">${mb(r.size)}</span>` : ''}</div>
      ${r.notes ? `<div class="upd-notes">${esc(r.notes)}</div>` : ''}
      <div class="upd-progress" data-progress hidden><div class="upd-bar"><i data-bar></i></div><div class="muted" data-status></div></div>
      <div class="err" data-err></div>
    </div>`,
    foot: `<button class="btn" data-page hidden>Download page</button><span class="spacer"></span><button class="btn ghost" data-close>Not now</button><button class="btn primary" data-go>Update</button>`,
    onClose: () => {
      win = null;
      if (phase === 'install') return;
      if (phase === 'download') native.updateCancel();
      warn();
    },
  });
  const $m = (s) => m.el.querySelector(s);
  $m('[data-page]').addEventListener('click', () => native.updatePage());
  const fail = (text) => {
    sfx.error();
    phase = 'offer';
    $m('[data-progress]').hidden = true;
    $m('[data-err]').textContent = text;
    $m('[data-close]').textContent = 'Not now';
    $m('[data-page]').hidden = false;
    $m('[data-go]').hidden = false;
    $m('[data-go]').textContent = 'Try again';
  };
  const start = async () => {
    if (!r.install) return native.updatePage();
    phase = 'download';
    $m('[data-err]').textContent = '';
    $m('[data-page]').hidden = true;
    $m('[data-go]').hidden = true;
    $m('[data-close]').textContent = 'Cancel';
    $m('[data-progress]').hidden = false;
    showProgress({ received: 0, total: r.size });
    const done = await native.updateDownload().catch(() => ({ ok: false, error: 'The download failed. Try again.' }));
    if (win !== m) return; // (cancelled: the window has gone)
    if (!done.ok) return fail(done.error);
    phase = 'install';
    $m('[data-close]').hidden = true;
    $m('[data-status]').textContent = 'Installing. The game restarts by itself.';
    saveSync();
    const ran = await native.updateInstall().catch(() => null);
    if (!ran?.ok) fail(ran?.error || 'The update couldn\'t start. Get the new version from the download page.');
  };
  if (!r.install) { $m('[data-go]').textContent = 'Download page'; $m('[data-close]').textContent = 'Not now'; }
  $m('[data-go]').addEventListener('click', start);
  if (go) start();
}

function showProgress({ received, total }) {
  const bar = win?.el.querySelector('[data-bar]');
  if (!bar) return;
  bar.style.width = `${total ? (received / total) * 100 : 0}%`;
  win.el.querySelector('[data-status]').textContent = `Downloading: ${mb(received)} of ${mb(total)}`;
}

function warn() {
  saidNo = Date.now();
  const m = openModal({
    title: 'Stay on this version?', cls: 'fatal-modal',
    body: `<div class="fatal-box gold"><div class="fatal-reason">You won't be able to play online with other players until you update.</div>
      <div class="muted" style="font-size:12px">Offline play keeps working. The game will offer the update again later, or you can press Update at the top right.</div></div>`,
    foot: '<button class="btn ghost" data-close>Not now</button><button class="btn primary" data-go>Update now</button>',
  });
  m.el.querySelector('[data-go]').addEventListener('click', () => { m.close(); openWindow({ go: true }); });
}

// The server refused this game ({ required, asked }). The window with the update if the release can be read; if not, the
// reason. Only the game connecting by itself, moments after a Not now, gets less: that was answered.
export async function updateRequired({ required, asked }) {
  sfx.error();
  if (!asked && Date.now() - saidNo < ANSWERED_MS) return toast('Update the game to play online with other players.', 'bad');
  if (canCheck && !release) await check();
  if (release) return openWindow({ locked: true });
  const m = openModal({
    title: 'Update required', cls: 'fatal-modal',
    body: `<div class="fatal-box gold"><div class="fatal-reason">${required ? `Version ${esc(required)} is out. ` : ''}${LOCKED}</div></div>`,
    foot: `<button class="btn ghost" data-close>OK</button>${canCheck ? '<button class="btn primary" data-page>Download page</button>' : ''}`,
  });
  m.el.querySelector('[data-page]')?.addEventListener('click', () => { m.close(); native.updatePage(); });
}

// Called once at boot (main.js). A check that fails shows nothing.
export function initUpdates() {
  if (!canCheck) return;
  native.onUpdateProgress(showProgress);
  net.on('update', checkAndOffer); // (the server's word that a release is out, ahead of the next check here)
  setTimeout(checkAndOffer, 5000);
  setInterval(checkAndOffer, CHECK_EVERY);
}
