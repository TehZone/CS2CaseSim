// Play mode: turns a CS2 map from the player's install into what the renderer needs to walk around it and shoot:
// the render world (glTF), a collision mesh, CS2's baked lighting, the sky, and the map's gameplay entities (spawns,
// bomb sites, buy zones, callout areas). Also reads weapon stats (weapons.vdata) and sound events.
const fs = require('fs');
const path = require('path');
const { parseEntities } = require('./vanity.cjs');
const { parseKV1, parseKV3 } = require('./kv.cjs');
const { readEXR } = require('./exr.cjs');
const { decodePNG, encodePNG } = require('./png.cjs');

const IN = 0.0254; // the exporter writes game inches as metres
const PLAY_VERSION = 14; // map exports (2: texture layers, sharper textures, non-solid brushes left out; 3: sun mask, probes, grading;
// 4: entities that start switched off left out, trigger_hurt volumes; 5: csgo_environment(_blend)'s other layers and height maps;
// 6: doors and breakable glass; 7: the 3D skybox; 8: no texture over 1024 after it; 9: breakable props too; 10: props named
// breakable (Mirage's vent covers) and what's left of a breakable once broken (Mirage's shutter frame); 11: soundscapes;
// 12: the windows' and glass's own textures, the sky's brightness; 13: props that break by their own prop data, Nuke's
// vent slats and Cache's vents, and each breakable's health; 14: the map's Wingman version)
const PROBE_MAX = 8; // probe irradiance is stored as 8-bit sRGB of value / PROBE_MAX
const DATA_VERSION = 7; // weapon stats + sound events (6: maps' ambience sounds, every surface's bullet impact sound; 7: how CS2
// plays each event, and its reverb presets)
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
  return packCollision(parts, surfaces);
}

// parts: [{ tris (9 floats each), flags, surface (index into surfaces) }] as collision.bin.
function packCollision(parts, surfaces) {
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
// world (their collision is left out by brushSolid; Wingman's come back in Wingman: see wingmanSetup). A brush entity's
// nodes are named after its model ("<model>.hammer_mesh_0"); a prop's after its model too, at the entity's origin.
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
// What a prop that breaks by its own prop data is made of (its base: Metal.Medium...), when its name doesn't say.
const BREAK_BASES = [[/^metal/i, 'metalvent'], [/^wood/i, 'wood'], [/^glass/i, 'glass'], [/^(pottery|ceramic)/i, 'pottery']];
// props: the map's props' own break data (propBreakData, by model path): a prop breaks in CS2 when its model has health
// and pieces to break into (Nuke's vent slats, Cache's vents), whatever it's called.
function glassNodes(json, ents, props = {}) {
  const find = entityNodes(json), out = [];
  for (const e of ents) {
    if (!e.model || /^(true|1)$/i.test(String(e.startdisabled ?? ''))) continue;
    const model = String(e.model).replace(/^resource_name:"?|"$/g, '').replace(/.*\//, '').replace(/\.vmdl$/, '');
    const own = props[modelPath(e)];
    let nodes, kind, health = +e.health || 1;
    if (e.classname === 'func_breakable' && String(e.material ?? '0') === '0') { nodes = find.brush(e); kind = BREAKS.find((k) => k[1] === 'glass'); }
    else if (/^prop_(dynamic|physics)/.test(e.classname) && (/breakable/i.test(model) || /breakable/i.test(String(e.targetname || '')) || (own?.health > 0 && own.pieces > 0))) {
      nodes = find.prop(e);
      kind = BREAKS.find(([re]) => re.test(model));
      const made = own && BREAK_BASES.find(([re]) => re.test(own.base));
      if (kind[1] === 'default' && made) kind = BREAKS.find((k) => k[1] === made[1]);
      if (own?.health > 0) health = own.health;
    } else continue;
    if (nodes.length) out.push({ nodes, health, surface: kind[1], sound: kind[2], solid: kind[3], origin: vec(e.origin), remainder: [] });
  }
  for (const e of ents) {
    if (!/^prop_dynamic/.test(e.classname) || !/^(true|1)$/i.test(String(e.startdisabled ?? '')) || !/remainder/i.test(String(e.model || ''))) continue;
    const o = vec(e.origin), near = out.filter((g) => g.origin.length === 3 && Math.hypot(g.origin[0] - o[0], g.origin[1] - o[1], g.origin[2] - o[2]) < 160)
      .sort((a, b) => Math.hypot(a.origin[0] - o[0], a.origin[1] - o[1]) - Math.hypot(b.origin[0] - o[0], b.origin[1] - o[1]))[0];
    if (near) near.remainder.push(...find.prop(e));
  }
  return out;
}

// An entity's model, as the game files name it (models/.../x.vmdl).
const modelPath = (e) => String(e.model || '').replace(/^resource_name:"?|"$/g, '').replace(/^"|"$/g, '').toLowerCase();

// A model's own break data, from its compiled data block (a cs2.dump of it): its prop_data's health and base (what it's
// made of) and how many pieces it breaks into. null for a model without prop_data.
function propBreakData(data) {
  let text = null;
  const look = (o) => {
    if (text || !o || typeof o !== 'object') return;
    if (typeof o.m_keyValueText === 'string') { text = o.m_keyValueText; return; }
    for (const v of Object.values(o)) look(v);
  };
  look(data);
  if (!text) return null;
  let kv;
  try { kv = parseKV3(text); } catch { return null; }
  const pd = kv?.prop_data;
  if (!pd) return null;
  return { health: +pd.health || 0, base: String(pd.base || ''), pieces: Array.isArray(kv.break_list) ? kv.break_list.length : 0 };
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

const spawnOn = (e) => e.enabled !== 'false' && e.enabled !== '0';
const spawnList = (ents, cls, on = spawnOn) => ents.filter((e) => e.classname === cls && on(e))
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
    // How bright CS2 draws the sky (env_sky's brightness scale: Cache's is 4).
    skyBrightness: Number.isFinite(+ents.find((e) => e.classname === 'env_sky')?.brightnessscale) ? +ents.find((e) => e.classname === 'env_sky').brightnessscale : 1,
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

// ---- Wingman ----------------------------------------------------------------------------------------------
// CS2 keeps one file per map: its Wingman version is that map with things switched as it loads. A Pulse graph (a
// point_pulse's) asks GetIsWingman and fires inputs at groups of entities: walls, barricades and doors on, nav blockers
// closed, spawns and buy zones swapped, the other site's signs off. Which site is left isn't written anywhere: it's
// the one both teams can still walk to. A map made for it (Debris, Eldorado, Poseidon) just has the one site.

// CS2's Wingman maps, for when gamemodes.txt can't be read.
const WINGMAN_POOL = ['de_debris', 'de_eldorado', 'de_poseidon', 'de_overpass', 'de_vertigo', 'de_nuke', 'de_inferno'];

// gamemodes.txt -> the maps of the Wingman mode (classic's scrimcomp2v2): its map groups, by name or through a template.
function wingmanPool(text) {
  const gm = Object.values(parseKV1(text))[0] || {};
  const groups = gm.gameTypes?.classic?.gameModes?.scrimcomp2v2?.mapgroupsMP || {};
  const names = Object.entries(groups).flatMap(([k, v]) => (k === 'template#include' ? Object.keys(gm['templates#include']?.[v] || {}) : [k]));
  return [...new Set(names.flatMap((g) => Object.keys(gm.mapgroups?.[g]?.maps || {})))];
}

// The map's Pulse graphs (its point_pulses'): their files in CS2.
const pulseGraphs = (ents) => [...new Set(ents.filter((e) => e.classname === 'point_pulse' && e.graph_def).map((e) => String(e.graph_def).replace(/^resource_name:"?|"$/g, '')))];

// A Pulse graph (decompiled .vpulse) -> what it does in Wingman: [{ target, input }] in order, the steps after its
// GetIsWingman check; null when it never asks.
function wingmanSteps(text) {
  const g = parseKV3(text);
  const fired = new Map((g.m_OutputConnections || []).map((o) => [String(o.m_SourceOutput).split(':').pop(), o]));
  const call = (x) => g.m_InvokeBindings?.[x.m_nInvokeBindingIndex];
  for (const chunk of g.m_Chunks || []) {
    const code = chunk.m_Instructions || [];
    const at = code.findIndex((x) => x.m_nCode === 'LIBRARY_INVOKE' && call(x)?.m_FuncName === 'CCSPointPulseAPI::GetIsWingman');
    if (at < 0 || code[at + 1]?.m_nCode !== 'JUMP_COND') continue;
    const steps = [];
    for (let i = code[at + 1].m_nDestInstruction; code[i] && code[i].m_nCode !== 'RETURN_VOID'; i++) {
      if (code[i].m_nCode !== 'CELL_INVOKE') continue;
      const o = fired.get(String(g.m_Cells?.[call(code[i])?.m_nCellIndex]?.m_nEditorNodeID));
      if (o) steps.push({ target: o.m_TargetEntity, input: o.m_TargetInput });
    }
    return steps;
  }
  return null;
}

const entityName = (e) => String(e.targetname || '').replace('[PR#]', '');
const SWITCHED_ON = /^(Enable|SetEnabled|BlockNav)$/i, SWITCHED_OFF = /^(Disable|SetDisabled|Kill)$/i;
// The entities those steps turn on and off.
function wingmanEntities(ents, steps) {
  const named = (re) => { const names = new Set(steps.filter((s) => re.test(s.input)).map((s) => s.target)); return ents.filter((e) => names.has(entityName(e))); };
  return { on: named(SWITCHED_ON), off: named(SWITCHED_OFF) };
}

// A model's physics (its _physics.glb) where the entity puts it, a part per physics group: [{ tris, extras }].
function placedPhysics(glb, e) {
  const [p, y, r] = (vec(e.angles).length === 3 ? vec(e.angles) : [0, 0, 0]).map((a) => (a * Math.PI) / 180);
  const sp = Math.sin(p), cp = Math.cos(p), sy = Math.sin(y), cy = Math.cos(y), sr = Math.sin(r), cr = Math.cos(r);
  // Source's angles as a matrix: the columns are forward, left and up.
  const R = [[cp * cy, sp * sr * cy - cr * sy, sp * cr * cy + sr * sy], [cp * sy, sp * sr * sy + cr * cy, sp * cr * sy - sr * cy], [-sp, sr * cp, cr * cp]];
  const S = vec(e.scales).length === 3 ? vec(e.scales) : [1, 1, 1], O = vec(e.origin);
  return glb.json.nodes.filter((n) => n.mesh !== undefined).map((n) => {
    const tris = meshTriangles(glb, n.mesh, nodeMatrix(n));
    for (let i = 0; i < tris.length; i += 3) {
      const x = tris[i] * S[0], y2 = tris[i + 1] * S[1], z = tris[i + 2] * S[2];
      for (let c = 0; c < 3; c++) tris[i + c] = O[c] + R[c][0] * x + R[c][1] * y2 + R[c][2] * z;
    }
    return { tris, extras: n.extras };
  });
}

// An entity's bounds from its physics: { min, max }, or null without any.
function physicsBox(glb, e) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const { tris } of placedPhysics(glb, e)) {
    const b = bounds(tris);
    for (let c = 0; c < 3; c++) { min[c] = Math.min(min[c], b.min[c]); max[c] = Math.max(max[c], b.max[c]); }
  }
  return Number.isFinite(min[0]) ? { min, max } : null;
}

// What Wingman makes solid: its brushes as their physics groups say (a wall, a player clip, a grenade clip), its props as
// their models': [{ tris, flags, surface (its name) }]. physics(e): the entity's model's _physics.glb.
function wingmanSolids(on, physics) {
  return on.flatMap((e) => {
    const solid = e.classname === 'func_brush' ? String(e.solidity ?? '0') !== '1' : /^prop_/.test(e.classname) && String(e.solid ?? '6') !== '0';
    const glb = solid ? physics(e) : null;
    if (!glb) return [];
    return placedPhysics(glb, e).map(({ tris, extras }) => ({ tris, flags: collisionFlags(extras), surface: String(extras?.SurfaceProperty || 'default') })).filter((s) => s.flags && s.tris.length);
  });
}

// Those as collision.bin.
function wingmanCollision(solids) {
  const surfaces = [...new Set(solids.map((s) => s.surface))];
  return packCollision(solids.map((s) => ({ ...s, surface: surfaces.indexOf(s.surface) })), surfaces);
}

// Does a nav area's floor touch a box? (Its outline and the box's, seen from above, and within pad in height.)
function areaInBox(a, box, pad) {
  const xs = a.c.map((p) => p[0]), ys = a.c.map((p) => p[1]), zs = a.c.map((p) => p[2]);
  if (Math.max(...xs) <= box.min[0] || Math.min(...xs) >= box.max[0] || Math.max(...ys) <= box.min[1] || Math.min(...ys) >= box.max[1]) return false;
  if (Math.max(...zs) < box.min[2] - pad || Math.min(...zs) > box.max[2] + pad) return false;
  const n = a.c.length;
  const inside = (x, y) => {
    let c = false;
    for (let i = 0, j = n - 1; i < n; j = i++) { const p = a.c[i], q = a.c[j]; if ((p[1] > y) !== (q[1] > y) && x < ((q[0] - p[0]) * (y - p[1])) / (q[1] - p[1]) + p[0]) c = !c; }
    return c;
  };
  const R = [[box.min[0], box.min[1]], [box.max[0], box.min[1]], [box.max[0], box.max[1]], [box.min[0], box.max[1]]];
  if (a.c.some((p) => p[0] > box.min[0] && p[0] < box.max[0] && p[1] > box.min[1] && p[1] < box.max[1]) || R.some((p) => inside(p[0], p[1]))) return true;
  const side = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  for (let i = 0; i < n; i++) for (let j = 0; j < 4; j++) {
    const p = a.c[i], q = a.c[(i + 1) % n], r = R[j], s = R[(j + 1) % 4];
    if (side(p, q, r) * side(p, q, s) < 0 && side(r, s, p) * side(r, s, q) < 0) return true;
  }
  return false;
}

// Does a walk from p to q (a player's height over it) go through a box?
function walkHitsBox(p, q, box) {
  let t0 = 0, t1 = 1;
  for (let c = 0; c < 2; c++) {
    const d = q[c] - p[c];
    if (Math.abs(d) < 1e-9) { if (p[c] < box.min[c] || p[c] > box.max[c]) return false; continue; }
    const a = (box.min[c] - p[c]) / d, b = (box.max[c] - p[c]) / d;
    t0 = Math.max(t0, Math.min(a, b)); t1 = Math.min(t1, Math.max(a, b));
    if (t0 > t1) return false;
  }
  const z = p[2] + (q[2] - p[2]) * ((t0 + t1) / 2);
  return z + 72 >= box.min[2] && z <= box.max[2];
}

// Does the segment p to q cross a triangle of tris (9 floats each)?
function segmentHits(p, q, t) {
  const dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2];
  for (let i = 0; i < t.length; i += 9) {
    const ax = t[i + 3] - t[i], ay = t[i + 4] - t[i + 1], az = t[i + 5] - t[i + 2], bx = t[i + 6] - t[i], by = t[i + 7] - t[i + 1], bz = t[i + 8] - t[i + 2];
    const hx = dy * bz - dz * by, hy = dz * bx - dx * bz, hz = dx * by - dy * bx, det = ax * hx + ay * hy + az * hz;
    if (Math.abs(det) < 1e-9) continue;
    const sx = p[0] - t[i], sy = p[1] - t[i + 1], sz = p[2] - t[i + 2], u = (sx * hx + sy * hy + sz * hz) / det;
    if (u < 0 || u > 1) continue;
    const rx = sy * az - sz * ay, ry = sz * ax - sx * az, rz = sx * ay - sy * ax, v = (dx * rx + dy * ry + dz * rz) / det;
    if (v < 0 || u + v > 1) continue;
    const k = (bx * rx + by * ry + bz * rz) / det;
    if (k >= 0 && k <= 1) return true;
  }
  return false;
}

const CROUCH_JUMP = 66; // the highest ledge a player gets up onto (nav.js)
// Does a walk from p to q go through something solid ([{ tris, box }])? Knee and head high on a player.
function walkHitsSolid(p, q, solids) {
  const lo = [0, 1, 2].map((c) => Math.min(p[c], q[c])), hi = [0, 1, 2].map((c) => Math.max(p[c], q[c]) + 72);
  return solids.some(({ tris, box }) => box.min.every((v, c) => v <= hi[c]) && box.max.every((v, c) => v >= lo[c])
    && [24, 60].some((h) => segmentHits([p[0], p[1], p[2] + h], [q[0], q[1], q[2] + h], tris)));
}

// The nav areas (compactNav's) left in Wingman, as CS2's bots find them: those its blockers touch are closed, and what
// that cuts off from both teams' spawns goes with them. A spawn on a closed area leaves it by its own side of the blocker.
// solids (what stops a player: [{ tris }]) count too: not every wall has a blocker (the floor under Vertigo's fence).
// { closed: the ids gone, cut: the links [from, to] left that walk through a wall, reach: { T, CT }: the ids each team
// can walk to }.
function wingmanReach(nav, blockers, spawns, solids = []) {
  const byId = new Map(nav.areas.map((a) => [a.id, a]));
  const walls = solids.map((s) => { const b = bounds(s.tris); return { tris: s.tris, box: { min: b.min.map((v) => v - 1), max: b.max.map((v) => v + 1) } }; });
  const blocked = new Set(nav.areas.filter((a) => blockers.some((b) => areaInBox(a, b, 8))).map((a) => a.id));
  const links = new Map(nav.areas.map((a) => [a.id, a.e.flat()]));
  for (const l of nav.ladders || []) for (const b of l.bottomAreas) for (const t of l.topAreas) { links.get(b)?.push(t); links.get(t)?.push(b); }
  const center = (a) => [0, 1, 2].map((k) => a.c.reduce((s, p) => s + p[k], 0) / a.c.length);
  const under = (o) => nav.areas.filter((a) => areaInBox(a, { min: [o[0] - 1, o[1] - 1, o[2] - 96], max: [o[0] + 1, o[1] + 1, o[2] + 24] }, 0))
    .sort((a, b) => Math.abs(center(a)[2] - o[2]) - Math.abs(center(b)[2] - o[2]))[0];
  // The middle of the edge a shares with b. A ladder's two ends have none (nothing's built over one).
  const gate = (a, b) => {
    const i = a.e.findIndex((l) => l.includes(b.id));
    return i < 0 ? null : [0, 1, 2].map((k) => (a.c[i][k] + a.c[(i + 1) % a.c.length][k]) / 2);
  };
  const walled = (a, b) => { const mid = gate(a, b); return !!mid && (walkHitsSolid(center(a), mid, walls) || walkHitsSolid(mid, center(b), walls)); };
  // Out of reach above (the way down from a room Wingman shuts the door of, Nuke's upper Secret)?
  const tooHigh = (a, b) => { const from = gate(a, b), to = gate(b, a); return !!from && !!to && to[2] - from[2] > CROUCH_JUMP; };
  const flood = (list) => {
    const seen = new Set(), stack = [];
    const add = (id) => { if (!seen.has(id) && !blocked.has(id) && byId.has(id)) { seen.add(id); stack.push(id); } };
    for (const { origin } of list) {
      const a = under(origin);
      if (!a) continue;
      add(a.id);
      if (blocked.has(a.id)) for (const id of links.get(a.id)) if (byId.has(id) && !blockers.some((b) => walkHitsBox(origin, center(byId.get(id)), b))) add(id);
    }
    while (stack.length) { const a = byId.get(stack.pop()); for (const id of links.get(a.id)) if (byId.has(id) && !tooHigh(a, byId.get(id)) && !walled(a, byId.get(id))) add(id); }
    return seen;
  };
  const reach = { T: flood(spawns.T), CT: flood(spawns.CT) };
  const open = (id) => reach.T.has(id) || reach.CT.has(id);
  const cut = nav.areas.filter((a) => open(a.id)).flatMap((a) => [...new Set(a.e.flat())].filter((id) => open(id) && walled(a, byId.get(id))).map((id) => [a.id, id]));
  return { closed: nav.areas.map((a) => a.id).filter((id) => !open(id)), cut, reach };
}

// Which of the map's bomb sites is left: the only one both teams can walk to (or the only one there is), else null.
function wingmanSite(nav, bombsites, reach) {
  if (bombsites.length === 1) return 0;
  const open = bombsites.map((s, i) => {
    const on = nav.areas.filter((a) => areaInBox(a, s, 40)).map((a) => a.id);
    return on.some((id) => reach.T.has(id)) && on.some((id) => reach.CT.has(id)) ? i : -1;
  }).filter((i) => i >= 0);
  return open.length === 1 ? open[0] : null;
}

// A map's Wingman version for map.json: its site (an index into bombsites) and what differs from the map as exported:
// { site, spawns, buyzones, show, hide (glTF nodes), closed (nav areas), cut (nav links) }. ents: the map's entities; nav:
// compactNav's; json: world.glb's; on, off: wingmanEntities'; solids: wingmanSolids'; physics(e): the entity's model's
// _physics.glb.
function wingmanSetup({ ents, nav, json, bombsites, on, off, solids, physics }) {
  const isOn = new Set(on), isOff = new Set(off);
  const enabled = (e) => (spawnOn(e) || isOn.has(e)) && !isOff.has(e);
  const spawns = { T: spawnList(ents, 'info_player_terrorist', enabled), CT: spawnList(ents, 'info_player_counterterrorist', enabled) };
  const box = (e) => { const glb = physics(e); return glb && physicsBox(glb, e); };
  const { closed, cut, reach } = wingmanReach(nav, on.filter((e) => e.classname === 'func_nav_blocker').map(box).filter(Boolean), spawns, solids.filter((s) => s.flags & F_PLAYER));
  const find = entityNodes(json);
  const nodes = (list) => list.filter((e) => e.model).flatMap((e) => (/^func_/.test(e.classname) ? find.brush(e) : find.prop(e)));
  const zones = ents.filter((e) => e.classname === 'func_buyzone' && !isOff.has(e)).map((e) => ({ team: +e.teamnum === 2 ? 'T' : 'CT', ...box(e) })).filter((z) => z.min);
  return {
    site: wingmanSite(nav, bombsites, reach),
    ...(on.concat(off).some((e) => /^info_player_/.test(e.classname)) ? { spawns } : {}),
    ...(on.some((e) => e.classname === 'func_buyzone') ? { buyzones: zones } : {}),
    show: nodes(on), hide: nodes(off), closed, cut,
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
  const root = typeof text === 'string' ? parseKV3(text) : text;
  const out = {};
  for (const [name, ev] of Object.entries(root)) {
    if (!ev || typeof ev !== 'object') continue;
    const files = [];
    for (const [k, v] of Object.entries(ev)) {
      if (/^vsnd_files/.test(k)) files.push(...[].concat(v).filter((f) => typeof f === 'string'));
    }
    if (files.length) out[name] = files;
    else if (ev.soundevent_01) out[name] = ev.dsp_preset ? [] : { alias: [].concat(ev.soundevent_01)[0] }; // (a soundscape plays all of its children: see soundEventInfo)
  }
  for (const [name, v] of Object.entries(out)) if (v.alias) out[name] = Array.isArray(out[v.alias]) ? out[v.alias] : [];
  return out;
}

// How CS2 plays each sound event (events: every file's events, by name; files: soundEventFiles' result, the events
// there's something to play for), compact: { v volume, p pitch, pr / vr [min, max] added to the pitch / volume at
// random, dl delay (s), o occlusion (0..1: how much a wall in between muffles it), r reverb (how much of it the room
// gets), n instances one source plays at once (a new one fades out the oldest), bl seconds the same source can't play it
// again, d volume by distance [[units, volume]...], s how much of it is plain stereo by distance (not positioned: up
// close), c the events it plays along with it (a gunshot's distant layer), fo seconds it fades out over when stopped;
// soundscapes (an env_soundscape's event and what it plays): dsp its reverb preset (ov: false, only as a default),
// fi seconds it fades in over, rt [min, max] seconds between plays of a one-shot (no rt: a loop), wp where in the world it
// is, rr [min, max] how far from you it plays (at random), rs the loop starts somewhere in the middle }.
// An event with a base gets the base's settings, then its own; one with no files of its own plays its first child's.
function soundEventInfo(events, files) {
  const merged = (name, depth = 0) => {
    const ev = events[name];
    if (!ev || typeof ev !== 'object') return {};
    return typeof ev.base === 'string' && ev.base && depth < 4 ? { ...merged(ev.base, depth + 1), ...ev } : ev;
  };
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
  const round = (x, k = 1000) => Math.round(x * k) / k;
  const curve = (c) => (Array.isArray(c) ? c.filter((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])).map((p) => [round(p[0], 100), round(p[1])]) : []);
  const lastX = (c) => { const pts = curve(c); return pts.length ? pts[pts.length - 1][0] : undefined; };
  const kids = (ev) => Object.keys(ev).filter((k) => /^soundevent_\d+$/.test(k)).flatMap((k) => [].concat(ev[k])).filter((c) => typeof c === 'string' && c);
  const out = {};
  for (const name of Object.keys(files)) {
    let ev = merged(name);
    const own = Object.keys(ev).some((k) => /^vsnd_files/.test(k));
    const children = ev.enable_child_events === false ? [] : kids(ev);
    if (!own && !children.length) continue;
    if (!own && files[name]?.length) ev = { ...merged(children[0]), ...Object.fromEntries(Object.entries(ev).filter(([k]) => !/^soundevent_/.test(k))) }; // an alias
    const i = {};
    const set = (k, v) => { if (v !== undefined) i[k] = v; };
    set('v', num(ev.volume)); set('p', num(ev.pitch));
    if (num(ev.pitch_random_min) || num(ev.pitch_random_max)) i.pr = [num(ev.pitch_random_min) ?? 0, num(ev.pitch_random_max) ?? 0].sort((a, b) => a - b);
    if (num(ev.volume_random_min) || num(ev.volume_random_max)) i.vr = [num(ev.volume_random_min) ?? 0, num(ev.volume_random_max) ?? 0].sort((a, b) => a - b);
    if (num(ev.delay) > 0) i.dl = ev.delay;
    set('o', num(ev.occlusion_intensity));
    // UI, voices and music aren't in the room.
    set('r', /^(UI|VO)$|Music|Movie/i.test(ev.mixgroup || '') ? 0 : num(ev.reverb_wet));
    if (num(ev.instance_limit) >= 1) i.n = ev.instance_limit;
    if (ev.block_matching_events === true && num(ev.block_duration) > 0) i.bl = ev.block_duration;
    if (ev.use_distance_volume_mapping_curve !== false && curve(ev.distance_volume_mapping_curve).length) i.d = curve(ev.distance_volume_mapping_curve);
    if (ev.use_distance_unfiltered_stereo_mapping_curve && curve(ev.distance_unfiltered_stereo_mapping_curve).length) i.s = curve(ev.distance_unfiltered_stereo_mapping_curve);
    const fo = lastX(ev.fadetime_volume_mapping_curve);
    if (fo > 0) i.fo = fo;
    if (own) { const c = children.filter((k) => k !== name && files[k]); if (c.length) i.c = c; }
    else if (!files[name]?.length) i.c = children.filter((k) => k !== name); // a soundscape: nothing of its own, all children
    if (typeof ev.dsp_preset === 'string' && ev.dsp_preset) { i.dsp = ev.dsp_preset.toLowerCase(); if (ev.override_dsp_preset === false) i.ov = false; }
    if (ev.use_time_volume_mapping_curve && lastX(ev.time_volume_mapping_curve) > 0) i.fi = lastX(ev.time_volume_mapping_curve);
    if (ev.enable_retrigger) i.rt = [num(ev.retrigger_interval_min) ?? 5, num(ev.retrigger_interval_max) ?? num(ev.retrigger_interval_min) ?? 10];
    if (ev.use_world_position && Array.isArray(ev.position) && ev.position.some((x) => x)) i.wp = ev.position.map((x) => round(x, 10));
    if (num(ev.randomize_position_max_radius) > 0) i.rr = [num(ev.randomize_position_min_radius) ?? 0, ev.randomize_position_max_radius];
    if (ev.randomize_start_time) i.rs = true;
    out[name] = i;
  }
  return out;
}

// One of CS2's reverb presets (sounds/graphs/reverb_*.vmix): its processors, run one after the other, as
// { name: [{ type: 'delay', ms, direct, gain, feedback (dB), cutoff (Hz: a lowpass on the repeats), width } |
//   { type: 'diffusor', size (0..1), complexity, feedback (dB), gain } |
//   { type: 'box', min, max (ms: the shoebox's delay lines), complexity, feedback (0..1), cutoff, gain (dB), parallel } |
//   { type: 'plate', decay, damp, diffusion (0..1: Dattorro's plate) } | { type: 'freeverb', size, damp, width, late } |
//   { type: 'filter', kind (lowpass, highpass, high_shelf...), cutoff, q, gain (dB), poles (1, 2 or 8: 6 to 48 dB an octave) }] }.
function reverbPreset(text) {
  const graph = parseKV3(text)?.Graphs?.[0];
  if (!graph?.Name) return {};
  const chain = [];
  for (const p of graph.m_Processors || []) {
    const d = p.m_desc || {};
    const cls = String(p._class || '');
    if (/Delay/.test(cls)) chain.push({ type: 'delay', ms: d.m_flDelay, direct: d.m_flDirectGain, gain: d.m_flDelayGain, feedback: d.m_flFeedbackGain,
      cutoff: d.m_bEnableFilter && d.m_feedbackFilter?.m_bEnabled ? d.m_feedbackFilter.m_flCutoffFreq : 20000, width: d.m_flWidth || 0 });
    else if (/Diffusor/.test(cls)) chain.push({ type: 'diffusor', size: d.m_flSize, complexity: d.m_flComplexity, feedback: d.m_flFeedback, gain: d.m_flOutputGain || 0 });
    else if (/Boxverb/.test(cls)) chain.push({ type: 'box', min: d.m_flSizeMin, max: d.m_flSizeMax, complexity: d.m_flComplexity, feedback: d.m_flFeedbackScale,
      cutoff: d.m_filterType?.m_bEnabled ? d.m_filterType.m_flCutoffFreq : 20000, gain: d.m_flOutputGain || 0, parallel: !!d.m_bParallel });
    else if (/PlateReverb/.test(cls)) chain.push({ type: 'plate', decay: d.m_flDecay ?? 0.5, damp: d.m_flDamp ?? 0.5, diffusion: d.m_flInputDiffusion1 ?? 0.5 });
    else if (/Freeverb/.test(cls)) chain.push({ type: 'freeverb', size: d.m_flRoomSize ?? 0.5, damp: d.m_flDamp ?? 0.5, width: d.m_flWidth ?? 1, late: d.m_flLateReflections ?? 1 });
    else if (/Filter/.test(cls) && d.m_bEnabled !== false) chain.push({ type: 'filter', kind: String(d.m_nFilterType || 'FILTER_LOWPASS').replace(/^FILTER_/, '').toLowerCase(),
      cutoff: d.m_flCutoffFreq, q: d.m_flQ || Math.SQRT1_2, gain: d.m_fldbGain || 0, poles: /1POLE/.test(d.m_nFilterSlope) ? 1 : /48dB/.test(d.m_nFilterSlope) ? 8 : /24dB/.test(d.m_nFilterSlope) ? 4 : 2 });
  }
  return { [graph.Name.toLowerCase()]: chain };
}

// The map's soundscapes (env_soundscape, CS2's: each plays a soundscape event, and sets the reverb, where it's heard
// from): [{ o: origin, r: radius, e: event, off: starts switched off }].
function mapSoundscapes(ents) {
  return ents.filter((e) => /^env_soundscape/.test(e.classname) && e.soundevent && !/^(false|0)$/.test(String(e.enablesoundevent ?? 'true')))
    .map((e) => ({ o: vec(e.origin), r: +e.radius || 0, e: String(e.soundevent), ...(/^(true|1)$/.test(String(e.startdisabled)) ? { off: true } : {}) }))
    .filter((s) => s.o.length === 3);
}

module.exports = {
  PLAY_VERSION, DATA_VERSION, F_PLAYER, F_BULLET, F_GRENADE, IRR_MAX, readGlb, buildCollision, brushSolid, gameVolumes, mapInfo, bakeLightmap, bakeSky,
  probeVolumes, bakeProbes, toneMapping, disabledNodes, hurtVolume, surfaceImpacts, doorNodes, glassNodes,
  WINGMAN_POOL, wingmanPool, pulseGraphs, wingmanSteps, wingmanEntities, wingmanSolids, wingmanCollision, wingmanReach, wingmanSite, wingmanSetup,
  weaponStats, soundEventFiles, modelPath, propBreakData, soundEventInfo, reverbPreset, mapSoundscapes, parseEntities, compactNav, NAV_VERSION, parseKV3,
};
