// Runs in a hidden window on the dev server (see main.cjs): renders charms through the game's real inspect and works out
// the layers charmlook.js draws them from (see there), and checks them against the real thing.
const origin = location.origin;
const THREE = await import('three');
const { loadData, D } = await import(origin + '/js/data.js');
const { inspectView: v } = await import(origin + '/js/inspect.js');
const { cs2Charm } = await import(origin + '/js/cs2/api.js');
const { PIC_W: W, PIC_H: H, hdrCode, UV_MIN, UV_SPAN, readLayers, readDetail, paintCharm } = await import(origin + '/js/charmlook.js');

const SS = 3; // renders at 3x and averages
const FW = W * SS, FH = H * SS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let rt, cam, black;
// What the charm's material puts out: x, 0 its light, 1 its colour, 2 tint mask, pearlescence and flakes, 3 its UVs,
// 4 its colour under its print, 5 its flakes' light; y, 1 z stands in for its colour (the black and white renders), 2 its
// colour's brightness does.
const ctl = { value: new THREE.Vector4() };
const OUT_LIGHT = 0, OUT_COLOUR = 1, OUT_MISC = 2, OUT_UV = 3, OUT_PLAIN = 4, OUT_FLAKES = 5;

// The params that change the lighting itself (a key per step), and the ones that move a print.
const LIGHTING = /^(g_fTextureRoughness|g_vMetalnessRemapRange|g_fGlitter|g_flIridescent)/;
const MOVES_PRINT = /^(g_vDetailTexCoord|g_flDetailTexCoord|g_fDetailBlendFactor)/;
// What charmlook.js reads, of a material's parameters.
const WANTED = /^(g_fContrast|g_fBrightness|g_fSaturation|g_fHueShift|g_flPearlescentScale|g_vDetailTexCoord|g_flDetailTexCoord|g_fDetailBlendFactor|g_bMaskDetailTextureByTintMask|g_vLiquidColor|g_flLiquidBrightness|g_flLiquidColorHueShift)/;
const KEYS = [0, 0.25, 0.5, 0.75, 1], FINE_KEYS = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1]; // the second where it comes and goes
// Below this much change across its patterns a charm keeps its Steam icon (mean difference, of 255).
const SAME_LOOK = 1;
const LEVELS = [0, 0.2, 0.4, 0.6, 0.8, 0.999]; // the lighter's fill: frac(seed x 100)

export async function ready() {
  await loadData();
  v.init();
  v.renderer.setPixelRatio(1);
  v.renderer.setSize(FW, FH, false);
  rt = new THREE.WebGLRenderTarget(FW, FH, { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true });
  cam = new THREE.PerspectiveCamera(30, 1.6, 0.05, 200);
  black = new THREE.MeshBasicMaterial({ color: 0 });
}

async function show(item) {
  v.token = null;
  await v.show(item);
  v.shadow.visible = false;
  const view = v.model.userData.view;
  v.pivot.rotation.set(view.pitch, view.yaw, 0);
  v.pivot.updateMatrixWorld(true);
  await sleep(300); // the charm's trail settles (see swingCharm)
  v.pivot.updateMatrixWorld(true);
}

// The inspect's camera, cropped to the charm.
function frame() {
  const s = v.size, fov = (30 * Math.PI) / 180;
  const fitH = s.y / 2 / Math.tan(fov / 2), fitW = s.x / 2 / Math.tan(fov / 2) / 1.6;
  const dist = Math.max(fitH, fitW) * 1.55, lift = s.y * 0.12;
  cam.position.set(0, -lift, dist);
  cam.lookAt(0, -lift, 0);
  cam.clearViewOffset();
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  const p = new THREE.Vector3();
  v.model.traverse((o) => {
    if (!o.isMesh) return;
    const n = o.geometry.attributes.position.count;
    for (let i = 0; i < n; i++) {
      o.getVertexPosition(i, p).applyMatrix4(o.matrixWorld).project(cam);
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
    }
  });
  // In a virtual 1600x1000 frame, the charm filling 92% of a 4:3 crop.
  const VW = 1600, VH = 1000;
  const px0 = ((x0 + 1) / 2) * VW, px1 = ((x1 + 1) / 2) * VW, py0 = ((1 - y1) / 2) * VH, py1 = ((1 - y0) / 2) * VH;
  const h = Math.max((py1 - py0) / 0.92, (px1 - px0) / 0.92 / (W / H)), w = h * (W / H);
  cam.setViewOffset(VW, VH, (px0 + px1) / 2 - w / 2, (py0 + py1) / 2 - h / 2, w, h);
  cam.updateProjectionMatrix();
}

// What the game shows: the real render through the real tone mapping, on a transparent background.
function truthPixels() {
  const r = v.renderer;
  r.setRenderTarget(null);
  r.setClearColor(0x000000, 0);
  r.clear();
  r.render(v.scene, cam);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(r.domElement, 0, 0, W, H);
  return g.getImageData(0, 0, W, H);
}

// One float render at full size.
function render(out, force = null) {
  ctl.value.set(out, force == null ? 0 : force === 'brightness' ? 2 : 1, force === 'brightness' ? 0 : force ?? 0, 0);
  const r = v.renderer;
  r.setRenderTarget(rt);
  r.setClearColor(0x000000, 0);
  r.clear();
  r.render(v.scene, cam);
  const px = new Float32Array(FW * FH * 4);
  r.readRenderTargetPixels(rt, 0, 0, FW, FH, px);
  r.setRenderTarget(null);
  return px;
}

// Averaged down over the samples each pixel covers, through `curve` and back (light: as the eye gets it after tone mapping,
// or the highlights on dark chrome come out far too bright). Gives [r, g, b, coverage] per pixel.
function reduce(px, code = (x) => x, uncode = (x) => x) {
  const out = new Float32Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s0 = 0, s1 = 0, s2 = 0, a = 0;
    for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) {
      const o = ((FH - 1 - (y * SS + j)) * FW + x * SS + i) * 4, w = px[o + 3];
      if (!w) continue;
      s0 += code(px[o]) * w; s1 += code(px[o + 1]) * w; s2 += code(px[o + 2]) * w; a += w;
    }
    const o = (y * W + x) * 4;
    if (a > 0) { out[o] = uncode(s0 / a); out[o + 1] = uncode(s1 / a); out[o + 2] = uncode(s2 / a); }
    out[o + 3] = a / (SS * SS);
  }
  return out;
}
// A pixel's middle sample (or any it covers), for what can't be averaged: UVs across a seam.
function pickMiddle(px) {
  const out = new Float32Array(W * H * 4), order = [[1, 1], [0, 0], [2, 2], [0, 2], [2, 0], [1, 0], [0, 1], [2, 1], [1, 2]];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (const [i, j] of order) {
    const o = ((FH - 1 - (y * SS + j)) * FW + x * SS + i) * 4;
    if (!px[o + 3]) continue;
    out.set(px.subarray(o, o + 4), (y * W + x) * 4);
    break;
  }
  return out;
}

// Light as the eye gets it: the inspect's exposure, ACES's curve and sRGB, on its own for each channel, and its inverse.
const eye = (x) => {
  x *= 1.08 / 0.6;
  const c = Math.min(1, Math.max(0, (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.432951) + 0.238081)));
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
};
const EYE_MAX = 64, EYE_STEPS = 8192;
const EYE = Float64Array.from({ length: EYE_STEPS + 1 }, (_, i) => eye((i / EYE_STEPS) ** 2 * EYE_MAX));
const unEye = (e) => {
  let lo = 0, hi = EYE_STEPS;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (EYE[m] < e) lo = m; else hi = m; }
  return (hi / EYE_STEPS) ** 2 * EYE_MAX;
};
const light = (px) => reduce(px, eye, unEye);

// The charm's pattern-driven material gets the bake's outputs; the others (its chain) don't change, so they go black in the
// passes that aren't its light.
function instrument(info) {
  const dyn = [], rest = [];
  v.model.traverse((o) => {
    if (!o.isMesh) return;
    const mi = info.materials?.[o.material?.name];
    if (mi && Object.values(mi.dynamic || {}).some((s) => /KeychainSeed/.test(s))) dyn.push(o); else rest.push(o);
  });
  if (!dyn.length) throw new Error('no pattern material');
  const fixed = rest.map((o) => o.material);
  const inst = { dyn, mi: info.materials[dyn[0].material.name], liquid: null, unlit() { rest.forEach((o) => { o.material = black; }); }, relit() { rest.forEach((o, i) => { o.material = fixed[i]; }); } };
  for (const o of dyn) {
    const m = o.material, orig = m.onBeforeCompile, key = m.customProgramCacheKey();
    if (inst.mi.shader === 'csgo_simple_liquid') {
      // Its liquid colour is what the black and white renders replace.
      m.onBeforeCompile = (shader, r) => { orig.call(m, shader, r); inst.liquid = shader.uniforms.cs2Liquid; };
      continue;
    }
    m.onBeforeCompile = (shader, r) => {
      orig.call(m, shader, r);
      shader.uniforms.bakeCtl = ctl;
      const put = (s, f) => {
        if (!shader.fragmentShader.includes(s)) throw new Error('charm shader changed: ' + s);
        shader.fragmentShader = shader.fragmentShader.replace(s, f(s));
      };
      put('uniform sampler2D cs2Rm;', (s) => `uniform vec4 bakeCtl;\nvec3 bakePlain, bakeColour, bakeFlakes = vec3(0.0), bakeFlakesLit = vec3(0.0); float bakePearl = 0.0, bakeFlake = 0.0;\n${s}`);
      put('diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * cs2Tint, cs2Mask);', (s) => `${s}\nbakePlain = diffuseColor.rgb;`);
      put('if (cs2Has.z > 0.5) diffuseColor.rgb = cs2Adj(diffuseColor.rgb, cs2Mask);', (s) => `bakeColour = diffuseColor.rgb;\n${s}\nif (bakeCtl.y > 1.5) diffuseColor.rgb = vec3(dot(bakeColour, CS2_LUM));\nelse if (bakeCtl.y > 0.5) diffuseColor.rgb = vec3(bakeCtl.z);`);
      if (m.defines.CS2_PEARL !== undefined) put('diffuseColor.rgb = cs2Hue(diffuseColor.rgb, cs2Pearl * (1.0 - dot(cs2V, normal)) * cs2Sfx);', (s) => `bakePearl = (1.0 - dot(cs2V, normal)) * cs2Sfx;\n${s}`);
      if (m.defines.CS2_GLITTER !== undefined) {
        const lit = 'cs2Sparkles = (c * 0.05 + c * normalize(max(diffuseColor.rgb, vec3(0.0003))) * 1.06 * 0.95) * g.a * max(0.0, dot(cs2V, normal)) * cs2Glit.x * cs2Sfx;';
        put(lit, (s) => `bakeFlakes = c * g.a * max(0.0, dot(cs2V, normal)) * cs2Glit.x * cs2Sfx;\n${s}\nif (bakeCtl.y > 0.5) cs2Sparkles = vec3(0.0);`);
        put('float sparkle = gi * g.a * abs(1.0 - n.z);', (s) => `${s}\nbakeFlake = sparkle;`);
        // Under a flake a dark surface brightens: charmlook.js does that, for the colour it's painting.
        const brighten = 'diffuseColor.rgb *= mix(1.0 + sparkle * 2.5, 1.0, smoothstep(0.0, 0.8, dot(diffuseColor.rgb, CS2_LUM)));';
        put(brighten, (s) => `if (bakeCtl.y < 0.5) ${s}`);
        put('totalEmissiveRadiance += cs2Sparkles * irr * RECIPROCAL_PI;', (s) => `${s}\nbakeFlakesLit = bakeFlakes * irr * RECIPROCAL_PI;`);
      }
      put('#include <dithering_fragment>', (s) => `${s}
        if (bakeCtl.x > 4.5) gl_FragColor = vec4(bakeFlakesLit, 1.0);
        else if (bakeCtl.x > 3.5) gl_FragColor = vec4(bakePlain, 1.0);
        else if (bakeCtl.x > 2.5) gl_FragColor = vec4(vMapUv, 0.0, 1.0);
        else if (bakeCtl.x > 1.5) gl_FragColor = vec4(cs2Mask, bakePearl, bakeFlake, 1.0);
        else if (bakeCtl.x > 0.5) gl_FragColor = vec4(bakeColour, 1.0);`);
    };
    m.customProgramCacheKey = () => key + 'bake';
    m.needsUpdate = true;
  }
  return inst;
}

function plane(f) {
  const out = new ImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    const c = f(i);
    out.data[i * 4] = c[0]; out.data[i * 4 + 1] = c[1]; out.data[i * 4 + 2] = c[2]; out.data[i * 4 + 3] = 255;
  }
  return out;
}
const srgb = (c) => { c = Math.min(1, Math.max(0, c)); return Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055) * 255); };
const code8 = (x) => Math.min(255, Math.round(hdrCode(x)));

// A and B (and flakes) for the model on show. `colour`: its samples' colours. A pixel's samples are averaged as the eye gets
// them: what's left for A is what brings that pixel's own colour to that average (averaging A and B apart comes out too
// bright on metals, where nearly all of a pixel is A).
function lightPlanes(inst, glitter, colour, misc) {
  const force = (c) => {
    if (inst.liquid) inst.liquid.value.set(c, c, c);
    return render(OUT_LIGHT, inst.liquid ? null : c);
  };
  const white = force(1), dark = force(0), level = colour ? render(OUT_LIGHT, 'brightness') : null;
  const diff = new Float32Array(white.length), whole = new Float32Array(white.length);
  let flakes = null;
  if (glitter) {
    inst.unlit();
    flakes = render(OUT_FLAKES);
    inst.relit();
  }
  const tone = (d, k) => 0.05 + Math.max(d, 0.0003) * k; // what a flake takes from the surface (charmlook.js)
  const boost = (d, flake) => { // what a flake does to a dark surface
    const s = Math.min(1, (0.2125 * d[0] + 0.7154 * d[1] + 0.0721 * d[2]) / 0.8);
    return 1 + flake * 2.5 * (1 - s * s * (3 - 2 * s));
  };
  const norm = (r, g, b) => 1.007 / Math.hypot(Math.max(r, 0.0003), Math.max(g, 0.0003), Math.max(b, 0.0003));
  for (let i = 0; i < diff.length; i += 4) {
    const d = colour ? [colour[i], colour[i + 1], colour[i + 2]] : [1, 1, 1], k = norm(...d);
    const y = colour ? 0.2125 * d[0] + 0.7154 * d[1] + 0.0721 * d[2] : 0, up = flakes ? boost(d, misc[i + 2]) : 1;
    for (let c = 0; c < 3; c++) {
      // Light isn't quite linear in a metal's colour (three's multiple scattering): measured from black to this surface's
      // own brightness, where it counts, else to white.
      diff[i + c] = Math.max(0, y > 0.02 ? (level[i + c] - dark[i + c]) / y : white[i + c] - dark[i + c]);
      whole[i + c] = dark[i + c] + diff[i + c] * d[c] * up + (flakes ? flakes[i + c] * tone(d[c], k) : 0);
    }
    diff[i + 3] = whole[i + 3] = white[i + 3];
  }
  const A = light(diff), B = light(dark), S = flakes ? light(flakes) : null, T = light(whole), C = colour ? reduce(colour) : null, M = flakes ? reduce(misc) : null;
  for (let i = 0; i < A.length; i += 4) {
    const d = C ? [C[i], C[i + 1], C[i + 2]] : [1, 1, 1], k = norm(...d), up = M ? boost(d, M[i + 2]) : 1;
    for (let c = 0; c < 3; c++) if (d[c] > 0.02) A[i + c] = Math.max(0, (T[i + c] - B[i + c] - (S ? S[i + c] * tone(d[c], k) : 0)) / (d[c] * up));
  }
  const out = [plane((i) => [code8(A[i * 4]), code8(A[i * 4 + 1]), code8(A[i * 4 + 2])]), plane((i) => [code8(B[i * 4]), code8(B[i * 4 + 1]), code8(B[i * 4 + 2])])];
  if (S) out.push(plane((i) => [code8(S[i * 4]), code8(S[i * 4 + 1]), code8(S[i * 4 + 2])]));
  return out;
}

// A print's colours. Its file's alpha is 0 almost everywhere (the shader never reads it), which a 2D canvas would multiply
// into the colour; WebGL hands them over as they are, and they're kept opaque.
async function printPixels(url) {
  const bitmap = await createImageBitmap(await (await fetch(url)).blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const gl = document.createElement('canvas').getContext('webgl2'), w = bitmap.width, h = bitmap.height;
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
  gl.bindFramebuffer(gl.FRAMEBUFFER, gl.createFramebuffer());
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, gl.getParameter(gl.TEXTURE_BINDING_2D), 0);
  const out = new ImageData(w, h);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out.data);
  for (let i = 3; i < out.data.length; i += 4) out.data[i] = 255;
  return out;
}

// Charms' results, kept for compare().
const baked = new Map();

export async function layers({ id }) {
  const def = D.charms[id], info = await cs2Charm(def.mdl, def.mat || null);
  await show({ t: 'charm', id, pat: 50000 });
  frame();
  let inst = instrument(info);
  const mi = inst.mi, dyn = mi.dynamic || {}, f = mi.flags || {}, t = mi.textures || {}, isLiquid = mi.shader === 'csgo_simple_liquid';
  const sfx = !!(f.F_ENABLE_SFX_MASK && t.rm);
  const param = (k) => mi.params[k] || dyn[k];
  const glitter = sfx && !!f.F_GLITTER && !!t.glitter && !!param('g_fGlitterIntensity');
  const pearl = sfx && !!param('g_flPearlescentScale');
  const keyed = Object.keys(dyn).some((k) => LIGHTING.test(k) && /KeychainSeed/.test(dyn[k]));
  const prints = !!t.detail && Object.keys(dyn).some((k) => MOVES_PRINT.test(k));
  const look = { adjust: !!f.F_ENABLE_ADJUSTMENTS };
  if (pearl) look.pearl = 1;
  if (glitter) look.glitter = 1;
  if (isLiquid) { look.liquid = 1; look.keys = LEVELS; look.keyBy = dyn.g_flLiquidLevelHeight.replace(/lerp\(.*?,.*?,(.*)\)/, '$1'); look.keyNearest = 1; } else if (keyed) look.keys = Object.entries(dyn).some(([k, e]) => LIGHTING.test(k) && /cos|sin|frac/.test(e)) ? FINE_KEYS : KEYS;
  look.params = Object.fromEntries(Object.entries(mi.params).filter(([k]) => WANTED.test(k)));
  look.dynamic = Object.fromEntries(Object.entries(dyn).filter(([k]) => WANTED.test(k)));

  // Warm the model's program, then the colour and its masks: they don't change with the pattern.
  render(OUT_LIGHT);
  inst.unlit();
  const colour = reduce(render(prints ? OUT_PLAIN : OUT_COLOUR)), seen = isLiquid ? null : render(OUT_COLOUR);
  const miscPx = render(OUT_MISC), misc = reduce(miscPx);
  const uvPx = prints ? pickMiddle(render(OUT_UV)) : null;
  inst.relit();
  const planes = [
    plane((i) => (isLiquid ? [255, 255, 255] : [srgb(colour[i * 4]), srgb(colour[i * 4 + 1]), srgb(colour[i * 4 + 2])])),
    plane((i) => [Math.round(misc[i * 4 + 3] * 255), Math.round(Math.min(1, misc[i * 4]) * 255), Math.round(Math.min(1, misc[i * 4 + 1]) * 255)]),
  ];
  if (glitter) planes.push(plane((i) => [Math.round(Math.min(1, misc[i * 4 + 2]) * 255), 0, 0]));
  for (const seed of look.keys || [null]) {
    if (seed != null) {
      await show({ t: 'charm', id, pat: Math.round((isLiquid ? seed / 100 : seed) * 100000) });
      frame();
      inst = instrument(info);
      render(OUT_LIGHT);
    }
    planes.push(...lightPlanes(inst, glitter, seen, miscPx));
  }
  if (prints) {
    const code = (x) => Math.max(0, Math.min(65535, Math.round(((x - UV_MIN) / UV_SPAN) * 65535)));
    planes.push(plane((i) => { const c = code(uvPx[i * 4]); return [c >> 8, c & 255, 0]; }));
    planes.push(plane((i) => { const c = code(uvPx[i * 4 + 1]); return [c >> 8, c & 255, 0]; }));
    // How far a pixel steps across the print's texture, for its filtering.
    const steps = [];
    for (let y = 1; y < H; y += 5) for (let x = 1; x < W; x += 5) {
      const a = (y * W + x) * 4, b = a + 4;
      if (uvPx[a + 3] && uvPx[b + 3]) steps.push(Math.hypot(uvPx[a] - uvPx[b], uvPx[a + 1] - uvPx[b + 1]));
    }
    steps.sort((p, q) => p - q);
    look.detail = { uvPerPixel: +steps[steps.length >> 1].toFixed(5), replaces: !!f.F_DETAIL_TEXTURE };
  }
  const sheet = document.createElement('canvas');
  sheet.width = W; sheet.height = H * planes.length;
  const g = sheet.getContext('2d', { willReadFrequently: true });
  planes.forEach((p, i) => g.putImageData(p, 0, H * i));
  const file = sheet.toDataURL('image/webp', 1);
  const files = { [`${id}.webp`]: file };
  let print = null;
  if (prints) {
    const px = await printPixels(t.detail), c = document.createElement('canvas');
    c.width = px.width; c.height = px.height;
    c.getContext('2d').putImageData(px, 0, 0);
    files[`${id}-print.webp`] = c.toDataURL('image/webp', 1);
    print = readDetail(px.data, px.width, px.height);
  }
  // Read back from the file itself, so a check of it is a check of what ships.
  const back = new Image();
  back.src = file;
  await back.decode();
  const bc = document.createElement('canvas');
  bc.width = back.naturalWidth; bc.height = back.naturalHeight;
  const bg = bc.getContext('2d', { willReadFrequently: true });
  bg.drawImage(back, 0, 0);
  const rgba = bg.getImageData(0, 0, bc.width, bc.height).data, was = g.getImageData(0, 0, sheet.width, sheet.height).data;
  let differ = 0;
  for (let i = 0; i < rgba.length; i++) if (rgba[i] !== was[i]) differ++;
  if (differ) throw new Error(`${id}: the sheet didn't survive its file (${differ} bytes differ)`);
  const layer = readLayers(rgba, look);
  baked.set(id, { layer, look, print });
  // How much it changes across its patterns: most from the first to any other.
  const at = (pat) => paintCharm(layer, look, pat, new Uint8ClampedArray(W * H * 4), print);
  const first = at(1);
  let change = 0;
  for (const pat of [12500, 25000, 37500, 50000, 62500, 75000, 87500, 100000]) {
    const p = at(pat);
    let sum = 0;
    for (let k = 0; k < layer.n; k++) { const o = layer.at[k] * 4; sum += (Math.abs(p[o] - first[o]) + Math.abs(p[o + 1] - first[o + 1]) + Math.abs(p[o + 2] - first[o + 2])) / 3; }
    change = Math.max(change, sum / layer.n);
  }
  const same = change < SAME_LOOK;
  return { files: same ? {} : files, look: same ? null : look, log: `layers ${id} ${def.n}: ${((file.length * 0.75) / 1024) | 0}KB, ${planes.length} planes, changes ${change.toFixed(1)}${same ? ' KEEPS ITS ICON' : ''} ${JSON.stringify({ ...look, params: undefined, dynamic: undefined })}` };
}

// The real 3D charm against the layers at these patterns: pictures side by side and how far apart they are.
export async function compare({ id, pats, keep = true }) {
  const { layer, look, print } = baked.get(id);
  const row = document.createElement('canvas');
  row.width = W * 2 * pats.length; row.height = H;
  const g = row.getContext('2d');
  g.fillStyle = '#23262b'; g.fillRect(0, 0, row.width, row.height);
  const tile = document.createElement('canvas'); tile.width = W; tile.height = H;
  const tg = tile.getContext('2d');
  const lines = [];
  for (let k = 0; k < pats.length; k++) {
    const pat = pats[k];
    await show({ t: 'charm', id, pat });
    frame();
    const truth = truthPixels();
    const t0 = performance.now();
    const px = new ImageData(W, H);
    paintCharm(layer, look, pat, px.data, print);
    const ms = performance.now() - t0;
    let sum = 0, cnt = 0, big = 0;
    const sumC = [0, 0, 0], sumT = [0, 0, 0];
    for (let i = 0; i < W * H; i++) {
      if (truth.data[i * 4 + 3] < 250 || px.data[i * 4 + 3] < 250) continue;
      const d = (Math.abs(truth.data[i * 4] - px.data[i * 4]) + Math.abs(truth.data[i * 4 + 1] - px.data[i * 4 + 1]) + Math.abs(truth.data[i * 4 + 2] - px.data[i * 4 + 2])) / 3;
      sum += d; cnt++; if (d > 12) big++;
      for (let c = 0; c < 3; c++) { sumC[c] += px.data[i * 4 + c]; sumT[c] += truth.data[i * 4 + c]; }
    }
    lines.push(`  #${pat}: mean err ${(sum / cnt).toFixed(2)}/255, ${((big / cnt) * 100).toFixed(1)}% px over 12, paint ${ms.toFixed(1)}ms, avg truth ${sumT.map((s) => (s / cnt) | 0)} vs ${sumC.map((s) => (s / cnt) | 0)}`);
    tg.clearRect(0, 0, W, H); tg.putImageData(truth, 0, 0); g.drawImage(tile, k * 2 * W, 0);
    tg.clearRect(0, 0, W, H); tg.putImageData(px, 0, 0); g.drawImage(tile, (k * 2 + 1) * W, 0);
  }
  return { files: keep ? { [`cmp-${id}.png`]: row.toDataURL('image/png') } : {}, log: `compare ${id} ${D.charms[id].n}\n${lines.join('\n')}` };
}
