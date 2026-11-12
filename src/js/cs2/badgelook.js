// Badges in 3D, the parts without three.js (cs2/badge.js draws them; scripts/test-badge-models.mjs tests them): which badges
// show CS2's own model in the inspect, and how each of a model's materials draws, from CS2's parameters with their dynamic
// expressions worked out for the badge (a Premier Season medal's colour and filled bands).
import { evalExpression } from './expr.js';

// A badge's def index (its id is collectible-<def index>), or null.
export const badgeDefIndex = (id) => /^collectible-(\d+)$/.exec(String(id ?? ''))?.[1] ?? null;

// What a badge's inspect shows: 'cs2' (CS2's own model: the service found one, see CS2Service.badge) when the game is
// installed, else 'icon' (its picture made solid, as before there were models): CS2 not installed, or a badge it has no
// model for (passes, Souvenir Tokens, Stars).
export function badgeSource(status, info) {
  return status?.available && typeof info?.model === 'string' && info.model ? 'cs2' : 'icon';
}

// What CS2 fills into a badge's composite text ({s:<name>} in its layout, see CS2Service.badgeComposite), from the badge
// (`def`, its game data): a CS2 map coin's map, in capitals as CS2's coin shows it. A trophy's event, team and players
// CS2 reads from the trophy itself, which a badge here hasn't got: none.
export function badgeStrings(def) {
  const map = def?.ty === 'Map Contributor Coin' && /^(.+?)\s+Map Coin$/i.exec(String(def.n || ''))?.[1];
  return map ? { contributor_token_mapname: map.toUpperCase() } : {};
}

// A composite layout's labels with what CS2 fills in put in ({s:<name>} from `strings`), or null when one of them
// can't be (that text isn't drawn at all: half of it would be wrong).
export function fillLabels(labels, strings = {}) {
  if (!Array.isArray(labels) || !labels.length) return null;
  let missing = false;
  const out = labels.map((l) => ({ ...l, text: String(l?.text ?? '').replace(/\{[a-z]:(\w+)\}/g, (m, k) => {
    if (typeof strings[k] === 'string') return strings[k];
    missing = true;
    return '';
  }) }));
  return missing ? null : out;
}

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const vec = (v, d) => (Array.isArray(v) && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? v : d);
const clamp01 = (x) => Math.min(1, Math.max(0, x));

// How one material of a badge model draws (`mat` as CS2Service.badgeModel describes it, `attrs` the badge's attributes):
//   kind: 'unlit' (csgo_black_unlit: the black backing of a trophy), 'glass' (csgo_glass: a medal's cover, a crystal),
//     'effect' (csgo_effects: glowing, added to what's behind) or 'surface' (everything else: metal, enamel, paint).
//   tint: g_vColorTint (sRGB, [r, g, b]) or null for none; tintMasked: only where the tint mask says (F_TINT_MASK: a
//     Service Medal's colour on its enamel, not its metal).
//   alphaTest: CS2's alpha test reference (F_ALPHA_TEST) or null; hidden: nothing of it passes (an empty band).
//   translucent (F_TRANSLUCENT, opacity g_flOpacityScale) and additive (F_ADDITIVE_BLEND).
//   metalness: g_flMetalness, for a surface whose metal is that one value (no F_METALNESS_TEXTURE: a Major trophy's gold,
//     a CS2 map coin), or null (its metal is the export's texture). The export leaves those as no metal at all.
//   glass: roughness (its TextureRoughness), refract (F_OPAQUE_CUBEMAP_REFRACTION: opaque, showing the surroundings bent
//     through it, as a crystal), remap (g_flTranslucencyRemap: how see-through, from its dust's alpha), doubleSided.
// Expressions that read none of the badge's attributes (a flame's flicker) keep their compiled value.
export function badgeLook(mat, attrs = {}) {
  const ints = mat?.ints || {}, floats = { ...mat?.floats }, vectors = { ...mat?.vectors };
  for (const [k, src] of Object.entries(mat?.dynamic || {})) {
    if (typeof src !== 'string' || !/\$\w/.test(src)) continue;
    const v = evalExpression(src, attrs);
    if (v == null) continue;
    if (Array.isArray(v)) vectors[k] = v;
    else if (Array.isArray(vectors[k])) vectors[k] = vectors[k].map(() => v);
    else floats[k] = v;
  }
  const shader = String(mat?.shader || '');
  const kind = /black_unlit/.test(shader) ? 'unlit' : /csgo_glass/.test(shader) ? 'glass' : /csgo_effects/.test(shader) ? 'effect' : 'surface';
  const t = vec(vectors.g_vColorTint, null)?.slice(0, 3) || null;
  const tint = t && t.length === 3 && t.some((c) => Math.abs(c - 1) > 1e-3) ? t : null;
  const look = {
    kind, tint, tintMasked: !!(tint && ints.F_TINT_MASK && mat?.textures?.tint),
    alphaTest: null, hidden: false,
    translucent: !!ints.F_TRANSLUCENT || kind === 'effect', additive: !!ints.F_ADDITIVE_BLEND || kind === 'effect',
    opacity: clamp01(num(floats.g_flOpacityScale, 1)),
    metalness: kind === 'surface' && !ints.F_METALNESS_TEXTURE && typeof floats.g_flMetalness === 'number' ? clamp01(num(floats.g_flMetalness, 0)) : null,
  };
  if (ints.F_ALPHA_TEST) {
    const ref = num(floats.g_flAlphaTestReference, 0.5);
    look.alphaTest = clamp01(ref);
    look.hidden = ref >= 1;
  }
  if (kind === 'glass') {
    const r = vec(vectors.TextureRoughness, null);
    const remap = vec(vectors.g_flTranslucencyRemap, [0, 1]);
    Object.assign(look, {
      roughness: clamp01(r ? r[0] : num(floats.g_flRoughness, 0.05)), refract: !!ints.F_OPAQUE_CUBEMAP_REFRACTION,
      remap: [num(remap[0], 0), num(remap[1], 1)], doubleSided: !!ints.F_RENDER_BACKFACES,
    });
  }
  return look;
}
