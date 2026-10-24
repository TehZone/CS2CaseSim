// "Prepare all CS2 content" (Settings): exports everything the game shows from the player's CS2 install up front, in
// the background (see CS2Service.prepareAll). The renderer knows which items the game has, so it makes the list.
import { D } from '../data.js';
import { S } from '../state.js';
import { cs2Status, cs2Play } from './api.js';
import { toast } from '../ui.js';

const native = () => window.native?.cs2PrepareAll;

// { skins, stickers, crates, agents, anims, weapons } for CS2Service.prepareAll.
async function prepareContent() {
  const { AGENTS, botClips } = await import('../play/bots.js');
  const stats = await cs2Play('stats').catch(() => ({}));
  const weapons = Object.keys(stats || {}).filter((id) => /^weapon_/.test(id));
  const skins = Object.values(D.skins).filter((s) => s.wid).map((s) => ({ weapon: s.wid, paint: s.v ? null : s.fid || null }));
  // Play mode's guns (and the bomb) on their own, without a skin.
  for (const id of weapons) skins.push({ weapon: id, paint: null });
  return {
    skins,
    stickers: [...new Set(Object.values(D.stickers).map((s) => s.sm).filter(Boolean))],
    crates: D.cases.map((c) => /^crate-(\d+)$/.exec(c.id)?.[1]).filter(Boolean),
    agents: [...AGENTS.T, ...AGENTS.CT],
    anims: botClips(weapons, { gestures: true }),
    weapons,
  };
}

// Starts preparing everything: false when it's running already (or there's no CS2 install to prepare from).
export async function prepareAll() {
  if (!native() || !(await cs2Status()).available) return false;
  return window.native.cs2PrepareAll(await prepareContent());
}

export const prepareStatus = () => (native() ? window.native.cs2PrepareStatus() : Promise.resolve(null));
export const prepareCancel = () => window.native?.cs2PrepareCancel?.();
export const cacheSize = () => (native() ? window.native.cs2CacheSize() : Promise.resolve(null));

// At start: once everything has been prepared, a CS2 update gets the same again in the background (only what the
// update changed is exported again), unless the player turned that off.
export async function keepPrepared() {
  if (!native() || S.settings.keepPrepared === false) return;
  try {
    const st = await prepareStatus();
    if (!st?.last?.outdated || st.running) return;
    if (await prepareAll()) toast('CS2 was updated: bringing its models, textures and maps up to date in the background.', 'gold');
  } catch (e) { console.warn('keep prepared', e); }
}
