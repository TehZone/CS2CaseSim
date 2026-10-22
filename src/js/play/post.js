// The world is drawn into an HDR render target (with its depth), then a full-screen pass puts it on screen: it
// ray-marches the volumetric smokes against that depth (so walls in front hide them and they end at walls), adds the
// flashbang's afterimage, then tone-maps like the renderer would. The first-person weapon is drawn on top afterwards.
import * as THREE from 'three';
import { VOX, NX, NY, NZ, SLOTS } from './smoke.js';

const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const fragmentShader = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tFlash;
uniform float flashImage;
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
uniform vec3 sunDir;
uniform vec3 smokeSun;
uniform vec3 smokeSky;
uniform vec3 smokeGround;
varying vec2 vUv;

const float VOX = ${VOX.toFixed(1)};
const vec3 DIM = vec3(${NX.toFixed(1)}, ${NY.toFixed(1)}, ${NZ.toFixed(1)});
const float SLOTS = ${SLOTS.toFixed(1)};

float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

// Smoke density (0..1) at a game-space point in cloud i: the voxels, eroded by drifting noise into wisps.
float density(vec3 p, int i) {
  vec3 g = (p - smokeMin[i]) / VOX;
  vec3 uvw = vec3(g.x / DIM.x, g.y / DIM.y, (clamp(g.z, 0.5, DIM.z - 0.5) + smokeSlot[i] * DIM.z) / (DIM.z * SLOTS));
  float d = texture(tSmoke, uvw).r;
  if (d < 0.004) return 0.0;
  vec3 drift = vec3(smokeTime * 1.5, smokeTime * -1.1, smokeTime * 2.2);
  // Big lumps (billows), then fine wisps; both eat into the edges, the fade at the end eats more.
  float lump = texture(tSmokeNoise, (p + drift) / 150.0).r;
  float wisp = texture(tSmokeNoise, (p - drift * 1.7) / 38.0).r;
  float n = lump * 0.62 + wisp * 0.38;
  float life = smokeLife[i];
  return clamp((d - n * mix(0.85, 0.5, life) + 0.22) * 2.6, 0.0, 1.0) * (0.75 + 0.5 * lump);
}

void main() {
  vec4 col = texture(tColor, vUv);
  if (flashImage > 0.0) col.rgb = mix(col.rgb, texture(tFlash, vUv).rgb * 1.4, flashImage);
  if (smokeCount > 0) {
    float depth = texture(tDepth, vUv).r;
    vec4 view = projInv * vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
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
      float steps = clamp(ceil((b - a) / 7.0), 6.0, 72.0);
      float dt = (b - a) / steps;
      float t = a + dt * jitter;
      for (int s = 0; s < 72; s++) {
        if (float(s) >= steps || T < 0.01) break;
        vec3 p = camPos + rd * t;
        float d = density(p, i);
        if (d > 0.0) {
          float alpha = 1.0 - exp(-d * 0.12 * dt);
          // Light: the sky from above (less deep inside, under more smoke), the sun through the cloud towards it.
          float toSun = density(p + sunDir * 20.0, i) + density(p + sunDir * 52.0, i) + density(p + sunDir * 96.0, i);
          float above = density(p + vec3(0.0, 0.0, 40.0), i) + density(p + vec3(0.0, 0.0, 90.0), i);
          float up = clamp((p.z - smokeMin[i].z - 2.0 * VOX) / (8.0 * VOX), 0.0, 1.0);
          vec3 sky = mix(smokeGround, smokeSky, 0.3 + 0.7 * up) * (1.0 - 0.32 * clamp(above * 0.6, 0.0, 1.0));
          vec3 light = sky + smokeSun * exp(-toSun * 1.8);
          L += T * alpha * light * 0.72;
          T *= 1.0 - alpha;
        }
        t += dt;
      }
    }
    col.rgb = col.rgb * T + L;
  }
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
    this.material = new THREE.ShaderMaterial({
      vertexShader, fragmentShader, depthTest: false, depthWrite: false,
      uniforms: {
        tColor: { value: this.rt.texture }, tDepth: { value: depthTexture }, tFlash: { value: this.flashRT.texture }, flashImage: { value: 0 },
        projInv: { value: new THREE.Matrix4() }, camWorld: { value: new THREE.Matrix4() }, camPos: { value: new THREE.Vector3() },
        sunDir: { value: new THREE.Vector3(0, 0, 1) }, smokeSun: { value: new THREE.Color() }, smokeSky: { value: new THREE.Color() }, smokeGround: { value: new THREE.Color() },
        ...smoke.uniforms,
      },
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new THREE.Mesh(geo, this.material);
    this.quad.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.quad);
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    // Copies the world image for the flashbang's afterimage.
    this.copy = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      vertexShader, depthTest: false, depthWrite: false, uniforms: { tColor: { value: this.rt.texture } },
      fragmentShader: 'uniform sampler2D tColor; varying vec2 vUv; void main() { gl_FragColor = texture(tColor, vUv); }',
    }));
    this.copy.frustumCulled = false;
    this.copyScene = new THREE.Scene();
    this.copyScene.add(this.copy);
  }

  setSize(w, h) {
    this.rt.setSize(w, h);
    this.flashRT.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
  }

  // Lighting for the smoke from the map's sun and sky.
  setLighting({ sunDir, sun, ambient }) {
    const u = this.material.uniforms;
    u.sunDir.value.set(sunDir[0], sunDir[1], sunDir[2]).normalize();
    u.smokeSun.value.copy(sun.color).multiplyScalar(sun.intensity * 0.075);
    u.smokeSky.value.copy(ambient.sky.value).multiplyScalar(0.95);
    u.smokeGround.value.copy(ambient.ground.value).multiplyScalar(0.55);
  }

  // Compiles the world's shaders for drawing into the render target.
  compile(scene, camera) {
    const r = this.renderer;
    r.setRenderTarget(this.rt);
    r.compile(scene, camera);
    r.setRenderTarget(null);
    r.compile(this.scene, this.cam);
  }

  // Draws the world through the composite pass onto the screen. captureFlash keeps this frame as the afterimage.
  render(scene, camera, { camPos, flashImage = 0, captureFlash = false }) {
    const r = this.renderer, u = this.material.uniforms;
    r.setRenderTarget(this.rt);
    r.clear();
    r.render(scene, camera);
    if (captureFlash) { r.setRenderTarget(this.flashRT); r.render(this.copyScene, this.cam); }
    r.setRenderTarget(null);
    camera.updateMatrixWorld();
    u.projInv.value.copy(camera.projectionMatrixInverse);
    u.camWorld.value.copy(camera.matrixWorld);
    u.camPos.value.set(camPos[0], camPos[1], camPos[2]);
    u.flashImage.value = flashImage;
    r.render(this.scene, this.cam);
  }

  dispose() {
    this.rt.depthTexture?.dispose();
    this.rt.dispose();
    this.flashRT.dispose();
    this.material.dispose();
    this.copy.material.dispose();
    this.quad.geometry.dispose();
  }
}
