// Play mode HUD (DOM over the canvas), laid out like CS2's: round timer and team scores at the top, health, armor and
// money bottom left, ammo bottom right, kill feed top right, crosshair, callout, round messages, plant/defuse
// progress, damage direction, the scoreboard (Tab), the sniper scope, the radio menu and chat, and the end-of-match
// screen.
import { esc } from '../util.js';

const fmtTime = (s) => { s = Math.max(0, Math.ceil(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export class Hud {
  constructor(root) {
    this.el = document.createElement('div');
    this.el.className = 'play-hud';
    this.el.innerHTML = `
      <div class="flashed"></div>
      <div class="scope"></div>
      <div class="dmg"></div>
      <div class="dmgdir"></div>
      <div class="xhair"></div>
      <div class="top">
        <div class="team ct"><span class="alive" data-alive-ct></span><b data-score-ct>0</b></div>
        <div class="clock" data-clock>0:00</div>
        <div class="team t"><b data-score-t>0</b><span class="alive" data-alive-t></span></div>
      </div>
      <div class="place"></div>
      <div class="modeline" data-mode></div>
      <div class="fps"></div>
      <div class="feed"></div>
      <div class="chat" data-chat></div>
      <div class="radio hidden" data-radio></div>
      <div class="msg" data-msg></div>
      <div class="progress hidden" data-progress><span data-progress-label></span><i><b data-progress-bar></b></i></div>
      <div class="spec hidden" data-spec></div>
      <div class="bottom">
        <div class="left">
          <div class="money"><span class="buyzone hidden" data-buyzone title="Buy zone (B)">BUY</span><span data-money>$0</span><span class="c4 hidden" data-c4>C4</span><span class="kit hidden" data-kit>KIT</span></div>
          <div class="vitals"><div><small>HP</small><span data-hp>100</span></div><div><small>ARMOR</small><span data-ar>0</span><i data-helmet class="hidden">H</i></div></div>
        </div>
        <div class="ammo"><div class="nades" data-nades></div><div class="weapon-name" data-wn></div><span data-clip>0</span> <small>/ <span data-res>0</span></small></div>
      </div>
      <div class="scoreboard hidden" data-scores></div>
      <div class="endscreen hidden" data-end></div>`;
    root.appendChild(this.el);
    this.q = (s) => this.el.querySelector(s);
    this.gap = -1;
    this.cache = {};
    this.setCrosshair(0);
  }

  set(sel, text) { if (this.cache[sel] !== text) { this.cache[sel] = text; this.q(sel).textContent = text; } }
  toggle(sel, on) { const k = sel + '?'; if (this.cache[k] !== on) { this.cache[k] = on; this.q(sel).classList.toggle('hidden', !on); } }

  // CS2's crosshair from your settings: classic (opens up with inaccuracy) or static, its length, gap, thickness,
  // outline, centre dot and colour.
  setCrosshairStyle(style = {}) { this.xh = { ...CROSSHAIR, ...style }; this.gap = null; this.setCrosshair(0); }
  setCrosshair(spread) {
    const x = this.xh || CROSSHAIR;
    const gap = Math.round(x.gap + (x.style === 'classic' ? spread * 600 : 0));
    if (gap === this.gap) return;
    this.gap = gap;
    this.q('.xhair').innerHTML = crosshairHtml(x, gap);
  }
  crosshair(on) { this.toggle('.xhair', on); }

  vitals(hp, armor, helmet) {
    this.set('[data-hp]', String(Math.max(0, Math.ceil(hp))));
    this.set('[data-ar]', String(Math.max(0, Math.ceil(armor))));
    this.toggle('[data-helmet]', !!helmet && armor > 0);
    this.q('.vitals').classList.toggle('low', hp <= 25);
  }
  money(m, { buyzone = false, c4 = false, kit = false } = {}) {
    this.toggle('[data-money]', m != null); // no money in Deathmatch
    this.set('[data-money]', m == null ? '' : '$' + Math.max(0, Math.floor(m)));
    this.toggle('[data-buyzone]', buyzone);
    this.toggle('[data-c4]', c4);
    this.toggle('[data-kit]', kit);
  }
  ammo(gun) {
    this.set('[data-wn]', gun?.name || '');
    const melee = !gun || gun.melee || gun.id === 'weapon_c4' || gun.nade;
    this.set('[data-clip]', melee ? '' : String(gun.clip));
    this.q('[data-res]').parentElement.style.display = melee ? 'none' : '';
    this.set('[data-res]', melee ? '' : String(gun.reserve));
  }
  // Your grenades (the one in your hand highlighted).
  nades(list, current) {
    const html = list.map(([id, short, n]) => (id === current ? `<b>${short}${n > 1 ? ' ×' + n : ''}</b>` : `${short}${n > 1 ? ' ×' + n : ''}`)).join(' · ');
    if (this.cache.nades !== html) { this.cache.nades = html; this.q('[data-nades]').innerHTML = html; }
  }
  // Flashbang: white that fades (opacity 0..1).
  flashed(a) { const k = Math.round(a * 100) / 100; if (this.cache.fl !== k) { this.cache.fl = k; this.q('.flashed').style.opacity = String(k); } }

  mode(text) { this.set('[data-mode]', text || ''); }
  place(name) { this.set('.place', name ? name.replace(/([a-z])([A-Z])/g, '$1 $2') : ''); }
  fps(v) { this.set('.fps', v == null ? '' : `${Math.round(v)} fps`); }
  scoped(on) { this.el.classList.toggle('scoped', !!on); }

  // Top bar: scores by side, alive players, the round clock (or the planted bomb).
  top({ ct, t, aliveCT, aliveT, totalCT, totalT, clock, planted, phase, ffa = false }) {
    this.q('.top').classList.toggle('ffa', ffa);
    this.set('[data-score-ct]', String(ct));
    this.set('[data-score-t]', String(t));
    const act = pips(aliveCT, totalCT, 'ct'), att = pips(aliveT, totalT, 't');
    if (act !== this.cache.act) this.q('[data-alive-ct]').innerHTML = this.cache.act = act;
    if (att !== this.cache.att) this.q('[data-alive-t]').innerHTML = this.cache.att = att;
    const text = planted ? 'C4' : fmtTime(clock);
    this.set('[data-clock]', text);
    this.q('[data-clock]').className = 'clock' + (planted ? ' bomb' : clock <= 10 && phase === 'live' ? ' low' : phase === 'freeze' ? ' freeze' : '');
  }

  message(html, ms = 3000, cls = '') {
    const m = this.q('[data-msg]');
    m.className = 'msg show ' + cls;
    m.innerHTML = html;
    clearTimeout(this.msgTimer);
    if (ms) this.msgTimer = setTimeout(() => { m.className = 'msg'; }, ms);
  }

  progress(label, frac) {
    const show = frac != null;
    this.toggle('[data-progress]', show);
    if (show) { this.set('[data-progress-label]', label); this.q('[data-progress-bar]').style.width = `${Math.round(frac * 100)}%`; }
  }

  spectate(name) { this.toggle('[data-spec]', !!name); if (name) this.set('[data-spec]', `Spectating ${name}  ·  Mouse1 next`); }

  // A red flash, and an arrow pointing to where the shot came from (angle in degrees, 0 = in front).
  hurt(angle, amount) {
    const d = this.q('.dmg');
    d.style.boxShadow = `inset 0 0 ${80 + amount * 2}px rgba(200,0,0,${Math.min(0.75, 0.25 + amount / 100)})`;
    clearTimeout(this.hurtT);
    this.hurtT = setTimeout(() => { d.style.boxShadow = ''; }, 250);
    if (angle == null) return;
    const a = document.createElement('i');
    a.style.transform = `translate(-50%, -50%) rotate(${angle}deg) translateY(-110px)`;
    this.q('.dmgdir').appendChild(a);
    setTimeout(() => a.remove(), 1200);
  }

  // A kill feed line, with CS2's marks for how it happened: a blinded killer before the weapon; after it, in the air,
  // no scope, through smoke, through a wall, headshot.
  kill({ killer, victim, weapon, headshot, wallbang, smoke, air, blind, noscope, mine, killerTeam, victimTeam }) {
    const row = document.createElement('div');
    if (mine) row.className = 'mine';
    const mark = (on, k) => (on ? KILL_MARKS[k] : '');
    row.innerHTML = `${killer ? `<span class="${killerTeam === 'CT' ? 'ct' : 't'}">${esc(killer)}</span>` : ''}${mark(blind, 'blind')}<span class="wpn">${esc(weapon)}</span>`
      + `${mark(air, 'air')}${mark(noscope, 'noscope')}${mark(smoke, 'smoke')}${mark(wallbang, 'wallbang')}${mark(headshot, 'headshot')}<span class="${victimTeam === 'CT' ? 'ct' : 't'}">${esc(victim)}</span>`;
    const feed = this.q('.feed');
    feed.prepend(row);
    while (feed.children.length > 6) feed.lastChild.remove();
    setTimeout(() => row.remove(), 7000);
  }

  // Tab: both teams with kills, deaths, assists, damage per round, money (your team) and MVPs; in free-for-all one list
  // by points (or Arms Race level).
  scoreboard(show, { players = [], myTeam, round = 1, scores = {}, ffa = false, respawn = false } = {}) {
    const el = this.q('[data-scores]');
    el.classList.toggle('hidden', !show);
    if (!show) return;
    if (respawn) {
      const list = (side) => players.filter((p) => ffa || p.team === side).sort((a, b) => b.level - a.level || b.points - a.points).map((p) => `
        <tr class="${p.alive ? '' : 'dead'} ${p.me ? 'me' : ''}"><td>${esc(p.name)}</td><td>${p.kills}</td><td>${p.deaths}</td><td>${ffa && p.level ? p.level + 1 : p.points}</td></tr>`).join('');
      const table = (side, name) => `<div class="sb-team ${side ? side.toLowerCase() : 'ffa'}"><div class="sb-head">${side ? `<b>${scores[side] ?? 0}</b> ` : ''}${name}</div>
        <table><thead><tr><th>Player</th><th>K</th><th>D</th><th>${players.some((p) => p.level) ? 'Level' : 'Points'}</th></tr></thead><tbody>${list(side)}</tbody></table></div>`;
      el.innerHTML = ffa ? table(null, 'Free for all') : table('CT', 'Counter-Terrorists') + table('T', 'Terrorists');
      return;
    }
    const rows = (side) => players.filter((p) => p.team === side).sort((a, b) => b.score - a.score).map((p) => `
      <tr class="${p.alive ? '' : 'dead'} ${p.me ? 'me' : ''}"><td>${esc(p.name)}</td><td>${p.team === myTeam ? '$' + p.money : ''}</td>
      <td>${p.kills}</td><td>${p.deaths}</td><td>${p.assists}</td><td>${Math.round(p.damage / Math.max(1, round - 1 || 1))}</td><td>${p.mvps ? '★' + p.mvps : ''}</td><td>${p.score}</td></tr>`).join('');
    const table = (side, name) => `<div class="sb-team ${side.toLowerCase()}"><div class="sb-head"><b>${scores[side] ?? 0}</b> ${name}</div>
      <table><thead><tr><th>Player</th><th>Money</th><th>K</th><th>D</th><th>A</th><th>ADR</th><th>MVP</th><th>Score</th></tr></thead><tbody>${rows(side)}</tbody></table></div>`;
    el.innerHTML = table('CT', 'Counter-Terrorists') + table('T', 'Terrorists');
  }

  // A radio call in the chat: name @ place: text (fades after a while).
  chat(name, place, text, team) {
    const row = document.createElement('div');
    row.innerHTML = `<span class="${team === 'CT' ? 'ct' : 't'}">${esc(name)}</span>${place ? ` <small>@ ${esc(place.replace(/([a-z])([A-Z])/g, '$1 $2'))}</small>` : ''}: ${esc(text)}`;
    const box = this.q('[data-chat]');
    box.appendChild(row);
    while (box.children.length > 6) box.firstChild.remove();
    setTimeout(() => row.classList.add('old'), 9000);
    setTimeout(() => row.remove(), 10000);
  }
  // The radio menu (Z / X / V), or null to hide it.
  radio(menu) {
    const el = this.q('[data-radio]');
    el.classList.toggle('hidden', !menu);
    if (menu) el.innerHTML = `<h4>${esc(menu.title)}</h4>${menu.items.map(([label], i) => `<div><kbd>${i + 1}</kbd> ${esc(label)}</div>`).join('')}<div class="muted"><kbd>0</kbd> Close</div>`;
  }

  endScreen(html) {
    const el = this.q('[data-end]');
    el.classList.toggle('hidden', !html);
    if (html) el.innerHTML = html;
  }

  dispose() { this.el.remove(); }
}

export const CROSSHAIR = { style: 'classic', color: '#32fa32', size: 6, gap: 3, thickness: 2, outline: true, dot: false };
// The crosshair's lines (and dot) as HTML around a zero-size centre; shared with the settings preview.
export function crosshairHtml(x, gap = x.gap) {
  const len = x.size, th = x.thickness;
  const look = `background:${x.color};${x.outline ? 'box-shadow:0 0 0 1px rgba(0,0,0,.7)' : 'box-shadow:none'}`;
  const lines = [
    `left:${-th / 2}px;top:${-gap - len}px;width:${th}px;height:${len}px`, `left:${-th / 2}px;top:${gap}px;width:${th}px;height:${len}px`,
    `top:${-th / 2}px;left:${-gap - len}px;height:${th}px;width:${len}px`, `top:${-th / 2}px;left:${gap}px;height:${th}px;width:${len}px`,
  ];
  if (x.dot) lines.push(`left:${-th / 2}px;top:${-th / 2}px;width:${th}px;height:${th}px`);
  return lines.map((p) => `<i style="${p};${look}"></i>`).join('');
}

// Kill feed marks (16px, drawn in the text colour).
const svg = (title, body) => `<svg class="km" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><title>${title}</title>${body}</svg>`;
const KILL_MARKS = {
  headshot: svg('Headshot', '<circle cx="8" cy="7.5" r="4.3"/><circle cx="8" cy="7.5" r="1.1" fill="currentColor" stroke="none"/><path d="M8 .8v2.4M8 11.8v2.4M1.3 7.5h2.4M12.3 7.5h2.4"/>'),
  wallbang: svg('Through a wall', '<path d="M7 1.5v13" stroke-width="3.2" opacity=".55"/><path d="M1 8h13M10.8 4.8 14 8l-3.2 3.2"/>'),
  smoke: svg('Through smoke', '<path d="M4.4 12.6h7.4a2.9 2.9 0 0 0 .3-5.8 4 4 0 0 0-7.6-1A3.4 3.4 0 0 0 4.4 12.6z" fill="currentColor" stroke="none"/>'),
  air: svg('In the air', '<path d="M8 10.5V2.2M4.6 5.6 8 2.2l3.4 3.4"/><path d="M3 14h10" stroke-dasharray="2 1.8"/>'),
  noscope: svg('No scope', '<circle cx="8" cy="8" r="5.6"/><path d="M8 3.6v8.8M3.6 8h8.8"/><path d="M2.2 13.8 13.8 2.2" stroke="#ff5a5a"/>'),
  blind: svg('Blinded', '<path d="M1.5 8S3.8 4.2 8 4.2 14.5 8 14.5 8 12.2 11.8 8 11.8 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="1.7" fill="currentColor" stroke="none"/><path d="M8 .6v1.6M2.6 2.2l1.1 1.1M13.4 2.2l-1.1 1.1"/>'),
};

// A bar per player, the ones alive next to their team's score (the CT bars sit left of it, the T bars right).
const pips = (alive, total, side) => Array.from({ length: total }, (_, i) => `<i class="${(side === 'ct' ? total - 1 - i : i) < alive ? 'on' : ''}"></i>`).join('');
