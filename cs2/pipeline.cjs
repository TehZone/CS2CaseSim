// Reads the player's local CS2 install (via Source 2 Viewer CLI) to build an index of paint kits, weapon
// composite inputs and models, and extracts models/textures/shaders on demand into a local cache.
// Used by the Electron main process and by dev scripts. Nothing from the game is bundled with the app.
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { parseKV1, splitDataDump } = require('./kv.cjs');
const { listVanity, parseEntities, sceneInfo } = require('./vanity.cjs');

const INDEX_VERSION = 3;
// Parameters a weapon's composite_inputs material provides to the paint shader.
const WEAPON_KEYS = ['g_tAmbientOcclusion', 'g_tColor', 'g_tMasks', 'g_tMetalness', 'g_tPosition', 'g_tSurface',
  'g_flUvScale1', 'g_flWeaponLength1', 'F_SEPARATE_CHANNEL_INPUTS'];

// ---- locating the game --------------------------------------------------------------------
function steamRoots() {
  const roots = [];
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { encoding: 'utf8', windowsHide: true });
    const m = out.match(/SteamPath\s+REG_SZ\s+(.+)/);
    if (m) roots.push(m[1].trim().replace(/\//g, '\\'));
  } catch {}
  roots.push('C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam');
  return [...new Set(roots)];
}

function findGameDir() {
  const libs = new Set();
  for (const root of steamRoots()) {
    const vdf = path.join(root, 'steamapps', 'libraryfolders.vdf');
    if (!fs.existsSync(vdf)) continue;
    libs.add(root);
    try {
      const kv = parseKV1(fs.readFileSync(vdf, 'utf8'));
      for (const v of Object.values(kv.libraryfolders || {})) if (v && v.path) libs.add(v.path.replace(/\\\\/g, '\\'));
    } catch {}
  }
  for (const lib of libs) {
    const dir = path.join(lib, 'steamapps', 'common', 'Counter-Strike Global Offensive', 'game', 'csgo');
    try { if (fs.existsSync(path.join(dir, 'pak01_dir.vpk'))) return dir; } catch {}
  }
  return null;
}

// ---- helpers ------------------------------------------------------------------------------
const params = (mat) => {
  const p = { ints: {}, floats: {}, vectors: {}, textures: {}, strings: {} };
  for (const x of mat.m_intParams || []) p.ints[x.m_name] = x.m_nValue;
  for (const x of mat.m_floatParams || []) p.floats[x.m_name] = x.m_flValue;
  for (const x of mat.m_vectorParams || []) p.vectors[x.m_name] = x.m_value;
  for (const x of mat.m_textureParams || []) p.textures[x.m_name] = x.m_pValue;
  for (const x of mat.m_stringAttributes || []) p.strings[x.m_name] = x.m_value;
  return p;
};
const base = (p) => p.replace(/\\/g, '/').split('/').pop().replace(/\.[^.]+$/, '');

// A loose variable from a composite container -> { value, min, max, kind }
function looseVar(v) {
  const t = v.m_nVariableType || '';
  if (v.m_strTextureRuntimeResourcePath != null) return { kind: 'texture', value: v.m_strTextureRuntimeResourcePath };
  if (v.m_cValueColor4 != null) return { kind: 'color', value: v.m_cValueColor4.slice(0, 3).map((c) => c / 255) };
  if (t.includes('BOOLEAN') || v.m_bValueBoolean != null) return { kind: 'int', value: v.m_bValueBoolean ? 1 : 0 };
  if (t.includes('INTEGER')) return { kind: 'int', value: v.m_nValueIntX ?? 0 };
  if (t.includes('FLOAT2') || v.m_flValueFloatY != null) {
    return {
      kind: 'float2', value: [v.m_flValueFloatX ?? 0, v.m_flValueFloatY ?? 0],
      min: v.m_bHasFloatBounds || v.m_flValueFloatX_Min != null ? [v.m_flValueFloatX_Min ?? 0, v.m_flValueFloatY_Min ?? 0] : null,
      max: v.m_bHasFloatBounds || v.m_flValueFloatX_Max != null ? [v.m_flValueFloatX_Max ?? 0, v.m_flValueFloatY_Max ?? 0] : null,
    };
  }
  if (t.includes('STRING')) return { kind: 'string', value: v.m_strStringValue ?? '' };
  return {
    kind: 'float', value: v.m_flValueFloatX ?? 0,
    min: v.m_flValueFloatX_Min ?? null, max: v.m_flValueFloatX_Max ?? null,
  };
}

class CS2 {
  constructor({ cli, gameDir, cacheDir, env = {}, log = () => {} }) {
    this.cli = cli;
    this.gameDir = gameDir;
    this.vpk = path.join(gameDir, 'pak01_dir.vpk');
    this.shaderVpk = path.join(gameDir, 'shaders_vulkan_dir.vpk');
    this.cacheDir = cacheDir;
    this.env = env;
    this.log = log;
    this.queue = Promise.resolve();
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  // Runs the CLI (serialised; the tool preloads the whole VPK on each start).
  run(args, { capture = true } = {}) {
    const job = () => new Promise((resolve, reject) => {
      const p = spawn(this.cli, args, { env: { ...process.env, ...this.env }, windowsHide: true });
      const out = [], err = [];
      p.stdout.on('data', (d) => capture && out.push(d));
      p.stderr.on('data', (d) => err.push(d));
      p.on('error', reject);
      p.on('close', (code) => {
        const text = Buffer.concat(out).toString('utf8');
        if (code !== 0 && !text) reject(new Error(`Source2Viewer-CLI exited ${code}: ${Buffer.concat(err).toString().slice(0, 500)}`));
        else resolve(text);
      });
    });
    const r = this.queue.then(job, job);
    this.queue = r.catch(() => {});
    return r;
  }

  vpkStamp() {
    const st = fs.statSync(this.vpk);
    return `${st.size}-${Math.round(st.mtimeMs)}`;
  }

  async dump(filter, ext, vpk = this.vpk) {
    const args = ['-i', vpk, '-f', filter, '-b', 'DATA'];
    if (ext) args.push('-e', ext);
    return splitDataDump(await this.run(args));
  }

  async list(vpk = this.vpk) {
    const text = await this.run(['-i', vpk, '-l']);
    return text.split(/\r?\n/).map((l) => l.split(' ')[0]).filter(Boolean);
  }

  // Extract (and decompile) VPK files into the cache, preserving their paths. Returns local paths.
  // `raw` keeps textures exactly as the shaders sample them (no normal map reconstruction), in files-raw/.
  async extract(files, { raw = false } = {}) {
    const root = raw ? 'files-raw' : 'files';
    const want = [...new Set(files.map((f) => f.replace(/\\/g, '/').replace(/(\.v\w+)$/, '$1_c').replace(/_c_c$/, '_c')))];
    const missing = want.filter((f) => !this.localPathFor(f, root));
    for (let i = 0; i < missing.length; i += 40) {
      const args = ['-i', this.vpk, '-f', missing.slice(i, i + 40).join(','), '-d', '-o', path.join(this.cacheDir, root)];
      if (raw) args.push('--texture_decode_flags', 'none');
      await this.run(args);
    }
    return Object.fromEntries(want.map((f) => [f, this.localPathFor(f, root)]));
  }

  // Decompiled texture lands as .png or .exr next to the VPK-relative path.
  localPathFor(vpkFile, root = 'files') {
    const rel = vpkFile.replace(/_c$/, '');
    if (rel.endsWith('.vsnd')) {
      for (const ext of ['.wav', '.mp3']) {
        const p = path.join(this.cacheDir, root, rel.replace(/\.vsnd$/, ext));
        if (fs.existsSync(p)) return p;
      }
      return null;
    }
    const stem = path.join(this.cacheDir, root, rel.replace(/\.vtex$/, ''));
    for (const ext of ['.png', '.exr', '']) {
      const p = rel.endsWith('.vtex') ? stem + ext : path.join(this.cacheDir, root, rel);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    }
    return null;
  }

  // Parameters of compiled materials ({ path: { shader, ints, floats, vectors, textures } }), many per CLI run.
  async materialParams(vmats) {
    const out = {};
    for (let i = 0; i < vmats.length; i += 40) {
      const docs = await this.dump(vmats.slice(i, i + 40).map((f) => f.replace(/\.vmat$/, '.vmat_c')).join(','), null);
      for (const [p, mat] of Object.entries(docs)) {
        const { ints, floats, vectors, textures } = params(mat);
        out[p] = { shader: (mat.m_shaderName || '').replace(/\.vfx$/, ''), ints, floats, vectors, textures };
      }
    }
    return out;
  }

  async exportModel(vmdl) {
    const name = base(vmdl);
    const dir = path.join(this.cacheDir, 'models', name);
    const file = path.join(dir, name + '.gltf');
    if (fs.existsSync(file)) return file;
    fs.mkdirSync(dir, { recursive: true });
    await this.run(['-i', this.vpk, '-f', vmdl.replace(/(\.vmdl)$/, '$1_c'), '-d', '-o', file,
      '--gltf_export_format', 'gltf', '--gltf_export_materials', '--gltf_textures_adapt']);
    if (!fs.existsSync(file)) throw new Error('Model export failed for ' + vmdl);
    return file;
  }

  // Exports any model/animation resource to glTF in the cache (first-person arms and inspect clips).
  async exportGltf(file, rel, { materials = false, glb = false } = {}) {
    const out = path.join(this.cacheDir, rel);
    if (fs.existsSync(out)) return out;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const args = ['-i', this.vpk, '-f', file.replace(/(.vw+)$/, '$1_c').replace(/_c_c$/, '_c'), '-o', out, '--gltf_export_format', glb ? 'glb' : 'gltf'];
    if (materials) args.push('--gltf_export_materials', '--gltf_textures_adapt');
    await this.run(args);
    for (const f of fs.readdirSync(path.dirname(out))) if (/_physics.(glb|gltf)$/i.test(f)) fs.rmSync(path.join(path.dirname(out), f), { force: true });
    if (!fs.existsSync(out)) throw new Error('Export failed for ' + file);
    return out;
  }

  // The inspect/menu backdrops in this install (maps/<id>_vanity.vpk).
  vanityMaps() {
    return listVanity(path.join(this.gameDir, 'maps'));
  }

  // Exports one backdrop's world to glTF (with its materials) and its entities to scene.json. Cached.
  async exportVanity(id) {
    const map = this.vanityMaps().find((m) => m.id === id);
    if (!map) throw new Error('Unknown backdrop ' + id);
    const vpk = path.join(this.gameDir, 'maps', map.vpk);
    const base = map.vpk.replace(/.vpk$/i, '');
    const dir = path.join(this.cacheDir, 'vanity', id);
    const glb = path.join(dir, 'scene.glb'), meta = path.join(dir, 'scene.json');
    if (fs.existsSync(glb) && fs.existsSync(meta)) return { glb, meta, fresh: false };
    fs.mkdirSync(dir, { recursive: true });
    await this.run(['-i', vpk, '-f', `maps/${base}/world.vwrld_c`, '-d', '-o', glb,
      '--gltf_export_format', 'glb', '--gltf_export_materials', '--gltf_textures_adapt']);
    if (!fs.existsSync(glb)) throw new Error('Backdrop export failed for ' + id);
    for (const f of fs.readdirSync(dir)) if (/_physics.glb$/i.test(f)) fs.rmSync(path.join(dir, f), { force: true });
    const entDir = path.join(dir, 'ents');
    await this.run(['-i', vpk, '-f', `maps/${base}/entities/default_ents.vents_c`, '-d', '-o', entDir]);
    const entFile = path.join(entDir, 'maps', base, 'entities', 'default_ents.vents');
    const info = fs.existsSync(entFile) ? sceneInfo(parseEntities(fs.readFileSync(entFile, 'utf8'))) : {};
    fs.rmSync(entDir, { recursive: true, force: true });
    fs.writeFileSync(meta, JSON.stringify({ id, name: map.name, ...info }));
    return { glb, meta, fresh: true };
  }

  // GLSL ES 3.00 for one static combo of a compiled pixel shader (needs the patched CLI).
  async shaderSource(shader, combo) {
    const key = `${shader}__${combo.replace(/[^\w=,]/g, '').replace(/[=,]/g, '_')}`;
    const file = path.join(this.cacheDir, 'shaders', key + '.frag');
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = await this.run(['-i', this.shaderVpk, '-f', `shaders/vfx/${shader}_vulkan_50_ps.vcs`, '--shader_combo', combo, '-q']);
    if (!/#version 300 es/.test(text)) throw new Error('Shader decompile failed: ' + text.slice(0, 300));
    fs.writeFileSync(file, text);
    return text;
  }

  // ---------------------------------------------------------------------------------------
  async buildIndex() {
    const indexFile = path.join(this.cacheDir, 'index.json');
    const stamp = this.vpkStamp();
    try {
      const cur = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      if (cur.version === INDEX_VERSION && cur.stamp === stamp) return cur;
    } catch {}

    this.log('Reading items_game.txt…');
    const igFile = path.join(this.cacheDir, 'items_game.txt');
    await this.run(['-i', this.vpk, '-f', 'scripts/items/items_game.txt', '-o', igFile]);
    const ig = parseKV1(fs.readFileSync(igFile, 'utf8')).items_game;

    this.log('Reading paint kits…');
    const compmats = await this.dump('weapons/paints/', 'vcompmat_c');
    const gloveMats = await this.dump('gloves/paints/', 'vcompmat_c,vmat_c');
    const paintVmats = await this.dump('materials/models/weapons/customization/paints/vmats/', 'vmat_c');
    const templates = await this.dump('workshop/paintkits/', 'vmat_c');
    this.log('Reading weapon composite inputs…');
    const all = await this.list();
    const inputFiles = all.filter((f) => /composite_inputs\.vmat_c$/.test(f));
    const inputs = {};
    for (let i = 0; i < inputFiles.length; i += 60) Object.assign(inputs, await this.dump(inputFiles.slice(i, i + 60).join(','), null));

    const materials = { ...paintVmats, ...templates, ...gloveMats };
    const compByName = {}, compByPath = {};
    for (const [p, doc] of Object.entries({ ...compmats, ...gloveMats })) {
      if (!p.endsWith('.vcompmat')) continue;
      compByPath[p] = { path: p, doc };
      if (!base(p).startsWith('_')) compByName[base(p)] = compByPath[p];
    }

    // Weapon composite inputs keyed by the weapon material they belong to (glTF material name).
    const inputsByMaterial = {};
    for (const [p, mat] of Object.entries(inputs)) {
      const pr = params(mat);
      const layer = pr.strings.layer_name_1;
      if (!layer) continue;
      inputsByMaterial[base(layer)] = {
        path: p,
        separate: pr.ints.F_SEPARATE_CHANNEL_INPUTS || 0,
        uvScale: pr.floats.g_flUvScale1 ?? 1,
        weaponLength: pr.floats.g_flWeaponLength1 ?? 36,
        textures: pr.textures,
      };
    }

    // Weapons: model per item (resolving prefabs).
    const resolve = (item, key) => {
      let cur = item, guard = 0;
      while (cur && guard++ < 20) {
        if (cur[key]) return cur[key];
        const pf = cur.prefab && ig.prefabs[cur.prefab.split(' ')[0]];
        cur = pf;
      }
      return null;
    };
    const weapons = {};
    for (const item of Object.values(ig.items || {})) {
      if (!item || !item.name) continue;
      const model = resolve(item, 'model_player');
      if (model && /\.vmdl$/.test(model)) weapons[item.name] = { model };
    }

    this.log('Resolving paint kits…');
    const paints = {};
    for (const [id, kit] of Object.entries(ig.paint_kits || {})) {
      if (!kit || !kit.name || kit.name === 'default') continue;
      const comp = compByName[kit.name];
      if (!comp) continue;
      try {
        paints[kit.name] = this.resolvePaint(kit, +id, comp, compByPath, materials);
      } catch (e) {
        this.log(`  skipped ${kit.name}: ${e.message}`);
      }
    }

    const index = { version: INDEX_VERSION, stamp, builtAt: new Date().toISOString(), weapons, inputs: inputsByMaterial, paints };
    fs.writeFileSync(indexFile, JSON.stringify(index));
    this.log(`Indexed ${Object.keys(paints).length} paint kits, ${Object.keys(inputsByMaterial).length} weapon materials.`);
    return index;
  }

  // Runs the composite-material program far enough to know, for the colour and roughness passes,
  // which shader variant and parameters are used and which variables the seed randomises.
  resolvePaint(kit, id, comp, compByPath, materials) {
    const procs = [];
    const collect = (doc, seen = new Set()) => {
      for (const point of doc.m_Points || []) {
        for (const proc of point.m_vecCompositeMaterialAssemblyProcedures || []) {
          for (const inc of proc.m_vecCompMatIncludes || []) {
            const n = inc.replace(/\\/g, '/');
            if (!seen.has(n) && compByPath[n]) { seen.add(n); collect(compByPath[n].doc, seen); }
          }
          procs.push(proc);
        }
      }
    };
    collect(comp.doc);

    // Containers (later procedures override earlier ones with the same alias).
    const containers = {};
    let paintMaterial = null;
    for (const proc of procs) {
      for (const c of proc.m_vecCompositeInputContainers || []) {
        const type = c.m_nCompositeMaterialInputContainerSourceType;
        const alias = c.m_strAlias;
        if (type === 'CONTAINER_SOURCE_TYPE_SPECIFIC_MATERIAL') {
          const mp = (c.m_strSpecificContainerMaterial || '').replace(/\\/g, '/');
          const mat = materials[mp];
          if (alias === 'paint') paintMaterial = mp;
          if (mat) containers[alias] = { kind: 'material', vars: materialVars(mat) };
        } else if (type === 'CONTAINER_SOURCE_TYPE_LOOSE_VARIABLES') {
          const prev = containers[alias]?.vars || {};
          const vars = { ...prev };
          for (const v of c.m_vecLooseVariables || []) vars[v.m_strName] = looseVar(v);
          containers[alias] = { kind: 'loose', vars };
        } else if (type === 'CONTAINER_SOURCE_TYPE_MATERIAL_FROM_TARGET_ATTR') {
          containers[alias] = { kind: 'weapon' };
        } else {
          containers[alias] = containers[alias] || { kind: 'target' };
        }
      }
    }
    if (!paintMaterial || !containers.paint) throw new Error('no paint material');

    // Randomised variables, in roll order.
    const rolls = [];
    const walk = (list, fn) => { for (const m of list || []) { fn(m); if (m.m_vecConditionalMutators) walk(m.m_vecConditionalMutators, fn); } };
    for (const proc of procs) {
      walk(proc.m_vecPropertyMutators, (m) => {
        if (m.m_nMutatorCommandType !== 'COMP_MAT_PROPERTY_MUTATOR_RANDOM_ROLL_INPUT_VARIABLES') return;
        if (!/g_nRandomSeed$/.test(m.m_strRandomRollInputVars_SeedInputVar || '')) return;
        for (const spec of m.m_vecRandomRollInputVars_InputVarsToRoll || []) {
          const [alias, name, comps] = spec.split('.');
          const v = containers[alias]?.vars?.[name];
          if (!v) continue;
          rolls.push({ alias, name, comps: comps.length, min: v.min, max: v.max });
        }
      });
    }

    // Evaluate GENERATE_TEXTURE programs for colour and roughness passes.
    const passes = {};
    const finalProps = {};
    const condOk = (conds) => (conds || []).every((c) => {
      const v = containers[c.m_strMutatorConditionContainerName]?.vars?.[c.m_strMutatorConditionContainerVarName];
      if (c.m_nMutatorCondition === 'COMP_MAT_MUTATOR_CONDITION_INPUT_CONTAINER_VALUE_EXISTS') return v != null;
      if (c.m_nMutatorCondition === 'COMP_MAT_MUTATOR_CONDITION_INPUT_CONTAINER_VALUE_EQUALS') {
        const want = c.m_strMutatorConditionContainerVarValue;
        const have = v?.value;
        return String(have === true ? 1 : have === false ? 0 : have) === String(want === 'true' ? 1 : want === 'false' ? 0 : want);
      }
      return true;
    });
    const copyFrom = (alias, into) => {
      const c = containers[alias];
      if (!c) return;
      if (c.kind === 'weapon') {
        for (const k of WEAPON_KEYS) into[k] = { kind: 'weapon', name: k };
        return;
      }
      for (const [k, v] of Object.entries(c.vars || {})) {
        if (alias === 'econ_instance' || alias === 'grunge_wear') into[k] = { kind: 'instance', alias, name: k, base: v };
        else into[k] = v;
      }
    };
    for (const proc of procs) {
      walk(proc.m_vecPropertyMutators, (m) => {
        const type = m.m_nMutatorCommandType;
        if (type === 'COMP_MAT_PROPERTY_MUTATOR_GENERATE_TEXTURE') {
          const target = m.m_strGenerateTexture_TargetParam;
          const vars = {};
          copyFrom(m.m_strGenerateTexture_InitialContainer, vars);
          for (const ins of m.m_vecTexGenInstructions || []) {
            if (!condOk(ins.m_vecConditions)) continue;
            if (ins.m_nMutatorCommandType === 'COMP_MAT_PROPERTY_MUTATOR_COPY_MATCHING_KEYS') copyFrom(ins.m_strCopyMatchingKeys_InputContainerSrc, vars);
            else if (ins.m_nMutatorCommandType === 'COMP_MAT_PROPERTY_MUTATOR_COPY_PROPERTY') {
              const src = containers[ins.m_strCopyProperty_InputContainerSrc];
              if (src?.kind === 'weapon' || src?.kind === 'target') vars[ins.m_strCopyProperty_TargetProperty] = { kind: 'weapon', name: ins.m_strCopyProperty_InputContainerProperty };
              else { const v = src?.vars?.[ins.m_strCopyProperty_InputContainerProperty]; if (v) vars[ins.m_strCopyProperty_TargetProperty] = v; }
            } else if (ins.m_nMutatorCommandType === 'COMP_MAT_PROPERTY_MUTATOR_SET_VALUE') {
              const sv = ins.m_nSetValue_Value;
              vars[sv.m_strName] = looseVar(sv);
            }
          }
          passes[target] = vars;
        } else if (type === 'COMP_MAT_PROPERTY_MUTATOR_COPY_PROPERTY' && condOk(m.m_vecConditions)) {
          const src = containers[m.m_strCopyProperty_InputContainerSrc];
          const v = src?.vars?.[m.m_strCopyProperty_InputContainerProperty];
          if (v) finalProps[m.m_strCopyProperty_TargetProperty] = v;
        }
      });
    }
    const color = passes.g_tColor;
    if (!color) throw new Error('no colour pass');
    const strip = (vars) => Object.fromEntries(Object.entries(vars).filter(([k]) => k !== '$weapon'));
    const shader = containers.paint ? (materials[paintMaterial]?.m_shaderName || 'csgo_customweapon.vfx') : 'csgo_customweapon.vfx';
    return {
      id,
      legacy: kit.use_legacy_model === '1',
      wear: [parseFloat(kit.wear_remap_min ?? 0), parseFloat(kit.wear_remap_max ?? 1)],
      compmat: comp.path,
      paint: paintMaterial,
      shader: shader.replace(/\.vfx$/, ''),
      color: strip(color),
      rough: passes.g_tMetalness ? strip(passes.g_tMetalness) : null,
      final: finalProps,
      rolls,
    };
  }
}

// Material params as loose-variable-like entries.
function materialVars(mat) {
  const pr = params(mat);
  const vars = {};
  for (const [k, v] of Object.entries(pr.ints)) vars[k] = { kind: 'int', value: v };
  for (const [k, v] of Object.entries(pr.floats)) vars[k] = { kind: 'float', value: v };
  for (const [k, v] of Object.entries(pr.vectors)) vars[k] = /^g_vColor\d$/.test(k) ? { kind: 'color', value: v.slice(0, 3) } : { kind: 'vec', value: v };
  for (const [k, v] of Object.entries(pr.textures)) vars[k] = { kind: 'texture', value: v };
  vars.$shader = { kind: 'string', value: mat.m_shaderName };
  return vars;
}

module.exports = { CS2, findGameDir, INDEX_VERSION };
