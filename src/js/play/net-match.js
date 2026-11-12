// Online PvP: what the host's game (net-host.js) and everyone else's (net-client.js) share about a match: which body is which
// slot (the server's slots: squad A's, then B's; a game's own squad is always its 'A', as game.js has it), whose look a gun
// has, the clock that ticks the match, the scoreboard's real players, chat through the server, and the end screen.
import { modeOf, squadOfSlot, slotsOf, otherSquad, NET } from '../engine/pvp.js';
import { itemDef } from '../items.js';
import { LOCAL } from './drops.js';
import { esc } from '../util.js';

export const TICK = NET.TICK;

// The match's slots on this game's bodies: game.me is ours; game.bots are our squad's other slots in order, then the other
// squad's (the order game.load makes them in: roster A, then B). → { mine, mySquad, other, bySlot: Map(slot -> { slot, c, b,
// info }), ofC: Map(combatant -> slot), local(serverSquad) → 'A' | 'B', server(localSquad) }
export function mapSlots(game, info) {
  const mode = info.mode, mine = info.slot, mySquad = squadOfSlot(mode, mine), other = otherSquad(mySquad);
  const order = [...slotsOf(mode, mySquad).filter((s) => s !== mine), ...slotsOf(mode, other)];
  const bySlot = new Map(), ofC = new Map(), infoOf = new Map((info.slots || []).map((s) => [s.slot, s]));
  const put = (slot, c, b) => { const x = { slot, c, b, info: infoOf.get(slot) || null }; bySlot.set(slot, x); ofC.set(c, slot); c.netSlot = slot; return x; };
  put(mine, game.me, null);
  order.forEach((slot, i) => { const b = game.bots[i]; if (b) put(slot, b.c, b); });
  for (const x of bySlot.values()) {
    const s = x.info;
    if (s?.kind === 'human') {
      x.c.bot = false; x.c.userId = s.userId; x.c.pic = s.pic || null; x.c.badge = s.badge || null; x.c.group = s.group ?? 0;
      if (x.c !== game.me) x.c.name = s.name || x.c.name;
      // (Not the bot their body was made as: their own profile picture where the HUD shows one, else none.)
      x.c.identity = s.pic && info.picUrl ? { id: null, name: x.c.name, avatar: info.picUrl(s.pic) || null } : null;
      if (x.b) x.b.human = true;
    } else if (s) { x.c.group = s.group ?? 0; if (s.skill != null) x.c.skill = s.skill; }
  }
  return {
    mine, mySquad, other, bySlot, ofC, mode, M: modeOf(mode),
    local: (sq) => (sq === mySquad ? 'A' : 'B'), server: (sq) => (sq === 'A' ? mySquad : other),
    at: (slot) => bySlot.get(slot) || null, cOf: (slot) => bySlot.get(slot)?.c || null,
  };
}

// A gun's look (drops.js gunSkin: { owner, item }) as a slot: whose loadout it's from (LOCAL: this game's own player).
export const skinSlot = (skin, mine) => (!skin ? 255 : skin.owner === LOCAL ? mine : /^slot:(\d+)$/.test(skin.owner) ? Number(skin.owner.slice(5)) : 255);
// And back: the look a slot's player has for this weapon (their loadout, from the server), or your own.
export function skinOf(slot, wid, slots, mine, own) {
  if (slot === 255 || slot == null) return null;
  if (slot === mine) return own(wid);
  const look = slots?.find((s) => s.slot === slot)?.look;
  const item = /knife|bayonet/.test(wid || '') ? look?.knife : look?.guns?.[wid];
  return item ? { owner: 'slot:' + slot, item } : null;
}
// The weapon id of someone's equipped knife (its model), or null for the default.
export function knifeWid(item) {
  const d = item && itemDef(item);
  return d?.wid?.startsWith?.('weapon_') ? d.wid : null;
}

// The match's clock: the game ticks by it (game.frame asks it: game.clock), driven by a timer as well as by the frames so a
// host whose window is hidden keeps the match going (main.js stops throttling it while it hosts). rate: the client's nudge.
export class MatchClock {
  constructor(game, { onRun = null, timer = true } = {}) {
    this.game = game; this.onRun = onRun; this.rate = 1; this.paused = false; this.last = performance.now(); this.ticks = 0;
    if (timer) { this.timer = setInterval(() => this.run(false), 4); }
  }
  // → ticks run. frame: called by the frame (net-client draws its bodies then). A tick that throws is logged and counted as
  // run all the same: retried, it would throw again every time, and the whole match would stop for everyone with it.
  run(frame = true) {
    if (this.busy || this.game.disposed) return 0;
    this.busy = true;
    let n = 0;
    try {
      const now = performance.now(), g = this.game;
      const dt = Math.min(0.25, Math.max(0, now - this.last) / 1000);
      this.last = now;
      if (!this.paused) {
        g.acc += dt * this.rate;
        while (g.acc >= TICK && n < 16) {
          try { g.tick(); } catch (e) { this.failed(e); }
          g.acc -= TICK; n++;
        }
        if (n >= 16) g.acc = Math.min(g.acc, TICK);
        this.ticks += n;
      }
      this.onRun?.(n, frame);
    } finally { this.busy = false; }
    return n;
  }
  // (At most one a second in the console, with how many since.)
  failed(e) {
    this.errors = (this.errors || 0) + 1;
    const t = performance.now();
    if (t - (this.errorAt || -1e9) < 1000) return;
    this.errorAt = t;
    console.error(`[pvp] a match tick failed (${this.errors} so far)`, e);
  }
  pause(on) { this.paused = !!on; this.last = performance.now(); }
  stop() { clearInterval(this.timer); this.timer = null; }
}

// The scoreboard's rows with the real players: their profile picture, and a note under the name (the ping, HOST, BOT, or
// BOT for a player a bot is playing for); humans' rank emblems are theirs.
export function playersOnBoard(game, slots, { picUrl, ping, bot }) {
  const d = Object.getPrototypeOf(game).scoreData.call(game);
  d.players.forEach((p, i) => {
    const c = game.combatants[i], slot = slots.ofC.get(c), s = slots.at(slot);
    if (!c || slot == null) return;
    if (c.bot === false) {
      if (c.pic && picUrl) p.avatar = picUrl(c.pic) || p.avatar;
      p.rank = c.group || 0;
      const b = bot(slot);
      p.org = b ? 'BOT plays for them' : ping(slot);
      if (b) p.name = `BOT for ${c.name}`;
    } else { p.org = 'BOT'; if (s?.info?.group != null) p.rank = c.group || p.rank; }
  });
  return d;
}

// Chat (Y all, U team) through the server: what's sent comes back like anyone's (the server filters it and stamps the name).
export function serverChat(game, send) {
  game.openChat = function (teamOnly) {
    this.input.keys.clear(); this.input.buttons = 0;
    this.chatOpen = true;
    this.hud.chatInput(!!teamOnly, (text) => {
      this.chatOpen = false;
      this.hud.chatInput(null);
      if (text != null && text.trim()) send({ t: 'chat', text: text.trim().slice(0, 127), team: !!teamOnly });
    });
  };
}

// Is someone defusing distance from the bomb and looking at it (game.js useKey)?
export function atBomb(eye, fwd, bombPos) {
  if (!bombPos) return false;
  const d = Math.hypot(bombPos[0] - eye[0], bombPos[1] - eye[1], bombPos[2] - eye[2]);
  return d < 90 && (fwd[0] * (bombPos[0] - eye[0]) + fwd[1] * (bombPos[1] - eye[1]) + fwd[2] * (bombPos[2] - eye[2])) / d > 0.75;
}

// The end of the match on screen (both roles): the result, then the reward once the server has paid it (pvp.js fills
// [data-reward] from pvp.paid / pvp.over).
export function endScreen(game, { won, draw, score }) {
  game.matchOver = true;
  game.hud.winPanel(null);
  game.sounds?.channel('music', 'Music.MatchEnd.valve_cs2_01', { volume: 0.4 * (game.musicVolume ?? 1) }, 0.8);
  const me = game.me, rounds = Math.max(1, game.match?.round || 1);
  const stats = [`${me.kills} / ${me.deaths} / ${me.assists} K/D/A`, `${Math.round((me.damage || 0) / rounds)} ADR`, `${me.mvps || 0} MVPs`].join(' · ');
  game.hud.endScreen(`<h1 class="${draw ? '' : won ? 'win' : 'loss'}">${draw ? 'Draw' : won ? 'Victory' : 'Defeat'}</h1>
    <div class="final">${score.you} : ${score.them}</div><div class="sub">${esc(stats)}</div><div class="reward" data-reward>Reward: verifying the match…</div>`);
  game.hud.scoreboard(true, game.scoreData());
  game.input.unlock();
  game.emit('over', { won, draw });
}
