// The world is drawn into an HDR render target (with its depth). The volumetric smokes are ray-marched against that
// depth (so walls in front hide them and they end at walls) at half resolution, like CS2 does, then a full-screen pass
// puts it all on screen: it blends the smoke back in (depth-aware, so it doesn't bleed over edges in front of it), adds
// the flashbang's afterimage, then tone-maps like the renderer would. The first-person weapon is drawn on top
// afterwards.
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
uniform vec2 smokeSize;
uniform bool smokeOn;
uniform float flashImage;
uniform float cameraNear;
uniform float cameraFar;
varying vec2 vUv;

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
  gl_FragColor = col;
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class Post {
  constructor(renderer, { samples = 4, smoke }) {
    this.renderer = renderer;
    const depthTexture = new THREE.DepthTexture(1, 1);
    this.rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples, depthTexture });
    this.flashRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.smokeRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
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
        smokeOn: { value: false }, flashImage: { value: 0 }, cameraNear: { value: 0.05 }, cameraFar: { value: 400 },
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
  }

  setSize(w, h) {
    this.rt.setSize(w, h);
    this.flashRT.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    this.smokeRT.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    this.material.uniforms.smokeSize.value.set(Math.max(1, w >> 1), Math.max(1, h >> 1));
  }

  // Lighting for the smoke from the map's sun and sky (baked into the voxels by smoke.js).
  setLighting({ sunDir, sun, ambient }) {
    const l = Math.hypot(...sunDir) || 1;
    const c = (col, k) => [col.r * k, col.g * k, col.b * k];
    this.smoke.setLighting({ sunDir: sunDir.map((v) => v / l), sun: c(sun.color, sun.intensity * 0.075), sky: c(ambient.sky.value, 0.95), ground: c(ambient.ground.value, 0.55) });
  }

  // Compiles the world's shaders for drawing into the render target, and the passes.
  compile(scene, camera) {
    const r = this.renderer;
    r.setRenderTarget(this.rt);
    r.compile(scene, camera);
    r.setRenderTarget(this.smokeRT);
    r.compile(this.smokeScene, this.cam);
    r.setRenderTarget(null);
    r.compile(this.scene, this.cam);
  }

  // Draws the world, the smokes and the composite onto the screen. captureFlash keeps this frame as the afterimage.
  render(scene, camera, { camPos, flashImage = 0, captureFlash = false }) {
    const r = this.renderer, u = this.material.uniforms, su = this.smokeMat.uniforms;
    r.setRenderTarget(this.rt);
    r.clear();
    r.render(scene, camera);
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
    this.rt.depthTexture?.dispose();
    for (const t of [this.rt, this.flashRT, this.smokeRT]) t.dispose();
    for (const m of [this.material, this.smokeMat, this.copyMat]) m.dispose();
    this.geo.dispose();
  }
}
