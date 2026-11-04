// Checks for the admin panel's shared rules (engine/admin.js) and the NPC blocks and rules the offline panel sets
// (engine/npcs.js, the social tick in engine/actions.js).
//   node scripts/test-admin-local.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = (m) => import(new URL(`../src/js/engine/${m}.js`, import.meta.url));
const { D, initData } = await E('data');
initData(JSON.parse(fs.readFileSync(path.join(ROOT, 'src/data/game-data.json'), 'utf8')), { keys: JSON.parse(fs.readFileSync(path.join(ROOT, 'src/data/keys.json'), 'utf8')) });
const AD = await E('admin');
const ACT = await E('actions');
const N = await E('npcs');
const I = await E('items');
const { freshState, upgradeState } = await E('economy');
const { MAX_LEVEL } = await E('levels');
const { mulberry32 } = await E('util');

let failed = 0, passed = 0;
function check(name, ok, info = '') {
  if (ok) passed++; else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`);
}
// The GameError a call throws (null: it didn't).
const refusal = (fn) => { try { fn(); } catch (e) { return e; } return null; };
const refused = (fn, code = 'bad') => { const e = refusal(fn); return e instanceof ACT.GameError && e.code === code; };
const rng = mulberry32(777);
const MIN = 60e3;

// ---- revOf ---------------------------------------------------------------------------------------------------------------
{
  // (what the server hashed before it shared this: node's SHA-256 of the sorted JSON, without inv and social)
  const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
  const canon = (v) => (Array.isArray(v) ? v.map(canon) : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
  const oldRev = (st) => { const { inv: _i, stored: _t, social: _s, ...rest } = st; return crypto.createHash('sha256').update(JSON.stringify(canon(rest))).digest('hex').slice(0, 32); };
  const st = freshState();
  delete st.settings; // (as online states are)
  st.stats.bestName = 'AWP | Dragon Lore ★ 日本 ✓';
  st.money = 1234.56;
  const shuffled = Object.fromEntries(Object.entries(st).reverse());
  check('revOf: the same hash the server made before (node SHA-256), whatever the key order', AD.revOf(st) === oldRev(st) && AD.revOf(shuffled) === AD.revOf(st) && /^[0-9a-f]{32}$/.test(AD.revOf(st)));
  const off = { ...st, settings: { volume: 0.2 }, inv: [{ uid: 'x' }], stored: [{ uid: 'y', su: 'x' }], social: { seed: 1 } };
  check('revOf: leaves out the inventory, what\'s in Storage Units, the NPC world and (offline) the settings; a money change changes it',
    AD.revOf(off) === AD.revOf(st) && AD.revOf({ ...st, money: 1 }) !== AD.revOf(st));
  check('rawView: the state without inv, social and settings', JSON.stringify(Object.keys(AD.rawView(off)).sort()) === JSON.stringify(Object.keys(st).filter((k) => k !== 'inv' && k !== 'stored' && k !== 'social').sort()));
}

// ---- argument checks -----------------------------------------------------------------------------------------------------
{
  check('text: trimmed, NUL dropped, a lone surrogate made well-formed; min and max', AD.text('  a\u0000b ', 'X', 5) === 'ab' && AD.text('x\ud800', 'X', 5) === 'x�'
    && refused(() => AD.text('', 'X', 5)) && AD.text(null, 'X', 5, { min: 0 }) === '' && refused(() => AD.text('123456', 'X', 5)) && refused(() => AD.text(5, 'X', 5)));
  check('int / number / bool / optBool', AD.int(3, 'n', 1, 5) === 3 && refused(() => AD.int(3.5, 'n', 1, 5)) && refused(() => AD.int('3', 'n', 1, 5)) && refused(() => AD.int(6, 'n', 1, 5))
    && AD.number(2.5, 'n', 0, 3) === 2.5 && refused(() => AD.number(Infinity, 'n', 0, 1e9)) && refused(() => AD.number(NaN, 'n', 0, 1))
    && AD.bool(false, 'b') === false && refused(() => AD.bool(1, 'b')) && AD.optBool(undefined, 'b') === false && refused(() => AD.optBool('yes', 'b')));
  check('numbers: only the keys of the spec, each in its range', JSON.stringify(AD.numbers({ a: 1.234, b: 2 }, 'o', { a: [0, 5, false], b: [0, 5, true] })) === '{"a":1.23,"b":2}'
    && refused(() => AD.numbers({ c: 1 }, 'o', { a: [0, 5, false] })) && refused(() => AD.numbers({ b: 1.5 }, 'o', { b: [0, 5, true] })) && refused(() => AD.numbers([], 'o', {})));
  const big = { x: 'y'.repeat(49 * 1024) };
  const j = AD.jsonOf({ s: 'a\udc00' }, 'It');
  check('jsonOf: an object up to 48 KB, without NUL characters, lone surrogates made well-formed', j.value.s === 'a�' && j.json === JSON.stringify(j.value)
    && refused(() => AD.jsonOf([], 'It')) && refused(() => AD.jsonOf(big, 'It')) && refused(() => AD.jsonOf({ s: 'a\u0000' }, 'It')) && refused(() => AD.jsonOf(null, 'It')));
  const e = refusal(() => AD.fail('no'));
  check('fail: throws the game\'s GameError (code bad by default)', e instanceof ACT.GameError && e.code === 'bad' && refusal(() => AD.fail('x', 'perm')).code === 'perm');
}

// ---- edit ----------------------------------------------------------------------------------------------------------------
{
  const st = upgradeState({ money: 10, stars: 2, stats: { opened: 4, gambleWon: 0 } });
  const p = AD.editPlan(st, { money: 12.345, stars: 2, prof: { level: 5 }, stats: { opened: 9, gambleWon: -50 }, rank: { wins: 3 } });
  check('editPlan: money rounded, unchanged fields left out of changed, before/after of what changes', p.next.money === 12.35 && p.next.stars === 2
    && p.changed.join() === 'money,prof.level,stats.opened,stats.gambleWon,rank.wins'
    && p.before.money === 10 && p.after.money === 12.35 && p.before.stats.opened === 4 && p.after.stats.gambleWon === -50 && !('stars' in p.before), p.changed.join(','));
  const bad = [{}, null, [], { money: -1 }, { money: 'x' }, { money: 2e12 }, { stars: 1.5 }, { charmDetach: -1 }, { prof: { level: 0 } }, { prof: { level: MAX_LEVEL + 1 } },
    { prof: { foo: 1 } }, { stats: { bestName: 3 } }, { stats: { opened: -1 } }, { inv: [] }, { settings: {} }, { rank: 5 }];
  const why = bad.map((set) => refusal(() => AD.editPlan(st, set)));
  check('editPlan: refuses nothing to change, unknown fields, wrong types and out-of-range values (code bad)', why.every((x) => x instanceof ACT.GameError && x.code === 'bad'),
    why.map((x) => x?.message).join(' | '));
  const same = AD.editPlan(st, { money: 10, stats: { opened: 4 } });
  check('editPlan: no change, nothing in changed', same.changed.length === 0);
  AD.applyEdit(st, p.next);
  check('applyEdit: an object\'s fields go over the ones it has', st.money === 12.35 && st.stats.opened === 9 && st.stats.gambleWon === -50 && st.stats.sold === 0 && st.prof.level === 5 && Array.isArray(st.prof.drops));
}

// ---- edit.raw ------------------------------------------------------------------------------------------------------------
{
  const cur = freshState(); // (offline: settings and social in the save)
  cur.inv = [{ uid: 'a1', t: 'key', id: Object.keys(D.keys)[0] }];
  cur.loadout = { knife: 'a1' };
  cur.social = N.freshSocial(99, 0);
  cur.settings.volume = 0.13;
  cur.prof.drops = [{ id: 'd1', offers: [{ uid: 'o1' }] }];
  cur.play = { run: 'r1', mode: 'premier', at: 5 };
  cur.mm = { ...cur.mm, match: { mode: 'premier', opponent: 1000, at: 5 } };
  const base = AD.revOf(cur);
  const json = JSON.parse(JSON.stringify(AD.rawView(cur)));
  const r = AD.rawEdit(cur, { ...json, money: 77.777, stars: 4, prof: { ...json.prof, drops: [] }, play: null, mm: { ...json.mm, match: null }, loadout: { knife: 'a1', gloves: 'gone' } }, base);
  check('rawEdit: the fields given replace the old ones; inv and the NPC world are the same objects; changed/before/after', r.next.money === 77.78 && r.next.stars === 4
    && r.next.inv === cur.inv && r.next.social === cur.social && r.changed.includes('money') && r.changed.includes('stars') && r.before.money === 10 && r.after.stars === 4
    && cur.money === 10, r.changed.join(','));
  check('rawEdit: always keeps the rewards waiting, the Play match, the ranked match and the settings; loadout only for owned items',
    r.next.prof.drops === cur.prof.drops && r.next.play === cur.play && r.next.mm.match === cur.mm.match && r.next.settings === cur.settings
    && JSON.stringify(r.next.loadout) === '{"knife":"a1"}' && !r.changed.includes('settings') && !r.changed.includes('play') && !r.changed.includes('prof'), r.changed.join(','));
  const stale = refusal(() => AD.rawEdit(cur, json, 'nope')), noBase = refusal(() => AD.rawEdit(cur, json));
  check("rawEdit: a base that isn't the state's rev is refused ('stale'), and none", stale?.code === 'stale' && noBase?.code === 'stale');
  const bad = [{ inv: [] }, { social: {} }, { settings: {} }, { nope: 1 }, { money: 'lots' }, { money: -1 }, { money: 2e12 }, { stars: Infinity },
    { stats: { 'bad key': 1 } }, { prof: { 'x-y': 1 } }, { loadout: [] }, { x: 'y'.repeat(49 * 1024) }];
  const why = bad.map((x) => refusal(() => AD.rawEdit(cur, { ...json, ...x }, base)));
  check('rawEdit: refuses inv/social/settings, unknown fields, wrong types, out of range, field names that aren\'t identifiers, over 48 KB (code bad)',
    why.every((x) => x instanceof ACT.GameError && x.code === 'bad'), why.map((x) => x?.message).join(' | '));
  const none = AD.rawEdit(cur, json, base);
  check('rawEdit: the same JSON back changes nothing', none.changed.length === 0, none.changed.join(','));
  const live = structuredClone(cur);
  AD.replaceInPlace(live, r.next);
  check('replaceInPlace + rev: the new state has another rev; the old base is stale now', AD.revOf(live) !== base && refusal(() => AD.rawEdit(live, json, base))?.code === 'stale'
    && AD.rawEdit(live, { ...json, stars: 1 }, AD.revOf(live)).next.stars === 1);
  const gone = { ...structuredClone(cur), extra: 1 };
  AD.replaceInPlace(gone, { money: 1 });
  check('replaceInPlace: keys the new state hasn\'t go', JSON.stringify(gone) === '{"money":1}');
  // (an own __proto__ key, as JSON.parse makes one from the panel's text: it would set the save's prototype)
  const proto = JSON.parse(`{"__proto__":{"polluted":"yes"},${JSON.stringify(json).slice(1)}`);
  const pe = refusal(() => AD.rawEdit(cur, proto, base));
  const target = { a: 1 };
  AD.replaceInPlace(target, JSON.parse('{"__proto__":{"polluted":"yes"},"b":2}'));
  check('rawEdit refuses a __proto__ field (code bad); replaceInPlace leaves one out, the prototype stays', pe?.code === 'bad' && /Unknown field: __proto__/.test(pe.message)
    && Object.getPrototypeOf(target) === Object.prototype && target.polluted === undefined && JSON.stringify(target) === '{"b":2}', pe?.message);
}

// ---- restoring a snapshot ------------------------------------------------------------------------------------------------
{
  const cur = freshState();
  cur.settings.volume = 0.9;
  cur.inv = [{ uid: 'claimed', t: 'key', id: Object.keys(D.keys)[0] }];
  cur.play = { run: 'now', mode: 'deathmatch', at: 1 };
  cur.mm = { ...cur.mm, match: { mode: 'competitive', opponent: 1, at: 1 } };
  const key = Object.keys(D.keys)[0];
  const snap = upgradeState({
    money: 5, inv: [{ uid: 'k1', t: 'key', id: key }, { uid: 'k1', t: 'key', id: key }, { uid: 'k2', t: 'key', id: key }, { uid: 'away', t: 'key', id: key }, { uid: 'ch', t: 'chicken', id: 'golden', hat: 'none', fl: 0.5 }],
    loadout: { a: 'k2', b: 'away' }, prof: { drops: [{ id: 'old', offers: [{ uid: 'claimed' }] }, { id: 'new', offers: [{ uid: 'fresh' }] }] }, play: null, mm: { match: null },
  });
  check('restoreUids: the snapshot\'s items and its rewards\' items', ['k1', 'k2', 'away', 'ch', 'claimed', 'fresh'].every((u) => AD.restoreUids(snap).includes(u)));
  const a = structuredClone(snap);
  const res = AD.restoreMerge(cur, a, { elsewhere: new Set(['away']) });
  check('restoreMerge: retired items sold, no item twice, none owned elsewhere, a reward claimed since left out; loadout fitted',
    res.rewards === 1 && res.dropped === 3 && a.inv.map((i) => i.uid).join() === 'k1,k2' && a.money === 5 + I.itemValue({ t: 'chicken', id: 'golden', hat: 'none', fl: 0.5 }) && a.stats.sold > 0 && a.prof.drops.map((d) => d.id).join() === 'new'
    && JSON.stringify(a.loadout) === '{"a":"k2"}', JSON.stringify(res));
  check('restoreMerge: keeps the settings, the Play match and the ranked match being played', a.settings === cur.settings && a.play === cur.play && a.mm.match === cur.mm.match);
  const b = structuredClone(snap);
  const res2 = AD.restoreMerge(cur, b, { keepRewards: true });
  check('restoreMerge, keepRewards (offline): the rewards stay as saved', res2.rewards === 0 && b.prof.drops.length === 2 && b.inv.length === 3 && res2.dropped === 1);
  const online = structuredClone(snap);
  AD.restoreMerge({ ...freshState(), settings: undefined }, online);
  check('restoreMerge: online (no settings in the state), the restored state has none', !('settings' in online));
}

// ---- items.give / items.remove -------------------------------------------------------------------------------------------
{
  const skins = Object.values(D.skins);
  const st = skins.find((s) => !s.v && s.stt && s.cat !== 'gloves' && s.svp == null && s.mn < 0.1);
  const vanilla = skins.find((s) => s.v);
  const noStt = skins.find((s) => !s.stt && !s.v);
  const sv = skins.find((s) => s.svp != null && !s.v);
  const crate = D.cases.find((c) => c.price != null), key = Object.keys(D.keys)[0], sticker = Object.values(D.stickers)[0], agent = Object.values(D.agents)[0], charm = Object.values(D.charms || {})[0];
  const spec = AD.itemSpec({ t: 'skin', id: st.id, fl: 0.05, sd: 661, stt: true, n: 2 });
  const it = spec.make();
  check('itemSpec: a skin with float, seed and StatTrak™, from "Admin"', spec.n === 2 && Math.abs(it.fl - 0.05) < 1e-6 && it.sd === 661 && it.stt === true && it.src === 'Admin' && it.t === 'skin');
  const bad = [null, { t: 'chicken', id: 'x' }, { t: 'skin', id: 'nope' }, { t: 'skin', id: st.id, fl: 2 }, { t: 'skin', id: vanilla.id, fl: 0.1 }, { t: 'skin', id: vanilla.id, sd: 1 },
    { t: 'skin', id: noStt.id, stt: true }, { t: 'skin', id: st.id, sv: true }, { t: 'skin', id: sv.id, stt: !!sv.stt, sv: true }, { t: 'skin', id: st.id, sd: 1001 },
    { t: 'skin', id: st.id, n: 0 }, { t: 'skin', id: st.id, n: 101 }, { t: 'crate', id: 'nope' }, { t: 'key', id: 'nope' }, { t: 'sticker', id: 'nope' }, { t: 'agent', id: 'nope' },
    { t: 'charm', id: 'nope' }, { t: 'skin', id: '' }, { t: 'skin', id: st.id, stt: 'yes' }].filter((x) => !(x?.sv && x.stt === false));
  const why = bad.map((x) => refusal(() => AD.itemSpec(x)));
  check('itemSpec: unknown kinds and ids, floats and seeds out of range or on a vanilla knife, StatTrak™/Souvenir a skin hasn\'t, counts out of 1-100 refused',
    why.every((x) => x instanceof ACT.GameError && x.code === 'bad'), why.map((x) => x?.message).join(' | '));
  check('itemSpec: a case, a key, a sticker, an agent, a charm with its pattern', AD.itemSpec({ t: 'crate', id: crate.id }).make().t === 'crate' && AD.itemSpec({ t: 'key', id: key }).make().t === 'key'
    && AD.itemSpec({ t: 'sticker', id: sticker.id }).make().t === 'sticker' && AD.itemSpec({ t: 'agent', id: agent.id }).make().t === 'agent'
    && (!charm || AD.itemSpec({ t: 'charm', id: charm.id, pat: 77 }).make().pat === 77));
  check('giveSpecs: 1 to 50 entries, and how many copies in all', refused(() => AD.giveSpecs([])) && refused(() => AD.giveSpecs(Array(51).fill({ t: 'key', id: key }))) && refused(() => AD.giveSpecs('x'))
    && AD.giveSpecs([{ t: 'key', id: key, n: 3 }, { t: 'skin', id: st.id }]).total === 4);
  // Offline: the save's own counters, continued (replaced, not changed in place).
  const save = freshState();
  const k = I.serialKey({ t: 'skin', id: st.id, stt: true });
  save.serials = { [k]: 7 };
  const was = save.serials;
  const { specs } = AD.giveSpecs([{ t: 'skin', id: st.id, stt: true, n: 2 }, { t: 'sticker', id: sticker.id }, { t: 'crate', id: crate.id }, { t: 'key', id: key }, { t: 'agent', id: agent.id }]);
  const items = AD.buildItems(specs, AD.localSerial(save));
  const sk = items.filter((i) => i.t === 'skin');
  check('buildItems + localSerial: skins, stickers and agents numbered by the save\'s counters (continued), cases and keys not; all new',
    items.length === 6 && sk.map((i) => i.sn).join() === '8,9' && save.serials[k] === 9 && items.find((i) => i.t === 'sticker').sn === 1 && items.find((i) => i.t === 'agent').sn === 1
    && items.filter((i) => i.t === 'crate' || i.t === 'key').every((i) => i.sn == null) && items.every((i) => i.nw === true && i.src === 'Admin') && was[k] === 7 && new Set(items.map((i) => i.uid)).size === 6,
    items.map((i) => `${i.t}#${i.sn ?? '-'}`).join(' '));
  const keys = [];
  AD.buildItems(AD.giveSpecs([{ t: 'skin', id: st.id }, { t: 'key', id: key }]).specs, (x) => { keys.push(x); return 42; });
  check('buildItems: asks serial(key) once per numbered item, with its serialKey', keys.length === 1 && keys[0] === I.serialKey({ t: 'skin', id: st.id, stt: false }));
  check('removeUids: 1 to 3,000 item ids of at most 64 characters', JSON.stringify(AD.removeUids(['a', 'b'])) === '["a","b"]' && refused(() => AD.removeUids([])) && refused(() => AD.removeUids([1]))
    && refused(() => AD.removeUids(['x'.repeat(65)])) && refused(() => AD.removeUids([''])) && refused(() => AD.removeUids(Array(3001).fill('a'))) && refused(() => AD.removeUids('a')));
  const gd = AD.givenDetail(items), rd = AD.removedDetail(items);
  check('givenDetail / removedDetail: the audit row\'s count, names and uids', gd.count === 6 && gd.items.find((x) => x.n === 2)?.name === I.itemName(sk[0]) && gd.uids.length === 6
    && rd.count === 6 && rd.items[0].uid === items[0].uid && rd.items[0].value === I.itemValue(items[0]) && AD.worthOf(items) === Math.round(items.reduce((s, i) => s + I.itemValue(i), 0) * 100) / 100);
}

// ---- NPC blocks -----------------------------------------------------------------------------------------------------------
// A save with things the NPCs want, its NPC world made by a first tick.
const skinsOver = (lo, hi) => Object.values(D.skins).filter((s) => !s.v && !s.star && s.p.FT?.[0] >= lo && s.p.FT?.[0] <= hi);
function world(seedRng = 1) {
  const r = mulberry32(seedRng);
  const st = freshState();
  st.money = 1000;
  for (const s of skinsOver(30, 150).slice(0, 12)) st.inv.push({ ...I.makeSkinItem(s, { r, src: 'Trade', fl: 0.2 }), at: 0 });
  let now = 1.8e12;
  const r2 = mulberry32(seedRng + 1);
  const run = (name, args = {}) => ACT.runAction(ACT.makeCtx(st, { rng: r2, now }), name, args);
  run('npc.tick');
  return { st, run, at: () => now, step: (ms = 10 * MIN) => { now += ms; return now; } };
}
// What the NPCs did in one tick at `now`: offers, market buys, messages (friend requests, chat), by NPC id.
function did(so, now) {
  const out = { offers: [], buys: [], requests: [], chat: [], msgs: [] };
  for (const o of so.offers) if (o.at === now) out.offers.push(o.npc);
  for (const f of so.feed) if (f.at === now) out.buys.push(f.npc);
  for (const [id, t] of Object.entries(so.threads)) {
    for (const m of t) {
      if (m.at !== now || m.from !== 'npc') continue;
      out.msgs.push(id);
      if (m.request) out.requests.push(id);
      else if (!m.offer) out.chat.push(id);
    }
  }
  return out;
}
const declineAll = (w) => { for (const o of w.st.social.offers.filter((x) => x.status === 'open')) w.run('npc.decline', { offer: o.id }); };

{
  const w = world(3);
  const so = w.st.social, people = N.activeCrowd(so.seed);
  const blocked = people.filter((_, i) => i % 2 === 0).map((n) => n.id), free = people.filter((_, i) => i % 2 === 1).map((n) => n.id);
  const B = new Set(blocked);
  for (const id of Object.keys(so.npcs)) so.npcs[id].friend = 0;
  for (let i = 0; i < 10; i++) { N.npcState(so, blocked[i]).friend = 1; N.npcState(so, free[i]).friend = 1; }
  for (let i = 10; i < 15; i++) { N.npcState(so, blocked[i]).friend = 3; N.npcState(so, free[i]).friend = 3; }
  // An offer open from one about to be blocked.
  so.offers.push({ id: 'pre', npc: blocked[0], kind: 'buy', at: w.at(), exp: w.at() + 60 * MIN, status: 'open', want: { uids: [w.st.inv[0].uid], money: 0 }, give: { uids: [], money: 5 },
    max: 5, patience: 3, annoy: 0, args: [], agreed: false });
  const t0 = w.at();
  const results = blocked.map((id) => N.blockNpc(so, id, { reason: 'test', by: 'tester' }, t0));
  check('blockNpc: blocks (for good), cancels their open offers', results.every((x) => x && x.block.expires === null && x.block.reason === 'test' && x.block.by === 'tester' && x.block.at === t0)
    && results[0].cancelled === 1 && so.offers.find((o) => o.id === 'pre').status === 'cancelled' && blocked.every((id) => N.isBlocked(so, id, t0 + 1e12))
    && N.activeBlocks(so, t0).length === 33 && N.blockOf(so, free[0], t0) === null);
  check('blockNpc / resetNpc: only one of the crowd (null for you and for ids that aren\'t)', N.blockNpc(so, 'me', {}, t0) === null && N.blockNpc(so, 'n99999', {}, t0) === null
    && N.resetNpc(so, 'me') === null && !('me' in so.blocked));
  check("npcOf: a trader by their own id only ('n7', not 'n007': a block or an entry under it would be nobody's)", N.npcOf(so.seed, 'n7')?.id === 'n7' && N.npcOf(so.seed, 'n0')?.id === 'n0'
    && N.npcOf(so.seed, 'n007') === null && N.npcOf(so.seed, 'n07') === null && N.blockNpc(so, 'n007', {}, t0) === null && !('n007' in so.blocked));
  const tot = { B: { offers: 0, buys: 0, requests: 0, chat: 0, msgs: 0 }, F: { offers: 0, buys: 0, requests: 0, chat: 0, msgs: 0 } };
  for (let k = 0; k < 300; k++) {
    const now = w.step();
    w.run('npc.tick');
    const d = did(w.st.social, now);
    for (const key of Object.keys(d)) for (const id of d[key]) tot[B.has(id) ? 'B' : 'F'][key]++;
    declineAll(w);
  }
  const s2 = w.st.social;
  check('a blocked NPC makes no offer, market buy, friend request or chat over 300 ticks', Object.values(tot.B).every((n) => n === 0), JSON.stringify(tot.B));
  check('the others still do all of those', tot.F.offers > 10 && tot.F.buys > 50 && tot.F.requests > 3 && tot.F.chat > 10, JSON.stringify(tot.F));
  check('a blocked NPC you sent a friend request to never answers it; the others do', blocked.slice(10, 15).every((id) => s2.npcs[id].friend === 3) && free.slice(10, 15).every((id) => s2.npcs[id].friend !== 3)
    && blocked.slice(15).every((id) => (s2.npcs[id]?.friend || 0) === 0));
  const before = JSON.stringify(w.st);
  const mine = w.st.inv[0], theirs = N.npcState(s2, blocked[1]).inv[0];
  const e1 = refusal(() => w.run('npc.offer', { npc: blocked[1], give: { money: 50 }, get: { uids: [theirs.uid] } }));
  const e2 = refusal(() => w.run('npc.say', { npc: blocked[1], text: 'hey' }));
  const e3 = refusal(() => w.run('npc.offer', { npc: blocked[1], give: { uids: [mine.uid] } }));
  check("your offer or message to a blocked NPC is refused ('blocked'), and nothing changes", e1?.code === 'blocked' && e2?.code === 'blocked' && e3?.code === 'blocked'
    && e1 instanceof ACT.GameError && JSON.stringify(w.st) === before, e1?.message);
  const ok = w.run('npc.say', { npc: free[1], text: 'hey' });
  check('…and to one not blocked, it goes', typeof ok.reply === 'string' && ok.reply.length > 0);
  // Lifting a block: they're back.
  const lifted = N.unblockNpc(s2, blocked[0]);
  check('unblockNpc: returns the block lifted (null when there was none)', lifted?.reason === 'test' && !N.isBlocked(s2, blocked[0], w.at()) && N.unblockNpc(s2, blocked[0]) === null);
  // Their friend request from before the block, and an offer of theirs still open (one a save brought in): not taken.
  const s3 = w.st.social, b2 = blocked[2];
  N.npcState(s3, b2).friend = 2;
  s3.offers.push({ id: 'late', npc: b2, kind: 'buy', at: w.at(), exp: w.at() + 60 * MIN, status: 'open', want: { uids: [mine.uid], money: 0 }, give: { uids: [], money: 5 },
    max: 5, patience: 3, annoy: 0, args: [], agreed: false });
  const before2 = JSON.stringify(w.st);
  const f = [refusal(() => w.run('npc.friend', { npc: b2, on: true })), refusal(() => w.run('npc.accept', { offer: 'late' })), refusal(() => w.run('npc.counter', { offer: 'late', price: 10 }))];
  check("accepting a blocked NPC's friend request or offer, or haggling with them, is refused ('blocked'): no message from them, nothing changes",
    f.every((e) => e?.code === 'blocked') && JSON.stringify(w.st) === before2, f.map((e) => e?.code).join());
  w.run('npc.friend', { npc: b2, on: false });
  check('…unfriending them still works', w.st.social.npcs[b2].friend === 0);
}

{
  // What you sell on the Market: only to an NPC not blocked, and to nobody with the market rule off.
  const w = world(5);
  const so = w.st.social, people = N.activeCrowd(so.seed);
  for (const n of people.slice(1)) N.blockNpc(so, n.id, { minutes: 60 }, w.at());
  const it = w.st.inv[0];
  w.run('item.sell', { uids: [it.uid] });
  const owner = Object.entries(w.st.social.npcs).filter(([, s]) => s.inv.some((x) => x.uid === it.uid)).map(([id]) => id);
  check('selling: what you sell goes to an NPC who isn\'t blocked', owner.length === 1 && owner[0] === people[0].id, owner.join());
  w.st.social.rules = { market: false };
  const it2 = w.st.inv[0];
  w.run('item.sell', { uids: [it2.uid] });
  check('selling: with the market rule off, no NPC gets it', !Object.values(w.st.social.npcs).some((s) => s.inv.some((x) => x.uid === it2.uid)) && !w.st.inv.some((x) => x.uid === it2.uid));
}

{
  // Expiry: everyone blocked for 30 minutes: nothing happens; past it, the tick sweeps the blocks and they're back.
  const w = world(7);
  const so = w.st.social, people = N.activeCrowd(so.seed);
  const t0 = w.at();
  for (const n of people) N.blockNpc(so, n.id, { minutes: 30, reason: 'cool off' }, t0);
  for (const n of people.slice(0, 6)) N.npcState(so, n.id).friend = 1;
  check('a block for 30 minutes: in force until then, not after', N.isBlocked(so, people[0].id, t0 + 29 * MIN) && !N.isBlocked(so, people[0].id, t0 + 30 * MIN)
    && so.blocked[people[0].id].expires === t0 + 30 * MIN);
  let during = 0;
  for (let k = 0; k < 2; k++) { const now = w.step(); w.run('npc.tick'); const d = did(w.st.social, now); during += d.offers.length + d.buys.length + d.msgs.length; }
  check('…nobody does anything while they\'re all blocked', during === 0 && Object.keys(w.st.social.blocked).length === people.length);
  let after = { offers: 0, buys: 0, msgs: 0 };
  for (let k = 0; k < 20; k++) {
    const now = w.step(); w.run('npc.tick');
    const d = did(w.st.social, now);
    after = { offers: after.offers + d.offers.length, buys: after.buys + d.buys.length, msgs: after.msgs + d.msgs.length };
    declineAll(w);
  }
  check('…and once it lapses, the tick sweeps the blocks and they\'re back', Object.keys(w.st.social.blocked).length === 0 && after.offers > 0 && after.buys > 0, JSON.stringify(after));
  const s = w.st.social;
  N.blockNpc(s, people[0].id, { minutes: 5 }, w.at());
  check('activeBlocks / sweepBlocks: lapsed ones aren\'t counted, then go', N.activeBlocks(s, w.at()).length === 1 && N.activeBlocks(s, w.at() + 6 * MIN).length === 0
    && N.sweepBlocks(s, w.at() + 6 * MIN) === 1 && !(people[0].id in s.blocked));
}

{
  // resetNpc: back to how the seed made them, their open offers cancelled.
  const w = world(9);
  const so = w.st.social, n = N.activeCrowd(so.seed)[4];
  const start = N.startingState(so.seed, n);
  const s = N.npcState(so, n.id);
  s.money = 1;
  s.inv = [];
  s.friend = 1;
  so.offers.push({ id: 'o9', npc: n.id, kind: 'buy', at: w.at(), exp: w.at() + 60 * MIN, status: 'open', want: { uids: [], money: 0 }, give: { uids: [], money: 5 }, max: 5, patience: 3, annoy: 0, args: [], agreed: false });
  N.post(so, n.id, 'npc', 'hi', {}, w.at());
  const r = N.resetNpc(so, n.id);
  const again = N.npcState(so, n.id);
  check('resetNpc: their money, inventory and friendship back to the start; offers cancelled; your chat with them stays', r.cancelled === 1 && so.offers.find((o) => o.id === 'o9').status === 'cancelled'
    && again.money === start.money && again.inv.length === start.inv.length && again.inv.map((i) => i.id).join() === start.inv.map((i) => i.id).join() && again.friend === 0 && so.threads[n.id].length > 0);
}

// ---- the offline rules ----------------------------------------------------------------------------------------------------
{
  const so0 = N.freshSocial(1, 0);
  check('ruleOn: every rule on when there are none (or no NPC world)', N.NPC_RULES.every((k) => N.ruleOn(so0, k) && N.ruleOn(null, k)) && N.ruleOn({ rules: { market: true } }, 'market')
    && !N.ruleOn({ rules: { chat: false } }, 'chat') && N.ruleOn({ rules: { chat: false } }, 'trading') && !N.isBlocked(null, 'n1') && N.activeBlocks(null).length === 0);
  const run50 = (rules, setup = () => {}) => {
    const w = world(11);
    const so = w.st.social;
    so.rules = rules;
    for (const n of N.activeCrowd(so.seed).slice(0, 12)) N.npcState(so, n.id).friend = 1;
    for (const n of N.activeCrowd(so.seed).slice(12, 16)) N.npcState(so, n.id).friend = 3;
    setup(w);
    const tot = { offers: 0, buys: 0, requests: 0, chat: 0 };
    const market0 = JSON.stringify(w.st.market || {});
    for (let k = 0; k < 80; k++) {
      const now = w.step(); w.run('npc.tick');
      const d = did(w.st.social, now);
      for (const key of Object.keys(tot)) tot[key] += d[key].length;
      declineAll(w);
    }
    const pending = N.activeCrowd(so.seed).slice(12, 16).filter((n) => w.st.social.npcs[n.id].friend === 3).length;
    return { tot, pending, marketSame: JSON.stringify(w.st.market || {}) === market0 };
  };
  const all = run50(undefined);
  check('rules: all on (none set), they offer, buy, send friend requests, chat and answer yours', all.tot.offers > 0 && all.tot.buys > 0 && all.tot.requests > 0 && all.tot.chat > 0 && all.pending === 0, JSON.stringify(all));
  const noTrade = run50({ trading: false });
  check('rules: trading off, no offers to you (the rest goes on)', noTrade.tot.offers === 0 && noTrade.tot.buys > 0 && noTrade.tot.chat > 0, JSON.stringify(noTrade));
  const noMarket = run50({ market: false });
  check('rules: market off, no market buys (the market as it was; the rest goes on)', noMarket.tot.buys === 0 && noMarket.marketSame && noMarket.tot.offers > 0 && noMarket.tot.chat > 0, JSON.stringify(noMarket));
  const noChat = run50({ chat: false });
  check('rules: chat off, no friend requests, no chat, your requests wait (offers and buying go on)', noChat.tot.requests === 0 && noChat.tot.chat === 0 && noChat.pending === 4
    && noChat.tot.offers > 0 && noChat.tot.buys > 0, JSON.stringify(noChat));
}

// ---- a save file (save.import offline) ------------------------------------------------------------------------------------
{
  // A save the game made: its NPC world after a while (offers, chats, market buys, a block, the rules), a level-up reward
  // waiting, your profile.
  const w = world(11);
  for (let k = 0; k < 40; k++) { w.step(); w.run('npc.tick'); }
  const bid = N.activeCrowd(w.st.social.seed)[3].id;
  N.blockNpc(w.st.social, bid, { minutes: 60, reason: 'spam', by: 'tester' }, w.at());
  w.st.social.rules = { chat: false };
  w.st.prof.drops = [{ id: 'd1', at: 1, level: 2, offers: [I.makeSkinItem(skinsOver(1, 5)[0], { r: rng, src: 'Level up' })] }];
  w.run('persona.set', { name: 'Me', bio: "it's me", country: 'DE', showcase: [w.st.inv[0].uid] });
  const so = w.st.social, json = JSON.stringify(w.st);
  check('saveFile: a save the game made comes back as it was (export, then import)', JSON.stringify(AD.saveFile(JSON.parse(json), w.at())) === json
    && so.offers.length > 0 && Object.keys(so.threads).length > 0 && so.feed.length > 0, `${so.offers.length} offers, ${so.feed.length} feed`);
  check("saveFile: a snapshot's download ({ state, config }) is taken as its state; a save from before the NPCs too",
    JSON.stringify(AD.saveFile({ id: 1, label: 'x', state: JSON.parse(json), config: { game: {} } }, w.at())) === json && AD.saveFile({ money: 5, inv: [] }).money === 5);
  const mut = (fn) => { const v = JSON.parse(json); fn(v); return refusal(() => AD.saveFile(v, w.at())); };
  const first = (o) => Object.keys(o)[0];
  const bad = {
    'no money': (v) => { delete v.money; }, 'offers [null]': (v) => { v.social.offers = [null]; }, 'a trader null': (v) => { v.social.npcs[first(v.social.npcs)] = null; },
    'tier as text': (v) => { v.social.npcs[first(v.social.npcs)].tier = 'x'; }, 'blocked as text': (v) => { v.social.blocked = 'x'; },
    'a block on nobody': (v) => { v.social.blocked.zz = { at: 1, expires: null }; }, 'a block on n007': (v) => { v.social.blocked.n007 = { at: 1, expires: null }; },
    'a uid with markup': (v) => { v.inv[0].uid = '"><img src=x onerror=alert(1)>'; }, 'an item of no kind': (v) => { v.inv[0].t = 'zzz'; },
    'an unknown skin': (v) => { v.inv[0].id = 'nope'; }, 'a serial as text': (v) => { v.inv[0].sn = '<b>1</b>'; }, 'a reward item': (v) => { v.prof.drops[0].offers[0].uid = 5; },
    'level as text': (v) => { v.prof.level = '<img src=x>'; }, 'stats.opened as text': (v) => { v.stats.opened = '9'; }, 'loadout as text': (v) => { v.loadout = 'x'; },
    'drops as text': (v) => { v.prof.drops = 'x'; }, 'a thread as text': (v) => { v.social.threads[first(v.social.threads)] = 'x'; },
    'a rule not true/false': (v) => { v.social.rules = { chat: 'no' }; }, 'a feed line of nobody': (v) => { v.social.feed[0].npc = 'me'; },
  };
  const why = Object.entries(bad).map(([k, fn]) => [k, mut(fn)]);
  check("saveFile: refuses what the game doesn't write (code bad)", why.every(([, e]) => e instanceof ACT.GameError && e.code === 'bad'),
    why.filter(([, e]) => !(e instanceof ACT.GameError && e.code === 'bad')).map(([k, e]) => `${k}: ${e?.message ?? 'taken'}`).join(', '));
  const v = JSON.parse(json);
  Object.assign(v.social.me, { name: '<img src=x onerror="alert(1)">', bio: '<script>x</script> "quoted"' });
  v.inv[0].src = '"><svg onload=alert(1)>';
  v.stats['<b>x</b>'] = 1;
  const c = AD.saveFile(JSON.parse(`{"__proto__":{"polluted":1},${JSON.stringify(v).slice(1)}`), w.at());
  check("saveFile: every text loses < and > and its \" (made '); __proto__ keys go", !/[<>]|\\"/.test(JSON.stringify(c)) && c.social.me.name === "img src=x onerror='alert(1)'"
    && c.inv[0].src === "'svg onload=alert(1)" && c.stats['bx/b'] === 1 && !Object.hasOwn(c, '__proto__') && Object.getPrototypeOf(c) === Object.prototype, c.social.me.name);
  const thin = JSON.parse(json);
  for (const k of ['threads', 'unread', 'feed', 'comments', 'me']) delete thin.social[k];
  const t = AD.saveFile(thin, w.at());
  const tick = refusal(() => ACT.runAction(ACT.makeCtx(t, { rng, now: w.at() + 6 * 3600e3 }), 'npc.tick'));
  check("saveFile: an NPC world without chats, feed or profile gets empty ones, and the NPCs' tick runs on it", tick === null && Array.isArray(t.social.threads[first(t.social.threads)] || [])
    && Array.isArray(t.social.feed) && Array.isArray(t.social.comments) && t.social.me.name === '', tick?.message);
  const o = JSON.parse(json);
  o.social.offers.push({ id: 'imp', npc: bid, kind: 'buy', at: w.at(), exp: w.at() + 60 * MIN, status: 'open', want: { uids: [], money: 0 }, give: { uids: [], money: 5 }, max: 5, patience: 3, annoy: 0, args: [], agreed: false });
  check("saveFile: a blocked trader's open offer in it is cancelled", AD.saveFile(o, w.at()).social.offers.find((x) => x.id === 'imp').status === 'cancelled');
}

// ---- Storage Units in the admin rules --------------------------------------------------------------------------------------
{
  const SU = await E('storage');
  const skin = Object.values(D.skins).find((s) => !s.v && !s.star);
  const stickerDef = Object.values(D.stickers)[0];
  const box = () => {
    const unit = { ...I.makeUnitItem('Store'), name: 'stash', mod: 5 };
    const a = I.makeSkinItem(skin, { r: rng }), b = I.makeStickerItem(stickerDef, 'x');
    const kept = { ...I.makeSkinItem(skin, { r: rng }), su: unit.uid, sat: 5 }, kept2 = { ...I.makeStickerItem(stickerDef, 'x'), su: unit.uid, sat: 6 };
    return { st: { ...freshState(), inv: [unit, a, b], stored: [kept, kept2] }, unit, a, b, kept, kept2 };
  };

  // items.give / items.remove
  const spec = AD.itemSpec({ t: 'unit', id: I.UNIT_ID, n: 2 });
  check('items.give: staff can give Storage Units; another id is refused', spec.n === 2 && spec.unit === true && spec.make().t === 'unit' && refused(() => AD.itemSpec({ t: 'unit', id: 'nope' })));
  const built = AD.buildItems(AD.giveSpecs([{ t: 'unit', id: I.UNIT_ID }]).specs, () => 1);
  check('items.give: a unit has no serial number and arrives unlabelled', built.length === 1 && built[0].sn === undefined && built[0].name === undefined && built[0].nw === true);
  {
    const { st, kept, a } = box();
    const ctx = ACT.makeCtx(st);
    const items = ACT.takeForStaff(ctx, [kept.uid, a.uid]);
    const d = ACT.delta(ctx);
    check('items.remove: staff reach items in a unit and the inventory in one go', items.length === 2 && !SU.storedItem(st, kept.uid) && !st.inv.includes(a) && d.sto.del.includes(kept.uid) && d.del.includes(a.uid));
  }
  {
    const { st, unit, kept, kept2 } = box();
    const e = refusal(() => ACT.takeForStaff(ACT.makeCtx(st), [unit.uid]));
    check('items.remove: a unit that still holds items is refused, and nothing moved', e?.code === 'unit' && /2 items/.test(e.message) && st.inv.includes(unit) && st.stored.length === 2);
    check('items.remove: a unit goes with everything in it', ACT.takeForStaff(ACT.makeCtx(st), [unit.uid, kept.uid, kept2.uid]).length === 3 && !st.inv.includes(unit) && !st.stored.length);
  }
  {
    const { st, a, kept } = box();
    const ctx = ACT.makeCtx({ ...st }, { reserved: new Set([a.uid]) });
    check('items.remove: an item in an open offer still refuses it all (nothing out of the unit either)', refused(() => ACT.takeForStaff(ctx, [kept.uid, a.uid]), 'reserved') && !!SU.storedItem(ctx.st, kept.uid));
  }

  // edit.raw
  {
    const { st } = box();
    delete st.settings;
    check('edit.raw: what\'s in Storage Units is out of its reach, as the inventory is', refused(() => AD.rawEdit(st, { stored: [] }, AD.revOf(st))));
    const r = AD.rawEdit(st, { ...AD.rawView(st), money: 77 }, AD.revOf(st));
    check('edit.raw: it keeps what\'s in the units, and doesn\'t list it as changed', r.next.stored.length === 2 && r.next.money === 77 && !r.changed.includes('stored') && !('stored' in AD.rawView(r.next)));
    check('revOf: storing an item doesn\'t stale an open raw edit, a rename of the money does', AD.revOf({ ...st, stored: [] }) === AD.revOf(st) && AD.revOf({ ...st, money: 1 }) !== AD.revOf(st));
  }

  // restoring a snapshot
  {
    const { st, kept, kept2, unit } = box();
    check('restoreUids: a snapshot\'s stored items are looked for elsewhere too', AD.restoreUids(st).includes(kept.uid));
    const next = upgradeState(structuredClone(st)), cur = freshState();
    const r = AD.restoreMerge(cur, next, { elsewhere: new Set([kept.uid]) });
    check('restoreMerge: a stored item owned elsewhere now is left out; the rest of the unit comes back', r.dropped === 1 && next.stored.length === 1 && next.stored[0].uid === kept2.uid && next.inv.some((i) => i.uid === unit.uid));
    const lost = upgradeState(structuredClone(st));
    const r2 = AD.restoreMerge(freshState(), lost, { elsewhere: new Set([unit.uid]) });
    check('restoreMerge: a unit left out gives its items back to the inventory, nothing is lost', r2.dropped === 1 && !lost.stored.length && lost.inv.some((i) => i.uid === kept.uid) && lost.inv.some((i) => i.uid === kept2.uid) && lost.inv.every((i) => i.su === undefined));
  }

  // save files
  {
    const { st, kept, unit } = box();
    const file = JSON.parse(JSON.stringify(st));
    const c = AD.saveFile(file);
    const up = upgradeState(c);
    check('saveFile: a save with Storage Units loads, what\'s stored still stored', up.stored.length === 2 && up.inv.find((i) => i.uid === unit.uid)?.name === 'stash' && SU.storedItem(up, kept.uid)?.su === unit.uid);
    const noUnit = JSON.parse(JSON.stringify(st));
    noUnit.stored[0].su = 'gone';
    const orphan = upgradeState(AD.saveFile(noUnit));
    check('saveFile: an item stored in a unit the save lacks goes to the inventory', orphan.stored.length === 1 && orphan.inv.some((i) => i.uid === kept.uid));
    const bad = (mutate) => { const v = JSON.parse(JSON.stringify(st)); mutate(v); return refused(() => AD.saveFile(v)); };
    check('saveFile: refused when stored is no list, an item in it is broken, or a unit\'s label or date isn\'t one', bad((v) => { v.stored = {}; }) && bad((v) => { v.stored[0].su = '<x>"'; delete v.stored[0].su; })
      && bad((v) => { v.stored[0].id = 'nope'; }) && bad((v) => { v.inv[0].name = 5; }) && bad((v) => { v.inv[0].mod = 'soon'; }));
    const xss = JSON.parse(JSON.stringify(st));
    xss.inv[0].name = '<img src=x onerror="alert(1)">';
    const clean = upgradeState(AD.saveFile(xss)).inv[0].name;
    check('saveFile: a label loses < > and quotes, and is cut to a label\'s length', !/[<>"]/.test(clean) && clean.length <= SU.UNIT_NAME_MAX, clean);
  }
  check('worthOf counts what you give it: the panels hand it everything owned', (() => { const { st, kept } = box(); return AD.worthOf(SU.ownedItems(st)) === SU.ownedValue(st) && SU.ownedValue(st) >= I.itemValue(kept); })());
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
