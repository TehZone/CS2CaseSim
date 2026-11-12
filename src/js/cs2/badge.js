// Badges in 3D: CS2's own model of a collectible (the coin, medal, pin or trophy its inventory inspect shows, exported from
// the player's install: CS2Service.badge) for the badge's inspect, lit and turned like any item, both faces there to see.
// Its materials are the export's (colour, normal map, roughness and metal: a pin's enamel and its metal, a coin's struck
// faces), set up as CS2 has them (badgelook.js): its colour tint (a Service Medal's only where its tint mask says), alpha
// test (a Premier Season medal's bands: those its colour fills show, the rest leave its bare metal), see-through and
// glowing parts, and glass: a medal's cover, see-through with the light it reflects, and crystal (CS2's opaque cubemap
// refraction: its surroundings, bent through it and tinted).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { cs2Badge } from './api.js';
import { hidePoints } from './rig.js';
import { badgeDefIndex, badgeLook, badgeSource, badgeStrings, fillLabels } from './badgelook.js';
import { D } from '../data.js';

const LUM = 'vec3(0.2125, 0.7154, 0.0721)';
// The surroundings a badge reflects (InspectView.applyLighting): the inspect's bright room, where in the dim studio a pin's
// polished metal lines and a coin's chrome came out black (CS2's inventory shows them bright), at a bit over half its
// strength so enamel keeps its colour (at full strength a coin's orange ring and a pin's camo washed out pale).
const ENV = { room: true, intensity: 0.55 };
const linear = (rgb) => new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);

// Badge models, loaded for an inspect: the last few kept (a Premier Season's 29 medals share one model), the rest let go.
// Their images are ImageBitmaps, which the browser doesn't free by itself: closed once no inspect shows the model (kept,
// every model looked at stayed in memory, about 17 MB each, gigabytes over the badge list).
const loader = new GLTFLoader();
const KEEP = 3;
const gltfs = new Map(); // url -> { job, users, kept }, oldest first
function useGltf(url) {
  let e = gltfs.get(url);
  if (e) gltfs.delete(url); // (to the newest end)
  else {
    e = { job: loader.loadAsync(url).then(hidePoints), users: 0, kept: true };
    e.job.catch(() => { if (gltfs.get(url) === e) gltfs.delete(url); });
  }
  gltfs.set(url, e);
  for (const [k, old] of gltfs) {
    if (gltfs.size <= KEEP) break;
    gltfs.delete(k);
    old.kept = false;
    if (!old.users) releaseGltf(old);
  }
  return e;
}
function releaseGltf(e) {
  e.job.then((g) => g.scene.traverse((o) => {
    for (const m of [].concat(o.material || [])) {
      for (const v of Object.values(m)) if (v?.isTexture) { v.dispose(); v.source?.data?.close?.(); }
    }
  })).catch(() => {});
}

// One of the textures the export leaves out (a tint mask, glass's tint and dust), loaded for this model only (no lasting
// cache: freed with it) and made no bigger than the model's own.
async function ownTexture(url, srgb) {
  const blob = await (await fetch(url)).blob();
  let bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  if (Math.max(bmp.width, bmp.height) > 1024) {
    const k = 1024 / Math.max(bmp.width, bmp.height);
    const big = bmp;
    bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none', resizeWidth: Math.round(big.width * k), resizeHeight: Math.round(big.height * k), resizeQuality: 'high' });
    big.close();
  }
  const t = new THREE.Texture(bmp);
  Object.assign(t, { flipY: false, premultiplyAlpha: false, colorSpace: srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, anisotropy: 8 });
  t.needsUpdate = true;
  t.addEventListener('dispose', () => bmp.close());
  return t;
}

// A surface (csgo_complex, csgo_vertexlitgeneric...): the export's material with CS2's tint, metal, alpha test and blending.
async function surfaceMaterial(src, look, mat) {
  const m = src.clone();
  if (look.tintMasked && m.map) {
    // CS2's tint mask: the colour multiplied by the tint where the mask is white (a Service Medal's enamel), left as it is
    // where it's black (its metal and ribbon).
    const mask = await ownTexture(mat.textures.tint, false);
    const u = { cs2TintMask: { value: mask }, cs2Tint: { value: linear(look.tint) } };
    m.color.setRGB(1, 1, 1);
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D cs2TintMask;\nuniform vec3 cs2Tint;')
        .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= mix(vec3(1.0), cs2Tint, texture2D(cs2TintMask, vMapUv).r);');
    };
    m.customProgramCacheKey = () => 'cs2badgetint';
    m.userData.dispose = () => mask.dispose();
  } else if (look.tint) m.color.copy(linear(look.tint));
  // (CS2's one value for its metal, which the export left out: its texture's metal is none. Its roughness stays.)
  if (look.metalness != null) { m.metalness = look.metalness; m.metalnessMap = null; }
  if (look.alphaTest != null) {
    // (Nothing below the reference shows; at 0 all of it does, with no test at all.)
    m.alphaTest = look.alphaTest;
    m.transparent = false;
  }
  if (look.translucent) {
    Object.assign(m, { transparent: true, depthWrite: false, opacity: look.opacity });
    if (look.additive) m.blending = THREE.AdditiveBlending;
  }
  return m;
}

// CS2's csgo_glass: the dust on it (colour, and in alpha how much: g_flTranslucencyRemap between its two values) lit like
// any surface, and through the rest what's behind, less at a glance (fresnel) and through its tint. A medal's cover shows
// what's behind it (drawn over it: the light it gives, plus what's behind times how much shows through); a crystal
// (F_OPAQUE_CUBEMAP_REFRACTION) is opaque and shows its surroundings bent through it instead, as CS2 does with its cubemap.
async function glassMaterial(src, look, mat) {
  const [dust, tint] = await Promise.all([
    mat.textures?.glassDust ? ownTexture(mat.textures.glassDust, true) : null,
    mat.textures?.glassTint ? ownTexture(mat.textures.glassTint, true) : null,
  ]);
  const m = new THREE.MeshStandardMaterial({
    name: src.name, map: dust, normalMap: src.normalMap || null, normalScale: src.normalScale?.clone() || new THREE.Vector2(1, 1),
    roughness: look.roughness, metalness: 0, side: look.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
  });
  const u = { cs2GlassTint: { value: tint }, cs2Remap: { value: new THREE.Vector2(...look.remap) } };
  if (look.refract) m.defines.CS2_REFRACT = '';
  else {
    Object.assign(m, { transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor });
  }
  if (tint && dust) m.defines.CS2_GLASS_TINT = ''; // (read with the dust's UVs)
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D cs2GlassTint;\nuniform vec2 cs2Remap;')
      .replace('#include <map_fragment>', `
        #ifdef USE_MAP
          vec4 cs2Dust = texture2D( map, vMapUv );
        #else
          vec4 cs2Dust = vec4( 1.0, 1.0, 1.0, 0.0 );
        #endif
        #ifdef CS2_GLASS_TINT
          vec3 cs2Tc = texture2D( cs2GlassTint, vMapUv ).rgb;
        #else
          vec3 cs2Tc = vec3( 1.0 );
        #endif
        float cs2O = mix( cs2Remap.x, cs2Remap.y, cs2Dust.a );
        diffuseColor.rgb = cs2Dust.rgb * cs2O;`)
      .replace('#include <opaque_fragment>', `
        float cs2Cos = clamp( abs( dot( normalize( vViewPosition ), normal ) ), 0.0, 1.0 );
        vec3 cs2Through = ( 1.0 - mix( 0.04, 1.0, pow( 1.0 - cs2Cos, 5.0 ) ) ) * cs2Tc * ( 1.0 - cs2O );
        #ifdef CS2_REFRACT
          vec3 cs2Bent = refract( -normalize( vViewPosition ), normal, 0.667 );
          #if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
            vec3 cs2Env = textureCubeUV( envMap, envMapRotation * inverseTransformDirection( cs2Bent, viewMatrix ), roughnessFactor ).rgb * envMapIntensity;
          #else
            vec3 cs2Env = ambientLightColor;
          #endif
          outgoingLight += cs2Env * cs2Through;
        #endif
        #include <opaque_fragment>
        #ifndef CS2_REFRACT
          gl_FragColor.a = 1.0 - dot( cs2Through, ${LUM} );
        #endif`);
  };
  m.customProgramCacheKey = () => 'cs2badgeglass' + (look.refract ? 'R' : '') + (tint && dust ? 'T' : '');
  m.userData.dispose = () => tint?.dispose();
  return m;
}

// The text CS2 draws into a material as it shows the badge (its composite: a CS2 map coin's "CS2 CONTRIBUTOR" and map
// name, see CS2Service.badgeComposite), drawn here the same way: the layout's labels top to bottom on a clear square, in
// the game's stand-in for CS2's Stratum2 (CS2's own ships in a form a page can't load), white letters (the colour CS2's
// composite gives them) with their shadow, the rest clear for the material's alpha test to cut away. Null when the text
// can't be filled in (see fillLabels).
async function compositeTexture(comp, strings) {
  const labels = fillLabels(comp?.labels, strings);
  if (!labels) return null;
  const res = Math.min(2048, Math.max(64, comp.res || 1024));
  const font = (l) => `600 ${l.size}px 'Saira Condensed', Bahnschrift, sans-serif`;
  await Promise.all(labels.map((l) => Promise.resolve(document.fonts?.load(font(l), l.text)).catch(() => null)));
  const c = document.createElement('canvas');
  c.width = c.height = res;
  const g = c.getContext('2d');
  g.textBaseline = 'top';
  let y = 0;
  for (const l of labels) {
    y += l.marginTop || 0;
    Object.assign(g, { font: font(l), textAlign: l.align || 'left', letterSpacing: `${l.spacing || 0}px`, fillStyle: l.color || '#ffffff' });
    const x = l.align === 'center' ? res / 2 : l.align === 'right' ? res : 0;
    for (const line of l.text.split('\n')) {
      if (l.shadow) {
        Object.assign(g, { shadowColor: l.shadow.color, shadowBlur: l.shadow.blur, shadowOffsetX: l.shadow.x, shadowOffsetY: l.shadow.y });
        for (let k = 0; k < Math.max(1, Math.round(l.shadow.strength)); k++) g.fillText(line, x, y);
        g.shadowColor = 'transparent';
      }
      g.fillText(line, x, y);
      y += l.size * 1.2;
    }
    y += l.marginBottom || 0;
  }
  const t = new THREE.CanvasTexture(c);
  Object.assign(t, { flipY: false, colorSpace: THREE.SRGBColorSpace, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, anisotropy: 8 });
  return t;
}

// The material a mesh of the model draws with.
async function badgeMaterial(src, mat, attrs) {
  const look = badgeLook(mat, attrs);
  if (!mat) return { material: src.clone(), look };
  if (look.kind === 'unlit') return { material: new THREE.MeshBasicMaterial({ name: src.name, color: 0x000000 }), look };
  if (look.kind === 'glass') return { material: await glassMaterial(src, look, mat), look };
  if (look.kind === 'effect') {
    const color = look.tint ? linear(look.tint) : new THREE.Color(1, 1, 1);
    return { material: new THREE.MeshBasicMaterial({ name: src.name, map: src.map, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: look.opacity }), look };
  }
  return { material: await surfaceMaterial(src, look, mat), look };
}

// A texture's pixels, made small, to read by UV (glTF's: top row first): (u, v) -> [r, g, b] from 0 to 1. Null without an
// image to read.
function pixelsOf(tex) {
  const img = tex?.image;
  if (!img?.width || !img?.height) return null;
  try {
    const w = Math.min(256, img.width), h = Math.max(1, Math.round((img.height * w) / img.width));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    return (u, v) => {
      const x = Math.min(w - 1, Math.max(0, Math.floor((u - Math.floor(u)) * w))), y = Math.min(h - 1, Math.max(0, Math.floor((v - Math.floor(v)) * h)));
      const i = (y * w + x) * 4;
      return [d[i] / 255, d[i + 1] / 255, d[i + 2] / 255];
    };
  } catch { return null; }
}

// CS2's display models are made to be seen from the front, as its inventory shows them: most have nothing behind (a coin
// or a pin is a shell, open at the back). Turned round in the inspect that showed through to the inside of its face. The
// back is closed here as a plain reverse: the model's outline (its front, pressed flat) at the back of the model, in the
// metal of its edge (its sides' colour, roughness and metalness, as their textures have them). Models with a back of
// their own (a trophy's backing) are left as they are. `meshes` are the model's, in `root` (glTF's axes: the front faces
// +X); those that don't make its outline (hidden, glowing) are left out.
function closeBack(root, meshes) {
  root.updateMatrixWorld(true);
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), m = new THREE.Matrix4();
  const parts = [];
  let front = 0, back = 0, xmin = Infinity;
  for (const o of meshes) {
    const look = o.userData.badgeLook;
    if (!o.visible || look?.additive || look?.kind === 'effect') continue;
    const pos = o.geometry.attributes.position, uv = o.geometry.attributes.uv, idx = o.geometry.index;
    if (!pos) continue;
    m.multiplyMatrices(toRoot, o.matrixWorld);
    const p = new Float32Array(pos.count * 3);
    // (Where each corner is drawn: posed by its bones, for a skinned one.)
    for (let i = 0; i < pos.count; i++) { o.getVertexPosition(i, a).applyMatrix4(m); a.toArray(p, i * 3); }
    const count = idx ? idx.count : pos.count, at = (k) => (idx ? idx.getX(k) : k);
    const tris = [];
    for (let k = 0; k + 2 < count; k += 3) {
      const i0 = at(k), i1 = at(k + 1), i2 = at(k + 2);
      a.fromArray(p, i0 * 3); b.fromArray(p, i1 * 3); c.fromArray(p, i2 * 3);
      xmin = Math.min(xmin, a.x, b.x, c.x);
      n.subVectors(b, a).cross(c.sub(a));
      const area = n.length() / 2;
      if (!(area > 0)) continue;
      const nx = n.x / (area * 2);
      if (nx > 0.5) front += area; else if (nx < -0.5) back += area;
      tris.push([i0, i1, i2, nx, area]);
    }
    parts.push({ o, p, uv, tris, solid: look?.kind === 'surface' && !look.translucent });
  }
  // (A back of its own: more than 60% as much facing back as faces front. Below that the back is open, or partly: the
  // Shattered Web coin's has holes. A model that's whole all round, a trophy or a coin with a reverse of its own, is left
  // alone: a flat plate behind it would show.)
  if (!parts.length || !(front > 0) || back > front * 0.6) return { front, back, lid: null };
  // The plate's metal: the metal of the badge, where its front and sides show metal (four points of each triangle, not
  // its enamel), else its sides; the middle of those by brightness, weighted by area, with their shading (ambient
  // occlusion) in, not the bright texels of its polish. Satin and a shade darker (a plain back is brushed, not a mirror):
  // polished, a flat plate facing you shows the bright room behind you, and a dark nickel pin's back was a white disc.
  const metalSamples = [], sideSamples = [], bary = [[1 / 3, 1 / 3], [0.6, 0.2], [0.2, 0.6], [0.2, 0.2]];
  let seen = 0;
  for (const { o, uv, tris, solid } of parts) {
    if (!solid || !uv) continue;
    const mat = o.material, col = pixelsOf(mat.map), rough = pixelsOf(mat.roughnessMap), ao = pixelsOf(mat.aoMap);
    const metal = mat.metalnessMap === mat.roughnessMap ? rough : pixelsOf(mat.metalnessMap);
    for (const [i0, i1, i2, nx, area] of tris) {
      const side = Math.abs(nx) <= 0.3;
      if (!side && nx < 0.5) continue;
      for (const [s, t] of bary) {
        const r = 1 - s - t;
        const u = uv.getX(i0) * s + uv.getX(i1) * t + uv.getX(i2) * r, v = uv.getY(i0) * s + uv.getY(i1) * t + uv.getY(i2) * r;
        const rgb = col ? col(u, v) : [1, 1, 1], shade = ao ? 1 + (ao(u, v)[0] - 1) * mat.aoMapIntensity : 1;
        const lin = new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace).multiply(mat.color).multiplyScalar(shade);
        const x = { lin, lum: lin.r * 0.2126 + lin.g * 0.7152 + lin.b * 0.0722, w: area,
          rough: (rough ? rough(u, v)[1] : 1) * mat.roughness, metal: (metal ? metal(u, v)[2] : 1) * mat.metalness };
        seen += area;
        if (x.metal >= 0.5) metalSamples.push(x);
        if (side) sideSamples.push(x);
      }
    }
  }
  // (Enough metal to go by: a tenth of what was looked at.)
  const samples = metalSamples.reduce((s, x) => s + x.w, 0) > 0.1 * seen ? metalSamples : sideSamples;
  samples.sort((x, y) => x.lum - y.lum);
  const total = samples.reduce((s, x) => s + x.w, 0);
  const mid = { r: 0, g: 0, b: 0, rough: 0, metal: 0, w: 0 };
  for (let i = 0, at = 0; i < samples.length; at += samples[i++].w) {
    const x = samples[i];
    if (at + x.w < total * 0.35 || at > total * 0.65) continue; // (the middle 30%)
    mid.r += x.lin.r * x.w; mid.g += x.lin.g * x.w; mid.b += x.lin.b * x.w; mid.rough += x.rough * x.w; mid.metal += x.metal * x.w; mid.w += x.w;
  }
  const ok = mid.w > 0;
  const color = ok ? new THREE.Color(mid.r / mid.w, mid.g / mid.w, mid.b / mid.w).multiplyScalar(0.65) : new THREE.Color().setRGB(0.4, 0.41, 0.42, THREE.SRGBColorSpace);
  const roughness = ok ? THREE.MathUtils.clamp(mid.rough / mid.w, 0.6, 0.9) : 0.65, metalness = ok ? mid.metal / mid.w : 0.9;
  // The outline: every triangle that faces the front, flattened just behind the model and turned to face back. (Its
  // openings stay open: the 2026 Service Medal's gaps around its star go right through it.)
  const out = [];
  for (const { p, tris } of parts) {
    for (const [i0, i1, i2, nx] of tris) {
      if (nx <= 0) continue;
      for (const i of [i0, i2, i1]) out.push(xmin, p[i * 3 + 1], p[i * 3 + 2]);
    }
  }
  if (!out.length) return { front, back, lid: null };
  const geo = new THREE.BufferGeometry();
  const posArr = new Float32Array(out);
  const span = new THREE.Box3().setFromArray(posArr).getSize(new THREE.Vector3());
  for (let i = 0; i < posArr.length; i += 3) posArr[i] -= Math.max(span.y, span.z) * 0.0015; // (a hair behind its back edge)
  geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
  const nrm = new Float32Array(posArr.length);
  for (let i = 0; i < nrm.length; i += 3) nrm[i] = -1;
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  const lid = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ name: 'badge_back', color, roughness, metalness }));
  lid.name = 'back';
  lid.frustumCulled = false;
  root.add(lid);
  return { front, back, lid };
}

// A badge item's model (its CS2 model, about 3 units across, facing you and turning about its middle), or null when it
// has none to show (CS2 not installed, or no model for this badge: the inspect shows its picture made solid instead).
export async function buildBadgeModel(item, status = { available: true }) {
  const id = badgeDefIndex(item?.id);
  if (!id) return null;
  const info = await cs2Badge(id);
  if (badgeSource(status, info) !== 'cs2') return null;
  // (Its glTF in use until this model is disposed: any of its materials' disposal says so, once.)
  const entry = useGltf(info.model);
  entry.users++;
  let done = false;
  const free = () => {
    if (done) return;
    done = true;
    if (--entry.users === 0 && !entry.kept) releaseGltf(entry);
  };
  const meshes = [];
  let root;
  try {
    const gltf = await entry.job;
    // (A copy with bones of its own: a few are skinned, the 10 Year Birthday Coin's cupcake posed by its skeleton.)
    root = cloneSkinned(gltf.scene);
    root.traverse((o) => { if (o.isMesh) meshes.push(o); });
    // (The text CS2 draws in, for the materials it's for: drawn once.)
    const comp = info.composite, forComp = (name) => !!(comp?.match && String(name || '').includes(comp.match));
    const text = meshes.some((o) => forComp(o.material?.name)) ? compositeTexture(comp, badgeStrings(D.badges?.[item.id])).catch(() => null) : null;
    await Promise.all(meshes.map(async (o) => {
      o.frustumCulled = false;
      const name = o.material?.name;
      const { material, look } = await badgeMaterial(o.material, info.materials?.[name], info.attrs || {});
      const own = material.userData.dispose;
      material.userData.dispose = () => { own?.(); free(); };
      const tex = forComp(name) && look.kind === 'surface' && material.isMeshStandardMaterial ? await text : null;
      if (tex) { material.map = tex; material.color.setRGB(1, 1, 1); material.needsUpdate = true; }
      o.material = material;
      o.userData.badgeLook = look;
      if (look.hidden) o.visible = false;
    }));
  } catch (e) {
    free();
    throw e;
  }
  const { front, back, lid } = closeBack(root, meshes);
  if (lid) { lid.material.userData.dispose = free; meshes.push(lid); }
  // CS2's display models face along their +X (glTF's axes): turned to face you (one facing the other way, the other way).
  const holder = new THREE.Group();
  holder.rotation.y = back > front * 2 ? Math.PI / 2 : -Math.PI / 2;
  holder.add(root);
  holder.updateMatrixWorld(true);
  const box = new THREE.Box3();
  for (const o of meshes) if (o.visible) box.expandByObject(o, true);
  if (box.isEmpty()) {
    for (const o of meshes) { o.geometry.dispose(); o.material.userData.dispose?.(); o.material.dispose(); }
    free();
    return null;
  }
  const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  const k = 3 / (Math.max(size.x, size.y, size.z) || 1);
  const inner = new THREE.Group();
  inner.scale.setScalar(k);
  inner.position.copy(center).multiplyScalar(-k); // its middle at the pivot
  inner.add(holder);
  const wrap = new THREE.Group();
  wrap.add(inner);
  // (Framed for any turn: as wide as it is deep.)
  const w = Math.max(size.x, size.z) * k;
  wrap.userData.bounds = new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(w, size.y * k, w));
  wrap.userData.cs2 = true;
  wrap.userData.badge = info.name;
  wrap.userData.env = ENV;
  return wrap;
}
