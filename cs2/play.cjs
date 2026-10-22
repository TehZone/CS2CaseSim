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
const PLAY_VERSION = 2; // map exports (2: second texture layers, sharper world textures, non-solid brushes left out)
const DATA_VERSION = 5; // weapon stats + sound events
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
  const params = ents.find((e) => e.classname === 'info_map_parameters');
  return {
    spawns: { T: spawnList(ents, 'info_player_terrorist'), CT: spawnList(ents, 'info_player_counterterrorist') },
    sun: sun ? { angles: vec(sun.angles), color: vec(sun.color), brightness: +sun.brightness || 1 } : null,
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
      out[(y * S + x) * 4 + 3] = Math.round(s / (ks * ks));
    }
  }
  fs.writeFileSync(outFile, out);
  return { size: S, irrMax: IRR_MAX };
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
  weaponStats, soundEventFiles, parseEntities, compactNav, NAV_VERSION,
};
