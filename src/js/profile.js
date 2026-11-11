// Your profile, like CS2's: your level in the top bar (CS2's own level icon when it's installed) with its XP bar and the
// Service Medal you've reached, the medals you can earn, and the rewards each level up brings: four items to keep two
// of (CS2's care package). Levels and medals are earned by playing matches (rules in engine/levels.js).
import { esc, imgUrl, money } from './util.js';
import { S, on } from './state.js';
import * as I from './items.js';
import { XP_PER_LEVEL, MAX_LEVEL, MEDALS, XP, PAY, PASSIVE, CARE_PICKS, CARE_OFFERS, medalName, medalOf, nextMedal } from './engine/levels.js';
import { cs2Status, cs2Play } from './cs2/api.js';
import { openModal, itemCard, toast, tryAct, showItemDetail } from './ui.js';
import { sfx } from './audio.js';

let art = null; // CS2's level icons and medals from the install: { levels: { n: url }, medals: { 'year-colour': url } }
let pics = {}; // Steam's medal pictures (data/medals.json), when CS2 isn't installed

const medalKey = (m) => `${m.y}-${m.l}`;
const usd = (n) => '$' + n.toLocaleString('en-US'); // (whole dollars: $1,250)
export function medalImg(m) {
  if (!m) return '';
  return art?.medals?.[medalKey(m)] || (pics[medalKey(m)] ? imgUrl(pics[medalKey(m)], 's') : '');
}
export function medalHtml(m, size = 28, cls = '') {
  const src = medalImg(m);
  return src ? `<img class="medal ${cls}" src="${src}" style="width:${size}px;height:${size}px" alt="" title="${esc(medalName(m))}">` : '';
}
// CS2's icon for a level (a numbered badge without the install).
export function levelIconHtml(level, size = 28) {
  const url = art?.levels?.[level];
  return url ? `<img class="lvl-ico" src="${url}" style="width:${size}px;height:${size}px" alt="">`
    : `<span class="lvl-ico drawn" style="--s:${size}px">${level}</span>`;
}
// "Level 12" with its icon and your medal (the stats page).
export function levelHtml(prof, { size = 28 } = {}) {
  return `<span class="lvl-line">${medalHtml(medalOf(prof), size)}${levelIconHtml(prof.level, size)}Level ${prof.level}</span>`;
}
// The XP bar: how far through this level (from: where it started, shown as the darker part, at the end of a match).
export function xpBarHtml(prof, { from = null } = {}) {
  const k = (x) => Math.max(0, Math.min(100, (x / XP_PER_LEVEL) * 100));
  return `<div class="xpbar"><i class="was" style="width:${k(from ?? prof.xp)}%"></i><i class="now" style="width:${k(prof.xp)}%"></i></div>`;
}

// What a finished match earned (the play.reward result), for the end of the match: the money, the XP and the level.
export function matchRewardHtml(r) {
  if (!r) return '';
  if (r.cheats) return '<span class="muted">Cheats were used, so this match pays nothing</span>';
  const p = r.pay, x = r.xp;
  const parts = [p.result && `${{ win: 'Win', draw: 'Draw', loss: 'Loss' }[r.result] || 'Result'} ${usd(p.result)}`, p.kills && `kills ${usd(p.kills)}`, p.assists && `assists ${usd(p.assists)}`, p.mvps && `MVPs ${usd(p.mvps)}`].filter(Boolean).join(' · ');
  const prof = { ...S.prof, ...r.after };
  const medal = r.medals?.length ? MEDALS[r.medals.at(-1)] : null;
  const ups = r.levelUps ? `<div class="lvl-up">${medal ? `${medalHtml(medal, 40)}<b>${esc(medalName(medal))}</b> earned! Back to level 1`
    : `${levelIconHtml(prof.level, 36)}<b>Level ${prof.level}</b>`}${r.levelUps > 1 ? ` (${r.levelUps} level ups)` : ''} · ${r.waiting} reward${r.waiting === 1 ? '' : 's'} waiting at the top of the menu</div>` : '';
  return `<div class="match-pay"><div><b class="green">+${money(r.earned)}</b> <span class="muted">${parts}</span></div>
    <div class="xp-line">${levelIconHtml(prof.level, 26)}<span>+${x.total.toLocaleString()} XP</span>${xpBarHtml(prof, { from: r.levelUps ? 0 : r.before.xp })}<span class="muted">${prof.xp.toLocaleString()} / ${XP_PER_LEVEL.toLocaleString()}</span></div>
    ${ups}</div>`;
}

// ---- the top bar ------------------------------------------------------------------------------------------------------
function drawChip() {
  const el = document.getElementById('prof');
  if (!el) return;
  const prof = S.prof, waiting = prof.drops?.length || 0;
  el.classList.toggle('has-drops', waiting > 0);
  el.title = `Level ${prof.level} · ${prof.xp.toLocaleString()} / ${XP_PER_LEVEL.toLocaleString()} XP${waiting ? ` · ${waiting} level-up reward${waiting === 1 ? '' : 's'} to claim` : ''}`;
  el.innerHTML = `${medalHtml(medalOf(prof), 30, 'pc-medal')}${levelIconHtml(prof.level, 34)}
    <span class="pc-txt"><b>Level ${prof.level}</b>${xpBarHtml(prof)}</span>${waiting ? `<span class="pill gift">${waiting}</span>` : ''}`;
}

export async function initProfile() {
  const el = document.getElementById('prof');
  el?.addEventListener('click', () => (S.prof.drops?.length ? openRewards() : openProfile()));
  for (const ev of ['prof', 'reset']) on(ev, drawChip);
  drawChip();
  fetch('data/medals.json').then((r) => (r.ok ? r.json() : {})).then((m) => { pics = m || {}; drawChip(); }).catch(() => {});
  if ((await cs2Status().catch(() => null))?.available) {
    art = await cs2Play('profileArt').catch(() => null);
    drawChip();
  }
}

// ---- your profile: level, XP and the Service Medals ----------------------------------------------------------------------
export function openProfile() {
  const prof = S.prof, cur = medalOf(prof), next = nextMedal(prof), waiting = prof.drops?.length || 0;
  const years = [];
  for (const [i, m] of MEDALS.entries()) {
    if (!years.length || years.at(-1).y !== m.y) years.push({ y: m.y, list: [] });
    years.at(-1).list.push({ m, i });
  }
  const medalCell = ({ m, i }) => {
    const state = i < prof.medals ? 'got' : i === prof.medals ? 'next' : 'locked';
    return `<div class="mcell ${state}" title="${esc(medalName(m))} · colour ${m.l}${state === 'next' ? ' · your next medal' : state === 'got' ? ' · earned' : ''}">${medalHtml(m, 46) || `<span class="mph">${m.l}</span>`}</div>`;
  };
  const m = openModal({
    title: 'Profile',
    cls: 'wide',
    body: `<div class="prof-head">
        ${cur ? medalHtml(cur, 72) : ''}${levelIconHtml(prof.level, 72)}
        <div class="grow"><h3>Level ${prof.level}</h3>${xpBarHtml(prof)}
          <div class="muted">${prof.xp.toLocaleString()} / ${XP_PER_LEVEL.toLocaleString()} XP · ${prof.level < MAX_LEVEL ? `level ${prof.level + 1} next` : next ? `the ${esc(medalName(next))} next` : 'every medal earned'}</div>
          <div class="muted">${cur ? `Your medal: <b>${esc(medalName(cur))}</b> (colour ${cur.l})` : 'No Service Medal yet: reach level 40 and level up once more for your first.'}</div></div>
        ${waiting ? `<button class="btn gold" data-claim>Claim reward${waiting > 1 ? `s (${waiting})` : ''}</button>` : ''}
      </div>
      <div class="section-title">Earning XP and money</div>
      <div class="muted" style="font-size:13px;line-height:1.6">Every finished match in Play: a win or draw <b>${usd(PAY.win)}</b> and ${XP.win} XP, a loss <b>${usd(PAY.loss)}</b> and ${XP.loss} XP;
        each kill <b>${usd(PAY.kill)}</b> and ${XP.kill} XP, each assist <b>${usd(PAY.assist)}</b> and ${XP.assist} XP, each round MVP <b>${usd(PAY.mvp)}</b>, and ${XP.round} XP for each round your team wins.
        ${XP_PER_LEVEL.toLocaleString()} XP is a level, and every level up brings a reward: ${CARE_OFFERS} items to keep ${CARE_PICKS} of.
        You also get <b>${usd(PASSIVE.perMinute)}</b> every minute, even while the game is closed (up to ${PASSIVE.capHours} hours).</div>
      <div class="section-title">Service Medals <span class="muted" style="font-size:12px;text-transform:none;letter-spacing:0">${prof.medals} of ${MEDALS.length}</span></div>
      <div class="muted" style="font-size:13px;margin-bottom:10px">Past level 40 you earn the next medal and start again at level 1. Every colour of the newest medal comes first, then the year before's, back to the first ever, 2015's.</div>
      <div class="medal-years">${years.map((y) => `<div class="myear"><span>${y.y}</span>${y.list.map(medalCell).join('')}</div>`).join('')}</div>`,
    foot: '<button class="btn ghost" data-close>Close</button>',
  });
  m.el.querySelector('[data-claim]')?.addEventListener('click', () => { m.close(); openRewards(); });
}

// ---- level-up rewards: four items, keep two ------------------------------------------------------------------------------
export function openRewards() {
  const drop = S.prof.drops?.[0];
  if (!drop) return openProfile();
  const picked = new Set();
  const left = S.prof.drops.length - 1;
  const m = openModal({
    title: `Level-up reward${drop.level ? ` · level ${drop.level}` : ''}`,
    cls: 'wide',
    body: `<p class="muted" style="margin:0 0 12px">Choose <b>${CARE_PICKS}</b> of these ${drop.offers.length} to keep. Cases open with their key (on the Cases page or from your inventory).</p>
      <div class="grid care">${drop.offers.map((it) => itemCard(it, { selectable: true })).join('')}</div>`,
    foot: `<span class="muted">${left ? `${left} more reward${left === 1 ? '' : 's'} after this one` : ''}</span><span class="spacer"></span><button class="btn ghost" data-close>Later</button><button class="btn gold" data-take disabled>Keep these ${CARE_PICKS}</button>`,
  });
  const take = m.el.querySelector('[data-take]');
  m.el.querySelectorAll('.card[data-uid]').forEach((c) => {
    c.addEventListener('click', () => {
      const i = drop.offers.findIndex((it) => it.uid === c.dataset.uid);
      if (picked.has(i)) picked.delete(i);
      else if (picked.size < CARE_PICKS) picked.add(i);
      else return;
      c.classList.toggle('selected', picked.has(i));
      take.disabled = picked.size !== CARE_PICKS;
    });
    c.addEventListener('contextmenu', (e) => { e.preventDefault(); showItemDetail(drop.offers.find((it) => it.uid === c.dataset.uid)); });
  });
  take.addEventListener('click', async () => {
    take.disabled = true;
    const r = await tryAct('drop.claim', { id: drop.id, picks: [...picked] });
    if (!r) { take.disabled = false; return; }
    sfx.reveal?.(Math.max(...r.items.map((it) => I.rarityRank(it))));
    toast(`Added to your inventory: ${r.items.map((it) => `<b>${esc(I.itemName(it))}</b>`).join(' and ')}`, 'good');
    m.close();
    if (S.prof.drops?.length) openRewards();
  });
}
