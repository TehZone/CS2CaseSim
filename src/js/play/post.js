// The world is drawn into an HDR render target (with its depth), and the first-person weapon into one of its own. The
// volumetric smokes are ray-marched against the world's depth (so walls in front hide them and they end at walls) at
// half resolution, like CS2 does, then a full-screen pass puts it all on screen: it blends the smoke back in
// (depth-aware, so it doesn't bleed over edges in front of it), adds the flashbang's afterimage, lays the weapon over
// it, and finishes like CS2's post processing: the exposure (auto exposure within the map's range), CS2's filmic tone
// curve with the map's parameters, sRGB, then the map's colour grading LUT.
import * as THREE from 'three';
import { VOX, NX, NY, NZ, SLOTS, LIGHT_SCALE } from './smoke.js';

const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// The smokes, at half resolution: rgb = the light they add, a = how much of the scene shows through.
const smokeShader = /* glsl */ `
uniform sampler2D tDepth;
uniform vec2 smokeSize;
uniform mat4 projInv;
uniform mat4 camWorld;
uniform vec3 camPos;
uniform sampler3D tSmoke;
uniform sampler3D tSmokeNoise;
uniform int smokeCount;
uniform vec3 smokeMin[${SLOTS}];
uniform float smokeSlot[${SLOTS}];
uniform float smokeLife[${SLOTS}];
uniform float smokeTime;

const float VOX = ${VOX.toFixed(1)};
const vec3 DIM = vec3(${NX.toFixed(1)}, ${NY.toFixed(1)}, ${NZ.toFixed(1)});
const float SLOTS = ${SLOTS.toFixed(1)};

float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

// Smoke at a game-space point in cloud i: its light (rgb) and density (a, 0..1), the voxels eroded by drifting noise
// into wisps.
vec4 smoke(vec3 p, int i) {
  vec3 g = (p - smokeMin[i]) / VOX;
  vec3 uvw = vec3(g.x / DIM.x, g.y / DIM.y, (clamp(g.z, 0.5, DIM.z - 0.5) + smokeSlot[i] * DIM.z) / (DIM.z * SLOTS));
  vec4 v = texture(tSmoke, uvw);
  float d = v.a;
  if (d < 0.004) return vec4(0.0);
  vec3 drift = vec3(smokeTime * 1.5, smokeTime * -1.1, smokeTime * 2.2);
  // Big lumps (billows), then fine wisps; both eat into the edges, the fade at the end eats more.
  float lump = texture(tSmokeNoise, (p + drift) / 150.0).r;
  float wisp = texture(tSmokeNoise, (p - drift * 1.7) / 38.0).r;
  float n = lump * 0.62 + wisp * 0.38;
  float life = smokeLife[i];
  return vec4(v.rgb * ${LIGHT_SCALE.toFixed(1)} * (0.8 + 0.4 * lump), clamp((d - n * mix(0.85, 0.5, life) + 0.22) * 2.6, 0.0, 1.0) * (0.75 + 0.5 * lump));
}

void main() {
  vec2 uv = gl_FragCoord.xy / smokeSize;
  float depth = texture(tDepth, uv).r;
  vec4 view = projInv * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  view /= view.w;
  vec3 w = (camWorld * view).xyz;
  vec3 wg = vec3(w.z, w.x, w.y) / 0.0254; // glTF (metres, Y up) -> game (inches, Z up)
  vec3 rd = wg - camPos;
  float maxT = length(rd);
  rd /= maxT;
  float T = 1.0;
  vec3 L = vec3(0.0);
  float jitter = hash12(gl_FragCoord.xy + fract(smokeTime) * 61.0);
  for (int i = 0; i < ${SLOTS}; i++) {
    if (i >= smokeCount) break;
    vec3 bmin = smokeMin[i] + VOX, bmax = smokeMin[i] + (DIM - 1.0) * VOX;
    vec3 inv = 1.0 / rd;
    vec3 t0 = (bmin - camPos) * inv, t1 = (bmax - camPos) * inv;
    vec3 tn = min(t0, t1), tf = max(t0, t1);
    float a = max(max(tn.x, tn.y), max(tn.z, 0.0));
    float b = min(min(tf.x, tf.y), min(tf.z, maxT));
    if (b <= a) continue;
    float steps = clamp(ceil((b - a) / 8.0), 6.0, 64.0);
    float dt = (b - a) / steps;
    float t = a + dt * jitter;
    for (int s = 0; s < 64; s++) {
      if (float(s) >= steps || T < 0.01) break;
      vec4 v = smoke(camPos + rd * t, i);
      if (v.a > 0.0) {
        float alpha = 1.0 - exp(-v.a * 0.12 * dt);
        L += T * alpha * v.rgb;
        T *= 1.0 - alpha;
      }
      t += dt;
    }
  }
  gl_FragColor = vec4(L, T);
}`;

const compositeShader = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tFlash;
uniform sampler2D tSmokeRT;
uniform sampler2D tVm;
uniform vec2 smokeSize;
uniform bool smokeOn;
uniform bool vmOn;
uniform float flashImage;
uniform float cameraNear;
uniform float cameraFar;
uniform float exposure; // the map's exposure bias (and with auto exposure, times tExposure's)
uniform sampler2D tExposure;
uniform bool autoOn;
uniform vec4 tmCurve; // shoulder, linear strength, linear angle, toe strength
uniform vec4 tmToe; // toe numerator, toe denominator, white point, 1 / curve(white point)
uniform sampler3D tLut;
uniform bool lutOn;
uniform vec2 lutRange;
varying vec2 vUv;

// CS2's tone curve (Hable's filmic curve with the map's parameters, after a 2.8x pre-scale clamped at the white point).
vec3 cs2Curve(vec3 x) {
  vec3 n = x * (tmCurve.x * x + tmCurve.y * tmCurve.z) + tmToe.x * tmCurve.w;
  vec3 d = x * (tmCurve.x * x + tmCurve.y) + tmToe.y * tmCurve.w;
  return n / d - tmToe.x / tmToe.y;
}

float viewZ(float d) { return cameraNear * cameraFar / (cameraFar - d * (cameraFar - cameraNear)); }

// The half-resolution smoke at this pixel: its four nearest texels, weighted by distance and by how close their depth is
// to this pixel's (so a wall in front of a smoke keeps a clean edge).
vec4 smokeHere() {
  vec2 p = vUv * smokeSize - 0.5, f = fract(p), base = floor(p);
  float dc = viewZ(texture(tDepth, vUv).r);
  vec4 sum = vec4(0.0), plain = vec4(0.0);
  float wsum = 0.0;
  for (int j = 0; j < 4; j++) {
    vec2 o = vec2(float(j - (j / 2) * 2), float(j / 2));
    vec2 uv = (base + o + 0.5) / smokeSize;
    vec4 s = texture(tSmokeRT, uv);
    float bw = (o.x > 0.5 ? f.x : 1.0 - f.x) * (o.y > 0.5 ? f.y : 1.0 - f.y);
    float dz = abs(viewZ(texture(tDepth, uv).r) - dc) / max(dc, 0.01);
    float w = bw * exp(-dz * 30.0) + 1e-5;
    sum += s * w; wsum += w; plain += s * bw;
  }
  return wsum > 1e-3 ? sum / wsum : plain;
}

void main() {
  vec4 col = texture(tColor, vUv);
  if (flashImage > 0.0) col.rgb = mix(col.rgb, texture(tFlash, vUv).rgb * 1.4, flashImage);
  if (smokeOn) { vec4 s = smokeHere(); col.rgb = col.rgb * s.a + s.rgb; }
  if (vmOn) { vec4 v = texture(tVm, vUv); col.rgb = col.rgb * (1.0 - v.a) + v.rgb; }
  float ex = exposure * (autoOn ? texelFetch(tExposure, ivec2(0), 0).r : 1.0);
  vec3 c = cs2Curve(min(max(col.rgb, 0.0) * ex * 2.8, vec3(tmToe.z))) * tmToe.w;
  c = sRGBTransferOETF(vec4(clamp(c, 0.0, 1.0), 1.0)).rgb;
  if (lutOn) c = texture(tLut, c * lutRange.x + lutRange.y).rgb;
  gl_FragColor = vec4(c, 1.0);
}`;

// Average log luminance of the HDR image, 32x18 cells of 4x4 samples (for the auto exposure: see adaptShader).
const lumShader = /* glsl */ `
uniform sampler2D tColor;
varying vec2 vUv;
void main() {
  float sum = 0.0;
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
    vec3 c = texture(tColor, vUv + (vec2(float(i), float(j)) - 1.5) / vec2(128.0, 72.0)).rgb;
    sum += log(max(dot(c, vec3(0.2125, 0.7154, 0.0721)), 1e-4));
  }
  gl_FragColor = vec4(sum / 16.0, 0.0, 0.0, 1.0);
}`;

// The auto exposure, all on the GPU: the image's average (log) luminance from lumShader's cells, where the exposure
// heads for it (middle grey, within the map's range), and this frame's exposure from last frame's, eased toward that
// (faster brightening or darkening by the map's speeds). One pixel, kept in a pair of 1x1 targets in turn and read by
// the composite. (Read back to the CPU it cost ~10 ms each time it arrived, a hitch five times a second.)
const adaptShader = /* glsl */ `
uniform sampler2D tLum, tPrev;
uniform float dt, up, down, lo, hi, middle;
uniform bool init;
varying vec2 vUv;
void main() {
  float sum = 0.0;
  for (int y = 0; y < 18; y++) for (int x = 0; x < 32; x++) sum += texelFetch(tLum, ivec2(x, y), 0).r;
  float target = clamp(middle / max(exp(sum / 576.0), 1e-4), lo, hi);
  float prev = init ? clamp(1.0, lo, hi) : texelFetch(tPrev, ivec2(0), 0).r;
  float e = prev + (target - prev) * (1.0 - exp(-dt * 1.5 * (target > prev ? up : down)));
  gl_FragColor = vec4(e, 0.0, 0.0, 1.0);
}`;

// CS2's default curve where a map gives none (nearly linear).
const LINEAR_CURVE = { exposureBias: 0, shoulder: 0, linear: 0.001, angle: 0.001, toe: 1, toeNum: 1, toeDenom: 1, white: 1.5 };
const curve = (t, x) => (x * (t.shoulder * x + t.linear * t.angle) + t.toeNum * t.toe) / (x * (t.shoulder * x + t.linear) + t.toeDenom * t.toe) - t.toeNum / t.toeDenom;

export class Post {
  constructor(renderer, { samples = 4, smoke }) {
    this.renderer = renderer;
    const depthTexture = new THREE.DepthTexture(1, 1);
    this.rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples, depthTexture });
    this.flashRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.smokeRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.vmRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples });
    this.lumRT = new THREE.WebGLRenderTarget(32, 18, { type: THREE.FloatType, depthBuffer: false });
    const one = () => new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.expRT = [one(), one()]; this.expCur = 0; // (the auto exposure's pixel: last frame's and this frame's, in turn)
    this.exposure = 1; // (the starting exposure; with auto exposure the GPU keeps the current one)
    this.lut = null;
    this.smoke = smoke;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    const pass = (material) => { const m = new THREE.Mesh(geo, material); m.frustumCulled = false; const s = new THREE.Scene(); s.add(m); return s; };
    const shared = { tDepth: { value: depthTexture }, smokeSize: { value: new THREE.Vector2(1, 1) } };
    this.smokeMat = new THREE.ShaderMaterial({
      vertexShader, fragmentShader: smokeShader, depthTest: false, depthWrite: false, toneMapped: false,
      uniforms: { ...shared, projInv: { value: new THREE.Matrix4() }, camWorld: { value: new THREE.Matrix4() }, camPos: { value: new THREE.Vector3() }, ...smoke.uniforms },
    });
    this.material = new THREE.ShaderMaterial({
      vertexShader, fragmentShader: compositeShader, depthTest: false, depthWrite: false,
      uniforms: {
        ...shared, tColor: { value: this.rt.texture }, tFlash: { value: this.flashRT.texture }, tSmokeRT: { value: this.smokeRT.texture },
        tVm: { value: this.vmRT.texture }, vmOn: { value: false },
        smokeOn: { value: false }, flashImage: { value: 0 }, cameraNear: { value: 0.05 }, cameraFar: { value: 400 },
        exposure: { value: 1 }, tExposure: { value: null }, autoOn: { value: false }, tmCurve: { value: new THREE.Vector4() }, tmToe: { value: new THREE.Vector4() },
        tLut: { value: null }, lutOn: { value: false }, lutRange: { value: new THREE.Vector2(1, 0) },
      },
    });
    this.smokeScene = pass(this.smokeMat);
    this.scene = pass(this.material);
    this.geo = geo;
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    // Copies the world image for the flashbang's afterimage.
    this.copyMat = new THREE.ShaderMaterial({
      vertexShader, depthTest: false, depthWrite: false, toneMapped: false, uniforms: { tColor: { value: this.rt.texture } },
      fragmentShader: 'uniform sampler2D tColor; varying vec2 vUv; void main() { gl_FragColor = texture(tColor, vUv); }',
    });
    this.copyScene = pass(this.copyMat);
    this.lumMat = new THREE.ShaderMaterial({ vertexShader, fragmentShader: lumShader, depthTest: false, depthWrite: false, toneMapped: false, uniforms: { tColor: { value: this.rt.texture } } });
    this.lumScene = pass(this.lumMat);
    this.adaptMat = new THREE.ShaderMaterial({
      vertexShader, fragmentShader: adaptShader, depthTest: false, depthWrite: false, toneMapped: false,
      uniforms: { tLum: { value: this.lumRT.texture }, tPrev: { value: null }, dt: { value: 0 }, up: { value: 1 }, down: { value: 1 }, lo: { value: 1 }, hi: { value: 1 }, middle: { value: 0.18 }, init: { value: true } },
    });
    this.adaptScene = pass(this.adaptMat);
    this.setGrading({});
  }

  // The map's post processing: tone (its curve), lut ({ data: RGB bytes, red fastest; size }), exposure (auto
  // exposure's { min, max, up, down, compensation }; none: a fixed exposure of 1, like CS2).
  setGrading({ tone = null, lut = null, exposure = null }) {
    const t = { ...LINEAR_CURVE, ...(tone || {}) }, u = this.material.uniforms;
    const white = Math.pow(2, t.white);
    u.tmCurve.value.set(t.shoulder, t.linear, t.angle, t.toe);
    u.tmToe.value.set(t.toeNum, t.toeDenom, white, 1 / curve(t, white));
    this.tone = t; this.white = white;
    this.bias = Math.pow(2, t.exposureBias || 0);
    this.auto = exposure;
    this.exposure = exposure ? Math.min(exposure.max, Math.max(exposure.min, 1)) : 1;
    // Where middle grey comes out: the scene value the curve shows as 0.18 (for the auto exposure's target).
    let lo = 0, hi = white / 2.8;
    for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (curve(t, Math.min(m * 2.8, white)) / curve(t, white) < 0.18) lo = m; else hi = m; }
    this.middle = (lo + hi) / 2;
    const au = this.adaptMat.uniforms;
    if (exposure) { au.up.value = exposure.up; au.down.value = exposure.down; au.lo.value = exposure.min; au.hi.value = exposure.max; au.middle.value = this.middle; }
    au.init.value = true; // (a new map: from the start again)
    this.lut?.dispose();
    this.lut = null;
    if (lut?.data) {
      const n = lut.size, rgba = new Uint8Array(n * n * n * 4);
      for (let i = 0; i < n * n * n; i++) { rgba[i * 4] = lut.data[i * 3]; rgba[i * 4 + 1] = lut.data[i * 3 + 1]; rgba[i * 4 + 2] = lut.data[i * 3 + 2]; rgba[i * 4 + 3] = 255; }
      const tex = new THREE.Data3DTexture(rgba, n, n, n);
      tex.format = THREE.RGBAFormat; tex.type = THREE.UnsignedByteType;
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
      tex.unpackAlignment = 1;
      tex.needsUpdate = true;
      this.lut = tex;
      u.lutRange.value.set(1 - 1 / n, 0.5 / n);
    }
    u.tLut.value = this.lut;
    u.lutOn.value = !!this.lut;
  }

  // Auto exposure: a few times a second, the image's average (log) luminance sets where the exposure heads, within the
  // map's range, at its speeds. Read back when the GPU has it (waiting for it stalled the frame).
  updateExposure(dt) {
    const u = this.material.uniforms;
    u.autoOn.value = !!this.auto;
    if (!this.auto) return;
    const r = this.renderer, au = this.adaptMat.uniforms, prev = this.expRT[this.expCur], next = this.expRT[1 - this.expCur];
    r.setRenderTarget(this.lumRT);
    r.render(this.lumScene, this.cam);
    au.tPrev.value = prev.texture; au.dt.value = Math.min(dt, 0.25);
    r.setRenderTarget(next);
    r.render(this.adaptScene, this.cam);
    au.init.value = false;
    this.expCur = 1 - this.expCur;
    u.tExposure.value = next.texture;
  }

  setSize(w, h) {
    this.rt.setSize(w, h);
    this.flashRT.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    this.smokeRT.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    this.vmRT.setSize(w, h);
    this.material.uniforms.smokeSize.value.set(Math.max(1, w >> 1), Math.max(1, h >> 1));
  }

  // Lighting for the smoke from the map's sun and sky (baked into the voxels by smoke.js).
  setLighting({ sunDir, sun, ambient }) {
    const l = Math.hypot(...sunDir) || 1;
    const c = (col, k) => [col.r * k, col.g * k, col.b * k];
    this.smoke.setLighting({ sunDir: sunDir.map((v) => v / l), sun: c(sun.color, sun.intensity * 0.075), sky: c(ambient.sky.value, 0.95), ground: c(ambient.ground.value, 0.55) });
  }

  // Compiles the world's shaders (and the overlay's: { scene, camera }) for drawing into their render targets, and
  // the passes.
  compile(scene, camera, overlay = null) {
    const r = this.renderer;
    r.setRenderTarget(this.rt);
    r.compile(scene, camera);
    if (overlay) { r.setRenderTarget(this.vmRT); r.compile(overlay.scene, overlay.camera); }
    r.setRenderTarget(this.smokeRT);
    r.compile(this.smokeScene, this.cam);
    r.setRenderTarget(this.lumRT);
    r.compile(this.lumScene, this.cam);
    r.setRenderTarget(this.expRT[0]);
    r.compile(this.adaptScene, this.cam);
    r.setRenderTarget(null);
    r.compile(this.scene, this.cam);
  }

  // Draws the world, the smokes, the weapon (overlay: { scene, camera } or null) and the composite onto the screen.
  // captureFlash keeps this frame as the afterimage.
  // sky3d: the map's 3D skybox ({ scene, camera }), drawn first, behind everything.
  render(scene, camera, { camPos, flashImage = 0, captureFlash = false, overlay = null, dt = 0, sky3d = null }) {
    const r = this.renderer, u = this.material.uniforms, su = this.smokeMat.uniforms;
    r.setRenderTarget(this.rt);
    r.clear();
    if (sky3d) {
      r.render(sky3d.scene, sky3d.camera);
      r.clearDepth();
      const bg = scene.background;
      scene.background = null;
      r.render(scene, camera);
      scene.background = bg;
    } else r.render(scene, camera);
    if (overlay) {
      const alpha = r.getClearAlpha();
      r.setRenderTarget(this.vmRT);
      r.setClearAlpha(0);
      r.clear();
      r.render(overlay.scene, overlay.camera);
      r.setClearAlpha(alpha);
    }
    u.vmOn.value = !!overlay;
    this.updateExposure(dt);
    u.exposure.value = (this.auto ? 1 : this.exposure) * this.bias;
    if (captureFlash) { r.setRenderTarget(this.flashRT); r.render(this.copyScene, this.cam); }
    const smokes = this.smoke.active;
    if (smokes) {
      camera.updateMatrixWorld();
      su.projInv.value.copy(camera.projectionMatrixInverse);
      su.camWorld.value.copy(camera.matrixWorld);
      su.camPos.value.set(camPos[0], camPos[1], camPos[2]);
      r.setRenderTarget(this.smokeRT);
      r.render(this.smokeScene, this.cam);
    }
    r.setRenderTarget(null);
    u.smokeOn.value = smokes;
    u.flashImage.value = flashImage;
    u.cameraNear.value = camera.near; u.cameraFar.value = camera.far;
    r.render(this.scene, this.cam);
  }

  dispose() {
    this.disposed = true;
    this.rt.depthTexture?.dispose();
    for (const t of [this.rt, this.flashRT, this.smokeRT, this.vmRT, this.lumRT, ...this.expRT]) t.dispose();
    for (const m of [this.material, this.smokeMat, this.copyMat, this.lumMat, this.adaptMat]) m.dispose();
    this.lut?.dispose();
    this.geo.dispose();
  }
}
