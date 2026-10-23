// Loadout: what you have equipped — gloves (worn in the first-person inspect), a knife, one agent per side and one
// skin per gun. Stored as slot -> uid in S.loadout (see engine items.loadoutSlot).
import { S } from './state.js';
import * as I from './items.js';

export const MAIN_SLOTS = [['gloves', 'Gloves'], ['knife', 'Knife'], ['agentT', 'T Agent'], ['agentCT', 'CT Agent']];

// Every gun's slot, grouped and ordered like CS2's loadout and buy menu, with the side that can buy it ('' = both).
export const GUN_GROUPS = [
  ['Pistols', ['Glock-18:T', 'P2000:CT', 'USP-S:CT', 'Dual Berettas', 'P250', 'Tec-9:T', 'Five-SeveN:CT', 'CZ75-Auto', 'Desert Eagle', 'R8 Revolver']],
  ['Mid-Tier', ['MAC-10:T', 'MP9:CT', 'MP7', 'MP5-SD', 'UMP-45', 'P90', 'PP-Bizon', 'Nova', 'XM1014', 'Sawed-Off:T', 'MAG-7:CT', 'M249', 'Negev']],
  ['Rifles', ['Galil AR:T', 'FAMAS:CT', 'AK-47:T', 'M4A4:CT', 'M4A1-S:CT', 'SSG 08', 'SG 553:T', 'AUG:CT', 'AWP', 'G3SG1:T', 'SCAR-20:CT']],
].map(([name, guns]) => [name, guns.map((g) => { const [w, side = ''] = g.split(':'); return { slot: 'w:' + w, side }; })]);
export const ZEUS_SLOT = 'w:Zeus x27';

export function equipped(slot) {
  const uid = S.loadout?.[slot];
  return uid ? S.inv.find((i) => i.uid === uid) || null : null;
}

export function isEquipped(item) {
  const slot = I.loadoutSlot(item);
  return !!slot && S.loadout?.[slot] === item.uid;
}

export function slotName(slot) {
  return MAIN_SLOTS.find(([k]) => k === slot)?.[1] || slot.replace(/^w:/, '');
}

// Uids of everything equipped (protected from bulk selling).
export function equippedUids() {
  return new Set(Object.values(S.loadout || {}).filter((u) => S.inv.some((i) => i.uid === u)));
}
