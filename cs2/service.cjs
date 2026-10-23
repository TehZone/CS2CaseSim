// Main-process service: prepares everything the renderer needs to draw one skin on the real CS2 model.
const fs = require('fs');
const path = require('path');
const { CS2, findGameDir } = require('./pipeline.cjs');
const { pickClip, playClips } = require('./firstperson.cjs');
const { parseKV1 } = require('./kv.cjs');
const play = require('./play.cjs');
const { nameOf } = require('./vanity.cjs');

// Pixel-shader static combos of csgo_customweapon (feature F_X drives combo S_X).
const STATIC_COMBOS = ['S_PAINT_STYLE', 'S_OVERRIDE_NORMAL', 'S_USE_ALL_MASKS', 'S_ROUGHNESS_TEXTURE', 'S_PEARLESCENCE_MASK',
  'S_METALNESS_TEXTURE', 'S_SEPARATE_CHANNEL_INPUTS', 'S_OVERLAY_TEXTURE', 'S_CASE_HARDENING', 'S_CASE_HARDENING_TRILINEAR', 'S_PATINA_AGE'];

const toPosix = (p) => p.replace(/\\/g, '/');
const PISTOL_RE = /PISTOL/;
// Models for items without paint kits (not in the skin index).
const EXTRA_MODELS = {
  weapon_c4: 'weapons/models/c4/weapon_c4.vmdl', defuser: 'weapons/models/defuser/defuser.vmdl',
  weapon_hegrenade: 'weapons/models/grenade/hegrenade/weapon_hegrenade.vmdl', weapon_flashbang: 'weapons/models/grenade/flashbang/weapon_flashbang.vmdl',
  weapon_smokegrenade: 'weapons/models/grenade/smokegrenade/weapon_smokegrenade.vmdl', weapon_molotov: 'weapons/models/grenade/molotov/weapon_molotov.vmdl',
  weapon_incgrenade: 'weapons/models/grenade/incendiary/weapon_incendiarygrenade.vmdl', weapon_decoy: 'weapons/models/grenade/decoy/weapon_decoy.vmdl',
};

// Textures of a csgo_weapon_sticker material the renderer uses. Normal maps are kept raw (hemi-octahedral
// normal in RG, roughness in B, self-illum mask in A), exactly as CS2's sticker shader samples them.
const STICKER_TEXTURES = ['g_tSticker0', 'g_tSfxMaskSticker0', 'g_tHoloSpectrumSticker0', 'g_tStickerScratches', 'g_tColor'];
const STICKER_RAW_TEXTURES = ['g_tNormalRoughnessSticker0', 'g_tGlitterNormalSticker0'];
const STICKER_META_VERSION = 1;

// Folders whose textures were made smaller carry this stamp. Version 1 was written by Electron's resizer, which
// premultiplied alpha (textures keeping a mask in alpha came out dark or black), so those folders are exported again.
const SHRUNK = '.shrunk2';
const shrunkBadly = (dir) => fs.existsSync(path.join(dir, '.shrunk')) && !fs.existsSync(path.join(dir, SHRUNK));

// CS2's two-layer world materials blend a second layer in with vertex paint; the glTF export keeps the first only.
const LAYER_TEXTURES = ['g_tLayer2Color', 'g_tLayer2NormalRoughness', 'g_tBlendModulation'];
// Shaders of world geometry (big surfaces seen up close: their textures are kept sharper).
const WORLD_SHADERS = /lightmappedgeneric|static_overlay|environment_blend|csgo_environment\.vfx/i;

// Glove composite textures csgo_customglove samples as raw hemi-octahedral normals.
const GLOVE_RAW_TEXTURES = /^g_t(Normal|DetailNormal\d|DamageNormal\d|SurfaceNormal\d|SubstrateNormal\d|TintId)$/;

// CS2's own case-opening sounds.
const CASE_SOUNDS = {
  unlock: 'sounds/ui/panorama/case_unlock_01.vsnd',
  drop: 'sounds/ui/panorama/case_drop_01.vsnd',
  scroll: 'sounds/ui/csgo_ui_crate_item_scroll.vsnd',
  revealRare: 'sounds/ui/panorama/case_reveal_rare_01.vsnd',
  revealMythical: 'sounds/ui/panorama/case_reveal_mythical_01.vsnd',
  revealLegendary: 'sounds/ui/panorama/case_reveal_legendary_01.vsnd',
  revealAncient: 'sounds/ui/panorama/case_reveal_ancient_01.vsnd',
  knife: 'sounds/ui/panorama/item_showcase_knife_01.vsnd',
};

class CS2Service {
  // shrinkImages(files, maxSize): optional, makes backdrop textures smaller after export (Electron passes one).
  constructor({ cacheDir, cliPath, cliEnv = {}, log = () => {}, shrinkImages = null }) {
    this.shrinkImages = shrinkImages;
    this.vanityJobs = new Map();
    this.crateJobs = new Map();
    this.cacheDir = cacheDir;
    this.cliPath = cliPath;
    this.cliEnv = { VRF_GLSL_ES: '1', ...cliEnv };
    this.log = log;
    this.gameDir = undefined;
    this.cs2 = null;
    this.indexPromise = null;
    this.stickerJobs = new Map();
    this.stickerBatch = [];
    this.stickerTimer = null;
    this.playJobs = new Map();
    this.progress = new Map(); // job -> latest progress line (Play mode's first-time map export)
  }

  status() {
    if (this.gameDir === undefined) this.gameDir = findGameDir();
    const cli = !!this.cliPath && fs.existsSync(this.cliPath);
    return { available: !!this.gameDir && cli, gameDir: this.gameDir, cli, indexed: !!this.index };
  }

  url(file) {
    return 'cs2cache/' + toPosix(path.relative(this.cacheDir, file)).split('/').map(encodeURIComponent).join('/');
  }

  ensureCS2() {
    const st = this.status();
    if (!st.available) throw new Error(st.gameDir ? 'Model extractor is missing' : 'Counter-Strike 2 is not installed');
    if (!this.cs2) this.cs2 = new CS2({ cli: this.cliPath, gameDir: this.gameDir, cacheDir: this.cacheDir, env: this.cliEnv, log: this.log });
    return this.cs2;
  }

  // Viewmodel inspect clips in the game (listed once per game build).
  async viewmodelClips() {
    const cs2 = this.ensureCS2();
    const file = path.join(this.cacheDir, 'fp', 'clips.json');
    const stamp = cs2.vpkStamp();
    try { const c = JSON.parse(fs.readFileSync(file, 'utf8')); if (c.stamp === stamp) return c.clips; } catch {}
    const clips = (await cs2.list()).filter((f) => f.startsWith('animation/anims/viewmodel/') && f.endsWith('.vnmclip_c'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ stamp, clips }));
    return clips;
  }

  // First-person inspect for a weapon id: CS2's inspect clip (skeleton + animation) and the first-person arms.
  async firstPerson(weapon) {
    const cs2 = this.ensureCS2();
    const clip = pickClip(String(weapon), await this.viewmodelClips());
    if (!clip) throw new Error('No first-person inspect for ' + weapon);
    const name = clip.split('/').pop().replace(/.vnmclip_c$/, '');
    const clipFile = await cs2.exportGltf(clip, `fp/clips/${name}.glb`, { glb: true });
    const armsFile = await cs2.exportGltf('weapons/models/shared/arms/weapon_arms.vmdl', 'fp/arms/weapon_arms.gltf', { materials: true });
    return { clip: this.url(clipFile), arms: this.url(armsFile), name };
  }

  // CS2's glove inspect animation (both hands posed on the viewmodel skeleton): { clip } glTF URL.
  async gloveClip() {
    const cs2 = this.ensureCS2();
    const file = await cs2.exportGltf('animation/anims/viewmodel/arms/inspects/pedestal_gloves_loop.vnmclip_c', 'fp/clips/pedestal_gloves_loop.glb', { glb: true });
    return { clip: this.url(file) };
  }

  // Inspect backdrops (CS2's vanity maps) available in this install: [{ id, name }].
  vanityMaps() {
    if (!this.status().available) return [];
    return this.ensureCS2().vanityMaps().map(({ id, name }) => ({ id, name }));
  }

  // One backdrop, exported on first use: { glb: url, info: { item, cameras, sun, sky, name } }.
  vanity(id) {
    if (!this.vanityJobs.has(id)) {
      const job = (async () => {
        const cs2 = this.ensureCS2();
        const old = path.join(this.cacheDir, 'vanity', String(id));
        if (this.shrinkImages && shrunkBadly(old)) fs.rmSync(old, { recursive: true, force: true });
        const r = await cs2.exportVanity(String(id));
        const dir = path.dirname(r.glb);
        const stamp = path.join(dir, SHRUNK);
        if (this.shrinkImages && !fs.existsSync(stamp)) {
          // The backdrop is drawn blurred behind the weapon, so small textures are plenty (and load fast).
          const imgs = fs.readdirSync(dir).filter((f) => /.(png|jpe?g)$/i.test(f)).map((f) => path.join(dir, f));
          await this.shrinkImages(imgs, 512);
          fs.writeFileSync(stamp, '');
        }
        return { glb: this.url(r.glb), info: JSON.parse(fs.readFileSync(r.meta, 'utf8')) };
      })();
      this.vanityJobs.set(id, job);
      job.catch(() => this.vanityJobs.delete(id));
    }
    return this.vanityJobs.get(id);
  }

  // Container item id (items_game def index) -> its 3D crate model, read from items_game.txt once per game build.
  async crateModels() {
    if (!this.crateModelsJob) {
      this.crateModelsJob = (async () => {
        const cs2 = this.ensureCS2();
        const file = path.join(this.cacheDir, 'crates', 'models.json');
        const stamp = cs2.vpkStamp();
        try { const c = JSON.parse(fs.readFileSync(file, 'utf8')); if (c.stamp === stamp) return c.models; } catch {}
        await this.ensureIndex(); // extracts items_game.txt
        const ig = parseKV1(fs.readFileSync(path.join(this.cacheDir, 'items_game.txt'), 'utf8')).items_game;
        const models = {};
        for (const items of [].concat(ig.items || [])) {
          for (const [id, it] of Object.entries(items)) {
            const m = it?.model_player;
            if (typeof m === 'string' && m.startsWith('models/props/crates/')) models[id] = m;
          }
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ stamp, models }));
        return models;
      })();
      this.crateModelsJob.catch(() => { this.crateModelsJob = null; });
    }
    return this.crateModelsJob;
  }

  // A container's 3D crate with CS2's own "fall" and "open" animations: { model: url }, or null if it has none
  // (capsules, older souvenir packages).
  crate(id) {
    id = String(id);
    if (!this.crateJobs.has(id)) {
      const job = (async () => {
        if (!this.status().available) return null;
        const vmdl = (await this.crateModels())[id];
        if (!vmdl) return null;
        const name = path.basename(vmdl, '.vmdl');
        const old = path.join(this.cacheDir, 'crates', name);
        if (this.shrinkImages && shrunkBadly(old)) fs.rmSync(old, { recursive: true, force: true });
        const file = await this.ensureCS2().exportGltf(vmdl, `crates/${name}/${name}.gltf`, { materials: true, animations: true });
        const dir = path.dirname(file);
        const stamp = path.join(dir, SHRUNK);
        if (this.shrinkImages && !fs.existsSync(stamp)) {
          // Crate textures are up to 4K; the crate fills part of the screen for a few seconds.
          const imgs = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g)$/i.test(f)).map((f) => path.join(dir, f));
          await this.shrinkImages(imgs, 1024);
          fs.writeFileSync(stamp, '');
        }
        // Older crates paint their artwork with a decal texture over the base colour (second UV set), which the
        // glTF export leaves out: { material: url }.
        const g = JSON.parse(fs.readFileSync(file, 'utf8'));
        const want = {};
        for (const m of g.materials || []) {
          const v = m.extras?.vmat;
          if (v?.IntParams?.F_DECAL_TEXTURE && v.TextureParams?.g_tDecal) want[m.name] = v.TextureParams.g_tDecal;
        }
        const files = Object.keys(want).length ? await this.cs2.extract(Object.values(want)) : {};
        const decals = {};
        for (const [mat, vtex] of Object.entries(want)) {
          const local = files[vtex + '_c'];
          if (local) decals[mat] = this.url(local);
        }
        return { model: this.url(file), name, decals };
      })();
      this.crateJobs.set(id, job);
      job.catch(() => this.crateJobs.delete(id));
    }
    return this.crateJobs.get(id);
  }

  // CS2's case-opening sounds extracted from the player's install, as { name: url }.
  async sounds() {
    const files = await this.ensureCS2().extract(Object.values(CASE_SOUNDS));
    const out = {};
    for (const [name, vpk] of Object.entries(CASE_SOUNDS)) {
      const local = files[vpk + '_c'];
      if (local) out[name] = this.url(local);
    }
    return out;
  }

  async ensureIndex() {
    this.ensureCS2();
    if (!this.indexPromise) {
      this.indexPromise = this.cs2.buildIndex().then((idx) => (this.index = idx));
      this.indexPromise.catch(() => { this.indexPromise = null; });
    }
    return this.indexPromise;
  }

  // Export the model once; strip textures out of the glTF (the renderer loads the few it needs itself,
  // downscaled) and remember which texture files belong to which material.
  // One export per model at a time (a skin and the plain weapon can ask for the same model together).
  model(vmdl) {
    this.modelJobs ||= new Map();
    if (!this.modelJobs.has(vmdl)) {
      const job = this.exportModelInfo(vmdl);
      this.modelJobs.set(vmdl, job);
      job.catch(() => this.modelJobs.delete(vmdl));
    }
    return this.modelJobs.get(vmdl);
  }

  async exportModelInfo(vmdl) {
    let gltfFile = await this.cs2.exportModel(vmdl);
    // The textures the model's info lists must all be there (else the export was cut short: do it again).
    const infoFile0 = gltfFile.replace(/\.gltf$/, '.info.json');
    try {
      const info = JSON.parse(fs.readFileSync(infoFile0, 'utf8'));
      const files = Object.values(info.materials).flatMap((m) => [m.color, m.orm, m.normal]).filter(Boolean);
      const local = (u) => path.join(this.cacheDir, ...u.replace(/^cs2cache\//, '').split('/').map(decodeURIComponent));
      if (files.some((u) => !fs.existsSync(local(u)))) {
        fs.rmSync(path.dirname(gltfFile), { recursive: true, force: true });
        gltfFile = await this.cs2.exportModel(vmdl);
      }
    } catch {}
    const infoFile = gltfFile.replace(/\.gltf$/, '.info.json');
    if (fs.existsSync(infoFile)) return { gltfFile, info: JSON.parse(fs.readFileSync(infoFile, 'utf8')) };
    const g = JSON.parse(fs.readFileSync(gltfFile, 'utf8'));
    const dir = path.dirname(gltfFile);
    const img = (texIndex) => {
      const t = texIndex != null && g.textures?.[texIndex];
      const im = t && g.images?.[t.source];
      return im?.uri ? this.url(path.join(dir, decodeURIComponent(im.uri))) : null;
    };
    const materials = {};
    for (const m of g.materials || []) {
      materials[m.name] = {
        color: img(m.pbrMetallicRoughness?.baseColorTexture?.index),
        orm: img(m.pbrMetallicRoughness?.metallicRoughnessTexture?.index),
        normal: img(m.normalTexture?.index),
        alphaMode: m.alphaMode || 'OPAQUE',
      };
      delete m.normalTexture; delete m.occlusionTexture; delete m.emissiveTexture;
      if (m.pbrMetallicRoughness) { delete m.pbrMetallicRoughness.baseColorTexture; delete m.pbrMetallicRoughness.metallicRoughnessTexture; }
    }
    delete g.textures; delete g.images; delete g.samplers;
    const meshes = (g.meshes || []).map((m) => ({
      name: m.name.split('.').pop(),
      materials: m.primitives.map((p) => g.materials?.[p.material]?.name || ''),
    }));
    fs.writeFileSync(gltfFile, JSON.stringify(g));
    const info = { meshes, materials };
    fs.writeFileSync(infoFile, JSON.stringify(info));
    return { gltfFile, info };
  }

  // One sticker's CS2 material (`sticker_material` of its sticker kit, e.g. "standard/aces_high_holo"):
  // the material's parameters and its extracted textures as URLs. Requests made close together share
  // one CLI run (each run reloads the VPK), and the parameters are cached per game build.
  sticker(material) {
    material = String(material || '').toLowerCase();
    if (!/^[a-z0-9_\-/]+$/.test(material) || material.includes('..')) return Promise.reject(new Error('Bad sticker material: ' + material));
    if (!this.stickerJobs.has(material)) {
      const job = new Promise((resolve, reject) => {
        this.ensureCS2();
        this.stickerBatch.push({ material, resolve, reject });
        if (!this.stickerTimer) this.stickerTimer = setTimeout(() => this.flushStickers(), 25);
      });
      this.stickerJobs.set(material, job);
      job.catch(() => this.stickerJobs.delete(material));
    }
    return this.stickerJobs.get(material);
  }

  async flushStickers() {
    const batch = this.stickerBatch;
    this.stickerBatch = [];
    this.stickerTimer = null;
    try {
      const stamp = this.cs2.vpkStamp();
      const metaFile = (m) => path.join(this.cacheDir, 'stickers', m + '.json');
      const metas = {};
      for (const { material } of batch) {
        try {
          const m = JSON.parse(fs.readFileSync(metaFile(material), 'utf8'));
          if (m.version === STICKER_META_VERSION && m.stamp === stamp) metas[material] = m;
        } catch {}
      }
      const need = batch.map((b) => b.material).filter((m) => !metas[m]);
      if (need.length) {
        const found = await this.cs2.materialParams(need.map((m) => `stickers/${m}.vmat`));
        for (const m of need) {
          const p = found[`stickers/${m}.vmat`];
          if (!p) continue;
          metas[m] = { version: STICKER_META_VERSION, stamp, material: m, ...p };
          fs.mkdirSync(path.dirname(metaFile(m)), { recursive: true });
          fs.writeFileSync(metaFile(m), JSON.stringify(metas[m]));
        }
      }
      const pick = (names) => [...new Set(Object.values(metas).flatMap((m) => names.map((n) => m.textures[n]).filter(Boolean)))];
      const files = await this.cs2.extract(pick(STICKER_TEXTURES));
      const rawFiles = await this.cs2.extract(pick(STICKER_RAW_TEXTURES), { raw: true });
      for (const { material, resolve, reject } of batch) {
        const m = metas[material];
        if (!m) { reject(new Error('Sticker material not found: ' + material)); continue; }
        const textures = {};
        for (const [name, vtex] of Object.entries(m.textures)) {
          const local = (STICKER_RAW_TEXTURES.includes(name) ? rawFiles : STICKER_TEXTURES.includes(name) ? files : {})[vtex + '_c'];
          if (local) textures[name] = this.url(local);
        }
        resolve({ material, shader: m.shader, ints: m.ints, floats: m.floats, vectors: m.vectors, textures });
      }
    } catch (e) {
      for (const b of batch) b.reject(e);
    }
  }

  async prepare({ weapon, paint }) {
    const index = await this.ensureIndex();
    const w = index.weapons[weapon] || (EXTRA_MODELS[weapon] && { model: EXTRA_MODELS[weapon] });
    if (!w) throw new Error('Unknown weapon ' + weapon);
    const kit = paint ? index.paints[paint] : null;
    if (paint && !kit) throw new Error('Paint kit not found: ' + paint);

    const { gltfFile, info } = await this.model(w.model);
    const pick = (suffix) => info.meshes.find((m) => m.name.endsWith(suffix));
    const mesh = (kit?.legacy ? pick('body_legacy') || pick('body_hd') : pick('body_hd') || pick('body_legacy')) || info.meshes[0];
    const material = mesh.materials.find((n) => index.inputs[n]) || mesh.materials[0];
    const inputs = index.inputs[material] || null;

    if (kit?.shader === 'csgo_customglove') return this.prepareGlove(gltfFile, info, kit);
    const result = { model: this.url(gltfFile), meshes: info.meshes, mesh: mesh.name, material, materials: info.materials, inputs, kit, textures: {}, shader: null };
    if (!kit || !inputs) return result;

    // Every texture referenced by the weapon inputs and both paint passes.
    const vtex = new Set(Object.values(inputs.textures));
    for (const pass of [kit.color, kit.rough, kit.final]) {
      for (const v of Object.values(pass || {})) if (v && v.kind === 'texture' && v.value) vtex.add(v.value);
    }
    const files = await this.cs2.extract([...vtex]);
    for (const [vpk, local] of Object.entries(files)) {
      if (local) result.textures[vpk.replace(/_c$/, '')] = this.url(local);
    }

    const combo = STATIC_COMBOS.map((s) => {
      const f = 'F_' + s.slice(2);
      let v = kit.color[f];
      v = v?.kind === 'weapon' ? (f === 'F_SEPARATE_CHANNEL_INPUTS' ? inputs.separate : 0) : v?.value;
      return v ? `${s}=${v}` : null;
    }).filter(Boolean).join(',');
    result.shader = { combo, source: await this.cs2.shaderSource(kit.shader, combo || 'S_PAINT_STYLE=0') };
    return result;
  }

  // ---- Play mode ----------------------------------------------------------------------------------------
  // Shared one-time jobs (by key), dropped again if they fail so a retry runs them anew.
  playJob(key, fn) {
    if (!this.playJobs.has(key)) {
      const job = fn();
      this.playJobs.set(key, job);
      job.catch(() => this.playJobs.delete(key));
    }
    return this.playJobs.get(key);
  }

  // Maps in this install that can be played: [{ id, name }].
  playMaps() {
    if (!this.status().available) return [];
    let files = [];
    try { files = fs.readdirSync(path.join(this.gameDir, 'maps')); } catch {}
    return files.filter((f) => /^(de|cs)_[a-z0-9_]+\.vpk$/i.test(f) && !/_vanity|_dir\.vpk$|_\d{3}\.vpk$/i.test(f))
      .map((f) => { const id = f.replace(/\.vpk$/i, ''); return { id, name: nameOf(id) }; })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

// CS2's screenshot of every playable map, for the play menu's tiles (the 360p one, else a bigger one): { id: url }.
  playMapImages() {
    return this.playJob('mapImages', async () => {
      const ids = this.playMaps().map((m) => m.id);
      if (!ids.length) return {};
      const cs2 = this.ensureCS2();
      const all = new Set(await cs2.list());
      const pick = (id) => ['360p/' + id, '720p/' + id, '360p/' + id + '_1', '720p/' + id + '_1', '1080p/' + id]
        .map((n) => `panorama/images/map_icons/screenshots/${n}_png.vtex_c`).find((p) => all.has(p));
      const want = ids.map((id) => [id, pick(id)]).filter(([, p]) => p);
      const files = await cs2.extract(want.map(([, p]) => p));
      const out = {};
      for (const [id, p] of want) if (files[p]) out[id] = this.url(files[p]);
      return out;
    });
  }

  // A playable map, exported on first use into play/<id>/: { world, collision, lightmap, sky, info } (URLs + map data).
  playMap(id) {
    id = String(id);
    if (!/^[a-z0-9_]+$/i.test(id)) return Promise.reject(new Error('Bad map id'));
    return this.playJob('map:' + id, async () => {
      const cs2 = this.ensureCS2();
      const vpk = path.join(this.gameDir, 'maps', id + '.vpk');
      if (!fs.existsSync(vpk)) throw new Error('Map not installed: ' + id);
      const st = fs.statSync(vpk);
      const stamp = `${st.size}-${Math.round(st.mtimeMs)}`;
      const dir = path.join(this.cacheDir, 'play', id);
      const metaFile = path.join(dir, 'map.json');
      const result = async (meta) => ({
        id, name: meta.name, info: meta, nav: await this.playNav(id, vpk, dir), radar: await this.playRadar(id, dir),
        world: this.url(path.join(dir, 'world.glb')), collision: this.url(path.join(dir, 'collision.bin')),
        lightmap: meta.lightmap ? this.url(path.join(dir, 'lightmap.bin')) : null, sky: meta.sky ? this.url(path.join(dir, 'sky.png')) : null,
        probes: meta.lighting?.probes ? this.url(path.join(dir, 'probes.bin')) : null, lut: meta.lighting?.lut ? this.url(path.join(dir, 'lut.bin')) : null,
      });
      const say = (m) => { this.progress.set('map:' + id, m); this.log(`[play ${id}] ${m}`); };
      try {
        let meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
        if (meta.version === 2 && meta.stamp === stamp) meta = await this.upgradeMapLighting(id, vpk, dir, meta, say);
        if (meta.version === play.PLAY_VERSION && meta.stamp === stamp) { this.progress.delete('map:' + id); return result(meta); }
      } catch (e) { if (e?.code !== 'ENOENT') this.log('map cache: ' + e.message); }
      fs.rmSync(dir, { recursive: true, force: true });
      const tmp = path.join(dir, 'tmp');
      fs.mkdirSync(tmp, { recursive: true });

      say('Exporting the map from your CS2 install…');
      const glb = path.join(dir, 'world.glb');
      await cs2.run(['-i', vpk, '-f', `maps/${id}/world.vwrld_c`, '-d', '-o', glb, '--gltf_export_format', 'glb', '--gltf_export_materials', '--gltf_textures_adapt']);
      if (!fs.existsSync(glb)) throw new Error('Map export failed for ' + id);
      say('Reading collision and gameplay areas…');
      await cs2.run(['-i', vpk, '-f', `maps/${id}/world_physics.vmdl_c`, '-d', '-o', path.join(tmp, 'world_physics.glb'), '--gltf_export_format', 'glb']);
      await cs2.run(['-i', vpk, '-f', [`maps/${id}/entities/default_ents.vents_c`, `maps/${id}/lightmaps/irradiance.vtex_c`,
        `maps/${id}/lightmaps/direct_light_shadows.vtex_c`].join(','), '-d', '-o', tmp]);
      const entFile = path.join(tmp, 'maps', id, 'entities', 'default_ents.vents');
      const ents = fs.existsSync(entFile) ? play.parseEntities(fs.readFileSync(entFile, 'utf8')) : [];
      const physFile = [path.join(tmp, 'world_physics_physics.glb'), path.join(tmp, 'world_physics.glb')].find((f) => fs.existsSync(f));
      if (!physFile) throw new Error('No collision mesh in ' + id);
      const entPhysFile = path.join(dir, 'world_physics.glb'); // brush entities, exported along with the world
      const entPhys = fs.existsSync(entPhysFile) ? play.readGlb(entPhysFile) : null;
      const col = play.buildCollision(play.readGlb(physFile), entPhys, ents);
      fs.writeFileSync(path.join(dir, 'collision.bin'), col.buf);
      const volumes = play.gameVolumes(entPhys, ents);
      const info = play.mapInfo(ents);

      say('Baking the map\'s lighting…');
      let lightmap = null;
      const irr = path.join(tmp, 'maps', id, 'lightmaps', 'irradiance.exr');
      if (fs.existsSync(irr)) lightmap = play.bakeLightmap(irr, path.join(tmp, 'maps', id, 'lightmaps', 'direct_light_shadows.png'), path.join(dir, 'lightmap.bin'));
      say('Reading the light probes and post processing…');
      const lighting = await this.playLighting(vpk, dir, ents, info);
      let sky = false;
      if (info.sky) {
        try {
          const mat = (await cs2.materialParams([info.sky]))[info.sky];
          const vtex = mat?.textures?.g_tSkyTexture;
          const local = vtex && (await cs2.extract([vtex]))[vtex + '_c'];
          if (local && /\.exr$/i.test(local)) { play.bakeSky(local, path.join(dir, 'sky.png')); sky = true; }
        } catch (e) { this.log('sky: ' + e.message); }
      }

      say('Exporting the second texture layers…');
      const { json } = play.readGlb(glb);
      const layers = await this.playLayers(vpk, dir, json);

      say('Optimising textures…');
      if (this.shrinkImages) {
        // World surfaces (floors and walls, seen up close) keep twice the resolution of props.
        const world = new Set(Object.values(layers));
        const uri = (t) => t && json.images[json.textures[t.index]?.source]?.uri;
        for (const m of json.materials || []) {
          if (!WORLD_SHADERS.test(m.extras?.vmat?.ShaderName || '')) continue;
          for (const t of [m.pbrMetallicRoughness?.baseColorTexture, m.pbrMetallicRoughness?.metallicRoughnessTexture, m.normalTexture]) if (uri(t)) world.add(uri(t));
        }
        const imgs = fs.readdirSync(dir).filter((f) => /\.png$/i.test(f) && f !== 'sky.png');
        const group = (re, isWorld) => imgs.filter((f) => re.test(f) && world.has(f) === isWorld).map((f) => path.join(dir, f));
        for (const isWorld of [false, true]) {
          const k = isWorld ? 2 : 1;
          await this.shrinkImages(group(/_orm_/i, isWorld), 128 * k);
          await this.shrinkImages(group(/^(?!.*_orm_).*(normal|blendmod)/i, isWorld), 256 * k);
          await this.shrinkImages(group(/^(?!.*(_orm_|normal|blendmod))/i, isWorld), 512 * k);
        }
      }
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(entPhysFile, { force: true });
      const meta = {
        version: play.PLAY_VERSION, stamp, id, name: nameOf(id), ...info, ...volumes, lightmap, sky, layers, lighting,
        collision: { tris: col.tris, surfaces: col.surfaces, flags: { player: play.F_PLAYER, bullet: play.F_BULLET, grenade: play.F_GRENADE } },
      };
      fs.writeFileSync(metaFile, JSON.stringify(meta));
      this.progress.delete('map:' + id);
      return result(meta);
    });
  }

// CS2's lighting beyond the lightmap: the light probe atlas everything that isn't lightmapped is lit by
  // (probes.bin) and the post processing (tone mapping; the colour grading LUT as lut.bin). Returns what map.json keeps.
  async playLighting(vpk, dir, ents, info) {
    const cs2 = this.ensureCS2();
    const tmp = path.join(dir, 'tmp-lighting');
    const vols = play.probeVolumes(ents);
    const want = [vols[0]?.texture, vols[0]?.shadows, info.postProcessing].filter(Boolean);
    // Depth slices of a 3D texture: <name>_zNNN.<ext>.
    const slices = (vtex, ext) => {
      const b = path.join(tmp, vtex.replace(/\.vtex$/, '')), d = path.dirname(b), re = new RegExp('^' + path.basename(b).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '_z\\d+\\.' + ext + '$');
      return fs.existsSync(d) ? fs.readdirSync(d).filter((n) => re.test(n)).sort().map((n) => path.join(d, n)) : [];
    };
    const have = (f) => (/\.vtex$/.test(f) ? slices(f, /dlshd/.test(f) ? 'png' : 'exr').length > 0 : fs.existsSync(path.join(tmp, f)));
    // Files the map made are in its own VPK, the rest in the game's.
    for (const src of [vpk, cs2.vpk]) {
      const missing = want.filter((w) => !have(w));
      if (missing.length) await cs2.run(['-i', src, '-f', missing.map((w) => w + '_c').join(','), '-d', '-o', tmp]).catch(() => {});
    }
    const out = { probes: null, tonemap: null, lut: null };
    try {
      if (vols.length) {
        const irr = slices(vols[0].texture, 'exr'), sh = slices(vols[0].shadows, 'png');
        if (irr.length && sh.length) out.probes = { ...play.bakeProbes(irr, sh, path.join(dir, 'probes.bin')), volumes: vols.map(({ texture, shadows, ...v }) => v) };
      }
      if (info.postProcessing && have(info.postProcessing)) {
        const vpost = path.join(tmp, info.postProcessing);
        out.tonemap = play.toneMapping(fs.readFileSync(vpost, 'utf8'));
        const raw = vpost.replace(/\.vpost$/, '.raw'); // the LUT, written next to it (RGB, red fastest)
        const n = fs.existsSync(raw) ? Math.round(Math.cbrt(fs.statSync(raw).size / 3)) : 0;
        if (n > 1 && n ** 3 * 3 === fs.statSync(raw).size) { fs.copyFileSync(raw, path.join(dir, 'lut.bin')); out.lut = { size: n }; }
      }
    } catch (e) { this.log('lighting: ' + e.message); }
    fs.rmSync(tmp, { recursive: true, force: true });
    return out;
  }

  // Maps exported as version 2 get version 3's lighting without exporting everything again: the lightmap's sun mask
  // turned round (it held the shadow, not the light), the probes and the post processing.
  async upgradeMapLighting(id, vpk, dir, meta, say) {
    say('Updating the map\'s lighting…');
    const lm = path.join(dir, 'lightmap.bin');
    if (meta.lightmap && fs.existsSync(lm)) {
      const b = fs.readFileSync(lm);
      let masked = false;
      for (let i = 3; i < b.length && !masked; i += 4) masked = b[i] !== 255;
      if (masked) { for (let i = 3; i < b.length; i += 4) b[i] = 255 - b[i]; fs.writeFileSync(lm, b); }
    }
    const tmp = path.join(dir, 'tmp-ents');
    await this.ensureCS2().run(['-i', vpk, '-f', `maps/${id}/entities/default_ents.vents_c`, '-d', '-o', tmp]);
    const entFile = path.join(tmp, 'maps', id, 'entities', 'default_ents.vents');
    const ents = fs.existsSync(entFile) ? play.parseEntities(fs.readFileSync(entFile, 'utf8')) : [];
    fs.rmSync(tmp, { recursive: true, force: true });
    const info = play.mapInfo(ents);
    const lighting = await this.playLighting(vpk, dir, ents, info);
    const next = { ...meta, sun: info.sun, exposure: info.exposure, postProcessing: info.postProcessing, lighting, version: play.PLAY_VERSION };
    fs.writeFileSync(path.join(dir, 'map.json'), JSON.stringify(next));
    return next;
  }

  // The second layer of CS2's two-layer world materials (sand painted over asphalt, plaster over brick...): its colour
  // and normal map and the blend modulation texture, copied into the map folder. Returns { vtex path: file name }.
  async playLayers(vpk, dir, json) {
    const want = new Set();
    for (const m of json.materials || []) {
      const v = m.extras?.vmat;
      if (!v?.IntParams?.F_LAYERS) continue;
      for (const k of LAYER_TEXTURES) if (v.TextureParams?.[k]) want.add(v.TextureParams[k]);
    }
    if (!want.size) return {};
    const cs2 = this.ensureCS2();
    // Most are in the game's VPK; a map can bring its own.
    const found = await cs2.extract([...want]).catch(() => ({}));
    const rest = [...want].filter((f) => !found[f + '_c']);
    const tmp = path.join(dir, 'tmp-layers');
    for (let i = 0; i < rest.length; i += 40) await cs2.run(['-i', vpk, '-f', rest.slice(i, i + 40).map((f) => f + '_c').join(','), '-d', '-o', tmp]).catch(() => {});
    const out = {};
    for (const f of want) {
      const src = found[f + '_c'] || path.join(tmp, f.replace(/\.vtex$/, '.png'));
      if (!/\.png$/i.test(src) || !fs.existsSync(src)) continue;
      const name = 'layer_' + path.basename(src);
      fs.copyFileSync(src, path.join(dir, name));
      out[f] = name;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    return out;
  }

  // The map's nav mesh (bots walk on it) as play/<id>/nav.json; exported separately so older map exports gain it.
  async playNav(id, vpk, dir) {
    const file = path.join(dir, 'nav.json');
    let current = false;
    try { current = JSON.parse(fs.readFileSync(file, 'utf8')).version === play.NAV_VERSION; } catch {}
    if (!current) {
      try {
        const cs2 = this.ensureCS2();
        const tmp = path.join(dir, 'tmp-nav');
        await cs2.run(['-i', vpk, '-f', `maps/${id}.nav`, '-o', tmp]);
        const raw = path.join(tmp, 'maps', id + '.nav');
        if (!fs.existsSync(raw)) return null;
        const text = await cs2.run(['-i', raw], { env: { VRF_NAV_JSON: '1' } });
        fs.writeFileSync(file, JSON.stringify(play.compactNav(text)));
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch (e) { this.log('nav: ' + e.message); return null; }
    }
    return this.url(file);
  }

  // Latest progress line of a running Play mode export (null when idle).
  playProgress(key) { return this.progress.get(key) || null; }

  // Weapon stats and sound events, read once per game build: { weapons, sounds }.
  playData() {
    return this.playJob('data', async () => {
      const cs2 = this.ensureCS2();
      const file = path.join(this.cacheDir, 'play', 'data.json');
      const stamp = cs2.vpkStamp();
      try { const c = JSON.parse(fs.readFileSync(file, 'utf8')); if (c.stamp === stamp && c.version === play.DATA_VERSION) return c; } catch {}
      const tmp = path.join(this.cacheDir, 'play', 'tmp-data');
      const files = ['scripts/weapons.vdata_c', 'soundevents/game_sounds_weapons.vsndevts_c', 'soundevents/game_sounds_player.vsndevts_c',
        'soundevents/game_sounds_physics.vsndevts_c', 'soundevents/game_sounds_footsteps.vsndevts_c', 'soundevents/game_sounds_ui.vsndevts_c',
        'soundevents/vo/announcer/game_sounds_cs2_classic.vsndevts_c', 'soundevents/music/valve_cs2_01/game_sounds_music.vsndevts_c',
        ...['phoenix', 'leet', 'sas', 'seal'].map((a) => `soundevents/vo/agents/game_sounds_${a}.vsndevts_c`)]; // the bots' voices
      await cs2.run(['-i', cs2.vpk, '-f', files.join(','), '-d', '-o', tmp]);
      const read = (f) => fs.readFileSync(path.join(tmp, f.replace(/_c$/, '')), 'utf8');
      const weapons = play.weaponStats(read(files[0]));
      const sounds = {};
      for (const f of files.slice(1)) { try { Object.assign(sounds, play.soundEventFiles(read(f))); } catch (e) { this.log(`${f}: ${e.message}`); } }
      fs.rmSync(tmp, { recursive: true, force: true });
      const data = { version: play.DATA_VERSION, stamp, weapons, sounds };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data));
      return data;
    });
  }

  // Sound events -> { event: [urls] } (each event's variations, extracted from the install).
  async playSounds(events) {
    const { sounds } = await this.playData();
    const want = [...new Set(events)].filter((e) => sounds[e]);
    const files = await this.ensureCS2().extract(want.flatMap((e) => sounds[e]));
    const out = {};
    for (const e of want) out[e] = sounds[e].map((f) => files[f + '_c']).filter(Boolean).map((f) => this.url(f));
    return out;
  }

  // Everything to hold and fire a weapon in first person: { stats, clips: { role: url | [urls] }, arms, sounds }.
  playWeapon(weapon) {
    weapon = String(weapon);
    if (!/^weapon_[a-z0-9_]+$/.test(weapon)) return Promise.reject(new Error('Bad weapon id'));
    return this.playJob('weapon:' + weapon, async () => {
      const cs2 = this.ensureCS2();
      const data = await this.playData();
      const stats = data.weapons[weapon] || null;
      const found = playClips(weapon, await this.viewmodelClips());
      if (!found.idle && !found.draw) throw new Error('No first-person animations for ' + weapon);
      const files = await cs2.exportGlbBatch(Object.values(found).flat(), 'fp/batch');
      const url = (c) => (files[c] ? this.url(files[c]) : null);
      const clips = {};
      for (const [role, c] of Object.entries(found)) clips[role] = Array.isArray(c) ? c.map(url).filter(Boolean) : url(c);
      const arms = this.url(await cs2.exportGltf('weapons/models/shared/arms/weapon_arms.vmdl', 'fp/arms/weapon_arms.gltf', { materials: true }));
      const prefix = (stats?.shootSound || '').replace(/\.[^.]*$/, '.');
      const events = prefix.length > 1 ? Object.keys(data.sounds).filter((e) => e.startsWith(prefix) && !/Distant|_Q$|Inspect|LookAt/i.test(e)) : [];
      if (/knife|bayonet/.test(weapon)) events.push('Weapon_Knife.Deploy', 'Weapon_Knife.Hit', 'Weapon_Knife.HitWall', 'Weapon_Knife.Slash', 'Weapon_Knife.Stab');
      if (stats?.silencer && stats.silencer !== 'WEAPONSILENCER_NONE') events.push(...Object.keys(data.sounds).filter((e) => e.startsWith(prefix) && /Silenced/i.test(e)));
      events.push(PISTOL_RE.test(stats?.type || '') ? 'Default.ClipEmpty_Pistol' : 'Default.ClipEmpty_Rifle');
      return { weapon, stats, clips, arms, sounds: await this.playSounds(events) };
    });
  }

  // A character model for bots (agent .vmdl, e.g. "agents/models/tm_phoenix/tm_phoenix.vmdl"): { model } glTF URL.
  playAgent(vmdl) {
    vmdl = String(vmdl).replace(/\\/g, '/');
    if (!/^agents\/models\/[a-z0-9_/]+\.vmdl$/i.test(vmdl)) return Promise.reject(new Error('Bad agent model'));
    return this.playJob('agent:' + vmdl, async () => {
      const name = vmdl.split('/').pop().replace(/\.vmdl$/, '');
      const old = path.join(this.cacheDir, 'play', 'agents', name);
      if (this.shrinkImages && shrunkBadly(old)) fs.rmSync(old, { recursive: true, force: true });
      const file = await this.ensureCS2().exportGltf(vmdl, `play/agents/${name}/${name}.gltf`, { materials: true });
      const dir = path.dirname(file), stamp = path.join(dir, SHRUNK);
      if (this.shrinkImages && !fs.existsSync(stamp)) {
        await this.shrinkImages(fs.readdirSync(dir).filter((f) => /\.png$/i.test(f)).map((f) => path.join(dir, f)), 1024);
        fs.writeFileSync(stamp, '');
      }
      return { model: this.url(file), name };
    });
  }

  // Third-person animation clips by path under animation/anims/world/ (e.g. "rifle/_default_rifle/idle_rifle"):
  // { path: url }.
  async playAnims(list) {
    const ok = [...new Set(list)].filter((p) => /^[a-z0-9_/+.]+$/i.test(p) && !p.includes('..'));
    const vpk = (p) => `animation/anims/world/${p}.vnmclip_c`;
    const files = await this.ensureCS2().exportGlbBatch(ok.map(vpk), 'play/clips');
    const out = {};
    for (const p of ok) if (files[vpk(p)]) out[p] = this.url(files[vpk(p)]);
    return out;
  }

  // Weapon stats from weapons.vdata: { weapon_id: stats }.
  async playStats() { return (await this.playData()).weapons; }

  // The bots' voices (the agents' radio calls and chatter), by agent and line:
  // { phoenix: { enemyspotted: ['phoenix.radio_enemyspotted01', ...], ... }, leet, sas, seal }.
  async playVoices() {
    const { sounds } = await this.playData();
    const out = {};
    for (const e of Object.keys(sounds)) {
      const m = /^(phoenix|leet|sas|seal)\.(.+?)\d*$/i.exec(e);
      if (!m) continue;
      const key = m[2].toLowerCase().replace(/^radio[._]/, '').replace(/[^a-z]/g, '');
      ((out[m[1].toLowerCase()] ||= {})[key] ||= []).push(e);
    }
    return out;
  }

  // The map's radar (CS2's overview image and its placement): { image, x, y, scale } or null.
  async playRadar(id, dir) {
    const meta = path.join(dir, 'radar.json'), img = path.join(dir, 'radar.png');
    if (!fs.existsSync(meta)) {
      try {
        const cs2 = this.ensureCS2();
        const txt = `resource/overviews/${id}.txt`, tex = `panorama/images/overheadmaps/${id}_radar_psd.vtex`;
        const files = await cs2.extract([txt, tex]);
        const local = files[tex + '_c'], ovr = files[txt];
        if (!local || !ovr) return null;
        const kv = parseKV1(fs.readFileSync(ovr, 'utf8'));
        const o = kv[id] || Object.values(kv)[0] || {};
        fs.copyFileSync(local, img);
        fs.writeFileSync(meta, JSON.stringify({ x: +o.pos_x || 0, y: +o.pos_y || 0, scale: +o.scale || 1 }));
      } catch (e) { this.log('radar: ' + e.message); return null; }
    }
    return { image: this.url(img), ...JSON.parse(fs.readFileSync(meta, 'utf8')) };
  }

  // Default agent models per team (their item ids come from the agents in items_game).
  async agentModel(defIndex) {
    await this.ensureIndex();
    const ig = this.agentModels || (this.agentModels = (() => {
      const items = parseKV1(fs.readFileSync(path.join(this.cacheDir, 'items_game.txt'), 'utf8')).items_game;
      const out = {};
      for (const group of [].concat(items.items || [])) for (const [id, it] of Object.entries(group)) if (/^agents\//.test(it?.model_player || '')) out[id] = it.model_player;
      return out;
    })());
    return ig[String(defIndex)] || null;
  }

  // Glove kits use csgo_customglove, which CS2 runs once per hand (glove_*_left / glove_*_right materials of the
  // first-person "viewmodel" mesh). Normal maps stay raw (hemi-octahedral), as the shader samples them.
  async prepareGlove(gltfFile, info, kit) {
    const mesh = info.meshes.find((m) => m.name === 'viewmodel') || info.meshes[0];
    const hands = mesh.materials.filter((n) => /^glove_/.test(n));
    const tex = Object.entries(kit.color).filter(([, v]) => v?.kind === 'texture' && v.value);
    const isRaw = (n) => GLOVE_RAW_TEXTURES.test(n);
    const [files, rawFiles] = await Promise.all([
      this.cs2.extract(tex.filter(([n]) => !isRaw(n)).map(([, v]) => v.value)),
      this.cs2.extract(tex.filter(([n]) => isRaw(n)).map(([, v]) => v.value), { raw: true }),
    ]);
    const urls = (found) => Object.fromEntries(Object.entries(found).filter(([, f]) => f).map(([vpk, f]) => [vpk.replace(/_c$/, ''), this.url(f)]));
    // Older kits use the "Source1 texture layout"; the newest (Source2 height blending) layer surface and substrate
    // materials and may tint by ID. SPIRV-Cross needs GLSL ES 3.10 for that variant (the renderer converts it).
    const f = (n) => (kit.color[n]?.value ? 1 : 0);
    const layered = f('F_BACKWARDS_COMPATIBILITY');
    const combo = `S_BACKWARDS_COMPATIBILITY=${layered},S_ANISOTROPIC_GLOSS=${f('F_ANISOTROPIC_GLOSS')},S_TINT_ID=${layered && f('F_TINT_ID')}`;
    return {
      model: this.url(gltfFile), meshes: info.meshes, mesh: mesh.name, material: hands[0] || null, materials: info.materials,
      inputs: null, kit, glove: true, hands, textures: urls(files), rawTextures: urls(rawFiles),
      shader: { combo, layered: !!layered, source: await this.cs2.shaderSource(kit.shader, combo, { es: layered ? 310 : 300 }) },
    };
  }
}

module.exports = { CS2Service };
