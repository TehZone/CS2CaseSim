// Every change to a player's state goes through these actions. Offline, the client runs them on the local save;
// online, the server runs the exact same code on the account and sends the client the resulting changes.
//
// An action gets a context (ctx) wrapping the state, the RNG and the clock, and records what it changed:
// added/removed/updated items and the other top-level fields it touched (money, stars, stats...).
import { D, casePrice } from './data.js';
import * as I from './items.js';
import * as E from './economy.js';
import { tradeupContract, rollTradeup } from './tradeup.js';
import { PASS_PRICE, PASS_STARS, findLiveOffer, offerBox, starsFromSpend } from './armory.js';
import * as M from './manager.js';
import * as G from './gamble.js';
import * as MK from './market.js';
import { rand, round2 } from './util.js';

export class GameError extends Error {
  constructor(message, code = 'bad') { super(message); this.code = code; }
}
const fail = (m, code) => { throw new GameError(m, code); };

export function makeCtx(st, opts = {}) {
  return {
    st, rng: opts.rng || rand, now: opts.now || Date.now(), online: !!opts.online,
    invCap: opts.invCap || Infinity, reserved: opts.reserved || null,
    add: [], del: [], upd: new Map(), dirty: new Set(),
  };
}

// The changes an action made, in the form sent to online clients.
export function delta(ctx) {
  const set = {};
  for (const k of ctx.dirty) set[k] = ctx.st[k];
  const added = new Set(ctx.add.map((i) => i.uid));
  const removed = new Set(ctx.del);
  return {
    set,
    add: ctx.add.filter((i) => !removed.has(i.uid)),
    del: ctx.del.filter((u) => !added.has(u)),
    upd: [...ctx.upd.values()].filter((i) => !removed.has(i.uid) && !added.has(i.uid)),
  };
}

// ---- helpers -----------------------------------------------------------------------------------
const int = (v, lo, hi, name = 'value') => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) fail(`Invalid ${name}`);
  return n;
};
const money = (v) => {
  const n = round2(Number(v) || 0);
  if (!(n >= 0) || n > 1e12) fail('Invalid amount');
  return n;
};
export function spend(ctx, v) {
  v = round2(v);
  if (ctx.st.money + 1e-9 < v) fail('Not enough money', 'funds');
  ctx.st.money = round2(ctx.st.money - v);
  ctx.dirty.add('money');
}
export function credit(ctx, v) {
  ctx.st.money = round2(ctx.st.money + v);
  ctx.dirty.add('money');
}
export function stats(ctx) {
  ctx.dirty.add('stats');
  return ctx.st.stats;
}
export function give(ctx, items) {
  if (ctx.st.inv.length + items.length > ctx.invCap) fail(`Inventory full (${ctx.invCap} items). Sell something first.`, 'full');
  ctx.st.inv.unshift(...items);
  ctx.add.push(...items);
}
export function findOwned(ctx, uid) {
  const it = ctx.st.inv.find((i) => i.uid === uid);
  if (!it) fail('Item not found (it may have been sold or traded)', 'missing');
  return it;
}
// Removes items from the inventory (fails if any is missing, locked, or tied up in a trade offer).
export function take(ctx, uids, { allowLocked = false } = {}) {
  if (!Array.isArray(uids) || new Set(uids).size !== uids.length) fail('Invalid items');
  const items = uids.map((u) => findOwned(ctx, String(u)));
  for (const it of items) {
    if (it.lk && !allowLocked) fail(`${I.itemName(it)} is locked. Unlock it first.`, 'locked');
    if (ctx.reserved?.has(it.uid)) fail(`${I.itemName(it)} is in a pending trade offer`, 'reserved');
  }
  const set = new Set(uids);
  ctx.st.inv = ctx.st.inv.filter((i) => !set.has(i.uid));
  ctx.del.push(...uids);
  return items;
}
export function touch(ctx, item) { ctx.upd.set(item.uid, item); }

function noteDrops(ctx, items) {
  const s = stats(ctx);
  for (const it of items) {
    const v = I.itemValue(it);
    const rank = I.rarityRank(it);
    s.drops[rank] = (s.drops[rank] || 0) + 1;
    if (I.itemDef(it)?.star) s.knives++;
    if (v > s.bestValue) { s.bestValue = v; s.bestName = I.itemName(it); }
  }
}
function earnStars(ctx, spent) {
  const add = starsFromSpend(ctx.st.starSpend || 0, spent);
  ctx.st.starSpend = round2((ctx.st.starSpend || 0) + spent);
  ctx.dirty.add('starSpend');
  if (add) { ctx.st.stars += add; ctx.dirty.add('stars'); }
  return add;
}
// Sells new drops that match the auto-sell rules straight away (marked `as`, never added to the inventory).
function autoSellDrops(ctx, items, rules) {
  const r = I.cleanAutoSell(rules);
  if (!r) return 0;
  let total = 0;
  for (const it of items) if (I.autoSellMatch(it, r)) { it.as = true; delete it.nw; total += I.itemValue(it); }
  total = round2(total);
  if (total > 0) { credit(ctx, total); stats(ctx).sold = round2(ctx.st.stats.sold + total); }
  return total;
}

// A gambling stake: money plus items, removed from the player. Returns its total value.
export function takeStake(ctx, { money: m = 0, uids = [] } = {}) {
  const cash = money(m);
  if (uids.length > 50) fail('Too many items');
  const items = take(ctx, uids.map(String));
  if (cash) spend(ctx, cash);
  const value = round2(cash + items.reduce((s, it) => s + I.itemValue(it), 0));
  if (value < 0.01) fail('Stake something first');
  return { cash, items, value };
}

// ---- the actions -----------------------------------------------------------------------------------
export const ACTIONS = {
  'case.open'(ctx, { id, n = 1, autoSell }) {
    n = int(n, 1, 10, 'count');
    const c = D.caseById[id];
    if (!c || c.price == null) fail('Unknown case');
    const cost = round2(casePrice(c) * n);
    spend(ctx, cost);
    const items = Array.from({ length: n }, () => I.rollFromCase(c, ctx.rng));
    for (const it of items) it.nw = true;
    noteDrops(ctx, items);
    const s = stats(ctx);
    s.opened += n;
    s.spent = round2(s.spent + cost);
    const stars = earnStars(ctx, cost);
    const autoSold = autoSellDrops(ctx, items, autoSell);
    give(ctx, items.filter((it) => !it.as));
    return { items, cost, stars, autoSold };
  },

  'item.sell'(ctx, { uids }) {
    const items = take(ctx, uids);
    const total = round2(items.reduce((s, it) => s + I.itemValue(it), 0));
    credit(ctx, total);
    stats(ctx).sold = round2(ctx.st.stats.sold + total);
    return { total, n: items.length };
  },
  'item.lock'(ctx, { uid, lk }) {
    const it = findOwned(ctx, uid);
    if (lk) it.lk = true; else delete it.lk;
    touch(ctx, it);
  },
  'item.seen'(ctx, { uids }) {
    for (const u of uids || []) {
      const it = ctx.st.inv.find((i) => i.uid === u);
      if (it?.nw) { delete it.nw; touch(ctx, it); }
    }
  },

  // Buys one listing from the market's limited stock (see engine/market.js). ctx.market(w) can supply the
  // server-wide sold listings; offline they are kept in the save.
  'market.buy'(ctx, { kind, id, n, window: win }) {
    const cur = MK.marketWindow(ctx.now);
    const w = win == null ? cur : int(win, 0, 1e9, 'listing');
    if (w !== cur && !(w === cur - 1 && ctx.now - cur * MK.MARKET_WINDOW_MS < MK.MARKET_GRACE_MS)) fail('The market has restocked. Have a look at the new listings.', 'expired');
    const sold = ctx.market ? ctx.market(w) : MK.localSold(ctx.st, w);
    let item, price, lid;
    if (kind === 'sticker' || kind === 'agent') {
      const d = kind === 'sticker' ? D.stickers[id] : D.agents[id];
      if (!d) fail('Unknown item');
      const count = MK.unitStock(kind, d, w);
      let k = 0;
      while (k < count && sold.has(MK.unitLid(kind, d.id, w, k))) k++;
      if (k >= count) fail(count ? 'Sold out until the next restock' : 'Not for sale right now. Check back after a restock.', 'sold');
      lid = MK.unitLid(kind, d.id, w, k);
      price = d.p;
      item = kind === 'sticker' ? I.makeStickerItem(d, 'Market') : I.makeAgentItem(d, 'Market');
    } else {
      const skin = D.skins[id];
      if (!skin) fail('Unknown item');
      const listing = MK.skinListings(skin, w)[int(n, 0, 99, 'listing')];
      if (!listing) fail('That listing is gone');
      if (sold.has(listing.lid)) fail('Someone already bought that listing', 'sold');
      ({ lid, p: price } = listing);
      item = MK.fromListing(listing);
    }
    spend(ctx, price);
    item.nw = true;
    give(ctx, [item]);
    sold.add(lid); // last, so nothing can fail after a listing is taken
    if (!ctx.market) ctx.dirty.add('market');
    return { item, price, lid, window: w };
  },

  click(ctx, { n, crits = 0 }) {
    n = int(n, 0, 400, 'clicks');
    crits = int(crits, 0, n, 'headshots');
    if (ctx.online && n && crits > Math.ceil(n * E.critChance(ctx.st) * 3) + 3) fail('Suspicious headshot rate');
    const v = E.clickValue(ctx.st);
    const earned = round2(v * (n - crits) + v * E.CRIT_MULT * crits);
    credit(ctx, earned);
    const s = stats(ctx);
    s.clicks += n;
    s.clickEarned = round2(s.clickEarned + earned);
    return { earned };
  },
  'upgrade.buy'(ctx, { id }) {
    const u = E.UPGRADES.find((x) => x.id === id);
    if (!u) fail('Unknown upgrade');
    if (u.max != null && E.lvl(ctx.st, id) >= u.max) fail('Already maxed');
    spend(ctx, E.upgradeCost(ctx.st, u));
    ctx.st.upg = { ...ctx.st.upg, [id]: E.lvl(ctx.st, id) + 1 };
    ctx.dirty.add('upg');
  },
  'coop.slot'(ctx) {
    spend(ctx, E.coopSlotCost(ctx.st));
    ctx.st.coopSlots++;
    ctx.dirty.add('coopSlots');
  },

  'stickers.apply'(ctx, { uid, stickers }) {
    const item = findOwned(ctx, uid);
    if (!I.canHaveStickers(item)) fail('Stickers can’t be applied to this item');
    if (!Array.isArray(stickers) || !stickers.length) fail('No stickers');
    if ((item.stk?.length || 0) + stickers.length > I.MAX_STICKERS) fail('All 5 sticker slots are used');
    const srcs = take(ctx, stickers.map((s) => String(s.srcUid)));
    if (srcs.some((s) => s.t !== 'sticker')) fail('Only stickers can be applied');
    const num = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));
    const placed = stickers.map((s, i) => ({
      id: srcs[i].id, x: num(s.x, 0, 1), y: num(s.y, 0, 1), r: num(s.r, -180, 180), wr: 0, ...(s.m ? { m: 1 } : {}),
    }));
    item.stk = [...(item.stk || []), ...placed];
    touch(ctx, item);
    stats(ctx).stickersApplied += placed.length;
    return { item };
  },
  'stickers.scrape'(ctx, { uid, i }) {
    const item = findOwned(ctx, uid);
    const idx = int(i, 0, (item.stk?.length || 1) - 1, 'sticker');
    const s = item.stk[idx];
    const next = round2((s.wr || 0) + 0.25);
    const stk = [...item.stk];
    if (next >= 1) stk.splice(idx, 1);
    else stk[idx] = { ...s, wr: next };
    item.stk = stk;
    touch(ctx, item);
    return { item, removed: next >= 1 };
  },

  'tradeup.sign'(ctx, { uids }) {
    if (!Array.isArray(uids)) fail('Invalid contract');
    const items = uids.map((u) => findOwned(ctx, String(u)));
    const contract = tradeupContract(items);
    if (!contract.ok) fail(contract.error);
    take(ctx, uids.map(String));
    const item = rollTradeup(contract, ctx.rng);
    item.nw = true;
    give(ctx, [item]);
    noteDrops(ctx, [item]);
    stats(ctx).tradeups++;
    return { item };
  },

  'armory.pass'(ctx) {
    spend(ctx, PASS_PRICE);
    ctx.st.stars += PASS_STARS;
    ctx.dirty.add('stars');
    return { stars: PASS_STARS };
  },
  'armory.redeem'(ctx, { offer, autoSell }) {
    const o = findLiveOffer(String(offer), ctx.now);
    if (!o) fail('That offer has rotated out of the armory', 'expired');
    if (ctx.st.stars < o.stars) fail('Not enough Armory Stars', 'funds');
    ctx.st.stars -= o.stars;
    ctx.dirty.add('stars');
    const box = offerBox(o);
    const item = I.rollFromCase(box, ctx.rng);
    item.src = 'Armory · ' + box.n;
    item.nw = true;
    noteDrops(ctx, [item]);
    const autoSold = autoSellDrops(ctx, [item], autoSell);
    if (!item.as) give(ctx, [item]);
    stats(ctx).armory++;
    return { item, offer: o, autoSold };
  },

  'team.pack'(ctx, { pack, token = false }) {
    const def = M.packById(String(pack));
    if (!def || (def.perEvent && !M.packEvents().includes(+String(pack).split(':')[1]))) fail('Unknown pack');
    if (token) {
      const t = ctx.st.team.tokens[def.id] || 0;
      if (t < 1) fail('No pack token');
      ctx.st.team.tokens = { ...ctx.st.team.tokens, [def.id]: t - 1 };
      ctx.dirty.add('team');
    } else spend(ctx, M.packPrice(String(pack)));
    const items = M.openPack(String(pack), ctx.rng);
    for (const it of items) it.nw = true;
    give(ctx, items);
    stats(ctx).packs++;
    return { items };
  },
  'team.set'(ctx, { slots = {}, bench = [], name }) {
    const used = new Set();
    const check = (u) => {
      if (u == null) return null;
      const it = findOwned(ctx, String(u));
      if (it.t !== 'pro') fail('Only pro player cards can be in your team');
      if (used.has(it.uid)) fail('A card can only be in one slot');
      const pid = D.pros[it.id].pid;
      if ([...used].some((x) => D.pros[ctx.st.inv.find((i) => i.uid === x).id].pid === pid)) fail('That player is already in your team');
      used.add(it.uid);
      return it.uid;
    };
    const t = { ...ctx.st.team, slots: {}, bench: [] };
    for (const s of M.SLOTS) t.slots[s] = check(slots[s]);
    t.bench = [0, 1].map((i) => check(bench[i]));
    if (typeof name === 'string') t.name = name.replace(/[<>]/g, '').trim().slice(0, 24) || 'My Team';
    ctx.st.team = t;
    ctx.dirty.add('team');
  },
  'team.match'(ctx, { opp }) {
    const lineup = M.lineupFromState(ctx.st);
    const mine = M.teamRating(lineup);
    if (!mine.complete) fail('Fill all five roles first');
    const other = M.rosterTeam(String(opp));
    if (!other) fail('Unknown opponent');
    const match = M.simulateMatch({ name: ctx.st.team.name, lineup }, other, ctx.rng);
    const won = match.winner === 'A';
    const reward = M.matchReward(mine.rating, other.rating, won);
    credit(ctx, reward);
    const t = ctx.st.team;
    const exp = 1 / (1 + Math.pow(10, (other.rating * 12 + 100 - t.elo) / 400));
    ctx.st.team = {
      ...t, w: t.w + (won ? 1 : 0), l: t.l + (won ? 0 : 1), elo: Math.round(t.elo + 24 * ((won ? 1 : 0) - exp)),
      history: [{ opp: other.name, score: match.score, won, at: ctx.now }, ...t.history].slice(0, 20),
    };
    ctx.dirty.add('team');
    stats(ctx).matches++;
    return { match, reward, opp: { key: other.key, name: other.name, rating: other.rating }, mine: mine.rating };
  },
  'team.cupStart'(ctx, { type }) {
    if (!M.CUPS[type]) fail('Unknown event');
    const mine = M.teamRating(M.lineupFromState(ctx.st));
    if (!mine.complete) fail('Fill all five roles first');
    if (ctx.st.team.cup && !ctx.st.team.cup.done) fail('Finish your current event first');
    ctx.st.team = { ...ctx.st.team, cup: M.newCup(type, mine.rating, ctx.rng) };
    ctx.dirty.add('team');
    return { cup: ctx.st.team.cup };
  },
  'team.cupPlay'(ctx) {
    const cup = ctx.st.team.cup;
    if (!cup || cup.done) fail('No event in progress');
    const lineup = M.lineupFromState(ctx.st);
    const mine = M.teamRating(lineup);
    if (!mine.complete) fail('Fill all five roles first');
    const me = { name: ctx.st.team.name, lineup };
    const def = M.CUPS[cup.type];
    const next = [], results = [];
    let myMatch = null, myOpp = null;
    for (let i = 0; i < cup.alive.length; i += 2) {
      const a = cup.alive[i], b = cup.alive[i + 1];
      const ta = a === 'me' ? me : M.rosterTeam(a), tb = b === 'me' ? me : M.rosterTeam(b);
      const m = M.simulateMatch(ta, tb, ctx.rng);
      const w = m.winner === 'A' ? a : b;
      next.push(w);
      results.push({ a, b, score: m.score, w });
      if (a === 'me' || b === 'me') { myMatch = a === 'me' ? m : { ...m, score: [m.score[1], m.score[0]], winner: m.winner === 'A' ? 'B' : 'A' }; myOpp = a === 'me' ? b : a; }
    }
    const out = { ...cup, round: cup.round + 1, results: [...cup.results, results], alive: next };
    let prize = 0, token = null;
    const stillIn = next.includes('me');
    if (!stillIn || next.length === 1) {
      out.done = true;
      out.place = stillIn ? 1 : cup.alive.length / 2 + 1;
      prize = def.prize[out.place] || 0;
      if (out.place === 1) token = def.token;
    }
    if (prize) credit(ctx, prize);
    const tokens = token ? { ...ctx.st.team.tokens, [token]: (ctx.st.team.tokens[token] || 0) + 1 } : ctx.st.team.tokens;
    ctx.st.team = { ...ctx.st.team, cup: out, tokens };
    ctx.dirty.add('team');
    stats(ctx).matches++;
    return { match: myMatch, opp: myOpp, oppName: M.teamLabel(myOpp), cup: out, prize, token };
  },
  'team.cupLeave'(ctx) {
    ctx.st.team = { ...ctx.st.team, cup: null };
    ctx.dirty.add('team');
  },

  // ---- gambling against bots (offline, and bot games online) ----
  'gamble.coinflip'(ctx, { money: m, uids = [], side, clientSeed }) {
    if (!G.SIDES.includes(side)) fail('Pick CT or T');
    const stake = takeStake(ctx, { money: m, uids });
    const fair = G.newFairness(clientSeed);
    const result = G.coinflipResult(fair.serverSeed, fair.clientSeed);
    const won = result === side;
    const bot = G.botPlayer(fair.hash.slice(0, 8));
    if (won) { credit(ctx, round2(stake.cash + stake.value)); if (stake.items.length) give(ctx, stake.items); }
    const s = stats(ctx);
    s.gambleWagered = round2(s.gambleWagered + stake.value);
    s.gambleWon = round2(s.gambleWon + (won ? stake.value : -stake.value));
    return { result, won, side, value: stake.value, bot, fair };
  },
  'gamble.jackpot'(ctx, { money: m, uids = [], bots = 3, clientSeed }) {
    const nb = int(bots, 1, 7, 'bots');
    const stake = takeStake(ctx, { money: m, uids });
    const fair = G.newFairness(clientSeed);
    const r = G.fairRng(fair.serverSeed, fair.clientSeed, 'bots');
    const entries = [{ id: 'me', name: 'You', value: stake.value }];
    let pot = stake.value;
    for (let i = 0; i < nb; i++) {
      const bot = G.botPlayer(fair.hash.slice(0, 6) + i);
      const value = G.botJackpotStake(pot, r);
      entries.push({ ...bot, value });
      pot = round2(pot + value);
    }
    const { winner, ticket, total } = G.jackpotWinner(entries, fair.serverSeed, fair.clientSeed);
    const won = winner === 'me';
    if (won) { credit(ctx, round2(stake.cash + total - stake.value)); if (stake.items.length) give(ctx, stake.items); }
    const s = stats(ctx);
    s.gambleWagered = round2(s.gambleWagered + stake.value);
    s.gambleWon = round2(s.gambleWon + (won ? total - stake.value : -stake.value));
    return { entries, winner, ticket, total, won, fair };
  },
  'gamble.battle'(ctx, { cases, format = '1v1', mode = 'normal', clientSeed }) {
    if (!G.BATTLE_FORMATS[format]) fail('Unknown format');
    if (!G.BATTLE_MODES[mode]) fail('Unknown mode');
    if (!Array.isArray(cases) || !cases.length || cases.length > G.MAX_BATTLE_ROUNDS) fail(`Pick 1 to ${G.MAX_BATTLE_ROUNDS} cases`);
    if (cases.some((id) => !D.caseById[id] || D.caseById[id].price == null)) fail('Unknown case');
    const cost = G.battleCost(cases);
    spend(ctx, cost);
    const fair = G.newFairness(clientSeed);
    const f = G.BATTLE_FORMATS[format];
    const seats = Array.from({ length: f.seats }, (_, i) => (i === 0 ? { id: 'me', name: 'You' } : G.botPlayer(fair.hash.slice(0, 6) + i)));
    const res = G.runBattle({ cases, format, mode }, fair, I.itemValue);
    const myTeam = f.teams.findIndex((t) => t.includes(0));
    const won = res.winTeam === myTeam;
    const prize = won ? res.share[0] : [];
    for (const it of prize) it.nw = true;
    if (prize.length) give(ctx, prize);
    const value = round2(prize.reduce((s, it) => s + I.itemValue(it), 0));
    const s = stats(ctx);
    s.battles++;
    s.spent = round2(s.spent + cost);
    s.gambleWagered = round2(s.gambleWagered + cost);
    s.gambleWon = round2(s.gambleWon + value - cost);
    earnStars(ctx, cost);
    return { ...res, seats, won, cost, prize, value, fair, cases, format, mode };
  },
};

// Runs fn all-or-nothing: if it throws part-way (not enough money after a check, inventory full...), the
// state's top-level fields, inventory list and stats are put back as they were.
export function atomically(ctx, fn) {
  const st = ctx.st;
  const snap = { ...st, inv: st.inv.slice(), stats: { ...st.stats, drops: { ...st.stats.drops } } };
  try {
    return fn();
  } catch (e) {
    for (const k of Object.keys(st)) if (!(k in snap)) delete st[k];
    Object.assign(st, snap);
    ctx.add.length = 0; ctx.del.length = 0; ctx.upd.clear(); ctx.dirty.clear();
    throw e;
  }
}

// Runs an action by name. Throws GameError on invalid requests (and then nothing has changed).
export function runAction(ctx, name, args = {}) {
  const fn = ACTIONS[name];
  if (!fn) fail('Unknown action');
  return atomically(ctx, () => fn(ctx, args || {}) ?? {});
}
