// Runs in a hidden window on the dev server (see main.cjs): paints a Case Hardened or Heat Treated skin with the game's
// own bake for every seed and counts what shows on the model, from each side. The bake is an exact one, as the game's is for
// Heat Treated (see bakeSkin): the Case Hardened kits come out the same either way.
const origin = location.origin;
const THREE = await import('three');
const { buildCS2Model, bakeSkin } = await import(origin + '/js/cs2/skin.js');
const { buildFirstPerson } = await import(origin + '/js/cs2/firstperson.js');
const { cs2Prepare } = await import(origin + '/js/cs2/api.js');
const { texture } = await import(origin + '/js/cs2/textures.js');

const SEEDS = 1001;
const VIEW = 1600; // pixels across a side view; the model's length fills most of it
const SIDES = { front: new THREE.Vector3(0, 0, 1), back: new THREE.Vector3(0, 0, -1), top: new THREE.Vector3(0, 1, 0) };
const SIDE_NAMES = { front: 'icon side', back: 'other side', top: 'top' };
// The part of a skin that counts, where that isn't all of its painted side: what the community's numbers are of, and what
// collectors look at. A knife's blade: many paint a handle, a ring, a pommel or a guard as well, and a third of the side
// can be those (a Butterfly's gold blade over blue handles reads half blue without this). along is where the part lies
// along the model's length, from the tip; across where it lies up the side, or from the back to the front from above.
// Each was found by trying parts against the community's numbers, seed by seed. With them, the seeds of every skin rank as
// the community's numbers do (a rank correlation of at least 0.96, on most 0.99) and its best seeds read within a few points.
const PARTS = {
  // The left of the dust cover, from above. First person shows more of the side, but the AK-47's Blue Gems are about this:
  // from the side 661 is nowhere near the first, and the whole top reads it 69% for all the barrel and stock in it. Here
  // it's all blue, as the community says.
  weapon_ak47: { side: 'top', along: [0.5, 0.7], across: [0.75, 0.917] },
  weapon_knife_butterfly: { along: [0, 0.475] }, // (the handles)
  weapon_knife_falchion: { along: [0, 0.5] }, // (the handle)
  weapon_knife_flip: { along: [0, 0.575] }, // (the guard)
  weapon_knife_gut: { along: [0, 0.55] },
  weapon_knife_gypsy_jackknife: { along: [0, 0.45] }, // (the handle's plate)
  weapon_knife_karambit: { along: [0, 0.7] }, // (the finger ring)
  weapon_knife_m9_bayonet: { along: [0, 0.625] },
  weapon_knife_push: { across: [0.167, 0.833] }, // (the two handles: the daggers lie blade to blade, one each way)
  weapon_knife_skeleton: { along: [0, 0.725] },
  weapon_knife_stiletto: { along: [0, 0.725] }, // (the pommel)
  weapon_knife_survival_bowie: { along: [0, 0.6] },
  weapon_knife_tactical: { along: [0, 0.6] },
  weapon_knife_widowmaker: { along: [0, 0.775] },
};

// The colour bands, as hue (degrees) of the painted colour. Both kits' palettes (the Case Hardened pattern's colours, the
// Heat Treated ramp's) have the same two families: a gold one around 45 and a blue one from 195 to about 245, with almost
// nothing between 75 and 185. Blue stops at 260, where it turns violet. Purple and red in the rims of the patches, and
// colour too pale to call (below MIN_SATURATION: the silver in the gold), count as neither.
const GOLD = [20, 75], BLUE = [185, 260], MIN_SATURATION = 0.1;
function band(r, g, b) {
  const hi = Math.max(r, g, b), lo = Math.min(r, g, b), spread = hi - lo;
  if (spread === 0 || spread < MIN_SATURATION * hi) return 2;
  const hue = (360 + 60 * (hi === r ? (g - b) / spread : hi === g ? 2 + (b - r) / spread : 4 + (r - g) / spread)) % 360;
  return hue >= BLUE[0] && hue < BLUE[1] ? 0 : hue >= GOLD[0] && hue < GOLD[1] ? 1 : 2;
}

const canvas = document.createElement('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });

const SKINNED_VS = `
#include <common>
#include <skinning_pars_vertex>
uniform mat3 toModel;
varying vec2 vTexel;
varying vec3 vFacing;
void main() {
  vTexel = uv;
  vFacing = toModel * normal;
  #include <skinbase_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
}`;
// Where each pixel of the model is on the painted texture, and whether the kit paints it.
const TEXEL_FS = `
uniform sampler2D masks;
varying vec2 vTexel;
void main() { vec2 texel = fract(vTexel); gl_FragColor = vec4(texel, texture2D(masks, texel).r, 1.0); }`;
// Which way each pixel faces on the model at rest (bones moved or not), and whether the kit paints it.
const FACING_FS = `
uniform sampler2D masks;
varying vec2 vTexel;
varying vec3 vFacing;
void main() { gl_FragColor = vec4(normalize(vFacing), texture2D(masks, fract(vTexel)).r); }`;
// Everything else: it hides the paint behind it and counts for nothing.
const BLOCK_FS = 'void main() { gl_FragColor = vec4(0.0); }';

// Copies the painted texels at the listed spots out of a bake (sRGB, as the bake stored them).
const GATHER_VS = 'precision highp float; in vec3 position; void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }';
const GATHER_FS = `precision highp float; precision highp sampler2D;
uniform sampler2D paint, spots;
out vec4 colour;
vec3 srgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }
void main() {
  vec2 spot = texelFetch(spots, ivec2(gl_FragCoord.xy), 0).xy;
  colour = vec4(srgb(texelFetch(paint, ivec2(spot * vec2(textureSize(paint, 0))), 0).rgb), 1.0);
}`;

// What a camera sees, one float pixel at a time.
function capture(scene, camera, w, h) {
  const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.render(scene, camera);
  const px = new Float32Array(w * h * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, w, h, px);
  renderer.setRenderTarget(null);
  rt.dispose();
  return px;
}

// The painted texels each side shows, side-on with no perspective: every pixel counts the same, so surfaces weigh what
// they cover on screen, hidden ones nothing, and a texel two mirrored faces share counts once on each side it's seen.
function sideSpots(model, wid) {
  const scene = new THREE.Scene();
  scene.add(model);
  model.updateMatrixWorld(true);
  const box = new THREE.Box3();
  model.traverse((o) => {
    let shown = o.visible;
    for (let n = o.parent; n && shown; n = n.parent) shown = n.visible;
    if (o.isMesh && shown) box.expandByObject(o, true);
  });
  const centre = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3()), reach = size.length() / 2;
  const part = { along: [-Infinity, Infinity], across: [-Infinity, Infinity], ...PARTS[wid] };
  const spots = {};
  for (const [side, dir] of Object.entries(SIDES)) {
    const camera = new THREE.OrthographicCamera(-reach, reach, reach, -reach, 0.01, reach * 4);
    camera.position.copy(centre).addScaledVector(dir, reach * 2);
    camera.up.set(0, dir.y ? 0 : 1, dir.y ? -1 : 0);
    camera.lookAt(centre);
    camera.updateMatrixWorld(true);
    const px = capture(scene, camera, VIEW, VIEW);
    // Where a pixel is on the model, out of 1. along: from the tip (the low end of x), by its column: a back view is mirrored.
    // across: by its row, from the bottom of the model, or from above from its back (the low end of z).
    const along = (col) => (centre.x + (col / VIEW - 0.5) * 2 * reach * (dir.z < 0 ? -1 : 1) - box.min.x) / size.x;
    const across = (row) => (dir.y ? (centre.z + reach - (row / VIEW) * 2 * reach - box.min.z) / size.z : (centre.y + (row / VIEW - 0.5) * 2 * reach - box.min.y) / size.y);
    const list = [];
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 2] <= 0.5) continue;
      const a = along((i / 4) % VIEW), c = across(Math.floor(i / 4 / VIEW));
      if (a >= part.along[0] && a <= part.along[1] && c >= part.across[0] && c <= part.across[1]) list.push(px[i], px[i + 1]);
    }
    spots[side] = list;
  }
  scene.remove(model);
  return spots;
}

// Which way the painted surface you see in first person faces: the viewmodel at rest, in CS2's first-person field of view
// from the player's eyes, arms in the way. → { front, back, top } as shares of the painted pixels seen, out of 1.
async function firstPersonShares(model, { texels, facing, block }) {
  const fp = await buildFirstPerson(model);
  fp.rig.traverse((o) => {
    if (!o.isMesh) return;
    o.frustumCulled = false;
    o.material = o.material === texels ? facing : block;
  });
  const scene = new THREE.Scene();
  scene.add(fp.rig);
  fp.play(false);
  fp.mixer.setTime(0);
  fp.update(0);
  scene.updateMatrixWorld(true);
  const w = 1920, h = 1080;
  const px = capture(scene, new THREE.PerspectiveCamera(54, w / h, 0.01, 400), w, h);
  const seen = { front: 0, back: 0, top: 0, other: 0 };
  let total = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] <= 0.5) continue;
    const x = Math.abs(px[i]), y = px[i + 1], z = px[i + 2];
    seen[Math.abs(z) >= Math.abs(y) && Math.abs(z) >= x ? (z > 0 ? 'front' : 'back') : y >= x && y > 0 ? 'top' : 'other']++;
    total++;
  }
  fp.dispose();
  return { front: seen.front / total, back: seen.back / total, top: seen.top / total };
}

// Reads the listed spots of a bake for each seed. → gather(colorRT) → RGBA bytes, one pixel per spot.
function gatherer(list) {
  const count = list.length / 2, size = Math.ceil(Math.sqrt(count));
  const data = new Float32Array(size * size * 4);
  for (let i = 0; i < count; i++) { data[i * 4] = list[i * 2]; data[i * 4 + 1] = list[i * 2 + 1]; }
  const spots = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.FloatType);
  spots.needsUpdate = true;
  const quad = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3)));
  quad.frustumCulled = false;
  quad.material = new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: GATHER_VS, fragmentShader: GATHER_FS, uniforms: { paint: { value: null }, spots: { value: spots } }, depthTest: false, depthWrite: false });
  const scene = new THREE.Scene();
  scene.add(quad);
  const camera = new THREE.Camera();
  const rt = new THREE.WebGLRenderTarget(size, size, { depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  const px = new Uint8Array(size * size * 4);
  return {
    gather(colorRT) {
      quad.material.uniforms.paint.value = colorRT.texture;
      renderer.setRenderTarget(rt);
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(rt, 0, 0, size, size, px);
      renderer.setRenderTarget(null);
      return px;
    },
    dispose() { spots.dispose(); quad.geometry.dispose(); quad.material.dispose(); rt.dispose(); },
  };
}

// One skin: { blue, gold, other, sideChosen, why, sides: { front, back, top: { blue, gold, other } } }, percents per seed.
export async function measureSkin({ wid, fid, cat, n }) {
  const started = performance.now();
  const prep = await cs2Prepare(wid, fid);
  const item = { sd: 0, fl: 0 };
  const model = await buildCS2Model(item, { wid, fid, cat }, renderer, { statTrak: false });

  const masks = await texture(prep.textures[prep.kit.color.g_tMasks.value ?? prep.inputs.textures.g_tMasks], { wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping });
  const painted = [];
  model.traverse((o) => { if (o.isMesh && o.material.userData.dispose) painted.push(o); });
  const bake = painted[0].material;
  model.updateMatrixWorld(true);
  const uniforms = { masks: { value: masks }, toModel: { value: new THREE.Matrix3().getNormalMatrix(painted[0].matrixWorld) } };
  const texels = new THREE.ShaderMaterial({ vertexShader: SKINNED_VS, fragmentShader: TEXEL_FS, uniforms });
  const facing = new THREE.ShaderMaterial({ vertexShader: SKINNED_VS, fragmentShader: FACING_FS, uniforms });
  const block = new THREE.ShaderMaterial({ vertexShader: SKINNED_VS, fragmentShader: BLOCK_FS, uniforms });
  model.traverse((o) => { if (o.isMesh) o.material = painted.includes(o) ? texels : block; });

  const spots = sideSpots(model, wid);
  const seen = await firstPersonShares(model, { texels, facing, block });
  const most = Object.keys(SIDES).reduce((a, b) => (seen[b] > seen[a] ? b : a));
  const chosen = PARTS[wid]?.side ?? most;
  const shares = Object.keys(SIDES).map((s) => `${SIDE_NAMES[s]} ${Math.round(seen[s] * 100)}%`).join(', ');
  const why = `${chosen === most ? `first person shows the most of its ${SIDE_NAMES[most]}` : 'its Blue Gems are about what it shows from there'} (painted surface seen in first person: ${shares})`;

  const sides = Object.keys(SIDES);
  const all = sides.flatMap((s) => spots[s]);
  const reader = gatherer(all);
  const counts = sides.map((s) => spots[s].length / 2);
  const out = Object.fromEntries(sides.map((s) => [s, { blue: [], gold: [], other: [] }]));
  const percent = (part, whole) => Math.round((part / whole) * 1000) / 10;
  const kept = new Map();
  for (let seed = 0; seed < SEEDS; seed++) {
    const { colorRT, rmRT } = await bakeSkin(renderer, prep, { sd: seed, fl: 0 }, kept, true);
    const px = reader.gather(colorRT);
    colorRT.dispose();
    rmRT.dispose();
    let at = 0;
    sides.forEach((side, s) => {
      const tally = [0, 0, 0];
      for (const end = at + counts[s] * 4; at < end; at += 4) tally[band(px[at], px[at + 1], px[at + 2])]++;
      out[side].blue.push(percent(tally[0], counts[s]));
      out[side].gold.push(percent(tally[1], counts[s]));
      out[side].other.push(percent(tally[2], counts[s]));
    });
  }

  for (const t of kept.values()) t.dispose();
  reader.dispose();
  bake.userData.dispose();
  bake.dispose();
  masks.dispose();
  texels.dispose();
  facing.dispose();
  block.dispose();
  const best = (list) => list.indexOf(Math.max(...list));
  const { blue, gold } = out[chosen];
  console.log(`measure: ${n}: ${chosen}, ${counts.join('/')} pixels, blue ${Math.min(...blue)}-${Math.max(...blue)}% (most: seed ${best(blue)}), gold ${Math.min(...gold)}-${Math.max(...gold)}% (most: seed ${best(gold)}), ${Math.round((performance.now() - started) / 1000)}s`);
  return { ...out[chosen], sideChosen: chosen, why, sides: out };
}
