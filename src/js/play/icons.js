// CS2's equipment icons (white silhouettes) for the buy menu and the kill feed. The service extracts them from the
// player's install as { name: url } under CS2's own names (panorama/images/icons/equipment/<name>): a weapon id without
// "weapon_" (weapon_m4a1_silencer -> m4a1_silencer, weapon_hegrenade, weapon_c4, weapon_taser), a skin knife's own
// (knife_karambit, bayonet) or else the default knife. Without CS2 there are none and the name is shown instead.

// The buy menu's gear, by CS2's item names.
const GEAR = { vest: 'kevlar', vesthelm: 'assaultsuit', defuser: 'defuser' };

// Icon names to try for an item id, best first. `gun` is the weapon as it was used (a USP-S or M4A1-S with its silencer
// off has its own icon); in the kill feed a molotov or incendiary kill is the fire's (CS2's inferno).
export function iconNames(id, { gun = null, kill = false } = {}) {
  id = String(id || '');
  if (!id) return [];
  const name = GEAR[id] || id.replace(/^weapon_/, '');
  const names = [];
  if (kill && /^(molotov|incgrenade)$/.test(name)) names.push('inferno');
  if (gun?.detachable && !gun.silenced) names.push(name + '_off');
  names.push(name);
  if (/knife|bayonet/.test(name)) names.push('knife');
  return names;
}

// The URL of an item's icon in the extracted set, or null when there isn't one.
export function iconFor(icons, id, opts) {
  for (const n of iconNames(id, opts)) if (icons?.[n]) return icons[n];
  return null;
}
