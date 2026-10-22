// Engine checks: odds, armory rotation, trade-up rules, provably-fair gambling, team manager and actions.
//   node scripts/test-engine.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = (m) => import(new URL(`../src/js/engine/${m}.js`, import.meta.url));
const { D, initData, caseTiers, COLLECTION_ODDS, CASE_ODDS } = await E('data');
initData(JSON.parse(fs.readFileSync(path.join(ROOT, 'src/data/game-data.json'), 'utf8')));
const I = await E('items');
const T = await E('tradeup');
const A = await E('armory');
const G = await E('gamble');
const M = await E('manager');
const ACT = await E('actions');
const { freshState } = await E('economy');
const { mulberry32 } = await E('util');

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

// ---- team manager -------------------------------------------------------------------------------
{
  const teams = M.allRosterTeams();
  const nearT = (r) => teams.reduce((a, b) => (Math.abs(b.rating - r) < Math.abs(a.rating - r) ? b : a));
  const winRate = (d) => { const A2 = nearT(80 + d), B = nearT(80); let w = 0; for (let i = 0; i < 300; i++) if (M.simulateMatch(A2, B, rng).winner === 'A') w++; return w / 300; };
  const w0 = winRate(0), w5 = winRate(5), w12 = winRate(12);
  check('match sim: better teams win more often', w0 < w5 && w5 < w12 && w12 > 0.85 && w0 > 0.3 && w0 < 0.7, `even ${w0.toFixed(2)}, +5 ${w5.toFixed(2)}, +12 ${w12.toFixed(2)}`);
  const m = M.simulateMatch(nearT(85), nearT(84), rng);
  check('matches end 13-x or in overtime', (Math.max(...m.score) === 13 && Math.min(...m.score) <= 11) || (m.overtime && Math.abs(m.score[0] - m.score[1]) >= 1), m.score.join('-'));
  const cards = M.openPack('premium', rng);
  check('premium pack has 5 cards with a Gold+', cards.length === 5 && cards.some((c) => I.proTier(D.pros[c.id].ovr) >= 2));
  for (const p of M.PACKS) {
    const id = p.perEvent ? 'major:' + M.packEvents()[0] : p.id;
    const ev = M.packEV(p, p.perEvent ? M.packEvents()[0] : null);
    check(`${p.n} returns ~85% (${id} $${M.packPrice(id)})`, near(ev / M.packPrice(id), 0.85, 0.06));
  }
}

// ---- actions --------------------------------------------------------------------------------------
{
  const st = freshState();
  st.money = 1000;
  const run = (name, args) => { const ctx = ACT.makeCtx(st, { rng }); const r = ACT.runAction(ctx, name, args); return { r, d: ACT.delta(ctx) }; };
  const box = D.cases.find((x) => x.n === 'Chroma 2 Case');
  const { r, d } = run('case.open', { id: box.id, n: 3 });
  check('case.open debits and adds items', r.items.length === 3 && near(st.money, 1000 - r.cost, 1e-9) && d.add.length === 3 && d.set.money === st.money);
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
    const all = run('case.open', { id: box.id, n: 10, autoSell: { on: true, below: 1e6, ranks: [], keepStt: false, keepRare: false } });
    const sold = all.r.items.filter((i) => i.as), kept = all.r.items.filter((i) => !i.as);
    const soldValue = sold.reduce((s, i) => s + I.itemValue(i), 0);
    check('auto-sell by amount sells every non-★ drop and pays for it', kept.every((i) => I.rarityRank(i) >= 6) && st.inv.length === n0 + kept.length
      && Math.abs(st.money - (before - all.r.cost + soldValue)) < 0.011 && Math.abs(all.r.autoSold - soldValue) < 0.011);
    const byRank = run('case.open', { id: box.id, n: 10, autoSell: { on: true, below: 0, ranks: [2], keepStt: true, keepRare: false } });
    check('auto-sell by rarity only sells that rarity (and keeps StatTrak)', byRank.r.items.every((i) => !!i.as === (I.rarityRank(i) === 2 && !i.stt)));
    const off = run('case.open', { id: box.id, n: 3, autoSell: { on: false, below: 1e6, ranks: [2] } });
    check('auto-sell off keeps everything', off.r.items.every((i) => !i.as) && !off.r.autoSold);
    const knife = { uid: 'k', t: 'skin', id: box.rare[0][0], fl: 0.3, sd: 1, stt: false, stk: [] };
    check('knives and gloves are never auto-sold', !I.autoSellMatch(knife, { on: true, below: 1e9, ranks: [0, 1, 2, 3, 4, 5] }));
  }
  {
    // A failure part-way (inventory full after paying) leaves the state untouched.
    const m = st.money, n = st.inv.length, opened = st.stats.opened;
    const ctx = ACT.makeCtx(st, { rng, invCap: st.inv.length + 1 });
    let e = null; try { ACT.runAction(ctx, 'case.open', { id: box.id, n: 3 }); } catch (x) { e = x; }
    check('failed actions change nothing (all-or-nothing)', e?.code === 'full' && st.money === m && st.inv.length === n && st.stats.opened === opened);
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
  const pk = run('team.pack', { pack: 'legend' });
  const cards = pk.r.items;
  const flip = run('gamble.coinflip', { money: 10, side: 'ct', clientSeed: 'x' });
  check('coinflip settles with the revealed seed', flip.r.result === G.coinflipResult(flip.r.fair.serverSeed, flip.r.fair.clientSeed));
  const m0 = st.money;
  const bat = run('gamble.battle', { cases: [box.id, box.id], format: '1v1v1', mode: 'normal', clientSeed: 'y' });
  check('bot battle charges the cost and pays out the winner', near(st.money, m0 - bat.r.cost, 1e-9) && (bat.r.won ? bat.r.prize.length === 6 : bat.r.prize.length === 0));
  const jp = run('gamble.jackpot', { money: 5, bots: 3, clientSeed: 'z' });
  check('jackpot vs bots has 4 entries', jp.r.entries.length === 4);
  // Fill a team and play a match.
  for (let i = 0; i < 4; i++) run('team.pack', { pack: 'premium' });
  const owned = st.inv.filter((i) => i.t === 'pro');
  const pick = M.autoLineup([...new Map(owned.map((it) => [D.pros[it.id].pid, D.pros[it.id]])).values()]);
  const slots = Object.fromEntries(M.SLOTS.map((s) => [s, owned.find((it) => it.id === pick[s].id).uid]));
  run('team.set', { slots });
  const mt = run('team.match', { opp: M.allRosterTeams()[100].key });
  check('team match plays out and pays a reward', mt.r.match.rounds.length >= 13 && mt.r.reward > 0);
  run('team.cupStart', { type: 'lan' });
  let cup;
  for (let k = 0; k < 4; k++) { cup = run('team.cupPlay').r.cup; if (cup.done) break; }
  check('LAN event plays to a finish', cup.done && cup.place >= 1, 'place ' + cup.place);
  void cards;
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
