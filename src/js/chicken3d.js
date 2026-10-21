// Procedural low-poly CS-style chickens with breed materials and hats.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { BREED } from './chickens.js';
import { mulberry32 } from './util.js';

const ORANGE = 0xf2a43a, RED = 0xd8262e;

function patternTexture(kind, base, seed) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  const r = mulberry32(seed + 1);
  g.fillStyle = base;
  g.fillRect(0, 0, 256, 128);
  if (kind === 'speckle') {
    for (let i = 0; i < 260; i++) {
      g.fillStyle = r() < 0.5 ? '#3b2c22' : '#7b5a40';
      g.beginPath(); g.ellipse(r() * 256, r() * 128, 1.5 + r() * 2.5, 1 + r() * 2, r() * 3, 0, 7); g.fill();
    }
  } else if (kind === 'rot') {
    for (let i = 0; i < 40; i++) {
      g.fillStyle = r() < 0.5 ? 'rgba(70,40,40,0.7)' : 'rgba(150,170,110,0.6)';
      g.beginPath(); g.ellipse(r() * 256, r() * 128, 6 + r() * 14, 4 + r() * 10, r() * 3, 0, 7); g.fill();
    }
  } else if (kind === 'camo') {
    const cols = ['#8c7650', '#d1bd8f', '#6e5a3b', '#a8916a'];
    for (let i = 0; i < 70; i++) {
      g.fillStyle = cols[i % cols.length];
      g.beginPath(); g.ellipse(r() * 256, r() * 128, 8 + r() * 20, 5 + r() * 12, r() * 3, 0, 7); g.fill();
    }
  } else if (kind === 'lore') {
    // Dragon Lore-ish: parchment gold with dark green scale swirls
    g.fillStyle = '#d8b765'; g.fillRect(0, 0, 256, 128);
    for (let y = 0; y < 128; y += 10) {
      for (let x = (y / 10) % 2 ? 0 : 7; x < 256; x += 14) {
        g.strokeStyle = 'rgba(52,72,40,0.85)'; g.lineWidth = 1.6;
        g.beginPath(); g.arc(x, y, 6, 0, Math.PI); g.stroke();
      }
    }
    g.strokeStyle = 'rgba(120,40,20,0.8)'; g.lineWidth = 4;
    g.beginPath(); g.moveTo(0, 90);
    for (let x = 0; x <= 256; x += 16) g.quadraticCurveTo(x + 8, 60 + Math.sin(x) * 30, x + 16, 90 - Math.cos(x) * 20);
    g.stroke();
  } else if (kind === 'neon') {
    g.fillStyle = '#1b0f2e'; g.fillRect(0, 0, 256, 128);
    const cols = ['#ff3fa4', '#2fe3ff', '#ffe14d'];
    for (let i = 0; i < 9; i++) {
      g.strokeStyle = cols[i % 3]; g.lineWidth = 5;
      g.beginPath(); g.moveTo(i * 32 - 20, 0); g.lineTo(i * 32 + 40, 128); g.stroke();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function bodyMaterial(b, seed) {
  if (b.metal) return new THREE.MeshPhysicalMaterial({ color: b.color, metalness: 1, roughness: 0.17, clearcoat: 0.6 });
  if (b.holo) return new THREE.MeshPhysicalMaterial({ color: b.color, metalness: 0.75, roughness: 0.12, iridescence: 1, iridescenceIOR: 1.8, iridescenceThicknessRange: [200, 900], clearcoat: 1 });
  if (b.crystal) return new THREE.MeshPhysicalMaterial({ color: b.color, metalness: 0, roughness: 0.02, transmission: 0.92, thickness: 1.4, ior: 2.4, clearcoat: 1, flatShading: true, envMapIntensity: 1.6 });
  if (b.ghost) return new THREE.MeshPhysicalMaterial({ color: b.color, transparent: true, opacity: 0.55, roughness: 0.25, emissive: 0x6fa8ff, emissiveIntensity: 0.35, depthWrite: false });
  if (b.neon) return new THREE.MeshStandardMaterial({ map: patternTexture('neon', b.color, seed), emissive: 0xffffff, emissiveMap: patternTexture('neon', b.color, seed), emissiveIntensity: 0.55, roughness: 0.4 });
  if (b.lore) return new THREE.MeshPhysicalMaterial({ map: patternTexture('lore', b.color, seed), metalness: 0.35, roughness: 0.38, clearcoat: 0.7 });
  if (b.pattern) return new THREE.MeshStandardMaterial({ map: patternTexture(b.pattern, b.color, seed), roughness: 0.9 });
  return new THREE.MeshStandardMaterial({ color: b.color, roughness: 0.9 });
}

const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, ...extra });
const gold = () => new THREE.MeshPhysicalMaterial({ color: 0xf2c34b, metalness: 1, roughness: 0.15, clearcoat: 0.5 });

function mesh(geo, mat, pos, rot, scale) {
  const m = new THREE.Mesh(geo, mat);
  if (pos) m.position.set(...pos);
  if (rot) m.rotation.set(...rot);
  if (scale) m.scale.set(...scale);
  return m;
}

function stripeTexture(a, b) {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = a; g.fillRect(0, 0, 64, 64);
  g.fillStyle = b;
  for (let i = -64; i < 64; i += 16) { g.beginPath(); g.moveTo(i, 64); g.lineTo(i + 8, 64); g.lineTo(i + 72, 0); g.lineTo(i + 64, 0); g.fill(); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function buildHat(id) {
  const g = new THREE.Group();
  switch (id) {
    case 'party': {
      g.add(mesh(new THREE.ConeGeometry(0.26, 0.7, 24), new THREE.MeshStandardMaterial({ map: stripeTexture('#2f7cff', '#ffd23f'), roughness: 0.5 }), [0, 0.33, 0], [0, 0, 0.18]));
      g.add(mesh(new THREE.SphereGeometry(0.09, 12, 10), std(0xff4fa0), [-0.12, 0.68, 0]));
      break;
    }
    case 'santa': {
      g.add(mesh(new THREE.ConeGeometry(0.33, 0.72, 24), std(0xc8102e), [0, 0.36, -0.05], [-0.35, 0, 0]));
      g.add(mesh(new THREE.TorusGeometry(0.33, 0.08, 10, 24), std(0xffffff, { roughness: 1 }), [0, 0.02, 0], [Math.PI / 2, 0, 0]));
      g.add(mesh(new THREE.SphereGeometry(0.1, 12, 10), std(0xffffff, { roughness: 1 }), [0, 0.62, -0.32]));
      break;
    }
    case 'bandana': {
      const mat = std(0xb3121f);
      g.add(mesh(new THREE.TorusGeometry(0.44, 0.07, 10, 28), mat, [0, -0.1, 0], [Math.PI / 2 - 0.15, 0, 0]));
      g.add(mesh(new THREE.ConeGeometry(0.1, 0.32, 8), mat, [0, -0.08, -0.5], [-1.2, 0, 0]));
      break;
    }
    case 'bunny': {
      const outer = std(0xf5f5f5, { roughness: 0.95 }), inner = std(0xffb6c8, { roughness: 0.95 });
      for (const s of [-1, 1]) {
        g.add(mesh(new THREE.SphereGeometry(0.11, 14, 12), outer, [s * 0.15, 0.38, -0.05], [0, 0, s * -0.2], [1, 4, 0.5]));
        g.add(mesh(new THREE.SphereGeometry(0.07, 12, 10), inner, [s * 0.15, 0.38, 0.0], [0, 0, s * -0.2], [1, 3.6, 0.3]));
      }
      break;
    }
    case 'sombrero': {
      const straw = std(0xd9b46a, { roughness: 0.9 });
      g.add(mesh(new THREE.CylinderGeometry(0.85, 0.85, 0.05, 32), straw, [0, 0.02, 0]));
      g.add(mesh(new THREE.CylinderGeometry(0.22, 0.32, 0.38, 24), straw, [0, 0.22, 0]));
      g.add(mesh(new THREE.CylinderGeometry(0.33, 0.33, 0.08, 24), std(0x1b8a3e), [0, 0.08, 0]));
      break;
    }
    case 'pumpkin': {
      const c = document.createElement('canvas');
      c.width = 256; c.height = 128;
      const x = c.getContext('2d');
      x.fillStyle = '#e8741c'; x.fillRect(0, 0, 256, 128);
      x.strokeStyle = '#b8540e'; x.lineWidth = 4;
      for (let i = 0; i < 256; i += 32) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, 128); x.stroke(); }
      x.fillStyle = '#ffd34d';
      x.beginPath(); x.moveTo(52, 50); x.lineTo(64, 32); x.lineTo(76, 50); x.fill();
      x.beginPath(); x.moveTo(84, 50); x.lineTo(96, 32); x.lineTo(108, 50); x.fill();
      x.beginPath(); x.moveTo(48, 70); x.lineTo(112, 70); x.lineTo(104, 84); x.lineTo(56, 84); x.fill();
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.offset.x = 0.0;
      g.add(mesh(new THREE.SphereGeometry(0.58, 32, 20), new THREE.MeshStandardMaterial({ map: t, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0.15, roughness: 0.6 }), [0, -0.38, 0.05], [0, -Math.PI / 2, 0], [1, 0.9, 1]));
      g.add(mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.2, 8), std(0x4a6b2a), [0, 0.15, 0.05]));
      break;
    }
    case 'helmet': {
      const m = std(0x4b5320, { roughness: 0.8 });
      g.add(mesh(new THREE.SphereGeometry(0.5, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), m, [0, -0.15, 0]));
      g.add(mesh(new THREE.CylinderGeometry(0.56, 0.56, 0.05, 28), m, [0, -0.15, 0]));
      g.add(mesh(new THREE.BoxGeometry(0.16, 0.08, 0.06), std(0x111111), [0, 0.12, 0.45]));
      break;
    }
    case 'viking': {
      const m = new THREE.MeshPhysicalMaterial({ color: 0x8a8f96, metalness: 0.9, roughness: 0.35 });
      g.add(mesh(new THREE.SphereGeometry(0.48, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), m, [0, -0.12, 0]));
      g.add(mesh(new THREE.TorusGeometry(0.48, 0.04, 8, 28), new THREE.MeshPhysicalMaterial({ color: 0x9c6b2f, metalness: 0.8, roughness: 0.4 }), [0, -0.1, 0], [Math.PI / 2, 0, 0]));
      const horn = std(0xf1e6cf, { roughness: 0.5 });
      for (const s of [-1, 1]) g.add(mesh(new THREE.ConeGeometry(0.09, 0.5, 14), horn, [s * 0.55, 0.15, 0], [0, 0, s * -1.0]));
      break;
    }
    case 'crown': {
      const m = gold();
      g.add(mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.2, 24, 1, true), m, [0, 0.02, 0]));
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        g.add(mesh(new THREE.ConeGeometry(0.06, 0.18, 8), m, [Math.cos(a) * 0.3, 0.2, Math.sin(a) * 0.3]));
      }
      const gem = new THREE.MeshPhysicalMaterial({ color: 0xff2244, metalness: 0, roughness: 0, transmission: 0.6, ior: 2.2, thickness: 0.2 });
      g.add(mesh(new THREE.OctahedronGeometry(0.07), gem, [0, 0.03, 0.31]));
      break;
    }
    case 'halo': {
      g.add(mesh(new THREE.TorusGeometry(0.36, 0.045, 12, 40), new THREE.MeshStandardMaterial({ color: 0xffe27a, emissive: 0xffd34d, emissiveIntensity: 1.4, metalness: 0.5, roughness: 0.3 }), [0, 0.38, 0], [Math.PI / 2, 0, 0]));
      break;
    }
  }
  return g;
}

export function buildChicken(item) {
  const b = BREED[item.id];
  const body = bodyMaterial(b, item.sd || 1);
  const crystal = !!b.crystal;
  const seg = crystal ? [8, 6] : [32, 24];
  const sphere = (r) => (crystal ? new THREE.IcosahedronGeometry(r, 1) : new THREE.SphereGeometry(r, ...seg));
  const g = new THREE.Group();
  const beakMat = b.metal || b.lore ? gold() : std(ORANGE, { roughness: 0.5 });
  const combMat = b.id === 'zombie' ? std(0x5a1a1a) : b.ghost ? body : std(RED, { roughness: 0.55 });

  g.add(mesh(sphere(1), body, [0, 1.1, 0], null, [0.85, 0.8, 1.05]));
  g.add(mesh(sphere(0.7), body, [0, 1.05, 0.5]));
  g.add(mesh(sphere(0.46), body, [0, 1.95, 0.6]));
  g.add(mesh(sphere(0.3), body, [0, 1.6, 0.6]));
  g.add(mesh(new THREE.ConeGeometry(0.12, 0.34, 12), beakMat, [0, 1.92, 1.12], [Math.PI / 2, 0, 0]));
  for (let i = 0; i < 3; i++) g.add(mesh(new THREE.SphereGeometry(0.12 - i * 0.015, 14, 12), combMat, [0, 2.4 - i * 0.03, 0.72 - i * 0.17]));
  g.add(mesh(new THREE.SphereGeometry(0.09, 12, 10), combMat, [0, 1.72, 1.0], null, [1, 1.7, 1]));
  const eye = std(0x0a0a0a, { roughness: 0.2 });
  const glint = new THREE.MeshBasicMaterial({ color: b.id === 'zombie' ? 0xff3030 : 0xffffff });
  for (const s of [-1, 1]) {
    g.add(mesh(new THREE.SphereGeometry(0.065, 12, 10), eye, [s * 0.3, 2.02, 0.92]));
    g.add(mesh(new THREE.SphereGeometry(0.02, 8, 6), glint, [s * 0.32, 2.05, 0.98]));
    g.add(mesh(sphere(0.5), body, [s * 0.78, 1.15, -0.05], [0.25, 0, s * 0.18], [0.3, 0.7, 1.1]));
    const leg = std(ORANGE, { roughness: 0.5 });
    g.add(mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.55, 8), leg, [s * 0.32, 0.28, 0.1]));
    for (const a of [-0.45, 0, 0.45]) g.add(mesh(new THREE.BoxGeometry(0.06, 0.04, 0.3), leg, [s * 0.32 + Math.sin(a) * 0.12, 0.02, 0.22 + Math.cos(a) * 0.08], [0, a, 0]));
  }
  for (let i = 0; i < 4; i++) {
    g.add(mesh(sphere(0.35), body, [(i - 1.5) * 0.14, 1.65 + Math.abs(i - 1.5) * -0.08, -1.0], [-0.9 + (i - 1.5) * 0.05, 0, (i - 1.5) * 0.25], [0.35, 1.2, 0.5]));
  }
  if (item.hat && item.hat !== 'none') {
    const hat = buildHat(item.hat);
    hat.position.set(0, 2.35, 0.6);
    g.add(hat);
  }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });
  return g;
}

// ---- thumbnails for cards ------------------------------------------------------------------
let thumbR, thumbScene, thumbCam;
const thumbs = new Map();
export function chickenThumbKey(item) { return item.id + '|' + item.hat; }
export function getChickenThumb(item) { return thumbs.get(chickenThumbKey(item)); }

export function renderChickenThumb(item) {
  const key = chickenThumbKey(item);
  if (thumbs.has(key)) return thumbs.get(key);
  if (!thumbR) {
    thumbR = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    thumbR.setSize(320, 240, false);
    thumbR.toneMapping = THREE.ACESFilmicToneMapping;
    thumbR.outputColorSpace = THREE.SRGBColorSpace;
    thumbScene = new THREE.Scene();
    thumbScene.environment = new THREE.PMREMGenerator(thumbR).fromScene(new RoomEnvironment(), 0.04).texture;
    const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(3, 5, 6);
    thumbScene.add(key, new THREE.AmbientLight(0xffffff, 0.3));
    thumbCam = new THREE.PerspectiveCamera(30, 320 / 240, 0.1, 100);
    thumbCam.position.set(4.6, 3.2, 7.5);
    thumbCam.lookAt(0, 1.3, 0);
  }
  const model = buildChicken(item);
  model.rotation.y = 0.5;
  thumbScene.add(model);
  thumbR.render(thumbScene, thumbCam);
  const url = thumbR.domElement.toDataURL('image/png');
  thumbScene.remove(model);
  model.traverse((o) => { o.geometry?.dispose(); for (const m of [].concat(o.material || [])) { m.map?.dispose(); m.dispose(); } });
  thumbs.set(key, url);
  return url;
}
