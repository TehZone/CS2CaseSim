// Shared helpers for CS2's animated viewmodel rigs (first-person inspect, glove inspect): glTF loading and
// rebinding skinned meshes onto an animation clip's skeleton.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const loader = new GLTFLoader();
const files = new Map();
export function loadGltf(url) {
  if (!files.has(url)) { const p = loader.loadAsync(url); files.set(url, p); p.catch(() => files.delete(url)); }
  return files.get(url);
}

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
export function rebind(scene, bones, fallback) {
  scene.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    const sk = o.skeleton;
    o.bind(new THREE.Skeleton(sk.bones.map((b) => graft(b, bones, fallback)), sk.boneInverses), o.bindMatrix);
    o.frustumCulled = false;
  });
}

// CS2's forearm twist (the arms model's CTiltTwistConstraints): the clips don't animate the forearm twist bones;
// the game turns them by a share of the hand's roll around the forearm (bone X axis), measured from the hand's rest
// orientation (the constraint's target offset). Returns an update to run after each animation step.
const TWIST_REST = new THREE.Quaternion(0.684638, -0.0025270376, 0.03596654, 0.72799087).invert();
const TWISTS = [['arm_lower_L_TWIST', 'hand_L', 0.5], ['arm_lower_L_TWIST1', 'hand_L', 1], ['arm_lower_R_TWIST', 'hand_R', 0.5], ['arm_lower_R_TWIST1', 'hand_R', 1]];
const X_AXIS = new THREE.Vector3(1, 0, 0);
export function forearmTwist(bones) {
  const list = TWISTS.filter(([b, h]) => bones[b] && bones[h]).map(([b, h, w]) => ({ bone: bones[b], hand: bones[h], w, rest: bones[b].quaternion.clone() }));
  const q = new THREE.Quaternion(), t = new THREE.Quaternion();
  return () => {
    for (const { bone, hand, w, rest } of list) {
      q.copy(TWIST_REST).multiply(hand.quaternion);
      if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w);
      const angle = 2 * Math.atan2(q.x, q.w); // the twist part of the swing-twist split about X
      bone.quaternion.copy(rest).multiply(t.setFromAxisAngle(X_AXIS, angle * w));
    }
  };
}

// Some weapons play clips made for a sibling model (the USP-S uses the P2000's), whose parts rest elsewhere: the clip
// would put them at the sibling's places (the USP-S slide sat up and back). Call before rebind: re-binds each weapon
// part so the clip's motion is applied from this model's own rest pose, relative to the weapon bone. `bones` are the
// clip's, still at rest. Returns { bone name -> matrix } to premultiply things parented to a part with (stickers,
// the StatTrak™ counter). Parts that already match the clip come out unchanged.
export function retargetWeapon(scene, bones, weaponName = 'weapon') {
  const fixes = new Map();
  const own = bonesByName(scene);
  const ow = own[weaponName], cw = bones[weaponName];
  if (!ow || !cw) return fixes;
  scene.updateMatrixWorld(true);
  cw.parent?.updateMatrixWorld(true);
  const owInv = ow.matrixWorld.clone().invert(), cwInv = cw.matrixWorld.clone().invert();
  const rest = new Map(); // the clip's rest pose of each part relative to the weapon bone
  ow.traverse((b) => {
    const cb = bones[b.name];
    // A part the clip lacks is grafted onto its parent with this model's own offset (see graft).
    const rel0 = cb ? cwInv.clone().multiply(cb.matrixWorld) : rest.has(b.parent?.name) ? rest.get(b.parent.name).clone().multiply(b.matrix) : null;
    if (!rel0) return;
    rest.set(b.name, rel0);
    fixes.set(b.name, rel0.clone().invert().multiply(owInv.clone().multiply(b.matrixWorld)));
  });
  scene.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    const sk = o.skeleton;
    sk.boneInverses = sk.boneInverses.map((inv, i) => { const f = fixes.get(sk.bones[i].name); return f ? f.clone().multiply(inv) : inv; });
  });
  return fixes;
}

// Bones of a scene by name (first match wins).
export function bonesByName(scene) {
  const bones = {};
  scene.traverse((o) => { if (o.name && !bones[o.name]) bones[o.name] = o; });
  return bones;
}
