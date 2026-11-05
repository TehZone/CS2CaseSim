// Rare unboxings for the Discord server: a Blue Gem or Gold Gem knife or weapon, or a Doppler, opened by a player online.
// What counts comes from the game's own pattern analysis (src/js/engine/patterns.js), the labels players see on the item.
import { D } from '../src/js/engine/data.js';
import { analyzePattern } from '../src/js/engine/patterns.js';
import { itemName, itemValue, wearName } from '../src/js/engine/items.js';

const STEAM = 'https://community.akamai.steamstatic.com/economy/image/';
const BLUE = 0x4b69ff, GOLD = 0xffd700, DOPPLER = 0xd32ce6;
// (A player's name in Discord's markdown: no styles, no links.)
const md = (s) => String(s).replace(/[\\*_~`|<>[\]()]/g, '\\$&');

// Why an item is worth a post: { title, color, skin, pattern }, or null. Gloves aren't a knife or weapon.
export function rareDrop(item) {
  const skin = item?.t === 'skin' ? D.skins[item.id] : null;
  if (!skin || skin.cat === 'gloves') return null;
  const pattern = analyzePattern(skin, item.sd);
  if (/Doppler/.test(skin.fin || '')) return { title: `✨ ${skin.fin}${skin.ph ? ` · ${skin.ph}` : ''}`, color: DOPPLER, skin, pattern };
  if (pattern.label.includes('Blue Gem')) return { title: `💎 ${pattern.label}`, color: BLUE, skin, pattern };
  if (pattern.label === 'Gold Gem') return { title: '🥇 Gold Gem', color: GOLD, skin, pattern };
  return null;
}

// The post for a rare item that `player` just opened, or null for any other item.
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
  const img = skin.img?.startsWith('~') ? STEAM + skin.img.slice(1) + '/256fx192f' : null;
  return {
    title, color, fields, timestamp: new Date().toISOString(),
    description: `**${md(player)}** unboxed **${md(itemName(item))}**${item.src ? ` from **${md(item.src)}**` : ''}`,
    ...(img ? { thumbnail: { url: img } } : {}),
  };
}
