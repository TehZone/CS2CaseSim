// CS2's developer console (the ~ key): console commands and variables under CS2's names, typed with completion (Tab),
// history (up and down) and an output log. Cheat commands need sv_cheats 1, like in CS2. The match keeps running
// while it's open (as CS2 does offline); your keys go to the console instead of the game.
import { esc } from '../util.js';
import { MOVE } from './movement.js';
import { DIFFICULTY } from './ai.js';
import { ITEM_NAMES } from './match.js';

const MOVE_DEFAULTS = { ...MOVE };
const BOT_LEVELS = ['easy', 'normal', 'hard', 'expert'];
// cl_crosshaircolor 0-4 (5: cl_crosshaircolor_r/g/b).
const XHAIR_COLORS = ['#fa3232', '#32fa32', '#fafa32', '#3232fa', '#32fafa'];
const CHEAT_MSG = (name) => `Can't use cheat command ${name} in multiplayer, unless the server has sv_cheats set to 1.`;

// Every command and variable: { help, cheat, get?() (variables), set?(value), run?(args) }.
function commands(g, con) {
  const num = (v, lo = -Infinity, hi = Infinity) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };
  const rules = () => g.match?.rules || g.rules;
  // A console variable kept on the game (g.cv) or wherever get/set point.
  const cv = (name, help, def, { cheat = false, lo, hi, apply } = {}) => {
    g.cv[name] ??= def;
    return { help, cheat, get: () => g.cv[name], set: (v) => { const n = num(v, lo, hi); if (n == null) return false; g.cv[name] = n; apply?.(n); return true; } };
  };
  const rule = (key, help, scale = 1) => ({ help, get: () => +(rules()[key] / scale).toFixed(3), set: (v) => { const n = num(v, 0); if (n == null) return false; rules()[key] = n * scale; return true; } });
  const xhair = (key, help, from = (v) => v, to = (v) => v) => ({
    help, get: () => to(g.hud.xh[key]),
    set: (v) => { const n = num(v); if (n == null) return false; g.hud.setCrosshairStyle({ ...g.hud.xh, [key]: from(n) }); return true; },
  });
  const vm = (key, help) => ({
    help, get: () => g.vm[key],
    set: (v) => { const n = num(v, key === 'fov' ? 54 : -2.5, key === 'fov' ? 68 : 2.5); if (n == null) return false; g.vm[key] = n; if (key === 'fov') g.setViewmodelFov?.(n); return true; },
  });
  const me = () => g.me;
  return {
    // ---- console --------------------------------------------------------------------------------------------------
    help: { help: 'Lists the commands, or describes one: help <command>', run: ([n]) => {
      if (n) { const c = con.cmds[n]; con.print(c ? `${n}${c.get ? ` = ${c.get()}` : ''}${c.cheat ? ' (cheat)' : ''} - ${c.help}` : `Unknown command "${n}"`, c ? '' : 'err'); return; }
      con.print(Object.keys(con.cmds).sort().join('  '), 'dim');
      con.print('Type a command and its value (e.g. mp_roundtime 2). "find <text>" searches them.');
    } },
    find: { help: 'Finds commands and variables by name or description: find <text>', run: ([q = '']) => {
      const hits = Object.entries(con.cmds).filter(([n, c]) => n.includes(q.toLowerCase()) || c.help.toLowerCase().includes(q.toLowerCase()));
      if (!hits.length) con.print(`No commands found for "${q}"`, 'dim');
      for (const [n, c] of hits) con.print(`${n}${c.get ? ` = ${c.get()}` : ''} - ${c.help}`);
    } },
    cvarlist: { help: 'Lists the console variables and their values', run: () => { for (const [n, c] of Object.entries(con.cmds)) if (c.get) con.print(`${n} = ${c.get()}`); } },
    clear: { help: 'Clears the console', run: () => con.clear() },
    echo: { help: 'Prints text: echo <text>', run: (a) => con.print(a.join(' ')) },
    status: { help: 'Lists the players', run: () => {
      for (const c of g.combatants) con.print(`${c.team.padEnd(3)} ${c.name.padEnd(16)} ${c.alive ? String(Math.max(0, Math.round(c.health))).padStart(3) + ' hp' : ' dead '}  $${c.money}  ${c.kills} / ${c.deaths}`);
    } },
    // ---- the server -----------------------------------------------------------------------------------------------
    sv_cheats: { help: 'Allows cheat commands (1) or not (0)', get: () => g.cv.sv_cheats, set: (v) => {
      const n = num(v, 0, 1); if (n == null) return false;
      g.cv.sv_cheats = n ? 1 : 0;
      if (!n) { g.god = false; g.noclip = false; g.cv.host_timescale = 1; g.cv.sv_infinite_ammo = 0; g.cv.bot_stop = 0; g.cv.bot_dont_shoot = 0; Object.assign(MOVE, MOVE_DEFAULTS); }
      return true;
    } },
    host_timescale: cv('host_timescale', 'How fast the game runs (1 = real time)', 1, { cheat: true, lo: 0.1, hi: 10 }),
    sv_gravity: { help: 'Gravity (units/s²)', cheat: true, get: () => MOVE.gravity, set: (v) => { const n = num(v, 0, 5000); if (n == null) return false; MOVE.gravity = n; return true; } },
    sv_infinite_ammo: cv('sv_infinite_ammo', 'Infinite ammo: 1 = never reload, 2 = never run out of reserve', 0, { cheat: true, lo: 0, hi: 2 }),
    mp_restartgame: { help: 'Restarts the match after this many seconds: mp_restartgame <seconds>', run: ([s = '1']) => {
      const n = num(s, 0, 60) ?? 1; g.restartAt = g.now + n; con.print(`Restarting the match in ${n} second${n === 1 ? '' : 's'}`);
    } },
    mp_warmup_end: { help: 'Ends the warmup', run: () => con.print('There is no warmup in this match', 'dim') },
    mp_roundtime: rule('roundTime', 'Round time in minutes (from the next round)', 60),
    mp_roundtime_defuse: rule('roundTime', 'Round time in minutes on bomb maps (from the next round)', 60),
    mp_freezetime: rule('freeze', 'Freeze time in seconds (from the next round)'),
    mp_buytime: rule('buyTime', 'Buy time in seconds'),
    mp_c4timer: rule('bombTime', 'Seconds until the planted bomb explodes (from the next plant)'),
    mp_startmoney: rule('startMoney', 'Money at the start of each half'),
    mp_maxmoney: rule('maxMoney', 'The most money a player can have'),
    mp_buy_anywhere: cv('mp_buy_anywhere', 'Buy anywhere on the map (1) or only in your buy zone (0)', 0, { lo: 0, hi: 1 }),
    mp_friendlyfire: { help: 'Friendly fire (1) or not (0)', get: () => (g.ff ? 1 : 0), set: (v) => { const n = num(v, 0, 1); if (n == null) return false; g.ff = !!n && !g.ffa; return true; } },
    // ---- you ------------------------------------------------------------------------------------------------------
    god: { help: 'Toggles taking no damage', cheat: true, run: () => { g.god = !g.god; con.print(g.god ? 'godmode ON' : 'godmode OFF'); } },
    noclip: { help: 'Toggles flying through walls', cheat: true, run: () => { g.noclip = !g.noclip; if (!g.noclip) g.player.velocity = [0, 0, 0]; con.print(g.noclip ? 'noclip ON' : 'noclip OFF'); } },
    give: { help: 'Gives you an item: give weapon_ak47, give item_assaultsuit, give item_defuser...', cheat: true, run: ([id]) => {
      if (!id) { con.print('Usage: give <item>', 'err'); return; }
      if (!g.giveItem(id)) con.print(`Unknown item "${id}"`, 'err');
    } },
    impulse: { help: 'impulse 101: the most money you can have', cheat: true, run: ([n]) => { if (n === '101') { me().money = rules().maxMoney ?? 16000; g.buyMenu?.render(); } } },
    kill: { help: 'Kills you', run: () => { if (me().alive) g.kill(me(), null, { name: 'World' }, false); } },
    explode: { help: 'Kills you', run: () => { if (me().alive) g.kill(me(), null, { name: 'World' }, false); } },
    buy: { help: 'Buys an item if you can: buy weapon_ak47', run: ([id]) => { if (id) g.buy(id.startsWith('weapon_') || ITEM_NAMES[id] ? id : 'weapon_' + id); } },
    say: { help: 'Says something in the chat', run: (a) => g.hud.chat('You', g.placeOf?.(me()) || '', a.join(' '), me().team) },
    disconnect: { help: 'Leaves the match', run: () => g.root.querySelector('[data-leave]')?.click() },
    quit: { help: 'Leaves the match', run: () => g.root.querySelector('[data-leave]')?.click() },
    // ---- bots -----------------------------------------------------------------------------------------------------
    bot_stop: cv('bot_stop', 'Bots stand still and stop thinking (1)', 0, { cheat: true, lo: 0, hi: 1 }),
    bot_dont_shoot: cv('bot_dont_shoot', "Bots don't shoot (1)", 0, { cheat: true, lo: 0, hi: 1 }),
    bot_difficulty: { help: 'Bot difficulty: 0 easy, 1 normal, 2 hard, 3 expert', get: () => Math.max(0, BOT_LEVELS.indexOf(g.difficulty)), set: (v) => {
      const n = num(v, 0, 3); if (n == null) return false;
      g.difficulty = BOT_LEVELS[Math.round(n)];
      for (const b of g.bots) b.brain.d = DIFFICULTY[g.difficulty];
      return true;
    } },
    bot_kill: { help: 'Kills the bots: bot_kill [all | t | ct]', run: ([which = 'all']) => {
      for (const b of g.bots) if (b.c.alive && (which === 'all' || b.c.team === which.toUpperCase())) g.kill(b.c, null, { name: 'World' }, false);
    } },
    // ---- view and sound -------------------------------------------------------------------------------------------
    sensitivity: { help: 'Mouse sensitivity (CS2 units)', get: () => g.baseSensitivity, set: (v) => { const n = num(v, 0.05, 20); if (n == null) return false; g.setSensitivity(n); return true; } },
    volume: { help: 'Master volume (0-1)', get: () => +g.sounds.out.gain.value.toFixed(2), set: (v) => { const n = num(v, 0, 1); if (n == null) return false; g.sounds.out.gain.value = n; return true; } },
    snd_musicvolume: { help: 'Music volume (0-1)', get: () => g.musicVolume, set: (v) => { const n = num(v, 0, 1); if (n == null) return false; g.musicVolume = n; return true; } },
    fps_max: cv('fps_max', 'Frame rate cap (0 = none)', 0, { lo: 0, hi: 1000 }),
    cl_showfps: { help: 'Shows the frame rate (1) or not (0)', get: () => (g.settings.showFps === false ? 0 : 1), set: (v) => { const n = num(v, 0, 1); if (n == null) return false; g.settings.showFps = !!n; return true; } },
    cl_drawhud: { help: 'Shows the HUD (1) or not (0)', get: () => (g.hud.el.style.display === 'none' ? 0 : 1), set: (v) => { const n = num(v, 0, 1); if (n == null) return false; g.hud.el.style.display = n ? '' : 'none'; return true; } },
    r_drawviewmodel: cv('r_drawviewmodel', 'Draws your weapon (1) or not (0)', 1, { lo: 0, hi: 1 }),
    cl_inspect_rare: cv('cl_inspect_rare', "CS2's special inspects and draws: 0 now and then, 1 always, -1 never", 0, { lo: -1, hi: 1 }),
    viewmodel_fov: vm('fov', 'Weapon field of view (54-68)'),
    viewmodel_offset_x: vm('x', 'Weapon offset sideways (-2.5 to 2.5)'),
    viewmodel_offset_y: vm('y', 'Weapon offset forward (-2.5 to 2.5)'),
    viewmodel_offset_z: vm('z', 'Weapon offset up (-2.5 to 2.5)'),
    cl_crosshairstyle: xhair('style', 'Crosshair style: 2 or 3 classic (opens up as you move and shoot), 4 or 5 static', (n) => (n >= 4 ? 'static' : 'classic'), (s) => (s === 'static' ? 4 : 2)),
    cl_crosshaircolor: xhair('color', 'Crosshair colour: 0 red, 1 green, 2 yellow, 3 blue, 4 cyan', (n) => XHAIR_COLORS[Math.max(0, Math.min(4, Math.round(n)))], (c) => Math.max(0, XHAIR_COLORS.indexOf(c))),
    cl_crosshairsize: xhair('size', 'Crosshair line length', (n) => Math.max(0, n)),
    cl_crosshairgap: xhair('gap', 'Crosshair gap', (n) => n),
    cl_crosshairthickness: xhair('thickness', 'Crosshair line thickness', (n) => Math.max(0.5, n)),
    cl_crosshairdot: xhair('dot', 'Crosshair dot (1) or not (0)', (n) => !!n, (b) => (b ? 1 : 0)),
    cl_crosshair_drawoutline: xhair('outline', 'Crosshair outline (1) or not (0)', (n) => !!n, (b) => (b ? 1 : 0)),
  };
}

export class DevConsole {
  constructor(root, game) {
    this.game = game;
    this.history = [];
    this.hi = -1;
    this.el = document.createElement('div');
    this.el.className = 'dev-console hidden';
    this.el.innerHTML = `<div class="con-head"><b>Console</b><button type="button" class="con-x" data-con-close title="Close (~)">✕</button></div>
      <div class="con-log"></div>
      <div class="con-suggest hidden"></div>
      <form class="con-row"><input class="con-input" spellcheck="false" autocomplete="off" placeholder="Type a command (help, find, sv_cheats 1, give weapon_awp…)"><button class="con-go" type="submit">Submit</button></form>`;
    root.appendChild(this.el);
    this.log = this.el.querySelector('.con-log');
    this.input = this.el.querySelector('.con-input');
    this.suggest = this.el.querySelector('.con-suggest');
    game.cv ||= {};
    this.cmds = commands(game, this);
    this.el.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); this.submit(); });
    this.el.querySelector('[data-con-close]').addEventListener('click', () => game.toggleConsole(false));
    this.suggest.addEventListener('mousedown', (e) => { const s = e.target.closest('[data-s]'); if (s) { e.preventDefault(); this.input.value = s.dataset.s + ' '; this.input.focus(); this.update(); } });
    // The console's keys stay in the console (the game listens on the document).
    for (const type of ['keydown', 'keyup']) this.el.addEventListener(type, (e) => { e.stopPropagation(); if (type === 'keydown') this.key(e); });
    this.input.addEventListener('input', () => this.update());
    this.print('CS2 developer console. Type "help" for the commands, "find <text>" to search them.', 'dim');
  }

  get isOpen() { return !this.el.classList.contains('hidden'); }
  open() { this.el.classList.remove('hidden'); this.input.focus(); this.update(); }
  close() { this.el.classList.add('hidden'); this.input.blur(); this.suggest.classList.add('hidden'); }

  key(e) {
    if (e.code === 'Backquote' || e.code === 'Escape') { e.preventDefault(); this.game.toggleConsole(false); return; }
    if (e.code === 'Tab') { e.preventDefault(); const first = this.matches()[0]; if (first) { this.input.value = first + ' '; this.update(); } return; }
    if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
      e.preventDefault();
      if (!this.history.length) return;
      this.hi = Math.max(-1, Math.min(this.history.length - 1, this.hi + (e.code === 'ArrowUp' ? 1 : -1)));
      this.input.value = this.hi < 0 ? '' : this.history[this.hi];
      this.update();
    }
  }

  // Commands starting with what's typed (before the first space).
  matches() {
    const t = this.input.value.trimStart();
    if (!t || t.includes(' ')) return [];
    return Object.keys(this.cmds).filter((n) => n.startsWith(t.toLowerCase())).sort().slice(0, 10);
  }
  update() {
    const m = this.matches();
    this.suggest.classList.toggle('hidden', !m.length);
    this.suggest.innerHTML = m.map((n) => { const c = this.cmds[n]; return `<div data-s="${n}"><b>${esc(n)}</b>${c.get ? ` <span>${esc(String(c.get()))}</span>` : ''}${c.cheat ? ' <i>cheat</i>' : ''}</div>`; }).join('');
  }

  submit() {
    const line = this.input.value.trim();
    this.input.value = '';
    this.update();
    if (!line) return;
    this.history = [line, ...this.history.filter((h) => h !== line)].slice(0, 50);
    this.hi = -1;
    this.print('] ' + line, 'cmd');
    for (const part of line.split(';')) this.run(part.trim());
  }

  // Runs one command: "name", "name value" (variables) or "name args...".
  run(line) {
    if (!line) return;
    const [name, ...args] = line.split(/\s+/);
    const c = this.cmds[name.toLowerCase()];
    if (!c) { this.print(`Unknown command "${name}"`, 'err'); return; }
    if (c.cheat && !this.game.cv.sv_cheats) { this.print(CHEAT_MSG(name), 'err'); return; }
    if (c.run) { try { c.run(args); } catch (e) { this.print(String(e.message || e), 'err'); } return; }
    if (!args.length) { this.print(`${name} = ${c.get()}  - ${c.help}`); return; }
    if (!c.set(args[0])) this.print(`Bad value for ${name}: ${args[0]}`, 'err');
  }

  print(text, cls = '') {
    const row = document.createElement('div');
    if (cls) row.className = cls;
    row.textContent = text;
    this.log.appendChild(row);
    while (this.log.children.length > 400) this.log.firstChild.remove();
    this.log.scrollTop = this.log.scrollHeight;
  }
  clear() { this.log.innerHTML = ''; }

  dispose() { Object.assign(MOVE, MOVE_DEFAULTS); this.el.remove(); }
}
