// Play mode: turns a CS2 map from the player's install into what the renderer needs to walk around it and shoot:
// the render world (glTF), a collision mesh, CS2's baked lighting, the sky, and the map's gameplay entities (spawns,
// bomb sites, buy zones, callout areas). Also reads weapon stats (weapons.vdata) and sound events.
const fs = require('fs');
const path = require('path');
const { parseEntities } = require('./vanity.cjs');
const { parseKV3 } = require('./kv.cjs');
const { readEXR } = require('./exr.cjs');
const { decodePNG, encodePNG } = require('./png.cjs');

const IN = 0.0254; // the exporter writes game inches as metres
const PLAY_VERSION = 10; // map exports (2: texture layers, sharper textures, non-solid brushes left out; 3: sun mask, probes, grading;
// 4: entities that start switched off left out, trigger_hurt volumes; 5: csgo_environment(_blend)'s other layers and height maps;
// 6: doors and breakable glass; 7: the 3D skybox; 8: no texture over 1024 after it; 9: breakable props too; 10: props named
// breakable (Mirage's vent covers) and what's left of a breakable once broken (Mirage's shutter frame))
const PROBE_MAX = 8; // probe irradiance is stored as 8-bit sRGB of value / PROBE_MAX
const DATA_VERSION = 6; // weapon stats + sound events (6: maps' ambience sounds, every surface's bullet impact sound)
// Collision flags per triangle: what it stops.
const F_PLAYER = 1, F_BULLET = 2, F_GRENADE = 4;
// The irradiance lightmap is stored as 8-bit sRGB of value / IRR_MAX.
const IRR_MAX = 4;
const LIGHTMAP_SIZE = 4096;

const vec = (s) => (s || '').replace(/[[\]]/g, '').trim().split(/[\s,]+/).filter(Boolean).map(Number);

// ---- glTF reading ---------------------------------------------------------------------------
function readGlb(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a glb: ' + file);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
  const binStart = 20 + jsonLen + 8;
  return { json, bin: buf.subarray(binStart, binStart + buf.readUInt32LE(20 + jsonLen)) };
}

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const TYPES = { 5126: [Float32Array, 4], 5125: [Uint32Array, 4], 5123: [Uint16Array, 2], 5121: [Uint8Array, 1] };
function accessor({ json, bin }, i) {
  const a = json.accessors[i], view = json.bufferViews[a.bufferView];
  const [T, size] = TYPES[a.componentType];
  const n = COMPONENTS[a.type], stride = view.byteStride || n * size;
  const start = (view.byteOffset || 0) + (a.byteOffset || 0);
  const out = new T(a.count * n);
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const get = { 5126: (o) => dv.getFloat32(o, true), 5125: (o) => dv.getUint32(o, true), 5123: (o) => dv.getUint16(o, true), 5121: (o) => dv.getUint8(o) }[a.componentType];
  for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) out[k * n + c] = get(start + k * stride + c * size);
  return out;
}

function nodeMatrix(n) {
  if (n.matrix) return n.matrix;
  const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  if (n.translation) [m[12], m[13], m[14]] = n.translation;
  return m;
}

// A mesh's triangles in game units (Z up), 9 floats per triangle, placed by the node's matrix.
function meshTriangles(glb, meshIndex, m) {
  const parts = [];
  for (const p of glb.json.meshes[meshIndex].primitives) {
    if (p.mode !== undefined && p.mode !== 4) continue;
    const pos = accessor(glb, p.attributes.POSITION);
    const idx = p.indices !== undefined ? accessor(glb, p.indices) : Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);
    const out = new Float32Array(idx.length * 3);
    for (let i = 0; i < idx.length; i++) {
      const x = pos[idx[i] * 3], y = pos[idx[i] * 3 + 1], z = pos[idx[i] * 3 + 2];
      const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
      const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
      const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
      out[i * 3] = wz / IN; out[i * 3 + 1] = wx / IN; out[i * 3 + 2] = wy / IN; // glTF (y, z, x) -> game (x, y, z)
    }
    parts.push(out);
  }
  const all = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  return all;
}

const bounds = (tris) => {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i += 3) for (let c = 0; c < 3; c++) { min[c] = Math.min(min[c], tris[i + c]); max[c] = Math.max(max[c], tris[i + c]); }
  return { min: min.map((v) => Math.round(v)), max: max.map((v) => Math.round(v)) };
};

// What a physics group stops, from its collision group and "interact as" tags.
function collisionFlags(extras = {}) {
  const group = String(extras.CollisionGroup || '').toLowerCase();
  const as = (extras.InteractAs || []).map((s) => String(s).toLowerCase());
  if (as.includes('sky')) return 0;
  if (group === 'default') return F_PLAYER | F_BULLET | F_GRENADE;
  if (as.includes('passbullets')) return F_PLAYER | F_GRENADE; // chain-link fences, pottery
  if (as.includes('playerclip')) return F_PLAYER;
  if (as.includes('csgo_grenadeclip')) return F_GRENADE;
  return 0;
}

// Whether a func_brush blocks: its Solidity (0: solid while enabled, 1: never, 2: always) and whether it starts
// disabled (Retakes' blockers on Mirage, for one, are switched on by that mode only).
function brushSolid(e) {
  const solidity = String(e.solidity ?? '0');
  if (solidity === '1') return false;
  return solidity === '2' || !/^(true|1)$/i.test(String(e.startdisabled ?? ''));
}

// collision.bin: triangle positions (Float32 x9 each), then one flags byte and one surface byte per triangle.
// ents: the map's entities (to leave out brushes that don't block).
function buildCollision(worldPhys, entityPhys, ents = []) {
  const surfaces = [];
  const parts = [];
  const add = (glb, node, flags) => {
    if (!flags || node.mesh === undefined) return;
    const tris = meshTriangles(glb, node.mesh, nodeMatrix(node));
    const s = String(node.extras?.SurfaceProperty || 'default');
    if (!surfaces.includes(s)) surfaces.push(s);
    parts.push({ tris, flags, surface: surfaces.indexOf(s) });
  };
  for (const n of worldPhys.json.nodes) add(worldPhys, n, collisionFlags(n.extras));
  // Brush entities that are solid (doors and planks built as func_brush). The export names their physics by class
  // only; the node sits at its entity's origin.
  const brushes = ents.filter((e) => e.classname === 'func_brush').map((e) => ({ e, o: vec(e.origin) }));
  if (entityPhys) for (const n of entityPhys.json.nodes) {
    if (n.name !== 'func_brush') continue;
    const m = nodeMatrix(n), o = [m[14] / IN, m[12] / IN, m[13] / IN];
    let best = null, bd = 4;
    for (const b of brushes) { const d = Math.hypot(b.o[0] - o[0], b.o[1] - o[1], b.o[2] - o[2]); if (d < bd) { bd = d; best = b.e; } }
    if (!best || brushSolid(best)) add(entityPhys, n, F_PLAYER | F_BULLET | F_GRENADE);
  }
  const count = parts.reduce((s, p) => s + p.tris.length / 9, 0);
  const buf = Buffer.alloc(count * 38);
  const pos = new Float32Array(buf.buffer, buf.byteOffset, count * 9);
  let t = 0;
  for (const p of parts) {
    pos.set(p.tris, t * 9);
    const n = p.tris.length / 9;
    buf.fill(p.flags, count * 36 + t, count * 36 + t + n);
    buf.fill(p.surface, count * 37 + t, count * 37 + t + n);
    t += n;
  }
  return { buf, tris: count, surfaces };
}

// Entities CS2 starts switched off, for a game mode to switch on (Wingman's barricades, doors and blocker walls on
// Vertigo, Nuke, Overpass and Inferno; Retakes' blockers): the glTF nodes of their models, to leave out of the drawn
// world (their collision is left out by brushSolid). A brush entity's nodes are named after its model
// ("<model>.hammer_mesh_0"); a prop's after its model too, at the entity's origin.
function disabledNodes(json, ents) {
  const brushes = new Set(), props = [];
  for (const e of ents) {
    if (!/^(true|1)$/i.test(String(e.startdisabled ?? '')) || !e.model) continue;
    const base = String(e.model).replace(/^resource_name:"?|"$/g, '').replace(/.*\//, '').replace(/\.vmdl$/, '');
    if (/^func_/.test(e.classname)) brushes.add(base); else props.push({ base, o: vec(e.origin) });
  }
  const out = [];
  (json.nodes || []).forEach((n, i) => {
    const base = String(n.name || '').split('.')[0];
    if (brushes.has(base)) { out.push(i); return; }
    const near = props.filter((p) => p.base === base);
    if (!near.length) return;
    const m = nodeMatrix(n), o = [m[14] / IN, m[12] / IN, m[13] / IN];
    if (near.some((p) => Math.hypot(p.o[0] - o[0], p.o[1] - o[1], p.o[2] - o[2]) < 2)) out.push(i);
  });
  return out;
}

// The glTF nodes of an entity's model: a brush entity's are named after its model ("<model>.hammer_mesh_0"), a prop's
// after its model too, at the entity's origin.
function entityNodes(json) {
  const byName = new Map();
  (json.nodes || []).forEach((n, i) => { const k = String(n.name || '').split('.')[0]; if (!byName.has(k)) byName.set(k, []); byName.get(k).push(i); });
  const base = (e) => String(e.model || '').replace(/^resource_name:"?|"$/g, '').replace(/.*\//, '').replace(/\.vmdl$/, '');
  return {
    brush: (e) => byName.get(base(e)) || [],
    prop: (e) => (byName.get(base(e)) || []).filter((i) => {
      const m = nodeMatrix(json.nodes[i]), o = vec(e.origin);
      return Math.hypot(m[14] / IN - o[0], m[12] / IN - o[1], m[13] / IN - o[2]) < 2;
    }),
  };
}

// Doors that swing open: prop_door_rotating, and func_door_rotating with the props on it (Vertigo's portable toilets).
// Each: its glTF nodes, where it hinges (its origin), how far (degrees) and fast it swings, how long it stays open
// (-1: until closed), whether it opens away from whoever uses it, and its sounds.
function doorNodes(json, ents) {
  const find = entityNodes(json), out = [];
  for (const e of ents) {
    if (e.classname !== 'prop_door_rotating' && e.classname !== 'func_door_rotating') continue;
    const prop = e.classname === 'prop_door_rotating';
    const nodes = prop ? find.prop(e) : [...find.brush(e), ...ents.filter((c) => c.parentname && c.parentname === e.targetname && c.model).flatMap(find.prop)];
    if (!nodes.length) continue;
    out.push({
      nodes, origin: vec(e.origin), distance: +e.distance || 90, speed: +e.speed || 100,
      wait: prop ? +(e.returndelay ?? -1) : +(e.wait ?? 4), away: prop && String(e.opendir ?? '0') === '0', reverse: !prop && !!((+e.spawnflags || 0) & 2),
      sounds: prop ? { open: e.soundopenoverride || '', close: e.soundcloseoverride || '', move: e.soundmoveoverride || '' } : { open: e.noise2 || '', close: e.noise2 || '', move: e.noise1 || '' },
    });
  }
  return out;
}

// Things a bullet breaks: breakable glass (func_breakable of glass, material 0) and the props whose model (or name) is a
// breakable piece (Inferno's and Poseidon's shop windows, Train's windows and cabinet doors, Nuke's vent covers, Mirage's
// shutter and its sheet metal vent covers, bottles, pots...). Each: its glTF nodes, what it's made of (the impact
// surface), its break sound, whether it stops players (a bottle or a plant doesn't, only bullets), and the nodes of
// what's left once it's broken (remainder: props that start switched off beside it, Mirage's shutter frame).
const BREAKS = [
  [/wood|shutter|crate|fence/i, 'wood', 'Wood_Panel.Break', true], // (before glass: Mirage's shutter_window_l_breakable)
  [/glass|window/i, 'glass', 'Glass.Break', true],
  [/bottle/i, 'glassbottle', 'GlassBottle.Break', false],
  [/vent|enclosure|metal/i, 'metalvent', 'Metal_Box.Break', true],
  [/vase|pot|planter/i, 'pottery', 'Pottery.Break', false],
  [/./, 'default', 'Wood.Break', false],
];
function glassNodes(json, ents) {
  const find = entityNodes(json), out = [];
  for (const e of ents) {
    if (!e.model || /^(true|1)$/i.test(String(e.startdisabled ?? ''))) continue;
    const model = String(e.model).replace(/^resource_name:"?|"$/g, '').replace(/.*\//, '').replace(/\.vmdl$/, '');
    let nodes, kind;
    if (e.classname === 'func_breakable' && String(e.material ?? '0') === '0') { nodes = find.brush(e); kind = BREAKS.find((k) => k[1] === 'glass'); }
    else if (/^prop_(dynamic|physics)/.test(e.classname) && (/breakable/i.test(model) || /breakable/i.test(String(e.targetname || '')))) { nodes = find.prop(e); kind = BREAKS.find(([re]) => re.test(model)); }
    else continue;
    if (nodes.length) out.push({ nodes, health: +e.health || 1, surface: kind[1], sound: kind[2], solid: kind[3], origin: vec(e.origin), remainder: [] });
  }
  for (const e of ents) {
    if (!/^prop_dynamic/.test(e.classname) || !/^(true|1)$/i.test(String(e.startdisabled ?? '')) || !/remainder/i.test(String(e.model || ''))) continue;
    const o = vec(e.origin), near = out.filter((g) => g.origin.length === 3 && Math.hypot(g.origin[0] - o[0], g.origin[1] - o[1], g.origin[2] - o[2]) < 160)
      .sort((a, b) => Math.hypot(a.origin[0] - o[0], a.origin[1] - o[1]) - Math.hypot(b.origin[0] - o[0], b.origin[1] - o[1]))[0];
    if (near) near.remainder.push(...find.prop(e));
  }
  return out;
}

// Every surface's bullet impact sound (surfaceproperties.vsurf): { surface (lower case): sound event }. Inferno's
// church bells ring when shot this way (brass_bell_large: inferno.bell_c).
function surfaceImpacts(text) {
  const out = {};
  for (const block of String(text).split(/surfacePropertyName\s*=\s*/).slice(1)) {
    const name = block.match(/^"([^"]+)"/)?.[1], hit = block.match(/bulletimpact\s*=\s*"([^"]+)"/)?.[1];
    if (name && hit) out[name.toLowerCase()] = hit;
  }
  return out;
}

// A trigger_hurt's volume (game units) from its brush model's physics (in the model's own space, round the entity's
// origin): { min, max, damage } (damage a second).
function hurtVolume(glb, origin, damage) {
  const tris = [];
  for (const n of glb.json.nodes) if (n.mesh !== undefined) tris.push(...meshTriangles(glb, n.mesh, nodeMatrix(n)));
  if (!tris.length) return null;
  const b = bounds(tris), o = vec(origin);
  return { min: b.min.map((v, i) => v + (o[i] || 0)), max: b.max.map((v, i) => v + (o[i] || 0)), damage };
}

// Gameplay volumes (bomb sites, buy zones, callout areas) as boxes in game units, named from the entity lump.
function gameVolumes(entityPhys, ents) {
  const out = { bombsites: [], buyzones: [], places: [] };
  if (!entityPhys) return out;
  const spawnsOf = (cls) => ents.filter((e) => e.classname === cls).map((e) => vec(e.origin));
  const centroid = (pts) => pts.length ? [0, 1, 2].map((c) => pts.reduce((s, p) => s + p[c], 0) / pts.length) : null;
  const tCenter = centroid(spawnsOf('info_player_terrorist')), ctCenter = centroid(spawnsOf('info_player_counterterrorist'));
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const placeEnts = ents.filter((e) => e.classname === 'env_cs_place');
  const sitePlaces = (s) => placeEnts.filter((e) => new RegExp('bombsite' + s, 'i').test(e.place_name || '')).map((e) => vec(e.origin));
  for (const n of entityPhys.json.nodes) {
    if (n.mesh === undefined) continue;
    const m = nodeMatrix(n);
    const box = bounds(meshTriangles(entityPhys, n.mesh, m));
    const center = box.min.map((v, i) => (v + box.max[i]) / 2);
    if (n.name === 'func_bomb_target') {
      const near = (s) => Math.min(...sitePlaces(s).map((p) => dist(p, center)), Infinity);
      out.bombsites.push({ site: near('A') <= near('B') ? 'A' : 'B', ...box });
    } else if (n.name === 'func_buyzone') {
      out.buyzones.push({ team: tCenter && ctCenter && dist(center, tCenter) < dist(center, ctCenter) ? 'T' : 'CT', ...box });
    } else if (n.name === 'env_cs_place') {
      const origin = [m[14] / IN, m[12] / IN, m[13] / IN];
      let best = null, bd = 8;
      for (const e of placeEnts) { const d = dist(vec(e.origin), origin); if (d < bd) { bd = d; best = e; } }
      if (best?.place_name) out.places.push({ name: best.place_name, ...box });
    }
  }
  return out;
}

const spawnList = (ents, cls) => ents.filter((e) => e.classname === cls && e.enabled !== 'false' && e.enabled !== '0')
  .map((e) => ({ origin: vec(e.origin), yaw: vec(e.angles)[1] || 0, priority: +e.priority || 0 }));

function mapInfo(ents) {
  const sun = ents.find((e) => e.classname === 'light_environment');
  const ppv = ents.filter((e) => e.classname === 'post_processing_volume').sort((a, b) => (b.master === 'true') - (a.master === 'true'))[0];
  const params = ents.find((e) => e.classname === 'info_map_parameters');
  return {
    spawns: { T: spawnList(ents, 'info_player_terrorist'), CT: spawnList(ents, 'info_player_counterterrorist') },
    sun: sun ? { angles: vec(sun.angles), color: vec(sun.color), brightness: (+sun.brightness || 1) * (Number.isFinite(+sun.brightnessscale) ? +sun.brightnessscale : 1) } : null,
    // Auto exposure's range (CS2 keeps the exposure at 1 without it).
    exposure: ppv && /^(true|1)$/.test(String(ppv.enableexposure)) ? { min: +ppv.minexposure || 0.25, max: +ppv.maxexposure || 8, up: +ppv.exposurespeedup || 1, down: +ppv.exposurespeeddown || 1, compensation: +ppv.exposurecompensation || 0 } : null,
    postProcessing: String(ppv?.postprocessing || '').replace(/^resource_name:"?|"$/g, ''),
    bombRadius: +params?.bombradius || 500,
    sky: ents.find((e) => e.classname === 'env_sky')?.skyname?.replace(/^resource_name:"?|"$/g, '') || '',
  };
}

// ---- lighting -------------------------------------------------------------------------------------------
const toSrgb8 = (v) => {
  v = Math.max(0, Math.min(1, v));
  return Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
};

// CS2's baked lighting packed into one LIGHTMAP_SIZE² RGBA8 file (lightmap.bin): RGB = irradiance (indirect light
// and baked lights) as sRGB of value / IRR_MAX, A = the sun's baked shadow (direct_light_shadows, red channel).
// The lightmap file: RGB = irradiance (8-bit sRGB of value / IRR_MAX), A = how much the sun reaches (CS2's
// direct_light_shadows holds the sun's shadow in its red channel, light_environment's bakedshadowindex 0).
function bakeLightmap(irradianceExr, shadowPng, outFile) {
  const S = LIGHTMAP_SIZE;
  const out = Buffer.alloc(S * S * 4);
  let k = 1;
  const acc = new Float32Array(S * 3);
  readEXR(irradianceExr, {
    onRow: (y, row) => {
      const w = row.length / 4;
      k = w / S;
      for (let x = 0; x < w; x++) {
        const o = Math.floor(x / k) * 3;
        acc[o] += row[x * 4]; acc[o + 1] += row[x * 4 + 1]; acc[o + 2] += row[x * 4 + 2];
      }
      if ((y + 1) % k) return;
      const oy = (y + 1) / k - 1, n = k * k;
      for (let x = 0; x < S; x++) {
        const o = (oy * S + x) * 4;
        for (let c = 0; c < 3; c++) out[o + c] = toSrgb8(acc[x * 3 + c] / n / IRR_MAX);
        out[o + 3] = 255;
      }
      acc.fill(0);
    },
  });
  if (shadowPng && fs.existsSync(shadowPng)) {
    const img = decodePNG(fs.readFileSync(shadowPng));
    const ks = img.width / S, ch = img.channels;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      let s = 0;
      for (let dy = 0; dy < ks; dy++) for (let dx = 0; dx < ks; dx++) s += img.data[((y * ks + dy) * img.width + x * ks + dx) * ch];
      out[(y * S + x) * 4 + 3] = 255 - Math.round(s / (ks * ks));
    }
  }
  fs.writeFileSync(outFile, out);
  return { size: S, irrMax: IRR_MAX };
}

// CS2's light probe volumes (env_combined_light_probe_volume): boxes of baked lighting for everything that isn't
// lightmapped (props, players, weapons). All of a map's volumes share one atlas: an "ambient cube" per voxel (the light
// arriving from +X, +Y, +Z, -X, -Y, -Z, stacked as six blocks along the texture's depth) and the sun's baked shadow.
// Ordered like CS2 picks them: more indoor first, then smaller.
function probeVolumes(ents) {
  const res = (v) => String(v || '').replace(/^resource_name:"?|"$/g, '');
  const list = ents.filter((e) => /^env(_combined)?_light_probe_volume$/.test(e.classname) && e.light_probe_atlas_x != null && res(e.lightprobetexture) && res(e.lightprobetexture_dlshd))
    .map((e) => ({
      origin: vec(e.origin), angles: vec(e.angles), min: vec(e.box_mins), max: vec(e.box_maxs), fade: vec(e.edge_fade_dists),
      size: [+e.light_probe_size_x, +e.light_probe_size_y, +e.light_probe_size_z], atlas: [+e.light_probe_atlas_x, +e.light_probe_atlas_y, +e.light_probe_atlas_z],
      level: +e.indoor_outdoor_level || 0, texture: res(e.lightprobetexture), shadows: res(e.lightprobetexture_dlshd),
    }));
  const atlas = list[0]?.texture;
  return list.filter((v) => v.texture === atlas)
    .sort((a, b) => b.level - a.level || a.size.reduce((t, x) => t + x * x, 0) - b.size.reduce((t, x) => t + x * x, 0));
}

// The probe atlas (exported as depth slices: name_zNNN.exr for the light, name_dlshd_zNNN.png for the sun's shadow)
// into one file: RGB 8-bit sRGB of irradiance / PROBE_MAX for every voxel of the six blocks, then one byte per voxel of
// how much the sun reaches (255 - the shadow). Returns { size: [w, h, depth of one block], max }.
function bakeProbes(irrSlices, shadowSlices, outFile) {
  const first = readEXR(irrSlices[0]);
  const w = first.width, h = first.height, depth = shadowSlices.length;
  if (irrSlices.length !== depth * 6) throw new Error(`probe atlas: ${irrSlices.length} light slices for ${depth} shadow slices`);
  const out = Buffer.alloc(w * h * depth * 6 * 3 + w * h * depth);
  irrSlices.forEach((file, z) => {
    const { rgba } = z ? readEXR(file) : first;
    const o = z * w * h * 3;
    for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) out[o + i * 3 + c] = toSrgb8(rgba[i * 4 + c] / PROBE_MAX);
  });
  const so = w * h * depth * 6 * 3;
  shadowSlices.forEach((file, z) => {
    const img = decodePNG(fs.readFileSync(file));
    for (let i = 0; i < w * h; i++) out[so + z * w * h + i] = 255 - img.data[i * img.channels];
  });
  fs.writeFileSync(outFile, out);
  return { size: [w, h, depth], max: PROBE_MAX };
}

// The map's tone mapping from its post processing file (CToneMappingLayer), or null.
function toneMapping(vpostText) {
  const layers = parseKV3(vpostText)?.m_layers || [];
  const p = layers.find((l) => l?._class === 'CToneMappingLayer' && l.m_bVisible !== false)?.m_params;
  if (!p) return null;
  const k = (n, d) => (Number.isFinite(+p[n]) ? +p[n] : d);
  return {
    exposureBias: k('m_flExposureBias', 0), shoulder: k('m_flShoulderStrength', 0.15), linear: k('m_flLinearStrength', 0.5), angle: k('m_flLinearAngle', 0.1),
    toe: k('m_flToeStrength', 0.2), toeNum: k('m_flToeNum', 0.02), toeDenom: k('m_flToeDenom', 0.3), white: k('m_flWhitePoint', 4),
  };
}

// The map's sky (exported by Source 2 Viewer as an equirectangular EXR) as an 8-bit sRGB PNG.
function bakeSky(exr, outFile) {
  const { width, height, rgba } = readEXR(exr);
  const px = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    for (let c = 0; c < 3; c++) px[i * 4 + c] = toSrgb8(rgba[i * 4 + c]);
    px[i * 4 + 3] = 255;
  }
  fs.writeFileSync(outFile, encodePNG(width, height, px));
}

// ---- navigation -----------------------------------------------------------------------------------------
// The patched CLI's nav mesh JSON (VRF_NAV_JSON=1) -> the player hull's areas: { areas: [{ id, flags, c: corners,
// e: neighbour ids per edge, h: hiding spots }] } in game units.
// nav.json format version (2: ladders).
const NAV_VERSION = 2;
function compactNav(text) {
  const j = JSON.parse(text.slice(text.indexOf('{')));
  const r = (v) => Math.round(v * 10) / 10;
  return {
    version: NAV_VERSION,
    areas: j.areas.filter((a) => a.hull === 0).map((a) => ({
      id: a.id, flags: a.flags, c: a.corners.map((p) => p.map(r)), e: a.connections, h: a.hiding.map((s) => s.slice(0, 3).map(r)),
    })),
    ladders: (j.ladders || []).map((l) => ({ id: l.id, width: r(l.width), length: r(l.length), dir: l.dir, top: l.top.map(r), bottom: l.bottom.map(r), topAreas: l.topAreas, bottomAreas: l.bottomAreas })),
  };
}

// ---- weapons and sounds ---------------------------------------------------------------------------------
const pair = (v, d = 0) => (Array.isArray(v) ? [v[0] ?? d, v[1] ?? v[0] ?? d] : [v ?? d, v ?? d]);

// weapons.vdata -> { weapon_ak47: stats } with prefab inheritance resolved.
function weaponStats(text) {
  const root = parseKV3(text);
  const resolve = (key, seen = new Set()) => {
    const e = root[key];
    if (!e || typeof e !== 'object' || seen.has(key)) return {};
    seen.add(key);
    return { ...(e._base ? resolve(e._base, seen) : {}), ...e };
  };
  const out = {};
  for (const key of Object.keys(root)) {
    const w = resolve(key);
    const id = w.m_szName || w._class;
    if (!id || !/^weapon_/.test(id)) continue;
    if (/_prefab$/.test(key) && out[id]) continue; // the weapon's own entry (its prefab plus overrides) wins
    out[id] = {
      id, type: w.m_WeaponType || '', slot: w.m_GearSlot || '', price: w.m_nPrice || 0, killAward: w.m_nKillAward ?? 300,
      damage: w.m_nDamage || 0, clip: w.m_iMaxClip1 || 0,
      reserve: (w.m_nPrimaryReserveAmmoMax || 0) * (w.m_bReserveAmmoAsClips ? w.m_iMaxClip1 || 0 : 1), fullAuto: !!w.m_bIsFullAuto,
      bullets: w.m_nNumBullets || 1, melee: !!w.m_bMeleeWeapon, cycle: pair(w.m_flCycleTime, 0.1),
      headshot: w.m_flHeadshotMultiplier ?? 4, armorRatio: w.m_flArmorRatio ?? 1, penetration: w.m_flPenetration ?? 1,
      range: w.m_flRange ?? 8192, rangeModifier: w.m_flRangeModifier ?? 0.98, maxSpeed: pair(w.m_flMaxSpeed, 250),
      spread: pair(w.m_flSpread), inaccCrouch: pair(w.m_flInaccuracyCrouch), inaccStand: pair(w.m_flInaccuracyStand),
      inaccJump: pair(w.m_flInaccuracyJump), inaccJumpInitial: w.m_flInaccuracyJumpInitial || 0, inaccLand: pair(w.m_flInaccuracyLand),
      inaccFire: pair(w.m_flInaccuracyFire), inaccMove: pair(w.m_flInaccuracyMove),
      recoveryCrouch: w.m_flRecoveryTimeCrouch ?? 0.3, recoveryStand: w.m_flRecoveryTimeStand ?? 0.4,
      recoveryCrouchFinal: w.m_flRecoveryTimeCrouchFinal ?? w.m_flRecoveryTimeCrouch ?? 0.3,
      recoveryStandFinal: w.m_flRecoveryTimeStandFinal ?? w.m_flRecoveryTimeStand ?? 0.4,
      recoveryStart: w.m_nRecoveryTransitionStartBullet ?? 0, recoveryEnd: w.m_nRecoveryTransitionEndBullet ?? 0,
      recoilAngle: pair(w.m_flRecoilAngle), recoilAngleVariance: pair(w.m_flRecoilAngleVariance),
      recoilMagnitude: pair(w.m_flRecoilMagnitude), recoilMagnitudeVariance: pair(w.m_flRecoilMagnitudeVariance),
      recoilSeed: w.m_nRecoilSeed || 0, spreadSeed: w.m_nSpreadSeed || 0, deploy: w.m_flDeployDuration ?? 1,
      zoomLevels: w.m_nZoomLevels || 0, zoomFov: [w.m_nZoomFOV1 || 90, w.m_nZoomFOV2 || 90], zoomTime: [w.m_flZoomTime0 || 0, w.m_flZoomTime1 || 0, w.m_flZoomTime2 || 0],
      silencer: w.m_eSilencerType || 'WEAPONSILENCER_NONE', burst: !!w.m_bHasBurstMode, revolver: !!w.m_bIsRevolver,
      burstCycle: w.m_flCycleTimeWhenInBurstMode || 0, burstGap: w.m_flTimeBetweenBurstShots || 0,
      reloadTime: w.m_flDisallowAttackAfterReloadStartDuration || 0,
      tracerFrequency: pair(w.m_nTracerFrequency, 1)[0], unzoomsAfterShot: !!w.m_bUnzoomsAfterShot,
      hideViewmodelZoomed: !!w.m_bHideViewModelWhenZoomed, attackMoveFactor: w.m_flAttackMovespeedFactor ?? 1,
      shootSound: w.m_aShootSounds?.WEAPON_SOUND_SINGLE || '', worldModel: w.m_szWorldModel || '',
      muzzle: w.m_vecMuzzlePos0 || null, bulletsPerReload: w.m_bReloadsSingleShells ? 1 : 0,
    };
  }
  return out;
}

// Sound event files (*.vsndevts) -> { "Weapon_AK47.Single": ["sounds/weapons/ak47/ak47_01.vsnd", ...], ... }.
function soundEventFiles(text) {
  const root = parseKV3(text);
  const out = {};
  for (const [name, ev] of Object.entries(root)) {
    if (!ev || typeof ev !== 'object') continue;
    const files = [];
    for (const [k, v] of Object.entries(ev)) {
      if (/^vsnd_files/.test(k)) files.push(...[].concat(v).filter((f) => typeof f === 'string'));
    }
    if (files.length) out[name] = files;
    else if (ev.soundevent_01) out[name] = { alias: [].concat(ev.soundevent_01)[0] };
  }
  for (const [name, v] of Object.entries(out)) if (v.alias) out[name] = Array.isArray(out[v.alias]) ? out[v.alias] : [];
  return out;
}

module.exports = {
  PLAY_VERSION, DATA_VERSION, F_PLAYER, F_BULLET, F_GRENADE, IRR_MAX, readGlb, buildCollision, brushSolid, gameVolumes, mapInfo, bakeLightmap, bakeSky,
  probeVolumes, bakeProbes, toneMapping, disabledNodes, hurtVolume, surfaceImpacts, doorNodes, glassNodes,
  weaponStats, soundEventFiles, parseEntities, compactNav, NAV_VERSION,
};
