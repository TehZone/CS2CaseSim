// The shape of a player's state. Every function takes the state object explicitly so the same rules run on the client
// (offline save) and on the multiplayer server (online account). Money is earned by playing matches (see levels.js).
import { freshRank } from './ranks.js';
import { freshMM } from './matchmaking.js';
import { freshProfile } from './levels.js';

// Auto-sell rules for new drops: sell anything worth less than `below` dollars and/or of the rarity ranks in
// `ranks` (0 Consumer ... 5 Covert). Knives, gloves and other ★ items are never auto-sold.
export const AUTO_SELL_DEFAULT = { on: false, below: 0, ranks: [], keepStt: true, keepRare: true };

export function freshState() {
  return {
    v: 2,
    money: 10,
    stars: 0,
    starSpend: 0, // case spending towards the next armory star
    inv: [],
    team: freshTeam(),
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
    stats: {
      opened: 0, spent: 0, sold: 0,
      bestValue: 0, bestName: '', drops: {}, knives: 0, stickersApplied: 0,
      tradeups: 0, armory: 0, packs: 0, gambleWagered: 0, gambleWon: 0, battles: 0, matches: 0,
      playMatches: 0, playWins: 0, playKills: 0, playEarned: 0,
    },
    settings: { volume: 0.5, fast: false, confirmSellAbove: 25, showOdds: true, autoSell: { ...AUTO_SELL_DEFAULT } },
    created: Date.now(),
    lastSeen: Date.now(),
  };
}

export function freshTeam() {
  return { name: 'My Team', slots: { IGL: null, AWP: null, Entry: null, Support: null, Lurk: null }, bench: [null, null], tokens: {}, w: 0, l: 0, elo: 1000, cup: null, history: [] };
}

// Older saves: fill in anything added since.
export function upgradeState(saved) {
  const base = freshState();
  const st = { ...base, ...saved, stats: { ...base.stats, ...saved.stats }, settings: { ...base.settings, ...saved.settings } };
  st.settings.autoSell = { ...AUTO_SELL_DEFAULT, ...(saved.settings?.autoSell || {}) };
  st.team = { ...freshTeam(), ...(saved.team || {}) };
  st.team.slots = { ...freshTeam().slots, ...(st.team.slots || {}) };
  st.loadout = { ...(saved.loadout || {}) };
  st.mm = { ...freshMM(), ...(saved.mm || {}) };
  st.prof = { ...freshProfile(), ...(saved.prof || {}) };
  st.serialsBackfilled = !!saved.serialsBackfilled; // saves from before serials get theirs on load (items.backfillSerials)
  st.v = base.v;
  return st;
}
