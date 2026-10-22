// A playable CS2 map in three.js. World surfaces use CS2's baked lighting: the irradiance lightmap (second UV set) plus
// the sun drawn live and masked by CS2's baked sun shadows (lightmap alpha). Props (CS2 lights those with probes we
// can't read) get a sky/ground ambient plus the sun with a shadow map rendered once when the map loads. The exported
// world is thousands of small meshes, so it's merged by material in large cells to keep draw calls down.
// Coordinates: the scene stays in the exporter's glTF metres (Y up); gameplay runs in game units.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const IN = 0.0254;
// Game (x, y, z; inches, Z up) <-> glTF scene (metres, Y up).
export const toGl = (p, out = new THREE.Vector3()) => out.set(p[1] * IN, p[2] * IN, p[0] * IN);
export const fromGl = (v) => [v.z / IN, v.x / IN, v.y / IN];
// Unit direction (game) for pitch/yaw in degrees (Source: positive pitch looks down).
export function angleDir(pitch, yaw) {
  const p = (pitch * Math.PI) / 180, y = (yaw * Math.PI) / 180;
  return [Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), -Math.sin(p)];
}
export const dirGl = (d, out = new THREE.Vector3()) => out.set(d[1], d[2], d[0]);

// Materials that never draw in game (tool textures), or need CS2 shaders we don't have.
const HIDDEN = /toolsskybox|tools\/|toolsnodraw|nodraw|toolsclip|toolsplayerclip|toolsinvisible|toolstrigger|skybox/i;
const HIDDEN_SHADERS = /csgo_effects|sky\.vfx|csgo_water|spritecard/i;
// Shaders whose second UV set is the lightmap UV (world geometry and overlays).
const LIGHTMAPPED = /lightmappedgeneric|static_overlay|environment_blend|csgo_environment\.vfx/i;
const CELL = 3000; // merge cell size, game units

// The lightmap file (RGBA8: sRGB irradiance / irrMax, alpha = sun visibility) as a texture on UV set 1.
async function loadLightmap(url, size) {
  const buf = await fetch(url).then((r) => { if (!r.ok) throw new Error('lightmap ' + r.status); return r.arrayBuffer(); });
  const tex = new THREE.DataTexture(new Uint8Array(buf), size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace; // the GPU decodes RGB; alpha stays linear
  tex.flipY = false;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.channel = 1;
  tex.needsUpdate = true;
  return tex;
}

// Lightmapped surfaces: the sun's direct light is multiplied by the baked sun visibility in the lightmap's alpha.
function lightmapped(m, lightMap, irrMax) {
  m.lightMap = lightMap;
  m.lightMapIntensity = irrMax * Math.PI;
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_begin>',
      'float cs2SunMask = texture2D( lightMap, vLightMapUv ).a;\n' + THREE.ShaderChunk.lights_fragment_begin.replace(
        'getDirectionalLightInfo( directionalLight, directLight );',
        'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= cs2SunMask;'));
  };
  m.customProgramCacheKey = () => 'cs2lm';
}

// Everything else: a sky/ground ambient (by normal) and the shadow-mapped sun.
export function ambientLit(m, ambient) {
  m.onBeforeCompile = (sh) => {
    sh.uniforms.cs2Sky = ambient.sky;
    sh.uniforms.cs2Ground = ambient.ground;
    sh.fragmentShader = 'uniform vec3 cs2Sky;\nuniform vec3 cs2Ground;\n' + sh.fragmentShader
      .replace('#include <lights_fragment_maps>', '#include <lights_fragment_maps>\n\t{ vec3 wn = inverseTransformDirection( geometryNormal, viewMatrix );\n\tirradiance += mix( cs2Ground, cs2Sky, wn.y * 0.5 + 0.5 ); }');
  };
  m.customProgramCacheKey = () => 'cs2amb';
}

// An attribute's values as a tightly packed Float32Array (plain float arrays are used as they are). Cached: the
// exporter's aggregate fragments share one big vertex buffer between many meshes.
const packed = new WeakMap();
function floats(attr) {
  if (!attr) return null;
  if (packed.has(attr)) return packed.get(attr);
  const n = attr.count, k = attr.itemSize;
  const inter = attr.isInterleavedBufferAttribute;
  const src = inter ? attr.data.array : attr.array;
  let out = src;
  if (inter || !(src instanceof Float32Array)) {
    const stride = inter ? attr.data.stride : k, off = inter ? attr.offset : 0;
    const s = !attr.normalized ? 1 : src instanceof Int8Array ? 127 : src instanceof Uint8Array ? 255 : src instanceof Int16Array ? 32767 : src instanceof Uint16Array ? 65535 : 1;
    const min = attr.normalized && (src instanceof Int8Array || src instanceof Int16Array) ? -1 : -Infinity;
    out = new Float32Array(n * k);
    for (let i = 0; i < n; i++) for (let c = 0; c < k; c++) out[i * k + c] = Math.max(min, src[i * stride + off + c] / s);
  }
  packed.set(attr, out);
  return out;
}

// Merges meshes (placed by `matrix`) into one geometry with position, normal, uv and optionally uv1 (lightmap) and
// tangent. Only the vertices each mesh's triangles use are copied (fragments index into shared buffers).
let remap = new Int32Array(0), mark = new Int32Array(0), gen = 0;
function mergeMeshes(list, { lm, tangents }) {
  let nv = 0, ni = 0;
  for (const { geo } of list) {
    const c = geo.index ? geo.index.count : geo.attributes.position.count;
    ni += c; nv += Math.min(c, geo.attributes.position.count);
  }
  let pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  let uv1 = lm ? new Float32Array(nv * 2) : null, tan = tangents ? new Float32Array(nv * 4) : null;
  const idx = new Uint32Array(ni);
  const nm = new THREE.Matrix3();
  let vo = 0, io = 0;
  for (const { geo, matrix } of list) {
    const a = geo.attributes, count = a.position.count;
    const P = floats(a.position), N = floats(a.normal), U = floats(a.uv), U1 = uv1 && floats(a.uv1), T = tan && floats(a.tangent);
    const e = matrix.elements, m = nm.getNormalMatrix(matrix).elements;
    if (mark.length < count) { mark = new Int32Array(count * 2); remap = new Int32Array(count * 2); gen = 0; }
    gen++;
    const ix = geo.index ? geo.index.array : null, ic = geo.index ? geo.index.count : count;
    const flip = matrix.determinant() < 0; // a mirrored transform flips the winding
    for (let i = 0; i < ic; i++) {
      const j = flip && i % 3 ? (i % 3 === 1 ? i + 1 : i - 1) : i;
      const v = ix ? ix[j] : j;
      if (mark[v] !== gen) {
        mark[v] = gen;
        remap[v] = vo;
        const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2], o = vo * 3;
        pos[o] = e[0] * x + e[4] * y + e[8] * z + e[12];
        pos[o + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
        pos[o + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
        if (N) {
          const nx = N[v * 3], ny = N[v * 3 + 1], nz = N[v * 3 + 2];
          const X = m[0] * nx + m[3] * ny + m[6] * nz, Y = m[1] * nx + m[4] * ny + m[7] * nz, Z = m[2] * nx + m[5] * ny + m[8] * nz;
          const l = Math.hypot(X, Y, Z) || 1;
          nor[o] = X / l; nor[o + 1] = Y / l; nor[o + 2] = Z / l;
        }
        if (U) { uv[vo * 2] = U[v * 2]; uv[vo * 2 + 1] = U[v * 2 + 1]; }
        if (U1) { uv1[vo * 2] = U1[v * 2]; uv1[vo * 2 + 1] = U1[v * 2 + 1]; }
        if (tan) {
          const t = vo * 4;
          if (T) {
            const tx = T[v * 4], ty = T[v * 4 + 1], tz = T[v * 4 + 2];
            const X = e[0] * tx + e[4] * ty + e[8] * tz, Y = e[1] * tx + e[5] * ty + e[9] * tz, Z = e[2] * tx + e[6] * ty + e[10] * tz;
            const l = Math.hypot(X, Y, Z) || 1;
            tan[t] = X / l; tan[t + 1] = Y / l; tan[t + 2] = Z / l; tan[t + 3] = T[v * 4 + 3];
          } else { tan[t] = 1; tan[t + 3] = 1; }
        }
        vo++;
      }
      idx[io + i] = remap[v];
    }
    io += ic;
  }
  // Trim to the vertices actually used.
  pos = pos.slice(0, vo * 3); nor = nor.slice(0, vo * 3); uv = uv.slice(0, vo * 2);
  if (uv1) uv1 = uv1.slice(0, vo * 2);
  if (tan) tan = tan.slice(0, vo * 4);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (uv1) g.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
  if (tan) g.setAttribute('tangent', new THREE.BufferAttribute(tan, 4));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

// Rough centre of the triangles a mesh draws (its bounds cover the whole shared buffer).
function fragmentCenter(geo, out) {
  const P = floats(geo.attributes.position), ix = geo.index?.array, c = geo.index ? geo.index.count : geo.attributes.position.count;
  const step = Math.max(1, Math.floor(c / 64));
  let n = 0;
  out.set(0, 0, 0);
  for (let i = 0; i < c; i += step) { const v = ix ? ix[i] : i; out.x += P[v * 3]; out.y += P[v * 3 + 1]; out.z += P[v * 3 + 2]; n++; }
  return out.divideScalar(Math.max(1, n));
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// Loads a map exported by CS2Service.playMap: { scene, sun, sunDir, ambient, bounds, dispose }.
export async function loadWorld(map, renderer, { onProgress = () => {} } = {}) {
  const info = map.info;
  onProgress('Loading the map…');
  const [gltf, lightMap, sky] = await Promise.all([
    new GLTFLoader().loadAsync(map.world, (e) => e.total && onProgress(`Loading the map… ${Math.round((e.loaded / e.total) * 100)}%`)),
    map.lightmap ? loadLightmap(map.lightmap, info.lightmap.size) : null,
    map.sky ? new THREE.TextureLoader().loadAsync(map.sky) : null,
  ]);
  onProgress('Building the world…');
  await tick();
  gltf.scene.updateMatrixWorld(true);
  const ambient = { sky: { value: new THREE.Color(0.42, 0.47, 0.56) }, ground: { value: new THREE.Color(0.46, 0.39, 0.31) } };
  const variants = new Map(), groups = new Map(), originals = new Set();
  const center = new THREE.Vector3();
  gltf.scene.traverse((o) => {
    if (!o.isMesh || Array.isArray(o.material)) return;
    const m = o.material;
    const vm = m.userData?.vmat || {};
    if (HIDDEN.test(m.name || '') || HIDDEN.test(vm.Name || '') || HIDDEN_SHADERS.test(vm.ShaderName || '')) return;
    const lm = !!(lightMap && o.geometry.attributes.uv1 && LIGHTMAPPED.test(vm.ShaderName || ''));
    const key = m.uuid + (lm ? ':lm' : ':amb');
    if (!variants.has(key)) {
      const v = m.clone();
      v.vertexColors = false; // CS2 uses vertex colours for layer blending, not tint
      v.envMap = null;
      if (v.transparent) { v.depthWrite = false; v.polygonOffset = true; v.polygonOffsetFactor = -2; v.polygonOffsetUnits = -4; }
      if (lm) lightmapped(v, lightMap, info.lightmap.irrMax); else ambientLit(v, ambient);
      v.userData.lm = lm;
      variants.set(key, v);
      originals.add(m);
    }
    fragmentCenter(o.geometry, center).applyMatrix4(o.matrixWorld);
    const cell = `${Math.floor(center.x / (CELL * IN))},${Math.floor(center.z / (CELL * IN))}`;
    const gk = key + '|' + cell;
    if (!groups.has(gk)) groups.set(gk, { material: variants.get(key), list: [] });
    groups.get(gk).list.push({ geo: o.geometry, matrix: o.matrixWorld.clone() });
  });
  const world = new THREE.Group();
  let n = 0;
  for (const { material, list } of groups.values()) {
    const mesh = new THREE.Mesh(mergeMeshes(list, { lm: material.userData.lm, tangents: !!material.normalMap }), material);
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = !material.transparent;
    mesh.receiveShadow = !material.userData.lm;
    world.add(mesh);
    if (++n % 200 === 0) { onProgress(`Building the world… ${Math.round((n / groups.size) * 100)}%`); await tick(); }
  }
  gltf.scene.traverse((o) => o.geometry?.dispose());
  for (const m of originals) m.dispose();

  const scene = new THREE.Scene();
  scene.add(world);
  const bounds = new THREE.Box3().setFromObject(world);
  // The sun: light_environment angles give the direction the light travels.
  const s = info.sun || { angles: [50, 45, 0], color: [255, 240, 220], brightness: 2 };
  const travel = dirGl(angleDir(s.angles[0], s.angles[1]));
  const sun = new THREE.DirectionalLight(new THREE.Color(s.color[0] / 255, s.color[1] / 255, s.color[2] / 255), s.brightness * Math.PI);
  // One static shadow map over the whole map, rendered once (the world doesn't move).
  const c = bounds.getCenter(new THREE.Vector3()), r = bounds.getSize(new THREE.Vector3()).length() / 2;
  sun.position.copy(c).addScaledVector(travel, -r - 10);
  sun.target.position.copy(c);
  sun.castShadow = true;
  const cam = sun.shadow.camera;
  cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r; cam.near = 1; cam.far = 2 * r + 20;
  cam.updateProjectionMatrix();
  const max = renderer.capabilities.maxTextureSize;
  sun.shadow.mapSize.set(Math.min(4096, max), Math.min(4096, max));
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);
  if (sky) {
    sky.mapping = THREE.EquirectangularReflectionMapping;
    sky.colorSpace = THREE.SRGBColorSpace;
    scene.background = sky;
  } else scene.background = new THREE.Color(0x9cc3e8);

  return {
    scene, world, sun, sky, ambient, bounds,
    sunDir: [-travel.z, -travel.x, -travel.y], // game-space direction towards the sun
    drawCalls: world.children.length,
    dispose() {
      for (const v of variants.values()) {
        for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) v[k]?.dispose();
        v.dispose();
      }
      world.traverse((o) => o.geometry?.dispose());
      lightMap?.dispose();
      sky?.dispose();
      sun.shadow.map?.dispose();
    },
  };
}
