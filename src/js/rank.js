// CS:GO competitive rank badges for the pages and the Play HUD: CS2's skill group emblems when the game is installed
// (see CS2Service.playRanks), else the rank's short name.
import { cs2Status, cs2Play } from './cs2/api.js';
import { esc } from './util.js';
import { SKILL_GROUPS, SHORT_NAMES } from './engine/ranks.js';
import { tierOf, formatRating } from './engine/premier.js';

let art = null, job = null, pictures = null;
// The emblems and rank-up art, loaded once ({ emblems, flag, halo }, or null without CS2).
export function loadRankArt() {
  job ||= cs2Status().then((s) => (s.available ? cs2Play('ranks') : null)).then((a) => { art = a; pictures = a ? toPictures(a.emblems) : null; return a; }).catch(() => null);
  return job;
}
export const rankArt = () => art;
// Once every emblem is a picture (Play waits for it as it loads).
export const rankPictures = () => loadRankArt().then(() => pictures);

// CS2's emblems are huge SVGs (Global Elite's is 550 KB: over a thousand paths and gradients for 32 by 13 pixels), and
// one is drawn all over again each time what's around it is (13 ms an emblem: the scoreboard stuttered every time Tab
// brought it up). Each is drawn once into a picture at twice the biggest size shown (64 px), one at a time, and used
// from then on.
async function toPictures(emblems = {}) {
  for (const [k, url] of Object.entries(emblems)) {
    try { emblems[k] = await picture(url, 128); } catch {}
    await new Promise((r) => setTimeout(r, 0));
  }
}
async function picture(url, h) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const w = Math.max(1, Math.round((h * img.naturalWidth) / (img.naturalHeight || img.naturalWidth || 1)));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  return blob ? URL.createObjectURL(blob) : url;
}

// The emblem to show for a rank (see engine/ranks.js rankInfo): its group, the '?' plate (0) until placed, 'expired'.
export const rankKey = (info) => (info.expired ? 'expired' : info.group);

// An emblem: a group 1..18, 0 for unranked or 'expired'. size: its height in pixels. wingman: Wingman's own emblems.
export function emblemHtml(key, { size = 24, wingman = false } = {}) {
  const name = typeof key === 'number' ? (key ? SKILL_GROUPS[key - 1] : 'Unranked') : 'Rank expired';
  const url = art?.emblems?.[wingman ? (typeof key === 'number' ? 'wingman' + key : 'wingman_' + key) : key];
  if (url) return `<img class="rank-emblem" src="${url}" alt="${esc(name)}" title="${esc(name)}" style="height:${size}px">`;
  return `<span class="rank-emblem text" title="${esc(name)}" style="--h:${size}px">${esc(typeof key === 'number' && key ? SHORT_NAMES[key - 1] : '?')}</span>`;
}

// A CS Rating badge like CS2's: the tier's colour, the thousands big ("12" ",345"); null (unrated) shows a dash.
export function ratingHtml(rating, { size = 14, title = '' } = {}) {
  if (rating == null) return `<span class="cs-rating unrated" style="--fs:${size}px" title="${esc(title || 'Unrated')}">---</span>`;
  const t = tierOf(rating), s = formatRating(rating), cut = s.lastIndexOf(',');
  return `<span class="cs-rating" style="--c:${t.color};--fs:${size}px" title="${esc(title || `CS Rating ${s} (${t.name})`)}"><b>${cut > 0 ? s.slice(0, cut) : s}</b>${cut > 0 ? s.slice(cut) : ''}</span>`;
}
