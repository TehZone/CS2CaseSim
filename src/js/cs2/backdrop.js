// Inspect backdrops: CS2's own "vanity" scenes (the 3D maps behind the main menu and item inspect), extracted from
// the player's install. The scene is placed so CS2's item spot sits where the inspect shows the weapon, turned so
// CS2's inspect camera looks the same way as ours, and drawn blurred like the game's depth of field.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { cs2Vanity } from './api.js';

const IN = 0.0254; // the exporter writes game inches as metres
const DEG = Math.PI / 180;
// Game coordinates (x, y, z, Z up) -> exported glTF coordinates (y, z, x) in metres.
const toGltf = ([x, y, z]) => new THREE.Vector3(y * IN, z * IN, x * IN);
// Direction for game angles [pitch, yaw, roll] (positive pitch looks down), in glTF axes.
function dirOf([pitch, yaw]) {
  const p = pitch * DEG, y = yaw * DEG;
  return new THREE.Vector3(Math.cos(p) * Math.sin(y), -Math.sin(p), Math.cos(p) * Math.cos(y));
}

const loaded = new Map(); // id -> Promise<{ world, info }>
function loadScene(id) {
  if (!loaded.has(id)) {
    const p = (async () => {
      const { glb, info } = await cs2Vanity(id);
      const gltf = await new GLTFLoader().loadAsync(glb);
      const world = gltf.scene;
      world.traverse((o) => {
        if (o.isLight) o.visible = false; // the exported sun is in physical units; we light the scene ourselves
        if (o.isMesh && [].concat(o.material || []).some((m) => /skybox|toolsskybox|nodraw/i.test(m.name || ''))) o.visible = false; // 3D-skybox cards need CS2's sky shader
        if (o.isMesh) {
          o.castShadow = false; o.receiveShadow = false;
          for (const m of [].concat(o.material || [])) {
            if (m.transparent && m.alphaTest === 0 && m.map) { m.alphaTest = 0.4; m.transparent = false; } // foliage cards
            m.envMapIntensity = 0.6;
          }
        }
      });
      return { world, info };
    })();
    loaded.set(id, p);
    p.catch(() => loaded.delete(id));
  }
  return loaded.get(id);
}

// Builds a backdrop for the inspect view. unitScale = inspect units per glTF metre (from the weapon model).
export async function buildBackdrop(id) {
  const { world, info } = await loadScene(id);
  if (!info.item) throw new Error('This backdrop has no item spot');
  const cams = info.cameras || {};
  // CS2 views weapons from cam_0..cam_8 (closer to further), all looking the same way at the item spot.
  const camInfo = cams.cam_0 || cams.cam_melee || cams.cam_default || Object.values(cams)[0];
  const item = toGltf(info.item.origin);
  const view = camInfo ? item.clone().sub(toGltf(camInfo.origin)) : dirOf([0, (info.item.angles?.[1] || 0) - 90]);
  view.y = 0;
  view.normalize();
  const turn = Math.PI - Math.atan2(view.x, view.z); // rotates CS2's view direction onto -Z (our camera's)

  const outer = new THREE.Group();
  const inner = new THREE.Group();
  inner.position.copy(item).multiplyScalar(-1);
  inner.add(world);
  outer.add(inner);
  outer.rotation.y = turn;

  const scene = new THREE.Scene();
  scene.add(outer);
  // Lighting for the scene itself (its baked lightmaps don't come through the export): the map's sun and sky.
  const sunInfo = info.sun || { angles: [50, 45, 0], color: [255, 240, 220], brightness: 2 };
  const sunColor = new THREE.Color(sunInfo.color[0] / 255, sunInfo.color[1] / 255, sunInfo.color[2] / 255);
  const sunDir = dirOf(sunInfo.angles).applyAxisAngle(new THREE.Vector3(0, 1, 0), turn); // the way the light travels
  const sun = new THREE.DirectionalLight(sunColor, Math.min(4, 1.2 + sunInfo.brightness * 0.6));
  sun.position.copy(sunDir).multiplyScalar(-10);
  scene.add(sun, sun.target);
  const night = /night/i.test(id);
  // Baked bounce light doesn't come through the export, so undersides (awnings, arches) get a soft fill instead.
  scene.add(new THREE.HemisphereLight(night ? 0x5a6f9a : 0xc8dcff, night ? 0x2a2733 : 0xa08b70, night ? 0.8 : 1.4));
  scene.add(new THREE.AmbientLight(night ? 0x8090c0 : 0xfff2e0, night ? 0.35 : 0.55));
  scene.background = new THREE.Color(night ? 0x0d1424 : 0x9cc3e8);

  return {
    id, name: info.name, scene, outer, sun: { dir: sunDir, color: sunColor, intensity: sun.intensity },
    // Scale the scene to the inspect model (units per metre) so CS2's distances match the weapon.
    setScale(k) { outer.scale.setScalar(k); },
  };
}

// ---- blurred background (CS2's inspect depth of field) -------------------------------------------------
const quadGeo = new THREE.PlaneGeometry(2, 2);
const vert = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
const blurFrag = `
  uniform sampler2D tex; uniform vec2 dir; varying vec2 vUv;
  void main() {
    vec4 c = texture2D(tex, vUv) * 0.2270270270;
    c += texture2D(tex, vUv + dir * 1.3846153846) * 0.3162162162;
    c += texture2D(tex, vUv - dir * 1.3846153846) * 0.3162162162;
    c += texture2D(tex, vUv + dir * 3.2307692308) * 0.0702702703;
    c += texture2D(tex, vUv - dir * 3.2307692308) * 0.0702702703;
    gl_FragColor = c;
  }`;

export class BlurredBackdrop {
  constructor() {
    const opts = { type: THREE.HalfFloatType, depthBuffer: true };
    this.a = new THREE.WebGLRenderTarget(4, 4, opts);
    this.b = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false });
    this.blur = new THREE.ShaderMaterial({ uniforms: { tex: { value: null }, dir: { value: new THREE.Vector2() } }, vertexShader: vert, fragmentShader: blurFrag, depthTest: false, depthWrite: false });
    this.quadScene = new THREE.Scene();
    this.quad = new THREE.Mesh(quadGeo, this.blur);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
    this.orth = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    // The finished background: a fullscreen quad drawn with tone mapping like the rest of the frame.
    this.showMat = new THREE.MeshBasicMaterial({ map: this.a.texture, depthTest: false, depthWrite: false });
    this.showScene = new THREE.Scene();
    const show = new THREE.Mesh(quadGeo, this.showMat);
    show.frustumCulled = false;
    this.showScene.add(show);
  }

  setSize(w, h) {
    // Rendered at half size: it is blurred anyway, and it keeps the inspect smooth.
    const bw = Math.max(4, Math.round(w / 2)), bh = Math.max(4, Math.round(h / 2));
    this.a.setSize(bw, bh);
    this.b.setSize(bw, bh);
    this.texel = new THREE.Vector2(1 / bw, 1 / bh);
  }

  // Renders the backdrop from `camera`, blurs it `strength` times, and draws it as the frame's background.
  render(renderer, backdrop, camera, strength = 3) {
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.a);
    renderer.clear();
    renderer.render(backdrop.scene, camera);
    for (let i = 0; i < strength; i++) {
      const spread = 1 + i * 0.75;
      this.quad.material = this.blur;
      this.blur.uniforms.tex.value = this.a.texture;
      this.blur.uniforms.dir.value.set(this.texel.x * spread, 0);
      renderer.setRenderTarget(this.b);
      renderer.render(this.quadScene, this.orth);
      this.blur.uniforms.tex.value = this.b.texture;
      this.blur.uniforms.dir.value.set(0, this.texel.y * spread);
      renderer.setRenderTarget(this.a);
      renderer.render(this.quadScene, this.orth);
    }
    renderer.setRenderTarget(prev);
    renderer.render(this.showScene, this.orth);
  }

  dispose() { this.a.dispose(); this.b.dispose(); this.blur.dispose(); this.showMat.dispose(); }
}

// A reflection/lighting environment for the weapon, captured from the backdrop at the item spot.
export function backdropEnvironment(renderer, backdrop) {
  const rt = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType });
  const cube = new THREE.CubeCamera(0.01, 2000, rt);
  backdrop.scene.add(cube);
  cube.update(renderer, backdrop.scene);
  backdrop.scene.remove(cube);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromCubemap(rt.texture).texture;
  pmrem.dispose();
  rt.dispose();
  return env;
}
