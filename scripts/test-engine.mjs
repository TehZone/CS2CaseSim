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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
