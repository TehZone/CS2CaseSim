// Team manager: open packs of pro player cards, build a five-player lineup with roles and chemistry, and play
// simulated matches and events against real historical Major rosters.
import { esc, money, imgUrl } from '../util.js';
import { D, eventShort } from '../data.js';
import * as I from '../items.js';
import { S, on } from '../state.js';
import { sfx } from '../audio.js';
import { tryAct, toast, openModal, sellItems, confirmDialog } from '../ui.js';
import * as M from '../engine/manager.js';
import { online } from '../backend.js';
import { net } from '../net/online.js';

const view = { tab: 'squad', pack: 'major', packEv: null, q: '', role: 'all', tier: 'all', opps: null };
let root = null, offs = [];

export function render(r) {
  root = r;
  offs.forEach((o) => o());
  offs = [on('team', () => draw()), on('inv', () => draw()), on('money', () => updateAfford())];
  draw();
}
export function destroy() { offs.forEach((o) => o()); offs = []; root = null; }

// ---- card --------------------------------------------------------------------------------------
export function proCardHTML(p, { uid = '', sm = false, slot = null, extra = '', cls = '' } = {}) {
  const t = M.proTier(p.ovr), R = M.PRO_RARITY[t];
  const fit = slot ? M.roleFit(p, slot) : 0;
  return `<div class="pro-card ${sm ? 'sm' : ''} t${t} ${cls}" style="--pc:${R.c}" ${uid ? `data-uid="${uid}"` : ''} data-pro="${p.id}" title="${esc(p.n)} · ${esc(M.ROLE_NAMES[p.role] || p.role)} · ${esc(M.proTeamName(p))} at ${esc(D.events[p.ev]?.n || '')}">
    <div class="ovr">${p.ovr}</div><div class="role">${esc(p.role)}</div><div class="flag chip" style="font-size:9px;padding:1px 5px">${esc(p.geo || '')}</div><div class="tier">${R.n}</div>
    <div class="art">${p.img ? `<img loading="lazy" src="${imgUrl(p.img, 's')}" alt="">` : '<span class="noimg">★</span>'}</div>
    <div class="nm">${esc(p.n)}</div><div class="tm">${esc(M.proTeamTag(p) || M.proTeamName(p))} · ${esc(eventShort(p.ev))}</div>
    <div class="attrs">${M.ATTRS.map((a, i) => `<div><b>${p.a[i]}</b>${a}</div>`).join('')}</div>
    ${fit ? `<div class="fit">−${fit} off-role</div>` : ''}${extra}
  </div>`;
}

const myCards = () => S.inv.filter((i) => i.t === 'pro' && D.pros[i.id]);
const lineup = () => M.lineupFromState(S);
const inTeam = () => new Set([...Object.values(S.team.slots), ...S.team.bench].filter(Boolean));

function draw() {
  if (!root) return;
  const lu = lineup(), tr = M.teamRating(lu), chem = M.chemistry(lu);
  root.innerHTML = `<div class="page">
    <div class="page-head"><h1>Team Manager</h1><span class="sub">Open packs of pro player cards, build your five, and take on real Major rosters.</span></div>
    <div class="team-bar">
      <input class="input" data-name value="${esc(S.team.name)}" maxlength="24" style="width:200px;font-size:16px">
      <div class="stat2"><b>${tr.complete ? tr.rating.toFixed(1) : '—'}</b><span>Team rating</span></div>
      <div class="stat2"><b>${chem.value}</b><span>Chemistry</span></div>
      <div class="stat2"><b>${S.team.w}-${S.team.l}</b><span>Record</span></div>
      <div class="stat2"><b>${S.team.elo}</b><span>Elo</span></div>
      <div class="stat2"><b>${myCards().length}</b><span>Cards</span></div>
      <span class="spacer"></span>
      <div class="seg" data-tabs>${[['squad', 'Squad'], ['packs', 'Packs'], ['play', 'Play'], ['cards', 'My cards']].map(([k, n]) => `<button data-v="${k}" class="${view.tab === k ? 'active' : ''}">${n}</button>`).join('')}</div>
    </div>
    <div data-body></div>
  </div>`;
  root.querySelectorAll('[data-tabs] button').forEach((b) => b.addEventListener('click', () => { view.tab = b.dataset.v; draw(); }));
  root.querySelector('[data-name]').addEventListener('change', (e) => setTeam({ name: e.target.value }));
  const body = root.querySelector('[data-body]');
  ({ squad: drawSquad, packs: drawPacks, play: drawPlay, cards: drawCards })[view.tab](body, lu, tr, chem);
}

// ---- squad ---------------------------------------------------------------------------------------
async function setTeam(changes) {
  const t = { slots: { ...S.team.slots }, bench: [...S.team.bench], ...changes };
  return tryAct('team.set', t);
}

function drawSquad(el, lu, tr, chem) {
  const byUid = new Map(myCards().map((i) => [i.uid, i]));
  const slotCard = (uid, slot, label) => {
    const it = byUid.get(uid);
    return `<div class="slot-wrap"><span class="lbl">${label}</span>${it ? proCardHTML(D.pros[it.id], { uid, slot, extra: `<button class="rm" data-unset="${label}" title="Remove from team">&times;</button>` }) : `<div class="pro-card empty" data-pick="${label}">+ ${label}</div>`}</div>`;
  };
  el.innerHTML = `<div class="pitch">${M.SLOTS.map((s) => slotCard(S.team.slots[s], s, s)).join('')}</div>
    <div class="section-title">Bench</div>
    <div class="cards-row">${[0, 1].map((i) => {
      const it = byUid.get(S.team.bench[i]);
      return it ? proCardHTML(D.pros[it.id], { uid: it.uid, sm: true, extra: `<button class="rm" data-unbench="${i}" title="Remove from bench">&times;</button>` }) : `<div class="pro-card sm empty" data-bench="${i}">+ Bench</div>`;
    }).join('')}</div>
    <div class="open-row" style="margin-top:16px">
      <button class="btn gold" data-auto ${myCards().length ? '' : 'disabled'}>Auto-pick best team</button>
      <span class="muted" style="font-size:12px">Chemistry: +3 per pair from the same roster, +1.5 same team other year, +1 same country, +1 per player in their real role. Off-role players lose rating.</span>
    </div>
    ${chem.links.length ? `<div class="section-title">Links</div><div style="display:flex;flex-wrap:wrap;gap:6px">${chem.links.map(([a, b, why]) => `<span class="chip green">${esc(D.pros[a].n)} + ${esc(D.pros[b].n)}: ${why}</span>`).join('')}</div>` : ''}
    ${!myCards().length ? '<div class="empty">You have no player cards yet. Open a pack on the <b>Packs</b> tab.</div>' : ''}`;
  el.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => chooseCard(b.dataset.pick)));
  el.querySelectorAll('.pitch .pro-card[data-uid]').forEach((c) => c.addEventListener('click', (e) => { if (!e.target.closest('[data-unset]')) chooseCard(c.closest('.slot-wrap').querySelector('.lbl').textContent); }));
  el.querySelectorAll('[data-unset]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); setTeam({ slots: { ...S.team.slots, [b.dataset.unset]: null } }); }));
  el.querySelectorAll('[data-bench]').forEach((b) => b.addEventListener('click', () => chooseCard(null, +b.dataset.bench)));
  el.querySelectorAll('[data-unbench]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); const bench = [...S.team.bench]; bench[+b.dataset.unbench] = null; setTeam({ bench }); }));
  el.querySelector('[data-auto]')?.addEventListener('click', autoPick);
}

function chooseCard(slot, benchIdx = null) {
  const used = inTeam();
  const current = slot ? S.team.slots[slot] : S.team.bench[benchIdx];
  const usedPids = new Set([...used].filter((u) => u !== current).map((u) => D.pros[S.inv.find((i) => i.uid === u)?.id]?.pid));
  const cards = myCards().filter((it) => !usedPids.has(D.pros[it.id].pid))
    .sort((a, b) => (D.pros[b.id].ovr - (slot ? M.roleFit(D.pros[b.id], slot) : 0)) - (D.pros[a.id].ovr - (slot ? M.roleFit(D.pros[a.id], slot) : 0)));
  const m = openModal({ title: slot ? `Pick your ${M.ROLE_NAMES[slot]}` : 'Pick a bench player', cls: 'xwide', body: cards.length ? `<div class="cards-row">${cards.slice(0, 120).map((it) => proCardHTML(D.pros[it.id], { uid: it.uid, sm: true, slot, cls: it.uid === current ? 'selected' : '' })).join('')}</div>` : '<div class="empty">No cards available. Open packs first.</div>' });
  m.el.querySelectorAll('.pro-card[data-uid]').forEach((c) => c.addEventListener('click', async () => {
    const uid = c.dataset.uid;
    const slots = { ...S.team.slots }, bench = [...S.team.bench];
    for (const s of M.SLOTS) if (slots[s] === uid) slots[s] = null;
    for (let i = 0; i < 2; i++) if (bench[i] === uid) bench[i] = null;
    if (slot) slots[slot] = uid; else bench[benchIdx] = uid;
    if (await setTeam({ slots, bench })) { sfx.click(); m.close(); }
  }));
}

async function autoPick() {
  // One card per player (their best), then the best lineup by effective rating.
  const best = new Map();
  for (const it of myCards()) { const p = D.pros[it.id]; if (!best.has(p.pid) || D.pros[best.get(p.pid).id].ovr < p.ovr) best.set(p.pid, it); }
  const cards = [...best.values()];
  const lu = M.autoLineup(cards.map((it) => D.pros[it.id]));
  const uidOf = (p) => cards.find((it) => it.id === p?.id)?.uid || null;
  const slots = Object.fromEntries(M.SLOTS.map((s) => [s, uidOf(lu[s])]));
  const used = new Set(Object.values(slots));
  const rest = cards.filter((it) => !used.has(it.uid)).sort((a, b) => D.pros[b.id].ovr - D.pros[a.id].ovr);
  if (await setTeam({ slots, bench: [rest[0]?.uid || null, rest[1]?.uid || null] })) sfx.buy();
}

// ---- packs ---------------------------------------------------------------------------------------
function drawPacks(el) {
  const evs = M.packEvents();
  if (!view.packEv || !evs.includes(view.packEv)) view.packEv = evs[0];
  el.innerHTML = `<div class="cards-row">${M.PACKS.map((p) => {
    const id = p.perEvent ? `${p.id}:${view.packEv}` : p.id;
    const price = M.packPrice(id);
    const tokens = S.team.tokens[p.id] || 0;
    const tw = p.w.reduce((a, b) => a + b, 0);
    return `<div class="pack" style="--pk:${p.color}">
      <div class="art">★</div><h4>${esc(p.n)}</h4>
      <div class="muted" style="font-size:12px">${p.cards} cards${p.guarantee ? ` · 1 guaranteed ${M.PRO_RARITY[p.guarantee].n}+` : ''}</div>
      ${p.perEvent ? `<select class="input" data-ev>${evs.map((ev) => `<option value="${ev}" ${ev === view.packEv ? 'selected' : ''}>${esc(eventShort(ev))}</option>`).join('')}</select>` : ''}
      <div class="odds2">${M.PRO_RARITY.map((r, i) => (p.w[i] ? `${r.n} ${((p.w[i] / tw) * 100).toFixed(p.w[i] / tw < 0.01 ? 1 : 0)}%` : '')).filter(Boolean).join(' · ')}</div>
      <button class="btn gold" data-buy="${id}" data-p="${price}">Open for ${money(price)}</button>
      ${tokens ? `<button class="btn primary" data-token="${id}">Use token (${tokens})</button>` : ''}
    </div>`;
  }).join('')}</div>
  <p class="muted" style="font-size:12px;margin-top:14px">Win events on the <b>Play</b> tab to earn free pack tokens. Card ratings come from each player's real Major results (team placement, Major wins, peak years).</p>`;
  el.querySelector('[data-ev]')?.addEventListener('change', (e) => { view.packEv = +e.target.value; draw(); });
  el.querySelectorAll('[data-buy]').forEach((b) => b.addEventListener('click', () => openPack(b.dataset.buy, false)));
  el.querySelectorAll('[data-token]').forEach((b) => b.addEventListener('click', () => openPack(b.dataset.token, true)));
  updateAfford();
}
function updateAfford() {
  root?.querySelectorAll('[data-buy][data-p]').forEach((b) => (b.disabled = S.money < +b.dataset.p));
}

let opening = false;
async function openPack(id, token) {
  if (opening) return;
  opening = true;
  const r = await tryAct('team.pack', { pack: id, token });
  opening = false;
  if (!r) return;
  sfx.open();
  const m = openModal({ title: `${esc(M.packById(id).n)}`, cls: 'xwide', body: `<div class="reveal">${r.items.map((it, i) => `<div class="flip" data-i="${i}"><div class="back">★</div><div class="front">${proCardHTML(D.pros[it.id], { uid: it.uid })}</div></div>`).join('')}</div>`,
    foot: '<button class="btn" data-all>Reveal all</button><span class="spacer"></span><button class="btn" data-sell>Sell all</button><button class="btn gold" data-close>Keep</button>' });
  const flip = (el) => {
    if (el.classList.contains('open')) return;
    el.classList.add('open');
    const it = r.items[+el.dataset.i];
    const t = M.proTier(D.pros[it.id].ovr);
    sfx.reveal(t + 2);
    if (t >= 4) setTimeout(() => sfx.gold(), 200);
  };
  m.el.querySelectorAll('.flip').forEach((el) => el.addEventListener('click', () => flip(el)));
  m.el.querySelector('[data-all]').addEventListener('click', () => m.el.querySelectorAll('.flip').forEach((el, i) => setTimeout(() => flip(el), i * 280)));
  m.el.querySelector('[data-sell]').addEventListener('click', async () => {
    const items = r.items.filter((it) => S.inv.some((x) => x.uid === it.uid));
    if (await sellItems(items)) m.close();
  });
}

// ---- play ----------------------------------------------------------------------------------------
function drawPlay(el, lu, tr) {
  if (!tr.complete) {
    el.innerHTML = '<div class="empty">Fill all five roles on the <b>Squad</b> tab to play matches.</div>';
    return;
  }
  if (!view.opps || view.opps.rating !== tr.rating) view.opps = { rating: tr.rating, list: M.suggestOpponents(tr.rating) };
  const cup = S.team.cup;
  el.innerHTML = `<div class="section-title">Quick match</div>
    <div class="opps">${view.opps.list.map((t, i) => `<div class="opp ${['easy', 'even', 'hard'][i]}">
      <div class="muted" style="font-size:11px;letter-spacing:1px;text-transform:uppercase">${['Easier', 'Even', 'Harder'][i]}</div>
      <div style="font-size:16px">${esc(t.name)}</div>
      <div class="rt">${t.rating.toFixed(1)}</div>
      <div class="muted" style="font-size:12px">${M.SLOTS.map((s) => esc(t.lineup[s].n)).join(', ')}</div>
      <div class="muted" style="font-size:12px">Win reward <b class="green">${money(M.matchReward(tr.rating, t.rating, true))}</b></div>
      <button class="btn primary" data-play="${t.key}">Play</button></div>`).join('')}</div>
    <div class="open-row" style="margin-top:8px"><button class="btn sm" data-reroll>Other opponents</button></div>
    <div class="section-title">Events</div>
    ${cup && !cup.done ? bracketHTML(cup) + `<div class="open-row" style="margin-top:12px"><button class="btn gold" data-cupplay>Play next match</button><button class="btn ghost" data-cupleave>Leave event</button></div>`
      : `${cup?.done ? `<div class="panel" style="margin-bottom:12px">Last event: <b>${esc(M.CUPS[cup.type].n)}</b> · finished <b>${M.placeLabel(cup.place)}</b>${cup.place === 1 ? ' 🏆' : ''}</div>` : ''}
      <div class="opps">${Object.entries(M.CUPS).map(([k, c]) => `<div class="opp">
        <div style="font-size:16px">${esc(c.n)}</div><div class="muted" style="font-size:12px">${c.teams} teams, single elimination. Opponents around your rating${k === 'major' ? ', the best rosters' : ''}.</div>
        <div class="muted" style="font-size:12px">Prizes: ${Object.entries(c.prize).map(([p, v]) => `${M.placeLabel(+p)} ${money(v)}`).join(' · ')}<br>Winner also gets a ${esc(M.packById(c.token).n)} token</div>
        <button class="btn gold" data-cup="${k}">Enter</button></div>`).join('')}</div>`}
    ${online() ? '<div class="section-title">Online ladder</div><div data-ladder class="muted">Loading…</div>' : ''}
    ${S.team.history.length ? `<div class="section-title">Recent matches</div><div style="display:flex;flex-direction:column;gap:4px">${S.team.history.map((h) => `<div class="entry"><span class="chip ${h.won ? 'green' : 'red'}">${h.won ? 'W' : 'L'}</span>${esc(h.opp)}<span class="pct">${h.score.join(' - ')}</span></div>`).join('')}</div>` : ''}`;
  el.querySelectorAll('[data-play]').forEach((b) => b.addEventListener('click', () => quickMatch(b.dataset.play)));
  el.querySelector('[data-reroll]').addEventListener('click', () => { view.opps = { rating: tr.rating, list: M.suggestOpponents(tr.rating) }; draw(); });
  el.querySelectorAll('[data-cup]').forEach((b) => b.addEventListener('click', async () => { if (await tryAct('team.cupStart', { type: b.dataset.cup })) sfx.buy(); }));
  el.querySelector('[data-cupplay]')?.addEventListener('click', cupPlay);
  if (online()) drawLadder(el.querySelector('[data-ladder]'));
  el.querySelector('[data-cupleave]')?.addEventListener('click', async () => {
    if (await confirmDialog('Leave this event? You will not get a prize.', { ok: 'Leave', danger: true })) tryAct('team.cupLeave');
  });
}

// Online: other players' saved lineups, ranked by Elo. Challenging plays your team against theirs.
async function drawLadder(el) {
  let list;
  try { list = await net.social('ladder'); } catch (e) { el.textContent = e.message; return; }
  if (!el.isConnected) return;
  el.classList.remove('muted');
  el.innerHTML = `<table class="sb-table" style="max-width:760px"><tr><th>#</th><th>Player</th><th>Team</th><th>Elo</th><th>W-L</th><th></th></tr>
    ${list.map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.name)}</td><td>${esc(p.team)}</td><td>${p.elo}</td><td>${p.w}-${p.l}</td>
      <td>${p.me ? '<span class="chip gold">You</span>' : `<button class="btn sm primary" data-ch="${esc(p.name)}">Challenge</button>`}</td></tr>`).join('')}</table>
    <div class="muted" style="font-size:12px;margin-top:6px">Your team plays their saved lineup. Both Elo ratings change; you earn a reward for wins.</div>`;
  el.querySelectorAll('[data-ch]').forEach((b) => b.addEventListener('click', async () => {
    let r;
    try { r = await net.social('challenge', { name: b.dataset.ch }); } catch (e) { sfx.error(); return toast(esc(e.message), 'bad'); }
    await showMatch(r.match, S.team.name, r.opp.name, `${r.match.winner === 'A' ? 'Win' : 'Loss'} · Elo ${r.elo >= 0 ? '+' : ''}${r.elo}${r.reward ? ' · +' + money(r.reward) : ''}`);
    draw();
  }));
}

function bracketHTML(cup) {
  const rounds = [];
  let field = cup.field;
  for (let r = 0; field.length > 1; r++) {
    const res = cup.results[r];
    const pairs = [];
    for (let i = 0; i < field.length; i += 2) pairs.push([field[i], field[i + 1], res?.find((x) => x.a === field[i])]);
    rounds.push(pairs);
    field = res ? res.map((x) => x.w) : Array(field.length / 2).fill(null);
    if (!res) { for (let k = field.length; k > 1; k /= 2) rounds.push(Array(k / 2).fill([null, null, null])); break; }
  }
  const name = (k) => (k ? esc(M.teamLabel(k)) : '<span class="dim">TBD</span>');
  return `<div class="bracket">${rounds.map((pairs) => `<div class="col">${pairs.map(([a, b, x]) => `<div class="m">
    <div class="${x?.w === a && a ? 'w' : ''} ${a === 'me' ? 'me' : ''}"><span>${name(a)}</span><b>${x ? x.score[0] : ''}</b></div>
    <div class="${x?.w === b && b ? 'w' : ''} ${b === 'me' ? 'me' : ''}"><span>${name(b)}</span><b>${x ? x.score[1] : ''}</b></div></div>`).join('')}</div>`).join('')}</div>`;
}

async function quickMatch(key) {
  const r = await tryAct('team.match', { opp: key });
  if (!r) return;
  await showMatch(r.match, S.team.name, r.opp.name, r.reward ? `${r.match.winner === 'A' ? 'Win' : 'Loss'} · +${money(r.reward)}` : '');
  view.opps = null;
  draw();
}
async function cupPlay() {
  const r = await tryAct('team.cupPlay');
  if (!r) return;
  const c = r.cup;
  let note = '';
  if (c.done) note = c.place === 1 ? `Champions! +${money(r.prize)}${r.token ? ' and a ' + M.packById(r.token).n + ' token' : ''}` : `Knocked out · ${M.placeLabel(c.place)}${r.prize ? ' · +' + money(r.prize) : ''}`;
  await showMatch(r.match, S.team.name, r.oppName, note);
  if (c.done && c.place === 1) sfx.gold();
  draw();
}

// Round-by-round match viewer.
function showMatch(match, nameA, nameB, note) {
  return new Promise((resolve) => {
    const m = openModal({ title: 'Match', cls: 'xwide', body: `<div class="match">
      <div class="scoreboard">
        <div class="score-big"><span class="tn">${esc(nameA)}</span><span data-sa>0</span>:<span data-sb>0</span><span class="tn">${esc(nameB)}</span></div>
        <div class="rounds-bar" data-rb></div>
        <div data-final></div>
      </div>
      <div class="killfeed" data-feed></div></div>`, foot: '<button class="btn" data-skip>Skip</button><span class="spacer"></span><button class="btn ghost" data-close>Close</button>', onClose: resolve });
    const sa = m.el.querySelector('[data-sa]'), sb = m.el.querySelector('[data-sb]'), rb = m.el.querySelector('[data-rb]'), feed = m.el.querySelector('[data-feed]');
    const namesA = new Set(match.players.slice(0, 5).map((p) => p.n));
    let i = 0, timer = null;
    const step = () => {
      if (!m.el.isConnected) return;
      if (i >= match.rounds.length) return finish();
      const r = match.rounds[i++];
      sa.textContent = r.score[0]; sb.textContent = r.score[1];
      rb.insertAdjacentHTML('beforeend', `<i class="${r.w === 'A' ? 'a' : 'b'}"></i>`);
      feed.insertAdjacentHTML('beforeend', `<div class="rnd">Round ${i} · ${r.w === 'A' ? esc(nameA) : esc(nameB)}</div>` + r.feed.map((k) => `<div class="k"><span class="${namesA.has(k.k) ? 'a' : 'b'}">${esc(k.k)}</span> ${k.awp ? '▬' : '➔'}${k.hs ? ' ◎' : ''} <span class="${namesA.has(k.v) ? 'a' : 'b'}">${esc(k.v)}</span>${k.trade ? ' <span class="dim">(traded)</span>' : ''}</div>`).join(''));
      feed.scrollTop = feed.scrollHeight;
      if (i % 3 === 0) sfx.tick();
      timer = setTimeout(step, S.settings.fast ? 140 : 420);
    };
    const finish = () => {
      clearTimeout(timer);
      sa.textContent = match.score[0]; sb.textContent = match.score[1];
      if (rb.children.length < match.rounds.length) rb.innerHTML = match.rounds.map((r) => `<i class="${r.w === 'A' ? 'a' : 'b'}"></i>`).join('');
      const won = match.winner === 'A';
      won ? sfx.coin() : sfx.error();
      const rows = (list) => list.sort((a, b) => b.k - a.k).map((p) => `<tr><td>${esc(p.n)}</td><td>${p.k}</td><td>${p.d}</td><td>${p.adr}</td></tr>`).join('');
      m.el.querySelector('[data-final]').innerHTML = `<div class="bigval ${won ? 'green' : 'red'}" style="text-align:center">${won ? 'Victory' : 'Defeat'}${match.overtime ? ' (overtime)' : ''}</div>
        ${note ? `<div style="text-align:center" class="muted">${esc(note)}</div>` : ''}
        <table class="sb-table" style="margin-top:10px"><tr><th>${esc(nameA)}</th><th>K</th><th>D</th><th>ADR</th></tr>${rows(match.players.slice(0, 5))}
        <tr><th>${esc(nameB)}</th><th>K</th><th>D</th><th>ADR</th></tr>${rows(match.players.slice(5))}</table>`;
      m.el.querySelector('[data-skip]')?.remove();
    };
    m.el.querySelector('[data-skip]').addEventListener('click', () => { clearTimeout(timer); finish(); });
    step();
  });
}

// ---- my cards ------------------------------------------------------------------------------------
function drawCards(el) {
  const used = inTeam();
  let cards = myCards();
  if (view.q) cards = cards.filter((it) => (D.pros[it.id].n + ' ' + M.proTeamName(D.pros[it.id])).toLowerCase().includes(view.q));
  if (view.role !== 'all') cards = cards.filter((it) => D.pros[it.id].role === view.role);
  if (view.tier !== 'all') cards = cards.filter((it) => String(M.proTier(D.pros[it.id].ovr)) === view.tier);
  cards.sort((a, b) => D.pros[b.id].ovr - D.pros[a.id].ovr);
  el.innerHTML = `<div class="toolbar">
      <input class="input" type="search" placeholder="Search players or teams…" value="${esc(view.q)}">
      <select class="input" data-k="role"><option value="all">All roles</option>${Object.keys(M.ROLE_NAMES).map((r) => `<option value="${r}" ${view.role === r ? 'selected' : ''}>${M.ROLE_NAMES[r]}</option>`).join('')}</select>
      <select class="input" data-k="tier"><option value="all">All rarities</option>${M.PRO_RARITY.map((r, i) => `<option value="${i}" ${view.tier === String(i) ? 'selected' : ''}>${r.n}</option>`).join('')}</select>
      <span class="spacer"></span><button class="btn" data-dupes>Sell duplicates</button>
    </div>
    ${cards.length ? `<div class="cards-row">${cards.slice(0, 300).map((it) => proCardHTML(D.pros[it.id], { uid: it.uid, sm: true, extra: `<div style="text-align:center;padding:0 0 8px;font-size:11px">${used.has(it.uid) ? '<span class="chip gold">In team</span>' : `<span class="green">${money(I.itemValue(it))}</span>`}</div>` })).join('')}</div>` : '<div class="empty">No cards match.</div>'}`;
  const q = el.querySelector('input[type=search]');
  q.addEventListener('input', () => { view.q = q.value.toLowerCase(); draw(); const n = root.querySelector('[data-body] input[type=search]'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); });
  el.querySelectorAll('select[data-k]').forEach((s) => s.addEventListener('change', () => { view[s.dataset.k] = s.value; draw(); }));
  el.querySelectorAll('.pro-card[data-uid]').forEach((c) => c.addEventListener('click', async () => {
    const it = S.inv.find((i) => i.uid === c.dataset.uid);
    if (!it) return;
    if (used.has(it.uid)) return toast('Remove this card from your team before selling it.', 'bad');
    await sellItems([it]);
  }));
  el.querySelector('[data-dupes]').addEventListener('click', async () => {
    const best = new Map();
    for (const it of myCards()) { const p = D.pros[it.id]; const cur = best.get(p.pid); if (!cur || D.pros[cur.id].ovr < p.ovr || used.has(it.uid)) best.set(p.pid, used.has(cur?.uid) ? cur : it); }
    const keep = new Set([...best.values()].map((i) => i.uid));
    const sell = myCards().filter((it) => !keep.has(it.uid) && !used.has(it.uid) && !it.lk);
    if (!sell.length) return toast('No duplicate players to sell.', '');
    await sellItems(sell);
  });
}
