// Charms in 3D: CS2's charm model hung from a point on a gun (it rides along in first person and Play), swinging as the
// gun moves and turned about its chain by its pattern; and a charm on its own (a charm item's inspect). Where it hangs is
// the charm's own place on the gun (moved in the inspect), else the gun model's default spot (CS2's KeychainMarkup).
// A charm model is a short chain of three joints from the clasp (at its origin) with the charm on the end, hanging
// along its -Y (CS2's -Z). A Sticker Slab is the clear case model with its sticker on the card inside, in the
// sticker's own material.
// Charms are drawn with their csgo_weapon materials as CS2 does: tint, colour adjustments, roughness and the effects
// (pearlescence, glitter, iridescence), most of them following the charm's pattern (CS2's dynamic expressions of
// $KeychainSeed: a pattern's colours); the lighter's liquid as csgo_simple_liquid does.
// Two charms react to how they're moved, as in CS2: the 8 Ball's answer goes when it's shaken and comes back, maybe
// another (see shakeWatch), and the lighter's liquid sloshes, wobbles and fizzes (see sloshing).
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { cs2Charm, cs2CharmAttach } from './api.js';
import { loadGltf, skinningBone } from './rig.js';
import { weaponMarkup } from './markup.js';
import { UniformRandomStream } from './rng.js';
import { stickerSurface, SHADER_SPARKLE, KEY_LIGHT } from './sticker.js';
import { D } from '../engine/data.js';
import { itemDef, charmPlacement, CHARM_PATTERNS } from '../engine/items.js';
import { imgUrl, loadImage } from '../util.js';

const INCH = 0.0254;
// Turns a separately exported model (glTF axes) into a bone's axes (CS2's), as for the StatTrak™ counter (skin.js).
const GLTF_TO_BONE = new THREE.Quaternion(0.5, 0.5, 0.5, 0.5);
const DOWN = new THREE.Vector3(0, -1, 0);
const UP = new THREE.Vector3(0, 1, 0);
const GRAVITY = 9.81; // m/s²
const DAMPING = 1.4; // per second: a swing dies down in a couple of seconds
// The pendulum's length for its swing (not where it hangs): a charm's few centimetres of chain swing three times a second,
// a jitter; CS2's charms sway more slowly, about twice a second.
const SWING_LENGTH = 0.06;
// On a gun the charm stays clear of it: its chain never swings in towards the gun's middle, at least far enough out to
// clear the gun's side below its keychain (measured from the gun model, see clearance). It swings at most SWING_MAX from
// hanging straight down, whichever way the gun is held (the inspect shows the Dual Berettas muzzle down). FWD_SWING is
// how far forward or back along the gun clearance allows for.
const DEG = Math.PI / 180;
const OUT_MIN = 6 * DEG, SWING_MAX = 65 * DEG, FWD_SWING = 30 * DEG;
// The most a charm leans out at rest: a wide charm that would need more to clear the gun turns flatter to it instead,
// and where that's not enough rests against it (CS2's charms go through the gun) rather than sticking straight out. Only
// past LEAN_MAX if more than LOST_MAX of it would be lost inside the gun (hung from the top of the gun, say).
const LEAN_MAX = 30 * DEG, LOST_MAX = 0.35;
// How far out from the gun's surface the clasp is: its ring hooks around the edge it hangs from.
const CLASP_GAP = 0.002; // metres

// The Sticker Slab's case: the card inside its window is the top left of the case's colour map.
const SLAB_CARD = { x: 12 / 1024, y: 123 / 1024, w: 486 / 1024, h: 487 / 1024 };

// The way a pattern hangs: its turn about the chain, from the pattern number (Valve's RNG, like skin seeds), up to 45°
// either way from facing out from the gun (further and its face turns along the gun).
export const patternTurn = (pat) => new UniformRandomStream(pat || 0).randomFloat(-Math.PI / 4, Math.PI / 4);
// CS2's $KeychainSeed: the pattern from 0 to 1.
export const keychainSeed = (pat) => Math.max(0, Math.min(1, (pat || 0) / CHARM_PATTERNS));

// ---------------------------------------------------------------------------------------------
// CS2's dynamic material expressions, as the decompiler writes them ("v0 = …;" lines, then "return …;"), evaluated with
// the charm's attributes ({ $KeychainSeed: 0..1, ... }). Values are numbers or vectors (arrays); attributes it doesn't
// have read as 0. Returns null if it can't read one.
// ---------------------------------------------------------------------------------------------
const SWIZZLE = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 };
// Component by component, numbers standing for every component (as HLSL widens them).
const zipN = (args, f) => {
  const vecs = args.filter(Array.isArray);
  if (!vecs.length) return f(...args);
  const n = Math.max(...vecs.map((v) => v.length));
  return Array.from({ length: n }, (_, i) => f(...args.map((a) => (Array.isArray(a) ? a[i] ?? 0 : a))));
};
const zip = (a, b, f) => zipN([a, b], f);
const each = (a, f) => (Array.isArray(a) ? a.map(f) : f(a));
const truthy = (v) => (Array.isArray(v) ? v.some(Boolean) : !!v);
const FUNCS = {
  lerp: (a, b, t) => zipN([a, b, t], (x, y, k) => x + (y - x) * k),
  pow: (a, b) => zip(a, b, Math.pow), min: (a, b) => zip(a, b, Math.min), max: (a, b) => zip(a, b, Math.max),
  step: (e, x) => zip(e, x, (p, q) => (q >= p ? 1 : 0)),
  clamp: (x, lo, hi) => zip(zip(x, lo, Math.max), hi, Math.min),
  saturate: (x) => each(x, (v) => Math.min(1, Math.max(0, v))),
  frac: (x) => each(x, (v) => v - Math.floor(v)), floor: (x) => each(x, Math.floor), ceil: (x) => each(x, Math.ceil),
  abs: (x) => each(x, Math.abs), sign: (x) => each(x, Math.sign), sqrt: (x) => each(x, Math.sqrt), sqr: (x) => each(x, (v) => v * v),
  sin: (x) => each(x, Math.sin), cos: (x) => each(x, Math.cos), tan: (x) => each(x, Math.tan),
  radians: (x) => each(x, (v) => (v * Math.PI) / 180), degrees: (x) => each(x, (v) => (v * 180) / Math.PI),
  float2: (...a) => a.flat().slice(0, 2), float3: (...a) => a.flat().slice(0, 3), float4: (...a) => a.flat().slice(0, 4),
  length: (x) => Math.hypot(...[].concat(x)), normalize: (x) => { const l = Math.hypot(...[].concat(x)) || 1; return each(x, (v) => v / l); },
};
const tokens = new Map(); // (some run every frame)
export function evalExpression(src, attrs = {}) {
  let toks = tokens.get(src);
  if (!toks) tokens.set(src, toks = String(src).match(/\$[\w$]+|[A-Za-z_]\w*|\d*\.\d+|\d+|<=|>=|==|!=|&&|\|\||[-+*/%(),?:<>!.;=]/g) || []);
  let i = 0;
  const locals = {};
  const peek = () => toks[i];
  const take = (t) => { if (toks[i] !== t) throw new Error(`expected ${t}`); i++; };
  const primary = () => {
    const t = toks[i++];
    if (t === undefined) throw new Error('unexpected end');
    if (t === '(') { const v = ternary(); take(')'); return v; }
    if (t === '-') return each(postfix(primary()), (v) => -v);
    if (t === '!') return truthy(postfix(primary())) ? 0 : 1;
    if (/^[\d.]/.test(t)) return parseFloat(t);
    if (t.startsWith('$')) return attrs[t] ?? 0;
    if (peek() === '(') {
      i++;
      if (t === 'exists') { const name = toks[i++]; take(')'); return name in attrs ? 1 : 0; }
      const args = [];
      while (peek() !== ')') { args.push(ternary()); if (peek() === ',') i++; }
      take(')');
      if (!FUNCS[t]) throw new Error('unknown function ' + t);
      return FUNCS[t](...args);
    }
    if (t in locals) return locals[t];
    throw new Error('unknown name ' + t);
  };
  const postfix = (v) => {
    while (peek() === '.') {
      i++;
      const sw = [...toks[i++]].map((c) => (Array.isArray(v) ? v[SWIZZLE[c]] ?? 0 : v));
      v = sw.length === 1 ? sw[0] : sw;
    }
    return v;
  };
  const unary = () => postfix(primary());
  const binary = (next, ops) => () => {
    let v = next();
    while (ops[peek()]) { const f = ops[toks[i++]]; v = f(v, next()); }
    return v;
  };
  const mul = binary(unary, { '*': (a, b) => zip(a, b, (x, y) => x * y), '/': (a, b) => zip(a, b, (x, y) => x / y), '%': (a, b) => zip(a, b, (x, y) => x % y) });
  const add = binary(mul, { '+': (a, b) => zip(a, b, (x, y) => x + y), '-': (a, b) => zip(a, b, (x, y) => x - y) });
  const cmp = binary(add, { '<': (a, b) => zip(a, b, (x, y) => +(x < y)), '<=': (a, b) => zip(a, b, (x, y) => +(x <= y)), '>': (a, b) => zip(a, b, (x, y) => +(x > y)), '>=': (a, b) => zip(a, b, (x, y) => +(x >= y)) });
  const eq = binary(cmp, { '==': (a, b) => zip(a, b, (x, y) => +(x === y)), '!=': (a, b) => zip(a, b, (x, y) => +(x !== y)) });
  const and = binary(eq, { '&&': (a, b) => +(truthy(a) && truthy(b)) });
  const or = binary(and, { '||': (a, b) => +(truthy(a) || truthy(b)) });
  function ternary() {
    const c = or();
    if (peek() !== '?') return c;
    i++;
    const a = ternary();
    take(':');
    const b = ternary();
    return truthy(c) ? a : b;
  }
  try {
    while (i < toks.length) {
      if (toks[i] === 'return') { i++; return ternary(); }
      const name = toks[i++];
      take('=');
      locals[name] = ternary();
      if (peek() === ';') i++;
    }
  } catch (e) { console.warn('charm material expression', src, e.message); }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Materials: csgo_weapon's charm look on three's physical material, from the game's decompiled pixel shader. The colour
// map's tint and adjustments (contrast, brightness, hue about the grey axis weighted by saturation, then saturation;
// masked by the tint mask), a detail texture multiplied in or laid over the colour before them (the pattern moves and
// scales it: Diner Dog's and Lil' Teacup's prints; the 8 Ball's answer follows its last shake), the roughness/metal map
// (roughness in red with its contrast and brightness, metalness in green remapped; the diffuse fades as
// pow(1 - metalness, bias)) and the effects its blue channel, the SFX mask, lets through: pearlescence (the colour's hue turning with the view angle),
// glitter (point-sampled flakes that flash in rainbow colours as the view moves, lit like the surface) and iridescence
// (the reflections' colour turned to a rainbow, keeping its brightness, that scrolls with the view and the light). The
// lighter's tank (csgo_simple_liquid) is the exporter's material with CS2's liquid inside.
// ---------------------------------------------------------------------------------------------
const textures = new Map();
// `point`: CS2's point sampler (the glitter's crisp flakes, whose file has no mips).
function texture(url, srgb, point = false) {
  const key = point ? url + '#point' : url;
  if (!textures.has(key)) {
    const p = new THREE.TextureLoader().loadAsync(url).then((t) => {
      t.flipY = false; // glTF UVs
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 8;
      if (point) { t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; }
      return t;
    });
    textures.set(key, p);
    p.catch(() => textures.delete(key));
  }
  return textures.get(key);
}
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const SHADER_HEAD = `
#define CS2_LUM vec3(0.2125, 0.7154, 0.0721)
uniform sampler2D cs2Rm;
uniform sampler2D cs2TintMap;
uniform vec4 cs2Has; // has roughness/metal map, has tint mask, adjustments on, the detail replaces the colour
uniform vec3 cs2Tint;
uniform vec4 cs2Adjust; // contrast, brightness, saturation, hue (radians)
uniform vec3 cs2Rough; // roughness contrast, brightness, masked by the tint mask
uniform vec2 cs2Metal; // metalness remap
uniform float cs2MetalBias; // metalness transition bias
#ifdef CS2_DETAIL
uniform sampler2D cs2Detail;
uniform vec4 cs2DetailXform; // its UVs' scale and rotation, as two rows
uniform vec4 cs2DetailOpts; // its UVs' offset, blend, masked by the tint mask
#endif
// CS2's hue turn: about the grey axis, weighted by saturation.
vec3 cs2Hue(vec3 c, float a) {
  float ch = cos(a);
  const vec3 K = vec3(0.57735);
  float mx = max(c.r, max(c.g, c.b));
  float s = mx > 0.0 ? (mx - min(c.r, min(c.g, c.b))) / mx : 0.0;
  vec3 rot = c * ch + cross(K, c) * sin(a) + K * dot(K, c) * (1.0 - ch);
  return mix(vec3(dot(c, CS2_LUM)), rot, pow(s, 0.125));
}
vec3 cs2Adj(vec3 c, float mask) {
  vec3 a = clamp(mix(vec3(0.5), c, cs2Adjust.x) * cs2Adjust.y, 0.0, 1.0);
  vec3 b = cs2Hue(a, cs2Adjust.w);
  return mix(c, clamp(mix(vec3(dot(b, CS2_LUM)), b, cs2Adjust.z), 0.0, 1.0), mask);
}
#ifdef CS2_CLEAR
uniform sampler2D cs2ClearMask;
uniform vec4 cs2Clear; // glancing mask, opacity, contrast, brightness
#endif
#ifdef CS2_EFFECTS
uniform float cs2Pearl; // pearlescence: the hue turn (radians) at grazing angles
uniform sampler2D cs2Glitter; // flakes: hemi-octahedral normal (RG), shape (A)
uniform vec4 cs2Glit; // glitter intensity, flakes per UV, rainbow balance, rainbow spread
uniform vec3 cs2Irid; // iridescence strength, scale, hue shift
const vec3 CS2_KEY_LIGHT = vec3(${KEY_LIGHT.toArray().map((v) => v.toFixed(6)).join(', ')});
vec3 cs2HemiOct(vec2 e) {
  float x = (e.x + e.y) - 1.00392163, y = e.x - e.y;
  return normalize(vec3(x, y, (1.0 - abs(x)) - abs(y)));
}
// Tangent frame from screen-space derivatives (no normal map).
mat3 cs2Frame(vec3 p, vec3 n, vec2 uv) {
  vec3 q0 = dFdx(p), q1 = dFdy(p);
  vec2 st0 = dFdx(uv), st1 = dFdy(uv);
  vec3 q1perp = cross(q1, n), q0perp = cross(n, q0);
  vec3 T = q1perp * st0.x + q0perp * st1.x, B = q1perp * st0.y + q0perp * st1.y;
  float det = max(dot(T, T), dot(B, B));
  float sc = det == 0.0 ? 0.0 : inversesqrt(det);
  return mat3(T * sc, B * sc, n);
}
#endif
`;
// The effects, once the normal is known (csgo_weapon's order: pearlescence on the adjusted colour, then glitter).
const SHADER_EFFECTS = `
#ifdef CS2_EFFECTS
  float cs2Sfx = cs2Has.x > 0.5 ? texture2D(cs2Rm, vMapUv).b : 0.0;
  vec3 cs2V = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(vViewPosition);
#endif
#ifdef CS2_PEARL
  diffuseColor.rgb = cs2Hue(diffuseColor.rgb, cs2Pearl * (1.0 - dot(cs2V, normal)) * cs2Sfx);
#endif
#ifdef CS2_GLITTER
  // Each flake is a tiny mirror: the view reflected off it (world space) through sin() makes it flash, white or in
  // rainbow colours; under a flake the surface is smoother, more metal, and a dark colour brighter.
  vec3 cs2Sparkles = vec3(0.0);
  {
    float gi = cs2Sfx * min(1.0, cs2Glit.x);
    vec2 guv = vMapUv * cs2Glit.y;
    vec4 g = texture2D(cs2Glitter, guv);
    vec3 n = cs2HemiOct(g.xy);
    n *= n.z;
  #ifdef USE_NORMALMAP_TANGENTSPACE
    vec3 flake = tbn * n;
  #else
    vec3 flake = cs2Frame(-vViewPosition, normal, vMapUv) * n;
  #endif
    float spread = cs2Glit.w, bal = cs2Glit.z;
    vec3 s = sin(inverseTransformDirection(reflect(cs2V, normalize(normal + flake)), viewMatrix) * mix(12.0, 5.6, spread));
    float th = mix(0.99, 0.8, spread), k = 1.0 / (1.0 - th);
    vec3 hi = max(vec3(0.0), s - th) * k, lo = max(vec3(0.0), -s - th) * k;
    vec3 c = vec3(pow(dot(saturate(-s), CS2_LUM), 4.0) + dot(saturate(vec3(0.15) - s), CS2_LUM) * max(0.0, bal))
      + (hi + pow(hi.yzx + lo * max(0.0, -bal), vec3(4.0 - 3.5 * max(0.0, spread)))) * 4.0 * max(0.0, 1.0 - bal);
    cs2Sparkles = (c * 0.05 + c * normalize(max(diffuseColor.rgb, vec3(0.0003))) * 1.06 * 0.95) * g.a * max(0.0, dot(cs2V, normal)) * cs2Glit.x * cs2Sfx;
    float sparkle = gi * g.a * abs(1.0 - n.z);
    roughnessFactor *= 1.0 - sparkle * 0.25;
    diffuseColor.rgb *= mix(1.0 + sparkle * 2.5, 1.0, smoothstep(0.0, 0.8, dot(diffuseColor.rgb, CS2_LUM)));
    metalnessFactor = max(metalnessFactor, sparkle * 0.5 * gi);
    vec2 fw = max(dFdx(guv), dFdy(guv)); // flakes too small to see stop tilting the surface
    normal = normalize(normal + flake * 0.04 * gi * saturate(1.0 - min(fw.x, fw.y) * 40.0));
  }
#endif
#ifdef CS2_CLEAR
  // F_OPAQUE_REFRACT, the Sticker Slab's clear case: where its mask says, facing you, the colour is what's behind it,
  // brightened (CS2: the blurred frame; here the environment, as for the lighter's tank).
  {
    vec3 V = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(vViewPosition);
    float k = (1.0 - saturate((1.0 - dot(V, normal)) / (1.0 - cs2Clear.x))) * texture2D(cs2ClearMask, vMapUv).r * cs2Clear.y;
  #if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
    vec3 behind = textureCubeUV(envMap, envMapRotation * inverseTransformDirection(-V, viewMatrix), 0.5).rgb * envMapIntensity;
  #else
    vec3 behind = ambientLightColor;
  #endif
    diffuseColor.rgb = mix(diffuseColor.rgb, saturate(mix(vec3(0.5), behind, 1.0 + cs2Clear.z) * cs2Clear.w), k);
  }
#endif
`;
// Iridescence on the specular colour (F0): a rainbow hue from the view against the surface and the key light.
const SHADER_IRIDESCENCE = `
material.diffuseContribution = diffuseColor.rgb * pow(1.0 - metalnessFactor, cs2MetalBias);
#ifdef CS2_IRID
{
  float h = fract((dot(cs2V, nonPerturbedNormal) + dot(cs2V, normalize(mat3(viewMatrix) * CS2_KEY_LIGHT))) * cs2Irid.y + cs2Irid.z) * 6.0;
  vec3 hue = saturate(vec3(abs(h - 3.0) - 1.0, 2.0 - abs(h - 2.0), 2.0 - abs(h - 4.0)));
  vec3 f0 = material.specularColorBlended, hn = normalize(max(hue, vec3(0.001)));
  float lum = dot(f0, CS2_LUM);
  material.specularColorBlended = saturate(mix(f0, hn * min(lum / dot(hn, CS2_LUM), 3.0 * lum * max(hue.r, max(hue.g, hue.b))), cs2Irid.x * cs2Sfx));
}
#endif
`;
function patchShader(shader, u) {
  Object.assign(shader.uniforms, u);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\n' + SHADER_HEAD)
    .replace('#include <map_fragment>', `#include <map_fragment>
      float cs2Mask = cs2Has.y > 0.5 ? texture2D(cs2TintMap, vMapUv).r : 1.0;
      {
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * cs2Tint, cs2Mask);
      #ifdef CS2_DETAIL
        vec2 cs2DetailUv = vec2(dot(cs2DetailXform.xy, vMapUv), dot(cs2DetailXform.zw, vMapUv)) + cs2DetailOpts.xy;
        vec3 cs2DetailRgb = texture2D(cs2Detail, cs2DetailUv).rgb;
        diffuseColor.rgb = mix(diffuseColor.rgb, cs2Has.w > 0.5 ? cs2DetailRgb : diffuseColor.rgb * cs2DetailRgb, cs2DetailOpts.z * (cs2DetailOpts.w > 0.5 ? cs2Mask : 1.0));
      #endif
        if (cs2Has.z > 0.5) diffuseColor.rgb = cs2Adj(diffuseColor.rgb, cs2Mask);
      }`)
    .replace('#include <roughnessmap_fragment>', `float roughnessFactor = roughness;
      if (cs2Has.x > 0.5) {
        float r = texture2D(cs2Rm, vMapUv).r;
        vec2 k = cs2Rough.z > 0.5 ? mix(vec2(1.0), cs2Rough.xy, cs2Mask) : cs2Rough.xy;
        roughnessFactor = clamp(((r - 0.5) * k.x + 0.5) * k.y, 0.04, 1.0);
      }`)
    .replace('#include <metalnessmap_fragment>', `float metalnessFactor = metalness;
      if (cs2Has.x > 0.5) metalnessFactor = mix(cs2Metal.x, cs2Metal.y, texture2D(cs2Rm, vMapUv).g);`)
    .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + SHADER_EFFECTS)
    .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n' + SHADER_IRIDESCENCE)
    .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n#ifdef CS2_GLITTER\n' + SHADER_SPARKLE + '\n#endif');
}

// A material's parameters with its dynamic expressions worked out for these attributes (`dynamic`: just these ones, into
// `p`): { num, vec }, which read a number or a vector with a default.
function readParams(info, attrs, p = { ...info?.params }, dynamic = Object.entries(info?.dynamic || {})) {
  for (const [k, src] of dynamic) {
    const v = evalExpression(src, attrs);
    if (v == null) continue;
    p[k] = Array.isArray(p[k]) && !Array.isArray(v) ? p[k].map(() => v) : v;
  }
  return {
    num: (k, d) => (typeof p[k] === 'number' && Number.isFinite(p[k]) ? p[k] : d),
    vec: (k, d) => (Array.isArray(p[k]) ? p[k] : typeof p[k] === 'number' ? [p[k], p[k], p[k], p[k]] : d),
  };
}
// Reads a material's parameters again as an attribute changes (only the expressions that use it, those being the ones
// that move). Returns fn(value) -> { num, vec }, or null when it has none.
function following(info, attrs, attr) {
  const dynamic = Object.entries(info?.dynamic || {}).filter(([, src]) => src.includes(attr));
  if (!dynamic.length) return null;
  const p = { ...info.params }, now = { ...attrs };
  return (value) => { now[attr] = value; return readParams(info, now, p, dynamic); };
}

// The detail texture's place: CS2 compiles the offset to scale and turn it about its middle.
function placeDetail(xform, opts, { num, vec }, on) {
  const ds = vec('g_vDetailTexCoordScale', [1, 1]), dr = num('g_flDetailTexCoordRotation', 0) * DEG, dc = Math.cos(dr), dn = Math.sin(dr);
  const off = vec('g_vDetailTexCoordOffset', [0, 0]);
  xform.set(ds[0] * dc, -ds[0] * dn, ds[1] * dn, ds[1] * dc);
  opts.x = 0.5 + off[0] - 0.5 * ds[0] * (dc - dn);
  opts.y = 0.5 + off[1] - 0.5 * ds[1] * (dn + dc);
  opts.z = on ? num('g_fDetailBlendFactor', 1) : 0;
}

// A charm material from the service's description (see CS2Service.charm) for this charm's attributes. `base` is the
// exporter's material (the lighter's tank keeps it, with its liquid). Null when it's neither a csgo_weapon material
// with a colour map nor a liquid.
async function charmMaterial(info, attrs, { name = '', base = null } = {}) {
  const read = readParams(info, attrs), { num, vec } = read;
  if (info?.shader === 'csgo_simple_liquid') return base && info.textures?.liquid ? liquidMaterial(info, attrs, base, read) : null;
  if (info?.shader !== 'csgo_weapon' || !info.textures?.color) return null;
  const t = info.textures, f = info.flags || {};
  // The effects it has: CS2 lets them through its SFX mask only, so without one there's nothing to draw.
  const sfx = !!(f.F_ENABLE_SFX_MASK && t.rm);
  const pearl = sfx ? num('g_flPearlescentScale', 0) : 0;
  const glitter = sfx && f.F_GLITTER && t.glitter ? num('g_fGlitterIntensity', 0) : 0;
  const irid = sfx && f.F_IRIDESCENCE ? num('g_flIridescentStrength', 0.75) : 0;
  const shaken = t.detail ? following(info, attrs, '$ent_weapon_shake') : null;
  const blend = t.detail ? num('g_fDetailBlendFactor', 1) : 0;
  const [color, normal, ao, rm, tint, flakes, detail, clear] = await Promise.all([
    texture(t.color, true), t.normal ? texture(t.normal, false) : null, t.ao ? texture(t.ao, false) : null,
    t.rm ? texture(t.rm, false) : null, t.tint && f.F_TINT_MASK ? texture(t.tint, false) : null,
    glitter > 0 ? texture(t.glitter, false, true) : null, blend > 0 || shaken ? texture(t.detail, true) : null,
    t.clear && f.F_OPAQUE_REFRACT ? texture(t.clear, false) : null,
  ]);
  const tc = vec('g_vColorTint', [1, 1, 1]), mr = vec('g_vMetalnessRemapRange', [0, 1]);
  // CS2's non-metals reflect 2% head on (three's default is 4%), and its normal maps' green is up in the art, against the
  // V of its UVs.
  const m = new THREE.MeshPhysicalMaterial({ name, map: color, normalMap: normal, normalScale: new THREE.Vector2(1, -1), aoMap: ao, roughness: 0.5, metalness: 0, ior: 1.3333, envMapIntensity: 1.1 });
  const effects = [pearl && 'CS2_PEARL', glitter > 0 && 'CS2_GLITTER', irid > 0 && 'CS2_IRID'].filter(Boolean);
  if (effects.length) for (const k of ['CS2_EFFECTS', ...effects]) m.defines[k] = '';
  if (detail) m.defines.CS2_DETAIL = '';
  if (clear) m.defines.CS2_CLEAR = '';
  const u = {
    cs2Rm: { value: rm }, cs2TintMap: { value: tint },
    cs2Has: { value: new THREE.Vector4(rm ? 1 : 0, tint ? 1 : 0, f.F_ENABLE_ADJUSTMENTS ? 1 : 0, f.F_DETAIL_TEXTURE ? 1 : 0) },
    cs2Tint: { value: new THREE.Vector3(...tc.slice(0, 3).map(toLinear)) },
    cs2Adjust: { value: new THREE.Vector4(num('g_fContrast', 1), num('g_fBrightness', 1), num('g_fSaturation', 1), (num('g_fHueShift', 0) * Math.PI) / 180) },
    cs2Rough: { value: new THREE.Vector3(num('g_fTextureRoughnessContrast', 1), num('g_fTextureRoughnessBrightness', 1), num('g_bMaskRoughnessAdjustmentsByTintMask', 0)) },
    cs2Metal: { value: new THREE.Vector2(mr[0] ?? 0, mr[1] ?? 1) },
    cs2MetalBias: { value: num('g_flMetalnessTransitionBias', 1) },
    cs2Pearl: { value: pearl },
    // Flakes per UV: the shader's 2.5 (its other view setting is 1.75; sticker.js uses 2.5 too) x glitter scale.
    cs2Glitter: { value: flakes },
    cs2Glit: { value: new THREE.Vector4(glitter, 2.5 * num('g_fGlitterScale', 10) * num('g_flUvScale1', 1), num('g_fGlitterRainbowBalance', 0.25), num('g_fGlitterRainbowSpread', 0)) },
    cs2Irid: { value: new THREE.Vector3(irid, num('g_flIridescentScale', 2), num('g_flIridescentHueShift', 0.5)) },
    cs2ClearMask: { value: clear },
    cs2Clear: { value: new THREE.Vector4(num('g_flRefractGlancingMask', 0), num('g_flRefractOpacity', 1), num('g_flRefractContrast', 0), num('g_flRefractBrightness', 1)) },
    cs2Detail: { value: detail },
    cs2DetailXform: { value: new THREE.Vector4() },
    cs2DetailOpts: { value: new THREE.Vector4(0, 0, 0, num('g_bMaskDetailTextureByTintMask', 0)) },
  };
  placeDetail(u.cs2DetailXform.value, u.cs2DetailOpts.value, read, !!detail);
  // The 8 Ball's answer follows the last shake, for whichever copy of it is about to draw.
  if (shaken) m.userData.cs2Shaken = (shake) => placeDetail(u.cs2DetailXform.value, u.cs2DetailOpts.value, shaken(shake), true);
  m.onBeforeCompile = (shader) => patchShader(shader, u);
  const key = 'cs2charm' + effects.join('') + (detail ? 'CS2_DETAIL' : '') + (clear ? 'CS2_CLEAR' : ''); // a program per set of effects
  m.customProgramCacheKey = () => key;
  return m;
}

// CS2's hue turn (as cs2Hue) of a colour [r, g, b] by `a` radians.
function hueTurn(c, a) {
  const k = 0.57735, cos = Math.cos(a), sin = Math.sin(a), d = k * (c[0] + c[1] + c[2]);
  const rot = [0, 1, 2].map((i) => c[i] * cos + k * (c[(i + 1) % 3] - c[(i + 2) % 3]) * -sin + k * d * (1 - cos));
  const mx = Math.max(...c), s = mx > 0 ? (mx - Math.min(...c)) / mx : 0, w = Math.pow(s, 0.125);
  const lum = 0.2125 * c[0] + 0.7154 * c[1] + 0.0721 * c[2];
  return rot.map((v) => lum + (v - lum) * w);
}

// The lighter's tank (csgo_simple_liquid): the exporter's material with CS2's liquid behind the see-through part (its
// liquid mask). The liquid is coloured by the pattern and fills the tank to the pattern's level, its surface square to
// its own gravity (which follows the swing of a little pendulum in the tank, see sloshing) with a waterline where it
// meets the glass. The surface wobbles in waves that grow with the agitation, and bubbles rise through the liquid,
// bigger near the surface and as it's agitated, until it foams. What shows through the glass and the liquid is the
// environment behind them, refracted (bent by the bubbles) and tinted by them, which CS2 draws as light of its own:
// the liquid's glow.
const LIQUID_HEAD = `
uniform sampler2D cs2LiquidMask;
uniform vec2 cs2MaskRange; // mask minimum, maximum
uniform vec3 cs2Liquid; // the liquid's colour x brightness, hue turned
uniform vec4 cs2Glow; // liquid brightness, inner glow, emissive strength, brightening of the empty part
uniform vec4 cs2Surface; // the level (inches from the liquid's centre), inches per world unit, sharpness, waterline strength
uniform vec4 cs2Refract; // glass and liquid transparency, refracted environment brightness, glass fresnel thickness
uniform vec3 cs2Eta; // glass, liquid and liquid surface refraction
uniform vec3 cs2Up; // the liquid's up, against its gravity (world)
uniform vec3 cs2Centre; // the liquid's centre (world)
uniform vec3 cs2Slosh; // wave time, agitation, the tank's up along the liquid's up
uniform vec4 cs2Wobble; // wave height, wavelength, surface tension, how far back the surface shows from above
uniform vec4 cs2Bubbles; // size, spacing, the agitation's smallest and biggest
uniform vec4 cs2Bubbles2; // shrinking with depth, bending of the refraction, speed, opacity
uniform vec3 cs2BubbleIn;
uniform vec3 cs2BubbleOut;
uniform float cs2BackFade;
// One layer of bubbles: a circle in each cell of a grid, its edge lit and bending what's behind it.
void cs2Bubble(vec2 p, float inv, float edge, inout vec3 colour, inout vec2 bend, inout float sum) {
  vec2 q = (fract(p) * 2.0 - 1.0) * inv;
  float l = length(q), a = saturate(edge * (1.0 - l));
  vec2 n = q * l * l;
  colour += mix(cs2BubbleIn, cs2BubbleOut, length(n)) * a;
  bend += n * a;
  sum += a;
}
`;
const LIQUID_SURFACE = `
vec3 cs2LiquidGlow = vec3(0.0);
{
  float mask = saturate((texture2D(cs2LiquidMask, vMapUv).r - cs2MaskRange.x) / (cs2MaskRange.y + 0.001));
  vec3 V = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(vViewPosition);
  float f = saturate(1.0 - dot(V, normal)), f1 = 1.0 - f, f2 = f1 * f1;
  // Inches from the liquid's centre: along its up, and in the view across and down its gravity (what the waves and bubbles
  // run on). CS2's model and world are in inches.
  vec3 rel = (cameraPosition + (vec4(-vViewPosition, 0.0) * viewMatrix).xyz - cs2Centre) * cs2Surface.y;
  float height = dot(rel, cs2Up);
  vec3 sideways = mat3(viewMatrix) * rel, fall = mat3(viewMatrix) * -cs2Up;
  fall = dot(fall.xy, fall.xy) > 1e-6 ? normalize(vec3(fall.xy, 0.0)) : vec3(0.0, -1.0, 0.0);
  vec2 w = vec2(dot(sideways, cross(fall, vec3(0.0, 0.0, 1.0))), dot(sideways, fall));
  float wave = cs2Slosh.x, agitation = cs2Slosh.y, a = agitation * agitation + 0.01;
  float upright = mix(0.5, 1.0, abs(cs2Slosh.z));
  float level = length(inverseTransformDirection(normal, viewMatrix) * cs2Up), rough = 1.0 - level, turn = wave * 0.104;
  vec2 k = w * cs2Wobble.y * upright * mix(0.2, 0.6, a);
  float waves = (a * exp(sin(dot(vec2(-1.24211, 1.142074), k) + wave * 0.034) - 1.0) * 0.125
    + exp(sin(dot(vec2(2.8211, 2.92074), k) + wave * 0.044) - 1.0) * 0.333333
    + a * exp(sin(dot(vec2(-3.24211, -3.642074), k) + wave * 0.024) - 1.0) * 0.111111
    + a * exp(sin(dot(vec2(3.74211, -3.642074), k) + wave * 0.029) - 1.0) * 0.111111)
    * exp(sin(dot(vec2(-8.74211, 13.642074), k) + turn) * rough * 0.14) * exp(sin(dot(vec2(13.74211, 14.642074), k) - turn) * rough * 0.13)
    * exp(sin(dot(vec2(-23.74211, -13.642074), k) + turn) * rough * 0.1) * exp(sin(dot(vec2(31.74211, -20.642075), k) - turn) * rough * 0.08);
  float wobble = waves * cs2Wobble.x * a * a * upright * 15.0 * (1.5 - f) - a * 0.25;
  float tension = (f * mix(0.25, 1.0, level) + pow(f, 5.0) * 0.8) * cs2Wobble.z;
  float above = dot(inverseTransformDirection(V, viewMatrix), cs2Up); // seen from above
  // The bubbles, in four layers drifting up at their own speeds.
#ifdef USE_NORMALMAP_TANGENTSPACE
  vec2 b = w * cs2Bubbles.y + (texture2D(normalMap, vNormalMapUv).xy - 0.5) * 0.25;
#else
  vec2 b = w * cs2Bubbles.y;
#endif
  float size = 1.5 * cs2Bubbles.x * mix(cs2Bubbles.z, cs2Bubbles.w, pow(agitation, 9.0) + 0.25) / (1.0 + abs((cs2Surface.x + tension + wobble - height) * cs2Bubbles2.x));
  b.y += 0.4 * wobble * size;
  float s1 = sin(b.y) * 0.25 + sin(b.y * 23.1984) * 0.02, s2 = sin(b.x * 1.294) * 0.25 + sin(b.x * 18.1984) * 0.04;
  float inv = 1.0 / max(size, 0.001), edge = 4.0 * (1.0 - roughnessFactor), rise = wave * 0.005 * cs2Bubbles2.z, sum = 0.0;
  vec3 tint = vec3(0.0);
  vec2 bend = vec2(0.0);
  cs2Bubble(((b + vec2(0.2 - s1, 0.356 + s2)) * 0.6 + vec2(0.1, 1.0) * rise * 0.25) * 1.74, inv, edge, tint, bend, sum);
  cs2Bubble(((b + vec2(-0.2 + s1, -0.56 - s2)) * 0.55 + vec2(-0.1, 1.0) * rise * 0.3) * 2.74, inv, edge, tint, bend, sum);
  cs2Bubble(((b + vec2(0.35 - s1 * 0.5, 0.6 - s2 * 0.5)) * 0.5 + vec2(0.13, 1.0) * rise * 0.35) * 4.74, inv, edge, tint, bend, sum);
  cs2Bubble(((b + vec2(-0.42 + s1 * 0.5, -0.76 + s2 * 0.5)) * 0.45 + vec2(-0.14, 1.0) * rise * 0.4) * 5.34, inv, edge, tint, bend, sum);
  float bubbles = sum * size;
  // The surface: inches above it (d), its line on the glass, the liquid in front and, from above, its surface further back.
  float top = cs2Surface.x + wobble + bubbles * 0.025 - abs(above) * 0.05;
  float sharp = cs2Surface.z * mask * mix(1.0, 0.2, pow(roughnessFactor, 1.5));
  float d = height - (top + tension + 1.5 * min(0.3, saturate(1.0 - abs(cs2Up.y))) * (f - 0.2));
  float line = (1.0 - saturate(abs(d - 0.05) * f2 * sharp)) * f2 * cs2Surface.w;
  float front = 1.0 - saturate(d * sharp * 0.25);
  float reach = 1.5 * cs2Wobble.w * pow(saturate(above), 2.0) * f1 * length(rel);
  float fade = 1.0 - saturate(saturate(d / max(reach, 1e-4)) * cs2BackFade * 0.5);
  float back = (1.0 - saturate((d - reach) * sharp * 0.125)) * fade;
  float filled = saturate(line + front + back), cover = saturate(filled * mask), surface = saturate((back - front) * mask);
  vec3 liquid = cs2Liquid * saturate(1.0 - line) * mix(vec3(1.0), tint * 4.0, saturate(cs2Bubbles2.w * bubbles * front));
  vec3 col = diffuseColor.rgb * mix(1.0, 0.2, saturate(2.0 * (f - cs2Refract.w)) * mask);
  col = col * mix(vec3(1.0), liquid, cover) + liquid * cs2Glow.x * f1 * f2 * cover / (1.0 + max(top - height, 0.0)) * cs2Glow.y;
  col *= 1.0 + cs2Glow.w * mask * (1.0 - filled);
  // What's behind, through the bubbles and, from above, the surface.
  bend *= size * front;
  vec3 bent = normalize(mix(normal, V, -0.3) + (vec3(0.0, 1.0, 0.0) * bend.y + cross(vec3(0.0, 1.0, 0.0), -V) * bend.x) * cs2Bubbles2.y);
  vec3 flat2 = normalize(mat3(viewMatrix) * (cs2Up + vec3(0.0, 0.0, wobble * 0.5)));
  bent = normalize(mix(bent, flat2, saturate(1.0 - (saturate(d) - saturate(d - reach)) * 0.5) * saturate(filled) * surface * (0.25 + fade * 0.666667)));
  float eta = mix(mix(cs2Eta.x, cs2Eta.y, filled), cs2Eta.z, surface);
  vec3 through = normalize(mix(normal, mix(normal, bent, 0.75), filled));
  vec3 r = refract(-V, through, eta);
  if (dot(r, r) < 1e-4) r = reflect(-V, through);
#if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
  vec3 env = textureCubeUV(envMap, envMapRotation * inverseTransformDirection(r, viewMatrix), mix(0.1, 1.0, roughnessFactor)).rgb * envMapIntensity;
#else
  vec3 env = ambientLightColor;
#endif
  float open = saturate(mix(cs2Refract.x, cs2Refract.y, filled) * mask);
  vec3 seen = col * mix(1.25, 0.75, f) * env * cs2Refract.z;
  diffuseColor.rgb = mix(col, seen, open);
  cs2LiquidGlow = seen * open + liquid * cover * cs2Glow.z;
  // A light behind the tank shines through it, tinted (CS2: for its sun, with its colour squared).
#if NUM_DIR_LIGHTS > 0
  vec3 rs = refract(-V, normal, mix(eta, 1.0, 0.5));
  if (dot(rs, rs) > 1e-4) {
    float e = 40.0 / (roughnessFactor + 0.2);
    vec3 sun = vec3(0.0);
    for (int i = 0; i < NUM_DIR_LIGHTS; i++) {
      float s = pow(saturate(dot(normalize(rs), directionalLights[i].direction)), e);
      sun += directionalLights[i].color * directionalLights[i].color * (s + pow(s, e * 10.0) * 4.0);
    }
    cs2LiquidGlow += col * sun * mask * mask * 8.0 * mix(cs2Refract.x, cs2Refract.y, filled) * cs2Refract.z;
  }
#endif
}
`;
async function liquidMaterial(info, attrs, base, { num, vec }) {
  const m = base.clone();
  m.envMapIntensity = 1.1;
  const colour = hueTurn(vec('g_vLiquidColor', [0.6, 0.4, 0.1]).slice(0, 3).map((c) => toLinear(c) * num('g_flLiquidBrightness', 1)), (num('g_flLiquidColorHueShift', 0) * Math.PI) / 180);
  const linear = (k, d) => new THREE.Vector3(...vec(k, d).slice(0, 3).map(toLinear));
  const glass = num('g_flGlassRefraction', 1), inside = num('g_flLiquidRefraction', 1);
  const u = {
    cs2LiquidMask: { value: await texture(info.textures.liquid, false) },
    cs2MaskRange: { value: new THREE.Vector2(num('g_flMaskMinimum', 0), num('g_flMaskMaximum', 1)) },
    cs2Liquid: { value: new THREE.Vector3(...colour) },
    cs2Glow: { value: new THREE.Vector4(num('g_flLiquidBrightness', 1), num('g_flLiquidInnerGlow', 0.1), num('g_flLiquidEmissiveStrength', 0), num('g_flBrightenEmptyArea', 3)) },
    cs2Surface: { value: new THREE.Vector4(1e9, 1, num('g_flLiquidSharpness', 100), num('g_flWaterLineStrength', 1)) },
    cs2Refract: { value: new THREE.Vector4(num('g_flCubeRefractTransparency', 1), num('g_flCubeRefractLiquidTransparency', 1), num('g_flCubeRefractBrightness', 1), num('g_flFresnelGlassThickness', 0.2)) },
    cs2Eta: { value: new THREE.Vector3(glass, inside, num('g_flLiquidSurfaceRefraction', inside)) },
    cs2Up: { value: UP.clone() },
    cs2Centre: { value: new THREE.Vector3() },
    cs2Slosh: { value: new THREE.Vector3(0, 0, 1) },
    cs2Wobble: { value: new THREE.Vector4(num('g_flLiquidWobbleScale', 0.02), num('g_flLiquidWobbleWavelength', 6), num('g_flSurfaceTension', 0), num('g_flLiquidBackOffset', 0)) },
    cs2Bubbles: { value: new THREE.Vector4(num('g_flBubbleScale', 0.3), num('g_flBubbleSpaceScale', 1), num('g_flBubblesMinimum', 0.1), num('g_flBubblesMaximum', 0.4)) },
    cs2Bubbles2: { value: new THREE.Vector4(num('g_flBubbleDepthFalloff', 1), num('g_flBubbleStrength', 10), num('g_flBubbleSpeed', 1), num('g_flBubbleOpacity', 1)) },
    cs2BubbleIn: { value: linear('g_vBubbleColorInner', [0, 0, 0]) },
    cs2BubbleOut: { value: linear('g_vBubbleColorOuter', [1, 1, 1]) },
    cs2BackFade: { value: num('g_flLiquidBackFade', 0) },
  };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + LIQUID_HEAD)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + LIQUID_SURFACE)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += cs2LiquidGlow;');
  };
  m.customProgramCacheKey = () => 'cs2liquid';
  // The surface's level (inches about the liquid's centre) when the tank stands up, lies on its side or hangs upside
  // down, how full it is, and what follows the pendulum: its agitation and gravity (CS2's axes).
  const moves = following(info, attrs, LIQUID_ATTR);
  m.userData.cs2Level = {
    surface: u.cs2Surface.value, slosh: u.cs2Slosh.value, liquidUp: u.cs2Up.value, liquidCentre: u.cs2Centre.value,
    height: num('g_flLiquidLevelHeight', 0.5), centre: vec('g_flLiquidCenterOffset', [0, 0, 0]),
    up: vec('g_vLiquidLevelUpwardsMinMidMax', [-1, 0, 1]), side: vec('g_vLiquidLevelSidewardsMinMidMax', [-1, 0, 1]), down: vec('g_vLiquidLevelDownwardsMinMidMax', [-1, 0, 1]),
    waves: 3 * Math.floor(num('g_flLiquidWobbleSpeed', 0.3) * 200),
    follow: (up) => {
      const p = moves ? moves(up) : { num, vec };
      return { agitation: p.num('g_flTestAgitation', 0), gravity: p.vec('g_vTestGravityDir', [0, 0, -1]) };
    },
  };
  return m;
}

// Where a tank's liquid rides, kept on its mesh so a copy of the gun (first person) has it: the bone that carries it,
// and CS2's liquid centre (inches in the model) and the tank's up on that bone.
function liquidAnchor(mesh, root, lv) {
  const bones = mesh.skeleton?.bones || [];
  const bone = bones.find((b) => b.name === 'liquid_surface') || bones.at(-1);
  if (!bone) return;
  root.updateMatrixWorld(true);
  const toBone = bone.matrixWorld.clone().invert().multiply(root.matrixWorld);
  mesh.userData.cs2Liquid = {
    bone: bone.name,
    centre: new THREE.Vector3(lv.centre[1], lv.centre[2], lv.centre[0]).multiplyScalar(INCH).applyMatrix4(toBone).toArray(), // CS2's axes to glTF's
    up: UP.clone().transformDirection(toBone).toArray(),
  };
}

// Keeps the liquid in a holder's tanks moving: CS2's liquid_surface is a rod an inch long in the tank with a light weight
// on its end at half gravity (as the model's cloth has it), its up what CS2's materials read as $bone_upvector. As the tank
// is moved that swings, tipping the liquid's gravity and agitating it through the materials' own expressions, which set
// the level and the waves. `held`: in first person, where the tank's real moves do that, else the inspect's turn does too
// (see LIQUID_ARM). Returns fn(q, dt, gap), run each frame with the holder's turn; each tank draws in its copy's own place
// (the material is shared). Null when the holder has no tank.
function sloshing(holder, held) {
  const tanks = [];
  holder.traverse((o) => { if (o.userData.cs2Liquid) tanks.push(o); });
  if (!tanks.length) return null;
  const bone = tanks[0].skeleton.bones.find((b) => b.name === tanks[0].userData.cs2Liquid.bone);
  const dir = DOWN.clone(), vel = new THREE.Vector3(), next = new THREE.Vector3(), force = new THREE.Vector3();
  const pos = new THREE.Vector3(), size = new THREE.Vector3();
  const pushed = new THREE.Vector3(), turn = new THREE.Vector3(), was = new THREE.Quaternion();
  const moved = inertia(LIQUID_SMOOTH, LIQUID_INERTIA);
  const up = [0, 0, 1]; // the rod's up, CS2's axes (x its z, y its x, z its y)
  const sat = (x) => Math.min(1, Math.max(0, x));
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  for (const mesh of tanks) {
    const at = mesh.userData.cs2Liquid, lv = mesh.material.userData.cs2Level;
    const centre = new THREE.Vector3().fromArray(at.centre), tank = new THREE.Vector3().fromArray(at.up);
    const c = new THREE.Vector3(), u = new THREE.Vector3(), s = new THREE.Vector3();
    mesh.onBeforeRender = () => {
      const { agitation, gravity } = lv.follow(up);
      lv.liquidUp.set(-gravity[1], -gravity[2], -gravity[0]).normalize();
      c.copy(centre).applyMatrix4(bone.matrixWorld);
      u.copy(tank).transformDirection(bone.matrixWorld);
      const tilt = u.dot(lv.liquidUp), h = lv.height;
      const r = mix(mix(lv.down, lv.side, sat(tilt + 1)), lv.up, sat(tilt));
      const low = r[0] + (r[1] - r[0]) * sat(h * 2);
      lv.surface.x = low + (r[2] - low) * sat(h * 2 - 1);
      lv.surface.y = 1 / (INCH * s.setFromMatrixScale(bone.matrixWorld).x);
      lv.liquidCentre.copy(c);
      lv.slosh.set(((performance.now() / 1000) % 200) * lv.waves, agitation, tilt);
    };
  }
  return (q, dt, gap) => {
    if (dt && !held) pushed.add(turnVector(turn, was, q).cross(LIQUID_ARM));
    was.copy(q);
    // (Metres, whatever the charm's scale.)
    pos.setFromMatrixPosition(bone.matrixWorld).divideScalar(size.setFromMatrixScale(bone.matrixWorld).x).add(pushed);
    const acc = moved(pos, 1, dt, gap);
    if (!dt) { dir.copy(DOWN); vel.set(0, 0, 0); } else {
      force.copy(DOWN).multiplyScalar(LIQUID_GRAVITY).sub(acc);
      const n = Math.ceil(dt / SUBSTEP - 1e-6), h = dt / n;
      for (let i = 0; i < n; i++) {
        vel.addScaledVector(force, h).multiplyScalar(Math.exp(-LIQUID_DAMPING * h));
        next.copy(dir).addScaledVector(vel, h / LIQUID_ROD).normalize();
        const side = Math.hypot(next.x, next.z);
        if (next.y > 0 || side > Math.sin(LIQUID_SWING)) {
          const k = Math.sin(LIQUID_SWING) / (side || 1);
          next.set(next.x * k, -Math.cos(LIQUID_SWING), next.z * k);
        }
        vel.subVectors(next, dir).multiplyScalar(LIQUID_ROD / h);
        dir.copy(next);
      }
    }
    up[0] = -dir.z; up[1] = -dir.x; up[2] = Math.min(1, -dir.y);
  };
}

// ---------------------------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------------------------
// A fresh copy of a charm item's model with its pattern's materials: { root, joint (the top joint, which swings), box,
// length (m, clasp to the charm's middle) }.
async function charmModel(charm) {
  const def = itemDef(charm);
  if (!def?.mdl) throw new Error('No model for this charm');
  const info = await cs2Charm(def.mdl, def.mat || null);
  const gltf = await loadGltf(info.model);
  const root = cloneSkinned(gltf.scene);
  let joint = null;
  const meshes = [];
  root.traverse((o) => {
    if (o.isBone && !joint) joint = o;
    if (o.isMesh) { o.frustumCulled = false; meshes.push(o); }
  });
  if (!joint) throw new Error('Charm model has no chain');
  // Never shaken (see shakeWatch), and its liquid at rest (see sloshing).
  const attrs = { $KeychainSeed: keychainSeed(charm.pat), $ent_weapon_shake: [SHAKE_SETTLE, 0], [LIQUID_ATTR]: [0, 0, 1] };
  if (def.slab) {
    const s = D.stickers[def.sk];
    if (s?.rc) attrs.$sticker_rarity_color = [1, 3, 5].map((k) => parseInt(s.rc.slice(k, k + 2), 16) / 255);
  }
  for (const o of meshes) {
    const name = o.material?.name || '';
    const mi = info.materials?.[name];
    const m = mi && await charmMaterial(mi, attrs, { name, base: o.material });
    if (m) {
      if (def.slab && name === 'kc_sticker_display_case') Object.assign(m, { clearcoat: 1, clearcoatRoughness: 0.05 }); // the clear case
      if (m.userData.cs2Level) liquidAnchor(o, root, m.userData.cs2Level);
      o.material = m;
    } else for (const x of [].concat(o.material || [])) x.envMapIntensity = 1.1;
    if (def.slab && name === 'kc_sticker_display_case') await sealSticker(o, def, mi?.textures?.color);
  }
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  return { root, joint, box, length: Math.max(0.008, -box.getCenter(new THREE.Vector3()).y) };
}

// A Sticker Slab's sticker on the card inside its case (the case's mesh `o`), as CS2 draws it: the sticker's own
// material (holo, foil, glitter, gold, lenticular... see sticker.js) in the case's second UV set, where the sticker is
// a square inch on the card (its offset and scale at their defaults). A decal of the card's triangles that carry it,
// skinned like the case. Without the game's sticker material, its icon printed on the card instead.
async function sealSticker(o, def, colorUrl) {
  try {
    const surf = await stickerSurface(D.stickers[def.sk]);
    const geo = stickerCard(o.geometry);
    if (!geo) throw new Error('No sticker card on the slab model');
    const decal = new THREE.SkinnedMesh(geo, surf.material);
    decal.bind(o.skeleton, o.bindMatrix);
    decal.position.copy(o.position);
    decal.quaternion.copy(o.quaternion);
    decal.scale.copy(o.scale);
    decal.frustumCulled = false;
    decal.renderOrder = 2;
    decal.userData.card = true; // its geometry is its own
    o.parent.add(decal);
  } catch (e) {
    console.warn('CS2 sticker material unavailable for the slab, printing its icon:', e);
    if (colorUrl && o.material?.map) o.material.map = await printSticker(colorUrl, def);
  }
}

// The triangles of a mesh's geometry where its second UV set (the sticker's) covers 0..1, as a geometry of their own
// with that UV set as its UVs (flipped to the decals' convention, see sticker.js).
function stickerCard(src) {
  const uv1 = src.attributes.uv1, idx = src.index;
  if (!uv1) return null;
  const keep = [], n = idx ? idx.count : uv1.count;
  for (let t = 0; t + 2 < n; t += 3) {
    const v = [t, t + 1, t + 2].map((i) => (idx ? idx.getX(i) : i));
    const us = v.map((i) => uv1.getX(i)), vs = v.map((i) => uv1.getY(i));
    if (Math.max(...us) > 0 && Math.min(...us) < 1 && Math.max(...vs) > 0 && Math.min(...vs) < 1) keep.push(...v);
  }
  if (!keep.length) return null;
  const geo = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'skinIndex', 'skinWeight']) {
    const a = src.attributes[name];
    if (!a) continue;
    const out = new Float32Array(keep.length * a.itemSize);
    keep.forEach((i, j) => { for (let c = 0; c < a.itemSize; c++) out[j * a.itemSize + c] = a.getComponent(i, c); });
    geo.setAttribute(name, new THREE.BufferAttribute(out, a.itemSize));
  }
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(keep.flatMap((i) => [uv1.getX(i), 1 - uv1.getY(i)]), 2));
  return geo;
}

// A Sticker Slab's colour map with its sticker's icon printed on the card inside the case (a texture of its own).
async function printSticker(colorUrl, def) {
  const [base, sticker] = await Promise.all([texture(colorUrl, true), loadImage(imgUrl(D.stickers[def.sk]?.img, 'l'))]);
  const im = base.image, art = artBox(sticker); // Steam's sticker icons are mostly margin
  const c = document.createElement('canvas');
  c.width = im.width; c.height = im.height;
  const g = c.getContext('2d');
  g.drawImage(im, 0, 0);
  const W = SLAB_CARD.w * c.width, H = SLAB_CARD.h * c.height;
  const k = Math.min(W / art.w, H / art.h) * 0.86;
  const w = art.w * k, h = art.h * k;
  g.drawImage(sticker, art.x, art.y, art.w, art.h, SLAB_CARD.x * c.width + (W - w) / 2, SLAB_CARD.y * c.height + (H - h) / 2, w, h);
  const map = new THREE.CanvasTexture(c);
  Object.assign(map, { colorSpace: THREE.SRGBColorSpace, flipY: false, anisotropy: 8 });
  return map;
}

// The part of an image that isn't transparent: { x, y, w, h }.
function artBox(im) {
  const W = im.naturalWidth, H = im.naturalHeight, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(im, 0, 0);
  const a = g.getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) if (a[(y * W + x) * 4 + 3] > 20) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return x1 > x0 ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : { x: 0, y: 0, w: W, h: H };
}

// The holder a charm hangs in. turn: its turn about the chain. frame (on a gun): the gun's down and outward directions in
// the holder's frame, { down, out }, which keep it clear of the gun; none on its own.
function holderFor(m, turn, frame = null) {
  const holder = new THREE.Group();
  holder.name = 'charm';
  holder.userData.charm = { length: m.length, turn, rest: m.joint.quaternion.toArray(), frame };
  holder.add(m.root);
  swingCharm(holder);
  return holder;
}

// On a gun the charm feels the gun's own acceleration up to INERTIA_MAX: a flick spins the inspect's gun far faster
// than a hand turns one (twenty g at its keychain), which flung the charm from one limit to the other.
const INERTIA_MAX = 1.5 * GRAVITY; // m/s²
// A drag moves the gun in steps (on a fast screen a slow mouse moves it one frame and not the next): the clasp's velocity
// is smoothed for this long, twice, before its acceleration is read from it, which then doesn't depend on the steps.
const INERTIA_SMOOTH = 0.03; // s
// How quickly a charm untwists on its chain after the gun has turned it over.
const UNTWIST = 0.2; // s
// A charm on its own turns with the view as one piece, its body trailing the turn a little on its chain: a damped spring
// (SWAY_SPRING rad/s, SWAY_DAMPING of critical, so it overshoots a little when you stop) towards a lag of SWAY_LAG
// seconds of the turn, at most SWAY_MAX (less about its chain).
const SWAY_LAG = 0.03, SWAY_MAX = 0.18, SWAY_TWIST = 0.5; // s, rad, share about the chain
const SWAY_SPRING = 10, SWAY_DAMPING = 0.35;
// Both are worked out in steps of at most this (the same at any frame rate).
const SUBSTEP = 1 / 240; // s
// The lighter's pendulum (see sloshing), and what CS2's materials read it as.
const LIQUID_ROD = INCH, LIQUID_GRAVITY = 180 * INCH; // m, m/s²: CS2's 360 units/s² at the model's half gravity
// The model smooths a keychain's motion before its cloth feels it (motion_smooth_cdt 0.25, critically damped: two stages of
// half that). CS2's rod has no damping of its own and no limits but its solver's: these keep it from going over the top
// of the tank (the liquid would jump to the other end) or past where CS2's agitation turns it all to black foam, at 40°.
const LIQUID_SMOOTH = 0.125, LIQUID_INERTIA = 0.4 * GRAVITY, LIQUID_DAMPING = 3, LIQUID_SWING = 35 * DEG; // s, m/s², per second, radians
const LIQUID_ATTR = '$bone_upvector$liquid_surface';
// CS2's shake (its weapons' tick, in client.dll): each tick the weapon's move goes in a ring of its last ticks, and more than
// turns changes of direction among them along either axis, counting moves over STEP inches a tick, is a shake. It won't
// shake again for SETTLE seconds, as long as the 8 Ball's answer takes to come back.
const SHAKE_TICK = 1 / 64, SHAKE_STEP = 1, SHAKE_SETTLE = 3; // s, inches, s
const SHAKE_HELD = { ticks: 32, turns: 5 };
// CS2's inspect has no shake (a charm with no weapon reads a fixed "settled"), so this is ours: there it's the turn that
// counts, as if your hand were TURN_ARM inches away (four radians a second is STEP), and a mouse doesn't go back and forth
// as fast as a gun on a moving player: a second's worth of ticks, left-right-left-right.
const SHAKE_TURNED = { ticks: 64, turns: 3 }, TURN_ARM = 16;
// A charm turned in the inspect barely moves through space, so its liquid would feel nothing: the turn pushes it as if
// from that hand, out below and in front of it (so that a turn about any axis tips it).
const LIQUID_ARM = new THREE.Vector3(0, -1, -1).normalize().multiplyScalar(TURN_ARM * INCH); // m

// The turn from one orientation to another, as a vector along its axis as long as its angle (radians, world axes).
const turnVector = (() => {
  const d = new THREE.Quaternion();
  return (out, from, to) => {
    d.copy(from).invert().premultiply(to);
    if (d.w < 0) d.set(-d.x, -d.y, -d.z, -d.w);
    const sin = Math.hypot(d.x, d.y, d.z);
    return out.set(d.x, d.y, d.z).multiplyScalar(sin > 1e-9 ? (2 * Math.atan2(sin, d.w)) / sin : 2);
  };
})();

// A point's acceleration (m/s², it may be scaled) from its last moves, none across a pause; at most `most`, its velocity
// smoothed twice for `smooth` seconds (see INERTIA_SMOOTH). Returns fn(point, scale, dt, gap) -> the acceleration, reused.
function inertia(smooth = INERTIA_SMOOTH, most = INERTIA_MAX) {
  const at = new THREE.Vector3(), v = new THREE.Vector3(), slow = new THREE.Vector3(), slower = new THREE.Vector3(), acc = new THREE.Vector3();
  let moving = 0; // frames its velocity has been known for
  return (p, scale, dt, gap) => {
    if (!dt) { moving = 0; acc.set(0, 0, 0); } else {
      v.subVectors(p, at).divideScalar(dt * Math.abs(scale));
      moving = gap ? 0 : moving + 1;
      if (moving < 2) { slow.copy(v); slower.copy(v); }
      const k = 1 - Math.exp(-dt / smooth);
      acc.copy(slower);
      slower.lerp(slow.lerp(v, k), k);
      acc.subVectors(slower, acc).divideScalar(dt);
      if (acc.length() > most) acc.setLength(most);
    }
    at.copy(p);
    return acc;
  };
}

// Watches a holder for CS2's shake (see SHAKE_HELD): { x: seconds since the last shake (from SHAKE_SETTLE: settled), y: when
// it was, feed(...) each frame }: what CS2's $ent_weapon_shake reads. `held`: in first person, where it's the clasp's
// moves across the world that count; else the inspect's turn (SHAKE_TURNED). The moves are shared out among fixed ticks, so
// it's the same at any frame rate. The 8 Ball's answer is y's seconds modulo 3, CS2 leaving it to the clock; in CS2 that's
// the same answer again one time in three, here the next one along, so a shake always changes it.
function shakeWatch(held) {
  const { ticks, turns } = held ? SHAKE_HELD : SHAKE_TURNED;
  const ring = new Float32Array(ticks * 3), sum = [0, 0, 0], move = [0, 0, 0];
  const at = new THREE.Vector3(), was = new THREE.Quaternion(), turn = new THREE.Vector3();
  let head = 0, count = 0, inTick = 0, when = -Infinity;
  const shaken = () => {
    for (let axis = 0; axis < 3; axis++) {
      let sign = 0, n = 0;
      for (let i = 0; i < count; i++) {
        const v = ring[((head + ticks - count + i) % ticks) * 3 + axis];
        if (Math.abs(v) > SHAKE_STEP && Math.sign(v) !== sign) { sign = Math.sign(v); n++; }
      }
      if (n > turns) return true;
    }
    return false;
  };
  const answer = (y) => Math.max(1, Math.ceil(y % 3));
  const watch = {
    x: SHAKE_SETTLE, y: 0,
    feed(anchor, q, scale, dt, gap, now) {
      if (gap) { count = inTick = 0; sum.fill(0); } else if (dt) {
        if (held) {
          const k = 1 / (Math.abs(scale) * INCH);
          move[0] = (anchor.x - at.x) * k; move[1] = (anchor.z - at.z) * k; move[2] = 0;
        } else {
          turnVector(turn, was, q).multiplyScalar(TURN_ARM).toArray(move);
        }
        for (let left = dt; left > 1e-9;) {
          const take = Math.min(left, SHAKE_TICK - inTick);
          for (let i = 0; i < 3; i++) sum[i] += (move[i] * take) / dt;
          inTick += take; left -= take;
          if (inTick < SHAKE_TICK - 1e-9) continue;
          ring.set(sum, head * 3);
          head = (head + 1) % ticks; count = Math.min(count + 1, ticks); inTick = 0; sum.fill(0);
          if (now - when >= SHAKE_SETTLE && shaken()) {
            when = now;
            watch.y = answer(now) === answer(watch.y) ? now + 1 : now;
          }
        }
      }
      at.copy(anchor); was.copy(q);
      watch.x = Math.min(SHAKE_SETTLE, now - when);
    },
  };
  return watch;
}

// Hangs a holder's charm from its clasp: on a gun (see holderFor) a damped pendulum under gravity (world -Y) that
// swings as the gun moves, kept clear of the gun; on its own, turned with the view and trailing it a little. It runs as
// the holder's world matrix is worked out each frame, and so do the charm's reactions to being moved: the liquid in a
// tank (see sloshing) and the 8 Ball's shake (see shakeWatch). First person calls this again on its copy of the gun, as
// `held`.
export function swingCharm(holder, { held = false } = {}) {
  const { turn, rest, frame } = holder.userData.charm;
  let joint = null;
  const shaken = [];
  holder.traverse((o) => {
    if (o.isBone && !joint) joint = o;
    if (o.material?.userData?.cs2Shaken) shaken.push(o);
  });
  if (!joint) return;
  const slosh = sloshing(holder, held), watch = shaken.length ? shakeWatch(held) : null;
  // (The material is shared with any other copy of the gun: each sets it as it draws.)
  const shake = [SHAKE_SETTLE, 0];
  for (const mesh of shaken) {
    const show = mesh.material.userData.cs2Shaken;
    mesh.onBeforeRender = () => { shake[0] = watch.x; shake[1] = watch.y; show(shake); };
  }
  const restQ = new THREE.Quaternion().fromArray(rest);
  const twist = new THREE.Quaternion().setFromAxisAngle(UP, turn);
  const step = frame ? hanging(holder.userData.charm) : trailing();
  const anchor = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(), swing = new THREE.Quaternion();
  const update = Object.getPrototypeOf(holder).updateMatrixWorld;
  let last = 0;
  holder.updateMatrixWorld = function (force) {
    if (this.matrixAutoUpdate) this.updateMatrix();
    if (this.parent) this.matrixWorld.multiplyMatrices(this.parent.matrixWorld, this.matrix);
    else this.matrixWorld.copy(this.matrix);
    this.matrixWorld.decompose(anchor, q, s);
    // Once a frame (the matrix is worked out more often than that); after a pause it carries on from where it was.
    const now = performance.now() / 1000, dt = now - last, stepped = !last || dt > 0.001;
    const h = last ? Math.min(dt, 0.1) : 0, gap = !last || dt > 0.25;
    if (stepped) {
      step(swing, anchor, q, s.x, h, gap);
      watch?.feed(anchor, q, s.x, h, gap, now);
      last = now;
    }
    joint.quaternion.copy(swing).multiply(twist).multiply(restQ);
    update.call(this, true);
    if (stepped) slosh?.(q, h, gap);
  };
}

// A chain's direction on a gun: `o` out from the gun's side, `f` round it from straight down the gun.
const chainDir = (v, down, out, fwd, o, f) => v.copy(down).multiplyScalar(Math.cos(f)).addScaledVector(fwd, Math.sin(f)).multiplyScalar(Math.cos(o)).addScaledVector(out, Math.sin(o));

// On a gun: a pendulum from the clasp worked out in the holder's (the gun's) frame, pulled by gravity and pushed by the
// gun's acceleration (both turned into it), kept within its limits. Sets the swing, the turn from hanging straight down
// the holder to the chain's direction.
function hanging({ length, frame }) {
  const L = Math.max(SWING_LENGTH, length);
  const down = new THREE.Vector3().fromArray(frame.down), out = new THREE.Vector3().fromArray(frame.out);
  const fwd = new THREE.Vector3().crossVectors(out, down);
  const outMin = frame.outMin ?? OUT_MIN;
  // The nearest direction clear of the gun.
  const limit = (v) => chainDir(v, down, out, fwd, Math.max(outMin, Math.asin(Math.max(-1, Math.min(1, v.dot(out))))), Math.atan2(v.dot(fwd), v.dot(down)));
  const dir = new THREE.Vector3(), vel = new THREE.Vector3(), next = new THREE.Vector3(), force = new THREE.Vector3();
  const moved = inertia(), qi = new THREE.Quaternion(), hang = new THREE.Vector3(), away = new THREE.Vector3();
  const was = new THREE.Vector3(), turned = new THREE.Quaternion(), straight = new THREE.Quaternion();
  // A world direction in the holder's frame: a mirrored gun (Play's left-handed viewmodel) has a negative x scale.
  const toGun = (w, scale) => { w.applyQuaternion(qi); if (scale < 0) w.x = -w.x; return w; };
  return (swing, anchor, q, scale, dt, gap) => {
    qi.copy(q).invert();
    toGun(force.copy(DOWN).multiplyScalar(GRAVITY), scale);
    hang.copy(force).normalize();
    const acc = moved(anchor, scale, dt, gap);
    if (!dt) {
      // Hanging still: straight down (as far as the gun lets it).
      limit(dir.copy(force).normalize());
      vel.set(0, 0, 0);
    } else {
      force.sub(toGun(acc, scale));
      // The bob keeps its (damped) velocity and falls, the chain holds it at its length and the gun stops it at the limits.
      const n = Math.ceil(dt / SUBSTEP - 1e-6), h = dt / n;
      for (let i = 0; i < n; i++) {
        vel.addScaledVector(force, h).multiplyScalar(Math.exp(-DAMPING * h));
        limit(next.copy(dir).addScaledVector(vel, h / L).normalize());
        vel.subVectors(next, dir).multiplyScalar(L / h);
        // Past SWING_MAX it stops going further: hanging straight down moves as the gun turns, which mustn't throw it.
        const a = next.angleTo(hang);
        if (a > SWING_MAX) {
          away.copy(next).multiplyScalar(next.dot(hang)).sub(hang).normalize();
          vel.addScaledVector(away, -Math.max(0, vel.dot(away)));
          limit(next.multiplyScalar(Math.sin(SWING_MAX)).addScaledVector(hang, Math.sin(a - SWING_MAX)).divideScalar(Math.max(1e-6, Math.sin(a))).normalize());
        }
        dir.copy(next);
      }
    }
    // It turns the shortest way from where it was, easing back to the shortest way from hanging straight down the gun
    // (on its own that flips the charm round on its chain as the gun goes upside down).
    straight.setFromUnitVectors(DOWN, dir);
    if (dt) swing.premultiply(turned.setFromUnitVectors(was, dir)).slerp(straight, 1 - Math.exp(-dt / UNTWIST));
    else swing.copy(straight);
    was.copy(dir);
  };
}

// On its own: no swing but a little trail behind the view's turn, about the clasp (see SWAY_LAG).
function trailing() {
  const lag = new THREE.Vector3(), lagVel = new THREE.Vector3(), rate = new THREE.Vector3(), spin = new THREE.Vector3();
  const aim = new THREE.Vector3(), axis = new THREE.Vector3(), was = new THREE.Quaternion(), d = new THREE.Quaternion();
  const k = SWAY_SPRING * SWAY_SPRING, c = 2 * SWAY_DAMPING * SWAY_SPRING;
  return (swing, anchor, q, scale, dt, gap) => {
    if (dt && !gap) {
      // How fast it's turning, in its own frame, smoothed over a few frames (a drag turns it in uneven steps).
      d.copy(was).invert().multiply(q);
      if (d.w < 0) d.set(-d.x, -d.y, -d.z, -d.w);
      const angle = 2 * Math.acos(Math.min(1, d.w)), sin = Math.sqrt(Math.max(0, 1 - d.w * d.w));
      spin.set(d.x, d.y, d.z).multiplyScalar(sin > 1e-6 ? angle / sin / dt : 0);
      rate.lerp(spin, 1 - Math.exp(-dt / 0.05));
      // The lag it springs towards: against the turn, easing off towards its most.
      aim.copy(rate).multiplyScalar(-SWAY_LAG);
      aim.y *= SWAY_TWIST;
      const a = aim.length();
      if (a > 1e-9) aim.multiplyScalar((SWAY_MAX * Math.tanh(a / SWAY_MAX)) / a);
      const n = Math.ceil(dt / SUBSTEP - 1e-6), h = dt / n;
      for (let i = 0; i < n; i++) {
        lagVel.addScaledVector(spin.subVectors(aim, lag), k * h).multiplyScalar(Math.max(0, 1 - c * h));
        lag.addScaledVector(lagVel, h);
      }
    } else if (gap) rate.set(0, 0, 0);
    was.copy(q);
    const a = lag.length();
    swing.setFromAxisAngle(a > 1e-9 ? axis.copy(lag).divideScalar(a) : UP, a);
  };
}

// How far out the charm's chain must lean to clear the gun's side under its keychain (a lean angle): CS2's charm rests
// against the gun where its side is wider than the keychain sits out (most pistols and the M4s). The gun's surface
// (vertices and triangle middles, in the holder's frame) gives its outermost point in each cell of a grid below the
// keychain (depth along the gun's down by distance along it); the charm, turned as it hangs, must stay out beyond those,
// by `need`: SWUNG leaning straight down the gun and swung forward and back as far as it goes, RESTING just leaning, both
// up to LEAN_MAX; SHOWING beyond it, with most of it out of the gun. Infinity when nothing manages that. Cached per gun
// model (with or without its StatTrak™ counter), charm and turn.
const CELL = 0.004, MARGIN = 0.0015, CLASP = 0.01;
const SWUNG = 0, RESTING = 1, SHOWING = 2;
const clearances = new Map();
// The gun's surface: its visible meshes' vertices and triangle middles, in the gun model's own frame (metres).
function gunSurface(root) {
  root.updateMatrixWorld(true);
  const toRoot = root.matrixWorld.clone().invert();
  const pts = [], v = new THREE.Vector3(), c = new THREE.Vector3();
  root.traverse((o) => {
    if (!o.isMesh || o.userData.decal) return;
    for (let n = o; n; n = n.parent) if (!n.visible || n.userData.charm) return; // not a charm already on it
    const pos = o.geometry.attributes.position, idx = o.geometry.index, local = new Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      o.getVertexPosition(i, v); // skinned, on a skinned mesh
      pts.push(local[i] = v.clone().applyMatrix4(o.matrixWorld).applyMatrix4(toRoot));
    }
    const tri = idx ? idx.count / 3 : pos.count / 3;
    for (let t = 0; t < tri; t++) {
      const a = idx ? idx.getX(t * 3) : t * 3, b = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, e = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      pts.push(c.copy(local[a]).add(local[b]).add(local[e]).divideScalar(3).clone());
    }
  });
  return pts;
}
function clearance(surface, toHolder, down, out, m, turn, need, key) {
  if (clearances.has(key)) return clearances.get(key);
  const fwd = new THREE.Vector3().crossVectors(out, down);
  // The charm's points as it hangs (turned, before leaning), in its own frame.
  m.root.updateMatrixWorld(true);
  const pts = [];
  const v = new THREE.Vector3();
  m.root.traverse((o) => {
    if (!o.isMesh) return;
    const n = o.geometry.attributes.position.count, step = Math.max(1, Math.floor(n / 600));
    for (let i = 0; i < n; i += step) pts.push(o.getVertexPosition(i, v).clone().applyMatrix4(o.matrixWorld));
  });
  const twist = new THREE.Quaternion().setFromAxisAngle(UP, turn);
  for (const p of pts) p.applyQuaternion(twist);
  const reach = Math.max(...pts.map((p) => p.length())) + CELL;
  // The clasp hooks onto the gun at its keychain (on some guns right at the surface): only the charm below it counts.
  const body = pts.filter((p) => p.length() > CLASP);
  // The gun's outermost surface per cell within reach of the charm.
  const grid = new Map();
  const cell = (d, f) => Math.floor(d / CELL) + ':' + Math.floor(f / CELL);
  const note = (p) => {
    const d = p.dot(down), f = p.dot(fwd), o = p.dot(out);
    if (d < -reach || d > reach || Math.abs(f) > reach || o > reach) return; // (the Dual Berettas' other pistol)
    const k = cell(d, f);
    if (!(grid.get(k) >= o)) grid.set(k, o);
  };
  for (const s of surface) note(v.copy(s).applyMatrix4(toHolder));
  const near = (d, f) => {
    let best = -Infinity;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) { const g = grid.get(cell(d + i * CELL, f + j * CELL)); if (g > best) best = g; }
    return best;
  };
  const sw = new THREE.Quaternion(), dir = new THREE.Vector3(), p = new THREE.Vector3();
  const clear = (lean, along, lost = 0.01) => {
    sw.setFromUnitVectors(DOWN, chainDir(dir, down, out, fwd, lean, along));
    let bad = 0;
    for (const q of body) {
      p.copy(q).applyQuaternion(sw);
      if (p.dot(out) < near(p.dot(down), p.dot(fwd)) + MARGIN && ++bad > body.length * lost) return false;
    }
    return true;
  };
  const ok = [(a) => clear(a, 0) && clear(a, FWD_SWING) && clear(a, -FWD_SWING), (a) => clear(a, 0), (a) => clear(a, 0, LOST_MAX)][need];
  const most = need === SHOWING ? SWING_MAX : LEAN_MAX;
  let lean = need === SHOWING ? LEAN_MAX : OUT_MIN;
  while (lean < most + DEG && !ok(lean)) lean += 2 * DEG;
  if (lean >= most + DEG) lean = Infinity;
  clearances.set(key, lean);
  return lean;
}

// The gun model's own frame (CS2's model space): its top bone's parent. glTF's axes there are CS2's turned Y-up: x is
// CS2's y (the gun's left), y its z (up), z its x (forward).
function modelFrame(root) {
  let top = null;
  root.traverse((o) => { if (!top && o.isBone) top = o; });
  while (top?.parent?.isBone) top = top.parent;
  return top?.parent || null;
}
const toFrame = ([x, y, z]) => new THREE.Vector3(y, z, x);
const fromFrame = (v) => [v.z, v.x, v.y];

// The gun model's default spot for a charm: the middle of its default KeychainMarkup quad (the legacy model's or not),
// facing out from the side it's on.
function defaultPlacement(mk, legacy) {
  const quads = mk?.keychain || [];
  const q = quads.find((k) => k.def && k.legacy === legacy) || quads.find((k) => k.def);
  if (!q) return null;
  const [a, b, c, d] = q.corners.map((v) => new THREE.Vector3(...v));
  const p = a.clone().add(b).add(c).add(d).multiplyScalar(0.25);
  const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
  if (n.y * p.y < 0 || (Math.abs(p.y) < 0.05 && n.z < 0)) n.negate();
  return { b: q.bone, p: p.toArray(), n: n.toArray() };
}

// A place on the gun from a ray hit on its model (the inspect's charm placement): the point, the surface's outward
// normal and the bone that carries it (a pistol's slide, say), in the model's space in inches. Null if it can't tell.
export function placementFromHit(model, hit) {
  const frame = model?.userData.root && modelFrame(model.userData.root);
  if (!frame || !hit?.face) return null;
  frame.updateWorldMatrix(true, false);
  const inv = frame.matrixWorld.clone().invert();
  const p = hit.point.clone().applyMatrix4(inv).divideScalar(INCH);
  const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).transformDirection(inv);
  return charmPlacement({ b: skinningBone(hit) || 'weapon_offset', p: fromFrame(p), n: fromFrame(n) });
}

// Hangs a gun model's charm (an inspect's model, see skin.js buildCS2Model) again, e.g. moved (charm.o).
export async function rehangCharm(model, charm) {
  const root = model?.userData.root;
  if (!root) return null;
  const old = [];
  root.traverse((o) => { if (o.userData.charm) old.push(o); });
  const hung = await addCharm(root, model.userData.weapon, model.userData.mesh || '', { ...charm, t: 'charm' });
  for (const o of old) {
    o.removeFromParent();
    o.traverse((x) => {
      if (!x.isMesh) return;
      if (x.userData.card) x.geometry.dispose();
      x.skeleton?.dispose();
      for (const mm of [].concat(x.material || [])) { mm.userData.dispose?.(); mm.dispose(); }
    });
  }
  return hung;
}

// Hangs a gun's charm on its model (root: the gun's glTF scene; wid: weapon id; mesh: the model's mesh name). Returns
// the holder, or null when it has nowhere to hang.
export async function addCharm(root, wid, mesh, charm) {
  const legacy = /legacy/.test(mesh);
  const [mk, m] = await Promise.all([weaponMarkup(wid), charmModel(charm)]);
  const place = charmPlacement(charm.o) || defaultPlacement(mk, legacy);
  const frame = place && modelFrame(root);
  root.updateWorldMatrix(true, true);
  const holder = new THREE.Group();
  const findBone = (name) => { let b = null; root.traverse((o) => { if (!b && o.isBone && o.name === name) b = o; }); return b; };
  let bone = frame ? findBone(place.b) || findBone('weapon_offset') : null, down = null, out = null;
  if (bone) {
    // On the gun's surface, the clasp just out from it; the holder turned like the model, so its down is the gun's.
    const p = toFrame(place.p).multiplyScalar(INCH), n = toFrame(place.n).normalize();
    holder.position.copy(bone.worldToLocal(frame.localToWorld(p.clone().addScaledVector(n, CLASP_GAP))));
    holder.quaternion.copy(bone.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(frame.getWorldQuaternion(new THREE.Quaternion())));
    // Outward is the surface's way out from the gun, or (on its top or underside) the side it's on.
    down = DOWN.clone();
    out = new THREE.Vector3(n.x, 0, n.z);
    if (out.length() < 0.35) out.set(Math.sign(p.x) || 1, 0, 0);
    out.normalize();
  } else {
    // Without CS2's placement data: the gun's "keychain" attachment.
    const at = await cs2CharmAttach(wid);
    const a = (legacy && at.legacy) || at.attach;
    bone = a && findBone(a.bone);
    if (!bone) return null;
    holder.position.set(a.offset[0] * INCH, a.offset[1] * INCH, a.offset[2] * INCH);
    holder.quaternion.set(...a.rotation).multiply(GLTF_TO_BONE);
  }
  bone.add(holder);
  holder.updateWorldMatrix(true, false);
  const surface = gunSurface(root);
  const rel = root.matrixWorld.clone().invert().multiply(holder.matrixWorld);
  if (!out) {
    // The gun's down and outward in the holder's frame: the gun model stands up along its +Y with its sides along X,
    // and the attachment is on one side of it (the left on every CS2 gun), so outward is from its middle to that side.
    const pos = new THREE.Vector3(), rq = new THREE.Quaternion();
    rel.decompose(pos, rq, new THREE.Vector3());
    rq.invert();
    let x0 = Infinity, x1 = -Infinity;
    for (const s of surface) { if (s.x < x0) x0 = s.x; if (s.x > x1) x1 = s.x; }
    down = DOWN.clone().applyQuaternion(rq);
    out = new THREE.Vector3(Math.sign(pos.x - (x0 + x1) / 2) || 1, 0, 0).applyQuaternion(rq);
    out.addScaledVector(down, -out.dot(down)).normalize();
  }
  // The charm's face (its +X) turned to face outward when it hangs down the gun, then by its pattern, less of it where
  // that would stick a wide charm straight out from the gun (it lies against it, as one would).
  const face = out.clone().applyQuaternion(new THREE.Quaternion().setFromUnitVectors(DOWN, down).invert());
  const outward = Math.atan2(-face.z, face.x), pattern = patternTurn(charm.pat);
  const where = place ? `${place.b}:${place.p.join(',')}` : 'attach';
  // Clear of the gun as it swings if any turn manages that, else as it rests, else leaning on it at the flattest turn.
  let turn, outMin = Infinity;
  for (const need of [SWUNG, RESTING, SHOWING]) {
    for (let k = need === SHOWING ? 0 : 1; k >= 0 && outMin === Infinity; k -= 0.25) {
      turn = outward + pattern * k;
      outMin = clearance(surface, rel.clone().invert(), down, out, m, turn, need, `${wid}|${mesh}|${surface.length}|${itemDef(charm)?.mdl}|${turn.toFixed(3)}|${where}|${need}`);
    }
  }
  bone.remove(holder);
  const hung = holderFor(m, turn, { down: down.toArray(), out: out.toArray(), outMin: Math.min(outMin, SWING_MAX) });
  hung.position.copy(holder.position);
  hung.quaternion.copy(holder.quaternion);
  bone.add(hung);
  return hung;
}

// A charm on its own (its inspect): as it hangs from its clasp, facing you, turning about its middle as you turn it
// (trailing a little, see swingCharm). About 3 units across.
export async function buildCharmModel(charm) {
  const m = await charmModel(charm);
  const size = m.box.getSize(new THREE.Vector3()), center = m.box.getCenter(new THREE.Vector3());
  const k = 3 / (Math.max(size.x, size.y, size.z) || 1);
  // How far its furthest point is from its middle: turned up on end a wide, flat charm needs more room than it looks.
  let far = 0;
  const v = new THREE.Vector3();
  m.root.traverse((o) => {
    if (!o.isMesh) return;
    const n = o.geometry.attributes.position.count, step = Math.max(1, Math.floor(n / 600));
    for (let i = 0; i < n; i += step) far = Math.max(far, o.getVertexPosition(i, v).applyMatrix4(o.matrixWorld).distanceTo(center));
  });
  const holder = holderFor(m, 0);
  holder.rotation.y = -Math.PI / 2; // every charm faces along its +X: turned to you
  const inner = new THREE.Group();
  inner.scale.setScalar(k);
  inner.position.copy(center).applyQuaternion(holder.quaternion).multiplyScalar(-k); // its middle at the pivot
  inner.add(holder);
  const wrap = new THREE.Group();
  wrap.add(inner);
  wrap.userData.bounds = new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(Math.max(size.x, size.z), Math.max(size.y, far * 1.4), Math.max(size.x, size.z)).multiplyScalar(k));
  // First seen the way its icon (CS2's render) shows it: turned a little to its right, from a little above.
  wrap.userData.view = { yaw: -0.45, pitch: 0.15 };
  return wrap;
}
