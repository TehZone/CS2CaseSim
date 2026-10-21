// Gambling: case battles, coinflip and jackpot. Against bots offline; online there are also live lobbies with
// other players (see net/online.js). Every round is provably fair. Virtual money only.
import { esc, money, imgUrl } from '../util.js';
import { D, casePrice } from '../data.js';
import * as I from '../items.js';
import { S, on } from '../state.js';
import { sfx } from '../audio.js';
import { tryAct, toast, openModal, showItemDetail } from '../ui.js';
import { online } from '../backend.js';
import { mountPicker } from '../picker.js';
import { caseImage } from './cases.js';
import * as G from '../engine/gamble.js';
import { net } from '../net/online.js';

const randSeed = () => Math.random().toString(36).slice(2, 12);
const view = {
  tab: 'battles',
  battle: { format: '1v1', mode: 'normal', cases: {}, q: '' },
  flip: { money: 1, side: 'ct' },
  jackpot: { money: 1, bots: 3 },
  seed: randSeed(),
};
const stake = { flip: new Set(), jackpot: new Set() };
let root = null, offs = [], busy = false;

export function render(r) {
  root = r;
  offs.forEach((o) => o());
  offs = [on('inv', () => !busy && draw()), on('money', () => updateCost()), net.on('lobbies', () => !busy && drawLobbies())];
  draw();
}
export function destroy() { offs.forEach((o) => o()); offs = []; root = null; }

const stakeItems = (which) => [...stake[which]].map((u) => S.inv.find((i) => i.uid === u)).filter(Boolean);
const stakeValue = (which) => round(+view[which].money || 0) + stakeItems(which).reduce((s, it) => s + I.itemValue(it), 0);
const round = (v) => Math.round(v * 100) / 100;

function draw() {
  if (!root) return;
  for (const k of ['flip', 'jackpot']) for (const u of stake[k]) if (!S.inv.some((i) => i.uid === u && !i.lk)) stake[k].delete(u);
  root.innerHTML = `<div class="page">
    <div class="page-head"><h1>Gamble</h1><span class="sub">Case battles, coinflip and jackpot${online() ? ' against other players or bots' : ' against bots (go online to play other people)'}. Provably fair, virtual money only, no house edge.</span></div>
    <div class="toolbar">
      <div class="seg" data-tabs>${[['battles', 'Case Battles'], ['coinflip', 'Coinflip'], ['jackpot', 'Jackpot']].map(([k, n]) => `<button data-v="${k}" class="${view.tab === k ? 'active' : ''}">${n}</button>`).join('')}</div>
      <span class="spacer"></span>
      <label class="check" title="Mixed into every result so the server can't pick outcomes">Client seed <input class="input" data-seed value="${esc(view.seed)}" style="width:130px"></label>
      <button class="btn sm" data-reseed>New seed</button>
    </div>
    <div data-body></div>
    <div data-lobbies></div>
  </div>`;
  root.querySelectorAll('[data-tabs] button').forEach((b) => b.addEventListener('click', () => { view.tab = b.dataset.v; draw(); }));
  root.querySelector('[data-seed]').addEventListener('change', (e) => { view.seed = e.target.value.trim().slice(0, 64) || randSeed(); });
  root.querySelector('[data-reseed]').addEventListener('click', () => { view.seed = randSeed(); draw(); });
  const body = root.querySelector('[data-body]');
  if (view.tab === 'battles') drawBattleBuilder(body);
  if (view.tab === 'coinflip') drawFlip(body);
  if (view.tab === 'jackpot') drawJackpot(body);
  drawLobbies();
}

// ---- case battles ------------------------------------------------------------------------------
const battleCases = () => Object.entries(view.battle.cases).flatMap(([id, n]) => Array(n).fill(id));
function drawBattleBuilder(el) {
  const b = view.battle;
  const list = D.cases.filter((c) => c.price != null && ['case', 'souvenir', 'package', 'capsule', 'autograph', 'agents', 'chickens'].includes(c.kind))
    .filter((c) => !b.q || c.n.toLowerCase().includes(b.q))
    .sort((a, c) => (b.cases[c.id] || 0) - (b.cases[a.id] || 0) || casePrice(a) - casePrice(c));
  const cases = battleCases();
  const cost = cases.length ? G.battleCost(cases) : 0;
  el.innerHTML = `<div class="two-col">
    <div class="panel">
      <h3>New battle</h3>
      <div style="display:grid;gap:12px">
        <div><div class="muted" style="font-size:12px;margin-bottom:4px">Players</div><div class="seg" data-fmt>${Object.keys(G.BATTLE_FORMATS).map((f) => `<button data-v="${f}" class="${b.format === f ? 'active' : ''}">${f}</button>`).join('')}</div></div>
        <div><div class="muted" style="font-size:12px;margin-bottom:4px">Mode</div><div class="seg" data-mode>${Object.entries(G.BATTLE_MODES).map(([k, n]) => `<button data-v="${k}" class="${b.mode === k ? 'active' : ''}" title="${esc(n)}">${k === 'normal' ? 'Normal' : 'Crazy'}</button>`).join('')}</div>
          <div class="muted" style="font-size:12px;margin-top:4px">${esc(G.BATTLE_MODES[b.mode])}. The winner${b.format === '2v2' ? 'ning team' : ''} takes every item opened.</div></div>
        <div class="muted">${cases.length} round${cases.length === 1 ? '' : 's'} · each player pays <b class="green" data-cost>${money(cost)}</b></div>
        <div class="open-row">
          <button class="btn gold big" data-bots ${cases.length ? '' : 'disabled'}>Battle vs bots</button>
          ${online() ? `<button class="btn primary big" data-create ${cases.length ? '' : 'disabled'}>Create lobby</button>` : ''}
          ${cases.length ? '<button class="btn ghost" data-clear>Clear</button>' : ''}
        </div>
      </div>
    </div>
    <div>
      <div class="toolbar"><input class="input" type="search" placeholder="Search cases…" value="${esc(b.q)}"><span class="muted" style="font-size:12px">Up to ${G.MAX_BATTLE_ROUNDS} rounds</span></div>
      <div class="case-pick">${list.slice(0, 160).map((c) => `<div class="cp ${b.cases[c.id] ? 'on' : ''}">
        <img loading="lazy" src="${caseImage(c)}"><div class="n" title="${esc(c.n)}">${esc(c.n)}</div><div class="green">${money(casePrice(c))}</div>
        <div class="ctl"><button class="btn sm" data-dec="${c.id}">−</button><span class="cnt">${b.cases[c.id] || 0}</span><button class="btn sm" data-inc="${c.id}">+</button></div></div>`).join('')}</div>
    </div>
  </div>`;
  el.querySelectorAll('[data-fmt] button').forEach((x) => x.addEventListener('click', () => { b.format = x.dataset.v; draw(); }));
  el.querySelectorAll('[data-mode] button').forEach((x) => x.addEventListener('click', () => { b.mode = x.dataset.v; draw(); }));
  el.querySelectorAll('[data-inc]').forEach((x) => x.addEventListener('click', () => {
    if (battleCases().length >= G.MAX_BATTLE_ROUNDS) return toast(`At most ${G.MAX_BATTLE_ROUNDS} rounds`, 'bad');
    b.cases[x.dataset.inc] = (b.cases[x.dataset.inc] || 0) + 1; draw();
  }));
  el.querySelectorAll('[data-dec]').forEach((x) => x.addEventListener('click', () => {
    const id = x.dataset.dec;
    if (b.cases[id]) { b.cases[id]--; if (!b.cases[id]) delete b.cases[id]; draw(); }
  }));
  el.querySelector('[data-clear]')?.addEventListener('click', () => { b.cases = {}; draw(); });
  el.querySelector('[data-bots]')?.addEventListener('click', () => botBattle());
  el.querySelector('[data-create]')?.addEventListener('click', async () => {
    const r = await net.gamble('battle.create', { cases: battleCases(), format: b.format, mode: b.mode, clientSeed: view.seed }).catch((e) => toast(esc(e.message), 'bad'));
    if (r) toast('Lobby created. Waiting for players (you can add bots to empty seats).', 'good');
  });
  const q = el.querySelector('input[type=search]');
  q.addEventListener('input', () => { b.q = q.value.toLowerCase(); draw(); const n = root.querySelector('[data-body] input[type=search]'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); });
}
function updateCost() {
  const el = root?.querySelector('[data-cost]');
  if (el) el.classList.toggle('red', S.money < G.battleCost(battleCases()));
}

async function botBattle() {
  if (busy) return;
  const b = view.battle;
  const cases = battleCases();
  if (S.money + 1e-9 < G.battleCost(cases)) { sfx.error(); return toast('Not enough money for this battle', 'bad'); }
  busy = true;
  const r = await tryAct('gamble.battle', { cases, format: b.format, mode: b.mode, clientSeed: view.seed });
  if (!r) { busy = false; return; }
  try { await playBattle(r, 0); } finally { busy = false; }
}

// Plays a battle result (from a bot battle or a live lobby). mySeat: index of the local player, or -1 to spectate.
export async function playBattle(r, mySeat) {
  const f = G.BATTLE_FORMATS[r.format];
  const fast = S.settings.fast;
  const m = openModal({ title: `Case battle · ${r.format} · ${r.mode === 'crazy' ? 'Crazy' : 'Normal'}`, cls: 'xwide', body: '', foot: '<button class="btn" data-skip>Skip</button><span class="spacer"></span><button class="btn" data-verify>Verify fairness</button><button class="btn ghost" data-close>Close</button>' });
  const body = m.el.querySelector('.modal-body');
  const teamOf = (seat) => f.teams.findIndex((t) => t.includes(seat));
  body.innerHTML = `<div class="battle">
    <div class="round-info" data-round>Round 0 / ${r.cases.length}</div>
    <div class="battle-seats" style="grid-template-columns:repeat(${f.seats}, 1fr)">${r.seats.map((p, i) => `<div class="seat" data-seat="${i}">
      <div class="who"><span class="avatar" style="--c:${p.color || '#2d6cdf'}">${p.avatar ? `<img src="${imgUrl(p.avatar, 's')}" alt="">` : esc((p.name || '?').replace(/^bot /i, '').slice(0, 2).toUpperCase())}</span>
        <div><div>${esc(i === mySeat ? 'You' : p.name)}</div><div class="muted" style="font-size:10px">${f.teams.length === 2 && f.seats === 4 ? 'Team ' + (teamOf(i) + 1) : p.bot ? 'Bot' : 'Player'}</div></div>
        <span class="tot" data-tot>$0.00</span></div>
      <div class="vreel"><div class="strip-v"></div></div>
      <div class="drops"></div></div>`).join('')}</div>
    <div data-summary></div>
  </div>`;
  let skip = false;
  m.el.querySelector('[data-skip]').addEventListener('click', () => { skip = true; });
  m.el.querySelector('[data-verify]').addEventListener('click', () => verifyModal('battle', r));
  const seatEls = [...body.querySelectorAll('.seat')];
  const totals = r.seats.map(() => 0);
  for (let ri = 0; ri < r.rounds.length; ri++) {
    if (!m.el.isConnected) return;
    body.querySelector('[data-round]').textContent = `Round ${ri + 1} / ${r.cases.length} · ${D.caseById[r.cases[ri]]?.n || ''}`;
    const box = D.caseById[r.cases[ri]];
    if (!skip) await Promise.all(r.rounds[ri].map((it, seat) => spinVertical(seatEls[seat].querySelector('.vreel'), box, it, fast ? 1100 : 2400, seat === 0)));
    r.rounds[ri].forEach((it, seat) => {
      totals[seat] += I.itemValue(it);
      seatEls[seat].querySelector('[data-tot]').textContent = money(totals[seat]);
      const rr = I.rarityInfo(it);
      seatEls[seat].querySelector('.drops').insertAdjacentHTML('beforeend', `<div class="d" style="--rc:${rr.c}" title="${esc(I.itemName(it))}"><img src="${I.itemImage(it, 's')}">${money(I.itemValue(it))}</div>`);
    });
    if (!skip) {
      sfx.reveal(Math.max(...r.rounds[ri].map((it) => I.rarityRank(it))));
      await wait(fast ? 250 : 600);
    }
  }
  seatEls.forEach((el, i) => el.classList.add(r.winners.includes(i) ? 'win' : 'lose'));
  const mine = mySeat >= 0 && r.winners.includes(mySeat);
  const prize = mySeat >= 0 ? r.share[mySeat] || [] : [];
  const value = prize.reduce((s, it) => s + I.itemValue(it), 0);
  if (mine && prize.some((it) => I.rarityRank(it) >= 6)) sfx.gold();
  else if (mine) sfx.coin();
  body.querySelector('[data-summary]').innerHTML = `<div class="panel" style="text-align:center;margin-top:8px">
    <div class="bigval ${mine ? 'green' : mySeat >= 0 ? 'red' : ''}">${mySeat < 0 ? `${esc(r.winners.map((s) => r.seats[s].name).join(' & '))} won` : mine ? `You won ${money(value)}!` : 'You lost this battle'}</div>
    <div class="muted" style="margin-top:4px">${r.tiebreak ? 'Tie broken by the fair seed. ' : ''}Team totals: ${r.teamTotals.map(money).join(' vs ')} · Cost ${money(r.cost ?? G.battleCost(r.cases))} per player</div>
    ${mine && prize.length ? `<div class="drops" style="justify-content:center;display:flex;flex-wrap:wrap;gap:6px;margin-top:10px">${prize.map((it) => `<div class="d" data-uid="${it.uid}" style="--rc:${I.rarityInfo(it).c};width:72px;cursor:pointer"><img src="${I.itemImage(it, 's')}" style="width:100%">${money(I.itemValue(it))}</div>`).join('')}</div>` : ''}
  </div>`;
  body.querySelectorAll('[data-summary] [data-uid]').forEach((d) => d.addEventListener('click', () => {
    const it = S.inv.find((i) => i.uid === d.dataset.uid);
    if (it) showItemDetail(it);
  }));
  m.el.querySelector('[data-skip]').remove();
}

const wait = (ms) => new Promise((res) => setTimeout(res, ms));
function vslot(it) {
  const r = I.rarityInfo(it);
  return `<div class="vs" style="--rc:${r.c}"><img src="${I.itemImage(it, 's')}"><div class="sn">${esc(I.nameParts(it).bottom)}</div></div>`;
}
function spinVertical(reelEl, box, item, dur, ticks) {
  return new Promise((res) => {
    const strip = reelEl.querySelector('.strip-v');
    const N = 28, WIN = 24, H = 95;
    const entries = Array.from({ length: N }, (_, i) => (i === WIN ? item : I.fakeRoll(box)));
    strip.innerHTML = entries.map(vslot).join('');
    const target = WIN * H - (reelEl.clientHeight / 2 - H / 2) + (Math.random() - 0.5) * H * 0.5;
    const t0 = performance.now();
    let last = -1;
    const step = (now) => {
      const t = Math.min(1, (now - t0) / dur);
      const y = (1 - Math.pow(1 - t, 4)) * target;
      strip.style.transform = `translateY(${-y}px)`;
      const idx = Math.floor(y / H);
      if (ticks && idx !== last && t < 1) { last = idx; sfx.tick(); }
      if (t < 1) requestAnimationFrame(step); else res();
    };
    requestAnimationFrame(step);
  });
}

// ---- coinflip ----------------------------------------------------------------------------------
function stakePanel(which, extra = '') {
  return `<div style="display:grid;gap:10px">
    <label class="check">Money <input class="input" type="number" min="0" step="0.01" data-money value="${view[which].money}" style="width:110px"></label>
    <div class="muted" style="font-size:12px">Add items to your stake (locked items are hidden):</div>
    <div data-picker></div>
    ${extra}
    <div class="muted">Total stake <b class="green" data-stake>${money(stakeValue(which))}</b></div>
  </div>`;
}
function wireStake(el, which, after) {
  el.querySelector('[data-money]').addEventListener('input', (e) => { view[which].money = Math.max(0, +e.target.value || 0); el.querySelector('[data-stake]').textContent = money(stakeValue(which)); after?.(); });
  mountPicker(el.querySelector('[data-picker]'), {
    items: () => S.inv.filter((i) => !i.lk), selected: stake[which], empty: 'No unlocked items',
    onChange: () => { el.querySelector('[data-stake]').textContent = money(stakeValue(which)); after?.(); },
  });
}

function drawFlip(el) {
  const f = view.flip;
  el.innerHTML = `<div class="two-col">
    <div class="panel">
      <h3>Coinflip</h3>
      <div class="side-pick"><button class="ct ${f.side === 'ct' ? 'on' : ''}" data-side="ct">CT</button><button class="t ${f.side === 't' ? 'on' : ''}" data-side="t">T</button></div>
      <div class="coin-stage"><div class="coin" data-coin><div class="face ct">CT</div><div class="face t">T</div></div></div>
      <div class="open-row" style="justify-content:center">
        <button class="btn gold big" data-flip>Flip vs bot</button>
        ${online() ? '<button class="btn primary big" data-create>Create lobby</button>' : ''}
      </div>
      <div class="muted" style="font-size:12px;text-align:center;margin-top:8px">A bot matches your stake. 50/50, winner takes both.</div>
    </div>
    <div class="panel">${stakePanel('flip')}</div>
  </div>`;
  el.querySelectorAll('[data-side]').forEach((b) => b.addEventListener('click', () => { f.side = b.dataset.side; draw(); }));
  wireStake(el, 'flip');
  el.querySelector('[data-flip]').addEventListener('click', () => doFlip(el));
  el.querySelector('[data-create]')?.addEventListener('click', async () => {
    const r = await net.gamble('flip.create', { money: f.money, uids: [...stake.flip], side: f.side, clientSeed: view.seed }).catch((e) => toast(esc(e.message), 'bad'));
    if (r) { stake.flip.clear(); toast('Coinflip lobby created. Waiting for an opponent…', 'good'); }
  });
}

export function animateCoin(coin, result) {
  return new Promise((res) => {
    const spins = 6 + Math.floor(Math.random() * 3);
    coin.style.transition = 'none';
    coin.style.transform = 'rotateY(0deg)';
    void coin.offsetWidth;
    coin.style.transition = `transform ${S.settings.fast ? 1.2 : 2.6}s cubic-bezier(.15,.7,.25,1)`;
    coin.style.transform = `rotateY(${spins * 360 + (result === 'ct' ? 0 : 180)}deg)`;
    setTimeout(res, S.settings.fast ? 1250 : 2650);
  });
}

async function doFlip(el) {
  if (busy) return;
  const f = view.flip;
  if (stakeValue('flip') < 0.01) return toast('Stake some money or items first', 'bad');
  busy = true;
  const r = await tryAct('gamble.coinflip', { money: f.money, uids: [...stake.flip], side: f.side, clientSeed: view.seed });
  if (!r) { busy = false; return; }
  stake.flip.clear();
  sfx.open();
  await animateCoin(el.querySelector('[data-coin]'), r.result);
  busy = false;
  if (r.won) { sfx.coin(); toast(`It's ${r.result.toUpperCase()}! You beat ${esc(r.bot.name)} and won <b class="green">${money(r.value * 2)}</b>`, 'good'); }
  else { sfx.error(); toast(`It's ${r.result.toUpperCase()}. ${esc(r.bot.name)} takes the pot of ${money(r.value * 2)}.`, 'bad'); }
  const stage = el.querySelector('.coin-stage');
  stage?.insertAdjacentHTML('afterend', '<div style="text-align:center"><button class="btn sm" data-ver>Verify fairness</button></div>');
  el.querySelector('[data-ver]')?.addEventListener('click', () => verifyModal('coinflip', r));
}

// ---- jackpot -----------------------------------------------------------------------------------
function drawJackpot(el) {
  const j = view.jackpot;
  el.innerHTML = `<div class="two-col">
    <div class="panel">
      <h3>Jackpot</h3>
      <div class="jp-reel"><div class="track" data-track></div></div>
      <div class="jp-bar" data-bar></div>
      <div class="entries" data-entries><div class="muted" style="font-size:12px">Everyone adds money or items to the pot. Your chance to win the whole pot is your share of it.</div></div>
      <div class="open-row" style="margin-top:12px">
        <label class="check">Bots <select class="input" data-botn>${[1, 2, 3, 4, 5, 6, 7].map((n) => `<option ${j.bots === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <button class="btn gold big" data-play>Play vs bots</button>
        ${online() ? '<button class="btn primary big" data-join>Join live pot</button>' : ''}
      </div>
    </div>
    <div class="panel">${stakePanel('jackpot')}</div>
  </div>`;
  wireStake(el, 'jackpot');
  el.querySelector('[data-botn]').addEventListener('change', (e) => { j.bots = +e.target.value; });
  el.querySelector('[data-play]').addEventListener('click', () => doJackpot(el));
  el.querySelector('[data-join]')?.addEventListener('click', async () => {
    const r = await net.gamble('jackpot.join', { money: j.money, uids: [...stake.jackpot], clientSeed: view.seed }).catch((e) => toast(esc(e.message), 'bad'));
    if (r) { stake.jackpot.clear(); toast('You joined the live pot. Good luck!', 'good'); }
  });
}

const COLORS = ['#2d6cdf', '#d9480f', '#2b8a3e', '#ae3ec9', '#e8590c', '#1098ad', '#c2255c', '#5c940d'];
export function drawEntries(el, entries, total, meName = 'You') {
  el.querySelector('[data-bar]').innerHTML = entries.map((e, i) => `<i style="--c:${e.color || COLORS[i % COLORS.length]};width:${(e.value / total) * 100}%"></i>`).join('');
  el.querySelector('[data-entries]').innerHTML = entries.map((e, i) => `<div class="entry"><span class="avatar" style="--c:${e.color || COLORS[i % COLORS.length]}">${esc((e.name || '?').replace(/^bot /i, '').slice(0, 2).toUpperCase())}</span>
    <span>${esc(e.id === 'me' ? meName : e.name)}</span><span class="green">${money(e.value)}</span><span class="pct">${((e.value / total) * 100).toFixed(1)}%</span></div>`).join('');
}
export function spinJackpot(el, entries, winnerId, total) {
  return new Promise((res) => {
    const track = el.querySelector('[data-track]');
    const N = 64, WIN = 54, W = 86;
    const tiles = [];
    for (let i = 0; i < N; i++) {
      if (i === WIN) { tiles.push(entries.find((e) => e.id === winnerId)); continue; }
      let x = Math.random() * total, pick = entries[0];
      for (const e of entries) { if ((x -= e.value) < 0) { pick = e; break; } }
      tiles.push(pick);
    }
    track.innerHTML = tiles.map((e) => { const i = entries.indexOf(e); return `<div class="ent" style="--c:${e.color || COLORS[i % COLORS.length]}"><b>${esc((e.name || '?').replace(/^bot /i, '').slice(0, 10))}</b>${money(e.value)}</div>`; }).join('');
    const box = el.querySelector('.jp-reel');
    const target = WIN * W + 40 - box.clientWidth / 2 + (Math.random() - 0.5) * 50;
    const dur = S.settings.fast ? 2200 : 5200, t0 = performance.now();
    let last = -1;
    const step = (now) => {
      const t = Math.min(1, (now - t0) / dur);
      const x = (1 - Math.pow(1 - t, 4.2)) * target;
      track.style.transform = `translateX(${-x}px)`;
      const idx = Math.floor(x / W);
      if (idx !== last && t < 1) { last = idx; sfx.tick(); }
      if (t < 1) requestAnimationFrame(step); else res();
    };
    requestAnimationFrame(step);
  });
}

async function doJackpot(el) {
  if (busy) return;
  const j = view.jackpot;
  if (stakeValue('jackpot') < 0.01) return toast('Stake some money or items first', 'bad');
  busy = true;
  const r = await tryAct('gamble.jackpot', { money: j.money, uids: [...stake.jackpot], bots: j.bots, clientSeed: view.seed });
  if (!r) { busy = false; return; }
  stake.jackpot.clear();
  drawEntries(el, r.entries, r.total);
  sfx.open();
  await spinJackpot(el, r.entries, r.winner, r.total);
  busy = false;
  const w = r.entries.find((e) => e.id === r.winner);
  if (r.won) { sfx.coin(); toast(`You won the jackpot: <b class="green">${money(r.total)}</b>!`, 'good'); }
  else toast(`${esc(w.name)} won the ${money(r.total)} pot with ${((w.value / r.total) * 100).toFixed(1)}%.`, 'bad');
  el.querySelector('[data-entries]').insertAdjacentHTML('afterend', '<button class="btn sm" data-ver style="margin-top:8px">Verify fairness</button>');
  el.querySelector('[data-ver]').addEventListener('click', () => verifyModal('jackpot', r));
}

// ---- provably fair -------------------------------------------------------------------------------
export function verifyModal(kind, r) {
  const f = r.fair;
  let check = '';
  if (kind === 'coinflip') check = `Result from seeds: <b>${G.coinflipResult(f.serverSeed, f.clientSeed).toUpperCase()}</b> (game said ${r.result.toUpperCase()})`;
  if (kind === 'jackpot') {
    const v = G.jackpotWinner(r.entries.map((e) => ({ id: e.id, value: e.value })), f.serverSeed, f.clientSeed);
    check = `Winning ticket ${v.ticket.toFixed(2)} of ${v.total.toFixed(2)} → <b>${esc(r.entries.find((e) => e.id === v.winner)?.name || v.winner)}</b>`;
  }
  if (kind === 'battle') {
    const again = G.runBattle({ cases: r.cases, format: r.format, mode: r.mode }, f, I.itemValue);
    const same = JSON.stringify(again.rounds.map((x) => x.map((i) => [i.id, i.fl, i.sd]))) === JSON.stringify(r.rounds.map((x) => x.map((i) => [i.id, i.fl, i.sd])));
    check = same ? '<b class="green">Every drop matches the seeds.</b>' : '<b class="red">Mismatch!</b>';
  }
  const hashOk = G.sha256Hex(f.serverSeed) === f.hash;
  openModal({
    title: 'Provably fair',
    body: `<div style="display:grid;gap:10px;font-size:13px;line-height:1.5">
      <div>Before the round the server committed to <b>SHA-256(server seed)</b>. After it, the seed is revealed so you can recompute everything.</div>
      <div><div class="muted">Server seed hash (shown before the round)</div><div class="fair">${esc(f.hash)}</div></div>
      <div><div class="muted">Server seed (revealed)</div><div class="fair">${esc(f.serverSeed)}</div></div>
      <div><div class="muted">Client seed</div><div class="fair">${esc(f.clientSeed)}</div></div>
      <div>Hash matches seed: ${hashOk ? '<b class="green">yes</b>' : '<b class="red">no</b>'}</div>
      <div>${check}</div>
      <div class="muted" style="font-size:12px">Floats come from HMAC-SHA256(server seed, "client seed:nonce:cursor"), 4 bytes per float.</div>
    </div>`,
  });
}

// ---- live lobbies (online) ------------------------------------------------------------------------
function drawLobbies() {
  const el = root?.querySelector('[data-lobbies]');
  if (!el) return;
  if (!online()) { el.innerHTML = ''; return; }
  const L = net.lobbies();
  const section = (title, html) => `<div class="section-title">${title}</div>${html}`;
  let html = '';
  if (view.tab === 'battles') {
    html = section(`Live battles (${L.battles.length})`, L.battles.length ? `<div class="lobbies">${L.battles.map((b) => `<div class="lobby">
      <b>${esc(b.format)}</b><span class="chip">${b.mode === 'crazy' ? 'Crazy' : 'Normal'}</span>
      <span class="muted">${b.cases.length} rounds · ${money(b.cost)} each</span>
      <span>${b.seats.map((p, i) => `<span class="chip ${p ? 'green' : ''}">${p ? esc(p.name) : `<a href="#" data-join-b="${b.id}" data-seat="${i}">Join</a>`}</span>`).join(' ')}</span>
      <span class="spacer"></span>
      ${b.mine ? `<button class="btn sm" data-bot-b="${b.id}">Fill with bots</button><button class="btn sm ghost" data-cancel-b="${b.id}">Cancel</button>` : ''}
    </div>`).join('')}</div>` : '<div class="muted">No open battles. Create one above.</div>');
  }
  if (view.tab === 'coinflip') {
    html = section(`Live coinflips (${L.flips.length})`, L.flips.length ? `<div class="lobbies">${L.flips.map((c) => `<div class="lobby">
      <span class="chip ${c.side === 'ct' ? '' : 'gold'}">${esc(c.side.toUpperCase())}</span><b>${esc(c.name)}</b>
      <span class="green">${money(c.value)}</span><span class="muted">${c.items} item${c.items === 1 ? '' : 's'} · join with ${money(c.value * 0.95)} – ${money(c.value * 1.05)}</span>
      <span class="spacer"></span>
      ${c.mine ? `<button class="btn sm" data-bot-f="${c.id}">Call a bot</button><button class="btn sm ghost" data-cancel-f="${c.id}">Cancel</button>` : `<button class="btn sm primary" data-join-f="${c.id}">Join with my stake</button>`}
    </div>`).join('')}</div>` : '<div class="muted">No open coinflips.</div>');
  }
  if (view.tab === 'jackpot') {
    const j = L.jackpot;
    html = section('Live pot', j && j.entries.length ? `<div class="panel" data-livejp><div class="jp-reel"><div class="track" data-track></div></div><div class="jp-bar" data-bar></div><div class="entries" data-entries></div>
      <div class="muted" style="margin-top:8px">${j.endsAt ? `Draw in <b data-jpt>${Math.max(0, Math.ceil((j.endsAt - Date.now()) / 1000))}s</b>` : 'Waiting for a second player'} · hash <span class="fair">${esc(j.hash.slice(0, 24))}…</span></div></div>`
      : '<div class="muted">The live pot is empty. Join it above.</div>');
  }
  el.innerHTML = html;
  if (view.tab === 'jackpot' && L.jackpot?.entries.length) drawEntries(el.querySelector('[data-livejp]'), L.jackpot.entries, L.jackpot.total, net.me()?.name || 'You');
  const call = (m, a) => net.gamble(m, a).catch((e) => toast(esc(e.message), 'bad'));
  el.querySelectorAll('[data-join-b]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); call('battle.join', { id: a.dataset.joinB, seat: +a.dataset.seat, clientSeed: view.seed }); }));
  el.querySelectorAll('[data-bot-b]').forEach((a) => a.addEventListener('click', () => call('battle.bots', { id: a.dataset.botB })));
  el.querySelectorAll('[data-cancel-b]').forEach((a) => a.addEventListener('click', () => call('battle.cancel', { id: a.dataset.cancelB })));
  el.querySelectorAll('[data-join-f]').forEach((a) => a.addEventListener('click', async () => {
    if (await call('flip.join', { id: a.dataset.joinF, money: view.flip.money, uids: [...stake.flip], clientSeed: view.seed })) stake.flip.clear();
  }));
  el.querySelectorAll('[data-bot-f]').forEach((a) => a.addEventListener('click', () => call('flip.bot', { id: a.dataset.botF })));
  el.querySelectorAll('[data-cancel-f]').forEach((a) => a.addEventListener('click', () => call('flip.cancel', { id: a.dataset.cancelF })));
}

// Results of live games arrive from the server.
net.on('gamble.result', async (ev) => {
  if (ev.kind === 'battle') return playBattle(ev.result, ev.mySeat);
  if (ev.kind === 'flip') {
    const m = openModal({ title: 'Coinflip', body: `<div class="coin-stage"><div class="coin"><div class="face ct">CT</div><div class="face t">T</div></div></div><div data-msg style="text-align:center"></div>`, foot: '<button class="btn" data-ver>Verify fairness</button><button class="btn ghost" data-close>Close</button>' });
    m.el.querySelector('[data-ver]').addEventListener('click', () => verifyModal('coinflip', ev.result));
    await animateCoin(m.el.querySelector('.coin'), ev.result.result);
    m.el.querySelector('[data-msg]').innerHTML = ev.won ? `<b class="green bigval">You won ${money(ev.result.value)}!</b>` : `<b class="red bigval">${esc(ev.result.winnerName)} won ${money(ev.result.value)}</b>`;
    if (ev.won) sfx.coin();
  }
  if (ev.kind === 'jackpot' && root && view.tab === 'jackpot') {
    const el = root.querySelector('[data-livejp]');
    if (el) {
      drawEntries(el, ev.result.entries, ev.result.total, net.me()?.name || 'You');
      await spinJackpot(el, ev.result.entries, ev.result.winner, ev.result.total);
    }
    toast(ev.won ? `You won the live pot: <b class="green">${money(ev.result.total)}</b>!` : `${esc(ev.result.winnerName)} won the live pot (${money(ev.result.total)})`, ev.won ? 'good' : '');
  }
});
