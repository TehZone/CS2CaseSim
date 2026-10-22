// Glove skins: CS2's own (decompiled) csgo_customglove compositing shader, run like CS2's compositor does it:
// once per hand (glove_*_left / glove_*_right), at 2048², for the item's exact float and seed. It bakes the
// colour, the normal + roughness, the metalness + cloth mask and the ambient occlusion of each glove.
import * as THREE from 'three';
import { UniformRandomStream } from './rng.js';
import { texture, whiteTex } from './textures.js';

const BAKE_SIZE = 2048; // csgo_customglove's GENERATE_TEXTURE resolution (its blur kernels assume it)

// Defaults of the shader's parameters that a paint kit may leave out (from csgo_customglove.vfx).
const DEFAULTS = {
  g_flSheenScale: 0.667, g_fColorMaskBlur: 2, g_fPatternRoughnessBrightness: 1, g_fPaintThickness: 1, g_fPaintDurability: 0.5,
  g_nPatternReplaceIndex: 1, g_vPatternPaletteIndices: [5, 6, 7, 8], g_fWearExponent: 1, g_fPatternTexCoordScale: 2.5,
  g_fGrungeTexCoordScale: 2.5, g_fPatternTexCoordOffset: [0, 0], g_fGrungeTexCoordOffset: [0, 0],
  g_vColorTint1: [0.15, 0.11, 0.08], g_vColorTint2: [0.23, 0.16, 0.26], g_vColorTint3: [0.16, 0.16, 0.28], g_vColorTint4: [0.2, 0.3, 0.3],
  g_vColorTint5: [0.09, 0.16, 0.1], g_vColorTint6: [0.29, 0.26, 0.11], g_vColorTint7: [0.32, 0.22, 0.12], g_vColorTint8: [0.21, 0.12, 0.09],
};
for (let i = 1; i <= 4; i++) {
  Object.assign(DEFAULTS, {
    ['g_fDetailBlackPoint' + i]: 0.047, ['g_fDetailScale' + i]: 4, ['g_fDetailRoughnessBrightness' + i]: 1, ['g_fDetailNormalContrast' + i]: 1,
    ['g_vDamageLevels' + i]: [0, 0], ['g_fDamageRoughnessBrightness' + i]: 1, ['g_fCurvaturePower' + i]: 1, ['g_fDamageNormalEdgeWidth' + i]: 1,
    ['g_fDamageEdgeRoughness' + i]: 0.8, ['g_fGrungeMax' + i]: 1, ['g_fGrungeRoughnessBrightness' + i]: 0.8, ['g_fWearBleaching' + i]: 0.25,
  });
}

// Texture colour handling (csgo_customglove.vfx, Source2 layout): grunge and noise are read as sRGB.
const SRGB_TEX = /^g_t(Grunge\d|Noise)$/;

// The shader samples 22 textures, more than WebGL allows in one shader (16), so each set of four per-material
// layers (detail, detail normal, damage normal, grunge) is packed into one array texture.
const LAYERED = ['Detail', 'DetailNormal', 'DamageNormal', 'Grunge'];
const LAYERED_RE = /^g_t(Detail|DetailNormal|DamageNormal|Grunge)(\d)_g_sTrilinearWrap$/;
const LAYER_MAX = 1024;

// Pattern/grunge UV transforms, exactly as the shader's material expressions compute them.
function xform(rotationDeg, scale, offset) {
  const v0 = (rotationDeg * 3.14159) / 180;
  const v1 = Math.cos(v0), v2 = Math.sin(v0), v3 = scale;
  const v4 = 0.5 / (v3 !== 0 ? v3 : 1);
  const v5 = Math.cos(-v0), v6 = Math.sin(-v0);
  const v7 = v4 * v5 - v4 * v6;
  const v8 = v7 * v6 + v4 * v5;
  return [
    new THREE.Vector4(v1 * v3, -v2 * v3, 0, v3 * v1 * v7 + v3 * -v2 * v8 + (offset[0] - 0.5)),
    new THREE.Vector4(v2 * v3, v1 * v3, 0, v3 * v2 * v7 + v3 * v1 * v8 + (offset[1] - 0.5)),
  ];
}
const levels = (x, y, z) => new THREE.Vector3(-x, -1.4427 * Math.log(Math.max(0.0001, 1 - y)), 2 - z);

// The shader's inputs for one hand. CS2 rolls the pattern/grunge placement from the item's seed, the right
// hand with the alternate seed (its material has seed_offset 1), and mirrors the pattern on the left hand.
function handParams(kit, item, left) {
  const p = { ...DEFAULTS };
  for (const [k, v] of Object.entries(kit.color)) if (v && v.value !== undefined) p[k] = v.value;
  const rng = new UniformRandomStream((item.sd ?? 0) + (left ? 0 : 1));
  for (const r of kit.rolls || []) {
    p[r.name] = r.comps === 1 ? rng.randomFloat(r.min ?? 0, r.max ?? 0)
      : [rng.randomFloat(r.min?.[0] ?? 0, r.max?.[0] ?? 0), rng.randomFloat(r.min?.[1] ?? 0, r.max?.[1] ?? 0)];
  }
  const flip = left ? !p.g_bFlipFixup : !!p.g_bFlipFixup;
  const rot = p.g_fPatternTexCoordRotation ?? p.g_fPatternTexcoordRotation ?? 0;
  const [pat0, pat1] = xform(flip ? -rot : rot, p.g_fPatternTexCoordScale, p.g_fPatternTexCoordOffset);
  const [patR0, patR1] = xform(flip ? rot : -rot, 1, [0, 0]);
  const [gr0, gr1] = xform(p.g_fGrungeTexCoordRotation || 0, p.g_fGrungeTexCoordScale, p.g_fGrungeTexCoordOffset);
  const [grR0, grR1] = xform(-(p.g_fGrungeTexCoordRotation || 0), 1, [0, 0]);
  Object.assign(p, {
    g_bPattern: p.F_PATTERN ? 1 : 0,
    g_nOutputMode: 0,
    g_vTextileAlbedoLevels: levels(-0.045, 0.6, 1),
    g_vMetallicTextileAlbedoLevels: levels(-0.08, 0.6, 1.08),
    g_fWearProgress: Math.pow(Math.max(0, item.fl ?? 0), p.g_fWearExponent ?? 1),
    g_fFlipFixup: flip ? -1 : 1,
    g_fPaintShadowPower: Math.max(0.01, p.g_fPaintThickness * 0.15),
    g_nPatternReplaceIndex: (p.g_nPatternReplaceIndex ?? 1) - 1,
    g_vPatternTexCoordXform0: pat0, g_vPatternTexCoordXform1: pat1, g_vPatternTexRotationXform0: patR0, g_vPatternTexRotationXform1: patR1,
    g_vGrungeTexCoordXform0: gr0, g_vGrungeTexCoordXform1: gr1, g_vGrungeTexRotationXform0: grR0, g_vGrungeTexRotationXform1: grR1,
  });
  for (let i = 1; i <= 4; i++) p['g_fDetailBlackPointCompensation' + i] = 1 - p['g_fDetailBlackPoint' + i];
  return p;
}

// Coerce a parameter to the struct member's GLSL type.
function uniformValue(v, type) {
  const size = { vec2: 2, vec3: 3, vec4: 4, ivec4: 4 }[type];
  if (!size) return typeof v === 'number' ? v : typeof v === 'boolean' ? +v : Array.isArray(v) ? v[0] ?? 0 : 0;
  const arr = v?.isVector2 || v?.isVector3 || v?.isVector4 ? v.toArray() : Array.isArray(v) ? v : [typeof v === 'number' ? v : 0];
  const a = [0, 1, 2, 3].map((i) => arr[i] ?? 0);
  return size === 2 ? new THREE.Vector2(a[0], a[1]) : size === 3 ? new THREE.Vector3(a[0], a[1], a[2]) : new THREE.Vector4(...a);
}

const BAKE_VS = `
precision highp float;
in vec3 position;
out highp vec4 input_0;
void main() {
  vec2 uv = position.xy * 0.5 + 0.5;
  input_0 = uv.xyxy;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

// The decompiled shader with its output mode turned into a variable, so one draw can evaluate several modes:
// pass 0 colour; pass 1 normal (RGB normal map for three.js); pass 2 AO, roughness, metalness, cloth.
function adaptFragment(src) {
  let s = src.replace(/^\s*#version.*$/m, '').replace(/precision mediump float;/, 'precision highp float;');
  s = s.replace(/(precision highp int;)/, `$1
float saturate(float x) { return clamp(x, 0.0, 1.0); }
vec2 saturate(vec2 x) { return clamp(x, 0.0, 1.0); }
vec3 saturate(vec3 x) { return clamp(x, 0.0, 1.0); }
vec4 saturate(vec4 x) { return clamp(x, 0.0, 1.0); }
vec3 cs2LinearToSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }
int cs2Mode;
uniform int cs2Pass;`);
  s = s.replace(/_Globals_\.g_nOutputMode/g, 'cs2Mode').replace(/void main\(\)/, 'void cs2_main()');
  s = s.replace(/uniform highp sampler2D g_t(Detail|DetailNormal|DamageNormal|Grunge)1_g_sTrilinearWrap;/g, 'uniform highp sampler2DArray cs2_$1;')
    .replace(/uniform highp sampler2D g_t(Detail|DetailNormal|DamageNormal|Grunge)[234]_g_sTrilinearWrap;\n/g, '')
    .replace(/texture\(g_t(Detail|DetailNormal|DamageNormal|Grunge)(\d)_g_sTrilinearWrap, (_\d+)\)/g, (m, set, n, uv) => `texture(cs2_${set}, vec3(${uv}, ${n - 1}.0))`);
  // Modes 1-3 write data through an sRGB->linear step (CS2's targets are sRGB); undo it to get the raw values.
  s += `
void main() {
  cs2Mode = 0;
  if (cs2Pass == 0) { cs2_main(); output_0 = vec4(output_0.rgb, 1.0); return; }
  cs2Mode = 1; cs2_main();
  vec3 nr = cs2LinearToSrgb(output_0.xyz);
  if (cs2Pass == 1) {
    float x = (nr.x + nr.y) - 1.00392163, y = nr.x - nr.y;
    vec3 n = normalize(vec3(x, y, (1.0 - abs(x)) - abs(y)));
    output_0 = vec4(n * 0.5 + 0.5, 1.0);
    return;
  }
  float rough = nr.z;
  cs2Mode = 3; cs2_main();
  float ao = cs2LinearToSrgb(output_0.xyz).x;
  cs2Mode = 2; cs2_main();
  vec3 mc = cs2LinearToSrgb(output_0.xyz);
  output_0 = vec4(ao, rough, mc.y, mc.z);
}`;
  return s;
}

function parseGlobals(src) {
  const struct = src.match(/struct (_\d+)\s*\{([^}]*)\};\s*\n\s*uniform \1 _Globals_;/);
  if (!struct) return [];
  return [...struct[2].matchAll(/(?:highp |mediump |lowp )?(\w+)\s+(\w+);/g)].map((m) => ({ type: m[1], name: m[2] }));
}
const samplerNames = (src) => [...src.matchAll(/uniform highp sampler2D (\w+);/g)].map((m) => m[1]);

// Copies up to four textures into the layers of one array texture (sRGB layers stay sRGB-encoded).
const COPY_VS = 'precision highp float; in vec3 position; out vec2 vUv; void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }';
const COPY_FS = 'precision highp float; uniform sampler2D src; in vec2 vUv; out vec4 outColor; void main() { outColor = texture(src, vUv); }';
async function layerArray(renderer, urls, srgb) {
  const texs = await Promise.all(urls.map((u) => (u ? texture(u, { srgb }) : null)));
  const size = Math.min(LAYER_MAX, Math.max(4, ...texs.map((t) => (t ? Math.max(t.image.width, t.image.height) : 4))));
  const rt = new THREE.WebGLArrayRenderTarget(size, size, texs.length, {
    depthBuffer: false, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    colorSpace: srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace,
  });
  rt.texture.wrapS = rt.texture.wrapT = THREE.RepeatWrapping;
  rt.texture.anisotropy = 8;
  const mat = new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: COPY_VS, fragmentShader: COPY_FS, uniforms: { src: { value: null } }, depthTest: false, depthWrite: false });
  const q = bakeQuad();
  q.mesh.material = mat;
  texs.forEach((t, i) => {
    mat.uniforms.src.value = t || whiteTex();
    renderer.setRenderTarget(rt, i);
    renderer.render(q.scene, q.camera);
  });
  mat.dispose();
  for (const t of texs) t?.dispose();
  return rt;
}

let quad = null;
function bakeQuad() {
  if (!quad) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    const mesh = new THREE.Mesh(g);
    mesh.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(mesh);
    quad = { mesh, scene, camera: new THREE.Camera() };
  }
  return quad;
}

// Bakes one hand: { color, normal, orm } render targets (orm = AO, roughness, metalness, cloth mask).
async function bakeHand(renderer, prep, item, left) {
  const src = prep.shader.source;
  const p = handParams(prep.kit, item, left);
  const globals = {};
  for (const { name, type } of parseGlobals(src)) globals[name] = uniformValue(p[name], type);
  const uniforms = { _Globals_: { value: globals }, cs2Pass: { value: 0 } };
  await Promise.all(samplerNames(src).filter((u) => !LAYERED_RE.test(u)).map(async (u) => {
    const m = u.match(/^(g_t[A-Za-z0-9]+)_(.+)$/);
    const name = m ? m[1] : u;
    const vpk = p[name];
    const url = vpk && (prep.rawTextures[vpk] || prep.textures[vpk]);
    let t = whiteTex();
    if (url) {
      t = await texture(url, { srgb: SRGB_TEX.test(name) });
      if (/Point/.test(m?.[2] || '')) { t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; }
    }
    uniforms[u] = { value: t };
  }));

  const arrays = [];
  const before = renderer.getRenderTarget();
  try {
    for (const set of LAYERED) {
      const urls = [1, 2, 3, 4].map((i) => { const vpk = p[`g_t${set}${i}`]; return vpk && (prep.rawTextures[vpk] || prep.textures[vpk]); });
      const rt = await layerArray(renderer, urls, set === 'Grunge');
      arrays.push(rt);
      uniforms['cs2_' + set] = { value: rt.texture };
    }
  } finally {
    renderer.setRenderTarget(before);
  }

  const mat = new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: BAKE_VS, fragmentShader: adaptFragment(src), uniforms, depthTest: false, depthWrite: false });
  const target = (srgb) => {
    const rt = new THREE.WebGLRenderTarget(BAKE_SIZE, BAKE_SIZE, {
      depthBuffer: false, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
      colorSpace: srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace,
    });
    rt.texture.anisotropy = 8;
    rt.texture.wrapS = rt.texture.wrapT = THREE.RepeatWrapping; // the left glove's UVs run negative
    return rt;
  };
  const out = { color: target(true), normal: target(false), orm: target(false) };
  const q = bakeQuad();
  q.mesh.material = mat;
  const prev = renderer.getRenderTarget();
  try {
    for (const [pass, rt] of [[0, out.color], [1, out.normal], [2, out.orm]]) {
      uniforms.cs2Pass.value = pass;
      renderer.setRenderTarget(rt);
      renderer.render(q.scene, q.camera);
    }
  } catch (e) {
    for (const rt of Object.values(out)) rt.dispose();
    throw e;
  } finally {
    renderer.setRenderTarget(prev);
    mat.dispose();
    for (const u of Object.values(uniforms)) if (u.value?.isTexture && u.value !== whiteTex() && !u.value.isDataArrayTexture) u.value.dispose();
    for (const rt of arrays) rt.dispose();
  }
  return out;
}

// The material of one hand: the baked textures on three's physical material, with cloth sheen where CS2's
// cloth mask says so.
async function handMaterial(renderer, prep, item, left) {
  const rt = await bakeHand(renderer, prep, item, left);
  const sheenScale = prep.kit.final?.g_flSheenScale?.value ?? prep.kit.color.g_flSheenScale?.value ?? DEFAULTS.g_flSheenScale;
  const cloth = !!(prep.kit.final?.F_CLOTH_SHADING?.value ?? prep.kit.color.F_CLOTH_SHADING?.value);
  const m = new THREE.MeshPhysicalMaterial({
    map: rt.color.texture, normalMap: rt.normal.texture, roughnessMap: rt.orm.texture, metalnessMap: rt.orm.texture, aoMap: rt.orm.texture,
    roughness: 1, metalness: 1, sheen: cloth ? 1 : 0, sheenColor: new THREE.Color(1, 1, 1).multiplyScalar(Math.min(1, sheenScale)), sheenRoughness: 0.55,
  });
  if (cloth) {
    m.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
      #ifdef USE_SHEEN
        material.sheenColor *= texture2D(metalnessMap, vMetalnessMapUv).a;
      #endif`);
    };
    m.customProgramCacheKey = () => 'cs2glovecloth';
  }
  m.userData.dispose = () => { for (const t of Object.values(rt)) t.dispose(); };
  m.userData.baked = rt;
  return m;
}

// Materials for the glove model's hand materials, keyed by material name.
export async function gloveMaterials(renderer, prep, item) {
  const out = {};
  for (const name of prep.hands || []) out[name] = await handMaterial(renderer, prep, item, /_left$/.test(name));
  return out;
}
