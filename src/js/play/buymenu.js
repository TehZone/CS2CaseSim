// The buy menu (B): CS2's catalog for your side with prices from the game's weapon data. Click an item, or use the
// number keys like the classic menu (category, then item). Shows the cursor while open; you can still move.
import { esc } from '../util.js';
import { CATALOG } from './match.js';

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

  open() { this.cat = null; this.render(); this.el.classList.remove('hidden'); }
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
    return CATALOG.map((c) => ({
      cat: c.cat,
      items: c.items.filter(([, , team]) => !team || team === me.team).map(([id, name]) => {
        const owned = g.owns(id);
        return { id, name, price: m.costFor(me, id, g.stats), owned, ok: !owned && m.canBuy(me, id, g.stats) && g.inBuyZone() };
      }),
    }));
  }

  render() {
    if (!this.game.me) return;
    const cats = this.categories();
    const left = this.game.match.buyOpen ? Math.max(0, Math.ceil(this.game.buyTimeLeft())) : 0;
    this.el.innerHTML = `<div class="buy-head"><b>$${this.game.me.money}</b><span>${left ? `Buy time ${left}s` : 'Buy time is over'}</span><button class="btn ghost sm" data-close>Close (B)</button></div>
      <div class="buy-cols">${cats.map((c, ci) => `<div class="buy-col ${this.cat === ci ? 'active' : ''}"><h4><kbd>${ci + 1}</kbd> ${esc(c.cat)}</h4>
        ${c.items.map((it, ii) => `<button class="buy-item ${it.owned ? 'owned' : ''}" data-buy="${it.id}" ${it.ok ? '' : 'disabled'}>
          <kbd>${this.cat === ci ? ii + 1 : ''}</kbd><span>${esc(it.name)}</span><em>${it.owned ? 'Owned' : '$' + it.price}</em></button>`).join('')}</div>`).join('')}</div>
      <div class="buy-hint">Up to 4 grenades (2 flashbangs, 1 of each other). Mouse1 throws, Mouse2 lobs, both for a medium throw.</div>`;
  }
}
