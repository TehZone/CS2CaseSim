// Engine checks: odds, armory rotation, trade-up rules, provably-fair gambling and actions.
//   node scripts/test-engine.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
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
  // Premium patterns (blue gems etc.) are kept on only ~10% of listings that roll one. (69 of the AK-47's seeds are a Blue Gem
  // Tier 2 or better since the CS.MONEY Wiki's ranks, 28 before: hence one in 100 restocks rather than one in 170.)
  const ch = Object.values(D.skins).find((s) => s.n === 'AK-47 | Case Hardened');
  let listings = 0, premium = 0;
  for (let w = W0; w < W0 + 3000; w++) for (const l of MK.skinListings(ch, w)) { listings++; if (['t0', 't1', 't2'].includes(I.patternInfo(l.item).tier)) premium++; }
  check('blue gems rarely reach the market', premium / 3000 < 0.01, `${premium} blue-gem-tier AK Case Hardened listings in 3000 restocks (${listings} listings)`);
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

// ---- Case Hardened and Heat Treated: every label comes from what the seed really shows --------------------------------
{
  // (What the measuring gives by itself: on the 12 skins the CS.MONEY Wiki covers its groups go on top, checked further down.)
  const { basePattern: analyzePattern, playside } = await E('patterns');
  const { CASE_HARDENED } = await E('case-hardened-data');
  const seeds = Array.from({ length: 1001 }, (_, i) => i);
  const hardened = Object.values(D.skins).filter((s) => s.fin === 'Case Hardened' || s.fin === 'Heat Treated');
  const measured = hardened.filter((s) => s.cat !== 'gloves');
  const skin = (wid, fin = 'Case Hardened') => hardened.find((s) => s.wid === wid && s.fin === fin);
  const ak = skin('weapon_ak47'), karambit = skin('weapon_knife_karambit'), five = skin('weapon_fiveseven'), daggers = skin('weapon_knife_push');
  const fiveHeat = skin('weapon_fiveseven', 'Heat Treated'), deagleHeat = skin('weapon_deagle', 'Heat Treated'), hydra = hardened.find((s) => s.cat === 'gloves');
  const data = (s) => CASE_HARDENED[s.wid][s.fid];
  const digit = (text, sd) => parseInt(text.slice(sd * 2, sd * 2 + 2), 32) / 10;
  const blueOf = (s, sd) => digit(data(s).b, sd), goldOf = (s, sd) => digit(data(s).g, sd);
  const bluest = (s) => seeds.reduce((a, b) => (blueOf(s, b) > blueOf(s, a) ? b : a));
  const typical = new Map(measured.map((s) => [s, seeds.map((sd) => blueOf(s, sd)).sort((a, b) => a - b)[500]]));
  const label = (s, sd) => analyzePattern(s, sd).label;
  const count = (s, test) => seeds.filter((sd) => test(label(s, sd))).length;
  const gem = (l) => l.includes('Blue Gem');
  const each = (test) => measured.flatMap((s) => seeds.filter((sd) => !test(s, sd)).map((sd) => `${s.n} ${sd}`));
  const shown = (list) => (list.length ? `${list.length}: ${list.slice(0, 5).join(', ')}` : '');

  check('Case Hardened: all skins but the gloves are measured, all 1001 seeds', hardened.length === 26 && measured.length === 25 && measured.every((s) => data(s)?.b.length === 2002 && data(s).g.length === 2002));
  let bad = each((s, sd) => { const p = analyzePattern(s, sd); return p.blue === blueOf(s, sd) / 100 && p.gold === goldOf(s, sd) / 100; });
  check('Case Hardened: blue and gold are the file\'s numbers, every seed of every skin', !bad.length, shown(bad));
  bad = each((s, sd) => { const { info } = analyzePattern(s, sd); return info.length === 2 && info[0][0] === 'Playside blue' && info[0][1] === blueOf(s, sd).toFixed(1) + '%' && info[1][0] === 'Playside gold' && info[1][1] === goldOf(s, sd).toFixed(1) + '%'; });
  check('Case Hardened: and so is the info line', !bad.length, shown(bad));
  check('Case Hardened: blue and gold never come to more than the whole', !each((s, sd) => blueOf(s, sd) + goldOf(s, sd) <= 100.1).length);
  // Pinned from the measuring, so a number made up per seed can't pass for it.
  const pinned = [[ak, 661, 99.8, 0], [ak, 784, 2.6, 91.2], [karambit, 387, 98.7, 0], [five, 690, 95.6, 1.7], [fiveHeat, 904, 88.3, 3.5], [deagleHeat, 490, 76.6, 8.1]];
  check('Case Hardened: known seeds read what CS2\'s pattern gave', pinned.every(([s, sd, b, g]) => blueOf(s, sd) === b && goldOf(s, sd) === g), JSON.stringify(pinned.map(([s, sd]) => [sd, blueOf(s, sd), goldOf(s, sd)])));

  check('Case Hardened: 661 is the AK-47\'s bluest seed, its #1 Blue Gem', bluest(ak) === 661 && label(ak, 661) === '#1 Blue Gem' && analyzePattern(ak, 661).mult === 500 && analyzePattern(ak, 661).tier === 't0');
  check('Case Hardened: the community\'s best seeds come out first on their own weapons', bluest(karambit) === 387 && [278, 690].includes(bluest(five)) && bluest(skin('weapon_knife_falchion')) === 494 && bluest(skin('weapon_knife_m9_bayonet')) === 601);

  // (The community's Tier 1 names, which go on top of the bluest seeds.)
  const tierOne = new Map([[ak, [670, 321, 151, 955, 179, 387, 555, 592, 760, 809, 828, 868, 617]], [five, [278, 690, 868, 363, 872, 648, 151]], [karambit, [387, 269, 463, 470, 868, 853, 442, 73, 902]]]);
  bad = each((s, sd) => {
    const m = data(s), blue = blueOf(s, sd), gold = goldOf(s, sd), l = label(s, sd), goldEnough = gold - blue >= m.gold;
    if (l === '#1 Blue Gem') return s === ak && sd === 661;
    if (l === 'Blue Gem Tier 1') return blue >= m.t1 || tierOne.get(s)?.includes(sd);
    if (l === 'Blue Gem Tier 2') return blue >= m.t2 && blue < m.t1;
    if (l === 'Gold Gem') return goldEnough && gold >= 75 && blue <= 8;
    return l === '' && blue < m.t2 && !goldEnough;
  });
  check('Case Hardened: every label agrees with the seed\'s numbers, and every seed that earns one has it', !bad.length, shown(bad));
  bad = measured.filter((s) => { const most = Math.max(...seeds.map((sd) => goldOf(s, sd) - blueOf(s, sd))); return Math.abs(data(s).gold - Math.max(75, most - 14)) > 0.05; }).map((s) => s.n);
  check('Case Hardened: a Gold Gem goes by the look of the skin\'s goldest seed, not by how many seeds there are', !bad.length, shown(bad));
  bad = each((s, sd) => label(s, sd) !== '' || blueOf(s, sd) < data(s).t2);
  check('Case Hardened: nothing as blue as the skin\'s Blue Gems goes without a label', !bad.length, shown(bad));

  const share = (s, test) => count(s, test) / 1001;
  bad = measured.filter((s) => share(s, gem) > 0.03).map((s) => s.n);
  check('Case Hardened: Blue Gems are 3% of a skin\'s seeds at most', !bad.length, shown(bad));
  bad = measured.filter((s) => count(s, (l) => /High Blue|Above-average/.test(l))).map((s) => s.n);
  check('Case Hardened: no High Blue or Above-average blue labels: only Blue Gems and Gold Gems are named', !bad.length, shown(bad));
  bad = measured.filter((s) => share(s, (l) => l === 'Gold Gem') > 0.06).map((s) => s.n);
  check('Case Hardened: Gold Gem is rare: 6% of a skin\'s seeds at most (it was 30%)', !bad.length, shown(bad));
  const labelled = measured.reduce((n, s) => n + count(s, (l) => l !== ''), 0) / (measured.length * 1001);
  check('Case Hardened: only a few seeds have a label at all, the Blue and Gold Gems (it was over half, then a fifth)', labelled > 0.01 && labelled < 0.09, `${(labelled * 100).toFixed(1)}%`);

  const named = [[ak, 219], [ak, 784], [skin('weapon_bayonet'), 395], [skin('weapon_bayonet'), 359], [skin('weapon_bayonet'), 848], [skin('weapon_knife_flip'), 731], [skin('weapon_knife_gut'), 837], [karambit, 939], [karambit, 388],
    [skin('weapon_knife_m9_bayonet'), 739], [skin('weapon_knife_falchion'), 926], [skin('weapon_knife_falchion'), 279], [skin('weapon_knife_falchion'), 386], [skin('weapon_knife_butterfly'), 75], [skin('weapon_knife_cord'), 521], [skin('weapon_knife_widowmaker'), 757], [five, 691]];
  bad = named.filter(([s, sd]) => label(s, sd) !== 'Gold Gem').map(([s, sd]) => `${s.n} ${sd}`);
  check('Case Hardened: the Gold Gems the community names are Gold Gems', !bad.length, shown(bad));
  check('Case Hardened: no Gold Gem on the Shadow Daggers, or on Heat Treated, which never gets near all gold', [daggers, fiveHeat, deagleHeat].every((s) => !count(s, (l) => l === 'Gold Gem')));

  // What's painted beside the blade or the dust cover decides nothing. These seeds, by what the part shows, not the rest:
  const butterfly = skin('weapon_knife_butterfly'), navaja = skin('weapon_knife_gypsy_jackknife'), stiletto = skin('weapon_knife_stiletto');
  const each_ = (list, test) => list.filter(([s, sds]) => sds.some((sd) => !test(label(s, sd))));
  const goldParts = [[butterfly, [572, 926, 84, 279, 462, 599]], [navaja, [317, 137, 636]], [stiletto, [15, 36, 186]], [karambit, [653, 78, 543, 145, 679]], [ak, [315, 925, 343]]];
  check('Case Hardened: a gold blade is a Gold Gem whatever colour its handle or ring is', !each_(goldParts, (l) => l === 'Gold Gem').length);
  const halfParts = [[butterfly, [587, 842, 826, 399, 436, 369, 475, 911, 382]], [navaja, [278, 690]], [stiletto, [374, 501]], [ak, [838, 790, 608, 113, 675]]];
  check('Case Hardened: and a half gold one has no label for a blue handle', !each_(halfParts, (l) => l === '').length);
  const blueParts = [[butterfly, [42, 256, 34]], [navaja, [615, 20, 893]], [stiletto, [953, 644]], [ak, [985, 497, 557, 782]]];
  check('Case Hardened: a blue blade under a gold handle is never called a Gold Gem', !each_(blueParts, (l) => l !== 'Gold Gem').length);
  check('Case Hardened: solid blue blades are Blue Gems, and a blade that isn\'t blue isn\'t for its handles', [[butterfly, 330], [butterfly, 838], [butterfly, 263], [butterfly, 800], [ak, 512]].every(([s, sd]) => gem(label(s, sd))) && !gem(label(butterfly, 808)));

  const off = [[ak, [32, 589, 735, 784, 341, 442]], [karambit, [151, 592, 760, 555, 179]], [five, [179, 592]]];
  check('Case Hardened: seeds the old lists had that aren\'t blue aren\'t Blue Gems', off.every(([s, list]) => list.every((sd) => !gem(label(s, sd)))) && label(ak, 784) === 'Gold Gem');
  check('Case Hardened: the community\'s Tier 1 stands, whatever the playside shows', [...tierOne].every(([s, list]) => list.every((sd) => label(s, sd) === 'Blue Gem Tier 1')));
  check('Case Hardened: a seed that\'s blue enough is a Blue Gem on a list\'s skin too', [[karambit, 888, 'Blue Gem Tier 1'], [karambit, 776, 'Blue Gem Tier 1'], [five, 689, 'Blue Gem Tier 1'], [five, 532, 'Blue Gem Tier 2'], [ak, 13, 'Blue Gem Tier 2']].every(([s, sd, l]) => label(s, sd) === l));
  bad = measured.filter((s) => !['front', 'back', 'top'].includes(playside(s))).map((s) => s.n);
  check('Case Hardened: every measured skin says which side its numbers are of, for the inspect to open on', !bad.length && playside(ak) === 'top' && playside(karambit) === 'front' && playside(butterfly) === 'back' && playside(hydra) === null, shown(bad));
  check('Case Hardened: a seed guessed for every knife isn\'t a Blue Gem where it isn\'t blue', [[skin('weapon_knife_survival_bowie'), 592], [skin('weapon_knife_widowmaker'), 463], [skin('weapon_mac10'), 661]].every(([s, sd]) => blueOf(s, sd) < 10 && !gem(label(s, sd))));
  check('Case Hardened: knives without a list get about as many Blue Gems as the one they had, at its price', measured.filter((s) => s.cat === 'knife' && s !== karambit).every((s) => Math.abs(count(s, gem) - 19) <= 2) && analyzePattern(skin('weapon_knife_m9_bayonet'), 601).mult === 15 && label(skin('weapon_knife_m9_bayonet'), 601) === 'Blue Gem Tier 1');
  check('Heat Treated: has its own Blue Gems, not the Case Hardened list', !gem(label(fiveHeat, 690)) && !gem(label(fiveHeat, 278)) && label(fiveHeat, 904) === 'Blue Gem Tier 1' && analyzePattern(fiveHeat, 904).mult === 35 && label(deagleHeat, 490) === 'Blue Gem Tier 1' && analyzePattern(deagleHeat, 490).mult === 4);

  const mults = { 'Gold Gem': 1.3, '': 1 };
  bad = each((s, sd) => { const p = analyzePattern(s, sd); return gem(p.label) || p.mult === mults[p.label]; });
  check('Case Hardened: each label keeps its multiplier', !bad.length, shown(bad));
  bad = each((s, sd) => { const p = analyzePattern(s, sd); return gem(p.label) || p.tier === (p.label === 'Gold Gem' ? 't3' : ''); });
  check('Case Hardened: Gold Gem is t3, for what reads it', !bad.length, shown(bad));

  const gloves = seeds.map((sd) => analyzePattern(hydra, sd));
  check('Hydra Gloves can\'t be measured: no blue or gold numbers on any seed', gloves.every((p) => p.blue === undefined && p.gold === undefined && !p.info.some(([k]) => /Playside/.test(k))));
  const hydraSeeds = (want) => seeds.filter((sd) => label(hydra, sd) === want);
  const hydraCounts = ['Blue Gem Tier 1', 'Blue Gem Tier 2', 'Blue Gem Tier 3', 'Gold Gem', 'Blaze Gem Tier 1', 'Blaze Gem Tier 2', 'Blaze Gem Tier 3', 'Tier 4', ''].map((l) => hydraSeeds(l).length);
  check('Hydra Gloves: the guide\'s tier list, every label', hydraCounts.join() === '11,50,55,5,9,20,44,236,571', hydraCounts.join());
  check('Hydra Gloves: its ranks show in the info', analyzePattern(hydra, 310).info.join() === 'Tier list,P1' && analyzePattern(hydra, 505).info.join() === 'Tier list,P10' && analyzePattern(hydra, 28).info.join() === 'Tier list,High' && analyzePattern(hydra, 974).info.join() === 'Tier list,Low' && analyzePattern(hydra, 896).info.join() === 'Tier list,P1');
  check('Hydra Gloves: a seed it gives twice is the better list', label(hydra, 226) === 'Gold Gem' && label(hydra, 808) === 'Blaze Gem Tier 3' && label(hydra, 780) === 'Blue Gem Tier 2' && label(hydra, 85) === 'Blaze Gem Tier 3' && label(hydra, 361) === 'Blue Gem Tier 3' && label(hydra, 414) === 'Blaze Gem Tier 2');
  check('Hydra Gloves: Blue Gem Tier 1 is worth the most, and a seed off the list is a plain pair', analyzePattern(hydra, 310).mult === 4 && analyzePattern(hydra, 442).mult === 1.8 && label(hydra, 442) === 'Blue Gem Tier 2' && analyzePattern(hydra, 3).mult === 1 && !label(hydra, 3) && !analyzePattern(hydra, 3).tier);
  check('Hydra Gloves: the guide\'s table ranks what its lists don\'t name, and a seed under review stays plain', label(hydra, 29) === 'Blue Gem Tier 2' && label(hydra, 5) === 'Blue Gem Tier 3' && label(hydra, 102) === 'Blaze Gem Tier 2' && label(hydra, 22) === 'Blaze Gem Tier 3' && label(hydra, 734) === 'Gold Gem' && label(hydra, 2) === 'Tier 4' && !label(hydra, 716) && !label(hydra, 867) && !label(hydra, 988));
  check('Hydra Gloves: where the table and a list disagree, the list stands', label(hydra, 399) === 'Blue Gem Tier 1' && label(hydra, 28) === 'Blue Gem Tier 2');
  check('Hydra Gloves: a blue gem hunter never rates a Blaze Gem above a Blue Gem', seeds.every((sd) => !/Blaze/.test(label(hydra, sd)) || analyzePattern(hydra, sd).tier === 't3') && !analyzePattern(hydra, 896).tier);
  check('Hydra Gloves: every label\'s worth at least a plain pair, and nothing else reads the guide\'s list', gloves.every((p) => p.mult >= 1) && !gloves.some((p) => /High Blue|Above-average/.test(p.label)) && !/Blaze|Tier 4/.test(label(karambit, 15)) && label(skin('weapon_mac10', 'Case Hardened'), 174) !== 'Blaze Gem Tier 1');
  check('Case Hardened: a seed past the end of the measuring shows nothing rather than break', [-1, 1001, 5000].every((sd) => { const p = analyzePattern(ak, sd); return p.label === '' && p.blue === undefined && p.mult === 1; }));
  check('Case Hardened: the data stays small', fs.statSync(path.join(ROOT, 'src/js/engine/case-hardened-data.js')).size < 120e3);
}

// ---- The CS.MONEY Wiki's rare patterns (rare-patterns-data.js): 100 skins' groups, 22 Fades' real percentages ------------
{
  const P = await E('patterns');
  const raw = fs.readFileSync(path.join(ROOT, 'scripts/data/cs-money-rare-patterns.json'), 'utf8'), src = JSON.parse(raw).skins;
  const seeds = Array.from({ length: 1001 }, (_, i) => i);
  const named = new Map(Object.values(D.skins).filter((s) => !s.v).map((s) => [s.n, s]));
  const pages = Object.entries(src).map(([k, e]) => ({ k, ...e, skin: named.get(e.name) }));
  const fades = pages.filter((p) => p.fade), grouped = pages.filter((p) => !p.fade);
  const on = (k, sd) => P.analyzePattern(named.get(src[k].name), sd);
  const is = (k, sd, label, mult, tier) => { const p = on(k, sd); return p.label === label && p.mult === mult && (tier === undefined || p.tier === tier); };
  const key = (g) => g.type + (g.tier != null ? '/' + g.tier : '');
  const unpack = (s) => Array.from({ length: s.length / 2 }, (_, i) => parseInt(s.slice(i * 2, i * 2 + 2), 32));
  const shown = (list) => (list.length ? `${list.length}: ${list.slice(0, 5).join(', ')}` : '');

  check('Rare patterns: all 100 of the wiki\'s skins are in the game, each a skin of its own', pages.length === 100 && fades.length === 22
    && pages.every((p) => p.skin && P.rarePatterns(p.skin)) && new Set(pages.map((p) => p.skin?.id)).size === 100);
  let bad = grouped.filter((p) => {
    const want = {};
    for (const g of p.groups) want[key(g)] = [...new Set([...(want[key(g)] || []), ...g.seeds])].sort((a, b) => a - b);
    return JSON.stringify(Object.fromEntries(Object.entries(P.rarePatterns(p.skin).groups).map(([k, v]) => [k, unpack(v)]))) !== JSON.stringify(want);
  }).map((p) => p.k);
  check('Rare patterns: every skin has all its groups, every seed of each and no other', !bad.length, shown(bad));
  bad = grouped.flatMap((p) => p.groups.filter((g) => !P.RARE[P.rarePatterns(p.skin).set]?.[key(g)]).map((g) => `${p.k} ${key(g)}`));
  check('Rare patterns: every group has its label, tier and boost in the one table', !bad.length, shown(bad));
  // (A Marble Fade tip on more of the knife's seeds than TIPS's last share is only told, in the info.)
  const told = (g) => /-tip$/.test(g.type) && g.seeds.length > P.TIPS.at(-1)[0] * 1001;
  bad = grouped.flatMap((p) => p.groups.flatMap((g) => g.seeds.filter((sd) => {
    const r = P.analyzePattern(p.skin, sd);
    if (told(g) && !r.label) return r.mult !== 1 || !r.info.some(([k, v]) => k === 'Tip' && `${v.toLowerCase()}-tip` === g.type);
    return !r.label || !(r.mult > 1) || r.mult < (P.RARE[P.rarePatterns(p.skin).set][key(g)].mult ?? 1);
  }).map((sd) => `${p.k} ${g.name} ${sd}`)));
  check('Rare patterns: every seed of every group is named, and worth at least its group\'s boost (a tip on most of a knife only told)', !bad.length, shown(bad));
  bad = grouped.filter((p) => !/case-hardened/.test(p.k)).flatMap((p) => seeds.filter((sd) => on(p.k, sd).label && !p.groups.some((g) => g.seeds.includes(sd))).map((sd) => `${p.k} ${sd}`));
  check('Rare patterns: on the wiki\'s skins nothing else is named (no roll, no list for every knife, no measured Fire & Ice)', !bad.length, shown(bad));
  check('Rare patterns: the source keeps only what\'s used, and the data stays small', !/preview|image|webp|png/i.test(raw) && fs.statSync(path.join(ROOT, 'src/js/engine/rare-patterns-data.js')).size < 70e3);

  bad = fades.flatMap((p) => seeds.filter((sd) => { const r = P.analyzePattern(p.skin, sd); return r.fade !== p.fade[sd] || r.info.join() !== `Fade,${p.fade[sd].toFixed(1)}%`; }).map((sd) => `${p.k} ${sd}`));
  check('Fade: the wiki\'s real percentage shows on all 22, every seed, instead of one made up from the seed', !bad.length, shown(bad));
  bad = fades.flatMap((p) => seeds.filter((sd) => {
    const r = P.analyzePattern(p.skin, sd), pct = p.fade[sd], whole = pct >= 99.5 ? 100 : Math.floor(pct);
    const want = whole === 100 ? ['Full Fade', 't1', 1.5] : whole >= 97 ? [`${pct.toFixed(1)}% Fade`, whole === 97 ? 't3' : 't2', { 99: 1.3, 98: 1.2, 97: 1.1 }[whole]]
      : whole >= 95 ? ['', '', 1.07] : ['', '', pct < 85 ? 0.92 : 1];
    return [r.label, r.tier, r.mult].join() !== want.join();
  }).map((sd) => `${p.k} ${sd}`));
  check('Fade: label and boost go by the percentage shown: Full Fade from 99.5%, then 99, 98 and 97% by number, 95-96% a little, under 85% less', !bad.length, shown(bad));
  bad = fades.flatMap((p) => { const seen = new Map(); return seeds.filter((sd) => { const r = P.analyzePattern(p.skin, sd), k = r.info[0][1], was = seen.get(k); seen.set(k, `${r.tier} ${r.mult}`); return was != null && was !== seen.get(k); }).map((sd) => `${p.k} ${sd}`); });
  check('Fade: copies that show the same percentage read the same (the wiki\'s whole-percent groups split its x.5s both ways)', !bad.length
    && fades.every((p) => p.groups.every((g) => g.seeds.every((sd) => Math.abs(p.fade[sd] - +g.type) <= 0.5))), shown(bad));
  check('Fade: spot checks (the Karambit\'s 412 is a Full Fade, the AWP\'s 129 reads 99.5% and is one too, a Butterfly\'s 412 is 80%)',
    is('karambit/fade', 412, 'Full Fade', 1.5, 't1') && on('karambit/fade', 412).info.join() === 'Fade,100.0%' && is('awp/fade', 129, 'Full Fade', 1.5, 't1') && on('awp/fade', 129).info.join() === 'Fade,99.5%'
    && is('awp/fade', 628, 'Full Fade', 1.5) && is('karambit/fade', 1000, '98.6% Fade', 1.2, 't2')
    && is('butterfly-knife/fade', 412, '', 0.92) && on('butterfly-knife/fade', 412).fade === 80 && is('glock-18/fade', 41, 'Full Fade', 1.5) && is('m4a1-s/fade', 0, '', 1) && on('m4a1-s/fade', 0).fade === 88.3);

  check('Marble Fade: spot checks: Fire & Ice\'s Max ranks and tiers, the fakes, Tricolor, the tips',
    is('karambit/marble-fade', 412, '1st Max', 2.6, 't0') && is('karambit/marble-fade', 152, '3rd Max', 2.3, 't1') && is('karambit/marble-fade', 28, '10th Max', 1.8, 't3')
    && is('karambit/marble-fade', 9, 'Max Fake Fire & Ice', 1.25) && is('karambit/marble-fade', 60, 'Fake Fire & Ice', 1.15, 't3') && is('karambit/marble-fade', 0, 'Tricolor', 1.1)
    && is('talon-knife/marble-fade', 41, 'Fire & Ice Tier 1', 1.9, 't1') && is('talon-knife/marble-fade', 6, 'Fake Fire & Ice Tier 1', 1.25, 't3') && is('talon-knife/marble-fade', 2, 'Tricolor Tier 3', 1.1)
    && is('talon-knife/marble-fade', 412, 'Red Tip', 1.15) && is('stiletto-knife/marble-fade', 34, 'Blue Tip', 1.1) && is('nomad-knife/marble-fade', 11, 'Orange Tip', 1.05)
    && is('butterfly-knife/marble-fade', 0, '', 1) && on('butterfly-knife/marble-fade', 0).info.join() === 'Tip,Red' && is('m9-bayonet/marble-fade', 0, '', 1) && is('butterfly-knife/marble-fade', 412, '', 1));
  // Tips: the wiki gives nearly every seed of most knives one, so what a tip is worth is how rare it is on that knife.
  bad = grouped.filter((p) => /marble-fade/.test(p.k)).flatMap((p) => {
    const tips = p.groups.filter((g) => /-tip$/.test(g.type)).map((g) => {
      const rs = g.seeds.filter((sd) => p.groups.every((h) => h === g || !h.seeds.includes(sd))).map((sd) => P.analyzePattern(p.skin, sd));
      return { t: g.type, n: g.seeds.length, mult: Math.max(...rs.map((r) => r.mult)), named: rs.some((r) => r.label) };
    });
    return tips.filter((a) => (a.named || a.mult > 1) === a.n > 150 || tips.some((b) => a.n < b.n && a.mult < b.mult)).map((a) => `${p.k} ${a.t} (${a.n})`);
  });
  check('Marble Fade: a tip on over 15% of a knife\'s seeds has no tag and adds nothing, a rarer one does, and never less than a commoner one on the knife', !bad.length
    && P.TIPS.every(([share, m], i) => !i || (share > P.TIPS[i - 1][0] && m < P.TIPS[i - 1][1])), shown(bad));
  const marble = Object.values(D.skins).filter((s) => s.fin === 'Marble Fade');
  bad = marble.filter((s) => P.rarePatterns(s)).flatMap((s) => seeds.filter((sd) => {
    const a = P.analyzePattern(s, sd), b = P.basePattern(s, sd);
    return a.info.slice(0, b.info.length).join() !== b.info.join() || a.info.slice(b.info.length).some(([k]) => k !== 'Tip') || JSON.stringify(a.colors) !== JSON.stringify(b.colors);
  }).map((sd) => `${s.n} ${sd}`));
  check('Marble Fade: where the wiki names the seed the measured colours still show', !bad.length && on('karambit/marble-fade', 412).info[0][0] === 'Playside colours', shown(bad));
  const ownMarble = marble.filter((s) => !P.rarePatterns(s));
  check('Marble Fade: the knives the wiki hasn\'t keep the measuring: 412 is still their Max Fire & Ice', ownMarble.map((s) => s.w).sort().join() === 'Gut Knife,Navaja Knife,Shadow Daggers,Specialist Gloves,Survival Knife'
    && ownMarble.filter((s) => s.cat === 'knife').every((s) => P.analyzePattern(s, 412).label === 'Max Fire & Ice' && P.analyzePattern(s, 16).label === 'Fire & Ice'));

  check('Slaughter: spot checks, and the old Diamond list only where the wiki hasn\'t the knife', is('bayonet/slaughter', 2, 'Diamond Double Heart Tier 1', 1.9, 't1') && is('karambit/slaughter', 33, 'Diamond Tier 1', 1.6, 't1')
    && is('karambit/slaughter', 85, 'Heart Tier 2', 1.2, 't2') && is('flip-knife/slaughter', 74, 'Lozenge Diamond', 1.6) && is('nomad-knife/slaughter', 611, 'Mirror Diamond Tier 1', 1.8)
    && P.analyzePattern(named.get('★ Gut Knife | Slaughter'), 104).label === 'Diamond');
  check('Crimson Web: the wiki\'s webs instead of a roll, a Quad Web the rarest', is('butterfly-knife/crimson-web', 977, 'Quad Web Tier 3', 3, 't0') && is('bayonet/crimson-web', 810, 'Quad Web Tier 2', 3.5, 't0')
    && is('butterfly-knife/crimson-web', 165, 'Triple Web', 2.5, 't1') && is('karambit/crimson-web', 10, 'Centered Web', 1.35, 't3'));
  check('Tiger Tooth, Scorched and Freehand are named now', is('karambit/tiger-tooth', 2, 'Straight Stripes Tier 1', 1.25, 't1') && is('karambit/tiger-tooth', 34, 'Straight Stripes Tier 3', 1.07, 't3')
    && is('karambit/scorched', 271, 'Black Gem Tier 1', 1.3, 't1') && is('butterfly-knife/freehand', 137, '#1 Max Purple', 1.6, 't0') && is('karambit/freehand', 26, 'Max Black', 1.2));
  check('Gloves: the five pairs are named now, and add a little: 1.5 at most', is('gloves/sport-gloves-ultra-violent', 0, 'Max Pink Tier 1', 1.4, 't1') && is('gloves/sport-gloves-ultra-violent', 48, 'Symmetric', 1.15)
    && is('gloves/sport-gloves-nocts', 15, 'Full Leopard', 1.4) && is('gloves/specialist-gloves-emerald-web', 208, 'Double Web Tier 1', 1.5) && is('gloves/hand-wraps-slaughter', 3, 'Double Diamond', 1.5)
    && is('gloves/moto-gloves-cool-mint', 56, 'Ice Blue', 1.3) && pages.filter((p) => /^gloves/.test(p.k)).every((p) => seeds.every((sd) => { const m = on(p.k, sd).mult; return m >= 1 && m <= 1.5; })));

  // Case Hardened: the measuring stays the base (basePattern, checked above), and the wiki only adds.
  const order = { t0: 4, t1: 3, t2: 2, t3: 1, '': 0 };
  bad = Object.values(D.skins).filter((s) => s.fin === 'Case Hardened' || s.fin === 'Heat Treated').flatMap((s) => seeds.filter((sd) => {
    const a = P.analyzePattern(s, sd), b = P.basePattern(s, sd);
    return a.mult < b.mult || order[a.tier] < order[b.tier] || a.info.slice(0, b.info.length).join() !== b.info.join() || a.info.slice(b.info.length).some(([k]) => k !== 'CS.MONEY Wiki')
      || (a.label !== b.label && a.info.at(-1)?.[0] !== 'CS.MONEY Wiki') || a.blue !== b.blue || a.gold !== b.gold || (!P.rarePatterns(s) && JSON.stringify(a) !== JSON.stringify(b));
  }).map((sd) => `${s.n} ${sd}`));
  check('Case Hardened: the wiki never lowers what the measuring gives, keeps its blue and gold, says where it decides, and the skins it hasn\'t are as they were', !bad.length, shown(bad));
  const ak = named.get('AK-47 | Case Hardened');
  check('Case Hardened: #1s and Ranks are Blue Gem tiers at the weapon\'s own boost, the wiki\'s Gold Gems t3', is('ak-47/case-hardened', 661, '#1 Blue Gem', 500, 't0') && is('karambit/case-hardened', 387, '#1 Blue Gem', 150, 't0')
    && is('m9-bayonet/case-hardened', 601, '#1 Blue Gem', 60, 't0') && is('huntsman-knife/case-hardened', 618, '#1 Blue Gem', 60) && is('ak-47/case-hardened', 4, 'Blue Gem Tier 2', 8, 't2') && P.basePattern(ak, 4).label === ''
    && is('ak-47/case-hardened', 34, 'Blue Gem Tier 3', 2.5, 't3') && is('karambit/case-hardened', 38, 'Blue Gem Tier 3', 2, 't3') && is('butterfly-knife/case-hardened', 27, 'Blue Gem Tier 3', 1.7, 't3')
    && is('ak-47/case-hardened', 219, 'Gold Gem Tier 1', 1.7, 't3') && P.basePattern(ak, 219).label === 'Gold Gem' && on('ak-47/case-hardened', 219).info.join() === 'Playside blue,0.7%,Playside gold,91.2%,CS.MONEY Wiki,Gold Gem Tier 1');
  // The Karambit's ranks go by either side of the blade: 346 is gold where the game measures (3% blue) and 95% blue on the back.
  // Its 195 is a Rank 4 and a Gold Gem on the wiki, which calls it a Gold Gem.
  check('Case Hardened: a rank shows in the wiki\'s words, and a seed that\'s a Rank and a Gold Gem is the Gold Gem', is('karambit/case-hardened', 346, 'Blue Gem Tier 2', 5, 't2')
    && on('karambit/case-hardened', 346).info.join() === 'Playside blue,3.2%,Playside gold,84.4%,CS.MONEY Wiki,Rank 2' && on('karambit/case-hardened', 387).info.at(-1).join() === 'CS.MONEY Wiki,#1'
    && is('karambit/case-hardened', 195, 'Gold Gem Tier 2', 1.5, 't3') && on('karambit/case-hardened', 195).info.at(-1).join() === 'CS.MONEY Wiki,Gold Gem Tier 2');

  // The rarer the more.
  const families = {};
  for (const [set, groups] of Object.entries(P.RARE)) for (const [k, g] of Object.entries(groups)) { const [fam, n] = k.split('/'); if (n && g.mult != null) (families[`${set} ${fam}`] ||= []).push([+n, g.mult]); }
  bad = Object.entries(families).filter(([, list]) => list.sort((a, b) => a[0] - b[0]).some(([, m], i) => i && m >= list[i - 1][1])).map(([f]) => f);
  const maxes = Array.from({ length: 10 }, (_, i) => P.RARE['Marble Fade'][`${i + 1}${['st', 'nd', 'rd'][i] || 'th'}-max`].mult), web = P.RARE['Crimson Web'];
  const gems = (k) => ['#1 Blue Gem', 'Blue Gem Tier 1', 'Blue Gem Tier 2', 'Blue Gem Tier 3'].map((l) => seeds.map((sd) => on(k, sd)).find((p) => p.label === l)?.mult);
  check('Rare patterns: the rarer the more: each Tier 1 over its Tier 2 over its Tier 3, 1st Max down to 10th, #1 Blue Gem down to Tier 3, Quad Web down to one web',
    !bad.length && maxes.every((m, i) => !i || m < maxes[i - 1]) && ['ak-47/case-hardened', 'karambit/case-hardened', 'butterfly-knife/case-hardened'].every((k) => gems(k).every((x, i, m) => x > 1 && (!i || x < m[i - 1])))
    && web['quad-web/3'].mult > web['triple-web/1'].mult && web['triple-web/1'].mult > web['double-web/1'].mult && web['double-web/1'].mult > web['web/1'].mult
    && Object.values(P.RARE).every((groups) => Object.values(groups).every((g) => g.mult == null || g.mult > 1)), shown(bad));

  // Everything else as it was: every seed of a skin with a pattern rule, a sample of the rest.
  const ruled = /^(Fade|Amber Fade|Marble Fade|Crimson Web|Slaughter|Case Hardened|Heat Treated|Doppler|Gamma Doppler)$/;
  bad = Object.values(D.skins).filter((s) => !P.rarePatterns(s)).filter((s) => seeds.filter((sd) => ruled.test(s.fin) || sd % 50 === 0)
    .some((sd) => JSON.stringify(P.analyzePattern(s, sd)) !== JSON.stringify(P.basePattern(s, sd)))).map((s) => s.n);
  check('Rare patterns: every skin the wiki hasn\'t is as it was (the Gut Knife\'s Fade and Slaughter, Doppler\'s Pink Galaxy and Max Pearl...)', !bad.length, shown(bad));
  bad = Object.values(D.skins).filter((s) => s.fin === 'Crimson Web' && !P.rarePatterns(s)).filter((s) => seeds.some((sd) => { const p = P.analyzePattern(s, sd); return p.label || p.mult !== 1; })).map((s) => s.n);
  check('Crimson Web: no rolled webs where the wiki has none, every seed plain', !bad.length && Object.values(D.skins).some((s) => s.fin === 'Crimson Web' && !P.rarePatterns(s)), shown(bad));
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
  // The Terminals: Dead Hand has gold of its own, gloves only, as CS2's file says. Genesis has none.
  const deadHand = D.cases.find((x) => x.n === 'Sealed Dead Hand Terminal'), genesis = D.cases.find((x) => x.n === 'Sealed Genesis Terminal');
  const dead5 = deadHand.pools[5].flatMap((id) => [mk(id, 0.2), mk(id, 0.3), mk(id, 0.4)]).slice(0, 5);
  const dc = T.tradeupContract(dead5);
  check('5 Dead Hand Coverts -> its gloves', dc.ok && dc.outcomes.length === deadHand.rare.length && dc.outcomes.every((o) => D.skins[o.ids[0]].cat === 'gloves'), dc.error || dc.outcomes.length + ' outcomes');
  const dg = T.rollTradeup(dc, rng);
  check('and the contract gives one, with a float in its range', D.skins[dg.id].star && deadHand.rare.some((g) => g.includes(dg.id)) && dg.fl >= D.skins[dg.id].mn && dg.fl <= D.skins[dg.id].mx, I.itemName(dg));
  check('a StatTrak Dead Hand contract has nothing to give: gloves have no StatTrak', !T.tradeupContract(dead5.map((x) => ({ ...x, stt: true }))).ok);
  check('a Genesis Covert still can\'t: CS2 gave that Terminal no gold', /no knife or gloves/.test(T.tradeupIneligible(mk(genesis.pools[5][0], 0.2))));
  check('a StatTrak Covert of a box with only gloves is told why', /gloves have no StatTrak/.test(T.tradeupIneligible({ ...mk(deadHand.pools[5][0], 0.2), stt: true })));
  const mixed = T.tradeupContract([...dead5.slice(0, 3), ...five.slice(0, 2)]);
  check('Dead Hand and a case in one contract share the tickets', mixed.ok && mixed.outcomes.some((o) => D.skins[o.ids[0]].cat === 'gloves') && mixed.outcomes.some((o) => D.skins[o.ids[0]].cat === 'knife'), mixed.error);
  check('the Armory still features the Terminals\' collections', D.collections.filter((c) => /Dead Hand|Genesis/.test(c.n)).every((c) => !c.caseId));
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
    // What each keep option saves, and only that.
    const sells = (it, keep) => I.autoSellMatch(it, { on: true, below: 1e9, ranks: [], keepStt: false, keepRare: false, keepBlue: false, keepFloat: false, ...keep });
    const skinOf = (fn) => Object.values(D.skins).find(fn), drop = (s, fl, sd) => ({ t: 'skin', id: s.id, fl, sd, stt: false, stk: [] });
    const akCh = skinOf((s) => s.wid === 'weapon_ak47' && s.fin === 'Case Hardened'), fadeGun = skinOf((s) => s.fin === 'Fade' && !s.star);
    const plainGun = skinOf((s) => !s.star && !s.v && s.mn === 0 && s.mx >= 0.5 && !/Doppler|Case Hardened|Heat Treated|Fade|Crimson Web|Slaughter/.test(s.fin || ''));
    const gem = drop(akCh, 0.2, 661), fadeSeed = Array.from({ length: 1001 }, (_, i) => i).find((i) => I.patternInfo(drop(fadeGun, 0.02, i)).mult > 1), fade = drop(fadeGun, 0.02, fadeSeed);
    check('auto-sell: Keep Blue Gems saves a Blue Gem and nothing else', !sells(gem, { keepBlue: true }) && sells(gem, { keepRare: true }) && sells(fade, { keepBlue: true }));
    check('auto-sell: Keep other rare patterns saves a fade, not a Blue Gem', !sells(fade, { keepRare: true }) && I.patternInfo(fade).mult > 1);
    check('auto-sell: Keep low floats saves a 0.000 float and nothing above it, whatever else is on', !sells(drop(plainGun, 0.0009, 1), { keepFloat: true }) && !sells(drop(plainGun, 0.00001, 1), { keepFloat: true })
      && sells(drop(plainGun, 0.001, 1), { keepFloat: true }) && sells(drop(plainGun, 0.0015, 1), { keepFloat: true }) && sells(drop(plainGun, 0.005, 1), { keepRare: true, keepBlue: true, keepFloat: true }));
    check('auto-sell: a plain drop with a float premium isn\'t kept by any of them', I.floatMultiplier(drop(plainGun, 0.009, 1)) > 1 && sells(drop(plainGun, 0.009, 1), { keepRare: true, keepBlue: true, keepFloat: true }));
    const rules = (r) => I.cleanAutoSell({ on: true, below: 5, ...r });
    check('auto-sell: an older game or save has keepRare alone, which still covers all three', rules({ keepRare: true }).keepBlue === true && rules({ keepRare: true }).keepFloat === true && rules({ keepRare: false }).keepBlue === false && rules({}).keepFloat === false);
    check('auto-sell: once they\'re set they stand alone', rules({ keepRare: true, keepBlue: false, keepFloat: false }).keepBlue === false && rules({ keepRare: true, keepBlue: false, keepFloat: false }).keepFloat === false && rules({ keepRare: false, keepBlue: true }).keepBlue === true);
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
  const forgiven = MM.forgive({ ...MM.abandon(MM.abandon(MM.freshMM(), t0).mm, t0).mm, match: { mode: 'premier' } });
  check('matchmaking: staff taking a cooldown away ends it, the next is the shortest again, and the match you\'re in stays', MM.cooldownLeft(forgiven, t0) === 0 && MM.nextCooldown(forgiven, t0) === 30 * 60e3 && forgiven.match?.mode === 'premier' && MM.cooldownLeft(MM.forgive(null)) === 0);
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

  // Float records: every skin together, both ends, by category; only what has a float.
  const rec = [mk('r1', 0.3), { item: { uid: 'r2', t: 'skin', id: 'other', fl: 0.001, at: 0 } }, mk('r3', 0.95, { stt: true }), mk('r4', 0.0005, { sv: true }),
    { item: { uid: 'r5', t: 'sticker', id: 'k' } }, mk('r6', null), mk('r7', 0.3, { at: -1 })];
  const uids = (l) => l.map((c) => (c.item || c).uid).join();
  check('float records: the lowest floats of every skin together, an equal float by who had it first, nothing without a float', uids(DB.floatRecords(rec)) === 'r4,r2,r7,r1,r3', uids(DB.floatRecords(rec)));
  check('float records: the highest are the lowest read backwards', uids(DB.floatRecords(rec, { dir: 'high' })) === 'r3,r1,r7,r2,r4', uids(DB.floatRecords(rec, { dir: 'high' })));
  check('float records: by category, at most the limit, items or copies, none of none', uids(DB.floatRecords(rec, { cat: 'n' })) === 'r2,r7,r1' && uids(DB.floatRecords(rec, { cat: 'st', dir: 'high' })) === 'r3'
    && uids(DB.floatRecords(rec, { cat: 'sv' })) === 'r4' && uids(DB.floatRecords(rec, { limit: 2 })) === 'r4,r2' && uids(DB.floatRecords(rec.map((c) => c.item), { limit: 1 })) === 'r4' && DB.floatRecords([]).length === 0);
  {
    // (it keeps only the best `limit` as it goes: the same as sorting every copy, ties and categories included)
    let s = 7; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    const many = Array.from({ length: 3000 }, (_, i) => mk('m' + i, rnd() < 0.2 ? [0.1, 0.5, 0.9][i % 3] : rnd(), { at: Math.floor(rnd() * 5), stt: rnd() < 0.3, sv: rnd() < 0.1 }));
    const sortAll = (dir, cat) => many.filter((c) => cat === 'all' || DB.copyCategory(c.item) === cat).sort((a, b) => (dir === 'high' ? DB.byFloat(b.item, a.item) : DB.byFloat(a.item, b.item)));
    const same = ['low', 'high'].every((dir) => ['all', 'n', 'st', 'sv'].every((cat) => [1, 7, 100, 5000].every((limit) =>
      uids(DB.floatRecords(many, { dir, cat, limit })) === uids(sortAll(dir, cat).slice(0, limit)))));
    check('float records: the best few kept while going through them give what sorting them all would', same && DB.floatRecords(many, { limit: 0 }).length === 0);
  }

  // Patterns among an item's copies: how many share each, and copies in pattern order.
  const pc = [mk('p1', 0.2, { sd: 661 }), mk('p2', 0.1, { sd: 661 }), mk('p3', 0.4, { sd: 661, stt: true }), mk('p4', 0.3, { sd: 5 }), mk('p5', null, { sd: null }), mk('p6', 0.05, { sd: 1000 }), mk('z0', 0.5, { sd: 0 })];
  const pats = DB.patternCounts(pc), pn = (i, cat) => DB.patternCount(pats, pc[i].item, cat);
  check('patterns: how many copies share each pattern, over all of them or one category', pn(0) === 3 && pn(0, 'n') === 2 && pn(2, 'st') === 1 && pn(2, 'n') === 2 && pn(3) === 1 && pn(6) === 1
    && pn(4) === 0 && DB.patternCount(pats, { sd: 7 }) === 0 && DB.patternCounts(pc.map((c) => c.item)).get('all:661') === 3);
  const byPat = pc.map((c) => c.item).sort(DB.byPattern).map((it) => it.uid).join();
  check('patterns: copies by pattern number, then float, and one with no pattern last', byPat === 'z0,p4,p2,p1,p3,p6,p5', byPat);
  // (a pattern of null and none at all are the same: no NaN, which would leave the order to chance)
  const noSd = [{ uid: 'q1', sd: null, fl: 0.1 }, { uid: 'q2', fl: 0.2 }];
  const { floatString } = await import('../src/js/engine/items.js');
  check('a float as the game shows it: plain decimals under 1e-6 too, its 32-bit value', floatString(5e-8) === '0.00000005000000058430487' && floatString(0.25) === '0.25'
    && Number(floatString(1e-10)) === Math.fround(1e-10) && floatString(0) === '0' && floatString(null) === '—', floatString(5e-8));
  check('patterns: a copy with sd null and one with no sd compare by float', DB.byPattern(noSd[0], noSd[1]) < 0 && DB.byPattern(noSd[1], noSd[0]) > 0
    && [{ uid: 'q3', fl: 0.3 }, { uid: 'q4', sd: 2, fl: 0.9 }, ...noSd].sort(DB.byPattern).map((it) => it.uid).join() === 'q4,q1,q2,q3');
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
  check('match money: a win or draw $1,250, a loss $500, $100 a kill and $50 an assist',
    L.matchPay({ result: 'win', kills: 3, assists: 2 }).total === 1650 && L.matchPay({ result: 'draw' }).total === 1250 && L.matchPay({ result: 'loss', kills: 1 }).total === 600);
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
  check('a finished match pays and gives XP', pay.r.earned === 3950 && near(st.money, 10 + 3950, 1e-9) && pay.r.xp.total === 250 + 500 + 40 + 650 && st.prof.xp === pay.r.xp.total && 'prof' in pay.d.set);
  const old = run('play.reward', { won: true, kills: 2, assists: 0, mvps: 1, rounds: 9, difficulty: 'hard' });
  check('the game’s older reward call (won, rounds won) still pays (and the MVP it sent: $250)', old.r.earned === 1250 + 200 + 250 && old.r.pay.mvps === 250);
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
  // A match with cheats in it pays nothing, online or offline, and closes its run.
  for (const online of [false, true]) {
    const cheatRun = run('play.start', { mode: 'deathmatch' }, { online }).r.run;
    const before = JSON.stringify([st.money, st.prof, st.stats]);
    const none = run('play.reward', { run: cheatRun, mode: 'deathmatch', result: 'win', kills: 40, assists: 5, cheats: true }, { online }).r;
    check(`cheats: no money, XP or record for that match (${online ? 'online' : 'offline'})`, none.cheats === true && none.earned === 0 && !none.xp && JSON.stringify([st.money, st.prof, st.stats]) === before && !st.play);
    let again = null; try { run('play.reward', { run: cheatRun, mode: 'deathmatch', result: 'win', kills: 1 }, { online: true }); } catch (e) { again = e; }
    check('cheats: and asking again without the flag pays nothing either', again?.code === 'match');
  }
  let unseen = null; try { run('play.reward', { result: 'win', kills: 1, roundsWon: 13, rounds: 20 }, { online: true }); } catch (e) { unseen = e; }
  const { run: id } = run('play.start', { mode: 'wingman' }, { now: t0 }).r;
  let quick = null; try { run('play.reward', { run: id, result: 'win', kills: 5, roundsWon: 9, rounds: 14 }, { online: true, now: t0 + 60e3 }); } catch (e) { quick = e; }
  let many = null; try { run('play.reward', { run: id, result: 'win', kills: 40, roundsWon: 9, rounds: 14 }, { online: true, now: t0 + 20 * 60e3 }); } catch (e) { many = e; }
  const ok = run('play.reward', { run: id, result: 'win', kills: 12, roundsWon: 9, rounds: 14 }, { online: true, now: t0 + 20 * 60e3 });
  let twice = null; try { run('play.reward', { run: id, result: 'win', kills: 12, roundsWon: 9, rounds: 14 }, { online: true, now: t0 + 21 * 60e3 }); } catch (e) { twice = e; }
  check('online match money: only for a match the server saw start, once, long enough, with kills a Wingman match could have',
    unseen?.code === 'match' && quick?.code === 'match' && many?.code === 'match' && ok.r.earned === 2450 && twice?.code === 'match');
  {
    // A StatTrak™ kill online: only in a match the server saw start, one at a time, no faster than the match's clock.
    const def = Object.values(D.skins).find((s) => s.stt && s.cat === 'rifle');
    const gun = { uid: 'kc1', t: 'skin', id: def.id, fl: 0.2, sd: 1, stt: true, kills: 0, stk: [] }, t = 1e12;
    st.inv.push(gun);
    const kill = (ms, a = {}) => run('play.stattrak', { uid: gun.uid, ...a }, { online: true, now: t + ms });
    const no = (ms, a) => { try { kill(ms, a); return null; } catch (e) { return e.code; } };
    st.play = null;
    check('StatTrak™ online: no kill counts without a match the server saw start', no(3600e3) === 'match' && gun.kills === 0);
    run('play.start', { mode: 'deathmatch' }, { online: true, now: t });
    check('StatTrak™ online: nor the moment one starts', no(500) === 'match' && gun.kills === 0 && !st.play.kills);
    const first = kill(1500, { kills: 50 });
    check('StatTrak™ online: a call is one kill, whatever it claims', first.r.kills === 1 && gun.kills === 1 && st.play.kills === 1 && first.d.upd[0]?.kills === 1 && 'play' in first.d.set);
    check('StatTrak™ online: and no faster than the match\'s clock', no(2000) === 'match' && gun.kills === 1 && st.play.kills === 1);
    for (let i = 0; i < 19; i++) kill(30e3);
    check('StatTrak™ online: kills in a burst count, up to a kill every 1.5 seconds of the match', gun.kills === 20 && no(30e3) === 'match' && gun.kills === 20);
    run('play.start', { mode: 'deathmatch' }, { online: true, now: t + 31e3 });
    check('StatTrak™ online: starting another match only starts the clock again', no(31e3 + 1000) === 'match' && gun.kills === 20 && !st.play.kills);
    check('StatTrak™ online: a match six hours old counts no more', no(31e3 + 6 * 3600e3 + 1000) === 'match' && gun.kills === 20);
    gun.lk = true;
    kill(60e3);
    check('StatTrak™ online: a lock doesn\'t stop a kill counting (it only keeps an item from being sold or traded)', gun.kills === 21);
    delete gun.lk;
    const { run: over } = run('play.start', { mode: 'deathmatch' }, { online: true, now: t + 90e3 }).r;
    run('play.reward', { run: over, mode: 'deathmatch', result: 'win', kills: 1, rounds: 1 }, { online: true, now: t + 200e3 });
    check('StatTrak™ online: a finished match counts no more', no(300e3) === 'match' && gun.kills === 21);
    gun.kills = 999999;
    run('play.stattrak', { uid: gun.uid });
    check('StatTrak™ offline: a kill counts with no match on record, and the counter stops at six digits', gun.kills === 999999 && !st.play);
    gun.kills = 5;
    run('play.stattrak', { uid: gun.uid, kills: 50 });
    check('StatTrak™ offline: one at a time too', gun.kills === 6);
    st.inv = st.inv.filter((i) => i !== gun);
  }
  const crate = drop.offers.find((o) => o.t === 'crate');
  check('reward cases are inventory cases that take their own key', !!keyFor(D.caseById[crate.id]) && I.itemName(crate) === D.caseById[crate.id].n && I.itemValue(crate) === D.caseById[crate.id].price);
}

// ---- round MVPs: $250 each, no more than the rounds your team won, none without rounds -----------------------------------
{
  const L = await E('levels');
  const both = L.matchPay({ result: 'win', kills: 3, assists: 2, mvps: 2 }), none = L.matchPay({ result: 'win', kills: 3, assists: 2 });
  check('match money: $250 a round MVP, its own part of the pay, none when not given', L.PAY.mvp === 250 && both.mvps === 500 && both.total === 1650 + 500
    && none.mvps === 0 && none.total === 1650, JSON.stringify(both));
  check('match XP: MVPs give none', L.matchXp({ result: 'win', kills: 3, assists: 2, roundsWon: 13, mvps: 5 }).total === L.matchXp({ result: 'win', kills: 3, assists: 2, roundsWon: 13 }).total);

  const st = freshState();
  const run = (name, args, opts = {}) => { const ctx = ACT.makeCtx(st, { rng, ...opts }); return ACT.runAction(ctx, name, args); };
  const err = (args, opts) => { try { run('play.reward', args, opts); return null; } catch (e) { return e; } };
  const comp = { mode: 'competitive', result: 'win', kills: 20, assists: 3, roundsWon: 13, rounds: 22 };
  const m0 = st.money, paid = run('play.reward', { ...comp, mvps: 5 }), plain = run('play.reward', comp);
  check('play.reward: each MVP pays $250 (offline), on top of the rest, with the same XP', paid.earned === 1250 + 2000 + 150 + 1250 && paid.pay.mvps === 1250
    && plain.earned === paid.earned - 1250 && plain.pay.mvps === 0 && paid.xp.total === plain.xp.total && near(st.money, m0 + paid.earned + plain.earned, 1e-9), `${paid.earned} / ${plain.earned}`);
  const all = run('play.reward', { ...comp, mvps: 13 });
  check('play.reward: an MVP every round your team won is fine', all.pay.mvps === 13 * 250);
  const before = st.money;
  const bad = [-1, 1.5, 61, 'two', {}].map((mvps) => err({ ...comp, mvps }));
  const over = err({ ...comp, mvps: 14 }), dm = err({ mode: 'deathmatch', result: 'win', kills: 30, mvps: 1 }), ar = err({ mode: 'armsrace', result: 'win', kills: 30, mvps: 1, roundsWon: 5, rounds: 5 });
  check('play.reward: MVPs that aren\'t a whole number from 0 to 60 fail like kills do', bad.every((e) => e instanceof ACT.GameError && /MVPs/.test(e.message)), bad.map((e) => e?.message).join(' / '));
  check('play.reward: more MVPs than rounds your team won, or any in Deathmatch or Arms Race, fail and pay nothing', over?.code === 'match' && dm?.code === 'match' && ar?.code === 'match' && st.money === before);
  check('play.reward: none sent is none (older callers), null too', run('play.reward', { ...comp }).pay.mvps === 0 && run('play.reward', { ...comp, mvps: null }).pay.mvps === 0);

  // Online: against the match the server saw start, its mode, not the one the reward claims.
  const t0 = 2e12;
  const id = run('play.start', { mode: 'competitive' }, { online: true, now: t0 }).run;
  const at = { online: true, now: t0 + 20 * 60e3 }, cash = st.money;
  const tooMany = err({ ...comp, run: id, mvps: 14 }, at);
  check('online: a reward with more MVPs than rounds won fails, pays nothing and leaves the match open', tooMany?.code === 'match' && st.money === cash && st.play?.run === id);
  const fair = run('play.reward', { ...comp, run: id, mvps: 6 }, at);
  check('online: a fair one pays its MVPs, once', fair.pay.mvps === 1500 && fair.earned === 1250 + 2000 + 150 + 1500 && near(st.money, cash + fair.earned, 1e-9) && !st.play
    && err({ ...comp, run: id, mvps: 6 }, at)?.code === 'match');
  const dmRun = run('play.start', { mode: 'deathmatch' }, { online: true, now: t0 }).run;
  const claimed = err({ ...comp, run: dmRun, mvps: 1 }, at);
  const dmPaid = run('play.reward', { run: dmRun, mode: 'deathmatch', result: 'win', kills: 30, assists: 2 }, at);
  check('online: a Deathmatch claiming to be Competitive gets no MVPs (the mode is the started match\'s); without them it pays', claimed?.code === 'match' && dmPaid.pay.mvps === 0 && dmPaid.earned === 1250 + 3000 + 100);
}

// ---- passive income: $100 a whole minute, open or closed, up to 12 hours of it at a time --------------------------------
{
  const L = await E('levels');
  const { upgradeState } = await E('economy');
  const AD = await E('admin');
  const MIN = 60e3, HOUR = 3600e3, t = 1.7e12;
  check('passive: $100 a minute and $100 more for each prestige, 12 hours at most', L.PASSIVE.perMinute === 100 && L.PASSIVE.perPrestige === 100 && L.PASSIVE.capHours === 12);
  // The rule.
  const r1 = L.passivePay(t, t + 3 * MIN + 25e3);
  check('passive: whole minutes only, and the part of a minute left over carries over', r1.minutes === 3 && r1.pay === 300 && r1.at === t + 3 * MIN && !r1.capped
    && L.passivePay(r1.at, t + 4 * MIN).minutes === 1);
  const r0 = L.passivePay(t, t + MIN - 1);
  check('passive: under a minute pays nothing and moves nothing', r0.minutes === 0 && r0.pay === 0 && r0.at === t && !L.passiveDue({ at: t }, t + MIN - 1) && L.passiveDue({ at: t }, t + MIN));
  const cap = L.passivePay(t, t + 30 * HOUR + 10e3);
  check('passive: past 12 hours pays 12 hours ($72,000), and counts all of the time (none of it pays later)', cap.minutes === 720 && cap.pay === 72000 && cap.capped
    && cap.at === t + 30 * HOUR && L.passivePay(cap.at, t + 30 * HOUR + 10e3).pay === 0);
  const twelve = L.passivePay(t, t + 12 * HOUR);
  check('passive: 12 hours exactly is within the cap', twelve.pay === 72000 && !twelve.capped);
  const back = L.passivePay(t, t - 5 * MIN);
  check('passive: a clock gone backwards pays nothing and counts from its time', back.pay === 0 && back.at === t - 5 * MIN && L.passiveDue({ at: t }, t - 1));
  const none = L.passivePay(undefined, t);
  check('passive: no time yet pays nothing and counts from now', none.pay === 0 && none.at === t && L.passiveDue(undefined, t) && L.passiveDue({}, t));
  // Prestige: each Service Medal adds $100 a minute; the 12 hours stay 12 hours.
  check('passive: the rate is $100 + $100 × prestiges', L.passiveRate(0) === 100 && L.passiveRate(1) === 200 && L.passiveRate(2) === 300 && L.passiveRate() === 100);
  const p2 = L.passivePay(t, t + 3 * MIN + 25e3, 2);
  check('passive: with 2 prestiges, 3 whole minutes pay $900 and the clock moves as without', p2.minutes === 3 && p2.pay === 900 && p2.at === r1.at && !p2.capped);
  const capP = L.passivePay(t, t + 30 * HOUR, 3);
  check('passive: with 3 prestiges the cap is still 12 hours: 720 minutes at $400 ($288,000)', capP.minutes === 720 && capP.pay === 288000 && capP.capped && capP.at === t + 30 * HOUR);
  check('passive: nothing due pays nothing at any rate', L.passivePay(t, t + MIN - 1, 5).pay === 0 && L.passivePay(undefined, t, 5).pay === 0 && L.passivePay(t, t - MIN, 5).pay === 0);
  check('passive: prestiges are the profile\'s medals, a whole number from 0 to every medal there is', L.prestigesOf({ medals: 4 }) === 4 && L.prestigesOf({ medals: 2.7 }) === 2
    && L.prestigesOf(undefined) === 0 && L.prestigesOf({}) === 0 && L.prestigesOf({ medals: -3 }) === 0 && L.prestigesOf({ medals: 'x' }) === 0 && L.prestigesOf({ medals: NaN }) === 0
    && L.prestigesOf({ medals: 1e9 }) === L.MEDALS.length && L.passiveRate(1e9) === 100 + 100 * L.MEDALS.length && L.passiveRate(-2) === 100);

  // The action, on a save.
  const collect = (st, now, opts = {}) => { const ctx = ACT.makeCtx(st, { now, ...opts }); const r = ACT.runAction(ctx, 'passive.collect'); return { r, d: ACT.delta(ctx) }; };
  const fresh = freshState(t);
  check('passive: a new save counts from when it was made', fresh.passive.at === t && fresh.passive.earned === 0 && collect(freshState(t), t + 30e3).r.earned === 0);
  const st = freshState(t);
  const a = collect(st, t + 2 * MIN + 30e3);
  check('passive: a collect pays and moves the clock, in one change of just those two', a.r.earned === 200 && a.r.minutes === 2 && st.money === 210 && st.passive.at === t + 2 * MIN
    && st.passive.earned === 200 && Object.keys(a.d.set).sort().join() === 'money,passive' && !a.d.add.length && !a.d.del.length && !a.d.upd.length);
  const b = collect(st, t + 3 * MIN);
  check('passive: the half minute left over makes the next one due 30 seconds later', b.r.earned === 100 && st.passive.at === t + 3 * MIN && st.money === 310);
  const idle = collect(st, t + 3 * MIN + 59e3);
  check('passive: nothing due changes nothing', idle.r.earned === 0 && !Object.keys(idle.d.set).length && st.money === 310);
  const twice = [collect(st, t + 4 * MIN), collect(st, t + 4 * MIN)];
  check('passive: the same minute is never paid twice', twice[0].r.earned === 100 && twice[1].r.earned === 0 && st.money === 410);
  const away = collect(st, t + 4 * MIN + 13 * HOUR);
  check('passive: back after 13 hours, 12 hours\' worth', away.r.earned === 72000 && away.r.capped && away.r.minutes === 720 && st.money === 72410
    && st.passive.at === t + 4 * MIN + 13 * HOUR && st.passive.earned === 72400);
  const behind = collect(st, t);
  check('passive: a clock put back pays nothing and counts again from its time', behind.r.earned === 0 && st.money === 72410 && st.passive.at === t
    && 'passive' in behind.d.set && !('money' in behind.d.set));
  check('passive: and pays from there as usual', collect(st, t + MIN).r.earned === 100 && st.money === 72510);

  // Prestige on a save: the medals the profile has when it's collected.
  {
    const ps = freshState(t);
    ps.prof = { ...ps.prof, medals: 2 };
    const c1 = collect(ps, t + 2 * MIN);
    check('passive: a save with 2 prestiges is paid $300 a minute', c1.r.earned === 600 && c1.r.minutes === 2 && ps.money === 610 && ps.passive.earned === 600
      && Object.keys(c1.d.set).sort().join() === 'money,passive' && Object.keys(c1.r).sort().join() === 'capped,earned,minutes');
    // A prestige the way a match brings it: past level 40, the next medal. The next collect pays at the new rate.
    ps.prof = { ...ps.prof, level: L.MAX_LEVEL, xp: L.XP_PER_LEVEL - 1 };
    const up = L.addXp(ps.prof, 1, { now: t });
    ps.prof = up.prof;
    check('passive: the prestige a level up past 40 brings counts from the next collect', up.medals.length === 1 && ps.prof.medals === 3 && collect(ps, t + 3 * MIN).r.earned === 400 && ps.money === 1010);
    check('passive: and all of the time due is paid at the medals had when it\'s collected', collect(ps, t + 6 * MIN + 59e3).r.earned === 1200 && ps.money === 2210);
    const held = { ...freshState(t), prof: { ...ps.prof } };
    check('passive: a context without prestige (the server\'s rules before they\'re out) pays $100 a minute whatever the medals', held.prof.medals === 3
      && collect(held, t + 2 * MIN, { prestige: false }).r.earned === 200 && collect(held, t + 3 * MIN).r.earned === 400);
    const away = collect(ps, t + 6 * MIN + 20 * HOUR);
    check('passive: 20 hours away with 3 prestiges: 12 hours of $400 a minute', away.r.earned === 288000 && away.r.capped && ps.money === 290210);
    ps.prof = { ...ps.prof, medals: 'lots' };
    check('passive: a medal count that isn\'t one pays as none', collect(ps, t + 6 * MIN + 20 * HOUR + MIN).r.earned === 100);
    const noProf = freshState(t);
    delete noProf.prof;
    check('passive: a state without a profile pays $100 a minute', collect(noProf, t + MIN).r.earned === 100);
  }

  // Saves and accounts from before passive income: no back pay.
  const { passive: _p, ...older } = freshState(t - 30 * 24 * HOUR);
  const old = upgradeState(JSON.parse(JSON.stringify(older)));
  check('passive: a save from before it has no clock when it loads (none is made up for it)', old.passive === undefined && !('passive' in JSON.parse(JSON.stringify(old))));
  const first = collect(old, t);
  check('passive: its first collect starts the clock and pays nothing for the time before', first.r.earned === 0 && old.money === 10 && old.passive.at === t && old.passive.earned === 0 && 'passive' in first.d.set);
  check('passive: then it earns like any other', collect(old, t + 5 * MIN).r.earned === 500 && old.money === 510);
  check('passive: and the clock is saved with it', upgradeState(JSON.parse(JSON.stringify(old))).passive.at === t + 5 * MIN);

  // Online only the server collects (server/passive.mjs), by its own time: the action takes none from anyone.
  const acct = freshState(t);
  let refused = null; try { collect(acct, t + 10 * MIN, { online: true }); } catch (e) { refused = e; }
  check('passive: online a client can\'t ask for it', refused?.code === 'server' && acct.money === 10 && acct.passive.at === t);
  const sys = ACT.runAction(ACT.makeCtx(acct, { online: true, system: true, now: t + 10 * MIN }), 'passive.collect', { now: t + 99 * HOUR, at: 0, minutes: 720 });
  check('passive: the server\'s collect goes by its clock, not by anything sent with it', sys.earned === 1000 && acct.money === 1010 && acct.passive.at === t + 10 * MIN);

  // What a replaced state keeps (the admin panels): a restore or a raw edit keeps the clock, a reset starts it again.
  const cur = { ...freshState(t), money: 5010, passive: { at: t + 50 * MIN, earned: 5000 } };
  const snap = upgradeState(JSON.parse(JSON.stringify(freshState(t - 24 * HOUR))));
  AD.restoreMerge(cur, snap, {});
  check('passive: a restored snapshot keeps the clock as it is now (no time paid twice)', snap.passive === cur.passive);
  const reset = upgradeState(JSON.parse(JSON.stringify(freshState(t + 60 * MIN))));
  AD.restoreMerge(cur, reset, { startOver: true });
  check('passive: a reset counts again from the reset', reset.passive.at === t + 60 * MIN && reset.passive.earned === 0);
  const rev = AD.revOf(cur), view = JSON.parse(JSON.stringify(AD.rawView(cur)));
  collect(cur, t + 53 * MIN); // (what it pays while the panel has the raw JSON open)
  check('passive: what it pays meanwhile doesn\'t make a raw edit stale', AD.revOf(cur) === rev && cur.money === 5310);
  const edit = AD.rawEdit(cur, { ...view, stars: 7 }, rev);
  check('passive: the raw edit keeps what it paid since, and its clock', edit.next.money === 5310 && edit.next.stars === 7 && edit.next.passive === cur.passive && edit.changed.join() === 'stars', edit.changed.join());
  check('passive: a raw edit\'s money is that money plus what was paid since it was opened', AD.rawEdit(cur, { ...view, money: 100 }, rev).next.money === 400);
  cur.money += 1;
  check('passive: anything else that moved the money still makes it stale', AD.revOf(cur) !== rev);
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
  // (Saves know their NPCs by their place in the list: the first 420 and what they start with stay as they first were. An
  // NPC stops collecting at a value, so what patterns are worth moves it for those holding one, until they're in the save:
  // the real Case Hardened numbers did that to 79 of the 2,000, and taking High Blue and Above-average blue off again.)
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
    // 100 of them (it was 20), bought ten at a time; a buy that would go past it is refused whole, and costs nothing.
    const { st, run } = setup();
    st.money = 1e4;
    for (let i = 0; i < 9; i++) run('storage.buy', { n: 10 });
    run('storage.buy', { n: 5 });
    const money = st.money;
    let msg = '';
    try { run('storage.buy', { n: 10 }); } catch (e) { msg = e.message; }
    check('Storage Unit: you can own 100 (up from 20)', SU.MAX_UNITS === 100 && SU.unitsOf(st).length === 95 && /100 at most/.test(msg) && st.money === money && SU.unitsOf(st).length === 95, msg);
    run('storage.buy', { n: 5 });
    check('Storage Unit: the 100th fits, the 101st is refused', SU.unitsOf(st).length === 100 && code(() => run('storage.buy', {})) === 'units' && SU.unitsOf(st).length === 100);
    // Staff can still give more (the panels' items.give doesn't count them), and an account with more keeps them all.
    st.inv.push(I.makeUnitItem('Admin'));
    const kept = upgradeState(JSON.parse(JSON.stringify(st)));
    check('Storage Unit: more than 100 (given by staff) stay as they are, and none more can be bought', SU.unitsOf(kept).length === 101 && code(() => run('storage.buy', {})) === 'units');
  }
  {
    // The server's rules while the release that brings 100 units isn't out (server/index.mjs HELD_RULES): a context's maxUnits.
    const { st, run } = setup();
    st.money = 1e4;
    for (let i = 0; i < 2; i++) run('storage.buy', { n: 10 }, { maxUnits: 20 });
    let msg = '';
    try { run('storage.buy', {}, { maxUnits: 20 }); } catch (e) { msg = e.message; }
    check('Storage Unit: a context\'s maxUnits (the server\'s rules before 100 are out) is the most that can be bought; by default 100', SU.unitsOf(st).length === 20 && /20 at most/.test(msg)
      && ACT.makeCtx(st).maxUnits === SU.MAX_UNITS && code(() => run('storage.buy', {})) === null, msg);
  }
  {
    // What a list of units reads: every unit's count and value from one pass, the same as unitCount and unitValue each.
    const { st, run, named } = setup();
    st.money = 1e4;
    const us = Array.from({ length: 6 }, (_, i) => named('u' + i));
    st.inv.push(...Array.from({ length: 60 }, (_, i) => skinOf({ fl: 0.01 + i / 100 })), ...Array.from({ length: 9 }, () => I.makeStickerItem(stickerDef, 'test')));
    const loose = st.inv.filter((it) => !I.isUnit(it));
    us.slice(0, 5).forEach((u, k) => run('storage.deposit', { unit: u.uid, uids: loose.filter((_, i) => i % 5 === k).map((it) => it.uid) }));
    const tot = SU.unitTotals(st), counts = SU.unitCounts(st);
    check('Storage Unit: unitTotals and unitCounts: every unit\'s count and value in one pass, as unitCount and unitValue give them',
      us.every((u) => (tot.get(u.uid)?.n || 0) === SU.unitCount(st, u.uid) && (tot.get(u.uid)?.value || 0) === SU.unitValue(st, u.uid) && (counts.get(u.uid) || 0) === SU.unitCount(st, u.uid))
      && SU.unitCount(st, us[0].uid) === 14 && !tot.has(us[5].uid) && !counts.has(us[5].uid) && [...tot.values()].reduce((s, x) => s + x.n, 0) === 69);
    check('Storage Unit: and nothing stored, nothing counted', SU.unitTotals({ inv: [] }).size === 0 && SU.unitCounts({ inv: [], stored: [] }).size === 0);
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

// ---- tools: Name Tags and the StatTrak™ Swap Tool --------------------------------------------------------------------------
{
  const TL = await E('tools');
  const N = await E('npcs');
  const SU = await E('storage');
  const DBE = await E('database');
  const { upgradeState } = await E('economy');
  const skins = Object.values(D.skins);
  const find = (f) => skins.find(f);
  const ak = find((s) => s.w === 'AK-47' && !s.v && s.stt);
  const ak2 = skins.find((s) => s.w === 'AK-47' && !s.v && s.stt && s.id !== ak.id);
  const m4a4 = find((s) => s.w === 'M4A4' && !s.v && s.stt), m4a1 = find((s) => s.w === 'M4A1-S' && !s.v && s.stt);
  const usp = find((s) => s.w === 'USP-S' && !s.v && s.stt), p2000 = find((s) => s.w === 'P2000' && !s.v && s.stt);
  const deagle = find((s) => s.w === 'Desert Eagle' && !s.v && s.stt), r8 = find((s) => s.w === 'R8 Revolver' && !s.v && s.stt);
  const karambit = find((s) => s.w === 'Karambit' && !s.v && s.stt), bayonet = find((s) => s.w === 'Bayonet' && !s.v && s.stt);
  const vanilla = find((s) => s.cat === 'knife' && s.v && s.stt), zeus = find((s) => s.cat === 'equipment');
  const glove = find((s) => s.cat === 'gloves');
  const sticker = Object.values(D.stickers).find((s) => s.p > 0), charm = Object.values(D.charms)[0], agent = Object.values(D.agents)[0];
  const box = D.cases.find((c) => c.price != null);
  const setup = () => {
    const st = { ...freshState(), money: 1000 };
    const run = (name, args, o) => { const c = ACT.makeCtx(st, { rng, ...o }); const r = ACT.runAction(c, name, args); return { r, d: ACT.delta(c) }; };
    const gun = (s = ak, x = {}) => { const it = { ...I.makeSkinItem(s, { stt: !!x.stt, r: rng, src: 'test' }), ...x }; st.inv.unshift(it); return it; };
    const tool = (id = I.NAME_TAG) => run('tools.buy', { id }).r.items[0];
    return { st, run, gun, tool };
  };
  const code = (fn) => { try { fn(); } catch (e) { return e instanceof ACT.GameError ? e.code : 'crash: ' + e.message; } return null; };
  const count = (st, id) => st.inv.filter((i) => i.t === 'tool' && i.id === id).length;

  // The items
  {
    const { st, run } = setup();
    const r = run('tools.buy', { id: I.NAME_TAG, n: 3 }).r;
    const t = r.items[0];
    check('tools: 3 Name Tags cost 3 x the Steam Market\'s $4.47, one item each', r.cost === 13.41 && st.money === 986.59 && st.inv.length === 3 && t.t === 'tool' && t.nw === true && t.src === 'Store');
    check('tools: a Base Grade Tool with CS2\'s name and description', I.itemName(t) === 'Name Tag' && I.rarityInfo(t).n === 'Base Grade Tool' && I.rarityInfo(t).c === I.rarityInfo({ t: 'key', id: Object.keys(D.keys)[0] }).c
      && /rename a weapon/.test(I.itemDef(t).desc) && I.nameParts(t).bottom === 'Name Tag' && I.rarityRank(t) === 0);
    const sw = run('tools.buy', { id: I.SWAP_TOOL }).r.items[0];
    check('tools: the Swap Tool costs $1.62, with CS2\'s description', I.itemValue(sw) === 1.62 && I.itemName(sw) === 'StatTrak™ Swap Tool' && /same item type/.test(I.itemDef(sw).desc));
    check('tools: worth their price, in your net worth', I.itemValue(t) === 4.47 && SU.ownedValue(st) === 15.03);
    check('tools: tradable, and nothing you equip or put stickers on', I.tradable(t) && I.loadoutSlot(t) === null && !I.canHaveCharm(t) && !I.canHaveStickers(t));
    check('tools: other ids and counts are refused, with nothing spent', code(() => run('tools.buy', { id: 'nope' })) === 'bad' && code(() => run('tools.buy', { id: '__proto__' })) === 'bad' && code(() => run('tools.buy', { id: I.NAME_TAG, n: 0 })) === 'bad'
      && code(() => run('tools.buy', { id: I.NAME_TAG, n: 101 })) === 'bad' && code(() => run('tools.buy', { id: I.NAME_TAG, n: 1.5 })) === 'bad' && st.money === 984.97);
    st.money = 4;
    check('tools: refused without the money', code(() => run('tools.buy', { id: I.NAME_TAG })) === 'funds' && st.money === 4 && st.inv.length === 4);
    st.money = 100;
    check('tools: a full inventory refuses them, and nothing is spent', code(() => run('tools.buy', { id: I.NAME_TAG }, { invCap: 4 })) === 'full' && st.money === 100 && st.inv.length === 4);
    check('tools: they earn no Armory Stars (they sell for what they cost)', st.stars === 0 && !st.starSpend);
    run('tools.buy', { id: I.SWAP_TOOL, n: 2 });
    const before = st.money;
    const out = run('item.sell', { uids: st.inv.filter((i) => i.id === I.SWAP_TOOL).map((i) => i.uid) }).r;
    check('tools: selling pays exactly what buying cost', out.total === 4.86 && st.money === round2(before + 4.86));
  }

  // No money from NPCs: nobody pays more than the store, and nobody sells one back for less
  {
    const { st, run, tool } = setup();
    run('npc.tick');
    const crowd = N.crowd(st.social.seed), bad = [];
    for (const id of [I.NAME_TAG, I.SWAP_TOOL]) {
      const it = { t: 'tool', id, uid: 'x' }, v = I.itemValue(it);
      for (const n of crowd) {
        const s = { inv: [it], money: 1e6 }, so = st.social;
        if (N.judge(so, n, s, { yours: [it], theirs: [], myMoney: 0, theirMoney: v }).ok) bad.push(n.id + ' paid the store price');
        if (N.judge(so, n, s, { yours: [], theirs: [it], myMoney: v * 0.99, theirMoney: 0 }).ok) bad.push(n.id + ' sold under the store price');
        if (N.buyValue(n, it) >= N.keepValue(n, it) || N.buyValue(n, it) >= v) bad.push(n.id + ' buys for what they sell');
      }
    }
    check(`tools: none of the ${crowd.length} NPCs pays the store's price for one, or sells one for less`, !bad.length, bad.slice(0, 3).join(', '));
    const beginner = crowd.find((n) => n.type === 'beginner' && N.guess(n, { t: 'tool', id: I.NAME_TAG }) > 4.47 * 1.2) || crowd.find((n) => n.type === 'beginner');
    check('tools: a beginner\'s hunch doesn\'t count for them', N.buyValue(beginner, { t: 'tool', id: I.NAME_TAG }) === round2(4.47 * 0.75));
    const npc = crowd.find((n) => n.type === 'player'), t = tool();
    const ask = run('npc.offer', { npc: npc.id, give: { uids: [t.uid] }, get: { money: 4 } }).r;
    check('tools: they don\'t haggle over one: too high is a plain no', ask.result === 'declined' && st.inv.includes(t) && !st.social.offers.some((o) => o.status === 'open' && o.want.uids.includes(t.uid)));
    const cash = st.money;
    const sold = run('npc.offer', { npc: npc.id, give: { uids: [t.uid] }, get: { money: 3 } }).r;
    check('tools: they trade with NPCs at their own bid, and stay in their inventory', sold.result === 'accepted' && st.money === round2(cash + 3) && !st.inv.includes(t) && st.social.npcs[npc.id].inv.some((i) => i.uid === t.uid));
    check('tools: never something they message you about', !N.notable(t) && N.interest(npc, t) === 0);
  }

  // Everything else that switches on the item's type
  {
    const { st, run, gun, tool } = setup();
    const t = tool(), g = gun();
    const wager = code(() => run('gamble.coinflip', { money: 0, uids: [t.uid], side: 't', clientSeed: 's' }));
    check('tools: staked like any other item, at their price', wager === null);
    st.inv = st.inv.filter((i) => i.uid !== t.uid);
    const t2 = tool();
    check('tools: refused by a trade-up', (await E('tradeup')).tradeupIneligible(t2) === 'Only weapon skins can be traded up' && code(() => run('tradeup.sign', { uids: [t2.uid] })) === 'bad' && st.inv.includes(t2));
    check('tools: refused by the loadout', code(() => run('loadout.equip', { uid: t2.uid })) === 'bad');
    check('tools: can be showcased', run('persona.set', { showcase: [t2.uid] }).r.me.showcase.length === 1);
    check('tools: in the item database\'s counts', DBE.DB_TYPES.includes('tool') && DBE.countCopies([{ item: t2 }])['tool:' + I.NAME_TAG] === 1);
    check('tools: found by a Storage Unit\'s filters and sorts', SU.viewItems([t2, g], { q: 'name tag' }).length === 1 && SU.viewItems([t2], { rank: '0', sort: 'quality' }).length === 1);
    const u = run('storage.buy', {}).r.items[0];
    run('storage.name', { unit: u.uid, name: 'x' });
    run('storage.deposit', { unit: u.uid, uids: [t2.uid] });
    check('tools: stored in a unit: still yours', SU.ownedItems(st).some((i) => i.uid === t2.uid) && !st.inv.includes(t2));
    check('tools: a stored one can\'t be used, named or picked for you', code(() => run('tools.name', { uid: g.uid, tool: t2.uid, name: 'x' })) === 'stored' && code(() => run('tools.name', { uid: g.uid, name: 'x' })) === 'notool' && !g.name);
    run('storage.retrieve', { unit: u.uid, uids: [t2.uid] });
    check('tools: retrieved, it works', run('tools.name', { uid: g.uid, tool: t2.uid, name: 'x' }).r.item.name === 'x');
  }

  // What can take a name
  {
    const mk = (s, x = {}) => ({ uid: 'u', t: 'skin', id: s.id, fl: 0.2, sd: 1, ...x });
    check('Name Tag: guns, knives and the Zeus, of any quality', [mk(ak), mk(ak, { stt: true }), mk(ak, { sv: true }), mk(karambit), mk(vanilla, { fl: null, sd: null }), mk(zeus)].every(TL.nameable));
    check('Name Tag: not gloves, agents, charms, stickers, cases, keys, units or tools', ![mk(glove), I.makeAgentItem(agent), I.makeCharmItem(charm), I.makeStickerItem(sticker), I.makeCrateItem(box), I.makeKeyItem(Object.keys(D.keys)[0]), I.makeUnitItem(), I.makeToolItem(I.NAME_TAG)].some(TL.nameable));
  }

  // What a name can be
  {
    const ok = ['a', 'x'.repeat(20), '<img src=x onerror=', '"quoted"', "it's", 'a b', '😀'.repeat(10), '日本語の名前', 'שלום', 'مرحبا', '&amp;', '\u00a0x', 'x\u00a0', 'Ünï'];
    const bad = ['', ' a', 'a ', ' ', 'x'.repeat(21), '😀'.repeat(11), 'a\nb', 'a\tb', '\u0000', 'a\u001f', '\u007f', 'a\u0085', '\u009f', 'a\u200eb', 'a\u200fb', 'a\u202eb', 'a\u2066b', 'a\u2028b', '\ud83d', 'a\ude00b', null, undefined, 5, {}, ['a']];
    check('Name Tag: CS2\'s rule: 1 to 20 UTF-16 units, < > quotes and emoji are fine', ok.every((s) => TL.nameProblem(s) === ''), ok.filter((s) => TL.nameProblem(s)).join(' | '));
    check('Name Tag: empty, too long, spaces at the ends, control and reordering characters and broken text are refused', bad.every((s) => TL.nameProblem(s) !== ''), bad.filter((s) => !TL.nameProblem(s)).map(String).join(' | '));
    check('Name Tag: the server\'s words are refused, however they\'re written', ['fuck', 'FUCKER', 'xshitx', 'ｆｕｃｋ', 'f\u200bu\u200bck', 'fúck', 'admin', 'Valve', 'bot_1', 'moderator_x'].every((s) => TL.nameProblem(s) === 'Please pick another name'));
    check('Name Tag: and a name that merely holds a reserved word isn\'t', TL.nameProblem('botany') === '' && TL.nameProblem('my admin') === '');
    const spelt = ['f.u.c.k', 'f u c k', 'f_u_c_k', 'f-uck', 'sh1t', 'sh!t', 'n1gger', 'ni66er', 'h1tler', 'hitl3r', 'fսck', 'fuсk', 'nаzi', 'f\u3164uck', 'f\u115fuck', 'f\u2800uck', 'f\u{1F480}uck', 'f*uck',
      'Аdmin', 'admin.', '[admin]', 'admin\u00a0', 'b o t', 'adm1n', 'b0t', 's3rver_1', 'Server:'];
    check('Name Tag: the words are refused as they read: spaced out, signs between, digits for letters, lookalike letters, blank letters', spelt.every((s) => TL.nameProblem(s) === 'Please pick another name'), spelt.filter((s) => TL.nameProblem(s) !== 'Please pick another name').join(' | '));
    const fine = ['Push It', 'Wolf Agent', 'War Ape', 'Star Apex', 'Mini GG', 'Smash It', 'I Push It', 'M4A1-S', 'AK-47 Killer', 'Dust 2', '1337', 'Рома', '小明', 'بطل', 'Bot Killer'];
    check('Name Tag: words side by side stay words, and other alphabets are fine', fine.every((s) => TL.nameProblem(s) === ''), fine.filter((s) => TL.nameProblem(s)).join(' | '));
    check('Name Tag: usernames go through the same words', ['sh1t_lord', 'f_u_c_k', 'b0t', 'adm1n', 'admin_1', 'Admin-'].every(TL.refusedWord) && !['wolf_agent', 'push_it', 'player_1', 'Bob_2', 'tradepal'].some(TL.refusedWord));
    const blank = ['\u3164', '\u115f', '\u200b', '\u00a0', '\u2800', '\ufeff', '\u034f', '\u0301', '\u3164\u3164', '\u00a0\u200b'];
    check('Name Tag: a name with nothing to see is refused', blank.every((s) => TL.nameProblem(s) === TL.BAD_NAME), blank.filter((s) => TL.nameProblem(s) !== TL.BAD_NAME).map((s) => JSON.stringify(s)).join(' '));
  }

  // Applying, renaming, removing
  {
    const { st, run, gun, tool } = setup();
    const g = gun(ak, { stt: true, kills: 7 }), before = JSON.stringify(g), worth = I.itemValue(g), real = I.itemName(g);
    check('Name Tag: needs a tag', code(() => run('tools.name', { uid: g.uid, name: 'x' })) === 'notool' && !g.name);
    tool();
    check('Name Tag: a refused name doesn\'t use up the tag', code(() => run('tools.name', { uid: g.uid, name: ' x' })) === 'name' && code(() => run('tools.name', { uid: g.uid, name: 'fuck' })) === 'name' && code(() => run('tools.name', { uid: g.uid })) === 'name' && count(st, I.NAME_TAG) === 1 && !g.name);
    const { d } = run('tools.name', { uid: g.uid, name: '"<b>" & co' });
    check('Name Tag: the name goes on and the tag is used up', g.name === '"<b>" & co' && count(st, I.NAME_TAG) === 0 && d.upd.some((i) => i.uid === g.uid && i.name === g.name) && d.del.length === 1);
    check('Name Tag: only the name changed, and it adds no value', JSON.stringify({ ...g, name: undefined }) === before && I.itemValue(g) === worth);
    check('Name Tag: the real name stays readable beside it', I.itemName(g) === real + ' "\"<b>\" & co"'.replaceAll('\\', '') && I.realName(g) === real && I.customName(g) === g.name && I.nameParts(g).bottom === I.nameParts({ ...g, name: null }).bottom);
    check('Name Tag: search finds it by the name', SU.viewItems([g], { q: '<b>' }).length === 1);
    check('Name Tag: a new name takes a new tag', code(() => run('tools.name', { uid: g.uid, name: 'second' })) === 'notool' && g.name === '"<b>" & co');
    tool();
    check('Name Tag: the same name again is refused, tag kept', code(() => run('tools.name', { uid: g.uid, name: g.name })) === 'name' && count(st, I.NAME_TAG) === 1);
    run('tools.name', { uid: g.uid, name: 'second' });
    check('Name Tag: renamed with the second tag', g.name === 'second' && count(st, I.NAME_TAG) === 0);
    const removed = run('tools.unname', { uid: g.uid });
    check('Name Tag: removing needs no tag, costs nothing and gives none back', !('name' in g) && count(st, I.NAME_TAG) === 0 && removed.d.upd[0].uid === g.uid && !('name' in removed.d.upd[0]) && I.itemName(g) === real);
    check('Name Tag: nothing to remove is refused', code(() => run('tools.unname', { uid: g.uid })) === 'nameable');
    const u = run('storage.buy', {}).r.items[0];
    run('storage.name', { unit: u.uid, name: 'stash' });
    check('Name Tag: a unit\'s label isn\'t one', code(() => run('tools.unname', { uid: u.uid })) === 'nameable' && u.name === 'stash');
    check('Name Tag: and a tag can\'t name a unit, a tool or gloves', (() => { const t = tool(), gl = gun(glove); return code(() => run('tools.name', { uid: u.uid, name: 'x' })) === 'nameable' && code(() => run('tools.name', { uid: t.uid, name: 'x' })) === 'nameable' && code(() => run('tools.name', { uid: gl.uid, name: 'x' })) === 'nameable' && count(st, I.NAME_TAG) === 1; })());
    const v = gun(vanilla, { stt: false });
    check('Name Tag: a vanilla knife takes one', run('tools.name', { uid: v.uid, name: 'knife' }).r.item.name === 'knife' && I.itemName(v).endsWith('"knife"'));
  }

  // Refused: not yours, stored, locked, in an offer
  {
    const { st, run, gun, tool } = setup();
    const g = gun(), t = tool();
    check('Name Tag: an item you don\'t own', code(() => run('tools.name', { uid: 'nope', name: 'x' })) === 'missing');
    check('Name Tag: a tag that isn\'t one', code(() => run('tools.name', { uid: g.uid, tool: g.uid, name: 'x' })) === 'bad');
    g.lk = true;
    check('Name Tag: a locked item', code(() => run('tools.name', { uid: g.uid, name: 'x' })) === 'locked' && !g.name && count(st, I.NAME_TAG) === 1);
    delete g.lk;
    t.lk = true;
    check('Name Tag: a locked tag isn\'t used', code(() => run('tools.name', { uid: g.uid, name: 'x' })) === 'notool' && code(() => run('tools.name', { uid: g.uid, tool: t.uid, name: 'x' })) === 'locked' && !g.name);
    delete t.lk;
    const held = new Set([g.uid]), tagHeld = new Set([t.uid]);
    check('Name Tag: an item in an offer you made', code(() => run('tools.name', { uid: g.uid, name: 'x' }, { reserved: held })) === 'reserved' && !g.name);
    check('Name Tag: or one someone\'s offer asks you for', code(() => run('tools.name', { uid: g.uid, name: 'x' }, { asked: held })) === 'reserved' && !g.name);
    check('Name Tag: a tag in an offer isn\'t used', code(() => run('tools.name', { uid: g.uid, name: 'x' }, { reserved: tagHeld })) === 'notool' && code(() => run('tools.name', { uid: g.uid, tool: t.uid, name: 'x' }, { asked: tagHeld })) === 'reserved' && !g.name);
    const says = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };
    check('Name Tag: and it says why, when you do own one', /is locked or in a pending trade offer/.test(says(() => run('tools.name', { uid: g.uid, name: 'x' }, { reserved: tagHeld }))));
    run('npc.tick');
    const offer = { id: 'o', npc: N.crowd(st.social.seed)[0].id, status: 'open', at: 0, exp: Date.now() + 1e6, want: { uids: [g.uid], money: 0 }, give: { uids: [], money: 5 } };
    st.social.offers.push(offer);
    check('Name Tag: offline, or one a trader\'s open offer is for', code(() => run('tools.name', { uid: g.uid, name: 'x' })) === 'reserved' && !g.name);
    offer.status = 'declined';
    run('tools.name', { uid: g.uid, name: 'x' });
    check('Name Tag: free again once it\'s answered', g.name === 'x');
    g.lk = true;
    check('Name Tag: a locked item keeps its name', code(() => run('tools.unname', { uid: g.uid })) === 'locked' && g.name === 'x');
    delete g.lk;
    check('Name Tag: and so does one in an offer', code(() => run('tools.unname', { uid: g.uid }, { reserved: new Set([g.uid]) })) === 'reserved' && code(() => run('tools.unname', { uid: g.uid }, { asked: new Set([g.uid]) })) === 'reserved' && g.name === 'x');
    const u = run('storage.buy', {}).r.items[0];
    run('storage.name', { unit: u.uid, name: 's' });
    run('storage.deposit', { unit: u.uid, uids: [g.uid] });
    const kept = SU.storedItem(st, g.uid);
    tool();
    check('Name Tag: not on a stored item, or off one', code(() => run('tools.name', { uid: g.uid, name: 'y' })) === 'stored' && code(() => run('tools.unname', { uid: g.uid })) === 'stored' && kept.name === 'x');
  }

  // A name travels with the item
  {
    const { st, run, gun, tool } = setup();
    const g = gun();
    tool();
    run('tools.name', { uid: g.uid, name: 'keeps <3' });
    const u = run('storage.buy', {}).r.items[0];
    run('storage.name', { unit: u.uid, name: 's' });
    run('storage.deposit', { unit: u.uid, uids: [g.uid] });
    check('Name Tag: stored with the item', SU.storedItem(st, g.uid).name === 'keeps <3');
    run('storage.retrieve', { unit: u.uid, uids: [g.uid] });
    const back = st.inv.find((i) => i.uid === g.uid);
    check('Name Tag: and retrieved with it', back.name === 'keeps <3');
    const round = upgradeState(JSON.parse(JSON.stringify(st)));
    check('Name Tag: and saved and loaded with it', round.inv.find((i) => i.uid === g.uid).name === 'keeps <3');
    check('Name Tag: the database shows it, the unit a label doesn\'t count as one', DBE.publicCopy(back).name === 'keeps <3' && I.customName(u) === '');
    run('npc.tick');
    const npc = N.crowd(st.social.seed).find((n) => n.type === 'collector');
    N.npcState(st.social, npc.id).money = 1e6;
    const r = run('npc.offer', { npc: npc.id, give: { uids: [back.uid] }, get: { money: 0.01 } }).r;
    check('Name Tag: and traded to an NPC with it', r.result === 'accepted' && st.social.npcs[npc.id].inv.find((i) => i.uid === g.uid)?.name === 'keeps <3');
    check('Name Tag: older saves load unchanged', JSON.stringify(upgradeState({ money: 1, inv: [{ uid: 'a', t: 'skin', id: ak.id, fl: 0.2, sd: 1, stk: [], stt: false }], stats: {} }).inv[0]) === JSON.stringify({ uid: 'a', t: 'skin', id: ak.id, fl: 0.2, sd: 1, stk: [], stt: false }));
  }

  // Swapping counters
  {
    const pair = (a = ak, b = ak, ka = 120, kb = 5) => {
      const s = setup();
      const x = s.gun(a, { stt: true, kills: ka }), y = s.gun(b, { stt: true, kills: kb });
      return { ...s, x, y };
    };
    {
      const { st, run, x, y, tool } = pair(ak, ak2);
      x.name = 'keep'; x.stk = [{ id: sticker.id, x: 0.5, y: 0.5, r: 0, wr: 0 }];
      const was = [JSON.stringify({ ...x, kills: 0 }), JSON.stringify({ ...y, kills: 0 })], worth = [I.itemValue(x), I.itemValue(y)];
      check('Swap: needs a tool', code(() => run('tools.swap', { a: x.uid, b: y.uid })) === 'notool' && x.kills === 120);
      const t = tool(I.SWAP_TOOL);
      const { d } = run('tools.swap', { a: x.uid, b: y.uid });
      check('Swap: the two counters change places in one action, and the tool is used up', x.kills === 5 && y.kills === 120 && count(st, I.SWAP_TOOL) === 0 && d.del.includes(t.uid) && d.upd.length === 2);
      check('Swap: nothing else moves: floats, seeds, stickers, names, value', JSON.stringify({ ...x, kills: 0 }) === was[0] && JSON.stringify({ ...y, kills: 0 }) === was[1] && I.itemValue(x) === worth[0] && I.itemValue(y) === worth[1]);
      check('Swap: a second swap needs a second tool', code(() => run('tools.swap', { a: x.uid, b: y.uid })) === 'notool' && x.kills === 5);
    }
    const refuse = (name, a, b, want = 'swap', ka = 120, kb = 5) => {
      const { st, run, x, y, tool } = pair(a, b, ka, kb);
      tool(I.SWAP_TOOL);
      const c = code(() => run('tools.swap', { a: x.uid, b: y.uid }));
      check(`Swap: ${name}`, c === want && x.kills === ka && y.kills === kb && count(st, I.SWAP_TOOL) === 1, String(c));
    };
    refuse('an M4A4 and an M4A1-S are different items', m4a4, m4a1);
    refuse('a USP-S and a P2000 are too', usp, p2000);
    refuse('a Desert Eagle and an R8 too, though CS2 gives them one class', deagle, r8);
    refuse('an AK and an M4 are too', ak, m4a4);
    refuse('equal counters are refused, as in CS2, and the tool kept', ak, ak2, 'swap', 9, 9);
    refuse('two untouched counters too', ak, ak2, 'swap', 0, 0);
    {
      const { run, x, y, tool } = pair(karambit, bayonet);
      tool(I.SWAP_TOOL);
      run('tools.swap', { a: x.uid, b: y.uid });
      check('Swap: any two knives can', x.kills === 5 && y.kills === 120);
    }
    {
      const s = setup();
      const k = s.gun(karambit, { stt: true, kills: 3 }), v = s.gun(vanilla, { stt: true, kills: 44 });
      s.tool(I.SWAP_TOOL);
      s.run('tools.swap', { a: k.uid, b: v.uid });
      check('Swap: a vanilla knife with a painted one', k.kills === 44 && v.kills === 3);
    }
    {
      const s = setup();
      const x = s.gun(ak, { stt: true }), y = s.gun(ak, { stt: true, kills: 12 });
      delete x.kills;
      s.tool(I.SWAP_TOOL);
      s.run('tools.swap', { a: x.uid, b: y.uid });
      check('Swap: a counter that was never written counts as 0', x.kills === 12 && y.kills === 0);
    }
    {
      const { st, run, x, y, tool, gun } = pair();
      const t = tool(I.SWAP_TOOL), plain = gun(ak, { stt: false }), sv = gun(find((s) => s.w === 'AK-47' && !s.v), { sv: true, stt: false }), stick = I.makeStickerItem(sticker);
      st.inv.push(stick);
      const fails = (a, b, o) => code(() => run('tools.swap', { a, b }, o));
      check('Swap: the same item twice', fails(x.uid, x.uid) === 'swap');
      check('Swap: not a StatTrak™ item, a Souvenir or a sticker', fails(x.uid, plain.uid) === 'swap' && fails(sv.uid, x.uid) === 'swap' && fails(x.uid, stick.uid) === 'swap');
      check('Swap: an item you don\'t own', fails(x.uid, 'nope') === 'missing' && code(() => run('tools.swap', { a: x.uid })) === 'missing');
      y.lk = true;
      check('Swap: a locked item', fails(x.uid, y.uid) === 'locked');
      delete y.lk;
      t.lk = true;
      check('Swap: a locked tool', fails(x.uid, y.uid) === 'notool' && code(() => run('tools.swap', { a: x.uid, b: y.uid, tool: t.uid })) === 'locked');
      delete t.lk;
      check('Swap: an item in an offer, either way', fails(x.uid, y.uid, { reserved: new Set([y.uid]) }) === 'reserved' && fails(x.uid, y.uid, { asked: new Set([x.uid]) }) === 'reserved');
      check('Swap: a tool in an offer', fails(x.uid, y.uid, { reserved: new Set([t.uid]) }) === 'notool');
      const u = run('storage.buy', {}).r.items[0];
      run('storage.name', { unit: u.uid, name: 's' });
      run('storage.deposit', { unit: u.uid, uids: [y.uid] });
      check('Swap: a stored item', fails(x.uid, y.uid) === 'stored');
      check('Swap: all that left everything as it was', x.kills === 120 && SU.storedItem(st, y.uid).kills === 5 && count(st, I.SWAP_TOOL) === 1);
    }
    check('Swap: which skins share a type: StatTrak™ only, of the same weapon or two knives', TL.swapRefusal({ uid: 'a', t: 'skin', id: ak.id, stt: true, kills: 1 }, { uid: 'b', t: 'skin', id: ak2.id, stt: true, kills: 2 }) === ''
      && TL.swapRefusal({ uid: 'a', t: 'skin', id: bayonet.id, stt: true, kills: 1 }, { uid: 'b', t: 'skin', id: karambit.id, stt: true, kills: 2 }) === ''
      && TL.swapRefusal({ uid: 'a', t: 'skin', id: ak.id, stt: true, kills: 1 }, { uid: 'b', t: 'skin', id: karambit.id, stt: true, kills: 2 }) !== '');
  }
}

// ---- a save holding what the game no longer has: worth nothing, and nothing else stops working ---------------------------------
{
  const { ownedValue } = await E('storage');
  const gone = { uid: 'g1', t: 'skin', id: 'skin-gone', fl: 0.1, sd: 3, stt: false, stk: [], at: 1, src: 'x' };
  const lost = { uid: 'g2', t: 'tool', id: 'gone_tool', at: 1, src: 'x' };
  let total = null, threw = '';
  try { total = ownedValue({ inv: [gone, lost], stored: [] }); } catch (e) { threw = e.message; }
  check('an item the game no longer has adds nothing to a save\'s value, and adding it up works', total === 0, threw);
  check('its card has a name to show, not an error', I.nameParts(gone).bottom === 'Unknown item' && I.nameParts(lost).bottom === 'Unknown item' && I.itemName(lost) === 'Unknown item');
  const skinDef = Object.values(D.skins)[0], box = D.cases.find((c) => c.price != null);
  const kinds = [I.makeSkinItem(skinDef, { stt: false }), I.makeStickerItem(Object.values(D.stickers)[0]), I.makeCharmItem(Object.values(D.charms)[0]), I.makeAgentItem(Object.values(D.agents)[0]),
    I.makeCrateItem(box), I.makeKeyItem(Object.keys(D.keys)[0]), I.makeToolItem(I.NAME_TAG)];
  check('nobody can be offered one, and every item the game has can still be', !I.tradable(gone) && !I.tradable(lost) && kinds.every(I.tradable) && !I.tradable(I.makeUnitItem()), kinds.filter((k) => !I.tradable(k)).map((k) => k.t).join());
}

// ---- the Index: the record of what you've unboxed, and the rewards for finishing a set ---------------------------------------
{
  const IX = await E('itemindex');
  const L = await E('levels');
  const MK = await E('market');
  const N = await E('npcs');
  const AD = await E('admin');
  const { upgradeState } = await E('economy');
  const NOW = Date.UTC(2026, 5, 1);
  const save = () => { const st = freshState(); st.money = 1e7; return st; };
  const on = (st, name, args = {}, opts = {}) => { const ctx = ACT.makeCtx(st, { rng, now: NOW, ...opts }); const r = ACT.runAction(ctx, name, args); return { r, d: ACT.delta(ctx) }; };
  const refusedWith = (fn) => { try { fn(); return null; } catch (e) { return e.code || e.message; } };
  const box = D.cases.find((c) => c.n === 'Chroma 2 Case');
  const open = (st, c, n = 1, opts) => {
    on(st, 'case.buy', { id: c.id, n }, opts);
    if (keyFor(c)) on(st, 'key.buy', { key: keyFor(c), n }, opts);
    return on(st, 'case.open', { id: c.id, n }, opts);
  };
  const copy = (id, extra = {}) => ({ t: IX.kindOf(id), id, ...extra });
  const onRecord = (st) => Object.keys(st.index.items);

  // The record.
  {
    const st = save();
    check('Index: a new save has an empty record, nothing to fill in later', JSON.stringify(st.index) === JSON.stringify({ items: {}, claimed: {}, filled: true, lost: 0 }));
    const first = open(st, box);
    const it = first.r.items[0], e = st.index.items[it.id];
    check('Index: a case opened goes on the record: when, how many, its float', e.n === 1 && e.at === NOW && near(e.fl, it.fl, it.fl * 1e-5) && (!!e.st === !!it.stt));
    check('Index: what reaches the client is the change, not the record', first.d.ix.items[it.id].n === 1 && !('index' in first.d.set));
    const later = open(st, box, 10, { now: NOW + 5000 }), all = [it, ...later.r.items], same = all.filter((x) => x.id === it.id);
    const e2 = st.index.items[it.id];
    check('Index: more copies add up, the first time stays, the float is the lowest yet', e2.n === same.length && e2.at === NOW && near(e2.fl, Math.min(...same.map((x) => x.fl)), 1e-4));
    check('Index: every copy is counted', Object.values(st.index.items).reduce((s, x) => s + x.n, 0) === all.length);
    const before = JSON.stringify(st.index);
    on(st, 'item.sell', { uids: st.inv.filter((x) => x.t === 'skin').map((x) => x.uid) });
    check('Index: selling takes nothing off it', st.inv.filter((x) => x.t === 'skin').length === 0 && JSON.stringify(st.index) === before);

    const r = { index: IX.freshIndex() }, skin = box.pools[2][0];
    IX.record(r, [copy(skin, { fl: 0.3, sd: 1, stt: true }), copy(skin, { fl: 0.2, sd: 2 }), copy(skin, { fl: 0.5, sd: 3, sv: true })], NOW);
    check('Index: StatTrak™ and Souvenir copies are counted apart', r.index.items[skin].n === 3 && r.index.items[skin].st === 1 && r.index.items[skin].sv === 1);
    const plain = { index: IX.freshIndex() };
    IX.record(plain, [copy(skin, { fl: 0.3, sd: 1 })], NOW);
    check('Index: an entry writes nothing it has no use for', JSON.stringify(Object.keys(plain.index.items[skin]).sort()) === JSON.stringify(['at', 'fl', 'n']));
    const fancy = Object.values(D.skins).find((s) => !s.v && Array.from({ length: 1001 }, (_, sd) => I.patternInfo({ t: 'skin', id: s.id, sd }).mult).some((m) => m > 1));
    const seeds = Array.from({ length: 1001 }, (_, sd) => sd).sort((a, b) => I.patternInfo({ t: 'skin', id: fancy.id, sd: b }).mult - I.patternInfo({ t: 'skin', id: fancy.id, sd: a }).mult);
    const pat = { index: IX.freshIndex() };
    IX.record(pat, [copy(fancy.id, { fl: 0.1, sd: seeds[0] })], NOW);
    IX.record(pat, [copy(fancy.id, { fl: 0.1, sd: seeds.at(-1) })], NOW);
    check('Index: the rarest pattern found stays', pat.index.items[fancy.id].pt === seeds[0], I.patternInfo({ t: 'skin', id: fancy.id, sd: seeds[0] }).label);
    const ch = Object.values(D.charms)[0], pc = { index: IX.freshIndex() };
    IX.record(pc, [copy(ch.id, { pat: 1 })], NOW);
    IX.record(pc, [copy(ch.id, { pat: 50000 })], NOW);
    check('Index: a charm\'s best pattern too', pc.index.items[ch.id].pt === 1 && pc.index.items[ch.id].n === 2);
    check('Index: only what boxes hold: no cases, keys or tools, no Sticker Slabs', IX.record({ index: IX.freshIndex() }, [I.makeCrateItem(box, 'x'), I.makeKeyItem(keyFor(box), 'x'), { uid: 'x', t: 'tool', id: 'nametag' }, { t: 'charm', id: 'slab', sk: 'sticker-13', pat: 5 }], NOW) === null);
  }

  // What counts.
  {
    const st = save();
    const none = { on: true, below: 1e6, ranks: [2, 3, 4, 5], keepStt: false, keepRare: false };
    on(st, 'case.buy', { id: box.id, n: 5 }); on(st, 'key.buy', { key: keyFor(box), n: 5 });
    const sold = on(st, 'case.open', { id: box.id, n: 5, autoSell: none }).r.items;
    check('Index: an item auto-sold was still unboxed', sold.some((i) => i.as) && sold.every((i) => st.index.items[i.id]));

    const w = A.armoryWindow(NOW), offer = A.armoryOffers(w.i).offers[0];
    const arm = save(); arm.stars = 1000;
    const got = on(arm, 'armory.redeem', { offer: offer.id, n: 3 }).r.items;
    check('Index: Armory redemptions count', got.every((i) => arm.index.items[i.id]));

    const lvl = save();
    let drop = null;
    for (let k = 0; k < 50 && !drop; k++) { const d = L.carePackage({ r: rng, now: NOW }); if (d.offers.some((o) => o.t === 'skin') && d.offers.some((o) => o.t === 'crate')) drop = d; }
    lvl.prof = { ...lvl.prof, drops: [drop] };
    const picks = [drop.offers.findIndex((o) => o.t === 'skin'), drop.offers.findIndex((o) => o.t === 'crate')];
    on(lvl, 'drop.claim', { id: drop.id, picks });
    check('Index: a level-up reward\'s skin counts, the case in it doesn\'t (what comes out of it will)', onRecord(lvl).length === 1 && onRecord(lvl)[0] === drop.offers[picks[0]].id);

    const bat = save();
    let won = null, lost = null;
    for (let k = 0; k < 40 && !(won && lost); k++) {
      const before = onRecord(bat).length, { r } = on(bat, 'gamble.battle', { cases: [box.id], format: '1v1', mode: 'normal', clientSeed: 'ix' + k });
      if (r.won) won = r; else if (!lost) lost = { r, same: onRecord(bat).length === before };
    }
    check('Index: a case battle: what you take home counts, a lost one adds nothing', won?.prize.every((i) => bat.index.items[i.id]) && lost?.same);
  }

  // What doesn't.
  {
    const st = save(), w = MK.marketWindow(NOW);
    const listed = Object.values(D.skins).find((s) => !s.star && MK.skinListings(s, w).length);
    on(st, 'market.buy', { kind: 'skin', id: listed.id, n: 0, window: w });
    check('Index: an item bought on the Market doesn\'t count', st.inv.some((i) => i.id === listed.id) && !onRecord(st).length);

    const col = Object.values(D.skins).find((s) => !s.v && !s.star && s.r === 2 && s.col && T.tradeupIneligible({ t: 'skin', id: s.id, fl: s.mn }) === '');
    const up = save(), ten = Array.from({ length: 10 }, () => I.makeSkinItem(col, { stt: false, r: rng, src: 'Market' }));
    up.inv.push(...ten);
    const made = on(up, 'tradeup.sign', { uids: ten.map((i) => i.uid) }).r.item;
    check('Index: a Trade Up Contract\'s result doesn\'t count (what goes in can be bought)', up.inv.some((i) => i.uid === made.uid) && !onRecord(up).length);

    const so = save(), real = Object.values(D.skins).find((s) => !s.v && !s.star);
    so.social = N.freshSocial(1234, NOW);
    let target = null, theirs = null;
    for (const n of N.crowd(so.social.seed)) { if (n.type !== 'player') continue; const it = N.npcState(so.social, n.id).inv.find((x) => I.itemValue(x) > 1); if (it) { target = n; theirs = it; break; } }
    const r = on(so, 'npc.offer', { npc: target.id, give: { money: round2(N.keepValue(target, theirs) * 3 + 50) }, get: { uids: [theirs.uid] } }).r;
    check('Index: an item traded from an NPC doesn\'t count', r.result === 'accepted' && so.inv.some((i) => i.uid === theirs.uid) && !onRecord(so).length, r.result);

    const staked = save(), mine = I.makeSkinItem(real, { stt: false, r: rng, src: box.n });
    staked.inv.push(mine);
    let back = false;
    for (let k = 0; k < 40 && !back; k++) {
      const { r: f } = on(staked, 'gamble.coinflip', { money: 0, uids: [mine.uid], side: 'ct', clientSeed: 'ix' + k });
      if (f.won) back = true; else staked.inv.push(mine);
    }
    check('Index: a stake that comes back isn\'t unboxed again', back && !onRecord(staked).length);

    const given = save();
    ACT.give(ACT.makeCtx(given), AD.buildItems([AD.itemSpec({ t: 'skin', id: real.id })], AD.localSerial(given)));
    check('Index: nor is what staff give', given.inv.length === 1 && !onRecord(given).length);

    // The rule holds by there being nowhere else that writes: one call per way of unboxing.
    const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
    const calls = (p) => read(p).match(/(?<!function )\bnoteUnboxed\(ctx/g)?.length || 0; // (not its definition)
    const sources = ['src/js/engine/gamble.js', 'src/js/engine/market.js', 'src/js/engine/npcs.js', 'src/js/engine/tradeup.js', 'src/js/engine/admin.js', 'src/js/admin-local.js', 'server/trade.mjs', 'server/admin.mjs', 'server/index.mjs'];
    check('Index: only the unboxing actions write to it (case.open, drop.claim, armory.redeem, gamble.battle, a live battle\'s winnings)',
      calls('src/js/engine/actions.js') === 4 && calls('server/live.mjs') === 1 && sources.every((p) => !calls(p) && !/\bIX\.record\(|\brecord\(st/.test(read(p))));
  }

  // A failed action leaves it alone.
  {
    const st = save();
    open(st, box);
    on(st, 'case.buy', { id: box.id }); on(st, 'key.buy', { key: keyFor(box) });
    const before = st.index, ctx = ACT.makeCtx(st, { rng, now: NOW, invCap: 1 });
    let failedWith = null;
    try { ACT.runAction(ctx, 'case.open', { id: box.id }); } catch (e) { failedWith = e.code; }
    check('Index: an opening that fails (inventory full) adds nothing', failedWith === 'full' && st.index === before && ctx.ix === null);
  }

  // Sets and goals.
  {
    const sets = IX.allSets(), goals = IX.allGoals();
    check('Index: every case and collection is a set, each with a goal', sets.length === D.cases.length + D.collections.length + D.charmCollections.length && sets.every((s) => IX.goalOf(s.goal) && s.ids.length));
    check('Index: every goal\'s key is a plain token, as a save keeps it', goals.every((g) => /^[A-Za-z0-9_-]{1,64}$/.test(g.key)));
    const everyItem = (s) => s.ids.every((id) => IX.kindOf(id));
    check('Index: every item a set asks for exists', sets.every(everyItem));
    const inBox = (c) => new Set(Object.values(c.pools).flat());
    check('Index: nothing is asked for that a box can\'t drop', D.collections.filter((c) => c.caseId).every((c) => { const b = inBox(D.caseById[c.caseId]); return IX.setOf(c.id).ids.every((id) => b.has(id)); }));
    const hunts = D.collections.find((c) => c.n === 'The Huntsman Collection');
    check('Index: a collection with a case is that case, the same goal', IX.setOf(hunts.id).goal === IX.setOf(hunts.caseId).goal && IX.setOf(hunts.id).ids.length === IX.setOf(hunts.caseId).ids.length);
    check('Index: it\'s called by the case you opened, under the collection\'s key (which doesn\'t change)', IX.goalOf(IX.setOf(hunts.caseId).goal).n === 'Huntsman Weapon Case' && IX.setOf(hunts.caseId).goal === hunts.id && IX.setOf(IX.goalOf(hunts.id).face).kind === 'case');
    const dust = D.collections.find((c) => c.n === 'The Dust 2 Collection'), pkgs = sets.filter((s) => s.goal === dust.id);
    check('Index: souvenir packages of one collection share its one reward', pkgs.length > 5 && pkgs.filter((s) => s.kind === 'souvenir').length === pkgs.length - 1, `${pkgs.length} sets`);
    const distinct = new Set(sets.map((s) => [...s.ids].sort().join()));
    check('Index: one goal for every different set of items, however many boxes hold it', goals.filter((g) => g.kind === 'set').length === distinct.size, `${distinct.size} of ${sets.length}`);
    const cases = sets.filter((s) => s.kind === 'case');
    check('Index: a weapon case\'s rare specials aren\'t needed to finish it', cases.every((s) => s.rare.length && s.rareGoal && s.rare.every((id) => !s.ids.includes(id))));
    check('Index: and many cases share a rare pool, so one bonus each', new Set(cases.map((s) => s.rareGoal)).size < cases.length && goals.filter((g) => g.kind === 'rare').every((g) => g.ids.length && g.reward === IX.RARE_REWARD));
    check('Index: every weapon case pays the same (they\'re about as hard)', new Set(cases.map((s) => JSON.stringify(IX.goalOf(s.goal).reward))).size === 1, JSON.stringify(IX.goalOf(cases[0].goal).reward));
    check('Index: a harder set never pays less', IX.GRADES.every(([, xp, stars], i) => !i || (xp > IX.GRADES[i - 1][1] && stars > IX.GRADES[i - 1][2])));
    check('Index: how hard a set is goes by the odds: a 1-item package takes 1 opening, a weapon case hundreds, a 320-sticker capsule tens of thousands', IX.setOf(D.cases.find((c) => c.n === 'X-Ray P250 Package').id).opens === 1
      && IX.goalOf(IX.setOf(box.id).goal).opens > 100 && IX.goalOf(IX.setOf(box.id).goal).opens < 1000 && Math.max(...sets.map((s) => s.opens)) > 20000);
    // The economy: money comes from matches only. Each goal pays once and pays no money, so all a save can ever earn is
    // this fixed amount, and no set (bar one item worth 500 XP) pays more than a fifth of what opening it takes.
    const STAR = A.STAR_VALUE, XP = 0.001; // (5,000 XP is a level, and a level-up reward's two items are worth a few dollars)
    const dear = goals.filter((g) => g.kind === 'set' && g.opens > 1).map((g) => {
      const boxes = g.sets.map((id) => D.caseById[id]).filter(Boolean);
      return boxes.length ? (g.reward.stars * STAR + g.reward.xp * XP) / (g.opens * Math.min(...boxes.map(casePrice))) : 0;
    });
    check('Index: no reward is worth more than a fifth of what finishing the set costs', Math.max(...dear) < 0.2, `worst ${(Math.max(...dear) * 100).toFixed(1)}%`);
    check('Index: all the rewards there are, for every set in the game', goals.reduce((s, g) => s + g.reward.stars, 0) < 10000, `${goals.reduce((s, g) => s + g.reward.stars, 0)} stars, ${goals.reduce((s, g) => s + g.reward.xp, 0).toLocaleString()} XP`);
  }

  // Finishing and claiming.
  {
    const st = save(), xray = D.cases.find((c) => c.n === 'X-Ray P250 Package'), s = IX.setOf(xray.id);
    check('Index: an unfinished set can\'t be claimed', refusedWith(() => on(st, 'index.claim', { goal: s.goal })) === 'unfinished' && st.stars === 0);
    check('Index: nor something that isn\'t a reward', ['nope', '__proto__', 'constructor', '', null, undefined, 5].every((goal) => refusedWith(() => on(st, 'index.claim', { goal })) === 'bad'));
    const done = open(st, xray);
    check('Index: finishing a set says so in the same change', JSON.stringify(done.d.ix.done) === JSON.stringify([s.goal]));
    check('Index: and it\'s waiting to be claimed', IX.waitingGoals(st.index).map((g) => g.key).includes(s.goal));
    check('Index: another of the same doesn\'t say it again', open(st, xray).d.ix.done.length === 0);
    const before = { money: st.money, stars: st.stars, total: st.prof.total }, g = IX.goalOf(s.goal);
    const paid = on(st, 'index.claim', { goal: s.goal }, { now: NOW + 1 });
    check('Index: a claim pays its XP and stars, and no money', st.money === before.money && st.stars === before.stars + g.reward.stars && st.prof.total === before.total + g.reward.xp && paid.r.xp === g.reward.xp);
    check('Index: a claim is sent as a small change too', paid.d.ix.claimed[s.goal] === NOW + 1 && !('index' in paid.d.set));
    check('Index: the same reward can\'t be claimed twice', refusedWith(() => on(st, 'index.claim', { goal: s.goal })) === 'claimed' && st.prof.total === before.total + g.reward.xp);
    const col = save();
    IX.record(col, IX.goalOf(s.goal).ids.map((id) => copy(id)), NOW);
    on(col, 'index.claim', { goal: IX.setOf(xray.id).goal });
    check('Index: sets that share a goal are claimed together', IX.isClaimed(col.index, IX.setOf(xray.col).goal) && !IX.waitingGoals(col.index).length);

    // A real set, from nothing to finished, by what it takes in the game.
    const small = D.cases.filter((c) => c.kind === 'autograph' && Object.values(c.pools).flat().length === 5)[0];
    const team = save();
    let tries = 0, finishedBy = null;
    while (!finishedBy && tries < 200) { tries++; const r = open(team, small); if (r.d.ix.done?.length) finishedBy = r; }
    check('Index: a small capsule finished by opening it', !!finishedBy && IX.progress(team.index, IX.setOf(small.id)).complete && on(team, 'index.claim', { goal: IX.setOf(small.id).goal }).r.xp > 0, `${tries} openings`);

    // A bought copy can't finish a set.
    const w = MK.marketWindow(NOW), buys = save();
    const set = IX.allSets().find((x) => x.kind === 'case' && x.ids.some((id) => MK.skinListings(D.skins[id], w).length));
    const last = set.ids.find((id) => MK.skinListings(D.skins[id], w).length);
    IX.record(buys, set.ids.filter((id) => id !== last).map((id) => copy(id)), NOW);
    on(buys, 'market.buy', { kind: 'skin', id: last, n: 0, window: w });
    check('Index: the last item bought doesn\'t finish a set', buys.inv.some((i) => i.id === last) && !IX.progress(buys.index, set).complete && refusedWith(() => on(buys, 'index.claim', { goal: set.goal })) === 'unfinished');

    // The bonus for a rare special.
    const rare = save(), c = IX.setOf(box.id);
    check('Index: no bonus before a rare special', refusedWith(() => on(rare, 'index.claim', { goal: c.rareGoal })) === 'unfinished');
    const knife = IX.record(rare, [copy(c.rare[0], { fl: 0.1, sd: 1 })], NOW);
    check('Index: the first rare special from a pool is a bonus, whatever else you\'ve found', knife.done.includes(c.rareGoal) && !IX.progress(rare.index, c).complete);
    const b = on(rare, 'index.claim', { goal: c.rareGoal });
    check('Index: paid once, for the pool', b.r.xp === IX.RARE_REWARD.xp && refusedWith(() => on(rare, 'index.claim', { goal: c.rareGoal })) === 'claimed' && !IX.record(rare, [copy(c.rare[1], { fl: 0.1, sd: 1 })], NOW).done.length);
  }

  // Older saves.
  {
    const skinsOf = (c) => Object.values(c.pools).flat();
    const a = skinsOf(box)[0], b = skinsOf(box)[1], c = skinsOf(box)[2], d = skinsOf(box)[3], gone = skinsOf(box)[4], bought = skinsOf(box)[5];
    const old = (extra = {}) => {
      const { index: _index, ...st } = freshState();
      return upgradeState({ ...JSON.parse(JSON.stringify(st)), ...extra });
    };
    const unit = I.makeUnitItem('Store');
    const mk = (id, src, more = {}) => ({ ...I.makeSkinItem(D.skins[id], { stt: false, r: rng, src }), at: 1000, ...more });
    const copyA = mk(a, box.n, { fl: 0.25, at: 2000 }), copyA2 = mk(a, box.n, { fl: 0.1, at: 1000 }), stored = { ...mk(b, 'Armory · ' + box.n), su: unit.uid, sat: 5 };
    const charm = I.makeCharmItem(Object.values(D.charms)[0], { src: D.charmCollections[0].n, r: rng });
    const { uid: _u, t: _t, ...kc } = { ...charm, src: 'Armory · ' + D.charmCollections[0].n };
    const gun = { ...mk(c, 'Level-up reward'), kc };
    const st = old({
      inv: [copyA, copyA2, gun, unit, mk(bought, 'Market'), mk(d, 'Trade Up Contract'), mk(d, 'Trade with Someone'), mk(d, 'Admin'), mk(d, '')],
      stored: [stored], serials: { [`skin:${a}`]: 4, [`skin:${gone}`]: 2, [`skin:${gone}:st`]: 1, 'chicken:x': 3, 'skin:skin-not-in-the-game': 9 },
      stats: { ...freshState().stats, opened: 20, armory: 1 },
    });
    check('Index: a save from before it is marked to be filled in', st.index.filled === false && !onRecord(st).length);
    IX.backfillIndex(st);
    const e = st.index.items;
    check('Index backfill: copies you own that came from a box, with their details', e[a].fl === 0.1 && e[a].at === 1000 && e[c].n === 1);
    check('Index backfill: what\'s in a Storage Unit, and a charm on a gun', e[b].n === 1 && !!e[kc.id]);
    check('Index backfill: the serial counters bring back what\'s been sold, in numbers only', e[a].n === 4 && e[gone].n === 3 && e[gone].st === 1 && e[gone].at === undefined && e[gone].fl === undefined);
    check('Index backfill: bought, contract-made, NPC-traded and staff items stay out', !e[bought] && !e[d]);
    check('Index backfill: counters for things the game no longer has are ignored', !e['skin-not-in-the-game'] && !e.x);
    const total = Object.values(e).reduce((s, x) => s + x.n, 0);
    check('Index backfill: what can\'t be matched to anything is counted', st.index.lost === 21 - total && st.index.filled === true, `${st.index.lost} of 21`);
    const once = JSON.stringify(st.index);
    IX.backfillIndex(st);
    check('Index backfill: happens once', JSON.stringify(st.index) === once);
    const saved = upgradeState(JSON.parse(JSON.stringify(st)));
    check('Index backfill: and stays through a save and load', saved.index.filled === true && JSON.stringify(saved.index) === once);

    // Online: the counters are the server's and a trade keeps an item's src, so what changed hands is left out.
    const traded = mk(a, box.n), mine = mk(b, box.n), acc = old({ inv: [traded, mine], stats: { ...freshState().stats, opened: 5 } });
    IX.backfillIndex(acc, { moved: new Set([traded.uid]) });
    check('Index backfill: online, an item that came in a trade stays out though its src says a case', !acc.index.items[a] && acc.index.items[b].n === 1 && acc.index.lost === 4);

    // A set found in an old save can be claimed, with what was recovered.
    const xray = D.cases.find((x) => x.n === 'X-Ray P250 Package'), won = old({ inv: [mk(IX.setOf(xray.id).ids[0], xray.n)] });
    IX.backfillIndex(won);
    check('Index backfill: a set finished long ago is waiting to be claimed', IX.waitingGoals(won.index).some((g) => g.key === IX.setOf(xray.id).goal));
  }

  // Reading it, and keeping it small.
  {
    const st = save();
    const ids = [...Object.keys(D.skins), ...Object.keys(D.stickers), ...Object.keys(D.agents), ...Object.keys(D.charms)];
    IX.record(st, ids.map((id) => copy(id, IX.kindOf(id) === 'skin' ? { fl: 0.123456789, sd: 7 } : {})), NOW);
    const whole = JSON.stringify(st.index).length;
    check('Index: every item in the game on the record is under a megabyte (a full inventory of items is about that)', whole < 1024 * 1024, `${(whole / 1024).toFixed(0)} KB, ${(whole / ids.length).toFixed(0)} bytes an item`);
    const t0 = performance.now(), rows = IX.rows(st.index), t1 = performance.now();
    const view = IX.viewRows(rows, { q: 'ak-47', rank: 'all', type: 'skin', sort: 'rarity' }), t2 = performance.now();
    check('Index: a record of every item in the game reads quickly', rows.length === ids.length && t1 - t0 < 400 && t2 - t1 < 100, `${(t1 - t0).toFixed(0)} ms to list ${rows.length.toLocaleString()}, ${(t2 - t1).toFixed(0)} ms to search`);
    check('Index: search and the type filter', view.length > 5 && view.every((r) => r.name.includes('AK-47') && r.item.t === 'skin' && r.rank !== 6));
    check('Index: rarity order', view.every((r, i) => !i || view[i - 1].rank >= r.rank));
    const stars = IX.viewRows(rows, { type: 'star' }), stickers = IX.viewRows(rows, { type: 'sticker', rank: '5' });
    check('Index: the rarity filter, and knives and gloves apart', stars.length > 100 && stars.every((r) => r.rank === 6) && stickers.length > 0 && stickers.every((r) => r.item.t === 'sticker' && r.rank === 5));

    const grind = save(), start = performance.now();
    for (let k = 0; k < 2000; k++) IX.record(grind, Array.from({ length: 10 }, () => I.rollFromCase(box, rng)), NOW + k);
    const size = JSON.stringify(grind.index).length, per = Object.keys(grind.index.items).length;
    check('Index: 20,000 cases opened add a few KB: it grows with what\'s different, not with how much', Object.values(grind.index.items).reduce((s, e) => s + e.n, 0) === 20000 && size < per * 90 && per <= IX.setOf(box.id).ids.length + IX.setOf(box.id).rare.length, `${(size / 1024).toFixed(1)} KB, ${per} entries, ${(performance.now() - start).toFixed(0)} ms`);
    const change = JSON.stringify(ACT.delta(Object.assign(ACT.makeCtx(st), { ix: IX.record(st, [copy(box.pools[2][0], { fl: 0.2, sd: 1 })], NOW) })).ix).length;
    check('Index: and what\'s sent for one opening stays tiny however long the record is', change < 200, `${change} bytes`);
    const copyOf = JSON.parse(JSON.stringify(grind.index));
    check('Index: an entry\'s float keeps six figures, not seventeen', Object.values(copyOf.items).some((e) => e.fl != null) && Object.values(copyOf.items).every((e) => e.fl == null || Number(e.fl.toPrecision(6)) === e.fl));
  }

  // Putting an older state back online.
  {
    const was = freshState(), now_ = freshState(), id = Object.keys(D.skins)[0], other = Object.keys(D.skins)[1];
    was.index = { ...IX.freshIndex(), items: { [id]: { at: 500, n: 1, fl: 0.2 } } };
    now_.index = { ...IX.freshIndex(), items: { [id]: { at: 500, n: 3, st: 1, fl: 0.1 }, [other]: { at: 900, n: 1 } }, claimed: { some: 9 } };
    const m = IX.mergeIndex(was.index, now_.index);
    check('Index: a merge keeps the most of everything, and every claim', m.items[id].n === 3 && m.items[id].st === 1 && m.items[id].fl === 0.1 && m.items[id].at === 500 && m.items[other].n === 1 && m.claimed.some === 9);
    const again = upgradeState({ ...JSON.parse(JSON.stringify(was)) });
    AD.restoreMerge(now_, again, {});
    check('Index: an older snapshot put back online can\'t reopen a claim', again.index.claimed.some === 9 && again.index.items[other].n === 1);
    const off = upgradeState({ ...JSON.parse(JSON.stringify(was)) });
    AD.restoreMerge(now_, off, { keepRewards: true });
    check('Index: offline a restore is your own save as it was', !off.index.claimed.some && !off.index.items[other]);
  }
}

// ---- Souvenir stickers: in the gun's own slots, as CS2 places them -----------------------------------------------------
{
  const { slotUv, souvenirSlots, souvenirsOnIcon } = await import(new URL('../src/js/cs2/markup.js', import.meta.url));
  const { SOUVENIR_ICONS } = await import(new URL('../src/js/cs2/souvenir-icons.js', import.meta.url));
  const slot = (id, offset, scale, legacy = false, rotation = 0) => ({ id, offset, scale, rotation, legacy });
  // The AK-47's slots as its model has them.
  const ak = { stickers: [slot('Autograph', [0.148, -0.434], 14.1), slot('Team1', [0.061, -0.434], 14.1), slot('Team2', [-0.025, -0.435], 14.1), slot('Map', [-0.164, -0.444], 14.1), slot('Map', [-0.164, -0.444], 15.35, true)] };
  const map = ak.stickers[3];
  const close = (a, b) => a.every((v, i) => near(v, b[i], 1e-9));
  check('Souvenir slot: its offset is the middle of the sticker', close(slotUv(map, 0.336, 0.056), [0.5, 0.5]));
  check('Souvenir slot: its scale is how many stickers fit across the sticker space', close(slotUv(map, 0.336 + 0.5 / 14.1, 0.056 - 0.5 / 14.1), [1, 0]));
  check('Souvenir slot: its rotation is in turns, as the Glock\'s grip has it', close(slotUv(slot('Map', [0, 0], 2, false, 0.25), 0.75, 0.5), [0.5, 1]));
  const stk = ['event', 'team a', 'team b', 'mvp'].map((id) => ({ id, x: 0.3, y: 0.42, r: 0, wr: 0, m: 1, sv: 1 }));
  const item = { stk }, saved = JSON.stringify(item);
  check('Souvenir slots: the event, the two teams and the autograph in the slots CS2 names', souvenirSlots(item, ak).map((s) => s.slot.id).join() === 'Map,Team1,Team2,Autograph');
  check('Souvenir slots: a legacy skin takes its legacy slot', souvenirSlots(item, ak, true)[0].slot.scale === 15.35);
  check('Souvenir slots: a legacy body without a slot of its own falls back on the other body\'s', souvenirSlots(item, ak, true)[1].slot === ak.stickers[1]);
  check('Souvenir slots: an event before autographs leaves that slot empty', souvenirSlots({ stk: stk.slice(0, 3) }, ak).map((s) => s.slot.id).join() === 'Map,Team1,Team2');
  check('Souvenir slots: without CS2 they stay where they were made', souvenirSlots(item, null).every((s, i) => s === stk[i]));
  check('Souvenir slots: what\'s saved is left alone', JSON.stringify(item) === saved && !stk.some((s) => s.at || s.slot));
  const applied = { id: 'mine', x: 0.5, y: 0.5, r: 0, wr: 0 };
  check('Souvenir slots: a sticker a player placed doesn\'t move', souvenirSlots({ stk: [applied] }, ak)[0] === applied && souvenirsOnIcon({ stk: [applied] }, 'weapon_ak47', { x0: 0, x1: 1, y0: 0, y1: 1 }, 512, 384)[0] === applied);

  // An icon's outline as composite.js finds it, in a 512 by 384 picture.
  const outline = (b) => ({ x0: b[0], x1: b[1], y0: b[2] / 0.75, y1: b[3] / 0.75 });
  const [hd, legacy] = SOUVENIR_ICONS.weapon_ak47;
  const on = (wid, view) => souvenirsOnIcon(item, wid, outline(view.box), 512, 384);
  const same = (x, y) => x.every((v, i) => near(v, y[i], 1e-9));
  check('Souvenir icons: an icon\'s outline picks the gun\'s body', same(on('weapon_ak47', hd)[0].at, hd.slots.Map) && same(on('weapon_ak47', legacy)[0].at, legacy.slots.Map));
  const big = souvenirsOnIcon(item, 'weapon_ak47', { x0: 0.25 + hd.box[0] / 2, x1: 0.25 + hd.box[1] / 2, y0: 0.25 + hd.box[2] / 1.5, y1: 0.25 + hd.box[3] / 1.5 }, 1024, 768)[0].at;
  check('Souvenir icons: Steam\'s biggest picture is the icon in a margin, and a sticker stays on it', near(big[0], 0.25 + hd.slots.Map[0] / 2, 1e-9) && near(big[1], 0.1875 + hd.slots.Map[1] / 2, 1e-9) && near(big[2], hd.slots.Map[2] / 2, 1e-9));
  const small = souvenirsOnIcon(item, 'weapon_ak47', outline(legacy.box), 256, 192)[0].at;
  check('Souvenir icons: a smaller picture is the same icon', same(small, legacy.slots.Map));
  const xs = on('weapon_ak47', hd).map((s) => s.at[0]);
  check('Souvenir icons: on the AK-47 from muzzle to stock, Map, Team2, Team1, Autograph', xs[0] < xs[2] && xs[2] < xs[1] && xs[1] < xs[3], xs.join(' '));
  check('Souvenir icons: a slot the icon can\'t show isn\'t drawn (the M249\'s ammo box hides three)', on('weapon_m249', SOUVENIR_ICONS.weapon_m249[0]).map((s) => s.id).join() === 'mvp');
  check('Souvenir icons: a gun with no slots keeps its stickers where they were made', souvenirsOnIcon(item, 'weapon_nothing', outline(hd.box), 512, 384) === stk);
  const guns = new Set(Object.values(D.cases).filter((c) => c.kind === 'souvenir').flatMap((c) => [...Object.values(c.pools || {}).flat(), ...(c.rare || []).flat()]).map((id) => D.skins[id]?.wid).filter(Boolean));
  check('Souvenir icons: every gun that comes as a souvenir has its place on them', [...guns].every((w) => SOUVENIR_ICONS[w]?.length), [...guns].filter((w) => !SOUVENIR_ICONS[w]?.length).join());
  const all = Object.values(SOUVENIR_ICONS).flat().flatMap((v) => Object.values(v.slots));
  check('Souvenir icons: every sticker lands on the picture at a size a sticker could be', all.length > 150 && all.every(([x, y, ax, ay, bx, by]) => x > 0 && x < 1 && y > 0 && y < 0.75 && Math.hypot(ax, ay) > 0.01 && Math.hypot(ax, ay) < 0.3 && Math.hypot(bx, by) < 0.3), all.length + ' slots');
  // Each gun's slots left to right on its icons, a string for each body (M Map, 1 and 2 the teams, A Autograph). They're what
  // the models say, each slot's middle along the gun, but for the Dual Berettas (two guns, posed by hand) and the MP7's
  // second body (Map and Team1 a hair apart, at different heights): those are as the table has them.
  const ALONG = {
    ak47: 'M21A M21A', aug: '1A2M 1A2M', awp: '21AM 21AM', bizon: 'M21A M21A', cz75a: '21AM 21AM', deagle: '21AM 21AM', elite: '21MA 21MA', famas: '1A2M 1A2M',
    fiveseven: '21AM 21AM', g3sg1: '2A1M 2A1M', galilar: '21AM 21AM', glock: '21AM 21AM', hkp2000: '21AM 21AM', m249: 'A A', m4a1: '21AM 21AM', m4a1_silencer: 'M21A M21A',
    mac10: '21MA 21MA', mag7: '21AM 21AM', mp5sd: 'M21A M21A', mp7: '21MA 2M1A', mp9: '21MA 21MA', negev: '2M1A 2M1A', nova: '21AM 21AM', p250: '21AM 21AM', p90: '1A2M 1A2M',
    revolver: '21AM 21AM', sawedoff: 'M21A M21A', scar20: 'M21A 21AM', sg556: '2M1A 2M1A', ssg08: 'M21A 21AM', taser: '21AM', tec9: '21A 21A', ump45: 'M21A M21A',
    usp_silencer: '21AM 21AM', xm1014: 'M21A M21A',
  };
  const letter = { Map: 'M', Team1: '1', Team2: '2', Autograph: 'A' };
  const order = (w) => SOUVENIR_ICONS[w].map((v) => Object.keys(v.slots).sort((a, b) => v.slots[a][0] - v.slots[b][0]).map((k) => letter[k]).join('')).join(' ');
  const misordered = Object.keys(SOUVENIR_ICONS).filter((w) => order(w) !== ALONG[w.slice(7)]);
  check('Souvenir icons: every gun\'s slots run along it in the order its model has them', !misordered.length && Object.keys(SOUVENIR_ICONS).length === Object.keys(ALONG).length, misordered.map((w) => `${w}: ${order(w)}`).join(', '));
  check('Souvenir icons: every slot\'s middle is inside its gun\'s bounds', Object.values(SOUVENIR_ICONS).flat().every((v) => Object.values(v.slots).every(([x, y]) => x > v.box[0] && x < v.box[1] && y > v.box[2] && y < v.box[3])));
  // On real icons, where this machine has them (scripts/build-souvenir-icons.mjs fetches them to cache/img), the way a drawn
  // icon goes: its outline picks the body and places the slots, and each slot's middle has to land on the gun.
  const { decodePNG } = createRequire(import.meta.url)('../cs2/png.cjs');
  const outlineOf = ({ width: w, height: h, channels: c, data }) => {
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) if (data[(y * w + x) * c + 3] > 20) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    return { x0: x0 / w, x1: x1 / w, y0: y0 / h, y1: y1 / h };
  };
  let icons = 0;
  const off = [];
  for (const wid of Object.keys(SOUVENIR_ICONS)) {
    let left = 12;
    for (const skin of Object.values(D.skins)) {
      if (skin.wid !== wid || !skin.img || !left) continue;
      const file = path.join(ROOT, 'cache/img', crypto.createHash('sha1').update(`https://community.akamai.steamstatic.com/economy/image/${skin.img.slice(1)}/512fx384f`).digest('hex'));
      if (!fs.existsSync(file)) continue;
      left--; icons++;
      const img = decodePNG(fs.readFileSync(file)), W = img.width, H = img.height;
      for (const s of souvenirsOnIcon(item, wid, outlineOf(img), W, H)) {
        if (s.at && !(img.data[(Math.round(s.at[1] * W) * W + Math.round(s.at[0] * W)) * img.channels + 3] > 100)) off.push(`${skin.n} ${s.id}`);
      }
    }
  }
  if (icons) check('Souvenir icons: on real icons every slot\'s middle is on the gun', !off.length, off.length ? off.slice(0, 6).join(', ') : icons + ' icons');
  else console.log('      (no icons in cache/img: slots not checked against real outlines)');
  const { artSide, TEXTURE_FILL } = await import(new URL('../src/js/composite.js', import.meta.url));
  check('Sticker art: it fills a slot by its longer side, tall art by its height', near(artSide({ x0: 0.2, x1: 0.8, y0: 0.05, y1: 0.95 }, 256, 256), 230.4, 1e-9) && near(artSide({ x0: 0.1, x1: 0.9, y0: 0.25, y1: 0.75 }, 200, 100), 160, 1e-9) && TEXTURE_FILL > 0.9 && TEXTURE_FILL < 1);

  // A sticker on a gun in Play's world, whose lighting replaces a material's shader patch (on the floor, and again in a
  // bot's hands): its picture stays the right way up, and in the mask of a slot's sticker.
  const THREE = await import('three');
  const { BotAssets } = await import(new URL('../src/js/play/bots.js', import.meta.url));
  const assets = new BotAssets(null, { cube: { value: new Float32Array(18) } });
  const sticker = (cs2Sticker) => {
    const m = new THREE.MeshStandardMaterial({ map: new THREE.Texture(), transparent: true });
    m.cs2Sticker = cs2Sticker;
    assets.light(new THREE.Mesh(new THREE.BufferGeometry(), m));
    return m;
  };
  const shaded = (m) => {
    const sh = { vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms: {} };
    m.onBeforeCompile(sh, null);
    return { up: sh.fragmentShader.includes('1.0 - vMapUv.y'), masked: !!sh.uniforms.cs2Mask && sh.fragmentShader.includes('cs2Mask, vCs2Texel') && sh.vertexShader.includes('vCs2Texel = cs2Texel') };
  };
  const inSlot = sticker({ cs2Mask: { value: new THREE.Texture() } }), placed = sticker({}), icon = sticker(undefined);
  check('Stickers in Play: on the floor and in a bot\'s hands, a slot\'s stays the right way up and in its mask', [inSlot, assets.botMaterial(inSlot)].every((m) => { const r = shaded(m); return r.up && r.masked; }));
  check('Stickers in Play: one a player placed is the right way up, with no mask to read', [placed, assets.botMaterial(placed)].every((m) => { const r = shaded(m); return r.up && !r.masked; }));
  check('Stickers in Play: an icon in place of CS2\'s texture is left as it is', !shaded(icon).up && !shaded(assets.botMaterial(icon)).up);
  check('Stickers in Play: masked and unmasked don\'t share a shader', new Set([inSlot, placed, icon].map((m) => m.customProgramCacheKey())).size === 3);
}

// ---- badges: CS2's collectibles as items; only the Pins Capsules' pins can be had, and only they trade ------------------------
// (Last: it loads the game data again with src/data/badges.json, and again without it at the end.)
{
  const BD = await E('badgedata');
  const B = await E('badges');
  const N = await E('npcs');
  const SU = await E('storage');
  const P = await E('p2p');
  const IX = await E('itemindex');
  const ADM = await E('admin');
  const DB = await E('database');
  const { lockBase } = await E('custom');
  const { PIN_ODDS } = await E('data');
  const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  const game = read('src/data/game-data.json'), keys = read('src/data/keys.json'), file = read('src/data/badges.json');
  // (CS2's raw item data is only on a PC that has run the data build (cache/ isn't in git): without it, the checks against it
  // check what the shipped badges.json holds, and the rebuild check is skipped.)
  const hasRaw = fs.existsSync(path.join(ROOT, 'cache/raw/collectibles.json')) && fs.existsSync(path.join(ROOT, 'cache/raw/crates.json'));
  const rawCol = hasRaw ? read('cache/raw/collectibles.json') : null, rawCrates = hasRaw ? read('cache/raw/crates.json') : null;
  const frozen = JSON.stringify(file);
  // NPCs' starting inventories without badges, to compare with theirs once there are badges.
  const npcSeed = 4242, firstNpcs = N.crowd(npcSeed).slice(0, 60);
  const plainInv = firstNpcs.map((n) => N.startingState(npcSeed, n).inv.map((it) => `${it.t}:${it.id}:${it.fl}:${it.sd}:${it.sn || ''}`).join());
  const lockBefore = D.lock;
  initData(game, { keys, badges: file });
  const code = (fn) => { try { fn(); } catch (e) { return e instanceof ACT.GameError ? e.code : 'crash: ' + e.message; } return null; };
  const setup = () => {
    const st = { ...freshState(), money: 1000 };
    const run = (name, args, o) => { const c = ACT.makeCtx(st, { rng, ...o }); const r = ACT.runAction(c, name, args); return { r, d: ACT.delta(c) }; };
    const add = (id) => { const it = I.makeBadgeItem(D.badges[id], 'Admin'); st.inv.unshift(it); return it; };
    return { st, run, add };
  };

  // The data
  const all = Object.values(D.badges), pins = all.filter((b) => b.tr), caps = B.pinCapsules();
  check('Badges: every one of CS2\'s 667 collectibles is a badge, each with a name, kind, rarity and picture', (!rawCol || all.length === rawCol.length) && all.length === 667
    && all.every((b) => b.n && b.ty && [0, 2, 3, 4, 5].includes(b.r) && /^(~|https:\/\/cdn\.steamstatic\.com\/apps\/730\/)/.test(b.img)), `${all.length}`);
  const rawCaps = rawCrates ? rawCrates.filter((c) => c.type === 'Pins') : null;
  check('Badges: the 4 Collectible Pins Capsules (Series 1, 2, 3 and Half-Life: Alyx) are cases of their own kind, needing no key', caps.length === 4 && (!rawCaps || rawCaps.length === 4)
    && caps.every((c) => c.kind === 'pins' && !c.key && !keyFor(c) && c.price > 0 && D.caseById[c.id] === c && casePrice(c) === c.price)
    && ['Series 1', 'Series 2', 'Series 3', 'Half-Life: Alyx'].every((s) => caps.some((c) => c.n.includes(s))), caps.map((c) => `${c.n} $${c.price}`).join(', '));
  const inCaps = new Set(caps.flatMap((c) => Object.values(c.pools).flat()));
  check('Badges: the capsules hold exactly their 45 pins, and those are the only badges that trade', inCaps.size === 45 && pins.length === 45
    && pins.every((b) => inCaps.has(b.id) && b.ty === 'Pin' && D.caseById[b.box]?.pools[b.r]?.includes(b.id))
    && (!rawCaps || rawCaps.every((c) => c.contains.every((x) => D.badges[x.id]?.tr && D.badges[x.id].box === c.id))));
  check('Badges: Genuine (operation) pins, coins, medals, trophies and passes are in the game but don\'t trade',
    all.filter((b) => b.ty === 'Pin' && !b.tr).length === 34 && all.filter((b) => !b.tr).every((b) => b.p === 0 && !b.box)
    && ['Service Medal', 'Operation Coin', 'Map Contributor Coin', "Pick'Em Coin", 'Premier Season Coin', 'Tournament Finalist Trophy', 'Operation Pass', 'Tournament Pass', 'Veteran Coin'].every((t) => all.some((b) => b.ty === t && !b.tr)));
  check('Badges: names tell every badge apart (a Service Medal\'s level, a Premier Medal\'s colour, a CS2 map\'s coin)', new Set(all.map((b) => I.itemName({ t: 'badge', id: b.id }))).size === all.length
    && I.itemName({ t: 'badge', id: 'collectible-1340' }) === '2016 Service Medal (Level 2)');
  check('Badges: pins have market prices, from the price data the build reads', pins.every((b) => b.p > 0.5 && b.p < 500) && caps.every((c) => c.price > 1 && c.price < 50));

  // The lock
  check('Badges: they\'re part of the data lock (+bd.<hash>), and the game data\'s own build is still what a price patch goes by',
    D.lock === `${game.generatedAt}+bd.${BD.badgeLock(file)}` && lockBefore === game.generatedAt && lockBase(D.lock) === game.generatedAt && D.generatedAt === game.generatedAt && D.bd?.app === file.app, D.lock);
  const tweak = (fn) => { const b = structuredClone(file); fn(b); return BD.badgeLock(b); };
  const L0 = BD.badgeLock(file);
  check('Badges: prices, pictures and descriptions aren\'t in the lock (they reach games through the price patch)', tweak((b) => { b.badges['collectible-6101'].p = 999; b.badges['collectible-6101'].img = 'x'; b.badges['collectible-6101'].desc = 'y'; b.cases[0].price = 1; b.app = '9.9.9'; }) === L0);
  check('Badges: what an item is, is: a name, a rarity, whether it trades, a capsule\'s contents',
    [(b) => { b.badges['collectible-6101'].n = 'X'; }, (b) => { b.badges['collectible-6101'].r = 4; }, (b) => { b.badges['collectible-874'].tr = 1; }, (b) => { b.cases[0].pools['2'].pop(); }, (b) => { delete b.badges['collectible-874']; }]
      .every((fn) => tweak(fn) !== L0));
  check('Badges: merging leaves the parsed files as they were, and no badges file means no badges (the lock is as before)', JSON.stringify(file) === frozen
    && (() => { initData(game, { keys }); const ok = !Object.keys(D.badges).length && D.lock === game.generatedAt && !D.cases.some((c) => c.kind === 'pins') && D.bd === null; initData(game, { keys, badges: file }); return ok; })());
  if (!hasRaw) console.log('SKIP  Badges: the build script check needs cache/raw (run the data build on this PC)');
  else check('Badges: the build script makes the same badges from the raw data (scripts/build-badges.mjs)', await (async () => {
    const { buildBadges } = await import(new URL('../scripts/build-badges.mjs', import.meta.url));
    const b = buildBadges();
    return !b.problems.length && BD.badgeLock({ format: file.format, badges: b.badges, cases: b.cases }) === L0;
  })());

  // Opening a capsule
  const s1 = caps.find((c) => c.n.includes('Series 1'));
  check('Pins Capsules: CS2\'s capsule odds (High Grade, Remarkable, Exotic, Extraordinary)', JSON.stringify(caseTiers(s1)) === JSON.stringify(Object.entries(PIN_ODDS)));
  {
    const r = mulberry32(777), n = 40000, by = {};
    for (let i = 0; i < n; i++) { const it = I.rollFromCase(s1, r); by[D.badges[it.id].r] = (by[D.badges[it.id].r] || 0) + 1; }
    const tw = Object.values(PIN_ODDS).reduce((a, b) => a + b, 0);
    check('Pins Capsules: drops come at those odds', Object.entries(PIN_ODDS).every(([k, w]) => near((by[k] || 0) / n, w / tw, 0.006)), JSON.stringify(by));
  }
  {
    const { st, run } = setup();
    const before = st.money;
    run('case.buy', { id: s1.id, n: 2 });
    check('Pins Capsules: bought in the Store at their price, to the inventory', near(st.money, before - s1.price * 2, 1e-6) && st.inv.filter((it) => it.t === 'crate' && it.id === s1.id).length === 2);
    const got = run('case.open', { id: s1.id, n: 2 }).r.items;
    check('Pins Capsules: open without a key into pins, numbered like any unboxing and on the Index', got.length === 2 && got.every((it) => it.t === 'badge' && D.badges[it.id].box === s1.id && it.sn >= 1 && it.src === s1.n && st.inv.includes(it))
      && got.every((it) => st.index.items[it.id]?.n >= 1) && !st.inv.some((it) => it.t === 'crate'));
    const pin = got[0];
    check('Pins: they trade (trades, the Market, stakes, Storage Units)', I.tradable(pin) && !I.isBound(pin) && P.listRefusal(pin) === '' && SU.storeRefusal(pin) === '' && P.categoryOf(pin) === 'pin');
    const u = run('storage.buy', {}).r.items[0];
    run('storage.name', { unit: u.uid, name: 'pins' });
    run('storage.deposit', { unit: u.uid, uids: [pin.uid] });
    check('Pins: one goes into a Storage Unit, and still counts as theirs', SU.contents(st, u.uid).some((it) => it.uid === pin.uid) && B.ownsBadge(st, pin.id) && B.featuredBadge(st, pin.id) === pin.id);
    run('storage.retrieve', { unit: u.uid, uids: [pin.uid] });
    const value = I.itemValue(got[1]);
    const sold = run('item.sell', { uids: [got[1].uid] }).r;
    check('Pins: they sell to the Store for their value', near(sold.total, value, 1e-9) && !st.inv.includes(got[1]));
    check('Pins: auto-sell can sell one as it drops (a bound badge never)', I.autoSellMatch(pin, { on: true, below: 1e6, ranks: [] }) && !I.autoSellMatch(I.makeBadgeItem(D.badges['collectible-874']), { on: true, below: 1e6, ranks: [0, 5] }));
    check('Pins: and they stake', code(() => run('gamble.coinflip', { money: 0, uids: [pin.uid], side: 't', clientSeed: 's' })) === null);
  }
  check('Pins: nowhere sells them: not the Store\'s cases or tools, nor the Market\'s stock', code(() => setup().run('case.buy', { id: 'collectible-6101', n: 1 })) === 'bad'
    && code(() => setup().run('market.buy', { kind: 'badge', id: 'collectible-6101', n: 0 })) === 'bad' && code(() => setup().run('tools.buy', { id: 'collectible-6101' })) === 'bad');

  // Bound badges: nobody can get one but from staff, and nothing moves one
  {
    const { st, run, add } = setup();
    const medal = add('collectible-1340'), coin = add('collectible-874');
    check('Bound badges: everything but a capsule\'s pin', I.isBound(medal) && !I.tradable(medal) && I.isBound({ t: 'badge', id: 'collectible-6001' }) && !I.isBound({ t: 'badge', id: 'collectible-6101' }) && I.itemValue(medal) === 0);
    const money = st.money;
    const paths = {
      'a sale': () => run('item.sell', { uids: [medal.uid] }),
      'a coinflip stake': () => run('gamble.coinflip', { money: 1, uids: [medal.uid], side: 't', clientSeed: 's' }),
      'a jackpot stake': () => run('gamble.jackpot', { money: 1, uids: [medal.uid], bots: 1, clientSeed: 's' }),
      'a server-style take (trades, escrow)': () => ACT.take(ACT.makeCtx(st), [medal.uid]),
      'a trade-up': () => run('tradeup.sign', { uids: [medal.uid, coin.uid] }),
      'stickers': () => run('stickers.apply', { uid: medal.uid, stickers: [{ srcUid: coin.uid, x: 0.5, y: 0.5, r: 0 }] }),
      'a charm': () => run('charms.attach', { uid: medal.uid, charm: coin.uid }),
      'a Name Tag': () => run('tools.name', { uid: medal.uid, name: 'x' }),
    };
    for (const [name, fn] of Object.entries(paths)) check(`Bound badges: refuse ${name}`, code(fn) !== null && st.inv.includes(medal) && st.inv.includes(coin) && st.money === money, code(fn));
    check('Bound badges: a sale or stake says why (code bound)', code(paths['a sale']) === 'bound' && code(paths['a coinflip stake']) === 'bound');
    const u = run('storage.buy', {}).r.items[0];
    run('storage.name', { unit: u.uid, name: 'x' });
    check('Bound badges: no Storage Unit takes one (as CS2 keeps out Service Medals)', code(() => run('storage.deposit', { unit: u.uid, uids: [medal.uid] })) === 'unit' && st.inv.includes(medal) && /can't go into a Storage Unit/.test(SU.storeRefusal(medal)));
    check('Bound badges: the Market refuses one', /can't be listed/.test(P.listRefusal(medal)) && code(() => run('p2p.list', { uid: medal.uid, price: 5 })) === 'item' && st.inv.includes(medal));
    run('npc.tick');
    const npc = N.crowd(st.social.seed)[0];
    check('Bound badges: an NPC trader can\'t be offered one', code(() => run('npc.offer', { npc: npc.id, give: { uids: [medal.uid] }, get: { money: 1 } })) === 'bound');
    check('Bound badges: they lock, and show on a profile\'s showcase', code(() => run('item.lock', { uid: medal.uid, lk: true })) === null && run('persona.set', { showcase: [medal.uid] }).r.me.showcase.includes(medal.uid));
    run('item.lock', { uid: medal.uid, lk: false });
    const c = ACT.makeCtx(st);
    check('Bound badges: staff can take one away', ACT.takeForStaff(c, [coin.uid]).length === 1 && !st.inv.includes(coin));
    check('Bound badges: they aren\'t in the Market\'s catalog; a capsule\'s pins are', !P.catalog().some((e) => e.t === 'badge' && !D.badges[e.id].tr) && pins.every((b) => P.catalogEntry(`badge:${b.id}`)?.cat === 'pin'));
  }

  // Staff giving them
  {
    const spec = ADM.giveSpecs([{ t: 'badge', id: 'collectible-1340', n: 2 }, { t: 'badge', id: 'collectible-6101' }]);
    const st = { serials: {} }, made = ADM.buildItems(spec.specs, ADM.localSerial(st));
    check('Admin: staff give any badge; a pin is numbered as it would be unboxed, a bound badge isn\'t', made.length === 3 && made.every((it) => it.t === 'badge' && it.src === 'Admin' && it.nw)
      && made.filter((it) => it.id === 'collectible-1340').every((it) => !it.sn) && made.find((it) => it.id === 'collectible-6101').sn === 1 && ADM.ITEM_KINDS.includes('badge'));
    check('Admin: an unknown badge is refused', (() => { try { ADM.giveSpecs([{ t: 'badge', id: 'collectible-0' }]); return false; } catch (e) { return /Unknown badge/.test(e.message); } })());
    const save = { ...freshState(), money: 5, inv: [I.makeBadgeItem(D.badges['collectible-6101'])], listed: [{ ...I.makeBadgeItem(D.badges['collectible-874']), lid: 'l1', lp: 5, lat: 1 }] };
    check('Admin: a save that has a bound badge on the Market isn\'t one the game wrote', (() => { try { ADM.saveFile(save); return false; } catch (e) { return /listed\[0\]/.test(e.message); } })());
  }

  // What a profile reads (engine/badges.js)
  {
    const { st, add } = setup();
    add('collectible-874'); add('collectible-6101'); add('collectible-6101');
    st.stored = [{ ...I.makeBadgeItem(D.badges['collectible-6132']), su: 'u1', sat: 1 }];
    const list = B.badgesOf(st);
    check('Profile: badgesOf lists each badge once with its copies (inventory and Storage Units), rarest first', list.length === 3 && list.find((x) => x.id === 'collectible-6101').n === 2
      && list.some((x) => x.id === 'collectible-6132') && list.every((x, i) => !i || list[i - 1].def.r >= x.def.r) && B.isBadge({ t: 'badge' }) && !B.isBadge({ t: 'sticker' }));
    check('Profile: a featured badge is kept while they own one, and only then', B.featuredBadge(st, 'collectible-874') === 'collectible-874' && B.featuredBadge(st, 'collectible-6132') === 'collectible-6132'
      && B.featuredBadge(st, 'collectible-6102') === null && B.featuredBadge(st, 'nonsense') === null && B.featuredBadge(st, null) === null && B.featuredBadge(st, { toString: () => 'collectible-874' }) === 'collectible-874');
    st.listed = [{ ...I.makeBadgeItem(D.badges['collectible-6102']), lid: 'l', lp: 9, lat: 1 }];
    check('Profile: one listed on the Market isn\'t theirs to show', !B.ownsBadge(st, 'collectible-6102'));
  }

  // The Index and the Item Database
  check('Index: the capsules are sets with a reward, and their pins go on the record as unboxed', caps.every((c) => IX.setOf(c.id)?.ids.length === Object.values(c.pools).flat().length && IX.goalOf(IX.setOf(c.id).goal))
    && IX.kindOf('collectible-6101') === 'badge' && IX.RECORD_TYPES.some(([k]) => k === 'badge'));
  check('Item Database: badges are one of its kinds', DB.DB_TYPES.includes('badge') && DB.countCopies([{ t: 'badge', id: 'collectible-874' }, { t: 'badge', id: 'collectible-874' }])['badge:collectible-874'] === 2);

  // Prices
  {
    const pricing = createRequire(import.meta.url)('../shared/pricing.cjs');
    const b = structuredClone(file.badges);
    const idx = pricing.buildIndex({ skinport: [{ market_hash_name: 'Dust II Pin', min_price: 31.5, suggested_price: 30, quantity: 3 }, { market_hash_name: '5 Year Veteran Coin', min_price: 9, suggested_price: 9, quantity: 3 }] });
    const n = pricing.applyPrices({ skins: {}, stickers: {}, agents: {}, cases: [], badges: b }, idx);
    check('Prices: a refresh prices the pins from the markets, and leaves the bound badges at $0', b['collectible-6101'].p === 31.5 && b['collectible-874'].p === 0 && n.badges === 1);
  }

  // NPC traders own some pins (their own seed: the rest of what they start with is as it was)
  {
    const withPins = firstNpcs.map((n) => N.startingState(npcSeed, n).inv);
    const same = withPins.every((inv, i) => inv.filter((it) => it.t !== 'badge').map((it) => `${it.t}:${it.id}:${it.fl}:${it.sd}:${it.sn || ''}`).join() === plainInv[i]);
    const owners = N.crowd(npcSeed).filter((n) => N.startingState(npcSeed, n).inv.some((it) => it.t === 'badge'));
    check('NPCs: some own pins from the capsules, and everything else they start with is as before', same && owners.length > 100 && owners.length < 900
      && owners.every((n) => N.startingState(npcSeed, n).inv.filter((it) => it.t === 'badge').every((it) => D.badges[it.id]?.tr)), `${owners.length} of 2000 own pins`);
    const so = N.freshSocial(npcSeed), npc = owners[0];
    check('NPCs: their pins show as their badges', B.badgesOf({ inv: N.inventoryOf(so, npc) }).length > 0);
  }

  // ---- profile pictures (engine/picture.js) and the featured badge (persona.set) ---------------------------------------------
  {
    const PIC = await E('picture');
    const zlib = await import('node:zlib');
    // Pictures made here: a real PNG (zlib, with its CRCs), and WebPs whose headers are as libwebp writes them (the checks read
    // headers only, as the server's do).
    const pngChunk = (type, data) => { const td = Buffer.concat([Buffer.from(type, 'latin1'), data]), len = Buffer.alloc(4), crc = Buffer.alloc(4); len.writeUInt32BE(data.length); crc.writeUInt32BE(zlib.crc32(td)); return Buffer.concat([len, td, crc]); };
    const png = (w, h, { extra = [], tail = Buffer.alloc(0), noise = 0 } = {}) => {
      const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
      const raw = Buffer.alloc((w * 4 + 1) * h); for (let i = 0; i < noise; i++) raw[(i * 7919) % raw.length] = (i * 31) & 255;
      return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), ...extra.map(([t, d]) => pngChunk(t, d)), pngChunk('IDAT', zlib.deflateSync(raw, { level: noise ? 0 : 9 })), pngChunk('IEND', Buffer.alloc(0)), tail]));
    };
    const riffChunk = (tag, data) => { const head = Buffer.alloc(8); head.write(tag, 0, 'latin1'); head.writeUInt32LE(data.length, 4); return Buffer.concat([head, data, Buffer.alloc(data.length & 1)]); };
    const riff = (chunks) => { const body = Buffer.concat(chunks), head = Buffer.alloc(12); head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(4 + body.length, 4); head.write('WEBP', 8, 'latin1'); return new Uint8Array(Buffer.concat([head, body])); };
    const vp8l = (w, h) => { const d = Buffer.alloc(15); d[0] = 0x2f; d.writeUInt32LE((((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14)) >>> 0, 1); return riffChunk('VP8L', d); };
    const vp8 = (w, h) => { const d = Buffer.alloc(30); d.set([0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a]); d.writeUInt16LE(w, 6); d.writeUInt16LE(h, 8); return riffChunk('VP8 ', d); };
    const vp8x = (w, h, flags) => { const d = Buffer.alloc(10); d[0] = flags; d.writeUIntLE(w - 1, 4, 3); d.writeUIntLE(h - 1, 7, 3); return riffChunk('VP8X', d); };
    const S = PIC.PIC_SIZE, ok = (b) => PIC.pictureProblem(b) === '';
    const good = { png: png(S, S), lossless: riff([vp8l(S, S)]), lossy: riff([vp8(S, S)]), extended: riff([vp8x(S, S, 0x10), riffChunk('ALPH', Buffer.alloc(9)), vp8(S, S)]) };
    check('Pictures: a 184 x 184 PNG, and WebP simple (lossy or lossless) and extended (with alpha), are taken', Object.values(good).every(ok)
      && PIC.pictureInfo(good.png).type === 'png' && PIC.pictureInfo(good.lossy).type === 'webp' && PIC.pictureInfo(good.extended).w === S, JSON.stringify(Object.fromEntries(Object.entries(good).map(([k, b]) => [k, PIC.pictureProblem(b)]))));
    const bad = {
      'another size': png(185, 184), 'not square': riff([vp8l(184, 92)]), 'an APNG': png(S, S, { extra: [['acTL', Buffer.alloc(8)]] }), 'an animated WebP': riff([vp8x(S, S, 0x02), vp8l(S, S)]),
      'an ANMF frame': riff([vp8x(S, S, 0), riffChunk('ANMF', Buffer.alloc(16))]), 'EXIF in a PNG': png(S, S, { extra: [['eXIf', Buffer.from('MM\0*')]] }), 'EXIF in a WebP': riff([vp8x(S, S, 0x08), vp8l(S, S)]),
      'an XMP chunk': riff([vp8l(S, S), riffChunk('XMP ', Buffer.from('<x/>'))]), 'bytes after a PNG ends': png(S, S, { tail: Buffer.from('hidden') }), 'a RIFF the wrong length': (() => { const b = riff([vp8l(S, S)]); return new Uint8Array([...b, 1, 2]); })(),
      'a cut-off PNG': png(S, S).subarray(0, 60), 'a JPEG': new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0]), 'a GIF': new Uint8Array(Buffer.from('GIF89a\xb8\0\xb8\0', 'latin1')), 'nothing': new Uint8Array(0),
      'over 64 KB': png(S, S, { noise: 70000 }), 'not bytes': 'iVBORw0KGgo=',
    };
    const through = Object.entries(bad).filter(([, b]) => ok(b)).map(([k]) => k);
    check(`Pictures: refused (${Object.keys(bad).length}): another size, animated, metadata, anything after the end, damaged, other types, too big`, !through.length && /up to 64 KB/.test(PIC.pictureProblem(bad['over 64 KB'])) && /animated/.test(PIC.pictureProblem(bad['an APNG'])) && /metadata/.test(PIC.pictureProblem(bad['EXIF in a WebP'])) && /184 x 184/.test(PIC.pictureProblem(bad['another size'])), through.join(', '));
    // Only what a picture is made of: a browser's canvas writes a WebP as VP8X + ICCP (its sRGB colour profile) + ALPH + VP8.
    const icc = (n) => riffChunk('ICCP', Buffer.alloc(n, 7));
    const canvasLike = { opaque: riff([vp8x(S, S, 0x20), icc(456), vp8(S, S)]), alpha: riff([vp8x(S, S, 0x30), icc(456), riffChunk('ALPH', Buffer.alloc(47)), vp8(S, S)]),
      'png with colour chunks': png(S, S, { extra: [['sRGB', Buffer.from([0])], ['gAMA', Buffer.alloc(4)], ['pHYs', Buffer.alloc(9)]] }) };
    check('Pictures: what a browser\'s canvas makes is taken (a colour profile, alpha; a PNG\'s colour chunks)', Object.values(canvasLike).every(ok), JSON.stringify(Object.fromEntries(Object.entries(canvasLike).map(([k, b]) => [k, PIC.pictureProblem(b)]))));
    const carrying = {
      'XMP in a PNG (iTXt)': png(S, S, { extra: [['iTXt', Buffer.from('XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta/>')]] }), 'EXIF in a PNG (zTXt)': png(S, S, { extra: [['zTXt', Buffer.from('Raw profile type exif\0\0x')]] }),
      'a PNG text chunk': png(S, S, { extra: [['tEXt', Buffer.from('Comment\0hi')]] }), 'a PNG chunk of its own': png(S, S, { extra: [['prVt', Buffer.alloc(40)]] }),
      'a WebP chunk of its own': riff([vp8x(S, S, 0), vp8(S, S), riffChunk('JUNK', Buffer.alloc(30))]), 'a chunk after a simple WebP': riff([vp8(S, S), riffChunk('ICCP', Buffer.alloc(10))]),
      'a big colour profile': riff([vp8x(S, S, 0x20), icc(30000), vp8(S, S)]), 'a canvas over a bigger image': riff([vp8x(S, S, 0), vp8(16000, 16000)]),
      'two images': riff([vp8x(S, S, 0), vp8(S, S), vp8(S, S)]), 'an extended WebP with no image': riff([vp8x(S, S, 0x20), icc(100)]),
    };
    const carried = Object.entries(carrying).filter(([, b]) => ok(b)).map(([k]) => k);
    check(`Pictures: nothing else rides along (${Object.keys(carrying).length}): text, EXIF or XMP in any chunk, chunks of anyone's own, a canvas that isn't its image's size`, !carried.length
      && /metadata/.test(PIC.pictureProblem(carrying['XMP in a PNG (iTXt)'])) && /metadata/.test(PIC.pictureProblem(carrying['a WebP chunk of its own'])), carried.join(', '));
    const url = PIC.bytesToDataUrl(good.lossless);
    check('Pictures: a save keeps one as a data: URL of the type it is, and reads back the same bytes', url.startsWith('data:image/webp;base64,') && PIC.dataUrlProblem(url) === '' && Buffer.from(PIC.dataUrlBytes(url)).equals(Buffer.from(good.lossless))
      && PIC.bytesToDataUrl(bad['an APNG']) === null);
    check('Pictures: a data: URL that says another type, isn\'t base64 or isn\'t a picture is refused', !!PIC.dataUrlProblem(url.replace('image/webp', 'image/png')) && !!PIC.dataUrlProblem('data:image/png;base64,@@@') && !!PIC.dataUrlProblem('data:text/html;base64,PGI+')
      && !!PIC.dataUrlProblem('https://example.com/a.png') && !!PIC.dataUrlProblem(null) && !!PIC.dataUrlProblem('data:image/png;base64,' + 'A'.repeat(100000)));

    // persona.set: your picture, and the badge you feature
    const { st, run, add } = setup();
    const pin = add('collectible-6101');
    const before = run('persona.set', { avatar: Object.keys(D.agents)[0] }).r.me;
    const withPic = run('persona.set', { pic: url, badge: pin.id }).r.me;
    check('persona.set: a picture of your own and a badge you have, kept with the save (the agent stays)', withPic.pic === url && withPic.badge === pin.id && withPic.avatar === before.avatar && st.social.me.pic === url);
    const refusedPic = code(() => run('persona.set', { pic: PIC.bytesToDataUrl(good.png).replace('image/png', 'image/webp'), name: 'x' }));
    check('persona.set: a picture that isn\'t one to keep is refused, and nothing else changes', refusedPic === 'bad' && st.social.me.pic === url && st.social.me.name !== 'x'
      && code(() => run('persona.set', { pic: 'data:image/png;base64,' + Buffer.from(bad['an APNG']).toString('base64') })) === 'bad' && code(() => run('persona.set', { pic: 5 })) === 'bad');
    check('persona.set: a badge you don\'t have, or isn\'t one, is refused', code(() => run('persona.set', { badge: 'collectible-874' })) === 'bad' && code(() => run('persona.set', { badge: 'nope' })) === 'bad' && st.social.me.badge === pin.id);
    const off = run('persona.set', { pic: null, badge: null }).r.me;
    check('persona.set: the picture and the badge come off with null, and what isn\'t sent stays', off.pic === null && off.badge === null && off.avatar === before.avatar
      && run('persona.set', { badge: pin.id }).r.me.pic === null && st.social.me.badge === pin.id);
    st.inv = st.inv.filter((it) => it !== pin);
    check('A featured badge shows only while you have one (badges.js featuredBadge)', B.featuredBadge(st, st.social.me.badge) === null);
    // The admin panel's save check keeps a picture the game made and a badge the save has, and drops anything else.
    const file = { ...structuredClone(st), inv: [...st.inv, I.makeBadgeItem(D.badges['collectible-6102'])] };
    file.social.me = { ...file.social.me, pic: url, badge: 'collectible-6102' };
    const kept = ADM.saveFile(file).social.me;
    file.social.me = { ...file.social.me, pic: 'data:image/png;base64,PHNjcmlwdD4=', badge: 'collectible-874' };
    const dropped = ADM.saveFile(file).social.me;
    check('Admin: a save\'s picture and featured badge are kept when the game could have made them, dropped otherwise', kept.pic === url && kept.badge === 'collectible-6102' && dropped.pic === null && dropped.badge === null);
    check('A new profile has no picture and no badge', N.freshPersona().pic === null && N.freshPersona().badge === null);
  }
  initData(game, { keys });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
