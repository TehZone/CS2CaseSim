// CS2's "vanity" maps: the small 3D scenes the game draws behind the main menu and item inspect (Dust II,
// Mirage, Ancient...). Each one ships as game/csgo/maps/<name>_vanity.vpk with the world geometry, baked lighting and
// the entities that say where items are shown and where the cameras are.
const fs = require('fs');

// Friendly names for the backdrops (anything else gets a tidied-up file name).
const NAMES = {
  de_dust2: 'Dust II', de_mirage: 'Mirage', de_inferno: 'Inferno', de_ancient: 'Ancient', de_ancient_night: 'Ancient (Night)',
  de_anubis: 'Anubis', de_cache: 'Cache', de_nuke: 'Nuke', de_overpass: 'Overpass', de_train: 'Train', de_vertigo: 'Vertigo',
  cs_italy: 'Italy', cs_office: 'Office', ar_baggage: 'Baggage', warehouse: 'Warehouse',
};
const nameOf = (id) => NAMES[id] || id.replace(/^(de|cs|ar)_/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// Lists the backdrops in an install: [{ id, name, vpk }].
function listVanity(mapsDir) {
  let files = [];
  try { files = fs.readdirSync(mapsDir); } catch { return []; }
  return files.filter((f) => /_vanity\.vpk$/i.test(f) && !/_dir\.vpk$/i.test(f))
    .map((f) => { const id = f.replace(/_vanity\.vpk$/i, ''); return { id, name: nameOf(id), vpk: f }; })
    .sort((a, b) => a.name.localeCompare(b.name));
}

const vec = (s) => (s || '').replace(/[[\]]/g, '').trim().split(/[\s,]+/).filter(Boolean).map(Number);

// Parses a decompiled entity lump (default_ents.vents) into plain objects.
function parseEntities(text) {
  return text.replace(/\r/g, '').split(/\n?====\d+====\n/).map((block) => {
    const e = {};
    for (const line of block.split('\n')) {
      const m = line.match(/^([A-Za-z_0-9]+)\s+(.*)$/);
      if (m) e[m[1]] = m[2].replace(/^"|"$/g, '');
    }
    return e;
  }).filter((e) => e.classname);
}

// What the renderer needs from the entities: where CS2 shows a weapon, its inspect cameras, the sun and the sky.
// Positions and angles stay in the game's own units (inches, Z up; angles pitch/yaw/roll in degrees).
function sceneInfo(ents) {
  const named = (n) => ents.find((e) => (e.targetname || '').replace('[PR#]', '') === n);
  const spotEnt = named('item') || ents.find((e) => e.classname === 'csgo_item_previewmodel');
  const cams = {};
  for (const e of ents.filter((x) => x.classname === 'point_camera_vertical_fov')) {
    const n = (e.targetname || '').replace('[PR#]', '');
    if (n && !/intro/.test(n)) cams[n] = { origin: vec(e.origin), angles: vec(e.angles), fov: +e.verticalfov || 35 };
  }
  const sun = ents.find((e) => e.classname === 'light_environment');
  const sky = ents.find((e) => e.classname === 'env_sky');
  return {
    item: spotEnt ? { origin: vec(spotEnt.origin), angles: vec(spotEnt.angles) } : null,
    cameras: cams,
    sun: sun ? { angles: vec(sun.angles), color: vec(sun.color), brightness: +sun.brightness || 1 } : null,
    sky: sky?.skyname?.replace(/^resource_name:"?|"$/g, '') || '',
  };
}

module.exports = { listVanity, parseEntities, sceneInfo, nameOf };
