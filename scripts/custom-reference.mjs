// What to paint a custom skin on (CUSTOM_CONTENT.md): exports, from your own CS2 install, a model's UV layout and its
// reference textures into a folder of yours. They're CS2's files, for you to paint over in your editor: never put them in a
// pack (the game ships nothing of CS2's).
//   node scripts/custom-reference.mjs AK-47 [--out <dir>]            a gun or knife (its name or id: weapon_knife_karambit)
//   node scripts/custom-reference.mjs "Sport Gloves"                 a glove type
//   node scripts/custom-reference.mjs crate "Kilowatt Case"          a case's 3D crate: its emblem picture (the layout to follow)
// Writes <name>_uv.png (the UV wireframe, 2048 px: what the texture's pixels land on), the model (.gltf with its .bin and
// textures, to open in Blender or Substance Painter and paint in 3D) and the CS2 textures in that same UV layout (ambient
// occlusion, masks...). Default folder: custom-reference/<name> (not shipped, not in git).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { encode } from './custom/images.mjs';
import { GLOVES } from './build-custom.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { CS2Service } = require('../cs2/service.cjs');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? null : args.splice(i, 2)[1]; };
const outArg = opt('--out'), size = +opt('--size') || 2048;
const what = args.join(' ').trim();
if (!what) { console.log('Usage: node scripts/custom-reference.mjs <weapon | glove type | crate "<case>"> [--out <dir>]'); process.exit(1); }

const game = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'data', 'game-data.json'), 'utf8'));
const cache = process.env.CS2SIM_CACHE || path.join(ROOT, 'cache', 'cs2');
const svc = new CS2Service({ cacheDir: cache, cliPath: path.join(ROOT, 'tools', 's2v', 'Source2Viewer-CLI.exe'), log: (m) => console.log('[cs2]', m) });
if (!svc.status().available) { console.log('Counter-Strike 2 (or the model extractor in tools/s2v) is not installed here.'); process.exit(1); }
const local = (url) => path.join(cache, ...url.replace(/^cs2cache\//, '').split('/').map(decodeURIComponent));
const slug = (s) => s.replace(/[^\w.-]+/g, '_').replace(/^_|_$/g, '');

// ---- a case's crate ------------------------------------------------------------------------------------------------------
if (/^crate\b/i.test(what)) {
  const name = what.replace(/^crate\s*/i, '') || 'Kilowatt Case';
  const c = game.cases.find((x) => x.n.toLowerCase() === name.toLowerCase());
  const def = /^crate-(\d+)$/.exec(c?.id || '')?.[1];
  if (!def) { console.log(`"${name}" isn't a real case`); process.exit(1); }
  const info = await svc.crate(def);
  if (!info) { console.log(`${c.n} has no 3D crate`); process.exit(1); }
  const out = path.resolve(outArg || path.join(ROOT, 'custom-reference', slug(c.n)));
  fs.mkdirSync(out, { recursive: true });
  const dir = path.dirname(local(info.model));
  for (const f of fs.readdirSync(dir)) if (/\.(png|gltf|bin)$/.test(f)) fs.copyFileSync(path.join(dir, f), path.join(out, f));
  const emblem = fs.readdirSync(dir).find((f) => /_decal_.*color.*\.png$|decal.*\.png$/i.test(f));
  console.log(`${c.n}'s crate is in ${out}.` + (emblem ? ` Its emblem is ${emblem}: a crate.png follows that layout (a square picture, transparent around the emblem).` : ' It has no separate emblem texture: its art is painted on the body (an older crate); pick a CS2-era case (Kilowatt, Gallery, Fever...) as "base".'));
  process.exit(0);
}

// ---- a gun, knife or glove type ------------------------------------------------------------------------------------------
const norm = (s) => s.toLowerCase().replace(/^★\s*/, '');
const gloveType = Object.entries(GLOVES).find(([id, g]) => id === what || norm(g.name) === norm(what))?.[0];
const real = Object.values(game.skins).find((s) => s.wid.startsWith('weapon_') && (s.wid === what || norm(s.w) === norm(what)));
const weapon = gloveType || real?.wid;
if (!weapon) { console.log(`"${what}" isn't a CS2 weapon, knife or glove type (try AK-47, Karambit, Sport Gloves...)`); process.exit(1); }
const label = gloveType ? GLOVES[gloveType].name : real.w;
const paint = gloveType ? GLOVES[gloveType].base : null;
const prep = await svc.prepare({ weapon, paint });
const out = path.resolve(outArg || path.join(ROOT, 'custom-reference', slug(label)));
fs.mkdirSync(out, { recursive: true });

// The model, as exported (open it in Blender or Substance Painter to paint on it in 3D).
const gltfFile = local(prep.model), gdir = path.dirname(gltfFile);
const g = JSON.parse(fs.readFileSync(gltfFile, 'utf8'));
for (const f of fs.readdirSync(gdir)) if (/\.(gltf|bin|png)$/.test(f) && !/info\.json$/.test(f)) fs.copyFileSync(path.join(gdir, f), path.join(out, f));

// Which material is painted: a gun's or knife's skin material (on CS2's model, "hd", or the CS:GO one, "legacy"), or the
// right glove (both hands share its layout).
// A knife has one model (whatever its mesh is called), so its files carry no hd/legacy in their names; a gun's say which.
const targets = [];
const knife = !gloveType && real.cat === 'knife';
if (gloveType) targets.push({ mesh: prep.mesh, material: prep.hands.find((h) => /_right$/.test(h)) || prep.hands[0], name: `${slug(label)}_uv.png`, tag: '' });
else {
  for (const m of prep.meshes.filter((x) => /body_(hd|legacy)$/.test(x.name))) {
    const mat = m.materials.find((n) => /composite|weapon|knife/.test(n) && prep.materials[n]) || m.materials[0];
    const tag = knife ? '' : `_${m.name.endsWith('hd') ? 'hd' : 'legacy'}`;
    targets.push({ mesh: m.name, material: mat, name: `${slug(label)}${tag}_uv.png`, tag });
    if (knife) break;
  }
}
const buffers = (g.buffers || []).map((b) => fs.readFileSync(path.join(gdir, decodeURIComponent(b.uri))));
const read = (ai) => {
  const a = g.accessors[ai], bv = g.bufferViews[a.bufferView], buf = buffers[bv.buffer];
  const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type], size = { 5126: 4, 5125: 4, 5123: 2, 5121: 1 }[a.componentType];
  const stride = bv.byteStride || n * size, base = (bv.byteOffset || 0) + (a.byteOffset || 0), out = [];
  for (let i = 0; i < a.count; i++) for (let k = 0; k < n; k++) {
    const o = base + i * stride + k * size;
    out.push(a.componentType === 5126 ? buf.readFloatLE(o) : a.componentType === 5125 ? buf.readUInt32LE(o) : a.componentType === 5123 ? buf.readUInt16LE(o) : buf[o]);
  }
  return out;
};
for (const t of targets) {
  const img = { w: size, h: size, data: new Uint8Array(size * size * 4) };
  const fill = (x, y, a, col) => {
    x = ((x % size) + size) % size; y = ((y % size) + size) % size; // (UVs past 0..1 repeat, as the texture does)
    const o = (y * size + x) * 4;
    img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2]; img.data[o + 3] = Math.max(img.data[o + 3], a);
  };
  const line = (x0, y0, x1, y1) => {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) | 0;
    for (let i = 0; i <= n; i++) fill(Math.round(x0 + ((x1 - x0) * i) / (n || 1)), Math.round(y0 + ((y1 - y0) * i) / (n || 1)), 255, [255, 255, 255]);
  };
  const tri = (a, b, c) => { // (islands filled faintly, so what's covered shows)
    const minY = Math.floor(Math.min(a[1], b[1], c[1])), maxY = Math.ceil(Math.max(a[1], b[1], c[1]));
    const minX = Math.floor(Math.min(a[0], b[0], c[0])), maxX = Math.ceil(Math.max(a[0], b[0], c[0]));
    const area = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const A = area(a, b, c);
    if (!A || (maxX - minX) * (maxY - minY) > size * size) return;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const p = [x + 0.5, y + 0.5], w0 = area(b, c, p) / A, w1 = area(c, a, p) / A, w2 = area(a, b, p) / A;
      if (w0 >= 0 && w1 >= 0 && w2 >= 0) fill(x, y, 90, [70, 140, 255]);
    }
  };
  let tris = 0;
  for (const m of g.meshes) {
    if (!m.name.endsWith(t.mesh)) continue;
    for (const p of m.primitives) {
      if (g.materials?.[p.material]?.name !== t.material || p.attributes.TEXCOORD_0 == null) continue;
      const uv = read(p.attributes.TEXCOORD_0), idx = p.indices != null ? read(p.indices) : [...Array(uv.length / 2).keys()];
      const pt = (i) => [uv[i * 2] * size, uv[i * 2 + 1] * size];
      for (let i = 0; i < idx.length; i += 3) { const [a, b, c] = [pt(idx[i]), pt(idx[i + 1]), pt(idx[i + 2])]; tri(a, b, c); tris++; }
      for (let i = 0; i < idx.length; i += 3) { const [a, b, c] = [pt(idx[i]), pt(idx[i + 1]), pt(idx[i + 2])]; line(...a, ...b); line(...b, ...c); line(...c, ...a); }
    }
  }
  fs.writeFileSync(path.join(out, t.name), encode(img));
  console.log(`${t.name}: ${tris} triangles of ${t.material} (${t.mesh})`);
  // That model's own maps (its material's g_tNormal, g_tColor, g_tAmbientOcclusion, exported beside the .gltf under CS2's
  // file names), copied under names that say which model and map they are: <weapon>[_hd|_legacy]_normal.png (what a
  // normal.png starts from), _color.png, _ao.png.
  if (gloveType) continue;
  const tex = (g.materials || []).find((x) => x.name === t.material)?.extras?.vmat?.TextureParams || {};
  const exported = fs.readdirSync(gdir);
  for (const [kind, k] of [['normal', 'g_tNormal'], ['color', 'g_tColor'], ['ao', 'g_tAmbientOcclusion']]) {
    const base = tex[k] ? path.basename(tex[k]).replace(/\.vtex$/, '') : null;
    const file = base && exported.find((f) => f.startsWith(base) && /\.png$/i.test(f));
    // (The CS2 model's colour comes with its composite inputs, below, under this same name.)
    if (!file || (kind === 'color' && (knife || t.tag === '_hd'))) continue;
    const name = `${slug(label)}${t.tag}_${kind}.png`;
    fs.copyFileSync(path.join(gdir, file), path.join(out, name));
    const what = kind === 'ao' ? `ambient occlusion${/_orm_/.test(file) ? ', in its red channel' : ''}` : kind === 'color' ? 'own colour' : 'normal map';
    console.log(`${name} (the ${t.tag ? t.tag.slice(1) + ' model\'s' : 'model\'s'} ${what})`);
  }
}

// CS2's own textures in that layout: a gun's composite inputs (ambient occlusion, masks, its own colour) or a glove type's
// (layer mask, normal map, ambient occlusion).
const want = gloveType ? ['g_tLayerMask', 'g_tNormal', 'g_tSurface'].map((k) => [k, prep.kit.color[k]?.value]) : Object.entries(prep.inputs?.textures || {});
const files = await svc.cs2.extract(want.map(([, v]) => v).filter(Boolean));
// (A gun's composite inputs are its CS2 model's, "hd": the CS:GO one has its own maps, copied above.)
const inputTag = !gloveType && !knife && targets.length > 1 ? '_hd' : '';
for (const [k, v] of want) {
  const f = v && files[v.replace(/(\.v\w+)$/, '$1_c').replace(/_c_c$/, '_c')];
  if (f) { const name = `${slug(label)}${inputTag}_${k.replace(/^g_t/, '').toLowerCase()}${path.extname(f)}`; fs.copyFileSync(f, path.join(out, name)); console.log(name + (inputTag ? ' (the hd model\'s, as CS2 composites it)' : '')); }
}
console.log(`\nIn ${out}. Paint your texture on the UV layout above (same size and position: ${size}x${size} maps to the whole 0..1 square).`);
