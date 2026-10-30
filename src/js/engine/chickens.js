// Chickens, from the old Chicken Coop Crate (no longer in the game). Kept to name and price the ones in older saves,
// which are sold once when the save loads (items.retireOld).
import { round2 } from './util.js';

export const BREEDS = [
  { id: 'farm', n: 'Farm Chicken', r: 2, v: 0.55 },
  { id: 'brown', n: 'Brown Hen', r: 2, v: 0.65 },
  { id: 'speckled', n: 'Speckled Rooster', r: 2, v: 0.8 },
  { id: 'midnight', n: 'Midnight Chicken', r: 3, v: 3.4 },
  { id: 'zombie', n: 'Zombie Chicken', r: 3, v: 3.9 },
  { id: 'camo', n: 'Dust II Camo Chicken', r: 3, v: 4.4 },
  { id: 'ghost', n: 'Ghost Chicken', r: 4, v: 21 },
  { id: 'neon', n: 'Neon Rider Chicken', r: 4, v: 26 },
  { id: 'golden', n: 'Golden Chicken', r: 5, v: 140 },
  { id: 'holo', n: 'Holo Chicken', r: 5, v: 165 },
  { id: 'diamond', n: '★ Diamond Chicken', r: 6, v: 900 },
  { id: 'lore', n: '★ Dragon Lore Chicken', r: 6, v: 1250 },
];
export const BREED = Object.fromEntries(BREEDS.map((b) => [b.id, b]));

export const HATS = [
  { id: 'none', n: 'No Hat', m: 1 },
  { id: 'party', n: 'Party Hat', m: 1.1 },
  { id: 'bandana', n: 'Bandana', m: 1.15 },
  { id: 'santa', n: 'Santa Hat', m: 1.25 },
  { id: 'bunny', n: 'Bunny Ears', m: 1.3 },
  { id: 'sombrero', n: 'Sombrero', m: 1.5 },
  { id: 'pumpkin', n: 'Pumpkin Head', m: 1.8 },
  { id: 'helmet', n: 'Ballistic Helmet', m: 2 },
  { id: 'viking', n: 'Viking Helmet', m: 2.5 },
  { id: 'crown', n: 'Golden Crown', m: 4 },
  { id: 'halo', n: 'Halo', m: 6 },
];
export const HAT = Object.fromEntries(HATS.map((h) => [h.id, h]));

// "Feather float": like skin float, lower is more pristine and worth more.
export function featherMult(fl) {
  if (fl < 0.001) return 3;
  if (fl < 0.01) return 1.6;
  if (fl < 0.05) return 1.2;
  return 1 + (1 - fl) * 0.15;
}

export function chickenValue(item) {
  const b = BREED[item.id];
  return round2(b.v * (HAT[item.hat]?.m || 1) * featherMult(item.fl));
}

export function chickenName(item) {
  const b = BREED[item.id];
  return item.hat !== 'none' && HAT[item.hat] ? `${b.n} (${HAT[item.hat].n})` : b.n;
}
