// CS:GO competitive rank badges for the pages and the Play HUD: CS2's skill group emblems when the game is installed
// (see CS2Service.playRanks), else the rank's short name.
import { cs2Status, cs2Play } from './cs2/api.js';
import { esc } from './util.js';
import { SKILL_GROUPS, SHORT_NAMES } from './engine/ranks.js';

let art = null, job = null;
// The emblems and rank-up art, loaded once ({ emblems, flag, halo }, or null without CS2).
export function loadRankArt() {
  job ||= cs2Status().then((s) => (s.available ? cs2Play('ranks') : null)).then((a) => (art = a)).catch(() => null);
  return job;
}
export const rankArt = () => art;

// The emblem to show for a rank (see engine/ranks.js rankInfo): its group, the '?' plate (0) until placed, 'expired'.
export const rankKey = (info) => (info.expired ? 'expired' : info.group);

// An emblem: a group 1..18, 0 for unranked or 'expired'. size: its height in pixels.
export function emblemHtml(key, { size = 24 } = {}) {
  const name = typeof key === 'number' ? (key ? SKILL_GROUPS[key - 1] : 'Unranked') : 'Rank expired';
  const url = art?.emblems?.[key];
  if (url) return `<img class="rank-emblem" src="${url}" alt="${esc(name)}" title="${esc(name)}" style="height:${size}px">`;
  return `<span class="rank-emblem text" title="${esc(name)}" style="--h:${size}px">${esc(typeof key === 'number' && key ? SHORT_NAMES[key - 1] : '?')}</span>`;
}
