// Every change to a player's state goes through these actions. Offline, the client runs them on the local save;
// online, the server runs the exact same code on the account and sends the client the resulting changes.
//
// An action gets a context (ctx) wrapping the state, the RNG and the clock, and records what it changed:
// added/removed/updated items and the other top-level fields it touched (money, stars, stats...).
import { D, keyFor } from './data.js';
import * as I from './items.js';
import { tradeupContract, rollTradeup } from './tradeup.js';
import { PASS_PRICE, PASS_STARS, findLiveOffer, offerBox, starsFromSpend } from './armory.js';
import * as G from './gamble.js';
import * as MK from './market.js';
import * as R from './ranks.js';
import * as P from './premier.js';
import * as MM from './matchmaking.js';
import * as L from './levels.js';
import * as N from './npcs.js';
import * as SU from './storage.js';
import { rand, round2, clamp, pick, pickWeighted, uid as newUid } from './util.js';

export class GameError extends Error {
  constructor(message, code = 'bad') { super(message); this.code = code; }
}
const fail = (m, code) => { throw new GameError(m, code); };
const PLAY_MODES = ['premier', 'competitive', 'wingman', 'deathmatch', 'armsrace'];
const FFA_MODES = new Set(['deathmatch', 'armsrace']); // (no rounds: everyone for themselves)
const MODE_NAMES = { premier: 'Premier', competitive: 'Competitive', wingman: 'Wingman' };
const RANK_KEY = { competitive: 'rank', wingman: 'wingman' }; // (the state's field for each mode's rank)

// The ranked match you were in is over: nothing left to abandon.
function finishMatch(ctx) {
  if (!ctx.st.mm?.match) return;
  ctx.st.mm = { ...ctx.st.mm, match: null };
  ctx.dirty.add('mm');
}
// A ranked match abandoned: a loss for its mode's rank (or CS Rating) and the cooldown.
function abandonMatch(ctx, { roundsFor = 0, roundsAgainst = 0 } = {}) {
  const m = ctx.st.mm.match, result = 'loss';
  let rated;
  if (m.mode === 'premier') {
    rated = P.ratePremier(ctx.st.premier, { result, roundsFor, roundsAgainst, opponent: m.opponent ?? P.START_RATING });
    ctx.st.premier = rated.premier;
    ctx.dirty.add('premier');
  } else {
    const key = RANK_KEY[m.mode] || 'rank';
    rated = R.rateMatch(ctx.st[key], { result, roundsFor, roundsAgainst, opponent: m.opponent ?? null, now: ctx.now });
    ctx.st[key] = rated.rank;
    ctx.dirty.add(key);
  }
  const { mm, ms } = MM.abandon(ctx.st.mm, ctx.now);
  ctx.st.mm = mm;
  ctx.dirty.add('mm');
  return { mode: m.mode, cooldown: ms, until: mm.until, rated };
}

export function makeCtx(st, opts = {}) {
  return {
    st, rng: opts.rng || rand, now: opts.now || Date.now(), online: !!opts.online,
    invCap: opts.invCap || Infinity, reserved: opts.reserved || null,
    add: [], del: [], upd: new Map(), dirty: new Set(), sto: { add: [], del: [] },
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
    // (only what moved in or out of a Storage Unit: their contents are too big to send whole)
    ...(ctx.sto.add.length || ctx.sto.del.length ? { sto: { add: ctx.sto.add, del: ctx.sto.del } } : {}),
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
  if (it) return it;
  const kept = SU.storedItem(ctx.st, uid);
  if (kept) fail(`${I.itemName(kept)} is in a Storage Unit. Retrieve it first.`, 'stored');
  fail('Item not found (it may have been sold or traded)', 'missing');
}
// Removes items from the inventory (fails if any is missing, locked, a Storage Unit, or tied up in a trade offer). Only
// what's meant for units themselves passes allowUnit.
export function take(ctx, uids, { allowLocked = false, allowUnit = false } = {}) {
  if (!Array.isArray(uids) || new Set(uids).size !== uids.length) fail('Invalid items');
  const items = uids.map((u) => findOwned(ctx, String(u)));
  for (const it of items) {
    if (it.lk && !allowLocked) fail(`${I.itemName(it)} is locked. Unlock it first.`, 'locked');
    if (I.isUnit(it) && !allowUnit) fail("Storage Units can't be traded or sold", 'unit');
    if (ctx.reserved?.has(it.uid)) fail(`${I.itemName(it)} is in a pending trade offer`, 'reserved');
  }
  const set = new Set(uids);
  ctx.st.inv = ctx.st.inv.filter((i) => !set.has(i.uid));
  ctx.del.push(...uids);
  unequip(ctx, set);
  return items;
}
// Staff removing items (the admin panels): from the inventory (locked ones too) or out of Storage Units. A unit only goes
// with everything in it, so nothing is left without one.
export function takeForStaff(ctx, uids) {
  const stored = new Map(SU.storedOf(ctx.st).map((it) => [it.uid, it]));
  const gone = new Set(uids);
  for (const u of uids) {
    const it = ctx.st.inv.find((i) => i.uid === u);
    if (!it || !I.isUnit(it)) continue;
    const left = SU.contents(ctx.st, u).filter((x) => !gone.has(x.uid)).length;
    if (left) fail(`${I.itemName(it)} still holds ${left} item${left === 1 ? '' : 's'}: remove them with it, or take them out first`, 'unit');
  }
  const out = uids.filter((u) => stored.has(u)).map((u) => stored.get(u));
  const items = take(ctx, uids.filter((u) => !stored.has(u)), { allowLocked: true, allowUnit: true });
  if (out.length) {
    ctx.st.stored = SU.storedOf(ctx.st).filter((it) => !gone.has(it.uid));
    ctx.sto.del.push(...out.map((it) => it.uid));
  }
  return [...items, ...out];
}
// Clears loadout slots holding any of these uids (the items left the inventory or were unequipped).
function unequip(ctx, uids) {
  const lo = ctx.st.loadout || {};
  const keep = Object.entries(lo).filter(([, u]) => !uids.has(u));
  if (keep.length === Object.keys(lo).length) return;
  ctx.st.loadout = Object.fromEntries(keep);
  ctx.dirty.add('loadout');
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
// Gives unboxed items their serial numbers (see items.serialKey). ctx.serial(key) is the server's shared counter;
// offline the save keeps its own (replaced, not mutated, so a failed action rolls it back).
function serialize(ctx, items) {
  for (const it of items) {
    const key = I.serialKey(it);
    if (ctx.serial) it.sn = ctx.serial(key);
    else {
      const n = (ctx.st.serials?.[key] || 0) + 1;
      ctx.st.serials = { ...(ctx.st.serials || {}), [key]: n };
      ctx.dirty.add('serials');
      it.sn = n;
    }
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

// ---- NPC players (engine/npcs.js): their state, trades with them -------------------------------------------------------
// Their state, copied so a failed action leaves the save as it was (atomically() puts back top-level fields only).
function social(ctx) {
  if (ctx.online) fail('NPC players are only in offline mode', 'online');
  return ctx.st.social ? structuredClone(ctx.st.social) : N.freshSocial(Math.floor(ctx.rng() * 2 ** 31), ctx.now);
}
function keepSocial(ctx, so) { ctx.st.social = so; ctx.dirty.add('social'); }
function openOffer(so, id) {
  const o = so.offers.find((x) => x.id === id);
  if (!o || o.status !== 'open') fail('That offer is no longer open', 'missing');
  return o;
}
// A blocked NPC (the admin panel offline) takes no offers, messages or friend requests from you, and you can't take
// theirs.
function notBlocked(ctx, so, n) {
  if (N.isBlocked(so, n.id, ctx.now)) fail(`${n.name} is blocked in the admin panel`, 'blocked');
}
const tradeText = (items, cash) => [...items.map(I.itemName), cash ? N.dollars(cash) : ''].filter(Boolean).join(' + ') || 'nothing';
// An NPC keeps at most 60 items (the cheapest go).
function trimInv(s) {
  if (s.inv.length <= 60) return;
  s.inv.sort((a, b) => I.itemValue(b) - I.itemValue(a));
  s.inv.length = 60;
}
// Swaps items and money with an NPC in one go: their side is checked first, yours is taken like any trade's.
function swapWithNpc(ctx, so, n, { mine, theirs, myMoney, theirMoney }) {
  const s = N.npcState(so, n.id);
  const got = theirs.map((u) => s.inv.find((x) => x.uid === u) || fail(`${n.name} no longer has that item`, 'missing'));
  if (theirMoney > s.money + 1e-9) fail(`${n.name} can't afford that any more`, 'funds');
  const given = take(ctx, mine);
  if (myMoney) spend(ctx, myMoney);
  if (theirMoney) credit(ctx, theirMoney);
  s.inv = [...s.inv.filter((x) => !theirs.includes(x.uid)), ...given.map(({ lk: _lk, nw: _nw, ...it }) => ({ ...it, at: ctx.now }))];
  trimInv(s);
  s.money = round2(s.money - theirMoney + myMoney);
  s.trades = (s.trades || 0) + 1;
  s.mood = clamp((s.mood ?? 0.7) + 0.1, 0, 1);
  const items = got.map((it) => ({ ...it, at: ctx.now, nw: true, src: `Trade with ${n.name}` }));
  if (items.length) give(ctx, items);
  // Sometimes they leave you +rep on your profile.
  if (ctx.rng() < 0.4) {
    so.comments.unshift({ at: ctx.now, npc: n.id, text: pick(['+rep fast trader', '+rep smooth trade', '+rep legit 👍', '+rep nice inventory!', '+rep good guy, fair prices'], ctx.rng) });
    so.comments.length = Math.min(so.comments.length, 30);
  }
  const st = stats(ctx);
  st.npcTrades = (st.npcTrades || 0) + 1;
  return { got: items, given, money: round2(theirMoney - myMoney) };
}
// Offline, what you sell on the Market is bought by someone: the better items end up in an NPC's inventory (not a
// blocked one's, and nobody's with the NPCs' market rule off).
function passToNpcs(ctx, items) {
  if (ctx.online || !ctx.st.social || !N.ruleOn(ctx.st.social, 'market')) return;
  const worth = items.filter((it) => I.itemValue(it) >= 5);
  if (!worth.length) return;
  const so = structuredClone(ctx.st.social);
  const people = N.activeCrowd(so.seed).filter((n) => !N.isBlocked(so, n.id, ctx.now));
  if (!people.length) return;
  for (const { lk: _lk, nw: _nw, ...it } of worth) {
    const s = N.npcState(so, pick(people, ctx.rng).id);
    s.inv.push({ ...it, at: ctx.now, src: 'Market' });
    trimInv(s);
  }
  keepSocial(ctx, so);
}

// ---- Storage Units (see storage.js) -----------------------------------------------------------------
function ownedUnit(ctx, uid) {
  const it = findOwned(ctx, String(uid));
  if (!I.isUnit(it)) fail("That isn't a Storage Unit");
  return it;
}
function unitUids(v) {
  if (!Array.isArray(v) || !v.length || v.length > SU.UNIT_CAP) fail('Pick the items first');
  const uids = v.map(String);
  if (new Set(uids).size !== uids.length) fail('Invalid items');
  return uids;
}
// A unit changed (last, so nothing can fail after it: a failed action doesn't put items back as they were).
function unitChanged(ctx, unit) {
  unit.mod = ctx.now;
  touch(ctx, unit);
}

// ---- the actions -----------------------------------------------------------------------------------
export const ACTIONS = {
  // Buying cases (and capsules, packages...): they go to your inventory, like CS2's store. A case that takes a key opens
  // with one of its keys (key.buy, case.open).
  'case.buy'(ctx, { id, n = 1 }) {
    n = int(n, 1, 100, 'count');
    const c = D.caseById[id];
    if (!c || c.price == null) fail('Unknown case');
    const cost = round2(c.price * n);
    spend(ctx, cost);
    const items = Array.from({ length: n }, () => ({ ...I.makeCrateItem(c, 'Store'), nw: true }));
    give(ctx, items);
    const s = stats(ctx);
    s.spent = round2(s.spent + cost);
    return { items, cost, stars: earnStars(ctx, cost) };
  },
  'key.buy'(ctx, { key, n = 1 }) {
    n = int(n, 1, 100, 'count');
    if (!D.keys[key]) fail('Unknown key');
    const cost = round2(D.keyPrice * n);
    spend(ctx, cost);
    const items = Array.from({ length: n }, () => ({ ...I.makeKeyItem(key, 'Store'), nw: true }));
    give(ctx, items);
    const s = stats(ctx);
    s.spent = round2(s.spent + cost);
    return { items, cost, stars: earnStars(ctx, cost) };
  },
  // Opens n of your cases of one kind (uids: which ones, else your oldest), each with one of your keys for it if it takes
  // one. Locked cases and keys, and ones in a trade offer, stay put.
  'case.open'(ctx, { id, n = 1, uids = null, autoSell }) {
    n = int(Array.isArray(uids) ? uids.length : n, 1, 10, 'count');
    const c = D.caseById[id];
    if (!c) fail('Unknown case');
    const free = (it) => !it.lk && !ctx.reserved?.has(it.uid);
    const oldest = (a, b) => (a.at || 0) - (b.at || 0);
    const boxes = Array.isArray(uids) ? uids.map((u) => findOwned(ctx, String(u)))
      : ctx.st.inv.filter((it) => it.t === 'crate' && it.id === c.id && free(it)).sort(oldest).slice(0, n);
    if (boxes.some((b) => b.t !== 'crate' || b.id !== c.id)) fail(`Those aren't all ${c.n}s`);
    if (boxes.length < n) fail(n > 1 ? `You have ${boxes.length} ${c.n}${boxes.length === 1 ? '' : 's'}, not ${n}` : `You don't have a ${c.n}. Buy one first.`, 'nocase');
    const key = keyFor(c);
    const keys = key ? ctx.st.inv.filter((it) => it.t === 'key' && it.id === key && free(it)).sort(oldest).slice(0, n) : [];
    if (key && keys.length < n) fail(`You need ${n > 1 ? n + ' ' + D.keys[key].n + 's' : 'a ' + D.keys[key].n} to open ${n > 1 ? 'these' : 'this'}. Buy ${n > 1 ? 'them' : 'one'} first.`, 'nokey');
    take(ctx, [...boxes, ...keys].map((it) => it.uid));
    const items = Array.from({ length: n }, () => I.rollFromCase(c, ctx.rng));
    serialize(ctx, items);
    for (const it of items) it.nw = true;
    noteDrops(ctx, items);
    stats(ctx).opened += n;
    const autoSold = autoSellDrops(ctx, items, autoSell);
    give(ctx, items.filter((it) => !it.as));
    return { items, autoSold };
  },
  // A Storage Unit from the store. As in CS2 a full inventory can still buy one (it's how you make room), so it doesn't go
  // through give(); there's a limit on how many you can own instead.
  'storage.buy'(ctx, { n = 1 }) {
    n = int(n, 1, 10, 'count');
    if (SU.unitsOf(ctx.st).length + n > SU.MAX_UNITS) fail(`You already own too many Storage Units (${SU.MAX_UNITS} at most)`, 'units');
    const cost = round2(SU.UNIT_PRICE * n);
    spend(ctx, cost);
    const items = Array.from({ length: n }, () => ({ ...I.makeUnitItem('Store'), nw: true }));
    ctx.st.inv.unshift(...items);
    ctx.add.push(...items);
    return { items, cost };
  },
  // Its label: set when you start using it, changed for free at any time.
  'storage.name'(ctx, { unit, name }) {
    const u = ownedUnit(ctx, unit), label = SU.cleanName(name);
    if (!label) fail('Enter a label for it first');
    u.name = label;
    unitChanged(ctx, u);
    return { item: u };
  },
  // Into a unit, all or nothing. Locked items may go (they stay locked); items in a pending trade offer may not.
  'storage.deposit'(ctx, { unit, uids }) {
    const u = ownedUnit(ctx, unit), list = unitUids(uids);
    if (!u.name) fail('Label this Storage Unit first', 'unnamed');
    const room = SU.UNIT_CAP - SU.unitCount(ctx.st, u.uid);
    if (list.length > room) fail(room ? `This Storage Unit only has room for ${room} more item${room === 1 ? '' : 's'}` : `This Storage Unit is full (${SU.UNIT_CAP.toLocaleString('en-US')} items)`, 'unitfull');
    for (const id of list) { const why = SU.storeRefusal(findOwned(ctx, id)); if (why) fail(why, 'unit'); }
    const stored = take(ctx, list, { allowLocked: true }).map(({ nw: _nw, ...it }) => ({ ...it, su: u.uid, sat: ctx.now }));
    ctx.st.stored = [...stored, ...SU.storedOf(ctx.st)];
    ctx.sto.add.push(...stored);
    unitChanged(ctx, u);
    return { n: stored.length };
  },
  // Out of a unit, all or nothing (a full inventory refuses it, as in CS2).
  'storage.retrieve'(ctx, { unit, uids }) {
    const u = ownedUnit(ctx, unit), list = unitUids(uids);
    const inside = new Map(SU.contents(ctx.st, u.uid).map((it) => [it.uid, it]));
    const items = list.map((id) => inside.get(id) || fail("That item isn't in this Storage Unit", 'missing')).map(({ su: _su, sat: _sat, ...it }) => it);
    const set = new Set(list);
    ctx.st.stored = SU.storedOf(ctx.st).filter((it) => !set.has(it.uid));
    ctx.sto.del.push(...list);
    give(ctx, items);
    unitChanged(ctx, u);
    return { n: items.length };
  },
  // An empty unit can be deleted (since CS2's October 2022 update), for no refund.
  'storage.delete'(ctx, { unit }) {
    const u = ownedUnit(ctx, unit), n = SU.unitCount(ctx.st, u.uid);
    if (n) fail(`Retrieve the ${n} item${n === 1 ? '' : 's'} in it first`, 'unit');
    take(ctx, [u.uid], { allowLocked: true, allowUnit: true });
  },

  'item.sell'(ctx, { uids }) {
    const items = take(ctx, uids);
    const total = round2(items.reduce((s, it) => s + I.itemValue(it), 0));
    credit(ctx, total);
    stats(ctx).sold = round2(ctx.st.stats.sold + total);
    passToNpcs(ctx, items);
    return { total, n: items.length };
  },
  'item.lock'(ctx, { uid, lk }) {
    const it = findOwned(ctx, uid);
    if (lk) it.lk = true; else delete it.lk;
    touch(ctx, it);
  },
  // Loadout: equip an item in its slot (replacing what was there), or take it off.
  'loadout.equip'(ctx, { uid }) {
    const it = findOwned(ctx, String(uid));
    const slot = I.loadoutSlot(it);
    if (!slot) fail(`${I.itemName(it)} can't be equipped`);
    ctx.st.loadout = { ...(ctx.st.loadout || {}), [slot]: it.uid };
    ctx.dirty.add('loadout');
    return { slot };
  },
  'loadout.unequip'(ctx, { uid }) {
    unequip(ctx, new Set([String(uid)]));
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
    if (kind === 'charm') {
      // A listing by its number (each has its own pattern and price), or the first one left.
      const d = D.charms[id];
      if (!d) fail('Unknown item');
      const all = MK.charmListings(d, w);
      const listing = n == null ? all.find((l) => !sold.has(l.lid)) : all[int(n, 0, 99, 'listing')];
      if (n == null && !listing) fail(all.length ? 'Sold out until the next restock' : 'Not for sale right now. Check back after a restock.', 'sold');
      if (!listing) fail('That listing is gone');
      if (sold.has(listing.lid)) fail('Someone already bought that listing', 'sold');
      ({ lid, p: price } = listing);
      item = MK.fromListing(listing);
    } else if (kind === 'sticker' || kind === 'agent') {
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

  // A Play match starts (any mode, private ones too): its reward is checked against it when it ends. Returns its run id.
  'play.start'(ctx, { mode }) {
    if (!PLAY_MODES.includes(mode)) fail('Invalid mode');
    ctx.st.play = { run: newUid(), mode, at: ctx.now };
    ctx.dirty.add('play');
    return { run: ctx.st.play.run };
  },
  // A finished Play match pays and gives XP (see levels.js): its result, your kills and assists, and the rounds your team
  // won. Online the server can't see the match, so it only pays one it saw start (play.start), once, and only what that
  // match could have earned: long enough for its rounds, and no more kills than there were enemies to kill.
  'play.reward'(ctx, { run = null, mode = null, result = null, won = false, kills = 0, assists = 0, roundsWon = null, rounds = 0 }) {
    result ??= won ? 'win' : 'loss'; // (callers from before draws were paid)
    if (!L.RESULTS.includes(result)) fail('Invalid result');
    kills = int(kills, 0, 400, 'kills'); assists = int(assists, 0, 400, 'assists'); rounds = int(rounds, 0, 60, 'rounds');
    roundsWon = roundsWon == null ? rounds : int(roundsWon, 0, 60, 'rounds'); // (older callers sent the rounds won as rounds)
    const cur = ctx.st.play?.run && ctx.st.play.run === run ? ctx.st.play : null;
    if (ctx.online && !cur) fail("The server didn't see that match start, so it can't pay for it", 'match');
    const ffa = FFA_MODES.has(cur?.mode || mode);
    if (cur) {
      const secs = (ctx.now - cur.at) / 1000;
      const played = Math.max(rounds, roundsWon), enemies = cur.mode === 'wingman' ? 2 : 5;
      const fits = secs <= 6 * 3600 && (ffa ? secs >= 60 && kills <= secs / 1.5 + 5 && assists <= secs / 1.5 + 5
        : secs >= played * 15 && kills <= played * enemies && assists <= played * enemies);
      if (!fits) fail("Those match results don't add up", 'match');
      ctx.st.play = null;
      ctx.dirty.add('play');
    }
    const pay = L.matchPay({ result, kills, assists });
    const xp = L.matchXp({ result, kills, assists, roundsWon: ffa ? 0 : roundsWon });
    credit(ctx, pay.total);
    const lv = L.addXp(ctx.st.prof, xp.total, { r: ctx.rng, now: ctx.now });
    ctx.st.prof = lv.prof;
    ctx.dirty.add('prof');
    const s = stats(ctx);
    s.playMatches = (s.playMatches || 0) + 1;
    s.playWins = (s.playWins || 0) + (result === 'win' ? 1 : 0);
    s.playKills = (s.playKills || 0) + kills;
    s.playEarned = round2((s.playEarned || 0) + pay.total);
    return { result, earned: pay.total, pay, xp, before: lv.before, after: lv.after, levelUps: lv.levelUps, medals: lv.medals, waiting: lv.prof.drops.length };
  },
  // Claiming a level-up reward: two of its four items, like CS2's care package.
  'drop.claim'(ctx, { id, picks }) {
    const prof = { ...L.freshProfile(), ...ctx.st.prof };
    const drop = prof.drops.find((d) => d.id === id);
    if (!drop) fail('That reward was already claimed', 'missing');
    if (!Array.isArray(picks) || new Set(picks).size !== L.CARE_PICKS || picks.some((i) => !Number.isInteger(i) || i < 0 || i >= drop.offers.length)) fail(`Pick ${L.CARE_PICKS} items`);
    const items = picks.map((i) => ({ ...drop.offers[i], at: ctx.now, nw: true }));
    give(ctx, items);
    ctx.st.prof = { ...prof, drops: prof.drops.filter((d) => d !== drop) };
    ctx.dirty.add('prof');
    return { items };
  },

  // Searching for a match. A ranked match still open from before (the game closed during it) was abandoned: settled
  // first, a loss and the cooldown. Returns { settled, cooldown } (ms left of an abandon's cooldown, for a ranked mode:
  // no searching until it's over).
  'play.queue'(ctx, { mode }) {
    if (!PLAY_MODES.includes(mode)) fail('Invalid mode');
    const settled = ctx.st.mm?.match ? abandonMatch(ctx) : null;
    return { settled, cooldown: MM.isRanked(mode) ? MM.cooldownLeft(ctx.st.mm, ctx.now) : 0 };
  },
  // A ranked match starts: it's yours until it's finished (a quit game, or not coming back to it, is an abandon).
  // opponent: the other team's average rating.
  'play.join'(ctx, { mode, opponent = 0 }) {
    if (!MM.isRanked(mode)) fail('Invalid mode');
    const left = MM.cooldownLeft(ctx.st.mm, ctx.now);
    if (left) fail(`You can't play ${MODE_NAMES[mode]} for ${MM.formatWait(left)}: you abandoned a match`, 'cooldown');
    if (ctx.st.mm?.match) fail('You are already in a match');
    ctx.st.mm = { ...MM.freshMM(), ...(ctx.st.mm || {}), match: { mode, opponent: int(opponent, 0, P.MAX_RATING, 'rating'), at: ctx.now } };
    ctx.dirty.add('mm');
    return { ok: true };
  },
  // Leaving the ranked match you're in for good (or not reconnecting in time): it counts as a loss, and the cooldown.
  'play.abandon'(ctx, { roundsFor = 0, roundsAgainst = 0 }) {
    if (!ctx.st.mm?.match) fail('Not in a ranked match');
    return abandonMatch(ctx, { roundsFor: int(roundsFor, 0, 60, 'rounds'), roundsAgainst: int(roundsAgainst, 0, 60, 'rounds') });
  },
  // A finished competitive or wingman match against the bots moves that mode's rank (CS:GO's skill groups, one for all
  // maps; online too: it's only the rank). opponent: the other team's average rating (else the old difficulty's).
  'play.rank'(ctx, { result, roundsFor = 0, roundsAgainst = 0, difficulty = 'normal', opponent = null, mode = 'competitive' }) {
    if (!['win', 'loss', 'tie'].includes(result)) fail('Invalid result');
    if (!Object.hasOwn(R.BOT_MMR, difficulty)) fail('Invalid difficulty');
    const key = RANK_KEY[mode];
    if (!key) fail('Invalid mode');
    const r = R.rateMatch(ctx.st[key], { result, roundsFor: int(roundsFor, 0, 60, 'rounds'), roundsAgainst: int(roundsAgainst, 0, 60, 'rounds'), difficulty,
      opponent: opponent == null ? null : int(opponent, 0, 5000, 'rating'), now: ctx.now });
    ctx.st[key] = r.rank;
    ctx.dirty.add(key);
    finishMatch(ctx);
    return { change: r.change, before: r.before, after: r.after, rank: r.rank, delta: r.delta };
  },
  // A finished Premier match against the bots moves your CS Rating (online too: it's only the rating).
  'play.premier'(ctx, { result, roundsFor = 0, roundsAgainst = 0, opponent = P.START_RATING }) {
    if (!['win', 'loss', 'tie'].includes(result)) fail('Invalid result');
    const r = P.ratePremier(ctx.st.premier, { result, roundsFor: int(roundsFor, 0, 60, 'rounds'), roundsAgainst: int(roundsAgainst, 0, 60, 'rounds'), opponent: int(opponent, 0, P.MAX_RATING, 'rating') });
    ctx.st.premier = r.premier;
    ctx.dirty.add('premier');
    finishMatch(ctx);
    return { delta: r.delta, before: r.before, after: r.after, placed: r.placed, premier: r.premier };
  },
  // A kill in Play with a StatTrak™ gun or knife counts on its counter (online too: it changes nothing but the count).
  'play.stattrak'(ctx, { uid, kills = 1 }) {
    const it = findOwned(ctx, String(uid));
    if (!it.stt) fail(`${I.itemName(it)} isn't StatTrak™`);
    it.kills = Math.min(999999, (it.kills || 0) + int(kills, 1, 50, 'kills'));
    touch(ctx, it);
    return { kills: it.kills };
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

  // Charms: one per gun. Attaching takes the charm out of the inventory onto the gun (item.kc); taking it off again uses
  // a Charm Detachment (buy: buy a pack first when you have none) and gives the same charm back. Items are only changed
  // after every check, since a failed action puts back the inventory list but not the items in it.
  'charms.attach'(ctx, { uid, charm }) {
    const gun = findOwned(ctx, String(uid));
    if (!I.canHaveCharm(gun)) fail('Charms only go on guns');
    if (gun.kc) fail(`${I.itemName(gun)} already has a charm. Take it off first.`);
    if (ctx.reserved?.has(gun.uid)) fail(`${I.itemName(gun)} is in a pending trade offer`, 'reserved');
    const [c] = take(ctx, [String(charm)]);
    if (c.t !== 'charm') fail('That isn’t a charm');
    const { uid: _, t, nw, lk, ...kc } = c;
    gun.kc = kc;
    touch(ctx, gun);
    return { item: gun };
  },
  'charms.detach'(ctx, { uid, buy = false }) {
    const gun = findOwned(ctx, String(uid));
    if (!gun.kc) fail(`${I.itemName(gun)} has no charm`);
    if (ctx.reserved?.has(gun.uid)) fail(`${I.itemName(gun)} is in a pending trade offer`, 'reserved');
    let bought = 0;
    if (!(ctx.st.charmDetach > 0)) {
      if (!buy) fail('You have no Charm Detachments left', 'detach');
      spend(ctx, I.DETACH_PACK.price);
      ctx.st.charmDetach = (ctx.st.charmDetach || 0) + I.DETACH_PACK.n;
      bought = I.DETACH_PACK.n;
    }
    ctx.st.charmDetach--;
    ctx.dirty.add('charmDetach');
    const { o: _o, ...kc } = gun.kc; // its place was on this gun
    const charm = { ...kc, uid: newUid(), t: 'charm', nw: true };
    give(ctx, [charm]);
    delete gun.kc;
    touch(ctx, gun);
    return { item: gun, charm, bought, left: ctx.st.charmDetach };
  },
  // Moves a gun's charm: to a point on the gun (o, see items.js charmPlacement), or back to the gun's own spot (no o).
  'charms.place'(ctx, { uid, o = null }) {
    const gun = findOwned(ctx, String(uid));
    if (!gun.kc) fail(`${I.itemName(gun)} has no charm`);
    if (ctx.reserved?.has(gun.uid)) fail(`${I.itemName(gun)} is in a pending trade offer`, 'reserved');
    const place = o == null ? null : I.charmPlacement(o);
    if (o != null && !place) fail('That isn’t a place on the gun');
    const { o: _o, ...kc } = gun.kc;
    gun.kc = place ? { ...kc, o: place } : kc;
    touch(ctx, gun);
    return { item: gun };
  },
  'charms.buyDetach'(ctx) {
    spend(ctx, I.DETACH_PACK.price);
    ctx.st.charmDetach = (ctx.st.charmDetach || 0) + I.DETACH_PACK.n;
    ctx.dirty.add('charmDetach');
    return { left: ctx.st.charmDetach };
  },
  // Seals a sticker in a Sticker Slab, making it a charm (the sticker is used up).
  'charms.slab'(ctx, { uid }) {
    if (!D.slab) fail('Sticker Slabs aren’t available');
    const s = findOwned(ctx, String(uid));
    if (s.t !== 'sticker') fail('Only stickers can be slabbed');
    take(ctx, [s.uid]);
    spend(ctx, D.slab.p);
    const item = I.makeSlabItem(s.id, { r: ctx.rng });
    item.nw = true;
    give(ctx, [item]);
    return { item, price: D.slab.p };
  },

  'tradeup.sign'(ctx, { uids }) {
    if (!Array.isArray(uids)) fail('Invalid contract');
    const items = uids.map((u) => findOwned(ctx, String(u)));
    const charmed = items.find((it) => it.kc);
    if (charmed) fail(`Take the charm off ${I.itemName(charmed)} first`);
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
  // Redeems an offer 1, 5 or 10 times at once (stars × n).
  'armory.redeem'(ctx, { offer, autoSell, n = 1 }) {
    n = int(n, 1, 10, 'amount');
    const o = findLiveOffer(String(offer), ctx.now);
    if (!o) fail('That offer has rotated out of the armory', 'expired');
    if (ctx.st.stars < o.stars * n) fail('Not enough Armory Stars', 'funds');
    ctx.st.stars -= o.stars * n;
    ctx.dirty.add('stars');
    const box = offerBox(o);
    const items = [];
    for (let i = 0; i < n; i++) {
      const item = I.rollFromCase(box, ctx.rng);
      item.src = 'Armory · ' + box.n;
      item.nw = true;
      items.push(item);
    }
    serialize(ctx, items);
    noteDrops(ctx, items);
    const autoSold = autoSellDrops(ctx, items, autoSell);
    give(ctx, items.filter((i) => !i.as));
    stats(ctx).armory += n;
    return { item: items[0], items, offer: o, autoSold };
  },

  // ---- NPC players (offline only, see engine/npcs.js) ----
  // Time passing for the NPCs: offers expire, they buy from the market, message you about your rare items, add you as a
  // friend and chat (each only while the admin panel's rule for it is on, and never a blocked NPC: see npcs.js). Returns
  // the messages they sent { events: [{ npc, text }] }.
  'npc.tick'(ctx) {
    const so = social(ctx), r = ctx.rng, now = ctx.now;
    const dt = clamp(now - (so.at || now), 0, 6 * 3600e3);
    so.at = now;
    N.sweepBlocks(so, now);
    const free = (id) => !N.isBlocked(so, id, now);
    const chat = N.ruleOn(so, 'chat');
    const events = [];
    const said = (id) => { const t = so.threads[id]; if (t?.length) events.push({ npc: id, text: t[t.length - 1].text }); };
    const rolls = (perMin, cap) => { const x = (dt / 60000) * perMin; return Math.min(cap, Math.floor(x) + (r() < x % 1 ? 1 : 0)); };
    for (const o of so.offers) {
      if (o.status !== 'open') continue;
      if (!free(o.npc)) { o.status = 'cancelled'; continue; } // (blocking cancels them; this catches a block from elsewhere)
      const gone = o.want.uids.some((u) => !ctx.st.inv.some((it) => it.uid === u));
      if (gone || now > o.exp) {
        o.status = 'expired';
        if (!gone) { N.post(so, o.npc, 'npc', pick(['nvm, found another one', 'offer\'s off, sorry', 'guess not, np'], r), {}, now); said(o.npc); }
      }
    }
    let bought = 0;
    if (N.ruleOn(so, 'market')) for (let k = rolls(0.4, 4); k > 0; k--) if (N.marketBuy(so, ctx.st, { r, now })) bought++;
    if (bought) ctx.dirty.add('market');
    const open = so.offers.filter((o) => o.status === 'open').length;
    if (N.ruleOn(so, 'trading')) for (let k = Math.min(rolls(0.3, 2), 6 - open); k > 0; k--) { const o = N.makeOffer(so, ctx.st, { r, now }); if (o) said(o.npc); }
    for (const [id, s] of Object.entries(so.npcs)) {
      if (!chat || s.friend !== 3 || !free(id) || r() > Math.min(1, dt / (3 * 60e3))) continue;
      if (r() < s.mood + 0.2) { s.friend = 1; N.post(so, id, 'npc', pick(['thx for the add!', 'hey 👋', 'added, what\'s up'], r), {}, now); said(id); } else s.friend = 0;
    }
    if (chat && rolls(1 / 30, 1)) {
      const people = N.activeCrowd(so.seed).filter((n) => !so.npcs[n.id]?.friend && free(n.id));
      if (people.length) {
        const n = pickWeighted(people.map((p) => [p, so.threads[p.id] ? 4 : 1]), r);
        N.npcState(so, n.id).friend = 2;
        N.post(so, n.id, 'npc', pick(['hey, added you. you trade?', 'yo add me back', 'saw your inventory, nice stuff. added you'], r), { request: true }, now);
        said(n.id);
      }
    }
    if (chat && rolls(1 / 25, 1)) {
      const friends = N.crowd(so.seed).filter((n) => so.npcs[n.id]?.friend === 1 && free(n.id));
      if (friends.length) { const n = pick(friends, r); N.post(so, n.id, 'npc', N.chatLine(n, N.npcState(so, n.id), r), {}, now); said(n.id); }
    }
    for (const s of Object.values(so.npcs)) s.money = round2(s.money + (dt / 3600e3) * [2, 10, 40, 120][s.tier]);
    so.offers = so.offers.filter((o, i) => o.status === 'open' || i >= so.offers.length - 60);
    keepSocial(ctx, so);
    return { events };
  },
  // You've read their messages (and looked them up: their inventory is ready to see).
  'npc.read'(ctx, { npc }) {
    const so = social(ctx);
    if (!N.npcOf(so.seed, String(npc))) fail('Unknown player');
    N.npcState(so, String(npc));
    so.unread[String(npc)] = 0;
    keepSocial(ctx, so);
  },
  // Accepting an NPC's offer: the items and money change hands at once.
  'npc.accept'(ctx, { offer }) {
    const so = social(ctx), o = openOffer(so, offer);
    const n = N.npcOf(so.seed, o.npc);
    notBlocked(ctx, so, n);
    const out = swapWithNpc(ctx, so, n, { mine: o.want.uids, theirs: o.give.uids, myMoney: o.want.money || 0, theirMoney: o.give.money || 0 });
    o.status = 'accepted';
    N.post(so, n.id, 'npc', N.voice(n, 'thanks', ctx.rng), {}, ctx.now);
    keepSocial(ctx, so);
    return out;
  },
  'npc.decline'(ctx, { offer }) {
    const so = social(ctx), o = openOffer(so, offer);
    o.status = 'declined';
    N.post(so, o.npc, 'me', 'No thanks.', {}, ctx.now);
    N.post(so, o.npc, 'npc', N.voice(N.npcOf(so.seed, o.npc), 'declined', ctx.rng), {}, ctx.now);
    so.unread[o.npc] = 0;
    keepSocial(ctx, so);
  },
  // Haggling: the net cash you want from their offer (negative: what you'd pay them), with an argument for it.
  'npc.counter'(ctx, { offer, price, arg = null }) {
    const so = social(ctx), o = openOffer(so, offer);
    notBlocked(ctx, so, N.npcOf(so.seed, o.npc));
    for (const u of o.want.uids) findOwned(ctx, u); // (not over what's gone into a Storage Unit since)
    price = Number(price);
    if (!Number.isFinite(price) || Math.abs(price) > 1e9) fail('Invalid price');
    price = round2(price);
    N.post(so, o.npc, 'me', `${arg && N.ARGUMENTS[arg] ? N.ARGUMENTS[arg].n + '. ' : ''}${price >= 0 ? `How about ${N.dollars(price)}?` : `I'd add ${N.dollars(-price)}.`}`, {}, ctx.now);
    const h = N.haggle(so, ctx.st, o, { price, arg }, { r: ctx.rng, now: ctx.now });
    N.post(so, o.npc, 'npc', h.text, h.outcome === 'walk' ? {} : { offer: o.id }, ctx.now);
    so.unread[o.npc] = 0;
    keepSocial(ctx, so);
    return { ...h, offer: o };
  },
  // A message you type: read for a haggle when there's an offer open between you (a price, yes or no, an argument),
  // else small talk.
  'npc.say'(ctx, { npc, text }) {
    const so = social(ctx), n = N.npcOf(so.seed, String(npc));
    if (!n) fail('Unknown player');
    notBlocked(ctx, so, n);
    text = String(text || '').replace(/[<>]/g, '').trim().slice(0, 300);
    if (!text) fail('Type a message first');
    N.post(so, n.id, 'me', text, {}, ctx.now);
    const o = [...so.offers].reverse().find((x) => x.npc === n.id && x.status === 'open' && !x.want.uids.some((u) => SU.storedItem(ctx.st, u)));
    const m = N.readMessage(text);
    let reply, outcome = null;
    if (o && m.no) {
      o.status = 'declined';
      reply = N.voice(n, 'declined', ctx.rng);
    } else if (o && m.yes && m.price == null) {
      reply = o.agreed ? pick(['great, accept it then 👍', 'send it 🤝'], ctx.rng) : pick([`so ${N.dollars(Math.max(0, o.give.money - o.want.money))}? accept the offer then`, 'accept it then 😄'], ctx.rng);
    } else if (o && (m.price != null || m.arg)) {
      const cur = (o.give.money || 0) - (o.want.money || 0);
      const h = N.haggle(so, ctx.st, o, { price: m.price ?? round2(Math.max(cur * 1.15, cur + 1)), arg: m.arg }, { r: ctx.rng, now: ctx.now });
      reply = h.text;
      outcome = h.outcome;
    } else reply = N.smallTalk(n, text, ctx.rng);
    N.post(so, n.id, 'npc', reply, o && o.status === 'open' && outcome ? { offer: o.id } : {}, ctx.now);
    so.unread[n.id] = 0;
    keepSocial(ctx, so);
    return { reply, outcome };
  },
  // An offer you make to an NPC: they take it, ask for a bit more (a counter offer you can accept or haggle over), or
  // say no.
  'npc.offer'(ctx, { npc, give: g = {}, get = {}, msg = '' }) {
    const so = social(ctx), n = N.npcOf(so.seed, String(npc));
    if (!n) fail('Unknown player');
    notBlocked(ctx, so, n);
    const s = N.npcState(so, n.id);
    const mine = [...new Set((g.uids || []).map(String))], theirs = [...new Set((get.uids || []).map(String))];
    const myMoney = money(g.money), theirMoney = money(get.money);
    if (!mine.length && !theirs.length && !myMoney && !theirMoney) fail('Add something to the offer');
    const yours = mine.map((u) => findOwned(ctx, u));
    for (const it of yours) {
      if (it.lk) fail(`${I.itemName(it)} is locked. Unlock it first.`, 'locked');
      if (I.isUnit(it)) fail("Storage Units can't be traded or sold", 'unit');
    }
    const their = theirs.map((u) => s.inv.find((x) => x.uid === u) || fail('They no longer have that item', 'missing'));
    if (myMoney > ctx.st.money + 1e-9) fail('Not enough money', 'funds');
    if (theirMoney > s.money + 1e-9) fail(`${n.name} doesn't have that much money`, 'funds');
    msg = String(msg || '').replace(/[<>]/g, '').trim().slice(0, 200);
    N.post(so, n.id, 'me', `${msg ? msg + ' · ' : ''}Sent a trade offer: ${tradeText(yours, myMoney)} for ${tradeText(their, theirMoney)}`, {}, ctx.now);
    const j = N.judge(so, n, s, { yours, theirs: their, myMoney, theirMoney });
    let result;
    if (j.ok) {
      const out = swapWithNpc(ctx, so, n, { mine, theirs, myMoney, theirMoney });
      N.post(so, n.id, 'npc', N.voice(n, 'accepted', ctx.rng), {}, ctx.now);
      result = { result: 'accepted', ...out };
    } else if (j.more && j.more <= Math.max(5, (theirMoney + their.reduce((t, x) => t + I.itemValue(x), 0)) * 0.25)) {
      const o = { id: newUid(), npc: n.id, kind: 'trade', at: ctx.now, exp: ctx.now + N.OFFER_LIFE, status: 'open', want: { uids: mine, money: myMoney }, give: { uids: theirs, money: theirMoney },
        max: 0, patience: n.patience, annoy: 0, args: [], agreed: true };
      const netNow = round2(theirMoney - myMoney - j.more);
      o.give.money = Math.max(0, netNow); o.want.money = Math.max(0, -netNow);
      o.max = round2(netNow + j.more * 0.4);
      so.offers.push(o);
      N.post(so, n.id, 'npc', N.voice(n, 'more', ctx.rng, N.dollars(j.more)), { offer: o.id }, ctx.now);
      result = { result: 'countered', offer: o, more: j.more };
    } else {
      N.post(so, n.id, 'npc', N.voice(n, 'refused', ctx.rng), {}, ctx.now);
      result = { result: 'declined' };
    }
    so.unread[n.id] = 0;
    keepSocial(ctx, so);
    return result;
  },
  // Friends: add (or accept their request), or remove.
  'npc.friend'(ctx, { npc, on = true }) {
    const so = social(ctx), n = N.npcOf(so.seed, String(npc));
    if (!n) fail('Unknown player');
    if (on) notBlocked(ctx, so, n); // (unfriending them is fine)
    const s = N.npcState(so, n.id);
    if (!on) s.friend = 0;
    else if (s.friend === 2) { s.friend = 1; N.post(so, n.id, 'npc', pick(['👋', 'ty for accepting!', 'hey!'], ctx.rng), {}, ctx.now); }
    else if (s.friend !== 1) s.friend = 3;
    keepSocial(ctx, so);
    return { friend: s.friend };
  },
  // Your profile: name, avatar (an agent), country, bio, a map behind it, and up to 6 items to show off.
  'persona.set'(ctx, { name, bio, avatar, country, showcase, bg }) {
    const so = social(ctx);
    const me = { ...N.freshPersona(), ...so.me };
    const clean = (x, max) => String(x ?? '').replace(/[<>]/g, '').trim().slice(0, max);
    if (name !== undefined) me.name = clean(name, 32);
    if (bio !== undefined) me.bio = clean(bio, 300);
    if (country !== undefined) me.country = /^[A-Z]{2}$/.test(country) ? country : '';
    if (avatar !== undefined) me.avatar = avatar && D.agents[avatar] ? avatar : null;
    if (bg !== undefined) me.bg = bg ? clean(bg, 40) : null;
    if (showcase !== undefined) {
      if (!Array.isArray(showcase) || showcase.length > 6) fail('Pick up to 6 items');
      me.showcase = [...new Set(showcase.map(String))].filter((u) => ctx.st.inv.some((it) => it.uid === u && !I.isUnit(it)));
    }
    so.me = me;
    keepSocial(ctx, so);
    return { me };
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
    serialize(ctx, prize); // the drops you take home (the bots' leave with them)
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
    ctx.add.length = 0; ctx.del.length = 0; ctx.upd.clear(); ctx.dirty.clear(); ctx.sto.add.length = 0; ctx.sto.del.length = 0;
    throw e;
  }
}

// Runs an action by name. Throws GameError on invalid requests (and then nothing has changed).
export function runAction(ctx, name, args = {}) {
  const fn = ACTIONS[name];
  if (!fn) fail('Unknown action');
  return atomically(ctx, () => fn(ctx, args || {}) ?? {});
}
