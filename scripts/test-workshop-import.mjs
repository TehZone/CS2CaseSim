// The Workshop importer's checks (scripts/import-workshop.mjs, CUSTOM_CONTENT.md section 10). A creator's files in each form
// a Workshop weapon finish comes in are made up here, with procedural textures and made-up Workshop ids, never a real
// item's: a CS2 addon with its .econitem (as a folder and as a zip), a finish's .vcompmat, a CS:GO-era upload, and a
// subscribed item's folder (a map, as Steam downloads them). Then: what they map onto, that the build takes the result,
// what's refused, and that nothing reaches the live game (custom/ and the data lock stay as they are).
// With CS2 and tools/s2v installed it also imports Valve's own compiled example finish from your CS2 (into a temp folder).
//   node scripts/test-workshop-import.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const W = await import('./custom/workshop.mjs');
const { readImage } = await import('./custom/images.mjs');
const { readZip, listVpk } = await import('./custom/archives.mjs');
const { buildCustom } = await import('./build-custom.mjs');
const CX = await import('../src/js/engine/custom.js');
const { D, initData } = await import('../src/js/engine/data.js');

let failed = 0, passed = 0;
function check(name, ok, info = '') {
  if (ok) passed++; else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`);
}
const game = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'data', 'game-data.json'), 'utf8'));
const keys = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'data', 'keys.json'), 'utf8'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cs2sim-wsimport-'));
const LIVE = path.join(ROOT, 'custom');
const liveBefore = fs.existsSync(LIVE) ? fs.readdirSync(LIVE, { recursive: true }).sort().join('|') : null;

// ---- making a creator's files -------------------------------------------------------------------------------------------
function picture(w, h, fn) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b, a = 255] = fn(x / w, y / h, x, y); data.set([r, g, b, a].map((v) => Math.max(0, Math.min(255, Math.round(v)))), (y * w + x) * 4); }
  return { w, h, data };
}
// A TGA as CS2's Workshop tools and CS:GO's took them: bottom-up, 24 or 32-bit (or 8-bit grey), plain or run-length encoded.
function tga(img, { bpp = 32, rle = false, grey = false } = {}) {
  const n = grey ? 1 : bpp / 8, head = Buffer.alloc(18);
  head[2] = grey ? (rle ? 11 : 3) : rle ? 10 : 2;
  head.writeUInt16LE(img.w, 12); head.writeUInt16LE(img.h, 14); head[16] = n * 8; head[17] = n === 4 ? 8 : 0;
  const px = [];
  for (let y = img.h - 1; y >= 0; y--) for (let x = 0; x < img.w; x++) {
    const o = (y * img.w + x) * 4, d = img.data;
    px.push(grey ? [d[o]] : n === 4 ? [d[o + 2], d[o + 1], d[o], d[o + 3]] : [d[o + 2], d[o + 1], d[o]]);
  }
  if (!rle) return Buffer.concat([head, Buffer.from(px.flat())]);
  const out = [];
  for (let i = 0; i < px.length;) {
    let j = i + 1;
    while (j < px.length && j - i < 128 && px[j].join() === px[i].join()) j++;
    if (j - i > 1) { out.push(0x80 | (j - i - 1), ...px[i]); i = j; continue; }
    while (j < px.length && j - i < 128 && !(j + 1 < px.length && px[j].join() === px[j + 1].join())) j++;
    out.push(j - i - 1); for (let k = i; k < j; k++) out.push(...px[k]); i = j;
  }
  return Buffer.concat([head, Buffer.from(out)]);
}
// A zip (Deflate or Store), as Windows and 7-Zip make them.
function zip(entries, { store = false } = {}) {
  const parts = [], central = [];
  let off = 0;
  for (const [name, data] of entries) {
    const nb = Buffer.from(name), body = store ? data : zlib.deflateRawSync(data), crc = zlib.crc32(data) >>> 0, method = store ? 0 : 8;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    parts.push(lh, nb, body); central.push(ch, nb);
    off += 30 + nb.length + body.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}
const zipFolder = (dir) => zip(fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).isFile()).map((f) => [path.relative(dir, f).replace(/\\/g, '/'), fs.readFileSync(f)]));
// A VPK directory file (version 2) listing these files, as a downloaded Workshop map's <id>_dir.vpk.
function vpk(files) {
  const tree = [];
  const z = (s) => Buffer.from(s + '\0');
  const byExt = {};
  for (const f of files) { const ext = f.split('.').pop(), dir = path.posix.dirname(f), name = path.posix.basename(f, '.' + ext); ((byExt[ext] ||= {})[dir] ||= []).push(name); }
  for (const [ext, dirs] of Object.entries(byExt)) {
    tree.push(z(ext));
    for (const [dir, names] of Object.entries(dirs)) {
      tree.push(z(dir));
      for (const n of names) { const e = Buffer.alloc(18); e.writeUInt16LE(0, 4); e.writeUInt16LE(0, 6); e.writeUInt32LE(0, 8); e.writeUInt32LE(1234, 12); e.writeUInt16LE(0xffff, 16); tree.push(z(n), e); }
      tree.push(z(''));
    }
    tree.push(z(''));
  }
  tree.push(z(''));
  const t = Buffer.concat(tree), head = Buffer.alloc(28);
  head.writeUInt32LE(0x55aa1234, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(t.length, 8);
  return Buffer.concat([head, t]);
}
const put = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file; };
const KV3 = '<!-- kv3 encoding:text:version{e21c7f3c-8a33-41c5-9977-a76d3a32aa0d} format:generic:version{7412167c-06e9-4698-aff2-e63eb59037e7} -->\n';
// An .econitem as CS2's item editor (and the Substance Painter plugin that writes the same) saves one.
function econitem({ cls, weapon, keys: k, all = null, name }) {
  const lines = (o) => Object.entries(o).map(([a, b]) => `\t\t\t${a} = ${typeof b === 'string' ? JSON.stringify(b) : JSON.stringify(b).replace(/,/g, ', ')}`).join('\n');
  return `${KV3}{\n\tcs2_item_type = "CCS2EconNode_PaintKit"\n\tCCS2EconNode_PaintKit = \n\t{\n\t\tdescription_string = "#CSGO_Workshop_EmptyString"\n\t\tdescription_tag = "#CSGO_Workshop"\n\t\trarity = "common"\n\t\tcomposite_material_class = "PaintKit_${cls}"\n\t\tcomposite_material_keys = \n\t\t{\n${lines(k)}\n\t\t}\n${all ? `\t\tall_composite_material_keys = \n\t\t{\n${lines(all)}\n\t\t}\n` : ''}\t\tpreview_weapon = "${weapon}"\n\t\tassociate_assets = \n\t\t[\n\t\t\tresource_name:"weapons/paints/workshop/${name}.vcompmat",\n\t\t]\n\t}\n}\n`;
}
// Steam's GetPublishedFileDetails answer, as the real one is shaped (made-up ids, never contacted here).
const CREATOR = '76561190000000042';
const item = (id, title, tags, extra = {}) => ({ publishedfileid: id, result: 1, creator: CREATOR, creator_app_id: 730, consumer_app_id: 730, filename: '', file_size: '16781234',
  preview_url: '', hcontent_preview: '0', title, description: '', time_created: 1790000000, time_updated: 1793000000, visibility: 0, banned: 0, ban_reason: '',
  subscriptions: 0, favorited: 3, lifetime_subscriptions: 0, lifetime_favorited: 3, views: 120, tags: tags.map((tag) => ({ tag })), ...extra });
const DETAILS = put(path.join(TMP, 'details.json'), JSON.stringify({ response: { result: 1, resultcount: 9, publishedfiledetails: [
  item('9900000001', 'AK-47 | Test Nebula', ['Cs2', 'Weapon Finish', 'Custom Paint Job', 'AK-47']),
  item('9900000002', 'M4A1-S | Test Tide (v2)', ['Cs2', 'Weapon Finish', 'Hydrographic Extended', 'M4A1-S']),
  item('9900000003', 'Karambit | Test Aurora', ['Cs2', 'Weapon Finish', 'Anodized Multicolored', 'AK-47']),
  item('9900000004', 'Test Ember', ['Custom Paint Job', 'AK-47', 'Weapon Finish'], { filename: 'myweaponfinishes/test_ember.zip', file_size: '182211' }),
  item('9900000005', 'aim_testmap', ['Cs2', 'Map', 'Custom'], { hcontent_file: '1234567890123', file_url: '' }),
  item('9900000006', 'Sport Gloves | Test Grip', ['Cs2', 'Weapon Finish', 'Custom Paint Job', 'AK-47']),
  item('9900000007', 'Karambit | Test Wrong', ['Cs2', 'Weapon Finish', 'Custom Paint Job', 'AK-47']),
  item('9900000008', 'Sticker | Test', ['Cs2', 'Sticker']),
  item('9900000009', 'AK-47 | Test Dots', ['Cs2', 'Weapon Finish', 'Spray-Paint', 'AK-47']),
] } }));
const PERMISSION = put(path.join(TMP, 'from-the-creator.txt'), 'Test creator, 2026-11-11: yes, you may ship my finish in the game, credited to me.\n');
const ICON = put(path.join(TMP, 'icon-in.png'), (await import('./custom/images.mjs')).encode(picture(256, 192, (u, v) => [200 * u, 80, 200 * v, (u - 0.5) ** 2 + (v - 0.5) ** 2 < 0.16 ? 255 : 0])));
const base = { game, details: DETAILS, creatorName: 'Test Creator', permission: PERMISSION, icon: ICON };
const run = (o) => W.importFinish({ ...base, ...o });
const outDir = (n) => path.join(TMP, 'out-' + n);
const json = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const has = (r, re) => [...(r.errors || []), ...(r.notes || [])].some((x) => re.test(x));

// The creator of "AK-47 | Test Nebula": a CS2 addon as CS2's Workshop tools lay it out (content/csgo_addons/<addon>/), its
// .econitem naming its textures by absolute paths on the creator's own PC.
const addon = path.join(TMP, 'creator1', 'content', 'csgo_addons', 'workshop_items');
const theirPC = 'C:/Program Files (x86)/Steam/steamapps/common/Counter-Strike Global Offensive/content/csgo_addons/workshop_items/weapons/paints/workshop/test_nebula';
const nebula = picture(64, 64, (u, v, x, y) => [40 + 180 * u, 30 + 60 * Math.sin(v * 9), 120 + 100 * v, x < 8 ? 64 : x > 56 ? 200 : 255]);
put(path.join(addon, 'weapons/paints/workshop/test_nebula/test_nebula_color.tga'), tga(nebula, { bpp: 32 }));
put(path.join(addon, 'weapons/paints/workshop/test_nebula/test_nebula_normal.tga'), tga(picture(4096, 16, () => [128, 128, 255]), { bpp: 24 }));
put(path.join(addon, 'weapons/paints/workshop/test_nebula/test_nebula_rough.tga'), tga(picture(64, 64, (u) => [255 * u, 255 * u, 255 * u]), { grey: true }));
put(path.join(addon, 'weapons/paints/workshop/test_nebula/test_nebula_pearl.tga'), tga(picture(64, 64, () => [255, 255, 255]), { bpp: 24 }));
put(path.join(addon, 'readme.txt'), 'My finish! Made in Substance Painter.\nCredits: me.\n');
const nebulaKeys = {
  'econ_instance.g_flPatternTexCoordRotation': [0.0, 0.0, 0.0], 'econ_instance.g_flWearAmount': [0.0, 0.05, 0.7],
  'econ_instance.g_vPatternTexCoordOffset.0': [0.0, 0.0, 0.0], 'econ_instance.g_vPatternTexCoordOffset.1': [0.0, 0.0, 0.0],
  'exposed_params.g_bIgnoreWeaponSizeScale': false, 'exposed_params.g_bOverrideAmbientOcclusion': false, 'exposed_params.g_bOverrideDefaultMasks': false,
  'exposed_params.g_bUseNormalMap': true, 'exposed_params.g_bUsePearlescenceMask': false, 'exposed_params.g_bUseRoughness': true,
  'exposed_params.g_flPatternTexCoordScale': 1.0, 'exposed_params.g_flPearlescentScale': 0.0,
  'exposed_params.g_tPaintRoughness': `${theirPC}/test_nebula_rough.tga`, 'exposed_params.g_tPattern': `${theirPC}/test_nebula_color.tga`,
  'exposed_params.g_vColor0': [255, 255, 255], 'exposed_params.g_vColor1': [255, 255, 255], 'exposed_params.g_vColor2': [255, 255, 255], 'exposed_params.g_vColor3': [255, 255, 255],
};
const nebulaAll = { ...nebulaKeys, 'exposed_params.g_bUseRoughnessByColor': false, 'exposed_params.g_flPaintRoughness': 0.45,
  'exposed_params.g_tFinalAmbientOcclusion': `${theirPC}/test_nebula_ao.tga`, 'exposed_params.g_tNormal': `${theirPC}/test_nebula_normal.tga`,
  'exposed_params.g_tPaintByNumberMasks': `${theirPC}/test_nebula_masks.tga`, 'exposed_params.g_tPearlescenceMask': `${theirPC}/test_nebula_pearl.tga`,
  'exposed_params.g_vPaintMetalness.0': 0.0, 'exposed_params.g_vPaintMetalness.1': 0.0, 'exposed_params.g_vPaintRoughness.0': 0.6 };
put(path.join(addon, 'items/assets/paintkits/workshop/test_nebula.econitem'), econitem({ cls: 'CustomPaintJob', weapon: 'weapon_ak47', keys: nebulaKeys, all: nebulaAll, name: 'test_nebula' }));
const addonZip = put(path.join(TMP, 'test_nebula_addon.zip'), zipFolder(addon));
const nebulaOpts = { workshop: '9900000001', rarity: 'Classified', prices: { FN: 42.5, MW: 24, FT: 15.75, WW: 13.2, BS: 11.4 } };

try {
  // ---- the pieces ---------------------------------------------------------------------------------------------------------
  check('workshopId: a bare id, or a Workshop link', W.workshopId('3837590379') === '3837590379' && W.workshopId('https://steamcommunity.com/sharedfiles/filedetails/?id=3837590379&searchtext=') === '3837590379' && W.workshopId('steamcommunity.com/workshop/filedetails/?id=12') === '12' && W.workshopId('ak47') === null);
  check('parseTitle: "<weapon> | <finish>", a trailing "| CS2" dropped, variants and versions unclear',
    W.parseTitle('AK-47 | Fairy Hunter').finish === 'Fairy Hunter' && W.parseTitle('AUG | Counterfeit | CS2').finish === 'Counterfeit' && W.parseTitle('Firebrand').finish === 'Firebrand'
    && W.parseTitle('SG | APERTURE (Dynamic Wear) (Blue)').unclear && W.parseTitle('AUG | Vandal V2').unclear && W.parseTitle('a | b | c').unclear);
  check('readDetails: a finish has no file to download; a map has one', (() => {
    const j = json(DETAILS).response.publishedfiledetails;
    const f = W.readDetails(j[0]), m = W.readDetails(j[4]);
    return f.kind === 'finish' && !f.hasFile && f.creator === CREATOR && f.updated === '2026-10-26' && m.kind === 'map' && m.hasFile && W.readDetails({ result: 9 }) === null;
  })());
  const table = W.weaponTable(game);
  check('weapons: CS2\'s names and ids, and the Workshop\'s "Sawed-Off Shotgun" tag', table.find('AK-47')?.wid === 'weapon_ak47' && table.find('weapon_knife_karambit')?.w === 'Karambit'
    && table.find('Sawed-Off Shotgun')?.wid === 'weapon_sawedoff' && table.find('AK47')?.wid === 'weapon_ak47' && table.find('Sport Gloves')?.cat === 'gloves' && table.find('SG') === null);
  check('the zip reader reads Deflate and Store, and refuses a file outside its folder', (() => {
    const z = put(path.join(TMP, 'z1.zip'), zip([['a/b.txt', Buffer.from('hello')], ['c.bin', Buffer.alloc(1000, 7)]], { store: false }));
    const s = put(path.join(TMP, 'z2.zip'), zip([['x.txt', Buffer.from('stored')]], { store: true }));
    const e = readZip(z);
    return e.length === 2 && e[0].read().toString() === 'hello' && e[1].read().equals(Buffer.alloc(1000, 7)) && readZip(s)[0].read().toString() === 'stored';
  })());
  check('the VPK lister reads a Workshop map\'s directory file', (() => {
    const f = put(path.join(TMP, 'v_dir.vpk'), vpk(['maps/aim_testmap.vpk', 'materials/x/y.vmat_c']));
    const l = listVpk(f).map((x) => x.path).sort();
    return l.join() === 'maps/aim_testmap.vpk,materials/x/y.vmat_c';
  })());
  check('8-bit greyscale TGAs read (masks are often saved so)', (() => { const g = readImage(put(path.join(TMP, 'g.tga'), tga(picture(4, 2, (u) => [255 * u, 0, 0]), { grey: true }))); return g.w === 4 && g.data[0] === 0 && g.data[4] === 64 && g.data[5] === 64 && g.data[7] === 255; })());
  check('RLE TGAs read the same as plain ones', (() => { const a = readImage(put(path.join(TMP, 'p.tga'), tga(nebula))), b = readImage(put(path.join(TMP, 'r.tga'), tga(nebula, { rle: true }))); return Buffer.from(a.data).equals(Buffer.from(b.data)) && Buffer.from(a.data).equals(Buffer.from(nebula.data)); })());

  // ---- a CS2 addon with its .econitem ---------------------------------------------------------------------------------------
  const r1 = await run({ ...nebulaOpts, files: addon, out: outDir(1) });
  for (const e of r1.errors) console.log('  import error: ' + e);
  check('a CS2 addon imports', r1.ok && r1.format === 'cs2-econitem' && r1.template === 'custom_paint_job');
  const s1 = r1.ok ? json(path.join(r1.folder, 'skin.json')) : {};
  check('it goes into the staging pack folder given, named after the item', r1.ok && r1.folder === path.join(outDir(1), 'skins', 'AK-47 - Test Nebula'));
  check('its name from the Workshop title, its weapon from preview_weapon', s1.name === 'AK-47 | Test Nebula');
  check('its float range is the creator\'s wear range ([min, value, max] of g_flWearAmount), the wear it was shown at its icon\'s', JSON.stringify(s1.float) === '[0,0.7]' && s1.iconFloat === 0.05);
  check('the style and its settings: Custom Paint Job on CS2\'s model, fixed placement, its roughness', s1.finish?.style === 'Custom Paint Job' && s1.finish.model === 'hd'
    && JSON.stringify(s1.finish.rotation) === '[0,0]' && JSON.stringify(s1.finish.offset) === '[[0,0],[0,0]]' && s1.finish.scale === 1 && s1.finish.roughness === 0.45 && s1.finish.ignoreWeaponSize === false && s1.finish.pearlescence === 0);
  check('a Custom Paint Job\'s colours are left out (its picture is its colour), and settings its template lacks', !s1.finish?.colors && !s1.finish?.params && has(r1, /colours are left out/) && has(r1, /g_vPaintMetalness/));
  check('textures: each one its switch turns on, as PNG', ['color', 'normal', 'roughness'].every((t) => fs.existsSync(path.join(r1.folder || '', t + '.png'))) && !fs.existsSync(path.join(r1.folder || '', 'pearlescence.png')) && has(r1, /pearlescence: the creator's file has it turned off/));
  check('the creator\'s absolute paths on their own PC are found in their addon', r1.ok && readImage(path.join(r1.folder, 'color.png')).w === 64);
  const c1 = r1.ok ? readImage(path.join(r1.folder, 'color.png')) : null;
  check('the picture keeps its alpha (the wear mask) exactly', c1 && Buffer.from(c1.data).equals(Buffer.from(nebula.data)));
  check('a 4096 texture is kept to 2048 (as the game ships it)', r1.ok && readImage(path.join(r1.folder, 'normal.png')).w === 2048);
  check('an 8-bit grey roughness TGA becomes a grey PNG', r1.ok && (() => { const g = readImage(path.join(r1.folder, 'roughness.png')); return g.data[4 * 32] === g.data[4 * 32 + 1] && g.data[4 * 32] > 100; })());
  check('the Workshop details are kept: id, link, title, creator and their name, tags, format, permission', s1.workshop?.id === '9900000001' && s1.workshop.url === 'https://steamcommunity.com/sharedfiles/filedetails/?id=9900000001'
    && s1.workshop.title === 'AK-47 | Test Nebula' && s1.workshop.creator === CREATOR && s1.workshop.creatorName === 'Test Creator' && s1.workshop.format === 'cs2-econitem'
    && s1.workshop.tags.includes('Custom Paint Job') && s1.workshop.updated === '2026-10-26' && s1.workshop.permission === 'permission.txt' && fs.readFileSync(path.join(r1.folder, 'permission.txt'), 'utf8').includes('yes, you may ship'));
  check('rarity and prices are the developer\'s', s1.rarity === 'Classified' && s1.prices?.FN === 42.5);
  check('notes on the import are kept beside it', r1.ok && /Workshop: https:\/\/steamcommunity\.com\/sharedfiles\/filedetails\/\?id=9900000001/.test(fs.readFileSync(path.join(r1.folder, 'import-notes.txt'), 'utf8')));
  check('a readme.txt in the addon isn\'t taken for a CS:GO workbench file', r1.ok);

  // The same addon zipped gives the same skin.
  const r1z = await run({ ...nebulaOpts, files: addonZip, out: outDir('1z') });
  check('the same addon as a zip gives the same skin.json and textures, byte for byte', r1z.ok && fs.readFileSync(path.join(r1z.folder, 'skin.json'), 'utf8') === fs.readFileSync(path.join(r1.folder, 'skin.json'), 'utf8')
    && ['color', 'normal', 'roughness', 'icon'].every((t) => fs.readFileSync(path.join(r1z.folder, t + '.png')).equals(fs.readFileSync(path.join(r1.folder, t + '.png')))), r1z.errors.join('; '));

  // ---- the build takes it, and the game credits the creator ---------------------------------------------------------------
  const b1 = buildCustom({ src: outDir(1), data: game });
  for (const e of b1.errors) console.log('  build error: ' + e);
  const rec = b1.ok ? Object.values(b1.custom.skins)[0] : null;
  check('the game\'s own build takes the imported skin (with the creator\'s permission on file)', b1.ok && rec?.n === 'AK-47 | Test Nebula' && rec.id === r1.id);
  check('the item carries its creator and Workshop id, for the game to show', JSON.stringify(rec?.ws) === JSON.stringify({ id: '9900000001', by: 'Test Creator', sid: CREATOR }));
  const kit = b1.ok ? b1.custom.kits[rec.fid] : null;
  check('its 3D: CS2\'s custom_paint_job template, with its picture, normal map and roughness turned on', kit?.template === 'custom_paint_job' && kit.vars['exposed_params.g_tPattern']?.texture === `custom/${rec.id}/color.png`
    && kit.vars['exposed_params.g_bUseNormalMap']?.bool === true && kit.vars['exposed_params.g_bUseRoughness']?.bool === true && !kit.vars['exposed_params.g_bUsePearlescenceMask'] && kit.vars['exposed_params.g_flPaintRoughness']?.value === 0.45 && kit.legacy === false);
  check('crediting the creator isn\'t part of the data lock', (() => {
    const c2 = JSON.parse(JSON.stringify(b1.custom));
    Object.values(c2.skins)[0].ws = { id: '1', by: 'Someone else' };
    return b1.ok && CX.customLock(c2) === b1.lock;
  })());
  initData(JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'data', 'game-data.json'), 'utf8')), { keys, custom: b1.custom });
  check('merged into the game data, the item has its credit', D.skins[r1.id]?.ws?.by === 'Test Creator' && D.skins[r1.id].cx === 1 && D.lock !== game.generatedAt);
  initData(JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'data', 'game-data.json'), 'utf8')), { keys });
  check('without it the lock is the game data\'s own again', D.lock === game.generatedAt);

  // Without permission: staging and try-outs only.
  const r1n = await run({ ...nebulaOpts, files: addon, out: outDir('1n'), permission: null });
  check('without permission it still imports into staging, and says so', r1n.ok && !r1n.permission && !json(path.join(r1n.folder, 'skin.json')).workshop.permission && /NO PERMISSION ON FILE/.test(fs.readFileSync(path.join(r1n.folder, 'import-notes.txt'), 'utf8')));
  const b1n = buildCustom({ src: outDir('1n'), data: game }), t1n = buildCustom({ src: outDir('1n'), data: game, trial: true });
  check('the game\'s build refuses a Workshop skin with no permission on file; a try-out only warns', !b1n.ok && b1n.errors.some((e) => /permission/.test(e)) && t1n.ok && t1n.warnings.some((w) => /permission/.test(w)));
  const lv = await run({ ...nebulaOpts, files: addon, live: true, permission: null });
  check('into custom/ itself only with permission (and nothing is written)', !lv.ok && lv.errors.some((e) => /permission/.test(e)));
  const lv2 = await run({ ...nebulaOpts, files: addon, out: LIVE });
  check('custom/ isn\'t a staging folder: --live says so', !lv2.ok && lv2.errors.some((e) => /live pack folder/.test(e)));
  const bw = buildCustom({ src: outDir(1), data: game });
  check('a bad "workshop" block is refused by the build', (() => {
    const dir = path.join(TMP, 'badws'); fs.cpSync(outDir(1), dir, { recursive: true });
    const f = path.join(dir, 'skins', 'AK-47 - Test Nebula', 'skin.json'), j = json(f);
    j.workshop.id = 'abc'; j.workshop.colour = 1; fs.writeFileSync(f, JSON.stringify(j));
    const r = buildCustom({ src: dir, data: game });
    return bw.ok && !r.ok && r.errors.some((e) => /"workshop"."id"/.test(e)) && r.errors.some((e) => /unknown "workshop" field "colour"/.test(e));
  })());

  // Again, into the same folder.
  const again = await run({ ...nebulaOpts, files: addon, out: outDir(1) });
  const forced = await run({ ...nebulaOpts, files: addon, out: outDir(1), force: true });
  check('a folder of that name is replaced only with --force', !again.ok && again.errors.some((e) => /--force/.test(e)) && forced.ok);

  // ---- an _extended finish ----------------------------------------------------------------------------------------------------
  const addon2 = path.join(TMP, 'creator2', 'workshop_items');
  put(path.join(addon2, 'weapons/paints/workshop/m4a1s_test_tide/m4a1s_test_tide_color.tga'), tga(picture(64, 64, (u, v) => [u > 0.5 ? 255 : 0, v > 0.5 ? 255 : 0, (u + v) % 0.5 > 0.25 ? 255 : 0]), { rle: true }));
  put(path.join(addon2, 'weapons/paints/workshop/m4a1s_test_tide/m4a1s_test_tide_overlay.tga'), tga(picture(16, 16, () => [255, 0, 0, 128])));
  const tideKeys = {
    'econ_instance.g_flPatternTexCoordRotation': [-10.0, 0.0, 10.0], 'econ_instance.g_flWearAmount': [0.0, 0.1, 0.8],
    'econ_instance.g_vPatternTexCoordOffset.0': [0.0, 0.0, 1.0], 'econ_instance.g_vPatternTexCoordOffset.1': [0.0, 0.0, 1.0],
    'exposed_params.g_tPattern': 'weapons/paints/workshop/m4a1s_test_tide/m4a1s_test_tide_color.tga', 'exposed_params.g_flPatternTexCoordScale': 1.5,
    'exposed_params.g_vColor0': [21, 24, 31], 'exposed_params.g_vColor1': [255, 138, 31], 'exposed_params.g_vColor2': [61, 227, 160], 'exposed_params.g_vColor3': [44, 123, 255],
    'exposed_params.g_bUseRoughnessByColor': true, 'exposed_params.g_vPaintRoughness.0': 0.2, 'exposed_params.g_vPaintRoughness.1': 0.4, 'exposed_params.g_vPaintRoughness.2': 0.6, 'exposed_params.g_vPaintRoughness.3': 0.8,
    'exposed_params.g_bUseOverlay': true, 'exposed_params.g_tOverlay': 'weapons/paints/workshop/m4a1s_test_tide/m4a1s_test_tide_overlay.tga', 'exposed_params.g_fGlitterIntensity': 0.0,
  };
  put(path.join(addon2, 'items/assets/paintkits/workshop/m4a1s_test_tide.econitem'), econitem({ cls: 'HydroGraphicExtended', weapon: 'weapon_m4a1_silencer', keys: tideKeys, name: 'm4a1s_test_tide' }));
  const tideOpts = { files: addon2, workshop: '9900000002', rarity: 'Restricted', prices: [9.8, 5.1, 3.4, 3, 2.6], out: outDir(2) };
  const r2 = await run(tideOpts);
  check('an _extended finish that uses an overlay is refused, saying what custom skins can\'t do yet', !r2.ok && r2.errors.some((e) => /an overlay texture/.test(e) && /--allow-loss/.test(e)));
  const r2b = await run({ ...tideOpts, allowLoss: true });
  for (const e of r2b.errors) console.log('  import error: ' + e);
  const s2 = r2b.ok ? json(path.join(r2b.folder, 'skin.json')) : {};
  check('with --allow-loss it\'s made on its base template, the overlay left out (and noted)', r2b.ok && r2b.template === 'hydrographic_extended' && s2.finish?.style === 'Hydrographic' && has(r2b, /left out \(--allow-loss\): an overlay texture/));
  check('a title with a version ("(v2)") isn\'t used: the name comes from the file, the weapon\'s own name dropped', s2.name === 'M4A1-S | Test Tide' && has(r2b, /named from the file/));
  check('pattern colours, scale, and the seed\'s rotation and offset ranges', JSON.stringify(s2.finish?.colors) === '["#15181f","#ff8a1f","#3de3a0","#2c7bff"]' && s2.finish.scale === 1.5
    && JSON.stringify(s2.finish.rotation) === '[-10,10]' && JSON.stringify(s2.finish.offset) === '[[0,0],[1,1]]' && JSON.stringify(s2.float) === '[0,0.8]');
  check('the template\'s other settings pass through as params (roughness by colour, a vector from its components)', s2.finish?.params?.['exposed_params.g_bUseRoughnessByColor'] === true && JSON.stringify(s2.finish.params['exposed_params.g_vPaintRoughness']) === '[0.2,0.4,0.6,0.8]');
  check('prices given in wear order', JSON.stringify(s2.prices) === '{"FN":9.8,"MW":5.1,"FT":3.4,"WW":3,"BS":2.6}');
  const b2 = buildCustom({ src: outDir(2), data: game });
  const k2 = b2.ok ? Object.values(b2.custom.kits)[0] : null;
  check('the build takes it: hydrographic, its colours and params in the kit', b2.ok && k2?.template === 'hydrographic' && JSON.stringify(k2.vars['exposed_params.g_vColor1']?.color) === '[255,138,31]'
    && JSON.stringify(k2.vars['exposed_params.g_vPaintRoughness']?.value) === '[0.2,0.4,0.6,0.8]' && JSON.stringify(k2.vars['econ_instance.g_flPatternTexCoordRotation']) === '{"value":-10,"min":-10,"max":10}', b2.errors.join('; '));

  // ---- a finish's .vcompmat, for a knife ----------------------------------------------------------------------------------------
  const addon3 = path.join(TMP, 'creator3');
  const loose = (alias, vars) => `{\n m_nCompositeMaterialInputContainerSourceType = "CONTAINER_SOURCE_TYPE_LOOSE_VARIABLES"\n m_strAlias = "${alias}"\n m_vecLooseVariables = [\n${vars.join(',\n')}\n ]\n}`;
  const fv = (name, xs, mins, maxs) => `{ m_strName = "${name}" m_bExposeExternally = true m_nVariableType = "LOOSE_VARIABLE_TYPE_FLOAT${xs.length}" m_bHasFloatBounds = true ${xs.map((x, i) => `m_flValueFloat${'XYZW'[i]} = ${x} m_flValueFloat${'XYZW'[i]}_Min = ${mins[i]} m_flValueFloat${'XYZW'[i]}_Max = ${maxs[i]}`).join(' ')} }`;
  const bv = (name, b) => `{ m_strName = "${name}" m_bExposeExternally = true m_nVariableType = "LOOSE_VARIABLE_TYPE_BOOLEAN" m_bValueBoolean = ${b} }`;
  const cv = (name, c) => `{ m_strName = "${name}" m_bExposeExternally = true m_nVariableType = "LOOSE_VARIABLE_TYPE_COLOR4" m_cValueColor4 = [ ${c.join(', ')} ] }`;
  const tv = (name, asset) => `{ m_strName = "${name}" m_bExposeExternally = true m_nVariableType = "LOOSE_VARIABLE_TYPE_RESOURCE_TEXTURE" m_strTextureContentAssetPath = "${asset}" m_strTextureRuntimeResourcePath = resource_name:"${asset.replace(/\.tga$/, '_tga_0123abcd.vtex')}" m_nTextureType = "INPUT_TEXTURE_TYPE_COLOR" }`;
  const vcomp = `${KV3}{\n_class = "CCompositeMaterialEditorDoc"\nm_nVersion = 1\nm_Points = [ { m_vecCompositeMaterialAssemblyProcedures = [ { m_vecMatchFilters = [ ] m_vecCompositeInputContainers = [\n`
    + `{ m_nCompositeMaterialInputContainerSourceType = "CONTAINER_SOURCE_TYPE_TARGET_MATERIAL" m_strAlias = "target" },\n`
    + loose('econ_instance', ['{ m_strName = "g_nRandomSeed" m_nVariableType = "LOOSE_VARIABLE_TYPE_INTEGER1" m_nValueIntX = 0 }', fv('g_flWearAmount', [0], [0], [0.08]), fv('g_flPatternTexCoordRotation', [-60], [-70], [-50]), fv('g_vPatternTexCoordOffset', [0, 0], [0, 0], [0.4, 0.3])]) + ',\n'
    + '{ m_nCompositeMaterialInputContainerSourceType = "CONTAINER_SOURCE_TYPE_SPECIFIC_MATERIAL" m_strSpecificContainerMaterial = resource_name:"workshop/paintkits/templates/an_multi_template.vmat" m_strAlias = "paint" },\n'
    + loose('exposed_params', [cv('g_vColor0', [12, 20, 48]), cv('g_vColor1', [33, 230, 161]), cv('g_vColor2', [123, 77, 255]), cv('g_vColor3', [255, 79, 163]),
      tv('g_tPattern', 'items/assets/paintkits/workshop/test_aurora_pattern.tga'), fv('g_flPatternTexCoordScale', [1.6], [-10], [10]), fv('g_flPearlescentScale', [0.2], [-10], [10]),
      bv('g_bUseNormalMap', false), tv('g_tNormal', 'workshop/paintkits/templates/custom_template_pattern_normal.tga'), bv('g_bUseRoughness', true), tv('g_tPaintRoughness', 'items/assets/paintkits/workshop/test_aurora_rough.tga'),
      bv('g_bOverrideAmbientOcclusion', true), tv('g_tFinalAmbientOcclusion', 'materials/default/default_ao.tga'), bv('g_bIgnoreWeaponSizeScale', true)])
    + '\n] } ] } ]\n}\n';
  put(path.join(addon3, 'weapons/paints/workshop/test_aurora.vcompmat'), vcomp);
  put(path.join(addon3, 'items/assets/paintkits/workshop/test_aurora_pattern.tga'), tga(picture(64, 64, (u, v) => [255 * u, 255 * v, 255 * (1 - u)])));
  put(path.join(addon3, 'items/assets/paintkits/workshop/test_aurora_rough.tga'), tga(picture(64, 64, () => [90, 90, 90]), { grey: true, rle: true }));
  const r3 = await run({ files: addon3, workshop: '9900000003', prices: { FN: 1450, MW: 1290 }, pricesStatTrak: { FN: 1690, MW: 1480 }, out: outDir(3) });
  for (const e of r3.errors) console.log('  import error: ' + e);
  const s3 = r3.ok ? json(path.join(r3.folder, 'skin.json')) : {};
  check('a creator\'s .vcompmat imports: its template from its paint material', r3.ok && r3.format === 'cs2-vcompmat' && r3.template === 'anodized_multicolor' && s3.finish?.style === 'Anodized Multicolored');
  check('a knife finish posted under an AK-47 tag is made for the knife its title names (★, Covert, no rarity asked)', s3.name === '★ Karambit | Test Aurora' && !s3.rarity && r3.folder?.endsWith('Karambit - Test Aurora') && has(r3, /posted under a gun's tag/));
  check('its loose variables: wear range, the seed\'s rotation and offset bounds, colours, scale, pearlescence', JSON.stringify(s3.float) === '[0,0.08]' && JSON.stringify(s3.finish?.rotation) === '[-70,-50]'
    && JSON.stringify(s3.finish.offset) === '[[0,0],[0.4,0.3]]' && JSON.stringify(s3.finish.colors) === '["#0c1430","#21e6a1","#7b4dff","#ff4fa3"]' && s3.finish.scale === 1.6 && s3.finish.pearlescence === 0.2 && s3.finish.ignoreWeaponSize === true);
  check('textures by their source (.tga) path; CS2\'s own default AO left to the template', fs.existsSync(path.join(r3.folder || '', 'color.png')) && fs.existsSync(path.join(r3.folder || '', 'roughness.png')) && !fs.existsSync(path.join(r3.folder || '', 'ao.png')) && has(r3, /ao: turned on, but it's CS2's own default/));
  const b3 = buildCustom({ src: outDir(3), data: game });
  const k3 = b3.ok ? Object.values(b3.custom.skins)[0] : null;
  check('the build makes it a ★ Covert knife with StatTrak™ prices', b3.ok && k3?.star && k3.r === 5 && k3.cat === 'knife' && k3.p.FN[1] === 1690, b3.errors.join('; '));

  // ---- a CS:GO-era upload ----------------------------------------------------------------------------------------------------
  const emberArt = picture(64, 64, (u, v, x) => [200, 80 + 100 * v, 30, x < 8 ? 200 : 255]);
  const emberTxt = '"test_ember"\n{\n\t"style"\t\t"7"\n\t"pattern"\t\t"test_ember"\n\t"normal"\t\t"test_ember_normal"\n\t"wear_remap_min"\t\t"0.000000"\n\t"wear_remap_max"\t\t"0.600000"\n'
    + '\t"pattern_scale"\t\t"1.000000"\n\t"pattern_offset_x_start"\t\t"0.000000"\n\t"pattern_offset_x_end"\t\t"0.000000"\n\t"pattern_offset_y_start"\t\t"0.000000"\n\t"pattern_offset_y_end"\t\t"0.000000"\n'
    + '\t"pattern_rotate_start"\t\t"0"\n\t"pattern_rotate_end"\t\t"0"\n\t"phongexponent"\t\t"32"\n\t"phongalbedoboost"\t\t"40"\n\t"preview"\n\t{\n\t\t"weapon"\t\t"weapon_ak47"\n\t}\n}\n';
  const emberZip = put(path.join(TMP, 'myweaponfinishes', 'test_ember.zip'), zip([['test_ember.txt', Buffer.from(emberTxt)], ['test_ember.tga', tga(emberArt)],
    ['test_ember_normal.tga', tga(picture(32, 32, (u) => [128, 255 * u, 255]), { bpp: 24 })], ['test_ember.vtf', Buffer.from('VTF\0 a compiled CS:GO texture')]]));
  const outer = put(path.join(TMP, 'sent-to-me.zip'), zip([['test_ember.zip', fs.readFileSync(emberZip)]], { store: true }));
  const r4 = await run({ files: outer, workshop: '9900000004', rarity: 'Restricted', prices: { FN: 8, FT: 3 }, out: outDir(4) });
  for (const e of r4.errors) console.log('  import error: ' + e);
  const s4 = r4.ok ? json(path.join(r4.folder, 'skin.json')) : {};
  check('a CS:GO-era upload (inside another zip) imports from its workbench .txt', r4.ok && r4.format === 'csgo-zip' && s4.finish?.style === 'Custom Paint Job');
  check('its name from a one-part title, its weapon from the workbench file', s4.name === 'AK-47 | Test Ember');
  check('painted on CS:GO\'s UV layout: the legacy model, its normal map\'s green flipped', s4.finish?.model === 'legacy' && s4.finish.flipNormalGreen === true && fs.existsSync(path.join(r4.folder || '', 'normal.png')));
  check('CS:GO\'s wear range, and what doesn\'t carry over is said', JSON.stringify(s4.float) === '[0,0.6]' && has(r4, /shine settings \(phongexponent, phongalbedoboost\)/) && JSON.stringify(s4.prices) === '{"FN":8,"FT":3}');
  check('alpha CS2 reads as "no paint" (153 to 230) is pointed out on a CS:GO picture', has(r4, /13% of its picture's alpha is 153 to 230/));
  check('the .vtf is ignored', r4.ok && !fs.readdirSync(r4.folder).some((f) => /vtf/i.test(f)));
  const b4 = buildCustom({ src: outDir(4), data: game });
  check('the build takes it, on the legacy model', b4.ok && Object.values(b4.custom.kits)[0]?.legacy === true, b4.errors.join('; '));
  // A workbench file this can't read.
  const odd = put(path.join(TMP, 'odd.zip'), zip([['odd.txt', Buffer.from('"workbench"\n{\n\t"foo"\t"1"\n\t"bar"\t"2"\n}\n')], ['odd.tga', tga(emberArt)], ['odd.vtf', Buffer.from('VTF')]]));
  const r5 = await run({ files: odd, workshop: '9900000004', rarity: 'Restricted', prices: { FN: 8 }, float: [0, 0.5], out: outDir(5) });
  check('a workbench .txt it can\'t read is refused, listing its keys and asking for the style', !r5.ok && r5.errors.some((e) => /can't read \(its keys: workbench, foo, bar\)/.test(e) && /--style/.test(e)));
  const r5b = await run({ files: odd, workshop: '9900000004', rarity: 'Restricted', prices: { FN: 8 }, float: [0, 0.5], style: 'Custom Paint Job', out: outDir(5) });
  check('with --style it takes the upload\'s one picture', r5b.ok && fs.existsSync(path.join(r5b.folder, 'color.png')) && json(path.join(r5b.folder, 'skin.json')).finish.style === 'Custom Paint Job', r5b.errors.join('; '));

  // ---- what's refused ------------------------------------------------------------------------------------------------------
  const nope = async (name, o, re) => { const r = await run({ out: outDir('x'), ...o }); check(name, !r.ok && r.errors.some((e) => re.test(e)), r.ok ? 'it imported' : r.errors.join(' / ')); };
  await nope('Workshop "gloves" are refused, pointing at how custom gloves are made', { files: addon, workshop: '9900000006', rarity: 'Covert', prices: { FN: 1 } }, /no Workshop gloves.*section 5/);
  await nope('a title naming another weapon than the creator\'s file asks for --weapon', { files: addon, workshop: '9900000007', prices: { FN: 1 } }, /title says Karambit, but the creator's file is for the AK-47/);
  await nope('a UV-painted finish can\'t move to another weapon', { ...nebulaOpts, files: addon, weapon: 'M4A4' }, /painted on the AK-47's UV layout/);
  await nope('a real CS2 item\'s name is refused', { ...nebulaOpts, files: addon, name: 'AK-47 | Redline' }, /"AK-47 \| Redline" is a real CS2 item/);
  await nope('what the Workshop doesn\'t carry must be given: rarity and prices', { files: addon, workshop: '9900000001' }, /--rarity[\s\S]*--prices FN=<\$>,MW=<\$>,FT=<\$>,WW=<\$>,BS=<\$>/);
  await nope('a saved answer without that item', { ...nebulaOpts, files: addon, workshop: '9900000099' }, /has no Workshop item 9900000099/);
  await nope('a map isn\'t a weapon finish', { files: addon, workshop: '9900000005' }, /is a map, not a weapon finish/);
  await nope('nor is a sticker', { files: addon, workshop: '9900000008' }, /isn't a weapon finish \(its tags: Cs2, Sticker\)/);
  await nope('no creator name, offline: asked for', { ...nebulaOpts, files: addon, workshop: '9900000001', details: null, offline: true, creatorName: null }, /--creator-name/);
  await nope('a switch on with no texture named', { ...nebulaOpts, files: (() => { const d = path.join(TMP, 'creator-sw'); fs.cpSync(addon, d, { recursive: true }); const f = path.join(d, 'items/assets/paintkits/workshop/test_nebula.econitem'); fs.writeFileSync(f, econitem({ cls: 'CustomPaintJob', weapon: 'weapon_ak47', keys: { ...nebulaKeys, 'exposed_params.g_bOverrideAmbientOcclusion': true }, name: 'test_nebula' })); return d; })() }, /g_bOverrideAmbientOcclusion is on, but the creator's file names no exposed_params.g_tFinalAmbientOcclusion/);
  await nope('a texture named but not sent', { ...nebulaOpts, files: (() => { const d = path.join(TMP, 'creator-miss'); fs.cpSync(addon, d, { recursive: true }); fs.rmSync(path.join(d, 'weapons/paints/workshop/test_nebula/test_nebula_rough.tga')); return d; })() }, /roughness: the creator's file names ".*test_nebula_rough\.tga", which isn't among their files/);
  await nope('CS2\'s Spray-Paint Halftone isn\'t offered yet', { files: (() => { const d = path.join(TMP, 'creator-ht'); put(path.join(d, 'x.econitem'), econitem({ cls: 'SprayPaintHalftone', weapon: 'weapon_ak47', keys: {}, name: 'x' })); return d; })(), workshop: '9900000009', rarity: 'Mil-Spec', prices: { FN: 1 } }, /Spray-Paint Halftone style, which custom skins don't offer yet/);
  await nope('a zip with a file outside its own folder isn\'t unpacked', { ...nebulaOpts, files: put(path.join(TMP, 'slip.zip'), zip([['../../evil.txt', Buffer.from('x')], ['ok.txt', Buffer.from('y')]])) }, /a file outside its own folder/);
  await nope('a folder with no finish in it', { ...nebulaOpts, files: path.join(TMP, 'myweaponfinishes', '..', 'out-1', 'skins') }, /no finish found/);
  check('nothing was written for the refused imports', !fs.existsSync(outDir('x')));
  check('its output never goes inside src/', !(await run({ ...nebulaOpts, files: addon, out: path.join(ROOT, 'src', 'custom-x') })).ok && !fs.existsSync(path.join(ROOT, 'src', 'custom-x')));

  // ---- what Steam downloaded ------------------------------------------------------------------------------------------------
  const steam = path.join(TMP, 'Steam');
  const mapDir = path.join(steam, 'steamapps', 'workshop', 'content', '730', '9900000005');
  put(path.join(mapDir, 'publish_data.txt'), '"publish_data"\n{\n\t"title"\t\t"aim_testmap"\n\t"source_folder"\t\t"aim_testmap"\n\t"publish_time"\t\t"1781412230"\n}\n');
  put(path.join(mapDir, '9900000005_dir.vpk'), vpk(['maps/aim_testmap.vpk', 'maps/aim_testmap.nav', 'materials/test/wall.vmat_c']));
  put(path.join(mapDir, '9900000005_000.vpk'), Buffer.alloc(64));
  const d = W.describeSubscribed(mapDir);
  check('a subscribed map\'s folder: its title and the map its VPK holds', d.kind === 'map' && d.title === 'aim_testmap' && d.packed.includes('maps/aim_testmap.vpk'));
  const rs = await run({ workshop: '9900000001', steam, files: null, ...nebulaOpts });
  check('a finish is never in the Steam folder: why, and what to do instead', !rs.ok && rs.errors.some((e) => /isn't in your Steam folder\. Steam never downloads a weapon finish/.test(e) && /--files <their folder or zip> --workshop 9900000001/.test(e)));
  const rm = await W.importFinish({ game, workshop: '9900000005', steam, offline: true, creatorName: 'x' });
  check('an id that is a subscribed map: said so, from the VPK', !rm.ok && rm.errors.some((e) => /is a map \("aim_testmap"\): its VPK holds maps\/aim_testmap\.vpk/.test(e)));
  const real = 'C:/Program Files (x86)/Steam/steamapps/workshop/content/730/3744399267';
  if (fs.existsSync(real)) {
    const dr = W.describeSubscribed(real);
    check('(your Steam) your one subscribed CS2 item is a map, as Steam downloads them', dr.kind === 'map' && dr.packed.some((p) => /^maps\/.+\.vpk$/.test(p)), `${dr.title}: ${dr.packed.find((p) => /^maps\//.test(p))}`);
  }

  // ---- the command line --------------------------------------------------------------------------------------------------------
  const cli = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'import-workshop.mjs'), ...a], { encoding: 'utf8' });
  const c = cli(addonZip, '--workshop', 'https://steamcommunity.com/sharedfiles/filedetails/?id=9900000001', '--details', DETAILS, '--creator-name', 'Test Creator', '--rarity', 'Classified',
    '--prices', 'FN=42.5,MW=24,FT=15.75,WW=13.2,BS=11.4', '--out', outDir('cli'), '--permission', PERMISSION, '--icon', ICON);
  check('the command line imports, says where, and what\'s next', c.status === 0 && /Imported AK-47 \| Test Nebula \(Steam Workshop 9900000001, by Test Creator\)/.test(c.stdout) && /Next:/.test(c.stdout) && fs.existsSync(path.join(outDir('cli'), 'skins', 'AK-47 - Test Nebula', 'skin.json')), c.stdout + c.stderr);
  const c2 = cli('9900000001', '--steam', steam, '--details', DETAILS);
  check('the command line with only an id says why there\'s nothing to import', c2.status === 1 && /Steam never downloads a weapon finish/.test(c2.stdout));
  const c3 = cli(addon, '--workshop', '9900000001', '--details', DETAILS, '--rarity', 'Classified', '--prices', '1', '--out', LIVE);
  check('the command line won\'t write into custom/ without --live', c3.status === 1 && /live pack folder/.test(c3.stdout));

  // ---- Valve's own compiled example (only with CS2 installed) --------------------------------------------------------------------
  const vpkFile = 'C:/Program Files (x86)/Steam/steamapps/common/Counter-Strike Global Offensive/game/csgo/pak01_dir.vpk';
  if (fs.existsSync(W.CLI) && fs.existsSync(vpkFile)) {
    const vdir = path.join(TMP, 'valve-example');
    for (const f of ['weapons/paints/workshop/cu_paintkit_example.vcompmat_c', 'items/assets/paintkits/workshop/example_custom_paint_tga_1ad43866.vtex_c']) execFileSync(W.CLI, ['-i', vpkFile, '-f', f, '-o', vdir], { windowsHide: true, stdio: 'ignore' });
    const rv = await W.importFinish({ game, files: vdir, creatorName: 'Valve (CS2\'s example finish)', name: 'AK-47 | Valve Example', weapon: 'AK-47', rarity: 'Covert', prices: { FN: 1 }, out: outDir('valve') });
    for (const e of rv.errors) console.log('  import error: ' + e);
    const sv = rv.ok ? json(path.join(rv.folder, 'skin.json')) : {};
    check('(your CS2) Valve\'s own compiled example finish (.vcompmat_c, .vtex_c) imports: Custom Paint Job, its 4096 picture at 2048', rv.ok && rv.format === 'cs2-vcompmat' && sv.finish?.style === 'Custom Paint Job'
      && readImage(path.join(rv.folder, 'color.png')).w === 2048 && sv.credit === 'Valve (CS2\'s example finish)' && !sv.workshop, rv.textures?.join(', '));
    check('(your CS2) and the build takes it', buildCustom({ src: outDir('valve'), data: game, draft: true }).ok);
  } else console.log('(skipped: Valve\'s compiled example, CS2 or tools/s2v not installed)');

  // ---- nothing reaches the game -----------------------------------------------------------------------------------------------------
  const liveAfter = fs.existsSync(LIVE) ? fs.readdirSync(LIVE, { recursive: true }).sort().join('|') : null;
  check('custom/ is as it was', liveAfter === liveBefore);
  check('the game still ships no custom content (no src/data/custom.json, no src/custom/)', !fs.existsSync(path.join(ROOT, 'src', 'data', 'custom.json')) && !fs.existsSync(path.join(ROOT, 'src', 'custom')));
  const liveBuild = buildCustom({ src: LIVE });
  initData(JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'data', 'game-data.json'), 'utf8')), { keys });
  check('and the data lock is the game data\'s own generatedAt, exactly', liveBuild.ok && liveBuild.custom === null && D.lock === game.generatedAt && D.lock === '2026-10-25T01:46:47.726Z');
  check('custom-staging/ is ignored by git', /^custom-staging\/$/m.test(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')));
} catch (e) {
  failed++;
  console.log('FAIL  threw: ' + (e?.stack || e));
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
