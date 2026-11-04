// Changelog: every update to the game, newest first, by version and by day, with search. The entries come with the game
// (data/changelog.json, made from the same source as the Discord update log when the game is built: see
// scripts/build-changelog.mjs), so this works offline and online alike and never touches the network.
import { esc, debounce } from '../util.js';

const view = { q: '', area: 'all', version: 'all' };
let root = null, log = null, loading = null;

// The log, once: { version, updates: [{ at, day, version, area, text }] }, newest first. Filtering a version's updates is
// all the update window would need to list what's new.
export function loadChangelog() {
  return (loading ||= fetch('data/changelog.json').then((r) => {
    if (!r.ok) throw new Error('no changelog');
    return r.json();
  }).catch((e) => { loading = null; throw e; }));
}

// (The day as on the commit, as the Discord log has it. Worked out once: there can be thousands.)
const dateFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
const shortFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });
const asDate = (day) => new Date(`${day}T12:00:00Z`);
function prepare(data) {
  return {
    ...data,
    updates: data.updates.map((u) => {
      const date = dateFormat.format(asDate(u.day));
      return { ...u, date, hay: `${u.text} ${u.area} ${u.version} ${date}`.toLowerCase() };
    }),
  };
}

const plural = (n, one) => `${n.toLocaleString('en-US')} ${one}${n === 1 ? '' : 's'}`;
const thisVersion = () => window.native?.build?.version || log.version;
const terms = () => view.q.toLowerCase().split(/\s+/).filter(Boolean);
const matching = (words) => log.updates.filter((u) => (view.area === 'all' || u.area === view.area)
  && (view.version === 'all' || u.version === view.version) && words.every((w) => u.hay.includes(w)));

// The text with what was searched for picked out. It's split on the raw text and every piece escaped on its own.
function marker(words) {
  if (!words.length) return esc;
  const re = new RegExp(`(${[...words].sort((a, b) => b.length - a.length).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return (text) => text.split(re).map((s, i) => (i % 2 ? `<mark>${esc(s)}</mark>` : esc(s))).join('');
}

// Updates in order to their versions and, in each, their days.
function grouped(list) {
  const versions = [];
  for (const u of list) {
    let v = versions.at(-1);
    if (v?.version !== u.version) versions.push(v = { version: u.version, count: 0, days: [] });
    let d = v.days.at(-1);
    if (d?.day !== u.day) v.days.push(d = { day: u.day, date: u.date, updates: [] });
    d.updates.push(u);
    v.count++;
  }
  return versions;
}

function drawList() {
  const el = root?.querySelector('[data-list]');
  if (!el) return;
  const words = terms(), list = matching(words), mark = marker(words), groups = grouped(list);
  el.innerHTML = list.length ? groups.map((v) => `<section class="cl-version">
      <h2 class="cl-vhead">Version ${esc(v.version)}${v.version === thisVersion() ? '<span class="cl-this">This version</span>' : ''}<span class="cl-vcount">${plural(v.count, 'update')}</span></h2>
      ${v.days.map((d) => `<section class="cl-day">
        <h3><span>${mark(d.date)}</span><span class="cl-n">${plural(d.updates.length, 'update')}</span></h3>
        <ul>${d.updates.map((u) => `<li><span class="cl-area">${mark(u.area)}</span><span class="cl-text">${mark(u.text)}</span></li>`).join('')}</ul>
      </section>`).join('')}
    </section>`).join('')
    : `<div class="empty">No updates match${view.q ? ` “${esc(view.q)}”` : ' these filters'}.</div>`;
  root.querySelector('[data-count]').textContent = list.length === log.updates.length ? plural(list.length, 'update') : `${list.length.toLocaleString('en-US')} of ${plural(log.updates.length, 'update')}`;
  // The days to jump to are the ones on show (the option's value is the day's place in the list).
  let i = 0;
  root.querySelector('[data-jump]').innerHTML = `<option value="">Jump to a date</option>${groups.map((v) => `<optgroup label="Version ${esc(v.version)}">${v.days.map((d) => `<option value="${i++}">${esc(shortFormat.format(asDate(d.day)))} (${d.updates.length})</option>`).join('')}</optgroup>`).join('')}`;
}

function counts(key) {
  const by = new Map();
  for (const u of log.updates) by.set(u[key], (by.get(u[key]) || 0) + 1);
  return by;
}

function draw() {
  const areas = [...counts('area')].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const versions = [...counts('version')];
  if (!areas.some(([a]) => a === view.area)) view.area = 'all';
  if (!versions.some(([v]) => v === view.version)) view.version = 'all';
  const first = log.updates.at(-1);
  root.innerHTML = `<div class="page cl">
    <div class="page-head"><h1>Changelog</h1><span class="sub">Every update to the game, newest first${first ? `, back to ${esc(shortFormat.format(asDate(first.day)))}` : ''}</span></div>
    ${log.updates.length ? `<div class="toolbar">
      <input class="input" type="search" data-q placeholder="Search updates…" aria-label="Search updates" value="${esc(view.q)}">
      <select class="input" data-area aria-label="Part of the game"><option value="all">Everything</option>${areas.map(([a, n]) => `<option value="${esc(a)}" ${a === view.area ? 'selected' : ''}>${esc(a)} (${n})</option>`).join('')}</select>
      ${versions.length > 1 ? `<select class="input" data-version aria-label="Version"><option value="all">All versions</option>${versions.map(([v, n]) => `<option value="${esc(v)}" ${v === view.version ? 'selected' : ''}>Version ${esc(v)} (${n})</option>`).join('')}</select>` : ''}
      <select class="input" data-jump aria-label="Jump to a date"></select>
      <span class="spacer"></span><span class="muted cl-count" data-count aria-live="polite"></span>
    </div>
    <div data-list></div>
    <button class="btn cl-top" data-top hidden>Back to top</button>` : '<div class="empty">No updates to show yet.</div>'}
  </div>`;
  if (!log.updates.length) return;
  const $ = (s) => root.querySelector(s);
  const search = debounce(drawList, 120);
  $('[data-q]').addEventListener('input', (e) => { view.q = e.target.value.trim(); search(); });
  $('[data-area]').addEventListener('change', (e) => { view.area = e.target.value; drawList(); });
  $('[data-version]')?.addEventListener('change', (e) => { view.version = e.target.value; drawList(); });
  $('[data-jump]').addEventListener('change', (e) => {
    root.querySelectorAll('.cl-day')[+e.target.value]?.scrollIntoView({ block: 'start' });
    e.target.value = '';
  });
  $('[data-top]').addEventListener('click', () => { root.scrollTop = 0; });
  root.addEventListener('scroll', showTop, { passive: true });
  drawList();
}
const showTop = () => {
  const top = root?.querySelector('[data-top]');
  if (top) top.hidden = root.scrollTop < 500;
};

export function render(r) {
  root = r;
  r.innerHTML = '<div class="page cl"><div class="page-head"><h1>Changelog</h1></div><div class="empty">Loading…</div></div>';
  loadChangelog().then((data) => {
    if (root !== r || r.dataset.page !== 'changelog') return;
    log ||= prepare(data);
    draw();
  }).catch(() => {
    if (root === r && r.dataset.page === 'changelog') r.querySelector('.empty').textContent = 'The changelog couldn\'t be loaded.';
  });
}

export function destroy() {
  root?.removeEventListener('scroll', showTop);
  root = null;
}
