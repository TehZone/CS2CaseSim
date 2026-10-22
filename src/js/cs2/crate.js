// CS2's case opening: the container's own 3D crate drops in and unlocks, played with the "fall" and "open"
// animations that ship with CS2's crate models (exported from the player's install).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { cs2Crate, cs2Status } from './api.js';
import { texture } from './textures.js';

const loader = new GLTFLoader();
const gltfs = new Map();
const loadGltf = (url) => {
  if (!gltfs.has(url)) { const p = loader.loadAsync(url); gltfs.set(url, p); p.catch(() => gltfs.delete(url)); }
  return gltfs.get(url);
};

// One renderer for every opening (its canvas moves into each opening overlay).
let renderer = null, env = null;
function sharedRenderer() {
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const pmrem = new THREE.PMREMGenerator(renderer);
    env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
  }
  return renderer;
}

// Older crates paint their artwork as a decal over the base colour, on the mesh's second UV set.
function addDecal(material, map) {
  material.onBeforeCompile = (sh) => {
    sh.uniforms.cs2Decal = { value: map };
    sh.vertexShader = sh.vertexShader
      .replace('#include <uv_pars_vertex>', '#include <uv_pars_vertex>\nattribute vec2 uv1;\nvarying vec2 vCs2DecalUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvCs2DecalUv = uv1;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <uv_pars_fragment>', '#include <uv_pars_fragment>\nuniform sampler2D cs2Decal;\nvarying vec2 vCs2DecalUv;')
      .replace('#include <map_fragment>', '#include <map_fragment>\n{ vec4 d = texture2D(cs2Decal, vCs2DecalUv); diffuseColor.rgb = mix(diffuseColor.rgb, d.rgb, d.a); }');
  };
  material.customProgramCacheKey = () => 'cs2decal';
}

// Soft contact shadow under the crate.
function shadowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(0,0,0,.65)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

class CrateScene {
  constructor(gltf, decals) {
    this.scene = new THREE.Scene();
    this.root = cloneSkinned(gltf.scene);
    this.root.traverse((o) => {
      if (!o.isMesh) return;
      o.frustumCulled = false;
      o.material = o.material.clone();
      o.material.envMapIntensity = 0.75;
      if (decals[o.material.name]) addDecal(o.material, decals[o.material.name]);
    });
    this.scene.add(this.root);
    this.scene.environment = env;
    const key = new THREE.DirectionalLight(0xfff3e0, 2.2); key.position.set(2, 6, 5);
    const fill = new THREE.DirectionalLight(0x9fb8ff, 0.6); fill.position.set(-5, 2, 3);
    const rim = new THREE.DirectionalLight(0xffd59a, 1.4); rim.position.set(0, 4, -6);
    this.scene.add(key, fill, rim, new THREE.HemisphereLight(0x8090a0, 0x101010, 0.5));

    this.mixer = new THREE.AnimationMixer(this.root);
    this.clips = Object.fromEntries(gltf.animations.map((a) => [a.name, a]));

    // Frame the closed crate at rest (the clips park the key and lock far away while they're hidden), from
    // slightly above like CS2, with room for the lid swinging open.
    const idle = this.clips.idle || this.clips.fall;
    const a = this.mixer.clipAction(idle);
    a.play();
    this.mixer.setTime(idle === this.clips.idle ? 0 : idle.duration);
    const box = this.bounds();
    a.stop();
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    center.y += size.y * 0.32;
    this.center = center;
    this.radius = Math.max(size.x, size.y, size.z) * 0.92;
    this.camera = new THREE.PerspectiveCamera(32, 1, this.radius * 0.05, this.radius * 60);

    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set(center.x, box.min.y + 0.002, center.z);
    shadow.scale.set(size.x * 1.5, size.z * 1.9, 1);
    this.scene.add(shadow);
  }

  // World-space bounds of the skinned crate in its current pose.
  bounds() {
    this.root.updateMatrixWorld(true);
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    this.root.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      const pos = o.geometry.attributes.position;
      // Every 7th vertex is plenty for framing.
      for (let i = 0; i < pos.count; i += 7) {
        v.fromBufferAttribute(pos, i);
        if (o.isSkinnedMesh) o.applyBoneTransform(i, v);
        box.expandByPoint(v.applyMatrix4(o.matrixWorld));
      }
    });
    return box;
  }

  mount(host) {
    const r = sharedRenderer();
    this.host = host;
    host.appendChild(r.domElement);
    const fit = () => {
      const w = host.clientWidth || 1, h = host.clientHeight || 1;
      r.setSize(w, h, false);
      r.domElement.style.width = w + 'px';
      r.domElement.style.height = h + 'px';
      this.camera.aspect = w / h;
      // Distance so the crate fits both ways, viewed from a little above and to the right of its front (the
      // crates face +X in the export, padlock on the right).
      const vfov = THREE.MathUtils.degToRad(this.camera.fov);
      const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
      const d = this.radius / Math.sin(Math.min(vfov, hfov) / 2);
      const dir = new THREE.Vector3(1, 0.4, -0.35).normalize();
      this.camera.position.copy(this.center).addScaledVector(dir, d);
      this.camera.lookAt(this.center);
      this.camera.updateProjectionMatrix();
    };
    fit();
    this.resize = new ResizeObserver(fit);
    this.resize.observe(host);
    let last = performance.now();
    const loop = (now) => {
      if (!this.host) return;
      // The first frame's timestamp can be older than `last`; a negative step would end a play-once clip at 0.
      const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
      last = now;
      this.mixer.update(dt * (this.speed || 1));
      if (this.waiting && this.waiting.action.time >= this.waiting.clip.duration - 1e-3) { const w = this.waiting; this.waiting = null; w.resolve(); }
      r.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(loop);
    };
    // Drawing starts next frame, once the caller has started a clip (so the crate never shows in its bind pose).
    this.raf = requestAnimationFrame(loop);
  }

  // Plays one of the crate's clips once; resolves when it ends (or on skip()).
  play(name, speed = 1) {
    const clip = this.clips[name];
    if (!clip) return Promise.resolve();
    this.mixer.stopAllAction();
    const action = this.mixer.clipAction(clip);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.reset().play();
    this.speed = speed;
    return new Promise((resolve) => { this.waiting = { action, clip, resolve }; });
  }

  skip() {
    const w = this.waiting;
    this.waiting = null;
    w?.resolve();
  }

  unmount() {
    this.skip();
    cancelAnimationFrame(this.raf);
    this.resize?.disconnect();
    if (this.host && renderer.domElement.parentNode === this.host) this.host.removeChild(renderer.domElement);
    this.host = null;
  }
}

// The container's 3D crate ready to play, or null (no CS2 install, or a container without one: capsules, older
// souvenir packages). `id` is the container's item id ("crate-4001").
export async function loadCrate(id) {
  const def = String(id).replace(/^crate-/, '');
  if (!/^\d+$/.test(def) || !(await cs2Status()).available) return null;
  const info = await cs2Crate(def);
  if (!info?.model) return null;
  const [gltf, decals] = await Promise.all([
    loadGltf(info.model),
    Promise.all(Object.entries(info.decals || {}).map(async ([m, url]) => [m, await texture(url, { srgb: true })])),
  ]);
  if (!gltf.animations.some((a) => a.name === 'fall')) return null;
  sharedRenderer();
  return new CrateScene(gltf, Object.fromEntries(decals));
}
