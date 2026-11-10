// Rare pattern (paint seed) analysis. Seeds run 0-1000 like CS2's "Pattern Template".
// Seed lists follow well-known community tiers (blue gems, Fire & Ice, full fades, diamonds...).
// Case Hardened and Heat Treated go by what each seed really shows: how much of the playside is blue and gold is measured
// from CS2's own pattern (case-hardened-data.js), on the part the community goes by (a knife's blade, the AK-47's dust cover),
// and every label comes from those numbers, with cut-offs for each weapon (scripts/build-case-hardened.mjs says why each is
// what it is). The community's Tier 1 lists below only add to that.
import { seeded } from './util.js';
import { D } from './data.js';
import { CASE_HARDENED } from './case-hardened-data.js';

const set = (...a) => new Set(a);

// Blue Gem tiers. Every skin's are its bluest seeds, so nothing bluer than a Blue Gem goes without. The lists are the seeds
// the community calls Tier 1 on top of that: a rank can go by more than the playside (the AK-47's 555 by its magazine). They're
// for the Case Hardened pattern: Heat Treated is another pattern, and what's bluest there has nothing to do with them.
const CH = {
  weapon_ak47: {
    t0: set(661),
    t1: set(670, 321, 151, 955, 179, 387, 555, 592, 760, 809, 828, 868, 617),
    mult: { t0: 500, t1: 40, t2: 8 },
  },
  weapon_fiveseven: {
    t1: set(278, 690, 868, 363, 872, 648, 151),
    mult: { t1: 35, t2: 6 },
  },
  weapon_knife_karambit: {
    t1: set(387, 269, 463, 470, 868, 853, 442, 73, 902),
    mult: { t1: 30, t2: 5 },
  },
  knife: { mult: { t1: 15, t2: 4 } },
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

// Returns { mult, label, tier, info: [[k, v]], blue?, gold?, fade? }.
export function analyzePattern(skin, seed) {
  const out = { mult: 1, label: '', tier: '', info: [] };
  if (!skin || skin.v || seed == null) return out;
  const fin = skin.fin;

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
    const r = seeded(seed, 'fade-' + skin.wid);
    const pct = 80 + 20 * Math.pow(r, 0.9);
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

  if (fin === 'Crimson Web') {
    const r = seeded(seed, 'web-' + skin.wid);
    if (r < 0.01) { out.mult = 1.6; out.tier = 't2'; out.label = 'Triple Web'; }
    else if (r < 0.05) { out.mult = 1.35; out.tier = 't3'; out.label = 'Centered Web'; }
    return out;
  }

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
