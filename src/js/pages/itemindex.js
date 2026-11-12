// The Index page: every case and collection with how much of it you've unboxed, a set's items (found in colour, missing
// dimmed), and everything you've ever unboxed. Finishing a set brings up a banner and a reward to claim here. The rules are in
// engine/itemindex.js and the claim is an action (index.claim), so the same checks run on the offline save and on the server.
import { $, esc, debounce, timeAgo } from '../util.js';
import { D, WEAR_BY_KEY, wearOf } from '../data.js';
import * as I from '../items.js';
import { S, on } from '../state.js';
import { sfx } from '../audio.js';
import { openModal, tryAct, topModal, patternTag } from '../ui.js';
import { levelIconHtml, xpBarHtml } from '../profile.js';
import { XP_PER_LEVEL } from '../engine/levels.js';
import { RANK_FILTERS } from '../engine/storage.js';
import * as IX from '../engine/itemindex.js';
import { caseImage, openCaseView, openCollectionView } from './cases.js';

const PAGE = 120;
// As the Cases page lists them (a charm collection is a collection here).
const KINDS = [['case', 'Weapon Cases'], ['souvenir', 'Souvenir Packages'], ['package', 'Packages'], ['collection', 'Collections'], ['capsule', 'Sticker Capsules'], ['autograph', 'Autograph Capsules'], ['pins', 'Pin Capsules'], ['agents', 'Agents']];
const KIND_NAME = { case: 'Weapon case', souvenir: 'Souvenir package', package: 'Package', collection: 'Collection', charms: 'Charm collection', capsule: 'Sticker capsule', autograph: 'Autograph capsule', pins: 'Pin capsule', agents: 'Agent locker' };
const SET_SORTS = [['near', 'Closest to finished'], ['reward', 'Biggest reward'], ['easy', 'Fewest openings'], ['name', 'Name']];
const NEW_RECORD = () => ({ q: '', rank: 'all', type: 'all', sort: 'new', limit: PAGE });
const view = { tab: 'sets', kind: 'case', q: '', sort: 'near', set: null, record: NEW_RECORD() };
let root = null, off = null, watcher = null;

const num = (n) => n.toLocaleString('en-US');
const go = (name) => window.dispatchEvent(new CustomEvent('app:go', { detail: name }));
const rewardText = ({ xp, stars }) => `+${num(xp)} XP${stars ? ` · ★ ${stars}` : ''}`;
const inKind = (s, kind) => s.kind === kind || (kind === 'collection' && s.kind === 'charms');
// A collection's picture is its best item, as on the Cases page; a box has its own.
function setImage(s, size = 'm') {
  if (s.kind === 'collection' || s.kind === 'charms') { const item = IX.entryItem(s.tiers[0][1][0]); return item ? I.itemImage(item, size) : ''; }
  return caseImage(D.caseById[s.id]);
}

// ---- pictures of the record ---------------------------------------------------------------------------------------------
// What an entry says about your best copy.
function bestLine(item, e) {
  if (e.fl != null) { const wk = wearOf(e.fl); return `<b class="wk" style="--wc:${WEAR_BY_KEY[wk].c}" title="Your lowest float: ${WEAR_BY_KEY[wk].n}">${wk}</b>${e.fl.toFixed(4)}`; }
  return esc(I.rarityInfo(item).n);
}
// One item as the Index shows it: as you've found it, or dimmed.
function itemTile(id, e) {
  const item = IX.entryItem(id, e);
  if (!item) return '';
  const plain = { t: item.t, id }, r = I.rarityInfo(plain), np = I.nameParts(plain), pat = e ? I.patternInfo(item) : null;
  return `<div class="card ix-item ${e ? '' : 'missing'}" data-item="${esc(id)}" style="--rc:${r.c}">
    <div class="tags">${e?.st ? '<span class="tag st">ST™</span>' : ''}${e?.sv ? '<span class="tag sv">Souvenir</span>' : ''}${pat?.label ? patternTag(pat) : ''}</div>
    <div class="img"><img loading="lazy" src="${I.itemImage(plain, 'm')}" alt=""></div>
    <div class="rbar"></div>
    <div class="meta">
      <div class="n1">${esc(np.top)}</div>
      <div class="n2">${esc(np.bottom)}</div>
      <div class="row">${e ? `<span class="wear">${bestLine(plain, e)}</span><span class="ix-n" title="How many you've unboxed">×${num(e.n)}</span>` : '<span class="wear">Not unboxed yet</span>'}</div>
    </div>
  </div>`;
}
const firstText = (e) => (e.at ? `${new Date(e.at).toLocaleDateString()} (${timeAgo(e.at)})` : 'Before the Index');

// An item's window: what the record says, and where it comes from (a set opens from here).
function showItem(id, ix = S.index, { sets = true } = {}) {
  const e = ix.items[id], item = IX.entryItem(id, e);
  if (!item) return;
  const plain = { t: item.t, id }, r = I.rarityInfo(plain), pat = e ? I.patternInfo(item) : null, inSets = IX.setsWith(id);
  const rows = [['Rarity', `<span style="color:${r.c}">${esc(r.n)}</span>`]];
  if (e) {
    rows.push(['First unboxed', esc(firstText(e))], ['Unboxed', `${num(e.n)} time${e.n === 1 ? '' : 's'}`]);
    if (e.st) rows.push(['StatTrak™', num(e.st)]);
    if (e.sv) rows.push(['Souvenir', num(e.sv)]);
    if (e.fl != null) rows.push(['Lowest float', `${esc(WEAR_BY_KEY[wearOf(e.fl)].n)} · ${e.fl}`]);
    if (pat?.label) rows.push(['Best pattern', esc(pat.label)]);
  }
  const m = openModal({
    title: esc(I.itemName(plain)),
    body: `<div class="ix-entry ${e ? '' : 'missing'}" style="--rc:${r.c}"><img src="${I.itemImage(plain, 'm')}" alt="">
      <div><dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      ${e ? '' : '<p class="muted">You haven\'t unboxed this yet. Buying it or trading for it won\'t count.</p>'}</div></div>
      ${inSets.length ? `<div class="section-title">Part of ${num(inSets.length)} set${inSets.length === 1 ? '' : 's'}</div>
      <div class="ix-sets">${inSets.slice(0, 12).map((s) => (sets ? `<button class="btn sm" data-set="${esc(s.id)}">${esc(s.n)}</button>` : `<span class="chip">${esc(s.n)}</span>`)).join('')}${inSets.length > 12 ? `<span class="muted">and ${num(inSets.length - 12)} more</span>` : ''}</div>` : ''}`,
    foot: '<button class="btn ghost" data-close>Close</button>',
  });
  m.el.querySelectorAll('[data-set]').forEach((b) => b.addEventListener('click', () => { m.close(); openSet(b.dataset.set); }));
}

// ---- everything you've unboxed ------------------------------------------------------------------------------------------
// The list a record shows: built once for a record, and only a page of it is drawn at a time, so a long one stays quick.
let rowsFor = { items: null, rows: [] };
function recordRows(ix) {
  if (rowsFor.items !== ix.items) rowsFor = { items: ix.items, rows: IX.rows(ix) };
  return rowsFor.rows;
}
// The record's view in `el`, for the page and the admin panels. v: the filters. open: an item clicked.
export function drawRecord(el, ix, v, open) {
  const select = (k, list) => `<select class="input" data-k="${k}">${list.map(([x, n]) => `<option value="${x}" ${String(v[k]) === x ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
  const sum = IX.summary(ix);
  el.innerHTML = `<div class="toolbar">
      <input class="input" type="search" placeholder="Search everything unboxed…" value="${esc(v.q)}">
      ${select('type', IX.RECORD_TYPES)}${select('rank', RANK_FILTERS)}
      <span class="spacer"></span>${select('sort', IX.RECORD_SORTS)}
    </div>
    <div class="muted ix-count" data-count></div>
    <div class="grid" data-grid></div><div class="ix-more" data-morebox></div>
    ${sum.lost ? `<p class="muted ix-lost">${num(sum.lost)} older unboxing${sum.lost === 1 ? ' isn\'t' : 's aren\'t'} listed: ${sum.lost === 1 ? 'that item' : 'those items'} left the inventory before the Index existed, so there's nothing to say what ${sum.lost === 1 ? 'it was' : 'they were'}.</p>` : ''}`;
  const grid = el.querySelector('[data-grid]'), box = el.querySelector('[data-morebox]'), count = el.querySelector('[data-count]');
  let list = [], shown = 0, seen = null;
  const more = () => {
    const next = list.slice(shown, Math.min(list.length, Math.max(v.limit, shown + PAGE)));
    grid.insertAdjacentHTML('beforeend', next.map((r) => itemTile(r.id, r.e)).join(''));
    shown += next.length;
    v.limit = shown;
    seen?.disconnect();
    box.innerHTML = shown < list.length ? `<button class="btn" data-more>Show more (${num(list.length - shown)} left)</button>` : '';
    const b = box.querySelector('[data-more]');
    if (!b) return;
    b.addEventListener('click', more);
    // (…and it comes up by itself when you scroll to it)
    seen = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting) && b.isConnected) more(); });
    seen.observe(b);
  };
  const fill = () => {
    list = IX.viewRows(recordRows(ix), v);
    shown = 0;
    grid.innerHTML = '';
    count.textContent = sum.items ? `${num(list.length)} of ${num(sum.items)} item${sum.items === 1 ? '' : 's'} · ${num(sum.copies)} unboxed in all` : '';
    if (!list.length) grid.innerHTML = `<div class="empty">${sum.items ? 'Nothing matches.' : 'Nothing yet. What you unbox goes here for good, even after you\'ve sold it.'}</div>`;
    more();
  };
  const refill = () => { v.limit = PAGE; fill(); };
  el.querySelector('input[type=search]').addEventListener('input', debounce((e) => { v.q = e.target.value; refill(); }, 120));
  el.querySelectorAll('select[data-k]').forEach((s) => s.addEventListener('change', () => { v[s.dataset.k] = s.value; refill(); }));
  grid.addEventListener('click', (e) => { const c = e.target.closest('[data-item]'); if (c) open(c.dataset.item); });
  fill();
}

// ---- the sets -----------------------------------------------------------------------------------------------------------
const stateOf = (ix, s) => {
  const p = IX.progress(ix, s), claimed = IX.isClaimed(ix, s.goal);
  return { p, claimed, waiting: p.complete && !claimed, rareWaiting: !!s.rareGoal && p.rareDone > 0 && !IX.isClaimed(ix, s.rareGoal) };
};
const setTile = (s, ix) => {
  const { p, claimed, waiting, rareWaiting } = stateOf(ix, s), reward = IX.goalOf(s.goal).reward;
  const tag = waiting || rareWaiting ? '<span class="tag ix-ready">Reward ready</span>' : claimed ? '<span class="tag ix-claimed">✓ Claimed</span>' : p.complete ? '<span class="tag ix-claimed">✓ Complete</span>' : '';
  return `<div class="card case-tile ix-tile ${p.done ? '' : 'none'} ${waiting || rareWaiting ? 'ready' : ''}" data-set="${esc(s.id)}" style="--rc:#f2b21b">
    <div class="tags">${tag}</div>
    <div class="img"><img loading="lazy" src="${setImage(s)}" alt=""></div>
    <div class="meta">
      <div class="n2">${esc(s.n)}</div>
      <div class="ix-bar ${p.complete ? 'full' : ''}"><i style="width:${(p.done / p.total) * 100}%"></i></div>
      <div class="row"><span class="wear">${num(p.done)} / ${num(p.total)} unboxed</span><span class="ix-reward" title="Finishing this pays">${rewardText(reward)}</span></div>
      ${p.rareTotal ? `<div class="row"><span class="wear ix-rare">★ ${num(p.rareDone)} / ${num(p.rareTotal)} rare specials</span></div>` : ''}
    </div>
  </div>`;
};
const SET_ORDER = {
  near: (a, b, ix) => { const rank = (s) => { const x = stateOf(ix, s); return x.waiting || x.rareWaiting ? 0 : x.p.complete ? 2 : 1; }; const f = (s) => { const p = IX.progress(ix, s); return p.done / p.total; }; return rank(a) - rank(b) || f(b) - f(a); },
  reward: (a, b) => IX.goalOf(b.goal).reward.xp - IX.goalOf(a.goal).reward.xp,
  easy: (a, b) => IX.goalOf(a.goal).opens - IX.goalOf(b.goal).opens,
  name: () => 0,
};
function fillSets() {
  const ix = S.index, q = view.q.trim().toLowerCase();
  const list = IX.allSets().filter((s) => inKind(s, view.kind) && (!q || s.n.toLowerCase().includes(q)))
    .sort((a, b) => SET_ORDER[view.sort](a, b, ix) || a.n.localeCompare(b.n));
  const grid = $('[data-sets]', root);
  grid.innerHTML = list.map((s) => setTile(s, ix)).join('') || '<div class="empty">Nothing matches.</div>';
}

// The rewards waiting, at the top of the page.
function waitingHtml(ix) {
  const list = IX.waitingGoals(ix);
  if (!list.length) return '';
  return `<div class="ix-waiting">
    <div class="ix-waiting-head"><b>${list.length === 1 ? 'A reward is' : `${num(list.length)} rewards are`} waiting</b>${list.length > 1 ? '<button class="btn gold sm" data-claimall>Claim all</button>' : ''}</div>
    ${list.slice(0, 6).map((g) => `<div class="ix-goal"><span class="grow">${g.kind === 'rare' ? `<b class="goldtxt">★ Rare special:</b> ${esc(g.n)}${g.sets.length > 1 ? ` and ${g.sets.length - 1} more` : ''}` : esc(g.n)}</span><span class="ix-reward">${rewardText(g.reward)}</span><button class="btn gold sm" data-claim="${esc(g.key)}">Claim</button></div>`).join('')}
    ${list.length > 6 ? `<div class="muted">and ${num(list.length - 6)} more</div>` : ''}
  </div>`;
}

function headHtml(ix) {
  const sum = IX.summary(ix);
  return `<div class="page-head"><h1>Index</h1><span class="sub">${num(sum.items)} item${sum.items === 1 ? '' : 's'} unboxed · ${num(sum.claimed)} of ${num(sum.goals)} rewards claimed</span></div>
    <div class="toolbar"><div class="seg" data-tabs>${[['sets', 'Cases & Collections'], ['record', 'Everything Unboxed']].map(([k, n]) => `<button data-v="${k}" class="${view.tab === k ? 'active' : ''}">${n}</button>`).join('')}</div></div>`;
}
function bindClaims(el) {
  el.querySelectorAll('[data-claim]').forEach((b) => b.addEventListener('click', () => claimGoals([b.dataset.claim], b)));
  el.querySelector('[data-claimall]')?.addEventListener('click', (e) => claimGoals(IX.waitingGoals(S.index).map((g) => g.key), e.currentTarget));
}

function drawList() {
  const ix = S.index;
  root.innerHTML = `<div class="page ix-page">${headHtml(ix)}
    ${view.tab === 'sets' ? `${waitingHtml(ix)}
      <div class="toolbar"><div class="seg" data-kinds>${KINDS.map(([k, n]) => `<button data-v="${k}" class="${view.kind === k ? 'active' : ''}">${n}</button>`).join('')}</div>
        <input class="input" type="search" placeholder="Search…" value="${esc(view.q)}"><span class="spacer"></span>
        <select class="input" data-sort>${SET_SORTS.map(([k, n]) => `<option value="${k}" ${view.sort === k ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      <div class="grid lg" data-sets></div>` : '<div data-record></div>'}
  </div>`;
  root.querySelectorAll('[data-tabs] button').forEach((b) => b.addEventListener('click', () => { view.tab = b.dataset.v; drawList(); }));
  bindClaims(root);
  if (view.tab === 'record') return drawRecord($('[data-record]', root), ix, view.record, (id) => showItem(id));
  root.querySelectorAll('[data-kinds] button').forEach((b) => b.addEventListener('click', () => { view.kind = b.dataset.v; drawList(); }));
  $('[data-sort]', root).addEventListener('change', (e) => { view.sort = e.target.value; fillSets(); });
  $('input[type=search]', root).addEventListener('input', debounce((e) => { view.q = e.target.value; fillSets(); }, 120));
  $('[data-sets]', root).addEventListener('click', (e) => { const c = e.target.closest('[data-set]'); if (c) openSet(c.dataset.set); });
  fillSets();
}

// Where a set's items come from.
function sourceButton(s) {
  const c = D.caseById[s.id] || D.caseById[D.colById[s.id]?.caseId];
  if (c) return `<button class="btn" data-source="case:${esc(c.id)}">Open in Cases</button>`;
  if (s.kind === 'collection') return `<button class="btn" data-source="col:${esc(s.id)}">Open in Cases</button>`;
  return '<button class="btn" data-source="armory">Go to the Armory</button>';
}
function openSource(v) {
  const [where, id] = v.split(':');
  if (where === 'armory') return go('armory');
  go('cases');
  if (where === 'case') openCaseView(id); else openCollectionView(id);
}

function drawSet(s) {
  const ix = S.index, { p, claimed, waiting } = stateOf(ix, s), goal = IX.goalOf(s.goal), rare = s.rareGoal ? IX.goalOf(s.rareGoal) : null;
  const rareReady = rare && p.rareDone > 0 && !IX.isClaimed(ix, rare.key), rareClaimed = rare && IX.isClaimed(ix, rare.key);
  const others = goal.sets.filter((id) => id !== s.id).map(IX.setOf);
  const sameAs = others.length ? `The same items as ${esc(others[0].n)}${others.length > 1 ? ` and ${others.length - 1} more` : ''}, so they share this reward.` : '';
  const tierName = (k) => I.rarityInfo({ t: IX.kindOf(s.ids[0]), id: s.tiers.find(([x]) => x === k)[1][0] }).n;
  const section = (title, ids) => `<div class="section-title">${title}</div><div class="grid">${ids.map((id) => itemTile(id, ix.items[id])).join('')}</div>`;
  root.innerHTML = `<div class="page ix-page">
    <div class="page-head"><button class="btn ghost" data-back>← Index</button></div>
    <div class="case-hero ix-hero">
      <img class="ci" src="${setImage(s, 'l')}" alt="">
      <div>
        <div class="kicker">${KIND_NAME[s.kind] || ''}</div>
        <h2>${esc(s.n)}</h2>
        <div class="stats">
          <div>Unboxed<b>${num(p.done)} / ${num(p.total)}</b></div>
          <div>Reward<b class="goldtxt">${rewardText(goal.reward)}</b></div>
          <div>Finishing it takes about<b>${num(goal.opens)} opening${goal.opens === 1 ? '' : 's'}</b></div>
          ${p.rareTotal ? `<div>Rare specials<b>★ ${num(p.rareDone)} / ${num(p.rareTotal)}</b></div>` : ''}
        </div>
        <div class="ix-bar big ${p.complete ? 'full' : ''}"><i style="width:${(p.done / p.total) * 100}%"></i></div>
        <div class="open-row">
          ${waiting ? `<button class="btn gold" data-claim="${esc(goal.key)}">Claim ${rewardText(goal.reward)}</button>` : ''}
          ${rareReady ? `<button class="btn gold" data-claim="${esc(rare.key)}">Claim the ★ bonus ${rewardText(rare.reward)}</button>` : ''}
          ${claimed ? '<span class="chip green">✓ Reward claimed</span>' : ''}
          ${sourceButton(s)}
        </div>
        <p class="muted ix-note">${[sameAs, 'Only what you unbox counts, in any version: items you buy, trade for or make with a contract don\'t.'].filter(Boolean).join(' ')}</p>
      </div>
    </div>
    ${s.tiers.map(([k, ids]) => { const n = ids.filter((id) => ix.items[id]).length; return section(`${esc(tierName(k))} <span class="muted">${num(n)} / ${num(ids.length)}</span>`, ids); }).join('')}
    ${s.rare.length ? section(`★ Rare Special Items <span class="muted">${num(p.rareDone)} / ${num(p.rareTotal)} · not needed to finish${rare ? `, but the first one pays ${rewardText(rare.reward)}${rareClaimed ? ' (claimed)' : ''}` : ''}</span>`, s.rare) : ''}
  </div>`;
  $('[data-back]', root).addEventListener('click', () => { view.set = null; draw(); });
  $('[data-source]', root).addEventListener('click', (e) => openSource(e.currentTarget.dataset.source));
  bindClaims(root);
  root.querySelectorAll('[data-item]').forEach((c) => c.addEventListener('click', () => showItem(c.dataset.item)));
}

function draw() {
  if (!root?.isConnected) return;
  const s = view.set && IX.setOf(view.set);
  if (s) drawSet(s); else drawList();
}
function openSet(id) {
  view.set = id;
  view.tab = 'sets';
  if (root?.isConnected && root.dataset.page === 'index') { root.scrollTop = 0; draw(); } else go('index');
}

export function render(el) {
  root = el;
  off?.();
  off = on('index', () => draw());
  draw();
}
export function destroy() { off?.(); off = null; }

// ---- claiming -------------------------------------------------------------------------------------------------------------
// Claims goals one by one (the server checks each) and shows what they paid.
async function claimGoals(keys, btn) {
  if (btn) btn.disabled = true;
  const done = [];
  for (const goal of keys) {
    const r = await tryAct('index.claim', { goal });
    if (!r) break;
    done.push(r);
  }
  if (btn?.isConnected) btn.disabled = false;
  if (!done.length) return;
  sfx.reveal(6);
  const xp = done.reduce((s, r) => s + r.xp, 0), stars = done.reduce((s, r) => s + r.stars, 0), levelUps = done.reduce((s, r) => s + r.levelUps, 0);
  const last = done.at(-1), prof = S.prof;
  const m = openModal({
    title: 'Reward claimed',
    body: `<div class="ix-paid">
      <div class="kicker">${done.length === 1 ? (last.kind === 'rare' ? 'Rare special bonus' : 'Finished') : `${num(done.length)} rewards`}</div>
      <h2>${done.length === 1 ? esc(last.n) : `${num(done.length)} sets finished`}</h2>
      <div class="ix-gains"><div><b>+${num(xp)}</b>XP</div>${stars ? `<div><b class="goldtxt">★ ${num(stars)}</b>Armory Stars</div>` : ''}</div>
      <div class="xp-line">${levelIconHtml(prof.level, 26)}${xpBarHtml(prof, { from: levelUps ? 0 : done[0].before.xp })}<span class="muted">${num(prof.xp)} / ${num(XP_PER_LEVEL)}</span></div>
      ${levelUps ? `<div class="lvl-up"><b>Level ${prof.level}</b>${levelUps > 1 ? ` (${levelUps} level ups)` : ''} · ${last.waiting} reward${last.waiting === 1 ? '' : 's'} waiting at the top of the menu</div>` : ''}
    </div>`,
    foot: '<button class="btn gold" data-close>Nice</button>',
  });
  m.el.querySelector('[data-close]').focus();
}

// ---- the moment a set is finished, and the count on the tab ----------------------------------------------------------------
function updateBadge() {
  const el = document.getElementById('index-count');
  if (!el) return;
  const n = IX.waitingGoals(S.index).length;
  el.hidden = !n;
  el.textContent = n;
}
// Not while the reel is spinning or a battle is on: that would give away what's about to land.
const revealing = () => !!document.querySelector('.opening, .battle, .play-canvas');
let finished = [];
function flushFinished() {
  clearTimeout(watcher);
  if (!finished.length) return;
  if (revealing()) { watcher = setTimeout(flushFinished, 300); return; }
  const goals = finished.splice(0).map(IX.goalOf).filter((g) => g && !IX.isClaimed(S.index, g.key));
  if (goals.length) banner(goals);
}
function banner(goals) {
  document.querySelector('.ix-banner')?.remove();
  const g = goals[0], s = IX.setOf(g.face);
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'ix-banner';
  const kind = g.kind === 'rare' ? 'Rare special found' : s.kind === 'case' ? 'Case finished' : s.kind === 'collection' || s.kind === 'charms' ? 'Collection finished' : `${KIND_NAME[s.kind] || 'Set'} finished`;
  el.innerHTML = `<img src="${setImage(s)}" alt="">
    <span class="grow"><span class="kicker">${esc(kind)}</span><b>${esc(g.n)}${goals.length > 1 ? ` and ${goals.length - 1} more` : ''}</b>
      <span class="ix-reward">${rewardText(g.reward)}${goals.length > 1 ? ' and more' : ''}</span></span>
    <span class="btn gold sm">Claim in Index</span>`;
  document.body.appendChild(el);
  sfx.gold();
  const away = setTimeout(() => el.classList.add('out'), 9000), gone = setTimeout(() => el.remove(), 9400);
  el.addEventListener('click', () => {
    clearTimeout(away); clearTimeout(gone);
    el.remove();
    while (topModal()) topModal().close();
    view.set = null;
    view.tab = 'sets';
    go('index');
  });
}
export function initIndex() {
  updateBadge();
  on('reset', updateBadge);
  on('index', (ch) => {
    updateBadge();
    if (!ch?.done?.length) return;
    finished.push(...ch.done);
    // (A moment on: the reel that's about to show this item goes up just after the action that rolled it.)
    clearTimeout(watcher);
    watcher = setTimeout(flushFinished, 400);
  });
}

// ---- the admin panels: a player's record, to read ------------------------------------------------------------------------
const FOR_ADMIN = { record: NEW_RECORD() };
export function drawAdminIndex(el, st) {
  const ix = IX.upgradeIndex(st?.index), sum = IX.summary(ix);
  const claimed = Object.entries(ix.claimed).sort((a, b) => b[1] - a[1]).map(([key, at]) => [IX.goalOf(key), key, at]);
  el.innerHTML = `<div class="summary adm-summary">${[['Items unboxed', num(sum.items)], ['Copies in all', num(sum.copies)], ['From before the record', num(sum.lost)], ['Rewards claimed', `${num(sum.claimed)} of ${num(sum.goals)}`], ['Ready to claim', num(sum.waiting)]].map(([k, v]) => `<div>${k}<b>${v}</b></div>`).join('')}</div>
    <p class="muted adm-note">Only unboxing writes to this record, so it can't be edited here. A restored snapshot keeps the record and claims as they are now.</p>
    ${claimed.length ? `<div class="panel"><h3>Rewards claimed</h3><dl class="kv">${claimed.slice(0, 100).map(([g, key, at]) => `<dt>${esc(new Date(at).toLocaleDateString())}</dt><dd>${esc(g?.n || key)}${g?.kind === 'rare' ? ' (★ bonus)' : ''}${g ? ` · ${rewardText(g.reward)}` : ''}</dd>`).join('')}</dl></div>` : ''}
    <div data-adm-record></div>`;
  drawRecord(el.querySelector('[data-adm-record]'), ix, FOR_ADMIN.record, (id) => showItem(id, ix, { sets: false }));
}
export const recordSize = (st) => Object.keys(st?.index?.items || {}).length;
