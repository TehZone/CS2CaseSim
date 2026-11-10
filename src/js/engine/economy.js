// The shape of a player's state. Every function takes the state object explicitly so the same rules run on the client
// (offline save) and on the multiplayer server (online account). Money is earned by playing matches and by passive income
// (see levels.js).
import { freshRank } from './ranks.js';
import { freshMM } from './matchmaking.js';
import { freshProfile, freshPassive } from './levels.js';
import { repairStorage } from './storage.js';
import { freshIndex, upgradeIndex } from './itemindex.js';

// Auto-sell rules for new drops: sell anything worth less than `below` dollars and/or of the rarity ranks in
// `ranks` (0 Consumer ... 5 Covert). Knives, gloves and other ★ items are never auto-sold. keepRare keeps rare patterns, and
// keepBlue and keepFloat Blue Gems and floats of 0.000-something: until they're set they follow keepRare, which used to mean
// all three (older saves and older games have only that).
export const AUTO_SELL_DEFAULT = { on: false, below: 0, ranks: [], keepStt: true, keepRare: true };

// (now: when it's made; the server passes its own clock's)
export function freshState(now = Date.now()) {
  return {
    v: 2,
    money: 10,
    passive: freshPassive(now), // passive income: the time it's been counted up to, and what it has paid (see levels.js)
    stars: 0,
    starSpend: 0, // case spending towards the next armory star
    inv: [],
    stored: [], // what's in your Storage Units (see storage.js)
    loadout: {}, // slot (see items.loadoutSlot) -> uid
    charmDetach: 0, // Charm Detachments left (taking a charm off a gun uses one)
    serials: {}, // offline serial counters: items.serialKey -> last number given
    serialsBackfilled: true, // (older saves get their unboxed items numbered once on load)
    rank: freshRank(), // CS:GO competitive rank from Play (see ranks.js)
    wingman: freshRank(), // and Wingman's own
    mm: freshMM(), // matchmaking: an abandon's cooldown, the ranked match you're in (see matchmaking.js)
    prof: freshProfile(), // your level, XP, Service Medals and level-up rewards waiting (see levels.js)
    play: null, // the Play match you're in: { run, mode, at } (what its reward is checked against)
    social: null, // offline: the NPC players, your chats and offers with them, and your profile (see npcs.js)
    index: freshIndex(), // the record of what you've unboxed and the rewards claimed for it (see itemindex.js)
    stats: {
      opened: 0, spent: 0, sold: 0,
      bestValue: 0, bestName: '', drops: {}, knives: 0, stickersApplied: 0,
      tradeups: 0, armory: 0, gambleWagered: 0, gambleWon: 0, battles: 0,
      playMatches: 0, playWins: 0, playKills: 0, playEarned: 0,
    },
    settings: { volume: 0.5, fast: false, confirmSellAbove: 25, showOdds: true, autoSell: { ...AUTO_SELL_DEFAULT } },
    created: now,
    lastSeen: now,
  };
}

// Older saves: fill in anything added since.
export function upgradeState(saved) {
  const base = freshState();
  const st = { ...base, ...saved, stats: { ...base.stats, ...saved.stats }, settings: { ...base.settings, ...saved.settings } };
  st.settings.autoSell = { ...AUTO_SELL_DEFAULT, ...(saved.settings?.autoSell || {}) };
  delete st.team; // (the old Team manager's)
  st.loadout = { ...(saved.loadout || {}) };
  st.mm = { ...freshMM(), ...(saved.mm || {}) };
  st.prof = { ...freshProfile(), ...(saved.prof || {}) };
  st.serialsBackfilled = !!saved.serialsBackfilled; // saves from before serials get theirs on load (items.backfillSerials)
  repairStorage(st); // saves from before Storage Units have none
  st.index = upgradeIndex(saved.index); // (saves from before the Index are filled in as they load: itemindex.backfillIndex)
  // Passive income's clock as saved. One from before it has none, and isn't given one here: it starts counting at its first
  // collect, which saves it (a clock made on every load would lose the time between loads that never collected).
  if (!Number.isFinite(saved.passive?.at)) delete st.passive;
  st.v = base.v;
  return st;
}
