// Bots: CS2 agent models animated with CS2's third-person clips, holding a CS2 weapon, with hitboxes on their bones
// (head, chest, stomach, arms, legs) for CS2's damage rules. In this first version they stand still; they die with
// CS2's death animations and come back somewhere else a few seconds later.
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { cs2Play } from '../cs2/api.js';
import { loadGltf } from '../cs2/rig.js';
import { buildCS2Model } from '../cs2/skin.js';
import { toGl, fromGl, IN, ambientLit } from './world.js';

export const AGENTS = {
  T: ['agents/models/tm_phoenix/tm_phoenix.vmdl', 'agents/models/tm_leet/tm_leet_variantb.vmdl'],
  CT: ['agents/models/ctm_sas/ctm_sas.vmdl', 'agents/models/ctm_st6/ctm_st6_variante.vmdl'],
};
const ANIMS = {
  idle: 'rifle/_default_rifle/idle_rifle',
  hold: 'rifle/rifle_ak/idle_ak.vnmclip+non_additive',
  deaths: ['shared/death_chest_a', 'shared/death_chest_b', 'shared/death_gut_a', 'shared/death_gut_b', 'shared/death_rknee_a', 'shared/death_rshoulder'],
  headshot: ['shared/death_chest_a', 'shared/death_chest_b'],
};
// Hitbox capsules between bones (radius in game units) and the hit group they count as.
const HITBOXES = [
  { a: 'head_0', b: 'head_0', ext: 6.5, r: 4.6, group: 'head' },
  { a: 'neck_0', b: 'head_0', r: 3.6, group: 'chest' },
  { a: 'spine_2', b: 'neck_0', r: 6.8, group: 'chest' },
  { a: 'spine_0', b: 'spine_2', r: 6.6, group: 'stomach' },
  { a: 'pelvis', b: 'spine_0', r: 6.6, group: 'stomach' },
  { a: 'arm_upper_L', b: 'arm_lower_L', r: 3.2, group: 'arm' }, { a: 'arm_lower_L', b: 'hand_L', r: 2.6, group: 'arm' },
  { a: 'arm_upper_R', b: 'arm_lower_R', r: 3.2, group: 'arm' }, { a: 'arm_lower_R', b: 'hand_R', r: 2.6, group: 'arm' },
  { a: 'leg_upper_L', b: 'leg_lower_L', r: 4.6, group: 'leg' }, { a: 'leg_lower_L', b: 'ankle_L', r: 3.6, group: 'leg' },
  { a: 'leg_upper_R', b: 'leg_lower_R', r: 4.6, group: 'leg' }, { a: 'leg_lower_R', b: 'ankle_R', r: 3.6, group: 'leg' },
];
const NAMES = ['Ace', 'Blaze', 'Cobra', 'Dash', 'Echo', 'Falcon', 'Ghost', 'Havoc', 'Ice', 'Jinx', 'Kilo', 'Lynx', 'Maverick', 'Nova', 'Onyx', 'Phantom', 'Quake', 'Raven', 'Shadow', 'Titan'];

// Shared assets for all bots: agent models per team, clips, a default weapon.
export async function loadBotAssets(renderer, ambient, { teams = ['T'], weapon = 'weapon_ak47' } = {}) {
  const models = {};
  for (const team of teams) {
    models[team] = [];
    for (const vmdl of AGENTS[team]) {
      try {
        const { model } = await cs2Play('agent', vmdl);
        models[team].push(await loadGltf(model));
      } catch (e) { console.warn('agent model failed', vmdl, e); }
    }
  }
  const animList = [ANIMS.idle, ANIMS.hold, ...ANIMS.deaths];
  const urls = await cs2Play('anims', animList);
  const clips = {};
  await Promise.all(animList.map(async (p) => { if (urls[p]) clips[p] = (await loadGltf(urls[p])).animations[0]; }));
  // The rifle idle for the body, with the AK's own hold pose on the arms and the weapon bone.
  const ARMS = /(clavicle|arm_|hand_|finger_|wpn)/;
  const idle = clips[ANIMS.idle], hold = clips[ANIMS.hold];
  if (idle && hold) {
    clips.body = new THREE.AnimationClip('body', idle.duration, idle.tracks.filter((t) => !ARMS.test(t.name)));
    clips.arms = new THREE.AnimationClip('arms', hold.duration, hold.tracks.filter((t) => ARMS.test(t.name)));
  } else clips.body = idle || hold;
  let gun = null;
  try {
    const def = { wid: weapon, w: 'AK-47', n: 'AK-47', cat: 'rifle', v: true };
    gun = await buildCS2Model({ t: 'skin', fl: 0, sd: 0 }, def, renderer);
  } catch (e) { console.warn('bot weapon failed', e); }
  // Agents are lit like the map's props: ambient plus the shadow-mapped sun.
  const lit = new Set();
  for (const list of Object.values(models)) for (const g of list) g.scene.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of [].concat(o.material)) if (!lit.has(m)) { lit.add(m); m.envMap = null; ambientLit(m, ambient); if (m.transparent && m.map) { m.alphaTest = 0.4; m.transparent = false; } }
  });
  gun?.userData.root.traverse((o) => { if (o.isMesh) for (const m of [].concat(o.material)) if (!lit.has(m)) { lit.add(m); ambientLit(m, ambient); } });
  return { models, clips, gun };
}

export class Bot {
  constructor(assets, team, index) {
    this.team = team;
    this.name = 'BOT ' + NAMES[index % NAMES.length];
    const list = assets.models[team];
    const src = list[index % list.length];
    this.root = new THREE.Group();
    this.model = cloneSkinned(src.scene);
    this.model.traverse((o) => {
      if (o.isMesh) {
        o.frustumCulled = false;
        o.castShadow = true;
        o.receiveShadow = true;
        if (/firstperson/.test(o.name) || /firstperson/.test(o.parent?.name || '')) o.visible = false;
      }
    });
    this.root.add(this.model);
    this.bones = {};
    this.model.traverse((o) => { if (o.isBone && !this.bones[o.name]) this.bones[o.name] = o; });
    this.mixer = new THREE.AnimationMixer(this.model);
    this.assets = assets;
    // The held weapon follows the agent's weapon bone (CS2 bone-merges the weapon's "weapon" bone onto "wpn").
    if (assets.gun && this.bones.wpn) {
      const w = cloneSkinned(assets.gun.userData.root);
      let wb = null;
      w.traverse((o) => { if (!wb && o.isBone && o.name === 'weapon') wb = o; });
      w.traverse((o) => { if (o.isMesh) { o.frustumCulled = false; o.castShadow = true; o.receiveShadow = true; } });
      w.updateMatrixWorld(true);
      if (wb) {
        const holder = new THREE.Group();
        holder.matrixAutoUpdate = false;
        holder.matrix.copy(wb.matrixWorld).invert();
        holder.add(w);
        this.bones.wpn.add(holder);
      } else this.bones.wpn.add(w);
      this.weapon = w;
    }
    this.health = 100; this.armor = 100; this.helmet = true;
    this.alive = true;
    this.pos = [0, 0, 0];
    this.yaw = 0;
    this.respawnAt = 0;
  }

  idle() {
    this.mixer.stopAllAction();
    const { clips } = this.assets;
    for (const c of [clips.body, clips.arms]) {
      if (!c) continue;
      const a = this.mixer.clipAction(c);
      a.setLoop(THREE.LoopRepeat, Infinity);
      a.time = Math.random() * c.duration;
      a.play();
    }
  }

  place(origin, yaw) {
    this.pos = origin.slice();
    this.yaw = yaw;
    toGl(origin, this.root.position);
    this.root.rotation.set(0, (yaw * Math.PI) / 180, 0);
    this.health = 100; this.armor = 100; this.helmet = true; this.alive = true;
    this.root.visible = true;
    this.idle();
    this.mixer.update(0);
    this.root.updateMatrixWorld(true);
  }

  die(headshot) {
    this.alive = false;
    this.mixer.stopAllAction();
    const list = headshot ? ANIMS.headshot : ANIMS.deaths;
    const clip = this.assets.clips[list[Math.floor(Math.random() * list.length)]];
    if (clip) {
      const a = this.mixer.clipAction(clip);
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
      a.play();
    }
  }

  update(dt) { this.mixer.update(dt); }

  // Bone position in game units.
  bonePos(name, out = new THREE.Vector3()) {
    const b = this.bones[name];
    if (!b) return null;
    b.getWorldPosition(out);
    return fromGl(out);
  }

  // Ray (game units) against this bot's hitboxes: { t, group } of the nearest hit, or null.
  raycast(o, d, maxT) {
    if (!this.alive) return null;
    // Quick reject with a bounding cylinder around the bot.
    const cx = this.pos[0] - o[0], cy = this.pos[1] - o[1];
    const along = cx * d[0] + cy * d[1];
    const px = cx - d[0] * along, py = cy - d[1] * along;
    if (px * px + py * py > 60 * 60 && Math.hypot(cx, cy) > 60) return null;
    this.root.updateMatrixWorld(true);
    let best = null;
    const v = new THREE.Vector3();
    for (const h of HITBOXES) {
      const a = this.bonePos(h.a, v);
      if (!a) continue;
      let b = this.bonePos(h.b, v) || a;
      if (h.ext) {
        // the head: from the base of the skull up along the neck->head direction
        const n = this.bonePos('neck_0', v) || a;
        const dir = [a[0] - n[0], a[1] - n[1], a[2] - n[2]];
        const l = Math.hypot(...dir) || 1;
        b = [a[0] + (dir[0] / l) * h.ext, a[1] + (dir[1] / l) * h.ext, a[2] + (dir[2] / l) * h.ext];
      }
      const t = rayCapsule(o, d, a, b, h.r);
      if (t !== null && t >= 0 && t < maxT && (!best || t < best.t)) best = { t, group: h.group };
    }
    return best;
  }

  dispose() { this.mixer.stopAllAction(); this.root.removeFromParent(); }
}

// Distance along a ray (o + d t, d unit length) to a capsule (segment a-b, radius r), or null.
function rayCapsule(o, d, a, b, r) {
  const ba = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], oa = [o[0] - a[0], o[1] - a[1], o[2] - a[2]];
  const dot = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  const baba = dot(ba, ba), bard = dot(ba, d), baoa = dot(ba, oa), rdoa = dot(d, oa), oaoa = dot(oa, oa);
  const A = baba - bard * bard, B = baba * rdoa - baoa * bard, C = baba * oaoa - baoa * baoa - r * r * baba;
  if (A > 1e-9) {
    const h = B * B - A * C;
    if (h >= 0) {
      const t = (-B - Math.sqrt(h)) / A;
      const y = baoa + t * bard;
      if (y > 0 && y < baba) return t;
    }
  }
  // caps
  for (const c of [a, b]) {
    const oc = [o[0] - c[0], o[1] - c[1], o[2] - c[2]];
    const bb = dot(d, oc), cc = dot(oc, oc) - r * r, h = bb * bb - cc;
    if (h >= 0) { const t = -bb - Math.sqrt(h); if (t >= 0) return t; }
  }
  return null;
}

export { IN };
