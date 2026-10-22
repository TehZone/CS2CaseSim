// First-person inspect: CS2's own viewmodel inspect animation ("lookat01" clips) played on CS2's first-person arms
// and on the real weapon model with your skin, seen from the player's eyes. The clip (exported from the player's
// install) carries the viewmodel skeleton: arms, hands, fingers and the weapon's own bones (bolt, magazine...).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { cs2FirstPerson } from './api.js';

const loader = new GLTFLoader();
const files = new Map();
const load = (url) => {
  if (!files.has(url)) { const p = loader.loadAsync(url); files.set(url, p); p.catch(() => files.delete(url)); }
  return files.get(url);
};

// A bone the clip doesn't animate (forearm twist helpers, the body, extra weapon bones) is copied onto its parent
// in the clip's skeleton with its rest offset, so it follows the animation instead of staying behind.
function graft(b, bones, fallback) {
  if (bones[b.name]) return bones[b.name];
  const parent = b.parent && (bones[b.parent.name] || (b.parent.isBone ? graft(b.parent, bones, fallback) : null));
  const g = new THREE.Bone();
  g.name = b.name;
  g.position.copy(b.position); g.quaternion.copy(b.quaternion); g.scale.copy(b.scale);
  (parent || fallback).add(g);
  bones[b.name] = g;
  return g;
}

// Points a skinned scene's meshes at the clip's bones (by name), so the animation moves them.
function rebind(scene, bones, fallback) {
  scene.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    const sk = o.skeleton;
    o.bind(new THREE.Skeleton(sk.bones.map((b) => graft(b, bones, fallback)), sk.boneInverses), o.bindMatrix);
    o.frustumCulled = false;
  });
}

// Builds the first-person rig for an inspect model made by buildCS2Model. Returns { rig, mixer, action, duration }.
// The rig is in game metres with the eye at the origin, looking down -Z.
export async function buildFirstPerson(model) {
  const weapon = model.userData.weapon;
  if (!weapon || !model.userData.root) throw new Error('First person needs the real CS2 model');
  const { clip, arms } = await cs2FirstPerson(weapon);
  const [clipG, armsG] = await Promise.all([load(clip), load(arms)]);

  const rig = new THREE.Group();
  const view = new THREE.Group(); // the exported viewmodel faces +Z; turn it to face -Z like our cameras
  view.rotation.y = Math.PI;
  rig.add(view);

  const skel = cloneSkinned(clipG.scene);
  skel.traverse((o) => { if (o.isMesh) o.visible = false; }); // the clip's placeholder meshes
  view.add(skel);
  const bones = {};
  skel.traverse((o) => { if (o.name && !bones[o.name]) bones[o.name] = o; });
  // CS2 bone-merges the weapon onto the hands: its "weapon" bone follows the viewmodel's "wpn" bone, and the
  // clip animates the weapon's own parts (bolt, magazine, blade...) relative to it.
  const weaponBone = bones.weapon;
  const weaponRoot = weaponBone?.parent;
  if (weaponRoot && bones.wpn) {
    bones.wpn.add(weaponRoot);
    weaponRoot.matrixAutoUpdate = false;
  }

  const armsScene = cloneSkinned(armsG.scene);
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
  return { rig, mixer, action, update, duration: anim.duration };
}
