// CS2's own sticker material (csgo_weapon_sticker.vfx) in three.js. The sticker's textures come from the player's CS2
// install and are shaded the way the game's decompiled sticker pixel shader does it: PBR colour fitting, foil/gold metal
// with tint, the holographic spectrum (lenticular stickers are holo stickers whose "spectrum" is a set of pictures),
// glitter sparkles, self-illumination and scrape wear. Lighting is three's standard PBR on top.
import * as THREE from 'three';
import { cs2Sticker } from './api.js';
import { loadSource, texture, solidTex } from './textures.js';

// Material expressions of the shader's albedo ranges: float3(-x, -1.4427 * log(1 - y), 2 - z) of the authored levels.
const levels = (x, y, z) => `vec3(${[-x, -1.4427 * Math.log(Math.max(0.0001, 1 - y)), 2 - z].map((v) => v.toFixed(6)).join(', ')})`;
// Direction of the inspect key light (world space); CS2 adds the view angle to it to scroll the holo spectrum.
const KEY_LIGHT = new THREE.Vector3(3, 4, 6).normalize();

const SHADER_PARS = /* glsl */ `
#define CS2_LUM vec3(0.2125, 0.7154, 0.0721)
const vec3 CS2_ALBEDO = ${levels(-0.045, 0.4, 1.15)};
const vec3 CS2_METAL = ${levels(-0.45, 0.4, 1.08)};
const vec3 CS2_DARK_METAL = ${levels(-0.1, 0.4, 1.08)};
const vec3 CS2_HOLO_LEVELS = ${levels(-0.05, 0.35, 1.15)};
const vec3 CS2_KEY_LIGHT = vec3(${KEY_LIGHT.toArray().map((v) => v.toFixed(6)).join(', ')});
uniform sampler2D cs2Sticker;
uniform sampler2D cs2NormalRough;
uniform sampler2D cs2SfxMask;
uniform sampler2D cs2Spectrum;
uniform sampler2D cs2Glitter;
uniform sampler2D cs2Scratches;
uniform sampler2D cs2Backing;
uniform vec3 cs2Tint;
uniform float cs2TintSat;
uniform float cs2Boost;
uniform float cs2SfxBoost;
uniform float cs2GlitterScale;
uniform float cs2Wear;
uniform float cs2WearScratches;
uniform vec2 cs2WearBias;

// Hemi-octahedral normal (RG) as the shader decodes it; +y points down the texture like CS2's texture space.
vec3 cs2HemiOct(vec2 e) {
  float x = (e.x + e.y) - 1.00392163, y = e.x - e.y;
  return normalize(vec3(x, y, (1.0 - abs(x)) - abs(y)));
}
// Fits an authored colour into the albedo range of the given levels (csgo_weapon_sticker's PBR colour fitting).
vec3 cs2Fit(vec3 dir, vec3 c, vec3 lev, float base, float boost, float lum, float lumBoost) {
  vec3 f = max(((dir * base) * 1.732) / length(dir) / dot(dir, CS2_LUM), dir * mix(lev.x, lev.z, saturate(pow(max(c.r, max(c.g, c.b)) * boost, lev.y))));
  return mix(vec3(base), mix(f, min(lev.zzz, f + lum * lumBoost), max(0.0, boost - 1.0) / 63.0), pow(smoothstep(0.0003, base, lum), 0.5));
}
vec3 cs2Sparkle(vec3 s) {
  vec3 sp = max(vec3(0.0), s - 0.99) * 100.0001;
  return vec3(pow(dot(saturate(-s), CS2_LUM), 4.0) + dot(saturate(vec3(0.15) - s), CS2_LUM) * 0.25) + (sp + pow(sp.yzx, vec3(4.0))) * 3.0;
}
// Tangent frame from screen-space derivatives: T along +u, B along +v (down the texture).
mat3 cs2TangentFrame(vec3 p, vec3 n, vec2 uv) {
  vec3 q0 = dFdx(p), q1 = dFdy(p);
  vec2 st0 = dFdx(uv), st1 = dFdy(uv);
  vec3 q1perp = cross(q1, n), q0perp = cross(n, q0);
  vec3 T = q1perp * st0.x + q0perp * st1.x;
  vec3 B = q1perp * st0.y + q0perp * st1.y;
  float det = max(dot(T, T), dot(B, B));
  float sc = det == 0.0 ? 0.0 : inversesqrt(det);
  return mat3(T * sc, B * sc, n);
}
ivec2 cs2Texel(sampler2D t, vec2 uv) {
  ivec2 s = textureSize(t, 0);
  return clamp(ivec2(uv * vec2(s)), ivec2(0), s - 1);
}
`;

const SHADER_SURFACE = /* glsl */ `
vec3 cs2Sparkles = vec3(0.0);
{
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y); // CS2 texture space (rows top-down)
  float inside = all(equal(saturate(uv), uv)) ? 1.0 : 0.0;
  uv = saturate(uv);
  vec3 V = normalize(vViewPosition);
  vec3 Ng = normal;
  mat3 tbn = cs2TangentFrame(-vViewPosition, Ng, uv);

  vec4 col = texture(cs2Sticker, uv, -1.0);
  float a = saturate(col.a * 12.75) * inside; // alpha is also the wear mask; anything above 20/255 is sticker
  vec4 nr = texture(cs2NormalRough, uv, -1.0); // RG normal, B roughness, A self-illum mask
  vec3 ns = cs2HemiOct(nr.xy);
  ns.y = -ns.y;
  vec3 tn = normalize(vec3(0.0, 0.0, 1.0) + ns * a * 2.0);
  float rough = nr.z;
  float metal = float(CS2_METALLIC);

  // Glitter: two layers of tiny mirrors (point-sampled and filtered) that flash as the view changes.
  float gs = 2.5 * cs2GlitterScale;
  vec4 guv = vec4(uv * gs, (vec2(0.5) + uv) * gs);
  vec2 gfw = max(dFdx(guv.xy), dFdy(guv.xy));
#if CS2_GLITTER
  float g = 1.0 - texture(cs2SfxMask, uv, -1.0).a;
  if (g != 0.0) {
    vec4 g1 = texelFetch(cs2Glitter, cs2Texel(cs2Glitter, fract(guv.xy)), 0);
    vec3 n1 = cs2HemiOct(g1.xy);
    n1 *= n1.z;
    vec3 c1 = cs2Sparkle(sin(reflect(V, normalize(tbn * n1)) * 12.0));
    vec4 g2 = textureLod(cs2Glitter, guv.zw, 0.0);
    vec3 n2 = cs2HemiOct(g2.xy);
    vec3 c2 = cs2Sparkle(sin(reflect(V, normalize(tbn * n2)) * 12.0));
    float pert = 0.04 * g * saturate(1.0 - min(gfw.x, gfw.y) * 40.0);
    tn.xy += n1.xy * pert + n2.xy * pert * g2.a;
    vec3 base = col.rgb;
  #if CS2_FIT
    base = cs2Fit(normalize(max(vec3(0.0003), col.rgb)) * 1.06, col.rgb, CS2_ALBEDO, CS2_ALBEDO.x, 1.0, dot(saturate(col.rgb), CS2_LUM), 1.0);
  #endif
    cs2Sparkles = max(c1 * g1.a, c2 * g2.a) * base * cs2SfxBoost * g;
    metal = max(metal, g * 0.5);
  }
#endif

  // Colour: tint (gold) and saturation apply to the metallic part, then the result is fitted to a PBR albedo.
  vec3 albedo = col.rgb;
#if CS2_FIT
  {
    vec3 tint = mix(vec3(1.0), cs2Tint, metal);
    float sat = cs2TintSat * metal;
  #if CS2_LEGACY_TINT
    vec3 c = saturate(mix(col.rgb, vec3(dot(col.rgb, CS2_LUM)), sat) * tint);
    vec3 dir = normalize(max(vec3(0.0003), c)) * 1.06;
  #else
    vec3 c = col.rgb;
    vec3 dir = normalize(max(vec3(0.0003), mix(tint * c, tint, sat))) * 1.06;
  #endif
    float lum = dot(saturate(c * cs2Boost), CS2_LUM);
    vec3 lev = mix(CS2_ALBEDO, mix(CS2_METAL, CS2_DARK_METAL, 1.0 - smoothstep(0.0156, 0.55, lum)), metal);
    albedo = cs2Fit(dir, c, lev, mix(CS2_ALBEDO.x, CS2_DARK_METAL.x, metal), cs2Boost, lum, 1.0);
  }
#elif CS2_METALLIC
  albedo = mix(col.rgb, vec3(dot(col.rgb, CS2_LUM)), cs2TintSat) * cs2Tint * (CS2_LEGACY_TINT == 1 ? cs2Boost : 1.0);
#endif
#if CS2_SELF_ILLUM
  vec3 glow = albedo * nr.w * 2.0;
#endif

  // Holo: the mask picks a spot in the spectrum texture (G, B) and its strength (R); the view angle scrolls it.
#if CS2_HOLO
  {
    vec4 mp = texelFetch(cs2SfxMask, cs2Texel(cs2SfxMask, uv), 0);
    vec3 mk = mix(mp.xyz, texture(cs2SfxMask, uv, -1.0).xyz, mp.w);
    vec2 huv = vec2(mk.y + dot(V, Ng) + dot(V, normalize(mat3(viewMatrix) * CS2_KEY_LIGHT)), mk.z);
  #if CS2_CLAMP_V
    float hh = float(textureSize(cs2Spectrum, 0).y);
    huv.y = clamp(huv.y, 0.5 / hh, 1.0 - 0.5 / hh);
  #endif
    vec3 sp = mix(texelFetch(cs2Spectrum, cs2Texel(cs2Spectrum, fract(huv)), 0).rgb, texture(cs2Spectrum, huv, -1.0).rgb, mp.w);
    float lumH = dot(saturate(sp * cs2SfxBoost), CS2_LUM);
    vec3 holo = cs2Fit(normalize(max(vec3(0.0003), sp)) * 1.06, sp, CS2_HOLO_LEVELS, CS2_HOLO_LEVELS.x, cs2SfxBoost, lumH, cs2SfxBoost);
    albedo = mix(albedo, holo, mk.x);
    metal *= 1.0 - mk.x;
  }
#endif

  // Scrape wear: scratches eat into the sticker in the order of its wear mask (alpha), paper shows through.
  if (cs2Wear > 0.0) {
    float k = 1.0 - min(cs2WearScratches, texture(cs2Scratches, uv, -1.0).r);
    float w2 = mix(k, k * 0.5, cs2Wear);
    float w = saturate(cs2Wear);
    float t = saturate(w - pow(saturate((col.a - 0.078431375) * 1.0851064), cs2WearBias.x * cs2WearBias.x));
  #if CS2_PAPER
    float bias = 0.5;
    float tp = saturate(t * 2.0) + cs2WearBias.y * w;
    albedo = mix(vec3(mix(0.7, 0.2 + 0.4 * w2, w)), albedo, smoothstep(tp, tp + 0.1, w2));
  #else
    float bias = ((cs2WearBias.y * (cs2WearBias.y > 0.0 ? 0.5 : 0.25)) + 0.5) * 0.5;
  #endif
    float th = saturate(t * (1.0 + bias) - bias);
  #if !CS2_METALLIC && !CS2_PRESERVE_ROUGH
    rough = mix(rough, 0.8, step(w2, smoothstep(0.0, 0.35, w)));
  #endif
    albedo = mix(albedo, albedo * w2, w * 0.3);
    a *= smoothstep(th, th + 0.1, w2);
  }

  // Edges bevel outwards; the surface under the sticker stays flat.
  tn.xy = mix(uv - 0.5, tn.xy, a);
  normal = normalize(tbn * normalize(mix(vec3(0.0, 0.0, 1.0), tn, a)));
#if CS2_BACKING
  diffuseColor = vec4(mix(texture(cs2Backing, uv).rgb, saturate(albedo), a), 1.0);
  roughnessFactor = mix(0.4665, rough, a);
  metalnessFactor = metal * a;
#else
  diffuseColor = vec4(saturate(albedo), a);
  roughnessFactor = rough;
  metalnessFactor = metal;
#endif
#if CS2_SELF_ILLUM
  totalEmissiveRadiance += glow * a;
#endif
  cs2Sparkles *= a;
}
`;

// Glitter is lit like the diffuse surface (CS2 multiplies it by the diffuse lighting).
const SHADER_SPARKLE = /* glsl */ `
{
  vec3 irr = irradiance + iblIrradiance;
#if NUM_DIR_LIGHTS > 0
  for (int i = 0; i < NUM_DIR_LIGHTS; i++) irr += directionalLights[i].color * saturate(dot(normal, directionalLights[i].direction));
#endif
  totalEmissiveRadiance += cs2Sparkles * irr * RECIPROCAL_PI;
}
`;

function patchStickerShader(shader) {
  Object.assign(shader.uniforms, this.userData.cs2Uniforms);
  shader.fragmentShader = shader.fragmentShader
    .replace('void main() {', SHADER_PARS + 'void main() {')
    .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + SHADER_SURFACE)
    .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + SHADER_SPARKLE);
}

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

// Stand-ins for textures a material leaves at the shader's default.
const DEFAULT_TEX = {
  g_tNormalRoughnessSticker0: () => solidTex(128, 128, 25, 0), // flat, roughness 0.1 (CS2's default)
  g_tSfxMaskSticker0: () => solidTex(0, 0, 0, 255),
  g_tHoloSpectrumSticker0: () => solidTex(0, 0, 0, 255),
  g_tGlitterNormalSticker0: () => solidTex(128, 128, 0, 0),
  g_tStickerScratches: () => solidTex(0, 0, 0, 255),
  g_tColor: () => solidTex(140, 145, 150, 255),
};

// The sticker's CS2 material as a three.js material. `wear` is the scrape amount (0..1); `backing` makes it opaque
// with CS2's paper backing where the sticker is cut out (standalone sticker) instead of a transparent decal.
// Rejects when the game data is unavailable, so callers can fall back to the icon.
export async function stickerSurface(def, { wear = 0, backing = false } = {}) {
  if (!def?.sm) throw new Error('No CS2 sticker material for ' + def?.n);
  const info = await cs2Sticker(def.sm);
  const t = info.textures;
  if (!t.g_tSticker0) throw new Error('Sticker texture missing for ' + def.sm);
  const clamp = { wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping };
  const load = (name, opts) => (t[name] ? texture(t[name], opts) : DEFAULT_TEX[name]());
  const [sticker, normalRough, sfx, spectrum, glitter, scratches, back] = await Promise.all([
    load('g_tSticker0', { srgb: true, ...clamp }),
    load('g_tNormalRoughnessSticker0', clamp),
    load('g_tSfxMaskSticker0', clamp),
    load('g_tHoloSpectrumSticker0', { srgb: true }),
    load('g_tGlitterNormalSticker0'),
    load('g_tStickerScratches'),
    backing ? load('g_tColor', { srgb: true }) : solidTex(0, 0, 0, 255),
  ]);
  const textures = [sticker, normalRough, sfx, spectrum, glitter, scratches, back];

  // Material parameters; colour tint and tint saturation go through the shader's expressions (sRGB->linear, 1-x).
  const num = (name, def) => info.floats[name] ?? info.ints[name] ?? def;
  const flag = (name, def) => (num(name, def) ? 1 : 0);
  const tint = (info.vectors.g_vColorTintSticker0 || [1, 1, 1]).slice(0, 3).map(srgbToLinear);
  const bias = info.vectors.g_vWearBiasSticker0 || [1, 1];
  const material = new THREE.MeshStandardMaterial(backing ? {} : { transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
  material.defines = {
    USE_UV: '',
    CS2_METALLIC: flag('g_bMetallicSticker0', 0),
    CS2_HOLO: flag('g_bHolographicSticker0', 0),
    CS2_GLITTER: flag('g_bGlitterSticker0', 0),
    CS2_PAPER: flag('g_bPaperBackingSticker0', 0),
    CS2_FIT: flag('g_bAutomaticPBRColorFittingSticker0', 1),
    CS2_LEGACY_TINT: flag('g_bLegacyTintMultiplySticker0', 0),
    CS2_CLAMP_V: flag('g_bClampSpectrumVSticker0', 1),
    CS2_PRESERVE_ROUGH: flag('g_bPreserveRoughnessSticker0', 0),
    CS2_SELF_ILLUM: flag('g_bSelfIllumSticker0', 0),
    CS2_BACKING: backing ? 1 : 0,
  };
  material.userData.cs2Uniforms = {
    cs2Sticker: { value: sticker }, cs2NormalRough: { value: normalRough }, cs2SfxMask: { value: sfx },
    cs2Spectrum: { value: spectrum }, cs2Glitter: { value: glitter }, cs2Scratches: { value: scratches }, cs2Backing: { value: back },
    cs2Tint: { value: new THREE.Vector3(...tint) },
    cs2TintSat: { value: 1 - num('g_flTintSaturateSticker0', 1) },
    cs2Boost: { value: num('g_flColorBoostSticker0', 1) },
    cs2SfxBoost: { value: num('g_flSfxColorBoostSticker0', 1) },
    cs2GlitterScale: { value: num('g_flGlitterScaleSticker0', 1) },
    cs2Wear: { value: Math.max(0, wear) },
    cs2WearScratches: { value: num('g_fWearScratchesSticker0', 1) },
    cs2WearBias: { value: new THREE.Vector2(bias[0] ?? 1, bias[1] ?? 1) },
  };
  material.onBeforeCompile = patchStickerShader;
  material.userData.dispose = () => { for (const x of textures) x.dispose(); };
  const result = { material, image: (await loadSource(t.g_tSticker0)).bitmap, info };
  if (backing) {
    // Back and edges of a standalone sticker: CS2's sticker backing paper.
    result.backing = new THREE.MeshStandardMaterial({ map: back, roughness: 0.4665, metalness: 0 });
  }
  return result;
}

// Normalised bounding box of the visible (alpha > 20/255) part of an image or bitmap.
const boxes = new WeakMap();
export function contentBox(img) {
  if (boxes.has(img)) return boxes.get(img);
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const k = Math.min(1, 256 / Math.max(iw, ih));
  const W = Math.max(1, Math.round(iw * k)), H = Math.max(1, Math.round(ih * k));
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (d[(y * W + x) * 4 + 3] > 20) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  const box = x1 < x0 ? { x0: 0, y0: 0, x1: 1, y1: 1 } : { x0: x0 / W, y0: y0 / H, x1: (x1 + 1) / W, y1: (y1 + 1) / H };
  box.w = box.x1 - box.x0;
  box.h = box.y1 - box.y0;
  boxes.set(img, box);
  return box;
}
