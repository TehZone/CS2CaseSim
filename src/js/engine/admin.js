// The admin panel's rules, shared by the online server (server/admin.mjs) and the offline panel (admin-local.js): the
// checks on what staff send (a refusal is a GameError the panel shows as is), an edit's fields, a raw edit's rules and
// what it always keeps, what a restore puts back, the items staff give, and a state's rev. No storage here: callers
// load, lock and save.
import { D } from './data.js';
import { GameError } from './actions.js';
import { freshState, upgradeState } from './economy.js';
import { sha256Hex } from './gamble.js';
import * as I from './items.js';
import { indexProblem, mergeIndex } from './itemindex.js';
import { MAX_LEVEL, MEDALS } from './levels.js';
import * as N from './npcs.js';
import { repairStorage, storedOf } from './storage.js';
import { featuredBadge } from './badges.js';
import { dataUrlProblem } from './picture.js';
import { MAX_KILLS, nameable, nameProblem } from './tools.js';
import { round2 } from './util.js';

export const MAX_JSON = 48 * 1024, KEEP_AUTO = 20, MAX_MANUAL = 50, PAGE = 50;
export const LEVEL_NAMES = ['Player', 'Moderator', 'Admin', 'Owner'];
export const ITEM_KINDS = ['skin', 'crate', 'key', 'sticker', 'agent', 'charm', 'unit', 'tool', 'badge'];
// The objects of a raw edit whose fields the panel's editor shows by name: their field names must be plain identifiers.
export const NAMED_FIELDS = new Set(['stats', 'rank', 'wingman', 'prof', 'mm', 'premier']);
export const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
// (What comes out of containers; bought cases and keys have none, and of the badges only a capsule's pins: items.isBound.)
export const SERIAL_KINDS = new Set(['skin', 'sticker', 'agent', 'charm', 'badge']);

export const fail = (m, code) => { throw new GameError(m, code); };
export const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
export const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o?.[k]]));
// Strings as a JSONB column takes them: a lone UTF-16 surrogate (which it refuses, losing the row) becomes U+FFFD.
export const wellFormed = (v) => (typeof v === 'string' ? v.toWellFormed()
  : Array.isArray(v) ? v.map(wellFormed)
    : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k.toWellFormed(), wellFormed(x)])) : v);
export const worthOf = (inv) => round2((inv || []).reduce((s, it) => s + I.itemValue(it), 0));
// Replaces a state object in place (anything holding it keeps seeing the current one). (An own __proto__ key, as
// JSON.parse makes one, would set its prototype: it's left out.)
export function replaceInPlace(st, next) {
  for (const k of Object.keys(st)) if (!Object.hasOwn(next, k)) delete st[k];
  for (const [k, v] of Object.entries(next)) if (k !== '__proto__') st[k] = v;
}

// The state as edit.raw replaces it (all but the inventory, what's in Storage Units, the Index's record, the NPC world and, offline, the device's settings), as a
// short hash: the panel sends back the one it loaded, so a raw edit can't put back what changed since. Keys sorted (a
// state read back from JSONB has them in another order). Not what passive income changes by itself every minute (levels.js):
// its clock, and the money it has paid (money counts without it). A raw edit opened a while ago isn't stale for that, and
// keeps what it paid since (rawEdit).
const canon = (v) => (Array.isArray(v) ? v.map(canon) : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
export function revOf(st) {
  const { inv: _inv, stored: _stored, index: _index, social: _social, settings: _settings, passive, ...rest } = st;
  if (typeof rest.money === 'number') rest.money = round2(rest.money - (Number(passive?.earned) || 0));
  return sha256Hex(JSON.stringify(canon(rest))).slice(0, 32);
}
// What a raw edit shows and answers: the state without those.
export function rawView(st) {
  const { inv: _inv, stored: _stored, listed: _listed, index: _index, social: _social, settings: _settings, ...rest } = st;
  return rest;
}

// ---- argument checks ---------------------------------------------------------------------------------------------------
export function text(v, name, max, { min = 1 } = {}) {
  if (v == null) v = '';
  if (typeof v !== 'string') fail(`${name} must be text`);
  const s = v.replace(/\u0000/g, '').toWellFormed().trim(); // (Postgres can't store NUL characters, JSONB lone surrogates)
  if (s.length < min) fail(`${name} is required`);
  if (s.length > max) fail(`${name}: at most ${max} characters`);
  return s;
}
export function int(v, name, lo, hi) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) fail(`${name} must be a whole number from ${lo} to ${hi}`);
  return v;
}
export function number(v, name, lo, hi) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) fail(`${name} must be a number from ${lo} to ${hi}`);
  return v;
}
export function bool(v, name) {
  if (typeof v !== 'boolean') fail(`${name} must be true or false`);
  return v;
}
export const optBool = (v, name) => (v == null ? false : bool(v, name));
// JSON a player or an admin sent, as stored: an object, at most 48 KB, nothing Postgres refuses. → { value, json }
const enc = new TextEncoder();
export function jsonOf(v, what) {
  if (!isObj(v)) fail(`${what} must be a JSON object`);
  const size = enc.encode(JSON.stringify(v)).length;
  if (size > MAX_JSON) fail(`Too big to save: ${Math.ceil(size / 1024)} KB (48 KB at most)`);
  const value = wellFormed(v);
  const json = JSON.stringify(value);
  if (json.includes('\\u0000')) fail(`${what} can't contain NUL characters`);
  return { value, json };
}
// A partial object of numbers: only the keys given in `spec` ({ key: [lo, hi, integer] }).
export function numbers(v, name, spec) {
  if (!isObj(v)) fail(`${name} must be an object`);
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    const s = spec[k];
    if (!s) fail(`Unknown field: ${name}.${k}`);
    out[k] = s[2] ? int(x, `${name}.${k}`, s[0], s[1]) : round2(number(x, `${name}.${k}`, s[0], s[1]));
  }
  return out;
}

// ---- edit: money, stars, detachments, the profile, stats and ranks ------------------------------------------------------
// `set` checked field by field against the state `st`. → { next (the fields to set), changed (['money', 'prof.level',
// ...]: what differs from `st`), before, after }. Nothing changes until applyEdit.
export function editPlan(st, set) {
  if (!isObj(set) || !Object.keys(set).length) fail('Nothing to change');
  const next = {};
  for (const [k, v] of Object.entries(set)) {
    if (k === 'money') next.money = round2(number(v, 'Money', 0, 1e12));
    else if (k === 'stars') next.stars = int(v, 'Stars', 0, 1e9);
    else if (k === 'charmDetach') next.charmDetach = int(v, 'Charm detachments', 0, 1e6);
    else if (k === 'prof') next.prof = numbers(v, 'prof', { level: [1, MAX_LEVEL, true], xp: [0, 1e9, true], medals: [0, MEDALS.length, true] });
    else if (k === 'stats') {
      // Existing number stats only; the net gambling result can be below zero.
      const spec = Object.fromEntries(Object.entries(st.stats).filter(([, x]) => typeof x === 'number').map(([s]) => [s, [s === 'gambleWon' ? -1e12 : 0, 1e12, false]]));
      next.stats = numbers(v, 'stats', spec);
    } else if (k === 'rank' || k === 'wingman') {
      const spec = Object.fromEntries(Object.entries(st[k] || {}).filter(([, x]) => typeof x === 'number').map(([s]) => [s, [0, 1e13, false]]));
      next[k] = numbers(v, k, spec);
    } else fail(`Unknown field: ${k}`);
  }
  const changed = [], before = {}, after = {};
  for (const [k, v] of Object.entries(next)) {
    if (isObj(v)) {
      const keys = Object.keys(v).filter((s) => st[k]?.[s] !== v[s]);
      if (!keys.length) continue;
      before[k] = pick(st[k], keys); after[k] = pick(v, keys);
      changed.push(...keys.map((s) => `${k}.${s}`));
    } else if (st[k] !== v) {
      before[k] = st[k]; after[k] = v;
      changed.push(k);
    }
  }
  return { next, changed, before, after };
}
// Puts an edit's fields in the state (an object's over the fields it has).
export function applyEdit(st, next) {
  for (const [k, v] of Object.entries(next)) st[k] = isObj(v) ? { ...st[k], ...v } : v;
}

// ---- what a replaced state always keeps --------------------------------------------------------------------------------
// From the state it replaces: the device's settings (offline; online states have none), the Play match being played
// (what its reward is checked against; one already paid isn't paid again), the ranked match in progress, and passive
// income's clock (levels.js: a restore or an edit puts back no time to be paid again; startOver, a reset, is a new
// account's, counting from now).
export function keepLive(next, cur, { startOver = false } = {}) {
  if (cur.settings) next.settings = cur.settings; else delete next.settings;
  next.play = cur.play ?? null;
  next.mm = { ...next.mm, match: cur.mm?.match ?? null };
  if (!startOver) { if (cur.passive) next.passive = cur.passive; else delete next.passive; }
  return next;
}
// Loadout slots only for items the state has.
export function fitLoadout(st) {
  const uids = new Set(st.inv.map((i) => i.uid));
  st.loadout = Object.fromEntries(Object.entries(st.loadout || {}).filter(([, u]) => uids.has(u)));
}

// ---- edit.raw ----------------------------------------------------------------------------------------------------------
// Every top-level field but the inventory and the NPC world, replaced as given (filled in through upgradeState), from the
// state the panel loaded: `base` is that `player` answer's rev, and anything changed since refuses it ('stale').
// → { next (the whole new state: `cur` isn't changed), changed (top-level keys), before, after }.
export function rawEdit(cur, state, base) {
  const src = jsonOf(state, 'The state').value;
  if (typeof base !== 'string' || base !== revOf(cur)) fail('The account changed since you opened it. Reload it and try again.', 'stale');
  const fresh = freshState();
  for (const [k, v] of Object.entries(src)) {
    // (listed: what's on the Market, which its own tools take down. An admin panel from before the Market (1.1.3) sends it back
    // as it loaded it, so that is kept as it is now; a change to it is refused.)
    if (k === 'listed') {
      if (JSON.stringify(canon(v)) !== JSON.stringify(canon(cur.listed ?? []))) fail("listed can't be edited here (it's what the player has on the Market: take a listing down in the Market tab)");
      continue;
    }
    if (k === 'inv' || k === 'stored' || k === 'social') fail(`${k} can't be edited here (use the inventory tools)`);
    // (the record is what rewards are earned by, and bigger than a raw edit's limit: nobody writes it by hand)
    if (k === 'index') fail("index can't be edited here (it's the record of what the player has unboxed)");
    // (own fields only: '__proto__' is `in` every object)
    if (k === 'settings' || !(Object.hasOwn(fresh, k) || Object.hasOwn(cur, k))) fail(`Unknown field: ${k}`);
    const d = Object.hasOwn(fresh, k) ? fresh[k] : cur[k];
    const ok = d === null ? v === null || isObj(v)
      : typeof d === 'number' ? typeof v === 'number' && Number.isFinite(v)
        : Array.isArray(d) ? Array.isArray(v) : isObj(d) ? isObj(v) : typeof v === typeof d;
    if (!ok) fail(`${k} has the wrong type`);
    if (typeof d === 'number' && (v < 0 || v > 1e13)) fail(`${k} must be from 0 to 10,000,000,000,000`);
    if (NAMED_FIELDS.has(k) && isObj(v)) for (const f of Object.keys(v)) if (!IDENT.test(f)) fail(`${k} has a field with an invalid name: ${JSON.stringify(f.slice(0, 40))}`);
  }
  if (src.money != null && src.money > 1e12) fail('Money must be a number from 0 to 1000000000000');
  const st = upgradeState({ ...src, inv: cur.inv, stored: cur.stored, index: cur.index, social: cur.social, ...('listed' in cur ? { listed: cur.listed } : {}) });
  // Never from the JSON: the rewards waiting (their items' uids are handed out as they are), the Service Medal badges given
  // (their record goes with the inventory, which isn't edited here: one left out or emptied would give every medal's badge
  // again, as second copies: engine/badges.js grantMedals), and what keepLive keeps.
  st.prof = { ...st.prof, drops: cur.prof?.drops ?? [], medalBadges: cur.prof?.medalBadges ?? [] };
  keepLive(st, cur);
  fitLoadout(st);
  // What passive income paid since the panel loaded this (it didn't make it stale: revOf) stays paid, on top of its money.
  const paid = Number(cur.passive?.earned) || 0, then = Number(src.passive?.earned);
  const since = Number.isFinite(then) ? Math.min(paid, Math.max(0, paid - then)) : 0;
  if (typeof st.money === 'number') st.money = round2(st.money + since);
  const changed = [...new Set([...Object.keys(cur), ...Object.keys(st)])].filter((k) => k !== 'inv' && k !== 'stored' && k !== 'listed' && k !== 'index' && k !== 'social' && JSON.stringify(cur[k]) !== JSON.stringify(st[k]));
  return { next: st, changed, before: pick(cur, changed), after: pick(st, changed) };
}

// ---- restoring a snapshot -----------------------------------------------------------------------------------------------
// The uids a restore of `next` would bring back (its items and its rewards' items), to look for elsewhere.
export function restoreUids(next) {
  const drops = Array.isArray(next.prof?.drops) ? next.prof.drops : [];
  return [...next.inv.map((i) => i.uid), ...storedOf(next).map((i) => i.uid), ...drops.flatMap((d) => (Array.isArray(d?.offers) ? d.offers : []).map((o) => o?.uid)).filter(Boolean)];
}
// Makes an upgraded snapshot `next` fit to replace `cur`: retired items sold, no item twice, none in `elsewhere` (uids
// owned by someone else now: online, other inventories and escrows), loadout fitted, and what keepLive keeps. A level-up
// reward whose items exist now (elsewhere, or in either inventory) was claimed since, and claiming it again would make
// second copies: left out, unless keepRewards (offline: nobody else can own them). For the same reason a restore online keeps
// the Index's record and claims as they are now: rewards can't be claimed twice by going back to before the first time. Not
// a reset (startOver): that's a new account, everything on it to earn again. Changes `next`.
// → { dropped (items and rewards left out), rewards }
export function restoreMerge(cur, next, { elsewhere = new Set(), keepRewards = false, startOver = false } = {}) {
  I.retireOld(next);
  const drops = Array.isArray(next.prof?.drops) ? next.prof.drops : [];
  const seen = new Set();
  const inv = next.inv.filter((i) => !elsewhere.has(i.uid) && !seen.has(i.uid) && seen.add(i.uid));
  const stored = storedOf(next).filter((i) => !elsewhere.has(i.uid) && !seen.has(i.uid) && seen.add(i.uid));
  const mine = new Set([...cur.inv, ...storedOf(cur)].map((i) => i.uid));
  const exists = (u) => elsewhere.has(u) || mine.has(u) || seen.has(u);
  const keep = keepRewards ? drops : drops.filter((d) => !(Array.isArray(d?.offers) ? d.offers : []).some((o) => exists(o?.uid)));
  const rewards = drops.length - keep.length, dropped = next.inv.length - inv.length + storedOf(next).length - stored.length + rewards;
  next.inv = inv;
  next.stored = stored;
  repairStorage(next); // (a unit left out: what's in it goes back to the inventory)
  if (next.prof) next.prof = { ...next.prof, drops: keep };
  if (!keepRewards && !startOver) next.index = mergeIndex(next.index, cur.index);
  fitLoadout(next);
  keepLive(next, cur, { startOver });
  return { dropped, rewards };
}

// ---- a save file (offline: save.import) --------------------------------------------------------------------------------
// A save from a file (someone else's, say) as the game writes one, or refused: the game's pages show what a save holds
// as it is (only the game wrote saves until now). Every text in it loses < and > (the game's own free text has none) and
// its " (made '), keys named __proto__ go, its numbers are numbers, items and offers have plain ids, and its NPC world
// is whole: traders of its seed, offers, chats and blocks as the game makes them, what's missing there filled in, a
// blocked trader's open offers cancelled. A snapshot's download ({ state, config }) is taken too. The one text left as it
// is is the Name Tag name of a skin in one of the save's item lists, which may hold those characters: it has to pass a Name
// Tag's rules instead, and a counter a counter's (on a skin with a StatTrak™ version), so a file can't put on an item what the
// tools wouldn't have. → the save (a copy)
const TOKEN = /^[A-Za-z0-9_-]{1,64}$/;
const isToken = (v) => typeof v === 'string' && TOKEN.test(v);
const cleanText = (s) => s.replace(/[<>]/g, '').replaceAll('"', "'");
const cleanAll = (v) => (typeof v === 'string' ? cleanText(v) : Array.isArray(v) ? v.map(cleanAll)
  : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [cleanText(k), cleanAll(x)]).filter(([k]) => k !== '__proto__')) : v);
// The Name Tag names of an item list, back as the file has them.
const tagNames = (list, from) => {
  if (Array.isArray(list)) list.forEach((it, i) => { if (isObj(it) && it.t === 'skin' && from?.[i]?.name !== undefined) it.name = from[i].name; });
};
// (of the type the game starts a field with; null: null or an object)
const sameType = (d, v) => (d === null ? v === null || isObj(v) : typeof d === 'number' ? Number.isFinite(v)
  : Array.isArray(d) ? Array.isArray(v) : isObj(d) ? isObj(v) : typeof v === typeof d);
const optNum = (v) => v == null || Number.isFinite(v);
const defOf = (it) => { try { return I.itemDef(it); } catch { return null; } };
export function saveFile(file, now = Date.now()) {
  const raw = isObj(file) && isObj(file.state) && !('inv' in file) ? file.state : file, st = cleanAll(raw);
  const bad = (what) => fail(`That file isn't a save from this game${what ? ` (its ${what} isn't as the game writes it)` : ''}`);
  if (!isObj(st) || !Number.isFinite(st.money) || st.money < 0 || !Array.isArray(st.inv)) bad();
  tagNames(st.inv, raw.inv);
  tagNames(st.stored, raw.stored);
  tagNames(st.listed, raw.listed);
  if (Array.isArray(st.prof?.drops)) st.prof.drops.forEach((d, i) => tagNames(d?.offers, raw.prof.drops[i]?.offers));
  if (isObj(st.social?.npcs)) for (const [id, s] of Object.entries(st.social.npcs)) tagNames(s?.inv, raw.social.npcs[id]?.inv);
  // The fields a new save has, and their objects' fields (stats, prof, rank...), of the same types (not the settings:
  // this device's stay).
  for (const [k, d] of Object.entries(freshState())) {
    if (k === 'settings' || st[k] === undefined) continue;
    if (!sameType(d, st[k])) bad(k);
    if (isObj(d)) for (const [f, x] of Object.entries(d)) if (st[k][f] !== undefined && !sameType(x, st[k][f])) bad(`${k}.${f}`);
  }
  const item = (it, what) => {
    if (!isObj(it) || !isToken(it.uid) || !isObj(defOf(it)) || !['fl', 'sd', 'sn', 'pat', 'at', 'mod', 'sat'].every((f) => optNum(it[f]))
      || (it.name != null && !(I.isUnit(it) ? typeof it.name === 'string' : nameable(it) && !nameProblem(it.name)))
      || (it.stt && !(it.t === 'skin' && defOf(it).stt && defOf(it).cat !== 'gloves' && !it.sv))
      || (it.kills != null && !(Number.isInteger(it.kills) && it.kills >= 0 && it.kills <= MAX_KILLS && (it.stt || !it.kills)))
      || (it.stk != null && !(Array.isArray(it.stk) && it.stk.every((s) => isObj(s) && isObj(D.stickers[s.id]))))
      || (it.kc != null && !(isObj(it.kc) && isObj(defOf(I.attachedCharm(it)))))) bad(what);
  };
  st.inv.forEach((it, i) => item(it, `inv[${i}]`));
  // (what's stored in a unit the save doesn't have goes back to the inventory as it loads: storage.repairStorage)
  (st.stored || []).forEach((it, i) => { item(it, `stored[${i}]`); if (!isToken(it.su)) bad(`stored[${i}]`); });
  // What it has on the Market (engine/p2p.js): items as the inventory's, none of them also in the inventory, a unit or listed
  // twice, each with its listing's id, a price the Market takes ($0.03 to $1,000,000) and when it was listed.
  if (st.listed != null && !Array.isArray(st.listed)) bad('listed');
  const owned = new Set([...st.inv, ...(Array.isArray(st.stored) ? st.stored : [])].map((it) => it?.uid));
  (st.listed || []).forEach((it, i) => {
    item(it, `listed[${i}]`);
    if (!isToken(it.lid) || !Number.isFinite(it.lp) || it.lp < 0.03 || it.lp > 1e6 || !optNum(it.lat) || I.isUnit(it) || I.isBound(it) || owned.has(it.uid)) bad(`listed[${i}]`);
    owned.add(it.uid);
  });
  (st.prof?.drops || []).forEach((d, i) => {
    if (!isObj(d) || !isToken(d.id) || !optNum(d.level) || !Array.isArray(d.offers)) bad(`prof.drops[${i}]`);
    d.offers.forEach((it, j) => item(it, `prof.drops[${i}].offers[${j}]`));
  });
  for (const [k, n] of Object.entries(st.serials || {})) if (!Number.isFinite(n)) bad(`serials.${k}`);
  if (st.index != null) { const why = indexProblem(st.index); if (why) bad(why); }
  if (st.market != null && !(isObj(st.market) && Object.values(st.market).every(Array.isArray))) bad('market');
  const so = st.social;
  if (so == null) return st;
  if (!Number.isSafeInteger(so.seed) || so.seed < 0 || !optNum(so.at)) bad('social');
  const trader = (id) => N.npcOf(so.seed, id)?.id === id; // (one of its seed's crowd, by their own id)
  const field = (k, empty) => {
    so[k] ??= empty;
    if (Array.isArray(empty) ? !Array.isArray(so[k]) : !isObj(so[k])) bad(`social.${k}`);
    return so[k];
  };
  for (const [id, s] of Object.entries(field('npcs', {}))) {
    if (!trader(id) || !isObj(s) || !Number.isFinite(s.money) || !Array.isArray(s.inv) || ![0, 1, 2, 3].includes(s.friend) || ![0, 1, 2, 3].includes(s.tier)
      || !Number.isFinite(s.mood) || !Number.isFinite(s.trades)) bad(`social.npcs.${id}`);
    s.inv.forEach((it, i) => item(it, `social.npcs.${id}.inv[${i}]`));
  }
  const side = (x) => isObj(x) && Array.isArray(x.uids) && x.uids.every(isToken) && optNum(x.money);
  field('offers', []).forEach((o, i) => {
    if (!isObj(o) || !isToken(o.id) || !trader(o.npc) || typeof o.status !== 'string' || !Number.isFinite(o.at) || !Number.isFinite(o.exp) || !side(o.want) || !side(o.give)
      || (o.args != null && !Array.isArray(o.args)) || !['max', 'patience', 'annoy'].every((f) => optNum(o[f]))) bad(`social.offers[${i}]`);
  });
  for (const [id, t] of Object.entries(field('threads', {}))) {
    if (!trader(id) || !Array.isArray(t) || !t.every((m) => isObj(m) && Number.isFinite(m.at) && typeof m.text === 'string' && (m.from === 'me' || m.from === 'npc'))) bad(`social.threads.${id}`);
  }
  for (const [id, n] of Object.entries(field('unread', {}))) if (!Number.isFinite(n)) bad(`social.unread.${id}`);
  for (const k of ['feed', 'comments']) field(k, []).forEach((x, i) => { if (!isObj(x) || !Number.isFinite(x.at) || !trader(x.npc) || typeof x.text !== 'string') bad(`social.${k}[${i}]`); });
  for (const [id, b] of Object.entries(so.blocked == null ? {} : field('blocked', {}))) {
    if (!trader(id) || !isObj(b) || !Number.isFinite(b.at) || !optNum(b.expires) || ![b.reason, b.by].every((x) => x == null || typeof x === 'string')) bad(`social.blocked.${id}`);
  }
  if (so.rules != null && !(isObj(so.rules) && N.NPC_RULES.every((k) => so.rules[k] == null || typeof so.rules[k] === 'boolean'))) bad('social.rules');
  // Your profile as Community's editor leaves it (actions.js persona.set).
  const me = isObj(so.me) ? so.me : {}, str = (x, max) => String(x ?? '').trim().slice(0, max), mine = new Set(st.inv.map((it) => it.uid));
  so.me = {
    ...N.freshPersona(), ...me, name: str(me.name, 32), bio: str(me.bio, 300), country: /^[A-Z]{2}$/.test(me.country) ? me.country : '',
    avatar: Object.hasOwn(D.agents, me.avatar ?? '') ? me.avatar : null, bg: me.bg ? str(me.bg, 40) : null,
    showcase: Array.isArray(me.showcase) ? [...new Set(me.showcase.filter((u) => mine.has(u)))].slice(0, 6) : [],
    // (a picture as the game makes one, and a badge the save has: engine/picture.js, badges.js)
    pic: me.pic && !dataUrlProblem(me.pic) ? me.pic : null, badge: featuredBadge(st, me.badge),
  };
  for (const o of so.offers) if (o.status === 'open' && N.isBlocked(so, o.npc, now)) o.status = 'cancelled';
  return st;
}

// ---- items.give / items.remove -----------------------------------------------------------------------------------------
// One entry of items.give, checked against the game data. → { n (copies), make () (a new copy, no serial yet) }
export function itemSpec(x) {
  if (!isObj(x)) fail('Invalid item');
  if (!ITEM_KINDS.includes(x.t)) fail(`Unknown item kind: ${String(x.t).slice(0, 20)}`);
  const id = text(x.id, 'Item id', 120);
  const n = x.n == null ? 1 : int(x.n, 'Count', 1, 100);
  const src = 'Admin';
  switch (x.t) {
    case 'skin': {
      const s = D.skins[id] || fail(`Unknown skin: ${id}`);
      const o = { src, stt: false };
      if (x.fl != null) { if (s.v) fail(`${s.n} has no float`); o.fl = Math.fround(number(x.fl, 'Float', s.mn, s.mx)); }
      if (x.sd != null) { if (s.v) fail(`${s.n} has no pattern seed`); o.sd = int(x.sd, 'Pattern seed', 0, 1000); }
      if (x.stt != null && bool(x.stt, 'StatTrak™')) { if (!s.stt || s.cat === 'gloves') fail(`${s.n} has no StatTrak™ version`); o.stt = true; }
      if (x.sv != null && bool(x.sv, 'Souvenir')) {
        if (s.svp == null) fail(`${s.n} has no Souvenir version`);
        if (o.stt) fail('A skin is StatTrak™ or Souvenir, not both');
        o.sv = true;
      }
      return { n, make: () => I.makeSkinItem(s, o) };
    }
    case 'crate': {
      const c = D.caseById[id];
      if (!c || c.price == null) fail(`Unknown case: ${id}`);
      return { n, make: () => I.makeCrateItem(c, src) };
    }
    case 'key': {
      if (!D.keys[id]) fail(`Unknown key: ${id}`);
      return { n, make: () => I.makeKeyItem(id, src) };
    }
    case 'sticker': {
      const s = D.stickers[id] || fail(`Unknown sticker: ${id}`);
      return { n, make: () => I.makeStickerItem(s, src) };
    }
    case 'agent': {
      const g = D.agents[id] || fail(`Unknown agent: ${id}`);
      return { n, make: () => I.makeAgentItem(g, src) };
    }
    case 'unit': {
      if (id !== I.UNIT_ID) fail(`Unknown Storage Unit: ${id}`);
      return { n, unit: true, make: () => I.makeUnitItem(src) };
    }
    case 'tool': {
      if (!Object.hasOwn(I.TOOLS, id)) fail(`Unknown tool: ${id}`);
      return { n, make: () => I.makeToolItem(id, src) };
    }
    case 'charm': {
      const pat = x.pat == null ? undefined : int(x.pat, 'Charm pattern', 1, I.CHARM_PATTERNS);
      if (id === 'slab') {
        const sk = text(x.sk, 'Sticker of the slab', 120);
        if (!D.stickers[sk] || !D.slab) fail(`Unknown sticker: ${sk}`);
        return { n, make: () => I.makeSlabItem(sk, { src, pat }) };
      }
      const c = D.charms[id] || fail(`Unknown charm: ${id}`);
      return { n, make: () => I.makeCharmItem(c, { src, pat }) };
    }
    case 'badge': {
      // (Any of CS2's collectibles, the ones nobody can get too: staff are the only way to one. The Service Medals come from
      // prestiging as well, and a copy given here is one more: engine/badges.js)
      const b = (Object.hasOwn(D.badges, id) && D.badges[id]) || fail(`Unknown badge: ${id}`);
      return { n, bound: !b.tr, make: () => I.makeBadgeItem(b, src) };
    }
  }
  return fail('Invalid item');
}
// items.give's list (1 to 50 entries). → { specs, total (copies in all), counted (those that count toward an inventory's
// limit: all but bound badges, items.capCount) }
export function giveSpecs(items) {
  if (!Array.isArray(items) || !items.length || items.length > 50) fail('Give 1 to 50 kinds of items at a time');
  const specs = items.map(itemSpec);
  return { specs, total: specs.reduce((s, x) => s + x.n, 0), counted: specs.reduce((s, x) => s + (x.bound ? 0 : x.n), 0) };
}
// The new items, marked new, those that have serials numbered by serial(key) (online the server's counters, offline
// the save's: localSerial).
export function buildItems(specs, serial) {
  const items = specs.flatMap((s) => Array.from({ length: s.n }, () => ({ ...s.make(), nw: true })));
  for (const it of items) if (SERIAL_KINDS.has(it.t) && !I.isBound(it)) it.sn = serial(I.serialKey(it));
  return items;
}
// The save's own serial counters, as a case opened offline numbers its drops (st.serials replaced, not changed).
export const localSerial = (st) => (key) => {
  const n = (st.serials?.[key] || 0) + 1;
  st.serials = { ...(st.serials || {}), [key]: n };
  return n;
};
// items.remove's list: 1 to 3,000 item uids.
export function removeUids(v) {
  if (!Array.isArray(v) || !v.length || v.length > 3000) fail('Pick the items to remove');
  return v.map((u) => (typeof u === 'string' && u && u.length <= 64 ? u : fail('Invalid item')));
}
// What the audit row says about the items given or removed.
export function givenDetail(items) {
  const names = {};
  for (const it of items) names[I.itemName(it)] = (names[I.itemName(it)] || 0) + 1;
  return { count: items.length, items: Object.entries(names).slice(0, 50).map(([name, n]) => ({ name, n })), uids: items.slice(0, 200).map((i) => i.uid) };
}
export const removedDetail = (items) => ({ count: items.length, items: items.slice(0, 100).map((it) => ({ uid: it.uid, name: I.itemName(it), value: I.itemValue(it) })) });
// And about a name staff took off (actions.clearNameForStaff's answer).
export const unnamedDetail = ({ item, name }) => ({ uid: item.uid, item: I.itemName(item), name });
