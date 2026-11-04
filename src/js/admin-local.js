// The admin panel offline: the requests pages/admin.js sends the server online (server/admin.mjs), answered in the same
// shapes from this PC's save and its 2,000 NPC traders, with the same checks (engine/admin.js). Your save is snapshotted
// before every change to it and every change is logged; the snapshots, the log and the notes stay in this PC's
// IndexedDB (db 'cs2-admin'), never in the save. Only on a staff PC (account.js staffPc()) and never online (there the
// server answers). Refusals are GameErrors with the server's codes ('bad', 'perm', 'stale', 'missing', 'reserved',
// 'full'), plus 'online', 'offline' (a request that needs the server) and 'storage' (no IndexedDB).
import { S, save, applyDelta, replaceState } from './state.js';
import { online, act } from './backend.js';
import { staffPc } from './account.js';
import { playPrefs } from './pages/play-settings.js';
import { GameError, makeCtx, delta, give, take, takeForStaff } from './engine/actions.js';
import { freshState, upgradeState } from './engine/economy.js';
import { backfillSerials } from './engine/items.js';
import * as N from './engine/npcs.js';
import { ownedItems } from './engine/storage.js';
import { round2 } from './engine/util.js';
import {
  KEEP_AUTO, MAX_MANUAL, PAGE, LEVEL_NAMES, fail, isObj, pick, worthOf, replaceInPlace, revOf, rawView, text, int, number, bool,
  optBool, editPlan, applyEdit, rawEdit, restoreMerge, saveFile, giveSpecs, buildItems, localSerial, removeUids, givenDetail, removedDetail,
} from './engine/admin.js';

const DB = 'cs2-admin';
const NPC_CAP = 60; // (a trader keeps at most 60 items: a trade trims the cheapest, see actions.js)
const FILTERS = ['all', 'online', 'banned', 'friends'];
const RULES = { npcTrading: 'trading', npcMarket: 'market', npcChat: 'chat' }; // (setting -> S.social.rules key)
// What needs the server: other people, Discord, everyone online.
const NOT_OFFLINE = new Set(['kick', 'warn', 'signout', 'rename', 'broadcast', 'link', 'link.code', 'unlink', 'resetpassword']);
// Whole-save changes: a block not lifted, replaced or expired before one of them ended with it.
const ENDS = new Set(['snapshot.restore', 'save.import']);

// ---- requests ------------------------------------------------------------------------------------------------------------
// One at a time (as the server takes a player's requests under their lock); the answer a copy, as the server's is, so
// the page never holds the save's own objects.
let queue = Promise.resolve();
export function localAdmin(m, args) {
  const run = queue.then(() => exec(String(m), isObj(args) ? args : {}));
  queue = run.catch(() => {});
  return run.then((out) => structuredClone(out));
}
async function exec(m, a) {
  gate();
  if (NOT_OFFLINE.has(m)) fail('Not available offline', 'offline');
  if (!Object.hasOwn(METHODS, m)) fail('Unknown request');
  return METHODS[m](a);
}
function gate() {
  if (online()) fail('The offline admin panel only works on your offline save', 'online');
  if (!staffPc()) fail('The admin panel works offline only on a PC that has signed in to a staff account', 'perm');
}
// (Who did it, in the log, snapshots, notes and blocks: the staff account that unlocked this PC.)
const actor = () => staffPc()?.name || 'Staff';

// ---- this PC's IndexedDB -------------------------------------------------------------------------------------------------
// snapshots: { id, label, kind, by, created, size }, and the saves themselves in states: { id, state (JSON), config }
// (a list doesn't read them). audit: { id, at, actor, action, target: { id, name } | null, detail, seed }. notes: { id,
// target, name, by, text, created, seed }. (seed: the NPC world they were made in; a trader's id is someone else in
// another.)
let dbp = null;
const storageError = (e) => (e instanceof GameError ? e : new GameError(`This PC's admin storage (IndexedDB) isn't working${e?.message ? `: ${e.message}` : ''}`, 'storage'));
function openDb() {
  dbp ||= new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') throw new Error('not available here');
    let late = false;
    const timer = setTimeout(() => { late = true; reject(new Error("it didn't open (another window may be holding it)")); }, 5000);
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('snapshots', { keyPath: 'id', autoIncrement: true });
      db.createObjectStore('states', { keyPath: 'id' });
      db.createObjectStore('audit', { keyPath: 'id', autoIncrement: true });
      db.createObjectStore('notes', { keyPath: 'id', autoIncrement: true }).createIndex('target', 'target');
    };
    req.onsuccess = () => {
      clearTimeout(timer);
      const db = req.result;
      if (late) { db.close(); return; }
      db.onversionchange = () => { db.close(); dbp = null; }; // (a newer version opened elsewhere)
      db.onclose = () => { dbp = null; };
      resolve(db);
    };
    req.onerror = () => { clearTimeout(timer); reject(req.error); };
  }).catch((e) => { dbp = null; throw storageError(e); });
  return dbp;
}
// One transaction: fn(...stores) makes the requests and returns a function that reads the answer once it's done.
async function tx(names, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    let t, out;
    try {
      t = db.transaction(names, mode);
      out = fn(...[].concat(names).map((n) => t.objectStore(n)));
    } catch (e) {
      try { t?.abort(); } catch {}
      reject(storageError(e));
      return;
    }
    t.oncomplete = () => resolve(out?.());
    t.onerror = t.onabort = () => reject(storageError(t.error || new Error('cancelled')));
  });
}
const all = (src, q) => { const r = q === undefined ? src.getAll() : src.getAll(q); return () => r.result; };
const newestFirst = (a, b) => (b.created ?? b.at) - (a.created ?? a.at) || b.id - a.id;

// Snapshots: your save as it is now, without this device's settings (they go in its config, with Play's). The newest 20
// automatic ones are kept. → its id
const snapRow = (r) => ({ id: r.id, label: r.label, kind: r.kind, by: r.by, created: r.created, size: r.size || 0 });
const snapList = async () => (await tx('snapshots', 'readonly', (s) => all(s))).sort(newestFirst).map(snapRow);
function saveSnap(label, kind) {
  const { settings, ...st } = S;
  const json = JSON.stringify(st), config = { game: settings, play: playPrefs() };
  const meta = { label: label.slice(0, 120), kind, by: actor(), created: Date.now(), size: json.length };
  return tx(['snapshots', 'states'], 'readwrite', (snaps, states) => {
    const add = snaps.add(meta);
    add.onsuccess = () => states.put({ id: add.result, state: json, config });
    if (kind === 'auto') {
      const list = snaps.getAll(); // (after the add: it's in the list)
      list.onsuccess = () => {
        for (const r of list.result.filter((x) => x.kind === 'auto').sort(newestFirst).slice(KEEP_AUTO)) { snaps.delete(r.id); states.delete(r.id); }
      };
    }
    return () => add.result;
  });
}
const dropSnap = (id) => tx(['snapshots', 'states'], 'readwrite', (snaps, states) => { snaps.delete(id); states.delete(id); });
async function snapshot(v) {
  const id = int(v, 'Snapshot id', 1, 2 ** 31 - 1);
  const [meta, body] = await tx(['snapshots', 'states'], 'readonly', (snaps, states) => {
    const a = snaps.get(id), b = states.get(id);
    return () => [a.result, b.result];
  });
  if (!meta || !body) fail('That snapshot is gone', 'missing');
  return { ...meta, state: body.state, config: body.config ?? null };
}

// The log. A row that can't be written doesn't undo the change it's about (as the server's).
async function writeLog(action, t, detail, at = Date.now()) {
  const row = { at, actor: actor(), action, target: t ? { id: t.id, name: t.name } : null, detail: detail ?? {}, seed: S.social?.seed ?? null };
  try {
    return await tx('audit', 'readwrite', (s) => { const r = s.add(row); return () => r.result; });
  } catch (e) {
    console.warn('[admin] could not log', action, e?.message || e);
    return null;
  }
}
const auditRow = (r) => ({ id: r.id, at: r.at, actor: r.actor, actorDiscord: null, action: r.action, target: r.target ?? null, detail: r.detail ?? {} });
const auditAll = () => tx('audit', 'readonly', (s) => all(s));

async function notesOf(t) {
  const rows = await tx('notes', 'readonly', (s) => all(s.index('target'), t.id));
  return rows.filter((r) => !t.npc || r.seed === S.social?.seed).sort(newestFirst).slice(0, 200)
    .map((r) => ({ id: r.id, by: r.by, text: r.text, created: r.created }));
}

// ---- the save and its NPC world -------------------------------------------------------------------------------------------
// Every change: checked first (plan() throws the refusal before anything is written; { noop: answer } when there's nothing
// to change); for your own save an automatic snapshot of it, then checked again on the save as it is by then (it may have
// moved on meanwhile); made and announced by apply(plan) (state.js events), saved, and logged. apply → { answer (or
// answer(log row id)), detail (null: nothing to log) }.
async function change(t, action, what, plan, apply, { snap = t?.id === 'me', at = Date.now() } = {}) {
  let p = plan();
  if ('noop' in p) return p.noop;
  if (snap) {
    let id;
    try {
      id = await saveSnap(`Before ${what} by ${actor()}`, 'auto');
    } catch (e) {
      throw new GameError(`Nothing was changed: the snapshot of your save before it couldn't be saved (${e.message})`, e.code || 'storage');
    }
    try {
      gate();
      p = plan();
    } catch (e) {
      await dropSnap(id).catch(() => {});
      throw e;
    }
    if ('noop' in p) { await dropSnap(id).catch(() => {}); return p.noop; }
  }
  const { answer, detail } = apply(p);
  save();
  const log = detail ? await writeLog(action, t, detail, at) : null;
  return typeof answer === 'function' ? answer(log) : answer;
}
// Tells the pages what changed, as an action's changes do (the save itself is changed already).
const announce = (set, d = {}) => applyDelta({ set, add: [], del: [], upd: [], ...d }, { local: true });
const socialChanged = () => announce({ social: S.social });

// The NPC world, made by the social tick if the save has none yet (a new save, or one just reset).
async function ensureSocial() {
  if (!S.social) await act('npc.tick').catch(() => {});
  gate();
  if (!S.social) fail("The NPC world couldn't be made");
}
const myName = () => S.social?.me?.name || 'You';
// Your save's rev without what moves on its own: lastSeen (every save(), every 15 s) and the market's sold listings (the
// traders buy from it every minute or two). A raw edit opened a while ago isn't stale for those, and keeps the save's own.
const myRev = () => revOf({ ...S, lastSeen: 0, market: null });
const keepMoving = (st) => {
  const { market: _market, ...rest } = st;
  return { ...rest, lastSeen: S.lastSeen, ...('market' in S ? { market: S.market } : {}) };
};
// 'me' (your save) or a trader ('n<k>'). → { id, name, npc (their entry in the crowd; null for you), seed (their world's) }
async function who(id) {
  if (id === 'me') return { id, name: myName(), npc: null };
  if (typeof id !== 'string' || !/^n\d+$/.test(id)) fail('No such player', 'missing');
  await ensureSocial();
  const npc = N.npcOf(S.social.seed, id) || fail('No such player', 'missing');
  return { id, name: npc.name, npc, seed: S.social.seed };
}
// The NPC world again after waiting on storage (a reset from Settings may have replaced it meanwhile).
function worldNow(t) {
  if (!S.social || (t?.npc && S.social.seed !== t.seed)) fail('The NPC world changed meanwhile. Try again.', 'missing');
  return S.social;
}
// A trader as the save has them, or (not dealt with yet) as they start: the save's seed makes them the same every time.
const npcNow = (t) => S.social.npcs[t.id] || N.startingState(S.social.seed, t.npc);
const isOn = (n, now) => N.presence(n, now).s !== 'offline';
const lastSeenOf = (so, id) => so.threads[id]?.at(-1)?.at ?? null; // (your last message with them)
const rulesOf = (so) => Object.fromEntries(Object.entries(RULES).map(([k, r]) => [k, N.ruleOn(so, r)]));
// Items an open offer holds (not removed, as an online trade's): yours it asks for, or a trader's it gives.
const heldMine = (so) => new Set((so?.offers || []).filter((o) => o.status === 'open').flatMap((o) => o.want.uids));
const heldBy = (so, id) => new Set(so.offers.filter((o) => o.status === 'open' && o.npc === id).flatMap((o) => o.give.uids));

// The open offers between you and the traders, as the server lists trades (newest first): from the trader to you, `give`
// theirs and `get` yours.
function tradesOf(so, id = null) {
  const mine = new Map(S.inv.map((i) => [i.uid, i]));
  return so.offers.filter((o) => o.status === 'open' && (id == null || o.npc === id)).reverse().map((o) => {
    const theirs = new Map((so.npcs[o.npc]?.inv || []).map((i) => [i.uid, i]));
    return {
      id: o.id, status: o.status, version: 0, created: o.at, updated: o.at, expires: o.exp, kind: o.kind, msg: '',
      from: { id: o.npc, name: N.npcOf(so.seed, o.npc)?.name || o.npc }, to: { id: 'me', name: myName() },
      give: { items: o.give.uids.map((u) => theirs.get(u)).filter(Boolean), money: o.give.money || 0 },
      get: { items: o.want.uids.map((u) => mine.get(u)).filter(Boolean), money: o.want.money || 0 },
    };
  });
}

// The blocks as the server's ban rows, newest first: every block the log has from this NPC world, active while the save
// has it in force, else lifted by what ended it (an unblock, a new block, a restore or an import) or expired; then any
// block in force the log doesn't have (a save from another PC).
function blockRows(so, log, now = Date.now()) {
  const rows = log.filter((r) => r.seed === so.seed).sort((a, b) => a.id - b.id);
  const out = [], logged = new Set();
  rows.forEach((r, i) => {
    if (r.action !== 'ban' || !r.target) return;
    const id = r.target.id, d = r.detail || {}, cur = so.blocked?.[id];
    if (cur?.at === r.at) logged.add(id);
    const active = cur?.at === r.at && N.isBlocked(so, id, now), expires = d.expires ?? null;
    const end = active ? null : rows.slice(i + 1).find((x) => ENDS.has(x.action) || (x.target?.id === id && (x.action === 'unban' || x.action === 'ban')));
    const lifted = end && !(expires != null && expires <= end.at) ? end : null;
    out.push({ id: r.id, user: { id, name: r.target.name }, network: false, reason: d.reason ?? '', by: r.actor, created: r.at, expires,
      lifted: lifted?.at ?? null, liftedBy: lifted?.actor ?? null, active });
  });
  for (const [id, b] of N.activeBlocks(so, now)) {
    if (logged.has(id)) continue;
    out.push({ id: null, user: { id, name: N.npcOf(so.seed, id)?.name || id }, network: false, reason: b.reason || '', by: b.by || '', created: b.at,
      expires: b.expires ?? null, lifted: null, liftedBy: null, active: true });
  }
  return out.sort((a, b) => b.created - a.created || (b.id ?? 0) - (a.id ?? 0));
}

const meRow = () => ({
  id: 'me', name: myName(), self: true, online: true, country: S.social?.me?.country || '', level: S.prof?.level || 1, lastSeen: null,
  blocked: null, friend: null, money: round2(S.money), items: ownedItems(S).length, worth: worthOf(ownedItems(S)),
});
function npcRow(so, n, now) {
  const s = so.npcs[n.id] || N.startingState(so.seed, n);
  return {
    id: n.id, name: n.name, country: n.country, type: n.type, focus: n.focus, active: n.active, online: isOn(n, now), lastSeen: lastSeenOf(so, n.id),
    blocked: N.blockOf(so, n.id, now), friend: s.friend || 0, money: round2(s.money), items: s.inv.length, worth: worthOf(s.inv),
  };
}
// A trader's edit: money, mood (0 to 1) and friendship (0 none, 1 friends, 2 they asked, 3 you asked).
function npcEditPlan(s, set) {
  if (!isObj(set) || !Object.keys(set).length) fail('Nothing to change');
  const next = {};
  for (const [k, v] of Object.entries(set)) {
    if (k === 'money') next.money = round2(number(v, 'Money', 0, 1e12));
    else if (k === 'mood') next.mood = number(v, 'Mood', 0, 1);
    else if (k === 'friend') next.friend = int(v, 'Friend', 0, 3);
    else fail(`Unknown field: ${k}`);
  }
  const changed = Object.keys(next).filter((k) => s[k] !== next[k]);
  return { next, changed, before: pick(s, changed), after: pick(next, changed) };
}
// A save (a snapshot's, or a file's: saveFile checked and cleaned that) made fit to replace yours: as a save is loaded (upgraded, serials filled in, retired
// items sold: restoreMerge), no item twice, its loadout fitted, and this device's settings and the match being played
// kept. Level-up rewards stay as saved: offline nobody else can own their items.
function loadable(v) {
  const next = upgradeState(v);
  backfillSerials(next);
  const { dropped, rewards } = restoreMerge(S, next, { keepRewards: true });
  return { next, dropped, rewards };
}

// ---- the methods (server/admin.mjs's, offline) ----------------------------------------------------------------------------
const METHODS = {
  async overview() {
    await ensureSocial();
    const [snaps, log] = await Promise.all([snapList(), auditAll()]);
    gate();
    const so = worldNow(), now = Date.now();
    let activeNow = 0;
    for (const n of N.crowd(so.seed)) if (isOn(n, now)) activeNow++;
    return {
      offline: true, me: { name: actor(), level: 3, levelName: LEVEL_NAMES[3] },
      money: round2(S.money), items: ownedItems(S).length, invValue: worthOf(ownedItems(S)), level: S.prof?.level || 1, opened: S.stats?.opened || 0,
      npcs: N.WORLD, activeNow, blocked: N.activeBlocks(so, now).length, snapshots: snaps.length,
      saveBytes: new TextEncoder().encode(JSON.stringify(S)).length, lastSaved: S.lastSeen ?? null,
      settings: rulesOf(so), recent: log.sort(newestFirst).slice(0, 15).map(auditRow),
    };
  },

  // You first, then the traders: who's online, then whom you've talked with lately (as the server: online, last seen).
  async players(a) {
    const q = text(a.q, 'Search', 64, { min: 0 }).toLowerCase();
    const filter = a.filter ?? 'all';
    if (!FILTERS.includes(filter)) fail('Unknown filter');
    const page = a.page == null ? 0 : int(a.page, 'Page', 0, 1e6);
    await ensureSocial();
    const so = S.social, now = Date.now();
    const match = (name) => !q || name.toLowerCase().includes(q);
    const keep = { all: () => true, online: (n) => isOn(n, now), banned: (n) => N.isBlocked(so, n.id, now), friends: (n) => so.npcs[n.id]?.friend === 1 }[filter];
    const people = N.crowd(so.seed).filter((n) => match(n.name) && keep(n)).map((n) => [n, isOn(n, now), lastSeenOf(so, n.id) || 0])
      .sort((x, y) => y[1] - x[1] || y[2] - x[2]);
    const list = (filter === 'all' || filter === 'online') && match(myName()) ? ['me', ...people] : people;
    return { players: list.slice(page * PAGE, page * PAGE + PAGE).map((x) => (x === 'me' ? meRow() : npcRow(so, x[0], now))), total: list.length, page };
  },

  async player(a) {
    const t = await who(a.id);
    const [notes, log, snapshots] = await Promise.all([notesOf(t), auditAll(), t.npc ? [] : snapList()]);
    gate();
    const so = t.npc ? worldNow(t) : S.social, now = Date.now();
    const audit = log.filter((r) => r.target?.id === t.id && (!t.npc || r.seed === so.seed)).sort(newestFirst).slice(0, 40).map(auditRow);
    if (!t.npc) {
      const { settings, ...state } = S;
      return {
        user: { id: 'me', name: t.name, created: S.created ?? null, lastSeen: S.lastSeen ?? null, online: true, discord: null, staff: 0, ban: null },
        state, rev: myRev(), config: { game: settings, play: playPrefs() }, configAt: now,
        bans: [], notes, snapshots, trades: so ? tradesOf(so) : [], audit, alts: [],
      };
    }
    // (Their own inventory from now on, as visiting their profile makes it: the uids the inventory tools send.)
    if (!so.npcs[t.id]) { N.npcState(so, t.id); socialChanged(); save(); }
    const s = so.npcs[t.id], n = t.npc;
    return {
      user: {
        id: t.id, name: t.name, online: isOn(n, now), lastSeen: lastSeenOf(so, t.id),
        npc: { type: n.type, focus: n.focus, active: n.active, country: n.country, level: n.level, tier: s.tier, friend: s.friend || 0, mood: s.mood, trades: s.trades || 0, blocked: N.blockOf(so, t.id, now) },
      },
      state: { money: round2(s.money), inv: s.inv }, rev: revOf(s), config: null, configAt: null,
      bans: blockRows(so, log, now).filter((b) => b.user.id === t.id), notes, snapshots, trades: tradesOf(so, t.id), audit, alts: [],
    };
  },

  // Yours: the server's fields and checks (editPlan). A trader's: { money, mood, friend }, as `set` or beside the id.
  async edit(a) {
    const t = await who(a.id);
    if (t.npc) {
      const set = isObj(a.set) ? a.set : pick(a, ['money', 'mood', 'friend'].filter((k) => k in a));
      const plan = () => { const p = npcEditPlan(npcNow(t), set); return p.changed.length ? p : { noop: { state: pick(npcNow(t), Object.keys(p.next)) } }; };
      return change(t, 'edit', 'edit', plan, (p) => {
        const s = N.npcState(S.social, t.id);
        Object.assign(s, p.next);
        socialChanged();
        return { answer: { state: pick(s, Object.keys(p.next)) }, detail: { changed: p.changed, before: p.before, after: p.after } };
      });
    }
    const plan = () => { const p = editPlan(S, a.set); return p.changed.length ? p : { noop: { state: pick(S, Object.keys(p.next)) } }; };
    return change(t, 'edit', 'edit', plan, (p) => {
      applyEdit(S, p.next);
      announce(pick(S, Object.keys(p.before)));
      return { answer: { state: pick(S, Object.keys(p.next)) }, detail: { changed: p.changed, before: p.before, after: p.after } };
    });
  },

  // Your save only, by the server's rules (rawEdit): `base` is the rev the panel loaded, and a save changed since refuses.
  async 'edit.raw'(a) {
    const t = await who(a.id);
    if (t.npc) fail('Raw JSON is for your own save only');
    const plan = () => {
      const p = rawEdit(S, isObj(a.state) ? keepMoving(a.state) : a.state, a.base === myRev() ? revOf(S) : null);
      return p.changed.length ? p : { noop: { state: rawView(S), rev: myRev() } };
    };
    return change(t, 'edit.raw', 'raw edit', plan, (p) => {
      replaceInPlace(S, p.next);
      // (a field the save no longer has goes as null, as the server sends it)
      announce(Object.fromEntries(p.changed.map((k) => [k, S[k] ?? null])));
      return { answer: { state: rawView(S), rev: myRev() }, detail: { changed: p.changed, before: p.before, after: p.after } };
    });
  },

  // New copies (new uids, numbered on the save's own serial counters); a trader keeps at most 60 items.
  async 'items.give'(a) {
    const t = await who(a.id);
    const { specs, total } = giveSpecs(a.items);
    if (t.npc) {
      if (specs.some((x) => x.unit)) fail("Traders don't keep Storage Units");
      return change(t, 'items.give', 'give', () => {
        if (npcNow(t).inv.length + total > NPC_CAP) fail(`${t.name}'s inventory would be over the limit (${NPC_CAP} items)`, 'full');
        return {};
      }, () => {
        const s = N.npcState(S.social, t.id), now = Date.now();
        const items = buildItems(specs, localSerial(S)).map(({ nw: _nw, ...it }) => ({ ...it, at: now }));
        s.inv.push(...items);
        announce({ social: S.social, serials: S.serials });
        return { answer: { added: items.length }, detail: givenDetail(items) };
      });
    }
    return change(t, 'items.give', 'give', () => ({}), () => {
      const ctx = makeCtx(S);
      const items = buildItems(specs, localSerial(S));
      ctx.dirty.add('serials');
      give(ctx, items);
      applyDelta(delta(ctx), { local: true });
      return { answer: { added: items.length }, detail: givenDetail(items) };
    });
  },

  // As the server's: locked items go too, and what's in Storage Units; one an open offer holds refuses it all (take() checks
  // before it changes anything).
  async 'items.remove'(a) {
    const t = await who(a.id);
    const uids = removeUids(a.uids);
    if (t.npc) {
      const takeFrom = (s) => {
        const ctx = makeCtx({ inv: s.inv, loadout: {} }, { reserved: heldBy(S.social, t.id) });
        return { items: take(ctx, uids, { allowLocked: true }), inv: ctx.st.inv };
      };
      return change(t, 'items.remove', 'item removal', () => takeFrom(npcNow(t)), () => {
        const s = N.npcState(S.social, t.id);
        const { items, inv } = takeFrom(s);
        s.inv = inv;
        socialChanged();
        return { answer: { removed: items.length }, detail: removedDetail(items) };
      });
    }
    const takeMine = (st) => {
      const ctx = makeCtx(st, { reserved: heldMine(S.social) });
      return { ctx, items: takeForStaff(ctx, uids) };
    };
    // (checked on a copy first: it only replaces the copy's inventory, stored items and loadout)
    return change(t, 'items.remove', 'item removal', () => { takeMine({ ...S }); return {}; }, () => {
      const { ctx, items } = takeMine(S);
      applyDelta(delta(ctx), { local: true });
      return { answer: { removed: items.length }, detail: removedDetail(items) };
    });
  },

  async 'snapshot.save'(a) {
    const t = await who(a.id);
    if (t.npc) fail('Snapshots are of your own save only');
    const label = text(a.label, 'Label', 80, { min: 0 }) || `Saved by ${actor()}`;
    const manual = (await tx('snapshots', 'readonly', (s) => all(s))).filter((r) => r.kind === 'manual').length;
    if (manual >= MAX_MANUAL) fail(`You have ${MAX_MANUAL} saved snapshots. Delete some first.`);
    gate();
    const id = await saveSnap(label, 'manual');
    await writeLog('snapshot.save', t, { snap: id, label });
    return { id };
  },

  async 'snapshot.list'(a) {
    const t = await who(a.id);
    return t.npc ? [] : snapList();
  },

  async 'snapshot.get'(a) {
    const s = await snapshot(a.snap);
    return { id: s.id, user: { id: 'me', name: myName() }, label: s.label, kind: s.kind, by: s.by, created: s.created, state: JSON.parse(s.state), config: s.config };
  },

  // The whole save as it was (its NPC world too, so nothing traded since is in two places), loaded as a save is.
  async 'snapshot.restore'(a) {
    const s = await snapshot(a.snap);
    const t = await who('me');
    return change(t, 'snapshot.restore', 'restore', () => loadable(JSON.parse(s.state)), ({ next, dropped, rewards }) => {
      replaceState(next);
      return { answer: { dropped, rewards }, detail: { snap: s.id, label: s.label, created: s.created, dropped, rewards } };
    });
  },

  async 'snapshot.delete'(a) {
    const s = await snapshot(a.snap);
    await dropSnap(s.id);
    await writeLog('snapshot.delete', await who('me'), { snap: s.id, label: s.label, kind: s.kind });
    return {};
  },

  async 'config.get'(a) {
    const t = await who(a.id);
    return t.npc ? { config: null, at: null } : { config: { game: S.settings, play: playPrefs() }, at: Date.now() };
  },

  // Blocking a trader (engine/npcs.js blockNpc): their open offers to you are cancelled; minutes null is for good.
  async ban(a) {
    const t = await who(a.id);
    if (!t.npc) fail("You can't do that to yourself", 'perm');
    const reason = text(a.reason, 'Reason', 300);
    const minutes = a.minutes == null ? null : int(a.minutes, 'Minutes', 1, 5256000);
    if (optBool(a.network, 'network') || optBool(a.discordBan, 'discordBan')) fail('Not available offline', 'offline');
    const now = Date.now(); // (the block's time and its log row's: the block history pairs them)
    return change(t, 'ban', 'block', () => ({}), () => {
      const { block, cancelled } = N.blockNpc(S.social, t.id, { minutes, reason, by: actor() }, now);
      socialChanged();
      return {
        answer: (id) => ({ ban: { id, reason, expires: block.expires, by: block.by, network: false, created: now, cancelled } }),
        detail: { reason, minutes, expires: block.expires, cancelled },
      };
    }, { at: now });
  },

  async unban(a) {
    const t = await who(a.id);
    if (!t.npc) fail("You can't do that to yourself", 'perm');
    if (optBool(a.discordUnban, 'discordUnban')) fail('Not available offline', 'offline');
    return change(t, 'unban', 'unblock', () => (S.social.blocked?.[t.id] ? {} : { noop: { lifted: 0 } }), () => {
      const was = N.blockOf(S.social, t.id), b = N.unblockNpc(S.social, t.id);
      socialChanged();
      // (one that had run out is only cleared away: nothing lifted, nothing to log)
      return { answer: { lifted: was ? 1 : 0 }, detail: was ? { lifted: 1, reason: b.reason } : null };
    });
  },

  async bans(a) {
    const active = optBool(a.active, 'active');
    await ensureSocial();
    const log = await auditAll();
    gate();
    const rows = blockRows(worldNow(), log).filter((b) => !active || b.active).slice(0, 500);
    return { bans: rows, total: rows.length };
  },

  async 'note.add'(a) {
    const t = await who(a.id);
    const note = text(a.text, 'Note', 1000);
    const row = { target: t.id, name: t.name, by: actor(), text: note, created: Date.now(), seed: S.social?.seed ?? null };
    const id = await tx('notes', 'readwrite', (s) => { const r = s.add(row); return () => r.result; });
    await writeLog('note.add', t, { note: id, text: note });
    return { id };
  },

  // Yours: a new game's save, this device's settings kept (as Settings' reset). A trader's: back to their start, their
  // open offers cancelled (your chat with them and a block stay).
  async reset(a) {
    const t = await who(a.id);
    if (t.npc) {
      return change(t, 'reset', 'reset', () => ({}), () => {
        const { cancelled } = N.resetNpc(S.social, t.id);
        socialChanged();
        return { answer: { cancelled }, detail: { cancelled } };
      });
    }
    return change(t, 'reset', 'reset', () => ({}), () => {
      replaceState(freshState());
      return { answer: {}, detail: {} };
    });
  },

  async audit(a) {
    const q = text(a.q, 'Search', 80, { min: 0 }).toLowerCase();
    const page = a.page == null ? 0 : int(a.page, 'Page', 0, 1e6);
    // (by the action's name as the panel shows it too: offline a ban is a block)
    const shown = { ban: 'block', unban: 'unblock' };
    const rows = (await auditAll()).filter((r) => !q || [r.actor, r.target?.name, r.action, shown[r.action]].some((x) => String(x ?? '').toLowerCase().includes(q))).sort(newestFirst);
    return { rows: rows.slice(page * PAGE, page * PAGE + PAGE).map(auditRow), total: rows.length, page };
  },

  // What the traders do, each on unless switched off: kept in the save (S.social.rules), not in this device's settings.
  async 'settings.get'() {
    await ensureSocial();
    return rulesOf(S.social);
  },
  async 'settings.set'(a) {
    if (!isObj(a.settings)) fail('Invalid settings');
    for (const [k, v] of Object.entries(a.settings)) {
      if (!Object.hasOwn(RULES, k)) fail(`Unknown setting: ${k}`);
      bool(v, k);
    }
    await ensureSocial();
    return change(null, 'settings.set', 'settings', () => {
      const before = rulesOf(S.social), next = { ...before, ...a.settings };
      const changed = Object.keys(next).filter((k) => next[k] !== before[k]);
      return changed.length ? { before, next, changed } : { noop: next };
    }, ({ before, next, changed }) => {
      S.social.rules = Object.fromEntries(Object.entries(RULES).map(([k, r]) => [r, next[k]]));
      socialChanged();
      return { answer: next, detail: { changed, before: pick(before, changed), after: pick(next, changed) } };
    });
  },

  // ---- offline only: the save itself ----
  // The save as save.json has it (this device's settings too), for a download.
  async 'save.export'() {
    return { json: JSON.stringify(S), name: `cs2-save-${new Date().toISOString().slice(0, 10)}.json` };
  },
  // A save file in place of yours (checked and cleaned: saveFile), loaded as a save is; this device's settings and the
  // match being played stay.
  async 'save.import'(a) {
    if (typeof a.json !== 'string' || !a.json.trim()) fail('Pick a save file');
    const parse = () => {
      let v;
      try { v = JSON.parse(a.json); } catch { fail("That file isn't a save (it isn't valid JSON)"); }
      return saveFile(v);
    };
    parse();
    const t = await who('me');
    return change(t, 'save.import', 'import', () => loadable(parse()), ({ next, dropped }) => {
      replaceState(next);
      const out = { items: next.inv.length, money: next.money, dropped };
      return { answer: out, detail: out };
    });
  },
  // A new NPC world from a new seed: everyone's money, items and friendship, your chats, their offers and the blocks start
  // over; your profile and the panel's NPC settings stay.
  async 'world.reset'() {
    await ensureSocial();
    const t = await who('me');
    return change(t, 'world.reset', 'new NPC world', () => ({}), () => {
      const cur = S.social;
      let seed;
      do seed = Math.floor(Math.random() * 2 ** 31); while (seed === cur?.seed);
      const so = N.freshSocial(seed, Date.now());
      if (cur?.me) so.me = cur.me;
      if (cur?.rules) so.rules = cur.rules;
      S.social = so;
      socialChanged();
      return { answer: { seed }, detail: { seed } };
    });
  },
};
