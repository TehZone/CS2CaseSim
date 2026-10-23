// The buy menu (B): CS2's catalog for your side with prices from the game's weapon data. Click an item, or use the
// number keys like the classic menu (category, then item). Shows the cursor while open; you can still move.
// In Deathmatch every gun is free and the menu opens anywhere.
// The buttons are built once when it opens and then updated in place (money, prices, what you can afford): rebuilding
// them while it's open would swallow clicks that land between a press and its release.
// Each item shows CS2's icon for it when the game's icons are there, else just its name.
import { esc } from '../util.js';
import { CATALOG } from './match.js';
import { iconFor } from './icons.js';

export class BuyMenu {
  constructor(root, game) {
    this.game = game;
    this.el = document.createElement('div');
    this.el.className = 'play-buy hidden';
    root.appendChild(this.el);
    this.cat = null;
    this.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-buy]');
      if (b && !b.disabled) this.game.buy(b.dataset.buy);
      if (e.target.closest('[data-close]')) this.game.closeBuyMenu();
    });
  }

  get isOpen() { return !this.el.classList.contains('hidden'); }

  open() { this.cat = null; this.build(); this.el.classList.remove('hidden'); }
  close() { this.el.classList.add('hidden'); }

  // Number keys: pick a category, then an item (0 or Esc goes back / closes).
  key(code) {
    const n = /^Digit(\d)$/.exec(code)?.[1];
    if (n == null) return false;
    const i = Number(n);
    if (i === 0) { if (this.cat != null) { this.cat = null; this.render(); } else this.game.closeBuyMenu(); return true; }
    const cats = this.categories();
    if (this.cat == null) { if (cats[i - 1]) { this.cat = i - 1; this.render(); } return true; }
    const item = cats[this.cat]?.items[i - 1];
    if (item && item.ok) this.game.buy(item.id);
    return true;
  }

  categories() {
    const g = this.game, me = g.me, m = g.match;
    // Deathmatch: every gun, free (no gear or grenades).
    const dm = g.respawnMode;
    return CATALOG.filter((c) => !dm || ['Pistols', 'Mid-Tier', 'Rifles'].includes(c.cat)).map((c) => ({
      cat: c.cat,
      items: c.items.filter(([, , team]) => dm || !team || team === me.team).map(([id, name]) => {
        const owned = g.owns(id);
        return { id, name, price: m.costFor(me, id, g.stats), owned, ok: !owned && m.canBuy(me, id, g.stats) && g.inBuyZone() };
      }),
    }));
  }

  // What the buttons are built from: the categories and items for your side, and whether CS2's icons have arrived.
  layoutOf(cats) { return (this.game.icons ? 'icons|' : '') + cats.map((c) => c.cat + ':' + c.items.map((it) => it.id).join(',')).join('|'); }

  // The menu's layout, then its current state.
  build() {
    if (!this.game.me) return;
    const cats = this.categories();
    const dm = this.game.respawnMode;
    this.layout = this.layoutOf(cats);
    const item = (it, ii) => {
      const icon = iconFor(this.game.icons, it.id);
      return `<button class="buy-item${icon ? ' has-icon' : ''}" data-buy="${it.id}"><kbd data-key="${ii + 1}"></kbd>`
        + `${icon ? `<img src="${esc(icon)}" alt="" draggable="false">` : ''}<span>${esc(it.name)}</span><em></em></button>`;
    };
    this.el.innerHTML = `<div class="buy-head"><b data-money></b><span data-time></span><button class="btn ghost sm" data-close>Close (B)</button></div>
      <div class="buy-cols">${cats.map((c, ci) => `<div class="buy-col" data-col="${ci}"><h4><kbd>${ci + 1}</kbd> ${esc(c.cat)}</h4>
        ${c.items.map(item).join('')}</div>`).join('')}</div>
      <div class="buy-hint">${dm ? 'B opens this anywhere. What you pick is what you respawn with.' : 'Up to 4 grenades (2 flashbangs, 1 of each other). Mouse1 throws, Mouse2 lobs, both for a medium throw.'}</div>`;
    this.render(cats);
  }

  // Updates money, buy time, prices and what you can buy without replacing the buttons.
  render(cats = this.categories()) {
    if (!this.game.me) return;
    if (this.layoutOf(cats) !== this.layout) return this.build();
    const g = this.game, dm = g.respawnMode;
    const left = g.match.buyOpen ? Math.max(0, Math.ceil(g.buyTimeLeft())) : 0;
    const set = (el, text) => { if (el && el.textContent !== text) el.textContent = text; };
    set(this.el.querySelector('[data-money]'), dm ? 'Deathmatch' : '$' + g.me.money);
    set(this.el.querySelector('[data-time]'), dm ? 'Every weapon is free · you respawn with what you pick' : left ? `Buy time ${left}s` : 'Buy time is over');
    cats.forEach((c, ci) => {
      const col = this.el.querySelector(`[data-col="${ci}"]`);
      col?.classList.toggle('active', this.cat === ci);
      for (const it of c.items) {
        const b = col?.querySelector(`[data-buy="${it.id}"]`);
        if (!b) continue;
        b.disabled = !it.ok;
        b.classList.toggle('owned', it.owned);
        set(b.querySelector('em'), it.owned ? 'Owned' : dm ? 'Free' : '$' + it.price);
        const k = b.querySelector('kbd');
        set(k, this.cat === ci ? k.dataset.key : '');
      }
    });
  }
}
