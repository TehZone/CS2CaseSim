// Premier's map veto, once a match is found: both teams (you and four bots against five, real players each with a CS
// Rating, listed like a leaderboard), then CS2's pick/ban over the Active Duty maps installed: the first team bans
// two, the second three, the first one more, and the map that's left is played; the second team picks its starting
// side. You ban on your team's turns; the other team bans by itself.
import { esc } from '../util.js';
import { S } from '../state.js';
import { ratingHtml } from '../rank.js';
import { premierInfo, VETO } from '../engine/premier.js';
import { needsCredit, CREDIT } from '../play/identity.js';

// roster: { A: your teammates, B: the other team } as [{ identity, rating }]; pool: the map ids to ban from; nameOf:
// a map's name; images: { id: url } of the maps' screenshots. Resolves to { map, team } (your starting side).
export function premierVeto({ roster, pool, nameOf = (id) => id, images = {} }) {
  const mine = roster.A, theirs = roster.B;
  const meFirst = Math.random() < 0.5;
  const teamOf = (ab) => (ab === 'A') === meFirst ? 'mine' : 'theirs';
  const steps = Array.from({ length: pool.length - 1 }, (_, i) => VETO[i]?.[0] || (i % 2 ? 'B' : 'A')).map(teamOf);
  const sidePicker = teamOf('B');
  const banned = new Map(); // map -> 'mine' | 'theirs'
  const you = premierInfo(S.premier);
  const avg = (list) => Math.round(list.reduce((s, x) => s + (x.rating || 0), 0) / Math.max(1, list.length));
  const row = (x) => `<li>${x.identity?.avatar ? `<img class="veto-avatar" src="${esc(x.identity.avatar)}" alt="">` : '<span class="veto-avatar you"></span>'}
    <span class="veto-name">${esc(x.identity?.name || (x.you ? 'You' : 'Player'))}<small>${esc([x.identity?.team, x.identity?.country].filter(Boolean).join(' · ') || (x.you ? (you.rated ? 'You' : `You · ${you.needWins} wins to a rating`) : ''))}</small></span>${ratingHtml(x.rating)}</li>`;
  const team = (label, list, cls, extra = []) => `<div class="veto-team ${cls}"><h3>${label}<small>average ${ratingHtml(avg(list), { size: 12 })}</small></h3>
    <ol>${[...extra, ...list].sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1)).map(row).join('')}</ol></div>`;
  const youRow = { you: true, rating: you.rating };

  const el = document.createElement('div');
  el.className = 'play-root veto-root';
  document.body.appendChild(el);
  return new Promise((resolve) => {
    let side = null, enemyTimer = null;
    const done = (v) => { clearTimeout(enemyTimer); el.remove(); resolve(v); };
    const turn = () => steps[banned.size] || null;
    const left = () => pool.filter((id) => !banned.has(id));
    const draw = () => {
      const t = turn(), map = !t ? left()[0] : null;
      const status = t === 'mine' ? '<b>Your turn:</b> ban a map' : t === 'theirs' ? 'The other team is banning…'
        : sidePicker === 'mine' && !side ? `<b>${esc(nameOf(map))}</b> it is. Pick your starting side` : `<b>${esc(nameOf(map))}</b> · you start as <b>${side === 'CT' ? 'Counter-Terrorists' : 'Terrorists'}</b>`;
      el.innerHTML = `<div class="veto panel">
        <div class="veto-head"><h2>Premier</h2><span class="veto-status">${status}</span></div>
        <div class="veto-body">
          ${team('Your team', mine, 'mine', [youRow])}
          <div class="veto-maps">${pool.map((id) => `<button class="veto-map ${banned.has(id) ? 'banned' : ''} ${map === id ? 'picked' : ''}" data-vmap="${id}" ${t !== 'mine' || banned.has(id) ? 'disabled' : ''}
            style="${images[id] ? `--img: url('${new URL(images[id], location.href).href}')` : ''}"><span>${esc(nameOf(id))}</span>${banned.has(id) ? `<em>Banned by ${banned.get(id) === 'mine' ? 'your team' : 'the other team'}</em>` : map === id ? '<em>Picked</em>' : ''}</button>`).join('')}
            <div class="veto-order">${steps.map((s, i) => `<i class="${i < banned.size ? 'done' : i === banned.size ? 'now' : ''} ${s}">${s === 'mine' ? 'You' : 'Them'}</i>`).join('')}<i class="${!t ? 'now' : ''} ${sidePicker}">Side</i></div>
          </div>
          ${team('Other team', theirs, 'theirs')}
        </div>
        <div class="veto-foot">${!t ? (sidePicker === 'mine' && !side
          ? '<button class="btn" data-side="CT">Start as Counter-Terrorists</button><button class="btn" data-side="T">Start as Terrorists</button>'
          : '<button class="btn primary big" data-veto-go>Play</button>') : ''}</div>
        ${needsCredit([...mine, ...theirs].map((x) => x.identity)) ? `<div class="muted veto-credit">${esc(CREDIT)}</div>` : ''}
      </div>`;
      el.querySelectorAll('[data-vmap]').forEach((b) => b.addEventListener('click', () => { if (turn() === 'mine' && !banned.has(b.dataset.vmap)) { banned.set(b.dataset.vmap, 'mine'); next(); } }));
      el.querySelectorAll('[data-side]').forEach((b) => b.addEventListener('click', () => { side = b.dataset.side; draw(); }));
      el.querySelector('[data-veto-go]')?.addEventListener('click', () => done({ map, team: side }));
    };
    const next = () => {
      if (turn() === 'theirs') enemyTimer = setTimeout(() => { const opts = left(); banned.set(opts[Math.floor(Math.random() * opts.length)], 'theirs'); next(); }, 900 + Math.random() * 700);
      else if (!turn() && sidePicker === 'theirs') side = Math.random() < 0.5 ? 'T' : 'CT'; // (their pick: you're on the other side)
      draw();
    };
    next();
  });
}
