// Badges in 3D: which of CS2's models each collectible is (its "pedestal display model", the model CS2's own inventory
// inspect shows: the coin, medal, pin or trophy), read from the player's items_game.txt, and the attributes its materials
// read. Pure (no files, no CLI): CS2Service.badgeModels() feeds it the parsed items_game and the install's file list.
//
// A collectible's model is the "pedestal display model" attribute of its item (by def index: a badge's id is
// collectible-<def index>), or of the prefabs it's made from. Passes, Souvenir Tokens and Stars have none (CS2 shows them
// as their picture), and a model the install hasn't got is left out: those badges keep the inspect's solid picture.

const { parseKV1 } = require('./kv.cjs');

const ATTR = 'pedestal display model';
const VMDL = /^models\/[\w./-]+\.vmdl$/i;

// An attribute's value as items_game writes it: a string, or { attribute_class, value }.
const attrValue = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' && typeof v.value === 'string' ? v.value : null);

// An item's attribute, looked for on the item, then its prefabs (in the order it lists them, each with its own prefabs).
function findAttr(item, name, prefabs, seen = new Set()) {
  if (!item || typeof item !== 'object') return null;
  const own = attrValue(item.attributes?.[name]);
  if (own != null) return own;
  for (const p of String(item.prefab || '').split(/\s+/).filter(Boolean)) {
    if (seen.has(p) || !Object.hasOwn(prefabs, p)) continue;
    seen.add(p);
    const v = findAttr(prefabs[p], name, prefabs, seen);
    if (v != null) return v;
  }
  return null;
}

// CS Rating's colours, as CS2's Premier Season medals show them (client.dll's table for $PremierSeasonBand<n>Color:
// none, then grey, light blue, blue, purple, pink, red and gold), RGBA.
const PREMIER_COLORS = [[0, 0, 0, 0], [0.76863, 0.81569, 0.87451, 1], [0.54902, 0.77647, 1, 1], [0.41569, 0.4902, 1, 1],
  [0.75686, 0.4, 1, 1], [0.94118, 0.23529, 1, 1], [0.92157, 0.29412, 0.29412, 1], [1, 0.84314, 0, 1]];
const PREMIER_BANDS = 5;

// What a Premier Season medal's materials read, from its item's "premier season clrs" (its colour, 1 to 7: the best CS
// Rating reached) and "premier season bars" (how many of its five bands are filled). Its icon is named for the two
// (premier_season_2_coin_33: blue, three bands). Each filled band ($PremierSeasonBand<n>Color, its alpha 1) is that
// colour, the rest empty (alpha 0: the medal's bare metal shows); gold ($PremierSeasonGold) fills them with the gold
// bands instead. Null for an item that isn't one (or Season One's, which has neither).
function premierAttrs(item, prefabs = {}) {
  const c = Number(findAttr(item, 'premier season clrs', prefabs)), b = Number(findAttr(item, 'premier season bars', prefabs));
  if (!Number.isInteger(c) || !Number.isInteger(b) || c < 1 || c >= PREMIER_COLORS.length || b < 0) return null;
  const out = { $PremierSeasonGold: c === PREMIER_COLORS.length - 1 ? 1 : 0 };
  for (let n = 1; n <= PREMIER_BANDS; n++) out[`$PremierSeasonBand${n}Color`] = n <= b ? [...PREMIER_COLORS[c]] : [0, 0, 0, 0];
  return out;
}

// Every item with a display model: { def index: { model (VPK path of the .vmdl), attrs? (what its materials read) } }.
// `ig` is items_game as parseKV1 reads it; `has(vpkPath)` says whether the install has a file (models whose .vmdl_c
// it hasn't got are left out).
function badgeModels(ig, has = () => true) {
  const items = Object.assign({}, ...[].concat(ig?.items || []));
  const prefabs = Object.assign({}, ...[].concat(ig?.prefabs || []));
  const out = {};
  for (const [id, item] of Object.entries(items)) {
    if (!/^\d+$/.test(id)) continue;
    const model = findAttr(item, ATTR, prefabs);
    if (!model || !VMDL.test(model) || model.includes('..')) continue;
    const vmdl = model.replace(/\\/g, '/');
    if (!has(vmdl + '_c')) continue;
    const attrs = premierAttrs(item, prefabs);
    out[id] = attrs ? { model: vmdl, attrs } : { model: vmdl };
  }
  return out;
}

// The dynamic expressions in materials the CLI printed decompiled (`-d -o -`: "--- <path>" and the material, for each),
// { vmat path: { parameter: expression } }; `read` counts the materials it could read (none: the output wasn't that).
function dynamicParams(text) {
  const out = {};
  let read = 0;
  for (const part of String(text || '').split(/^--- (?=\S+\.vmat\r?$)/m).slice(1)) {
    const nl = part.indexOf('\n');
    try {
      const layer = Object.values(parseKV1(part.slice(nl + 1)))[0];
      if (!layer || typeof layer !== 'object') continue;
      read++;
      if (layer.DynamicParams && typeof layer.DynamicParams === 'object') out[part.slice(0, nl).trim().replace(/\\/g, '/')] = layer.DynamicParams;
    } catch {}
  }
  return { dynamic: out, read };
}

// A composite material's (.vcompmat, as parseKV3 reads it) Panorama layout drawn into a material's colour as CS2 shows
// the item (a CS2 map coin's "CS2 CONTRIBUTOR" and map name, the export can't carry it): { match (the materials it's for:
// names containing it), panel (the layout's VPK path), res (its size in pixels) }, or null when it has none.
function compositePanel(doc) {
  const list = (v) => [].concat(v || []);
  for (const point of list(doc?.m_Points)) {
    for (const proc of list(point?.m_vecCompositeMaterialAssemblyProcedures)) {
      const filter = list(proc?.m_vecMatchFilters).find((f) => f?.m_nCompositeMaterialMatchFilterType === 'MATCH_FILTER_MATERIAL_NAME_SUBSTR' && f.m_strMatchFilter);
      let panel = null;
      for (const c of list(proc?.m_vecCompositeInputContainers)) {
        for (const v of list(c?.m_vecLooseVariables)) {
          if (v?.m_nVariableType === 'LOOSE_VARIABLE_TYPE_PANORAMA_RENDER') panel = { alias: c.m_strAlias, name: v.m_strName, path: v.m_strPanoramaPanelPath, res: v.m_nPanoramaRenderRes };
        }
      }
      if (!filter || !panel) continue;
      // (Into the colour: g_tColor made with the layout copied in.)
      const intoColor = list(proc.m_vecPropertyMutators).some((m) => m?.m_strGenerateTexture_TargetParam === 'g_tColor'
        && list(m.m_vecTexGenInstructions).some((t) => t?.m_strCopyProperty_InputContainerSrc === panel.alias && t?.m_strCopyProperty_InputContainerProperty === panel.name));
      const p = /^file:\/\/\{resources\}\/(layout\/[\w./-]+\.vxml)$/.exec(String(panel.path || ''));
      if (!intoColor || !p || p[1].includes('..')) continue;
      const res = Number(panel.res);
      return { match: String(filter.m_strMatchFilter), panel: 'panorama/' + p[1], res: Number.isInteger(res) && res >= 64 && res <= 4096 ? res : 1024 };
    }
  }
  return null;
}

// The labels of a Panorama layout (the CLI prints it as XML), top to bottom, in the layout's pixels (`res` square):
// { text ("\n" a new line, {s:name} what CS2 fills in), size, color, spacing, marginTop, marginBottom, align, shadow:
// { x, y, blur, strength, color } or null }.
function panoramaLabels(xml, res = 1024) {
  const out = [];
  const unescape = (s) => s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e.toLowerCase()]
    ?? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)));
  const len = (v, d) => {
    const m = /^(-?[\d.]+)\s*(px|%)?$/.exec(String(v ?? '').trim());
    if (!m || !Number.isFinite(+m[1])) return d;
    return m[2] === '%' ? (+m[1] / 100) * res : +m[1];
  };
  const color = (v) => (/^#[\da-f]{6}([\da-f]{2})?$/i.test(String(v || '').trim()) ? String(v).trim().slice(0, 7) : null);
  for (const m of String(xml || '').matchAll(/<Label\b([^>]*?)\/?>/g)) {
    const attr = (k) => { const a = new RegExp(`\\s${k}="([^"]*)"`).exec(m[1]); return a ? unescape(a[1]) : null; };
    const text = attr('text');
    if (text == null) continue;
    const style = {};
    for (const decl of String(attr('style') || '').split(';')) {
      const i = decl.indexOf(':');
      if (i > 0) style[decl.slice(0, i).trim().toLowerCase()] = decl.slice(i + 1).trim();
    }
    const cls = String(attr('class') || '');
    const sh = /^(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px\s+([\d.]+)\s+(#[\da-f]{6,8})$/i.exec(style['text-shadow'] || '');
    const align = /^(left|right|center)$/i.test(style['text-align'] || '') ? style['text-align'].toLowerCase() : 'left';
    out.push({
      text: text.replace(/\\n/g, '\n'), size: Math.max(1, len(style['font-size'], 18)), color: color(style['wash-color']) || color(style.color) || '#ffffff',
      spacing: len(style['letter-spacing'], Number(/\btext-letterspace-(\d+)px\b/.exec(cls)?.[1] || 0)),
      marginTop: len(style['margin-top'], 0), marginBottom: len(style['margin-bottom'], 0), align,
      shadow: sh ? { x: +sh[1], y: +sh[2], blur: +sh[3], strength: +sh[4], color: sh[5].slice(0, 7) } : null,
    });
  }
  return out;
}

module.exports = { badgeModels, premierAttrs, dynamicParams, compositePanel, panoramaLabels, PREMIER_COLORS };
