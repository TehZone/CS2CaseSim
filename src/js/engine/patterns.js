// Rare pattern (paint seed) analysis. Seeds run 0-1000 like CS2's "Pattern Template".
// Seed lists follow well-known community tiers (blue gems, Fire & Ice, full fades, diamonds...).
// Case Hardened and Heat Treated go by what each seed really shows: how much of the playside is blue and gold is measured
// from CS2's own pattern (case-hardened-data.js), on the part the community goes by (a knife's blade, the AK-47's dust cover),
// and every label comes from those numbers, with cut-offs for each weapon (scripts/build-case-hardened.mjs says why each is
// what it is). The community's Tier 1 lists below only add to that.
// For the 100 skins the CS.MONEY Wiki's rare patterns cover (rare-patterns-data.js), its groups go on top: see RARE at the end.
import { seeded } from './util.js';
import { rotationRoll } from './rng.js';
import { D } from './data.js';
import { CASE_HARDENED } from './case-hardened-data.js';
import { RARE_PATTERNS, RARE_FADES } from './rare-patterns-data.js';

const set = (...a) => new Set(a);

// Blue Gem tiers. Every skin's are its bluest seeds, so nothing bluer than a Blue Gem goes without. The lists are the seeds
// the community calls Tier 1 on top of that: a rank can go by more than the playside (the AK-47's 555 by its magazine). They're
// for the Case Hardened pattern: Heat Treated is another pattern, and what's bluest there has nothing to do with them.
// (t0 and t3 are the CS.MONEY Wiki's #1 and Tier 3 on the skins it covers, RARE below: the measuring names neither, but the
// AK-47's 661. A knife's #1 is worth a few of its Tier 1s, as the AK-47's is; a Tier 3 sits under Tier 2 as Tier 2 under 1.)
const CH = {
  weapon_ak47: {
    t0: set(661),
    t1: set(670, 321, 151, 955, 179, 387, 555, 592, 760, 809, 828, 868, 617),
    mult: { t0: 500, t1: 40, t2: 8, t3: 2.5 },
  },
  weapon_fiveseven: {
    t1: set(278, 690, 868, 363, 872, 648, 151),
    mult: { t1: 35, t2: 6 },
  },
  weapon_knife_karambit: {
    t1: set(387, 269, 463, 470, 868, 853, 442, 73, 902),
    mult: { t0: 150, t1: 30, t2: 5, t3: 2 },
  },
  knife: { mult: { t0: 60, t1: 15, t2: 4, t3: 1.7 } },
  other: { mult: { t1: 4, t2: 1.8 } },
};

// Hydra Gloves can't be measured (each hand has a seed of its own, and neither is a playside), so they go by the community's tier
// list: the Definitive Hydra Gloves Case Hardened Guide, https://steamcommunity.com/sharedfiles/filedetails/?id=2993876938.
// Its written lists come first, with the captions of its pictures where they add a seed (High Tier 2's second 708 is its
// picture's 155). Its table of every seed, a picture of a Google Sheet, then ranks the seeds those don't name: the entries
// with no rank below. It also settles a seed the lists give twice: 414 and 808 are Blaze Gems and 791 is Low; otherwise the
// first list here has it. Where the table and a list disagree the list stands, for the sales the guide gives with it.
const HYDRA = new Map();
const hydraTier = (label, tier, mult, ranks) => {
  for (const [rank, ...seeds] of ranks) for (const seed of seeds) if (!HYDRA.has(seed)) HYDRA.set(seed, { label, tier, mult, rank });
};
hydraTier('Blue Gem Tier 1', 't1', 4, [['P1', 310, 829], ['P2', 221], ['P3', 71], ['P4', 941], ['P5', 632], ['P6', 399], ['P7', 392], ['P8', 900], ['P9', 773], ['P10', 505]]);
hydraTier('Blue Gem Tier 2', 't2', 1.8, [
  ['High', 28, 442, 708, 698, 975, 837, 931, 341, 880, 882, 155, 814, 232, 617, 932, 818, 779, 9, 55],
  ['Average', 31, 113, 119, 187, 195, 369, 562, 575, 703, 872, 898],
  ['Low', 254, 279, 282, 297, 308, 366, 393, 476, 500, 569, 701, 760, 780, 791, 881, 905, 916, 944, 974],
  ['', 29],
]);
hydraTier('Blue Gem Tier 3', 't3', 1.4, [['', 13, 25, 45, 79, 103, 143, 184, 185, 213, 240, 319, 348, 358, 361, 394, 398, 401, 410, 440, 461, 463, 470, 590, 608, 633,
  651, 653, 704, 717, 764, 781, 803, 922, 928, 929, 971,
  5, 17, 18, 54, 116, 133, 175, 294, 327, 416, 422, 524, 584, 601, 656, 691, 706, 746, 804]]);
hydraTier('Gold Gem', '', 1.3, [['P1', 896], ['P2', 739], ['P3', 599], ['P4', 226], ['', 734]]);
// (A Blaze Gem's tier is its colour on the card and what a blue gem hunter sees in it, which is never a Blue Gem's better.)
hydraTier('Blaze Gem Tier 1', 't3', 1.6, [['', 174, 367, 15, 959, 566, 225, 387, 483, 834]]);
hydraTier('Blaze Gem Tier 2', 't3', 1.3, [['', 314, 547, 491, 179, 677, 899, 485, 49, 354, 122, 391, 414,
  102, 161, 396, 465, 612, 648, 737, 802]]);
hydraTier('Blaze Gem Tier 3', 't3', 1.15, [['', 85, 157, 340, 808,
  22, 46, 88, 108, 129, 136, 142, 180, 303, 330, 343, 418, 517, 540, 557, 560, 589, 594, 598, 622, 623, 630, 690, 692,
  695, 711, 728, 730, 741, 744, 749, 771, 839, 861, 938, 940, 945, 958, 960, 985]]);
hydraTier('Tier 4', '', 1.1, [['', 1, 8, 14, 19, 30, 44, 56, 95, 96, 99, 115, 125, 127, 137, 138, 156, 166, 189, 199, 202, 222, 226, 315, 321, 322, 332, 338, 342, 344, 345,
  346, 361, 368, 371, 379, 380, 386, 403, 409, 433, 454, 462, 474, 475, 506, 525, 528, 561, 572, 574, 579, 580, 599, 600, 602, 637, 676, 685, 689, 697, 718, 721, 729, 738,
  739, 747, 750, 752, 762, 763, 783, 790, 806, 821, 823, 830, 836, 844, 893, 895, 896, 903, 912, 947, 948, 954, 955, 956, 961, 973, 984, 997, 999,
  2, 10, 26, 38, 51, 57, 58, 65, 75, 82, 87, 90, 92, 94, 98, 110, 120, 124, 147, 154, 160, 165, 167, 172, 183, 186, 194,
  198, 200, 205, 217, 218, 224, 233, 234, 236, 250, 255, 260, 263, 272, 274, 275, 290, 291, 292, 293, 298, 305, 311,
  312, 325, 331, 339, 356, 364, 373, 374, 377, 378, 389, 390, 407, 423, 431, 435, 441, 452, 459, 467, 472, 480, 487,
  490, 494, 504, 519, 522, 527, 539, 544, 556, 563, 582, 588, 596, 597, 606, 610, 616, 631, 634, 635, 641, 649, 650,
  659, 665, 666, 668, 670, 671, 682, 707, 720, 732, 740, 748, 753, 757, 772, 782, 785, 787, 788, 792, 794, 797, 809,
  810, 815, 849, 854, 858, 860, 862, 865, 876, 888, 891, 892, 897, 901, 909, 911, 914, 919, 926, 951, 957, 965, 970,
  982, 987, 989, 991, 995, 998]]);

// A seed's percent out of a measured string: two base-32 digits a seed, in tenths.
const percent = (digits, seed) => parseInt(digits.slice(seed * 2, seed * 2 + 2), 32) / 10;

const FIRE_ICE = set(412, 16, 146, 241, 359, 393, 541, 602, 649, 688, 701);
const FAKE_FIRE_ICE = set(152, 281, 292, 344, 628, 761, 924);
const DIAMOND = set(104, 237, 340, 497, 520, 708, 801, 820);
const ANGEL = set(97, 285, 359, 459);

export const TIER_LABEL = { t0: 'Tier 0', t1: 'Tier 1', t2: 'Tier 2', t3: 'Tier 3' };

// Which side of its model a skin's playside numbers are of: 'front' (the side its icon shows), 'back' or 'top'. null: it has none.
export const playside = (skin) => CASE_HARDENED[skin.wid]?.[skin.fid]?.side ?? null;

// What the game makes of a seed by itself, before the CS.MONEY Wiki's groups (analyzePattern, at the end): the measuring, the
// Hydra guide, and the lists and rolls below. Same shape as analyzePattern's.
export function basePattern(skin, seed) {
  const out = { mult: 1, label: '', tier: '', info: [] };
  if (!skin || skin.v || seed == null) return out;
  // A custom finish isn't one of CS2's, whatever it's called: no rule goes by its name, only the one its pack chose (`pr`,
  // 'Fade': a fade percentage from the seed). See CUSTOM_CONTENT.md.
  const fin = skin.cx ? (skin.pr === 'Fade' ? 'Fade' : '') : skin.fin;

  if (fin === 'Case Hardened' || fin === 'Heat Treated') {
    if (skin.wid === 'studded_hydra_gloves' && fin === 'Case Hardened') {
      const h = HYDRA.get(seed);
      if (!h) return out;
      if (h.rank) out.info.push(['Tier list', h.rank]);
      return { ...out, label: h.label, tier: h.tier, mult: h.mult };
    }
    const table = CH[skin.wid] || (skin.cat === 'knife' ? CH.knife : CH.other);
    const list = fin === 'Case Hardened' ? table : {};
    const m = CASE_HARDENED[skin.wid]?.[skin.fid];
    const measured = !!m && seed >= 0 && seed * 2 < m.b.length;
    const blue = measured ? percent(m.b, seed) : 0, gold = measured ? percent(m.g, seed) : 0;
    if (measured) {
      out.blue = blue / 100;
      out.gold = gold / 100;
      out.info.push(['Playside blue', blue.toFixed(1) + '%'], ['Playside gold', gold.toFixed(1) + '%']);
    }
    const tier = list.t0?.has(seed) ? 't0' : list.t1?.has(seed) || (measured && blue >= m.t1) ? 't1'
      : list.t2?.has(seed) || (measured && blue >= m.t2) ? 't2' : '';
    if (tier) {
      out.tier = tier;
      out.mult = table.mult[tier];
      out.label = tier === 't0' ? '#1 Blue Gem' : `Blue Gem ${TIER_LABEL[tier]}`;
    } else if (!measured) {
      return out;
    } else if (gold - blue >= m.gold) {
      // (Only Blue Gems and Gold Gems are named: the user had High Blue and Above-average blue taken off on 2026-11-10.)
      out.tier = 't3'; out.mult = 1.3; out.label = 'Gold Gem';
    }
    return out;
  }

  if (fin === 'Fade' || fin === 'Amber Fade') {
    // A custom Fade's percentage is the rotation the seed turns its pattern to, as the 3D draws it: 80% at its "rotation"
    // range's first angle, 100% at the second (CS2's own Fades' real percentages go by their rotation the same way).
    const r = skin.cx ? rotationRoll(seed) : seeded(seed, 'fade-' + skin.wid);
    const pct = skin.cx ? 80 + 20 * r : 80 + 20 * Math.pow(r, 0.9);
    out.fade = pct;
    out.info.push(['Fade', pct.toFixed(1) + '%']);
    if (pct >= 99.5) { out.mult = 1.5; out.tier = 't1'; out.label = 'Full Fade'; }
    else if (pct >= 98) { out.mult = 1.2; out.tier = 't2'; out.label = `${pct.toFixed(1)}% Fade`; }
    else if (pct >= 95) out.mult = 1.07;
    else if (pct < 85) out.mult = 0.92;
    return out;
  }

  if (fin === 'Marble Fade') {
    // Measured from CS2's own pattern for this knife (scripts/build-marble.mjs): Fire & Ice is the pattern turned to
    // the end of its range, where the blade's playside shows only red and blue.
    const m = D.marble?.[skin.wid]?.[skin.fid];
    if (m && seed >= 0 && seed < m.t.length) {
      if (m.ok) {
        const [y, r, b] = m.c.slice(seed * 3, seed * 3 + 3);
        out.colors = { yellow: y, red: r, blue: b };
        out.info.push(['Playside colours', `Red ${Math.round(r)}% · Blue ${Math.round(b)}% · Yellow ${Math.round(y)}%`]);
      }
      const tier = +m.t[seed];
      if (tier === 3) { out.mult = 2.6; out.tier = 't0'; out.label = 'Max Fire & Ice'; }
      else if (tier === 2) { out.mult = 1.9; out.tier = 't1'; out.label = 'Fire & Ice'; }
      else if (tier === 1) { out.mult = 1.15; out.tier = 't3'; out.label = 'Fake Fire & Ice'; }
      return out;
    }
    if (seed === 412) { out.mult = 2.6; out.tier = 't0'; out.label = 'Max Fire & Ice'; }
    else if (FIRE_ICE.has(seed)) { out.mult = 1.9; out.tier = 't1'; out.label = 'Fire & Ice'; }
    else if (FAKE_FIRE_ICE.has(seed)) { out.mult = 1.15; out.tier = 't3'; out.label = 'Fake Fire & Ice'; }
    else if (seeded(seed, 'mf-tip') < 0.06) { out.mult = 1.08; out.label = 'Blue Tip'; }
    return out;
  }

  // Crimson Web is named only where the CS.MONEY Wiki says (rare-patterns-data.js): no rolled webs on the other knives, the
  // user's choice on 2026-11-10.
  if (fin === 'Crimson Web') return out;

  if (fin === 'Slaughter') {
    if (DIAMOND.has(seed)) { out.mult = 1.25; out.tier = 't3'; out.label = 'Diamond'; }
    else if (ANGEL.has(seed)) { out.mult = 1.15; out.tier = 't3'; out.label = 'Angel'; }
    return out;
  }

  if (fin === 'Doppler' || fin === 'Gamma Doppler') {
    if (skin.ph === 'Phase 2' && seeded(seed, 'pink') < 0.05) { out.mult = 1.2; out.tier = 't3'; out.label = 'Pink Galaxy'; }
    if (skin.ph === 'Black Pearl' && seeded(seed, 'bp') < 0.1) { out.mult = 1.15; out.tier = 't3'; out.label = 'Max Pearl'; }
    return out;
  }
  return out;
}

// ---- The CS.MONEY Wiki's rare patterns -----------------------------------------------------------------------------------
// https://wiki.cs.money/rare-patterns, fetched 2026-11-10 (rare-patterns-data.js, made by scripts/build-rare-patterns.mjs, which
// says how): for 100 skins, the groups of seeds the wiki names, and for 22 Fades every seed's real fade percentage. On a skin it
// covers they decide the label, tier and boost, and this is how they go with what basePattern gives; on any other skin
// basePattern stands.
//   Case Hardened  the measuring stays the base, and a group only ever raises it (as the community's Tier 1 lists do): the seed
//                  keeps whichever is worth more, and its blue and gold either way. The wiki's #1 is the #1 Blue Gem; Rank 1
//                  and Tier 1 are Blue Gem Tier 1, Rank 2 and Tier 2 Tier 2, Ranks 3 and 4 and Tier 3 Tier 3, at the weapon's
//                  own Blue Gem boost (CH). Its Gold Gems are t3 like the measured one: they're not what a blue gem hunter wants.
//                  Where a group decides, the info says so in the wiki's words (CS.MONEY Wiki: Rank 2): its ranks can go by
//                  the other side of the blade, so a Karambit it ranks a Blue Gem can be gold on the side the game measures
//                  (its 346 is 3% blue there and 95% on the back, by the same measuring).
//   Marble Fade    the groups name the seed (Fire & Ice's 1st to 10th Max, the fakes, Tricolor, the rarer tips) and the measured
//                  colours still show. The Gut, Navaja, Shadow Daggers and Survival Knife, which the wiki hasn't, keep the measuring.
//   Fade           the wiki's real percentage instead of one made up from the seed, and the label and boost go by it as they
//                  did by the made-up one, so copies that show the same percentage read the same.
//   the rest       Crimson Web and Slaughter go by the groups instead of a roll or one list for every knife; Tiger Tooth,
//                  Freehand, Scorched and the five pairs of gloves had nothing before. (Doppler's Pink Galaxy and Max Pearl aren't
//                  on the wiki and stay as they are.)
// RARE: each group's label, tier and boost, by the skin's set (its finish; a pair of gloves by its whole name) and the group (the
// wiki's type, then / and its tier when it has one). The boosts are on the game's scale (Blue Gems, Fire & Ice 1.9, Full Fade
// 1.5, Gold Gem 1.3): the rarer the group the more, and a Tier 1 always more than its Tier 2 and 3. Every other label says
// Tier N only where the wiki has more than one tier of it. mult null: the weapon's Blue Gem boost (CH) for that tier, or for a
// tip how rare it is on the knife (TIPS). label null (Fade): the seed's own percentage. wiki: the group's name on the wiki where
// it isn't the label. first: a seed it shares with another group is its, whatever the boosts.
const r = (label, tier, mult = null) => ({ label, tier, mult });
// A group's tiers, [wiki tier, tier, mult] each, labelled like the Blue Gems: tiers('diamond', 'Diamond', [1, 't1', 1.6]) is
// { 'diamond/1': 'Diamond Tier 1' at t1, ×1.6 }.
const tiers = (key, name, ...each) => Object.fromEntries(each.map(([n, tier, mult]) => [`${key}/${n}`, r(`${name} ${TIER_LABEL['t' + n]}`, tier, mult)]));
const gem = (tier, wiki) => ({ ...r(`Blue Gem ${TIER_LABEL[tier]}`, tier), wiki });
// (A Gold Gem goes first: the one seed that's a Rank and a Gold Gem too, the Karambit's 195, the wiki itself calls a Gold Gem,
// and its playside is gold.)
const goldGem = (n, mult) => ({ [`gold-gem/${n}`]: { ...r(`Gold Gem ${TIER_LABEL['t' + n]}`, 't3', mult), first: true } });
const tip = (colour) => ({ ...r(`${colour} Tip`, ''), tip: colour });
// What colour a Marble Fade's tip is. The wiki sorts nearly every seed of the knives it has no Fire & Ice for by it, so a tip is
// worth what it's rare on that knife: [the most of the knife's seeds it's on, boost]. One on more than 15% of them (most are on
// 16-54%) is only told (the info's Tip) and adds nothing, and a rarer tip on a knife is never worth less than a commoner one.
// (The wiki's rare ones: the Talon's Red Tip 1%, the Stiletto's Blue Tip 5%, an Orange Tip on 11-14% of a few knives.)
export const TIPS = [[0.03, 1.15], [0.08, 1.1], [0.15, 1.05]];
export const RARE = {
  'Case Hardened': {
    1: { ...r('#1 Blue Gem', 't0'), wiki: '#1' }, 'rank-1': gem('t1', 'Rank 1'), 'rank-2': gem('t2', 'Rank 2'), 'rank-3': gem('t3', 'Rank 3'), 'rank-4': gem('t3', 'Rank 4'),
    ...tiers('blue-gem', 'Blue Gem', [1, 't1'], [2, 't2'], [3, 't3']),
    ...goldGem(1, 1.7), ...goldGem(2, 1.5), ...goldGem(3, 1.3),
  },
  // By the percentage shown: 100 is a Full Fade, from 99.5% as it always was, and the rest their whole percent ('98.7% Fade' is
  // a 98). 95% and 96% add a little without a name, and any seed under 85% is worth a little less.
  Fade: {
    100: r('Full Fade', 't1', 1.5), 99: r(null, 't2', 1.3), 98: r(null, 't2', 1.2), 97: r(null, 't3', 1.1), 96: r('', '', 1.07), 95: r('', '', 1.07),
  },
  // Fire & Ice's Max ranks are the Karambit's, Bayonet's and Flip Knife's (1st Max is 412, the old Max Fire & Ice), the tiers the
  // Talon's. Fakes stay t3 as the game had them. The tips' boosts are TIPS's.
  'Marble Fade': {
    '1st-max': r('1st Max', 't0', 2.6), '2nd-max': r('2nd Max', 't1', 2.4), '3rd-max': r('3rd Max', 't1', 2.3), '4th-max': r('4th Max', 't1', 2.2),
    '5th-max': r('5th Max', 't2', 2.1), '6th-max': r('6th Max', 't2', 2), '7th-max': r('7th Max', 't2', 1.95),
    '8th-max': r('8th Max', 't3', 1.9), '9th-max': r('9th Max', 't3', 1.85), '10th-max': r('10th Max', 't3', 1.8),
    ...tiers('fire-and-ice', 'Fire & Ice', [1, 't1', 1.9], [2, 't2', 1.6], [3, 't3', 1.35]),
    'max-fake': r('Max Fake Fire & Ice', 't3', 1.25), ffi: r('Fake Fire & Ice', 't3', 1.15),
    ...tiers('fake-fire-and-ice', 'Fake Fire & Ice', [1, 't3', 1.25], [2, 't3', 1.15]),
    ...tiers('tricolor', 'Tricolor', [2, 't2', 1.2], [3, 't3', 1.1]), tricolor: r('Tricolor', 't3', 1.1),
    'red-tip': tip('Red'), 'blue-tip': tip('Blue'), 'orange-tip': tip('Orange'), 'yellow-tip': tip('Yellow'),
  },
  // Diamonds over hearts (the wiki: diamonds are the rarest, hearts next), and the more shapes together the more.
  Slaughter: {
    ...tiers('diamond', 'Diamond', [1, 't1', 1.6], [2, 't2', 1.35]), ...tiers('heart', 'Heart', [1, 't1', 1.35], [2, 't2', 1.2]),
    'lozenge-diamond/1': r('Lozenge Diamond', 't1', 1.6), ...tiers('diamond-heart', 'Diamond Heart', [1, 't1', 1.7], [2, 't2', 1.45]),
    ...tiers('double-diamond', 'Double Diamond', [1, 't1', 1.8], [2, 't2', 1.5]), ...tiers('mirror-diamond', 'Mirror Diamond', [1, 't1', 1.8], [2, 't2', 1.5]),
    ...tiers('diamond-double-heart', 'Diamond Double Heart', [1, 't1', 1.9], [2, 't2', 1.55]),
  },
  // One web centre on the blade, two, three, four (the wiki: three or more are the rarest). A Quad Web is one seed on its knife.
  'Crimson Web': {
    'web/1': r('Centered Web', 't3', 1.35), 'double-web/1': r('Double Web', 't2', 1.8), 'triple-web/1': r('Triple Web', 't1', 2.5),
    ...tiers('quad-web', 'Quad Web', [2, 't0', 3.5], [3, 't0', 3]),
  },
  'Tiger Tooth': tiers('straight-stripes', 'Straight Stripes', [1, 't1', 1.25], [2, 't2', 1.15], [3, 't3', 1.07]),
  Scorched: tiers('black-gem', 'Black Gem', [1, 't1', 1.3], [2, 't2', 1.15], [3, 't3', 1.07]),
  Freehand: { '1-max-purple': r('#1 Max Purple', 't0', 1.6), 'max-purple': r('Max Purple', 't1', 1.3), 'max-black': r('Max Black', 't2', 1.2) },
  // Gloves add less, and the most for what's on both hands (the wiki: a web centre on both gloves, or a big diamond on both wraps).
  'Sport Gloves | Ultra Violent': {
    ...tiers('max-pink', 'Max Pink', [1, 't1', 1.4], [2, 't2', 1.2], [3, 't3', 1.1]), ...tiers('max-blue', 'Max Blue', [1, 't1', 1.4], [2, 't2', 1.2], [3, 't3', 1.1]),
    'blue-left-pink-right': r('Blue Left Pink Right', 't3', 1.2), 'pink-left-blue-right': r('Pink Left Blue Right', 't3', 1.2), symmetric: r('Symmetric', 't3', 1.15),
  },
  'Sport Gloves | Nocts': { 'full-leopard': r('Full Leopard', 't1', 1.4), 'full-black': r('Full Black', 't2', 1.25), 'right-hand-black': r('Right Hand Black', 't3', 1.1) },
  'Specialist Gloves | Emerald Web': {
    ...tiers('emerald-double-web', 'Double Web', [1, 't1', 1.5], [2, 't2', 1.3]),
    'emerald-right-hand-web': r('Right Hand Web', 't3', 1.15), 'emerald-left-hand-web': r('Left Hand Web', 't3', 1.07),
  },
  'Hand Wraps | Slaughter': { 'double-diamond': r('Double Diamond', 't1', 1.5), ...tiers('diamond', 'Diamond', [1, 't1', 1.25], [2, 't2', 1.1]) },
  'Moto Gloves | Cool Mint': { 'ice-blue': r('Ice Blue', 't1', 1.3), 'max-white': r('Max White', 't2', 1.15) },
};

// The wiki's entry for a skin ({ set, groups } or { set: 'Fade', fade }), or null: it doesn't cover the skin.
export const rarePatterns = (skin) => (skin && !skin.v && !skin.cx ? RARE_PATTERNS[skin.wid]?.[skin.fid] ?? null : null);

// A seed's group on a skin the wiki covers, as { label, tier, mult, wiki, info? }, or null. A seed in two groups (a #1 that's
// also a Tier 1, a Talon's Tricolor that's also a Yellow Tip) has the one worth more, unless one goes first (a Gold Gem). Every
// such seed then has the group the wiki's own page names it by.
const bySeed = new WeakMap();
function rareGroup(skin, rare, seed) {
  let best = bySeed.get(rare);
  if (!best) {
    best = new Map();
    const gems = CH[skin.wid] || (skin.cat === 'knife' ? CH.knife : CH.other);
    for (const [key, seeds] of Object.entries(rare.groups)) {
      const g = RARE[rare.set]?.[key];
      if (!g) continue; // (the tests say if one is missing)
      let group = { label: g.label, tier: g.tier, mult: g.mult ?? gems.mult[g.tier], wiki: g.wiki ?? g.label, first: !!g.first };
      if (g.tip) {
        const band = TIPS.find(([share]) => seeds.length / 2 <= share * 1001);
        group = band ? { ...group, mult: band[1] } : { ...group, label: '', mult: 1, info: ['Tip', g.tip] };
      }
      for (let i = 0; i < seeds.length; i += 2) {
        const sd = parseInt(seeds.slice(i, i + 2), 32), old = best.get(sd);
        if (!old || (group.first !== old.first ? group.first : group.mult > old.mult)) best.set(sd, group);
      }
    }
    bySeed.set(rare, best);
  }
  return best.get(seed) ?? null;
}

// Returns { mult, label, tier, info: [[k, v]], blue?, gold?, colors?, fade? }.
export function analyzePattern(skin, seed) {
  const out = basePattern(skin, seed);
  const rare = rarePatterns(skin);
  if (!rare || !Number.isInteger(seed) || seed < 0 || seed > 1000) return out;
  if (rare.fade != null) {
    const tenths = parseInt(RARE_FADES[rare.fade].p.slice(seed * 2, seed * 2 + 2), 32), pct = tenths / 10;
    const g = RARE.Fade[tenths >= 995 ? 100 : Math.floor(tenths / 10)];
    return { mult: g ? g.mult : pct < 85 ? 0.92 : 1, label: g ? g.label ?? `${pct.toFixed(1)}% Fade` : '', tier: g?.tier || '', info: [['Fade', pct.toFixed(1) + '%']], fade: pct };
  }
  const g = rareGroup(skin, rare, seed);
  if (rare.set === 'Case Hardened') {
    if (!g || g.mult < out.mult) return out;
    return { ...out, label: g.label, tier: g.tier, mult: g.mult, info: [...out.info, ['CS.MONEY Wiki', g.wiki]] };
  }
  return { ...out, label: g?.label || '', tier: g?.tier || '', mult: g?.mult || 1, info: g?.info ? [...out.info, [...g.info]] : out.info };
}
