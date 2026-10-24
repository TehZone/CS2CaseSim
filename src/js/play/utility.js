// The bots' utility lineups (src/data/lineups.json, found by scripts/build-lineups.mjs on each map's geometry): a spot to
// stand on, an aim and a throw that put a smoke, a molotov or a pop flash where it does its job. Each is checked again on
// this match's collision (doors and all) when the map loads, so one a door now blocks isn't used.
import { throwVelocity, throwOrigin, simulateFlight } from './flight.js';

const EYE = 64, JUMP = 301.993;
let all = null;

export async function loadLineups(mapId, col) {
  all ||= fetch('data/lineups.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  const list = (await all)[mapId] || [];
  return list.filter((l) => {
    const res = landing(col, l);
    const off = res && Math.hypot(res.pos[0] - l.land[0], res.pos[1] - l.land[1], res.pos[2] - l.land[2]);
    return off != null && off < (l.kind === 'flash' ? 160 : 110);
  });
}

// Where a lineup's grenade goes off, thrown from its spot (pitch and yaw nudged by err: [dp, dy] degrees).
export function landing(col, l, err = [0, 0]) {
  const eye = [l.pos[0], l.pos[1], l.pos[2] + EYE], pitch = l.pitch + err[0], yaw = l.yaw + err[1];
  return simulateFlight(col, throwOrigin(col, eye, pitch, yaw), throwVelocity(pitch, yaw, l.strength, l.jump ? [0, 0, JUMP] : [0, 0, 0]), l.kind);
}

// The lineups a side has for a purpose ('A', 'B', 'mid', 'default', 'holdA', 'retakeB'...), by kind.
export function lineupsFor(list, side, purpose, kind = null) {
  return (list || []).filter((l) => l.side === side && l.purpose.includes(purpose) && (!kind || l.kind === kind));
}

export const NADE_OF = { smoke: 'weapon_smokegrenade', flash: 'weapon_flashbang', he: 'weapon_hegrenade' };
// The grenade a bot throws a lineup of this kind with (its side's molotov for fire).
export const nadeFor = (kind, team) => (kind === 'fire' ? (team === 'T' ? 'weapon_molotov' : 'weapon_incgrenade') : NADE_OF[kind]);
