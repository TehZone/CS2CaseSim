// Builds custom content: your own skins, knives, gloves and cases (CUSTOM_CONTENT.md says how to make them).
//   node scripts/build-custom.mjs                 checks custom/ and builds it into the game (src/data/custom.json, src/custom/)
//   node scripts/build-custom.mjs --check         only checks, writes nothing
//   node scripts/build-custom.mjs --src docs/custom-example --try
//                                                 another folder of packs, built into a try-out folder of its own (it prints
//                                                 the commands to run a development copy with it: npm start -- --custom <dir>).
//                                                 --out <dir> builds somewhere else of your choice. Only custom/ builds into src/.
// Options: --draft (a missing icon gets a stand-in, for scripts/bake-custom-icons.mjs), --allow-removed (let an item from an
// earlier build go: players' copies of it then show as Unknown item), --data <game-data.json>.
// A build with --try or --out somewhere else is a try-out: a Steam Workshop finish (scripts/import-workshop.mjs) with no
// permission from its creator on file is only warned about there. The game's own build refuses it.
// A build into the game stamps the version it ships in (package.json's: it must be one that isn't out yet when the lock
// changes), which the server waits for before it runs the content (server/index.mjs customGate).
//
// The source folder (custom/ by default; it doesn't ship, only what this writes does):
//   skins/<name>/skin.json   one gun skin, knife or pair of gloves, its textures beside it (a folder named after the item,
//                            with " - " for " | ", which Windows can't have in a name: "AK-47 - Nebula")
//   cases/<name>/case.json   one case, with case.png (its picture) and optionally crate.png (its 3D crate's art)
//   ids.json                 every item this has built (written by it, keep it with the packs): an item can't vanish by mistake
// With no items at all it writes nothing and removes what an earlier build wrote: the game is then exactly as without
// custom content, and so is its data lock.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readImage, resize, fit, capSize, encode, hasTransparency } from './custom/images.mjs';
import { customLock, dataLock, CX_FORMAT } from '../src/js/engine/custom.js';
import { TRADEUP_SRC } from '../src/js/engine/tradeup.js';
import { phaseWeight } from '../src/js/engine/data.js';
import { CARE_SRC } from '../src/js/engine/levels.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- the rules -------------------------------------------------------------------------------------------------------
const RARITIES = [['Consumer', 'Consumer Grade', '#b0c3d9'], ['Industrial', 'Industrial Grade', '#5e98d9'], ['Mil-Spec', 'Mil-Spec Grade', '#4b69ff'],
  ['Restricted', 'Restricted', '#8847ff'], ['Classified', 'Classified', '#d32ce6'], ['Covert', 'Covert', '#eb4b4b']];
const rarityOf = (s) => RARITIES.findIndex(([a, b]) => [a, b].some((x) => x.toLowerCase() === String(s).trim().toLowerCase()));
const WEARS = [['FN', 0, 0.07], ['MW', 0.07, 0.15], ['FT', 0.15, 0.38], ['WW', 0.38, 0.45], ['BS', 0.45, 1]];
const WEAR_RATIO = { FN: 2.1, MW: 1.35, FT: 1, WW: 0.9, BS: 0.8 }; // (as shared/pricing.cjs fills a wear with no price)
const wearsIn = (mn, mx) => WEARS.filter(([, lo, hi]) => mx > lo && mn < hi).map(([k]) => k);

// CS2's finish styles: CS2's own Workshop template for each (workshop/paintkits/templates/<template>.vcompmat in the
// player's CS2), and which of the template's settings apply.
//   uv: painted on the model's UV layout (no seed placement unless asked), pattern: a tiling mask the seed places,
//   texture: the main texture (exposed_params.g_tPattern) is required.
export const STYLES = {
  'Custom Paint Job': { template: 'custom_paint_job', uv: true, texture: 'required', placement: true },
  Patina: { template: 'patina', uv: true, texture: 'required', placement: true, colors: true },
  Gunsmith: { template: 'gunsmith', uv: true, texture: 'required', placement: true, colors: true },
  Hydrographic: { template: 'hydrographic', texture: 'required', placement: true, colors: true },
  'Spray-Paint': { template: 'spraypaint', texture: 'required', placement: true, colors: true, spray: true },
  'Anodized Multicolored': { template: 'anodized_multicolor', texture: 'required', placement: true, colors: true },
  'Anodized Airbrushed': { template: 'anodized_airbrushed', texture: 'required', placement: true, colors: true },
  'Solid Color': { template: 'solid_color', texture: 'none', colors: true },
  Anodized: { template: 'anodized', texture: 'none', colors: 1 },
};
const styleOf = (s) => Object.keys(STYLES).find((k) => k.toLowerCase().replace(/[^a-z]/g, '') === String(s).toLowerCase().replace(/[^a-z]/g, ''));

// Glove types (CS2's ids) and the classic CS2 kit of each that a custom pair starts from (its leather, fabric, stitching,
// normal map and wear; the pack's picture goes on top). Any classic kit of the same type can be named as `base` instead.
export const GLOVES = {
  sporty_gloves: { name: 'Sport Gloves', base: 'sporty_light_blue' },
  slick_gloves: { name: 'Driver Gloves', base: 'slick_military' },
  leather_handwraps: { name: 'Hand Wraps', base: 'handwrap_red_slaughter' },
  motorcycle_gloves: { name: 'Moto Gloves', base: 'motorcycle_basic_black' },
  specialist_gloves: { name: 'Specialist Gloves', base: 'specialist_ddpat_green_camo' },
  studded_hydra_gloves: { name: 'Hydra Gloves', base: 'bloodhound_hydra_snakeskin_brass' },
  studded_bloodhound_gloves: { name: 'Bloodhound Gloves', base: 'bloodhound_guerrilla' },
  studded_brokenfang_gloves: { name: 'Broken Fang Gloves', base: 'operation10_snakeskin_black' },
};
const GLOVE_MODES = { color: 3, 'color-layer': 2, mask: 1, 'mask-layer': 0 };

// A skin folder's texture files: role -> the names it may have (PNG or TGA). A Workshop finish's own file names
// (<name>_color, _normal, _rough, _pearl, _ao, _masks) work too.
const TEXTURES = {
  color: ['color', 'albedo', 'pattern'], normal: ['normal'], roughness: ['roughness', 'rough'], pearlescence: ['pearlescence', 'pearl'],
  ao: ['ao', 'occlusion'], masks: ['masks', 'mask', 'paintbynumber', 'material_mask', 'patina_mask'], layermask: ['layermask'],
};
const TEXTURE_MAX = 2048;
const ICON = [512, 384], ICON_L = [1024, 768];
const CRATE_ART_MAX = 1024;

const SKIN_FIELDS = new Set(['name', 'key', 'weapon', 'rarity', 'float', 'stattrak', 'prices', 'pricesStatTrak', 'finish', 'phase', 'phaseWeight', 'patternRule', 'credit', 'workshop', 'iconSeed', 'iconFloat']);
// A Steam Workshop finish's own details (scripts/import-workshop.mjs writes them): who made it, where it is, and their
// written permission to ship it, a file in the skin's folder.
const WORKSHOP_FIELDS = new Set(['id', 'url', 'title', 'creator', 'creatorName', 'updated', 'tags', 'format', 'permission']);
export const workshopUrl = (id) => `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`;
const FINISH_FIELDS = new Set(['style', 'model', 'colors', 'scale', 'rotation', 'offset', 'ignoreWeaponSize', 'roughness', 'pearlescence', 'flipNormalGreen', 'params']);
const GLOVE_FINISH_FIELDS = new Set(['base', 'mode', 'layer', 'scale', 'rotation', 'offset', 'tints', 'palette', 'mirror']);
const CASE_FIELDS = new Set(['name', 'oldName', 'key', 'price', 'date', 'collection', 'oldCollection', 'items', 'rare', 'crate', 'levelDrops', 'allowTradeupProfit', 'credit']);

// ---- ids --------------------------------------------------------------------------------------------------------------
// Names compared and hashed the same however they're typed: one Unicode form, one space, any case.
export const norm = (s) => String(s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
// An old name kept as a skin's "key", read as its name is: " - " (a folder's spelling) for " | ", and a knife's or gloves'
// ★ whether it's written or not. So a key always gives the id the item had under that name.
const keyName = (k, star) => {
  let n = String(k).replace(/｜/g, '|').replace(/\s+/g, ' ').trim();
  if (!n.includes(' | ')) n = n.replace(/ - /, ' | ');
  n = n.replace(/^★\s*/, '');
  return (star ? '★ ' : '') + n;
};
// Names a case can't have: where the game says an item came from (its src) other than a case (a case's items carry the
// case's name), so a case of one of those names would pass for it (Discord's "traded up", the Index's "unboxed"). Any
// "Armory · …" or "Trade with …" too. (Real cases' and collections' names are refused as well, below.)
const RESERVED_CASE_NAMES = new Set(['Agent Locker', 'Market', 'Trade', TRADEUP_SRC, CARE_SRC, 'Collection', 'Unboxed', 'Admin', 'Store', 'Armory'].map((s) => norm(s)));
const reservedCaseName = (n) => RESERVED_CASE_NAMES.has(norm(n)) || /^(armory|trade with)\b/i.test(String(n).trim());
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
// Stable ids from the item's key (its name unless the pack keeps an old one): the same name always gives the same id, so
// rebuilding never moves a player's items. 'x' is never in a real id's hex, and real cases are crate-<digits>.
export const skinId = (key, phase) => 'skin-cx-' + hash('skin|' + norm(key) + (phase ? '|' + norm(phase) : ''));
export const caseId = (key) => 'crate-cx-' + hash('case|' + norm(key));
export const collectionId = (key) => 'collection-cx-' + hash('collection|' + norm(key));
export const kitId = (id) => 'cx_' + hash('kit|' + id);

// ---- helpers ----------------------------------------------------------------------------------------------------------
const round2 = (v) => Math.round(v * 100) / 100;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v) => typeof v === 'number' && Number.isFinite(v);
function hex(c) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(c ?? '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
// A folder name as an item's name: "AK-47 - Nebula" -> "AK-47 | Nebula" (Windows can't put | in a name); a full-width
// bar works too.
const nameFromFolder = (dir) => dir.replace(/｜/g, '|').replace(/ - /, ' | ');
const listDirs = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : []);

// Finds a texture by role in a folder: <name>.png/.tga or *_<name>.png/.tga.
function findTexture(dir, role) {
  const files = fs.readdirSync(dir);
  for (const n of TEXTURES[role]) {
    const f = files.find((x) => new RegExp(`^(.*_)?${n}\\.(png|tga)$`, 'i').test(x));
    if (f) return path.join(dir, f);
  }
  return null;
}

// ---- the build --------------------------------------------------------------------------------------------------------
// Returns { ok, errors, warnings, custom (the data), files: { published path: Buffer } }. Writes nothing itself.
// trial: a try-out build (not into the game): a Workshop finish without its creator's permission on file is only warned
// about (a draft is a try-out too).
export function buildCustom({ src = path.join(ROOT, 'custom'), data = path.join(ROOT, 'src', 'data', 'game-data.json'), keys = path.join(ROOT, 'src', 'data', 'keys.json'), history = null, draft = false, allowRemoved = false, trial = false } = {}) {
  const errors = [], warnings = [];
  const game = typeof data === 'string' ? JSON.parse(fs.readFileSync(data, 'utf8')) : data;
  const realKeys = typeof keys === 'string' ? (fs.existsSync(keys) ? JSON.parse(fs.readFileSync(keys, 'utf8')) : {}) : keys || {};
  const realKeyNames = new Set(Object.values(realKeys).map((k) => norm(k.n)));
  for (const c of game.cases) if (c.key) realKeyNames.add(norm(c.n.replace(/^Sealed /, '') + ' Key'));
  const files = new Map();
  const rel = (f) => path.relative(src, f).replace(/\\/g, '/');
  const err = (where, msg) => errors.push(`${where}: ${msg}`);
  const warn = (where, msg) => warnings.push(`${where}: ${msg}`);

  // What the real game has: names nothing custom may take, and what a weapon is called.
  const realSkins = Object.values(game.skins);
  const realNames = new Map(); // norm(name [+ phase]) -> the real item's name
  for (const s of realSkins) realNames.set(norm(s.n) + (s.ph ? '|' + norm(s.ph) : ''), s.n);
  const realSkinByName = new Map(); // norm(name) -> [real skin], phases together
  for (const s of realSkins) { const k = norm(s.n); if (!realSkinByName.has(k)) realSkinByName.set(k, []); realSkinByName.get(k).push(s); }
  const realCaseNames = new Map(game.cases.map((c) => [norm(c.n), c]));
  const realCollectionNames = new Set(game.collections.map((c) => norm(c.n)));
  const weapons = new Map(); // wid -> { w, cat }
  for (const s of realSkins) if (!weapons.has(s.wid) && (s.wid.startsWith('weapon_') || s.cat === 'gloves')) weapons.set(s.wid, { w: s.w, cat: s.cat });
  const weaponByName = new Map([...weapons].map(([wid, x]) => [norm(x.w), wid]));
  for (const [wid, g] of Object.entries(GLOVES)) weaponByName.set(norm(g.name), wid);

  const skins = {}, kits = {}, cases = [], collections = [];
  const sources = {}; // skin id -> its folder (for the icon baker)
  const customByName = new Map(); // norm(name) -> [custom skin]
  const broken = new Set(); // norm(name) of skins with errors (a case naming one isn't told again that it's missing)
  const taken = new Map(); // norm(name)|phase -> folder
  const idFrom = new Map(); // id -> the folder that has it (two items with one id would be one item to every player)
  const failed = new Set(); // ids of items with errors of their own (not reported as gone from ids.json as well)
  const customByKey = new Map(); // norm(old name kept as "key") -> [custom skin]

  // ---- skins, knives, gloves --------------------------------------------------------------------------------------------
  for (const dir of listDirs(path.join(src, 'skins'))) {
    const folder = path.join(src, 'skins', dir), where = `skins/${dir}`;
    const jsonFile = path.join(folder, 'skin.json');
    if (!fs.existsSync(jsonFile)) { err(where, 'has no skin.json'); continue; }
    let j;
    try { j = JSON.parse(fs.readFileSync(jsonFile, 'utf8')); } catch (e) { err(where + '/skin.json', `isn't valid JSON (${e.message})`); continue; }
    if (!isObj(j)) { err(where + '/skin.json', 'must be a JSON object'); continue; }
    const before = errors.length;
    const e = (m) => err(where + '/skin.json', m);
    for (const k of Object.keys(j)) if (!SKIN_FIELDS.has(k)) e(`unknown field "${k}" (fields: ${[...SKIN_FIELDS].join(', ')})`);

    // Name and weapon.
    let name = String(j.name ?? nameFromFolder(dir)).replace(/\s+/g, ' ').trim();
    const bare = name.replace(/^★\s*/, '');
    const [wName, finName] = bare.split(' | ');
    if (!finName || bare.split(' | ').length !== 2) { e(`name "${name}" must be "<weapon> | <finish>", e.g. "AK-47 | Nebula" (folder names use " - " for " | ")`); continue; }
    let wid = j.weapon != null ? (weapons.has(j.weapon) || GLOVES[j.weapon] ? j.weapon : weaponByName.get(norm(j.weapon))) : weaponByName.get(norm(wName));
    if (!wid) { e(`unknown weapon "${j.weapon ?? wName}": use CS2's name for it (AK-47, Karambit, Sport Gloves...) or its id (weapon_ak47, weapon_knife_karambit, sporty_gloves...)`); continue; }
    const glove = !!GLOVES[wid];
    const info = glove ? { w: GLOVES[wid].name, cat: 'gloves' } : weapons.get(wid);
    if (norm(wName) !== norm(info.w)) { e(`the name starts with "${wName}" but the weapon is ${info.w}`); continue; }
    if (info.cat === 'equipment') { e(`${info.w} can't have custom skins`); continue; }
    const star = info.cat === 'knife' || glove;
    name = (star ? '★ ' : '') + `${info.w} | ${finName.trim()}`;
    const phase = j.phase == null ? null : String(j.phase).trim();
    if (phase === '') e('"phase" is empty');
    // (Phases share one gold slot, split by "phaseWeight". A case's pools pick each item alike, so a gun's phases would
    // each be a skin of their own there: one look per skin instead.)
    if (phase && !star) e('"phase" is for knives and gloves, whose phases share one slot of a case\'s gold slot. In a case\'s pool every phase of a gun would drop as often as a skin of its own: make each look its own skin');
    if (j.key != null && (typeof j.key !== 'string' || !j.key.trim())) e('"key" must be the item\'s old name (to keep the id it had)');
    const key = j.key == null ? name : keyName(j.key, star);
    const id = skinId(key, phase);
    if (idFrom.has(id)) e(`has the same id as ${idFrom.get(id)} (${j.key != null ? `its "key" is that item's name, or that item's own "key"` : 'that item keeps this name as its "key"'}): two items can't share one, or every copy of one would turn into the other`);
    else idFrom.set(id, where);

    // Rarity, float, StatTrak.
    let r = 5;
    if (star) { if (j.rarity != null && rarityOf(j.rarity) !== 5) e(`knives and gloves are always Covert (★), not "${j.rarity}"`); }
    else {
      r = rarityOf(j.rarity);
      if (r < 0) { e(`rarity must be one of ${RARITIES.map((x) => x[0]).join(', ')} (it's "${j.rarity ?? ''}")`); continue; }
    }
    const fl = j.float ?? [0, 1];
    if (!Array.isArray(fl) || fl.length !== 2 || !fl.every(num) || fl[0] < 0 || fl[1] > 1 || fl[0] >= fl[1]) { e(`"float" must be [min, max] with 0 <= min < max <= 1 (it's ${JSON.stringify(j.float)})`); continue; }
    const [mn, mx] = fl.map((x) => Math.round(x * 1e6) / 1e6);
    if (glove && j.stattrak) e('gloves have no StatTrak™');
    const stt = glove ? false : j.stattrak ?? true;
    if (typeof stt !== 'boolean') e('"stattrak" must be true or false');

    // Prices: the pack's own, per wear in the float range (a missing wear is filled from the nearest one, as the game does
    // for real items).
    const wears = wearsIn(mn, mx);
    const priceTable = (obj, label) => {
      if (obj == null) return null;
      if (!isObj(obj)) { e(`"${label}" must be { "FN": 12.5, "MW": 8, ... }`); return null; }
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        if (!WEARS.some(([w]) => w === k)) { e(`"${label}" has "${k}": wears are FN, MW, FT, WW, BS`); continue; }
        if (!wears.includes(k)) { e(`"${label}" has a ${k} price, but a float range of ${mn} to ${mx} has no ${k}`); continue; }
        if (!num(v) || v <= 0 || v > 1e6) { e(`"${label}".${k} must be a price in dollars above 0 (it's ${JSON.stringify(v)})`); continue; }
        out[k] = round2(v);
      }
      if (!Object.keys(out).length) { e(`"${label}" has no price for any of its wears (${wears.join(', ')})`); return null; }
      for (const w of wears) {
        if (out[w] != null) continue;
        const ref = Object.keys(out).sort((a, b) => Math.abs(wears.indexOf(a) - wears.indexOf(w)) - Math.abs(wears.indexOf(b) - wears.indexOf(w)))[0];
        out[w] = round2(out[ref] * (WEAR_RATIO[w] / WEAR_RATIO[ref]));
      }
      return out;
    };
    if (j.prices == null) e(`needs "prices": { ${wears.map((w) => `"${w}": 1.23`).join(', ')} } (in dollars; there's no market for it)`);
    const prices = priceTable(j.prices, 'prices');
    if (j.pricesStatTrak != null && !stt) e('"pricesStatTrak" is for a skin with StatTrak™');
    const sttPrices = stt ? priceTable(j.pricesStatTrak, 'pricesStatTrak') : null;
    const p = {};
    if (prices) for (const w of wears) p[w] = [prices[w], stt ? (sttPrices?.[w] ?? round2(prices[w] * (star ? 1.15 : 1.7))) : null];

    // Phases (like Doppler's: one finish, several looks, each its own item sharing one rare slot).
    if (j.phaseWeight != null && (!num(j.phaseWeight) || j.phaseWeight <= 0)) e('"phaseWeight" must be a number above 0');
    if (j.phaseWeight != null && !phase) e('"phaseWeight" is for an item with a "phase"');
    if (j.patternRule != null && j.patternRule !== 'Fade') e('"patternRule" can only be "Fade" (a fade percentage from the seed)');
    if (j.patternRule != null && glove) e('"patternRule" is for knives and guns: gloves have no Fade');
    if (j.iconFloat != null && (!num(j.iconFloat) || j.iconFloat < mn || j.iconFloat > mx)) e(`"iconFloat" must be in its float range (${mn} to ${mx})`);
    if (j.iconSeed != null && (!Number.isInteger(j.iconSeed) || j.iconSeed < 0 || j.iconSeed > 1000)) e('"iconSeed" must be a pattern seed, 0 to 1000');
    const ws = checkWorkshop(j.workshop, folder, e, draft || trial ? warn.bind(null, where) : null);

    // Name clashes.
    const nk = norm(name) + (phase ? '|' + norm(phase) : '');
    if (realNames.has(nk) || realSkinByName.has(norm(name))) e(`"${name}" is a real CS2 item's name: pick another`);
    if (taken.has(nk)) e(`"${name}"${phase ? ` (${phase})` : ''} is in ${taken.get(nk)} too`);
    taken.set(nk, where);

    // The finish (3D) and its textures.
    const fin = j.finish ?? {};
    if (!isObj(fin)) { e('"finish" must be an object'); continue; }
    const fid = kitId(id);
    const out = `custom/${id}/`;
    const texOut = {}, texImg = {};
    const addTexture = (role, file, max = TEXTURE_MAX, flipGreen = false) => {
      try {
        let img = readImage(file);
        if (img.w & (img.w - 1) || img.h & (img.h - 1)) warn(where, `${path.basename(file)} is ${img.w}x${img.h}: CS2's own textures are powers of two (512, 1024, 2048)`);
        if (Math.max(img.w, img.h) > max) warn(where, `${path.basename(file)} is ${img.w}x${img.h}: it ships at ${max} on its longest side`);
        img = capSize(img, max);
        if (flipGreen) { img = { ...img, data: new Uint8Array(img.data) }; for (let i = 1; i < img.data.length; i += 4) img.data[i] = 255 - img.data[i]; }
        files.set(out + role + '.png', encode(img));
        texOut[role] = out + role + '.png';
        texImg[role] = img;
        return img;
      } catch (x) { e(`${path.basename(file)}: ${x.message}`); return null; }
    };
    let st, kit;
    if (glove) {
      for (const k of Object.keys(fin)) if (!GLOVE_FINISH_FIELDS.has(k)) e(`unknown finish field "${k}" for gloves (fields: ${[...GLOVE_FINISH_FIELDS].join(', ')})`);
      const mode = fin.mode == null ? 3 : GLOVE_MODES[fin.mode];
      if (mode == null) e(`finish "mode" must be one of ${Object.keys(GLOVE_MODES).join(', ')}`);
      const layer = fin.layer ?? 1;
      if (![1, 2, 3, 4].includes(layer)) e('finish "layer" must be 1, 2, 3 or 4 (the glove\'s material layers)');
      const pat = findTexture(folder, 'color');
      if (!pat) e(`needs its picture: pattern.png (or color.png), painted on the ${info.w}' UV layout (CUSTOM_CONTENT.md, Gloves)`);
      else addTexture('pattern', pat);
      const lm = findTexture(folder, 'layermask');
      if (lm) addTexture('layermask', lm);
      const tints = (fin.tints || []).map(hex);
      if (fin.tints != null && (!Array.isArray(fin.tints) || fin.tints.length > 8 || tints.some((t) => !t))) e('finish "tints" must be up to 8 colours like "#a1b2c3"');
      if (fin.palette != null && (!Array.isArray(fin.palette) || fin.palette.length !== 4 || !fin.palette.every((x) => [1, 2, 3, 4, 5, 6, 7, 8].includes(x)))) e('finish "palette" must be 4 tint numbers (1 to 8)');
      const placement = checkPlacement(fin, e, { rotation: [0, 0], offset: [[0, 0], [0, 0]] });
      if (fin.scale != null && (!num(fin.scale) || fin.scale <= 0)) e('finish "scale" must be a number above 0');
      if (fin.base != null && typeof fin.base !== 'string') e('finish "base" must be a CS2 glove kit\'s name');
      st = 'None'; // (as CS2's own gloves have it: they're drawn by the glove shader, not with a weapon finish style)
      kit = { kind: 'glove', base: fin.base || GLOVES[wid].base, pattern: texOut.pattern, mode, layer, scale: fin.scale ?? 1, ...placement, wear: [mn, mx],
        ...(tints.length ? { tints: tints.map((c) => c.map((x) => Math.round((x / 255) * 1e4) / 1e4)) } : {}), ...(fin.palette ? { palette: fin.palette } : {}),
        ...(texOut.layermask ? { layerMask: texOut.layermask } : {}), ...(fin.mirror ? { mirror: true } : {}) };
    } else {
      for (const k of Object.keys(fin)) if (!FINISH_FIELDS.has(k)) e(`unknown finish field "${k}" (fields: ${[...FINISH_FIELDS].join(', ')})`);
      st = styleOf(fin.style ?? 'Custom Paint Job');
      if (!st) { e(`finish "style" must be one of ${Object.keys(STYLES).join(', ')} (it's "${fin.style}")`); continue; }
      const S = STYLES[st];
      if (fin.model != null && !['hd', 'legacy'].includes(fin.model)) e('finish "model" must be "hd" (the CS2 model) or "legacy" (the CS:GO one)');
      const vars = {};
      const tex = (role) => findTexture(folder, role);
      const color = tex('color');
      if (S.texture === 'required' && !color) e(`a ${st} needs color.png: ${S.uv ? 'painted on the model\'s UV layout, its alpha the wear mask' : 'the pattern\'s mask, its layers in red, green and blue'}`);
      if (S.texture === 'none' && color) warn(where, `${st} uses no colour texture: ${path.basename(color)} is left out`);
      if (color && S.texture === 'required' && addTexture('color', color)) vars['exposed_params.g_tPattern'] = { texture: texOut.color };
      const normal = tex('normal');
      if (normal && addTexture('normal', normal, TEXTURE_MAX, !!fin.flipNormalGreen)) Object.assign(vars, { 'exposed_params.g_bUseNormalMap': { bool: true }, 'exposed_params.g_tNormal': { texture: texOut.normal } });
      const rough = tex('roughness');
      if (rough && addTexture('roughness', rough)) Object.assign(vars, { 'exposed_params.g_bUseRoughness': { bool: true }, 'exposed_params.g_tPaintRoughness': { texture: texOut.roughness } });
      const pearl = tex('pearlescence');
      if (pearl && addTexture('pearlescence', pearl)) Object.assign(vars, { 'exposed_params.g_bUsePearlescenceMask': { bool: true }, 'exposed_params.g_tPearlescenceMask': { texture: texOut.pearlescence } });
      const ao = tex('ao');
      if (ao && addTexture('ao', ao)) Object.assign(vars, { 'exposed_params.g_bOverrideAmbientOcclusion': { bool: true }, 'exposed_params.g_tFinalAmbientOcclusion': { texture: texOut.ao } });
      const masks = tex('masks');
      if (masks && addTexture('masks', masks)) {
        Object.assign(vars, { 'exposed_params.g_bOverrideDefaultMasks': { bool: true }, 'exposed_params.g_tPaintByNumberMasks': { texture: texOut.masks } });
        if (S.spray) vars['exposed_params.g_bUsePaintByNumberMasks'] = { bool: true };
      }
      // Colours.
      if (fin.colors != null) {
        const cs = Array.isArray(fin.colors) ? fin.colors.map(hex) : [];
        if (!S.colors) e(`a ${st} has no colours of its own (its texture is the colour)`);
        else if (!cs.length || cs.length > (S.colors === 1 ? 1 : 4) || cs.some((c) => !c)) e(`finish "colors" must be ${S.colors === 1 ? '1 colour' : 'up to 4 colours'} like "#a1b2c3"`);
        else cs.forEach((c, i) => { vars[`exposed_params.g_vColor${i}`] = { color: c }; });
      }
      // Placement: scale, and what the seed picks (rotation and offset ranges).
      if (fin.scale != null) { if (!num(fin.scale) || fin.scale <= 0 || fin.scale > 10) e('finish "scale" must be above 0 and at most 10'); else vars['exposed_params.g_flPatternTexCoordScale'] = { value: fin.scale }; }
      if (S.placement) {
        const pl = checkPlacement(fin, e, S.uv ? { rotation: [0, 0], offset: [[0, 0], [0, 0]] } : { rotation: [0, 0], offset: [[0, 0], [1, 1]] });
        vars['econ_instance.g_flPatternTexCoordRotation'] = { value: pl.rotation[0], min: pl.rotation[0], max: pl.rotation[1] };
        vars['econ_instance.g_vPatternTexCoordOffset'] = { value: pl.offset[0], min: pl.offset[0], max: pl.offset[1] };
        // The Fade rule's percentage follows the rotation the seed picks (as CS2's own Fades' do: patterns.js), so the
        // rotation is what moves the fade, and nothing else may.
        if (j.patternRule === 'Fade') {
          if (pl.rotation[0] === pl.rotation[1]) e('"patternRule": "Fade" needs a "rotation" range: the seed\'s rotation in it is the fade percentage (80% at the first angle, 100% at the second)');
          if (JSON.stringify(pl.offset[0]) !== JSON.stringify(pl.offset[1])) e('"patternRule": "Fade" needs a fixed "offset" (like [[0.1, 0.2], [0.1, 0.2]], as CS2\'s own Fades have): its percentage goes by the rotation alone, so an offset that moves with the seed would change the blade without changing the percentage');
        }
      } else if (fin.rotation != null || fin.offset != null) e(`a ${st} has no pattern to place: "rotation" and "offset" don't apply`);
      if (j.patternRule === 'Fade' && !S.placement) e(`"patternRule": "Fade" needs a style the seed places (Anodized Airbrushed, as CS2's Fades): a ${st} has none`);
      if (fin.ignoreWeaponSize != null) { if (typeof fin.ignoreWeaponSize !== 'boolean') e('finish "ignoreWeaponSize" must be true or false'); else if (S.placement) vars['exposed_params.g_bIgnoreWeaponSizeScale'] = { bool: fin.ignoreWeaponSize }; }
      if (fin.roughness != null) { if (!num(fin.roughness) || fin.roughness < 0 || fin.roughness > 1) e('finish "roughness" must be 0 to 1'); else vars['exposed_params.g_flPaintRoughness'] = { value: fin.roughness }; }
      if (fin.pearlescence != null) { if (!num(fin.pearlescence) || fin.pearlescence < -10 || fin.pearlescence > 10) e('finish "pearlescence" must be -10 to 10'); else vars['exposed_params.g_flPearlescentScale'] = { value: fin.pearlescence }; }
      // Anything else the template exposes, by its own name (CUSTOM_CONTENT.md lists them).
      if (fin.params != null) {
        if (!isObj(fin.params)) e('finish "params" must be { "exposed_params.<name>": value }');
        else for (const [k, v] of Object.entries(fin.params)) {
          if (!/^(exposed_params|econ_instance)\.g_[A-Za-z0-9]+$/.test(k)) { e(`finish "params" "${k}": names are exposed_params.g_… or econ_instance.g_…`); continue; }
          const spec = paramSpec(v);
          if (!spec) e(`finish "params" "${k}": a number, [numbers], true/false, "#rrggbb", or { value, min, max }`);
          else vars[k] = spec;
        }
      }
      kit = { kind: 'weapon', template: S.template, legacy: info.cat !== 'knife' && fin.model === 'legacy', wear: [mn, mx], vars };
    }

    // The 2D picture: the pack's icon.png, else (with --draft) a stand-in for the icon baker.
    const iconFile = findIcon(folder);
    if (iconFile) addIcon(iconFile, out, files, e, warn.bind(null, where));
    else if (draft) addDraftIcon(texImg.color || texImg.pattern, files, out);
    else e(`needs icon.png: its picture in the game (any size, a transparent PNG; it's fitted to ${ICON_L.join('x')}). node scripts/bake-custom-icons.mjs makes one from the 3D`);

    if (errors.length > before) { broken.add(norm(name)); failed.add(id); continue; }
    const rc = RARITIES[r][2];
    const rec = {
      id, n: name, w: info.w, wid, cat: info.cat, fin: finName.trim(), fid, st, r, rc, rn: star ? (glove ? 'Extraordinary' : 'Covert') : RARITIES[r][1],
      mn, mx, stt, star, img: out + 'icon.png', p,
      ...(phase ? { ph: phase } : {}), ...(j.phaseWeight != null ? { pw: j.phaseWeight } : {}), ...(j.patternRule ? { pr: j.patternRule } : {}),
      ...(j.credit ? { credit: String(j.credit).slice(0, 200) } : {}), ...(ws ? { ws } : {}),
    };
    skins[id] = rec;
    kits[fid] = kit;
    sources[id] = { dir: folder, iconFloat: j.iconFloat, iconSeed: j.iconSeed };
    const nn = norm(name);
    if (!customByName.has(nn)) customByName.set(nn, []);
    customByName.get(nn).push(rec);
    if (j.key != null && norm(key) !== nn) {
      if (!customByKey.has(norm(key))) customByKey.set(norm(key), []);
      customByKey.get(norm(key)).push(rec);
    }
  }
  // An old name kept as a "key" that another item has as its name now: a case naming it would mean that one.
  for (const [k, list] of customByKey) {
    const other = customByName.get(k);
    if (other) err(`skins/${list[0].n}`, `its "key", "${other[0].n}", is the name of another custom item now: give that one another name, or this one another key`);
  }
  // Phases of one name must agree on what kind of item they are.
  for (const list of customByName.values()) {
    if (list.length > 1 && list.some((s) => !s.ph)) err(`skins/${list[0].n}`, 'has several folders of the same name: each needs its own "phase" (like Doppler\'s Phase 1, Ruby...)');
    if (list.some((s) => s.wid !== list[0].wid || s.r !== list[0].r)) err(`skins/${list[0].n}`, 'its phases must be the same weapon and rarity');
  }

  // ---- cases ------------------------------------------------------------------------------------------------------------
  const lookup = (n, where) => {
    const k = norm(n);
    const c = customByName.get(k);
    if (c) return c.map((s) => s.id);
    const real = realSkinByName.get(k), old = customByKey.get(k);
    // A custom item's old name ("key"): what a case still says after a rename. That's the item, unless a real item has the
    // name now (Valve's own, the reason it was renamed): then the case must say which it means.
    if (old && real) { err(where, `"${n}" is both a real CS2 item's name (now) and the old name of ${old[0].n} (its "key"): write "${old[0].n}" for the custom one. A real item whose name a custom one had can't go in a custom case`); return null; }
    if (old) { warn(where, `"${n}" is ${old[0].n}'s old name (its "key"): that's the item it means. Write its new name here`); return old.map((s) => s.id); }
    if (real) return real.map((s) => s.id);
    if (broken.has(k)) { err(where, `"${n}" has errors of its own (above)`); return null; }
    err(where, `"${n}" isn't a custom skin here or a real CS2 item`);
    return null;
  };
  const skinOf = (id) => skins[id] || game.skins[id];
  const caseNames = new Map();
  const caseInfo = new Map(); // case id -> { where, allowProfit }
  for (const dir of listDirs(path.join(src, 'cases'))) {
    const folder = path.join(src, 'cases', dir), where = `cases/${dir}/case.json`;
    const jsonFile = path.join(folder, 'case.json');
    if (!fs.existsSync(jsonFile)) { err(`cases/${dir}`, 'has no case.json'); continue; }
    let j;
    try { j = JSON.parse(fs.readFileSync(jsonFile, 'utf8')); } catch (x) { err(where, `isn't valid JSON (${x.message})`); continue; }
    if (!isObj(j)) { err(where, 'must be a JSON object'); continue; }
    const before = errors.length;
    const e = (m) => err(where, m);
    for (const k of Object.keys(j)) if (!CASE_FIELDS.has(k)) e(`unknown field "${k}" (fields: ${[...CASE_FIELDS].join(', ')})`);
    const name = String(j.name ?? dir).replace(/\s+/g, ' ').trim();
    if (!name) { e('needs a "name"'); continue; }
    if (realCaseNames.has(norm(name))) e(`"${name}" is a real CS2 container's name: pick another`);
    if (realCollectionNames.has(norm(name))) e(`"${name}" is a real collection's name: pick another`);
    if (reservedCaseName(name)) e(`"${name}" is what the game calls a place items come from (the Market, a trade, a Trade Up Contract, the Armory...): pick another`);
    if (caseNames.has(norm(name))) e(`"${name}" is in ${caseNames.get(norm(name))} too`);
    caseNames.set(norm(name), `cases/${dir}`);
    // Its id is from its name, or the old name it keeps ("oldName", after a rename): players' unopened cases and their keys
    // stay that case.
    const oldName = j.oldName == null ? null : String(j.oldName).replace(/\s+/g, ' ').trim();
    if (j.oldName != null && (typeof j.oldName !== 'string' || !oldName)) e('"oldName" must be the case\'s old name (to keep the id it had)');
    const id = caseId(oldName || name);
    if (idFrom.has(id)) e(`has the same id as ${idFrom.get(id)} (one's "oldName" is the other's name or old name): two cases can't share one`);
    else idFrom.set(id, `cases/${dir}`);
    const oldCol = j.oldCollection == null ? null : String(j.oldCollection).replace(/\s+/g, ' ').trim();
    if (j.oldCollection != null && (typeof j.oldCollection !== 'string' || !oldCol)) e('"oldCollection" must be its collection\'s old name (to keep the id it had)');
    if (oldCol && j.collection == null) e('"oldCollection" is for a case with a "collection"');
    const colGuess = j.collection != null && String(j.collection).trim() ? collectionId(oldCol || String(j.collection).trim()) : null;
    if (j.allowTradeupProfit != null && typeof j.allowTradeupProfit !== 'boolean') e('"allowTradeupProfit" must be true or false');
    if (!num(j.price) || j.price < 0 || j.price > 1e5) e(`needs "price": the case's own price in dollars (its key's ${game.keyPrice ?? 2.49} is added when it takes one)`);
    if (j.key != null && typeof j.key !== 'boolean') e('"key" must be true (it takes a key, as weapon cases do) or false');
    const key = j.key ?? true;
    if (key && realKeyNames.has(norm(name.replace(/^Sealed /, '') + ' Key'))) e(`its key, "${name} Key", is a real key's name`);
    if (j.date != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(j.date))) e('"date" must be YYYY-MM-DD');
    if (j.levelDrops != null && typeof j.levelDrops !== 'boolean') e('"levelDrops" must be true or false');

    // What it holds: { "Mil-Spec": [names], ... } (checked against each skin's rarity) or a plain list of names.
    const pools = {};
    const put = (ids, want, n) => {
      for (const sid of ids) {
        const s = skinOf(sid);
        if (s.star) { e(`"${n}" is a knife or gloves: those go in "rare"`); return; }
        if (s.v) { e(`"${n}" has no finish`); return; }
        if (want != null && s.r !== want) { e(`"${n}" is ${RARITIES[s.r]?.[1] ?? 'another rarity'}, not ${RARITIES[want][1]}`); return; }
        if (s.r < 2 || s.r > 5) { e(`"${n}" is ${RARITIES[s.r]?.[1]}: a case holds Mil-Spec to Covert`); return; }
        (pools[s.r] ||= []).includes(sid) || pools[s.r].push(sid);
      }
    };
    if (Array.isArray(j.items)) for (const n of j.items) { const ids = lookup(n, where); if (ids) put(ids, null, n); }
    else if (isObj(j.items)) {
      for (const [rk, list] of Object.entries(j.items)) {
        const want = rarityOf(rk);
        if (want < 2) { e(`"items" has "${rk}": a case's rarities are Mil-Spec, Restricted, Classified and Covert`); continue; }
        if (!Array.isArray(list)) { e(`"items"."${rk}" must be a list of names`); continue; }
        for (const n of list) { const ids = lookup(n, where); if (ids) put(ids, want, n); }
      }
    } else e('needs "items": { "Mil-Spec": [names], "Restricted": [...], "Classified": [...], "Covert": [...] }');
    if (!Object.keys(pools).length && errors.length === before) e('holds nothing');

    // The gold slot: knives and gloves, custom or real ({ "from": "<real case>" } takes that case's whole list).
    const rare = [];
    const addRare = (ids, n) => {
      if (ids.some((sid) => !skinOf(sid).star)) { e(`"${n}" isn't a knife or gloves (the gold slot holds only ★ items)`); return; }
      if (rare.some((g) => g.join() === ids.join())) return;
      // (One slot per finish; a finish with phases is one slot, its phases split it.)
      rare.push(ids);
    };
    for (const x of j.rare ?? []) {
      if (isObj(x) && x.from) {
        const c = realCaseNames.get(norm(x.from));
        if (!c?.rare?.length) { e(`"rare": "${x.from}" isn't a real case with knives or gloves`); continue; }
        for (const g of c.rare) addRare(g, D_name(game, g[0]));
      } else if (typeof x === 'string') { const ids = lookup(x, where); if (ids) addRare(ids, x); }
      else e('"rare" entries are names, or { "from": "<a real case>" }');
    }
    if (j.rare != null && !Array.isArray(j.rare)) e('"rare" must be a list');

    // Its collection (custom skins in it can then be traded up: CUSTOM_CONTENT.md, Trade-ups).
    let col = null;
    if (j.collection != null) {
      const cn = String(j.collection).trim();
      if (!cn) e('"collection" is empty');
      else if (realCollectionNames.has(norm(cn))) e(`"${cn}" is a real collection's name`);
      else if (collections.some((c) => norm(c.n) === norm(cn))) e(`"${cn}" is another case's collection too`);
      else if (collections.some((c) => c.id === colGuess)) e(`"${cn}" has the same id as another case's collection (one's "oldCollection" is the other's name or old name)`);
      else col = { id: colGuess, n: cn };
    }

    // Pictures.
    const out = `custom/${id}/`;
    const pic = findIcon(folder, ['case', 'icon']);
    if (!pic) e(`needs case.png: its picture, a transparent PNG like Steam's (it's fitted to ${ICON.join('x')} and ${ICON_L.join('x')})`);
    else addIcon(pic, out, files, e, warn.bind(null, `cases/${dir}`));
    let crate = null;
    if (j.crate != null) {
      if (!isObj(j.crate)) e('"crate" must be { "base": "<a real case>" }');
      else {
        const base = realCaseNames.get(norm(j.crate.base ?? 'Kilowatt Case'));
        const def = /^crate-(\d+)$/.exec(base?.id || '')?.[1];
        if (!def) e(`"crate"."base" must be a real case whose 3D crate to use, e.g. "Kilowatt Case" (it's "${j.crate.base}")`);
        else {
          crate = { base: def };
          const art = findIcon(folder, ['crate']);
          if (art) {
            try {
              const img = capSize(readImage(art), CRATE_ART_MAX);
              files.set(out + 'crate.png', encode(img));
              crate.art = out + 'crate.png';
            } catch (x) { e(`${path.basename(art)}: ${x.message}`); }
          } else warn(`cases/${dir}`, `has no crate.png: its 3D crate is ${base.n}'s, with ${base.n}'s art`);
        }
      }
    }
    if (errors.length > before) { failed.add(id); failed.add('key-' + id); if (colGuess) failed.add(colGuess); continue; }
    const ids = [...new Set(Object.values(pools).flat())];
    if (col) {
      // Only its custom skins join its collection; real ones keep their own (real trade-ups never change).
      const tiers = {};
      for (const [rk, list] of Object.entries(pools)) { const own = list.filter((sid) => skins[sid]); if (own.length) tiers[rk] = own; }
      for (const sid of Object.values(tiers).flat()) {
        if (skins[sid].col && skins[sid].col !== col.id) err(where, `"${skins[sid].n}" is in another case's collection already`);
        skins[sid].col = col.id;
      }
      collections.push({ id: col.id, n: col.n, img: out + 'icon.png', rel: j.date || '', tiers, packages: [], caseId: id });
    }
    const rareKind = !rare.length ? null : rare.some((g) => skinOf(g[0]).cat === 'gloves') ? (rare.some((g) => skinOf(g[0]).cat === 'knife') ? 'mixed' : 'gloves') : 'knife';
    cases.push({
      id, n: name, img: out + 'icon.png', kind: 'case', key, date: j.date || '', price: round2(j.price), pools,
      ...(rare.length ? { rare, rareKind } : {}), ...(col ? { col: col.id } : {}), ...(crate ? { crate } : {}),
      ...(j.levelDrops ? { levelDrops: true } : {}), ...(j.credit ? { credit: String(j.credit).slice(0, 200) } : {}),
    });
    caseInfo.set(id, { where: `cases/${dir}/case.json`, allowProfit: j.allowTradeupProfit === true });
    if (!ids.length) warn(`cases/${dir}`, 'holds no skins');
    // How it's priced against what it holds (the game's own cases are worth about 80% of what they cost to open).
    const ev = expectedValue(cases.at(-1), skinOf, game.keyPrice ?? 2.49);
    if (ev && (ev.ratio < 0.4 || ev.ratio > 1.5)) warn(`cases/${dir}`, `opening it costs $${ev.cost.toFixed(2)} and gives $${ev.ev.toFixed(2)} on average (${Math.round(ev.ratio * 100)}%): real cases give about 80%`);
  }

  // ---- trade-ups ----------------------------------------------------------------------------------------------------------
  // A pack's prices are its own, so nothing else keeps a contract from paying out more than its inputs cost: ten of the
  // cheapest custom skin of a rarity against the next rarity's average, five of the cheapest custom Covert against the gold
  // slot's (phases by their weights), at each wear, StatTrak™ too. (Outputs are taken at the inputs' wear: their float follows
  // the inputs'.) Above 1 is a warning; above 2 an error unless the case says "allowTradeupProfit": true.
  for (const col of collections) {
    const c = cases.find((x) => x.id === col.caseId), info = caseInfo.get(c.id);
    const at = (s, w, k) => { const v = s.p?.[w]?.[k]; return num(v) && v > 0 ? v : null; };
    const avgAt = (s, w, k) => at(s, w, k) ?? (() => { const vs = Object.values(s.p || {}).map((x) => x?.[k]).filter((v) => num(v) && v > 0); return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null; })();
    let worst = null;
    for (let r = 2; r <= 5; r++) {
      const inputs = (col.tiers[r] || []).map((id) => skins[id]);
      if (!inputs.length) continue;
      const groups = r < 5 ? (col.tiers[r + 1] || []).map((id) => [id]) : c.rare || [];
      if (!groups.length) continue;
      for (const [w] of WEARS) for (const k of [0, 1]) {
        const ins = inputs.map((s) => at(s, w, k)).filter((v) => v != null);
        if (!ins.length) continue;
        const cost = (r < 5 ? 10 : 5) * Math.min(...ins);
        // (A StatTrak™ contract gives no gloves.)
        const outs = groups.filter((g) => k === 0 || skinOf(g[0]).stt).map((g) => {
          const ws = g.map((id) => (g.length > 1 ? phaseWeight(skinOf(id)) : 1)), t = ws.reduce((a, b) => a + b, 0);
          const vs = g.map((id) => avgAt(skinOf(id), w, k));
          return vs.some((v) => v == null) ? null : g.reduce((s, id, i) => s + (ws[i] / t) * vs[i], 0);
        }).filter((v) => v != null);
        if (!outs.length) continue;
        const ratio = outs.reduce((a, b) => a + b, 0) / outs.length / cost;
        if (!worst || ratio > worst.ratio) worst = { ratio, r, w, k, cost, ev: ratio * cost };
      }
    }
    if (!worst || worst.ratio <= 1) continue;
    const msg = `a trade-up of ${worst.r < 5 ? 10 : 5} ${worst.k ? 'StatTrak™ ' : ''}${worst.w} ${RARITIES[worst.r][1]} skins of ${col.n} costs $${worst.cost.toFixed(2)} (its cheapest) and gives $${worst.ev.toFixed(2)} on average (${Math.round(worst.ratio * 100)}%): `
      + 'a contract shouldn\'t be worth more than its inputs. Price the inputs higher or what they trade up into lower';
    if (worst.ratio > 2 && !info.allowProfit) err(info.where, msg + ' (or, to ship it anyway, "allowTradeupProfit": true)');
    else warn(info.where, msg);
  }

  // ---- ids that were built before ------------------------------------------------------------------------------------------
  const now = { ...Object.fromEntries(Object.values(skins).map((s) => [s.id, s.n + (s.ph ? ` (${s.ph})` : '')])), ...Object.fromEntries(cases.map((c) => [c.id, c.n])), ...Object.fromEntries(collections.map((c) => [c.id, c.n])),
    ...Object.fromEntries(cases.filter((c) => c.key).map((c) => ['key-' + c.id, c.n + ' Key'])) };
  let seen = {};
  if (history && fs.existsSync(history)) { try { seen = JSON.parse(fs.readFileSync(history, 'utf8')).ids || {}; } catch { err('ids.json', "can't be read: restore it from git"); } }
  // (Not an item that has errors of its own, above: that one's fixed with them.)
  const gone = Object.entries(seen).filter(([id]) => !now[id] && !failed.has(id));
  if (gone.length && !allowRemoved) {
    const how = (id) => (id.startsWith('key-') ? 'its case takes no key now? Players\' keys would be Unknown items too: keep "key": true'
      : id.startsWith('crate-') ? 'renamed? keep its old name as "oldName"' : id.startsWith('collection-') ? 'renamed? keep its old name as "oldCollection"' : 'renamed? keep its old name as "key"');
    for (const [id, n] of gone) err('ids.json', `"${n}" (${id}) was in an earlier build and isn't now. Players who have it would see "Unknown item" worth nothing. Put it back (${how(id)}), or build with --allow-removed`);
  }

  const custom = { format: CX_FORMAT, skins: sortKeys(skins), cases: cases.sort(byId), collections: collections.sort(byId), kits: sortKeys(kits) };
  const any = Object.keys(skins).length || cases.length;
  return {
    ok: !errors.length, errors, warnings, custom: any ? custom : null, lock: any ? customLock(custom) : null, generatedAt: game.generatedAt,
    files: any ? files : new Map(), ids: now, removed: gone.map(([id]) => id), sources,
  };
}

const byId = (a, b) => (a.id < b.id ? -1 : 1);
const sortKeys = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
const D_name = (game, id) => game.skins[id]?.n || id;

// Seed placement ranges: rotation [from, to] in degrees (either way round, as CS2's own kits have it: the Fade rule goes from
// the first to the second), offset [[minX, minY], [maxX, maxY]].
function checkPlacement(fin, e, defaults) {
  const rotation = fin.rotation ?? defaults.rotation, offset = fin.offset ?? defaults.offset;
  if (!Array.isArray(rotation) || rotation.length !== 2 || !rotation.every(num) || rotation.some((x) => Math.abs(x) > 360)) e('finish "rotation" must be [from, to] in degrees (-360 to 360): the seed picks one in it');
  const pt = (v) => Array.isArray(v) && v.length === 2 && v.every(num) && v.every((x) => Math.abs(x) <= 1);
  if (!Array.isArray(offset) || offset.length !== 2 || !offset.every(pt) || offset[0][0] > offset[1][0] || offset[0][1] > offset[1][1]) e('finish "offset" must be [[minX, minY], [maxX, maxY]] (-1 to 1): the seed picks one in it');
  return { rotation, offset };
}

// A Steam Workshop finish's "workshop" details: { id, by (the creator's name), sid (their Steam id) } for the item, which
// the game shows with a link to the Workshop item (not part of the data lock: crediting someone doesn't change what an
// item is). Its creator's written permission must be on file to build it into the game; a try-out (`trialWarn`) only warns.
function checkWorkshop(w, folder, e, trialWarn) {
  if (w == null) return null;
  if (!isObj(w)) { e('"workshop" must be { "id": "<its number>", "creatorName": "...", "permission": "permission.txt", ... }'); return null; }
  for (const k of Object.keys(w)) if (!WORKSHOP_FIELDS.has(k)) e(`unknown "workshop" field "${k}" (fields: ${[...WORKSHOP_FIELDS].join(', ')})`);
  const id = String(w.id ?? '');
  if (!/^\d{1,20}$/.test(id)) { e('"workshop"."id" must be the Workshop item\'s number (its link ends in ?id=<number>)'); return null; }
  if (w.url != null && w.url !== workshopUrl(id)) e(`"workshop"."url" must be ${workshopUrl(id)}`);
  const by = typeof w.creatorName === 'string' ? w.creatorName.replace(/\s+/g, ' ').trim() : '';
  if (!by) e('"workshop"."creatorName" must be its creator\'s name: the game credits them');
  if (w.creator != null && !/^\d{17}$/.test(String(w.creator))) e('"workshop"."creator" must be the creator\'s Steam id (17 digits)');
  const perm = typeof w.permission === 'string' && w.permission && !/[\\/]|^\.\.?$/.test(w.permission) && fs.existsSync(path.join(folder, w.permission));
  if (!perm) {
    const m = `"workshop"."permission" must name a file in this folder with the creator's written permission to ship it (e.g. "permission.txt"): a Workshop finish belongs to its creator (CUSTOM_CONTENT.md, Steam Workshop finishes)`;
    if (trialWarn) trialWarn(m + '. A try-out builds without it; the game\'s own build doesn\'t'); else e(m);
  }
  return { id, by: by.slice(0, 64), ...(w.creator != null && /^\d{17}$/.test(String(w.creator)) ? { sid: String(w.creator) } : {}) };
}

function paramSpec(v) {
  if (typeof v === 'boolean') return { bool: v };
  if (num(v)) return { value: v };
  if (Array.isArray(v) && v.length && v.length <= 4 && v.every(num)) return { value: v };
  if (typeof v === 'string' && hex(v)) return { color: hex(v) };
  if (isObj(v) && (num(v.value) || (Array.isArray(v.value) && v.value.every(num)))) return { value: v.value, ...(v.min != null ? { min: v.min } : {}), ...(v.max != null ? { max: v.max } : {}) };
  return null;
}

function findIcon(dir, names = ['icon']) {
  const files = fs.readdirSync(dir);
  for (const n of names) { const f = files.find((x) => x.toLowerCase() === n + '.png'); if (f) return path.join(dir, f); }
  return null;
}
// The picture at the game's two sizes (Steam's: 512x384 and 1024x768), fitted on a transparent canvas.
function addIcon(file, out, files, e, warn) {
  try {
    const img = readImage(file);
    if (!hasTransparency(img)) warn(`${path.basename(file)} has no transparent background: the game's tiles show it as a box`);
    if (Math.max(img.w / ICON_L[0], img.h / ICON_L[1]) < 0.5) warn(`${path.basename(file)} is only ${img.w}x${img.h}: it looks soft at ${ICON_L.join('x')}`);
    files.set(out + 'icon.png', encode(fit(img, ...ICON)));
    files.set(out + 'icon-l.png', encode(fit(img, ...ICON_L)));
  } catch (x) { e(`${path.basename(file)}: ${x.message}`); }
}
// --draft's stand-in picture: the item's texture as a card (until scripts/bake-custom-icons.mjs draws the real one).
function addDraftIcon(tex, files, out) {
  const [W, H] = ICON, img = { w: W, h: H, data: new Uint8Array(W * H * 4) };
  const src = tex ? resize(tex, W - 120, H - 80) : null;
  for (let y = 40; y < H - 40; y++) for (let x = 60; x < W - 60; x++) {
    const o = (y * W + x) * 4, s = src ? ((y - 40) * src.w + (x - 60)) * 4 : -1;
    img.data[o] = s >= 0 ? src.data[s] : 120; img.data[o + 1] = s >= 0 ? src.data[s + 1] : 120; img.data[o + 2] = s >= 0 ? src.data[s + 2] : 130; img.data[o + 3] = 255;
  }
  files.set(out + 'icon.png', encode(img));
  files.set(out + 'icon-l.png', encode(resize(img, ...ICON_L)));
}

// Expected value of opening a case (as the Cases page works it out), against what it costs.
function expectedValue(c, skinOf, keyPrice) {
  const odds = [['2', 0.7992], ['3', 0.1598], ['4', 0.032], ['5', 0.0064], ['rare', 0.0026]].filter(([k]) => (k === 'rare' ? c.rare?.length : c.pools[k]?.length));
  const tw = odds.reduce((s, [, w]) => s + w, 0);
  if (!tw) return null;
  const val = (s) => {
    const rows = Object.values(s.p || {});
    if (s.v) return s.p.V[0];
    return rows.reduce((a, r) => a + r[0], 0) / (rows.length || 1);
  };
  // (A finish with phases is one slot, its phases weighed as they drop.)
  const PH = { 'Phase 1': 0.22, 'Phase 2': 0.22, 'Phase 3': 0.22, 'Phase 4': 0.22, Ruby: 0.045, Sapphire: 0.045, 'Black Pearl': 0.03, Emerald: 0.06 };
  const group = (g) => {
    const ws = g.map((id) => (g.length > 1 ? skinOf(id).pw ?? PH[skinOf(id).ph] ?? 0.2 : 1)), t = ws.reduce((a, b) => a + b, 0);
    return g.reduce((s, id, i) => s + (ws[i] / t) * val(skinOf(id)), 0);
  };
  let ev = 0;
  for (const [k, w] of odds) {
    const avg = k === 'rare' ? c.rare.reduce((s, g) => s + group(g), 0) / c.rare.length : c.pools[k].reduce((s, id) => s + val(skinOf(id)), 0) / c.pools[k].length;
    ev += (w / tw) * avg;
  }
  const cost = c.price + (c.key ? keyPrice : 0);
  return { ev, cost, ratio: cost ? ev / cost : 0 };
}

// Writes a build into `out` (src/ by default): data/custom.json and custom/, replacing what an earlier build left there. A
// build with nothing in it removes them both.
export function writeBuild(result, { out = path.join(ROOT, 'src'), history = null } = {}) {
  const dataFile = path.join(out, 'data', 'custom.json'), dir = path.join(out, 'custom');
  fs.rmSync(dir, { recursive: true, force: true });
  if (!result.custom) { fs.rmSync(dataFile, { force: true }); }
  else {
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    // (Items sorted by id, each record's fields in a fixed order: the same packs always write the same bytes. Prices stay
    // in wear order, as the game's own data has them.)
    fs.writeFileSync(dataFile, JSON.stringify(result.custom) + '\n');
    for (const [p, buf] of result.files) {
      const f = path.join(out, ...p.split('/'));
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, buf);
    }
  }
  if (history) {
    const ids = Object.fromEntries(Object.entries(result.ids).sort(([a], [b]) => (a < b ? -1 : 1)));
    if (Object.keys(ids).length) fs.writeFileSync(history, JSON.stringify({ about: 'Every custom item scripts/build-custom.mjs has built (keep this file with the packs).', ids }, null, 2) + '\n');
  }
}

// ---- command line -----------------------------------------------------------------------------------------------------------
// A try-out build's folder (--try): the same one every time, so the commands it prints stay the same.
export const TRY_DIR = path.join(os.tmpdir(), 'cs2sim-custom-try');

// Whether a version of the game is out already: its release's tag (vX.Y.Z) is in the repository. (null: git can't say.)
function released(version) {
  try { return execFileSync('git', ['tag', '-l', 'v' + version], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== ''; } catch { return null; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const stop = (m) => { console.log('ERROR    ' + m); process.exit(1); };
  // (A path with a shell's variable in it that this shell left as it is: %TEMP% is cmd's, $env:TEMP PowerShell's. Built
  // there, it would be a folder of that name in the checkout.)
  for (const f of ['--src', '--out', '--data']) {
    const v = opt(f);
    if (v != null && /%[^%\s\\/]+%|\$env:|^\$/i.test(v)) stop(`${f} ${v}: that's a variable your shell didn't fill in (%TEMP% works in cmd, $env:TEMP in PowerShell). Give a whole path, or --try for a try-out folder.`);
  }
  const LIVE = path.join(ROOT, 'custom'), GAME = path.join(ROOT, 'src');
  const src = path.resolve(opt('--src') || LIVE);
  const tryOut = args.includes('--try');
  if (tryOut && opt('--out')) stop('--try is a folder of its own: give --try or --out <dir>, not both');
  const out = path.resolve(tryOut ? TRY_DIR : opt('--out') || GAME);
  // Only custom/ is built into the game: a build of any other folder there would replace every custom item players have
  // with only that folder's. (--check writes nothing, so any folder can be checked.)
  const intoGame = out === GAME && src === LIVE;
  if (out === GAME && src !== LIVE && !args.includes('--check')) stop(`only custom/ is built into the game (src/). To try ${path.relative(ROOT, src) || src}: --try (or --out <dir>). To ship what's in it, move it into custom/ first.`);
  const history = path.join(src, 'ids.json');
  const r = buildCustom({ src, data: opt('--data') ? path.resolve(opt('--data')) : undefined, history, draft: args.includes('--draft'), allowRemoved: args.includes('--allow-removed'), trial: !intoGame });
  // The version of the game this content ships in, for the server (server/index.mjs customGate): it runs content with a new
  // lock only once that version's release is published, so pushing it before then locks no game out. Content whose lock
  // is the earlier build's (new prices, new textures) keeps that build's version: it changes nothing a game has to match.
  if (r.ok && r.custom) {
    const prev = intoGame ? (() => { try { return JSON.parse(fs.readFileSync(path.join(GAME, 'data', 'custom.json'), 'utf8')); } catch { return null; } })() : null;
    const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    r.custom.app = prev?.app && customLock(prev) === r.lock ? prev.app : version;
    if (intoGame && r.custom.app === version) {
      const isOut = released(version);
      const m = `package.json: version ${version} is out already (git tag v${version}), and this changes what the game's custom items are (its data lock). Set "version" to the release this ships in first (CUSTOM_CONTENT.md, section 8): the server keeps it back until that version is published, so no game is locked out before.`;
      if (isOut) (args.includes('--check') ? r.warnings : r.errors).push(m + (args.includes('--check') ? ' The build refuses it until then' : ''));
      else if (isOut == null) r.warnings.push(`package.json: git couldn't say whether version ${version} is out already. It must be the version this ships in, not one that's out (CUSTOM_CONTENT.md, section 8)`);
      r.ok = !r.errors.length;
    }
  }
  for (const w of r.warnings) console.log('warning  ' + w);
  for (const e of r.errors) console.log('ERROR    ' + e);
  if (!r.ok) { console.log(`\n${r.errors.length} error${r.errors.length === 1 ? '' : 's'}: nothing was written.`); process.exit(1); }
  const n = r.custom ? Object.keys(r.custom.skins).length : 0, c = r.custom ? r.custom.cases.length : 0;
  const bytes = [...r.files.values()].reduce((s, b) => s + b.length, 0);
  const lock = dataLock(r.generatedAt, r.custom);
  if (args.includes('--check')) { console.log(`OK: ${n} skins, ${c} cases (${(bytes / 1048576).toFixed(1)} MB of pictures and textures). Its data lock would be ${lock}. --check: nothing written.`); process.exit(0); }
  // (ids.json is kept by builds into the game itself; a try-out built elsewhere leaves it alone.)
  writeBuild(r, { out, history: fs.existsSync(src) && intoGame ? history : null });
  const where = path.relative(ROOT, out) || out;
  if (!r.custom) console.log(`No custom content in ${path.relative(ROOT, src) || src}: ${where} has none (the data lock is the game data's own: ${lock}).`);
  else console.log(`Built ${n} skins and ${c} cases into ${where} (${(bytes / 1048576).toFixed(1)} MB), for version ${r.custom.app}. Data lock: ${lock}`);
  if (r.custom && !intoGame) {
    // (Quoted whole paths: the same commands work in cmd and PowerShell.)
    console.log(`\nTry it (a development copy only, with a save of its own):\n  npm start -- --custom "${out}"\n  npm run dev -- --custom "${out}"          (the browser preview)\n  node server/index.mjs --custom "${out}"   (a local server with it. To play on it: F12 in the game, and in the Console\n      (await import('/js/net/online.js')).net.setServerUrl('http://localhost:8787'))`);
  }
}
