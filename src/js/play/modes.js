// CS2's other game modes, next to Competitive (match.js):
//  - Premier: Competitive's rules over the full MR12 (first to 13, overtime on a tie), the map picked by banning from the
//    Active Duty pool, and a CS Rating instead of a skill group (engine/premier.js).
//  - Wingman: 2v2 on one bomb site, first to 9 rounds, shorter rounds.
//  - Deathmatch: 10 minutes of respawning, every weapon free from the buy menu anywhere, points for kills (more for a
//    headshot or a pistol/knife kill); free-for-all or teams.
//  - Arms Race: free-for-all; every kill moves you to the next weapon, the last one is the knife; a knife kill also
//    sets the victim back a weapon. First to get a knife kill wins.
// Deathmatch and Arms Race keep the round system's shape (phase, time, the bomb's state) so the rest of the game
// treats them like one long round.
import { RULES, CATALOG } from './match.js';

export const MODES = {
  premier: { name: 'Premier', blurb: 'CS Rating, map pick/ban, MR12 with overtime' },
  competitive: { name: 'Competitive', blurb: 'Rounds, economy and the bomb' },
  wingman: { name: 'Wingman', blurb: '2v2 on one bomb site, first to 9' },
  deathmatch: { name: 'Deathmatch', blurb: 'Respawn, free weapons, most points in 10 minutes', respawn: true },
  armsrace: { name: 'Arms Race', blurb: 'A new weapon every kill, the knife last', respawn: true },
};
export const WINGMAN_RULES = { ...RULES, freeze: 10, roundTime: 90, buyTime: 15, maxRounds: 16, winsNeeded: 9, halftime: 8 };

// Arms Race's weapons, in order (the knife is the last level).
export const ARMS_RACE = ['weapon_m4a1_silencer', 'weapon_ak47', 'weapon_aug', 'weapon_famas', 'weapon_galilar', 'weapon_awp', 'weapon_p90',
  'weapon_mp9', 'weapon_mac10', 'weapon_nova', 'weapon_xm1014', 'weapon_negev', 'weapon_deagle', 'weapon_fiveseven', 'weapon_tec9', 'weapon_glock',
  'weapon_knife'];
const RESPAWN = 2, PROTECT = 2;
// Deathmatch points: CS2 gives more for harder kills.
const POINTS = { base: 10, headshot: 5, pistol: 5, knife: 20 };
const PISTOLS = new Set(CATALOG[0].items.map(([id]) => id));

export class Deathmatch {
  constructor(game, { minutes = 10, ffa = true, armsRace = false } = {}) {
    this.game = game;
    this.ffa = ffa || armsRace;
    this.armsRace = armsRace;
    this.rules = { ...RULES, freeze: 0, roundTime: minutes * 60, buyTime: Infinity, maxRounds: 1, winsNeeded: Infinity };
    this.round = 0;
    this.score = { A: 0, B: 0 };
    this.lossStreak = { T: 0, CT: 0 };
    this.history = [];
    this.phase = 'live';
    this.time = this.rules.roundTime;
    this.bomb = { state: 'none', pos: null };
    this.leader = null;
  }

  sideOf(squad) { return this.game.combatants.find((c) => c.squad === squad)?.team; }
  alive(side) { return this.game.combatants.filter((c) => c.alive && c.team === side); }
  get buyOpen() { return this.phase === 'live' && !this.armsRace; }
  get roundTimeLeft() { return this.time; }

  startRound() {
    this.round = 1;
    this.phase = 'live';
    this.time = this.rules.roundTime;
    for (const c of this.game.combatants) { c.points = 0; c.level = 0; c.roundKills = 0; c.roundDamage.clear(); c.hasC4 = false; }
    this.game.onRoundStart(1, { halftime: false, pistol: false, respawn: true });
    this.game.onLive();
  }

  tick(dt) {
    if (this.phase === 'over') return;
    this.time -= dt;
    const now = this.game.now;
    for (const c of this.game.combatants) if (!c.alive && c.respawnAt != null && now >= c.respawnAt) { c.respawnAt = null; this.game.respawn(c); }
    if (this.time <= 0) this.end();
  }

  end(winner = null) {
    if (this.phase === 'over') return;
    this.phase = 'over';
    const list = this.game.combatants.slice().sort((a, b) => this.rank(b) - this.rank(a));
    this.leader = winner || list[0];
    this.game.onMatchOver(this.winnerSquad());
  }
  rank(c) { return this.armsRace ? c.level * 1000 + c.kills : c.points; }
  finished() { return this.phase === 'over'; }
  winnerSquad() {
    if (this.ffa) return this.leader === this.game.me ? 'A' : 'B';
    return this.score.A === this.score.B ? null : this.score.A > this.score.B ? 'A' : 'B';
  }

  // No bomb in these modes.
  canPlant() { return false; }
  siteAt() { return null; }
  planted() {} startDefuse() { return false; } dropBomb() {} pickupBomb() {} endRound() {}
  checkElimination() {}

  // Buying: any gun, free, anywhere (no grenades or gear: you respawn with armor).
  priceOf() { return 0; }
  costFor() { return 0; }
  canBuy(c, id) { return this.buyOpen && c.alive && id.startsWith('weapon_') && !CATALOG[4].items.some(([g]) => g === id) && id !== 'weapon_taser'; }
  pay() {}

  onDamage(victim, attacker, amount) {
    if (!attacker || attacker === victim) return;
    if (this.game.hostile(attacker, victim)) attacker.damage += amount;
  }

  onKill(victim, attacker, weapon, { headshot = false } = {}) {
    victim.deaths++;
    victim.respawnAt = this.game.now + RESPAWN;
    if (!attacker || attacker === victim || !this.game.hostile(attacker, victim)) {
      if (attacker === victim || !attacker) victim.points = Math.max(0, (victim.points || 0) - POINTS.base); // suicide
      return;
    }
    attacker.kills++; attacker.roundKills++;
    if (headshot) attacker.hsKills = (attacker.hsKills || 0) + 1;
    const id = weapon?.id || '';
    const knife = /knife|bayonet/.test(id);
    attacker.points = (attacker.points || 0) + POINTS.base + (headshot ? POINTS.headshot : 0) + (PISTOLS.has(id) ? POINTS.pistol : 0) + (knife ? POINTS.knife : 0);
    attacker.score = attacker.points;
    if (!this.ffa) this.score[attacker.squad]++;
    if (this.armsRace) {
      if (knife && victim.level > 0) { victim.level--; this.game.onLevel(victim, -1); } // knifed: back one weapon
      if (attacker.level >= ARMS_RACE.length - 1) { this.end(attacker); return; } // the knife kill wins
      attacker.level++;
      this.game.onLevel(attacker, 1);
    }
  }
}

export { RESPAWN, PROTECT };
