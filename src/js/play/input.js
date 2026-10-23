// Keyboard and mouse for Play mode, bound like CS2: a key (CS2's names: w, space, mouse1, mwheelup, kp_end...) runs a
// command (+jump, slot1, buymenu, say gg...). Commands with a + are held while the key is down; the rest run once per
// press, and any other console command goes to the console. A mouse wheel notch on a + command holds it for exactly
// one tick (press and release), like CS2's scroll jump, so "bind mwheeldown +jump" bunny hops. Mouse look uses CS2's
// units (m_yaw = 0.022 degrees per count times sensitivity), so a CS2 sensitivity feels the same here.

// CS2's default binds (and a few of this game's: c crouches, the right Ctrl and Shift too).
export const DEFAULT_BINDS = {
  w: '+forward', s: '+back', a: '+left', d: '+right', space: '+jump', ctrl: '+duck', rctrl: '+duck', c: '+duck', shift: '+sprint', rshift: '+sprint',
  r: '+reload', f: '+lookatweapon', 1: 'slot1', 2: 'slot2', 3: 'slot3', 4: 'slot4', 5: 'slot5', q: 'lastinv', tab: '+showscores', e: '+use',
  g: 'drop', b: 'buymenu', z: 'radio1', x: 'radio2', v: 'radio3', y: 'messagemode', u: 'messagemode2', '`': 'toggleconsole',
  mouse1: '+attack', mouse2: '+attack2', mouse3: 'player_ping', mwheelup: 'invprev', mwheeldown: 'invnext',
};
// What the game does for each command (its action). Anything else is run as a console command.
export const COMMANDS = {
  '+forward': 'forward', '+back': 'back', '+left': 'left', '+moveleft': 'left', '+right': 'right', '+moveright': 'right', '+jump': 'jump',
  '+duck': 'duck', '+sprint': 'walk', '+speed': 'walk', '+reload': 'reload', '+lookatweapon': 'inspect', '+use': 'use', '+showscores': 'scores',
  '+attack': 'attack', '+attack2': 'attack2', slot1: 'slot1', slot2: 'slot2', slot3: 'slot3', slot4: 'slot4', slot5: 'slot5', lastinv: 'lastWeapon',
  drop: 'drop', buymenu: 'buy', radio1: 'radio1', radio2: 'radio2', radio3: 'radio3', messagemode: 'chatAll', messagemode2: 'chatTeam',
  toggleconsole: 'console', invprev: 'invprev', invnext: 'invnext', player_ping: 'ping',
};
// The actions in the settings screen, with the command each one binds.
export const ACTIONS = [
  ['forward', 'Forward', '+forward'], ['back', 'Back', '+back'], ['left', 'Left', '+left'], ['right', 'Right', '+right'], ['jump', 'Jump', '+jump'],
  ['duck', 'Crouch', '+duck'], ['walk', 'Walk', '+sprint'], ['attack', 'Fire', '+attack'], ['attack2', 'Secondary fire / scope', '+attack2'],
  ['reload', 'Reload', '+reload'], ['inspect', 'Inspect', '+lookatweapon'], ['use', 'Use / defuse', '+use'], ['slot1', 'Primary', 'slot1'],
  ['slot2', 'Pistol', 'slot2'], ['slot3', 'Knife / Zeus', 'slot3'], ['slot4', 'Grenades', 'slot4'], ['slot5', 'Bomb', 'slot5'],
  ['lastWeapon', 'Last weapon', 'lastinv'], ['invprev', 'Previous weapon', 'invprev'], ['invnext', 'Next weapon', 'invnext'], ['drop', 'Drop weapon', 'drop'],
  ['buy', 'Buy menu', 'buymenu'], ['scores', 'Scoreboard', '+showscores'], ['radio1', 'Radio: commands', 'radio1'], ['radio2', 'Radio: reports', 'radio2'],
  ['radio3', 'Radio: responses', 'radio3'], ['chatAll', 'Chat (all)', 'messagemode'], ['chatTeam', 'Chat (team)', 'messagemode2'],
  ['ping', 'Ping', 'player_ping'], ['console', 'Console', 'toggleconsole'],
];

// Keyboard codes under CS2's key names (letters, digits and f1-f12 are just their names).
const CODE_NAMES = {
  Space: 'space', Tab: 'tab', Enter: 'enter', Escape: 'escape', Backspace: 'backspace', CapsLock: 'capslock', ShiftLeft: 'shift', ShiftRight: 'rshift',
  ControlLeft: 'ctrl', ControlRight: 'rctrl', AltLeft: 'alt', AltRight: 'ralt', ArrowUp: 'uparrow', ArrowDown: 'downarrow', ArrowLeft: 'leftarrow',
  ArrowRight: 'rightarrow', Insert: 'ins', Delete: 'del', Home: 'home', End: 'end', PageUp: 'pgup', PageDown: 'pgdn', Semicolon: 'semicolon',
  Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\', Comma: ',', Period: '.', Slash: '/', Minus: '-', Equal: '=', Backquote: '`',
  Pause: 'pause', Numpad0: 'kp_ins', Numpad1: 'kp_end', Numpad2: 'kp_downarrow', Numpad3: 'kp_pgdn', Numpad4: 'kp_leftarrow', Numpad5: 'kp_5',
  Numpad6: 'kp_rightarrow', Numpad7: 'kp_home', Numpad8: 'kp_uparrow', Numpad9: 'kp_pgup', NumpadDecimal: 'kp_del', NumpadDivide: 'kp_slash',
  NumpadMultiply: 'kp_multiply', NumpadSubtract: 'kp_minus', NumpadAdd: 'kp_plus', NumpadEnter: 'kp_enter',
};
export function keyName(code) {
  if (CODE_NAMES[code]) return CODE_NAMES[code];
  const m = /^Key([A-Z])$|^Digit(\d)$|^(F\d{1,2})$/.exec(code || '');
  return m ? (m[1] || m[2] || m[3]).toLowerCase() : null;
}
const KEY_NAMES = new Set([...Object.values(CODE_NAMES), ...'abcdefghijklmnopqrstuvwxyz0123456789'.split(''), ...Array.from({ length: 12 }, (_, i) => 'f' + (i + 1)),
  'mouse1', 'mouse2', 'mouse3', 'mouse4', 'mouse5', 'mwheelup', 'mwheeldown']);
export const isKeyName = (name) => KEY_NAMES.has(String(name).toLowerCase());
// A key's name for the settings screen.
export const keyLabel = (name) => ({ space: 'Space', ctrl: 'Ctrl', rctrl: 'Right Ctrl', shift: 'Shift', rshift: 'Right Shift', alt: 'Alt', ralt: 'Right Alt', tab: 'Tab',
  mouse1: 'Mouse 1', mouse2: 'Mouse 2', mouse3: 'Middle mouse', mouse4: 'Mouse 4', mouse5: 'Mouse 5', mwheelup: 'Wheel up', mwheeldown: 'Wheel down',
  '`': '~', escape: 'Esc', enter: 'Enter', backspace: 'Backspace', capslock: 'Caps Lock' }[name] || name.toUpperCase());

// The binds a match uses: your table (key -> command), else your older per-action keys over the defaults.
export function bindTable({ keybinds = null, binds = {} } = {}) {
  if (keybinds) return { ...keybinds };
  const t = { ...DEFAULT_BINDS };
  for (const [action, code] of Object.entries(binds || {})) {
    const cmd = ACTIONS.find(([a]) => a === action)?.[2], key = keyName(code);
    if (!cmd || !key) continue;
    for (const [k, c] of Object.entries(t)) if (COMMANDS[c] === action) delete t[k];
    t[key] = cmd;
  }
  return t;
}

export class Input {
  constructor(el, { sensitivity = 1.25, binds = DEFAULT_BINDS, onLockChange = () => {} } = {}) {
    this.el = el;
    this.sensitivity = sensitivity;
    this.keys = new Set(); // CS2 names of the keys and mouse buttons held down
    this.pressed = new Set(); // actions pressed since the last poll
    this.pulses = new Set(); // actions a wheel notch holds until the end of the tick
    this.buttons = 0; // +attack (1) and +attack2 (4) held, as mouse buttons
    this.clicked = 0; // and pressed since the last poll
    this.yaw = 0; this.pitch = 0;
    this.wheel = 0; // invprev / invnext notches since the last poll
    this.locked = false;
    this.menu = false; // a menu (buy menu) shows the cursor: keys still move you
    this.onKey = null; // (code, down) for menus
    this.onCommand = null; // (action or console command) for commands the game runs itself
    this.onLockChange = onLockChange;
    this.setBinds(binds);
    const mouse = (b) => ['mouse1', 'mouse3', 'mouse2', 'mouse4', 'mouse5'][b];
    this.handlers = [
      [document, 'keydown', (e) => this.key(e, true)],
      [document, 'keyup', (e) => this.key(e, false)],
      [document, 'mousemove', (e) => this.move(e)],
      [document, 'mousedown', (e) => { if (!this.locked) return; e.preventDefault(); this.down(mouse(e.button)); }],
      [document, 'mouseup', (e) => this.up(mouse(e.button))],
      [document, 'wheel', (e) => { if (this.locked && e.deltaY) { e.preventDefault(); this.notch(e.deltaY < 0 ? 'mwheelup' : 'mwheeldown'); } }, { passive: false }],
      [document, 'pointerlockchange', () => this.lockChanged()],
      [document, 'contextmenu', (e) => { if (this.locked) e.preventDefault(); }],
      [window, 'blur', () => this.releaseAll()],
    ];
    for (const [t, ev, fn, opt] of this.handlers) t.addEventListener(ev, fn, opt);
  }

  // Binds: { key: command }.
  setBinds(table) {
    this.binds = { ...table };
    this.actionKeys = {}; // action -> keys bound to it
    for (const [k, c] of Object.entries(this.binds)) { const a = COMMANDS[c]; if (a) (this.actionKeys[a] ||= []).push(k); }
  }
  actionOf(key) { return COMMANDS[this.binds[key]] ?? null; }

  async lock() {
    try { await this.el.requestPointerLock({ unadjustedMovement: true }); } catch {
      try { await this.el.requestPointerLock(); } catch {}
    }
  }
  unlock() { if (document.pointerLockElement) document.exitPointerLock(); }

  lockChanged() {
    this.locked = document.pointerLockElement === this.el;
    if (!this.locked && !this.menu) this.releaseAll();
    this.onLockChange(this.locked);
  }
  releaseAll() { this.keys.clear(); this.buttons = 0; }

  key(e, down) {
    if (!this.locked && !this.menu) return;
    if (this.onKey?.(e.code, down, e)) { e.preventDefault(); return; }
    const name = keyName(e.code);
    if ((name && this.binds[name]) || e.ctrlKey) e.preventDefault();
    if (!name) return;
    if (down) { if (!this.keys.has(name)) this.down(name); } else this.up(name);
  }

  // A key or mouse button goes down / up: + commands hold their action, the rest run once.
  down(name) {
    if (!name) return;
    this.keys.add(name);
    const cmd = this.binds[name];
    if (!cmd) return;
    const a = COMMANDS[cmd];
    if (a === 'attack') { this.buttons |= 1; this.clicked |= 1; } else if (a === 'attack2') { this.buttons |= 4; this.clicked |= 4; }
    this.run(cmd, a);
  }
  up(name) {
    if (!name || !this.keys.delete(name)) return;
    const a = this.actionOf(name);
    if ((a === 'attack' || a === 'attack2') && !this.held(a)) this.buttons &= a === 'attack' ? ~1 : ~4;
  }
  // A wheel notch: + commands for one tick (see endTick), the rest once.
  notch(name) {
    const cmd = this.binds[name];
    if (!cmd) return;
    const a = COMMANDS[cmd];
    if (cmd.startsWith('+') && a) {
      this.pulses.add(a);
      if (a === 'attack') { this.buttons |= 1; this.clicked |= 1; } else if (a === 'attack2') { this.buttons |= 4; this.clicked |= 4; }
    }
    this.run(cmd, a);
  }
  run(cmd, a) {
    if (a === 'invprev' || a === 'invnext') this.wheel += a === 'invnext' ? 1 : -1;
    else if (a === 'ping') this.pinged = true;
    else if (a === 'console' || a === 'buy' || a === 'chatAll' || a === 'chatTeam' || /^radio\d$/.test(a || '')) this.onCommand?.(a);
    else if (a) this.pressed.add(a);
    else this.onCommand?.(cmd); // a console command
  }
  // After each game tick: a wheel notch's + command lets go.
  endTick() {
    if (!this.pulses.size) return;
    if (this.pulses.has('attack') && !this.held('attack', true)) this.buttons &= ~1;
    if (this.pulses.has('attack2') && !this.held('attack2', true)) this.buttons &= ~4;
    this.pulses.clear();
  }

  move(e) {
    if (!this.locked) return;
    const k = 0.022 * this.sensitivity;
    this.yaw -= e.movementX * k;
    this.pitch = Math.max(-89, Math.min(89, this.pitch + e.movementY * k));
  }

  // A wheel notch pressed this action this tick (a fresh press even while it was down the tick before).
  notched(action) { return this.pulses.has(action); }
  held(action, keysOnly = false) { return (!keysOnly && this.pulses.has(action)) || !!this.actionKeys[action]?.some((k) => this.keys.has(k)); }
  // Whether a keyboard key (its code) is bound to an action (for menus that listen to raw keys).
  is(action, code) { return this.actionOf(keyName(code)) === action; }
  // Actions pressed since the last call (each reported once).
  takePressed() { const p = this.pressed; this.pressed = new Set(); return p; }
  takeClicked() { const c = this.clicked; this.clicked = 0; return c; }
  takeWheel() { const w = this.wheel; this.wheel = 0; return w; }
  takePing() { const p = this.pinged; this.pinged = false; return p; }

  dispose() {
    this.unlock();
    for (const [t, ev, fn, opt] of this.handlers) t.removeEventListener(ev, fn, opt);
  }
}
