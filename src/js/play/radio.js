// The radio: CS2's agent voice lines for the bots' chatter ("Enemy spotted", "Planting the bomb", "Flashbang out")
// and the radio menus you use to talk to your bot teammates (Z commands, X reports, V responses). Commands are
// orders your bots follow: go to a site, rush, follow you, hold, regroup, fall back, cover you. Only your own team's
// radio is heard, like in CS2; every call also shows in the chat with where it came from.
import { cs2Play } from '../cs2/api.js';

// Each team's two bot agents speak with their agent's voice (the models in bots.js: Phoenix and Elite Crew, SAS and SEAL).
const AGENT_VOICE = { T: ['phoenix', 'leet'], CT: ['sas', 'seal'] };

// [label, voice line, order]
export const RADIO = {
  KeyZ: { title: 'Commands', items: [
    ['Go A', 'letsgo', 'siteA'], ['Go B', 'letsgo', 'siteB'], ['Go go go!', 'letsgo', 'rush'], ['Follow me', 'followme', 'follow'],
    ['Hold this position', 'radiobothold', 'hold'], ['Regroup', 'radiobotregroup', 'regroup'], ['Fall back', 'radiobotfallback', 'fallback'],
    ['Cover me', 'coverme', 'cover']] },
  KeyX: { title: 'Reports', items: [
    ['Enemy spotted', 'enemyspotted', 'spotted'], ['Need backup', 'needbackup', 'cover'], ['Taking fire', 'takingfire', 'cover'],
    ['Sector clear', 'clearedarea', null], ["I'm in position", 'inposition', null], ['Bomb spotted', 'spottedloosebomb', 'spotted']] },
  KeyV: { title: 'Responses', items: [
    ['Affirmative', 'affirmative', null], ['Negative', 'negative', null], ['Thanks', 'thanks', null], ['Nice shot', 'niceshot', null],
    ['Enemy down', 'enemydown', null]] },
};
const ACK = [['affirmative', 'Affirmative'], ['agree', 'Roger that'], ['affirmative', 'On my way']];

export class Radio {
  constructor(game) {
    this.game = game;
    this.voices = {};
    this.last = new Map(); // combatant -> time of their last call
    this.lastAny = -9;
    this.menu = null;
    cs2Play('voices').then((v) => { this.voices = v || {}; }).catch(() => {});
  }

  agentOf(c) {
    const b = this.game.botOf(c);
    return AGENT_VOICE[c.team][b ? b.index % 2 : 0];
  }

  // A call in someone's voice. Your team's calls play over the radio and show in the chat; the other team's aren't heard.
  // Bots don't repeat themselves too often (force skips that, for answers and your own calls).
  say(c, line, text, { force = false } = {}) {
    const g = this.game, now = g.now;
    if (!c || c.team !== g.me.team || (!c.alive && c !== g.me)) return false;
    if (!force && (now - (this.last.get(c) ?? -99) < 5 || now - this.lastAny < 1.5)) return false;
    this.last.set(c, now);
    this.lastAny = now;
    const list = this.voices[this.agentOf(c)]?.[line];
    if (list?.length) {
      const ev = list[Math.floor(Math.random() * list.length)];
      g.sounds.load([ev]).then(() => { if (!g.disposed) g.sounds.play(ev, { volume: 0.5 }); });
    }
    if (text) g.hud.chat(c === g.me ? 'You' : c.name, g.placeOf(c), text, c.team);
    return true;
  }

  // Chatter by the bots about what they see and do.
  chatter(c, event, extra = {}) {
    const t = c.team === 'T' ? 't' : 'ct';
    const lines = {
      spotted: ['enemyspotted', extra.where ? `Enemy spotted ${extra.where}` : 'Enemy spotted'],
      kill: ['enemydown', 'Enemy down'], plant: ['plantingbomb', 'Planting the bomb'], defuse: ['defusingbomb', 'Defusing the bomb'],
      goingToPlant: [extra.site === 'B' ? 'goingtoplantbombb' : 'goingtoplantbomba', `Going to plant the bomb at ${extra.site || 'A'}`],
      flash: [t + 'flashbang', 'Flashbang out!'], smoke: [t + 'smoke', 'Smoke out!'], fire: [t + 'molotov', 'Fire in the hole!'],
      he: [t + 'grenade', 'HE out!'], hurt: ['takingfire', 'Taking fire, need assistance!'], ticking: ['bombtickingdown', 'The bomb is ticking down!'],
      roundStart: [Math.random() < 0.5 ? 'locknload' : 'letsgo', null], oneLeft: ['oneenemyleft', 'One enemy left'],
      twoLeft: ['twoenemiesleft', 'Two enemies left'], niceShot: ['niceshot', 'Nice shot!'], lastAlive: ['lastmanstanding', null],
    }[event];
    if (lines) this.say(c, lines[0], lines[1], { force: extra.force });
  }

  // ---- the radio menus ----------------------------------------------------------------------------------------------
  open(code) {
    if (!this.game.me.alive) return;
    this.menu = this.menu === RADIO[code] ? null : RADIO[code];
    this.game.hud.radio(this.menu);
  }
  close() { this.menu = null; this.game.hud.radio(null); }
  // Digit pressed while a menu is open: say it, and your bots act on commands.
  choose(i) {
    const item = this.menu?.items[i - 1];
    this.close();
    if (!item) return;
    const g = this.game;
    this.say(g.me, item[1], item[0], { force: true });
    if (item[2]) this.order(item[2]);
  }

  order(kind) {
    const g = this.game, me = g.me;
    const mates = g.bots.filter((b) => b.c.alive && b.c.team === me.team);
    if (!mates.length) return;
    const pos = g.player.origin.slice();
    let target = null;
    if (kind === 'spotted') {
      // Where you're looking: the first thing your crosshair hits.
      const eye = g.player.eye(), dir = g.viewDir(me);
      const hit = g.collision.raycast(eye, dir, 4000, 2);
      target = [0, 1, 2].map((k) => eye[k] + dir[k] * (hit ? hit.t - 8 : 1500));
    }
    if (kind === 'siteA' || kind === 'siteB') {
      const site = kind === 'siteA' ? 'A' : 'B';
      const plan = g.plans?.[me.team];
      if (plan) { if (me.team === 'T') { plan.site = site; plan.lurk = null; } else plan.rotate = site; }
    }
    if (kind === 'rush' && g.plans?.[me.team]) g.plans[me.team].rush = true;
    for (const b of mates) b.brain.obey(kind, { pos, target, t: g.now });
    // One of them answers.
    const who = mates[Math.floor(Math.random() * mates.length)].c;
    const [line, text] = ACK[Math.floor(Math.random() * ACK.length)];
    setTimeout(() => { if (!g.disposed) this.say(who, line, text, { force: true }); }, 700);
  }
}
