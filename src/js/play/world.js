// A playable CS2 map in three.js. World surfaces use CS2's baked lighting: the irradiance lightmap (second UV set) plus
// the sun drawn live and masked by CS2's baked sun shadows (lightmap alpha). Props get the light of CS2's light probe
// volumes (probes.js; baked into their vertices here) plus the sun with a shadow map rendered once when the map loads;
// players and weapons are lit by the probes where they stand (ambient cube uniforms). CS2's
// two-layer materials (sand painted over asphalt, plaster over brick...) blend their second layer in like CS2 does. The
// exported world is thousands of small meshes, so it's merged by material in large cells to keep draw calls down.
// Coordinates: the scene stays in the exporter's glTF metres (Y up); gameplay runs in game units.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ProbeField } from './probes.js';

export const IN = 0.0254;
// Game (x, y, z; inches, Z up) <-> glTF scene (metres, Y up).
export const toGl = (p, out = new THREE.Vector3()) => out.set(p[1] * IN, p[2] * IN, p[0] * IN);
export const fromGl = (v) => [v.z / IN, v.x / IN, v.y / IN];
// Unit direction (game) for pitch/yaw in degrees (Source: positive pitch looks down).
export function angleDir(pitch, yaw) {
  const p = (pitch * Math.PI) / 180, y = (yaw * Math.PI) / 180;
  return [Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), -Math.sin(p)];
}
export const dirGl = (d, out = new THREE.Vector3()) => out.set(d[1], d[2], d[0]);

// Materials that never draw in game (tool textures), or need CS2 shaders we don't have.
const HIDDEN = /toolsskybox|tools\/|toolsnodraw|nodraw|toolsclip|toolsplayerclip|toolsinvisible|toolstrigger|skybox/i;
const HIDDEN_SHADERS = /csgo_effects|sky\.vfx|spritecard/i;
// Physics props kept out of the static world: the soccer ball.
const BALL = /soccer_?ball/i;
// Lightmapped shaders (world geometry and overlays). Their lightmap UV is the second UV set (TEXCOORD_1), except
// CS2's newer csgo_environment(_blend), whose second set is a second texture UV and the lightmap UV the third.
const LIGHTMAPPED = /lightmappedgeneric|static_overlay|environment_blend|csgo_environment\.vfx/i;
const lightmapUv = (shader) => (/csgo_environment/i.test(shader || '') ? 'uv2' : 'uv1');
const CELL = 3000; // merge cell size, game units

// The lightmap file (RGBA8: sRGB irradiance / irrMax, alpha = sun visibility) as a texture on UV set 1.
async function loadLightmap(url, size) {
  const buf = await fetch(url).then((r) => { if (!r.ok) throw new Error('lightmap ' + r.status); return r.arrayBuffer(); });
  const tex = new THREE.DataTexture(new Uint8Array(buf), size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace; // the GPU decodes RGB; alpha stays linear
  tex.flipY = false;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.channel = 1;
  tex.needsUpdate = true;
  return tex;
}

// A two-layer material's second layer (F_LAYERS): { color, normal, blendMod, mode, soft, tint1, tint2, key } or null.
// textures: the map export's { vtex path: file name }; load(file, srgb) gives a texture.
function layerOf(vm, textures, load) {
  const t = vm.TextureParams || {};
  if (!vm.IntParams?.F_LAYERS || !textures[t.g_tLayer2Color]) return null;
  const file = (k) => textures[t[k]] || null;
  const tint = (k) => { const v = vm.VectorParams?.[k]; return v ? new THREE.Color().setRGB(v[0], v[1], v[2], THREE.SRGBColorSpace) : new THREE.Color(1, 1, 1); };
  const mode = vm.IntParams.F_FANCY_BLENDING | 0;
  const L = {
    color: load(file('g_tLayer2Color'), true), normal: file('g_tLayer2NormalRoughness') && load(file('g_tLayer2NormalRoughness'), false),
    blendMod: mode && file('g_tBlendModulation') ? load(file('g_tBlendModulation'), false) : null,
    mode, soft: vm.FloatParams?.g_flBlendSoftness ?? 0.1, tint1: tint('g_vLayer1Tint'), tint2: tint('g_vLayer2Tint'),
  };
  L.key = `L${mode}${L.normal ? 'n' : ''}${L.blendMod ? 'm' : ''}`;
  return L;
}

// Blends the second layer in like CS2's csgo_lightmappedgeneric: the vertex paint (cs2Blend) sharpened by the blend
// modulation texture (F_FANCY_BLENDING 1: threshold in its green channel, softness in red; 2: green with
// g_flBlendSoftness; 3: alpha with g_flBlendSoftness), for colour, normal and roughness (the layer's normal alpha).
function addLayer(sh, L) {
  Object.assign(sh.uniforms, {
    cs2Layer2: { value: L.color }, cs2Layer2Normal: { value: L.normal }, cs2BlendMod: { value: L.blendMod },
    cs2BlendSoft: { value: L.soft }, cs2Tint1: { value: L.tint1 }, cs2Tint2: { value: L.tint2 },
  });
  sh.vertexShader = 'attribute float cs2Blend;\nvarying float vCs2Blend;\n' + sh.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\n\tvCs2Blend = cs2Blend;');
  const defs = `#define CS2_BLEND_MODE ${L.mode}\n${L.normal ? '#define CS2_LAYER2_NORMAL\n' : ''}${L.blendMod ? '#define CS2_BLENDMOD\n' : ''}`;
  sh.fragmentShader = defs + 'uniform sampler2D cs2Layer2;\nuniform sampler2D cs2Layer2Normal;\nuniform sampler2D cs2BlendMod;\nuniform float cs2BlendSoft;\nuniform vec3 cs2Tint1;\nuniform vec3 cs2Tint2;\nvarying float vCs2Blend;\n' + sh.fragmentShader
    .replace('#include <map_fragment>', `float cs2B = clamp( vCs2Blend, 0.0, 1.0 );
#ifdef CS2_BLENDMOD
	{
		vec4 bm = texture2D( cs2BlendMod, vMapUv );
		#if CS2_BLEND_MODE == 1
			float mask = bm.g, soft = bm.r;
		#elif CS2_BLEND_MODE == 3
			float mask = bm.a, soft = cs2BlendSoft;
		#else
			float mask = bm.g, soft = cs2BlendSoft;
		#endif
		soft = max( soft, 0.002 );
		cs2B = smoothstep( max( 0.0, mask - soft ), min( 1.0, mask + soft ), cs2B );
	}
#endif
diffuseColor *= mix( texture2D( map, vMapUv ) * vec4( cs2Tint1, 1.0 ), texture2D( cs2Layer2, vMapUv ) * vec4( cs2Tint2, 1.0 ), cs2B );`)
    .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
#ifdef CS2_LAYER2_NORMAL
	roughnessFactor = mix( roughnessFactor, roughness * texture2D( cs2Layer2Normal, vMapUv ).a, cs2B );
#endif`)
    .replace('#include <normal_fragment_maps>', THREE.ShaderChunk.normal_fragment_maps.replace('vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;',
      `#ifdef CS2_LAYER2_NORMAL
		vec3 mapN = mix( texture2D( normalMap, vNormalMapUv ).xyz, texture2D( cs2Layer2Normal, vMapUv ).xyz, cs2B ) * 2.0 - 1.0;
	#else
		vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
	#endif`));
}

// CS2's csgo_environment(_blend), most surfaces on the newer maps (Train, Cache, Inferno, Ancient...): the exporter keeps
// only the first layer's colour, untinted. This is the rest, as CS2's shader does it: up to two more layers (colour,
// normal; the second on the second UV set unless g_nUVSet2 says otherwise, the third on the first) blended in by the
// vertex paint (cs2Env, the exporter's _TEXCOORD_4: x the second layer, y the third, w softer) against each layer's
// height map (CS2's height blend, without its softening with distance), every layer's colour saturated, brightened,
// contrasted and tinted where its tint mask (the height map's green) says, then the material's and the vertex's
// (COLOR_0) tints. A layer's roughness is its normal map's alpha. Returns the material's layers or null.
function envOf(vm, textures, load) {
  const shader = vm.ShaderName || '';
  if (!shader.includes('csgo_environment')) return null;
  const T = vm.TextureParams || {}, F = vm.FloatParams || {}, V = vm.VectorParams || {}, I = vm.IntParams || {};
  const tex = (k, srgb) => (T[k] && textures[T[k]] ? load(textures[T[k]], srgb) : null);
  const blend = shader.includes('environment_blend');
  const E = {
    kind: 'env', height: [tex('g_tHeight1', false)],
    color2: blend ? tex('g_tColor2', true) : null, normal2: blend ? tex('g_tNormal2', false) : null,
    color3: blend && I.F_ENABLE_LAYER_3 ? tex('g_tColor3', true) : null, normal3: blend && I.F_ENABLE_LAYER_3 ? tex('g_tNormal3', false) : null,
    uvSet: [I.g_nUVSet1 | 0, I.g_nUVSet2 | 0, I.g_nUVSet3 | 0],
  };
  E.height.push(E.color2 ? tex('g_tHeight2', false) : null, E.color3 ? tex('g_tHeight3', false) : null);
  const srgb = (v) => new THREE.Color().setRGB(v[0], v[1], v[2], THREE.SRGBColorSpace);
  const f = (k, i, d) => F[k + i] ?? d;
  // Per layer: [height scale, height zero point, blend softness, mask with height], [saturation, brightness, contrast],
  // the tint, [tint mask contrast, tint mask brightness], [UV scale x, y, offset x, y].
  E.h = [1, 2, 3].map((i) => new THREE.Vector4(f('g_flHeightMapScale', i, 1), f('g_flHeightMapZeroPoint', i, 0), f('g_flBlendSoftness', i, 0.1), f('g_flMaskWithHeight', i, 0)));
  E.adj = [1, 2, 3].map((i) => new THREE.Vector3(f('g_fTextureColorSaturation', i, 1), f('g_fTextureColorBrightness', i, 1), f('g_fTextureColorContrast', i, 1)));
  E.tint = [1, 2, 3].map((i) => srgb(V['g_vTextureColorTint' + i] || [1, 1, 1]));
  E.mask = [1, 2, 3].map((i) => new THREE.Vector2(f('g_fTintMaskContrast', i, 1), f('g_fTintMaskBrightness', i, 1)));
  E.uv = [1, 2, 3].map((i) => { const s = V['g_vTexCoordScale' + i] || [1, 1], o = V['g_vTexCoordOffset' + i] || [0, 0]; return new THREE.Vector4(s[0], s[1], o[0], o[1]); });
  E.colorTint = srgb(V.g_vColorTint || [1, 1, 1]);
  E.key = 'E' + [E.color2, E.normal2, E.color3, E.normal3, ...E.height].map((t) => (t ? 1 : 0)).join('') + E.uvSet.join('');
  return E;
}

// The layer UVs: a layer's set (0: as exported, 1: the first set transformed, 2: the second transformed).
const envUv = (set, i, raw) => (set === 0 ? raw : `( ${set === 2 ? 'vCs2Uv2' : 'vCs2Uv0'} * cs2EnvUv[ ${i} ].xy + cs2EnvUv[ ${i} ].zw )`);

function addEnv(sh, E) {
  Object.assign(sh.uniforms, {
    cs2Color2: { value: E.color2 }, cs2Normal2: { value: E.normal2 }, cs2Color3: { value: E.color3 }, cs2Normal3: { value: E.normal3 },
    cs2Height1: { value: E.height[0] }, cs2Height2: { value: E.height[1] }, cs2Height3: { value: E.height[2] },
    cs2EnvH: { value: E.h }, cs2EnvAdj: { value: E.adj }, cs2EnvTint: { value: E.tint }, cs2EnvMask: { value: E.mask }, cs2EnvUv: { value: E.uv },
    cs2ColorTint: { value: E.colorTint },
  });
  sh.vertexShader = 'attribute vec2 cs2Uv2;\nattribute vec4 cs2Env;\nattribute vec4 cs2Tint;\nvarying vec2 vCs2Uv0;\nvarying vec2 vCs2Uv2;\nvarying vec4 vCs2Env;\nvarying vec4 vCs2Tint;\n'
    + sh.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\n\tvCs2Uv0 = uv; vCs2Uv2 = cs2Uv2; vCs2Env = cs2Env; vCs2Tint = cs2Tint;');
  const defs = [E.color2 && 'CS2_L2', E.normal2 && 'CS2_N2', E.color3 && 'CS2_L3', E.normal3 && 'CS2_N3', E.height[0] && 'CS2_H1', E.height[1] && 'CS2_H2', E.height[2] && 'CS2_H3']
    .filter(Boolean).map((d) => `#define ${d}\n`).join('');
  const uv1 = envUv(E.uvSet[0], 0, 'vMapUv'), uv2 = envUv(E.uvSet[1], 1, 'vCs2Uv2'), uv3 = envUv(E.uvSet[2], 2, 'vCs2Uv0');
  sh.fragmentShader = defs + `uniform sampler2D cs2Color2;\nuniform sampler2D cs2Normal2;\nuniform sampler2D cs2Color3;\nuniform sampler2D cs2Normal3;
uniform sampler2D cs2Height1;\nuniform sampler2D cs2Height2;\nuniform sampler2D cs2Height3;
uniform vec4 cs2EnvH[ 3 ];\nuniform vec3 cs2EnvAdj[ 3 ];\nuniform vec3 cs2EnvTint[ 3 ];\nuniform vec2 cs2EnvMask[ 3 ];\nuniform vec4 cs2EnvUv[ 3 ];\nuniform vec3 cs2ColorTint;
varying vec2 vCs2Uv0;\nvarying vec2 vCs2Uv2;\nvarying vec4 vCs2Env;\nvarying vec4 vCs2Tint;
// A layer's colour, saturated, brightened, contrasted and tinted where its tint mask says.
vec3 cs2Adjust( vec3 c, float mask, int i ) {
	float m = clamp( ( cs2EnvMask[ i ].x * ( mask - 0.5 ) + 0.5 ) * cs2EnvMask[ i ].y, 0.0, 1.0 );
	vec3 a = mix( vec3( dot( c, vec3( 0.2125, 0.7154, 0.0721 ) ) ), c, cs2EnvAdj[ i ].x );
	a = max( ( a - 0.18 ) * cs2EnvAdj[ i ].z + 0.18, 0.0 ) * cs2EnvAdj[ i ].y * cs2EnvTint[ i ];
	return mix( c, a, m );
}
` + sh.fragmentShader
    .replace('#include <map_fragment>', `vec2 cs2U1 = ${uv1}, cs2U2 = ${uv2}, cs2U3 = ${uv3};
vec4 cs2C1 = texture2D( map, cs2U1 ), cs2C2 = vec4( 0.0 ), cs2C3 = vec4( 0.0 );
vec4 cs2H1 = vec4( 0.5, 1.0, 0.0, 1.0 ), cs2H2 = cs2H1, cs2H3 = cs2H1;
#ifdef CS2_H1
	cs2H1 = texture2D( cs2Height1, cs2U1 );
#endif
cs2C1.rgb = cs2Adjust( cs2C1.rgb, cs2H1.g, 0 );
// CS2's height blend: each layer's height (scaled about its zero point) against the vertex paint, then normalised.
float cs2W2 = clamp( vCs2Env.x * 1.1 - 0.05, 0.0, 1.0 ), cs2W3 = clamp( vCs2Env.y * 1.1 - 0.05, 0.0, 1.0 );
float cs2S2 = max( min( vCs2Env.w + cs2EnvH[ 1 ].z, 1.0 ), 1e-4 );
float cs2K1 = cs2EnvH[ 0 ].x + cs2S2, cs2Z1 = cs2EnvH[ 0 ].y;
float cs2Lo = -cs2Z1 * cs2K1, cs2Hi = ( 1.0 - cs2Z1 ) * cs2K1;
float cs2Ht1 = ( cs2H1.r - cs2Z1 ) * cs2K1, cs2Ht2 = cs2Ht1, cs2Ht12 = cs2Ht1;
float cs2B2 = 0.0, cs2B3 = 0.0;
#ifdef CS2_L2
	cs2C2 = texture2D( cs2Color2, cs2U2 );
	#ifdef CS2_H2
		cs2H2 = texture2D( cs2Height2, cs2U2 );
	#endif
	cs2C2.rgb = cs2Adjust( cs2C2.rgb, cs2H2.g, 1 );
	{
		float z = cs2EnvH[ 1 ].y, k = cs2EnvH[ 1 ].x + cs2S2, kb = k - 2.0 * cs2S2;
		kb = kb == 0.0 ? 1e-4 : kb;
		float raw = ( cs2H2.r - z ) * kb;
		cs2Ht2 = raw + mix( cs2Lo - ( 1.0 - z ) * k - cs2S2, cs2Hi + z * k, cs2W2 );
		vec2 v = max( vec2( cs2Ht1, cs2Ht2 ) - max( cs2Ht1, cs2Ht2 ) + cs2S2, 0.0 );
		cs2B2 = clamp( v.y / ( v.x + 1e-4 + v.y ) * mix( 0.5, cs2H2.r, cs2EnvH[ 1 ].w ) * 2.0, 0.0, 1.0 );
		cs2Ht12 = mix( cs2Ht1, raw, cs2B2 );
	}
#endif
#ifdef CS2_L3
	cs2C3 = texture2D( cs2Color3, cs2U3 );
	#ifdef CS2_H3
		cs2H3 = texture2D( cs2Height3, cs2U3 );
	#endif
	cs2C3.rgb = cs2Adjust( cs2C3.rgb, cs2H3.g, 2 );
	{
		float s = max( min( vCs2Env.w + cs2EnvH[ 2 ].z, 1.0 ), 1e-4 );
		float z = cs2EnvH[ 2 ].y, k = cs2EnvH[ 2 ].x + s, kb = k - 2.0 * s;
		kb = kb == 0.0 ? 1e-4 : kb;
		float h3 = ( cs2H3.r - z ) * kb + mix( cs2Lo - ( 1.0 - z ) * k - s, cs2Hi + z * k, cs2W3 );
		vec3 v = max( vec3( cs2Ht1, cs2Ht2, h3 ) - max( cs2Ht12, h3 ) + s, 0.0 );
		cs2B3 = clamp( v.z / ( v.x + 1e-4 + v.y + v.z ) * mix( 0.5, cs2H3.r, cs2EnvH[ 2 ].w ) * 2.0, 0.0, 1.0 );
	}
#endif
vec3 cs2Col = mix( mix( cs2C1.rgb, cs2C2.rgb, cs2B2 ), cs2C3.rgb, cs2B3 );
diffuseColor.rgb *= cs2Col * cs2ColorTint * mix( vec3( 1.0 ), vCs2Tint.rgb, vCs2Tint.a );
diffuseColor.a *= cs2C1.a;`)
    .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
#ifdef CS2_N2
	roughnessFactor = mix( roughnessFactor, roughness * texture2D( cs2Normal2, cs2U2 ).a, cs2B2 );
#endif
#ifdef CS2_N3
	roughnessFactor = mix( roughnessFactor, roughness * texture2D( cs2Normal3, cs2U3 ).a, cs2B3 );
#endif`)
    .replace('#include <normal_fragment_maps>', THREE.ShaderChunk.normal_fragment_maps.replace('vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;',
      `vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz;
	#ifdef CS2_N2
		mapN = mix( mapN, texture2D( cs2Normal2, cs2U2 ).xyz, cs2B2 );
	#endif
	#ifdef CS2_N3
		mapN = mix( mapN, texture2D( cs2Normal3, cs2U3 ).xyz, cs2B3 );
	#endif
	mapN = mapN * 2.0 - 1.0;`));
}

// The clock of animated textures (overlays' frame grids: Nuke's water caustics...), set as they're drawn.
const CS2_TIME = { value: 0 };

// CS2's overlays (csgo_static_overlay: decals) that don't cover what's under them: F_BLEND_MODE 3 multiplies it (mod2x:
// mid grey leaves it as it is, darker darkens, lighter lightens: grime, stains, caustics), 2 adds to it. Unlit, as in
// CS2. F_TEXTURE_ANIMATION plays the texture's grid of frames (g_vAnimationGrid, g_nNumAnimationCells, at
// g_flAnimationTimePerFrame) instead of showing the whole sheet.
function overlayMaterial(src, vm, mode) {
  const I = vm.IntParams || {}, F = vm.FloatParams || {}, V = vm.VectorParams || {};
  const m = new THREE.MeshBasicMaterial({ map: src.map, color: src.color, opacity: src.opacity, transparent: true, depthWrite: false, side: src.side,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  if (mode === 3) Object.assign(m, { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.DstColorFactor, blendDst: THREE.SrcColorFactor });
  else m.blending = THREE.AdditiveBlending;
  const grid = I.F_TEXTURE_ANIMATION && V.g_vAnimationGrid?.[0] > 0 ? V.g_vAnimationGrid : null;
  const cells = grid ? I.g_nNumAnimationCells || grid[0] * grid[1] : 0, frame = Math.max(0.001, F.g_flAnimationTimePerFrame || 0.1);
  m.onBeforeCompile = (sh) => {
    if (grid) {
      sh.uniforms.cs2Time = CS2_TIME;
      sh.fragmentShader = 'uniform float cs2Time;\n' + sh.fragmentShader.replace('#include <map_fragment>', `float cs2F = mod( floor( ( cs2Time + ${(F.g_flAnimationTimeOffset || 0).toFixed(3)} ) / ${frame.toFixed(4)} ), ${cells.toFixed(1)} );
	vec2 cs2G = vec2( ${grid[0].toFixed(1)}, ${grid[1].toFixed(1)} );
	diffuseColor *= texture2D( map, ( vec2( mod( cs2F, cs2G.x ), floor( cs2F / cs2G.x ) ) + clamp( vMapUv, 0.002, 0.998 ) ) / cs2G );`);
    }
    // mod2x: the blend doubles colour x what's there; mid grey (0.5 in sRGB, 0.214 linear) is "no change".
    if (mode === 3) sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>', '#include <opaque_fragment>\n\tgl_FragColor = vec4( mix( vec3( 0.5 ), gl_FragColor.rgb * ( 0.5 / 0.214 ), gl_FragColor.a ), 1.0 );');
  };
  m.customProgramCacheKey = () => 'cs2ov' + mode + (grid ? 'a' : '');
  m.userData.basic = true;
  m.userData.animated = !!grid;
  return m;
}

// Glass (csgo_glass; the exporter gives it neither colour nor transparency, so it came out a solid white slab) and
// water (csgo_water_fancy, left out before): see-through, reflecting the map's sky more at glancing angles like CS2's,
// water tinted its g_vWaterFogColor with waves running over it.
function clearMaterial(src, vm, sky, water) {
  const V = vm.VectorParams || {};
  const c = (v, d) => new THREE.Color().setRGB(...(v || d).slice(0, 3), THREE.SRGBColorSpace);
  const m = new THREE.MeshStandardMaterial({
    color: water ? c(V.g_vWaterFogColor, [0.3, 0.4, 0.4]).multiplyScalar(0.3) : c(V.GlassTintColor, [1, 1, 1]).multiplyScalar(0.6),
    roughness: water ? 0.3 : 0.1, metalness: 0, envMap: sky, envMapIntensity: water ? 0.9 : 0.7,
    transparent: true, depthWrite: false, side: water ? THREE.FrontSide : THREE.DoubleSide,
  });
  const [near, far] = water ? [0.35, 0.92] : [0.1, 0.55]; // see-through looking down into it, a mirror at a glance
  m.onBeforeCompile = (sh) => {
    if (water) {
      sh.uniforms.cs2Time = CS2_TIME;
      sh.vertexShader = 'varying vec3 vCs2World;\n' + sh.vertexShader.replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n\tvCs2World = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
      sh.fragmentShader = 'uniform float cs2Time;\nvarying vec3 vCs2World;\n' + sh.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
	{
		// Waves: a few travelling ripples of different sizes (metres), as the surface's slope.
		vec2 p = vCs2World.xz, s = vec2( 0.0 );
		s += vec2( cos( p.x * 2.1 + cs2Time * 1.3 ), cos( p.y * 1.7 - cs2Time * 1.1 ) ) * 0.05;
		s += vec2( cos( ( p.x + p.y ) * 4.3 - cs2Time * 1.9 ), cos( ( p.x - p.y ) * 3.7 + cs2Time * 1.6 ) ) * 0.03;
		s += vec2( cos( p.y * 9.1 + p.x * 2.0 + cs2Time * 2.7 ), cos( p.x * 8.3 - p.y * 1.5 - cs2Time * 2.3 ) ) * 0.015;
		normal = normalize( ( viewMatrix * vec4( normalize( vec3( -s.x, 1.0, -s.y ) ), 0.0 ) ).xyz );
	}`);
    }
    // The sun's glint, softened (on rippling water a sharp one lit the whole surface up).
    sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
	reflectedLight.directSpecular *= ${water ? '0.25' : '0.5'};`);
    sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>', `#include <opaque_fragment>
	gl_FragColor.a = mix( ${near.toFixed(2)}, ${far.toFixed(2)}, pow( 1.0 - abs( dot( normal, normalize( vViewPosition ) ) ), 3.0 ) );`);
  };
  m.customProgramCacheKey = () => (water ? 'cs2water' : 'cs2glass');
  m.userData.basic = true; // lit by the sun and the sky, no probe light per vertex
  m.userData.animated = water;
  return m;
}

// CS2 reflects its cubemaps off every surface; without one, metal (no diffuse colour) went black (Vertigo's lift
// doors). The light around a point stands in for its cubemap: the indirect light, as radiance from all around.
const REFLECT_AROUND = `
	#if defined( RE_IndirectSpecular ) && ! defined( USE_ENVMAP )
		radiance += irradiance * RECIPROCAL_PI;
	#endif`;

// Lightmapped surfaces: the sun's direct light is multiplied by the baked sun visibility in the lightmap's alpha.
function lightmapped(m, lightMap, irrMax, layer = null) {
  m.lightMap = lightMap;
  m.lightMapIntensity = irrMax * Math.PI;
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_begin>',
      'float cs2SunMask = texture2D( lightMap, vLightMapUv ).a;\n' + THREE.ShaderChunk.lights_fragment_begin.replace(
        'getDirectionalLightInfo( directionalLight, directLight );',
        'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= cs2SunMask;'));
    sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_maps>', '#include <lights_fragment_maps>' + REFLECT_AROUND);
    if (layer) (layer.kind === 'env' ? addEnv : addLayer)(sh, layer);
  };
  m.customProgramCacheKey = () => 'cs2lm' + (layer?.key || '');
}

// Everything else: the shadow-mapped sun plus its indirect light, one of: CS2's probe light baked into the vertices
// (probe: true; attribute cs2Probe), an ambient cube (ambient.cube: 6 colours from +X, +Y, +Z, -X, -Y, -Z in game axes,
// weighted by the normal like CS2's probes; for players and weapons, updated where they are), or a sky/ground ambient.
// The probe light is irradiance, as the lightmap's: times PI for three's Lambert.
export function ambientLit(m, ambient, layer = null, { probe = false } = {}) {
  const mode = probe ? 'p' : ambient.cube ? 'c' : 'h';
  m.onBeforeCompile = (sh) => {
    let add;
    if (mode === 'p') {
      sh.vertexShader = 'attribute vec3 cs2Probe;\nvarying vec3 vCs2Probe;\n' + sh.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\n\tvCs2Probe = cs2Probe;');
      add = 'varying vec3 vCs2Probe;\n';
    } else if (mode === 'c') {
      sh.uniforms.cs2Cube = ambient.cube;
      add = 'uniform vec3 cs2Cube[6];\n';
    } else {
      sh.uniforms.cs2Sky = ambient.sky;
      sh.uniforms.cs2Ground = ambient.ground;
      add = 'uniform vec3 cs2Sky;\nuniform vec3 cs2Ground;\n';
    }
    const light = {
      p: 'irradiance += vCs2Probe * PI;',
      // glTF axes (Y up) to game axes (Z up): game = (gl.z, gl.x, gl.y).
      c: `vec3 gn = inverseTransformDirection( geometryNormal, viewMatrix ).zxy, n2 = gn * gn;
	irradiance += PI * ( n2.x * ( gn.x >= 0.0 ? cs2Cube[ 0 ] : cs2Cube[ 3 ] ) + n2.y * ( gn.y >= 0.0 ? cs2Cube[ 1 ] : cs2Cube[ 4 ] ) + n2.z * ( gn.z >= 0.0 ? cs2Cube[ 2 ] : cs2Cube[ 5 ] ) );`,
      h: 'vec3 wn = inverseTransformDirection( geometryNormal, viewMatrix );\n\tirradiance += mix( cs2Ground, cs2Sky, wn.y * 0.5 + 0.5 );',
    }[mode];
    sh.fragmentShader = add + sh.fragmentShader.replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
	{ ${light} }${REFLECT_AROUND}`);
    if (layer) (layer.kind === 'env' ? addEnv : addLayer)(sh, layer);
  };
  m.customProgramCacheKey = () => 'cs2amb' + mode + (layer?.key || '');
}

// An ambient cube uniform (see ambientLit) and a function that sets it from the probes at a point.
export function ambientCube() {
  const cube = { value: Array.from({ length: 6 }, () => new THREE.Vector3(0.4, 0.4, 0.4)) };
  const tmp = new Float32Array(18);
  return { cube, set(probes, p) { if (!probes) return; probes.cube(p, tmp); for (let k = 0; k < 6; k++) cube.value[k].set(tmp[k * 3], tmp[k * 3 + 1], tmp[k * 3 + 2]); }, values: tmp };
}

// An attribute's values as a tightly packed Float32Array (plain float arrays are used as they are). Cached: the
// exporter's aggregate fragments share one big vertex buffer between many meshes.
const packed = new WeakMap();
function floats(attr) {
  if (!attr) return null;
  if (packed.has(attr)) return packed.get(attr);
  const n = attr.count, k = attr.itemSize;
  const inter = attr.isInterleavedBufferAttribute;
  const src = inter ? attr.data.array : attr.array;
  let out = src;
  if (inter || !(src instanceof Float32Array)) {
    const stride = inter ? attr.data.stride : k, off = inter ? attr.offset : 0;
    const s = !attr.normalized ? 1 : src instanceof Int8Array ? 127 : src instanceof Uint8Array ? 255 : src instanceof Int16Array ? 32767 : src instanceof Uint16Array ? 65535 : 1;
    const min = attr.normalized && (src instanceof Int8Array || src instanceof Int16Array) ? -1 : -Infinity;
    out = new Float32Array(n * k);
    for (let i = 0; i < n; i++) for (let c = 0; c < k; c++) out[i * k + c] = Math.max(min, src[i * stride + off + c] / s);
  }
  packed.set(attr, out);
  return out;
}

// Merges meshes (placed by `matrix`) into one geometry with position, normal, uv and optionally uv1 (lightmap),
// tangent, cs2Blend (the second layer's vertex paint, the exporter's _TEXCOORD_4.x) and cs2Probe (the probe light at
// each vertex, from probe(gamePos, gameNormal, out)). Only the vertices each mesh's triangles use are copied (fragments
// index into shared buffers).
let remap = new Int32Array(0), mark = new Int32Array(0), gen = 0;
function mergeMeshes(list, { lm, lmUv = 'uv1', tangents, blend = false, env = false, probe = null }) {
  let nv = 0, ni = 0;
  for (const { geo } of list) {
    const c = geo.index ? geo.index.count : geo.attributes.position.count;
    ni += c; nv += Math.min(c, geo.attributes.position.count);
  }
  let pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  let uv1 = lm ? new Float32Array(nv * 2) : null, tan = tangents ? new Float32Array(nv * 4) : null, bl = blend ? new Float32Array(nv) : null;
  let pr = probe ? new Float32Array(nv * 3) : null;
  // csgo_environment(_blend) (see addEnv): the second UV set, the vertex paint and the vertex tint.
  let eu = env ? new Float32Array(nv * 2) : null, eb = env ? new Float32Array(nv * 4) : null, et = env ? new Float32Array(nv * 4) : null;
  const gp = [0, 0, 0], gnrm = [0, 0, 1], pv = new Float32Array(3);
  const idx = new Uint32Array(ni);
  const nm = new THREE.Matrix3();
  let vo = 0, io = 0;
  for (const { geo, matrix } of list) {
    const a = geo.attributes, count = a.position.count;
    const P = floats(a.position), N = floats(a.normal), U = floats(a.uv), U1 = uv1 && floats(a[lmUv]), T = tan && floats(a.tangent);
    const B = bl && floats(a._texcoord_4), Bk = a._texcoord_4?.itemSize || 1;
    const EU = eu && floats(a.uv1), EB = eb && floats(a._texcoord_4), EBk = a._texcoord_4?.itemSize || 4, EC = et && floats(a.color), ECk = a.color?.itemSize || 4;
    const e = matrix.elements, m = nm.getNormalMatrix(matrix).elements;
    if (mark.length < count) { mark = new Int32Array(count * 2); remap = new Int32Array(count * 2); gen = 0; }
    gen++;
    const ix = geo.index ? geo.index.array : null, ic = geo.index ? geo.index.count : count;
    const flip = (matrix.determinant() < 0) !== !!geo.userData.mirrored; // a mirrored transform flips the winding
  for (let i = 0; i < ic; i++) {
      const j = flip && i % 3 ? (i % 3 === 1 ? i + 1 : i - 1) : i;
      const v = ix ? ix[j] : j;
      if (mark[v] !== gen) {
        mark[v] = gen;
        remap[v] = vo;
        const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2], o = vo * 3;
        pos[o] = e[0] * x + e[4] * y + e[8] * z + e[12];
        pos[o + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
        pos[o + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
        if (N) {
          const nx = N[v * 3], ny = N[v * 3 + 1], nz = N[v * 3 + 2];
          const X = m[0] * nx + m[3] * ny + m[6] * nz, Y = m[1] * nx + m[4] * ny + m[7] * nz, Z = m[2] * nx + m[5] * ny + m[8] * nz;
          const l = Math.hypot(X, Y, Z) || 1;
          nor[o] = X / l; nor[o + 1] = Y / l; nor[o + 2] = Z / l;
        }
        if (pr) {
          // glTF metres (Y up) to game units (Z up).
          gp[0] = pos[o + 2] / IN; gp[1] = pos[o] / IN; gp[2] = pos[o + 1] / IN;
          gnrm[0] = nor[o + 2]; gnrm[1] = nor[o]; gnrm[2] = nor[o + 1];
          probe(gp, gnrm, pv);
          pr[o] = pv[0]; pr[o + 1] = pv[1]; pr[o + 2] = pv[2];
        }
        if (U) { uv[vo * 2] = U[v * 2]; uv[vo * 2 + 1] = U[v * 2 + 1]; }
        if (U1) { uv1[vo * 2] = U1[v * 2]; uv1[vo * 2 + 1] = U1[v * 2 + 1]; }
        if (bl) bl[vo] = B ? B[v * Bk] : 0;
        if (eu) {
          if (EU) { eu[vo * 2] = EU[v * 2]; eu[vo * 2 + 1] = EU[v * 2 + 1]; }
          for (let c = 0; c < 4; c++) eb[vo * 4 + c] = EB && c < EBk ? EB[v * EBk + c] : 0;
          if (EC) for (let c = 0; c < 4; c++) et[vo * 4 + c] = c < ECk ? EC[v * ECk + c] : 1;
          else { et[vo * 4] = et[vo * 4 + 1] = et[vo * 4 + 2] = 1; et[vo * 4 + 3] = 0; }
        }
        if (tan) {
          const t = vo * 4;
          if (T) {
            const tx = T[v * 4], ty = T[v * 4 + 1], tz = T[v * 4 + 2];
            const X = e[0] * tx + e[4] * ty + e[8] * tz, Y = e[1] * tx + e[5] * ty + e[9] * tz, Z = e[2] * tx + e[6] * ty + e[10] * tz;
            const l = Math.hypot(X, Y, Z) || 1;
            tan[t] = X / l; tan[t + 1] = Y / l; tan[t + 2] = Z / l; tan[t + 3] = T[v * 4 + 3];
          } else { tan[t] = 1; tan[t + 3] = 1; }
        }
        vo++;
      }
      idx[io + i] = remap[v];
    }
    io += ic;
  }
  // Trim to the vertices actually used.
  pos = pos.slice(0, vo * 3); nor = nor.slice(0, vo * 3); uv = uv.slice(0, vo * 2);
  if (uv1) uv1 = uv1.slice(0, vo * 2);
  if (tan) tan = tan.slice(0, vo * 4);
  if (bl) bl = bl.slice(0, vo);
  if (pr) pr = pr.slice(0, vo * 3);
  if (eu) { eu = eu.slice(0, vo * 2); eb = eb.slice(0, vo * 4); et = et.slice(0, vo * 4); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (uv1) g.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
  if (tan) g.setAttribute('tangent', new THREE.BufferAttribute(tan, 4));
  if (bl) g.setAttribute('cs2Blend', new THREE.BufferAttribute(bl, 1));
  if (pr) g.setAttribute('cs2Probe', new THREE.BufferAttribute(pr, 3));
  if (eu) { g.setAttribute('cs2Uv2', new THREE.BufferAttribute(eu, 2)); g.setAttribute('cs2Env', new THREE.BufferAttribute(eb, 4)); g.setAttribute('cs2Tint', new THREE.BufferAttribute(et, 4)); }
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

// Rough centre of the triangles a mesh draws (its bounds cover the whole shared buffer).
function fragmentCenter(geo, out) {
  const P = floats(geo.attributes.position), ix = geo.index?.array, c = geo.index ? geo.index.count : geo.attributes.position.count;
  const step = Math.max(1, Math.floor(c / 64));
  let n = 0;
  out.set(0, 0, 0);
  for (let i = 0; i < c; i += step) { const v = ix ? ix[i] : i; out.x += P[v * 3]; out.y += P[v * 3 + 1]; out.z += P[v * 3 + 2]; n++; }
  return out.divideScalar(Math.max(1, n));
}

// A prop with a skeleton (a door, Nuke's vent covers and slats, Train's hanging cables...): the exporter leaves its mesh
// at the origin and puts it in place with its bones. Its vertices where its bones (at rest) put them, in world space: a
// geometry sharing everything else with the original.
const IDENTITY = new THREE.Matrix4();
function bakeSkin(o) {
  const src = o.geometry, a = src.attributes, n = a.position.count;
  const sk = o.skeleton, base = new THREE.Matrix4().multiplyMatrices(o.matrixWorld, o.bindMatrixInverse);
  const bones = sk.bones.map((b, i) => new THREE.Matrix4().multiplyMatrices(base, b.matrixWorld).multiply(sk.boneInverses[i]).multiply(o.bindMatrix));
  const P = floats(a.position), N = floats(a.normal), T = floats(a.tangent), SI = floats(a.skinIndex), SW = floats(a.skinWeight);
  const pos = new Float32Array(n * 3), nor = N && new Float32Array(n * 3), tan = T && new Float32Array(n * 4);
  const m = new THREE.Matrix4(), v = new THREE.Vector3(), e = m.elements;
  for (let i = 0; i < n; i++) {
    e.fill(0);
    for (let k = 0; k < 4; k++) {
      const w = SW ? SW[i * 4 + k] : k ? 0 : 1;
      if (!w) continue;
      const be = bones[SI ? SI[i * 4 + k] : 0]?.elements || IDENTITY.elements;
      for (let c = 0; c < 16; c++) e[c] += be[c] * w;
    }
    v.fromArray(P, i * 3).applyMatrix4(m).toArray(pos, i * 3);
    if (nor) v.fromArray(N, i * 3).transformDirection(m).toArray(nor, i * 3);
    if (tan) { v.fromArray(T, i * 4).transformDirection(m).toArray(tan, i * 4); tan[i * 4 + 3] = T[i * 4 + 3]; }
  }
  const g = new THREE.BufferGeometry();
  for (const [k, attr] of Object.entries(a)) if (k !== 'skinIndex' && k !== 'skinWeight') g.setAttribute(k, attr);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (nor) g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  if (tan) g.setAttribute('tangent', new THREE.BufferAttribute(tan, 4));
  g.setIndex(src.index);
  g.userData.mirrored = bones[0]?.determinant() < 0; // (see mergeMeshes)
  return g;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// Loads a map exported by CS2Service.playMap: { scene, sun, sunDir, ambient, bounds, dispose }.
// anisotropy: texture filtering for the world's surfaces (props get at most 4).
export async function loadWorld(map, renderer, { onProgress = () => {}, anisotropy = 8 } = {}) {
  const info = map.info;
  onProgress('Loading the map…');
  const [gltf, lightMap, sky, probeData] = await Promise.all([
    new GLTFLoader().loadAsync(map.world, (e) => e.total && onProgress(`Loading the map… ${Math.round((e.loaded / e.total) * 100)}%`)),
    map.lightmap ? loadLightmap(map.lightmap, info.lightmap.size) : null,
    map.sky ? new THREE.TextureLoader().loadAsync(map.sky) : null,
    map.probes ? fetch(map.probes).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null) : null,
  ]);
  onProgress('Building the world…');
  await tick();
  gltf.scene.updateMatrixWorld(true);
  // The second layers' textures, next to the map's glTF.
  const base = map.world.replace(/[^/]*$/, ''), layerTextures = new Map(), aniso = Math.min(anisotropy, renderer.capabilities.getMaxAnisotropy());
  const loadLayer = (file, srgb) => {
    if (!layerTextures.has(file)) {
      const t = new THREE.TextureLoader().load(base + encodeURIComponent(file));
      t.flipY = false; // glTF's texture convention
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = aniso;
      layerTextures.set(file, t);
    }
    return layerTextures.get(file);
  };
  const ambient = { sky: { value: new THREE.Color(0.42, 0.47, 0.56) }, ground: { value: new THREE.Color(0.46, 0.39, 0.31) } };
  // CS2's light probes (props, players, weapons); where no volume reaches, a sky above and ground below.
  const probes = probeData && info.lighting?.probes
    ? new ProbeField(new Uint8Array(probeData), info.lighting.probes, { up: [0.42, 0.47, 0.56].map((v) => v / Math.PI), down: [0.46, 0.39, 0.31].map((v) => v / Math.PI) })
    : null;
  // Props' vertices take the probe light of the 12-unit cell they're in (the probes are 24 units apart).
  const cells = new Map();
  // Sampled 8 units out from the surface: a vertex on (or a touch under) the ground or a wall would take a cell inside it,
  // which is black (pebbles, rubble, lily pads came out pitch black).
  const q = [0, 0, 0];
  const probeAt = probes && ((p, n, out) => {
    q[0] = p[0] + n[0] * 8; q[1] = p[1] + n[1] * 8; q[2] = p[2] + n[2] * 8;
    const key = ((Math.floor(q[0] / 12) + 2048) * 4096 + Math.floor(q[1] / 12) + 2048) * 2048 + Math.floor(q[2] / 12) + 1024;
    let cube = cells.get(key);
    if (!cube) cells.set(key, (cube = probes.cube([(Math.floor(q[0] / 12) + 0.5) * 12, (Math.floor(q[1] / 12) + 0.5) * 12, (Math.floor(q[2] / 12) + 0.5) * 12])));
    const kx = n[0] >= 0 ? 0 : 3, ky = n[1] >= 0 ? 1 : 4, kz = n[2] >= 0 ? 2 : 5, wx = n[0] * n[0], wy = n[1] * n[1], wz = n[2] * n[2];
    for (let c = 0; c < 3; c++) out[c] = cube[kx * 3 + c] * wx + cube[ky * 3 + c] * wy + cube[kz * 3 + c] * wz;
  });
  const variants = new Map(), groups = new Map(), originals = new Set(), props = [];
  const center = new THREE.Vector3();
  // Entities CS2 starts switched off (Wingman's barricades, doors and blocker walls...: see disabledNodes): left out.
  const off = new Set(info.hidden || []), offNodes = new Set();
  if (off.size) gltf.scene.traverse((o) => { const a = gltf.parser.associations.get(o); if (a?.nodes !== undefined && off.has(a.nodes)) offNodes.add(o); });
  // (A prop with a skeleton is where its bones are: see bakeSkin.)
  const placed = (o) => (o.isSkinnedMesh ? o.skeleton.bones[0] || o : o);
  const switchedOff = (o) => { for (let p = placed(o); p && offNodes.size; p = p.parent) if (offNodes.has(p)) return true; return false; };
  // Doors and breakable glass (see doorNodes, glassNodes): drawn apart from the merged world, a door on a pivot at its
  // hinge to swing, a pane on its own to break.
  const movers = new Map(); // glTF node index -> 'd<door>' | 'g<pane>'
  (info.doors || []).forEach((d, i) => d.nodes.forEach((n) => movers.set(n, 'd' + i)));
  (info.glass || []).forEach((g, i) => g.nodes.forEach((n) => movers.set(n, 'g' + i)));
  const moverObjs = new Map();
  if (movers.size) gltf.scene.traverse((o) => { const a = gltf.parser.associations.get(o); if (a?.nodes !== undefined && movers.has(a.nodes)) moverObjs.set(o, movers.get(a.nodes)); });
  const moverOf = (o) => { for (let p = placed(o); p && moverObjs.size; p = p.parent) if (moverObjs.has(p)) return moverObjs.get(p); return null; };
  gltf.scene.traverse((o) => {
    if (!o.isMesh || Array.isArray(o.material) || switchedOff(o)) return;
    const m = o.material;
    const vm = m.userData?.vmat || {};
    if (HIDDEN.test(m.name || '') || HIDDEN.test(vm.Name || '') || HIDDEN_SHADERS.test(vm.ShaderName || '')) return;
    if (BALL.test(o.name) || BALL.test(o.parent?.name || '')) { props.push(o); return; }
    const lmUv = lightmapUv(vm.ShaderName);
    const lm = !!(lightMap && o.geometry.attributes[lmUv] && LIGHTMAPPED.test(vm.ShaderName || ''));
    const key = m.uuid + (lm ? ':lm' : ':amb');
    if (!variants.has(key)) {
      const overlay = (vm.ShaderName || '').includes('static_overlay') ? vm.IntParams?.F_BLEND_MODE | 0 : -1;
      const shader = vm.ShaderName || '';
      if (overlay === 2 || overlay === 3) variants.set(key, overlayMaterial(m, vm, overlay)); // a decal that multiplies or adds: unlit
      else if (shader.includes('csgo_glass') || shader.includes('csgo_water')) variants.set(key, clearMaterial(m, vm, sky, shader.includes('csgo_water')));
      if (variants.has(key)) originals.add(m);
    }
    if (!variants.has(key)) {
      const v = m.clone();
      v.vertexColors = false; // CS2 uses vertex colours for layer blending, not tint
      v.envMap = null;
      if (v.transparent) { v.depthWrite = false; v.polygonOffset = true; v.polygonOffsetFactor = -2; v.polygonOffsetUnits = -4; }
      const layer = v.map ? layerOf(vm, info.layers || {}, loadLayer) || envOf(vm, info.layers || {}, loadLayer) : null;
      if (lm) lightmapped(v, lightMap, info.lightmap.irrMax, layer); else ambientLit(v, ambient, layer, { probe: !!probes });
      v.userData.lm = lm;
      v.userData.lmUv = lmUv;
      v.userData.layer = !!layer && layer.kind !== 'env';
      v.userData.env = layer?.kind === 'env';
      for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) if (v[k]) v[k].anisotropy = Math.max(v[k].anisotropy, lm ? aniso : Math.min(4, aniso));
      variants.set(key, v);
      originals.add(m);
    }
    const geo = o.isSkinnedMesh ? bakeSkin(o) : o.geometry, matrix = o.isSkinnedMesh ? IDENTITY : o.matrixWorld;
    fragmentCenter(geo, center).applyMatrix4(matrix);
    const cell = `${Math.floor(center.x / (CELL * IN))},${Math.floor(center.z / (CELL * IN))}`;
    const mover = moverOf(o);
    const gk = key + '|' + (mover || cell);
    if (!groups.has(gk)) groups.set(gk, { material: variants.get(key), list: [], mover });
    groups.get(gk).list.push({ geo, matrix: matrix.clone() });
  });
  const world = new THREE.Group();
  let n = 0;
  const doors = (info.doors || []).map((d) => ({ ...d, pivot: new THREE.Group(), box: new THREE.Box3() }));
  const glass = (info.glass || []).map((g) => ({ ...g, meshes: [], box: new THREE.Box3() }));
  for (const d of doors) { toGl(d.origin, d.pivot.position); world.add(d.pivot); }
  for (const { material, list, mover } of groups.values()) {
    const mesh = new THREE.Mesh(mergeMeshes(list, { lm: material.userData.lm, lmUv: material.userData.lmUv, tangents: !!material.normalMap, blend: material.userData.layer, env: material.userData.env, probe: material.userData.lm || material.userData.basic ? null : probeAt }), material);
    mesh.matrixAutoUpdate = false;
    if (material.userData.animated) mesh.onBeforeRender = () => { CS2_TIME.value = performance.now() / 1000; };
    mesh.castShadow = !material.transparent;
    mesh.receiveShadow = !material.userData.lm;
    if (mover?.[0] === 'd') {
      // On its door's pivot (the geometry is in world space: offset by the hinge), and the door's box in pivot space.
      const d = doors[+mover.slice(1)];
      mesh.geometry.translate(-d.pivot.position.x, -d.pivot.position.y, -d.pivot.position.z);
      mesh.geometry.computeBoundingBox();
      d.box.union(mesh.geometry.boundingBox);
      mesh.matrixAutoUpdate = true;
      d.pivot.add(mesh);
    } else if (mover?.[0] === 'g') {
      const g = glass[+mover.slice(1)];
      mesh.geometry.computeBoundingBox();
      g.box.union(mesh.geometry.boundingBox);
      g.meshes.push(mesh);
      world.add(mesh);
    } else world.add(mesh);
    if (++n % 200 === 0) { onProgress(`Building the world… ${Math.round((n / groups.size) * 100)}%`); await tick(); }
  }
  // The soccer ball (a physics prop, exported in place) stays a mesh of its own, to be kicked about (see props.js).
  const balls = props.map((o) => {
    const geo = o.geometry.clone().applyMatrix4(o.matrixWorld);
    geo.computeBoundingSphere();
    const c = geo.boundingSphere.center.clone();
    geo.translate(-c.x, -c.y, -c.z);
    const amb = ambientCube(), m = o.material.clone();
    m.vertexColors = false; m.envMap = null;
    ambientLit(m, { cube: amb.cube });
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.copy(c);
    mesh.castShadow = false; // the sun's shadow map is drawn once
    mesh.receiveShadow = true;
    return { mesh, spawn: fromGl(c), radius: geo.boundingSphere.radius / IN, amb };
  });
  gltf.scene.traverse((o) => o.geometry?.dispose());
  for (const m of originals) m.dispose();

  const scene = new THREE.Scene();
  scene.add(world);
  const bounds = new THREE.Box3().setFromObject(world);
  // The sun: light_environment angles give the direction the light travels.
  const s = info.sun || { angles: [50, 45, 0], color: [255, 240, 220], brightness: 2 };
  const travel = dirGl(angleDir(s.angles[0], s.angles[1]));
  // CS2's sun: the colour is sRGB (linearized), times its brightness; times PI for three's Lambert.
  const sun = new THREE.DirectionalLight(new THREE.Color().setRGB(s.color[0] / 255, s.color[1] / 255, s.color[2] / 255, THREE.SRGBColorSpace), s.brightness * Math.PI);
  // One static shadow map over the whole map, rendered once (the world doesn't move).
  const c = bounds.getCenter(new THREE.Vector3()), r = bounds.getSize(new THREE.Vector3()).length() / 2;
  sun.position.copy(c).addScaledVector(travel, -r - 10);
  sun.target.position.copy(c);
  sun.castShadow = true;
  const cam = sun.shadow.camera;
  cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r; cam.near = 1; cam.far = 2 * r + 20;
  cam.updateProjectionMatrix();
  const max = renderer.capabilities.maxTextureSize;
  sun.shadow.mapSize.set(Math.min(4096, max), Math.min(4096, max));
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);
  if (sky) {
    sky.mapping = THREE.EquirectangularReflectionMapping;
    sky.colorSpace = THREE.SRGBColorSpace;
    scene.background = sky;
  } else scene.background = new THREE.Color(0x9cc3e8);

  // The 3D skybox (see CS2Service.playSky3d): a scene of its own, at its own scale, lit by the sun and the sky; Game
  // draws it first from a camera that moves 1/scale as far as yours, then the map over it.
  let sky3d = null;
  if (map.sky3d && info.sky3d) {
    try {
      onProgress('Loading the 3D skybox…');
      const g3 = await new GLTFLoader().loadAsync(map.sky3d);
      const skyScene = new THREE.Scene(), mats = new Map();
      skyScene.background = scene.background;
      const sun3 = new THREE.DirectionalLight(sun.color, sun.intensity);
      sun3.position.copy(travel).multiplyScalar(-1);
      skyScene.add(sun3, sun3.target);
      g3.scene.traverse((o) => {
        if (!o.isMesh || Array.isArray(o.material)) return;
        const m = o.material, vm = m.userData?.vmat || {};
        if (HIDDEN.test(m.name || '') || HIDDEN.test(vm.Name || '') || HIDDEN_SHADERS.test(vm.ShaderName || '')) { o.visible = false; return; }
        if (!mats.has(m)) {
          const v = m.clone();
          v.vertexColors = false; v.envMap = null;
          v.normalMap = v.roughnessMap = v.metalnessMap = v.aoMap = null; // far away: its colour is all that shows
          v.metalness = 0; // (glTF's factor is 1 under a metalness map: all metal without it)
          if (v.transparent) v.depthWrite = false;
          ambientLit(v, ambient);
          mats.set(m, v);
        }
        o.material = mats.get(m);
        o.castShadow = o.receiveShadow = false;
      });
      skyScene.add(g3.scene);
      const t = info.sky3d;
      sky3d = { scene: skyScene, camera: new THREE.PerspectiveCamera(), origin: toGl(t.origin), offset: toGl(t.offset), scale: t.scale || 16, materials: mats };
      for (const m of mats.keys()) m.dispose();
    } catch (e) { console.warn('3D skybox unavailable:', e); }
  }

  return {
    scene, world, sun, sky, ambient, bounds, probes, balls, doors, glass, sky3d,
    sunDir: [-travel.z, -travel.x, -travel.y], // game-space direction towards the sun
    drawCalls: world.children.length,
    dispose() {
      if (sky3d) {
        sky3d.scene.traverse((o) => o.geometry?.dispose());
        for (const v of sky3d.materials.values()) { for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) v[k]?.dispose(); v.dispose(); }
      }
      for (const v of variants.values()) {
        for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) v[k]?.dispose();
        v.dispose();
      }
      world.traverse((o) => o.geometry?.dispose());
      for (const { mesh } of balls) {
        mesh.geometry.dispose();
        for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) mesh.material[k]?.dispose();
        mesh.material.dispose();
      }
      lightMap?.dispose();
      for (const t of layerTextures.values()) t.dispose();
      sky?.dispose();
      sun.shadow.map?.dispose();
    },
  };
}
