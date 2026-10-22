// Keyboard and mouse for Play mode, with CS2's default binds. Mouse look uses CS2's units (m_yaw = 0.022 degrees per
// count times sensitivity), so a CS2 sensitivity feels the same here.
export const BINDS = {
  forward: ['KeyW'], back: ['KeyS'], left: ['KeyA'], right: ['KeyD'], jump: ['Space'], duck: ['ControlLeft', 'ControlRight', 'KeyC'],
  walk: ['ShiftLeft', 'ShiftRight'], reload: ['KeyR'], inspect: ['KeyF'], slot1: ['Digit1'], slot2: ['Digit2'], slot3: ['Digit3'],
  lastWeapon: ['KeyQ'], scores: ['Tab'], use: ['KeyE'], drop: ['KeyG'], buy: ['KeyB'],
};
const GAME_KEYS = new Set(Object.values(BINDS).flat());

export class Input {
  constructor(el, { sensitivity = 1.25, onLockChange = () => {} } = {}) {
    this.el = el;
    this.sensitivity = sensitivity;
    this.keys = new Set();
    this.pressed = new Set(); // actions pressed since the last poll
    this.buttons = 0;
    this.clicked = 0; // mouse buttons pressed since the last poll (bit mask)
    this.yaw = 0; this.pitch = 0;
    this.wheel = 0;
    this.locked = false;
    this.onLockChange = onLockChange;
    this.handlers = [
      [document, 'keydown', (e) => this.key(e, true)],
      [document, 'keyup', (e) => this.key(e, false)],
      [document, 'mousemove', (e) => this.move(e)],
      [document, 'mousedown', (e) => { if (!this.locked) return; this.buttons |= 1 << e.button; this.clicked |= 1 << e.button; e.preventDefault(); }],
      [document, 'mouseup', (e) => { this.buttons &= ~(1 << e.button); }],
      [document, 'wheel', (e) => { if (this.locked) { this.wheel += Math.sign(e.deltaY); e.preventDefault(); } }, { passive: false }],
      [document, 'pointerlockchange', () => this.lockChanged()],
      [document, 'contextmenu', (e) => { if (this.locked) e.preventDefault(); }],
      [window, 'blur', () => { this.keys.clear(); this.buttons = 0; }],
    ];
    for (const [t, ev, fn, opt] of this.handlers) t.addEventListener(ev, fn, opt);
  }

  async lock() {
    try { await this.el.requestPointerLock({ unadjustedMovement: true }); } catch {
      try { await this.el.requestPointerLock(); } catch {}
    }
  }
  unlock() { if (document.pointerLockElement) document.exitPointerLock(); }

  lockChanged() {
    this.locked = document.pointerLockElement === this.el;
    if (!this.locked) { this.keys.clear(); this.buttons = 0; }
    this.onLockChange(this.locked);
  }

  key(e, down) {
    if (!this.locked) return;
    if (GAME_KEYS.has(e.code) || e.ctrlKey) e.preventDefault();
    if (down) {
      if (!this.keys.has(e.code)) for (const [a, codes] of Object.entries(BINDS)) if (codes.includes(e.code)) this.pressed.add(a);
      this.keys.add(e.code);
    } else this.keys.delete(e.code);
  }

  move(e) {
    if (!this.locked) return;
    const k = 0.022 * this.sensitivity;
    this.yaw -= e.movementX * k;
    this.pitch = Math.max(-89, Math.min(89, this.pitch + e.movementY * k));
  }

  held(action) { return BINDS[action].some((c) => this.keys.has(c)); }
  // Actions pressed since the last call (each reported once).
  takePressed() { const p = this.pressed; this.pressed = new Set(); return p; }
  takeClicked() { const c = this.clicked; this.clicked = 0; return c; }
  takeWheel() { const w = this.wheel; this.wheel = 0; return w; }

  dispose() {
    this.unlock();
    for (const [t, ev, fn, opt] of this.handlers) t.removeEventListener(ev, fn, opt);
  }
}
