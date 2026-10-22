// First-person inspect: CS2's own viewmodel inspect animation ("lookat01" clips) played on CS2's first-person arms
// and on the real weapon model with your skin, seen from the player's eyes. The clip (exported from the player's
// install) carries the viewmodel skeleton: arms, hands, fingers and the weapon's own bones (bolt, magazine...).
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { cs2FirstPerson } from './api.js';
import { loadGltf as load, rebind, bonesByName } from './rig.js';
import { buildGloveScene } from './skin.js';
import { itemDef } from '../items.js';

// Builds the first-person rig for an inspect model made by buildCS2Model. Returns { rig, mixer, action, duration }.
// The rig is in game metres with the eye at the origin, looking down -Z. `gloves` (an inventory item) replaces
// CS2's default arms with that glove model and its skin, like equipped gloves in game.
export async function buildFirstPerson(model, { gloves = null, renderer = null } = {}) {
  const weapon = model.userData.weapon;
  if (!weapon || !model.userData.root) throw new Error('First person needs the real CS2 model');
  const { clip, arms } = await cs2FirstPerson(weapon);
  const [clipG, gloveArms] = await Promise.all([load(clip), gloves && renderer ? buildGloveScene(gloves, itemDef(gloves), renderer).catch((e) => {
    console.warn('Equipped gloves unavailable in first person, using the default arms:', e);
    return null;
  }) : null]);

  const rig = new THREE.Group();
  const view = new THREE.Group(); // the exported viewmodel faces +Z; turn it to face -Z like our cameras
  view.rotation.y = Math.PI;
  rig.add(view);

  const skel = cloneSkinned(clipG.scene);
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

  const armsScene = gloveArms ? gloveArms.root : cloneSkinned((await load(arms)).scene);
  armsScene.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of [].concat(o.material || [])) { m.envMapIntensity = 0.7; if (m.transparent && m.map) { m.alphaTest = 0.4; m.transparent = false; } }
  });
  rebind(armsScene, bones, skel);
  view.add(armsScene);

  // The weapon: a copy of the inspect model's glTF scene (same skin materials), without its inspect framing.
  const root = cloneSkinned(model.userData.root);
  root.position.set(0, 0, 0); root.rotation.set(0, 0, 0); root.scale.set(1, 1, 1);
  rebind(root, bones, weaponRoot || skel);
  view.add(root);

  // Stickers ride on the weapon's main bone.
  const db = model.userData.decalBone;
  if (db && bones[db.name]) {
    const toBone = db.matrixWorld.clone().invert();
    model.traverse((o) => {
      if (!o.userData.decal) return;
      const d = new THREE.Mesh(o.geometry.clone().applyMatrix4(toBone), o.material);
      d.renderOrder = o.renderOrder;
      d.frustumCulled = false;
      bones[db.name].add(d);
    });
  }

  const anim = clipG.animations[0];
  const mixer = new THREE.AnimationMixer(skel);
  const action = mixer.clipAction(anim);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  // Advances the animation and keeps the weapon merged onto the hands.
  const update = (dt) => {
    mixer.update(dt);
    if (weaponRoot && bones.wpn) {
      weaponBone.updateMatrix();
      weaponRoot.matrix.copy(weaponBone.matrix).invert();
    }
  };
  update(0);
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
  return { rig, mixer, action, update, dispose, duration: anim.duration };
}
