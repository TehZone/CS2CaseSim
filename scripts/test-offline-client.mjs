// The game's offline side, as the real modules run it (with the real state and game data; the page's globals are
// stand-ins and nothing goes on the network): the admin panel offline is every player's, for their own offline save,
// and never acts while online (admin-local.js); saves wait while a case opening's reel plays (state.js holdSaves); and
// the float ranks offline, worked out again only where something changed, are the same as worked out from scratch
// (floatranks.js).
//   node scripts/test-offline-client.mjs
import fs from 'node:fs';

const ls = new Map();
globalThis.localStorage = { getItem: (k) => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) };
const writes = [];
globalThis.window = { native: { writeSave: (t) => { writes.push(['async', t.length]); return Promise.resolve(true); }, writeSaveSync: (t) => { writes.push(['sync', t.length]); return true; } } };
globalThis.document = { body: { classList: { toggle() {}, add() {}, remove() {} } } };
const quiet = console.warn;
console.warn = () => {}; // (the offline admin log needs IndexedDB, which node hasn't: it says so, and the change still stands)

const state = await import('../src/js/state.js');
const { D, initData } = await import('../src/js/data.js');
const { setRemote, online } = await import('../src/js/backend.js');
const { localAdmin } = await import('../src/js/admin-local.js');
const floatranks = await import('../src/js/floatranks.js');
const N = await import('../src/js/engine/npcs.js');
const { makeSkinItem } = await import('../src/js/engine/items.js');
const { floatRanks, itemKey } = await import('../src/js/engine/database.js');
const { ownedItems } = await import('../src/js/engine/storage.js');
const { freshState } = await import('../src/js/engine/economy.js');
const { mulberry32 } = await import('../src/js/engine/util.js');
const DATA = new URL('../src/data/', import.meta.url);
initData(JSON.parse(fs.readFileSync(new URL('game-data.json', DATA), 'utf8')), { keys: JSON.parse(fs.readFileSync(new URL('keys.json', DATA), 'utf8')) });

let failed = 0, passed = 0;
const check = (name, ok, info = '') => { ok ? passed++ : failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const refusal = async (p) => { try { await p; return null; } catch (e) { return e; } };
// An IndexedDB in memory, as much of one as admin-local.js uses (open with an upgrade, object stores with a keyPath and
// autoIncrement, an index, transactions that complete once their requests have): node has none.
function fakeIndexedDB() {
  const dbs = new Map(), later = (fn) => setTimeout(fn, 0);
  return {
    open(name) {
      const req = {};
      later(() => {
        const fresh = !dbs.has(name);
        if (fresh) dbs.set(name, new Map());
        const stores = dbs.get(name);
        const db = {
          createObjectStore(n, def = {}) { const s = { def, rows: new Map(), seq: 0, idx: {} }; stores.set(n, s); return { createIndex(i, key) { s.idx[i] = key; } }; },
          transaction(names) {
            const t = { pending: 0, done: false, error: null, abort() {} };
            const settle = () => { if (!t.pending && !t.done) { t.done = true; later(() => (t.error ? t.onerror?.() : t.oncomplete?.())); } };
            const ask = (fn) => { const r = {}; t.pending++; later(() => { try { r.result = fn(); r.onsuccess?.(); } catch (e) { t.error = e; } t.pending--; settle(); }); return r; };
            later(settle);
            t.objectStore = (n) => {
              const s = stores.get(n), kp = s.def.keyPath, rows = (q) => [...s.rows.values()].filter((v) => q === undefined || v === q).map((v) => structuredClone(v));
              return {
                add: (v) => ask(() => { const row = structuredClone(v), k = row[kp] ?? (s.def.autoIncrement ? ++s.seq : undefined); row[kp] = k; s.rows.set(k, row); return k; }),
                put: (v) => ask(() => { s.rows.set(v[kp], structuredClone(v)); return v[kp]; }),
                get: (k) => ask(() => structuredClone(s.rows.get(k))),
                getAll: () => ask(() => rows()),
                delete: (k) => ask(() => { s.rows.delete(k); }),
                index: (i) => ({ getAll: (q) => ask(() => [...s.rows.values()].filter((v) => q === undefined || v[s.idx[i]] === q).map((v) => structuredClone(v))) }),
              };
            };
            return t;
          },
          close() {},
        };
        req.result = db;
        if (fresh) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
}

try {
  // ---- the admin panel offline: everyone's, on their own save; never while online ---------------------------------------
  {
    Object.assign(state.S, freshState());
    check('no staff account has ever signed in on this PC (no cs2-admin-pc)', localStorage.getItem('cs2-admin-pc') == null && !online());
    const rules = await localAdmin('settings.get');
    check('offline: the panel answers for any player (no staff PC needed)', rules?.npcTrading === true && rules.npcMarket === true && rules.npcChat === true, JSON.stringify(rules));
    const set = await localAdmin('settings.set', { settings: { npcChat: false } });
    check('offline: a change is made on the offline save', set?.npcChat === false && state.S.social?.rules?.chat === false);
    const before = JSON.stringify(state.S.social.rules);
    // Online: the server answers the panel (for its staff); the offline one refuses, and asks the server nothing.
    const asked = [];
    setRemote({ act: async (name, args) => { asked.push(name); return {}; }, can: () => true });
    const e1 = await refusal(localAdmin('settings.get'));
    const e2 = await refusal(localAdmin('settings.set', { settings: { npcChat: true } }));
    const e3 = await refusal(localAdmin('players', {}));
    setRemote(null);
    check('online: every request is refused with code online, and nothing is sent to the server', [e1, e2, e3].every((e) => e?.code === 'online') && !asked.length, JSON.stringify([e1?.code, e2?.code, e3?.code, asked]));
    check('online: the offline save is left as it was', JSON.stringify(state.S.social.rules) === before);
    const again = await localAdmin('settings.get');
    check('offline again: the panel works again', again?.npcChat === false);
  }

  // ---- saves wait while an opening plays -----------------------------------------------------------------------------------
  {
    writes.length = 0;
    state.save();
    await wait(300);
    const early = writes.length;
    await wait(700);
    check('save(): written 0.8 s later, once', early === 0 && writes.length === 1 && writes[0][0] === 'async');
    writes.length = 0;
    state.save(); state.save(); await wait(300); state.save();
    await wait(1000);
    check('save() three times close together: written once', writes.length === 1);
    writes.length = 0;
    state.holdSaves(true);
    state.save();
    await wait(1000);
    const held = writes.length;
    state.holdSaves(false);
    await wait(300);
    const right = writes.length;
    await wait(700);
    check('while held a save that comes due waits; it is written 0.8 s after the hold ends', held === 0 && right === 0 && writes.length === 1, `${held}/${right}/${writes.length}`);
    writes.length = 0;
    state.holdSaves(true); state.holdSaves(true);
    state.save();
    await wait(1000);
    state.holdSaves(false);
    await wait(1000);
    const inner = writes.length;
    state.holdSaves(false);
    await wait(1000);
    check('holds nest: written only once the last one ends', inner === 0 && writes.length === 1, `${inner}/${writes.length}`);
    writes.length = 0;
    state.holdSaves(true); state.holdSaves(false);
    await wait(1000);
    check('a hold with no save due writes nothing', writes.length === 0);
    state.save();
    state.saveNow();
    await wait(1000);
    check('saveNow() writes at once and takes the place of the one waiting', writes.length === 1);
    writes.length = 0;
    state.holdSaves(true);
    state.saveSync();
    state.holdSaves(false);
    check('closing the game (saveSync) writes whatever is held', writes.length === 1 && writes[0][0] === 'sync');
    state.holdSaves(false); // (one too many: it stays at none)
    state.save();
    await wait(1000);
    check('holdSaves(false) with no hold: saves go on as usual', writes.length === 2);
    // A hold that goes on and on (auto open with the animation): a save waits saveHold.max at most.
    writes.length = 0;
    const was = state.saveHold.max;
    state.saveHold.max = 1500;
    state.holdSaves(true);
    state.save();
    await wait(1200);
    const waiting = writes.length;
    state.save(); // (more changes meanwhile don't put it off past the limit)
    await wait(1300);
    const capped = writes.length;
    state.holdSaves(false);
    await wait(1000);
    state.saveHold.max = was;
    check('a save held saveHold.max is written anyway, even as more changes come; the hold ending then writes nothing more',
      waiting === 0 && capped === 1 && writes.length === 1, `${waiting}/${capped}/${writes.length}`);
  }

  // ---- float ranks offline: the same as worked out from scratch ------------------------------------------------------------
  {
    const S = state.S;
    S.social = N.freshSocial(4242, Date.now());
    const r = mulberry32(7);
    const world = N.worldCopies(S.social);
    // Your skins: copies of what the NPC players own (so they're ranked among theirs), and some nobody else has.
    const skinIds = [...new Set(world.filter((c) => c.item.t === 'skin' && c.item.fl != null).map((c) => c.item.id))];
    const mk = (id, extra = {}) => ({ ...makeSkinItem(D.skins[id], { r, src: 'Unboxed' }), ...extra });
    S.inv = Array.from({ length: 400 }, (_, i) => mk(skinIds[i % 60], { at: 1000 + i, ...(i % 7 === 0 ? { stt: true } : {}) }));
    // From scratch, as before: every one of your skins against everyone's copies of it.
    const scratch = () => {
      const mine = new Map(), out = new Map();
      for (const it of ownedItems(S)) if (it.t === 'skin' && it.fl != null) { const k = itemKey(it); if (!mine.has(k)) mine.set(k, []); mine.get(k).push(it); }
      const theirs = new Map();
      for (const c of N.worldCopies(S.social)) { const k = itemKey(c.item); if (mine.has(k)) { if (!theirs.has(k)) theirs.set(k, []); theirs.get(k).push(c.item); } }
      for (const [k, list] of mine) {
        const own = new Set(list.map((it) => it.uid));
        for (const [uid, rk] of floatRanks([...list, ...(theirs.get(k) || [])])) if (own.has(uid)) out.set(uid, rk);
      }
      return out;
    };
    const same = async (what) => {
      await floatranks.refreshRanks();
      const want = scratch();
      const got = new Map(ownedItems(S).map((it) => [it.uid, floatranks.floatRankOf(it.uid)]).filter(([, v]) => v));
      const bad = [...want].filter(([uid, v]) => JSON.stringify(got.get(uid)) !== JSON.stringify(v));
      check(`float ranks offline ${what}: the same as from scratch (${want.size} ranked)`, want.size > 0 && got.size === want.size && !bad.length, bad.length ? `${bad.length} differ` : '');
    };
    await same('at first');
    // Drops: new copies at the top, one with a float lower than anyone's.
    S.inv.unshift(mk(skinIds[3], { at: 5000, fl: 0.000001 }), mk(skinIds[4], { at: 5001 }), mk(skinIds[200 % skinIds.length], { at: 5002 }));
    await same('after drops');
    // Sold: the lowest float goes (the next one up takes its rank).
    S.inv = S.inv.filter((it) => it.fl !== 0.000001);
    await same('after a sale');
    // A trade with an NPC player: they have one of yours now and you one of theirs (the NPC world changed).
    const npc = N.activeCrowd(S.social.seed)[0], s = N.npcState(S.social, npc.id);
    const mineGiven = S.inv.find((it) => it.t === 'skin'), theirsGiven = s.inv.find((it) => it.t === 'skin' && it.fl != null);
    S.inv = [{ ...theirsGiven, at: 6000 }, ...S.inv.filter((it) => it !== mineGiven)];
    s.inv = [...s.inv.filter((it) => it !== theirsGiven), { ...mineGiven }];
    await same('after a trade with an NPC player');
    // A Storage Unit's contents count too.
    S.stored = [{ ...mk(skinIds[5], { at: 7000 }), su: 'unit-x' }];
    await same('with a skin in a Storage Unit');
    // A new NPC world.
    S.social = N.freshSocial(777, Date.now());
    S.inv.unshift(mk(skinIds[6], { at: 8000 }));
    await same('in a new NPC world');
  }

  // ---- the featured badge offline: it goes with the last of it, as online (server/store.mjs) -------------------------------
  {
    const S = state.S, id = 'test-pin';
    D.badges[id] = { id, n: 'Test Pin', ty: 'Pin', r: 2, tr: 1 }; // (a pin of this test's own: the data here has no badges)
    S.social = N.freshSocial(778, Date.now());
    S.social.me = { ...S.social.me, badge: id };
    const pin = { uid: 'pin-1', t: 'badge', id };
    S.inv.unshift(pin);
    state.saveNow();
    const kept = S.social.me.badge;
    S.inv = S.inv.filter((it) => it.uid !== pin.uid);
    S.stored = [...(S.stored || []), { ...pin, su: 'unit-x' }];
    state.saveNow();
    const stored = S.social.me.badge;
    S.stored = S.stored.filter((it) => it.uid !== pin.uid);
    S.listed = [{ ...pin, lid: 'l1', lp: 5 }];
    state.saveNow();
    const listed = S.social.me.badge;
    S.listed = [];
    S.inv.unshift(pin);
    state.saveNow();
    check('featured badge offline: kept while it\'s in the inventory or a Storage Unit; a save without one (listed on the Market) unfeatures it, and it stays off when it comes back',
      kept === id && stored === id && listed === null && S.social.me.badge === null, JSON.stringify({ kept, stored, listed, back: S.social.me.badge }));
    S.inv = S.inv.filter((it) => it.uid !== pin.uid);
    delete D.badges[id];
  }

  // ---- Service Medals offline: the badges of prestiges from before, as the save loads; each prestige's, as it comes ---------
  {
    initData(JSON.parse(fs.readFileSync(new URL('game-data.json', DATA), 'utf8')), { keys: JSON.parse(fs.readFileSync(new URL('keys.json', DATA), 'utf8')), badges: JSON.parse(fs.readFileSync(new URL('badges.json', DATA), 'utf8')) });
    const { act } = await import('../src/js/backend.js');
    const { medalBadgeIds, featuredBadge } = await import('../src/js/engine/badges.js');
    const { isBound } = await import('../src/js/engine/items.js');
    const faces = await import('../src/js/faces.js');
    const ids = medalBadgeIds(), medalsOf = () => state.S.inv.filter((x) => x.t === 'badge' && x.src === 'Prestige').map((x) => x.id);
    let saved = null;
    const native = window.native, writeSync = native.writeSaveSync;
    native.loadSave = async () => saved;
    native.writeSaveSync = (t) => { saved = t; return true; };
    const old = freshState();
    old.prof = { level: 9, xp: 120, medals: 3, total: 1, drops: [] }; // (a save from before: no medalBadges)
    saved = JSON.stringify(old);
    await state.loadState();
    check('medals offline: a save with 3 prestiges from before gets their 3 Service Medal badges as it loads, the newest first (for the toast: medalsOnLoad)', medalsOf().join() === [ids[2], ids[1], ids[0]].join()
      && state.S.prof.medalBadges.join() === ids.slice(0, 3).join() && state.medalsOnLoad.length === 3 && state.S.inv.filter((x) => x.t === 'badge').every((x) => isBound(x) && x.nw));
    state.saveSync();
    await state.loadState();
    check('medals offline: loaded again it gets nothing more (the record is in the save)', medalsOf().length === 3 && state.medalsOnLoad.length === 0 && state.S.prof.medalBadges.length === 3);
    // A prestige, through the game's own backend (the engine on the save).
    state.S.prof = { ...state.S.prof, level: 40, xp: 4999 };
    let invEvents = 0;
    const off = state.on('inv', () => invEvents++);
    await act('play.start', { mode: 'competitive' });
    state.S.play = { ...state.S.play, at: Date.now() - 30 * 60 * 1000 };
    const r = await act('play.reward', { run: state.S.play.run, mode: 'competitive', result: 'loss', roundsWon: 0, rounds: 0 });
    off();
    check('medals offline: a prestige in a match gives the next medal\'s badge to the save, and the inventory is told', r.medals?.length === 1 && r.badges?.length === 1 && state.S.inv[0].id === ids[3]
      && state.S.prof.medals === 4 && state.S.prof.medalBadges.join() === ids.slice(0, 4).join() && medalsOf().length === 4 && invEvents >= 1);
    const me = await act('persona.set', { badge: ids[3] });
    check('medals offline: featured on your profile picture like any badge you have', me.me.badge === ids[3] && faces.myFace().badge === ids[3] && featuredBadge(state.S, ids[3]) === ids[3]
      && faces.badgeList(state.S).some((b) => b.id === ids[3]));
    // The offline admin panel: raising the medals gives their badges, as the server's does (an IndexedDB of this test's own).
    globalThis.indexedDB = fakeIndexedDB();
    await localAdmin('edit', { id: 'me', set: { prof: { medals: 6 } } });
    check('medals offline: the admin panel raising the medals gives their badges', medalsOf().slice(0, 2).join() === [ids[5], ids[4]].join() && medalsOf().length === 6 && state.S.prof.medalBadges.length === 6);
    await localAdmin('edit', { id: 'me', set: { prof: { medals: 2 } } });
    check('medals offline: lowering them takes none away', medalsOf().length === 6 && state.S.prof.medals === 2);
    // The offline panel's raw edit too: a prof without the record of badges given gives none again (engine/admin.js rawEdit).
    const view = await localAdmin('player', { id: 'me' }), { medalBadges: _given, ...bare } = view.state.prof;
    const { inv: _inv, stored: _stored, listed: _listed, index: _index, social: _social, ...rawState } = view.state;
    await localAdmin('edit.raw', { id: 'me', state: { ...rawState, prof: { ...bare, medals: 6, level: 8 } }, base: view.rev });
    check('medals offline: a raw edit raising them again, with the record of badges given left out, gives none twice', medalsOf().length === 6 && new Set(medalsOf()).size === 6
      && state.S.prof.medals === 6 && state.S.prof.level === 8 && state.S.prof.medalBadges.length === 6, medalsOf().join());
    const file = { ...freshState(), money: 50 };
    file.prof = { ...file.prof, medals: 2 };
    delete file.prof.medalBadges;
    await localAdmin('save.import', { json: JSON.stringify(file) });
    check('medals offline: an imported save from before gets its prestiges\' badges, as a save loads', medalsOf().join() === [ids[1], ids[0]].join() && state.S.prof.medalBadges.join() === [ids[0], ids[1]].join() && state.S.money === 50);
    delete globalThis.indexedDB;
    native.writeSaveSync = writeSync;
    delete native.loadSave;
  }
} finally {
  console.warn = quiet;
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
