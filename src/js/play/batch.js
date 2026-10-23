// Batching the map's surfaces: three draws each material on its own (its textures bound, its uniforms uploaded), and a
// CS2 map has hundreds, which cost most of a frame. Here every texture of the same size and kind goes into one texture
// array, and the materials that would compile to the same shader and use textures of the same sizes become one: each
// surface's textures are layers of those arrays, its own values (the second and third layers' tints, CS2's
// csgo_environment height blend settings...) a row of a small float table, picked by a material number per vertex.
// A map then draws in a few dozen draws instead of several hundred, and looks the same.
import * as THREE from 'three';

// The textures a material samples, by slot: [slot, material property or layer field, sRGB?]. 'ao' is a separate
// occlusion texture (usually it's the same as the roughness/metalness one, 'orm').
const SLOTS = ['map', 'normal', 'orm', 'ao', 'l2', 'l2n', 'bm', 'c2', 'n2', 'c3', 'n3', 'h1', 'h2', 'h3'];
const SRGB = new Set(['map', 'l2', 'c2', 'c3']);
// The samplers in the shaders (three's and ours: see world.js addLayer, addEnv) and the slot each reads.
const SAMPLERS = { map: 'map', normalMap: 'normal', roughnessMap: 'orm', metalnessMap: 'orm', cs2Layer2: 'l2', cs2Layer2Normal: 'l2n', cs2BlendMod: 'bm',
  cs2Color2: 'c2', cs2Normal2: 'n2', cs2Color3: 'c3', cs2Normal3: 'n3', cs2Height1: 'h1', cs2Height2: 'h2', cs2Height3: 'h3' };
const ROW = 20; // table texels per material
const DUMMY = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
DUMMY.needsUpdate = true;

// A material's textures by slot (L: its second or other layers, see world.js layerOf, envOf), or null when it can't be
// batched (a texture not loaded yet, moved or scaled on its UVs, on another UV set...).
export function slotsOf(v, L) {
  const s = { map: v.map, normal: v.normalMap, orm: v.roughnessMap, ao: v.aoMap && v.aoMap !== v.roughnessMap ? v.aoMap : null };
  if (v.metalnessMap && v.metalnessMap !== v.roughnessMap) return null;
  if (L?.kind === 'env') Object.assign(s, { c2: L.color2, n2: L.normal2, c3: L.color3, n3: L.normal3, h1: L.height[0], h2: L.height[1], h3: L.height[2] });
  else if (L) Object.assign(s, { l2: L.color, l2n: L.normal, bm: L.blendMod });
  for (const k of SLOTS) {
    const t = s[k];
    if (!t) { delete s[k]; continue; }
    const img = t.image;
    if (!img || !(img.width > 0) || t.channel !== 0 || t.offset.x || t.offset.y || t.repeat.x !== 1 || t.repeat.y !== 1 || t.rotation) return null;
  }
  return s.map ? s : null;
}

// The texture arrays: add() files a texture into the array for its size, kind (sRGB or not) and wrapping, build()
// makes them on the GPU. Arrays are split to stay under a size a graphics driver takes in one go.
export class TextureArrays {
  constructor(renderer, anisotropy) {
    this.renderer = renderer;
    this.gl = renderer.getContext();
    this.aniso = anisotropy;
    this.maxLayers = this.gl.getParameter(this.gl.MAX_ARRAY_TEXTURE_LAYERS);
    this.arrays = []; // { key, srgb, w, h, wrapS, wrapT, images: [], texture }
    this.open = new Map(); // key -> the array being filled
    this.placed = new Map(); // three texture -> { array, layer }
  }

  // Which kind of array a texture goes in (its size, sRGB or not, wrapping).
  static kind(t, srgb) { return `${srgb ? 's' : 'l'}${t.image.width}x${t.image.height}:${t.wrapS},${t.wrapT}`; }

  // Where a texture goes (the same image goes once): { array: index, layer }.
  add(t, srgb) {
    if (this.placed.has(t)) return this.placed.get(t);
    const img = t.image, w = img.width, h = img.height, key = TextureArrays.kind(t, srgb);
    let a = this.open.get(key);
    const cap = Math.min(this.maxLayers, Math.max(1, Math.floor((768 << 20) / (w * h * 4 * 1.34))));
    if (!a || a.images.length >= cap) {
      a = { index: this.arrays.length, key, srgb, w, h, wrapS: t.wrapS, wrapT: t.wrapT, images: [], texture: null };
      this.arrays.push(a);
      this.open.set(key, a);
    }
    const at = { array: a.index, layer: a.images.length };
    a.images.push(img);
    this.placed.set(t, at);
    return at;
  }

  // Uploads them, with mipmaps, as three textures it binds as they are (ExternalTexture).
  build() {
    const gl = this.gl, af = gl.getExtension('EXT_texture_filter_anisotropic');
    const wrap = (w) => (w === THREE.ClampToEdgeWrapping ? gl.CLAMP_TO_EDGE : w === THREE.MirroredRepeatWrapping ? gl.MIRRORED_REPEAT : gl.REPEAT);
    for (const a of this.arrays) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, Math.floor(Math.log2(Math.max(a.w, a.h))) + 1, a.srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, a.w, a.h, a.images.length);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); // glTF's convention, as three uploads them
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      a.images.forEach((img, i) => gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, a.w, a.h, 1, gl.RGBA, gl.UNSIGNED_BYTE, img));
      gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, wrap(a.wrapS));
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, wrap(a.wrapT));
      if (af) gl.texParameterf(gl.TEXTURE_2D_ARRAY, af.TEXTURE_MAX_ANISOTROPY_EXT, this.aniso);
      a.texture = new THREE.ExternalTexture(tex);
      a.gl = tex;
      a.images = null;
    }
    this.renderer.resetState(); // (three's idea of what's bound is out of date)
  }

  dispose() { for (const a of this.arrays) if (a.gl) this.gl.deleteTexture(a.gl); }
}

// One batch's table: a row of ROW texels per material (RGBA float): the layers of its textures, then its values.
//  0: layer of map, normal, orm, ao        1: l2|c2, l2n|n2, bm|c3, n3        2: h1, h2, h3, blend softness
//  3: the second layer's first tint (csgo_lightmappedgeneric) or the colour tint (csgo_environment)
//  4: the second tint     5-7: height blend (per layer)     8-10: saturation, brightness, contrast
//  11-13: tints     14-16: tint mask     17-19: UV scale and offset
export function materialTable(rows) {
  const data = new Float32Array(ROW * 4 * rows.length);
  rows.forEach(({ layers, L }, r) => {
    const o = r * ROW * 4, put = (texel, v) => data.set(v, o + texel * 4);
    put(0, [layers.map ?? 0, layers.normal ?? 0, layers.orm ?? 0, layers.ao ?? layers.orm ?? 0]);
    put(1, [layers.l2 ?? layers.c2 ?? 0, layers.l2n ?? layers.n2 ?? 0, layers.bm ?? layers.c3 ?? 0, layers.n3 ?? 0]);
    put(2, [layers.h1 ?? 0, layers.h2 ?? 0, layers.h3 ?? 0, L?.soft ?? 0]);
    if (L?.kind === 'env') {
      put(3, L.colorTint.toArray());
      for (let i = 0; i < 3; i++) {
        put(5 + i, L.h[i].toArray()); put(8 + i, L.adj[i].toArray()); put(11 + i, L.tint[i].toArray());
        put(14 + i, L.mask[i].toArray()); put(17 + i, L.uv[i].toArray());
      }
    } else if (L) { put(3, L.tint1.toArray()); put(4, L.tint2.toArray()); }
  });
  const t = new THREE.DataTexture(data, ROW, rows.length, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}

// A batch's material from one of its members (made by world.js's lightmapped/ambientLit, so it has their shader): its
// textures swapped for placeholders (so three still compiles the same shader, UVs and all) and its shader then made to
// read the arrays and the table (see arrayShader).
export { SLOTS, SRGB };

// broken: the breakables' texture (see world.js), when the batch has breakable pieces in it.
export function batchMaterial(first, slots, arrays, table, light, broken = null) {
  const B = first.clone();
  B.map = DUMMY;
  B.normalMap = slots.normal ? DUMMY : null;
  B.roughnessMap = B.metalnessMap = slots.orm ? DUMMY : null;
  B.aoMap = first.aoMap ? DUMMY : null;
  B.emissiveMap = null;
  B.userData = { ...first.userData, batched: true, pieces: !!broken, shader: undefined };
  light(B);
  const inner = B.onBeforeCompile, key = B.customProgramCacheKey;
  const present = Object.keys(slots).filter((k) => slots[k] != null);
  B.onBeforeCompile = (sh, r) => {
    inner(sh, r);
    sh.uniforms.cs2MatTable = { value: table };
    for (const k of present) sh.uniforms['cs2Arr_' + k] = { value: arrays.arrays[slots[k]].texture };
    arrayShader(sh, present);
    if (broken) {
      // A broken piece's triangles collapse out of view.
      sh.uniforms.cs2Broken = { value: broken };
      sh.vertexShader = 'attribute float cs2Piece;\nuniform highp sampler2D cs2Broken;\n' + sh.vertexShader.replace('#include <project_vertex>',
        '#include <project_vertex>\n\tif ( cs2Piece > 0.5 && texelFetch( cs2Broken, ivec2( int( cs2Piece + 0.5 ), 0 ), 0 ).r > 0.5 ) gl_Position = vec4( 0.0, 0.0, 2.0, 1.0 );');
    }
  };
  B.customProgramCacheKey = () => key.call(B) + '|B' + present.join(',') + (broken ? 'p' : '');
  return B;
}

// The shader made to read texture arrays and the material table: three's chunks that sample (and ours: addLayer,
// addEnv) spelled out, each texture2D( sampler, uv ) of a batched sampler made cs2Sample( array, layer, uv ), and the
// per-material uniforms made globals filled from the table at the start.
export function arrayShader(sh, present) {
  sh.vertexShader = 'attribute float cs2Mat;\nflat varying float vCs2Mat;\n' + sh.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\n\tvCs2Mat = cs2Mat;');
  let f = sh.fragmentShader;
  for (const c of ['map_fragment', 'normal_fragment_maps', 'roughnessmap_fragment', 'metalnessmap_fragment', 'aomap_fragment']) f = f.replace(`#include <${c}>`, THREE.ShaderChunk[c]);
  const ao = present.includes('ao') ? 'ao' : 'orm';
  f = f.replace(/texture2D\(\s*(map|normalMap|roughnessMap|metalnessMap|aoMap|cs2Layer2Normal|cs2Layer2|cs2BlendMod|cs2Color2|cs2Normal2|cs2Color3|cs2Normal3|cs2Height1|cs2Height2|cs2Height3)\s*,/g,
    (_, s) => { const k = s === 'aoMap' ? ao : SAMPLERS[s]; return `cs2Sample( cs2Arr_${k}, cs2L_${k},`; });
  // Our per-material uniforms, now globals from the table.
  f = f.replace(/uniform sampler2D (cs2Layer2|cs2Layer2Normal|cs2BlendMod|cs2Color2|cs2Normal2|cs2Color3|cs2Normal3|cs2Height1|cs2Height2|cs2Height3);\n/g, '')
    .replace(/uniform ((?:float|vec[234]) (?:cs2BlendSoft|cs2Tint1|cs2Tint2|cs2EnvH|cs2EnvAdj|cs2EnvTint|cs2EnvMask|cs2EnvUv|cs2ColorTint)(?:\[ 3 \])?;)/g, '$1');
  const used = new Set(present);
  if (/cs2L_orm/.test(f)) used.add('orm');
  const decl = [...used].map((k) => `uniform sampler2DArray cs2Arr_${k};\nfloat cs2L_${k};`).join('\n');
  const has = (name) => new RegExp(`\\b${name}\\b`).test(f);
  const load = [
    'int r = int( vCs2Mat + 0.5 );',
    'vec4 t0 = texelFetch( cs2MatTable, ivec2( 0, r ), 0 ), t1 = texelFetch( cs2MatTable, ivec2( 1, r ), 0 ), t2 = texelFetch( cs2MatTable, ivec2( 2, r ), 0 );',
    ...['map', 'normal', 'orm'].filter((k) => used.has(k)).map((k, i) => `cs2L_${k} = t0[ ${['map', 'normal', 'orm'].indexOf(k)} ];`),
    used.has('ao') ? 'cs2L_ao = t0.w;' : '',
    used.has('l2') ? 'cs2L_l2 = t1.x;' : '', used.has('c2') ? 'cs2L_c2 = t1.x;' : '',
    used.has('l2n') ? 'cs2L_l2n = t1.y;' : '', used.has('n2') ? 'cs2L_n2 = t1.y;' : '',
    used.has('bm') ? 'cs2L_bm = t1.z;' : '', used.has('c3') ? 'cs2L_c3 = t1.z;' : '', used.has('n3') ? 'cs2L_n3 = t1.w;' : '',
    used.has('h1') ? 'cs2L_h1 = t2.x;' : '', used.has('h2') ? 'cs2L_h2 = t2.y;' : '', used.has('h3') ? 'cs2L_h3 = t2.z;' : '',
    has('cs2BlendSoft') ? 'cs2BlendSoft = t2.w;' : '',
    has('cs2Tint1') ? 'cs2Tint1 = texelFetch( cs2MatTable, ivec2( 3, r ), 0 ).rgb;' : '',
    has('cs2Tint2') ? 'cs2Tint2 = texelFetch( cs2MatTable, ivec2( 4, r ), 0 ).rgb;' : '',
    has('cs2ColorTint') ? 'cs2ColorTint = texelFetch( cs2MatTable, ivec2( 3, r ), 0 ).rgb;' : '',
    has('cs2EnvH') ? 'for ( int i = 0; i < 3; i ++ ) {\n\t\tcs2EnvH[ i ] = texelFetch( cs2MatTable, ivec2( 5 + i, r ), 0 );\n\t\tcs2EnvAdj[ i ] = texelFetch( cs2MatTable, ivec2( 8 + i, r ), 0 ).xyz;\n\t\tcs2EnvTint[ i ] = texelFetch( cs2MatTable, ivec2( 11 + i, r ), 0 ).rgb;\n\t\tcs2EnvMask[ i ] = texelFetch( cs2MatTable, ivec2( 14 + i, r ), 0 ).xy;\n\t\tcs2EnvUv[ i ] = texelFetch( cs2MatTable, ivec2( 17 + i, r ), 0 );\n\t}' : '',
  ].filter(Boolean).join('\n\t');
  f = `flat varying float vCs2Mat;\nuniform highp sampler2D cs2MatTable;\n${decl}\nvec4 cs2Sample( sampler2DArray s, float layer, vec2 uv ) { return texture( s, vec3( uv, layer ) ); }\n` + f;
  // The loading goes first in main() (after the globals are declared: the material code comes before main).
  f = f.replace(/void main\(\) \{/, `void cs2LoadMaterial() {\n\t${load}\n}\nvoid main() {\n\tcs2LoadMaterial();`);
  sh.fragmentShader = f;
}
