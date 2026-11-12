// Badges in 3D, the parts that run in Node: which CS2 model each collectible is (cs2/badges.cjs, from items_game), the
// attributes a Premier Season medal's materials read, which inspect a badge gets (its CS2 model or its solid picture),
// how its materials draw (src/js/cs2/badgelook.js: tint, alpha test, glass, metal), the expressions read from the CLI's
// printed materials, and the text CS2 draws in (a CS2 map coin's composite layout). Not part of the five suites: run it
// on its own. With CS2 installed and items_game extracted (CS2SIM_ITEMS_GAME=<path>
// to items_game.txt) it also counts how many of the game's badges have a model in that install.
//   node scripts/test-badge-models.mjs
import fs from 'fs';
import { createRequire } from 'module';
import { badgeDefIndex, badgeSource, badgeLook, badgeStrings, fillLabels } from '../src/js/cs2/badgelook.js';

const require = createRequire(import.meta.url);
const { badgeModels, premierAttrs, dynamicParams, compositePanel, panoramaLabels, PREMIER_COLORS } = require('../cs2/badges.cjs');
const { parseKV1, parseKV3 } = require('../cs2/kv.cjs');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('FAIL', msg); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- the mapping from items_game ----------------------------------------------------------------------------------------
// As items_game.txt has them (parsed with the same reader), cut down: a coin with its model as a plain attribute, a trophy
// with it as { attribute_class, value }, pins and medals that get it from their prefab (one through a second prefab), a
// pass with none, a model the install hasn't got, Premier Season medals, and things that aren't models.
const IG = parseKV1(`"items_game"
{
  "prefabs"
  {
    "collectible_pin" { "prefab" "collectible_untradable" "attributes" { "pedestal display model" "models/inventory_items/pin_default.vmdl" } }
    "collectible_untradable" { "item_type_name" "#CSGO_Type_Collectible" }
    "medal_base" { "attributes" { "pedestal display model" { "attribute_class" "pedestal_display_model" "value" "models/inventory_items/medal_base.vmdl" } } }
    "medal_year" { "prefab" "medal_base" }
    "season_pass" { "prefab" "csgo_tool" }
    "premier_season_coin" { "attributes" { "premier season clrs max" "7" "premier season bars max" "5" } }
  }
  "items"
  {
    "874" { "name" "Five Year Service Coin" "attributes" { "pedestal display model" "models/inventory_items/5_year_coin.vmdl" } }
    "875" { "name" "DH2013 Champion" "attributes" { "pedestal display model" { "attribute_class" "pedestal_display_model" "value" "models/inventory_items/dreamhack_trophy_champion.vmdl" } "tournament event id" { "value" "1" } } }
    "6001" { "name" "Pin - Dust II" "prefab" "collectible_pin" "attributes" { "pedestal display model" "models/inventory_items/collectible_pin_dust2.vmdl" } }
    "6002" { "name" "Pin - default" "prefab" "collectible_pin" }
    "1339" { "name" "prestige coin 2016" "prefab" "valve medal_year" }
    "1000" { "name" "Payback Pass" "prefab" "season_pass" }
    "4999" { "name" "Missing" "attributes" { "pedestal display model" "models/inventory_items/not_in_this_install.vmdl" } }
    "5000" { "name" "premier s2 c3 b3" "prefab" "premier_season_coin" "attributes" { "premier season clrs" "3" "premier season bars" "3" "pedestal display model" "models/inventory_items/premier_seasons/premier_season_2_coin_eg.vmdl" } }
    "5001" { "name" "premier s2 c7 b5" "prefab" "premier_season_coin" "attributes" { "premier season clrs" "7" "premier season bars" "5" "pedestal display model" "models/inventory_items/premier_seasons/premier_season_2_coin_eg.vmdl" } }
    "4986" { "name" "premier s1" "attributes" { "pedestal display model" "models/inventory_items/premier_seasons/premier_season_1_coin_eg.vmdl" } }
    "7000" { "name" "Not a model" "attributes" { "pedestal display model" "materials/models/inventory_items/x.vmat" } }
    "7001" { "name" "Climbs out" "attributes" { "pedestal display model" "models/../../secret.vmdl" } }
    "default" { "name" "not an item id" "attributes" { "pedestal display model" "models/inventory_items/5_year_coin.vmdl" } }
  }
}`).items_game;
const INSTALL = new Set(['5_year_coin', 'dreamhack_trophy_champion', 'collectible_pin_dust2', 'pin_default', 'medal_base', 'premier_seasons/premier_season_2_coin_eg',
  'premier_seasons/premier_season_1_coin_eg', '../../secret'].map((m) => `models/inventory_items/${m}.vmdl_c`));
const map = badgeModels(IG, (f) => INSTALL.has(f));
ok(map['874']?.model === 'models/inventory_items/5_year_coin.vmdl', 'a coin: its model as a plain attribute');
ok(map['875']?.model === 'models/inventory_items/dreamhack_trophy_champion.vmdl', 'a trophy: its model as { attribute_class, value }');
ok(map['6001']?.model === 'models/inventory_items/collectible_pin_dust2.vmdl', "a pin's own model wins over its prefab's");
ok(map['6002']?.model === 'models/inventory_items/pin_default.vmdl', 'a pin without one of its own: its prefab’s');
ok(map['1339']?.model === 'models/inventory_items/medal_base.vmdl', 'a medal through its second prefab and that one’s own prefab');
ok(!('1000' in map), 'a pass has no model (it keeps its picture)');
ok(!('4999' in map), "a model this install hasn't got is left out");
ok(!('7000' in map) && !('7001' in map), "anything that isn't a model under models/ is left out");
ok(!('default' in map), 'only item ids (def indexes) are mapped');
ok(!map['874'].attrs && !map['6001'].attrs, 'ordinary badges carry no attributes');
ok(same(badgeModels({}, () => true), {}) && same(badgeModels(null), {}), 'an empty or missing items_game maps nothing');

// ---- a Premier Season medal's attributes ---------------------------------------------------------------------------------
const p3 = map['5000']?.attrs;
ok(p3 && same(p3.$PremierSeasonBand1Color, PREMIER_COLORS[3]) && same(p3.$PremierSeasonBand3Color, PREMIER_COLORS[3]), 'colour 3 (blue): its first three bands blue');
ok(p3 && same(p3.$PremierSeasonBand4Color, [0, 0, 0, 0]) && same(p3.$PremierSeasonBand5Color, [0, 0, 0, 0]), 'three bands: the other two empty');
ok(p3?.$PremierSeasonGold === 0, 'blue is not gold');
const p7 = map['5001']?.attrs;
ok(p7?.$PremierSeasonGold === 1 && same(p7.$PremierSeasonBand5Color, PREMIER_COLORS[7]), 'colour 7 is gold, all five bands');
ok(!map['4986']?.attrs, "Season One's medal (no colour or bands) has none");
ok(premierAttrs({ attributes: { 'premier season clrs': '9', 'premier season bars': '2' } }) === null, 'a colour past the table: none');
ok(same(PREMIER_COLORS[2].slice(0, 3), [0.54902, 0.77647, 1]), "CS2's palette: light blue second");

// ---- which inspect a badge gets -------------------------------------------------------------------------------------------
ok(badgeDefIndex('collectible-874') === '874' && badgeDefIndex('crate-4001') === null && badgeDefIndex('collectible-') === null && badgeDefIndex(undefined) === null, 'def index from a badge id');
const real = { model: 'cs2cache/badges/inventory_items/5_year_coin/5_year_coin.gltf' };
ok(badgeSource({ available: true }, real) === 'cs2', 'CS2 installed with a model: the real model');
ok(badgeSource({ available: false }, real) === 'icon', 'CS2 not installed: the solid picture');
ok(badgeSource({ available: true }, null) === 'icon', 'no model for it (a pass): the solid picture');
ok(badgeSource(null, null) === 'icon' && badgeSource({ available: true }, { model: '' }) === 'icon', 'nothing known: the solid picture');

// ---- how its materials draw -----------------------------------------------------------------------------------------------
// The Premier Season medal's bands, with their real expressions (as the decompiled materials have them).
const band = (n, gold) => ({
  shader: 'csgo_complex', ints: { F_ALPHA_TEST: 1, ...(gold ? { F_METALNESS_TEXTURE: 1 } : {}) }, floats: { g_flAlphaTestReference: 0.5 }, vectors: { g_vColorTint: [1, 1, 1, 0] },
  dynamic: gold ? { g_flAlphaTestReference: `return 1-$PremierSeasonBand${n}Color.w*$PremierSeasonGold.x;` }
    : { g_flAlphaTestReference: `return 1-$PremierSeasonBand${n}Color.w*(1-$PremierSeasonGold);`, g_vColorTint: `return $PremierSeasonBand${n}Color;` },
});
const b2 = badgeLook(band(2), p3), b4 = badgeLook(band(4), p3), g2 = badgeLook(band(2, true), p3);
ok(!b2.hidden && b2.alphaTest === 0 && same(b2.tint, PREMIER_COLORS[3].slice(0, 3)), 'a filled band shows, in its colour');
ok(b4.hidden && b4.alphaTest === 1, 'an empty band is hidden (the bare metal shows)');
ok(g2.hidden, "a blue medal's gold bands are hidden");
ok(badgeLook(band(1), p7).hidden && !badgeLook(band(1, true), p7).hidden, 'a gold medal shows its gold bands instead');
ok(badgeLook(band(1), {}).hidden, 'with no attributes at all no band shows (none filled)');
// A Service Medal's tint: only where its tint mask is, when there is one.
const medal = { shader: 'csgo_complex', ints: { F_TINT_MASK: 1 }, vectors: { g_vColorTint: [0.709804, 0.760784, 0.866667, 1] }, textures: { tint: 'cs2cache/files/mask.png' } };
ok(badgeLook(medal).tintMasked && same(badgeLook(medal).tint, [0.709804, 0.760784, 0.866667]), "a Service Medal's tint goes through its mask");
ok(!badgeLook({ ...medal, textures: {} }).tintMasked, 'without the mask the tint covers it all');
ok(badgeLook({ shader: 'csgo_vertexlitgeneric', vectors: { g_vColorTint: [1, 1, 1, 0] } }).tint === null, 'white is no tint');
ok(badgeLook({ shader: 'csgo_black_unlit' }).kind === 'unlit', "a trophy's black backing is unlit");
const crystal = badgeLook({ shader: 'csgo_glass', ints: { F_OPAQUE_CUBEMAP_REFRACTION: 1 }, vectors: { TextureRoughness: [0.054902, 0.054902, 0.054902, 0] } });
ok(crystal.kind === 'glass' && crystal.refract && Math.abs(crystal.roughness - 0.054902) < 1e-6, "a crystal: glass, refracting, CS2's roughness");
const cover = badgeLook({ shader: 'csgo_glass', ints: {}, vectors: { g_flTranslucencyRemap: [0, 1, 0, 0] } });
ok(cover.kind === 'glass' && !cover.refract && same(cover.remap, [0, 1]), "a medal's cover: see-through glass");
const shine = badgeLook({ shader: 'csgo_complex', ints: { F_TRANSLUCENT: 1, F_ADDITIVE_BLEND: 1 }, floats: { g_flOpacityScale: 1 } });
ok(shine.translucent && shine.additive && shine.opacity === 1, "a crystal's shine is added on");
const flame = badgeLook({ shader: 'csgo_effects', dynamic: { g_flColorBoost: 'return random(1.8,2.5);' } });
ok(flame.kind === 'effect' && flame.additive, 'a flame glows (its flicker, an expression of no attribute, keeps its compiled value)');
ok(badgeLook(null).kind === 'surface' && badgeLook(undefined, undefined).alphaTest === null, "a material the service didn't describe: the export's as it is");
// Metal as one value (g_flMetalness, no metal texture): the export leaves it out (its texture says no metal at all).
ok(badgeLook({ shader: 'csgo_simple', ints: {}, floats: { g_flMetalness: 1 } }).metalness === 1, "a CS2 map coin's metal (csgo_simple, g_flMetalness 1) is metal");
ok(badgeLook({ shader: 'csgo_complex', ints: { g_bFogEnabled: 1 }, floats: { g_flMetalness: 0.7 } }).metalness === 0.7, "a Katowice trophy's 0.7 stays 0.7");
ok(badgeLook({ shader: 'csgo_complex', ints: {}, floats: { g_flMetalness: 0 } }).metalness === 0, 'none is none');
ok(badgeLook({ shader: 'csgo_complex', ints: { F_METALNESS_TEXTURE: 1 }, floats: { g_flMetalness: 1 } }).metalness === null, 'with a metal texture, the texture says (as exported)');
ok(badgeLook({ shader: 'csgo_vertexlitgeneric', ints: {}, floats: {} }).metalness === null && badgeLook(null).metalness === null, 'no value: as exported');
ok(badgeLook({ shader: 'csgo_glass', ints: {}, floats: { g_flMetalness: 1 } }).metalness === null, 'glass is never metal');
ok(badgeLook({ shader: 'csgo_complex', ints: {}, floats: { g_flMetalness: 2 } }).metalness === 1, 'kept between none and all');

// ---- the expressions read from the CLI's printed materials -------------------------------------------------------------
const printed = [
  '--- models/inventory_items/premier_seasons/premier_season_coin.vmat',
  '"Layer0"', '{', '\t"shader"\t"csgo_complex.vfx"', '\t"g_flMetalness"\t"0"', '}', '',
  '--- models/inventory_items/premier_seasons/premier_season_coin_bar1.vmat',
  '"Layer0"', '{', '\t"shader"\t"csgo_complex.vfx"', '\t"F_ALPHA_TEST"\t"1"', '\t"DynamicParams"', '\t{',
  '\t\t"g_flAlphaTestReference"\t"return 1-$PremierSeasonBand1Color.w*(1-$PremierSeasonGold);"', '\t\t"g_vColorTint"\t"return $PremierSeasonBand1Color;"', '\t}', '}', '',
].join('\r\n');
const dp = dynamicParams(printed);
ok(dp.read === 2 && Object.keys(dp.dynamic).length === 1, 'two materials read, one with expressions');
ok(dp.dynamic['models/inventory_items/premier_seasons/premier_season_coin_bar1.vmat']?.g_vColorTint === 'return $PremierSeasonBand1Color;', 'a band’s colour expression, by its material path (CRLF output too)');
ok(same(badgeLook({ shader: 'csgo_complex', ints: { F_ALPHA_TEST: 1 }, floats: { g_flAlphaTestReference: 0.5 }, vectors: { g_vColorTint: [1, 1, 1, 0] },
  dynamic: dp.dynamic['models/inventory_items/premier_seasons/premier_season_coin_bar1.vmat'] }, p3).tint, PREMIER_COLORS[3].slice(0, 3)), 'and it colours the band');
ok(dynamicParams('').read === 0 && dynamicParams('Source2Viewer-CLI exited 1').read === 0 && dynamicParams(null).read === 0, 'nothing printed: nothing read (tried again next time)');

// ---- the text CS2 draws in (composite materials) ---------------------------------------------------------------------------
// A CS2 map coin's, as the CLI prints its .vcompmat and layout (cut down).
const VCOMPMAT = `--- models/inventory_items/cs2_maptokens/materials/cs2_maptoken.vcompmat
<!-- kv3 encoding:text:version{e21c7f3c-8a33-41c5-9977-a76d3a32aa0d} format:generic:version{7412167c-06e9-4698-aff2-e63eb59037e7} -->
{ _class = "CCompositeMaterialEditorDoc" m_Points = [ { m_vecCompositeMaterialAssemblyProcedures = [ {
  m_vecMatchFilters = [ { m_nCompositeMaterialMatchFilterType = "MATCH_FILTER_MATERIAL_NAME_SUBSTR" m_strMatchFilter = "_text" }, ]
  m_vecCompositeInputContainers = [
    { m_nCompositeMaterialInputContainerSourceType = "CONTAINER_SOURCE_TYPE_TARGET_MATERIAL" m_strAlias = "target" },
    { m_nCompositeMaterialInputContainerSourceType = "CONTAINER_SOURCE_TYPE_SPECIFIC_MATERIAL" m_strSpecificContainerMaterial = resource_name:"materials/dev/compositematerials_prewarm/composite_generic_prewarm.vmat" m_strAlias = "base" },
    { m_nCompositeMaterialInputContainerSourceType = "CONTAINER_SOURCE_TYPE_LOOSE_VARIABLES" m_strAlias = "panorama"
      m_vecLooseVariables = [ { m_strName = "text_panel" m_nVariableType = "LOOSE_VARIABLE_TYPE_PANORAMA_RENDER" m_strPanoramaPanelPath = "file://{resources}/layout/composite/cs2_maptoken.vxml" m_nPanoramaRenderRes = 1024 }, ] },
  ]
  m_vecPropertyMutators = [
    { m_nMutatorCommandType = "COMP_MAT_PROPERTY_MUTATOR_INIT" m_strInitWith_Container = "target" },
    { m_nMutatorCommandType = "COMP_MAT_PROPERTY_MUTATOR_GENERATE_TEXTURE" m_strGenerateTexture_TargetParam = "g_tColor" m_strGenerateTexture_InitialContainer = "base"
      m_vecTexGenInstructions = [ { m_nMutatorCommandType = "COMP_MAT_PROPERTY_MUTATOR_COPY_PROPERTY" m_strCopyProperty_InputContainerSrc = "panorama" m_strCopyProperty_InputContainerProperty = "text_panel" m_strCopyProperty_TargetProperty = "g_tTextureB" }, ] },
  ] }, ] }, ] }`;
const panel = compositePanel(parseKV3(VCOMPMAT));
ok(same(panel, { match: '_text', panel: 'panorama/layout/composite/cs2_maptoken.vxml', res: 1024 }), "a map coin's composite: its layout, drawn into its _text material's colour");
ok(compositePanel(parseKV3(VCOMPMAT.replace('file://{resources}/layout/composite/cs2_maptoken.vxml', 'file://{resources}/../../secret.vxml'))) === null, 'a layout outside panorama/layout is left alone');
ok(compositePanel(parseKV3(VCOMPMAT.replace('"g_tColor"', '"g_tNormal"'))) === null, 'only a layout drawn into the colour counts');
ok(compositePanel(null) === null && compositePanel({}) === null, 'no composite: none');
const XML = `--- panorama/layout/composite/cs2_maptoken.xml
<root>
	<Panel class="full-width">
		<Label class="MonoNumbersFont text-letterspace-1px" style="     font-size: 110;     blur: gaussian( 1, 1, 1 );     wash-color: #FFFFFF;     text-align: center;     width: 100%;     margin-top: 1%;     text-shadow: 0px 0px 2px 3.0 #000000;     " text="CS2 CONTRIBUTOR\\n{s:contributor_token_mapname}" />
		<Label style="font-size: 40px; wash-color: #f5dd2a; margin-bottom: 16px;" text="A &amp; B • {s:x}" />
	</Panel>
</root>`;
const labels = panoramaLabels(XML, 1024);
ok(labels.length === 2 && labels[0].text === 'CS2 CONTRIBUTOR\n{s:contributor_token_mapname}' && labels[0].size === 110 && labels[0].align === 'center', "the coin's label: two lines, centred, its size");
ok(Math.abs(labels[0].marginTop - 10.24) < 1e-9 && labels[0].spacing === 1 && labels[0].color === '#FFFFFF' && same(labels[0].shadow, { x: 0, y: 0, blur: 2, strength: 3, color: '#000000' }), 'its margin (1% of the layout), letter spacing (its class), colour and shadow');
ok(labels[1].text === 'A & B • {s:x}' && labels[1].size === 40 && labels[1].marginBottom === 16 && labels[1].align === 'left' && labels[1].shadow === null, 'entities, px sizes, and the defaults');
ok(panoramaLabels('').length === 0 && panoramaLabels(null).length === 0, 'no layout: no labels');
const coinDef = { id: 'collectible-4941', n: 'Thera Map Coin', ty: 'Map Contributor Coin' };
ok(same(badgeStrings(coinDef), { contributor_token_mapname: 'THERA' }) && badgeStrings({ n: 'Pool Day Map Coin', ty: 'Map Contributor Coin' }).contributor_token_mapname === 'POOL DAY', "a CS2 map coin's map, in capitals as CS2's shows it");
ok(same(badgeStrings({ n: 'Champion at PGL Copenhagen 2024', ty: 'Tournament Finalist Trophy' }), {}) && same(badgeStrings(undefined), {}), "a trophy's event, team and players: not known here");
const filled = fillLabels(labels.slice(0, 1), badgeStrings(coinDef));
ok(filled?.[0].text === 'CS2 CONTRIBUTOR\nTHERA' && labels[0].text.includes('{s:'), 'the map filled in (the layout itself unchanged)');
ok(fillLabels(labels, badgeStrings(coinDef)) === null, 'anything it can’t fill in: no text at all (a trophy keeps its blank plate)');
ok(fillLabels([], {}) === null && fillLabels(null, {}) === null, 'no labels: nothing to draw');

// ---- this install ---------------------------------------------------------------------------------------------------------
const igFile = process.env.CS2SIM_ITEMS_GAME;
if (igFile && fs.existsSync(igFile)) {
  const ig = parseKV1(fs.readFileSync(igFile, 'utf8')).items_game;
  const all = badgeModels(ig);
  const badges = Object.values(JSON.parse(fs.readFileSync(new URL('../src/data/badges.json', import.meta.url), 'utf8')).badges);
  const by = {};
  for (const d of badges) { const e = (by[d.ty] ||= [0, 0]); e[1]++; if (all[badgeDefIndex(d.id)]) e[0]++; }
  console.log('items_game models (files not checked):', Object.entries(by).map(([k, [m, n]]) => `${k} ${m}/${n}`).join(', '));
  ok(badges.filter((d) => all[badgeDefIndex(d.id)]).length > badges.length / 2, 'most badges have a model in items_game');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
