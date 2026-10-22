// Loadout: what you have equipped — gloves (worn in the first-person inspect), a knife, one agent per side and one
// skin per gun. Stored as slot -> uid in S.loadout (see engine items.loadoutSlot).
import { S } from './state.js';
import * as I from './items.js';

export const MAIN_SLOTS = [['gloves', 'Gloves'], ['knife', 'Knife'], ['agentT', 'T Agent'], ['agentCT', 'CT Agent']];

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
