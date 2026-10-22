// Bots' bodies: CS2 agent models animated with CS2's third-person clips (idle, walk, run and crouch in every direction,
// blended by how the bot moves; each weapon's own hold pose on the arms; the weapon's draw and reload, pulling a
// grenade's pin and throwing it, flinching when hit, covering their eyes when flashed; in the air, climbing ladders,
// planting, defusing and death), holding CS2's weapon models, with hitboxes on their bones (head, chest, stomach,
// arms, legs) for CS2's damage rules.
// The bot's brain (where to go, who to shoot) is in ai.js.
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { cs2Play } from '../cs2/api.js';
import { loadGltf } from '../cs2/rig.js';
import { buildCS2Model } from '../cs2/skin.js';
import { toGl, fromGl, ambientLit } from './world.js';

export const AGENTS = {
  T: ['agents/models/tm_phoenix/tm_phoenix.vmdl', 'agents/models/tm_leet/tm_leet_variantb.vmdl'],
  CT: ['agents/models/ctm_sas/ctm_sas.vmdl', 'agents/models/ctm_st6/ctm_st6_variante.vmdl'],
};
// CS2's bot names.
export const BOT_NAMES = ['Albert', 'Allen', 'Bert', 'Bob', 'Cecil', 'Clarence', 'Elliot', 'Elmer', 'Ernie', 'Eugene', 'Fergus', 'Ferris', 'Frank',
  'Frasier', 'Fred', 'George', 'Graham', 'Harvey', 'Irwin', 'Larry', 'Lester', 'Marvin', 'Neil', 'Niles', 'Oliver', 'Opie', 'Quinn', 'Ringo',
  'Rock', 'Shark', 'Ulric', 'Vitaliy', 'Wolf', 'Yanni', 'Zach'];

const SETS = ['rifle', 'pistol', 'knife'];
const GAITS = ['run', 'walk', 'crouch'];
const DIRS = ['n', 'e', 's', 'w'];
const locoPath = (set, gait, dir) => `${set}/_default_${set}/${gait}_${dir}_${set}`;
const DEATHS = ['shared/death_chest_a', 'shared/death_chest_b', 'shared/death_gut_a', 'shared/death_gut_b', 'shared/death_rknee_a', 'shared/death_rshoulder'];
const PLANT = 'equipment/c4/planting', DEFUSE = 'shared/defuse/defuse_crouch_loop_rifle';
const ARMS = /(clavicle|arm_|hand_|finger_|wpn)/;
const UPPER = /(spine_[123]|neck|head|clavicle|arm_|hand_|finger_|wpn)/;
// Gestures over the hold pose (arms, or the upper body), shared by every weapon class.
const SHARED = {
  pullpin: 'grenade/_default_grenade/pullpin_grenade', throw: 'grenade/_default_grenade/throw_overhand_grenade',
  lob: 'grenade/_default_grenade/throw_underhand_grenade', flashed: 'shared/flashed',
  flinchHead: 'shared/flinch_head.vnmclip+non_additive', flinchChest: 'shared/flinch_chest.vnmclip+non_additive',
  flinchStomach: 'shared/flinch_stomach.vnmclip+non_additive',
};
const GRENADE_RE = /^weapon_(hegrenade|flashbang|smokegrenade|molotov|incgrenade|decoy)$/;
// Each weapon's third-person hold pose (arms), where its folder or clip name doesn't follow the weapon id.
const HOLD = {
  weapon_ak47: 'rifle/rifle_ak/idle_ak', weapon_m4a1: 'rifle/rifle_m4a4/idle_m4a4', weapon_m4a1_silencer: 'rifle/rifle_m4a1_silencer/idle_m4a1s',
  weapon_scar20: 'rifle/rifle_scar/idle_scar20', weapon_usp_silencer: 'pistol/pistol_usp/idle_usp', weapon_hkp2000: 'pistol/pistol_hkp2000/idle_hkp',
  weapon_c4: 'equipment/c4/idle_c4',
};
const PISTOL_RE = /^weapon_(glock|usp_silencer|hkp2000|elite|p250|tec9|fiveseven|cz75a|deagle|revolver)$/;
// Locomotion set: grenades and the Zeus are carried like a pistol or knife (CS2 has no running clips for them).
export const setOf = (id) => (/knife|bayonet/.test(id || '') || GRENADE_RE.test(id || '') ? 'knife' : PISTOL_RE.test(id || '') || id === 'weapon_taser' ? 'pistol' : 'rifle');
function holdPath(id) {
  if (/knife|bayonet/.test(id)) return 'knife/_default_knife/idle_knife';
  if (id === 'weapon_molotov' || id === 'weapon_incgrenade') return 'grenade/grenade_molotov/idle_molotov.vnmclip+non_additive';
  if (GRENADE_RE.test(id)) return 'grenade/_default_grenade/idle_grenade.vnmclip+non_additive';
  if (id === 'weapon_taser') return 'pistol/pistol_taser/idle_taser.vnmclip+non_additive';
  if (HOLD[id]) return HOLD[id] + '.vnmclip+non_additive';
  const short = id.replace(/^weapon_/, ''), set = setOf(id);
  return `${set}/${set}_${short}/idle_${short}.vnmclip+non_additive`;
}
// The weapon's own draw / reload clip, next to its hold pose (rifle/rifle_ak/idle_ak -> rifle/rifle_ak/reload_ak).
function weaponClip(id, kind) {
  if (/knife|bayonet/.test(id)) return kind === 'draw' ? 'knife/_default_knife/draw_knife' : null;
  const m = /^(.*)\/idle_([a-z0-9_]+)/.exec(holdPath(id));
  return m ? `${m[1]}/${kind}_${m[2]}` : null;
}

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

// Shared assets for every bot: agent models per team, CS2's third-person clips, weapon models (loaded on first use).
export class BotAssets {
  constructor(renderer, ambient) {
    this.renderer = renderer;
    this.ambient = ambient;
    this.models = { T: [], CT: [] };
    this.clips = {};
    this.weapons = new Map(); // weapon id -> Promise<template scene | null>
    this.holds = new Map(); // weapon id -> Promise<arm clip | null>
    this.gestures = new Map(); // "weapon id:kind" -> Promise<arm clip | null>
    this.lit = new Set();
  }

  light(root) {
    root.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of [].concat(o.material)) {
        if (this.lit.has(m)) continue;
        this.lit.add(m);
        m.envMap = null;
        ambientLit(m, this.ambient);
        if (m.transparent && m.map) { m.alphaTest = 0.4; m.transparent = false; }
      }
    });
  }

  async load(holdsFor = []) {
    for (const team of ['T', 'CT']) {
      for (const vmdl of AGENTS[team]) {
        try {
          const g = await loadGltf((await cs2Play('agent', vmdl)).model);
          this.light(g.scene);
          this.models[team].push(g);
        } catch (e) { console.warn('agent model failed', vmdl, e); }
      }
    }
    const loco = SETS.flatMap((s) => [`${s}/_default_${s}/idle_${s}`, `${s}/_default_${s}/idle_crouch_${s}`, `${s}/_default_${s}/inair_stand_${s}`, ...GAITS.flatMap((g) => DIRS.map((d) => locoPath(s, g, d)))]);
    const ladders = SETS.map((s) => `${s}/_default_${s}/ladder_facing_slow_${s}`);
    const list = [...loco, ...ladders, ...DEATHS, PLANT, DEFUSE, ...Object.values(SHARED), ...holdsFor.map(holdPath)];
    const urls = await cs2Play('anims', list);
    await Promise.all(Object.entries(urls).map(async ([p, url]) => {
      try { this.clips[p] = (await loadGltf(url)).animations[0]; } catch {}
    }));
    // Legs from the locomotion clips (the arms come from the weapon's hold pose).
    for (const p of loco) {
      const c = this.clips[p];
      if (c) this.clips[p] = new THREE.AnimationClip(p, c.duration, c.tracks.filter((t) => !ARMS.test(t.name)));
    }
    for (const id of holdsFor) this.holds.set(id, Promise.resolve(this.armsClip(holdPath(id))));
    // Gestures keep only the tracks they move over the rest of the body.
    for (const [k, p] of Object.entries(SHARED)) this.clips[k] = this.trackClip(p, /^flinch|flashed/.test(k) ? UPPER : ARMS);
  }

  trackClip(path, re) {
    const c = this.clips[path];
    return c ? new THREE.AnimationClip(path + '#' + re.source, c.duration, c.tracks.filter((t) => re.test(t.name))) : null;
  }
  // A weapon's draw or reload as an arms clip (loaded on first use).
  gesture(id, kind) {
    const key = id + ':' + kind;
    if (!this.gestures.has(key)) {
      const path = weaponClip(id, kind);
      this.gestures.set(key, !path ? Promise.resolve(null) : cs2Play('anims', [path]).then(async (u) => {
        if (!u[path]) return null;
        this.clips[path] ||= (await loadGltf(u[path])).animations[0];
        return this.trackClip(path, ARMS);
      }).catch(() => null));
    }
    return this.gestures.get(key);
  }

  armsClip(path) {
    const c = this.clips[path];
    return c ? new THREE.AnimationClip(path, c.duration, c.tracks.filter((t) => ARMS.test(t.name))) : null;
  }
  hold(id) {
    if (!this.holds.has(id)) {
      this.holds.set(id, cs2Play('anims', [holdPath(id)]).then(async (u) => {
        const url = u[holdPath(id)];
        if (!url) return null;
        this.clips[holdPath(id)] = (await loadGltf(url)).animations[0];
        return this.armsClip(holdPath(id));
      }).catch(() => null));
    }
    return this.holds.get(id);
  }
  weapon(id) {
    if (!this.weapons.has(id)) {
      const def = { wid: id, w: id, n: id, cat: /knife|bayonet/.test(id) ? 'knife' : 'rifle', v: true };
      this.weapons.set(id, buildCS2Model({ t: 'skin', fl: 0, sd: 0 }, def, this.renderer).then((m) => {
        const root = m?.userData.root;
        if (root) this.light(root);
        return root || null;
      }).catch((e) => { console.warn('bot weapon model failed', id, e); return null; }));
    }
    return this.weapons.get(id);
  }
}

export class Bot {
  constructor(assets, c, index) {
    this.c = c; // the Combatant (team, health, money...)
    this.assets = assets;
    this.index = index;
    this.root = new THREE.Group();
    this.pos = [0, 0, 0]; this.vel = [0, 0, 0];
    this.yaw = 0; this.pitch = 0; this.ducked = false;
    this.weapons = {}; this.slot = 'secondary';
    this.mode = 'move'; // move | plant | defuse | dead
    this.time = 0;
    this.setModel(c.team);
  }

  setModel(team) {
    if (this.model && this.modelTeam === team) return;
    this.model?.removeFromParent();
    this.mixer?.stopAllAction();
    const list = this.assets.models[team];
    const src = list[this.index % Math.max(1, list.length)];
    this.modelTeam = team;
    this.model = cloneSkinned(src.scene);
    this.model.traverse((o) => {
      if (!o.isMesh) return;
      o.frustumCulled = false; o.castShadow = true; o.receiveShadow = true;
      if (/firstperson/.test(o.name) || /firstperson/.test(o.parent?.name || '')) o.visible = false;
    });
    this.root.add(this.model);
    this.bones = {};
    this.model.traverse((o) => { if (o.isBone && !this.bones[o.name]) this.bones[o.name] = o; });
    this.mixer = new THREE.AnimationMixer(this.model);
    this.loco = null;
    this.weaponModel = null;
    this.armsAction = null;
    this.gestureAction = null;
    this.ladder = null;
  }

  // Locomotion actions for a weapon class (all playing; weights blend them).
  setLocomotion(set) {
    if (this.loco?.set === set) return;
    if (this.loco) for (const a of this.loco.all) a.stop();
    const clip = (p) => this.assets.clips[p];
    const act = (p) => { const c = clip(p); if (!c) return null; const a = this.mixer.clipAction(c); a.setLoop(THREE.LoopRepeat, Infinity); a.setEffectiveWeight(0); a.play(); return a; };
    const loco = { set, idle: act(`${set}/_default_${set}/idle_${set}`), crouchIdle: act(`${set}/_default_${set}/idle_crouch_${set}`), air: act(`${set}/_default_${set}/inair_stand_${set}`) };
    for (const g of GAITS) loco[g] = DIRS.map((d) => act(locoPath(set, g, d)));
    loco.ladder = act(`${set}/_default_${set}/ladder_facing_slow_${set}`);
    loco.all = [loco.idle, loco.crouchIdle, loco.air, loco.ladder, ...GAITS.flatMap((g) => loco[g])].filter(Boolean);
    this.loco = loco;
  }

  // Shows the bot holding a weapon (its CS2 model on the "wpn" bone, its hold pose on the arms) and drawing it.
  async equip(id, { draw = true } = {}) {
    const changed = this.holding !== id;
    this.holding = id;
    this.setLocomotion(setOf(id));
    const [tpl, arms] = await Promise.all([this.assets.weapon(id), this.assets.hold(id)]);
    if (this.holding !== id) return;
    this.weaponModel?.removeFromParent();
    this.weaponModel = null;
    if (tpl && this.bones.wpn) {
      const w = cloneSkinned(tpl);
      w.position.set(0, 0, 0); w.rotation.set(0, 0, 0); w.scale.set(1, 1, 1);
      w.traverse((o) => { if (o.isMesh) { o.frustumCulled = false; o.castShadow = true; o.receiveShadow = true; } });
      let wb = null;
      w.traverse((o) => { if (!wb && o.isBone && o.name === 'weapon') wb = o; });
      w.updateMatrixWorld(true);
      const holder = new THREE.Group();
      holder.matrixAutoUpdate = false;
      if (wb) holder.matrix.copy(wb.matrixWorld).invert();
      holder.add(w);
      this.bones.wpn.add(holder);
      this.weaponModel = holder;
    }
    this.armsAction?.stop();
    this.armsAction = null;
    if (arms && this.mode !== 'dead') {
      this.armsAction = this.mixer.clipAction(arms);
      this.armsAction.setLoop(THREE.LoopRepeat, Infinity);
      this.armsAction.play();
    }
    if (draw && changed && this.mode === 'move') this.assets.gesture(id, 'draw').then((c) => { if (c && this.holding === id) this.gesture(c); });
  }

  // A one-off clip over the hold pose (draw, reload, throw, flinch...): the hold pose fades out under it and back after.
  gesture(clip, { weight = 1, loop = false, duration = null, speed = 1 } = {}) {
    if (!clip || this.mode === 'dead') return 0;
    const a = this.mixer.clipAction(clip);
    if (this.gestureAction && this.gestureAction !== a) this.gestureAction.fadeOut(0.08);
    a.reset();
    a.enabled = true;
    a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    a.clampWhenFinished = true;
    a.timeScale = speed;
    a.setEffectiveWeight(weight);
    a.fadeIn(0.08);
    a.play();
    if (weight >= 1) this.armsAction?.fadeOut(0.08);
    this.gestureAction = a;
    const len = duration ?? clip.duration / speed;
    this.gestureEnd = this.time + len;
    return len;
  }
  endGesture(fade = 0.15) {
    if (!this.gestureAction) return;
    this.gestureAction.fadeOut(fade);
    this.gestureAction = null;
    const h = this.armsAction;
    if (h && this.mode !== 'dead') { h.enabled = true; h.play(); h.fadeIn(fade); }
  }
  // Shorthands for the shared gestures.
  reloadGesture(id, secs) { this.assets.gesture(id, 'reload').then((c) => { if (c && this.holding === id) this.gesture(c, { speed: c.duration / Math.max(0.3, secs) }); }); }
  flashed(secs) { const c = this.assets.clips.flashed; if (c) this.gesture(c, { loop: true, duration: secs }); }
  flinch(group) {
    const c = this.assets.clips[group === 'head' ? 'flinchHead' : group === 'stomach' ? 'flinchStomach' : 'flinchChest'];
    if (c && !this.gestureAction) this.gesture(c, { weight: 0.6, duration: 0.35 });
  }

  // Puts the bot somewhere, alive and idle.
  spawn(origin, yaw) {
    this.setModel(this.c.team);
    this.pos = origin.slice(); this.vel = [0, 0, 0];
    this.yaw = yaw; this.pitch = 0; this.ducked = false;
    this.mode = 'move';
    this.mixer.stopAllAction();
    this.loco = null;
    this.gestureAction = null;
    this.climbing = null; this.airborne = false; this.pendingThrow = null;
    this.root.visible = true;
    if (this.holding) { const h = this.holding; this.holding = null; this.equip(h, { draw: false }); }
    this.sync();
  }

  // Plays planting / defusing / dying (or back to moving).
  setMode(mode, opts = {}) {
    if (this.mode === mode || this.mode === 'dead') return;
    this.mode = mode;
    this.special?.fadeOut(0.15);
    this.special = null;
    const clip = mode === 'plant' ? this.assets.clips[PLANT] : mode === 'defuse' ? this.assets.clips[DEFUSE]
      : mode === 'dead' ? this.assets.clips[DEATHS[Math.floor(Math.random() * (opts.headshot ? 2 : DEATHS.length))]] : null;
    if (mode === 'dead') {
      for (const a of this.loco?.all || []) a.fadeOut(0.1);
      this.armsAction?.fadeOut(0.1);
      this.gestureAction?.fadeOut(0.1);
      this.gestureAction = null;
    }
    if (clip) {
      const a = this.mixer.clipAction(clip);
      a.reset();
      a.setLoop(mode === 'defuse' ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
      a.clampWhenFinished = true;
      a.setEffectiveWeight(1);
      a.fadeIn(0.12);
      a.play();
      this.special = a;
    }
  }

  // Blend weights from the bot's velocity relative to where it faces.
  animate(dt) {
    const l = this.loco;
    this.time += dt;
    if (this.gestureAction && this.time >= this.gestureEnd) this.endGesture();
    // On a ladder the clip moves the arms too (hands on the rungs): the hold pose steps aside.
    if (!!this.climbing !== !!this.wasClimbing && this.armsAction && !this.gestureAction) {
      this.armsAction.enabled = true;
      if (this.climbing) this.armsAction.fadeOut(0.15); else { this.armsAction.play(); this.armsAction.fadeIn(0.15); }
    }
    this.wasClimbing = !!this.climbing;
    if (l && this.mode === 'move' && (this.climbing || this.airborne)) {
      // Climbing a ladder (the clip runs with the climbing speed) or in the air (falling off a ledge).
      const k = this.climbing ? 'ladder' : 'air';
      for (const a of l.all) a.setEffectiveWeight(a === l[k] ? 1 : 0);
      if (this.climbing && l.ladder) l.ladder.timeScale = Math.min(1.6, Math.abs(this.vel[2]) / 100);
    } else if (l && this.mode === 'move') {
      const yr = (this.yaw * Math.PI) / 180;
      const vf = this.vel[0] * Math.cos(yr) + this.vel[1] * Math.sin(yr);
      const vr = this.vel[0] * Math.sin(yr) - this.vel[1] * Math.cos(yr);
      const speed = Math.hypot(vf, vr);
      const move = Math.min(1, speed / 60);
      const gait = this.ducked ? 'crouch' : speed > 150 ? 'run' : 'walk';
      const a = Math.atan2(vr, vf);
      const w = [Math.max(0, Math.cos(a)), Math.max(0, Math.sin(a)), Math.max(0, -Math.cos(a)), Math.max(0, -Math.sin(a))];
      const sum = w.reduce((s, x) => s + x, 0) || 1;
      for (const g of GAITS) l[g].forEach((act, i) => { if (!act) return; act.setEffectiveWeight(g === gait ? (w[i] / sum) * move : 0); act.timeScale = Math.max(0.4, speed / (g === 'run' ? 230 : g === 'walk' ? 120 : 85)); });
      l.idle?.setEffectiveWeight(this.ducked ? 0 : 1 - move);
      l.crouchIdle?.setEffectiveWeight(this.ducked ? 1 - move : 0);
      l.air?.setEffectiveWeight(0);
      l.ladder?.setEffectiveWeight(0);
    }
    this.mixer.update(dt);
    if (this.mode === 'move' && !this.climbing) this.bendSpine();
  }

  // Leans the spine to aim up and down (CS2 blends aim poses; this bends spine_1..3 by a third each).
  bendSpine() {
    const yr = (this.yaw * Math.PI) / 180;
    const axis = new THREE.Vector3(-Math.cos(yr), 0, Math.sin(yr)); // the bot's right, in glTF axes
    const angle = (-this.pitch * Math.PI) / 180 / 3;
    const pq = new THREE.Quaternion(), q = new THREE.Quaternion().setFromAxisAngle(axis, angle);
    for (const n of ['spine_1', 'spine_2', 'spine_3']) {
      const b = this.bones[n];
      if (!b?.parent) continue;
      b.parent.updateWorldMatrix(true, false);
      b.parent.getWorldQuaternion(pq);
      b.quaternion.premultiply(pq.clone().invert().multiply(q).multiply(pq));
    }
  }

  // Copies the simulated position and facing onto the model.
  sync() {
    toGl(this.pos, this.root.position);
    this.root.rotation.set(0, (this.yaw * Math.PI) / 180, 0);
  }

  eye() { return [this.pos[0], this.pos[1], this.pos[2] + (this.ducked ? 46 : 64)]; }

  bonePos(name, out = new THREE.Vector3()) {
    const b = this.bones[name];
    if (!b) return null;
    b.getWorldPosition(out);
    return fromGl(out);
  }

  // Where shots come out of the bot's gun (game units).
  muzzle() {
    const w = this.bonePos('wpn');
    const yr = (this.yaw * Math.PI) / 180, pr = (this.pitch * Math.PI) / 180;
    const d = [Math.cos(pr) * Math.cos(yr), Math.cos(pr) * Math.sin(yr), -Math.sin(pr)];
    const o = w || this.eye();
    return [o[0] + d[0] * 26, o[1] + d[1] * 26, o[2] + d[2] * 26 + 2];
  }

  // Ray (game units) against this bot's hitboxes: { t, group } of the nearest hit, or null.
  raycast(o, d, maxT) {
    if (this.mode === 'dead') return null;
    const cx = this.pos[0] - o[0], cy = this.pos[1] - o[1];
    const along = cx * d[0] + cy * d[1];
    const px = cx - d[0] * along, py = cy - d[1] * along;
    if (px * px + py * py > 60 * 60 && Math.hypot(cx, cy) > 60) return null;
    this.sync(); // hitboxes follow the simulated position even between frames
    this.root.updateMatrixWorld(true);
    let best = null;
    const v = new THREE.Vector3();
    for (const h of HITBOXES) {
      const a = this.bonePos(h.a, v);
      if (!a) continue;
      let b = this.bonePos(h.b, v) || a;
      if (h.ext) {
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

  dispose() { this.mixer?.stopAllAction(); this.root.removeFromParent(); }
}

// Distance along a ray (o + d t, d unit length) to a capsule (segment a-b, radius r), or null.
export function rayCapsule(o, d, a, b, r) {
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
  let best = null;
  for (const c of [a, b]) {
    const oc = [o[0] - c[0], o[1] - c[1], o[2] - c[2]];
    const bb = dot(d, oc), cc = dot(oc, oc) - r * r, h = bb * bb - cc;
    if (h >= 0) { const t = -bb - Math.sqrt(h); if (t >= 0 && (best === null || t < best)) best = t; }
  }
  return best;
}
