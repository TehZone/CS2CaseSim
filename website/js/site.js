// cs2casesim.lol: the latest release from GitHub's API, the players online from the game's server (/status, which Caddy
// passes to the server's /health), the screenshots' lightbox, and the Discord links. All of it is extra: without this
// script, or when GitHub or the server doesn't answer, the page keeps its download links and its own release notes.
(() => {
  'use strict';

  // The Discord server's invite link (https://discord.gg/...). While it's empty, every Discord button and link stays hidden.
  const DISCORD_INVITE = '';

  const REPO = 'TehZone/CS2CaseSim';
  const API = `https://api.github.com/repos/${REPO}/releases/latest`;
  const FILES = { setup: 'CS2-Case-Simulator-Setup.exe', portable: 'CS2-Case-Simulator.exe' };
  // GitHub allows 60 requests an hour per visitor without a login: the answer is kept for 15 minutes in this browser.
  const CACHE_KEY = 'cs2sim.release.v1';
  const CACHE_MS = 15 * 60 * 1000;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const el = (tag, text) => { const e = document.createElement(tag); if (text != null) e.textContent = text; return e; };

  // ---- Discord --------------------------------------------------------------------------------------------------------
  const invite = /^https:\/\/(discord\.gg|discord\.com\/invite)\/[A-Za-z0-9-]+\/?$/.test(DISCORD_INVITE) ? DISCORD_INVITE : '';
  if (invite) {
    for (const a of $$('a[data-discord-link]')) { a.href = invite; a.rel = 'noopener'; }
    for (const e of $$('[data-discord]')) e.hidden = false;
  }

  // ---- the latest release -----------------------------------------------------------------------------------------------
  const cached = () => {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      return c && Date.now() - c.at < CACHE_MS && c.release ? c.release : null;
    } catch { return null; }
  };
  const keep = (release) => { try { localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), release })); } catch {} };

  // Only what the page shows, checked: a version, a date, the notes as text, and the two exes' sizes and SHA-256.
  function fromApi(r) {
    const version = String(r?.tag_name || '').replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
    const files = {};
    for (const [kind, name] of Object.entries(FILES)) {
      const a = (r.assets || []).find((x) => x && x.name === name);
      if (!a) continue;
      const sha = /^sha256:([0-9a-f]{64})$/.exec(String(a.digest || ''));
      files[kind] = { size: Number(a.size) || 0, sha256: sha ? sha[1] : '' };
    }
    const date = Date.parse(r.published_at || '');
    return { version, date: Number.isFinite(date) ? date : 0, notes: String(r.body || '').slice(0, 6000), files };
  }

  async function latest() {
    const hit = cached();
    if (hit) return hit;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await fetch(API, { headers: { Accept: 'application/vnd.github+json' }, signal: ctl.signal, credentials: 'omit' });
      if (!res.ok) return null; // (rate-limited: 403 or 429; the page's own notes stay)
      const release = fromApi(await res.json());
      if (release) keep(release);
      return release;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  const mb = (bytes) => `${Math.round(bytes / 1048576)} MB`;
  const day = (ms) => new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  // A line of the notes: "Area: what changed" gets its area in bold, **bold** and `code` are kept, the rest is text.
  function inline(target, text) {
    const area = /^([A-Z][\w &'’/-]{0,30}):\s+(.+)$/.exec(text);
    if (area) { target.append(el('strong', `${area[1]}:`), ' '); text = area[2]; }
    for (const part of text.split(/(\*\*[^*]+\*\*|`[^`]+`)/)) {
      if (!part) continue;
      if (part.startsWith('**') && part.endsWith('**')) target.append(el('strong', part.slice(2, -2)));
      else if (part.startsWith('`') && part.endsWith('`')) target.append(el('code', part.slice(1, -1)));
      else target.append(part);
    }
  }

  // The notes' first paragraph is the release's headline; its "- " lines are the list. Text only, never HTML.
  function showNotes(release) {
    const box = $('[data-notes]');
    if (!box || !release.notes.trim()) return;
    const lines = release.notes.replace(/\r/g, '').split('\n').map((l) => l.trim());
    let headline = '';
    const frag = document.createDocumentFragment();
    let list = null, items = 0;
    for (const line of lines) {
      if (!line) { list = null; continue; }
      const item = /^[-*]\s+(.+)$/.exec(line);
      if (item) {
        if (++items > 12) continue;
        if (!list) { list = el('ul'); frag.append(list); }
        const li = el('li');
        inline(li, item[1]);
        list.append(li);
        continue;
      }
      list = null;
      const text = line.replace(/^#+\s*/, '');
      if (!headline && !frag.childNodes.length) { headline = text; continue; }
      const p = el('p');
      inline(p, text);
      frag.append(p);
    }
    if (!frag.childNodes.length) return;
    box.replaceChildren(frag);
    const when = $('[data-notes-when]');
    if (when) when.textContent = [headline, release.date ? `Released ${day(release.date)}.` : ''].filter(Boolean).join(' ');
    const v = $('[data-notes-version]');
    if (v) v.textContent = release.version;
    const link = $('[data-notes-link]');
    if (link) link.href = `https://github.com/${REPO}/releases/tag/v${release.version}`;
  }

  function showRelease(release) {
    const meta = $('[data-release-meta]');
    if (meta) {
      $('[data-version]', meta).textContent = release.version;
      const size = release.files.setup?.size;
      $('[data-release-size]', meta).textContent = size ? mb(size) : '';
      $('[data-release-date]', meta).textContent = release.date ? `Released ${day(release.date)}` : '';
      meta.hidden = false;
    }
    showNotes(release);
    const hashes = $('[data-hashes]');
    const rows = Object.entries(FILES).filter(([kind]) => release.files[kind]?.sha256);
    if (hashes && rows.length) {
      hashes.replaceChildren(...rows.flatMap(([kind, name]) => {
        const dd = el('dd');
        dd.append(el('code', release.files[kind].sha256));
        return [el('dt', `SHA-256 of ${name} (${release.version})`), dd];
      }));
      hashes.hidden = false;
    }
  }

  latest().then((r) => { if (r) showRelease(r); });

  // ---- players online -----------------------------------------------------------------------------------------------
  const live = $('[data-online]');
  async function online() {
    if (!live) return;
    try {
      const res = await fetch('/status', { cache: 'no-store', headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(String(res.status));
      const n = (await res.json())?.online;
      if (!Number.isInteger(n) || n < 0) throw new Error('no count');
      $('[data-online-count]', live).textContent = n.toLocaleString('en-US');
      $('[data-online-word]', live).textContent = n === 1 ? 'player' : 'players';
      live.hidden = false;
    } catch {
      live.hidden = true;
    }
  }
  online();
  setInterval(() => { if (!document.hidden) online(); }, 60000);

  // ---- the screenshots' lightbox --------------------------------------------------------------------------------------
  const dialog = $('.lightbox');
  const shots = $$('.gallery a');
  if (dialog && typeof dialog.showModal === 'function' && shots.length) {
    const img = $('[data-lb-img]', dialog), cap = $('[data-lb-cap]', dialog), count = $('[data-lb-count]', dialog);
    let at = 0, opener = null;
    const show = (i) => {
      at = (i + shots.length) % shots.length;
      const a = shots[at];
      img.src = a.getAttribute('href');
      img.alt = $('img', a)?.alt || '';
      cap.textContent = a.dataset.caption || '';
      count.textContent = `${at + 1} / ${shots.length}`;
      // (the next one, ready for the arrow key)
      const next = new Image();
      next.src = shots[(at + 1) % shots.length].getAttribute('href');
    };
    shots.forEach((a, i) => {
      a.setAttribute('aria-haspopup', 'dialog');
      a.addEventListener('click', (e) => {
        if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return; // (a new tab: the image itself)
        e.preventDefault();
        opener = a;
        show(i);
        dialog.showModal();
      });
    });
    $('[data-lb-prev]', dialog).addEventListener('click', () => show(at - 1));
    $('[data-lb-next]', dialog).addEventListener('click', () => show(at + 1));
    $('[data-lb-close]', dialog).addEventListener('click', () => dialog.close());
    dialog.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); show(at - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); show(at + 1); }
      else if (e.key === 'Home') { e.preventDefault(); show(0); }
      else if (e.key === 'End') { e.preventDefault(); show(shots.length - 1); }
    });
    // A click on the dark around the picture closes it.
    dialog.addEventListener('click', (e) => { if (e.target === dialog || e.target.matches('[data-lb-stage]')) dialog.close(); });
    // Swipe left and right on a touch screen (the stage's touch-action leaves sideways moves to these events).
    let x0 = null;
    const stage = $('[data-lb-stage]', dialog);
    stage.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') x0 = e.clientX; });
    stage.addEventListener('pointercancel', () => { x0 = null; });
    stage.addEventListener('pointerup', (e) => {
      if (x0 == null) return;
      const dx = e.clientX - x0;
      x0 = null;
      if (Math.abs(dx) > 50) show(at + (dx < 0 ? 1 : -1));
    });
    dialog.addEventListener('close', () => { img.removeAttribute('src'); opener?.focus(); });
  }
})();
