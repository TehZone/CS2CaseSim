// Steam Workshop weapon finishes as custom skins (CUSTOM_CONTENT.md, section 10): the importer behind
// scripts/import-workshop.mjs.
//
// Steam never downloads a weapon finish. Subscribing to one only counts as a vote, since maps are the only "ready to use"
// Workshop items, and Steam's API gives out no file for a finish. So the finish comes from its creator's own files, which
// are what CS2's Workshop tools save:
//   cs2-econitem   a CS2 addon (content/csgo_addons/<addon>/, a folder or a zip of it): the finish's .econitem (KV3: its
//                  style as composite_material_class, its settings as composite_material_keys, preview_weapon) and the
//                  .tga textures it names (weapons/paints/workshop/<name>/<name>_color.tga, _normal, _rough...)
//   cs2-vcompmat   a finish's .vcompmat (CCompositeMaterialEditorDoc, as Valve ships the finishes it accepts) or its
//                  compiled .vcompmat_c, with its .tga sources or compiled .vtex_c textures
//   csgo-zip       a CS:GO-era upload (myweaponfinishes/<name>.zip): the workbench .txt, the .tga art and normal map, and
//                  a .vtf, which isn't needed
// Either way the finish is one of CS2's own Workshop templates plus its settings and textures, which is exactly what a
// custom skin is, so it maps straight onto skin.json. The Workshop item itself gives only who made it and where it is
// (Steam's public metadata); the item never comes from there.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readImage, capSize, encode } from './images.mjs';
import { extractZip, listVpk } from './archives.mjs';
import { STYLES, GLOVES, buildCustom, norm, workshopUrl } from '../build-custom.mjs';

const require = createRequire(import.meta.url);
const { parseKV1, parseKV3 } = require('../../cs2/kv.cjs');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CLI = path.join(ROOT, 'tools', 's2v', 'Source2Viewer-CLI.exe');
export const STAGING = path.join(ROOT, 'custom-staging');
const UA = 'workshop-import (metadata only)';
const TEXTURE_KEEP = 2048; // (the build ships textures at 2048 at most: bigger sources only bloat the packs in git)

// ---- what CS2's Workshop finishes are ---------------------------------------------------------------------------------
// CS2's Workshop templates (workshop/paintkits/templates/<name>.vcompmat) and the custom-skin style each one is made as
// (STYLES in scripts/build-custom.mjs). An _extended template is its base plus overlay, metalness, glitter, iridescence and
// its own wear and grunge textures. A style of null isn't offered by custom skins yet (CUSTOM_CONTENT.md section 11).
export const TEMPLATES = {
  custom_paint_job: { style: 'Custom Paint Job' }, custom_paint_job_extended: { style: 'Custom Paint Job', base: 'custom_paint_job' },
  patina: { style: 'Patina' }, patina_extended: { style: 'Patina', base: 'patina' },
  gunsmith: { style: 'Gunsmith' }, gunsmith_extended: { style: 'Gunsmith', base: 'gunsmith' },
  hydrographic: { style: 'Hydrographic' }, hydrographic_extended: { style: 'Hydrographic', base: 'hydrographic' },
  spraypaint: { style: 'Spray-Paint' }, spraypaint_extended: { style: 'Spray-Paint', base: 'spraypaint' },
  anodized_multicolor: { style: 'Anodized Multicolored' }, anodized_airbrushed: { style: 'Anodized Airbrushed' },
  solid_color: { style: 'Solid Color' }, solid_color_extended: { style: 'Solid Color', base: 'solid_color' },
  anodized: { style: 'Anodized' },
  spraypaint_halftone: { style: null, label: 'Spray-Paint Halftone' }, case_hardening: { style: null, label: 'Case Hardening' },
  gunsmith_case_hardening: { style: null, label: 'Gunsmith Case Hardening' }, solid_color_case_hardening: { style: null, label: 'Solid Color Case Hardening' },
  glove: { style: null, label: 'Gloves' },
};
// An .econitem's composite_material_class, PaintKit_<class> (the classes of CS2's item editor,
// resource/toolhelp_cs2_item_editor_english.txt).
export const CLASSES = {
  CustomPaintJob: 'custom_paint_job', CustomPaintJobExtended: 'custom_paint_job_extended', Patina: 'patina', PatinaExtended: 'patina_extended',
  Gunsmith: 'gunsmith', GunsmithExtended: 'gunsmith_extended', GunsmithCaseHardening: 'gunsmith_case_hardening', HydroGraphic: 'hydrographic',
  HydroGraphicExtended: 'hydrographic_extended', SprayPaint: 'spraypaint', SprayPaintExtended: 'spraypaint_extended', SprayPaintHalftone: 'spraypaint_halftone',
  AnodizedMulticolor: 'anodized_multicolor', AnodizedAirbrushed: 'anodized_airbrushed', SolidColor: 'solid_color', SolidColorExtended: 'solid_color_extended',
  SolidColorCaseHardening: 'solid_color_case_hardening', CaseHardening: 'case_hardening', Anodized: 'anodized',
};
// A .vcompmat's template, by the material its "paint" input is (workshop/paintkits/templates/<x>.vmat).
const VMATS = {
  cu_template: 'custom_paint_job', cu_extended_template: 'custom_paint_job_extended', aq_template: 'patina', aq_extended_template: 'patina_extended',
  aq_case_hardening_template: 'case_hardening', gs_template: 'gunsmith', gs_extended_template: 'gunsmith_extended', gs_case_hardening_template: 'gunsmith_case_hardening',
  hy_template: 'hydrographic', hy_extended_template: 'hydrographic_extended', sp_template: 'spraypaint', sp_extended_template: 'spraypaint_extended',
  sp_halftone_template: 'spraypaint_halftone', so_template: 'solid_color', so_extended_template: 'solid_color_extended',
  so_case_hardening_template: 'solid_color_case_hardening', an_template: 'anodized', an_multi_template: 'anodized_multicolor', aa_template: 'anodized_airbrushed',
  glove_compositor: 'glove',
};
// CS:GO's paint kit styles (a workbench .txt's "style", as items_game numbers them).
const LEGACY_STYLES = { 1: 'solid_color', 2: 'hydrographic', 3: 'spraypaint', 4: 'anodized', 5: 'anodized_multicolor', 6: 'anodized_airbrushed', 7: 'custom_paint_job', 8: 'patina', 9: 'gunsmith' };

// What each supported template lets a finish set (its exposed variables, as alias.name), read from CS2's own templates.
const PLACE = ['econ_instance.g_flWearAmount', 'econ_instance.g_flPatternTexCoordRotation', 'econ_instance.g_vPatternTexCoordOffset'];
const COMMON = ['g_bUseNormalMap', 'g_tNormal', 'g_bUsePearlescenceMask', 'g_tPearlescenceMask', 'g_flPearlescentScale', 'g_flPaintRoughness', 'g_bUseRoughness', 'g_tPaintRoughness', 'g_bOverrideAmbientOcclusion', 'g_tFinalAmbientOcclusion'];
const COLORS = ['g_vColor0', 'g_vColor1', 'g_vColor2', 'g_vColor3'];
const PATTERN = ['g_tPattern', 'g_flPatternTexCoordScale', 'g_bIgnoreWeaponSizeScale'];
const MASKS = ['g_bOverrideDefaultMasks', 'g_tPaintByNumberMasks'];
const BY_COLOR = ['g_bUseRoughnessByColor', 'g_vPaintRoughness', 'g_vPaintMetalness', 'g_vPaintDurability'];
const ep = (list) => list.map((k) => (k.includes('.') ? k : 'exposed_params.' + k));
export const BASE_VARS = {
  custom_paint_job: ep([...PLACE, ...PATTERN, ...COMMON]),
  patina: ep([...PLACE, ...COLORS, ...PATTERN, ...COMMON, ...MASKS]),
  gunsmith: ep([...PLACE, ...COLORS, ...PATTERN, ...COMMON, ...MASKS]),
  anodized_multicolor: ep([...PLACE, ...COLORS, ...PATTERN, ...COMMON, ...MASKS]),
  anodized_airbrushed: ep([...PLACE, ...COLORS, ...PATTERN, ...COMMON, ...MASKS]),
  hydrographic: ep([...PLACE, ...COLORS, ...PATTERN, ...COMMON, ...MASKS, ...BY_COLOR]),
  spraypaint: ep([...PLACE, ...COLORS, ...PATTERN, ...COMMON, ...MASKS, ...BY_COLOR, 'g_bUsePaintByNumberMasks', 'g_vSprayBlend']),
  solid_color: ep(['econ_instance.g_flWearAmount', ...COLORS, ...COMMON, ...MASKS, ...BY_COLOR]),
  anodized: ep(['econ_instance.g_flWearAmount', 'g_vColor0', ...COMMON, ...MASKS]),
};
// The features only the _extended templates have, and how to tell a finish uses one. A finish that does can't be made
// exactly yet: the importer stops unless told to leave them out (--allow-loss).
const EXT_FEATURES = [
  ['an overlay texture', (v, own) => on(v, 'g_bUseOverlay') || own('g_tOverlay')],
  ['a metalness texture', (v, own) => on(v, 'g_bUseMetalness') || own('g_tPaintMetalness')],
  ['glitter', (v) => num1(v, 'g_fGlitterIntensity') > 0],
  ['iridescence', (v) => num1(v, 'g_flIridescentStrength') > 0],
  ['its own wear texture', (v, own) => on(v, 'g_bOverrideWearTexture') || own('g_tWear')],
  ['its own grunge texture', (v, own) => on(v, 'g_bOverrideGrungeTexture') || own('g_tGrunge')],
  ['an aged-patina ramp', (v, own) => own('g_tPatinaAgeColorRamp') || own('g_tPatinaAgeMask') || num1(v, 'g_flPatinaColorize') > 0],
];
const on = (v, k) => v.get('exposed_params.' + k)?.kind === 'bool' && v.get('exposed_params.' + k).value === true;
const num1 = (v, k) => (v.get('exposed_params.' + k)?.kind === 'float' ? v.get('exposed_params.' + k).value[0] : 0);
// The texture roles of a custom skin folder (scripts/build-custom.mjs TEXTURES), the template variable each one fills and
// the switch that turns it on in the template (the main texture has none).
const TEXTURES = [
  ['color', 'exposed_params.g_tPattern', null],
  ['normal', 'exposed_params.g_tNormal', 'exposed_params.g_bUseNormalMap'],
  ['roughness', 'exposed_params.g_tPaintRoughness', 'exposed_params.g_bUseRoughness'],
  ['pearlescence', 'exposed_params.g_tPearlescenceMask', 'exposed_params.g_bUsePearlescenceMask'],
  ['ao', 'exposed_params.g_tFinalAmbientOcclusion', 'exposed_params.g_bOverrideAmbientOcclusion'],
  ['masks', 'exposed_params.g_tPaintByNumberMasks', 'exposed_params.g_bOverrideDefaultMasks'],
];
// CS2's own textures a template points at until a creator picks theirs (never the creator's files).
const isValveDefault = (p) => /^(materials\/default\/|workshop\/paintkits\/templates\/|materials\/models\/weapons\/customization\/)/.test(relPath(p));

// ---- reading the creator's files --------------------------------------------------------------------------------------
// Settings as { 'alias.name': V }, V one of { kind: 'float', value: [x, y...], min?: [...], max?: [...] }, { kind: 'bool',
// value }, { kind: 'color', value: [r, g, b] (0-255) }, { kind: 'int', value }, { kind: 'texture', paths: [...] }.
const kindOf = (name) => (/^g_t/.test(name) ? 'texture' : /^(g_b|b_)/.test(name) ? 'bool' : /^g_[vc]Color/.test(name) ? 'color' : /^(g_n|F_)/.test(name) ? 'int' : 'float');
const toNum = (x) => (typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' && Number.isFinite(+x) ? +x : null);
function toBool(x) {
  if (typeof x === 'boolean') return x;
  if (x === 1 || x === '1' || /^true$/i.test(String(x))) return true;
  if (x === 0 || x === '0' || /^false$/i.test(String(x))) return false;
  return null;
}
export function toColor(x) {
  if (typeof x === 'string') {
    const m = /^#?([0-9a-f]{6})$/i.exec(x.trim());
    if (m) { const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
    x = x.trim().split(/[\s,]+/).map(Number);
  }
  if (!Array.isArray(x) || x.length < 3 || !x.slice(0, 3).every((c) => Number.isFinite(+c))) return null;
  const c = x.slice(0, 3).map(Number);
  // (0-255, as the item editor saves them; 0-1 floats are scaled.)
  const unit = c.every((v) => v >= 0 && v <= 1) && c.some((v) => !Number.isInteger(v));
  return c.map((v) => Math.max(0, Math.min(255, Math.round(unit ? v * 255 : v))));
}
const hex = (c) => '#' + c.map((x) => x.toString(16).padStart(2, '0')).join('');

// An .econitem's composite_material_keys: "econ_instance.g_flWearAmount = [min, value, max]", one line per component for
// vectors ("econ_instance.g_vPatternTexCoordOffset.0 = [min, value, max]"), colours as [r, g, b], textures as paths.
function settingsFromKeys(keys, notes) {
  const out = new Map(), odd = [];
  for (const [k, raw] of Object.entries(keys || {})) {
    const m = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)(?:\.([0-3]))?$/.exec(k);
    if (!m) { odd.push(k); continue; }
    const key = m[1] + '.' + m[2], kind = kindOf(m[2]), comp = m[3] == null ? null : +m[3];
    if (kind === 'texture') { if (typeof raw === 'string' && raw.trim()) out.set(key, { kind, paths: [raw.trim()] }); continue; }
    if (kind === 'bool') { const b = toBool(raw); if (b != null) out.set(key, { kind, value: b }); else odd.push(k); continue; }
    if (kind === 'color') { const c = toColor(raw); if (c) out.set(key, { kind, value: c }); else odd.push(k); continue; }
    if (kind === 'int') { const n = toNum(raw); if (n != null) out.set(key, { kind, value: Math.round(n) }); else odd.push(k); continue; }
    const v = out.get(key) || { kind: 'float', value: [] };
    const put = (i, x) => {
      // A number, or [min, value, max]: the range the item's seed picks it from.
      if (Array.isArray(x) && x.length === 3 && x.every((y) => toNum(y) != null)) { (v.min ||= [])[i] = +x[0]; v.value[i] = +x[1]; (v.max ||= [])[i] = +x[2]; return true; }
      if (toNum(x) != null) { v.value[i] = +x; return true; }
      return false;
    };
    let ok;
    if (comp != null) ok = put(comp, raw);
    else if (Array.isArray(raw) && /^g_v/.test(m[2]) && raw.every((y) => toNum(y) != null)) { v.value = raw.map(Number); ok = true; }
    else ok = put(0, raw);
    if (ok) out.set(key, v); else odd.push(k);
  }
  for (const v of out.values()) if (v.kind === 'float') { v.value = Array.from(v.value, (x) => x ?? 0); }
  if (odd.length) notes.push(`not read (an unexpected form): ${odd.join(', ')}`);
  return out;
}

// The finish an .econitem describes, or null if the file isn't one.
export function readEconitem(file) {
  let root;
  try { root = parseKV3(fs.readFileSync(file, 'utf8')); } catch { return null; }
  let node = null;
  const visit = (o, depth = 0) => {
    if (node || !o || typeof o !== 'object' || depth > 6) return;
    if (typeof o.composite_material_class === 'string') { node = o; return; }
    for (const v of Object.values(o)) visit(v, depth + 1);
  };
  visit(root);
  if (!node) return null;
  if (root?.cs2_item_type && root.cs2_item_type !== 'CCS2EconNode_PaintKit') return null;
  const notes = [];
  const cls = String(node.composite_material_class).replace(/^PaintKit_/, '');
  // (composite_material_keys are what the creator set; all_composite_material_keys, when there, every setting.)
  const values = settingsFromKeys({ ...(node.all_composite_material_keys || {}), ...(node.composite_material_keys || {}) }, notes);
  return {
    format: 'cs2-econitem', file, cls, template: CLASSES[cls] ?? null, values, notes,
    weapon: typeof node.preview_weapon === 'string' && /^weapon_\w+$/.test(node.preview_weapon) ? node.preview_weapon : null,
    finishName: path.basename(file).replace(/\.econitem$/i, ''),
  };
}

// The finish a .vcompmat (CCompositeMaterialEditorDoc, parsed) describes: its template by its "paint" material, its
// settings by the template's exposed variables. Null if it isn't one.
export function readVcompmat(doc, file) {
  if (doc?._class !== 'CCompositeMaterialEditorDoc') return null;
  let template = null, vmat = null;
  const values = new Map();
  const A = ['X', 'Y', 'Z', 'W'];
  for (const point of doc.m_Points || []) for (const proc of point.m_vecCompositeMaterialAssemblyProcedures || []) for (const c of proc.m_vecCompositeInputContainers || []) {
    if (c.m_strAlias === 'paint' && typeof c.m_strSpecificContainerMaterial === 'string') { vmat = c.m_strSpecificContainerMaterial; template ??= VMATS[path.posix.basename(vmat).replace(/\.vmat$/, '')] ?? null; }
    if (c.m_nCompositeMaterialInputContainerSourceType !== 'CONTAINER_SOURCE_TYPE_LOOSE_VARIABLES') continue;
    for (const v of c.m_vecLooseVariables || []) {
      if (!v.m_bExposeExternally || !v.m_strName) continue;
      const key = c.m_strAlias + '.' + v.m_strName, type = String(v.m_nVariableType || '').replace('LOOSE_VARIABLE_TYPE_', '');
      if (values.has(key)) continue;
      const fl = /^FLOAT([1-4])$/.exec(type);
      if (fl) {
        const n = +fl[1], x = { kind: 'float', value: A.slice(0, n).map((a) => +(v['m_flValueFloat' + a] ?? 0)) };
        if (v.m_bHasFloatBounds) { x.min = A.slice(0, n).map((a) => +(v[`m_flValueFloat${a}_Min`] ?? x.value[0])); x.max = A.slice(0, n).map((a) => +(v[`m_flValueFloat${a}_Max`] ?? x.value[0])); }
        values.set(key, x);
      } else if (type === 'BOOLEAN') values.set(key, { kind: 'bool', value: !!v.m_bValueBoolean });
      else if (type === 'COLOR4' && toColor(v.m_cValueColor4)) values.set(key, { kind: 'color', value: toColor(v.m_cValueColor4) });
      else if (/^INTEGER/.test(type)) values.set(key, { kind: 'int', value: +(v.m_nValueIntX ?? 0) });
      else if (type === 'RESOURCE_TEXTURE') values.set(key, { kind: 'texture', paths: [v.m_strTextureContentAssetPath, v.m_strTextureRuntimeResourcePath].filter((p) => typeof p === 'string' && p) });
    }
  }
  return { format: 'cs2-vcompmat', file, template, vmat, values, notes: [], weapon: null, finishName: path.basename(file).replace(/\.vcompmat(_c)?$/i, '') };
}

// A compiled .vcompmat_c, read through Source2Viewer (tools/s2v).
function readCompiled(file, cli) {
  if (!fs.existsSync(cli)) throw new Error(`${path.basename(file)} is compiled: reading it needs Source2Viewer-CLI.exe in tools/s2v`);
  const text = execFileSync(cli, ['-i', file, '-b', 'DATA'], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
  const i = text.indexOf('--- Data for block "DATA" ---');
  if (i < 0) throw new Error(`${path.basename(file)} has no data Source2Viewer can read`);
  return readVcompmat(parseKV3(text.slice(i)), file);
}

// A CS:GO workbench .txt (KeyValues). Its exact layout was never published (and CS2's files no longer have one), so this
// takes the block with CS:GO's paint kit keys, as items_game had them; `recognised` is false when there's no such block.
const LEGACY_KEYS = ['style', 'color0', 'color1', 'color2', 'color3', 'pattern', 'normal', 'pattern_scale', 'pattern_offset_x_start', 'pattern_offset_x_end',
  'pattern_offset_y_start', 'pattern_offset_y_end', 'pattern_rotate_start', 'pattern_rotate_end', 'wear_remap_min', 'wear_remap_max', 'wear_default',
  'ignore_weapon_size_scale', 'phongexponent', 'phongintensity', 'phongalbedoboost', 'phongalbedofactor', 'view_model_exponent_override_size', 'only_first_material'];
export function readLegacy(file, files) {
  let kv;
  try { kv = parseKV1(fs.readFileSync(file, 'utf8')); } catch { return null; }
  let best = null, score = 0, weapon = null;
  const keys = new Set();
  const visit = (o, depth = 0) => {
    if (!o || typeof o !== 'object' || depth > 6) return;
    const low = Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));
    const s = LEGACY_KEYS.filter((k) => low[k] != null && typeof low[k] !== 'object').length;
    if (s > score) { best = low; score = s; }
    for (const [k, v] of Object.entries(o)) {
      keys.add(k);
      if (typeof v === 'string' && !weapon && /^weapon_[a-z0-9_]+$/.test(v)) weapon = v;
      visit(v, depth + 1);
    }
  };
  visit(kv);
  const base = { format: 'csgo-zip', file, weapon, finishName: path.basename(file).replace(/\.txt$/i, '').replace(/-txt$/i, ''), notes: [], keys: [...keys] };
  const style = best ? toNum(best.style) : null;
  if (!best || !LEGACY_STYLES[style]) return { ...base, recognised: false, template: null, values: new Map() };
  const values = new Map(), f = (k, d = 0) => toNum(best[k]) ?? d;
  for (let i = 0; i < 4; i++) { const c = best['color' + i] != null ? toColor(best['color' + i]) : null; if (c) values.set('exposed_params.g_vColor' + i, { kind: 'color', value: c }); }
  if (best.pattern_scale != null) values.set('exposed_params.g_flPatternTexCoordScale', { kind: 'float', value: [f('pattern_scale', 1)] });
  const xs = f('pattern_offset_x_start'), xe = f('pattern_offset_x_end', xs), ys = f('pattern_offset_y_start'), ye = f('pattern_offset_y_end', ys);
  values.set('econ_instance.g_vPatternTexCoordOffset', { kind: 'float', value: [xs, ys], min: [xs, ys], max: [xe, ye] });
  const rs = f('pattern_rotate_start'), re = f('pattern_rotate_end', rs);
  values.set('econ_instance.g_flPatternTexCoordRotation', { kind: 'float', value: [rs], min: [rs], max: [re] });
  if (best.wear_remap_min != null || best.wear_remap_max != null) {
    const lo = f('wear_remap_min', 0), hi = f('wear_remap_max', 1);
    values.set('econ_instance.g_flWearAmount', { kind: 'float', value: [toNum(best.wear_default) ?? lo], min: [lo], max: [hi] });
  }
  if (best.ignore_weapon_size_scale != null) values.set('exposed_params.g_bIgnoreWeaponSizeScale', { kind: 'bool', value: toBool(best.ignore_weapon_size_scale) === true });
  // Its art: the "pattern" it names (a texture name, without .tga), else the one picture in the upload that isn't a normal map.
  const tgas = files.filter((x) => /\.(tga|png)$/i.test(x));
  const art = best.pattern ? [best.pattern + '.tga', best.pattern + '.png', best.pattern] : tgas.filter((x) => !/normal/i.test(path.basename(x)));
  if (art.length) values.set('exposed_params.g_tPattern', { kind: 'texture', paths: art });
  const normal = best.normal ? [best.normal + '.tga', best.normal] : tgas.filter((x) => /_normal\.(tga|png)$/i.test(x));
  if (normal.length) { values.set('exposed_params.g_bUseNormalMap', { kind: 'bool', value: true }); values.set('exposed_params.g_tNormal', { kind: 'texture', paths: normal }); }
  const phong = ['phongexponent', 'phongintensity', 'phongalbedoboost', 'phongalbedofactor'].filter((k) => best[k] != null);
  if (phong.length) base.notes.push(`CS:GO's shine settings (${phong.join(', ')}) have no CS2 equivalent: CS2's template sets the paint's roughness`);
  return { ...base, recognised: true, template: LEGACY_STYLES[style], values };
}

// ---- the creator's files, found -----------------------------------------------------------------------------------------
function walk(root, max = 20000) {
  const out = [];
  const go = (dir, depth) => {
    if (depth > 16) return;
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= max) throw new Error(`${root} holds over ${max} files: point at the finish's own folder`);
      const f = path.join(dir, d.name);
      // (Links aren't followed: nothing outside the folder is read.)
      if (d.isDirectory()) go(f, depth + 1); else if (d.isFile()) out.push(f);
    }
  };
  go(root, 0);
  return out;
}
// A path as the creator's tools wrote it (absolute on their PC, from their addon's root, or a compiled resource name),
// relative to an addon's root.
function relPath(p) {
  let q = String(p).trim().replace(/^resource(_name)?:/, '').replace(/\\/g, '/').toLowerCase();
  const a = /(?:^|\/)(?:content|game)\/csgo_addons\/[^/]+\/(.*)$/.exec(q) || /(?:^|\/)csgo_addons\/[^/]+\/(.*)$/.exec(q);
  if (a) q = a[1];
  return q.replace(/^[a-z]:\//, '').replace(/^\/+/, '');
}
// Finds a texture the creator's files name, among those files only.
function resolver(root, files) {
  const rel = files.map((f) => ({ f, r: path.relative(root, f).replace(/\\/g, '/').toLowerCase() }));
  const inside = new Set(files.map((f) => path.resolve(f).toLowerCase()));
  return (p) => {
    if (typeof p !== 'string' || !p.trim()) return null;
    // (A path to one of these files itself. Any other absolute path is the creator's own PC's: only its tail is used.)
    if (path.isAbsolute(p) && inside.has(path.resolve(p).toLowerCase())) return path.resolve(p);
    const q = relPath(p), names = [q];
    if (/\.vtex$/.test(q)) names.push(q + '_c', q.replace(/_(tga|png|psd|jpg)_[0-9a-f]+\.vtex$/, '.$1'), q.replace(/_(tga|png|psd|jpg)_[0-9a-f]+\.vtex$/, '.png'));
    if (/\.tga$/.test(q)) names.push(q.replace(/\.tga$/, '.png'));
    if (/\.png$/.test(q)) names.push(q.replace(/\.png$/, '.tga'));
    if (!/\.\w+$/.test(q)) names.push(q + '.tga', q + '.png');
    for (const n of names) {
      const exact = rel.find((x) => x.r === n);
      if (exact) return exact.f;
      const tail = rel.filter((x) => x.r.endsWith('/' + n));
      if (tail.length === 1) return tail[0].f;
    }
    // (Last, by its file name alone: a creator who sent their textures loose.)
    for (const n of names) {
      const b = n.split('/').pop(), hits = rel.filter((x) => x.r.split('/').pop() === b);
      if (hits.length === 1) return hits[0].f;
    }
    return null;
  };
}
// A texture file as RGBA: PNG or TGA, or a compiled .vtex_c through Source2Viewer.
function loadTexture(file, tmp, cli) {
  if (!/\.vtex_c$/i.test(file)) return readImage(file);
  if (!fs.existsSync(cli)) throw new Error(`${path.basename(file)} is a compiled CS2 texture: reading it needs Source2Viewer-CLI.exe in tools/s2v`);
  const out = path.join(tmp, `vtex-${fs.readdirSync(tmp).length}.png`);
  execFileSync(cli, ['-i', file, '-o', out], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!fs.existsSync(out)) throw new Error(`Source2Viewer couldn't read ${path.basename(file)}`);
  return readImage(out);
}

// Which finish the files hold: the creator's .econitem first, else a .vcompmat (text, then compiled), else a CS:GO
// workbench .txt. `pick` chooses one by name when there are several.
export function findFinish(root, files, { pick = null, cli = CLI } = {}) {
  const want = (s) => !pick || norm(s.finishName) === norm(pick);
  const tiers = [
    () => files.filter((f) => /\.econitem$/i.test(f)).map(readEconitem).filter(Boolean),
    () => files.filter((f) => /\.vcompmat$/i.test(f)).map((f) => { try { return readVcompmat(parseKV3(fs.readFileSync(f, 'utf8')), f); } catch { return null; } }).filter(Boolean),
    () => files.filter((f) => /\.vcompmat_c$/i.test(f)).map((f) => readCompiled(f, cli)).filter(Boolean),
    () => files.filter((f) => /\.txt$/i.test(f) && !/^publish_data\.txt$/i.test(path.basename(f))).map((f) => readLegacy(f, files)).filter((x) => x?.recognised),
  ];
  for (const tier of tiers) {
    const all = tier(), found = all.filter(want);
    if (found.length === 1) return found[0];
    if (found.length > 1) throw new Error(`the files hold ${found.length} finishes (${found.map((s) => s.finishName).join(', ')}): pick one with --item <name>`);
    if (all.length && pick) throw new Error(`no finish called "${pick}" (there's ${all.map((s) => s.finishName).join(', ')})`);
  }
  // A CS:GO upload (its .vtf gives it away) whose workbench .txt this can't read: said so, rather than "no finish".
  const vtf = files.find((f) => /\.vtf$/i.test(f));
  if (vtf) {
    const txts = files.filter((f) => /\.txt$/i.test(f) && !/^publish_data\.txt$/i.test(path.basename(f)));
    const stem = (f) => path.basename(f).replace(/\.\w+$/, '').replace(/-txt$/i, '').toLowerCase();
    const txt = txts.find((f) => stem(f) === stem(vtf)) || (txts.length === 1 ? txts[0] : null);
    if (txt) return readLegacy(txt, files) || { format: 'csgo-zip', file: txt, recognised: false, keys: [], template: null, values: new Map(), notes: [], weapon: null, finishName: stem(txt) };
  }
  return null;
}

// ---- the game's weapons -----------------------------------------------------------------------------------------------
const loose = (s) => String(s ?? '').toLowerCase().replace(/★/g, '').replace(/[^a-z0-9]/g, '');
export function weaponTable(game) {
  const weapons = new Map();
  for (const s of Object.values(game.skins)) if (!weapons.has(s.wid) && (s.wid.startsWith('weapon_') || s.cat === 'gloves')) weapons.set(s.wid, { wid: s.wid, w: s.w, cat: s.cat });
  for (const [wid, g] of Object.entries(GLOVES)) weapons.set(wid, { wid, w: g.name, cat: 'gloves' });
  const byName = new Map([...weapons.values()].map((x) => [loose(x.w), x.wid]));
  byName.set(loose('Sawed-Off Shotgun'), 'weapon_sawedoff'); // (the Workshop's tag for it)
  const find = (s) => (s == null ? null : weapons.get(weapons.has(s) ? s : byName.get(loose(s))) ?? null);
  return { weapons, find };
}
const WEARS = [['FN', 0, 0.07], ['MW', 0.07, 0.15], ['FT', 0.15, 0.38], ['WW', 0.38, 0.45], ['BS', 0.45, 1]];
const wearsIn = (mn, mx) => WEARS.filter(([, lo, hi]) => mx > lo && mn < hi).map(([k]) => k);

// A Workshop title as "<weapon> | <finish>": { weapon?, finish } or { unclear } (a version, a variant or a third part).
export function parseTitle(t) {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim().replace(/^★\s*/, '').replace(/\s*(\|\s*)?[([]?\bCS2\b[)\]]?\s*$/i, '').trim();
  const parts = s.split(/\s*\|\s*/).filter(Boolean);
  if (!parts.length || parts.length > 2) return { unclear: true };
  const finish = parts.at(-1);
  if (/[()[\]{}]|\bv\d+(\.\d+)?$/i.test(finish) || finish.length > 40) return { unclear: true, ...(parts.length === 2 ? { weapon: parts[0] } : {}) };
  return parts.length === 2 ? { weapon: parts[0], finish } : { finish };
}
const titleCase = (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

// ---- Steam's public metadata (who made it, never its files) ---------------------------------------------------------------
export function workshopId(s) {
  const m = /^(\d{1,20})$/.exec(String(s ?? '').trim()) || /steamcommunity\.com\/(?:sharedfiles|workshop)\/filedetails\/?\?(?:.*&)?id=(\d{1,20})/i.exec(String(s ?? ''));
  return m ? m[1] : null;
}
// GetPublishedFileDetails's answer for one item, tidied (or null: no such public item).
export function readDetails(d) {
  if (!d || d.result !== 1) return null;
  const tags = (d.tags || []).map((t) => (typeof t === 'string' ? t : t?.tag)).filter((t) => typeof t === 'string');
  return {
    id: String(d.publishedfileid), title: String(d.title || ''), app: d.consumer_app_id, tags,
    kind: tags.includes('Weapon Finish') ? 'finish' : tags.includes('Map') ? 'map' : 'other',
    creator: /^\d{17}$/.test(String(d.creator ?? '')) ? String(d.creator) : null,
    updated: d.time_updated ? new Date(d.time_updated * 1000).toISOString().slice(0, 10) : null,
    // (Steam gives a file only for an item one can subscribe to: never for a weapon finish.)
    hasFile: !!(d.file_url || d.hcontent_file),
  };
}
// From a saved answer (a file: the whole response, or one item) or from Steam.
export async function workshopDetails(id, { file = null, offline = false } = {}) {
  if (file) {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = j?.response?.publishedfiledetails || j?.publishedfiledetails || (Array.isArray(j) ? j : [j]);
    return readDetails(list.find((x) => String(x?.publishedfileid) === String(id)) || null);
  }
  if (offline) return null;
  const body = new URLSearchParams({ itemcount: '1', 'publishedfileids[0]': id });
  const r = await fetch('https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/', { method: 'POST', body, headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Steam answered ${r.status}`);
  return readDetails((await r.json())?.response?.publishedfiledetails?.[0]);
}
// A Steam profile's public name.
export async function creatorName(steamid) {
  const r = await fetch(`https://steamcommunity.com/profiles/${steamid}/?xml=1`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) return null;
  const t = await r.text();
  const m = /<steamID><!\[CDATA\[([\s\S]*?)\]\]><\/steamID>/.exec(t) || /<steamID>([^<]*)<\/steamID>/.exec(t);
  return m ? m[1].replace(/\s+/g, ' ').trim() || null : null;
}

// ---- what Steam downloaded ---------------------------------------------------------------------------------------------
// The Steam libraries to look in: `steam` alone when given, else this PC's Steam (the registry's SteamPath and the usual
// folder) and every library its libraryfolders.vdf lists.
export function steamLibraries(steam = null) {
  const roots = steam ? [steam] : [];
  if (!steam) {
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const m = /SteamPath\s+REG_SZ\s+(.+)/.exec(out);
      if (m) roots.push(m[1].trim());
    } catch { /* no Steam in the registry */ }
    roots.push('C:/Program Files (x86)/Steam');
  }
  const libs = new Set();
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    libs.add(path.resolve(r));
    try {
      const kv = parseKV1(fs.readFileSync(path.join(r, 'steamapps', 'libraryfolders.vdf'), 'utf8'));
      for (const l of Object.values(kv.libraryfolders || {})) if (l && typeof l === 'object' && l.path) libs.add(path.resolve(l.path));
    } catch { /* none */ }
  }
  return [...libs].filter((l) => fs.existsSync(l));
}
export function findSubscribed(id, libs) {
  for (const l of libs) { const d = path.join(l, 'steamapps', 'workshop', 'content', '730', id); if (fs.existsSync(d)) return d; }
  return null;
}
// What a downloaded Workshop item holds: a map (a VPK addon with maps/), a finish's files, or something else.
export function describeSubscribed(folder) {
  let title = null;
  try { title = parseKV1(fs.readFileSync(path.join(folder, 'publish_data.txt'), 'utf8')).publish_data?.title || null; } catch { /* none */ }
  const packed = [];
  for (const v of fs.readdirSync(folder).filter((n) => /_dir\.vpk$/i.test(n))) { try { packed.push(...listVpk(path.join(folder, v)).map((x) => x.path)); } catch { /* not a VPK */ } }
  const files = walk(folder);
  const kind = packed.some((p) => /^maps\/[^/]+\.vpk$/i.test(p)) ? 'map'
    : packed.some((p) => /\.(vcompmat_c|econitem)$/i.test(p) || /^weapons\/paints\//i.test(p)) ? 'packed-finish'
      : files.some((f) => /\.(econitem|vcompmat|vcompmat_c)$/i.test(f)) ? 'files' : 'unknown';
  return { folder, title, kind, packed, files };
}

const NOT_DOWNLOADED = 'Steam never downloads a weapon finish: subscribing to one only counts as a vote (maps are the only "ready to use" Workshop items), and Steam\'s API gives out no file for one';

// ---- the import ---------------------------------------------------------------------------------------------------------
// Options (scripts/import-workshop.mjs has the command line):
//   files         the creator's files: a folder or a .zip (else, with `workshop`, the item's subscribed folder is looked at)
//   workshop      the Workshop item's id or link (its metadata: title, creator, tags)   details: a saved metadata answer
//   offline       never contact Steam                                                   creatorName: the creator's name
//   name, weapon, rarity, float [min, max], prices, pricesStatTrak ({ FN: 1.5 } or [in wear order]), stattrak (bool)
//   style         when the files don't say (a CS:GO .txt this can't read), or to override them (with allowLoss)
//   model ('hd'|'legacy'), flipNormal (bool), icon (a picture), permission (the creator's written permission, a file)
//   out           the pack folder it goes into (default custom-staging/), live: into custom/ itself
//   force         replace a folder of the same name   allowLoss: leave out what custom skins can't do yet
//   keepSize      keep textures over 2048             item: which finish, when the files hold several
//   steam         a Steam folder to look in           game: the game data (default src/data/game-data.json)
// Returns { ok, errors, notes, folder, skin, id, record }. Writes nothing unless it all checks out.
export async function importFinish(o = {}) {
  const errors = [], notes = [];
  const fail = (m) => { errors.push(m); return { ok: false, errors, notes }; };
  const game = o.game || JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'data', 'game-data.json'), 'utf8'));
  const cli = o.cli || CLI;
  const table = weaponTable(game);
  const live = path.join(ROOT, 'custom');
  const out = path.resolve(o.live ? live : o.out || STAGING);
  if (!o.live && path.resolve(out) === live) return fail('custom/ is the live pack folder (it changes the game\'s data lock once built): import into custom-staging/ first, or pass --live');
  if ((out + path.sep).startsWith(path.join(ROOT, 'src') + path.sep)) return fail(`${out} is inside src/, where the build writes: pick a pack folder`);

  // Who made it, and where it is.
  const wsid = o.workshop != null ? workshopId(o.workshop) : null;
  if (o.workshop != null && !wsid) return fail(`"${o.workshop}" isn't a Workshop item's id or link`);
  let details = null;
  if (wsid) {
    try { details = await workshopDetails(wsid, { file: o.details, offline: o.offline }); } catch (e) { return fail(`couldn't read Workshop item ${wsid}'s details from Steam (${e.message}): pass --offline with --creator-name, or --details <a saved answer>`); }
    if (details && details.app !== 730) return fail(`Workshop item ${wsid} isn't a Counter-Strike item`);
    if (details?.kind === 'map') return fail(`Workshop item ${wsid} "${details.title}" is a map, not a weapon finish`);
    if (details && details.kind !== 'finish') return fail(`Workshop item ${wsid} "${details.title}" isn't a weapon finish (its tags: ${details.tags.join(', ') || 'none'})`);
    if (!details && o.details) return fail(`${o.details} has no Workshop item ${wsid}`);
    if (!details && !o.offline) return fail(`Workshop item ${wsid} isn't a public item Steam knows`);
    if (!details) notes.push(`no Workshop details read (offline): its title, creator id and tags aren't recorded`);
  }
  let by = o.creatorName ? String(o.creatorName).replace(/\s+/g, ' ').trim() : null;
  if (!by && details?.creator && !o.offline && !o.details) { try { by = await creatorName(details.creator); } catch { /* asked for below */ } }
  const about = wsid ? `Workshop item ${wsid}${details ? ` "${details.title}"` : ''}${by ? ` by ${by}` : ''}` : 'the finish';

  // The creator's files.
  let input = o.files ? path.resolve(o.files) : null;
  if (!input && wsid) {
    const sub = findSubscribed(wsid, steamLibraries(o.steam));
    if (!sub) return fail(`${about} isn't in your Steam folder. ${NOT_DOWNLOADED}. Ask the creator for their files (their CS2 addon folder, with the finish's .econitem and its .tga textures, or a zip of it) and their written permission, then: node scripts/import-workshop.mjs --files <their folder or zip> --workshop ${wsid} --permission <their permission>`);
    const d = describeSubscribed(sub);
    if (d.kind === 'map') return fail(`${about} in your Steam folder (${sub}) is a map${d.title ? ` ("${d.title}")` : ''}: its VPK holds ${d.packed.find((p) => /^maps\//.test(p))}. A weapon finish can't be downloaded: ${NOT_DOWNLOADED}`);
    if (d.kind === 'packed-finish') return fail(`${sub} holds a finish packed in a VPK: unpack it with tools/s2v/Source2Viewer-CLI.exe -i <its _dir.vpk> -o <a folder> and pass --files <that folder>`);
    if (d.kind !== 'files') return fail(`${sub} holds no finish this can read (${d.files.length} files)`);
    input = sub;
  }
  if (!input) return fail('which finish? Pass the creator\'s files (a folder or a .zip), or a Workshop id');
  if (!fs.existsSync(input)) return fail(`${input} doesn't exist`);
  if (!by) return fail(`${wsid ? 'its creator\'s name isn\'t known' : 'who made it?'}: pass --creator-name "<their name>" (the game credits them)`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs2sim-workshop-'));
  try {
    let root = input;
    if (fs.statSync(input).isFile()) {
      if (!/\.zip$/i.test(input)) return fail(`${path.basename(input)}: pass a folder or a .zip of the creator's files`);
      root = path.join(tmp, 'files');
      try { extractZip(input, root); } catch (e) { return fail(e.message); }
      // (A zip holding one zip, as a CS:GO upload sent inside another: that one too.)
      const inner = walk(root);
      if (inner.length === 1 && /\.zip$/i.test(inner[0])) { const r2 = path.join(tmp, 'files2'); try { extractZip(inner[0], r2); } catch (e) { return fail(e.message); } root = r2; }
    }
    const files = walk(root);
    let src;
    try { src = findFinish(root, files, { pick: o.item, cli }); } catch (e) { return fail(e.message); }
    if (src?.format === 'csgo-zip' && !src.recognised) {
      if (!o.style) return fail(`${path.basename(src.file)} is a CS:GO workbench file this can't read (its keys: ${src.keys.slice(0, 20).join(', ') || 'none'}): CS:GO's layout for it was never published. Give its style with --style (and --colors, --float), and the picture is taken from the upload's .tga`);
      notes.push(`${path.basename(src.file)}: its settings couldn't be read, so they're yours (--style...)`);
    }
    if (!src) {
      if (!o.style) return fail(`no finish found in ${input}: a CS2 finish is its .econitem (or .vcompmat) with its textures; a CS:GO one, its workbench .txt with its .tga. With only pictures, say the style with --style`);
      src = { format: 'files', file: input, template: null, values: new Map(), notes: [], weapon: null, finishName: path.basename(input).replace(/\.zip$/i, '') };
    }
    if (src.format === 'files' || src.recognised === false) {
      // (Settings by hand: the picture is the files' one picture, and a *_normal one its normal map.)
      const pics = files.filter((f) => /\.(tga|png)$/i.test(f) && !/normal|icon|permission/i.test(path.basename(f)));
      if (pics.length === 1) src.values.set('exposed_params.g_tPattern', { kind: 'texture', paths: [pics[0]] });
      else if (pics.length > 1) notes.push(`its picture: ${pics.length} candidates (${pics.map((f) => path.basename(f)).join(', ')}), so none was picked`);
      const nrm = files.filter((f) => /_normal\.(tga|png)$/i.test(f));
      if (nrm.length === 1) { src.values.set('exposed_params.g_bUseNormalMap', { kind: 'bool', value: true }); src.values.set('exposed_params.g_tNormal', { kind: 'texture', paths: [nrm[0]] }); }
    }
    notes.push(...src.notes);

    // Its style: CS2's template.
    let template = src.template;
    const tagTemplate = details?.tags.map((t) => templateFromName(t)).find(Boolean) || null;
    if (o.style) {
      const want = templateFromName(o.style);
      if (!want) return fail(`--style "${o.style}": custom skin styles are ${Object.keys(STYLES).join(', ')}`);
      if (template && want !== template && (TEMPLATES[template].base || template) !== want && !o.allowLoss) return fail(`the creator's file says ${label(template)}, not ${label(want)}: pass --allow-loss to make it as ${label(want)} anyway`);
      template = want;
    }
    if (!template && src.format === 'cs2-econitem') return fail(`${path.basename(src.file)}: composite_material_class "PaintKit_${src.cls}" isn't one of CS2's finish styles`);
    if (!template && src.format === 'cs2-vcompmat') return fail(`${path.basename(src.file)} isn't built on one of CS2's Workshop templates (its paint material is ${src.vmat || 'missing'}): it can't be read as a Workshop finish`);
    if (!template) template = tagTemplate;
    if (!template) return fail('its style isn\'t known: pass --style');
    if (tagTemplate && (TEMPLATES[tagTemplate].base || tagTemplate) !== (TEMPLATES[template].base || template)) notes.push(`its Workshop tag says ${label(tagTemplate)}; the creator's file says ${label(template)} (the file is used)`);
    const T = TEMPLATES[template];
    if (template === 'glove') return fail(gloveRefusal());
    if (!T.style) return fail(`it's CS2's ${T.label} style, which custom skins don't offer yet (CUSTOM_CONTENT.md, section 11)`);

    // Which weapon, and its name.
    const t = parseTitle(o.name || details?.title || '');
    const titleWeapon = t.weapon ? table.find(t.weapon) : null;
    if (/glove|wraps/i.test(t.weapon || '') || (!o.weapon && /\bgloves?\b|hand wraps/i.test(o.name || details?.title || ''))) return fail(gloveRefusal());
    const fromFlag = o.weapon ? table.find(o.weapon) : null;
    if (o.weapon && !fromFlag) return fail(`--weapon "${o.weapon}" isn't one of CS2's weapons (AK-47, Karambit... or weapon_ak47...)`);
    const fromFiles = src.weapon ? table.find(src.weapon) : null;
    if (src.weapon && !fromFiles) return fail(`the creator's file is for ${src.weapon}, which isn't a weapon in the game`);
    const fromTag = details?.tags.map((x) => table.find(x)).find(Boolean) || null;
    const S = STYLES[T.style];
    let weapon;
    if (fromFlag) {
      weapon = fromFlag;
      if (S.uv && fromFiles && fromFiles.wid !== fromFlag.wid) return fail(`it's a ${T.style} painted on the ${fromFiles.w}'s UV layout: on the ${fromFlag.w} the picture would land in the wrong places. Only a pattern style (Hydrographic, Spray-Paint, Anodized...) moves to another weapon`);
    } else if (fromFiles) {
      if (titleWeapon && titleWeapon.wid !== fromFiles.wid) return fail(`its title says ${titleWeapon.w}, but the creator's file is for the ${fromFiles.w} (preview_weapon): say which with --weapon`);
      weapon = fromFiles;
    } else if (titleWeapon) weapon = titleWeapon;
    else if (fromTag) { weapon = fromTag; notes.push(`its weapon is from its Workshop tag (${fromTag.w})`); }
    else return fail('which weapon is it for? Pass --weapon (AK-47, Karambit...)');
    if (fromTag && fromTag.wid !== weapon.wid) notes.push(`its Workshop tag says ${fromTag.w} (knife finishes are posted under a gun's tag): it's made for the ${weapon.w}`);
    if (weapon.cat === 'gloves') return fail(gloveRefusal());
    if (weapon.cat === 'equipment') return fail(`${weapon.w} can't have custom skins`);
    if (S.uv && weapon.cat === 'knife' && !fromFiles) notes.push(`check it's painted on the ${weapon.w}'s own UV layout (node scripts/custom-reference.mjs "${weapon.w}"): the files don't say which model it was painted on`);
    if (t.unclear && !o.name) {
      if (!src.finishName) return fail(`its title "${details?.title}" isn't "<weapon> | <finish>": name it with --name "${weapon.w} | <finish>"`);
    }
    if (o.name && t.unclear) return fail(`--name "${o.name}" must be "<weapon> | <finish>", e.g. "${weapon.w} | Nebula"`);
    if (o.name && t.weapon && titleWeapon?.wid !== weapon.wid) return fail(`--name says ${t.weapon}, but it's for the ${weapon.w}`);
    let finishName = t.unclear ? null : t.finish;
    if (!finishName) {
      // From the file's name ("ak47_fairy_hunter" -> "Fairy Hunter").
      const short = weapon.wid.replace(/^weapon_(knife_)?/, '');
      const words = src.finishName.split(/[_\s-]+/).filter(Boolean);
      while (words.length > 1 && [loose(weapon.w), short, 'weapon', 'knife'].includes(loose(words[0]))) words.shift();
      finishName = titleCase(words.join(' ').toLowerCase());
      if (!finishName) return fail(`name it with --name "${weapon.w} | <finish>"`);
      notes.push(`named from the file (${path.basename(src.file)})${details?.title ? `, as its title "${details.title}" isn't plain "<weapon> | <finish>"` : ''}: pass --name to choose`);
    }
    const star = weapon.cat === 'knife';
    const name = `${star ? '★ ' : ''}${weapon.w} | ${finishName}`;
    if (game.skins && Object.values(game.skins).some((s) => norm(s.n) === norm(name))) return fail(`"${name}" is a real CS2 item${details ? ' (Valve may have added this very finish to CS2)' : ''}: it's in the game already. Name yours otherwise with --name`);
    const folderName = `${weapon.w} - ${finishName}`.replace(/[<>:"/\\|?*]/g, '').trim();
    for (const dir of [live, out]) {
      for (const d of listSkinNames(dir)) {
        if (d.folder === folderName && dir === out && o.force) continue;
        if (norm(d.name) === norm(name.replace(/^★\s*/, ''))) return fail(`${path.relative(ROOT, d.dir) || d.dir} is "${name}" already${dir === out && d.folder === folderName ? ': pass --force to replace it' : ''}`);
      }
    }
    const dest = path.join(out, 'skins', folderName);
    if (fs.existsSync(dest) && !o.force) return fail(`${dest} exists: pass --force to replace it`);

    // Its finish: the creator's settings on the custom skin's fields.
    const resolve = resolver(root, files);
    const m = mapFinish({ ...src, template }, { resolve, weapon, legacy: src.format === 'csgo-zip' });
    notes.push(...m.notes);
    if (m.errors.length) return fail(m.errors.join('; '));
    if (m.losses.length && !o.allowLoss) return fail(`it uses ${m.losses.join(', ')}: CS2's ${template} template has that, but custom skins are made on the ${TEMPLATES[template].base || template} template, which doesn't (CUSTOM_CONTENT.md, section 11). Pass --allow-loss to import it without ${m.losses.length > 1 ? 'them' : 'it'}: it then won't look exactly like the creator's`);
    if (m.losses.length) notes.push(`left out (--allow-loss): ${m.losses.join(', ')}`);
    if (o.colors) {
      const cs = String(o.colors).split(/[\s,]+/).filter(Boolean).map(toColor);
      if (cs.some((c) => !c) || cs.length > 4) return fail('--colors must be up to 4 colours like "#a1b2c3,#d4e5f6"');
      m.fin.colors = cs.map(hex);
    }
    if (o.model) { if (!['hd', 'legacy'].includes(o.model)) return fail('--model is hd (CS2\'s model) or legacy (CS:GO\'s)'); if (S.uv) m.fin.model = o.model; }
    if (o.flipNormal != null && m.textures.normal) { if (o.flipNormal) m.fin.flipNormalGreen = true; else delete m.fin.flipNormalGreen; }
    if (!S.colors) delete m.fin.colors;

    // What the Workshop doesn't carry: the developer's.
    const float = o.float || m.float || null;
    const missing = [];
    if (!float) missing.push('--float <min>,<max>: its float range (the creator\'s file doesn\'t give one)');
    const [mn, mx] = float || [0, 1];
    const wears = wearsIn(mn, mx);
    if (!star && !o.rarity) missing.push('--rarity: Consumer, Industrial, Mil-Spec, Restricted, Classified or Covert (Valve picks one only when it accepts a finish)');
    if (star && o.rarity && !/^covert$/i.test(o.rarity)) return fail('knives are always ★ Covert');
    const prices = priceTable(o.prices, wears, 'prices', errors), sttPrices = priceTable(o.pricesStatTrak, wears, 'prices-stattrak', errors);
    if (errors.length) return { ok: false, errors, notes };
    if (!prices) missing.push(`--prices ${wears.map((w) => w + '=<$>').join(',')}: its prices (there's no market for it; a wear left out is filled from the nearest)`);
    if (missing.length) return fail(`what the Workshop doesn't carry is yours to set:\n  ${missing.join('\n  ')}`);
    if (o.live && wsid && !o.permission) return fail('into custom/ only with the creator\'s written permission: --permission <file>');

    // The skin folder, made in a scratch pack first and checked by the build itself.
    const pack = path.join(tmp, 'pack'), stage = path.join(pack, 'skins', folderName);
    fs.mkdirSync(stage, { recursive: true });
    const made = [];
    for (const [role, spec] of Object.entries(m.textures)) {
      const file = spec.paths.map(resolve).find(Boolean);
      if (!file) {
        if (spec.paths.every(isValveDefault)) { notes.push(`${role}: turned on, but it's CS2's own default texture (left to the template)`); continue; }
        return fail(`${role}: the creator's file names "${spec.paths[0]}", which isn't among their files`);
      }
      let img;
      try { img = loadTexture(file, tmp, cli); } catch (e) { return fail(`${path.basename(file)}: ${e.message}`); }
      const size = `${img.w}x${img.h}`;
      if (!o.keepSize) img = capSize(img, TEXTURE_KEEP);
      if (role === 'color' && src.format === 'csgo-zip') {
        let bare = 0;
        for (let i = 3; i < img.data.length; i += 4) if (img.data[i] >= 153 && img.data[i] <= 230) bare++;
        const share = bare / (img.w * img.h);
        if (share > 0.02) notes.push(`${Math.round(share * 100)}% of its picture's alpha is 153 to 230, where CS2 shows no paint at all (CUSTOM_CONTENT.md 3.2). CS:GO read alpha differently: check it in inspect, and set that alpha to 255 if the paint is missing`);
      }
      fs.writeFileSync(path.join(stage, role + '.png'), encode(img));
      made.push(`${role}.png (${path.basename(file)}, ${size}${img.w + 'x' + img.h !== size ? ` -> ${img.w}x${img.h}` : ''})`);
    }
    if (S.texture === 'required' && !fs.existsSync(path.join(stage, 'color.png'))) return fail(`a ${T.style} needs its picture (the template's g_tPattern), and the creator's files don't have it`);
    if (o.icon) {
      try { fs.writeFileSync(path.join(stage, 'icon.png'), encode(readImage(path.resolve(o.icon)))); } catch (e) { return fail(`--icon: ${e.message}`); }
    }
    let permission = null;
    if (o.permission) {
      const pf = path.resolve(o.permission);
      if (!fs.existsSync(pf) || !fs.statSync(pf).isFile()) return fail(`--permission: ${pf} isn't a file`);
      if (fs.statSync(pf).size > 20 << 20) return fail('--permission: that file is over 20 MB');
      permission = 'permission' + (path.extname(pf).toLowerCase() || '.txt');
      fs.copyFileSync(pf, path.join(stage, permission));
    }
    const round4 = (x) => Math.round(x * 1e4) / 1e4;
    const skin = {
      name, ...(star ? {} : { rarity: o.rarity }), float: [mn, mx], ...(o.stattrak != null ? { stattrak: !!o.stattrak } : {}),
      prices, ...(sttPrices ? { pricesStatTrak: sttPrices } : {}), finish: m.fin,
      ...(wsid ? {
        workshop: {
          id: wsid, url: workshopUrl(wsid), ...(details?.title ? { title: details.title } : {}), ...(details?.creator ? { creator: details.creator } : {}), creatorName: by,
          ...(details?.updated ? { updated: details.updated } : {}), ...(details?.tags?.length ? { tags: details.tags } : {}), format: src.format,
          ...(permission ? { permission } : {}),
        },
      } : { credit: by }),
      ...(m.iconFloat != null && m.iconFloat >= mn && m.iconFloat <= mx ? { iconFloat: round4(m.iconFloat) } : {}),
    };
    fs.writeFileSync(path.join(stage, 'skin.json'), JSON.stringify(skin, null, 2) + '\n');
    const r = buildCustom({ src: pack, data: game, draft: true, trial: true });
    if (!r.ok) return fail(`the build refuses it: ${r.errors.map((x) => x.replace(/^skins\/[^:]+: /, '')).join('; ')}`);
    for (const w of r.warnings) if (!/permission/.test(w)) notes.push(w.replace(/^skins\/[^:]+: /, ''));
    const id = Object.keys(r.custom.skins)[0];
    fs.writeFileSync(path.join(stage, 'import-notes.txt'), [
      `${name}: imported by scripts/import-workshop.mjs on ${new Date().toISOString().slice(0, 10)}.`,
      // (Its name only: the folder it was in is on this PC, and this file is committed with the packs, to a public repository.)
      `From: ${path.basename(input)}${o.item ? ` (${o.item})` : ''}, ${src.format}${src.file && src.file !== input ? `: ${path.relative(root, src.file).replace(/\\/g, '/')}` : ''}`,
      wsid ? `Workshop: ${workshopUrl(wsid)}${details?.title ? ` "${details.title}"` : ''} by ${by}${details?.updated ? `, updated ${details.updated}` : ''}` : `Made by: ${by}`,
      `Its style: CS2's ${template} template${TEMPLATES[template].base ? `, made as ${T.style}` : ''}. Textures: ${made.join(', ') || 'none'}.`,
      'Yours, not the creator\'s: its rarity, prices, StatTrak and which case it\'s in.',
      ...(permission ? [`The creator's permission: ${permission}`] : ['NO PERMISSION ON FILE: the game\'s build refuses it until there is (workshop.permission).']),
      ...(notes.length ? ['', 'Notes:', ...notes.map((n) => '- ' + n)] : []),
    ].join('\n') + '\n');
    if (o.force) fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(stage, dest, { recursive: true });
    return { ok: true, errors, notes, folder: dest, skin, id, record: r.custom.skins[id], template, format: src.format, textures: made, permission: !!permission };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function gloveRefusal() {
  return 'Workshop finishes are gun (and knife) finishes, made with CS2\'s weapon shader: there are no Workshop gloves, and gloves are drawn by another shader on their own UV layout. Make custom gloves as in CUSTOM_CONTENT.md, section 5';
}
const label = (template) => {
  const T = TEMPLATES[template];
  return !T ? template : T.label || T.style + (T.base ? ' Extended' : '');
};
// A style's name (a custom skin style, a Workshop tag, a CS2 class or template) as CS2's template.
function templateFromName(s) {
  const k = loose(s);
  if (!k) return null;
  for (const [st, S] of Object.entries(STYLES)) if (loose(st) === k) return S.template;
  for (const [cls, t] of Object.entries(CLASSES)) if (loose(cls) === k || loose(cls) + 'ed' === k || loose(cls.replace('Extended', 'edExtended')) === k) return t;
  return TEMPLATES[String(s).trim()] ? String(s).trim() : null;
}
// The skins a pack folder already has: [{ dir, folder, name (without ★) }].
function listSkinNames(pack) {
  const dir = path.join(pack, 'skins');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => {
    let n = d.name.replace(/｜/g, '|').replace(/ - /, ' | ');
    try { const j = JSON.parse(fs.readFileSync(path.join(dir, d.name, 'skin.json'), 'utf8')); if (typeof j?.name === 'string') n = j.name; } catch { /* its folder's name, then */ }
    return { dir: path.join(dir, d.name), folder: d.name, name: n.replace(/^★\s*/, '') };
  });
}
// Prices as the skin.json wants them, from { FN: 1.5 } or a list in wear order.
function priceTable(p, wears, flag, errors) {
  if (p == null) return null;
  if (Array.isArray(p)) {
    if (p.length > wears.length || !p.every((x) => Number.isFinite(x) && x > 0)) { errors.push(`--${flag}: ${p.length} prices for ${wears.length} wears (${wears.join(', ')}), each above 0`); return null; }
    return Object.fromEntries(p.map((x, i) => [wears[i], x]));
  }
  return p;
}

// The creator's settings on a custom skin's fields (scripts/build-custom.mjs: finish.style, colors, scale, rotation,
// offset, roughness, pearlescence, ignoreWeaponSize, params) and its textures by role. What the base template has no
// setting for is left out: quietly when it's off, as a loss when the finish uses it.
export function mapFinish(src, { resolve = () => null, legacy = false } = {}) {
  const notes = [], losses = [], errors = [], textures = {};
  const T = TEMPLATES[src.template], base = T.base || src.template, S = STYLES[T.style];
  const known = new Set(BASE_VARS[base]), v = src.values, used = new Set();
  const take = (k) => { used.add(k); return v.get(k); };
  const fin = { style: T.style }, params = {};
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const r6 = (x) => Math.round(x * 1e6) / 1e6;

  // Wear: the range its float is in (the template's wear amount's own bounds), and the wear it was shown at.
  const wear = take('econ_instance.g_flWearAmount');
  let float = null, iconFloat = null;
  if (wear?.min && wear?.max) {
    const lo = clamp(wear.min[0], 0, 1), hi = clamp(wear.max[0], 0, 1);
    if (hi > lo) float = [r6(lo), r6(hi)]; else notes.push(`its wear range (${wear.min[0]} to ${wear.max[0]}) is empty: give one with --float`);
  }
  if (wear?.value?.length) iconFloat = wear.value[0];
  // Placement: what the seed picks the rotation and offset from.
  const rot = take('econ_instance.g_flPatternTexCoordRotation'), off = take('econ_instance.g_vPatternTexCoordOffset');
  if (S.placement) {
    if (rot) {
      const a = rot.min?.[0] ?? rot.value[0], b = rot.max?.[0] ?? rot.value[0];
      fin.rotation = [clamp(Math.min(a, b), -360, 360), clamp(Math.max(a, b), -360, 360)].map(r6);
    }
    if (off) {
      const lo = [0, 1].map((i) => off.min?.[i] ?? off.value[i] ?? 0), hi = [0, 1].map((i) => off.max?.[i] ?? off.value[i] ?? 0);
      if ([...lo, ...hi].some((x) => Math.abs(x) > 1)) notes.push('its offset range went past -1 to 1 (one whole tile): kept to -1 to 1');
      fin.offset = [[Math.min(lo[0], hi[0]), Math.min(lo[1], hi[1])].map((x) => r6(clamp(x, -1, 1))), [Math.max(lo[0], hi[0]), Math.max(lo[1], hi[1])].map((x) => r6(clamp(x, -1, 1)))];
    }
    if (S.uv && (fin.rotation?.[0] !== fin.rotation?.[1] || fin.offset?.[0].some((x, i) => x !== fin.offset[1][i]))) notes.push('its seed moves its picture (the rotation or offset ranges in the creator\'s file): a picture painted on the UV layout is usually fixed, so check that is what they meant');
  }
  // The main settings.
  const sc = take('exposed_params.g_flPatternTexCoordScale');
  if (sc && known.has('exposed_params.g_flPatternTexCoordScale')) { const s = sc.value[0]; if (s > 0 && s <= 10) fin.scale = r6(s); else params['exposed_params.g_flPatternTexCoordScale'] = s; }
  if (S.colors) {
    const n = S.colors === 1 ? 1 : 4, cs = [];
    for (let i = 0; i < 4; i++) { const c = take('exposed_params.g_vColor' + i); if (i < n) cs.push(c?.kind === 'color' ? hex(c.value) : null); }
    while (cs.length && !cs.at(-1)) cs.pop();
    if (cs.every(Boolean)) { if (cs.length) fin.colors = cs; } else cs.forEach((c, i) => { if (c) params['exposed_params.g_vColor' + i] = c; });
  } else if ([0, 1, 2, 3].map((i) => take('exposed_params.g_vColor' + i)).some(Boolean)) notes.push(`its colours are left out: a ${T.style} takes its colour from its picture`);
  const rough = take('exposed_params.g_flPaintRoughness');
  if (rough?.kind === 'float' && known.has('exposed_params.g_flPaintRoughness')) { const x = rough.value[0]; if (x >= 0 && x <= 1) fin.roughness = r6(x); else params['exposed_params.g_flPaintRoughness'] = x; }
  const pearl = take('exposed_params.g_flPearlescentScale');
  if (pearl?.kind === 'float' && known.has('exposed_params.g_flPearlescentScale')) { const x = pearl.value[0]; if (Math.abs(x) <= 10) fin.pearlescence = r6(x); else params['exposed_params.g_flPearlescentScale'] = x; }
  const ign = take('exposed_params.g_bIgnoreWeaponSizeScale');
  if (ign?.kind === 'bool' && S.placement && known.has('exposed_params.g_bIgnoreWeaponSizeScale')) fin.ignoreWeaponSize = ign.value;
  // Textures: each one its switch turns on (the build turns the switch on again for the file it finds).
  for (const [role, key, sw] of TEXTURES) {
    const tex = take(key), turn = sw ? take(sw) : null;
    if (!known.has(key)) continue;
    if (role === 'color') {
      if (S.texture !== 'required') { if (tex) notes.push(`its main texture is left out: a ${T.style} has none`); continue; }
      if (tex?.kind === 'texture') textures.color = tex; else errors.push(`the creator's file names no main texture (${key}) for its ${T.style}`);
      continue;
    }
    if (turn?.kind !== 'bool' || !turn.value) {
      if (tex?.kind === 'texture' && tex.paths.some((p) => resolve(p) && !isValveDefault(p))) notes.push(`${role}: the creator's file has it turned off, so it's left out (as in their finish)`);
      continue;
    }
    if (tex?.kind !== 'texture') { errors.push(`${sw} is on, but the creator's file names no ${key}`); continue; }
    textures[role] = tex;
  }
  // CS:GO's normal maps are DirectX style (green down); the game's 3D reads them green up.
  if (legacy && textures.normal) fin.flipNormalGreen = true;
  if (legacy && S.uv) fin.model = 'legacy';
  else if (S.uv) fin.model = 'hd';
  // The rest: the base template's other settings as they are, the extended ones' as losses when used.
  const extended = [], unknown = [];
  for (const [k, val] of v) {
    if (used.has(k) || /^econ_instance\.g_nRandomSeed/.test(k)) continue;
    if (known.has(k)) {
      if (val.kind === 'bool') params[k] = val.value;
      else if (val.kind === 'float') params[k] = val.value.length === 1 ? val.value[0] : val.value.slice(0, 4);
      else if (val.kind === 'color') params[k] = hex(val.value);
      else notes.push(`${k} is left out (a ${val.kind} setting)`);
    } else if (/^(exposed_params|econ_instance|grunge_wear)\./.test(k) && !k.startsWith('econ_instance.g_flWearAmount')) (T.base ? extended : unknown).push(k);
    else unknown.push(k);
  }
  const own = (name) => { const x = v.get('exposed_params.' + name); return x?.kind === 'texture' && x.paths.some((p) => resolve(p) && !isValveDefault(p)); };
  for (const [what, test] of EXT_FEATURES) if (test(v, own)) losses.push(what);
  if (T.base) notes.push(`it's CS2's ${src.template} template, made as ${T.style}${losses.length ? '' : ', which it fully is: it uses none of the extended features'}`);
  if (unknown.length) notes.push(`not settings of CS2's ${base} template, so left out: ${unknown.join(', ')}`);
  if (Object.keys(params).length) fin.params = params;
  return { fin, textures, float, iconFloat, notes, losses, errors };
}
