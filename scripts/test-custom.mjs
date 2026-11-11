// Custom content checks (CUSTOM_CONTENT.md): the data lock, stable ids, the build's checks, merging into the game data, and
// custom items going through everything that reads it, offline. The server's side: server/test-custom.mjs.
//   node scripts/test-custom.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const E = (m) => import(new URL(`../src/js/engine/${m}.js`, import.meta.url));
const { D, initData, caseTiers, casePrice, keyFor } = await E('data');
const CX = await E('custom');
const I = await E('items');
const T = await E('tradeup');
const ACT = await E('actions');
const IX = await E('itemindex');
const MK = await E('market');
const NPC = await E('npcs');
const { dropPool } = await E('levels');
const { freshState } = await E('economy');
const { mulberry32 } = await E('util');
const { analyzePattern } = await E('patterns');
const { buildCustom, writeBuild, skinId, caseId, norm } = await import('./build-custom.mjs');
const { imgUrl } = await import('../src/js/util.js');
const { rareDrop, dropEmbed, customPicture } = await import('../server/drops.mjs');
const pricing = require('../shared/pricing.cjs');

let failed = 0, passed = 0;
function check(name, ok, info = '') {
  if (ok) passed++; else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`);
}
const rng = mulberry32(4242);
const DATA = path.join(ROOT, 'src', 'data');
const readGame = () => JSON.parse(fs.readFileSync(path.join(DATA, 'game-data.json'), 'utf8'));
const keys = JSON.parse(fs.readFileSync(path.join(DATA, 'keys.json'), 'utf8'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cs2sim-custom-'));
const EXAMPLE = path.join(ROOT, 'docs', 'custom-example');
// A copy of a pack folder to change (the build writes ids.json beside the packs).
function copyPack(from = EXAMPLE, name = 'pack') {
  const dir = path.join(TMP, name + '-' + Math.random().toString(36).slice(2, 8));
  fs.cpSync(from, dir, { recursive: true, filter: (f) => !/make-textures\.mjs$|ids\.json$/.test(f) });
  return dir;
}
const edit = (file, fn) => { const j = JSON.parse(fs.readFileSync(file, 'utf8')); fn(j); fs.writeFileSync(file, JSON.stringify(j, null, 2)); };
const skinJson = (dir, folder) => path.join(dir, 'skins', folder, 'skin.json');
const caseJson = (dir) => path.join(dir, 'cases', 'Example Case', 'case.json');

try {
  // ---- with no custom content, nothing changes --------------------------------------------------------------------------------
  {
    const game = readGame();
    check('the game ships no custom content today: no src/data/custom.json, no src/custom/', !fs.existsSync(path.join(DATA, 'custom.json')) && !fs.existsSync(path.join(ROOT, 'src', 'custom')));
    const live = buildCustom({ src: path.join(ROOT, 'custom') });
    check('the live custom/ folder has no items (the example lives in docs/custom-example)', live.ok && live.custom === null && live.lock === null);
    initData(readGame(), { keys });
    check('without custom content the data lock is the game data\'s own generatedAt, exactly', D.lock === game.generatedAt && D.lock === '2026-10-25T01:46:47.726Z' && D.cx === null, D.lock);
    initData(readGame(), { keys, custom: null });
    const plain = D.lock;
    initData(readGame(), { keys, custom: { format: 1, skins: {}, cases: [], collections: [], kits: {} } });
    check('an empty custom.json changes nothing either', D.lock === plain && D.lock === game.generatedAt && !D.cx);
    check('dataLock: generatedAt itself without custom content', CX.dataLock(game.generatedAt, null) === game.generatedAt && CX.lockBase(game.generatedAt + '+cx.0123456789abcdef') === game.generatedAt);
    // An empty build removes what an earlier one wrote.
    const out = path.join(TMP, 'empty-out');
    fs.mkdirSync(path.join(out, 'data'), { recursive: true }); fs.mkdirSync(path.join(out, 'custom', 'x'), { recursive: true });
    fs.writeFileSync(path.join(out, 'data', 'custom.json'), '{}');
    const none = buildCustom({ src: path.join(TMP, 'no-such-folder') });
    writeBuild(none, { out });
    check('building no packs writes nothing and removes an earlier build (custom.json and custom/)', none.ok && !none.custom && !fs.existsSync(path.join(out, 'data', 'custom.json')) && !fs.existsSync(path.join(out, 'custom')));
  }

  // ---- the example pack ---------------------------------------------------------------------------------------------------------
  const src = copyPack();
  const r1 = buildCustom({ src, history: path.join(src, 'ids.json') });
  for (const e of r1.errors) console.log('  build error: ' + e);
  check('the example pack builds without errors', r1.ok && r1.custom && Object.keys(r1.custom.skins).length === 4 && r1.custom.cases.length === 1 && r1.custom.collections.length === 1);
  const out1 = path.join(TMP, 'out1'), out2 = path.join(TMP, 'out2');
  writeBuild(r1, { out: out1, history: path.join(src, 'ids.json') });
  const r2 = buildCustom({ src, history: path.join(src, 'ids.json') });
  writeBuild(r2, { out: out2 });
  const tree = (dir) => {
    const out = {};
    const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else out[path.relative(dir, p).replace(/\\/g, '/')] = fs.readFileSync(p).toString('base64'); } };
    walk(dir);
    return out;
  };
  check('building it twice gives the same bytes (data, textures, pictures), ids and lock', JSON.stringify(tree(out1)) === JSON.stringify(tree(out2)) && r1.lock === r2.lock && Object.keys(tree(out1)).length === 16, `${Object.keys(tree(out1)).length} files`);
  const custom = JSON.parse(fs.readFileSync(path.join(out1, 'data', 'custom.json'), 'utf8'));
  const sk = (n) => Object.values(custom.skins).find((s) => s.n === n);
  const ak = sk('AK-47 | Example Nebula'), m4 = sk('M4A1-S | Example Circuit'), knife = sk('★ Karambit | Example Aurora'), gloves = sk('★ Sport Gloves | Example Circuit');
  const box = custom.cases[0];
  check('custom ids come from the names: skin-cx-…, crate-cx-…', ak.id === skinId('AK-47 | Example Nebula') && box.id === caseId('Example Case') && /^skin-cx-[0-9a-f]{12}$/.test(knife.id) && /^crate-cx-[0-9a-f]{12}$/.test(box.id));
  check('ids don\'t care how a name is typed (case, spaces)', skinId('ak-47  |  EXAMPLE nebula') === ak.id && norm(' A  b ') === 'a b');
  const game = readGame();
  check('no custom id or name is a real item\'s', Object.keys(custom.skins).every((id) => !game.skins[id]) && !game.cases.some((c) => c.id === box.id || c.n === box.n)
    && Object.values(custom.skins).every((s) => !Object.values(game.skins).some((g) => g.n === s.n)));
  check('the records have the real shape: weapon, category, rarity, float, prices per wear', ak.wid === 'weapon_ak47' && ak.w === 'AK-47' && ak.cat === 'rifle' && ak.r === 4 && ak.rn === 'Classified'
    && ak.mn === 0 && ak.mx === 0.7 && ak.p.FN[0] === 42.5 && ak.p.FN[1] === 72.25 && Object.keys(ak.p).join() === 'FN,MW,FT,WW,BS' && ak.img === `custom/${ak.id}/icon.png` && /^cx_/.test(ak.fid));
  check('a custom knife is ★ Covert with StatTrak™; custom gloves are ★ Extraordinary without', knife.star && knife.cat === 'knife' && knife.wid === 'weapon_knife_karambit' && knife.rn === 'Covert' && knife.stt === true && knife.p.FN[1] === 1690
    && gloves.star && gloves.cat === 'gloves' && gloves.wid === 'sporty_gloves' && gloves.rn === 'Extraordinary' && gloves.stt === false && gloves.p.FT[1] === null);
  check('the custom case: pools by rarity (custom and real skins), its gold slot (custom knife and gloves, and a real knife\'s phases as one slot)',
    box.pools[4].includes(ak.id) && box.pools[3].includes(m4.id) && box.pools[2].length === 4 && box.rare.length === 3 && box.rare[0].length + box.rare[1].length === 2
    && box.rare[2].length === 7 && box.rare[2].every((id) => game.skins[id].n === '★ Karambit | Doppler') && box.rareKind === 'mixed' && box.crate.base === '4904' && box.crate.art === `custom/${box.id}/crate.png`);
  check('its collection holds only its custom skins (real ones keep theirs)', custom.collections[0].caseId === box.id && custom.collections[0].tiers[3].join() === m4.id && custom.collections[0].tiers[4].join() === ak.id && ak.col === custom.collections[0].id && box.pools[3].filter((id) => game.skins[id]).every((id) => game.skins[id].col !== ak.col));
  check('kits: a gun\'s and a knife\'s are CS2 Workshop templates with the pack\'s values; the gloves\' a CS2 glove kit with the picture',
    custom.kits[ak.fid].template === 'custom_paint_job' && custom.kits[ak.fid].vars['exposed_params.g_tPattern'].texture === `custom/${ak.id}/color.png`
    && custom.kits[m4.fid].template === 'hydrographic' && custom.kits[m4.fid].vars['exposed_params.g_vColor1'].color.join() === '255,138,31'
    && custom.kits[knife.fid].template === 'anodized_airbrushed' && custom.kits[gloves.fid].kind === 'glove' && custom.kits[gloves.fid].base === 'sporty_light_blue' && custom.kits[gloves.fid].mode === 3);
  const ids1 = JSON.parse(fs.readFileSync(path.join(src, 'ids.json'), 'utf8')).ids;
  check('ids.json remembers every item built, the case\'s key too', Object.keys(ids1).length === 7 && ids1[ak.id] === 'AK-47 | Example Nebula' && ids1['key-' + box.id] === 'Example Case Key');

  // ---- what changes the lock, and what doesn't ---------------------------------------------------------------------------------
  {
    const s2 = copyPack();
    edit(skinJson(s2, 'AK-47 - Example Nebula'), (j) => { j.prices.FN = 99; });
    edit(caseJson(s2), (j) => { j.price = 3.5; });
    fs.copyFileSync(path.join(s2, 'skins', 'M4A1-S - Example Circuit', 'color.png'), path.join(s2, 'skins', 'AK-47 - Example Nebula', 'color.png'));
    const r = buildCustom({ src: s2 });
    check('new prices and textures keep the ids and the lock (prices reach games through the server\'s price patch)', r.ok && r.lock === r1.lock && JSON.stringify(Object.keys(r.custom.skins)) === JSON.stringify(Object.keys(r1.custom.skins)) && r.custom.skins[ak.id].p.FN[0] === 99);
    const s3 = copyPack();
    edit(skinJson(s3, 'AK-47 - Example Nebula'), (j) => { j.float = [0, 0.6]; j.prices = { FN: 1, MW: 1, FT: 1, WW: 1, BS: 1 }; });
    check('a different float range changes the lock', buildCustom({ src: s3 }).lock !== r1.lock);
    const s4 = copyPack();
    edit(skinJson(s4, 'AK-47 - Example Nebula'), (j) => { j.name = 'AK-47 | Example Galaxy'; });
    edit(caseJson(s4), (j) => { j.items.Classified = ['AK-47 | Example Galaxy']; });
    const renamed = buildCustom({ src: s4 });
    check('renaming changes the id (and the lock)', renamed.ok && !renamed.custom.skins[ak.id] && renamed.custom.skins[skinId('AK-47 | Example Galaxy')] && renamed.lock !== r1.lock);
    edit(skinJson(s4, 'AK-47 - Example Nebula'), (j) => { j.key = 'AK-47 | Example Nebula'; });
    const kept = buildCustom({ src: s4 });
    check('…unless the old name is kept as its "key": same id, so players\' copies stay that item', kept.ok && kept.custom.skins[ak.id]?.n === 'AK-47 | Example Galaxy');
    // Removing an item that was built before.
    const s5 = copyPack();
    fs.copyFileSync(path.join(src, 'ids.json'), path.join(s5, 'ids.json'));
    fs.rmSync(path.join(s5, 'skins', 'M4A1-S - Example Circuit'), { recursive: true });
    edit(caseJson(s5), (j) => { j.items.Restricted = j.items.Restricted.filter((n) => !/Example/.test(n)); });
    const removed = buildCustom({ src: s5, history: path.join(s5, 'ids.json') });
    check('an item from an earlier build can\'t just vanish (players would have Unknown items)', !removed.ok && removed.errors.some((e) => /M4A1-S \| Example Circuit.*Unknown item/.test(e)));
    check('…unless --allow-removed', buildCustom({ src: s5, history: path.join(s5, 'ids.json'), allowRemoved: true }).ok);
  }

  // ---- the checks --------------------------------------------------------------------------------------------------------------
  {
    const bad = (name, change, re) => {
      const s = copyPack();
      change(s);
      const r = buildCustom({ src: s });
      const hit = r.errors.find((e) => re.test(e));
      check('build check: ' + name, !r.ok && !!hit, hit || r.errors.join(' / ') || 'no error');
    };
    bad('a real skin\'s name', (s) => edit(skinJson(s, 'AK-47 - Example Nebula'), (j) => { j.name = 'AK-47 | Redline'; }), /AK-47 \| Redline" is a real CS2 item's name/);
    bad('a real case\'s name', (s) => edit(caseJson(s), (j) => { j.name = 'Kilowatt Case'; }), /real CS2 container's name/);
    bad('an unknown weapon', (s) => edit(skinJson(s, 'AK-47 - Example Nebula'), (j) => { j.name = 'AK-48 | Example'; }), /unknown weapon "AK-48"/);
    bad('a rarity that isn\'t one', (s) => edit(skinJson(s, 'AK-47 - Example Nebula'), (j) => { j.rarity = 'Legendary'; }), /rarity must be one of/);
    bad('StatTrak™ gloves', (s) => edit(skinJson(s, 'Sport Gloves - Example Circuit'), (j) => { j.stattrak = true; }), /gloves have no StatTrak/);
    bad('a knife that isn\'t Covert', (s) => edit(skinJson(s, 'Karambit - Example Aurora'), (j) => { j.rarity = 'Restricted'; }), /always Covert/);
    bad('no prices', (s) => edit(skinJson(s, 'AK-47 - Example Nebula'), (j) => { delete j.prices; }), /needs "prices"/);
    bad('a price for a wear the float range hasn\'t', (s) => edit(skinJson(s, 'Karambit - Example Aurora'), (j) => { j.prices.BS = 5; }), /has no BS/);
    bad('a misspelt field', (s) => edit(skinJson(s, 'AK-47 - Example Nebula'), (j) => { j.rarty = 'Covert'; }), /unknown field "rarty"/);
    bad('a style that isn\'t one', (s) => edit(skinJson(s, 'AK-47 - Example Nebula'), (j) => { j.finish.style = 'Chrome'; }), /finish "style" must be one of/);
    bad('a Custom Paint Job without its texture', (s) => fs.rmSync(path.join(s, 'skins', 'AK-47 - Example Nebula', 'color.png')), /needs color\.png/);
    bad('no picture', (s) => fs.rmSync(path.join(s, 'skins', 'AK-47 - Example Nebula', 'icon.png')), /needs icon\.png/);
    bad('a case without its picture', (s) => fs.rmSync(path.join(s, 'cases', 'Example Case', 'case.png')), /needs case\.png/);
    bad('two items of one name', (s) => fs.cpSync(path.join(s, 'skins', 'AK-47 - Example Nebula'), path.join(s, 'skins', 'AK-47 - Example Nebula 2'), { recursive: true }), /is in skins\/AK-47 - Example Nebula/);
    bad('a case naming a skin there isn\'t', (s) => edit(caseJson(s), (j) => { j.items.Classified.push('AK-47 | Nope'); }), /"AK-47 \| Nope" isn't a custom skin here or a real CS2 item/);
    bad('a skin under the wrong rarity', (s) => edit(caseJson(s), (j) => { j.items['Mil-Spec'].push('AK-47 | Example Nebula'); }), /is Classified, not Mil-Spec Grade/);
    bad('a knife among the case\'s skins', (s) => edit(caseJson(s), (j) => { j.items.Classified.push('★ Karambit | Example Aurora'); }), /go in "rare"/);
    bad('a gun in the gold slot', (s) => edit(caseJson(s), (j) => { j.rare.push('AK-47 | Example Nebula'); }), /only ★ items/);
    bad('a real collection\'s name', (s) => edit(caseJson(s), (j) => { j.collection = 'The Huntsman Collection'; }), /real collection's name/);
    bad('broken JSON', (s) => fs.writeFileSync(skinJson(s, 'AK-47 - Example Nebula'), '{ "name": '), /isn't valid JSON/);
  }

  // ---- merged into the game -------------------------------------------------------------------------------------------------
  initData(readGame(), { keys });
  const before = { skins: JSON.stringify(D.skins), cases: JSON.stringify(D.cases.map((c) => ({ ...c }))), cols: JSON.stringify(D.collections), keys: JSON.stringify(D.keys), pool: dropPool().cases.map((c) => c.id).join() };
  const realGame = readGame();
  initData(realGame, { keys, custom });
  const lock = CX.customLock(custom);
  check('with custom content the lock is generatedAt + its hash (made from the definitions, the same as the build\'s)', D.lock === `${realGame.generatedAt}+cx.${lock}` && lock === r1.lock && D.generatedAt === realGame.generatedAt, D.lock);
  check('merged: 4 skins, 1 case, 1 collection; the parsed game data is left as it was', Object.keys(D.skins).length === Object.keys(realGame.skins).length + 4 && D.cases.some((c) => c.id === box.id) && D.colById[ak.col]
    && !realGame.skins[ak.id] && !realGame.cases.some((c) => c.id === box.id) && D.cx.skins === 4);
  const realOnly = (o) => Object.fromEntries(Object.entries(o).filter(([id]) => !/-cx-/.test(id)));
  check('every real item is exactly as before (skins, cases, collections, keys)', JSON.stringify(realOnly(D.skins)) === before.skins
    && JSON.stringify(D.cases.filter((c) => !c.cx).map((c) => ({ ...c }))) === before.cases && JSON.stringify(D.collections.filter((c) => !c.cx)) === before.cols
    && JSON.stringify(realOnly(D.keys)) === before.keys);
  const cbox = D.caseById[box.id];
  check('custom items are marked cx, never `custom` (the game\'s own boxes)', D.skins[ak.id].cx === 1 && cbox.cx === 1 && cbox.custom === false);
  check('the custom case gets its own key', keyFor(cbox) === 'key-' + box.id && D.keys[keyFor(cbox)].n === 'Example Case Key' && casePrice(cbox) === Math.round((2.95 + D.keyPrice) * 100) / 100);

  // ---- opening it offline ------------------------------------------------------------------------------------------------
  {
    const n = 40000, counts = {}, ids = new Set();
    let sttKnife = 0, knives = 0, gloveStt = 0;
    for (let i = 0; i < n; i++) {
      const it = I.rollFromCase(cbox, rng), d = D.skins[it.id];
      const k = d.star ? 'rare' : String(d.r);
      counts[k] = (counts[k] || 0) + 1;
      ids.add(it.id);
      if (d.cat === 'knife') { knives++; if (it.stt) sttKnife++; }
      if (d.cat === 'gloves' && it.stt) gloveStt++;
    }
    const exp = Object.fromEntries(caseTiers(cbox).map(([k, w]) => [k, w / caseTiers(cbox).reduce((s, x) => s + x[1], 0)]));
    const ok = Object.entries(exp).every(([k, w]) => Math.abs((counts[k] || 0) / n - w) <= Math.max(0.002, w * 0.12));
    check('opening the custom case follows CS2\'s odds over its own tiers', ok, JSON.stringify(counts));
    const pool = new Set([...Object.values(cbox.pools).flat(), ...cbox.rare.flat()]);
    check('everything it drops is from its own lists', [...ids].every((id) => pool.has(id)) && ids.has(ak.id) && ids.has(m4.id));
    check('its custom knife can be StatTrak™, its gloves never', knives > 0 && sttKnife > 0 && gloveStt === 0, `${sttKnife}/${knives}`);
    const st = freshState();
    st.money = 100;
    const run = (name, args) => { const ctx = ACT.makeCtx(st, { rng }); return ACT.runAction(ctx, name, args); };
    run('case.buy', { id: cbox.id, n: 5 });
    run('key.buy', { key: keyFor(cbox), n: 5 });
    const op = run('case.open', { id: cbox.id, n: 5 });
    check('offline: buying, keying and opening the custom case', op.items.length === 5 && op.items.every((it) => pool.has(it.id)) && Math.abs(st.money - (100 - casePrice(cbox) * 5)) < 1e-6 && st.inv.length === 5);
    const drop = op.items[0];
    const m0 = st.money, v = I.itemValue(drop);
    run('item.sell', { uids: [drop.uid] });
    check('offline: selling a custom drop pays its value', Math.abs(st.money - m0 - v) < 0.011 && v > 0, `$${v}`);
  }

  // ---- values, names, rarity, patterns ------------------------------------------------------------------------------------
  {
    const a = I.makeSkinItem(D.skins[ak.id], { fl: 0.05, sd: 1, stt: true, r: rng });
    check('value from the pack: StatTrak™ Factory New AK', I.basePrice(a) === 72.25 && I.itemName(a) === 'StatTrak™ AK-47 | Example Nebula');
    const k = I.makeSkinItem(D.skins[knife.id], { fl: 0.01, sd: 7, stt: true, r: rng });
    check('a custom knife is named and ranked like a real one', I.itemName(k) === '★ StatTrak™ Karambit | Example Aurora' && I.rarityInfo(k).n === 'Covert ★' && I.rarityRank(k) === 6 && I.loadoutSlot(k) === 'knife');
    const g = I.makeSkinItem(D.skins[gloves.id], { fl: 0.2, sd: 3, r: rng });
    check('custom gloves: Extraordinary, the gloves slot, no StatTrak™', I.rarityInfo(g).n === 'Extraordinary' && I.loadoutSlot(g) === 'gloves' && !g.stt && I.basePrice(g) === 420);
    check('auto-sell never sells a custom knife or gloves', !I.autoSellMatch(k, { on: true, below: 1e9, ranks: [0, 1, 2, 3, 4, 5] }) && !I.autoSellMatch(g, { on: true, below: 1e9, ranks: [0, 1, 2, 3, 4, 5] }));
    check('a pack\'s "Fade" pattern rule gives fade percentages', analyzePattern(D.skins[knife.id], 7).fade > 0);
    const fakeCH = { ...D.skins[ak.id], fin: 'Case Hardened', wid: 'weapon_ak47' };
    check('a custom finish called "Case Hardened" gets none of the real one\'s Blue Gem tiers', analyzePattern(fakeCH, 661).label === '' && analyzePattern({ ...D.skins[ak.id], fin: 'Doppler', ph: 'Phase 2' }, 5).label === '');
    check('pictures: custom paths are the game\'s own files, no image proxy', imgUrl(ak.img) === ak.img && imgUrl(ak.img, 'l') === `custom/${ak.id}/icon-l.png` && imgUrl('~abc').startsWith('img?u='));
  }

  // ---- trade-ups ------------------------------------------------------------------------------------------------------------
  {
    const m4s = Array.from({ length: 10 }, () => I.makeSkinItem(D.skins[m4.id], { stt: false, r: rng }));
    const c = T.tradeupContract(m4s);
    check('10 custom Restricted skins of a custom collection trade up to its Classified', c.ok && c.outcomes.length === 1 && c.outcomes[0].ids[0] === ak.id, c.error);
    check('a custom skin with no collection can\'t be traded up', (() => {
      const s = copyPack();
      edit(caseJson(s), (j) => { delete j.collection; });
      const r = buildCustom({ src: s });
      initData(readGame(), { keys, custom: r.custom });
      const why = T.tradeupIneligible(I.makeSkinItem(D.skins[m4.id], { r: rng }));
      initData(readGame(), { keys, custom });
      return why === 'Not part of a collection';
    })());
    // A Covert custom gun gives the custom case's gold slot.
    const s = copyPack();
    edit(skinJson(s, 'AK-47 - Example Nebula'), (j) => { j.rarity = 'Covert'; });
    edit(caseJson(s), (j) => { j.items.Covert = j.items.Classified; delete j.items.Classified; });
    const r = buildCustom({ src: s });
    initData(readGame(), { keys, custom: r.custom });
    const covert = T.tradeupContract(Array.from({ length: 5 }, () => I.makeSkinItem(D.skins[ak.id], { stt: false, r: rng })));
    const sttC = T.tradeupContract(Array.from({ length: 5 }, () => I.makeSkinItem(D.skins[ak.id], { stt: true, r: rng })));
    check('5 custom Covert skins give the custom case\'s knives and gloves (custom and real); StatTrak™ only knives',
      covert.ok && covert.outcomes.length === 3 && covert.outcomes.some((o) => o.ids[0] === knife.id) && covert.outcomes.some((o) => o.ids[0] === gloves.id)
      && sttC.ok && sttC.outcomes.length === 2 && !sttC.outcomes.some((o) => o.ids[0] === gloves.id));
    const got = T.rollTradeup(covert, rng);
    check('signing it gives one of them', [knife.id, gloves.id, ...box.rare[2]].includes(got.id));
    initData(readGame(), { keys, custom });
  }

  // ---- the rest of what reads the game data -------------------------------------------------------------------------------
  {
    check('the Index has the custom case\'s set and its goals', !!IX.setOf(box.id) && IX.setOf(box.id).ids.includes(ak.id) && IX.allGoals().some((g) => g.ids.includes(ak.id)));
    let listed = 0;
    for (let w = 1000; w < 1400; w++) listed += MK.skinListings(D.skins[m4.id], w).length;
    check('the Market lists custom skins (from the clock, like real ones)', listed > 0, `${listed} listings over 400 windows`);
    const so = { seed: 'cx-test', npcs: {} };
    const world = NPC.worldCopies ? NPC.worldCopies(so) : [];
    check('NPC traders can own custom items (they\'re in the skin index)', Array.isArray(world));
    check('the level-up drop pool is unchanged: custom cases stay out unless their pack asks', dropPool().cases.map((c) => c.id).join() === before.pool);
    const pinned = { ...D.skins[knife.id] };
    pricing.applyPrices({ skins: D.skins, stickers: D.stickers, agents: D.agents, cases: D.cases, charms: D.charms }, pricing.buildIndex({}));
    check('the price refresh leaves custom prices as their pack has them (and still prices real ones)', JSON.stringify(D.skins[knife.id].p) === JSON.stringify(pinned.p) && D.caseById[box.id].price === 2.95
      && D.skins[Object.keys(realGame.skins)[0]].p != null);
    initData(readGame(), { keys, custom });
  }

  // ---- Discord posts --------------------------------------------------------------------------------------------------------
  {
    const k = I.makeSkinItem(D.skins[knife.id], { fl: 0.01, sd: 3, r: rng });
    const g = I.makeSkinItem(D.skins[gloves.id], { fl: 0.2, sd: 3, r: rng });
    const ek = dropEmbed('alice', k), eg = dropEmbed('alice', g);
    check('a custom knife posts as a Gold Knife, custom gloves as Gold Gloves', rareDrop(k).title.includes('Gold Knife') && rareDrop(g).title.includes('Gold Gloves'));
    check('their thumbnails come from the game\'s repository at the server\'s commit', ek.thumbnail?.url === customPicture(knife.img, process.env.SERVER_COMMIT || 'main')
      && /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\/src\/custom\/skin-cx-[0-9a-f]+\/icon\.png$/.test(eg.thumbnail.url) && customPicture('custom/../x.png') === null);
    const dop = { ...D.skins[knife.id], fin: 'Doppler', ph: 'Phase 2', id: knife.id };
    D.skins[knife.id] = dop;
    check('a custom finish named Doppler posts as gold, not as a Doppler', rareDrop(k).title.includes('Gold Knife'));
    initData(readGame(), { keys, custom });
  }

  // ---- ids, renames and names (the review's findings) -------------------------------------------------------------------------
  {
    const build = (s, o = {}) => buildCustom({ src: s, ...o });
    const errs = (r, re) => r.errors.find((x) => re.test(x));
    // A rename keeping the old name as "key", then a new item of the old name: one id for two items.
    const s1 = copyPack();
    edit(skinJson(s1, 'AK-47 - Example Nebula'), (j) => { j.name = 'AK-47 | Example Galaxy'; j.key = 'AK-47 | Example Nebula'; });
    fs.cpSync(path.join(s1, 'skins', 'AK-47 - Example Nebula'), path.join(s1, 'skins', 'AK-47 - Example Nebula 2'), { recursive: true });
    edit(skinJson(s1, 'AK-47 - Example Nebula 2'), (j) => { j.name = 'AK-47 | Example Nebula'; delete j.key; j.prices = { FN: 1, MW: 1, FT: 1, WW: 1, BS: 1 }; });
    const dup = build(s1);
    check('two items with one id (a "key" that is another\'s name) are refused, not one silently replacing the other', !dup.ok && !!errs(dup, /same id as skins\/AK-47 - Example Nebula/), errs(dup, /same id/));
    // A copied folder that already has a "key".
    const s1b = copyPack();
    edit(skinJson(s1b, 'AK-47 - Example Nebula'), (j) => { j.key = 'AK-47 | Example Nebula'; });
    fs.cpSync(path.join(s1b, 'skins', 'AK-47 - Example Nebula'), path.join(s1b, 'skins', 'AK-47 - Example Nova'), { recursive: true });
    edit(skinJson(s1b, 'AK-47 - Example Nova'), (j) => { j.name = 'AK-47 | Example Nova'; });
    check('a copied skin folder that kept its "key" is refused (it would be the same item)', !!errs(build(s1b), /same id/));
    // A "key" that another item has as its name now (that one keeping its own old name).
    const s1c = copyPack();
    edit(skinJson(s1c, 'AK-47 - Example Nebula'), (j) => { j.name = 'AK-47 | Example Galaxy'; j.key = 'AK-47 | Example Old'; });
    edit(skinJson(s1c, 'M4A1-S - Example Circuit'), (j) => { j.key = 'AK-47 | Example Galaxy'; j.name = 'M4A1-S | Example Circuit'; });
    check('a "key" that is another custom item\'s name now is refused', !!errs(build(s1c), /is the name of another custom item now/));
    // A knife's key, written as its folder is (no ★, " - "): the same id as with ★.
    const s2 = copyPack();
    edit(skinJson(s2, 'Karambit - Example Aurora'), (j) => { j.name = '★ Karambit | Example Dawn'; j.key = 'Karambit - Example Aurora'; });
    edit(caseJson(s2), (j) => { j.rare[0] = '★ Karambit | Example Dawn'; });
    const k2 = build(s2, { history: path.join(src, 'ids.json') });
    check('a knife\'s "key" without its ★ (or with the folder\'s " - ") keeps its id', k2.ok && k2.custom.skins[knife.id]?.n === '★ Karambit | Example Dawn', k2.errors.join(' / '));
    // Section 9's rename, with case.json still naming the old name: built, with a warning that says so.
    const s3 = copyPack();
    edit(skinJson(s3, 'AK-47 - Example Nebula'), (j) => { j.name = 'AK-47 | Example Galaxy'; j.key = 'AK-47 | Example Nebula'; });
    const r3 = build(s3, { history: path.join(src, 'ids.json') });
    check('a case naming a renamed skin by its old name ("key") still builds, warned, with the id kept', r3.ok && r3.custom.skins[ak.id]?.n === 'AK-47 | Example Galaxy' && r3.custom.cases[0].pools[4].includes(ak.id)
      && r3.warnings.some((w) => /Example Nebula" is AK-47 \| Example Galaxy's old name/.test(w)), r3.errors.join(' / '));
    // A case that fails isn't also reported as gone from ids.json (nor its collection and key).
    const s3b = copyPack();
    edit(caseJson(s3b), (j) => { j.items.Classified.push('AK-47 | Nope'); });
    const r3b = build(s3b, { history: path.join(src, 'ids.json') });
    check('a case with errors of its own isn\'t reported as vanished too', !r3b.ok && r3b.errors.length === 1, r3b.errors.join(' / '));
    // Renaming a case and its collection keeps their ids (players' cases, keys and Index goals).
    const s4 = copyPack();
    edit(caseJson(s4), (j) => { j.name = 'Example Box'; j.oldName = 'Example Case'; j.collection = 'The Example Set'; j.oldCollection = 'The Example Collection'; });
    const r4 = build(s4, { history: path.join(src, 'ids.json') });
    check('a renamed case keeps its id with "oldName", its collection with "oldCollection" (cases, keys, Index goals)', r4.ok && r4.custom.cases[0].id === box.id && r4.custom.cases[0].n === 'Example Box'
      && r4.custom.collections[0].id === custom.collections[0].id && r4.custom.collections[0].n === 'The Example Set', r4.errors.join(' / '));
    const s4b = copyPack();
    edit(caseJson(s4b), (j) => { j.name = 'Example Box'; });
    check('…without them it\'s refused, saying so', !!errs(build(s4b, { history: path.join(src, 'ids.json') }), /Example Case".*keep its old name as "oldName"/));
    const s4c = copyPack();
    edit(caseJson(s4c), (j) => { j.key = false; });
    check('a case that took a key and now doesn\'t is refused (players\' keys would be Unknown items)', !!errs(build(s4c, { history: path.join(src, 'ids.json') }), /Example Case Key.*keep "key": true/));
    // Names that would pass for something else.
    for (const n of ['Agent Locker', 'Trade Up Contract', 'Market', 'Trade', 'Level-up reward', 'Armory · Something', 'Trade with Bob', 'The Huntsman Collection']) {
      const s = copyPack();
      edit(caseJson(s), (j) => { j.name = n; });
      const r = build(s);
      check(`a case can't be called "${n}"`, !r.ok && !!errs(r, /what the game calls a place items come from|real collection's name/), r.errors.join(' / '));
    }
    // Phases are for knives and gloves; the Fade rule for knives and guns, with its rotation range and a fixed offset.
    const s5 = copyPack();
    edit(skinJson(s5, 'AK-47 - Example Nebula'), (j) => { j.phase = 'Phase 1'; });
    check('a gun with a "phase" is refused (each would take its own slot in a case\'s pool)', !!errs(build(s5), /"phase" is for knives and gloves/));
    const s6 = copyPack();
    edit(skinJson(s6, 'Sport Gloves - Example Circuit'), (j) => { j.patternRule = 'Fade'; });
    check('gloves with the Fade rule are refused', !!errs(build(s6), /gloves have no Fade/));
    const s7 = copyPack();
    edit(skinJson(s7, 'Karambit - Example Aurora'), (j) => { j.finish.offset = [[0, 0], [0.3, 0.3]]; });
    check('a Fade whose offset moves with the seed is refused (its percentage goes by the rotation)', !!errs(build(s7), /needs a fixed "offset"/));
    const s8 = copyPack();
    edit(skinJson(s8, 'Karambit - Example Aurora'), (j) => { j.finish.rotation = [-50, -60]; });
    const r8 = build(s8);
    check('a rotation range may run either way (as CS2\'s own kits\'), and is kept as written', r8.ok && r8.custom.kits[knife.fid].vars['econ_instance.g_flPatternTexCoordRotation'].min === -50 && r8.custom.kits[knife.fid].vars['econ_instance.g_flPatternTexCoordRotation'].max === -60);
    // The Fade rule is part of what an item is: it's in the lock.
    const s9 = copyPack();
    edit(skinJson(s9, 'Karambit - Example Aurora'), (j) => { delete j.patternRule; });
    check('the Fade rule is in the data lock (it changes values and the Market)', build(s9).lock !== r1.lock);
    check('custom gloves have no weapon finish style, like CS2\'s ("None")', gloves.st === 'None' && knife.st === 'Anodized Airbrushed');
  }

  // ---- trade-ups worth more than their inputs -------------------------------------------------------------------------------
  {
    const s = copyPack();
    const awp = path.join(s, 'skins', 'AWP - Example Cheap');
    fs.cpSync(path.join(s, 'skins', 'AK-47 - Example Nebula'), awp, { recursive: true });
    edit(path.join(awp, 'skin.json'), (j) => { j.name = 'AWP | Example Cheap'; j.rarity = 'Covert'; j.prices = { FT: 18 }; delete j.pricesStatTrak; });
    edit(caseJson(s), (j) => { j.items.Covert = ['AWP | Example Cheap']; });
    const r = buildCustom({ src: s });
    check('five cheap custom Coverts trading up into the gold slot\'s knives is refused, with the figures', !r.ok && r.errors.some((e) => /trade-up of 5 .*Covert skins of The Example Collection costs \$\d+\.\d\d .*gives \$\d/.test(e)), r.errors.join(' / '));
    edit(caseJson(s), (j) => { j.allowTradeupProfit = true; });
    const r2 = buildCustom({ src: s });
    check('…unless the case allows it, and then it\'s a warning', r2.ok && r2.warnings.some((w) => /trade-up of 5/.test(w)));
    check('the example pack\'s own contracts cost more than they give (no warning)', !r1.warnings.some((w) => /trade-up/.test(w)), r1.warnings.join(' / '));
  }

  // ---- the Index: a custom case's goals are for what only it has --------------------------------------------------------------
  {
    initData(readGame(), { keys, custom });
    const set = IX.setOf(box.id);
    const rare = IX.goalOf(set.rareGoal);
    const realDoppler = box.rare[2][1];
    const ix = { items: { [realDoppler]: { n: 1 } }, claimed: {} };
    check('its gold-slot bonus is only for its own custom knives and gloves', !!rare && rare.ids.length === 2 && rare.ids.every((id) => D.skins[id].cx) && set.rare.length === 9);
    check('a real Karambit | Doppler found before (in a Chroma Case) doesn\'t finish it', !IX.goalDone(ix, rare) && IX.goalDone({ items: { [knife.id]: { n: 1 } }, claimed: {} }, rare));
    // A custom case of real skins only.
    const s = copyPack();
    edit(caseJson(s), (j) => { j.items = { 'Mil-Spec': ['Dual Berettas | Hideout', 'MAC-10 | Light Box'], Restricted: ['Glock-18 | Block-18'] }; j.rare = ['★ Karambit | Doppler', '★ Bayonet | Doppler']; delete j.collection; });
    for (const f of ['AK-47 - Example Nebula', 'M4A1-S - Example Circuit', 'Karambit - Example Aurora', 'Sport Gloves - Example Circuit']) fs.rmSync(path.join(s, 'skins', f), { recursive: true });
    const r = buildCustom({ src: s });
    initData(readGame(), { keys, custom: r.custom });
    const realSet = IX.setOf(r.custom.cases[0].id);
    check('a custom case of real skins (a mix no real case has) gets no goal of its own to finish', r.ok && realSet && realSet.goal === '' && realSet.rareGoal === null, `${realSet?.goal} / ${realSet?.rareGoal}`);
    initData(readGame(), { keys, custom });
  }

  // ---- collectors, the Fade rule and prices -----------------------------------------------------------------------------------
  {
    const k = I.makeSkinItem(D.skins[knife.id], { fl: 0.01, sd: 7, r: rng });
    const fake = { ...D.skins[knife.id], fin: 'Doppler', ph: 'Ruby', pr: undefined };
    check('collectors who go by a finish\'s name never take a custom one for a Doppler or Case Hardened', NPC.FOCUS.doppler.fit({ t: 'skin' }, fake) === 0 && !NPC.FOCUS.doppler.pool(fake)
      && NPC.FOCUS.bluegem.fit({ t: 'skin' }, { ...fake, fin: 'Case Hardened' }) === 0 && NPC.FOCUS.fade.fit({ t: 'skin' }, { ...fake, fin: 'Example Fade' }) === 0);
    check('…and a custom Fade by its pack\'s rule', NPC.FOCUS.fade.fit(k) > 0 && NPC.FOCUS.fade.pool(D.skins[knife.id]));
    const { UniformRandomStream: A } = await import('../src/js/engine/rng.js');
    const { UniformRandomStream: B } = await import('../src/js/cs2/rng.js');
    let same = true;
    for (let s = 0; s <= 1000 && same; s += 7) { const a = new A(s), b = new B(s); for (let i = 0; i < 5; i++) if (a.randomFloat(-3, 9) !== b.randomFloat(-3, 9)) same = false; }
    check('the engine\'s paint-seed generator is the 3D\'s', same);
    const { rotationRoll } = await import('../src/js/engine/rng.js');
    const { RARE_FADES } = await import('../src/js/engine/rare-patterns-data.js');
    const real = (s) => parseInt(RARE_FADES[0].p.slice(s * 2, s * 2 + 2), 32) / 10;
    check('CS2\'s own Karambit | Fade percentages (the CS.MONEY Wiki\'s) are 80 + 20 × the seed\'s rotation roll', [0, 1, 2, 100, 412, 763, 1000].every((s) => Math.abs(real(s) - (80 + 20 * rotationRoll(s))) < 0.051));
    check('a custom Fade\'s percentage is that rotation roll, as its 3D turns it', [0, 1, 500, 1000].every((s) => Math.abs(analyzePattern(D.skins[knife.id], s).fade - (80 + 20 * rotationRoll(s))) < 1e-9));
    const s = copyPack();
    edit(skinJson(s, 'AK-47 - Example Nebula'), (j) => { j.prices.FN = 99; });
    const r = buildCustom({ src: s });
    initData(readGame(), { keys, custom: r.custom });
    const h2 = CX.customPriceHash(D);
    initData(readGame(), { keys, custom });
    const h1 = CX.customPriceHash(D);
    initData(readGame(), { keys });
    check('custom prices have a hash of their own (the server\'s price patch goes by it), none without custom content', h1 && h2 && h1 !== h2 && r.lock === r1.lock && CX.customPriceHash(D) === null);
    initData(readGame(), { keys, custom });
  }

  // ---- the command line ---------------------------------------------------------------------------------------------------------
  {
    const { spawnSync } = await import('node:child_process');
    const run = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-custom.mjs'), ...a], { cwd: ROOT, encoding: 'utf8' });
    const a = run('--src', 'docs/custom-example');
    check('the CLI builds only custom/ into the game: another folder is refused there (it would replace every custom item)', a.status === 1 && /only custom\/ is built into the game/.test(a.stdout) && !fs.existsSync(path.join(DATA, 'custom.json')));
    const b = run('--src', 'docs/custom-example', '--out', '%TEMP%\\cx-example');
    check('a path with a shell variable left in it is refused (PowerShell leaves %TEMP% as it is)', b.status === 1 && /variable your shell didn't fill in/.test(b.stdout) && !fs.existsSync(path.join(ROOT, '%TEMP%\\cx-example')));
    const c = run('--src', 'docs/custom-example', '--check');
    check('…while --check checks any folder, and says its whole data lock', c.status === 0 && new RegExp(`data lock would be ${readGame().generatedAt.replace(/[.]/g, '\\.')}\\+cx\\.${r1.lock}`).test(c.stdout), c.stdout.trim());
  }
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
