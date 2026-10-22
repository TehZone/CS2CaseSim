// Renders an item on its real CS2 model: CS2's own (decompiled) skin compositing shader is run over the
// model's UV space to bake the colour and roughness/metalness textures for the item's exact float and seed.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';
import { imgUrl, loadImage } from '../util.js';
import { UniformRandomStream } from './rng.js';
import { cs2Prepare, cs2GloveClip } from './api.js';
import { gloveMaterials } from './glove.js';
import { loadGltf as loadRig, rebind, bonesByName, forearmTwist } from './rig.js';
import { loadSource, texture, whiteTex } from './textures.js';
import { stickerSurface, contentBox } from './sticker.js';
import { D } from '../data.js';

const BAKE_SIZE = 2048;

const WRAP = { 0: THREE.RepeatWrapping, 1: THREE.MirroredRepeatWrapping, 2: THREE.ClampToEdgeWrapping, 3: THREE.ClampToEdgeWrapping, 4: THREE.ClampToEdgeWrapping };

// ---------------------------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------------------------
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const round2 = (x) => Math.floor((x + 0.005) * 100) / 100;

// Pattern/wear/grunge UV transform, exactly as the shader's material expressions compute it.
function xform(rotation, scale, offset, sizeScale) {
  const v0 = round2(rotation);
  const v1 = round2(scale * sizeScale);
  const v3 = (v0 * Math.PI) / 180;
  const v4 = Math.cos(v3), v5 = Math.sin(v3);
  const v6 = 0.5 / (v1 !== 0 ? v1 : 1);
  const v7 = Math.cos(-v3), v8 = Math.sin(-v3);
  const v9 = v6 * v7 - v6 * v8;
  const v10 = globalThis.__cs2Debug?.xformFix ? v6 * v8 + v6 * v7 : v9 * v8 + v6 * v7;
  const ox = round2(offset[0]), oy = round2(offset[1]);
  return [
    new THREE.Vector4(v4 * v1, -v5 * v1, 0, v1 * v4 * v9 + v1 * -v5 * v10 + (ox - 0.5)),
    new THREE.Vector4(v5 * v1, v4 * v1, 0, v1 * v5 * v9 + v1 * v4 * v10 + (oy - 0.5)),
  ];
}

// Seeded rolls of the composite material's random variables (pattern placement, wear, grunge).
function rollInstance(kit, seed) {
  const rng = new UniformRandomStream(seed);
  const out = {};
  let rolls = kit.rolls || [];
  if (globalThis.__cs2Debug?.rotFirst) {
    const i = rolls.findIndex((r) => r.name === 'g_flPatternTexCoordRotation');
    const j = rolls.findIndex((r) => r.name === 'g_vPatternTexCoordOffset');
    if (i > j && j >= 0) { rolls = [...rolls]; [rolls[i], rolls[j]] = [rolls[j], rolls[i]]; }
  }
  for (const r of rolls) {
    out[r.alias + '.' + r.name] = r.comps === 1
      ? rng.randomFloat(r.min ?? 0, r.max ?? 0)
      : [rng.randomFloat(r.min?.[0] ?? 0, r.max?.[0] ?? 0), rng.randomFloat(r.min?.[1] ?? 0, r.max?.[1] ?? 0)];
  }
  return out;
}

const WEAPON_VALUE = {
  g_flUvScale1: (i) => i.uvScale,
  g_flWeaponLength1: (i) => i.weaponLength,
  F_SEPARATE_CHANNEL_INPUTS: (i) => i.separate,
};

// Resolve one pass's variables to plain values for this item.
function resolveVars(vars, inputs, rolled, item) {
  const out = {};
  for (const [k, v] of Object.entries(vars || {})) {
    if (!v) continue;
    if (v.kind === 'weapon') {
      if (WEAPON_VALUE[k]) out[k] = WEAPON_VALUE[k](inputs);
      else out[k] = inputs.textures[v.name === 'g_tRoughness' ? 'g_tMetalness' : v.name] ?? inputs.textures[k] ?? null;
    } else if (v.kind === 'instance') {
      if (v.name === 'g_flWearAmount') out[k] = item.fl ?? 0;
      else if (v.name === 'g_nRandomSeed') out[k] = item.sd ?? 0;
      else out[k] = rolled[v.alias + '.' + v.name] ?? v.base?.value;
    } else out[k] = v.value;
  }
  return out;
}

function defaults(style) {
  return {
    g_fWearSoftness: 0, g_flColorBrightness: 1, g_flPaintRoughness: style === 4 || style === 5 ? 0.2 : 0.6,
    g_flPearlescentScale: 0, g_flPaintMetalness: 0, g_nColorAdjustmentMode: 1, g_bPearlescentOnMetallicOnly: 0,
    g_vPaintRoughness: [0.6, 0.6, 0.6, 0.6], g_vPaintMetalness: [0, 0, 0, 0], g_vPaintDurability: [0, 0, 0, 0],
    g_vColor0: [0.5, 0.5, 0.5], g_vColor1: [0.59, 0.59, 0.59], g_vColor2: [0.38, 0.38, 0.38], g_vColor3: [0.42, 0.42, 0.42],
    g_vSprayBlend: [1, 1], g_bBiasSpray: 0, g_fHalftoneCavityCutoff: 1, g_vHalftonePatternLevels: [0, 0.5, 0],
    g_vHalftoneThresholds: [0, 0], g_bHalftoneInCavity: 1, g_flHalftoneRotationOffsetA: 0, g_flHalftoneRotationOffsetB: 4,
    g_flHalftoneRotationOffsetC: -4, g_flCaseHardeningPatternInfluence: 0.5, g_flCaseHardeningGeometricInfluence: 1,
    g_flCaseHardeningRampOffset: 0, g_vCaseHardening: [0, 0, 0, 0], g_flPatinaAgeStart: 0, g_flPatinaColorize: 1,
    g_flPatternTexCoordScale: 1, g_flPatternTexCoordRotation: 0, g_vPatternTexCoordOffset: [0, 0],
    g_flWearTexCoordScale: 1, g_flWearTexCoordRotation: 0, g_vWearTexCoordOffset: [0, 0],
    g_flGrungeTexCoordScale: 1, g_flGrungeTexCoordRotation: 0, g_vGrungeTexCoordOffset: [0, 0],
    g_bIgnoreWeaponSizeScale: 0,
  };
}

// Values for the shader's _Globals_ struct members (some are material expressions of other params).
function globalValue(name, p, type) {
  const v = globalValueRaw(name, p);
  // Coerce to the declared GLSL type so a missing parameter never breaks the upload.
  const size = { vec2: 2, vec3: 3, vec4: 4 }[type];
  if (!size) return typeof v === 'number' ? v : Array.isArray(v) ? v[0] ?? 0 : (v?.x ?? 0);
  const arr = v?.isVector2 || v?.isVector3 || v?.isVector4 ? v.toArray() : Array.isArray(v) ? v : [typeof v === 'number' ? v : 0];
  const a = [0, 1, 2, 3].map((i) => arr[i] ?? 0);
  return size === 2 ? new THREE.Vector2(a[0], a[1]) : size === 3 ? new THREE.Vector3(a[0], a[1], a[2]) : new THREE.Vector4(...a);
}

function globalValueRaw(name, p) {
  const v3 = (a) => new THREE.Vector3(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0);
  const v4 = (a) => new THREE.Vector4(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0);
  const levels = (x, y, z) => new THREE.Vector3(-x, -1.4427 * Math.log(Math.max(0.0001, 1 - y)), 2 - z);
  switch (name) {
    case 'g_vColor0': case 'g_vColor1': case 'g_vColor2': case 'g_vColor3': return v3(p[name].map(srgbToLinear));
    case 'g_vPaintDurability': return v4(p.g_vPaintDurability.map((x) => 1 - x));
    case 'g_vPaintAlbedoLevels': return levels(-0.045, 0.6, 1);
    case 'g_vMetallicPaintAlbedoLevels': return levels(-0.08, 0.6, 1);
    case 'g_vAlbedoLevels': return levels(-0.045, 0.4, 1.15);
    case 'g_vMetallicAlbedoLevels': return levels(-0.45, 0.4, 1.08);
    case 'g_vDarkMetallicAlbedoLevels': return levels(-0.1, 0.4, 1.08);
    case 'g_vHalftonePatternLevels': { const h = p.g_vHalftonePatternLevels; return levels(h[0], h[1], h[2] ?? 0); }
    case 'g_vSprayBiasBlend': return new THREE.Vector3(p.g_bBiasSpray ? 1 : 0, p.g_vSprayBlend[0] ?? 1, p.g_vSprayBlend[1] ?? 1);
    case 'bSpraypaintHalftone': return p.F_SPRAYPAINT_HALFTONE ? 1 : 0;
    case 'g_bRoughnessPerColor': return p.F_ROUGHNESS_PER_COLOR ? 1 : 0;
    case 'g_fColorBoostFactor': return 63;
  }
  const halftone = name.match(/^g_vPatternTexCoordXformHalftone([ABC])([01])$/);
  if (halftone) return p.$halftone[halftone[1]][+halftone[2]];
  const val = p[name];
  if (val?.isVector2 || val?.isVector3 || val?.isVector4) return val;
  if (Array.isArray(val)) return val.length >= 4 ? v4(val) : val.length === 3 ? v3(val) : new THREE.Vector2(val[0], val[1]);
  return typeof val === 'number' ? val : 0;
}

// ---------------------------------------------------------------------------------------------
// Bake
// ---------------------------------------------------------------------------------------------
const BAKE_VS = `
precision highp float;
in vec3 position;
uniform vec4 uPat0, uPat1, uWear0, uWear1, uGrunge0, uGrunge1;
out highp vec4 input_1;
out highp vec4 input_2;
void main() {
  vec2 uv = position.xy * 0.5 + 0.5;
  input_1 = vec4(uv, dot(uv, uPat0.xy) + uPat0.w, dot(uv, uPat1.xy) + uPat1.w);
  input_2 = vec4(dot(uv, uWear0.xy) + uWear0.w, dot(uv, uWear1.xy) + uWear1.w, dot(uv, uGrunge0.xy) + uGrunge0.w, dot(uv, uGrunge1.xy) + uGrunge1.w);
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const HELPERS = `
float saturate(float x) { return clamp(x, 0.0, 1.0); }
vec2 saturate(vec2 x) { return clamp(x, 0.0, 1.0); }
vec3 saturate(vec3 x) { return clamp(x, 0.0, 1.0); }
vec4 saturate(vec4 x) { return clamp(x, 0.0, 1.0); }
vec3 cs2LinearToSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }
`;

// Turn the decompiled GLSL ES 3.00 into a three.js RawShaderMaterial fragment shader.
function adaptFragment(src) {
  let s = src.replace(/^\s*#version.*$/m, '').replace(/precision mediump float;/, 'precision highp float;');
  s = s.replace(/(precision highp int;)/, `$1\n${HELPERS}`);
  s = s.replace(/void main\(\)/, 'void cs2_main()');
  const probe = globalThis.__cs2Debug?.probe;
  if (probe) {
    // Debug: output the first sample of the given texture straight away.
    const re = new RegExp('(highp vec4 (_\\d+) = texture\\(' + probe + '_[^;]*;)');
    const expr = globalThis.__cs2Debug?.expr;
    s = s.replace(re, (m, line, v) => expr
      ? `output_0 = vec4(${expr}, 1.0); return;\n    ${line}`
      : `${line}\n    output_0 = vec4(${v}.xyz, 1.0); return;`);
  }
  // The colour pass target is sRGB (hardware encodes); the roughness pass undoes the shader's
  // sRGB->linear step so the raw values land in G (roughness) and B (metalness) for three.js.
  s += `
void main() {
  cs2_main();
  if (_Globals_.bRoughnessMode != 0) {
    vec3 raw = cs2LinearToSrgb(output_0.xyz);
    output_0 = vec4(1.0, raw.x, raw.y, raw.z); // alpha = paint coverage (drives pearlescence)
  } else {
    output_0 = vec4(output_0.rgb, 1.0);
  }
}`;
  return s;
}

function parseGlobals(src) {
  const struct = src.match(/struct (_\d+)\s*\{([^}]*)\};\s*\n\s*uniform \1 _Globals_;/);
  if (!struct) return [];
  return [...struct[2].matchAll(/(?:highp |mediump |lowp )?(\w+)\s+(\w+);/g)].map((m) => ({ type: m[1], name: m[2] }));
}
const samplerNames = (src) => [...src.matchAll(/uniform highp sampler2D (\w+);/g)].map((m) => m[1]);

const SRGB_TEX = new Set(['g_tAmbientOcclusion', 'g_tColor', 'g_tGrunge', 'g_tCaseHardeningColorRamp', 'g_tOverlay', 'g_tPatinaAgeColorRamp']);

let bakeScene, bakeCam, bakeMesh;
function bakeQuad() {
  if (!bakeScene) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    bakeMesh = new THREE.Mesh(g);
    bakeMesh.frustumCulled = false;
    bakeScene = new THREE.Scene();
    bakeScene.add(bakeMesh);
    bakeCam = new THREE.Camera();
  }
  return bakeMesh;
}

async function bakeSkin(renderer, prep, item) {
  const { kit, inputs, shader } = prep;
  const rolled = rollInstance(kit, item.sd ?? 0);
  const resolved = resolveVars(kit.color, inputs, rolled, item);
  const style = resolved.F_PAINT_STYLE | 0;
  const p = { ...defaults(style), ...resolved };
  const dbg = globalThis.__cs2Debug || {};
  // The shader's variants for position-projected styles (spray, airbrush, all-masks, trilinear case
  // hardening) scale by weapon length; every other style scales by the model's UV density.
  const projected = style === 2 || style === 5 || p.F_USE_ALL_MASKS || p.F_CASE_HARDENING_TRILINEAR;
  const sizeMode = dbg.sizeMode || (projected ? 'len' : 'uv');
  const sizeScale = p.g_bIgnoreWeaponSizeScale ? 1 : sizeMode === 'uv' ? inputs.uvScale : sizeMode === 'one' ? 1 : inputs.weaponLength / 36;
  const [pat0, pat1] = xform(p.g_flPatternTexCoordRotation, p.g_flPatternTexCoordScale, p.g_vPatternTexCoordOffset, sizeScale);
  const [wear0, wear1] = xform(p.g_flWearTexCoordRotation, p.g_flWearTexCoordScale, p.g_vWearTexCoordOffset, sizeScale);
  const [gr0, gr1] = xform(p.g_flGrungeTexCoordRotation, p.g_flGrungeTexCoordScale, p.g_vGrungeTexCoordOffset, sizeScale);
  Object.assign(p, {
    g_vPatternTexCoordXform0: pat0, g_vPatternTexCoordXform1: pat1, g_vWearTexCoordXform0: wear0,
    g_vWearTexCoordXform1: wear1, g_vGrungeTexCoordXform0: gr0, g_vGrungeTexCoordXform1: gr1,
  });
  p.$halftone = {};
  for (const k of ['A', 'B', 'C']) p.$halftone[k] = xform(p.g_flPatternTexCoordRotation + p['g_flHalftoneRotationOffset' + k], p.g_flPatternTexCoordScale, p.g_vPatternTexCoordOffset, sizeScale);

  const src = shader.source;
  const patternSrgb = ![1, 2, 4, 5].includes(style) && !p.F_USE_ALL_MASKS;
  const uniforms = { uPat0: { value: pat0 }, uPat1: { value: pat1 }, uWear0: { value: wear0 }, uWear1: { value: wear1 }, uGrunge0: { value: gr0 }, uGrunge1: { value: gr1 } };
  const globals = {};
  for (const { name, type } of parseGlobals(src)) globals[name] = globalValue(name, p, type);
  uniforms._Globals_ = { value: globals };

  await Promise.all(samplerNames(src).map(async (u) => {
    const m = u.match(/^(g_t[A-Za-z0-9]+)_(.+)$/);
    const texName = m ? m[1] : u;
    const samp = m ? m[2] : '';
    const vpk = p[texName];
    const url = vpk && prep.textures[vpk];
    let wrapS = THREE.RepeatWrapping, wrapT = THREE.RepeatWrapping;
    if (/Clamp/.test(samp)) wrapS = wrapT = THREE.ClampToEdgeWrapping;
    else if (/dynamic/.test(samp)) {
      wrapS = WRAP[p.g_nPatternTextureHorizontalSampling | 0] ?? THREE.RepeatWrapping;
      wrapT = WRAP[p.g_nPatternTextureVerticalSampling | 0] ?? THREE.RepeatWrapping;
    }
    const srgb = SRGB_TEX.has(texName) || (texName === 'g_tPattern' && patternSrgb);
    uniforms[u] = { value: url ? await texture(url, { srgb, wrapS, wrapT }) : whiteTex() };
  }));

  const mat = new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: BAKE_VS, fragmentShader: adaptFragment(src), uniforms, depthTest: false, depthWrite: false });
  const mesh = bakeQuad();
  mesh.material = mat;

  const target = (srgb) => {
    const rt = new THREE.WebGLRenderTarget(BAKE_SIZE, BAKE_SIZE, {
      depthBuffer: false, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
      colorSpace: srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace,
    });
    rt.texture.anisotropy = 8;
    rt.texture.wrapS = rt.texture.wrapT = THREE.RepeatWrapping; // some parts use UVs outside 0..1
    return rt;
  };
  const colorRT = target(true), rmRT = target(false);
  const prev = renderer.getRenderTarget();
  try {
    globals.bRoughnessMode = 0;
    renderer.setRenderTarget(colorRT);
    renderer.render(bakeScene, bakeCam);
    globals.bRoughnessMode = 1;
    renderer.setRenderTarget(rmRT);
    renderer.render(bakeScene, bakeCam);
  } catch (e) {
    colorRT.dispose(); rmRT.dispose();
    throw e;
  } finally {
    renderer.setRenderTarget(prev);
    mat.dispose();
  }
  if (globalThis.__cs2Debug) globalThis.__cs2LastBake = { colorRT, rmRT, params: p, rolled, renderer };
  return { colorRT, rmRT, params: p, rolled };
}

// ---------------------------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------------------------
// CS2's pearlescence (csgo_weapon.vfx): rotate the paint hue around the grey axis by an angle that
// grows at grazing view angles, where paint covers the metal.
function addPearlescence(material, scale) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.cs2Pearl = { value: scale };
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform float cs2Pearl;\nvoid main() {')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      {
        float cov = texture2D(metalnessMap, vMetalnessMapUv).a;
        float a = cs2Pearl * (1.0 - dot(normalize(vViewPosition), normal)) * cov;
        vec3 c = diffuseColor.rgb;
        float mx = max(c.r, max(c.g, c.b));
        float sat = mx == 0.0 ? 0.0 : (mx - min(c.r, min(c.g, c.b))) / mx;
        vec3 k = vec3(0.57735);
        float cs = cos(a);
        vec3 rot = c * cs + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - cs);
        diffuseColor.rgb = mix(vec3(dot(c, vec3(0.2125, 0.7154, 0.0721))), rot, pow(sat, 0.125));
      }`);
  };
  material.customProgramCacheKey = () => 'cs2pearl';
}

const gltfCache = new Map();
function loadGltf(url) {
  if (!gltfCache.has(url)) {
    const job = new GLTFLoader().loadAsync(url);
    gltfCache.set(url, job);
    job.catch(() => gltfCache.delete(url));
  }
  return gltfCache.get(url);
}

async function plainMaterial(info) {
  const [map, orm, normal] = await Promise.all([
    info?.color ? texture(info.color, { srgb: true }) : null,
    info?.orm ? texture(info.orm) : null,
    info?.normal ? texture(info.normal) : null,
  ]);
  return new THREE.MeshPhysicalMaterial({
    map, roughnessMap: orm, metalnessMap: orm, aoMap: orm, normalMap: normal,
    roughness: 1, metalness: orm ? 1 : 0, transparent: info?.alphaMode === 'BLEND',
  });
}

// The glove model's first-person ("viewmodel") mesh with the item's skin baked onto both hands by CS2's own
// glove shader; the bare arm keeps CS2's own material. Returns { root, prep } (root: a fresh skinned scene).
export async function buildGloveScene(item, def, renderer) {
  const prep = await cs2Prepare(def.wid, def.v ? null : def.fid);
  if (!prep.glove) throw new Error('No CS2 glove skin for ' + def.n);
  const [gltf, hands] = await Promise.all([loadGltf(prep.model), gloveMaterials(renderer, prep, item)]);
  const root = cloneSkinned(gltf.scene);
  const meshes = [];
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const inView = (o) => { for (let n = o; n; n = n.parent) if (n.name.includes(prep.mesh)) return true; return false; };
  for (const o of meshes) {
    if (!inView(o)) { o.parent.remove(o); continue; }
    const name = o.material?.name || '';
    o.material = hands[name] || await plainMaterial(prep.materials[name]);
    o.frustumCulled = false;
  }
  return { root, prep };
}

// Grows a box by the (skinned) vertices a mesh actually draws. CS2's glove model shares one vertex buffer between
// the gloves and the bare arm, so the whole buffer would include the hidden arm.
function expandByDrawn(box, mesh) {
  const g = mesh.geometry, idx = g.index, v = new THREE.Vector3();
  const seen = new Uint8Array(g.attributes.position.count);
  const n = idx ? idx.count : g.attributes.position.count;
  for (let i = 0; i < n; i++) {
    const k = idx ? idx.getX(i) : i;
    if (seen[k]) continue;
    seen[k] = 1;
    box.expandByPoint(mesh.getVertexPosition(k, v).applyMatrix4(mesh.matrixWorld));
  }
}

// Gloves for the 3D inspect: just the two gloves (no arms), posed by CS2's glove inspect animation (its looping
// pedestal clip), centred.
async function buildGloveModel(item, def, renderer) {
  const [{ root, prep }, { clip }] = await Promise.all([buildGloveScene(item, def, renderer), cs2GloveClip()]);
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (!o.material.userData.baked) o.visible = false; // the bare arm
    else o.material.side = THREE.DoubleSide; // the cuff opening shows the glove's inside
  });
  const clipG = await loadRig(clip);
  const skel = cloneSkinned(clipG.scene);
  skel.traverse((o) => { if (o.isMesh) o.visible = false; });
  const bones = bonesByName(skel);
  rebind(root, bones, skel);
  const twist = forearmTwist(bones);
  const posed = new THREE.Group();
  posed.add(skel, root);
  const mixer = new THREE.AnimationMixer(skel);
  mixer.clipAction(clipG.animations[0]).play();
  const tick = (dt) => { mixer.update(dt); twist(); };
  tick(0);

  posed.updateMatrixWorld(true);
  const box = new THREE.Box3();
  root.traverse((o) => { if (o.isMesh && o.visible) expandByDrawn(box, o); });
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  posed.position.sub(center);
  const inner = new THREE.Group();
  inner.add(posed);
  const longest = Math.max(size.x, size.y, size.z) || 1;
  inner.scale.setScalar(4 / longest);
  const wrap = new THREE.Group();
  wrap.add(inner);
  wrap.userData.cs2 = { prep, mesh: prep.mesh };
  wrap.userData.unitScale = 4 / longest;
  wrap.userData.tick = tick;
  wrap.userData.bounds = new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(), size.multiplyScalar(4 / longest)); // for framing
  return wrap;
}

// Returns a THREE.Group with the item on its real model, centred, barrel along +X, or null if unsupported.
export async function buildCS2Model(item, def, renderer) {
  if (def.cat === 'gloves') return buildGloveModel(item, def, renderer);
  const paint = def.v ? null : def.fid;
  // Vanilla knives carry a HUD id instead of the weapon id; borrow it from a finished skin of the same knife.
  const wid = def.wid.startsWith('weapon_') ? def.wid
    : Object.values(D.skins).find((s) => s.w === def.w && s.wid.startsWith('weapon_'))?.wid || def.wid;
  const prep = await cs2Prepare(wid, paint);
  if (paint && !prep.shader) return null; // e.g. gloves (different compositing shader)
  const gltf = await loadGltf(prep.model);
  const root = cloneSkinned(gltf.scene);

  let skin = null;
  if (prep.kit && prep.inputs) {
    const baked = await bakeSkin(renderer, prep, item);
    const [normal, orm] = await Promise.all([
      prep.materials[prep.material]?.normal ? texture(prep.materials[prep.material].normal) : null,
      prep.materials[prep.material]?.orm ? texture(prep.materials[prep.material].orm) : null,
    ]);
    const override = prep.kit.final?.g_tNormal?.value;
    const normalMap = override && prep.textures[override] ? await texture(prep.textures[override]) : normal;
    skin = new THREE.MeshPhysicalMaterial({
      map: baked.colorRT.texture, roughnessMap: baked.rmRT.texture, metalnessMap: baked.rmRT.texture,
      roughness: 1, metalness: 1, normalMap, aoMap: orm, clearcoat: 0.08, clearcoatRoughness: 0.4,
    });
    skin.userData.dispose = () => { baked.colorRT.dispose(); baked.rmRT.dispose(); };
    const pearl = prep.kit.final?.g_flPearlescentScale?.value ?? baked.params.g_flPearlescentScale ?? 0;
    if (pearl) addPearlescence(skin, pearl);
  }

  const meshes = [];
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const inBody = (o) => { for (let n = o; n; n = n.parent) if (n.name.includes(prep.mesh)) return true; return false; };
  for (const o of meshes) {
    const owner = inBody(o) || meshes.length === 1;
    const matName = o.material?.name || '';
    if (!owner || /sticker_gaps/.test(matName)) { o.visible = false; continue; }
    if (skin && matName === prep.material) o.material = skin;
    else o.material = await plainMaterial(prep.materials[matName]);
    o.frustumCulled = false;
  }

  // Centre and orient: longest axis along X, model standing upright.
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  root.traverse((o) => { if (o.isMesh && o.visible) box.expandByObject(o); });
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const wrap = new THREE.Group();
  const inner = new THREE.Group();
  root.position.sub(center);
  inner.add(root);
  // Turn the model's thinnest axis towards the camera. CS2 weapons and knives are thin along X, and
  // this shows the side Steam icons use (muzzle/blade pointing left) at yaw 0.
  if (size.x <= size.y && size.x <= size.z) inner.rotation.y = -Math.PI / 2;
  else if (size.y <= size.z) inner.rotation.x = Math.PI / 2;
  const longest = Math.max(size.x, size.y, size.z) || 1;
  inner.scale.setScalar(4 / longest);
  // Long straight knives are modelled blade-up; icons show them lying down with the tip to the left.
  const tilt = new THREE.Group();
  if (size.x <= size.y && size.x <= size.z && size.y > size.z * 1.5) tilt.rotation.z = Math.PI / 2;
  tilt.add(inner);
  wrap.add(tilt);
  wrap.userData.cs2 = { prep, mesh: prep.mesh };
  wrap.userData.unitScale = 4 / longest; // scene units per glTF metre (lines up CS2 inspect backdrops)
  wrap.userData.weapon = wid; // for the first-person inspect
  wrap.userData.root = root;
  if (item.stk?.length) {
    try { await addStickerDecals(wrap, item, def); } catch (e) { console.warn('sticker decals failed', e); }
    // Where the decals sit relative to the weapon's main bone, so they can follow it in first person.
    wrap.updateMatrixWorld(true);
    let bone = null;
    root.traverse((o) => { if (!bone && o.isBone && o.name === 'weapon_offset') bone = o; });
    root.traverse((o) => { if (!bone && o.isBone && o.name === 'weapon') bone = o; });
    if (bone) wrap.userData.decalBone = { name: bone.name, matrixWorld: bone.matrixWorld.clone() };
  }
  return wrap;
}

// ---------------------------------------------------------------------------------------------
// Stickers: placements are stored on the 2D icon; map them onto the model's matching side view
// (outline to outline), ray-cast onto the surface and project a decal there.
// ---------------------------------------------------------------------------------------------
async function alphaBounds(url) {
  const im = await loadImage(url);
  const c = document.createElement('canvas');
  c.width = im.naturalWidth; c.height = im.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(im, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
  for (let y = 0; y < c.height; y += 2) for (let x = 0; x < c.width; x += 2) {
    if (d[(y * c.width + x) * 4 + 3] > 20) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  }
  // Vertical extent of the weapon in the icon at a given (normalised) column.
  const column = (xn) => {
    let top = -1, bottom = -1;
    const cxp = Math.round(xn * (c.width - 1));
    for (let y = 0; y < c.height; y++) {
      let on = false;
      for (let dx = -2; dx <= 2 && !on; dx++) { const x = cxp + dx; on = x >= 0 && x < c.width && d[(y * c.width + x) * 4 + 3] > 40; }
      if (on) { if (top < 0) top = y; bottom = y; }
    }
    return top < 0 ? null : { top: top / c.height, bottom: bottom / c.height };
  };
  return { x0: x0 / c.width, x1: x1 / c.width, y0: y0 / c.height, y1: y1 / c.height, column };
}

function stickerMaterial(def, map) {
  const fx = def?.fx;
  const p = fx === 'Holo' || fx === 'Lenticular' ? { metalness: 0.5, roughness: 0.15, iridescence: 1, iridescenceIOR: 1.7, iridescenceThicknessRange: [180, 820] }
    : fx === 'Foil' ? { metalness: 0.85, roughness: 0.2 }
      : fx === 'Gold' ? { metalness: 1, roughness: 0.16 }
        : fx === 'Glitter' ? { metalness: 0.6, roughness: 0.3, iridescence: 0.5 }
          : { metalness: 0.05, roughness: 0.4 };
  return new THREE.MeshPhysicalMaterial({
    map, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, clearcoat: 0.6, clearcoatRoughness: 0.25, ...p,
  });
}

async function addStickerDecals(wrap, item, def) {
  const icon = await alphaBounds(imgUrl(def.img, 'm'));
  wrap.updateMatrixWorld(true);
  const targets = [];
  wrap.traverse((o) => {
    let shown = o.visible;
    for (let n = o.parent; n && shown; n = n.parent) shown = n.visible;
    if (o.isMesh && shown) targets.push(o);
  });
  const box = new THREE.Box3();
  for (const t of targets) box.expandByObject(t, true);
  const W = box.max.x - box.min.x, H = box.max.y - box.min.y;
  const ray = new THREE.Raycaster();
  const { D } = await import('../data.js');
  for (const s of item.stk) {
    const sd = D.stickers[s.id];
    if (!sd) continue;
    const u = (s.x - icon.x0) / Math.max(1e-6, icon.x1 - icon.x0);
    const v = (s.y - icon.y0) / Math.max(1e-6, icon.y1 - icon.y0);
    if (s.m) {
      // Placed on the model's own side view (sticker editor with CS2 models): exact mapping.
      await placeDecal(wrap, targets, ray, box, sd, s, box.min.x + s.x * W, box.max.y - s.y * H, 0.15 * (s.s || 1) * W);
      continue;
    }
    const cx = box.min.x + u * W;
    // Map height within the weapon's local top/bottom edges at this column (icons are tilted 3/4 views).
    let cy = box.max.y - v * H;
    const ic = icon.column(s.x);
    if (ic && ic.bottom > ic.top) {
      let top = null, bottom = null;
      for (let k = 0; k <= 80; k++) {
        const y = box.max.y - (k / 80) * H;
        ray.set(new THREE.Vector3(cx, y, box.max.z + 1), new THREE.Vector3(0, 0, -1));
        if (ray.intersectObjects(targets, false).length) { if (top === null) top = y; bottom = y; }
      }
      if (top !== null && top > bottom) {
        const lv = Math.min(1, Math.max(0, (s.y - ic.top) / (ic.bottom - ic.top)));
        cy = top - lv * (top - bottom);
      }
    }
    // The icon is a 3/4 render, so the mapped point can land in a gap: spiral outwards to the nearest surface.
    let hit = null;
    for (let i = 0; i < 60 && !hit; i++) {
      const rad = i === 0 ? 0 : 0.012 * W * Math.sqrt(i), ang = i * 2.4;
      ray.set(new THREE.Vector3(cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad, box.max.z + 1), new THREE.Vector3(0, 0, -1));
      hit = ray.intersectObjects(targets, false)[0] || null;
    }
    if (!hit) continue;
    await placeDecal(wrap, targets, ray, box, sd, s, hit.point.x, hit.point.y, (0.15 * (s.s || 1) * W) / Math.max(0.05, icon.x1 - icon.x0), hit);
  }
}

async function placeDecal(wrap, targets, ray, box, sd, s, x, y, width, hit = null) {
  const W = box.max.x - box.min.x;
  for (let i = 0; i < 60 && !hit; i++) {
    const rad = i === 0 ? 0 : 0.012 * W * Math.sqrt(i), ang = i * 2.4;
    ray.set(new THREE.Vector3(x + Math.cos(ang) * rad, y + Math.sin(ang) * rad, box.max.z + 1), new THREE.Vector3(0, 0, -1));
    hit = ray.intersectObjects(targets, false)[0] || null;
  }
  if (!hit) return;
  {
    const icon = await loadImage(imgUrl(sd.img, 'm'));
    // CS2's own sticker material (effects, scrape wear) when the game has it; the icon image otherwise.
    let surface = null;
    if (sd.sm) {
      try { surface = await stickerSurface(sd, { wear: s.wr || 0 }); } catch (e) { console.warn('CS2 sticker material unavailable, using the icon:', sd.n, e); }
    }
    let mat, aspect;
    if (surface) {
      // The game texture is padded differently from the icon: keep the visible sticker the size placed on the icon.
      width *= contentBox(icon).w / Math.max(0.05, contentBox(surface.image).w);
      aspect = surface.image.height / surface.image.width;
      mat = surface.material;
    } else {
      const tex = new THREE.Texture(icon);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      aspect = icon.naturalHeight / icon.naturalWidth || 0.75;
      mat = stickerMaterial(sd, tex);
      mat.opacity = 1 - (s.wr || 0) * 0.8;
    }
    const normal = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3(0, 0, 1);
    const orient = new THREE.Object3D();
    orient.position.copy(hit.point);
    orient.lookAt(hit.point.clone().add(normal));
    orient.rotateZ(-((s.r || 0) * Math.PI) / 180);
    const size = new THREE.Vector3(width, width * aspect, Math.min(width * 0.3, (box.max.z - box.min.z) * 0.45));
    const geo = new DecalGeometry(hit.object, hit.point, orient.rotation, size);
    const decal = new THREE.Mesh(geo, mat);
    decal.renderOrder = 2;
    decal.userData.decal = true;
    wrap.add(decal);
  }
}

// Orthographic side view of the item on its real model, framed exactly to the model's visible bounding
// box, so normalised image coordinates equal the model-space sticker coordinates used by decals.
export async function renderSideView(item, def, renderer, env, size = 1400) {
  const model = await buildCS2Model(item, def, renderer);
  if (!model) return null;
  model.updateMatrixWorld(true);
  const box = new THREE.Box3();
  model.traverse((o) => {
    let shown = o.visible;
    for (let n = o.parent; n && shown; n = n.parent) shown = n.visible;
    if (o.isMesh && shown && o.renderOrder !== 2) box.expandByObject(o, true);
  });
  const W = box.max.x - box.min.x, H = box.max.y - box.min.y;
  const pw = size, ph = Math.max(2, Math.round((size * H) / W));
  const scene = new THREE.Scene();
  scene.environment = env;
  const key = new THREE.DirectionalLight(0xffffff, 1.5); key.position.set(3, 4, 6);
  const fill = new THREE.DirectionalLight(0xa9c4ff, 0.5); fill.position.set(-5, 1, 3);
  scene.add(key, fill, new THREE.AmbientLight(0xffffff, 0.2), model);
  const cam = new THREE.OrthographicCamera(box.min.x, box.max.x, box.max.y, box.min.y, 0.01, 100);
  cam.position.set(0, 0, box.max.z + 10);
  const rt = new THREE.WebGLRenderTarget(pw, ph, { colorSpace: THREE.SRGBColorSpace, samples: 4 });
  const prev = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
  try {
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, cam);
    const px = new Uint8Array(pw * ph * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, pw, ph, px);
    const canvas = document.createElement('canvas');
    canvas.width = pw; canvas.height = ph;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(pw, ph);
    for (let y = 0; y < ph; y++) img.data.set(px.subarray((ph - 1 - y) * pw * 4, (ph - y) * pw * 4), y * pw * 4); // GL rows are bottom-up
    ctx.putImageData(img, 0, 0);
    return { canvas, width: W, height: H };
  } finally {
    renderer.setRenderTarget(prev);
    renderer.setClearColor(prevClear, prevAlpha);
    rt.dispose();
    model.traverse((o) => {
      o.geometry?.dispose();
      for (const m of [].concat(o.material || [])) { m.userData.dispose?.(); m.dispose?.(); }
    });
  }
}

export const __debug = { texture, loadSource };
