// "Prepare all CS2 content" (Settings): exports everything the game shows from the player's CS2 install up front, in
// the background (see CS2Service.prepareAll). The renderer knows which items the game has, so it makes the list.
import { D } from '../data.js';
import { S } from '../state.js';
import { cs2Status, cs2Play } from './api.js';
import { toast } from '../ui.js';

const native = () => window.native?.cs2PrepareAll;

// The maps to make first: your last Play map, your matchmaking maps, then Active Duty (CS2Service.bombMaps puts the rest
// after them), so the maps you play are the ones done if the drive fills up.
async function mapOrder() {
  const [{ playPrefs }, { ACTIVE_DUTY }] = await Promise.all([import('../pages/play-settings.js'), import('../engine/premier.js')]);
  const p = playPrefs();
  return [...new Set([p.map, ...Object.values(p.pools || {}).flat(), ...ACTIVE_DUTY].filter((x) => typeof x === 'string'))];
}

// { skins, stickers, crates, agents, anims, weapons, maps } for CS2Service.prepareAll.
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
    crates: D.cases.map((c) => (c.cx ? c.crate?.base : /^crate-(\d+)$/.exec(c.id)?.[1])).filter(Boolean), // (a custom case: the crate it borrows)
    agents: [...AGENTS.T, ...AGENTS.CT],
    anims: botClips(weapons, { gestures: true }),
    weapons,
    maps: await mapOrder(),
  };
}

// Starts preparing everything: false when it's running already (or there's no CS2 install to prepare from).
export async function prepareAll() {
  if (!native() || !(await cs2Status()).available) return false;
  return window.native.cs2PrepareAll(await prepareContent());
}

// Starts preparing just Play's maps (Maps only): false when a run is going already (or there's no CS2 install).
export async function prepareMaps() {
  if (!native() || !window.native.cs2PrepareMaps || !(await cs2Status()).available) return false;
  return window.native.cs2PrepareMaps(await mapOrder());
}

export const prepareStatus = () => (native() ? window.native.cs2PrepareStatus() : Promise.resolve(null));
export const prepareCancel = () => window.native?.cs2PrepareCancel?.();
export const cacheSize = () => (native() ? window.native.cs2CacheSize() : Promise.resolve(null));

// At start: once something has been prepared, a CS2 update gets the same again in the background (only what the update
// changed is exported again): what was prepared last, everything or the maps only. Unless the player turned that off.
export async function keepPrepared() {
  if (!native() || S.settings.keepPrepared === false) return;
  try {
    const st = await prepareStatus();
    if (!st?.keep || st.running) return;
    const maps = st.keep === 'maps';
    if (await (maps ? prepareMaps() : prepareAll())) {
      toast(maps ? 'CS2 was updated: bringing its maps up to date in the background.' : 'CS2 was updated: bringing its models, textures and maps up to date in the background.', 'gold');
    }
  } catch (e) { console.warn('keep prepared', e); }
}
