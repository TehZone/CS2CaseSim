// Chickens: collectible pets from the Chicken Coop Crate. Chickens placed in the coop lay eggs (passive income).
import { pickWeighted, rand, round2, uid } from './util.js';

export const BREEDS = [
  { id: 'farm', n: 'Farm Chicken', r: 2, v: 0.55, inc: 0.02, color: '#f2efe6' },
  { id: 'brown', n: 'Brown Hen', r: 2, v: 0.65, inc: 0.022, color: '#9a6233' },
  { id: 'speckled', n: 'Speckled Rooster', r: 2, v: 0.8, inc: 0.025, color: '#e4dccb', pattern: 'speckle' },
  { id: 'midnight', n: 'Midnight Chicken', r: 3, v: 3.4, inc: 0.08, color: '#202329' },
  { id: 'zombie', n: 'Zombie Chicken', r: 3, v: 3.9, inc: 0.085, color: '#7f9a5a', pattern: 'rot' },
  { id: 'camo', n: 'Dust II Camo Chicken', r: 3, v: 4.4, inc: 0.09, color: '#b59b6b', pattern: 'camo' },
  { id: 'ghost', n: 'Ghost Chicken', r: 4, v: 21, inc: 0.35, color: '#cfe8ff', ghost: true },
  { id: 'neon', n: 'Neon Rider Chicken', r: 4, v: 26, inc: 0.38, color: '#ff3fa4', neon: true },
  { id: 'golden', n: 'Golden Chicken', r: 5, v: 140, inc: 1.5, color: '#e6b93a', metal: true },
  { id: 'holo', n: 'Holo Chicken', r: 5, v: 165, inc: 1.6, color: '#d8e0ff', holo: true },
  { id: 'diamond', n: '★ Diamond Chicken', r: 6, v: 900, inc: 6, color: '#bdf2ff', crystal: true },
  { id: 'lore', n: '★ Dragon Lore Chicken', r: 6, v: 1250, inc: 7, color: '#d6b25c', lore: true },
];
export const BREED = Object.fromEntries(BREEDS.map((b) => [b.id, b]));

export const HATS = [
  { id: 'none', n: 'No Hat', w: 45, m: 1 },
  { id: 'party', n: 'Party Hat', w: 14, m: 1.1 },
  { id: 'bandana', n: 'Bandana', w: 10, m: 1.15 },
  { id: 'santa', n: 'Santa Hat', w: 9, m: 1.25 },
  { id: 'bunny', n: 'Bunny Ears', w: 7, m: 1.3 },
  { id: 'sombrero', n: 'Sombrero', w: 5, m: 1.5 },
  { id: 'pumpkin', n: 'Pumpkin Head', w: 4, m: 1.8 },
  { id: 'helmet', n: 'Ballistic Helmet', w: 3, m: 2 },
  { id: 'viking', n: 'Viking Helmet', w: 2, m: 2.5 },
  { id: 'crown', n: 'Golden Crown', w: 0.8, m: 4 },
  { id: 'halo', n: 'Halo', w: 0.4, m: 6 },
];
export const HAT = Object.fromEntries(HATS.map((h) => [h.id, h]));

export const CHICKEN_COOP = {
  id: 'custom-chickens', n: 'Chicken Coop Crate', kind: 'chickens', key: false, custom: true,
  date: '', img: '', icon: 'chicken', price: 8.99,
  pools: Object.fromEntries([2, 3, 4, 5, 6].map((r) => [r, BREEDS.filter((b) => b.r === r).map((b) => b.id)])),
};

const TIER_ODDS = [[2, 0.7992], [3, 0.1598], [4, 0.032], [5, 0.0064], [6, 0.0026]];

export function rollChicken(r = rand, src = 'Chicken Coop Crate') {
  const tier = pickWeighted(TIER_ODDS, r);
  const options = BREEDS.filter((b) => b.r === tier);
  const breed = options[Math.floor(r() * options.length)];
  const hat = pickWeighted(HATS.map((h) => [h.id, h.w]), r);
  return { uid: uid(), t: 'chicken', id: breed.id, hat, fl: Math.fround(r()), sd: Math.floor(r() * 1001), at: Date.now(), src };
}

// "Feather float": like skin float, lower is more pristine and worth more.
export function featherMult(fl) {
  if (fl < 0.001) return 3;
  if (fl < 0.01) return 1.6;
  if (fl < 0.05) return 1.2;
  return 1 + (1 - fl) * 0.15;
}

export function chickenValue(item) {
  const b = BREED[item.id];
  return round2(b.v * HAT[item.hat].m * featherMult(item.fl));
}

export function chickenIncome(item) {
  const b = BREED[item.id];
  return b.inc * HAT[item.hat].m * (item.fl < 0.01 ? 1.25 : 1);
}

export function chickenName(item) {
  const b = BREED[item.id];
  return item.hat !== 'none' ? `${b.n} (${HAT[item.hat].n})` : b.n;
}
