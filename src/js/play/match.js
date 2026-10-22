// CS2's competitive rules for an offline match: rounds with freeze time and buy time, the round timer, the bomb
// (plant, 40 second fuse, defuse with or without a kit), win conditions, the economy (round rewards, loss bonus,
// kill rewards by weapon) and halftime. The game (game.js) supplies the players and the world; this only keeps score.

export const RULES = {
  freeze: 15, roundTime: 115, buyTime: 20, bombTime: 40, plantTime: 3, defuseTime: 10, defuseKitTime: 5, endDelay: 7,
  startMoney: 800, maxMoney: 16000, maxRounds: 24, winsNeeded: 13, halftime: 12,
};
export const SHORT_RULES = { ...RULES, maxRounds: 16, winsNeeded: 9, halftime: 8 };
const WIN_REWARD = { elimination: 3250, bomb: 3500, defuse: 3500, time: 3250 };
const LOSS_BONUS = [1400, 1900, 2400, 2900, 3400];
const PLANT_BONUS_TEAM = 800, PLANT_BONUS = 300, DEFUSE_BONUS = 300;

// What you can buy, per team (CS2's defaults; the CT gets the M4A4 or the M4A1-S and USP-S or P2000 by loadout).
export const CATALOG = [
  { cat: 'Pistols', items: [
    ['weapon_glock', 'Glock-18', 'T'], ['weapon_usp_silencer', 'USP-S', 'CT'], ['weapon_hkp2000', 'P2000', 'CT'], ['weapon_elite', 'Dual Berettas'],
    ['weapon_p250', 'P250'], ['weapon_tec9', 'Tec-9', 'T'], ['weapon_fiveseven', 'Five-SeveN', 'CT'], ['weapon_cz75a', 'CZ75-Auto'],
    ['weapon_deagle', 'Desert Eagle'], ['weapon_revolver', 'R8 Revolver']] },
  { cat: 'Mid-Tier', items: [
    ['weapon_mac10', 'MAC-10', 'T'], ['weapon_mp9', 'MP9', 'CT'], ['weapon_mp7', 'MP7'], ['weapon_mp5sd', 'MP5-SD'], ['weapon_ump45', 'UMP-45'],
    ['weapon_p90', 'P90'], ['weapon_bizon', 'PP-Bizon'], ['weapon_nova', 'Nova'], ['weapon_xm1014', 'XM1014'], ['weapon_sawedoff', 'Sawed-Off', 'T'],
    ['weapon_mag7', 'MAG-7', 'CT'], ['weapon_negev', 'Negev'], ['weapon_m249', 'M249']] },
  { cat: 'Rifles', items: [
    ['weapon_galilar', 'Galil AR', 'T'], ['weapon_famas', 'FAMAS', 'CT'], ['weapon_ak47', 'AK-47', 'T'], ['weapon_m4a1', 'M4A4', 'CT'],
    ['weapon_m4a1_silencer', 'M4A1-S', 'CT'], ['weapon_ssg08', 'SSG 08'], ['weapon_sg556', 'SG 553', 'T'], ['weapon_aug', 'AUG', 'CT'],
    ['weapon_awp', 'AWP'], ['weapon_g3sg1', 'G3SG1', 'T'], ['weapon_scar20', 'SCAR-20', 'CT']] },
  { cat: 'Gear', items: [['vest', 'Kevlar Vest', null, 650], ['vesthelm', 'Kevlar + Helmet', null, 1000], ['defuser', 'Defuse Kit', 'CT', 400]] },
];
export const ITEM_NAMES = Object.fromEntries(CATALOG.flatMap((c) => c.items.map(([id, name]) => [id, name])));
export const DEFAULT_PISTOL = { T: 'weapon_glock', CT: 'weapon_usp_silencer' };
const PISTOLS = new Set(CATALOG[0].items.map(([id]) => id));
export const slotOf = (id) => (PISTOLS.has(id) ? 'secondary' : 'primary');

let nextId = 1;
// A player in the match (you or a bot).
export class Combatant {
  constructor({ name, team, squad, bot = true }) {
    this.id = nextId++;
    Object.assign(this, { name, team, squad, bot });
    this.money = RULES.startMoney;
    this.kills = 0; this.deaths = 0; this.assists = 0; this.damage = 0; this.mvps = 0; this.score = 0;
    this.health = 100; this.armor = 0; this.helmet = false; this.defuser = false; this.alive = true;
    this.resetWeapons = true; // starts with the default pistol
    this.roundKills = 0; this.roundDamage = new Map(); // attacker id -> damage this round (assists)
  }
}

export class Match {
  constructor(game, rules = RULES) {
    this.game = game;
    this.rules = rules;
    this.round = 0;
    this.score = { A: 0, B: 0 }; // by squad (you and your teammates are squad A)
    this.lossStreak = { T: 0, CT: 0 };
    this.phase = 'freeze';
    this.time = 0; // seconds left in the current phase
    this.history = []; // per round: { winner (side), reason }
    this.bomb = null;
  }

  sideOf(squad) { return this.game.combatants.find((c) => c.squad === squad)?.team || (squad === 'A' ? this.game.team : this.game.enemyTeam); }
  scoreOf(side) { return this.score[this.game.combatants.find((c) => c.team === side)?.squad || (side === this.game.team ? 'A' : 'B')]; }
  alive(side) { return this.game.combatants.filter((c) => c.team === side && c.alive); }

  // ---- round flow -----------------------------------------------------------------------------------------------
  startRound() {
    this.round++;
    const halftime = this.round === this.rules.halftime + 1;
    if (halftime) this.swapSides();
    this.phase = 'freeze';
    this.time = this.rules.freeze;
    this.roundStart = this.game.now;
    this.bomb = { state: 'carried', carrier: null, pos: null, site: null, plantedAt: 0, defuser: null, defuseEnd: 0, beepAt: 0 };
    const ts = this.game.combatants.filter((c) => c.team === 'T');
    for (const c of this.game.combatants) {
      c.roundKills = 0;
      c.roundDamage.clear();
      c.hasC4 = false;
    }
    // One terrorist carries the bomb (you, if you're the only one or by chance).
    if (ts.length) { const carrier = ts[Math.floor(Math.random() * ts.length)]; carrier.hasC4 = true; this.bomb.carrier = carrier; }
    this.game.onRoundStart(this.round, { halftime, pistol: this.round === 1 || halftime });
  }

  swapSides() {
    for (const c of this.game.combatants) {
      c.team = c.team === 'T' ? 'CT' : 'T';
      c.money = this.rules.startMoney;
      c.armor = 0; c.helmet = false; c.defuser = false;
      c.resetWeapons = true;
    }
    this.lossStreak = { T: 0, CT: 0 };
    this.game.team = this.game.me.team;
    this.game.enemyTeam = this.game.team === 'T' ? 'CT' : 'T';
    this.game.onHalftime();
  }

  get buyOpen() { return (this.phase === 'freeze' || (this.phase === 'live' && this.rules.roundTime - this.time < this.rules.buyTime)) && this.phase !== 'end'; }
  get roundTimeLeft() { return this.phase === 'planted' ? null : this.time; }

  tick(dt) {
    if (this.phase === 'over') return;
    this.time -= dt;
    const b = this.bomb;
    if (this.phase === 'freeze' && this.time <= 0) { this.phase = 'live'; this.time = this.rules.roundTime; this.game.onLive(); }
    else if (this.phase === 'live') {
      this.checkElimination();
      if (this.phase === 'live' && this.time <= 0) this.endRound('CT', 'time');
    } else if (this.phase === 'planted') {
      if (b.defuser && (!b.defuser.alive || !this.game.isDefusing(b.defuser))) { b.defuser = null; this.game.onDefuseAbort(); }
      if (b.defuser && this.game.now >= b.defuseEnd) { this.defused(); return; }
      if (this.game.now >= b.plantedAt + this.rules.bombTime) { this.exploded(); return; }
      this.checkElimination();
    } else if (this.phase === 'end' && this.time <= 0) {
      if (this.finished()) { this.phase = 'over'; this.game.onMatchOver(this.winnerSquad()); } else this.startRound();
    }
  }

  checkElimination() {
    const t = this.alive('T').length, ct = this.alive('CT').length;
    if (!ct && t) this.endRound('T', 'elimination');
    else if (!t && this.phase === 'live') this.endRound('CT', 'elimination');
    else if (!t && !ct) this.endRound(this.phase === 'planted' ? 'T' : 'CT', 'elimination');
  }

  // ---- bomb -------------------------------------------------------------------------------------------------------
  canPlant(c, pos) { return this.phase === 'live' && c.alive && c.hasC4 && this.siteAt(pos); }
  siteAt(pos) {
    return (this.game.map.info.bombsites || []).find((s) => pos[0] >= s.min[0] && pos[0] <= s.max[0] && pos[1] >= s.min[1] && pos[1] <= s.max[1]
      && pos[2] >= s.min[2] - 40 && pos[2] <= s.max[2] + 10) || null;
  }
  planted(c, pos) {
    const b = this.bomb;
    b.state = 'planted'; b.pos = pos.slice(); b.site = this.siteAt(pos)?.site || '?'; b.plantedAt = this.game.now; b.carrier = null; b.planter = c;
    c.hasC4 = false;
    c.money = Math.min(this.rules.maxMoney, c.money + PLANT_BONUS);
    c.score += 2;
    this.phase = 'planted';
    this.game.onPlanted(c, b);
  }
  startDefuse(c) {
    const b = this.bomb;
    if (this.phase !== 'planted' || b.defuser || !c.alive || c.team !== 'CT') return false;
    b.defuser = c;
    b.defuseEnd = this.game.now + (c.defuser ? this.rules.defuseKitTime : this.rules.defuseTime);
    this.game.onDefuseStart(c);
    return true;
  }
  defused() {
    const c = this.bomb.defuser;
    this.bomb.state = 'defused';
    c.money = Math.min(this.rules.maxMoney, c.money + DEFUSE_BONUS);
    c.score += 2;
    this.game.onDefused(c);
    this.endRound('CT', 'defuse');
  }
  exploded() {
    this.bomb.state = 'exploded';
    this.game.onExploded(this.bomb);
    this.endRound('T', 'bomb');
  }
  dropBomb(c, pos) {
    if (!c.hasC4) return;
    c.hasC4 = false;
    Object.assign(this.bomb, { state: 'dropped', carrier: null, pos: pos.slice() });
    this.game.onBombDropped(this.bomb);
  }
  pickupBomb(c) {
    if (this.bomb.state !== 'dropped' || c.team !== 'T' || !c.alive) return;
    c.hasC4 = true;
    Object.assign(this.bomb, { state: 'carried', carrier: c, pos: null });
    this.game.onBombPickedUp(c);
  }

  // ---- kills and money --------------------------------------------------------------------------------------------
  onDamage(victim, attacker, amount) {
    if (!attacker || attacker === victim) return;
    victim.roundDamage.set(attacker.id, (victim.roundDamage.get(attacker.id) || 0) + amount);
    if (attacker.team !== victim.team) attacker.damage += amount;
  }
  onKill(victim, attacker, weapon) {
    victim.deaths++;
    if (victim.hasC4) this.dropBomb(victim, this.game.positionOf(victim));
    if (attacker && attacker !== victim && attacker.team !== victim.team) {
      attacker.kills++; attacker.roundKills++; attacker.score += 2;
      const award = weapon?.killAward ?? 300;
      attacker.money = Math.min(this.rules.maxMoney, attacker.money + award);
    }
    // Assists: 41+ damage from someone else on the killer's side.
    for (const [id, dmg] of victim.roundDamage) {
      const a = this.game.combatants.find((c) => c.id === id);
      if (a && a !== attacker && a.team !== victim.team && dmg > 40) { a.assists++; a.score += 1; }
    }
  }

  endRound(winner, reason) {
    if (this.phase === 'end' || this.phase === 'over') return;
    const loser = winner === 'T' ? 'CT' : 'T';
    this.phase = 'end';
    this.time = this.rules.endDelay;
    const winSquad = this.game.combatants.find((c) => c.team === winner)?.squad;
    if (winSquad) this.score[winSquad]++;
    this.history.push({ winner, reason, round: this.round });
    // Money: the winners' reward, the losers' loss bonus (CS2: the streak drops by one on a win).
    const bonus = LOSS_BONUS[Math.min(this.lossStreak[loser], LOSS_BONUS.length - 1)];
    const planted = this.bomb?.state === 'planted' || this.bomb?.state === 'exploded' || this.bomb?.state === 'defused';
    for (const c of this.game.combatants) {
      let add = 0;
      if (c.team === winner) add = WIN_REWARD[reason];
      else {
        // Terrorists still alive when time runs out get nothing.
        add = c.team === 'T' && reason === 'time' && c.alive ? 0 : bonus;
        if (c.team === 'T' && planted) add += PLANT_BONUS_TEAM;
      }
      c.money = Math.min(this.rules.maxMoney, c.money + add);
    }
    this.lossStreak[loser] = Math.min(this.lossStreak[loser] + 1, LOSS_BONUS.length);
    this.lossStreak[winner] = Math.max(0, this.lossStreak[winner] - 1);
    // MVP: most kills on the winning side (the defuser or bomb planter on objective wins).
    const winners = this.game.combatants.filter((c) => c.team === winner);
    let mvp = reason === 'defuse' ? this.bomb.defuser : reason === 'bomb' ? this.bomb.planter : null;
    if (!mvp) mvp = winners.slice().sort((a, b) => b.roundKills - a.roundKills)[0] || null;
    if (mvp) { mvp.mvps++; mvp.score += 1; }
    this.game.onRoundEnd(winner, reason, mvp);
  }

  finished() {
    const r = this.rules;
    return this.score.A >= r.winsNeeded || this.score.B >= r.winsNeeded || this.round >= r.maxRounds;
  }
  winnerSquad() { return this.score.A === this.score.B ? null : this.score.A > this.score.B ? 'A' : 'B'; }

  // ---- buying -----------------------------------------------------------------------------------------------------
  priceOf(id, stats) {
    if (id === 'vest') return 650;
    if (id === 'vesthelm') return 1000;
    if (id === 'defuser') return 400;
    return stats?.[id]?.price || 0;
  }
  // Can this combatant buy the item now? (money, team, phase; the buy zone is checked by the game)
  canBuy(c, id, stats) {
    if (!this.buyOpen || !c.alive) return false;
    const item = CATALOG.flatMap((x) => x.items).find(([i]) => i === id);
    if (!item || (item[2] && item[2] !== c.team)) return false;
    if (id === 'vest' && c.armor >= 100) return false;
    if (id === 'vesthelm' && c.armor >= 100 && c.helmet) return false;
    if (id === 'defuser' && c.defuser) return false;
    return c.money >= this.costFor(c, id, stats);
  }
  // Kevlar + helmet costs only the helmet's $350 with full kevlar already on.
  costFor(c, id, stats) { return id === 'vesthelm' && c.armor >= 100 && !c.helmet ? 350 : this.priceOf(id, stats); }
  pay(c, id, stats) {
    c.money -= this.costFor(c, id, stats);
    if (id === 'vest') c.armor = 100;
    else if (id === 'vesthelm') { c.armor = 100; c.helmet = true; }
    else if (id === 'defuser') c.defuser = true;
  }
}
