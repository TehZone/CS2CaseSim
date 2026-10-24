// Combat effects: bullet holes, impact dust/sparks, blood, tracers and the muzzle flash. Positions come in game
// units and are drawn in the glTF scene.
import * as THREE from 'three';
import { toGl, IN } from './world.js';

function canvasTexture(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const soft = (color) => canvasTexture(64, (g, s) => {
  const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  r.addColorStop(0, color); r.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = r; g.fillRect(0, 0, s, s);
});
const holeTex = () => canvasTexture(64, (g, s) => {
  const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  r.addColorStop(0, 'rgba(8,6,5,1)'); r.addColorStop(0.3, 'rgba(20,16,12,0.95)'); r.addColorStop(0.55, 'rgba(60,50,40,0.45)'); r.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = r; g.fillRect(0, 0, s, s);
});
const flashTex = () => canvasTexture(128, (g, s) => {
  g.translate(s / 2, s / 2);
  for (let i = 0; i < 7; i++) {
    g.rotate((Math.PI * 2) / 7 + Math.random() * 0.3);
    const r = g.createLinearGradient(0, 0, s / 2, 0);
    r.addColorStop(0, 'rgba(255,240,190,1)'); r.addColorStop(1, 'rgba(255,140,40,0)');
    g.fillStyle = r;
    g.beginPath(); g.moveTo(0, -5); g.lineTo(s / 2 * (0.6 + Math.random() * 0.4), 0); g.lineTo(0, 5); g.fill();
  }
  const c = g.createRadialGradient(0, 0, 0, 0, 0, s / 4);
  c.addColorStop(0, 'rgba(255,250,220,1)'); c.addColorStop(1, 'rgba(255,170,60,0)');
  g.fillStyle = c; g.fillRect(-s / 2, -s / 2, s, s);
});

const DUST = { concrete: 0xb8b0a4, rock: 0xb8b0a4, tile: 0xc8c0b4, sand: 0xd8c09a, dirt: 0xa08060, default: 0xb0a898 };

export class Effects {
  constructor(scene, vmScene) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.holeMat = new THREE.MeshBasicMaterial({ map: holeTex(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    this.holeGeo = new THREE.PlaneGeometry(3.2 * IN, 3.2 * IN);
    // The last 120 bullet holes, in one draw (a mesh each cost a draw each).
    this.holes = new THREE.InstancedMesh(this.holeGeo, this.holeMat, 120);
    this.holes.count = 0;
    this.holes.frustumCulled = false;
    this.holeNext = 0;
    this.holePose = new THREE.Object3D();
    this.group.add(this.holes);
    this.puffTex = soft('rgba(255,255,255,0.9)');
    this.sparkTex = soft('rgba(255,220,140,1)');
    this.particles = [];
    this.tracerMat = new THREE.LineBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0.85 });
    this.tracers = [];
    // muzzle flash in the viewmodel scene
    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex(), color: 0xffd9a0, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, depthTest: false }));
    this.flash.visible = false;
    this.flash.renderOrder = 10;
    vmScene?.add(this.flash);
    this.flashLeft = 0;
  }

  // A bullet hole on a wall plus a puff of dust (or sparks on metal).
  impact(pos, normal, surface = 'default') {
    const p = toGl(pos), n = new THREE.Vector3(normal[1], normal[2], normal[0]);
    const hole = this.holePose, H = this.holes;
    hole.position.copy(p).addScaledVector(n, 0.002);
    hole.rotation.set(0, 0, 0);
    hole.lookAt(p.clone().add(n));
    hole.rotateZ(Math.random() * Math.PI * 2);
    hole.scale.setScalar(0.7 + Math.random() * 0.5);
    hole.updateMatrix();
    H.setMatrixAt(this.holeNext, hole.matrix);
    this.holeNext = (this.holeNext + 1) % H.instanceMatrix.count;
    H.count = Math.min(H.instanceMatrix.count, H.count + 1);
    H.instanceMatrix.needsUpdate = true;
    const metal = /metal|chainlink/i.test(surface);
    const color = DUST[surface.toLowerCase()] ?? (metal ? 0xffd080 : /wood/i.test(surface) ? 0x9a7b55 : DUST.default);
    this.puff(p, n, metal ? this.sparkTex : this.puffTex, color, metal ? 6 : 3, metal);
  }

  blood(pos, dir) {
    const p = toGl(pos), n = new THREE.Vector3(-dir[1], -dir[2], -dir[0]);
    this.puff(p, n, this.puffTex, 0x8a0d0d, 4, false, 0.5);
  }

  puff(p, n, tex, color, count, sparks, life = 0.6) {
    for (let i = 0; i < count; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color, transparent: true, depthWrite: false, opacity: sparks ? 1 : 0.7, blending: sparks ? THREE.AdditiveBlending : THREE.NormalBlending }));
      s.position.copy(p).addScaledVector(n, 0.03);
      const v = n.clone().multiplyScalar(sparks ? 3 : 0.6).add(new THREE.Vector3((Math.random() - 0.5), (Math.random() - 0.2), (Math.random() - 0.5)).multiplyScalar(sparks ? 2.5 : 0.5));
      const size = sparks ? 0.025 : 0.12 + Math.random() * 0.1;
      s.scale.setScalar(size);
      this.group.add(s);
      this.particles.push({ s, v, life: sparks ? 0.25 : life, age: 0, size, grow: sparks ? 0 : 0.6, gravity: sparks ? 6 : -0.3 });
    }
  }

  tracer(from, to) {
    const g = new THREE.BufferGeometry().setFromPoints([toGl(from), toGl(to)]);
    const l = new THREE.Line(g, this.tracerMat.clone());
    this.group.add(l);
    this.tracers.push({ l, age: 0 });
  }

  // A bot's muzzle flash in the world (game units).
  worldFlash(pos) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.flash.material.map, color: 0xffd9a0, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
    s.position.copy(toGl(pos));
    s.material.rotation = Math.random() * Math.PI * 2;
    s.scale.setScalar(0.35);
    this.group.add(s);
    this.particles.push({ s, v: new THREE.Vector3(), life: 0.05, age: 0, size: 0.35, grow: 0, gravity: 0, keepMap: true });
  }

  // An explosion (the bomb, or smaller for an HE grenade): a flash of fire and smoke.
  explosion(pos, scale = 1) {
    const p = toGl(pos);
    for (let i = 0; i < Math.round(26 * Math.sqrt(scale)); i++) {
      const fire = i < 10;
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.puffTex, color: fire ? 0xffb050 : 0x6a625a, transparent: true, depthWrite: false, blending: fire ? THREE.AdditiveBlending : THREE.NormalBlending }));
      s.position.copy(p).add(new THREE.Vector3((Math.random() - 0.5) * 2 * scale, Math.random() * 1.5 * scale, (Math.random() - 0.5) * 2 * scale));
      const size = (fire ? 4 + Math.random() * 4 : 3 + Math.random() * 3) * scale;
      s.scale.setScalar(size);
      this.group.add(s);
      const v = new THREE.Vector3((Math.random() - 0.5) * 8, 2 + Math.random() * 6, (Math.random() - 0.5) * 8).multiplyScalar(scale);
      this.particles.push({ s, v, life: fire ? 0.8 : 3.5 * Math.sqrt(scale), age: 0, size, grow: fire ? 0.4 : 0.5, gravity: -0.5 });
    }
  }

  // A flashbang going off: a white pop.
  flashPop(pos) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.puffTex, color: 0xffffff, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
    s.position.copy(toGl(pos));
    s.scale.setScalar(3);
    this.group.add(s);
    this.particles.push({ s, v: new THREE.Vector3(), life: 0.25, age: 0, size: 3, grow: 0.6, gravity: 0 });
  }

  // While the map's shaders compile (on), one of each kind of thing this draws is in the scene and the muzzle flash
  // shows, so the first shot doesn't compile them mid-fight; off takes them out again. The sprite's material is kept: a
  // shader goes when the last material using it is disposed, and every puff's is (the next one compiled it again).
  warmUp(on) {
    if (on) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.puffTex, transparent: true, depthWrite: false }));
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0.01, 0)]), this.tracerMat);
      this.warm = [s, l];
      this.group.add(s, l);
    } else for (const o of this.warm || []) { this.group.remove(o); if (o.isLine) o.geometry.dispose(); else this.keep = o.material; }
    this.flash.visible = on;
  }

  // Bullet holes and particles go away when a round restarts.
  clear() {
    this.holes.count = 0;
    this.holeNext = 0;
    for (const p of this.particles) { this.group.remove(p.s); p.s.material.dispose(); }
    this.particles = [];
  }

  muzzleFlash(pos) {
    this.flash.position.copy(pos);
    this.flash.material.rotation = Math.random() * Math.PI * 2;
    const s = 0.09 + Math.random() * 0.05;
    this.flash.scale.set(s, s, s);
    this.flash.visible = true;
    this.flashLeft = 0.035;
  }

  update(dt) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.age += dt;
      const k = p.age / p.life;
      if (k >= 1) { this.group.remove(p.s); p.s.material.dispose(); this.particles.splice(i, 1); continue; }
      p.v.y -= p.gravity * dt;
      p.s.position.addScaledVector(p.v, dt);
      p.s.scale.setScalar(p.size * (1 + p.grow * k * 3));
      p.s.material.opacity = (1 - k) * (p.grow ? 0.7 : 1);
    }
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.age += dt;
      if (t.age > 0.06) { this.group.remove(t.l); t.l.geometry.dispose(); t.l.material.dispose(); this.tracers.splice(i, 1); }
    }
    if (this.flashLeft > 0) { this.flashLeft -= dt; if (this.flashLeft <= 0) this.flash.visible = false; }
  }

  dispose() {
    this.group.removeFromParent();
    this.holeMat.map.dispose(); this.holeMat.dispose(); this.holeGeo.dispose();
    this.puffTex.dispose(); this.sparkTex.dispose();
    this.flash.material.map.dispose(); this.flash.material.dispose(); this.keep?.dispose();
    for (const p of this.particles) p.s.material.dispose();
    for (const t of this.tracers) { t.l.geometry.dispose(); t.l.material.dispose(); }
  }
}
