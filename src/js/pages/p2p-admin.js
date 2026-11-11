// A player's Market tab in the admin panel (pages/admin.js): their open listings (staff can take one down: the item goes
// back to its owner, and it's in the audit log) and their latest that ended, sold to or bought from whom. Online it's the
// server's (admin 'market.player' and 'market.cancel', server/admin.mjs); offline it's your own save's listings, and taking
// one down is cancelling it.
import { esc, money, timeAgo } from '../util.js';
import * as I from '../items.js';
import { S } from '../state.js';
import { act, online } from '../backend.js';
import { net } from '../net/online.js';
import { toast, confirmDialog } from '../ui.js';
import { listedOf } from '../engine/storage.js';
import * as P from '../engine/p2p.js';

export const marketCount = (p) => listedOf(p?.state || {}).length;

const STATUS = { sold: ['Sold', 'green'], cancelled: ['Cancelled', ''], removed: ['Taken down', 'red'], bought: ['Bought', ''] };
const itemCell = (it) => `<td class="adm-thumb"><img loading="lazy" src="${esc(I.itemImage(it, 's'))}" alt=""></td>
  <td><div class="adm-iname ${it.stt ? 'stt' : it.sv ? 'sv' : ''}">${esc(I.itemName(it))}</div><div class="adm-uid">${esc(it.uid || '')}${it.fl != null ? ` · ${(+it.fl).toFixed(6)}` : ''}</div></td>`;

// el: the tab's body. canTidy: whether you may take their listings down. done(): after one is taken down.
export async function drawMarketTab(el, p, { canTidy = false, done = () => {} } = {}) {
  el.innerHTML = '<div class="empty adm-empty">Loading…</div>';
  let open, recent, fee = P.MARKET_FEE;
  if (online()) {
    try {
      const v = await net.admin('market.player', { id: p.user.id });
      ({ open, recent } = v);
      fee = v.fee ?? fee;
    } catch (e) { el.innerHTML = `<div class="empty adm-empty red">${esc(e.message)}</div>`; return; }
  } else {
    open = listedOf(p.state || {}).map((x) => ({ lid: x.lid, item: P.fromListed(x), price: x.lp, at: x.lat }));
    recent = (S.p2p?.log || []).map((x) => ({ status: x.kind, item: null, name: x.name, price: x.price, at: x.at, buyer: x.kind === 'sold' ? { name: x.who } : null, seller: x.kind === 'bought' ? { name: x.who } : null }));
  }
  if (!el.isConnected) return;
  const ref = (it) => money(P.referencePrice(it));
  el.innerHTML = `<p class="muted adm-note">Listed items are out of the inventory until they sell or come down, and still count as theirs (worth, Item Database).
      ${fee ? `The Market keeps ${Math.round(fee * 100)}% of a sale.` : 'The Market takes no fee.'} At most ${P.MAX_LISTINGS} listings each.</p>
    <div class="section-title">Listed now <span class="adm-count">${open.length}</span></div>
    ${open.length ? `<div class="db-table-wrap"><table class="price-table adm-table"><thead><tr><th></th><th>Item</th><th class="num">Price</th><th class="num">Reference</th><th>Listed</th><th></th></tr></thead><tbody>
      ${open.map((l, i) => `<tr>${itemCell(l.item)}<td class="num green">${money(l.price)}</td><td class="num">${ref(l.item)}</td><td class="nw">${esc(timeAgo(l.at))}</td>
        <td class="adm-rowbtns">${canTidy ? `<button class="btn ghost sm" data-down="${i}">Take down</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty adm-empty">Nothing listed.</div>'}
    <div class="section-title">Latest that ended</div>
    ${recent.length ? `<div class="db-table-wrap"><table class="price-table adm-table"><thead><tr><th>When</th><th>What</th><th>Item</th><th class="num">Price</th><th>Seller</th><th>Buyer</th></tr></thead><tbody>
      ${recent.map((r) => { const [label, tone] = STATUS[r.status] || [r.status, '']; return `<tr><td class="nw">${esc(timeAgo(r.at))}</td><td><span class="chip ${tone}">${label}</span></td>
        <td>${esc(r.item ? I.itemName(r.item) : r.name || '')}</td><td class="num">${money(r.price)}</td><td>${esc(r.seller?.name || (r.status === 'bought' ? '' : p.user.name) || '—')}</td><td>${esc(r.buyer?.name || '—')}</td></tr>`; }).join('')}
      </tbody></table></div>` : '<div class="empty adm-empty">Nothing yet.</div>'}`;
  el.querySelectorAll('[data-down]').forEach((b) => b.addEventListener('click', async () => {
    const l = open[+b.dataset.down], name = esc(I.itemName(l.item));
    if (!(await confirmDialog(online() ? `Take <b>${esc(p.user.name)}</b>'s ${name} (${money(l.price)}) off the Market? It goes back to their inventory, they're told, and this goes in the audit log.`
      : `Take your ${name} off the Market? It goes back to your inventory.`, { ok: 'Take it down', no: online() ? 'Cancel' : 'Keep it listed', danger: true }))) return;
    b.disabled = true;
    try {
      if (online()) await net.admin('market.cancel', { id: p.user.id, lid: l.lid });
      else await act('p2p.cancel', { lid: l.lid });
      toast(`${name} is off the Market`, 'good');
      done();
    } catch (e) { toast(esc(e.message), 'bad'); b.disabled = false; }
  }));
}
