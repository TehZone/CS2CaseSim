// Charms in 3D: CS2's charm model hung from a gun's "keychain" attachment (it rides along in first person and Play),
// swinging as the gun moves and turned about its chain by its pattern; and a charm on its own (a charm item's inspect).
// A charm model is a short chain of three joints from the clasp (at its origin) with the charm on the end, hanging
// along its -Y (CS2's -Z). A Sticker Slab is the clear case model with its sticker printed on the card inside.
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { cs2Charm, cs2CharmAttach } from './api.js';
import { loadGltf } from './rig.js';
import { UniformRandomStream } from './rng.js';
import { D } from '../engine/data.js';
import { itemDef } from '../engine/items.js';
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

// The Sticker Slab's case: the card inside its window is the top left of the case's colour map.
const SLAB_CARD = { x: 12 / 1024, y: 123 / 1024, w: 486 / 1024, h: 487 / 1024 };

// The way a pattern hangs: its turn about the chain, from the pattern number (Valve's RNG, like skin seeds). A charm's
// face is its +X, which the keychain attachment points away from the gun's side; patterns turn it up to 60° either way
// (further and it would face into the gun).
export const patternTurn = (pat) => new UniformRandomStream(pat || 0).randomFloat(-Math.PI / 3, Math.PI / 3);

// A fresh copy of a charm item's model: { root, joint (the top joint, which swings), length (m, clasp to the charm's middle) }.
async function charmModel(charm) {
  const def = itemDef(charm);
  if (!def?.mdl) throw new Error('No model for this charm');
  const gltf = await loadGltf((await cs2Charm(def.mdl)).model);
  const root = cloneSkinned(gltf.scene);
  let joint = null;
  root.traverse((o) => {
    if (o.isBone && !joint) joint = o;
    if (o.isMesh) { o.frustumCulled = false; for (const m of [].concat(o.material || [])) m.envMapIntensity = 1.1; }
  });
  if (!joint) throw new Error('Charm model has no chain');
  if (def.slab) await sealSticker(root, def);
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  return { root, joint, box, length: Math.max(0.008, -box.getCenter(new THREE.Vector3()).y) };
}

// Prints a slab's sticker on the card inside its case (its own copy of the case's material, a glossy clear coat on top).
async function sealSticker(root, def) {
  let body = null;
  root.traverse((o) => { if (o.isMesh && o.material?.name === 'kc_sticker_display_case') body = o; });
  const base = body?.material.map?.image;
  if (!base) return;
  const sticker = await loadImage(imgUrl(D.stickers[def.sk]?.img, 'l'));
  const art = artBox(sticker); // Steam's sticker icons are mostly margin
  const c = document.createElement('canvas');
  c.width = base.width; c.height = base.height;
  const g = c.getContext('2d');
  g.drawImage(base, 0, 0);
  const W = SLAB_CARD.w * c.width, H = SLAB_CARD.h * c.height;
  const k = Math.min(W / art.w, H / art.h) * 0.86;
  const w = art.w * k, h = art.h * k;
  g.drawImage(sticker, art.x, art.y, art.w, art.h, SLAB_CARD.x * c.width + (W - w) / 2, SLAB_CARD.y * c.height + (H - h) / 2, w, h);
  const old = body.material, map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.flipY = old.map.flipY;
  map.anisotropy = 8;
  body.material = new THREE.MeshPhysicalMaterial({
    name: old.name, map, normalMap: old.normalMap, aoMap: old.aoMap, roughnessMap: old.roughnessMap, metalnessMap: old.metalnessMap,
    roughness: old.roughness, metalness: old.metalness, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.1,
  });
  body.material.userData.dispose = () => map.dispose();
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

// The holder a charm hangs in. turn: its pattern's turn about the chain (a gun's charm), or 0 (facing you, on its own).
function holderFor(m, turn) {
  const holder = new THREE.Group();
  holder.name = 'charm';
  holder.userData.charm = { length: m.length, turn, rest: m.joint.quaternion.toArray() };
  holder.add(m.root);
  swingCharm(holder);
  return holder;
}

// Hangs a holder's charm under gravity (world -Y) as a damped pendulum from its clasp, so it swings when the gun moves.
// It runs as the holder's world matrix is worked out each frame. First person calls this again on its copy of the gun.
export function swingCharm(holder) {
  const { turn, rest } = holder.userData.charm;
  const length = Math.max(SWING_LENGTH, holder.userData.charm.length);
  let joint = null;
  holder.traverse((o) => { if (o.isBone && !joint) joint = o; });
  if (!joint) return;
  const restQ = new THREE.Quaternion().fromArray(rest);
  const twist = new THREE.Quaternion().setFromAxisAngle(UP, turn);
  const anchor = new THREE.Vector3(), bob = new THREE.Vector3(), prev = new THREE.Vector3(), v = new THREE.Vector3();
  const q = new THREE.Quaternion(), s = new THREE.Vector3(), swing = new THREE.Quaternion();
  const update = Object.getPrototypeOf(holder).updateMatrixWorld;
  let last = 0;
  holder.updateMatrixWorld = function (force) {
    if (this.matrixAutoUpdate) this.updateMatrix();
    if (this.parent) this.matrixWorld.multiplyMatrices(this.parent.matrixWorld, this.matrix);
    else this.matrixWorld.copy(this.matrix);
    this.matrixWorld.decompose(anchor, q, s);
    const L = length * s.x;
    const now = performance.now() / 1000, dt = now - last;
    if (!last || dt > 0.25) { bob.copy(anchor).addScaledVector(DOWN, L); prev.copy(bob); last = now; }
    else if (dt > 0.001) {
      // Verlet: the bob keeps its (damped) velocity and falls, then the chain holds it at its length from the clasp.
      const h = Math.min(dt, 1 / 30);
      v.subVectors(bob, prev).multiplyScalar(Math.exp(-DAMPING * h));
      prev.copy(bob);
      bob.add(v).addScaledVector(DOWN, GRAVITY * s.x * h * h);
      v.subVectors(bob, anchor);
      bob.copy(anchor).addScaledVector(v.lengthSq() > 1e-12 ? v.normalize() : DOWN, L);
      last = now;
    }
    // The chain's direction in the holder's frame, turned to from hanging straight down.
    v.subVectors(bob, anchor).normalize().applyQuaternion(q.invert());
    swing.setFromUnitVectors(DOWN, v);
    joint.quaternion.copy(swing).multiply(twist).multiply(restQ);
    update.call(this, true);
  };
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
  const holder = holderFor(m, patternTurn(charm.pat));
  holder.position.set(a.offset[0] * INCH, a.offset[1] * INCH, a.offset[2] * INCH);
  holder.quaternion.set(...a.rotation).multiply(GLTF_TO_BONE);
  bone.add(holder);
  return holder;
}

// A charm on its own (its inspect): hanging from its clasp, facing you, swinging as you turn it. About 3 units tall.
export async function buildCharmModel(charm) {
  const m = await charmModel(charm);
  const size = m.box.getSize(new THREE.Vector3()), center = m.box.getCenter(new THREE.Vector3());
  const k = 3 / (Math.max(size.x, size.y, size.z) || 1);
  const holder = holderFor(m, 0);
  // Its thin side away from you, so you see its face (as a gun's side faces you in the inspect).
  if (size.x <= size.z) holder.rotation.y = -Math.PI / 2;
  const inner = new THREE.Group();
  inner.scale.setScalar(k);
  inner.position.set(0, -center.y * k, 0);
  inner.add(holder);
  const wrap = new THREE.Group();
  wrap.add(inner);
  wrap.userData.bounds = new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(Math.max(size.x, size.z), size.y, Math.max(size.x, size.z)).multiplyScalar(k));
  return wrap;
}
