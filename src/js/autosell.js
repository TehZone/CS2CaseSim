// Auto-sell settings: new drops from cases, packages, capsules and the Armory are sold straight away when they are
// worth less than an amount and/or have one of the chosen rarities. Saved per device with the other settings.
import { esc, money } from './util.js';
import { rarityColor } from './data.js';
import { S, save } from './state.js';
import { openModal } from './ui.js';
import { AUTO_SELL_DEFAULT } from './engine/economy.js';

// Rarity ranks 0-5 and what they're called for skins / stickers / agents.
export const SELL_RANKS = [
  [0, 'Consumer Grade', ''],
  [1, 'Industrial Grade', 'Base Grade stickers'],
  [2, 'Mil-Spec', 'High Grade stickers, Distinguished agents'],
  [3, 'Restricted', 'Remarkable stickers, Exceptional agents'],
  [4, 'Classified', 'Exotic stickers, Superior agents'],
  [5, 'Covert', 'Extraordinary stickers, Master agents'],
];

export const autoSellRules = () => ({ ...AUTO_SELL_DEFAULT, ...(S.settings.autoSell || {}) });

export function autoSellLabel() {
  const r = autoSellRules();
  if (!r.on || (!r.below && !r.ranks.length)) return 'Auto-sell: off';
  const parts = [];
  if (r.below) parts.push(`under ${money(r.below)}`);
  if (r.ranks.length) parts.push(r.ranks.length === 1 ? SELL_RANKS[r.ranks[0]][1] : `${r.ranks.length} rarities`);
  return 'Auto-sell: ' + parts.join(' or ');
}

export function autoSellModal(onChange) {
  const r = autoSellRules();
  const m = openModal({
    title: 'Auto-sell',
    body: `<div style="display:grid;gap:14px;max-width:560px">
      <label class="check" style="font-size:15px;color:var(--text)"><input type="checkbox" data-on ${r.on ? 'checked' : ''}> Auto-sell new drops</label>
      <div class="muted" style="font-size:12px;line-height:1.5">Applies to cases, souvenir packages, packages, capsules, the Agent Locker, the Chicken Coop Crate and the Armory.
        A drop is sold right after the reveal if it matches <b>either</b> rule below. Knives, gloves and other ★ items are never auto-sold.</div>
      <div class="panel" style="padding:12px 14px">
        <h3 style="margin-bottom:6px">By amount</h3>
        <label class="check">Sell anything worth less than $ <input class="input" type="number" min="0" step="0.25" value="${r.below || 0}" style="width:110px" data-below></label>
        <div class="muted" style="font-size:11px;margin-top:4px">0 = don't sell by amount.</div>
      </div>
      <div class="panel" style="padding:12px 14px">
        <h3 style="margin-bottom:6px">By rarity</h3>
        <div style="display:grid;gap:6px">${SELL_RANKS.map(([k, n, also]) => `<label class="check" style="color:var(--text)">
          <input type="checkbox" data-rank="${k}" ${r.ranks.includes(k) ? 'checked' : ''}>
          <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${rarityColor(k)}"></span>${esc(n)}${also ? ` <span class="dim" style="font-size:11px">(${esc(also)})</span>` : ''}</label>`).join('')}</div>
      </div>
      <div style="display:grid;gap:6px">
        <label class="check"><input type="checkbox" data-stt ${r.keepStt ? 'checked' : ''}> Always keep StatTrak™ items</label>
        <label class="check"><input type="checkbox" data-rare ${r.keepRare ? 'checked' : ''}> Always keep rare patterns and premium floats (blue gems, fades, very low floats…)</label>
      </div>
    </div>`,
    foot: '<button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-save>Save</button>',
  });
  m.el.querySelector('[data-save]').addEventListener('click', () => {
    const q = (s) => m.el.querySelector(s);
    S.settings.autoSell = {
      on: q('[data-on]').checked,
      below: Math.max(0, Math.round((+q('[data-below]').value || 0) * 100) / 100),
      ranks: [...m.el.querySelectorAll('[data-rank]:checked')].map((x) => +x.dataset.rank),
      keepStt: q('[data-stt]').checked,
      keepRare: q('[data-rare]').checked,
    };
    save();
    m.close();
    onChange?.();
  });
}
