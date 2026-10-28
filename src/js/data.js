// Client side of the game data: fetches game-data.json (bundled, or refreshed prices) and the case keys into the shared
// engine tables.
import { initData } from './engine/data.js';

export * from './engine/data.js';

export async function loadData() {
  const [res, keys] = await Promise.all([fetch('data/game-data.json'), fetch('data/keys.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}))]);
  if (!res.ok) throw new Error('Could not load game data');
  initData(await res.json(), { keys });
}
