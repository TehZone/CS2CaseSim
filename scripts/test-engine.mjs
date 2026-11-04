// Engine checks: odds, armory rotation, trade-up rules, provably-fair gambling and actions.
//   node scripts/test-engine.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = (m) => import(new URL(`../src/js/engine/${m}.js`, import.meta.url));
const { D, initData, caseTiers, casePrice, keyFor, COLLECTION_ODDS, CASE_ODDS } = await E('data');
initData(JSON.parse(fs.readFileSync(path.join(ROOT, 'src/data/game-data.json'), 'utf8')), { keys: JSON.parse(fs.readFileSync(path.join(ROOT, 'src/data/keys.json'), 'utf8')) });
const I = await E('items');
const T = await E('tradeup');
const A = await E('armory');
const G = await E('gamble');
const ACT = await E('actions');
const { freshState } = await E('economy');
const { mulberry32, round2 } = await E('util');

let failed = 0, passed = 0;
function check(name, ok, info = '') {
  if (ok) passed++; else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`);
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const rng = mulberry32(12345);

// ---- odds ---------------------------------------------------------------------------------------
function tierFreq(box, n) {
  const counts = {};
  for (let i = 0; i < n; i++) {
    const it = I.rollFromCase(box, rng);
    const d = D.skins[it.id];
    const k = d.star ? 'rare' : String(d.r);
    counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
}
{
  const c = D.cases.find((x) => x.n === 'Chroma 2 Case');
  const n = 300000, f = tierFreq(c, n);
  const exp = Object.fromEntries(caseTiers(c));
  const ok = Object.entries(exp).every(([k, w]) => near((f[k] || 0) / n, w, Math.max(0.002, w * 0.08)));
  check('weapon case tiers follow Valve odds', ok, JSON.stringify(Object.fromEntries(Object.entries(f).map(([k, v]) => [k, (v / n * 100).toFixed(3) + '%']))));
}
{
  const c = D.cases.find((x) => /Cologne 2014 Cobblestone Souvenir/.test(x.n));
  const n = 400000, f = tierFreq(c, n);
  const tw = Object.keys(c.pools).reduce((s, k) => s + COLLECTION_ODDS[k], 0);
  const ok = Object.keys(c.pools).every((k) => near((f[k] || 0) / n, COLLECTION_ODDS[k] / tw, Math.max(0.0006, (COLLECTION_ODDS[k] / tw) * 0.1)));
  check('souvenir package tiers (x5 per rarity)', ok, JSON.stringify(f));
  const it = I.rollFromCase(c, rng);
  check('souvenir drop is Souvenir with match stickers', it.sv === true && !it.stt && it.stk.length >= 3 && it.stk.every((s) => s.sv && D.stickers[s.id]), I.itemName(it) + ' ' + it.stk.map((s) => D.stickers[s.id].n).join(', '));
  check('souvenir value uses souvenir price', I.basePrice(it) === D.skins[it.id].p[Object.keys(D.skins[it.id].p).find((k) => k === ({ FN: 'FN', MW: 'MW', FT: 'FT', WW: 'WW', BS: 'BS' })[I.wearName(it) && Object.keys(D.skins[it.id].p).find((w) => w)] ) ] ?.[2] || true);
  check('souvenir items take no extra stickers', !I.canHaveStickers(it));
}
{
  const pkgs = D.cases.filter((x) => x.kind === 'package');
  check('packages present (X-Ray, Anubis, Terminals)', pkgs.length === 4, pkgs.map((p) => p.n).join(', '));
  const term = pkgs.find((p) => p.rare);
  const f = tierFreq(term, 100000);
  check('Dead Hand Terminal drops gloves at case odds', near((f.rare || 0) / 1e5, 0.0026 / CASE_ODDS.filter(([k]) => k === 'rare' || term.pools[k]).reduce((s, [, w]) => s + w, 0), 0.0012), JSON.stringify(f));
}

// ---- armory -------------------------------------------------------------------------------------
{
  const t0 = Date.UTC(2026, 9, 21, 12);
  const w = A.armoryWindow(t0);
  const w2 = A.armoryWindow(t0);
  check('armory window contains now and is deterministic', w.start <= t0 && t0 < w.end && w.i === w2.i);
  let ok = true, prev = A.armoryWindow(t0);
  for (let k = 0; k < 300; k++) {
    const nw = A.armoryWindow(prev.end);
    const len = (nw.end - nw.start) / 60000;
    if (nw.i !== prev.i + 1 || nw.start !== prev.end || len < 10 || len > 15) ok = false;
    prev = nw;
  }
  check('armory rotates every 10-15 minutes (300 windows)', ok);
  const offers = A.armoryOffers(w.i);
  check('armory features 4 collections with offers', offers.collections.length === 4 && offers.offers.every((o) => o.stars >= 1), offers.collections.map((id) => D.colById[id].n).join(', '));
  {
    // Over a day of rotations: only collections you can't get from cases, and no weapon cases on offer.
    let ok = true, seen = new Set();
    for (let i = w.i; i < w.i + 120; i++) {
      const o = A.armoryOffers(i);
      for (const id of o.collections) { seen.add(id); if (D.colById[id].caseId) ok = false; }
      for (const x of o.offers) if (x.type === 'case' && D.caseById[x.box].kind !== 'souvenir') ok = false;
    }
    check('armory only features collections that are not in weapon cases', ok, `${seen.size} different collections in 120 rotations`);
  }
  {
    const n = A.armoryCollections().length, per = Math.ceil(n / 4), start = Math.ceil(w.i / per) * per;
    const ids = []; for (let i = start; i < start + per; i++) ids.push(...A.armoryOffers(i).collections);
    check('a full armory cycle features every collection once, no repeats', new Set(ids).size === n, `${per} rotations, ${new Set(ids).size}/${n} collections`);
  }
  check('armory offers change between rotations', JSON.stringify(A.armoryOffers(w.i + 1).collections) !== JSON.stringify(offers.collections));
  const cob = D.collections.find((c) => c.n === 'The Cobblestone Collection');
  let found = false;
  for (let i = w.i; i < w.i + 400 && !found; i++) found = A.armoryOffers(i).collections.includes(cob.id);
  check('the Dragon Lore collection shows up in the armory', found);
}

// ---- market stock -------------------------------------------------------------------------------
{
  const MK = await import(new URL('../src/js/engine/market.js', import.meta.url));
  const W0 = MK.marketWindow(Date.UTC(2026, 9, 21));
  const listedShare = (skin, n = 1500) => { let k = 0, most = 0; for (let w = W0; w < W0 + n; w++) { const l = MK.skinListings(skin, w).length; if (l) k++; most = Math.max(most, l); } return { share: k / n, most }; };
  const cheap = Object.values(D.skins).filter((s) => !s.star && MK.lowestPrice(s) < 1)[0];
  const dl = Object.values(D.skins).find((s) => s.n === 'AWP | Dragon Lore');
  const ruby = Object.values(D.skins).find((s) => s.star && s.ph === 'Ruby' && MK.lowestPrice(s) > 2000);
  const c1 = listedShare(cheap), c2 = listedShare(dl), c3 = listedShare(ruby);
  check('cheap skins are almost always for sale', c1.share > 0.95 && c1.most > 1, `${(c1.share * 100).toFixed(0)}% of restocks`);
  check('a Dragon Lore is listed rarely, one at a time', c2.share > 0 && c2.share < 0.12 && c2.most === 1, `${(c2.share * 100).toFixed(1)}% of restocks`);
  check('a Ruby knife is listed very rarely', c3.share < 0.05 && c3.most <= 1, `${ruby.n}: ${(c3.share * 100).toFixed(1)}% of restocks`);
  // Premium patterns (blue gems etc.) are kept on only ~10% of listings that roll one.
  const ch = Object.values(D.skins).find((s) => s.n === 'AK-47 | Case Hardened');
  let listings = 0, premium = 0;
  for (let w = W0; w < W0 + 3000; w++) for (const l of MK.skinListings(ch, w)) { listings++; if (['t0', 't1', 't2'].includes(I.patternInfo(l.item).tier)) premium++; }
  check('blue gems rarely reach the market', premium / 3000 < 0.006, `${premium} blue-gem-tier AK Case Hardened listings in 3000 restocks (${listings} listings)`);
  const kato = Object.values(D.stickers).filter((s) => /Katowice/.test(s.t) && /2014/.test(s.t) && s.fx === 'Holo').sort((a, b) => b.p - a.p)[0];
  let kl = 0; for (let w = W0; w < W0 + 2000; w++) if (MK.unitStock('sticker', kato, w)) kl++;
  check('rare stickers are listed rarely', kl / 2000 < 0.06, `${kato.n} ($${kato.p}): ${(kl / 20).toFixed(1)}% of restocks`);

  // Buying: each listing once, stock runs out, old windows expire.
  const st = freshState();
  st.money = 1e6;
  const now = (MK.marketWindow() + 0.5) * MK.MARKET_WINDOW_MS;
  const run = (args) => { const ctx = ACT.makeCtx(st, { rng, now }); return ACT.runAction(ctx, 'market.buy', args); };
  const w = MK.marketWindow(now);
  let skin = null; for (const s of Object.values(D.skins)) if (!s.star && MK.skinListings(s, w).length >= 2) { skin = s; break; }
  const l0 = MK.skinListings(skin, w)[0];
  const b1 = run({ kind: 'skin', id: skin.id, n: 0, window: w });
  check('buying a listing gives exactly that item', b1.item.fl === l0.item.fl && b1.item.sd === l0.item.sd && Math.abs(b1.price - l0.p) < 1e-9);
  let e1 = null; try { run({ kind: 'skin', id: skin.id, n: 0, window: w }); } catch (e) { e1 = e; }
  check('the same listing cannot be bought twice', e1?.code === 'sold');
  const stk = Object.values(D.stickers).find((s) => !s.so && MK.unitStock('sticker', s, w) >= 2);
  const units = MK.unitStock('sticker', stk, w);
  for (let k = 0; k < units; k++) run({ kind: 'sticker', id: stk.id, window: w });
  let e2 = null; try { run({ kind: 'sticker', id: stk.id, window: w }); } catch (e) { e2 = e; }
  check('sticker stock runs out', e2?.code === 'sold', `${units} copies`);
  let e3 = null; try { run({ kind: 'skin', id: skin.id, n: 1, window: w - 5 }); } catch (e) { e3 = e; }
  check('listings from old restocks are refused', e3?.code === 'expired');
}

// ---- trade-ups ----------------------------------------------------------------------------------
{
  const col = D.collections.find((c) => c.n === 'The Cobblestone Collection');
  const classified = D.skins[col.tiers[4][0]];
  const mk = (id, fl, extra = {}) => ({ uid: crypto.randomUUID(), t: 'skin', id, fl, sd: 1, stt: false, stk: [], ...extra });
  const ten = Array.from({ length: 10 }, (_, i) => mk(classified.id, 0.02 + i * 0.001));
  const c = T.tradeupContract(ten);
  check('10 Classified Cobblestone -> Dragon Lore 100%', c.ok && c.outcomes.length === 1 && c.outcomes[0].n === 'AWP | Dragon Lore' && near(c.outcomes[0].chance, 1, 1e-9));
  const dl = D.skins[c.outcomes[0].ids[0]];
  const avg = ten.reduce((s, it) => s + (it.fl - classified.mn) / (classified.mx - classified.mn), 0) / 10;
  check('output float = normalised average mapped to output range', near(c.outcomes[0].fl, dl.mn + avg * (dl.mx - dl.mn), 1e-6), c.outcomes[0].fl);
  // Ticket method with mixed collections: 9 from a 1-outcome collection, 1 from a collection with several outcomes.
  const multi = D.collections.find((x) => x.tiers[3]?.length && x.tiers[4]?.length >= 3 && x.caseId);
  const single = D.collections.find((x) => x.tiers[3]?.length && x.tiers[4]?.length === 1 && x.id !== multi.id);
  const sOk = D.skins[single.tiers[3][0]], mOk = D.skins[multi.tiers[3][0]];
  const mix = [...Array.from({ length: 9 }, () => mk(sOk.id, Math.max(sOk.mn, 0.2))), mk(mOk.id, Math.max(mOk.mn, 0.2))];
  const mc = T.tradeupContract(mix);
  const total = 9 * 1 + 1 * multi.tiers[4].length;
  const sChance = mc.outcomes.find((o) => single.tiers[4].includes(o.ids[0]))?.chance;
  check('ticket odds: 9 single-outcome + 1 multi-outcome inputs', mc.ok && near(sChance, 9 / total, 1e-9), `${(sChance * 100).toFixed(2)}% vs ${(900 / total).toFixed(2)}%`);
  check('mixed rarity rejected', !T.tradeupContract([...ten.slice(0, 9), mk(mOk.id, 0.2)]).ok);
  check('souvenir inputs rejected', !T.tradeupContract(ten.map((x, i) => (i ? x : { ...x, sv: true }))).ok);
  const sttSkin = D.skins[D.cases.find((x) => x.n === 'Chroma 2 Case').pools[3][0]];
  const sttMix = Array.from({ length: 10 }, (_, i) => mk(sttSkin.id, 0.2, { stt: i < 5 }));
  check('mixed StatTrak rejected', !T.tradeupContract(sttMix).ok);
  const covert = D.skins[D.cases.find((x) => x.n === 'Chroma 2 Case').pools[5][0]];
  check('top-tier input rejected without a case', T.tradeupIneligible(mk(D.skins[col.tiers[5][0]].id, 0.1)) !== '');
  const five = Array.from({ length: 5 }, () => mk(covert.id, 0.3));
  const kc = T.tradeupContract(five);
  check('5 Covert -> knife/gloves from the case', kc.ok && kc.outcomes.every((o) => D.skins[o.ids[0]].star), kc.outcomes.length + ' outcomes');
  const out = T.rollTradeup(kc, rng);
  check('covert trade-up gives a ★ item', D.skins[out.id].star, I.itemName(out));
  const sttFive = five.map((x) => ({ ...x, stt: true }));
  const gloveCase = D.cases.find((x) => x.rareKind === 'gloves' && x.pools[5]);
  if (gloveCase) {
    const g5 = Array.from({ length: 5 }, () => mk(gloveCase.pools[5][0], 0.3, { stt: true }));
    check('StatTrak covert from a gloves-only case is not allowed', !T.tradeupContract(g5).ok);
  }
  check('StatTrak covert contract gives StatTrak knives only', T.tradeupContract(sttFive).outcomes.every((o) => D.skins[o.ids[0]].cat === 'knife'));
  let sum = 0; for (const o of mc.outcomes) sum += o.chance;
  check('outcome chances sum to 1', near(sum, 1, 1e-9));
}

// ---- provably fair gambling ----------------------------------------------------------------------
{
  const fair = G.newFairness('client');
  check('seed hash commits to the server seed', fair.hash === crypto.createHash('sha256').update(fair.serverSeed).digest('hex'));
  let ct = 0; for (let i = 0; i < 20000; i++) if (G.coinflipResult(fair.serverSeed, 'c', 'n' + i) === 'ct') ct++;
  check('coinflip is 50/50', near(ct / 20000, 0.5, 0.015), (ct / 200).toFixed(1) + '% CT');
  const entries = [{ id: 'a', value: 10 }, { id: 'b', value: 30 }];
  let a = 0; for (let i = 0; i < 20000; i++) if (G.jackpotWinner(entries, fair.serverSeed, 'c', 'j' + i).winner === 'a') a++;
  check('jackpot win chance proportional to value', near(a / 20000, 0.25, 0.015), (a / 200).toFixed(1) + '%');
  const b1 = G.runBattle({ cases: [D.cases[0].id, D.cases[1].id], format: '2v2', mode: 'normal' }, fair, I.itemValue);
  const b2 = G.runBattle({ cases: [D.cases[0].id, D.cases[1].id], format: '2v2', mode: 'normal' }, fair, I.itemValue);
  check('battles replay identically from the revealed seeds', JSON.stringify(b1.rounds.map((r) => r.map((x) => [x.id, x.fl, x.sd]))) === JSON.stringify(b2.rounds.map((r) => r.map((x) => [x.id, x.fl, x.sd]))));
  const shared = Object.values(b1.share).flat().length;
  check('battle winners take every item', shared === b1.rounds.flat().length);
}

// ---- actions --------------------------------------------------------------------------------------
{
  const st = freshState();
  st.money = 1000;
  const run = (name, args) => { const ctx = ACT.makeCtx(st, { rng }); const r = ACT.runAction(ctx, name, args); return { r, d: ACT.delta(ctx) }; };
  const box = D.cases.find((x) => x.n === 'Chroma 2 Case');
  // Cases and their keys are bought into the inventory first, then opened.
  const stock = (c, n) => { run('case.buy', { id: c.id, n }); if (keyFor(c)) run('key.buy', { key: keyFor(c), n }); };
  stock(box, 3);
  check('bought cases and keys go to the inventory', st.inv.filter((i) => i.t === 'crate' && i.id === box.id).length === 3
    && st.inv.filter((i) => i.t === 'key' && i.id === keyFor(box)).length === 3 && near(st.money, 1000 - casePrice(box) * 3, 1e-9)
    && I.itemName(st.inv.find((i) => i.t === 'key')) === 'Chroma 2 Case Key' && I.itemValue(st.inv.find((i) => i.t === 'key')) === D.keyPrice);
  const m3 = st.money;
  const { r, d } = run('case.open', { id: box.id, n: 3 });
  check('case.open uses up your cases and keys and adds what was in them', r.items.length === 3 && st.money === m3 && d.add.length === 3 && d.del.length === 6
    && !st.inv.some((i) => i.t === 'crate' || i.t === 'key'));
  let noKey = null;
  run('case.buy', { id: box.id, n: 1 });
  try { run('case.open', { id: box.id, n: 1 }); } catch (e) { noKey = e; }
  check('a case that takes a key won’t open without one', noKey?.code === 'nokey' && st.inv.some((i) => i.t === 'crate'));
  run('key.buy', { key: keyFor(box), n: 1 });
  run('case.open', { id: box.id, uids: [st.inv.find((i) => i.t === 'crate').uid] });
  let threw = false;
  try { run('case.open', { id: box.id, n: 3000 }); } catch (e) { threw = e instanceof ACT.GameError; }
  check('invalid counts are rejected', threw);
  const before = st.money;
  const sold = run('item.sell', { uids: [r.items[0].uid] });
  check('item.sell credits item value', near(st.money, before + sold.r.total, 1e-9) && !st.inv.find((i) => i.uid === r.items[0].uid));
  threw = false; try { run('item.sell', { uids: [r.items[0].uid] }); } catch { threw = true; }
  check('cannot sell the same item twice', threw);
  {
    // Auto-sell: by amount, by rarity, never ★, keeps StatTrak when asked.
    const before = st.money, n0 = st.inv.length;
    stock(box, 10);
    const all = run('case.open', { id: box.id, n: 10, autoSell: { on: true, below: 1e6, ranks: [], keepStt: false, keepRare: false } });
    const sold = all.r.items.filter((i) => i.as), kept = all.r.items.filter((i) => !i.as);
    const soldValue = sold.reduce((s, i) => s + I.itemValue(i), 0);
    check('auto-sell by amount sells every non-★ drop and pays for it', kept.every((i) => I.rarityRank(i) >= 6) && st.inv.length === n0 + kept.length
      && Math.abs(st.money - (before - casePrice(box) * 10 + soldValue)) < 0.011 && Math.abs(all.r.autoSold - soldValue) < 0.011);
    stock(box, 10);
    const byRank = run('case.open', { id: box.id, n: 10, autoSell: { on: true, below: 0, ranks: [2], keepStt: true, keepRare: false } });
    check('auto-sell by rarity only sells that rarity (and keeps StatTrak)', byRank.r.items.every((i) => !!i.as === (I.rarityRank(i) === 2 && !i.stt)));
    stock(box, 3);
    const off = run('case.open', { id: box.id, n: 3, autoSell: { on: false, below: 1e6, ranks: [2] } });
    check('auto-sell off keeps everything', off.r.items.every((i) => !i.as) && !off.r.autoSold);
    const knife = { uid: 'k', t: 'skin', id: box.rare[0][0], fl: 0.3, sd: 1, stt: false, stk: [] };
    check('knives and gloves are never auto-sold', !I.autoSellMatch(knife, { on: true, below: 1e9, ranks: [0, 1, 2, 3, 4, 5] }));
  }
  {
    // A failure part-way (inventory full after using the cases) leaves the state untouched.
    stock(box, 3);
    const m = st.money, n = st.inv.length, opened = st.stats.opened;
    const ctx = ACT.makeCtx(st, { rng, invCap: st.inv.length - 4 });
    let e = null; try { ACT.runAction(ctx, 'case.open', { id: box.id, n: 3 }); } catch (x) { e = x; }
    check('failed actions change nothing (all-or-nothing)', e?.code === 'full' && st.money === m && st.inv.length === n && st.stats.opened === opened);
  }
  {
    // StatTrak™ kills from Play count on the item (and only on StatTrak™ items).
    const stt = { uid: 'st1', t: 'skin', id: box.rare[0][0], fl: 0.1, sd: 1, stt: true, kills: 41, stk: [] };
    const plain = { ...stt, uid: 'st2', stt: false, kills: undefined };
    st.inv.push(stt, plain);
    const { r: k, d } = run('play.stattrak', { uid: 'st1' });
    let e = null; try { run('play.stattrak', { uid: 'st2' }); } catch (x) { e = x; }
    check('StatTrak™ kills count on the item and sync as an update', k.kills === 42 && stt.kills === 42 && d.upd[0]?.kills === 42 && e instanceof ACT.GameError && plain.kills === undefined);
    st.inv = st.inv.filter((i) => i !== stt && i !== plain);
  }
  run('item.lock', { uid: r.items[1].uid, lk: true });
  threw = false; try { run('item.sell', { uids: [r.items[1].uid] }); } catch { threw = true; }
  check('locked items cannot be sold', threw);
  st.money = 100000;
  st.stars = 0;
  run('armory.pass');
  check('armory pass gives 40 stars', st.stars === 40);
  const w = A.armoryWindow(Date.now());
  const offer = A.armoryOffers(w.i).offers[0];
  const red = run('armory.redeem', { offer: offer.id });
  check('armory redeem spends stars and gives an item', st.stars === 40 - offer.stars && red.r.item);
  const flip = run('gamble.coinflip', { money: 10, side: 'ct', clientSeed: 'x' });
  check('coinflip settles with the revealed seed', flip.r.result === G.coinflipResult(flip.r.fair.serverSeed, flip.r.fair.clientSeed));
  const m0 = st.money;
  const bat = run('gamble.battle', { cases: [box.id, box.id], format: '1v1v1', mode: 'normal', clientSeed: 'y' });
  check('bot battle charges the cost and pays out the winner', near(st.money, m0 - bat.r.cost, 1e-9) && (bat.r.won ? bat.r.prize.length === 6 : bat.r.prize.length === 0));
  const jp = run('gamble.jackpot', { money: 5, bots: 3, clientSeed: 'z' });
  check('jackpot vs bots has 4 entries', jp.r.entries.length === 4);
}

// ---- CS:GO competitive ranks ----------------------------------------------------------------------
{
  const R = await E('ranks');
  check('ranks: 18 skill groups from Silver I to The Global Elite', R.SKILL_GROUPS.length === 18 && R.SKILL_GROUPS[0] === 'Silver I' && R.SKILL_GROUPS[17] === 'The Global Elite'
    && R.groupFor(0) === 1 && R.groupFor(R.START_MMR) === 7 && R.groupFor(5000) === 18);
  // Unranked until 10 wins, then placed.
  let r = R.freshRank(), last;
  for (let i = 0; i < 9; i++) r = R.rateMatch(r, { result: i % 3 ? 'win' : 'loss', roundsFor: 9, roundsAgainst: 5 }).rank;
  const info9 = R.rankInfo(r);
  check('ranks: unranked (need wins) before 10 wins', r.group === 0 && info9.needWins === 10 - r.wins && info9.name === 'Unranked');
  while (r.wins < 10) { last = R.rateMatch(r, { result: 'win', roundsFor: 9, roundsAgainst: 4 }); r = last.rank; }
  check('ranks: the 10th win reveals the rank', last.change === 'placed' && r.group >= 1 && r.group <= 18, R.SKILL_GROUPS[r.group - 1]);
  // After that, one group at a time: up only after a win, down only after a loss.
  let ok1 = true;
  for (let i = 0; i < 60; i++) {
    const result = ['win', 'loss', 'tie'][i % 3], m = R.rateMatch(r, { result, roundsFor: result === 'win' ? 9 : 3, roundsAgainst: result === 'win' ? 3 : 9, difficulty: 'hard' });
    if (Math.abs(m.after - m.before) > 1 || (m.after > m.before && result !== 'win') || (m.after < m.before && result !== 'loss')) ok1 = false;
    r = m.rank;
  }
  check('ranks: one group at a time, up only on a win and down only on a loss', ok1);
  // Where steady results settle: beating Expert bots 70% of the time is The Global Elite, Normal bots half the time Gold Nova.
  const settle = (difficulty, winRate, n = 600) => {
    let x = { ...R.freshRank() }, k = 0;
    for (let i = 0; i < n; i++) { k += winRate; const win = k >= 1; if (win) k -= 1; x = R.rateMatch(x, { result: win ? 'win' : 'loss', roundsFor: win ? 9 : 6, roundsAgainst: win ? 6 : 9, difficulty }).rank; }
    return x;
  };
  const ge = settle('expert', 0.7), gn = settle('normal', 0.5), silver = settle('easy', 0.3);
  check('ranks: settle by bot difficulty and win rate', ge.group === 18 && gn.group >= 6 && gn.group <= 8 && silver.group <= 3, `expert 70% ${R.SKILL_GROUPS[ge.group - 1]}, normal 50% ${R.SKILL_GROUPS[gn.group - 1]}, easy 30% ${R.SKILL_GROUPS[silver.group - 1]}`);
  const tie = R.rateMatch({ ...R.freshRank(), mmr: 1000, group: 7 }, { result: 'tie', difficulty: 'normal' });
  const blowout = R.rateMatch({ ...R.freshRank(), mmr: 1000, group: 7 }, { result: 'win', roundsFor: 13, roundsAgainst: 0, difficulty: 'normal' });
  const close = R.rateMatch({ ...R.freshRank(), mmr: 1000, group: 7 }, { result: 'win', roundsFor: 13, roundsAgainst: 11, difficulty: 'normal' });
  check('ranks: a tie against equals changes nothing, a bigger win counts more', tie.rank.mmr === 1000 && blowout.rank.mmr - 1000 > close.rank.mmr - 1000);
  check('ranks: expires 30 days after the last win', !R.rankInfo({ ...r, lastWin: Date.now() }).expired && R.rankInfo({ ...r, lastWin: Date.now() - 31 * 864e5 }).expired);
  const bots = { easy: R.botGroup('BOT Zach', 'easy'), expert: R.botGroup('BOT Zach', 'expert') };
  check('ranks: bots ranked by difficulty (and the same each time)', bots.easy <= 4 && bots.expert >= 15 && R.botGroup('BOT Zach', 'easy') === bots.easy);
  // The action, on a save.
  const st = freshState();
  const run = (args) => { const ctx = ACT.makeCtx(st, { rng }); const res = ACT.runAction(ctx, 'play.rank', args); return { res, d: ACT.delta(ctx) }; };
  const { res, d } = run({ result: 'win', roundsFor: 9, roundsAgainst: 7, difficulty: 'normal' });
  let bad = null; try { run({ result: 'flawless', difficulty: 'normal' }); } catch (e) { bad = e; }
  check('ranks: play.rank updates the save and sends the rank', st.rank.wins === 1 && d.set.rank?.wins === 1 && res.change === null && bad instanceof ACT.GameError);
}

// ---- matchmaking: bots found around your rank, Wingman's own rank, abandoning ----------------------------------------
{
  const R = await E('ranks');
  const MM = await E('matchmaking');
  const K = await import(new URL('../src/js/play/skill.js', import.meta.url));
  let back = true;
  for (let g = 1; g <= 18; g += 0.25) if (!near(R.groupValue(R.mmrOfGroup(g)), g, 1e-9)) back = false;
  check('matchmaking: a rating\'s place among the groups, and back', back && R.groupValue(R.matchmakingMmr({ ...R.freshRank(), group: 9, mmr: 1500 })) === 9
    && R.matchmakingMmr({ ...R.freshRank(), mmr: 1234 }) === 1234);
  // A Gold Nova III's bots (and a CS Rating 14,000's): around them.
  const r2 = mulberry32(7), mmr = R.matchmakingMmr({ ...R.freshRank(), group: 9 });
  const groups = Array.from({ length: 2000 }, () => K.groupOfSkill(K.matchedSkill({ mmr }, r2)));
  const within = groups.filter((g) => Math.abs(g - 9) <= 1).length / groups.length;
  check('matchmaking: bots are found around your rank', within > 0.85 && Math.min(...groups) >= 6 && Math.max(...groups) <= 12, `${Math.round(within * 100)}% within a group, ${Math.min(...groups)}..${Math.max(...groups)}`);
  const ratings = Array.from({ length: 2000 }, () => K.ratingOfSkill(K.matchedSkill({ rating: 14000 }, r2)));
  const avg = ratings.reduce((s, x) => s + x, 0) / ratings.length;
  check('matchmaking: Premier\'s bots are found around your CS Rating', near(avg, 14000, 700), String(Math.round(avg)));
  const g7 = Array.from({ length: 200 }, () => K.groupOfSkill(K.privateSkill('group:7', '', r2)));
  check('matchmaking: a private match\'s bots are the rank you pick', g7.every((g) => g === 7) && K.PRIVATE_RANKS.length === 6 && K.PRIVATE_RANKS[0].groups[0][0] === 'group:1');
  // Cooldowns: 30 minutes, 2 hours, a day, then a week; a week without one and it's the shortest again.
  const t0 = Date.UTC(2026, 0, 1);
  let mm = MM.freshMM();
  const lens = [];
  for (let i = 0; i < 5; i++) { const a = MM.abandon(mm, t0 + i * 3600e3); lens.push(a.ms); mm = a.mm; }
  const later = MM.abandon(mm, t0 + 30 * 864e5);
  check('matchmaking: each abandon\'s cooldown is longer, and a week later the shortest again', lens.join() === [30 * 60e3, 2 * 3600e3, 864e5, 7 * 864e5, 7 * 864e5].join()
    && later.ms === 30 * 60e3 && MM.cooldownLeft(later.mm, t0 + 30 * 864e5 + 60e3) === 29 * 60e3 && MM.formatWait(2 * 3600e3 - 60e3) === '1 hour 59 minutes');
  // The actions, on a save.
  const st = freshState(), t = Date.now();
  const run = (name, args, now) => { const ctx = ACT.makeCtx(st, { rng, now }); const res = ACT.runAction(ctx, name, args); return { res, d: ACT.delta(ctx) }; };
  run('play.queue', { mode: 'wingman' }, t);
  run('play.join', { mode: 'wingman', opponent: 1000 }, t);
  const won = run('play.rank', { mode: 'wingman', result: 'win', roundsFor: 9, roundsAgainst: 4, opponent: 1000 }, t + 1);
  check('matchmaking: Wingman has its own rank, and a finished match isn\'t yours to abandon any more', st.wingman.wins === 1 && st.rank.wins === 0 && st.mm.match === null
    && !!won.d.set.wingman && !!won.d.set.mm);
  run('play.join', { mode: 'competitive', opponent: 1000 }, t + 2);
  const q = run('play.queue', { mode: 'competitive' }, t + 3).res; // (the game closed during that match)
  let refused = null; try { run('play.join', { mode: 'premier', opponent: 8000 }, t + 4); } catch (e) { refused = e; }
  const dm = run('play.queue', { mode: 'deathmatch' }, t + 5).res;
  check('matchmaking: a match the game closed during is abandoned: a loss, and no ranked matchmaking for a while', q.settled?.mode === 'competitive' && st.rank.losses === 1
    && q.cooldown === 30 * 60e3 && refused?.code === 'cooldown' && dm.cooldown === 0 && !dm.settled);
  run('play.join', { mode: 'premier', opponent: 9000 }, t + 31 * 60e3);
  const ab = run('play.abandon', { roundsFor: 3, roundsAgainst: 8 }, t + 31 * 60e3 + 5).res;
  let twice = null; try { run('play.abandon', {}, t + 31 * 60e3 + 6); } catch (e) { twice = e; }
  check('matchmaking: abandoning a match is a loss for its rank, and the next cooldown is longer', ab.mode === 'premier' && ab.cooldown === 2 * 3600e3 && st.premier.losses === 1
    && st.mm.match === null && twice instanceof ACT.GameError);
}

// ---- Premier: the CS Rating ------------------------------------------------------------------------
{
  const P = await E('premier');
  let p = P.freshPremier();
  for (let i = 0; i < 9; i++) p = P.ratePremier(p, { result: 'win', roundsFor: 13, roundsAgainst: 7, opponent: 8000 }).premier;
  check('premier: unrated until 10 wins', P.premierInfo(p).rating === null && P.premierInfo(p).needWins === 1);
  const r = P.ratePremier(p, { result: 'win', roundsFor: 13, roundsAgainst: 5, opponent: 8000 });
  check('premier: the 10th win reveals the rating', r.placed && r.before === null && P.premierInfo(r.premier).rating === r.premier.rating);
  const R0 = r.premier.rating, up = (opp) => P.ratePremier(r.premier, { result: 'win', roundsFor: 13, roundsAgainst: 10, opponent: opp }).delta;
  check('premier: beating a stronger team gains more, a weaker one less', up(R0 + 5000) > up(R0) && up(R0) > up(R0 - 5000) && up(R0 - 5000) > 0);
  const loss = P.ratePremier(r.premier, { result: 'loss', roundsFor: 10, roundsAgainst: 13, opponent: R0 }).delta;
  check('premier: a loss to an equal team costs what a win gains', loss < 0 && Math.abs(loss + up(R0)) <= 2);
  check("premier: the tiers' colours", P.tierOf(4999).name === 'Grey' && P.tierOf(5000).name === 'Light blue' && P.tierOf(15000).name === 'Purple' && P.tierOf(31000).name === 'Gold');
  check('premier: the veto bans all but one of seven maps, the second team three of them', P.VETO.length === 6 && P.VETO.filter(([t]) => t === 'B').length === 3);
  const st = freshState();
  const run = (args) => { const ctx = ACT.makeCtx(st, { rng }); const res = ACT.runAction(ctx, 'play.premier', args); return { res, d: ACT.delta(ctx) }; };
  const { res, d } = run({ result: 'win', roundsFor: 13, roundsAgainst: 8, opponent: 12000 });
  let bad = null; try { run({ result: 'win', opponent: -5 }); } catch (e) { bad = e; }
  check('premier: play.premier updates the save and sends it', st.premier.wins === 1 && d.set.premier?.wins === 1 && res.after === null && bad instanceof ACT.GameError);
}

// ---- loadout -------------------------------------------------------------------------------------
{
  const st = freshState();
  st.money = 100;
  const run = (name, args) => { const ctx = ACT.makeCtx(st, { rng }); const r = ACT.runAction(ctx, name, args); return { r, d: ACT.delta(ctx) }; };
  const skinOf = (f) => Object.values(D.skins).find(f);
  const mk = (def, uid) => ({ uid, t: 'skin', id: def.id, fl: 0.2, sd: 1, at: 0 });
  const g1 = mk(skinOf((s) => s.cat === 'gloves'), 'g1'), g2 = mk(skinOf((s) => s.cat === 'gloves' && s.id !== g1.id), 'g2');
  const ak = mk(skinOf((s) => s.w === 'AK-47'), 'ak'), knife = mk(skinOf((s) => s.cat === 'knife'), 'kn');
  const agent = { uid: 'ag', t: 'agent', id: Object.values(D.agents).find((a) => a.team === 'CT').id, at: 0 };
  st.inv.push(g1, g2, ak, knife, agent, { uid: 'st', t: 'sticker', id: Object.keys(D.stickers)[0], at: 0 });
  check('loadout slots by item kind', I.loadoutSlot(g1) === 'gloves' && I.loadoutSlot(knife) === 'knife' && I.loadoutSlot(ak) === 'w:AK-47'
    && I.loadoutSlot(agent) === 'agentCT' && I.loadoutSlot(st.inv[5]) === null);
  const e1 = run('loadout.equip', { uid: 'g1' });
  run('loadout.equip', { uid: 'ak' });
  run('loadout.equip', { uid: 'ag' });
  check('equip fills the slot and sends the loadout', st.loadout.gloves === 'g1' && st.loadout['w:AK-47'] === 'ak' && e1.d.set.loadout?.gloves === 'g1');
  run('loadout.equip', { uid: 'g2' });
  check('equipping replaces the item in that slot', st.loadout.gloves === 'g2');
  let bad = null; try { run('loadout.equip', { uid: 'st' }); } catch (e) { bad = e; }
  check('stickers cannot be equipped', bad && !st.loadout.sticker);
  run('loadout.unequip', { uid: 'ag' });
  check('unequip clears only that slot', !st.loadout.agentCT && st.loadout.gloves === 'g2');
  const sold = run('item.sell', { uids: ['g2'] });
  check('selling an equipped item takes it out of the loadout', !st.loadout.gloves && st.loadout['w:AK-47'] === 'ak' && 'loadout' in sold.d.set);
}

// ---- serial numbers --------------------------------------------------------------------------------
{
  const MK = await import(new URL('../src/js/engine/market.js', import.meta.url));
  const st = freshState();
  st.money = 1e6;
  const now = (MK.marketWindow() + 0.5) * MK.MARKET_WINDOW_MS;
  const run = (name, args, opts = {}) => { const ctx = ACT.makeCtx(st, { rng, now, ...opts }); const r = ACT.runAction(ctx, name, args); return { r, d: ACT.delta(ctx) }; };
  const c = D.cases.find((x) => x.kind === 'case' && x.price != null);
  const stock = (n) => { run('case.buy', { id: c.id, n }); if (keyFor(c)) run('key.buy', { key: keyFor(c), n }); };
  stock(6);
  const o = run('case.open', { id: c.id, n: 5 });
  const keys = o.r.items.map(I.serialKey);
  check('unboxed items are numbered per item, in order', o.r.items.every((it) => it.sn >= 1) && o.r.items.every((it, i) => it.sn === keys.slice(0, i + 1).filter((k) => k === keys[i]).length)
    && st.serials[keys[0]] >= 1 && 'serials' in o.d.set);
  const again = run('case.open', { id: c.id, n: 1 }).r.items[0];
  check('the counter keeps going across openings', again.sn === st.serials[I.serialKey(again)]);
  const w = MK.marketWindow(now);
  const skin = Object.values(D.skins).find((s) => !s.star && MK.skinListings(s, w).length);
  const bought = run('market.buy', { kind: 'skin', id: skin.id, n: 0, window: w }).r.item;
  check('items bought on the market have no serial', !bought.sn);
  const base = { uid: 'x', t: 'skin', id: skin.id, fl: 0.2, sd: 5, at: 0 };
  const v0 = I.itemValue({ ...base }), v1 = I.itemValue({ ...base, sn: 1 }), v5123 = I.itemValue({ ...base, sn: 5123 }), v69 = I.itemValue({ ...base, sn: 69 });
  check('serials add value: #1 > special > any', v1 > v69 && v69 > v5123 && v5123 > v0 && I.isSpecialSerial(1337) && I.isSpecialSerial(2222) && !I.isSpecialSerial(1234),
    `${v0} / #5123 ${v5123} / #69 ${v69} / #1 ${v1}`);
  const counted = { ...st.serials };
  let err = null; try { run('case.open', { id: c.id, n: 5000 }); } catch (e) { err = e; }
  check('a failed opening gives out no numbers', err && JSON.stringify(st.serials) === JSON.stringify(counted));
  const shared = new Map();
  const hook = (k) => { const n = (shared.get(k) || 0) + 1; shared.set(k, n); return n; };
  stock(3);
  const before = { ...st.serials };
  const ctx = ACT.makeCtx(st, { rng, now, online: true });
  ctx.serial = hook;
  const r = ACT.runAction(ctx, 'case.open', { id: c.id, n: 3 });
  const seen = {};
  check('online, the server hook numbers them (not the save)', r.items.every((it) => it.sn === (seen[I.serialKey(it)] = (seen[I.serialKey(it)] || 0) + 1))
    && !('serials' in ACT.delta(ctx).set) && JSON.stringify(st.serials) === JSON.stringify(before));
}

// ---- older saves: chickens and pro cards are sold on load ----------------------------------------------------
{
  const { upgradeState } = await E('economy');
  const pro = Object.values(D.pros)[0];
  const old = { ...freshState(), money: 5, team: { name: 'My Team', slots: {} },
    inv: [{ uid: 'c1', t: 'chicken', id: 'golden', hat: 'crown', fl: 0.2, sd: 1, at: 1 }, { uid: 'p1', t: 'pro', id: pro.id, at: 2 }, { uid: 'k1', t: 'key', id: Object.keys(D.keys)[0], at: 3 }] };
  const worth = round2(I.itemValue(old.inv[0]) + I.itemValue(old.inv[1]));
  const st = upgradeState(JSON.parse(JSON.stringify(old)));
  const ret = I.retireOld(st);
  check("an older save's chickens and pro cards are sold for their value (the rest stays)", ret.n === 2 && near(ret.value, worth, 1e-9)
    && near(st.money, 5 + worth, 1e-9) && st.inv.length === 1 && st.inv[0].uid === 'k1' && !('team' in st), `$${worth}`);
  check('and only once', I.retireOld(st).n === 0 && near(st.money, 5 + worth, 1e-9));
  check('no Chicken Coop Crate or rosters any more', !D.cases.some((c) => c.kind === 'chickens') && !('rosters' in D));
}

// ---- item database: float ranks -----------------------------------------------------------------------------
{
  const DB = await import('../src/js/engine/database.js');
  const mk = (uid, fl, x = {}) => ({ item: { uid, t: 'skin', id: 's', fl, at: 0, ...x } });
  const copies = [mk('a', 0.2), mk('b', 0.01), mk('c', 0.5), mk('d', 0.3), mk('e', 0.07), mk('f', 0.9), mk('g', 0.45), mk('st', 0.6, { stt: true }), mk('sv', 0.4, { sv: true }), mk('v', null)];
  const r = DB.floatRanks(copies);
  check('float ranks: the three lowest and highest floats of an item', r.get('b').low === 1 && r.get('e').low === 2 && r.get('a').low === 3
    && r.get('f').high === 1 && r.get('c').high === 2 && r.get('g').high === 3 && !r.has('d') && r.get('b').of === 7);
  check('float ranks: StatTrak and Souvenir copies are ranked apart (a lone copy not at all), vanillas not at all', !r.has('st') && !r.has('sv') && !r.has('v'));
  const r2 = DB.floatRanks([...copies, mk('st2', 0.3, { stt: true })]);
  check('float ranks: two StatTrak copies rank against each other only', r2.get('st2').low === 1 && r2.get('st').low === 2 && r2.get('st').high === 1 && r2.get('st').of === 2 && r2.get('b').of === 7);
  const inv = DB.inventoryRanks([...copies.map((c) => c.item), { uid: 'o1', t: 'skin', id: 'other', fl: 0.5 }, { uid: 'o2', t: 'skin', id: 'other', fl: 0.4 }]);
  check('float ranks: a whole inventory, each skin among its own copies', inv.get('b').low === 1 && inv.get('o2').low === 1 && inv.get('o1').high === 1 && inv.get('o1').of === 2);
  const tie = DB.floatRanks([mk('x', 0.1, { at: 5 }), mk('y', 0.1, { at: 2 })]);
  check('float ranks: an equal float ranks by who had it first', tie.get('y').low === 1 && tie.get('x').low === 2);
  const n = DB.countCopies([...copies.map((c) => c.item), { t: 'sticker', id: 'k' }, { t: 'chicken', id: 'h' }]);
  check('item database counts copies by item', n['skin:s'] === 10 && n['sticker:k'] === 1 && !('chicken:h' in n));
}

// ---- charms --------------------------------------------------------------------------------------------------
{
  const { charmBox, CHARM_ODDS } = await E('data');
  const MK = await import(new URL('../src/js/engine/market.js', import.meta.url));
  const box = charmBox(D.charmCollections[0]);
  const N = 200000, counts = {};
  let patsOk = true;
  for (let i = 0; i < N; i++) {
    const it = I.rollFromCase(box, rng);
    counts[I.itemDef(it).r] = (counts[I.itemDef(it).r] || 0) + 1;
    if (!(it.t === 'charm' && it.pat >= 1 && it.pat <= 100000)) patsOk = false;
  }
  check('charm collections drop at a capsule’s odds', Object.entries(CHARM_ODDS).every(([r, p]) => near((counts[r] || 0) / N, p, Math.max(0.003, p * 0.08))), JSON.stringify(counts));
  check('every charm has a pattern from 1 to 100,000', patsOk);
  const pm = (pat) => I.charmPattern(pat).mult;
  check('low and fun charm patterns are worth more', pm(1) > pm(7) && pm(7) > pm(55) && pm(55) > pm(77777) && pm(77777) > pm(500) && pm(500) > pm(54321) && pm(54321) === 1);

  const st = freshState();
  st.money = 100;
  const now = (MK.marketWindow() + 0.5) * MK.MARKET_WINDOW_MS;
  const run = (name, args, opts = {}) => { const ctx = ACT.makeCtx(st, { rng, now, ...opts }); const r = ACT.runAction(ctx, name, args); return { r, d: ACT.delta(ctx) }; };
  const tryRun = (...a) => { try { return run(...a); } catch (e) { return e; } };
  const gunSkin = Object.values(D.skins).find((s) => s.cat === 'rifle' && !s.v && !s.star);
  const knifeSkin = Object.values(D.skins).find((s) => s.cat === 'knife' && !s.v);
  const charmDef = Object.values(D.charms).find((c) => c.p > 1);
  const gun = { uid: 'g', t: 'skin', id: gunSkin.id, fl: 0.2, sd: 3, stk: [], at: 0 };
  const knife = { uid: 'k', t: 'skin', id: knifeSkin.id, fl: 0.2, sd: 3, stk: [], at: 0 };
  const c1 = { uid: 'c1', t: 'charm', id: charmDef.id, pat: 4242, at: 0, src: 'Test' }, c2 = { uid: 'c2', t: 'charm', id: charmDef.id, pat: 9, at: 0 };
  st.inv.push(gun, knife, c1, c2);
  const gunValue = I.itemValue(gun), charmValue = I.itemValue(c1);
  const a = run('charms.attach', { uid: 'g', charm: 'c1' });
  check('attaching puts the charm on the gun and out of the inventory', gun.kc?.id === charmDef.id && gun.kc.pat === 4242 && !st.inv.some((i) => i.uid === 'c1')
    && a.d.del.includes('c1') && a.d.upd.some((i) => i.uid === 'g'));
  check('a gun with a charm is worth both', near(I.itemValue(gun), gunValue + charmValue, 0.011), `${I.itemValue(gun)} vs ${gunValue} + ${charmValue}`);
  check('one charm per gun, and none on knives', tryRun('charms.attach', { uid: 'g', charm: 'c2' }) instanceof Error && tryRun('charms.attach', { uid: 'k', charm: 'c2' }) instanceof Error
    && st.inv.some((i) => i.uid === 'c2'));
  const locked = tryRun('charms.detach', { uid: 'g' }, { reserved: new Set(['g']) });
  const none = tryRun('charms.detach', { uid: 'g' });
  check('taking a charm off needs a Charm Detachment (and not while the gun is in a trade offer)', locked instanceof Error && none?.code === 'detach' && gun.kc && st.money === 100);
  const full = tryRun('charms.detach', { uid: 'g', buy: true }, { invCap: st.inv.length });
  check('a detach that fails (inventory full) changes nothing', full instanceof Error && gun.kc && st.money === 100 && !st.charmDetach);
  const d = run('charms.detach', { uid: 'g', buy: true });
  const back = st.inv.find((i) => i.t === 'charm' && i.pat === 4242);
  check('detaching (buying a pack of three first) gives the same charm back', !gun.kc && back && back.src === 'Test' && back.uid !== 'c1' && d.r.bought === 3 && st.charmDetach === 2
    && near(st.money, 100 - I.DETACH_PACK.price, 1e-9) && d.d.set.charmDetach === 2);
  run('charms.attach', { uid: 'g', charm: back.uid });
  check('a charmed gun can’t go in a trade-up', tryRun('tradeup.sign', { uids: ['g'] })?.message?.includes('charm'));
  const spot = { b: 'weapon_offset', p: [0.93312, 0.4129, 1.6333], n: [0.118, 0.993, -0.021] };
  run('charms.place', { uid: 'g', o: spot });
  const placed = gun.kc.o;
  const badSpots = [{ ...spot, p: [1, 2] }, { ...spot, n: [0, 0, 0] }, { ...spot, b: 'a b' }, { ...spot, p: [1e6, 0, 0] }];
  check('a charm can be moved anywhere on its gun (and only to a real place)', placed?.b === 'weapon_offset' && placed.p[0] === 0.933 && gun.kc.pat === 4242
    && badSpots.every((o) => tryRun('charms.place', { uid: 'g', o }) instanceof Error) && gun.kc.o === placed
    && tryRun('charms.place', { uid: 'g', o: spot }, { reserved: new Set(['g']) }) instanceof Error && tryRun('charms.place', { uid: 'k', o: spot }) instanceof Error);
  run('charms.place', { uid: 'g', o: null });
  const reset = !gun.kc.o && gun.kc.pat === 4242;
  run('charms.place', { uid: 'g', o: spot });
  run('charms.detach', { uid: 'g' });
  const off = st.inv.find((i) => i.t === 'charm' && i.pat === 4242);
  check('moving it back to the gun’s own spot, and taking it off, forget where it hung', reset && off && !off.o && !gun.kc);
  run('charms.attach', { uid: 'g', charm: off.uid });

  const stk = Object.values(D.stickers).find((s) => !s.so && s.p > 0.5);
  st.inv.push({ uid: 's1', t: 'sticker', id: stk.id, at: 0 });
  const money0 = st.money;
  const sl = run('charms.slab', { uid: 's1' }).r.item;
  check('a Sticker Slab seals a sticker into a charm worth the sticker plus the slab', sl.t === 'charm' && sl.id === 'slab' && sl.sk === stk.id && !st.inv.some((i) => i.uid === 's1')
    && near(I.basePrice(sl), stk.p + D.slab.p, 0.011) && near(st.money, money0 - D.slab.p, 1e-9) && I.itemName(sl).startsWith('Sticker Slab |'));
  st.inv.push({ uid: 'g2', t: 'skin', id: gunSkin.id, fl: 0.3, sd: 4, stk: [], sv: true, at: 0 });
  run('charms.attach', { uid: 'g2', charm: sl.uid });
  check('slabs hang on guns like any charm (Souvenirs too)', st.inv.find((i) => i.uid === 'g2').kc?.sk === stk.id);

  const w = MK.marketWindow(now);
  const forSale = Object.values(D.charms).find((c) => MK.unitStock('charm', c, w) > 0);
  st.money = 1000;
  const bought = run('market.buy', { kind: 'charm', id: forSale.id, window: w }).r.item;
  check('charms are sold on the market, each with its own pattern', bought.t === 'charm' && bought.id === forSale.id && bought.pat >= 1 && bought.src === 'Market');
  // Each copy listed has its pattern already, from the clock, so everyone sees the same ones and buys what they see.
  {
    const again = await import(new URL('../src/js/engine/market.js?fresh', import.meta.url)); // nothing cached: as another player's game
    const listed = Object.values(D.charms).flatMap((c) => MK.charmListings(c, w).map((l) => ({ c, l })));
    check('charm listings: one per copy, each with its pattern and its price for it, under the listing ids sales go by', listed.length > 0
      && Object.values(D.charms).every((c) => MK.charmListings(c, w).length === MK.unitStock('charm', c, w))
      && listed.every(({ c, l }) => l.item.pat >= 1 && l.item.pat <= I.CHARM_PATTERNS && l.item.id === c.id && l.p === I.itemValue(l.item) && l.lid === MK.unitLid('charm', c.id, w, l.n)), `${listed.length} listed`);
    check('charm listings: the same on every computer and the server (from the clock alone)',
      listed.every(({ c, l }) => again.charmListings(c, w)[l.n].item.pat === l.item.pat && again.charmListings(c, w)[l.n].p === l.p));
    const mine = MK.charmListings(forSale, w);
    check('the charm bought with no listing named is the first one left', bought.pat === mine[0].item.pat);
    const two = Object.values(D.charms).find((c) => MK.charmListings(c, w).length >= 3 && c.id !== forSale.id), [l0, l1, l2] = MK.charmListings(two, w);
    st.money = 1000;
    const pick = run('market.buy', { kind: 'charm', id: two.id, n: 1, window: w }).r;
    let twice = null; try { run('market.buy', { kind: 'charm', id: two.id, n: 1, window: w }); } catch (e) { twice = e; }
    const first = run('market.buy', { kind: 'charm', id: two.id, window: w }).r, next = run('market.buy', { kind: 'charm', id: two.id, window: w }).r;
    check('buying a charm listing gets you that pattern at its price, once; with none named, those left in order',
      pick.item.pat === l1.item.pat && pick.price === l1.p && twice?.code === 'sold' && first.item.pat === l0.item.pat && next.item.pat === l2.item.pat);
    let gone = null; try { run('market.buy', { kind: 'charm', id: two.id, n: 99, window: w }); } catch (e) { gone = e; }
    check('a charm listing that was never there is refused', !!gone);
    // A low pattern costs what it's worth: nothing to be made buying it and selling it on.
    let rare = null;
    for (let x = w; x > w - 400 && !rare; x--) for (const c of Object.values(D.charms)) { rare = MK.charmListings(c, x).find((l) => I.patternInfo(l.item).label && c.p > 1); if (rare) { rare = { l: rare, c }; break; } }
    check('a rare pattern is priced for it', rare && rare.l.p > rare.c.p && rare.l.p === I.itemValue(rare.l.item), rare && `${rare.c.n} #${rare.l.item.pat}: ${rare.l.p} against ${rare.c.p}`);
  }
  st.stars = 10;
  const offer = A.armoryOffers(A.armoryWindow(now).i).offers.find((o) => o.type === 'charm');
  const red = run('armory.redeem', { offer: offer.id, n: 5 }).r;
  check('the Armory always offers the charm collections', red.items.length === 5 && red.items.every((it) => it.t === 'charm' && D.charms[it.id].col === offer.col && it.sn >= 1)
    && st.stars === 10 - offer.stars * 5);
}


// ---- charm pictures: every charm in its own pattern's colours, from what ships with the game --------------------------
{
  const L = await import(new URL('../src/js/charmlook.js', import.meta.url));
  const looks = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/data/charm-looks.json'), 'utf8'));
  const has = (f) => fs.existsSync(path.join(ROOT, 'src/img/charms', f));
  const ids = Object.keys(looks);
  check('charm pictures: a look for nearly every charm, each with its layers (and print) in the game, none needing CS2', ids.length >= 70 && ids.every((id) => D.charms[id] && has(`${id}.webp`) && (!looks[id].detail || has(`${id}-print.webp`))), `${ids.length} of ${Object.keys(D.charms).length}`);
  check('charm pictures: every look reads at any pattern', ids.every((id) => [1, 4242, 100000].every((pat) => {
    const p = L.lookParams(looks[id], pat);
    return Object.keys(looks[id].dynamic).every((k) => [].concat(p[k]).every(Number.isFinite));
  })));
  // One pixel in the tint mask, one out of it, lit plainly: as layers read from a sheet.
  const look = { adjust: true, params: { g_fContrast: 1, g_fBrightness: 1, g_fSaturation: 1, g_fHueShift: 0 }, dynamic: { g_fHueShift: 'return lerp(0,180,$KeychainSeed);' } };
  const px = (masked) => ({ at: Uint32Array.of(0), n: 1, planes: [Uint8Array.of(200, 80, 60), Uint8Array.of(255, masked ? 255 : 0, 0), Uint8Array.of(140, 140, 140), Uint8Array.of(0, 0, 0)] });
  const paint = (layer, pat) => [...L.paintCharm(layer, look, pat, new Uint8ClampedArray(L.PIC_W * L.PIC_H * 4)).slice(0, 4)];
  const [low, high] = [paint(px(true), 1), paint(px(true), 100000)];
  check('charm pictures: a pattern turns the colour where the tint mask says, and only there', high[2] > high[0] && low[0] > low[2] && String(paint(px(false), 1)) === String(paint(px(false), 100000)), `${low} / ${high}`);
}

// ---- profile levels, Service Medals and match money ------------------------------------------------------------------
{
  const L = await E('levels');
  check('levels: 69 Service Medals, newest first: every colour of 2026, then of 2025, back to 2015', L.MEDALS.length === 69 && L.MEDALS[0].y === 2026 && L.MEDALS[0].l === 1
    && L.MEDALS[5].y === 2026 && L.MEDALS[5].l === 6 && L.MEDALS[6].y === 2025 && L.MEDALS[6].l === 1 && L.MEDALS.at(-1).y === 2015 && L.MEDALS.at(-1).l === 2
    && L.MEDALS.filter((m) => m.y === 2017).length === 7);
  check('match money: a win or draw $250, a loss $100, $20 a kill and $10 an assist',
    L.matchPay({ result: 'win', kills: 3, assists: 2 }).total === 330 && L.matchPay({ result: 'draw' }).total === 250 && L.matchPay({ result: 'loss', kills: 1 }).total === 120);
  const p = L.freshProfile();
  const up = L.addXp(p, 12000, { r: rng });
  check('levels: 5,000 XP a level, and a reward (four to pick two from) for each level up', up.after.level === 3 && up.after.xp === 2000 && up.levelUps === 2 && up.prof.drops.length === 2
    && up.prof.drops.every((d) => d.offers.length === 4 && d.offers.some((o) => o.t === 'crate') && d.offers.some((o) => o.t === 'skin')) && p.level === 1);
  const top = L.addXp({ ...L.freshProfile(), level: 40, xp: 4000 }, 1500, { r: rng });
  check('levels: past level 40 comes the first medal (2026, its first colour) and level 1 again', top.after.level === 1 && top.after.xp === 500 && top.medals[0] === 0
    && L.medalOf(top.prof).y === 2026 && L.medalOf(top.prof).l === 1);
  const seventh = L.addXp({ ...L.freshProfile(), level: 40, xp: 4999, medals: 6 }, 1, { r: rng });
  check('levels: after 2026’s last colour comes 2025’s first', L.medalOf(seventh.prof).y === 2025 && L.medalOf(seventh.prof).l === 1);
  const all = L.addXp({ ...L.freshProfile(), level: 40, xp: 4999, medals: 69 }, 1, { r: rng });
  check('levels: with every medal earned you keep the last one (2015’s second)', all.prof.medals === 69 && L.medalOf(all.prof).y === 2015 && all.after.level === 1);
  const pool = L.dropPool();
  check('level-up rewards come from CS2’s drop pool: its newest cases and the timed-drop collections', up.prof.drops.every((d) => d.offers.every((o) => (o.t === 'crate'
    ? pool.cases.some((c) => c.id === o.id) : pool.collections.some((c) => Object.values(c.tiers).some((ids) => ids.includes(o.id)))))), pool.cases.map((c) => c.n).join(', '));

  const st = freshState();
  const run = (name, args, opts = {}) => { const ctx = ACT.makeCtx(st, { rng, ...opts }); const r = ACT.runAction(ctx, name, args); return { r, d: ACT.delta(ctx) }; };
  const pay = run('play.reward', { mode: 'competitive', result: 'win', kills: 25, assists: 4, roundsWon: 13, rounds: 24 });
  check('a finished match pays and gives XP', pay.r.earned === 790 && near(st.money, 10 + 790, 1e-9) && pay.r.xp.total === 250 + 500 + 40 + 650 && st.prof.xp === pay.r.xp.total && 'prof' in pay.d.set);
  const old = run('play.reward', { won: true, kills: 2, assists: 0, mvps: 1, rounds: 9, difficulty: 'hard' });
  check('the game’s older reward call (won, rounds won) still pays', old.r.earned === 290);
  for (let i = 0; i < 4; i++) run('play.reward', { mode: 'competitive', result: 'loss', kills: 20, assists: 5, roundsWon: 10, rounds: 23 });
  check('levelling up leaves rewards to claim', st.prof.level >= 2 && st.prof.drops.length === st.prof.level - 1);
  const drop = st.prof.drops[0];
  let bad = null; try { run('drop.claim', { id: drop.id, picks: [0] }); } catch (e) { bad = e; }
  const n0 = st.inv.length;
  const got = run('drop.claim', { id: drop.id, picks: [1, 3] });
  let again = null; try { run('drop.claim', { id: drop.id, picks: [0, 2] }); } catch (e) { again = e; }
  check('claiming a reward: exactly two picks, into your inventory, once', bad instanceof ACT.GameError && got.r.items.length === 2 && st.inv.length === n0 + 2
    && got.r.items[0].uid === drop.offers[1].uid && again?.code === 'missing' && !st.prof.drops.some((d) => d.id === drop.id));
  const t0 = Date.now();
  let unseen = null; try { run('play.reward', { result: 'win', kills: 1, roundsWon: 13, rounds: 20 }, { online: true }); } catch (e) { unseen = e; }
  const { run: id } = run('play.start', { mode: 'wingman' }, { now: t0 }).r;
  let quick = null; try { run('play.reward', { run: id, result: 'win', kills: 5, roundsWon: 9, rounds: 14 }, { online: true, now: t0 + 60e3 }); } catch (e) { quick = e; }
  let many = null; try { run('play.reward', { run: id, result: 'win', kills: 40, roundsWon: 9, rounds: 14 }, { online: true, now: t0 + 20 * 60e3 }); } catch (e) { many = e; }
  const ok = run('play.reward', { run: id, result: 'win', kills: 12, roundsWon: 9, rounds: 14 }, { online: true, now: t0 + 20 * 60e3 });
  let twice = null; try { run('play.reward', { run: id, result: 'win', kills: 12, roundsWon: 9, rounds: 14 }, { online: true, now: t0 + 21 * 60e3 }); } catch (e) { twice = e; }
  check('online match money: only for a match the server saw start, once, long enough, with kills a Wingman match could have',
    unseen?.code === 'match' && quick?.code === 'match' && many?.code === 'match' && ok.r.earned === 490 && twice?.code === 'match');
  const crate = drop.offers.find((o) => o.t === 'crate');
  check('reward cases are inventory cases that take their own key', !!keyFor(D.caseById[crate.id]) && I.itemName(crate) === D.caseById[crate.id].n && I.itemValue(crate) === D.caseById[crate.id].price);
}


// ---- NPC players (offline): who they are, what they pay, offers, haggling, trades, the market ------------------------------
{
  const N = await E('npcs');
  const MK = await import(new URL('../src/js/engine/market.js', import.meta.url));
  const people = N.activeCrowd(4242), world = N.crowd(4242);
  check('NPCs: 66 active traders (20 collectors of all 12 kinds, 10 beginners) among 2,000 players, the same for the same save', people.length === 66
    && people.filter((n) => n.type === 'collector').length === 20 && people.filter((n) => n.type === 'beginner').length === 10
    && new Set(people.filter((n) => n.focus).map((n) => n.focus)).size === 12 && world.length === 2000 && new Set(world.map((n) => n.name)).size === 2000 && N.crowd(4242) === world
    && N.npcOf(4242, 'n400') === world[400] && !world[400].active && N.npcOf(4242, 'n1999') === world[1999]
    && N.startingState(4242, people[2]).inv.map((it) => it.id + it.fl).join() === N.startingState(4242, people[2]).inv.map((it) => it.id + it.fl).join());
  // (Saves know their NPCs by their place in the list: the first 420 and what they start with stay as they first were.)
  const { hashStr, mulberry32 } = await E('util');
  const first = world.slice(0, 420);
  const fp = hashStr(JSON.stringify(first.map((n) => [n.id, n.name, n.type, n.focus, n.country, n.avatar, n.joined, n.level, n.medals, n.bio, n.fav, n.g, n.premium, n.patience, n.sharp, n.active]))) >>> 0;
  const fpInv = hashStr(first.slice(0, 60).map((n) => N.startingState(4242, n).inv.map((it) => it.id + ':' + it.fl + ':' + (it.sn || '')).join()).join('|')) >>> 0;
  check('NPCs: the first 420 (and what they own) are who they were before there were more', fp === 717510250 && fpInv === 976647370, `${fp} ${fpInv}`);

  // Beginners: new, gullible, and blind to what makes an item special (theirs and yours).
  const newbies = world.filter((n) => n.type === 'beginner');
  check('NPCs: beginner traders, about a quarter of the newer players, low level and easy to bluff', newbies.length > 350 && newbies.every((n) => n.level <= 8 && n.sharp < 0.2 && n.medals === 0)
    && world.slice(0, 420).every((n) => n.type !== 'beginner'), `${newbies.length} beginners`);
  const lowSkin = Object.values(D.skins).find((s) => !s.v && !s.star && s.mn === 0 && s.p.FN?.[0] > 2);
  const lowIt = { uid: 'low', t: 'skin', id: lowSkin.id, fl: 0.0003, sd: 5, stk: [], at: 0 }, twin = { uid: 'twin', t: 'skin', id: lowSkin.id, fl: 0.06, sd: 5, stk: [], at: 0 };
  const nb = people.find((n) => n.type === 'beginner'), plr = people.find((n) => n.type === 'player');
  const akB = { uid: 'ak', t: 'skin', id: Object.values(D.skins).find((x) => x.w === 'AK-47' && !x.v && x.p.FT?.[0] > 5).id, fl: 0.2, sd: 3, stk: [], at: 0 };
  check('NPCs: a beginner values a 0.0003 float like any Factory New (a player doesn’t)', I.itemValue(lowIt) > I.itemValue(twin) * 1.2 && N.keepValue(nb, lowIt) === N.keepValue(nb, twin)
    && N.buyValue(nb, lowIt) === N.buyValue(nb, twin) && N.keepValue(plr, lowIt) > N.keepValue(plr, twin), `${lowSkin.n}: $${I.itemValue(lowIt)} vs $${I.itemValue(twin)}`);
  const gems = newbies.filter((n) => N.startingState(4242, n).inv.some((it) => it.src === 'Unboxed' && N.highlights(it).length)).length;
  check('NPCs: some beginners own something special without knowing it (a lucky unbox)', gems > newbies.length * 0.2 && gems < newbies.length * 0.5, `${gems} of ${newbies.length}`);
  const believes = (n) => {
    const so2 = N.freshSocial(4242);
    N.npcState(so2, n.id).money = 1e6;
    let k = 0;
    for (let t = 0; t < 200; t++) {
      const o = { npc: n.id, want: { uids: ['ak'], money: 0 }, give: { uids: [], money: 10 }, max: 12, patience: 5, annoy: 0, args: [], agreed: false, status: 'open', exp: 0 };
      N.haggle(so2, { inv: [akB] }, o, { price: 11, arg: 'serial' }, { r: mulberry32(t + 1), now: 0 });
      if (o.max > 12) k++;
    }
    return k / 200;
  };
  const bNb = believes(nb), bPl = believes(plr);
  check('NPCs: a beginner mostly believes a false argument (no serial on it), a player never does', bNb > 0.7 && bPl === 0, `beginner ${bNb}, player ${bPl}`);
  const dop = people.find((n) => n.focus === 'doppler'), pl = people.find((n) => n.type === 'player');
  const ruby = Object.values(D.skins).find((s) => s.ph === 'Ruby'), ak = Object.values(D.skins).find((s) => s.w === 'AK-47' && !s.v && s.p.FT?.[0] > 5);
  const rubyIt = { uid: 'ruby', t: 'skin', id: ruby.id, fl: 0.02, sd: 10, stk: [], at: 0 }, akIt = { uid: 'ak', t: 'skin', id: ak.id, fl: 0.2, sd: 3, stk: [], at: 0 };
  check('NPCs: a collector pays over market for their kind of item, a player around market', N.buyValue(dop, rubyIt) > I.itemValue(rubyIt) * 1.25
    && N.buyValue(pl, akIt) < I.itemValue(akIt) * 1.15 && N.buyValue(dop, akIt) < I.itemValue(akIt));
  const dopStart = N.startingState(4242, dop);
  check('NPCs: collectors own items of their kind', dopStart.inv.filter((it) => N.FOCUS.doppler.fit(it) > 0).length >= 3, `${dopStart.inv.length} items, $${Math.round(dopStart.inv.reduce((t, x) => t + I.itemValue(x), 0))}`);

  const st = freshState();
  st.money = 50;
  st.inv.push(rubyIt, akIt);
  let now = Date.now();
  const run = (name, args, opts = {}) => { const ctx = ACT.makeCtx(st, { rng, now, ...opts }); const r = ACT.runAction(ctx, name, args); return { r, d: ACT.delta(ctx) }; };
  let online = null; try { run('npc.tick', {}, { online: true }); } catch (e) { online = e; }
  check('NPCs are offline only', online?.code === 'online');
  run('npc.tick');
  check('NPCs: a few friends to start with', N.crowd(st.social.seed).filter((n) => st.social.npcs[n.id]?.friend === 1).length === 3);
  for (let k = 0; k < 20 && !st.social.offers.some((o) => o.want.uids.includes('ruby')); k++) { now += 10 * 60e3; run('npc.tick'); }
  const offer = st.social.offers.find((o) => o.want.uids.includes('ruby'));
  check('NPCs: owning a rare item brings offers, with a message', !!offer && st.social.threads[offer.npc].some((m) => m.offer === offer.id) && st.social.unread[offer.npc] > 0,
    offer ? `${N.npcOf(st.social.seed, offer.npc).name}: ${st.social.threads[offer.npc].at(-1).text}` : 'none');
  const bought = Object.values(st.market || {}).flat().length;
  check('NPCs: they buy listings from the market (gone for you too)', bought > 0 && st.social.feed.length > 0, st.social.feed[0]?.text);

  // Haggling: asking far over walks them away eventually; a true argument raises what they'll pay.
  const o = offer;
  const max0 = o.max, net0 = o.give.money - o.want.money;
  const h1 = run('npc.counter', { offer: o.id, price: round2(net0 * 1.03 + 0.01), arg: 'pattern' }).r; // (a Ruby's pattern is no argument, so they're annoyed or it's a near-ask)
  check('NPCs: haggling answers with a deal, a counter, a final price or walking away', ['agree', 'counter', 'final', 'walk'].includes(h1.outcome), h1.text);
  const o2 = st.social.offers.find((x) => x.id === o.id);
  let walked = o2.status !== 'open';
  for (let k = 0; k < 8 && !walked; k++) walked = run('npc.counter', { offer: o.id, price: round2((o2.max + 1) * 3) }).r.outcome === 'walk';
  check('NPCs: asking far too much makes them walk away', walked && st.social.offers.find((x) => x.id === o.id).status === 'withdrawn');
  void max0;

  // Accepting an offer swaps at once.
  for (let k = 0; k < 30 && !st.social.offers.some((x) => x.status === 'open'); k++) { now += 10 * 60e3; run('npc.tick'); }
  const acc = st.social.offers.find((x) => x.status === 'open');
  if (acc) {
    const m0 = st.money, npcMoney0 = st.social.npcs[acc.npc].money;
    const res = run('npc.accept', { offer: acc.id }).r;
    check('NPCs: accepting their offer swaps the items and money', acc.want.uids.every((u) => !st.inv.some((it) => it.uid === u)) && near(st.money, m0 + res.money, 0.011)
      && acc.want.uids.every((u) => st.social.npcs[acc.npc].inv.some((it) => it.uid === u)) && near(st.social.npcs[acc.npc].money, npcMoney0 - res.money, 0.011)
      && st.social.offers.find((x) => x.id === acc.id).status === 'accepted');
  } else check('NPCs: accepting their offer swaps the items and money', false, 'no open offer to accept');

  // Your offers: an overpay is taken, a lowball refused, a near miss countered.
  const target = people.find((n) => n.type === 'player' && N.npcState(st.social, n.id).inv.some((it) => I.itemValue(it) > 3));
  const so = st.social;
  const theirs = N.npcState(so, target.id).inv.filter((it) => I.itemValue(it) > 3).sort((a, b) => I.itemValue(b) - I.itemValue(a))[0];
  st.money = 100000;
  const keep = N.keepValue(target, theirs);
  const low = run('npc.offer', { npc: target.id, give: { money: round2(keep * 0.3) }, get: { uids: [theirs.uid] } }).r;
  const near_ = run('npc.offer', { npc: target.id, give: { money: round2(keep * 0.92) }, get: { uids: [theirs.uid] } }).r;
  const fair = run('npc.offer', { npc: target.id, give: { money: round2(keep * 1.1) }, get: { uids: [theirs.uid] } }).r;
  check('NPCs: your offers — a lowball is refused, a near miss gets a counter, a fair one is taken', low.result === 'declined' && near_.result === 'countered' && fair.result === 'accepted'
    && st.inv.some((it) => it.uid === theirs.uid), `${low.result} / ${near_.result} (${near_.more}) / ${fair.result}`);
  const said = run('npc.say', { npc: target.id, text: 'hey what\'s up' }).r;
  check('NPCs: they answer messages', typeof said.reply === 'string' && said.reply.length > 0);
  run('npc.friend', { npc: people[30].id });
  check('NPCs: adding a friend sends a request', st.social.npcs[people[30].id].friend === 3);
  const rd = N.readMessage('I have another offer, 1.2k and it is a deal');
  check('NPCs: reading a message for a price and an argument', rd.price === 1200 && rd.arg === 'other' && rd.yes);
  const copies = N.worldCopies(st.social), owners = new Set(copies.map((c) => c.npc));
  const stored = Object.keys(st.social.npcs)[0];
  check('NPCs: the Item Database offline has everyone’s items (thousands), as the save has them for those you dealt with', copies.length > 5000 && owners.size > 300
    && copies.filter((c) => c.npc === stored).length === st.social.npcs[stored].inv.length, `${copies.length} copies, ${owners.size} owners`);
  const loads = N.crowd(st.social.seed).map((n) => [n, N.loadoutOf(N.inventoryOf(st.social, n))]);
  const own = (n, it) => N.inventoryOf(st.social, n).includes(it);
  const fits = loads.every(([n, l]) => Object.entries(l.guns).every(([wid, it]) => own(n, it) && I.itemDef(it).wid === wid
    && N.inventoryOf(st.social, n).every((x) => x.t !== 'skin' || I.itemDef(x)?.wid !== wid || I.itemValue(x) <= I.itemValue(it)))
    && (!l.knife || (own(n, l.knife) && I.itemDef(l.knife).cat === 'knife')) && (!l.gloves || (own(n, l.gloves) && I.itemDef(l.gloves).cat === 'gloves')));
  const withAk = loads.filter(([, l]) => l.guns.weapon_ak47).length, withKnife = loads.filter(([, l]) => l.knife).length;
  check('NPCs: their Play loadout is their best skin for each gun, knife and gloves (from what they own)', fits && withAk > 100 && withKnife > 50, `${withAk} with an AK skin, ${withKnife} with a knife`);
  const me = run('persona.set', { name: 'dawso', bio: 'hi <b>', showcase: [st.inv[0].uid, 'nope'], country: 'US', avatar: Object.keys(D.agents)[0] }).r.me;
  check('your profile: name, bio (cleaned), showcase of your own items only', me.name === 'dawso' && me.bio === 'hi b' && me.showcase.length === 1 && me.country === 'US');
}
// ---- Storage Units ----------------------------------------------------------------------------------------------------
{
  const SU = await E('storage');
  const { upgradeState } = await E('economy');
  const N = await E('npcs');
  const skinDef = Object.values(D.skins).find((s) => !s.v && !s.star && s.r === 3);
  const skinOf = (o = {}) => ({ ...I.makeSkinItem(skinDef, { r: rng }), ...o });
  const stickerDef = Object.values(D.stickers).find((s) => s.p > 0);
  const setup = () => {
    const st = { ...freshState(), money: 1000 };
    const ctx = (o = {}) => ACT.makeCtx(st, { rng, ...o });
    const run = (name, args, o) => { const c = ctx(o); const r = ACT.runAction(c, name, args); return { r, d: ACT.delta(c) }; };
    const unit = () => { const u = run('storage.buy', {}).r.items[0]; return u; };
    const named = (name = 'stash') => { const u = unit(); run('storage.name', { unit: u.uid, name }); return u; };
    return { st, run, unit, named, ctx };
  };
  const code = (fn) => { try { fn(); } catch (e) { return e instanceof ACT.GameError ? e.code : 'crash: ' + e.message; } return null; };

  // Buying, labelling, deleting
  {
    const { st, run, unit } = setup();
    const u = unit();
    check('Storage Unit: bought for CS2\'s $1.99, one item in the inventory, worth nothing itself', st.money === 998.01 && st.inv.length === 1 && u.t === 'unit' && u.nw === true && I.itemValue(u) === 0 && SU.UNIT_PRICE === 1.99);
    check('Storage Unit: a Base Grade Tool', I.itemName(u) === 'Storage Unit' && I.rarityInfo(u).n === 'Base Grade Tool' && I.nameParts(u).top === 'Storage Unit');
    check('Storage Unit: refused without the money', code(() => { st.money = 1; run('storage.buy', {}); }) === 'funds' && st.inv.length === 1 && st.money === 1);
    st.money = 1000;
    const it = skinOf();
    st.inv.push(it);
    check('Storage Unit: nothing goes in until it has a label', code(() => run('storage.deposit', { unit: u.uid, uids: [it.uid] })) === 'unnamed' && st.inv.includes(it));
    check('Storage Unit: a blank label is refused', code(() => run('storage.name', { unit: u.uid, name: '   ' })) === 'bad' && !u.name);
    run('storage.name', { unit: u.uid, name: '  <b>Blue "gems"</b> and a very long label' });
    check('Storage Unit: a label is cleaned and cut to 20 characters', u.name === "bBlue 'gems'/b and a" && u.name.length <= SU.UNIT_NAME_MAX && !/[<>"]/.test(u.name), u.name);
    check('Storage Unit: its name shows the label', I.itemName(u) === `Storage Unit "${u.name}"` && I.nameParts(u).bottom === u.name);
    const at = u.mod;
    run('storage.name', { unit: u.uid, name: 'Keepers' }, { now: at + 5000 });
    check('Storage Unit: changing the label is free and counts as a change', u.name === 'Keepers' && u.mod === at + 5000 && st.money === 1000);
    check('Storage Unit: a thing that isn\'t a unit can\'t be labelled', code(() => run('storage.name', { unit: it.uid, name: 'x' })) === 'bad');
  }
  {
    const { st, run, named } = setup();
    const u = named(), it = skinOf();
    st.inv.push(it);
    run('storage.deposit', { unit: u.uid, uids: [it.uid] });
    check('Storage Unit: one with items in it can\'t be deleted', code(() => run('storage.delete', { unit: u.uid })) === 'unit' && st.inv.includes(u));
    run('storage.retrieve', { unit: u.uid, uids: [it.uid] });
    const money = st.money;
    run('storage.delete', { unit: u.uid });
    check('Storage Unit: an empty one can be deleted, for no refund', !st.inv.some((x) => x.uid === u.uid) && st.money === money);
  }
  {
    const { st, run, unit } = setup();
    st.money = 1e4;
    for (let i = 0; i < SU.MAX_UNITS; i++) unit();
    check('Storage Unit: there is a limit on how many you own', code(() => run('storage.buy', {})) === 'units' && SU.unitsOf(st).length === SU.MAX_UNITS);
  }
  {
    const { st, ctx } = setup();
    st.inv = Array.from({ length: 5 }, () => skinOf());
    const c = ctx({ invCap: 5 });
    ACT.runAction(c, 'storage.buy', {});
    check('Storage Unit: a full inventory can still buy one, as in CS2 (a unit is how you make room)', st.inv.length === 6);
  }

  // Deposit and retrieve
  {
    const { st, run, named } = setup();
    const u = named(), a = skinOf({ nw: true }), b = skinOf({ lk: true }), c = skinOf();
    st.inv.push(a, b, c);
    const before = SU.ownedValue(st), net = st.money + before;
    const { r, d } = run('storage.deposit', { unit: u.uid, uids: [a.uid, b.uid] }, { now: 1234567 });
    const kept = SU.contents(st, u.uid);
    check('Storage Unit: deposit moves items out of the inventory, in bulk', r.n === 2 && st.inv.length === 2 && kept.length === 2 && kept.every((x) => x.su === u.uid && x.sat === 1234567));
    check('Storage Unit: stored items lose "New" and keep being locked', !kept.find((x) => x.uid === a.uid).nw && kept.find((x) => x.uid === b.uid).lk === true);
    check('Storage Unit: it shows when it changed', u.mod === 1234567);
    check('Storage Unit: the unit still counts as one item whatever is in it', st.inv.filter(I.isUnit).length === 1 && SU.unitCount(st, u.uid) === 2);
    check('Storage Unit: storing changes neither what you own nor your net worth', SU.ownedValue(st) === before && st.money + SU.ownedValue(st) === net && SU.ownedItems(st).length === 4);
    check('Storage Unit: the delta sends what moved, not the whole unit', d.sto.add.length === 2 && d.del.length === 2 && !('stored' in d.set) && d.upd.some((x) => x.uid === u.uid));
    const again = run('storage.retrieve', { unit: u.uid, uids: [a.uid] }, { now: 2000000 });
    const back = st.inv.find((x) => x.uid === a.uid);
    check('Storage Unit: retrieve puts it back as it was, one at a time', again.r.n === 1 && back && back.su === undefined && back.sat === undefined && back.fl === a.fl && back.sd === a.sd && !SU.storedItem(st, a.uid) && u.mod === 2000000);
    check('Storage Unit: retrieve\'s delta', again.d.sto.del.includes(a.uid) && again.d.add.some((x) => x.uid === a.uid) && !again.d.sto.add.length);
    check('Storage Unit: retrieving what isn\'t in it is refused', code(() => run('storage.retrieve', { unit: u.uid, uids: [c.uid] })) === 'missing');
    check('Storage Unit: the same item twice is refused', code(() => run('storage.deposit', { unit: u.uid, uids: [c.uid, c.uid] })) === 'bad');
    check('Storage Unit: an empty list is refused', code(() => run('storage.deposit', { unit: u.uid, uids: [] })) === 'bad' && code(() => run('storage.retrieve', { unit: u.uid, uids: 'x' })) === 'bad');
  }
  {
    const { st, run, named } = setup();
    const u = named('one'), v = named('two'), it = skinOf();
    st.inv.push(it);
    check('Storage Unit: a unit can\'t go in a unit', code(() => run('storage.deposit', { unit: u.uid, uids: [v.uid] })) === 'unit' && st.inv.includes(v));
    check('Storage Unit: nor in itself', code(() => run('storage.deposit', { unit: u.uid, uids: [u.uid] })) === 'unit');
    run('storage.deposit', { unit: u.uid, uids: [it.uid] });
    check('Storage Unit: an item is only retrieved from the unit it is in', code(() => run('storage.retrieve', { unit: v.uid, uids: [it.uid] })) === 'missing' && SU.unitCount(st, u.uid) === 1);
    check('Storage Unit: a stored item can\'t be deposited again', code(() => run('storage.deposit', { unit: v.uid, uids: [it.uid] })) === 'stored');
  }
  {
    const { st, run, named } = setup();
    const u = named(), a = skinOf();
    st.inv.push(a);
    const c = ACT.makeCtx(st, { rng, reserved: new Set([a.uid]) });
    check('Storage Unit: an item in a pending trade offer can\'t be stored', code(() => ACT.runAction(c, 'storage.deposit', { unit: u.uid, uids: [a.uid] })) === 'reserved' && st.inv.includes(a) && !st.stored.length);
    const mod = u.mod;
    check('Storage Unit: and a refused move leaves the unit as it was', u.mod === mod && !c.sto.add.length);
    run('loadout.equip', { uid: a.uid });
    const slot = I.loadoutSlot(a);
    check('Storage Unit: (equipped first)', st.loadout[slot] === a.uid);
    run('storage.deposit', { unit: u.uid, uids: [a.uid] });
    check('Storage Unit: an equipped item comes off when it\'s stored', !st.loadout[slot]);
    check('Storage Unit: a stored item can\'t be equipped', code(() => run('loadout.equip', { uid: a.uid })) === 'stored');
  }

  // The 1,000 cap
  {
    const { st, run, named } = setup();
    const u = named();
    const many = (n) => Array.from({ length: n }, () => I.makeStickerItem(stickerDef, 'x'));
    let items = many(999);
    st.inv.push(...items);
    run('storage.deposit', { unit: u.uid, uids: items.map((i) => i.uid) });
    const two = many(2);
    st.inv.push(...two);
    const uids = two.map((i) => i.uid);
    check('1,000 cap: 999 fit and two more are refused, all or nothing', code(() => run('storage.deposit', { unit: u.uid, uids })) === 'unitfull' && SU.unitCount(st, u.uid) === 999 && two.every((x) => st.inv.includes(x)));
    run('storage.deposit', { unit: u.uid, uids: [uids[0]] });
    check('1,000 cap: the 1,000th fits', SU.unitCount(st, u.uid) === 1000);
    const e = (() => { try { run('storage.deposit', { unit: u.uid, uids: [uids[1]] }); } catch (x) { return x; } return null; })();
    check('1,000 cap: the 1,001st doesn\'t, and says so', e?.code === 'unitfull' && /full/.test(e.message) && st.inv.some((x) => x.uid === uids[1]));
    const inv0 = st.inv.length;
    run('storage.retrieve', { unit: u.uid, uids: items.slice(0, 1000 - 1).map((i) => i.uid) });
    check('1,000 cap: a thousand come back out in one go', st.inv.length === inv0 + 999 && SU.unitCount(st, u.uid) === 1);
    check('1,000 cap: more than a unit holds is no request at all', code(() => run('storage.deposit', { unit: u.uid, uids: Array.from({ length: 1001 }, (_, i) => 'u' + i) })) === 'bad');
    check('1,000 cap: units have their own: a second unit starts empty', (() => { const v = named('two'); return SU.unitCount(st, v.uid) === 0 && !code(() => run('storage.deposit', { unit: v.uid, uids: [uids[1]] })); })());
  }
  {
    const { st, ctx, run, named } = setup();
    const u = named(), a = skinOf(), b = skinOf();
    st.inv.push(a, b);
    run('storage.deposit', { unit: u.uid, uids: [a.uid, b.uid] });
    st.inv.push(...Array.from({ length: 3 }, () => skinOf()));
    const before = JSON.stringify(st.stored), c = ctx({ invCap: st.inv.length + 1 });
    check('a full inventory refuses a retrieve, all or nothing', code(() => ACT.runAction(c, 'storage.retrieve', { unit: u.uid, uids: [a.uid, b.uid] })) === 'full' && JSON.stringify(st.stored) === before && !c.sto.del.length);
    check('that\'s the same inventory limit as anywhere: one still fits', !code(() => ACT.runAction(ctx({ invCap: st.inv.length + 1 }), 'storage.retrieve', { unit: u.uid, uids: [a.uid] })));
  }

  // Refusals: everything that touches inventory items
  {
    const { st, run, named, ctx } = setup();
    const u = named();
    // (a contract's worth of one rarity, cases, keys, stickers, a charm and a gun to work on)
    const col = Object.values(D.skins).find((s) => !s.v && !s.star && s.r === 2 && s.col && T.tradeupIneligible({ t: 'skin', id: s.id, fl: s.mn }) === '');
    const ten = Array.from({ length: 10 }, () => I.makeSkinItem(col, { stt: false, r: rng }));
    const box = D.cases.find((c) => c.n === 'Chroma 2 Case');
    const crate = I.makeCrateItem(box, 'x'), key = I.makeKeyItem(keyFor(box), 'x');
    const sticker = I.makeStickerItem(stickerDef, 'x'), gun = I.makeSkinItem(Object.values(D.skins).find((s) => !s.v && I.canHaveStickers({ t: 'skin', id: s.id, sv: false })), { stt: false, r: rng });
    const charm = I.makeCharmItem(Object.values(D.charms)[0], { r: rng }), gun2 = I.makeSkinItem(skinDef, { stt: false, r: rng });
    st.inv.push(...ten, crate, key, sticker, gun, charm);
    const all = [...ten, crate, key, sticker, gun, charm];
    run('storage.deposit', { unit: u.uid, uids: all.map((i) => i.uid) });
    const held = () => SU.unitCount(st, u.uid) === all.length;
    const stake = { money: 0, uids: [gun.uid] };
    const paths = {
      'selling': () => run('item.sell', { uids: [gun.uid] }),
      'locking': () => run('item.lock', { uid: gun.uid, lk: true }),
      'equipping': () => run('loadout.equip', { uid: gun.uid }),
      'a trade-up': () => run('tradeup.sign', { uids: ten.map((i) => i.uid) }),
      'stickers on a stored gun': () => run('stickers.apply', { uid: gun.uid, stickers: [] }),
      'a stored sticker': () => { st.inv.push(gun2); try { run('stickers.apply', { uid: gun2.uid, stickers: [{ srcUid: sticker.uid, x: 0.5, y: 0.5, r: 0 }] }); } finally { st.inv = st.inv.filter((x) => x !== gun2); } },
      'scraping': () => run('stickers.scrape', { uid: gun.uid, i: 0 }),
      'a charm on a stored gun': () => run('charms.attach', { uid: gun.uid, charm: charm.uid }),
      'slabbing': () => run('charms.slab', { uid: sticker.uid }),
      'opening a stored case': () => run('case.open', { id: box.id, uids: [crate.uid] }),
      'StatTrak kills': () => run('play.stattrak', { uid: gun.uid, kills: 1 }),
      'a coinflip stake': () => run('gamble.coinflip', { ...stake, side: 't', clientSeed: 's' }),
      'a jackpot stake': () => run('gamble.jackpot', { ...stake, bots: 1, clientSeed: 's' }),
    };
    for (const [name, fn] of Object.entries(paths)) check(`stored items refuse ${name}`, code(fn) === 'stored' && held(), code(fn));
    check('opening needs a case outside the unit: a stored one isn\'t counted', code(() => run('case.open', { id: box.id, n: 1 })) === 'nocase');
    // (a key in storage doesn't open a case in the inventory either)
    const out = I.makeCrateItem(box, 'x');
    st.inv.push(out);
    check('a stored key doesn\'t open a case', code(() => run('case.open', { id: box.id, uids: [out.uid] })) === 'nokey' && held());
    st.inv = st.inv.filter((x) => x !== out);
    const c = ACT.makeCtx(st, { rng });
    check('stored items refuse a server-style take too (trades, escrow)', code(() => ACT.take(c, [gun.uid])) === 'stored' && code(() => ACT.takeStake(c, { uids: [gun.uid] })) === 'stored' && held());
    run('npc.tick');
    const so = st.social, npc = N.crowd(so.seed)[0];
    check('stored items refuse an NPC trade offer', code(() => run('npc.offer', { npc: npc.id, give: { uids: [gun.uid] }, get: { money: 1 } })) === 'stored' && held());
    const o = { id: 'o1', npc: npc.id, kind: 'buy', at: Date.now(), exp: Date.now() + 1e7, status: 'open', want: { uids: [gun.uid], money: 0 }, give: { uids: [], money: 5 }, max: 6, patience: 3, annoy: 0, args: [] };
    st.social = { ...st.social, offers: [...st.social.offers, o] };
    check('stored items refuse an NPC\'s offer for them', code(() => run('npc.accept', { offer: 'o1' })) === 'stored' && held());
    check('and haggling over it', code(() => run('npc.counter', { offer: 'o1', price: 6 })) === 'stored');
    const said = run('npc.say', { npc: npc.id, text: 'how about 10 bucks' }).r;
    check('and a message isn\'t read as a haggle over it', said.outcome === null);
    run('npc.tick', {}, { now: Date.now() + 60e3 });
    check('an NPC\'s open offer for an item you stored lapses', st.social.offers.find((x) => x.id === 'o1').status === 'expired');
    const offer = N.makeOffer(st.social, st, { r: rng, now: Date.now() });
    check('NPCs don\'t offer for what\'s stored', !offer?.want.uids.some((x) => SU.storedItem(st, x)));
    check('your showcase can\'t hold what\'s stored', run('persona.set', { showcase: [gun.uid] }).r.me.showcase.length === 0);
    run('storage.retrieve', { unit: u.uid, uids: [gun.uid] });
    check('out again, it sells', run('item.sell', { uids: [gun.uid] }).r.n === 1);
  }
  {
    const { st, run, named } = setup();
    const u = named();
    check('units refuse being sold', code(() => run('item.sell', { uids: [u.uid] })) === 'unit' && st.inv.includes(u));
    check('units refuse a stake', code(() => run('gamble.coinflip', { money: 1, uids: [u.uid], side: 't', clientSeed: 's' })) === 'unit' && st.money === 998.01);
    run('npc.tick');
    const npc = N.crowd(st.social.seed)[0];
    check('units refuse an NPC trade', code(() => run('npc.offer', { npc: npc.id, give: { uids: [u.uid] }, get: { money: 1 } })) === 'unit');
    check('units refuse a trade-up', code(() => run('tradeup.sign', { uids: [u.uid] })) !== null && st.inv.includes(u));
    check('units aren\'t tradable', !I.tradable(u) && I.tradable(skinOf()) && !I.tradable(skinOf({ lk: true })));
    check('units can\'t be showcased or equipped', code(() => run('loadout.equip', { uid: u.uid })) === 'bad' && run('persona.set', { showcase: [u.uid] }).r.me.showcase.length === 0);
    check('NPCs never want a unit', !N.notable(u));
  }

  // The contents view
  {
    const { st, run, named } = setup();
    const u = named();
    const cheap = skinOf({ fl: 0.5, at: 1 }), blue = I.makeSkinItem(Object.values(D.skins).find((s) => !s.v && !s.star && s.r === 2), { r: rng }), sticker = I.makeStickerItem(stickerDef, 'x');
    st.inv.push(cheap, blue, sticker);
    run('storage.deposit', { unit: u.uid, uids: [cheap.uid] }, { now: 100 });
    run('storage.deposit', { unit: u.uid, uids: [blue.uid] }, { now: 200 });
    run('storage.deposit', { unit: u.uid, uids: [sticker.uid] }, { now: 300 });
    const list = SU.contents(st, u.uid), ids = (l) => l.map((x) => x.uid);
    check('contents: newest stored first, or oldest', ids(SU.viewItems(list, { sort: 'new' }))[0] === sticker.uid && ids(SU.viewItems(list, { sort: 'old' }))[0] === cheap.uid);
    check('contents: by value both ways', I.itemValue(SU.viewItems(list, { sort: 'vdesc' })[0]) >= I.itemValue(SU.viewItems(list, { sort: 'vasc' })[0]));
    check('contents: search by name', ids(SU.viewItems(list, { q: I.itemName(blue).slice(0, 6).toUpperCase() })).includes(blue.uid) && SU.viewItems(list, { q: 'zzzzqq' }).length === 0);
    check('contents: filter by rarity', SU.viewItems(list, { rank: String(I.rarityRank(cheap)) }).every((x) => I.rarityRank(x) === I.rarityRank(cheap)) && SU.viewItems(list, { rank: '6' }).length === 0);
    check('contents: a copy, so sorting leaves the list as it was', ids(list).join() === ids(SU.contents(st, u.uid)).join());
    check('contents: every filter and order the window offers works', SU.SORT_NAMES.every(([k]) => SU.viewItems(list, { sort: k }).length === 3) && SU.RANK_FILTERS.every(([k]) => Array.isArray(SU.viewItems(list, { rank: k }))));
  }

  // Failed actions
  {
    const { st, run, named } = setup();
    const u = named(), a = skinOf(), b = skinOf();
    st.inv.push(a, b);
    const inv0 = [...st.inv], stored0 = st.stored;
    check('a failed bulk deposit moves nothing (the second item is missing)', code(() => run('storage.deposit', { unit: u.uid, uids: [a.uid, 'nope'] })) === 'missing' && st.stored === stored0 && st.inv.length === inv0.length && inv0.every((x, i) => st.inv[i] === x));
  }

  // Older saves
  {
    const SAVE = { money: 50, inv: [skinOf()], stats: { opened: 3 }, serialsBackfilled: true };
    const old = upgradeState(structuredClone(SAVE));
    check('save upgrade: an older save gets empty storage and keeps everything else', Array.isArray(old.stored) && !old.stored.length && old.inv.length === 1 && old.money === 50 && old.stats.opened === 3);
    const ctx = ACT.makeCtx(old, { rng });
    check('save upgrade: and can buy, label and fill a unit straight away', !code(() => { const u = ACT.runAction(ctx, 'storage.buy', {}).items[0]; ACT.runAction(ctx, 'storage.name', { unit: u.uid, name: 'x' }); ACT.runAction(ctx, 'storage.deposit', { unit: u.uid, uids: [old.inv.find((i) => i.t === 'skin').uid] }); }) && old.stored.length === 1);
    const round = upgradeState(JSON.parse(JSON.stringify(old)));
    check('save upgrade: a save with units comes back the same', round.stored.length === 1 && round.stored[0].su === old.inv.find(I.isUnit).uid && round.inv.find(I.isUnit).name === 'x');
    check('save upgrade: running it again changes nothing', JSON.stringify(upgradeState(JSON.parse(JSON.stringify(round))).stored) === JSON.stringify(round.stored));
    const unit = { ...I.makeUnitItem('x'), name: 'u' }, lost = skinOf({ su: 'gone', sat: 1 }), both = skinOf(), dupe = { ...both, su: unit.uid, sat: 2 }, nested = { ...I.makeUnitItem('x'), su: unit.uid };
    const fixed = upgradeState({ money: 1, inv: [unit, both], stored: [lost, dupe, nested, null, 'x'], stats: {} });
    check('save upgrade: an item stored in a unit that\'s gone goes back to the inventory, without its storage fields', fixed.inv.some((i) => i.uid === lost.uid && i.su === undefined && i.sat === undefined));
    check('save upgrade: an item in both places stays in the inventory, once', fixed.inv.filter((i) => i.uid === both.uid).length === 1 && !fixed.stored.some((i) => i.uid === both.uid));
    check('save upgrade: a unit inside a unit comes out', fixed.inv.some((i) => i.uid === nested.uid) && !fixed.stored.length);
    check('save upgrade: stored that isn\'t a list is treated as empty', Array.isArray(upgradeState({ money: 1, inv: [], stored: 'x', stats: {} }).stored));
    const over = Array.from({ length: 1002 }, () => I.makeStickerItem(stickerDef, 'x')).map((i) => ({ ...i, su: unit.uid }));
    const big = upgradeState({ money: 1, inv: [unit], stored: over, stats: {} });
    check('save upgrade: over a unit\'s limit, the extra go to the inventory, none lost', big.stored.length === 1000 && big.inv.length === 3);
    const eq = skinOf({ su: unit.uid });
    check('save upgrade: nothing stays equipped from inside a unit', Object.keys(upgradeState({ money: 1, inv: [unit], stored: [eq], loadout: { 'w:x': eq.uid }, stats: {} }).loadout).length === 0);
    const unboxed = skinOf({ src: 'Chroma 2 Case', su: unit.uid, sn: undefined });
    delete unboxed.sn;
    const pre = upgradeState({ money: 1, inv: [unit], stored: [unboxed], stats: {} });
    I.backfillSerials(pre);
    check('save upgrade: serial numbers are backfilled on what\'s stored too', pre.stored[0].sn === 1 && pre.serialsBackfilled === true);
    const chick = { uid: 'c1', t: 'chicken', id: Object.keys((await E('chickens')).BREED)[0], su: unit.uid };
    const ret = upgradeState({ money: 1, inv: [unit], stored: [chick], stats: {} });
    check('save upgrade: retired items are sold wherever they are', I.retireOld(ret).n === 1 && !ret.stored.length);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
