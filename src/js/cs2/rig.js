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

// Bones of a scene by name (first match wins).
export function bonesByName(scene) {
  const bones = {};
  scene.traverse((o) => { if (o.name && !bones[o.name]) bones[o.name] = o; });
  return bones;
}
