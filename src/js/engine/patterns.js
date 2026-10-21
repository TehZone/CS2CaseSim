// Rare pattern (paint seed) analysis. Seeds run 0-1000 like CS2's "Pattern Template".
// Seed lists follow well-known community tiers (blue gems, Fire & Ice, full fades, diamonds...).
import { seeded } from './util.js';

const set = (...a) => new Set(a);

const CH = {
  weapon_ak47: {
    t0: set(661),
    t1: set(670, 321, 151, 955, 179, 387, 555, 592, 760, 809, 828, 868, 617),
    t2: set(103, 112, 168, 341, 426, 442, 463, 589, 713, 735, 750, 784, 922, 4, 13, 32),
    mult: { t0: 500, t1: 40, t2: 8 },
  },
  weapon_fiveseven: {
    t1: set(278, 690, 868, 363, 872, 648, 151),
    t2: set(670, 179, 321, 555, 592, 828),
    mult: { t1: 35, t2: 6 },
  },
  weapon_knife_karambit: {
    t1: set(387, 269, 463, 470, 868, 853, 442, 73, 902),
    t2: set(555, 592, 670, 151, 179, 321, 661, 760, 809),
    mult: { t1: 30, t2: 5 },
  },
  knife: {
    t1: set(555, 592, 670, 151, 179, 321, 661, 387, 760, 809, 828, 868, 955),
    t2: set(103, 112, 168, 442, 463, 713),
    mult: { t1: 15, t2: 4 },
  },
  other: {
    t1: set(555, 592, 670, 151, 179, 321, 661, 387),
    t2: set(103, 112, 168, 442),
    mult: { t1: 4, t2: 1.8 },
  },
};

const FIRE_ICE = set(412, 16, 146, 241, 359, 393, 541, 602, 649, 688, 701);
const FAKE_FIRE_ICE = set(152, 281, 292, 344, 628, 761, 924);
const DIAMOND = set(104, 237, 340, 497, 520, 708, 801, 820);
const ANGEL = set(97, 285, 359, 459);

export const TIER_LABEL = { t0: 'Tier 0', t1: 'Tier 1', t2: 'Tier 2', t3: 'Tier 3' };

// Returns { mult, label, tier, info: [[k, v]], blue?, fade? }.
export function analyzePattern(skin, seed) {
  const out = { mult: 1, label: '', tier: '', info: [] };
  if (!skin || skin.v || seed == null) return out;
  const fin = skin.fin;

  if (fin === 'Case Hardened' || fin === 'Heat Treated') {
    const table = CH[skin.wid] || (skin.cat === 'knife' ? CH.knife : CH.other);
    const r = seeded(seed, 'ch-' + skin.wid);
    let tier = table.t0?.has(seed) ? 't0' : table.t1.has(seed) ? 't1' : table.t2.has(seed) ? 't2' : '';
    let blue = tier === 't0' ? 88 + r * 6 : tier === 't1' ? 62 + r * 20 : tier === 't2' ? 47 + r * 14 : 4 + Math.pow(r, 2.4) * 46;
    out.blue = blue / 100;
    out.info.push(['Playside blue', blue.toFixed(1) + '%']);
    if (tier) {
      out.tier = tier;
      out.mult = table.mult[tier];
      out.label = tier === 't0' ? '#1 Blue Gem' : `Blue Gem ${TIER_LABEL[tier]}`;
    } else if (blue > 40) {
      out.tier = 't3'; out.mult = 1.6; out.label = 'High Blue';
    } else if (blue > 30) {
      out.mult = 1.15; out.label = 'Above-average blue';
    } else if (blue < 6.5) {
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
