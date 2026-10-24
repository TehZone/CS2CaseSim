// Weapons on the ground: dropped by dying players (their best gun) or by you (G). Walking over one picks it up when that
// slot is free; E swaps it for the gun in your hand. Bots pick them up too. Cleared when a round restarts.
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { FLAG_PLAYER } from './collision.js';
import { toGl } from './world.js';

export class Drops {
  constructor(game) {
    this.game = game;
    this.list = [];
    this.group = new THREE.Group();
    game.scene.add(this.group);
  }

  // gun: { id, clip, reserve } (a gun's state); pos: where it leaves the hand; vel: thrown velocity.
  drop(gun, pos, vel = [0, 0, 0], by = null) {
    const item = { id: gun.id, clip: gun.clip, reserve: gun.reserve, pos: pos.slice(), vel: vel.slice(), by, at: this.game.now, obj: new THREE.Group(), resting: false };
    item.obj.rotation.set(0, Math.random() * Math.PI * 2, Math.PI / 2, 'YXZ'); // lying on its side
    this.group.add(item.obj);
    this.game.botAssets.weapon(gun.id).then((tpl) => {
      if (!tpl || !item.obj.parent) return;
      const m = cloneSkinned(tpl);
      m.position.set(0, 0, 0); m.rotation.set(0, 0, 0); m.scale.set(1, 1, 1);
      m.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = true; } }); // (culled: it lies still in its bind pose)
      item.obj.add(m);
      if (item.resting) this.freeze(item);
    });
    toGl(item.pos, item.obj.position);
    this.list.push(item);
    return item;
  }

  // Lying still: its matrices (and its bones') worked out once, not every frame.
  freeze(it) {
    it.obj.updateMatrixWorld(true);
    it.obj.traverse((o) => { o.matrixAutoUpdate = false; });
  }

  tick(dt) {
    const g = this.game;
    for (const it of this.list) {
      if (it.resting) continue;
      it.vel[2] -= 800 * dt;
      const to = it.pos.map((p, i) => p + it.vel[i] * dt);
      const tr = g.collision.traceBox(it.pos, to, [-3, -3, -1], [3, 3, 3], FLAG_PLAYER);
      it.pos = tr.endpos;
      if (tr.normal) {
        if (tr.normal[2] > 0.7) { it.resting = true; it.vel = [0, 0, 0]; toGl(it.pos, it.obj.position); this.freeze(it); } else { const vn = it.vel[0] * tr.normal[0] + it.vel[1] * tr.normal[1] + it.vel[2] * tr.normal[2]; it.vel = it.vel.map((v, i) => (v - vn * tr.normal[i]) * 0.5); }
      }
      if (it.pos[2] < -4000) it.resting = true;
      toGl(it.pos, it.obj.position);
    }
  }

  // Items within reach of a position (game units), nearest first.
  near(pos, r = 48) {
    return this.list.filter((it) => Math.hypot(it.pos[0] - pos[0], it.pos[1] - pos[1]) < r && Math.abs(it.pos[2] - pos[2]) < 80)
      .sort((a, b) => Math.hypot(a.pos[0] - pos[0], a.pos[1] - pos[1]) - Math.hypot(b.pos[0] - pos[0], b.pos[1] - pos[1]));
  }
  // The item you're looking at within use range.
  lookedAt(eye, dir, r = 110) {
    let best = null, bd = Infinity;
    for (const it of this.list) {
      const d = [it.pos[0] - eye[0], it.pos[1] - eye[1], it.pos[2] + 2 - eye[2]];
      const l = Math.hypot(...d);
      if (l > r) continue;
      const cos = (d[0] * dir[0] + d[1] * dir[1] + d[2] * dir[2]) / l;
      if (cos > 0.9 && l < bd) { bd = l; best = it; }
    }
    return best;
  }

  take(it) {
    const i = this.list.indexOf(it);
    if (i < 0) return false;
    this.list.splice(i, 1);
    this.group.remove(it.obj);
    return true;
  }

  clear() { for (const it of this.list) this.group.remove(it.obj); this.list = []; }
  dispose() { this.clear(); this.group.removeFromParent(); }
}
