// Glove skins: CS2's own (decompiled) csgo_customglove compositing shader, run like CS2's compositor does it:
// once per hand (glove_*_left / glove_*_right), at 2048², for the item's exact float and seed. It bakes the
// colour, the normal + roughness, the metalness + cloth mask and the ambient occlusion of each glove.
// Two variants exist: the classic one ("Source1 texture layout": a layer mask over four detail materials) and the
// newest gloves' one ("Source2 height blending": four surface/substrate materials with damage, grime, burnishing and
// tint-by-ID).
import * as THREE from 'three';
import { UniformRandomStream } from './rng.js';
import { texture, whiteTex } from './textures.js';

const BAKE_SIZE = 2048; // csgo_customglove's GENERATE_TEXTURE resolution (its blur kernels assume it)

// Non-zero defaults of csgo_customglove's parameters (from its .vfx); "#" stands for each of the four layers.
const DEFAULT_TABLE = {
  g_vPatternTexCoordCenter: [0.5, 0.5], g_vPatternTexCoordScale: [1, 1], 'g_vUvScale#': [4, 4], 'g_fCurvaturePower#': 1,
  'g_fDamageUvScale#': 4, 'g_fGrimeUvScale#': 4, 'g_fGrimeTranslucency#': 0.5, 'g_fDetailBlackPoint#': 0.047,
  'g_fGrimeRoughnessBrightness#': 1, 'g_vSubstrateColorTint#': [1, 1, 1], 'g_vSurfaceColorTint#': [1, 1, 1],
  'g_fSubstrateColorContrast#': 1, 'g_fSurfaceColorContrast#': 1, 'g_fSubstrateColorSaturation#': 1,
  'g_fSurfaceColorSaturation#': 1, 'g_fSubstrateColorBrightness#': 1, 'g_fSurfaceColorBrightness#': 1,
  'g_fDamageHeightBlendSoftness#': 0.01, 'g_fDetailScale#': 4, 'g_fDetailNormalContrast#': 1,
  'g_fDetailRoughnessBrightness#': 1, 'g_fWearBleaching#': 0.25, 'g_fBurnishingGrime#': 0.5,
  'g_vBurnishingColorTint#': [1, 1, 1], 'g_vDamageBevelColorTint#': [1, 1, 1], 'g_fBurnishingColorContrast#': 1,
  'g_fDamageBevelColorContrast#': 1, 'g_fGrungeMax#': 1, 'g_fSubstrateCompositeColorTranslucency#': 0.5,
  'g_fBurnishingColorSaturation#': 1, 'g_fDamageBevelColorSaturation#': 1, 'g_fGrungeRoughnessBrightness#': 0.8,
  'g_fBurnishingColorBrightness#': 1, 'g_fDamageBevelColorBrightness#': 1, 'g_fBurnishingNormalScale#': 1,
  'g_fDamageBevelBlendSoftness#': 0.5, 'g_fDamageBevelEmboss#': 1, 'g_fDamageRoughnessBrightness#': 1,
  'g_fSurfaceBurnishingRoughnessBrightness#': 1, 'g_fSubstrateBurnishingRoughnessBrightness#': 1,
  'g_fDamageBevelRoughnessBrightness#': 1, 'g_fDamageNormalEdgeWidth#': 1, 'g_fDamageEdgeRoughness#': 0.8,
  g_vColorTint1: [0.15, 0.11, 0.08], g_vColorTint2: [0.23, 0.16, 0.26], g_vColorTint3: [0.16, 0.16, 0.28],
  g_vColorTint4: [0.2, 0.3, 0.3], g_vColorTint5: [0.09, 0.16, 0.1], g_vColorTint6: [0.29, 0.26, 0.11],
  g_vColorTint7: [0.32, 0.22, 0.12], g_vColorTint8: [0.21, 0.12, 0.09], g_vPatternPaletteIndices: [5, 6, 7, 8],
  g_fColorMaskBlur: 2, g_fPatternTexCoordScale: 2.5, g_fGrungeTexCoordScale: 2.5, g_fPatternTranslucencyThreshold: 0.01,
  g_flSheenScale: 0.667, g_fPaintThickness: 1, g_fPaintDurability: 0.5, g_fPatternRoughnessBrightness: 1,
  g_nPatternReplaceIndex: 1, g_fPatternEmboss: 0.5, g_fWearExponent: 1, g_vPatternRoughnessContrastBrightness: [1, 1],
  'g_vId#Color': [1, 1, 1, 1], 'g_vId5Color': [1, 1, 1, 1], 'g_vId6Color': [1, 1, 1, 1], 'g_vId7Color': [1, 1, 1, 1],
  'g_vId8Color': [1, 1, 1, 1], 'g_bId#Pattern': 1, g_bId5Pattern: 1, g_bId6Pattern: 1, g_bId7Pattern: 1, g_bId8Pattern: 1,
};
const DEFAULTS = {};
for (const [k, v] of Object.entries(DEFAULT_TABLE)) {
  if (k.includes('#')) for (let i = 1; i <= 4; i++) DEFAULTS[k.replace('#', i)] = v;
  else DEFAULTS[k] = v;
}

// Texture handling per variant. Each set of four per-layer textures is packed into one array texture (the shader
// samples more textures than WebGL allows in one shader); sRGB ones are read as sRGB, normal maps stay raw.
const VARIANTS = {
  classic: { sets: { Detail: 1024, DetailNormal: 1024, DamageNormal: 1024, Grunge: 1024 }, srgb: /^g_t(Grunge\d|Noise)$/ },
  layered: {
    sets: { Surface: 1024, SurfaceNormal: 1024, Substrate: 1024, SubstrateNormal: 1024, SurfaceProperties: 512, SubstrateProperties: 512, Damage: 512, Grime: 512 },
    srgb: /^g_t(Surface\d|Substrate\d|Grime\d|Pattern|Noise)$/,
  },
};
const variantOf = (prep) => (prep.shader.layered ? VARIANTS.layered : VARIANTS.classic);
const setNames = (v) => Object.keys(v.sets).join('|');

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

// Pattern/grunge UV transforms of the classic variant, exactly as its material expressions compute them.
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
// The layered variant's (vertex shader) transforms: rotate about a centre, scale, offset.
function xformAbout(rotationDeg, scale, center, offset) {
  const v0 = (rotationDeg * 3.1415927) / 180;
  const c = Math.cos(v0), s = Math.sin(v0);
  return [
    new THREE.Vector4(c * scale[0], -s * scale[1], 0, center[0] + offset[0] + s * center[1] - c * center[0]),
    new THREE.Vector4(s * scale[0], c * scale[1], 0, center[1] + offset[1] - (s * center[0] + c * center[1])),
  ];
}
const levels = (x, y, z) => new THREE.Vector3(-x, -1.4427 * Math.log(Math.max(0.0001, 1 - y)), 2 - z);

// Valve's colour matrices (VFX expression functions, as Source 2 Viewer implements them), in column-vector form.
const LUM = new THREE.Vector3(0.2126, 0.7152, 0.0722).normalize();
const LUM_SCALE = new THREE.Matrix4().makeScale(LUM.x, LUM.y, LUM.z);
const LUM_UNSCALE = new THREE.Matrix4().makeScale(1 / LUM.x, 1 / LUM.y, 1 / LUM.z);
const LUM_ROT = (() => {
  const axis = new THREE.Vector3().crossVectors(LUM, new THREE.Vector3(0, 0, 1));
  const angle = Math.atan2(axis.length(), LUM.z);
  return new THREE.Matrix4().makeRotationAxis(axis.normalize(), angle);
})();
const LUM_ROT_T = LUM_ROT.clone().transpose();
const chain = (...ms) => ms.reduce((acc, m) => acc.multiply(m), new THREE.Matrix4());
// MatrixColorCorrect2(contrast/saturation/brightness, pivot colour).
function colorCorrect([contrast, saturation, brightness], o) {
  return chain(LUM_UNSCALE, LUM_ROT_T, new THREE.Matrix4().makeScale(saturation, saturation, 1), LUM_ROT, LUM_SCALE,
    new THREE.Matrix4().makeScale(brightness, brightness, brightness), new THREE.Matrix4().makeTranslation(o.x, o.y, o.z),
    new THREE.Matrix4().makeScale(contrast, contrast, contrast), new THREE.Matrix4().makeTranslation(-o.x, -o.y, -o.z));
}
// MatrixColorTint2(rgb, 1): luminance-preserving tint.
function colorTint(rgb) {
  const mx = Math.max(...rgb), mn = Math.min(...rgb);
  const sat = mx === 0 ? 0 : (mx - mn) / mx;
  const gray = new THREE.Vector3(...rgb).applyMatrix4(chain(LUM_ROT, LUM_SCALE));
  const d = 1 - sat, sf = 1 - sat * sat;
  return chain(LUM_UNSCALE, LUM_ROT_T, new THREE.Matrix4().makeTranslation(gray.x, gray.y, (1 - sf) * gray.z),
    new THREE.Matrix4().makeScale(d, d, sf), new THREE.Matrix4().makeTranslation(-gray.x, -gray.y, 0), LUM_ROT, LUM_SCALE);
}
// MatrixMultiply(MatrixColorTint2(tint, 1), MatrixColorCorrect2(csb, TextureAverageColor(tex))), transposed for
// the shader (it multiplies vec4(colour, 1) * matrix).
const colorAdjust = (tint, csb, avg) => chain(colorTint(tint), colorCorrect(csb, avg)).transpose();

// CS2's random rolls for one hand (the composite material's RANDOM_ROLL steps whose conditions hold): the left
// hand rolls on the item's seed, the right hand (material seed_offset 1) on the alternate seed.
function rollHand(kit, item, left, p) {
  const seedOf = { g_nRandomSeed: item.sd ?? 0, g_nRandomSeedAlt: (item.sd ?? 0) + 1 };
  const draw = (rng, r) => (r.comps === 1 ? rng.randomFloat(r.min ?? 0, r.max ?? 1)
    : Array.from({ length: r.comps }, (_, i) => rng.randomFloat(r.min?.[i] ?? 0, r.max?.[i] ?? 1)));
  if (!kit.rollSets) {
    const rng = new UniformRandomStream(left ? seedOf.g_nRandomSeed : seedOf.g_nRandomSeedAlt);
    for (const r of kit.rolls || []) p[r.name] = draw(rng, r);
    return;
  }
  const ctx = { 'material_seed.seed_offset': left ? 0 : 1, 'handedness.left': left ? 1 : 0 };
  const norm = (v) => String(v === true || v === 'true' ? 1 : v === false || v === 'false' ? 0 : v);
  const holds = (c) => {
    const v = c.on.startsWith('instance_params.') ? p[c.on.slice(16)] : ctx[c.on];
    const ok = c.exists ? v != null : v != null && norm(v) === norm(c.value);
    return c.not ? !ok : ok;
  };
  for (const set of kit.rollSets) {
    if (!set.conds.every(holds)) continue;
    const rng = new UniformRandomStream(seedOf[set.seed] ?? 0);
    for (const r of set.vars) {
      const v = draw(rng, r);
      if (!r.consume) p[r.name] = v;
    }
  }
}

// The shader's inputs for one hand. `avg` holds the average colour of each surface/substrate layer.
function handParams(prep, item, left, avg) {
  const kit = prep.kit;
  const p = { ...DEFAULTS };
  for (const [k, v] of Object.entries(kit.color)) if (v && v.value !== undefined) p[k] = v.value;
  rollHand(kit, item, left, p);
  if (!prep.shader.layered) {
    const flip = left ? !p.g_bFlipFixup : !!p.g_bFlipFixup;
    const rot = p.g_fPatternTexCoordRotation ?? p.g_fPatternTexcoordRotation ?? 0;
    const [pat0, pat1] = xform(flip ? -rot : rot, p.g_fPatternTexCoordScale, p.g_fPatternTexCoordOffset || [0, 0]);
    const [patR0, patR1] = xform(flip ? rot : -rot, 1, [0, 0]);
    const [gr0, gr1] = xform(p.g_fGrungeTexCoordRotation || 0, p.g_fGrungeTexCoordScale, p.g_fGrungeTexCoordOffset || [0, 0]);
    const [grR0, grR1] = xform(-(p.g_fGrungeTexCoordRotation || 0), 1, [0, 0]);
    Object.assign(p, {
      g_vTextileAlbedoLevels: levels(-0.045, 0.6, 1),
      g_vMetallicTextileAlbedoLevels: levels(-0.08, 0.6, 1.08),
      g_fWearProgress: Math.pow(Math.max(0, item.fl ?? 0), p.g_fWearExponent ?? 1),
      g_fFlipFixup: flip ? -1 : 1,
      g_fPaintShadowPower: Math.max(0.01, p.g_fPaintThickness * 0.15),
      g_vPatternTexCoordXform0: pat0, g_vPatternTexCoordXform1: pat1, g_vPatternTexRotationXform0: patR0, g_vPatternTexRotationXform1: patR1,
      g_vGrungeTexCoordXform0: gr0, g_vGrungeTexCoordXform1: gr1, g_vGrungeTexRotationXform0: grR0, g_vGrungeTexRotationXform1: grR1,
    });
    for (let i = 1; i <= 4; i++) p['g_fDetailBlackPointCompensation' + i] = 1 - p['g_fDetailBlackPoint' + i];
  } else {
    // The composite material clears the flip on the left hand.
    p.$flip = left ? 0 : (p.g_bFlipFixup ? 1 : 0);
    p.g_fWearProgress = linearToSrgb(Math.max(0, item.fl ?? 0));
    p.g_bPatternPaintLayer = p.F_PATTERN_PAINT ? 1 : 0;
    p.g_bPatternPaintEmboss = p.F_PUFFY_PAINT ? 1 : 0;
    for (let i = 1; i <= 8; i++) {
      const c = p[`g_vId${i}Color`] || [1, 1, 1, 1];
      p[`g_vId${i}Color`] = [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2]), c[3] ?? 1];
    }
    const csb = (pre, i) => [p[`${pre}Contrast${i}`] ?? 1, p[`${pre}Saturation${i}`] ?? 1, p[`${pre}Brightness${i}`] ?? 1];
    for (let i = 1; i <= 4; i++) {
      const height = Math.max(p['g_fDamageHeightBlendSoftness' + i] ?? 0.01, 0.001);
      p['g_fDamageHeightBlendSoftness' + i] = height;
      p['g_fDamageBevelBlendSoftness' + i] = Math.max((p['g_fDamageBevelBlendSoftness' + i] ?? 0.5) + height, 0.001);
      const surf = avg.Surface[i - 1], sub = avg.Substrate[i - 1];
      p['g_mSurfaceColorAdjust' + i] = colorAdjust(p['g_vSurfaceColorTint' + i], csb('g_fSurfaceColor', i), surf);
      p['g_mSubstrateColorAdjust' + i] = colorAdjust(p['g_vSubstrateColorTint' + i], csb('g_fSubstrateColor', i), sub);
      p['g_mDamageColorAdjust' + i] = colorAdjust(p['g_vDamageBevelColorTint' + i], csb('g_fDamageBevelColor', i), surf);
      p['g_mSurfaceBurnishingColorAdjust' + i] = colorAdjust(p['g_vBurnishingColorTint' + i], csb('g_fBurnishingColor', i), surf);
      p['g_mSubstrateBurnishingColorAdjust' + i] = colorAdjust(p['g_vBurnishingColorTint' + i], csb('g_fBurnishingColor', i), sub);
    }
    // Vertex shader inputs.
    const pat = xformAbout(p.g_fPatternTexCoordRotation || 0, p.g_vPatternTexCoordScale, p.g_vPatternTexCoordCenter, p.g_vPatternTexCoordOffset || [0, 0]);
    const dmg = xformAbout(p.g_fDamageTexCoordRotation || 0, [1, 1], [0.5, 0.5], p.g_vDamageTexCoordOffset || [0, 0]);
    const grime = xformAbout(p.g_fGrimeTexCoordRotation || 0, [1, 1], [0.5, 0.5], p.g_vGrimeTexCoordOffset || [0, 0]);
    p.$vs = {
      cs2Pat0: pat[0], cs2Pat1: pat[1], cs2Dmg0: dmg[0], cs2Dmg1: dmg[1], cs2Grime0: grime[0], cs2Grime1: grime[1],
      cs2PatScale: new THREE.Vector2(...p.g_vPatternTexCoordScale), cs2PatDistort: (p.g_fPatternNormalDistortion || 0) * 0.1,
      cs2UvScale: [1, 2, 3, 4].map((i) => new THREE.Vector2(...(p['g_vUvScale' + i] || [4, 4]))),
      cs2UvOffset: [1, 2, 3, 4].map((i) => new THREE.Vector2(...(p['g_vUvOffset' + i] || [0, 0]))),
      cs2Flip: p.$flip,
    };
  }
  p.g_bPattern = p.F_PATTERN ? 1 : 0;
  p.g_nOutputMode = 0;
  p.g_nPatternReplaceIndex = (p.g_nPatternReplaceIndex ?? 1) - 1;
  return p;
}

// Coerce a parameter to the struct member's GLSL type (a single default fills every component).
function uniformValue(v, type) {
  if (type === 'mat4') return v?.isMatrix4 ? v : new THREE.Matrix4();
  const size = { vec2: 2, vec3: 3, vec4: 4, ivec2: 2, ivec4: 4 }[type];
  if (!size) return typeof v === 'number' ? v : typeof v === 'boolean' ? +v : Array.isArray(v) ? v[0] ?? 0 : 0;
  const arr = v?.isVector2 || v?.isVector3 || v?.isVector4 ? v.toArray() : Array.isArray(v) ? v : Array(size).fill(typeof v === 'number' ? v : 0);
  const a = [0, 1, 2, 3].map((i) => arr[i] ?? 0);
  return size === 2 ? new THREE.Vector2(a[0], a[1]) : size === 3 ? new THREE.Vector3(a[0], a[1], a[2]) : new THREE.Vector4(...a);
}

const CLASSIC_VS = `
precision highp float;
in vec3 position;
out highp vec4 input_0;
void main() {
  vec2 uv = position.xy * 0.5 + 0.5;
  input_0 = uv.xyxy;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;
// The layered variant's vertex shader (csgo_customglove VS, Source2 layout): per-layer, pattern and wear UVs.
const LAYERED_VS = `
precision highp float;
in vec3 position;
uniform vec4 cs2Pat0, cs2Pat1, cs2Dmg0, cs2Dmg1, cs2Grime0, cs2Grime1;
uniform vec2 cs2PatScale, cs2UvScale[4], cs2UvOffset[4];
uniform float cs2PatDistort;
uniform int cs2Flip;
out highp vec4 input_0, input_1, input_2, input_3, input_4, input_6;
out highp vec3 input_5;
void main() {
  vec2 uv = position.xy * 0.5 + 0.5;
  vec2 fu = cs2Flip != 0 ? vec2(-uv.x, uv.y) : uv;
  input_0 = uv.xyxy;
  input_1 = vec4(dot(fu, cs2Pat0.xy) + cs2Pat0.w, dot(fu, cs2Pat1.xy) + cs2Pat1.w, vec2(cs2PatDistort) * cs2PatScale);
  input_2 = vec4(uv * cs2UvScale[0] + cs2UvOffset[0], uv * cs2UvScale[1] + cs2UvOffset[1]);
  input_3 = vec4(uv * cs2UvScale[2] + cs2UvOffset[2], uv * cs2UvScale[3] + cs2UvOffset[3]);
  input_4 = vec4(dot(uv, cs2Dmg0.xy) + cs2Dmg0.w, dot(uv, cs2Dmg1.xy) + cs2Dmg1.w, dot(uv, cs2Grime0.xy) + cs2Grime0.w, dot(uv, cs2Grime1.xy) + cs2Grime1.w);
  input_5 = vec3(0.0, 0.0, 1.0);
  input_6 = vec4(1.0, 0.0, 0.0, 1.0);
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

// Index of the bracket/parenthesis that closes the one opened just before `i`.
function closeOf(s, i, open, close) {
  for (let depth = 1; i < s.length; i++) {
    if (s[i] === open) depth++;
    else if (s[i] === close && --depth === 0) return i;
  }
  return -1;
}
// GLSL ES 3.00 has no arrays of arrays: int a[8][9] becomes int a[72], a[i][j] becomes a[(i) * 9 + (j)].
function flattenArrays(s) {
  for (const m of [...s.matchAll(/\b(\w+) (_\d+)\[(\d+)\]\[(\d+)\];/g)]) {
    const [, , name, n, k] = m;
    s = s.replace(m[0], `${m[1]} ${name}[${n * k}];`);
    let out = '', i = 0;
    for (let at = s.indexOf(name + '[', i); at >= 0; at = s.indexOf(name + '[', i)) {
      const a0 = at + name.length + 1;
      if (/\w/.test(s[at - 1])) { out += s.slice(i, a0); i = a0; continue; } // part of a longer name
      const a1 = closeOf(s, a0, '[', ']');
      if (s[a1 + 1] !== '[') { out += s.slice(i, a1 + 1); i = a1 + 1; continue; }
      const b1 = closeOf(s, a1 + 2, '[', ']');
      out += `${s.slice(i, at)}${name}[(${s.slice(a0, a1)}) * ${k} + (${s.slice(a1 + 2, b1)})]`;
      i = b1 + 1;
    }
    s = out + s.slice(i);
  }
  return s;
}
// Turns texture lookups of a layer set into array lookups: texture(g_tSurface2_g_sTrilinearWrap, uv, ...) becomes
// texture(cs2_Surface, vec3(uv, 1.0), ...).
function arrayLookups(s, sets) {
  const re = new RegExp(`(texture\\w*)\\(g_t(${sets})(\\d)_g_sTrilinearWrap, `, 'g');
  let out = '', i = 0, m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    let depth = 0, j = start;
    for (; j < s.length; j++) {
      if ('([{'.includes(s[j])) depth++;
      else if (')]}'.includes(s[j])) { if (depth === 0) break; depth--; } else if (s[j] === ',' && depth === 0) break;
    }
    out += `${s.slice(i, m.index)}${m[1]}(cs2_${m[2]}, vec3(${s.slice(start, j)}, ${m[3] - 1}.0)`;
    i = j;
    re.lastIndex = j;
  }
  return out + s.slice(i);
}

// The decompiled shader, with its output mode as a uniform (one program for every pass) and its data outputs made
// usable: mode 0 colour; 1 normal as an RGB normal map for three.js, roughness in alpha; 2 metalness (G) and cloth
// (B); 3 ambient occlusion (R).
function adaptFragment(src, variant) {
  const sets = setNames(variant);
  let s = src.replace(/^\s*#version.*$/m, '').replace(/precision mediump float;/, 'precision highp float;');
  s = s.replace(/layout\(location = \d+\) in /g, 'in ');
  s = flattenArrays(s);
  s = s.replace(/(precision highp int;)/, `$1
float saturate(float x) { return clamp(x, 0.0, 1.0); }
vec2 saturate(vec2 x) { return clamp(x, 0.0, 1.0); }
vec3 saturate(vec3 x) { return clamp(x, 0.0, 1.0); }
vec4 saturate(vec4 x) { return clamp(x, 0.0, 1.0); }
vec3 cs2LinearToSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }
uniform int cs2Mode;`);
  s = s.replace(/_Globals_\.g_nOutputMode/g, 'cs2Mode').replace(/void main\(\)/, 'void cs2_main()');
  s = s.replace(new RegExp(`uniform highp sampler2D g_t(${sets})1_g_sTrilinearWrap;`, 'g'), 'uniform highp sampler2DArray cs2_$1;')
    .replace(new RegExp(`uniform highp sampler2D g_t(${sets})[234]_g_sTrilinearWrap;\\n`, 'g'), '');
  s = arrayLookups(s, sets);
  // Modes 1-3 write data through an sRGB->linear step (CS2's targets are sRGB); undo it to get the raw values.
  s += `
void main() {
  cs2_main();
  vec3 raw = cs2LinearToSrgb(output_0.xyz);
  if (cs2Mode == 0) output_0 = vec4(output_0.rgb, 1.0);
  else if (cs2Mode == 1) {
    float x = (raw.x + raw.y) - 1.00392163, y = raw.x - raw.y;
    output_0 = vec4(normalize(vec3(x, y, (1.0 - abs(x)) - abs(y))) * 0.5 + 0.5, raw.z);
  } else output_0 = vec4(raw, 1.0);
}`;
  return s;
}

// Packs the data passes into one texture for three.js: AO (R), roughness (G), metalness (B), cloth mask (A).
const PACK_FS = `precision highp float; uniform sampler2D normalRough, metalCloth, occlusion; in vec2 vUv; out vec4 outColor;
void main() { outColor = vec4(texture(occlusion, vUv).r, texture(normalRough, vUv).a, texture(metalCloth, vUv).g, texture(metalCloth, vUv).b); }`;

function parseGlobals(src) {
  const struct = src.match(/struct (_\d+)\s*\{([^}]*)\};\s*\n\s*uniform \1 _Globals_;/);
  if (!struct) return [];
  return [...struct[2].matchAll(/(?:highp |mediump |lowp )?(\w+)\s+(\w+);/g)].map((m) => ({ type: m[1], name: m[2] }));
}
const samplerNames = (src) => [...src.matchAll(/uniform highp sampler2D (\w+);/g)].map((m) => m[1]);

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

// Copies up to four textures into the layers of one array texture (sRGB layers stay sRGB-encoded).
const COPY_VS = 'precision highp float; in vec3 position; out vec2 vUv; void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }';
const COPY_FS = 'precision highp float; uniform sampler2D src; in vec2 vUv; out vec4 outColor; void main() { outColor = texture(src, vUv); }';
async function layerArray(renderer, urls, srgb, maxSize) {
  const texs = await Promise.all(urls.map((u) => (u ? texture(u, { srgb }) : null)));
  const size = Math.min(maxSize, Math.max(4, ...texs.map((t) => (t ? Math.max(t.image.width, t.image.height) : 4))));
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

// Average linear colour of each layer of an array texture (its smallest mip level), for TextureAverageColor().
const AVG_FS = `precision highp float; precision highp sampler2DArray; uniform sampler2DArray src; out vec4 outColor;
void main() { outColor = textureLod(src, vec3(0.5, 0.5, floor(gl_FragCoord.x)), 16.0); }`;
function layerAverages(renderer, arrayTex, n) {
  const rt = new THREE.WebGLRenderTarget(n, 1, { depthBuffer: false, colorSpace: THREE.NoColorSpace });
  const mat = new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: COPY_VS, fragmentShader: AVG_FS, uniforms: { src: { value: arrayTex } }, depthTest: false, depthWrite: false });
  const q = bakeQuad();
  q.mesh.material = mat;
  renderer.setRenderTarget(rt);
  renderer.render(q.scene, q.camera);
  const px = new Uint8Array(n * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, n, 1, px);
  mat.dispose();
  rt.dispose();
  return Array.from({ length: n }, (_, i) => new THREE.Vector3(px[i * 4] / 255, px[i * 4 + 1] / 255, px[i * 4 + 2] / 255));
}

// The textures both hands share: one array texture per layer set, plus the single textures.
async function loadTextures(renderer, prep, variant) {
  const src = prep.shader.source;
  const p = { ...DEFAULTS };
  for (const [k, v] of Object.entries(prep.kit.color)) if (v?.kind === 'texture') p[k] = v.value;
  const url = (name) => p[name] && (prep.rawTextures[p[name]] || prep.textures[p[name]]);
  const uniforms = {};
  const owned = [];
  const before = renderer.getRenderTarget();
  try {
    for (const [set, max] of Object.entries(variant.sets)) {
      if (!src.includes(`g_t${set}1_g_sTrilinearWrap`)) continue;
      const rt = await layerArray(renderer, [1, 2, 3, 4].map((i) => url(`g_t${set}${i}`)), variant.srgb.test(`g_t${set}1`), max);
      owned.push(rt);
      uniforms['cs2_' + set] = { value: rt.texture };
    }
  } finally {
    renderer.setRenderTarget(before);
  }
  const layered = new RegExp(`^g_t(${setNames(variant)})\\d_`);
  await Promise.all(samplerNames(src).filter((u) => !layered.test(u)).map(async (u) => {
    const m = u.match(/^(g_t[A-Za-z0-9]+)_(.+)$/);
    const name = m ? m[1] : u;
    let t = whiteTex();
    if (url(name)) {
      t = await texture(url(name), { srgb: variant.srgb.test(name) });
      if (/Point|Dummy/.test(m?.[2] || '')) { t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; }
      owned.push(t);
    }
    uniforms[u] = { value: t };
  }));
  const avg = {};
  for (const set of ['Surface', 'Substrate']) {
    if (uniforms['cs2_' + set]) avg[set] = layerAverages(renderer, uniforms['cs2_' + set].value, 4);
  }
  renderer.setRenderTarget(before);
  return { uniforms, avg, dispose: () => { for (const o of owned) o.dispose(); } };
}

// The bake program for a shader variant, kept for the session: CS2's glove shader is large and takes a while to
// compile, so every glove (both hands) of that variant reuses it with its own textures.
const bakeMaterials = new Map();
function bakeMaterial(prep, tex, variant) {
  let mat = bakeMaterials.get(prep.shader.source);
  if (!mat) {
    mat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: prep.shader.layered ? LAYERED_VS : CLASSIC_VS, fragmentShader: adaptFragment(prep.shader.source, variant),
      uniforms: { _Globals_: { value: {} }, cs2Mode: { value: 0 } }, depthTest: false, depthWrite: false,
    });
    bakeMaterials.set(prep.shader.source, mat);
  }
  for (const [k, u] of Object.entries(tex.uniforms)) mat.uniforms[k] = { value: u.value };
  return mat;
}

// Bakes one hand: { color, normal, orm } render targets (orm = AO, roughness, metalness, cloth mask).
function bakeHand(renderer, prep, item, left, tex, mat) {
  const p = handParams(prep, item, left, tex.avg);
  const globals = {};
  for (const { name, type } of parseGlobals(prep.shader.source)) globals[name] = uniformValue(p[name], type);
  const uniforms = mat.uniforms;
  uniforms._Globals_.value = globals;
  for (const [k, v] of Object.entries(p.$vs || {})) uniforms[k] = { value: v };
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
  const metal = target(false), ao = target(false);
  const pack = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: COPY_VS, fragmentShader: PACK_FS, depthTest: false, depthWrite: false,
    uniforms: { normalRough: { value: out.normal.texture }, metalCloth: { value: metal.texture }, occlusion: { value: ao.texture } },
  });
  const q = bakeQuad();
  const prev = renderer.getRenderTarget();
  try {
    q.mesh.material = mat;
    for (const [mode, rt] of [[0, out.color], [1, out.normal], [2, metal], [3, ao]]) {
      uniforms.cs2Mode.value = mode;
      renderer.setRenderTarget(rt);
      renderer.render(q.scene, q.camera);
    }
    q.mesh.material = pack;
    renderer.setRenderTarget(out.orm);
    renderer.render(q.scene, q.camera);
  } catch (e) {
    for (const rt of Object.values(out)) rt.dispose();
    throw e;
  } finally {
    renderer.setRenderTarget(prev);
    pack.dispose();
    metal.dispose();
    ao.dispose();
  }
  return out;
}

// The material of one hand: the baked textures on three's physical material, with cloth sheen where CS2's
// cloth mask says so.
function handMaterial(prep, rt) {
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
  const variant = variantOf(prep);
  const tex = await loadTextures(renderer, prep, variant);
  const mat = bakeMaterial(prep, tex, variant);
  try {
    const out = {};
    for (const name of prep.hands || []) out[name] = handMaterial(prep, bakeHand(renderer, prep, item, /_left$/.test(name), tex, mat));
    return out;
  } finally {
    for (const k of Object.keys(tex.uniforms)) mat.uniforms[k].value = null; // don't hold on to freed textures
    tex.dispose();
  }
}
