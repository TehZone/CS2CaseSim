// Online matches: your teammates' names over their heads, as CS2 shows them (through walls too: you always know where your
// team is), fading with distance. A label per teammate, kept from frame to frame, moved each frame (net-host.js and
// net-client.js start it; game.frame's 'frame' event moves them).
import * as THREE from 'three';
import { toGl } from './world.js';

const _v = new THREE.Vector3();
const FAR = 3000, NEAR = 400; // (game units: fully shown nearer than NEAR, gone past FAR)

export class NameTags {
  constructor(game) {
    this.game = game;
    this.el = document.createElement('div');
    this.el.className = 'pvp-tags';
    game.screen.appendChild(this.el);
    this.tags = new Map(); // body -> { el, name }
    this.off = game.on((type) => { if (type === 'frame') this.update(); });
  }
  update() {
    const g = this.game, me = g.me, cam = g.camera, w = this.el.clientWidth, h = this.el.clientHeight;
    const seen = new Set();
    if (me && !g.matchOver && w && h) {
      const eye = g.camEye || [0, 0, 0];
      for (const b of g.bots) {
        const c = b.c;
        if (!c.alive || c.team !== me.team || b === g.specHidden || !b.root.visible) continue;
        const p = b.pos, d = Math.hypot(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]);
        if (d > FAR) continue;
        toGl([p[0], p[1], p[2] + (b.ducked ? 62 : 80)], _v);
        _v.project(cam);
        if (_v.z > 1 || _v.z < -1 || Math.abs(_v.x) > 1.1 || Math.abs(_v.y) > 1.1) continue;
        let t = this.tags.get(b);
        if (!t) { t = { el: document.createElement('div'), name: null }; t.el.className = 'pvp-tag'; this.el.appendChild(t.el); this.tags.set(b, t); }
        if (t.name !== c.name) { t.name = c.name; t.el.textContent = c.name; }
        t.el.classList.toggle('t', c.team === 'T');
        t.el.style.left = `${((_v.x + 1) / 2) * w}px`;
        t.el.style.top = `${((1 - _v.y) / 2) * h}px`;
        t.el.style.opacity = String(d < NEAR ? 1 : Math.max(0, 1 - (d - NEAR) / (FAR - NEAR)) * 0.9 + 0.1);
        t.el.hidden = false;
        seen.add(b);
      }
    }
    for (const [b, t] of this.tags) if (!seen.has(b)) t.el.hidden = true;
  }
  dispose() { this.off?.(); this.el.remove(); this.tags.clear(); }
}
