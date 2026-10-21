// Main-process service: prepares everything the renderer needs to draw one skin on the real CS2 model.
const fs = require('fs');
const path = require('path');
const { CS2, findGameDir } = require('./pipeline.cjs');

// Pixel-shader static combos of csgo_customweapon (feature F_X drives combo S_X).
const STATIC_COMBOS = ['S_PAINT_STYLE', 'S_OVERRIDE_NORMAL', 'S_USE_ALL_MASKS', 'S_ROUGHNESS_TEXTURE', 'S_PEARLESCENCE_MASK',
  'S_METALNESS_TEXTURE', 'S_SEPARATE_CHANNEL_INPUTS', 'S_OVERLAY_TEXTURE', 'S_CASE_HARDENING', 'S_CASE_HARDENING_TRILINEAR', 'S_PATINA_AGE'];

const toPosix = (p) => p.replace(/\\/g, '/');

// CS2's own case-opening sounds.
const CASE_SOUNDS = {
  unlock: 'sounds/ui/panorama/case_unlock_01.vsnd',
  scroll: 'sounds/ui/csgo_ui_crate_item_scroll.vsnd',
  revealRare: 'sounds/ui/panorama/case_reveal_rare_01.vsnd',
  revealMythical: 'sounds/ui/panorama/case_reveal_mythical_01.vsnd',
  revealLegendary: 'sounds/ui/panorama/case_reveal_legendary_01.vsnd',
  revealAncient: 'sounds/ui/panorama/case_reveal_ancient_01.vsnd',
  knife: 'sounds/ui/panorama/item_showcase_knife_01.vsnd',
};

class CS2Service {
  constructor({ cacheDir, cliPath, cliEnv = {}, log = () => {} }) {
    this.cacheDir = cacheDir;
    this.cliPath = cliPath;
    this.cliEnv = { VRF_GLSL_ES: '1', ...cliEnv };
    this.log = log;
    this.gameDir = undefined;
    this.cs2 = null;
    this.indexPromise = null;
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
  async model(vmdl) {
    const gltfFile = await this.cs2.exportModel(vmdl);
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

  async prepare({ weapon, paint }) {
    const index = await this.ensureIndex();
    const w = index.weapons[weapon];
    if (!w) throw new Error('Unknown weapon ' + weapon);
    const kit = paint ? index.paints[paint] : null;
    if (paint && !kit) throw new Error('Paint kit not found: ' + paint);

    const { gltfFile, info } = await this.model(w.model);
    const pick = (suffix) => info.meshes.find((m) => m.name.endsWith(suffix));
    const mesh = (kit?.legacy ? pick('body_legacy') || pick('body_hd') : pick('body_hd') || pick('body_legacy')) || info.meshes[0];
    const material = mesh.materials.find((n) => index.inputs[n]) || mesh.materials[0];
    const inputs = index.inputs[material] || null;

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
}

module.exports = { CS2Service };
