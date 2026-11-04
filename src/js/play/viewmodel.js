// A weapon in first person for Play mode: your skin on CS2's model, on CS2's arms (or your equipped gloves), playing
// CS2's viewmodel animations (draw, idle, shoot, reload, inspect, knife attacks, the silencer screwed on and off).
import * as THREE from 'three';
import { assembleViewmodel } from '../cs2/firstperson.js';
import { loadGltf, rebind, shareSkeletons } from '../cs2/rig.js';
import { buildCS2Model } from '../cs2/skin.js';
import { barrelTip, SPECULAR_AA, centroidVaryings } from './world.js';

// The weapon's reflections, stronger than the map's sky alone gives: metal (blades, the Molotov's lighter) shows only
// what it reflects, and in the shade, without the sun, it went near black. CS2's own reflections come from bright
// captures of the map around you. (And specular anti-aliasing and centroid sampling, see world.js: no sparkling dots.)
const REFLECT = 3;
function strongerReflections(m) {
  if (!m?.isMeshStandardMaterial || m.userData.vmReflect) return;
  m.userData.vmReflect = true;
  const prev = m.onBeforeCompile, key = m.customProgramCacheKey;
  m.onBeforeCompile = (sh, r) => {
    prev?.call(m, sh, r);
    sh.fragmentShader = sh.fragmentShader.replace('#include <lights_physical_fragment>', SPECULAR_AA);
    sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
	#if defined( RE_IndirectSpecular )
		radiance *= ${REFLECT.toFixed(1)};
	#endif`);
    centroidVaryings(sh);
  };
  m.customProgramCacheKey = () => (key?.call(m) || '') + 'vmreflect3';
  m.needsUpdate = true;
}

// Your weapon in your left hand (cl_prefer_lefthanded, see Game.setLeftHanded) is the viewmodel mirrored. three takes
// a normal map's bitangent from the mirrored normal and tangent, which turns it round, and the dents and scratches would
// be lit inside out: a mirrored model gets it back.
const MIRROR_SAFE = `#include <normal_vertex>
#if defined( USE_TANGENT ) && ! defined( FLAT_SHADED )
	if ( determinant( mat3( modelMatrix ) ) < 0.0 ) vBitangent = - vBitangent;
#endif`;
function mirrorSafe(m) {
  if (!m?.isMaterial || m.userData.vmMirror) return;
  m.userData.vmMirror = true;
  const prev = m.onBeforeCompile, key = m.customProgramCacheKey;
  m.onBeforeCompile = (sh, r) => {
    prev?.call(m, sh, r);
    sh.vertexShader = sh.vertexShader.replace('#include <normal_vertex>', MIRROR_SAFE);
  };
  m.customProgramCacheKey = () => (key?.call(m) || '') + 'vmmirror';
  m.needsUpdate = true;
}

// CS2 blends one viewmodel animation into the next from wherever the viewmodel is, so nothing snaps: an inspect pressed
// again starts over from the pose it's in, a reload takes over from an inspect halfway through. nodes: the bones the
// clips move. hold() keeps the pose shown before the clips change; start(fade) after, and each step eases the bones from
// that pose to the new clip's over fade seconds.
export function poseBlend(nodes) {
  const poses = () => nodes.map(() => ({ p: new THREE.Vector3(), q: new THREE.Quaternion(), s: new THREE.Vector3() }));
  const from = poses(), raw = poses();
  const save = (to) => nodes.forEach((o, i) => { to[i].p.copy(o.position); to[i].q.copy(o.quaternion); to[i].s.copy(o.scale); });
  const put = (src) => nodes.forEach((o, i) => { o.position.copy(src[i].p); o.quaternion.copy(src[i].q); o.scale.copy(src[i].s); });
  let t = 0, len = 0;
  return {
    get active() { return len > 0; },
    hold() { save(from); },
    // (Until the next step it shows the held pose: drawn before then, it doesn't flash the rest pose.)
    start(fade) { if (!(fade > 0)) { len = 0; return; } save(raw); put(from); t = 0; len = fade; },
    // run(dt) advances the clips.
    step(dt, run) {
      if (!len) { run(dt); return; }
      put(raw); // (a bone the new clip doesn't move is where it went back to, not where the last step's blend left it)
      run(dt);
      save(raw);
      t += dt;
      const k = Math.min(1, t / len), w = k * k * (3 - 2 * k);
      nodes.forEach((o, i) => {
        o.position.lerpVectors(from[i].p, raw[i].p, w); o.quaternion.slerpQuaternions(from[i].q, raw[i].q, w); o.scale.lerpVectors(from[i].s, raw[i].s, w);
      });
      if (k >= 1) len = 0;
    },
  };
}

// A viewmodel's clips (clips: role -> [AnimationClip]) played on its skeleton (root), each blended in from the pose it's
// in. play() returns the clip's length in seconds; update(dt) steps it.
export function clipPlayer(root, clips) {
  const mixer = new THREE.AnimationMixer(root);
  const moved = [...new Set(Object.values(clips).flat().flatMap((c) => c.tracks.map((t) => THREE.PropertyBinding.parseTrackName(t.name).nodeName)))]
    .map((n) => THREE.PropertyBinding.findNode(root, n)).filter((o, i, all) => o?.isObject3D && all.indexOf(o) === i);
  const blend = poseBlend(moved);
  let current = null, currentRole = null;
  // A clip for a role (a random one when there are several), blended over fade seconds from the pose the viewmodel is
  // in (0: from the clip's first frame, as a draw is).
  const play = (role, { loop = false, fade = 0.05, speed = 1, index = null } = {}) => {
    const list = clips[role];
    if (!list?.length) return 0;
    const clip = list[index ?? Math.floor(Math.random() * list.length)];
    const a = mixer.clipAction(clip);
    if (current) blend.hold();
    mixer.stopAllAction();
    a.reset();
    a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    a.clampWhenFinished = !loop;
    a.timeScale = speed;
    a.setEffectiveWeight(1);
    a.play();
    blend.start(current ? fade : 0);
    current = a;
    currentRole = role;
    return clip.duration / speed;
  };
  return {
    mixer, play,
    has: (role) => !!clips[role]?.length,
    length: (role) => clips[role]?.[0]?.duration || 0,
    update: (dt) => blend.step(dt, (d) => mixer.update(d)),
    get role() { return currentRole; },
  };
}

// The bones that move with your arms. Some agents' sleeves are cut from their jacket, weighted to the shoulders and the
// body too (tm_leet variantf-j, tm_jungle_raider_varianta), which no viewmodel clip moves: those triangles swept across
// the screen. Only what hangs on the arms stays.
const ARM_BONE = /^(arm_(upper|lower)_[LR](_TWIST1?)?|hand_[LR]|finger_\w+)$/;
export function armsOnly(o) {
  const g = o.geometry, si = g.attributes.skinIndex, sw = g.attributes.skinWeight, idx = g.index;
  if (!si || !sw || !idx) return g;
  const body = o.skeleton.bones.map((b) => !ARM_BONE.test(b.name));
  const off = (v) => { for (let k = 0; k < 4; k++) if (sw.getComponent(v, k) > 0 && body[si.getComponent(v, k)]) return true; return false; };
  const keep = [];
  for (let i = 0; i < idx.count; i += 3) { const a = idx.getX(i), b = idx.getX(i + 1), c = idx.getX(i + 2); if (!off(a) && !off(b) && !off(c)) keep.push(a, b, c); }
  if (keep.length === idx.count) return g;
  const cut = new THREE.BufferGeometry();
  for (const [k, v] of Object.entries(g.attributes)) cut.setAttribute(k, v);
  cut.setIndex(keep);
  return cut;
}

// An agent's arms in first person, from its model (each CS2 agent carries them): arms, its bare arms and default gloves;
// sleeves, what it wears over them (none on 12 agents; a watch on some). Materials of their own: the model's are lit for
// the world (see BotAssets.light), and they'd come out too bright here. Textures stay shared with your body.
export function agentArms(gltf) {
  const mats = new Map(), cuts = [];
  const mine = (m) => {
    if (!mats.has(m)) {
      const c = m.clone();
      c.envMapIntensity = 0.7;
      if (c.transparent && c.map) { c.alphaTest = 0.4; c.transparent = false; }
      mats.set(m, c);
    }
    return mats.get(m);
  };
  const meshes = (re) => {
    const out = [];
    gltf.scene.traverse((o) => {
      if (!o.isSkinnedMesh || !(re.test(o.name) || re.test(o.parent?.name || ''))) return;
      const c = o.clone();
      c.visible = true;
      c.material = Array.isArray(o.material) ? o.material.map(mine) : mine(o.material);
      const g = armsOnly(o);
      if (g !== o.geometry) { cuts.push(g); c.geometry = g; }
      out.push(c);
    });
    return out;
  };
  return { arms: meshes(/firstperson_default_gloves_arms/), sleeves: meshes(/firstperson_sleeves/), dispose() { for (const m of mats.values()) m.dispose(); for (const g of cuts) g.dispose(); } };
}

// Your agents' arms on a rig: agents, each side's agentArms. Returns wear(side): that side's arms on, and today's arms
// (weapon_arms) off, or left on for a side with no agent. Equipped gloves stay on either way, as in CS2: they replace the
// agent's bare arms and gloves, its sleeves go over them.
export function dressArms(vm, agents, gloves) {
  const roots = {};
  for (const [side, src] of Object.entries(agents)) {
    const root = new THREE.Group();
    for (const m of [...(gloves ? [] : src.arms), ...src.sleeves]) root.add(m.clone());
    rebind(root, vm.bones, vm.skel);
    shareSkeletons(root);
    root.visible = false;
    vm.view.add(root);
    roots[side] = root;
  }
  return (side) => {
    for (const [k, root] of Object.entries(roots)) root.visible = k === side;
    if (!gloves) vm.arms.visible = !roots[side];
  };
}

// data: cs2Play('weapon', id) -> { clips: { role: url | [urls] }, arms }. agents: your agents' arms (see dressArms), on
// your own guns only: a spectated bot's hands stay as they are.
export async function buildViewmodel(item, def, data, { gloves = null, gloveScene = null, renderer, agents = null }) {
  const model = await buildCS2Model(item, def, renderer, { quick: true });
  if (!model?.userData.root) throw new Error('No CS2 model for ' + def.n);
  const entries = Object.entries(data.clips).flatMap(([role, u]) => [].concat(u).map((url) => [role, url]));
  const loaded = await Promise.all(entries.map(([, url]) => loadGltf(url)));
  const base = loaded[entries.findIndex(([r]) => r === 'idle')] || loaded[0];
  const vm = await assembleViewmodel(model, base.scene, data.arms, { gloves, gloveScene, renderer });
  const wear = agents ? dressArms(vm, agents, vm.gloved) : null; // (gloves that failed to load: as if none were on)
  vm.rig.traverse((o) => { if (o.isMesh) { o.frustumCulled = false; o.castShadow = false; o.receiveShadow = true; } });
  model.traverse((o) => { if (o.isMesh) for (const m of [].concat(o.material)) strongerReflections(m); });
  vm.rig.traverse((o) => { if (o.isMesh) for (const m of [].concat(o.material)) mirrorSafe(m); });

  const clips = {};
  entries.forEach(([role], i) => { const a = loaded[i].animations[0]; if (a) (clips[role] ||= []).push(a); });
  const anim = clipPlayer(vm.skel, clips), { play, has, length } = anim;
  // A detachable silencer (its own bone): hidden while it's off (the idle clips would put it back on the muzzle).
  let silencerOff = false;
  const setSilencer = (on) => { silencerOff = !on; if (on) vm.bones.silencer?.scale.setScalar(1); };
  const update = (dt) => {
    anim.update(dt);
    if (silencerOff) vm.bones.silencer?.scale.setScalar(1e-4);
    vm.pose();
  };
  play(has('idle') ? 'idle' : 'draw', { loop: has('idle') });
  update(0);

  // Muzzle: the weapon model's muzzle attachment bone if it has one, else a point on its weapon bone at the barrel's tip
  // (the muzzle flash and your tracers start there).
  let muzzle = null;
  vm.rig.traverse((o) => { if (!muzzle && /muzzle/i.test(o.name)) muzzle = o; });
  const tip = !muzzle && vm.bones.weapon && def.cat !== 'knife' && barrelTip(model.userData.root);
  if (tip) { muzzle = new THREE.Object3D(); muzzle.name = 'muzzle_tip'; muzzle.position.copy(tip); vm.bones.weapon.add(muzzle); }
  return {
    model, rig: vm.rig, bones: vm.bones, muzzle, play, has, length, update, setSilencer, wear,
    get role() { return anim.role; },
    dispose() {
      anim.mixer.stopAllAction();
      vm.dispose();
      model.traverse((o) => { for (const m of [].concat(o.material || [])) m.userData.dispose?.(); }); // the skin's baked textures
    },
  };
}
