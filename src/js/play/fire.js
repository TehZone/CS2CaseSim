// Molotov and incendiary fire, drawn in the glTF scene (metres, Y up): flame tongues standing on the ground (quads
// turned to the camera, playing a looping flipbook made here: noise rising through a flame's shape, white-hot at the
// root, deep red at the tips), a scorch and a flickering glow on the ground under them, embers and dark smoke rising off
// them. Each layer is one instanced draw; the fire spreads out from where the bottle broke and dies down from its edges.
// Grenades adds the orange light it throws on the walls and players around it.
import * as THREE from 'three';

const COLS = 8, ROWS = 4, FRAMES = COLS * ROWS, CW = 64, CH = 128;

// Integer lattice hash, 0..1.
function hash(x, y) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
// Smooth value noise repeating every py cells in y, and octaves of it (still repeating every py at the base).
function noise(x, y, py) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const y0 = ((yi % py) + py) % py, y1 = (y0 + 1) % py;
  const a = hash(xi, y0), b = hash(xi + 1, y0), c = hash(xi, y1), d = hash(xi + 1, y1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
function fbm(x, y, py, octaves = 4) {
  let s = 0, amp = 0.5, f = 1;
  for (let o = 0; o < octaves; o++, amp *= 0.5, f *= 2) s += amp * noise(x * f + o * 17, y * f, py * f);
  return s / (1 - 0.5 ** octaves);
}

// The flame flipbook: one loop in FRAMES frames, COLS x ROWS cells of CW x CH (first frame bottom left, each flame's root
// at the bottom of its cell). R is the flame's heat (0 none, 1 white-hot; the shader colours it), G how much of it
// shows (fading out at the root and the tip, without cooling to red there). The noise scrolls up one whole period over
// the loop, so the last frame runs into the first.
export function flameAtlas() {
  const W = COLS * CW, H = ROWS * CH, data = new Uint8Array(W * H * 4);
  const P = 4, PS = 2; // periods (in noise cells) of the flame's noise and of the licking
  for (let f = 0; f < FRAMES; f++) {
    const t = f / FRAMES, cx = (f % COLS) * CW, cy = Math.floor(f / COLS) * CH;
    for (let j = 0; j < CH; j++) {
      const v = (j + 0.5) / CH;
      const y = v * 2.2 - t * P;
      const w = 0.98 * Math.pow(1 - v, 0.7); // the flame's width: full at the root, narrowing to the tip
      const show = Math.min(1, v * 7, (1 - v) * 10);
      for (let i = 0; i < CW; i++) {
        const u0 = (i + 0.5) / CW;
        // Tongues licking sideways (more higher up), eaten into by noise stretched upwards.
        const u = u0 + (fbm(u0 * 2 + 11, v * 1.4 - t * PS, PS, 2) - 0.5) * 0.45 * (0.25 + v);
        const d = (Math.abs(u - 0.5) * 2) / Math.max(w, 1e-3);
        const eat = Math.min(1, Math.max(0, 0.5 + (fbm(u * 5, y, P) - 0.5) * 2.2));
        const heat = (Math.max(0, 1 - d) ** 0.8 * (1.15 - 0.85 * v) - eat * (0.3 + 0.95 * v)) * 1.25;
        const k = ((cy + j) * W + cx + i) * 4;
        data[k] = Math.round(Math.min(1, Math.max(0, heat)) * 255);
        data[k + 1] = Math.round(show * 255);
        data[k + 3] = 255;
      }
    }
  }
  return { data, width: W, height: H };
}

// A soft lumpy blob (R) for the smoke puffs and the glow and scorch on the ground.
export function puffImage(size = 64) {
  const data = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const x = (i + 0.5) / size * 2 - 1, y = (j + 0.5) / size * 2 - 1;
    const r = Math.hypot(x, y);
    const n = fbm(x * 2.5 + 3, y * 2.5 + 3, 64);
    const a = Math.max(0, 1 - r * (1.15 - 0.5 * n)) ** 1.6 * (0.55 + 0.45 * n);
    const k = (j * size + i) * 4;
    data[k] = Math.round(Math.min(1, a * 1.3) * 255);
    data[k + 3] = 255;
  }
  return { data, width: size, height: size };
}

function texture({ data, width, height }) {
  const t = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

const COMMON = /* glsl */ `
uniform float uTime;   // the game's clock
uniform float uAge;    // seconds since the fire started
uniform float uRemain; // seconds until it's out
attribute vec3 aBase;
attribute vec4 aAnim;
varying vec2 vUv;
mat2 spin(float r) { return mat2(cos(r), sin(r), -sin(r), cos(r)); }
`;

// Flame tongues: upright quads turned to the camera (leaning back a little when seen from above), rooted in the ground.
// aSize: width (negative: mirrored), height; aAnim: x loop phase, y loops a second, z when it catches, w how much
// earlier it dies down.
const FLAME_VS = COMMON + /* glsl */ `
attribute vec2 aSize;
varying float vFrame;
varying float vLife;
void main() {
  float life = smoothstep(aAnim.z, aAnim.z + 0.5, uAge) * clamp((uRemain - aAnim.w) / 1.5, 0.0, 1.0);
  vec3 base = (modelMatrix * vec4(aBase, 1.0)).xyz;
  vec3 toCam = normalize(cameraPosition - base);
  vec3 right = normalize(vec3(toCam.z, 0.0, -toCam.x) + vec3(1e-4, 0.0, 0.0));
  vec3 up = normalize(vec3(0.0, 1.0, 0.0) - toCam * toCam.y * 0.5);
  float flick = 0.88 + 0.12 * sin(uTime * 8.0 + aAnim.x * 40.0) * sin(uTime * 4.7 + aAnim.x * 13.0);
  vec2 s = aSize * vec2(0.5 + 0.5 * life, life * flick);
  vec3 p = base + right * (position.x * s.x) + up * ((position.y + 0.5) * s.y - 0.07 * aSize.y);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  vUv = position.xy + 0.5;
  vFrame = fract(uTime * aAnim.y + aAnim.x) * FRAMES;
  vLife = life;
}`;
const FLAME_FS = /* glsl */ `
uniform sampler2D uMap;
uniform float uIntensity;
varying vec2 vUv;
varying float vFrame;
varying float vLife;
vec2 cell(float f) {
  f = mod(f, FRAMES);
  return (vec2(mod(f, COLS), floor(f / COLS)) + clamp(vUv, 0.01, 0.99)) / vec2(COLS, ROWS);
}
// Heat to light (linear, HDR): deep red, orange, yellow, white-hot.
vec3 ramp(float h) {
  vec3 c = mix(vec3(0.35, 0.03, 0.0), vec3(1.0, 0.22, 0.02), smoothstep(0.05, 0.35, h));
  c = mix(c, vec3(1.0, 0.52, 0.1), smoothstep(0.3, 0.6, h));
  c = mix(c, vec3(1.0, 0.72, 0.3), smoothstep(0.55, 0.85, h));
  c = mix(c, vec3(1.0, 0.86, 0.55), smoothstep(0.85, 1.0, h));
  return c * (0.25 + 1.3 * h * h);
}
void main() {
  float f0 = floor(vFrame);
  vec2 t = mix(texture2D(uMap, cell(f0)).rg, texture2D(uMap, cell(f0 + 1.0)).rg, vFrame - f0);
  float h = t.r * mix(0.6, 1.0, vLife); // cooler while catching and dying down
  float a = smoothstep(0.03, 0.2, h) * t.g * smoothstep(0.0, 0.15, vLife);
  if (a < 0.004) discard;
  gl_FragColor = vec4(ramp(h) * uIntensity * a, a * 0.3);
}`;

// Billboards rising off the fire: smoke puffs and embers. aAnim: x phase, y rises a second, z size (m), w a seed.
const RISE_VS = (rise, drift, grow, fadeIn) => COMMON + /* glsl */ `
varying float vLife;
varying float vAlpha;
void main() {
  float life = fract(uTime * aAnim.y + aAnim.x);
  float on = smoothstep(${fadeIn.toFixed(2)}, ${(fadeIn + 0.6).toFixed(2)}, uAge) * clamp(uRemain / 2.0, 0.0, 1.0);
  float a = aAnim.w * 6.2832 + life * ${drift.toFixed(1)};
  vec3 c = (modelMatrix * vec4(aBase, 1.0)).xyz + vec3(sin(a) * life * 0.6, life * ${rise.toFixed(2)} * (0.7 + 0.6 * fract(aAnim.w * 7.0)), cos(a) * life * 0.6);
  vec4 mv = viewMatrix * vec4(c, 1.0);
  mv.xy += spin(aAnim.w * 6.2832 + life * 1.2) * position.xy * aAnim.z * (1.0 + ${grow.toFixed(2)} * life);
  gl_Position = projectionMatrix * mv;
  vUv = position.xy + 0.5;
  vLife = life;
  vAlpha = smoothstep(0.0, 0.12, life) * (1.0 - life) * on;
}`;
const SMOKE_FS = /* glsl */ `
uniform sampler2D uMap;
varying vec2 vUv;
varying float vLife;
varying float vAlpha;
void main() {
  float a = min(0.85, texture2D(uMap, vUv).r * vAlpha * 1.7);
  if (a < 0.003) discard;
  // lit orange by the flames low down, then dark grey
  vec3 col = mix(vec3(0.5, 0.17, 0.04), vec3(0.025, 0.024, 0.022), smoothstep(0.0, 0.18, vLife));
  gl_FragColor = vec4(col * a, a);
}`;
const EMBER_FS = /* glsl */ `
uniform float uTime;
varying vec2 vUv;
varying float vLife;
varying float vAlpha;
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float a = pow(max(0.0, 1.0 - d), 2.0) * vAlpha * (0.6 + 0.4 * sin(uTime * 25.0 + vLife * 40.0));
  if (a < 0.003) discard;
  gl_FragColor = vec4(vec3(1.0, 0.42, 0.1) * 6.0 * a, 0.0);
}`;

// Flat on the ground: aAnim x radius (m), y turn, z when it catches, w a seed.
const GROUND_VS = COMMON + /* glsl */ `
varying float vLife;
varying float vFlick;
void main() {
  float life = smoothstep(aAnim.z, aAnim.z + 0.6, uAge) * clamp(uRemain / 1.5, 0.0, 1.0);
  vec2 q = spin(aAnim.y) * position.xy * aAnim.x * 2.0 * (0.6 + 0.4 * life);
  gl_Position = projectionMatrix * viewMatrix * vec4((modelMatrix * vec4(aBase, 1.0)).xyz + vec3(q.x, 0.0, q.y), 1.0);
  vUv = position.xy + 0.5;
  vLife = life;
  vFlick = 0.8 + 0.2 * sin(uTime * 11.0 + aAnim.w * 30.0) * sin(uTime * 6.1 + aAnim.w * 7.0);
}`;
const GLOW_FS = /* glsl */ `
uniform sampler2D uMap;
varying vec2 vUv;
varying float vLife;
varying float vFlick;
void main() {
  float a = texture2D(uMap, vUv).r * vLife * vFlick;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vec3(1.0, 0.32, 0.06) * 2.0 * a, 0.0);
}`;
const SCORCH_FS = /* glsl */ `
uniform sampler2D uMap;
varying vec2 vUv;
varying float vLife;
varying float vFlick;
void main() {
  float a = min(1.0, texture2D(uMap, vUv).r * 1.6) * smoothstep(0.0, 0.5, vLife) * 0.75;
  if (a < 0.003) discard;
  gl_FragColor = vec4(0.0, 0.0, 0.0, a);
}`;

// Textures and materials shared by every fire (made once a match).
export class FireArt {
  constructor() {
    this.flames = texture(flameAtlas());
    this.puff = texture(puffImage());
  }
  // A layer's material on a fire's shared uniforms. Everything blends premultiplied: rgb is the light added, a how much
  // of what's behind it is hidden.
  material(vs, fs, u, map, extra = {}) {
    return new THREE.ShaderMaterial({
      vertexShader: vs, fragmentShader: fs,
      uniforms: { uTime: u.uTime, uAge: u.uAge, uRemain: u.uRemain, uIntensity: u.uIntensity, uMap: { value: map } },
      defines: { COLS: COLS.toFixed(1), ROWS: ROWS.toFixed(1), FRAMES: FRAMES.toFixed(1) },
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      ...extra,
    });
  }
  dispose() { this.flames.dispose(); this.puff.dispose(); }
}

function layer(count, attrs, material, order) {
  const geo = new THREE.InstancedBufferGeometry().copy(new THREE.PlaneGeometry(1, 1));
  for (const [name, size, arr] of attrs) geo.setAttribute(name, new THREE.InstancedBufferAttribute(arr, size));
  geo.instanceCount = count;
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false; // the shaders place the quads
  mesh.renderOrder = order;
  return mesh;
}

// One fire. spots: where its flames stand ([x, y, z] in the glTF scene, metres) with each one's distance from the
// centre (0..1): the fire catches from the centre outwards and dies down from its edges. now: the game clock.
export class GroundFire {
  constructor(art, center, spots, duration, now) {
    this.center = center.clone();
    this.start = now; this.duration = duration;
    const u = this.u = { uTime: { value: now }, uAge: { value: 0 }, uRemain: { value: duration }, uIntensity: { value: 1 } };
    this.obj = new THREE.Group();
    const rnd = Math.random;
    const n = spots.length;

    // Flames, wide enough to run into each other: the taller ones towards the middle.
    const base = new Float32Array(n * 3), size = new Float32Array(n * 2), anim = new Float32Array(n * 4);
    spots.forEach(([x, y, z, r], i) => {
      base.set([x, y, z], i * 3);
      const h = (0.45 + 0.75 * (1 - r) ** 1.5 + rnd() * 0.45) * (rnd() < 0.25 ? 0.6 : 1);
      size.set([h * (0.8 + rnd() * 0.35) * (rnd() < 0.5 ? -1 : 1), h], i * 2);
      anim.set([rnd(), 0.8 + rnd() * 0.6, r * 0.8 + rnd() * 0.15, (1 - r) * 0.2 + r * 0.9 + rnd() * 0.3], i * 4);
    });
    this.obj.add(layer(n, [['aBase', 3, base], ['aSize', 2, size], ['aAnim', 4, anim]], art.material(FLAME_VS, FLAME_FS, u, art.flames), 3));

    // Glow and scorch on the ground: one small patch (flat, so not too far over an edge) for every few flames.
    const pick = () => spots[Math.floor(rnd() * spots.length) % spots.length] || [center.x, center.y, center.z, 0];
    const patches = Math.max(8, Math.round(n / 2.5));
    const gb = new Float32Array(patches * 3), ga = new Float32Array(patches * 4);
    for (let i = 0; i < patches; i++) {
      const [x, y, z, r] = i === 0 ? [center.x, center.y, center.z, 0] : pick();
      gb.set([x, y + 0.02, z], i * 3);
      ga.set([0.5 + rnd() * 0.4, rnd() * 6.28, r * 0.8, rnd()], i * 4);
    }
    const flat = { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 };
    this.obj.add(layer(patches, [['aBase', 3, gb], ['aAnim', 4, ga]], art.material(GROUND_VS, SCORCH_FS, u, art.puff, flat), 1));
    this.obj.add(layer(patches, [['aBase', 3, gb.slice()], ['aAnim', 4, ga.slice()]], art.material(GROUND_VS, GLOW_FS, u, art.puff, flat), 2));

    // Embers and smoke rising off the flames.
    const rising = (count, lift, seed) => {
      const b = new Float32Array(count * 3), a = new Float32Array(count * 4);
      for (let i = 0; i < count; i++) {
        const [x, y, z, r] = pick();
        b.set([x, y + lift, z], i * 3);
        a.set(seed(r), i * 4);
        a[i * 4 + 3] = rnd();
      }
      return [['aBase', 3, b], ['aAnim', 4, a]];
    };
    this.obj.add(layer(48, rising(48, 0.3, () => [rnd(), 0.5 + rnd() * 0.5, 0.012 + rnd() * 0.012, 0]),
      art.material(RISE_VS(2.4, 3.0, 0.0, 0.3), EMBER_FS, u, null), 4));
    this.obj.add(layer(30, rising(30, 0.6, () => [rnd(), 0.3 + rnd() * 0.15, 0.45 + rnd() * 0.3, 0]),
      art.material(RISE_VS(3.6, 0.6, 2.4, 0.5), SMOKE_FS, u, art.puff), 5));
  }

  // How strong the fire is now (0..1): for its light.
  level(now) {
    const age = now - this.start;
    return Math.min(1, age / 0.8) * Math.min(1, Math.max(0, (this.duration - age) / 1.5));
  }
  update(now) {
    this.u.uTime.value = now;
    this.u.uAge.value = now - this.start;
    this.u.uRemain.value = this.duration - (now - this.start);
  }
  dispose() {
    this.obj.removeFromParent();
    this.obj.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
  }
}
