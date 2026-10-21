// Trade Up Contracts, following CS2's rules.
//
// Classic contract: 10 skins of the same rarity (Consumer to Classified), all StatTrak or all not, no souvenirs.
//   You get one skin of the next rarity from the collections of the inputs.
// Covert contract: 5 Covert skins (all StatTrak or all not) give a knife or gloves from the case of an input's
//   collection. Gloves have no StatTrak, so StatTrak contracts can only give knives.
//
// Odds ("tickets"): every input adds one ticket for each possible outcome in its own collection, then one ticket
//   is drawn. So P(outcome) = inputs from the outcome's collection / total tickets.
// Output float: each input float is normalised to its own skin's range, those are averaged, and the average is
//   mapped onto the output skin's range: out = min + avg * (max - min).
import { D, DOPPLER_PHASE_WEIGHT } from './data.js';
import { makeSkinItem } from './items.js';
import { rand, pickWeighted } from './util.js';

export const CLASSIC_COUNT = 10;
export const COVERT_COUNT = 5;
export const TRADEUP_SRC = 'Trade Up Contract';

// Possible outcome groups (same skin name = one outcome; Doppler phases split it) for one input.
function outcomeGroups(def, stt) {
  const col = D.colById[def.col];
  if (!col) return [];
  if (def.r < 5) {
    const ids = col.tiers[def.r + 1] || [];
    const byName = new Map();
    for (const id of ids) {
      const s = D.skins[id];
      if (!s || (stt && !s.stt)) continue;
      if (!byName.has(s.n)) byName.set(s.n, []);
      byName.get(s.n).push(id);
    }
    return [...byName.values()];
  }
  const box = col.caseId && D.caseById[col.caseId];
  if (!box?.rare) return [];
  return box.rare.filter((g) => !stt || (D.skins[g[0]].cat !== 'gloves' && D.skins[g[0]].stt));
}

// Why an item can't go into a contract (or '' if it can).
export function tradeupIneligible(item) {
  if (item.t !== 'skin') return 'Only weapon skins can be traded up';
  const d = D.skins[item.id];
  if (!d) return 'Unknown item';
  if (d.star) return 'Knives and gloves cannot be traded up';
  if (item.sv) return 'Souvenir items cannot be traded up';
  if (d.r > 5) return 'This rarity cannot be traded up';
  if (!d.col) return 'Not part of a collection';
  if (!outcomeGroups(d, !!item.stt).length) return d.r === 5 ? 'Its collection has no knife or gloves case' : 'Highest rarity in its collection';
  return '';
}

// Validates a contract and lists its outcomes with chances and resulting floats.
export function tradeupContract(items) {
  if (!items.length) return { ok: false, error: 'Add skins to the contract', outcomes: [] };
  const d0 = D.skins[items[0].id];
  const rarity = d0?.r;
  const covert = rarity === 5;
  const need = covert ? COVERT_COUNT : CLASSIC_COUNT;
  const stt = !!items[0].stt;
  for (const it of items) {
    const why = tradeupIneligible(it);
    if (why) return { ok: false, error: why, outcomes: [], need, rarity, stt };
    if (D.skins[it.id].r !== rarity) return { ok: false, error: 'All skins must be the same rarity', outcomes: [], need, rarity, stt };
    if (!!it.stt !== stt) return { ok: false, error: 'Mix of StatTrak™ and normal skins', outcomes: [], need, rarity, stt };
  }
  const tickets = new Map(); // group key -> { ids, tickets }
  let total = 0;
  for (const it of items) {
    const groups = outcomeGroups(D.skins[it.id], stt);
    for (const g of groups) {
      const key = g.join(',');
      if (!tickets.has(key)) tickets.set(key, { ids: g, t: 0 });
      tickets.get(key).t++;
    }
    total += groups.length;
  }
  const avg = items.reduce((s, it) => {
    const d = D.skins[it.id];
    return s + (d.mx > d.mn ? (it.fl - d.mn) / (d.mx - d.mn) : 0);
  }, 0) / items.length;
  const outcomes = [...tickets.values()].map(({ ids, t }) => {
    const s = D.skins[ids[0]];
    return { ids, n: s.n, chance: t / total, fl: s.v ? null : Math.fround(s.mn + avg * (s.mx - s.mn)) };
  }).sort((a, b) => b.chance - a.chance);
  const count = items.length;
  return {
    ok: count === need, error: count === need ? '' : `Add ${need - count} more skin${need - count === 1 ? '' : 's'}`,
    need, rarity, stt, covert, outcomes, avg,
  };
}

// Signs a valid contract: returns the new item (the caller removes the inputs).
export function rollTradeup(contract, r = rand) {
  const o = pickWeighted(contract.outcomes.map((x) => [x, x.chance]), r);
  const id = o.ids.length > 1 ? pickWeighted(o.ids.map((i) => [i, DOPPLER_PHASE_WEIGHT[D.skins[i].ph] ?? 0.2]), r) : o.ids[0];
  const skin = D.skins[id];
  return makeSkinItem(skin, { src: TRADEUP_SRC, stt: contract.stt && skin.stt, fl: skin.v ? null : o.fl, r });
}
