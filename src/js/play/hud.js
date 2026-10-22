// Play mode HUD (DOM over the canvas): CS2-style crosshair, health and armor, ammo, the weapon, kill feed, the callout
// you're in, and the sniper scope.
import { esc } from '../util.js';

export class Hud {
  constructor(root) {
    this.el = document.createElement('div');
    this.el.className = 'play-hud';
    this.el.innerHTML = `
      <div class="scope"></div>
      <div class="dmg"></div>
      <div class="xhair"></div>
      <div class="place"></div>
      <div class="fps"></div>
      <div class="feed"></div>
      <div class="bottom">
        <div class="vitals"><div><small>HP</small><span data-hp>100</span></div><div><small>ARMOR</small><span data-ar>100</span></div></div>
        <div class="ammo"><div class="weapon-name" data-wn></div><span data-clip>0</span> <small>/ <span data-res>0</span></small></div>
      </div>`;
    root.appendChild(this.el);
    this.q = (s) => this.el.querySelector(s);
    this.gap = -1;
    this.setCrosshair(0);
  }

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

  vitals(hp, armor) { this.q('[data-hp]').textContent = Math.max(0, Math.ceil(hp)); this.q('[data-ar]').textContent = Math.max(0, Math.ceil(armor)); }
  ammo(gun) {
    this.q('[data-wn]').textContent = gun?.name || '';
    const melee = !gun || gun.melee;
    this.q('.ammo').style.visibility = melee && !gun?.name ? 'hidden' : 'visible';
    this.q('[data-clip]').textContent = melee ? '' : gun.clip;
    this.q('[data-res]').parentElement.style.display = melee ? 'none' : '';
    this.q('[data-res]').textContent = melee ? '' : gun.reserve;
  }
  place(name) { const p = this.q('.place'); const t = name ? name.replace(/([a-z])([A-Z])/g, '$1 $2') : ''; if (p.textContent !== t) p.textContent = t; }
  fps(v) { this.q('.fps').textContent = `${Math.round(v)} fps`; }
  scoped(on) { this.el.classList.toggle('scoped', !!on); }

  kill({ killer, victim, weapon, headshot, mine, killerTeam, victimTeam }) {
    const row = document.createElement('div');
    if (mine) row.className = 'mine';
    row.innerHTML = `<span class="${killerTeam === 'CT' ? 'ct' : 't'}">${esc(killer)}</span> <span class="muted">${esc(weapon)}${headshot ? ' ⌖' : ''}</span> <span class="${victimTeam === 'CT' ? 'ct' : 't'}">${esc(victim)}</span>`;
    const feed = this.q('.feed');
    feed.prepend(row);
    while (feed.children.length > 5) feed.lastChild.remove();
    setTimeout(() => row.remove(), 6000);
  }

  dispose() { this.el.remove(); }
}
