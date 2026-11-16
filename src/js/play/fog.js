// CS2's fog: env_cubemap_fog (the sky's own colour, blurred, over what's far off: the haze that melts the scenery round
// a map into its sky) and env_gradient_fog (a colour of its own: Inferno's and Vertigo's blue distance, Train's grey).
// Each is a distance curve, nothing at its start distance to its most at its end, shaped by its falloff exponent, times
// a height curve when it has one (all of it at its start height, none at its end height, shaped by its exponent).
// The map is fogged in the post pass from its depth (post.js); the 3D skybox, which that depth doesn't hold, in its own
// materials, at the distance it stands for (its own times its scale). Both share these uniforms, so they match.
// The map's fog comes from its entities (cs2/play.cjs mapFog): { cube, gradient }, either null.
import * as THREE from 'three';

const IN = 0.0254;

// The fog's uniforms for a map: fog (info.fog), sky (its texture, equirectangular, or null), skyBrightness.
export function fogUniforms(fog, sky, skyBrightness = 1) {
  const curve = (f) => new THREE.Vector4(f.start, 1 / Math.max(1, f.end - f.start), Math.max(0.01, f.falloff), Math.min(1, Math.max(0, f.maxOpacity)));
  // (Height: (z - end) / (start - end), all of it at the start height; none when there's no height fog.)
  const height = (f) => (f.height && f.heightStart !== f.heightEnd ? new THREE.Vector4(f.heightEnd, 1 / (f.heightStart - f.heightEnd), Math.max(0.01, f.heightExponent), 1) : new THREE.Vector4(0, 0, 1, 0));
  const off = { start: 0, end: 1, falloff: 1, maxOpacity: 0 };
  const cube = fog?.cube && sky ? fog.cube : null, grad = fog?.gradient || null;
  const width = sky?.image?.width || 1024;
  const c = grad?.color || [0, 0, 0];
  return {
    fogCubeOn: { value: !!cube }, fogCube: { value: curve(cube || off) }, fogCubeH: { value: height(cube || {}) },
    // The sky blurred, as CS2's does it: the blurriest mip (three above one texel, of a cube face a quarter of the
    // equirectangular sky's width) where the fog is thin, sharper as it thickens, by the lod bias.
    fogSky: { value: cube ? sky : null }, fogSkyLod: { value: new THREE.Vector2(Math.max(0, Math.log2(width / 4) - 3), Math.max(0, cube?.lodBias ?? 0)) }, fogSkyBright: { value: skyBrightness },
    fogGradOn: { value: !!grad }, fogGrad: { value: curve(grad || off) }, fogGradH: { value: height(grad || {}) },
    fogGradColor: { value: new THREE.Color().setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace).multiplyScalar(grad?.strength ?? 1) },
    fogCam: { value: new THREE.Vector3() }, // the camera, glTF metres (set each frame)
  };
}

// The fog, as GLSL: applyFog(colour, the point (glTF metres), where it's seen from) -> the colour fogged.
export const FOG_GLSL = /* glsl */ `
uniform bool fogCubeOn, fogGradOn;
uniform vec4 fogCube, fogCubeH, fogGrad, fogGradH;
uniform sampler2D fogSky;
uniform vec2 fogSkyLod;
uniform float fogSkyBright;
uniform vec3 fogGradColor;
uniform vec3 fogCam;
// How thick (0-1, before the most it covers): the distance term times the height term.
float fogPart(float d, float z, vec4 p, vec4 h) {
  float f = pow(clamp((d - p.x) * p.y, 0.0001, 1.0), p.z);
  if (h.w > 0.5) f *= pow(clamp((z - h.x) * h.y, 0.0001, 1.0), h.z);
  return f;
}
vec3 applyFog(vec3 col, vec3 at) {
  vec3 dv = at - fogCam;
  float len = length(dv), d = len / ${IN}, z = at.y / ${IN};
  if (fogGradOn) col = mix(col, fogGradColor, fogPart(d, z, fogGrad, fogGradH) * fogGrad.w);
  if (fogCubeOn) {
    vec3 dir = dv / max(len, 1e-5);
    vec2 uv = vec2(atan(dir.z, dir.x) * 0.1591549 + 0.5, asin(clamp(dir.y, -1.0, 1.0)) * 0.3183099 + 0.5);
    float f = fogPart(d, z, fogCube, fogCubeH);
    float lod = clamp(1.0 - f * fogSkyLod.y, 0.0, 1.0) * fogSkyLod.x;
    col = mix(col, textureLod(fogSky, uv, lod).rgb * fogSkyBright, f * fogCube.w);
  }
  return col;
}`;

// The 3D skybox's materials fogged where what they draw stands in for (the skybox's point back in the map: (p - its
// camera's origin) * scale + the reference's offset). sky3d: { origin, offset, scale } (glTF).
export function fogSkyMaterials(scene, uniforms, sky3d) {
  const done = new Set();
  const extra = { ...uniforms, fogOrigin: { value: sky3d.origin.clone() }, fogOffset: { value: sky3d.offset.clone() }, fogScale: { value: sky3d.scale } };
  scene.traverse((o) => {
    for (const m of [].concat(o.material || [])) {
      if (!m || done.has(m)) continue;
      done.add(m);
      // (Its own key; three's default is the onBeforeCompile's source, which is about to be this one's for all: that
      // one as it is now.)
      const before = m.onBeforeCompile, own = m.customProgramCacheKey, plain = own === THREE.Material.prototype.customProgramCacheKey, was = plain ? own.call(m) : '';
      m.onBeforeCompile = (sh, r) => {
        before?.call(m, sh, r);
        Object.assign(sh.uniforms, extra);
        sh.vertexShader = 'varying vec3 vFogAt;\n' + sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n\tvFogAt = (modelMatrix * vec4(transformed, 1.0)).xyz;');
        sh.fragmentShader = 'varying vec3 vFogAt;\nuniform vec3 fogOrigin, fogOffset;\nuniform float fogScale;\n' + FOG_GLSL + '\n' + sh.fragmentShader
          .replace('#include <fog_fragment>', '#include <fog_fragment>\n\tgl_FragColor.rgb = applyFog(gl_FragColor.rgb, (vFogAt - fogOrigin) * fogScale + fogOffset);');
      };
      m.customProgramCacheKey = () => (plain ? was : own.call(m)) + '|fog3d';
      m.needsUpdate = true;
    }
  });
}
