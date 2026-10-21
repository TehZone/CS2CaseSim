// Client side of the game data: fetches game-data.json (bundled, or refreshed prices) into the shared engine tables.
import { initData } from './engine/data.js';

export * from './engine/data.js';

export async function loadData() {
  const res = await fetch('data/game-data.json');
  if (!res.ok) throw new Error('Could not load game data');
  initData(await res.json());
}
