// First-person viewmodels: CS2's viewmodel animations played on CS2's first-person arms (or your equipped gloves) and
// on the real weapon model with your skin, seen from the player's eyes. Used by the first-person inspect and by Play
// mode. Each clip (exported from the player's install) carries the viewmodel skeleton: arms, hands, fingers and the
// weapon's own bones (bolt, magazine...).
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { cs2FirstPerson } from './api.js';
import { loadGltf as load, rebind, bonesByName, forearmTwist, retargetWeapon } from './rig.js';
import { buildGloveScene } from './skin.js';
import { itemDef } from '../items.js';

// CS2's special inspects and draws (the Deagle's spin, the Falchion's and Skeleton's tricks...) come up now and then:
// about one in nine, and never twice in a row (Play and the inventory's first-person inspect alike).
export const RARE_CHANCE = 1 / 9;

// Puts arms and weapon on a clip's skeleton (clipScene may be a promise). Returns { rig, skel, bones, pose, dispose }:
// the rig is in game metres with the eye at the origin, looking down -Z; run pose() after each animation step (forearm
// twist, weapon merge). `gloves` (an inventory item) replaces CS2's default arms with that glove model and its skin,
// like equipped gloves in game.
export async function assembleViewmodel(model, clipScene, armsUrl, { gloves = null, renderer = null } = {}) {
  let gloveArms;
  [clipScene, gloveArms] = await Promise.all([clipScene, gloves && renderer ? buildGloveScene(gloves, itemDef(gloves), renderer).catch((e) => {
    console.warn('Equipped gloves unavailable in first person, using the default arms:', e);
    return null;
  }) : null]);

  const rig = new THREE.Group();
  const view = new THREE.Group(); // the exported viewmodel faces +Z; turn it to face -Z like our cameras
  view.rotation.y = Math.PI;
  rig.add(view);

  const skel = cloneSkinned(clipScene);
  skel.traverse((o) => { if (o.isMesh) o.visible = false; }); // the clip's placeholder meshes
  view.add(skel);
  const bones = bonesByName(skel);
  // CS2 bone-merges the weapon onto the hands: its "weapon" bone follows the viewmodel's "wpn" bone, and the
  // clip animates the weapon's own parts (bolt, magazine, blade...) relative to it.
  const weaponBone = bones.weapon;
  const weaponRoot = weaponBone?.parent;
  if (weaponRoot && bones.wpn) {
    bones.wpn.add(weaponRoot);
    weaponRoot.matrixAutoUpdate = false;
  }

  const armsScene = gloveArms ? gloveArms.root : cloneSkinned((await load(armsUrl)).scene);
  armsScene.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of [].concat(o.material || [])) { m.envMapIntensity = 0.7; if (m.transparent && m.map) { m.alphaTest = 0.4; m.transparent = false; } }
  });
  rebind(armsScene, bones, skel);
  view.add(armsScene);
  const twist = forearmTwist(bones);

  // The weapon: a copy of the inspect model's glTF scene (same skin materials), without its inspect framing.
  const root = cloneSkinned(model.userData.root);
  root.position.set(0, 0, 0); root.rotation.set(0, 0, 0); root.scale.set(1, 1, 1);
  const fixes = retargetWeapon(root, bones); // e.g. the USP-S on the P2000's clips
  rebind(root, bones, weaponRoot || skel);
  view.add(root);
  // A StatTrak™ counter moves onto the animated bone of the same name.
  const riders = [];
  root.traverse((o) => { if (o.userData.statTrak && o.parent?.isBone) riders.push(o); });
  for (const o of riders) {
    const b = bones[o.parent.name];
    if (!b) continue;
    const f = fixes.get(o.parent.name);
    if (f) o.applyMatrix4(f);
    b.add(o);
  }

  // Stickers ride on the bone that moves the surface they're on (the magazine's for one on the mag, so it comes out
  // with it on a reload), else the weapon's main bone.
  const db = model.userData.decalBone;
  model.traverse((o) => {
    if (!o.userData.decal) return;
    const on = o.userData.bone && bones[o.userData.bone.name] ? o.userData.bone : db && bones[db.name] ? db : null;
    if (!on) return;
    const geo = o.geometry.clone().applyMatrix4(on.matrixWorld.clone().invert());
    if (fixes.has(on.name)) geo.applyMatrix4(fixes.get(on.name));
    const d = new THREE.Mesh(geo, o.material);
    d.renderOrder = o.renderOrder;
    d.frustumCulled = false;
    bones[on.name].add(d);
  });

  // Keeps the forearms twisting with the hands and the weapon merged onto them.
  const pose = () => {
    twist();
    if (weaponRoot && bones.wpn) {
      weaponBone.updateMatrix();
      weaponRoot.matrix.copy(weaponBone.matrix).invert();
    }
  };
  // Frees what this rig made itself (the equipped gloves' baked textures); the weapon's materials belong to the model.
  const dispose = () => {
    gloveArms?.root.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of [].concat(o.material || [])) {
        for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) m[k]?.dispose();
        m.userData.dispose?.();
        m.dispose();
      }
    });
  };
  return { rig, skel, bones, pose, dispose };
}

// The first-person inspect for an inspect model made by buildCS2Model: { rig, mixer, action, actions, play(rare),
// update, duration }. actions[0] is the usual inspect, the rest CS2's special ones (play(true) picks one of them).
export async function buildFirstPerson(model, { gloves = null, renderer = null } = {}) {
  const weapon = model.userData.weapon;
  if (!weapon || !model.userData.root) throw new Error('First person needs the real CS2 model');
  const { clip, clips = [clip], arms } = await cs2FirstPerson(weapon);
  const loads = clips.map((u) => load(u));
  const vm = await assembleViewmodel(model, loads[0].then((g) => g.scene), arms, { gloves, renderer });
  const mixer = new THREE.AnimationMixer(vm.skel);
  const actions = (await Promise.all(loads.map((p) => p.catch(() => null)))).map((g) => g?.animations[0]).filter(Boolean).map((anim) => {
    const a = mixer.clipAction(anim);
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    return a;
  });
  const fp = { rig: vm.rig, mixer, actions, action: actions[0], dispose: vm.dispose, duration: actions[0].getClip().duration };
  fp.hasRare = actions.length > 1;
  // Plays the usual inspect, or one of the special ones.
  fp.play = (rare = false) => {
    const a = rare && fp.hasRare ? actions[1 + Math.floor(Math.random() * (actions.length - 1))] : actions[0];
    for (const o of actions) if (o !== a) o.stop();
    fp.action = a;
    fp.duration = a.getClip().duration;
    a.reset().play();
  };
  fp.update = (dt) => { mixer.update(dt); vm.pose(); };
  fp.update(0);
  return fp;
}
