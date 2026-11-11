// Rare drops for the Discord server: anything gold (every knife and pair of gloves), a Doppler, or a Blue Gem pattern on a
// weapon, opened or traded up to online.
// What counts comes from the game's own pattern analysis (src/js/engine/patterns.js), the labels players see on the item.
import { createRequire } from 'node:module';
import { D } from '../src/js/engine/data.js';
import { analyzePattern } from '../src/js/engine/patterns.js';
import { itemName, itemValue, wearName } from '../src/js/engine/items.js';
import { TRADEUP_SRC } from '../src/js/engine/tradeup.js';

const STEAM = 'https://community.akamai.steamstatic.com/economy/image/';
const BLUE = 0x4b69ff, GOLD = 0xffd700, DOPPLER = 0xd32ce6;
// A custom item's picture ships in the game (src/custom/...), so Discord gets it from the game's own GitHub repository, at
// the commit the server runs (SERVER_COMMIT, which deploy/vps writes), else main. Discord fetches it, not the players.
const { REPO } = createRequire(import.meta.url)('../shared/release.cjs');
export function customPicture(img, commit = process.env.SERVER_COMMIT || process.env.RENDER_GIT_COMMIT || 'main') {
  if (typeof img !== 'string' || !/^custom\/[\w./-]+\.png$/.test(img) || img.includes('..')) return null;
  return `https://raw.githubusercontent.com/${REPO}/${encodeURIComponent(commit)}/src/${img}`;
}
// (A player's name in Discord's markdown: no styles, no links.)
const md = (s) => String(s).replace(/[\\*_~`|<>[\]()]/g, '\\$&');

// Why an item is worth a post: { title, color, skin, pattern }, or null. The most special reason wins.
export function rareDrop(item) {
  const skin = item?.t === 'skin' ? D.skins[item.id] : null;
  if (!skin) return null;
  const pattern = analyzePattern(skin, item.sd);
  // (A custom finish named like a Doppler isn't one: its knife or gloves post as gold, below.)
  if (!skin.cx && /Doppler/.test(skin.fin || '')) return { title: `✨ ${skin.fin}${skin.ph ? ` · ${skin.ph}` : ''}`, color: DOPPLER, skin, pattern };
  if (pattern.label.includes('Blue Gem')) return { title: `💎 ${pattern.label}`, color: BLUE, skin, pattern };
  if (skin.cat === 'knife') return { title: '🔪 Gold Knife', color: GOLD, skin, pattern };
  if (skin.cat === 'gloves') return { title: '🧤 Gold Gloves', color: GOLD, skin, pattern };
  return null;
}

// The post for a rare item that `player` just opened or traded up to, or null for any other item.
export function dropEmbed(player, item) {
  const rare = rareDrop(item);
  if (!rare) return null;
  const { title, color, skin, pattern } = rare;
  const field = (name, value) => ({ name, value: String(value), inline: true });
  const fields = [];
  if (item.fl != null) fields.push(field('Wear', `${wearName(item)} (${item.fl.toFixed(6)})`));
  if (item.sd != null) fields.push(field('Pattern', `#${item.sd}`));
  fields.push(field('Value', `$${itemValue(item).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`));
  for (const [k, v] of pattern.info) fields.push(field(k, v));
  if (pattern.label && !title.includes(pattern.label)) fields.push(field('Pattern type', pattern.label));
  if (item.sn) fields.push(field('Serial', `#${item.sn}`));
  const img = skin.img?.startsWith('~') ? STEAM + skin.img.slice(1) + '/256fx192f' : customPicture(skin.img);
  const traded = item.src === TRADEUP_SRC;
  return {
    title, color, fields, timestamp: new Date().toISOString(),
    description: `**${md(player)}** ${traded ? 'traded up to' : 'unboxed'} **${md(itemName(item))}**${item.src && !traded ? ` from **${md(item.src)}**` : ''}`,
    ...(img ? { thumbnail: { url: img } } : {}),
  };
}
