// The Market's engine (src/js/engine/p2p.js): the catalog of every item in the game, the searches and rules the server and the
// game share, and the offline side: the NPC traders' listings, buying from them, listing your own, and the traders buying
// what you list over time (p2p.tick), each refused online.
//   node scripts/test-market-engine.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = (m) => import(new URL(`../src/js/engine/${m}.js`, import.meta.url));
const { D, initData, WEAR_BY_KEY, wearOf } = await E('data');
initData(JSON.parse(fs.readFileSync(path.join(ROOT, 'src/data/game-data.json'), 'utf8')), { keys: JSON.parse(fs.readFileSync(path.join(ROOT, 'src/data/keys.json'), 'utf8')) });
const I = await E('items');
const P = await E('p2p');
const N = await E('npcs');
const SU = await E('storage');
const { makeCtx, runAction, ACTIONS } = await E('actions');
const { freshState } = await E('economy');
const { mulberry32, round2 } = await E('util');

let failed = 0, passed = 0;
const check = (name, ok, info = '') => { ok ? passed++ : failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const refused = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const T0 = Date.UTC(2026, 10, 11, 9, 30);

// ---- the catalog: every item in the game ------------------------------------------------------------------------------------
const cat = P.catalog();
const kinds = {};
for (const e of cat) kinds[e.t] = (kinds[e.t] || 0) + 1;
check('catalog: every skin in each wear, StatTrak™ and Souvenir, every sticker, agent, charm, case, key and tool',
  kinds.skin > 15000 && kinds.sticker === Object.keys(D.stickers).length && kinds.agent === Object.keys(D.agents).length && kinds.charm === Object.keys(D.charms).length
  && kinds.crate === D.cases.length && kinds.key === Object.keys(D.keys).length && kinds.tool === Object.keys(I.TOOLS).length, JSON.stringify(kinds));
check('catalog: one entry per key', new Set(cat.map((e) => e.key)).size === cat.length);
const rifle = Object.values(D.skins).find((s) => s.cat === 'rifle' && s.stt && s.svp && !s.v && s.p.FT && s.mn <= 0.16 && s.mx >= 0.7);
check('catalog: a skin with every version has normal, StatTrak™ and Souvenir entries per wear', ['n', 'st', 'sv'].every((v) => P.catalogEntry(`skin:${rifle.id}:FT:${v}`)), rifle?.n);
const glove = Object.values(D.skins).find((s) => s.cat === 'gloves');
check('catalog: no StatTrak™ gloves (CS2 has none)', !cat.some((e) => e.id === glove.id && e.v === 'st'));
const r = mulberry32(7);
let mism = 0;
for (let k = 0; k < 400; k++) {
  const c = D.cases[Math.floor(r() * D.cases.length)];
  if (!c.pools) continue;
  const it = I.rollFromCase(c, r);
  if (!P.catalogEntry(P.catalogKey(it))) mism++;
}
check('catalog: whatever a case drops has its entry (catalogKey)', mism === 0, `${mism} missing`);
const e0 = P.catalogEntry(`skin:${rifle.id}:FT:st`), rep = P.entryItem(e0);
check('catalog: an entry\'s reference price is its item\'s market price', Math.abs(P.entryRef(e0) - I.basePrice(rep)) < 0.001 && wearOf(rep.fl) === 'FT');
check('catalog: a Sticker Slab\'s entry is made when asked', !!P.catalogEntry(`charm:slab:${Object.keys(D.stickers)[3]}`) && !P.catalogEntry('charm:slab:nope'));

// ---- the rules -----------------------------------------------------------------------------------------------------------------
check('fee: none, as one constant (MARKET_FEE); the seller gets the whole price', P.MARKET_FEE === 0 && P.sellerGets(123.45) === 123.45 && P.feeOf(10) === 0);
check('prices: cents, from $0.03 to $1,000,000, at most 20x the reference', P.cleanPrice('$1,234.567') === 1234.57 && !P.priceProblem(0.03, 0.01) && !!P.priceProblem(0.02, 1)
  && !!P.priceProblem(1000001, 1e6) && !!P.priceProblem(201, 10) && !P.priceProblem(200, 10) && !!P.priceProblem('abc') && !P.priceProblem(5, 0));
check('suggested price: never under the reference (the Store pays that at once); just under a cheaper-than-that listing', P.suggestedPrice(10) === 10.5 && P.suggestedPrice(10, 12) === 11.99 && P.suggestedPrice(10, 8) === 10);
const skin = (fl, extra = {}) => ({ ...I.makeSkinItem(rifle, { fl, sd: 3, stt: false }), ...extra }); // (never a StatTrak™ by chance)
check('list refusals: locked, a Storage Unit, a trade offer\'s, a gone item', !!P.listRefusal(skin(0.2, { lk: true })) && !!P.listRefusal(I.makeUnitItem())
  && !!P.listRefusal(skin(0.2, { uid: 'x' }), { reserved: new Set(['x']) }) && !!P.listRefusal({ t: 'skin', id: 'gone', uid: 'y' }) && !P.listRefusal(skin(0.2)));

// ---- searching ------------------------------------------------------------------------------------------------------------------
const L = (item, price, at, seller = { id: 1, name: 'a' }) => ({ lid: 'l' + at, item, price, at, seller });
const knife = Object.values(D.skins).find((s) => s.cat === 'knife' && !s.v && s.p.FN);
const list = [L(skin(0.16), 5, 1), L(skin(0.3, { stt: true }), 50, 2), L(skin(0.6), 1, 3), L({ ...I.makeSkinItem(knife, { fl: 0.01, sd: 1, stt: false }) }, 900, 4), L(I.makeStickerItem(Object.values(D.stickers)[9]), 2, 5)];
const q = (o, sorts) => P.cleanQuery(o, sorts);
check('search: newest first by default', P.findListings(list, q({})).map((l) => l.at).join() === '5,4,3,2,1');
check('search: price both ways, floats both ways (no float last)', P.findListings(list, q({ sort: 'plow' })).map((l) => l.price).join() === '1,2,5,50,900'
  && P.findListings(list, q({ sort: 'flow' })).map((l) => l.at).join() === '4,1,2,3,5' && P.findListings(list, q({ sort: 'fhigh' })).at(-1).at === 5);
check('search: by category, exterior (only what has one of those: no sticker), StatTrak™, rarity, price range',
  P.findListings(list, q({ cat: 'knife' })).length === 1 && P.findListings(list, q({ wears: ['FT'] })).map((l) => l.at).sort().join() === '1,2'
  && P.findListings(list, q({ wears: [...P.WEAR_KEYS] })).length === list.length
  && P.findListings(list, q({ stt: true })).length === 1 && P.findListings(list, q({ ranks: [6] })).length === 1 && P.findListings(list, q({ pmin: 2, pmax: 50 })).length === 3);
check('search: by name (every word)', P.findListings(list, q({ text: rifle.n.split(' | ')[1] })).length === 3 && P.findListings(list, q({ text: 'stattrak ' + rifle.w })).length === 1);
check('search: biggest discount first', P.findListings(list, q({ sort: 'disc' })).every((l, i, a) => !i || P.factsOf(a[i - 1]).disc >= P.factsOf(l).disc));
const pg = P.pageOf(Array.from({ length: 130 }, (_, i) => i), 2);
check('search: pages of 60', pg.rows.length === 10 && pg.pages === 3 && pg.page === 2 && P.pageOf([], 5).page === 0);
const counts = P.listingCounts(list);
const found = P.findCatalog(counts, q({ text: rifle.n }, P.CATALOG_SORTS));
check('catalog search: listed entries first, with count and lowest; unlisted ones too', found[0] && counts.has(found[0].key) && found.some((e) => !counts.has(e.key))
  && P.catalogRow(counts, found[0]).n >= 1);
check('catalog search: "listed only" and the category', P.findCatalog(counts, q({ listed: true }, P.CATALOG_SORTS)).length === counts.size
  && P.findCatalog(counts, q({ cat: 'agent' }, P.CATALOG_SORTS)).every((e) => e.t === 'agent'));
// The catalog search against the plain way of doing it (filter every entry, sort them all), which took a fifth of a second
// or more each time on the server: the same entries in the same order, whatever the search, with listings or not.
{
  const plainT = (s) => String(s || '').toLowerCase().replace(/[™★|()"]/g, ' ').replace(/\s+/g, ' ').trim();
  const plainCatalog = (cnt, qq) => {
    const toks = plainT(qq.text).split(' ').filter(Boolean), price = (e) => cnt.get(e.key)?.min ?? P.entryRef(e);
    const narrowed = qq.wears.length && qq.wears.length < P.WEAR_KEYS.length;
    const rows = P.catalog().filter((e) => {
      const wear = e.w && e.w !== 'V' ? e.w : null, p = price(e);
      return (!qq.key || e.key === qq.key) && (!qq.listed || cnt.has(e.key)) && toks.every((t) => e.s.includes(t)) && (!qq.cat || e.cat === qq.cat)
        && (qq.pmin == null || p >= qq.pmin) && (qq.pmax == null || !(qq.pmax > 0) || p <= qq.pmax) && (!narrowed || (wear && qq.wears.includes(wear)))
        && (!(qq.stt || qq.sv) || (qq.stt && e.v === 'st') || (qq.sv && e.v === 'sv')) && (!qq.ranks.length || qq.ranks.includes(e.rank));
    });
    const n = (e) => cnt.get(e.key)?.n || 0;
    const sorts = {
      listed: (a, b) => n(b) - n(a) || (n(a) ? cnt.get(a.key).min - cnt.get(b.key).min : 0) || P.entryRef(b) - P.entryRef(a) || a.n.localeCompare(b.n),
      plow: (a, b) => price(a) - price(b) || a.n.localeCompare(b.n), phigh: (a, b) => price(b) - price(a) || a.n.localeCompare(b.n), name: (a, b) => a.n.localeCompare(b.n),
    };
    return rows.sort(sorts[qq.sort] || sorts.listed);
  };
  const rr = mulberry32(31), all = P.catalog(), pickOf = (a) => a[Math.floor(rr() * a.length)];
  const someListings = (k) => Array.from({ length: k }, (_, i) => {
    const e = pickOf(all), it = { ...P.entryItem(e), uid: 'c' + i };
    return { lid: 'c' + i, item: it, price: Math.max(0.03, round2(P.entryRef(e) * (0.5 + rr()))), at: i, seller: { id: 2, name: 'b' } };
  });
  const texts = ['', '', 'ak', 'doppler', 'case', 'sticker gold', 'stattrak', 'knife ft', 'zzzz'];
  let bad = 0, tried = 0;
  for (let k = 0; k < 28; k++) {
    const cnt = P.listingCounts(someListings(k % 3 ? 400 : 0));
    const qq = q({
      sort: P.CATALOG_SORTS[k % 4][0], text: pickOf(texts), cat: rr() < 0.3 ? pickOf(P.CATS)[0] : '', pmin: rr() < 0.3 ? round2(rr() * 20) : null, pmax: rr() < 0.3 ? round2(5 + rr() * 500) : null,
      wears: rr() < 0.3 ? P.WEAR_KEYS.filter(() => rr() < 0.5) : [], stt: rr() < 0.2, sv: rr() < 0.1, ranks: rr() < 0.2 ? [Math.floor(rr() * 8)] : [], listed: rr() < 0.15,
    }, P.CATALOG_SORTS);
    for (const c2 of [cnt, P.listingCounts([...cnt.keys()].length ? someListings(50) : [])]) { // (and again: the same search with other listings)
      tried++;
      const a = P.findCatalog(c2, qq).map((e) => e.key).join(), b = plainCatalog(c2, qq).map((e) => e.key).join();
      if (a !== b) { bad++; if (bad < 3) console.log('   differs:', JSON.stringify(qq)); }
    }
  }
  check('catalog search: the same entries in the same order as sorting every entry, for any search', !bad, `${bad} of ${tried} differ`);
  const times = [];
  for (let k = 0; k < 5; k++) { const c2 = P.listingCounts(someListings(500)); const t = performance.now(); P.findCatalog(c2, q({ sort: P.CATALOG_SORTS[k % 3][0], pmin: k / 100 }, P.CATALOG_SORTS)); times.push(performance.now() - t); }
  times.sort((x, y) => x - y);
  check('catalog search: every item in the game, a new search each time, in a few milliseconds (not hundreds)', times[2] < 100, `median ${times[2].toFixed(1)} ms`);
  const fn = all.find((e) => e.t === 'skin' && e.w === 'FN');
  const narrowed = P.findCatalog(new Map(), q({ wears: ['FN'], sort: 'name' }, P.CATALOG_SORTS));
  check('catalog search: one exterior ticked finds only skins in it (no case, sticker or vanilla knife)', narrowed.length && narrowed.every((e) => e.t === 'skin' && e.w === 'FN') && narrowed.includes(fn));
}
check('prices typed with a comma: before the cents a decimal point, between thousands a separator', P.cleanPrice('1,5') === 1.5 && P.cleanPrice('12,50') === 12.5 && P.cleanPrice('1,250') === 1250
  && P.cleanPrice('1.234,56') === 1234.56 && P.cleanPrice('$ 2,99') === 2.99 && Number.isNaN(P.cleanPrice('1,5,0')) && Number.isNaN(P.cleanPrice('')) && P.cleanPrice(7.256) === 7.26);
const dop = Object.values(D.skins).find((s) => s.ph && s.star);
check('the Market names a Doppler with its phase (the window before buying, what happened)', !!dop && P.marketName({ t: 'skin', id: dop.id }).includes(`(${dop.ph})`)
  && P.marketName({ t: 'skin', id: dop.id, name: 'Shiny' }).endsWith('"Shiny"') && !P.marketName({ t: 'skin', id: dop.id, name: 'Shiny' }, { real: true }).includes('Shiny')
  && P.marketName({ t: 'skin', id: rifle.id }) === I.itemName({ t: 'skin', id: rifle.id }), dop && P.marketName({ t: 'skin', id: dop.id }));

// ---- offline: the traders' listings -----------------------------------------------------------------------------------------------
const st0 = freshState(T0);
st0.money = 100000;
st0.social = N.freshSocial(4242, T0);
const so = st0.social;
const npcAll = P.allNpcListings(so, T0);
check('traders\' listings: hundreds, from the save\'s seed and the clock (the same twice)', npcAll.length > 300 && P.allNpcListings(so, T0).length === npcAll.length, String(npcAll.length));
const under = npcAll.filter((l) => l.price < P.referencePrice(l.item) * 0.95);
check('traders\' prices: never under market but by a beginner\'s mistake', under.every((l) => l.seller.type === 'beginner') && npcAll.every((l) => l.price >= P.MIN_PRICE), `${under.length} under`);
check('traders\' listings: each found again by its id', npcAll.slice(0, 50).every((l) => P.npcListingByLid(so, l.lid, T0)?.listing.price === l.price));
const later = P.allNpcListings(so, T0 + 9 * 3600e3), ids = new Set(npcAll.map((l) => l.lid));
check('traders\' listings: come and go over the hours', later.some((l) => !ids.has(l.lid)) && npcAll.some((l) => !later.some((x) => x.lid === l.lid)));
const seller = npcAll[0].seller.npc;
const blocked = structuredClone(so);
N.blockNpc(blocked, seller, {}, T0);
check('a blocked trader lists nothing', !P.allNpcListings(blocked, T0).some((l) => l.seller.npc === seller));

// ---- offline: buying from a trader -------------------------------------------------------------------------------------------------
const run = (st, name, args, opts = {}) => { const ctx = makeCtx(st, { now: T0 + 1000, rng: mulberry32(9), ...opts }); return runAction(ctx, name, args); };
const st = structuredClone(st0);
const pick1 = npcAll.find((l) => l.price < 5000);
const was = st.money;
const badPrice = refused(() => run(st, 'p2p.buy', { lid: pick1.lid, price: pick1.price + 1 }));
check('buy: a price other than the listing\'s is refused, nothing changes', badPrice?.code === 'price' && st.money === was && !st.social.npcs[pick1.seller.npc]?.inv?.length === !st0.social.npcs[pick1.seller.npc]);
const got = run(st, 'p2p.buy', { lid: pick1.lid, price: pick1.price });
const npcNow = st.social.npcs[pick1.seller.npc];
check('buy: the item is yours (New), the money the trader\'s', got.item && st.inv[0].uid === got.item.uid && st.inv[0].nw && Math.abs(st.money - (was - pick1.price)) < 0.005
  && P.catalogKey(got.item) === P.catalogKey(pick1.item) && got.item.fl === pick1.item.fl && !!npcNow);
check('buy: they don\'t have it any more, and the listing is gone', !P.npcListingByLid(st.social, pick1.lid, T0 + 2000) && !P.fids(npcNow.inv).includes(pick1.lid.split(':')[2]));
check('buy: on the record', st.p2p?.log?.[0]?.kind === 'bought' && st.p2p.log[0].who === pick1.seller.name);
const twice = refused(() => run(st, 'p2p.buy', { lid: pick1.lid, price: pick1.price }));
check('buy: a listing can\'t be bought twice', twice?.code === 'gone');
const poor = structuredClone(st0);
poor.money = 0;
const broke = refused(() => run(poor, 'p2p.buy', { lid: pick1.lid, price: pick1.price }));
check('buy: not enough money, nothing changes', broke?.code === 'funds' && poor.inv.length === 0 && JSON.stringify(poor.social) === JSON.stringify(st0.social));

// ---- offline: listing your own -------------------------------------------------------------------------------------------------------
const mine = Array.from({ length: 55 }, (_, k) => ({ ...I.makeSkinItem(rifle, { fl: 0.16 + k / 1000, sd: k, stt: false }), at: T0 }));
st.inv.push(...mine);
st.loadout = { ['w:' + rifle.w]: mine[0].uid };
const l0 = run(st, 'p2p.list', { uid: mine[0].uid, price: 12.5 });
check('list: out of the inventory into st.listed with its price, and unequipped', !st.inv.some((i) => i.uid === mine[0].uid) && st.listed[0].lid === l0.lid && st.listed[0].lp === 12.5 && !st.loadout['w:' + rifle.w]);
check('list: still yours (owned items, worth)', SU.ownedItems(st).some((i) => i.uid === mine[0].uid) && SU.ownedValue(st) >= I.itemValue(mine[0]));
const lk = { ...mine[1], lk: true };
st.inv = st.inv.map((i) => (i.uid === lk.uid ? lk : i));
check('list refused: locked, a bad price, not yours', refused(() => run(st, 'p2p.list', { uid: lk.uid, price: 5 }))?.code === 'item'
  && refused(() => run(st, 'p2p.list', { uid: mine[2].uid, price: 0 }))?.code === 'price' && refused(() => run(st, 'p2p.list', { uid: 'nope', price: 5 }))?.code === 'missing');
for (let k = 2; k < 51; k++) run(st, 'p2p.list', { uid: mine[k].uid, price: round2(I.itemValue(mine[k]) * 1.02) });
const over = refused(() => run(st, 'p2p.list', { uid: mine[51].uid, price: 5 }));
check(`list: at most ${P.MAX_LISTINGS}`, st.listed.length === P.MAX_LISTINGS && over?.code === 'limit' && st.inv.some((i) => i.uid === mine[51].uid));
run(st, 'p2p.reprice', { lid: l0.lid, price: 13 });
check('reprice', st.listed.find((x) => x.lid === l0.lid).lp === 13 && refused(() => run(st, 'p2p.reprice', { lid: l0.lid, price: -1 }))?.code === 'price');
const back = run(st, 'p2p.cancel', { lid: l0.lid });
check('cancel: the item is back, as it was', st.inv[0].uid === mine[0].uid && back.item.uid === mine[0].uid && !('lid' in st.inv[0]) && !st.listed.some((x) => x.lid === l0.lid));
check('cancel: a listing that\'s gone', refused(() => run(st, 'p2p.cancel', { lid: l0.lid }))?.code === 'gone');
const mineAsListings = st.listed.map((x) => ({ lid: x.lid, item: P.fromListed(x), price: x.lp, at: x.lat, seller: { me: true } }));
check('your listings show with the traders\' in a search', P.findListings([...npcAll, ...mineAsListings], q({ text: rifle.n.split(' | ')[1] })).some((l) => l.seller.me));
// A listed item can't be used: it isn't in the inventory.
const used = st.listed[0].uid;
check('a listed item: no selling, trade-up or storing it', refused(() => run(st, 'item.sell', { uids: [used] }))?.code === 'missing'
  && refused(() => run(st, 'loadout.equip', { uid: used }))?.code === 'missing' && refused(() => run(st, 'gamble.coinflip', { side: 'ct', uids: [used], clientSeed: 'x' }))?.code === 'missing');

// ---- offline: the traders buy what you list ------------------------------------------------------------------------------------------
const sellSt = structuredClone(st0);
const plainSkin = Object.values(D.skins).find((s) => s.cat === 'rifle' && !s.v && s.p.FT?.[0] > 2 && s.p.FT[0] < 8 && s.mn <= 0.2 && s.mx >= 0.32);
const cheap = Array.from({ length: 12 }, (_, k) => ({ ...I.makeSkinItem(plainSkin, { fl: 0.2 + k / 100, sd: 100 + k, stt: false }), at: T0 }));
sellSt.inv.push(...cheap);
for (const it of cheap.slice(0, 6)) run(sellSt, 'p2p.list', { uid: it.uid, price: round2(I.itemValue(it) * 0.9) });
for (const it of cheap.slice(6)) run(sellSt, 'p2p.list', { uid: it.uid, price: round2(I.itemValue(it) * 15) });
const cash0 = sellSt.money;
const hour = (h) => makeCtx(sellSt, { now: T0 + h * 3600e3, rng: mulberry32(h) });
const t1 = runAction(hour(3), 'p2p.tick');
check('tick: over hours, the traders buy what\'s priced to sell, not what\'s 15x over', t1.sold.length >= 4 && t1.sold.every((s) => cheap.slice(0, 6).some((i) => I.itemName(i) === s.name)) && sellSt.listed.length === 12 - t1.sold.length, `${t1.sold.length} sold`);
const paid = round2(t1.sold.reduce((s, x) => s + x.got, 0));
check('tick: you\'re paid (no fee), they have the items, it\'s on the record', Math.abs(sellSt.money - cash0 - paid) < 0.005
  && t1.sold.every((s) => sellSt.social.npcs[s.npc]?.inv.some((i) => I.itemName(i) === s.name)) && sellSt.p2p.log.filter((x) => x.kind === 'sold').length === t1.sold.length);
check('tick: no item twice anywhere', (() => { const all = [...sellSt.inv, ...sellSt.listed, ...Object.values(sellSt.social.npcs).flatMap((s) => s.inv)].map((i) => i.uid); return new Set(all).size === all.length; })());
const quiet = runAction(makeCtx(sellSt, { now: T0 + 3 * 3600e3 + 1000, rng: mulberry32(1) }), 'p2p.tick');
check('tick: no time passed, nothing more', quiet.sold.length === 0);
const ruled = structuredClone(st0);
ruled.inv.push(...cheap.map((i) => ({ ...i })));
for (const it of ruled.inv) run(ruled, 'p2p.list', { uid: it.uid, price: round2(I.itemValue(it) * 0.9) });
ruled.social.rules = { market: false };
check('tick: with the admin panel\'s "Market buyers" rule off, nobody buys', runAction(makeCtx(ruled, { now: T0 + 5 * 3600e3, rng: mulberry32(2) }), 'p2p.tick').sold.length === 0);
const allBlocked = structuredClone(ruled);
allBlocked.social.rules = {};
for (const n of N.activeCrowd(allBlocked.social.seed)) N.blockNpc(allBlocked.social, n.id, {}, T0);
check('tick: blocked traders buy nothing', runAction(makeCtx(allBlocked, { now: T0 + 5 * 3600e3, rng: mulberry32(3) }), 'p2p.tick').sold.length === 0);

// ---- online: these are the server's ------------------------------------------------------------------------------------------------
const on = structuredClone(st);
const onl = (name, args) => refused(() => runAction(makeCtx(on, { online: true }), name, args));
check('online: every one of these actions is refused (the server runs the Market)', ['p2p.list', 'p2p.cancel', 'p2p.reprice', 'p2p.buy', 'p2p.tick'].every((a) => onl(a, { uid: on.inv[0].uid, lid: on.listed[0].lid, price: 5 })?.code === 'online')
  && JSON.stringify(on) === JSON.stringify(st));
check('the actions are the game\'s (registered with the engine\'s)', ['p2p.list', 'p2p.cancel', 'p2p.reprice', 'p2p.buy', 'p2p.tick'].every((a) => typeof ACTIONS[a] === 'function'));
// A save's listings put right.
const messy = structuredClone(st);
messy.listed = [...messy.listed, messy.listed[0], { ...messy.inv[0], lid: 'dup', lp: 1, lat: 1 }, { t: 'skin', id: 'gone', uid: 'g', lid: 'g', lp: 1 }, null];
const fixedN = P.repairListed(messy);
check('repairListed: no item twice, none that\'s in the inventory, none the game lost', fixedN === 4 && messy.listed.length === st.listed.length);

// ---- the admin panel's rules and a save file, with listings ----------------------------------------------------------------------
const AD = await E('admin');
// A raw edit from an admin panel from before the Market (1.1.3): its JSON is the state but inv, stored, index and social, so the
// player's listings are in it as it loaded them.
const restOf113 = (s) => { const { inv: _i, stored: _s, index: _x, social: _o, ...rest } = s; return JSON.parse(JSON.stringify(rest)); };
const rawSt = structuredClone(st);
delete rawSt.settings;
const edit113 = restOf113(rawSt);
edit113.money = 4242;
const rawOk = refused(() => AD.rawEdit(rawSt, edit113, AD.revOf(rawSt)));
const rawPlan = rawOk ? null : AD.rawEdit(rawSt, edit113, AD.revOf(rawSt));
check('raw edit from a 1.1.3 admin panel (listings in it as loaded): goes through, the listings kept as they are', !rawOk && rawPlan.next.money === 4242
  && JSON.stringify(rawPlan.next.listed) === JSON.stringify(rawSt.listed) && !rawPlan.changed.includes('listed'), rawOk?.message);
const ended = structuredClone(rawSt);
ended.listed = [];
const endedEdit = restOf113(ended);
check('raw edit from a 1.1.3 panel for a player whose listings all ended (listed: [])', !refused(() => AD.rawEdit(ended, endedEdit, AD.revOf(ended))));
const sneaky = restOf113(rawSt);
sneaky.listed = sneaky.listed.slice(1);
check('raw edit: changing the listings in it is refused (the Market\'s own tools take them down)', /listed can't be edited/.test(refused(() => AD.rawEdit(rawSt, sneaky, AD.revOf(rawSt)))?.message || ''));
// A save file's listed items get the same checks as its inventory's.
const fileSt = structuredClone(st);
delete fileSt.settings;
check('a save file with listings, as the game writes one: taken', !refused(() => AD.saveFile(structuredClone(fileSt))));
const forged = structuredClone(fileSt);
forged.listed.push({ ...I.makeSkinItem(glove, { fl: 0.2, sd: 1 }), stt: true, kills: 999999999, uid: 'forged1', lid: 'lforged', lp: 5, lat: T0 });
const dupe = structuredClone(fileSt);
dupe.listed.push({ ...dupe.inv[0], lid: 'ldupe', lp: 5, lat: T0 });
const badPriceFile = structuredClone(fileSt);
badPriceFile.listed[0].lp = 'free';
check('a save file\'s listed items are checked as its inventory\'s: no StatTrak™ gloves with a billion kills, none also in the inventory, a real price',
  /listed\[/.test(refused(() => AD.saveFile(forged))?.message || '') && /listed\[/.test(refused(() => AD.saveFile(dupe))?.message || '') && /listed\[/.test(refused(() => AD.saveFile(badPriceFile))?.message || ''));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
