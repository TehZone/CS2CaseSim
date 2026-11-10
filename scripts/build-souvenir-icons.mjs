// Where a souvenir's stickers land on its Steam icon. In 3D a sticker follows CS2's own numbers (cs2/markup.js), but an icon
// is a picture: to find a sticker on one, the camera it was taken with has to be known. The icons are CS2's renders of
// the real models, every skin of a gun from one camera (one for each of its bodies), and CS2's files don't have that
// camera: a model's camera_inventory attachment doesn't reproduce the icons, and items_game's inventory_image_data gives
// no distance, and no angles for some guns. So it's found here from the icon: a pinhole camera is moved until the model's
// outline lies on the icon's, which it does to about a pixel. Nearly every gun's comes out with the same lens and roll,
// which says that's the rig they were made with. Then each slot's sticker goes through it, over the gun's real surface,
// seen or hidden as that camera sees it.
// Writes src/js/cs2/souvenir-icons.js:
//   { [weapon id]: [{ box, slots: { [slot name]: [x, y, ax, ay, bx, by] } }, one per body] }
// All of it is in widths of the icon. box is the outline's bounds (x0, x1, y0, y1), which a drawn icon's own is matched to:
// it says which body that is, and where the icon is in it. A slot is the middle of the sticker and its two sides as
// vectors: one the icon can't show (the back of the M249's ammo box) isn't there. Needs a CS2 install. Ten minutes or so.
//   node scripts/build-souvenir-icons.mjs [weapon ids: just these, the rest of the file stays]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const require = createRequire(import.meta.url);
const { CS2Service } = require('../cs2/service.cjs');
const { decodePNG } = require('../cs2/png.cjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src', 'js', 'cs2', 'souvenir-icons.js');
const SLOTS = ['Map', 'Team1', 'Team2', 'Autograph'];

const W = 512, H = 384; // an icon, as this works with it
// The lenses the icons turn out to have, as horizontal fields of view in degrees: 25.3 nearly always, wider for the
// MP9, the Tec-9 and the Five-SeveN. A search starts from each, as on a long thin gun it can otherwise trade lens for pose.
const LENSES = [25.3, 34, 60];
const YAWS = [34, 42, 50, 58, 64]; // how far round from the gun's side towards its muzzle a camera might be
// Rounds that hang off a model at rest but aren't on its icon: bones of the shells it reloads and of the M249's belt.
const LOOSE = /^(shell\d*|bullet\d+|bullet_scaffold\d+)$/;
// Models of two guns, side by side at rest, posed by hand on their icon. Gun 0 shows its left, gun 1 its right, muzzle up.
const PAIRS = new Set(['weapon_elite']);

const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
const cross = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
const sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
const unit = (p) => { const l = Math.hypot(...p) || 1; return p.map((v) => v / l); };
const deg = (d) => (d * Math.PI) / 180;

// A body's primitives from a model's glTF: positions, the two UV sets (rounds have no sticker space), triangles, its
// material's name.
function readBody(file, body) {
  const g = JSON.parse(fs.readFileSync(file, 'utf8')), bin = fs.readFileSync(path.join(path.dirname(file), g.buffers[0].uri));
  const read = (i) => {
    const a = g.accessors[i], v = g.bufferViews[a.bufferView], n = a.count * { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
    const Type = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array }[a.componentType];
    const at = (v.byteOffset || 0) + (a.byteOffset || 0);
    return new Type(bin.buffer.slice(bin.byteOffset + at, bin.byteOffset + at + n * Type.BYTES_PER_ELEMENT));
  };
  const joints = (g.skins?.[0]?.joints || []).map((j) => g.nodes[j].name);
  return g.meshes.filter((m) => m.name.endsWith('.' + body)).flatMap((m) => m.primitives.map((p) => {
    const J = p.attributes.JOINTS_0 != null ? read(p.attributes.JOINTS_0) : null, Wt = J && read(p.attributes.WEIGHTS_0);
    const loose = (v) => J && [0, 1, 2, 3].some((k) => Wt[v * 4 + k] > 0.5 && LOOSE.test(joints[J[v * 4 + k]] || ''));
    const T = read(p.indices), keep = [];
    for (let t = 0; t < T.length; t += 3) if (![T[t], T[t + 1], T[t + 2]].some(loose)) keep.push(T[t], T[t + 1], T[t + 2]);
    return { name: g.materials[p.material].name, P: read(p.attributes.POSITION), U: read(p.attributes.TEXCOORD_0), S: p.attributes.TEXCOORD_1 != null ? read(p.attributes.TEXCOORD_1) : null, T: keep };
  }));
}
// What a gun's outline is made of: everything but its sticker gaps (which only ever show a sticker).
const solid = (prims, keep = () => true) => {
  const out = [];
  for (const p of prims) {
    if (/sticker_gaps/.test(p.name)) continue;
    const T = [];
    for (let t = 0; t < p.T.length; t += 3) if (keep(p.P[p.T[t] * 3])) T.push(p.T[t], p.T[t + 1], p.T[t + 2]);
    out.push({ P: p.P, T });
  }
  return out;
};
function middle(mesh) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const { P, T } of mesh) for (const v of T) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], P[v * 3 + k]); hi[k] = Math.max(hi[k], P[v * 3 + k]); }
  return { at: lo.map((v, k) => (v + hi[k]) / 2), length: Math.max(0.05, hi[2] - lo[2]) };
}

// A camera from p: [yaw, pitch, roll, 1 / distance, x, y, scale], looking at `target` from that far away: yaw round from
// +x towards +z, and scale how many pixels (of 512) a metre is at the target, which lands at x, y from the icon's middle.
function camera(p, target) {
  const [yaw, pitch, roll, near] = p, dist = 1 / near;
  const fwd = unit([-Math.cos(pitch) * Math.cos(yaw), -Math.sin(pitch), -Math.cos(pitch) * Math.sin(yaw)]);
  const r0 = unit(cross(fwd, [0, 1, 0])), u0 = cross(r0, fwd), cr = Math.cos(roll), sr = Math.sin(roll);
  return {
    eye: target.map((v, i) => v - fwd[i] * dist), fwd, right: r0.map((v, i) => v * cr + u0[i] * sr), up: u0.map((v, i) => v * cr - r0[i] * sr),
    f: p[6] * dist, x: p[4], y: p[5],
  };
}
// Where a point lands, in pixels of a w wide picture, and how far in front of the camera it is.
function project(cam, q, w) {
  const d = sub(q, cam.eye), z = dot(d, cam.fwd), k = w / W;
  return [w / 2 + (cam.x + (cam.f * dot(d, cam.right)) / z) * k, (w * H) / W / 2 + (cam.y - (cam.f * dot(d, cam.up)) / z) * k, z];
}
// A mesh drawn by a camera: 1s where it covers a w by h picture, and its nearest depth there if asked.
function draw(mesh, cam, w, h, depth = null) {
  const m = new Uint8Array(w * h);
  for (const { P, T } of mesh) {
    const n = P.length / 3, sx = new Float64Array(n), sy = new Float64Array(n), sz = new Float64Array(n);
    const k = w / W, f = cam.f * k, ox = w / 2 + cam.x * k, oy = h / 2 + cam.y * k, { eye, fwd, right, up } = cam;
    for (let i = 0; i < n; i++) {
      const dx = P[i * 3] - eye[0], dy = P[i * 3 + 1] - eye[1], dz = P[i * 3 + 2] - eye[2];
      const z = dx * fwd[0] + dy * fwd[1] + dz * fwd[2];
      sz[i] = z;
      sx[i] = ox + (f * (dx * right[0] + dy * right[1] + dz * right[2])) / z;
      sy[i] = oy - (f * (dx * up[0] + dy * up[1] + dz * up[2])) / z;
    }
    for (let t = 0; t < T.length; t += 3) {
      const a0 = T[t], b0 = T[t + 1], c0 = T[t + 2];
      const x0 = sx[a0], y0 = sy[a0], z0 = sz[a0], x1 = sx[b0], y1 = sy[b0], z1 = sz[b0], x2 = sx[c0], y2 = sy[c0], z2 = sz[c0];
      if (z0 < 0.02 || z1 < 0.02 || z2 < 0.02) continue;
      const den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
      if (Math.abs(den) < 1e-9) continue;
      const ya = Math.max(0, Math.floor(Math.min(y0, y1, y2))), yb = Math.min(h - 1, Math.ceil(Math.max(y0, y1, y2)));
      const xa = Math.max(0, Math.floor(Math.min(x0, x1, x2))), xb = Math.min(w - 1, Math.ceil(Math.max(x0, x1, x2)));
      for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
        const a = ((y1 - y2) * (x + 0.5 - x2) + (x2 - x1) * (y + 0.5 - y2)) / den, b = ((y2 - y0) * (x + 0.5 - x2) + (x0 - x2) * (y + 0.5 - y2)) / den;
        if (a < 0 || b < 0 || a + b > 1) continue;
        m[y * w + x] = 1;
        if (depth) depth[y * w + x] = Math.min(depth[y * w + x], a * z0 + b * z1 + (1 - a - b) * z2);
      }
    }
  }
  return m;
}
function outline(img, w, h) {
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.floor(((x + 0.5) * img.width) / w), sy = Math.floor(((y + 0.5) * img.height) / h);
    m[y * w + x] = img.data[(sy * img.width + sx) * img.channels + 3] > 100 ? 1 : 0;
  }
  return m;
}
function overlap(a, b) {
  let both = 0, either = 0;
  for (let k = 0; k < a.length; k++) { both += a[k] & b[k]; either += a[k] | b[k]; }
  return either ? both / either : 0;
}
// Walks p uphill on score, every number in turn, in steps that shrink until the x, y step is under `fine` pixels.
function climb(score, p0, steps, fine) {
  let p = p0.slice(), best = score(p), s = steps.slice();
  for (let round = 0; round < 90; round++) {
    let moved = false;
    for (let i = 0; i < p.length; i++) for (const sign of [1, -1]) {
      const q = p.slice();
      q[i] += sign * s[i];
      if (q[3] <= 0.05) continue;
      const v = score(q);
      if (v > best) { best = v; p = q; moved = true; }
    }
    if (!moved) { s = s.map((x) => x * 0.55); if (s[4] < fine) break; }
  }
  return { p, best };
}
const SIZES = [[128, 96, [0.06, 0.04, 0.04, 0.12, 10, 10, 0.05], 1.5], [256, 192, [0.02, 0.02, 0.02, 0.08, 3, 3, 0.015], 0.4], [512, 384, [0.006, 0.006, 0.006, 0.03, 1, 1, 0.005], 0.1]];
const stepsFor = (steps, p) => steps.map((s, i) => (i === 3 || i === 6 ? s * p[i] : s));

// The camera of a gun on its icon.
function fitOne(mesh, img) {
  const { at, length } = middle(mesh), [[w, h, steps, fine], ...finer] = SIZES;
  const start = [];
  const ref = outline(img, w, h);
  for (const lens of LENSES) for (const yawDeg of YAWS) {
    // (The lens stays put here, the scale following the distance: on a picture this small it would wander off.)
    const yaw = deg(yawDeg), f = 256 / Math.tan(deg(lens) / 2), scale = 480 / (length * Math.cos(yaw));
    const p = [yaw, 0, 0, scale / f, 0, 0], tied = (q) => [...q, f * q[3]];
    const r = climb((q) => overlap(draw(mesh, camera(tied(q), at), w, h), ref), p, stepsFor(steps, p).slice(0, 6), fine);
    start.push({ p: tied(r.p), best: r.best });
  }
  start.sort((a, b) => b.best - a.best);
  const done = start.slice(0, 3).map(({ p }) => {
    for (const [fw, fh, fs, ff] of finer) {
      const r = outline(img, fw, fh);
      ({ p } = climb((q) => overlap(draw(mesh, camera(q, at), fw, fh), r), p, stepsFor(fs, p), ff));
    }
    return { p, best: overlap(draw(mesh, camera(p, at), W, H), outline(img, W, H)) };
  }).sort((a, b) => b.best - a.best)[0];
  return { cams: [camera(done.p, at)], fit: done.best };
}
// The cameras of a pair of guns: each first where it lies inside the icon's outline, then both to fill it.
function fitPair(meshes, img) {
  const targets = meshes.map((m) => middle(m).at), [w, h] = SIZES[0], ref = outline(img, w, h);
  const inside = (m) => {
    let good = 0, bad = 0;
    for (let k = 0; k < m.length; k++) if (m[k]) { if (ref[k]) good++; else bad++; }
    return good - 4 * bad;
  };
  const place = (i) => {
    let top = null;
    for (const yawDeg of [0, 25]) for (const rollDeg of [55, 80, 105]) for (const x of [-70, -30, 30, 70]) for (const y of [-30, 20]) {
      const p = [deg(yawDeg + 180 * i), 0, deg(i ? -rollDeg : rollDeg), 1 / 0.6, x, y, 1450];
      const r = climb((q) => inside(draw(meshes[i], camera(q, targets[i]), w, h)), p, [0.08, 0.06, 0.06, 0.2, 8, 8, 40], 1);
      if (!top || r.best > top.best) top = r;
    }
    return top.p;
  };
  const both = (a, b, fw, fh) => {
    const m = draw(meshes[0], camera(a, targets[0]), fw, fh), n = draw(meshes[1], camera(b, targets[1]), fw, fh);
    return m.map((v, k) => v | n[k]);
  };
  let p = [...place(0), ...place(1)];
  for (const [fw, fh, fs, ff] of SIZES.slice(1)) {
    const r = outline(img, fw, fh), steps = [...stepsFor(fs, p.slice(0, 7)), ...stepsFor(fs, p.slice(7))];
    ({ p } = climb((q) => overlap(both(q.slice(0, 7), q.slice(7), fw, fh), r), p, steps, ff));
  }
  return { cams: [camera(p.slice(0, 7), targets[0]), camera(p.slice(7), targets[1])], fit: overlap(both(p.slice(0, 7), p.slice(7), W, H), outline(img, W, H)) };
}

// Solves a x = b for three unknowns.
function solve3(A, b) {
  const m = A.map((r, i) => [...r, b[i]]);
  for (let i = 0; i < 3; i++) {
    let top = i;
    for (let k = i + 1; k < 3; k++) if (Math.abs(m[k][i]) > Math.abs(m[top][i])) top = k;
    [m[i], m[top]] = [m[top], m[i]];
    for (let k = 0; k < 3; k++) if (k !== i) { const f = m[k][i] / m[i][i]; for (let j = i; j < 4; j++) m[k][j] -= f * m[i][j]; }
  }
  return m.map((r, i) => r[3] / r[i]);
}
// Whether the mask lets a sticker show at a place on the gun's textures.
const shows = (mask, u, v) => {
  if (!mask) return true;
  const x = Math.floor((u - Math.floor(u)) * mask.width), y = Math.floor((v - Math.floor(v)) * mask.height);
  return mask.data[(y * mask.width + x) * mask.channels] > 64;
};
// A slot on the icon: a grid of points over its sticker found on the gun through the sticker space, as the camera that
// has them sees them, and the flat sticker that best covers those it can see. null if it hardly sees any.
function slotOnIcon(slot, prims, masks, views) {
  const N = 8, turn = slot.rotation * 2 * Math.PI, c = Math.cos(turn), s = Math.sin(turn), reach = 0.75 / slot.scale;
  const cu = 0.5 + slot.offset[0], cv = 0.5 + slot.offset[1];
  const near = [];
  for (const p of prims.filter((x) => x.S)) for (let t = 0; t < p.T.length; t += 3) {
    const [a, b, d] = [p.T[t], p.T[t + 1], p.T[t + 2]], us = [p.S[a * 2], p.S[b * 2], p.S[d * 2]], vs = [p.S[a * 2 + 1], p.S[b * 2 + 1], p.S[d * 2 + 1]];
    if (us.some((u) => u <= -1) || Math.min(...us) > cu + reach || Math.max(...us) < cu - reach || Math.min(...vs) > cv + reach || Math.max(...vs) < cv - reach) continue;
    near.push({ p, a, b, d, us, vs });
  }
  const seen = [];
  let found = 0;
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
    const t = i / N - 0.5, w = j / N - 0.5, u = cu + (t * c + w * s) / slot.scale, v = cv + (-t * s + w * c) / slot.scale;
    let hit = null;
    for (const { p, a, b, d, us, vs } of near) {
      const den = (vs[1] - vs[2]) * (us[0] - us[2]) + (us[2] - us[1]) * (vs[0] - vs[2]);
      if (Math.abs(den) < 1e-12) continue;
      const wa = ((vs[1] - vs[2]) * (u - us[2]) + (us[2] - us[1]) * (v - vs[2])) / den, wb = ((vs[2] - vs[0]) * (u - us[2]) + (us[0] - us[2]) * (v - vs[2])) / den, wd = 1 - wa - wb;
      if (wa < 0 || wb < 0 || wd < 0) continue;
      if (!shows(masks[p.name], wa * p.U[a * 2] + wb * p.U[b * 2] + wd * p.U[d * 2], wa * p.U[a * 2 + 1] + wb * p.U[b * 2 + 1] + wd * p.U[d * 2 + 1])) continue;
      const pos = [a, b, d].map((k) => [p.P[k * 3], p.P[k * 3 + 1], p.P[k * 3 + 2]]);
      const q = [0, 1, 2].map((k) => wa * pos[0][k] + wb * pos[1][k] + wd * pos[2][k]);
      const view = views[views.length > 1 && q[0] >= views.split ? 1 : 0];
      if (dot(cross(sub(pos[1], pos[0]), sub(pos[2], pos[0])), sub(view.cam.eye, q)) <= 0) continue;
      const [x, y, z] = project(view.cam, q, W);
      if (!hit || z < hit.z) hit = { x, y, z, view };
    }
    if (!hit) continue;
    found++;
    const k = Math.floor(hit.y) * W + Math.floor(hit.x);
    if (hit.x >= 0 && hit.y >= 0 && hit.x < W && hit.y < H && hit.z <= hit.view.depth[k] + 0.005 && !hit.view.behind?.[k]) seen.push({ t, w, x: hit.x, y: hit.y });
  }
  if (seen.length < 12 || seen.length < found * 0.4) return null;
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bx = [0, 0, 0], by = [0, 0, 0];
  for (const q of seen) {
    const r = [1, q.t, q.w];
    for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) A[i][j] += r[i] * r[j]; bx[i] += r[i] * q.x; by[i] += r[i] * q.y; }
  }
  const [x, ax, bxx] = solve3(A, bx), [y, ay, byy] = solve3(A, by);
  return [x, y, ax, ay, bxx, byy].map((v) => +(v / W).toFixed(4));
}

// One gun's body on its icon: the job a worker gets.
function iconOf({ wid, body, gltf, icon, slots, masks: maskFiles }) {
  const img = decodePNG(fs.readFileSync(icon)), prims = readBody(gltf, body);
  const masks = Object.fromEntries(Object.entries(maskFiles).map(([k, f]) => [k, f && !/sticker_gaps/.test(k) ? decodePNG(fs.readFileSync(f)) : null]));
  let cams, fit, views;
  if (PAIRS.has(wid)) {
    const all = solid(prims), split = (() => { let lo = Infinity, hi = -Infinity; for (const { P, T } of all) for (const v of T) { lo = Math.min(lo, P[v * 3]); hi = Math.max(hi, P[v * 3]); } return (lo + hi) / 2; })();
    const meshes = [solid(prims, (x) => x < split), solid(prims, (x) => x >= split)];
    ({ cams, fit } = fitPair(meshes, img));
    views = cams.map((cam, i) => ({ cam, depth: new Float32Array(W * H).fill(Infinity), mesh: meshes[i] }));
    views.forEach((v) => { v.covers = draw(v.mesh, v.cam, W, H, v.depth); });
    views.split = split;
    views[0].behind = views[1].covers; // gun 1 lies over gun 0
  } else {
    const mesh = solid(prims);
    ({ cams, fit } = fitOne(mesh, img));
    views = [{ cam: cams[0], depth: new Float32Array(W * H).fill(Infinity) }];
    draw(mesh, cams[0], W, H, views[0].depth);
  }
  const placed = {};
  for (const s of slots) { const at = slotOnIcon(s, prims, masks, views); if (at) placed[s.id] = at; }
  let x0 = img.width, y0 = img.height, x1 = 0, y1 = 0;
  for (let y = 0; y < img.height; y += 2) for (let x = 0; x < img.width; x += 2) {
    if (img.data[(y * img.width + x) * img.channels + 3] > 20) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  }
  return { wid, body, fit, box: [x0, x1, y0, y1].map((v) => +(v / img.width).toFixed(4)), slots: placed };
}

async function main() {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'data', 'game-data.json'), 'utf8'));
  const svc = new CS2Service({ cacheDir: path.join(ROOT, 'cache', 'cs2'), cliPath: path.join(ROOT, 'tools', 's2v', 'Source2Viewer-CLI.exe'), log: () => {}, shrinkImages: () => {} });
  svc.url = (f) => f; // local paths
  if (!svc.status().available) throw new Error('Counter-Strike 2 is not installed: the models come from its files');
  const index = await svc.ensureIndex();
  const souvenir = new Set(Object.values(data.cases).filter((c) => c.kind === 'souvenir').flatMap((c) => [...Object.values(c.pools || {}).flat(), ...(c.rare || []).flat()]).map((id) => data.skins[id]?.wid));
  const only = process.argv.slice(2);
  const icon = async (img) => {
    const url = 'https://community.akamai.steamstatic.com/economy/image/' + img.slice(1) + '/512fx384f';
    const file = path.join(ROOT, 'cache', 'img', crypto.createHash('sha1').update(url).digest('hex'));
    if (!fs.existsSync(file)) {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${r.status} for an icon`);
      fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    }
    return file;
  };
  const jobs = [];
  for (const wid of [...souvenir].filter((w) => w && (!only.length || only.includes(w))).sort()) {
    const mk = await svc.weaponMarkup(wid), { gltfFile } = await svc.model(index.weapons[wid].model);
    for (const body of ['body_hd', 'body_legacy']) {
      const legacy = body === 'body_legacy', skin = Object.values(data.skins).find((s) => s.wid === wid && s.img && !!index.paints[s.fid]?.legacy === legacy);
      const slots = mk.stickers.filter((s) => SLOTS.includes(s.id) && s.legacy === legacy);
      if (skin && slots.length) jobs.push({ wid, body, gltf: gltfFile, icon: await icon(skin.img), slots, masks: mk.masks });
    }
  }
  const results = [];
  const next = async () => {
    for (let job = jobs.shift(); job; job = jobs.shift()) {
      const r = await new Promise((res, rej) => new Worker(fileURLToPath(import.meta.url), { workerData: job }).once('message', res).once('error', rej));
      console.log(`${r.wid} ${r.body.slice(5)}`.padEnd(30), r.fit.toFixed(4), Object.keys(r.slots).join(' '));
      results.push(r);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(8, os.availableParallelism() >> 1)) }, next));

  const had = fs.existsSync(OUT) ? (await import(pathToFileURL(OUT))).SOUVENIR_ICONS : {};
  const all = { ...had };
  for (const wid of new Set(results.map((r) => r.wid))) all[wid] = results.filter((r) => r.wid === wid).sort((a, b) => a.body.localeCompare(b.body)).map(({ box, slots }) => ({ box, slots }));
  const lines = Object.keys(all).sort().map((w) => `  ${w}: ${JSON.stringify(all[w])},`);
  fs.writeFileSync(OUT, `// Made by scripts/build-souvenir-icons.mjs, which says what all of this means. Don't edit it by hand.\nexport const SOUVENIR_ICONS = {\n${lines.join('\n')}\n};\n`);
  console.log('wrote', OUT);
  process.exit(0);
}

if (isMainThread) await main();
else parentPort.postMessage(iconOf(workerData));
