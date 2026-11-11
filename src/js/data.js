// Client side of the game data: fetches game-data.json (bundled, or refreshed prices) and the case keys into the shared
// engine tables.
import { initData } from './engine/data.js';

export * from './engine/data.js';

export async function loadData() {
  const [res, keys, custom] = await Promise.all([fetch('data/game-data.json'), fetch('data/keys.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({})), loadCustom()]);
  if (!res.ok) throw new Error('Could not load game data');
  initData(await res.json(), { keys, custom });
}

// Custom content (CUSTOM_CONTENT.md): data/custom.json, which only a game built with some has (the app answers null for
// it otherwise). One that's there but broken stops the game, as the server would refuse it anyway.
async function loadCustom() {
  const res = await fetch('data/custom.json').catch(() => null);
  if (!res?.ok) return null;
  return res.json();
}
