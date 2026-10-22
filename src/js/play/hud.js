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

  // CS2's classic static crosshair, opening up slightly with inaccuracy.
  setCrosshair(spread) {
    const gap = Math.round(3 + spread * 600);
    if (gap === this.gap) return;
    this.gap = gap;
    const len = 6, th = 2;
    this.q('.xhair').innerHTML = [
      `left:${-th / 2}px;top:${-gap - len}px;width:${th}px;height:${len}px`, `left:${-th / 2}px;top:${gap}px;width:${th}px;height:${len}px`,
      `top:${-th / 2}px;left:${-gap - len}px;height:${th}px;width:${len}px`, `top:${-th / 2}px;left:${gap}px;height:${th}px;width:${len}px`,
    ].map((s) => `<i style="${s}"></i>`).join('');
  }
  crosshair(on) { this.toggle('.xhair', on); }

  vitals(hp, armor, helmet) {
    this.set('[data-hp]', String(Math.max(0, Math.ceil(hp))));
    this.set('[data-ar]', String(Math.max(0, Math.ceil(armor))));
    this.toggle('[data-helmet]', !!helmet && armor > 0);
    this.q('.vitals').classList.toggle('low', hp <= 25);
  }
  money(m, { buyzone = false, c4 = false, kit = false } = {}) {
    this.set('[data-money]', '$' + Math.max(0, Math.floor(m)));
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

  place(name) { this.set('.place', name ? name.replace(/([a-z])([A-Z])/g, '$1 $2') : ''); }
  fps(v) { this.set('.fps', `${Math.round(v)} fps`); }
  scoped(on) { this.el.classList.toggle('scoped', !!on); }

  // Top bar: scores by side, alive players, the round clock (or the planted bomb).
  top({ ct, t, aliveCT, aliveT, totalCT, totalT, clock, planted, phase }) {
    this.set('[data-score-ct]', String(ct));
    this.set('[data-score-t]', String(t));
    this.q('[data-alive-ct]').innerHTML !== this.cache.act && (this.q('[data-alive-ct]').innerHTML = this.cache.act = pips(aliveCT, totalCT));
    this.q('[data-alive-t]').innerHTML !== this.cache.att && (this.q('[data-alive-t]').innerHTML = this.cache.att = pips(aliveT, totalT));
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

  kill({ killer, victim, weapon, headshot, wallbang, mine, killerTeam, victimTeam }) {
    const row = document.createElement('div');
    if (mine) row.className = 'mine';
    row.innerHTML = `${killer ? `<span class="${killerTeam === 'CT' ? 'ct' : 't'}">${esc(killer)}</span> ` : ''}<span class="muted">${esc(weapon)}${wallbang ? ' ⫽' : ''}${headshot ? ' ⌖' : ''}</span> <span class="${victimTeam === 'CT' ? 'ct' : 't'}">${esc(victim)}</span>`;
    const feed = this.q('.feed');
    feed.prepend(row);
    while (feed.children.length > 6) feed.lastChild.remove();
    setTimeout(() => row.remove(), 7000);
  }

  // Tab: both teams with kills, deaths, assists, damage per round, money (your team) and MVPs.
  scoreboard(show, { players = [], myTeam, round = 1, scores = {} } = {}) {
    const el = this.q('[data-scores]');
    el.classList.toggle('hidden', !show);
    if (!show) return;
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

const pips = (alive, total) => Array.from({ length: total }, (_, i) => `<i class="${i < alive ? 'on' : ''}"></i>`).join('');
