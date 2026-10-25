// Charms in 3D: CS2's charm model hung from a gun's "keychain" attachment (it rides along in first person and Play),
// swinging as the gun moves and turned about its chain by its pattern; and a charm on its own (a charm item's inspect).
// A charm model is a short chain of three joints from the clasp (at its origin) with the charm on the end, hanging
// along its -Y (CS2's -Z). A Sticker Slab is the clear case model with its sticker printed on the card inside.
// Charms are drawn with their csgo_weapon materials as CS2 does: tint, colour adjustments and roughness, most of them
// following the charm's pattern (CS2's dynamic expressions of $KeychainSeed: a pattern's colours).
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { cs2Charm, cs2CharmAttach } from './api.js';
import { loadGltf } from './rig.js';
import { UniformRandomStream } from './rng.js';
import { D } from '../engine/data.js';
import { itemDef, CHARM_PATTERNS } from '../engine/items.js';
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
// clear the gun's side below its keychain (measured from the gun model, see clearance), at most OUT_MAX out, and at most
// FWD_MAX forward or back along the gun.
const DEG = Math.PI / 180;
const OUT_MIN = 6 * DEG, OUT_MAX = 65 * DEG, FWD_MAX = 30 * DEG;

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
export function evalExpression(src, attrs = {}) {
  const toks = String(src).match(/\$[\w$]+|[A-Za-z_]\w*|\d*\.\d+|\d+|<=|>=|==|!=|&&|\|\||[-+*/%(),?:<>!.;=]/g) || [];
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
// Materials: csgo_weapon's charm look on three's physical material. The colour map's tint and adjustments (contrast,
// brightness, hue about the grey axis weighted by saturation, then saturation; masked by the tint mask) and the
// roughness/metal map (roughness in red with its contrast and brightness, metalness in green remapped) are CS2's own
// maths (csgo_weapon's pixel shader). Glitter and iridescence are approximated.
// ---------------------------------------------------------------------------------------------
const textures = new Map();
function texture(url, srgb) {
  if (!textures.has(url)) {
    const p = new THREE.TextureLoader().loadAsync(url).then((t) => {
      t.flipY = false; // glTF UVs
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 8;
      return t;
    });
    textures.set(url, p);
    p.catch(() => textures.delete(url));
  }
  return textures.get(url);
}
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const SHADER_HEAD = `
uniform sampler2D cs2Rm;
uniform sampler2D cs2TintMap;
uniform vec4 cs2Has; // has roughness/metal map, has tint mask, adjustments on
uniform vec3 cs2Tint;
uniform vec4 cs2Adjust; // contrast, brightness, saturation, hue (radians)
uniform vec2 cs2Rough; // roughness contrast, brightness
uniform vec2 cs2Metal; // metalness remap
vec3 cs2Adj(vec3 c, float mask) {
  vec3 a = clamp(mix(vec3(0.5), c, cs2Adjust.x) * cs2Adjust.y, 0.0, 1.0);
  float ch = cos(cs2Adjust.w);
  const vec3 K = vec3(0.57735);
  float mx = max(a.r, max(a.g, a.b));
  float s = mx > 0.0 ? (mx - min(a.r, min(a.g, a.b))) / mx : 0.0;
  vec3 rot = a * ch + cross(K, a) * sin(cs2Adjust.w) + K * dot(K, a) * (1.0 - ch);
  const vec3 L = vec3(0.2125, 0.7154, 0.0721);
  vec3 b = mix(vec3(dot(a, L)), rot, pow(s, 0.125));
  return mix(c, clamp(mix(vec3(dot(b, L)), b, cs2Adjust.z), 0.0, 1.0), mask);
}
`;
function patchShader(shader, u) {
  Object.assign(shader.uniforms, u);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\n' + SHADER_HEAD)
    .replace('#include <map_fragment>', `#include <map_fragment>
      {
        float cs2Mask = cs2Has.y > 0.5 ? texture2D(cs2TintMap, vMapUv).r : 1.0;
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * cs2Tint, cs2Mask);
        if (cs2Has.z > 0.5) diffuseColor.rgb = cs2Adj(diffuseColor.rgb, cs2Mask);
      }`)
    .replace('#include <roughnessmap_fragment>', `float roughnessFactor = roughness;
      if (cs2Has.x > 0.5) { float r = texture2D(cs2Rm, vMapUv).r; roughnessFactor = clamp(((r - 0.5) * cs2Rough.x + 0.5) * cs2Rough.y, 0.04, 1.0); }`)
    .replace('#include <metalnessmap_fragment>', `float metalnessFactor = metalness;
      if (cs2Has.x > 0.5) metalnessFactor = mix(cs2Metal.x, cs2Metal.y, texture2D(cs2Rm, vMapUv).g);`);
}

// A charm material from the service's description (see CS2Service.charm) for this charm's attributes. `map` replaces
// its colour map (a Sticker Slab's, with the sticker printed on). Null when it isn't a csgo_weapon material with a
// colour map (the lighter's liquid keeps the exporter's material).
async function charmMaterial(info, attrs, { name = '', map = null } = {}) {
  if (info?.shader !== 'csgo_weapon' || !info.textures?.color) return null;
  const p = { ...info.params };
  for (const [k, src] of Object.entries(info.dynamic || {})) {
    const v = evalExpression(src, attrs);
    if (v == null) continue;
    p[k] = Array.isArray(p[k]) && !Array.isArray(v) ? p[k].map(() => v) : v;
  }
  const t = info.textures, f = info.flags || {};
  const [color, normal, ao, rm, tint] = await Promise.all([
    map || texture(t.color, true), t.normal ? texture(t.normal, false) : null, t.ao ? texture(t.ao, false) : null,
    t.rm ? texture(t.rm, false) : null, t.tint && f.F_TINT_MASK ? texture(t.tint, false) : null,
  ]);
  const num = (k, d) => (typeof p[k] === 'number' && Number.isFinite(p[k]) ? p[k] : d);
  const vec = (k, d) => (Array.isArray(p[k]) ? p[k] : typeof p[k] === 'number' ? [p[k], p[k], p[k], p[k]] : d);
  const tc = vec('g_vColorTint', [1, 1, 1]), mr = vec('g_vMetalnessRemapRange', [0, 1]);
  const m = new THREE.MeshPhysicalMaterial({ name, map: color, normalMap: normal, aoMap: ao, roughness: 0.5, metalness: 0, envMapIntensity: 1.1 });
  const irid = f.F_IRIDESCENCE ? num('g_flIridescentStrength', 0) : 0;
  if (irid > 0) Object.assign(m, { iridescence: Math.min(1, irid), iridescenceIOR: 1.5, iridescenceThicknessRange: [120, 640] });
  const glitter = f.F_GLITTER ? num('g_fGlitterIntensity', 0) : 0;
  if (glitter > 0) Object.assign(m, { clearcoat: Math.min(1, glitter * 2), clearcoatRoughness: 0.15 });
  const u = {
    cs2Rm: { value: rm }, cs2TintMap: { value: tint },
    cs2Has: { value: new THREE.Vector4(rm ? 1 : 0, tint ? 1 : 0, f.F_ENABLE_ADJUSTMENTS ? 1 : 0, 0) },
    cs2Tint: { value: new THREE.Vector3(...tc.slice(0, 3).map(toLinear)) },
    cs2Adjust: { value: new THREE.Vector4(num('g_fContrast', 1), num('g_fBrightness', 1), num('g_fSaturation', 1), (num('g_fHueShift', 0) * Math.PI) / 180) },
    cs2Rough: { value: new THREE.Vector2(num('g_fTextureRoughnessContrast', 1), num('g_fTextureRoughnessBrightness', 1)) },
    cs2Metal: { value: new THREE.Vector2(mr[0] ?? 0, mr[1] ?? 1) },
  };
  m.onBeforeCompile = (shader) => patchShader(shader, u);
  m.customProgramCacheKey = () => 'cs2charm';
  return m;
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
  const attrs = { $KeychainSeed: keychainSeed(charm.pat) };
  if (def.slab) {
    const s = D.stickers[def.sk];
    if (s?.rc) attrs.$sticker_rarity_color = [1, 3, 5].map((k) => parseInt(s.rc.slice(k, k + 2), 16) / 255);
  }
  for (const o of meshes) {
    const name = o.material?.name || '';
    const mi = info.materials?.[name];
    const map = def.slab && name === 'kc_sticker_display_case' && mi?.textures?.color ? await sealSticker(mi.textures.color, def) : null;
    const m = mi && await charmMaterial(mi, attrs, { name, map });
    if (m) {
      if (def.slab && name === 'kc_sticker_display_case') Object.assign(m, { clearcoat: 1, clearcoatRoughness: 0.05 }); // the clear case
      o.material = m;
    } else for (const x of [].concat(o.material || [])) x.envMapIntensity = 1.1;
  }
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  return { root, joint, box, length: Math.max(0.008, -box.getCenter(new THREE.Vector3()).y) };
}

// A Sticker Slab's colour map with its sticker printed on the card inside the case (a texture of its own).
async function sealSticker(colorUrl, def) {
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

// Hangs a holder's charm under gravity (world -Y) as a damped pendulum from its clasp, so it swings when the gun moves,
// kept clear of the gun (see holderFor). It runs as the holder's world matrix is worked out each frame. First person
// calls this again on its copy of the gun.
export function swingCharm(holder) {
  const { turn, rest, frame } = holder.userData.charm;
  const length = Math.max(SWING_LENGTH, holder.userData.charm.length);
  let joint = null;
  holder.traverse((o) => { if (o.isBone && !joint) joint = o; });
  if (!joint) return;
  const restQ = new THREE.Quaternion().fromArray(rest);
  const twist = new THREE.Quaternion().setFromAxisAngle(UP, turn);
  const down = frame && new THREE.Vector3().fromArray(frame.down), out = frame && new THREE.Vector3().fromArray(frame.out);
  const fwd = frame && new THREE.Vector3().crossVectors(out, down);
  const outMin = Math.tan(frame?.outMin ?? OUT_MIN), outMax = Math.tan(OUT_MAX), fwdMax = Math.tan(FWD_MAX);
  const anchor = new THREE.Vector3(), bob = new THREE.Vector3(), prev = new THREE.Vector3(), v = new THREE.Vector3();
  const q = new THREE.Quaternion(), qi = new THREE.Quaternion(), s = new THREE.Vector3(), swing = new THREE.Quaternion();
  const update = Object.getPrototypeOf(holder).updateMatrixWorld;
  let last = 0;
  holder.updateMatrixWorld = function (force) {
    if (this.matrixAutoUpdate) this.updateMatrix();
    if (this.parent) this.matrixWorld.multiplyMatrices(this.parent.matrixWorld, this.matrix);
    else this.matrixWorld.copy(this.matrix);
    this.matrixWorld.decompose(anchor, q, s);
    qi.copy(q).invert();
    const L = length * s.x;
    const now = performance.now() / 1000, dt = now - last;
    if (!last || dt > 0.25) {
      // Hanging still: straight down (as far as the gun lets it, below).
      bob.copy(anchor).addScaledVector(DOWN, L);
      prev.copy(bob);
      last = now;
    } else if (dt > 0.001) {
      // Verlet: the bob keeps its (damped) velocity and falls, then the chain holds it at its length from the clasp.
      const h = Math.min(dt, 1 / 30);
      v.subVectors(bob, prev).multiplyScalar(Math.exp(-DAMPING * h));
      prev.copy(bob);
      bob.add(v).addScaledVector(DOWN, GRAVITY * s.x * h * h);
      v.subVectors(bob, anchor);
      bob.copy(anchor).addScaledVector(v.lengthSq() > 1e-12 ? v.normalize() : DOWN, L);
      last = now;
    }
    // The chain's direction in the holder's frame, kept clear of the gun, and the turn to it from hanging straight down.
    v.subVectors(bob, anchor).normalize().applyQuaternion(qi);
    if (frame) {
      // Its lean out from the gun and along it (as slopes from straight down the gun), each kept within its limits.
      const d = Math.max(1e-3, v.dot(down));
      const o = Math.min(outMax, Math.max(outMin, v.dot(out) / d)), f = Math.min(fwdMax, Math.max(-fwdMax, v.dot(fwd) / d));
      v.copy(down).addScaledVector(out, o).addScaledVector(fwd, f).normalize();
      bob.copy(v).applyQuaternion(q).multiplyScalar(L).add(anchor); // the swing stops there
    }
    swing.setFromUnitVectors(DOWN, v);
    joint.quaternion.copy(swing).multiply(twist).multiply(restQ);
    update.call(this, true);
  };
}

// How far out the charm's chain must lean to clear the gun's side under its keychain (a lean angle): CS2's charm rests
// against the gun where its side is wider than the keychain sits out (most pistols and the M4s). The gun's surface
// (vertices and triangle middles, in the holder's frame) gives its outermost point in each cell of a grid below the
// keychain (depth along the gun's down by distance along it); the charm, turned as it hangs, must stay out beyond those,
// leaning straight down the gun and swung forward and back as far as it goes. Cached per gun model, charm and turn.
const CELL = 0.004, MARGIN = 0.0015, CLASP = 0.01;
const clearances = new Map();
// The gun's surface: its visible meshes' vertices and triangle middles, in the gun model's own frame (metres).
function gunSurface(root) {
  root.updateMatrixWorld(true);
  const toRoot = root.matrixWorld.clone().invert();
  const pts = [], v = new THREE.Vector3(), c = new THREE.Vector3();
  root.traverse((o) => {
    if (!o.isMesh || o.userData.decal) return;
    for (let n = o; n; n = n.parent) if (!n.visible) return;
    const pos = o.geometry.attributes.position, idx = o.geometry.index, local = new Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      o.getVertexPosition(i, v);
      if (o.isSkinnedMesh) o.applyBoneTransform(i, v);
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
function clearance(surface, toHolder, down, out, m, turn, key) {
  if (clearances.has(key)) return clearances.get(key);
  const fwd = new THREE.Vector3().crossVectors(out, down);
  // The charm's points as it hangs (turned, before leaning), in its own frame.
  m.root.updateMatrixWorld(true);
  const pts = [];
  const v = new THREE.Vector3();
  m.root.traverse((o) => {
    if (!o.isMesh) return;
    const n = o.geometry.attributes.position.count, step = Math.max(1, Math.floor(n / 600));
    for (let i = 0; i < n; i += step) { o.getVertexPosition(i, v); if (o.isSkinnedMesh) o.applyBoneTransform(i, v); pts.push(v.clone().applyMatrix4(o.matrixWorld)); }
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
    const d = p.dot(down), f = p.dot(fwd);
    if (d < -reach || d > reach || Math.abs(f) > reach) return;
    const k = cell(d, f), o = p.dot(out);
    if (!(grid.get(k) >= o)) grid.set(k, o);
  };
  for (const s of surface) note(v.copy(s).applyMatrix4(toHolder));
  const near = (d, f) => {
    let best = -Infinity;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) { const g = grid.get(cell(d + i * CELL, f + j * CELL)); if (g > best) best = g; }
    return best;
  };
  const sw = new THREE.Quaternion(), dir = new THREE.Vector3(), p = new THREE.Vector3();
  const clear = (lean, along) => {
    dir.copy(down).addScaledVector(out, Math.tan(lean)).addScaledVector(fwd, Math.tan(along)).normalize();
    sw.setFromUnitVectors(DOWN, dir);
    let bad = 0;
    for (const q of body) {
      p.copy(q).applyQuaternion(sw);
      if (p.dot(out) < near(p.dot(down), p.dot(fwd)) + MARGIN) bad++;
    }
    return bad <= body.length * 0.01;
  };
  let lean = OUT_MIN;
  while (lean < OUT_MAX && !(clear(lean, 0) && clear(lean, FWD_MAX) && clear(lean, -FWD_MAX))) lean += 2 * DEG;
  lean = Math.min(lean, OUT_MAX);
  clearances.set(key, lean);
  return lean;
}

// Hangs a gun's charm on its model (root: the gun's glTF scene; wid: weapon id; mesh: the model's mesh name). Returns
// the holder, or null when the model has no keychain attachment.
export async function addCharm(root, wid, mesh, charm) {
  const [at, m] = await Promise.all([cs2CharmAttach(wid), charmModel(charm)]);
  const a = (/legacy/.test(mesh) && at.legacy) || at.attach;
  if (!a) return null;
  let bone = null;
  root.traverse((o) => { if (!bone && o.isBone && o.name === a.bone) bone = o; });
  if (!bone) return null;
  const holder = new THREE.Group();
  holder.position.set(a.offset[0] * INCH, a.offset[1] * INCH, a.offset[2] * INCH);
  holder.quaternion.set(...a.rotation).multiply(GLTF_TO_BONE);
  bone.add(holder);
  // The gun's down and outward in the holder's frame: the gun model stands up along its +Y with its sides along X, and
  // the attachment is on one side of it (the left on every CS2 gun), so outward is from the gun's middle to that side.
  holder.updateWorldMatrix(true, false);
  const surface = gunSurface(root);
  const rel = root.matrixWorld.clone().invert().multiply(holder.matrixWorld);
  const pos = new THREE.Vector3(), rq = new THREE.Quaternion();
  rel.decompose(pos, rq, new THREE.Vector3());
  rq.invert();
  let x0 = Infinity, x1 = -Infinity;
  for (const s of surface) { if (s.x < x0) x0 = s.x; if (s.x > x1) x1 = s.x; }
  const down = DOWN.clone().applyQuaternion(rq), out = new THREE.Vector3(Math.sign(pos.x - (x0 + x1) / 2) || 1, 0, 0).applyQuaternion(rq);
  out.addScaledVector(down, -out.dot(down)).normalize();
  // The charm's face (its +X) turned to face outward when it hangs down the gun, then by its pattern.
  const face = out.clone().applyQuaternion(new THREE.Quaternion().setFromUnitVectors(DOWN, down).invert());
  const turn = Math.atan2(-face.z, face.x) + patternTurn(charm.pat);
  const outMin = clearance(surface, rel.clone().invert(), down, out, m, turn, `${wid}|${mesh}|${itemDef(charm)?.mdl}|${turn.toFixed(3)}`);
  bone.remove(holder);
  const hung = holderFor(m, turn, { down: down.toArray(), out: out.toArray(), outMin });
  hung.position.copy(holder.position);
  hung.quaternion.copy(holder.quaternion);
  bone.add(hung);
  return hung;
}

// A charm on its own (its inspect): hanging from its clasp, facing you, swinging as you turn it. About 3 units tall.
export async function buildCharmModel(charm) {
  const m = await charmModel(charm);
  const size = m.box.getSize(new THREE.Vector3()), center = m.box.getCenter(new THREE.Vector3());
  const k = 3 / (Math.max(size.x, size.y, size.z) || 1);
  const holder = holderFor(m, 0);
  holder.rotation.y = -Math.PI / 2; // every charm faces along its +X: turned to you
  const inner = new THREE.Group();
  inner.scale.setScalar(k);
  inner.position.set(0, -center.y * k, 0);
  inner.add(holder);
  const wrap = new THREE.Group();
  wrap.add(inner);
  wrap.userData.bounds = new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(Math.max(size.x, size.z), size.y, Math.max(size.x, size.z)).multiplyScalar(k));
  return wrap;
}
