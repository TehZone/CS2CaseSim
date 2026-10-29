// Who the bots are. The source is swappable; each gives [{ id, name, country, team, avatar }]:
//  - offline, the NPC players (engine/npcs.js: the people in Friends, trading and the Item Database), each with the
//    skins they own: loadout { guns: { weapon_ak47: item, ... }, knife, gloves } (npcs.js loadoutOf), npc: their id.
//  - src/data/bot-players.json when it's there (scripts/build-bot-players.mjs, from Liquipedia): gamer tags, countries,
//    teams and photos, credited as Liquipedia's (CC-BY-SA), see CREDIT.
//  - else the pros in the game data (from the Majors' autograph stickers): name, country, team, and their autograph
//    sticker as the picture. One entry a player (their latest).
// pickIdentities hands out as many as a match needs at random, nobody twice. A bot's rank isn't part of who it is: it
// comes from its skill (a skill group in Competitive, a CS Rating in Premier).
import { D } from '../data.js';
import { imgUrl } from '../util.js';
import { S } from '../state.js';
import { act, online } from '../backend.js';
import { crowd, inventoryOf, loadoutOf } from '../engine/npcs.js';

export const CREDIT = 'Player data: Liquipedia (CC-BY-SA)';

let liquipedia; // bot-players.json's players (null when it isn't there)
async function fromLiquipedia() {
  if (liquipedia === undefined) {
    try {
      const r = await fetch('data/bot-players.json');
      liquipedia = r.ok ? (await r.json()).players?.filter((p) => p?.id) || null : null;
    } catch { liquipedia = null; }
  }
  return liquipedia?.length ? liquipedia.map((p) => ({ id: 'lq-' + p.id, name: String(p.id), country: p.country || null, team: p.team || null,
    avatar: p.img ? imgUrl(p.img) : null, source: 'liquipedia' })) : null;
}

let pros = null;
function fromPros() {
  if (!pros) {
    const latest = new Map();
    for (const p of Object.values(D.pros || {})) { const cur = latest.get(p.pid); if (!cur || p.y > cur.y) latest.set(p.pid, p); }
    pros = [...latest.values()].map((p) => ({ id: 'pro-' + p.pid, name: p.n, country: p.geo && p.geo !== 'WORLD' ? p.geo : null, team: D.proTeams?.[p.tm]?.n || null,
      avatar: p.img ? imgUrl(p.img, 's') : null, source: 'pros' }));
  }
  return pros;
}

// The NPC players, offline (null online, where they aren't). Their loadout is what they own as the match starts (worked
// out when it's first asked for: only those picked are).
async function fromNpcs() {
  if (online()) return null;
  if (!S.social) await act('npc.tick').catch(() => {});
  const so = S.social;
  if (!so) return null;
  return crowd(so.seed).map((n) => {
    let loadout = null;
    return { id: 'npc-' + n.id, npc: n.id, name: n.name, country: n.country || null, team: null, level: n.level,
      avatar: D.agents[n.avatar]?.img ? imgUrl(D.agents[n.avatar].img, 's') : null, source: 'npc',
      get loadout() { return (loadout ||= loadoutOf(inventoryOf(so, n))); } };
  });
}

// Everyone the bots can be: offline the NPC players, else Liquipedia's players if they're there, else the game data's pros.
export async function botIdentities() { return (await fromNpcs()) || (await fromLiquipedia()) || fromPros(); }

// n identities at random, none twice (fewer if there aren't enough); rng: () => 0..1.
export function pickIdentities(list, n, rng = Math.random) {
  const pool = list.slice();
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return pool.slice(0, n);
}

// Whether the credit has to show (Liquipedia's data is in use).
export const needsCredit = (ids) => ids.some((x) => x?.source === 'liquipedia');
