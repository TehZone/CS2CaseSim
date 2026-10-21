// 3D inspect: turns an item's (composited) icon into a solid extruded model and lets you rotate it like CS2's inspect.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { composeItem, bleedEdges, normalMapFrom, wearAmount } from './composite.js';
import { itemDef } from './items.js';
import { buildChicken } from './chicken3d.js';
import { cs2Status } from './cs2/api.js';
import { buildCS2Model } from './cs2/skin.js';
import { stickerSurface } from './cs2/sticker.js';
import { clamp } from './util.js';

// ---------------------------------------------------------------------------------------------
// Silhouette extraction (marching squares) -> THREE.Shapes with holes
// ---------------------------------------------------------------------------------------------
function alphaMask(src, maxW = 512) {
  const w = Math.min(maxW, src.width), h = Math.round((src.height * w) / src.width);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const a = new Uint8Array(w * h);
  for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
  return { a, w, h };
}

function traceContours(a, w, h, thr = 110) {
  const gw = w + 2, gh = h + 2;
  const v = new Uint8Array(gw * gh); // padded so every contour closes
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) v[(y + 1) * gw + x + 1] = a[y * w + x];
  const VOFF = gw * gh;
  const N = VOFF * 2;
  const l0 = new Int32Array(N).fill(-1), l1 = new Int32Array(N).fill(-1);
  const link = (p, q) => {
    if (l0[p] < 0) l0[p] = q; else l1[p] = q;
    if (l0[q] < 0) l0[q] = p; else l1[q] = p;
  };
  for (let y = 0; y < gh - 1; y++) {
    for (let x = 0; x < gw - 1; x++) {
      const vtl = v[y * gw + x], vtr = v[y * gw + x + 1], vbr = v[(y + 1) * gw + x + 1], vbl = v[(y + 1) * gw + x];
      const code = (vtl >= thr ? 8 : 0) | (vtr >= thr ? 4 : 0) | (vbr >= thr ? 2 : 0) | (vbl >= thr ? 1 : 0);
      if (code === 0 || code === 15) continue;
      const T = y * gw + x, B = (y + 1) * gw + x, L = VOFF + y * gw + x, R = VOFF + y * gw + x + 1;
      const center = (vtl + vtr + vbr + vbl) / 4 >= thr;
      switch (code) {
        case 1: case 14: link(L, B); break;
        case 2: case 13: link(B, R); break;
        case 3: case 12: link(L, R); break;
        case 4: case 11: link(T, R); break;
        case 6: case 9: link(T, B); break;
        case 7: case 8: link(L, T); break;
        case 5: if (center) { link(L, T); link(B, R); } else { link(T, R); link(L, B); } break;
        case 10: if (center) { link(T, R); link(L, B); } else { link(L, T); link(B, R); } break;
      }
    }
  }
  const point = (id) => {
    if (id < VOFF) { // horizontal edge (x,y)-(x+1,y)
      const x = id % gw, y = (id / gw) | 0;
      const va = v[id], vb = v[id + 1];
      const t = va === vb ? 0.5 : (thr - va) / (vb - va);
      return [x + t - 0.5, y - 0.5]; // padded grid -> pixel-centre coordinates
    }
    const j = id - VOFF; // vertical edge (x,y)-(x,y+1)
    const x = j % gw, y = (j / gw) | 0;
    const va = v[j], vb = v[j + gw];
    const t = va === vb ? 0.5 : (thr - va) / (vb - va);
    return [x - 0.5, y + t - 0.5];
  };
  const seen = new Uint8Array(N);
  const loops = [];
  for (let s = 0; s < N; s++) {
    if (l0[s] < 0 || seen[s]) continue;
    const loop = [];
    let prev = -1, cur = s;
    while (cur >= 0 && !seen[cur]) {
      seen[cur] = 1;
      loop.push(point(cur));
      const nx = l0[cur] !== prev ? l0[cur] : l1[cur];
      prev = cur;
      cur = nx;
    }
    if (loop.length >= 6) loops.push(loop);
  }
  return loops;
}

function rdp(pts, eps) {
  if (pts.length < 3) return pts;
  const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1];
  const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
  let max = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / len;
    if (d > max) { max = d; idx = i; }
  }
  if (max <= eps) return [pts[0], pts[pts.length - 1]];
  const left = rdp(pts.slice(0, idx + 1), eps), right = rdp(pts.slice(idx), eps);
  return left.slice(0, -1).concat(right);
}
function simplifyClosed(loop, eps) {
  // split at the point farthest from the start so both halves are open polylines
  let far = 0, fd = 0;
  for (let i = 1; i < loop.length; i++) {
    const d = (loop[i][0] - loop[0][0]) ** 2 + (loop[i][1] - loop[0][1]) ** 2;
    if (d > fd) { fd = d; far = i; }
  }
  const a = rdp(loop.slice(0, far + 1), eps), b = rdp(loop.slice(far).concat([loop[0]]), eps);
  return a.slice(0, -1).concat(b.slice(0, -1));
}
const area = (p) => { let s = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) s += (p[j][0] + p[i][0]) * (p[j][1] - p[i][1]); return s / 2; };
function inside(pt, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function shapesFromMask({ a, w, h }, worldW) {
  const s = worldW / w;
  const minArea = w * h * 0.0004;
  const loops = traceContours(a, w, h)
    .map((l) => simplifyClosed(l, 0.6))
    .filter((l) => l.length >= 3)
    .map((pts) => ({ pts, area: Math.abs(area(pts)) }))
    .filter((l) => l.area > minArea);
  for (const l of loops) l.depth = loops.filter((o) => o !== l && o.area > l.area && inside(l.pts[0], o.pts)).length;
  const toV = ([x, y]) => new THREE.Vector2((x - w / 2) * s, (h / 2 - y) * s);
  const outers = loops.filter((l) => l.depth % 2 === 0).map((l) => ({ l, shape: new THREE.Shape(l.pts.map(toV)) }));
  for (const hole of loops.filter((l) => l.depth % 2 === 1)) {
    const parent = outers
      .filter((o) => o.l.depth === hole.depth - 1 && o.l.area > hole.area && inside(hole.pts[0], o.l.pts))
      .sort((x, y) => x.l.area - y.l.area)[0];
    if (parent) parent.shape.holes.push(new THREE.Path(hole.pts.map(toV)));
  }
  return { shapes: outers.map((o) => o.shape), s, w, h };
}

// Extruded solid of an image silhouette with UVs mapping the image onto front and back.
export function extrudeImage(src, { width = 4, depth = 0.1, bevel = 0.012, segments = 2 } = {}) {
  const mask = alphaMask(src);
  const { shapes, s, w, h } = shapesFromMask(mask, width);
  const geo = new THREE.ExtrudeGeometry(shapes, {
    depth, steps: 1, curveSegments: 1,
    bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel * 0.28, bevelSegments: segments,
  });
  geo.translate(0, 0, -depth / 2);
  const pos = geo.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = pos.getX(i) / (s * w) + 0.5;
    uv[i * 2 + 1] = pos.getY(i) / (s * h) + 0.5;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.computeBoundingBox();
  return geo;
}

// ExtrudeGeometry puts both caps in material group 0: regroup into front (0), back (1) and sides (2).
function splitCaps(geo) {
  const tris = [[], [], []];
  const nrm = geo.attributes.normal;
  for (const g of geo.groups) {
    for (let i = g.start; i < g.start + g.count; i += 3) tris[g.materialIndex === 0 ? (nrm.getZ(i) >= 0 ? 0 : 1) : 2].push(i);
  }
  const order = tris.flat();
  for (const attr of Object.values(geo.attributes)) {
    const n = attr.itemSize, src = attr.array.slice();
    order.forEach((v, k) => attr.array.set(src.subarray(v * n, (v + 3) * n), k * 3 * n));
    attr.needsUpdate = true;
  }
  geo.clearGroups();
  let start = 0;
  tris.forEach((t, m) => { geo.addGroup(start, t.length * 3, m); start += t.length * 3; });
  return geo;
}

// A sticker item with CS2's own sticker material: a thin die-cut sticker on CS2's backing paper. The outline is the
// sticker texture's alpha where the shader's cut-out (alpha * 12.75) passes one half.
async function buildCS2Sticker(def) {
  const surf = await stickerSurface(def, { backing: true });
  const img = surf.image;
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, c.width, c.height);
  for (let i = 3; i < id.data.length; i += 4) id.data[i] = id.data[i] >= 10 ? 255 : 0;
  ctx.putImageData(id, 0, 0);
  const geo = splitCaps(extrudeImage(c, { width: 2.8, depth: 0.035, bevel: 0.008 }));
  const g = new THREE.Group();
  g.add(new THREE.Mesh(geo, [surf.material, surf.backing, surf.backing]));
  return g;
}

// ---------------------------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------------------------
function skinMaterialParams(def, item) {
  const st = def.st || '';
  const wear = item.fl != null ? wearAmount(item.fl) : 0;
  if (def.cat === 'gloves') return { metalness: 0, roughness: 0.82, sheen: 0.7, sheenRoughness: 0.5, sheenColor: new THREE.Color(0x888888), normalScale: 1.2 };
  if (st === 'Vanilla') return { metalness: 0.9, roughness: 0.26, clearcoat: 0.3, normalScale: 0.4 };
  if (/Anodized/.test(st)) return { metalness: 0.72, roughness: 0.18 + wear * 0.2, clearcoat: 0.9, clearcoatRoughness: 0.08, normalScale: 0.35 };
  if (st === 'Case Hardening' || st === 'Patina') return { metalness: 0.65, roughness: 0.3 + wear * 0.2, clearcoat: 0.35, normalScale: 0.5 };
  return { metalness: 0.28, roughness: 0.46 + wear * 0.25, clearcoat: 0.35 * (1 - wear), clearcoatRoughness: 0.35, normalScale: 0.55 };
}
function stickerMaterialParams(def) {
  switch (def.fx) {
    case 'Holo': case 'Lenticular':
      return { metalness: 0.55, roughness: 0.14, iridescence: 1, iridescenceIOR: 1.7, iridescenceThicknessRange: [180, 820], clearcoat: 1 };
    case 'Foil': return { metalness: 0.88, roughness: 0.2, clearcoat: 0.8 };
    case 'Gold': return { metalness: 1, roughness: 0.16, clearcoat: 0.6 };
    case 'Glitter': return { metalness: 0.7, roughness: 0.3, iridescence: 0.5, clearcoat: 1, normalScale: 1.4 };
    case 'Embroidered': return { metalness: 0, roughness: 0.92, sheen: 1, sheenRoughness: 0.4, sheenColor: new THREE.Color(0xffffff), normalScale: 1.6 };
    default: return { metalness: 0.05, roughness: 0.42, clearcoat: 0.8, clearcoatRoughness: 0.2 };
  }
}

function canvasTexture(c, renderer, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}

// Dim studio with a top softbox and strip lights, close to CS2's inspect/icon lighting (metal needs contrast).
function studioScene() {
  const scene = new THREE.Scene();
  const room = new THREE.Mesh(new THREE.BoxGeometry(24, 14, 24), new THREE.MeshBasicMaterial({ color: 0x23272e, side: THREE.BackSide }));
  scene.add(room);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(24, 24), new THREE.MeshBasicMaterial({ color: 0x0b0c0f }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -6.9;
  scene.add(floor);
  const panel = (w, h, k, pos) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(k, k, k * 1.02), side: THREE.DoubleSide }));
    m.position.set(...pos);
    m.lookAt(0, 0, 0);
    scene.add(m);
  };
  panel(10, 3.5, 7, [0, 6.5, 2]);
  panel(2.2, 9, 3.5, [-10, 1.5, 4]);
  panel(2.2, 9, 2.5, [10, 1, -3]);
  panel(14, 5, 1.6, [-2, 1.5, 11.5]); // soft panel behind the camera: polished steel facing us reads bright
  panel(4, 4, 0.9, [3, 2, -11]);
  return scene;
}

function shadowBlob() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  grad.addColorStop(0, 'rgba(0,0,0,0.55)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  return m;
}

// ---------------------------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------------------------
const easeOutBack = (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

class InspectView {
  init() {
    if (this.renderer) return;
    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }));
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.08;
    r.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(r);
    this.envRoom = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.envStudio = pmrem.fromScene(studioScene(), 0.02).texture;
    this.scene.environment = this.envRoom;
    this.scene.environmentIntensity = 0.95;
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.05, 200);
    const key = new THREE.DirectionalLight(0xffffff, 1.7); key.position.set(3, 4, 6);
    const fill = new THREE.DirectionalLight(0xa9c4ff, 0.55); fill.position.set(-5, 1, 3);
    const rim = new THREE.DirectionalLight(0xffe0bd, 1.1); rim.position.set(0, 3, -6);
    this.scene.add(key, fill, rim, new THREE.AmbientLight(0xffffff, 0.15));
    this.pivot = new THREE.Group();
    this.scene.add(this.pivot);
    this.shadow = shadowBlob();
    this.scene.add(this.shadow);
    this.state = { yaw: 0, pitch: 0, vy: 0, vp: 0, zoom: 1, dragging: false, lastInput: 0, anim: null, swayT: 0 };
    this.clock = new THREE.Timer();
    this.bindInput(r.domElement);
    this.resizeObs = new ResizeObserver(() => this.resize());
  }

  bindInput(el) {
    el.style.touchAction = 'none';
    let lx = 0, ly = 0;
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      this.state.dragging = true; this.state.anim = null;
      lx = e.clientX; ly = e.clientY;
      el.style.cursor = 'grabbing';
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.state.dragging) return;
      const dx = e.clientX - lx, dy = e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      this.state.vy = dx * 0.0085; this.state.vp = dy * 0.0065;
      this.state.yaw += this.state.vy; this.state.pitch = clamp(this.state.pitch + this.state.vp, -1.35, 1.35);
      this.state.lastInput = performance.now();
    });
    const up = () => { this.state.dragging = false; el.style.cursor = 'grab'; this.state.lastInput = performance.now(); };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.state.zoom = clamp(this.state.zoom * (1 - e.deltaY * 0.0012), 0.55, 3);
    }, { passive: false });
    el.addEventListener('dblclick', () => this.reset());
    el.style.cursor = 'grab';
  }

  mount(container) {
    this.init();
    this.container = container;
    container.appendChild(this.renderer.domElement);
    this.resizeObs.observe(container);
    this.resize();
    this.running = true;
    this.clock.update();
    const loop = () => {
      if (!this.running) return;
      this.frame();
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  unmount() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    if (this.container) this.resizeObs.unobserve(this.container);
    this.renderer?.domElement.remove();
    this.clearModel();
  }

  resize() {
    if (!this.container) return;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  clearModel() {
    if (!this.model) return;
    this.pivot.remove(this.model);
    this.model.traverse((o) => {
      o.geometry?.dispose();
      for (const m of [].concat(o.material || [])) {
        for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) m[k]?.dispose();
        m.userData.dispose?.();
        m.dispose();
      }
    });
    this.model = null;
  }

  async show(item) {
    this.init();
    const token = (this.token = {});
    const model = await this.buildModel(item);
    if (token !== this.token) return; // a newer show() won the race
    this.clearModel();
    // Measure visible geometry in the model's own frame (before it inherits the pivot's rotation).
    model.updateMatrixWorld(true);
    const box = new THREE.Box3();
    model.traverse((o) => {
      let shown = o.visible;
      for (let n = o.parent; n && shown; n = n.parent) shown = n.visible;
      if (o.isMesh && shown) box.expandByObject(o, !!model.userData.cs2);
    });
    const size = box.getSize(new THREE.Vector3());
    this.model = model;
    this.pivot.add(model);
    this.scene.environment = this.source === 'cs2' ? this.envStudio : this.envRoom;
    this.scene.environmentIntensity = this.source === 'cs2' ? 1.0 : 0.95;
    this.size = size;
    this.shadow.scale.set(size.x * 1.1, Math.max(size.z, size.x * 0.35), 1);
    this.shadow.position.y = -size.y / 2 - 0.35;
    this.reset(true);
  }

  async buildModel(item) {
    const def = itemDef(item);
    if (item.t === 'chicken') {
      const g = buildChicken(item);
      g.position.y = -1.2;
      const wrap = new THREE.Group();
      wrap.add(g);
      return wrap;
    }
    // Real CS2 model + CS2's own skin shader when the game is installed (guns and knives).
    if (item.t === 'skin' && def.cat !== 'gloves') {
      try {
        if ((await cs2Status()).available) {
          const real = await buildCS2Model(item, def, this.renderer);
          if (real) { this.source = 'cs2'; return real; }
        }
      } catch (e) {
        console.warn('CS2 model unavailable, using the icon model instead:', e);
      }
    }
    // Stickers with CS2's own sticker material (holo, foil, gold, glitter, lenticular, embroidered effects).
    if (item.t === 'sticker' && def.sm) {
      try {
        if ((await cs2Status()).available) {
          const real = await buildCS2Sticker(def);
          this.source = 'cs2';
          return real;
        }
      } catch (e) {
        console.warn('CS2 sticker material unavailable, using the icon model instead:', e);
      }
    }
    this.source = 'icon';
    const composed = await composeItem(item, { size: 'l' });
    const r = this.renderer;
    let width = 4, depth = 0.09, bevel = 0.012, segments = 2, params;
    if (item.t === 'skin') {
      params = skinMaterialParams(def, item);
      if (def.cat === 'gloves') { depth = 0.12; bevel = 0.07; segments = 4; width = 3.6; }
      else if (def.cat === 'knife') { depth = 0.07; }
      else if (def.cat === 'pistol') { depth = 0.12; width = 3.4; }
    } else if (item.t === 'sticker') {
      params = stickerMaterialParams(def); width = 2.8; depth = 0.035; bevel = 0.008;
    } else {
      params = { metalness: 0, roughness: 0.7, clearcoat: 0.1, normalScale: 0.6 }; width = 3.4; depth = 0.12; bevel = 0.02;
    }
    const geo = extrudeImage(composed, { width, depth, bevel, segments });
    const bled = bleedEdges(composed);
    const map = canvasTexture(bled, r);
    // Side walls sample a blurred copy so edge colours read as a smooth rim, not streaks.
    const blurred = document.createElement('canvas');
    blurred.width = bled.width >> 2; blurred.height = bled.height >> 2;
    const bctx = blurred.getContext('2d');
    bctx.filter = 'blur(3px)';
    bctx.drawImage(bled, 0, 0, blurred.width, blurred.height);
    const sideMap = canvasTexture(blurred, r);
    const normal = canvasTexture(normalMapFrom(composed), r, false);
    const ns = params.normalScale ?? 0.5;
    delete params.normalScale;
    const front = new THREE.MeshPhysicalMaterial({ map, normalMap: normal, normalScale: new THREE.Vector2(ns, ns), ...params });
    const side = new THREE.MeshPhysicalMaterial({ map: sideMap, color: 0x9a9a9a, metalness: Math.min(0.9, (params.metalness || 0) + 0.1), roughness: 0.5 });
    const mesh = new THREE.Mesh(geo, [front, side]);
    const g = new THREE.Group();
    g.add(mesh);
    return g;
  }

  reset(intro = false) {
    const s = this.state;
    s.zoom = 1; s.vy = 0; s.vp = 0;
    if (intro) {
      // CS2-style draw: swings in from a three-quarter back view and settles
      s.anim = { t: 0, dur: 1.25, from: { yaw: -2.6, pitch: 0.45, z: 0.6 }, to: { yaw: 0.22, pitch: 0.12, z: 0 }, ease: easeOutBack };
    } else {
      s.anim = { t: 0, dur: 0.6, from: { yaw: s.yaw, pitch: s.pitch, z: 0 }, to: { yaw: Math.round(s.yaw / (Math.PI * 2)) * Math.PI * 2 + 0.22, pitch: 0.12, z: 0 }, ease: easeInOut };
    }
  }

  flip() {
    const s = this.state;
    s.anim = { t: 0, dur: 0.8, from: { yaw: s.yaw, pitch: s.pitch, z: 0 }, to: { yaw: s.yaw + Math.PI, pitch: s.pitch, z: 0 }, ease: easeInOut };
  }

  // The "F" inspect: roll the weapon over to show both sides, then return.
  playInspect() {
    const s = this.state;
    const y0 = s.yaw, p0 = s.pitch;
    s.anim = {
      t: 0, dur: 3.2, custom: (t) => {
        const k = easeInOut(t);
        s.yaw = y0 + Math.sin(k * Math.PI) * 0.9 + k * Math.PI * 2;
        s.pitch = p0 + Math.sin(k * Math.PI * 2) * 0.55;
        this.pivot.rotation.z = Math.sin(k * Math.PI * 2) * 0.25;
      },
    };
  }

  frame() {
    this.clock.update();
    const dt = Math.min(0.05, this.clock.getDelta());
    const s = this.state;
    let zOff = 0;
    if (s.anim) {
      s.anim.t += dt / s.anim.dur;
      const t = Math.min(1, s.anim.t);
      if (s.anim.custom) s.anim.custom(t);
      else {
        const k = s.anim.ease(t);
        s.yaw = s.anim.from.yaw + (s.anim.to.yaw - s.anim.from.yaw) * k;
        s.pitch = s.anim.from.pitch + (s.anim.to.pitch - s.anim.from.pitch) * k;
        zOff = s.anim.from.z + (s.anim.to.z - s.anim.from.z) * Math.min(1, t * 1.4);
      }
      if (t >= 1) { s.anim = null; this.pivot.rotation.z = 0; s.lastInput = performance.now(); }
    } else if (!s.dragging) {
      s.yaw += s.vy; s.pitch = clamp(s.pitch + s.vp, -1.35, 1.35);
      s.vy *= 0.93; s.vp *= 0.9;
      // gentle idle sway after a few seconds without input
      if (performance.now() - s.lastInput > 2500) {
        s.swayT += dt;
        s.yaw += Math.sin(s.swayT * 0.7) * 0.0016;
        s.pitch += (0.12 - s.pitch) * 0.01;
      }
    }
    this.pivot.rotation.y = s.yaw;
    this.pivot.rotation.x = s.pitch;
    if (this.size) {
      const fov = (this.camera.fov * Math.PI) / 180;
      const fitH = this.size.y / 2 / Math.tan(fov / 2);
      const fitW = this.size.x / 2 / Math.tan(fov / 2) / this.camera.aspect;
      const dist = (Math.max(fitH, fitW) * 1.55) / s.zoom;
      const lift = this.size.y * 0.12; // keep the model above the HUD text
      this.camera.position.set(0, -lift, dist * (1 + zOff));
      this.camera.lookAt(0, -lift, 0);
    }
    this.renderer.render(this.scene, this.camera);
  }
}

export const inspectView = new InspectView();
