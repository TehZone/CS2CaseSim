// A weapon in first person for Play mode: your skin on CS2's model, on CS2's arms (or your equipped gloves), playing
// CS2's viewmodel animations (draw, idle, shoot, reload, inspect, knife attacks).
import * as THREE from 'three';
import { assembleViewmodel } from '../cs2/firstperson.js';
import { loadGltf } from '../cs2/rig.js';
import { buildCS2Model } from '../cs2/skin.js';

// data: cs2Play('weapon', id) -> { clips: { role: url | [urls] }, arms }.
export async function buildViewmodel(item, def, data, { gloves = null, renderer }) {
  const model = await buildCS2Model(item, def, renderer);
  if (!model?.userData.root) throw new Error('No CS2 model for ' + def.n);
  const entries = Object.entries(data.clips).flatMap(([role, u]) => [].concat(u).map((url) => [role, url]));
  const loaded = await Promise.all(entries.map(([, url]) => loadGltf(url)));
  const base = loaded[entries.findIndex(([r]) => r === 'idle')] || loaded[0];
  const vm = await assembleViewmodel(model, base.scene, data.arms, { gloves, renderer });
  vm.rig.traverse((o) => { if (o.isMesh) { o.frustumCulled = false; o.castShadow = false; o.receiveShadow = true; } });

  const mixer = new THREE.AnimationMixer(vm.skel);
  const clips = {};
  entries.forEach(([role], i) => { const a = loaded[i].animations[0]; if (a) (clips[role] ||= []).push(a); });
  let current = null, currentRole = null;
  // Plays a clip for a role (a random one when there are several). Returns its length in seconds.
  const play = (role, { loop = false, fade = 0.05, speed = 1, index = null } = {}) => {
    const list = clips[role];
    if (!list?.length) return 0;
    const clip = list[index ?? Math.floor(Math.random() * list.length)];
    const a = mixer.clipAction(clip);
    const prev = current;
    a.reset();
    a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    a.clampWhenFinished = !loop;
    a.timeScale = speed;
    a.setEffectiveWeight(1);
    a.play();
    if (prev && prev !== a) { a.crossFadeFrom(prev, fade, false); }
    current = a;
    currentRole = role;
    return clip.duration / speed;
  };
  const has = (role) => !!clips[role]?.length;
  const length = (role) => clips[role]?.[0]?.duration || 0;
  const update = (dt) => { mixer.update(dt); vm.pose(); };
  play(has('idle') ? 'idle' : 'draw', { loop: has('idle') });
  update(0);

  // Muzzle: the weapon model's muzzle attachment bone if it has one.
  let muzzle = null;
  vm.rig.traverse((o) => { if (!muzzle && /muzzle/i.test(o.name)) muzzle = o; });
  return {
    model, rig: vm.rig, bones: vm.bones, muzzle, play, has, length, update,
    get role() { return currentRole; },
    dispose() {
      mixer.stopAllAction();
      vm.dispose();
      model.traverse((o) => { for (const m of [].concat(o.material || [])) m.userData.dispose?.(); }); // the skin's baked textures
    },
  };
}
