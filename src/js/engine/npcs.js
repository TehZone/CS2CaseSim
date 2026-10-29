// NPC players, offline only (online, the people you trade with are real). A crowd of made-up CS2 players, each with an
// inventory, a wallet and a way of trading:
//   players     buy on the market, swap skins at about market price and lowball a little;
//   collectors  chase one kind of item (Dopplers, blue gems, low floats, #1 serials, old Major stickers...) and pay well
//               over market for the right one (the better it fits, the more), but part with their collection dearly.
// They message you when you own something they want, with cash or trade offers you can accept, decline or haggle over
// (a price, and arguments for it: its float, pattern, stickers, serial, the market price, another buyer...); they buy
// from the market's stock; some are your friends and chat. Who they are comes from the save's seed; what they own,
// their money, your chats and offers are kept in the save (state.social).
//
// The first 36 are the active ones, who message you and buy on the market; a few hundred more are the rest of the
// community: they only own things (the Item Database's owners, offline), and you can visit them, add them and trade.
import { D, wearOf, WEAR_BY_KEY } from './data.js';
import * as I from './items.js';
import * as MK from './market.js';
import { mulberry32, hashStr, pick, pickWeighted, round2, clamp, uid } from './util.js';

export const CROWD = 36, COLLECTORS = 12, WORLD = 420;
const MIN = 60 * 1000;

// ---- who they are -------------------------------------------------------------------------------------------------------
const WORD_A = ['Shadow', 'Frag', 'Silent', 'Toxic', 'Lucky', 'Crazy', 'Cold', 'Dark', 'Swift', 'Sneaky', 'Salty', 'Rapid', 'Lazy', 'Mad', 'Ghost', 'Neon',
  'Pixel', 'Turbo', 'Hyper', 'Iron', 'Tilted', 'Clutch', 'Spray', 'Flick', 'Eco', 'Rush', 'Baited', 'Smurf', 'Silver', 'Frosty', 'Wild', 'Sleepy'];
const WORD_B = ['Wolf', 'Hunter', 'King', 'Sniper', 'Fox', 'Dragon', 'Viper', 'Ninja', 'Tiger', 'Beast', 'Rat', 'Panda', 'Lord', 'Kid', 'Goose', 'Monk',
  'Bot', 'Duck', 'Pigeon', 'Raven', 'Cobra', 'Reaper', 'Taco', 'Potato', 'Llama', 'Gremlin', 'Bandit', 'Ace', 'Owl', 'Shark', 'Moose', 'Yeti'];
const HANDLES = ['kryptic', 'zyphr', 'N1ghtm4re', 'v0id', 'sp1ke', 'mirage_enjoyer', 'dust2only', 'awpdaddy', 'headshot.exe', 'bhop_god', 'smokecriminal',
  'lurk3r', 'oneTap', 'peekaboo', 'rushB', 'nadeking', 'jumpthrow', 'deagle_diff', 'karambit_kid', 'ecoFrag', 'tapTapBoom', 'flashbang_victim', 'ctspawn',
  'pistol_round', 'boost_me', 'anubis_hater', 'vertigo_main', 'molly_lineup', 'sh0ckwave', 'xanthos', 'mellow', 'Ruby_hunter', 'gemfinder', 'floatking'];
const COUNTRIES = ['US', 'DE', 'SE', 'DK', 'FR', 'PL', 'BR', 'UA', 'GB', 'CA', 'AU', 'FI', 'NO', 'NL', 'ES', 'CZ', 'TR', 'KZ', 'PT', 'RO', 'HU', 'AR', 'LV', 'IL'];
export const flagOf = (cc) => (cc ? String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '');
const FAV_GUNS = ['AK-47', 'M4A4', 'M4A1-S', 'AWP', 'USP-S', 'Glock-18', 'Desert Eagle', 'MP9', 'Galil AR', 'FAMAS', 'P250', 'MAC-10'];

// What each kind of collector chases: how well an item fits (0 = not at all, 1 = right up their alley, more for a
// grail), and items for their own collection.
const OLD_MAJOR = /2014|Katowice 2015|Cologne 2015/;
const skinOf = (it) => (it.t === 'skin' ? I.itemDef(it) : null);
export const FOCUS = {
  doppler: { n: 'Doppler collector', bio: 'Every phase, every knife. Ruby / Sapphire / Black Pearl / Emerald over everything.',
    fit: (it, d = skinOf(it)) => (d?.ph ? (/Ruby|Sapphire|Black Pearl|Emerald/.test(d.ph) ? 1.3 : 0.7) : 0), pool: (s) => !!s.ph },
  bluegem: { n: 'Blue gem hunter', bio: 'Case Hardened only. Show me your blue.',
    fit: (it, d = skinOf(it)) => (d?.fin === 'Case Hardened' ? ({ t0: 2, t1: 1.4, t2: 1, t3: 0.7 }[I.patternInfo(it).tier] ?? 0.3) : 0), pool: (s) => s.fin === 'Case Hardened' },
  fade: { n: 'Fade collector', bio: 'Full fades and nothing less.',
    fit: (it, d = skinOf(it)) => (/Fade/.test(d?.fin || '') ? (I.patternInfo(it).mult > 1 ? 1.2 : 0.5) : 0), pool: (s) => /Fade/.test(s.fin || '') },
  lowfloat: { n: 'Low float collector', bio: '0.00x or bust. Float is everything.',
    fit: (it) => (it.t === 'skin' && it.fl != null ? (it.fl < 0.001 ? 1.6 : it.fl < 0.01 ? 1 : I.floatMultiplier(it) > 1 ? 0.6 : 0) : 0), pool: (s) => !s.v && s.mn < 0.01 },
  serial: { n: 'Serial number collector', bio: 'Low serials, #1s and funny numbers.',
    fit: (it) => (it.sn ? (it.sn === 1 ? 1.8 : it.sn <= 10 ? 1.2 : it.sn <= 100 ? 0.7 : I.isSpecialSerial(it.sn) ? 0.6 : 0) : 0), pool: (s) => !s.star && s.r >= 3 },
  stickers: { n: 'Sticker craft collector', bio: 'Katowice 2014 crafts. Holos on AKs.',
    fit: (it) => (it.t === 'sticker' ? (OLD_MAJOR.test(I.itemDef(it)?.t || '') ? 1 : 0)
      : it.t === 'skin' && (it.stk || []).some((s) => !s.sv && OLD_MAJOR.test(D.stickers[s.id]?.t || '')) ? 1.2 : 0), pool: (s) => ['AK-47', 'M4A4', 'AWP', 'M4A1-S'].includes(s.w) },
  souvenir: { n: 'Souvenir collector', bio: 'Major history on my guns. Souvenirs only.', fit: (it) => (it.sv ? 1 : 0), pool: () => false },
  stattrak: { n: 'StatTrak™ knife collector', bio: 'Kills on the counter, star on the knife.',
    fit: (it, d = skinOf(it)) => (it.stt ? (d?.star ? 1.1 : 0.4) : 0), pool: (s) => s.star && s.cat === 'knife' && s.stt },
  awp: { n: 'AWP collector', bio: 'One shot, one kill. AWP skins only.', fit: (it, d = skinOf(it)) => (d?.w === 'AWP' ? (I.itemValue(it) > 100 ? 1 : 0.5) : 0), pool: (s) => s.w === 'AWP' },
  gloves: { n: 'Glove collector', bio: 'Hands tell the story.', fit: (it, d = skinOf(it)) => (d?.cat === 'gloves' ? 0.9 : 0), pool: (s) => s.cat === 'gloves' },
  charms: { n: 'Charm collector', bio: 'Low patterns, cute charms.',
    fit: (it) => (it.t === 'charm' ? (I.patternInfo(it).mult > 1 ? 1.3 : 0.5) : 0), pool: () => false },
  knives: { n: 'Knife collector', bio: 'A knife for every day of the week.', fit: (it, d = skinOf(it)) => (d?.cat === 'knife' ? 0.8 : 0), pool: (s) => s.cat === 'knife' },
};
const FOCI = Object.keys(FOCUS);

const BIOS = ['just here for the skins', 'premier grinder | no scams pls', 'add me for trades, no lowballs', 'silver forever', 'eco round enjoyer',
  'trading daily, fair offers only', 'I peek with my ears', 'rifler. sometimes awper.', 'collecting slowly', 'gl hf', 'faceit lvl 10 (trust)', 'don\'t ask about my k/d'];

const crowds = new Map();
// The save's crowd: [{ id, name, type: 'player' | 'collector', focus, country, avatar, joined, level, medals, bio, g (how
// close to market they pay), premium (a collector's extra for their focus), patience (counters before they walk away) }].
export function crowd(seed) {
  if (crowds.has(seed)) return crowds.get(seed);
  const r = mulberry32(seed >>> 0);
  const names = new Set();
  const nameFor = () => {
    for (;;) {
      const a = pick(WORD_A, r), b = pick(WORD_B, r), k = r();
      let n = k < 0.3 ? pick(HANDLES, r) : k < 0.5 ? `${a}${b}` : k < 0.65 ? `${a.toLowerCase()}_${b.toLowerCase()}` : k < 0.8 ? `${a}${b}${1 + Math.floor(r() * 99)}` : `x${a}${b}x`;
      if (r() < 0.15) n = n.replace(/o/g, '0').replace(/e/g, '3');
      if (!names.has(n)) { names.add(n); return n; }
    }
  };
  const agents = Object.values(D.agents).map((a) => a.id).sort();
  const foci = [...FOCI];
  const list = [];
  for (let i = 0; i < WORLD; i++) {
    const active = i < CROWD;
    const collector = active ? i % 3 === 2 && foci.length && list.filter((n) => n.type === 'collector').length < COLLECTORS : r() < 0.15;
    const focus = !collector ? null : active ? foci.splice(Math.floor(r() * foci.length), 1)[0] : pick(FOCI, r);
    const name = nameFor();
    list.push({
      id: 'n' + i, name, type: collector ? 'collector' : 'player', focus, active,
      country: pick(COUNTRIES, r), avatar: agents.length ? pick(agents, r) : null, joined: 2012 + Math.floor(r() * 13),
      level: 1 + Math.floor(r() * 40), medals: Math.floor(r() * (collector ? 30 : 12)),
      bio: collector ? FOCUS[focus].bio : pick(BIOS, r), fav: pick(FAV_GUNS, r),
      g: collector ? 0.9 + r() * 0.1 : 0.82 + r() * 0.2, premium: collector ? 0.25 + r() * 0.5 : 0.1 + r() * 0.15,
      patience: 2 + Math.floor(r() * 3), sharp: collector ? 0.7 : 0.35 + r() * 0.2, // how likely they see through a bluff
    });
  }
  crowds.set(seed, list);
  return list;
}
export const npcOf = (seed, id) => (/^n\d+$/.test(id) ? crowd(seed)[+id.slice(1)] || null : null);
// The 36 who message you, buy on the market and send friend requests.
export const activeCrowd = (seed) => crowd(seed).slice(0, CROWD);

// Online status, like Steam's: from the hour of the day and who they are (no state: the same for everyone, all day).
export function presence(npc, now = Date.now()) {
  const h = Math.floor(now / (20 * MIN));
  const x = mulberry32(hashStr(npc.id + ':' + h))();
  if (x < 0.25) return { s: 'ingame', label: pick(['In-Game · Counter-Strike 2', 'In-Game · Premier', 'In-Game · Competitive · Mirage', 'In-Game · Deathmatch'], mulberry32(h)) };
  if (x < 0.55) return { s: 'online', label: 'Online' };
  if (x < 0.65) return { s: 'away', label: 'Away' };
  return { s: 'offline', label: `Last online ${1 + Math.floor(x * 20)} hrs ago` };
}

// ---- what things are worth to them --------------------------------------------------------------------------------------
// How much an NPC wants an item (0 = not interested at that price).
export function interest(npc, it) {
  if (npc.type === 'collector') return FOCUS[npc.focus].fit(it);
  const d = skinOf(it);
  if (!d) return it.t === 'charm' || it.t === 'agent' ? 0.05 : 0;
  return (d.w === npc.fav ? 0.25 : 0.1) + (d.star ? 0.1 : 0);
}
// The most they'd pay for an item: market value, more for a collector's kind of item.
export function buyValue(npc, it) {
  const v = I.itemValue(it), k = interest(npc, it);
  if (npc.type === 'collector') return round2(v * (k ? 1 + npc.premium * k : 0.85));
  return round2(v * (k ? npc.g + 0.25 * k : 0.75));
}
// What one of their own items is worth to them when they trade it away (a collector's focus items, a lot more).
export function keepValue(npc, it) {
  const v = I.itemValue(it), k = npc.type === 'collector' ? FOCUS[npc.focus].fit(it) : 0;
  return round2(v * (k ? 1.1 + npc.premium * k : npc.type === 'collector' ? 1 : 1.04));
}
// Prices people actually say: $1,240 not $1,237.18.
export function nice(x) {
  if (x >= 1000) return Math.round(x / 10) * 10;
  if (x >= 100) return Math.round(x / 5) * 5;
  if (x >= 20) return Math.round(x);
  return round2(x);
}

// ---- their own inventories and money --------------------------------------------------------------------------------------
const lowest = (s) => (s.v ? s.p.V[0] : Math.min(...Object.values(s.p).map((r) => r[0] ?? Infinity)));
// Every skin (by its cheapest price, for picking within a budget) and each collector's kind, worked out once.
let skinIndex = null;
function index() {
  if (skinIndex?.data === D.generatedAt) return skinIndex;
  const list = Object.values(D.skins).filter((s) => s.cat !== 'equipment' && Number.isFinite(lowest(s))).map((s) => ({ s, p: lowest(s) })).sort((a, b) => a.p - b.p);
  skinIndex = { data: D.generatedAt, list: list.map((x) => x.s), all: list, plain: list.filter((x) => !x.s.star), pools: {},
    old: Object.values(D.stickers).filter((x) => OLD_MAJOR.test(x.t || '') && x.p > 0), souvenirs: D.cases.filter((c) => c.kind === 'souvenir' && c.pools) };
  for (const f of FOCI) skinIndex.pools[f] = skinIndex.list.filter(FOCUS[f].pool);
  return skinIndex;
}
const skins = () => index().list;
// A random skin costing at most cap (from the cheapest listed price): null if none is that cheap.
function skinUnder(list, cap, r) {
  let lo = 0, hi = list.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (list[m].p <= cap) lo = m + 1; else hi = m; }
  return lo ? list[Math.floor(r() * lo)].s : null;
}
function focusItem(focus, r) {
  const X = index();
  if (focus === 'souvenir') return X.souvenirs.length ? I.rollFromCase(pick(X.souvenirs, r), r) : null;
  if (focus === 'charms') { const cs = Object.values(D.charms); return cs.length ? I.makeCharmItem(pick(cs, r), { src: 'Collection', r }) : null; }
  if (focus === 'stickers' && r() < 0.4 && X.old.length) return I.makeStickerItem(pick(X.old, r), 'Collection');
  const pool = X.pools[focus];
  if (!pool.length) return null;
  const s = pick(pool, r);
  const it = I.makeSkinItem(s, { r, src: 'Collection', ...(focus === 'stattrak' ? { stt: true } : {}) });
  if (focus === 'lowfloat' && it.fl != null) it.fl = Math.fround(s.mn + r() * 0.008);
  if (focus === 'serial') it.sn = r() < 0.2 ? 1 : 1 + Math.floor(Math.pow(r(), 2) * 100);
  if (focus === 'stickers' && it.t === 'skin' && X.old.length) {
    const n = 2 + Math.floor(r() * 3), one = r() < 0.4 ? pick(X.old, r) : null;
    it.stk = Array.from({ length: n }, (_, i) => ({ id: (one || pick(X.old, r)).id, x: 0.2 + i * 0.16, y: 0.42, r: 0, wr: 0 }));
  }
  return it;
}
// An NPC's starting money and inventory (seeded: the same NPC in the same save starts the same).
export function startingState(seed, npc) {
  const r = mulberry32(hashStr(seed + ':' + npc.id));
  const tier = npc.type === 'collector' ? 3 : pickWeighted([[0, 0.45], [1, 0.38], [2, 0.17]], r);
  // Players from a few dollars to a few thousand; collectors are the whales (spread evenly in orders of magnitude).
  const [worth, cash] = [[[40, 400], [20, 200]], [[400, 3000], [100, 1200]], [[3000, 30000], [800, 8000]], [[10000, 250000], [10000, 400000]]][tier];
  const span = ([a, b]) => (tier === 3 ? Math.exp(Math.log(a) + r() * (Math.log(b) - Math.log(a))) : a + r() * (b - a));
  const target = span(worth);
  const inv = [];
  let total = 0;
  for (let k = 0; k < 60 && total < target && inv.length < 34; k++) {
    let it = null;
    if (npc.type === 'collector' && r() < 0.65) it = focusItem(npc.focus, r);
    if (!it) {
      const cap = Math.max(1, (target - total) * (r() < 0.2 ? 1 : 0.35));
      const s = skinUnder(tier >= 2 ? index().all : index().plain, cap, r);
      if (!s) break;
      it = I.makeSkinItem(s, { r, src: 'Trade' });
    }
    it.at = 0;
    inv.push(it);
    total += I.itemValue(it);
  }
  return { money: round2(span(cash)), inv, friend: 0, mood: 0.7, trades: 0, tier };
}

// ---- the save's NPC state ---------------------------------------------------------------------------------------------------
// state.social: { seed, at (last tick), npcs: { id: { money, inv, friend, mood, trades, tier } }, threads: { id: [msg] },
// offers: [offer], unread: { id: n }, feed: [{ at, npc, text }], me: your profile, comments: [{ at, npc, text }] }.
// friend: 0 none, 1 friends, 2 they sent you a request, 3 you sent them one.
export function freshSocial(seed, now = Date.now()) {
  const so = { seed, at: now, npcs: {}, threads: {}, offers: [], unread: {}, feed: [], comments: [], me: freshPersona() };
  // A few friends to start with (players you've played with).
  for (const n of activeCrowd(seed).filter((x) => x.type === 'player').slice(0, 3)) npcState(so, n.id).friend = 1;
  return so;
}
export const freshPersona = () => ({ name: '', avatar: null, bio: '', country: '', showcase: [], bg: null });
export function npcState(so, id) {
  if (!so.npcs[id]) so.npcs[id] = startingState(so.seed, npcOf(so.seed, id));
  return so.npcs[id];
}

// What someone owns: as the save has it once you've dealt with them, else as they start (worked out once a session:
// it doesn't change until you deal with them). worldCopies: everything everyone owns, for the Item Database offline:
// [{ npc, owner, item }].
const starts = new Map();
export function inventoryOf(so, n) {
  if (so.npcs[n.id]) return so.npcs[n.id].inv;
  let gen = starts.get(so.seed);
  if (!gen || gen.data !== D.generatedAt) starts.set(so.seed, (gen = { data: D.generatedAt, inv: new Map() }));
  if (!gen.inv.has(n.id)) gen.inv.set(n.id, startingState(so.seed, n).inv.map((it, k) => ({ ...it, uid: `${n.id}:${k}` })));
  return gen.inv.get(n.id);
}
export function worldCopies(so) {
  if (!so) return [];
  const out = [];
  for (const n of crowd(so.seed)) for (const item of inventoryOf(so, n)) out.push({ npc: n.id, owner: n.name, item });
  return out;
}

// What they play with in Play (they're the bots offline, see play/identity.js): for each gun the best skin they own
// for it, and their best knife and gloves, as if they'd equipped them. { guns: { weapon_ak47: item, ... }, knife, gloves }
// (null when they own none).
export function loadoutOf(inv) {
  const out = { guns: {}, knife: null, gloves: null }, worth = new Map();
  const better = (cur, it) => {
    if (!worth.has(it)) worth.set(it, I.itemValue(it));
    return !cur || worth.get(it) > worth.get(cur) ? it : cur;
  };
  for (const it of inv) {
    const def = it.t === 'skin' ? I.itemDef(it) : null;
    if (!def?.wid) continue;
    if (def.cat === 'knife') out.knife = better(out.knife, it);
    else if (def.cat === 'gloves') out.gloves = better(out.gloves, it);
    else if (def.wid.startsWith('weapon_')) out.guns[def.wid] = better(out.guns[def.wid], it);
  }
  return out;
}

// ---- messages ---------------------------------------------------------------------------------------------------------------
const say = (r, lines) => pick(lines, r);
export function post(so, id, from, text, extra = {}, now = Date.now()) {
  const t = (so.threads[id] ||= []);
  t.push({ id: uid(), at: now, from, text, ...extra });
  if (t.length > 80) t.splice(0, t.length - 80);
  if (from === 'npc') so.unread[id] = (so.unread[id] || 0) + 1;
}
function short(it) {
  const name = I.itemName(it);
  const w = it.t === 'skin' && it.fl != null ? ` (${WEAR_BY_KEY[wearOf(it.fl)].k})` : '';
  return name + w;
}
// What makes an item special, in a few words ("0.003 float, Blue Gem Tier 1, #7").
export function highlights(it) {
  const out = [];
  if (it.t === 'skin' && it.fl != null && I.floatMultiplier(it) > 1) out.push(`${it.fl.toFixed(it.fl < 0.01 ? 4 : 3)} float`);
  const p = I.patternInfo(it);
  if (p.label) out.push(p.label);
  if (it.sn && I.serialMultiplier(it.sn) > 1.03) out.push('#' + it.sn);
  if ((it.stk || []).some((s) => !s.sv && OLD_MAJOR.test(D.stickers[s.id]?.t || ''))) out.push('Katowice-era stickers');
  if (it.stt && skinOf(it)?.star) out.push('StatTrak™');
  return out;
}

// ---- offers --------------------------------------------------------------------------------------------------------------------
// An offer from an NPC: { id, npc, kind: 'buy' | 'trade', at, exp, status: open | accepted | declined | expired | withdrawn,
//   want: { uids, money } (what you'd give), give: { uids, money } (what they'd give), max (the most net cash toward you
//   they'd go to, hidden), patience, annoy, args: [arguments heard], agreed (they said yes to the cash now on it) }.
export const OFFER_LIFE = 45 * MIN;
const net = (o) => round2((o.give.money || 0) - (o.want.money || 0));
function setNet(o, x) { x = round2(x); o.give.money = Math.max(0, x); o.want.money = Math.max(0, -x); }

// Things you might own that someone would message you about.
export function notable(it) {
  const v = I.itemValue(it);
  return v >= 25 || (v >= 3 && highlights(it).length > 0) || (v >= 1 && it.sn && it.sn <= 10);
}
// Picks one of your items and an NPC who wants it, and writes them an offer (null if nobody's interested now).
export function makeOffer(so, st, { r, now }) {
  const mine = st.inv.filter((it) => !it.lk && notable(it) && !so.offers.some((o) => o.status === 'open' && o.want.uids.includes(it.uid)));
  if (!mine.length) return null;
  const people = activeCrowd(so.seed);
  const cands = [];
  for (const it of mine) {
    const v = I.itemValue(it);
    for (const n of people) {
      const k = interest(n, it);
      if (!k || (n.type === 'player' && v < 5)) continue;
      const s = npcState(so, n.id);
      const max = Math.min(buyValue(n, it), s.money + s.inv.reduce((t, x) => t + I.itemValue(x), 0) * 0.6);
      if (max < v * 0.6) continue;
      cands.push([[it, n, max], (n.type === 'collector' ? 4 : 1) * k * Math.sqrt(v)]);
    }
  }
  if (!cands.length) return null;
  const [it, n, max] = pickWeighted(cands, r);
  const s = npcState(so, n.id);
  const o = { id: uid(), npc: n.id, at: now, exp: now + OFFER_LIFE * (0.7 + r() * 0.6), status: 'open', want: { uids: [it.uid], money: 0 }, give: { uids: [], money: 0 },
    max: 0, patience: n.patience, annoy: 0, args: [], agreed: false };
  const open = max * (n.type === 'collector' ? 0.8 + r() * 0.12 : 0.72 + r() * 0.16);
  // A trade when they have something close in value they'd part with (players more often than collectors).
  const swap = r() < (n.type === 'collector' ? 0.25 : 0.5) ? tradeItems(n, s, open, r) : null;
  const hl = highlights(it);
  if (swap?.length) {
    const theirs = swap.reduce((t, x) => t + keepValue(n, x), 0);
    o.kind = 'trade';
    o.give.uids = swap.map((x) => x.uid);
    o.max = round2(Math.min(s.money, Math.max(0, max - theirs)));
    setNet(o, nice(Math.max(0, Math.min(o.max, open - theirs))));
    const what = swap.map(short).join(' + ') + (o.give.money ? ` + ${dollars(o.give.money)}` : '');
    post(so, n.id, 'npc', n.type === 'collector'
      ? say(r, [`Hi! Your ${short(it)}${hl.length ? ` (${hl.join(', ')})` : ''} would complete my collection. Would you trade it for my ${what}?`,
        `Hey, I collect these. Trade my ${what} for your ${short(it)}?`])
      : say(r, [`yo trade? my ${what} for ur ${short(it)}`, `hey wanna swap? ${what} for your ${short(it)}`, `trade my ${what} for ur ${short(it)}? sent u an offer`]),
    { offer: o.id }, now);
  } else {
    if (s.money < I.itemValue(it) * 0.5) return null;
    o.kind = 'buy';
    o.max = round2(Math.min(s.money, max));
    setNet(o, nice(Math.min(o.max, open)));
    post(so, n.id, 'npc', n.type === 'collector'
      ? say(r, [`Hi! I collect ${FOCUS[n.focus].n.replace(/ collector| hunter/i, '').toLowerCase()} items and your ${short(it)}${hl.length ? ` (${hl.join(', ')})` : ''} caught my eye. Would you sell it for ${dollars(net(o))}?`,
        `Hello! Is your ${short(it)} for sale? I can pay ${dollars(net(o))} right now.`,
        `Saw your ${short(it)}${hl.length ? ` — ${hl.join(', ')}` : ''}. Cash offer: ${dollars(net(o))}. Interested?`])
      : say(r, [`yo u selling ur ${short(it)}? i can do ${dollars(net(o))}`, `hey would u take ${dollars(net(o))} for the ${short(it)}?`, `${dollars(net(o))} for ur ${short(it)}? cash rn`]),
    { offer: o.id }, now);
  }
  so.offers.push(o);
  return o;
}
export const dollars = (x) => '$' + (x >= 100 ? Math.round(x).toLocaleString('en-US') : x.toFixed(2));
// Items of theirs worth about `target` to them, that they'd part with (never a collector's own focus items).
function tradeItems(n, s, target, r) {
  const can = s.inv.filter((x) => !(n.type === 'collector' && FOCUS[n.focus].fit(x) > 0) && keepValue(n, x) <= target * 1.05).sort((a, b) => keepValue(n, b) - keepValue(n, a));
  const out = [];
  let sum = 0;
  for (const x of can) {
    if (out.length >= 3) break;
    const v = keepValue(n, x);
    if (sum + v <= target * 1.02 && (out.length || r() < 0.9)) { out.push(x); sum += v; }
  }
  return sum >= target * 0.5 ? out : null;
}

// ---- haggling --------------------------------------------------------------------------------------------------------------------
// The arguments you can make for your price, and whether they hold for the items you'd give.
export const ARGUMENTS = {
  float: { n: 'It has a great float', ok: (its) => its.some((it) => it.t === 'skin' && it.fl != null && (I.floatMultiplier(it) > 1 || floatRank(it) < 0.05)), bump: 0.06 },
  pattern: { n: 'The pattern is rare', ok: (its) => its.some((it) => { const p = I.patternInfo(it); return p.mult > 1 || !!p.tier; }), bump: 0.08 },
  stickers: { n: 'The stickers are worth a lot', ok: (its) => its.some((it) => I.stickerContribution(it).reduce((t, s) => t + s.value, 0) >= 5), bump: 0.05 },
  serial: { n: 'It has a low serial number', ok: (its) => its.some((it) => it.sn && I.serialMultiplier(it.sn) > 1.03), bump: 0.06 },
  rare: { n: "It's StatTrak™ / Souvenir / ★", ok: (its) => its.some((it) => it.stt || it.sv || skinOf(it)?.star), bump: 0.04 },
  market: { n: "That's what the market pays", ok: () => true, bump: 0 },
  other: { n: "Someone else offered me more", ok: () => true, bump: 0 },
};
// Where a skin's float sits in its wear (0 = the best of it).
function floatRank(it) {
  const w = WEAR_BY_KEY[wearOf(it.fl)], d = I.itemDef(it);
  const lo = Math.max(w.min, d.mn), hi = Math.min(w.max, d.mx);
  return (it.fl - lo) / Math.max(1e-6, hi - lo);
}

// You counter an NPC's offer: `price` is the net cash you want toward you (what they pay, or minus what you'd pay), `arg`
// an argument for it. Returns { outcome: 'agree' | 'counter' | 'final' | 'walk', text }; the offer is updated.
export function haggle(so, st, o, { price, arg = null }, { r, now }) {
  const n = npcOf(so.seed, o.npc), s = npcState(so, o.npc);
  const items = o.want.uids.map((u) => st.inv.find((it) => it.uid === u)).filter(Boolean);
  const value = items.reduce((t, it) => t + I.itemValue(it), 0) + (o.want.money || 0);
  const lines = [];
  // The argument first: a true one moves them, a false one or a bluff they see through annoys them.
  if (arg && ARGUMENTS[arg] && !o.args.includes(arg)) {
    o.args.push(arg);
    const A = ARGUMENTS[arg];
    if (arg === 'market') {
      if (price <= value * 1.03 + 0.01) { o.max = Math.max(o.max, Math.min(value, s.money)); lines.push(say(r, ['fair, market is market', 'ok true that\'s what it goes for'])); }
      else { o.annoy += 0.25; lines.push(say(r, [`market's ${dollars(value)} tho`, `nah it goes for about ${dollars(value)}`])); }
    } else if (arg === 'other') {
      const rival = so.offers.filter((x) => x !== o && x.status === 'open' && x.want.uids.some((u) => o.want.uids.includes(u))).reduce((m, x) => Math.max(m, net(x)), 0);
      if (rival > net(o)) { o.max = Math.max(o.max, Math.min(s.money, rival * 1.03, items.length ? buyValue(n, items[0]) * 1.15 : rival)); lines.push(say(r, ['hm ok I can beat that', 'alright, I don\'t want to lose it'])); }
      else if (r() < n.sharp) { o.annoy += 0.4; o.patience--; lines.push(say(r, ['lol sure they did', 'no they didn\'t 😂', 'I doubt that tbh'])); }
      else { o.max = Math.min(s.money, o.max * 1.06); lines.push(say(r, ['hmm ok', 'really? ok let me think'])); }
    } else if (A.ok(items)) {
      o.max = round2(Math.min(s.money, o.max * (1 + A.bump * (n.type === 'collector' ? 1.4 : 1))));
      lines.push(say(r, n.type === 'collector' ? ['True, that does matter to me.', 'Fair point, I noticed that too.'] : ['ye true', 'fair', 'ok ok']));
    } else {
      o.annoy += n.type === 'collector' ? 0.45 : 0.3; o.patience--;
      lines.push(say(r, n.type === 'collector' ? ['That\'s not really true though.', 'I checked, it isn\'t.'] : ['lol no it\'s not', 'bro what', 'thats cap']));
    }
  }
  const cur = net(o);
  let outcome;
  if (price <= cur) {
    o.agreed = true; outcome = 'agree';
    lines.push(say(r, ['deal 🤝', 'sure, deal', 'works for me']));
  } else if (price <= o.max && (price - cur <= Math.max(1, value * 0.04) || r() < 0.55)) {
    setNet(o, price); o.agreed = true; outcome = 'agree';
    lines.push(say(r, n.type === 'collector' ? ['Alright, deal.', 'Okay, you have a deal.', 'Fine, let\'s do it.'] : ['ok fine deal', 'ugh ok deal', 'aight deal']));
  } else if (o.patience <= 1 || o.annoy >= 1) {
    o.status = 'withdrawn'; outcome = 'walk';
    lines.push(say(r, n.type === 'collector' ? ['I don\'t think we\'ll agree. Good luck with the sale.', 'Let\'s leave it, thanks anyway.'] : ['nah forget it', 'ok nvm gl', 'too much, im out']));
  } else if (cur >= o.max - 0.01) {
    o.patience--; outcome = 'final';
    lines.push(say(r, [`${dollars(cur)} is my max`, `can't go above ${dollars(cur)}`, `${dollars(cur)}, final offer`]));
  } else {
    o.patience -= price > o.max * 1.4 ? 2 : 1;
    const step = price > o.max * 1.4 ? 0.2 + r() * 0.15 : 0.35 + r() * 0.35;
    setNet(o, nice(Math.min(o.max, cur + (Math.min(price, o.max) - cur) * step)));
    o.agreed = false; outcome = 'counter';
    lines.push(price > o.max * 1.4 ? say(r, [`lol no. ${dollars(net(o))}`, `way too much. ${dollars(net(o))}?`]) : say(r, [`meet me at ${dollars(net(o))}?`, `${dollars(net(o))}?`, `I can do ${dollars(net(o))}`]));
  }
  if (o.status === 'open') o.exp = Math.max(o.exp, now + 15 * MIN);
  return { outcome, text: lines.join(' ') };
}

// ---- offers you make ---------------------------------------------------------------------------------------------------------
// They weigh what they'd get against what they'd give: accept, ask for more cash, or say no.
export function judge(so, n, s, { yours, theirs, myMoney, theirMoney }) {
  const get = yours.reduce((t, it) => t + buyValue(n, it), 0) + myMoney;
  const give = theirs.reduce((t, it) => t + keepValue(n, it), 0) + theirMoney;
  const margin = n.type === 'collector' ? 0.0 : 0.03;
  if (get >= give * (1 + margin)) return { ok: true };
  if (get >= give * 0.8 && give > 0) return { ok: false, more: nice(give * (1 + margin) - get + 0.5) };
  return { ok: false };
}

// ---- the NPCs' own market buying ------------------------------------------------------------------------------------------------
// One NPC buys a listing from the market's current stock (offline, it's gone for you too). Returns the feed line.
export function marketBuy(so, st, { r, now }) {
  const people = activeCrowd(so.seed);
  const n = pickWeighted(people.map((p) => [p, Math.sqrt(Math.max(1, npcState(so, p.id).money))]), r);
  const s = npcState(so, n.id);
  const w = MK.marketWindow(now);
  const sold = MK.localSold(st, w);
  const pool = n.type === 'collector' ? index().pools[n.focus] : skins();
  for (let k = 0; k < 25; k++) {
    const skin = pick(pool.length ? pool : skins(), r);
    const l = MK.skinListings(skin, w).find((x) => !sold.has(x.lid));
    if (!l || l.p > s.money * 0.7 || l.p < 0.5) continue;
    if (n.type === 'player' && l.p > s.money * 0.4) continue;
    sold.add(l.lid);
    const it = MK.fromListing(l);
    it.at = now;
    s.inv.push(it);
    s.money = round2(s.money - l.p);
    const text = `bought ${short(it)} on the Market for ${dollars(l.p)}`;
    so.feed.unshift({ at: now, npc: n.id, text, lid: l.lid });
    so.feed.length = Math.min(so.feed.length, 40);
    return text;
  }
  return null;
}

// ---- small talk -------------------------------------------------------------------------------------------------------------------
export function chatLine(n, s, r) {
  const best = [...s.inv].sort((a, b) => I.itemValue(b) - I.itemValue(a))[0];
  return pick([
    'anyone up for premier later?', 'gg last night', 'these new cases are a scam lol', 'what\'s the best thing you ever unboxed?',
    best ? `look what I got: ${short(best)} 😎` : 'still no knife 😭', 'can you +rep my profile?', 'mirage again? 💀', 'I swear the AWP is broken',
    n.type === 'collector' ? `still looking for ${FOCUS[n.focus].n.replace(' collector', '').toLowerCase()} items if you find any` : 'u got any knives for trade?',
  ], r);
}
// A reply to something you typed that isn't about an offer.
export function smallTalk(n, text, r) {
  if (/\b(hi|hey|yo|hello|sup)\b/i.test(text)) return pick(['hey', 'yo', 'sup', 'hi!'], r);
  if (/\b(wts|wtb|sell|buy|trade|price|how much)\b/i.test(text)) return pick(['send me an offer and I\'ll take a look', 'make me an offer', 'whatcha got?'], r);
  if (/\b(play|premier|game|queue)\b/i.test(text)) return pick(['maybe later', 'ye I\'m down', 'not tonight, tilted'], r);
  if (/\?$/.test(text.trim())) return pick(['idk', 'maybe', 'hmm good question', 'lol'], r);
  return pick(['lol', 'true', 'haha', 'ye', '👍', 'fr'], r);
}

// What you typed, read for a haggle: a price, yes/no, and an argument.
export function readMessage(text) {
  const t = text.toLowerCase();
  const m = /\$?\s*(\d+(?:[.,]\d{1,2})?)\s*(k)?\b/.exec(t.replace(/,(?=\d{3}\b)/g, ''));
  const price = m ? parseFloat(m[1].replace(',', '.')) * (m[2] ? 1000 : 1) : null;
  const yes = /\b(yes|yeah|yep|deal|ok|okay|sure|accept|sold|done)\b/.test(t) && !/\b(not ok|no deal)\b/.test(t);
  const no = /\b(no|nah|nope|pass|decline|not interested|no deal)\b/.test(t);
  const arg = /other offer|someone else|another (buyer|offer)|offered me|got an offer/.test(t) ? 'other'
    : /float|factory new|\bfn\b|0\.0\d/.test(t) ? 'float'
    : /pattern|seed|gem|fade|blue|phase|ruby|sapphire|pearl|emerald|fire.?ice/.test(t) ? 'pattern'
    : /sticker|kato|craft|holo/.test(t) ? 'stickers'
    : /serial|#\d/.test(t) ? 'serial'
    : /stattrak|souvenir|\bst\b|knife|rare/.test(t) ? 'rare'
    : /market|steam|buff|csfloat|worth|goes for|value/.test(t) ? 'market' : null;
  return { price, yes: yes && !no, no: no && !yes, arg };
}
